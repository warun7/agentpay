import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildServer } from '../src/server/index.js';
import type { FastifyInstance } from 'fastify';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { SecureChannel } from '../src/session/secure-channel.js';
import { completeHandshake } from '../src/session/handshake.js';
import {
  verifyQuoteSignature,
  assertSignedTransactionMatchesPayload,
  signTransactionPayload,
} from '../src/protocol/negotiation.js';
import { checkMandateBounds } from '../src/identity/credentials.js';
import { issueSpendingMandate } from '../src/identity/credentials.js';
import { createAgentIdentity } from '../src/identity/did.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import {
  SqlitePersistence,
  MemoryPersistence,
  createPersistenceFromEnv,
} from '../src/persistence/persistence.js';
import type { QuoteMessage } from '../src/protocol/schemas.js';

/**
 * Judge Remediation — P1 quote signatures, P2 currency bounds,
 * P3 full txn verification + freshness, P4 envelope freshness,
 * P5 durable ledger, P6 honest gateway modes.
 */

// ── Shared fixtures ──────────────────────────────────────────────────────────

async function makeSignedQuote(opts?: { tamper?: (q: any) => void; foreignKey?: boolean }) {
  const merchant = new MerchantAgent({ name: 'Remediation Merchant' });
  const buyer = new BuyerAgent();
  await buyer.provisionMandate({
    maxAmount: 900000, currency: 'INR',
    allowedCategories: ['cloud_services', 'saas_subscription'],
    merchantWhitelist: ['*'],
  });

  const session = merchant.createSessionHandler();
  const mDID = session.handleDIDExchange(buyer.createDIDExchangeMessage());
  const channel = buyer.establishSession(mDID.didDocument);
  await session.handleMandatePresentation(
    channel.packMessage(buyer.createMandatePresentation()),
    buyer.userWalletIdentity.signingKeyPair.jwk.public
  );
  session.handleCatalogRequest({ type: 'CATALOG_REQUEST' });
  const quote: any = channel.unpackMessage(await session.handlePurchaseIntent(channel.packMessage({
    type: 'PURCHASE_INTENT', cartId: 'cart_r',
    items: [{ itemId: 'item_gpu_h100_cluster', quantity: 1 }],
  })));

  if (opts?.tamper) opts.tamper(quote);

  const { signingKeyJwk } = extractKeysFromDIDDocument(mDID.didDocument);
  let foreignKey;
  if (opts?.foreignKey) {
    const outsider = createAgentIdentity('Impostor Merchant', 'merchant');
    foreignKey = extractKeysFromDIDDocument(outsider.didDocument).signingKeyJwk;
  }

  return { merchant, buyer, session, channel, quote, merchantKey: signingKeyJwk, foreignKey };
}

// ── P1: Quote signature verification ────────────────────────────────────────

describe('P1 — Quote signature verification', () => {
  it('accepts a genuine merchant-signed quote and the buyer signs it', async () => {
    const { buyer, quote, merchantKey, merchant } = await makeSignedQuote();
    expect((await verifyQuoteSignature(quote, merchantKey)).valid).toBe(true);

    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), merchantKey);
    expect(signedTx.amount).toBe(quote.totalAmount);
  });

  it('rejects a TAMPERED totalAmount even though the JWS itself is intact', async () => {
    const { quote, merchantKey } = await makeSignedQuote({
      tamper: (q) => { q.totalAmount = 1; }, // visible field ≠ signed payload
    });
    const res = await verifyQuoteSignature(quote, merchantKey);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('totalAmount');
  });

  it('rejects TAMPERED recommendations (growth-agent MITM)', async () => {
    const { quote, merchantKey } = await makeSignedQuote({
      tamper: (q) => { if (q.recommendations?.[0]) q.recommendations[0].offeredUnitPrice = 1; },
    });
    expect((await verifyQuoteSignature(quote, merchantKey)).valid).toBe(false);
  });

  it('rejects quotes signed by a DIFFERENT merchant key', async () => {
    const { quote, foreignKey } = await makeSignedQuote({ foreignKey: true });
    expect((await verifyQuoteSignature(quote, foreignKey!)).valid).toBe(false);
  });

  it('refuses to SIGN when verification fails; advisory strategy also refuses', async () => {
    const { buyer, quote, merchant, merchantKey } = await makeSignedQuote({
      tamper: (q) => { q.merchantUpiId = 'attacker@upi'; },
    });

    await expect(
      buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), merchantKey)
    ).rejects.toThrow(/Quote signature verification failed/);

    // Even before mandate math runs:
    const evalRes = await buyer.strategicEvaluateQuote(quote, 'cloud_services', merchant.getDID(), merchantKey);
    expect(evalRes.proceed).toBe(false);
    expect(evalRes.evaluation.decision.rationale).toContain('QUOTE SIGNATURE REJECTED');
  });
});

