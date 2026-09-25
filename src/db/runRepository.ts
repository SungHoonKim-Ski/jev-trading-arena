import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AssetDecision, EquityPoint, Metrics, RunParams, RunStatus, Trade } from '../types.ts';
import { transaction } from './database.ts';

export interface RunSummary {
  readonly totalReturn: number;
  readonly benchmarkReturn: number;
  readonly indexReturn: number | null;
  readonly jevCalls: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  readonly model: string;
  readonly intradayFills: number | null;
  readonly fallbackFills: number | null;
}

export interface RunArtifacts {
  readonly equity: readonly (EquityPoint & { readonly index?: number | null })[];
  readonly trades: readonly Trade[];
  readonly decisions: readonly (AssetDecision & { readonly date: string })[];
  readonly metrics: Metrics;
  readonly summary: RunSummary;
}

export interface RankFilters {
  readonly market?: string;
  readonly engine?: string;
  readonly effort?: string;
  readonly strategy?: string;
  readonly intervalDays?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly nickname?: string;
  readonly execution?: string;
}

export const SORT_COLUMNS = ['total_return', 'excess_return', 'sharpe', 'cagr', 'mdd'] as const;
export type SortColumn = typeof SORT_COLUMNS[number];

type Row = Record<string, unknown>;

const RUN_COLUMNS = `id, group_id, nickname, market, tickers, symbol_names, start_date, end_date, interval_days, effort,
  strategy, engine, model, initial_capital, status, progress, error, created_at, finished_at, total_return, cagr, mdd,
  sharpe, volatility, trades, fees, final_equity, benchmark_return, index_return, excess_return, jev_calls,
  jev_input_tokens, jev_cost_usd, execution, intraday_fills, fallback_fills`;

function toRun(row: Row): Row {
  return {
    ...row,
    tickers: JSON.parse(String(row.tickers)),
    symbol_names: row.symbol_names ? JSON.parse(String(row.symbol_names)) : null,
  };
}

function whereClause(f: RankFilters): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = ["status = 'done'"];
  const params: SQLInputValue[] = [];
  const eq = (col: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') { parts.push(`${col} = ?`); params.push(v); }
  };
  eq('market', f.market); eq('engine', f.engine); eq('effort', f.effort); eq('strategy', f.strategy);
  eq('interval_days', f.intervalDays); eq('start_date', f.startDate); eq('end_date', f.endDate); eq('nickname', f.nickname); eq('execution', f.execution);
  return { sql: parts.join(' AND '), params };
}

