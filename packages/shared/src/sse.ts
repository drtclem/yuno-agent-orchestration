import { z } from 'zod';
import { AgentStatusSchema } from './agents.ts';
import {
  RunSchema,
  RunStepSchema,
  MessageSchema,
  ApprovalSchema,
} from './execution.ts';

const time = z.int().nonnegative();
export const LogSchema = z.strictObject({
  id: z.uuid(),
  ts: time,
  level: z.enum(['info', 'warn', 'error']),
  agentId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  event: z.string().trim().min(1),
  data: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
// Zod 4 discriminated unions validate each event's payload (https://zod.dev/api#discriminated-unions).
export const SSEEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('agent.status'),
    ts: time,
    data: z.strictObject({ agentId: z.uuid(), status: AgentStatusSchema }),
  }),
  z.strictObject({ type: z.literal('run.updated'), ts: time, data: RunSchema }),
  z.strictObject({
    type: z.literal('step.updated'),
    ts: time,
    data: RunStepSchema,
  }),
  z.strictObject({
    type: z.literal('message.created'),
    ts: time,
    data: MessageSchema,
  }),
  z.strictObject({
    type: z.literal('message.updated'),
    ts: time,
    data: MessageSchema,
  }),
  z.strictObject({
    type: z.literal('approval.created'),
    ts: time,
    data: ApprovalSchema,
  }),
  z.strictObject({
    type: z.literal('approval.resolved'),
    ts: time,
    data: ApprovalSchema,
  }),
  z.strictObject({ type: z.literal('log'), ts: time, data: LogSchema }),
  z.strictObject({
    type: z.literal('usage'),
    ts: time,
    data: z.strictObject({
      agentId: z.uuid(),
      runId: z.uuid().nullable(),
      inputTokens: z.int().nonnegative(),
      outputTokens: z.int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  }),
  z.strictObject({
    type: z.literal('channel.status'),
    ts: time,
    data: z.strictObject({
      type: z.literal('slack'),
      connected: z.boolean(),
      detail: z.string().optional(),
    }),
  }),
]);
export type Log = z.infer<typeof LogSchema>;
export type SSEEvent = z.infer<typeof SSEEventSchema>;
