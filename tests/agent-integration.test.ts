import { describe, it, expect } from 'vitest';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { verifyCompactJWS } from '../src/crypto/signatures.js';

describe('Autonomous Agent-to-Agent Integration', () => {
  it('should successfully complete an autonomous trustless checkout loop', async () => {
    // 1. Provision Agents
    const merchant = new MerchantAgent({ name: 'Test Cloud Merchant' });
    const buyer = new BuyerAgent({ name: 'Test Autonomous Buyer' });
    await buyer.provisionMandate({
      maxAmount: 500000, // ₹5,000.00
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const merchantSession = merchant.createSessionHandler();

    // 2. DID Exchange & ECDH Handshake
    const buyerDIDMsg = buyer.createDIDExchangeMessage();
    const merchantDIDMsg = merchantSession.handleDIDExchange(buyerDIDMsg);
    const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);
    const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(merchantDIDMsg.didDocument);

    expect(buyerChannel.getSession().isEstablished).toBe(true);

    // 3. Mandate Presentation
    const mandateMsg = buyer.createMandatePresentation();
    const mandateVerification = await merchantSession.handleMandatePresentation(
      mandateMsg,
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    expect(mandateVerification.verified).toBe(true);

    // 4. Catalog Query
    const catalogReq = buyer.createCatalogRequest('cloud_services');
    const catalogResp = merchantSession.handleCatalogRequest(catalogReq);
    expect(catalogResp.items.length).toBeGreaterThan(0);

    // 5. Purchase Intent & Quote Negotiation
    const targetItem = catalogResp.items[0];
    const purchaseIntent = buyer.createPurchaseIntent(targetItem.id, 1, 320000);
    const quote = await merchantSession.handlePurchaseIntent(purchaseIntent);
    expect(quote.totalAmount).toBeLessThan(500000); // Within mandate limit

    // 6. Buyer Signature
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);
    expect(signedTx.jwsSignature).toBeDefined();

    // Verify JWS signature against Buyer's public key
    const { signingKeyJwk } = extractKeysFromDIDDocument(buyer.identity.didDocument);
    const { payload } = await verifyCompactJWS<any>(signedTx.jwsSignature, signingKeyJwk);
    expect(payload.transactionId).toBe(signedTx.transactionId);

    // 7. Merchant Payment Settlement
    const receipt = await merchantSession.handleSignedTransaction(signedTx);
    expect(receipt.status).toBe('CAPTURED');
    expect(receipt.razorpayOrderId).toBeDefined();
    expect(merchantSession.fsm.getState()).toBe('SETTLED');
  });

  it('should deterministically reject purchases that exceed spending mandate limit', async () => {
    const merchant = new MerchantAgent();
    const buyer = new BuyerAgent();
    // User set a strict ₹1,000 limit
    await buyer.provisionMandate({
      maxAmount: 100000, // ₹1,000.00
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const merchantSession = merchant.createSessionHandler();

    // Perform handshake & mandate presentation
    merchantSession.handleDIDExchange(buyer.createDIDExchangeMessage());
    await merchantSession.handleMandatePresentation(
      buyer.createMandatePresentation(),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );

    // Expensive item: ₹3,500 — genuinely signed so P1 verification passes and
    // the test proves the MANDATE gate (not the signature gate) does the rejecting.
    const expensiveQuotePayload = {
      quoteId: 'quote_expensive',
      cartId: 'cart_exp',
      subtotal: 350000,
      discount: 0,
      tax: 63000,
      totalAmount: 413000, // ₹4,130.00 > ₹1,000.00
      currency: 'INR',
      merchantUpiId: merchant.upiId,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const { signCompactJWS } = await import('../src/crypto/signatures.js');
    const expensiveQuote = {
      type: 'QUOTE_RESPONSE' as const,
      ...expensiveQuotePayload,
      merchantSignature: await signCompactJWS(
        expensiveQuotePayload,
        merchant.identity.signingKeyPair.jwk.private,
        { kid: `${merchant.getDID()}#key-1` }
      ),
    };
    const { signingKeyJwk: mKeyExp } = extractKeysFromDIDDocument(merchant.identity.didDocument);

    // Buyer must refuse to sign and throw deterministic error
    await expect(
      buyer.evaluateAndSignQuote(expensiveQuote, 'cloud_services', merchant.getDID(), mKeyExp)
    ).rejects.toThrow(/exceeds mandate limit/);
  });
});
