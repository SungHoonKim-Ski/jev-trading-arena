import { z } from 'zod';

export type IntradayInterval = '1m' | '5m' | '60m';

export interface IntradayBar {
  readonly ts: number; // epoch seconds (UTC)
  readonly date: string; // 거래소 현지 날짜
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface IntradaySpec {
  readonly interval: IntradayInterval;
  /** Yahoo가 제공하는 최대 과거 일수 */
  readonly maxDays: number;
  /** 한 번의 요청으로 받을 수 있는 최대 일수 */
  readonly chunkDays: number;
}

/** 촘촘한 순서. Yahoo 무료 데이터 한도(2026-09 실측): 1m 30일, 5m 60일, 60m 730일 */
export const INTRADAY_SPECS: readonly IntradaySpec[] = [
  { interval: '1m', maxDays: 29, chunkDays: 7 },
  { interval: '5m', maxDays: 59, chunkDays: 59 },
  { interval: '60m', maxDays: 729, chunkDays: 729 },
];

const nums = z.array(z.number().nullable());
const schema = z.object({
  chart: z.object({
    result: z.array(z.object({
      meta: z.object({ gmtoffset: z.number().default(0) }),
      timestamp: z.array(z.number()).optional(),
      indicators: z.object({ quote: z.array(z.object({ open: nums.optional(), high: nums.optional(), low: nums.optional(), close: nums.optional(), volume: nums.optional() })) }),
    })).nullable(),
  }),
});

/** Yahoo 분봉 응답 파싱 (원주가 그대로, 수정주가 아님) */
export function parseIntraday(json: unknown): IntradayBar[] {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected Yahoo intraday response: ${parsed.error.message.slice(0, 200)}`);
  const r = parsed.data.chart.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  // 휴장 구간은 quote가 빈 객체로 온다
  const { open, high, low, close, volume } = q ?? {};
  if (!open || !high || !low || !close) return [];
  const out: IntradayBar[] = [];
  r.timestamp.forEach((ts, i) => {
    const [o, h, l, c] = [open[i], high[i], low[i], close[i]];
    if (o == null || h == null || l == null || c == null || c <= 0) return;
    out.push({ ts, date: new Date((ts + r.meta.gmtoffset) * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: volume?.[i] ?? 0 });
  });
  return out;
}

/** 세션 VWAP = Σ(typical price × volume) / Σvolume */
export function sessionVwap(bars: readonly IntradayBar[]): number | null {
  if (bars.length === 0) return null;
  const vol = bars.reduce((s, b) => s + b.volume, 0);
  if (vol <= 0) return bars.reduce((s, b) => s + b.close, 0) / bars.length;
  return bars.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / vol;
}

/**
 * 분봉은 원주가, 일봉은 수정주가이므로 비율로 환산한다.
 * 체결가 = 수정 시가 × (원주가 VWAP / 원주가 첫 분봉 시가)
 */
export function adjustedFill(adjustedOpen: number, bars: readonly IntradayBar[]): number | null {
  const vwap = sessionVwap(bars);
  const firstOpen = bars[0]?.open;
  if (vwap === null || !firstOpen) return null;
  return adjustedOpen * (vwap / firstOpen);
}

/** 장중에 받은 마지막 분봉은 미완성일 수 있으므로 이만큼 겹쳐서 다시 받아 덮어쓴다 */
export const REFETCH_OVERLAP_SEC = 2 * 3600;

/**
 * 수집 구간 계산: (마지막 저장 시점 - 겹침) ~ 현재, chunkDays 단위로 분할.
 * 최초 수집 시작점은 UTC 자정으로 올림해 가장 오래된 날이 장 중간부터 잘려 저장되지 않게 한다
 * (한국 장 시작 09:00 KST = 00:00 UTC, 미국 장은 13:30 UTC 이후).
 */
export function collectionWindows(spec: IntradaySpec, lastTs: number | null, now: number): [number, number][] {
  const raw = now - spec.maxDays * 86_400;
  const earliest = Math.ceil(raw / 86_400) * 86_400;
  let from = lastTs === null ? earliest : Math.max(earliest, lastTs - REFETCH_OVERLAP_SEC);
  const windows: [number, number][] = [];
  while (from < now) {
    const to = Math.min(now, from + spec.chunkDays * 86_400);
    windows.push([from, to]);
    from = to;
  }
  return windows;
}

export async function fetchIntraday(
  symbol: string, interval: IntradayInterval, from: number, to: number, fetchImpl: typeof fetch = fetch,
): Promise<IntradayBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=${interval}&period1=${from}&period2=${to}&includePrePost=false`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`분봉 조회 실패 (${symbol} ${interval}): HTTP ${res.status}`);
  return parseIntraday(await res.json());
}
