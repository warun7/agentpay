import type { DIDDocument } from '../identity/types.js';

export interface SessionContext {
  sessionId: string;
  peerDID: string;
  peerDIDDocument: DIDDocument;
  sharedSecret: Buffer;
  sessionKey: Buffer; // AES-256-GCM symmetric key derived via HKDF
  createdAt: number;
  messageCount: number;
  lastSequenceId: number;
  isEstablished: boolean;
}

export interface WireEnvelope {
  version: string;
  sessionId: string;
  sequenceId: number;
  timestamp: string;
  encrypted: boolean;
  ciphertext?: string;
  iv?: string;
  authTag?: string;
  payload?: any; // Plaintext when encrypted=false
}
