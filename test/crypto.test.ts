import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateSymbols } from '../src/market/yahoo.ts';
import { simulate } from '../src/backtest/engine.ts';
import { computeMetrics } from '../src/backtest/metrics.ts';
import { computeRawFeatures } from '../src/market/features.ts';
import { buildJevRequest, questionId } from '../src/jev/questions.ts';
import { createRunSchema } from '../src/api/validation.ts';
import { MARKETS } from '../src/config.ts';
import { barsFromCloses, linearCloses } from './helpers.ts';

test('candidateSymbols: 코인은 BTC → BTC-USD로 정규화', () => {
  assert.deepEqual(candidateSymbols('CRYPTO', 'btc'), ['BTC-USD']);
  assert.deepEqual(candidateSymbols('CRYPTO', 'ETH-USD'), ['ETH-USD']);
});

test('simulate: lotSize로 소수점 수량 매수 (1개가 자본보다 비싼 코인)', async () => {
  const bars = barsFromCloses([50_000, 40_000, 40_000]);
  const r = await simulate({
    symbols: ['BTC'], bars: { BTC: bars }, startDate: bars[0]!.date, endDate: bars[2]!.date, intervalDays: 1,
    initialCapital: 1000, buyFeeRate: 0, sellFeeRate: 0, lotSize: 1e-8, decide: async () => ({ BTC: 1 }),
  });
  assert.equal(r.trades.length, 1);
  assert.ok(Math.abs(r.trades[0]!.shares - 0.025) < 1e-8);
  assert.ok(Math.abs(r.equity.at(-1)!.equity - 1000) < 1e-3);
});

test('simulate: lotSize 기본값은 1주 (주식)', async () => {
  const bars = barsFromCloses([50_000, 40_000, 40_000]);
  const r = await simulate({
    symbols: ['A'], bars: { A: bars }, startDate: bars[0]!.date, endDate: bars[2]!.date, intervalDays: 1,
    initialCapital: 1000, buyFeeRate: 0, sellFeeRate: 0, decide: async () => ({ A: 1 }),
  });
  assert.equal(r.trades.length, 0);
});

test('연환산: 코인은 365일 기준 (Sharpe·변동성·지표)', () => {
  const pts = [100, 101, 99, 102, 103].map((e, i) => ({ date: `2024-01-0${i + 1}`, equity: e, benchmark: 100 }));
  const stock = computeMetrics(pts, [], 100, 252);
  const coin = computeMetrics(pts, [], 100, 365);
  assert.ok(Math.abs(coin.volatility / stock.volatility - Math.sqrt(365 / 252)) < 1e-9);
  const bars = barsFromCloses(linearCloses(100, 1, 40).map((c, i) => c + (i % 2) * 3));
  const f252 = computeRawFeatures(bars, 39, 252);
  const f365 = computeRawFeatures(bars, 39, 365);
  assert.ok(Math.abs(f365.vol20 / f252.vol20 - Math.sqrt(365 / 252)) < 1e-9);
});

test('Jev 질문: 코인은 cryptocurrency·days 문구 사용', () => {
  const req = buildJevRequest({ assets: { asset_1: { trend_past_month: 'rise' } }, strategy: 'noul', effort: 'low', intervalDays: 7, model: 'm', assetNoun: 'cryptocurrency', dayUnit: 'days' });
  const text = JSON.stringify(req.questions[questionId('asset_1', 0)]);
  assert.match(text, /this cryptocurrency/);
  assert.match(text, /the next 7 days/);
  const stock = JSON.stringify(buildJevRequest({ assets: { asset_1: {} }, strategy: 'noul', effort: 'low', intervalDays: 5, model: 'm' }).questions);
  assert.match(stock, /this stock/);
  assert.match(stock, /the next 5 trading days/);
});

const base = {
  nickname: 'coin', market: 'CRYPTO', tickers: ['BTC-USD', 'eth'], startDate: '2025-01-01', endDate: '2025-06-30',
  initialCapital: 10000, engine: 'mock', strategies: ['noul'], efforts: ['low'], intervals: [7],
};

test('검증: 코인 티커 형식과 시장별 매매 주기', () => {
  const ok = createRunSchema.safeParse(base);
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  assert.deepEqual(ok.data!.tickers, ['BTC-USD', 'ETH']);
  assert.equal(createRunSchema.safeParse({ ...base, tickers: ['005930'] }).success, false);
  assert.equal(createRunSchema.safeParse({ ...base, intervals: [5] }).success, false, '코인에 주식용 5거래일 주기 불가');
  assert.equal(createRunSchema.safeParse({ ...base, market: 'US', tickers: ['AAPL'], intervals: [7] }).success, false, '주식에 7일 주기 불가');
});

test('MARKETS.CRYPTO: 벤치마크 BTC, 365일, 소수점 수량, 수수료', () => {
  const c = MARKETS.CRYPTO;
  assert.equal(c.indexSymbol, 'BTC-USD');
  assert.equal(c.periodsPerYear, 365);
  assert.ok(c.lotSize < 1);
  assert.ok(c.buyFeeRate > 0 && c.sellFeeRate > 0);
  assert.deepEqual(c.intervals.map((i) => i.days), [1, 7, 14, 30]);
  assert.deepEqual(MARKETS.KR.intervals.map((i) => i.days), [1, 5, 10, 21]);
});
