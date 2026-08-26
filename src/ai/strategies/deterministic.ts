import type {
  BuyerStrategy,
  MerchantStrategy,
  IntentDecision,
  PricingDecision,
  QuoteEvaluationDecision,
  StrategyResult,
  ShoppingGoal,
} from '../types.js';
import type { CatalogItem, PurchaseIntentMessage, QuoteMessage, RecommendationMessage } from '../../protocol/schemas.js';

/**
 * Deterministic strategies — the always-available baseline.
 * Identical behavior to the pre-AI AgentPay pipeline. Used when no LLM key
 * is configured AND as the safety fallback whenever the firewall rejects
 * persistent malformed LLM output.
 */

const AGENT_OFFER_RATIO = 0.92; // offer 8% below base price

export class DeterministicBuyerStrategy implements BuyerStrategy {
  readonly name = 'deterministic-buyer';

  async decideIntent(
    catalog: CatalogItem[],
    remainingBudgetPaise: number,
    goal?: ShoppingGoal
  ): Promise<StrategyResult<IntentDecision>> {
    let pool = catalog.filter((i) => i.stock > 0 && i.basePrice <= remainingBudgetPaise);
    if (goal?.category) pool = pool.filter((i) => i.category === goal.category);
    if (goal?.itemId) pool = pool.filter((i) => i.id === goal.itemId);

    const item =
      pool.sort((a, b) => b.basePrice - a.basePrice)[0] ||
      catalog.filter((i) => i.stock > 0).sort((a, b) => a.basePrice - b.basePrice)[0];

    if (!item) throw new Error('No purchasable catalog item within budget');

    const quantity = Math.max(1, Math.min(goal?.quantity ?? 1, item.stock, 10));

    return {
      decision: {
        itemId: item.id,
        quantity,
        offeredUnitPrice: Math.round(item.basePrice * AGENT_OFFER_RATIO),
        negotiationReason: 'Automated agent volume procurement',
        rationale:
          `Deterministic policy: selected ${item.name} at ${Math.round(AGENT_OFFER_RATIO * 100)}% of ` +
          `base price (₹${item.basePrice / 100}) within remaining budget ₹${remainingBudgetPaise / 100}.`,
      },
      source: 'deterministic',
      attempts: 0,
    };
  }

  async evaluateQuote(
    quote: QuoteMessage,
    mandateMaxAmountPaise: number,
    _category: string
  ): Promise<StrategyResult<QuoteEvaluationDecision>> {
    const approved = quote.totalAmount <= mandateMaxAmountPaise;
    return {
      decision: {
        action: approved ? 'accept' : 'reject',
        rationale: approved
          ? `Deterministic policy: quote total ₹${quote.totalAmount / 100} is within mandate cap ₹${mandateMaxAmountPaise / 100}.`
          : `Deterministic policy: quote total ₹${quote.totalAmount / 100} exceeds mandate cap ₹${mandateMaxAmountPaise / 100}.`,
      },
      source: 'deterministic',
      attempts: 0,
    };
  }
}

export class DeterministicMerchantStrategy implements MerchantStrategy {
  readonly name = 'deterministic-merchant';

  async priceIntent(
    _intent: PurchaseIntentMessage,
    _item: CatalogItem
  ): Promise<StrategyResult<PricingDecision>> {
    return {
      decision: {
        discountPercentage: 0.05, // standard agent-commerce discount
        rationale: 'Deterministic policy: flat 5% agentic-commerce discount.',
      },
      source: 'deterministic',
      attempts: 0,
    };
  }

  /**
   * Rule-based cross-sell map — the deterministic growth agent baseline.
   * Price discipline: basePrice × (1 − appliedDiscount), identical to the
   * primary line's discount. Never proposes items already in the cart.
   */
  async recommend(
    primaryItem: CatalogItem,
    catalog: CatalogItem[],
    appliedDiscount: number
  ): Promise<StrategyResult<RecommendationMessage[]>> {
    const CROSS_SELL_MAP: Record<string, string[]> = {
      item_gpu_h100_cluster: ['item_vector_db_pro', 'item_api_gateway_enterprise'],
      item_gpu_a100_node: ['item_api_gateway_enterprise'],
      item_api_gateway_enterprise: ['item_vector_db_pro'],
      item_vector_db_pro: ['item_api_gateway_enterprise'],
    };

    const candidates = (CROSS_SELL_MAP[primaryItem.id] || [])
      .map((id) => catalog.find((c) => c.id === id))
      .filter((c): c is CatalogItem => !!c && c.stock > 0)
      .slice(0, 1)
      .map((item) => ({
        itemId: item.id,
        name: item.name,
        quantity: 1,
        offeredUnitPrice: Math.round(item.basePrice * (1 - appliedDiscount)),
        reason: `Frequently co-provisioned with ${primaryItem.name} by AI-infra teams.`,
      }));

    return { decision: candidates, source: 'deterministic', attempts: 0 };
  }
}
