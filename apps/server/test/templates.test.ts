import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTemplates } from '../src/domain/templates.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TemplateSchema,
  WorkflowSchema,
  RunSchema,
  RunStepSchema,
  ApprovalSchema,
  type Template,
} from '@yuno/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createAgentsRepository } from '../src/db/repos/agents.js';
import { createWorkflowsRepository } from '../src/db/repos/workflows.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';
import { createEventHub } from '../src/events/hub.js';
import { createLogsRepository } from '../src/db/repos/logs.js';

const cleanup: (() => Promise<void>)[] = [];
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
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function template(id: string) {
  return TemplateSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`../../../templates/${id}.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
}
async function setup() {
  const connection = openDatabase(':memory:');
  const dataDir = await mkdtemp(join(tmpdir(), 'yuno-templates-'));
  const hub = createEventHub(createLogsRepository(connection.db));
  const events: string[] = [];
  hub.subscribe((event) => events.push(event.type));
  const app = buildApp({
    db: connection.db,
    dataDir,
    runtime: createFakeRuntime(),
    hub,
  });
  cleanup.push(async () => {
    await app.close();
    connection.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const agents = createAgentsRepository(connection.db);
  const workflows = createWorkflowsRepository(connection.db);
  async function load(id: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/templates/${id}/load`,
    });
    expect(response.statusCode).toBe(201);
    const { id: workflowId } = z
      .object({ id: z.uuid() })
      .parse(response.json());
    return WorkflowSchema.parse(
      (await app.inject(`/api/workflows/${workflowId}`)).json(),
    );
  }
  return { app, agents, workflows, events, load };
}
function topology(value: Template) {
  const name = (id: string) =>
    value.graph.nodes.find((node) => node.id === id)?.agentName;
  return value.graph.edges.map((edge) => [
    name(edge.source),
    edge.condition,
    name(edge.target),
  ]);
}

