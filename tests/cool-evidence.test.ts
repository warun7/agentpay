import { describe, it, expect } from 'vitest';
import { CooL, verifyEvidence, withTrustedKeys } from 'cool-nwc';
import { SimulatedDstackClient, disclose } from 'cool-nwc/phala';
import {
  CheckoutEvidence,
  verifyCheckoutEvidence,
  discloseTerms,
  checkTermsDisclosure,
  canonicalJson,
} from '../src/evidence/cool-evidence.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent, isWireEnvelope } from '../src/agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';

async function checkout(merchant: MerchantAgent, buyer: BuyerAgent) {
  const session = merchant.createSessionHandler();
  const mDID = session.handleDIDExchange(buyer.createDIDExchangeMessage());
  const channel = buyer.establishSession(mDID.didDocument);
  const open = <T>(env: unknown): T => {
    if (!isWireEnvelope(env)) throw new Error('expected encrypted envelope');
    return channel.unpackMessage<T>(env);
  };
  open(await session.handleMandatePresentation(
    channel.packMessage(buyer.createMandatePresentation()),
    buyer.userWalletIdentity.signingKeyPair.jwk.public
  ));
  const catalog = open<{ items: Array<{ id: string }> }>(
    session.handleCatalogRequest(channel.packMessage(buyer.createCatalogRequest('cloud_services')))
  );
  const quote = open<any>(await session.handlePurchaseIntent(
    channel.packMessage(buyer.createPurchaseIntent(catalog.items[0].id, 1, 320000))
  ));
  const { signingKeyJwk } = extractKeysFromDIDDocument(channel.getSession().peerDIDDocument);
  const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), signingKeyJwk);
  const receipt = open<any>(await session.handleSignedTransaction(channel.packMessage(signedTx)));
  return { executionId: channel.getSession().sessionId, receipt, session, channel, signedTx };
}

const MANDATE = {
  maxAmount: 500000,
  currency: 'INR',
  allowedCategories: ['cloud_services', 'saas_subscription'],
  merchantWhitelist: ['*'],
};

