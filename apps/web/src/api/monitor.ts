import { z } from 'zod';
import {
  LogSchema,
  ApprovalDecisionSchema,
  ApprovalSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
} from '@yuno/shared';
import { configurationApi } from './configuration.js';
export const RunDetailSchema = RunSchema.extend({
  steps: RunStepSchema.array(),
  messages: MessageSchema.array(),
  approvals: ApprovalSchema.array(),
});
const UsageSchema = z.object({
  agentId: z.string(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export const monitorApi = {
  logs: (signal: AbortSignal) =>
    configurationApi.get('/logs', LogSchema.array(), signal),
  runs: (signal: AbortSignal) =>
    configurationApi.get('/runs', RunSchema.array(), signal),
  detail: (id: string, signal: AbortSignal) =>
    configurationApi.get(
      `/runs/${encodeURIComponent(id)}`,
      RunDetailSchema,
      signal,
    ),
  messages: (signal: AbortSignal) =>
    configurationApi.get('/messages', MessageSchema.array(), signal),
  usage: (since: number, signal: AbortSignal) =>
    configurationApi.get(
      `/usage?groupBy=agent&since=${since}`,
      UsageSchema.array(),
      signal,
    ),
  decide: (id: string, decision: 'approve' | 'reject') =>
    configurationApi.write(
      `/approvals/${encodeURIComponent(id)}`,
      ApprovalSchema,
      ApprovalDecisionSchema.parse({ decision }),
    ),
  cancel: (id: string) =>
    configurationApi.write(`/runs/${encodeURIComponent(id)}/cancel`, RunSchema),
};
export const money = (value: number) => `$${value.toFixed(4)}`;
