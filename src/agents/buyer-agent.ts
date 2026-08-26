import { v4 as uuidv4 } from 'uuid';
import { createAgentIdentity, extractKeysFromDIDDocument } from '../identity/did.js';
import type { JWKKey } from '../crypto/types.js';
import { issueSpendingMandate } from '../identity/credentials.js';
import { completeHandshake } from '../session/handshake.js';
import { SecureChannel } from '../session/secure-channel.js';
import {
  evaluateQuoteAgainstMandate,
  signTransactionPayload,
  createReconciliationChallenge,
  verifyQuoteSignature,
} from '../protocol/negotiation.js';
import { verifyCompactJWS } from '../crypto/signatures.js';
import type {
  BuyerStrategy,
  IntentDecision,
  ShoppingGoal,
  StrategyResult,
} from '../ai/types.js';
import { DeterministicBuyerStrategy } from '../ai/strategies/deterministic.js';
import type { AgentIdentity, VerifiableCredential, SpendingConstraints } from '../identity/types.js';
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
  RecommendationMessage,
} from '../protocol/schemas.js';


export interface BuyerAgentOptions {
  name?: string;
  spendingMandate?: VerifiableCredential;
  userWalletIdentity?: AgentIdentity;
  constraints?: SpendingConstraints;
  /** Commercial strategy (default: deterministic). LLM strategies are injected here. */
  strategy?: BuyerStrategy;
}

export class BuyerAgent {
  public identity: AgentIdentity;
  public userWalletIdentity: AgentIdentity;
  public mandate: VerifiableCredential | null = null;
  public strategy: BuyerStrategy;

  constructor(options: BuyerAgentOptions = {}) {
    this.identity = createAgentIdentity(options.name || 'AgentPay Buyer Agent', 'buyer');
    this.userWalletIdentity = options.userWalletIdentity || createAgentIdentity('User Primary Wallet', 'buyer');
    this.strategy = options.strategy || new DeterministicBuyerStrategy();

    if (options.spendingMandate) {
      this.mandate = options.spendingMandate;
    }
  }

  /**
   * Provisions a user spending mandate if not already assigned.
   */
  public async provisionMandate(
    constraints: SpendingConstraints = {
      maxAmount: 500000, // ₹5,000.00
      currency: 'INR',
      allowedCategories: ['cloud_services', 'saas_subscription'],
      merchantWhitelist: ['*'],
    }
  ): Promise<VerifiableCredential> {
    this.mandate = await issueSpendingMandate({
      issuerIdentity: {
        did: this.userWalletIdentity.did,
        signingPrivateKeyJwk: this.userWalletIdentity.signingKeyPair.jwk.private,
      },
      subjectDID: this.identity.did,
      constraints,
      userUpiId: 'varun.developer@okhdfcbank',
      uapMandateCircleRef: `uap_circle_mandate_${uuidv4().substring(0, 8)}`,
    });

    return this.mandate;
  }

  public getDID(): string {
    return this.identity.did;
  }

  /**
   * Generates the initial DID Exchange message.
   */
  public createDIDExchangeMessage(): DIDExchangeMessage {
    return {
      type: 'DID_EXCHANGE',
      agentRole: 'buyer',
      did: this.identity.did,
      didDocument: this.identity.didDocument,
    };
  }

  /**
   * Completes ECDH key exchange with the merchant's DID document.
   */
  public establishSession(merchantDIDDocument: any): SecureChannel {
    const session = completeHandshake(this.identity, merchantDIDDocument);
    return new SecureChannel(session);
  }

  /**
   * Generates the Mandate Presentation message.
   */
  public createMandatePresentation(): MandatePresentationMessage {
    if (!this.mandate) {
      throw new Error('Buyer Agent cannot present mandate: No spending mandate provisioned');
    }

    return {
      type: 'MANDATE_PRESENTATION',
      verifiableCredential: this.mandate,
    };
  }

  /**
   * Generates a Catalog Request.
   */
  public createCatalogRequest(category?: string): CatalogRequestMessage {
    return {
      type: 'CATALOG_REQUEST',
      category,
    };
  }

  /**
   * Selects an item from the catalog and generates a Purchase Intent.
   */
  public createPurchaseIntent(
    itemId: string,
    quantity = 1,
    offeredUnitPrice?: number
  ): PurchaseIntentMessage {
    return {
      type: 'PURCHASE_INTENT',
      cartId: `cart_${uuidv4().substring(0, 8)}`,
      items: [
        {
          itemId,
          quantity,
          offeredUnitPrice,
        },
      ],
      negotiationReason: 'Automated agent volume procurement',
    };
  }

