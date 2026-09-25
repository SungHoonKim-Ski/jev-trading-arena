import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { DuckDbTickStore, TickBudgetError } from '../src/ticks/duckdbTickStore.ts';
import { BinanceTickDownloader, ChecksumMismatchError } from '../src/ticks/binanceTickDownloader.ts';
import type { TickDownloader } from '../src/ticks/types.ts';

const DAY = '2025-01-02';
const dayStartUs = Date.UTC(2025, 0, 2) * 1000;

/** id,price,qty,quoteQty,time,isBuyerMaker,isBestMatch (바이낸스 trades CSV 형식) */
function csv(rows: [number, number, number, number][], unit: 'ms' | 'us' = 'us'): Uint8Array {
  return strToU8(rows.map(([id, price, qty, offsetSec]) => {
    const t = unit === 'us' ? dayStartUs + offsetSec * 1e6 : Date.UTC(2025, 0, 2) + offsetSec * 1000;
    return `${id},${price},${qty},${price * qty},${t},False,True`;
  }).join('\n'));
}

const ROWS: [number, number, number, number][] = [[1, 100, 1, 1], [2, 110, 1, 2], [3, 120, 2, 3], [4, 130, 10, 4]];

function fakeDownloader(bytes: Uint8Array): TickDownloader & { calls: number } {
  const d = { calls: 0, download: async () => { d.calls++; return { csv: bytes, sha256: 'x' }; } };
  return d;
}

test('loadDay: 적재 후 재호출해도 중복 없음, 커버리지 기록', async () => {
  const dl = fakeDownloader(csv(ROWS));
  const store = await DuckDbTickStore.open(':memory:', dl, { maxBytes: 1e12 });
  assert.equal(await store.hasDay('BTCUSDT', DAY), false);
  assert.equal((await store.loadDay('BTCUSDT', DAY)).trades, 4);
  await store.loadDay('BTCUSDT', DAY);
  assert.equal(dl.calls, 1, '이미 있는 날은 다시 받지 않음');
  assert.equal(await store.hasDay('BTCUSDT', DAY), true);
  const cov = await store.coverage();
  assert.deepEqual(cov.map((c) => [c.symbol, c.days, c.trades]), [['BTCUSDT', 1, 4]]);
  store.close();
});

test('loadDay: 밀리초 시각(옛 파일)도 마이크로초로 통일', async () => {
  const store = await DuckDbTickStore.open(':memory:', fakeDownloader(csv(ROWS, 'ms')), { maxBytes: 1e12 });
  await store.loadDay('BTCUSDT', DAY);
  const p = await store.fillPrice('BTCUSDT', DAY, 0.1, 0.1);
  assert.equal(p, 100, '첫 체결(1초) 가격');
  store.close();
});

test('fillPrice: 참여율만큼 체결 흐름을 따라가며 체결가 계산', async () => {
  const store = await DuckDbTickStore.open(':memory:', fakeDownloader(csv(ROWS)), { maxBytes: 1e12 });
  await store.loadDay('BTCUSDT', DAY);
  // 수량 0.3, 참여율 10% → 시장 거래량 3개를 따라감: 100×1 + 110×1 + 120×1 = 330 / 3
  assert.equal(await store.fillPrice('BTCUSDT', DAY, 0.3, 0.1), 110);
  // 하루 거래량(14)으로 부족하면 나머지는 마지막 가격(130)
  const big = await store.fillPrice('BTCUSDT', DAY, 2, 0.1); // 필요 20
  assert.ok(Math.abs(big! - (100 + 110 + 240 + 1300 + 6 * 130) / 20) < 1e-9);
  assert.equal(await store.fillPrice('BTCUSDT', '2025-01-03', 1, 0.1), null, '틱 없는 날');
  store.close();
});

test('용량 상한을 넘으면 새 날짜 적재 거부', async () => {
  const store = await DuckDbTickStore.open(':memory:', fakeDownloader(csv(ROWS)), { maxBytes: 0 });
  await assert.rejects(store.loadDay('BTCUSDT', DAY), TickBudgetError);
  store.close();
});

function zipResponse(name: string, content: Uint8Array) {
  const zip = zipSync({ [name]: content });
  const sha = createHash('sha256').update(zip).digest('hex');
  return { zip, sha };
}

test('BinanceTickDownloader: zip 체크섬 검증 후 CSV 반환, 불일치면 예외', async () => {
  const content = csv(ROWS);
  const { zip, sha } = zipResponse(`BTCUSDT-trades-${DAY}.csv`, content);
  const urls: string[] = [];
  const mk = (checksum: string) => (async (url: string) => {
    urls.push(url);
    if (url.endsWith('.CHECKSUM')) return new Response(`${checksum}  BTCUSDT-trades-${DAY}.zip`);
    return new Response(zip);
  }) as unknown as typeof fetch;
  const ok = await new BinanceTickDownloader(mk(sha)).download('BTCUSDT', DAY);
  assert.deepEqual(Buffer.from(ok.csv), Buffer.from(content));
  assert.equal(ok.sha256, sha);
  assert.match(urls[0]!, /data\.binance\.vision\/data\/spot\/daily\/trades\/BTCUSDT\/BTCUSDT-trades-2025-01-02\.zip/);
  await assert.rejects(new BinanceTickDownloader(mk('0'.repeat(64))).download('BTCUSDT', DAY), ChecksumMismatchError);
});

test('BinanceTickDownloader: 아직 공개되지 않은 날(404)은 명확한 오류', async () => {
  const f = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(new BinanceTickDownloader(f).download('BTCUSDT', DAY), /공개되지 않았/);
});
