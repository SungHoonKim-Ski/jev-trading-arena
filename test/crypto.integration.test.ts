import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { strToU8 } from 'fflate';
import { openLocalDatabase } from '../src/db/client.node.ts';
import { createApp, type App } from '../src/app.ts';
import { DuckDbTickStore } from '../src/ticks/duckdbTickStore.ts';
import { resolveCryptoSymbol } from '../src/market/binance.ts';
import type { BarFetcher } from '../src/market/priceService.ts';
import type { MinuteFetcher } from '../src/backtest/fills.ts';

const DAY_MS = 86_400_000;
const priceOn = (t: number, seed: number) => 100 + seed + 20 * Math.sin(t / DAY_MS / (5 + seed));

/** 주말 포함 매일 일봉 */
const fetcher: BarFetcher = async (market, input, from, to) => {
  const symbol = market === 'CRYPTO' ? resolveCryptoSymbol(input)! : input;
  const seed = symbol.charCodeAt(0) % 7;
  const bars = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    const c = priceOn(t, seed);
    bars.push({ date: new Date(t).toISOString().slice(0, 10), open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1000 });
  }
  return { symbol, name: symbol, currency: 'USD', bars };
};

let minuteCalls = 0;
const cryptoMinutes: MinuteFetcher = async (_symbol, from) => {
  minuteCalls++;
  return Array.from({ length: 1440 }, (_, i) => ({ ts: from + i * 60, date: new Date(from * 1000).toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100, volume: 1 }));
};

/** 하루 100건의 가짜 원본 체결 (가격 100~109.9) */
let tickDownloads = 0;
const downloader = {
  download: async (_symbol: string, date: string) => {
    tickDownloads++;
    if (date >= '2025-03-01') throw new Error(`${date} 틱 파일이 아직 공개되지 않았습니다`);
    const start = Date.parse(`${date}T00:00:00Z`) * 1000;
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1},${100 + i / 10},1,${100 + i / 10},${start + i * 1e6},False,True`);
    return { csv: strToU8(lines.join('\n')), sha256: 'fake' };
  },
};

let app: App;
let server: Server;
let base: string;

before(async () => {
  const ticks = await DuckDbTickStore.open(':memory:', downloader, { maxBytes: 1e12 });
  app = createApp({ db: await openLocalDatabase(':memory:'), fetcher, liveJev: null, ticks, cryptoMinutes, intradayFetcher: async () => [] });
  server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const run = (over: Record<string, unknown>) => post('/api/runs', {
  nickname: 'tick', market: 'CRYPTO', tickers: ['BTC', 'ETH'], startDate: '2025-01-01', endDate: '2025-03-31',
  initialCapital: 10000, engine: 'mock', strategies: ['noul'], efforts: ['low'], intervals: [7], ...over,
});

test('meta: 틱 저장소 사용 가능, 지원 코인 5종', async () => {
  const m = (await (await fetch(`${base}/api/meta`)).json()).data;
  assert.equal(m.ticksEnabled, true);
  assert.deepEqual(m.cryptoAssets.map((a: { ticker: string }) => a.ticker), ['BTC', 'ETH', 'SOL', 'XRP', 'BNB']);
});

test('틱 체결: 틱 있는 날은 틱, 공개 전 날짜는 1분봉 VWAP으로 대체하고 출처별 건수 기록', async () => {
  const res = await run({ execution: 'tick' });
  assert.equal(res.status, 202, await res.clone().text());
  const { data } = await res.json();
  await app.queue.onIdle();
  const detail = (await (await fetch(`${base}/api/runs/${data.runIds[0]}`)).json()).data;
  const r = detail.run;
  assert.equal(r.status, 'done', r.error);
  assert.equal(r.execution, 'tick');
  assert.ok(r.trades > 0);
  assert.equal(r.tick_fills + r.intraday_fills + r.fallback_fills, r.trades);
  assert.ok(r.tick_fills > 0, JSON.stringify(r));
  assert.ok(r.intraday_fills > 0, '3월 이후는 틱 파일이 없어 1분봉 사용');
  assert.ok(minuteCalls > 0);
  const tickTrades = detail.trades.filter((t: { date: string }) => t.date < '2025-03-01');
  for (const t of tickTrades) assert.ok(t.price >= 100 && t.price < 110, `틱 가격 범위 내 체결: ${t.price}`);
});

test('틱 현황·수집 API', async () => {
  const before = tickDownloads;
  const ok = await post('/api/ticks/collect', { tickers: ['SOL'], from: '2025-01-05', to: '2025-01-06' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.length, 2);
  assert.equal(tickDownloads - before, 2);
  const cov = (await (await fetch(`${base}/api/ticks/coverage`)).json()).data;
  assert.equal(cov.enabled, true);
  assert.ok(cov.coverage.some((c: { symbol: string; days: number }) => c.symbol === 'SOLUSDT' && c.days === 2));
  const tooMany = await post('/api/ticks/collect', { tickers: ['BTC', 'ETH'], from: '2025-01-01', to: '2025-01-10' });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /npm run ticks/);
  const bad = await post('/api/ticks/collect', { tickers: ['DOGE'], from: '2025-01-01', to: '2025-01-01' });
  assert.equal(bad.status, 400);
});

test('틱 체결은 코인 전용, 지원 외 코인 거부', async () => {
  assert.equal((await run({ market: 'US', tickers: ['AAPL'], intervals: [5], execution: 'tick' })).status, 400);
  assert.equal((await run({ tickers: ['DOGE'] })).status, 400);
});

test('틱 체결 사전 점검: 필요한 틱 용량이 남은 용량을 넘으면 시작 전에 거부', async () => {
  const small = await DuckDbTickStore.open(':memory:', downloader, { maxBytes: 300e6 });
  const app2 = createApp({ db: await openLocalDatabase(':memory:'), fetcher, liveJev: null, ticks: small, cryptoMinutes, intradayFetcher: async () => [] });
  const srv = createServer((req, res) => { void app2.handle(req, res); });
  await new Promise<void>((r) => srv.listen(0, r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/runs`;
    const body = { nickname: 'b', market: 'CRYPTO', tickers: ['BTC'], startDate: '2025-01-01', endDate: '2025-06-30', initialCapital: 10000, engine: 'mock', strategies: ['noul'], efforts: ['low'], execution: 'tick' };
    const tooBig = await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, intervals: [1] }) });
    const tooBigBody = await tooBig.json();
    assert.equal(tooBig.status, 400, JSON.stringify(tooBigBody));
    assert.match(tooBigBody.error, /남은 용량/);
    const fits = await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, endDate: '2025-02-05', intervals: [7] }) });
    assert.equal(fits.status, 202, await fits.text());
    await app2.queue.onIdle();
  } finally {
    srv.close();
    small.close();
  }
});