// ── P2: Currency enforcement ────────────────────────────────────────────────

describe('P2 — Mandate currency enforcement', () => {
  async function inrMandate() {
    const userRoot = createAgentIdentity('Root', 'buyer');
    const subject = createAgentIdentity('Subj', 'buyer');
    return issueSpendingMandate({
      issuerIdentity: { did: userRoot.did, signingPrivateKeyJwk: userRoot.signingKeyPair.jwk.private },
      subjectDID: subject.did,
      constraints: { maxAmount: 500000, currency: 'INR', allowedCategories: ['cloud_services'], merchantWhitelist: ['*'] },
    });
  }

  it('accepts INR within an INR mandate', async () => {
    const vc = await inrMandate();
    expect(checkMandateBounds(vc, 100000, 'cloud_services', undefined, 'INR').allowed).toBe(true);
  });

  it('rejects USD even when under the cap — reason names both currencies', async () => {
    const vc = await inrMandate();
    const res = checkMandateBounds(vc, 100000, 'cloud_services', undefined, 'USD');
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("'USD'");
    expect(res.reason).toContain("'INR'");
  });
});

// ── P3: Full signed-transaction verification ────────────────────────────────

describe('P3 — Complete signed transaction verification', () => {
  function baseTx(overrides: Partial<any> = {}) {
    return {
      type: 'SIGNED_TRANSACTION' as const,
      transactionId: 'txn_p3',
      quoteId: 'quote_p3',
      buyerDID: 'did:key:zBuyer',
      merchantDID: 'did:key:zMerchant',
      amount: 100000,
      currency: 'INR',
      merchantUpiId: 'store@upi',
      nonce: '11111111-2222-4333-8444-555555555555',
      timestamp: new Date().toISOString(),
      jwsSignature: 'x.y.z',
      ...overrides,
    };
  }
  const payload = () => ({ ...baseTx(), type: undefined });

  it('matches an untouched transaction', () => {
    const tx = baseTx();
    expect(() =>
      assertSignedTransactionMatchesPayload(tx, payload(), 'did:key:zMerchant')
    ).not.toThrow();
  });

  it('rejects a tampered merchantUpiId / currency despite valid JWS shape', () => {
    const tx = baseTx({ merchantUpiId: 'attacker@upi' });
    expect(() => assertSignedTransactionMatchesPayload(tx, payload(), 'did:key:zMerchant'))
      .toThrow(/merchantUpiId/);

    const tx2 = baseTx({ currency: 'USD' });
    expect(() => assertSignedTransactionMatchesPayload(tx2, payload(), 'did:key:zMerchant'))
      .toThrow(/currency/);
  });

  it('rejects transactions addressed to ANOTHER merchant', () => {
    const tx = baseTx();
    expect(() => assertSignedTransactionMatchesPayload(tx, payload(), 'did:key:zSomeoneElse'))
      .toThrow(/wrong merchant/);
  });

  it('rejects STALE signed transactions at the settlement gate', async () => {
    const { merchant, buyer, session, channel, quote } = await makeSignedQuote();

    // Sign with the system clock frozen 10 minutes in the past so BOTH the
    // JWS payload and visible timestamp are genuinely stale.
    const RealDate = Date;
    const frozenNow = Date.now() - 10 * 60 * 1000;
    const FakeDate: any = class extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(frozenNow);
        else super(...(args as [any]));
      }
      static now() { return frozenNow; }
    };
    const g = globalThis as any;
    const RealDateRef = g.Date;
    g.Date = FakeDate;
    let staleTx;
    try {
      staleTx = await signTransactionPayload(
        quote,
        { did: buyer.identity.did, signingPrivateKeyJwk: buyer.identity.signingKeyPair.jwk.private },
        merchant.getDID()
      );
    } finally {
      g.Date = RealDateRef;
    }

    await expect(
      session.handleSignedTransaction(channel.packMessage(staleTx))
    ).rejects.toThrow(/Stale or malformed signed transaction/);
  });
});

