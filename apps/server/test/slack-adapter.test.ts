import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSlackChannel } from '../src/channels/slack/index.js';

const fake = vi.hoisted(() => ({
  process: undefined as
    | ((event: { body: unknown; ack: () => Promise<void> }) => Promise<void>)
    | undefined,
  socketEvents: new Map<string, () => void>(),
  info: vi.fn<
    (input: { user: string }) => Promise<{
      ok: boolean;
      user?: {
        profile?: { display_name?: string; real_name?: string };
        real_name?: string;
      };
    }>
  >(),
  auth: vi.fn<() => Promise<{ user_id?: string }>>(),
  post: vi.fn<() => Promise<{ ts?: string }>>(),
  update: vi.fn<() => Promise<void>>(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  options: vi.fn(),
  events: new Map<string, (input: { body: unknown }) => Promise<void>>(),
}));
vi.mock('@slack/bolt', () => ({
  LogLevel: { ERROR: 'error' },
  SocketModeReceiver: class {
    client = {
      on: (name: string, listener: () => void) => {
        fake.socketEvents.set(name, listener);
      },
    };
  },
  App: class {
    constructor(options: unknown) {
      fake.options(options);
      fake.process = this.processEvent.bind(this);
    }
    async processEvent(event: { body: unknown; ack: () => Promise<void> }) {
      await event.ack();
      const parsed = event.body as { event?: { type?: string } };
      const handler = fake.events.get(parsed.event?.type ?? '');
      await handler?.({ body: event.body });
    }
    client = {
      auth: { test: fake.auth },
      users: { info: fake.info },
      chat: { postMessage: fake.post, update: fake.update },
    };
    event(name: string, handler: (input: { body: unknown }) => Promise<void>) {
      fake.events.set(name, handler);
    }
    error() {}
    start = fake.start;
    stop = fake.stop;
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.events.clear();
  fake.socketEvents.clear();
  fake.process = undefined;
  fake.info.mockResolvedValue({
    ok: true,
    user: { profile: { display_name: 'Taylor' } },
  });
  fake.auth.mockResolvedValue({ user_id: 'B1' });
  fake.post.mockResolvedValue({ ts: '123.456' });
  fake.update.mockResolvedValue();
  fake.start.mockResolvedValue();
  fake.stop.mockResolvedValue();
});
afterEach(() => vi.useRealTimers());
const adapter = () =>
  createSlackChannel({ botToken: 'test-bot', appToken: 'test-app' });

describe('T13 Slack external boundary (R-18)', () => {
  it('R-18 configures 15 second SDK calls without retries and replaces a thread placeholder', async () => {
    const channel = adapter();
    await channel.start(async () => {});
    expect(fake.options).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOptions: {
          timeout: 15000,
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
        },
      }),
    );
    const handle = await channel.postPlaceholder(
      'slack:T1:C1:123.000',
      'thinking…',
    );
    expect(handle).toBe('123.456');
    expect(fake.post).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '123.000',
        text: 'thinking…',
      }),
    );
    await channel.updateMessage('slack:T1:C1:123.000', handle, 'Reply');
    expect(fake.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: handle,
      text: 'Reply',
    });
    await channel.stop();
    expect(channel.status().connected).toBe(false);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
  it('R-18 a Socket Mode startup timeout stops the receiver and exposes a failed status', async () => {
    fake.start.mockImplementation(() => new Promise<void>(() => {}));
    const channel = adapter();
    const result = expect(channel.start(async () => {})).rejects.toThrow(
      'slack_connection_failed',
    );
    await vi.advanceTimersByTimeAsync(15000);
    await result;
    expect(channel.status()).toEqual({
      connected: false,
      detail: 'connection failed',
    });
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
  it('R-18 failed authentication cleans up and exposes a sanitized connection failure', async () => {
    fake.auth.mockRejectedValue(new Error('private-token-bearing-error'));
    const channel = adapter();
    await expect(channel.start(async () => {})).rejects.toThrow(
      'slack_connection_failed',
    );
    expect(channel.status()).toEqual({
      connected: false,
      detail: 'connection failed',
    });
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
  it('R-18 acknowledges a Slack event only after durable inbound acceptance and never after rejection', async () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('./fixtures/slack-events.json', import.meta.url),
        'utf8',
      ),
    );
    const body: unknown =
      raw && typeof raw === 'object' ? Reflect.get(raw, 'dm') : undefined;
    let accept: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let rejectInbound = false;
    let received = 0;
    const channel = adapter();
    await channel.start(async () => {
      received++;
      await gate;
      if (rejectInbound) throw new Error('database_unavailable');
    });
    const process = fake.process;
    if (!process || !accept) throw new Error('missing_receiver');
    const ack = vi.fn<() => Promise<void>>().mockResolvedValue();
    const delivery = process({ body, ack });
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    accept();
    await delivery;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(received).toBe(1);
    ack.mockClear();
    rejectInbound = true;
    await expect(process({ body, ack })).rejects.toThrow(
      'database_unavailable',
    );
    expect(ack).not.toHaveBeenCalled();
  });
  it('R-18 reconnect events update connection status and late events cannot revive a stopped receiver', async () => {
    const channel = adapter();
    await channel.start(async () => {});
    fake.socketEvents.get('reconnecting')?.();
    expect(channel.status()).toEqual({
      connected: false,
      detail: 'reconnecting',
    });
    fake.socketEvents.get('connected')?.();
    expect(channel.status().connected).toBe(true);
    fake.socketEvents.get('error')?.();
    expect(channel.status()).toEqual({
      connected: false,
      detail: 'connection failed',
    });
    fake.socketEvents.get('disconnected')?.();
    expect(channel.status().connected).toBe(false);
    await channel.start(async () => {});
    expect(fake.options).toHaveBeenCalledTimes(1);
    await channel.stop();
    fake.socketEvents.get('connected')?.();
    expect(channel.status().connected).toBe(false);
  });
});

