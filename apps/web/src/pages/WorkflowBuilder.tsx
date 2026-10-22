import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  WorkflowInputSchema,
  validateGraph,
  type Workflow,
  type WorkflowGraph,
  type Agent,
} from '@yuno/shared';
import { workflowApi } from '../api/workflows.js';
import { Field, RequestError, fieldErrors } from '../components/forms.js';
import { WorkflowCanvas } from '../components/WorkflowCanvas.js';
import { WorkflowInspectors } from '../components/WorkflowInspectors.js';
import { RunDialog } from '../components/RunDialog.js';

const empty = {
  name: '',
  description: '',
  graph: { nodes: [], edges: [], startNodeId: '', maxIterations: 6 },
};
export function WorkflowBuilder() {
  const { id } = useParams();
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => workflowApi.agents(signal),
  });
  const workflow = useQuery({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => workflowApi.get(id ?? '', signal),
    enabled: Boolean(id),
  });
  if (agents.isError || workflow.isError)
    return (
      <RequestError
        error={agents.error ?? workflow.error}
        retry={() => {
          void agents.refetch();
          if (id) void workflow.refetch();
        }}
      />
    );
  if (agents.isPending || (id && workflow.isPending))
    return <p role="status">Loading workflow…</p>;
  return (
    <Editor
      key={id ?? 'new'}
      initial={workflow.data}
      agents={agents.data ?? []}
    />
  );
}

function Editor({
  initial,
  agents,
}: {
  initial: Workflow | undefined;
  agents: Agent[];
}) {
  const [draft, setDraft] = useState(() =>
    initial
      ? {
          name: initial.name,
          description: initial.description,
          graph: initial.graph,
        }
      : empty,
  );
  const [saved, setSaved] = useState(() =>
    initial
      ? JSON.stringify({
          name: initial.name,
          description: initial.description,
          graph: initial.graph,
        })
      : '',
  );
  const [edgeId, setEdgeId] = useState<string>();
  const [nodeId, setNodeId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const client = useQueryClient();
  const graph = draft.graph;
  const validation = validateGraph(
    graph,
    agents.map((agent) => agent.id),
  );
  const dirty = JSON.stringify(draft) !== saved;
  const save = useMutation({
    mutationFn: () => workflowApi.save(initial?.id, draft),
    onSuccess: (workflow) => {
      const value = {
        name: workflow.name,
        description: workflow.description,
        graph: workflow.graph,
      };
      setDraft(value);
      setSaved(JSON.stringify(value));
      setErrors({});
      client.setQueryData(['workflows', workflow.id], workflow);
      void client.invalidateQueries({ queryKey: ['workflows'] });
      if (!initial) navigate(`/workflows/${workflow.id}`, { replace: true });
    },
    onError: (error) => setErrors(fieldErrors(error)),
  });
  function changeGraph(value: WorkflowGraph) {
    setDraft({ ...draft, graph: value });
  }
  return (
    <>
      <header className="page-header">
        <div>
          <Link to="/workflows">Workflows</Link>
          <h1>Workflow builder</h1>
          <p>
            {dirty
              ? 'Unsaved changes. Save before running or leaving this page.'
              : 'All changes saved.'}
          </p>
        </div>
        <div className="actions">
          <button
            disabled={save.isPending}
            onClick={() => {
              const result = WorkflowInputSchema.safeParse(draft);
              setErrors(result.success ? {} : fieldErrors(result.error));
              if (result.success && validation.length === 0) save.mutate();
            }}
          >
            {save.isPending ? 'Saving…' : 'Save workflow'}
          </button>
          <button
            className="secondary"
            disabled={
              !initial || dirty || save.isPending || validation.length > 0
            }
            onClick={() => setRunning(true)}
          >
            Run
          </button>
        </div>
      </header>
      <RequestError error={save.error} />
      <fieldset className="form-grid panel" disabled={save.isPending}>
        <Field label="Workflow name" error={errors.name}>
          {(attrs) => (
            <input
              {...attrs}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Description" error={errors.description}>
          {(attrs) => (
            <textarea
              {...attrs}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          )}
        </Field>
        <Field label="Max iterations">
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              min={1}
              step={1}
              value={graph.maxIterations || ''}
              onChange={(e) =>
                changeGraph({ ...graph, maxIterations: Number(e.target.value) })
              }
            />
          )}
        </Field>
        <Field label="Start node">
          {(attrs) => (
            <select
              {...attrs}
              value={graph.startNodeId}
              onChange={(e) =>
                changeGraph({ ...graph, startNodeId: e.target.value })
              }
            >
              <option value="">Choose a start node</option>
              {graph.nodes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>
      {validation.length > 0 && (
        <div className="notice" role="alert">
          <div>
            <strong>Workflow validation</strong>
            <ul>
              {validation.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {graph.nodes.length === 0 && (
        <p>
          No steps yet. Add an agent below or{' '}
          <Link to="/templates">load a template</Link>.
        </p>
      )}
      <WorkflowCanvas
        graph={graph}
        agents={agents}
        onChange={changeGraph}
        selectEdge={setEdgeId}
        selectNode={setNodeId}
        disabled={save.isPending}
      />
      <WorkflowInspectors
        graph={graph}
        changeGraph={changeGraph}
        edgeId={edgeId}
        setEdgeId={setEdgeId}
        nodeId={nodeId}
        setNodeId={setNodeId}
        disabled={save.isPending}
      />
      {running && initial && (
        <RunDialog workflowId={initial.id} onClose={() => setRunning(false)} />
      )}
    </>
  );
}
