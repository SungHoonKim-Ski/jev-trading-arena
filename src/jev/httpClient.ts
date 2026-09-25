import { z } from 'zod';
import type { JevClient, JevRequest, JevResponse } from './types.ts';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.number()), confidence: z.number() }),
  z.object({ type: z.literal('score'), score: z.number(), probabilities: z.record(z.number()), legend: z.record(z.string()), confidence: z.number() }),
]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export class JevApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'JevApiError';
    this.status = status;
  }
}

export interface HttpJevClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** TypeSafe System One HTTP API 클라이언트. 429/529 등은 지수 백오프로 재시도 */
export class HttpJevClient implements JevClient {
  readonly mode = 'live' as const;
  readonly #opts: Required<HttpJevClientOptions>;

  constructor(opts: HttpJevClientOptions) {
    if (!opts.apiKey) throw new Error('TypeSafe API key is required for live Jev calls');
    this.#opts = { timeoutMs: 30_000, maxRetries: 4, fetchImpl: fetch, sleep: defaultSleep, ...opts };
  }

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const { maxRetries, sleep } = this.#opts;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.#once(request);
      } catch (err) {
        lastError = err;
        const retryable = !(err instanceof JevApiError) || RETRYABLE.has(err.status);
        if (!retryable || attempt === maxRetries) break;
        await sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #once(request: JevRequest): Promise<JevResponse> {
    const { apiKey, baseUrl, timeoutMs, fetchImpl } = this.#opts;
    const res = await fetchImpl(`${baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new JevApiError(res.status, `Jev API ${res.status}: ${text.slice(0, 300)}`);
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new JevApiError(502, `Unexpected Jev response shape: ${parsed.error.message.slice(0, 300)}`);
    return parsed.data as JevResponse;
  }
}
