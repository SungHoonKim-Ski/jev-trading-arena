import type { Bar, Market } from '../types.ts';
import { queryAll, queryOne, writeBatch, type Db } from './database.ts';

export interface Coverage { readonly startDate: string; readonly endDate: string; readonly fetchedAt: string }
export interface SymbolInfo { readonly symbol: string; readonly market: Market; readonly name: string; readonly currency: string }

export class PriceRepository {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  async getCoverage(symbol: string): Promise<Coverage | null> {
    return queryOne<Coverage>(this.#db,
      'SELECT start_date AS startDate, end_date AS endDate, fetched_at AS fetchedAt FROM price_coverage WHERE symbol = ?', [symbol]);
  }

  async getBars(symbol: string, from: string, to: string): Promise<Bar[]> {
    return queryAll<Bar>(this.#db,
      'SELECT date, open, high, low, close, volume FROM prices WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date', [symbol, from, to]);
  }

  async saveBars(info: SymbolInfo, bars: readonly Bar[], coverage: Coverage): Promise<void> {
    await writeBatch(this.#db, [
      { sql: 'INSERT OR REPLACE INTO symbols (symbol, market, name, currency) VALUES (?, ?, ?, ?)', args: [info.symbol, info.market, info.name, info.currency] },
      ...bars.map((b) => ({
        sql: 'INSERT OR REPLACE INTO prices (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [info.symbol, b.date, b.open, b.high, b.low, b.close, b.volume],
      })),
      // 커버리지는 마지막에 기록: 중간에 실패하면 다음 요청이 다시 받아 온다
      { sql: 'INSERT OR REPLACE INTO price_coverage (symbol, start_date, end_date, fetched_at) VALUES (?, ?, ?, ?)', args: [info.symbol, coverage.startDate, coverage.endDate, coverage.fetchedAt] },
    ]);
  }

  async listSymbols(market?: Market): Promise<string[]> {
    const rows = market
      ? await queryAll<{ symbol: string }>(this.#db, 'SELECT symbol FROM symbols WHERE market = ? ORDER BY symbol', [market])
      : await queryAll<{ symbol: string }>(this.#db, 'SELECT symbol FROM symbols ORDER BY symbol');
    return rows.map((r) => r.symbol);
  }

  async getSymbol(symbol: string): Promise<SymbolInfo | null> {
    return queryOne<SymbolInfo>(this.#db, 'SELECT symbol, market, name, currency FROM symbols WHERE symbol = ?', [symbol]);
  }
}
