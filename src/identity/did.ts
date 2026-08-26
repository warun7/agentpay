import crypto from 'node:crypto';
import { generateSigningKeyPair, generateEncryptionKeyPair } from '../crypto/keys.js';
import type { JWKKey, Ed25519JWK, X25519JWK } from '../crypto/types.js';
import type { DIDDocument, AgentIdentity } from './types.js';

// Base58 alphabet for multibase encoding (RFC 5869 / BTC58)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(buffer: Buffer): string {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
    digits[0] += buffer[i];
    let carry = 0;
    for (let j = 0; j < digits.length; j++) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; buffer[i] === 0 && i < buffer.length - 1; i++) {
    digits.push(0);
  }
  return digits.reverse().map((d) => ALPHABET[d]).join('');
}

/**
 * Derives a deterministic `did:key:z6Mk...` from an Ed25519 public key.
 * Uses W3C Multicodec prefix: 0xed, 0x01 (ed25519-pub) + 'z' multibase base58btc prefix.
 */
export function formatEd25519DID(publicKeyJwk: Ed25519JWK): string {
  const rawKeyBuffer = Buffer.from(publicKeyJwk.x, 'base64url');
  // Multicodec prefix for Ed25519 public key is 0xed01
  const multicodecKey = Buffer.concat([Buffer.from([0xed, 0x01]), rawKeyBuffer]);
  const base58Key = encodeBase58(multicodecKey);
  return `did:key:z${base58Key}`;
}

/**
 * Creates a standard W3C DID Document containing both Ed25519 signing key and X25519 key agreement key.
 */
export function createDIDDocument(
  signingPubKeyJwk: Ed25519JWK,
  encryptionPubKeyJwk: X25519JWK
): DIDDocument {
  const did = formatEd25519DID(signingPubKeyJwk);
  const signingKeyId = `${did}#key-1`;
  const encryptionKeyId = `${did}#key-2`;

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      'https://w3id.org/security/suites/x25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: signingKeyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyJwk: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: signingPubKeyJwk.x,
        },
      },
    ],
    authentication: [signingKeyId],
    assertionMethod: [signingKeyId],
    keyAgreement: [
      {
        id: encryptionKeyId,
        type: 'X25519KeyAgreementKey2020',
        controller: did,
        publicKeyJwk: {
          kty: 'OKP',
          crv: 'X25519',
          x: encryptionPubKeyJwk.x,
        },
      },
    ],
  };
}

/**
 * Resolves and extracts the signing public key and key agreement public key from a DID Document.
 */
export function extractKeysFromDIDDocument(didDocument: DIDDocument): {
  signingKeyJwk: JWKKey;
  encryptionKeyJwk: X25519JWK;
} {
  const signingMethod = didDocument.verificationMethod.find(
    (m) => m.type === 'Ed25519VerificationKey2020'
  );
  if (!signingMethod) {
    throw new Error(`DID Document ${didDocument.id} lacks an Ed25519VerificationKey2020 signing method`);
  }

  const agreementMethod = didDocument.keyAgreement?.find(
    (m) => m.type === 'X25519KeyAgreementKey2020'
  );
  if (!agreementMethod) {
    throw new Error(`DID Document ${didDocument.id} lacks an X25519KeyAgreementKey2020 key agreement method`);
  }

  return {
    signingKeyJwk: signingMethod.publicKeyJwk,
    encryptionKeyJwk: agreementMethod.publicKeyJwk,
  };
}

/**
 * Initializes a fully-provisioned autonomous Agent identity with sovereign keypairs and DID Document.
 */
export function createAgentIdentity(name: string, role: 'buyer' | 'merchant'): AgentIdentity {
  const signingKeyPair = generateSigningKeyPair();
  const encryptionKeyPair = generateEncryptionKeyPair();
  const didDocument = createDIDDocument(signingKeyPair.jwk.public, encryptionKeyPair.jwk.public);

  return {
    name,
    role,
    did: didDocument.id,
    didDocument,
    signingKeyPair,
    encryptionKeyPair,
  };
}
