import type { Bar } from '../src/types.ts';

/** 거래일(주말 제외) 달력 생성 */
export function tradingDates(start: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** 종가 배열로 Bar 생성 (시가=종가) */
export function barsFromCloses(closes: readonly number[], start = '2024-01-01'): Bar[] {
  const dates = tradingDates(start, closes.length);
  return closes.map((c, i) => ({ date: dates[i]!, open: c, high: c, low: c, close: c, volume: 1000 }));
}

export function linearCloses(from: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + step * i);
}
