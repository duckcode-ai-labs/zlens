import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ThemeProvider, TooltipProvider } from '@zlens/ui';
import { NotebookProvider, useNotebookStore } from './store/NotebookStore';
import { AppShell } from './components/shell/AppShell';
import { ServerAccessGate } from './components/shell/ServerAccessGate';
import { HostUiProvider } from './host/host-ui';
import { ViewerShell } from './components/shell/ViewerShell';
import { isViewerLink } from './api/server-auth';
import { themes } from './themes/notebook-theme';
import { api } from './api/client';
import { useHotReload } from './hooks/useHotReload';
import { OperationsProvider } from './operations/OperationsProvider';
import { ZLensStoppedNotice } from './snowflake-app/ZLensStoppedNotice';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppInner() {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const dispatch = useNotebookStore((state) => state.dispatch);
  const t = themes[themeMode];

  // Inject global CSS reset and scrollbar styles. Resolve against Luna CSS
  // vars so switching `data-theme` re-skins the body without a re-inject.
  useEffect(() => {
    const id = 'dql-global-styles';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: var(--font-ui, ${t.font});
        overflow: hidden;
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: var(--color-border-secondary);
        border-radius: 3px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--color-text-tertiary);
      }
      ::selection {
        background: color-mix(in srgb, var(--color-accent-blue) 25%, transparent);
        color: var(--color-text-primary);
      }
      .dql-meta-pill:hover {
        background: var(--dql-pill-hover-bg) !important;
        border-color: var(--dql-pill-hover-border) !important;
      }
    `;
  }, [t]);

  // v1.3.2 — three Luna themes (obsidian / paper / white). Legacy
  // 'dark'/'light'/'midnight'/'arctic' alias onto the live set so persisted
  // state from earlier v1.3 releases still loads.
  useEffect(() => {
    const luna =
      themeMode === 'dark' || themeMode === 'midnight' ? 'obsidian'
      : themeMode === 'light' ? 'paper'
      : themeMode === 'arctic' ? 'white'
      : themeMode;
    document.documentElement.setAttribute('data-theme', luna);
  }, [themeMode]);

  // A read-only page link (RFC 0010) shows one App's reader and loads
  // nothing else from the project.
  const readOnlyLink = isViewerLink();
  const notebooksQuery = useQuery({
    queryKey: ['notebooks'],
    queryFn: () => api.listNotebooks(),
    enabled: !readOnlyLink,
  });
  const domainsQuery = useQuery({
    queryKey: ['authored-domains'],
    queryFn: () => api.getDomains(),
    enabled: !readOnlyLink,
  });

  // Load independent startup resources without blocking the first workspace
  // paint. Query caching also prevents page remounts from recreating the same
  // request storm.
  useEffect(() => {
    dispatch({ type: 'SET_FILES_LOADING', loading: notebooksQuery.isLoading });
    if (notebooksQuery.data) dispatch({ type: 'SET_FILES', files: notebooksQuery.data });
  }, [dispatch, notebooksQuery.data, notebooksQuery.isLoading]);

  useEffect(() => {
    // UI-001/UI-006: ownership pickers only consume authored Domain pages.
    if (domainsQuery.data) dispatch({ type: 'SET_AUTHORED_DOMAINS', domains: domainsQuery.data.domains });
  }, [dispatch, domainsQuery.data]);

  // Hot reload — watches project files via SSE and refreshes state
  useHotReload();

  return (
    <ThemeProvider theme={themeMode} applyGlobal>
      <TooltipProvider delayDuration={200} skipDelayDuration={400}>
        {readOnlyLink ? <ViewerShell /> : <AppShell />}
        <ServerAccessGate />
        <ZLensStoppedNotice />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NotebookProvider>
        <OperationsProvider>
          <HostUiProvider>
          <AppInner />
        </HostUiProvider>
        </OperationsProvider>
      </NotebookProvider>
    </QueryClientProvider>
  );
}
