import { afterEach, describe, expect, it } from 'vitest';
import type { Log } from '@yuno/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createLogsRepository } from '../src/db/repos/logs.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const connection = openDatabase(':memory:');
  const app = buildApp({ db: connection.db, runtime: createFakeRuntime() });
  cleanups.push(async () => {
    await app.close();
    connection.close();
  });
  const logs = createLogsRepository(connection.db);
  const records: Log[] = Array.from({ length: 505 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    ts: 1000 + index,
    level: 'info',
    agentId: null,
    runId: null,
    event: `persisted.${index}`,
    data: {},
  }));
  // Deliberately insert out of timestamp order, so row order cannot satisfy this test.
  for (const record of [...records].reverse()) logs.insert(record);
  return { app, records };
}
describe('T23 persisted logs API (R-22)', () => {
  it('R-22 defaults to the last 200 persisted logs, newest last, and honors limits up to 500', async () => {
    const { app, records } = setup();
    for (const [query, limit] of [
      ['', 200],
      ['?limit=1', 1],
      ['?limit=500', 500],
    ] as const) {
      const response = await app.inject(`/api/logs${query}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(records.slice(-limit));
    }
  });
  it.each(['0', '-1', '501', '1.5', 'abc', '', 'Infinity'])(
    'R-22 rejects invalid limit %j',
    async (limit) => {
      const { app } = setup();
      expect((await app.inject(`/api/logs?limit=${limit}`)).statusCode).toBe(
        400,
      );
    },
  );
});
