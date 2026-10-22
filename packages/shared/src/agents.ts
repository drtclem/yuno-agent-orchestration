import { z } from 'zod';

// D4 curated pools; inventory source and review date recorded in docs/questions.md Q-06.
export const ALLOWED_MODELS = [
  { id: 'openai/gpt-5.4-mini', pool: '2.5M/day pool' },
  { id: 'openai/gpt-5.4-nano', pool: '2.5M/day pool' },
  { id: 'openai/gpt-5-mini', pool: '2.5M/day pool' },
  { id: 'openai/gpt-5.4', pool: '250K/day pool' },
] as const;
export const ModelSchema = z.enum(ALLOWED_MODELS.map((model) => model.id));
const text = z.string().trim().min(1);
export const PermissionSchema = z.enum(['allow', 'ask', 'deny']);
export const PermissionsSchema = z.strictObject({
  bash: PermissionSchema.default('deny'),
  edit: PermissionSchema.default('deny'),
  webfetch: PermissionSchema.default('deny'),
  denyBash: z.array(text).default([]),
  canDeploy: z.boolean().default(false),
});
export const GuardrailsSchema = z.strictObject({
  dailyCostCapUsd: z.number().nonnegative().default(2),
  runCostCapUsd: z.number().nonnegative().default(0.5),
  maxTurnsPerHour: z.int().positive().default(30),
  turnTimeoutMs: z.int().positive().default(600000),
});
export const AgentStatusSchema = z.enum([
  'idle',
  'working',
  'waiting_approval',
  'error',
  'disabled',
]);
export const AgentInputSchema = z.strictObject({
  name: text,
  role: text,
  systemPrompt: text,
  model: ModelSchema.default('openai/gpt-5.4-mini'),
  tools: z
    .strictObject({
      bash: z.boolean().default(false),
      edit: z.boolean().default(false),
      webfetch: z.boolean().default(false),
    })
    .prefault({}),
  permissions: PermissionsSchema.prefault({}),
  guardrails: GuardrailsSchema.prefault({}),
});
// Retain unavailable models for display and repair; writes use AgentInputSchema.
export const AgentSettingsSchema = AgentInputSchema.extend({
  model: text.default('openai/gpt-5.4-mini'),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export const AgentSchema = AgentSettingsSchema.extend({
  id: z.uuid(),
  status: AgentStatusSchema,
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
});
export const SkillSchema = z.strictObject({
  id: z.uuid(),
  name: text,
  description: z.string(),
  stepsMd: text,
  createdAt: z.int().nonnegative(),
});
export const MemorySchema = z.strictObject({
  id: z.uuid(),
  agentId: z.uuid(),
  fact: text,
  source: z.enum(['ui', 'agent']),
  createdAt: z.int().nonnegative(),
});
export const ScheduleInputSchema = z
  .strictObject({
    kind: z.enum(['cron', 'interval']),
    expr: text,
    prompt: text,
    workflowId: z.uuid().nullable(),
    enabled: z.boolean(),
  })
  .refine(
    (schedule) =>
      schedule.kind !== 'interval' ||
      (/^[1-9]\d*$/.test(schedule.expr) &&
        Number.isSafeInteger(Number(schedule.expr))),
    { path: ['expr'], message: 'Interval must be positive integer seconds' },
  );
// safeExtend retains interval validation on the persisted record. https://zod.dev/api#safeextend
export const ScheduleSchema = ScheduleInputSchema.safeExtend({
  id: z.uuid(),
  agentId: z.uuid(),
  lastRunAt: z.int().nonnegative().nullable(),
  nextRunAt: z.int().nonnegative().nullable(),
});
export const ChannelBindingSchema = z.strictObject({
  id: z.uuid(),
  agentId: z.uuid(),
  type: z.literal('slack'),
  config: z.strictObject({ respondTo: z.literal('dm_and_mentions') }),
  enabled: z.boolean(),
});
export type Model = z.infer<typeof ModelSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type AgentInput = z.infer<typeof AgentInputSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;
