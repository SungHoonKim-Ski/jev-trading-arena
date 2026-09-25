import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntraday, sessionVwap, adjustedFill, collectionWindows, INTRADAY_SPECS, REFETCH_OVERLAP_SEC } from '../src/market/intraday.ts';
import { openDatabase } from '../src/db/database.ts';
import { IntradayRepository } from '../src/db/intradayRepository.ts';
import { IntradayCollector, type IntradayFetcher } from '../src/market/intradayCollector.ts';

const FIXTURE = {
  chart: {
    result: [{
      meta: { symbol: 'AAPL', gmtoffset: -14400 },
      timestamp: [1735828200, 1735828260, 1735828320],
      indicators: { quote: [{ open: [100, 101, null], high: [101, 102, 1], low: [99, 100, 1], close: [100.5, 101.5, 1], volume: [1000, 3000, 5] }] },
    }],
    error: null,
  },
};

test('parseIntraday: 현지 날짜, null 행 제거', () => {
  const bars = parseIntraday(FIXTURE);
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.date, '2025-01-02');
  assert.equal(bars[0]!.ts, 1735828200);
});

test('parseIntraday: 휴장 구간의 빈 quote는 빈 배열', () => {
  assert.deepEqual(parseIntraday({ chart: { result: [{ meta: { gmtoffset: 0 }, timestamp: [1], indicators: { quote: [{}] } }] } }), []);
  assert.deepEqual(parseIntraday({ chart: { result: [{ meta: { gmtoffset: 0 }, indicators: { quote: [{}] } }] } }), []);
});

test('sessionVwap: 거래량 가중 평균(typical price), 거래량 0이면 종가 평균', () => {
  const bars = parseIntraday(FIXTURE);
  const t1 = (101 + 99 + 100.5) / 3, t2 = (102 + 100 + 101.5) / 3;
  assert.ok(Math.abs(sessionVwap(bars)! - (t1 * 1000 + t2 * 3000) / 4000) < 1e-9);
  assert.equal(sessionVwap([]), null);
  assert.equal(sessionVwap(bars.map((b) => ({ ...b, volume: 0 }))), (100.5 + 101.5) / 2);
});

test('adjustedFill: 원주가 VWAP/첫 분봉 시가 비율을 수정주가 시가에 적용', () => {
  const bars = parseIntraday(FIXTURE);
  const fill = adjustedFill(50, bars)!; // 수정주가가 원주가의 절반인 경우
  assert.ok(Math.abs(fill - 50 * (sessionVwap(bars)! / 100)) < 1e-9);
});

test('collectionWindows: 저장된 마지막 시점 이후만, 청크 단위로', () => {
  const now = 1_800_000_000;
  const spec = INTRADAY_SPECS.find((s) => s.interval === '1m')!;
  const full = collectionWindows(spec, null, now);
  assert.equal(full.length, Math.ceil(spec.maxDays / spec.chunkDays));
  assert.ok(full.every(([a, b]) => b - a <= spec.chunkDays * 86400));
  assert.equal(full[0]![0] % 86400, 0, '최초 수집은 UTC 자정부터');
  const partial = collectionWindows(spec, now - 600, now);
  assert.deepEqual(partial, [[now - 600 - REFETCH_OVERLAP_SEC, now]], '마지막 구간은 겹쳐서 재수집');
});

test('IntradayRepository: 가장 촘촘한 분봉 우선 조회 + 커버리지 요약', () => {
  const repo = new IntradayRepository(openDatabase(':memory:'));
  const bars = parseIntraday(FIXTURE);
  repo.upsert('AAPL', '60m', bars.slice(0, 1));
  repo.upsert('AAPL', '1m', bars);
  repo.upsert('AAPL', '1m', bars); // 중복 저장은 무시
  const day = repo.getFinestDay('AAPL', '2025-01-02');
  assert.equal(day.interval, '1m');
  assert.equal(day.bars.length, 2);
  assert.equal(repo.getFinestDay('AAPL', '2025-01-03').bars.length, 0);
  // 장 중간부터 잘린 1분봉(첫 분봉이 60분봉보다 늦음)은 건너뛰고 60분봉 사용
  const early = { ...bars[0]!, ts: bars[0]!.ts - 3600, date: '2025-01-06' };
  repo.upsert('AAPL', '60m', [early]);
  repo.upsert('AAPL', '1m', [{ ...bars[0]!, date: '2025-01-06' }]);
  assert.equal(repo.getFinestDay('AAPL', '2025-01-06').interval, '60m');
  // 같은 시각 분봉은 최신 값으로 갱신
  repo.upsert('AAPL', '1m', [{ ...bars[0]!, close: 999 }]);
  assert.equal(repo.getFinestDay('AAPL', '2025-01-02').bars[0]!.close, 999);
  const cov = repo.coverage();
  assert.equal(cov.find((c) => c.interval === '1m')!.bars, 2);
  assert.equal(repo.lastTs('AAPL', '1m'), 1735828260);
});

test('IntradayCollector: 간격별 수집·저장, 한 간격 실패해도 나머지 계속', async () => {
  const repo = new IntradayRepository(openDatabase(':memory:'));
  const calls: string[] = [];
  const fetcher: IntradayFetcher = async (symbol, interval) => {
    calls.push(interval);
    if (interval === '5m') throw new Error('boom');
    return parseIntraday(FIXTURE);
  };
  const collector = new IntradayCollector(repo, fetcher, () => 1735900000, async () => {});
  const result = await collector.collect('AAPL');
  assert.equal(result.errors.length, 1);
  assert.ok(result.saved['1m']! >= 2);
  assert.ok(calls.includes('60m'));
  assert.equal(repo.getFinestDay('AAPL', '2025-01-02').interval, '1m');
});
