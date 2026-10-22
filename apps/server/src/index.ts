import { createSlackChannel } from './channels/slack/index.js';
import { createFakeRuntime } from './runtime/fake/index.js';
import { createOpenCodeRuntime } from './runtime/opencode/index.js';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDatabase } from './db/client.js';

let app: ReturnType<typeof buildApp> | undefined;
try {
  const database = openDatabase(join(config.DATA_DIR, 'yuno.db'));
  const runtime =
    config.RUNTIME === 'opencode'
      ? createOpenCodeRuntime({ db: database.db, baseUrl: config.OPENCODE_URL })
      : createFakeRuntime();
  app = buildApp({
    db: database.db,
    runtime,
    dataDir: config.DATA_DIR,
    ...(config.WEB_DIR ? { webDir: config.WEB_DIR } : {}),
    ...(config.SLACK_BOT_TOKEN && config.SLACK_APP_TOKEN
      ? {
          channel: createSlackChannel({
            botToken: config.SLACK_BOT_TOKEN,
            appToken: config.SLACK_APP_TOKEN,
          }),
        }
      : {}),
  });
  app.addHook('onClose', () => database.close());
  await app.listen({ port: config.PORT, host: config.HOST });
} catch {
  await app?.close();
  console.error('Server failed to start');
  process.exitCode = 1;
}
