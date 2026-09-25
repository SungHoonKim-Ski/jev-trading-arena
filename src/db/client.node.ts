import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { initDatabase, type Db } from './database.ts';

/** 로컬 개발·테스트용: SQLite 파일 또는 ':memory:' */
export async function openLocalDatabase(file: string): Promise<Db> {
  if (file === ':memory:') return initDatabase(createClient({ url: ':memory:' }));
  mkdirSync(path.dirname(file), { recursive: true });
  const db = createClient({ url: `file:${file}` });
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA busy_timeout = 5000');
  return initDatabase(db);
}
