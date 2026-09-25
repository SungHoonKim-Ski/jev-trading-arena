import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS price_coverage (
  symbol TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  market TEXT NOT NULL,
  tickers TEXT NOT NULL,
  symbol_names TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  effort TEXT NOT NULL,
  strategy TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  initial_capital REAL NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  total_return REAL, cagr REAL, mdd REAL, sharpe REAL, volatility REAL,
  trades INTEGER, fees REAL, final_equity REAL,
  benchmark_return REAL, index_return REAL, excess_return REAL,
  jev_calls INTEGER, jev_input_tokens INTEGER, jev_cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_runs_rank ON runs(status, market, engine, total_return);
CREATE INDEX IF NOT EXISTS idx_runs_nickname ON runs(nickname);
CREATE TABLE IF NOT EXISTS run_equity (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  equity REAL NOT NULL,
  benchmark REAL NOT NULL,
  idx REAL,
  PRIMARY KEY (run_id, date)
);
CREATE TABLE IF NOT EXISTS run_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  date TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
  shares REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_run ON run_trades(run_id);
CREATE TABLE IF NOT EXISTS run_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  date TEXT NOT NULL, symbol TEXT NOT NULL, action TEXT NOT NULL,
  target_weight REAL, confidence REAL NOT NULL, signal REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_run ON run_decisions(run_id);
CREATE TABLE IF NOT EXISTS intraday_bars (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (symbol, interval, ts)
);
CREATE INDEX IF NOT EXISTS idx_intraday_day ON intraday_bars(symbol, interval, date);
CREATE TABLE IF NOT EXISTS jev_cache (
  key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 기존 DB에 새 컬럼 추가 (CREATE TABLE IF NOT EXISTS로는 반영되지 않음) */
const COLUMN_MIGRATIONS: readonly [table: string, column: string, ddl: string][] = [
  ['runs', 'execution', "ALTER TABLE runs ADD COLUMN execution TEXT NOT NULL DEFAULT 'open'"],
  ['runs', 'intraday_fills', 'ALTER TABLE runs ADD COLUMN intraday_fills INTEGER'],
  ['runs', 'fallback_fills', 'ALTER TABLE runs ADD COLUMN fallback_fills INTEGER'],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

/** 여러 쓰기를 하나의 트랜잭션으로 묶는다 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
