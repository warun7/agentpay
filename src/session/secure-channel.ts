import { encryptPayload, decryptPayload } from '../crypto/encryption.js';
import type { SessionContext, WireEnvelope } from './types.js';

export interface SecureChannelOptions {
  /** Max |now − envelope.timestamp| skew tolerated. Default 2 minutes. */
  maxClockSkewMs?: number;
}

export class SecureChannel {
  private session: SessionContext;
  private localSequence = 0;
  private receivedSequences = new Set<number>();
  private readonly maxWindowSize = 1000;
  private readonly maxClockSkewMs: number;

  constructor(session: SessionContext, options: SecureChannelOptions = {}) {
    this.session = session;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 2 * 60 * 1000;
  }

  public getSession(): SessionContext {
    return this.session;
  }

  /**
   * Encrypts and wraps an application message into a WireEnvelope.
   */
  public packMessage(payload: object): WireEnvelope {
    this.localSequence += 1;
    this.session.messageCount += 1;

    const sequenceId = this.localSequence;
    const timestamp = new Date().toISOString();
    const aad = `${this.session.sessionId}:${sequenceId}:${timestamp}`;

    const encrypted = encryptPayload(payload, this.session.sessionKey, aad);

    return {
      version: '1.0',
      sessionId: this.session.sessionId,
      sequenceId,
      timestamp,
      encrypted: true,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
    };
  }

  /**
   * Unwraps, authenticates, and decrypts an incoming WireEnvelope.
   * Throws if authentication fails, sequence is replayed, or timestamp is invalid.
   */
  public unpackMessage<T = any>(envelope: WireEnvelope): T {
    // 1. Session ID validation
    if (envelope.sessionId !== this.session.sessionId) {
      throw new Error(`Session mismatch: received ${envelope.sessionId}, expected ${this.session.sessionId}`);
    }

    // 2. Anti-replay protection: check sequence monotonicity and duplicate sets
    if (this.receivedSequences.has(envelope.sequenceId)) {
      throw new Error(`Replay attack detected: duplicate sequenceId ${envelope.sequenceId}`);
    }

    if (envelope.sequenceId <= this.session.lastSequenceId && envelope.sequenceId !== 0) {
      throw new Error(`Out-of-order/replayed sequenceId: received ${envelope.sequenceId}, last ${this.session.lastSequenceId}`);
    }

    // 3. Timestamp freshness — AAD binding proves integrity of the timestamp
    // field, but only a wall-clock window proves it is RECENT (replay across
    // sessions or long-delayed capture is rejected here).
    const tsMs = Date.parse(envelope.timestamp);
    if (!Number.isFinite(tsMs)) {
      throw new Error(`Invalid envelope timestamp: ${envelope.timestamp}`);
    }
    const skew = Date.now() - tsMs;
    if (Math.abs(skew) > this.maxClockSkewMs) {
      throw new Error(
        `Stale/future envelope rejected: timestamp ${envelope.timestamp} outside ±${this.maxClockSkewMs / 1000}s clock-skew window`
      );
    }

    // 4. Decrypt and verify AES-256-GCM authentication tag
    if (envelope.encrypted) {
      if (!envelope.ciphertext || !envelope.iv || !envelope.authTag) {
        throw new Error('Encrypted envelope missing ciphertext, iv, or authTag');
      }

      const aad = `${envelope.sessionId}:${envelope.sequenceId}:${envelope.timestamp}`;
      const decrypted = decryptPayload<T>(
        {
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          authTag: envelope.authTag,
        },
        this.session.sessionKey,
        aad
      );

      // Update sequence tracking
      this.receivedSequences.add(envelope.sequenceId);
      this.session.lastSequenceId = envelope.sequenceId;

      // Clean window if needed
      if (this.receivedSequences.size > this.maxWindowSize) {
        const minToKeep = this.session.lastSequenceId - this.maxWindowSize / 2;
        for (const seq of this.receivedSequences) {
          if (seq < minToKeep) this.receivedSequences.delete(seq);
        }
      }

      return decrypted;
    }

    // Plaintext unwrap (for initial handshake only)
    this.receivedSequences.add(envelope.sequenceId);
    this.session.lastSequenceId = envelope.sequenceId;
    return envelope.payload as T;
  }
}