const dm = (text: string, eventId = 'Ev-name') => ({
  team_id: 'T1',
  event_id: eventId,
  event: {
    type: 'message',
    channel_type: 'im',
    channel: 'D1',
    user: 'U1',
    text,
    ts: '1700000000.000001',
  },
});
describe('T24 Slack human names and markup (R-19/R-23)', () => {
  it('R-19/R-23 resolves and caches sender and mention names before delivering normalized input', async () => {
    fake.info.mockImplementation(async ({ user }) => ({
      ok: true,
      user: {
        profile: { display_name: user === 'U1' ? 'Taylor Clements' : 'Alex' },
      },
    }));
    const receive = vi.fn();
    const channel = adapter();
    await channel.start(receive);
    if (!fake.process) throw new Error('missing_receiver');
    for (const eventId of ['Ev-first', 'Ev-second'])
      await fake.process({
        body: dm('Hi <@U2> <@U2> <https://x|site> &amp; <@U1>', eventId),
        ack: async () => {},
      });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        userName: 'Taylor Clements',
        text: 'Hi @Alex @Alex site (https://x) & @Taylor Clements',
      }),
    );
    expect(fake.info).toHaveBeenCalledTimes(2);
    expect(fake.info).toHaveBeenCalledWith({ user: 'U1' });
    expect(fake.info).toHaveBeenCalledWith({ user: 'U2' });
  });
  it('R-19/R-23 falls back to IDs on users.info error and still delivers inbound input', async () => {
    fake.info.mockRejectedValue(new Error('external_failure'));
    const receive = vi.fn();
    const channel = adapter();
    await channel.start(receive);
    if (!fake.process) throw new Error('missing_receiver');
    await fake.process({ body: dm('Hi <@U2>'), ack: async () => {} });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'U1', text: 'Hi @U2' }),
    );
  });
  it('R-19/R-23 sender and mention timeouts together delay delivery by at most 15 seconds', async () => {
    fake.info.mockImplementation(() => new Promise(() => {}));
    const receive = vi.fn();
    const channel = adapter();
    await channel.start(receive);
    if (!fake.process) throw new Error('missing_receiver');
    const delivery = fake.process({
      body: dm('Hi <@U2> <@U3>'),
      ack: async () => {},
    });
    await vi.advanceTimersByTimeAsync(14999);
    expect(receive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await delivery;
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'U1', text: 'Hi @U2 @U3' }),
    );
  });
});

describe('T24 Slack lookup response fallback (R-19/R-23)', () => {
  it.each([
    [
      {
        ok: true,
        user: { profile: { display_name: '', real_name: 'Taylor Real' } },
      },
      'Taylor Real',
    ],
    [{ ok: false }, 'U1'],
    [{ ok: true }, 'U1'],
  ])(
    'R-19/R-23 uses real name or ID when display name is unavailable',
    async (result, name) => {
      fake.info.mockResolvedValue(result);
      const receive = vi.fn();
      const channel = adapter();
      await channel.start(receive);
      if (!fake.process) throw new Error('missing_receiver');
      await fake.process({ body: dm('Hello'), ack: async () => {} });
      expect(receive).toHaveBeenCalledWith(
        expect.objectContaining({ userName: name, text: 'Hello' }),
      );
    },
  );
});

describe('T24 bounded Slack name cache (R-19/R-23)', () => {
  it('R-19/R-23 evicts old users after 256 names and clears names on stop', async () => {
    const channel = adapter();
    await channel.start(async () => {});
    const deliver = async (user: string) => {
      if (!fake.process) throw new Error('missing_receiver');
      const body = dm('Hello', `Ev-${user}`);
      body.event.user = user;
      await fake.process({ body, ack: async () => {} });
    };
    await deliver('U0');
    await deliver('U0');
    expect(fake.info).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 256; index++) await deliver(`U${index}`);
    await deliver('U0');
    expect(
      fake.info.mock.calls.filter(([input]) => input.user === 'U0'),
    ).toHaveLength(2);
    await channel.stop();
    await channel.start(async () => {});
    await deliver('U0');
    expect(
      fake.info.mock.calls.filter(([input]) => input.user === 'U0'),
    ).toHaveLength(3);
  });
});
