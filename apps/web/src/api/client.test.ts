import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('T15 typed API boundary (R-29, R-31)', () => {
  it('calls the API prefix and validates the returned payload', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 2 })));
    vi.stubGlobal('fetch', fetch);
    await expect(
      apiRequest('/example', z.object({ value: z.number() })),
    ).resolves.toEqual({ value: 2 });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/example');
    await expect(
      apiRequest('/example', z.object({ value: z.string() })),
    ).rejects.toThrow();
  });
  it('surfaces HTTP failures instead of accepting an error response as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })),
    );
    await expect(apiRequest('/example', z.unknown())).rejects.toThrow();
  });
  it('bounds a stalled external request with a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      ),
    );
    const request = apiRequest('/example', z.unknown());
    const outcome = expect(request).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_001);
    await outcome;
  });
});
