import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server/index.js';
import { connectedClients } from '../src/server/websocket.js';
import type { FastifyInstance } from 'fastify';

/**
 * Phase 4 — Live WebSocket feed.
 * A fake WS client is registered directly into the broadcast set; a real
 * /api/demo/run must stream RUN_STARTED → FSM_TRANSITION* → RUN_COMPLETE,
 * all sharing one runId with monotonic sequence numbers.
 */

describe('Live WS feed broadcasts', () => {
  let app: FastifyInstance;
  let captured: any[] = [];

  beforeEach(async () => {
    process.env.PERSISTENCE = 'memory';
    process.env.NODE_ENV = 'test';
    process.env.RAZORPAY_MOCK_MODE = 'true';
    captured = [];
    const fakeSocket: any = {
      readyState: 1,
      send: (data: string) => captured.push(JSON.parse(data)),
    };
    connectedClients.add(fakeSocket);
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    for (const c of connectedClients) connectedClients.delete(c);
  });

  it('streams the full protocol run to connected dashboard clients', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/demo/run',
      payload: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    // Events arrived synchronously during the run
    const types = captured.map((e) => e.type);
    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('FSM_TRANSITION');
    // Growth-agent upsell rounds emit extra frames after RUN_COMPLETE
    expect(['RUN_COMPLETE', 'SETTLEMENT_CONFIRMED']).toContain(types[types.length - 1]);
    expect(types).toContain('RUN_COMPLETE');

    // Run-scoped events share ONE runId matching the response.
    // (SETTLEMENT_CONFIRMED is bus-level and intentionally unscoped.)
    const runEvents = captured.filter((e) => e.runId !== undefined);
    const runIds = new Set(runEvents.map((e) => e.runId));
    expect(runIds.size).toBe(1);
    expect(runEvents[0].runId).toBe(body.runId);

    // Monotonic seq per run
    const seqs = runEvents.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // FSM transitions walk the full happy path
    const states = captured
      .filter((e) => e.type === 'FSM_TRANSITION')
      .map((e) => e.payload.toState);
    expect(states).toContain('SESSION_ESTABLISHED');
    expect(states).toContain('MANDATE_VERIFIED');
    expect(states[states.length - 1]).toBe('SETTLED');

    // Settlement confirmation flows through the unified bus too
    expect(types).toContain('SETTLEMENT_CONFIRMED');
  });

  it('exposes gatewayMode + llm provider info via /api/identities', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.LLM_ENABLED = 'false';
    const res = await app.inject({ method: 'GET', url: '/api/identities' });
    const body = res.json();
    expect(body.gatewayMode).toBe('mock');
    expect(body.llmEnabled).toBe(false);
    process.env.LLM_ENABLED = undefined as any;
  });
});
