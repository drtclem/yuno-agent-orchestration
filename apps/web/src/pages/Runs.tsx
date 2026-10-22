import { useQuery } from '@tanstack/react-query';
import type { Run } from '@yuno/shared';
import { Link } from 'react-router';
import { money, monitorApi } from '../api/monitor.js';
import { EmptyState } from '../components/EmptyState.js';
import { RequestError } from '../components/forms.js';
export const activeRun = (run: Run) =>
  ['queued', 'running', 'waiting_approval'].includes(run.status);
export function RunList({ runs }: { runs: Run[] }) {
  return (
    <ul className="run-list">
      {runs.map((run) => (
        <li className="panel" key={run.id}>
          <div className="actions">
            <Link to={`/runs/${run.id}`}>{run.input || run.id}</Link>
            <span className="pill">{run.status.replaceAll('_', ' ')}</span>
          </div>
          <p>
            {run.trigger} · {run.totalTokens.toLocaleString()} tokens ·{' '}
            {money(run.totalCostUsd)} estimated
          </p>
          {run.error && <p role="alert">{run.error}</p>}
        </li>
      ))}
    </ul>
  );
}
export function Runs() {
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: ({ signal }) => monitorApi.runs(signal),
  });
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">Execution history</p>
        <h1>Runs</h1>
        <p>Follow workflows, scheduled turns, and conversations.</p>
      </div>
      <RequestError error={runs.error} retry={() => void runs.refetch()} />
      {runs.isPending && <p role="status">Loading runs…</p>}
      {runs.data?.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Load a template and start your first workflow."
        />
      )}
      {runs.data && <RunList runs={runs.data} />}
    </>
  );
}
