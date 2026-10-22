import { and, asc, eq, sql } from 'drizzle-orm';
import { ApprovalSchema, type Approval } from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import { approvals, runSteps } from '../schema.js';

export function createApprovalsRepository(db: AppDatabase) {
  return {
    list(status?: Approval['status']) {
      return db
        .select()
        .from(approvals)
        .where(status ? eq(approvals.status, status) : undefined)
        .orderBy(asc(approvals.createdAt))
        .all()
        .map((row) => ApprovalSchema.parse(row));
    },
    get(id: string) {
      const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
      return row ? ApprovalSchema.parse(row) : undefined;
    },
    insert(approval: Approval) {
      db.insert(approvals).values(ApprovalSchema.parse(approval)).run();
    },
    resolve(id: string, status: Approval['status'], now: number) {
      const row = db
        .update(approvals)
        .set({ status, resolvedAt: now })
        .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
        .returning()
        .get();
      return row ? ApprovalSchema.parse(row) : undefined;
    },
    budget(agentId: string, runId: string, now: number) {
      const day = Math.floor(now / 86400000) * 86400000;
      // A turn crossing UTC midnight is charged conservatively to both days it overlaps.
      const row = db
        .select({
          runCost: sql<number>`coalesce(sum(case when ${runSteps.runId} = ${runId} then ${runSteps.costUsd} else 0 end),0)`,
          dailyCost: sql<number>`coalesce(sum(case when (${runSteps.startedAt} >= ${day} or ${runSteps.finishedAt} >= ${day} or ${runSteps.status} = 'running') then ${runSteps.costUsd} else 0 end),0)`,
          turns: sql<number>`coalesce(sum(case when ${runSteps.startedAt} > ${now - 3600000} and ${runSteps.status} != 'blocked' then 1 else 0 end),0)`,
        })
        .from(runSteps)
        .where(eq(runSteps.agentId, agentId))
        .get();
      if (!row) throw new Error('budget_unavailable');
      return row;
    },
  };
}
