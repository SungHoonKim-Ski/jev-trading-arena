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

/** 서버가 틱 파일을 열고 있으면(DuckDB는 한 프로세스만 쓸 수 있음) 서버 API로 하루씩 수집 */
async function collectViaServer(symbols: readonly string[], from: string, to: string): Promise<void> {
  const base = `http://127.0.0.1:${CONFIG.port}`;
  const tickers = symbols.map((s) => s.replace(/USDT$/, ''));
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const res = await fetch(`${base}/api/ticks/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers, from: date, to: date }),
    }).catch((err: unknown) => {
      throw new Error(`틱 저장소는 다른 프로세스가 쓰는 중인데 ${base} 서버에 연결할 수 없습니다. 서버와 같은 PORT로 실행하세요`, { cause: err });
    });
    const body = await res.json() as { success: boolean; data: { symbol: string; trades?: number; cached?: boolean; error?: string }[]; error: string | null };
    if (!body.success) throw new Error(body.error ?? `HTTP ${res.status}`);
    for (const r of body.data) logger.info('ticks', `${r.symbol} ${date}: ${r.error ?? `${r.trades?.toLocaleString()} trades${r.cached ? ' (이미 있음)' : ''}`}`);
  }
}

async function main(): Promise<void> {
  const { symbols, from, to } = parseArgs(process.argv.slice(2));
  let store: DuckDbTickStore;
  try {
    store = await DuckDbTickStore.open(CONFIG.ticks.path, new BinanceTickDownloader(), { maxBytes: CONFIG.ticks.maxBytes });
  } catch (err) {
    if (!/lock/i.test(String(err))) throw err;
    logger.info('ticks', '서버가 틱 저장소를 사용 중이라 서버 API로 수집합니다');
    await collectViaServer(symbols, from, to);
    return;
  }
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
