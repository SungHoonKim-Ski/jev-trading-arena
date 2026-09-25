import type { Bar, Effort } from '../types.ts';

/**
 * 코드에서 계산하는 원시 지표.
 * Jev는 수치 계산에 약하므로(jaggedness 문서) 숫자는 여기서 계산하고
 * 모델에는 의미 있는 영어 라벨만 전달한다.
 */
export interface RawFeatures {
  readonly ret5: number;
  readonly ret20: number;
  readonly ret60: number;
  readonly gap20: number;
  readonly gap60: number;
  readonly rsi14: number;
  readonly vol20: number;
  readonly drawdown60: number;
  readonly volumeRatio: number;
  readonly recentReturns: readonly number[];
}

export type AssetState = Readonly<Record<string, string | readonly string[]>>;

interface Bucket {
  readonly max: number; // 이 값 미만이면 해당 라벨
  readonly label: string;
  readonly sentiment: number; // mock 엔진 전용 (-1 ~ 1)
}

const TRADING_DAYS_PER_YEAR = 252;

function pctChange(bars: readonly Bar[], index: number, lookback: number): number {
  const from = Math.max(0, index - lookback);
  const base = bars[from]!.close;
  return base > 0 ? bars[index]!.close / base - 1 : 0;
}

function sma(bars: readonly Bar[], index: number, n: number): number {
  const from = Math.max(0, index - n + 1);
  const slice = bars.slice(from, index + 1);
  return slice.reduce((s, b) => s + b.close, 0) / slice.length;
}

function dailyReturns(bars: readonly Bar[], index: number, n: number): number[] {
  const from = Math.max(1, index - n + 1);
  const out: number[] = [];
  for (let i = from; i <= index; i++) {
    const prev = bars[i - 1]!.close;
    out.push(prev > 0 ? bars[i]!.close / prev - 1 : 0);
  }
  return out;
}

function rsi(bars: readonly Bar[], index: number, n = 14): number {
  const rets = dailyReturns(bars, index, n);
  const gains = rets.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const losses = rets.filter((r) => r < 0).reduce((s, r) => s - r, 0);
  if (gains + losses === 0) return 50;
  return (100 * gains) / (gains + losses);
}

