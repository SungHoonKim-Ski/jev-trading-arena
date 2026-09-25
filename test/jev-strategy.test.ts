import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJevRequest, questionId } from '../src/jev/questions.ts';
import { interpretAnswers } from '../src/jev/interpret.ts';
import type { JevAnswer } from '../src/jev/types.ts';

const STATE = { asset_1: { trend_past_month: 'rise', price_vs_20_day_average: 'above its average' } };

test('buildJevRequest: effort에 따라 종목당 관점(질문) 수가 1/2/3개', () => {
  for (const [effort, n] of [['low', 1], ['medium', 2], ['high', 3]] as const) {
    const req = buildJevRequest({ assets: STATE, strategy: 'choice', effort, intervalDays: 5, model: 'jev-latest' });
    assert.equal(Object.keys(req.questions).length, n);
    assert.deepEqual(req.state, { assets: STATE });
  }
});

test('buildJevRequest: 전략별 질문 타입 매핑', () => {
  const expected = { choice: 'choice', probability: 'choice', noul: 'noul', score: 'score' } as const;
  for (const [strategy, type] of Object.entries(expected)) {
    const req = buildJevRequest({ assets: STATE, strategy: strategy as keyof typeof expected, effort: 'low', intervalDays: 1, model: 'm' });
    const q = req.questions[questionId('asset_1', 0)]!;
    assert.equal(q.type, type);
    assert.match(JSON.stringify(q.instructions), /`assets\.asset_1`/);
  }
});

test('buildJevRequest: 종목이 없으면 예외', () => {
  assert.throws(() => buildJevRequest({ assets: {}, strategy: 'noul', effort: 'low', intervalDays: 1, model: 'm' }), /asset/);
});

function choiceAnswer(buy: number, hold: number, sell: number, confidence = 0.8): JevAnswer {
  return { type: 'choice', choice: buy >= hold && buy >= sell ? 'buy' : sell >= hold ? 'sell' : 'hold', probabilities: { buy, hold, sell }, confidence };
}

test('interpret choice: 최빈 선택지 실행, hold는 비중 유지', () => {
  const buy = interpretAnswers({ answers: { [questionId('a', 0)]: choiceAnswer(0.7, 0.2, 0.1) }, assetKeys: ['a'], strategy: 'choice', effort: 'low', currentWeights: { a: 0 } });
  assert.equal(buy.a!.targetWeight, 1);
  assert.equal(buy.a!.action, 'buy');
  const hold = interpretAnswers({ answers: { [questionId('a', 0)]: choiceAnswer(0.2, 0.6, 0.2) }, assetKeys: ['a'], strategy: 'choice', effort: 'low', currentWeights: { a: 0.5 } });
  assert.equal(hold.a!.targetWeight, null);
  assert.equal(hold.a!.action, 'hold');
});

test('interpret choice(high): 신뢰도가 낮으면 행동하지 않음', () => {
  const answers = Object.fromEntries([0, 1, 2].map((k) => [questionId('a', k), choiceAnswer(0.4, 0.3, 0.3, 0.1)]));
  const r = interpretAnswers({ answers, assetKeys: ['a'], strategy: 'choice', effort: 'high', currentWeights: { a: 0 } });
  assert.equal(r.a!.targetWeight, null);
});

test('interpret probability: 확률분포 기대 노출(P(buy)+0.5·P(hold))로 비중 산정', () => {
  const r = interpretAnswers({ answers: { [questionId('a', 0)]: choiceAnswer(0.5, 0.4, 0.1) }, assetKeys: ['a'], strategy: 'probability', effort: 'low', currentWeights: { a: 0 } });
  assert.ok(Math.abs(r.a!.targetWeight! - 0.7) < 1e-9);
  assert.equal(r.a!.action, 'buy');
});

test('interpret noul: 임계값 기반 매수/매도/유지', () => {
  const mk = (p: number) => interpretAnswers({ answers: { [questionId('a', 0)]: { type: 'noul', noul: p } }, assetKeys: ['a'], strategy: 'noul', effort: 'low', currentWeights: { a: 0.5 } }).a!;
  assert.equal(mk(0.8).targetWeight, 1);
  assert.equal(mk(0.2).targetWeight, 0);
  assert.equal(mk(0.5).targetWeight, null);
});

test('interpret noul(high): 확률이 임계값을 넘어도 확신이 약하면 유지', () => {
  const answers = Object.fromEntries([0, 1, 2].map((k) => [questionId('a', k), { type: 'noul' as const, noul: 0.62 }]));
  const r = interpretAnswers({ answers, assetKeys: ['a'], strategy: 'noul', effort: 'high', currentWeights: { a: 0 } });
  assert.equal(r.a!.targetWeight, null);
  const low = interpretAnswers({ answers: { [questionId('a', 0)]: { type: 'noul', noul: 0.62 } }, assetKeys: ['a'], strategy: 'noul', effort: 'low', currentWeights: { a: 0 } });
  assert.equal(low.a!.targetWeight, 1);
});

test('interpret score: 5단계 기대값을 비중으로, 여러 관점은 평균', () => {
  const answers = {
    [questionId('a', 0)]: { type: 'score', score: 4, confidence: 0.9, probabilities: {}, legend: {} },
    [questionId('a', 1)]: { type: 'score', score: 2, confidence: 0.9, probabilities: {}, legend: {} },
  } satisfies Record<string, JevAnswer>;
  const r = interpretAnswers({ answers, assetKeys: ['a'], strategy: 'score', effort: 'medium', currentWeights: { a: 0 } });
  assert.ok(Math.abs(r.a!.targetWeight! - 0.75) < 1e-9);
});

test('interpret: 답변 누락 시 예외 대신 유지(hold) 처리', () => {
  const r = interpretAnswers({ answers: {}, assetKeys: ['a'], strategy: 'noul', effort: 'low', currentWeights: { a: 0.3 } });
  assert.equal(r.a!.targetWeight, null);
  assert.equal(r.a!.confidence, 0);
});
