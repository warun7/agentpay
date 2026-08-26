import type {
  BuyerStrategy,
  QuoteEvaluationDecision,
  ShoppingGoal,
  StrategyResult,
} from '../types.js';
import { DeterministicBuyerStrategy } from './deterministic.js';
import type { CatalogItem, QuoteMessage } from '../../protocol/schemas.js';

/**
 * Latency-optimized buyer strategy for interactive flows (chat + demo route):
 * the LLM drives WHAT to buy — the demo-visible decision — while quote
 * evaluation runs deterministically. Its interesting failure mode (mandate
 * violation) is already enforced by checkMandateBounds regardless of opinion,
 * so the extra LLM hop bought nothing but seconds.
 *
 * Cuts per-round Gemini/OpenRouter hops from 4 to 3; free-tier latency stacks
 * fast across sequential calls.
 */
export class HybridBuyerStrategy implements BuyerStrategy {
  readonly name = 'llm-buyer-hybrid';
  private fallback = new DeterministicBuyerStrategy();

  constructor(private readonly llm: BuyerStrategy) {}

  async decideIntent(
    catalog: CatalogItem[],
    remainingBudgetPaise: number,
    goal?: ShoppingGoal
  ) {
    return this.llm.decideIntent(catalog, remainingBudgetPaise, goal);
  }

  async evaluateQuote(
    quote: QuoteMessage,
    mandateMaxAmountPaise: number,
    category: string
  ): Promise<StrategyResult<QuoteEvaluationDecision>> {
    return this.fallback.evaluateQuote(quote, mandateMaxAmountPaise, category);
  }
}
