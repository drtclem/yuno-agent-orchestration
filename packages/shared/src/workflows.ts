import { z } from 'zod';
import { AgentInputSchema } from './agents.ts';

const text = z.string().trim().min(1);
const NodeSchema = z.strictObject({
  id: text,
  agentId: z.uuid(),
  label: text,
  instructions: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  position: z.strictObject({ x: z.number(), y: z.number() }),
});
const EdgeSchema = z.strictObject({
  id: text,
  source: text,
  target: text,
  condition: z.union([
    z.enum(['always', 'approved', 'rejected']),
    z.strictObject({ contains: text }),
  ]),
});
export const WorkflowGraphSchema = z.strictObject({
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema),
  startNodeId: text,
  maxIterations: z.int().positive().default(6),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

// Accept raw input so save/run boundaries receive field errors as well as graph errors.
export function validateGraph(
  input: unknown,
  existingAgentIds: readonly string[],
): string[] {
  const parsed = WorkflowGraphSchema.safeParse(input);
  if (!parsed.success)
    return parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
  const graph = parsed.data;
  const errors: string[] = [];
  const nodes = new Set<string>();
  const agents = new Set(existingAgentIds);
  const edges = new Set<string>();
  const outgoing = new Map<string, typeof graph.edges>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    nodes.add(node.id);
    if (!agents.has(node.agentId))
      errors.push(`Unknown agent: ${node.agentId}`);
  }
  if (!nodes.has(graph.startNodeId))
    errors.push(`Unknown start node: ${graph.startNodeId}`);
  for (const edge of graph.edges) {
    if (edges.has(edge.id)) errors.push(`Duplicate edge id: ${edge.id}`);
    edges.add(edge.id);
    if (!nodes.has(edge.source))
      errors.push(`Unknown edge source: ${edge.source}`);
    if (!nodes.has(edge.target))
      errors.push(`Unknown edge target: ${edge.target}`);
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  for (const [source, list] of outgoing) {
    if (list.filter((edge) => edge.condition === 'always').length > 1)
      errors.push(`Multiple always edges: ${source}`);
  }
  const visited = new Set<string>();
  const pending = [graph.startNodeId];
  let hasEnd = false;
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (id === undefined || !nodes.has(id) || visited.has(id)) continue;
    visited.add(id);
    const list = outgoing.get(id) ?? [];
    if (list.length === 0) hasEnd = true;
    for (const edge of list) pending.push(edge.target);
  }
  if (!hasEnd) errors.push('No end node is reachable from the start');
  return errors;
}
export const WorkflowSchema = z.strictObject({
  id: z.uuid(),
  name: text,
  description: z.string(),
  graph: WorkflowGraphSchema,
  templateId: text.nullable(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
});
const TemplateGraphSchema = WorkflowGraphSchema.extend({
  nodes: z
    .array(NodeSchema.omit({ agentId: true }).extend({ agentName: text }))
    .min(1),
});
export const TemplateSchema = z
  .strictObject({
    id: text,
    name: text,
    description: z.string(),
    agents: z.array(AgentInputSchema).min(1),
    graph: TemplateGraphSchema,
  })
  .superRefine((template, ctx) => {
    const names = template.agents.map((agent) => agent.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: 'custom',
        path: ['agents'],
        message: 'Duplicate agent names',
      });
    // Reuse structural graph validation without inventing persistent IDs for template agents.
    const placeholder = '00000000-0000-4000-8000-000000000000';
    const graph = {
      ...template.graph,
      nodes: template.graph.nodes.map(({ agentName, ...node }) => {
        if (!names.includes(agentName))
          ctx.addIssue({
            code: 'custom',
            path: ['graph', 'nodes'],
            message: `Unknown agent name: ${agentName}`,
          });
        return { ...node, agentId: placeholder };
      }),
    };
    for (const message of validateGraph(graph, [placeholder]))
      ctx.addIssue({ code: 'custom', path: ['graph'], message });
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Template = z.infer<typeof TemplateSchema>;
