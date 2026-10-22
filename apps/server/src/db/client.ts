import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export function openDatabase(filename: string) {
  if (filename !== ':memory:')
    mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename, { timeout: 5000 });
  try {
    // SQLite keeps :memory: databases in memory journal mode; disk databases use WAL.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    // https://orm.drizzle.team/docs/migrations — apply checked-in migrations on startup.
    migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('./repos/migrations/', import.meta.url),
      ),
    });
    return { db, sqlite, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
// Accept transaction handles so related repository writes can commit atomically.
export type AppDatabase = Pick<
  ReturnType<typeof openDatabase>['db'],
  'insert' | 'select' | 'update' | 'delete'
>;
