import type { FastifyInstance } from 'fastify';
import type { EventHub } from '../events/hub.js';

export function registerEventRoutes(app: FastifyInstance, hub: EventHub) {
  const clients = new Set<() => void>();
  // Close streams before Fastify waits for connections: https://fastify.dev/docs/latest/Reference/Hooks/#preclose
  app.addHook('preClose', (done) => {
    for (const close of clients) close();
    done();
  });
  app.get('/api/events', (_request, reply) => {
    // Raw SSE owns the response lifecycle: https://fastify.dev/docs/latest/Reference/Reply/#hijack
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const unsubscribe = hub.subscribe((event) =>
      write(`data: ${JSON.stringify(event)}\n\n`),
    );
    const timer = setInterval(() => write(': heartbeat\n\n'), 15000);
    timer.unref();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      clients.delete(close);
      response.end();
    }
    function write(frame: string) {
      if (closed) return;
      try {
        // No application queue for slow clients: https://nodejs.org/docs/latest-v24.x/api/http.html#responsewritechunk-encoding-callback
        if (!response.write(frame)) {
          close();
          response.destroy();
        }
      } catch {
        close();
        response.destroy();
      }
    }
    response.once('close', close);
    response.once('error', close);
    clients.add(close);
    write(': connected\n\n');
  });
}
