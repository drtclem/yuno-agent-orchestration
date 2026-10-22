import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSchema,
  MessageSchema,
  type Log,
  type SSEEvent,
} from '@yuno/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import { createEventHub } from '../src/events/hub.js';
import { createAgentStatusService } from '../src/domain/agent-status.js';

const id = '00000000-0000-4000-8000-000000000001';
const log: Log = {
  id,
  ts: 123,
  level: 'info',
  agentId: null,
  runId: null,
  event: 'turn.completed',
  data: { durationMs: 42, status: 'completed', cached: false, error: null },
};
const status: SSEEvent = {
  type: 'agent.status',
  ts: 123,
  data: { agentId: id, status: 'working' },
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const database = openDatabase(':memory:');
  cleanups.push(() => {
    database.close();
  });
  const logs = createLogsRepository(database.db);
  const hub = createEventHub(logs);
  return { database, logs, hub };
}
async function connect() {
  const state = setup();
  const app = buildApp({ db: state.database.db, hub: state.hub });
  cleanups.push(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/events`, {
    signal: controller.signal,
  });
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  cleanups.push(async () => {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
  const decoder = new TextDecoder();
  let text = '';
  async function readUntil(needle: string) {
    while (!text.includes(needle)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE ended before ${needle}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  }
  await readUntil(': connected\n\n');
  return { ...state, app, response, reader, controller, readUntil };
}

describe('T5 event hub and SSE (R-21, R-22, R-23, R-29)', () => {
  it('R-21 R-29 a published event reaches a connected SSE client and disconnect removes the client', async () => {
    const { hub, response, controller, readUntil } = await connect();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(hub.subscriberCount).toBe(1);
    hub.publish(status);
    expect(await readUntil(`data: ${JSON.stringify(status)}\n\n`)).toContain(
      JSON.stringify(status),
    );
    controller.abort();
    await vi.waitFor(() => expect(hub.subscriberCount).toBe(0));
  });

  it('R-22 logs are persisted before delivery and survive unsubscribing', () => {
    const { hub, logs } = setup();
    const observed: unknown[] = [];
    const unsubscribe = hub.subscribe(() => observed.push(logs.get(log.id)));
    hub.publish({ type: 'log', ts: log.ts, data: log });
    expect(observed).toEqual([log]);
    expect(logs.list()).toEqual([log]);
    unsubscribe();
    unsubscribe();
    expect(hub.subscriberCount).toBe(0);
    expect(logs.get(log.id)).toEqual(log);
  });

  it('R-22 R-29 invalid events are neither persisted nor delivered; persistence failure prevents delivery', () => {
    const { hub, logs } = setup();
    const delivered: SSEEvent[] = [];
    hub.subscribe((event) => delivered.push(event));
    expect(() =>
      hub.publish({ ...status, data: {} } as unknown as SSEEvent),
    ).toThrow();
    expect(logs.list()).toEqual([]);
    hub.publish({ type: 'log', ts: log.ts, data: log });
    expect(() => hub.publish({ type: 'log', ts: log.ts, data: log })).toThrow();
    expect(logs.list()).toEqual([log]);
    expect(delivered).toHaveLength(1);
  });

  it('R-29 isolates a failing subscriber and removes it while healthy clients keep receiving', () => {
    const { hub } = setup();
    hub.subscribe(() => {
      throw new Error('client disconnected');
    });
    const delivered: SSEEvent[] = [];
    hub.subscribe((event) => delivered.push(event));
    hub.publish(status);
    hub.publish(status);
    expect(delivered).toEqual([status, status]);
    expect(hub.subscriberCount).toBe(1);
  });

  it('R-23 R-29 streams message events with Unicode and long content intact', async () => {
    const { hub, readUntil } = await connect();
    const event: SSEEvent = {
      type: 'message.created',
      ts: 123,
      data: MessageSchema.parse({
        id,
        runId: null,
        conversationId: null,
        fromKind: 'human',
        fromId: 'owner',
        toAgentId: id,
        channel: 'ui',
        content: 'Hello 🌍\n'.repeat(10000),
        verdict: null,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 123,
        idempotencyKey: 'ui:one',
        error: null,
        createdAt: 123,
        updatedAt: 123,
      }),
    };
    hub.publish(event);
    const received = await readUntil(`data: ${JSON.stringify(event)}\n\n`);
    expect(received).toContain(`data: ${JSON.stringify(event)}\n\n`);
  });

  it('R-29 sends a heartbeat every 15 seconds and shutdown removes clients and timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, hub, readUntil, reader } = await connect();
    const count = vi.getTimerCount();
    expect(count).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await readUntil(': heartbeat\n\n')).toContain(': heartbeat\n\n');
    await app.close();
    expect(hub.subscriberCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('R-21 status changes persist and emit only real changes; missing agents emit nothing', () => {
    const { database, hub } = setup();
    const agents = createAgentsRepository(database.db);
    const agent = AgentSchema.parse({
      id,
      name: 'Writer',
      role: 'Writer',
      systemPrompt: 'Write',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    });
    agents.insert(agent);
    const service = createAgentStatusService(database.db, hub);
    const observed: SSEEvent[] = [];
    hub.subscribe((event) => {
      expect(agents.get(id)?.status).toBe('working');
      observed.push(event);
    });
    expect(service.setStatus(id, 'working')).toMatchObject({
      id,
      status: 'working',
    });
    expect(agents.get(id)?.status).toBe('working');
    service.setStatus(id, 'working');
    expect(
      service.setStatus('00000000-0000-4000-8000-000000000099', 'working'),
    ).toBeUndefined();
    expect(observed).toEqual([
      {
        type: 'agent.status',
        ts: expect.any(Number),
        data: { agentId: id, status: 'working' },
      },
    ]);
  });
});
