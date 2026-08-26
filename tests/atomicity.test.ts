import { describe, it, expect } from 'vitest';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent } from '../src/agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import { ProtocolStateMachine } from '../src/protocol/state-machine.js';

describe('Distributed Payment Atomicity & Autonomous Dispute Recovery', () => {
  it('should cleanly recover settlement state when connection drops after order capture', async () => {
    // 1. Setup Agents & Session
    const merchant = new MerchantAgent({ name: 'Atomicity Test Merchant' });
    const buyer = new BuyerAgent({ name: 'Atomicity Test Buyer' });
    await buyer.provisionMandate({
      maxAmount: 500000,
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const buyerFsm = new ProtocolStateMachine();
    const merchantSession = merchant.createSessionHandler();

    // 2. Handshake & Mandate
    const buyerDIDMsg = buyer.createDIDExchangeMessage();
    buyerFsm.transition('DID_EXCHANGED', 'SEND_DID');
    const merchantDIDMsg = merchantSession.handleDIDExchange(buyerDIDMsg);

    const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);
    const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(merchantDIDMsg.didDocument);
    buyerFsm.transition('SESSION_ESTABLISHED', 'COMPLETE_ECDH');

    await merchantSession.handleMandatePresentation(
      buyer.createMandatePresentation(),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    buyerFsm.transition('MANDATE_VERIFIED', 'MANDATE_VERIFIED');

    // 3. Catalog & Intent
    const catalogResp = merchantSession.handleCatalogRequest(buyer.createCatalogRequest('cloud_services'));
    buyerFsm.transition('CATALOG_RECEIVED', 'CATALOG_RECEIVED');

    const intent = buyer.createPurchaseIntent(catalogResp.items[0].id, 1, 320000);
    buyerFsm.transition('INTENT_SENT', 'INTENT_SENT');

    const quote = await merchantSession.handlePurchaseIntent(intent);
    buyerFsm.transition('QUOTE_RECEIVED', 'QUOTE_RECEIVED');

    // 4. Buyer Signs Transaction
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);
    buyerFsm.transition('SIGNED', 'SIGN_TRANSACTION');

    // 5. Merchant captures payment on Razorpay Gateway
    const settlementReceipt = await merchantSession.handleSignedTransaction(signedTx);
    expect(settlementReceipt.status).toBe('CAPTURED');
    expect(merchant.transactionStore.has(signedTx.nonce)).toBe(true);

    // --- SIMULATE NETWORK DROP / LOST FRAME HERE ---
    // The settlementReceipt frame never reached the Buyer Agent over the wire.
    // Buyer FSM is currently stuck at SIGNED and hits timeout T_ack (3000ms).

    expect(buyerFsm.getState()).toBe('SIGNED');

    // 6. Buyer initiates Dispute Recovery Loop
    buyerFsm.transition('RECONCILING', 'TIMEOUT_INITIATE_RECONCILIATION');
    const challenge = await buyer.createReconciliationChallenge(
      signedTx.transactionId,
      quote.quoteId,
      signedTx.nonce
    );

    // 7. Merchant handles reconciliation challenge
    const proof = await merchantSession.handleReconciliation(challenge);
    expect(proof.status).toBe('SETTLED');
    expect(proof.settlementReceipt).toBeDefined();
    expect(proof.settlementReceipt?.razorpayOrderId).toBe(settlementReceipt.razorpayOrderId);

    // 8. Buyer processes and cryptographically verifies the proof
    const { signingKeyJwk: merchantPubKey } = extractKeysFromDIDDocument(merchant.identity.didDocument);
    const resolution = await buyer.processReconciliationProof(proof, merchantPubKey);

    expect(resolution.settled).toBe(true);
    expect(resolution.receipt?.razorpayPaymentId).toBe(settlementReceipt.razorpayPaymentId);

    // Buyer updates state machine to SETTLED
    buyerFsm.transition('SETTLED', 'SYNC_RECOVERED_RECEIPT', resolution.receipt);
    expect(buyerFsm.getState()).toBe('SETTLED');
  });

  it('should cleanly abort with signed void proof if payment never processed', async () => {
    const merchant = new MerchantAgent();
    const buyer = new BuyerAgent();
    await buyer.provisionMandate({
      maxAmount: 500000,
      currency: 'INR',
      allowedCategories: ['cloud_services'],
      merchantWhitelist: ['*'],
    });

    const buyerFsm = new ProtocolStateMachine();
    const merchantSession = merchant.createSessionHandler();

    // Handshake
    merchantSession.handleDIDExchange(buyer.createDIDExchangeMessage());
    buyerFsm.transition('DID_EXCHANGED', 'SEND_DID');
    buyerFsm.transition('SESSION_ESTABLISHED', 'COMPLETE_ECDH');
    buyerFsm.transition('MANDATE_VERIFIED', 'MANDATE_VERIFIED');
    buyerFsm.transition('CATALOG_RECEIVED', 'CATALOG_RECEIVED');
    buyerFsm.transition('INTENT_SENT', 'INTENT_SENT');
    buyerFsm.transition('QUOTE_RECEIVED', 'QUOTE_RECEIVED');
    buyerFsm.transition('SIGNED', 'SIGN_TRANSACTION');

    // Simulate scenario: Buyer sent signed transaction, but network died BEFORE reaching Merchant
    // Merchant never executed handleSignedTransaction
    buyerFsm.transition('RECONCILING', 'TIMEOUT_INITIATE_RECONCILIATION');
    const challenge = await buyer.createReconciliationChallenge(
      'txn_dropped_in_flight',
      'quote_123',
      'e7b4a20a-81a1-43d9-9528-98e3b2e59e10'
    );

    // Merchant processes challenge for unknown/unprocessed transaction
    const proof = await merchantSession.handleReconciliation(challenge);
    expect(proof.status).toBe('VOIDED');
    expect(proof.reason).toContain('GATEWAY_TIMEOUT_ORDER_NOT_PROCESSED');
    expect(proof.merchantSignature).toBeDefined();

    // Buyer verifies void proof
    const { signingKeyJwk: merchantPubKey } = extractKeysFromDIDDocument(merchant.identity.didDocument);
    const resolution = await buyer.processReconciliationProof(proof, merchantPubKey);

    expect(resolution.settled).toBe(false);
    expect(resolution.reason).toContain('GATEWAY_TIMEOUT_ORDER_NOT_PROCESSED');

    buyerFsm.transition('ABORTED', 'ACCEPT_SIGNED_VOID_PROOF');
    expect(buyerFsm.getState()).toBe('ABORTED');
  });

  it('should reject forged reconciliation challenges signed by unauthorized keys', async () => {
    const merchant = new MerchantAgent();
    const buyer = new BuyerAgent();
    const attacker = new BuyerAgent({ name: 'Malicious Agent' });

    const merchantSession = merchant.createSessionHandler();
    merchantSession.handleDIDExchange(buyer.createDIDExchangeMessage());

    // Attacker generates challenge for Buyer's transaction
    const forgedChallenge = await attacker.createReconciliationChallenge(
      'txn_victim',
      'quote_victim',
      '0ed4be6c-927a-4bac-9320-1345a0facd16'
    );

    // Merchant should reject because signature fails verification against established peer DID
    await expect(merchantSession.handleReconciliation(forgedChallenge)).rejects.toThrow();
  });
});