  /**
   * Strategy-driven purchase decision. The LLM (or deterministic policy)
   * proposes WHAT to buy; this method maps the validated decision onto a
   * protocol intent message. No cryptographic authority is granted.
   */
  public async decidePurchaseIntent(
    catalog: CatalogItem[],
    opts: { remainingBudgetPaise: number; goal?: ShoppingGoal }
  ): Promise<{ intent: PurchaseIntentMessage; strategyResult: StrategyResult<IntentDecision> }> {
    const result = await this.strategy.decideIntent(catalog, opts.remainingBudgetPaise, opts.goal);
    const d = result.decision;
    const intent = this.createPurchaseIntent(d.itemId, d.quantity, d.offeredUnitPrice);
    intent.negotiationReason = d.negotiationReason;
    return { intent, strategyResult: result };
  }

  /**
   * Strategy opinion on a received quote. ADVISORY ONLY — proceed=false skips
   * the purchase, but proceed=true does NOT authorize signing: that still
   * requires evaluateAndSignQuote(), where checkMandateBounds is the gate.
   *
   * P1: requires quote signature verification — an unverifiable (or tampered)
   * quote can never reach advisory approval, let alone signing.
   *
   * HARD OVERRIDE: if the deterministic bounds checker rejects an over-cap
   * quote while the strategy said "accept", the decision is flipped to reject
   * with an explicit override rationale. No strategy verdict can mask a
   * mandate violation.
   */
  public async strategicEvaluateQuote(
    quote: QuoteMessage,
    category: string,
    merchantDID: string,
    merchantSigningPublicKeyJwk: JWKKey
  ): Promise<{ proceed: boolean; evaluation: StrategyResult<import('../ai/types.js').QuoteEvaluationDecision> }> {
    if (!this.mandate) throw new Error('Cannot evaluate quote without a spending mandate');

    const sigCheck = await verifyQuoteSignature(quote, merchantSigningPublicKeyJwk);
    if (!sigCheck.valid) {
      return {
        proceed: false,
        evaluation: {
          decision: {
            action: 'reject',
            rationale: `QUOTE SIGNATURE REJECTED: ${sigCheck.reason}. Advisory strategies never run on unverifiable quotes.`,
          },
          source: 'deterministic',
          attempts: 0,
        },
      };
    }

    const cap = this.mandate.credentialSubject.spendingConstraints.maxAmount;
    let evaluation = await this.strategy.evaluateQuote(quote, cap, category);
    const bounds = evaluateQuoteAgainstMandate(quote, this.mandate, category, merchantDID);

    if (!bounds.approved && evaluation.decision.action === 'accept') {
      evaluation = {
        ...evaluation,
        decision: {
          action: 'reject',
          rationale:
            `HARD OVERRIDE: quote total ₹${quote.totalAmount / 100} violates mandate bounds ` +
            `(${bounds.reason}). Strategy suggested accept — deterministic bounds checker prevails. ` +
            `[Strategy rationale: ${evaluation.decision.rationale}]`,
        },
      };
    }

    return { proceed: evaluation.decision.action === 'accept' && bounds.approved, evaluation };
  }

  /**
   * Growth-agent counterpart: decide which merchant recommendations to accept.
   *
   * Deterministic gate (strategy-proof): a recommendation is ONLY acceptable if
   *   price = offeredUnitPrice × quantity fits in remainingBudget, AND
   *   its full round cost (price × 1.121 GST/discount envelope) still fits the mandate cap.
   * The LLM's opinion only chooses among ALREADY-affordable items — it can
   * never spend money the mandate doesn't allow.
   */
  public async evaluateRecommendations(
    recs: RecommendationMessage[],
    remainingBudgetPaise: number,
    mandateCapPaise: number
  ): Promise<{
    accepted: RecommendationMessage[];
    declined: RecommendationMessage[];
    strategyResult?: StrategyResult<import('../ai/types.js').QuoteEvaluationDecision>;
  }> {
    const affordable = recs.filter((r) => {
      const linePrice = r.offeredUnitPrice * r.quantity;
      return (
        linePrice <= remainingBudgetPaise &&
        Math.round(linePrice * 1.121) <= Math.min(mandateCapPaise, remainingBudgetPaise)
      );
    });

    if (affordable.length === 0) {
      return {
        accepted: [],
        declined: recs.map((r) => ({ ...r, reason: `Over remaining budget — ${r.reason}` })),
      };
    }

    // Ask the strategy for an opinion on the top affordable candidate only
    const target = affordable[0];
    const pseudoQuote: QuoteMessage = {
      type: 'QUOTE_RESPONSE',
      quoteId: `rec_${target.itemId}`,
      cartId: 'recommendation',
      subtotal: target.offeredUnitPrice * target.quantity,
      discount: 0,
      tax: 0,
      totalAmount: target.offeredUnitPrice * target.quantity,
      currency: 'INR',
      merchantUpiId: '',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      merchantSignature: 'n/a',
    };

    let evaluation;
    try {
      evaluation = await this.strategy.evaluateQuote(pseudoQuote, mandateCapPaise, 'cloud_services');
    } catch {
      // Strategy opinions are advisory; affordability already passed
      return { accepted: [target], declined: recs.filter((r) => r !== target) };
    }

    if (evaluation.decision.action === 'accept') {
      return { accepted: [target], declined: recs.filter((r) => r !== target), strategyResult: evaluation };
    }
    return { accepted: [], declined: [...recs] };
  }

