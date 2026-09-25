import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalDatabase } from '../src/db/client.node.ts';
import { RunRepository, type RunArtifacts } from '../src/db/runRepository.ts';
import type { RunParams } from '../src/types.ts';

const PARAMS: RunParams = {
  nickname: 'alice', market: 'US', tickers: ['AAPL'], startDate: '2024-01-01', endDate: '2024-12-31',
  intervalDays: 5, effort: 'low', strategy: 'noul', initialCapital: 10000, engine: 'mock', execution: 'open',
};

function artifacts(totalReturn: number, bench = 0.1): RunArtifacts {
  return {
    equity: [{ date: '2024-01-02', equity: 10000, benchmark: 10000, index: 10000 }],
    trades: [{ date: '2024-01-03', symbol: 'AAPL', side: 'buy', shares: 1, price: 100, fee: 0 }],
    decisions: [{ date: '2024-01-02', symbol: 'AAPL', action: 'buy', targetWeight: 1, confidence: 0.5, signal: 0.7 }],
    metrics: { totalReturn, cagr: totalReturn, mdd: -0.1, sharpe: 1, volatility: 0.2, trades: 1, fees: 0, finalEquity: 10000 * (1 + totalReturn) },
    summary: { totalReturn, benchmarkReturn: bench, indexReturn: 0.05, jevCalls: 10, jevInputTokens: 1000, jevCostUsd: 0.00004, model: 'jev-mock', tickFills: null, intradayFills: null, fallbackFills: null },
  };
}

async function seed() {
  const repo = new RunRepository(await openLocalDatabase(':memory:'));
  const mk = async (p: Partial<RunParams>, ret: number) => {
    const id = await repo.create({ ...PARAMS, ...p }, 'g1');
    await repo.complete(id, artifacts(ret));
    return id;
  };
  await mk({ nickname: 'alice', strategy: 'noul' }, 0.3);
  await mk({ nickname: 'alice', strategy: 'score' }, 0.1);
  await mk({ nickname: 'bob', strategy: 'noul' }, 0.2);
  await mk({ nickname: 'carol', strategy: 'choice', market: 'KR' }, 0.5);
  await repo.create({ ...PARAMS, nickname: 'dave' }, 'g2'); // queued: 랭킹 제외
  return repo;
}

test('leaderboard: 완료된 실행만, 수익률 내림차순, 필터 적용', async () => {
  const repo = await seed();
  const us = await repo.leaderboard({ market: 'US' }, 'total_return', 10, false);
  assert.deepEqual(us.map((r) => r.nickname), ['alice', 'bob', 'alice']);
  assert.equal(us[0]!.rank, 1);
  assert.deepEqual(us[0]!.tickers, ['AAPL']);
  const best = await repo.leaderboard({}, 'total_return', 10, true);
  assert.deepEqual(best.map((r) => r.nickname), ['carol', 'alice', 'bob']);
});

test('leaderboard: 초과수익(excess) 정렬', async () => {
  const rows = await (await seed()).leaderboard({ market: 'US' }, 'excess_return', 1, false);
  assert.ok(Math.abs(Number(rows[0]!.excess_return) - 0.2) < 1e-9);
});

test('strategyStats: 전략×effort×주기별 평균', async () => {
  const stats = await (await seed()).strategyStats({ market: 'US' });
  const noul = stats.find((s) => s.strategy === 'noul')!;
  assert.equal(noul.runs, 2);
  assert.equal(noul.users, 2);
  assert.ok(Math.abs(Number(noul.avg_return) - 0.25) < 1e-9);
  assert.equal(stats[0]!.strategy, 'noul');
});

test('getDetail / requeueUnfinished / 실패 처리', async () => {
  const repo = await seed();
  const detail = (await repo.getDetail(1))!;
  assert.equal((detail.equity as unknown[]).length, 1);
  assert.equal((detail.trades as unknown[]).length, 1);
  assert.equal(await repo.getDetail(999), null);
  const running = await repo.create(PARAMS, 'g3');
  await repo.setStatus(running, 'running');
  assert.deepEqual(await repo.requeueUnfinished(), [5, running]);
  await repo.setStatus(running, 'failed', 'boom');
  assert.equal((await repo.get(running))!.error, 'boom');
  assert.equal((await repo.getParams(running))!.nickname, 'alice');
  assert.equal((await repo.list({ nickname: 'bob', limit: 10 })).length, 1);
});

test('claim: 대기 중인 실행은 한 번만 가져갈 수 있음 (서버리스 중복 실행 방지)', async () => {
  const repo = new RunRepository(await openLocalDatabase(':memory:'));
  const id = await repo.create(PARAMS, 'g');
  assert.equal(await repo.claim(id), true);
  assert.equal(await repo.claim(id), false);
  assert.equal((await repo.get(id))!.status, 'running');
});

test('recoverStale: 오래 멈춘 running만 대기열로 되돌림', async () => {
  const repo = new RunRepository(await openLocalDatabase(':memory:'));
  const stuck = await repo.create(PARAMS, 'g');
  const fresh = await repo.create(PARAMS, 'g');
  const waiting = await repo.create(PARAMS, 'g');
  await repo.claim(stuck);
  await repo.claim(fresh);
  assert.deepEqual(await repo.recoverStale(60_000, 10), [waiting]);
  assert.deepEqual(await repo.recoverStale(-1, 10), [stuck, fresh, waiting]);
});
