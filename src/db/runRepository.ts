import type { AssetDecision, EquityPoint, Metrics, RunParams, RunStatus, Trade } from '../types.ts';
import { queryAll, queryOne, writeBatch, type Db, type SqlArg } from './database.ts';
import { DEFAULT_THRESHOLD } from '../config.ts';

export interface RunSummary {
  readonly totalReturn: number;
  readonly benchmarkReturn: number;
  readonly indexReturn: number | null;
  readonly jevCalls: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  readonly model: string;
  readonly tickFills: number | null;
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
  readonly threshold?: number;
  /** true면 현재 규칙('오를까?' + 확신 기준) 기록만 */
  readonly current?: boolean;
}

export const SORT_COLUMNS = ['total_return', 'excess_return', 'sharpe', 'cagr', 'mdd'] as const;
export type SortColumn = typeof SORT_COLUMNS[number];

type Row = Record<string, unknown>;

const RUN_COLUMNS = `id, group_id, nickname, market, tickers, symbol_names, start_date, end_date, interval_days, effort,
  strategy, engine, model, initial_capital, status, progress, error, created_at, finished_at, total_return, cagr, mdd,
  sharpe, volatility, trades, fees, final_equity, benchmark_return, index_return, excess_return, jev_calls,
  jev_input_tokens, jev_cost_usd, execution, intraday_fills, fallback_fills, tick_fills, started_at, threshold, exit_rule`;

function toRun(row: Row): Row {
  return {
    ...row,
    tickers: JSON.parse(String(row.tickers)),
    symbol_names: row.symbol_names ? JSON.parse(String(row.symbol_names)) : null,
  };
}

function whereClause(f: RankFilters): { sql: string; params: SqlArg[] } {
  const parts: string[] = ["status = 'done'"];
  const params: SqlArg[] = [];
  const eq = (col: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') { parts.push(`${col} = ?`); params.push(v); }
  };
  eq('market', f.market); eq('engine', f.engine); eq('effort', f.effort); eq('strategy', f.strategy);
  eq('interval_days', f.intervalDays); eq('start_date', f.startDate); eq('end_date', f.endDate); eq('nickname', f.nickname); eq('execution', f.execution); eq('threshold', f.threshold);
  if (f.current) parts.push("strategy = 'noul' AND threshold IS NOT NULL");
  return { sql: parts.join(' AND '), params };
}

