// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  AgentSchema,
  ApprovalSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
  WorkflowSchema,
} from '@yuno/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';

const id = '00000000-0000-4000-8000-000000000001';
const agent = AgentSchema.parse({
  id,
  name: 'Coder',
  role: 'developer',
  systemPrompt: 'Build',
  status: 'working',
  createdAt: 0,
  updatedAt: 0,
});
const workflow = WorkflowSchema.parse({
  id,
  name: 'Development pipeline',
  description: '',
  templateId: null,
  createdAt: 0,
  updatedAt: 0,
  graph: {
    nodes: [
      {
        id: 'coder',
        position: { x: 0, y: 0 },
        agentId: id,
        label: 'Coder',
        instructions: '',
        requiresApproval: false,
      },
    ],
    edges: [],
    startNodeId: 'coder',
    maxIterations: 6,
  },
});
const initialRun = RunSchema.parse({
  id,
  workflowId: id,
  trigger: 'ui',
  input: 'Build 🌍',
  status: 'running',
  result: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  totalCostUsd: 0,
  totalTokens: 0,
});
const initialStep = RunStepSchema.parse({
  id,
  runId: id,
  nodeId: 'coder',
  agentId: id,
  iteration: 1,
  status: 'running',
  prompt: 'Build',
  output: null,
  verdict: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  finishedAt: null,
  error: null,
});
const message = MessageSchema.parse({
  id,
  runId: id,
  conversationId: 'thread',
  fromKind: 'human',
  fromId: 'Slack user',
  toAgentId: id,
  channel: 'slack',
  content: 'Deploy 🚀 after review',
  verdict: null,
  status: 'acked',
  attempts: 1,
  nextAttemptAt: 0,
  idempotencyKey: `run:${id}:start`,
  error: null,
  createdAt: 1,
  updatedAt: 1,
});
const initialApproval = ApprovalSchema.parse({
  id,
  runId: id,
  stepId: id,
  agentId: id,
  kind: 'step_gate',
  detail: 'Approve deployment',
  runtimeSessionId: null,
  runtimePermissionId: null,
  status: 'pending',
  createdAt: 1,
  resolvedAt: null,
});
let run = initialRun;
let step = initialStep;
let approval = initialApproval;
let earlierStep: typeof initialStep | undefined;
let failDecision = false;
let failRunRead = false;
let logHistory: unknown[] = [];
let availableAgents = [agent];
let feedMessages = [message];
let delayedLogs: Promise<Response> | undefined;
const decisions: unknown[] = [];
class FakeEventSource {
  static current: FakeEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.current = this;
  }
  close() {}
  emit(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, ts: 2, data }) });
  }
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  // Browser layout shims from https://reactflow.dev/learn/advanced-use/testing.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(
        private callback: (
          entries: {
            target: Element;
            contentRect: { width: number; height: number };
          }[],
        ) => void,
      ) {}
      observe(target: Element) {
        setTimeout(
          () =>
            this.callback([
              { target, contentRect: { width: 800, height: 600 } },
            ]),
          0,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m22 = 1;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  });

  run = { ...initialRun };
  step = { ...initialStep };
  earlierStep = undefined;
  approval = { ...initialApproval };
  decisions.length = 0;
  failDecision = false;
  failRunRead = false;
  logHistory = [];
  availableAgents = [agent];
  feedMessages = [message];
  delayedLogs = undefined;
  localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api', '');
      if (path === `/approvals/${id}` && init?.method === 'POST') {
        const decision = JSON.parse(String(init.body)) as { decision: string };
        decisions.push(decision);
        if (failDecision)
          return response({ message: 'Approval service unavailable' }, 503);
        approval = {
          ...approval,
          status: decision.decision === 'approve' ? 'approved' : 'rejected',
          resolvedAt: 2,
        };
        run = {
          ...run,
          status: decision.decision === 'approve' ? 'running' : 'failed',
        };
        return response(approval);
      }
      if (path.startsWith('/approvals'))
        return response(approval.status === 'pending' ? [approval] : []);
      if (path === '/health') return response({ ok: true });
      if (path === '/agents') return response(availableAgents);
      if (path.startsWith('/logs')) return delayedLogs ?? response(logHistory);
      if (path.includes('/channels'))
        return response({
          id,
          agentId: id,
          type: 'slack',
          config: { respondTo: 'dm_and_mentions' },
          enabled: true,
        });
      if (path === '/runs') return response([run]);
      if (path === `/runs/${id}` && failRunRead)
        return response({ message: 'Run unavailable' }, 503);
      if (path === `/runs/${id}`)
        return response({
          ...run,
          steps: earlierStep ? [step, earlierStep] : [step],
          messages: feedMessages,
          approvals: [approval],
        });
      if (path === '/workflows') return response([workflow]);
      if (path === `/workflows/${id}`) return response(workflow);
      if (path.startsWith('/messages')) return response(feedMessages);
      if (path.startsWith('/usage'))
        return response([
          {
            agentId: id,
            runId: id,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            totalTokens: run.totalTokens,
            costUsd: run.totalCostUsd,
          },
        ]);
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('T23 demo monitoring polish (R-16, R-22, R-24)', () => {
  it.each(['/approvals', `/runs/${id}`])(
    'R-24 approval card shows Deployer rather than its ID on %s',
    async (path) => {
      availableAgents = [{ ...agent, name: 'Deployer' }];
      mount(path);
      const detail = await screen.findByText('Approve deployment');
      const card = detail.closest('article');
      if (!card) throw new Error('Missing approval card');
      await waitFor(() =>
        expect(within(card).getByText('Deployer')).toBeTruthy(),
      );
      expect(within(card).queryByText(id)).toBeNull();
    },
  );
  it('R-24 approval card falls back to the ID for a removed agent', async () => {
    availableAgents = [];
    mount('/approvals');
    const detail = await screen.findByText('Approve deployment');
    const card = detail.closest('article');
    if (!card) throw new Error('Missing approval card');
    expect(within(card).getByText(id)).toBeTruthy();
  });
  it.each([
    ['blocked', 'daily_cost_cap'],
    ['failed', 'runtime_turn_failed'],
  ] as const)(
    'R-16 R-24 message trail shows %s reason instead of acked',
    async (status, error) => {
      step = { ...step, status, error, finishedAt: 2 };
      mount(`/runs/${id}`);
      const trail = await screen.findByRole('list', { name: 'Message trail' });
      expect(
        await within(trail).findByText(`${status} · ${error}`),
      ).toBeTruthy();
      expect(within(trail).queryByText('acked')).toBeNull();
    },
  );
  it('R-16 R-24 a successful retry keeps the consumed message acked', async () => {
    step = {
      ...step,
      status: 'failed',
      error: 'runtime_turn_failed',
      finishedAt: 2,
    };
    earlierStep = {
      ...initialStep,
      id: '00000000-0000-4000-8000-000000000002',
      status: 'completed',
      startedAt: 3,
      finishedAt: 4,
      iteration: 2,
    };
    mount(`/runs/${id}`);
    const trail = await screen.findByRole('list', { name: 'Message trail' });
    expect(within(trail).getByText('acked')).toBeTruthy();
    expect(within(trail).queryByText(/failed ·/)).toBeNull();
  });
  it('R-16 R-24 later feedback failure does not overwrite an earlier consumed message outcome', async () => {
    step = { ...step, status: 'completed', finishedAt: 2 };
    earlierStep = {
      ...initialStep,
      id: '00000000-0000-4000-8000-000000000002',
      status: 'blocked',
      error: 'daily_cost_cap',
      startedAt: 3,
      finishedAt: 4,
      iteration: 2,
    };
    mount(`/runs/${id}`);
    const trail = await screen.findByRole('list', { name: 'Message trail' });
    expect(within(trail).getByText('acked')).toBeTruthy();
    expect(within(trail).queryByText(/blocked ·/)).toBeNull();
  });
  it.each([
    ['blocked', 'daily_cost_cap'],
    ['failed', 'runtime_turn_failed'],
  ] as const)(
    'R-16 R-24 Monitor recent messages show %s from cached run details',
    async (status, error) => {
      step = { ...step, status, error, finishedAt: 2 };
      mount('/');
      const trail = await screen.findByRole('list', { name: 'Message trail' });
      expect(
        await within(trail).findByText(`${status} · ${error}`),
      ).toBeTruthy();
      expect(within(trail).queryByText('acked')).toBeNull();
    },
  );
  it('R-16 R-24 a producer-keyed handoff shows its next consumer failure without overwriting the earlier message', async () => {
    step = { ...step, status: 'completed', finishedAt: 2 };
    earlierStep = {
      ...initialStep,
      id: '00000000-0000-4000-8000-000000000002',
      status: 'blocked',
      error: 'daily_cost_cap',
      iteration: 2,
      startedAt: 3,
      finishedAt: 4,
    };
    feedMessages = [
      message,
      {
        ...message,
        id: '00000000-0000-4000-8000-000000000003',
        fromKind: 'agent',
        fromId: id,
        content: 'Fix review feedback',
        idempotencyKey: `run:${id}:step:${step.id}`,
      },
    ];
    mount(`/runs/${id}`);
    const trail = await screen.findByRole('list', { name: 'Message trail' });
    const first = within(trail).getByText(message.content).closest('li');
    const handoff = within(trail)
      .getByText('Fix review feedback')
      .closest('li');
    if (!first || !handoff) throw new Error('Missing message entries');
    expect(within(first).getByText('acked')).toBeTruthy();
    expect(within(first).queryByText(/blocked ·/)).toBeNull();
    expect(within(handoff).getByText('blocked · daily_cost_cap')).toBeTruthy();
    expect(within(handoff).queryByText('acked')).toBeNull();
  });
  it('R-16 R-24 unknown chat reply keys preserve queue status despite a failed run step', async () => {
    step = {
      ...step,
      status: 'failed',
      error: 'runtime_turn_failed',
      finishedAt: 2,
    };
    feedMessages = [{ ...message, idempotencyKey: 'chat:reply:external-turn' }];
    mount(`/runs/${id}`);
    const trail = await screen.findByRole('list', { name: 'Message trail' });
    expect(within(trail).getByText('acked')).toBeTruthy();
    expect(within(trail).queryByText(/failed ·/)).toBeNull();
  });
  it('R-22 delayed persisted logs merge with SSE events received before hydration', async () => {
    const persisted = {
      id,
      ts: 1,
      level: 'info',
      agentId: null,
      runId: null,
      event: 'history_before_open',
      data: {},
    };
    let release: ((value: Response) => void) | undefined;
    delayedLogs = new Promise<Response>((resolve) => {
      release = resolve;
    });
    mount('/');
    await screen.findByText('Coder');
    act(() => {
      FakeEventSource.current.emit('log', persisted);
      FakeEventSource.current.emit('log', {
        ...persisted,
        id: '00000000-0000-4000-8000-000000000002',
        ts: 2,
        event: 'arrived_during_load',
      });
    });
    expect(await screen.findByText(/arrived_during_load/)).toBeTruthy();
    await act(async () => {
      if (!release) throw new Error('Missing logs response resolver');
      release(response([persisted]));
      await delayedLogs;
    });
    const logs = screen.getByRole('list', { name: 'Live logs' });
    expect(within(logs).getAllByRole('listitem')).toHaveLength(2);
    expect(within(logs).getAllByText(/history_before_open/)).toHaveLength(1);
    expect(within(logs).getByText(/arrived_during_load/)).toBeTruthy();
  });
  it('R-22 loads persisted logs on open then appends SSE logs without duplicate IDs', async () => {
    const persisted = {
      id,
      ts: 1,
      level: 'info',
      agentId: null,
      runId: null,
      event: 'persisted_log',
      data: {},
    };
    logHistory = [persisted];
    mount('/');
    expect(await screen.findByText(/persisted_log/)).toBeTruthy();
    act(() => {
      FakeEventSource.current.emit('log', persisted);
      FakeEventSource.current.emit('log', {
        ...persisted,
        id: '00000000-0000-4000-8000-000000000002',
        ts: 2,
        event: 'new_live_log',
      });
    });
    expect(await screen.findByText(/new_live_log/)).toBeTruthy();
    const logs = screen.getByRole('list', { name: 'Live logs' });
    expect(within(logs).getAllByRole('listitem')).toHaveLength(2);
    expect(logs.textContent?.indexOf('persisted_log')).toBeLessThan(
      logs.textContent?.indexOf('new_live_log') ?? 0,
    );
    expect(
      screen.queryByText(/Logs missed while disconnected are not replayed/),
    ).toBeNull();
    expect(screen.getByText(/200.*persisted|persisted.*200/i)).toBeTruthy();
  });
});

