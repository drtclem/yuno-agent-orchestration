import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
  AgentSchema,
  TemplateSchema,
  TemplateParamsSchema,
  WorkflowSchema,
  validateGraph,
} from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import { createAgentsRepository } from '../db/repos/agents.js';
import { createWorkflowsRepository } from '../db/repos/workflows.js';

export function createTemplates(
  db: ReturnType<typeof openDatabase>['db'],
  directory = new URL('../../../../templates/', import.meta.url),
) {
  const catalog = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const template = TemplateSchema.parse(
        JSON.parse(
          readFileSync(new URL(encodeURIComponent(name), directory), 'utf8'),
        ),
      );
      TemplateParamsSchema.parse({ id: template.id });
      return template;
    });
  if (new Set(catalog.map((template) => template.id)).size !== catalog.length)
    throw new Error('Duplicate template IDs');
  return {
    list: () => structuredClone(catalog),
    load(id: string) {
      const template = catalog.find((item) => item.id === id);
      if (!template)
        throw Object.assign(new Error('Template not found'), {
          statusCode: 404,
        });
      // https://orm.drizzle.team/docs/transactions — no partial agent creation on failure.
      return db.transaction((tx) => {
        const agents = createAgentsRepository(tx);
        const byName = new Map(
          agents.list().map((agent) => [agent.name, agent.id]),
        );
        const now = Date.now();
        for (const input of template.agents) {
          if (byName.has(input.name)) continue;
          const agent = AgentSchema.parse({
            ...input,
            id: randomUUID(),
            status: 'idle',
            createdAt: now,
            updatedAt: now,
          });
          agents.insert(agent);
          byName.set(agent.name, agent.id);
        }
        const workflows = createWorkflowsRepository(tx);
        const names = new Set(workflows.list().map((item) => item.name));
        let name = template.name;
        for (let copy = 2; names.has(name); copy++)
          name = `${template.name} (${copy})`;
        const workflow = WorkflowSchema.parse({
          id: randomUUID(),
          name,
          description: template.description,
          templateId: template.id,
          createdAt: now,
          updatedAt: now,
          graph: {
            ...template.graph,
            nodes: template.graph.nodes.map(({ agentName, ...node }) => ({
              ...node,
              agentId: byName.get(agentName),
            })),
          },
        });
        const errors = validateGraph(workflow.graph, [...byName.values()]);
        if (errors.length) throw new Error(errors.join('; '));
        workflows.insert(workflow);
        return workflow;
      });
    },
  };
}