describe('T12 templates (R-12/R-13)', () => {
  it('R-27 T23 Reviewer alone knows every house checklist item and rejects with specific feedback', async () => {
    const dev = await template('dev-pipeline');
    const reviewer =
      dev.agents.find((agent) => agent.name === 'Reviewer')?.systemPrompt ?? '';
    const coder =
      dev.agents.find((agent) => agent.name === 'Coder')?.systemPrompt ?? '';
    for (const item of [
      /reset|clear/i,
      /two decimal|2 decimal/i,
      /currency symbol/i,
      /<title>/i,
      /viewport/i,
      /keyboard focus/i,
    ]) {
      expect(reviewer).toMatch(item);
      expect(coder).not.toMatch(item);
    }
    expect(reviewer).toMatch(/reject/i);
    expect(reviewer).toMatch(/specific|list/i);
    expect(reviewer).toMatch(/files/i);
    expect(reviewer).toMatch(/feedback/i);
  });
  it('R-10 T23 loading a template repeatedly persists unique numbered names', async () => {
    const s = await setup();
    const first = await s.load('dev-pipeline');
    const second = await s.load('dev-pipeline');
    const third = await s.load('dev-pipeline');
    expect([first.name, second.name, third.name]).toEqual([
      'Development pipeline',
      'Development pipeline (2)',
      'Development pipeline (3)',
    ]);
    expect(
      s.workflows
        .list()
        .map((value) => value.name)
        .sort(),
    ).toEqual([first.name, second.name, third.name].sort());
  });
  it('R-09 R-27 T22 grants deployment only to the dev-pipeline Deployer', async () => {
    const dev = await template('dev-pipeline');
    expect(
      dev.agents
        .filter((agent) => agent.permissions.canDeploy)
        .map((agent) => agent.name),
    ).toEqual(['Deployer']);
    expect(
      dev.agents.find((agent) => agent.name === 'Deployer')?.systemPrompt,
    ).toMatch(/\/deployments\//);
  });

  it('R-12/R-13 both JSON templates validate and contain the specified topology, prompts and tools', async () => {
    const dev = await template('dev-pipeline');
    const research = await template('research-pipeline');
    expect(topology(dev)).toEqual(
      expect.arrayContaining([
        ['Coder', 'always', 'Reviewer'],
        ['Reviewer', 'rejected', 'Coder'],
        ['Reviewer', 'approved', 'Deployer'],
      ]),
    );
    expect(
      dev.graph.nodes.find((node) => node.agentName === 'Deployer')
        ?.requiresApproval,
    ).toBe(true);
    expect(topology(research)).toEqual(
      expect.arrayContaining([
        ['Researcher', 'always', 'Writer'],
        ['Writer', 'always', 'Editor'],
        ['Editor', 'rejected', 'Writer'],
      ]),
    );
    expect(
      research.graph.edges.filter(
        (edge) =>
          edge.source ===
          research.graph.nodes.find((node) => node.agentName === 'Editor')?.id,
      ),
    ).toHaveLength(2);
    const approved = research.graph.edges.find(
      (edge) =>
        edge.source ===
          research.graph.nodes.find((node) => node.agentName === 'Editor')
            ?.id && edge.condition === 'approved',
    );
    expect(approved).toBeDefined();
    expect(
      research.graph.nodes.some((node) => node.id === approved?.target),
    ).toBe(true);
    expect(
      research.graph.edges.some((edge) => edge.source === approved?.target),
    ).toBe(false);
    const agent = (value: Template, name: string) => {
      const found = value.agents.find((item) => item.name === name);
      if (!found) throw new Error(`Missing ${name}`);
      return found;
    };
    expect(agent(dev, 'Coder').systemPrompt).toMatch(
      /static.*web|web.*static/i,
    );
    expect(agent(dev, 'Coder').systemPrompt).toMatch(/workspace/i);
    expect(agent(dev, 'Coder').tools.edit).toBe(true);
    expect(agent(dev, 'Reviewer').systemPrompt).toMatch(/files/i);
    expect(agent(dev, 'Reviewer').systemPrompt).toMatch(/feedback/i);
    expect(agent(dev, 'Deployer').systemPrompt).toMatch(
      /\/deployments\/.*runId/i,
    );
    expect(agent(dev, 'Deployer').tools.bash).toBe(true);
    expect(agent(research, 'Researcher').tools.webfetch).toBe(true);
    expect(agent(research, 'Researcher').permissions.webfetch).toBe('allow');
    expect(agent(research, 'Researcher').systemPrompt).toMatch(/cit|URL/i);
    expect(agent(research, 'Writer').systemPrompt).toContain('report.md');
    expect(agent(research, 'Writer').tools.edit).toBe(true);
    expect(agent(research, 'Editor').systemPrompt).toMatch(/claims/i);
    expect(agent(research, 'Editor').systemPrompt).toMatch(/citat|sources/i);
  });
  it('R-13 GET lists the validated templates and loading creates missing agents and a new editable workflow', async () => {
    const s = await setup();
    const response = await s.app.inject('/api/templates');
    expect(response.statusCode).toBe(200);
    const values = z.array(TemplateSchema).parse(response.json());
    expect(values.map((value) => value.id)).toEqual(
      expect.arrayContaining(['dev-pipeline', 'research-pipeline']),
    );
    const workflow = await s.load('dev-pipeline');
    expect(workflow.templateId).toBe('dev-pipeline');
    expect(
      s.agents
        .list()
        .map((agent) => agent.name)
        .sort(),
    ).toEqual(['Coder', 'Deployer', 'Reviewer']);
    expect(
      workflow.graph.nodes.every((node) => s.agents.get(node.agentId)),
    ).toBe(true);
    expect(s.workflows.get(workflow.id)).toEqual(workflow);
    const update = await s.app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflow.id}`,
      payload: {
        name: 'My edited template',
        description: workflow.description,
        graph: workflow.graph,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(s.workflows.get(workflow.id)?.name).toBe('My edited template');
  });
  it('R-13 loading twice reuses agents by exact name, preserves customization and creates a second independent workflow', async () => {
    const s = await setup();
    const first = await s.load('dev-pipeline');
    const coder = s.agents.list().find((agent) => agent.name === 'Coder');
    if (!coder) throw new Error('Missing Coder');
    const custom = {
      ...coder,
      systemPrompt: 'My custom prompt 🌍',
      tools: { ...coder.tools, bash: false },
    };
    s.agents.update(custom);
    s.agents.insert({ ...coder, id: crypto.randomUUID(), name: 'coder' });
    const second = await s.load('dev-pipeline');
    expect(second.id).not.toBe(first.id);
    expect(second.graph).toEqual(first.graph);
    expect(s.agents.list()).toHaveLength(4);
    expect(s.agents.get(coder.id)).toEqual(custom);
    expect(s.workflows.list()).toHaveLength(2);
  });
  it.each(['dev-pipeline', 'research-pipeline'])(
    'R-12/R-13 loaded %s completes with fake runtime, including rejection feedback and dev approval',
    async (id) => {
      const s = await setup();
      const workflow = await s.load(id);
      const response = await s.app.inject({
        method: 'POST',
        url: `/api/workflows/${workflow.id}/runs`,
        payload: { input: 'Build a useful result 🌍' },
      });
      expect(response.statusCode).toBe(201);
      const run = RunSchema.parse(response.json());
      await vi.advanceTimersByTimeAsync(3000);
      if (id === 'dev-pipeline') {
        expect((await s.app.inject(`/api/runs/${run.id}`)).json().status).toBe(
          'waiting_approval',
        );
        const approvals = z
          .array(ApprovalSchema)
          .parse((await s.app.inject('/api/approvals?status=pending')).json());
        expect(approvals).toHaveLength(1);
        const gate = approvals[0];
        if (!gate) throw new Error('Missing deployment gate');
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: `/api/approvals/${gate.id}`,
              payload: { decision: 'approve' },
            })
          ).statusCode,
        ).toBe(200);
        await vi.advanceTimersByTimeAsync(1000);
      }
      const result = z
        .object({ ...RunSchema.shape, steps: z.array(RunStepSchema) })
        .parse((await s.app.inject(`/api/runs/${run.id}`)).json());
      expect(result.status).toBe('completed');
      expect(result.error).toBeNull();
      expect(
        result.steps
          .filter((step) => step.verdict !== null)
          .map((step) => step.verdict),
      ).toEqual(['rejected', 'approved']);
      expect(result.steps.every((step) => step.status === 'completed')).toBe(
        true,
      );
      expect(result.steps).toHaveLength(id === 'dev-pipeline' ? 5 : 6);
      expect(s.events).toContain('run.updated');
      expect(s.events).toContain('message.created');
    },
  );
  it('R-13 unknown and malformed template IDs fail without creating agents or workflows', async () => {
    const s = await setup();
    for (const [id, status] of [
      ['unknown-template', 404],
      ['bad%20id', 400],
    ] as const) {
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: `/api/templates/${id}/load`,
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(s.agents.list()).toEqual([]);
    expect(s.workflows.list()).toEqual([]);
  });
  it('R-13 discovers added JSON after restart and rejects invalid, duplicate and un-loadable catalog IDs', async () => {
    const connection = openDatabase(':memory:');
    const directory = await mkdtemp(join(tmpdir(), 'yuno-catalog-'));
    cleanup.push(async () => {
      connection.close();
      await rm(directory, { recursive: true, force: true });
    });
    const url = pathToFileURL(`${directory}/`);
    const value = await template('dev-pipeline');
    await writeFile(join(directory, 'dev.json'), JSON.stringify(value));
    const catalog = createTemplates(connection.db, url);
    const custom = { ...value, id: 'custom-pipeline', name: 'Custom pipeline' };
    await writeFile(join(directory, 'custom.json'), JSON.stringify(custom));
    expect(catalog.list().map((item) => item.id)).toEqual(['dev-pipeline']);
    const restarted = createTemplates(connection.db, url);
    expect(restarted.list().map((item) => item.id)).toEqual([
      'custom-pipeline',
      'dev-pipeline',
    ]);
    expect(restarted.load('custom-pipeline').templateId).toBe(
      'custom-pipeline',
    );
    const copy = restarted.list();
    copy.splice(0);
    expect(restarted.list()).toHaveLength(2);
    await writeFile(join(directory, 'custom.json'), JSON.stringify(value));
    expect(() => createTemplates(connection.db, url)).toThrow(/duplicate/i);
    await writeFile(
      join(directory, 'custom.json'),
      JSON.stringify({ ...custom, graph: {} }),
    );
    expect(() => createTemplates(connection.db, url)).toThrow();
    await writeFile(
      join(directory, 'custom.json'),
      JSON.stringify({ ...custom, id: 'un loadable' }),
    );
    expect(() => createTemplates(connection.db, url)).toThrow();
  });
  it('R-13 failed workflow insertion rolls back all newly created agents and preserves existing records', async () => {
    const connection = openDatabase(':memory:');
    cleanup.push(async () => {
      connection.close();
    });
    const agents = createAgentsRepository(connection.db);
    const catalog = createTemplates(connection.db);
    const existing = catalog.load('research-pipeline');
    const before = agents.list();
    // Simulate a storage failure at the actual workflow INSERT after agent creation.
    connection.sqlite.exec(
      "CREATE TRIGGER reject_template_workflow BEFORE INSERT ON workflows BEGIN SELECT RAISE(ABORT, 'workflow storage failure'); END",
    );
    expect(() => catalog.load('dev-pipeline')).toThrow(
      /workflow storage failure/,
    );
    expect(agents.list()).toEqual(before);
    expect(createWorkflowsRepository(connection.db).list()).toEqual([existing]);
  });
});
