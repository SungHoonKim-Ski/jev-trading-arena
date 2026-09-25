import type { RunRepository } from '../db/runRepository.ts';
import { logger } from '../logger.ts';

/** 동시 실행 수를 제한하는 백테스트 대기열 (Jev 레이트리밋 보호) */
export class RunQueue {
  readonly #pending: number[] = [];
  readonly #active = new Set<number>();
  readonly #concurrency: number;
  readonly #runs: RunRepository;
  readonly #execute: (id: number) => Promise<void>;
  #idleResolvers: (() => void)[] = [];

  constructor(runs: RunRepository, execute: (id: number) => Promise<void>, concurrency: number) {
    this.#runs = runs;
    this.#execute = execute;
    this.#concurrency = Math.max(1, concurrency);
  }

  enqueue(ids: readonly number[]): void {
    this.#pending.push(...ids.filter((id) => !this.#active.has(id) && !this.#pending.includes(id)));
    this.#pump();
  }

  get size(): number { return this.#pending.length + this.#active.size; }

  /** 테스트용: 대기열이 빌 때까지 대기 */
  onIdle(): Promise<void> {
    return this.size === 0 ? Promise.resolve() : new Promise((r) => this.#idleResolvers.push(r));
  }

  #pump(): void {
    while (this.#active.size < this.#concurrency && this.#pending.length > 0) {
      const id = this.#pending.shift()!;
      this.#active.add(id);
      this.#execute(id)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('queue', `run ${id} failed`, err);
          try {
            this.#runs.setStatus(id, 'failed', message.slice(0, 500));
          } catch (dbErr) {
            logger.error('queue', `could not mark run ${id} as failed`, dbErr);
          }
        })
        .finally(() => {
          this.#active.delete(id);
          this.#pump();
          if (this.size === 0) {
            const resolvers = this.#idleResolvers;
            this.#idleResolvers = [];
            resolvers.forEach((r) => r());
          }
        });
    }
  }
}
