import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { openLocalDatabase } from '../src/db/client.node.ts';
import { createApp, type App } from '../src/app.ts';
import type { BarFetcher } from '../src/market/priceService.ts';
import { MockJevClient } from '../src/jev/mockClient.ts';
import type { JevClient } from '../src/jev/types.ts';
import { tradingDates } from './helpers.ts';
import type { IntradayFetcher } from '../src/market/intradayCollector.ts';

/** 사인파 + 추세로 만든 결정적 가짜 시세 */
const fakeFetcher: BarFetcher = async (_market, input, from, to) => {
  if (input === 'NOPE') throw Object.assign(new Error('종목을 찾을 수 없습니다: NOPE'), { name: 'SymbolNotFoundError' });
  const seed = [...input].reduce((s, c) => s + c.charCodeAt(0), 0);
  const dates = tradingDates(from, 800).filter((d) => d <= to);
  const bars = dates.map((date, i) => {
    const c = 100 + i * 0.05 * ((seed % 3) - 1) + 10 * Math.sin(i / (8 + (seed % 5)));
    return { date, open: c * 0.998, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + (i % 7) * 100 };
  });
  return { symbol: input.startsWith('^') ? input : `${input}`, name: `Fake ${input}`, currency: 'USD', bars };
};

/** 요청 구간의 거래일마다 09:30~ 5개의 1분봉을 생성 (시가 대비 +1% 부근에서 거래) */
const fakeIntraday: IntradayFetcher = async (_symbol, interval, from, to) => {
  if (interval !== '1m') return [];
  const start = new Date(from * 1000).toISOString().slice(0, 10);
  return tradingDates(start, 40).filter((d) => Date.parse(d) / 1000 <= to).flatMap((date) =>
    [0, 1, 2, 3, 4].map((k) => ({ ts: Date.parse(`${date}T13:30:00Z`) / 1000 + k * 60, date, open: 100, high: 101.5, low: 100.5, close: 101, volume: 10 })));
};

let liveCalls = 0;
const fakeLive: JevClient = { mode: 'live', evaluate: async (r) => { liveCalls++; return new MockJevClient().evaluate(r); } };

let app: App;
let server: Server;
let base: string;

before(async () => {
  app = createApp({ db: await openLocalDatabase(':memory:'), fetcher: fakeFetcher, liveJev: fakeLive, intradayFetcher: fakeIntraday });
  server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const body = (over: Record<string, unknown> = {}) => ({
  nickname: '테스터', market: 'US', tickers: ['AAPL', 'MSFT'], startDate: '2024-01-02', endDate: '2024-06-28',
  initialCapital: 10000, engine: 'mock', strategies: ['noul', 'score'], efforts: ['low', 'high'], intervals: [5], ...over,
});
const post = (b: unknown) => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

test('meta: Jev 엔진 가용 여부와 선택지 반환', async () => {
  const res = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(res.success, true);
  assert.equal(res.data.jevLive, true);
  assert.ok(res.data.strategies.probability);
  assert.equal(res.data.markets.US.intervals.length, 4);
  assert.deepEqual(res.data.markets.CRYPTO.intervals.map((i: { days: number }) => i.days), [1, 7, 14, 30]);
  assert.equal(res.data.presets.CRYPTO[0].ticker, 'BTC');
});

test('POST /api/runs → 조합별 실행 → 완료 → 랭킹/통계 반영', async () => {
  const res = await post(body());
  assert.equal(res.status, 202);
  const { data } = await res.json();
  assert.equal(data.runIds.length, 4);
  await app.queue.onIdle();

  const detail = (await (await fetch(`${base}/api/runs/${data.runIds[0]}`)).json()).data;
  assert.equal(detail.run.status, 'done', detail.run.error);
  assert.ok(detail.equity.length > 100);
  assert.ok(detail.decisions.length > 0);
  assert.equal(typeof detail.run.total_return, 'number');
  assert.equal(detail.run.engine, 'mock');
  assert.equal(detail.run.jev_cost_usd, 0);
  assert.equal(detail.run.symbol_names.AAPL, 'Fake AAPL');

  const board = (await (await fetch(`${base}/api/leaderboard?market=US&engine=mock`)).json()).data;
  assert.equal(board.length, 4);
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].total_return >= board[i].total_return);

  const stats = (await (await fetch(`${base}/api/stats?market=US`)).json()).data;
  assert.equal(stats.length, 4);
  const group = (await (await fetch(`${base}/api/runs?groupId=${data.groupId}`)).json()).data;
  assert.equal(group.length, 4);
});

test('live 엔진: 비용 계산, 동일 요청은 캐시로 재호출 없음', async () => {
  const b = body({ strategies: ['choice'], efforts: ['medium'], intervals: [21], nickname: 'live1', engine: 'live' });
  const first = (await (await post(b)).json()).data;
  await app.queue.onIdle();
  const callsAfterFirst = liveCalls;
  assert.ok(callsAfterFirst > 0);
  await post({ ...b, nickname: 'live2' });
  await app.queue.onIdle();
  assert.equal(liveCalls, callsAfterFirst, '두 번째 실행은 캐시 사용');
  const run = (await (await fetch(`${base}/api/runs/${first.runIds[0]}`)).json()).data.run;
  assert.ok(run.jev_cost_usd > 0);
  const best = (await (await fetch(`${base}/api/leaderboard?engine=live&bestPerUser=true`)).json()).data;
  assert.equal(best.length, 2);
});

