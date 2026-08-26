import { describe, it, expect } from 'vitest';
import { GeminiClient, GeminiTransportError } from '../src/ai/gemini-client.js';
import { LLMFirewallError } from '../src/ai/firewall.js';
import { GeminiBuyerStrategy } from '../src/ai/strategies/gemini-buyer.js';
import { GeminiMerchantStrategy } from '../src/ai/strategies/gemini-merchant.js';
import type { BuyerStrategy, MerchantStrategy, StrategyResult } from '../src/ai/types.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { DEFAULT_CATALOG } from '../src/agents/catalog-data.js';
import { generateQuote } from '../src/protocol/negotiation.js';
import type { CatalogItem, PurchaseIntentMessage } from '../src/protocol/schemas.js';

/**
 * Phase 1 — AI Strategy Layer.
 * Proves the core invariant: the LLM proposes, the protocol disposes.
 */

// ── Test helpers ─────────────────────────────────────────────────────────────

function geminiOK(body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function transportOf(...responses: Array<Response | { throwError: Error }>): () => Promise<Response> {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new GeminiTransportError('transport queue exhausted');
    if ('throwError' in next) throw next.throwError;
    return next;
  };
}

function clientWith(...responses: Array<Response | { throwError: Error }>): GeminiClient {
  return new GeminiClient(
    { apiKey: 'test-key', model: 'test-model', timeoutMs: 500 },
    transportOf(...responses)
  );
}

const VALID_INTENT = {
  itemId: 'item_gpu_h100_cluster',
  quantity: 1,
  offeredUnitPrice: 320000,
  negotiationReason: 'Q3 inference workload',
  rationale: 'Best throughput per rupee within budget.',
};

async function makeQuote(merchant: MerchantAgent, itemId = 'item_gpu_h100_cluster') {
  const session = merchant.createSessionHandler();
  const buyer = new BuyerAgent({ name: 'Quote Helper Buyer' });
  await buyer.provisionMandate({
    maxAmount: 500000,
    currency: 'INR',
    allowedCategories: ['cloud_services'],
    merchantWhitelist: ['*'],
  });

  // Walk the FSM to INTENT_SENT legally
  const merchantDIDMsg = session.handleDIDExchange(buyer.createDIDExchangeMessage());
  const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);
  const merchantKey = extractKeysFromDIDDocument(buyerChannel.getSession().peerDIDDocument).signingKeyJwk;
  await session.handleMandatePresentation(
    buyer.createMandatePresentation(),
    buyer.userWalletIdentity.signingKeyPair.jwk.public
  );
  session.handleCatalogRequest(buyer.createCatalogRequest('cloud_services'));

  const intent: PurchaseIntentMessage = {
    type: 'PURCHASE_INTENT',
    cartId: 'cart_test',
    items: [{ itemId, quantity: 1 }],
    negotiationReason: 'test',
  };
  return { session, quote: await session.handlePurchaseIntent(intent) as any, merchantKey };
}

// ── 1. Deterministic default (offline safety net) ────────────────────────────

describe('Deterministic default strategies', () => {
  it('BuyerAgent without injected strategy works fully offline', async () => {
    const buyer = new BuyerAgent();
    await buyer.provisionMandate({ maxAmount: 500000, currency: 'INR', allowedCategories: ['cloud_services'], merchantWhitelist: ['*'] });

    const { intent, strategyResult } = await buyer.decidePurchaseIntent(DEFAULT_CATALOG, {
      remainingBudgetPaise: 500000,
    });

    expect(strategyResult.source).toBe('deterministic');
    expect(intent.type).toBe('PURCHASE_INTENT');
    // Highest-value item within budget wins under deterministic policy
    expect(intent.items[0].itemId).toBe('item_gpu_h100_cluster');
    expect(intent.items[0].offeredUnitPrice).toBe(Math.round(DEFAULT_CATALOG[0].basePrice * 0.92));
  });
});

// ── 2. LLM firewall: repair loop + exhaustion fallback ──────────────────────

describe('LLM firewall', () => {
  it('repairs malformed output via feedback loop and succeeds', async () => {
    const strategy = new GeminiBuyerStrategy(
      clientWith(
        geminiOK('I am not JSON, sorry!'),
        geminiOK({ ...VALID_INTENT, quantity: 99, negotiationReason: '' }), // fails Zod
        geminiOK(VALID_INTENT),
      )
    );

    const result = await strategy.decideIntent(DEFAULT_CATALOG, 500000);

    expect(result.source).toBe('llm-gemini');
    expect(result.attempts).toBe(3); // two repairs before clean pass
    expect(result.decision.itemId).toBe('item_gpu_h100_cluster');
  });

  it('falls back to deterministic after persistent malformed output (firewall exhaustion)', async () => {
    const strategy = new GeminiBuyerStrategy(
      clientWith(geminiOK('garbage'), geminiOK('garbage'), geminiOK('garbage'))
    );

    const result = await strategy.decideIntent(DEFAULT_CATALOG, 500000);

    expect(result.source).toBe('deterministic');
    expect(result.decision.itemId).toBe('item_gpu_h100_cluster');
  });

  it('fails fast to deterministic fallback on transport errors', async () => {
    const strategy = new GeminiMerchantStrategy(
      clientWith({ throwError: new GeminiTransportError('API quota exceeded', 429) })
    );

    const intent: PurchaseIntentMessage = {
      type: 'PURCHASE_INTENT',
      cartId: 'cart_x',
      items: [{ itemId: 'item_gpu_h100_cluster', quantity: 1 }],
    };
    const item = DEFAULT_CATALOG[0];
    const result = await strategy.priceIntent(intent, item);

    expect(result.source).toBe('deterministic');
    expect(result.decision.discountPercentage).toBeCloseTo(0.05, 5);
  });
});

