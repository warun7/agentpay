import { createAgentIdentity, extractKeysFromDIDDocument } from '../identity/did.js';
import { verifyMandateCredential } from '../identity/credentials.js';
import { completeHandshake } from '../session/handshake.js';
import { SecureChannel } from '../session/secure-channel.js';
import { ProtocolStateMachine } from '../protocol/state-machine.js';
import { generateQuote, createVoidProof, assertSignedTransactionMatchesPayload } from '../protocol/negotiation.js';
import { verifyCompactJWS, signCompactJWS } from '../crypto/signatures.js';
import { RazorpayGateway } from '../payment/razorpay.js';
import { processAgenticCheckout } from '../payment/mandate-gateway.js';
import { DEFAULT_CATALOG } from './catalog-data.js';
import {
  DIDExchangeSchema,
  MandatePresentationSchema,
  CatalogRequestSchema,
  PurchaseIntentSchema,
  TransactionPayloadSchema,
  ReconciliationChallengeSchema,
} from '../protocol/schemas.js';
import type { AgentIdentity, VerifiableCredential } from '../identity/types.js';
import type {
  DIDExchangeMessage,
  MandatePresentationMessage,
  CatalogRequestMessage,
  CatalogResponseMessage,
  PurchaseIntentMessage,
  QuoteMessage,
  TransactionPayloadMessage,
  SettlementReceiptMessage,
  ReconciliationChallengeMessage,
  ReconciliationProofMessage,
  CatalogItem,
} from '../protocol/schemas.js';
import type { UAPProofBundle } from '../payment/types.js';
import type { WireEnvelope } from '../session/types.js';
import { paymentBus } from '../payment/webhook-events.js';
import { MemoryPersistence, type PersistenceStore } from '../persistence/persistence.js';
import { SpendLedger } from '../identity/credentials.js';
import type { MerchantStrategy, PricingDecision, StrategyResult } from '../ai/types.js';
import { DeterministicMerchantStrategy } from '../ai/strategies/deterministic.js';
import { DISCOUNT_FLOOR, DISCOUNT_CAP } from '../ai/strategies/gemini-merchant.js';
import { CheckoutEvidence, type SealedCheckoutEvent } from '../evidence/cool-evidence.js';

export interface StoredTransactionRecord {
  transactionId: string;
  originalNonce: string;
  signedTx: TransactionPayloadMessage;
  receipt?: SettlementReceiptMessage;
  bundle?: UAPProofBundle;
  status: 'SETTLED' | 'VOIDED';
  reason?: string;
  timestamp: string;
  /** Stamp applied when the capture confirmation event arrives (bus or live webhook). */
  confirmedAt?: string;
  confirmedBy?: 'internal-synthetic' | 'razorpay-webhook';
  /** Growth-agent attribution */
  recommendationsOffered?: number;
  isUpsellRound?: boolean;
}

export interface MerchantAnalytics {
  totalTransactions: number;
  grossRevenuePaise: number;
  incrementalRevenuePaise: number; // revenue from accepted recommendation rounds
  recsOfferedCount: number;        // quotes that carried ≥1 recommendation
  recsAcceptedCount: number;       // upsell rounds actually settled
}

/**
 * Handler results are returned as plaintext objects (loopback/in-process mode)
 * OR as encrypted WireEnvelopes when the caller delivered an encrypted frame.
 */
export type SecureResult<T> = T | WireEnvelope;

/** Signed transactions older than this are rejected (replay/freshness window). */
export const SIGNED_TX_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Type guard: detects a WireEnvelope frame vs a raw protocol message.
 */
export function isWireEnvelope(raw: unknown): raw is WireEnvelope {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'sessionId' in (raw as Record<string, unknown>) &&
    'sequenceId' in (raw as Record<string, unknown>) &&
    ('ciphertext' in (raw as Record<string, unknown>) || 'payload' in (raw as Record<string, unknown>))
  );
}

