import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { BuyerAgent } from '../agents/buyer-agent.js';
import { isWireEnvelope } from '../agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../identity/did.js';
import type { MerchantAgent } from '../agents/merchant-agent.js';
import { createLLMClientFromEnv } from '../ai/llm-failover.js';
import { GeminiBuyerStrategy } from '../ai/strategies/gemini-buyer.js';
import { HybridBuyerStrategy } from '../ai/strategies/hybrid-buyer.js';
import { GeminiMerchantStrategy } from '../ai/strategies/gemini-merchant.js';
import { DeterministicBuyerStrategy } from '../ai/strategies/deterministic.js';
import { extractShoppingGoal, type ShoppingGoalExtraction } from '../ai/goal-extractor.js';
import type { ShoppingGoal, StrategyResult, BuyerStrategy, IntentDecision, QuoteEvaluationDecision } from '../ai/types.js';
import { broadcastProtocolEvent } from './websocket.js';

/**
 * Conversational Checkout — natural language in, cryptographically settled
 * receipt out. Each user message runs through:
 *   NL → goal extraction (LLM|heuristic) → encrypted agent negotiation →
 *   deterministic bounds gate → Razorpay settlement → transcript events.
 *
 * Sessions persist in-memory so follow-ups ("now add a vector db") reuse the
 * established identities, encrypted channel, and remaining budget.
 */

const HARD_MANDATE_CAP_PAISE = 1000000; // ₹10,000 demo ceiling
const DEFAULT_MANDATE_CAP_PAISE = 500000; // ₹5,000

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(1000),
});

