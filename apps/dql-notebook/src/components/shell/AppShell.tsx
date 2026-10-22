import React, { lazy, Suspense, useCallback, useRef, useState, useEffect } from 'react';
import { HostPageView } from './HostPageView';
import { readAppDraftLink, readAppPageLink, withAppPageLink, withoutAppDraftLink } from '../apps/app-links';
import { useShallow } from 'zustand/react/shallow';
import { CommandPalette } from '../palette/CommandPalette';
import { InspectorPanel } from './InspectorPanel';
import { askTraceRouteFromPathname, useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { withoutAskLocationHref, withoutAskTraceLocationHref } from '../home/ask-location';
import { themes } from '../../themes/notebook-theme';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { HostBanner } from './HostBanner';
import { hostLandingView, useHostUi } from '../../host/host-ui';
import { HostRefusalNotice, ReadOnlyStrip } from './HostReadOnly';
import { DevPanel } from './DevPanel';
import { api, type SetupLaunchResponse } from '../../api/client';
import { parseNotebookFile } from '../../utils/parse-workbook';
import { makeCell } from '../../store/NotebookStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useRunSnapshotAutosave } from '../../hooks/useRunSnapshotAutosave';
import type { NotebookFile } from '../../store/types';
import { withoutDomainStudioLocationHref } from '../modeling/domain-studio-model';

const HomePage = lazy(() => import('../home/HomePage').then((module) => ({ default: module.HomePage })));
const AnalyticsHome = lazy(() => import('../home/AnalyticsHome').then((module) => ({ default: module.AnalyticsHome })));
const GlobalAiRail = lazy(() => import('../agent/GlobalAiRail').then((module) => ({ default: module.GlobalAiRail })));
const NotebookEditor = lazy(() => import('../notebook/NotebookEditor').then((module) => ({ default: module.NotebookEditor })));
const NewNotebookModal = lazy(() => import('../modals/NewNotebookModal').then((module) => ({ default: module.NewNotebookModal })));
const NewBlockModal = lazy(() => import('../modals/NewBlockModal').then((module) => ({ default: module.NewBlockModal })));
const SetupOnboarding = lazy(() => import('../modals/SetupOnboarding').then((module) => ({ default: module.SetupOnboarding })));
const BlockStudio = lazy(() => import('../block-studio/BlockStudio').then((module) => ({ default: module.BlockStudio })));
const BusinessArtifactView = lazy(() => import('../panels/BusinessArtifactView').then((module) => ({ default: module.BusinessArtifactView })));
const LineageDetailView = lazy(() => import('../panels/LineageDetailView').then((module) => ({ default: module.LineageDetailView })));
const LineageDAG = lazy(() => import('../panels/LineageDAG').then((module) => ({ default: module.LineageDAG })));
const HelpDocsPage = lazy(() => import('../help/HelpDocsPage').then((module) => ({ default: module.HelpDocsPage })));
const ConnectionPanel = lazy(() => import('../panels/ConnectionPanel').then((module) => ({ default: module.ConnectionPanel })));
const GitPage = lazy(() => import('../git/GitPage').then((module) => ({ default: module.GitPage })));
const ReadinessPage = lazy(() => import('../readiness/ReadinessPage').then((module) => ({ default: module.ReadinessPage })));
const AgentLogPage = lazy(() => import('../agent/AgentLogPage').then((module) => ({ default: module.AgentLogPage })));
const AskTracePage = lazy(() => import('../agent/AskTracePage').then((module) => ({ default: module.AskTracePage })));
const AskObservabilityPage = lazy(() => import('../agent/AskObservabilityPage').then((module) => ({ default: module.AskObservabilityPage })));
const DbtFirstModelingPage = lazy(() => import('../modeling/DbtFirstModelingPage').then((module) => ({ default: module.DbtFirstModelingPage })));
const HomeSummary = lazy(() => import('../home/HomeSummary').then((module) => ({ default: module.HomeSummary })));
const AppsView = lazy(() => import('../apps/AppsView').then((module) => ({ default: module.AppsView })));
const LineageDrawer = lazy(() => import('../lineage/LineageDrawer').then((module) => ({ default: module.LineageDrawer })));
const AiBuildDialog = lazy(() => import('../agent/AiBuildDialog').then((module) => ({ default: module.AiBuildDialog })));

export function AppShell() {
  const state = useNotebookStore(useShallow((store) => ({
    appMode: store.appMode,
    dashboardMode: store.dashboardMode,
    globalAi: store.globalAi,
    inspectorOpen: store.inspectorOpen,
    lineageDrawerOpen: store.lineageDrawerOpen,
    lineageFullscreen: store.lineageFullscreen,
    mainView: store.mainView,
    askTraceRunId: store.askTraceRunId,
    newBlockModalOpen: store.newBlockModalOpen,
    newNotebookModalOpen: store.newNotebookModalOpen,
    setupOpen: store.setupOpen,
    sidebarOpen: store.sidebarOpen,
    sidebarPanel: store.sidebarPanel,
    themeMode: store.themeMode,
    activeAppId: store.activeAppId,
    activeAppDraftId: store.activeAppDraftId,
    activeAppExperience: store.activeAppExperience,
    activeDashboardId: store.activeDashboardId,
  })));
  const dispatch = useDispatch();
  const t = themes[state.themeMode];
  const cellRefs = useRef<Record<string, HTMLDivElement>>({});
  const blockWorkspaceOpen = state.mainView === 'block_studio' || state.mainView === 'imports';

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [setupLaunch, setSetupLaunch] = useState<SetupLaunchResponse | null>(null);

  // UI-007 / E2E-005: a fresh install and each installed CLI version get one
  // project-local setup review before the user enters the product.
  useEffect(() => {
    let alive = true;
    void api.getSetupLaunch()
      .then((launch) => {
        if (!alive) return;
        setSetupLaunch(launch);
        if (launch.shouldOpen) dispatch({ type: 'OPEN_SETUP' });
      })
      .catch(() => {
        // A launch-check failure must not trap users outside the local product.
      });
    return () => { alive = false; };
  }, [dispatch]);

  // OBS-009: a trace deep link is navigation state, not persisted trace data.
  // Keep browser Back/Forward faithful to the addressable `/ask/traces/:runId`
  // surface without teaching unrelated pages to parse trace contents.
  useEffect(() => {
    const onPopState = () => {
      const route = askTraceRouteFromPathname(window.location.pathname);
      if (route?.mainView === 'ask_trace') {
        dispatch({ type: 'OPEN_ASK_TRACE', runId: route.runId });
      } else if (route?.mainView === 'ask_observability') {
        dispatch({ type: 'OPEN_ASK_OBSERVABILITY' });
      } else {
        // The trace route is browser navigation state. Returning to Ask must
        // not leave the previous trace detail mounted after Back/Forward.
        dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [dispatch]);

  useEffect(() => {
    const openProposal = () => dispatch({ type: 'SET_MAIN_VIEW', view: 'modeling' });
    window.addEventListener('dql:open-context-proposal', openProposal);
    // "Save this join as a relationship" from an answer opens the builder on the Modeling page.
    window.addEventListener('dql:open-relationship-draft', openProposal);
    return () => {
      window.removeEventListener('dql:open-context-proposal', openProposal);
      window.removeEventListener('dql:open-relationship-draft', openProposal);
    };
  }, [dispatch]);

  // Domain/model/section query parameters are valid deep-link state only while
  // Domain Studio is visible. Keeping them on Ask, Git, Settings, or Notebook
  // URLs makes reloads unexpectedly reopen Domains and creates misleading
  // bookmarks after ordinary navigation.
  useEffect(() => {
    if (state.mainView === 'domains' || state.mainView === 'modeling' || state.mainView === 'skills') {
      // Domain Studio owns its own location; an Ask thread left in the URL
      // would send a reload back to Ask instead of the modeling workspace.
      const studio = withoutAskLocationHref(window.location.href);
      const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (studio !== here) window.history.replaceState(window.history.state, '', studio);
      return;
    }
    const stripped = withoutDomainStudioLocationHref(window.location.href);
    // The Ask thread lives in the URL only while Ask is open; leaving Ask
    // must not leave a reload pointing back at it.
    const next = state.mainView !== 'ask' && state.mainView !== 'ask_trace' && state.mainView !== 'ask_observability'
      ? withoutAskTraceLocationHref(`${window.location.origin}${withoutAskLocationHref(`${window.location.origin}${stripped}`)}`)
      : stripped;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [state.mainView]);

  // A page link (`?app=<id>&page=<id>`, RFC 0008 step 10) opens that page in
  // the reader once, on load.
  useEffect(() => {
    const link = readAppPageLink(window.location.href);
    if (link) dispatch({ type: 'OPEN_APP', appId: link.appId, ...(link.pageId ? { dashboardId: link.pageId } : {}), experience: 'view', section: 'dashboards' });
    // A draft link (`?appDraft=<id>`, from MCP `build_dql_app`) opens that
    // draft in App Studio once, on load.
    const draftId = readAppDraftLink(window.location.href);
    if (draftId) {
      window.history.replaceState(window.history.state, '', withoutAppDraftLink(window.location.href));
      dispatch({ type: 'OPEN_APP_DRAFT', draftId });
    }
  }, [dispatch]);

  // While a published page is open for reading, the address bar is its link.
  useEffect(() => {
    const reading = state.mainView === 'apps' && state.activeAppId && !state.activeAppDraftId && state.activeAppExperience === 'view';
    const next = withAppPageLink(window.location.href, reading ? { appId: state.activeAppId!, pageId: state.activeDashboardId } : null);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [state.activeAppDraftId, state.activeAppExperience, state.activeAppId, state.activeDashboardId, state.mainView]);

  // Under a host, everyone lands on Home: Ask (with the Home cards) for people
  // who may ask, Apps with the Home cards above the list for the rest. Once, on load.
  const hostUi = useHostUi();
  useEffect(() => {
    const view = hostLandingView(hostUi, { pathname: window.location.pathname, mainView: state.mainView, activeAppId: state.activeAppId });
    if (view) dispatch({ type: 'SET_MAIN_VIEW', view });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the landing is decided once, from the first state
  }, []);

  // Global keyboard shortcuts
  useKeyboardShortcuts();
  // Debounced autosave of cell results to <notebook>.run.json
  useRunSnapshotAutosave();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_INSPECTOR' });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dispatch]);

  const handleOpenFile = useCallback(
    async (file: NotebookFile) => {
      try {
        if (file.type === 'term' || file.type === 'business_view') {
          if (state.sidebarPanel !== 'files') dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
          dispatch({ type: 'OPEN_BUSINESS_ARTIFACT', file });
          return;
        }
        if (file.type === 'block') {
          const payload = await api.openBlockStudio(file.path);
          dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
          return;
        }
        const { content } = await api.readNotebook(file.path);
        const { title, cells, metadata } = parseNotebookFile(file.path, content);

        const snap = file.path.endsWith('.dqlnb') ? await api.fetchRunSnapshot(file.path) : null;
        let hydrated = cells;
        if (snap?.found && snap.snapshot) {
          const byId = new Map(snap.snapshot.cells.map((e) => [e.cellId, e]));
          hydrated = cells.map((c) => {
            const entry = byId.get(c.id);
            if (!entry) return c;
            return {
              ...c,
              status: entry.status ?? c.status,
              result: entry.result ?? c.result,
              error: entry.error ?? c.error,
              executionCount: entry.executionCount ?? c.executionCount,
              execution: entry.execution ?? c.execution,
              fromSnapshot: entry.result != null,
            };
          });
        }

        dispatch({ type: 'OPEN_FILE', file, cells: hydrated, title, metadata });
        // Ensure files panel is visible
        if (state.sidebarPanel !== 'files') {
          dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'files' });
        }
      } catch (err) {
        console.error('Failed to open file:', err);
        if (file.type === 'block') {
          try {
            const { content } = await api.readNotebook(file.path);
            dispatch({
              type: 'OPEN_BLOCK_STUDIO',
              file,
              payload: {
                path: file.path,
                source: content,
                companionPath: null,
                metadata: {
                  name: file.name.replace(/\.dql$/i, ''),
                  path: file.path,
                  domain: file.path.split('/').slice(1, -1).join('/') || 'uncategorized',
                  description: '',
                  owner: '',
                  tags: [],
                },
                validation: {
                  valid: false,
                  diagnostics: [{ severity: 'warning', message: 'Opened saved query without studio metadata. Save once to normalize it.' }],
                  semanticRefs: { metrics: [], dimensions: [], segments: [] },
                },
              },
            });
            return;
          } catch (fallbackErr) {
            console.error('Failed to open block fallback:', fallbackErr);
          }
        } else {
          dispatch({
            type: 'OPEN_FILE',
            file,
            cells: [makeCell('sql')],
            title: file.name,
          });
        }
      }
    },
    [dispatch, state.sidebarPanel]
  );

  const handleNavigateToCell = useCallback((cellId: string) => {
    const el = cellRefs.current[cellId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const registerCellRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      cellRefs.current[id] = el;
    } else {
      delete cellRefs.current[id];
    }
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: t.appBg,
        fontFamily: t.font,
        color: t.textPrimary,
        overflow: 'hidden',
      }}
    >
      {/* The host's strip (HH-9), e.g. "Draft space — changes go to review" */}
      <HostBanner />
      {/* Header spans full width */}
      <Header />
      <HostRefusalNotice />
      <ReadOnlyStrip mainView={state.mainView} />

      {/* Body row: ActivityBar + Sidebar + Main.
          v1.3 Track 5 — ActivityBar + Sidebar hidden in App mode. */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {state.appMode === 'studio' && <ActivityBar />}

        {state.appMode === 'studio' && state.sidebarOpen && !blockWorkspaceOpen && (
          <Sidebar
            onOpenFile={handleOpenFile}
          />
        )}

        {/* Main content column */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <Suspense fallback={<PageLoading t={t} />}>
            {state.mainView === 'home' ? (
              <HomePage />
            ) : state.mainView === 'ask' ? (
              <AnalyticsHome />
            ) : state.mainView === 'business_artifact' ? (
              <BusinessArtifactView />
            ) : state.mainView === 'lineage' ? (
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <LineageDAG />
              </div>
            ) : state.mainView === 'lineage_detail' ? (
              <LineageDetailView />
            ) : state.mainView === 'help' ? (
              <HelpDocsPage />
            ) : state.mainView === 'connection' || state.mainView === 'settings' ? (
              <ConnectionWorkspace>
                <ConnectionPanel variant="page" />
              </ConnectionWorkspace>
            ) : state.mainView === 'git' ? (
              <GitPage />
            ) : state.mainView === 'readiness' ? (
              <ReadinessPage />
            ) : state.mainView === 'skills' ? (
              // Skills live on the Modeling page: one place for the context Ask reads.
              <DbtFirstModelingPage key="modeling-skills" initialSection="skills" />
            ) : state.mainView === 'domains' || state.mainView === 'modeling' ? (
              <DbtFirstModelingPage key="modeling" />
            ) : state.mainView === 'apps' ? (
              <>
                {/* Under a host the Apps list is Home for people without Ask: the summary sits above it. */}
                {hostUi.host && !state.activeAppId && !state.activeAppDraftId ? (
                  <div style={{ flexShrink: 0, maxHeight: '40vh', overflowY: 'auto' }}>
                    <HomeSummary />
                  </div>
                ) : null}
                <AppsView />
              </>
            ) : state.mainView === 'agent_log' ? (
              <FullPageSection
                title="Agent steps"
                description="What the agent did to answer this question, and where the time went — route, tools, checks, and per-step timing."
              >
                <AgentLogPage />
              </FullPageSection>
            ) : state.mainView === 'host_page' ? (
              <HostPageView />
            ) : state.mainView === 'ask_observability' ? (
              <AskObservabilityPage />
            ) : state.mainView === 'ask_trace' && state.askTraceRunId ? (
              <AskTracePage runId={state.askTraceRunId} />
            ) : (
              <>
                {state.mainView === 'imports' || state.mainView === 'block_studio' ? (
                  <BlockStudio key="block-editor" />
                ) : (
                  <>
                    <NotebookEditor
                      onOpenFile={handleOpenFile}
                      registerCellRef={registerCellRef}
                    />
                    {state.appMode === 'studio' && <DevPanel />}
                  </>
                )}
              </>
            )}
          </Suspense>
        </div>

        {state.appMode === 'studio' && state.lineageDrawerOpen && !state.lineageFullscreen && !state.dashboardMode && (
          <Suspense fallback={null}><LineageDrawer /></Suspense>
        )}

        {state.appMode === 'studio' && state.inspectorOpen && !state.lineageFullscreen && !state.lineageDrawerOpen && !state.dashboardMode && (
          <InspectorPanel />
        )}

        {/* App copilot rail — only on the Apps surface (tile follow-up). Analyst
            surfaces (Notebook, Block Studio) have their own AI; Ask is its own chat.
            Scoping here avoids a redundant second AI on those pages. */}
        {state.globalAi.open && state.mainView === 'apps' && (
          <Suspense fallback={null}><GlobalAiRail /></Suspense>
        )}

      </div>

      {/* Modals */}
      {state.newNotebookModalOpen && (
        <Suspense fallback={null}><NewNotebookModal onFileOpened={handleOpenFile} /></Suspense>
      )}
      {state.newBlockModalOpen && (
        <Suspense fallback={null}><NewBlockModal onFileOpened={handleOpenFile} /></Suspense>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Spec 14 — shared AI Build surface for the non-notebook front doors. */}
      <Suspense fallback={null}><AiBuildDialog /></Suspense>
      {/* Short Guided Setup workflow launched from Settings Overview or first run. */}
      {state.setupOpen && (
        <Suspense fallback={<SetupLaunchGate t={t} />}>
          <SetupOnboarding
            launch={setupLaunch?.shouldOpen ? setupLaunch : undefined}
            onAcknowledged={() => setSetupLaunch((current) => current ? { ...current, shouldOpen: false, reason: null } : current)}
          />
        </Suspense>
      )}
    </div>
  );
}

function PageLoading({ t }: { t: (typeof themes)[keyof typeof themes] }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flex: 1, minWidth: 0, display: 'grid', placeItems: 'center',
        background: t.appBg, color: t.textSecondary, fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: t.accent }} />
        Loading workspace…
      </div>
    </div>
  );
}

function SetupLaunchGate({ t }: { t: (typeof themes)[keyof typeof themes] }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, display: 'grid', placeItems: 'center',
        background: t.appBg, color: t.textSecondary, fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: t.accent }} />
        Checking workspace setup…
      </div>
    </div>
  );
}

function ConnectionWorkspace({ children }: { children: React.ReactNode }) {
  // The prototype's Settings screen puts the section nav directly under the app
  // header — each section carries its own heading, so no page-level H1 here.
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '18px 28px 32px',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function FullPageSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ padding: '18px 24px 12px', borderBottom: '1px solid rgba(127, 127, 127, 0.16)' }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6, maxWidth: 760, lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
