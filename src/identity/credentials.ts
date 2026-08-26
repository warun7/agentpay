import { v4 as uuidv4 } from 'uuid';
import { signCompactJWS, verifyCompactJWS } from '../crypto/signatures.js';
import type { JWKKey } from '../crypto/types.js';
import type {
  VerifiableCredential,
  SpendingConstraints,
  MandateSubject,
} from './types.js';

export interface IssueMandateParams {
  issuerIdentity: {
    did: string;
    signingPrivateKeyJwk: JWKKey;
  };
  subjectDID: string;
  constraints: SpendingConstraints;
  validityDays?: number;
  userUpiId?: string;
  uapMandateCircleRef?: string;
}

/**
 * Issues an Ed25519-signed Verifiable Credential representing a user's delegated spending mandate.
 */
export async function issueSpendingMandate(
  params: IssueMandateParams
): Promise<VerifiableCredential> {
  const {
    issuerIdentity,
    subjectDID,
    constraints,
    validityDays = 7,
    userUpiId = 'user.primary@okhdfcbank',
    uapMandateCircleRef = `uap_circle_${uuidv4().substring(0, 8)}`,
  } = params;

  const now = new Date();
  const expires = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

  const credentialSubject: MandateSubject = {
    id: subjectDID,
    spendingConstraints: constraints,
    userUpiId,
    uapMandateCircleRef,
  };

  const unsignedClaims = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      'https://schema.org',
    ],
    id: `urn:uuid:${uuidv4()}`,
    type: ['VerifiableCredential', 'AgentSpendingMandate'],
    issuer: issuerIdentity.did,
    issuanceDate: now.toISOString(),
    expirationDate: expires.toISOString(),
    credentialSubject,
  };

  // Sign claims payload with Issuer's private key
  const jws = await signCompactJWS(unsignedClaims, issuerIdentity.signingPrivateKeyJwk, {
    kid: `${issuerIdentity.did}#key-1`,
  });

  return {
    ...unsignedClaims,
    proof: {
      type: 'Ed25519Signature2020',
      created: now.toISOString(),
      verificationMethod: `${issuerIdentity.did}#key-1`,
      jws,
    },
  };
}

/**
 * Cryptographically verifies a Verifiable Credential using the Issuer's public key.
 */
export async function verifyMandateCredential(
  vc: VerifiableCredential,
  issuerPublicKeyJwk: JWKKey
): Promise<{
  valid: boolean;
  expired: boolean;
  reason?: string;
}> {
  try {
    // 1. Verify JWS signature against Issuer's public key
    const { payload } = await verifyCompactJWS<any>(vc.proof.jws, issuerPublicKeyJwk);

    // 2. Cross-verify embedded claims match the signed payload
    if (
      payload.id !== vc.id ||
      payload.issuer !== vc.issuer ||
      JSON.stringify(payload.credentialSubject) !== JSON.stringify(vc.credentialSubject)
    ) {
      return { valid: false, expired: false, reason: 'Claims payload mismatch with cryptographic proof' };
    }

    // 3. Verify expiration date
    const expiry = new Date(vc.expirationDate).getTime();
    const now = Date.now();
    if (now > expiry) {
      return { valid: false, expired: true, reason: `Mandate expired on ${vc.expirationDate}` };
    }

    return { valid: true, expired: false };
  } catch (error: any) {
    return { valid: false, expired: false, reason: `Signature verification failed: ${error.message}` };
  }
}

/**
 * Cumulative spend ledger for daily limit enforcement.
 * Tracks per-subject-DID spend within rolling 24-hour windows.
 */
export class SpendLedger {
  private static instance: SpendLedger;
  private records = new Map<string, { amount: number; timestamp: number }[]>();
  /** Optional durable backing store — when set, spend survives restarts. */
  private static persistence: { recordSpend(d: string, a: number, t: number): void; loadSpendSince(ms: number): Array<{ subject_did: string; amount: number; timestamp: number }> } | null = null;

  static getInstance(): SpendLedger {
    if (!SpendLedger.instance) {
      SpendLedger.instance = new SpendLedger();
    }
    return SpendLedger.instance;
  }

  /** Attach durable storage (SQLite). Idempotent. */
  static setPersistence(store: NonNullable<typeof SpendLedger.persistence>): void {
    SpendLedger.persistence = store;
  }

