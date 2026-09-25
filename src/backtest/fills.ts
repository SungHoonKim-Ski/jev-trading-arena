import type { IntradayDay, IntradayRepository } from '../db/intradayRepository.ts';
import { adjustedFill, type IntradayBar } from '../market/intraday.ts';
import type { SymbolBars } from '../market/priceService.ts';
import type { TickStore } from '../ticks/types.ts';
import type { Bar, RunParams, Trade } from '../types.ts';
import { logger } from '../logger.ts';
import type { FillPriceFn } from './engine.ts';

export type FillSource = 'tick' | 'minute' | 'daily';
export type MinuteFetcher = (symbol: string, fromSec: number, toSec: number) => Promise<IntradayBar[]>;

export interface FillDeps {
  readonly intraday: IntradayRepository;
  readonly ticks: TickStore | null;
  /** 코인 1분봉을 필요한 날만 받아 오는 함수 (바이낸스) */
  readonly cryptoMinutes: MinuteFetcher;
  readonly participation: number;
}

export interface FillCounts { readonly tick: number; readonly minute: number; readonly daily: number }

const FULL_CRYPTO_DAY_MINUTES = 1_400; // 1,440개 중 일부 누락 허용

/** 코인: 체결일의 1분봉이 DB에 없으면 그날 치만 받아서 저장 (전 기간 선수집 불필요) */
async function cryptoMinuteDay(symbol: string, date: string, deps: FillDeps): Promise<IntradayDay> {
  const existing = await deps.intraday.getFinestDay(symbol, date);
  if (existing.interval === '1m' && existing.bars.length >= FULL_CRYPTO_DAY_MINUTES) return existing;
  const from = Date.parse(`${date}T00:00:00Z`) / 1000;
  const bars = await deps.cryptoMinutes(symbol, from, from + 86_400 - 60);
  await deps.intraday.upsert(symbol, '1m', bars);
  return { interval: '1m', bars };
}

const dailyAverage = (bar: Bar) => (bar.open + bar.high + bar.low + bar.close) / 4;

/**
 * 체결 방식별 체결가 함수와, 체결마다 실제로 쓰인 데이터 출처 기록.
 * 우선순위: 틱(tick 모드) → 분봉 VWAP → 일봉 평균가
 */
export function makeFillPrice(
  params: RunParams, symbols: readonly SymbolBars[], stockDays: ReadonlyMap<string, ReadonlyMap<string, IntradayDay>>, deps: FillDeps,
): { fillPrice: FillPriceFn | undefined; sources: Map<string, FillSource> } {
  const sources = new Map<string, FillSource>();
  if (params.execution === 'open') return { fillPrice: undefined, sources };
  const barByDate = new Map(symbols.map((s) => [s.symbol, new Map(s.bars.map((b) => [b.date, b]))]));
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string, err: unknown) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn('fills', message, err);
  };

  const minuteVwap = async (symbol: string, date: string, bar: Bar): Promise<number | null> => {
    try {
      const day = params.market === 'CRYPTO' ? await cryptoMinuteDay(symbol, date, deps) : stockDays.get(symbol)?.get(date);
      return adjustedFill(bar.open, day?.bars ?? []);
    } catch (err) {
      warnOnce(`minute:${symbol}`, `minute bars unavailable for ${symbol}; using daily average`, err);
      return null;
    }
  };

  const tickPrice = async (symbol: string, date: string, quantity: number): Promise<number | null> => {
    if (!deps.ticks) return null;
    try {
      await deps.ticks.loadDay(symbol, date);
      return await deps.ticks.fillPrice(symbol, date, quantity, deps.participation);
    } catch (err) {
      warnOnce(`tick:${err instanceof Error ? err.name : 'x'}`, `tick data unavailable (${symbol} ${date}); falling back to minute VWAP`, err);
      return null;
    }
  };

  const fillPrice: FillPriceFn = async (symbol, date, _side, quantity) => {
    const bar = barByDate.get(symbol)?.get(date);
    if (!bar) return null;
    const key = `${symbol}|${date}`;
    if (params.execution === 'tick') {
      const p = await tickPrice(symbol, date, quantity);
      if (p !== null) { sources.set(key, 'tick'); return p; }
    }
    const v = await minuteVwap(symbol, date, bar);
    if (v !== null) { sources.set(key, 'minute'); return v; }
    sources.set(key, 'daily');
    return dailyAverage(bar);
  };
  return { fillPrice, sources };
}

export function countFills(trades: readonly Trade[], sources: ReadonlyMap<string, FillSource>): FillCounts {
  const counts = { tick: 0, minute: 0, daily: 0 };
  for (const t of trades) counts[sources.get(`${t.symbol}|${t.date}`) ?? 'daily'] += 1;
  return counts;
}