export class RunRepository {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  async create(params: RunParams, groupId: string): Promise<number> {
    const r = await this.#db.execute({
      sql: `INSERT INTO runs (group_id, nickname, market, tickers, start_date, end_date, interval_days, effort, strategy, engine,
        execution, threshold, exit_rule, initial_capital, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      args: [groupId, params.nickname, params.market, JSON.stringify(params.tickers), params.startDate, params.endDate,
        params.intervalDays, params.effort, params.strategy, params.engine, params.execution, params.threshold, params.exitRule, params.initialCapital, new Date().toISOString()],
    });
    return Number(r.lastInsertRowid);
  }

  async getParams(id: number): Promise<RunParams | null> {
    const row = await queryOne<Row>(this.#db, 'SELECT * FROM runs WHERE id = ?', [id]);
    if (!row) return null;
    return {
      nickname: String(row.nickname), market: row.market as RunParams['market'], tickers: JSON.parse(String(row.tickers)),
      startDate: String(row.start_date), endDate: String(row.end_date), intervalDays: Number(row.interval_days),
      effort: row.effort as RunParams['effort'], strategy: row.strategy as RunParams['strategy'],
      initialCapital: Number(row.initial_capital), engine: row.engine as RunParams['engine'],
      execution: (row.execution ?? 'open') as RunParams['execution'],
      threshold: row.threshold == null ? DEFAULT_THRESHOLD : Number(row.threshold),
      exitRule: (row.exit_rule ?? 'opposite') as RunParams['exitRule'],
    };
  }

  async setStatus(id: number, status: RunStatus, error: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    const finished = status === 'done' || status === 'failed' ? now : null;
    await this.#db.execute({
      sql: `UPDATE runs SET status = ?, error = ?, finished_at = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END WHERE id = ?`,
      args: [status, error, finished, status, now, id],
    });
  }

  /**
   * 대기 중인 실행을 원자적으로 가져온다 (여러 서버리스 인스턴스가 같은 실행을 중복 처리하지 않도록).
   * 성공하면 true.
   */
  async claim(id: number): Promise<boolean> {
    const r = await this.#db.execute({
      sql: "UPDATE runs SET status = 'running', started_at = ?, progress = 0 WHERE id = ? AND status = 'queued'",
      args: [new Date().toISOString(), id],
    });
    return r.rowsAffected === 1;
  }

  async setProgress(id: number, progress: number): Promise<void> {
    await this.#db.execute({ sql: 'UPDATE runs SET progress = ? WHERE id = ?', args: [Math.max(0, Math.min(1, progress)), id] });
  }

  async setSymbolNames(id: number, names: Readonly<Record<string, string>>): Promise<void> {
    await this.#db.execute({ sql: 'UPDATE runs SET symbol_names = ? WHERE id = ?', args: [JSON.stringify(names), id] });
  }

  async complete(id: number, a: RunArtifacts): Promise<void> {
    const m = a.metrics, s = a.summary;
    await writeBatch(this.#db, [
      ...['run_equity', 'run_trades', 'run_decisions'].map((t) => ({ sql: `DELETE FROM ${t} WHERE run_id = ?`, args: [id] })),
      ...a.equity.map((p) => ({ sql: 'INSERT INTO run_equity (run_id, date, equity, benchmark, idx) VALUES (?, ?, ?, ?, ?)', args: [id, p.date, p.equity, p.benchmark, p.index ?? null] })),
      ...a.trades.map((t) => ({ sql: 'INSERT INTO run_trades (run_id, date, symbol, side, shares, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [id, t.date, t.symbol, t.side, t.shares, t.price, t.fee] })),
      ...a.decisions.map((d) => ({ sql: 'INSERT INTO run_decisions (run_id, date, symbol, action, target_weight, confidence, signal) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [id, d.date, d.symbol, d.action, d.targetWeight, d.confidence, d.signal] })),
      // 완료 표시는 마지막: 중간에 끊기면 완료로 보이지 않는다
      {
        sql: `UPDATE runs SET status = 'done', progress = 1, error = NULL, finished_at = ?, model = ?,
          total_return = ?, cagr = ?, mdd = ?, sharpe = ?, volatility = ?, trades = ?, fees = ?, final_equity = ?,
          benchmark_return = ?, index_return = ?, excess_return = ?, jev_calls = ?, jev_input_tokens = ?, jev_cost_usd = ?,
          intraday_fills = ?, fallback_fills = ?, tick_fills = ? WHERE id = ?`,
        args: [new Date().toISOString(), s.model, m.totalReturn, m.cagr, m.mdd, m.sharpe, m.volatility, m.trades,
          m.fees, m.finalEquity, s.benchmarkReturn, s.indexReturn, m.totalReturn - s.benchmarkReturn, s.jevCalls,
          s.jevInputTokens, s.jevCostUsd, s.intradayFills, s.fallbackFills, s.tickFills, id],
      },
    ]);
  }

  async get(id: number): Promise<Row | null> {
    const row = await queryOne<Row>(this.#db, `SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, [id]);
    return row ? toRun(row) : null;
  }

  async getDetail(id: number): Promise<Row | null> {
    const run = await this.get(id);
    if (!run) return null;
    // 재생 화면용: 실행 종목의 기간 내 일봉 (시가·종가)
    const symbols = Object.keys((run.symbol_names as Record<string, string> | null) ?? {});
    const priceRows = symbols.length === 0 ? [] : await queryAll<{ symbol: string; date: string; open: number; close: number }>(this.#db,
      `SELECT symbol, date, open, close FROM prices WHERE symbol IN (${symbols.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? ORDER BY symbol, date`,
      [...symbols, String(run.start_date), String(run.end_date)]);
    const prices: Record<string, { date: string; open: number; close: number }[]> = {};
    for (const { symbol, ...bar } of priceRows) prices[symbol] = [...(prices[symbol] ?? []), bar];
    const [equity, trades, decisions] = await Promise.all([
      queryAll(this.#db, 'SELECT date, equity, benchmark, idx AS "index" FROM run_equity WHERE run_id = ? ORDER BY date', [id]),
      queryAll(this.#db, 'SELECT date, symbol, side, shares, price, fee FROM run_trades WHERE run_id = ? ORDER BY id', [id]),
      queryAll(this.#db, `SELECT date, symbol, action, target_weight AS targetWeight, confidence, signal
        FROM run_decisions WHERE run_id = ? ORDER BY date, symbol`, [id]),
    ]);
    return { run, equity, trades, decisions, prices };
  }

  async list(opts: { nickname?: string; groupId?: string; limit: number }): Promise<Row[]> {
    const parts: string[] = [];
    const params: SqlArg[] = [];
    if (opts.nickname) { parts.push('nickname = ?'); params.push(opts.nickname); }
    if (opts.groupId) { parts.push('group_id = ?'); params.push(opts.groupId); }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    return (await queryAll<Row>(this.#db, `SELECT ${RUN_COLUMNS} FROM runs ${where} ORDER BY id DESC LIMIT ?`, [...params, opts.limit])).map(toRun);
  }

  /** 수익률 랭킹. bestPerUser=true면 닉네임당 최고 기록 1개만 */
  async leaderboard(f: RankFilters, sort: SortColumn, limit: number, bestPerUser: boolean): Promise<Row[]> {
    const { sql, params } = whereClause(f);
    const order = `${sort} DESC, id ASC`;
    const inner = `SELECT ${RUN_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY ${order}) AS user_rank FROM runs WHERE ${sql}`;
    const rows = await queryAll<Row>(this.#db,
      `SELECT * FROM (${inner}) ${bestPerUser ? 'WHERE user_rank = 1' : ''} ORDER BY ${order} LIMIT ?`, [...params, limit]);
    return rows.map((r, i) => ({ ...toRun(r), rank: i + 1 }));
  }

  /** 전략(Jev 응답 방식) × effort × 매매 주기 조합별 평균 성과 */
  async strategyStats(f: RankFilters): Promise<Row[]> {
    const { sql, params } = whereClause(f);
    return queryAll<Row>(this.#db, `SELECT strategy, effort, interval_days, threshold, COUNT(*) AS runs, COUNT(DISTINCT nickname) AS users,
      AVG(total_return) AS avg_return, MAX(total_return) AS best_return, AVG(excess_return) AS avg_excess,
      AVG(sharpe) AS avg_sharpe, AVG(mdd) AS avg_mdd, AVG(trades) AS avg_trades,
      AVG(CASE WHEN excess_return > 0 THEN 1.0 ELSE 0.0 END) AS beat_benchmark_rate,
      AVG(jev_cost_usd) AS avg_cost_usd
      FROM runs WHERE ${sql} GROUP BY strategy, effort, interval_days, threshold ORDER BY avg_excess DESC, avg_return DESC`, params);
  }

  /** 단일 서버 재시작 시: 끝나지 않은 실행을 모두 다시 대기열로 */
  async requeueUnfinished(): Promise<number[]> {
    await this.#db.execute("UPDATE runs SET status = 'queued', progress = 0 WHERE status = 'running'");
    return (await queryAll<{ id: number }>(this.#db, "SELECT id FROM runs WHERE status = 'queued' ORDER BY id")).map((r) => Number(r.id));
  }

  /**
   * 서버리스용 복구: staleMs 이상 'running'에 멈춘 실행(함수 시간 초과 등)을 대기열로 되돌리고,
   * 대기 중인 실행 id를 반환한다.
   */
  async recoverStale(staleMs: number, limit: number): Promise<number[]> {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    await this.#db.execute({ sql: "UPDATE runs SET status = 'queued', progress = 0 WHERE status = 'running' AND started_at < ?", args: [cutoff] });
    return (await queryAll<{ id: number }>(this.#db, "SELECT id FROM runs WHERE status = 'queued' ORDER BY id LIMIT ?", [limit])).map((r) => Number(r.id));
  }
}
