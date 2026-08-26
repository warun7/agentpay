import type { GeminiTransport } from './gemini-client.js';
import { GeminiClient, GeminiTransportError, DEFAULT_TIMEOUT_MS, DEFAULT_MODEL } from './gemini-client.js';

/**
 * Multi-provider LLM layer with automatic failover.
 *
 * Why: free-tier Gemini rate limits (429s) would wreck a live demo. OpenRouter
 * exposes OpenAI-compatible `:free` models — a perfect secondary provider.
 *
 * Design: FailoverLLMClient implements the SAME generateJSON(prompt, schema,
 * systemInstruction) surface as GeminiClient, so every strategy (buyer,
 * merchant, goal-extractor) works unchanged across providers.
 *
 * Failover semantics:
 *   - Any transport error (429/5xx/timeout/network) advances to the next
 *     provider for THIS call and marks it sticky-preferred for future calls.
 *   - Schema validation failures are NOT failover triggers — the firewall's
 *     repair loop owns those (provider-agnostic).
 */

/** Minimal contract both adapters satisfy. */
export interface LLMProvider {
  readonly name: string;
  /** Human-readable provider:model identifier for UI/status surfaces. */
  readonly modelLabel?: string;
  generateJSON(
    prompt: string,
    responseSchema: object,
    systemInstruction?: string
  ): Promise<{ raw: string }>;
}

// ── OpenRouter adapter (OpenAI-compatible chat completions) ─────────────────

/**
 * Default OpenRouter model — chosen by live benchmark (docs/DEMO_GUIDE.md):
 * tasks here are slot-fill + small JSON, so the fastest VALID emitter wins.
 * lfm-2.5-2.6b: 5.9s, 2/2 schema-valid vs ox-alpha 27.9s, 1/2 + timeouts.
 * Override with OPENROUTER_MODEL if this ever degrades.
 */
export const DEFAULT_OPENROUTER_MODEL = 'liquid/lfm-2.5-2.6b:free';

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenRouterClient implements LLMProvider {
  readonly name = 'openrouter';
  readonly modelLabel: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url = 'https://openrouter.ai/api/v1/chat/completions';

  constructor(
    apiKey: string,
    model: string = DEFAULT_OPENROUTER_MODEL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly transport: GeminiTransport = ((url, init) => fetch(url, init))
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.modelLabel = `openrouter:${model}`;
  }

  async generateJSON(
    prompt: string,
    responseSchema: object,
    systemInstruction?: string
  ): Promise<{ raw: string }> {
    // Most :free models lack native structured output; we embed the schema in
    // the prompt AND request JSON mode. The Zod firewall remains the real gate.
    const schemaHint = `\n\nRespond with ONLY a single valid JSON object matching this shape:\n${JSON.stringify(responseSchema)}`;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction + schemaHint });
    }
    messages.push({ role: 'user', content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Title': 'AgentPay Agentic Checkout',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new GeminiTransportError(
          `OpenRouter API error ${response.status}: ${detail.slice(0, 300)}`,
          response.status
        );
      }

      const data = (await response.json()) as OpenAIChatResponse;
      const raw = data.choices?.[0]?.message?.content;
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new GeminiTransportError('OpenRouter returned an empty completion');
      }

      // Strip accidental markdown fences some models emit despite JSON mode
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      return { raw: cleaned };
    } catch (err: any) {
      if (err instanceof GeminiTransportError) throw err;
      if (err.name === 'AbortError') {
        throw new GeminiTransportError(`OpenRouter call timed out after ${this.timeoutMs}ms`);
      }
      throw new GeminiTransportError(`OpenRouter transport failure: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Failover chain ───────────────────────────────────────────────────────────

export class FailoverLLMClient implements LLMProvider {
  /** Provider that served the most recent successful call. */
  public activeProvider: string;

  /** LLMProvider contract: reports whichever provider is currently serving. */
  get name(): string {
    return this.activeProvider;
  }

  constructor(
    public readonly providers: LLMProvider[],
    private readonly onFailover?: (from: string, to: string, error: Error) => void
  ) {
    if (providers.length === 0) {
      throw new Error('FailoverLLMClient requires at least one provider');
    }
    this.activeProvider = providers[0].name;
  }

  get providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** e.g. "openrouter:stealth/ox-alpha" for the currently-serving provider. */
  get activeModel(): string {
    const active = this.providers.find((p) => p.name === this.activeProvider);
    return active?.modelLabel ?? this.activeProvider;
  }

  async generateJSON(
    prompt: string,
    responseSchema: object,
    systemInstruction?: string
  ): Promise<{ raw: string }> {
    // Sticky preference: start from whichever provider last succeeded.
    const preferredIdx = Math.max(
      0,
      this.providers.findIndex((p) => p.name === this.activeProvider)
    );

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const idx = (preferredIdx + attempt) % this.providers.length;
      const provider = this.providers[idx];
      try {
        const result = await provider.generateJSON(prompt, responseSchema, systemInstruction);
        this.activeProvider = provider.name;
        return result;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.providers.length - 1 && this.onFailover) {
          const next = this.providers[(idx + 1) % this.providers.length];
          this.onFailover(provider.name, next.name, lastError);
        }
      }
    }

    throw lastError ?? new GeminiTransportError('All LLM providers failed');
  }
}

// ── Environment factory ─────────────────────────────────────────────────────

/**
 * Builds the best-configured provider chain from environment variables.
 *
 * Priority: Gemini first (native structured output), OpenRouter as fallback;
 * either alone works; none → null (deterministic strategies take over).
 */
export function createLLMClientFromEnv(): FailoverLLMClient | null {
  if (process.env.LLM_ENABLED === 'false') return null;

  const providers: LLMProvider[] = [];
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // Preferred demo order: OpenRouter FIRST (free-tier resilience), Gemini as
  // fallback, deterministic strategies as the final safe path. Provider order
  // in the chain == failover priority.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    providers.push(new OpenRouterClient(
      openrouterKey,
      process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      timeoutMs
    ));
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    providers.push(new GeminiClient({
      apiKey: geminiKey,
      model: process.env.LLM_MODEL || DEFAULT_MODEL,
      timeoutMs,
    }));
  }

  if (providers.length === 0) return null;
  return new FailoverLLMClient(providers);
}
