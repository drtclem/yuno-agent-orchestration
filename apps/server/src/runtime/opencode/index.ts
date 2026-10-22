import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createOpencodeClient,
  type Event,
  type AssistantMessage,
  type Part,
  type PermissionRuleset,
} from '@opencode-ai/sdk/v2';
import type { AppDatabase } from '../../db/client.js';
import { createRuntimeSessionsRepository } from '../../db/repos/runtime-sessions.js';
import type { AgentRuntime, CompiledAgent, TurnResult } from '../types.js';

// API shapes and permission precedence: docs/spikes.md; pinned SDK's generated v2 client.
function policy(agent: CompiledAgent) {
  const effective = (tool: 'bash' | 'edit' | 'webfetch') =>
    agent.tools[tool] === false ? 'deny' : agent.permissions[tool];
  const permission = {
    '*': 'deny' as const,
    read: 'allow' as const,
    glob: 'allow' as const,
    grep: 'allow' as const,
    list: 'allow' as const,
    bash: {
      '*': effective('bash'),
      ...Object.fromEntries(
        agent.permissions.denyBash.map((pattern) => [pattern, 'deny' as const]),
      ),
    },
    edit: effective('edit'),
    webfetch: effective('webfetch'),
    external_directory: agent.permissions.deploymentDir
      ? {
          '*': 'deny' as const,
          [`${agent.permissions.deploymentDir}*`]: 'allow' as const,
        }
      : ('deny' as const),
  };
  const rules: PermissionRuleset = Object.entries(permission).flatMap(
    ([tool, value]) =>
      typeof value === 'string'
        ? [{ permission: tool, pattern: '*', action: value }]
        : Object.entries(value).map(([pattern, action]) => ({
            permission: tool,
            pattern,
            action,
          })),
  );
  return { permission, rules };
}

