import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
  ScheduleSchema,
  ScheduleInputSchema,
  WorkflowSchema,
  type SSEEvent,
} from '@yuno/shared';
import { z } from 'zod';
import { createEngine } from '../src/domain/engine.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createConfigurationRepository } from '../src/db/repos/configuration.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import { createEventHub } from '../src/events/hub.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';

const NOW = Date.UTC(2026, 0, 1);
const AGENT = '00000000-0000-4000-8000-000000000001';
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
const scheduleInput = (overrides = {}) => ({
  kind: 'interval',
  expr: '10',
  prompt: 'Check 🌍 使用',
  workflowId: null,
  enabled: true,
  ...overrides,
});
async function setup(
  options: Parameters<typeof createFakeRuntime>[0] = {},
  seed = false,
  cap = 0.5,
) {
  const connection = openDatabase(':memory:');
  cleanups.push(() => {
    connection.close();
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'yuno-scheduler-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  createAgentsRepository(connection.db).insert(
    AgentSchema.parse({
      id: AGENT,
      name: 'Scheduled agent',
      role: 'worker',
      status: 'idle',
      systemPrompt: 'Work.',
      createdAt: NOW,
      updatedAt: NOW,
      guardrails: { runCostCapUsd: cap },
    }),
  );
  const repo = createConfigurationRepository(connection.db);
  const seeded = seed
    ? repo.createSchedule(AGENT, ScheduleInputSchema.parse(scheduleInput()))
    : undefined;
  const hub = createEventHub(createLogsRepository(connection.db));
  const events: SSEEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const app = buildApp({
    db: connection.db,
    runtime: createFakeRuntime(options),
    hub,
    dataDir,
  });
  cleanups.push(() => app.close());
  await app.ready();
  async function create(overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${AGENT}/schedules`,
      payload: scheduleInput(overrides),
    });
    expect(response.statusCode).toBe(201);
    return ScheduleSchema.parse(response.json());
  }
  async function runs() {
    return z.array(RunSchema).parse((await app.inject('/api/runs')).json());
  }
  async function detail(id: string) {
    return z
      .object({
        ...RunSchema.shape,
        steps: z.array(RunStepSchema),
        messages: z.array(MessageSchema),
      })
      .parse((await app.inject(`/api/runs/${id}`)).json());
  }
  return {
    app,
    repo,
    create,
    runs,
    detail,
    events,
    seeded,
    db: connection.db,
    hub,
    dataDir,
  };
}

describe('T11 scheduler (R-03)', () => {
  it('R-03 loads enabled interval schedules on startup and persists execution timestamps and events', async () => {
    const s = await setup({}, true);
    const schedule = s.seeded;
    expect(schedule).toBeDefined();
    if (!schedule) throw new Error('Missing fixture');
    expect(s.repo.getSchedule(AGENT, schedule.id)?.nextRunAt).toBe(NOW + 10000);
    await vi.advanceTimersByTimeAsync(11000);
    const runs = await s.runs();
    expect(runs).toHaveLength(1);
    const result = await s.detail(runs[0]?.id ?? 'missing');
    expect(result).toMatchObject({
      trigger: 'schedule',
      workflowId: null,
      status: 'completed',
      input: 'Check 🌍 使用',
    });
    expect(result.steps).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      channel: 'schedule',
      status: 'acked',
      toAgentId: AGENT,
    });
    expect(s.repo.getSchedule(AGENT, schedule.id)).toMatchObject({
      lastRunAt: NOW + 10000,
      nextRunAt: NOW + 20000,
    });
    expect(s.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.updated',
        'step.updated',
        'message.created',
        'usage',
      ]),
    );
  });
  it('R-03 fires cron schedules added through the API at their next matching time', async () => {
    const s = await setup();
    const schedule = await s.create({ kind: 'cron', expr: '* * * * *' });
    await vi.advanceTimersByTimeAsync(59000);
    expect(await s.runs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await s.runs()).toEqual([
      expect.objectContaining({ trigger: 'schedule', status: 'completed' }),
    ]);
    expect(s.repo.getSchedule(AGENT, schedule.id)).toMatchObject({
      lastRunAt: NOW + 60000,
      nextRunAt: NOW + 120000,
    });
  });
  it('R-03 never fires disabled schedules', async () => {
    const s = await setup();
    const schedule = await s.create({ enabled: false });
    await vi.advanceTimersByTimeAsync(61000);
    expect(await s.runs()).toEqual([]);
    expect(s.repo.getSchedule(AGENT, schedule.id)).toMatchObject({
      lastRunAt: null,
      nextRunAt: null,
    });
  });
  it('R-03 editing reschedules and disabling or deleting cancels the old timer', async () => {
    const s = await setup();
    const schedule = await s.create();
    await vi.advanceTimersByTimeAsync(5000);
    const url = `/api/agents/${AGENT}/schedules/${schedule.id}`;
    expect(
      (
        await s.app.inject({
          method: 'PUT',
          url,
          payload: scheduleInput({ expr: '20', prompt: 'Edited' }),
        })
      ).statusCode,
    ).toBe(200);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await s.runs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await s.runs()).toEqual([
      expect.objectContaining({ input: 'Edited', status: 'completed' }),
    ]);
    expect(
      (
        await s.app.inject({
          method: 'PUT',
          url,
          payload: scheduleInput({ enabled: false }),
        })
      ).statusCode,
    ).toBe(200);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await s.runs()).toHaveLength(1);
    const deleted = await s.create();
    expect(
      (
        await s.app.inject({
          method: 'DELETE',
          url: `/api/agents/${AGENT}/schedules/${deleted.id}`,
        })
      ).statusCode,
    ).toBe(204);
    await vi.advanceTimersByTimeAsync(11000);
    expect(await s.runs()).toHaveLength(1);
  });
  it('R-03 changing another schedule preserves existing interval deadlines', async () => {
    const s = await setup();
    const first = await s.create();
    await vi.advanceTimersByTimeAsync(5000);
    await s.create({ enabled: false });
    expect(s.repo.getSchedule(AGENT, first.id)?.nextRunAt).toBe(NOW + 10000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await s.runs()).toHaveLength(1);
    expect(s.repo.getSchedule(AGENT, first.id)?.lastRunAt).toBe(NOW + 10000);
  });
  it('R-03 skips ticks while the agent is busy instead of queueing overlapping runs', async () => {
    const s = await setup({ delayMs: 25000 });
    await s.create();
    await vi.advanceTimersByTimeAsync(31000);
    expect(await s.runs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await s.runs()).toHaveLength(2);
  });
  it('R-03 starts the selected workflow with a schedule trigger', async () => {
    const s = await setup();
    const response = await s.app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Scheduled workflow',
        description: '',
        graph: {
          nodes: [
            {
              id: 'start',
              agentId: AGENT,
              label: 'Worker',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
          startNodeId: 'start',
          maxIterations: 6,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const workflow = WorkflowSchema.parse(response.json());
    await s.create({ workflowId: workflow.id });
    await vi.advanceTimersByTimeAsync(11000);
    expect(await s.runs()).toEqual([
      expect.objectContaining({
        workflowId: workflow.id,
        trigger: 'schedule',
        status: 'completed',
      }),
    ]);
  });
  it('R-03 applies guardrails to standalone scheduled turns with a persisted visible failure', async () => {
    const s = await setup({}, false, 0);
    await s.create();
    await vi.advanceTimersByTimeAsync(11000);
    const runs = await s.runs();
    expect(runs).toHaveLength(1);
    const result = await s.detail(runs[0]?.id ?? 'missing');
    expect(result).toMatchObject({
      status: 'failed',
      error: 'run_cost_cap',
      trigger: 'schedule',
    });
    expect(result.steps).toEqual([
      expect.objectContaining({ status: 'blocked', error: 'run_cost_cap' }),
    ]);
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          data: expect.objectContaining({ event: 'guardrail_blocked' }),
        }),
      ]),
    );
  });
  it.each(['this is not cron', '2027-01-01T00:00:00Z'])(
    'R-03 rejects invalid cron %s before persisting a row or arming a timer',
    async (expr) => {
      const s = await setup();
      const response = await s.app.inject({
        method: 'POST',
        url: `/api/agents/${AGENT}/schedules`,
        payload: scheduleInput({ kind: 'cron', expr }),
      });
      expect(response.statusCode).toBe(400);
      expect(s.repo.listSchedules(AGENT)).toEqual([]);
      await vi.advanceTimersByTimeAsync(61000);
      expect(await s.runs()).toEqual([]);
    },
  );
  it('R-03 simultaneous schedules skip an already pending same-agent turn', async () => {
    const s = await setup();
    await s.create();
    await s.create();
    await vi.advanceTimersByTimeAsync(11000);
    expect(await s.runs()).toHaveLength(1);
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          data: expect.objectContaining({
            event: 'schedule_skipped',
            data: expect.objectContaining({ reason: 'agent_busy' }),
          }),
        }),
      ]),
    );
  });
  it('R-03 a queued standalone run recovers after its schedule is deleted', async () => {
    const s = await setup();
    const schedule = await s.create();
    await s.app.close();
    const engine = createEngine({
      db: s.db,
      hub: s.hub,
      runtime: createFakeRuntime(),
      dataDir: s.dataDir,
    });
    const run = engine.startScheduled(schedule);
    s.repo.deleteSchedule(AGENT, schedule.id);
    const app = buildApp({
      db: s.db,
      hub: s.hub,
      runtime: createFakeRuntime(),
      dataDir: s.dataDir,
    });
    cleanups.push(() => app.close());
    await app.ready();
    await vi.advanceTimersByTimeAsync(1000);
    const result = z
      .object({
        ...RunSchema.shape,
        steps: z.array(RunStepSchema),
        messages: z.array(MessageSchema),
      })
      .parse((await app.inject(`/api/runs/${run.id}`)).json());
    expect(result).toMatchObject({
      status: 'completed',
      trigger: 'schedule',
      workflowId: null,
    });
    expect(result.steps).toHaveLength(1);
    expect(result.messages).toEqual([
      expect.objectContaining({ status: 'acked' }),
    ]);
  });
  it('R-03 stopping the application prevents further scheduler ticks', async () => {
    const s = await setup();
    const schedule = await s.create();
    await s.app.close();
    const engine = createEngine({
      db: s.db,
      hub: s.hub,
      runtime: createFakeRuntime(),
      dataDir: s.dataDir,
    });
    await vi.advanceTimersByTimeAsync(31000);
    expect(engine.listRuns()).toEqual([]);
    expect(s.repo.getSchedule(AGENT, schedule.id)?.lastRunAt).toBeNull();
  });
  it('R-03 skips a disabled agent with a visible reason', async () => {
    const s = await setup();
    const agents = createAgentsRepository(s.db);
    const agent = agents.get(AGENT);
    if (!agent) throw new Error('Missing fixture');
    agents.update({ ...agent, status: 'disabled' });
    await s.create();
    await vi.advanceTimersByTimeAsync(11000);
    expect(await s.runs()).toEqual([]);
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          data: expect.objectContaining({ event: 'schedule_skipped' }),
        }),
      ]),
    );
  });
  it('R-03 skips a workflow whose start agent is busy even when the schedule owner is idle', async () => {
    const s = await setup({ delayMs: 25000 });
    const owner = '00000000-0000-4000-8000-000000000002';
    createAgentsRepository(s.db).insert(
      AgentSchema.parse({
        id: owner,
        name: 'Owner',
        role: 'worker',
        systemPrompt: 'Work.',
        status: 'idle',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await s.create();
    await vi.advanceTimersByTimeAsync(11000);
    const response = await s.app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Busy start',
        description: '',
        graph: {
          nodes: [
            {
              id: 'start',
              agentId: AGENT,
              label: 'Busy',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
          startNodeId: 'start',
          maxIterations: 6,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const workflow = WorkflowSchema.parse(response.json());
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: `/api/agents/${owner}/schedules`,
          payload: scheduleInput({ workflowId: workflow.id }),
        })
      ).statusCode,
    ).toBe(201);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await s.runs()).toHaveLength(1);
    expect(createAgentsRepository(s.db).get(owner)?.status).toBe('idle');
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          data: expect.objectContaining({
            agentId: owner,
            event: 'schedule_skipped',
          }),
        }),
      ]),
    );
  });
  it('R-03 an identical PUT preserves nextRunAt and its original deadline', async () => {
    const s = await setup();
    const schedule = await s.create();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      (
        await s.app.inject({
          method: 'PUT',
          url: `/api/agents/${AGENT}/schedules/${schedule.id}`,
          payload: scheduleInput(),
        })
      ).statusCode,
    ).toBe(200);
    expect(s.repo.getSchedule(AGENT, schedule.id)?.nextRunAt).toBe(NOW + 10000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await s.runs()).toHaveLength(1);
    expect(s.repo.getSchedule(AGENT, schedule.id)?.lastRunAt).toBe(NOW + 10000);
  });
});
