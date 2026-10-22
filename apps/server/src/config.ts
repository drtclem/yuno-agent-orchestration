import { z } from 'zod';

export const config = z
  .object({
    RUNTIME: z.enum(['fake', 'opencode']).default('fake'),
    OPENCODE_URL: z.url().default('http://127.0.0.1:4096'),
    LIVE_TESTS: z.enum(['0', '1']).default('0'),
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_APP_TOKEN: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    WEB_DIR: z.string().trim().min(1).optional(),
    DATA_DIR: z.string().trim().min(1).default('data'),
  })
  .parse(process.env);
