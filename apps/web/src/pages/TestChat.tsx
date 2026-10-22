import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ApprovalSchema,
  ChatInputSchema,
  MessageSchema,
  RunSchema,
  RunStepSchema,
} from '@yuno/shared';
import { z } from 'zod';
import { Link } from 'react-router';
import { configurationApi } from '../api/configuration.js';
import { Field, RequestError, fieldErrors } from '../components/forms.js';

const RunDetailSchema = RunSchema.extend({
  steps: RunStepSchema.array(),
  messages: MessageSchema.array(),
  approvals: ApprovalSchema.array(),
});
const ChatResponseSchema = z.object({
  run: RunSchema,
  conversationId: z.string(),
});
export function TestChat({ id }: { id: string }) {
  const [text, setText] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = useQuery({
    queryKey: ['runs', runId],
    queryFn: ({ signal }) =>
      configurationApi.get(`/runs/${runId}`, RunDetailSchema, signal),
    enabled: !!runId,
    refetchInterval: (query) =>
      query.state.data &&
      ['completed', 'failed', 'cancelled'].includes(query.state.data.status)
        ? false
        : 1000,
  });
  const messages = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ signal }) =>
      configurationApi.get(
        `/messages?conversationId=${encodeURIComponent(conversationId ?? '')}`,
        MessageSchema.array(),
        signal,
      ),
    enabled: !!conversationId,
    refetchInterval: 1000,
  });
  const send = useMutation({
    mutationFn: () =>
      configurationApi.write(
        `/agents/${id}/chat`,
        ChatResponseSchema,
        ChatInputSchema.parse({
          text,
          ...(conversationId ? { conversationId } : {}),
        }),
      ),
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setRunId(result.run.id);
      setText('');
    },
    onError: (error) => setErrors(fieldErrors(error)),
  });
  const busy =
    send.isPending ||
    (!!runId &&
      (!run.data ||
        ['queued', 'running', 'waiting_approval'].includes(run.data.status)));
  return (
    <section className="panel">
      <h2>Test chat</h2>
      <p>Send a message to test this agent with its saved configuration.</p>
      {!conversationId && (
        <p>No messages yet. Send your first message below.</p>
      )}
      <ol aria-label="Conversation">
        {messages.data?.map((message) => (
          <li className="chat-message" key={message.id}>
            <strong>
              {message.fromKind === 'human'
                ? (message.fromName ?? message.fromId)
                : message.fromKind === 'agent'
                  ? 'Agent'
                  : 'System'}
            </strong>
            <p className="chat-message">{message.content}</p>
            {message.error && <p role="alert">{message.error}</p>}
          </li>
        ))}
      </ol>
      <RequestError
        error={messages.error}
        retry={() => void messages.refetch()}
      />
      <RequestError error={run.error} retry={() => void run.refetch()} />
      {run.data && (
        <p role="status">
          Run: {run.data.status}
          {run.data.error ? ` — ${run.data.error}` : ''}
        </p>
      )}
      {run.data?.status === 'waiting_approval' && (
        <p>
          <Link to="/approvals">Review pending approval</Link>
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const result = ChatInputSchema.safeParse({
            text,
            ...(conversationId ? { conversationId } : {}),
          });
          setErrors(result.success ? {} : fieldErrors(result.error));
          if (result.success) send.mutate();
        }}
      >
        <Field label="Message" error={errors.text}>
          {(attrs) => (
            <textarea
              {...attrs}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              disabled={send.isPending}
            />
          )}
        </Field>
        <button disabled={busy}>Send message</button>
        <RequestError error={send.error} />
      </form>
    </section>
  );
}
