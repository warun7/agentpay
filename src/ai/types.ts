import type { CatalogItem, PurchaseIntentMessage, QuoteMessage, RecommendationMessage } from '../protocol/schemas.js';

/**
 * AgentPay AI Strategy Layer — Type Contracts.
 *
 * Design invariant ("LLM proposes, protocol disposes"):
 *   Strategies are ADVISORS. They produce decisions + human-readable rationales.
 *   They never touch signing keys, never see the gateway, and their output is
 *   always re-validated: Zod firewall -> semantic clamps -> deterministic
 *   mandate bounds checker -> FSM. No strategy verdict can bypass the gate.
 */

export interface ShoppingGoal {
  itemId?: string;
  category?: string;
  budgetPaise?: number;
  quantity?: number;
  notes?: string;
}

export interface IntentDecision {
  itemId: string;
  quantity: number;
  offeredUnitPrice?: number; // paise
  negotiationReason: string;
  rationale: string;
}

export interface PricingDecision {
  discountPercentage: number; // fraction, e.g. 0.07 = 7%
  rationale: string;
}

export interface QuoteEvaluationDecision {
  action: 'accept' | 'reject';
  rationale: string;
}

/** Where a decision came from — surfaced in UI reasoning cards and audit logs.
 *  LLM sources are provider-labeled: llm-openrouter, llm-gemini, etc. */
export type DecisionSource = 'deterministic' | `llm-${string}`;

export interface StrategyResult<T> {
  decision: T;
  source: DecisionSource;
  /** Firewall attempts consumed (1 = clean first pass). */
  attempts: number;
}

export interface BuyerStrategy {
  readonly name: string;
  decideIntent(
    catalog: CatalogItem[],
    remainingBudgetPaise: number,
    goal?: ShoppingGoal
  ): Promise<StrategyResult<IntentDecision>>;
  evaluateQuote(
    quote: QuoteMessage,
    mandateMaxAmountPaise: number,
    category: string
  ): Promise<StrategyResult<QuoteEvaluationDecision>>;
}

export interface MerchantStrategy {
  readonly name: string;
  priceIntent(
    intent: PurchaseIntentMessage,
    item: CatalogItem
  ): Promise<StrategyResult<PricingDecision>>;
  /**
   * Growth agent: propose 0-2 complementary/tier-up items for the cart.
   * Prices MUST be derived as basePrice × (1 − appliedDiscount) so the
   * recommendation can never carry hidden margin. Optional — strategies
   * without it simply don't upsell.
   */
  recommend?(
    primaryItem: CatalogItem,
    catalog: CatalogItem[],
    appliedDiscount: number,
    quantityRequested: number
  ): Promise<StrategyResult<RecommendationMessage[]>>;
}
