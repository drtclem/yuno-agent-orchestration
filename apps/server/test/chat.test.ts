import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSchema, type SSEEvent } from '@yuno/shared';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createConfigurationRepository } from '../src/db/repos/configuration.js';
import { createMessagesRepository } from '../src/db/repos/messages.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import { createEventHub } from '../src/events/hub.js';
import { createEngine } from '../src/domain/engine.js';
import { createChat } from '../src/domain/chat.js';
import { createFakeChannel } from '../src/channels/fake/index.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import { buildApp } from '../src/app.js';
import type { TurnInput } from '../src/runtime/types.js';

const agentId = '00000000-0000-4000-8000-000000000001';
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
  vi.setSystemTime(100000);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
async function setup() {
  const connection = openDatabase(':memory:');
  cleanups.push(() => {
    connection.close();
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'yuno-chat-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  createAgentsRepository(connection.db).insert(
    AgentSchema.parse({
      id: agentId,
      name: 'Chat agent',
      role: 'helper',
      systemPrompt: 'Be warm.',
      status: 'idle',
      createdAt: 100000,
      updatedAt: 100000,
    }),
  );
  createConfigurationRepository(connection.db).setChannel(agentId, {
    type: 'slack',
    enabled: true,
    config: { respondTo: 'dm_and_mentions' },
  });
  const hub = createEventHub(createLogsRepository(connection.db));
  const events: SSEEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const runtime = createFakeRuntime({
    scripts: {
      [agentId]: [
        { text: 'First reply.\nREMEMBER: Likes tea.' },
        { text: 'Second reply.' },
      ],
    },
  });
  const inputs: string[] = [];
  const turnInputs: TurnInput[] = [];
  const runTurn = runtime.runTurn.bind(runtime);
  runtime.runTurn = (input, onEvent, signal) => {
    inputs.push(input.sessionKey);
    turnInputs.push(input);
    return runTurn(input, onEvent, signal);
  };
  return {
    ...connection,
    dataDir,
    hub,
    events,
    runtime,
    inputs,
    turnInputs,
    messages: createMessagesRepository(connection.db),
    channel: createFakeChannel(),
  };
}
const inbound = {
  channel: 'slack' as const,
  externalEventId: 'Ev1',
  conversationId: 'slack:T1:D1:dm',
  userId: 'U1',
  text: 'Hello 🌍 使用'.repeat(1000),
};
async function start() {
  const s = await setup();
  const engine = createEngine({ ...s, db: s.db });
  const chat = createChat({ db: s.db, hub: s.hub, engine, channel: s.channel });
  cleanups.push(() => engine.stop());
  cleanups.push(() => chat.stop());
  await engine.start();
  await chat.start();
  return { ...s, engine, chat };
}

describe('T13 fake channel chat (R-18/R-19/R-23)', () => {
  it('R-18/R-19 inbound yields the bound agent reply; R-23 persists and publishes human and agent messages', async () => {
    const s = await start();
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.channel.messages).toEqual([
      expect.objectContaining({
        conversationId: inbound.conversationId,
        text: 'First reply.',
      }),
    ]);
    const trail = s.messages.list().filter((m) => m.channel === 'slack');
    expect(trail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromKind: 'human',
          fromId: 'U1',
          toAgentId: agentId,
          content: inbound.text,
          status: 'acked',
        }),
        expect.objectContaining({
          fromKind: 'agent',
          fromId: agentId,
          content: 'First reply.',
          status: 'acked',
        }),
      ]),
    );
    for (const message of trail)
      expect(s.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message.created',
            data: expect.objectContaining({ id: message.id }),
          }),
        ]),
      );
  });
  it('R-18 ignores duplicate externalEventId without another turn or persisted human message', async () => {
    const s = await start();
    await s.channel.receive(inbound);
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.inputs).toHaveLength(1);
    expect(s.channel.messages).toHaveLength(1);
    expect(
      s.messages.list().filter((m) => m.fromKind === 'human'),
    ).toHaveLength(1);
  });
  it('R-19 the same conversation reuses one session key and retains an ordered reply trail', async () => {
    const s = await start();
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    await s.channel.receive({
      ...inbound,
      externalEventId: 'Ev2',
      text: 'Again',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.inputs).toHaveLength(2);
    expect(s.inputs[0]).toMatch(/^chat:/);
    expect(new Set(s.inputs).size).toBe(1);
    expect(s.channel.messages.map((m) => m.text)).toEqual([
      'First reply.',
      'Second reply.',
    ]);
  });
  it('R-18 UI test chat accepts validated input and persists a completed response', async () => {
    const s = await setup();
    const app = buildApp(s);
    cleanups.push(() => app.close());
    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/chat`,
      payload: { text: 'Hello from UI' },
    });
    expect(result.statusCode).toBe(202);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.messages.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'ui',
          fromKind: 'human',
          content: 'Hello from UI',
        }),
        expect.objectContaining({
          channel: 'ui',
          fromKind: 'agent',
          content: 'First reply.',
        }),
      ]),
    );
    const bad = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/chat`,
      payload: { text: '' },
    });
    expect(bad.statusCode).toBe(400);
  });
  it('R-18 guardrail rejection makes no runtime call or Slack placeholder and publishes the failed run', async () => {
    const s = await start();
    const agents = createAgentsRepository(s.db);
    const agent = agents.get(agentId);
    if (!agent) throw new Error('missing_agent');
    agents.update({
      ...agent,
      guardrails: { ...agent.guardrails, runCostCapUsd: 0 },
    });
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.inputs).toHaveLength(0);
    expect(s.channel.messages).toHaveLength(0);
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.updated',
          data: expect.objectContaining({ status: 'failed' }),
        }),
      ]),
    );
    expect(s.messages.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromKind: 'human', status: 'acked' }),
      ]),
    );
  });
  it('R-18/R-23 failed Slack delivery preserves the reply and emits a visible log without repeating the turn', async () => {
    const s = await start();
    s.channel.updateMessage = async () => {
      throw new Error('slack_offline');
    };
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.inputs).toHaveLength(1);
    expect(s.messages.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromKind: 'agent',
          content: 'First reply.',
          status: 'acked',
        }),
      ]),
    );
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          data: expect.objectContaining({ event: 'channel_delivery_failed' }),
        }),
      ]),
    );
  });
  it('R-18 disabling and reenabling the Slack binding reloads connection and ignores messages while disabled', async () => {
    const s = await start();
    const config = createConfigurationRepository(s.db);
    config.setChannel(agentId, {
      type: 'slack',
      enabled: false,
      config: { respondTo: 'dm_and_mentions' },
    });
    await s.chat.reload();
    expect(s.channel.status().connected).toBe(false);
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.messages.list()).toHaveLength(0);
    config.setChannel(agentId, {
      type: 'slack',
      enabled: true,
      config: { respondTo: 'dm_and_mentions' },
    });
    await s.chat.reload();
    expect(s.channel.status().connected).toBe(true);
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.inputs).toHaveLength(1);
  });
  it('R-19 chat compiles personality, memory, skills and tools using the bound agent configuration', async () => {
    const s = await start();
    const config = createConfigurationRepository(s.db);
    config.addMemory(agentId, { fact: 'Prefers concise explanations.' });
    const skill = config.createSkill({
      name: 'Clarify',
      description: 'Clarifying questions',
      stepsMd: 'Ask one question first.',
    });
    config.setAgentSkills(agentId, [skill.id]);
    const agents = createAgentsRepository(s.db);
    const agent = agents.get(agentId);
    if (!agent) throw new Error('missing_agent');
    agents.update({
      ...agent,
      tools: { ...agent.tools, webfetch: true },
      permissions: { ...agent.permissions, webfetch: 'allow' },
    });
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.turnInputs).toHaveLength(1);
    expect(s.turnInputs[0]?.agent.systemPrompt).toContain('Be warm.');
    expect(s.turnInputs[0]?.agent.systemPrompt).toContain(
      'Prefers concise explanations.',
    );
    expect(s.turnInputs[0]?.agent.systemPrompt).toContain(
      'Ask one question first.',
    );
    expect(s.turnInputs[0]?.agent.tools.webfetch).toBe(true);
    expect(s.turnInputs[0]?.workspaceDir).toBe(
      join(s.dataDir, 'workspaces', 'agents', agentId),
    );
    expect(config.listMemories(agentId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ fact: 'Likes tea.' })]),
    );
  });
  it('R-18 UI conversation cannot be reused by a different agent or confused with a Slack conversation', async () => {
    const s = await setup();
    const otherId = '00000000-0000-4000-8000-000000000002';
    createAgentsRepository(s.db).insert(
      AgentSchema.parse({
        id: otherId,
        name: 'Other',
        role: 'helper',
        systemPrompt: 'Other.',
        status: 'idle',
        createdAt: 100000,
        updatedAt: 100000,
      }),
    );
    const app = buildApp(s);
    cleanups.push(() => app.close());
    const first = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/chat`,
      payload: { text: 'One' },
    });
    expect(first.statusCode).toBe(202);
    const body = first.json<{ conversationId: string }>();
    const denied = await app.inject({
      method: 'POST',
      url: `/api/agents/${otherId}/chat`,
      payload: { text: 'Steal', conversationId: body.conversationId },
    });
    expect(denied.statusCode).toBe(409);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.messages.list().some((m) => m.content === 'Steal')).toBe(false);
  });
  it('R-18 chat and workflow turns for one agent never overlap', async () => {
    const s = await start();
    let active = 0;
    let peak = 0;
    const runTurn = s.runtime.runTurn.bind(s.runtime);
    s.runtime.runTurn = async (input, onEvent, signal) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return await runTurn(input, onEvent, signal);
      } finally {
        active--;
      }
    };
    const workflowId = '00000000-0000-4000-8000-000000000003';
    s.engine.saveWorkflow({
      id: workflowId,
      name: 'One agent',
      description: '',
      templateId: null,
      createdAt: 100000,
      updatedAt: 100000,
      graph: {
        nodes: [
          { id: 'one', agentId, label: 'Chat agent', position: { x: 0, y: 0 } },
        ],
        edges: [],
        startNodeId: 'one',
        maxIterations: 1,
      },
    });
    const run = s.engine.startRun(workflowId, 'Workflow input');
    await s.channel.receive(inbound);
    await s.channel.receive({
      ...inbound,
      externalEventId: 'Ev2',
      text: 'Concurrent followup',
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(peak).toBe(1);
    expect(s.inputs).toHaveLength(3);
    expect(s.engine.detail(run.id)?.status).toBe('completed');
    expect(
      s.messages
        .list()
        .filter((m) => m.channel === 'slack' && m.fromKind === 'agent'),
    ).toHaveLength(2);
  });
  it('R-18 crash recovery reruns a persisted processing chat exactly once and keeps event dedupe', async () => {
    const s = await start();
    await s.channel.receive(inbound);
    await s.chat.stop();
    await s.engine.stop();
    const message = s.messages.list().find((m) => m.fromKind === 'human');
    if (!message) throw new Error('missing_message');
    s.messages.update({ ...message, status: 'processing' });
    const app = buildApp({ ...s, channel: s.channel });
    cleanups.push(() => app.close());
    await app.ready();
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.inputs).toHaveLength(1);
    expect(s.messages.get(message.id)?.status).toBe('acked');
    expect(
      s.messages.list().filter((m) => m.fromKind === 'human'),
    ).toHaveLength(1);
    expect(
      s.messages.list().filter((m) => m.fromKind === 'agent'),
    ).toHaveLength(1);
    expect(s.channel.messages.map((m) => m.text)).toEqual(['First reply.']);
  });
  it('R-18 cancellation during placeholder posting replaces the placeholder with a terminal reply and never runs the agent', async () => {
    const s = await start();
    const post = s.channel.postPlaceholder.bind(s.channel);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.channel.postPlaceholder = async (conversationId, text) => {
      await gate;
      return post(conversationId, text);
    };
    await s.channel.receive(inbound);
    await vi.advanceTimersByTimeAsync(100);
    const message = s.messages.list().find((m) => m.fromKind === 'human');
    if (!message?.runId || !release) throw new Error('missing_pending_chat');
    s.engine.cancelRun(message.runId);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.inputs).toHaveLength(0);
    expect(s.channel.messages).toHaveLength(1);
    expect(s.channel.messages[0]?.text).toContain('cancel');
    expect(s.channel.messages[0]?.text).not.toBe('thinking…');
  });
  it('R-18 disabled binding stops a disconnected adapter to cancel its reconnect lifecycle', async () => {
    const s = await start();
    const stop = s.channel.stop.bind(s.channel);
    let stopped = 0;
    s.channel.stop = async () => {
      stopped++;
      await stop();
    };
    s.channel.status = () => ({ connected: false });
    createConfigurationRepository(s.db).setChannel(agentId, {
      type: 'slack',
      enabled: false,
      config: { respondTo: 'dm_and_mentions' },
    });
    await s.chat.reload();
    expect(stopped).toBe(1);
  });
  it('R-18/R-23 publishes changed channel connection status and stops polling on shutdown', async () => {
    const s = await start();
    let connected = true;
    s.channel.status = () => ({ connected });
    await vi.advanceTimersByTimeAsync(1000);
    const count = () =>
      s.events.filter((event) => event.type === 'channel.status').length;
    const before = count();
    connected = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(count()).toBe(before + 1);
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'channel.status',
          data: expect.objectContaining({ connected: false }),
        }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(count()).toBe(before + 1);
    await s.chat.stop();
    const stoppedCount = count();
    connected = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(count()).toBe(stoppedCount);
  });
});

describe('T24 persisted human names (R-16/R-19/R-23)', () => {
  it('R-16/R-19/R-23 persists and emits the resolved Slack human sender name', async () => {
    const s = await start();
    await s.channel.receive({ ...inbound, userName: 'Taylor Clements' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.messages.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromKind: 'human',
          fromId: 'U1',
          fromName: 'Taylor Clements',
        }),
      ]),
    );
    expect(s.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message.created',
          data: expect.objectContaining({ fromName: 'Taylor Clements' }),
        }),
      ]),
    );
  });
  it('R-16/R-23 persists You (UI) as the UI human sender name', async () => {
    const s = await setup();
    const app = buildApp(s);
    cleanups.push(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/chat`,
      payload: { text: 'Hello' },
    });
    expect(response.statusCode).toBe(202);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.messages.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromKind: 'human',
          channel: 'ui',
          fromName: 'You (UI)',
        }),
      ]),
    );
  });
});
