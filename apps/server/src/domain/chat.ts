import {
  ChatInputSchema,
  InboundMessageSchema,
  type Message,
  type Run,
} from '@yuno/shared';
import type { openDatabase } from '../db/client.js';
import { createChatRepository } from '../db/repos/chat.js';
import type { ChannelAdapter, InboundMessage } from '../channels/types.js';
import type { EventHub } from '../events/hub.js';
import type { createEngine } from './engine.js';

export function createChat({
  db,
  hub,
  engine,
  channel,
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub: EventHub;
  engine: ReturnType<typeof createEngine>;
  channel?: ChannelAdapter;
}) {
  const repo = createChatRepository(db);
  const handles = new Map<string, { conversationId: string; handle: string }>();
  const pending = new Set<Promise<void>>();
  let unsubscribe: (() => void) | undefined;
  let running = false;
  let started = false;
  let lifecycle = Promise.resolve();
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let lastStatus = '';
  const status = () =>
    channel?.status() ?? { connected: false, detail: 'not configured' };
  const publishStatus = () => {
    const current = status();
    const serialized = JSON.stringify(current);
    if (serialized === lastStatus) return;
    lastStatus = serialized;
    hub.publish({
      type: 'channel.status',
      ts: Date.now(),
      data: { type: 'slack', ...current },
    });
  };
  function failure(runId: string | null, event = 'channel_delivery_failed') {
    const ts = Date.now();
    hub.publish({
      type: 'log',
      ts,
      data: {
        id: crypto.randomUUID(),
        ts,
        level: 'error',
        agentId: null,
        runId,
        event,
        data: {},
      },
    });
  }
  function deliver(run: Run) {
    const target = handles.get(run.id);
    if (
      !target ||
      !channel ||
      !['completed', 'failed', 'cancelled'].includes(run.status)
    )
      return;
    handles.delete(run.id);
    // shortcut: handles are process-local; use an outbox if delivery must survive a crash after commit.
    const delivery = Promise.resolve()
      .then(() =>
        channel.updateMessage(
          target.conversationId,
          target.handle,
          run.status === 'completed'
            ? run.result || '(empty reply)'
            : `Turn failed: ${run.error ?? run.status}`,
        ),
      )
      .catch(() => failure(run.id));
    pending.add(delivery);
    void delivery.then(
      () => pending.delete(delivery),
      () => pending.delete(delivery),
    );
  }
  async function receive(raw: InboundMessage) {
    const input = InboundMessageSchema.parse(raw);
    const binding = repo.binding();
    if (!running || !binding) return;
    engine.startChat({ ...input, agentId: binding.agentId });
  }
  function reload() {
    lifecycle = lifecycle
      .catch(() => {})
      .then(async () => {
        if (!channel) {
          publishStatus();
          return;
        }
        try {
          if (running && repo.binding()) {
            if (!started) {
              started = true;
              await channel.start(receive);
            }
          } else if (started) {
            await channel.stop();
            started = false;
          }
        } catch {
          started = false;
          await channel.stop().catch(() => {});
          failure(null, 'channel_connection_failed');
        }
        publishStatus();
      });
    return lifecycle;
  }
  return {
    status,
    receive,
    reload,
    testChat(agentId: string, raw: unknown) {
      const input = ChatInputSchema.parse(raw);
      const conversationId =
        input.conversationId ?? `ui:${agentId}:${crypto.randomUUID()}`;
      const run = engine.startChat({
        agentId,
        conversationId,
        channel: 'ui',
        externalEventId: `ui:${crypto.randomUUID()}`,
        userId: 'ui',
        userName: 'You (UI)',
        text: input.text,
      });
      return { run, conversationId };
    },
    async start() {
      if (running) return;
      running = true;
      engine.setChatDelivery(async (message: Message) => {
        if (
          !channel ||
          !message.conversationId ||
          !message.runId ||
          !channel.status().connected
        )
          throw new Error('channel_unavailable');
        if (handles.has(message.runId)) return;
        const handle = await channel.postPlaceholder(
          message.conversationId,
          'thinking…',
        );
        handles.set(message.runId, {
          conversationId: message.conversationId,
          handle,
        });
        const current = engine.detail(message.runId);
        if (current) deliver(current);
      });
      if (channel)
        unsubscribe = hub.subscribe((event) => {
          if (
            event.type !== 'run.updated' ||
            !['completed', 'failed', 'cancelled'].includes(event.data.status)
          )
            return;
          deliver(event.data);
        });
      await reload();
      if (channel) statusTimer = setInterval(publishStatus, 1000);
    },
    async stop() {
      running = false;
      clearInterval(statusTimer);
      statusTimer = undefined;
      await lifecycle;
      unsubscribe?.();
      unsubscribe = undefined;
      engine.setChatDelivery(undefined);
      await Promise.allSettled([...pending]);
      await channel?.stop();
      started = false;
      handles.clear();
    },
  };
}
