import type { Bar, Market } from '../types.ts';
import type { PriceRepository } from '../db/priceRepository.ts';
import { candidateSymbols, fetchDailyBars, type ChartResult } from './yahoo.ts';

export type BarFetcher = (market: Market, input: string, from: string, to: string) => Promise<ChartResult>;

export interface SymbolBars {
  readonly symbol: string;
  readonly name: string;
  readonly currency: string;
  readonly bars: readonly Bar[];
}

function yesterday(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** DB에 저장된 구간이면 DB에서, 아니면 Yahoo에서 받아 저장(캐시) */
export class PriceService {
  readonly #repo: PriceRepository;
  readonly #fetcher: BarFetcher;
  readonly #now: () => Date;

  constructor(repo: PriceRepository, fetcher: BarFetcher = fetchDailyBars, now: () => Date = () => new Date()) {
    this.#repo = repo;
    this.#fetcher = fetcher;
    this.#now = now;
  }

  async getBars(market: Market, input: string, from: string, to: string): Promise<SymbolBars> {
    for (const symbol of candidateSymbols(market, input)) {
      const [cov, info] = await Promise.all([this.#repo.getCoverage(symbol), this.#repo.getSymbol(symbol)]);
      if (cov && info && cov.startDate <= from && cov.endDate >= to) {
        return { symbol, name: info.name, currency: info.currency, bars: await this.#repo.getBars(symbol, from, to) };
      }
    }
    const coverages = await Promise.all(candidateSymbols(market, input).map((s) => this.#repo.getCoverage(s)));
    const existing = coverages.find(Boolean);
    const fetchFrom = existing && existing.startDate < from ? existing.startDate : from;
    const fetchTo = existing && existing.endDate > to ? existing.endDate : to;
    const chart = await this.#fetcher(market, input, fetchFrom, fetchTo);
    const coveredTo = fetchTo < yesterday(this.#now()) ? fetchTo : yesterday(this.#now());
    await this.#repo.saveBars(
      { symbol: chart.symbol, market, name: chart.name, currency: chart.currency },
      chart.bars,
      { startDate: fetchFrom, endDate: coveredTo, fetchedAt: this.#now().toISOString() },
    );
    return { symbol: chart.symbol, name: chart.name, currency: chart.currency, bars: chart.bars.filter((b) => b.date >= from && b.date <= to) };
  }
}
