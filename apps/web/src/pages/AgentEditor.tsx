import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AgentInputSchema,
  AgentSettingsSchema,
  AGENT_DIMENSIONS,
  GuardrailsSchema,
  AgentSchema,
  ChannelBindingSchema,
  MemorySchema,
  ScheduleSchema,
  SkillSchema,
  type AgentSettings,
} from '@yuno/shared';
import { z } from 'zod';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { configurationApi as api } from '../api/configuration.js';
import { fieldErrors, RequestError } from '../components/forms.js';
import { AgentFields } from './AgentFields.js';
import { AgentConfiguration } from './AgentConfiguration.js';
import { TestChat } from './TestChat.js';

const tabs = [
  'Basics',
  'Tools & permissions',
  'Channels',
  'Schedules',
  'Memory',
  'Skills',
  'Guardrails',
  'Test chat',
];
function Dimensions({ id, value }: { id?: string; value: AgentSettings }) {
  const query = useQuery({
    queryKey: ['agents', id, 'dimensions'],
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const [channel, schedules, memories, skills] = await Promise.all([
        api.get(
          `/agents/${id}/channels`,
          ChannelBindingSchema.nullable(),
          signal,
        ),
        api.get(`/agents/${id}/schedules`, ScheduleSchema.array(), signal),
        api.get(`/agents/${id}/memories`, MemorySchema.array(), signal),
        api.get(`/agents/${id}/skills`, SkillSchema.array(), signal),
      ]);
      return { channel, schedules, memories, skills };
    },
  });
  const settings: Record<string, unknown> = {
    ...value,
    ...Object.fromEntries(
      Object.entries(value.tools).map(([key, v]) => [`tools.${key}`, v]),
    ),
    ...Object.fromEntries(
      Object.entries(value.permissions).map(([key, v]) => [
        `permissions.${key}`,
        v,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(value.guardrails).map(([key, v]) => [
        `guardrails.${key}`,
        v,
      ]),
    ),
    channel: query.data?.channel?.enabled,
    schedules: query.data?.schedules.some((schedule) => schedule.enabled),
    memories: query.data?.memories,
    skills: query.data?.skills,
  };
  const setCount = AGENT_DIMENSIONS.filter(({ key }) => {
    const setting = settings[key];
    const guardrail = key.slice('guardrails.'.length);
    if (key.startsWith('guardrails.') && guardrail in GuardrailsSchema.shape) {
      const field =
        GuardrailsSchema.shape[
          guardrail as keyof typeof GuardrailsSchema.shape
        ];
      return field.safeParse(setting).success;
    }
    return Array.isArray(setting)
      ? setting.some((item: unknown) => typeof item !== 'string' || item.trim())
      : typeof setting === 'string'
        ? Boolean(setting.trim()) && setting !== 'deny'
        : typeof setting === 'number'
          ? Number.isFinite(setting) && setting >= 0
          : setting === true;
  }).length;
  return (
    <details className="dimension-count">
      <summary>
        <span>{AGENT_DIMENSIONS.length} configurable dimensions</span> ·{' '}
        <span>
          {id && query.isPending
            ? 'Loading configured dimensions…'
            : query.isError
              ? 'Configured dimensions unavailable'
              : `${setCount} set on this agent`}
        </span>
      </summary>
      <p>
        Includes current edits and saved channels, schedules, memory, and
        skills. Enabled tools, non-deny permissions, nonempty values and valid
        guardrail values (including defaults) count as set.
      </p>
      <ul>
        {[...new Set(AGENT_DIMENSIONS.map((dimension) => dimension.group))].map(
          (group) => (
            <li key={group}>
              {group}:{' '}
              {
                AGENT_DIMENSIONS.filter(
                  (dimension) => dimension.group === group,
                ).length
              }{' '}
              —{' '}
              {AGENT_DIMENSIONS.filter((dimension) => dimension.group === group)
                .map((dimension) => dimension.label)
                .join(', ')}
            </li>
          ),
        )}
      </ul>
      <RequestError error={query.error} retry={() => void query.refetch()} />
    </details>
  );
}
function Editor({ id, initial }: { id?: string; initial: AgentSettings }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [tab, setTab] = useState('Basics');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (input: AgentSettings) =>
      api.write(
        id ? `/agents/${id}` : '/agents',
        AgentSchema,
        input,
        id ? 'PUT' : 'POST',
      ),
    onSuccess: async (agent) => {
      setSaved(AgentSettingsSchema.strip().parse(agent));
      setErrors({});
      await client.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent saved');
      if (!id) void navigate(`/agents/${agent.id}`);
    },
    onError: (error) => setErrors(fieldErrors(error)),
  });
  const remove = useMutation({
    mutationFn: () =>
      api.write(`/agents/${id}`, z.undefined(), undefined, 'DELETE'),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['agents'] });
      void navigate('/agents');
    },
  });
  function submit() {
    const parsed = AgentInputSchema.safeParse({
      ...value,
      permissions: {
        ...value.permissions,
        denyBash: value.permissions.denyBash
          .map((line) => line.trim())
          .filter(Boolean),
      },
    });
    if (!parsed.success) {
      const next = fieldErrors(parsed.error);
      setErrors(next);
      const key = Object.keys(next)[0] ?? '';
      setTab(
        key.startsWith('guardrails')
          ? 'Guardrails'
          : key.startsWith('permissions') || key.startsWith('tools')
            ? 'Tools & permissions'
            : 'Basics',
      );
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }
  return (
    <>
      <Link to="/agents" className="text-link">
        ← Agents
      </Link>
      <div className="page-heading">
        <p className="eyebrow">Agent configuration</p>
        <h1>{id ? saved.name : 'Create agent'}</h1>
        <Dimensions {...(id ? { id } : {})} value={value} />
        {!id && (
          <p>
            Save the agent to add channels, schedules, memory, skills, and test
            chat.
          </p>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Agent configuration"
        className="editor-tabs"
      >
        {tabs.map((name) => (
          <button
            key={name}
            id={`tab-${name.replaceAll(' ', '-')}`}
            role="tab"
            aria-selected={tab === name}
            aria-controls="agent-panel"
            disabled={
              !id &&
              !['Basics', 'Tools & permissions', 'Guardrails'].includes(name)
            }
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const enabled = tabs.filter(
                (name) =>
                  id ||
                  ['Basics', 'Tools & permissions', 'Guardrails'].includes(
                    name,
                  ),
              );
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? enabled.length - 1
                    : (enabled.indexOf(tab) +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        enabled.length) %
                      enabled.length;
              const next = enabled[index];
              if (next) {
                setTab(next);
                document
                  .getElementById(`tab-${next.replaceAll(' ', '-')}`)
                  ?.focus();
              }
            }}
            tabIndex={tab === name ? 0 : -1}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="footnote">
        Save each configuration tab before switching. Test chat uses saved
        settings.
      </p>
      <section
        className="panel"
        id="agent-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}
      >
        {['Basics', 'Tools & permissions', 'Guardrails'].includes(tab) ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <fieldset disabled={save.isPending}>
              <legend className="sr-only">{tab}</legend>
              <AgentFields
                tab={tab}
                value={value}
                setValue={setValue}
                errors={errors}
              />
              <div className="actions">
                <button className="button" type="submit">
                  {save.isPending ? 'Saving…' : 'Save agent'}
                </button>
                <span>
                  Applies Basics, Tools & permissions, and Guardrails.
                </span>
              </div>
            </fieldset>
            <RequestError error={save.error} />
          </form>
        ) : id && tab !== 'Test chat' ? (
          <AgentConfiguration id={id} tab={tab} />
        ) : null}
        {id && (
          <div hidden={tab !== 'Test chat'}>
            <TestChat id={id} />
          </div>
        )}
      </section>
      {id && (
        <section className="danger-zone">
          <h2>Delete agent</h2>
          <p>
            Workflow references or retained execution history can prevent
            deletion.
          </p>
          {confirmDelete ? (
            <div className="actions">
              <span>Delete {saved.name} and its configuration?</span>
              <button
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Confirm delete
              </button>
              <button onClick={() => setConfirmDelete(false)}>
                Keep agent
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)}>Delete agent</button>
          )}
          <RequestError error={remove.error} />
        </section>
      )}
    </>
  );
}
export function AgentEditor() {
  const { id } = useParams();
  const agent = useQuery({
    queryKey: ['agents', id],
    queryFn: ({ signal }) => api.get(`/agents/${id}`, AgentSchema, signal),
    enabled: Boolean(id),
  });
  if (!id)
    return (
      <Editor
        key="new"
        initial={{
          ...AgentInputSchema.parse({
            name: 'New agent',
            role: 'Assistant',
            systemPrompt: 'Help with the task.',
          }),
          name: '',
          role: '',
          systemPrompt: '',
        }}
      />
    );
  if (agent.isPending) return <p role="status">Loading agent…</p>;
  if (agent.isError)
    return (
      <>
        <h1>Agent unavailable</h1>
        <RequestError error={agent.error} retry={() => void agent.refetch()} />
        <Link to="/agents">Back to agents</Link>
      </>
    );
  return (
    <Editor
      key={id}
      id={id}
      initial={AgentSettingsSchema.strip().parse(agent.data)}
    />
  );
}
