import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/api/http.ts';

test('RateLimiter: 윈도우 내 한도 초과 차단, 윈도우가 지나면 허용', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 1), true);
  assert.equal(rl.allow('a', 2), false);
  assert.equal(rl.allow('b', 2), true);
  assert.equal(rl.allow('a', 1001), true);
});

test('RateLimiter: 추적 키가 많아지면 만료된 항목 정리', () => {
  const rl = new RateLimiter(1, 10);
  for (let i = 0; i < 10_001; i++) rl.allow(`k${i}`, 0);
  rl.allow('new', 100);
  assert.equal(rl.trackedKeys, 1);
});
