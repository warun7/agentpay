# Spike: CooL evidence for AgentPay checkouts

AgentPay's settlement receipt carries one SHA-256 audit digest:
`H(vcHash : jwsHash : orderId : paymentId : nonce)`. It proves the pieces of a
settled payment belong together. It says nothing about the order of decisions,
about decisions that were refused, or about records that were quietly dropped.

This spike seals each checkout decision into a [CooL](https://github.com/Northwind-Cipher/cool-sdk)
log (`cool-nwc@3.1.1`): a hybrid ML-DSA-65 + Ed25519 signature over each
record, appended to an RFC 6962 Merkle log, verifiable offline by anyone
holding the party's published keys.

## What gets sealed

Each agent runs **its own** log, so neither party can speak for the other.
Both use the ECDH session id (derived identically on both sides) as the CooL
execution id, so one checkout's records correlate across the two logs.

| Party | Event | When |
|---|---|---|
| merchant | `agentpay.mandate.verified` / `.rejected` | Mandate VC checked |
| merchant | `agentpay.quote.issued` | Quote signed; records the strategy's requested discount, the protocol-applied discount, and whether it was clamped |
| buyer | `agentpay.quote.signed` / `agentpay.quote.refused` | Quote-signature gate and mandate-bounds gate (refusals name the gate) |
| merchant | `agentpay.payment.settled` | After Razorpay settlement; includes the existing audit digest |
| merchant | `agentpay.transaction.rejected` | Any signed-transaction gate throws (signature, payload mismatch, DID, freshness, duplicate nonce) |

Plaintext never enters the receipt. Each record commits to salted hashes of:

- `state`: canonical JSON of the decision's terms (amounts, ids, reasons)
- `input` / `output`: the protocol messages the decision consumed and produced

## Run it

```bash
npm run demo:cool
npx vitest run tests/cool-evidence.test.ts
```

The demo runs a checkout and verifies every record offline against pinned keys.
It then shows a tampered record failing and a selective disclosure: true terms
pass and an inflated amount fails. Finally it shows an impostor log's forgery
failing under strict pinning, and a buyer's over-cap refusal sealed as evidence.

The server also exposes `GET /api/cool/keys` (the merchant's key directory) and
`GET /api/cool/evidence/:executionId`. `POST /api/demo/run` returns a
`coolEvidence` block with both parties' receipts and keys, and the live feed emits
a `COOL_EVIDENCE` event.

Set `COOL_EVIDENCE=off` to disable. Sealing is best-effort: a CooL failure is
logged and never blocks a payment.

| Env var | Effect |
|---|---|
| `COOL_EVIDENCE=off` | Disable sealing |
| `COOL_SIM_SECRET` | Secret root seed for the simulator. Unset means a random seed per process, so keys change on restart |
| `COOL_DSTACK_ENDPOINT` | Use a real Phala dstack guest agent (TEE) instead of the simulator |
| `COOL_IMAGE_DIGEST` | Image digest fed into the measurement |

## Verifying

`verifyCheckoutEvidence(receipts, trustedKeys)` runs CooL's offline verifier
after overlaying the party's published keys. It also requires every signer key
id (the record signature and the tree-head signature) to be in the trusted
directory. The overlay alone is what cool-nwc's `withTrustedKeys` does, and it
is not a pin (see below). The receipt's embedded simulator attestation root is
kept, because it can only ever produce `simulated`, never `pass`.

## Limits

- **Simulated attestation.** Without TEE hardware, CooL labels attestation
  `simulated`. You still get tamper-evidence and ordering, but the operator
  holds the signing key and could forge its own records. On Phala TDX the key
  is sealed to the enclave.
- **No witnesses.** A log can still withhold entries; external witnesses would
  detect forks, not omissions.
- **The salts are public.** They are stored in the receipt, so low-entropy terms
  are guessable. Every terms object includes a high-entropy id (session id,
  quote id, nonce) to make guessing infeasible.
- **Evidence lives in memory.** It is not persisted to the SQLite ledger yet,
  so it is lost on restart.

## Notes for upstream (cool-nwc 3.1.1)

All three were observed by `npm run demo:cool` and `tests/cool-evidence.test.ts`,
and the source for each is unchanged on `main` at 4.0.0.

1. **`withTrustedKeys` is not a pin.** It returns
   `{ ...receipt.key_directory, ...trusted }`, so trusted keys only override
   matching key ids. Key ids follow the image digest, so a build with a
   different digest signs under new ids, and its embedded keys survive the
   merge. Observed: a forged ₹1 settlement from
   `imageDigest: "sha256:attacker-build"` gives `ok=true` with
   `withTrustedKeys(forged, merchantKeys)`. Fix: also require the signer key ids
   to be in the trusted set.
2. **Default local mode derives keys from public inputs.** The simulator's
   `deriveKey` hashes the default root seed `"cool"`, the measurement (from app
   name and image digest) and the app id. Two independent
   `new CooL({ applicationId })` clients produce identical keys (observed:
   `true`), so anyone who knows the app id can produce records with
   `signature=pass`. Attestation correctly says `simulated`, but the signature
   domain reads as meaningful when it is not. The client exposes no `rootSeed`.
   This spike injects `SimulatedDstackClient` with a secret seed.
3. **Metadata disclosure always fails.** `disclose(receipt, "metadata", value)`
   hashes the UTF-8 string `value`, but metadata is committed as
   `saltedCommit(salt, canonicalCbor(metadata))`. Observed: it throws even when
   given the exact recorded metadata. This spike puts disclosable terms in the
   `state` payload instead.
