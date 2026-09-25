import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CONFIG } from './config.ts';
import { PriceRepository } from './db/priceRepository.ts';
import { RunRepository } from './db/runRepository.ts';
import { JevCacheRepository } from './db/jevCacheRepository.ts';
import { PriceService, type BarFetcher } from './market/priceService.ts';
import { HttpJevClient } from './jev/httpClient.ts';
import { MockJevClient } from './jev/mockClient.ts';
import { CachedJevClient } from './jev/cachedClient.ts';
import type { JevClient } from './jev/types.ts';
import { executeRun } from './backtest/runner.ts';
import { RunQueue } from './backtest/queue.ts';
import { createRouter } from './api/router.ts';
import { IntradayRepository } from './db/intradayRepository.ts';
import { IntradayCollector, type IntradayFetcher } from './market/intradayCollector.ts';

export interface AppOptions {
  readonly db: DatabaseSync;
  readonly fetcher?: BarFetcher;
  readonly liveJev?: JevClient | null;
  readonly intradayFetcher?: IntradayFetcher;
}

export interface App {
  readonly server: Server;
  readonly queue: RunQueue;
  readonly runs: RunRepository;
  readonly collector: IntradayCollector;
  /** 분봉 주기 수집 대상: 일봉을 받아 둔 모든 종목(지수 제외) */
  readonly trackedSymbols: () => string[];
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
  const server = createServer(createRouter({ runs, queue, jevLive: live !== null, publicDir: CONFIG.publicDir, intraday, collector, prices }));
  const trackedSymbols = () => priceRepo.listSymbols().filter((s) => !s.startsWith('^'));
  return { server, queue, runs, collector, trackedSymbols };
}
