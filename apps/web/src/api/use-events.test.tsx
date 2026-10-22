// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEvents } from './use-events.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const agentId = '00000000-0000-4000-8000-000000000001';
function setup() {
  const client = new QueryClient();
  for (const key of [
    ['agents'],
    ['agents', agentId],
    ['runs'],
    ['health'],
    ['usage'],
  ]) {
    client.setQueryData(key, 'cached');
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useEvents(), { wrapper });
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('The SSE hook did not create an EventSource');
  return { ...hook, client, source };
}
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T15 SSE query invalidation (R-29)', () => {
  it('invalidates matching agent queries without invalidating unrelated queries', () => {
    const { source, client } = setup();
    expect(source.url).toBe('/api/events');
    act(() =>
      source.emit({
        type: 'agent.status',
        ts: 1,
        data: { agentId, status: 'working' },
      }),
    );
    expect(client.getQueryState(['agents'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['agents', agentId])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['runs'])?.isInvalidated).toBe(false);
    expect(client.getQueryState(['health'])?.isInvalidated).toBe(false);
  });

  it('refreshes cached queries on open and reconnect and exposes connection state', () => {
    const { source, result, client } = setup();
    expect(result.current.status).toBe('connecting');
    act(() => source.onopen?.());
    expect(result.current.status).toBe('connected');
    expect(client.getQueryState(['runs'])?.isInvalidated).toBe(true);
    act(() => source.onerror?.());
    expect(result.current.status).toBe('reconnecting');
    client.setQueryData(['runs'], 'fresh');
    act(() => source.onopen?.());
    expect(result.current.status).toBe('connected');
    expect(client.getQueryState(['runs'])?.isInvalidated).toBe(true);
  });

  it('ignores malformed events and reports a visible error', () => {
    const { source, result, client } = setup();
    act(() => source.onmessage?.({ data: '{broken' }));
    expect(result.current.error).toBeTruthy();
    act(() =>
      source.emit({
        type: 'agent.status',
        ts: 1,
        data: { agentId, status: 'unknown' },
      }),
    );
    expect(client.getQueryState(['agents'])?.isInvalidated).toBe(false);
    expect(result.current.logs).toEqual([]);
  });

  it('retains only the last 500 validated logs and closes on unmount', () => {
    const { source, result, unmount } = setup();
    act(() => {
      for (let index = 0; index < 501; index++) {
        source.emit({
          type: 'log',
          ts: index,
          data: {
            id: agentId,
            ts: index,
            level: 'info',
            agentId: null,
            runId: null,
            event: `event-${index}`,
            data: {},
          },
        });
      }
    });
    expect(result.current.logs).toHaveLength(500);
    expect(result.current.logs[0]?.event).toBe('event-1');
    expect(result.current.logs.at(-1)?.event).toBe('event-500');
    unmount();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