export interface ChatTranscriptEvent {
  seq: number;
  actor: 'user' | 'buyer' | 'merchant' | 'system';
  kind: string;
  title: string;
  detail?: string;
  rationale?: string;
  source?: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

interface ChatSession {
  id: string;
  createdAt: number;
  transcript: ChatTranscriptEvent[];
  buyer: BuyerAgent | null;
  mandateCapPaise: number;
  spentPaise: number;
  purchases: Array<Record<string, unknown>>;
}

const sessions = new Map<string, ChatSession>();

/** Push a transcript entry AND mirror it onto the live WS feed. */
function pushTranscript(
  session: ChatSession,
  evt: Omit<ChatTranscriptEvent, 'seq' | 'timestamp'> & { timestamp?: string }
): ChatTranscriptEvent {
  const full: ChatTranscriptEvent = {
    ...evt,
    seq: session.transcript.length + 1,
    timestamp: evt.timestamp ?? new Date().toISOString(),
  };
  session.transcript.push(full);
  broadcastProtocolEvent({ type: 'CHAT_EVENT', runId: session.id, seq: full.seq, timestamp: full.timestamp, payload: full });
  return full;
}

function newSession(): ChatSession {
  const s: ChatSession = {
    id: uuidv4(),
    createdAt: Date.now(),
    transcript: [],
    buyer: null,
    mandateCapPaise: DEFAULT_MANDATE_CAP_PAISE,
    spentPaise: 0,
    purchases: [],
  };
  sessions.set(s.id, s);
  return s;
}

function budgetView(s: ChatSession) {
  return { capPaise: s.mandateCapPaise, spentPaise: s.spentPaise, remainingPaise: s.mandateCapPaise - s.spentPaise };
}

/** Provisions identities + mandate once per chat session (reused across rounds). */
async function provisionBuyer(
  session: ChatSession,
  requestedBudgetPaise: number | undefined
) {
  if (session.buyer) return;

  const cap = Math.min(requestedBudgetPaise ?? DEFAULT_MANDATE_CAP_PAISE, HARD_MANDATE_CAP_PAISE);
  session.mandateCapPaise = cap;

  const gemini = createLLMClientFromEnv();
  const buyer = new BuyerAgent({
    name: `Chat Buyer ${session.id.substring(0, 8)}`,
    strategy: gemini ? new HybridBuyerStrategy(new GeminiBuyerStrategy(gemini)) : undefined,
  });
  await buyer.provisionMandate({
    maxAmount: cap,
    currency: 'INR',
    allowedCategories: ['cloud_services', 'saas_subscription'],
    merchantWhitelist: ['*'],
  });

  session.buyer = buyer;
}

async function runPurchaseRound(
  session: ChatSession,
  merchant: MerchantAgent,
  goal: ShoppingGoalExtraction,
  goalSource: string
): Promise<{ settled: boolean; error?: string }> {
  await provisionBuyer(session, goal.budgetPaise);
  const buyer = session.buyer!;

  // Fresh ECDH handshake + FSM per purchase round: the merchant state machine
  // is single-checkout by design, and fresh ephemeral keys per transaction are
  // exactly the forward-secrecy property we advertise.
  const merchantSession = merchant.createSessionHandler();
  const buyerDIDMsg = buyer.createDIDExchangeMessage();
  const merchantDIDMsg = merchantSession.handleDIDExchange(buyerDIDMsg);
  const channel = buyer.establishSession(merchantDIDMsg.didDocument);

  pushTranscript(session, {
    actor: 'system',
    kind: 'SESSION_ESTABLISHED',
    title: 'Secure checkout session established',
    detail: `Fresh X25519→AES-256-GCM tunnel · mandate cap ₹${session.mandateCapPaise / 100}`,
    meta: { sessionId: channel.getSession().sessionId },
    timestamp: new Date().toISOString(),
  });

  const fromMerchant = <T>(response: unknown): T => {
    if (!isWireEnvelope(response)) throw new Error('Protocol violation: expected encrypted envelope');
    return channel.unpackMessage(response) as T;
  };

  // Mandate presentation (encrypted)
  const mandateResp = await merchantSession.handleMandatePresentation(
    channel.packMessage(buyer.createMandatePresentation()),
    buyer.userWalletIdentity.signingKeyPair.jwk.public
  );
  fromMerchant(mandateResp);

  // Catalog (encrypted)
  const catalogResp = fromMerchant<{ items: any[]; merchantName: string }>(
    merchantSession.handleCatalogRequest(channel.packMessage({ type: 'CATALOG_REQUEST', category: goal.category }))
  );

  pushTranscript(session, {
    actor: 'buyer',
    kind: 'GOAL_PARSED',
    title: 'Shopping goal understood',
    detail: goal.notes,
    rationale:
      `${goalSource === 'llm-gemini' ? 'Gemini' : 'Heuristic'} extraction → action=${goal.action}` +
      `${goal.category ? `, category=${goal.category}` : ''}${goal.budgetPaise ? `, budget=₹${goal.budgetPaise / 100}` : ''}`,
    source: goalSource,
    meta: { goal },
    timestamp: new Date().toISOString(),
  });
  pushTranscript(session, {
    actor: 'merchant',
    kind: 'CATALOG',
    title: `${catalogResp.items.length} items served over encrypted tunnel`,
    detail: catalogResp.items.map((i: any) => `${i.name} — ₹${(i.basePrice / 100).toFixed(0)}`).join(' • '),
    timestamp: new Date().toISOString(),
  });

  // Intent decision (strategy-driven)
  const remaining = session.mandateCapPaise - session.spentPaise;
  const shoppingGoal: ShoppingGoal = {
    itemId: goal.itemIdHint,
    category: goal.category,
    budgetPaise: goal.budgetPaise ?? remaining,
    quantity: goal.quantity,
    notes: goal.notes,
  };
  const { intent, strategyResult } = await buyer.decidePurchaseIntent(catalogResp.items, {
    remainingBudgetPaise: remaining,
    goal: shoppingGoal,
  });

  pushTranscript(session, {
    actor: 'buyer',
    kind: 'INTENT',
    title: `Intent: ${intent.items[0].quantity}× ${catalogResp.items.find((i: any) => i.id === intent.items[0].itemId)?.name ?? intent.items[0].itemId}`,
    detail: `Offer ₹${((intent.items[0].offeredUnitPrice ?? 0) / 100).toFixed(2)}/unit — ${intent.negotiationReason}`,
    rationale: strategyResult.decision.rationale,
    source: strategyResult.source,
    meta: { intent },
    timestamp: new Date().toISOString(),
  });

  // Quote (encrypted)
  const quote = fromMerchant<any>(await merchantSession.handlePurchaseIntent(channel.packMessage(intent)));
  pushTranscript(session, {
    actor: 'merchant',
    kind: 'QUOTE',
    title: `Quote ₹${(quote.totalAmount / 100).toFixed(2)} (${quote.quoteId})`,
    detail: `Subtotal ₹${(quote.subtotal / 100).toFixed(2)} − discount ₹${(quote.discount / 100).toFixed(2)} + GST ₹${(quote.tax / 100).toFixed(2)}`,
    rationale: merchantSession.getStrategyTrace().at(-1)?.rationale,
    source: merchantSession.getStrategyTrace().at(-1)?.source,
    meta: { quote },
    timestamp: new Date().toISOString(),
  });

  // Advisory evaluation + deterministic signing gate
  const { signingKeyJwk: merchantSigningKeyJwk } = extractKeysFromDIDDocument(
    channel.getSession().peerDIDDocument
  );
  const evaluation = await buyer.strategicEvaluateQuote(quote, goal.category ?? 'cloud_services', merchant.getDID(), merchantSigningKeyJwk);
  if (!evaluation.proceed) {
    pushTranscript(session, {
      actor: 'system',
      kind: 'REJECTED',
      title: 'Quote rejected before signing',
      rationale: evaluation.evaluation.decision.rationale,
      timestamp: new Date().toISOString(),
    });
    return { settled: false, error: 'QUOTE_REJECTED' };
  }

  const signedTx = await buyer.evaluateAndSignQuote(quote, goal.category ?? 'cloud_services', merchant.getDID(), merchantSigningKeyJwk);
  pushTranscript(session, {
    actor: 'buyer',
    kind: 'SIGNED',
    title: `Signed ₹${(signedTx.amount / 100).toFixed(2)} within mandate`,
    detail: `Detached Ed25519 JWS · nonce ${signedTx.nonce.substring(0, 8)}…`,
    rationale: evaluation.evaluation.decision.rationale,
    meta: { transactionId: signedTx.transactionId },
    timestamp: new Date().toISOString(),
  });

  // Settlement (encrypted) — bus confirms capture internally
  const receipt = fromMerchant<any>(await merchantSession.handleSignedTransaction(channel.packMessage(signedTx)));
  session.spentPaise += receipt.amount;
  session.purchases.push({ ...receipt });

  pushTranscript(session, {
    actor: 'merchant',
    kind: 'SETTLED',
    title: `Settled ₹${(receipt.amount / 100).toFixed(2)} via Razorpay UPI Reserve Pay`,
    detail: `${receipt.razorpayOrderId} · ${receipt.razorpayPaymentId}`,
    rationale: `Audit digest ${receipt.cryptographicAuditDigest.substring(0, 27)}… · Remaining budget ₹${((session.mandateCapPaise - session.spentPaise) / 100).toFixed(2)}`,
    meta: { receipt },
  });

  // ── Growth agent: ONE bounded recommendation round after settlement ──
  const offeredRecs: any[] = quote.recommendations ?? [];
  if (offeredRecs.length > 0) {
    pushTranscript(session, {
      actor: 'merchant',
      kind: 'REC_OFFERED',
      title: 'Growth agent suggests complementary capacity',
      detail: offeredRecs.map((r) => `${r.name} @ ₹${(r.offeredUnitPrice / 100).toFixed(0)} — ${r.reason}`).join('\n'),
      source: merchantSession.getStrategyTrace().at(-1)?.source,
      meta: { recommendations: offeredRecs },
    });

    const remainingAfterPrimary = session.mandateCapPaise - session.spentPaise;
    const recEval = await buyer.evaluateRecommendations(offeredRecs, remainingAfterPrimary, session.mandateCapPaise);

    if (recEval.accepted.length > 0) {
      const rec = recEval.accepted[0];
      pushTranscript(session, {
        actor: 'buyer',
        kind: 'REC_ACCEPTED',
        title: `Accepted: ${rec.name}`,
        rationale: `Fits remaining budget (₹${(remainingAfterPrimary / 100).toFixed(2)}) within mandate bounds — deterministic affordability gate passed.`,
      });

      // Fresh FSM/handshake for the upsell round
      merchant.pendingUpsellAttribution = { recommendationsOffered: offeredRecs.length };
      const s2 = merchant.createSessionHandler();
      const mDID2 = s2.handleDIDExchange(buyer.createDIDExchangeMessage());
      const ch2 = buyer.establishSession(mDID2.didDocument);
      await s2.handleMandatePresentation(ch2.packMessage(buyer.createMandatePresentation()), buyer.userWalletIdentity.signingKeyPair.jwk.public);
      s2.handleCatalogRequest(ch2.packMessage({ type: 'CATALOG_REQUEST' }));
      const q2 = fromMerchantAny(ch2, await s2.handlePurchaseIntent(ch2.packMessage(buyer.createUpsellIntent(rec))));
      const recCategory = merchant.catalog.find((c) => c.id === rec.itemId)?.category ?? 'cloud_services';
      const { signingKeyJwk: mKey2 } = extractKeysFromDIDDocument(ch2.getSession().peerDIDDocument);
      const stx2 = await buyer.evaluateAndSignQuote(q2, recCategory, merchant.getDID(), mKey2);
      const r2 = fromMerchantAny(ch2, await s2.handleSignedTransaction(ch2.packMessage(stx2)));

      session.spentPaise += r2.amount;
      session.purchases.push({ ...r2 });
      pushTranscript(session, {
        actor: 'merchant',
        kind: 'SETTLED',
        title: `Upsell settled: +₹${(r2.amount / 100).toFixed(2)} (${r2.razorpayOrderId})`,
        rationale: `Recommendation-driven revenue · Remaining budget ₹${((session.mandateCapPaise - session.spentPaise) / 100).toFixed(2)}`,
        meta: { receipt: r2 },
      });
    } else {
      pushTranscript(session, {
        actor: 'buyer',
        kind: 'REC_DECLINED',
        title: 'Declined recommendation',
        detail:
          remainingAfterPrimary <= 0
            ? 'No remaining mandate budget after the primary purchase.'
            : 'Outside deterministic affordability bounds.',
      });
    }
  }

  return { settled: true };
}

/** Unpack helper usable across per-round channels. */
function fromMerchantAny(ch: { unpackMessage(e: any): any }, response: unknown): any {
  if (!isWireEnvelope(response)) throw new Error('Protocol violation: expected encrypted envelope');
  return ch.unpackMessage(response);
}

export function registerChatRoutes(fastify: FastifyInstance, merchant: MerchantAgent) {
  fastify.post('/api/chat', async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'Invalid request', validationErrors: parsed.error.flatten().fieldErrors };
    }
    const { message } = parsed.data;
    const session = parsed.data.sessionId ? sessions.get(parsed.data.sessionId) ?? newSession() : newSession();
    if (!parsed.data.sessionId && !sessions.has(session.id)) sessions.set(session.id, session);

