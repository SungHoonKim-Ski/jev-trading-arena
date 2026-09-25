/**
 * 코인 원본 틱 수집 CLI (바이낸스 공개 데이터 → 로컬 DuckDB).
 *   npm run ticks -- BTC,ETH 2026-09-01 2026-09-23
 *   npm run ticks -- ALL 2026-09-20 2026-09-23      # 5종 전체
 * 용량 상한(TICK_STORE_MAX_GB, 기본 10GB)을 넘으면 중단한다.
 */
import { CONFIG } from '../config.ts';
import { DuckDbTickStore } from '../ticks/duckdbTickStore.ts';
import { BinanceTickDownloader } from '../ticks/binanceTickDownloader.ts';
import { CRYPTO_ASSETS, resolveCryptoSymbol } from '../market/binance.ts';
import { logger } from '../logger.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: readonly string[]): { symbols: string[]; from: string; to: string } {
  const [coins, from, to = from] = argv;
  if (!coins || !from || !DATE.test(from) || !DATE.test(to!)) {
    throw new Error('사용법: npm run ticks -- <BTC,ETH|ALL> <시작일 YYYY-MM-DD> [종료일]');
  }
  const symbols = coins.toUpperCase() === 'ALL'
    ? CRYPTO_ASSETS.map((a) => a.symbol)
    : coins.split(',').map((c) => {
      const s = resolveCryptoSymbol(c);
      if (!s) throw new Error(`지원하지 않는 코인: ${c} (지원: ${CRYPTO_ASSETS.map((a) => a.ticker).join(', ')})`);
      return s;
    });
  return { symbols, from, to: to! };
}

async function main(): Promise<void> {
  const { symbols, from, to } = parseArgs(process.argv.slice(2));
  const store = await DuckDbTickStore.open(CONFIG.ticks.path, new BinanceTickDownloader(), { maxBytes: CONFIG.ticks.maxBytes });
  try {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      for (const symbol of symbols) {
        const started = Date.now();
        const r = await store.loadDay(symbol, date);
        logger.info('ticks', `${symbol} ${date}: ${r.trades.toLocaleString()} trades ${r.cached ? '(이미 있음)' : `(${Date.now() - started}ms)`} | store ${(store.sizeBytes() / 1e9).toFixed(2)}GB`);
      }
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  logger.error('ticks', 'failed', err);
  process.exit(1);
});
