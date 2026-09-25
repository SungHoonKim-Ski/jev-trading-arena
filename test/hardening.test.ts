import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTickConfig } from '../src/config.ts';
import { estimateTickBytes, TICK_DAY_BYTES } from '../src/ticks/estimate.ts';
import { clientIp } from '../src/api/http.ts';
import { simulate } from '../src/backtest/engine.ts';
import { barsFromCloses } from './helpers.ts';
import type { IncomingMessage } from 'node:http';

test('readTickConfig: 기본값, 잘못된 참여율·용량은 시작 시 예외', () => {
  const d = readTickConfig({}, '/tmp');
  assert.equal(d.participation, 0.1);
  assert.equal(d.maxBytes, 10e9);
  assert.throws(() => readTickConfig({ TICK_PARTICIPATION: 'abc' }, '/tmp'), /TICK_PARTICIPATION/);
  assert.throws(() => readTickConfig({ TICK_PARTICIPATION: '1.5' }, '/tmp'), /TICK_PARTICIPATION/);
  assert.throws(() => readTickConfig({ TICK_STORE_MAX_GB: '-1' }, '/tmp'), /TICK_STORE_MAX_GB/);
  assert.throws(() => readTickConfig({ TICK_STORE_MAX_GB: 'x' }, '/tmp'), /TICK_STORE_MAX_GB/);
});

test('estimateTickBytes: 체결 예정일 × 코인, 이미 저장된 날은 제외', () => {
  const base = { symbols: ['BTCUSDT', 'ETHUSDT'], startDate: '2025-01-01', endDate: '2025-01-29', intervals: [7] };
  const all = estimateTickBytes(base, new Map());
  // 결정일 1/1, 1/8, 1/15, 1/22 → 체결일 1/2, 1/9, 1/16, 1/23 (마지막 결정일 1/29는 체결 없음)
  assert.equal(all.days, 8);
  assert.equal(all.bytes, 4 * (TICK_DAY_BYTES.BTCUSDT! + TICK_DAY_BYTES.ETHUSDT!));
  const stored = estimateTickBytes(base, new Map([['BTCUSDT', new Set(['2025-01-02', '2025-01-09'])]]));
  assert.equal(stored.days, 6);
  const daily = estimateTickBytes({ ...base, intervals: [7, 1] }, new Map());
  assert.equal(daily.days, 2 * 28, '여러 주기는 체결일 합집합');
});

function req(headers: Record<string, string>, remote = '10.0.0.5'): IncomingMessage {
  return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
}

test('clientIp: 프록시를 믿지 않으면 X-Forwarded-For 무시', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), false), '10.0.0.5');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), true), '1.2.3.4');
  assert.equal(clientIp(req({}), true), '10.0.0.5');
});

test('engine: 체결가 반영 후 매매 방향이 뒤집히면 거래하지 않음', async () => {
  // 비중 0.5 보유 중 목표 0.5 유지 주문: 시가 기준으로는 소폭 매수지만, 체결가가 높으면 매도로 뒤집힘
  const bars = barsFromCloses([100, 100, 100, 100]);
  let step = 0;
  const r = await simulate({
    symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[3]!.date, intervalDays: 1,
    initialCapital: 1000, buyFeeRate: 0, sellFeeRate: 0, lotSize: 0.01,
    decide: async () => (step++ === 0 ? { A: 0.5 } : step === 2 ? { A: 0.5049 } : { A: null }),
    fillPrice: (_s, date, side) => (date === bars[2]!.date && side === 'buy' ? 101 : null),
  });
  assert.equal(r.trades.length, 1, JSON.stringify(r.trades));
});

test('engine: 체결가 반영 후 수량이 크게 달라지면 최종 수량으로 한 번 다시 계산', async () => {
  const bars = barsFromCloses([100, 100, 100]);
  const quotes: number[] = [];
  const r = await simulate({
    symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[2]!.date, intervalDays: 1,
    initialCapital: 1000, buyFeeRate: 0, sellFeeRate: 0, lotSize: 0.01, decide: async () => ({ A: 1 }),
    fillPrice: (_s, _d, _side, qty) => { quotes.push(qty); return qty > 9 ? 125 : 120; },
  });
  assert.deepEqual(quotes, [10, 8]);
  assert.equal(r.trades[0]!.price, 120);
  assert.equal(r.trades[0]!.shares, 8.33);
});

test('실행 검증: 전략을 생략하면 오를까?(noul)로, 다른 질문 방식은 거부', async () => {
  const { createRunSchema } = await import('../src/api/validation.ts');
  const base = { nickname: 'a', market: 'US', tickers: ['AAPL'], startDate: '2025-01-01', endDate: '2025-06-30', initialCapital: 10000, engine: 'mock', efforts: ['low'], intervals: [5] };
  const ok = createRunSchema.safeParse(base);
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data!.strategies, ['noul']);
  assert.equal(createRunSchema.safeParse({ ...base, strategies: ['probability'] }).success, false);
});