function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function avgVolume(bars: readonly Bar[], index: number, n: number): number {
  const slice = bars.slice(Math.max(0, index - n + 1), index + 1);
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

export function computeRawFeatures(bars: readonly Bar[], index: number): RawFeatures {
  if (index < 0 || index >= bars.length) {
    throw new RangeError(`index ${index} out of range (0..${bars.length - 1})`);
  }
  const close = bars[index]!.close;
  const high60 = Math.max(...bars.slice(Math.max(0, index - 59), index + 1).map((b) => b.close));
  const vol20Avg = avgVolume(bars, index, 20);
  return {
    ret5: pctChange(bars, index, 5),
    ret20: pctChange(bars, index, 20),
    ret60: pctChange(bars, index, 60),
    gap20: close / sma(bars, index, 20) - 1,
    gap60: close / sma(bars, index, 60) - 1,
    rsi14: rsi(bars, index),
    vol20: stdev(dailyReturns(bars, index, 20)) * Math.sqrt(TRADING_DAYS_PER_YEAR),
    drawdown60: high60 > 0 ? close / high60 - 1 : 0,
    volumeRatio: vol20Avg > 0 ? avgVolume(bars, index, 5) / vol20Avg : 1,
    recentReturns: padStart(dailyReturns(bars, index, 10), 10),
  };
}

function padStart(values: readonly number[], length: number): number[] {
  return [...Array.from({ length: Math.max(0, length - values.length) }, () => 0), ...values];
}

function returnBuckets(scale: number): Bucket[] {
  return [
    { max: -0.1 * scale, label: 'sharp decline', sentiment: -1 },
    { max: -0.03 * scale, label: 'decline', sentiment: -0.5 },
    { max: 0.03 * scale, label: 'flat', sentiment: 0 },
    { max: 0.1 * scale, label: 'rise', sentiment: 0.5 },
    { max: Infinity, label: 'sharp rise', sentiment: 1 },
  ];
}

const GAP_BUCKETS: Bucket[] = [
  { max: -0.05, label: 'well below its average', sentiment: -0.7 },
  { max: -0.01, label: 'below its average', sentiment: -0.3 },
  { max: 0.01, label: 'near its average', sentiment: 0 },
  { max: 0.05, label: 'above its average', sentiment: 0.3 },
  { max: Infinity, label: 'well above its average', sentiment: 0.7 },
];

const RSI_BUCKETS: Bucket[] = [
  { max: 30, label: 'oversold', sentiment: 0.2 },
  { max: 45, label: 'weak momentum', sentiment: -0.3 },
  { max: 55, label: 'neutral momentum', sentiment: 0 },
  { max: 70, label: 'strong momentum', sentiment: 0.3 },
  { max: Infinity, label: 'overbought', sentiment: -0.1 },
];

const VOLATILITY_BUCKETS: Bucket[] = [
  { max: 0.15, label: 'low volatility', sentiment: 0.1 },
  { max: 0.35, label: 'moderate volatility', sentiment: 0 },
  { max: 0.6, label: 'high volatility', sentiment: -0.2 },
  { max: Infinity, label: 'extreme volatility', sentiment: -0.4 },
];

const DRAWDOWN_BUCKETS: Bucket[] = [
  { max: -0.2, label: 'deep drawdown from recent high', sentiment: -0.6 },
  { max: -0.1, label: 'significant pullback from recent high', sentiment: -0.3 },
  { max: -0.03, label: 'modest pullback from recent high', sentiment: 0 },
  { max: Infinity, label: 'near recent high', sentiment: 0.3 },
];

const VOLUME_BUCKETS: Bucket[] = [
  { max: 0.7, label: 'below-normal trading volume', sentiment: 0 },
  { max: 1.3, label: 'normal trading volume', sentiment: 0 },
  { max: Infinity, label: 'elevated trading volume', sentiment: 0 },
];

const DAILY_MOVE_BUCKETS: Bucket[] = [
  { max: -0.02, label: 'big down', sentiment: -1 },
  { max: -0.003, label: 'down', sentiment: -0.5 },
  { max: 0.003, label: 'flat', sentiment: 0 },
  { max: 0.02, label: 'up', sentiment: 0.5 },
  { max: Infinity, label: 'big up', sentiment: 1 },
];

function bucketize(value: number, buckets: readonly Bucket[]): Bucket {
  return buckets.find((b) => value < b.max) ?? buckets[buckets.length - 1]!;
}

type FieldSpec = readonly [key: string, pick: (f: RawFeatures) => number, buckets: readonly Bucket[]];

const LOW_FIELDS: readonly FieldSpec[] = [
  ['trend_past_month', (f) => f.ret20, returnBuckets(1)],
  ['price_vs_20_day_average', (f) => f.gap20, GAP_BUCKETS],
];

const MEDIUM_FIELDS: readonly FieldSpec[] = [
  ...LOW_FIELDS,
  ['move_past_week', (f) => f.ret5, returnBuckets(0.5)],
  ['trend_past_3_months', (f) => f.ret60, returnBuckets(2)],
  ['price_vs_60_day_average', (f) => f.gap60, GAP_BUCKETS],
  ['momentum_rsi', (f) => f.rsi14, RSI_BUCKETS],
  ['volatility_past_month', (f) => f.vol20, VOLATILITY_BUCKETS],
];

const HIGH_FIELDS: readonly FieldSpec[] = [
  ...MEDIUM_FIELDS,
  ['distance_from_3_month_high', (f) => f.drawdown60, DRAWDOWN_BUCKETS],
  ['volume_past_week', (f) => f.volumeRatio, VOLUME_BUCKETS],
];

const FIELDS_BY_EFFORT: Record<Effort, readonly FieldSpec[]> = {
  low: LOW_FIELDS,
  medium: MEDIUM_FIELDS,
  high: HIGH_FIELDS,
};

/** effort에 따라 Jev에게 보낼 한 종목의 state(라벨)를 만든다 */
export function buildAssetState(features: RawFeatures, effort: Effort): AssetState {
  const entries: [string, string | readonly string[]][] = FIELDS_BY_EFFORT[effort].map(
    ([key, pick, buckets]) => [key, bucketize(pick(features), buckets).label],
  );
  if (effort === 'high') {
    entries.push([
      'daily_moves_last_10_days_oldest_first',
      features.recentReturns.map((r) => bucketize(r, DAILY_MOVE_BUCKETS).label),
    ]);
  }
  return Object.fromEntries(entries);
}

const SENTIMENT_BY_LABEL: ReadonlyMap<string, number> = new Map(
  [
    ...returnBuckets(1), ...GAP_BUCKETS, ...RSI_BUCKETS, ...VOLATILITY_BUCKETS,
    ...DRAWDOWN_BUCKETS, ...VOLUME_BUCKETS,
  ].map((b) => [b.label, b.sentiment]),
);
const DAILY_SENTIMENT: ReadonlyMap<string, number> = new Map(DAILY_MOVE_BUCKETS.map((b) => [b.label, b.sentiment]));

/**
 * mock 엔진 전용: Jev가 보는 것과 동일한 라벨만 가지고 강세/약세 정도를 추정 (-1~1).
 * 실제 Jev 결과가 아니며, API 키가 없을 때 파이프라인을 검증하기 위한 대체물이다.
 */
export function stateSentiment(state: AssetState): number {
  const scores: number[] = [];
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) {
      const daily = value.map((v) => DAILY_SENTIMENT.get(v) ?? 0);
      scores.push(daily.reduce((s, v) => s + v, 0) / Math.max(1, daily.length));
    } else {
      scores.push(SENTIMENT_BY_LABEL.get(value as string) ?? 0);
    }
  }
  const mean = scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length);
  return Math.max(-1, Math.min(1, mean * 2));
}
