import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SkillSchema, SkillInputSchema, type Skill } from '@yuno/shared';
import { z } from 'zod';
import { Link } from 'react-router';
import { configurationApi } from '../api/configuration.js';
import { Field, RequestError, fieldErrors } from '../components/forms.js';

const empty = { name: '', description: '', stepsMd: '' };
export function Skills() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['skills'],
    queryFn: ({ signal }) =>
      configurationApi.get('/skills', SkillSchema.array(), signal),
  });
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (removeId?: string) =>
      removeId
        ? configurationApi.write(
            `/skills/${removeId}`,
            z.undefined(),
            undefined,
            'DELETE',
          )
        : configurationApi.write(
            editing ? `/skills/${editing}` : '/skills',
            SkillSchema,
            SkillInputSchema.parse(draft),
            editing ? 'PUT' : 'POST',
          ),
    onSuccess: (_data, removeId) => {
      if (!removeId || removeId === editing) {
        setDraft(empty);
        setEditing(undefined);
        setErrors({});
      }
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (error) => setErrors(fieldErrors(error)),
  });
  function edit(skill: Skill) {
    setDraft({
      name: skill.name,
      description: skill.description,
      stepsMd: skill.stepsMd,
    });
    setEditing(skill.id);
    setErrors({});
  }
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Skills</h1>
          <p>Reusable instructions for your agents.</p>
        </div>
        <Link to="/agents">Agents</Link>
      </header>
      <section className="panel">
        <h2>Skill library</h2>
        <RequestError error={query.error} retry={() => void query.refetch()} />
        {query.isPending ? (
          <p>Loading skills…</p>
        ) : (
          !query.isError &&
          !query.data?.length && (
            <p>No skills yet. Create your first skill below.</p>
          )
        )}
        <ul>
          {query.data?.map((skill) => (
            <li key={skill.id}>
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={save.isPending}
                  onClick={() => edit(skill)}
                  aria-label={`Edit ${skill.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={save.isPending}
                  onClick={() => save.mutate(skill.id)}
                  aria-label={`Delete ${skill.name}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>{editing ? 'Edit skill' : 'Create skill'}</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (save.isPending) return;
            const result = SkillInputSchema.safeParse(draft);
            setErrors(result.success ? {} : fieldErrors(result.error));
            if (result.success) save.mutate(undefined);
          }}
        >
          <fieldset disabled={save.isPending} className="form-grid">
            <Field label="Skill name" error={errors.name}>
              {(attrs) => (
                <input
                  {...attrs}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Description" error={errors.description}>
              {(attrs) => (
                <textarea
                  {...attrs}
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              )}
            </Field>
            <Field label="Steps (Markdown)" error={errors.stepsMd}>
              {(attrs) => (
                <textarea
                  {...attrs}
                  rows={8}
                  value={draft.stepsMd}
                  onChange={(e) =>
                    setDraft({ ...draft, stepsMd: e.target.value })
                  }
                />
              )}
            </Field>
            <div className="actions">
              <button disabled={save.isPending}>Save skill</button>
              {editing && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditing(undefined);
                    setDraft(empty);
                    setErrors({});
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
            <RequestError error={save.error} />
          </fieldset>
        </form>
      </section>
    </>
  );
}
