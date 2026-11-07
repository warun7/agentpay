import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { MerchantAgent, isWireEnvelope } from '../agents/merchant-agent.js';
import { BuyerAgent } from '../agents/buyer-agent.js';
import { extractKeysFromDIDDocument } from '../identity/did.js';
import { DEFAULT_CATALOG } from '../agents/catalog-data.js';
import { createLLMClientFromEnv } from '../ai/llm-failover.js';
import { HybridBuyerStrategy } from '../ai/strategies/hybrid-buyer.js';
import { GeminiBuyerStrategy } from '../ai/strategies/gemini-buyer.js';
import { GeminiMerchantStrategy } from '../ai/strategies/gemini-merchant.js';
import { verifyWebhookSignature } from '../crypto/signatures.js';
import { paymentBus } from '../payment/webhook-events.js';
import { broadcastProtocolEvent } from './websocket.js';
import type { UAPProofBundle } from '../payment/types.js';
import type { StateTransitionEvent } from '../protocol/state-machine.js';
import type { SealedCheckoutEvent } from '../evidence/cool-evidence.js';

/** Compact view of a sealed CooL record for the live feed. */
const summarizeEvidence = (e: SealedCheckoutEvent) => ({
  party: e.party,
  type: e.type,
  recordId: e.recordId,
});

// Runtime validation schema for demo run requests
const DemoRunRequestSchema = z.object({
  itemId: z.string().default('item_gpu_h100_cluster'),
  maxAmount: z.number().positive().max(10000000).default(500000),
  quantity: z.number().int().positive().max(100).default(1),
  offeredUnitPrice: z.number().positive().optional(),
  /** Opt-in to Gemini-driven negotiation (falls back to deterministic if unavailable). */
  useLLM: z.boolean().optional(),
}).partial();

// In-memory audit log store
export const AUDIT_STORE = new Map<string, {
  transactionId: string;
  transitions: StateTransitionEvent[];
  bundle?: UAPProofBundle;
  timestamp: string;
}>();

/** Webhook idempotency ledger: `${event}:${orderId}:${paymentId}` → first-seen. */
export const PROCESSED_WEBHOOKS = new Set<string>();