// ── P4: Envelope timestamp freshness ────────────────────────────────────────

describe('P4 — SecureChannel timestamp freshness', () => {
  function freshChannel() {
    const a = createAgentIdentity('A', 'buyer');
    const b = createAgentIdentity('B', 'merchant');
    const chA = new SecureChannel(completeHandshake(a, b.didDocument));
    const chB = new SecureChannel(completeHandshake(b, a.didDocument));
    return { chA, chB };
  }

  it('accepts current timestamps', () => {
    const { chA, chB } = freshChannel();
    const env = chA.packMessage({ hello: 1 });
    expect(chB.unpackMessage(env)).toEqual({ hello: 1 });
  });

  it('rejects malformed timestamps', () => {
    const { chA, chB } = freshChannel();
    const env = chA.packMessage({ x: 1 });
    (env as any).timestamp = 'not-a-date';
    expect(() => chB.unpackMessage(env)).toThrow(/Invalid envelope timestamp/);
  });

  it('rejects an OLD frame even with a UNIQUE sequence number', () => {
    const { chA, chB } = freshChannel();
    const env = chA.packMessage({ x: 1 });
    env.sequenceId = 42; // unique — bypasses replay-window checks
    env.timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min old
    expect(() => chB.unpackMessage(env)).toThrow(/clock-skew window/);
  });

  it('rejects FUTURE timestamps beyond the skew window', () => {
    const { chA, chB } = freshChannel();
    const env = chA.packMessage({ x: 1 });
    env.timestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(() => chB.unpackMessage(env)).toThrow(/clock-skew window/);
  });
});

// ── P5: Durable ledger ──────────────────────────────────────────────────────