describe('T22 historical run graphs (R-28)', () => {
  it('R-28 draws the run snapshot rather than the edited live workflow', async () => {
    run = {
      ...initialRun,
      status: 'completed',
      graphSnapshot: {
        ...workflow.graph,
        nodes: workflow.graph.nodes.map((node) => ({
          ...node,
          label: 'Original captured label',
        })),
      },
    };
    mount(`/runs/${id}`);
    expect(await screen.findByText('Original captured label')).toBeTruthy();
    expect(
      screen.getByText(/Workflow definition captured at run start/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/workflow definition reflects its current/),
    ).toBeNull();
  });
  it('R-28 falls back to the current graph with a notice for a pre-migration run', async () => {
    run = { ...initialRun, graphSnapshot: null };
    mount(`/runs/${id}`);
    expect(
      await screen.findByText(
        /workflow definition reflects its current saved configuration/,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText('Coder').length).toBeGreaterThan(0);
  });
});

describe('T18 monitoring (R-06, R-16, R-20 through R-25)', () => {
  it('R-16 R-23 R-24 R-25 shows live run node states, Slack trail, and changing tokens/cost without refreshing', async () => {
    mount(`/runs/${id}`);
    expect(await screen.findByText(message.content)).toBeTruthy();
    expect(
      await screen.findByLabelText('Coder: waiting approval'),
    ).toBeTruthy();
    expect(screen.getAllByText(/slack/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0);
    run = {
      ...run,
      status: 'completed',
      totalTokens: 321,
      totalCostUsd: 0.125,
      finishedAt: 2,
    };
    approval = { ...approval, status: 'approved', resolvedAt: 2 };
    earlierStep = {
      ...step,
      id: '00000000-0000-4000-8000-000000000002',
      status: 'failed',
      finishedAt: 1,
    };
    step = {
      ...step,
      iteration: 2,
      status: 'completed',
      inputTokens: 300,
      outputTokens: 21,
      costUsd: 0.125,
      output: 'Shipped',
      verdict: 'approved',
      finishedAt: 2,
    };
    act(() => {
      FakeEventSource.current.emit('step.updated', step);
      FakeEventSource.current.emit('run.updated', run);
    });
    expect(await screen.findByText('Shipped')).toBeTruthy();
    expect(await screen.findByLabelText('Coder: completed')).toBeTruthy();
    expect(screen.queryByLabelText('Coder: failed')).toBeNull();
    expect(screen.getByText('Iteration 2')).toBeTruthy();
    expect(screen.getAllByText(/321/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0\.125/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
  });
  it('R-20 R-21 R-22 R-23 R-24 R-25 monitor shows agents, channel messages, active runs and live logs', async () => {
    mount('/');
    expect(await screen.findByText('Coder')).toBeTruthy();
    expect(await screen.findByText(/Slack: enabled/)).toBeTruthy();
    expect(await screen.findByText(/0 completed turns/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Build 🌍' }).getAttribute('href'),
    ).toBe(`/runs/${id}`);
    expect(await screen.findByText(message.content)).toBeTruthy();
    expect(screen.getAllByText(/working/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/estimated/i).length).toBeGreaterThan(0);
    act(() =>
      FakeEventSource.current.emit('log', {
        id,
        ts: 2,
        level: 'info',
        agentId: id,
        runId: id,
        event: 'deployment_started',
        data: {},
      }),
    );
    expect(await screen.findByText(/deployment_started/)).toBeTruthy();
  });
  it('R-06 approving from the inbox posts the decision and resumes the waiting run', async () => {
    run = { ...run, status: 'waiting_approval' };
    mount('/approvals');
    expect(await screen.findByText('Approve deployment')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(decisions).toEqual([{ decision: 'approve' }]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull(),
    );
    expect(run.status).toBe('running');
    expect(approval.status).toBe('approved');
  });
  it('R-06 failed approval remains actionable and exposes the transport failure', async () => {
    failDecision = true;
    mount('/approvals');
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    expect(
      await screen.findByText('Approval service unavailable'),
    ).toBeTruthy();
    expect(approval.status).toBe('pending');
    expect(
      screen.getByRole('button', { name: /^approve$/i }).matches(':disabled'),
    ).toBe(false);
  });
  it('R-06 run detail approval banner rejects and refreshes its run state', async () => {
    run = { ...run, status: 'waiting_approval' };
    mount(`/runs/${id}`);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(decisions).toEqual([{ decision: 'reject' }]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^reject$/i })).toBeNull(),
    );
    expect(await screen.findByText(/failed/i)).toBeTruthy();
  });
  it('R-24 run detail displays failed reads and lets the user retry', async () => {
    failRunRead = true;
    mount(`/runs/${id}`);
    expect(
      await screen.findByText('Run unavailable', {}, { timeout: 4000 }),
    ).toBeTruthy();
    failRunRead = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(message.content)).toBeTruthy();
  });
  it('R-24 R-25 run history links to its persisted detail and shows totals', async () => {
    run = { ...run, totalTokens: 321, totalCostUsd: 0.125 };
    mount('/runs');
    const detail = await screen.findByRole('link', { name: 'Build 🌍' });
    expect(detail.getAttribute('href')).toBe(`/runs/${id}`);
    expect(screen.getByText(/321 tokens/)).toBeTruthy();
    expect(screen.getByText(/0\.125/)).toBeTruthy();
  });
});