export function createOpenCodeRuntime({
  db,
  baseUrl,
  fetch: fetcher = globalThis.fetch,
}: {
  db: AppDatabase;
  baseUrl: string;
  fetch?: typeof fetch;
}): AgentRuntime {
  const sessions = createRuntimeSessionsRepository(db);
  const busyKeys = new Set<string>();
  const busyDirectories = new Set<string>();
  const pending = new Map<string, { sessionId: string; directory: string }>();
  const control = createOpencodeClient({ baseUrl, fetch: fetcher });
  return {
    async health() {
      try {
        const { data } = await control.global.health({
          signal: AbortSignal.timeout(5000),
          throwOnError: true,
        });
        return { ok: data.healthy, version: data.version };
      } catch {
        return { ok: false };
      }
    },
    async respondPermission(sessionId, permissionId, allow) {
      const request = pending.get(permissionId);
      if (!request || request.sessionId !== sessionId)
        throw new Error('Unknown runtime permission');
      const { data } = await control.permission.reply(
        {
          requestID: permissionId,
          directory: request.directory,
          reply: allow ? 'once' : 'reject',
        },
        { signal: AbortSignal.timeout(5000), throwOnError: true },
      );
      if (!data) throw new Error('Runtime permission reply failed');
      pending.delete(permissionId);
    },
    // Callers construct workspaces beneath DATA_DIR/workspaces; tests use isolated temp directories.
    async runTurn(input, onEvent, signal) {
      signal.throwIfAborted();
      if (!isAbsolute(input.workspaceDir))
        throw new Error('Workspace must be absolute');
      const directory = resolve(input.workspaceDir);
      if (busyKeys.has(input.sessionKey) || busyDirectories.has(directory))
        throw new Error('Runtime workspace or session is busy');
      busyKeys.add(input.sessionKey);
      busyDirectories.add(directory);
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new Error('Runtime turn timed out')),
        input.agent.turnTimeoutMs,
      );
      const combined = AbortSignal.any([signal, deadline.signal]);
      const streamAbort = new AbortController();
      const streamSignal = AbortSignal.any([combined, streamAbort.signal]);
      let sessionId: string | undefined;
      let streamTask: Promise<void> | undefined;
      let finished = false;
      let abortFailed = false;
      const emittedTools = new Map<string, string>();
      const assistant = new Map<string, AssistantMessage>();
      const tools = new Map<string, TurnResult['toolCalls'][number]>();
      const totals = () =>
        [...assistant.values()].reduce(
          (sum, message) => ({
            inputTokens: sum.inputTokens + message.tokens.input,
            outputTokens: sum.outputTokens + message.tokens.output,
            costUsd: sum.costUsd + message.cost,
          }),
          { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        );
      try {
        const { permission, rules } = policy(input.agent);
        await mkdir(directory, { recursive: true });
        if (input.agent.permissions.deploymentDir)
          await mkdir(input.agent.permissions.deploymentDir, {
            recursive: true,
          });
        await writeFile(
          join(directory, 'opencode.json'),
          JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            permission,
            share: 'disabled',
            autoupdate: false,
          }),
        );
        combined.throwIfAborted();
        let readyResolve: (() => void) | undefined;
        let readyReject: ((reason: unknown) => void) | undefined;
        const ready = new Promise<void>((resolveReady, rejectReady) => {
          readyResolve = resolveReady;
          readyReject = rejectReady;
        });
        const client = createOpencodeClient({
          baseUrl,
          fetch: async (request, init) => {
            const response = await fetcher(request, init);
            const url = new URL(
              request instanceof Request ? request.url : request.toString(),
            );
            if (url.pathname === '/event' && response.ok) readyResolve?.();
            return response;
          },
        });
        const options = { signal: combined, throwOnError: true as const };
        const saved = sessions.get(input.sessionKey);
        if (saved && saved.agentId !== input.agent.agentId)
          throw new Error('Runtime session agent mismatch');
        if (saved) {
          sessionId = saved.runtimeSessionId;
          await client.session.update(
            { sessionID: sessionId, directory, permission: rules },
            options,
          );
        } else {
          const { data } = await client.session.create(
            { directory, permission: rules },
            options,
          );
          sessionId = data.id;
          sessions.save({
            sessionKey: input.sessionKey,
            runtimeSessionId: sessionId,
            agentId: input.agent.agentId,
            createdAt: Date.now(),
          });
        }
        const location = { sessionID: sessionId, directory };
        const { data: history } = await client.session.messages(
          location,
          options,
        );
        const oldIds = new Set(history.map((message) => message.info.id));
        const update = (info: AssistantMessage) => {
          if (info.sessionID !== sessionId || oldIds.has(info.id)) return;
          if (info.error) throw new Error('Runtime assistant failed');
          assistant.set(info.id, info);
          onEvent({ type: 'usage', ...totals() });
        };
        const part = (value: Part) => {
          if (
            value.sessionID !== sessionId ||
            oldIds.has(value.messageID) ||
            value.type !== 'tool'
          )
            return;
          const status = value.state.status;
          if (status === 'pending' || emittedTools.get(value.callID) === status)
            return;
          emittedTools.set(value.callID, status);
          onEvent({
            type: 'tool',
            tool: value.tool,
            status:
              status === 'running'
                ? 'started'
                : status === 'error'
                  ? 'failed'
                  : 'completed',
            ...('title' in value.state ? { title: value.state.title } : {}),
          });
          if (status !== 'running')
            tools.set(value.callID, {
              tool: value.tool,
              status: status === 'error' ? 'failed' : 'completed',
            });
        };
        let idle = false;
        let idleResolve: (() => void) | undefined;
        const event = (value: Event) => {
          if (
            (value.type === 'session.idle' &&
              value.properties.sessionID === sessionId) ||
            (value.type === 'session.status' &&
              value.properties.sessionID === sessionId &&
              value.properties.status.type === 'idle')
          ) {
            idle = true;
            idleResolve?.();
          }
          if (
            value.type === 'message.updated' &&
            value.properties.info.role === 'assistant'
          )
            update(value.properties.info);
          if (value.type === 'message.part.updated')
            part(value.properties.part);
          if (
            value.type === 'session.error' &&
            value.properties.sessionID === sessionId
          )
            throw new Error('Runtime session failed');
          if (
            value.type === 'permission.asked' &&
            value.properties.sessionID === sessionId
          ) {
            const request = value.properties;
            pending.set(request.id, { sessionId, directory });
            onEvent({
              type: 'permission_request',
              permissionId: request.id,
              sessionId,
              tool: request.permission,
              detail: request.patterns.join(', '),
            });
          }
        };
        const subscription = await client.event.subscribe(
          { directory },
          {
            signal: streamSignal,
            sseMaxRetryAttempts: 1,
            onSseError: () =>
              deadline.abort(new Error('Runtime event stream failed')),
          },
        );
        streamTask = (async () => {
          try {
            for await (const value of subscription.stream) event(value);
            readyReject?.(new Error('Runtime event stream disconnected'));
            if (!finished && !streamSignal.aborted)
              throw new Error('Runtime event stream disconnected');
          } catch (error) {
            readyReject?.(error);
            if (!finished && !combined.aborted)
              deadline.abort(new Error('Runtime event stream failed'));
          }
        })();
        await ready;
        const { data: response } = await client.session.prompt(
          {
            ...location,
            system: input.agent.systemPrompt,
            model: input.agent.model,
            parts: [{ type: 'text', text: input.prompt }],
          },
          options,
        );
        update(response.info);
        response.parts.forEach(part);
        if (!idle) {
          await new Promise<void>((resolveIdle, rejectIdle) => {
            const abort = () =>
              rejectIdle(new Error('Runtime turn interrupted'));
            idleResolve = () => {
              combined.removeEventListener('abort', abort);
              resolveIdle();
            };
            combined.addEventListener('abort', abort, { once: true });
            if (combined.aborted) abort();
          });
        }
        const { data: messages } = await client.session.messages(
          location,
          options,
        );
        for (const message of messages) {
          if (message.info.role === 'assistant') update(message.info);
          message.parts.forEach(part);
        }
        combined.throwIfAborted();
        return {
          text: response.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n'),
          sessionId,
          ...totals(),
          toolCalls: [...tools.values()],
        };
      } catch {
        if (sessionId) {
          try {
            const { data: aborted } = await control.session.abort(
              { sessionID: sessionId, directory },
              { signal: AbortSignal.timeout(5000), throwOnError: true },
            );
            if (!aborted) throw new Error('Runtime abort refused');
          } catch {
            abortFailed = true;
            onEvent({
              type: 'log',
              level: 'error',
              text: 'Runtime abort failed',
            });
          }
        }
        const reason = signal.aborted
          ? 'Runtime turn aborted'
          : deadline.signal.aborted
            ? 'Runtime turn timed out or event stream failed'
            : 'Runtime turn failed';
        onEvent({ type: 'log', level: 'error', text: reason });
        throw new Error(reason);
      } finally {
        finished = true;
        clearTimeout(timer);
        streamAbort.abort();
        // Do not wait on an uncooperative HTTP implementation after cancellation.
        void streamTask;
        for (const [id, request] of pending)
          if (request.sessionId === sessionId) pending.delete(id);
        // Failed aborts keep the workspace quarantined: remote work may still be running.
        if (!abortFailed) {
          busyKeys.delete(input.sessionKey);
          busyDirectories.delete(directory);
        }
      }
    },
  };
}
