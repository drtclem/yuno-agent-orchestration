import { buildGraphEdges } from './graph-edges.js';
import { workflowNodeTypes } from './WorkflowNode.js';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import type { Approval, RunStep, WorkflowGraph } from '@yuno/shared';
import '@xyflow/react/dist/style.css';
export function RunGraph({
  graph,
  steps,
  approvals,
}: {
  graph: WorkflowGraph;
  steps: RunStep[];
  approvals: Approval[];
}) {
  const nodes = graph.nodes.map((node) => {
    const step = steps
      .filter((item) => item.nodeId === node.id)
      .sort(
        (a, b) => b.iteration - a.iteration || b.startedAt - a.startedAt,
      )[0];
    const waiting =
      step &&
      approvals.some(
        (item) => item.stepId === step.id && item.status === 'pending',
      );
    const status = waiting
      ? 'waiting approval'
      : (step?.status ?? 'not started');
    return {
      id: node.id,
      position: node.position,
      className: `run-node state-${waiting ? 'waiting' : (step?.status ?? 'idle')}`,
      ariaLabel: `${node.label}: ${status}`,
      data: {
        label: (
          <>
            <strong>{node.label}</strong>
            <span>{status}</span>
            {step && <small>Iteration {step.iteration}</small>}
          </>
        ),
      },
    };
  });
  const edges = buildGraphEdges(graph);
  // https://reactflow.dev/api-reference/react-flow — disable graph edits while retaining pan/zoom.
  return (
    <div className="workflow-canvas" aria-label="Live run graph">
      <ReactFlow
        nodeTypes={workflowNodeTypes}
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
