import { createHash } from 'node:crypto';
import { stateSentiment, type AssetState } from '../market/features.ts';
import { parseQuestionId } from './questions.ts';
import type { JevAnswer, JevClient, JevQuestion, JevRequest, JevResponse } from './types.ts';

/** 요청 내용으로 결정되는 의사 난수 (-1~1). 같은 요청이면 같은 결과 */
function jitter(seed: string): number {
  const h = createHash('sha256').update(seed).digest();
  return (h.readUInt32BE(0) / 0xffffffff) * 2 - 1;
}

function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((s, v) => s + v, 0);
  return exps.map((e) => e / sum);
}

function confidenceOf(probs: readonly number[]): number {
  // 정규화 엔트로피 기반: 분포가 뾰족할수록 1에 가깝다
  const h = -probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  return 1 - h / Math.log(probs.length);
}

function answer(question: JevQuestion, bias: number): JevAnswer {
  const k = 3;
  if (question.type === 'noul') {
    return { type: 'noul', noul: 1 / (1 + Math.exp(-k * bias)) };
  }
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    const logits = keys.map((key) => (key === 'buy' ? k * bias : key === 'sell' ? -k * bias : 0.3));
    const probs = softmax(logits);
    const top = keys[probs.indexOf(Math.max(...probs))]!;
    return { type: 'choice', choice: top, probabilities: Object.fromEntries(keys.map((key, i) => [key, probs[i]!])), confidence: confidenceOf(probs) };
  }
  const levels = question.criteria.length;
  const center = ((bias + 1) / 2) * (levels - 1);
  const probs = softmax(Array.from({ length: levels }, (_, i) => -((i - center) ** 2)));
  const score = probs.reduce((s, p, i) => s + p * i, 0);
  return {
    type: 'score', score, confidence: confidenceOf(probs),
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
    legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])),
  };
}

/**
 * API 키 없이 파이프라인을 돌리기 위한 결정적 모의 엔진 (실제 Jev 아님).
 * Jev가 받는 것과 동일한 라벨 state만 보고 강세/약세를 추정한다.
 * 결과는 DB에 engine='mock'으로 저장되어 실제 Jev 결과와 랭킹이 섞이지 않는다.
 */
export class MockJevClient implements JevClient {
  readonly mode = 'mock' as const;

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const assets = (request.state as { assets?: Record<string, AssetState> }).assets ?? {};
    const stateJson = JSON.stringify(request.state);
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const parsed = parseQuestionId(id);
      const asset = parsed ? assets[parsed.assetKey] : undefined;
      const sentiment = asset ? stateSentiment(asset) : 0;
      const bias = Math.max(-1, Math.min(1, sentiment + 0.25 * jitter(`${stateJson}|${id}`)));
      answers[id] = answer(q, bias);
    }
    const tokens = Math.ceil((stateJson.length + JSON.stringify(request.questions).length) / 4);
    return { model: 'jev-mock', answers, usage: { input_tokens: tokens, output_tokens: 0 } };
  }
}
