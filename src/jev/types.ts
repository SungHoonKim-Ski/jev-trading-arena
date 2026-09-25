/** TypeSafe System One API (POST /v1/systemone) 요청/응답 타입 */
export type Instructions = string | Record<string, unknown> | readonly unknown[];

export type JevQuestion =
  | { readonly type: 'noul'; readonly instructions: Instructions; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: Instructions; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: 'score'; readonly instructions: Instructions; readonly criteria: readonly string[] };

export interface JevRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export type JevAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: Readonly<Record<string, number>>; readonly legend: Readonly<Record<string, string>>; readonly confidence: number };

export interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** 캐시에서 응답한 경우 true (API 호출·과금 없음) */
  readonly cached?: boolean;
}

export interface JevClient {
  readonly mode: 'live' | 'mock';
  evaluate(request: JevRequest): Promise<JevResponse>;
}