export interface MerchantAgentOptions {
  name?: string;
  upiId?: string;
  catalog?: CatalogItem[];
  gateway?: RazorpayGateway;
  /** Pricing strategy (default: deterministic). LLM strategies are injected here. */
  strategy?: MerchantStrategy;
  /** Durable ledger (default: SQLite via env, memory fallback). */
  persistence?: PersistenceStore;
  /**
   * The merchant's own CooL evidence log (default: a fresh one unless
   * COOL_EVIDENCE=off). Pass null to disable.
   */
  evidence?: CheckoutEvidence | null;
}

/** Audit trace entry for strategy decisions (UI reasoning cards / pitch evidence). */
export interface StrategyTraceEntry {
  step: 'priceIntent';
  itemId: string;
  source: string;
  attempts: number;
  discountPercentageRequested: number;
  discountPercentageApplied: number;
  clamped: boolean;
  rationale: string;
  timestamp: string;
}

export class MerchantAgent {
  public identity: AgentIdentity;
  public upiId: string;
  public catalog: CatalogItem[];
  public gateway: RazorpayGateway;
  public strategy: MerchantStrategy;
  public transactionStore = new Map<string, StoredTransactionRecord>();
  /** Growth-agent measurement — surfaced via GET /api/merchant/analytics */
  public analytics: MerchantAnalytics = {
    totalTransactions: 0,
    grossRevenuePaise: 0,
    incrementalRevenuePaise: 0,
    recsOfferedCount: 0,
    recsAcceptedCount: 0,
  };
  /**
   * Orchestrators set this BEFORE handleSignedTransaction for an upsell round
   * so the settled transaction is attributed as recommendation-driven revenue.
   */
  public pendingUpsellAttribution: { recommendationsOffered: number } | null = null;
  /** Durable ledger — transactions, confirmations, audit events survive restarts. */
  public persistence: PersistenceStore;
  /** Seals mandate, quote, settlement and rejection decisions into a CooL log. */
  public evidence: CheckoutEvidence | null;

  constructor(options: MerchantAgentOptions = {}) {
    this.evidence =
      options.evidence !== undefined
        ? options.evidence
        : process.env.COOL_EVIDENCE === 'off'
          ? null
          : new CheckoutEvidence('merchant');
    this.identity = createAgentIdentity(options.name || 'AgentPay Cloud Merchant', 'merchant');
    this.upiId = options.upiId || 'agentpay.merchant@razorpay';
    this.catalog = options.catalog || [...DEFAULT_CATALOG];
    this.strategy = options.strategy || new DeterministicMerchantStrategy();
    // Default: in-memory ledger. The SERVER entrypoint (buildServer) injects
    // the durable SQLite store so library consumers stay dependency-free.
    this.persistence = options.persistence ?? new MemoryPersistence();
    if (this.persistence.kind === 'sqlite') {
      SpendLedger.setPersistence(this.persistence);
    }
    this.gateway = options.gateway || new RazorpayGateway({
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_agentpay_mock',
      keySecret: process.env.RAZORPAY_KEY_SECRET || 'agentpay_secret_mock_12345',
      mockMode: process.env.RAZORPAY_MOCK_MODE !== 'false',
    });
    this.hydrateFromPersistence();
  }

  /**
   * Restores settled transactions (and derived analytics) from the durable
   * ledger so nonce idempotency, reconciliation, and webhook confirmation
   * survive process restarts.
   */
  private hydrateFromPersistence(): void {
    let rows: ReturnType<PersistenceStore['loadTransactions']>;
    try {
      rows = this.persistence.loadTransactions();
    } catch {
      return;
    }

    for (const row of rows) {
      if (!row.receipt_json) continue;
      try {
        const receipt = JSON.parse(row.receipt_json);
        const record: StoredTransactionRecord = {
          transactionId: row.transaction_id,
          originalNonce: row.nonce,
          signedTx: { type: 'SIGNED_TRANSACTION' } as any, // skeleton; full payload not needed for recovery
          receipt,
          status: 'SETTLED',
          timestamp: row.created_at,
          confirmedAt: row.confirmed_at ?? undefined,
          confirmedBy: (row.confirmed_by as any) ?? undefined,
          recommendationsOffered: row.recommendations_offered ?? undefined,
          isUpsellRound: !!row.is_upsell_round,
        };
        this.transactionStore.set(row.transaction_id, record);
        if (row.nonce) this.transactionStore.set(row.nonce, record);
        if (row.razorpay_order_id) this.transactionStore.set(row.razorpay_order_id, record);
        this.analytics.totalTransactions++;
        this.analytics.grossRevenuePaise += receipt.amount ?? 0;
        if (record.isUpsellRound) {
          this.analytics.recsAcceptedCount++;
          this.analytics.incrementalRevenuePaise += receipt.amount ?? 0;
        } else if ((row.recommendations_offered ?? 0) > 0) {
          this.analytics.recsOfferedCount++;
        }
      } catch {
        // Corrupt row — skip rather than fail boot
      }
    }

    if (rows.length > 0) {
      console.log(
        `[AgentPay] Recovered ${rows.length} transaction(s) from ${this.persistence.kind} ledger.`
      );
    }
  }