test('틱 저장소 없이 재개된 틱 실행은 분봉으로 바꾸지 않고 실패 처리', async () => {
  const app3 = createApp({ db: await openLocalDatabase(':memory:'), fetcher, liveJev: null, ticks: null, cryptoMinutes, intradayFetcher: async () => [] });
  const id = await app3.runs.create({ nickname: 'r', market: 'CRYPTO', tickers: ['BTC'], startDate: '2025-01-01', endDate: '2025-02-01', intervalDays: 7, effort: 'low', strategy: 'noul', initialCapital: 10000, engine: 'mock', execution: 'tick', threshold: 0.8, exitRule: 'opposite' }, 'g');
  app3.queue.enqueue([id]);
  await app3.queue.onIdle();
  const run = (await app3.runs.get(id))!;
  assert.equal(run.status, 'failed');
  assert.match(String(run.error), /틱 저장소가 꺼져/);
});

test('서버리스 구성: 원본 틱 저장 없이 스트리밍으로 틱 체결, 체결일 수 제한', async () => {
  const { StreamingTickPricer } = await import('../src/ticks/streamingTickPricer.ts');
  const { TickFillCacheRepository } = await import('../src/db/tickFillCacheRepository.ts');
  const { zipSync } = await import('fflate');
  let downloads = 0;
  const zipFetch = (async (url: string) => {
    downloads++;
    const date = /trades-(\d{4}-\d{2}-\d{2})\.zip/.exec(String(url))![1]!;
    try {
      const { csv } = await downloader.download('BTCUSDT', date);
      return new Response(zipSync({ 'x.csv': csv }));
    } catch {
      return new Response('', { status: 404 });
    }
  }) as unknown as typeof fetch;
  const db = await openLocalDatabase(':memory:');
  const appS = createApp({ db, fetcher, liveJev: null, ticks: null, tickPricer: new StreamingTickPricer(new TickFillCacheRepository(db), zipFetch), cryptoMinutes, intradayFetcher: async () => [] });
  const srv = createServer((req, res) => { void appS.handle(req, res); });
  await new Promise<void>((r) => srv.listen(0, r));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const m = (await (await fetch(`${b}/api/meta`)).json()).data;
    assert.equal(m.ticksEnabled, true);
    assert.equal(m.tickMode, 'stream');
    const req = { nickname: 's', market: 'CRYPTO', tickers: ['BTC'], startDate: '2025-01-01', endDate: '2025-02-28', initialCapital: 10000, engine: 'mock', efforts: ['low'], intervals: [7], execution: 'tick', threshold: 0.7 };
    const res = await fetch(`${b}/api/runs`, { method: 'POST', body: JSON.stringify(req) });
    assert.equal(res.status, 202, await res.clone().text());
    const { data } = await res.json();
    await appS.queue.onIdle();
    const run = (await (await fetch(`${b}/api/runs/${data.runIds[0]}`)).json()).data.run;
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.tick_fills, run.trades, JSON.stringify(run));
    assert.ok(downloads > 0);
    const tooMany = await fetch(`${b}/api/runs`, { method: 'POST', body: JSON.stringify({ ...req, startDate: '2023-01-01', endDate: '2025-02-28', intervals: [1] }) });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /체결일/);
  } finally {
    srv.close();
  }
});

test('기본 체결 방식: 코인은 원본 틱, 주식은 다음 날 시가 (execution 생략 시)', async () => {
  const coin = await post('/api/runs', { nickname: 'def', market: 'CRYPTO', tickers: ['BTC'], startDate: '2025-01-01', endDate: '2025-02-28', initialCapital: 10000, engine: 'mock', efforts: ['low'], intervals: [7] });
  assert.equal(coin.status, 202, await coin.clone().text());
  const stock = await post('/api/runs', { nickname: 'def', market: 'US', tickers: ['AAPL'], startDate: '2025-01-01', endDate: '2025-02-28', initialCapital: 10000, engine: 'mock', efforts: ['low'], intervals: [5] });
  assert.equal(stock.status, 202, await stock.clone().text());
  await app.queue.onIdle();
  const exec = async (r: Response) => (await (await fetch(`${base}/api/runs/${(await r.json()).data.runIds[0]}`)).json()).data.run.execution;
  assert.equal(await exec(coin), 'tick');
  assert.equal(await exec(stock), 'open');
});
