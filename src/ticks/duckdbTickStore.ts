import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { TickCoverage, TickDownloader, TickStore } from './types.ts';

export class TickBudgetError extends Error {
  constructor(size: number, max: number) {
    super(`틱 저장소 용량 상한 초과 (${(size / 1e9).toFixed(2)}GB / ${(max / 1e9).toFixed(2)}GB). TICK_STORE_MAX_GB를 늘리거나 오래된 틱을 정리하세요`);
    this.name = 'TickBudgetError';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  symbol VARCHAR NOT NULL,
  trade_id BIGINT NOT NULL,
  price DOUBLE NOT NULL,
  qty DOUBLE NOT NULL,
  ts BIGINT NOT NULL,            -- UTC 마이크로초
  is_buyer_maker BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS tick_days (
  symbol VARCHAR NOT NULL,
  date VARCHAR NOT NULL,
  trades BIGINT NOT NULL,
  sha256 VARCHAR NOT NULL,
  loaded_at VARCHAR NOT NULL,
  PRIMARY KEY (symbol, date)
);`;

/** 밀리초 시각(2025년 이전 파일)을 마이크로초로 통일하는 기준 */
const MICROS_THRESHOLD = 100_000_000_000_000;

function dayRangeUs(date: string): [number, number] {
  const start = Date.parse(`${date}T00:00:00Z`) * 1000;
  return [start, start + 86_400_000_000];
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * DuckDB 기반 원본 틱 저장소 (열 단위 압축: BTC 하루 330만 건 ≈ 37MB).
 * 쓰기는 한 번에 하나씩 직렬화한다.
 */
export class DuckDbTickStore implements TickStore {
  readonly maxBytes: number;
  readonly #conn: DuckDBConnection;
  readonly #file: string;
  readonly #downloader: TickDownloader;
  readonly #close: () => void;
  #writeChain: Promise<unknown> = Promise.resolve();

  private constructor(conn: DuckDBConnection, file: string, downloader: TickDownloader, maxBytes: number, close: () => void) {
    this.#conn = conn;
    this.#file = file;
    this.#downloader = downloader;
    this.maxBytes = maxBytes;
    this.#close = close;
  }

  static async open(file: string, downloader: TickDownloader, opts: { maxBytes: number }): Promise<DuckDbTickStore> {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const instance = await DuckDBInstance.create(file);
    const conn = await instance.connect();
    await conn.run(SCHEMA);
    return new DuckDbTickStore(conn, file, downloader, opts.maxBytes, () => { conn.closeSync(); instance.closeSync(); });
  }

  async hasDay(symbol: string, date: string): Promise<boolean> {
    const r = await this.#conn.runAndReadAll('SELECT 1 FROM tick_days WHERE symbol = $1 AND date = $2', [symbol, date]);
    return r.getRows().length > 0;
  }

  loadDay(symbol: string, date: string): Promise<{ trades: number; cached: boolean }> {
    const job = this.#writeChain.then(() => this.#loadDayNow(symbol, date));
    this.#writeChain = job.catch(() => undefined);
    return job;
  }

  async #loadDayNow(symbol: string, date: string): Promise<{ trades: number; cached: boolean }> {
    if (await this.hasDay(symbol, date)) {
      const r = await this.#conn.runAndReadAll('SELECT CAST(trades AS DOUBLE) AS n FROM tick_days WHERE symbol = $1 AND date = $2', [symbol, date]);
      return { trades: Number(r.getRowObjects()[0]!.n), cached: true };
    }
    const size = this.sizeBytes();
    if (size >= this.maxBytes) throw new TickBudgetError(size, this.maxBytes);
    const { csv, sha256 } = await this.#downloader.download(symbol, date);
    const tmp = path.join(tmpdir(), `ticks-${randomUUID()}.csv`);
    writeFileSync(tmp, csv);
    try {
      return { trades: await this.#insertCsv(symbol, date, tmp, sha256), cached: false };
    } finally {
      unlinkSync(tmp);
    }
  }

  async #insertCsv(symbol: string, date: string, file: string, sha256: string): Promise<number> {
    const [from, to] = dayRangeUs(date);
    await this.#conn.run('BEGIN TRANSACTION');
    try {
      await this.#conn.run('DELETE FROM trades WHERE symbol = $1 AND ts >= $2 AND ts < $3', [symbol, from, to]);
      // 일부 파일은 헤더가 있으므로 숫자로 변환되지 않는 행은 버린다
      await this.#conn.run(`INSERT INTO trades
        SELECT $1, TRY_CAST(c0 AS BIGINT), TRY_CAST(c1 AS DOUBLE), TRY_CAST(c2 AS DOUBLE),
          CASE WHEN TRY_CAST(c4 AS BIGINT) < ${MICROS_THRESHOLD} THEN TRY_CAST(c4 AS BIGINT) * 1000 ELSE TRY_CAST(c4 AS BIGINT) END,
          lower(c5) = 'true'
        FROM read_csv(${sqlString(file)}, header = false, all_varchar = true,
          columns = {'c0': 'VARCHAR', 'c1': 'VARCHAR', 'c2': 'VARCHAR', 'c3': 'VARCHAR', 'c4': 'VARCHAR', 'c5': 'VARCHAR', 'c6': 'VARCHAR'})
        WHERE TRY_CAST(c0 AS BIGINT) IS NOT NULL`, [symbol]);
      const r = await this.#conn.runAndReadAll('SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM trades WHERE symbol = $1 AND ts >= $2 AND ts < $3', [symbol, from, to]);
      const trades = Number(r.getRowObjects()[0]!.n);
      await this.#conn.run('INSERT OR REPLACE INTO tick_days VALUES ($1, $2, $3, $4, $5)', [symbol, date, trades, sha256, new Date().toISOString()]);
      await this.#conn.run('COMMIT');
      return trades;
    } catch (err) {
      await this.#conn.run('ROLLBACK');
      throw err;
    }
  }

  async fillPrice(symbol: string, date: string, quantity: number, participation: number): Promise<number | null> {
    if (quantity <= 0 || participation <= 0) return null;
    const [from, to] = dayRangeUs(date);
    const need = quantity / participation; // 따라가야 할 시장 체결량
    const r = await this.#conn.runAndReadAll(`
      WITH t AS (
        SELECT price, qty, SUM(qty) OVER (ORDER BY ts, trade_id ROWS UNBOUNDED PRECEDING) AS cum
        FROM trades WHERE symbol = $1 AND ts >= $2 AND ts < $3
      )
      SELECT SUM(price * LEAST(qty, GREATEST(0, $4 - (cum - qty)))) AS notional,
             SUM(LEAST(qty, GREATEST(0, $4 - (cum - qty)))) AS filled,
             ARG_MAX(price, cum) AS last_price,
             COUNT(*) AS n
      FROM t`, [symbol, from, to, need]);
    const row = r.getRowObjects()[0]!;
    if (Number(row.n) === 0) return null;
    const notional = Number(row.notional);
    const filled = Number(row.filled);
    const remainder = Math.max(0, need - filled);
    return (notional + remainder * Number(row.last_price)) / need;
  }

  async coverage(): Promise<TickCoverage[]> {
    const r = await this.#conn.runAndReadAll(`SELECT symbol, CAST(COUNT(*) AS DOUBLE) AS days, CAST(SUM(trades) AS DOUBLE) AS trades,
      MIN(date) AS firstDate, MAX(date) AS lastDate FROM tick_days GROUP BY symbol ORDER BY symbol`);
    return r.getRowObjects().map((o) => ({
      symbol: String(o.symbol), days: Number(o.days), trades: Number(o.trades), firstDate: String(o.firstDate), lastDate: String(o.lastDate),
    }));
  }

  sizeBytes(): number {
    if (this.#file === ':memory:') return 0;
    return [this.#file, `${this.#file}.wal`].filter(existsSync).reduce((s, f) => s + statSync(f).size, 0);
  }

  close(): void {
    this.#close();
  }
}
