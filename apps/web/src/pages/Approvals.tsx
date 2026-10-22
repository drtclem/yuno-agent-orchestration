import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { ApprovalActions } from '../components/ApprovalActions.js';
import { EmptyState } from '../components/EmptyState.js';
import { RequestError } from '../components/forms.js';
export function Approvals() {
  const approvals = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: ({ signal }) => api.pendingApprovals(signal),
  });
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">Human decisions</p>
        <h1>Approvals</h1>
        <p>
          Review step gates and tool requests. Requests expire after 30 minutes.
        </p>
      </div>
      <RequestError
        error={approvals.error}
        retry={() => void approvals.refetch()}
      />
      {approvals.isPending && <p role="status">Loading approvals…</p>}
      {approvals.data?.length === 0 && (
        <EmptyState
          title="No pending approvals"
          description="You're all caught up. Start a workflow from a template."
        />
      )}
      {approvals.data?.map((approval) => (
        <ApprovalActions key={approval.id} approval={approval} />
      ))}
    </>
  );
}
