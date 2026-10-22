import type { Edge } from '@xyflow/react';
import type { WorkflowGraph } from '@yuno/shared';

export function buildGraphEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    const backward = source && target && target.position.x < source.position.x;
    return {
      ...edge,
      type: 'smoothstep',
      sourceHandle: backward ? 'bottom-source' : 'right',
      targetHandle: backward ? 'bottom-target' : 'left',
      pathOptions: { offset: 40 },
      label:
        typeof edge.condition === 'string'
          ? edge.condition
          : `contains: ${edge.condition.contains}`,
      className: `condition-${typeof edge.condition === 'string' ? edge.condition : 'contains'}`,
      labelShowBg: true,
      labelBgPadding: [8, 5],
      labelBgBorderRadius: 4,
    };
  });
}
