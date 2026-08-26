import { describe, it, expect } from 'vitest';
import {
  createAgentIdentity,
  extractKeysFromDIDDocument,
  formatEd25519DID,
} from '../src/identity/did.js';
import {
  issueSpendingMandate,
  verifyMandateCredential,
  checkMandateBounds,
} from '../src/identity/credentials.js';

describe('Identity & Verifiable Credentials Layer', () => {
  it('should create self-certifying did:key documents conforming to W3C specs', () => {
    const agent = createAgentIdentity('Test Agent', 'buyer');
    expect(agent.did).toMatch(/^did:key:z6Mk/);
    expect(agent.didDocument.id).toBe(agent.did);
    expect(agent.didDocument.verificationMethod[0].type).toBe('Ed25519VerificationKey2020');
    expect(agent.didDocument.keyAgreement[0].type).toBe('X25519KeyAgreementKey2020');

    const extracted = extractKeysFromDIDDocument(agent.didDocument);
    expect(extracted.signingKeyJwk.crv).toBe('Ed25519');
    expect(extracted.encryptionKeyJwk.crv).toBe('X25519');
  });

  it('should issue and cryptographically verify a spending mandate Verifiable Credential', async () => {
    const userWallet = createAgentIdentity('User Root Wallet', 'buyer');
    const buyerAgent = createAgentIdentity('Autonomous Buyer', 'buyer');

    const mandate = await issueSpendingMandate({
      issuerIdentity: {
        did: userWallet.did,
        signingPrivateKeyJwk: userWallet.signingKeyPair.jwk.private,
      },
      subjectDID: buyerAgent.did,
      constraints: {
        maxAmount: 500000, // ₹5,000.00
        currency: 'INR',
        allowedCategories: ['cloud_services'],
        merchantWhitelist: ['*'],
      },
    });

    expect(mandate.type).toContain('VerifiableCredential');
    expect(mandate.issuer).toBe(userWallet.did);
    expect(mandate.credentialSubject.id).toBe(buyerAgent.did);

    // Verify using User Wallet's public key
    const verification = await verifyMandateCredential(
      mandate,
      userWallet.signingKeyPair.jwk.public
    );
    expect(verification.valid).toBe(true);
    expect(verification.expired).toBe(false);

    // Tampering test: modify maxAmount without re-signing
    const tampered = JSON.parse(JSON.stringify(mandate));
    tampered.credentialSubject.spendingConstraints.maxAmount = 99999999;
    const tamperedVerification = await verifyMandateCredential(
      tampered,
      userWallet.signingKeyPair.jwk.public
    );
    expect(tamperedVerification.valid).toBe(false);
  });

  it('should enforce deterministic spending mandate bounds', async () => {
    const userWallet = createAgentIdentity('User Root', 'buyer');
    const buyerAgent = createAgentIdentity('Buyer', 'buyer');

    const mandate = await issueSpendingMandate({
      issuerIdentity: {
        did: userWallet.did,
        signingPrivateKeyJwk: userWallet.signingKeyPair.jwk.private,
      },
      subjectDID: buyerAgent.did,
      constraints: {
        maxAmount: 500000, // ₹5,000.00
        currency: 'INR',
        allowedCategories: ['cloud_services'],
        merchantWhitelist: ['did:key:z6MkApprovedMerchant'],
      },
    });

    // 1. Within limits and allowed category
    const validCheck = checkMandateBounds(
      mandate,
      350000,
      'cloud_services',
      'did:key:z6MkApprovedMerchant'
    );
    expect(validCheck.allowed).toBe(true);
    expect(validCheck.remainingAllowance).toBe(150000);

    // 2. Exceeding max amount
    const overLimitCheck = checkMandateBounds(
      mandate,
      600000,
      'cloud_services',
      'did:key:z6MkApprovedMerchant'
    );
    expect(overLimitCheck.allowed).toBe(false);
    expect(overLimitCheck.reason).toContain('exceeds mandate limit');

    // 3. Unauthorized category
    const badCategoryCheck = checkMandateBounds(
      mandate,
      100000,
      'gambling_crypto',
      'did:key:z6MkApprovedMerchant'
    );
    expect(badCategoryCheck.allowed).toBe(false);
    expect(badCategoryCheck.reason).toContain('not authorized');

    // 4. Unauthorized merchant
    const badMerchantCheck = checkMandateBounds(
      mandate,
      100000,
      'cloud_services',
      'did:key:z6MkAdversaryMerchant'
    );
    expect(badMerchantCheck.allowed).toBe(false);
    expect(badMerchantCheck.reason).toContain('not in authorized whitelist');
  });
});
