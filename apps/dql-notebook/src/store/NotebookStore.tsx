/**
 * Notebook store — Zustand-backed, API-compatible with the previous reducer.
 *
 * Migration strategy
 * - Internal: Zustand store holds state + a `dispatch(action)` method that
 *   runs the original pure reducer. This keeps every existing
 *   `dispatch({...})` call site working unchanged.
 * - External: `useNotebook()` still returns `{ state, dispatch }`. Existing
 *   38 consumers stay put.
 * - New perf win: `useNotebookStore(selector)` subscribes to a slice with
 *   shallow equality — use this for hot paths (lineage, schema tree,
 *   semantic tree). Replaces unnecessary re-renders from full Context changes.
 * - Convenience hooks (`useCells`, `useFiles`, `useSemantic`, `useActiveFile`,
 *   `useInspector`) cover the common slicing patterns.
 */
import React, { createContext, useContext, type ReactNode } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { NotebookState, NotebookAction, Cell } from "./types";
import { downstreamCellIds } from "../utils/notebook-dependencies";
import { appHomePageId } from "../components/apps/app-links";

// Apps now live in the sidebar, so the notebook shell always starts in the
// full authoring surface. Clear the legacy mode preference so users do not get
// stuck in the old App/Reader chrome after the header tabs were removed.
function readInitialAppMode(): 'studio' {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.removeItem('dql-app-mode');
    } catch {
      // ignore privacy-mode failures
    }
  }
  return 'studio';
}

// Hex-handoff default: paper (warm off-white). Honors persisted choice.
function readInitialThemeMode(): 'obsidian' | 'paper' | 'white' {
  if (typeof window === 'undefined') return 'paper';
  const stored = window.localStorage?.getItem('dql-theme');
  if (stored === 'obsidian' || stored === 'paper' || stored === 'white') return stored;
  if (stored === 'midnight' || stored === 'dark') return 'obsidian';
  if (stored === 'arctic') return 'white';
  if (stored === 'light') return 'paper';
  return 'paper';
}

/**
 * OBS-009 / OBS-013: Ask trace navigation deliberately persists only a route
 * and (for detail) a run ID. Keep the parser pure so reload/back-forward
 * behavior can be tested without constructing a trace, API client, or browser
 * cache entry.
 */
export type AskTraceRoute =
  | { mainView: 'ask_observability' }
  | { mainView: 'ask_trace'; runId: string };

export function askTraceRouteFromPathname(pathname: string | undefined): AskTraceRoute | undefined {
  if (pathname === '/ask/traces') return { mainView: 'ask_observability' };
  const match = pathname?.match(/^\/ask\/traces\/([^/]+)$/);
  return match?.[1] ? { mainView: 'ask_trace', runId: decodeURIComponent(match[1]) } : undefined;
}

function readInitialMainView(): NotebookState['mainView'] {
  if (typeof window === 'undefined') return 'apps';
  const askTraceRoute = askTraceRouteFromPathname(window.location?.pathname);
  if (askTraceRoute) return askTraceRoute.mainView;
  // `/ask` (with or without a thread) reopens Ask: a reload never lands on Apps.
  if (window.location?.pathname === '/ask') return 'ask';
  const params = new URLSearchParams(window.location.search);
  return params.has('domain') || params.has('domainSection') || params.has('modelArea')
    ? 'domains'
    : 'apps';
}

/**
 * `/?app=<id>&page=<id>` opens that App page (the link deliveries and hosts
 * send). The parameters are removed once read, so a reload starts fresh.
 */
export function appLinkFromSearch(search: string): { appId: string; dashboardId: string | null } | null {
  const params = new URLSearchParams(search);
  const id = /^[A-Za-z0-9][\w.-]{0,127}$/;
  const appId = params.get('app')?.trim() ?? '';
  if (!id.test(appId)) return null;
  const page = params.get('page')?.trim() ?? '';
  return { appId, dashboardId: id.test(page) ? page : null };
}

