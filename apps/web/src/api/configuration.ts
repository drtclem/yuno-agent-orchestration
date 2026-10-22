import { z } from 'zod';
import { apiRequest } from './client.js';

export const configurationApi = {
  get: <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) =>
    apiRequest(path, schema, signal ? { signal } : {}),
  write: <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    method = 'POST',
  ) =>
    apiRequest(path, schema, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
};
