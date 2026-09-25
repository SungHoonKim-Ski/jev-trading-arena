import path from 'node:path';
import type { Effort, Market, Strategy } from './types.ts';

export interface TickConfig {
  readonly enabled: boolean;
  readonly path: string;
  readonly maxBytes: number;
  readonly participation: number;
  readonly dailyCollect: boolean;
}

/** 원본 틱 설정. 잘못된 값은 조용히 넘기지 않고 시작 시 실패시킨다 */
export function readTickConfig(env: Readonly<Record<string, string | undefined>>, rootDir: string): TickConfig {
  const maxGb = Number(env.TICK_STORE_MAX_GB ?? 10);
  if (!Number.isFinite(maxGb) || maxGb <= 0) throw new Error(`TICK_STORE_MAX_GB는 0보다 큰 숫자여야 합니다 (현재: ${env.TICK_STORE_MAX_GB})`);
  const participation = Number(env.TICK_PARTICIPATION ?? 0.1);
  if (!Number.isFinite(participation) || participation <= 0 || participation > 1) {
    throw new Error(`TICK_PARTICIPATION은 0보다 크고 1 이하인 숫자여야 합니다 (현재: ${env.TICK_PARTICIPATION})`);
  }
  return {
    enabled: env.TICKS !== 'off',
    path: env.TICK_STORE_PATH ?? path.join(rootDir, 'data', 'ticks.duckdb'),
    maxBytes: maxGb * 1e9,
    participation,
    dailyCollect: env.TICK_DAILY_COLLECT !== 'off',
  };
}

// 번들(Vercel) 환경에서는 import.meta.dirname이 없을 수 있다
const root = import.meta.dirname ? path.resolve(import.meta.dirname, '..') : process.cwd();

export const CONFIG = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'trading.db'),
  tursoUrl: process.env.TURSO_DATABASE_URL ?? '',
  tursoToken: process.env.TURSO_AUTH_TOKEN,
  cronSecret: process.env.CRON_SECRET ?? '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  /** 서버리스에서 이 시간 이상 running에 멈춘 실행은 크론이 다시 대기열로 되돌린다 */
  staleRunMs: 15 * 60_000,
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
  ticks: readTickConfig(process.env, root),
  /** 로컬 서버 수신 주소. 기본은 이 컴퓨터에서만 접속 가능 (외부 공개 시 HOST=0.0.0.0) */
  host: process.env.HOST ?? '127.0.0.1',
  /** 프록시(Vercel 등) 뒤에서만 X-Forwarded-For를 믿는다 */
  trustProxy: process.env.TRUST_PROXY === '1' || Boolean(process.env.VERCEL),

  maxRunsPerRequest: 24,
  rateLimit: { windowMs: 60_000, maxCreates: 20 },
} as const;

export interface IntervalOption { readonly days: number; readonly label: string }

export interface MarketConfig {
  readonly label: string;
  readonly currency: string;
  /** 벤치마크 지수(코인은 비트코인) */
  readonly indexSymbol: string;
  readonly indexName: string;
  readonly buyFeeRate: number;
  readonly sellFeeRate: number; // 수수료 + 거래세
  readonly defaultCapital: number;
  /** 연환산 기준 거래일 수 (주식 252, 24시간 거래 코인 365) */
  readonly periodsPerYear: number;
  /** 최소 매매 단위 (주식 1주, 코인 0.00000001개) */
  readonly lotSize: number;
  /** 매매 주기 선택지 (거래일 단위) */
  readonly intervals: readonly IntervalOption[];
  /** Jev 질문에 쓰는 자산 명칭과 기간 단위 */
  readonly assetNoun: 'stock' | 'cryptocurrency';
  readonly dayUnit: 'trading days' | 'days';
}

const STOCK_INTERVALS: readonly IntervalOption[] = [
  { days: 1, label: '매일' }, { days: 5, label: '매주' }, { days: 10, label: '격주' }, { days: 21, label: '매월' },
];
const CRYPTO_INTERVALS: readonly IntervalOption[] = [
  { days: 1, label: '매일' }, { days: 7, label: '매주' }, { days: 14, label: '격주' }, { days: 30, label: '매월' },
];

export const MARKETS: Record<Market, MarketConfig> = {
  KR: {
    label: '한국', currency: 'KRW', indexSymbol: '^KS11', indexName: 'KOSPI',
    buyFeeRate: 0.00015, sellFeeRate: 0.00015 + 0.002, defaultCapital: 10_000_000,
    periodsPerYear: 252, lotSize: 1, intervals: STOCK_INTERVALS, assetNoun: 'stock', dayUnit: 'trading days',
  },
  US: {
    label: '미국', currency: 'USD', indexSymbol: '^GSPC', indexName: 'S&P 500',
    buyFeeRate: 0.0, sellFeeRate: 0.0, defaultCapital: 10_000,
    periodsPerYear: 252, lotSize: 1, intervals: STOCK_INTERVALS, assetNoun: 'stock', dayUnit: 'trading days',
  },
  CRYPTO: {
    // 바이낸스 USDT 마켓 기준 (1 USDT ≈ 1 USD로 표시)
    label: '코인', currency: 'USD', indexSymbol: 'BTCUSDT', indexName: '비트코인',
    // 바이낸스 일반 등급 기준 매수·매도 각 0.1%
    buyFeeRate: 0.001, sellFeeRate: 0.001, defaultCapital: 10_000,
    periodsPerYear: 365, lotSize: 1e-8, intervals: CRYPTO_INTERVALS, assetNoun: 'cryptocurrency', dayUnit: 'days',
  },
};

/** 모든 시장의 매매 주기 (라벨 조회·필터용, 중복 제거) */
export const ALL_INTERVALS: readonly IntervalOption[] = [...new Map(
  [...STOCK_INTERVALS, ...CRYPTO_INTERVALS].map((i) => [i.days, i]),
).values()].sort((a, b) => a.days - b.days);

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
export const STRATEGIES: readonly Strategy[] = ['choice', 'probability', 'noul', 'score'];

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
/** 사용자가 고르는 확신 임계값: Jev가 이 확률 이상일 때만 사고판다 */
export const THRESHOLDS: readonly number[] = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
export const DEFAULT_THRESHOLD = 0.8;
export const EXIT_RULES = {
  opposite: { label: '반대 확신 매도', description: '내릴 확률이 임계값 이상일 때만 판다. 애매하면 보유 유지 (거래 적음)' },
  drop: { label: '확신 떨어지면 즉시 매도', description: '오를 확률이 임계값 밑으로 내려가면 바로 판다 (거래 잦음)' },
} as const;
export const WARMUP_CALENDAR_DAYS = 120;
