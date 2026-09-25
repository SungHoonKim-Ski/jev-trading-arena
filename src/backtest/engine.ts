import type { Bar, EquityPoint, Trade } from '../types.ts';

export interface DecideContext {
  readonly date: string;
  /** 결정일 당일까지의 각 종목 Bar 인덱스(해당 인덱스 이후 데이터 사용 금지) */
  readonly barIndex: Readonly<Record<string, number>>;
  /** 종목 슬롯 대비 현재 보유 비중 (0~1) */
  readonly currentWeights: Readonly<Record<string, number>>;
  readonly step: number;
  readonly totalSteps: number;
}

/** 종목별 목표 비중(0~1) 또는 null(유지) */
export type DecideFn = (ctx: DecideContext) => Promise<Readonly<Record<string, number | null>>>;

export interface SimulationInput {
  readonly symbols: readonly string[];
  readonly bars: Readonly<Record<string, readonly Bar[]>>;
  readonly startDate: string;
  readonly endDate: string;
  readonly intervalDays: number;
  readonly initialCapital: number;
  readonly buyFeeRate: number;
  readonly sellFeeRate: number;
  readonly decide: DecideFn;
  /** 체결가 결정 함수. null을 반환하면 해당 일 시가로 체결 */
  readonly fillPrice?: (symbol: string, date: string) => number | null;
  /** 최소 매매 단위 (기본 1주, 코인은 0.00000001개) */
  readonly lotSize?: number;
}

export interface SimulationResult {
  readonly equity: readonly EquityPoint[];
  readonly trades: readonly Trade[];
}

interface Portfolio {
  readonly cash: number;
  readonly shares: Readonly<Record<string, number>>;
}

interface Market {
  readonly calendar: readonly string[];
  readonly indexOf: Readonly<Record<string, ReadonlyMap<string, number>>>;
}

function buildMarket(input: SimulationInput): Market {
  const dates = new Set<string>();
  const indexOf: Record<string, Map<string, number>> = {};
  for (const s of input.symbols) {
    const bars = input.bars[s] ?? [];
    indexOf[s] = new Map(bars.map((b, i) => [b.date, i]));
    for (const b of bars) if (b.date >= input.startDate && b.date <= input.endDate) dates.add(b.date);
  }
  return { calendar: [...dates].sort(), indexOf };
}

