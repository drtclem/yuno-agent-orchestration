import { z } from 'zod';
import { WorkflowGraphSchema } from './workflows.ts';

const text = z.string().trim().min(1);
const time = z.int().nonnegative();
const tokens = z.int().nonnegative();
const cost = z.number().nonnegative();
export const VerdictSchema = z.enum(['approved', 'rejected']);
export const RunSchema = z.strictObject({
  id: z.uuid(),
  workflowId: z.uuid().nullable(),
  graphSnapshot: WorkflowGraphSchema.nullable().default(null),
  trigger: z.enum(['ui', 'schedule', 'chat']),
  input: z.string(),
  status: z.enum([
    'queued',
    'running',
    'waiting_approval',
    'completed',
    'failed',
    'cancelled',
  ]),
  result: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: time.nullable(),
  finishedAt: time.nullable(),
  totalCostUsd: cost,
  totalTokens: tokens,
});
export const RunStepSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  nodeId: text,
  agentId: z.uuid(),
  iteration: z.int().positive(),
  status: z.enum(['running', 'completed', 'failed', 'blocked']),
  prompt: z.string(),
  output: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  inputTokens: tokens,
  outputTokens: tokens,
  costUsd: cost,
  startedAt: time,
  finishedAt: time.nullable(),
  error: z.string().nullable(),
});
export const MessageSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid().nullable(),
  conversationId: text.nullable(),
  fromKind: z.enum(['agent', 'human', 'system']),
  fromId: text,
  fromName: text.nullable().default(null),
  toAgentId: z.uuid(),
  channel: z.enum(['internal', 'slack', 'ui', 'schedule']),
  content: z.string(),
  verdict: VerdictSchema.nullable(),
  status: z.enum(['pending', 'processing', 'acked', 'failed', 'dead']),
  attempts: tokens,
  nextAttemptAt: time,
  idempotencyKey: text,
  error: z.string().nullable(),
  createdAt: time,
  updatedAt: time,
});
export const ApprovalSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  stepId: z.uuid(),
  agentId: z.uuid(),
  kind: z.enum(['step_gate', 'tool_permission']),
  detail: text,
  runtimeSessionId: text.nullable(),
  runtimePermissionId: text.nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  createdAt: time,
  resolvedAt: time.nullable(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
