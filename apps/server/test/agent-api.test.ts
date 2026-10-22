import { createMessagesRepository } from '../src/db/repos/messages.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentSchema,
  ALLOWED_MODELS,
  type Agent,
  type Memory,
  type Skill,
  type Schedule,
  type ChannelBinding,
  WorkflowSchema,
} from '@yuno/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createWorkflowsRepository } from '../src/db/repos/workflows.js';

const input = {
  name: 'Writer',
  role: 'Writer',
  systemPrompt: 'Write carefully 🌍',
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const database = openDatabase(':memory:');
  const app = buildApp({ db: database.db });
  cleanups.push(async () => {
    await app.close();
    database.close();
  });
  return { app, database };
}

describe('T4 agent configuration API (R-01, R-02, R-04, R-05, R-32)', () => {
  it('R-01 R-02 R-32 creates, reads, updates and deletes a persisted agent', async () => {
    const { app, database } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: input,
    });
    expect(created.statusCode).toBe(201);
    const agent = AgentSchema.parse(created.json<unknown>());
    expect(createAgentsRepository(database.db).get(agent.id)).toEqual(agent);
    expect((await app.inject('/api/agents')).json<Agent[]>()).toEqual([agent]);
    expect((await app.inject(`/api/agents/${agent.id}`)).json<Agent>()).toEqual(
      agent,
    );
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}`,
      payload: { ...input, name: 'Editor', model: ALLOWED_MODELS[1].id },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<Agent>()).toMatchObject({
      id: agent.id,
      name: 'Editor',
      model: ALLOWED_MODELS[1].id,
    });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` }))
        .statusCode,
    ).toBe(204);
    expect(createAgentsRepository(database.db).get(agent.id)).toBeUndefined();
    expect((await app.inject(`/api/agents/${agent.id}`)).statusCode).toBe(404);
  });

  it('R-02 rejects invalid fields and disallowed models with field messages without persisting them', async () => {
    const { app, database } = setup();
    for (const [field, payload] of [
      ['name', { ...input, name: '' }],
      ['model', { ...input, model: 'openai/not-allowed' }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(field);
      expect(response.body.length).toBeGreaterThan(field.length);
    }
    expect(createAgentsRepository(database.db).list()).toEqual([]);
    expect((await app.inject('/api/models')).json<unknown>()).toEqual(
      ALLOWED_MODELS,
    );
  });

  it('R-02 T22 accepts exactly the four approved models and rejects the removed model without persistence', async () => {
    const { app, database } = setup();
    const models = [
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-nano',
      'openai/gpt-5-mini',
      'openai/gpt-5.4',
    ];
    expect(ALLOWED_MODELS.map((model) => model.id)).toEqual(models);
    for (const [index, model] of models.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...input, name: `Model ${index}`, model },
      });
      expect(response.statusCode).toBe(201);
    }
    const removed = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...input, model: 'openai/gpt-5-2025-08-07' },
    });
    expect(removed.statusCode).toBe(400);
    expect(createAgentsRepository(database.db).list()).toHaveLength(4);
  });

  it('R-01 returns 409 with workflow names when deleting an agent in use and preserves it', async () => {
    const { app, database } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    createWorkflowsRepository(database.db).insert(
      WorkflowSchema.parse({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Publishing',
        description: '',
        graph: {
          nodes: [
            {
              id: 'writer',
              agentId: agent.id,
              label: 'Writer',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
          startNodeId: 'writer',
        },
        templateId: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ workflowNames: string[] }>().workflowNames).toEqual([
      'Publishing',
    ]);
    expect(createAgentsRepository(database.db).get(agent.id)).toBeDefined();
  });

  it('R-04 adds and removes memory facts and prevents deleting another agent memory', async () => {
    const { app } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...input, name: 'Other' },
      })
    ).json<Agent>();
    const base = `/api/agents/${agent.id}/memories`;
    const response = await app.inject({
      method: 'POST',
      url: base,
      payload: { fact: 'Likes long walks 🌍' },
    });
    expect(response.statusCode).toBe(201);
    const memory = response.json<Memory>();
    expect(memory).toMatchObject({
      agentId: agent.id,
      fact: 'Likes long walks 🌍',
      source: 'ui',
    });
    expect((await app.inject(base)).json<Memory[]>()).toEqual([memory]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/agents/${other.id}/memories/${memory.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject(base)).json<Memory[]>()).toEqual([memory]);
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/${memory.id}` }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject(base)).json<Memory[]>()).toEqual([]);
  });

  it('R-05 creates, edits, attaches and detaches skills; invalid attachment is atomic', async () => {
    const { app, database } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const created = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: {
        name: 'Review',
        description: 'Check work',
        stepsMd: '1. Read\n2. Check',
      },
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json<Skill>();
    expect((await app.inject(`/api/skills/${skill.id}`)).json<Skill>()).toEqual(
      skill,
    );
    expect((await app.inject('/api/skills')).json<Skill[]>()).toEqual([skill]);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/skills/${skill.id}`,
          payload: {
            name: 'Review',
            description: 'Updated',
            stepsMd: 'Check every claim',
          },
        })
      ).statusCode,
    ).toBe(200);
    const url = `/api/agents/${agent.id}/skills`;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: { skillIds: [skill.id] },
        })
      ).statusCode,
    ).toBe(200);
    const before = database.sqlite.prepare('SELECT * FROM agent_skills').all();
    expect(before).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: {
            skillIds: [skill.id, '00000000-0000-4000-8000-000000000099'],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(database.sqlite.prepare('SELECT * FROM agent_skills').all()).toEqual(
      before,
    );
    expect(
      (await app.inject({ method: 'PUT', url, payload: { skillIds: [] } }))
        .statusCode,
    ).toBe(200);
    expect(database.sqlite.prepare('SELECT * FROM agent_skills').all()).toEqual(
      [],
    );
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/skills/${skill.id}` }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject('/api/skills')).json<Skill[]>()).toEqual([]);
  });

  it('R-02 schedule CRUD persists edits and enforces agent ownership', async () => {
    const { app } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...input, name: 'Other' },
      })
    ).json<Agent>();
    const base = `/api/agents/${agent.id}/schedules`;
    const payload = {
      kind: 'interval',
      expr: '60',
      prompt: 'Check work',
      workflowId: null,
      enabled: true,
    };
    const response = await app.inject({ method: 'POST', url: base, payload });
    expect(response.statusCode).toBe(201);
    const schedule = response.json<Schedule>();
    expect((await app.inject(base)).json<Schedule[]>()).toEqual([schedule]);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/agents/${other.id}/schedules/${schedule.id}`,
          payload,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/${schedule.id}`,
          payload: { ...payload, expr: '120', enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(base)).json<Schedule[]>()).toEqual([
      expect.objectContaining({ id: schedule.id, expr: '120', enabled: false }),
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          payload: { ...payload, expr: '0' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/agents/${other.id}/schedules/${schedule.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/${schedule.id}` }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject(base)).json<Schedule[]>()).toEqual([]);
  });

  it('R-02 stores channel bindings, enforces one Slack binding and unique agent names', async () => {
    const { app } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...input, name: 'Other' },
      })
    ).json<Agent>();
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents', payload: input }))
        .statusCode,
    ).toBe(409);
    const base = `/api/agents/${agent.id}/channels`;
    expect((await app.inject(base)).json<unknown>()).toBeNull();
    const payload = {
      type: 'slack',
      config: { respondTo: 'dm_and_mentions' },
      enabled: true,
    };
    const response = await app.inject({ method: 'PUT', url: base, payload });
    expect(response.statusCode).toBe(200);
    const binding = response.json<ChannelBinding>();
    expect(binding).toMatchObject({ agentId: agent.id, ...payload });
    expect((await app.inject(base)).json<ChannelBinding>()).toEqual(binding);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/agents/${other.id}/channels`,
          payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: base,
          payload: { ...payload, enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/agents/${other.id}/channels`,
          payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: base,
          payload: 'null',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(base)).json<unknown>()).toBeNull();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/agents/${other.id}/channels`,
          payload,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('R-01 R-04 R-05 returns 404 for configuration on nonexistent agents and missing library records', async () => {
    const { app } = setup();
    const missing = '00000000-0000-4000-8000-000000000099';
    for (const suffix of ['', '/memories', '/schedules', '/channels']) {
      expect(
        (await app.inject(`/api/agents/${missing}${suffix}`)).statusCode,
      ).toBe(404);
    }
    expect((await app.inject(`/api/skills/${missing}`)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/agents/${missing}`,
          payload: input,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/${missing}` }))
        .statusCode,
    ).toBe(404);
  });

  it('R-01 deletes editable configurations together but preserves reusable skills', async () => {
    const { app, database } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const skill = (
      await app.inject({
        method: 'POST',
        url: '/api/skills',
        payload: { name: 'Reusable', description: '', stepsMd: 'Check work' },
      })
    ).json<Skill>();
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/memories`,
      payload: { fact: 'Remember me' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/schedules`,
      payload: {
        kind: 'interval',
        expr: '60',
        prompt: 'Check',
        workflowId: null,
        enabled: true,
      },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}/skills`,
      payload: { skillIds: [skill.id] },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}/channels`,
      payload: {
        type: 'slack',
        config: { respondTo: 'dm_and_mentions' },
        enabled: true,
      },
    });
    for (const table of [
      'memories',
      'schedules',
      'agent_skills',
      'channel_bindings',
    ])
      expect(
        database.sqlite.prepare(`SELECT * FROM ${table}`).all(),
      ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` }))
        .statusCode,
    ).toBe(204);
    for (const table of [
      'memories',
      'schedules',
      'agent_skills',
      'channel_bindings',
    ])
      expect(database.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(
        [],
      );
    expect((await app.inject('/api/skills')).json<Skill[]>()).toEqual([skill]);
  });

  it('R-01 historical message conflict rolls back configuration deletion', async () => {
    const { app, database } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const memory = (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${agent.id}/memories`,
        payload: { fact: 'Keep this' },
      })
    ).json<Memory>();
    const messages = createMessagesRepository(database.db);
    messages.insert({
      id: '00000000-0000-4000-8000-000000000088',
      runId: null,
      conversationId: null,
      fromKind: 'human',
      fromId: 'owner',
      fromName: null,
      toAgentId: agent.id,
      channel: 'ui',
      content: 'Historical',
      verdict: null,
      status: 'acked',
      attempts: 1,
      nextAttemptAt: 1,
      idempotencyKey: 'history',
      error: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` }))
        .statusCode,
    ).toBe(409);
    expect(createAgentsRepository(database.db).get(agent.id)).toBeDefined();
    expect(
      (await app.inject(`/api/agents/${agent.id}/memories`)).json<Memory[]>(),
    ).toEqual([memory]);
    expect(messages.list()).toHaveLength(1);
  });

  it('R-02 R-04 R-05 validates child inputs and missing-resource writes', async () => {
    const { app } = setup();
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', payload: input })
    ).json<Agent>();
    const missing = '00000000-0000-4000-8000-000000000099';
    const schedule = {
      kind: 'interval',
      expr: '60',
      prompt: 'Check',
      workflowId: null,
      enabled: true,
    };
    const channel = {
      type: 'slack',
      config: { respondTo: 'dm_and_mentions' },
      enabled: true,
    };
    for (const request of [
      {
        method: 'POST' as const,
        url: `/api/agents/${missing}/memories`,
        payload: { fact: 'Fact' },
      },
      {
        method: 'POST' as const,
        url: `/api/agents/${missing}/schedules`,
        payload: schedule,
      },
      {
        method: 'PUT' as const,
        url: `/api/agents/${missing}/skills`,
        payload: { skillIds: [] },
      },
      {
        method: 'PUT' as const,
        url: `/api/agents/${missing}/channels`,
        payload: channel,
      },
      {
        method: 'PUT' as const,
        url: `/api/agents/${agent.id}/schedules/${missing}`,
        payload: schedule,
      },
      {
        method: 'DELETE' as const,
        url: `/api/agents/${agent.id}/memories/${missing}`,
      },
      {
        method: 'DELETE' as const,
        url: `/api/agents/${agent.id}/schedules/${missing}`,
      },
      { method: 'DELETE' as const, url: `/api/skills/${missing}` },
      {
        method: 'PUT' as const,
        url: `/api/skills/${missing}`,
        payload: { name: 'Missing', description: '', stepsMd: 'Check' },
      },
    ])
      expect((await app.inject(request)).statusCode).toBe(404);
    for (const request of [
      {
        method: 'POST' as const,
        url: `/api/agents/${agent.id}/memories`,
        payload: { fact: '' },
      },
      {
        method: 'PUT' as const,
        url: `/api/agents/${agent.id}/skills`,
        payload: { skillIds: ['invalid'] },
      },
      {
        method: 'PUT' as const,
        url: `/api/agents/${agent.id}/channels`,
        payload: { ...channel, config: { respondTo: 'invalid' } },
      },
      {
        method: 'POST' as const,
        url: '/api/skills',
        payload: { name: 'Empty', description: '', stepsMd: '' },
      },
    ])
      expect((await app.inject(request)).statusCode).toBe(400);
  });
});
