import type { Effort, Strategy } from '../types.ts';
import { EFFORT_INFO, HIGH_EFFORT_MIN_CONFIDENCE, NOUL_BUY_THRESHOLD, NOUL_SELL_THRESHOLD, REBALANCE_THRESHOLD } from '../config.ts';
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

/** 목표 비중(raw)과 신뢰도를 현재 비중과 비교해 최종 행동으로 변환 */
function finalize(raw: number | null, confidence: number, signal: number, current: number, gated: boolean): InterpretedDecision {
  if (raw === null || gated) return { action: 'hold', targetWeight: null, confidence, signal };
  const target = Math.max(0, Math.min(1, raw));
  const diff = target - current;
  if (Math.abs(diff) < REBALANCE_THRESHOLD) return { action: 'hold', targetWeight: null, confidence, signal };
  return { action: diff > 0 ? 'buy' : 'sell', targetWeight: target, confidence, signal };
}

function decideAsset(input: InterpretInput, key: string): InterpretedDecision {
  const n = EFFORT_INFO[input.effort].perspectives;
  const current = input.currentWeights[key] ?? 0;
  const gateOn = input.effort === 'high';

  if (input.strategy === 'noul') {
    const nouls = answersOfType(input.answers, key, n, 'noul');
    if (nouls.length === 0) return HOLD_NO_DATA;
    const p = mean(nouls.map((a) => a.noul));
    const raw = p >= NOUL_BUY_THRESHOLD ? 1 : p <= NOUL_SELL_THRESHOLD ? 0 : null;
    const confidence = Math.abs(2 * p - 1);
    return finalize(raw, confidence, p, current, gateOn && confidence < HIGH_EFFORT_MIN_CONFIDENCE);
  }

  if (input.strategy === 'score') {
    const scores = answersOfType(input.answers, key, n, 'score');
    if (scores.length === 0) return HOLD_NO_DATA;
    const signal = mean(scores.map((a) => a.score)) / SCORE_MAX;
    const confidence = mean(scores.map((a) => a.confidence));
    return finalize(signal, confidence, signal, current, gateOn && confidence < HIGH_EFFORT_MIN_CONFIDENCE);
  }

  const choices = answersOfType(input.answers, key, n, 'choice');
  if (choices.length === 0) return HOLD_NO_DATA;
  const pBuy = mean(choices.map((a) => a.probabilities.buy ?? 0));
  const pHold = mean(choices.map((a) => a.probabilities.hold ?? 0));
  const pSell = mean(choices.map((a) => a.probabilities.sell ?? 0));
  const confidence = mean(choices.map((a) => a.confidence));
  const signal = pBuy + 0.5 * pHold;
  const gated = gateOn && confidence < HIGH_EFFORT_MIN_CONFIDENCE;

  if (input.strategy === 'probability') return finalize(signal, confidence, signal, current, gated);

  const top = pBuy >= pHold && pBuy >= pSell ? 'buy' : pSell > pHold ? 'sell' : 'hold';
  const raw = top === 'buy' ? 1 : top === 'sell' ? 0 : null;
  return finalize(raw, confidence, signal, current, gated);
}

/** 종목별 Jev 답변(여러 관점)을 모아 매매 결정으로 해석한다 */
export function interpretAnswers(input: InterpretInput): Record<string, InterpretedDecision> {
  return Object.fromEntries(input.assetKeys.map((key) => [key, decideAsset(input, key)]));
}
