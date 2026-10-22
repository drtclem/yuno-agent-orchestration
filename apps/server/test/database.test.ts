import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSchema, MessageSchema, WorkflowSchema } from '@yuno/shared';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createWorkflowsRepository } from '../src/db/repos/workflows.js';
import { createMessagesRepository } from '../src/db/repos/messages.js';

const agent = AgentSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Writer',
  role: 'Writer',
  systemPrompt: 'Write carefully.',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
});
const workflow = WorkflowSchema.parse({
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Draft',
  description: '',
  graph: {
    nodes: [
      {
        id: 'write',
        agentId: agent.id,
        label: 'Write',
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    startNodeId: 'write',
  },
  templateId: null,
  createdAt: 1,
  updatedAt: 1,
});
const message = MessageSchema.parse({
  id: '00000000-0000-4000-8000-000000000003',
  runId: null,
  conversationId: null,
  fromKind: 'human',
  fromId: 'owner',
  toAgentId: agent.id,
  channel: 'ui',
  content: 'Hello 🌍',
  verdict: null,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 1,
  idempotencyKey: 'ui:one',
  error: null,
  createdAt: 1,
  updatedAt: 1,
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function freshDatabase() {
  const connection = openDatabase(':memory:');
  cleanups.push(() => connection.close());
  return connection;
}

describe('T3 database persistence (R-28)', () => {
  it('R-28 migrations create every architecture §5 table and enable foreign keys', () => {
    const { sqlite } = freshDatabase();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables).toEqual(
      expect.arrayContaining(
        [
          'agents',
          'skills',
          'agent_skills',
          'memories',
          'schedules',
          'channel_bindings',
          'workflows',
          'runs',
          'run_steps',
          'messages',
          'approvals',
          'runtime_sessions',
          'conversations',
          'processed_events',
          'logs',
        ].map((name) => ({ name })),
      ),
    );
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('R-28 enables WAL on disk and reruns migrations without losing persisted records', () => {
    // SQLite in-memory databases use memory journaling; WAL requires a real file.
    const directory = mkdtempSync(join(tmpdir(), 'yuno-t3-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'test.db');
    const first = openDatabase(filename);
    try {
      expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      createAgentsRepository(first.db).insert(agent);
    } finally {
      first.close();
    }
    const second = openDatabase(filename);
    cleanups.push(() => second.close());
    expect(createAgentsRepository(second.db).get(agent.id)).toEqual(agent);
    expect(second.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('R-28 agents round trip JSON fields, update, list, delete, and enforce unique names', () => {
    const { db } = freshDatabase();
    const repo = createAgentsRepository(db);
    repo.insert(agent);
    expect(repo.get(agent.id)).toEqual(agent);
    expect(repo.list()).toEqual([agent]);
    expect(() =>
      repo.insert({ ...agent, id: '00000000-0000-4000-8000-000000000004' }),
    ).toThrow();
    const updated = {
      ...agent,
      name: 'Editor',
      tools: { ...agent.tools, edit: true },
      updatedAt: 2,
    };
    repo.update(updated);
    expect(repo.get(agent.id)).toEqual(updated);
    repo.delete(agent.id);
    expect(repo.get(agent.id)).toBeUndefined();
    expect(repo.list()).toEqual([]);
  });

  it('R-28 workflows round trip their graph, update, list, and delete', () => {
    const { db } = freshDatabase();
    createAgentsRepository(db).insert(agent);
    const repo = createWorkflowsRepository(db);
    repo.insert(workflow);
    expect(repo.get(workflow.id)).toEqual(workflow);
    expect(repo.list()).toEqual([workflow]);
    const updated = {
      ...workflow,
      graph: { ...workflow.graph, maxIterations: 2 },
      updatedAt: 2,
    };
    repo.update(updated);
    expect(repo.get(workflow.id)).toEqual(updated);
    repo.delete(workflow.id);
    expect(repo.get(workflow.id)).toBeUndefined();
  });

  it('R-28 messages round trip Unicode content, update, list, delete, and reject duplicate idempotency keys', () => {
    const { db } = freshDatabase();
    createAgentsRepository(db).insert(agent);
    const repo = createMessagesRepository(db);
    repo.insert(message);
    expect(repo.get(message.id)).toEqual(message);
    expect(repo.list()).toEqual([message]);
    expect(() =>
      repo.insert({ ...message, id: '00000000-0000-4000-8000-000000000004' }),
    ).toThrow();
    expect(repo.list()).toEqual([message]);
    const updated = {
      ...message,
      status: 'acked' as const,
      attempts: 1,
      updatedAt: 2,
    };
    repo.update(updated);
    expect(repo.get(message.id)).toEqual(updated);
    repo.delete(message.id);
    expect(repo.get(message.id)).toBeUndefined();
  });

  it('R-28 rejects messages with nonexistent target agents at the persistence boundary', () => {
    const { db } = freshDatabase();
    const repo = createMessagesRepository(db);
    expect(() => repo.insert(message)).toThrow();
    expect(repo.list()).toEqual([]);
  });

  it('R-28 validates JSON records before writes and rejects corrupted stored JSON on reads', () => {
    const { db, sqlite } = freshDatabase();
    const agents = createAgentsRepository(db);
    expect(() =>
      agents.insert({
        ...agent,
        tools: { ...agent.tools, bash: 'yes' },
      } as unknown as typeof agent),
    ).toThrow();
    expect(agents.list()).toEqual([]);
    agents.insert(agent);
    sqlite
      .prepare('UPDATE agents SET tools_json = ? WHERE id = ?')
      .run('{"bash":"yes"}', agent.id);
    expect(() => agents.get(agent.id)).toThrow();
    const workflows = createWorkflowsRepository(db);
    expect(() =>
      workflows.insert({
        ...workflow,
        graph: { ...workflow.graph, maxIterations: 0 },
      }),
    ).toThrow();
    expect(workflows.list()).toEqual([]);
    workflows.insert(workflow);
    sqlite
      .prepare('UPDATE workflows SET graph_json = ? WHERE id = ?')
      .run('{invalid', workflow.id);
    expect(() => workflows.get(workflow.id)).toThrow();
  });
  it('R-28 migrations preserve all architecture §5 columns and primary keys', () => {
    const { sqlite } = freshDatabase();
    const columns: Record<string, string> = {
      agents:
        'id name role system_prompt model tools_json permissions_json guardrails_json status created_at updated_at',
      skills: 'id name description steps_md created_at',
      agent_skills: 'agent_id skill_id',
      memories: 'id agent_id fact source created_at',
      schedules:
        'id agent_id kind expr prompt workflow_id enabled last_run_at next_run_at',
      channel_bindings: 'id agent_id type config_json enabled',
      workflows:
        'id name description graph_json template_id created_at updated_at',
      runs: 'id workflow_id trigger input status result error started_at finished_at total_cost_usd total_tokens',
      run_steps:
        'id run_id node_id agent_id iteration status prompt output verdict input_tokens output_tokens cost_usd started_at finished_at error',
      messages:
        'id run_id conversation_id from_kind from_id to_agent_id channel content verdict status attempts next_attempt_at idempotency_key error created_at updated_at',
      approvals:
        'id run_id step_id agent_id kind detail runtime_session_id runtime_permission_id status created_at resolved_at',
      runtime_sessions: 'session_key runtime_session_id agent_id created_at',
      conversations: 'id agent_id channel external_ref created_at',
      processed_events: 'external_event_id created_at',
      logs: 'id ts level agent_id run_id event data_json',
    };
    for (const [table, names] of Object.entries(columns)) {
      const info = sqlite.pragma(`table_info(${table})`);
      expect(info).toEqual(
        expect.arrayContaining(
          names.split(' ').map((name) => expect.objectContaining({ name })),
        ),
      );
      const keys =
        table === 'agent_skills'
          ? ['agent_id', 'skill_id']
          : [
              table === 'runtime_sessions'
                ? 'session_key'
                : table === 'processed_events'
                  ? 'external_event_id'
                  : 'id',
            ];
      for (const [index, name] of keys.entries()) {
        expect(info).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name, pk: index + 1, notnull: 1 }),
          ]),
        );
      }
    }
  });

  it('R-28 migrations preserve foreign key relationships for execution history and configuration', () => {
    const { sqlite } = freshDatabase();
    const relationships: Record<string, string[]> = {
      agent_skills: ['agent_id:agents:id', 'skill_id:skills:id'],
      memories: ['agent_id:agents:id'],
      schedules: ['agent_id:agents:id', 'workflow_id:workflows:id'],
      channel_bindings: ['agent_id:agents:id'],
      runs: ['workflow_id:workflows:id'],
      run_steps: ['run_id:runs:id', 'agent_id:agents:id'],
      messages: [
        'run_id:runs:id',
        'conversation_id:conversations:id',
        'to_agent_id:agents:id',
      ],
      approvals: [
        'run_id:runs:id',
        'step_id:run_steps:id',
        'agent_id:agents:id',
      ],
      runtime_sessions: ['agent_id:agents:id'],
      conversations: ['agent_id:agents:id'],
      logs: ['agent_id:agents:id', 'run_id:runs:id'],
    };
    for (const [table, references] of Object.entries(relationships)) {
      expect(sqlite.pragma(`foreign_key_list(${table})`)).toEqual(
        expect.arrayContaining(
          references.map((reference) => {
            const [from, target, to] = reference.split(':');
            return expect.objectContaining({ from, table: target, to });
          }),
        ),
      );
    }
  });

  it('R-28 enforces composite skill assignments, unique skills, and one Slack binding globally', () => {
    const { db, sqlite } = freshDatabase();
    const agents = createAgentsRepository(db);
    agents.insert(agent);
    const secondAgent = {
      ...agent,
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Reviewer',
    };
    agents.insert(secondAgent);
    const insertSkill = sqlite.prepare(
      'INSERT INTO skills (id, name, description, steps_md, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertSkill.run('skill-one', 'Review', '', 'Read carefully', 1);
    expect(() =>
      insertSkill.run('skill-two', 'Review', '', 'Other instructions', 1),
    ).toThrow();
    const attach = sqlite.prepare(
      'INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)',
    );
    attach.run(agent.id, 'skill-one');
    expect(() => attach.run(agent.id, 'skill-one')).toThrow();
    attach.run(secondAgent.id, 'skill-one');
    expect(sqlite.prepare('SELECT * FROM agent_skills').all()).toHaveLength(2);
    const bind = sqlite.prepare(
      'INSERT INTO channel_bindings (id, agent_id, type, config_json, enabled) VALUES (?, ?, ?, ?, ?)',
    );
    bind.run(
      'binding-one',
      agent.id,
      'slack',
      '{"respondTo":"dm_and_mentions"}',
      1,
    );
    expect(() =>
      bind.run(
        'binding-two',
        secondAgent.id,
        'slack',
        '{"respondTo":"dm_and_mentions"}',
        1,
      ),
    ).toThrow();
    expect(sqlite.prepare('SELECT * FROM channel_bindings').all()).toHaveLength(
      1,
    );
  });

  it('R-28 repository writes roll back together when a transaction fails', () => {
    const { db } = freshDatabase();
    const agents = createAgentsRepository(db);
    const messages = createMessagesRepository(db);
    expect(() =>
      db.transaction((transaction) => {
        createAgentsRepository(transaction).insert(agent);
        const transactionalMessages = createMessagesRepository(transaction);
        transactionalMessages.insert(message);
        transactionalMessages.insert({
          ...message,
          id: '00000000-0000-4000-8000-000000000004',
        });
      }),
    ).toThrow();
    expect(agents.list()).toEqual([]);
    expect(messages.list()).toEqual([]);
  });
});

describe('T24 sender name migration (R-16/R-23)', () => {
  it('R-16/R-23 existing messages retain null from_name and their old sender ID after upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yuno-t24-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    for (const migration of ['0000_foundation', '0001_empty_warstar']) {
      legacy.exec(
        readFileSync(
          new URL(
            `../src/db/repos/migrations/${migration}.sql`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
    }
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(
      'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    legacy
      .prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      )
      .run('legacy', 1792502038970);
    legacy
      .prepare(
        `INSERT INTO messages (id, run_id, conversation_id, from_kind, from_id, to_agent_id, channel, content, verdict, status, attempts, next_attempt_at, idempotency_key, error, created_at, updated_at) VALUES (?, NULL, NULL, 'human', 'U123', ?, 'slack', 'Old text', NULL, 'acked', 0, 0, 'legacy', NULL, 0, 0)`,
      )
      .run(message.id, agent.id);
    legacy.close();
    const upgraded = openDatabase(filename);
    cleanups.push(() => upgraded.close());
    expect(
      upgraded.sqlite.prepare('SELECT from_name FROM messages').get(),
    ).toEqual({ from_name: null });
    expect(createMessagesRepository(upgraded.db).get(message.id)).toEqual(
      expect.objectContaining({
        fromName: null,
        fromId: 'U123',
        content: 'Old text',
      }),
    );
  });
});
