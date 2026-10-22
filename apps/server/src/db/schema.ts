import {
  customType,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  AgentSchema,
  ChannelBindingSchema,
  LogSchema,
  WorkflowGraphSchema,
} from '@yuno/shared';

// Validate JSON in both directions; .$type alone provides no runtime validation.
// https://orm.drizzle.team/docs/custom-types
function json<T>(name: string, schema: z.ZodType<T>) {
  return customType<{ data: T; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => JSON.stringify(schema.parse(value)),
    fromDriver: (value) => schema.parse(JSON.parse(value)),
  })(name);
}

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull().unique(),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  model: text('model').notNull(),
  tools: json('tools_json', AgentSchema.shape.tools).notNull(),
  permissions: json(
    'permissions_json',
    AgentSchema.shape.permissions,
  ).notNull(),
  guardrails: json('guardrails_json', AgentSchema.shape.guardrails).notNull(),
  status: text('status', {
    enum: ['idle', 'working', 'waiting_approval', 'error', 'disabled'],
  }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  stepsMd: text('steps_md').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const agentSkills = sqliteTable(
  'agent_skills',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.skillId] })],
);
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey().notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  fact: text('fact').notNull(),
  source: text('source', { enum: ['ui', 'agent'] }).notNull(),
  createdAt: integer('created_at').notNull(),
});
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  graph: json('graph_json', WorkflowGraphSchema).notNull(),
  templateId: text('template_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey().notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  kind: text('kind', { enum: ['cron', 'interval'] }).notNull(),
  expr: text('expr').notNull(),
  prompt: text('prompt').notNull(),
  workflowId: text('workflow_id').references(() => workflows.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  lastRunAt: integer('last_run_at'),
  nextRunAt: integer('next_run_at'),
});
export const channelBindings = sqliteTable('channel_bindings', {
  id: text('id').primaryKey().notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  type: text('type', { enum: ['slack'] })
    .notNull()
    .unique(),
  config: json('config_json', ChannelBindingSchema.shape.config).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
});
export const runs = sqliteTable('runs', {
  graphSnapshot: json('graph_snapshot_json', WorkflowGraphSchema),
  id: text('id').primaryKey().notNull(),
  workflowId: text('workflow_id').references(() => workflows.id),
  trigger: text('trigger', { enum: ['ui', 'schedule', 'chat'] }).notNull(),
  input: text('input').notNull(),
  status: text('status', {
    enum: [
      'queued',
      'running',
      'waiting_approval',
      'completed',
      'failed',
      'cancelled',
    ],
  }).notNull(),
  result: text('result'),
  error: text('error'),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  totalCostUsd: real('total_cost_usd').notNull(),
  totalTokens: integer('total_tokens').notNull(),
});
export const runSteps = sqliteTable('run_steps', {
  id: text('id').primaryKey().notNull(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  nodeId: text('node_id').notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  iteration: integer('iteration').notNull(),
  status: text('status', {
    enum: ['running', 'completed', 'failed', 'blocked'],
  }).notNull(),
  prompt: text('prompt').notNull(),
  output: text('output'),
  verdict: text('verdict', { enum: ['approved', 'rejected'] }),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  error: text('error'),
});
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey().notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  channel: text('channel', { enum: ['slack', 'ui'] }).notNull(),
  externalRef: text('external_ref').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().notNull(),
  runId: text('run_id').references(() => runs.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  fromKind: text('from_kind', { enum: ['agent', 'human', 'system'] }).notNull(),
  fromId: text('from_id').notNull(),
  fromName: text('from_name'),
  toAgentId: text('to_agent_id')
    .notNull()
    .references(() => agents.id),
  channel: text('channel', {
    enum: ['internal', 'slack', 'ui', 'schedule'],
  }).notNull(),
  content: text('content').notNull(),
  verdict: text('verdict', { enum: ['approved', 'rejected'] }),
  status: text('status', {
    enum: ['pending', 'processing', 'acked', 'failed', 'dead'],
  }).notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey().notNull(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  stepId: text('step_id')
    .notNull()
    .references(() => runSteps.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  kind: text('kind', { enum: ['step_gate', 'tool_permission'] }).notNull(),
  detail: text('detail').notNull(),
  runtimeSessionId: text('runtime_session_id'),
  runtimePermissionId: text('runtime_permission_id'),
  status: text('status', {
    enum: ['pending', 'approved', 'rejected', 'expired'],
  }).notNull(),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
});
export const runtimeSessions = sqliteTable('runtime_sessions', {
  sessionKey: text('session_key').primaryKey().notNull(),
  runtimeSessionId: text('runtime_session_id').notNull(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  createdAt: integer('created_at').notNull(),
});
export const processedEvents = sqliteTable('processed_events', {
  externalEventId: text('external_event_id').primaryKey().notNull(),
  createdAt: integer('created_at').notNull(),
});
export const logs = sqliteTable('logs', {
  id: text('id').primaryKey().notNull(),
  ts: integer('ts').notNull(),
  level: text('level', { enum: ['info', 'warn', 'error'] }).notNull(),
  agentId: text('agent_id').references(() => agents.id),
  runId: text('run_id').references(() => runs.id),
  event: text('event').notNull(),
  data: json('data_json', LogSchema.shape.data).notNull(),
});
