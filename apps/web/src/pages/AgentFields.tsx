import {
  ALLOWED_MODELS,
  type AgentSettings,
  PermissionSchema,
} from '@yuno/shared';
import { Field } from '../components/forms.js';

export function AgentFields({
  tab,
  value,
  setValue,
  errors,
}: {
  tab: string;
  value: AgentSettings;
  setValue: (value: AgentSettings) => void;
  errors: Record<string, string>;
}) {
  if (tab === 'Basics')
    return (
      <div className="form-grid">
        {(['name', 'role', 'systemPrompt'] as const).map((key) => (
          <Field
            key={key}
            label={
              { name: 'Name', role: 'Role', systemPrompt: 'System prompt' }[key]
            }
            error={errors[key]}
          >
            {(attrs) =>
              key === 'systemPrompt' ? (
                <textarea
                  {...attrs}
                  rows={8}
                  value={value[key]}
                  onChange={(e) =>
                    setValue({ ...value, [key]: e.target.value })
                  }
                />
              ) : (
                <input
                  {...attrs}
                  value={value[key]}
                  onChange={(e) =>
                    setValue({ ...value, [key]: e.target.value })
                  }
                />
              )
            }
          </Field>
        ))}
        <Field label="Model" error={errors.model}>
          {(attrs) => (
            <select
              {...attrs}
              value={value.model}
              onChange={(e) =>
                setValue({
                  ...value,
                  model:
                    ALLOWED_MODELS.find((m) => m.id === e.target.value)?.id ??
                    value.model,
                })
              }
            >
              {!ALLOWED_MODELS.some((model) => model.id === value.model) && (
                <option value={value.model}>
                  {value.model} · unavailable — pick another
                </option>
              )}
              {ALLOWED_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id} · {model.pool}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    );
  if (tab === 'Tools & permissions')
    return (
      <div className="form-grid">
        <p>
          Enable each tool and choose its permission. Disabled tools always deny
          access.
        </p>
        {(['bash', 'edit', 'webfetch'] as const).map((tool) => (
          <fieldset key={tool}>
            <legend>{tool}</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={value.tools[tool]}
                onChange={(e) =>
                  setValue({
                    ...value,
                    tools: { ...value.tools, [tool]: e.target.checked },
                  })
                }
              />
              {tool} enabled
            </label>
            <Field
              label={`${tool} permission`}
              error={errors[`permissions.${tool}`]}
            >
              {(attrs) => (
                <select
                  {...attrs}
                  value={value.permissions[tool]}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      permissions: {
                        ...value.permissions,
                        [tool]: PermissionSchema.parse(e.target.value),
                      },
                    })
                  }
                >
                  {PermissionSchema.options.map((permission) => (
                    <option key={permission}>{permission}</option>
                  ))}
                </select>
              )}
            </Field>
          </fieldset>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={value.permissions.canDeploy}
            onChange={(e) =>
              setValue({
                ...value,
                permissions: {
                  ...value.permissions,
                  canDeploy: e.target.checked,
                },
              })
            }
          />
          Can deploy (write to this run's deployments folder)
        </label>
        <Field label="Blocked commands" error={errors['permissions.denyBash']}>
          {(attrs) => (
            <textarea
              {...attrs}
              rows={4}
              value={value.permissions.denyBash.join('\n')}
              onChange={(e) =>
                setValue({
                  ...value,
                  permissions: {
                    ...value.permissions,
                    denyBash: e.target.value.split('\n'),
                  },
                })
              }
            />
          )}
        </Field>
        <p className="footnote">One denied bash pattern per line.</p>
      </div>
    );
  return (
    <div className="form-grid">
      <p>Cost limits are estimated USD at list prices.</p>
      {(
        [
          ['dailyCostCapUsd', 'Daily cost cap (USD)'],
          ['runCostCapUsd', 'Run cost cap (USD)'],
          ['maxTurnsPerHour', 'Max turns per hour'],
          ['turnTimeoutMs', 'Turn timeout (ms)'],
        ] as const
      ).map(([key, label]) => (
        <Field key={key} label={label} error={errors[`guardrails.${key}`]}>
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              step={key.endsWith('Usd') ? 'any' : '1'}
              min={key.endsWith('Usd') ? 0 : 1}
              value={
                Number.isNaN(value.guardrails[key]) ? '' : value.guardrails[key]
              }
              onChange={(e) =>
                setValue({
                  ...value,
                  guardrails: {
                    ...value.guardrails,
                    [key]: e.target.value === '' ? NaN : Number(e.target.value),
                  },
                })
              }
            />
          )}
        </Field>
      ))}
    </div>
  );
}