  /**
   * Builds the bounded upsell-round intent from an accepted recommendation.
   */
  public createUpsellIntent(rec: RecommendationMessage): PurchaseIntentMessage {
    return {
      type: 'PURCHASE_INTENT',
      cartId: `cart_${uuidv4().substring(0, 8)}`,
      items: [{ itemId: rec.itemId, quantity: rec.quantity, offeredUnitPrice: rec.offeredUnitPrice }],
      negotiationReason: rec.reason,
    };
  }

  /**
   * Evaluates a merchant's quote and creates a signed transaction commitment if approved.
   */
  public async evaluateAndSignQuote(
    quote: QuoteMessage,
    category: string,
    merchantDID: string,
    merchantSigningPublicKeyJwk: JWKKey
  ): Promise<TransactionPayloadMessage> {
    if (!this.mandate) {
      throw new Error('Cannot evaluate quote without a spending mandate');
    }

    // ── P1 GATE: quote must be verifiably signed by the expected merchant ──
    // This runs BEFORE mandate approval — a tampered amount, swapped UPI ID,
    // or modified recommendation can never reach a signed transaction.
    const sigCheck = await verifyQuoteSignature(quote, merchantSigningPublicKeyJwk);
    if (!sigCheck.valid) {
      throw new Error(`Quote signature verification failed — refusing to sign: ${sigCheck.reason}`);
    }

    // Deterministic bounds evaluation against the Verifiable Credential mandate
    const evaluation = evaluateQuoteAgainstMandate(quote, this.mandate, category, merchantDID);
    if (!evaluation.approved) {
      throw new Error(`Quote rejected by deterministic mandate bounds checker: ${evaluation.reason}`);
    }

    // Cryptographically sign the transaction payload with Ed25519 private key
    return await signTransactionPayload(
      quote,
      {
        did: this.identity.did,
        signingPrivateKeyJwk: this.identity.signingKeyPair.jwk.private,
      },
      merchantDID
    );
  }

  /**
   * Generates a signed Reconciliation Challenge when a network timeout occurs post-signing.
   * Delegates to the canonical implementation in negotiation.ts (Bug 6 fix: deduplication).
   */
  public async createReconciliationChallenge(
    transactionId: string,
    quoteId: string,
    originalNonce: string
  ): Promise<ReconciliationChallengeMessage> {
    return createReconciliationChallenge(transactionId, quoteId, originalNonce, {
      did: this.identity.did,
      signingPrivateKeyJwk: this.identity.signingKeyPair.jwk.private,
    });
  }

  /**
   * Verifies and processes a Reconciliation Proof received from the merchant.
   */
  public async processReconciliationProof(
    proof: ReconciliationProofMessage,
    merchantSigningKeyJwk: any
  ): Promise<{
    settled: boolean;
    receipt?: SettlementReceiptMessage;
    reason?: string;
  }> {
    // Verify Merchant signature on the proof
    const { payload } = await verifyCompactJWS<any>(proof.merchantSignature, merchantSigningKeyJwk);

    if (payload.transactionId !== proof.transactionId || payload.status !== proof.status) {
      throw new Error('Reconciliation proof payload signature mismatch');
    }

    if (proof.status === 'SETTLED' && proof.settlementReceipt) {
      return {
        settled: true,
        receipt: proof.settlementReceipt,
      };
    } else {
      return {
        settled: false,
        reason: proof.reason || 'Transaction voided by merchant',
      };
    }
  }
}


