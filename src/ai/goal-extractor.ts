import { z } from 'zod';
import type { LLMProvider } from './llm-failover.js';
import { validateWithRetry } from './firewall.js';
import type { ShoppingGoal } from './types.js';

/**
 * Natural-language shopping-goal extraction for conversational checkout.
 *
 * Primary path: Gemini structured output (flat schema).
 * Fallback path: deterministic heuristic parser (keyword/regex) so the chat
 * demo works fully OFFLINE when no key is configured. Both outputs pass the
 * same Zod firewall before touching the protocol.
 */

export const ShoppingGoalExtractionSchema = z.object({
  action: z.enum(['purchase', 'chitchat']),
  itemIdHint: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  budgetPaise: z.number().int().positive().max(100000000).optional(),
  quantity: z.number().int().positive().max(10).optional(),
  notes: z.string().min(1).max(400),
});

export type ShoppingGoalExtraction = z.infer<typeof ShoppingGoalExtractionSchema>;

export const GEMINI_SHOPPING_GOAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['purchase', 'chitchat'], description: 'purchase if the user wants to buy something, otherwise chitchat' },
    itemIdHint: { type: 'STRING', description: 'Substring of a catalog item name/id if clearly referenced, else omit' },
    category: { type: 'STRING', description: 'One of: cloud_services, saas_subscription — if inferable' },
    budgetPaise: { type: 'INTEGER', description: 'User budget in paise (₹1 = 100 paise) if stated' },
    quantity: { type: 'INTEGER', description: 'Requested units, 1-10' },
    notes: { type: 'STRING', description: 'Short normalized restatement of the shopping intent' },
  },
  required: ['action', 'notes'],
};

const SYSTEM_INSTRUCTION =
  'You convert a user\'s natural-language shopping request into structured JSON for an autonomous procurement agent. ' +
  'Prices are in paise (₹100 = 10000). If the user is not asking to buy anything, set action="chitchat". ' +
  'Respond ONLY with JSON matching the schema.';

/** Known merchant catalog categories for heuristic classification. */
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/\b(h100|a100|gpu|compute|cluster|fine.?tun|inference)\b/i, 'cloud_services'],
  [/\b(vector|db|database|api|gateway|saas|subscription)\b/i, 'saas_subscription'],
];

const PURCHASE_VERBS = /\b(buy|get|purchase|order|need|want|procure|book|hire)\b/i;
const RUPEE_RE = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i;
const BARE_AMOUNT_RE = /\b([\d,]{3,})\s*(?:rs\.?|rupees|inr)?\b/i;
const QTY_RE = /\b(?:x\s*)?(\d{1,2})\s*(?:x\b|units?|nodes?|instances?|hours?)\b/i;

/**
 * Deterministic offline parser — keyword + regex heuristics.
 */
export function heuristicExtractGoal(message: string): ShoppingGoalExtraction {
  const isPurchase = PURCHASE_VERBS.test(message);
  let budgetPaise: number | undefined;

  const rupeeMatch = message.match(RUPEE_RE);
  if (rupeeMatch) {
    budgetPaise = Math.round(parseFloat(rupeeMatch[1].replace(/,/g, '')) * 100);
  } else {
    const bare = message.match(BARE_AMOUNT_RE);
    if (bare && /under|below|max|budget|within/i.test(message)) {
      budgetPaise = Math.round(parseFloat(bare[1].replace(/,/g, '')) * 100);
    }
  }

  const qtyMatch = message.match(QTY_RE);
  const category = CATEGORY_HINTS.find(([re]) => re.test(message))?.[1];

  const extraction: ShoppingGoalExtraction = {
    action: isPurchase ? 'purchase' : 'chitchat',
    category,
    budgetPaise,
    quantity: qtyMatch ? parseInt(qtyMatch[1], 10) : undefined,
    notes: message.slice(0, 400),
  };
  const parsed = ShoppingGoalExtractionSchema.safeParse(extraction);
  return parsed.success ? parsed.data : { action: 'chitchat', notes: message.slice(0, 400) };
}

/**
 * Extract a shopping goal via Gemini; falls back to heuristics whenever the
 * client is unavailable, transport fails, or the firewall rejects output.
 */
export async function extractShoppingGoal(
  message: string,
  client: LLMProvider | null,
  knownCategories: string[]
): Promise<{ goal: ShoppingGoalExtraction; source: string; attempts: number }> {
  if (!client) {
    const g = heuristicExtractGoal(message);
    return { goal: g, source: 'deterministic', attempts: 0 };
  }

  const prompt =
    `KNOWN CATEGORIES: [${knownCategories.join(', ')}]\n` +
    `USER MESSAGE: "${message}"\n\n` +
    `TASK: ${SYSTEM_INSTRUCTION}`;

  try {
    const { data, attempts } = await validateWithRetry({
      schema: ShoppingGoalExtractionSchema,
      maxAttempts: 3,
      call: (feedback) =>
        client
          .generateJSON(feedback ? `${prompt}\nCORRECTION: ${feedback}` : prompt, GEMINI_SHOPPING_GOAL_SCHEMA)
          .then((r) => r.raw),
    });
    // Normalize category against the real catalog when possible
    const category = data.category && knownCategories.includes(data.category) ? data.category : undefined;
    return { goal: { ...data, category }, source: `llm-${client.name}`, attempts: attempts.length + 1 };
  } catch {
    const g = heuristicExtractGoal(message);
    return { goal: g, source: 'deterministic', attempts: 0 };
  }
}
