# ADR-008: Strict Finite State Machine (FSM) over Loose Event-Driven Architecture

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Protocol & Security Team  

## Context
Agent negotiation systems often use unstructured event emitters or message brokers where messages can arrive in arbitrary order. In high-stakes payment environments, this introduces critical vulnerabilities:
1. **Out-of-Order Execution:** An agent might request a payment signature before establishing a secure session or verifying the mandate.
2. **State Injection:** An attacker could inject a fake `PAYMENT_CONFIRMED` event directly into an event emitter without passing through the required DID exchange and quote agreement states.
3. **Audit Complexity:** Loose event pub-sub systems make it difficult to prove that a transaction strictly progressed through the required compliance and security checkpoints.

## Decision
We implement a **Strict Finite State Machine (FSM)** that governs the lifecycle of every agent-to-agent session:
```
INIT -> DID_EXCHANGED -> SESSION_ESTABLISHED -> MANDATE_VERIFIED -> CATALOG_RECEIVED -> INTENT_SENT -> QUOTE_RECEIVED -> SIGNED -> SETTLED
```
Any message received that does not conform to the valid transitions for the current state triggers an immediate fatal `ProtocolViolationError` and session termination.

## Consequences

### Positive
- **Guaranteed Invariant Enforcement:** Impossible to skip mandate validation or price quote agreement before triggering a payment handoff.
- **Mathematical Audit Trail:** Every transition is recorded with timestamp, prior state, next state, and cryptographic payload digest.
- **Explainable Failure Modes:** When a transaction fails, the exact state machine transition failure point is identified and displayed on the dashboard.

### Negative / Trade-offs
- **Linear Progression:** Complex non-linear multi-party negotiations require sub-state machine composition. For single Buyer-Merchant agent transactions, this linear FSM provides optimal security.
