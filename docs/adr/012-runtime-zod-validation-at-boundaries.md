# ADR-012: Runtime Zod Validation at All Handler Boundaries

**Status:** Accepted  
**Date:** 2026-08-25  
**Deciders:** AgentPay Protocol Security Team  

## Context

The Zod schemas in `src/protocol/schemas.ts` served as the project's "deterministic firewall" — the foundational claim that no malformed or hallucinated payload could enter the payment pipeline. However, these schemas were only exercised in unit tests and the chaos fuzzer. The actual message handlers in `merchant-agent.ts` accepted pre-typed TypeScript interfaces, and the HTTP routes in `routes.ts` used raw `request.body as any`.

This meant the schemas were **documentation**, not **enforcement**. A prompt-injected payload, a malformed WebSocket frame, or a tampered HTTP request body would bypass schema validation entirely and reach the FSM, signature verification, and payment gateway.

This gap directly contradicts the security claims in `SECURITY.md` (ATTACK-002: Prompt Injection) and the architecture thesis of ADR-003 (Zod over LLM-native parsing).

## Decision

All inbound message handlers now accept `unknown` and call `Schema.parse(rawMessage)` as their **first operation**, before any FSM transition or business logic:

```typescript
// Before (typed but unvalidated)
handleDIDExchange: (buyerMessage: DIDExchangeMessage): DIDExchangeMessage => { ... }

// After (runtime-validated at boundary)
handleDIDExchange: (rawMessage: unknown): DIDExchangeMessage => {
  const buyerMessage = DIDExchangeSchema.parse(rawMessage);
  ...
}
```

HTTP route entry points use `safeParse` for user-facing error messages:

```typescript
const parsed = DemoRunRequestSchema.safeParse(request.body || {});
if (!parsed.success) {
  reply.status(400);
  return { success: false, validationErrors: parsed.error.flatten().fieldErrors };
}
```

## Consequences

### Positive
- **Defense in depth is real:** The Zod firewall now operates at the actual trust boundary, not just in tests. SECURITY.md's ATTACK-002 mitigation is now literally enforced.
- **LLM-proof:** When the Gemini strategy layer (Phase 1) is added, LLM-generated payloads will hit the Zod wall before reaching any crypto or payment code.
- **Fail-fast:** Malformed payloads throw `ZodError` with structured field-level diagnostics immediately, rather than propagating as cryptic downstream failures.

### Negative / Trade-offs
- **Double validation in tests:** Test code that constructs well-typed messages now has those messages re-parsed at the handler boundary. The overhead is sub-microsecond per call (benchmarked at ~0.002ms in the chaos fuzzer), so this is negligible.
- **Slightly larger handler signatures:** Accepting `unknown` instead of typed interfaces reduces IDE autocompletion at call sites. Mitigated by the exported type aliases remaining available for callers.
