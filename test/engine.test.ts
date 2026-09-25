import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, type DecideFn } from '../src/backtest/engine.ts';
import { computeMetrics } from '../src/backtest/metrics.ts';
import { barsFromCloses, linearCloses } from './helpers.ts';

const base = { buyFeeRate: 0, sellFeeRate: 0, initialCapital: 1000 };

test('simulate: 결정은 종가 기준, 체결은 다음 거래일 시가', async () => {
  const bars = barsFromCloses([10, 20, 30, 40]);
  const seen: string[] = [];
  const decide: DecideFn = async (ctx) => { seen.push(ctx.date); return { A: 1 }; };
  const r = await simulate({ ...base, symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[3]!.date, intervalDays: 2, decide });
  assert.deepEqual(seen, [bars[0]!.date, bars[2]!.date]);
  assert.equal(r.trades[0]!.date, bars[1]!.date);
  assert.equal(r.trades[0]!.price, 20);
  assert.equal(r.trades[0]!.shares, 50);
  assert.equal(r.equity.at(-1)!.equity, 50 * 40);
});

test('simulate: decide에는 결정일까지의 데이터 인덱스만 전달(룩어헤드 없음)', async () => {
  const bars = barsFromCloses(linearCloses(100, 1, 30));
  const decide: DecideFn = async (ctx) => {
    const idx = ctx.barIndex.A!;
    assert.equal(bars[idx]!.date, ctx.date);
    return { A: null };
  };
  await simulate({ ...base, symbols: ['A'], bars: { A: bars }, startDate: bars[10]!.date, endDate: bars[29]!.date, intervalDays: 1, decide });
});

test('simulate: 수수료·세금 반영, 매도 후 현금 증가', async () => {
  const bars = barsFromCloses([10, 10, 10, 10, 10]);
  let step = 0;
  const decide: DecideFn = async () => (step++ === 0 ? { A: 1 } : { A: 0 });
  const r = await simulate({ symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[4]!.date, intervalDays: 1, initialCapital: 1000, buyFeeRate: 0.01, sellFeeRate: 0.02, decide });
  const buy = r.trades.find((t) => t.side === 'buy')!;
  const sell = r.trades.find((t) => t.side === 'sell')!;
  assert.equal(buy.shares, 99); // 1000 / (10*1.01)
  assert.ok(Math.abs(buy.fee - 9.9) < 1e-9);
  assert.equal(sell.shares, 99);
  assert.ok(r.equity.at(-1)!.equity < 1000);
});

test('simulate: 여러 종목은 동일 슬롯으로 배분, 현재 비중 전달', async () => {
  const a = barsFromCloses([10, 10, 10, 10]);
  const b = barsFromCloses([25, 25, 25, 25]); // 정수 주식: 250/25=10주
  const weights: Record<string, number>[] = [];
  const decide: DecideFn = async (ctx) => { weights.push({ ...ctx.currentWeights }); return { A: 1, B: 0.5 }; };
  const r = await simulate({ ...base, symbols: ['A', 'B'], bars: { A: a, B: b }, startDate: a[0]!.date, endDate: a[3]!.date, intervalDays: 2, decide });
  assert.deepEqual(weights[0], { A: 0, B: 0 });
  assert.equal(weights[1]!.A, 1);
  assert.equal(weights[1]!.B, 0.5);
  assert.equal(r.trades.length, 2);
});

test('simulate: 벤치마크는 전략과 같은 첫 체결일 시가에 동일비중 매수 후 보유', async () => {
  const bars = barsFromCloses([10, 20, 40]);
  const r = await simulate({ ...base, symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[2]!.date, intervalDays: 1, decide: async () => ({ A: null }) });
  assert.equal(r.equity[0]!.benchmark, 1000);
  assert.equal(r.equity[1]!.benchmark, 1000); // 20에 매수
  assert.equal(r.equity[2]!.benchmark, 2000);
  assert.equal(r.equity[2]!.equity, 1000);
});

