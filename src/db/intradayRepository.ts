import { INTRADAY_SPECS, type IntradayBar, type IntradayInterval } from '../market/intraday.ts';
import { queryAll, queryOne, writeBatch, type Db } from './database.ts';

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

export interface IntradayDay {
  readonly interval: IntradayInterval | null;
  readonly bars: readonly IntradayBar[];
}

type Row = IntradayBar & { readonly interval: IntradayInterval };

/**
 * 하루치 여러 간격 분봉 중 가장 촘촘한 "완전한" 것을 고른다.
 * 더 성긴 간격이 더 이른 시각부터 있으면 촘촘한 쪽은 장 중간부터 잘린 것으로 보고 건너뛴다.
 */
export function pickFinestComplete(byInterval: ReadonlyMap<IntradayInterval, readonly IntradayBar[]>): IntradayDay {
  const available = INTRADAY_SPECS.map((s) => ({ interval: s.interval, bars: byInterval.get(s.interval) ?? [] })).filter((x) => x.bars.length > 0);
  if (available.length === 0) return { interval: null, bars: [] };
  const sessionStart = Math.min(...available.map((x) => x.bars[0]!.ts));
  return available.find((x) => x.bars[0]!.ts <= sessionStart + SESSION_START_TOLERANCE_SEC) ?? { interval: null, bars: [] };
}

export class IntradayRepository {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  async #count(symbol: string, interval: IntradayInterval): Promise<number> {
    const row = await queryOne<{ n: number }>(this.#db, 'SELECT COUNT(*) AS n FROM intraday_bars WHERE symbol = ? AND interval = ?', [symbol, interval]);
    return Number(row?.n ?? 0);
  }

  /** 같은 시각 분봉은 최신 값으로 덮어쓴다 (장중 수집된 미완성 분봉 보정). 새로 늘어난 개수를 반환 */
  async upsert(symbol: string, interval: IntradayInterval, bars: readonly IntradayBar[]): Promise<number> {
    if (bars.length === 0) return 0;
    const before = await this.#count(symbol, interval);
    await writeBatch(this.#db, bars.map((b) => ({
      sql: `INSERT INTO intraday_bars (symbol, interval, ts, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, interval, ts) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
          close = excluded.close, volume = excluded.volume`,
      args: [symbol, interval, b.ts, b.date, b.open, b.high, b.low, b.close, b.volume],
    })));
    return (await this.#count(symbol, interval)) - before;
  }

  async lastTs(symbol: string, interval: IntradayInterval): Promise<number | null> {
    const row = await queryOne<{ ts: number | null }>(this.#db, 'SELECT MAX(ts) AS ts FROM intraday_bars WHERE symbol = ? AND interval = ?', [symbol, interval]);
    return row?.ts == null ? null : Number(row.ts);
  }

  /** 기간 내 날짜별로 가장 촘촘한 완전한 분봉 (백테스트 전에 한 번에 읽어 메모리에서 사용) */
  async getFinestDays(symbol: string, from: string, to: string): Promise<Map<string, IntradayDay>> {
    const rows = await queryAll<Row>(this.#db,
      'SELECT interval, ts, date, open, high, low, close, volume FROM intraday_bars WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY ts',
      [symbol, from, to]);
    const grouped = new Map<string, Map<IntradayInterval, IntradayBar[]>>();
    for (const { interval, ...bar } of rows) {
      const day = grouped.get(bar.date) ?? new Map<IntradayInterval, IntradayBar[]>();
      day.set(interval, [...(day.get(interval) ?? []), bar]);
      grouped.set(bar.date, day);
    }
    return new Map([...grouped].map(([date, byInterval]) => [date, pickFinestComplete(byInterval)]));
  }

  async getFinestDay(symbol: string, date: string): Promise<IntradayDay> {
    return (await this.getFinestDays(symbol, date, date)).get(date) ?? { interval: null, bars: [] };
  }

  async coverage(): Promise<IntradayCoverage[]> {
    return queryAll<IntradayCoverage>(this.#db, `SELECT symbol, interval, COUNT(*) AS bars, COUNT(DISTINCT date) AS days,
      MIN(date) AS firstDate, MAX(date) AS lastDate FROM intraday_bars GROUP BY symbol, interval ORDER BY symbol, interval`);
  }
}
