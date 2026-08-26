import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  deriveSharedSecret,
  deriveSessionKey,
} from '../src/crypto/keys.js';
import { encryptPayload, decryptPayload } from '../src/crypto/encryption.js';
import {
  signDetachedJWS,
  verifyCompactJWS,
  generateRazorpaySignature,
  verifyRazorpaySignature,
} from '../src/crypto/signatures.js';

describe('Crypto Core Engine', () => {
  it('should generate valid Ed25519 and X25519 keypairs', () => {
    const signing = generateSigningKeyPair();
    expect(signing.jwk.public.kty).toBe('OKP');
    expect(signing.jwk.public.crv).toBe('Ed25519');

    const encryption = generateEncryptionKeyPair();
    expect(encryption.jwk.public.kty).toBe('OKP');
    expect(encryption.jwk.public.crv).toBe('X25519');
  });

  it('should perform mutual ECDH and derive identical symmetric session keys', () => {
    const alice = generateEncryptionKeyPair();
    const bob = generateEncryptionKeyPair();

    const aliceSecret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bobSecret = deriveSharedSecret(bob.privateKey, alice.publicKey);

    expect(aliceSecret.equals(bobSecret)).toBe(true);

    const aliceSessionKey = deriveSessionKey(aliceSecret, 'salt', 'agentpay');
    const bobSessionKey = deriveSessionKey(bobSecret, 'salt', 'agentpay');

    expect(aliceSessionKey.equals(bobSessionKey)).toBe(true);
  });

  it('should encrypt and decrypt payloads with AES-256-GCM and verify auth tag integrity', () => {
    const key = generateEncryptionKeyPair();
    const secret = deriveSharedSecret(key.privateKey, key.publicKey);
    const sessionKey = deriveSessionKey(secret);

    const data = { action: 'BUY', amount: 350000, currency: 'INR' };
    const aad = 'session_123:seq_1';

    const encrypted = encryptPayload(data, sessionKey, aad);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toHaveLength(24); // 12 bytes hex
    expect(encrypted.authTag).toHaveLength(32); // 16 bytes hex

    const decrypted = decryptPayload<typeof data>(encrypted, sessionKey, aad);
    expect(decrypted).toEqual(data);

    // Tampering test: modify one bit in ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.substring(0, 4) + 'ff' + encrypted.ciphertext.substring(6),
    };
    expect(() => decryptPayload(tampered, sessionKey, aad)).toThrow();
  });

  it('should sign and verify Ed25519 JWS payloads', async () => {
    const signer = generateSigningKeyPair();
    const payload = { transactionId: 'txn_123', amount: 50000 };

    const { jws } = await signDetachedJWS(payload, signer.jwk.private);
    expect(jws).toBeDefined();

    const { payload: verified } = await verifyCompactJWS<typeof payload>(jws, signer.jwk.public);
    expect(verified.transactionId).toBe('txn_123');
    expect(verified.amount).toBe(50000);
  });

  it('should verify Razorpay HMAC-SHA256 signatures in constant time', () => {
    const secret = 'test_secret_key_12345';
    const orderId = 'order_RZP123';
    const paymentId = 'pay_RZP456';

    const sig = generateRazorpaySignature(orderId, paymentId, secret);
    expect(verifyRazorpaySignature(orderId, paymentId, sig, secret)).toBe(true);
    expect(verifyRazorpaySignature(orderId, paymentId, 'bad_signature_hex_00', secret)).toBe(false);
  });
});
