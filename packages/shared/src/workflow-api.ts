import { z } from 'zod';
import { WorkflowSchema } from './workflows.ts';

export const TemplateParamsSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const WorkflowInputSchema = WorkflowSchema.pick({
  name: true,
  description: true,
  graph: true,
});
export const RunInputSchema = z.strictObject({ input: z.string() });
export const MessageQuerySchema = z.strictObject({
  runId: z.uuid().optional(),
  conversationId: z.string().trim().min(1).optional(),
});
export const UsageQuerySchema = z.strictObject({
  groupBy: z.enum(['agent', 'run']).default('agent'),
  since: z.coerce.number().int().nonnegative().default(0),
});

export const ApprovalQuerySchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
});
export const ApprovalDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(4000).optional(),
});

export const LogQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
