/**
 * CooL evidence for AgentPay checkouts (spike).
 *
 * AgentPay already produces a SHA-256 audit digest per settlement. That digest
 * proves nothing about ordering, omissions, or the decisions that led up to the
 * payment. This module seals each protocol decision as a CooL record:
 *
 *   - hybrid ML-DSA-65 + Ed25519 signature over the record
 *   - appended to an RFC 6962 Merkle log (inclusion proof in every receipt)
 *   - verifiable offline by anyone holding the party's published key directory
 *
 * What gets sealed (see CheckoutEventType): mandate verified/rejected, quote
 * issued (including the strategy-proposed vs protocol-applied discount), quote
 * signed/refused by the buyer's mandate gate, payment settled, and transaction
 * rejected at the merchant's gates. Denials are evidence too.
 *
 * Privacy: CooL never stores the plaintext. Each record commits to:
 *   state  = canonical JSON of the decision's terms (amounts, ids, reasons)
 *   input  = canonical JSON of the message the decision was made on
 *   output = canonical JSON of the message the decision produced
 * as salted hashes. The salt is stored in the receipt, so low-entropy terms are
 * guessable; every terms object therefore carries a high-entropy id (session,
 * quote, nonce) to keep guessing infeasible.
 *
 * Honesty: without TEE hardware CooL runs its simulator and labels attestation
 * `simulated`. That still gives tamper-evidence and ordering, but the operator
 * holds the signing key, so it does not stop the operator forging records. On
 * Phala TDX (set COOL_DSTACK_ENDPOINT) the key is sealed to the enclave.
 *
 * Simulator keys: cool-nwc's default local mode derives the signing key only
 * from public inputs (app name, a default image digest, and a fixed "cool"
 * seed), so anyone who knows the app id can derive the same key and forge
 * records that pass the signature check. This module therefore injects the
 * simulator with a secret root seed (COOL_SIM_SECRET, else random per process).
 *
 * Sealing is best-effort: a CooL failure is logged and never blocks a checkout.
 */
import { randomBytes } from 'node:crypto';
import { CooL, verifyEvidence, type Evidence, type KeyDirectory, type Verdict } from 'cool-nwc';
import {
  SimulatedDstackClient,
  disclose,
  verifyDisclosure,
  type Disclosure,
  type DisclosureVerdict,
} from 'cool-nwc/phala';

export type CheckoutParty = 'merchant' | 'buyer';

export type CheckoutEventType =
  | 'agentpay.mandate.verified'
  | 'agentpay.mandate.rejected'
  | 'agentpay.quote.issued'
  | 'agentpay.quote.signed'
  | 'agentpay.quote.refused'
  | 'agentpay.payment.settled'
  | 'agentpay.transaction.rejected';

export interface SealedCheckoutEvent {
  party: CheckoutParty;
  type: CheckoutEventType;
  executionId: string;
  recordId: string;
  /** The canonical JSON committed as the record's `state` field. Keep it to disclose later. */
  terms: string;
  evidence: Evidence;
}

export interface CheckoutEvidenceOptions {
  /** Inject a CooL client (tests, or a dstack-backed client on TEE hardware). */
  cool?: CooL;
  /** Called after every successful seal. */
  onSealed?: (event: SealedCheckoutEvent) => void;
}

/** JSON with recursively sorted keys, so the same terms always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Per-process fallback when COOL_SIM_SECRET is unset: keys change on restart. */
const PROCESS_SIM_SECRET = randomBytes(32).toString('hex');

/**
 * The CooL client for one party. On TEE hardware (COOL_DSTACK_ENDPOINT set) it
 * talks to the dstack guest agent. Otherwise it runs the simulator with a
 * SECRET root seed, so the signing key is not derivable from the app id.
 */
export function createCooLClient(party: CheckoutParty): CooL {
  const applicationId = `agentpay-${party}`;
  if (process.env.COOL_DSTACK_ENDPOINT) {
    return new CooL({ applicationId, attestation: { provider: 'dstack' } });
  }
  const secret = process.env.COOL_SIM_SECRET || PROCESS_SIM_SECRET;
  return new CooL({
    applicationId,
    dstackClient: new SimulatedDstackClient({
      appName: applicationId,
      imageDigest: process.env.COOL_IMAGE_DIGEST ?? 'sha256:unpinned-development-image',
      rootSeed: `${secret}:${party}`,
    }),
  });
}

/** One party's evidence log. Each agent runs its own, so neither can speak for the other. */
export class CheckoutEvidence {
  public readonly party: CheckoutParty;
  private readonly cool: CooL;
  private readonly sealed: SealedCheckoutEvent[] = [];
  private readonly onSealed?: (event: SealedCheckoutEvent) => void;

