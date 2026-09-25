import { createClient } from '@libsql/client/web';
import { initDatabase, type Db } from './database.ts';

/** 서버리스(Vercel)용: Turso 원격 DB에 HTTP로 연결 (네이티브 모듈 불필요) */
export async function openRemoteDatabase(url: string, authToken: string | undefined): Promise<Db> {
  if (!url) throw new Error('TURSO_DATABASE_URL이 설정되지 않았습니다');
  return initDatabase(createClient({ url, authToken }));
}
