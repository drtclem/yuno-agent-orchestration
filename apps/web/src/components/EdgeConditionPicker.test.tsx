// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { WorkflowGraph } from '@yuno/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdgeConditionPicker } from './EdgeConditionPicker.js';

afterEach(cleanup);
type Condition = WorkflowGraph['edges'][number]['condition'];
function Picker() {
  const [value, onChange] = useState<Condition>('always');
  return <EdgeConditionPicker value={value} onChange={onChange} />;
}
describe('T17 edge condition picker (R-11, R-12)', () => {
  it('R-11 R-12 chooses unconditional, approved, rejected and text matching conditions', () => {
    render(<Picker />);
    const picker = screen.getByLabelText('Edge condition') as HTMLSelectElement;
    expect(picker.value).toBe('always');
    for (const condition of ['approved', 'rejected', 'always']) {
      fireEvent.change(picker, { target: { value: condition } });
      expect(picker.value).toBe(condition);
    }
    fireEvent.change(picker, { target: { value: 'contains' } });
    const text = screen.getByLabelText('Contains text') as HTMLInputElement;
    fireEvent.change(text, { target: { value: 'Ready ✓ 🌍' } });
    expect(text.value).toBe('Ready ✓ 🌍');
    fireEvent.change(picker, { target: { value: 'rejected' } });
    expect(screen.queryByLabelText('Contains text')).toBeNull();
  });
  it('R-11 emits the persisted contains object without altering unicode text', () => {
    const onChange = vi.fn();
    render(
      <EdgeConditionPicker value={{ contains: 'old' }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Contains text'), {
      target: { value: 'Ready ✓ 🌍' },
    });
    expect(onChange).toHaveBeenCalledWith({ contains: 'Ready ✓ 🌍' });
  });
});
