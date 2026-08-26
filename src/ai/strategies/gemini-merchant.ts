import type { LLMProvider } from '../llm-failover.js';
import { validateWithRetry, LLMFirewallError } from '../firewall.js';
import { z } from 'zod';
import { PricingDecisionSchema, GEMINI_PRICING_DECISION_SCHEMA } from '../schemas.js';
import { DeterministicMerchantStrategy } from './deterministic.js';
import type { MerchantStrategy, PricingDecision, StrategyResult } from '../types.js';
import type { CatalogItem, PurchaseIntentMessage, RecommendationMessage } from '../../protocol/schemas.js';

/**
 * Gemini-powered merchant pricing strategy (revenue optimization).
 *
 * The LLM chooses a discount INSIDE a hard-clamped band [5%, 15%]:
 *   - floor 5%: preserves the agentic-commerce incentive
 *   - cap 15%:  the LLM can NEVER give away margin beyond this — even if it
 *               hallucinates "47% off", the protocol boundary clamps it.
 *
 * This clamp is the flagship anti-hallucination demo: the AI proposes, the
 * protocol disposes.
 */

export const DISCOUNT_FLOOR = 0.05;
export const DISCOUNT_CAP = 0.15;

const SYSTEM_INSTRUCTION =
  'You are the dynamic pricing module of an AI merchant selling AI-infra capacity. ' +
  'You grow revenue by closing deals with autonomous buyer agents without eroding margin. ' +
  'Respond ONLY with JSON matching the requested schema.';

export class GeminiMerchantStrategy implements MerchantStrategy {
  readonly name = 'gemini-merchant';
  private fallback = new DeterministicMerchantStrategy();

  constructor(private readonly client: LLMProvider) {}

  async priceIntent(
    intent: PurchaseIntentMessage,
    item: CatalogItem
  ): Promise<StrategyResult<PricingDecision>> {
    const line = intent.items[0];
    const prompt =
      `A buyer agent submitted this purchase intent:\n` +
      JSON.stringify(
        {
          itemId: item.id,
          itemName: item.name,
          category: item.category,
          basePricePaise: item.basePrice,
          stock: item.stock,
          quantityRequested: line?.quantity ?? 1,
          offeredUnitPrice: line?.offeredUnitPrice,
          negotiationReason: intent.negotiationReason,
        },
        null,
        2
      ) +
      `\n\nTASK: Choose a discount fraction between ${DISCOUNT_FLOOR} and ${DISCOUNT_CAP}. ` +
      `Consider volume, the buyer's offer vs list price, and inventory position. ` +
      `Values outside [${DISCOUNT_FLOOR}, ${DISCOUNT_CAP}] will be clamped by the protocol.`;

    try {
      const { data, attempts } = await validateWithRetry({
        schema: PricingDecisionSchema,
        call: (feedback) =>
          this.client.generateJSON(feedback ? `${prompt}\n\nCORRECTION NEEDED: ${feedback}` : prompt, GEMINI_PRICING_DECISION_SCHEMA, SYSTEM_INSTRUCTION).then((r) => r.raw),
      });

      const clamped = Math.min(DISCOUNT_CAP, Math.max(DISCOUNT_FLOOR, data.discountPercentage));

      return {
        decision: {
          discountPercentage: clamped,
          // Note: the protocol layer annotates the trace when its clamp fires.
          rationale: data.rationale,
        },
        source: `llm-${this.client.name}`,
        attempts: attempts.length + 1,
      };
    } catch (err: any) {
      if (err instanceof LLMFirewallError || err.name === 'GeminiTransportError') {
        return this.fallback.priceIntent(intent, item);
      }
      throw err;
    }
  }

  /**
   * LLM growth agent. The model proposes WHICH complementary items and why;
   * the protocol enforces pricing discipline — every offeredUnitPrice is
   * recomputed as basePrice × (1 − appliedDiscount) server-side, so the LLM
   * cannot invent margin on recommendations either.
   */
  async recommend(
    primaryItem: CatalogItem,
    catalog: CatalogItem[],
    appliedDiscount: number,
    _quantityRequested: number
  ): Promise<StrategyResult<RecommendationMessage[]>> {
    const RecSchema = z.object({
      recommendations: z
        .array(
          z.object({
            itemId: z.string().min(1).max(64),
            reason: z.string().min(1).max(300),
          })
        )
        .max(2),
    });

    const others = catalog.filter((c) => c.id !== primaryItem.id && c.stock > 0);
    const prompt =
      `Primary purchase: ${primaryItem.name} (${primaryItem.category})\n` +
      `OTHER CATALOG:\n${JSON.stringify(others.map((c) => ({ itemId: c.id, name: c.name, category: c.category })), null, 2)}\n\n` +
      `TASK: Recommend 0-2 complementary items an AI-infra team would co-provision with this purchase. ` +
      `Only pick itemId values from OTHER CATALOG. Explain each in one line.`;

    try {
      const { data, attempts } = await validateWithRetry({
        schema: RecSchema,
        call: (feedback) =>
          this.client.generateJSON(feedback ? `${prompt}\nCORRECTION: ${feedback}` : prompt, {
            type: 'OBJECT',
            properties: {
              recommendations: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    itemId: { type: 'STRING' },
                    reason: { type: 'STRING' },
                  },
                  required: ['itemId', 'reason'],
                },
              },
            },
            required: ['recommendations'],
          }, SYSTEM_INSTRUCTION).then((r) => r.raw),
      });

      // Price discipline is PROTOCOL-owned: recompute every price server-side.
      const recs: RecommendationMessage[] = data.recommendations
        .map((r) => {
          const item = others.find((c) => c.id === r.itemId);
          if (!item) return null;
          return {
            itemId: item.id,
            name: item.name,
            quantity: 1,
            offeredUnitPrice: Math.round(item.basePrice * (1 - appliedDiscount)),
            reason: r.reason,
          };
        })
        .filter((r): r is RecommendationMessage => r !== null)
        .slice(0, 2);

      return { decision: recs, source: `llm-${this.client.name}`, attempts: attempts.length + 1 };
    } catch (err: any) {
      if (err instanceof LLMFirewallError || err.name === 'GeminiTransportError') {
        return this.fallback.recommend(primaryItem, catalog, appliedDiscount);
      }
      throw err;
    }
  }
}
