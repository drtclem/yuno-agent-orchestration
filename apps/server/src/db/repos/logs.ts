import { desc, eq, sql } from 'drizzle-orm';
import { LogSchema, type Log } from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import { logs } from '../schema.js';

export function createLogsRepository(db: AppDatabase) {
  return {
    insert(record: Log) {
      db.insert(logs).values(LogSchema.parse(record)).run();
    },
    get(id: string): Log | undefined {
      const row = db.select().from(logs).where(eq(logs.id, id)).get();
      return row === undefined ? undefined : LogSchema.parse(row);
    },
    latest(limit: number): Log[] {
      return db
        .select()
        .from(logs)
        .orderBy(desc(logs.ts), sql`rowid desc`)
        .limit(limit)
        .all()
        .reverse()
        .map((row) => LogSchema.parse(row));
    },
    list(): Log[] {
      return db
        .select()
        .from(logs)
        .all()
        .map((row) => LogSchema.parse(row));
    },
  };
}
