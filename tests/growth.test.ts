import { describe, it, expect } from 'vitest';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { GeminiMerchantStrategy } from '../src/ai/strategies/gemini-merchant.js';
import { OpenRouterClient } from '../src/ai/llm-failover.js';
import { QuoteSchema } from '../src/protocol/schemas.js';
import type { RecommendationMessage } from '../src/protocol/schemas.js';

/**
 * Phase 5 — Merchant growth agent + measured analytics.
 * Recommendations ride INSIDE the signed quote; acceptance is bounded by the
 * deterministic affordability gate; analytics attribute incremental revenue.
 */

describe('Recommendations in signed quotes', () => {
  it('deterministic merchant attaches a complementary item at discount-matched pricing', async () => {
    const merchant = new MerchantAgent({ name: 'Growth Merchant' });
    const session = merchant.createSessionHandler();
    const buyer = new BuyerAgent();
    await buyer.provisionMandate({ maxAmount: 900000, currency: 'INR', allowedCategories: ['cloud_services', 'saas_subscription'], merchantWhitelist: ['*'] });

    const mDID = session.handleDIDExchange(buyer.createDIDExchangeMessage());
    buyer.establishSession(mDID.didDocument);
    await session.handleMandatePresentation(buyer.createMandatePresentation(), buyer.userWalletIdentity.signingKeyPair.jwk.public);
    session.handleCatalogRequest({ type: 'CATALOG_REQUEST' });

    const quote: any = await session.handlePurchaseIntent({
      type: 'PURCHASE_INTENT',
      cartId: 'cart_g',
      items: [{ itemId: 'item_gpu_h100_cluster', quantity: 1 }],
      negotiationReason: 'test',
    });

    expect(quote.recommendations).toBeDefined();
    expect(quote.recommendations.length).toBeGreaterThan(0);
    expect(quote.recommendations[0].itemId).toBe('item_vector_db_pro');

    // Price discipline: rec price = base × (1 − appliedDiscount)
    const vectorBase = merchant.catalog.find((c) => c.id === 'item_vector_db_pro')!.basePrice;
    expect(quote.recommendations[0].offeredUnitPrice).toBe(Math.round(vectorBase * 0.95));

    // Recommendations survive schema validation AND signature verification is unaffected
    expect(QuoteSchema.safeParse(quote).success).toBe(true);
  });
});

