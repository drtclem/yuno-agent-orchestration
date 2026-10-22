// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  AgentSchema,
  ALLOWED_MODELS,
  AGENT_DIMENSIONS,
  type Agent,
  type Memory,
  type Schedule,
  type Skill,
  type Message,
} from '@yuno/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';

const id = '00000000-0000-4000-8000-000000000001';
let agent: Agent;
let memories: Memory[];
let schedules: Schedule[];
let attached: Skill[];
let messages: Message[];
let chatFailure: boolean;
let runFailed: boolean;
let agentPresent: boolean;
let deleteConflict: boolean;
let rejectAgentWrite: boolean;
let dimensionsWait: Promise<void> | undefined;
let scheduleWriteWait: Promise<void> | undefined;
function chatRun() {
  return {
    id,
    workflowId: null,
    trigger: 'chat',
    input: 'Check this claim 🌍',
    status: runFailed ? 'failed' : 'completed',
    result: runFailed ? null : 'Primary sources checked ✓',
    error: runFailed ? 'turn_timeout' : null,
    startedAt: 0,
    finishedAt: 0,
    totalCostUsd: 0,
    totalTokens: 0,
  };
}
const conversationId = `ui:${id}:${id}`;
const skill: Skill = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Fact checking',
  description: 'Verify claims',
  stepsMd: 'Check primary sources',
  createdAt: 0,
};
let writes: { path: string; body: unknown }[];
class FakeEventSource {
  close() {}
}
beforeEach(() => {
  localStorage.clear();
  writes = [];
  memories = [];
  schedules = [];
  attached = [];
  messages = [];
  chatFailure = false;
  runFailed = false;
  agentPresent = true;
  deleteConflict = false;
  rejectAgentWrite = false;
  dimensionsWait = undefined;
  scheduleWriteWait = undefined;
  agent = AgentSchema.parse({
    id,
    name: 'Researcher',
    role: 'Research',
    systemPrompt: 'Find facts',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api', '');
      if (init?.method && init.method !== 'GET') {
        const body: unknown = init.body
          ? JSON.parse(String(init.body))
          : undefined;
        writes.push({ path, body });
        if (
          (path === '/agents' || path === `/agents/${id}`) &&
          rejectAgentWrite
        )
          return new Response(
            JSON.stringify({
              message: 'Validation failed',
              errors: [{ field: 'name', message: 'Name already taken' }],
            }),
            { status: 400 },
          );
        if (path === `/agents/${id}` && init.method === 'DELETE') {
          if (deleteConflict)
            return new Response(
              JSON.stringify({
                message: 'Agent is used by workflows',
                workflowNames: ['Dev pipeline'],
              }),
              { status: 409 },
            );
          agentPresent = false;
          return new Response(null, { status: 204 });
        }
        if (path === '/agents' && init.method === 'POST') {
          agent = AgentSchema.parse({ ...agent, ...Object(body) });
          return new Response(JSON.stringify(agent), { status: 201 });
        }
        if (path.endsWith('/chat')) {
          if (chatFailure)
            return new Response(JSON.stringify({ message: 'Unavailable' }), {
              status: 503,
            });
          messages = [
            {
              id,
              runId: id,
              conversationId,
              fromKind: 'agent',
              fromId: id,
              fromName: null,
              toAgentId: id,
              channel: 'ui',
              content: 'Primary sources checked ✓',
              verdict: null,
              status: 'acked',
              attempts: 1,
              nextAttemptAt: 0,
              idempotencyKey: 'reply',
              error: null,
              createdAt: 0,
              updatedAt: 0,
            },
          ];
          return new Response(
            JSON.stringify({
              conversationId,
              run: chatRun(),
            }),
          );
        }
        if (path.endsWith('/memories')) {
          const memory = {
            id,
            agentId: id,
            source: 'ui',
            createdAt: 0,
            ...Object(body),
          } as Memory;
          memories.push(memory);
          return new Response(JSON.stringify(memory));
        }
        if (path === `/agents/${id}/schedules/${id}` && init.method === 'PUT') {
          await scheduleWriteWait;
          const schedule = { ...schedules[0], ...Object(body) } as Schedule;
          schedules = [schedule];
          return new Response(JSON.stringify(schedule));
        }
        if (
          path === `/agents/${id}/schedules/${id}` &&
          init.method === 'DELETE'
        ) {
          schedules = [];
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/schedules')) {
          if (Object(body).kind === 'cron' && Object(body).expr === 'not cron')
            return new Response(
              JSON.stringify({
                message: 'Invalid cron expression',
              }),
              { status: 400 },
            );
          const schedule = {
            id,
            agentId: id,
            lastRunAt: null,
            nextRunAt: 60000,
            ...Object(body),
          } as Schedule;
          schedules.push(schedule);
          return new Response(JSON.stringify(schedule));
        }
        if (path === `/agents/${id}/skills`) {
          attached = [skill];
          return new Response(JSON.stringify(attached));
        }
        if (path.endsWith('/channels'))
          return new Response(
            JSON.stringify({ id, agentId: id, ...Object(body) }),
          );
        if (path === `/agents/${id}` && init.method === 'PUT')
          agent = AgentSchema.parse({ ...agent, ...Object(body) });
        return new Response(JSON.stringify(agent));
      }
      if (path.endsWith('/channels') && dimensionsWait) await dimensionsWait;
      if (path === `/runs/${id}`)
        return new Response(
          JSON.stringify({ ...chatRun(), steps: [], messages, approvals: [] }),
        );
      const data =
        path === '/health'
          ? {
              ok: true,
              runtime: { ok: true },
              slack: { connected: false, detail: 'not configured' },
            }
          : path.startsWith('/messages?')
            ? messages
            : path === '/models'
              ? ALLOWED_MODELS
              : path === '/skills'
                ? [skill]
                : path.endsWith('/memories')
                  ? memories
                  : path.endsWith('/schedules')
                    ? schedules
                    : path.endsWith('/skills')
                      ? attached
                      : path === '/agents'
                        ? agentPresent
                          ? [agent]
                          : []
                        : path === `/agents/${id}`
                          ? agent
                          : path.endsWith('/channels')
                            ? {
                                id,
                                agentId: id,
                                type: 'slack',
                                config: { respondTo: 'dm_and_mentions' },
                                enabled: true,
                              }
                            : [];
      return new Response(JSON.stringify(data));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function tab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('T16 agent editor (R-01, R-02, R-03, R-04, R-05, R-20)', () => {
  it('R-03 T22 labels cron input and schedule last/next times UTC', async () => {
    schedules = [
      {
        id,
        agentId: id,
        kind: 'cron',
        expr: '0 9 * * *',
        prompt: 'Daily check',
        workflowId: null,
        enabled: true,
        lastRunAt: 0,
        nextRunAt: 60000,
      },
    ];
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Schedules');
    fireEvent.change(await screen.findByLabelText('Schedule kind'), {
      target: { value: 'cron' },
    });
    expect(screen.getByLabelText('Schedule expression (UTC)')).toBeTruthy();
    expect(screen.getByText(/Last run:.*UTC.*Next run:.*UTC/)).toBeTruthy();
  });

  it('R-02 T22 displays an unavailable legacy model and allows choosing an approved replacement', async () => {
    agent = { ...agent, model: 'openai/gpt-5-2025-08-07' };
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    expect(
      screen.getByRole('option', { name: /unavailable.*pick another/i }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'openai/gpt-5.4-mini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agent.model).toBe('openai/gpt-5.4-mini'));
  });

  it('R-02 T22 shows the approved model pool labels and deployment toggle', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    expect(
      screen.getByRole('option', { name: /gpt-5-mini.*2.5M\/day pool/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('option', { name: /gpt-5.4 .*250K\/day pool/ }),
    ).toBeTruthy();
    tab('Tools & permissions');
    expect(
      screen.getByLabelText(
        "Can deploy (write to this run's deployments folder)",
      ),
    ).toBeTruthy();
  });

  it('R-03 T22 counts only valid positive integer timeout and rate settings', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    const summary = await screen.findByText(/\d+ set on this agent/);
    const setCount = () =>
      Number(summary.textContent?.match(/(\d+) set on this agent/)?.[1]);
    const initial = setCount();
    tab('Guardrails');
    for (const label of ['Turn timeout (ms)', 'Max turns per hour']) {
      for (const invalid of ['0', '1.5']) {
        change(label, invalid);
        expect(setCount()).toBe(initial - 1);
        change(label, '10');
        expect(setCount()).toBe(initial);
      }
    }
  });

  it('R-03 T22 counts every shared configurable dimension and updates the set count after adding memory', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    expect(
      await screen.findByText(
        new RegExp(`${AGENT_DIMENSIONS.length} configurable dimensions`),
      ),
    ).toBeTruthy();
    const before = await screen.findByText(/\d+ set on this agent/);
    const count = Number(
      before.textContent?.match(/(\d+) set on this agent/)?.[1],
    );
    tab('Memory');
    change('Memory fact', 'Remember this');
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    expect(
      await screen.findByText(new RegExp(`${count + 1} set on this agent`)),
    ).toBeTruthy();
  });

  it('R-01 R-02 edits and saves every writable agent schema field, then reloads persisted values', async () => {
    const view = mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    change('Name', 'Updated researcher');
    change('Role', 'Editor');
    change('System prompt', 'Check every fact');
    change('Model', ALLOWED_MODELS[1].id);
    tab('Tools & permissions');
    for (const tool of ['bash', 'edit', 'webfetch']) {
      fireEvent.click(screen.getByLabelText(`${tool} enabled`));
      change(`${tool} permission`, tool === 'webfetch' ? 'ask' : 'allow');
    }
    change('Blocked commands', 'rm -rf\nsudo');
    tab('Guardrails');
    change('Daily cost cap (USD)', '3');
    change('Run cost cap (USD)', '1');
    change('Max turns per hour', '12');
    change('Turn timeout (ms)', '45000');
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    await waitFor(() => expect(agent.name).toBe('Updated researcher'));
    expect(agent).toMatchObject({
      role: 'Editor',
      systemPrompt: 'Check every fact',
      model: ALLOWED_MODELS[1].id,
      tools: { bash: true, edit: true, webfetch: true },
      permissions: {
        bash: 'allow',
        edit: 'allow',
        webfetch: 'ask',
        denyBash: ['rm -rf', 'sudo'],
      },
      guardrails: {
        dailyCostCapUsd: 3,
        runCostCapUsd: 1,
        maxTurnsPerHour: 12,
        turnTimeoutMs: 45000,
      },
    });
    view.unmount();
    mount(`/agents/${id}`);
    expect(
      ((await screen.findByLabelText('Name')) as HTMLInputElement).value,
    ).toBe('Updated researcher');
    expect(screen.getByText(/configurable dimensions/i)).toBeTruthy();
  });

  it('R-01 R-02 shows schema validation beside fields and does not persist invalid input', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    change('Name', ' ');
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    const name = screen.getByLabelText('Name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const errorId = name.getAttribute('aria-describedby');
    expect(
      errorId && document.getElementById(errorId)?.textContent,
    ).toBeTruthy();
    expect(writes).toEqual([]);
    change('Name', 'Valid name');
    tab('Guardrails');
    change('Max turns per hour', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    const rate = screen.getByLabelText('Max turns per hour');
    expect(rate.getAttribute('aria-invalid')).toBe('true');
    const rateErrorId = rate.getAttribute('aria-describedby');
    expect(
      rateErrorId && document.getElementById(rateErrorId)?.textContent,
    ).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('R-20 shows the channel binding and Slack status on both agent cards and editor', async () => {
    const view = mount('/agents');
    const link = await screen.findByRole('link', { name: /Researcher/ });
    const card = link.closest('article') ?? link;
    expect(within(card).getByText(/idle/i)).toBeTruthy();
    expect(within(card).getByText(/gpt-5.4-mini/)).toBeTruthy();
    expect(
      await within(card).findByText('Slack binding: enabled'),
    ).toBeTruthy();
    expect(await within(card).findByText('Slack: not configured')).toBeTruthy();
    view.unmount();
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Channels');
    expect(screen.getAllByText(/Slack: not configured/).length).toBeGreaterThan(
      0,
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Slack binding enabled') as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
  });

  it('R-03 R-04 R-05 persists schedules, memories, and attached reusable skills', async () => {
    const view = mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Memory');
    change('Memory fact', 'Prefers primary sources');
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    await waitFor(() =>
      expect(memories[0]?.fact).toBe('Prefers primary sources'),
    );
    tab('Schedules');
    change('Schedule kind', 'interval');
    change('Schedule expression', '60');
    change('Schedule prompt', 'Check updates');
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    await waitFor(() =>
      expect(schedules[0]).toMatchObject({
        kind: 'interval',
        expr: '60',
        prompt: 'Check updates',
        workflowId: null,
        enabled: true,
      }),
    );
    tab('Skills');
    fireEvent.click(await screen.findByLabelText(skill.name));
    fireEvent.click(screen.getByRole('button', { name: 'Save skills' }));
    await waitFor(() =>
      expect(
        writes.find((write) => write.path.endsWith('/skills'))?.body,
      ).toEqual({ skillIds: [skill.id] }),
    );
    view.unmount();
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Memory');
    expect(await screen.findByText('Prefers primary sources')).toBeTruthy();
    tab('Skills');
    expect(
      ((await screen.findByLabelText(skill.name)) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('R-02 Test chat sends a message and shows persisted agent replies', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Test chat');
    change('Message', 'Check this claim 🌍');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(
        writes.find((write) => write.path.endsWith('/chat'))?.body,
      ).toEqual({ text: 'Check this claim 🌍' }),
    );
    expect(await screen.findByText('Primary sources checked ✓')).toBeTruthy();
    expect(await screen.findByText('Run: completed')).toBeTruthy();
    tab('Basics');
    tab('Test chat');
    change('Message', 'Follow up');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(
        writes
          .filter((write) => write.path.endsWith('/chat'))
          .map((write) => write.body),
      ).toEqual([
        { text: 'Check this claim 🌍' },
        { text: 'Follow up', conversationId },
      ]),
    );
  });

  it('R-02 Test chat exposes failed requests and failed run status', async () => {
    chatFailure = true;
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Test chat');
    change('Message', 'Check this claim 🌍');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    chatFailure = false;
    runFailed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/Run: failed.*turn_timeout/)).toBeTruthy();
  });

  it('R-01 creates an agent from the new-agent route with persisted defaults', async () => {
    mount('/agents/new');
    change('Name', 'New worker');
    change('Role', 'Writer');
    change('System prompt', 'Write clearly');
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    expect(
      await screen.findByRole('heading', { name: 'New worker', level: 1 }),
    ).toBeTruthy();
    expect(
      writes.find((write) => write.path === '/agents')?.body,
    ).toMatchObject({
      name: 'New worker',
      role: 'Writer',
      systemPrompt: 'Write clearly',
      tools: { bash: false, edit: false, webfetch: false },
    });
    expect(agent.name).toBe('New worker');
  });

  it('R-01 confirms deletion, shows referenced workflow names on 409, and deletes after release', async () => {
    deleteConflict = true;
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(
      await screen.findByText('Agent is used by workflows: Dev pipeline'),
    ).toBeTruthy();
    expect(agentPresent).toBe(true);
    deleteConflict = false;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(
      await screen.findByRole('heading', { name: 'Create your first agent' }),
    ).toBeTruthy();
    expect(agentPresent).toBe(false);
  });

  it('R-01 R-02 shows server field validation beside the responsible field without changing persisted state', async () => {
    rejectAgentWrite = true;
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    change('Name', 'Taken name');
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
    expect(await screen.findByText('Name already taken')).toBeTruthy();
    const name = screen.getByLabelText('Name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(name.getAttribute('aria-describedby') ?? '')
        ?.textContent,
    ).toBe('Name already taken');
    expect(agent.name).toBe('Researcher');
  });

  it('R-03 R-04 configured dimensions distinguish loading from empty and refresh after configuration changes', async () => {
    let resolveDimensions = () => {};
    dimensionsWait = new Promise<void>((resolve) => {
      resolveDimensions = resolve;
    });
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    expect(screen.getByText(/Loading configured dimensions…/)).toBeTruthy();
    expect(screen.queryByText(/\d+ set on this agent/)).toBeNull();
    resolveDimensions();
    expect(await screen.findByText(/9 set on this agent/)).toBeTruthy();
    tab('Memory');
    change('Memory fact', 'Remember this');
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    expect(await screen.findByText(/10 set on this agent/)).toBeTruthy();
    tab('Basics');
    change('Name', '');
    expect(screen.getByText(/9 set on this agent/)).toBeTruthy();
  });

  it('R-03 deleting the schedule currently being edited resets the form and creates a fresh schedule', async () => {
    schedules = [
      {
        id,
        agentId: id,
        kind: 'interval',
        expr: '60',
        prompt: 'Old task',
        workflowId: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 60000,
      },
    ];
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Schedules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit schedule' }),
    );
    expect(
      (screen.getByLabelText('Schedule prompt') as HTMLInputElement).value,
    ).toBe('Old task');
    fireEvent.click(screen.getByRole('button', { name: 'Delete schedule' }));
    await waitFor(() => expect(schedules).toEqual([]));
    expect(
      await screen.findByRole('button', { name: 'Add schedule' }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Schedule prompt') as HTMLInputElement).value,
    ).toBe('');
    change('Schedule expression', '120');
    change('Schedule prompt', 'New task');
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    await waitFor(() =>
      expect(schedules[0]).toMatchObject({ expr: '120', prompt: 'New task' }),
    );
    expect(writes.at(-1)?.path).toBe(`/agents/${id}/schedules`);
  });

  it('R-03 shows the server cron validation error next to the schedule expression', async () => {
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Schedules');
    change('Schedule kind', 'cron');
    change('Schedule expression (UTC)', 'not cron');
    change('Schedule prompt', 'Check updates');
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    const expression = screen.getByLabelText('Schedule expression (UTC)');
    await waitFor(() =>
      expect(expression.getAttribute('aria-invalid')).toBe('true'),
    );
    expect(
      document.getElementById(expression.getAttribute('aria-describedby') ?? '')
        ?.textContent,
    ).toBe('Invalid cron expression');
    expect(schedules).toEqual([]);
  });

  it('R-03 locks schedule edits while saving and resets only after the pending update persists', async () => {
    schedules = [
      {
        id,
        agentId: id,
        kind: 'interval',
        expr: '60',
        prompt: 'Old task',
        workflowId: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 60000,
      },
    ];
    let finishSave = () => {};
    scheduleWriteWait = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    mount(`/agents/${id}`);
    await screen.findByLabelText('Name');
    tab('Schedules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit schedule' }),
    );
    change('Schedule prompt', 'Updated task');
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() =>
      expect(
        writes.some((write) => write.path.endsWith(`/schedules/${id}`)),
      ).toBe(true),
    );
    for (const control of [
      screen.getByLabelText('Schedule prompt'),
      screen.getByRole('button', { name: 'Edit schedule' }),
      screen.getByRole('button', { name: 'Cancel edit' }),
    ])
      expect(control.matches(':disabled')).toBe(true);
    expect(schedules[0]?.prompt).toBe('Old task');
    finishSave();
    await waitFor(() => expect(schedules[0]?.prompt).toBe('Updated task'));
    expect(
      await screen.findByRole('button', { name: 'Add schedule' }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Schedule prompt') as HTMLInputElement).value,
    ).toBe('');
  });
});
