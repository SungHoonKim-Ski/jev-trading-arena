import type { DatabaseSync } from 'node:sqlite';
import type { Bar, Market } from '../types.ts';
import { transaction } from './database.ts';

export interface Coverage { readonly startDate: string; readonly endDate: string; readonly fetchedAt: string }
export interface SymbolInfo { readonly symbol: string; readonly market: Market; readonly name: string; readonly currency: string }

export class PriceRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  getCoverage(symbol: string): Coverage | null {
    const row = this.#db.prepare('SELECT start_date, end_date, fetched_at FROM price_coverage WHERE symbol = ?').get(symbol) as
      { start_date: string; end_date: string; fetched_at: string } | undefined;
    return row ? { startDate: row.start_date, endDate: row.end_date, fetchedAt: row.fetched_at } : null;
  }

  getBars(symbol: string, from: string, to: string): Bar[] {
    return this.#db.prepare(
      'SELECT date, open, high, low, close, volume FROM prices WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date',
    ).all(symbol, from, to) as unknown as Bar[];
  }

  saveBars(info: SymbolInfo, bars: readonly Bar[], coverage: Coverage): void {
    transaction(this.#db, () => {
      this.#db.prepare('INSERT OR REPLACE INTO symbols (symbol, market, name, currency) VALUES (?, ?, ?, ?)')
        .run(info.symbol, info.market, info.name, info.currency);
      const insert = this.#db.prepare('INSERT OR REPLACE INTO prices (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const b of bars) insert.run(info.symbol, b.date, b.open, b.high, b.low, b.close, b.volume);
      this.#db.prepare('INSERT OR REPLACE INTO price_coverage (symbol, start_date, end_date, fetched_at) VALUES (?, ?, ?, ?)')
        .run(info.symbol, coverage.startDate, coverage.endDate, coverage.fetchedAt);
    });
  }

  listSymbols(): string[] {
    return (this.#db.prepare('SELECT symbol FROM symbols ORDER BY symbol').all() as { symbol: string }[]).map((r) => r.symbol);
  }

  getSymbol(symbol: string): SymbolInfo | null {
    const row = this.#db.prepare('SELECT symbol, market, name, currency FROM symbols WHERE symbol = ?').get(symbol);
    return (row as unknown as SymbolInfo) ?? null;
  }
}
