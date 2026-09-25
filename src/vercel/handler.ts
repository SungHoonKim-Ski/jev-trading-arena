import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import { CONFIG } from '../config.ts';
import { openRemoteDatabase } from '../db/client.web.ts';
import { createApp, type App } from '../app.ts';
import { logger } from '../logger.ts';

let appPromise: Promise<App> | null = null;

/** 인스턴스당 한 번만 DB 연결·스키마 확인 (웜 스타트 시 재사용) */
function getApp(): Promise<App> {
  appPromise ??= openRemoteDatabase(CONFIG.tursoUrl, CONFIG.tursoToken).then((db) => createApp({ db }));
  return appPromise;
}

/** 라우팅 규칙이 /api?__path=... 로 재작성해도 원래 경로로 복원 */
function restorePath(req: IncomingMessage): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original === null) return;
  url.searchParams.delete('__path');
  const query = url.searchParams.toString();
  req.url = `/api/${original}${query ? `?${query}` : ''}`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  restorePath(req);
  let app: App;
  try {
    app = await getApp();
  } catch (err) {
    appPromise = null;
    logger.error('vercel', 'database init failed', err);
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, data: null, error: '데이터베이스에 연결할 수 없습니다' }));
    return;
  }
  await app.handle(req, res);
  // 응답을 보낸 뒤에도 대기열의 백테스트가 끝날 때까지 함수를 살려 둔다 (최대 maxDuration)
  if (app.queue.size > 0) waitUntil(app.queue.onIdle());
}
