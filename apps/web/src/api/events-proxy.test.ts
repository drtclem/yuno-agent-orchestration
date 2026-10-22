import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config.js';

describe('T15 development SSE transport (R-29)', () => {
  it('keeps the event stream connected through idle time before the 15 second heartbeat', async () => {
    const upstream = createHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      const heartbeat = setTimeout(
        () => response.write(': heartbeat\n\n'),
        6000,
      );
      response.on('close', () => clearTimeout(heartbeat));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = Object.entries(config.server?.proxy ?? {}).find(([prefix]) =>
      '/api/events'.startsWith(prefix),
    )?.[1];
    if (!proxy || typeof proxy === 'string')
      throw new Error('Expected /api proxy options');
    const vite = await createServer({
      configFile: false,
      server: {
        host: '127.0.0.1',
        port: 0,
        proxy: {
          '/api': { ...proxy, target: `http://127.0.0.1:${upstreamPort}` },
        },
      },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      await vite.listen();
      const address = vite.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected Vite TCP listener');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/events`,
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected streaming response');
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain(': heartbeat');
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await vite.close();
      upstream.closeAllConnections();
      upstream.close();
      await once(upstream, 'close');
    }
  }, 12_000);
});
