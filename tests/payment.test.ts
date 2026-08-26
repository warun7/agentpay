import { describe, it, expect } from 'vitest';
import { RazorpayGateway } from '../src/payment/razorpay.js';
import { processAgenticCheckout } from '../src/payment/mandate-gateway.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { signCompactJWS } from '../src/crypto/signatures.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';

describe('Razorpay & UAP Payment Gateway Integration', () => {
  it('should create order and capture autonomous payment with HMAC verification', async () => {
    const gateway = new RazorpayGateway({
      keyId: 'rzp_test_mock_123',
      keySecret: 'secret_mock_456',
      mockMode: true,
    });

    const order = await gateway.createOrder({
      amount: 350000,
      currency: 'INR',
      receipt: 'rcpt_test_01',
    });

    expect(order.id).toMatch(/^order_RZP/);
    expect(order.amount).toBe(350000);
    expect(order.status).toBe('created');

    const { payment, signature } = await gateway.captureAutonomousPayment({
      orderId: order.id,
      amount: 350000,
      userUpiId: 'user.test@okhdfcbank',
      uapMandateCircleRef: 'uap_ref_123',
    });

    expect(payment.id).toMatch(/^pay_RZP/);
    expect(payment.status).toBe('captured');
    expect(signature).toBeDefined();

    const verified = gateway.verifyPayment(order.id, payment.id, signature);
    expect(verified).toBe(true);
  });

  it('should process agentic checkout and generate cryptographic audit proof bundle', async () => {
    const merchant = new MerchantAgent();
    const buyer = new BuyerAgent();
    const mandate = await buyer.provisionMandate({
      maxAmount: 500000,
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const quotePayload = {
      quoteId: 'quote_123',
      cartId: 'cart_123',
      subtotal: 300000,
      discount: 15000,
      tax: 51300,
      totalAmount: 336300,
      currency: 'INR',
      merchantUpiId: merchant.upiId,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    // P1: quotes must now be GENUINELY signed — buyer verifies before signing
    const quote = {
      type: 'QUOTE_RESPONSE' as const,
      ...quotePayload,
      merchantSignature: await signCompactJWS(
        quotePayload,
        merchant.identity.signingKeyPair.jwk.private,
        { kid: `${merchant.getDID()}#key-1` }
      ),
    };

    const { signingKeyJwk } = extractKeysFromDIDDocument(merchant.identity.didDocument);
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), signingKeyJwk);

    const { receipt, bundle } = await processAgenticCheckout({
      signedTransaction: signedTx,
      buyerMandate: mandate,
      gateway: merchant.gateway,
    });

    expect(receipt.status).toBe('CAPTURED');
    expect(receipt.amount).toBe(336300);
    expect(receipt.cryptographicAuditDigest).toMatch(/^sha256:/);
    expect(bundle.auditTrailDigest).toBe(receipt.cryptographicAuditDigest);
  });
});
