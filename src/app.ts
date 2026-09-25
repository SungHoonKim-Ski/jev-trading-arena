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

export interface AppOptions {
  readonly db: Db;
  readonly fetcher?: BarFetcher;
  readonly liveJev?: JevClient | null;
  readonly intradayFetcher?: IntradayFetcher;
}

export interface App {
  readonly handle: RequestHandler;
  readonly queue: RunQueue;
  readonly runs: RunRepository;
  readonly collector: IntradayCollector;
  /** 분봉 주기 수집 대상: 일봉을 받아 둔 모든 종목(지수 제외) */
  readonly trackedSymbols: () => Promise<string[]>;
  /** 주기 작업: 멈춘 실행 복구·재실행 + 분봉 수집 */
  readonly tick: () => Promise<{ requeued: number; collected: number }>;
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
  const queue = new RunQueue(runs, (id) => executeRun(id, { prices, runs, jevFor, model: CONFIG.jev.model, intraday, collector }), CONFIG.maxConcurrentRuns);
  const trackedSymbols = async () => (await priceRepo.listSymbols()).filter((s) => !s.startsWith('^'));
  const tick = async () => {
    const ids = await runs.recoverStale(CONFIG.staleRunMs, CONFIG.maxRunsPerRequest);
    queue.enqueue(ids);
    const results = await collector.collectMany(await trackedSymbols());
    await queue.onIdle();
    const collected = results.reduce((s, r) => s + Object.values(r.saved).reduce((a, b) => a + (b ?? 0), 0), 0);
    return { requeued: ids.length, collected };
  };
  const handle = createRouter({ runs, queue, jevLive: live !== null, publicDir: CONFIG.publicDir, intraday, collector, prices, onCron: tick });
  return { handle, queue, runs, collector, trackedSymbols, tick };
}
