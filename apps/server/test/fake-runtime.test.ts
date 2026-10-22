import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import type { RuntimeEvent, TurnInput } from '../src/runtime/types.js';

const input: TurnInput = {
  agent: {
    agentId: 'reviewer',
    name: 'Reviewer',
    systemPrompt: 'Review',
    model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
    tools: { bash: false, edit: false, webfetch: false },
    permissions: { bash: 'deny', edit: 'deny', webfetch: 'deny', denyBash: [] },
    turnTimeoutMs: 1000,
  },
  sessionKey: 'run:one:node:reviewer',
  workspaceDir: '/tmp/yuno-test',
  prompt: 'Review changes',
};
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe('T6 fake runtime seam (R-04, R-05, R-09)', () => {
  it('R-09 reviewer rejects then approves, reuses a session and starts distinct sessions independently', async () => {
    const runtime = createFakeRuntime({ roles: { reviewer: 'ReViEwEr' } });
    const events: RuntimeEvent[] = [];
    const first = await runtime.runTurn(
      input,
      (event) => events.push(event),
      signal(),
    );
    const second = await runtime.runTurn(
      input,
      (event) => events.push(event),
      signal(),
    );
    const other = await runtime.runTurn(
      { ...input, sessionKey: 'run:two:node:reviewer' },
      () => undefined,
      signal(),
    );
    expect(first.text).toContain('VERDICT: REJECTED');
    expect(second.text).toContain('VERDICT: APPROVED');
    expect(other.text).toContain('VERDICT: REJECTED');
    expect(second.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(first).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      toolCalls: [],
    });
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    expect(await runtime.health()).toMatchObject({ ok: true });
  });

  it.each([
    ['Reviewer', undefined, true],
    ['Editor', undefined, true],
    ['Reviewer', 'coder', false],
    ['Custom checker', 'ReViEwEr', true],
  ] as const)(
    'R-13 default name %s and role override %s preserve explicit role precedence',
    async (name, role, reviews) => {
      const runtime = createFakeRuntime(
        role === undefined ? {} : { roles: { reviewer: role } },
      );
      const turn = { ...input, agent: { ...input.agent, name } };
      const first = await runtime.runTurn(turn, () => undefined, signal());
      const second = await runtime.runTurn(turn, () => undefined, signal());
      if (reviews) {
        expect(first.text).toContain('VERDICT: REJECTED');
        expect(second.text).toContain('VERDICT: APPROVED');
      } else {
        expect(first.text).toBe(`${name} completed the task.`);
        expect(second.text).toBe(`${name} completed the task.`);
      }
    },
  );

  it('R-09 scripted failures advance to the next step and configured usage and tool events reach the caller', async () => {
    const tool: RuntimeEvent = {
      type: 'tool',
      tool: 'edit',
      status: 'completed',
    };
    const usage = { inputTokens: 42, outputTokens: 19, costUsd: 0.12 };
    const runtime = createFakeRuntime({
      scripts: {
        reviewer: [
          { error: 'temporary failure' },
          { text: 'Done 🌍', usage, events: [tool] },
        ],
      },
    });
    await expect(
      runtime.runTurn(input, () => undefined, signal()),
    ).rejects.toThrow('temporary failure');
    const events: RuntimeEvent[] = [];
    expect(
      await runtime.runTurn(input, (event) => events.push(event), signal()),
    ).toMatchObject({
      text: 'Done 🌍',
      ...usage,
      toolCalls: [{ tool: 'edit', status: 'completed' }],
    });
    expect(events).toEqual([tool, { type: 'usage', ...usage }]);
    const independent = runtime.runTurn(
      { ...input, sessionKey: 'other' },
      () => undefined,
      signal(),
    );
    await expect(independent).rejects.toThrow('temporary failure');
  });

  it('R-09 configurable delay and usage are deterministic with fake time', async () => {
    vi.useFakeTimers();
    const usage = { inputTokens: 3, outputTokens: 2, costUsd: 0.02 };
    const runtime = createFakeRuntime({ delayMs: 100, usage });
    const events: RuntimeEvent[] = [];
    const turn = runtime.runTurn(
      input,
      (event) => events.push(event),
      signal(),
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await turn).toMatchObject(usage);
    expect(events).toEqual([{ type: 'usage', ...usage }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('R-09 abort mid-turn rejects without delayed events or leaked timers', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime({ delayMs: 100 });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const turn = runtime.runTurn(
      input,
      (event) => events.push(event),
      controller.signal,
    );
    const rejected = expect(turn).rejects.toThrow(/abort/i);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('R-09 pre-aborted signal and turn timeout reject without events', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime({ delayMs: 2000 });
    const events: RuntimeEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.runTurn(input, (event) => events.push(event), controller.signal),
    ).rejects.toThrow(/abort/i);
    const turn = runtime.runTurn(
      input,
      (event) => events.push(event),
      signal(),
    );
    const rejected = expect(turn).rejects.toThrow(/timeout|timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
