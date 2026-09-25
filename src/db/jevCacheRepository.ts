import type { DatabaseSync } from 'node:sqlite';
import type { JevCacheStore } from '../jev/cachedClient.ts';

/** 별칭 모델(jev-latest)은 버전이 바뀔 수 있으므로 캐시를 일정 기간만 유효하게 둔다 */
const DEFAULT_TTL_MS = 30 * 24 * 3600_000;

export class JevCacheRepository implements JevCacheStore {
  readonly #db: DatabaseSync;
  readonly #ttlMs: number;
  constructor(db: DatabaseSync, ttlMs = DEFAULT_TTL_MS) { this.#db = db; this.#ttlMs = ttlMs; }

  get(key: string): string | null {
    const minCreated = new Date(Date.now() - this.#ttlMs).toISOString();
    const row = this.#db.prepare('SELECT response FROM jev_cache WHERE key = ? AND created_at >= ?').get(key, minCreated) as { response: string } | undefined;
    return row?.response ?? null;
  }

  set(key: string, model: string, value: string): void {
    this.#db.prepare('INSERT OR REPLACE INTO jev_cache (key, model, response, created_at) VALUES (?, ?, ?, ?)')
      .run(key, model, value, new Date().toISOString());
  }
}
