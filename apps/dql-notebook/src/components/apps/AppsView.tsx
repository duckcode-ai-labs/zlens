import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpenText,
  Bot,
  CalendarDays,
  Hash,
  List,
  ToggleLeft,
  Type,
  Check,
  ChevronDown,
  Download,
  Eye,
  FileText,
  GitBranch,
  LayoutDashboard,
  LineChart,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Share2,
  Table2,
  Trash2,
  User,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import {
  api,
  type AppBlockRecommendation,
  type AppDocumentSummary,
  type DashboardDocumentResponse,
  type DashboardRunResponse,
  type AppAiBuildSession,
  type GenerateAppResponse,
  type GeneratedAppPlan,
  type AppAskResponse,
  type LocalAppInvestigation,
  type AppStudioBuildDraft,
} from '../../api/client';
import { isViewerLink } from '../../api/server-auth';
import { hostAllows, hostReader, useHostPage, useHostUi } from '../../host/host-ui';
import { appLibraryWords, type LibraryFilter } from './app-library-words';
import type { AppSummary, AppWorkspaceExperience, AppWorkspaceSection } from '../../store/types';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH } from '../agent/AiSidePanel';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { appPageUrl } from './app-links';
import { defaultProposalSelection, type AppBuildBriefEdits } from './AppBuildProposalPanel';
import { AppStudioLaunchSurface, AppStudioV2, type AppStudioLaunchConfig } from './AppStudioV2';
import { APP_STYLES } from './app-styles';
import { cleanStakeholderCopy, formatBusinessLabel, tidyTitle } from './app-text';
import { AiPinsPanel, DraftsPanel, EmptyPanel, NotebookListPanel, PanelCard, SettingsPanel, StatusSeal } from './AppSidePanels';
import { FollowPageButton } from './FollowPageButton';
import { AskAboutApp } from './AskAboutApp';
import { ResearchPanel } from './ResearchPanel';
import { formatVariableEntryValue, formatVariableValue } from './app-variables';
import type { AppAnalysisHandoff, AppResearchSeed, CreateInvestigationResult } from './app-research-types';
import {
  coerceDashboardFilterValue,
  DashboardFilterControls,
  DashboardFilterEditor,
  DashboardFilterPicker,
  defaultDashboardFilterValue,
  filterIconForDashboardFilter,
  shallowEqualRecords,
} from './app-dashboard-filters';
import { DashboardRenderer } from './DashboardRenderer';
import { PersonaSwitcher } from './PersonaSwitcher';
import {
  addDashboardFilterToDocument,
  applyViewerFilterChoice,
  dashboardFilterCandidates,
  dashboardFilterCoverage,
  defaultParameterFilterValue,
  deriveDashboardFilters,
  removeDashboardFilterFromDocument,
  viewerFilterPageVariables,
  viewerFilterReach,
  viewerFiltersForRun,
  type ViewerDashboardFilter,
} from './dashboard-filters';
import { semanticApprovalState } from './app-semantic-approval';
import { appCertificationRollup, appLifecycleLabel } from './app-certification';
import type { AppTrustSummary } from '@zlens/core/apps/reader-trust';
import { beginPersistedAppWorkspaceLoad, resolvePersistedWorkspaceMetadata, type WorkspaceDashboardSummary } from './app-workspace-loader';
import {
  isAppScopedDashboardFilter,
  readPersistedAppFilterValues,
  valuesForDashboardPage,
  writePersistedAppFilterValues,
} from './app-dashboard-filter-scope';
import { authoredDomainOptions, resolveAuthoredDomainId } from '../domains/authored-domain-options';
import { useOperations } from '../../operations/OperationsProvider';
import { appLibraryLaunchExpanded, type AppLibraryLaunchPreference } from './app-library-launch';

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));
const StructuredAnswerText = lazy(() => import('../agent/AgentAnswerCard')
  .then((module) => ({ default: module.StructuredAnswerText })));

type AppSurface = 'library' | 'create' | 'workspace';
type AppExperience = AppWorkspaceExperience;
type BuilderMode = 'ai' | 'classic';
type AppSection = AppWorkspaceSection;
type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type DashboardNavigationEntry = {
  dashboardId: string;
  draftValues: Record<string, unknown>;
  appliedValues: Record<string, unknown>;
};
type AppAskDecision = Extract<AppAskResponse, { ok: true }>['decision'];
type AppCopilotRoute = 'certified_answer' | 'dataset_chart_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
type AppCopilotBlockTile = { blockId: string; title: string; viz: string; tileId: string };


interface AppPromptExample {
  title: string;
  domain: string;
  prompt: string;
}

const DEFAULT_PROMPT = 'A weekly revenue dashboard: revenue by month, the top regions, and the latest orders.';
const ACTIVE_APP_BUILD_STORAGE_KEY = 'dql.apps.active-ai-build.v1';
const APP_DASHBOARD_FILTER_VALUES_STORAGE_PREFIX = 'dql.apps.dashboard-filter-values.v1:';

interface PersistedAppBuild {
  sessionId: string;
  operationId?: string;
  prompt: string;
  existingAppId?: string;
  createdAt: string;
}

function readPersistedAppBuild(): PersistedAppBuild | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_APP_BUILD_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedAppBuild>;
    return typeof value.sessionId === 'string' && typeof value.prompt === 'string' && typeof value.createdAt === 'string'
      ? value as PersistedAppBuild
      : null;
  } catch {
    return null;
  }
}