  /** Reset the singleton (for testing) */
  static reset(): void {
    SpendLedger.instance = new SpendLedger();
  }

  /** Record a committed spend for a subject DID */
  recordSpend(subjectDID: string, amount: number): void {
    const ts = Date.now();
    if (!this.records.has(subjectDID)) {
      this.records.set(subjectDID, []);
    }
    this.records.get(subjectDID)!.push({ amount, timestamp: ts });
    SpendLedger.persistence?.recordSpend(subjectDID, amount, ts);
  }

  /** Get cumulative spend within the last 24 hours for a subject DID */
  getDailySpend(subjectDID: string): number {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);

    // Durable mode: SQLite is the source of truth (write-through above).
    if (SpendLedger.persistence) {
      return SpendLedger.persistence
        .loadSpendSince(twentyFourHoursAgo)
        .filter((r) => r.subject_did === subjectDID)
        .reduce((sum, r) => sum + r.amount, 0);
    }

    const entries = this.records.get(subjectDID);
    if (!entries) return 0;

    // Prune expired entries while we're here
    const activeEntries = entries.filter((e) => e.timestamp > twentyFourHoursAgo);
    this.records.set(subjectDID, activeEntries);

    return activeEntries.reduce((sum, e) => sum + e.amount, 0);
  }
}

/**
 * Deterministic bounds check: verifies that a requested transaction strictly conforms to the spending mandate constraints.
 * This is the deterministic firewall that guarantees money safety against prompt injections or agent misbehavior.
 *
 * Checks enforced:
 *   1. Per-transaction maxAmount
 *   2. Category allowlist
 *   3. Merchant whitelist
 *   4. Cumulative dailyLimit (rolling 24-hour window via SpendLedger)
 */
export function checkMandateBounds(
  vc: VerifiableCredential,
  requestedAmount: number,
  category: string,
  merchantDID?: string,
  currency?: string
): {
  allowed: boolean;
  reason?: string;
  remainingAllowance?: number;
} {
  const constraints = vc.credentialSubject.spendingConstraints;

  // 0. Currency enforcement — a mandate denominated in INR cannot settle USD.
  if (currency && currency !== constraints.currency) {
    return {
      allowed: false,
      reason: `Currency mismatch: requested '${currency}' but mandate allows only '${constraints.currency}'`,
    };
  }

  // 1. Amount limit check
  if (requestedAmount > constraints.maxAmount) {
    return {
      allowed: false,
      reason: `Requested amount (₹${requestedAmount / 100}) exceeds mandate limit (₹${constraints.maxAmount / 100})`,
    };
  }

  if (requestedAmount <= 0) {
    return {
      allowed: false,
      reason: `Requested amount must be greater than 0`,
    };
  }

  // 2. Category allowlist check
  if (
    constraints.allowedCategories.length > 0 &&
    !constraints.allowedCategories.includes('*') &&
    !constraints.allowedCategories.includes(category)
  ) {
    return {
      allowed: false,
      reason: `Category '${category}' is not authorized. Allowed categories: [${constraints.allowedCategories.join(', ')}]`,
    };
  }

  // 3. Merchant whitelist check
  if (
    merchantDID &&
    constraints.merchantWhitelist.length > 0 &&
    !constraints.merchantWhitelist.includes('*') &&
    !constraints.merchantWhitelist.includes(merchantDID)
  ) {
    return {
      allowed: false,
      reason: `Merchant DID '${merchantDID}' is not in authorized whitelist`,
    };
  }

  // 4. Daily cumulative limit check (Bug 3 + Bug 7 fix)
  if (constraints.dailyLimit !== undefined && constraints.dailyLimit > 0) {
    const subjectDID = vc.credentialSubject.id;
    const ledger = SpendLedger.getInstance();
    const currentDailySpend = ledger.getDailySpend(subjectDID);

    if (currentDailySpend + requestedAmount > constraints.dailyLimit) {
      return {
        allowed: false,
        reason: `Daily spend limit exceeded: current ₹${currentDailySpend / 100} + requested ₹${requestedAmount / 100} > daily limit ₹${constraints.dailyLimit / 100}`,
      };
    }
  }

  return {
    allowed: true,
    remainingAllowance: constraints.maxAmount - requestedAmount,
  };
}

