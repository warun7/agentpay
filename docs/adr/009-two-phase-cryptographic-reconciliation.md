# ADR-009: Two-Phase Cryptographic Reconciliation for Distributed Payment Atomicity

**Status:** Accepted  
**Date:** 2026-08-25  
**Deciders:** AgentPay Distributed Systems & Financial Engineering Team  

## Context
In distributed payment architectures, network partitions or process crashes can occur at the settlement boundary after a transaction is signed and captured:
1. The Buyer Agent signs a detached Ed25519 JWS commitment and transmits `SIGNED_TRANSACTION` over the WebSocket.
2. The Merchant Agent submits the proof bundle to Razorpay UPI Reserve Pay / UAP and the payment is successfully debited (`CAPTURED`).
3. Before the Merchant Agent can deliver `SETTLEMENT_RECEIPT` back to the Buyer, the network drops, WebSocket frame is lost, or the connection resets.

In standard architectures, this leads to a split-brain failure:
- The user has been charged on UPI, but the Buyer Agent believes the transaction timed out or failed.
- If the Buyer blindly retries, it risks a duplicate charge. If it abandons the session, the user is debited without receipt or goods.

## Decision
We implement an **Autonomous Two-Phase Cryptographic Reconciliation & Dispute Resolution Loop**:
1. If the Buyer Agent fails to receive a `SETTLEMENT_RECEIPT` within $T_{\text{ack}}$ (e.g. 3,000ms), it transitions its state machine to `RECONCILING` and re-establishes connection.
2. The Buyer Agent generates and transmits a cryptographically signed `RECONCILIATION_CHALLENGE` containing the original `transactionId`, `quoteId`, and `originalNonce`.
3. The Merchant Agent verifies the Buyer's signature and queries its persistent transaction store:
   - **Scenario 1 (Payment Captured):** Returns a signed `RECONCILIATION_PROOF` with `status: 'SETTLED'` and the original `SETTLEMENT_RECEIPT` (with Razorpay Order & Payment ID and audit digest). The Buyer synchronizes its state to `SETTLED`.
   - **Scenario 2 (Payment Not Processed / Failed):** Issues a cryptographically signed **Void Certificate** (`VOID_PROOF`) with `status: 'VOIDED'`, allowing the Buyer to transition to `ABORTED` with mathematical certainty that no charge cleared.

## Consequences

### Positive
- **Guaranteed Settlement Atomicity:** Eliminates split-brain state divergence across unreliable agent networks without requiring centralized two-phase commit (2PC) locks.
- **Idempotency & Double-Charge Immunity:** Replays and duplicate submissions with the same nonce are reconciled against the single original order.
- **Cryptographic Dispute Defense:** Both resolution outcomes (`SETTLED` receipt replay or `VOID_PROOF` certificate) are signed with Ed25519 private keys, creating tamper-evident dispute evidence for NPCI or payment gateways.

### Negative / Trade-offs
- **Reconnection Latency:** Recovering from dropped frames requires 1 additional request-response cycle on reconnect before state resolution.
