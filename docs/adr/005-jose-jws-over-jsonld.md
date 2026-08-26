# ADR-005: jose EdDSA JWS over JSON-LD Linked Data Proofs

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Architecture Team  

## Context
Verifiable Credentials (VCs) and signed transaction intents can be formatted using:
1. **JSON-LD Linked Data Proofs (W3C standard):** Uses RDF canonicalization (URDNA2015) and JSON-LD contexts. While expressive, canonicalization libraries are heavyweight, introduce large external dependency trees, and are prone to JSON parsing divergence in heterogeneous microservices.
2. **JSON Web Signatures (JWS - RFC 7515 / RFC 8037):** Compact or flattened detached signatures using Ed25519 (`EdDSA`). Audited, fast, compact, and natively supported across all payment gateways and JWT verifiers.

## Decision
We use standard **RFC 7515 / RFC 8037 JWS with EdDSA (Ed25519)** via the audited `jose` library to sign Verifiable Mandates and detached transaction commitments.

## Consequences

### Positive
- **Deterministic Canonicalization:** Simple stringified JSON payload normalization avoids complex RDF graph canonization bugs.
- **Compact Wire Format:** Compact JWS format (`header.payload.signature`) reduces WebSocket bandwidth by >60% compared to full JSON-LD document framing.
- **Interoperability:** Native compatibility with Razorpay headers, OAuth/OIDC infrastructure, and high-performance gateway verifiers.

### Negative / Trade-offs
- **Semantic Graph Contexts:** Does not retain deep RDF graph semantics from W3C JSON-LD suites, which is an acceptable trade-off given that payment mandates require strict, unambiguous schemas rather than open-world semantic graphs.
