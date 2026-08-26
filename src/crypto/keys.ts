import crypto from 'node:crypto';
import type { JWKKey, Ed25519JWK, X25519JWK } from './types.js';

/**
 * Generates an Ed25519 keypair for cryptographic signing.
 */
export function generateSigningKeyPair(): {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  jwk: { public: Ed25519JWK; private: Ed25519JWK };
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as Ed25519JWK;
  const privateJwk = privateKey.export({ format: 'jwk' }) as Ed25519JWK;

  return {
    publicKey,
    privateKey,
    jwk: {
      public: publicJwk,
      private: privateJwk,
    },
  };
}

/**
 * Generates an X25519 keypair for ECDH ephemeral key agreement.
 */
export function generateEncryptionKeyPair(): {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  jwk: { public: X25519JWK; private: X25519JWK };
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as X25519JWK;
  const privateJwk = privateKey.export({ format: 'jwk' }) as X25519JWK;

  return {
    publicKey,
    privateKey,
    jwk: {
      public: publicJwk,
      private: privateJwk,
    },
  };
}

/**
 * Imports an Ed25519 or X25519 key from JWK format.
 */
export function importKeyFromJwk(jwk: JWKKey, isPrivate = false): crypto.KeyObject {
  if (isPrivate) {
    return crypto.createPrivateKey({
      key: jwk as any,
      format: 'jwk',
    });
  }
  return crypto.createPublicKey({
    key: jwk as any,
    format: 'jwk',
  });
}

/**
 * Performs Elliptic-Curve Diffie-Hellman (ECDH) key agreement using X25519.
 * Computes a 256-bit symmetric shared secret.
 */
export function deriveSharedSecret(
  localPrivateKey: crypto.KeyObject,
  peerPublicKey: crypto.KeyObject
): Buffer {
  return crypto.diffieHellman({
    privateKey: localPrivateKey,
    publicKey: peerPublicKey,
  });
}

/**
 * Derives an AES-256-GCM symmetric key from an ECDH shared secret using HKDF-SHA256.
 */
export function deriveSessionKey(
  sharedSecret: Buffer,
  salt: string = 'agentpay-session-salt-v1',
  info: string = 'agentpay-aes-256-gcm'
): Buffer {
  const derived = crypto.hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.from(salt, 'utf-8'),
    Buffer.from(info, 'utf-8'),
    32 // 32 bytes = 256 bits for AES-256
  );
  return Buffer.from(derived);
}

/**
 * Computes SHA-256 hash of any string/object payload.
 */
export function computeSha256(data: string | object): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(payload).digest('hex');
}
