import type { AgentRuntime, RuntimeEvent, TurnResult } from '../types.js';

type Usage = Pick<TurnResult, 'inputTokens' | 'outputTokens' | 'costUsd'>;
export interface FakeTurn {
  text?: string;
  delayMs?: number;
  error?: string;
  usage?: Usage;
  events?: readonly RuntimeEvent[];
}
export interface FakeRuntimeOptions {
  roles?: Readonly<Record<string, string>>;
  scripts?: Readonly<Record<string, readonly FakeTurn[]>>;
  delayMs?: number;
  usage?: Usage;
}

export function createFakeRuntime(
  options: FakeRuntimeOptions = {},
): AgentRuntime {
  const sessions = new Map<string, { id: string; turns: number }>();
  return {
    async health() {
      return { ok: true, version: 'fake' };
    },
    async runTurn(input, onEvent, signal) {
      signal.throwIfAborted();
      let session = sessions.get(input.sessionKey);
      if (!session) {
        session = { id: `fake:${sessions.size + 1}`, turns: 0 };
        sessions.set(input.sessionKey, session);
      }
      const iteration = session.turns++;
      const step = options.scripts?.[input.agent.agentId]?.[iteration];
      const delay = step?.delayMs ?? options.delayMs ?? 0;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(work);
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const work = setTimeout(() => {
          cleanup();
          resolve();
        }, delay);
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('turn_timeout'));
        }, input.agent.turnTimeoutMs);
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      if (step?.error !== undefined) throw new Error(step.error);
      const toolCalls: TurnResult['toolCalls'] = [];
      let usage = options.usage ?? {
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      };
      for (const event of step?.events ?? []) {
        signal.throwIfAborted();
        onEvent(event);
        if (event.type === 'usage') usage = event;
        if (event.type === 'tool' && event.status !== 'started') {
          toolCalls.push({ tool: event.tool, status: event.status });
        }
      }
      usage = step?.usage ?? usage;
      signal.throwIfAborted();
      onEvent({ type: 'usage', ...usage });
      signal.throwIfAborted();
      const role =
        options.roles?.[input.agent.agentId]?.toLowerCase() ??
        input.agent.name.toLowerCase();
      const text =
        role === 'reviewer' || role === 'editor'
          ? iteration === 0
            ? 'Please revise the output.\nVERDICT: REJECTED'
            : 'The revisions are approved.\nVERDICT: APPROVED'
          : `${input.agent.name} completed the task.`;
      return {
        text: step?.text ?? text,
        sessionId: session.id,
        ...usage,
        toolCalls,
      };
    },
    async respondPermission() {
      throw new Error('unknown_permission');
    },
  };
}
