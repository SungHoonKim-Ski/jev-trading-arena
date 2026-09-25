/** 코인별 하루 원본 틱 저장 크기 추정치 (2026-09 바이낸스 실측 기반, DuckDB 압축 후) */
export const TICK_DAY_BYTES: Readonly<Record<string, number>> = {
  BTCUSDT: 37e6, ETHUSDT: 33e6, SOLUSDT: 16e6, XRPUSDT: 23e6, BNBUSDT: 11e6,
};
const DEFAULT_DAY_BYTES = 37e6;
const DAY_MS = 86_400_000;

export interface TickNeedInput {
  readonly symbols: readonly string[];
  readonly startDate: string;
  readonly endDate: string;
  /** 요청의 모든 매매 주기 (체결일 합집합으로 계산) */
  readonly intervals: readonly number[];
}

/**
 * 틱 체결 백테스트가 새로 받아야 할 틱 용량 추정.
 * 코인은 매일 거래하므로 결정일 = 시작일 + k×주기, 체결일 = 결정일 다음 날 (종료일 이내).
 */
export function estimateTickBytes(input: TickNeedInput, stored: ReadonlyMap<string, ReadonlySet<string>>): { days: number; bytes: number } {
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const fillDates = new Set<string>();
  for (const interval of input.intervals) {
    for (let t = start; t + DAY_MS <= end; t += interval * DAY_MS) fillDates.add(new Date(t + DAY_MS).toISOString().slice(0, 10));
  }
  let days = 0;
  let bytes = 0;
  for (const symbol of input.symbols) {
    const have = stored.get(symbol) ?? new Set<string>();
    const missing = [...fillDates].filter((d) => !have.has(d)).length;
    days += missing;
    bytes += missing * (TICK_DAY_BYTES[symbol] ?? DEFAULT_DAY_BYTES);
  }
  return { days, bytes };
}
