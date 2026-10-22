import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSchema } from '@yuno/shared';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { runtimeSessions } from '../src/db/schema.js';
import { createOpenCodeRuntime } from '../src/runtime/opencode/index.js';
import type { RuntimeEvent, TurnInput } from '../src/runtime/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(
  hang = false,
  failure?: 'assistant' | 'session' | 'stream' | 'abort-throw' | 'abort-false',
) {
  const database = openDatabase(':memory:');
  cleanups.push(database.close);
  const workspaceDir = mkdtempSync(join(tmpdir(), 'yuno-opencode-test-'));
  cleanups.push(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const agent = AgentSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Writer',
    role: 'Writer',
    systemPrompt: 'Write',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  });
  createAgentsRepository(database.db).insert(agent);
  const input: TurnInput = {
    agent: {
      agentId: agent.id,
      name: agent.name,
      systemPrompt: 'Write safely',
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      tools: { bash: true, edit: true, webfetch: false },
      permissions: {
        bash: 'ask',
        edit: 'allow',
        webfetch: 'deny',
        denyBash: ['rm *'],
      },
      turnTimeoutMs: 1000,
    },
    sessionKey: 'chat:test',
    workspaceDir,
    prompt: 'Hello 🌍',
  };
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const info = (id: string, inputTokens: number) => ({
    id,
    sessionID: 'ses_1',
    role: 'assistant',
    cost: inputTokens / 1000,
    tokens: {
      input: inputTokens,
      output: 2,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  });
  const emit = (type: string, properties: object) =>
    stream?.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type, properties })}\n\n`,
      ),
    );
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(
      request instanceof Request ? request.url : request.toString(),
    );
    const raw =
      init?.body ?? (request instanceof Request ? await request.text() : '');
    const body =
      typeof raw === 'string' && raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    calls.push({ url, body });
    if (url.pathname === '/global/health')
      return Response.json({ healthy: true, version: '1.19.3' });
    if (url.pathname === '/event')
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    if (url.pathname === '/session/ses_1')
      return Response.json({ id: 'ses_1' });
    if (url.pathname === '/session') return Response.json({ id: 'ses_1' });
    if (url.pathname.endsWith('/abort') && failure === 'abort-throw')
      throw new Error('abort unavailable');
    if (url.pathname.endsWith('/abort') && failure === 'abort-false')
      return Response.json(false);
    if (url.pathname.endsWith('/abort') || url.pathname.endsWith('/reply'))
      return Response.json(true);
    if (
      url.pathname.endsWith('/message') &&
      (init?.method ??
        (request instanceof Request ? request.method : 'GET')) === 'GET'
    )
      return Response.json([{ info: info('old_assistant', 900), parts: [] }]);
    if (url.pathname.endsWith('/message')) {
      if (hang)
        return new Promise((_resolve, reject) => {
          const signal =
            init?.signal ??
            (request instanceof Request ? request.signal : undefined);
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      if (failure === 'stream') {
        stream?.error(new Error('stream disconnected'));
        return new Promise((_resolve, reject) => {
          const signal =
            init?.signal ??
            (request instanceof Request ? request.signal : undefined);
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
      if (failure === 'session')
        emit('session.error', {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: { message: 'session exploded' },
          },
        });
      emit('message.updated', { info: info('old_assistant', 900) });
      emit('message.updated', { info: info('msg_a', 5) });
      emit('message.updated', { info: info('msg_a', 10) });
      emit('message.part.updated', {
        part: {
          id: 'part_1',
          sessionID: 'ses_1',
          messageID: 'msg_a',
          type: 'tool',
          tool: 'apply_patch',
          callID: 'call_1',
          state: { status: 'completed', title: 'Write file' },
        },
      });
      emit('permission.asked', {
        id: 'per_1',
        sessionID: 'ses_1',
        permission: 'bash',
        patterns: ['printf hello'],
        metadata: {},
      });
      emit('message.updated', { info: info('msg_b', 20) });
      emit('session.idle', { sessionID: 'ses_1' });
      return Response.json({
        info: {
          ...info('msg_b', 20),
          ...(failure === 'assistant'
            ? {
                error: {
                  name: 'UnknownError',
                  data: { message: 'assistant exploded' },
                },
              }
            : {}),
        },
        parts: [
          { type: 'text', text: 'Done 🌍' },
          {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_a',
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call_1',
            state: { status: 'completed', title: 'Write file' },
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  return {
    database,
    input,
    calls,
    runtime: createOpenCodeRuntime({
      db: database.db,
      baseUrl: 'http://opencode.test',
      fetch: fetcher,
    }),
  };
}

describe('T7 OpenCode mocked HTTP (R-26, R-09)', () => {
  it('R-26 maps tool and permission events and deduplicates per-message usage totals', async () => {
    const { runtime, input } = fixture();
    const events: RuntimeEvent[] = [];
    const result = await runtime.runTurn(
      input,
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      text: 'Done 🌍',
      inputTokens: 30,
      outputTokens: 4,
      costUsd: 0.03,
      toolCalls: [{ tool: 'apply_patch', status: 'completed' }],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: 'apply_patch',
        status: 'completed',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission_request',
        sessionId: 'ses_1',
        permissionId: 'per_1',
        tool: 'bash',
      }),
    );
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 30,
      outputTokens: 4,
      costUsd: 0.03,
    });
  });
  it('R-26 persists session reuse while resetting usage for each turn', async () => {
    const { runtime, database, input, calls } = fixture();
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    const next = await runtime.runTurn(
      input,
      () => undefined,
      new AbortController().signal,
    );
    expect(
      calls.filter((call) => call.url.pathname === '/session'),
    ).toHaveLength(1);
    expect(database.db.select().from(runtimeSessions).all()).toEqual([
      expect.objectContaining({
        sessionKey: input.sessionKey,
        runtimeSessionId: 'ses_1',
      }),
    ]);
    expect(next.inputTokens).toBe(30);
  });
  it('R-09 T22 revokes a deployment policy when reusing an existing session', async () => {
    const { runtime, input, calls } = fixture();
    const deploymentDir =
      join(input.workspaceDir, 'deployments', 'run-99') + '/';
    input.agent.permissions.deploymentDir = deploymentDir;
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    delete input.agent.permissions.deploymentDir;
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    const config = JSON.parse(
      readFileSync(join(input.workspaceDir, 'opencode.json'), 'utf8'),
    ) as { permission: { external_directory: unknown } };
    expect(config.permission.external_directory).toBe('deny');
    expect(
      calls.filter((call) => call.url.pathname === '/session'),
    ).toHaveLength(1);
  });

  it('R-09 T22 denies outside-workspace access without a deploy grant', async () => {
    const { runtime, input } = fixture();
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    const config = JSON.parse(
      readFileSync(join(input.workspaceDir, 'opencode.json'), 'utf8'),
    ) as { permission: { external_directory: unknown } };
    expect(config.permission.external_directory).toBe('deny');
  });

  it('R-09 R-27 T22 allows only the granted deployment directory and denies every other external directory', async () => {
    const { runtime, input } = fixture();
    const deploymentDir =
      join(input.workspaceDir, 'deployments', 'run-99') + '/';
    input.agent.permissions.deploymentDir = deploymentDir;
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    const config = JSON.parse(
      readFileSync(join(input.workspaceDir, 'opencode.json'), 'utf8'),
    ) as { permission: { external_directory: unknown } };
    expect(config.permission.external_directory).toEqual({
      '*': 'deny',
      [`${deploymentDir}*`]: 'allow',
    });
    expect(existsSync(deploymentDir)).toBe(true);
  });

  it('R-09 preserves ask and denied commands, omits unsafe tools map, and scopes every request', async () => {
    const { runtime, input, calls } = fixture();
    await runtime.runTurn(input, () => undefined, new AbortController().signal);
    const config = JSON.parse(
      readFileSync(join(input.workspaceDir, 'opencode.json'), 'utf8'),
    ) as { permission: object };
    expect(config.permission).toMatchObject({
      bash: { '*': 'ask', 'rm *': 'deny' },
      edit: 'allow',
      webfetch: 'deny',
    });
    const message = calls.find(
      (call) => call.url.pathname.endsWith('/message') && 'parts' in call.body,
    );
    expect(message?.body).toMatchObject({
      model: input.agent.model,
      system: input.agent.systemPrompt,
      parts: [{ type: 'text', text: input.prompt }],
    });
    expect(message?.body).not.toHaveProperty('tools');
    expect(
      calls.every(
        (call) => call.url.searchParams.get('directory') === input.workspaceDir,
      ),
    ).toBe(true);
    for (const allow of [true, false]) {
      const replies: Promise<void>[] = [];
      await runtime.runTurn(
        input,
        (event) => {
          if (event.type === 'permission_request')
            replies.push(
              runtime.respondPermission(
                event.sessionId,
                event.permissionId,
                allow,
              ),
            );
        },
        new AbortController().signal,
      );
      await Promise.all(replies);
    }
    expect(
      calls
        .filter((call) => call.url.pathname === '/permission/per_1/reply')
        .map((call) => call.body),
    ).toEqual([{ reply: 'once' }, { reply: 'reject' }]);
    expect(await runtime.health()).toEqual({ ok: true, version: '1.19.3' });
  });
  it('R-26 turn timeout calls the server abort endpoint and rejects visibly', async () => {
    const { runtime, input, calls } = fixture(true);
    input.agent.turnTimeoutMs = 20;
    await expect(
      runtime.runTurn(input, () => undefined, new AbortController().signal),
    ).rejects.toThrow();
    expect(
      calls.some((call) => call.url.pathname === '/session/ses_1/abort'),
    ).toBe(true);
  });
  it('R-26 caller cancellation calls the server abort endpoint and rejects visibly', async () => {
    const { runtime, input, calls } = fixture(true);
    const controller = new AbortController();
    const promise = runtime.runTurn(input, () => undefined, controller.signal);
    const assertion = expect(promise).rejects.toThrow();
    await vi.waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.url.pathname.endsWith('/message') && 'parts' in call.body,
        ),
      ).toBe(true);
    });
    controller.abort();
    await assertion;
    expect(
      calls.some((call) => call.url.pathname === '/session/ses_1/abort'),
    ).toBe(true);
  });
  it('R-26 pre-aborted turns never submit a prompt', async () => {
    const { runtime, input, calls } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.runTurn(input, () => undefined, controller.signal),
    ).rejects.toThrow();
    expect(calls.filter((call) => 'parts' in call.body)).toHaveLength(0);
  });
  it.each(['assistant', 'session', 'stream'] as const)(
    'R-26 %s errors are visible failures even when HTTP succeeds',
    async (failure) => {
      const { runtime, input, calls } = fixture(false, failure);
      input.agent.turnTimeoutMs = 100;
      await expect(
        runtime.runTurn(input, () => undefined, new AbortController().signal),
      ).rejects.toThrow();
      expect(calls.filter((call) => 'parts' in call.body)).toHaveLength(1);
    },
  );
  it('R-26 emits each tool call status once across SSE and response reconciliation', async () => {
    const { runtime, input } = fixture();
    const events: RuntimeEvent[] = [];
    await runtime.runTurn(
      input,
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(
      events.filter(
        (event) =>
          event.type === 'tool' &&
          event.tool === 'apply_patch' &&
          event.status === 'completed',
      ),
    ).toHaveLength(1);
  });
  it.each(['abort-throw', 'abort-false'] as const)(
    'R-09 %s quarantines an unconfirmed stopped workspace before any next prompt or policy rewrite',
    async (failure) => {
      const { runtime, input, calls } = fixture(true, failure);
      input.agent.turnTimeoutMs = 20;
      await expect(
        runtime.runTurn(input, () => undefined, new AbortController().signal),
      ).rejects.toThrow();
      const originalPolicy = readFileSync(
        join(input.workspaceDir, 'opencode.json'),
        'utf8',
      );
      const promptCount = calls.filter((call) => 'parts' in call.body).length;
      const requestCount = calls.length;
      input.agent.permissions.bash = 'allow';
      await expect(
        runtime.runTurn(input, () => undefined, new AbortController().signal),
      ).rejects.toThrow();
      expect(calls.filter((call) => 'parts' in call.body)).toHaveLength(
        promptCount,
      );
      expect(calls).toHaveLength(requestCount);
      expect(
        readFileSync(join(input.workspaceDir, 'opencode.json'), 'utf8'),
      ).toBe(originalPolicy);
    },
  );
});
