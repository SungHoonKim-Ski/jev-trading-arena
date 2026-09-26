import { Unzip, UnzipInflate } from 'fflate';
import type { TickPricer } from './types.ts';

export interface TickFillCache {
  get(key: string): Promise<number | null>;
  set(key: string, price: number): Promise<void>;
}

const BASE = process.env.BINANCE_DATA_BASE ?? 'https://data.binance.vision';

interface Walk {
  need: number;
  cum: number;
  notional: number;
  last: number | null;
  done: boolean;
  leftover: string;
}

/** CSV 줄(id,price,qty,...)을 체결 순서대로 따라가며 need만큼의 시장 체결량을 누적 */
function consumeLines(w: Walk, text: string): void {
  const lines = (w.leftover + text).split('\n');
  w.leftover = lines.pop() ?? '';
  for (const line of lines) {
    const [, priceText, qtyText] = line.split(',');
    const price = Number(priceText);
    const qty = Number(qtyText);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue; // 헤더 등
    const take = Math.min(qty, w.need - w.cum);
    w.notional += price * take;
    w.cum += take;
    w.last = price;
    if (w.cum >= w.need) { w.done = true; return; }
  }
}

/**
 * 서버리스용 틱 체결가 계산. 원본 틱을 저장하지 않는다.
 * 바이낸스 일별 체결 zip을 받으며 바로 압축을 풀고, 0시부터 체결을 따라가다 주문이 채워지면 다운로드를 멈춘다.
 * (작은 주문은 파일 앞부분 수 KB만 받는다.) 결과는 캐시에 저장해 같은 요청은 다시 받지 않는다.
 */
export class StreamingTickPricer implements TickPricer {
  readonly mode = 'stream' as const;
  readonly #cache: TickFillCache;
  readonly #fetch: typeof fetch;

  constructor(cache: TickFillCache, fetchImpl: typeof fetch = fetch) {
    this.#cache = cache;
    this.#fetch = fetchImpl;
  }

  async fillPrice(symbol: string, date: string, quantity: number, participation: number): Promise<number | null> {
    if (!(quantity > 0) || !(participation > 0 && participation <= 1)) return null;
    const need = quantity / participation;
    const key = `${symbol}|${date}|${need.toPrecision(8)}`;
    const cached = await this.#cache.get(key);
    if (cached !== null) return cached;
    const price = await this.#walk(symbol, date, need);
    if (price !== null) await this.#cache.set(key, price);
    return price;
  }

  async #walk(symbol: string, date: string, need: number): Promise<number | null> {
    const res = await this.#fetch(`${BASE}/data/spot/daily/trades/${symbol}/${symbol}-trades-${date}.zip`, { signal: AbortSignal.timeout(120_000) });
    if (res.status === 404) throw new Error(`${date} ${symbol} 틱 파일이 아직 공개되지 않았습니다 (보통 다음 날 공개)`);
    if (!res.ok || !res.body) throw new Error(`틱 파일 다운로드 실패 (${symbol} ${date}): HTTP ${res.status}`);
    const w: Walk = { need, cum: 0, notional: 0, last: null, done: false, leftover: '' };
    const decoder = new TextDecoder();
    let unzipError: unknown = null;
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      file.ondata = (err, chunk, final) => {
        if (err) { unzipError = err; return; }
        if (w.done) return;
        consumeLines(w, decoder.decode(chunk, { stream: !final }));
        if (final && !w.done && w.leftover) consumeLines(w, '\n');
      };
      file.start();
    };
    const reader = res.body.getReader();
    try {
      while (!w.done && !unzipError) {
        const { value, done } = await reader.read();
        if (done) { unzip.push(new Uint8Array(0), true); break; }
        unzip.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (unzipError) throw unzipError instanceof Error ? unzipError : new Error(String(unzipError));
    if (w.cum === 0 || w.last === null) return null;
    // 하루 거래량으로 다 못 채우면 나머지는 마지막 체결가로 (DuckDB 방식과 동일)
    return (w.notional + Math.max(0, w.need - w.cum) * w.last) / w.need;
  }
}
