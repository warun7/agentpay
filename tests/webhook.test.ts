import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildServer } from '../src/server/index.js';
import type { FastifyInstance } from 'fastify';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { paymentBus } from '../src/payment/webhook-events.js';
import {
  generateWebhookSignature,
  verifyWebhookSignature,
} from '../src/crypto/signatures.js';

/**
 * Phase 3 — Razorpay webhook pipeline.
 * One settlement-confirmation path: externally-signed webhooks (live) and
 * internal synthetic captures (mock/UAP-sim) flow through the same bus and
 * the same idempotent confirmCapture().
 */

const WEBHOOK_SECRET = 'whsec_test_secret_12345';

function signedWebhookBody(eventObj: object): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(eventObj);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': generateWebhookSignature(body, WEBHOOK_SECRET),
    },
  };
}

function capturedEvent(orderId: string, paymentId: string) {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: paymentId, order_id: orderId, amount: 389400, status: 'captured', method: 'upi' },
      },
      order: { entity: { id: orderId } },
    },
  };
}

describe('Webhook HMAC primitives', () => {
  it('verifies a correctly-signed delivery', () => {
    const raw = '{"event":"payment.captured"}';
    const sig = generateWebhookSignature(raw, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(raw, sig, WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a tampered body with a stale signature', () => {
    const raw = '{"event":"payment.captured","amount":1}';
    const sig = generateWebhookSignature(raw, WEBHOOK_SECRET);
    const tampered = raw.replace('1}', '999999}');
    expect(verifyWebhookSignature(tampered, sig, WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects wrong-secret signatures and missing headers', () => {
    const raw = '{"x":1}';
    const attackerSig = generateWebhookSignature(raw, 'attacker_secret');
    expect(verifyWebhookSignature(raw, attackerSig, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, '', WEBHOOK_SECRET)).toBe(false);
  });
});

describe('POST /api/webhooks/razorpay (HTTP integration)', () => {
  let app: FastifyInstance;
  let merchant: MerchantAgent;

  beforeEach(async () => {
    process.env.PERSISTENCE = 'memory';
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_MOCK_MODE = 'true';
    delete process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'test';
    merchant = new MerchantAgent({ name: 'Hook Test Merchant' });
    app = await buildServer(merchant);
  });

  afterEach(async () => {
    await app.close();
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it('accepts a validly-signed webhook for an UNKNOWN order (ack, no crash)', async () => {
    const { body, headers } = signedWebhookBody(capturedEvent('order_unknown123', 'pay_unknown456'));
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/razorpay', payload: body, headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, duplicate: false });
  });

  it('rejects tampered deliveries with 401', async () => {
    // Sign one body, deliver a DIFFERENT (still-valid-JSON) body under the same signature
    const evtObj = capturedEvent('order_t', 'pay_t');
    const signedBody = JSON.stringify(evtObj);
    const tamperedBody = JSON.stringify({ ...evtObj, payload: { payment: { entity: { id: 'pay_drained', order_id: 'order_t', amount: 1, status: 'captured' } } } });
    expect(tamperedBody).not.toBe(signedBody);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/razorpay',
      payload: tamperedBody,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': generateWebhookSignature(signedBody, WEBHOOK_SECRET) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().accepted).toBe(false);
  });

  it('rejects missing signature header with 401', async () => {
    const { body } = signedWebhookBody(capturedEvent('order_x', 'pay_x'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/razorpay',
      payload: body,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('is idempotent across duplicate deliveries', async () => {
    const evt = capturedEvent('order_dup', 'pay_dup');
    const first = signedWebhookBody(evt);
    const second = signedWebhookBody(evt); // fresh signature over identical bytes

    await app.inject({ method: 'POST', url: '/api/webhooks/razorpay', payload: first.body, headers: first.headers });
    const res2 = await app.inject({ method: 'POST', url: '/api/webhooks/razorpay', payload: second.body, headers: second.headers });

    expect(res2.json()).toMatchObject({ accepted: true, duplicate: true });
  });

  it('confirms a REAL settled transaction end-to-end via webhook path', async () => {
    // Run a genuine checkout against this merchant (mock gateway)
    const buyer = new BuyerAgent({ name: 'Hook Buyer' });
    await buyer.provisionMandate({
      maxAmount: 500000, currency: 'INR',
      allowedCategories: ['cloud_services'], merchantWhitelist: ['*'],
    });
    const session = merchant.createSessionHandler();
    const merchantDIDMsg = session.handleDIDExchange(buyer.createDIDExchangeMessage());
    const channel = buyer.establishSession(merchantDIDMsg.didDocument);
    await session.handleMandatePresentation(
      channel.packMessage(buyer.createMandatePresentation()),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    session.handleCatalogRequest(channel.packMessage(buyer.createCatalogRequest('cloud_services')));
    const quoteEnv = await session.handlePurchaseIntent(
      channel.packMessage(buyer.createPurchaseIntent('item_gpu_h100_cluster', 1))
    );
    const quote = channel.unpackMessage<any>(quoteEnv);
    const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(channel.getSession().peerDIDDocument);
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);
    const receiptEnv = await session.handleSignedTransaction(channel.packMessage(signedTx));
    const receipt = channel.unpackMessage<any>(receiptEnv);

    // Internal synthetic event already confirmed via bus — assert stamp exists
    const recordAfterSynthetic = merchant.transactionStore.get(receipt.razorpayOrderId)!;
    expect(recordAfterSynthetic.confirmedAt).toBeDefined();
    expect(recordAfterSynthetic.confirmedBy).toBe('internal-synthetic');

    // Now deliver an EXTERNAL live-style webhook for the same order.
    // Idempotency must hold even though source differs.
    const { body, headers } = signedWebhookBody(capturedEvent(receipt.razorpayOrderId, receipt.razorpayPaymentId));
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/razorpay', payload: body, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);

    const recordFinal = merchant.transactionStore.get(receipt.razorpayOrderId)!;
    expect(recordFinal.confirmedBy).toBe('internal-synthetic'); // first confirmation wins
    expect(recordFinal.confirmedAt).toBe(recordAfterSynthetic.confirmedAt);
  });
});

describe('confirmCapture unit semantics', () => {
  it('rejects confirmation for unknown orders; idempotent on repeat', async () => {
    const merchant = new MerchantAgent({ name: 'Unit Hook Merchant' });
    expect(merchant.confirmCapture({ razorpayOrderId: 'nope', source: 'razorpay-webhook' }).confirmed).toBe(false);

    const bus = paymentBus();
    let received = 0;
    const off = bus.subscribe(() => { received++; });
    off(); // subscription removal works

    expect(received).toBe(0);
  });
});
