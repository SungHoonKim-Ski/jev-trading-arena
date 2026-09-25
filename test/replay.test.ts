import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, signalText } from '../public/js/replay/timeline.js';

const detail = {
  run: { initial_capital: 1000, strategy: 'noul', symbol_names: { A: '에이' } },
  equity: [
    { date: 'd1', equity: 1000, benchmark: 1000, index: 1000 },
    { date: 'd2', equity: 1000, benchmark: 1100, index: 1050 },
    { date: 'd3', equity: 1200, benchmark: 1200, index: 1100 },
    { date: 'd4', equity: 1100, benchmark: 1150, index: null },
  ],
  trades: [
    { date: 'd2', symbol: 'A', side: 'buy', shares: 10, price: 100, fee: 0 },
    { date: 'd4', symbol: 'A', side: 'sell', shares: 5, price: 110, fee: 1 },
  ],
  decisions: [
    { date: 'd1', symbol: 'A', action: 'buy', targetWeight: 1, confidence: 0.4, signal: 0.71 },
    { date: 'd2', symbol: 'A', action: 'hold', targetWeight: null, confidence: 0.1, signal: 0.5 },
    { date: 'd3', symbol: 'A', action: 'sell', targetWeight: 0.5, confidence: 0.3, signal: 0.35 },
  ],
  prices: { A: [{ date: 'd1', open: 100, close: 100 }, { date: 'd2', open: 100, close: 100 }, { date: 'd3', open: 120, close: 120 }, { date: 'd4', open: 110, close: 110 }] },
};

test('buildTimeline: 날짜별 손익·보유 포지션 재계산', () => {
  const t = buildTimeline(detail);
  assert.deepEqual(t.dates, ['d1', 'd2', 'd3', 'd4']);
  assert.equal(t.frames[0].pnl, 0);
  assert.equal(t.frames[2].pnl, 200);
  assert.ok(Math.abs(t.frames[2].pnlPct - 0.2) < 1e-12);
  assert.ok(Math.abs(t.frames[2].vsBenchmark - 0) < 1e-12);
  assert.equal(t.frames[0].positions.A.shares, 0);
  const p2 = t.frames[2].positions.A;
  assert.equal(p2.shares, 10);
  assert.equal(p2.avgCost, 100);
  assert.equal(p2.unrealized, 200);
  const p3 = t.frames[3].positions.A;
  assert.equal(p3.shares, 5);
  assert.equal(p3.realized, 50 - 1);
  assert.equal(p3.unrealized, 50);
});

test('buildTimeline: 유지(hold) 판단은 이벤트에서 제외, 판단은 결정일·체결은 체결일에 배치', () => {
  const t = buildTimeline(detail);
  const kinds = t.events.map((e) => `${e.frame}:${e.type}:${e.action ?? e.side}`);
  assert.deepEqual(kinds, ['0:decision:buy', '1:trade:buy', '2:decision:sell', '3:trade:sell']);
  assert.equal(t.markers.A.length, 2);
  assert.deepEqual(t.markers.A.map((m) => [m.frame, m.side]), [[1, 'buy'], [3, 'sell']]);
});

test('buildTimeline: 가격은 날짜에 맞춰 정렬, 빈 날은 직전 가격 유지', () => {
  const t = buildTimeline({ ...detail, prices: { A: [{ date: 'd1', open: 1, close: 1 }, { date: 'd3', open: 3, close: 3 }] } });
  assert.deepEqual(t.closes.A, [1, 1, 3, 3]);
});

test('signalText: 전략별로 이해하기 쉬운 문장', () => {
  assert.equal(signalText('noul', { signal: 0.71, confidence: 0.4 }), '오를 확률 71%');
  assert.equal(signalText('probability', { signal: 0.64, confidence: 0.5 }), '강세 확률 64%');
  assert.equal(signalText('choice', { signal: 0.8, confidence: 0.62 }), '확신도 62%');
  assert.equal(signalText('score', { signal: 0.8, confidence: 0.5 }), '등급 매수 (3.2/4)');
});