function persistAppBuild(value: PersistedAppBuild | null): void {
  try {
    if (value) window.localStorage.setItem(ACTIVE_APP_BUILD_STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(ACTIVE_APP_BUILD_STORAGE_KEY);
  } catch {
    // The server operation still completes when browser storage is unavailable.
  }
}

function createAppBuildSessionId(): string {
  const suffix = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `app_build_${Date.now()}_${suffix}`;
}

const APP_PROMPT_EXAMPLES: AppPromptExample[] = [
  {
    title: 'Revenue story',
    domain: 'Revenue',
    prompt: 'Build a weekly revenue health app for the COO with risk flags.',
  },
  {
    title: 'Customer 360',
    domain: 'Customer',
    prompt: 'Customer 360: value, engagement, retention, orders, and service risk by segment.',
  },
  {
    title: 'Quality monitor',
    domain: 'Platform',
    prompt: 'Build a data quality monitor with freshness, failing tests, null rates, and model risk notes.',
  },
  {
    title: 'Experiment Readout',
    domain: 'Product',
    prompt: 'Create an experiment readout for product leadership with outcome, guardrails, and decision checklist.',
  },
];

function normalizeAppTheme(themeMode: string): 'obsidian' | 'paper' | 'white' {
  if (themeMode === 'obsidian' || themeMode === 'dark' || themeMode === 'midnight') return 'obsidian';
  if (themeMode === 'white' || themeMode === 'arctic') return 'white';
  return 'paper';
}

export function AppsView(): JSX.Element {
  const state = useNotebookStore(useShallow((store) => ({
    activeAppExperience: store.activeAppExperience,
    activeAppId: store.activeAppId,
    activeAppDraftId: store.activeAppDraftId,
    activeAppSection: store.activeAppSection,
    activeDashboardId: store.activeDashboardId,
    apps: store.apps,
    appsLoading: store.appsLoading,
    authoredDomains: store.authoredDomains,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const { operations, track: trackOperation } = useOperations();
  const appTheme = useMemo(() => normalizeAppTheme(state.themeMode), [state.themeMode]);
  const [surface, setSurface] = useState<AppSurface>(() => state.activeAppDraftId ? 'create' : state.activeAppId ? 'workspace' : 'library');
  const experience = state.activeAppExperience;
  const section = state.activeAppSection;
  const setExperience = (nextExperience: AppExperience) => {
    dispatch({ type: 'SET_APP_WORKSPACE_STATE', experience: nextExperience });
  };
  const setSection = (nextSection: AppSection) => {
    dispatch({ type: 'SET_APP_WORKSPACE_STATE', section: nextSection });
  };
  const [search, setSearch] = useState('');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [appDoc, setAppDoc] = useState<AppDocumentSummary | null>(null);
  const [dashboardDoc, setDashboardDoc] = useState<DashboardDocumentResponse | null>(null);
  const [appLoading, setAppLoading] = useState(false);
  const [dashboardLoadError, setDashboardLoadError] = useState<string | null>(null);
  /** Set when the host refused this person the App (HH-12), with where to ask. */
  const [dashboardRefusal, setDashboardRefusal] = useState<{ next?: { label: string; href: string } } | null>(null);
  /** The project has no such App or page (404), as opposed to a page that could not be read. */
  const [dashboardMissing, setDashboardMissing] = useState(false);
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [builderMode, setBuilderMode] = useState<BuilderMode>('ai');
  const [builderExploreGaps, setBuilderExploreGaps] = useState(false);
  const [builderTemplate, setBuilderTemplate] = useState<AppStudioLaunchConfig['template']>('operational_dashboard');
  const [builderPrompt, setBuilderPrompt] = useState(DEFAULT_PROMPT);
  const [builderName, setBuilderName] = useState('');
  // Once the author types a name or audience, the planner stops overwriting it.
  const builderNameTouchedRef = useRef(false);
  const [builderDomain, setBuilderDomain] = useState('');
  const builderDomainOptions = useMemo(() => authoredDomainOptions(state.authoredDomains), [state.authoredDomains]);
  const [builderOwner, setBuilderOwner] = useState('analytics');
  const [builderAudience, setBuilderAudience] = useState('stakeholders');
  const builderAudienceTouchedRef = useRef(false);
  const [builderExistingAppId, setBuilderExistingAppId] = useState<string | null>(null);
  const [builderDraftId, setBuilderDraftId] = useState<string | null>(() => state.activeAppDraftId);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<string>>(() => new Set());
  const [generated, setGenerated] = useState<GenerateAppResponse | null>(null);
  const [buildSession, setBuildSession] = useState<AppAiBuildSession | null>(null);
  const initialPersistedBuildRef = useRef<PersistedAppBuild | null>(readPersistedAppBuild());
  const [durableBuildSessionId, setDurableBuildSessionId] = useState<string | null>(initialPersistedBuildRef.current?.sessionId ?? null);
  const [buildOperationId, setBuildOperationId] = useState<string | null>(initialPersistedBuildRef.current?.operationId ?? null);
  const loadedBuildSessionRef = useRef<string | null>(null);
  const [proposalSelection, setProposalSelection] = useState<Set<string>>(new Set());
  const [proposalFilterSelection, setProposalFilterSelection] = useState<Set<string>>(new Set());
  const [proposalEdits, setProposalEdits] = useState<Record<string, { title?: string; viz?: string }>>({});
  const [committing, setCommitting] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [addPageOpen, setAddPageOpen] = useState(false);
  const [addPageTitle, setAddPageTitle] = useState('');
  const [addPageExploreGaps, setAddPageExploreGaps] = useState(false);
  const [addPageError, setAddPageError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppSummary | null>(null);
  const [deletingApp, setDeletingApp] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteUndo, setDeleteUndo] = useState<{ appName: string; recoveryId: string } | null>(null);
  // Page-local filter values remain keyed by page.  App-owned filters have a
  // second, explicit store keyed by the App so a same-named page control never
  // leaks through navigation merely because it shares an id.
  const [dashboardFilterValuesByPage, setDashboardFilterValuesByPage] = useState<Record<string, Record<string, unknown>>>({});
  const [appliedDashboardFilterValuesByPage, setAppliedDashboardFilterValuesByPage] = useState<Record<string, Record<string, unknown>>>({});
  const [appScopedDashboardFilterValues, setAppScopedDashboardFilterValues] = useState<Record<string, unknown>>({});
  const [appliedAppScopedDashboardFilterValues, setAppliedAppScopedDashboardFilterValues] = useState<Record<string, unknown>>({});
  const [dashboardFilterPersistenceAppId, setDashboardFilterPersistenceAppId] = useState<string | null>(null);
  const [dashboardNavigationStack, setDashboardNavigationStack] = useState<DashboardNavigationEntry[]>([]);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainExpanded, setExplainExpanded] = useState(false);
  const handleExplainChange = useCallback((open: boolean) => {
    setExplainOpen(open);
    if (!open) setExplainExpanded(false);
  }, []);
  // A read-only page link reads one App: no library, drafts or personas.
  const readOnlyLink = isViewerLink();
  const appsQuery = useQuery({
    queryKey: ['apps'],
    queryFn: () => api.listAppsStrict(),
    staleTime: 30_000,
    enabled: !readOnlyLink,
  });
  const appBuildsQuery = useQuery({
    queryKey: ['app-builds'],
    queryFn: () => api.listAppBuilds(),
    staleTime: 10_000,
    enabled: !readOnlyLink,
  });
  const personaQuery = useQuery({
    queryKey: ['persona'],
    queryFn: () => api.getPersona(),
    staleTime: 60_000,
    enabled: !readOnlyLink,
  });

  useEffect(() => {
    dispatch({ type: 'SET_APPS_LOADING', loading: appsQuery.isLoading });
    if (appsQuery.data) dispatch({ type: 'SET_APPS', apps: appsQuery.data });
  }, [appsQuery.data, appsQuery.isLoading, dispatch]);

  useEffect(() => {
    if (personaQuery.data) dispatch({ type: 'SET_ACTIVE_PERSONA', persona: personaQuery.data });
  }, [dispatch, personaQuery.data]);

  // Ask AI can open an AppBuildDraft while AppsView is already mounted (for
  // example from the global App Copilot rail). React state initializers only
  // run on mount, so mirror the explicit store transition into the Studio
  // surface instead of leaving the user in the retired workspace.
  useEffect(() => {
    if (!state.activeAppDraftId) return;
    setBuilderDraftId(state.activeAppDraftId);
    setBuilderExistingAppId(null);
    setSurface('create');
  }, [state.activeAppDraftId]);

  const applyRecoveredBuildSession = useCallback((session: AppAiBuildSession) => {
    setBuildSession(session);
    setBuilderDraftId(null);
    setSurface('create');
    setBuilderMode('ai');
    setBuilderPrompt(session.prompt || DEFAULT_PROMPT);
    setBuilderExistingAppId(session.inputs.existingAppId ?? null);
    setBuilderDomain(resolveAuthoredDomainId(session.inputs.domain, state.authoredDomains));
    setBuilderOwner(session.inputs.owner ?? 'analytics');
    setBuilderAudience(session.inputs.audience ?? 'stakeholders');
    setBuilderExploreGaps(session.inputs.exploreGaps === true);
    if (session.status === 'building') {
      setBuilderSaving(true);
      return;
    }
    setBuilderSaving(false);
    if (session.status === 'error') {
      setBuilderError(session.error ?? 'The App proposal did not complete.');
      return;
    }
    setBuilderError(null);
    setProposalSelection(session.proposal ? defaultProposalSelection(session.proposal) : new Set());
    // This runs on every build-status transition, so seeding must not clobber
    // what the author has typed. Previously a name or tile title entered during
    // the build was silently reverted to the planner's own wording.
    setProposalEdits((current) => Object.fromEntries((session.proposal?.tiles ?? []).map((tile) => [
      tile.id,
      current[tile.id] ?? { title: tile.title, viz: tile.viz },
    ])));
    const plan = session.plan as GeneratedAppPlan | undefined;
    setProposalFilterSelection(new Set(plannedAppFilterIds(plan)));
    const planName = session.inputs.existingAppId ? plan?.pages[0]?.title : plan?.name;
    if (planName) setBuilderName((current) => (builderNameTouchedRef.current ? current : planName));
    if (plan?.audience) setBuilderAudience((current) => (builderAudienceTouchedRef.current ? current : plan.audience!));
  }, [state.authoredDomains]);

  const activeBuildOperation = useMemo(() => {
    if (!durableBuildSessionId) return null;
    return operations.find((operation) => operation.id === buildOperationId)
      ?? operations.find((operation) => operation.type === 'app_ai_build' && operation.scope === `app-build:${durableBuildSessionId}`)
      ?? null;
  }, [buildOperationId, durableBuildSessionId, operations]);

  useEffect(() => {
    const persisted = initialPersistedBuildRef.current;
    if (!persisted) return;
    initialPersistedBuildRef.current = null;
    setBuilderPrompt(persisted.prompt);
    setBuilderExistingAppId(persisted.existingAppId ?? null);
    setBuilderMode('ai');
    setBuilderSaving(true);
    setSurface('create');
  }, []);

  useEffect(() => {
    if (!durableBuildSessionId) return;
    if (activeBuildOperation?.id && activeBuildOperation.id !== buildOperationId) {
      setBuildOperationId(activeBuildOperation.id);
      const current = readPersistedAppBuild();
      if (current?.sessionId === durableBuildSessionId) persistAppBuild({ ...current, operationId: activeBuildOperation.id });
    }
    if (
      activeBuildOperation
      && (activeBuildOperation.status === 'queued' || activeBuildOperation.status === 'running')
      && (!buildSession || buildSession.status === 'building')
    ) {
      setBuilderSaving(true);
      setSurface('create');
    }

    let cancelled = false;
    let timer: number | undefined;
    const recover = async () => {
      const session = await api.getAppAiBuild(durableBuildSessionId);
      if (cancelled) return;
      if (!session || session.status === 'building') {
        if (session) applyRecoveredBuildSession(session);
        if (activeBuildOperation && ['failed', 'cancelled', 'interrupted'].includes(activeBuildOperation.status)) {
          setBuilderSaving(false);
          setBuilderError(activeBuildOperation.error?.message ?? (
            activeBuildOperation.status === 'cancelled'
              ? 'The App proposal was cancelled.'
              : 'The App proposal did not complete.'
          ));
          return;
        }
        timer = window.setTimeout(() => { void recover(); }, 900);
        return;
      }
      // The durable session is authoritative. A LAN client can retain an older
      // queued/running operation in the React Query cache after the proposal is
      // already written. Always clear the spinner before the duplicate-session
      // guard so that stale progress cannot hide a completed Build Brief.
      setBuilderSaving(false);
      if (loadedBuildSessionRef.current === session.id && buildSession?.status === session.status) return;
      loadedBuildSessionRef.current = session.id;
      applyRecoveredBuildSession(session);
    };
    void recover();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeBuildOperation, applyRecoveredBuildSession, buildOperationId, buildSession?.status, durableBuildSessionId]);

  useEffect(() => {
    if (!state.activeAppId || surface !== 'workspace') {
      setAppDoc(null);
      setDashboardDoc(null);
      setDashboardLoadError(null);
      setDashboardRefusal(null);
      setDashboardMissing(false);
      setAppLoading(false);
      return;
    }
    if (!state.activeDashboardId) {
      setDashboardDoc(null);
      setDashboardLoadError(null);
      setDashboardRefusal(null);
      setDashboardMissing(false);
      setAppLoading(false);
      return;
    }
    setAppLoading(true);
    setDashboardLoadError(null);
    setDashboardRefusal(null);
    setDashboardMissing(false);
    setDashboardDoc(null);
    setAppDoc((current) => current?.app.id === state.activeAppId ? current : null);
    return beginPersistedAppWorkspaceLoad({
      appId: state.activeAppId,
      dashboardId: state.activeDashboardId,
      loadApp: api.getApp,
      loadDashboard: (appId, dashboardId) => api.getDashboard(appId, dashboardId, { throwNotFound: true }),
      onApp: (document) => setAppDoc(document),
      onDashboard: (document) => {
        setDashboardDoc(document);
        setAppLoading(false);
      },
      onDashboardError: (message, refusal, problem) => {
        setDashboardDoc(null);
        setDashboardLoadError(message);
        setDashboardRefusal(refusal ?? null);
        setDashboardMissing(!!problem?.notFound);
        setAppLoading(false);
      },
    });
  }, [state.activeAppId, state.activeDashboardId, surface, workspaceLoadAttempt]);

  const retryWorkspaceLoad = useCallback(() => {
    setWorkspaceLoadAttempt((attempt) => attempt + 1);
  }, []);

  const dashboardFilterKey = useMemo(
    () => JSON.stringify(deriveDashboardFilters(dashboardDoc?.dashboard ?? null)),
    [dashboardDoc?.dashboard],
  );
  const dashboardFilters = useMemo(
    () => deriveDashboardFilters(dashboardDoc?.dashboard ?? null),
    [dashboardDoc?.dashboard, dashboardFilterKey],
  );

  const activeDashboardFilterPageId = dashboardDoc?.dashboard.id ?? null;
  const dashboardFilterValues = useMemo(
    () => activeDashboardFilterPageId ? dashboardFilterValuesByPage[activeDashboardFilterPageId] ?? {} : {},
    [activeDashboardFilterPageId, dashboardFilterValuesByPage],
  );
  const appliedDashboardFilterValues = useMemo(
    () => activeDashboardFilterPageId ? appliedDashboardFilterValuesByPage[activeDashboardFilterPageId] ?? {} : {},
    [activeDashboardFilterPageId, appliedDashboardFilterValuesByPage],
  );

  // An App-scoped control represents a reader's current business scope. Keep
  // it across an App reopen, but reapply it only where the persisted page
  // declares that same control as App-scoped. Values never become a saved
  // dashboard mutation or a source binding.
  useEffect(() => {
    const appId = state.activeAppId;
    setDashboardFilterValuesByPage({});
    setAppliedDashboardFilterValuesByPage({});
    if (!appId) {
      setAppScopedDashboardFilterValues({});
      setAppliedAppScopedDashboardFilterValues({});
      setDashboardFilterPersistenceAppId(null);
      return;
    }
    try {
      const persisted = readPersistedAppFilterValues(
        window.localStorage,
        `${APP_DASHBOARD_FILTER_VALUES_STORAGE_PREFIX}${appId}`,
      );
      setAppScopedDashboardFilterValues(persisted.draft);
      setAppliedAppScopedDashboardFilterValues(persisted.applied);
    } catch {
      setAppScopedDashboardFilterValues({});
      setAppliedAppScopedDashboardFilterValues({});
    }
    setDashboardFilterPersistenceAppId(appId);
  }, [state.activeAppId]);

  useEffect(() => {
    if (!state.activeAppId || dashboardFilterPersistenceAppId !== state.activeAppId) return;
    try {
      writePersistedAppFilterValues(
        window.localStorage,
        `${APP_DASHBOARD_FILTER_VALUES_STORAGE_PREFIX}${state.activeAppId}`,
        { draft: appScopedDashboardFilterValues, applied: appliedAppScopedDashboardFilterValues },
      );
    } catch {
      // Browser storage is not execution authority. The current App still
      // receives its in-memory scope when persistence is unavailable.
    }
  }, [appScopedDashboardFilterValues, appliedAppScopedDashboardFilterValues, dashboardFilterPersistenceAppId, state.activeAppId]);

  useEffect(() => {
    if (!activeDashboardFilterPageId) return;
    setDashboardFilterValuesByPage((current) => {
      const pageValues = valuesForDashboardPage({
        filters: dashboardFilters,
        pageValues: current[activeDashboardFilterPageId] ?? {},
        appValues: appScopedDashboardFilterValues,
        defaultValue: defaultDashboardFilterValue,
      });
      if (shallowEqualRecords(current[activeDashboardFilterPageId] ?? {}, pageValues)) return current;
      return { ...current, [activeDashboardFilterPageId]: pageValues };
    });
    setAppliedDashboardFilterValuesByPage((current) => {
      const pageValues = valuesForDashboardPage({
        filters: dashboardFilters,
        pageValues: current[activeDashboardFilterPageId] ?? {},
        appValues: appliedAppScopedDashboardFilterValues,
        defaultValue: defaultDashboardFilterValue,
      });
      if (shallowEqualRecords(current[activeDashboardFilterPageId] ?? {}, pageValues)) return current;
      return { ...current, [activeDashboardFilterPageId]: pageValues };
    });
  }, [activeDashboardFilterPageId, appScopedDashboardFilterValues, appliedAppScopedDashboardFilterValues, dashboardFilterKey, dashboardFilters]);

  /**
   * Dataset detail navigation carries only explicitly named filters that the
   * destination page declares. Mark selections deliberately stay on their
   * source page: they are source/revision-scoped result interactions, not a
   * global field-name convention.
   */
  const navigateDashboard = useCallback(async (input: {
    fromDashboardId: string;
    toDashboardId: string;
    carryFilterIds: string[];
    variables: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }> => {
    if (!state.activeAppId || state.activeDashboardId !== input.fromDashboardId) {
      return { ok: false, error: 'The source page changed before its detail navigation could be opened.' };
    }
    if (input.toDashboardId === input.fromDashboardId) {
      return { ok: false, error: 'A detail navigation must target a different page.' };
    }
    const target = await api.getDashboard(state.activeAppId, input.toDashboardId);
    if (!target?.dashboard) return { ok: false, error: 'The configured detail page is unavailable.' };
    const targetFilterIds = new Set((target.dashboard.filters ?? []).map((filter) => filter.id));
    const carried = Object.fromEntries(input.carryFilterIds
      .filter((filterId) => targetFilterIds.has(filterId) && input.variables[filterId] !== undefined)
      .map((filterId) => [filterId, input.variables[filterId]]));
    setDashboardNavigationStack((current) => [...current, {
      dashboardId: input.fromDashboardId,
      draftValues: { ...dashboardFilterValues },
      appliedValues: { ...appliedDashboardFilterValues },
    }]);
    setDashboardFilterValuesByPage((current) => ({ ...current, [input.toDashboardId]: carried }));
    setAppliedDashboardFilterValuesByPage((current) => ({ ...current, [input.toDashboardId]: carried }));
    // An App-scoped control has one value across pages, and that value wins
    // when a page hydrates. A carried App-scoped value is therefore the new
    // App value; otherwise the destination would silently drop it.
    const carriedAppScoped = Object.fromEntries(Object.entries(carried).filter(([filterId]) => (
      isAppScopedDashboardFilter(target.dashboard.filters?.find((filter) => filter.id === filterId))
    )));
    if (Object.keys(carriedAppScoped).length) {
      setAppScopedDashboardFilterValues((current) => ({ ...current, ...carriedAppScoped }));
      setAppliedAppScopedDashboardFilterValues((current) => ({ ...current, ...carriedAppScoped }));
    }
    dispatch({ type: 'OPEN_DASHBOARD', dashboardId: input.toDashboardId });
    return { ok: true };
  }, [appliedDashboardFilterValues, dashboardFilterValues, dispatch, state.activeAppId, state.activeDashboardId]);

  const navigateDashboardBack = useCallback(() => {
    const previous = dashboardNavigationStack.at(-1);
    if (!previous) return;
    setDashboardNavigationStack((current) => current.slice(0, -1));
    setDashboardFilterValuesByPage((current) => ({ ...current, [previous.dashboardId]: previous.draftValues }));
    setAppliedDashboardFilterValuesByPage((current) => ({ ...current, [previous.dashboardId]: previous.appliedValues }));
    dispatch({ type: 'OPEN_DASHBOARD', dashboardId: previous.dashboardId });
  }, [dashboardNavigationStack, dispatch]);

  useEffect(() => {
    setDashboardNavigationStack([]);
  }, [state.activeAppId]);

  const refreshApps = async (
    openAppId?: string | null,
    dashboardId?: string | null,
    nextSurface?: AppSurface,
    workspaceState?: { experience?: AppExperience; section?: AppSection },
  ) => {
    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    const apps = await api.listApps();
    dispatch({ type: 'SET_APPS', apps });
    dispatch({ type: 'SET_APPS_LOADING', loading: false });
    if (openAppId) dispatch({ type: 'OPEN_APP', appId: openAppId, dashboardId, ...workspaceState });
    if (nextSurface) setSurface(nextSurface);
  };

  const localDrafts = (appBuildsQuery.data?.drafts ?? [])
    .filter((draft) => draft.state !== 'project_published');
  const appLibraryLoading = state.appsLoading || appsQuery.isLoading || appBuildsQuery.isLoading;
  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.apps.filter((app) => {
      if (libraryFilter === 'drafts') return false;
      if (libraryFilter === 'private' && isSharedProjectApp(app)) return false;
      if (libraryFilter === 'shared' && !isSharedProjectApp(app)) return false;
      if (libraryFilter === 'fav' && !favorites.has(app.id)) return false;
      if (!needle) return true;
      const haystack = [
        app.name,
        app.description ?? '',
        app.domain,
        app.audience ?? '',
        app.lifecycle ?? '',
        ...(app.tags ?? []),
        ...(app.owners ?? []),
        ...app.dashboards.map((dashboard) => dashboard.title),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [favorites, libraryFilter, search, state.apps]);

  const activeApp = useMemo(
    () => state.apps.find((app) => app.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  );
  // A persisted dashboard has its own server-resolved App identity. That is
  // sufficient for a read-only canvas if the broader App metadata endpoint is
  // delayed, while a matching library summary remains necessary for writes.
  const workspaceMetadata = useMemo(
    () => resolvePersistedWorkspaceMetadata({
      dashboard: dashboardDoc,
      appDocument: appDoc,
      libraryApp: activeApp,
    }),
    [activeApp, appDoc, dashboardDoc],
  );
  const handleInvestigationsChanged = useCallback((investigations: LocalAppInvestigation[]) => {
    setAppDoc((current) => {
      if (!current) return current;
      return {
        ...current,
        investigations,
      };
    });
  }, []);

  const openApp = (app: AppSummary, nextExperience: AppExperience = 'view') => {
    if (nextExperience === 'build') {
      setBuilderExistingAppId(app.id);
      setBuilderDraftId(null);
      setBuilderMode('classic');
      setBuilderTemplate('blank');
      setBuilderName(app.name);
      setBuilderPrompt(app.description ?? `Improve ${app.name} for ${app.audience ?? 'stakeholders'}.`);
      setBuilderDomain(resolveAuthoredDomainId(app.domain, state.authoredDomains));
      setBuilderAudience(app.audience ?? 'stakeholders');
      setBuilderError(null);
      setSurface('create');
      return;
    }
    dispatch({ type: 'OPEN_APP', appId: app.id, experience: nextExperience, section: 'dashboards' });
    setSurface('workspace');
  };

  const startStudioBuilder = (config: AppStudioLaunchConfig) => {
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    setBuilderExistingAppId(null);
    setBuilderDraftId(null);
    setBuilderMode(config.mode === 'ai' ? 'ai' : 'classic');
    setBuilderExploreGaps(config.sourcePolicy === 'include_review_required');
    setBuilderTemplate(config.template);
    setBuilderPrompt(config.mode === 'ai' ? config.prompt : 'A dashboard of live, checked numbers');
    setBuilderName(config.mode === 'manual' ? config.name : '');
    // A new App starts in no domain. Never inherit the domain of the App
    // opened for editing last; it would silently scope AI and the catalog.
    setBuilderDomain('');
    setBuilderAudience('stakeholders');
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setProposalEdits({});
    setProposalFilterSelection(new Set());
    setSurface('create');
  };

  const toggleSelectedBlock = (blockId: string) => {
    setSelectedBlocks((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  const runGenerate = async (options?: { extraBlockIds?: string[]; prompt?: string }) => {
    const extras = (options?.extraBlockIds ?? []).filter((id) => typeof id === 'string');
    const prompt = (options?.prompt ?? builderPrompt).trim();
    if (!prompt) {
      setBuilderError('Describe the app you want to build.');
      return;
    }
    setBuilderSaving(true);
    setBuilderError(null);
    const preferredBlockIds = builderMode === 'classic'
      ? Array.from(selectedBlocks)
      : Array.from(new Set([
          ...Array.from(selectedBlocks),
          ...extras,
        ]));
    // Two-phase build: propose first (no files) — the user reviews the content
    // list with per-tile toggles and confirms before anything is created. The
    // client owns the session id before the request starts, so route changes can
    // reconnect even during the server-acceptance window.
    const sessionId = createAppBuildSessionId();
    const persisted: PersistedAppBuild = {
      sessionId,
      prompt,
      ...(builderExistingAppId ? { existingAppId: builderExistingAppId } : {}),
      createdAt: new Date().toISOString(),
    };
    persistAppBuild(persisted);
    setDurableBuildSessionId(sessionId);
    setBuildOperationId(null);
    loadedBuildSessionRef.current = null;
    setBuildSession(null);
    setGenerated(null);
    try {
      const accepted = await api.proposeAppAiBuildInBackground({
        sessionId,
        prompt,
        existingAppId: builderExistingAppId ?? undefined,
        domain: builderDomain.trim() || undefined,
        owner: builderOwner.trim() || undefined,
        force: false,
        selectedBlockIds: preferredBlockIds,
        plannerMode: 'ai_assisted',
        mode: 'personal',
        exploreGaps: builderExploreGaps,
      });
      trackOperation(accepted.operation);
      setBuildOperationId(accepted.operation.id);
      persistAppBuild({ ...persisted, operationId: accepted.operation.id });
      // Do not wait solely on the global EventSource. Remote/LAN EventSource
      // cannot send the server bearer token, so its queued frame can remain in
      // memory even after the operation has completed. Poll the durable build
      // artifact directly; reload recovery remains a second safety net.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const session = await api.getAppAiBuild(sessionId);
        if (session && session.status !== 'building') {
          loadedBuildSessionRef.current = session.id;
          applyRecoveredBuildSession(session);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      setBuilderSaving(false);
      setBuilderError('The proposal is still running. You can retry now; ZLens will also recover the completed Build Brief when you return to Apps.');
    } catch (error) {
      setBuilderSaving(false);
      setBuilderError(error instanceof Error ? error.message : String(error));
      persistAppBuild(null);
      setDurableBuildSessionId(null);
      setBuildOperationId(null);
    }
  };

  // "Add more blocks" in the proposal: adding a certified catalog block
  // re-proposes the build with that block pinned, so the new tile arrives
  // through the same governed propose flow (no client-side tile fabrication).
  const addBlockToProposal = (blockId: string) => {
    setSelectedBlocks((current) => {
      const next = new Set(current);
      next.add(blockId);
      return next;
    });
    void runGenerate({ extraBlockIds: [blockId] });
  };

  const applyClarificationChoice = (question: string, choice: string) => {
    const nextPrompt = `${builderPrompt.trim()}\n${question} ${choice}`;
    setBuilderPrompt(nextPrompt);
    void runGenerate({ prompt: nextPrompt });
  };

  const toggleProposalTile = (tileId: string) => {
    setProposalSelection((current) => {
      const next = new Set(current);
      if (next.has(tileId)) next.delete(tileId);
      else next.add(tileId);
      return next;
    });
  };

  /**
   * Rename the App, or the page currently open inside it.
   *
   * Renaming had no writer at all after creation: `dql.app.json` was written
   * only by create and publish, and the dashboard layout PATCH cannot reach
   * `metadata.title`.
   */
  const runRenameApp = async (name: string, dashboardId?: string) => {
    const appId = state.activeAppId;
    if (!appId || !name.trim()) return;
    const result = await api.renameApp(appId, dashboardId ? { pageTitle: name.trim(), dashboardId } : { name: name.trim() });
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    await refreshApps(appId, dashboardId ?? state.activeDashboardId ?? undefined, 'workspace');
  };

  const runCommitProposal = async (edits?: AppBuildBriefEdits) => {
    if (!buildSession || buildSession.status !== 'proposed') return;
    setCommitting(true);
    setBuilderError(null);
    // Edits made in the shared Build Brief win over the surface's own fields:
    // they are the ones the author was looking at when they pressed Build.
    const name = (edits?.appName ?? edits?.pageTitle ?? builderName).trim();
    const result = await api.commitAppAiBuild(buildSession.id, {
      selectedTileIds: Array.from(proposalSelection),
      expectedProposalHash: buildSession.proposalHash,
      ...(builderExistingAppId
        ? { pageTitle: name || undefined }
        : { appName: name || undefined }),
      audience: (edits?.audience ?? builderAudience).trim() || undefined,
      filterIds: Array.from(proposalFilterSelection),
      tileOverrides: { ...proposalEdits, ...(edits?.tileOverrides ?? {}) },
    });
    setCommitting(false);
    if (!result.ok) {
      setBuilderError(result.error);
      return;
    }
    const session = result.session;
    setBuildSession(session);
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    const response: GenerateAppResponse = {
      ok: true,
      plan: session.plan as GeneratedAppPlan,
      validation: session.validation as GenerateAppResponse['validation'],
      generated: { paths: session.generatedPaths },
      app: result.app,
      dashboardId: result.dashboardId,
    };
    setGenerated(response);
    setExplainOpen(true);
    // You just authored this App, so land in the mode where you can adjust it.
    // Landing in read-only `view` hid the toolbar, the save status, and every
    // tile's edit chrome, which read as "there is no way to edit or save".
    await refreshApps(result.app?.id ?? response.plan.appId, result.dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
  };

  const runClassicCreate = async () => {
    const selected = catalog.filter((block) => selectedBlocks.has(block.id));
    const resolvedName = builderName.trim() || 'Untitled Analytics App';
    const resolvedDomain = builderDomain.trim() || selected[0]?.domain || builderDomainOptions[0]?.value || 'general';
    setBuilderName(resolvedName);
    setBuilderDomain(resolvedDomain);
    setBuilderSaving(true);
    setBuilderError(null);
    try {
      const result = await api.createApp({
        name: resolvedName,
        domain: resolvedDomain,
        dashboardTitle: 'Overview',
        purpose: builderPrompt.trim(),
        audience: builderAudience.trim() || 'stakeholders',
        visibility: 'private',
        lifecycle: 'draft',
        tags: ['app-builder', resolvedDomain.toLowerCase()],
        owners: [builderOwner.trim() || 'owner@local'],
        selectedBlockIds: Array.from(selectedBlocks),
      });
      await refreshApps(result.app.id, result.dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilderSaving(false);
    }
  };

  const openGeneratedWorkspace = () => {
    const appId = generated?.app?.id ?? generated?.plan.appId;
    if (!appId) return;
    dispatch({ type: 'OPEN_APP', appId, dashboardId: generated?.dashboardId ?? undefined, experience: 'build', section: 'dashboards' });
    setSurface('workspace');
  };

  const startDashboardPageBuilder = () => {
    if (!state.activeAppId || !appDoc) return;
    const request = addPageTitle.trim();
    if (!request) {
      setAddPageError('Describe the business question this page should answer.');
      return;
    }
    setAddPageError(null);
    persistAppBuild(null);
    setDurableBuildSessionId(null);
    setBuildOperationId(null);
    setBuilderExistingAppId(state.activeAppId);
    setBuilderDraftId(null);
    setBuilderMode('ai');
    setBuilderPrompt(request);
    setBuilderName('New App page');
    setBuilderDomain(resolveAuthoredDomainId(appDoc.app.domain, state.authoredDomains));
    setBuilderOwner(appDoc.app.owners[0] ?? 'analytics');
    setBuilderAudience(appDoc.app.audience ?? 'stakeholders');
    const localDraft = appDoc.app.publicationIntent === 'personal'
      || (!appDoc.app.publicationIntent && appDoc.app.visibility === 'private');
    setBuilderExploreGaps(localDraft && addPageExploreGaps);
    setSelectedBlocks(new Set());
    setBuilderError(null);
    setGenerated(null);
    setBuildSession(null);
    setProposalEdits({});
    setAddPageOpen(false);
    setAddPageTitle('');
    setAddPageExploreGaps(false);
    setSurface('create');
  };

  const dashboardVariables = useMemo(() => ({ ...appliedDashboardFilterValues }), [appliedDashboardFilterValues]);

  const handleDashboardFilterChange = useCallback((filter: DashboardFilter, value: unknown) => {
    if (!activeDashboardFilterPageId) return;
    const nextValue = coerceDashboardFilterValue(filter, value);
    setDashboardFilterValuesByPage((current) => ({
      ...current,
      [activeDashboardFilterPageId]: {
        ...(current[activeDashboardFilterPageId] ?? {}),
        [filter.id]: nextValue,
      },
    }));
    if (isAppScopedDashboardFilter(filter)) {
      setAppScopedDashboardFilterValues((current) => ({ ...current, [filter.id]: nextValue }));
    }
  }, [activeDashboardFilterPageId]);
  const applyDashboardFilters = useCallback(() => {
    if (!activeDashboardFilterPageId) return;
    setAppliedDashboardFilterValuesByPage((current) => ({
      ...current,
      [activeDashboardFilterPageId]: { ...dashboardFilterValues },
    }));
    setAppliedAppScopedDashboardFilterValues((current) => ({
      ...current,
      ...Object.fromEntries(dashboardFilters
        .filter(isAppScopedDashboardFilter)
        .map((filter) => [filter.id, dashboardFilterValues[filter.id]])),
    }));
  }, [activeDashboardFilterPageId, dashboardFilterValues, dashboardFilters]);
  const resetDashboardFilters = useCallback(() => {
    const defaults = Object.fromEntries(dashboardFilters.map((filter) => [filter.id, defaultDashboardFilterValue(filter)]));
    if (!activeDashboardFilterPageId) return;
    setDashboardFilterValuesByPage((current) => ({ ...current, [activeDashboardFilterPageId]: defaults }));
    setAppliedDashboardFilterValuesByPage((current) => ({ ...current, [activeDashboardFilterPageId]: defaults }));
    const appDefaults = Object.fromEntries(dashboardFilters
      .filter(isAppScopedDashboardFilter)
      .map((filter) => [filter.id, defaults[filter.id]]));
    if (Object.keys(appDefaults).length > 0) {
      setAppScopedDashboardFilterValues((current) => ({ ...current, ...appDefaults }));
      setAppliedAppScopedDashboardFilterValues((current) => ({ ...current, ...appDefaults }));
    }
  }, [activeDashboardFilterPageId, dashboardFilters]);
  // Filters apply as the reader changes them. A short pause folds a burst of
  // changes (several chips, or typing) into one page refresh.
  const dashboardFiltersPending = useMemo(() => dashboardFilters.some((filter) => (
    JSON.stringify(dashboardFilterValues[filter.id] ?? null) !== JSON.stringify(appliedDashboardFilterValues[filter.id] ?? null)
  )), [appliedDashboardFilterValues, dashboardFilterValues, dashboardFilters]);
  useEffect(() => {
    if (!dashboardFiltersPending) return;
    const timer = window.setTimeout(applyDashboardFilters, 450);
    return () => window.clearTimeout(timer);
  }, [applyDashboardFilters, dashboardFiltersPending]);

  const confirmDeleteApp = async () => {
    if (!deleteTarget || deletingApp) return;
    setDeletingApp(true);
    setDeleteError(null);
    try {
      const deleted = await api.deleteApp(deleteTarget.id, deleteTarget.fingerprint);
      setFavorites((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.id);
        return next;
      });
      dispatch({ type: 'SET_APPS', apps: state.apps.filter((app) => app.id !== deleteTarget.id) });
      if (state.activeAppId === deleteTarget.id) dispatch({ type: 'CLOSE_APP' });
      setDeleteTarget(null);
      setSurface('library');
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      setDeleteUndo({ appName: deleteTarget.name, recoveryId: deleted.recoveryId });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingApp(false);
    }
  };

  const restoreDeletedApp = async () => {
    if (!deleteUndo) return;
    const recovery = deleteUndo;
    setDeleteUndo(null);
    try {
      await api.restoreApp(recovery.recoveryId);
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      await queryClient.invalidateQueries({ queryKey: ['app-builds'] });
      await refreshApps();
    } catch (error) {
      setBuilderError(error instanceof Error ? error.message : String(error));
    }
  };

  const returnToAppLibrary = useCallback(() => {
    dispatch({ type: 'CLOSE_APP' });
    setAppDoc(null);
    setDashboardDoc(null);
    setBuilderExistingAppId(null);
    setBuilderDraftId(null);
    setSurface('library');
  }, [dispatch]);

  return (
    <div className={`dql-apps-waterline dql-apps-theme-${appTheme}`}>
      <style>{APP_STYLES}</style>
      {surface === 'library' ? (
        <AppLibrarySurface
          apps={filteredApps}
          allApps={state.apps}
          loading={appLibraryLoading}
          search={search}
          filter={libraryFilter}
          favorites={favorites}
          localDrafts={localDrafts}
          onSearch={setSearch}
          onFilter={setLibraryFilter}
          onToggleFavorite={(appId) => {
            setFavorites((current) => {
              const next = new Set(current);
              if (next.has(appId)) next.delete(appId);
              else next.add(appId);
              return next;
            });
          }}
          onStartStudio={startStudioBuilder}
          onContinueDraft={(draft) => {
            setBuilderDraftId(draft.id);
            setBuilderExistingAppId(draft.baseApp?.appId ?? null);
            setBuilderMode(draft.authoringMode === 'ai' ? 'ai' : 'classic');
            setBuilderTemplate(draft.template);
            setBuilderExploreGaps(draft.sourcePolicy === 'include_review_required');
            setBuilderPrompt(draft.frame.goal);
            setBuilderName(draft.name);
            setBuilderDomain(draft.pages[0]?.metadata.domain ?? '');
            setBuilderAudience(draft.frame.audience ?? 'stakeholders');
            setSurface('create');
          }}
          onOpenApp={openApp}
          onDeleteApp={(app) => {
            setDeleteError(null);
            setDeleteTarget(app);
          }}
        />
      ) : surface === 'create' ? (
        <AppStudioV2
          initialMode={builderMode === 'ai' ? 'ai' : 'manual'}
          initialPrompt={builderPrompt}
          initialName={builderName}
          initialDraftId={builderDraftId}
          initialSourcePolicy={builderExploreGaps ? 'include_review_required' : 'governed_only'}
          initialTemplate={builderTemplate}
          startImmediately
          baseAppId={builderExistingAppId}
          domain={builderDomain}
          audience={builderAudience}
          themeMode={state.themeMode}
          onBack={returnToAppLibrary}
          onPublished={(app, dashboardId) => {
            void queryClient.invalidateQueries({ queryKey: ['app-builds'] });
            void refreshApps(app.id, dashboardId, 'workspace', { experience: 'view', section: 'dashboards' });
          }}
          onDraftDeleted={(recovery) => {
            setDeleteUndo(recovery);
            setSurface('library');
            void queryClient.invalidateQueries({ queryKey: ['app-builds'] });
          }}
        />
      ) : (
        <AppWorkspaceSurface
          app={workspaceMetadata.writableLibraryApp}
          metadataApp={workspaceMetadata.app}
          dashboardPages={workspaceMetadata.dashboards}
          appDoc={appDoc}
          dashboardDoc={dashboardDoc}
          loading={appLoading}
          dashboardLoadError={dashboardLoadError}
          dashboardRefusal={dashboardRefusal}
          dashboardMissing={dashboardMissing}
          experience={experience}
          section={section}
          explainOpen={explainOpen}
          explainExpanded={explainExpanded}
          dashboardFilters={dashboardFilters}
          dashboardFilterValues={dashboardFilterValues}
          themeMode={state.themeMode}
          variables={dashboardVariables}
          onBack={returnToAppLibrary}
          onRetryDashboardLoad={retryWorkspaceLoad}
          onExperienceChange={(nextExperience) => {
            if (nextExperience === 'build') {
              if (workspaceMetadata.writableLibraryApp) openApp(workspaceMetadata.writableLibraryApp, 'build');
              return;
            }
            setExperience(nextExperience);
          }}
          onSectionChange={setSection}
          onDashboardFilterChange={handleDashboardFilterChange}
          onApplyDashboardFilters={applyDashboardFilters}
          onResetDashboardFilters={resetDashboardFilters}
          onExplainChange={handleExplainChange}
          onExplainExpandedChange={setExplainExpanded}
          onAddPage={() => {
            if (!workspaceMetadata.writableLibraryApp) return;
            setAddPageExploreGaps(false);
            setAddPageOpen(true);
          }}
          onOpenDashboard={(dashboardId) => {
            setDashboardNavigationStack([]);
            dispatch({ type: 'OPEN_DASHBOARD', dashboardId });
          }}
          onNavigateDashboard={navigateDashboard}
          navigationCanGoBack={dashboardNavigationStack.length > 0}
          onNavigationBack={navigateDashboardBack}
          onOpenApp={(appId, dashboardId, draftId) => {
            if (draftId) {
              setBuilderDraftId(draftId);
              setBuilderExistingAppId(null);
              dispatch({ type: 'OPEN_APP_DRAFT', draftId, appId, dashboardId });
              setSurface('create');
              return;
            }
            // Opening from "added to App" must show what was just added; a
            // review-required pin is filtered out of the read-only view.
            void refreshApps(appId, dashboardId, 'workspace', { experience: 'build', section: 'dashboards' });
          }}
          onRenameApp={(next, dashboardId) => void runRenameApp(next, dashboardId)}
          onDashboardChanged={(dashboard) => {
            setDashboardDoc((current) => current ? { ...current, dashboard } : current);
            void refreshApps(state.activeAppId, dashboard.id, 'workspace');
          }}
          onInvestigationsChanged={handleInvestigationsChanged}
          onOpenLineageNode={(nodeId) => {
            dispatch({
              type: 'OPEN_LINEAGE_DETAIL',
              nodeId,
              returnTo: state.activeAppId
                ? {
                    view: 'apps',
                    appId: state.activeAppId,
                    dashboardId: state.activeDashboardId,
                    label: activeApp?.name,
                    experience,
                    section,
                  }
                : null,
            });
          }}
        />
      )}
      {addPageOpen && (
        <AddPageDialog
          title={addPageTitle}
          allowExploration={appDoc?.app.publicationIntent === 'personal'
            || (!appDoc?.app.publicationIntent && appDoc?.app.visibility === 'private')}
          exploreGaps={addPageExploreGaps}
          error={addPageError}
          onChange={setAddPageTitle}
          onExploreGapsChange={setAddPageExploreGaps}
          onCancel={() => {
            setAddPageOpen(false);
            setAddPageExploreGaps(false);
            setAddPageError(null);
          }}
          onCreate={startDashboardPageBuilder}
        />
      )}
      {deleteTarget && (
        <DeleteAppDialog
          app={deleteTarget}
          deleting={deletingApp}
          error={deleteError}
          onCancel={() => {
            if (deletingApp) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={() => void confirmDeleteApp()}
        />
      )}
      {deleteUndo ? (
        <div className="dql-app-delete-undo" role="status">
          <span><strong>{deleteUndo.appName}</strong> moved to local recovery.</span>
          <button type="button" onClick={() => void restoreDeletedApp()}>Undo</button>
          <button type="button" aria-label="Dismiss delete recovery message" onClick={() => setDeleteUndo(null)}>×</button>
        </div>
      ) : null}
    </div>
  );
}

function AppLibrarySurface({
  apps,
  allApps,
  loading,
  search,
  filter,
  favorites,
  localDrafts,
  onSearch,
  onFilter,
  onToggleFavorite,
  onStartStudio,
  onContinueDraft,
  onOpenApp,
  onDeleteApp,
}: {
  apps: AppSummary[];
  allApps: AppSummary[];
  loading: boolean;
  search: string;
  filter: LibraryFilter;
  favorites: Set<string>;
  localDrafts: AppStudioBuildDraft[];
  onSearch: (value: string) => void;
  onFilter: (value: LibraryFilter) => void;
  onToggleFavorite: (appId: string) => void;
  onStartStudio: (config: AppStudioLaunchConfig) => void;
  onContinueDraft: (draft: AppStudioBuildDraft) => void;
  onOpenApp: (app: AppSummary, experience?: AppExperience) => void;
  onDeleteApp: (app: AppSummary) => void;
}) {
  const counts = libraryCounts(allApps, localDrafts, favorites);
  const [launchConfig, setLaunchConfig] = useState<AppStudioLaunchConfig>({
    mode: 'ai',
    prompt: DEFAULT_PROMPT,
    name: 'Untitled Analytics App',
    template: 'operational_dashboard',
    sourcePolicy: 'governed_only',
  });
  const [launchPreference, setLaunchPreference] = useState<AppLibraryLaunchPreference>('auto');
  const launchExpanded = appLibraryLaunchExpanded({
    preference: launchPreference,
    loading,
    appCount: allApps.length,
    localDraftCount: localDrafts.length,
  });
  const needle = search.trim().toLowerCase();
  const visibleDrafts = filter === 'all' || filter === 'drafts'
    ? localDrafts.filter((draft) => !needle || [
      draft.name,
      draft.frame.goal,
      draft.frame.audience ?? '',
      draft.pages[0]?.metadata.domain ?? '',
      draft.authoringMode,
    ].join(' ').toLowerCase().includes(needle))
    : [];
  const hasResults = visibleDrafts.length > 0 || apps.length > 0;
  // Under a host (RFC 0010 HH-9), people who may not author Apps read them.
  const hostUi = useHostUi();
  const canAuthor = hostAllows(hostUi, 'app.author');
  const reader = hostReader(hostUi);
  const words = appLibraryWords(reader);
  return (
    <main className="dql-apps-wrap">
      <div id="app-studio-launcher" hidden={!launchExpanded || !canAuthor}>
        {launchExpanded && canAuthor ? (
          <AppStudioLaunchSurface
            config={launchConfig}
            onChange={(patch) => setLaunchConfig((current) => ({ ...current, ...patch }))}
            onSubmit={() => onStartStudio(launchConfig)}
          />
        ) : null}
      </div>

      <section className="dql-apps-library-head" aria-labelledby="app-library-title">
        <div>
          <span className="dql-app-eyebrow">Your workspace</span>
          <h2 id="app-library-title">Apps</h2>
          <p>{words.intro}</p>
        </div>
        <div className="dql-apps-library-summary" aria-label="App library summary">
          {canAuthor ? (
            <button
              type="button"
              className="dql-app-card-act primary"
              aria-controls="app-studio-launcher"
              aria-expanded={launchExpanded}
              onClick={() => setLaunchPreference(launchExpanded ? 'collapsed' : 'expanded')}
            >
              {launchExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
              {launchExpanded ? 'Hide new App form' : 'Build new App'}
            </button>
          ) : null}
          {words.localCounts ? (
            <>
              <span><strong>{localDrafts.length}</strong> local draft{localDrafts.length === 1 ? '' : 's'}</span>
              <span><strong>{counts.private}</strong> private</span>
              <span><strong>{counts.shared}</strong> shared</span>
            </>
          ) : <span><strong>{counts.shared}</strong> shared App{counts.shared === 1 ? '' : 's'}</span>}
        </div>
      </section>

      <div className="dql-apps-libbar">
        <div className="dql-apps-filter-tabs">
          {words.filters.map((value) => (
            <button key={value} className={filter === value ? 'on' : ''} onClick={() => onFilter(value)}>
              {words.label(value)} <span>{counts[value]}</span>
            </button>
          ))}
        </div>
        <label className="dql-apps-search">
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search apps, domains, owners..." />
        </label>
      </div>

      {loading && allApps.length === 0 && localDrafts.length === 0 ? (
        <EmptyPanel title="Loading Apps..." detail={words.loadingDetail} />
      ) : !hasResults ? (
        <EmptyPanel title="No Apps match this view." detail={words.emptyDetail} />
      ) : (
        <div className="dql-apps-grid" aria-label="App library">
          {visibleDrafts.map((draft) => (
            <AppDraftCard key={draft.id} draft={draft} onOpen={() => onContinueDraft(draft)} />
          ))}
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              favorite={favorites.has(app.id)}
              onToggleFavorite={() => onToggleFavorite(app.id)}
              onOpen={() => onOpenApp(app, 'view')}
              onEdit={canAuthor ? () => onOpenApp(app, 'build') : undefined}
              onDelete={canAuthor ? () => onDeleteApp(app) : undefined}
              reader={reader}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function AppDraftCard({ draft, onOpen }: { draft: AppStudioBuildDraft; onOpen: () => void }) {
  const needsReview = draft.reviewTasks.some((task) => task.status === 'open');
  const domain = draft.pages[0]?.metadata.domain || 'Local workspace';
  return (
    <article className="dql-app-card dql-app-draft-card">
      <div className="dql-app-card-body" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(); }}>
        <div className="dql-app-card-top">
          <div className="dql-app-card-labels"><span className="dql-app-eyebrow">{domain}</span><span className="dql-app-visibility private"><ShieldCheck size={12} /> Private draft</span></div>
          <span className="dql-app-draft-mark"><LayoutDashboard size={15} /></span>
        </div>
        <StatusSeal tone={needsReview ? 'draft' : 'agentic'}>{needsReview ? 'needs review' : 'local draft'}</StatusSeal>
        <h3>{draft.name}</h3>
        <p>{cleanStakeholderCopy(draft.frame.goal || 'A private App draft ready to shape in Studio.')}</p>
        <div className="dql-app-card-mini">
          <MiniMetric label="Pages" value={String(draft.pages.length)} />
          <MiniMetric label="Mode" value={draft.authoringMode === 'ai' ? 'AI + manual' : 'Manual'} />
          <MiniMetric label="Revision" value={String(draft.revision)} />
        </div>
        <div className="dql-app-card-signals">
          <span><ShieldCheck size={13} /> Not in Project source</span>
          <span><Sparkles size={13} /> {draft.sourcePolicy === 'include_review_required' ? 'Also allows data that needs review' : 'Only certified data'}</span>
        </div>
      </div>
      <div className="dql-app-card-depth">
        <span>Saved locally</span>
        <button type="button" className="dql-app-card-act primary" onClick={onOpen}>Continue <ArrowRight size={12} /></button>
      </div>
    </article>
  );
}

function AppCard({
  app,
  favorite,
  onToggleFavorite,
  onOpen,
  onEdit,
  onDelete,
  reader = false,
}: {
  app: AppSummary;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
  /** Absent for someone who only reads Apps. */
  onEdit?: () => void;
  onDelete?: () => void;
  /** A hosted reader: no local drafts or local insights on the card. */
  reader?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const certified = app.certification === 'certified' || app.lifecycle === 'certified';
  const draftCount = app.drafts?.length ?? 0;
  const researchCount = app.investigations ?? 0;
  const aiPinCount = app.aiPins ?? 0;
  const shared = isSharedProjectApp(app);
  const trustLabel = certified ? 'Certified app' : draftCount > 0 || researchCount > 0 || aiPinCount > 0 ? 'Review needed' : 'Draft app';
  return (
    <article className="dql-app-card">
      <div className="dql-app-card-body" onClick={onOpen}>
        <div className="dql-app-card-top">
          <div className="dql-app-card-labels">
            <span className="dql-app-eyebrow">{app.domain || 'Domain'}</span>
            <span className={`dql-app-visibility ${shared ? 'shared' : 'private'}`}>{shared ? <Users size={12} /> : <ShieldCheck size={12} />}{reader ? (shared ? 'Shared' : 'Private') : shared ? 'Shared Project' : 'Private Project'}</span>
          </div>
          <button
            type="button"
            className={`dql-app-star ${favorite ? 'on' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
            aria-label={favorite ? `Remove ${app.name} from favourites` : `Add ${app.name} to favourites`}
            aria-pressed={favorite}
          >
            <Star size={14} strokeWidth={1.8} />
          </button>
        </div>
        {/* The card shows the App's lifecycle, not its data trust: whether each
            tile's source is certified is shown inside the App, from its run. */}
        <StatusSeal tone={certified ? 'certified' : draftCount > 0 ? 'draft' : 'agentic'} title="App lifecycle (draft, in review, certified). Data trust is shown on each tile inside the App.">
          {appLifecycleLabel(app.lifecycle, certified, draftCount)}
        </StatusSeal>
        <h3>
          <a
            className="dql-app-card-link"
            href={`/?app=${encodeURIComponent(app.id)}`}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpen(); }}
          >
            {app.name}
          </a>
        </h3>
        <p>{cleanStakeholderCopy(app.description || appLibraryWords(reader).appNote(app))}</p>
        <div className="dql-app-card-mini">
          <MiniMetric label="Pages" value={String(app.dashboards.length)} />
          <MiniMetric label="Books" value={String(app.notebooks?.length ?? 0)} />
          {reader ? null : <MiniMetric label="Drafts" value={String(draftCount)} />}
        </div>
        <div className="dql-app-card-signals">
          <span><ShieldCheck size={13} /> {trustLabel}</span>
          <span><Search size={13} /> {researchCount} analysis</span>
          {reader ? null : <span><Sparkles size={13} /> {aiPinCount} local insights</span>}
        </div>
      </div>
      <div className="dql-app-card-depth">
        <span>{primaryOwner(app)}</span>
        <button type="button" className="dql-app-card-act" onClick={onOpen} title="View app" aria-label={`View ${app.name}`}>
          <Eye size={12} /> View
        </button>
        {onEdit ? (
          <button type="button" className="dql-app-card-act" onClick={onEdit} title="Edit app" aria-label={`Edit ${app.name}`}>
            <Pencil size={12} /> Edit
          </button>
        ) : null}
        {onDelete ? <div className="dql-app-card-menu">
          <button type="button" className="dql-app-card-act" onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }} title="More App actions" aria-expanded={menuOpen}>
            <MoreHorizontal size={14} />
          </button>
          {menuOpen ? (
            <div role="menu">
              <button type="button" role="menuitem" className="danger" onClick={(event) => { event.stopPropagation(); setMenuOpen(false); onDelete(); }}>
                <Trash2 size={13} /> Delete App
              </button>
            </div>
          ) : null}
        </div> : null}
      </div>
    </article>
  );
}

function DeleteAppDialog({
  app,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  app: AppSummary;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const confirmed = confirmation.trim() === app.name;
  return (
    <div
      className="dql-app-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <section className="dql-app-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-app-title">
        <div className="dql-app-delete-heading">
          <span className="dql-app-delete-icon"><Trash2 size={16} /></span>
          <div>
            <h2 id="delete-app-title">Delete {app.name}?</h2>
            <p>Its project files and App-scoped local context move to recoverable local trash. Source control will show the canonical project files as deleted.</p>
          </div>
        </div>
        <label className="dql-app-delete-confirm">
          Type <strong>{app.name}</strong> to confirm
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && confirmed && !deleting) onConfirm(); }}
            disabled={deleting}
          />
        </label>
        {error ? <div className="dql-app-delete-error" role="alert">{error}</div> : null}
        <div className="dql-app-delete-actions">
          <button type="button" className="secondary" onClick={onCancel} disabled={deleting}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm} disabled={!confirmed || deleting}>{deleting ? 'Deleting…' : 'Delete App'}</button>
        </div>
      </section>
    </div>
  );
}

async function dashboardDocumentFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function AppWorkspaceSurface({
  app,
  metadataApp,
  dashboardPages,
  appDoc,
  dashboardDoc,
  loading,
  dashboardLoadError,
  dashboardRefusal,
  dashboardMissing,
  experience,
  section,
  explainOpen,
  explainExpanded,
  dashboardFilters,
  dashboardFilterValues,
  themeMode,
  variables: declaredVariables,
  onBack,
  onRetryDashboardLoad,
  onExperienceChange,
  onRenameApp,
  onSectionChange,
  onDashboardFilterChange,
  onApplyDashboardFilters,
  onResetDashboardFilters,
  onExplainChange,
  onExplainExpandedChange,
  onAddPage,
  onOpenDashboard,
  onNavigateDashboard,
  navigationCanGoBack,
  onNavigationBack,
  onOpenApp,
  onDashboardChanged,
  onInvestigationsChanged,
  onOpenLineageNode,
}: {
  /** Matching local-library entry; its presence is required for writes. */
  app: AppSummary | null;
  /** Server-resolved identity from the current persisted dashboard. */
  metadataApp: AppDocumentSummary['app'] | null;
  dashboardPages: WorkspaceDashboardSummary[];
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  loading: boolean;
  dashboardLoadError: string | null;
  dashboardRefusal: { next?: { label: string; href: string } } | null;
  /** The project has no such App or page (a host may say where it is). */
  dashboardMissing: boolean;
  experience: AppExperience;
  section: AppSection;
  explainOpen: boolean;
  explainExpanded: boolean;
  dashboardFilters: DashboardFilter[];
  dashboardFilterValues: Record<string, unknown>;
  themeMode: ThemeMode;
  variables: Record<string, unknown>;
  onBack: () => void;
  onRetryDashboardLoad: () => void;
  onExperienceChange: (experience: AppExperience) => void;
  onRenameApp: (name: string, dashboardId?: string) => void;
  onSectionChange: (section: AppSection) => void;
  onDashboardFilterChange: (filter: DashboardFilter, value: unknown) => void;
  onApplyDashboardFilters: () => void;
  onResetDashboardFilters: () => void;
  onExplainChange: (value: boolean) => void;
  onExplainExpandedChange: (value: boolean) => void;
  onAddPage: () => void;
  onOpenDashboard: (dashboardId: string) => void;
  onNavigateDashboard: (input: {
    fromDashboardId: string;
    toDashboardId: string;
    carryFilterIds: string[];
    variables: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
  navigationCanGoBack: boolean;
  onNavigationBack: () => void;
  onOpenApp: (appId: string, dashboardId?: string, draftId?: string) => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onInvestigationsChanged: (investigations: LocalAppInvestigation[]) => void;
  onOpenLineageNode: (nodeId: string) => void;
}) {
  const readOnlyLink = isViewerLink();
  const hostUi = useHostUi();
  const readerOnly = readOnlyLink || !hostAllows(hostUi, 'app.author');
  // "Ask about this App" is asking: only for people the host lets ask.
  const mayAskAboutApp = !readOnlyLink && hostAllows(hostUi, 'ask');
  const dispatch = useDispatch();
  const hostPage = useHostPage();
  const workspaceAppId = metadataApp?.id ?? app?.id ?? null;
  const workspaceAppName = metadataApp?.name ?? app?.name ?? null;
  // Dashboard metadata establishes what can be shown. Mutations still require
  // a same-App library record with its local write identity.
  const canWriteApp = Boolean(app && metadataApp && app.id === metadataApp.id);
  const isEditable = experience === 'build' && canWriteApp && !readerOnly;
  const draftCount = appDoc?.drafts?.length ?? 0;
  const dashboardBlockIds = useMemo(() => {
    return getCopilotBlockTiles(dashboardDoc?.dashboard ?? null).map((item) => item.blockId);
  }, [dashboardDoc]);
  const dashboardBlockKey = dashboardBlockIds.join('|');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(dashboardBlockIds[0] ?? null);
  const [dashboardRun, setDashboardRun] = useState<DashboardRunResponse | null>(null);
  // One aggregate data trust for the page, from the current run's tiles: the
  // header badge, Trust Lens line, story and tiles all read the same evidence.
  const [pageTrust, setPageTrust] = useState<AppTrustSummary | null>(null);
  const rollup = appCertificationRollup(dashboardDoc?.dashboard.layout.items, draftCount, dashboardRun?.tiles ?? null);
  // The rendered page reports the aggregate it shows next to its tiles; the
  // header repeats that exact value (plus any pending App drafts) rather than
  // computing its own. Before the page reports, the rollup says "not checked".
  const certification = pageTrust && pageTrust.state !== 'pending' && pageTrust.state !== 'empty'
    ? {
        allCertified: pageTrust.allCertified && draftCount === 0,
        label: pageTrust.allCertified && draftCount === 0 ? pageTrust.label : draftCount > 0 && pageTrust.allCertified ? `${pageTrust.text} · ${draftCount} App draft pending` : pageTrust.text,
      }
    : rollup;
  const [chartAnswer, setChartAnswer] = useState<{
    runId: string;
    tileId: string;
    state: 'loading' | 'ready' | 'error';
    answer?: Extract<AppAskResponse, { ok: true }>;
    error?: string;
  } | null>(null);
  // The same settled chart can receive more than one question. A slower older
  // answer must never replace the newer question's answer in this panel.
  const chartAnswerRequestRef = useRef(0);
  const [askSeed, setAskSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [researchSeed, setResearchSeed] = useState<AppResearchSeed | null>(null);
  const [activeInvestigation, setActiveInvestigation] = useState<LocalAppInvestigation | null>(null);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'downloaded' | 'ready'>('idle');
  const [shareText, setShareText] = useState('');
  const [promoteStatus, setPromoteStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [promoteMessage, setPromoteMessage] = useState('');
  const semanticTileIds = dashboardDoc?.dashboard.layout.items.filter((item) => item.semantic).map((item) => item.i) ?? [];
  const { ready: semanticRunReady, repairedTileIds: repairedSemanticTileIds } = semanticApprovalState(semanticTileIds, dashboardRun);
  const handleDashboardRunChange = useCallback((run: DashboardRunResponse | null) => {
    setDashboardRun(run);
    // Never display an answer grounded in a previous run as current after a
    // filter, query, interaction, or source-driven rerun settles.
    setChartAnswer((current) => {
      if (current?.runId === run?.runId) return current;
      chartAnswerRequestRef.current += 1;
      return null;
    });
  }, []);

  const [filterBusy, setFilterBusy] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const filterCandidates = useMemo(
    () => dashboardFilterCandidates(dashboardDoc?.dashboard ?? null, dashboardRun),
    [dashboardDoc, dashboardRun],
  );
  const coverageFor = useCallback(
    (filterId: string) => dashboardFilterCoverage(dashboardDoc?.dashboard ?? null, filterId, dashboardRun),
    [dashboardDoc, dashboardRun],
  );
  /**
   * Write the page's filter list. Filters live on the dashboard document, not
   * its layout, so the layout-only PATCH cannot carry them — this uses the
   * full-document PUT that already existed and had no caller.
   */
  const saveDashboardFilterDocument = useCallback(async (
    nextDashboard: DashboardDocumentResponse['dashboard'],
  ) => {
    if (!app?.id || !dashboardDoc) return;
    // Address the write by the app the loaded document says it belongs to, not
    // by whichever app the view currently has selected. Dashboard ids are only
    // unique within an app — several apps here have an `overview` page — so a
    // stale selection would write one app's document over another's file.
    const owningAppId = dashboardDoc.app?.id ?? app.id;
    if (owningAppId !== app.id) {
      setFilterError('This page belongs to a different app than the one open. Reload the app and try again.');
      return;
    }
    setFilterBusy(true);
    setFilterError(null);
    const result = await api.saveDashboard(owningAppId, dashboardDoc.dashboard.id, {
      ...nextDashboard,
    });
    setFilterBusy(false);
    if (!result.ok) {
      setFilterError(result.error);
      return;
    }
    const reloaded = await api.getDashboard(app.id, dashboardDoc.dashboard.id);
    if (reloaded?.dashboard) onDashboardChanged?.(reloaded.dashboard);
  }, [app?.id, dashboardDoc, onDashboardChanged]);

  const addDashboardFilter = useCallback((column: string) => {
    if (!dashboardDoc) return;
    const nextDashboard = addDashboardFilterToDocument(dashboardDoc.dashboard, column, dashboardRun);
    if (nextDashboard === dashboardDoc.dashboard) return;
    void saveDashboardFilterDocument(nextDashboard);
  }, [dashboardDoc, dashboardRun, saveDashboardFilterDocument]);

  /**
   * A viewer's own filter: applied to this session's run only.
   *
   * Nothing is written. A stakeholder narrowing a number to understand it must
   * not change the page's saved scope for everyone else; an author promotes one
   * deliberately with "Save to page" while customizing.
   */
  const [sessionFilters, setSessionFilters] = useState<ViewerDashboardFilter[]>([]);
  useEffect(() => { setSessionFilters([]); }, [dashboardDoc?.dashboard.id]);
  // The choice is held here and sent with every run of this page. It used to
  // be written into the page's declared-filter values, which only ever apply
  // filters the page declares — so the value was dropped and nothing narrowed.
  const applySessionFilter = useCallback((column: string, value: string) => {
    setSessionFilters((current) => applyViewerFilterChoice(current, { column, value, tileIds: coverageFor(column).applied }));
  }, [coverageFor]);
  const clearSessionFilter = useCallback((column: string) => {
    setSessionFilters((current) => current.filter((entry) => entry.column !== column));
  }, []);
  const saveSessionFilterToPage = useCallback((column: string) => {
    const entry = sessionFilters.find((candidate) => candidate.column === column);
    addDashboardFilter(column);
    // Keep the viewer's value once the column is a declared page filter.
    if (entry) onDashboardFilterChange({ id: column, type: 'select', bindsTo: column } as never, entry.value);
    setSessionFilters((current) => current.filter((candidate) => candidate.column !== column));
  }, [addDashboardFilter, onDashboardFilterChange, sessionFilters]);
  const viewerFilters = useMemo(
    () => viewerFiltersForRun(dashboardDoc?.dashboard ?? null, sessionFilters),
    [dashboardDoc?.dashboard, sessionFilters],
  );
  // Everything that describes the page's scope — the run, its story, "Ask
  // about this App", tile notices — reads the declared values plus these.
  const variables = useMemo(
    () => viewerFilterPageVariables(declaredVariables, viewerFilters),
    [declaredVariables, viewerFilters],
  );
  const activeSessionColumns = useMemo(() => new Set(viewerFilters.map((filter) => filter.column)), [viewerFilters]);
  const pickerCandidates = useMemo(
    () => filterCandidates.filter((candidate) => !activeSessionColumns.has(candidate.column)),
    [activeSessionColumns, filterCandidates],
  );

  const removeDashboardFilter = useCallback((filterId: string) => {
    if (!dashboardDoc) return;
    void saveDashboardFilterDocument(removeDashboardFilterFromDocument(dashboardDoc.dashboard, filterId));
  }, [dashboardDoc, saveDashboardFilterDocument]);
  const handleStartResearch = useCallback((seed: Omit<AppResearchSeed, 'nonce'>) => {
    setResearchSeed({ ...seed, nonce: Date.now() });
    onSectionChange('research');
    onExplainChange(true);
  }, [onExplainChange, onSectionChange]);
  const handleActiveInvestigationChange = useCallback((investigation: LocalAppInvestigation | null) => {
    setActiveInvestigation(investigation);
  }, []);
  const handleResearchSeedHandled = useCallback(() => {
    setResearchSeed(null);
  }, []);
  // The page run on screen, when it is a whole run of this page: Ask reads that run's results (server-side) for
  // a question about what the App shows. A bounded tile refresh keeps no page evidence, so it is not named.
  const currentPageRunId = dashboardRun && !dashboardRun.partial && dashboardRun.dashboardId === dashboardDoc?.dashboard.id
    ? dashboardRun.runId
    : undefined;
  const handleAskBlock = useCallback((blockId: string, question: string) => {
    setSelectedBlockId(blockId);
    // Stakeholder view: route tile follow-up through the governed agent loop in the
    // global right rail (deep research, repair, escalation). Build/analyst keeps the
    // in-app copilot shim.
    if (!isEditable) {
      dispatch({
        type: 'OPEN_GLOBAL_AI',
        audience: 'stakeholder',
        context: {
          title: 'App copilot',
          scopeHint: tidyTitle(workspaceAppName) ? `Follow up on ${tidyTitle(workspaceAppName)}` : 'Follow up on this tile',
          selectedObject: { kind: 'block', id: blockId, title: dashboardDoc?.dashboard.metadata.title },
          workspaceContext: {
            // Scoped to this App and page like "Ask about this App", focused on the tile.
            surface: 'apps',
            appId: workspaceAppId ?? undefined,
            appName: workspaceAppName ?? undefined,
            dashboardId: dashboardDoc?.dashboard.id,
            dashboardTitle: dashboardDoc?.dashboard.metadata.title,
            dashboardFilters: variables,
            blockId,
            ...(currentPageRunId ? { dashboardRunId: currentPageRunId } : {}),
          },
          // The app's own suggested questions (uncovered gaps from the AI build).
          suggestedQuestions: (dashboardDoc?.app as { copilot?: { suggestedQuestions?: string[] } } | undefined)?.copilot?.suggestedQuestions,
        },
        autoRun: { text: question, mode: 'auto' },
      });
      return;
    }
    onExplainChange(true);
    setAskSeed({ text: question, nonce: Date.now() });
  }, [dispatch, isEditable, workspaceAppId, workspaceAppName, dashboardDoc?.dashboard.id, dashboardDoc?.dashboard.metadata.title, onExplainChange, variables, currentPageRunId]);

  // "Ask about this App" (HH-16): the whole App, its domain and the filters on
  // screen, through the governed Ask loop (the server scopes it; see
  // app-copilot-scope). Readers ask in the global rail; authors in App AI.
  const handleAskApp = useCallback((question: string) => {
    if (isEditable) {
      onExplainChange(true);
      setAskSeed({ text: question, nonce: Date.now() });
      return;
    }
    const appTitle = tidyTitle(workspaceAppName) || 'this App';
    dispatch({
      type: 'OPEN_GLOBAL_AI',
      audience: 'stakeholder',
      context: {
        title: `Ask about ${appTitle}`,
        scopeHint: `Scoped to ${appTitle}${dashboardDoc?.dashboard.metadata.title ? ` · ${dashboardDoc.dashboard.metadata.title}` : ''}`,
        selectedObject: { kind: 'app', id: workspaceAppId ?? undefined, title: appTitle },
        workspaceContext: {
          surface: 'apps',
          appId: workspaceAppId ?? undefined,
          appName: workspaceAppName ?? undefined,
          dashboardId: dashboardDoc?.dashboard.id,
          dashboardTitle: dashboardDoc?.dashboard.metadata.title,
          dashboardFilters: variables,
          // The page run on screen: the server answers from its own evidence of it, never from browser rows.
          ...(currentPageRunId ? { dashboardRunId: currentPageRunId } : {}),
        },
        suggestedQuestions: (dashboardDoc?.app as { copilot?: { suggestedQuestions?: string[] } } | undefined)?.copilot?.suggestedQuestions,
      },
      autoRun: { text: question, mode: 'ask' },
    });
  }, [dispatch, isEditable, onExplainChange, workspaceAppId, workspaceAppName, dashboardDoc, variables, currentPageRunId]);
  const askAboutAppFilters = useMemo(() => [
    ...dashboardFilters.flatMap((filter) => {
      const value = dashboardFilterValues[filter.id];
      const text = Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
      return text.trim() ? [{ label: formatBusinessLabel((filter as { label?: string }).label ?? filter.id), value: text.slice(0, 80) }] : [];
    }),
    ...viewerFilters.map((filter) => ({ label: formatBusinessLabel(filter.column), value: filter.values.join(', ').slice(0, 80) })),
  ], [dashboardFilters, dashboardFilterValues, viewerFilters]);

  const handleAskChart = useCallback(async ({ tileId, runId, question }: { tileId: string; runId: string; question: string }) => {
    if (!workspaceAppId || !dashboardDoc) return;
    const requestToken = chartAnswerRequestRef.current + 1;
    chartAnswerRequestRef.current = requestToken;
    setChartAnswer({ runId, tileId, state: 'loading' });
    try {
      const response = await api.askApp(workspaceAppId, {
        question,
        dashboardId: dashboardDoc.dashboard.id,
        tileId,
        runId,
      });
      setChartAnswer((current) => {
        // A late response cannot overwrite a newer question, dashboard run,
        // or an answer panel that has since been closed.
        if (chartAnswerRequestRef.current !== requestToken
          || !current || current.runId !== runId || current.tileId !== tileId) return current;
        return response.ok
          ? { ...current, state: 'ready', answer: response }
          : { ...current, state: 'error', error: response.error };
      });
    } catch (error) {
      setChartAnswer((current) => {
        if (chartAnswerRequestRef.current !== requestToken
          || !current || current.runId !== runId || current.tileId !== tileId) return current;
        return { ...current, state: 'error', error: error instanceof Error ? error.message : String(error) };
      });
    }
  }, [workspaceAppId, dashboardDoc]);

  useEffect(() => {
    if (isEditable) return;
    if (section === 'notebooks' || section === 'ai' || section === 'drafts' || section === 'settings') {
      onSectionChange('dashboards');
    }
  }, [isEditable, section, onSectionChange]);

  useEffect(() => {
    if (dashboardBlockIds.length === 0) {
      if (selectedBlockId !== null) setSelectedBlockId(null);
      return;
    }
    if (!selectedBlockId || !dashboardBlockIds.includes(selectedBlockId)) {
      setSelectedBlockId(dashboardBlockIds[0]);
    }
  }, [dashboardBlockIds, dashboardBlockKey, selectedBlockId]);
  useEffect(() => {
    setDashboardRun(null);
    setChartAnswer(null);
    setActiveInvestigation(null);
  }, [workspaceAppId, dashboardDoc?.dashboard.id]);
  // A read-only link does not ask the owner's AI provider anything.
  const copilotAvailable = !readOnlyLink && Boolean(workspaceAppId && dashboardDoc && (section === 'dashboards' || section === 'research'));
  const copilotVisible = copilotAvailable && explainOpen;
  const markAction = (status: 'copied' | 'downloaded' | 'ready') => {
    setShareStatus(status);
    if (status !== 'ready') window.setTimeout(() => setShareStatus('idle'), 1800);
  };
  const copyShareLink = async () => {
    const text = buildAppShareText(app, appDoc, dashboardDoc, metadataApp);
    setShareText(text);
    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.focus();
      area.select();
      copied = document.execCommand('copy');
      document.body.removeChild(area);
    }
    markAction(copied ? 'copied' : 'ready');
  };
  const downloadBrief = () => {
    const markdown = buildAppBriefMarkdown(app, appDoc, dashboardDoc, metadataApp);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${workspaceAppId ?? appDoc?.app.id ?? 'dql-app'}-brief.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    markAction('downloaded');
  };
  const promoteApp = async () => {
    if (!canWriteApp || !app?.id) return;
    setPromoteStatus('running');
    setPromoteMessage('');
    const result = await api.publishAppToProject(app.id, { lifecycle: 'review' });
    if (!result.ok) {
      setPromoteStatus('error');
      setPromoteMessage(result.error);
      return;
    }
    setPromoteStatus('done');
    setPromoteMessage(`${result.paths.length} shared files published from the private draft${result.removedLocalTiles ? `; ${result.removedLocalTiles} local-only insight removed` : ''}.`);
    window.setTimeout(() => setPromoteStatus('idle'), 2400);
  };
  const approveSemanticResults = async () => {
    if (!canWriteApp || !app?.id || !dashboardDoc || !dashboardRun || semanticTileIds.length === 0) return;
    setPromoteStatus('running');
    setPromoteMessage('');
    const expectedDashboardFingerprint = await dashboardDocumentFingerprint(dashboardDoc.dashboard);
    const result = await api.approveAppSemanticTiles(app.id, dashboardDoc.dashboard.id, {
      runId: dashboardRun.runId,
      tileIds: semanticTileIds,
      expectedDashboardFingerprint,
    });
    if (!result.ok) {
      setPromoteStatus('error');
      setPromoteMessage(result.error);
      return;
    }
    onDashboardChanged(result.dashboard);
    setPromoteStatus('done');
    setPromoteMessage(`${semanticTileIds.length} semantic result${semanticTileIds.length === 1 ? '' : 's'} approved with run ${dashboardRun.runId}.`);
  };
  const onDashboards = section === 'dashboards' && Boolean(dashboardDoc);
  return (
    <div className="dql-app-workspace">
      <div className="dql-app-view-topbar">
        {readOnlyLink ? null : (
          <button type="button" className="dql-app-back dql-app-back-label" onClick={onBack} title="Back to apps">
            <ArrowLeft size={14} />
            <span>Apps</span>
          </button>
        )}
        {/* A reader sees the App's name; its id is for the people who build it. */}
        <span className="dql-app-crumb"><b>{hostReader(hostUi) ? (tidyTitle(workspaceAppName) || workspaceAppId || 'App') : (workspaceAppId ?? 'app')}</b></span>
        {onDashboards ? (
          <StatusSeal tone={certification.allCertified ? 'certified' : 'draft'} title="Data trust: whether every tile on this page ran from a certified source.">
            {certification.label}
          </StatusSeal>
        ) : null}
        {draftCount > 0 ? <StatusSeal tone="draft" title="App drafts waiting for review">{draftCount} App draft{draftCount === 1 ? '' : 's'}</StatusSeal> : null}

        {readerOnly ? null : <span className="dql-app-topbar-divider" aria-hidden="true" />}

        {readerOnly ? null : <div className="dql-app-modeseg" role="group" aria-label="App mode">
          <button
            type="button"
            className={!isEditable ? 'on' : ''}
            onClick={() => onExperienceChange('view')}
            title="Clean stakeholder view"
          >
            <Eye size={12} /> View
          </button>
          <button
            type="button"
            className={isEditable ? 'on' : ''}
            onClick={() => onExperienceChange('build')}
            title={canWriteApp ? 'Rearrange tiles and edit this app' : 'Editing is unavailable until matching local App metadata is loaded.'}
            disabled={!canWriteApp}
          >
            <Pencil size={12} /> Edit
          </button>
        </div>}

        <div className="dql-app-view-actions">
          {!readOnlyLink && workspaceAppId && dashboardDoc && section === 'dashboards'
            ? <FollowPageButton appId={workspaceAppId} pageId={dashboardDoc.dashboard.id} />
            : null}
          {readerOnly ? null : <PersonaSwitcher app={metadataApp} />}
          {isEditable ? (
            semanticTileIds.length > 0 ? (
              <button
                type="button"
                className="dql-apps-btn dql-apps-btn-line"
                onClick={() => void approveSemanticResults()}
                disabled={promoteStatus === 'running' || !semanticRunReady}
                title={semanticRunReady
                  ? 'Approve the successful semantic run for publication'
                  : repairedSemanticTileIds.length > 0
                    ? 'AI-repaired Metrics previews need review and cannot be approved as certified Metrics results'
                    : 'Run this dashboard successfully before semantic approval'}
              >
                <Check size={14} /> Approve semantic ({semanticTileIds.length})
              </button>
            ) : null
          ) : null}
          {isEditable ? (
            <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void promoteApp()} disabled={promoteStatus === 'running'}>
              <ShieldCheck size={14} /> {promoteStatus === 'running' ? 'Checking' : 'Publish to Project'}
            </button>
          ) : null}
          {readerOnly ? null : (
            <button type="button" className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon" title={shareStatus === 'copied' ? 'Copied handoff' : 'Share local app handoff'} onClick={() => void copyShareLink()}>
              {shareStatus === 'copied' ? <Check size={15} /> : <Share2 size={15} />}
            </button>
          )}
          <button type="button" className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon" title={shareStatus === 'downloaded' ? 'Brief saved' : 'Download app brief'} onClick={downloadBrief}>
            {shareStatus === 'downloaded' ? <Check size={15} /> : <Download size={15} />}
          </button>
          {shareStatus === 'ready' ? (
            <div className="dql-app-share-popover">
              <b>Local handoff</b>
              <textarea readOnly value={shareText} onFocus={(event) => event.currentTarget.select()} />
            </div>
          ) : null}
          {promoteStatus === 'done' || promoteStatus === 'error' ? (
            <div className={`dql-app-promote-popover ${promoteStatus === 'error' ? 'error' : ''}`}>
              {promoteMessage}
            </div>
          ) : null}
        </div>
      </div>

      <main className="dql-app-view-wrap">
        <div className="dql-app-title-row">
          <div className="dql-app-title-copy">
            <div className="dql-app-title-meta">
              <span><LayoutDashboard size={14} /> {metadataApp?.domain ?? dashboardDoc?.dashboard.metadata.domain ?? 'ZLens App'}</span>
              {onDashboards ? (
                // While on a page the heading below edits the PAGE title, so
                // this is the only place the App's own name can be renamed.
                isEditable && app ? (
                  <span className="dql-app-title-context">
                    <AppTitleInput
                      key={`${app.id}:name`}
                      variant="compact"
                      value={tidyTitle(app.name) || 'App'}
                      label="App name"
                      onCommit={(next) => void onRenameApp(next)}
                    />
                  </span>
                ) : <span className="dql-app-title-context">{tidyTitle(workspaceAppName) || 'App'}</span>
              ) : null}
              {isEditable ? <StatusSeal tone="draft">Customizing</StatusSeal> : null}
            </div>
            {/* Editable in place while customizing: `dql.app.json` and the page
                title previously had no writer after creation at all. */}
            {isEditable && app ? (
              <AppTitleInput
                key={`${app.id}:${onDashboards ? dashboardDoc?.dashboard.id ?? '' : 'app'}`}
                value={tidyTitle(onDashboards ? dashboardDoc?.dashboard.metadata.title : app.name) || 'App'}
                label={onDashboards ? 'Page name' : 'App name'}
                onCommit={(next) => void onRenameApp(next, onDashboards ? dashboardDoc?.dashboard.id : undefined)}
              />
            ) : (
              <h1>{tidyTitle(onDashboards ? dashboardDoc?.dashboard.metadata.title : workspaceAppName) || 'App'}</h1>
            )}
            <p>{cleanStakeholderCopy((onDashboards ? dashboardDoc?.dashboard.metadata.description : metadataApp?.description) ?? (hostReader(hostUi) ? '' : 'Local ZLens App'))}</p>
          </div>
          <div className="dql-app-nav-row">
            <AppWorkspaceTabs
              appDoc={appDoc}
              section={section}
              experience={isEditable ? 'build' : 'view'}
              dashboardCount={dashboardPages.length}
              onChange={onSectionChange}
            />
            {section === 'dashboards' && dashboardPages.length ? (
              <DashboardPagePicker
                dashboards={dashboardPages}
                activeDashboardId={dashboardDoc?.dashboard.id}
                isBuild={isEditable}
                onOpen={onOpenDashboard}
                onAdd={onAddPage}
              />
            ) : null}
            {copilotAvailable ? (
              <button
                type="button"
                className={`dql-apps-btn dql-apps-btn-line dql-apps-btn-icon ${explainOpen ? 'on' : ''}`}
                title={explainOpen ? 'Hide AI copilot' : 'Show AI copilot'}
                onClick={() => onExplainChange(!explainOpen)}
              >
                <Bot size={15} />
              </button>
            ) : null}
            {onDashboards && !readOnlyLink ? (
              <>
                <button
                  type="button"
                  className="dql-apps-btn dql-apps-btn-line dql-apps-btn-icon"
                  title="Open dashboard lineage"
                  onClick={() => { if (workspaceAppId && dashboardDoc) onOpenLineageNode(`dashboard:${workspaceAppId}/${dashboardDoc.dashboard.id}`); }}
                >
                  <GitBranch size={15} />
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className={`dql-app-view-layout ${copilotVisible ? '' : 'no-explain'}`}>
          <div className="dql-app-main-column">
            {/* Rendered whenever this page can be filtered at all — not only when
                it already carries a usable declared filter. Gating on that left
                a viewer with no way to filter a page the planner gave none to,
                and `deriveDashboardFilters` also drops a declared filter it
                considers unusable, which hid the row on pages that had one. */}
            {section === 'dashboards' && dashboardDoc
              && (dashboardFilters.length > 0 || filterCandidates.length > 0 || sessionFilters.length > 0 || isEditable) ? (
              <section className="dql-app-filter-row" aria-label="Dashboard filters">
                {dashboardFilters.length > 0 ? (
                  <>
                    <DashboardFilterControls
                      filters={dashboardFilters}
                      values={dashboardFilterValues}
                      onChange={onDashboardFilterChange}
                      datasets={dashboardDoc?.dashboard.datasets}
                    />
                    {dashboardFilters.some((filter) => coverageFor(filter.id).unaffected.length > 0) ? (
                      <div className="dql-app-filter-runtime-coverage" aria-label="Filter coverage">
                        {dashboardFilters.map((filter) => {
                          const coverage = coverageFor(filter.id);
                          if (coverage.unaffected.length === 0) return null;
                          return (
                            <span
                              key={filter.id}
                              className={`dql-app-filter-coverage ${coverage.applied.length === 0 ? 'is-none' : 'is-partial'}`}
                              title={`Unaffected: ${coverage.unaffected.map((tile) => `${tile.title ?? tile.tileId}${tile.reason ? ` — ${tile.reason}` : ''}`).join('; ')}`}
                            >
                              {formatBusinessLabel(filter.id)} affects {coverage.applied.length} of {coverage.filterable} tiles
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {dashboardFilters.some((filter) => JSON.stringify(dashboardFilterValues[filter.id] ?? null) !== JSON.stringify(defaultDashboardFilterValue(filter) ?? null)) ? (
                      <button type="button" className="dql-app-filter-reset" onClick={onResetDashboardFilters}>Reset</button>
                    ) : null}
                  </>
                ) : null}
                {/* The viewer's own control. Filtering a dashboard is a reading
                    act, so it belongs here rather than behind Edit. */}
                <DashboardFilterPicker
                  candidates={pickerCandidates}
                  coverageFor={coverageFor}
                  onApply={applySessionFilter}
                />
                {sessionFilters.length > 0 ? (
                  <div className="dql-app-filter-session" aria-label="Your filters">
                    {sessionFilters.map((entry) => {
                      const label = formatBusinessLabel(entry.column);
                      const reach = viewerFilterReach(dashboardDoc.dashboard, dashboardRun, entry);
                      const reachText = reach.applied.length === 0
                        ? 'No tile can apply it'
                        : `${reach.settled ? 'Narrows' : 'Narrowing'} ${reach.applied.length} of ${reach.filterable} tile${reach.filterable === 1 ? '' : 's'}`;
                      return (
                        <span
                          key={entry.column}
                          className={`dql-app-filter-chip${reach.applied.length === 0 ? ' is-none' : reach.unaffected.length > 0 ? ' is-partial' : ''}`}
                          data-testid="app-viewer-filter-chip"
                          title={reach.unaffected.length
                            ? `Not filtered by ${label}: ${reach.unaffected.map((tile) => tile.title ?? tile.tileId).join('; ')}`
                            : `Every tile on this page is filtered by ${label}.`}
                        >
                          <b>{label}:</b>
                          <span className="dql-app-filter-chip-value">{entry.value}</span>
                          <small>{reachText}</small>
                          <button
                            type="button"
                            className="dql-app-filter-chip-clear"
                            aria-label={`Clear the ${label} filter`}
                            onClick={() => clearSessionFilter(entry.column)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </span>
                      );
                    })}
                    <span>Your filters, this session only.</span>
                    {isEditable
                      ? sessionFilters.map((entry) => (
                          <button
                            key={entry.column}
                            type="button"
                            className="dql-apps-btn dql-apps-btn-line"
                            disabled={filterBusy}
                            onClick={() => saveSessionFilterToPage(entry.column)}
                          >
                            Save “{formatBusinessLabel(entry.column)}” to page
                          </button>
                        ))
                      : null}
                  </div>
                ) : null}
                {isEditable ? (
                  <DashboardFilterEditor
                    filters={dashboardDoc.dashboard.filters ?? []}
                    candidates={filterCandidates}
                    coverageFor={coverageFor}
                    onAdd={addDashboardFilter}
                    onRemove={removeDashboardFilter}
                    busy={filterBusy}
                  />
                ) : null}
                {filterError ? <div className="dql-app-filter-error" role="alert">{filterError}</div> : null}
              </section>
            ) : null}
            {loading ? (
              <EmptyPanel title="Loading app..." detail="Reading dashboard files and running local blocks." />
            ) : section === 'dashboards' && dashboardLoadError && dashboardRefusal ? (
              <div role="alert" style={{ display: 'grid', justifyItems: 'start', gap: 10 }}>
                <EmptyPanel title="You don't have access to this App" detail={dashboardLoadError} />
                {dashboardRefusal.next ? (
                  <button
                    type="button"
                    className="dql-apps-btn dql-apps-btn-primary"
                    onClick={() => { hostPage.openPage({ id: `refusal-${dashboardRefusal.next!.href}`, label: dashboardRefusal.next!.label, href: dashboardRefusal.next!.href }); dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
                  >
                    {dashboardRefusal.next.label}
                  </button>
                ) : null}
              </div>
            ) : section === 'dashboards' && dashboardLoadError && dashboardMissing && hostUi.host && hostUi.appNotFound ? (
              // HH-9 `appNotFound`: with a host the App may be elsewhere; the host says where, in its words.
              <div role="alert" style={{ display: 'grid', justifyItems: 'start', gap: 10 }}>
                <EmptyPanel title="This App isn't available here" detail={hostUi.appNotFound.message} />
                {hostUi.appNotFound.next ? (
                  <button
                    type="button"
                    className="dql-apps-btn dql-apps-btn-primary"
                    onClick={() => { const next = hostUi.host && hostUi.appNotFound?.next; if (!next) return; hostPage.openPage({ id: `missing-${next.href}`, label: next.label, href: next.href }); dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
                  >
                    {hostUi.appNotFound.next.label}
                  </button>
                ) : null}
              </div>
            ) : section === 'dashboards' && dashboardLoadError ? (
              <div role="alert" style={{ display: 'grid', justifyItems: 'start', gap: 10 }}>
                <EmptyPanel title="Dashboard could not be loaded" detail={dashboardLoadError} />
                <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onRetryDashboardLoad}>Retry loading dashboard</button>
              </div>
            ) : section === 'dashboards' && dashboardDoc && metadataApp ? (
              <>
                {navigationCanGoBack ? (
                  <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onNavigationBack} style={{ marginBottom: 8 }}>
                    <ArrowLeft size={14} /> Back to previous page
                  </button>
                ) : null}
                {!mayAskAboutApp ? null : (
                  <AskAboutApp
                    scope={{
                      appId: metadataApp.id,
                      appName: tidyTitle(metadataApp.name) || metadataApp.id,
                      domain: metadataApp.domain,
                      dashboardId: dashboardDoc.dashboard.id,
                      pageTitle: dashboardDoc.dashboard.metadata.title,
                      filters: askAboutAppFilters,
                      resultsReady: Boolean(currentPageRunId),
                    }}
                    onAsk={handleAskApp}
                  />
                )}
                <DashboardRenderer
                  appId={metadataApp.id}
                  dashboard={dashboardDoc.dashboard}
                  editable={isEditable}
                  embeddedHeader
                  variables={variables}
                  viewerFilters={viewerFilters}
                  selectedBlockId={selectedBlockId}
                  onBlockFocus={setSelectedBlockId}
                  onAskBlock={handleAskBlock}
                  onAskChart={handleAskChart}
                  onOpenLineageNode={onOpenLineageNode}
                  copilotOpen={explainOpen}
                  onCopilotChange={onExplainChange}
                  onDashboardChanged={onDashboardChanged}
                  onRunChange={handleDashboardRunChange}
                  onTrustChange={setPageTrust}
                  onNavigateDashboard={onNavigateDashboard}
                />
                {chartAnswer ? (
                  <DatasetChartAnswerPanel
                    answer={chartAnswer}
                    onAsk={(question) => void handleAskChart({
                      tileId: chartAnswer.tileId,
                      runId: chartAnswer.runId,
                      question,
                    })}
                    onClose={() => {
                      chartAnswerRequestRef.current += 1;
                      setChartAnswer(null);
                    }}
                  />
                ) : null}
              </>
            ) : section === 'notebooks' ? (
              <NotebookListPanel appDoc={appDoc} />
            ) : section === 'research' ? (
              <ResearchPanel
                appDoc={appDoc}
                dashboardDoc={dashboardDoc}
                seed={researchSeed}
                themeMode={themeMode}
                onSeedHandled={handleResearchSeedHandled}
                onDashboardChanged={onDashboardChanged}
                onInvestigationsChanged={onInvestigationsChanged}
                onActiveInvestigationChange={handleActiveInvestigationChange}
              />
            ) : section === 'ai' ? (
              <AiPinsPanel appDoc={appDoc} />
            ) : section === 'drafts' ? (
              <DraftsPanel appDoc={appDoc} />
            ) : section === 'settings' ? (
              <SettingsPanel
                appDoc={appDoc}
                onOpenLink={(label, href) => { hostPage.openPage({ id: `app-settings-${href}`, label, href }); dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
              />
            ) : (
              <EmptyPanel title="No dashboard page selected." detail="Choose a dashboard page or add one in Build mode." />
            )}
          </div>
          {copilotVisible ? (
            <UnifiedAppAiPanel
              app={app}
              appDoc={appDoc}
              dashboardDoc={dashboardDoc}
              dashboardRun={dashboardRun}
              variables={variables}
              selectedBlockId={selectedBlockId}
              askSeed={askSeed}
              themeMode={themeMode}
              expanded={explainExpanded}
              onToggleExpanded={() => onExplainExpandedChange(!explainExpanded)}
              onClose={() => onExplainChange(false)}
              onOpenApp={onOpenApp}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * An `h1` that becomes an input while customizing.
 *
 * Renaming commits on blur or Enter, never per keystroke, and Escape restores
 * the saved value so a half-typed name cannot be written by accident.
 */
/**
 * Rename control for the App and the page.
 *
 * `variant` matters for reachability, not just looks. While viewing a page the
 * heading-scale field edits the *page* title, so the App's own name had no
 * writer anywhere on the screen the user actually lands on. The compact variant
 * puts it in the meta row beside the domain, where it was already displayed as
 * dead text.
 */
function AppTitleInput({ value, label, onCommit, variant = 'title' }: { value: string; label: string; onCommit: (next: string) => void; variant?: 'title' | 'compact' }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      className={variant === 'compact' ? 'dql-app-title-input dql-app-title-input-compact' : 'dql-app-title-input'}
      aria-label={label}
      title={`${label} — press Enter to save`}
      value={draft}
      size={variant === 'compact' ? Math.max(8, Math.min(36, draft.length + 1)) : undefined}
      maxLength={120}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { const next = draft.trim(); if (next && next !== value) onCommit(next); else setDraft(value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
      }}
    />
  );
}

function AppWorkspaceTabs({
  appDoc,
  section,
  experience,
  dashboardCount,
  onChange,
}: {
  appDoc: AppDocumentSummary | null;
  section: AppSection;
  experience: AppExperience;
  dashboardCount: number;
  onChange: (section: AppSection) => void;
}) {
  const reportCount = appDoc?.investigations?.length ?? 0;
  const appTab = { id: 'dashboards' as const, label: 'Canvas', count: dashboardCount, icon: <LayoutDashboard size={14} /> };
  const contextItems: Array<{ id: AppSection; label: string; count?: number; icon: ReactNode }> = [
    { id: 'research', label: 'Analysis & evidence', count: reportCount, icon: <Search size={14} /> },
    { id: 'notebooks', label: 'Source notebooks', count: appDoc?.notebooks?.length ?? appDoc?.app.notebooks?.length ?? 0, icon: <BookOpenText size={14} /> },
    { id: 'ai', label: 'Saved insights', count: appDoc?.aiPins?.length ?? 0, icon: <Bot size={14} /> },
    { id: 'drafts', label: 'Review drafts', count: appDoc?.drafts?.length ?? 0, icon: <FileText size={14} /> },
    { id: 'settings', label: 'App settings', icon: <Workflow size={14} /> },
  ];
  return (
    <nav className="dql-app-section-tabs" aria-label="App sections">
      <button className={section === appTab.id ? 'on' : ''} data-app-section={appTab.id} onClick={() => onChange(appTab.id)}>
        <i className="dql-app-tab-icon">{appTab.icon}</i><span className="dql-app-tab-label">{appTab.label}</span><b>{appTab.count}</b>
      </button>
      {experience === 'build' ? (
        <details className="dql-app-context-menu">
          <summary><MoreHorizontal size={14} /> Context</summary>
          <div>
            {contextItems.map((item) => (
              <button key={item.id} type="button" className={section === item.id ? 'on' : ''} onClick={() => onChange(item.id)}>
                {item.icon}<span>{item.label}</span>{item.count !== undefined ? <b>{item.count}</b> : null}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </nav>
  );
}

function DashboardPagePicker({
  dashboards,
  activeDashboardId,
  isBuild,
  onOpen,
  onAdd,
}: {
  dashboards: WorkspaceDashboardSummary[];
  activeDashboardId?: string | null;
  isBuild: boolean;
  onOpen: (dashboardId: string) => void;
  onAdd: () => void;
}) {
  const activeDashboard = dashboards.find((dashboard) => dashboard.id === activeDashboardId) ?? dashboards[0];
  if (dashboards.length <= 6) {
    return (
      <nav className="dql-app-page-tabs" aria-label="Dashboard page">
        {dashboards.map((dashboard) => (
          <button
            key={dashboard.id}
            type="button"
            className={dashboard.id === activeDashboard?.id ? 'on' : ''}
            aria-current={dashboard.id === activeDashboard?.id ? 'page' : undefined}
            onClick={() => onOpen(dashboard.id)}
          >
            {dashboard.title}
          </button>
        ))}
        {isBuild ? (
          <button type="button" className="dql-app-page-add" onClick={onAdd} title="Add dashboard page" aria-label="Add dashboard page">
            <Plus size={14} />
          </button>
        ) : null}
      </nav>
    );
  }
  return (
    <div className="dql-app-page-picker" aria-label="Dashboard page">
      <span><LineChart size={14} /> Page</span>
      <select
        value={activeDashboard?.id ?? ''}
        onChange={(event) => onOpen(event.target.value)}
        title={activeDashboard?.title ?? 'Dashboard page'}
      >
        {dashboards.map((dashboard) => (
          <option key={dashboard.id} value={dashboard.id}>
            {dashboard.title}{dashboard.itemCount === undefined ? '' : ` (${dashboard.itemCount})`}
          </option>
        ))}
      </select>
      {isBuild ? (
        <button type="button" onClick={onAdd} title="Add dashboard page">
          <Plus size={14} />
        </button>
      ) : null}
    </div>
  );
}

function UnifiedAppAiPanel({
  app,
  appDoc,
  dashboardDoc,
  dashboardRun,
  variables,
  selectedBlockId,
  askSeed,
  themeMode,
  expanded,
  onToggleExpanded,
  onClose,
  onOpenApp,
}: {
  app: AppSummary | null;
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  dashboardRun: DashboardRunResponse | null;
  variables: Record<string, unknown>;
  selectedBlockId: string | null;
  askSeed?: { text: string; nonce: number } | null;
  themeMode: ThemeMode;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onOpenApp: (appId: string, dashboardId?: string, draftId?: string) => void;
}) {
  const t = themes[themeMode];
  const dashboard = dashboardDoc?.dashboard ?? null;
  const blockTiles = useMemo(() => getCopilotBlockTiles(dashboard, dashboardRun), [dashboard, dashboardRun]);
  const selectedBlock = blockTiles.find((item) => item.blockId === selectedBlockId) ?? null;
  const selectedTileRun = selectedBlock
    ? dashboardRun?.tiles.find((tile) => tile.tileId === selectedBlock.tileId || tile.blockId === selectedBlock.blockId)
    : null;
  const appId = app?.id ?? appDoc?.app.id ?? 'app';
  const dashboardId = dashboard?.id ?? 'dashboard';
  const agentThread = usePersistedAgentThreadId(`app:${appId}:${dashboardId}`);
  const [appAiRunning, setAppAiRunning] = useState(false);
  const appTitle = formatBusinessLabel(app?.name ?? appDoc?.app.name ?? dashboard?.metadata.title ?? 'App workspace');
  const dashboardTitle = formatBusinessLabel(dashboard?.metadata.title ?? 'Dashboard');
  const scopeHint = selectedBlock
    ? `Focused on ${formatBusinessLabel(selectedBlock.title)} in ${dashboardTitle}`
    : `Scoped to ${dashboardTitle}`;
  const selectedObject = selectedBlock
    ? { kind: 'block' as const, id: selectedBlock.blockId, title: selectedBlock.title }
    : dashboard
      ? { kind: 'dashboard' as const, id: dashboard.id, title: dashboard.metadata.title }
      : { kind: 'app' as const, id: appId, title: appTitle };
  const workspaceContext = useMemo(() => ({
    surface: 'apps',
    appId,
    appName: app?.name ?? appDoc?.app.name,
    appDomain: app?.domain ?? appDoc?.app.domain,
    appDescription: app?.description ?? appDoc?.app.description,
    dashboardId: dashboard?.id,
    dashboardTitle: dashboard?.metadata.title,
    dashboardDescription: dashboard?.metadata.description,
    dashboardFilters: variables,
    ...(dashboardRun && !dashboardRun.partial && dashboardRun.dashboardId === dashboard?.id ? { dashboardRunId: dashboardRun.runId } : {}),
    selectedBlock: selectedBlock ? {
      blockId: selectedBlock.blockId,
      tileId: selectedBlock.tileId,
      title: selectedBlock.title,
      visualization: selectedBlock.viz,
      status: selectedTileRun?.status,
      certificationStatus: selectedTileRun?.certificationStatus,
      rowCount: selectedTileRun?.result?.rowCount,
      columns: selectedTileRun?.result?.columns?.slice(0, 12),
      sampleRows: sampleDashboardRows(selectedTileRun?.result?.rows, selectedTileRun?.result?.columns),
    } : undefined,
  }), [app, appDoc, appId, dashboard, dashboardRun, selectedBlock, selectedTileRun, variables]);

  return (
    <AiSidePanel
      t={t}
      title="App AI"
      subtitle={appTitle}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      resizable
      minResizeWidth={390}
      maxResizeWidth={1200}
      fitViewportHeight
      heightResizable
      minResizeHeight={520}
      onClose={onClose}
      onNewChat={agentThread.resetThreadId}
      running={appAiRunning}
      ariaLabel="App AI"
      className="dql-app-explain-panel dql-app-assistant-panel"
    >
      <Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: t.textSecondary }}>Loading App AI…</div>}>
        <UnifiedAgentRunPanel
          key={`${appId}:${dashboardId}`}
          themeMode={themeMode}
          title="App AI"
          scopeHint={scopeHint}
          audience="stakeholder"
          selectedObject={selectedObject}
          workspaceContext={workspaceContext}
          initialMode="auto"
          autoRun={askSeed?.text ? { text: askSeed.text, mode: 'ask', nonce: askSeed.nonce } : undefined}
          threadId={agentThread.threadId}
          onThreadIdChange={agentThread.onThreadIdChange}
          onRunningChange={setAppAiRunning}
          onOpenApp={onOpenApp}
          answerFirstCards
          examplePrompts={[
            { label: 'Explain this dashboard', prompt: 'Explain the most important business story in this dashboard and what action it suggests.' },
            { label: 'Find the main driver', prompt: 'What is the main driver behind the current result? Use the active app filters and governed evidence.' },
            { label: 'Check this result', prompt: 'Validate the current result against its certified block, semantic definitions, and lineage.' },
          ]}
        />
      </Suspense>
    </AiSidePanel>
  );
}

function plannedAppFilterIds(plan: GeneratedAppPlan | undefined): string[] {
  if (!plan) return [];
  return Array.from(new Set([
    ...(plan.globalFilters ?? []).map((filter) => filter.id),
    ...plan.pages.flatMap((page) => (page.filters ?? []).map((filter) => filter.id)),
  ]));
}

function getDashboardItemBlockId(item: DashboardDocumentResponse['dashboard']['layout']['items'][number]): string | null {
  if (!item.block) return null;
  return 'blockId' in item.block ? item.block.blockId ?? null : item.block.ref ?? null;
}

function getCopilotBlockTiles(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  run?: DashboardRunResponse | null,
): AppCopilotBlockTile[] {
  if (!dashboard) return [];
  const runByTile = new Map((run?.tiles ?? []).map((tile) => [tile.tileId, tile]));
  const runByBlock = new Map((run?.tiles ?? []).filter((tile) => tile.blockId).map((tile) => [tile.blockId, tile]));
  const preferredTopics = new Set(dashboard.layout.items
    .filter((item) => getDashboardItemBlockId(item) && isPreferredCopilotContextItem(item))
    .map((item) => copilotBusinessTopicSignature(`${item.title ?? ''} ${getDashboardItemBlockId(item) ?? ''}`))
    .filter(Boolean));
  const ranked = dashboard.layout.items
    .map((item, index) => {
      const blockId = getDashboardItemBlockId(item);
      if (!blockId) return null;
      const topicKey = copilotBusinessTopicSignature(`${item.title ?? ''} ${blockId}`);
      if (topicKey && preferredTopics.has(topicKey) && !isPreferredCopilotContextItem(item)) return null;
      const tileRun = runByTile.get(item.i) ?? runByBlock.get(blockId);
      return {
        block: {
          blockId,
          title: item.title ?? blockId,
          viz: item.viz.type,
          tileId: item.i,
        },
        duplicateKeys: copilotBlockTileDuplicateKeys(item, tileRun, blockId),
        score: copilotBlockTileScore(item, tileRun, index),
      };
    })
    .filter((item): item is { block: AppCopilotBlockTile; duplicateKeys: string[]; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score);

  const seen = new Set<string>();
  const blocks: AppCopilotBlockTile[] = [];
  for (const item of ranked) {
    if (item.duplicateKeys.some((key) => seen.has(key))) continue;
    for (const key of item.duplicateKeys) seen.add(key);
    blocks.push(item.block);
  }
  return blocks;
}

function isPreferredCopilotContextItem(item: DashboardLayoutItem): boolean {
  if (item.parameterBindings?.length) return true;
  return Boolean(item.filterBindings?.some((binding) =>
    !binding.unsupportedReason && (binding.mode === 'parameter' || binding.mode === 'predicate' || Boolean(binding.binding)),
  ));
}

function copilotBlockTileDuplicateKeys(
  item: DashboardLayoutItem,
  tile: DashboardRunResponse['tiles'][number] | undefined,
  blockId: string,
): string[] {
  const keys = [`block:${blockId}`];
  const resultKey = copilotResultFingerprint(tile?.result);
  if (resultKey) keys.push(`result:${resultKey}`);
  const topicKey = copilotBusinessTopicSignature(`${item.title ?? ''} ${blockId}`);
  if (topicKey) keys.push(`topic:${topicKey}`);
  return keys;
}

function copilotResultFingerprint(result: DashboardRunResponse['tiles'][number]['result'] | undefined): string {
  if (!result?.columns?.length || !result.rows?.length) return '';
  const columns = result.columns.slice(0, 6).map((column) => column.toLowerCase());
  const rowValues = result.rows.slice(0, 3).map((row) =>
    columns.map((column) => formatCopilotFingerprintValue(row[column] ?? row[result.columns.find((candidate) => candidate.toLowerCase() === column) ?? column])).join(','),
  );
  return [...columns, ...rowValues].join('|');
}

function formatCopilotFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function copilotBusinessTopicSignature(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/\b(codex|e2e|qa|draft|imported|pasted|raw|sql|block)\b/g, ' ')
    .replace(/\b20\d{10,}\b/g, ' ');
  const entity = /\b(player|players|scorer|scorers|athlete)\b/.test(text)
    ? 'player'
    : /\b(customer|account|user)\b/.test(text)
      ? 'customer'
      : /\b(team|teams)\b/.test(text)
        ? 'team'
        : '';
  const intent = /\b(top|bottom|rank|ranking|leader|leaderboard|scorer|scorers)\b/.test(text)
    ? 'ranking'
    : /\b(availability|freshness|record|records|quality|coverage)\b/.test(text)
      ? 'availability'
      : /\b(trend|weekly|monthly|daily|over time)\b/.test(text)
        ? 'trend'
        : '';
  const metric = /\b(point|points|pts|score|scoring|scorer|scorers)\b/.test(text)
    ? 'points'
    : /\b(field goal|fgm|fga|field-goal|field_goals?)\b/.test(text)
      ? 'field_goals'
      : /\b(count|records|games played)\b/.test(text)
        ? 'count'
        : /\b(availability|freshness|quality|coverage)\b/.test(text)
          ? 'quality'
          : '';
  if (!entity || !intent || !metric) return '';
  return `${entity}|${intent}|${metric}`;
}

function copilotBlockTileScore(
  item: DashboardLayoutItem,
  tile: DashboardRunResponse['tiles'][number] | undefined,
  index: number,
): number {
  let score = 10000 - index;
  if (item.parameterBindings?.length) score += 50000;
  if (item.filterBindings?.length) score += 20000;
  if (tile?.status === 'ok') score += 15000;
  if (tile?.result?.rows?.length) score += 8000;
  if (tile?.certificationStatus === 'certified') score += 5000;
  if (String(item.trustState ?? item.display?.trustState ?? '').toLowerCase() === 'certified') score += 3000;
  if (/codex\s+e2e|test|pasted/i.test(String(item.title ?? ''))) score -= 6000;
  return score;
}

function sampleDashboardRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
}

function formatCopilotRouteLabel(route: AppCopilotRoute): string {
  if (route === 'certified_answer') return 'Answered from trusted logic';
  if (route === 'dataset_chart_answer') return 'Answered from this chart';
  if (route === 'generated_answer') return 'Generated — needs review';
  if (route === 'investigation') return 'Needs analysis';
  if (route === 'app_change_proposal') return 'App change idea';
  if (route === 'metadata_answer') return 'Metadata answer';
  return formatBusinessLabel(String(route));
}

function formatActionBriefLabel(mode: 'research' | 'evidence' | 'block'): string {
  if (mode === 'evidence') return 'Proof request';
  if (mode === 'block') return 'Reusable logic';
  return 'Business memo';
}

function reportTitleForAction(mode: 'research' | 'evidence' | 'block', question: string): string {
  const label = mode === 'evidence' ? 'Proof' : mode === 'block' ? 'Reusable Logic' : 'Business Memo';
  return `${label}: ${question}`;
}

function buildAppShareText(
  app: AppSummary | null,
  appDoc: AppDocumentSummary | null,
  dashboardDoc: DashboardDocumentResponse | null,
  dashboardApp?: AppDocumentSummary['app'] | null,
): string {
  const appId = app?.id ?? dashboardApp?.id ?? appDoc?.app.id ?? 'app';
  const appName = app?.name ?? dashboardApp?.name ?? appDoc?.app.name ?? 'ZLens App';
  const dashboard = dashboardDoc?.dashboard.metadata.title ?? appDoc?.dashboards[0]?.title ?? 'Overview';
  const origin = typeof window !== 'undefined' ? window.location.origin : null;
  const pageId = dashboardDoc?.dashboard.id ?? appDoc?.dashboards[0]?.id ?? null;
  return [
    appName,
    `App ID: ${appId}`,
    `Dashboard: ${dashboard}`,
    `Domain: ${app?.domain ?? dashboardApp?.domain ?? appDoc?.app.domain ?? dashboardDoc?.dashboard.metadata.domain ?? 'unknown'}`,
    `Open: ${origin ? appPageUrl(origin, { appId, pageId }) : 'local ZLens'}`,
  ].join('\n');
}

function buildAppBriefMarkdown(
  app: AppSummary | null,
  appDoc: AppDocumentSummary | null,
  dashboardDoc: DashboardDocumentResponse | null,
  dashboardApp?: AppDocumentSummary['app'] | null,
): string {
  const appModel = appDoc?.app ?? dashboardApp;
  const title = app?.name ?? appModel?.name ?? 'ZLens App';
  const dashboards = appDoc?.dashboards ?? [];
  const notebooks = appDoc?.notebooks ?? appModel?.notebooks ?? [];
  const drafts = appDoc?.drafts ?? [];
  const aiPins = appDoc?.aiPins ?? [];
  const dashboard = dashboardDoc?.dashboard;
  const blocks = dashboard?.layout.items
    .map((item) => item.block ? (item.block.blockId ?? item.block.ref ?? item.title ?? item.i) : null)
    .filter((value): value is string => Boolean(value)) ?? [];
  const lines = [
    `# ${title}`,
    '',
    app?.description ?? dashboard?.metadata.description ?? appModel?.description ?? 'Local ZLens App brief.',
    '',
    '## App Metadata',
    '',
    `- App ID: ${app?.id ?? appModel?.id ?? 'unknown'}`,
    `- Domain: ${app?.domain ?? appModel?.domain ?? dashboard?.metadata.domain ?? 'unknown'}`,
    `- Lifecycle: ${app?.lifecycle ?? appModel?.lifecycle ?? dashboard?.metadata.lifecycle ?? 'draft'}`,
    `- Audience: ${app?.audience ?? appModel?.audience ?? dashboard?.metadata.audience ?? 'stakeholder'}`,
    `- Owners: ${(app?.owners ?? appModel?.owners ?? []).join(', ') || 'owner@local'}`,
    '',
    '## Pages',
    '',
    ...(dashboards.length ? dashboards.map((item) => `- ${item.title} (${item.itemCount} tiles)`) : ['- No dashboard pages found.']),
    '',
    '## Governed Blocks',
    '',
    ...(blocks.length ? blocks.map((name) => `- ${name}`) : ['- No block-backed tiles found.']),
    '',
    '## Supporting Assets',
    '',
    `- Notebooks: ${notebooks.length}`,
    `- Pinned insights: ${aiPins.length}`,
    `- Drafts needing review: ${drafts.length}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><b>{value}</b></span>;
}

function AddPageDialog({
  title,
  allowExploration,
  exploreGaps,
  error,
  onChange,
  onExploreGapsChange,
  onCancel,
  onCreate,
}: {
  title: string;
  allowExploration: boolean;
  exploreGaps: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onExploreGapsChange: (value: boolean) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="dql-app-modal-backdrop">
      <div className="dql-app-modal">
        <h3>Build a new App page</h3>
        <p>Describe the business question. AI will propose exactly one page for review before changing the App.</p>
        <label>What should this page answer?
          <textarea
            value={title}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            rows={4}
            placeholder="Show quarterly revenue drivers by region and segment for leadership."
          />
        </label>
        {allowExploration ? (
          <button
            type="button"
            className={`dql-app-page-explore ${exploreGaps ? 'on' : ''}`}
            onClick={() => onExploreGapsChange(!exploreGaps)}
            aria-pressed={exploreGaps}
          >
            <span>{exploreGaps ? <Check size={11} strokeWidth={3} /> : null}</span>
            <b>Explore uncovered gaps with AI SQL</b>
            <small>Personal App only · bounded preview · needs review</small>
          </button>
        ) : (
          <small className="dql-app-page-source-policy">Shared-project pages use certified Datasets, Metrics and saved queries.</small>
        )}
        {error ? <div className="dql-app-error">{error}</div> : null}
        <div>
          <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onCancel}>Cancel</button>
          <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={onCreate}>Create Build Brief</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Keep the form's selected run and tile server-issued. The free-form question
 * can change, but the panel cannot retarget a request to another chart.
 */
export function datasetChartAnswerRequest(
  answer: { runId: string; tileId: string },
  question: string,
): { runId: string; tileId: string; question: string } | null {
  const normalized = question.trim();
  return normalized ? { runId: answer.runId, tileId: answer.tileId, question: normalized } : null;
}

/**
 * This deliberately small panel is fed only by the Dataset chart-answer
 * endpoint. It does not turn displayed rows into generic Ask context or reuse
 * an answer after the renderer reports a different run id.
 */
export function DatasetChartAnswerPanel({
  answer,
  onClose,
  onAsk,
}: {
  answer: {
    runId: string;
    tileId: string;
    state: 'loading' | 'ready' | 'error';
    answer?: Extract<AppAskResponse, { ok: true }>;
    error?: string;
  };
  onClose: () => void;
  onAsk?: (question: string) => void;
}) {
  const context = answer.answer?.analyticalContext;
  const [question, setQuestion] = useState('');
  const request = datasetChartAnswerRequest(answer, question);
  return (
    <section
      aria-live="polite"
      aria-label="Dataset chart answer"
      style={{
        marginTop: 12,
        border: '1px solid var(--border-default, var(--border-color, rgba(0,0,0,0.12)))',
        background: 'var(--bg-1, var(--dql-app-surface, rgba(0,0,0,0.02)))',
        borderRadius: 10,
        padding: 14,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <strong>About this chart</strong>
        <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={onClose}>Close</button>
      </div>
      {answer.state === 'loading' ? <span>Checking the current Dataset result…</span> : null}
      {answer.state === 'error' ? <div role="alert">{answer.error}</div> : null}
      {answer.state === 'ready' && answer.answer ? (
        <>
          <p style={{ margin: 0, lineHeight: 1.55 }}>{answer.answer.answer}</p>
          <small style={{ color: 'var(--text-secondary, var(--dql-app-text-muted, #64748b))' }}>
            {context?.evidenceScope === 'interaction'
              ? 'Scoped interaction evidence · not publishable'
              : context?.evidenceScope === 'incomplete'
                ? 'Current tile evidence · page preview incomplete'
                : 'Current full-dashboard evidence'}
            {context?.source.label ? ` · ${context.source.label}` : ''}
            {context?.source.trust ? ` · ${context.source.trust}` : ''}
          </small>
          {answer.answer.answerMode === 'deterministic_context_summary' ? (
            <small style={{ color: 'var(--text-secondary, var(--dql-app-text-muted, #64748b))' }}>
              Deterministic context summary · no configured AI provider
            </small>
          ) : null}
        </>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (request && answer.state !== 'loading') onAsk?.(request.question);
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <label style={{ display: 'grid', gap: 4, flex: 1 }}>
          <span className="sr-only">Ask about this chart</span>
          <input
            aria-label="Ask about this chart"
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about this chart"
            disabled={answer.state === 'loading' || !onAsk}
          />
        </label>
        <button
          type="submit"
          className="dql-apps-btn dql-apps-btn-primary"
          disabled={!request || answer.state === 'loading' || !onAsk}
        >
          Ask
        </button>
      </form>
    </section>
  );
}

function isSharedProjectApp(app: AppSummary): boolean {
  if (app.publicationIntent) return app.publicationIntent === 'shared_project';
  if (app.visibility) return app.visibility === 'shared';
  return (app.storage ?? 'shared') === 'shared';
}

function libraryCounts(apps: AppSummary[], drafts: AppStudioBuildDraft[], favorites: Set<string>): Record<LibraryFilter, number> {
  const shared = apps.filter(isSharedProjectApp).length;
  return {
    all: apps.length + drafts.length,
    drafts: drafts.length,
    private: apps.length - shared,
    shared,
    fav: apps.filter((app) => favorites.has(app.id)).length,
  };
}

function primaryOwner(app: AppSummary): string {
  return app.owners?.[0] ?? 'owner@local';
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return Math.abs(hash).toString(16).slice(0, 7).padStart(7, '0');
}

