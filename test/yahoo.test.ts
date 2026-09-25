import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChart, candidateSymbols, fetchDailyBars, SymbolNotFoundError } from '../src/market/yahoo.ts';

const FIXTURE = {
  chart: {
    result: [{
      meta: { symbol: '005930.KS', currency: 'KRW', gmtoffset: 32400, longName: 'Samsung Electronics Co., Ltd.' },
      timestamp: [1735776000, 1735862400, 1736121600],
      indicators: {
        quote: [{ open: [52700, null, 54400], high: [53600, 55100, 56200], low: [52300, 52800, 54300], close: [53400, 54400, 55900], volume: [100, 200, 300] }],
        adjclose: [{ adjclose: [26700, 54400, 55900] }],
      },
    }],
    error: null,
  },
};

test('parseChart: 현지 날짜 변환, 수정주가 반영, null 행 제거', () => {
  const r = parseChart(FIXTURE);
  assert.equal(r.name, 'Samsung Electronics Co., Ltd.');
  assert.equal(r.currency, 'KRW');
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0]!.date, '2025-01-02');
  assert.equal(r.bars[0]!.close, 26700);
  assert.equal(r.bars[0]!.open, 26350); // 52700 * 0.5
  assert.equal(r.bars[1]!.date, '2025-01-06');
});

test('parseChart: 에러 응답이면 SymbolNotFoundError', () => {
  assert.throws(() => parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'x' } } }), SymbolNotFoundError);
  assert.throws(() => parseChart({ foo: 1 }), /Unexpected/);
});

test('candidateSymbols: 한국 6자리 코드는 KOSPI→KOSDAQ 순으로 시도', () => {
  assert.deepEqual(candidateSymbols('KR', '005930'), ['005930.KS', '005930.KQ']);
  assert.deepEqual(candidateSymbols('KR', '035720.KQ'), ['035720.KQ']);
  assert.deepEqual(candidateSymbols('US', 'aapl'), ['AAPL']);
  assert.deepEqual(candidateSymbols('US', '^GSPC'), ['^GSPC']);
});

test('fetchDailyBars: 첫 후보가 없으면 다음 후보로', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    if (url.includes('.KS')) return new Response(JSON.stringify({ chart: { result: null, error: { code: 'Not Found' } } }), { status: 404 });
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await fetchDailyBars('KR', '035720', '2025-01-01', '2025-01-10', fetchImpl);
  assert.equal(r.symbol, '035720.KQ');
  assert.equal(urls.length, 2);
});

test('fetchDailyBars: 모든 후보 실패 시 SymbolNotFoundError', async () => {
  const fetchImpl = (async () => new Response('{"chart":{"result":null,"error":{"code":"Not Found"}}}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(fetchDailyBars('US', 'NOPE', '2025-01-01', '2025-01-10', fetchImpl), SymbolNotFoundError);
});