const initialAppLink = (() => {
  if (typeof window === 'undefined' || typeof window.location?.search !== 'string') return null;
  const link = appLinkFromSearch(window.location.search);
  if (link) {
    const params = new URLSearchParams(window.location.search);
    params.delete('app');
    params.delete('page');
    const rest = params.toString();
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`); } catch { /* keep the URL */ }
  }
  return link;
})();

function readInitialAskTraceRunId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const route = askTraceRouteFromPathname(window.location?.pathname);
  return route?.mainView === 'ask_trace' ? route.runId : undefined;
}

const initialState: NotebookState = {
  mainView: initialAppLink ? 'apps' : readInitialMainView(),
  agentLogRun: undefined,
  askTraceRunId: readInitialAskTraceRunId(),
  settingsTab: 'overview',
  themeMode: readInitialThemeMode(),
  appMode: readInitialAppMode(),
  sidebarPanel: null,
  sidebarOpen: false,
  files: [],
  filesLoading: false,
  activeFile: null,
  cells: [],
  notebookTitle: '',
  notebookMetadata: {},
  notebookDirty: false,
  schemaTables: [],
  schemaLoading: false,
  authoredDomains: [],
  semanticLayer: {
    available: false,
    provider: null,
    metrics: [],
    measures: [],
    dimensions: [],
    timeDimensions: [],
    entities: [],
    hierarchies: [],
    semanticModels: [],
    savedQueries: [],
    domains: [],
    tags: [],
    favorites: [],
    recentlyUsed: [],
    loading: false,
    lastSyncTime: null,
  },
  devPanelOpen: false,
  devPanelTab: 'logs',
  queryLog: [],
  newNotebookModalOpen: false,
  newBlockModalOpen: false,
  newBlockModalDefaultType: 'custom',
  autoSave: true,
  executionCounter: 0,
  savingFile: false,
  lineageFullscreen: false,
  lineageFocusNodeId: null,
  lineageReturnTarget: null,
  lineageDrawerOpen: false,
  lineageDrawerNodeId: null,
  dashboardMode: false,
  activeBlockPath: null,
  blockStudioDraft: '',
  blockStudioDirty: false,
  blockStudioPreview: null,
  blockStudioLastRun: null,
  blockStudioValidation: null,
  blockStudioMetadata: null,
  blockStudioCatalog: null,
  blockStudioCatalogLoading: false,
  blockStudioImportOpen: false,
  blockStudioDbtStatus: null,
  setupOpen: false,
  setupModelSource: null,
  inspectorOpen: false,
  inspectorContext: null,
  apps: [],
  appsLoading: false,
  activeAppId: initialAppLink?.appId ?? null,
  activeAppDraftId: null,
  activeDashboardId: initialAppLink?.dashboardId ?? null,
  activeAppExperience: 'view',
  activeAppSection: 'dashboards',
  activePersona: null,
  globalAi: { open: false, audience: 'stakeholder', context: {} },
};

export function ensureUniqueCellIds(cells: Cell[]): Cell[] {
  const used = new Set<string>();
  return cells.map((cell) => {
    let id = cell.id?.trim();
    if (!id || used.has(id)) {
      do {
        id = makeCellId();
      } while (used.has(id));
    }
    used.add(id);
    return id === cell.id ? cell : { ...cell, id };
  });
}

/**
 * Pure reducer — identical semantics to the previous useReducer version.
 * Kept as a free function so the action surface stays declarative and the
 * store definition below is tiny.
 */
function notebookReducer(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
    case 'SET_MAIN_VIEW':
      // A user leaving either trace catalog/detail through the normal Ask
      // navigation should not reload back into the prior trace route.
      if (action.view === 'ask' && typeof window !== 'undefined' && /^\/ask\/traces(?:\/|$)/.test(window.location.pathname)) {
        window.history.pushState({}, '', '/ask');
      }
      if (action.view === 'imports') {
        return {
          ...state,
          mainView: 'block_studio',
          sidebarPanel: 'block_library',
          sidebarOpen: true,
          blockStudioImportOpen: true,
          lineageFullscreen: false,
          lineageFocusNodeId: null,
          lineageReturnTarget: null,
        };
      }
      if (action.view === 'home') {
        return {
          ...state,
          mainView: 'home',
          sidebarPanel: null,
          sidebarOpen: false,
          lineageFullscreen: false,
          lineageFocusNodeId: null,
          lineageReturnTarget: null,
          lineageDrawerOpen: false,
          lineageDrawerNodeId: null,
          dashboardMode: false,
        };
      }
      return {
        ...state,
        mainView: action.view,
        // A block and a notebook share the outer editor shell but not an active
        // document contract. When a user explicitly opens Notebooks after
        // Block Studio, show the notebook landing state until they pick a file
        // instead of rendering block metadata over an empty notebook.
        ...(action.view === 'notebook' && state.activeFile?.type === 'block'
          ? {
              activeFile: null,
              cells: [],
              notebookTitle: '',
              notebookMetadata: {},
              notebookDirty: false,
              dashboardMode: false,
            }
          : {}),
        lineageFullscreen: false,
        lineageFocusNodeId: null,
        lineageReturnTarget: null,
      };
    case 'OPEN_AGENT_LOG':
      return { ...state, agentLogRun: action.run, mainView: 'agent_log' };

    case 'OPEN_ASK_TRACE': {
      if (typeof window !== 'undefined') {
        const nextPath = `/ask/traces/${encodeURIComponent(action.runId)}`;
        if (window.location.pathname !== nextPath) window.history.pushState({ askTraceRunId: action.runId }, '', nextPath);
      }
      return { ...state, askTraceRunId: action.runId, mainView: 'ask_trace' };
    }

    case 'OPEN_ASK_OBSERVABILITY': {
      if (typeof window !== 'undefined' && window.location.pathname !== '/ask/traces') {
        window.history.pushState({ askObservability: true }, '', '/ask/traces');
      }
      return { ...state, askTraceRunId: undefined, mainView: 'ask_observability' };
    }

    case 'SET_SETTINGS_TAB':
      return { ...state, settingsTab: action.tab };

    case 'SET_THEME': {
      // Sync the data-theme attribute BEFORE React re-renders. Inline-style
      // reads like `t.activityBarBg` resolve the Luna CSS var at render time;
      // if we wait for a post-render useEffect to flip data-theme, children
      // paint one frame of stale colors (v1.3 Track 9 — four-theme switch).
      if (typeof document !== 'undefined') {
        const luna =
          action.mode === 'dark' || action.mode === 'midnight' ? 'obsidian'
          : action.mode === 'light' ? 'paper'
          : action.mode === 'arctic' ? 'white'
          : action.mode;
        document.documentElement.setAttribute('data-theme', luna);
        try {
          window.localStorage?.setItem('dql-theme', action.mode);
        } catch {
          // ignore quota / privacy-mode failures
        }
      }
      return { ...state, themeMode: action.mode };
    }

    case 'SET_APP_MODE': {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage?.removeItem('dql-app-mode');
        } catch {
          // ignore quota / privacy-mode failures — it's a preference
        }
      }
      return { ...state, appMode: 'studio' };
    }

    case 'SET_SIDEBAR_PANEL': {
      if (action.panel === 'lineage') {
        // Lineage is a full-page graph canvas (Lineage Redesign) — no sidebar
        // index list; focus happens in-canvas.
        return {
          ...state,
          sidebarPanel: 'lineage',
          sidebarOpen: false,
          lineageFullscreen: false,
          lineageFocusNodeId: state.mainView === 'lineage_detail' ? state.lineageFocusNodeId : null,
          lineageReturnTarget: null,
          mainView: 'lineage',
        };
      }
      const fullPagePanels = ['connection', 'git', 'apps', 'readiness', 'skills', 'domains', 'settings'] as const;
      const isFullPage = (action.panel as string | null) !== null
        && (fullPagePanels as readonly string[]).includes(action.panel as string);
      const nextMainView =
        action.panel === 'connection'
          ? 'connection'
          : action.panel === 'git'
              ? 'git'
              : action.panel === 'apps'
                ? 'apps'
                : action.panel === 'readiness'
                  ? 'readiness'
                  : action.panel === 'skills'
                  ? 'skills'
                  : action.panel === 'domains'
                  ? 'domains'
                  : action.panel === 'settings'
                  ? 'connection'
                  : action.panel === 'files'
                    ? 'notebook'
                    : action.panel === 'block_library'
                      ? 'block_studio'
                      : state.activeFile?.type === 'block'
                        ? 'block_studio'
                        : 'notebook';
      return {
        ...state,
        sidebarPanel: action.panel,
        sidebarOpen: action.panel !== null && !isFullPage,
        ...(nextMainView === 'notebook' && state.activeFile?.type === 'block'
          ? {
              activeFile: null,
              cells: [],
              notebookTitle: '',
              notebookMetadata: {},
              notebookDirty: false,
              dashboardMode: false,
            }
          : {}),
        lineageFullscreen: false,
        lineageFocusNodeId: null,
        lineageReturnTarget: null,
        mainView: nextMainView,
      };
    }

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };

    case 'SET_FILES':
      return { ...state, files: action.files };

    case 'SET_FILES_LOADING':
      return { ...state, filesLoading: action.loading };

    case 'OPEN_BUSINESS_ARTIFACT':
      return {
        ...state,
        activeFile: action.file,
        cells: [],
        notebookTitle: action.file.name.replace(/\.(dqlnb|dql)$/i, ''),
        notebookDirty: false,
        mainView: 'business_artifact',
        activeBlockPath: null,
        blockStudioDraft: '',
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioLastRun: null,
        blockStudioValidation: null,
        blockStudioMetadata: null,
        dashboardMode: false,
        lineageFullscreen: false,
        lineageDrawerOpen: false,
        lineageDrawerNodeId: null,
        lineageFocusNodeId: `${action.file.type}:${action.file.name.replace(/\.(dqlnb|dql)$/i, '')}`,
      };

    case 'OPEN_FILE':
      return {
        ...state,
        activeFile: action.file,
        cells: ensureUniqueCellIds(action.cells),
        notebookTitle: action.title,
        notebookMetadata: action.metadata ?? {},
        notebookDirty: false,
        mainView: action.file.type === 'block' ? 'block_studio' : 'notebook',
        activeBlockPath: action.file.type === 'block' ? action.file.path : null,
        blockStudioDraft: action.file.type === 'block' ? state.blockStudioDraft : '',
        blockStudioDirty: false,
        blockStudioPreview: action.file.type === 'block' ? state.blockStudioPreview : null,
        blockStudioLastRun: action.file.type === 'block' ? state.blockStudioLastRun : null,
        blockStudioValidation: action.file.type === 'block' ? state.blockStudioValidation : null,
        blockStudioMetadata: action.file.type === 'block' ? state.blockStudioMetadata : null,
        lineageFullscreen: false,
        lineageFocusNodeId: null,
      };

    case 'OPEN_BLOCK_STUDIO':
      return {
        ...state,
        activeFile: action.file,
        cells: [],
        notebookTitle: action.payload.metadata.name,
        notebookDirty: false,
        mainView: 'block_studio',
        dashboardMode: false,
        activeBlockPath: action.payload.path,
        blockStudioDraft: action.payload.source,
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioLastRun: action.payload.lastRun ?? null,
        blockStudioValidation: action.payload.validation,
        blockStudioMetadata: action.payload.metadata,
        blockStudioImportOpen: false,
        lineageFullscreen: false,
        lineageFocusNodeId: action.payload.metadata?.name ? `block:${action.payload.metadata.name}` : null,
      };

    case 'BLOCK_CERTIFICATION_ACCEPTED':
      // The server wrote the attempt somewhere: the same file, or a draft beside
      // a certified block. The editor continues on that file and its fingerprint,
      // so the next Save or Certify is not rejected as "changed after it was opened".
      if (action.draft) {
        const draftFile: NotebookState['files'][number] = { name: `${action.draft.metadata.name}.dql`, path: action.draft.path, type: 'block', folder: 'blocks' };
        return {
          ...state,
          files: state.files.some((file) => file.path === action.draft!.path) ? state.files : [...state.files, draftFile],
          activeFile: draftFile,
          activeBlockPath: action.draft.path,
          blockStudioDraft: action.draft.source,
          blockStudioDirty: false,
          blockStudioPreview: null,
          blockStudioLastRun: null,
          blockStudioValidation: action.draft.validation,
          blockStudioMetadata: action.draft.metadata,
        };
      }
      return {
        ...state,
        blockStudioDraft: action.source,
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioLastRun: null,
        blockStudioMetadata: state.blockStudioMetadata
          ? { ...state.blockStudioMetadata, reviewStatus: 'draft' }
          : null,
      };

    case 'RECONCILE_BLOCK_CERTIFICATION': {
      const nextPath = action.newPath ?? action.payload.path;
      const nextFile: NotebookState['files'][number] = {
        name: `${action.payload.metadata.name}.dql`,
        path: nextPath,
        type: 'block',
        folder: 'blocks',
        isNew: false,
      };
      const pathsToRemove = action.outcome === 'certified'
        ? new Set([action.draftPath, action.oldPath].filter((path) => path !== nextPath && path.includes('/_drafts/')))
        : new Set<string>();
      const files = state.files.filter((file) => !pathsToRemove.has(file.path));
      const existingIndex = files.findIndex((file) => file.path === nextPath);
      const nextFiles = existingIndex >= 0
        ? files.map((file, index) => index === existingIndex ? { ...file, ...nextFile } : file)
        : [...files, nextFile];
      const activeMatches = state.mainView === 'block_studio'
        && !state.blockStudioDirty
        && (!state.activeBlockPath || [action.oldPath, action.draftPath, nextPath].includes(state.activeBlockPath));
      if (!activeMatches) return { ...state, files: nextFiles };
      return {
        ...state,
        files: nextFiles,
        activeFile: nextFile,
        activeBlockPath: nextPath,
        notebookTitle: action.payload.metadata.name,
        blockStudioDraft: action.payload.source,
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioLastRun: action.payload.lastRun ?? null,
        blockStudioValidation: action.payload.validation,
        blockStudioMetadata: action.payload.metadata,
        lineageFocusNodeId: `block:${action.payload.metadata.name}`,
      };
    }

    case 'SET_CELLS':
      return { ...state, cells: ensureUniqueCellIds(action.cells), notebookDirty: true };

    case 'UPDATE_NOTEBOOK_METADATA': {
      const current = state.notebookMetadata;
      let changed = false;
      for (const key of Object.keys(action.updates) as Array<keyof typeof action.updates>) {
        if (current[key] !== action.updates[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return state;
      return {
        ...state,
        notebookMetadata: { ...current, ...action.updates },
        notebookDirty: true,
      };
    }

    case 'ADD_CELL': {
      const cell = state.cells.some((candidate) => candidate.id === action.cell.id)
        ? { ...action.cell, id: makeCellId() }
        : action.cell;
      if (!action.afterId) {
        return { ...state, cells: [...state.cells, cell], notebookDirty: true };
      }
      const idx = state.cells.findIndex((c) => c.id === action.afterId);
      if (idx === -1) {
        return { ...state, cells: [...state.cells, cell], notebookDirty: true };
      }
      const newCells = [...state.cells];
      newCells.splice(idx + 1, 0, cell);
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case "UPDATE_CELL": {
      const invalidatesDependents =
        action.updates.content !== undefined ||
        action.updates.name !== undefined ||
        action.updates.executionTarget !== undefined ||
        action.updates.datasetRefs !== undefined ||
        action.updates.dependencies !== undefined ||
        action.updates.dqlParameterValues !== undefined ||
        action.updates.blockBinding !== undefined;
      const downstream = invalidatesDependents
        ? downstreamCellIds(action.id, state.cells)
        : new Set<string>();
      const cells = state.cells.map((c) => {
        if (c.id === action.id) {
          const updated = { ...c, ...action.updates };
          return invalidatesDependents && c.result && action.updates.stale === undefined
            ? { ...updated, stale: true }
            : updated;
        }
        if (downstream.has(c.id) && c.result) return { ...c, stale: true };
        return c;
      });
      const executionCounter =
        action.updates.executionCount !== undefined
          ? state.executionCounter + 1
          : state.executionCounter;
      return { ...state, cells, notebookDirty: true, executionCounter };
    }

    case 'DELETE_CELL':
      return {
        ...state,
        cells: state.cells.filter((c) => c.id !== action.id),
        notebookDirty: true,
      };

    case 'MOVE_CELL': {
      const idx = state.cells.findIndex((c) => c.id === action.id);
      if (idx === -1) return state;
      const newCells = [...state.cells];
      if (action.direction === 'up' && idx > 0) {
        [newCells[idx - 1], newCells[idx]] = [newCells[idx], newCells[idx - 1]];
      } else if (action.direction === 'down' && idx < newCells.length - 1) {
        [newCells[idx], newCells[idx + 1]] = [newCells[idx + 1], newCells[idx]];
      }
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case 'REORDER_CELL': {
      const { fromIndex, toIndex } = action;
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= state.cells.length || toIndex >= state.cells.length) return state;
      const newCells = [...state.cells];
      const [moved] = newCells.splice(fromIndex, 1);
      newCells.splice(toIndex, 0, moved);
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case 'SET_SCHEMA':
      return { ...state, schemaTables: action.tables };

    case 'MERGE_SCHEMA_TABLES': {
      const merged = new Map(
        state.schemaTables.map((table) => [table.path.toLowerCase(), table] as const),
      );
      for (const table of action.tables) {
        const key = table.path.toLowerCase();
        const existing = merged.get(key);
        merged.set(key, existing
          ? {
              ...existing,
              ...table,
              columns: table.columns.length > 0 ? table.columns : existing.columns,
              expanded: existing.expanded,
            }
          : table);
      }
      return { ...state, schemaTables: Array.from(merged.values()) };
    }

    case 'SET_SCHEMA_LOADING':
      return { ...state, schemaLoading: action.loading };

    case 'SET_AUTHORED_DOMAINS':
      return { ...state, authoredDomains: action.domains };

    case 'TOGGLE_SCHEMA_TABLE':
      return {
        ...state,
        schemaTables: state.schemaTables.map((t) =>
          t.name === action.tableName ? { ...t, expanded: !t.expanded } : t
        ),
      };

    case 'TOGGLE_DEV_PANEL':
      return { ...state, devPanelOpen: !state.devPanelOpen };

    case 'SET_DEV_PANEL_TAB':
      return { ...state, devPanelTab: action.tab };

    case 'APPEND_QUERY_LOG':
      return { ...state, queryLog: [...state.queryLog, action.entry] };

    case 'OPEN_NEW_NOTEBOOK_MODAL':
      return { ...state, newNotebookModalOpen: true };

    case 'CLOSE_NEW_NOTEBOOK_MODAL':
      return { ...state, newNotebookModalOpen: false };

    case 'OPEN_NEW_BLOCK_MODAL':
      return { ...state, newBlockModalOpen: true, newBlockModalDefaultType: action.blockType ?? 'custom' };

    case 'START_NEW_BLOCK_WORKSPACE':
      return {
        ...state,
        mainView: 'block_studio',
        sidebarPanel: 'block_library',
        sidebarOpen: true,
        activeFile: null,
        activeBlockPath: null,
        blockStudioDraft: '',
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioLastRun: null,
        blockStudioValidation: null,
        blockStudioMetadata: null,
        blockStudioImportOpen: false,
        newBlockModalOpen: false,
        newBlockModalDefaultType: action.blockType ?? 'custom',
        notebookTitle: 'Saved queries',
      };

    case 'CLOSE_NEW_BLOCK_MODAL':
      return { ...state, newBlockModalOpen: false };

    case 'SET_AUTO_SAVE':
      return { ...state, autoSave: action.enabled };

    case 'SET_NOTEBOOK_DIRTY':
      return { ...state, notebookDirty: action.dirty };

    case 'SET_SAVING':
      return { ...state, savingFile: action.saving };

    case 'FILE_ADDED':
      // Dedup by path — a file must never appear twice in the tree/sidebar.
      if (state.files.some((f) => f.path === action.file.path)) return state;
      return { ...state, files: [...state.files, action.file] };

    case 'FILE_REMOVED': {
      const files = state.files.filter((file) => file.path !== action.path);
      // Deleting the file that is currently open must also close it, or the
      // editor keeps rendering a notebook that no longer exists and the next
      // save recreates it.
      if (state.activeFile?.path !== action.path) return { ...state, files };
      return {
        ...state,
        files,
        activeFile: null,
        cells: [],
        notebookTitle: '',
        notebookMetadata: {},
        notebookDirty: false,
      };
    }

    case 'SET_TABLE_COLUMNS':
      return {
        ...state,
        schemaTables: state.schemaTables.map((t) =>
          t.name === action.tableName ? { ...t, columns: action.columns } : t
        ),
      };

    case 'SET_PARAM_VALUE':
      return {
        ...state,
        cells: state.cells.map((c) =>
          c.id === action.id ? { ...c, paramValue: action.value } : c
        ),
        notebookDirty: true,
      };

    case 'SET_SEMANTIC_LAYER':
      return {
        ...state,
        semanticLayer: { ...action.layer, loading: false },
      };

    case 'SET_SEMANTIC_LOADING':
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, loading: action.loading },
      };

    case 'SET_SEMANTIC_FAVORITES':
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, favorites: action.favorites },
      };

    case 'ADD_SEMANTIC_RECENT': {
      const nextRecent = [action.name, ...state.semanticLayer.recentlyUsed.filter((item) => item !== action.name)].slice(0, 12);
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, recentlyUsed: nextRecent },
      };
    }

    case 'SET_SEMANTIC_DOMAINS':
      return {
        ...state,
        semanticLayer: {
          ...state.semanticLayer,
          domains: action.domains,
          tags: action.tags,
          lastSyncTime: action.lastSyncTime ?? state.semanticLayer.lastSyncTime,
        },
      };

    case 'TOGGLE_LINEAGE_FULLSCREEN':
      return { ...state, lineageFullscreen: !state.lineageFullscreen };

    case 'SET_LINEAGE_FOCUS':
      return { ...state, lineageFocusNodeId: action.nodeId };

    case 'OPEN_LINEAGE_DETAIL': {
      const lineageReturnTarget = action.returnTo !== undefined
        ? action.returnTo
        : state.mainView === 'lineage_detail'
          ? state.lineageReturnTarget
          : null;
      return {
        ...state,
        mainView: 'lineage_detail',
        lineageFullscreen: false,
        lineageFocusNodeId: action.nodeId,
        lineageReturnTarget,
        lineageDrawerOpen: false,
        lineageDrawerNodeId: null,
        dashboardMode: false,
      };
    }

    case 'OPEN_LINEAGE_DRAWER':
      return { ...state, lineageDrawerOpen: true, lineageDrawerNodeId: action.nodeId };

    case 'CLOSE_LINEAGE_DRAWER':
      return { ...state, lineageDrawerOpen: false, lineageDrawerNodeId: null };

    case 'TOGGLE_DASHBOARD_MODE':
      return { ...state, dashboardMode: !state.dashboardMode };

    case 'SET_BLOCK_STUDIO_DRAFT':
      return { ...state, blockStudioDraft: action.draft, blockStudioDirty: true };

    case 'SET_BLOCK_STUDIO_DIRTY':
      return { ...state, blockStudioDirty: action.dirty };

    case 'SET_BLOCK_STUDIO_PREVIEW':
      return {
        ...state,
        blockStudioPreview: action.preview,
        blockStudioLastRun: action.preview ? {
          rowCount: action.preview.result.rowCount ?? action.preview.result.rows.length,
          executionTime: action.preview.result.executionTime,
          columns: action.preview.result.columns,
          ranAt: new Date().toISOString(),
        } : state.blockStudioLastRun,
      };

    case 'SET_BLOCK_STUDIO_VALIDATION':
      return { ...state, blockStudioValidation: action.validation };

    case 'SET_BLOCK_STUDIO_METADATA':
      return {
        ...state,
        blockStudioMetadata: action.metadata,
        notebookTitle: action.metadata.name,
        blockStudioDirty: true,
      };

    case 'SET_BLOCK_STUDIO_CATALOG':
      return { ...state, blockStudioCatalog: action.catalog };

    case 'SET_BLOCK_STUDIO_CATALOG_LOADING':
      return { ...state, blockStudioCatalogLoading: action.loading };

    case 'OPEN_BLOCK_IMPORT':
      return {
        ...state,
        mainView: 'block_studio',
        sidebarPanel: 'block_library',
        sidebarOpen: true,
        blockStudioImportOpen: true,
        lineageFullscreen: false,
        lineageFocusNodeId: null,
      };

    case 'CLOSE_BLOCK_IMPORT':
      return { ...state, blockStudioImportOpen: false };

    case 'SET_BLOCK_STUDIO_DBT_STATUS':
      return { ...state, blockStudioDbtStatus: action.status };

    case 'OPEN_SETUP':
      return { ...state, setupOpen: true, setupModelSource: action.modelSource ?? null };

    case 'CLOSE_SETUP':
      return { ...state, setupOpen: false, setupModelSource: null };

    case 'OPEN_GLOBAL_AI':
      return {
        ...state,
        globalAi: {
          open: true,
          audience: action.audience ?? state.globalAi.audience,
          context: action.context ?? state.globalAi.context,
          autoRun: action.autoRun ? { ...action.autoRun, nonce: Date.now() } : state.globalAi.autoRun,
        },
      };

    case 'CLOSE_GLOBAL_AI':
      return { ...state, globalAi: { ...state.globalAi, open: false } };

    case 'TOGGLE_GLOBAL_AI':
      return {
        ...state,
        globalAi: {
          ...state.globalAi,
          open: !state.globalAi.open,
          audience: action.audience ?? state.globalAi.audience,
          context: action.context ?? state.globalAi.context,
        },
      };

    case 'SET_GLOBAL_AI_CONTEXT':
      return {
        ...state,
        globalAi: {
          ...state.globalAi,
          context: action.context,
          audience: action.audience ?? state.globalAi.audience,
        },
      };

    case 'TOGGLE_INSPECTOR':
      return { ...state, inspectorOpen: !state.inspectorOpen };

    case 'SET_INSPECTOR':
      return {
        ...state,
        inspectorOpen: action.open,
        inspectorContext: action.context === undefined ? state.inspectorContext : action.context,
      };

    case 'SET_INSPECTOR_CONTEXT':
      return {
        ...state,
        inspectorContext: action.context,
        inspectorOpen: action.context !== null ? true : state.inspectorOpen,
      };

    case 'SET_APPS': {
      // An App opened by link without a page lands on its home page once Apps are known.
      if (state.activeAppId && !state.activeDashboardId && !state.activeAppDraftId) {
        const app = action.apps.find((candidate) => candidate.id === state.activeAppId);
        const home = appHomePageId(app);
        if (home) return { ...state, apps: action.apps, activeDashboardId: home };
      }
      return { ...state, apps: action.apps };
    }

    case 'SET_APPS_LOADING':
      return { ...state, appsLoading: action.loading };

    case 'OPEN_APP': {
      const app = state.apps.find((a) => a.id === action.appId) ?? null;
      const dashboardId = action.dashboardId !== undefined
        ? action.dashboardId
        : appHomePageId(app);
      const sameApp = state.activeAppId === action.appId;
      return {
        ...state,
        mainView: 'apps',
        activeAppId: action.appId,
        activeAppDraftId: null,
        activeDashboardId: dashboardId,
        activeAppExperience: action.experience ?? (sameApp ? state.activeAppExperience : 'view'),
        activeAppSection: action.section ?? (sameApp ? state.activeAppSection : 'dashboards'),
        lineageReturnTarget: null,
      };
    }

    case 'OPEN_APP_DRAFT':
      return {
        ...state,
        mainView: 'apps',
        activeAppId: action.appId ?? null,
        activeAppDraftId: action.draftId,
        activeDashboardId: action.dashboardId ?? null,
        activeAppExperience: 'build',
        activeAppSection: 'dashboards',
        lineageReturnTarget: null,
      };

    case 'CLOSE_APP':
      return {
        ...state,
        activeAppId: null,
        activeAppDraftId: null,
        activeDashboardId: null,
        activeAppExperience: 'view',
        activeAppSection: 'dashboards',
      };

    case 'OPEN_DASHBOARD':
      return { ...state, activeDashboardId: action.dashboardId };

    case 'SET_APP_WORKSPACE_STATE':
      return {
        ...state,
        activeAppExperience: action.experience ?? state.activeAppExperience,
        activeAppSection: action.section ?? state.activeAppSection,
      };

    case 'SET_ACTIVE_PERSONA':
      return { ...state, activePersona: action.persona };

    default:
      return state;
  }
}

/** Zustand store shape: flat state + a single dispatch(action) method. */
interface StoreShape extends NotebookState {
  dispatch: (action: NotebookAction) => void;
}

/**
 * The singleton store. Exported for tests and rare cross-component access
 * (e.g. event handlers outside React). Components should prefer the hooks
 * below so subscriptions are tracked.
 */
export const useNotebookStore: UseBoundStore<StoreApi<StoreShape>> = create<StoreShape>((set, get) => ({
  ...initialState,
  dispatch: (action: NotebookAction) => {
    const next = notebookReducer(get(), action);
    // Drop the dispatch fn from the reducer's returned state — reducer only
    // sees NotebookState, so we preserve dispatch ourselves.
    set(next);
  },
}));

/** Direct store handle (non-reactive). Use sparingly. */
export const notebookStoreApi = useNotebookStore;

// --- compat layer ---------------------------------------------------------

interface NotebookContextValue {
  state: NotebookState;
  dispatch: React.Dispatch<NotebookAction>;
}

/**
 * Compatibility context — retained only so tests that wrapped with a custom
 * Provider still work. Production code bypasses this and reads from the
 * Zustand store directly via `useNotebook()`.
 */
const NotebookContext = createContext<NotebookContextValue | null>(null);

export function NotebookProvider({ children }: { children: ReactNode }) {
  // Cross-tab theme sync: if a sibling tab changes `dql-theme`, mirror it here.
  React.useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'dql-theme' || !e.newValue) return;
      const mode = e.newValue;
      if (mode === 'obsidian' || mode === 'paper' || mode === 'white' || mode === 'midnight' || mode === 'arctic' || mode === 'dark' || mode === 'light') {
        useNotebookStore.getState().dispatch({ type: 'SET_THEME', mode: mode as any });
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  return <>{children}</>;
}

/**
 * Compat hook with the same `{ state, dispatch }` shape as the old reducer
 * version. Every existing consumer keeps working unchanged. Re-renders on
 * *any* state change — for fine-grained subscriptions, use the slice hooks
 * below or call `useNotebookStore(selector)` directly.
 */
export function useNotebook(): NotebookContextValue {
  // Pull the whole state (minus dispatch) as one snapshot. useShallow keeps
  // this from triggering a re-render when unrelated refs change identity
  // via a new object literal — but any field mutation still re-renders,
  // preserving the old behavior for consumers that read arbitrary fields.
  const state = useNotebookStore(
    useShallow((s) => {
      const { dispatch: _d, ...rest } = s;
      return rest as NotebookState;
    }),
  );
  const dispatch = useNotebookStore((s) => s.dispatch);
  // Honor a test-supplied context if present.
  const ctx = useContext(NotebookContext);
  return ctx ?? { state, dispatch };
}

// --- slice hooks (use these for new or refactored components) ------------

/** Files + loading + active file */
export function useFiles() {
  return useNotebookStore(
    useShallow((s) => ({
      files: s.files,
      filesLoading: s.filesLoading,
      activeFile: s.activeFile,
      notebookTitle: s.notebookTitle,
      notebookDirty: s.notebookDirty,
      savingFile: s.savingFile,
    })),
  );
}

/** Just the cells array + execution counter (notebook body) */
export function useCells() {
  return useNotebookStore(
    useShallow((s) => ({
      cells: s.cells,
      executionCounter: s.executionCounter,
    })),
  );
}

/** Semantic layer slice */
export function useSemantic() {
  return useNotebookStore((s) => s.semanticLayer);
}

/** Schema panel slice */
export function useSchema() {
  return useNotebookStore(
    useShallow((s) => ({
      schemaTables: s.schemaTables,
      schemaLoading: s.schemaLoading,
    })),
  );
}

/** Inspector / shell slice (sidebar, main view, panels, modals, lineage focus) */
export function useInspector() {
  return useNotebookStore(
    useShallow((s) => ({
      mainView: s.mainView,
      sidebarPanel: s.sidebarPanel,
      sidebarOpen: s.sidebarOpen,
      themeMode: s.themeMode,
      lineageFullscreen: s.lineageFullscreen,
      lineageFocusNodeId: s.lineageFocusNodeId,
      dashboardMode: s.dashboardMode,
    })),
  );
}

/** Get the dispatch function without subscribing to any state */
export function useDispatch(): React.Dispatch<NotebookAction> {
  return useNotebookStore((s) => s.dispatch);
}

// --- helpers (unchanged) -------------------------------------------------

export function makeCellId(): string {
  return `cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCell(type: Cell['type'], content = ''): Cell {
  const base: Cell = {
    id: makeCellId(),
    type,
    content,
    status: 'idle',
  };
  if (type === 'param') {
    base.content = '';
    base.paramConfig = {
      paramType: 'text',
      label: 'Parameter',
      defaultValue: '',
      options: [],
    };
  }
  if (type === 'chart') {
    base.chartConfig = { chart: 'bar' };
  }
  if (type === 'filter') {
    base.filterConfig = {
      mode: 'keep',
      groups: [{ id: `g_${Math.random().toString(36).slice(2, 8)}`, combinator: 'and', rules: [] }],
    };
  }
  if (type === 'pivot') {
    base.pivotConfig = { rows: [], columns: [], values: [] };
  }
  if (type === 'single_value') {
    base.singleValueConfig = { aggregation: 'count', format: 'number' };
  }
  if (type === 'table') {
    base.tableConfig = {};
  }
  if (type === 'chat') {
    base.chatConfig = { history: [] };
  }
  return base;
}
