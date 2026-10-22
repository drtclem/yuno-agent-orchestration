import { useState } from 'react';
import type { WorkflowGraph } from '@yuno/shared';
import { Field } from './forms.js';
import { EdgeConditionPicker } from './EdgeConditionPicker.js';

export function WorkflowInspectors({
  graph,
  changeGraph,
  edgeId,
  setEdgeId,
  nodeId,
  setNodeId,
  disabled,
}: {
  graph: WorkflowGraph;
  changeGraph: (graph: WorkflowGraph) => void;
  edgeId: string | undefined;
  setEdgeId: (id: string | undefined) => void;
  nodeId: string | undefined;
  setNodeId: (id: string | undefined) => void;
  disabled: boolean;
}) {
  const edge = graph.edges.find((item) => item.id === edgeId);
  const node = graph.nodes.find((item) => item.id === nodeId);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  return (
    <div className="workflow-inspectors">
      <section className="panel">
        <h2>Steps</h2>
        <p>Select a step to configure it.</p>
        <div className="actions">
          {graph.nodes.map((item) => (
            <button
              className="secondary"
              key={item.id}
              onClick={() => setNodeId(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {node && (
          <fieldset disabled={disabled} className="form-grid">
            <Field label="Step label">
              {(attrs) => (
                <input
                  {...attrs}
                  value={node.label}
                  onChange={(e) =>
                    changeGraph({
                      ...graph,
                      nodes: graph.nodes.map((item) =>
                        item.id === node.id
                          ? { ...item, label: e.target.value }
                          : item,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <Field label="Step instructions">
              {(attrs) => (
                <textarea
                  {...attrs}
                  value={node.instructions ?? ''}
                  onChange={(e) =>
                    changeGraph({
                      ...graph,
                      nodes: graph.nodes.map((item) =>
                        item.id === node.id
                          ? { ...item, instructions: e.target.value }
                          : item,
                      ),
                    })
                  }
                />
              )}
            </Field>
            <label>
              <input
                type="checkbox"
                checked={node.requiresApproval ?? false}
                onChange={(e) =>
                  changeGraph({
                    ...graph,
                    nodes: graph.nodes.map((item) =>
                      item.id === node.id
                        ? { ...item, requiresApproval: e.target.checked }
                        : item,
                    ),
                  })
                }
              />
              Requires approval
            </label>
            <button
              className="secondary"
              onClick={() => {
                changeGraph({
                  ...graph,
                  nodes: graph.nodes.filter((item) => item.id !== node.id),
                  edges: graph.edges.filter(
                    (item) =>
                      item.source !== node.id && item.target !== node.id,
                  ),
                });
                setNodeId(undefined);
              }}
            >
              Remove step
            </button>
          </fieldset>
        )}
      </section>
      <section className="panel">
        <h2>Edges</h2>
        <p>
          Connect handles on the canvas. Conditions are evaluated in the order
          below; the first match wins.
        </p>
        <fieldset disabled={disabled} className="form-grid">
          <Field label="From step">
            {(attrs) => (
              <select
                {...attrs}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Choose source</option>
                {graph.nodes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="To step">
            {(attrs) => (
              <select
                {...attrs}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose target</option>
                {graph.nodes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <button
            className="secondary"
            disabled={
              !graph.nodes.some((item) => item.id === source) ||
              !graph.nodes.some((item) => item.id === target)
            }
            onClick={() => {
              const id = crypto.randomUUID();
              changeGraph({
                ...graph,
                edges: [
                  ...graph.edges,
                  { id, source, target, condition: 'always' },
                ],
              });
              setEdgeId(id);
            }}
          >
            Connect steps
          </button>
        </fieldset>
        <ol>
          {graph.edges.map((item) => (
            <li key={item.id}>
              <button
                className="secondary"
                aria-label={`Select edge ${item.id}`}
                onClick={() => setEdgeId(item.id)}
              >
                {graph.nodes.find((n) => n.id === item.source)?.label} →{' '}
                {graph.nodes.find((n) => n.id === item.target)?.label} ·{' '}
                {typeof item.condition === 'string'
                  ? item.condition
                  : `contains: ${item.condition.contains}`}
              </button>
            </li>
          ))}
        </ol>
        {edge && (
          <>
            <EdgeConditionPicker
              value={edge.condition}
              disabled={disabled}
              onChange={(condition) =>
                changeGraph({
                  ...graph,
                  edges: graph.edges.map((item) =>
                    item.id === edge.id ? { ...item, condition } : item,
                  ),
                })
              }
            />
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => {
                changeGraph({
                  ...graph,
                  edges: graph.edges.filter((item) => item.id !== edge.id),
                });
                setEdgeId(undefined);
              }}
            >
              Remove edge
            </button>
          </>
        )}
      </section>
    </div>
  );
}
