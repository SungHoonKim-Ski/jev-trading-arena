import type { EquityPoint, Metrics, Trade } from '../types.ts';

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

export function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

export function totalReturnOf(values: readonly number[], initial: number): number {
  return values.length === 0 || initial <= 0 ? 0 : values[values.length - 1]! / initial - 1;
}

/** periodsPerYear: 연환산 기준 (주식 252, 코인 365) */
export function computeMetrics(points: readonly EquityPoint[], trades: readonly Trade[], initialCapital: number, periodsPerYear = 252): Metrics {
  const values = points.map((p) => p.equity);
  const finalEquity = values.at(-1) ?? initialCapital;
  const totalReturn = totalReturnOf(values, initialCapital);
  const daily = values.slice(1).map((v, i) => (values[i]! > 0 ? v / values[i]! - 1 : 0));
  const mean = daily.length ? daily.reduce((s, r) => s + r, 0) / daily.length : 0;
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((s, r) => s + (r - mean) ** 2, 0) / (daily.length - 1)) : 0;
  const years = points.length > 1
    ? (Date.parse(points.at(-1)!.date) - Date.parse(points[0]!.date)) / MS_PER_YEAR
    : 0;
  return {
    totalReturn,
    cagr: years > 0 && finalEquity > 0 ? (finalEquity / initialCapital) ** (1 / years) - 1 : 0,
    mdd: maxDrawdown(values),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0,
    volatility: sd * Math.sqrt(periodsPerYear),
    trades: trades.length,
    fees: trades.reduce((s, t) => s + t.fee, 0),
    finalEquity,
  };
}
