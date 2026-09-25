import { z } from 'zod';
import { EFFORTS, MARKETS, STRATEGIES } from '../config.ts';
import { SORT_COLUMNS } from '../db/runRepository.ts';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), '존재하지 않는 날짜입니다');
const KR_TICKER = /^\d{6}(\.(KS|KQ))?$/;
const US_TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
/** BTC 또는 BTC-USD 형식 */
const CRYPTO_TICKER = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,10}(-USD)?$/;
const TICKER_RULES = {
  KR: { pattern: KR_TICKER, hint: '6자리 종목코드(예: 005930)' },
  US: { pattern: US_TICKER, hint: '미국 티커(예: AAPL)' },
  CRYPTO: { pattern: CRYPTO_TICKER, hint: '코인 심볼(예: BTC 또는 BTC-USD)' },
} as const;
const MARKET_ENUM = z.enum(['KR', 'US', 'CRYPTO']);
const MIN_DAYS = 30;
const MAX_YEARS = 10;
const MAX_TICKERS = 5;

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export const createRunSchema = z.object({
  nickname: z.string().trim().min(1, '닉네임을 입력하세요').max(20, '닉네임은 20자 이하')
    .regex(/^[\p{L}\p{N}_\-. ]+$/u, '닉네임에는 문자·숫자·_-. 만 사용할 수 있습니다'),
  market: MARKET_ENUM,
  tickers: z.array(z.string().trim().toUpperCase()).min(1, '종목을 1개 이상 입력하세요').max(MAX_TICKERS, `종목은 최대 ${MAX_TICKERS}개`),
  startDate: DATE,
  endDate: DATE,
  initialCapital: z.number().finite().min(100, '초기 자본이 너무 작습니다').max(1e12),
  engine: z.enum(['live', 'mock']),
  execution: z.enum(['open', 'vwap']).default('open'),
  strategies: z.array(z.enum(STRATEGIES as [string, ...string[]])).min(1, '전략을 1개 이상 선택하세요'),
  efforts: z.array(z.enum(EFFORTS as [string, ...string[]])).min(1, 'effort를 1개 이상 선택하세요'),
  intervals: z.array(z.number().int()).min(1, '매매 주기를 1개 이상 선택하세요'),
}).superRefine((v, ctx) => {
  const rule = TICKER_RULES[v.market];
  v.tickers.forEach((t, i) => {
    if (!rule.pattern.test(t)) ctx.addIssue({ code: 'custom', path: ['tickers', i], message: `${t}: ${rule.hint} 형식이 아닙니다` });
  });
  const allowed = MARKETS[v.market].intervals.map((i) => i.days);
  v.intervals.forEach((d, i) => {
    if (!allowed.includes(d)) ctx.addIssue({ code: 'custom', path: ['intervals', i], message: `지원하지 않는 매매 주기입니다 (${MARKETS[v.market].label}: ${allowed.join('/')}일)` });
  });
  // 오늘(UTC) 일봉은 장중 미완성일 수 있으므로 어제까지만 허용
  const today = new Date().toISOString().slice(0, 10);
  if (v.endDate >= today) ctx.addIssue({ code: 'custom', path: ['endDate'], message: '종료일은 오늘 이전이어야 합니다' });
  if (v.startDate < '2000-01-01') ctx.addIssue({ code: 'custom', path: ['startDate'], message: '시작일은 2000-01-01 이후여야 합니다' });
  const span = daysBetween(v.startDate, v.endDate);
  if (span < MIN_DAYS) ctx.addIssue({ code: 'custom', path: ['endDate'], message: `기간은 최소 ${MIN_DAYS}일 이상이어야 합니다` });
  if (span > MAX_YEARS * 366) ctx.addIssue({ code: 'custom', path: ['startDate'], message: `기간은 최대 ${MAX_YEARS}년입니다` });
});

export type CreateRunInput = z.infer<typeof createRunSchema>;

const optionalInt = z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().positive().optional());
const optionalStr = z.string().trim().max(40).optional().transform((v) => (v ? v : undefined));

export const rankQuerySchema = z.object({
  market: MARKET_ENUM.optional().or(z.literal('').transform(() => undefined)),
  engine: z.enum(['live', 'mock']).optional().or(z.literal('').transform(() => undefined)),
  effort: z.enum(EFFORTS as [string, ...string[]]).optional().or(z.literal('').transform(() => undefined)),
  strategy: z.enum(STRATEGIES as [string, ...string[]]).optional().or(z.literal('').transform(() => undefined)),
  intervalDays: optionalInt,
  startDate: DATE.optional().or(z.literal('').transform(() => undefined)),
  endDate: DATE.optional().or(z.literal('').transform(() => undefined)),
  nickname: optionalStr,
  execution: z.enum(['open', 'vwap']).optional().or(z.literal('').transform(() => undefined)),
  sort: z.enum(SORT_COLUMNS).default('total_return'),
  limit: z.preprocess((v) => (v == null || v === '' ? 50 : Number(v)), z.number().int().min(1).max(200)),
  bestPerUser: z.preprocess((v) => v === 'true' || v === '1', z.boolean()),
});

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join(' / ');
}

export const collectSchema = z.object({
  market: MARKET_ENUM,
  tickers: z.array(z.string().trim().toUpperCase().regex(/^(\d{6}(\.(KS|KQ))?|[A-Z^][A-Z0-9.\-]{0,9}|[A-Z0-9]{2,10}(-USD)?)$/, '종목 형식이 올바르지 않습니다')).min(1).max(10),
});
