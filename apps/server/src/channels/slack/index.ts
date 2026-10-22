import {
  App,
  SocketModeReceiver,
  LogLevel,
  type ReceiverEvent,
} from '@slack/bolt';
import { z } from 'zod';
import { InboundMessageSchema } from '@yuno/shared';
import { normalizeSlackText } from './normalize.js';
import type { ChannelAdapter, InboundMessage } from '../types.js';

const payloadSchema = z.object({
  team_id: z.string().regex(/^[A-Za-z0-9]+$/),
  event_id: z.string().min(1),
  event: z.object({
    type: z.enum(['message', 'app_mention']),
    channel: z.string().regex(/^[A-Za-z0-9]+$/),
    channel_type: z.string().optional(),
    user: z.string().min(1).optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string(),
    ts: z.string().regex(/^\d+\.\d+$/),
    thread_ts: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
  }),
});
// Event envelope and DM/mention shapes: https://docs.slack.dev/reference/events/app_mention/
export function mapSlackEvent(
  raw: unknown,
  botUserId: string,
): InboundMessage | undefined {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { event, team_id, event_id } = parsed.data;
  if (
    event.bot_id ||
    event.subtype ||
    !event.user ||
    event.user === botUserId ||
    (event.type === 'message' && event.channel_type !== 'im')
  )
    return undefined;
  const text =
    event.type === 'app_mention'
      ? event.text.split(`<@${botUserId}>`).join('').trim()
      : event.text.trim();
  const result = InboundMessageSchema.safeParse({
    channel: 'slack',
    externalEventId: event_id,
    conversationId: `slack:${team_id}:${event.channel}:${event.channel_type === 'im' ? 'dm' : (event.thread_ts ?? event.ts)}`,
    userId: event.user,
    text,
  });
  return result.success ? result.data : undefined;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('slack_timeout')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createSlackChannel(tokens: {
  botToken: string;
  appToken: string;
}): ChannelAdapter {
  let app: App | undefined;
  let connected = false;
  let detail = 'not connected';
  // shortcut: failed lookups stay cached until eviction or stop; expire failures if automatic retry is needed.
  const names = new Map<string, Promise<string>>();
  function address(conversationId: string) {
    const parts = conversationId.split(':');
    const channel = parts[2];
    const thread = parts[3];
    if (!channel || !thread) throw new Error('invalid_conversation');
    return { channel, ...(thread === 'dm' ? {} : { thread_ts: thread }) };
  }
  // SDK timeouts and retries: https://docs.slack.dev/tools/node-slack-sdk/reference/web-api/interfaces/WebClientOptions/
  const clientOptions = {
    timeout: 15000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  };
  // Do not let third-party error objects or debug logs expose tokens or full messages.
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    setLevel() {},
    getLevel: () => LogLevel.ERROR,
    setName() {},
  };
  return {
    type: 'slack',
    status: () => ({ connected, detail }),
    async start(onMessage) {
      if (app) return;
      let botUserId: string | undefined;
      const receiver = new SocketModeReceiver({
        appToken: tokens.appToken,
        logger,
        installerOptions: { clientOptions },
        processEventErrorHandler: async () => {
          detail = 'event processing failed';
          return false;
        },
      });
      // Bolt normally ACKs before listeners; durable acceptance must happen first.
      // https://docs.slack.dev/tools/bolt-js/concepts/receiver/
      class DurableSlackApp extends App {
        override async processEvent(event: ReceiverEvent) {
          const input = botUserId
            ? mapSlackEvent(event.body, botUserId)
            : undefined;
          if (input) {
            const ids = new Set([
              input.userId,
              ...Array.from(
                input.text.matchAll(/<@([A-Za-z0-9]+)>/g),
                (match) => match[1] ?? '',
              ),
            ]);
            const resolved = Object.fromEntries(
              await Promise.all(
                [...ids].map(async (id) => {
                  let lookup = names.get(id);
                  if (!lookup) {
                    // https://docs.slack.dev/reference/methods/users.info/ — profile names can be empty.
                    lookup = bounded(this.client.users.info({ user: id }))
                      .then((result) => {
                        if (!result.ok)
                          throw new Error('slack_user_lookup_failed');
                        return (
                          result.user?.profile?.display_name?.trim() ||
                          result.user?.profile?.real_name?.trim() ||
                          result.user?.real_name?.trim() ||
                          id
                        );
                      })
                      .catch(() => {
                        detail = 'user name lookup failed; using IDs';
                        return id;
                      });
                    names.set(id, lookup);
                    if (names.size > 256) {
                      const oldest = names.keys().next().value;
                      if (oldest !== undefined) names.delete(oldest);
                    }
                  }
                  return [id, await lookup];
                }),
              ),
            );
            await onMessage(
              InboundMessageSchema.parse({
                ...input,
                userName: resolved[input.userId] ?? input.userId,
                text: normalizeSlackText(input.text, resolved),
              }),
            );
          }
          await super.processEvent(event);
        }
      }
      app = new DurableSlackApp({
        token: tokens.botToken,
        receiver,
        clientOptions,
        logger,
        tokenVerificationEnabled: false,
      });
      const current = app;
      receiver.client.on('connected', () => {
        if (app !== current) return;
        connected = true;
        detail = 'connected';
      });
      receiver.client.on('disconnected', () => {
        if (app !== current) return;
        connected = false;
        detail = 'disconnected';
      });
      receiver.client.on('reconnecting', () => {
        if (app !== current) return;
        connected = false;
        detail = 'reconnecting';
      });
      receiver.client.on('error', () => {
        if (app !== current) return;
        connected = false;
        detail = 'connection failed';
      });
      try {
        const identity = await bounded(current.client.auth.test());
        botUserId = identity.user_id;
        if (!botUserId) throw new Error('slack_identity_missing');
        current.error(async () => {
          detail = 'event processing failed';
        });
        await bounded(current.start());
        connected = true;
        detail = 'connected';
      } catch {
        app = undefined;
        connected = false;
        detail = 'connection failed';
        await bounded(current.stop()).catch(() => {});
        throw new Error('slack_connection_failed');
      }
    },
    async postPlaceholder(conversationId, text) {
      if (!app || !connected) throw new Error('slack_disconnected');
      const result = await app.client.chat.postMessage({
        ...address(conversationId),
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!result.ts) throw new Error('slack_handle_missing');
      return result.ts;
    },
    async updateMessage(conversationId, handle, text) {
      if (!app || !connected) throw new Error('slack_disconnected');
      await app.client.chat.update({
        channel: address(conversationId).channel,
        ts: handle,
        text,
      });
    },
    async stop() {
      names.clear();
      const current = app;
      app = undefined;
      connected = false;
      detail = 'disconnected';
      if (current) await bounded(current.stop());
    },
  };
}
