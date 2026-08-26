# ADR-004: did:key Self-Certifying Identifiers over did:web / did:ethr

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Identity & Cryptography Team  

## Context
Autonomous agents require sovereign cryptographic identities (Decentralized Identifiers - DIDs) to authenticate without centralized OAuth servers or third-party identity providers.
- `did:web` relies on DNS resolution and HTTPS web hosting (`https://example.com/.well-known/did.json`), creating network dependencies, DNS hijacking vulnerabilities, and centralized server reliance.
- `did:ethr` requires blockchain RPC calls, gas fees, and block confirmation latency (seconds to minutes), which breaks sub-second autonomous agent checkout requirements.
- `did:key` is a self-certifying, deterministic DID method where the DID identifier itself contains the multicodec-encoded public key (e.g., `did:key:z6MkhaXg...`).

## Decision
We adopt **`did:key`** as the foundational DID method for all Buyer and Merchant Agents in AgentPay.

## Consequences

### Positive
- **Zero Network Lookups:** The DID document can be computed and verified entirely offline without DNS, HTTP servers, or blockchain nodes.
- **Sub-Millisecond Verification:** Zero network I/O latency enables instant agent-to-agent mutual authentication.
- **Cryptographic Immutability:** Because the public key is the identifier, it cannot be forged, spoofed, or redirected via DNS poisoning.

### Negative / Trade-offs
- **Key Rotation:** A `did:key` cannot rotate its underlying cryptographic key without changing the DID identifier itself. In our architecture, agent lifespan is bounded, and new keys simply generate new ephemeral or persistent DIDs, with long-term trust rooted in user-issued Verifiable Credentials (mandates).