  constructor(party: CheckoutParty, options: CheckoutEvidenceOptions = {}) {
    this.party = party;
    this.cool = options.cool ?? createCooLClient(party);
    this.onSealed = options.onSealed;
  }

  /** Connect the evidence plane now (derives keys). `seal` does this on first use. */
  async ready(): Promise<void> {
    await this.cool.ready();
  }

  /**
   * Seal one checkout decision. Returns null (and warns) if CooL fails, so a
   * broken evidence plane never blocks a payment in this spike.
   */
  async seal(
    type: CheckoutEventType,
    executionId: string,
    terms: Record<string, unknown>,
    payloads: { input?: unknown; output?: unknown } = {}
  ): Promise<SealedCheckoutEvent | null> {
    const termsJson = canonicalJson({ party: this.party, event: type, ...terms });
    try {
      const { evidence, recordId } = await this.cool.record({
        type,
        executionId,
        metadata: { app: 'agentpay', party: this.party, event: type },
        payloads: {
          state: termsJson,
          input: payloads.input === undefined ? undefined : canonicalJson(payloads.input),
          output: payloads.output === undefined ? undefined : canonicalJson(payloads.output),
        },
      });
      const event: SealedCheckoutEvent = {
        party: this.party,
        type,
        executionId,
        recordId,
        terms: termsJson,
        evidence,
      };
      this.sealed.push(event);
      this.onSealed?.(event);
      return event;
    } catch (err: any) {
      console.warn(`[AgentPay] CooL seal failed for ${type} (continuing): ${err?.message ?? err}`);
      return null;
    }
  }

  /** Public keys a verifier pins. Publish these; never trust the keys inside a receipt. */
  get keyDirectory(): KeyDirectory {
    return this.cool.keyDirectory;
  }

  all(): readonly SealedCheckoutEvent[] {
    return [...this.sealed];
  }

  forExecution(executionId: string): SealedCheckoutEvent[] {
    return this.sealed.filter((e) => e.executionId === executionId);
  }

  async close(): Promise<void> {
    await this.cool.close();
  }
}

/** Key ids that signed this receipt: the record signature and the tree-head signature. */
export function signerKeyIds(evidence: Evidence): string[] {
  const r = evidence as any;
  return [r?.record?.signature?.key_id, r?.sth?.signature?.key_id].filter(
    (id): id is string => typeof id === 'string'
  );
}

/**
 * Overlay the verifier's trusted keys on the receipt's embedded directory.
 *
 * On its own this is what cool-nwc's `withTrustedKeys` does, and it is NOT a
 * pin: a receipt signed under a key id the verifier does not know keeps its own
 * embedded key and still verifies. `verifyCheckoutEvidence` adds the missing
 * half: every signer key id must be in the trusted directory. The embedded
 * simulator attestation root is kept; it only ever yields `simulated`.
 */
export function pinKeys(evidence: Evidence, trusted: KeyDirectory): Evidence {
  const r = evidence as any;
  return { ...r, key_directory: { ...(r?.key_directory ?? {}), ...trusted } } as Evidence;
}

export interface EvidenceCheck {
  recordId: string;
  type: string;
  ok: boolean;
  /** Signer key ids not in the trusted directory. Non-empty means rejected. */
  untrustedSigners: string[];
  verdict: Verdict;
}

/** Verify receipts offline against a party's pinned key directory. */
export async function verifyCheckoutEvidence(
  receipts: readonly Evidence[],
  trusted: KeyDirectory
): Promise<{ ok: boolean; checks: EvidenceCheck[] }> {
  const checks: EvidenceCheck[] = [];
  for (const receipt of receipts) {
    const verdict = await verifyEvidence(pinKeys(receipt, trusted));
    const untrustedSigners = signerKeyIds(receipt).filter((id) => !Object.hasOwn(trusted, id));
    const r = receipt as any;
    checks.push({
      recordId: r?.record?.record_id ?? 'unknown',
      type: r?.record?.event?.type ?? 'unknown',
      ok: verdict.ok && untrustedSigners.length === 0,
      untrustedSigners,
      verdict,
    });
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Open one record's terms (and only that record's) to an auditor or counterparty. */
export function discloseTerms(event: SealedCheckoutEvent): Disclosure {
  return disclose(event.evidence as any, 'state', event.terms);
}

/** Check a terms disclosure against its receipt. Verify the receipt itself first. */
export function checkTermsDisclosure(evidence: Evidence, disclosure: Disclosure): DisclosureVerdict {
  return verifyDisclosure(evidence as any, disclosure);
}
