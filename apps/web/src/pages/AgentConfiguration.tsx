import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ChannelBindingSchema,
  MemorySchema,
  MemoryInputSchema,
  ScheduleSchema,
  ScheduleInputSchema,
  SkillSchema,
  type Schedule,
} from '@yuno/shared';
import { configurationApi } from '../api/configuration.js';
import { fieldErrors } from '../components/forms.js';
import { api } from '../api/client.js';

export function AgentConfiguration({ id, tab }: { id: string; tab: string }) {
  if (tab === 'Channels') return <Channels id={id} />;
  if (tab === 'Schedules') return <Schedules id={id} />;
  if (tab === 'Memory') return <Memories id={id} />;
  return <AttachedSkills id={id} />;
}
function Failure({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  return error ? (
    <p role="alert">
      {error.message}{' '}
      {retry && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </p>
  ) : null;
}
function Channels({ id }: { id: string }) {
  const client = useQueryClient();
  const path = `/agents/${id}/channels`;
  const query = useQuery({
    queryKey: ['agents', id, 'channels'],
    queryFn: ({ signal }) =>
      configurationApi.get(path, ChannelBindingSchema.nullable(), signal),
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
  });
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const save = useMutation({
    mutationFn: (remove: boolean) =>
      configurationApi.write(
        path,
        ChannelBindingSchema.nullable(),
        remove
          ? null
          : {
              type: 'slack',
              config: { respondTo: 'dm_and_mentions' },
              enabled: enabled ?? query.data?.enabled ?? false,
            },
        'PUT',
      ),
    onSuccess: () => {
      setEnabled(undefined);
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['health'] });
    },
  });
  return (
    <section className="panel">
      <h2>Channels</h2>
      <Failure error={query.error} retry={() => void query.refetch()} />
      <Failure error={health.error} retry={() => void health.refetch()} />
      <p>
        Slack:{' '}
        {health.isPending
          ? 'checking…'
          : health.isError
            ? 'status unavailable'
            : health.data?.slack?.connected
              ? 'connected'
              : (health.data?.slack?.detail ?? 'disconnected')}
      </p>
      <p>
        {query.data
          ? `Slack bound: direct messages and mentions (${query.data.enabled ? 'enabled' : 'disabled'})`
          : query.isPending
            ? 'Loading binding…'
            : query.isError
              ? 'Binding unavailable'
              : 'No Slack binding'}
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled ?? query.data?.enabled ?? false}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={save.isPending || query.isPending || query.isError}
        />
        Slack binding enabled
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={save.isPending || query.isPending || query.isError}
          onClick={() => save.mutate(false)}
        >
          Save channel
        </button>
        {query.data && (
          <button
            type="button"
            className="secondary"
            disabled={save.isPending}
            onClick={() => save.mutate(true)}
          >
            Remove channel
          </button>
        )}
      </div>
      <Failure error={save.error} />
    </section>
  );
}
function Memories({ id }: { id: string }) {
  const client = useQueryClient();
  const path = `/agents/${id}/memories`;
  const query = useQuery({
    queryKey: ['agents', id, 'memories'],
    queryFn: ({ signal }) =>
      configurationApi.get(path, MemorySchema.array(), signal),
  });
  const [fact, setFact] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (memoryId?: string) =>
      memoryId
        ? configurationApi.write(
            `${path}/${memoryId}`,
            z.undefined(),
            undefined,
            'DELETE',
          )
        : configurationApi.write(
            path,
            MemorySchema,
            MemoryInputSchema.parse({ fact }),
          ),
    onSuccess: (_data, memoryId) => {
      if (!memoryId) {
        setFact('');
        setError('');
      }
      void client.invalidateQueries({ queryKey: ['agents', id, 'memories'] });
      void client.invalidateQueries({ queryKey: ['agents', id, 'dimensions'] });
    },
    onError: (failure) => setError(fieldErrors(failure).fact ?? ''),
  });
  return (
    <section className="panel">
      <h2>Memory</h2>
      <Failure error={query.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <p>Loading memory…</p>
      ) : (
        !query.isError &&
        !query.data?.length && <p>No memories yet. Add a fact below.</p>
      )}
      <ul>
        {query.data?.map((memory) => (
          <li key={memory.id}>
            {memory.fact} <small>{memory.source}</small>{' '}
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(memory.id)}
              aria-label={`Delete memory ${memory.fact}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (save.isPending) return;
          const result = MemoryInputSchema.safeParse({ fact });
          setError(
            result.success
              ? ''
              : (result.error.issues[0]?.message ?? 'Invalid fact'),
          );
          if (result.success) save.mutate(undefined);
        }}
      >
        <fieldset disabled={save.isPending} className="form-grid">
          <label className="field">
            Memory fact
            <textarea
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? 'memory-error' : undefined}
            />
            {error && (
              <span id="memory-error" role="alert">
                {error}
              </span>
            )}
          </label>
          <button disabled={save.isPending}>Add memory</button>
          <Failure error={save.error} />
        </fieldset>
      </form>
    </section>
  );
}
const emptySchedule = {
  kind: 'interval' as const,
  expr: '',
  prompt: '',
  workflowId: null as string | null,
  enabled: true,
};
function Schedules({ id }: { id: string }) {
  const client = useQueryClient();
  const path = `/agents/${id}/schedules`;
  const query = useQuery({
    queryKey: ['agents', id, 'schedules'],
    queryFn: ({ signal }) =>
      configurationApi.get(path, ScheduleSchema.array(), signal),
  });
  const [draft, setDraft] =
    useState<z.infer<typeof ScheduleInputSchema>>(emptySchedule);
  const [editing, setEditing] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (removeId?: string) =>
      removeId
        ? configurationApi.write(
            `${path}/${removeId}`,
            z.undefined(),
            undefined,
            'DELETE',
          )
        : configurationApi.write(
            editing ? `${path}/${editing}` : path,
            ScheduleSchema,
            ScheduleInputSchema.parse(draft),
            editing ? 'PUT' : 'POST',
          ),
    onSuccess: (_data, removeId) => {
      if (!removeId || removeId === editing) {
        setDraft(emptySchedule);
        setEditing(undefined);
        setErrors({});
      }
      void client.invalidateQueries({ queryKey: ['agents', id, 'schedules'] });
      void client.invalidateQueries({ queryKey: ['agents', id, 'dimensions'] });
    },
    onError: (failure) =>
      setErrors(
        failure.message === 'Invalid cron expression'
          ? { expr: failure.message }
          : fieldErrors(failure),
      ),
  });
  function edit(schedule: Schedule) {
    const { kind, expr, prompt, workflowId, enabled } = schedule;
    setDraft({ kind, expr, prompt, workflowId, enabled });
    setEditing(schedule.id);
    setErrors({});
  }
  return (
    <section className="panel">
      <h2>Schedules</h2>
      <Failure error={query.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <p>Loading schedules…</p>
      ) : (
        !query.isError &&
        !query.data?.length && <p>No schedules yet. Add one below.</p>
      )}
      <ul>
        {query.data?.map((schedule) => (
          <li key={schedule.id}>
            {schedule.kind}
            {schedule.kind === 'cron' ? ' (UTC)' : ''}: {schedule.expr} —{' '}
            {schedule.prompt} ({schedule.enabled ? 'enabled' : 'disabled'}) Last
            run:{' '}
            {schedule.lastRunAt === null
              ? 'never'
              : new Date(schedule.lastRunAt).toISOString()}{' '}
            UTC · Next run:{' '}
            {schedule.nextRunAt === null
              ? 'none'
              : new Date(schedule.nextRunAt).toISOString()}{' '}
            UTC{' '}
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => edit(schedule)}
            >
              Edit schedule
            </button>{' '}
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(schedule.id)}
            >
              Delete schedule
            </button>
          </li>
        ))}
      </ul>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (save.isPending) return;
          const result = ScheduleInputSchema.safeParse(draft);
          setErrors(
            result.success
              ? {}
              : Object.fromEntries(
                  result.error.issues.map((issue) => [
                    issue.path.join('.'),
                    issue.message,
                  ]),
                ),
          );
          if (result.success) save.mutate(undefined);
        }}
      >
        <fieldset disabled={save.isPending} className="form-grid">
          <label className="field">
            Schedule kind
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  kind: e.target.value === 'cron' ? 'cron' : 'interval',
                })
              }
            >
              <option value="interval">Interval (seconds)</option>
              <option value="cron">Cron (UTC)</option>
            </select>
          </label>
          {(['expr', 'prompt', 'workflowId'] as const).map((name) => (
            <label className="field" key={name}>
              {name === 'expr'
                ? `Schedule expression${draft.kind === 'cron' ? ' (UTC)' : ''}`
                : name === 'prompt'
                  ? 'Schedule prompt'
                  : 'Schedule workflow'}
              <input
                value={draft[name] ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [name]:
                      name === 'workflowId'
                        ? e.target.value || null
                        : e.target.value,
                  })
                }
                aria-invalid={!!errors[name]}
                aria-describedby={
                  errors[name] ? `schedule-${name}-error` : undefined
                }
              />
              {errors[name] && (
                <span role="alert" id={`schedule-${name}-error`}>
                  {errors[name]}
                </span>
              )}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            Schedule enabled
          </label>
          <div className="actions">
            <button disabled={save.isPending}>
              {editing ? 'Save schedule' : 'Add schedule'}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(undefined);
                  setDraft(emptySchedule);
                  setErrors({});
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
          <Failure error={save.error} />
        </fieldset>
      </form>
    </section>
  );
}
function AttachedSkills({ id }: { id: string }) {
  const client = useQueryClient();
  const path = `/agents/${id}/skills`;
  const library = useQuery({
    queryKey: ['skills'],
    queryFn: ({ signal }) =>
      configurationApi.get('/skills', SkillSchema.array(), signal),
  });
  const query = useQuery({
    queryKey: ['agents', id, 'skills'],
    queryFn: ({ signal }) =>
      configurationApi.get(path, SkillSchema.array(), signal),
  });
  const [selected, setSelected] = useState<string[] | undefined>();
  const ids = selected ?? query.data?.map((skill) => skill.id) ?? [];
  const save = useMutation({
    mutationFn: () =>
      configurationApi.write(
        path,
        SkillSchema.array(),
        { skillIds: ids },
        'PUT',
      ),
    onSuccess: () => {
      setSelected(undefined);
      void client.invalidateQueries({ queryKey: ['agents', id, 'skills'] });
      void client.invalidateQueries({ queryKey: ['agents', id, 'dimensions'] });
    },
  });
  return (
    <section className="panel">
      <h2>Skills</h2>
      <Failure
        error={query.error ?? library.error}
        retry={() => {
          void query.refetch();
          void library.refetch();
        }}
      />
      {library.isPending || query.isPending ? (
        <p>Loading skills…</p>
      ) : (
        !library.isError &&
        !query.isError &&
        !library.data?.length && (
          <p>No skills yet. Create one in the Skills library.</p>
        )
      )}
      {library.data?.map((skill) => (
        <label className="field" key={skill.id}>
          <span>
            <input
              type="checkbox"
              disabled={
                save.isPending ||
                query.isPending ||
                library.isPending ||
                query.isError ||
                library.isError
              }
              aria-label={skill.name}
              checked={ids.includes(skill.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...ids, skill.id]
                    : ids.filter((value) => value !== skill.id),
                )
              }
            />
            {skill.name}
          </span>
          <small>{skill.description}</small>
        </label>
      ))}
      <button
        type="button"
        disabled={
          save.isPending ||
          query.isPending ||
          library.isPending ||
          query.isError ||
          library.isError
        }
        onClick={() => save.mutate()}
      >
        Save skills
      </button>
      <Failure error={save.error} />
    </section>
  );
}
