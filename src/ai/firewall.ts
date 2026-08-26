import type { z } from 'zod';

/**
 * The LLM Firewall — AgentPay's anti-hallucination boundary.
 *
 * Every LLM output must survive strict Zod validation before it influences
 * any protocol decision. Invalid outputs trigger a repair loop: the Zod
 * error is fed back to the model as corrective feedback. After maxAttempts,
 * a typed LLMFirewallError is thrown and callers fall back to deterministic
 * strategies.
 *
 * The attempt log is exported for audit trails and UI "firewall blocked N
 * malformed outputs" badges — proof the guardrail actually works.
 */

export interface FirewallAttempt {
  attempt: number;
  error: string;
}

export class LLMFirewallError extends Error {
  constructor(public readonly attempts: FirewallAttempt[]) {
    super(
      `LLM output failed schema validation after ${attempts.length} attempt(s): ` +
        attempts.map((a) => `[${a.attempt}] ${a.error}`).join(' | ')
    );
    this.name = 'LLMFirewallError';
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export interface ValidateWithRetryParams<T> {
  schema: z.ZodType<T>;
  /** Produces raw model text. Receives corrective feedback from prior failures. */
  call: (feedback?: string) => Promise<string>;
  maxAttempts?: number;
}

export interface FirewallResult<T> {
  data: T;
  attempts: FirewallAttempt[];
  /** True when at least one malformed output had to be repaired. */
  repaired: boolean;
}

export async function validateWithRetry<T>(params: ValidateWithRetryParams<T>): Promise<FirewallResult<T>> {
  const { schema, call, maxAttempts = 3 } = params;
  const attempts: FirewallAttempt[] = [];
  let feedback: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await call(feedback);
    } catch (err: any) {
      // Transport-level failure: no point feeding back to the model, fail fast.
      throw err;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      feedback =
        'Your previous response was not valid JSON. Respond with ONLY a single valid JSON object matching the schema — no markdown fences, no commentary.';
      attempts.push({ attempt, error: 'InvalidJSON' });
      continue;
    }

    const result = schema.safeParse(candidate);
    if (result.success) {
      return { data: result.data, attempts, repaired: attempts.length > 0 };
    }

    feedback =
      `Your previous JSON failed validation: ${formatZodIssues(result.error)}. ` +
      'Return corrected JSON matching the schema exactly.';
    attempts.push({ attempt, error: formatZodIssues(result.error) });
  }

  throw new LLMFirewallError(attempts);
}