export const routes: FastifyPluginAsync<{ merchantAgent: MerchantAgent }> = async (
  fastify: FastifyInstance,
  opts
) => {
  const merchant = opts.merchantAgent;

  // 1. Health Check
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'AgentPay Autonomous Commerce Engine',
      version: '1.0.0',
      network: 'UAP-UPI-Reserve-Pay-Simulator',
      timestamp: new Date().toISOString(),
    };
  });

  // 2. Product Catalog
  fastify.get('/api/catalog', async () => {
    return {
      merchantDID: merchant.getDID(),
      merchantName: merchant.identity.name,
      merchantUpiId: merchant.upiId,
      items: merchant.catalog,
    };
  });

  // 3. Agent Identities
  fastify.get('/api/identities', async () => {
    const llm = createLLMClientFromEnv();
    return {
      merchant: {
        name: merchant.identity.name,
        role: merchant.identity.role,
        did: merchant.identity.did,
        didDocument: merchant.identity.didDocument,
      },
      gatewayMode: merchant.gateway.isMockMode() ? 'mock' : 'live',
      orderCreationMode: merchant.gateway.orderCreationMode(),
      captureMode: merchant.gateway.captureMode(),
      llmEnabled: !!llm,
      llmProviderOrder: llm?.providerNames ?? [],
      activeModel: llm?.activeModel ?? 'deterministic',
      persistence: merchant.persistence.kind,
    };
  });

  // 3b. LLM status surface (P7) — provider chain + active model, no secrets
  fastify.get('/api/llm/status', async () => {
    const llm = createLLMClientFromEnv();
    if (!llm) {
      return { enabled: false, providers: [], activeModel: 'deterministic', note: 'LLM disabled or unconfigured — deterministic strategies in use.' };
    }
    return {
      enabled: true,
      providers: llm.providerNames,
      models: llm.providers?.map?.((p: any) => p.modelLabel ?? p.name) ?? [],
      activeModel: llm.activeModel,
      note: 'Failover is sticky: first successful provider serves subsequent calls.',
    };
  });

  // 4. Trigger Full Autonomous End-to-End Demo Transaction
  fastify.post('/api/demo/run', async (request, reply) => {
    try {
      // Runtime Zod validation at route boundary (Bug 5 fix)
      const parsed = DemoRunRequestSchema.safeParse(request.body || {});
      if (!parsed.success) {
        reply.status(400);
        return {
          success: false,
          error: 'Invalid request body',
          validationErrors: parsed.error.flatten().fieldErrors,
        };
      }
      const { itemId, maxAmount, quantity, offeredUnitPrice } = {
        itemId: parsed.data.itemId || 'item_gpu_h100_cluster',
        maxAmount: parsed.data.maxAmount || 500000,
        quantity: parsed.data.quantity || 1,
        offeredUnitPrice: parsed.data.offeredUnitPrice || 320000,
      };

      // ── Strategy selection: any configured LLM provider, else deterministic ──
      // P7 fix: enablement is provider-agnostic — OpenRouter-only setups get
      // full LLM negotiation without a Gemini key.
      const wantLLM = parsed.data.useLLM ?? (process.env.LLM_ENABLED === 'true');
      const llmClient = wantLLM ? createLLMClientFromEnv() : null;
      const strategyMode: string = llmClient ? `llm-${llmClient.activeProvider}` : 'deterministic';
      const buyerStrategy = llmClient ? new HybridBuyerStrategy(new GeminiBuyerStrategy(llmClient)) : undefined;
      const merchantStrategy = llmClient ? new GeminiMerchantStrategy(llmClient) : undefined;
      if (llmClient) merchant.strategy = merchantStrategy!;

      // 1. Create fresh Buyer Agent
      const buyer = new BuyerAgent({ name: 'Alpha AutoBuyer Agent', strategy: buyerStrategy });
      await buyer.provisionMandate({
        maxAmount: maxAmount,
        currency: 'INR',
        allowedCategories: ['cloud_services', 'saas_subscription'],
        merchantWhitelist: ['*'],
      });

      // 2. Create session handler on Merchant
      const merchantSession = merchant.createSessionHandler();
      const transitionLogs: StateTransitionEvent[] = [];

      // Live feed: every FSM transition streams to the dashboard in real time
      const runId = uuidv4();
      let feedSeq = 0;
      const emitFeed = (type: string, payload: Record<string, unknown>) => {
        broadcastProtocolEvent({ type, runId, seq: ++feedSeq, timestamp: new Date().toISOString(), payload });
      };
      emitFeed('RUN_STARTED', { strategyMode, itemId, quantity });

      merchantSession.fsm.onTransition((evt) => {
        transitionLogs.push(evt);
        emitFeed('FSM_TRANSITION', {
          step: evt.step,
          fromState: evt.fromState,
          toState: evt.toState,
          action: evt.action,
          payloadDigest: evt.payloadDigest,
          details: evt.details,
        });
      });

      // Step 1: DID Exchange & ECDH (plaintext by protocol design — no shared key yet)
      const buyerDIDMsg = buyer.createDIDExchangeMessage();
      const merchantDIDMsg = merchantSession.handleDIDExchange(buyerDIDMsg);
      const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);

      // Buyer-side receive helper: unwrap merchant's encrypted response envelopes
      const fromMerchant = <T>(response: unknown): T => {
        if (!isWireEnvelope(response)) {
          throw new Error('Protocol violation: expected encrypted WireEnvelope from merchant');
        }
        return buyerChannel.unpackMessage<T>(response);
      };

      // Step 2: Mandate Presentation (encrypted envelope)
      const mandateResult = await merchantSession.handleMandatePresentation(
        buyerChannel.packMessage(buyer.createMandatePresentation()),
        buyer.userWalletIdentity.signingKeyPair.jwk.public
      );
      fromMerchant<{ verified: boolean }>(mandateResult);

      // Step 3: Catalog Request (encrypted envelope)
      const catalogResponse = merchantSession.handleCatalogRequest(
        buyerChannel.packMessage(buyer.createCatalogRequest('cloud_services'))
      );
      const catalogResp = fromMerchant<{ items: Array<{ id: string; name: string }> }>(catalogResponse);
      if (!catalogResp || !Array.isArray(catalogResp.items)) {
        throw new Error('Malformed catalog response received over secure channel');
      }

      // Step 4: Purchase Intent — LLM-decided when in Gemini mode, body params otherwise
      let intentMsg;
      let buyerIntentDecision: Awaited<ReturnType<typeof buyer.decidePurchaseIntent>>['strategyResult'] | null = null;
      if (strategyMode !== 'deterministic') {
        const decided = await buyer.decidePurchaseIntent(merchant.catalog, {
          remainingBudgetPaise: maxAmount,
          goal: { itemId, quantity, budgetPaise: maxAmount },
        });
        intentMsg = decided.intent;
        buyerIntentDecision = decided.strategyResult;
        emitFeed('LLM_REASONING', {
          actor: 'buyer',
          stage: 'intent',
          rationale: decided.strategyResult.decision.rationale,
          source: decided.strategyResult.source,
          attempts: decided.strategyResult.attempts,
        });
      } else {
        intentMsg = buyer.createPurchaseIntent(itemId, quantity, offeredUnitPrice);
      }
      // Step 4b: Quote + merchant pricing rationale
      const quoteEnvelope = await merchantSession.handlePurchaseIntent(
        buyerChannel.packMessage(intentMsg)
      );
      const quoteResp = fromMerchant<any>(quoteEnvelope);
      const pricingTrace = merchantSession.getStrategyTrace().at(-1);
      if (pricingTrace) {
        emitFeed('LLM_REASONING', {
          actor: 'merchant',
          stage: 'pricing',
          rationale: pricingTrace.rationale,
          source: pricingTrace.source,
          attempts: pricingTrace.attempts,
          discountRequested: pricingTrace.discountPercentageRequested,
          discountApplied: pricingTrace.discountPercentageApplied,
          clamped: pricingTrace.clamped,
        });
      }

      // Merchant's verified Ed25519 public key (from its DID document, which the
      // buyer bound during DID exchange) — used for quote signature verification.
      const { signingKeyJwk: merchantSigningKeyJwk } = extractKeysFromDIDDocument(
        buyerChannel.getSession().peerDIDDocument
      );

      // Strategy opinion on the quote (advisory rationale; bounds checker remains the gate)
      const quoteEvaluation = await buyer.strategicEvaluateQuote(
        quoteResp,
        'cloud_services',
        merchant.getDID(),
        merchantSigningKeyJwk
      );
      if (!quoteEvaluation.proceed) {
        throw new Error(
          `Buyer strategy rejected quote: ${quoteEvaluation.evaluation.decision.rationale}`
        );
      }

      // Step 5: Evaluate and Sign (signature verify → deterministic mandate gate)
      const signedTx = await buyer.evaluateAndSignQuote(quoteResp, 'cloud_services', merchant.getDID(), merchantSigningKeyJwk);

      // Step 6: Payment Settlement (encrypted envelope)
      const receiptEnvelope = await merchantSession.handleSignedTransaction(
        buyerChannel.packMessage(signedTx)
      );
      const settlementReceipt = fromMerchant<any>(receiptEnvelope);
      const proofBundle = merchantSession.getProofBundle();

      // CooL: what each agent sealed for the primary checkout. Emitted before
      // RUN_COMPLETE so the feed's terminal-event contract is unchanged.
      const executionId = buyerChannel.getSession().sessionId;
      const sealedSoFar = [
        ...(buyer.evidence?.forExecution(executionId) ?? []),
        ...(merchant.evidence?.forExecution(executionId) ?? []),
      ];
      if (sealedSoFar.length > 0) {
        emitFeed('COOL_EVIDENCE', { executionId, sealed: sealedSoFar.map(summarizeEvidence) });
      }

      emitFeed('RUN_COMPLETE', {
        transactionId: settlementReceipt.transactionId,
        amount: settlementReceipt.amount,
        razorpayOrderId: settlementReceipt.razorpayOrderId,
        status: settlementReceipt.status,
      });

      // ── Growth agent: ONE bounded recommendation round ──────────────────
      // Merchant attached complementary items to the SIGNED quote; the buyer
      // only accepts what the remaining mandate budget can afford.
      let upsellReceipt: any = null;
      let upsellOutcome: Record<string, unknown> | null = null;
      const offeredRecs = quoteResp.recommendations ?? [];
      if (offeredRecs.length > 0 && strategyMode !== undefined) {
        emitFeed('REC_OFFERED', {
          count: offeredRecs.length,
          items: offeredRecs.map((r: any) => `${r.name} @ ₹${(r.offeredUnitPrice / 100).toFixed(0)}`),
        });

        const mandateCap = maxAmount;
        const remainingAfterPrimary = mandateCap - settlementReceipt.amount;
        const recEval = await buyer.evaluateRecommendations(offeredRecs, remainingAfterPrimary, mandateCap);

        if (recEval.accepted.length > 0) {
          const rec = recEval.accepted[0];
          emitFeed('REC_ACCEPTED', { itemId: rec.itemId, rationale: rec.reason });

          // Round 2 on a FRESH FSM/handshake (merchant FSM is single-checkout)
          merchant.pendingUpsellAttribution = { recommendationsOffered: offeredRecs.length };
          const session2 = merchant.createSessionHandler();
          const mDID2 = session2.handleDIDExchange(buyer.createDIDExchangeMessage());
          const ch2 = buyer.establishSession(mDID2.didDocument);
          await session2.handleMandatePresentation(
            ch2.packMessage(buyer.createMandatePresentation()),
            buyer.userWalletIdentity.signingKeyPair.jwk.public
          );
          session2.handleCatalogRequest(ch2.packMessage({ type: 'CATALOG_REQUEST' }));
          const q2Env = await session2.handlePurchaseIntent(ch2.packMessage(buyer.createUpsellIntent(rec)));
          const q2 = (() => { if (!isWireEnvelope(q2Env)) throw new Error('expected envelope'); return ch2.unpackMessage(q2Env) as any; })();

          const recCategory = merchant.catalog.find((c) => c.id === rec.itemId)?.category ?? 'cloud_services';
          const { signingKeyJwk: mKey2 } = extractKeysFromDIDDocument(ch2.getSession().peerDIDDocument);
          const stx2 = await buyer.evaluateAndSignQuote(q2, recCategory, merchant.getDID(), mKey2);
          const r2Env = await session2.handleSignedTransaction(ch2.packMessage(stx2));
          upsellReceipt = (() => { if (!isWireEnvelope(r2Env)) throw new Error('expected envelope'); return ch2.unpackMessage(r2Env) as any; })();

          upsellOutcome = {
            accepted: true,
            itemId: rec.itemId,
            incrementalRevenuePaise: upsellReceipt.amount,
            transactionId: upsellReceipt.transactionId,
          };
        } else {
          const declinedWhy =
            remainingAfterPrimary <= 0
              ? 'no remaining mandate budget after primary purchase'
              : 'strategy declined within affordability bounds';
          emitFeed('REC_DECLINED', { reason: declinedWhy });
          upsellOutcome = { accepted: false, reason: declinedWhy };
        }
      }

      // Store in Audit History (memory for hot reads, ledger for durability)
      if (proofBundle) {
        AUDIT_STORE.set(settlementReceipt.transactionId, {
          transactionId: settlementReceipt.transactionId,
          transitions: transitionLogs,
          bundle: proofBundle,
          timestamp: new Date().toISOString(),
        });
        try {
          merchant.persistence.saveAuditEvents(
            transitionLogs.map((evt) => ({
              transaction_id: settlementReceipt.transactionId,
              step: evt.step,
              from_state: evt.fromState,
              to_state: evt.toState,
              action: evt.action,
              payload_digest: evt.payloadDigest ?? null,
              details_json: evt.details ? JSON.stringify(evt.details) : null,
              timestamp: evt.timestamp,
            }))
          );
        } catch { /* ledger best-effort */ }
      }

      // CooL evidence: each agent sealed its own decisions under the shared
      // ECDH session id (upsell rounds included). Receipts + both key
      // directories go back to the caller so anyone can verify them offline.
      const merchantEvidence = merchant.evidence?.forExecution(executionId) ?? [];
      const buyerEvidence = buyer.evidence?.forExecution(executionId) ?? [];

      return {
        success: true,
        runId,
        coolEvidence: {
          executionId,
          merchant: merchantEvidence.map((e) => ({ ...summarizeEvidence(e), evidence: e.evidence })),
          buyer: buyerEvidence.map((e) => ({ ...summarizeEvidence(e), evidence: e.evidence })),
          keys: {
            merchant: merchant.evidence?.keyDirectory ?? null,
            buyer: buyer.evidence?.keyDirectory ?? null,
          },
        },
        transactionId: settlementReceipt.transactionId,
        buyerDID: buyer.getDID(),
        merchantDID: merchant.getDID(),
        razorpayOrderId: settlementReceipt.razorpayOrderId,
        razorpayPaymentId: settlementReceipt.razorpayPaymentId,
        amount: settlementReceipt.amount,
        currency: settlementReceipt.currency,
        status: settlementReceipt.status,
        auditDigest: settlementReceipt.cryptographicAuditDigest,
        receipt: settlementReceipt,
        proofBundle,
        transitionHistory: transitionLogs,
        transport: {
          mode: 'ENCRYPTED_ENVELOPE',
          cipherSuite: 'AES-256-GCM',
          keyAgreement: 'X25519-ECDH + HKDF-SHA256',
          sessionId: buyerChannel.getSession().sessionId,
          encryptedFramesExchanged: 4,
          plaintextFramesExchanged: 1, // DID_EXCHANGE only (pre-shared-key handshake)
        },
        reasoning: {
          strategyMode,
          buyerIntentDecision,
          quoteEvaluation: quoteEvaluation.evaluation,
          merchantPricing: merchantSession.getStrategyTrace(),
        },
        upsell: {
          offeredCount: offeredRecs.length,
          offered: offeredRecs.map((r: any) => ({ itemId: r.itemId, name: r.name, price: r.offeredUnitPrice, reason: r.reason })),
          outcome: upsellOutcome,
          receipt: upsellReceipt,
        },
      };
    } catch (error: any) {
      fastify.log.error(error);
      reply.status(400);
      return {
        success: false,
        error: error.message,
        name: error.name,
      };
    }
  });

  // 4b. CooL: the merchant's published key directory. Verifiers pin THESE
  // keys; the keys embedded in a receipt are never trusted on their own.
  fastify.get('/api/cool/keys', async (_request, reply) => {
    if (!merchant.evidence) {
      reply.status(404);
      return { enabled: false, error: 'CooL evidence is disabled (COOL_EVIDENCE=off)' };
    }
    return { enabled: true, party: 'merchant', keyDirectory: merchant.evidence.keyDirectory };
  });

  // 4c. CooL: the merchant's sealed records for one checkout session.
  fastify.get('/api/cool/evidence/:executionId', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const records = merchant.evidence?.forExecution(executionId) ?? [];
    if (records.length === 0) {
      reply.status(404);
      return { error: `No CooL evidence for execution ${executionId}` };
    }
    return {
      executionId,
      records: records.map((e) => ({ ...summarizeEvidence(e), evidence: e.evidence })),
    };
  });

  // 5. Query Audit Trail
  fastify.get('/api/audit/:transactionId', async (request, reply) => {
    const { transactionId } = request.params as { transactionId: string };
    const record = AUDIT_STORE.get(transactionId);
    if (record) return record;

    // Durable fallback — audit survives process restarts
    const events = merchant.persistence.loadAuditEvents(transactionId);
    if (events.length > 0) {
      return {
        transactionId,
        transitions: events,
        bundle: undefined,
        timestamp: events[0]?.timestamp,
        recoveredFrom: 'ledger',
      };
    }

    reply.status(404);
    return { error: `Audit record for transaction ${transactionId} not found` };
  });

  // 6. List Recent Transactions
  fastify.get('/api/transactions', async () => {
    return Array.from(AUDIT_STORE.values()).reverse();
  });

  // ── Growth-agent measurement (the "measured money" endpoint) ──
  fastify.get('/api/merchant/analytics', async () => {
    const a = merchant.analytics;
    const txns = Math.max(1, a.totalTransactions);
    return {
      transactions: a.totalTransactions,
      grossRevenuePaise: a.grossRevenuePaise,
      avgOrderValuePaise: Math.round(a.grossRevenuePaise / txns),
      recommendations: {
        offered: a.recsOfferedCount,
        accepted: a.recsAcceptedCount,
        conversionRate: a.recsOfferedCount > 0 ? +(a.recsAcceptedCount / a.recsOfferedCount).toFixed(2) : 0,
        incrementalRevenuePaise: a.incrementalRevenuePaise,
        upliftPct:
          a.grossRevenuePaise > 0 && a.incrementalRevenuePaise > 0
            ? +((a.incrementalRevenuePaise / (a.grossRevenuePaise - a.incrementalRevenuePaise)) * 100).toFixed(1)
            : 0,
      },
    };
  });

  // ── 7. Razorpay Webhook Receiver (live settlement confirmation path) ──
  //
  // Signature verification uses the RAW request body bytes (Fastify stashes
  // them on request.rawBody via the custom content-type parser in server/index.ts).
  // Valid deliveries are published onto the SAME payment event bus that mock
  // captures use — one confirmation pipeline, two transports.
  fastify.post('/api/webhooks/razorpay', async (request, reply) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      reply.status(503);
      return { accepted: false, error: 'RAZORPAY_WEBHOOK_SECRET not configured' };
    }

    const rawBody = (request as any).rawBody;
    if (typeof rawBody !== 'string') {
      reply.status(400);
      return { accepted: false, error: 'Raw body unavailable for signature verification' };
    }

    const signature = request.headers['x-razorpay-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      fastify.log.warn({ hasSig: !!signature }, 'Rejected webhook with invalid HMAC signature');
      reply.status(401);
      return { accepted: false, error: 'Invalid signature' };
    }

    const body = request.body as any;
    const eventName = typeof body?.event === 'string' ? body.event : 'unknown';
    const paymentEntity = body?.payload?.payment?.entity || {};
    const orderEntity = body?.payload?.order?.entity || {};
    const razorpayOrderId = paymentEntity.order_id || orderEntity.id || '';
    const razorpayPaymentId = paymentEntity.id || '';

    const dedupeKey = `${eventName}:${razorpayOrderId}:${razorpayPaymentId}`;
    // Two-layer idempotency: in-process Set + durable ledger (survives restart)
    const durable = merchant.persistence.saveWebhook(dedupeKey, eventName, razorpayOrderId, razorpayPaymentId);
    if (PROCESSED_WEBHOOKS.has(dedupeKey) || durable === 'duplicate') {
      return { accepted: true, duplicate: true, event: eventName };
    }
    PROCESSED_WEBHOOKS.add(dedupeKey);

    if (eventName === 'payment.captured' && razorpayOrderId) {
      paymentBus().publish({
        kind: 'payment.captured',
        source: 'razorpay-webhook',
        razorpayOrderId,
        razorpayPaymentId,
        amountPaise: paymentEntity.amount,
        timestamp: new Date().toISOString(),
      });
    } else if (eventName === 'payment.failed' && razorpayOrderId) {
      paymentBus().publish({
        kind: 'payment.failed',
        source: 'razorpay-webhook',
        razorpayOrderId,
        reason: paymentEntity.error_description || 'Unknown gateway failure',
        timestamp: new Date().toISOString(),
      });
    }

    // Always 200-ack valid signed deliveries — non-matching orders are logged,
    // not errored, to avoid webhook retry storms.
    return { accepted: true, duplicate: false, event: eventName };
  });
};
