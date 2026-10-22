import { useId, type ReactNode } from 'react';
import { z } from 'zod';
import { ApiError } from '../api/client.js';

export function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof z.ZodError)
    return Object.fromEntries(
      error.issues.map((issue) => [issue.path.join('.'), issue.message]),
    );
  if (error instanceof ApiError) return error.fields;
  return {};
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: (attributes: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': error ? `${id}-error` : undefined,
      })}
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function RequestError({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  return error ? (
    <div className="notice" role="alert">
      <span>{error.message}</span>
      {retry && <button onClick={retry}>Retry</button>}
    </div>
  ) : null;
}
