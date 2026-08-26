import crypto from 'node:crypto';
import type { EncryptedPayload } from './types.js';

const GCM_IV_LENGTH = 12; // 96 bits standard for AES-GCM
const GCM_AUTH_TAG_LENGTH = 16; // 128 bits standard for AES-GCM

/**
 * Encrypts a plaintext string or object using AES-256-GCM.
 *
 * @param data Plaintext string or JSON-serializable object
 * @param key 256-bit (32 byte) symmetric encryption key
 * @param aad Optional Additional Authenticated Data
 */
export function encryptPayload(
  data: string | object,
  key: Buffer,
  aad?: string
): EncryptedPayload {
  const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
  const iv = crypto.randomBytes(GCM_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });

  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypts an AES-256-GCM encrypted payload and verifies the authentication tag.
 * Throws an Error if the ciphertext or authentication tag has been tampered with.
 *
 * @param payload EncryptedPayload containing ciphertext, iv, and authTag
 * @param key 256-bit (32 byte) symmetric encryption key
 * @param aad Optional Additional Authenticated Data
 */
export function decryptPayload<T = any>(
  payload: EncryptedPayload,
  key: Buffer,
  aad?: string
): T {
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTag);

  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  try {
    return JSON.parse(decrypted) as T;
  } catch {
    return decrypted as unknown as T;
  }
}
