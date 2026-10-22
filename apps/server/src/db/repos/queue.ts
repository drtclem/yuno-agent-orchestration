import { and, asc, eq, inArray, lte, notExists, sql } from 'drizzle-orm';
import {
  MessageSchema,
  RunSchema,
  SSEEventSchema,
  type Message,
  type SSEEvent,
} from '@yuno/shared';
import type { AppDatabase, openDatabase } from '../client.js';
import { approvals, messages, runs } from '../schema.js';

export type Completion = (tx: AppDatabase) => SSEEvent[];
export type ProcessingResult = Completion | { park: Completion };

// One dispatcher owns this database; startup recovery is not a distributed lease.
export function createQueueRepository(
  db: ReturnType<typeof openDatabase>['db'],
) {
  const notWaiting = notExists(
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, messages.runId),
          eq(approvals.agentId, messages.toAgentId),
          eq(approvals.status, 'pending'),
        ),
      ),
  );
  const deliverable = sql`(${messages.runId} is null or exists (select 1 from ${runs} where ${runs.id} = ${messages.runId} and ${runs.status} in ('running', 'queued')))`;
  return {
    enqueue(record: Message) {
      const parsed = MessageSchema.parse(record);
      if (parsed.status !== 'pending' || parsed.attempts !== 0)
        throw new Error('invalid_enqueue_state');
      const inserted = db
        .insert(messages)
        .values(parsed)
        .onConflictDoNothing({ target: messages.idempotencyKey })
        .returning()
        .get();
      const row =
        inserted ??
        db
          .select()
          .from(messages)
          .where(eq(messages.idempotencyKey, parsed.idempotencyKey))
          .get();
      return {
        message: MessageSchema.parse(row),
        created: inserted !== undefined,
      };
    },
    recover(now: number) {
      return db
        .update(messages)
        .set({ status: 'pending', updatedAt: now })
        .where(and(eq(messages.status, 'processing'), notWaiting))
        .returning()
        .all()
        .map((row) => MessageSchema.parse(row));
    },
    claim(now: number, busy: ReadonlySet<string>) {
      return db.transaction((tx) => {
        const row = tx
          .select()
          .from(messages)
          .where(
            and(
              inArray(messages.status, ['pending', 'failed']),
              lte(messages.nextAttemptAt, now),
              notWaiting,
              deliverable,
              busy.size
                ? sql`${messages.toAgentId} not in (${sql.join(
                    [...busy].map((id) => sql`${id}`),
                    sql`, `,
                  )})`
                : undefined,
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(1)
          .get();
        if (!row) return undefined;
        const claimed = tx
          .update(messages)
          .set({ status: 'processing', updatedAt: now })
          .where(and(eq(messages.id, row.id), eq(messages.status, row.status)))
          .returning()
          .get();
        return claimed ? MessageSchema.parse(claimed) : undefined;
      });
    },
    complete(message: Message, now: number, completion: ProcessingResult) {
      return db.transaction((tx) => {
        const acked = tx
          .update(messages)
          .set({
            status: typeof completion === 'function' ? 'acked' : 'pending',
            error: null,
            updatedAt: now,
          })
          .where(
            and(eq(messages.id, message.id), eq(messages.status, 'processing')),
          )
          .returning()
          .get();
        if (!acked) throw new Error('message_claim_lost');
        const events = (
          typeof completion === 'function'
            ? completion(tx)
            : completion.park(tx)
        ).map((event) => SSEEventSchema.parse(event));
        return { message: MessageSchema.parse(acked), events };
      });
    },
    release(message: Message, now: number) {
      const row = db
        .update(messages)
        .set({ status: 'pending', updatedAt: now })
        .where(
          and(eq(messages.id, message.id), eq(messages.status, 'processing')),
        )
        .returning()
        .get();
      return row ? MessageSchema.parse(row) : undefined;
    },
    fail(message: Message, now: number) {
      return db.transaction((tx) => {
        const attempts = message.attempts + 1;
        const row = tx
          .update(messages)
          .set({
            attempts,
            status: attempts >= 3 ? 'dead' : 'failed',
            error: 'message_processing_failed',
            nextAttemptAt: now + 2 ** attempts * 5000,
            updatedAt: now,
          })
          .where(
            and(eq(messages.id, message.id), eq(messages.status, 'processing')),
          )
          .returning()
          .get();
        let run;
        if (row?.status === 'dead' && row.runId) {
          run = tx
            .update(runs)
            .set({
              status: 'failed',
              error: 'message_processing_failed',
              finishedAt: now,
            })
            .where(
              and(
                eq(runs.id, row.runId),
                inArray(runs.status, ['running', 'queued', 'waiting_approval']),
              ),
            )
            .returning()
            .get();
        }
        return {
          message: row ? MessageSchema.parse(row) : undefined,
          run: run ? RunSchema.parse(run) : undefined,
        };
      });
    },
  };
}
