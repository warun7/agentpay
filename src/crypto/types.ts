/**
 * AgentPay Cryptographic Types
 */

export interface EncryptedPayload {
  ciphertext: string; // Hex-encoded
  iv: string;         // Hex-encoded initialization vector (12 bytes for GCM)
  authTag: string;    // Hex-encoded authentication tag (16 bytes for GCM)
}

export interface Ed25519JWK {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string; // Base64URL-encoded public key
  d?: string; // Base64URL-encoded private key (optional)
}

export interface X25519JWK {
  kty: 'OKP';
  crv: 'X25519';
  x: string; // Base64URL-encoded public key
  d?: string; // Base64URL-encoded private key (optional)
}

export type JWKKey = Ed25519JWK | X25519JWK;

export interface KeyPairResult {
  publicKeyJwk: JWKKey;
  privateKeyJwk: JWKKey;
  publicKeyBase64Url: string;
  publicKeyHex: string;
}

export interface DetachedJWS {
  protectedHeader: string;
  signature: string;
  compact: string;
}
