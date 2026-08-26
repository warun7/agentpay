# ADR-003: Deterministic Zod Schema Validation over LLM-Native Parsing

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Protocol Security Team  

## Context
Agentic commerce architectures frequently attempt to delegate negotiation and price agreement directly to LLM prompt responses (e.g. asking an LLM to generate or interpret checkout parameters). This opens critical attack vectors:
1. **Prompt Injection:** A malicious merchant prompt in product descriptions could trick a buyer LLM into transferring unlimited funds or signing exorbitant quotes.
2. **Hallucination & Type Coercion:** An LLM might output imprecise currency values, missing fields, or invalid decimal units.
3. **Non-Deterministic State Transitions:** LLM outputs cannot be mathematically verified in automated cryptographic audit trails.

## Decision
We enforce a strict separation of concerns:
- **LLMs are purely heuristic decision engines:** They decide *what* to buy based on user preferences.
- **The transaction pipeline is 100% deterministic:** Every message over the wire (catalog, intent, quote, signature payload) MUST validate against rigorous **Zod schemas** before cryptographic signing or state transition execution. If schema validation fails, the message is immediately dropped with a `ProtocolViolationError`.

## Consequences

### Positive
- **Prompt Injection Defense:** Malicious text payload injections cannot alter transaction amounts, UPI IDs, or mandate limits because the Zod parser enforces numeric bounds and exact regex patterns.
- **Explainable & Bounded State:** Every state transition is verifiable, schema-conforming, and logged in the immutable audit trail.
- **Compile-Time & Runtime Safety:** TypeScript types are inferred directly from Zod schemas (`z.infer<typeof ...>`), preventing schema drift.

### Negative / Trade-offs
- **Protocol Rigidity:** Protocol schema changes require version negotiation between agents.
- **LLM Output Structuring:** The LLM must output valid JSON conforming strictly to the schema, requiring structured output formatting or deterministic tooling wrappers.
