# ADR-006: Ephemeral ECDH Sessions over Static Shared Secrets

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Cryptography & Privacy Team  

## Context
Agent-to-agent negotiations pass sensitive business information: customized pricing tiers, volume discounts, user identity mandates, and payment receipts.
- If agents communicate using long-term static pre-shared keys or static encryption keys, a future compromise of an agent's disk or memory would allow an adversary to decrypt all historical recorded network traffic (lack of Perfect Forward Secrecy).
- If traffic is transmitted in plaintext over TLS without mutual payload encryption, intermediate proxies, compromised load balancers, or server infrastructure can inspect and tamper with negotiation state.

## Decision
We mandate an **ephemeral Elliptic-Curve Diffie-Hellman (ECDH) key exchange over X25519** at the initiation of every agent session. All subsequent negotiation payloads are encrypted symmetrically using **AES-256-GCM** derived from the ephemeral shared secret.

## Consequences

### Positive
- **Perfect Forward Secrecy (PFS):** Even if an agent's master Ed25519 signing key or static keys are later extracted, previous negotiation sessions remain mathematically undecryptable.
- **End-to-End Payload Confidentiality:** The transport layer is protected end-to-end even if the transport layer (e.g. reverse proxy or WebSocket broker) terminates TLS.
- **Authenticated Encryption:** AES-256-GCM includes a 128-bit authentication tag (`authTag`), immediately detecting any in-flight bit modification.

### Negative / Trade-offs
- **Handshake Overhead:** Initial connection requires a 1-roundtrip key exchange before catalog exchange begins. This takes <2ms locally, well within performance budgets.
