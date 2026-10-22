import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapSlackEvent } from '../src/channels/slack/index.js';

const fixtures: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/slack-events.json', import.meta.url),
    'utf8',
  ),
);
function fixture(name: string): unknown {
  if (!fixtures || typeof fixtures !== 'object' || !(name in fixtures))
    throw new Error('missing_fixture');
  return Reflect.get(fixtures, name);
}

describe('T13 recorded Slack event mapping without network (R-18/R-19)', () => {
  it('R-18 maps a direct message with a stable DM conversation', () => {
    expect(mapSlackEvent(fixture('dm'), 'B1')).toEqual({
      channel: 'slack',
      externalEventId: 'Ev-dm',
      conversationId: 'slack:T1:D1:dm',
      userId: 'U1',
      text: 'Hello 🌍',
    });
  });
  it('R-18 maps an app mention into its thread and removes the bot mention', () => {
    expect(mapSlackEvent(fixture('mention'), 'B1')).toEqual({
      channel: 'slack',
      externalEventId: 'Ev-mention',
      conversationId: 'slack:T1:C1:1700000000.000001',
      userId: 'U2',
      text: 'Please help',
    });
  });
  it('R-18 ignores bot messages and the bot own message to prevent reply loops', () => {
    expect(mapSlackEvent(fixture('bot'), 'B1')).toBeUndefined();
    expect(
      mapSlackEvent(
        {
          team_id: 'T1',
          event_id: 'own',
          event: {
            type: 'message',
            channel_type: 'im',
            channel: 'D1',
            user: 'B1',
            text: 'My reply',
            ts: '1.1',
          },
        },
        'B1',
      ),
    ).toBeUndefined();
  });
  it('R-18 ignores ordinary public messages, edits, and malformed payloads', () => {
    for (const event of [
      {
        type: 'message',
        channel_type: 'channel',
        channel: 'C1',
        user: 'U1',
        text: 'Not for bot',
        ts: '1.1',
      },
      {
        type: 'message',
        subtype: 'message_changed',
        channel_type: 'im',
        channel: 'D1',
        user: 'U1',
        text: 'Edited',
        ts: '1.1',
      },
    ])
      expect(
        mapSlackEvent({ team_id: 'T1', event_id: 'ignore', event }, 'B1'),
      ).toBeUndefined();
    for (const input of [
      null,
      {},
      { event: {} },
      { team_id: 'T1', event_id: 'bad', event: { type: 'message' } },
    ]) {
      expect(mapSlackEvent(input, 'B1')).toBeUndefined();
    }
  });
});
