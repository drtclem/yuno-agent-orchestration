import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSchema,
  MessageSchema,
  type Message,
  type SSEEvent,
} from '@yuno/shared';
import { openDatabase, type AppDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createMessagesRepository } from '../src/db/repos/messages.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import { approvals, runSteps, runs } from '../src/db/schema.js';
import { createEventHub } from '../src/events/hub.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import { compileAgent } from '../src/domain/compile.js';
import { createDispatcher } from '../src/domain/dispatcher.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 100000;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
function setup(options: Parameters<typeof createFakeRuntime>[0] = {}) {
  const connection = openDatabase(':memory:');
  cleanups.push(() => {
    connection.close();
  });
  const agents = Array.from({ length: 6 }, (_, n) =>
    AgentSchema.parse({
      id: id(n + 1),
      name: `Agent ${n}`,
      role: 'writer',
      systemPrompt: 'Write.',
      status: 'idle',
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  agents.forEach((agent) =>
    createAgentsRepository(connection.db).insert(agent),
  );
  const repo = createMessagesRepository(connection.db);
  const events: SSEEvent[] = [];
  const logs = createLogsRepository(connection.db);
  const hub = createEventHub(logs);
  hub.subscribe((event) => events.push(event));
  const runtime = createFakeRuntime(options);
  const calls: Message[] = [];
  async function processMessage(message: Message, signal: AbortSignal) {
    calls.push(message);
    const agent = agents.find(
      (candidate) => candidate.id === message.toAgentId,
    );
    if (!agent) throw new Error('missing test agent');
    await runtime.runTurn(
      {
        agent: compileAgent(agent, [], []),
        sessionKey: message.id,
        workspaceDir: '/tmp/yuno-dispatcher-test',
        prompt: message.content,
      },
      () => {},
      signal,
    );
    return () => [];
  }
  function dispatcher(
    handler: (
      message: Message,
      signal: AbortSignal,
    ) => Promise<(tx: AppDatabase) => SSEEvent[]> = processMessage,
  ) {
    const result = createDispatcher({
      db: connection.db,
      hub,
      processMessage: handler,
    });
    cleanups.push(() => result.stop());
    return result;
  }
  function message(n: number, agent = 1): Message {
    return MessageSchema.parse({
      id: id(100 + n),
      runId: null,
      conversationId: null,
      fromKind: 'human',
      fromId: 'owner',
      toAgentId: id(agent),
      channel: 'ui',
      content: 'Hello 🌍 使用'.repeat(1000),
      verdict: null,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      idempotencyKey: `test:${n}`,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return {
    ...connection,
    repo,
    events,
    hub,
    logs,
    calls,
    dispatcher,
    message,
    processMessage,
  };
}

describe('T8 dispatcher (R-14, R-16, R-17, R-32)', () => {
  it('R-17/R-32 failed turn retries after 10s and 20s then becomes dead on attempt 3 and fails its run', async () => {
    const s = setup({
      scripts: {
        [id(1)]: [
          { error: 'offline' },
          { error: 'offline' },
          { error: 'offline' },
        ],
      },
    });
    s.db
      .insert(runs)
      .values({
        id: id(50),
        workflowId: null,
        trigger: 'ui',
        input: 'start',
        status: 'running',
        result: null,
        error: null,
        startedAt: NOW,
        finishedAt: null,
        totalCostUsd: 0,
        totalTokens: 0,
      })
      .run();
    const d = s.dispatcher();
    d.enqueue({ ...s.message(1), runId: id(50) });
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.repo.get(id(101))).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: NOW + 10000,
    });
    await vi.advanceTimersByTimeAsync(9998);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(s.repo.get(id(101))).toMatchObject({
      status: 'failed',
      attempts: 2,
      nextAttemptAt: NOW + 30001,
    });
    await vi.advanceTimersByTimeAsync(19998);
    expect(s.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(102);
    expect(s.repo.get(id(101))).toMatchObject({
      status: 'dead',
      attempts: 3,
      error: 'message_processing_failed',
    });
    expect(s.db.select().from(runs).get()).toMatchObject({
      status: 'failed',
      error: 'message_processing_failed',
    });
    expect(
      s.events
        .filter((e) => e.type === 'message.updated')
        .map((e) => e.data.status),
    ).toEqual([
      'processing',
      'failed',
      'processing',
      'failed',
      'processing',
      'dead',
    ]);
  });
  it('R-17/R-32 recovers a processing message exactly once, including repeated start calls', async () => {
    const s = setup();
    s.repo.insert({ ...s.message(1), status: 'processing', attempts: 1 });
    const d = s.dispatcher();
    d.start();
    d.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toHaveLength(1);
    expect(s.repo.get(id(101))).toMatchObject({ status: 'acked' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toHaveLength(1);
  });
  it('R-17 startup recovery keeps pending approvals waiting rather than rerunning the turn', async () => {
    const s = setup();
    s.db
      .insert(runs)
      .values({
        id: id(50),
        workflowId: null,
        trigger: 'ui',
        input: 'start',
        status: 'waiting_approval',
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
        id: id(51),
        runId: id(50),
        nodeId: 'write',
        agentId: id(1),
        iteration: 1,
        status: 'blocked',
        prompt: 'start',
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
    s.db
      .insert(approvals)
      .values({
        id: id(52),
        runId: id(50),
        stepId: id(51),
        agentId: id(1),
        kind: 'step_gate',
        detail: 'approve',
        runtimeSessionId: null,
        runtimePermissionId: null,
        status: 'pending',
        createdAt: NOW,
        resolvedAt: null,
      })
      .run();
    s.repo.insert({ ...s.message(1), runId: id(50), status: 'processing' });
    const d = s.dispatcher();
    d.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toHaveLength(0);
    expect(s.repo.get(id(101))).toMatchObject({ status: 'processing' });
    expect(s.db.select().from(approvals).get()).toMatchObject({
      status: 'pending',
    });
  });
  it('R-14/R-16/R-17/R-32 duplicate idempotency keys persist and publish one original message', () => {
    const s = setup();
    const d = s.dispatcher();
    const original = s.message(1);
    expect(d.enqueue(original)).toEqual(original);
    expect(
      d.enqueue({ ...s.message(2), idempotencyKey: original.idempotencyKey }),
    ).toEqual(original);
    expect(s.repo.list()).toEqual([original]);
    expect(s.events.filter((e) => e.type === 'message.created')).toEqual([
      { type: 'message.created', ts: NOW, data: original },
    ]);
  });
  it('R-17/R-32 serializes one agent while permitting other agents up to a global limit of four', async () => {
    const s = setup({ delayMs: 1000 });
    const d = s.dispatcher();
    for (const [n, agent] of [1, 1, 2, 3, 4, 5].entries())
      d.enqueue(s.message(n + 1, agent));
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(4);
    expect(new Set(s.calls.map((m) => m.toAgentId)).size).toBe(4);
    expect(s.repo.list().filter((m) => m.status === 'processing')).toHaveLength(
      4,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.repo.list().every((m) => m.status === 'acked')).toBe(true);
  });
  it('R-14/R-17 rolls back completion writes together with acknowledgment if completion fails', async () => {
    const s = setup();
    const d = s.dispatcher(async (message, signal) => {
      await s.processMessage(message, signal);
      return (tx: AppDatabase) => {
        createMessagesRepository(tx).insert(s.message(2));
        throw new Error('completion_failed');
      };
    });
    d.enqueue(s.message(1));
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.repo.get(id(101))).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'message_processing_failed',
    });
    expect(s.repo.get(id(102))).toBeUndefined();
    expect(
      s.events
        .filter((e) => e.type === 'message.updated')
        .some((e) => e.data.status === 'acked'),
    ).toBe(false);
  });
  it('R-14/R-16 commits next message and ack before publishing completion events', async () => {
    const s = setup();
    const observations: string[] = [];
    const d = s.dispatcher(async (message, signal) => {
      await s.processMessage(message, signal);
      return (tx: AppDatabase) => {
        createMessagesRepository(tx).insert(s.message(2));
        return [
          { type: 'message.created', ts: Date.now(), data: s.message(2) },
        ];
      };
    });
    // Completion observers must see the transaction's durable state.
    s.hub.subscribe((event) => {
      if (event.type === 'message.created' && event.data.id === id(102)) {
        observations.push(
          `${s.repo.get(id(101))?.status}:${s.repo.get(id(102))?.status}`,
        );
      }
    });
    d.enqueue(s.message(1));
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.repo.get(id(101))).toMatchObject({ status: 'acked' });
    expect(s.repo.get(id(102))).toMatchObject({ status: 'pending' });
    expect(
      s.events
        .filter((e) => e.type === 'message.created')
        .map((e) => e.data.id),
    ).toEqual([id(101), id(102)]);
    expect(observations).toEqual(['acked:pending']);
  });
  it('R-14/R-17 invalid completion events roll back next message and acknowledgment before publication', async () => {
    const s = setup();
    const d = s.dispatcher(async (message, signal) => {
      await s.processMessage(message, signal);
      return (tx: AppDatabase) => {
        createMessagesRepository(tx).insert(s.message(2));
        return [{ type: 'message.created', ts: -1, data: s.message(2) }];
      };
    });
    d.enqueue(s.message(1));
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.repo.get(id(101))).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'message_processing_failed',
    });
    expect(s.repo.get(id(102))).toBeUndefined();
    expect(s.events.filter((e) => e.type === 'message.created')).toHaveLength(
      1,
    );
    expect(
      s.events
        .filter((e) => e.type === 'message.updated')
        .some((e) => e.data.status === 'acked'),
    ).toBe(false);
  });
  it('R-16/R-17 halts visibly on postcommit event persistence failure without retrying committed work', async () => {
    const s = setup();
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {});
    const persist = vi.spyOn(s.logs, 'insert').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    cleanups.push(() => {
      fallback.mockRestore();
      persist.mockRestore();
    });
    const d = s.dispatcher(async (message, signal) => {
      await s.processMessage(message, signal);
      return (tx: AppDatabase) => {
        createMessagesRepository(tx).insert(s.message(2));
        return [
          {
            type: 'log',
            ts: NOW,
            data: {
              id: id(70),
              ts: NOW,
              level: 'info',
              agentId: id(1),
              runId: null,
              event: 'turn_completed',
              data: {},
            },
          },
        ];
      };
    });
    d.enqueue(s.message(1));
    d.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.repo.get(id(101))).toMatchObject({ status: 'acked', attempts: 0 });
    expect(s.repo.get(id(102))).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(s.calls).toHaveLength(1);
    expect(fallback).toHaveBeenCalled();
  });
  it('R-17 stop aborts and waits for an active turn before restart without overlapping delivery', async () => {
    const s = setup({ delayMs: 1000 });
    const d = s.dispatcher();
    d.enqueue(s.message(1));
    d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(1);
    await d.stop();
    expect(s.repo.get(id(101))?.status).not.toBe('acked');
    const calls = s.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(calls);
    d.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.calls).toHaveLength(2);
    expect(s.repo.get(id(101))).toMatchObject({ status: 'acked' });
  });
});