test('simulate: 기간 중 상장한 종목의 벤치마크 슬롯은 상장 전까지 현금', async () => {
  const a = barsFromCloses([10, 10, 10, 10]);
  const b = barsFromCloses([50, 50], a[2]!.date);
  const r = await simulate({ ...base, symbols: ['A', 'B'], bars: { A: a, B: b }, startDate: a[0]!.date, endDate: a[3]!.date, intervalDays: 1, decide: async () => ({}) });
  assert.deepEqual(r.equity.map((p) => p.benchmark), [1000, 1000, 1000, 1000]);
});

test('simulate: 체결 전에 새 결정(유지)이 나오면 이전 대기 주문은 폐기', async () => {
  const a = barsFromCloses([10, 10, 10, 10, 10]);
  const b = [a[0]!, a[3]!, a[4]!].map((bar) => ({ ...bar, open: 5, close: 5 })); // B는 1,2일차 거래 없음
  let step = 0;
  const decide: DecideFn = async () => (step++ === 0 ? { A: null, B: 1 } : { A: null, B: null });
  const r = await simulate({ ...base, symbols: ['A', 'B'], bars: { A: a, B: b }, startDate: a[0]!.date, endDate: a[4]!.date, intervalDays: 1, decide });
  assert.equal(r.trades.length, 0);
});

test('simulate: 기간 내 데이터가 없으면 예외', async () => {
  const bars = barsFromCloses([10, 20]);
  await assert.rejects(simulate({ ...base, symbols: ['A'], bars: { A: bars }, startDate: '2030-01-01', endDate: '2030-02-01', intervalDays: 1, decide: async () => ({}) }), /no trading days/);
});

test('computeMetrics: 수익률·MDD·CAGR', () => {
  const pts = [100, 120, 90, 110].map((e, i) => ({ date: `2024-01-0${i + 1}`, equity: e, benchmark: 100 }));
  const m = computeMetrics(pts, [], 100);
  assert.ok(Math.abs(m.totalReturn - 0.1) < 1e-9);
  assert.ok(Math.abs(m.mdd - (-0.25)) < 1e-9);
  assert.ok(Number.isFinite(m.sharpe));
  assert.equal(m.trades, 0);
  const flat = computeMetrics([{ date: '2024-01-01', equity: 100, benchmark: 100 }], [], 100);
  assert.equal(flat.sharpe, 0);
  assert.equal(flat.cagr, 0);
});

test('simulate: fillPrice가 주어지면 해당 가격으로 체결(VWAP 등), null이면 시가', async () => {
  const bars = barsFromCloses([10, 20, 30, 40]);
  let step = 0;
  const decide: DecideFn = async () => (step++ === 0 ? { A: 1 } : { A: 0 });
  const r = await simulate({
    ...base, symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[3]!.date, intervalDays: 1, decide,
    fillPrice: (symbol, date) => (symbol === 'A' && date === bars[1]!.date ? 25 : null),
  });
  assert.equal(r.trades[0]!.price, 25);
  assert.equal(r.trades[0]!.shares, 40);
  assert.equal(r.trades[1]!.price, 30);
});

test('simulate: fillPrice에 매매 방향과 시가 기준 예상 수량 전달, 비동기 지원', async () => {
  const bars = barsFromCloses([10, 20, 20, 20]);
  const calls: [string, number][] = [];
  let step = 0;
  const decide: DecideFn = async () => (step++ === 0 ? { A: 1 } : { A: 0 });
  const r = await simulate({
    ...base, symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[3]!.date, intervalDays: 1, decide,
    fillPrice: async (_s, _d, side, qty) => { calls.push([side, qty]); return side === 'buy' ? 25 : 18; },
  });
  assert.deepEqual(calls, [['buy', 50], ['sell', 40]]);
  assert.equal(r.trades[0]!.shares, 40); // 1000/25
  assert.equal(r.trades[1]!.price, 18);
});
