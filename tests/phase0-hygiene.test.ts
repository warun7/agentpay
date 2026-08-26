import { describe, it, expect, beforeEach } from 'vitest';
import { RazorpayGateway } from '../src/payment/razorpay.js';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { checkMandateBounds, SpendLedger } from '../src/identity/credentials.js';
import { issueSpendingMandate } from '../src/identity/credentials.js';
import { createAgentIdentity } from '../src/identity/did.js';
import { ProtocolStateMachine } from '../src/protocol/state-machine.js';
import {
  DIDExchangeSchema,
  PurchaseIntentSchema,
  TransactionPayloadSchema,
  ReconciliationChallengeSchema,
} from '../src/protocol/schemas.js';

describe('Phase 0 — Hygiene & Correctness', () => {

  // ── Bug 1: Operator Precedence in RazorpayGateway Constructor ──
  describe('Bug 1: RazorpayGateway constructor precedence', () => {
    it('should stay in mock mode when mockMode=true even with rzp_test key', () => {
      const gw = new RazorpayGateway({
        keyId: 'rzp_test_should_not_connect',
        keySecret: 'test_secret',
        mockMode: true,
      });
      expect(gw.isMockMode()).toBe(true);
    });

    it('should stay in mock mode when mockMode is explicitly true with rzp_live key', () => {
      const gw = new RazorpayGateway({
        keyId: 'rzp_live_fake_key',
        keySecret: 'test_secret',
        mockMode: true,
      });
      expect(gw.isMockMode()).toBe(true);
    });
  });

  // ── Bug 2: Nonce Idempotency Guard ──
  describe('Bug 2: Nonce replay rejection before settlement', () => {
    it('should return existing receipt on duplicate nonce instead of double-charging', async () => {
      const merchant = new MerchantAgent({ name: 'Idempotency Test Merchant' });
      const buyer = new BuyerAgent({ name: 'Idempotency Test Buyer' });
      await buyer.provisionMandate({
        maxAmount: 500000,
        currency: 'INR',
        allowedCategories: ['cloud_services'],
        merchantWhitelist: ['*'],
      });

      const session = merchant.createSessionHandler();
      const merchantDIDMsg = session.handleDIDExchange(buyer.createDIDExchangeMessage());
      const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);
      const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(merchantDIDMsg.didDocument);

      await session.handleMandatePresentation(
        buyer.createMandatePresentation(),
        buyer.userWalletIdentity.signingKeyPair.jwk.public
      );

      const catalog = session.handleCatalogRequest(buyer.createCatalogRequest('cloud_services'));
      const intent = buyer.createPurchaseIntent(catalog.items[0].id, 1, 320000);
      const quote = await session.handlePurchaseIntent(intent);
      const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);

      // First settlement
      const receipt1 = await session.handleSignedTransaction(signedTx);
      expect(receipt1.status).toBe('CAPTURED');

      // Verify nonce is stored
      expect(merchant.transactionStore.has(signedTx.nonce)).toBe(true);

      // Re-submit the exact same signed transaction (same nonce) → idempotent return
      // Reset FSM to allow re-entry into SIGNED state for the test
      const session2 = merchant.createSessionHandler();
      session2.handleDIDExchange(buyer.createDIDExchangeMessage());
      await session2.handleMandatePresentation(
        buyer.createMandatePresentation(),
        buyer.userWalletIdentity.signingKeyPair.jwk.public
      );
      session2.handleCatalogRequest(buyer.createCatalogRequest('cloud_services'));
      await session2.handlePurchaseIntent(buyer.createPurchaseIntent(catalog.items[0].id, 1, 320000));

      const receipt2 = await session2.handleSignedTransaction(signedTx);
      // Should return the SAME receipt — no double charge
      expect(receipt2.razorpayOrderId).toBe(receipt1.razorpayOrderId);
      expect(receipt2.razorpayPaymentId).toBe(receipt1.razorpayPaymentId);
    });
  });

  // ── Bug 3 + Bug 7: dailyLimit Enforcement via SpendLedger ──
  describe('Bug 3+7: dailyLimit enforcement with cumulative spend tracking', () => {
    beforeEach(() => {
      SpendLedger.reset();
    });

    it('should block transaction when cumulative daily spend exceeds limit', async () => {
      const userRoot = createAgentIdentity('Root', 'buyer');
      const buyerAgent = createAgentIdentity('Buyer', 'buyer');

      const vc = await issueSpendingMandate({
        issuerIdentity: {
          did: userRoot.did,
          signingPrivateKeyJwk: userRoot.signingKeyPair.jwk.private,
        },
        subjectDID: buyerAgent.did,
        constraints: {
          maxAmount: 500000,
          currency: 'INR',
          allowedCategories: ['cloud_services'],
          merchantWhitelist: ['*'],
          dailyLimit: 600000, // ₹6,000 daily limit
        },
      });

      // First spend: ₹3,500 — should pass
      const ledger = SpendLedger.getInstance();
      const check1 = checkMandateBounds(vc, 350000, 'cloud_services');
      expect(check1.allowed).toBe(true);
      ledger.recordSpend(buyerAgent.did, 350000);

      // Second spend: ₹3,500 — cumulative ₹7,000 > ₹6,000 daily limit → blocked
      const check2 = checkMandateBounds(vc, 350000, 'cloud_services');
      expect(check2.allowed).toBe(false);
      expect(check2.reason).toContain('Daily spend limit exceeded');
    });

    it('should allow transaction when dailyLimit is not set', async () => {
      const userRoot = createAgentIdentity('Root', 'buyer');
      const buyerAgent = createAgentIdentity('Buyer', 'buyer');

      const vc = await issueSpendingMandate({
        issuerIdentity: {
          did: userRoot.did,
          signingPrivateKeyJwk: userRoot.signingKeyPair.jwk.private,
        },
        subjectDID: buyerAgent.did,
        constraints: {
          maxAmount: 500000,
          currency: 'INR',
          allowedCategories: ['cloud_services'],
          merchantWhitelist: ['*'],
          // no dailyLimit → unlimited daily
        },
      });

      const check = checkMandateBounds(vc, 400000, 'cloud_services');
      expect(check.allowed).toBe(true);
    });
  });

  // ── Bug 5: Runtime Zod Validation at Handler Boundaries ──
  describe('Bug 5: Zod schema validation at handler entry points', () => {
    it('should reject malformed DID exchange message at merchant handler', () => {
      const merchant = new MerchantAgent();
      const session = merchant.createSessionHandler();

      expect(() => session.handleDIDExchange({
        type: 'DID_EXCHANGE',
        agentRole: 'hacker',  // Invalid role
        did: 'not-a-did',
        didDocument: {},
      })).toThrow();
    });

    it('should reject malformed catalog request at merchant handler', () => {
      const merchant = new MerchantAgent();
      const session = merchant.createSessionHandler();

      // Need to be in SESSION_ESTABLISHED state first
      const buyer = new BuyerAgent();
      session.handleDIDExchange(buyer.createDIDExchangeMessage());

      // Valid catalog request should work
      expect(() => session.handleCatalogRequest({ type: 'NOT_CATALOG' })).toThrow();
    });
  });

  // ── Bug 6: Reconciliation Deduplication ──
  describe('Bug 6: Reconciliation challenge uses canonical negotiation.ts helper', () => {
    it('should produce schema-valid reconciliation challenge from BuyerAgent', async () => {
      const buyer = new BuyerAgent();

      const challenge = await buyer.createReconciliationChallenge(
        'txn_test_dedup',
        'quote_test_dedup',
        '0ed4be6c-927a-4bac-9320-1345a0facd16'
      );

      // Validate against canonical schema
      const result = ReconciliationChallengeSchema.safeParse(challenge);
      expect(result.success).toBe(true);
      expect(challenge.type).toBe('RECONCILIATION_CHALLENGE');
      expect(challenge.transactionId).toBe('txn_test_dedup');
    });
  });
});
