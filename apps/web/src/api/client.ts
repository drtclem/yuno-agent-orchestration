import { ApprovalSchema } from '@yuno/shared';
import { z } from 'zod';

// Matches /api/health, including unhealthy and unconfigured responses.
const HealthSchema = z.object({
  ok: z.boolean(),
  runtime: z
    .object({ ok: z.boolean(), version: z.string().optional() })
    .optional(),
  slack: z
    .object({ connected: z.boolean(), detail: z.string().optional() })
    .optional(),
});

export class ApiError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
const ErrorSchema = z.object({
  message: z.string(),
  errors: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional(),
  workflowNames: z.array(z.string()).optional(),
});

export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Request timed out after 15 seconds')),
    15_000,
  );
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
    });
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (parsed.success)
        throw new ApiError(
          `${parsed.data.message}${parsed.data.workflowNames?.length ? `: ${parsed.data.workflowNames.join(', ')}` : ''}`,
          Object.fromEntries(
            parsed.data.errors?.map((issue) => [issue.field, issue.message]) ??
              [],
          ),
        );
      throw new Error(`Request failed (${response.status})`);
    }
    return schema.parse(
      response.status === 204 ? undefined : await response.json(),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  health: (signal?: AbortSignal) =>
    apiRequest('/health', HealthSchema, signal ? { signal } : {}),
  pendingApprovals: (signal?: AbortSignal) =>
    apiRequest(
      '/approvals?status=pending',
      ApprovalSchema.array(),
      signal ? { signal } : {},
    ),
};
