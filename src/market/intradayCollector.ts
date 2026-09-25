import type { IntradayRepository } from '../db/intradayRepository.ts';
import { logger } from '../logger.ts';
import { collectionWindows, fetchIntraday, INTRADAY_SPECS, type IntradayBar, type IntradayInterval } from './intraday.ts';

export type IntradayFetcher = (symbol: string, interval: IntradayInterval, from: number, to: number) => Promise<IntradayBar[]>;

export interface CollectResult {
  readonly symbol: string;
  readonly saved: Readonly<Partial<Record<IntradayInterval, number>>>;
  readonly errors: readonly string[];
}

const REQUEST_GAP_MS = 300;

/**
 * 분봉 수집기. Yahoo는 과거 분봉을 짧게만 제공하므로(1m 30일 등)
 * 주기적으로 실행해 DB에 계속 누적하는 것이 핵심이다.
 */
export class IntradayCollector {
  readonly #repo: IntradayRepository;
  readonly #fetcher: IntradayFetcher;
  readonly #nowSec: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<unknown> = Promise.resolve();

  constructor(
    repo: IntradayRepository,
    fetcher: IntradayFetcher = fetchIntraday,
    nowSec: () => number = () => Math.floor(Date.now() / 1000),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.#repo = repo;
    this.#fetcher = fetcher;
    this.#nowSec = nowSec;
    this.#sleep = sleep;
  }

  async collect(symbol: string): Promise<CollectResult> {
    const saved: Partial<Record<IntradayInterval, number>> = {};
    const errors: string[] = [];
    for (const spec of INTRADAY_SPECS) {
      try {
        let count = 0;
        for (const [from, to] of collectionWindows(spec, this.#repo.lastTs(symbol, spec.interval), this.#nowSec())) {
          count += this.#repo.upsert(symbol, spec.interval, await this.#fetcher(symbol, spec.interval, from, to));
          await this.#sleep(REQUEST_GAP_MS);
        }
        saved[spec.interval] = count;
      } catch (err) {
        errors.push(`${spec.interval}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { symbol, saved, errors };
  }

  /** 동시에 여러 수집이 겹치지 않도록 직렬화 */
  collectMany(symbols: readonly string[]): Promise<CollectResult[]> {
    const job = this.#running.then(async () => {
      const results: CollectResult[] = [];
      for (const s of symbols) results.push(await this.collect(s));
      return results;
    });
    this.#running = job.catch(() => undefined);
    return job;
  }

  /** 주기 수집 시작 (추적 종목 목록은 호출 시점마다 새로 조회) */
  startSchedule(listSymbols: () => readonly string[], everyMs: number): void {
    const run = async () => {
      const symbols = listSymbols();
      if (symbols.length === 0) return;
      const results = await this.collectMany(symbols);
      const total = results.reduce((s, r) => s + Object.values(r.saved).reduce((a, b) => a + (b ?? 0), 0), 0);
      logger.info('intraday', `scheduled collection: ${symbols.length} symbols, ${total} new bars`);
      for (const r of results) if (r.errors.length) logger.warn('intraday', `${r.symbol}: ${r.errors.join('; ')}`);
    };
    run().catch((err) => logger.error('intraday', 'initial collection failed', err));
    this.#timer = setInterval(() => { run().catch((err) => logger.error('intraday', 'scheduled collection failed', err)); }, everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
