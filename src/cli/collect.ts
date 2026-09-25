/**
 * 분봉 수집 CLI. cron 등에 등록해 매일 실행하면 1분봉 이력이 계속 누적된다.
 *   npm run collect                 # 이미 추적 중인 모든 종목
 *   npm run collect -- KR 005930 000660
 *   npm run collect -- US AAPL NVDA
 *   npm run collect -- CRYPTO BTC ETH
 */
import { CONFIG } from '../config.ts';
import { openLocalDatabase } from '../db/client.node.ts';
import { openRemoteDatabase } from '../db/client.web.ts';
import { PriceRepository } from '../db/priceRepository.ts';
import { IntradayRepository } from '../db/intradayRepository.ts';
import { PriceService } from '../market/priceService.ts';
import { IntradayCollector } from '../market/intradayCollector.ts';
import { logger } from '../logger.ts';
import type { Market } from '../types.ts';

async function main(): Promise<void> {
  const [marketArg, ...tickers] = process.argv.slice(2);
  const db = CONFIG.tursoUrl ? await openRemoteDatabase(CONFIG.tursoUrl, CONFIG.tursoToken) : await openLocalDatabase(CONFIG.dbPath);
  const priceRepo = new PriceRepository(db);
  const prices = new PriceService(priceRepo);
  const collector = new IntradayCollector(new IntradayRepository(db));
  let symbols: string[];
  if (marketArg) {
    if (!['KR', 'US', 'CRYPTO'].includes(marketArg)) throw new Error('첫 인자는 KR, US, CRYPTO 중 하나여야 합니다');
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    symbols = [];
    for (const t of tickers) symbols.push((await prices.getBars(marketArg as Market, t, from, today)).symbol);
  } else {
    symbols = (await priceRepo.listSymbols()).filter((s) => !s.startsWith('^'));
  }
  for (const r of await collector.collectMany(symbols)) {
    logger.info('collect', `${r.symbol}: ${JSON.stringify(r.saved)}${r.errors.length ? ` errors=${r.errors.join('; ')}` : ''}`);
  }
  db.close();
}

main().catch((err) => {
  logger.error('collect', 'failed', err);
  process.exit(1);
});
