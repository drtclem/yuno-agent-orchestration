import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { workflowApi } from '../api/workflows.js';
import { Field, RequestError } from './forms.js';

export function RunDialog({
  workflowId,
  onClose,
}: {
  workflowId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState('');
  const client = useQueryClient();
  const navigate = useNavigate();
  const run = useMutation({
    mutationFn: () => workflowApi.run(workflowId, input),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${result.id}`);
    },
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        if (run.isPending) e.preventDefault();
      }}
      onClose={onClose}
      aria-labelledby="run-title"
    >
      <h2 id="run-title">Run workflow</h2>
      <p>The saved workflow will run with this input.</p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (!run.isPending && input.trim()) run.mutate();
        }}
      >
        <Field label="Run input">
          {(attrs) => (
            <textarea
              {...attrs}
              autoFocus
              required
              value={input}
              disabled={run.isPending}
              onChange={(e) => setInput(e.target.value)}
              rows={5}
            />
          )}
        </Field>
        <RequestError error={run.error} />
        <div className="actions">
          <button disabled={run.isPending || !input.trim()}>Start run</button>
          <button
            type="button"
            className="secondary"
            disabled={run.isPending}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
