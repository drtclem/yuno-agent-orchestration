import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './index.js';

describe('T0 shared scaffold (R-31 shared validation boundary)', () => {
  it('accepts the health response', () => {
    expect(healthResponseSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it('rejects a malformed health response', () => {
    expect(healthResponseSchema.safeParse({ ok: 'true' }).success).toBe(false);
  });
});
