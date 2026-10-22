import { useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { toast } from 'sonner';
import { api } from './api/client.js';
import { LiveEventsContext } from './LiveEventsContext.js';
import { useEvents } from './api/use-events.js';
import { EmptyState } from './components/EmptyState.js';
import { Agents } from './pages/Agents.js';
import { AgentEditor } from './pages/AgentEditor.js';
import { Skills } from './pages/Skills.js';
import { Workflows } from './pages/Workflows.js';
import { WorkflowBuilder } from './pages/WorkflowBuilder.js';
import { Monitor } from './pages/Monitor.js';
import { Runs } from './pages/Runs.js';
import { RunDetail } from './pages/RunDetail.js';
import { Approvals } from './pages/Approvals.js';
import { Templates } from './pages/Templates.js';
import { Toaster } from './components/ui/sonner.js';

const navigation = [
  ['/', 'Monitor'],
  ['/agents', 'Agents'],
  ['/workflows', 'Workflows'],
  ['/runs', 'Runs'],
  ['/approvals', 'Approvals'],
  ['/skills', 'Skills'],
  ['/templates', 'Templates'],
] as const;

function Shell() {
  const live = useEvents();
  const location = useLocation();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('yuno-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
    return typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 30_000,
  });
  const approvals = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: ({ signal }) => api.pendingApprovals(signal),
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('yuno-theme', theme);
    } catch {
      /* Keep the in-memory theme when storage is unavailable. */
    }
  }, [theme]);
  useEffect(() => {
    document.title = `${navigation.find(([path]) => path === location.pathname)?.[1] ?? 'Workspace'} · Yuno`;
  }, [location.pathname]);
  useEffect(() => {
    if (live.error) toast.error(live.error);
  }, [live.error]);
  const healthFailed = health.isError;
  const runtime = healthFailed
    ? 'unavailable'
    : health.isPending
      ? 'checking'
      : health.data.runtime
        ? health.data.runtime.ok
          ? `ready${health.data.runtime.version ? ` · ${health.data.runtime.version}` : ''}`
          : 'unavailable'
        : 'not configured';
  const slack = healthFailed
    ? 'unavailable'
    : health.isPending
      ? 'checking'
      : health.data.slack?.connected
        ? 'connected'
        : (health.data.slack?.detail ?? 'not configured');
  return (
    <LiveEventsContext.Provider value={live}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" to="/" aria-label="Yuno home">
            <span className="brand-mark">y</span>Yuno
          </Link>
          <p className="nav-label">Workspace</p>
          <nav aria-label="Main navigation">
            {navigation.map(([path, label]) => (
              <NavLink key={path} to={path} end={path === '/'}>
                <span>{label}</span>
                {label === 'Approvals' && (
                  <span
                    className="badge"
                    aria-label={
                      approvals.isError
                        ? 'Approval count unavailable'
                        : approvals.isPending
                          ? 'Loading approvals'
                          : `${approvals.data.length} pending approvals`
                    }
                  >
                    {approvals.isError
                      ? '!'
                      : approvals.isPending
                        ? '…'
                        : approvals.data.length}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="nav-label">Local workspace</span>
            <p>Your agents. One control room.</p>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="connection-status" role="status">
              <span
                className={`pill ${!healthFailed && health.data?.runtime?.ok ? 'ready' : ''}`}
              >
                Runtime: {runtime}
              </span>
              <span
                className={`pill ${!healthFailed && health.data?.slack?.connected ? 'ready' : ''}`}
              >
                Slack: {slack}
              </span>
              <span
                className={`stream-status ${live.status === 'connected' ? 'ready' : ''}`}
              >
                Live: {live.status}
              </span>
            </div>
            <button
              className="theme-toggle"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              {theme === 'light' ? 'Dark' : 'Light'} theme
            </button>
          </header>
          <main id="main" tabIndex={-1}>
            {(health.isError || approvals.isError) && (
              <div className="notice" role="alert">
                <span>
                  Workspace status could not be loaded.{' '}
                  {health.error?.message ?? approvals.error?.message}
                </span>
                <button
                  onClick={() => {
                    void health.refetch();
                    void approvals.refetch();
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {live.status !== 'connected' && (
              <p className="notice" role="status">
                {live.status === 'connecting'
                  ? 'Connecting to live updates…'
                  : 'Live updates disconnected. Reconnecting; displayed data may be out of date.'}
              </p>
            )}
            {live.error && (
              <p className="notice" role="alert">
                {live.error}
              </p>
            )}
            <Routes>
              <Route path="/" element={<Monitor />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/agents/new" element={<AgentEditor />} />
              <Route path="/agents/:id" element={<AgentEditor />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/workflows/new" element={<WorkflowBuilder />} />
              <Route path="/workflows/:id" element={<WorkflowBuilder />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route
                path="*"
                element={
                  <>
                    <h1>Page not found</h1>
                    <EmptyState
                      title="This page does not exist"
                      description="Return to the control room to continue."
                      to="/"
                      action="Back to monitor"
                    />
                  </>
                }
              />
            </Routes>
          </main>
        </div>
      </div>
      <Toaster theme={theme} />
    </LiveEventsContext.Provider>
  );
}

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  );
}
