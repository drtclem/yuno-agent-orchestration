import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentSchema,
  ApprovalSchema,
  RunSchema,
  RunStepSchema,
  WorkflowSchema,
  type Guardrails,
} from '@yuno/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createExecutionRepository } from '../src/db/repos/execution.js';
import { createApprovalsRepository } from '../src/db/repos/approvals.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import { createEventHub } from '../src/events/hub.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import type { AgentRuntime } from '../src/runtime/types.js';

const AGENT = '00000000-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 9, 19, 12);
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
async function setup(
  guardrails: Partial<Guardrails> = {},
  runtime = createFakeRuntime(),
  gate = false,
) {
  const connection = openDatabase(':memory:');
  cleanups.push(() => {
    connection.close();
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'yuno-guardrails-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  createAgentsRepository(connection.db).insert(
    AgentSchema.parse({
      id: AGENT,
      name: 'Worker',
      role: 'coder',
      systemPrompt: 'Work.',
      guardrails,
      status: 'idle',
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const hub = createEventHub(createLogsRepository(connection.db));
  const events: string[] = [];
  hub.subscribe((event) => events.push(event.type));
  let app = buildApp({
    db: connection.db,
    runtime,
    dataDir,
    hub,
  });
  cleanups.push(() => app.close());
  await app.ready();
  const saved = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: {
      name: 'Guarded',
      description: '',
      graph: {
        nodes: [
          {
            id: 'work',
            agentId: AGENT,
            label: 'Work',
            position: { x: 0, y: 0 },
            requiresApproval: gate,
          },
        ],
        edges: [],
        startNodeId: 'work',
        maxIterations: 5,
      },
    },
  });
  expect(saved.statusCode).toBe(201);
  const workflow = WorkflowSchema.parse(saved.json());
  async function start() {
    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflow.id}/runs`,
      payload: { input: 'Work 🌍' },
    });
    expect(response.statusCode).toBe(201);
    const run = RunSchema.parse(response.json());
    await vi.advanceTimersByTimeAsync(1000);
    return run.id;
  }
  async function state(id: string) {
    const response = await app.inject(`/api/runs/${id}`);
    expect(response.statusCode).toBe(200);
    return z
      .object({
        ...RunSchema.shape,
        steps: z.array(RunStepSchema),
        approvals: z.array(ApprovalSchema),
      })
      .parse(response.json());
  }
  async function pending() {
    const response = await app.inject('/api/approvals?status=pending');
    expect(response.statusCode).toBe(200);
    return z.array(ApprovalSchema).parse(response.json());
  }
  async function decide(id: string, decision: 'approve' | 'reject') {
    const response = await app.inject({
      method: 'POST',
      url: `/api/approvals/${id}`,
      payload: { decision, note: 'Reviewed' },
    });
    expect(response.statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
  }
  async function restart(
    nextRuntime = runtime,
    prepare?: () => void,
    pump = true,
  ) {
    await app.close();
    prepare?.();
    app = buildApp({ db: connection.db, runtime: nextRuntime, dataDir, hub });
    await app.ready();
    if (pump) await vi.advanceTimersByTimeAsync(1000);
  }
  return {
    app,
    start,
    state,
    pending,
    decide,
    events,
    workflow,
    restart,
    db: connection.db,
  };
}

describe('T10 guardrails and approvals (R-06/R-07/R-08/R-09)', () => {
  it.each(['runCostCapUsd', 'dailyCostCapUsd'] as const)(
    'R-07 blocks a turn at the %s cap with a visible reason',
    async (cap) => {
      const runtime = createFakeRuntime();
      const runTurn = vi.spyOn(runtime, 'runTurn');
      const s = await setup({ [cap]: 0 }, runtime);
      const result = await s.state(await s.start());
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/cost|budget|cap/i);
      expect(runTurn).not.toHaveBeenCalled();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        status: 'blocked',
        error: cap === 'runCostCapUsd' ? 'run_cost_cap' : 'daily_cost_cap',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(result.steps.some((step) => step.status === 'completed')).toBe(
        false,
      );
      expect(s.events).toContain('run.updated');
    },
  );
  it('R-07 counts earlier steps against the per-agent run budget', async () => {
    const s = await setup({ runCostCapUsd: 0.001 });
    const changed = await s.app.inject({
      method: 'PUT',
      url: `/api/workflows/${s.workflow.id}`,
      payload: {
        name: s.workflow.name,
        description: s.workflow.description,
        graph: {
          ...s.workflow.graph,
          nodes: [
            ...s.workflow.graph.nodes,
            {
              id: 'next',
              agentId: AGENT,
              label: 'Next',
              position: { x: 1, y: 0 },
            },
          ],
          edges: [
            {
              id: 'repeat',
              source: 'work',
              target: 'next',
              condition: 'always',
            },
          ],
        },
      },
    });
    expect(changed.statusCode).toBe(200);
    const result = await s.state(await s.start());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/cost|budget|cap/i);
    expect(
      result.steps.filter((step) => step.status === 'completed'),
    ).toHaveLength(1);
    expect(result.totalCostUsd).toBeCloseTo(0.001);
  });
  it('R-06 cancellation of a waiting gate clears the inbox and cannot resume work', async () => {
    const runtime = createFakeRuntime();
    const runTurn = vi.spyOn(runtime, 'runTurn');
    const s = await setup({}, runtime, true);
    const id = await s.start();
    const pending = await s.pending();
    expect(pending).toHaveLength(1);
    const approval = pending[0];
    if (!approval) throw new Error('Missing waiting gate');
    const response = await s.app.inject({
      method: 'POST',
      url: `/api/runs/${id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await s.pending()).toEqual([]);
    expect(runTurn).not.toHaveBeenCalled();
    // Jump past expiry, then exercise both pollers without replaying 20,460 idle callbacks.
    vi.setSystemTime(Date.now() + 31 * 60000);
    await vi.advanceTimersByTimeAsync(1000);
    const staleApproval = await s.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'approve' },
    });
    expect(staleApproval.statusCode).toBe(409);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTurn).not.toHaveBeenCalled();
    expect((await s.state(id)).status).toBe('cancelled');
    expect(await s.pending()).toEqual([]);
    expect(
      (await s.state(id)).steps.some((step) => step.status === 'completed'),
    ).toBe(false);
  });
  it('R-07 resets daily spending at UTC midnight', async () => {
    const s = await setup({ dailyCostCapUsd: 0.001 });
    expect((await s.state(await s.start())).status).toBe('completed');
    expect((await s.state(await s.start())).status).toBe('failed');
    vi.setSystemTime(Date.UTC(2026, 9, 20));
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(await s.start())).status).toBe('completed');
  });
  it('R-07 checks final result usage even when no usage event was emitted', async () => {
    const fake = createFakeRuntime();
    const runtime: AgentRuntime = {
      health: () => fake.health(),
      respondPermission: (...args) => fake.respondPermission(...args),
      async runTurn(input, onEvent, signal) {
        const result = await fake.runTurn(
          input,
          (event) => {
            if (event.type !== 'usage') onEvent(event);
          },
          signal,
        );
        return { ...result, costUsd: 0.6, inputTokens: 80, outputTokens: 20 };
      },
    };
    const s = await setup({}, runtime);
    const result = await s.state(await s.start());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/cost|budget|cap/i);
    expect(result.totalCostUsd).toBeCloseTo(0.6);
    expect(result.totalTokens).toBe(100);
  });
  it('R-06 waiting gates release dispatcher slots so five runs reach the inbox', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await s.start());
    expect(await s.pending()).toHaveLength(5);
    for (const id of ids)
      expect((await s.state(id)).status).toBe('waiting_approval');
    const pending = await s.pending();
    for (const approval of pending) await s.decide(approval.id, 'approve');
    for (const id of ids) expect((await s.state(id)).status).toBe('completed');
  });
  it('R-06 validates approval input and rejects repeated decisions without rerunning a step', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const id = await s.start();
    const approval = (await s.pending())[0];
    if (!approval) throw new Error('Missing approval');
    const invalid = await s.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'maybe' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(await s.pending()).toHaveLength(1);
    await s.decide(approval.id, 'approve');
    const repeated = await s.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'reject' },
    });
    expect(repeated.statusCode).toBe(409);
    const result = await s.state(id);
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    expect(result.approvals[0]?.status).toBe('approved');
    const malformed = await s.app.inject('/api/approvals?status=unknown');
    expect(malformed.statusCode).toBe(400);
  });
  it('R-06 restart preserves a pending gate and resumes the same step and iteration once', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const id = await s.start();
    const before = await s.state(id);
    const approval = (await s.pending())[0];
    if (!approval) throw new Error('Missing gate');
    await s.restart();
    expect((await s.pending()).map((a) => a.id)).toEqual([approval.id]);
    expect((await s.state(id)).status).toBe('waiting_approval');
    await s.decide(approval.id, 'approve');
    const result = await s.state(id);
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      id: before.steps[0]?.id,
      iteration: 1,
      status: 'completed',
    });
  });
  it('R-09 restart fails closed on a persisted interrupted tool permission without replaying it', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const id = await s.start();
    const gate = (await s.pending())[0];
    if (!gate) throw new Error('Missing persisted gate fixture');
    const fake = createFakeRuntime();
    let turns = 0;
    const runtime: AgentRuntime = {
      health: () => fake.health(),
      async runTurn(...args) {
        turns++;
        return fake.runTurn(...args);
      },
      respondPermission: (...args) => fake.respondPermission(...args),
    };
    await s.restart(runtime, () => {
      const repo = createApprovalsRepository(s.db);
      repo.resolve(gate.id, 'rejected', Date.now());
      repo.insert({
        ...gate,
        id: crypto.randomUUID(),
        kind: 'tool_permission',
        runtimeSessionId: 'interrupted',
        runtimePermissionId: 'pending-tool',
      });
    });
    const result = await s.state(id);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/interrupt/i);
    expect(await s.pending()).toEqual([]);
    expect(turns).toBe(0);
  });
  it.each(['throws', 'hangs', 'cancel'] as const)(
    'R-09 tool permission delivery %s terminates visibly and clears the inbox',
    async (mode) => {
      const fake = createFakeRuntime();
      const runtime: AgentRuntime = {
        health: () => fake.health(),
        async runTurn(_input, onEvent, signal) {
          onEvent({
            type: 'permission_request',
            sessionId: 'session',
            permissionId: 'permission',
            tool: 'bash',
            detail: 'Run tool',
          });
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          );
        },
        async respondPermission() {
          if (mode === 'throws') throw new Error('Network unavailable');
          return new Promise<void>(() => {});
        },
      };
      const s = await setup({}, runtime);
      const id = await s.start();
      const approval = (await s.pending())[0];
      if (!approval) throw new Error('Missing tool approval');
      if (mode === 'cancel') {
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: `/api/runs/${id}/cancel`,
            })
          ).statusCode,
        ).toBe(200);
      } else {
        const response = s.app.inject({
          method: 'POST',
          url: `/api/approvals/${approval.id}`,
          payload: { decision: 'approve' },
        });
        const request = response.then((value) => value);
        await vi.advanceTimersByTimeAsync(6000);
        expect((await request).statusCode).toBe(200);
      }
      await vi.advanceTimersByTimeAsync(1000);
      const result = await s.state(id);
      expect(result.status).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
      if (mode !== 'cancel') expect(result.error).toMatch(/permission.*fail/i);
      expect(await s.pending()).toEqual([]);
      expect(s.events).toContain('approval.resolved');
    },
  );
  it.each(['reject', 'expire'] as const)(
    'R-08 %s gate placeholders do not consume hourly invocation allowance',
    async (decision) => {
      const s = await setup({ maxTurnsPerHour: 1 }, createFakeRuntime(), true);
      const first = await s.start();
      const gate = (await s.pending())[0];
      if (!gate) throw new Error('Missing first gate');
      if (decision === 'reject') await s.decide(gate.id, 'reject');
      else {
        vi.setSystemTime(Date.now() + 30 * 60000);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect((await s.state(first)).status).toBe('failed');
      const next = await s.start();
      const second = (await s.pending())[0];
      if (!second) throw new Error('Missing second gate');
      await s.decide(second.id, 'approve');
      expect((await s.state(next)).status).toBe('completed');
    },
  );
  it('R-07 a turn crossing UTC midnight contributes usage to the new day budget', async () => {
    const s = await setup(
      { dailyCostCapUsd: 0.001 },
      createFakeRuntime({ delayMs: 2000 }),
    );
    vi.setSystemTime(Date.UTC(2026, 9, 20) - 500);
    const first = await s.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await s.state(first)).status).toBe('completed');
    const next = await s.state(await s.start());
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/daily.*cap/i);
  });
  it('R-09 waits for an in-progress permission delivery when the turn returns first', async () => {
    const fake = createFakeRuntime();
    let releaseTurn: (() => void) | undefined;
    const runtime: AgentRuntime = {
      health: () => fake.health(),
      async runTurn(input, onEvent, signal) {
        onEvent({
          type: 'permission_request',
          sessionId: 'session',
          permissionId: 'permission',
          tool: 'bash',
          detail: 'Run tool',
        });
        await new Promise<void>((resolve, reject) => {
          releaseTurn = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
        return fake.runTurn(input, onEvent, signal);
      },
      async respondPermission() {
        releaseTurn?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      },
    };
    const s = await setup({}, runtime);
    const id = await s.start();
    const approval = (await s.pending())[0];
    if (!approval) throw new Error('Missing permission');
    const request = s.app
      .inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}`,
        payload: { decision: 'approve' },
      })
      .then((response) => response);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await request).statusCode).toBe(200);
    const result = await s.state(id);
    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.approvals[0]?.status).toBe('approved');
  });
  it('R-09 logs a blocked bash pattern violation without the command text', async () => {
    const command = 'rm -rf /private-sensitive-workspace';
    const s = await setup(
      {},
      createFakeRuntime({
        scripts: {
          [AGENT]: [
            {
              events: [
                {
                  type: 'tool',
                  tool: 'bash',
                  status: 'started',
                  title: command,
                },
              ],
            },
          ],
        },
      }),
    );
    const repo = createAgentsRepository(s.db);
    const agent = repo.get(AGENT);
    if (!agent) throw new Error('Missing agent');
    repo.update({
      ...agent,
      permissions: { ...agent.permissions, denyBash: ['rm -rf *'] },
    });
    const id = await s.start();
    const logs = createLogsRepository(s.db)
      .list()
      .filter((log) => log.runId === id);
    const violation = logs.find(
      (log) => log.event === 'blocked_action_violation',
    );
    expect(violation).toMatchObject({
      agentId: AGENT,
      runId: id,
      data: { tool: 'bash', status: 'started' },
    });
    expect(JSON.stringify(logs)).not.toContain(command);
    expect(JSON.stringify(logs)).not.toContain('private-sensitive-workspace');
  });
  it('R-06 startup clears an orphan pending gate whose run is already cancelled', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const id = await s.start();
    expect(await s.pending()).toHaveLength(1);
    await s.restart(undefined, () => {
      const repo = createExecutionRepository(s.db);
      const run = repo.getRun(id);
      if (!run) throw new Error('Missing persisted run');
      repo.updateRun({ ...run, status: 'cancelled', finishedAt: Date.now() });
    });
    expect(await s.pending()).toEqual([]);
    const result = await s.state(id);
    expect(result.status).toBe('cancelled');
    expect(result.approvals[0]?.status).toBe('rejected');
    expect(result.steps.some((step) => step.status === 'completed')).toBe(
      false,
    );
  });
  it('R-06 app.ready waits until all already-expired startup gates have resolved', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) ids.push(await s.start());
    expect(await s.pending()).toHaveLength(12);
    await s.restart(
      undefined,
      () => {
        vi.setSystemTime(Date.now() + 31 * 60000);
      },
      false,
    );
    // Read synchronously after ready: injecting an HTTP request would let unfinished recovery advance.
    expect(createApprovalsRepository(s.db).list('pending')).toEqual([]);
    const repo = createExecutionRepository(s.db);
    for (const id of ids) expect(repo.getRun(id)?.status).toBe('failed');
  });
  it.each(['approve', 'reject'] as const)(
    'R-06 resolving parked gate A with %s preserves working status while run B uses the same agent',
    async (decision) => {
      const s = await setup({}, createFakeRuntime({ delayMs: 60000 }), true);
      const a = await s.start();
      const b = await s.start();
      const pending = await s.pending();
      const gateA = pending.find((approval) => approval.runId === a);
      const gateB = pending.find((approval) => approval.runId === b);
      if (!gateA || !gateB) throw new Error('Missing parked gates');
      await s.decide(gateB.id, 'approve');
      expect((await s.state(b)).status).toBe('running');
      const before = await s.app.inject(`/api/agents/${AGENT}`);
      expect(AgentSchema.parse(before.json()).status).toBe('working');
      await s.decide(gateA.id, decision);
      const after = await s.app.inject(`/api/agents/${AGENT}`);
      expect(AgentSchema.parse(after.json()).status).toBe('working');
      expect((await s.state(b)).status).toBe('running');
    },
  );
  it.each([false, true])(
    'R-06 completion reconciles the agent to idle after requiresApproval=%s',
    async (gate) => {
      const s = await setup({}, createFakeRuntime(), gate);
      const id = await s.start();
      if (gate) {
        const approval = (await s.pending())[0];
        if (!approval) throw new Error('Missing gate');
        await s.decide(approval.id, 'approve');
      }
      expect((await s.state(id)).status).toBe('completed');
      const response = await s.app.inject(`/api/agents/${AGENT}`);
      expect(response.statusCode).toBe(200);
      expect(AgentSchema.parse(response.json()).status).toBe('idle');
    },
  );
  it('R-07 counts earlier turns against the daily budget across runs', async () => {
    const s = await setup({ dailyCostCapUsd: 0.001 });
    expect((await s.state(await s.start())).status).toBe('completed');
    const blocked = await s.state(await s.start());
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatch(/daily|cost|budget|cap/i);
  });
  it('R-08 blocks the 31st turn within an hour and permits a turn after the window', async () => {
    const s = await setup();
    for (let n = 0; n < 30; n++)
      expect((await s.state(await s.start())).status).toBe('completed');
    const blocked = await s.state(await s.start());
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatch(/rate|hour|turn.*limit/i);
    vi.setSystemTime(Date.now() + 3600000);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(await s.start())).status).toBe('completed');
  });
  it('R-07 aborts on a mid-turn usage event and preserves incurred usage without retries', async () => {
    const runtime = createFakeRuntime({
      scripts: {
        [AGENT]: [
          {
            events: [
              {
                type: 'usage',
                inputTokens: 100,
                outputTokens: 50,
                costUsd: 0.6,
              },
            ],
            text: 'Must not complete',
          },
        ],
      },
    });
    const s = await setup({}, runtime);
    const id = await s.start();
    await vi.advanceTimersByTimeAsync(60000);
    const result = await s.state(id);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/cost|budget|cap/i);
    expect(result.totalCostUsd).toBeCloseTo(0.6);
    expect(result.totalTokens).toBe(150);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      costUsd: 0.6,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(s.events).toContain('usage');
  });
  it.each(['approve', 'reject'] as const)(
    'R-06 step gate waits and %s resolves the persisted run',
    async (decision) => {
      const s = await setup({}, createFakeRuntime(), true);
      const id = await s.start();
      expect((await s.state(id)).status).toBe('waiting_approval');
      const pending = await s.pending();
      expect(pending).toHaveLength(1);
      const approval = pending[0];
      expect(approval).toMatchObject({
        runId: id,
        kind: 'step_gate',
        status: 'pending',
      });
      if (!approval) throw new Error('Missing gate approval');
      expect(s.events).toContain('approval.created');
      await s.decide(approval.id, decision);
      const result = await s.state(id);
      expect(result.status).toBe(
        decision === 'approve' ? 'completed' : 'failed',
      );
      expect(result.approvals[0]?.status).toBe(
        decision === 'approve' ? 'approved' : 'rejected',
      );
      expect(await s.pending()).toEqual([]);
      expect(s.events).toContain('approval.resolved');
    },
  );
  it('R-06 expires the pending step gate after 30 minutes and fails the run', async () => {
    const s = await setup({}, createFakeRuntime(), true);
    const id = await s.start();
    expect((await s.state(id)).status).toBe('waiting_approval');
    vi.setSystemTime(Date.now() + 30 * 60000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await s.state(id);
    expect(result.status).toBe('failed');
    expect(result.approvals[0]?.status).toBe('expired');
    expect(await s.pending()).toEqual([]);
    expect(s.events).toContain('approval.resolved');
  });
  it.each(['approve', 'reject', 'expire'] as const)(
    'R-09 tool permission %s reaches respondPermission with the persisted identifiers',
    async (decision) => {
      const fake = createFakeRuntime();
      const replies: unknown[][] = [];
      let release: (() => void) | undefined;
      const runtime: AgentRuntime = {
        health: () => fake.health(),
        async runTurn(input, onEvent, signal) {
          onEvent({
            type: 'permission_request',
            sessionId: 'runtime-session',
            permissionId: 'permission-1',
            tool: 'bash',
            detail: 'Run deployment 🌍',
          });
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
          return fake.runTurn(input, onEvent, signal);
        },
        async respondPermission(...args) {
          replies.push(args);
          release?.();
        },
      };
      const s = await setup({}, runtime);
      const id = await s.start();
      const pending = await s.pending();
      expect(pending).toHaveLength(1);
      const approval = pending[0];
      expect(approval).toMatchObject({
        kind: 'tool_permission',
        runtimeSessionId: 'runtime-session',
        runtimePermissionId: 'permission-1',
      });
      if (!approval) throw new Error('Missing permission approval');
      expect((await s.state(id)).status).toBe('waiting_approval');
      if (decision === 'expire') {
        vi.setSystemTime(Date.now() + 30 * 60000);
        await vi.advanceTimersByTimeAsync(1000);
      } else await s.decide(approval.id, decision);
      expect(replies).toEqual([
        ['runtime-session', 'permission-1', decision === 'approve'],
      ]);
      expect((await s.state(id)).approvals[0]?.status).toBe(
        decision === 'expire'
          ? 'expired'
          : decision === 'approve'
            ? 'approved'
            : 'rejected',
      );
    },
  );
});
