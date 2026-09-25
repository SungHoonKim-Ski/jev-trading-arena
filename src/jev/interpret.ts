import type { Effort, Strategy } from '../types.ts';
import { EFFORT_INFO, HIGH_EFFORT_MIN_CONFIDENCE, REBALANCE_THRESHOLD } from '../config.ts';
import { questionId, SCORE_MAX } from './questions.ts';
import type { JevAnswer } from './types.ts';

export interface InterpretedDecision {
  readonly action: 'buy' | 'sell' | 'hold';
  readonly targetWeight: number | null;
  readonly confidence: number;
  readonly signal: number;
}

export interface InterpretInput {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly assetKeys: readonly string[];
  readonly strategy: Strategy;
  readonly effort: Effort;
  readonly currentWeights: Readonly<Record<string, number>>;
  /** 행동에 필요한 최소 확률 (예: 0.8 = 80%) */
  readonly threshold: number;
  readonly exitRule: ExitRule;
}

const HOLD_NO_DATA: InterpretedDecision = { action: 'hold', targetWeight: null, confidence: 0, signal: 0.5 };

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function answersOfType<T extends JevAnswer['type']>(
  answers: Readonly<Record<string, JevAnswer>>, assetKey: string, count: number, type: T,
): Extract<JevAnswer, { type: T }>[] {
  const out: Extract<JevAnswer, { type: T }>[] = [];
  for (let k = 0; k < count; k++) {
    const a = answers[questionId(assetKey, k)];
    if (a && a.type === type) out.push(a as Extract<JevAnswer, { type: T }>);
  }
  return out;
}

import type { ExitRule } from '../types.ts';
export type { ExitRule };

/** 한 종목에 대한 Jev 답변 요약: 오른다 쪽·내린다 쪽 확률, 행동 시 목표 비중, 신뢰도 */
interface Outlook {
  readonly bull: number;
  readonly bear: number;
  readonly buyTarget: number;
  readonly sellTarget: number;
  readonly confidence: number;
}

function levelProbability(a: Extract<JevAnswer, { type: 'score' }>, levels: readonly number[]): number {
  return levels.reduce((s, l) => s + (a.probabilities[String(l)] ?? 0), 0);
}

/** 전략별로 답변(여러 관점이면 평균)을 오른다/내린다 확률로 바꾼다 */
function outlookOf(input: InterpretInput, key: string): Outlook | null {
  const n = EFFORT_INFO[input.effort].perspectives;
  if (input.strategy === 'noul') {
    const nouls = answersOfType(input.answers, key, n, 'noul');
    if (nouls.length === 0) return null;
    const p = mean(nouls.map((a) => a.noul));
    return { bull: p, bear: 1 - p, buyTarget: 1, sellTarget: 0, confidence: Math.abs(2 * p - 1) };
  }
  if (input.strategy === 'score') {
    const scores = answersOfType(input.answers, key, n, 'score');
    if (scores.length === 0) return null;
    const weight = mean(scores.map((a) => a.score)) / SCORE_MAX;
    return {
      bull: mean(scores.map((a) => levelProbability(a, [SCORE_MAX - 1, SCORE_MAX]))),
      bear: mean(scores.map((a) => levelProbability(a, [0, 1]))),
      buyTarget: weight, sellTarget: weight, confidence: mean(scores.map((a) => a.confidence)),
    };
  }
  const choices = answersOfType(input.answers, key, n, 'choice');
  if (choices.length === 0) return null;
  const pBuy = mean(choices.map((a) => a.probabilities.buy ?? 0));
  const pHold = mean(choices.map((a) => a.probabilities.hold ?? 0));
  const pSell = mean(choices.map((a) => a.probabilities.sell ?? 0));
  // 확률대로: 확률분포로 비중(매수 + 보유의 절반), 단호하게: 전부 사거나 전부 판다
  const weight = pBuy + 0.5 * pHold;
  const continuous = input.strategy === 'probability';
  return {
    bull: pBuy, bear: pSell,
    buyTarget: continuous ? weight : 1, sellTarget: continuous ? weight : 0,
    confidence: mean(choices.map((a) => a.confidence)),
  };
}

/** 목표 비중을 현재 비중과 비교해 최종 행동으로 변환 (변화가 작으면 거래하지 않음) */
function finalize(target: number | null, confidence: number, signal: number, current: number): InterpretedDecision {
  if (target === null) return { action: 'hold', targetWeight: null, confidence, signal };
  const clamped = Math.max(0, Math.min(1, target));
  const diff = clamped - current;
  if (Math.abs(diff) < REBALANCE_THRESHOLD) return { action: 'hold', targetWeight: null, confidence, signal };
  return { action: diff > 0 ? 'buy' : 'sell', targetWeight: clamped, confidence, signal };
}

/**
 * 임계값 규칙:
 * - 오른다 쪽 확률 ≥ 임계값 → 매수 목표 비중
 * - 반대 매도(opposite): 내린다 쪽 확률 ≥ 임계값일 때만 매도, 그 사이는 보유 유지
 * - 즉시 매도(drop): 오른다 쪽 확률이 임계값 미만이면 바로 매도(비중 0)
 * 기록되는 signal은 행동을 일으킨 확률 (매수면 오른다 쪽, 매도면 내린다 쪽)
 */
function decideAsset(input: InterpretInput, key: string): InterpretedDecision {
  const o = outlookOf(input, key);
  if (!o) return HOLD_NO_DATA;
  const current = input.currentWeights[key] ?? 0;
  if (input.effort === 'high' && o.confidence < HIGH_EFFORT_MIN_CONFIDENCE) return finalize(null, o.confidence, o.bull, current);
  if (o.bull >= input.threshold) return finalize(o.buyTarget, o.confidence, o.bull, current);
  if (input.exitRule === 'drop') return finalize(0, o.confidence, 1 - o.bull, current);
  if (o.bear >= input.threshold) return finalize(o.sellTarget, o.confidence, o.bear, current);
  return finalize(null, o.confidence, o.bull, current);
}

/** 종목별 Jev 답변(여러 관점)을 임계값 규칙으로 매매 결정으로 해석한다 */
export function interpretAnswers(input: InterpretInput): Record<string, InterpretedDecision> {
  return Object.fromEntries(input.assetKeys.map((key) => [key, decideAsset(input, key)]));
}
