import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRawFeatures, buildAssetState, stateSentiment } from '../src/market/features.ts';
import { barsFromCloses, linearCloses } from './helpers.ts';

test('computeRawFeatures: 상승 추세에서 수익률·이동평균 괴리가 양수', () => {
  const bars = barsFromCloses(linearCloses(100, 1, 80));
  const f = computeRawFeatures(bars, bars.length - 1);
  assert.ok(f.ret20 > 0.1);
  assert.ok(f.gap20 > 0);
  assert.ok(f.rsi14 > 90, `rsi=${f.rsi14}`);
  assert.equal(f.drawdown60, 0);
  assert.equal(f.recentReturns.length, 10);
});

test('computeRawFeatures: 데이터 부족 시 가능한 범위로 계산하고 NaN을 만들지 않음', () => {
  const bars = barsFromCloses([100, 101, 99]);
  const f = computeRawFeatures(bars, 2);
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k}=${v}`);
  }
});

test('computeRawFeatures: 인덱스 범위 밖이면 예외', () => {
  const bars = barsFromCloses([100, 101]);
  assert.throws(() => computeRawFeatures(bars, 5), /index/);
});

test('buildAssetState: effort별 지표 개수가 늘어나고 숫자 대신 라벨을 사용', () => {
  const bars = barsFromCloses(linearCloses(100, 1, 80));
  const f = computeRawFeatures(bars, bars.length - 1);
  const low = buildAssetState(f, 'low');
  const medium = buildAssetState(f, 'medium');
  const high = buildAssetState(f, 'high');
  assert.equal(Object.keys(low).length, 2);
  assert.equal(Object.keys(medium).length, 7);
  assert.equal(Object.keys(high).length, 10);
  for (const v of Object.values(high)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const s of vals) assert.equal(typeof s, 'string');
  }
  assert.equal(low.trend_past_month, 'sharp rise');
});

test('stateSentiment: 상승 상태는 양수, 하락 상태는 음수', () => {
  const up = barsFromCloses(linearCloses(100, 1, 80));
  const down = barsFromCloses(linearCloses(200, -1.5, 80));
  const su = stateSentiment(buildAssetState(computeRawFeatures(up, 79), 'medium'));
  const sd = stateSentiment(buildAssetState(computeRawFeatures(down, 79), 'medium'));
  assert.ok(su > 0, `up=${su}`);
  assert.ok(sd < 0, `down=${sd}`);
  assert.ok(su <= 1 && sd >= -1);
});
