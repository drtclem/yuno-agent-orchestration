import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SSEEventSchema, type Log, type SSEEvent } from '@yuno/shared';

const queries: Record<SSEEvent['type'], string[]> = {
  'agent.status': ['agents'],
  'run.updated': ['runs'],
  'step.updated': ['runs'],
  'message.created': ['messages', 'runs'],
  'message.updated': ['messages', 'runs'],
  'approval.created': ['approvals', 'runs'],
  'approval.resolved': ['approvals', 'runs'],
  usage: ['usage', 'runs', 'agents'],
  'channel.status': ['health'],
  log: [],
};

export function useEvents() {
  const client = useQueryClient();
  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'reconnecting'
  >('connecting');
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Native EventSource reconnects; REST refresh repairs gaps in this transient stream.
    // https://developer.mozilla.org/en-US/docs/Web/API/EventSource
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setStatus('connected');
      void client.invalidateQueries();
    };
    source.onerror = () => setStatus('reconnecting');
    source.onmessage = (message) => {
      let event: SSEEvent;
      try {
        event = SSEEventSchema.parse(JSON.parse(message.data as string));
      } catch {
        setError(
          'A live update could not be read. Refresh to load the latest state.',
        );
        return;
      }
      if (event.type === 'log')
        setLogs((previous) => [...previous, event.data].slice(-500));
      // Prefix matching also refreshes detail/filter queries: https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation
      for (const key of queries[event.type])
        void client.invalidateQueries({ queryKey: [key] });
    };
    return () => {
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.close();
    };
  }, [client]);
  return { status, logs, error };
}
