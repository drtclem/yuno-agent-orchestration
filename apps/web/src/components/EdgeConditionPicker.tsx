import type { WorkflowGraph } from '@yuno/shared';
import { Field } from './forms.js';

type Condition = WorkflowGraph['edges'][number]['condition'];
export function EdgeConditionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: Condition;
  onChange: (value: Condition) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="form-grid">
      <Field label="Edge condition">
        {(attrs) => (
          <select
            {...attrs}
            value={typeof value === 'string' ? value : 'contains'}
            onChange={(e) => {
              const selected = e.target.value;
              if (
                selected === 'always' ||
                selected === 'approved' ||
                selected === 'rejected'
              )
                onChange(selected);
              else onChange({ contains: '' });
            }}
          >
            <option value="always">Always</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="contains">Contains</option>
          </select>
        )}
      </Field>
      {typeof value === 'object' && (
        <Field label="Contains text">
          {(attrs) => (
            <input
              {...attrs}
              value={value.contains}
              onChange={(e) => onChange({ contains: e.target.value })}
            />
          )}
        </Field>
      )}
    </fieldset>
  );
}
