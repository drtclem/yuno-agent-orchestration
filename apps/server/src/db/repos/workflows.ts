import { eq } from 'drizzle-orm';
import { WorkflowSchema, type Workflow } from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import { workflows } from '../schema.js';

export function createWorkflowsRepository(db: AppDatabase) {
  return {
    insert(record: Workflow) {
      db.insert(workflows).values(WorkflowSchema.parse(record)).run();
    },
    get(id: string): Workflow | undefined {
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get();
      return row === undefined ? undefined : WorkflowSchema.parse(row);
    },
    list(): Workflow[] {
      return db
        .select()
        .from(workflows)
        .all()
        .map((row) => WorkflowSchema.parse(row));
    },
    update(record: Workflow) {
      const parsed = WorkflowSchema.parse(record);
      db.update(workflows).set(parsed).where(eq(workflows.id, parsed.id)).run();
    },
    delete(id: string) {
      db.delete(workflows).where(eq(workflows.id, id)).run();
    },
  };
}
