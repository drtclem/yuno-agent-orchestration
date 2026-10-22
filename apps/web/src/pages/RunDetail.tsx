import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { money, monitorApi } from '../api/monitor.js';
import { workflowApi } from '../api/workflows.js';
import { ApprovalActions } from '../components/ApprovalActions.js';
import { MessageTrail } from '../components/MessageTrail.js';
import { RunGraph } from '../components/RunGraph.js';
import { RequestError } from '../components/forms.js';
import { activeRun } from './Runs.js';
export function RunDetail() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ['runs', id],
    queryFn: ({ signal }) => monitorApi.detail(id, signal),
  });
  const workflowId = run.data?.workflowId;
  const workflow = useQuery({
    queryKey: ['workflows', workflowId],
    queryFn: ({ signal }) => workflowApi.get(workflowId ?? '', signal),
    enabled: !!workflowId && !run.data?.graphSnapshot,
  });
  const graph = run.data?.graphSnapshot ?? workflow.data?.graph;
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => workflowApi.agents(signal),
  });
  const cancel = useMutation({
    mutationFn: () => monitorApi.cancel(id),
    onSuccess: async () => {
      await Promise.all(
        ['runs', 'approvals', 'agents'].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">Execution</p>
        <h1>Run detail</h1>
        <p className="mono">{id}</p>
      </div>
      <RequestError error={run.error} retry={() => void run.refetch()} />
      {run.isPending && <p role="status">Loading run…</p>}
      {run.data && (
        <>
          <section className="panel">
            <div className="actions">
              <h2>{run.data.input || 'Agent turn'}</h2>
              <span className="pill" role="status">
                {run.data.status.replaceAll('_', ' ')}
              </span>
              {activeRun(run.data) && (
                <button
                  className="secondary"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Cancel run
                </button>
              )}
            </div>
            <p>
              {run.data.totalTokens.toLocaleString()} tokens ·{' '}
              {money(run.data.totalCostUsd)} estimated cost
            </p>
            {run.data.error && <p role="alert">{run.data.error}</p>}
            {run.data.result && (
              <p className="chat-message">{run.data.result}</p>
            )}
            <RequestError error={cancel.error} />
          </section>
          {run.data.approvals
            .filter((approval) => approval.status === 'pending')
            .map((approval) => (
              <ApprovalActions key={approval.id} approval={approval} />
            ))}
          <RequestError
            error={workflow.error}
            retry={() => void workflow.refetch()}
          />
          {workflow.isPending && workflowId && !run.data.graphSnapshot && (
            <p role="status">Loading graph…</p>
          )}
          {graph && (
            <section>
              <h2>Live graph</h2>
              <p>
                Latest iteration per node.{' '}
                {run.data.graphSnapshot
                  ? 'Workflow definition captured at run start.'
                  : 'The workflow definition reflects its current saved configuration.'}
              </p>
              <RunGraph
                graph={graph}
                steps={run.data.steps}
                approvals={run.data.approvals}
              />
            </section>
          )}
          {!workflowId && (
            <p>This conversation or scheduled turn has no workflow graph.</p>
          )}
          <section>
            <h2>Steps</h2>
            {run.data.steps.length === 0 && <p>No steps yet.</p>}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Node / iteration</th>
                    <th>Status</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Estimated cost</th>
                    <th>Verdict / error</th>
                  </tr>
                </thead>
                <tbody>
                  {run.data.steps.map((step) => (
                    <tr key={step.id}>
                      <td>
                        {agents.data?.find((agent) => agent.id === step.agentId)
                          ?.name ?? step.agentId}{' '}
                        / {step.iteration}
                      </td>
                      <td>{step.status}</td>
                      <td>{step.inputTokens}</td>
                      <td>{step.outputTokens}</td>
                      <td>{money(step.costUsd)}</td>
                      <td>
                        {step.verdict}
                        {step.error && <span role="alert">{step.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {run.data.steps
              .filter((step) => step.output)
              .map((step) => (
                <details key={step.id}>
                  <summary>
                    {agents.data?.find((agent) => agent.id === step.agentId)
                      ?.name ?? step.agentId}{' '}
                    / {step.iteration} output
                  </summary>
                  <p className="chat-message">{step.output}</p>
                </details>
              ))}
          </section>
          <section>
            <h2>Message trail</h2>
            <RequestError
              error={agents.error}
              retry={() => void agents.refetch()}
            />
            {run.data.messages.length === 0 && <p>No messages yet.</p>}
            <MessageTrail
              messages={run.data.messages}
              agents={agents.data ?? []}
              steps={run.data.steps}
            />
          </section>
        </>
      )}
    </>
  );
}
