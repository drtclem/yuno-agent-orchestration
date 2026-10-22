import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
  WorkflowSchema,
  type WorkflowGraph,
} from '@yuno/shared';
import type { AgentRuntime } from '../src/runtime/types.js';
import { messages, runs, runSteps } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createConfigurationRepository } from '../src/db/repos/configuration.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createWorkflowsRepository } from '../src/db/repos/workflows.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import { createEventHub } from '../src/events/hub.js';
import { createLogsRepository } from '../src/db/repos/logs.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 100000;
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
const graph = (): WorkflowGraph => ({
  nodes: ['coder', 'reviewer', 'deployer'].map((name, index) => ({
    id: name,
    agentId: id(index + 1),
    label: name,
    position: { x: index, y: 0 },
  })),
  edges: [
    { id: 'review', source: 'coder', target: 'reviewer', condition: 'always' },
    { id: 'retry', source: 'reviewer', target: 'coder', condition: 'rejected' },
    {
      id: 'deploy',
      source: 'reviewer',
      target: 'deployer',
      condition: 'approved',
    },
  ],
  startNodeId: 'coder',
  maxIterations: 6,
});
async function setup(
  options: Parameters<typeof createFakeRuntime>[0] = {},
  runtime?: AgentRuntime,
  configure?: (
    app: ReturnType<typeof buildApp>,
    connection: ReturnType<typeof openDatabase>,
  ) => void,
) {
  const connection = openDatabase(':memory:');
  cleanups.push(() => {
    connection.close();
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'yuno-engine-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  for (let n = 1; n <= 3; n++)
    createAgentsRepository(connection.db).insert(
      AgentSchema.parse({
        id: id(n),
        name: `Agent ${n}`,
        role: n === 2 ? 'reviewer' : 'coder',
        systemPrompt: 'Work.',
        status: 'idle',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  const hub = createEventHub(createLogsRepository(connection.db));
  const events: string[] = [];
  hub.subscribe((event) => events.push(event.type));
  const app = buildApp({
    db: connection.db,
    runtime:
      runtime ??
      createFakeRuntime({ roles: { [id(2)]: 'reviewer' }, ...options }),
    hub,
    dataDir,
  });
  cleanups.push(() => app.close());
  configure?.(app, connection);
  await app.ready();
  async function save(value = graph()) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Dev pipeline', description: 'Test', graph: value },
    });
    expect(response.statusCode).toBe(201);
    return WorkflowSchema.parse(response.json());
  }
  async function start(workflowId: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/runs`,
      payload: { input: 'Build 🌍 使用'.repeat(1000) },
    });
    expect(response.statusCode).toBe(201);
    return RunSchema.parse(response.json());
  }
  async function state(runId: string) {
    const response = await app.inject(`/api/runs/${runId}`);
    expect(response.statusCode).toBe(200);
    return z
      .object({
        ...RunSchema.shape,
        steps: z.array(RunStepSchema),
        messages: z.array(MessageSchema),
        approvals: z.array(z.unknown()),
      })
      .parse(response.json());
  }
  return { app, ...connection, save, start, state, events };
}

describe('T9 workflow engine and run API (R-11/R-12/R-14/R-15/R-25/R-32)', () => {
  it('R-02 T22 fails legacy model turns visibly with model_not_allowed without invoking the runtime', async () => {
    const runtime = createFakeRuntime();
    const runTurn = vi.spyOn(runtime, 'runTurn');
    const s = await setup({}, runtime);
    s.sqlite
      .prepare('UPDATE agents SET model = ? WHERE id = ?')
      .run('openai/gpt-5-2025-08-07', id(1));
    const workflow = await s.save();
    const run = await s.start(workflow.id);
    await vi.advanceTimersByTimeAsync(31000);
    const result = await s.state(run.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('model_not_allowed');
    expect(runTurn).not.toHaveBeenCalled();
    expect(s.events).toContain('run.updated');
  });

  it('R-28 T22 snapshots the graph before routing and preserves completed run detail after workflow edits', async () => {
    const s = await setup();
    const original = graph();
    const workflow = await s.save(original);
    const run = await s.start(workflow.id);
    const changed = {
      ...original,
      edges: original.edges.filter((edge) => edge.id !== 'review'),
    };
    // Bypass edit policy to simulate a persisted workflow changing while a run is in flight.
    createWorkflowsRepository(s.db).update({ ...workflow, graph: changed });
    await vi.advanceTimersByTimeAsync(3000);
    const detail = (await s.app.inject(`/api/runs/${run.id}`)).json();
    expect(detail.status).toBe('completed');
    expect(detail.steps.map((step: { nodeId: string }) => step.nodeId)).toEqual(
      ['coder', 'reviewer', 'coder', 'reviewer', 'deployer'],
    );
    expect(detail.graphSnapshot).toEqual(original);
    createWorkflowsRepository(s.db).update({
      ...workflow,
      graph: {
        ...original,
        nodes: original.nodes.map((node) => ({
          ...node,
          label: 'Changed after completion',
        })),
      },
    });
    expect(
      (await s.app.inject(`/api/runs/${run.id}`)).json().graphSnapshot,
    ).toEqual(original);
  });

  it('R-11/R-12/R-14/R-15/R-32 rejects once, retries, approves and deploys with the complete ordered verdict trail', async () => {
    const s = await setup();
    const workflow = await s.save();
    const run = await s.start(workflow.id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result).toMatchObject({
      status: 'completed',
      result: 'Agent 3 completed the task.',
      error: null,
    });
    expect(
      result.steps.map((step) => [
        step.nodeId,
        step.iteration,
        step.verdict,
        step.status,
      ]),
    ).toEqual([
      ['coder', 1, null, 'completed'],
      ['reviewer', 1, 'rejected', 'completed'],
      ['coder', 2, null, 'completed'],
      ['reviewer', 2, 'approved', 'completed'],
      ['deployer', 1, null, 'completed'],
    ]);
    expect(
      result.messages.map((message) => [
        message.toAgentId,
        message.verdict,
        message.status,
      ]),
    ).toEqual([
      [id(1), null, 'acked'],
      [id(2), null, 'acked'],
      [id(1), 'rejected', 'acked'],
      [id(2), null, 'acked'],
      [id(3), 'approved', 'acked'],
    ]);
    expect(result.messages[2]?.content).toContain('Please revise');
    expect(result.steps[2]?.prompt).toContain('Please revise');
    expect(result.approvals).toEqual([]);
    expect(s.events).toEqual(
      expect.arrayContaining([
        'run.updated',
        'step.updated',
        'message.created',
        'message.updated',
        'usage',
      ]),
    );
    const trail = await s.app.inject(`/api/messages?runId=${run.id}`);
    expect(trail.json()).toEqual(result.messages);
    const runs = await s.app.inject('/api/runs');
    expect(runs.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: run.id, status: 'completed' }),
      ]),
    );
  });
  it('R-12/R-32 fails with loop_limit before exceeding the per-node turn limit', async () => {
    const s = await setup({
      scripts: {
        [id(2)]: [
          { text: 'Revise\nVERDICT: REJECTED' },
          { text: 'Revise\nVERDICT: REJECTED' },
        ],
      },
    });
    const workflow = await s.save({ ...graph(), maxIterations: 1 });
    const run = await s.start(workflow.id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result).toMatchObject({ status: 'failed', error: 'loop_limit' });
    expect(
      result.steps
        .filter((step) => step.status === 'completed')
        .map((step) => step.nodeId),
    ).toEqual(['coder', 'reviewer']);
  });
  it('R-11/R-32 fails with no_matching_edge when outgoing conditions do not match', async () => {
    const s = await setup();
    const value = graph();
    value.edges = [
      {
        id: 'conditional',
        source: 'coder',
        target: 'deployer',
        condition: 'approved',
      },
    ];
    const run = await s.start((await s.save(value)).id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await s.state(run.id)).toMatchObject({
      status: 'failed',
      error: 'no_matching_edge',
    });
  });
  it('R-12/R-32 cancels and aborts the in-flight turn without creating a handoff', async () => {
    const s = await setup({ delayMs: 60000 });
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(run.id)).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
    );
    const response = await s.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(61000);
    const result = await s.state(run.id);
    expect(result.status).toBe('cancelled');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.status).toBe('dead');
    expect(
      result.steps.some(
        (step) => step.status === 'running' || step.status === 'completed',
      ),
    ).toBe(false);
  });
  it('R-11/R-32 rejects invalid graphs on save and validates again on run', async () => {
    const s = await setup();
    const invalid = { ...graph(), startNodeId: 'missing' };
    const response = await s.app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Invalid', description: '', graph: invalid },
    });
    expect(response.statusCode).toBe(400);
    expect(createWorkflowsRepository(s.db).list()).toHaveLength(0);
    const workflow = await s.save();
    createWorkflowsRepository(s.db).update({ ...workflow, graph: invalid });
    const start = await s.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflow.id}/runs`,
      payload: { input: 'start' },
    });
    expect(start.statusCode).toBe(400);
    expect((await s.app.inject('/api/runs')).json()).toEqual([]);
  });
  it('R-25/R-32 persists correct per-step, per-run and per-agent usage totals with since filtering', async () => {
    const s = await setup({
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result.totalTokens).toBe(75);
    expect(result.totalCostUsd).toBeCloseTo(0.005);
    expect(result.steps).toHaveLength(5);
    result.steps.forEach((step) =>
      expect(step).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      }),
    );
    const byRun = await s.app.inject('/api/usage?groupBy=run&since=0');
    expect(byRun.json()).toEqual([
      {
        runId: run.id,
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
        costUsd: 0.005,
      },
    ]);
    const byAgent = await s.app.inject('/api/usage?groupBy=agent&since=0');
    expect(byAgent.json()).toEqual(
      expect.arrayContaining([
        {
          agentId: id(1),
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costUsd: 0.002,
        },
        {
          agentId: id(2),
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costUsd: 0.002,
        },
        {
          agentId: id(3),
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costUsd: 0.001,
        },
      ]),
    );
    expect(
      (
        await s.app.inject(`/api/usage?groupBy=run&since=${NOW + 10000}`)
      ).json(),
    ).toEqual([]);
  });
  it('R-11/R-14/R-32 chooses the first matching edge and matches contains case-insensitively', async () => {
    const s = await setup({
      scripts: { [id(1)]: [{ text: 'Ready To DEPLOY' }] },
    });
    const value = graph();
    value.edges = [
      {
        id: 'first',
        source: 'coder',
        target: 'deployer',
        condition: { contains: 'deploy' },
      },
      {
        id: 'fallback',
        source: 'coder',
        target: 'reviewer',
        condition: 'always',
      },
    ];
    const run = await s.start((await s.save(value)).id);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await s.state(run.id);
    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => step.nodeId)).toEqual([
      'coder',
      'deployer',
    ]);
  });
  it('R-11/R-32 supports workflow list, read, update and delete with graph validation', async () => {
    const s = await setup();
    const workflow = await s.save();
    expect((await s.app.inject('/api/workflows')).json()).toEqual([workflow]);
    expect(
      (await s.app.inject(`/api/workflows/${workflow.id}`)).json(),
    ).toEqual(workflow);
    const update = await s.app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflow.id}`,
      payload: { name: 'Updated', description: 'Edited', graph: graph() },
    });
    expect(update.statusCode).toBe(200);
    expect(WorkflowSchema.parse(update.json())).toMatchObject({
      id: workflow.id,
      name: 'Updated',
    });
    const invalid = await s.app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflow.id}`,
      payload: {
        name: 'Invalid',
        description: '',
        graph: { ...graph(), startNodeId: 'missing' },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(createWorkflowsRepository(s.db).get(workflow.id)?.name).toBe(
      'Updated',
    );
    expect(
      (
        await s.app.inject({
          method: 'DELETE',
          url: `/api/workflows/${workflow.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await s.app.inject(`/api/workflows/${workflow.id}`)).statusCode,
    ).toBe(404);
  });
  it('R-11/R-15/R-32 treats a missing or malformed verdict as rejected once then fails clearly', async () => {
    const s = await setup({
      scripts: {
        [id(2)]: [
          { text: 'Please revise without a verdict' },
          { text: 'Still malformed\nVERDICT: MAYBE' },
        ],
      },
    });
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/verdict/);
    expect(
      result.steps.filter((step) => step.nodeId === 'reviewer'),
    ).toHaveLength(2);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: id(2),
          toAgentId: id(1),
          verdict: 'rejected',
        }),
      ]),
    );
    expect(result.steps.some((step) => step.nodeId === 'deployer')).toBe(false);
  });
  it('R-32 refuses execution without a runtime', async () => {
    const s = await setup();
    const workflow = await s.save();
    const app = buildApp({ db: s.db });
    cleanups.push(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflow.id}/runs`,
      payload: { input: 'start' },
    });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).toContain('guardrails_unavailable');
    expect((await s.app.inject('/api/runs')).json()).toEqual([]);
  });
  it('R-32 parks approval-gated execution before any agent acts', async () => {
    const s = await setup();
    const value = graph();
    value.nodes = value.nodes.map((node) => ({
      ...node,
      requiresApproval: true,
    }));
    const workflow = await s.save(value);
    const run = await s.start(workflow.id);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await s.state(run.id);
    expect(result).toMatchObject({
      status: 'waiting_approval',
      error: null,
    });
    expect(result.steps.some((step) => step.status === 'completed')).toBe(
      false,
    );
    expect(result.messages).toHaveLength(1);
  });
  it('R-32 recovers a processing message and executes with guardrails', async () => {
    const s = await setup();
    const workflow = await s.save();
    await s.app.close();
    s.db
      .insert(runs)
      .values({
        id: id(50),
        workflowId: workflow.id,
        trigger: 'ui',
        input: 'recover',
        status: 'running',
        result: null,
        error: null,
        startedAt: NOW,
        finishedAt: null,
        totalCostUsd: 0,
        totalTokens: 0,
      })
      .run();
    s.db
      .insert(messages)
      .values({
        id: id(51),
        runId: id(50),
        conversationId: null,
        fromKind: 'human',
        fromId: 'ui',
        toAgentId: id(1),
        channel: 'ui',
        content: 'recover',
        verdict: null,
        status: 'processing',
        attempts: 1,
        nextAttemptAt: NOW,
        idempotencyKey: `run:${id(50)}:start`,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const runtime = createFakeRuntime({ roles: { [id(2)]: 'reviewer' } });
    const runTurn = vi.spyOn(runtime, 'runTurn');
    const app = buildApp({ db: s.db, runtime });
    cleanups.push(() => app.close());
    await app.ready();
    await vi.advanceTimersByTimeAsync(1000);
    const response = await app.inject(`/api/runs/${id(50)}`);
    expect(response.json()).toMatchObject({
      status: 'completed',
      error: null,
    });
    expect(runTurn).toHaveBeenCalledTimes(5);
    expect(response.json().steps).toHaveLength(5);
  });
  it('R-12/R-14/R-32 tracks distinct nodes sharing the same agent independently', async () => {
    const s = await setup();
    const value = graph();
    value.nodes = value.nodes.map((node) => ({ ...node, agentId: id(1) }));
    value.edges = [
      { id: 'one', source: 'coder', target: 'reviewer', condition: 'always' },
      {
        id: 'two',
        source: 'reviewer',
        target: 'deployer',
        condition: 'always',
      },
    ];
    value.maxIterations = 1;
    const run = await s.start((await s.save(value)).id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result.status).toBe('completed');
    expect(
      result.steps.map((step) => [step.nodeId, step.agentId, step.iteration]),
    ).toEqual([
      ['coder', id(1), 1],
      ['reviewer', id(1), 1],
      ['deployer', id(1), 1],
    ]);
    expect(result.messages.every((message) => message.status === 'acked')).toBe(
      true,
    );
  });
  it('R-12/R-32 preserves cancellation when a runtime ignores abort and resolves late', async () => {
    const fake = createFakeRuntime({ delayMs: 1000 });
    const runtime: AgentRuntime = {
      ...fake,
      runTurn: (input, onEvent) =>
        fake.runTurn(input, onEvent, new AbortController().signal),
    };
    const s = await setup({}, runtime);
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(run.id)).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
    );
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/cancel`,
        })
      ).statusCode,
    ).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result.status).toBe('cancelled');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.status).toBe('dead');
    expect(result.steps.some((step) => step.status === 'completed')).toBe(
      false,
    );
  });
  it('R-32 stops active turns and releases persistence before an external database-close hook', async () => {
    let stateAtDatabaseClose:
      | {
          statuses: string[];
          messageStatuses: string[];
          agentStatus: string | undefined;
        }
      | undefined;
    const s = await setup({ delayMs: 60000 }, undefined, (app, connection) => {
      app.addHook('onClose', async () => {
        stateAtDatabaseClose = {
          statuses: connection.db
            .select()
            .from(runSteps)
            .all()
            .map((step) => step.status),
          messageStatuses: connection.db
            .select()
            .from(messages)
            .all()
            .map((message) => message.status),
          agentStatus: createAgentsRepository(connection.db).get(id(1))?.status,
        };
        connection.close();
      });
    });
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(run.id)).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
    );
    await s.app.close();
    expect(stateAtDatabaseClose).toEqual({
      statuses: ['failed'],
      messageStatuses: ['pending'],
      agentStatus: 'idle',
    });
  });
  it('R-14/R-15/R-32 strips remembered facts from handoffs and includes them in the next turn prompt', async () => {
    const fake = createFakeRuntime({
      roles: { [id(2)]: 'reviewer' },
      scripts: {
        [id(1)]: [
          { text: 'Initial work\nREMEMBER: Always validate input' },
          { text: 'Revised work' },
        ],
      },
    });
    const runTurn = vi.spyOn(fake, 'runTurn');
    const s = await setup({}, fake);
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await s.state(run.id);
    expect(result.status).toBe('completed');
    expect(
      result.messages.every(
        (message) => !message.content.includes('REMEMBER:'),
      ),
    ).toBe(true);
    expect(result.messages[1]?.content).toBe('Initial work');
    expect(createConfigurationRepository(s.db).listMemories(id(1))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fact: 'Always validate input' }),
      ]),
    );
    const coderTurns = runTurn.mock.calls.filter(
      ([input]) => input.agent.agentId === id(1),
    );
    expect(coderTurns).toHaveLength(2);
    expect(coderTurns[1]?.[0].agent.systemPrompt).toContain(
      'Always validate input',
    );
  });
  it('R-25/R-32 persists usage reported before a failed turn and counts it with successful retry usage', async () => {
    const fake = createFakeRuntime({ roles: { [id(2)]: 'reviewer' } });
    let first = true;
    const runtime: AgentRuntime = {
      ...fake,
      async runTurn(input, onEvent, signal) {
        if (first) {
          first = false;
          onEvent({
            type: 'usage',
            inputTokens: 7,
            outputTokens: 3,
            costUsd: 0.002,
          });
          throw new Error('external runtime disconnected');
        }
        return fake.runTurn(input, onEvent, signal);
      },
    };
    const s = await setup({}, runtime);
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(16000);
    const result = await s.state(run.id);
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(6);
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.002,
    });
    expect(result.totalTokens).toBe(85);
    expect(result.totalCostUsd).toBeCloseTo(0.007);
    const usage = await s.app.inject('/api/usage?groupBy=run&since=0');
    expect(usage.json()).toEqual([
      {
        runId: run.id,
        inputTokens: 57,
        outputTokens: 28,
        totalTokens: 85,
        costUsd: 0.007,
      },
    ]);
  });
  it('R-25/R-32 retains observed in-flight usage when the run is cancelled', async () => {
    const fake = createFakeRuntime({ delayMs: 60000 });
    const runtime: AgentRuntime = {
      ...fake,
      runTurn(input, onEvent, signal) {
        onEvent({
          type: 'usage',
          inputTokens: 17,
          outputTokens: 4,
          costUsd: 0.003,
        });
        return fake.runTurn(input, onEvent, signal);
      },
    };
    const s = await setup({}, runtime);
    const run = await s.start((await s.save()).id);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.state(run.id)).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
    );
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/cancel`,
        })
      ).statusCode,
    ).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await s.state(run.id);
    expect(result.status).toBe('cancelled');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      inputTokens: 17,
      outputTokens: 4,
      costUsd: 0.003,
    });
    expect(result.totalTokens).toBe(21);
    expect(result.totalCostUsd).toBeCloseTo(0.003);
    expect(
      (await s.app.inject('/api/usage?groupBy=run&since=0')).json(),
    ).toEqual([
      {
        runId: run.id,
        inputTokens: 17,
        outputTokens: 4,
        totalTokens: 21,
        costUsd: 0.003,
      },
    ]);
  });
  it.each([
    {
      execution: undefined,
      expectedError: 'guardrails_unavailable',
      otherRun: false,
    },
    {
      execution: 'fake' as const,
      expectedError: 'loop_limit',
      otherRun: false,
    },
    { execution: 'fake' as const, expectedError: 'loop_limit', otherRun: true },
  ])(
    'R-12/R-32 closes recovered running steps and resets stale working status on $expectedError',
    async ({ execution, expectedError, otherRun }) => {
      const s = await setup();
      const workflow = await s.save({ ...graph(), maxIterations: 1 });
      await s.app.close();
      createAgentsRepository(s.db).setStatus(id(1), 'working', NOW);
      s.db
        .insert(runs)
        .values({
          id: id(50),
          workflowId: workflow.id,
          trigger: 'ui',
          input: 'recover',
          status: 'running',
          result: null,
          error: null,
          startedAt: NOW,
          finishedAt: null,
          totalCostUsd: 0,
          totalTokens: 0,
        })
        .run();
      s.db
        .insert(messages)
        .values({
          id: id(51),
          runId: id(50),
          conversationId: null,
          fromKind: 'human',
          fromId: 'ui',
          toAgentId: id(1),
          channel: 'ui',
          content: 'recover',
          verdict: null,
          status: 'processing',
          attempts: 1,
          nextAttemptAt: NOW,
          idempotencyKey: `run:${id(50)}:start`,
          error: null,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      s.db
        .insert(runSteps)
        .values({
          id: id(52),
          runId: id(50),
          nodeId: 'coder',
          agentId: id(1),
          iteration: 1,
          status: 'running',
          prompt: 'recover',
          output: null,
          verdict: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          startedAt: NOW,
          finishedAt: null,
          error: null,
        })
        .run();
      if (otherRun) {
        s.db
          .insert(runs)
          .values({
            id: id(60),
            workflowId: workflow.id,
            trigger: 'ui',
            input: 'other',
            status: 'running',
            result: null,
            error: null,
            startedAt: NOW,
            finishedAt: null,
            totalCostUsd: 0,
            totalTokens: 0,
          })
          .run();
        s.db
          .insert(runSteps)
          .values({
            id: id(62),
            runId: id(60),
            nodeId: 'coder',
            agentId: id(1),
            iteration: 1,
            status: 'running',
            prompt: 'other',
            output: null,
            verdict: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            startedAt: NOW,
            finishedAt: null,
            error: null,
          })
          .run();
      }
      const runtime = createFakeRuntime();
      const runTurn = vi.spyOn(runtime, 'runTurn');
      const events: { type: string; data: unknown }[] = [];
      const hub = createEventHub(createLogsRepository(s.db));
      hub.subscribe((event) => events.push(event));
      const app = buildApp({
        db: s.db,
        ...(execution ? { runtime } : {}),
        hub,
      });
      cleanups.push(() => app.close());
      await app.ready();
      await vi.advanceTimersByTimeAsync(1000);
      const response = await app.inject(`/api/runs/${id(50)}`);
      expect(response.json()).toMatchObject({
        status: 'failed',
        error: expectedError,
      });
      expect(response.json().steps).toEqual([
        expect.objectContaining({
          id: id(52),
          status: 'failed',
          finishedAt: expect.any(Number),
        }),
      ]);
      expect(createAgentsRepository(s.db).get(id(1))?.status).toBe(
        otherRun ? 'working' : 'idle',
      );
      if (otherRun) {
        expect((await app.inject(`/api/runs/${id(60)}`)).json()).toMatchObject({
          status: 'running',
          steps: [expect.objectContaining({ id: id(62), status: 'running' })],
        });
      }
      expect(events).toEqual(
        expect.arrayContaining([
          {
            type: 'step.updated',
            ts: expect.any(Number),
            data: expect.objectContaining({ id: id(52), status: 'failed' }),
          },
        ]),
      );
      expect(runTurn).not.toHaveBeenCalled();
    },
  );
  it('R-12/R-32 clears orphaned working status when cancelled before a recovered turn is dispatched', async () => {
    const runtime = createFakeRuntime();
    const runTurn = vi.spyOn(runtime, 'runTurn');
    const s = await setup({}, runtime);
    const workflow = await s.save();
    createAgentsRepository(s.db).setStatus(id(1), 'working', NOW);
    s.db
      .insert(runs)
      .values({
        id: id(70),
        workflowId: workflow.id,
        trigger: 'ui',
        input: 'recover',
        status: 'running',
        result: null,
        error: null,
        startedAt: NOW,
        finishedAt: null,
        totalCostUsd: 0,
        totalTokens: 0,
      })
      .run();
    s.db
      .insert(messages)
      .values({
        id: id(71),
        runId: id(70),
        conversationId: null,
        fromKind: 'human',
        fromId: 'ui',
        toAgentId: id(1),
        channel: 'ui',
        content: 'recover',
        verdict: null,
        status: 'pending',
        attempts: 1,
        nextAttemptAt: NOW,
        idempotencyKey: `run:${id(70)}:start`,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    s.db
      .insert(runSteps)
      .values({
        id: id(72),
        runId: id(70),
        nodeId: 'coder',
        agentId: id(1),
        iteration: 1,
        status: 'running',
        prompt: 'recover',
        output: null,
        verdict: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: NOW,
        finishedAt: null,
        error: null,
      })
      .run();
    const response = await s.app.inject({
      method: 'POST',
      url: `/api/runs/${id(70)}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    const result = await s.state(id(70));
    expect(result.status).toBe('cancelled');
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: id(72),
        status: 'failed',
        finishedAt: expect.any(Number),
      }),
    ]);
    expect(result.messages).toEqual([
      expect.objectContaining({ id: id(71), status: 'dead' }),
    ]);
    expect(createAgentsRepository(s.db).get(id(1))?.status).toBe('idle');
    expect(runTurn).not.toHaveBeenCalled();
  });
  it('R-12/R-32 settles recovered working status even when workspace preparation fails before runtime', async () => {
    const s = await setup();
    const workflow = await s.save({ ...graph(), maxIterations: 6 });
    await s.app.close();
    createAgentsRepository(s.db).setStatus(id(1), 'working', NOW);
    s.db
      .insert(runs)
      .values({
        id: id(80),
        workflowId: workflow.id,
        trigger: 'ui',
        input: 'recover',
        status: 'running',
        result: null,
        error: null,
        startedAt: NOW,
        finishedAt: null,
        totalCostUsd: 0,
        totalTokens: 0,
      })
      .run();
    s.db
      .insert(messages)
      .values({
        id: id(81),
        runId: id(80),
        conversationId: null,
        fromKind: 'human',
        fromId: 'ui',
        toAgentId: id(1),
        channel: 'ui',
        content: 'recover',
        verdict: null,
        status: 'processing',
        attempts: 0,
        nextAttemptAt: NOW,
        idempotencyKey: `run:${id(80)}:start`,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    s.db
      .insert(runSteps)
      .values({
        id: id(82),
        runId: id(80),
        nodeId: 'coder',
        agentId: id(1),
        iteration: 1,
        status: 'running',
        prompt: 'recover',
        output: null,
        verdict: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: NOW,
        finishedAt: null,
        error: null,
      })
      .run();
    const directory = await mkdtemp(join(tmpdir(), 'yuno-workspace-failure-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const dataDir = join(directory, 'regular-file');
    await writeFile(dataDir, 'This is a file, not a workspace directory.');
    const runtime = createFakeRuntime();
    const runTurn = vi.spyOn(runtime, 'runTurn');
    const app = buildApp({
      db: s.db,
      runtime,
      dataDir,
    });
    cleanups.push(() => app.close());
    await app.ready();
    await vi.advanceTimersByTimeAsync(31000);
    const response = await app.inject(`/api/runs/${id(80)}`);
    const result = z
      .object({
        ...RunSchema.shape,
        steps: z.array(RunStepSchema),
        messages: z.array(MessageSchema),
      })
      .parse(response.json());
    expect(result).toMatchObject({
      status: 'failed',
      error: 'message_processing_failed',
    });
    expect(result.steps).toEqual([
      expect.objectContaining({ id: id(82), status: 'failed' }),
    ]);
    expect(result.messages).toEqual([
      expect.objectContaining({ status: 'dead', attempts: 3 }),
    ]);
    expect(createAgentsRepository(s.db).get(id(1))?.status).toBe('idle');
    expect(runTurn).not.toHaveBeenCalled();
  });
});
