import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { StreamingTickPricer, type TickFillCache } from '../src/ticks/streamingTickPricer.ts';
import { DuckDbTickStore } from '../src/ticks/duckdbTickStore.ts';
import { localTickPricer } from '../src/ticks/localTickPricer.ts';

const DAY = '2025-01-02';
const start = Date.parse(`${DAY}T00:00:00Z`) * 1000;
/** 가격 100~, 수량 1~3 반복인 2만 건 체결 (id,price,qty,quoteQty,time,isBuyerMaker,isBestMatch) */
const CSV = strToU8(Array.from({ length: 20_000 }, (_, i) => {
  const price = 100 + (i % 50) / 10;
  const qty = 1 + (i % 3);
  return `${i + 1},${price},${qty},${price * qty},${start + i * 1000},False,True`;
}).join('\n'));
const ZIP = zipSync({ [`BTCUSDT-trades-${DAY}.csv`]: CSV });

function streamingFetch(stats: { requests: number; bytes: number }, status = 200): typeof fetch {
  return (async () => {
    stats.requests++;
    if (status !== 200) return new Response('', { status });
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= ZIP.length) { controller.close(); return; }
        const chunk = ZIP.slice(offset, offset + 4096);
        offset += chunk.length;
        stats.bytes += chunk.length;
        controller.enqueue(chunk);
      },
    });
    return new Response(body);
  }) as unknown as typeof fetch;
}

function memoryCache(): TickFillCache & { size: () => number } {
  const m = new Map<string, number>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, size: () => m.size };
}

test('스트리밍 체결가는 원본 틱을 저장한 DuckDB 방식과 같다', async () => {
  const local = localTickPricer(await DuckDbTickStore.open(':memory:', { download: async () => ({ csv: CSV, sha256: 'x' }) }, { maxBytes: 1e12 }));
  const stream = new StreamingTickPricer(memoryCache(), streamingFetch({ requests: 0, bytes: 0 }));
  for (const [qty, p] of [[0.3, 0.1], [5, 0.1], [120, 0.05], [9999, 0.5]] as const) {
    const a = await local.fillPrice('BTCUSDT', DAY, qty, p);
    const b = await stream.fillPrice('BTCUSDT', DAY, qty, p);
    assert.ok(a !== null && b !== null && Math.abs(a - b) < 1e-9, `qty=${qty} p=${p}: local=${a} stream=${b}`);
  }
});

test('주문이 채워지면 다운로드를 멈추고, 같은 요청은 캐시로 재다운로드 없음', async () => {
  const stats = { requests: 0, bytes: 0 };
  const cache = memoryCache();
  const pricer = new StreamingTickPricer(cache, streamingFetch(stats));
  await pricer.fillPrice('BTCUSDT', DAY, 1, 0.1);
  assert.ok(stats.bytes < ZIP.length / 2, `일부만 받음: ${stats.bytes} / ${ZIP.length}`);
  await pricer.fillPrice('BTCUSDT', DAY, 1, 0.1);
  assert.equal(stats.requests, 1);
  assert.equal(cache.size(), 1);
});

test('아직 공개되지 않은 날(404)은 명확한 오류, 지원하지 않는 형식이면 예외', async () => {
  const pricer = new StreamingTickPricer(memoryCache(), streamingFetch({ requests: 0, bytes: 0 }, 404));
  await assert.rejects(pricer.fillPrice('BTCUSDT', DAY, 1, 0.1), /공개되지 않았/);
  assert.equal(await new StreamingTickPricer(memoryCache(), streamingFetch({ requests: 0, bytes: 0 })).fillPrice('BTCUSDT', DAY, 0, 0.1), null);
});
