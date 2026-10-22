// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  AgentSchema,
  TemplateSchema,
  WorkflowInputSchema,
  WorkflowSchema,
  type Workflow,
} from '@yuno/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import templateJson from '../../../../templates/dev-pipeline.json';
import { App } from '../App.js';

const id = '00000000-0000-4000-8000-000000000001';
const template = TemplateSchema.parse(templateJson);
const agents = template.agents.map((agent, index) =>
  AgentSchema.parse({
    ...agent,
    id: `00000000-0000-4000-8000-00000000000${index + 2}`,
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
  }),
);
let saved: Workflow | undefined;
let updates: unknown[];
let runInputs: unknown[];
let failRun: boolean;
class FakeEventSource {
  close() {}
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
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
  saved = undefined;
  runInputs = [];
  failRun = false;
  updates = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api', '');
      if (path === '/templates/dev-pipeline/load' && init?.method === 'POST') {
        saved = WorkflowSchema.parse({
          id,
          name: template.name,
          description: template.description,
          templateId: template.id,
          createdAt: 0,
          updatedAt: 0,
          graph: {
            ...template.graph,
            nodes: template.graph.nodes.map(({ agentName, ...node }) => ({
              ...node,
              agentId: agents.find((agent) => agent.name === agentName)?.id,
            })),
          },
        });
        return response(saved, 201);
      }
      if (path === `/workflows/${id}` && init?.method === 'PUT') {
        const input = WorkflowInputSchema.parse(JSON.parse(String(init.body)));
        updates.push(input);
        saved = WorkflowSchema.parse({ ...saved, ...input });
        return response(saved);
      }
      if (path === `/workflows/${id}/runs` && init?.method === 'POST') {
        runInputs.push(JSON.parse(String(init.body)));
        if (failRun) return response({ message: 'Runtime unavailable' }, 503);
        return response(
          {
            id,
            workflowId: id,
            trigger: 'ui',
            input: 'Build 🌍',
            status: 'queued',
            result: null,
            error: null,
            startedAt: null,
            finishedAt: null,
            totalCostUsd: 0,
            totalTokens: 0,
          },
          201,
        );
      }
      if (path === '/templates') return response([template]);
      if (path === '/agents') return response(agents);
      if (path === `/workflows/${id}`) return response(saved);
      if (path === '/workflows') return response(saved ? [saved] : []);
      if (path === '/health') return response({ ok: true });
      if (path === '/approvals?status=pending') return response([]);
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('T17 workflow templates and builder (R-10, R-11, R-12, R-13)', () => {
  it('R-10 T23 offers Open existing and Load a copy after a template was already loaded', async () => {
    const view = mount('/templates');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load Development pipeline' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Select edge review' }),
    ).toBeTruthy();
    view.unmount();
    mount('/templates');
    const open = await screen.findByRole('link', { name: /open existing/i });
    expect(open.getAttribute('href')).toBe(`/workflows/${id}`);
    expect(open.classList.contains('secondary')).toBe(false);
    expect(screen.getByRole('button', { name: /load a copy/i })).toBeTruthy();
    const fetcher = vi.mocked(fetch);
    const before = fetcher.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/load') && init?.method === 'POST',
    ).length;
    fireEvent.click(screen.getByRole('button', { name: /load a copy/i }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith('/load') && init?.method === 'POST',
        ),
      ).toHaveLength(before + 1),
    );
  });
  it('R-10 R-11 R-12 R-13 loads dev-pipeline from the UI, edits an edge, saves, reloads and preserves its condition', async () => {
    const view = mount('/templates');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load Development pipeline' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select edge review' }),
    );
    fireEvent.change(screen.getByLabelText('Edge condition'), {
      target: { value: 'approved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(
      saved?.graph.edges.find((edge) => edge.id === 'review')?.condition,
    ).toBe('approved');
    expect(
      saved?.graph.edges.find((edge) => edge.id === 'revise')?.condition,
    ).toBe('rejected');
    expect(
      saved?.graph.nodes.find((node) => node.id === 'deployer')
        ?.requiresApproval,
    ).toBe(true);
    view.unmount();
    mount(`/workflows/${id}`);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select edge review' }),
    );
    expect(
      (screen.getByLabelText('Edge condition') as HTMLSelectElement).value,
    ).toBe('approved');
    expect(saved?.graph.maxIterations).toBe(6);
  });
  it('R-10 R-12 adds and removes nodes, prevents invalid saves, and persists approval and max iterations', async () => {
    mount('/templates');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load Development pipeline' }),
    );
    await screen.findByRole('button', { name: 'Save workflow' });
    fireEvent.change(screen.getByLabelText('Max iterations'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(screen.getByText('Workflow validation')).toBeTruthy();
    expect(updates).toEqual([]);
    fireEvent.change(screen.getByLabelText('Max iterations'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Coder' }));
    expect(
      (screen.getByLabelText('Step label') as HTMLInputElement).value,
    ).toBe('Coder');
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deployer' }));
    fireEvent.click(screen.getByLabelText('Requires approval'));
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(saved?.graph.nodes).toHaveLength(3);
    expect(
      saved?.graph.nodes.find((node) => node.id === 'deployer')
        ?.requiresApproval,
    ).toBe(false);
    expect(saved?.graph.maxIterations).toBe(9);
  });

  it('R-10 runs only saved workflows, submits input and displays request failures', async () => {
    mount('/templates');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load Development pipeline' }),
    );
    const run = await screen.findByRole('button', { name: 'Run' });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Changed description' },
    });
    expect(run.matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(run.matches(':disabled')).toBe(false));
    fireEvent.click(run);
    expect(
      (await screen.findByRole('button', { name: 'Start run' })).matches(
        ':disabled',
      ),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Run input'), {
      target: { value: 'Build 🌍' },
    });
    failRun = true;
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();
    expect(runInputs).toEqual([{ input: 'Build 🌍' }]);
    expect(saved?.description).toBe('Changed description');
    failRun = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(
      await screen.findByRole('heading', { name: 'Run detail', level: 1 }),
    ).toBeTruthy();
    expect(runInputs).toHaveLength(2);
  });
  it('R-10 R-12 connects steps with keyboard controls and blocks a graph with no reachable end', async () => {
    mount('/templates');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load Development pipeline' }),
    );
    const connect = await screen.findByRole('button', {
      name: 'Connect steps',
    });
    expect(connect.matches(':disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('From step'), {
      target: { value: 'deployer' },
    });
    fireEvent.change(screen.getByLabelText('To step'), {
      target: { value: 'coder' },
    });
    fireEvent.click(connect);
    expect(
      screen.getByText('No end node is reachable from the start'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(updates).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove edge' }));
    expect(
      screen.queryByText('No end node is reachable from the start'),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('From step'), {
      target: { value: 'coder' },
    });
    fireEvent.change(screen.getByLabelText('To step'), {
      target: { value: 'deployer' },
    });
    fireEvent.click(connect);
    fireEvent.change(screen.getByLabelText('Edge condition'), {
      target: { value: 'contains' },
    });
    fireEvent.change(screen.getByLabelText('Contains text'), {
      target: { value: 'Deploy now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(saved?.graph.edges).toHaveLength(4);
    expect(saved?.graph.edges.at(-1)).toMatchObject({
      source: 'coder',
      target: 'deployer',
      condition: { contains: 'Deploy now' },
    });
  });
});
