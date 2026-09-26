import type { TickPricer, TickStore } from './types.ts';

/** 로컬 서버: 체결일 원본 틱을 DuckDB에 저장(없으면 받아서)한 뒤 계산 */
export function localTickPricer(store: TickStore): TickPricer {
  return {
    mode: 'local',
    async fillPrice(symbol, date, quantity, participation) {
      await store.loadDay(symbol, date);
      return store.fillPrice(symbol, date, quantity, participation);
    },
  };
}
