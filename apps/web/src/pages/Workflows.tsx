import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { workflowApi } from '../api/workflows.js';
import { RequestError } from '../components/forms.js';
import { EmptyState } from '../components/EmptyState.js';

export function Workflows() {
  const query = useQuery({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => workflowApi.list(signal),
  });
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Workflows</h1>
          <p>Connect agents, review decisions, and bound feedback loops.</p>
        </div>
        <div className="actions">
          <Link to="/templates">Load a template</Link>
          <Link className="button" to="/workflows/new">
            Create workflow
          </Link>
        </div>
      </header>
      <RequestError error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <p role="status">Loading workflows…</p>}
      {query.data?.length === 0 && (
        <EmptyState
          title="Build your first workflow"
          description="Start with a ready-made pipeline and customize its agents and conditions."
          to="/templates"
          action="Load a template"
        />
      )}
      <div className="agent-grid">
        {query.data?.map((workflow) => (
          <article className="panel" key={workflow.id}>
            <h2>
              <Link to={`/workflows/${workflow.id}`}>{workflow.name}</Link>
            </h2>
            <p>{workflow.description}</p>
            <p>
              {workflow.graph.nodes.length} steps ·{' '}
              {workflow.graph.maxIterations} turns per node
            </p>
          </article>
        ))}
      </div>
    </>
  );
}
