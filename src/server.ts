import { createServer } from 'node:http';
import { CONFIG } from './config.ts';
import { openLocalDatabase } from './db/client.node.ts';
import { openRemoteDatabase } from './db/client.web.ts';
import { createApp } from './app.ts';
import { logger } from './logger.ts';

/** TURSO_DATABASE_URL이 있으면 원격 DB, 없으면 로컬 SQLite 파일 */
const db = CONFIG.tursoUrl ? await openRemoteDatabase(CONFIG.tursoUrl, CONFIG.tursoToken) : await openLocalDatabase(CONFIG.dbPath);
const app = createApp({ db });

const resumed = await app.runs.requeueUnfinished();
if (resumed.length > 0) {
  logger.info('server', `미완료 실행 ${resumed.length}건을 다시 대기열에 넣습니다`);
  app.queue.enqueue(resumed);
}

if (CONFIG.intradayCollectEnabled) app.collector.startSchedule(app.trackedSymbols, CONFIG.intradayCollectEveryMs);

const server = createServer((req, res) => { void app.handle(req, res); });
server.listen(CONFIG.port, () => {
  const engine = CONFIG.jev.apiKey ? `live (${CONFIG.jev.model})` : 'mock only (TYPESAFE_API_KEY 미설정)';
  logger.info('server', `http://localhost:${CONFIG.port}  |  Jev engine: ${engine}  |  DB: ${CONFIG.tursoUrl ? 'Turso' : CONFIG.dbPath}`);
});

const shutdown = () => {
  app.collector.stop();
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