describe('P5 — SQLite durable ledger', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpay-ledger-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function store() {
    return new SqlitePersistence(path.join(tmpDir, 'ledger.db'));
  }

  it('webhook dedupe SURVIVES repository recreation', () => {
    const s1 = store();
    expect(s1.saveWebhook('k1', 'payment.captured', 'o', 'p')).toBe('new');
    s1.close?.();

    const s2 = new SqlitePersistence(path.join(tmpDir, 'ledger.db'));
    expect(s2.saveWebhook('k1', 'payment.captured', 'o', 'p')).toBe('duplicate');
    expect(s2.loadWebhookKeys()).toContain('k1');
  });

  it('transactions persist; a NEW agent instance hydrates idempotency state', async () => {
    const dbPath = path.join(tmpDir, 'ledger.db');

    const merchantA = new MerchantAgent({ name: 'Persist A', persistence: new SqlitePersistence(dbPath) });
    const buyer = new BuyerAgent();
    await buyer.provisionMandate({
      maxAmount: 500000, currency: 'INR',
      allowedCategories: ['cloud_services'], merchantWhitelist: ['*'],
    });

    const sA = merchantA.createSessionHandler();
    const mDID = sA.handleDIDExchange(buyer.createDIDExchangeMessage());
    const channel = buyer.establishSession(mDID.didDocument);
    await sA.handleMandatePresentation(
      channel.packMessage(buyer.createMandatePresentation()),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    sA.handleCatalogRequest(channel.packMessage({ type: 'CATALOG_REQUEST' }));
    const quote: any = channel.unpackMessage(await sA.handlePurchaseIntent(channel.packMessage({
      type: 'PURCHASE_INTENT', cartId: 'cart_p5',
      items: [{ itemId: 'item_gpu_h100_cluster', quantity: 1 }],
    })));
    const { signingKeyJwk } = extractKeysFromDIDDocument(mDID.didDocument);
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchantA.getDID(), signingKeyJwk);
    const receipt: any = channel.unpackMessage(await sA.handleSignedTransaction(channel.packMessage(signedTx)));

    // "Restart": brand-new agent over the SAME database file
    const merchantB = new MerchantAgent({ name: 'Persist B', persistence: new SqlitePersistence(dbPath) });
    expect(merchantB.transactionStore.has(receipt.transactionId)).toBe(true);
    expect(merchantB.analytics.totalTransactions).toBeGreaterThanOrEqual(1);

    // Replay of the same signed transaction on a LEGAL fresh FSM → nonce check
    // hits the hydrated store and returns the ORIGINAL receipt (no double charge)
    const sB = merchantB.createSessionHandler();
    const mDIDb = sB.handleDIDExchange(buyer.createDIDExchangeMessage());
    const chB2 = buyer.establishSession(mDIDb.didDocument);
    await sB.handleMandatePresentation(
      chB2.packMessage(buyer.createMandatePresentation()),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );

    const r2: any = await sB.handleSignedTransaction(signedTx).catch((e) => ({ __error: e.message }));
    if (r2.__error) expect(String(r2.__error)).toMatch(/Duplicate nonce|already/i);
    else expect(r2.razorpayPaymentId).toBe(receipt.razorpayPaymentId);
  });

  it('daily spend limit uses PERSISTED records across instances', async () => {
    process.env.PERSISTENCE = 'auto';
    const storeInst = store();
    const { SpendLedger } = await import('../src/identity/credentials.js');
    SpendLedger.setPersistence(storeInst);
    try {
      storeInst.recordSpend('did:key:p5subject', 400000, Date.now());

      // Fresh singleton reads through SQLite
      SpendLedger.reset();
      const spent = SpendLedger.getInstance().getDailySpend('did:key:p5subject');
      expect(spent).toBe(400000);
    } finally {
      // Detach so other suites stay memory-based
      (SpendLedger as any).persistence = null;
    }
  });

  it('memory fallback factory works', () => {
    process.env.PERSISTENCE = 'memory';
    expect(createPersistenceFromEnv().kind).toBe('memory');
    delete process.env.PERSISTENCE;
  });
});

// ── P6: Honest gateway mode surfaces ────────────────────────────────────────

describe('P6 — Gateway honesty surfaces', () => {
  let app: FastifyInstance;

  afterEach(async () => { if (app) await app.close(); });

  it('/api/identities reports orderCreationMode, captureMode, llm chain, persistence', async () => {
    process.env.NODE_ENV = 'test';
    process.env.RAZORPAY_MOCK_MODE = 'true';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.LLM_ENABLED = 'false';

    app = await buildServer();
    const body = (await app.inject({ method: 'GET', url: '/api/identities' })).json();

    expect(body.gatewayMode).toBe('mock');
    expect(body.orderCreationMode).toBe('mock');
    expect(body.captureMode).toBe('uap-simulated');
    expect(body.llmEnabled).toBe(false);
    expect(body.activeModel).toBe('deterministic');
    expect(['sqlite', 'memory']).toContain(body.persistence);
  });

  it('/api/llm/status exposes provider chain without secrets', async () => {
    process.env.LLM_ENABLED = 'true';
    delete process.env.OPENROUTER_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    app = await buildServer();
    const body = (await app.inject({ method: 'GET', url: '/api/llm/status' })).json();

    expect(body.enabled).toBe(true);
    expect(body.providers).toEqual(['gemini']);
    expect(JSON.stringify(body)).not.toContain('test-gemini-key');
    process.env.LLM_ENABLED = undefined as any;
    delete process.env.GEMINI_API_KEY;
  });
});
