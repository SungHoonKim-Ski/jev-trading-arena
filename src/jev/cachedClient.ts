import { createHash } from 'node:crypto';
import type { JevClient, JevRequest, JevResponse } from './types.ts';

export interface JevCacheStore {
  get(key: string): string | null;
  set(key: string, model: string, value: string): void;
}

/**
 * 동일 요청 재호출 방지(비용·레이트리밋 절약). 같은 기간·전략을 여러 사용자가 돌려도 1회만 호출.
 * 캐시 응답은 usage를 0으로 돌려 비용이 중복 집계되지 않게 한다.
 */
export class CachedJevClient implements JevClient {
  readonly mode: JevClient['mode'];
  readonly #inner: JevClient;
  readonly #store: JevCacheStore;

  constructor(inner: JevClient, store: JevCacheStore) {
    this.#inner = inner;
    this.#store = store;
    this.mode = inner.mode;
  }

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const hit = this.#store.get(key);
    if (hit) {
      const res = JSON.parse(hit) as JevResponse;
      return { ...res, usage: { input_tokens: 0, output_tokens: 0 }, cached: true };
    }
    const res = await this.#inner.evaluate(request);
    this.#store.set(key, res.model, JSON.stringify(res));
    return res;
  }
}
