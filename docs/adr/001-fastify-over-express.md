# ADR-001: Fastify over Express for High-Throughput Agentic Commerce Engine

**Status:** Accepted  
**Date:** 2026-08-23  
**Deciders:** AgentPay Architecture Team  

## Context
Agent-to-agent autonomous commerce introduces high concurrency requirements:
1. Micro-negotiations happen continuously over WebSocket connections rather than sporadic human page clicks.
2. The server must process bidirectional JSON payloads, validate schemas, perform cryptographic verifications, and route payments with sub-millisecond overhead.
3. Node.js frameworks vary significantly in throughput and native TypeScript / JSON schema integration. Express has legacy overhead, no native TypeScript compilation, and requires third-party middleware for WebSockets and schema compilation.

## Decision
We chose **Fastify v5** with `@fastify/websocket` and built-in JSON schema compilation as the primary backend server framework.

## Consequences

### Positive
- **Throughput & Latency:** Fastify's radix-tree routing (`find-my-way`) and `fast-json-stringify` yield 2-3x higher requests per second compared to Express, critical for high-frequency agent negotiation.
- **First-Class TypeScript:** Native ESM and clean type bindings for route schemas, request headers, and WebSocket connections without fragile monkey-patching.
- **Built-in Schema Validation:** Native JSON Schema / Ajv integration at the network perimeter stops malformed payloads before they reach the agent business logic or cryptographic pipeline.
- **Structured Pino Logging:** Integrated high-performance structured JSON logging ensures tamper-evident audit trails.

### Negative / Trade-offs
- **Middleware Ecosystem:** Express has a larger ecosystem of legacy middleware, requiring Fastify-specific plugins (`@fastify/cors`, `@fastify/static`, `@fastify/websocket`).
- **Learning Curve:** Schema-first route definitions require strict upfront type modeling, though this aligns with our deterministic protocol security model.
