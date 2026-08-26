import { z } from 'zod';

/**
 * FLAT decision schemas — deliberately decoupled from the nested wire protocol
 * schemas. LLM structured output works best on flat, union-free shapes; the
 * firewall validates against THESE, and strategies map results onto protocol
 * messages afterwards.
 *
 * Gemini responseSchema counterparts are hand-maintained alongside (see
 * GEMINI_*_SCHEMA below). Keep the two in sync.
 */

// ── Zod firewalls ────────────────────────────────────────────────────────────

export const IntentDecisionSchema = z.object({
  itemId: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(10),
  offeredUnitPrice: z.number().int().positive().max(100000000).optional(),
  negotiationReason: z.string().min(1).max(300),
  rationale: z.string().min(1).max(1000),
});

export const PricingDecisionSchema = z.object({
  discountPercentage: z.number().min(0).max(0.5),
  rationale: z.string().min(1).max(1000),
});

export const QuoteEvaluationSchema = z.object({
  action: z.enum(['accept', 'reject']),
  rationale: z.string().min(1).max(1000),
});

export type IntentDecisionPayload = z.infer<typeof IntentDecisionSchema>;
export type PricingDecisionPayload = z.infer<typeof PricingDecisionSchema>;
export type QuoteEvaluationPayload = z.infer<typeof QuoteEvaluationSchema>;

// ── Gemini responseSchema counterparts (OpenAPI subset, flat) ───────────────

export const GEMINI_INTENT_DECISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    itemId: { type: 'STRING', description: 'Catalog item id to purchase' },
    quantity: { type: 'INTEGER', description: 'Units to buy, between 1 and 10' },
    offeredUnitPrice: {
      type: 'INTEGER',
      description: 'Offered unit price in paise (must be >= 85% of basePrice)',
    },
    negotiationReason: { type: 'STRING', description: 'Short commercial justification (<200 chars)' },
    rationale: { type: 'STRING', description: 'One-paragraph explanation of the buying decision' },
  },
  required: ['itemId', 'quantity', 'negotiationReason', 'rationale'],
};

export const GEMINI_PRICING_DECISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    discountPercentage: {
      type: 'NUMBER',
      description: 'Discount as a fraction (0.05 = 5%). Must be between 0.05 and 0.15.',
    },
    rationale: { type: 'STRING', description: 'One-paragraph explanation of the pricing decision' },
  },
  required: ['discountPercentage', 'rationale'],
};

export const GEMINI_QUOTE_EVALUATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['accept', 'reject'], description: 'Accept or reject the quote' },
    rationale: { type: 'STRING', description: 'One-paragraph explanation of the decision' },
  },
  required: ['action', 'rationale'],
};
