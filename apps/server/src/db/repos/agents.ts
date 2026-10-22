import { eq } from 'drizzle-orm';
import { AgentSchema, type Agent } from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import { agents } from '../schema.js';

export function createAgentsRepository(db: AppDatabase) {
  return {
    setStatus(id: string, status: Agent['status'], updatedAt: number) {
      const fields = AgentSchema.pick({ status: true, updatedAt: true }).parse({
        status,
        updatedAt,
      });
      const row = db
        .update(agents)
        .set(fields)
        .where(eq(agents.id, id))
        .returning()
        .get();
      return row === undefined ? undefined : AgentSchema.parse(row);
    },
    insert(record: Agent) {
      db.insert(agents).values(AgentSchema.parse(record)).run();
    },
    get(id: string): Agent | undefined {
      const row = db.select().from(agents).where(eq(agents.id, id)).get();
      return row === undefined ? undefined : AgentSchema.parse(row);
    },
    list(): Agent[] {
      return db
        .select()
        .from(agents)
        .all()
        .map((row) => AgentSchema.parse(row));
    },
    update(record: Agent) {
      const parsed = AgentSchema.parse(record);
      db.update(agents).set(parsed).where(eq(agents.id, parsed.id)).run();
    },
    delete(id: string) {
      db.delete(agents).where(eq(agents.id, id)).run();
    },
  };
}
