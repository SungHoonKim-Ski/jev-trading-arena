import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { TickDownload, TickDownloader } from './types.ts';

export class ChecksumMismatchError extends Error {
  constructor(file: string) {
    super(`체크섬 불일치: ${file} (다운로드가 손상됐을 수 있습니다)`);
    this.name = 'ChecksumMismatchError';
  }
}

const BASE = process.env.BINANCE_DATA_BASE ?? 'https://data.binance.vision';

/**
 * 바이낸스 공개 데이터(data.binance.vision)의 일별 원본 체결 파일.
 * API 키가 필요 없고 보통 다음 날 공개된다. 파일마다 SHA-256 체크섬이 함께 제공된다.
 */
export class BinanceTickDownloader implements TickDownloader {
  readonly #fetch: typeof fetch;
  constructor(fetchImpl: typeof fetch = fetch) { this.#fetch = fetchImpl; }

  async download(symbol: string, date: string): Promise<TickDownload> {
    const file = `${symbol}-trades-${date}.zip`;
    const url = `${BASE}/data/spot/daily/trades/${symbol}/${file}`;
    const [zipRes, sumRes] = await Promise.all([
      this.#fetch(url, { signal: AbortSignal.timeout(180_000) }),
      this.#fetch(`${url}.CHECKSUM`, { signal: AbortSignal.timeout(20_000) }),
    ]);
    if (zipRes.status === 404) throw new Error(`${date} ${symbol} 틱 파일이 아직 공개되지 않았습니다 (보통 다음 날 공개)`);
    if (!zipRes.ok) throw new Error(`틱 파일 다운로드 실패 (${file}): HTTP ${zipRes.status}`);
    const zip = new Uint8Array(await zipRes.arrayBuffer());
    const sha256 = createHash('sha256').update(zip).digest('hex');
    if (sumRes.ok) {
      const expected = (await sumRes.text()).trim().split(/\s+/)[0];
      if (expected && expected !== sha256) throw new ChecksumMismatchError(file);
    }
    const entries = unzipSync(zip);
    const csv = Object.values(entries)[0];
    if (!csv) throw new Error(`빈 압축 파일: ${file}`);
    return { csv, sha256 };
  }
}
