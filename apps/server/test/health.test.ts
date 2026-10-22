import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { buildApp } from '../src/app.js';

describe('T0 health endpoint (R-31 server boundary)', () => {
  it('GET /api/health returns { ok: true } with status 200', async () => {
    const database = openDatabase(':memory:');
    const app = buildApp({ db: database.db });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual({ ok: true });
    } finally {
      await app.close();
      database.close();
    }
  });
});
