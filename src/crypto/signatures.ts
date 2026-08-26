import crypto from 'node:crypto';
import * as jose from 'jose';
import type { JWKKey } from './types.js';

/**
 * Creates a JSON Web Signature (JWS) over a deterministic JSON payload using Ed25519 (EdDSA).
 *
 * @param payload Object or string to be signed
 * @param privateKeyJwk Ed25519 private key in JWK format
 */
export async function signDetachedJWS(
  payload: object | string,
  privateKeyJwk: JWKKey
): Promise<{ jws: string; payloadDigest: string }> {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const payloadDigest = crypto.createHash('sha256').update(payloadString).digest('hex');

  const privateKey = await jose.importJWK(privateKeyJwk, 'EdDSA');

  // Sign a standard Compact JWS
  const jws = await new jose.CompactSign(new TextEncoder().encode(payloadString))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: 'JWS',
    })
    .sign(privateKey);

  return {
    jws,
    payloadDigest,
  };
}

/**
 * Standard Compact JWS signature for payloads and Verifiable Credentials.
 */
export async function signCompactJWS(
  payload: object | string,
  privateKeyJwk: JWKKey,
  headerExtras: Record<string, any> = {}
): Promise<string> {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const privateKey = await jose.importJWK(privateKeyJwk, 'EdDSA');

  return await new jose.CompactSign(new TextEncoder().encode(payloadString))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: 'JWT',
      ...headerExtras,
    })
    .sign(privateKey);
}

/**
 * Verifies a Compact JWS against an Ed25519 public key JWK.
 * Returns the decoded payload if valid, throws if signature is invalid.
 */
export async function verifyCompactJWS<T = any>(
  jws: string,
  publicKeyJwk: JWKKey
): Promise<{ payload: T; protectedHeader: jose.CompactJWSHeaderParameters }> {
  const publicKey = await jose.importJWK(publicKeyJwk, 'EdDSA');
  const { payload, protectedHeader } = await jose.compactVerify(jws, publicKey);

  const decodedString = new TextDecoder().decode(payload);
  const decoded = JSON.parse(decodedString) as T;

  return {
    payload: decoded,
    protectedHeader,
  };
}

/**
 * Generates an HMAC-SHA256 signature for Razorpay verification.
 */
export function generateRazorpaySignature(
  orderId: string,
  paymentId: string,
  secret: string
): string {
  const body = `${orderId}|${paymentId}`;
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verifies Razorpay payment signature in constant time.
 */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): boolean {
  try {
    const expected = generateRazorpaySignature(orderId, paymentId, secret);
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');

    if (sigBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Computes the Razorpay WEBHOOK signature: HMAC-SHA256 over the RAW request
 * body bytes using the webhook secret. This is how Razorpay signs
 * `X-Razorpay-Signature` on every webhook delivery.
 */
export function generateWebhookSignature(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies a webhook delivery's `X-Razorpay-Signature` header against the raw
 * body in CONSTANT TIME. Signature verification MUST use the exact raw bytes
 * as received — re-serializing parsed JSON changes byte order and breaks HMAC.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }
  try {
    const expected = generateWebhookSignature(rawBody, secret);
    const sigBuf = Buffer.from(signatureHeader, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
