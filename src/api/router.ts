import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFIG, EFFORT_INFO, INTERVALS, MARKETS, STRATEGY_INFO } from '../config.ts';
import type { RunRepository } from '../db/runRepository.ts';
import type { RunQueue } from '../backtest/queue.ts';
import type { Effort, RunParams, Strategy } from '../types.ts';
import { fail, HttpError, ok, RateLimiter, readJson } from './http.ts';
import { TICKER_PRESETS } from './presets.ts';
import { logger } from '../logger.ts';
import { serveStatic } from './staticFiles.ts';
import { collectSchema, createRunSchema, formatZodError, rankQuerySchema, type CreateRunInput } from './validation.ts';
import type { IntradayRepository } from '../db/intradayRepository.ts';
import type { IntradayCollector } from '../market/intradayCollector.ts';
import type { PriceService } from '../market/priceService.ts';
import { INTRADAY_SPECS } from '../market/intraday.ts';

export interface RouterDeps {
  readonly runs: RunRepository;
  readonly queue: RunQueue;
  readonly jevLive: boolean;
  readonly publicDir: string;
  readonly intraday: IntradayRepository;
  readonly collector: IntradayCollector;
  readonly prices: PriceService;
}

function expandCombos(input: CreateRunInput): RunParams[] {
  const tickers = [...new Set(input.tickers)];
  return input.strategies.flatMap((strategy) => input.efforts.flatMap((effort) => input.intervals.map((intervalDays) => ({
    nickname: input.nickname, market: input.market, tickers, startDate: input.startDate, endDate: input.endDate,
    intervalDays, effort: effort as Effort, strategy: strategy as Strategy, initialCapital: input.initialCapital, engine: input.engine,
    execution: input.execution,
  }))));
}

function meta(jevLive: boolean) {
  return {
    jevLive,
    model: CONFIG.jev.model,
    markets: MARKETS,
    presets: TICKER_PRESETS,
    strategies: STRATEGY_INFO,
    efforts: EFFORT_INFO,
    intervals: INTERVALS,
    maxRunsPerRequest: CONFIG.maxRunsPerRequest,
    intradaySpecs: INTRADAY_SPECS,
  };
}

export function createRouter(deps: RouterDeps) {
  const limiter = new RateLimiter(CONFIG.rateLimit.maxCreates, CONFIG.rateLimit.windowMs);

  async function createRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요');
    const parsed = createRunSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    if (parsed.data.engine === 'live' && !deps.jevLive) throw new HttpError(400, 'TYPESAFE_API_KEY가 설정되지 않아 실제 Jev 엔진을 사용할 수 없습니다');
    const combos = expandCombos(parsed.data);
    if (combos.length > CONFIG.maxRunsPerRequest) throw new HttpError(400, `조합이 ${combos.length}개입니다. 한 번에 최대 ${CONFIG.maxRunsPerRequest}개까지 실행할 수 있습니다`);
    const groupId = randomUUID();
    const ids = combos.map((c) => deps.runs.create(c, groupId));
    deps.queue.enqueue(ids);
    ok(res, { groupId, runIds: ids }, 202);
  }

  /** 종목을 일봉으로 먼저 확인(심볼 확정)한 뒤 분봉 수집 */
  async function collectIntraday(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요');
    const parsed = collectSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const symbols: string[] = [];
    for (const t of parsed.data.tickers) {
      try {
        symbols.push((await deps.prices.getBars(parsed.data.market, t, weekAgo, today)).symbol);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    ok(res, await deps.collector.collectMany(symbols));
  }

  function getRun(res: ServerResponse, id: number): void {
    const detail = deps.runs.getDetail(id);
    if (!detail) throw new HttpError(404, '실행 기록을 찾을 수 없습니다');
    ok(res, detail);
  }

  function rankQuery(url: URL) {
    const parsed = rankQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return parsed.data;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/api/meta' && method === 'GET') return ok(res, meta(deps.jevLive));
    if (pathname === '/api/runs' && method === 'POST') return createRuns(req, res);
    if (pathname === '/api/runs' && method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      return ok(res, deps.runs.list({
        nickname: url.searchParams.get('nickname')?.trim() || undefined,
        groupId: url.searchParams.get('groupId')?.trim() || undefined,
        limit,
      }));
    }
    const runMatch = /^\/api\/runs\/(\d+)$/.exec(pathname);
    if (runMatch && method === 'GET') return getRun(res, Number(runMatch[1]));
    if (pathname === '/api/leaderboard' && method === 'GET') {
      const q = rankQuery(url);
      return ok(res, deps.runs.leaderboard(q, q.sort, q.limit, q.bestPerUser));
    }
    if (pathname === '/api/stats' && method === 'GET') return ok(res, deps.runs.strategyStats(rankQuery(url)));
    if (pathname === '/api/data/coverage' && method === 'GET') return ok(res, deps.intraday.coverage());
    if (pathname === '/api/data/collect' && method === 'POST') return collectIntraday(req, res);
    if (pathname.startsWith('/api/')) throw new HttpError(404, '존재하지 않는 API입니다');
    if (method === 'GET' && (await serveStatic(deps.publicDir, pathname, res))) return;
    throw new HttpError(404, 'Not found');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message);
      logger.error('api', 'unexpected error', err);
      fail(res, 500, '서버 오류가 발생했습니다');
    }
  };
}
