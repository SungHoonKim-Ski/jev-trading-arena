import type { TickFillCache } from '../ticks/streamingTickPricer.ts';
import { queryOne, type Db } from './database.ts';

/** 스트리밍 틱 체결가 캐시 (종목·날짜·필요 체결량 → 체결가) */
export class TickFillCacheRepository implements TickFillCache {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  async get(key: string): Promise<number | null> {
    const row = await queryOne<{ price: number }>(this.#db, 'SELECT price FROM tick_fill_cache WHERE key = ?', [key]);
    return row ? Number(row.price) : null;
  }

  async set(key: string, price: number): Promise<void> {
    await this.#db.execute({ sql: 'INSERT OR REPLACE INTO tick_fill_cache (key, price, created_at) VALUES (?, ?, ?)', args: [key, price, new Date().toISOString()] });
  }
}
