# ADR-010: Nonce Idempotency Guard Before Settlement

**Status:** Accepted  
**Date:** 2026-08-25  
**Deciders:** AgentPay Payment Integrity Team  

## Context

In the original implementation, `handleSignedTransaction` forwarded signed payloads directly to the Razorpay gateway *before* persisting the transaction nonce. This created a critical window where a replayed `SIGNED_TRANSACTION` (caused by network retry, WebSocket reconnection, or an adversarial duplicate) would trigger a second `orders.create` call — debiting the user twice.

This is the classic **at-least-once delivery** problem: the transport layer (WebSocket) does not guarantee exactly-once semantics, so the application layer must enforce idempotency.

## Decision

We enforce **nonce-based idempotency at the top of `handleSignedTransaction`**, before any state transition or gateway call:

1. Before transitioning the FSM to `SIGNED`, the handler checks `transactionStore.has(signedTx.nonce)`.
2. If a record exists with a completed receipt, the handler returns the **cached receipt** immediately — zero gateway interaction, zero state change.
3. If a record exists without a receipt (in-flight), the handler throws a `DuplicateNonceError` to prevent concurrent double-processing.
4. Only if the nonce is unseen does the handler proceed with FSM transition and Razorpay settlement.

## Consequences

### Positive
- **Double-charge immunity:** Replayed transactions with the same UUID v4 nonce are caught and deflected before any money moves.
- **Idempotent API surface:** The same `SIGNED_TRANSACTION` can be safely retried by the buyer agent after a timeout without financial side effects.
- **Complements reconciliation:** Works in tandem with ADR-009's two-phase reconciliation — the buyer can reconnect and resubmit without risk.

### Negative / Trade-offs
- **In-memory store:** The current `transactionStore` is a `Map` — it does not survive process restarts. For production, this would need to be backed by a persistent store (Redis/PostgreSQL). Acceptable for hackathon scope.
- **Nonce collision:** UUID v4 collision probability is ~1 in 2^122 — effectively zero.
