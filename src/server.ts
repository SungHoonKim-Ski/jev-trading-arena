import { CONFIG } from './config.ts';
import { openDatabase } from './db/database.ts';
import { createApp } from './app.ts';
import { logger } from './logger.ts';

const db = openDatabase(CONFIG.dbPath);
const app = createApp({ db });

const resumed = app.runs.requeueUnfinished();
if (resumed.length > 0) {
  logger.info('server', `미완료 실행 ${resumed.length}건을 다시 대기열에 넣습니다`);
  app.queue.enqueue(resumed);
}

if (CONFIG.intradayCollectEnabled) app.collector.startSchedule(app.trackedSymbols, CONFIG.intradayCollectEveryMs);

app.server.listen(CONFIG.port, () => {
  const engine = CONFIG.jev.apiKey ? `live (${CONFIG.jev.model})` : 'mock only (TYPESAFE_API_KEY 미설정)';
  logger.info('server', `http://localhost:${CONFIG.port}  |  Jev engine: ${engine}  |  DB: ${CONFIG.dbPath}`);
});

const shutdown = () => {
  app.collector.stop();
  app.server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
