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

function scoreAnswer(probs: readonly number[], confidence = 0.8): JevAnswer {
  const score = probs.reduce((s, p, i) => s + p * i, 0);
  return { type: 'score', score, confidence, legend: {}, probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])) };
}

type Rule = 'opposite' | 'drop';
function decide(answer: JevAnswer | JevAnswer[], strategy: 'choice' | 'probability' | 'noul' | 'score', opts: { current?: number; threshold?: number; exitRule?: Rule; effort?: 'low' | 'medium' | 'high' } = {}) {
  const list = Array.isArray(answer) ? answer : [answer];
  const answers = Object.fromEntries(list.map((a, k) => [questionId('a', k), a]));
  return interpretAnswers({
    answers, assetKeys: ['a'], strategy, effort: opts.effort ?? (list.length === 3 ? 'high' : list.length === 2 ? 'medium' : 'low'),
    currentWeights: { a: opts.current ?? 0 }, threshold: opts.threshold ?? 0.8, exitRule: opts.exitRule ?? 'opposite',
  }).a!;
}

const noul = (p: number): JevAnswer => ({ type: 'noul', noul: p });

test('반대 매도: 오른다 확률 ≥ 임계값이면 매수, 내린다 확률 ≥ 임계값이면 매도, 사이면 보유 유지', () => {
  assert.equal(decide(noul(0.85), 'noul').targetWeight, 1);
  assert.equal(decide(noul(0.85), 'noul').action, 'buy');
  assert.equal(decide(noul(0.5), 'noul', { current: 1 }).targetWeight, null, '애매하면 그대로');
  assert.equal(decide(noul(0.25), 'noul', { current: 1 }).targetWeight, null, '내린다 75% < 80% → 유지');
  assert.equal(decide(noul(0.15), 'noul', { current: 1 }).targetWeight, 0, '내린다 85% ≥ 80% → 매도');
});

test('임계값이 높을수록 덜 움직임: 90%면 오를 확률 85%로는 사지 않음', () => {
  assert.equal(decide(noul(0.85), 'noul', { threshold: 0.9 }).targetWeight, null);
  assert.equal(decide(noul(0.92), 'noul', { threshold: 0.9 }).targetWeight, 1);
});

test('즉시 매도: 오른다 확률이 임계값 아래로 내려가면 바로 매도', () => {
  assert.equal(decide(noul(0.85), 'noul', { exitRule: 'drop' }).targetWeight, 1);
  assert.equal(decide(noul(0.79), 'noul', { current: 1, exitRule: 'drop' }).targetWeight, 0);
  assert.equal(decide(noul(0.79), 'noul', { current: 0, exitRule: 'drop' }).targetWeight, null, '이미 없으면 거래 없음');
});

test('단호하게(choice): 매수·매도 확률에 임계값 적용', () => {
  assert.equal(decide(choiceAnswer(0.85, 0.1, 0.05), 'choice').targetWeight, 1);
  assert.equal(decide(choiceAnswer(0.7, 0.2, 0.1), 'choice').targetWeight, null, '매수가 1등이어도 70% < 80%면 관망');
  assert.equal(decide(choiceAnswer(0.05, 0.1, 0.85), 'choice', { current: 1 }).targetWeight, 0);
});

test('확률대로(probability): 임계값을 넘으면 확률분포로 비중 산정', () => {
  const r = decide(choiceAnswer(0.82, 0.16, 0.02), 'probability');
  assert.ok(Math.abs(r.targetWeight! - 0.9) < 1e-9); // 0.82 + 0.5×0.16
  assert.equal(decide(choiceAnswer(0.5, 0.4, 0.1), 'probability').targetWeight, null);
});

test('등급으로(score): 매수·강력매수 확률 합, 매도·강력매도 확률 합에 임계값 적용', () => {
  const bull = decide(scoreAnswer([0, 0.05, 0.1, 0.45, 0.4]), 'score');
  assert.ok(Math.abs(bull.targetWeight! - (0.05 + 0.2 + 1.35 + 1.6) / 4) < 1e-9);
  assert.equal(decide(scoreAnswer([0.1, 0.2, 0.4, 0.2, 0.1]), 'score', { current: 0.5 }).targetWeight, null);
  assert.equal(decide(scoreAnswer([0.5, 0.35, 0.1, 0.05, 0]), 'score', { current: 1 }).action, 'sell');
});

test('여러 관점(effort)은 확률을 평균한 뒤 임계값 비교', () => {
  assert.equal(decide([noul(0.95), noul(0.7)], 'noul').targetWeight, 1, '평균 82.5%');
  assert.equal(decide([noul(0.95), noul(0.6)], 'noul').targetWeight, null, '평균 77.5%');
});

test('high effort: 임계값을 넘어도 신뢰도가 낮으면 행동하지 않음', () => {
  const low = [0, 1, 2].map(() => choiceAnswer(0.81, 0.1, 0.09, 0.1));
  assert.equal(decide(low, 'choice').targetWeight, null);
});

test('답변 누락 시 예외 대신 유지(hold)', () => {
  const r = interpretAnswers({ answers: {}, assetKeys: ['a'], strategy: 'noul', effort: 'low', currentWeights: { a: 0.3 }, threshold: 0.8, exitRule: 'opposite' });
  assert.equal(r.a!.targetWeight, null);
  assert.equal(r.a!.confidence, 0);
});