  public getDID(): string {
    return this.identity.did;
  }

  /**
   * Idempotent capture-confirmation. Called by the unified payment event bus
   * for BOTH internal-synthetic (mock/UAP-sim) and razorpay-webhook (live)
   * confirmations — one code path, indistinguishable downstream.
   */
  public confirmCapture(evt: {
    razorpayOrderId: string;
    source: 'internal-synthetic' | 'razorpay-webhook';
    timestamp?: string;
  }): { confirmed: boolean; record?: StoredTransactionRecord; reason?: string } {
    const record = this.transactionStore.get(evt.razorpayOrderId);
    if (!record || record.status !== 'SETTLED' || !record.receipt) {
      return { confirmed: false, reason: `No settled transaction for order ${evt.razorpayOrderId}` };
    }
    if (record.confirmedAt) {
      return { confirmed: false, record, reason: 'Already confirmed (idempotent no-op)' };
    }
    record.confirmedAt = evt.timestamp || new Date().toISOString();
    record.confirmedBy = evt.source;
    this.persistence.markConfirmed(record.transactionId, record.confirmedAt, record.confirmedBy);
    this.transactionStore.set(record.transactionId, record);
    this.transactionStore.set(record.originalNonce, record);
    return { confirmed: true, record };
  }

  /**
   * Processes a complete negotiation and settlement session initiated by a Buyer Agent.
   *
   * Transport modes (per handler, auto-detected):
   *  - ENCRYPTED: caller passes a WireEnvelope -> decrypted via SecureChannel
   *    (AES-256-GCM, AAD-bound, anti-replay), response is packed back into an envelope.
   *  - LOOPBACK: caller passes a raw protocol object (in-process tests/simulations) ->
   *    processed directly, plaintext response returned.
   *
   * All inbound messages are runtime-validated via Zod schemas in both modes.
   */
  public createSessionHandler(fsm = new ProtocolStateMachine()) {
    let channel: SecureChannel | null = null;
    let buyerMandate: VerifiableCredential | null = null;
    let currentQuote: QuoteMessage | null = null;
    let latestProofBundle: UAPProofBundle | null = null;
    const strategyTrace: StrategyTraceEntry[] = [];

    const unwrapIncoming = <T>(raw: unknown): { msg: T; secure: boolean } => {
      if (isWireEnvelope(raw)) {
        if (!channel) {
          throw new Error('Received encrypted frame before DID exchange established a secure channel');
        }
        return { msg: channel.unpackMessage<T>(raw), secure: true };
      }
      return { msg: raw as T, secure: false };
    };

    const wrapOutgoing = <T>(msg: T, secure: boolean): SecureResult<T> => {
      if (secure && channel) {
        return channel.packMessage(msg as object);
      }
      return msg;
    };

    // CooL execution id: the ECDH session id, which buyer and merchant derive
    // identically, so both parties' evidence for one checkout correlates.
    const sessionIdOf = (): string => channel?.getSession().sessionId ?? 'pre-session';

    return {
      fsm,
      getChannel: () => channel,
      getProofBundle: () => latestProofBundle,
      getStrategyTrace: (): StrategyTraceEntry[] => [...strategyTrace],
      /** CooL records the merchant sealed for this session, oldest first. */
      getEvidence: (): SealedCheckoutEvent[] => this.evidence?.forExecution(sessionIdOf()) ?? [],

      // 1. Handshake with Buyer's DID Exchange
      handleDIDExchange: (rawMessage: unknown): DIDExchangeMessage => {
        // Runtime Zod validation at boundary
        const buyerMessage = DIDExchangeSchema.parse(rawMessage);

        fsm.transition('DID_EXCHANGED', 'RECEIVE_BUYER_DID', buyerMessage);

        const session = completeHandshake(this.identity, buyerMessage.didDocument);
        channel = new SecureChannel(session);

        fsm.transition('SESSION_ESTABLISHED', 'COMPLETE_ECDH_HANDSHAKE', {
          sessionId: session.sessionId,
          sharedSecretDerived: true,
        });

        return {
          type: 'DID_EXCHANGE',
          agentRole: 'merchant',
          did: this.identity.did,
          didDocument: this.identity.didDocument,
        };
      },

      // 2. Verify Mandate Presentation (encrypted via SecureChannel)
      handleMandatePresentation: async (
        rawMessage: unknown,
        issuerPublicKeyJwk: any
      ): Promise<SecureResult<{ verified: boolean; message: string }>> => {
        const { msg, secure } = unwrapIncoming<unknown>(rawMessage);

        // Runtime Zod validation
        const message = MandatePresentationSchema.parse(msg);

        const vc = message.verifiableCredential;
        const verification = await verifyMandateCredential(vc, issuerPublicKeyJwk);

        const mandateTerms = {
          vcId: vc.id,
          issuer: vc.issuer,
          subject: vc.credentialSubject.id,
          spendingConstraints: vc.credentialSubject.spendingConstraints,
        };

        if (!verification.valid) {
          fsm.transitionToError('VERIFY_MANDATE', verification.reason || 'Invalid mandate signature');
          await this.evidence?.seal(
            'agentpay.mandate.rejected',
            sessionIdOf(),
            { ...mandateTerms, reason: verification.reason || 'Invalid mandate signature' },
            { input: vc }
          );
          throw new Error(`Mandate verification failed: ${verification.reason}`);
        }

        buyerMandate = vc;
        fsm.transition('MANDATE_VERIFIED', 'VERIFY_BUYER_MANDATE', vc, {
          issuer: vc.issuer,
          maxAmount: vc.credentialSubject.spendingConstraints.maxAmount,
          categories: vc.credentialSubject.spendingConstraints.allowedCategories,
        });
        await this.evidence?.seal('agentpay.mandate.verified', sessionIdOf(), mandateTerms, { input: vc });

        return wrapOutgoing(
          { verified: true, message: 'Mandate signature and constraints verified successfully' },
          secure
        );
      },

      // 3. Serve Product Catalog
      handleCatalogRequest: (rawMessage: unknown): SecureResult<CatalogResponseMessage> => {
        const { msg, secure } = unwrapIncoming<unknown>(rawMessage);

        // Runtime Zod validation
        const _request = CatalogRequestSchema.parse(msg);

        const response: CatalogResponseMessage = {
          type: 'CATALOG_RESPONSE',
          items: this.catalog,
          merchantName: this.identity.name,
          timestamp: new Date().toISOString(),
        };

        fsm.transition('CATALOG_RECEIVED', 'SERVE_CATALOG', response);
        return wrapOutgoing(response, secure);
      },

      // 4. Generate Price Quote for Purchase Intent
      handlePurchaseIntent: async (rawMessage: unknown): Promise<SecureResult<QuoteMessage>> => {
        const { msg, secure } = unwrapIncoming<unknown>(rawMessage);

        // Runtime Zod validation
        const intent = PurchaseIntentSchema.parse(msg);

        fsm.transition('INTENT_SENT', 'RECEIVE_PURCHASE_INTENT', intent);

        // Strategy-driven dynamic pricing. The discount is HARD-CLAMPED here at
        // the protocol layer regardless of what any strategy claims — the LLM
        // can propose anything; it can never sign beyond [5%, 15%].
        const firstItem = this.catalog.find((c) => c.id === intent.items[0]?.itemId);
        if (!firstItem) {
          throw new Error(`Catalog item '${intent.items[0]?.itemId}' not found`);
        }

        const pricing: StrategyResult<PricingDecision> = await this.strategy.priceIntent(intent, firstItem);
        const requested = pricing.decision.discountPercentage;
        const applied = Math.min(DISCOUNT_CAP, Math.max(DISCOUNT_FLOOR, requested));
        const wasClamped = applied !== requested;
        strategyTrace.push({
          step: 'priceIntent',
          itemId: firstItem.id,
          source: pricing.source,
          attempts: pricing.attempts,
          discountPercentageRequested: requested,
          discountPercentageApplied: applied,
          clamped: wasClamped,
          rationale: wasClamped
            ? `${pricing.decision.rationale}\n[PROTOCOL CLAMP] Strategy proposed ${(requested * 100).toFixed(1)}% discount — ` +
              `clamped to ${(applied * 100).toFixed(1)}% by protocol boundary (allowed band 5–15%). The AI proposed; the protocol disposed.`
            : pricing.decision.rationale,
          timestamp: new Date().toISOString(),
        });

        const quote = await generateQuote({
          intent,
          catalog: this.catalog,
          merchantIdentity: {
            did: this.identity.did,
            signingPrivateKeyJwk: this.identity.signingKeyPair.jwk.private,
            upiId: this.upiId,
          },
          discountPercentage: applied,
          // Growth agent: complementary items INSIDE the signed quote payload
          recommendations: this.strategy.recommend
            ? (await this.strategy.recommend(firstItem, this.catalog, applied, intent.items[0]?.quantity ?? 1)).decision
            : undefined,
        });

        currentQuote = quote;
        fsm.transition('QUOTE_RECEIVED', 'GENERATE_SIGNED_QUOTE', quote);

        // "The AI proposes, the protocol disposes" — sealed: what the strategy
        // asked for, what the protocol applied, and whether it was clamped.
        await this.evidence?.seal(
          'agentpay.quote.issued',
          sessionIdOf(),
          {
            quoteId: quote.quoteId,
            cartId: quote.cartId,
            itemId: firstItem.id,
            strategySource: pricing.source,
            strategyAttempts: pricing.attempts,
            discountRequested: requested,
            discountApplied: applied,
            clamped: wasClamped,
            subtotal: quote.subtotal,
            discount: quote.discount,
            tax: quote.tax,
            totalAmount: quote.totalAmount,
            currency: quote.currency,
            merchantUpiId: quote.merchantUpiId,
            recommendationsOffered: quote.recommendations?.length ?? 0,
          },
          { input: intent, output: quote }
        );
        return wrapOutgoing(quote, secure);
      },

      // 5. Verify Buyer's Transaction Signature & Process Payment via Razorpay
      handleSignedTransaction: async (
        rawMessage: unknown
      ): Promise<SecureResult<SettlementReceiptMessage>> => {
        const { msg, secure } = unwrapIncoming<unknown>(rawMessage);

        // Runtime Zod validation at boundary
        const signedTx = TransactionPayloadSchema.parse(msg);

        // Every gate below that throws is sealed as a rejection before the
        // error propagates — a refused payment leaves evidence too.
        let mandateForSettlement: VerifiableCredential;
        try {
          if (!buyerMandate) {
            throw new Error('Cannot process transaction without a verified buyer mandate');
          }
          mandateForSettlement = buyerMandate;

          // ── BUG 2 FIX: Nonce idempotency check BEFORE settlement ──
          if (this.transactionStore.has(signedTx.nonce)) {
            const existingRecord = this.transactionStore.get(signedTx.nonce)!;
            if (existingRecord.receipt) {
              // Idempotent: return the existing receipt instead of double-charging
              return wrapOutgoing(existingRecord.receipt, secure);
            }
            throw new Error(`Duplicate nonce rejected: transaction ${existingRecord.transactionId} already in progress for nonce ${signedTx.nonce}`);
          }

          fsm.transition('SIGNED', 'RECEIVE_SIGNED_TRANSACTION', signedTx);

          // Verify Buyer Agent's detached Ed25519 signature
          if (!channel) {
            throw new Error('Secure channel not established');
          }
          const { signingKeyJwk } = extractKeysFromDIDDocument(channel.getSession().peerDIDDocument);

          // JWS verification
          const { payload: verifiedPayload } = await verifyCompactJWS<any>(
            signedTx.jwsSignature,
            signingKeyJwk
          );

          // ── P3 GATE: full payload/visibility match + DID addressing + freshness ──
          assertSignedTransactionMatchesPayload(signedTx, verifiedPayload, this.identity.did);
          if (signedTx.buyerDID !== channel.getSession().peerDID) {
            throw new Error(
              `Transaction buyerDID ${signedTx.buyerDID} does not match the established peer ${channel.getSession().peerDID}`
            );
          }
          const ageMs = Date.now() - Date.parse(signedTx.timestamp);
          if (!Number.isFinite(ageMs) || Math.abs(ageMs) > SIGNED_TX_MAX_AGE_MS) {
            throw new Error(
              `Stale or malformed signed transaction rejected: timestamp ${signedTx.timestamp} outside ±${SIGNED_TX_MAX_AGE_MS / 1000}s window`
            );
          }
        } catch (err: any) {
          await this.evidence?.seal(
            'agentpay.transaction.rejected',
            sessionIdOf(),
            {
              transactionId: signedTx.transactionId,
              nonce: signedTx.nonce,
              amount: signedTx.amount,
              currency: signedTx.currency,
              buyerDID: signedTx.buyerDID,
              reason: err?.message ?? String(err),
            },
            { input: signedTx }
          );
          throw err;
        }

        // Execute payment settlement via Razorpay Gateway (UPI Reserve Pay / UAP)
        const { receipt, bundle } = await processAgenticCheckout({
          signedTransaction: signedTx,
          buyerMandate: mandateForSettlement,
          gateway: this.gateway,
        });

        latestProofBundle = bundle;

        // Persist transaction record for atomicity and dispute recovery.
        // Indexed by nonce (idempotency), transactionId (reconciliation), AND
        // razorpayOrderId (webhook confirmation lookup).
        const isUpsellRound = this.pendingUpsellAttribution !== null;
        const recsOffered = isUpsellRound
          ? this.pendingUpsellAttribution!.recommendationsOffered
          : currentQuote?.recommendations?.length ?? 0;

        const record: StoredTransactionRecord = {
          transactionId: signedTx.transactionId,
          originalNonce: signedTx.nonce,
          signedTx,
          receipt,
          bundle,
          status: 'SETTLED',
          timestamp: new Date().toISOString(),
          recommendationsOffered: recsOffered,
          isUpsellRound,
        };
        this.pendingUpsellAttribution = null;

        // Growth-agent measurement
        if (recsOffered > 0 && !isUpsellRound) this.analytics.recsOfferedCount++;
        if (isUpsellRound) {
          this.analytics.recsAcceptedCount++;
          this.analytics.incrementalRevenuePaise += receipt.amount;
        }
        this.analytics.totalTransactions++;
        this.analytics.grossRevenuePaise += receipt.amount;
        this.transactionStore.set(signedTx.nonce, record);
        this.transactionStore.set(signedTx.transactionId, record);
        if (receipt.razorpayOrderId) {
          this.transactionStore.set(receipt.razorpayOrderId, record);
        }

        // Durable ledger write-through (P5): idempotency survives restarts.
        try {
          this.persistence.saveTransaction({
            transaction_id: record.transactionId,
            nonce: record.originalNonce,
            razorpay_order_id: receipt.razorpayOrderId || null,
            razorpay_payment_id: receipt.razorpayPaymentId || null,
            status: 'SETTLED',
            receipt_json: JSON.stringify(receipt),
            bundle_json: null,
            recommendations_offered: recsOffered,
            is_upsell_round: isUpsellRound ? 1 : 0,
            created_at: record.timestamp,
            confirmed_at: null,
            confirmed_by: null,
          });
        } catch (err: any) {
          console.warn(`[AgentPay] Ledger write failed (continuing): ${err.message}`);
        }

        // Publish capture confirmation through the unified event bus AFTER
        // persistence — mock/UAP-simulated captures emit internally; in live
        // test-mode the same confirmation arrives as an externally-signed
        // Razorpay webhook routed by POST /api/webhooks/razorpay into the
        // identical subscriber path.
        paymentBus().publish({
          kind: 'payment.captured',
          source: 'internal-synthetic',
          razorpayOrderId: receipt.razorpayOrderId,
          razorpayPaymentId: receipt.razorpayPaymentId,
          amountPaise: receipt.amount,
          transactionId: signedTx.transactionId,
          timestamp: new Date().toISOString(),
        });

        fsm.transition('SETTLED', 'EXECUTE_PAYMENT_SETTLEMENT', receipt, {
          razorpayOrderId: receipt.razorpayOrderId,
          razorpayPaymentId: receipt.razorpayPaymentId,
          auditDigest: receipt.cryptographicAuditDigest,
        });

        await this.evidence?.seal(
          'agentpay.payment.settled',
          sessionIdOf(),
          {
            transactionId: signedTx.transactionId,
            nonce: signedTx.nonce,
            quoteId: currentQuote?.quoteId,
            amount: receipt.amount,
            currency: receipt.currency,
            buyerDID: signedTx.buyerDID,
            merchantDID: this.identity.did,
            receiptId: receipt.receiptId,
            razorpayOrderId: receipt.razorpayOrderId,
            razorpayPaymentId: receipt.razorpayPaymentId,
            auditDigest: receipt.cryptographicAuditDigest,
            isUpsellRound,
          },
          { input: signedTx, output: receipt }
        );

        return wrapOutgoing(receipt, secure);
      },

      // 6. Autonomous Dispute & Reconciliation Handler (Two-Phase Atomicity)
      handleReconciliation: async (
        rawMessage: unknown
      ): Promise<SecureResult<ReconciliationProofMessage>> => {
        const { msg, secure } = unwrapIncoming<unknown>(rawMessage);

        // Runtime Zod validation
        const challenge = ReconciliationChallengeSchema.parse(msg);

        // Transition FSM to RECONCILING
        if (fsm.getState() === 'SIGNED') {
          fsm.transition('RECONCILING', 'RECEIVE_RECONCILIATION_CHALLENGE', challenge);
        } else if (fsm.getState() !== 'RECONCILING') {
          // If starting reconciliation in a fresh recovery session
          fsm.transition('RECONCILING', 'RECONNECT_RECONCILIATION', challenge);
        }

        // Verify Buyer's challenge signature
        if (channel) {
          const { signingKeyJwk } = extractKeysFromDIDDocument(channel.getSession().peerDIDDocument);
          await verifyCompactJWS<any>(challenge.buyerSignature, signingKeyJwk);
        }

        // Look up by originalNonce or transactionId
        const record = this.transactionStore.get(challenge.originalNonce) || this.transactionStore.get(challenge.transactionId);

        if (record && record.status === 'SETTLED' && record.receipt) {
          // Scenario 1: Payment was captured successfully -> sync receipt
          fsm.transition('SETTLED', 'REPLAY_SYNCED_SETTLEMENT_RECEIPT', record.receipt);

          const proofBody = {
            transactionId: record.transactionId,
            status: 'SETTLED' as const,
            razorpayOrderId: record.receipt.razorpayOrderId,
            razorpayPaymentId: record.receipt.razorpayPaymentId,
            timestamp: new Date().toISOString(),
          };

          const merchantSignature = await signCompactJWS(
            proofBody,
            this.identity.signingKeyPair.jwk.private,
            { kid: `${this.identity.did}#key-1` }
          );

          return wrapOutgoing(
            {
              type: 'RECONCILIATION_PROOF',
              transactionId: record.transactionId,
              status: 'SETTLED',
              settlementReceipt: record.receipt,
              merchantSignature,
              timestamp: new Date().toISOString(),
            },
            secure
          );
        } else {
          // Scenario 2: Payment failed / order never cleared -> return signed Void Certificate
          fsm.transition('ABORTED', 'ISSUE_VOID_CERTIFICATE', {
            transactionId: challenge.transactionId,
            originalNonce: challenge.originalNonce,
          });

          const voidProof = await createVoidProof(
            challenge.transactionId,
            'GATEWAY_TIMEOUT_ORDER_NOT_PROCESSED',
            {
              did: this.identity.did,
              signingPrivateKeyJwk: this.identity.signingKeyPair.jwk.private,
            }
          );

          return wrapOutgoing(voidProof, secure);
        }
      },
    };
  }
}
