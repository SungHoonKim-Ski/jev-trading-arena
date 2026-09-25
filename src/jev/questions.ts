import type { Effort, Strategy } from '../types.ts';
import type { AssetState } from '../market/features.ts';
import { EFFORT_INFO } from '../config.ts';
import type { JevQuestion, JevRequest } from './types.ts';

export const CHOICE_CRITERIA = {
  buy: 'The price is more likely to rise than fall; owning the stock is favorable.',
  hold: 'The outlook is balanced or unclear; keep the current position unchanged.',
  sell: 'The price is more likely to fall than rise; not owning the stock is favorable.',
} as const;

export const SCORE_LEVELS = [
  'Strong sell: the price is very likely to fall significantly',
  'Sell: the price is more likely to fall than rise',
  'Neutral: rising and falling are about equally likely',
  'Buy: the price is more likely to rise than fall',
  'Strong buy: the price is very likely to rise significantly',
] as const;

export const SCORE_MAX = SCORE_LEVELS.length - 1;

export function questionId(assetKey: string, perspective: number): string {
  return `${assetKey}__p${perspective}`;
}

export function parseQuestionId(id: string): { assetKey: string; perspective: number } | null {
  const m = /^(.+)__p(\d+)$/.exec(id);
  return m ? { assetKey: m[1]!, perspective: Number(m[2]) } : null;
}

function horizonText(intervalDays: number): string {
  return intervalDays <= 1 ? 'the next trading day' : `the next ${intervalDays} trading days`;
}

/** effort가 높을수록 더 많은 관점으로 같은 판단을 묻고 코드에서 앙상블한다 */
function perspectives(intervalDays: number): readonly string[] {
  const horizon = horizonText(intervalDays);
  return [
    `Looking only at the market data in \`{ref}\`, over ${horizon}`,
    `As a trend-following investor reading \`{ref}\`, over the next month`,
    `As a cautious, risk-averse investor reading \`{ref}\`, over ${horizon}`,
  ];
}

function questionFor(strategy: Strategy, lead: string): JevQuestion {
  switch (strategy) {
    case 'choice':
    case 'probability':
      return { type: 'choice', instructions: `${lead}, what should be done with a position in this stock?`, criteria: CHOICE_CRITERIA };
    case 'noul':
      return {
        type: 'noul',
        instructions: `${lead}, will this stock's price be higher than it is today?`,
        criteria: { true: 'The price will likely be higher.', false: 'The price will likely be lower or unchanged.' },
      };
    case 'score':
      return { type: 'score', instructions: `${lead}, how would you rate the outlook for this stock?`, criteria: SCORE_LEVELS };
  }
}

export interface BuildRequestInput {
  readonly assets: Readonly<Record<string, AssetState>>;
  readonly strategy: Strategy;
  readonly effort: Effort;
  readonly intervalDays: number;
  readonly model: string;
}

/**
 * 한 결정일의 모든 종목을 하나의 요청으로 묶는다(speculative fan-out 패턴).
 * 종목명·날짜는 state에 넣지 않는다: 모델이 과거 주가를 기억해 미래를 "커닝"하는 것을 막기 위함.
 */
export function buildJevRequest(input: BuildRequestInput): JevRequest {
  const assetKeys = Object.keys(input.assets);
  if (assetKeys.length === 0) throw new Error('at least one asset is required');
  const leads = perspectives(input.intervalDays).slice(0, EFFORT_INFO[input.effort].perspectives);
  const questions: Record<string, JevQuestion> = {};
  for (const key of assetKeys) {
    leads.forEach((lead, k) => {
      questions[questionId(key, k)] = questionFor(input.strategy, lead.replace('{ref}', `assets.${key}`));
    });
  }
  return { model: input.model, state: { assets: input.assets }, questions };
}
