import type { DatabaseSync } from 'node:sqlite';
import { INTRADAY_SPECS, type IntradayBar, type IntradayInterval } from '../market/intraday.ts';
import { transaction } from './database.ts';

/** 첫 분봉이 장 시작으로부터 이 이내면 완전한 하루로 본다 */
const SESSION_START_TOLERANCE_SEC = 5 * 60;

export interface IntradayCoverage {
  readonly symbol: string;
  readonly interval: IntradayInterval;
  readonly bars: number;
  readonly days: number;
  readonly firstDate: string;
  readonly lastDate: string;
}

export class IntradayRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  upsert(symbol: string, interval: IntradayInterval, bars: readonly IntradayBar[]): number {
    if (bars.length === 0) return 0;
    return transaction(this.#db, () => {
      const before = this.#count(symbol, interval);
      // 같은 시각 분봉은 최신 값으로 덮어쓴다 (장중 수집된 미완성 분봉 보정)
      const stmt = this.#db.prepare(`INSERT INTO intraday_bars (symbol, interval, ts, date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, interval, ts) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
          close = excluded.close, volume = excluded.volume`);
      for (const b of bars) stmt.run(symbol, interval, b.ts, b.date, b.open, b.high, b.low, b.close, b.volume);
      return this.#count(symbol, interval) - before;
    });
  }

  #count(symbol: string, interval: IntradayInterval): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM intraday_bars WHERE symbol = ? AND interval = ?').get(symbol, interval) as { n: number }).n);
  }

  lastTs(symbol: string, interval: IntradayInterval): number | null {
    const row = this.#db.prepare('SELECT MAX(ts) AS ts FROM intraday_bars WHERE symbol = ? AND interval = ?').get(symbol, interval) as { ts: number | null };
    return row.ts ?? null;
  }

  /**
   * 해당 날짜의 가장 촘촘한 "완전한" 분봉.
   * 더 성긴 간격이 더 이른 시각부터 있으면 촘촘한 쪽은 장 중간부터 잘린 것으로 보고 건너뛴다.
   */
  getFinestDay(symbol: string, date: string): { interval: IntradayInterval | null; bars: IntradayBar[] } {
    const stmt = this.#db.prepare('SELECT ts, date, open, high, low, close, volume FROM intraday_bars WHERE symbol = ? AND interval = ? AND date = ? ORDER BY ts');
    const byInterval = INTRADAY_SPECS
      .map((spec) => ({ interval: spec.interval, bars: stmt.all(symbol, spec.interval, date) as unknown as IntradayBar[] }))
      .filter((x) => x.bars.length > 0);
    if (byInterval.length === 0) return { interval: null, bars: [] };
    const sessionStart = Math.min(...byInterval.map((x) => x.bars[0]!.ts));
    const complete = byInterval.find((x) => x.bars[0]!.ts <= sessionStart + SESSION_START_TOLERANCE_SEC);
    return complete ?? { interval: null, bars: [] };
  }

  coverage(): IntradayCoverage[] {
    return this.#db.prepare(`SELECT symbol, interval, COUNT(*) AS bars, COUNT(DISTINCT date) AS days, MIN(date) AS firstDate, MAX(date) AS lastDate
      FROM intraday_bars GROUP BY symbol, interval ORDER BY symbol, interval`).all() as unknown as IntradayCoverage[];
  }
}
