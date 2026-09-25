import path from 'node:path';
import type { Effort, Market, Strategy } from './types.ts';

const root = path.resolve(import.meta.dirname, '..');

export const CONFIG = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'trading.db'),
  publicDir: path.join(root, 'public'),
  jev: {
    apiKey: process.env.TYPESAFE_API_KEY ?? '',
    baseUrl: process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai',
    model: process.env.JEV_MODEL ?? 'jev-latest',
    usdPerInputToken: 0.042 / 1_000_000,
    timeoutMs: 30_000,
    maxRetries: 4,
  },
  maxConcurrentRuns: 2,
  /** 분봉 주기 수집 간격 (Yahoo 1분봉은 30일만 보관되므로 최소 하루 1회 이상) */
  intradayCollectEveryMs: Number(process.env.INTRADAY_COLLECT_EVERY_MS ?? 6 * 3600_000),
  intradayCollectEnabled: process.env.INTRADAY_COLLECT !== 'off',
  maxRunsPerRequest: 24,
  rateLimit: { windowMs: 60_000, maxCreates: 20 },
} as const;

export const MARKETS: Record<Market, {
  readonly label: string;
  readonly currency: string;
  readonly indexSymbol: string;
  readonly indexName: string;
  readonly buyFeeRate: number;
  readonly sellFeeRate: number; // 수수료 + 거래세
  readonly defaultCapital: number;
}> = {
  KR: {
    label: '한국', currency: 'KRW', indexSymbol: '^KS11', indexName: 'KOSPI',
    buyFeeRate: 0.00015, sellFeeRate: 0.00015 + 0.002, defaultCapital: 10_000_000,
  },
  US: {
    label: '미국', currency: 'USD', indexSymbol: '^GSPC', indexName: 'S&P 500',
    buyFeeRate: 0.0, sellFeeRate: 0.0, defaultCapital: 10_000,
  },
};

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
export const STRATEGIES: readonly Strategy[] = ['choice', 'probability', 'noul', 'score'];
export const INTERVALS: readonly { readonly days: number; readonly label: string }[] = [
  { days: 1, label: '매일' },
  { days: 5, label: '매주' },
  { days: 10, label: '격주' },
  { days: 21, label: '매월' },
];

export const STRATEGY_INFO: Record<Strategy, { readonly label: string; readonly description: string }> = {
  choice: { label: 'Choice 결정', description: '매수/보유/매도 중 가장 확률이 높은 선택지를 그대로 실행' },
  probability: { label: 'Choice 확률', description: '매수·보유·매도 확률분포로 목표 비중을 연속적으로 산정' },
  noul: { label: 'Noul 예/아니오', description: '"앞으로 오를까?" 예/아니오 확률이 임계값을 넘으면 매수, 밑돌면 매도' },
  score: { label: 'Score 등급', description: '강력매도~강력매수 5단계 등급의 기대값을 목표 비중으로 사용' },
};

export const EFFORT_INFO: Record<Effort, { readonly label: string; readonly description: string; readonly perspectives: number }> = {
  low: { label: 'Low', description: '핵심 지표 2개 + 단일 관점 질문 1개', perspectives: 1 },
  medium: { label: 'Medium', description: '지표 7개 + 단기·추세 관점 2개 앙상블', perspectives: 2 },
  high: { label: 'High', description: '지표 9개 + 최근 10일 일별 흐름 + 관점 3개 앙상블 + 신뢰도 게이팅', perspectives: 3 },
};

/** 목표 비중 변화가 이 값보다 작으면 매매하지 않는다(과매매 방지) */
export const REBALANCE_THRESHOLD = 0.1;
/** high effort에서 이 신뢰도 미만이면 기존 비중 유지 */
export const HIGH_EFFORT_MIN_CONFIDENCE = 0.35;
export const NOUL_BUY_THRESHOLD = 0.6;
export const NOUL_SELL_THRESHOLD = 0.4;
export const WARMUP_CALENDAR_DAYS = 120;
