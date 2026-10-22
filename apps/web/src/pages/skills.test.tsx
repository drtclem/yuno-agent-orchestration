// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SkillSchema, type Skill } from '@yuno/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';

let skills: Skill[];
const id = '00000000-0000-4000-8000-000000000001';
class FakeEventSource {
  close() {}
}
beforeEach(() => {
  skills = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/skills') && init?.method) {
        if (init.method === 'DELETE') {
          skills = [];
          return new Response(null, { status: 204 });
        }
        const body: unknown = JSON.parse(String(init.body));
        const skill = SkillSchema.parse({ id, createdAt: 0, ...Object(body) });
        skills = [skill];
        return new Response(JSON.stringify(skill));
      }
      return new Response(
        JSON.stringify(
          url === '/api/skills'
            ? skills
            : url === '/api/health'
              ? { ok: true, runtime: { ok: true } }
              : [],
        ),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it('R-05 Skills library creates, edits, reloads, and deletes reusable procedures', async () => {
  const mount = () =>
    render(
      <MemoryRouter initialEntries={['/skills']}>
        <App />
      </MemoryRouter>,
    );
  const view = mount();
  await screen.findByLabelText('Skill name');
  change('Skill name', 'Verify');
  change('Description', 'Review claims');
  change('Steps (Markdown)', '1. Find primary sources');
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() =>
    expect(skills[0]).toMatchObject({
      name: 'Verify',
      description: 'Review claims',
      stepsMd: '1. Find primary sources',
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Verify' }));
  change('Steps (Markdown)', '1. Find sources\n2. Compare');
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() =>
    expect(skills[0]?.stepsMd).toBe('1. Find sources\n2. Compare'),
  );
  view.unmount();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Verify' }));
  expect(
    (screen.getByLabelText('Steps (Markdown)') as HTMLTextAreaElement).value,
  ).toBe('1. Find sources\n2. Compare');
  fireEvent.click(screen.getByRole('button', { name: 'Delete Verify' }));
  await waitFor(() => expect(skills).toEqual([]));
});
