import {
  importKeyFromJwk,
  deriveSharedSecret,
  deriveSessionKey,
  computeSha256,
} from '../crypto/keys.js';
import { extractKeysFromDIDDocument } from '../identity/did.js';
import type { AgentIdentity, DIDDocument } from '../identity/types.js';
import type { SessionContext } from './types.js';

/**
 * Deterministically derives a shared session ID from both parties' DIDs.
 * Both buyer and merchant independently compute the SAME sessionId,
 * which salts the HKDF key derivation identically on both sides.
 */
export function deriveSharedSessionId(didA: string, didB: string): string {
  const [low, high] = [didA, didB].sort();
  const digest = computeSha256(`${low}|${high}`);
  return `sess_${digest.substring(0, 32)}`;
}

/**
 * Creates the initial handshake payload containing the agent's DID document.
 */
export function createHandshakePayload(identity: AgentIdentity): {
  type: 'DID_EXCHANGE';
  agentRole: 'buyer' | 'merchant';
  did: string;
  didDocument: DIDDocument;
} {
  return {
    type: 'DID_EXCHANGE',
    agentRole: identity.role,
    did: identity.did,
    didDocument: identity.didDocument,
  };
}

/**
 * Executes the mutual ECDH key agreement with a peer agent's DID Document.
 * Derives a 256-bit symmetric session key with Perfect Forward Secrecy.
 */
export function completeHandshake(
  localIdentity: AgentIdentity,
  peerDIDDocument: DIDDocument,
  sessionId = deriveSharedSessionId(localIdentity.did, peerDIDDocument.id)
): SessionContext {
  // 1. Extract peer's X25519 key agreement public key from their DID Document
  const { encryptionKeyJwk } = extractKeysFromDIDDocument(peerDIDDocument);
  const peerPublicKey = importKeyFromJwk(encryptionKeyJwk, false);

  // 2. Perform ECDH: local X25519 private key + peer X25519 public key
  const localPrivateKey = importKeyFromJwk(localIdentity.encryptionKeyPair.jwk.private, true);
  const sharedSecret = deriveSharedSecret(localPrivateKey, peerPublicKey);

  // 3. Derive 256-bit AES-256-GCM symmetric session key via HKDF.
  //    Salt and info are canonical (direction-independent) so BOTH parties
  //    independently derive the identical session key.
  const sessionKey = deriveSessionKey(
    sharedSecret,
    `agentpay-salt-${sessionId}`,
    `agentpay-tunnel-${[localIdentity.did, peerDIDDocument.id].sort().join('<->')}`
  );

  return {
    sessionId,
    peerDID: peerDIDDocument.id,
    peerDIDDocument,
    sharedSecret,
    sessionKey,
    createdAt: Date.now(),
    messageCount: 0,
    lastSequenceId: 0,
    isEstablished: true,
  };
}
