import { describe, it, expect } from 'vitest';
import { MerchantAgent, isWireEnvelope } from '../src/agents/merchant-agent.js';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import type { WireEnvelope } from '../src/session/types.js';
import type { SettlementReceiptMessage } from '../src/protocol/schemas.js';

/**
 * Phase 0b — SecureChannel envelope enforcement.
 * Verifies that post-handshake protocol traffic genuinely rides inside
 * AES-256-GCM encrypted frames, and that tamper/replay/cross-session
 * attacks are rejected by the channel itself.
 */
describe('Phase 0b — Encrypted envelope transport', () => {

  async function setupSession() {
    const merchant = new MerchantAgent({ name: 'Secure Test Merchant' });
    const buyer = new BuyerAgent({ name: 'Secure Test Buyer' });
    await buyer.provisionMandate({
      maxAmount: 500000,
      currency: 'INR',
      allowedCategories: ['cloud_services', 'saas_subscription'],
      merchantWhitelist: ['*'],
    });

    const session = merchant.createSessionHandler();

    // Step 1 is plaintext by protocol design (no shared key yet)
    const merchantDIDMsg = session.handleDIDExchange(buyer.createDIDExchangeMessage());
    const buyerChannel = buyer.establishSession(merchantDIDMsg.didDocument);
    const merchantChannel = session.getChannel()!;

    return { merchant, buyer, session, buyerChannel, merchantChannel };
  }

  it('derives IDENTICAL sessionId and sessionKey on both sides of the handshake', async () => {
    const { buyerChannel, merchantChannel } = await setupSession();

    expect(buyerChannel.getSession().sessionId).toBe(merchantChannel.getSession().sessionId);
    expect(buyerChannel.getSession().sessionKey.equals(merchantChannel.getSession().sessionKey))
      .toBe(true);
  });

  it('runs the full checkout with every post-handshake frame encrypted', async () => {
    const { merchant, buyer, session, buyerChannel } = await setupSession();
    let allEncrypted = true;

    // Mandate presentation
    const mandateResp = await session.handleMandatePresentation(
      buyerChannel.packMessage(buyer.createMandatePresentation()),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    if (!isWireEnvelope(mandateResp)) throw new Error('expected envelope');
    allEncrypted &&= mandateResp.encrypted;
    const verified = buyerChannel.unpackMessage<{ verified: boolean }>(mandateResp);
    expect(verified.verified).toBe(true);

    // Catalog
    const catEnv = session.handleCatalogRequest(
      buyerChannel.packMessage(buyer.createCatalogRequest('cloud_services'))
    );
    if (!isWireEnvelope(catEnv)) throw new Error('expected envelope');
    allEncrypted &&= catEnv.encrypted;

    // Intent + quote
    const quoteEnv = await session.handlePurchaseIntent(
      buyerChannel.packMessage(buyer.createPurchaseIntent('item_gpu_h100_cluster', 1, 320000))
    );
    if (!isWireEnvelope(quoteEnv)) throw new Error('expected envelope');
    allEncrypted &&= quoteEnv.encrypted;
    const quote = buyerChannel.unpackMessage<any>(quoteEnv);

    // Sign + settle
    const { signingKeyJwk: mKey } = extractKeysFromDIDDocument(buyerChannel.getSession().peerDIDDocument);
    const signedTx = await buyer.evaluateAndSignQuote(quote, 'cloud_services', merchant.getDID(), mKey);
    const receiptEnv = await session.handleSignedTransaction(buyerChannel.packMessage(signedTx));
    if (!isWireEnvelope(receiptEnv)) throw new Error('expected envelope');
    allEncrypted &&= receiptEnv.encrypted;
    const receipt = buyerChannel.unpackMessage<SettlementReceiptMessage>(receiptEnv);

    expect(allEncrypted).toBe(true);
    expect(receipt.status).toBe('CAPTURED');
  });

  it('rejects a TAMPERED ciphertext (AES-GCM authentication failure)', async () => {
    const { buyer, session, buyerChannel } = await setupSession();
    const envelope = buyerChannel.packMessage(buyer.createMandatePresentation());

    const tampered: WireEnvelope = {
      ...envelope,
      ciphertext:
        envelope.ciphertext!.slice(0, -4) +
        (envelope.ciphertext!.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'),
    };

    await expect(
      session.handleMandatePresentation(tampered, buyer.userWalletIdentity.signingKeyPair.jwk.public)
    ).rejects.toThrow();
  });

  it('rejects REPLAYED sequenceIds (anti-replay window)', async () => {
    const { buyer, session, buyerChannel } = await setupSession();

    const replayedFrame = buyerChannel.packMessage(buyer.createMandatePresentation());
    await session.handleMandatePresentation(
      replayedFrame,
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );

    // Re-deliver the EXACT same envelope — must be rejected as a replay attack
    expect(() =>
      session.handleCatalogRequest(replayedFrame)
    ).toThrow(/Replay attack detected/);
  });

  it('rejects frames from a DIFFERENT session (sessionId mismatch)', async () => {
    const { buyer, session, buyerChannel } = await setupSession();

    // A second buyer establishes an independent session against the same merchant
    const outsider = new BuyerAgent({ name: 'Outsider Agent' });
    const outsiderChannel = outsider.establishSession(buyer.identity.didDocument);

    // Sanity: different identities -> different session IDs
    expect(outsiderChannel.getSession().sessionId).not.toBe(buyerChannel.getSession().sessionId);

    const rogueFrame = outsiderChannel.packMessage(outsider.createCatalogRequest('cloud_services'));

    // Deliver outsider's frame into buyer's established merchant session
    expect(() => session.handleCatalogRequest(rogueFrame)).toThrow(/Session mismatch/);
  });

  it('still supports LOOPBACK raw-object mode for in-process calls (backward compat)', async () => {
    const { merchant, buyer, session, buyerChannel } = await setupSession();

    // Raw objects, no envelopes anywhere
    await session.handleMandatePresentation(
      buyer.createMandatePresentation(),
      buyer.userWalletIdentity.signingKeyPair.jwk.public
    );
    const catalog = session.handleCatalogRequest(buyer.createCatalogRequest('cloud_services'));
    expect(isWireEnvelope(catalog)).toBe(false);
    expect((catalog as any).items.length).toBeGreaterThan(0);

    const intent = buyer.createPurchaseIntent('item_gpu_h100_cluster', 1, 320000);
    const quote = await session.handlePurchaseIntent(intent);
    expect(isWireEnvelope(quote)).toBe(false);

    const { signingKeyJwk: mKeyLoop } = extractKeysFromDIDDocument(buyerChannel.getSession().peerDIDDocument);
    const signedTx = await buyer.evaluateAndSignQuote(
      quote as any,
      'cloud_services',
      merchant.getDID(),
      mKeyLoop
    );
    const receipt = await session.handleSignedTransaction(signedTx);
    expect(isWireEnvelope(receipt)).toBe(false);
    expect((receipt as SettlementReceiptMessage).status).toBe('CAPTURED');
  });
});
