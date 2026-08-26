# ADR-007: Dual-Mode Razorpay Gateway (Live SDK + Deterministic Sandbox Simulator)

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Payments Integration Team  

## Context
Deploying and demonstrating agentic commerce products during hackathons and reviews requires resilience:
1. Live network calls to Razorpay Sandbox APIs require active internet access, valid API keys (`rzp_test_...`), and are subject to third-party rate limits and downtime.
2. The NPCI UAP / UPI Reserve Pay API spec involves metadata parameters (such as Circle delegation and mandate proofs) currently transitioning across pilot sandbox environments.
3. Reviewers and judges need to test the pipeline deterministically and reliably with zero manual key setup, while retaining the exact live Razorpay SDK signatures and HMAC-SHA256 verification.

## Decision
We implement a **Dual-Mode Razorpay Gateway Adapter**:
- If `RAZORPAY_MOCK_MODE=false` and valid credentials are provided, the system executes live REST calls via the official `razorpay` Node.js SDK.
- If in mock mode (default or fallback), the system uses an in-memory deterministic simulation engine that mirrors the exact Razorpay Order creation response schema, receipt generation, and real HMAC-SHA256 signature verification.

## Consequences

### Positive
- **Zero-Friction Evaluation:** Judges can clone the repo and run `npm run demo` or start the server without registering for a Razorpay account first.
- **Production Parity:** The mock adapter implements the exact same TypeScript interface and cryptographic signature verification routine as the live SDK adapter.
- **Flawless Demo Experience:** Zero dependency on external network latency or sandbox downtime during presentations.

### Negative / Trade-offs
- Maintaining two adapter branches requires interface synchronization tests (covered in `tests/payment.test.ts`).
