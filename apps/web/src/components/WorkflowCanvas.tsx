import { buildGraphEdges } from './graph-edges.js';
import { workflowNodeTypes } from './WorkflowNode.js';
import { useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  type ReactFlowInstance,
  type Node,
  type Edge,
} from '@xyflow/react';
import type { Agent, WorkflowGraph } from '@yuno/shared';
import '@xyflow/react/dist/style.css';

export function WorkflowCanvas({
  graph,
  agents,
  onChange,
  selectEdge,
  selectNode,
  disabled,
}: {
  graph: WorkflowGraph;
  agents: Agent[];
  onChange: (graph: WorkflowGraph) => void;
  selectEdge: (id: string) => void;
  selectNode: (id: string) => void;
  disabled: boolean;
}) {
  const [flow, setFlow] = useState<ReactFlowInstance<Node, Edge>>();
  function add(
    agentId: string,
    position = {
      x: 80 + graph.nodes.length * 40,
      y: 80 + graph.nodes.length * 40,
    },
  ) {
    if (disabled) return;
    const agent = agents.find((item) => item.id === agentId);
    if (!agent) return;
    const id = crypto.randomUUID();
    onChange({
      ...graph,
      startNodeId: graph.startNodeId || id,
      nodes: [...graph.nodes, { id, agentId, label: agent.name, position }],
    });
    selectNode(id);
  }
  const nodes: Node[] = graph.nodes.map((node) => {
    const agent = agents.find((item) => item.id === node.agentId);
    return {
      id: node.id,
      position: node.position,
      data: {
        label: (
          <>
            <strong>{node.label}</strong>
            <span>{agent?.name ?? 'Missing agent'}</span>
            <span>{agent?.role}</span>
            <small>{agent?.model}</small>
            {node.requiresApproval && (
              <span className="badge">Requires approval</span>
            )}
            {node.id === graph.startNodeId && <span>Start</span>}
          </>
        ),
      },
    };
  });
  const edges = buildGraphEdges(graph);
  return (
    <div className="workflow-layout">
      <aside className="panel agent-palette">
        <h2>Agents</h2>
        <p>Drag an agent onto the canvas, or use Add.</p>
        {agents.length === 0 && (
          <p>Create an agent or load a template first.</p>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            draggable={!disabled}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/yuno-agent', agent.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
          >
            <strong>{agent.name}</strong>
            <small>{agent.role}</small>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => add(agent.id)}
              aria-label={`Add ${agent.name}`}
            >
              Add
            </button>
          </div>
        ))}
      </aside>
      <div
        className="workflow-canvas"
        aria-label="Workflow canvas"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (flow)
            add(
              event.dataTransfer.getData('application/yuno-agent'),
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
        }}
      >
        {/* https://reactflow.dev/learn/concepts/adding-interactivity — controlled domain graph; never persist canvas internals. */}
        <ReactFlow
          nodeTypes={workflowNodeTypes}
          nodes={nodes}
          edges={edges}
          onInit={setFlow}
          fitView
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          deleteKeyCode={null}
          onNodeClick={(_event, node) => selectNode(node.id)}
          onEdgeClick={(_event, edge) => selectEdge(edge.id)}
          onNodesChange={(changes) => {
            if (disabled) return;
            const moved = applyNodeChanges(changes, nodes);
            if (changes.some((change) => change.type === 'position'))
              onChange({
                ...graph,
                nodes: graph.nodes.map((node) => ({
                  ...node,
                  position:
                    moved.find((item) => item.id === node.id)?.position ??
                    node.position,
                })),
              });
          }}
          onConnect={(connection) => {
            if (!disabled)
              onChange({
                ...graph,
                edges: [
                  ...graph.edges,
                  {
                    id: crypto.randomUUID(),
                    source: connection.source,
                    target: connection.target,
                    condition: 'always',
                  },
                ],
              });
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
