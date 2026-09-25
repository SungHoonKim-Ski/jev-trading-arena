import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALL_INTERVALS, CONFIG, EFFORT_INFO, MARKETS, STRATEGY_INFO } from '../config.ts';
import type { RunRepository } from '../db/runRepository.ts';
import type { RunQueue } from '../backtest/queue.ts';
import type { Effort, RunParams, Strategy } from '../types.ts';
import { fail, HttpError, ok, RateLimiter, readJson } from './http.ts';
import { TICKER_PRESETS } from './presets.ts';
import { logger } from '../logger.ts';
import { serveStatic } from './staticFiles.ts';
import { collectSchema, createRunSchema, formatZodError, rankQuerySchema, tickCollectSchema, type CreateRunInput } from './validation.ts';
import type { TickStore } from '../ticks/types.ts';
import { CRYPTO_ASSETS, resolveCryptoSymbol } from '../market/binance.ts';
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
  /** 주기 작업(멈춘 실행 복구, 분봉 수집). 서버리스 크론에서 호출 */
  readonly onCron: () => Promise<unknown>;
  readonly ticks: TickStore | null;
}

function expandCombos(input: CreateRunInput): RunParams[] {
  const tickers = [...new Set(input.tickers)];
  return input.strategies.flatMap((strategy) => input.efforts.flatMap((effort) => input.intervals.map((intervalDays) => ({
    nickname: input.nickname, market: input.market, tickers, startDate: input.startDate, endDate: input.endDate,
    intervalDays, effort: effort as Effort, strategy: strategy as Strategy, initialCapital: input.initialCapital, engine: input.engine,
    execution: input.execution,
  }))));
}

function meta(jevLive: boolean, ticksEnabled: boolean) {
  return {
    jevLive,
    ticksEnabled,
    tickParticipation: CONFIG.ticks.participation,
    cryptoAssets: CRYPTO_ASSETS,
    model: CONFIG.jev.model,
    markets: MARKETS,
    presets: TICKER_PRESETS,
    strategies: STRATEGY_INFO,
    efforts: EFFORT_INFO,
    intervals: ALL_INTERVALS,
    maxRunsPerRequest: CONFIG.maxRunsPerRequest,
    intradaySpecs: INTRADAY_SPECS,
  };
}

/** GitHub Pages 등 다른 출처의 프론트엔드가 API를 호출할 수 있도록 CORS 허용 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed = CONFIG.allowedOrigins;
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 프록시(Vercel) 뒤에서는 x-forwarded-for의 첫 주소가 실제 클라이언트 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRouter(deps: RouterDeps): RequestHandler {
  const limiter = new RateLimiter(CONFIG.rateLimit.maxCreates, CONFIG.rateLimit.windowMs);

  async function createRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!limiter.allow(clientIp(req))) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요');
    const parsed = createRunSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    if (parsed.data.execution === 'tick' && !deps.ticks) throw new HttpError(400, '이 서버에서는 틱 체결을 사용할 수 없습니다 (원본 틱 저장소는 로컬 전용)');
    if (parsed.data.engine === 'live' && !deps.jevLive) throw new HttpError(400, 'TYPESAFE_API_KEY가 설정되지 않아 실제 Jev 엔진을 사용할 수 없습니다');
    const combos = expandCombos(parsed.data);
    if (combos.length > CONFIG.maxRunsPerRequest) throw new HttpError(400, `조합이 ${combos.length}개입니다. 한 번에 최대 ${CONFIG.maxRunsPerRequest}개까지 실행할 수 있습니다`);
    const groupId = randomUUID();
    const ids: number[] = [];
    for (const c of combos) ids.push(await deps.runs.create(c, groupId));
    deps.queue.enqueue(ids);
    ok(res, { groupId, runIds: ids }, 202);
  }

  /** 종목을 일봉으로 먼저 확인(심볼 확정)한 뒤 분봉 수집 */
  async function collectIntraday(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!limiter.allow(clientIp(req))) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요');
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

  /** Vercel Cron은 Authorization: Bearer <CRON_SECRET> 헤더를 붙여 호출한다. 비밀값이 없으면 비활성 */
  async function cron(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!CONFIG.cronSecret || req.headers.authorization !== `Bearer ${CONFIG.cronSecret}`) throw new HttpError(404, '존재하지 않는 API입니다');
    ok(res, await deps.onCron());
  }

  async function tickCoverage(res: ServerResponse): Promise<void> {
    if (!deps.ticks) return ok(res, { enabled: false, sizeBytes: 0, maxBytes: 0, coverage: [] });
    ok(res, { enabled: true, sizeBytes: deps.ticks.sizeBytes(), maxBytes: deps.ticks.maxBytes, coverage: await deps.ticks.coverage() });
  }

  /** 지정 기간의 코인 원본 틱을 받아 저장 (요청당 코인×일수 10개 이하) */
  async function collectTicks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.ticks) throw new HttpError(400, '이 서버에서는 원본 틱 저장소를 사용할 수 없습니다');
    if (!limiter.allow(clientIp(req))) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요');
    const parsed = tickCollectSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    const results: { symbol: string; date: string; trades?: number; cached?: boolean; error?: string }[] = [];
    for (const ticker of parsed.data.tickers) {
      const symbol = resolveCryptoSymbol(ticker)!;
      for (let t = Date.parse(parsed.data.from); t <= Date.parse(parsed.data.to); t += 86_400_000) {
        const date = new Date(t).toISOString().slice(0, 10);
        try {
          results.push({ symbol, date, ...(await deps.ticks.loadDay(symbol, date)) });
        } catch (err) {
          results.push({ symbol, date, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    ok(res, results);
  }

  async function getRun(res: ServerResponse, id: number): Promise<void> {
    const detail = await deps.runs.getDetail(id);
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

    if (pathname === '/api/meta' && method === 'GET') return ok(res, meta(deps.jevLive, deps.ticks !== null));
    if (pathname === '/api/runs' && method === 'POST') return createRuns(req, res);
    if (pathname === '/api/runs' && method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      return ok(res, await deps.runs.list({
        nickname: url.searchParams.get('nickname')?.trim() || undefined,
        groupId: url.searchParams.get('groupId')?.trim() || undefined,
        limit,
      }));
    }
    const runMatch = /^\/api\/runs\/(\d+)$/.exec(pathname);
    if (runMatch && method === 'GET') return getRun(res, Number(runMatch[1]));
    if (pathname === '/api/leaderboard' && method === 'GET') {
      const q = rankQuery(url);
      return ok(res, await deps.runs.leaderboard(q, q.sort, q.limit, q.bestPerUser));
    }
    if (pathname === '/api/stats' && method === 'GET') return ok(res, await deps.runs.strategyStats(rankQuery(url)));
    if (pathname === '/api/data/coverage' && method === 'GET') return ok(res, await deps.intraday.coverage());
    if (pathname === '/api/cron/tick' && method === 'GET') return cron(req, res);
    if (pathname === '/api/ticks/coverage' && method === 'GET') return tickCoverage(res);
    if (pathname === '/api/ticks/collect' && method === 'POST') return collectTicks(req, res);
    if (pathname === '/api/data/collect' && method === 'POST') return collectIntraday(req, res);
    if (pathname.startsWith('/api/')) throw new HttpError(404, '존재하지 않는 API입니다');
    if (method === 'GET' && (await serveStatic(deps.publicDir, pathname, res))) return;
    throw new HttpError(404, 'Not found');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message);
      logger.error('api', 'unexpected error', err);
      fail(res, 500, '서버 오류가 발생했습니다');
    }
  };
}
