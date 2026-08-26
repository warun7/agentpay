import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server/index.js';
import type { FastifyInstance } from 'fastify';

/**
 * Phase 2 — Conversational checkout (offline/deterministic mode).
 * LLM env vars are absent under vitest, so goal extraction uses the
 * heuristic parser and strategies are deterministic — the full encrypted
 * pipeline still runs end-to-end.
 */

describe('POST /api/chat — conversational checkout', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PERSISTENCE = 'memory';
    process.env.NODE_ENV = 'test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLM_ENABLED;
    app = await buildServer();
  });

  const chat = (message: string, sessionId?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message, ...(sessionId ? { sessionId } : {}) },
      headers: { 'Content-Type': 'application/json' },
    });

  it('settles a purchase end-to-end from natural language', async () => {
    const res = await chat('Buy GPU hours for a weekend fine-tuning run');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeDefined();

    const kinds = body.transcript.map((e: any) => e.kind);
    expect(kinds).toContain('GOAL_PARSED');
    expect(kinds).toContain('INTENT');
    expect(kinds).toContain('QUOTE');
    expect(kinds).toContain('SIGNED');
    expect(kinds).toContain('SETTLED');

    expect(body.purchase.razorpayOrderId).toMatch(/^order_/);
    expect(body.budget.spentPaise).toBeGreaterThan(0);
    expect(body.budget.remainingPaise).toBeLessThan(body.budget.capPaise);
  });

  it('reuses the session for follow-up purchases and decrements budget', async () => {
    const first = await chat('Buy GPU hours for inference');
    const { sessionId } = first.json();

    const second = await chat('Get me the managed vector database', sessionId);
    const body = second.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(sessionId);
    expect(body.purchase).not.toBeNull();

    // Two purchases + one growth-agent upsell round = 3 settlements
    const settledCount = body.transcript.filter((e: any) => e.kind === 'SETTLED').length;
    expect(settledCount).toBe(3);

    const getRes = await app.inject({ method: 'GET', url: `/api/chat/${sessionId}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().purchases.length).toBe(3);
  });

  it('ENFORCES the mandate guardrail when nothing affordable fits (bounded & gated)', async () => {
    // ₹300 cap → even the cheapest SKU (~₹464 settled) exceeds it → HARD OVERRIDE
    const res = await chat('Order something cheap under ₹300');
    const body = res.json();

    expect(body.ok).toBe(true);           // round handled gracefully
    expect(body.purchase).toBeNull();     // nothing settled
    expect(body.transcript.map((e: any) => e.kind)).toContain('REJECTED');

    const rejected = body.transcript.find((e: any) => e.kind === 'REJECTED');
    // Deterministic strategy rejects pre-emptively; LLM strategies get HARD-OVERRIDE-flipped.
    expect(rejected.rationale).toMatch(/exceeds mandate cap|HARD OVERRIDE/);

    // Budget untouched
    expect(body.budget.spentPaise).toBe(0);
  });

  it('downshifts to an affordable item when a budget cap allows it', async () => {
    // ₹1,500 cap excludes the H100 cluster but fits the A100 node
    const res = await chat('We need an A100 node, keep it under ₹1500 please');
    const body = res.json();

    expect(body.ok).toBe(true);
    expect(body.purchase).not.toBeNull();
    expect(body.purchase.amount).toBeLessThanOrEqual(150000); // ≤ ₹1,500 in paise

    const intentEvt = body.transcript.find((e: any) => e.kind === 'INTENT');
    expect(intentEvt.title).toContain('A100');
  });

  it('responds with guidance to non-purchase messages', async () => {
    const baseline = await chat('Buy GPU hours for inference');
    const settledBefore = baseline.json().transcript.filter((e: any) => e.kind === 'SETTLED').length;

    const res = await chat('hello there, how is the weather?', baseline.json().sessionId);
    const body = res.json();

    expect(body.ok).toBe(true);
    expect(body.purchase).toBeNull();
    expect(body.transcript.map((e: any) => e.kind)).toContain('GUIDANCE');
    const settledAfter = body.transcript.filter((e: any) => e.kind === 'SETTLED').length;
    expect(settledAfter).toBe(settledBefore);
  });

  it('rejects malformed request bodies with validation errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: '' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('GET returns 404 for unknown sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
  });
});
