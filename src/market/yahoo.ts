import { z } from 'zod';
import type { Bar, Market } from '../types.ts';
import { resolveCryptoSymbol } from './binance.ts';

export class SymbolNotFoundError extends Error {
  constructor(symbol: string) {
    super(`종목을 찾을 수 없습니다: ${symbol}`);
    this.name = 'SymbolNotFoundError';
  }
}

const nullableNums = z.array(z.number().nullable());
const chartSchema = z.object({
  chart: z.object({
    result: z.array(z.object({
      meta: z.object({
        symbol: z.string(),
        currency: z.string().nullish(),
        gmtoffset: z.number().default(0),
        longName: z.string().nullish(),
        shortName: z.string().nullish(),
      }),
      timestamp: z.array(z.number()).default([]),
      indicators: z.object({
        quote: z.array(z.object({ open: nullableNums, high: nullableNums, low: nullableNums, close: nullableNums, volume: nullableNums })),
        adjclose: z.array(z.object({ adjclose: nullableNums })).optional(),
      }),
    })).nullable(),
    error: z.object({ code: z.string().optional() }).passthrough().nullable(),
  }),
});

export interface ChartResult {
  readonly symbol: string;
  readonly name: string;
  readonly currency: string;
  readonly bars: readonly Bar[];
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** Yahoo chart 응답 → 수정주가 기준 일봉 */
export function parseChart(json: unknown): ChartResult {
  const parsed = chartSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected Yahoo response: ${parsed.error.message.slice(0, 200)}`);
  const result = parsed.data.chart.result?.[0];
  if (!result) throw new SymbolNotFoundError(String(parsed.data.chart.error?.code ?? 'unknown'));
  const q = result.indicators.quote[0]!;
  const adj = result.indicators.adjclose?.[0]?.adjclose;
  const bars: Bar[] = [];
  result.timestamp.forEach((ts, i) => {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if (o == null || h == null || l == null || c == null || c <= 0) return;
    const factor = adj?.[i] != null ? adj[i]! / c : 1;
    bars.push({
      date: new Date((ts + result.meta.gmtoffset) * 1000).toISOString().slice(0, 10),
      open: round(o * factor), high: round(h * factor), low: round(l * factor), close: round(c * factor),
      volume: q.volume[i] ?? 0,
    });
  });
  const deduped = [...new Map(bars.map((b) => [b.date, b])).values()];
  return {
    symbol: result.meta.symbol,
    name: result.meta.longName ?? result.meta.shortName ?? result.meta.symbol,
    currency: result.meta.currency ?? '',
    bars: deduped,
  };
}

/** 사용자 입력 → Yahoo 심볼 후보 */
export function candidateSymbols(market: Market, input: string): string[] {
  const t = input.trim().toUpperCase();
  if (market === 'KR' && /^\d{6}$/.test(t)) return [`${t}.KS`, `${t}.KQ`];
  // 코인은 바이낸스 USDT 마켓 5종: BTC / BTC-USD / BTCUSDT → BTCUSDT
  if (market === 'CRYPTO') {
    const symbol = resolveCryptoSymbol(t);
    return symbol ? [symbol] : [];
  }
  return [t];
}

const toEpoch = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

export async function fetchDailyBars(
  market: Market, input: string, from: string, to: string, fetchImpl: typeof fetch = fetch,
): Promise<ChartResult> {
  const period2 = toEpoch(to) + 2 * 86_400;
  for (const symbol of candidateSymbols(market, input)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?period1=${toEpoch(from)}&period2=${period2}&interval=1d&events=div%2Csplits`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`시세 조회 실패 (${symbol}): HTTP ${res.status}`);
    try {
      const chart = parseChart(await res.json());
      if (chart.bars.length > 0) return { ...chart, symbol };
    } catch (err) {
      if (!(err instanceof SymbolNotFoundError)) throw err;
    }
  }
  throw new SymbolNotFoundError(input);
}
