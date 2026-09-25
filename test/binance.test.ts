import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCryptoSymbol, CRYPTO_ASSETS, parseKlines, fetchBinanceDaily, fetchBinanceMinutes } from '../src/market/binance.ts';
import { SymbolNotFoundError } from '../src/market/yahoo.ts';

const KLINE = (openMs: number, o: string, h: string, l: string, c: string, v: string) =>
  [openMs, o, h, l, c, v, openMs + 59_999, '0', 10, '0', '0', '0'];

test('resolveCryptoSymbol: BTC / BTC-USD / btcusdt → BTCUSDT, 5종 외는 null', () => {
  assert.equal(CRYPTO_ASSETS.length, 5);
  for (const input of ['BTC', 'btc-usd', 'BTCUSDT', ' Btc ']) assert.equal(resolveCryptoSymbol(input), 'BTCUSDT');
  assert.equal(resolveCryptoSymbol('XRP'), 'XRPUSDT');
  assert.equal(resolveCryptoSymbol('DOGE'), null);
});

test('parseKlines: UTC 날짜·숫자 변환, 잘못된 형식은 예외', () => {
  const bars = parseKlines([KLINE(Date.UTC(2025, 0, 2), '1', '3', '0.5', '2', '100')]);
  assert.deepEqual(bars[0], { ts: Date.UTC(2025, 0, 2) / 1000, date: '2025-01-02', open: 1, high: 3, low: 0.5, close: 2, volume: 100 });
  assert.throws(() => parseKlines({ code: -1121, msg: 'Invalid symbol.' }), /Unexpected/);
});

test('fetchBinanceDaily: 기간 전체를 1000개 단위로 이어 받고 이름 포함', async () => {
  const urls: string[] = [];
  const day = 86_400_000;
  const start = Date.UTC(2020, 0, 1);
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const from = Number(new URL(url).searchParams.get('startTime'));
    const n = Math.min(1000, Math.floor((Date.UTC(2023, 0, 1) - from) / day) + 1);
    return new Response(JSON.stringify(Array.from({ length: Math.max(0, n) }, (_, i) => KLINE(from + i * day, '1', '1', '1', '1', '1'))));
  }) as unknown as typeof fetch;
  const r = await fetchBinanceDaily('BTC', '2020-01-01', '2023-01-01', fetchImpl);
  assert.equal(r.symbol, 'BTCUSDT');
  assert.equal(r.name, '비트코인');
  assert.equal(r.bars[0]!.date, '2020-01-01');
  assert.equal(r.bars.at(-1)!.date, '2023-01-01');
  assert.equal(r.bars.length, Math.round((Date.UTC(2023, 0, 1) - start) / day) + 1);
  assert.equal(urls.length, 2);
});

test('fetchBinanceDaily: 지원하지 않는 코인은 SymbolNotFoundError', async () => {
  await assert.rejects(fetchBinanceDaily('DOGE', '2024-01-01', '2024-02-01'), SymbolNotFoundError);
});

test('fetchBinanceMinutes: 1분봉을 구간 끝까지 페이지 단위로 수집', async () => {
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    const from = Number(u.searchParams.get('startTime'));
    const end = Number(u.searchParams.get('endTime'));
    const n = Math.min(1000, Math.floor((end - from) / 60_000) + 1);
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => KLINE(from + i * 60_000, '1', '2', '1', '1.5', '3'))));
  }) as unknown as typeof fetch;
  const from = Date.UTC(2025, 0, 1) / 1000;
  const bars = await fetchBinanceMinutes('BTCUSDT', from, from + 86_400 - 60, fetchImpl);
  assert.equal(bars.length, 1440);
  assert.equal(new Set(bars.map((b) => b.date)).size, 1);
});
