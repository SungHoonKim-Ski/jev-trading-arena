import type { JevCacheStore } from '../jev/cachedClient.ts';
import { queryOne, type Db } from './database.ts';

/** 별칭 모델(jev-latest)은 버전이 바뀔 수 있으므로 캐시를 일정 기간만 유효하게 둔다 */
const DEFAULT_TTL_MS = 30 * 24 * 3600_000;

export class JevCacheRepository implements JevCacheStore {
  readonly #db: Db;
  readonly #ttlMs: number;
  constructor(db: Db, ttlMs = DEFAULT_TTL_MS) { this.#db = db; this.#ttlMs = ttlMs; }

  async get(key: string): Promise<string | null> {
    const minCreated = new Date(Date.now() - this.#ttlMs).toISOString();
    const row = await queryOne<{ response: string }>(this.#db, 'SELECT response FROM jev_cache WHERE key = ? AND created_at >= ?', [key, minCreated]);
    return row?.response ?? null;
  }

  async set(key: string, model: string, value: string): Promise<void> {
    await this.#db.execute({
      sql: 'INSERT OR REPLACE INTO jev_cache (key, model, response, created_at) VALUES (?, ?, ?, ?)',
      args: [key, model, value, new Date().toISOString()],
    });
  }
}
