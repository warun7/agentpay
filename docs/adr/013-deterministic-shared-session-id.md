# ADR-013: Deterministic Shared Session ID & Canonical HKDF Derivation

**Status:** Accepted
**Date:** 2026-08-25
**Phase:** 0b — SecureChannel Envelope Enforcement

## Context

Wiring `SecureChannel.packMessage`/`unpackMessage` into the live message path (closing Bug 4) exposed a latent handshake defect: `completeHandshake()` generated a **random `sessionId` per invocation** and used a **direction-dependent HKDF info string** (`tunnel-buyer->merchant` vs `tunnel-merchant->buyer`).

Consequence: the buyer and merchant each derived a *different* AES-256-GCM session key from the same ECDH shared secret. Any actual encrypted exchange between them would have failed authentication on the first frame. The defect was invisible because no code ever exchanged encrypted frames end-to-end.

## Decision

1. **Deterministic shared session ID.** Both parties compute
   `sess_ = "sess_" + sha256(sort(localDID, peerDID).join("|")).slice(0, 32)`.
   Sorting makes the derivation order-independent; both sides independently arrive at the identical session ID without any extra wire round-trip.
2. **Canonical HKDF parameters.** Salt is `agentpay-salt-${sessionId}`; info is
   `agentpay-tunnel-${sort(didA, didB).join("<->")}` — direction-independent, so both parties derive the *same* 256-bit key.

## Alternatives Considered

- **Initiator-proposed session ID in DID_EXCHANGE payload:** more explicit, but requires a schema change to `DIDExchangeSchema`, a protocol version bump, and trust-the-initiator reasoning. Rejected: self-derivation matches the self-certifying `did:key` philosophy and adds zero wire overhead.
- **Random session ID exchanged out-of-band:** reintroduces the original asymmetry problem.

## Consequences

- Buyer and merchant channels are now guaranteed-interoperable; verified by an explicit equality test (`tests/secure-envelope.test.ts`).
- Session IDs leak nothing beyond what DIDs already expose (SHA-256 of public identifiers).
- Existing raw/loopback callers are unaffected — the default parameter simply became deterministic.

## Verification

- `tests/secure-envelope.test.ts > derives IDENTICAL sessionId and sessionKey`
- Full pipeline runs with every post-handshake frame `encrypted: true`.
