import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TRACKED_KEYS = 10_000;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const ok = (res: ServerResponse, data: unknown, status = 200) => sendJson(res, status, { success: true, data, error: null });
export const fail = (res: ServerResponse, status: number, error: string) => sendJson(res, status, { success: false, data: null, error });

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '요청 본문이 너무 큽니다');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '올바른 JSON이 아닙니다');
  }
}

/** IP별 고정 윈도우 레이트리밋 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #max: number;
  readonly #windowMs: number;
  constructor(max: number, windowMs: number) { this.#max = max; this.#windowMs = windowMs; }

  allow(key: string, now = Date.now()): boolean {
    if (this.#hits.size > MAX_TRACKED_KEYS) this.#prune(now);
    const cur = this.#hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (cur.count >= this.#max) return false;
    this.#hits.set(key, { count: cur.count + 1, resetAt: cur.resetAt });
    return true;
  }

  get trackedKeys(): number { return this.#hits.size; }

  #prune(now: number): void {
    for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
  }
}
