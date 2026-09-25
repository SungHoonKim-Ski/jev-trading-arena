import { CONFIG } from './config.ts';
import type { Db } from './db/database.ts';
import { PriceRepository } from './db/priceRepository.ts';
import { RunRepository } from './db/runRepository.ts';
import { JevCacheRepository } from './db/jevCacheRepository.ts';
import { IntradayRepository } from './db/intradayRepository.ts';
import { PriceService, type BarFetcher } from './market/priceService.ts';
import { IntradayCollector, type IntradayFetcher } from './market/intradayCollector.ts';
import { HttpJevClient } from './jev/httpClient.ts';
import { MockJevClient } from './jev/mockClient.ts';
import { CachedJevClient } from './jev/cachedClient.ts';
import type { JevClient } from './jev/types.ts';
import { executeRun } from './backtest/runner.ts';
import { RunQueue } from './backtest/queue.ts';
import { createRouter, type RequestHandler } from './api/router.ts';
import type { TickStore } from './ticks/types.ts';
import type { MinuteFetcher } from './backtest/fills.ts';
import { CRYPTO_ASSETS, fetchBinanceMinutes } from './market/binance.ts';
import { logger } from './logger.ts';

export interface AppOptions {
  readonly db: Db;
  readonly fetcher?: BarFetcher;
  readonly liveJev?: JevClient | null;
  readonly intradayFetcher?: IntradayFetcher;
  /** 원본 틱 저장소 (로컬 전용, 서버리스에서는 null) */
  readonly ticks?: TickStore | null;
  readonly cryptoMinutes?: MinuteFetcher;
  readonly rateLimit?: { readonly maxCreates: number; readonly windowMs: number };
}

export interface App {
  readonly handle: RequestHandler;
  readonly queue: RunQueue;
  readonly runs: RunRepository;
  readonly collector: IntradayCollector;
  /** 분봉 주기 수집 대상: 일봉을 받아 둔 모든 종목(지수 제외) */
  readonly trackedSymbols: () => Promise<string[]>;
  /** 주기 작업: 멈춘 실행 복구·재실행 + 분봉 수집 + (로컬) 전날 원본 틱 수집 */
  readonly tick: () => Promise<{ requeued: number; collected: number; tickDays: number }>;
  /** 전날 코인 5종 원본 틱 수집 (로컬 전용) */
  readonly collectYesterdayTicks: () => Promise<number>;
}

function defaultLiveJev(): JevClient | null {
  if (!CONFIG.jev.apiKey) return null;
  return new HttpJevClient({ apiKey: CONFIG.jev.apiKey, baseUrl: CONFIG.jev.baseUrl, timeoutMs: CONFIG.jev.timeoutMs, maxRetries: CONFIG.jev.maxRetries });
}

export function createApp(opts: AppOptions): App {
  const runs = new RunRepository(opts.db);
  const priceRepo = new PriceRepository(opts.db);
  const prices = new PriceService(priceRepo, opts.fetcher);
  const intraday = new IntradayRepository(opts.db);
  const collector = new IntradayCollector(intraday, opts.intradayFetcher);
  const liveInner = opts.liveJev === undefined ? defaultLiveJev() : opts.liveJev;
  const live = liveInner ? new CachedJevClient(liveInner, new JevCacheRepository(opts.db)) : null;
  const mock = new MockJevClient();
  const jevFor = (engine: 'live' | 'mock'): JevClient => {
    if (engine === 'mock') return mock;
    if (!live) throw new Error('TYPESAFE_API_KEY가 설정되지 않았습니다');
    return live;
  };
  const ticks = opts.ticks ?? null;
  const cryptoMinutes = opts.cryptoMinutes ?? ((symbol, from, to) => fetchBinanceMinutes(symbol, from, to));
  const queue = new RunQueue(runs, (id) => executeRun(id, {
    prices, runs, jevFor, model: CONFIG.jev.model, intraday, collector, ticks, cryptoMinutes, participation: CONFIG.ticks.participation,
  }), CONFIG.maxConcurrentRuns);
  // Yahoo 분봉 주기 수집 대상은 주식만 (코인은 체결일마다 바이낸스에서 받는다)
  const trackedSymbols = async () => [
    ...await priceRepo.listSymbols('KR'), ...await priceRepo.listSymbols('US'),
  ].filter((s) => !s.startsWith('^'));
  const collectYesterdayTicks = async () => {
    if (!ticks || !CONFIG.ticks.dailyCollect) return 0;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let loaded = 0;
    for (const a of CRYPTO_ASSETS) {
      try {
        if (!(await ticks.loadDay(a.symbol, yesterday)).cached) loaded += 1;
      } catch (err) {
        logger.warn('ticks', `daily tick collection skipped for ${a.symbol} ${yesterday}`, err);
      }
    }
    return loaded;
  };
  const tick = async () => {
    const ids = await runs.recoverStale(CONFIG.staleRunMs, CONFIG.maxRunsPerRequest);
    queue.enqueue(ids);
    const results = await collector.collectMany(await trackedSymbols());
    await queue.onIdle();
    const collected = results.reduce((s, r) => s + Object.values(r.saved).reduce((a, b) => a + (b ?? 0), 0), 0);
    const tickDays = await collectYesterdayTicks();
    return { requeued: ids.length, collected, tickDays };
  };
  const handle = createRouter({ runs, queue, jevLive: live !== null, publicDir: CONFIG.publicDir, intraday, collector, prices, onCron: tick, ticks, rateLimit: opts.rateLimit });
  return { handle, queue, runs, collector, trackedSymbols, tick, collectYesterdayTicks };
}
