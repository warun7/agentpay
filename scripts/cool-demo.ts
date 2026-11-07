/**
 * AgentPay × CooL — sealed, offline-verifiable checkout evidence.
 *
 *   npm run demo:cool
 *
 * 1. Runs a full autonomous checkout; buyer and merchant each seal their
 *    decisions into their own CooL log.
 * 2. Verifies every record offline against each party's PINNED key directory.
 * 3. Tampers with the settled record           → must fail.
 * 4. Discloses the settled terms to an auditor → true terms pass, a lie fails.
 * 5. Forges a settlement from an impostor log  → must fail under pinning.
 * 6. Runs a buyer whose mandate is too small   → refusal is sealed too.
 */
import { CooL, verifyEvidence, withTrustedKeys } from 'cool-nwc';
import { SimulatedDstackClient, disclose } from 'cool-nwc/phala';
import { BuyerAgent } from '../src/agents/buyer-agent.js';
import { MerchantAgent, isWireEnvelope } from '../src/agents/merchant-agent.js';
import { extractKeysFromDIDDocument } from '../src/identity/did.js';
import {
  CheckoutEvidence,
  verifyCheckoutEvidence,
  discloseTerms,
  checkTermsDisclosure,
  canonicalJson,
  type SealedCheckoutEvent,
} from '../src/evidence/cool-evidence.js';

const ok = (b: boolean) => (b ? '✓' : '✗');
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
let failures = 0;
const expect = (label: string, cond: boolean) => {
  if (!cond) failures++;
  console.log(`  ${ok(cond)} ${label}`);
};

async function runCheckout(merchant: MerchantAgent, buyer: BuyerAgent) {
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
  return { executionId: channel.getSession().sessionId, receipt, session };
}

function printRecords(title: string, records: readonly SealedCheckoutEvent[]) {
  console.log(`  ${title}`);
  for (const r of records) {
    const leaf = (r.evidence as any)?.inclusion?.leaf_index;
    console.log(`    • ${r.type.padEnd(30)} ${r.recordId}${leaf !== undefined ? `  leaf ${leaf}` : ''}`);
  }
}