    pushTranscript(session, {
      actor: 'user',
      kind: 'USER_MESSAGE',
      title: message,
      timestamp: new Date().toISOString(),
    });

    try {
      const knownCategories = Array.from(new Set(merchant.catalog.map((c) => c.category)));
      const gemini = createLLMClientFromEnv();
      const { goal, source: goalSource } = await extractShoppingGoal(message, gemini, knownCategories);

      if (goal.action !== 'purchase') {
        pushTranscript(session, {
          actor: 'system',
          kind: 'GUIDANCE',
          title: 'I can transact for you autonomously',
          detail:
            'Try: "Buy GPU hours for a fine-tune run under ₹3000" · "Get me the vector DB" · "Order 2 API gateway packs under ₹1000"',
          timestamp: new Date().toISOString(),
        });
        return { ok: true, sessionId: session.id, transcript: session.transcript, budget: budgetView(session), purchase: null };
      }

      // Merchant pricing strategy follows the session's LLM availability
      if (gemini) merchant.strategy = new GeminiMerchantStrategy(gemini);

      const result = await runPurchaseRound(session, merchant, goal, goalSource);

      return {
        ok: true,
        sessionId: session.id,
        transcript: session.transcript,
        budget: budgetView(session),
        purchase: result.settled ? session.purchases.at(-1) : null,
        error: result.error,
      };
    } catch (err: any) {
      fastify.log.error(err, 'chat checkout failed');
      pushTranscript(session, {
        actor: 'system',
        kind: 'ERROR',
        title: 'Checkout round failed',
        detail: err.message?.substring(0, 200),
        timestamp: new Date().toISOString(),
      });
      reply.status(400);
      return { ok: false, sessionId: session.id, transcript: session.transcript, budget: budgetView(session), error: err.message };
    }
  });

  fastify.get('/api/chat/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessions.get(sessionId);
    if (!session) {
      reply.status(404);
      return { ok: false, error: 'Unknown session' };
    }
    return { ok: true, sessionId, createdAt: new Date(session.createdAt).toISOString(), transcript: session.transcript, budget: budgetView(session), purchases: session.purchases };
  });
}
