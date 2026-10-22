import { workflowApi } from '../api/workflows.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Approval } from '@yuno/shared';
import { Link } from 'react-router';
import { monitorApi } from '../api/monitor.js';
import { RequestError } from './forms.js';
export function ApprovalActions({ approval }: { approval: Approval }) {
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => workflowApi.agents(signal),
  });
  const decision = useMutation({
    mutationFn: (value: 'approve' | 'reject') =>
      monitorApi.decide(approval.id, value),
    // https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations
    onSuccess: async () => {
      await Promise.all(
        ['approvals', 'runs', 'agents'].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['approvals'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  return (
    <article className="panel approval-banner">
      <h2>
        {approval.kind === 'step_gate' ? 'Step approval' : 'Tool permission'}
      </h2>
      <p className="chat-message">{approval.detail}</p>
      <p>
        Agent{' '}
        <span className="mono">
          {agents.data?.find((agent) => agent.id === approval.agentId)?.name ??
            approval.agentId}
        </span>{' '}
        · <Link to={`/runs/${approval.runId}`}>View run</Link>
      </p>
      <p>
        Expires {new Date(approval.createdAt + 30 * 60_000).toLocaleString()}
      </p>
      <div className="actions">
        <button
          disabled={decision.isPending || approval.status !== 'pending'}
          onClick={() => decision.mutate('approve')}
        >
          Approve
        </button>
        <button
          className="secondary"
          disabled={decision.isPending || approval.status !== 'pending'}
          onClick={() => decision.mutate('reject')}
        >
          Reject
        </button>
      </div>
      <RequestError error={decision.error} />
    </article>
  );
}
