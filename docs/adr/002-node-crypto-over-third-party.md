# ADR-002: Native node:crypto over Third-Party Cryptographic Libraries

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Security & Cryptography Team  

## Context
Payment and financial settlement pipelines require zero-compromise cryptographic integrity. In the JavaScript/Node.js ecosystem, third-party libraries (e.g., `tweetnacl`, `noble-ed25519`, `elliptic`, or older JS implementations) introduce supply-chain vulnerabilities, unoptimized pure-JS math routines, and potential timing side-channel attacks.

Node.js v20+ includes native OpenSSL-backed implementations for:
- **Ed25519** (Edwards-curve Digital Signature Algorithm for unforgeable transaction signing)
- **X25519** (Montgomery curve Diffie-Hellman for ephemeral key agreement)
- **AES-256-GCM** (Galois/Counter Mode for authenticated symmetric payload encryption)
- **HMAC-SHA256** (for payment signature verification)

## Decision
We mandate using standard Node.js **`node:crypto`** as the exclusive low-level cryptographic primitive engine for key generation, key agreement (ECDH), symmetric encryption, and digest computation. We avoid third-party pure-JS crypto libraries.

## Consequences

### Positive
- **Supply Chain Hardening:** Zero third-party runtime dependencies for core key generation and elliptic-curve math eliminates npm package hijacking and malicious typo-squatting risks.
- **Timing Side-Channel Immunity:** Native OpenSSL C bindings ensure constant-time modular arithmetic and scalar multiplication.
- **Performance:** Hardware-accelerated AES-NI and vectorized curve math provide maximum throughput for high-frequency agent checkout loops.

### Negative / Trade-offs
- **Key Serialization Boilerplate:** Standard Node.js `KeyObject` requires explicit conversion to JWK / Multibase / Hex encodings for W3C DID document formatting, rather than automated high-level helper functions. We encapsulate these cleanly in `src/crypto/keys.ts`.
