import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  AgentSchema,
  ApprovalSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
  type Message,
  type Run,
  type RunStep,
} from '@yuno/shared';
import type { AppDatabase } from '../client.js';
import {
  agents,
  approvals,
  memories,
  messages,
  runs,
  runSteps,
  schedules,
} from '../schema.js';

const active = ['queued', 'running', 'waiting_approval'] as const;
export function createExecutionRepository(db: AppDatabase) {
  const getRun = (id: string) => {
    const row = db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? RunSchema.parse(row) : undefined;
  };
  const steps = (runId: string) =>
    db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.startedAt), sql`rowid`)
      .all()
      .map((row) => RunStepSchema.parse(row));
  const trail = (
    filter: {
      runId?: string | undefined;
      conversationId?: string | undefined;
    } = {},
  ) =>
    db
      .select()
      .from(messages)
      .where(
        and(
          filter.runId ? eq(messages.runId, filter.runId) : undefined,
          filter.conversationId
            ? eq(messages.conversationId, filter.conversationId)
            : undefined,
        ),
      )
      .orderBy(asc(messages.createdAt), sql`rowid`)
      .all()
      .map((row) => MessageSchema.parse(row));
  return {
    getRun,
    steps,
    trail,
    listRuns: () =>
      db
        .select()
        .from(runs)
        .orderBy(asc(runs.startedAt), sql`rowid`)
        .all()
        .map((row) => RunSchema.parse(row)),
    detail(id: string) {
      const run = getRun(id);
      return run
        ? {
            ...run,
            steps: steps(id),
            messages: trail({ runId: id }),
            approvals: db
              .select()
              .from(approvals)
              .where(eq(approvals.runId, id))
              .all()
              .map((row) => ApprovalSchema.parse(row)),
          }
        : undefined;
    },
    hasActiveRun(workflowId: string) {
      return !!db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(eq(runs.workflowId, workflowId), inArray(runs.status, active)),
        )
        .get();
    },
    hasReferences(workflowId: string) {
      return (
        !!db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.workflowId, workflowId))
          .get() ||
        !!db
          .select({ id: schedules.id })
          .from(schedules)
          .where(eq(schedules.workflowId, workflowId))
          .get()
      );
    },
    insertRun(run: Run) {
      db.insert(runs).values(RunSchema.parse(run)).run();
    },
    updateRun(run: Run) {
      db.update(runs)
        .set(RunSchema.parse(run))
        .where(eq(runs.id, run.id))
        .run();
    },
    insertMessage(message: Message) {
      db.insert(messages).values(MessageSchema.parse(message)).run();
    },
    insertStep(step: RunStep) {
      db.insert(runSteps).values(RunStepSchema.parse(step)).run();
    },
    updateStep(step: RunStep) {
      db.update(runSteps)
        .set(RunStepSchema.parse(step))
        .where(eq(runSteps.id, step.id))
        .run();
    },
    addMemories(agentId: string, facts: readonly string[], now: number) {
      for (const fact of facts)
        db.insert(memories)
          .values({
            id: crypto.randomUUID(),
            agentId,
            fact,
            source: 'agent',
            createdAt: now,
          })
          .run();
    },
    stopMessages(runId: string, error: string, now: number) {
      return db
        .update(messages)
        .set({ status: 'dead', error, updatedAt: now })
        .where(
          and(
            eq(messages.runId, runId),
            inArray(messages.status, ['pending', 'processing', 'failed']),
          ),
        )
        .returning()
        .all()
        .map((row) => MessageSchema.parse(row));
    },
    stopSteps(runId: string, error: string, now: number) {
      return db
        .update(runSteps)
        .set({
          status: sql`case when ${runSteps.status} = 'blocked' then 'blocked' else 'failed' end`,
          error,
          finishedAt: now,
        })
        .where(
          and(
            eq(runSteps.runId, runId),
            inArray(runSteps.status, ['running', 'blocked']),
            sql`${runSteps.finishedAt} is null`,
          ),
        )
        .returning()
        .all()
        .map((row) => RunStepSchema.parse(row));
    },
    settleAgentStatus(agentId: string, now: number) {
      const working = db
        .select({ id: runSteps.id })
        .from(runSteps)
        .where(
          and(eq(runSteps.agentId, agentId), eq(runSteps.status, 'running')),
        )
        .get();
      const pending = db
        .select({ kind: approvals.kind })
        .from(approvals)
        .where(
          and(eq(approvals.agentId, agentId), eq(approvals.status, 'pending')),
        )
        .all();
      const status = working
        ? pending.some((a) => a.kind === 'tool_permission')
          ? 'waiting_approval'
          : 'working'
        : pending.length
          ? 'waiting_approval'
          : 'idle';
      const row = db
        .update(agents)
        .set({ status, updatedAt: now })
        .where(
          and(
            eq(agents.id, agentId),
            ne(agents.status, 'disabled'),
            ne(agents.status, status),
          ),
        )
        .returning()
        .get();
      return row ? AgentSchema.parse(row) : undefined;
    },
    usage(groupBy: 'agent' | 'run', since: number) {
      const key = groupBy === 'agent' ? runSteps.agentId : runSteps.runId;
      return db
        .select({
          id: key,
          inputTokens: sql<number>`sum(${runSteps.inputTokens})`,
          outputTokens: sql<number>`sum(${runSteps.outputTokens})`,
          costUsd: sql<number>`sum(${runSteps.costUsd})`,
        })
        .from(runSteps)
        .where(sql`${runSteps.startedAt} >= ${since}`)
        .groupBy(key)
        .orderBy(key)
        .all()
        .map(({ id, ...row }) => ({
          [groupBy === 'agent' ? 'agentId' : 'runId']: id,
          ...row,
          totalTokens: row.inputTokens + row.outputTokens,
        }));
    },
  };
}
