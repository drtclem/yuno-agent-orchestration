import { describe, expect, it } from 'vitest';
import { WorkflowGraphSchema } from '@yuno/shared';
import { buildGraphEdges } from './graph-edges.js';

const graph = WorkflowGraphSchema.parse({
  startNodeId: 'coder',
  maxIterations: 6,
  nodes: [
    {
      id: 'coder',
      agentId: '00000000-0000-4000-8000-000000000001',
      label: 'Coder',
      position: { x: 0, y: 0 },
    },
    {
      id: 'reviewer',
      agentId: '00000000-0000-4000-8000-000000000002',
      label: 'Reviewer',
      position: { x: 300, y: 0 },
    },
  ],
  edges: [
    { id: 'forward', source: 'coder', target: 'reviewer', condition: 'always' },
    {
      id: 'feedback',
      source: 'reviewer',
      target: 'coder',
      condition: 'rejected',
    },
    {
      id: 'approved',
      source: 'coder',
      target: 'reviewer',
      condition: 'approved',
    },
    {
      id: 'contains',
      source: 'coder',
      target: 'reviewer',
      condition: { contains: 'ready 🌍' },
    },
  ],
});
describe('T23 shared graph edges (R-10)', () => {
  it('R-10 sends forward edges right to left and backward edges between bottom handles', () => {
    const edges = buildGraphEdges(graph);
    expect(edges.find((edge) => edge.id === 'forward')).toMatchObject({
      sourceHandle: 'right',
      targetHandle: 'left',
    });
    expect(edges.find((edge) => edge.id === 'feedback')).toMatchObject({
      sourceHandle: 'bottom-source',
      targetHandle: 'bottom-target',
      type: 'smoothstep',
    });
  });
  it('R-10 labels every condition with its condition class and preserves contains text', () => {
    const edges = buildGraphEdges(graph);
    for (const [id, condition, label] of [
      ['forward', 'always', 'always'],
      ['feedback', 'rejected', 'rejected'],
      ['approved', 'approved', 'approved'],
      ['contains', 'contains', 'contains: ready 🌍'],
    ]) {
      expect(edges.find((edge) => edge.id === id)).toMatchObject({
        className: `condition-${condition}`,
        label,
      });
    }
  });
});