describe('Bounded upsell round', () => {
  async function runPrimary(itemId = 'item_gpu_h100_cluster', maxAmount = 900000) {
    const merchant = new MerchantAgent({ name: 'Upsell Merchant' });
    const session = merchant.createSessionHandler();
    const buyer = new BuyerAgent();
    await buyer.provisionMandate({ maxAmount, currency: 'INR', allowedCategories: ['cloud_services', 'saas_subscription'], merchantWhitelist: ['*'] });

    const mDID = session.handleDIDExchange(buyer.createDIDExchangeMessage());
    const channel = buyer.establishSession(mDID.didDocument);
    const unpack = (r: any) => channel.unpackMessage(r);

    await session.handleMandatePresentation(channel.packMessage(buyer.createMandatePresentation()), buyer.userWalletIdentity.signingKeyPair.jwk.public);
    session.handleCatalogRequest(channel.packMessage({ type: 'CATALOG_REQUEST' }));
    const quote = unpack(await session.handlePurchaseIntent(channel.packMessage({
      type: 'PURCHASE_INTENT', cartId: 'cart_u',
      items: [{ itemId, quantity: 1 }], negotiationReason: 't',
    })));
    const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(channel.getSession().peerDIDDocument);
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);
    const receipt = unpack(await session.handleSignedTransaction(channel.packMessage(signedTx)));
    return { merchant, buyer, quote, receipt };
  }

  it('accepts an affordable recommendation → second SETTLED txn + analytics attribution', async () => {
    const { merchant, buyer, quote, receipt } = await runPrimary();

    const remaining = 900000 - receipt.amount;
    const evalRes = await buyer.evaluateRecommendations(
      quote.recommendations ?? [],
      remaining,
      900000
    );
    expect(evalRes.accepted.length).toBeGreaterThan(0);
    const rec: RecommendationMessage = evalRes.accepted[0];

    // Round-2 on fresh FSM with upsell attribution
    merchant.pendingUpsellAttribution = { recommendationsOffered: quote.recommendations.length };
    const s2 = merchant.createSessionHandler();
    const m2 = s2.handleDIDExchange(buyer.createDIDExchangeMessage());
    const ch2 = buyer.establishSession(m2.didDocument);
    await s2.handleMandatePresentation(ch2.packMessage(buyer.createMandatePresentation()), buyer.userWalletIdentity.signingKeyPair.jwk.public);
    s2.handleCatalogRequest(ch2.packMessage({ type: 'CATALOG_REQUEST' }));
    const q2: any = ch2.unpackMessage(await s2.handlePurchaseIntent(ch2.packMessage(buyer.createUpsellIntent(rec))));
    const { signingKeyJwk: mKey2 } = extractKeysFromDIDDocument(ch2.getSession().peerDIDDocument);
    const stx2 = await buyer.evaluateAndSignQuote(q2, 'saas_subscription', merchant.getDID(), mKey2);
    const r2: any = ch2.unpackMessage(await s2.handleSignedTransaction(ch2.packMessage(stx2)));

    expect(r2.status).toBe('CAPTURED');
    expect(r2.transactionId).not.toBe(receipt.transactionId);

    // Analytics: primary counted once, upsell attributed as incremental revenue
    expect(merchant.analytics.totalTransactions).toBe(2);
    expect(merchant.analytics.recsOfferedCount).toBeGreaterThanOrEqual(1);
    expect(merchant.analytics.recsAcceptedCount).toBe(1);
    expect(merchant.analytics.incrementalRevenuePaise).toBe(r2.amount);
    expect(merchant.analytics.grossRevenuePaise).toBe(receipt.amount + r2.amount);
  });

  it('DECLINES when remaining mandate budget cannot cover the recommendation', async () => {
    // Cap fits the H100 (~₹3,924 settled) but leaves <₹800 — not enough for any add-on
    const { buyer, quote, receipt } = await runPrimary('item_gpu_h100_cluster', 400000);
    const remaining = 400000 - receipt.amount;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(quote.recommendations[0].offeredUnitPrice);

    const evalRes = await buyer.evaluateRecommendations(
      (quote.recommendations ?? []).map((r: any) => ({ ...r, offeredUnitPrice: remaining + 1 })),
      remaining,
      360000
    );
    expect(evalRes.accepted.length).toBe(0);
    expect(evalRes.declined.length).toBe((quote.recommendations ?? []).length);
  });
});

describe('Gemini growth agent (LLM path)', () => {
  it('LLM proposes items; protocol recomputes ALL prices server-side', async () => {
    // LLM tries to sneak an underpriced recommendation — price is overwritten anyway
    const sneakyPayload = {
      recommendations: [
        { itemId: 'item_api_gateway_enterprise', reason: 'pairs well' },
        { itemId: 'item_unknown_xyz', reason: 'hallucinated item' }, // must be dropped
      ],
    };
    const router = new OpenRouterClient('k', 'free-model', 500, async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sneakyPayload) } }] }), { status: 200 })
    );

    const strategy = new GeminiMerchantStrategy(router);
    const merchant = new MerchantAgent({ name: 'Price Discipline Merchant' });
    const primary = merchant.catalog.find((c) => c.id === 'item_gpu_h100_cluster')!;
    const result = await strategy.recommend(primary, merchant.catalog, 0.10, 1);

    expect(result.decision.length).toBe(1); // unknown item dropped
    expect(result.decision[0].itemId).toBe('item_api_gateway_enterprise');
    const gwBase = merchant.catalog.find((c) => c.id === 'item_api_gateway_enterprise')!.basePrice;
    expect(result.decision[0].offeredUnitPrice).toBe(Math.round(gwBase * 0.90)); // protocol-owned price
    expect(result.source).toBe('llm-openrouter');
  });
});
