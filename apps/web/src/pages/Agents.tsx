import { useQuery } from '@tanstack/react-query';
import {
  AgentSchema,
  ModelSchema,
  ChannelBindingSchema,
  type Agent,
} from '@yuno/shared';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { configurationApi as apiConfig } from '../api/configuration.js';
import { EmptyState } from '../components/EmptyState.js';
import { RequestError } from '../components/forms.js';

function AgentCard({ agent, slack }: { agent: Agent; slack: string }) {
  const channel = useQuery({
    queryKey: ['agents', agent.id, 'channels'],
    queryFn: ({ signal }) =>
      apiConfig.get(
        `/agents/${agent.id}/channels`,
        ChannelBindingSchema.nullable(),
        signal,
      ),
  });
  return (
    <article className="panel agent-card">
      <div className="actions">
        <h2>
          <Link to={`/agents/${agent.id}`}>{agent.name}</Link>
        </h2>
        <span className="pill">{agent.status.replaceAll('_', ' ')}</span>
      </div>
      <p>{agent.role}</p>
      <p className="mono">
        {agent.model}
        {!ModelSchema.safeParse(agent.model).success &&
          ' · unavailable — pick another'}
      </p>
      <p>
        <span aria-hidden="true">♯ </span>Slack binding:{' '}
        {channel.isPending
          ? 'loading'
          : channel.isError
            ? 'unavailable'
            : channel.data?.enabled
              ? 'enabled'
              : channel.data
                ? 'disabled'
                : 'unbound'}
      </p>
      <p className="footnote">Slack: {slack}</p>
      <RequestError
        error={channel.error}
        retry={() => void channel.refetch()}
      />
    </article>
  );
}
export function Agents() {
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) =>
      apiConfig.get('/agents', AgentSchema.array(), signal),
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
  });
  const slack = health.isPending
    ? 'checking'
    : health.isError
      ? 'unavailable'
      : health.data.slack?.connected
        ? 'connected'
        : (health.data.slack?.detail ?? 'not configured');
  return (
    <>
      <div className="page-heading actions">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Agents</h1>
          <p>Configure the people and tools behind your workflows.</p>
        </div>
        <Link className="button" to="/agents/new">
          Create agent
        </Link>
      </div>
      <RequestError error={agents.error} retry={() => void agents.refetch()} />
      {agents.isPending && <p role="status">Loading agents…</p>}
      {agents.data?.length === 0 && (
        <EmptyState
          title="Create your first agent"
          description="Give an agent a role, tools, and instructions to begin."
          action="Create agent"
          to="/agents/new"
        />
      )}
      <div className="card-grid">
        {agents.data?.map((agent) => (
          <AgentCard key={agent.id} agent={agent} slack={slack} />
        ))}
      </div>
    </>
  );
}
