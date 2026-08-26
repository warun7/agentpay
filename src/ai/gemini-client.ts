/**
 * Minimal dependency-free Google Gemini client for structured JSON output.
 * Transport is injectable for deterministic testing.
 */

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
}

export type GeminiTransport = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TRANSPORT: GeminiTransport = (url, init) => fetch(url, init);

export class GeminiTransportError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GeminiTransportError';
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
}

export const DEFAULT_MODEL = 'gemini-3.6-flash';
export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * NOTE: Environment-based construction moved to llm-failover.ts
 * (createLLMClientFromEnv) which chains Gemini with OpenRouter fallback.
 */
export class GeminiClient {
  readonly name = 'gemini';
  readonly modelLabel: string;
  constructor(
    private readonly config: GeminiConfig,
    private readonly transport: GeminiTransport = DEFAULT_TRANSPORT
  ) {
    this.modelLabel = `gemini:${config.model}`;
  }

  /**
   * Requests a schema-constrained JSON completion.
   * Returns the raw text emitted by the model — validation is the firewall's job.
   */
  async generateJSON(
    prompt: string,
    responseSchema: object,
    systemInstruction?: string
  ): Promise<{ raw: string }> {
    const url =
      `${this.config.baseUrl || 'https://generativelanguage.googleapis.com'}` +
      `/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.transport(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new GeminiTransportError(
          `Gemini API error ${response.status}: ${detail.slice(0, 300)}`,
          response.status
        );
      }

      const data = (await response.json()) as GeminiResponse;
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new GeminiTransportError('Gemini returned an empty candidate');
      }
      return { raw };
    } catch (err: any) {
      if (err instanceof GeminiTransportError) throw err;
      if (err.name === 'AbortError') {
        throw new GeminiTransportError(`Gemini call timed out after ${this.config.timeoutMs}ms`);
      }
      throw new GeminiTransportError(`Gemini transport failure: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