export class RunRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  create(params: RunParams, groupId: string): number {
    const r = this.#db.prepare(`INSERT INTO runs (group_id, nickname, market, tickers, start_date, end_date, interval_days,
      effort, strategy, engine, execution, initial_capital, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
      .run(groupId, params.nickname, params.market, JSON.stringify(params.tickers), params.startDate, params.endDate,
        params.intervalDays, params.effort, params.strategy, params.engine, params.execution, params.initialCapital, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getParams(id: number): RunParams | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      nickname: String(row.nickname), market: row.market as RunParams['market'], tickers: JSON.parse(String(row.tickers)),
      startDate: String(row.start_date), endDate: String(row.end_date), intervalDays: Number(row.interval_days),
      effort: row.effort as RunParams['effort'], strategy: row.strategy as RunParams['strategy'],
      initialCapital: Number(row.initial_capital), engine: row.engine as RunParams['engine'],
      execution: (row.execution ?? 'open') as RunParams['execution'],
    };
  }

  setStatus(id: number, status: RunStatus, error: string | null = null): void {
    const finished = status === 'done' || status === 'failed' ? new Date().toISOString() : null;
    this.#db.prepare('UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error, finished, id);
  }

  setProgress(id: number, progress: number): void {
    this.#db.prepare('UPDATE runs SET progress = ? WHERE id = ?').run(Math.max(0, Math.min(1, progress)), id);
  }

  setSymbolNames(id: number, names: Readonly<Record<string, string>>): void {
    this.#db.prepare('UPDATE runs SET symbol_names = ? WHERE id = ?').run(JSON.stringify(names), id);
  }

  complete(id: number, a: RunArtifacts): void {
    transaction(this.#db, () => {
      this.#clearArtifacts(id);
      const eq = this.#db.prepare('INSERT INTO run_equity (run_id, date, equity, benchmark, idx) VALUES (?, ?, ?, ?, ?)');
      for (const p of a.equity) eq.run(id, p.date, p.equity, p.benchmark, p.index ?? null);
      const tr = this.#db.prepare('INSERT INTO run_trades (run_id, date, symbol, side, shares, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const t of a.trades) tr.run(id, t.date, t.symbol, t.side, t.shares, t.price, t.fee);
      const de = this.#db.prepare('INSERT INTO run_decisions (run_id, date, symbol, action, target_weight, confidence, signal) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const d of a.decisions) de.run(id, d.date, d.symbol, d.action, d.targetWeight, d.confidence, d.signal);
      const m = a.metrics, s = a.summary;
      this.#db.prepare(`UPDATE runs SET status = 'done', progress = 1, error = NULL, finished_at = ?, model = ?,
        total_return = ?, cagr = ?, mdd = ?, sharpe = ?, volatility = ?, trades = ?, fees = ?, final_equity = ?,
        benchmark_return = ?, index_return = ?, excess_return = ?, jev_calls = ?, jev_input_tokens = ?, jev_cost_usd = ?,
        intraday_fills = ?, fallback_fills = ? WHERE id = ?`).run(new Date().toISOString(), s.model, m.totalReturn, m.cagr, m.mdd, m.sharpe, m.volatility, m.trades,
        m.fees, m.finalEquity, s.benchmarkReturn, s.indexReturn, m.totalReturn - s.benchmarkReturn, s.jevCalls,
        s.jevInputTokens, s.jevCostUsd, s.intradayFills, s.fallbackFills, id);
    });
  }

  #clearArtifacts(id: number): void {
    for (const t of ['run_equity', 'run_trades', 'run_decisions']) this.#db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(id);
  }

  get(id: number): Row | null {
    const row = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  getDetail(id: number): Row | null {
    const run = this.get(id);
    if (!run) return null;
    return {
      run,
      equity: this.#db.prepare('SELECT date, equity, benchmark, idx AS "index" FROM run_equity WHERE run_id = ? ORDER BY date').all(id),
      trades: this.#db.prepare('SELECT date, symbol, side, shares, price, fee FROM run_trades WHERE run_id = ? ORDER BY id').all(id),
      decisions: this.#db.prepare(`SELECT date, symbol, action, target_weight AS targetWeight, confidence, signal
        FROM run_decisions WHERE run_id = ? ORDER BY date, symbol`).all(id),
    };
  }

  list(opts: { nickname?: string; groupId?: string; limit: number }): Row[] {
    const parts: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.nickname) { parts.push('nickname = ?'); params.push(opts.nickname); }
    if (opts.groupId) { parts.push('group_id = ?'); params.push(opts.groupId); }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    return (this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ${where} ORDER BY id DESC LIMIT ?`).all(...params, opts.limit) as Row[]).map(toRun);
  }

  /** 수익률 랭킹. bestPerUser=true면 닉네임당 최고 기록 1개만 */
  leaderboard(f: RankFilters, sort: SortColumn, limit: number, bestPerUser: boolean): Row[] {
    const { sql, params } = whereClause(f);
    const order = `${sort} DESC, id ASC`;
    const inner = `SELECT ${RUN_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY ${order}) AS user_rank FROM runs WHERE ${sql}`;
    const rows = this.#db.prepare(
      `SELECT * FROM (${inner}) ${bestPerUser ? 'WHERE user_rank = 1' : ''} ORDER BY ${order} LIMIT ?`,
    ).all(...params, limit) as Row[];
    return rows.map((r, i) => ({ ...toRun(r), rank: i + 1 }));
  }

  /** 전략(Jev 응답 방식) × effort × 매매 주기 조합별 평균 성과 */
  strategyStats(f: RankFilters): Row[] {
    const { sql, params } = whereClause(f);
    return this.#db.prepare(`SELECT strategy, effort, interval_days, COUNT(*) AS runs, COUNT(DISTINCT nickname) AS users,
      AVG(total_return) AS avg_return, MAX(total_return) AS best_return, AVG(excess_return) AS avg_excess,
      AVG(sharpe) AS avg_sharpe, AVG(mdd) AS avg_mdd, AVG(trades) AS avg_trades,
      AVG(CASE WHEN excess_return > 0 THEN 1.0 ELSE 0.0 END) AS beat_benchmark_rate,
      AVG(jev_cost_usd) AS avg_cost_usd
      FROM runs WHERE ${sql} GROUP BY strategy, effort, interval_days ORDER BY avg_excess DESC, avg_return DESC`).all(...params) as Row[];
  }

  /** 서버 재시작 시 끝나지 않은 실행을 다시 대기열로 */
  requeueUnfinished(): number[] {
    const rows = this.#db.prepare("SELECT id FROM runs WHERE status IN ('queued', 'running') ORDER BY id").all() as { id: number }[];
    this.#db.prepare("UPDATE runs SET status = 'queued', progress = 0 WHERE status = 'running'").run();
    return rows.map((r) => Number(r.id));
  }
}
