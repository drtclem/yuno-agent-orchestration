import { useContext, useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChannelBindingSchema, type Agent } from '@yuno/shared';
import { Link } from 'react-router';
import { LiveEventsContext } from '../LiveEventsContext.js';
import { configurationApi } from '../api/configuration.js';
import { money, monitorApi } from '../api/monitor.js';
import { workflowApi } from '../api/workflows.js';
import { MessageTrail } from '../components/MessageTrail.js';
import { EmptyState } from '../components/EmptyState.js';
import { RequestError } from '../components/forms.js';
import { activeRun, RunList } from './Runs.js';
const today = () => {
  const date = new Date();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
function MonitorAgent({
  agent,
  cost,
}: {
  agent: Agent;
  cost: number | undefined;
}) {
  const channel = useQuery({
    queryKey: ['agents', agent.id, 'channels'],
    queryFn: ({ signal }) =>
      configurationApi.get(
        `/agents/${agent.id}/channels`,
        ChannelBindingSchema.nullable(),
        signal,
      ),
  });
  return (
    <article className="panel agent-card">
      <div className="actions">
        <h3>
          <Link to={`/agents/${agent.id}`}>{agent.name}</Link>
        </h3>
        <span className={`pill status-${agent.status}`}>
          {agent.status.replaceAll('_', ' ')}
        </span>
      </div>
      <p>{agent.role}</p>
      <p>
        ♯ Slack:{' '}
        {channel.isError
          ? 'unavailable'
          : channel.isPending
            ? 'loading'
            : channel.data?.enabled
              ? 'enabled'
              : channel.data
                ? 'disabled'
                : 'unbound'}
      </p>
      <p>
        Today (UTC):{' '}
        {cost === undefined ? 'unavailable' : `${money(cost)} estimated`}
      </p>
      <RequestError
        error={channel.error}
        retry={() => void channel.refetch()}
      />
    </article>
  );
}
function ActiveProgress({ id }: { id: string }) {
  const run = useQuery({
    queryKey: ['runs', id],
    queryFn: ({ signal }) => monitorApi.detail(id, signal),
  });
  return (
    <div className="run-progress">
      {run.data && (
        <p>
          {run.data.steps.filter((step) => step.status === 'completed').length}{' '}
          completed turns ·{' '}
          {run.data.steps.filter((step) => step.status === 'running').length}{' '}
          running ·{' '}
          {
            run.data.approvals.filter(
              (approval) => approval.status === 'pending',
            ).length
          }{' '}
          pending approvals
        </p>
      )}
      {run.isPending && <p>Loading progress…</p>}
      <RequestError error={run.error} retry={() => void run.refetch()} />
    </div>
  );
}
export function Monitor() {
  const live = useContext(LiveEventsContext);
  const [since, setSince] = useState(today);
  useEffect(() => {
    const timer = setInterval(() => setSince(today()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => workflowApi.agents(signal),
  });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: ({ signal }) => monitorApi.runs(signal),
  });
  const messages = useQuery({
    queryKey: ['messages'],
    queryFn: ({ signal }) => monitorApi.messages(signal),
  });
  const recentMessages = messages.data?.slice(-50).reverse() ?? [];
  // Share cached details with active progress: https://tanstack.com/query/latest/docs/framework/react/reference/useQueries
  const details = useQueries({
    queries: [
      ...new Set(
        recentMessages.flatMap((message) =>
          message.runId ? [message.runId] : [],
        ),
      ),
    ].map((id) => ({
      queryKey: ['runs', id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        monitorApi.detail(id, signal),
    })),
  });
  const persistedLogs = useQuery({
    queryKey: ['logs'],
    queryFn: ({ signal }) => monitorApi.logs(signal),
  });
  const logs = [
    ...new Map(
      [...(persistedLogs.data ?? []), ...(live?.logs ?? [])].map((log) => [
        log.id,
        log,
      ]),
    ).values(),
  ]
    .sort((a, b) => a.ts - b.ts)
    .slice(-500);
  const usage = useQuery({
    queryKey: ['usage', 'agent', since],
    queryFn: ({ signal }) => monitorApi.usage(since, signal),
  });
  const active = runs.data?.filter(activeRun);
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">Control room</p>
        <h1>Monitor</h1>
        <p>Agents, handoffs, and decisions as they happen.</p>
      </div>
      <section className="panel">
        <h2>Today's usage (UTC)</h2>
        <RequestError error={usage.error} retry={() => void usage.refetch()} />
        {usage.isPending && <p role="status">Loading usage…</p>}
        {usage.data && (
          <p>
            {usage.data
              .reduce((sum, row) => sum + row.totalTokens, 0)
              .toLocaleString()}{' '}
            tokens ·{' '}
            {money(usage.data.reduce((sum, row) => sum + row.costUsd, 0))}{' '}
            estimated cost
          </p>
        )}
      </section>
      <section>
        <h2>Agents</h2>
        <RequestError
          error={agents.error}
          retry={() => void agents.refetch()}
        />
        {agents.isPending && <p role="status">Loading agents…</p>}
        {agents.data?.length === 0 && (
          <EmptyState
            title="Start with a workflow"
            description="Load a template to bring agents into your workspace."
          />
        )}
        <div className="card-grid">
          {agents.data?.map((agent) => (
            <MonitorAgent
              key={agent.id}
              agent={agent}
              cost={
                usage.data && !usage.isError
                  ? (usage.data.find((row) => row.agentId === agent.id)
                      ?.costUsd ?? 0)
                  : undefined
              }
            />
          ))}
        </div>
      </section>
      <section>
        <div className="actions">
          <h2>Active runs</h2>
          <Link to="/runs">All runs</Link>
        </div>
        <RequestError error={runs.error} retry={() => void runs.refetch()} />
        {runs.isPending && <p role="status">Loading runs…</p>}
        {active?.length === 0 && (
          <EmptyState
            title="No active runs"
            description="Choose a workflow template and start a run."
          />
        )}
        {active?.map((run) => (
          <div key={run.id}>
            <RunList runs={[run]} />
            <ActiveProgress id={run.id} />
          </div>
        ))}
      </section>
      <section>
        <h2>Recent messages</h2>
        <RequestError
          error={messages.error}
          retry={() => void messages.refetch()}
        />
        {messages.isPending && <p role="status">Loading messages…</p>}
        {messages.data?.length === 0 && (
          <p>No messages yet. Start a workflow or chat with an agent.</p>
        )}
        {details.map((detail, index) => (
          <RequestError
            key={index}
            error={detail.error}
            retry={() => void detail.refetch()}
          />
        ))}
        {messages.data && (
          <MessageTrail
            messages={recentMessages}
            conversationMessages={messages.data}
            steps={details.flatMap((detail) => detail.data?.steps ?? [])}
            agents={agents.data ?? []}
          />
        )}
      </section>
      <section className="panel">
        <h2>Live logs</h2>
        <p className="footnote">
          The last 200 persisted logs are loaded on open. Up to 500 events are
          kept while this workspace is open.
        </p>
        <RequestError
          error={persistedLogs.error}
          retry={() => void persistedLogs.refetch()}
        />
        {persistedLogs.isPending && (
          <p role="status">Loading persisted logs…</p>
        )}
        {!logs.length && (
          <p>No live log events yet. Start a workflow to see activity.</p>
        )}
        <ol className="live-logs" aria-label="Live logs">
          {logs.map((log) => (
            <li key={log.id}>
              <time>{new Date(log.ts).toLocaleTimeString()}</time> {log.level} ·{' '}
              {log.event}{' '}
              {log.runId && (
                <Link to={`/runs/${log.runId}`}>Run {log.runId}</Link>
              )}{' '}
              <span>{JSON.stringify(log.data)}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
