import { describe, it, expect, afterEach } from 'vitest';
import { GeminiClient, GeminiTransportError } from '../src/ai/gemini-client.js';
import {
  OpenRouterClient,
  FailoverLLMClient,
  createLLMClientFromEnv,
  DEFAULT_OPENROUTER_MODEL,
} from '../src/ai/llm-failover.js';
import { GeminiBuyerStrategy } from '../src/ai/strategies/gemini-buyer.js';
import { DEFAULT_CATALOG } from '../src/agents/catalog-data.js';

/**
 * Multi-provider LLM failover — Gemini primary, OpenRouter (:free) secondary.
 * A demo must never die on a free-tier 429.
 */

const VALID_INTENT = {
  itemId: 'item_gpu_h100_cluster',
  quantity: 1,
  offeredUnitPrice: 320000,
  negotiationReason: 'Q3 workload',
  rationale: 'Best value within budget.',
};

function geminiStyleResponse(body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
}

function openRouterStyleResponse(body: unknown): Response {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe('FailoverLLMClient', () => {
  it('fails over to OpenRouter when Gemini is rate-limited (429)', async () => {
    let geminiCalls = 0;
    const deadGemini = new GeminiClient(
      { apiKey: 'k', model: 'm', timeoutMs: 500 },
      async () => { geminiCalls++; return new Response('{"error":"quota"}', { status: 429 }); }
    );
    const okRouter = new OpenRouterClient('k', 'free-model', 500, async () => openRouterStyleResponse(VALID_INTENT));

    const chain = new FailoverLLMClient([deadGemini, okRouter]);
    const strategy = new GeminiBuyerStrategy(chain);
    const result = await strategy.decideIntent(DEFAULT_CATALOG, 500000);

    expect(geminiCalls).toBe(1);
    expect(chain.activeProvider).toBe('openrouter');
    // Provider-labeled provenance — the trace shows WHO decided
    expect(result.source).toBe('llm-openrouter');
    expect(result.decision.itemId).toBe('item_gpu_h100_cluster');
  });

  it('is STICKY: skips the dead provider entirely on subsequent calls', async () => {
    let geminiCalls = 0;
    let routerCalls = 0;
    const deadGemini = new GeminiClient(
      { apiKey: 'k', model: 'm', timeoutMs: 500 },
      async () => { geminiCalls++; return new Response('{}', { status: 503 }); }
    );
    const okRouter = new OpenRouterClient('k', 'free-model', 500, async () => {
      routerCalls++;
      return openRouterStyleResponse(VALID_INTENT);
    });

    const chain = new FailoverLLMClient([deadGemini, okRouter]);
    await chain.generateJSON('p1', {});
    await chain.generateJSON('p2', {});
    await chain.generateJSON('p3', {});

    expect(geminiCalls).toBe(1);   // only the very first attempt touched it
    expect(routerCalls).toBe(3);
    expect(chain.name).toBe('openrouter');
  });

  it('throws after ALL providers fail (strategy then falls back deterministically)', async () => {
    const deadGemini = new GeminiClient(
      { apiKey: 'k', model: 'm', timeoutMs: 500 },
      async () => { throw new GeminiTransportError('down', 503); }
    );
    const deadRouter = new OpenRouterClient('k', 'm', 500, async () => {
      throw new GeminiTransportError('down', 503);
    });

    const chain = new FailoverLLMClient([deadGemini, deadRouter]);
    const strategy = new GeminiBuyerStrategy(chain);
    const result = await strategy.decideIntent(DEFAULT_CATALOG, 500000);

    expect(result.source).toBe('deterministic');
  });
});

describe('OpenRouterClient adapter', () => {
  it('parses OpenAI-style choices[].message.content', async () => {
    const client = new OpenRouterClient('k', 'free-model', 500, async () =>
      openRouterStyleResponse({ hello: 'world' })
    );
    const { raw } = await client.generateJSON('p', {});
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  it('strips markdown fences some free models emit despite JSON mode', async () => {
    const fenced = '```json\n{"cleaned":true}\n```';
    const client = new OpenRouterClient('k', 'free-model', 500, async () =>
      openRouterStyleResponse(fenced)
    );
    const { raw } = await client.generateJSON('p', {});
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ cleaned: true });
  });

  it('surfaces HTTP failures as typed transport errors', async () => {
    const client = new OpenRouterClient('k', 'free-model', 500, async () =>
      new Response('insufficient credits', { status: 402 })
    );
    await expect(client.generateJSON('p', {})).rejects.toBeInstanceOf(GeminiTransportError);
  });
});

describe('createLLMClientFromEnv matrix', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in savedEnv)) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  });

  it('returns null with no keys or disabled flag', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.LLM_ENABLED = 'false';
    expect(createLLMClientFromEnv()).toBeNull();

    delete process.env.LLM_ENABLED;
    expect(createLLMClientFromEnv()).toBeNull();
  });

  it('builds openrouter→gemini chain when both keys present (OpenRouter preferred)', () => {
    process.env.LLM_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'g';
    process.env.OPENROUTER_API_KEY = 'o';
    const chain = createLLMClientFromEnv()!;
    expect(chain.providerNames).toEqual(['openrouter', 'gemini']);
    expect(chain.activeModel).toContain(DEFAULT_OPENROUTER_MODEL); // benchmark-chosen default
  });

  it('works with OpenRouter alone', () => {
    process.env.LLM_ENABLED = 'true';
    delete process.env.GEMINI_API_KEY;
    process.env.OPENROUTER_API_KEY = 'o';
    const chain = createLLMClientFromEnv()!;
    expect(chain.providerNames).toEqual(['openrouter']);
    expect(chain.activeProvider).toBe('openrouter');
  });
});