/** date 이하의 가장 최근 Bar 인덱스 */
function lastIndexAtOrBefore(bars: readonly Bar[], date: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function markPrice(input: SimulationInput, symbol: string, date: string, field: 'open' | 'close'): number | null {
  const bars = input.bars[symbol] ?? [];
  const i = lastIndexAtOrBefore(bars, date);
  if (i < 0) return null;
  return bars[i]!.date === date ? bars[i]![field] : bars[i]!.close;
}

function portfolioValue(input: SimulationInput, p: Portfolio, date: string, field: 'open' | 'close'): number {
  return input.symbols.reduce((sum, s) => sum + (p.shares[s] ?? 0) * (markPrice(input, s, date, field) ?? 0), p.cash);
}

function currentWeights(input: SimulationInput, p: Portfolio, date: string): Record<string, number> {
  const slot = portfolioValue(input, p, date, 'close') / input.symbols.length;
  return Object.fromEntries(input.symbols.map((s) => {
    const value = (p.shares[s] ?? 0) * (markPrice(input, s, date, 'close') ?? 0);
    return [s, slot > 0 ? Math.round((value / slot) * 1e6) / 1e6 : 0];
  }));
}

interface Order { readonly symbol: string; readonly target: number }

/** 시가에 목표 비중으로 리밸런싱. 매도 먼저, 이후 현금 한도 내 매수 */
/** 수량을 매매 단위로 내림. 부동소수 오차를 없애려고 단위 개수(정수)로 계산 */
function roundLots(quantity: number, lot: number): number {
  const lots = Math.floor(quantity / lot + 1e-9);
  return lot >= 1 ? lots * lot : Number((lots * lot).toFixed(12));
}

function execute(input: SimulationInput, p: Portfolio, orders: readonly Order[], date: string): { portfolio: Portfolio; trades: Trade[] } {
  const lot = input.lotSize ?? 1;
  const slot = portfolioValue(input, p, date, 'open') / input.symbols.length;
  const plans = orders.map((o) => {
    const price = input.fillPrice?.(o.symbol, date) ?? markPrice(input, o.symbol, date, 'open')!;
    const held = p.shares[o.symbol] ?? 0;
    return { ...o, price, held, delta: roundLots((slot * o.target) / price, lot) - held };
  });
  const trades: Trade[] = [];
  let cash = p.cash;
  let shares = { ...p.shares };
  for (const plan of plans.filter((x) => x.delta < 0)) {
    const qty = -plan.delta;
    const fee = qty * plan.price * input.sellFeeRate;
    cash += qty * plan.price - fee;
    shares = { ...shares, [plan.symbol]: plan.held - qty };
    trades.push({ date, symbol: plan.symbol, side: 'sell', shares: qty, price: plan.price, fee });
  }
  for (const plan of plans.filter((x) => x.delta > 0)) {
    const affordable = roundLots(cash / (plan.price * (1 + input.buyFeeRate)), lot);
    const qty = Math.min(plan.delta, affordable);
    if (qty <= 0) continue;
    const fee = qty * plan.price * input.buyFeeRate;
    cash -= qty * plan.price + fee;
    shares = { ...shares, [plan.symbol]: plan.held + qty };
    trades.push({ date, symbol: plan.symbol, side: 'buy', shares: qty, price: plan.price, fee });
  }
  return { portfolio: { cash, shares }, trades };
}

/**
 * 동일비중 매수 후 보유 벤치마크.
 * 전략과 같은 조건으로 첫 체결 가능일(두 번째 거래일) 시가에 매수하고, 수수료 없이 소수점 주식을 허용한다.
 * 기간 중 상장한 종목의 슬롯은 첫 거래일까지 현금으로 보유한다.
 */
function benchmarkSeries(input: SimulationInput, calendar: readonly string[]): number[] {
  const buyDate = calendar[Math.min(1, calendar.length - 1)]!;
  const slot = input.initialCapital / input.symbols.length;
  const entries = input.symbols.map((s) => (input.bars[s] ?? []).find((b) => b.date >= buyDate) ?? null);
  return calendar.map((d) => input.symbols.reduce((sum, s, i) => {
    const entry = entries[i];
    if (!entry || d < entry.date) return sum + slot;
    return sum + (slot / entry.open) * (markPrice(input, s, d, 'close') ?? entry.open);
  }, 0));
}

function barIndexAt(input: SimulationInput, date: string): Record<string, number> {
  return Object.fromEntries(input.symbols.map((s) => [s, lastIndexAtOrBefore(input.bars[s] ?? [], date)]));
}

/**
 * 백테스트 시뮬레이션.
 * - intervalDays 거래일마다 종가 기준으로 decide 호출
 * - 결정은 다음 거래일 시가에 체결 (해당 종목 거래가 없으면 다음 거래일로 이월)
 */
export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  const market = buildMarket(input);
  const { calendar } = market;
  if (calendar.length === 0) throw new Error('no trading days in the selected period');
  const interval = Math.max(1, Math.floor(input.intervalDays));
  const totalSteps = Math.ceil((calendar.length - 1) / interval);
  const bench = benchmarkSeries(input, calendar);

  let portfolio: Portfolio = { cash: input.initialCapital, shares: {} };
  let pending: Readonly<Record<string, number>> = {};
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];

  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d]!;
    const ready = Object.entries(pending).filter(([s]) => market.indexOf[s]!.has(date));
    if (ready.length > 0) {
      const result = execute(input, portfolio, ready.map(([symbol, target]) => ({ symbol, target })), date);
      portfolio = result.portfolio;
      trades.push(...result.trades);
      pending = Object.fromEntries(Object.entries(pending).filter(([s]) => !market.indexOf[s]!.has(date)));
    }
    if (d % interval === 0 && d < calendar.length - 1) {
      const targets = await input.decide({
        date, barIndex: barIndexAt(input, date), currentWeights: currentWeights(input, portfolio, date),
        step: d / interval, totalSteps,
      });
      // 새 결정이 나오면 아직 체결되지 않은 이전 주문은 폐기한다 (오래된 판단으로 체결되는 것 방지)
      const next = Object.entries(targets).filter((e): e is [string, number] => e[1] !== null && input.symbols.includes(e[0]));
      pending = Object.fromEntries(next);
    }
    equity.push({ date, equity: portfolioValue(input, portfolio, date, 'close'), benchmark: bench[d]! });
  }
  return { equity, trades };
}
