import { createServer } from 'node:http';
import { CONFIG } from './config.ts';
import { openLocalDatabase } from './db/client.node.ts';
import { openRemoteDatabase } from './db/client.web.ts';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import type { TickStore } from './ticks/types.ts';

/** 원본 틱 저장소는 DuckDB 네이티브 모듈이라 로컬 서버에서만 연다 (서버리스 번들에 포함되지 않도록 동적 import) */
async function openTickStore(): Promise<TickStore | null> {
  if (!CONFIG.ticks.enabled) return null;
  try {
    const [{ DuckDbTickStore }, { BinanceTickDownloader }] = await Promise.all([
      import('./ticks/duckdbTickStore.ts'), import('./ticks/binanceTickDownloader.ts'),
    ]);
    return await DuckDbTickStore.open(CONFIG.ticks.path, new BinanceTickDownloader(), { maxBytes: CONFIG.ticks.maxBytes });
  } catch (err) {
    logger.warn('server', 'tick store unavailable; tick execution disabled', err);
    return null;
  }
}

/** TURSO_DATABASE_URL이 있으면 원격 DB, 없으면 로컬 SQLite 파일 */
const db = CONFIG.tursoUrl ? await openRemoteDatabase(CONFIG.tursoUrl, CONFIG.tursoToken) : await openLocalDatabase(CONFIG.dbPath);
const ticks = await openTickStore();
const app = createApp({ db, ticks });

const resumed = await app.runs.requeueUnfinished();
if (resumed.length > 0) {
  logger.info('server', `미완료 실행 ${resumed.length}건을 다시 대기열에 넣습니다`);
  app.queue.enqueue(resumed);
}

if (CONFIG.intradayCollectEnabled) app.collector.startSchedule(app.trackedSymbols, CONFIG.intradayCollectEveryMs);
if (ticks && CONFIG.ticks.dailyCollect) {
  // 전날 코인 원본 틱을 수집 (이미 있으면 건너뜀, 용량 상한을 넘으면 중단)
  const collectTicks = () => app.collectYesterdayTicks()
    .then((n) => { if (n > 0) logger.info('ticks', `collected ${n} new coin-days of raw ticks`); })
    .catch((err) => logger.error('ticks', 'daily tick collection failed', err));
  void collectTicks();
  setInterval(collectTicks, CONFIG.intradayCollectEveryMs).unref();
}

const server = createServer((req, res) => { void app.handle(req, res); });
server.listen(CONFIG.port, () => {
  const engine = CONFIG.jev.apiKey ? `live (${CONFIG.jev.model})` : 'mock only (TYPESAFE_API_KEY 미설정)';
  logger.info('server', `http://localhost:${CONFIG.port}  |  Jev engine: ${engine}  |  DB: ${CONFIG.tursoUrl ? 'Turso' : CONFIG.dbPath}  |  ticks: ${ticks ? CONFIG.ticks.path : 'off'}`);
});

const shutdown = () => {
  app.collector.stop();
  server.close();
  db.close();
  ticks?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
