import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { createFakeRuntime } from '../src/runtime/fake/index.js';

describe('T14 built web serving (R-30)', () => {
  it('R-30 serves the built app, assets and client routes alongside fake runtime health', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yuno-web-'));
    const webDir = join(directory, 'web');
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(
      join(webDir, 'index.html'),
      '<!doctype html><title>Yuno</title>',
    );
    await writeFile(join(webDir, 'assets', 'app.js'), 'window.yuno = true;');
    await writeFile(join(directory, 'private.txt'), 'outside-web-root');
    const database = openDatabase(':memory:');
    const app = buildApp({
      db: database.db,
      runtime: createFakeRuntime(),
      webDir,
    });
    try {
      for (const url of ['/', '/workflows/example']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('<title>Yuno</title>');
      }
      const asset = await app.inject('/assets/app.js');
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toMatch(/javascript/);
      expect(asset.body).toBe('window.yuno = true;');
      const health = await app.inject('/api/health');
      expect(health.statusCode).toBe(200);
      expect(health.json<unknown>()).toMatchObject({
        ok: true,
        runtime: { version: 'fake' },
      });
      for (const url of [
        '/api/missing',
        '/assets/missing.js',
        '/%2e%2e/private.txt',
      ]) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('outside-web-root');
      }
    } finally {
      await app.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
