import { z } from 'zod';
import type { ChartResult } from './yahoo.ts';
import { SymbolNotFoundError } from './yahoo.ts';
import type { IntradayBar } from './intraday.ts';

/** 제공하는 대표 코인 5종 (스테이블코인 제외 시가총액 상위). 가격은 USDT 마켓 기준 */
export const CRYPTO_ASSETS = [
  { ticker: 'BTC', symbol: 'BTCUSDT', name: '비트코인' },
  { ticker: 'ETH', symbol: 'ETHUSDT', name: '이더리움' },
  { ticker: 'SOL', symbol: 'SOLUSDT', name: '솔라나' },
  { ticker: 'XRP', symbol: 'XRPUSDT', name: '리플' },
  { ticker: 'BNB', symbol: 'BNBUSDT', name: 'BNB' },
] as const;

export const BINANCE_API = process.env.BINANCE_API_BASE ?? 'https://api.binance.com';
const PAGE_LIMIT = 1000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** BTC, BTC-USD, BTCUSDT 모두 BTCUSDT로. 지원하지 않는 코인은 null */
export function resolveCryptoSymbol(input: string): string | null {
  const base = input.trim().toUpperCase().replace(/-USD$/, '').replace(/USDT$/, '');
  return CRYPTO_ASSETS.find((a) => a.ticker === base)?.symbol ?? null;
}

export function cryptoName(symbol: string): string {
  return CRYPTO_ASSETS.find((a) => a.symbol === symbol)?.name ?? symbol;
}

const klineSchema = z.array(z.tuple([
  z.number(), z.string(), z.string(), z.string(), z.string(), z.string(), z.number(),
]).rest(z.unknown()));

/** 바이낸스 kline 배열 → 봉 (시각은 UTC, 코인 하루는 UTC 0시 기준) */
export function parseKlines(json: unknown): IntradayBar[] {
  const parsed = klineSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected Binance response: ${JSON.stringify(json).slice(0, 200)}`);
  return parsed.data.map(([openMs, o, h, l, c, v]) => ({
    ts: Math.floor(openMs / 1000),
    date: new Date(openMs).toISOString().slice(0, 10),
    open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v),
  }));
}

async function fetchKlinePages(
  symbol: string, interval: '1d' | '1m', startMs: number, endMs: number, step: number, fetchImpl: typeof fetch,
): Promise<IntradayBar[]> {
  const out: IntradayBar[] = [];
  let from = startMs;
  while (from <= endMs) {
    const url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=${PAGE_LIMIT}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 451) throw new Error('바이낸스가 이 지역(IP)에서의 접근을 차단했습니다');
    if (!res.ok) throw new Error(`바이낸스 시세 조회 실패 (${symbol} ${interval}): HTTP ${res.status}`);
    const page = parseKlines(await res.json());
    if (page.length === 0) break;
    out.push(...page);
    from = page.at(-1)!.ts * 1000 + step;
    if (page.length < PAGE_LIMIT) break;
  }
  return out;
}

const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** 코인 일봉 (PriceService의 BarFetcher와 같은 형태) */
export async function fetchBinanceDaily(input: string, from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<ChartResult> {
  const symbol = resolveCryptoSymbol(input);
  if (!symbol) throw new SymbolNotFoundError(`${input} (코인은 ${CRYPTO_ASSETS.map((a) => a.ticker).join(', ')}만 지원)`);
  const bars = await fetchKlinePages(symbol, '1d', toMs(from), toMs(to) + DAY_MS - 1, DAY_MS, fetchImpl);
  if (bars.length === 0) throw new SymbolNotFoundError(symbol);
  return {
    symbol, name: cryptoName(symbol), currency: 'USD',
    bars: bars.map(({ ts: _ts, ...b }) => b),
  };
}

/** 코인 1분봉 (상장 이후 전체 이력 제공). fromSec~toSec 포함 */
export async function fetchBinanceMinutes(symbol: string, fromSec: number, toSec: number, fetchImpl: typeof fetch = fetch): Promise<IntradayBar[]> {
  return fetchKlinePages(symbol, '1m', fromSec * 1000, toSec * 1000, MINUTE_MS, fetchImpl);
}