// ── 3. Discount clamp: LLM proposes anything, protocol disposes ─────────────

describe('Discount clamp [5%, 15%]', () => {
  class RecklesslyGenerousMerchant implements MerchantStrategy {
    readonly name = 'reckless';
    async priceIntent(): Promise<StrategyResult<any>> {
      return {
        decision: { discountPercentage: 0.47, rationale: 'LLM hallucinated 47% off!' },
        source: 'llm-gemini',
        attempts: 1,
      };
    }
  }

  it('clamps an out-of-band LLM discount to the 15% protocol ceiling', async () => {
    const merchant = new MerchantAgent({ strategy: new RecklesslyGenerousMerchant() });
    const { session, quote } = await makeQuote(merchant); void session;

    // subtotal = basePrice 350000 → discount must be round(350000 * 0.15) = 52500, NOT 47%
    expect(quote.discount).toBe(52500);

    const trace = session.getStrategyTrace();
    expect(trace[0].discountPercentageRequested).toBe(0.47);
    expect(trace[0].discountPercentageApplied).toBe(0.15);
    expect(trace[0].clamped).toBe(true);
    expect(trace[0].rationale).toContain('[PROTOCOL CLAMP]');
  });

  it('also clamps BELOW the floor (merchant cannot secretly give 0%)', async () => {
    class ZeroDiscountMerchant implements MerchantStrategy {
      readonly name = 'stingy';
      async priceIntent(): Promise<StrategyResult<any>> {
        return {
          decision: { discountPercentage: 0, rationale: 'no discounts ever' },
          source: 'deterministic',
          attempts: 0,
        };
      }
    }
    const merchant = new MerchantAgent({ strategy: new ZeroDiscountMerchant() });
    const { quote } = await makeQuote(merchant);
    expect(quote.discount).toBe(17500); // round(350000 * 0.05)
  });
});

// ── 4. Mandate bounds ALWAYS win over strategy opinions ──────────────────────

describe('Bounds checker supremacy', () => {
  class OverBudgetBuyer implements BuyerStrategy {
    readonly name = 'overbudget';
    async decideIntent(catalog: CatalogItem[]) {
      return {
        decision: {
          itemId: catalog[0].id,
          quantity: 1,
          negotiationReason: 'want the big one',
          rationale: 'Ignoring budget entirely.',
        },
        source: 'llm-gemini' as const,
        attempts: 1,
      };
    }
    async evaluateQuote() {
      return {
        decision: { action: 'accept' as const, rationale: 'Looks great to me!' },
        source: 'llm-gemini' as const,
        attempts: 1,
      };
    }
  }

  it('strategicEvaluateQuote refuses when quote exceeds mandate despite strategy acceptance', async () => {
    const merchant = new MerchantAgent();
    const { quote, merchantKey: mKeyOver } = await makeQuote(merchant); // H100 cluster ≈ ₹3.8k total

    const buyer = new BuyerAgent({ strategy: new OverBudgetBuyer() });
    await buyer.provisionMandate({
      maxAmount: 100000, // ₹1,000 mandate — far below the quote
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const { proceed, evaluation } = await buyer.strategicEvaluateQuote(
      quote,
      'cloud_services',
      merchant.getDID(),
      mKeyOver
    );

    expect(proceed).toBe(false);
    expect(evaluation.decision.rationale).toContain('HARD OVERRIDE');

    await expect(
      buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKeyOver)
    ).rejects.toThrow(/mandate bounds checker/i);
  });
});

// ── 5. GeminiClient transport behavior ───────────────────────────────────────

describe('GeminiClient', () => {
  it('parses candidates text on success', async () => {
    const client = clientWith(geminiOK({ hello: 'world' }));
    const { raw } = await client.generateJSON('prompt', {});
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  it('throws typed transport error on HTTP failure', async () => {
    const client = new GeminiClient(
      { apiKey: 'k', model: 'm', timeoutMs: 500 },
      async () => new Response('{"error":"invalid key"}', { status: 401 })
    );
    await expect(client.generateJSON('p', {})).rejects.toBeInstanceOf(GeminiTransportError);
  });
});

// ── 6. Live smoke test against real Gemini (skipped without API key) ─────────

describe('Live Gemini integration', () => {
  const liveKey = process.env.GEMINI_API_KEY;

  it.skipIf(!liveKey)('produces a schema-valid intent decision from real Gemini', async () => {
    const client = new GeminiClient({
      apiKey: liveKey!,
      model: process.env.LLM_MODEL || 'gemini-3.6-flash',
      timeoutMs: 20000,
    });
    const strategy = new GeminiBuyerStrategy(client);
    const result = await strategy.decideIntent(DEFAULT_CATALOG, 400000, {
      notes: 'GPU hours for a weekend fine-tuning run',
    });

    // Must be genuinely LLM-driven — a silent deterministic fallback would mask
    // transport/schema regressions against the live API.
    expect(result.source).toBe('llm-gemini');
    expect(result.decision.itemId).toMatch(/^item_/);
    expect(result.decision.quantity).toBeGreaterThanOrEqual(1);
    expect(result.decision.rationale.length).toBeGreaterThan(10);
  }, 30000);
});