test('존재하지 않는 종목이면 실행이 failed로 기록', async () => {
  const { data } = await (await post(body({ tickers: ['NOPE'], strategies: ['noul'], efforts: ['low'] }))).json();
  await app.queue.onIdle();
  const run = (await (await fetch(`${base}/api/runs/${data.runIds[0]}`)).json()).data.run;
  assert.equal(run.status, 'failed');
  assert.match(run.error, /NOPE/);
});

test('입력 검증 오류는 400과 한국어 메시지', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ market: 'KR', tickers: ['AAPL'] }, /6자리/],
    [{ startDate: '2024-06-01', endDate: '2024-06-10' }, /최소/],
    [{ endDate: '2999-01-01' }, /오늘/],
    [{ strategies: [] }, /전략/],
    [{ intervals: [3] }, /매매 주기/],
    [{ nickname: '<script>' }, /닉네임/],
    [{ strategies: ['choice', 'probability', 'noul', 'score'], efforts: ['low', 'medium', 'high'], intervals: [1, 5, 10] }, /최대/],
  ];
  for (const [over, re] of cases) {
    const res = await post(body(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match((await res.json()).error, re);
  }
  const bad = await fetch(`${base}/api/runs`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
});

test('404 처리와 경로 탈출 차단', async () => {
  assert.equal((await fetch(`${base}/api/runs/99999`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/leaderboard?sort=drop_table`)).status, 400);
  assert.equal((await fetch(`${base}/%E0`)).status, 404);
});

test('VWAP 체결: 분봉 자동 수집 후 체결, 분봉 없는 날은 일봉 평균가로 대체하고 횟수 기록', async () => {
  const today = new Date();
  const end = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  const res = await post(body({ nickname: 'vwap', startDate: start, endDate: end, execution: 'vwap', strategies: ['noul'], efforts: ['low'], intervals: [1] }));
  assert.equal(res.status, 202);
  const { data } = await res.json();
  await app.queue.onIdle();
  const run = (await (await fetch(`${base}/api/runs/${data.runIds[0]}`)).json()).data.run;
  assert.equal(run.status, 'done', run.error);
  assert.equal(run.execution, 'vwap');
  assert.ok(run.intraday_fills + run.fallback_fills === run.trades, JSON.stringify(run));
  assert.ok(run.intraday_fills > 0, 'recent days use intraday VWAP');
  const cov = (await (await fetch(`${base}/api/data/coverage`)).json()).data;
  assert.ok(cov.some((c: { symbol: string; interval: string; bars: number }) => c.symbol === 'AAPL' && c.interval === '1m' && c.bars > 0));
  const vwapOnly = (await (await fetch(`${base}/api/leaderboard?execution=vwap`)).json()).data;
  assert.equal(vwapOnly.length, 1);
});

test('POST /api/data/collect: 종목 확인 후 분봉 수집, 잘못된 입력은 400', async () => {
  const ok = await fetch(`${base}/api/data/collect`, { method: 'POST', body: JSON.stringify({ market: 'US', tickers: ['TSLA'] }) });
  assert.equal(ok.status, 200);
  const results = (await ok.json()).data;
  assert.equal(results[0].symbol, 'TSLA');
  const bad = await fetch(`${base}/api/data/collect`, { method: 'POST', body: JSON.stringify({ market: 'US', tickers: ['NOPE'] }) });
  assert.equal(bad.status, 400);
  const invalid = await fetch(`${base}/api/data/collect`, { method: 'POST', body: JSON.stringify({ market: 'US', tickers: ['<x>'] }) });
  assert.equal(invalid.status, 400);
});

test('CORS: 다른 출처(GitHub Pages)에서 호출 가능, preflight 204', async () => {
  const pre = await fetch(`${base}/api/runs`, { method: 'OPTIONS', headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const res = await fetch(`${base}/api/meta`, { headers: { Origin: 'https://example.github.io' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('크론 엔드포인트: CRON_SECRET 없으면 비활성(404)', async () => {
  assert.equal((await fetch(`${base}/api/cron/tick`)).status, 404);
});

test('tick: 멈춘 실행 복구 후 재실행', async () => {
  const id = await app.runs.create({ nickname: 'stuck', market: 'US', tickers: ['AAPL'], startDate: '2024-01-02', endDate: '2024-03-29',
    intervalDays: 5, effort: 'low', strategy: 'noul', initialCapital: 10000, engine: 'mock', execution: 'open' }, 'gs');
  const result = await app.tick();
  assert.ok(result.requeued >= 1);
  assert.equal((await app.runs.get(id))!.status, 'done');
});
