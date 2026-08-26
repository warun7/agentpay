import { describe, it, expect } from 'vitest';
import { ProtocolStateMachine, ProtocolViolationError } from '../src/protocol/state-machine.js';
import {
  DIDExchangeSchema,
  MandatePresentationSchema,
  CatalogRequestSchema,
  CatalogResponseSchema,
  PurchaseIntentSchema,
  QuoteSchema,
  TransactionPayloadSchema,
  SettlementReceiptSchema,
} from '../src/protocol/schemas.js';

describe('Protocol Engine & State Machine', () => {
  it('should enforce strict linear state machine transitions', () => {
    const fsm = new ProtocolStateMachine();
    expect(fsm.getState()).toBe('INIT');

    fsm.transition('DID_EXCHANGED', 'EXCHANGE_DIDS');
    expect(fsm.getState()).toBe('DID_EXCHANGED');

    fsm.transition('SESSION_ESTABLISHED', 'COMPLETE_ECDH');
    expect(fsm.getState()).toBe('SESSION_ESTABLISHED');

    fsm.transition('MANDATE_VERIFIED', 'VERIFY_VC');
    expect(fsm.getState()).toBe('MANDATE_VERIFIED');

    fsm.transition('CATALOG_RECEIVED', 'FETCH_CATALOG');
    expect(fsm.getState()).toBe('CATALOG_RECEIVED');

    fsm.transition('INTENT_SENT', 'SUBMIT_INTENT');
    expect(fsm.getState()).toBe('INTENT_SENT');

    fsm.transition('QUOTE_RECEIVED', 'ISSUE_QUOTE');
    expect(fsm.getState()).toBe('QUOTE_RECEIVED');

    fsm.transition('SIGNED', 'SIGN_TRANSACTION');
    expect(fsm.getState()).toBe('SIGNED');

    fsm.transition('SETTLED', 'CAPTURE_PAYMENT');
    expect(fsm.getState()).toBe('SETTLED');

    const history = fsm.getHistory();
    expect(history).toHaveLength(8);
    expect(history[0].fromState).toBe('INIT');
    expect(history[0].toState).toBe('DID_EXCHANGED');
  });

  it('should reject out-of-order state transitions with ProtocolViolationError', () => {
    const fsm = new ProtocolStateMachine();
    expect(fsm.getState()).toBe('INIT');

    // Attempting to jump directly from INIT to SIGNED
    expect(() => {
      fsm.transition('SIGNED', 'ATTACK_SKIP_TO_SIGN');
    }).toThrow(ProtocolViolationError);

    expect(fsm.getState()).toBe('ERROR');
  });

  it('should validate protocol message shapes against Zod schemas', () => {
    const validCatalogReq = CatalogRequestSchema.safeParse({
      type: 'CATALOG_REQUEST',
      category: 'cloud_services',
    });
    expect(validCatalogReq.success).toBe(true);

    const invalidCatalogReq = CatalogRequestSchema.safeParse({
      type: 'CATALOG_REQUEST',
      maxPrice: -500, // Negative price
    });
    expect(invalidCatalogReq.success).toBe(false);

    const validTxn = TransactionPayloadSchema.safeParse({
      type: 'SIGNED_TRANSACTION',
      transactionId: 'txn_123',
      quoteId: 'quote_456',
      buyerDID: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      merchantDID: 'did:key:z6MkiE7VWHojYrmiGz7bHBgv3aUGA3mHD3bYniiwAZnjMptj',
      amount: 350000,
      currency: 'INR',
      merchantUpiId: 'agentpay.merchant@razorpay',
      nonce: '0ed4be6c-927a-4bac-9320-1345a0facd16',
      timestamp: new Date().toISOString(),
      jwsSignature: 'header.payload.sig',
    });
    expect(validTxn.success).toBe(true);
  });
});
