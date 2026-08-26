import type { LLMProvider } from '../llm-failover.js';
import { validateWithRetry, LLMFirewallError, type FirewallAttempt } from '../firewall.js';
import {
  IntentDecisionSchema,
  QuoteEvaluationSchema,
  GEMINI_INTENT_DECISION_SCHEMA,
  GEMINI_QUOTE_EVALUATION_SCHEMA,
} from '../schemas.js';
import { DeterministicBuyerStrategy } from './deterministic.js';
import type {
  BuyerStrategy,
  IntentDecision,
  QuoteEvaluationDecision,
  StrategyResult,
  ShoppingGoal,
} from '../types.js';
import type { CatalogItem, PurchaseIntentMessage, QuoteMessage } from '../../protocol/schemas.js';

/**
 * Gemini-powered buyer strategy.
 *
 * Guardrails (defense in depth):
 *   1. Zod firewall with repair loop (validateWithRetry)
 *   2. Semantic clamps — itemId must exist in catalog; quantity bounded by
 *      stock; offeredUnitPrice floored at 85% of base (protocol floor) and
 *      capped at list price
 *   3. On firewall exhaustion or transport failure → deterministic fallback
 *
 * The strategy NEVER approves a purchase: signing remains gated by the
 * deterministic mandate bounds checker in evaluateAndSignQuote().
 */

const PROTOCOL_OFFER_FLOOR = 0.85;
const DEFAULT_OFFER_RATIO = 0.92;

const SYSTEM_INSTRUCTION =
  'You are the commercial strategy module of an autonomous AI procurement agent. ' +
  'You maximize value for the principal within a hard spending mandate. ' +
  'Respond ONLY with JSON matching the requested schema. Prices are integers in paise (100 paise = ₹1).';

export class GeminiBuyerStrategy implements BuyerStrategy {
  readonly name = 'gemini-buyer';
  private fallback = new DeterministicBuyerStrategy();

  constructor(private readonly client: LLMProvider) {}

  async decideIntent(
    catalog: CatalogItem[],
    remainingBudgetPaise: number,
    goal?: ShoppingGoal
  ): Promise<StrategyResult<IntentDecision>> {
    const prompt =
      `You are purchasing on behalf of a research team.\n\n` +
      `REMAINING BUDGET: ${remainingBudgetPaise} paise\n` +
      (goal?.notes ? `SHOPPING GOAL: ${goal.notes}\n` : '') +
      `\nCATALOG (basePrice in paise):\n` +
      JSON.stringify(
        catalog.map((i) => ({
          itemId: i.id,
          name: i.name,
          category: i.category,
          basePrice: i.basePrice,
          stock: i.stock,
        })),
        null,
        2
      ) +
      `\n\nTASK: Select ONE item and quantity. Rules:\n` +
      `- The item's basePrice must be <= REMAINING BUDGET.\n` +
      `- quantity between 1 and min(10, stock).\n` +
      `- offeredUnitPrice must be an integer between ${Math.round(PROTOCOL_OFFER_FLOOR * 100)}% and 100% of the item's basePrice.`;

    try {
      const { data, attempts } = await validateWithRetry({
        schema: IntentDecisionSchema,
        call: (feedback) =>
          this.client.generateJSON(feedback ? `${prompt}\n\nCORRECTION NEEDED: ${feedback}` : prompt, GEMINI_INTENT_DECISION_SCHEMA, SYSTEM_INSTRUCTION).then((r) => r.raw),
      });

      const decision = this.clampIntent(data, catalog, remainingBudgetPaise);
      if (!decision) {
        // Semantically invalid (unknown item / over budget) → deterministic path
        return this.withAttempts(await this.fallback.decideIntent(catalog, remainingBudgetPaise, goal), attempts);
      }
      return { decision, source: `llm-${this.client.name}`, attempts: attempts.length + 1 };
    } catch (err: any) {
      if (err instanceof LLMFirewallError || err.name === 'GeminiTransportError') {
        return this.fallback.decideIntent(catalog, remainingBudgetPaise, goal);
      }
      throw err;
    }
  }

  async evaluateQuote(
    quote: QuoteMessage,
    mandateMaxAmountPaise: number,
    category: string
  ): Promise<StrategyResult<QuoteEvaluationDecision>> {
    const prompt =
      `Evaluate this signed merchant quote against your mandate.\n\n` +
      `MANDATE CAP: ${mandateMaxAmountPaise} paise\n` +
      `CATEGORY: ${category}\n` +
      `QUOTE:\n${JSON.stringify(
        {
          quoteId: quote.quoteId,
          subtotal: quote.subtotal,
          discount: quote.discount,
          tax: quote.tax,
          totalAmount: quote.totalAmount,
          expiresAt: quote.expiresAt,
        },
        null,
        2
      )}` +
      `\n\nTASK: Decide accept or reject. The protocol will independently enforce the mandate cap — ` +
      `your rationale should focus on value-for-money.`;

    try {
      const { data, attempts } = await validateWithRetry({
        schema: QuoteEvaluationSchema,
        call: (feedback) =>
          this.client.generateJSON(feedback ? `${prompt}\n\nCORRECTION NEEDED: ${feedback}` : prompt, GEMINI_QUOTE_EVALUATION_SCHEMA, SYSTEM_INSTRUCTION).then((r) => r.raw),
      });

      // Hard semantic override: over-cap quotes are ALWAYS rejected regardless of LLM opinion.
      if (quote.totalAmount > mandateMaxAmountPaise && data.action === 'accept') {
        return {
          decision: {
            action: 'reject',
            rationale:
              `HARD OVERRIDE: quote total ₹${quote.totalAmount / 100} exceeds mandate cap ` +
              `₹${mandateMaxAmountPaise / 100}. LLM suggested accept — deterministic bounds checker prevails.`,
          },
          source: `llm-${this.client.name}`,
          attempts: attempts.length + 1,
        };
      }

      return { decision: data, source: `llm-${this.client.name}`, attempts: attempts.length + 1 };
    } catch (err: any) {
      if (err instanceof LLMFirewallError || err.name === 'GeminiTransportError') {
        return this.fallback.evaluateQuote(quote, mandateMaxAmountPaise, category);
      }
      throw err;
    }
  }

  /** Semantic clamp: returns null when the LLM picked something unusable. */
  private clampIntent(
    data: import('../schemas.js').IntentDecisionPayload,
    catalog: CatalogItem[],
    remainingBudgetPaise: number
  ): IntentDecision | null {
    const item = catalog.find((i) => i.id === data.itemId);
    if (!item || item.stock < 1) return null;
    if (item.basePrice > remainingBudgetPaise) return null;

    const quantity = Math.max(1, Math.min(data.quantity, item.stock, 10));

    let offeredUnitPrice = data.offeredUnitPrice ?? Math.round(item.basePrice * DEFAULT_OFFER_RATIO);
    offeredUnitPrice = Math.max(
      Math.round(item.basePrice * PROTOCOL_OFFER_FLOOR),
      Math.min(offeredUnitPrice, item.basePrice)
    );

    return {
      itemId: item.id,
      quantity,
      offeredUnitPrice,
      negotiationReason: data.negotiationReason,
      rationale: data.rationale,
    };
  }

  private withAttempts<T>(result: StrategyResult<T>, attempts: FirewallAttempt[]): StrategyResult<T> {
    return { ...result, attempts: attempts.length };
  }
}
