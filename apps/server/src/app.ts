import { LogQuerySchema } from '@yuno/shared';
import type { ChannelAdapter } from './channels/types.js';
import { createChat } from './domain/chat.js';
import { registerChatRoutes } from './api/chat.js';
import { createScheduler } from './domain/scheduler.js';
import { createTemplates } from './domain/templates.js';
import { registerTemplateRoutes } from './api/templates.js';
import { resolve } from 'node:path';
import { createEngine } from './domain/engine.js';
import { registerWorkflowRoutes } from './api/workflows.js';
import type { AgentRuntime } from './runtime/types.js';
import { createRuntimeHealth } from './domain/health.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { extname } from 'node:path';
import type { openDatabase } from './db/client.js';
import { registerConfigurationRoutes } from './api/configuration.js';
import { registerEventRoutes } from './api/events.js';
import { createEventHub, type EventHub } from './events/hub.js';
import { createLogsRepository } from './db/repos/logs.js';

export function buildApp({
  db,
  runtime,
  channel,
  webDir,
  dataDir = resolve('data'),
  hub = createEventHub(createLogsRepository(db)),
}: {
  db: ReturnType<typeof openDatabase>['db'];
  hub?: EventHub;
  runtime?: AgentRuntime;
  channel?: ChannelAdapter;
  webDir?: string;
  dataDir?: string;
}) {
  const app = Fastify();
  if (webDir) {
    // https://github.com/fastify/fastify-static#usage
    app.register(fastifyStatic, { root: resolve(webDir) });
    app.setNotFoundHandler((request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        pathname !== '/api' &&
        !pathname.startsWith('/api/') &&
        !pathname.startsWith('/assets/') &&
        !extname(pathname)
      )
        return reply.sendFile('index.html', { maxAge: 0 });
      return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
    });
  }
  const runtimeHealth = runtime ? createRuntimeHealth(runtime) : undefined;
  app.get('/api/health', async () => {
    if (!runtimeHealth) return { ok: true };
    const status = await runtimeHealth();
    return { ok: status.ok, runtime: status, slack: chat.status() };
  });
  app.get('/api/logs', (request) =>
    createLogsRepository(db).latest(LogQuerySchema.parse(request.query).limit),
  );
  registerEventRoutes(app, hub);
  const engine = createEngine({ db, hub, runtime, dataDir });
  const chat = createChat({ db, hub, engine, ...(channel ? { channel } : {}) });
  registerChatRoutes(app, chat);
  const scheduler = createScheduler({ db, hub, engine });
  registerConfigurationRoutes(app, db, scheduler.reload, chat.reload);
  registerWorkflowRoutes(app, engine);
  registerTemplateRoutes(app, createTemplates(db));
  app.addHook('onReady', async () => {
    await chat.start();
    await engine.start();
    scheduler.start();
  });
  // Stop active turns before index.ts closes SQLite in onClose.
  // https://fastify.dev/docs/latest/Reference/Hooks/#preclose
  app.addHook('preClose', async () => {
    scheduler.stop();
    await engine.stop();
    await chat.stop();
  });
  return app;
}
