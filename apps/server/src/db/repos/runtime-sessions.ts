import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { runtimeSessions } from '../schema.js';

export function createRuntimeSessionsRepository(db: AppDatabase) {
  return {
    get(sessionKey: string) {
      return db
        .select()
        .from(runtimeSessions)
        .where(eq(runtimeSessions.sessionKey, sessionKey))
        .get();
    },
    save(record: typeof runtimeSessions.$inferInsert) {
      db.insert(runtimeSessions).values(record).run();
    },
  };
}
