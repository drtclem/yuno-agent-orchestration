import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { workflowApi } from '../api/workflows.js';
import { RequestError } from '../components/forms.js';
import { EmptyState } from '../components/EmptyState.js';

export function Templates() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['templates'],
    queryFn: ({ signal }) => workflowApi.templates(signal),
  });
  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => workflowApi.list(signal),
  });
  const load = useMutation({
    mutationFn: workflowApi.load,
    onSuccess: (workflow) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflows/${workflow.id}`);
    },
  });
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Templates</h1>
          <p>Load a starting point, then make the workflow yours.</p>
        </div>
      </header>
      <RequestError error={query.error} retry={() => void query.refetch()} />
      <RequestError error={load.error} />
      <RequestError
        error={workflows.error}
        retry={() => void workflows.refetch()}
      />
      {query.isPending && <p role="status">Loading templates…</p>}
      {query.data?.length === 0 && (
        <EmptyState
          title="No templates available"
          description="Create a workflow with your existing agents."
          to="/workflows/new"
          action="Create workflow"
        />
      )}
      <div className="agent-grid">
        {query.data?.map((template) => {
          const existing = workflows.data?.find(
            (workflow) => workflow.templateId === template.id,
          );
          return (
            <article className="panel" key={template.id}>
              <h2>{template.name}</h2>
              <p>{template.description}</p>
              <p>{template.agents.map((agent) => agent.name).join(' → ')}</p>
              {existing && (
                <Link className="button" to={`/workflows/${existing.id}`}>
                  Open existing
                </Link>
              )}
              <button
                className={existing ? 'secondary' : undefined}
                disabled={load.isPending || !workflows.data}
                aria-label={
                  existing
                    ? `Load a copy of ${template.name}`
                    : `Load ${template.name}`
                }
                onClick={() => load.mutate(template.id)}
              >
                {load.isPending && load.variables === template.id
                  ? 'Loading…'
                  : existing
                    ? 'Load a copy'
                    : 'Load'}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
