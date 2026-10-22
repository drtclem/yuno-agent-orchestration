import type { Agent, Message, RunStep } from '@yuno/shared';
export function MessageTrail({
  messages,
  agents,
  steps = [],
  conversationMessages = messages,
}: {
  messages: Message[];
  agents: Agent[];
  steps?: RunStep[];
  conversationMessages?: Message[];
}) {
  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id;
  return (
    <ol className="message-trail" aria-label="Message trail">
      {messages.map((message) => {
        const human =
          message.fromKind === 'agent' && message.conversationId
            ? (conversationMessages.find(
                (candidate) =>
                  candidate.fromKind === 'human' &&
                  candidate.conversationId === message.conversationId &&
                  candidate.runId === message.runId,
              ) ??
              conversationMessages
                .filter(
                  (candidate) =>
                    candidate.fromKind === 'human' &&
                    candidate.conversationId === message.conversationId &&
                    candidate.createdAt <= message.createdAt,
                )
                .sort((a, b) => b.createdAt - a.createdAt)[0])
            : undefined;
        const ordered = steps.filter((step) => step.runId === message.runId);
        const producer =
          message.idempotencyKey === `run:${message.runId}:start`
            ? -1
            : ordered.findIndex(
                (step) =>
                  message.idempotencyKey ===
                  `run:${message.runId}:step:${step.id}`,
              );
        const known =
          producer >= 0 ||
          message.idempotencyKey === `run:${message.runId}:start`;
        // Each completed turn produces the next handoff; failed retries belong to the same incoming message.
        const remaining = known ? ordered.slice(producer + 1) : [];
        const completed = remaining.findIndex(
          (step) => step.status === 'completed',
        );
        const consumer = remaining
          .slice(0, completed < 0 ? undefined : completed + 1)
          .findLast((step) => step.agentId === message.toAgentId);
        const outcome =
          consumer?.status === 'blocked' || consumer?.status === 'failed'
            ? consumer
            : undefined;
        return (
          <li className="panel" key={message.id}>
            <div className="actions">
              <strong>
                {message.fromKind === 'agent'
                  ? name(message.fromId)
                  : `${message.fromKind}: ${message.fromName ?? message.fromId}`}{' '}
                →{' '}
                {message.fromKind === 'agent' && message.conversationId
                  ? (human?.fromName ?? human?.fromId ?? 'Human')
                  : name(message.toAgentId)}
              </strong>
              <span className="badge">
                {message.channel === 'slack' ? 'Slack' : message.channel}
              </span>
              {outcome ? (
                <span className={`badge state-${outcome.status}`}>
                  {outcome.status}
                  {outcome.error && ` · ${outcome.error}`}
                </span>
              ) : (
                <span>{message.status}</span>
              )}
              {message.verdict && (
                <span className="badge">{message.verdict}</span>
              )}
            </div>
            <time dateTime={new Date(message.createdAt).toISOString()}>
              {new Date(message.createdAt).toLocaleString()}
            </time>
            <p className="chat-message">{message.content}</p>
            {message.error && <p role="alert">{message.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}