async function main() {
  console.log('\nAgentPay × CooL — sealed checkout evidence\n' + '─'.repeat(64));

  // ── 1. Checkout ───────────────────────────────────────────────────────
  const merchant = new MerchantAgent({ name: 'NovaCloud AI Infrastructure' });
  const buyer = new BuyerAgent({ name: 'Alpha Research Buyer' });
  await buyer.provisionMandate({
    maxAmount: 500000,
    currency: 'INR',
    allowedCategories: ['cloud_services', 'saas_subscription'],
    merchantWhitelist: ['*'],
  });
  if (!merchant.evidence || !buyer.evidence) {
    throw new Error('CooL evidence is disabled — unset COOL_EVIDENCE=off');
  }

  const { executionId, receipt } = await runCheckout(merchant, buyer);
  console.log(`\n[1] Checkout settled ${rupees(receipt.amount)} · order ${receipt.razorpayOrderId}`);
  console.log(`    execution (shared ECDH session) ${executionId}`);
  const buyerRecords = buyer.evidence.forExecution(executionId);
  const merchantRecords = merchant.evidence.forExecution(executionId);
  printRecords('buyer log:', buyerRecords);
  printRecords('merchant log:', merchantRecords);
  expect('buyer sealed its signing decision', buyerRecords.some((r) => r.type === 'agentpay.quote.signed'));
  expect(
    'merchant sealed mandate → quote → settlement in order',
    merchantRecords.map((r) => r.type).join(',') ===
      'agentpay.mandate.verified,agentpay.quote.issued,agentpay.payment.settled'
  );

  // ── 2. Offline verification against pinned keys ──────────────────────
  console.log('\n[2] Verify offline, keys pinned to each party’s published directory');
  const vb = await verifyCheckoutEvidence(buyerRecords.map((r) => r.evidence), buyer.evidence.keyDirectory);
  const vm = await verifyCheckoutEvidence(merchantRecords.map((r) => r.evidence), merchant.evidence.keyDirectory);
  for (const c of [...vb.checks, ...vm.checks]) {
    const d = c.verdict.checks as any;
    console.log(
      `    ${ok(c.ok)} ${c.type.padEnd(30)} binding=${d.binding?.status} signature=${d.signature?.status} ` +
        `inclusion=${d.inclusion?.status} attestation=${d.attestation?.status}`
    );
  }
  expect('every record verifies', vb.ok && vm.ok);

  // ── 3. Tamper ─────────────────────────────────────────────────────────
  console.log('\n[3] Someone edits the settled record after the fact');
  const settled = merchantRecords.find((r) => r.type === 'agentpay.payment.settled')!;
  const tampered = structuredClone(settled.evidence) as any;
  const c: string = tampered.record.event.commitments.state;
  tampered.record.event.commitments.state = c.slice(0, -1) + (c.endsWith('0') ? '1' : '0');
  const vt = await verifyCheckoutEvidence([tampered], merchant.evidence.keyDirectory);
  console.log(`    reasons: ${vt.checks[0].verdict.reasons.join(' | ')}`);
  expect('tampered record is rejected', !vt.ok);

  // ── 4. Selective disclosure ───────────────────────────────────────────
  console.log('\n[4] Merchant opens ONLY the settlement terms to an auditor');
  const disclosure = discloseTerms(settled);
  const truth = checkTermsDisclosure(settled.evidence, disclosure);
  console.log(`    disclosed: ${disclosure.value}`);
  expect('true terms match the sealed commitment', truth.ok);
  const claimed = JSON.parse(settled.terms);
  const lie = { ...disclosure, value: canonicalJson({ ...claimed, amount: claimed.amount + 50000 }) };
  expect(
    `claiming ${rupees(claimed.amount + 50000)} instead of ${rupees(claimed.amount)} fails`,
    !checkTermsDisclosure(settled.evidence, lie).ok
  );

  // ── 5. Impostors ──────────────────────────────────────────────────────
  console.log('\n[5] Impostors forge a ₹1.00 settlement');
  const sameKeys = (a: object, b: object) => canonicalJson(a) === canonicalJson(b);

  // Upstream behaviour: CooL's default local mode derives keys from public inputs.
  const defaultA = new CooL({ applicationId: 'agentpay-merchant' });
  const defaultB = new CooL({ applicationId: 'agentpay-merchant' });
  await Promise.all([defaultA.ready(), defaultB.ready()]);
  console.log(
    `    cool-nwc default local mode, two separate clients, same app id → identical keys: ${sameKeys(defaultA.keyDirectory, defaultB.keyDirectory)}`
  );
  expect(
    'our merchant key is NOT the derivable default key',
    !sameKeys(merchant.evidence.keyDirectory, defaultA.keyDirectory)
  );

  const impostors = [
    { label: 'same app id, default key', log: new CheckoutEvidence('merchant', { cool: defaultA }) },
    { label: 'different app id', log: new CheckoutEvidence('merchant', { cool: new CooL({ applicationId: 'agentpay-merchant-v2' }) }) },
    {
      label: 'different image digest',
      log: new CheckoutEvidence('merchant', {
        cool: new CooL({
          applicationId: 'agentpay-merchant',
          dstackClient: new SimulatedDstackClient({ appName: 'agentpay-merchant', imageDigest: 'sha256:attacker-build' }),
        }),
      }),
    },
  ];
  for (const { label, log } of impostors) {
    const forged = (await log.seal('agentpay.payment.settled', executionId, { ...claimed, amount: 100 }))!;
    const self = await verifyEvidence(forged.evidence);
    const merged = await verifyEvidence(withTrustedKeys(forged.evidence as any, merchant.evidence.keyDirectory));
    const pinned = await verifyCheckoutEvidence([forged.evidence], merchant.evidence.keyDirectory);
    const why = pinned.checks[0].untrustedSigners.length
      ? `untrusted signer ${pinned.checks[0].untrustedSigners.join(',')}`
      : `signature=${(pinned.checks[0].verdict.checks as any).signature?.status}`;
    console.log(`    ${label}: key ids ${Object.keys(log.keyDirectory).join(',')}`);
    console.log(`      own keys ok=${self.ok} · withTrustedKeys ok=${merged.ok} · pinned ok=${pinned.ok} (${why})`);
    expect(`${label}: forgery fails under pinning`, !pinned.ok);
  }
  await defaultB.close();

  // ── 6. Mandate gate refusal ───────────────────────────────────────────
  console.log('\n[6] A buyer with a ₹1,000 mandate is quoted ₹3,000+');
  const tightBuyer = new BuyerAgent({ name: 'Tight Budget Buyer' });
  await tightBuyer.provisionMandate({
    maxAmount: 100000,
    currency: 'INR',
    allowedCategories: ['cloud_services'],
    merchantWhitelist: ['*'],
  });
  let refusedWith = '';
  try {
    await runCheckout(merchant, tightBuyer);
  } catch (err: any) {
    refusedWith = err.message;
  }
  console.log(`    buyer refused: ${refusedWith}`);
  const refusal = tightBuyer.evidence!.all().find((r) => r.type === 'agentpay.quote.refused');
  expect('refusal was sealed by the buyer', !!refusal);
  if (refusal) {
    const vr = await verifyCheckoutEvidence([refusal.evidence], tightBuyer.evidence!.keyDirectory);
    expect('sealed refusal verifies offline', vr.ok);
  }

  // ── Probe: cool-nwc metadata disclosure ───────────────────────────────
  console.log('\n[probe] cool-nwc disclose(receipt, "metadata", <exact recorded metadata>)');
  try {
    disclose(settled.evidence as any, 'metadata', JSON.stringify({ app: 'agentpay', party: 'merchant', event: settled.type }));
    console.log('    → disclosure produced');
  } catch (err: any) {
    console.log(`    → threw: ${err.message}`);
  }

  await Promise.all([
    merchant.evidence.close(),
    buyer.evidence.close(),
    ...impostors.map((i) => i.log.close()),
    tightBuyer.evidence!.close(),
  ]);
  console.log('\n' + '─'.repeat(64));
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('cool-demo error:', err);
  process.exit(1);
});