describe('CooL checkout evidence (agents)', () => {
  it('both agents seal their decisions under the shared session id, and all verify', async () => {
    const merchant = new MerchantAgent({ evidence: new CheckoutEvidence('merchant') });
    const buyer = new BuyerAgent({ evidence: new CheckoutEvidence('buyer') });
    await buyer.provisionMandate(MANDATE);

    const { executionId, receipt, session } = await checkout(merchant, buyer);

    const merchantTypes = session.getEvidence().map((e) => e.type);
    expect(merchantTypes).toEqual([
      'agentpay.mandate.verified',
      'agentpay.quote.issued',
      'agentpay.payment.settled',
    ]);
    expect(buyer.evidence!.forExecution(executionId).map((e) => e.type)).toEqual(['agentpay.quote.signed']);

    const settled = session.getEvidence().at(-1)!;
    expect(JSON.parse(settled.terms)).toMatchObject({
      amount: receipt.amount,
      razorpayOrderId: receipt.razorpayOrderId,
      auditDigest: receipt.cryptographicAuditDigest,
    });

    expect((await verifyCheckoutEvidence(session.getEvidence().map((e) => e.evidence), merchant.evidence!.keyDirectory)).ok).toBe(true);
    expect((await verifyCheckoutEvidence(buyer.evidence!.all().map((e) => e.evidence), buyer.evidence!.keyDirectory)).ok).toBe(true);
  });

  it('seals the buyer mandate gate refusing an over-cap quote', async () => {
    const merchant = new MerchantAgent({ evidence: new CheckoutEvidence('merchant') });
    const buyer = new BuyerAgent({ evidence: new CheckoutEvidence('buyer') });
    await buyer.provisionMandate({ ...MANDATE, maxAmount: 100000 });

    await expect(checkout(merchant, buyer)).rejects.toThrow(/mandate bounds checker/);

    const refusal = buyer.evidence!.all().find((e) => e.type === 'agentpay.quote.refused');
    expect(refusal).toBeDefined();
    expect(JSON.parse(refusal!.terms)).toMatchObject({ gate: 'mandate-bounds', mandateMaxAmount: 100000 });
    expect((await verifyCheckoutEvidence([refusal!.evidence], buyer.evidence!.keyDirectory)).ok).toBe(true);
  });

  it('seals a replayed signed transaction on a new session as a merchant rejection', async () => {
    const merchant = new MerchantAgent({ evidence: new CheckoutEvidence('merchant') });
    const buyer = new BuyerAgent({ evidence: new CheckoutEvidence('buyer') });
    await buyer.provisionMandate(MANDATE);
    const { signedTx } = await checkout(merchant, buyer);

    // Second session; replay the old signed transaction with its nonce cleared
    // from the idempotency store so it reaches the signature/freshness gates.
    merchant.transactionStore.clear();
    const session2 = merchant.createSessionHandler();
    const mDID2 = session2.handleDIDExchange(buyer.createDIDExchangeMessage());
    const ch2 = buyer.establishSession(mDID2.didDocument);
    await session2.handleMandatePresentation(
      ch2.packMessage(buyer.createMandatePresentation()),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    session2.handleCatalogRequest(ch2.packMessage(buyer.createCatalogRequest('cloud_services')));
    await session2.handlePurchaseIntent(ch2.packMessage(buyer.createPurchaseIntent('item_gpu_h100_cluster', 1, 320000)));
    const tamperedTx = { ...signedTx, amount: signedTx.amount - 1 };

    await expect(session2.handleSignedTransaction(ch2.packMessage(tamperedTx))).rejects.toThrow();
    const rejection = merchant.evidence!.all().find((e) => e.type === 'agentpay.transaction.rejected');
    expect(rejection).toBeDefined();
    expect(JSON.parse(rejection!.terms)).toMatchObject({ transactionId: signedTx.transactionId, amount: signedTx.amount - 1 });
  });
});

const TERMS = {
  sessionId: 'sess_test_7f3a9c',
  transactionId: 'tx_test_01',
  nonce: 'b1946ac92492d2347c6235b4d2611184',
  amount: 448380,
  currency: 'INR',
};

describe('CooL checkout evidence (module)', () => {
  it('seals a decision and verifies it offline against the pinned key directory', async () => {
    const merchant = new CheckoutEvidence('merchant');
    const sealed = await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS);
    expect(sealed).not.toBeNull();

    const result = await verifyCheckoutEvidence([sealed!.evidence], merchant.keyDirectory);
    expect(result.ok).toBe(true);
    expect(result.checks[0].verdict.checks.binding.status).toBe('pass');
    expect(result.checks[0].verdict.checks.signature.status).toBe('pass');
    expect(result.checks[0].verdict.checks.inclusion.status).toBe('pass');
    await merchant.close();
  });

  it('rejects a receipt whose sealed terms commitment was swapped', async () => {
    const merchant = new CheckoutEvidence('merchant');
    const sealed = (await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS))!;
    const tampered = structuredClone(sealed.evidence) as any;
    const original: string = tampered.record.event.commitments.state;
    tampered.record.event.commitments.state = original.slice(0, -1) + (original.endsWith('0') ? '1' : '0');

    const result = await verifyCheckoutEvidence([tampered], merchant.keyDirectory);
    expect(result.ok).toBe(false);
    await merchant.close();
  });

  it('does not use cool-nwc’s derivable default local-mode key', async () => {
    const ours = new CheckoutEvidence('merchant');
    const defaultClient = new CooL({ applicationId: 'agentpay-merchant' });
    const otherDefault = new CooL({ applicationId: 'agentpay-merchant' });
    await Promise.all([ours.ready(), defaultClient.ready(), otherDefault.ready()]);

    expect(canonicalJson(ours.keyDirectory)).not.toBe(canonicalJson(defaultClient.keyDirectory));
    console.log(
      `[probe] cool-nwc default local mode, two clients, same app id → identical keys: ` +
        `${canonicalJson(defaultClient.keyDirectory) === canonicalJson(otherDefault.keyDirectory)}`
    );
    await Promise.all([ours.close(), defaultClient.close(), otherDefault.close()]);
  });

  it('rejects a forgery made with the derivable default key for the same app id', async () => {
    const merchant = new CheckoutEvidence('merchant');
    await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS);
    const impostor = new CheckoutEvidence('merchant', { cool: new CooL({ applicationId: 'agentpay-merchant' }) });
    const forged = (await impostor.seal('agentpay.payment.settled', TERMS.sessionId, { ...TERMS, amount: 1 }))!;

    expect((await verifyEvidence(forged.evidence)).ok).toBe(true);
    const pinned = await verifyCheckoutEvidence([forged.evidence], merchant.keyDirectory);
    expect(pinned.ok).toBe(false);

    await merchant.close();
    await impostor.close();
  });

  it('rejects a forgery signed under a key id the verifier does not trust', async () => {
    const merchant = new CheckoutEvidence('merchant');
    await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS);
    // Key ids follow the image digest, so an attacker build gets its own ids.
    const impostor = new CheckoutEvidence('merchant', {
      cool: new CooL({
        applicationId: 'agentpay-merchant',
        dstackClient: new SimulatedDstackClient({ appName: 'agentpay-merchant', imageDigest: 'sha256:attacker-build' }),
      }),
    });
    const forged = (await impostor.seal('agentpay.payment.settled', TERMS.sessionId, { ...TERMS, amount: 1 }))!;

    // Upstream: the merge-only helper accepts this forgery.
    const merged = await verifyEvidence(withTrustedKeys(forged.evidence as any, merchant.keyDirectory));
    console.log(`[probe] cool-nwc withTrustedKeys on a different-key-id forgery → ok=${merged.ok}`);

    const pinned = await verifyCheckoutEvidence([forged.evidence], merchant.keyDirectory);
    expect(pinned.ok).toBe(false);
    expect(pinned.checks[0].untrustedSigners.length).toBeGreaterThan(0);

    await merchant.close();
    await impostor.close();
  });

  it('discloses one record’s terms without exposing anything else', async () => {
    const merchant = new CheckoutEvidence('merchant');
    const sealed = (await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS))!;

    const disclosure = discloseTerms(sealed);
    expect(checkTermsDisclosure(sealed.evidence, disclosure).ok).toBe(true);

    // A counterparty claiming different terms cannot produce a matching disclosure.
    const lie = { ...disclosure, value: canonicalJson({ party: 'merchant', event: 'agentpay.payment.settled', ...TERMS, amount: 500000 }) };
    expect(checkTermsDisclosure(sealed.evidence, lie).ok).toBe(false);
    await merchant.close();
  });

  it('documents cool-nwc metadata disclosure behaviour', async () => {
    const merchant = new CheckoutEvidence('merchant');
    const sealed = (await merchant.seal('agentpay.payment.settled', TERMS.sessionId, TERMS))!;
    const metadata = { app: 'agentpay', party: 'merchant', event: 'agentpay.payment.settled' };
    let outcome = 'ok';
    try {
      disclose(sealed.evidence as any, 'metadata', JSON.stringify(metadata));
    } catch (err: any) {
      outcome = `threw: ${err.message}`;
    }
    console.log(`[probe] disclose(metadata, exact JSON of the recorded metadata) → ${outcome}`);
    await merchant.close();
  });
});
