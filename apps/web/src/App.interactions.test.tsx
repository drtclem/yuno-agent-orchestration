// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

class FakeEventSource {
  static current: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
  constructor() {
    FakeEventSource.current = this;
  }
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/health')
              ? {
                  ok: true,
                  runtime: { ok: true },
                  slack: { connected: false, detail: 'not configured' },
                }
              : [],
          ),
        ),
      ),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
describe('T15 shell navigation and visible status (R-29, R-31)', () => {
  it('navigates between workspace routes and shows live runtime/channel and approval status', async () => {
    mount();
    expect(await screen.findByText('Runtime: ready')).toBeTruthy();
    expect(screen.getByText('Slack: not configured')).toBeTruthy();
    expect(screen.getByLabelText('0 pending approvals')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
    expect(
      screen.getByRole('heading', { name: 'Agents', level: 1 }),
    ).toBeTruthy();
    expect(document.title).toBe('Agents · Yuno');
    act(() => FakeEventSource.current?.onopen?.());
    expect(screen.getByText('Live: connected')).toBeTruthy();
    act(() => FakeEventSource.current?.onerror?.());
    expect(screen.getByText(/Live updates disconnected/)).toBeTruthy();
  });
  it('persists the selected light/dark theme across remounts', () => {
    const first = mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('yuno-theme')).toBe('dark');
    first.unmount();
    mount();
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('renders an actionable unknown-route empty state', () => {
    mount('/missing');
    expect(
      screen.getByRole('heading', { name: 'Page not found' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Back to monitor' }));
    expect(
      screen.getByRole('heading', { name: 'Monitor', level: 1 }),
    ).toBeTruthy();
  });
  it('shows failed workspace requests and retries after recovery', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    mount();
    expect(
      await screen.findByText(
        /Workspace status could not be loaded/,
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText('Runtime: unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Approval count unavailable')).toBeTruthy();
    fetch.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/health') ? { ok: true, runtime: { ok: true } } : [],
          ),
        ),
      ),
    );
    const workspaceAlert = screen
      .getAllByRole('alert')
      .find((alert) =>
        alert.textContent?.includes('Workspace status could not be loaded'),
      );
    if (!workspaceAlert) throw new Error('Missing workspace status alert');
    fireEvent.click(
      within(workspaceAlert).getByRole('button', { name: 'Retry' }),
    );
    expect(await screen.findByText('Runtime: ready')).toBeTruthy();
    expect(
      screen.queryByText(/Workspace status could not be loaded/),
    ).toBeNull();
  });
  it('shows malformed live data as a visible error', () => {
    mount();
    act(() => FakeEventSource.current?.onmessage?.({ data: '{broken' }));
    expect(
      screen.getAllByRole('alert').some((alert) => Boolean(alert.textContent)),
    ).toBe(true);
  });
});
