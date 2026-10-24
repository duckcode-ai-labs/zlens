import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Bot, BookOpenCheck, Check, ChevronDown, ExternalLink, FileText, Loader2, Plus, Play, RefreshCw, Search, Send, SlidersHorizontal, Sparkles, Unlink, X } from 'lucide-react';
import { api, type NotebookResearchAgeFilter, type NotebookResearchContextPreview, type NotebookResearchDiagnostics, type NotebookResearchDqlPromotionAction, type NotebookResearchIntent, type NotebookResearchNextActionFilter as DurableNotebookResearchNextActionFilter, type NotebookResearchReadinessFilter, type NotebookResearchReviewStatus, type NotebookResearchRun, type NotebookResearchSort, type NotebookResearchStatus } from '../../api/client';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { Cell, NotebookFile } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { TableOutput } from '../output/TableOutput';
import {
  emitNotebookResearchChanged,
  notebookResearchSourceCellOption as sourceCellOption,
  notebookResearchSourceCellOptionFromMissingRun as sourceCellOptionFromMissingRun,
  notebookResearchSourceSyncStatus as sourceSyncStatus,
  sourceFingerprintForReviewedSql,
  type NotebookResearchSourceCellOption as SourceCellOption,
  type NotebookResearchSourceSyncStatus as SourceSyncStatus,
} from '../../utils/notebook-research';

interface NotebookResearchPanelProps {
  open: boolean;
  onClose: () => void;
  t: Theme;
  initialSourceCellId?: string;
  initialRequestId?: number;
  initialOpenNextRequestId?: number;
  initialOwnerFilter?: string;
  initialOwnerRequestId?: number;
  onOpenNotebookFile?: (file: NotebookFile) => void;
  onResearchChanged?: (run: NotebookResearchRun) => void;
}

type RunFilter =
  | 'open_work'
  | 'all'
  | 'ready'
  | 'draft'
  | 'error'
  | 'dql_draft'
  | 'draft_ready'
  | 'certification_ready'
  | 'blocked'
  | 'stale_open'
  | 'expired_open'
  | 'completed'
  | 'rejected'
  | 'reuse_existing'
  | 'extend_existing'
  | 'create_replacement'
  | 'create_new';
type ResearchScope = 'notebook' | 'project';
type SourceSyncFilter = 'all' | 'changed' | 'missing' | 'synced' | 'unknown';
type SourceCoverageStatus = 'unresearched' | 'changed' | 'missing' | 'synced' | 'unknown';
type SourceCoverageFilter = 'all' | SourceCoverageStatus;
type ResearchNextActionKind =
  | 'resolve_source'
  | 'fix_blockers'
  | 'review_sql'
  | 'review_context'
  | 'run_preview'
  | 'reuse_existing'
  | 'create_dql_draft'
  | 'open_certification'
  | 'complete_review'
  | 'continue_review';
type ResearchNextActionFilter = 'all' | ResearchNextActionKind;
type DraftResearchIntent = NotebookResearchIntent | 'auto';
type ResearchWorklistItem = {
  id: string;
  title: string;
  detail: string;
  reason: string;
  actionLabel: string;
  statusLabel: string;
  tone: ResearchTone;
  priority: number;
  run?: NotebookResearchRun;
  sourceItem?: SourceCoverageItem;
};
type ResearchFilterChip = {
  id: string;
  label: string;
  onClear: () => void;
};
type ResearchAgeState = {
  label: string;
  detail: string;
  tone: ResearchTone;
  daysOpen: number;
  stale: boolean;
};
type ResearchGateState = {
  label: string;
  detail: string;
  tone: ResearchTone;
  status: 'passed' | 'pending' | 'warning' | 'blocked';
  count: number;
};
type ResearchPattern = {
  id: NotebookResearchIntent;
  label: string;
  dqlTarget: string;
  promptPlaceholder: string;
  focus: string;
};

const RESEARCH_PAGE_SIZE = 25;
const RESEARCH_REGISTER_RUN_LIMIT = 250;
const RESEARCH_COVERAGE_SOURCE_LIMIT = 10_000;
const RESEARCH_WORKLIST_INITIAL_LIMIT = 6;
const RESEARCH_WORKLIST_PAGE_SIZE = 20;
const RESEARCH_COVERAGE_INITIAL_LIMIT = 8;
const RESEARCH_COVERAGE_PAGE_SIZE = 50;
const RESEARCH_REGISTER_CELL_NAME = 'Research Register';
const PORTFOLIO_NOTEBOOK_LIMIT = 6;
const PORTFOLIO_DOMAIN_LIMIT = 8;
const PORTFOLIO_OWNER_LIMIT = 8;
const PORTFOLIO_PATTERN_LIMIT = 6;
const NOTEBOOK_FILTER_DATALIST_ID = 'notebook-research-notebook-filter-options';
const DOMAIN_FILTER_DATALIST_ID = 'notebook-research-domain-filter-options';
const OWNER_FILTER_DATALIST_ID = 'notebook-research-owner-filter-options';
const DEFAULT_RUN_FILTER: RunFilter = 'open_work';
const RESEARCH_PATTERNS: ResearchPattern[] = [
  {
    id: 'ad_hoc_analysis',
    label: 'Ad hoc analysis',
    dqlTarget: 'custom block',
    promptPlaceholder: 'Example: Which players drove scoring changes between 2016 and 2017?',
    focus: 'question, grain, filters, output fields',
  },
  {
    id: 'diagnose_change',
    label: 'Change diagnosis',
    dqlTarget: 'driver or trend block',
    promptPlaceholder: 'Example: Why did scoring change from 2016 to 2017?',
    focus: 'baseline, comparison period, drivers',
  },
  {
    id: 'driver_breakdown',
    label: 'Driver breakdown',
    dqlTarget: 'ranking or contribution block',
    promptPlaceholder: 'Example: Which teams contributed most to the scoring increase?',
    focus: 'metric, contribution, tie-breaker',
  },
  {
    id: 'segment_compare',
    label: 'Segment compare',
    dqlTarget: 'comparison block',
    promptPlaceholder: 'Example: Compare guards and forwards by points and assists.',
    focus: 'segments, shared filters, deltas',
  },
  {
    id: 'entity_drilldown',
    label: 'Entity drilldown',
    dqlTarget: 'entity profile or drilldown block',
    promptPlaceholder: 'Example: Show player-level details behind top scorers.',
    focus: 'entity grain, identifiers, detail columns',
  },
  {
    id: 'anomaly_investigation',
    label: 'Anomaly investigation',
    dqlTarget: 'monitoring or exception block',
    promptPlaceholder: 'Example: Which games look unusual for scoring efficiency?',
    focus: 'expected range, anomaly rule, dimensions',
  },
  {
    id: 'trust_gap_review',
    label: 'Trust review',
    dqlTarget: 'replacement or validation block',
    promptPlaceholder: 'Example: Does this query duplicate or conflict with an existing scoring saved query?',
    focus: 'definitions, duplicates, lineage gaps',
  },
];
const patternTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const EMPTY_COUNTS = {
  total: 0,
  ready: 0,
  needsReview: 0,
  dqlDrafts: 0,
  errors: 0,
  reuseExisting: 0,
  extendExisting: 0,
  replacements: 0,
  createNew: 0,
  draftReady: 0,
  certificationReady: 0,
  blocked: 0,
  staleOpen: 0,
  expiredOpen: 0,
  sourceLinked: 0,
  nextActions: {
    fix_blockers: 0,
    review_sql: 0,
    review_context: 0,
    run_preview: 0,
    reuse_existing: 0,
    create_dql_draft: 0,
    open_certification: 0,
    complete_review: 0,
    continue_review: 0,
  },
};
const EMPTY_GROUP_COUNTS = {
  domains: 0,
  owners: 0,
  intents: 0,
  notebooks: 0,
};

export function NotebookResearchPanel({ open, onClose, t, initialSourceCellId, initialRequestId, initialOpenNextRequestId, initialOwnerFilter, initialOwnerRequestId, onOpenNotebookFile, onResearchChanged }: NotebookResearchPanelProps) {
  const { state, dispatch } = useNotebook();
  const handledInitialRequestRef = React.useRef<number | null>(null);
  const handledOpenNextRequestRef = React.useRef<number | null>(null);
  const handledOwnerRequestRef = React.useRef<number | null>(null);
  const autoQuestionSourceRef = React.useRef<string | null>(null);
  const manualDraftModeRef = React.useRef(false);
  const [runs, setRuns] = useState<NotebookResearchRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunSnapshot, setActiveRunSnapshot] = useState<NotebookResearchRun | null>(null);
  const [pendingNotebookOpenRun, setPendingNotebookOpenRun] = useState<{ runId: string; notebookPath: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [selectedCellId, setSelectedCellId] = useState<string>('');
  const [reviewedSql, setReviewedSql] = useState('');
  const [domain, setDomain] = useState('');
  const [owner, setOwner] = useState('analytics');
  const [draftIntent, setDraftIntent] = useState<DraftResearchIntent>('auto');
  const [runSearch, setRunSearch] = useState('');
  const [runFilter, setRunFilter] = useState<RunFilter>(DEFAULT_RUN_FILTER);
  const [runScope, setRunScope] = useState<ResearchScope>('notebook');
  const [runNotebookFilter, setRunNotebookFilter] = useState('');
  const [runDomainFilter, setRunDomainFilter] = useState('');
  const [runOwnerFilter, setRunOwnerFilter] = useState('');
  const [runIntentFilter, setRunIntentFilter] = useState<NotebookResearchIntent | ''>('');
  const [runSort, setRunSort] = useState<NotebookResearchSort>('priority');
  const [sourceSyncFilter, setSourceSyncFilter] = useState<SourceSyncFilter>('all');
  const [sourceCoverageFilter, setSourceCoverageFilter] = useState<SourceCoverageFilter>('all');
  const [nextActionFilter, setNextActionFilter] = useState<ResearchNextActionFilter>('all');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showPortfolioMapDetails, setShowPortfolioMapDetails] = useState(false);
  const [showSourceCoverageDetails, setShowSourceCoverageDetails] = useState(false);
  const [worklistVisibleLimit, setWorklistVisibleLimit] = useState(RESEARCH_WORKLIST_INITIAL_LIMIT);
  const [runDomains, setRunDomains] = useState<Array<{ domain: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>>([]);
  const [runOwners, setRunOwners] = useState<Array<{ owner: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>>([]);
  const [runIntents, setRunIntents] = useState<Array<{ intent: NotebookResearchIntent; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>>([]);
  const [runNotebooks, setRunNotebooks] = useState<Array<{ path: string; title: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>>([]);
	  const [pageOffset, setPageOffset] = useState(0);
	  const [totalRuns, setTotalRuns] = useState(0);
	  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [groupCounts, setGroupCounts] = useState(EMPTY_GROUP_COUNTS);
	  const [diagnostics, setDiagnostics] = useState<NotebookResearchDiagnostics | null>(null);
  const [draftMode, setDraftMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openingDraft, setOpeningDraft] = useState(false);
  const [checkingReuse, setCheckingReuse] = useState(false);
  const [contextPreview, setContextPreview] = useState<NotebookResearchContextPreview | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverageRuns, setCoverageRuns] = useState<NotebookResearchRun[]>([]);
  const [coverageVisibleLimit, setCoverageVisibleLimit] = useState(RESEARCH_COVERAGE_INITIAL_LIMIT);

  const notebookPath = state.activeFile?.path ?? '';
  const activeRunFromPage = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );
  const activeRun = useMemo(
    () => draftMode ? null : activeRunFromPage ?? (activeRunSnapshot?.id === activeRunId ? activeRunSnapshot : null),
    [activeRunFromPage, activeRunId, activeRunSnapshot, draftMode],
  );
  const sourceCells = useMemo(
    () => state.cells.map(sourceCellOption).filter((option): option is SourceCellOption => Boolean(option)),
    [state.cells],
  );
  const selectedSource = sourceCells.find((cell) => cell.id === selectedCellId) ?? null;
  const effectiveDraftIntent = draftIntent === 'auto' ? inferResearchIntentFromQuestion(question) : draftIntent;
  const selectedResearchPattern = researchPatternForIntent(effectiveDraftIntent);
  const sourceCellById = useMemo(() => new Map(sourceCells.map((cell) => [cell.id, cell])), [sourceCells]);
  const notebookTitleByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const file of state.files) {
      if (file.type !== 'notebook' && file.type !== 'workbook') continue;
      byPath.set(file.path, notebookDisplayName(file.path, file.name));
    }
    for (const item of runNotebooks) {
      if (item.path) byPath.set(item.path, item.title || notebookDisplayName(item.path));
    }
    return byPath;
  }, [runNotebooks, state.files]);
  const coverageRunBySourceId = useMemo(() => {
    const bySource = new Map<string, NotebookResearchRun>();
    for (const run of coverageRuns) {
      if (!run.sourceCellId || bySource.has(run.sourceCellId)) continue;
      bySource.set(run.sourceCellId, run);
    }
    return bySource;
  }, [coverageRuns]);
  const sourceCoverageItems = useMemo(() => {
    const currentCellItems = sourceCells.map((cell): SourceCoverageItem => {
      const run = coverageRunBySourceId.get(cell.id) ?? null;
      const sync = run ? researchSourceSyncForRun(run, sourceCellById, notebookPath) : null;
      const status: SourceCoverageStatus = run ? (sync ?? 'unknown') : 'unresearched';
      return {
        cell,
        run,
        status,
        nextAction: run ? researchNextAction(run, sync) : undefined,
      };
    });
    const missingCellItems = coverageRuns.flatMap((run): SourceCoverageItem[] => {
      if (!run.sourceCellId || sourceCellById.has(run.sourceCellId)) return [];
      const cell = sourceCellOptionFromMissingRun(run);
      const sync = researchSourceSyncForRun(run, sourceCellById, notebookPath);
      return [{
        cell,
        run,
        status: sync ?? 'missing',
        nextAction: researchNextAction(run, sync),
      }];
    });
    return [...currentCellItems, ...missingCellItems]
      .sort((a, b) => sourceCoveragePriority(a) - sourceCoveragePriority(b) || a.cell.name.localeCompare(b.cell.name));
  }, [coverageRunBySourceId, coverageRuns, notebookPath, sourceCellById, sourceCells]);
  const sourceCoverageCounts = useMemo(() => {
    const countsByStatus: Record<SourceCoverageStatus, number> = {
      unresearched: 0,
      changed: 0,
      missing: 0,
      synced: 0,
      unknown: 0,
    };
    for (const item of sourceCoverageItems) {
      countsByStatus[item.status] += 1;
    }
    return countsByStatus;
  }, [sourceCoverageItems]);
  const filteredSourceCoverageItems = useMemo(() => {
    const stateFiltered = sourceCoverageFilter === 'all'
      ? sourceCoverageItems
      : sourceCoverageItems.filter((item) => item.status === sourceCoverageFilter);
    if (!runSearch.trim()) return stateFiltered;
    return stateFiltered.filter((item) => sourceCoverageItemMatchesSearch(item, runSearch));
  }, [runSearch, sourceCoverageFilter, sourceCoverageItems]);
  const currentSourceCoveredCount = useMemo(
    () => sourceCoverageItems.filter((item) => item.run && item.status !== 'missing').length,
    [sourceCoverageItems],
  );
  const sourceSyncCounts = useMemo(() => {
    return runs.reduce((acc, run) => {
      const status = researchSourceSyncForRun(run, sourceCellById, notebookPath);
      if (status === 'changed') acc.changed += 1;
      if (status === 'missing') acc.missing += 1;
      if (status === 'synced') acc.synced += 1;
      if (status === 'unknown') acc.unknown += 1;
      return acc;
    }, { changed: 0, missing: 0, synced: 0, unknown: 0 });
  }, [notebookPath, runs, sourceCellById]);
  const sourceStateCounts = useMemo(
    () => {
      if (runScope !== 'notebook') return sourceSyncCounts;
      return coverageRuns.reduce((acc, run) => {
        const status = researchSourceSyncForRun(run, sourceCellById, notebookPath);
        if (status === 'changed') acc.changed += 1;
        if (status === 'missing') acc.missing += 1;
        if (status === 'synced') acc.synced += 1;
        if (status === 'unknown') acc.unknown += 1;
        return acc;
      }, { changed: 0, missing: 0, synced: 0, unknown: 0 });
    },
    [coverageRuns, notebookPath, runScope, sourceCellById, sourceSyncCounts],
  );
  const localSourceRunListMode = runScope === 'notebook' && sourceSyncFilter !== 'all';
  const sourceFilteredRuns = useMemo(() => {
    const baseRuns = localSourceRunListMode
      ? coverageRuns.filter((run) => researchRunMatchesLocalListFilters(run, {
          runSearch,
          runFilter,
          runNotebookFilter,
          runDomainFilter,
          runOwnerFilter,
          runIntentFilter,
        }))
      : runs;
    const filtered = sourceSyncFilter === 'all'
      ? baseRuns
      : baseRuns.filter((run) => researchSourceSyncForRun(run, sourceCellById, notebookPath) === sourceSyncFilter);
    return localSourceRunListMode
      ? sortNotebookResearchRunsForDisplay(filtered, runSort, sourceCellById)
      : filtered;
  }, [coverageRuns, localSourceRunListMode, notebookPath, runDomainFilter, runFilter, runIntentFilter, runOwnerFilter, runSort, runs, runSearch, sourceCellById, sourceSyncFilter]);
  const localNextActionCounts = useMemo(() => {
    return sourceFilteredRuns.reduce((acc, run) => {
      const action = researchNextAction(run, researchSourceSyncForRun(run, sourceCellById, notebookPath));
      acc[action.kind] = (acc[action.kind] ?? 0) + 1;
      return acc;
    }, {} as Record<ResearchNextActionKind, number>);
  }, [notebookPath, sourceFilteredRuns, sourceCellById]);
  const filteredVisibleRuns = useMemo(() => {
    if (nextActionFilter === 'all' || (!localSourceRunListMode && isDurableNextActionFilter(nextActionFilter))) return sourceFilteredRuns;
    return sourceFilteredRuns.filter((run) => researchNextAction(run, researchSourceSyncForRun(run, sourceCellById, notebookPath)).kind === nextActionFilter);
  }, [localSourceRunListMode, nextActionFilter, notebookPath, sourceFilteredRuns, sourceCellById]);
  const visibleRuns = useMemo(() => (
    localSourceRunListMode
      ? filteredVisibleRuns.slice(pageOffset, pageOffset + RESEARCH_PAGE_SIZE)
      : filteredVisibleRuns
  ), [filteredVisibleRuns, localSourceRunListMode, pageOffset]);
  const pageOffsetForLabel = pageOffset;
  const totalRunsForLabel = localSourceRunListMode ? filteredVisibleRuns.length : totalRuns;
  const pageEnd = localSourceRunListMode
    ? Math.min(pageOffset + visibleRuns.length, totalRunsForLabel)
    : pageOffset + runs.length;
  const nextActionableRun = useMemo(
    () => visibleRuns.find((run) => isActionableResearchRun(run, researchSourceSyncForRun(run, sourceCellById, notebookPath))) ?? null,
    [notebookPath, visibleRuns, sourceCellById],
  );
  const nextCoverageItem = useMemo(
    () => {
      if (nextActionFilter === 'resolve_source' || sourceCoverageFilter === 'changed' || sourceCoverageFilter === 'missing') {
        return filteredSourceCoverageItems.find((item) => item.status === 'changed' || item.status === 'missing') ?? null;
      }
      return filteredSourceCoverageItems.find((item) => !item.run || item.status === 'changed' || item.status === 'missing') ?? null;
    },
    [filteredSourceCoverageItems, nextActionFilter, sourceCoverageFilter],
  );
  const firstVisibleRun = visibleRuns[0] ?? null;
  const activeRunVisible = !activeRun || visibleRuns.some((run) => run.id === activeRun.id);
  const activeRunExternalNotebook = isExternalNotebookRun(activeRun, notebookPath);
  const activeSourceSync = activeRunExternalNotebook ? null : sourceSyncStatus(activeRun, sourceCellById);
  const sourceNeedsResolution = activeSourceSync === 'changed' || activeSourceSync === 'missing';
  const worklistCoverageItems = filteredSourceCoverageItems;
  const worklistItems = useMemo(() => buildResearchWorklist({
    runScope,
    sourceCoverageItems: worklistCoverageItems,
    visibleRuns,
    sourceCellById,
    currentNotebookPath: notebookPath,
    sourceCoverageFilter,
    nextActionFilter,
  }), [nextActionFilter, notebookPath, runScope, sourceCellById, sourceCoverageFilter, visibleRuns, worklistCoverageItems]);

  const fetchRunsPage = useCallback(async () => {
    if (!notebookPath) return null;
    const filter = runFilterRequest(runFilter);
    const durableNextAction = isDurableNextActionFilter(nextActionFilter) ? nextActionFilter : undefined;
    return api.listNotebookResearch({
      path: runNotebookFilter || (runScope === 'notebook' ? notebookPath : undefined),
      domain: runDomainFilter || undefined,
      owner: runOwnerFilter || undefined,
      intent: runIntentFilter || undefined,
      search: runSearch,
      status: filter.status,
      reviewStatus: filter.reviewStatus,
      promotionAction: filter.promotionAction,
      readiness: filter.readiness,
      age: filter.age,
      activeOnly: filter.activeOnly,
      nextAction: durableNextAction,
      sort: runSort,
      limit: RESEARCH_PAGE_SIZE,
      offset: pageOffset,
    });
  }, [nextActionFilter, notebookPath, pageOffset, runDomainFilter, runFilter, runIntentFilter, runNotebookFilter, runOwnerFilter, runScope, runSearch, runSort]);

  const fetchCoverageRuns = useCallback(async () => {
    if (!notebookPath) return [];
    const sourceIds = new Set(sourceCells.map((cell) => cell.id));
	    const coverage = await api.listNotebookResearchSourceCoverage({
	      path: notebookPath,
	      sourceCellIds: Array.from(sourceIds),
	      sourceCells: sourceCells.map((cell) => ({
	        id: cell.id,
	        name: cell.name,
	        type: cell.type,
	        fingerprint: cell.fingerprint,
	      })),
	      limit: RESEARCH_COVERAGE_SOURCE_LIMIT,
	    });
    return coverage.runs;
  }, [notebookPath, sourceCells]);

  const applyRunsPage = useCallback((page: Awaited<ReturnType<typeof api.listNotebookResearch>>, preferredRun?: NotebookResearchRun) => {
    setRuns(page.runs);
    setTotalRuns(page.total);
	    setCounts(page.counts);
    setGroupCounts(page.groupCounts ?? {
      domains: page.domains.length,
      owners: page.owners.length,
      intents: page.intents.length,
      notebooks: page.notebooks.length,
    });
	    setRunDomains(page.domains);
    setRunOwners(page.owners);
    setRunIntents(page.intents);
    setRunNotebooks(page.notebooks);
    if (preferredRun) {
      manualDraftModeRef.current = false;
      setActiveRunId(preferredRun.id);
      setActiveRunSnapshot(preferredRun);
      setDraftMode(false);
      return;
    }
    const matchingActiveRun = activeRunId ? page.runs.find((run) => run.id === activeRunId) : null;
    if (matchingActiveRun) setActiveRunSnapshot(matchingActiveRun);
    if (!activeRunId && draftMode && !manualDraftModeRef.current && page.total === 1 && page.runs.length === 1) {
      setActiveRunId(page.runs[0].id);
      setActiveRunSnapshot(page.runs[0]);
      setDraftMode(false);
      return;
    }
    if (!activeRunId && !draftMode && page.runs[0]) {
      setActiveRunId(page.runs[0].id);
      setActiveRunSnapshot(page.runs[0]);
    }
  }, [activeRunId, draftMode]);

  const loadRuns = useCallback(async () => {
    setError(null);
    try {
      const [page, nextDiagnostics] = await Promise.all([
        fetchRunsPage(),
        api.getNotebookResearchDiagnostics().catch(() => null),
      ]);
      if (page) applyRunsPage(page);
      if (nextDiagnostics) setDiagnostics(nextDiagnostics);
      if (runScope === 'notebook') setCoverageRuns(await fetchCoverageRuns());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyRunsPage, fetchCoverageRuns, fetchRunsPage, runScope]);

  useEffect(() => {
    if (!open) manualDraftModeRef.current = false;
  }, [open]);

  useEffect(() => {
    manualDraftModeRef.current = false;
  }, [notebookPath]);

  useEffect(() => {
    if (!open || !notebookPath) return;
    void loadRuns();
  }, [loadRuns, notebookPath, open]);

  useEffect(() => {
    if (!open || !notebookPath || state.queryLog.length === 0) return;
    void loadRuns();
  }, [loadRuns, notebookPath, open, state.queryLog.length]);

  useEffect(() => {
    if (!open || draftMode || !activeRunId || activeRunFromPage || activeRunSnapshot?.id === activeRunId) return;
    let cancelled = false;
    api.getNotebookResearch(activeRunId)
      .then((run) => {
        if (cancelled) return;
        setActiveRunSnapshot(run);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveRunId(null);
        setActiveRunSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRunFromPage, activeRunId, activeRunSnapshot?.id, draftMode, open]);

  useEffect(() => {
    if (!open || draftMode || !activeRun || activeRunVisible) return;
    setContextPreview(null);
    setError(null);
    setNotice(null);
  }, [activeRun, activeRunVisible, draftMode, open]);

  useEffect(() => {
    if (!open || !pendingNotebookOpenRun || pendingNotebookOpenRun.notebookPath !== notebookPath) return;
    let cancelled = false;
    api.getNotebookResearch(pendingNotebookOpenRun.runId)
      .then((run) => {
        if (cancelled) return;
        manualDraftModeRef.current = false;
        setDraftMode(false);
        setActiveRunId(run.id);
        setActiveRunSnapshot(run);
        setQuestion(run.question ?? '');
        if (run.domain) setDomain(run.domain);
        setOwner(run.owner ?? 'analytics');
        setDraftIntent(run.intent);
        setSelectedCellId(run.sourceCellId ?? '');
        setReviewedSql(run.reviewedSql ?? run.generatedSql ?? '');
        setPendingNotebookOpenRun(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPendingNotebookOpenRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookPath, open, pendingNotebookOpenRun]);

  useEffect(() => {
    setPageOffset(0);
  }, [notebookPath, nextActionFilter, runDomainFilter, runFilter, runIntentFilter, runNotebookFilter, runOwnerFilter, runScope, runSearch, runSort, sourceCoverageFilter, sourceSyncFilter]);

  useEffect(() => {
    setWorklistVisibleLimit(RESEARCH_WORKLIST_INITIAL_LIMIT);
    setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT);
  }, [notebookPath, nextActionFilter, runDomainFilter, runFilter, runIntentFilter, runNotebookFilter, runOwnerFilter, runScope, runSearch, runSort, sourceCoverageFilter, sourceSyncFilter]);

  useEffect(() => {
    if (!open || pageOffset === 0 || totalRunsForLabel === 0 || pageOffset < totalRunsForLabel) return;
    const lastPageOffset = Math.max(0, Math.floor((totalRunsForLabel - 1) / RESEARCH_PAGE_SIZE) * RESEARCH_PAGE_SIZE);
    setPageOffset(lastPageOffset);
  }, [open, pageOffset, totalRunsForLabel]);

  useEffect(() => {
    if (!open) return;
    if (!domain) setDomain(inferDomain(state.activeFile?.path, state.notebookMetadata?.categories));
    if (!selectedCellId && sourceCells[0]) setSelectedCellId(sourceCells[0].id);
  }, [domain, open, selectedCellId, sourceCells, state.activeFile?.path, state.notebookMetadata?.categories]);

  useEffect(() => {
    if (!open || !draftMode || !selectedSource) return;
    if (question.trim()) {
      autoQuestionSourceRef.current = selectedSource.id;
      return;
    }
    if (autoQuestionSourceRef.current === selectedSource.id) return;
    setQuestion(seedQuestionForCell(selectedSource));
    autoQuestionSourceRef.current = selectedSource.id;
  }, [draftMode, open, question, selectedSource]);

  useEffect(() => {
    if (!activeRun) return;
    setQuestion(activeRun.question ?? '');
    if (activeRun.domain) setDomain(activeRun.domain);
    setOwner(activeRun.owner ?? 'analytics');
    setDraftIntent(activeRun.intent);
    setSelectedCellId(activeRun.sourceCellId ?? selectedCellId);
    setReviewedSql(activeRun.reviewedSql ?? activeRun.generatedSql ?? '');
  }, [activeRun, selectedCellId]);

  useEffect(() => {
    if (!open || !notebookPath || !initialSourceCellId || !initialRequestId || handledInitialRequestRef.current === initialRequestId) return;
    const source = sourceCells.find((cell) => cell.id === initialSourceCellId);
    if (!source) return;
    handledInitialRequestRef.current = initialRequestId;
    let cancelled = false;

    const openRunForSource = (existingRun: NotebookResearchRun) => {
      if (cancelled) return;
      manualDraftModeRef.current = false;
      setDraftMode(false);
      setActiveRunId(existingRun.id);
      setActiveRunSnapshot(existingRun);
      setQuestion(existingRun.question ?? seedQuestionForCell(source));
      setDomain(existingRun.domain || domain || inferDomain(state.activeFile?.path, state.notebookMetadata?.categories));
      setOwner((existingRun.owner ?? owner) || 'analytics');
      setDraftIntent(existingRun.intent);
      setSelectedCellId(source.id);
      setReviewedSql(existingRun.reviewedSql ?? existingRun.generatedSql ?? source.sql);
      setNotice(`Opened existing research for ${source.name}.`);
    };
    const startDraftForSource = () => {
      if (cancelled) return;
      manualDraftModeRef.current = true;
      setDraftMode(true);
      setActiveRunId(null);
      setActiveRunSnapshot(null);
      setQuestion(seedQuestionForCell(source));
      setDomain(domain || inferDomain(state.activeFile?.path, state.notebookMetadata?.categories));
      setOwner(owner || 'analytics');
      setDraftIntent('auto');
      setSelectedCellId(source.id);
      setReviewedSql(source.sql);
      setNotice(`Started research from ${source.name}.`);
    };

    setContextPreview(null);
    setError(null);
    const existingVisibleRun = runs.find((run) => run.sourceCellId === initialSourceCellId);
    if (existingVisibleRun) {
      openRunForSource(existingVisibleRun);
      return () => {
        cancelled = true;
      };
    }

    void api.listNotebookResearch({
      path: notebookPath,
      sourceCellId: initialSourceCellId,
      limit: 1,
      sort: 'updated_desc',
    })
      .then((page) => {
        const existingRun = page.runs[0];
        if (existingRun) {
          openRunForSource(existingRun);
        } else {
          startDraftForSource();
        }
      })
      .catch(() => {
        startDraftForSource();
      });

    return () => {
      cancelled = true;
    };
  }, [
    domain,
    initialRequestId,
    initialSourceCellId,
    notebookPath,
    open,
    owner,
    runs,
    sourceCells,
    state.activeFile?.path,
    state.notebookMetadata?.categories,
  ]);

  useEffect(() => {
    if (
      !open
      || !notebookPath
      || !initialOwnerRequestId
      || handledOwnerRequestRef.current === initialOwnerRequestId
    ) {
      return;
    }
    const cleanOwnerFilter = initialOwnerFilter?.trim();
    if (!cleanOwnerFilter) return;
    handledOwnerRequestRef.current = initialOwnerRequestId;
    manualDraftModeRef.current = false;
    setDraftMode(false);
    setActiveRunId(null);
    setActiveRunSnapshot(null);
    setPendingNotebookOpenRun(null);
    setRunSearch('');
    setRunScope('project');
    setRunNotebookFilter('');
    setRunDomainFilter('');
    setRunOwnerFilter(cleanOwnerFilter);
    setRunIntentFilter('');
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setShowAdvancedFilters(true);
    setPageOffset(0);
    setContextPreview(null);
    setError(null);
    setNotice(`Showing research queue for ${cleanOwnerFilter}.`);
  }, [initialOwnerFilter, initialOwnerRequestId, notebookPath, open]);

  const upsertRun = useCallback((run: NotebookResearchRun) => {
    setRuns((current) => {
      const index = current.findIndex((item) => item.id === run.id);
      if (index === -1) return [run, ...current];
      const next = [...current];
      next[index] = run;
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
    setActiveRunId(run.id);
    setActiveRunSnapshot(run);
    manualDraftModeRef.current = false;
    setDraftMode(false);
  }, []);

  const refreshAfterMutation = useCallback(async (run: NotebookResearchRun) => {
    upsertRun(run);
    emitNotebookResearchChanged({
      notebookPath: run.notebookPath,
      sourceCellId: run.sourceCellId,
      runId: run.id,
      reason: 'research_run_changed',
    });
    onResearchChanged?.(run);
    try {
      const [page, nextDiagnostics] = await Promise.all([
        fetchRunsPage(),
        api.getNotebookResearchDiagnostics().catch(() => null),
      ]);
      if (page) applyRunsPage(page, run);
      if (nextDiagnostics) setDiagnostics(nextDiagnostics);
      if (runScope === 'notebook') setCoverageRuns(await fetchCoverageRuns());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyRunsPage, fetchCoverageRuns, fetchRunsPage, onResearchChanged, runScope, upsertRun]);

  const startNewRun = useCallback(() => {
    manualDraftModeRef.current = true;
    setDraftMode(true);
    setActiveRunId(null);
    setActiveRunSnapshot(null);
    setPendingNotebookOpenRun(null);
    setQuestion(selectedSource ? seedQuestionForCell(selectedSource) : '');
    setReviewedSql(selectedSource?.sql ?? '');
    setDraftIntent('auto');
    autoQuestionSourceRef.current = selectedSource?.id ?? null;
    setContextPreview(null);
    setError(null);
    setNotice(null);
  }, [selectedSource]);

  const openFirstVisibleRun = useCallback(() => {
    if (!firstVisibleRun) return;
    manualDraftModeRef.current = false;
    setDraftMode(false);
    setActiveRunId(firstVisibleRun.id);
    setActiveRunSnapshot(firstVisibleRun);
    setError(null);
    setNotice(null);
  }, [firstVisibleRun]);

  const openSourceNotebookForRun = useCallback((run: NotebookResearchRun) => {
    if (!run.notebookPath || run.notebookPath === notebookPath || !onOpenNotebookFile) return;
    const file = state.files.find((item) => item.path === run.notebookPath)
      ?? notebookFileFromPath(run.notebookPath);
    manualDraftModeRef.current = false;
    setDraftMode(false);
    setActiveRunId(run.id);
    setActiveRunSnapshot(run);
    setPendingNotebookOpenRun({ runId: run.id, notebookPath: run.notebookPath });
    setRunScope('notebook');
    setRunNotebookFilter('');
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setContextPreview(null);
    setError(null);
    setNotice(`Opening ${notebookTitleByPath.get(run.notebookPath) ?? notebookDisplayName(run.notebookPath)} for this research item.`);
    onOpenNotebookFile(file);
  }, [notebookPath, notebookTitleByPath, onOpenNotebookFile, state.files]);

  const openResearchRun = useCallback((run: NotebookResearchRun, options: { openNotebook?: boolean } = {}) => {
    manualDraftModeRef.current = false;
    setDraftMode(false);
    setActiveRunId(run.id);
    setActiveRunSnapshot(run);
    setPendingNotebookOpenRun(null);
    setError(null);
    setNotice(null);
    if (options.openNotebook && isExternalNotebookRun(run, notebookPath)) {
      openSourceNotebookForRun(run);
    }
  }, [notebookPath, openSourceNotebookForRun]);

  const openSourceCoverageItem = useCallback(async (item: SourceCoverageItem) => {
    setSelectedCellId(item.cell.id);
    setContextPreview(null);
    setError(null);
    if (item.run) {
      manualDraftModeRef.current = false;
      setDraftMode(false);
      setActiveRunId(item.run.id);
      setActiveRunSnapshot(item.run);
      setQuestion(item.run.question || seedQuestionForCell(item.cell));
      if (item.run.domain) setDomain(item.run.domain);
      setOwner((item.run.owner ?? owner) || 'analytics');
      setDraftIntent(item.run.intent);
      setReviewedSql(item.run.reviewedSql ?? item.run.generatedSql ?? item.cell.sql);
      setNotice(`Opened research for ${item.cell.name}.`);
      return;
    }
    if (!notebookPath) return;
    const seededQuestion = seedQuestionForCell(item.cell);
    const seededDomain = domain || inferDomain(state.activeFile?.path, state.notebookMetadata?.categories);
    setBusy(true);
    setQuestion(seededQuestion);
    setReviewedSql(item.cell.sql);
    setDraftIntent('auto');
    setDomain(seededDomain);
    autoQuestionSourceRef.current = item.cell.id;
    try {
      const run = await api.createNotebookResearch({
        notebookPath,
        domain: seededDomain || undefined,
        owner: owner || undefined,
        sourceCellId: item.cell.id,
        sourceCellName: item.cell.name,
        sourceCellFingerprint: item.cell.fingerprint,
        title: item.cell.name,
        question: seededQuestion,
        intent: inferResearchIntentFromQuestion(seededQuestion),
        context: {
          notebookTitle: state.notebookTitle,
          sourceCell: { id: item.cell.id, name: item.cell.name, type: item.cell.type },
          selectedDomain: seededDomain || undefined,
          selectedOwner: owner || undefined,
          seededFromNotebook: true,
        },
        generatedSql: item.cell.sql,
        reviewedSql: item.cell.sql,
      });
      await refreshAfterMutation(run);
      setNotice(`Created research draft from ${item.cell.name}.`);
    } catch (err) {
      setDraftMode(true);
      manualDraftModeRef.current = true;
      setActiveRunId(null);
      setActiveRunSnapshot(null);
      setError(err instanceof Error ? err.message : String(err));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }, [domain, notebookPath, owner, refreshAfterMutation, state.activeFile?.path, state.notebookMetadata?.categories, state.notebookTitle]);

  const openNextActionableRun = useCallback(() => {
    if (sourceCoverageFilter === 'unresearched' && nextCoverageItem) {
      void openSourceCoverageItem(nextCoverageItem);
      return;
    }
    if (nextActionableRun) {
      openResearchRun(nextActionableRun, { openNotebook: true });
      return;
    }
    if (nextCoverageItem) void openSourceCoverageItem(nextCoverageItem);
  }, [nextActionableRun, nextCoverageItem, openResearchRun, openSourceCoverageItem, sourceCoverageFilter]);

  const openNextExistingRun = useCallback(() => {
    const run = nextActionableRun ?? firstVisibleRun;
    if (!run) return;
    openResearchRun(run, { openNotebook: true });
  }, [firstVisibleRun, nextActionableRun, openResearchRun]);

  useEffect(() => {
    if (
      !open
      || !notebookPath
      || !initialOpenNextRequestId
      || handledOpenNextRequestRef.current === initialOpenNextRequestId
    ) {
      return;
    }
    if (!visibleRuns.length) return;
    handledOpenNextRequestRef.current = initialOpenNextRequestId;
    openNextExistingRun();
  }, [
    firstVisibleRun,
    initialOpenNextRequestId,
    notebookPath,
    open,
    openNextExistingRun,
    visibleRuns.length,
  ]);

  const clearQueueFilters = useCallback(() => {
    setRunSearch('');
    setRunFilter(DEFAULT_RUN_FILTER);
    setRunNotebookFilter('');
    setRunDomainFilter('');
    setRunOwnerFilter('');
    setRunIntentFilter('');
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const showSelectedRunInQueue = useCallback(() => {
    if (!activeRun) return;
    const selectedNotebookPath = activeRun.notebookPath;
    const inCurrentNotebook = Boolean(selectedNotebookPath && selectedNotebookPath === notebookPath);
    setRunSearch('');
    setRunFilter(isClosedResearchRun(activeRun) ? 'all' : DEFAULT_RUN_FILTER);
    setRunScope(inCurrentNotebook ? 'notebook' : 'project');
    setRunNotebookFilter(inCurrentNotebook ? '' : selectedNotebookPath || '');
    setRunDomainFilter('');
    setRunOwnerFilter('');
    setRunIntentFilter('');
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice('Showing the selected research item in the queue.');
  }, [activeRun, notebookPath]);

  const selectQueueAction = useCallback((kind: ResearchNextActionFilter) => {
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setNextActionFilter(kind);
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectSummaryFilter = useCallback((filter: RunFilter) => {
    setRunFilter(filter);
    setSourceSyncFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectPortfolioDomain = useCallback((domainName: string) => {
    setRunSearch('');
    setRunNotebookFilter('');
    setRunOwnerFilter('');
    setRunDomainFilter((current) => current === domainName ? '' : domainName);
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectPortfolioOwner = useCallback((ownerName: string) => {
    setRunSearch('');
    setRunNotebookFilter('');
    setRunDomainFilter('');
    setRunOwnerFilter((current) => current === ownerName ? '' : ownerName);
    setRunIntentFilter('');
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectPortfolioIntent = useCallback((intent: NotebookResearchIntent) => {
    setRunSearch('');
    setRunNotebookFilter('');
    setRunOwnerFilter('');
    setRunIntentFilter((current) => current === intent ? '' : intent);
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectPortfolioNotebook = useCallback((path: string) => {
    setRunSearch('');
    setRunScope('project');
    setRunNotebookFilter((current) => current === path ? '' : path);
    setRunDomainFilter('');
    setRunOwnerFilter('');
    setRunIntentFilter('');
    setRunFilter(DEFAULT_RUN_FILTER);
    setSourceSyncFilter('all');
    setSourceCoverageFilter('all');
    setNextActionFilter('all');
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const selectSourceCoverageFilter = useCallback((filter: SourceCoverageFilter) => {
    setSourceCoverageFilter(filter);
    if (filter === 'changed' || filter === 'missing' || filter === 'synced' || filter === 'unknown') {
      setSourceSyncFilter(filter);
    } else {
      setSourceSyncFilter('all');
    }
    if (filter === 'unresearched') {
      const firstNewSource = sourceCoverageItems.find((item) => item.status === 'unresearched' && !item.run);
      if (firstNewSource) {
        manualDraftModeRef.current = true;
        setDraftMode(true);
        setActiveRunId(null);
        setActiveRunSnapshot(null);
        setSelectedCellId(firstNewSource.cell.id);
        setQuestion(seedQuestionForCell(firstNewSource.cell));
        setReviewedSql(firstNewSource.cell.sql);
        setDraftIntent('auto');
        autoQuestionSourceRef.current = firstNewSource.cell.id;
        setContextPreview(null);
      }
    }
    setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT);
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, [sourceCoverageItems]);

  const selectSourceSyncFilter = useCallback((filter: SourceSyncFilter) => {
    setSourceSyncFilter(filter);
    if (filter === 'changed' || filter === 'missing' || filter === 'synced' || filter === 'unknown') {
      setSourceCoverageFilter(filter);
      setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT);
    } else {
      setSourceCoverageFilter('all');
    }
    setPageOffset(0);
    setError(null);
    setNotice(null);
  }, []);

  const seedResearchFromCells = useCallback(async () => {
    if (!notebookPath) return;
    if (sourceCells.length === 0) {
      setError('This notebook does not have SQL or DQL source cells to seed.');
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const seeded = await api.seedNotebookResearchFromCells({
        notebookPath,
        domain: domain || undefined,
        owner: owner || undefined,
        notebookTitle: state.notebookTitle,
        cells: sourceCells.map((cell) => ({
          id: cell.id,
          name: cell.name,
          type: cell.type,
          sql: cell.sql,
          sourceCellFingerprint: cell.fingerprint,
          question: seedQuestionForCell(cell),
        })),
      });
      if (seeded.createdCount === 0) {
        setNotice(`All ${sourceCells.length.toLocaleString()} source cell${sourceCells.length === 1 ? '' : 's'} already have research runs.`);
        return;
      }
      const limitNote = seeded.limitApplied ? ' The first 1,000 cells were processed.' : '';
      setNotice(`Created ${seeded.createdCount.toLocaleString()} research draft${seeded.createdCount === 1 ? '' : 's'} from notebook source cells. ${seeded.skippedCount.toLocaleString()} skipped.${limitNote}`);
      if (seeded.created[0]) {
        await refreshAfterMutation(seeded.created[0]);
      } else {
        await loadRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [domain, loadRuns, notebookPath, owner, refreshAfterMutation, sourceCells, state.notebookTitle]);

  const previewContext = useCallback(async () => {
    if (!notebookPath) return;
    const source = selectedSource;
    const cleanQuestion = researchQuestionFromInput(question, source);
    if (!cleanQuestion) {
      setError('Enter a research question before previewing context.');
      setNotice(null);
      return;
    }
    if (!question.trim()) setQuestion(cleanQuestion);
    setContextLoading(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await api.previewNotebookResearchContext({
        notebookPath,
        domain: domain || undefined,
        sourceCellId: source?.id,
        sourceCellName: source?.name,
        question: cleanQuestion,
        intent: effectiveDraftIntent,
        context: {
          notebookTitle: state.notebookTitle,
          sourceCell: source ? { id: source.id, name: source.name, type: source.type } : undefined,
          selectedDomain: domain || undefined,
          selectedOwner: owner || undefined,
          selectedIntent: effectiveDraftIntent,
          researchPattern: researchPatternContext(selectedResearchPattern),
        },
      });
      setContextPreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setContextPreview(null);
    } finally {
      setContextLoading(false);
    }
  }, [domain, effectiveDraftIntent, notebookPath, owner, question, selectedResearchPattern, selectedSource, state.notebookTitle]);

  const saveContextEvidence = useCallback(async () => {
    if (!notebookPath || !contextPreview) return;
    const source = selectedSource;
    const cleanQuestion = researchQuestionFromInput(question, source);
    if (!cleanQuestion) {
      setError('Enter a research question before saving evidence.');
      setNotice(null);
      return;
    }
    if (!question.trim()) setQuestion(cleanQuestion);
    const context = {
      notebookTitle: state.notebookTitle,
      sourceCell: source ? { id: source.id, name: source.name, type: source.type } : undefined,
      selectedDomain: domain || undefined,
      selectedOwner: owner || undefined,
      selectedIntent: effectiveDraftIntent,
      researchPattern: researchPatternContext(selectedResearchPattern),
      contextPreviewSavedAt: new Date().toISOString(),
    };
    const evidence = contextPreviewEvidencePayload(contextPreview);
    const previewWarnings = uniqueStrings([
      ...contextPreview.warnings,
      ...contextPreview.missingContext.map((item) => `${item.kind}: ${item.message}`),
    ]);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const target = activeRun && !draftMode
        ? activeRun
        : await api.createNotebookResearch({
            notebookPath,
            domain: domain || undefined,
            owner: owner || undefined,
            sourceCellId: source?.id,
            sourceCellName: source?.name,
            sourceCellFingerprint: source?.fingerprint,
            question: cleanQuestion,
            intent: effectiveDraftIntent,
            context,
            generatedSql: source?.sql,
          });
      const run = await api.updateNotebookResearch(target.id, {
        question: cleanQuestion,
        domain: domain || undefined,
        owner: owner || undefined,
        intent: effectiveDraftIntent,
        context,
        sourceCellId: source?.id,
        sourceCellName: source?.name,
        sourceCellFingerprint: source?.fingerprint,
        evidence,
        contextPackId: contextPreview.contextPackId,
        routeDecision: contextPreview.routeDecision,
        warnings: uniqueStrings([...(target.warnings ?? []), ...previewWarnings]),
      });
      await refreshAfterMutation(run);
      setNotice('Context preview saved as review evidence.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, contextPreview, domain, draftMode, effectiveDraftIntent, notebookPath, owner, question, refreshAfterMutation, selectedResearchPattern, selectedSource, state.notebookTitle]);

  const runResearch = useCallback(async () => {
    if (!notebookPath) return;
    if (activeRun && !draftMode && sourceNeedsResolution) {
      setError(activeSourceSync === 'changed'
        ? 'Resolve the changed source cell before rerunning. Sync from the cell or use the reviewed SQL as standalone evidence.'
        : 'Resolve the missing source cell before rerunning. Use the reviewed SQL as standalone evidence if it is still valid.');
      setNotice(null);
      return;
    }
    const source = selectedSource;
    const cleanQuestion = researchQuestionFromInput(question, source);
    if (!cleanQuestion) {
      setError('Enter a research question first.');
      return;
    }
    if (!question.trim()) setQuestion(cleanQuestion);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const context = {
        notebookTitle: state.notebookTitle,
        sourceCell: source ? { id: source.id, name: source.name, type: source.type } : undefined,
        selectedDomain: domain || undefined,
        selectedOwner: owner || undefined,
        selectedIntent: effectiveDraftIntent,
        researchPattern: researchPatternContext(selectedResearchPattern),
      };
      const payload = {
        notebookPath,
        domain: domain || undefined,
        owner: owner || undefined,
        sourceCellFingerprint: sourceFingerprintForReviewedSql(source, reviewedSql.trim() || source?.sql),
        sourceCellId: source?.id,
        sourceCellName: source?.name,
        question: cleanQuestion,
        intent: draftIntent === 'auto' ? undefined : draftIntent,
        context,
        generatedSql: reviewedSql.trim() || source?.sql,
        reviewedSql: reviewedSql.trim() || undefined,
      };
      const run = activeRun && !draftMode
        ? await api.runNotebookResearch(activeRun.id, payload)
        : await api.createNotebookResearch({ ...payload, run: true });
      await refreshAfterMutation(run);
      setReviewedSql(run.reviewedSql ?? run.generatedSql ?? reviewedSql);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, activeSourceSync, domain, draftIntent, draftMode, effectiveDraftIntent, notebookPath, owner, question, refreshAfterMutation, reviewedSql, selectedResearchPattern, selectedSource, sourceNeedsResolution, state.notebookTitle]);

  const saveEdits = useCallback(async () => {
    if (!activeRun) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await api.updateNotebookResearch(activeRun.id, {
        question: question.trim(),
        domain: domain || undefined,
        owner: owner || undefined,
        intent: effectiveDraftIntent,
        sourceCellId: selectedSource?.id,
        sourceCellName: selectedSource?.name,
        sourceCellFingerprint: sourceFingerprintForReviewedSql(selectedSource, reviewedSql.trim()),
        reviewedSql: reviewedSql.trim(),
      });
      await refreshAfterMutation(run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, domain, effectiveDraftIntent, owner, question, refreshAfterMutation, reviewedSql, selectedSource]);

  const promoteToDql = useCallback(async () => {
    if (!activeRun) return;
    if (sourceNeedsResolution) {
      setError(activeSourceSync === 'changed'
        ? 'Resolve the changed source cell before creating a DQL draft. Sync from the cell or use the reviewed SQL as standalone evidence.'
        : 'Resolve the missing source cell before creating a DQL draft. Use the reviewed SQL as standalone evidence if it is still valid.');
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = reviewedSql.trim()
        ? await api.updateNotebookResearch(activeRun.id, {
            question: question.trim(),
            domain: domain || undefined,
            owner: owner || undefined,
            intent: effectiveDraftIntent,
            sourceCellId: selectedSource?.id,
            sourceCellName: selectedSource?.name,
            sourceCellFingerprint: sourceFingerprintForReviewedSql(selectedSource, reviewedSql.trim()),
            reviewedSql: reviewedSql.trim(),
          })
        : activeRun;
      const promoted = await api.promoteNotebookResearchToDql(saved.id, {
        domain: domain || undefined,
        owner: owner || undefined,
        tags: ['notebook', 'research', effectiveDraftIntent],
      });
      await refreshAfterMutation(promoted.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, activeSourceSync, domain, effectiveDraftIntent, owner, question, refreshAfterMutation, reviewedSql, selectedSource, sourceNeedsResolution]);

  const checkDqlReuse = useCallback(async () => {
    if (!activeRun) return;
    if (!reviewedSql.trim() && !activeRun.reviewedSql?.trim() && !activeRun.generatedSql?.trim()) {
      setError('Reviewed SQL is required before checking for reusable saved queries.');
      setNotice(null);
      return;
    }
    setCheckingReuse(true);
    setError(null);
    setNotice(null);
    try {
      const saved = reviewedSql.trim()
        ? await api.updateNotebookResearch(activeRun.id, {
            question: question.trim(),
            domain: domain || undefined,
            owner: owner || undefined,
            intent: effectiveDraftIntent,
            sourceCellId: selectedSource?.id,
            sourceCellName: selectedSource?.name,
            sourceCellFingerprint: sourceFingerprintForReviewedSql(selectedSource, reviewedSql.trim()),
            reviewedSql: reviewedSql.trim(),
          })
        : activeRun;
      const checked = await api.checkNotebookResearchReuse(saved.id, {
        domain: domain || undefined,
        owner: owner || undefined,
      });
      await refreshAfterMutation(checked.run);
      const action = checked.promotion.recommendedAction;
      const topMatch = checked.promotion.similarityMatches[0];
      if (action === 'reuse_existing' && topMatch) {
        setNotice(`Reuse recommended: ${topMatch.name} (${Math.round(topMatch.score * 100)}% match).`);
      } else if (action === 'extend_existing' && topMatch) {
        setNotice(`Extension review recommended: ${topMatch.name} (${Math.round(topMatch.score * 100)}% match).`);
      } else if (action === 'create_replacement' && topMatch) {
        setNotice(`Replacement review recommended: ${topMatch.name} (${Math.round(topMatch.score * 100)}% match).`);
      } else {
        setNotice('Reuse check complete. No existing saved query was recommended for reuse.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingReuse(false);
    }
  }, [activeRun, domain, effectiveDraftIntent, owner, question, refreshAfterMutation, reviewedSql, selectedSource]);

  const openDqlDraft = useCallback(async () => {
    const path = activeRun?.draftBlockPath;
    if (!path) return;
    setOpeningDraft(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await api.openBlockStudio(path);
      const file: NotebookFile = {
        name: path.split('/').pop() ?? path,
        path,
        type: 'block',
        folder: 'blocks',
      };
      if (!state.files.some((existing) => existing.path === path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningDraft(false);
    }
  }, [activeRun?.draftBlockPath, dispatch, state.files]);

  const insertSqlCell = useCallback(() => {
    const sql = reviewedSql.trim() || activeRun?.reviewedSql || activeRun?.generatedSql || '';
    if (!sql.trim()) return;
    const cell = makeCell('sql', sql);
    cell.name = slugName(activeRun?.title || question || 'research_sql');
    dispatch({ type: 'ADD_CELL', cell, afterId: activeRun?.sourceCellId });
  }, [activeRun, dispatch, question, reviewedSql]);

  const insertNoteCell = useCallback(() => {
    if (!activeRun) return;
    const cell = makeCell('markdown', researchNoteMarkdown(activeRun, activeSourceSync));
    dispatch({ type: 'ADD_CELL', cell, afterId: activeRun.sourceCellId });
  }, [activeRun, activeSourceSync, dispatch]);

  const insertResearchRegisterCell = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let registerRuns = runs;
      let registerTotal = totalRuns;
      let registerLimitCaveat = '';
      if (localSourceRunListMode) {
        registerRuns = coverageRuns
          .filter((run) => researchRunMatchesLocalListFilters(run, {
            runSearch,
            runFilter,
            runNotebookFilter,
            runDomainFilter,
            runOwnerFilter,
            runIntentFilter,
          }))
          .filter((run) => researchSourceSyncForRun(run, sourceCellById, notebookPath) === sourceSyncFilter);
        if (nextActionFilter !== 'all') {
          registerRuns = registerRuns.filter((run) => researchNextAction(run, researchSourceSyncForRun(run, sourceCellById, notebookPath)).kind === nextActionFilter);
        }
        registerRuns = sortNotebookResearchRunsForDisplay(registerRuns, runSort, sourceCellById);
        registerTotal = registerRuns.length;
      } else if (notebookPath) {
        const filter = runFilterRequest(runFilter);
        const durableNextAction = isDurableNextActionFilter(nextActionFilter) ? nextActionFilter : undefined;
	        const page = await api.listNotebookResearch({
          path: runNotebookFilter || (runScope === 'notebook' ? notebookPath : undefined),
          domain: runDomainFilter || undefined,
          owner: runOwnerFilter || undefined,
          intent: runIntentFilter || undefined,
          search: runSearch,
          status: filter.status,
          reviewStatus: filter.reviewStatus,
          promotionAction: filter.promotionAction,
          readiness: filter.readiness,
          age: filter.age,
          activeOnly: filter.activeOnly,
          nextAction: durableNextAction,
          sort: runSort,
          limit: RESEARCH_REGISTER_RUN_LIMIT,
          offset: 0,
        });
        registerRuns = page.runs;
        registerTotal = page.total;
        const locallyFiltered = sourceSyncFilter !== 'all' || (nextActionFilter !== 'all' && !isDurableNextActionFilter(nextActionFilter));
        if (locallyFiltered && page.total > RESEARCH_REGISTER_RUN_LIMIT) {
          registerLimitCaveat = `Source-state filters were applied after fetching the first ${RESEARCH_REGISTER_RUN_LIMIT.toLocaleString()} matching runs. Clear source filters for an exhaustive project-level register.`;
        }
        if (sourceSyncFilter !== 'all') {
          registerRuns = registerRuns.filter((run) => researchSourceSyncForRun(run, sourceCellById, notebookPath) === sourceSyncFilter);
          registerTotal = registerRuns.length;
        }
        if (nextActionFilter !== 'all' && !isDurableNextActionFilter(nextActionFilter)) {
          registerRuns = registerRuns.filter((run) => researchNextAction(run, researchSourceSyncForRun(run, sourceCellById, notebookPath)).kind === nextActionFilter);
          registerTotal = registerRuns.length;
        }
      }
      const registerNotebookOptions = runNotebooks.filter((item) => item.path && item.total > 0);
      const registerDomainOptions = runDomains.filter((item) => item.domain && item.total > 0);
      const registerOwnerOptions = runOwners.filter((item) => item.owner && item.total > 0);
      const registerIntentOptions = runIntents.filter((item) => item.intent && item.total > 0);
      const registerPortfolioNotebooks = sortNotebookPortfolioGroups(registerNotebookOptions).slice(0, PORTFOLIO_NOTEBOOK_LIMIT);
      const registerPortfolioDomains = sortDomainPortfolioGroups(registerDomainOptions).slice(0, PORTFOLIO_DOMAIN_LIMIT);
      const registerPortfolioOwners = sortOwnerPortfolioGroups(registerOwnerOptions).slice(0, PORTFOLIO_OWNER_LIMIT);
      const registerPortfolioIntents = sortIntentPortfolioGroups(registerIntentOptions).slice(0, PORTFOLIO_PATTERN_LIMIT);
      const registerDiagnostics = await api.getNotebookResearchDiagnostics().catch(() => diagnostics);
	      if (registerDiagnostics) setDiagnostics(registerDiagnostics);
	      const registerMarkdown = researchRegisterMarkdown({
        notebookTitle: state.notebookTitle,
        notebookPath,
        counts,
        diagnostics: registerDiagnostics,
        sourceCellCount: sourceCells.length,
        currentSourceCoveredCount,
	        coverageItems: filteredSourceCoverageItems,
        portfolio: {
          notebooks: registerPortfolioNotebooks,
          domains: registerPortfolioDomains,
          owners: registerPortfolioOwners,
          intents: registerPortfolioIntents,
          groupCounts: {
            notebooks: Math.max(groupCounts.notebooks, registerNotebookOptions.length),
            domains: Math.max(groupCounts.domains, registerDomainOptions.length),
            owners: Math.max(groupCounts.owners, registerOwnerOptions.length),
            intents: Math.max(groupCounts.intents, registerIntentOptions.length),
          },
        },
	        runs: registerRuns,
        totalRuns: registerTotal,
        runLimit: RESEARCH_REGISTER_RUN_LIMIT,
        limitCaveat: registerLimitCaveat,
        filterSummary: researchRegisterFilterSummary({
          runScope,
          runSearch,
          runFilter,
          runNotebookFilter,
          runDomainFilter,
          runOwnerFilter,
          runIntentFilter,
          runSort,
          sourceSyncFilter,
          sourceCoverageFilter,
          nextActionFilter,
        }),
        worklistItems,
      });
      const existingRegister = state.cells.find(isResearchRegisterCell);
      if (existingRegister) {
        dispatch({ type: 'UPDATE_CELL', id: existingRegister.id, updates: { content: registerMarkdown, name: RESEARCH_REGISTER_CELL_NAME } });
        setNotice(`Updated notebook research register with ${registerRuns.length.toLocaleString()} run${registerRuns.length === 1 ? '' : 's'}.`);
      } else {
        const cell = makeCell('markdown', registerMarkdown);
        cell.name = RESEARCH_REGISTER_CELL_NAME;
        dispatch({ type: 'ADD_CELL', cell, afterId: activeRun?.sourceCellId });
        setNotice(`Inserted notebook research register with ${registerRuns.length.toLocaleString()} run${registerRuns.length === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    activeRun?.sourceCellId,
    counts,
    coverageRuns,
    currentSourceCoveredCount,
    diagnostics,
    dispatch,
    localSourceRunListMode,
    nextActionFilter,
    notebookPath,
    runDomainFilter,
    runFilter,
    runIntentFilter,
    runNotebookFilter,
    runOwnerFilter,
    runScope,
    runSearch,
    runSort,
    runs,
    sourceCellById,
    sourceCells.length,
    filteredSourceCoverageItems,
    groupCounts,
    sourceCoverageFilter,
    sourceSyncFilter,
    runDomains,
    runIntents,
    runOwners,
    runNotebooks,
    state.notebookTitle,
    state.cells,
    totalRuns,
    worklistItems,
  ]);

  const handleSourceChange = useCallback((value: string) => {
    setSelectedCellId(value);
    setContextPreview(null);
    autoQuestionSourceRef.current = null;
    if (!draftMode || reviewedSql.trim()) return;
    const source = sourceCells.find((cell) => cell.id === value);
    if (source) {
      setReviewedSql(source.sql);
      setQuestion(seedQuestionForCell(source));
      autoQuestionSourceRef.current = source.id;
    }
  }, [draftMode, reviewedSql, sourceCells]);

  const syncSourceFromCell = useCallback(async () => {
    if (!activeRun?.sourceCellId) return;
    const source = sourceCellById.get(activeRun.sourceCellId);
    if (!source) {
      setError('The source cell for this research run is no longer in the notebook.');
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await api.updateNotebookResearch(activeRun.id, {
        domain: domain || undefined,
        owner: owner || undefined,
        sourceCellId: source.id,
        sourceCellName: source.name,
        sourceCellFingerprint: source.fingerprint,
        generatedSql: source.sql,
        reviewedSql: source.sql,
      });
      await refreshAfterMutation(run);
      setReviewedSql(source.sql);
      setNotice('Synced reviewed SQL from the current notebook source cell.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, domain, owner, refreshAfterMutation, sourceCellById]);

  const useReviewedSqlStandalone = useCallback(async () => {
    if (!activeRun) return;
    const cleanSql = reviewedSql.trim();
    if (!cleanSql) {
      setError('Reviewed SQL is required before detaching from the source cell.');
      setNotice(null);
      return;
    }
    const sourceLabel = activeRun.sourceCellName ? ` "${activeRun.sourceCellName}"` : '';
    const standaloneWarning = activeSourceSync === 'missing'
      ? `Reviewed SQL was kept as standalone evidence because source cell${sourceLabel} is missing from the notebook.`
      : `Reviewed SQL was kept as standalone evidence instead of syncing changed source cell${sourceLabel}.`;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await api.updateNotebookResearch(activeRun.id, {
        question: question.trim(),
        domain: domain || undefined,
        owner: owner || undefined,
        sourceCellId: null,
        sourceCellName: null,
        sourceCellFingerprint: null,
        reviewedSql: cleanSql,
        warnings: uniqueStrings([...(activeRun.warnings ?? []), standaloneWarning]),
      });
      await refreshAfterMutation(run);
      setSelectedCellId('');
      setReviewedSql(cleanSql);
      setNotice('Reviewed SQL is now standalone evidence for this research run.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, activeSourceSync, domain, owner, question, refreshAfterMutation, reviewedSql]);

  const updateResearchReviewStatus = useCallback(async (
    reviewStatus: NotebookResearchReviewStatus,
    noticeText: string,
    warning?: string,
    recommendation?: string,
  ) => {
    if (!activeRun) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await api.updateNotebookResearch(activeRun.id, {
        domain: domain || undefined,
        owner: owner || undefined,
        reviewStatus,
        warnings: warning ? uniqueStrings([...(activeRun.warnings ?? []), warning]) : activeRun.warnings,
        recommendation,
      });
      await refreshAfterMutation(run);
      setNotice(noticeText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeRun, domain, owner, refreshAfterMutation]);

  const activeNextAction = activeRun ? researchNextAction(activeRun, activeSourceSync) : null;
  const activeSourceTrust = activeRun ? sourceTrustSummary(activeRun, activeSourceSync) : null;
  const performActiveNextAction = useCallback(() => {
    if (!activeRun || !activeNextAction) return;
    switch (activeNextAction.kind) {
      case 'resolve_source':
        if (activeSourceSync === 'changed') {
          void syncSourceFromCell();
        } else {
          void useReviewedSqlStandalone();
        }
        return;
      case 'review_sql':
        void saveEdits();
        return;
      case 'review_context':
        if (contextPreview) {
          void saveContextEvidence();
        } else {
          void previewContext();
        }
        return;
      case 'fix_blockers':
      case 'run_preview':
        void runResearch();
        return;
      case 'create_dql_draft':
        void promoteToDql();
        return;
      case 'open_certification':
      case 'complete_review':
        if (activeRun.draftBlockPath) {
          void openDqlDraft();
        } else {
          insertNoteCell();
        }
        return;
      case 'reuse_existing':
        void updateResearchReviewStatus(
          'completed',
          'Reuse decision completed and removed from active review.',
          undefined,
          'Reviewer closed this research run after accepting the reuse decision.',
        );
        return;
      case 'continue_review':
      default:
        insertNoteCell();
    }
  }, [
    activeNextAction,
    activeRun,
    activeSourceSync,
    contextPreview,
    insertNoteCell,
    openDqlDraft,
    previewContext,
    promoteToDql,
    runResearch,
    saveContextEvidence,
    saveEdits,
    syncSourceFromCell,
    updateResearchReviewStatus,
    useReviewedSqlStandalone,
  ]);
  const openWorklistItem = useCallback((item: ResearchWorklistItem) => {
    if (item.sourceItem) {
      void openSourceCoverageItem(item.sourceItem);
      return;
    }
    if (!item.run) return;
    openResearchRun(item.run, { openNotebook: true });
  }, [openResearchRun, openSourceCoverageItem]);

  if (!open) return null;

  const evidenceItems = selectedEvidence(activeRun);
  const activeTitle = activeRun?.title ?? 'New research';
  const currentIntentLabel = activeRun ? formatResearchIntent(activeRun.intent) : 'Draft';
  const dqlPromotion = activeRun?.dqlPromotion;
  const promotionCandidate = dqlPromotion?.candidates[0];
  const promotionMatches = dqlPromotion?.similarityMatches ?? promotionCandidate?.similarityMatches ?? [];
	  const reviewChecklist = activeRun?.reviewChecklist;
	  const domainOptions = runDomains.filter((item) => item.domain && item.total > 0);
	  const ownerOptions = runOwners.filter((item) => item.owner && item.total > 0);
	  const intentOptions = runIntents.filter((item) => item.intent && item.total > 0);
	  const notebookOptions = runNotebooks.filter((item) => item.path && item.total > 0);
	  const portfolioNotebooks = sortNotebookPortfolioGroups(notebookOptions).slice(0, PORTFOLIO_NOTEBOOK_LIMIT);
	  const portfolioDomains = sortDomainPortfolioGroups(domainOptions).slice(0, PORTFOLIO_DOMAIN_LIMIT);
	  const portfolioOwners = sortOwnerPortfolioGroups(ownerOptions).slice(0, PORTFOLIO_OWNER_LIMIT);
	  const portfolioIntents = sortIntentPortfolioGroups(intentOptions).slice(0, PORTFOLIO_PATTERN_LIMIT);
  const portfolioNotebookGroupCount = Math.max(groupCounts.notebooks, notebookOptions.length);
  const portfolioDomainGroupCount = Math.max(groupCounts.domains, domainOptions.length);
  const portfolioOwnerGroupCount = Math.max(groupCounts.owners, ownerOptions.length);
  const portfolioIntentGroupCount = Math.max(groupCounts.intents, intentOptions.length);
	  const hiddenPortfolioNotebookCount = Math.max(0, portfolioNotebookGroupCount - portfolioNotebooks.length);
	  const hiddenPortfolioDomainCount = Math.max(0, portfolioDomainGroupCount - portfolioDomains.length);
	  const hiddenPortfolioOwnerCount = Math.max(0, portfolioOwnerGroupCount - portfolioOwners.length);
	  const hiddenPortfolioIntentCount = Math.max(0, portfolioIntentGroupCount - portfolioIntents.length);
  const showPortfolioMap = counts.total > 0 && (portfolioNotebooks.length > 0 || portfolioDomains.length > 0 || portfolioOwners.length > 0 || portfolioIntents.length > 0);
  const activeRunNotebookTitle = activeRun?.notebookPath
    ? notebookTitleByPath.get(activeRun.notebookPath) ?? notebookDisplayName(activeRun.notebookPath)
    : '';
  const researchDisabled = busy || activeRunExternalNotebook || (Boolean(activeRun && !draftMode) && sourceNeedsResolution);
  const activeEvidenceReady = activeRun ? researchRunHasEvidence(activeRun) : false;
  const reuseBlocksDraft = activeRun?.dqlPromotionAction === 'reuse_existing';
  const draftDisabled = busy || activeRunExternalNotebook || !reviewedSql.trim() || sourceNeedsResolution || !activeEvidenceReady || reuseBlocksDraft;
  const draftDisabledReason = activeRunExternalNotebook
    ? 'Open the source notebook before creating a DQL draft'
    : sourceNeedsResolution
      ? 'Resolve source evidence before creating a DQL draft'
      : reuseBlocksDraft
      ? 'Reuse the matching saved query or document a replacement before creating a new DQL draft'
    : !activeEvidenceReady
      ? 'Preview and save metadata context before creating a DQL draft'
      : undefined;
  const reuseCheckDisabled = busy || checkingReuse || !activeRun || activeRunExternalNotebook || !reviewedSql.trim() || sourceNeedsResolution;
  const activeNextActionCommand = activeNextAction
    ? researchNextActionCommandLabel(activeNextAction.kind, {
        sourceSync: activeSourceSync,
        hasContextPreview: Boolean(contextPreview),
        hasDraft: Boolean(activeRun?.draftBlockPath),
      })
    : null;
  const activeNextActionCommandDisabled = busy
    || !activeRun
    || !activeNextAction
    || !activeNextActionCommand
    || (activeNextAction.kind === 'review_sql' && !reviewedSql.trim())
    || (activeNextAction.kind === 'review_context' && !question.trim())
    || activeRunExternalNotebook
    || (activeNextAction.kind === 'resolve_source' && activeSourceSync === 'missing' && !reviewedSql.trim())
    || ((activeNextAction.kind === 'fix_blockers' || activeNextAction.kind === 'run_preview') && researchDisabled)
    || (activeNextAction.kind === 'create_dql_draft' && draftDisabled)
    || (activeNextAction.kind === 'open_certification' && !activeRun.draftBlockPath);
  const contextPreviewItems = contextPreview ? contextPreviewEvidence(contextPreview) : [];
  const activeDossierItems = activeRun ? researchDossierItems(activeRun, activeSourceSync) : [];
  const activeWorkflowStages = activeRun ? researchWorkflowStages(activeRun, activeSourceSync, activeNextAction) : [];
  const activeResearchPlan = activeRun?.researchPlan;
  const activeEvidenceRecord = activeRun ? researchEvidenceRecord(activeRun) : null;
  const savedContextTrust = researchTrustLabel(activeEvidenceRecord);
  const savedContextPackId = activeRun?.contextPackId ?? stringFromRecord(activeEvidenceRecord, 'contextPackId');
  const savedContextRoute = activeRun ? researchRouteDecision(activeRun, activeEvidenceRecord) : null;
  const savedContextSummaries = researchEvidenceSummaries(activeEvidenceRecord);
  const savedContextRelations = researchAllowedRelations(activeEvidenceRecord);
  const savedContextMissing = researchMissingContext(activeEvidenceRecord);
  const hasSavedContext = Boolean(
    savedContextTrust
    || savedContextPackId
    || savedContextRoute
    || savedContextSummaries.length
    || savedContextRelations.length
    || savedContextMissing.length,
  );
  const nextActionCount = (kind: ResearchNextActionKind): number => {
    if (kind === 'resolve_source') return sourceStateCounts.changed + sourceStateCounts.missing;
    if (sourceSyncFilter === 'all' && counts.nextActions && isDurableNextActionFilter(kind)) return counts.nextActions[kind] ?? 0;
    return localNextActionCounts[kind] ?? 0;
  };
  const nextActionTotal = sourceSyncFilter === 'all'
    ? counts.total
    : sourceFilteredRuns.length;
  const sourceCoverageMetricCount = runScope === 'notebook'
    ? currentSourceCoveredCount
    : counts.sourceLinked ?? 0;
  const sourceCoverageMetricLabel = runScope === 'notebook' ? 'Covered cells' : 'Source runs';
  const coveredCellsValue = runScope === 'notebook'
    ? `${Math.min(sourceCoverageMetricCount, sourceCells.length)}/${sourceCells.length}`
    : sourceCoverageMetricCount;
  const uncoveredSourceCount = runScope === 'notebook'
    ? Math.max(0, sourceCells.length - sourceCoverageMetricCount)
    : 0;
  const seedButtonLabel = uncoveredSourceCount > 0 ? `Seed ${uncoveredSourceCount}` : 'Seed cells';
  const coverageVisibleItems = filteredSourceCoverageItems.slice(0, coverageVisibleLimit);
  const coverageMatchedCount = filteredSourceCoverageItems.length;
  const hiddenCoverageCount = Math.max(0, coverageMatchedCount - coverageVisibleItems.length);
  const nextCoveragePageCount = Math.min(RESEARCH_COVERAGE_PAGE_SIZE, hiddenCoverageCount);
  const coverageStartedCount = sourceCoverageItems.filter((item) => item.run && item.status !== 'missing').length;
  const coverageChangedCount = sourceCoverageCounts.changed;
  const coverageMissingCount = sourceCoverageCounts.missing;
  const coverageUnresearchedCount = sourceCoverageCounts.unresearched;
  const showSourceCoverage = runScope === 'notebook' && (sourceCells.length > 0 || sourceCoverageItems.length > 0);
  const sourceCoverageNeedsAttention = coverageChangedCount > 0
    || coverageMissingCount > 0
    || coverageUnresearchedCount > 0
    || sourceCoverageFilter !== 'all';
  const sourceCoverageExpanded = showSourceCoverageDetails || sourceCoverageNeedsAttention;
  const sourceCoverageHeaderLabel = sourceCells.length > 0
    ? `${coverageStartedCount}/${sourceCells.length} researched`
    : '0 current source cells';
  const canInsertResearchRegister = counts.total > 0 || sourceCells.length > 0;
  const queueMatchTotal = localSourceRunListMode
    ? filteredVisibleRuns.length
    : sourceSyncFilter === 'all' && nextActionFilter !== 'resolve_source'
      ? totalRuns
      : sourceFilteredRuns.length;
  const queueCountLabel = queueMatchTotal > visibleRuns.length
    ? `${visibleRuns.length}/${queueMatchTotal}`
    : String(visibleRuns.length);
  const hasQueueFilters = Boolean(
    runSearch
    || runFilter !== DEFAULT_RUN_FILTER
    || runNotebookFilter
    || runDomainFilter
    || runOwnerFilter
    || runIntentFilter
    || sourceSyncFilter !== 'all'
    || sourceCoverageFilter !== 'all'
    || nextActionFilter !== 'all',
  );
  const activeAdvancedFilters = (() => {
    const filters: string[] = [];
    if (runScope !== 'notebook') filters.push('Project scope');
    if (runNotebookFilter.trim()) {
      const notebook = runNotebooks.find((item) => item.path === runNotebookFilter.trim());
      filters.push(`Notebook: ${notebook?.title ?? runNotebookFilter.trim()}`);
    }
    if (runDomainFilter.trim()) filters.push(`Domain: ${runDomainFilter.trim()}`);
    if (runOwnerFilter.trim()) filters.push(`Owner: ${runOwnerFilter.trim()}`);
    if (runFilter !== DEFAULT_RUN_FILTER) filters.push(`Show: ${formatRunFilter(runFilter)}`);
    if (runIntentFilter) filters.push(`Intent: ${formatResearchIntent(runIntentFilter)}`);
    if (runSort !== 'priority') filters.push('Recent first');
    if (sourceSyncFilter !== 'all') filters.push(`Source: ${formatSourceSyncFilter(sourceSyncFilter)}`);
    if (sourceCoverageFilter !== 'all') filters.push(`Coverage: ${formatSourceCoverageFilter(sourceCoverageFilter)}`);
    if (nextActionFilter !== 'all') filters.push(`Next: ${formatResearchNextActionFilter(nextActionFilter)}`);
    return filters;
  })();
  const activeFilterChips: ResearchFilterChip[] = (() => {
    const chips: ResearchFilterChip[] = [];
    const notebook = runNotebookFilter.trim()
      ? runNotebooks.find((item) => item.path === runNotebookFilter.trim())
      : null;
    if (runSearch.trim()) {
      chips.push({
        id: 'search',
        label: `Search: ${runSearch.trim()}`,
        onClear: () => setRunSearch(''),
      });
    }
    if (runScope !== 'notebook') {
      chips.push({
        id: 'scope',
        label: 'Project scope',
        onClear: () => {
          setRunScope('notebook');
          setRunNotebookFilter('');
        },
      });
    }
    if (runNotebookFilter.trim()) {
      chips.push({
        id: 'notebook',
        label: `Notebook: ${notebook?.title ?? runNotebookFilter.trim()}`,
        onClear: () => setRunNotebookFilter(''),
      });
    }
    if (runDomainFilter.trim()) {
      chips.push({
        id: 'domain',
        label: `Domain: ${runDomainFilter.trim()}`,
        onClear: () => setRunDomainFilter(''),
      });
    }
    if (runOwnerFilter.trim()) {
      chips.push({
        id: 'owner',
        label: `Owner: ${runOwnerFilter.trim()}`,
        onClear: () => setRunOwnerFilter(''),
      });
    }
    if (runFilter !== DEFAULT_RUN_FILTER) {
      chips.push({
        id: 'show',
        label: `Show: ${formatRunFilter(runFilter)}`,
        onClear: () => setRunFilter(DEFAULT_RUN_FILTER),
      });
    }
    if (runIntentFilter) {
      chips.push({
        id: 'intent',
        label: `Intent: ${formatResearchIntent(runIntentFilter)}`,
        onClear: () => setRunIntentFilter(''),
      });
    }
    if (runSort !== 'priority') {
      chips.push({
        id: 'sort',
        label: 'Recent first',
        onClear: () => setRunSort('priority'),
      });
    }
    if (sourceSyncFilter !== 'all') {
      chips.push({
        id: 'source',
        label: `Source: ${formatSourceSyncFilter(sourceSyncFilter)}`,
        onClear: () => setSourceSyncFilter('all'),
      });
    }
    if (sourceCoverageFilter !== 'all') {
      chips.push({
        id: 'coverage',
        label: `Coverage: ${formatSourceCoverageFilter(sourceCoverageFilter)}`,
        onClear: () => setSourceCoverageFilter('all'),
      });
    }
    if (nextActionFilter !== 'all') {
      chips.push({
        id: 'next',
        label: `Next: ${formatResearchNextActionFilter(nextActionFilter)}`,
        onClear: () => setNextActionFilter('all'),
      });
    }
    return chips;
  })();
  const advancedFilterLabel = activeAdvancedFilters.length > 0
    ? activeAdvancedFilters.length > 3
      ? `${activeAdvancedFilters.slice(0, 3).join(' · ')} · +${activeAdvancedFilters.length - 3}`
      : activeAdvancedFilters.join(' · ')
    : 'Scope, notebook, domain, source, and order';
  const openNextTitle = sourceCoverageFilter === 'unresearched' && nextCoverageItem
    ? `Start research from ${nextCoverageItem.cell.name}`
    : !nextActionableRun && nextCoverageItem
      ? `Start research from ${nextCoverageItem.cell.name}`
      : undefined;
  const visibleWorklistItems = worklistItems.slice(0, worklistVisibleLimit);
  const hiddenWorklistCount = Math.max(0, worklistItems.length - visibleWorklistItems.length);
  const nextWorklistPageCount = Math.min(RESEARCH_WORKLIST_PAGE_SIZE, hiddenWorklistCount);
	  const portfolioMapExpanded = showPortfolioMapDetails || Boolean(runNotebookFilter || runDomainFilter || runOwnerFilter || runIntentFilter);
	  const portfolioMapSummary = [
	    portfolioSummaryLabel(portfolioNotebookGroupCount, 'notebook', portfolioNotebooks.length),
	    portfolioSummaryLabel(portfolioDomainGroupCount, 'domain', portfolioDomains.length),
	    portfolioSummaryLabel(portfolioOwnerGroupCount, 'owner', portfolioOwners.length),
	    portfolioSummaryLabel(portfolioIntentGroupCount, 'pattern', portfolioIntents.length),
	  ].join(' · ');
  const sourceCoverageSummary = [
    sourceCoverageHeaderLabel,
    coverageChangedCount > 0 ? `${coverageChangedCount} changed` : undefined,
    coverageMissingCount > 0 ? `${coverageMissingCount} missing` : undefined,
    coverageUnresearchedCount > 0 ? `${coverageUnresearchedCount} new` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <aside style={panelStyle(t)} aria-label="Notebook research panel">
      <div style={headerStyle(t)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Sparkles size={16} strokeWidth={2} color={t.accent} aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle(t)}>Research</div>
            <div style={subtitleStyle(t)}>SQL, evidence, preview, DQL draft</div>
          </div>
        </div>
        <button type="button" onClick={onClose} title="Hide research" style={iconButtonStyle(t)}>
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      <div style={bodyStyle}>
        {error && <div style={errorStyle(t)}>{error}</div>}
        {notice && <div style={noticeStyle(t)}>{notice}</div>}

        <section style={sectionStyle(t)}>
          <div style={sectionHeaderStyle(t)}>
            <span>{activeTitle}</span>
            <button type="button" onClick={startNewRun} disabled={busy} style={smallActionButtonStyle(t, busy)} title="Start a new research run">
              <Plus size={12} strokeWidth={2} />
              New
            </button>
          </div>
          <label style={labelStyle(t)}>Question</label>
          <textarea
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              setContextPreview(null);
            }}
            placeholder={selectedResearchPattern.promptPlaceholder}
            style={textareaStyle(t, 82)}
          />
          <label style={fieldShellStyle(t)}>
            <span style={labelStyle(t)}>Pattern</span>
            <select
              value={draftIntent}
              onChange={(event) => {
                setDraftIntent(event.target.value as DraftResearchIntent);
                setContextPreview(null);
              }}
              style={selectStyle(t)}
            >
              <option value="auto">Auto from question</option>
              {RESEARCH_PATTERNS.map((pattern) => (
                <option key={pattern.id} value={pattern.id}>{pattern.label}</option>
              ))}
            </select>
          </label>
          <div style={patternCardStyle(t)}>
            <span style={{ ...patternTextStyle, fontWeight: 900, color: t.textPrimary }}>{selectedResearchPattern.label}</span>
            <span style={{ ...patternTextStyle, color: t.textMuted }}>DQL: {selectedResearchPattern.dqlTarget}</span>
            <span style={{ ...patternTextStyle, color: t.textMuted }}>Focus: {selectedResearchPattern.focus}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={fieldShellStyle(t)}>
              <span style={labelStyle(t)}>Source cell</span>
              <select value={selectedCellId} onChange={(event) => handleSourceChange(event.target.value)} style={selectStyle(t)}>
                <option value="">Metadata only</option>
                {sourceCells.map((cell) => (
                  <option key={cell.id} value={cell.id}>{cell.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={fieldShellStyle(t)}>
              <span style={labelStyle(t)}>Domain</span>
              <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="customer" style={inputStyle(t)} />
            </label>
            <label style={fieldShellStyle(t)}>
              <span style={labelStyle(t)}>Owner</span>
              <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="analytics" style={inputStyle(t)} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={runResearch} disabled={researchDisabled} style={primaryButtonStyle(t, researchDisabled)} title={sourceNeedsResolution ? 'Resolve source evidence before rerunning' : undefined}>
              {busy ? <Loader2 size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
              {activeRun && !draftMode ? 'Rerun' : 'Run research'}
            </button>
            <button
              type="button"
              onClick={previewContext}
              disabled={busy || contextLoading || !question.trim()}
              style={secondaryButtonStyle(t, busy || contextLoading || !question.trim())}
            >
              {contextLoading ? <Loader2 size={14} strokeWidth={2} /> : <Search size={14} strokeWidth={2} />}
              Preview context
            </button>
            <button
              type="button"
              onClick={seedResearchFromCells}
              disabled={busy || sourceCells.length === 0}
              style={secondaryButtonStyle(t, busy || sourceCells.length === 0)}
              title="Create draft research runs for SQL and DQL cells that do not already have one"
            >
              <Plus size={14} strokeWidth={2} />
              {seedButtonLabel}
            </button>
            <button type="button" onClick={loadRuns} disabled={busy} style={secondaryButtonStyle(t, busy)}>
              <RefreshCw size={14} strokeWidth={2} />
              Refresh
            </button>
          </div>
        </section>

        {contextPreview && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Agent context</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={countPillStyle(t)}>{contextPreview.counts.evidence} evidence · {contextPreview.counts.relations} relations</span>
                <button type="button" onClick={saveContextEvidence} disabled={busy} style={smallActionButtonStyle(t, busy)}>
                  {activeRun && !draftMode ? 'Save evidence' : 'Save draft'}
                </button>
              </div>
            </div>
            <div style={contextPreviewHeaderStyle(t)}>
              {contextPreview.trustLabel && <span style={runChipStyle(t, 'success')}>{contextPreview.trustLabel}</span>}
              {contextPreview.routeDecision?.route && <span style={runChipStyle(t, 'neutral')}>{contextPreview.routeDecision.route}</span>}
              {contextPreview.routeDecision?.intent && <span style={runChipStyle(t, 'neutral')}>{contextPreview.routeDecision.intent}</span>}
            </div>
            {contextPreview.routeDecision?.reason && <p style={paragraphStyle(t)}>{contextPreview.routeDecision.reason}</p>}
            {contextPreviewItems.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {contextPreviewItems.slice(0, 6).map((item, index) => (
                  <div key={`${item}-${index}`} style={evidenceStyle(t)}>{item}</div>
                ))}
              </div>
            ) : (
              <div style={emptyStyle(t)}>No ranked context was selected for this question yet.</div>
            )}
            {contextPreview.relations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {contextPreview.relations.slice(0, 8).map((relation) => (
                  <span key={relation.relation || relation.name} style={countPillStyle(t)}>
                    {relation.name} · {relation.columns.length} cols
                  </span>
                ))}
              </div>
            )}
            {[...contextPreview.missingContext.map((item) => `${item.kind}: ${item.message}`), ...contextPreview.warnings].slice(0, 4).map((warning, index) => (
              <div key={`${warning}-${index}`} style={warningStyle(t)}>{warning}</div>
            ))}
          </section>
        )}

        <section style={sectionStyle(t)}>
          <div style={sectionHeaderStyle(t)}>
            <span>Research runs</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={countPillStyle(t)}>{queueCountLabel}</span>
              {hasQueueFilters && (
                <button type="button" onClick={clearQueueFilters} disabled={busy} style={smallActionButtonStyle(t, busy)}>
                  Reset
                </button>
              )}
              <button
                type="button"
                onClick={insertResearchRegisterCell}
                disabled={busy || !canInsertResearchRegister}
                style={smallActionButtonStyle(t, busy || !canInsertResearchRegister)}
                title="Insert a compact research backlog summary into this notebook"
              >
                Register
              </button>
              <button
                type="button"
                onClick={openNextActionableRun}
                disabled={busy || (!nextActionableRun && !nextCoverageItem)}
                style={smallActionButtonStyle(t, busy || (!nextActionableRun && !nextCoverageItem))}
                title={openNextTitle}
              >
                Open next
              </button>
            </div>
          </div>
          <div style={summaryGridStyle}>
            <MetricBox label="Runs" value={counts.total} tone="neutral" t={t} active={!hasQueueFilters} onClick={clearQueueFilters} title="Show open research work" disableWhenZero={false} />
            <MetricBox label={sourceCoverageMetricLabel} value={coveredCellsValue} tone={uncoveredSourceCount > 0 ? 'warning' : 'success'} t={t} />
            <MetricBox label="Review" value={counts.needsReview} tone="neutral" t={t} active={runFilter === 'draft'} onClick={() => selectSummaryFilter('draft')} title="Show runs that still need review" />
            <MetricBox label="Draft ready" value={counts.draftReady} tone="accent" t={t} active={runFilter === 'draft_ready'} onClick={() => selectSummaryFilter('draft_ready')} title="Show runs ready for DQL draft creation" />
            <MetricBox label="Cert ready" value={counts.certificationReady} tone="success" t={t} active={runFilter === 'certification_ready'} onClick={() => selectSummaryFilter('certification_ready')} title="Show runs ready for certification review" />
            <MetricBox label="Blocked" value={counts.blocked} tone="error" t={t} active={runFilter === 'blocked'} onClick={() => selectSummaryFilter('blocked')} title="Show blocked research runs" />
            <MetricBox label="Stale" value={counts.staleOpen} tone={counts.expiredOpen > 0 ? 'error' : 'warning'} t={t} active={runFilter === 'stale_open'} onClick={() => selectSummaryFilter('stale_open')} title="Show open research unchanged for 7 or more days" />
            <MetricBox label="30d+" value={counts.expiredOpen} tone="error" t={t} active={runFilter === 'expired_open'} onClick={() => selectSummaryFilter('expired_open')} title="Show open research unchanged for 30 or more days" />
            <MetricBox label="Drafts" value={counts.dqlDrafts} tone="accent" t={t} active={runFilter === 'dql_draft'} onClick={() => selectSummaryFilter('dql_draft')} title="Show runs with DQL drafts" />
            <MetricBox label="Errors" value={counts.errors} tone="error" t={t} active={runFilter === 'error'} onClick={() => selectSummaryFilter('error')} title="Show failed research runs" />
          </div>
          {diagnostics && <ResearchDiagnosticsLine diagnostics={diagnostics} t={t} />}
          {showPortfolioMap && (
            <div style={portfolioBoxStyle(t)} aria-label="Research portfolio map">
              <CollapsibleOverviewHeader
                title="Portfolio map"
                summary={portfolioMapSummary}
                expanded={portfolioMapExpanded}
                onToggle={() => setShowPortfolioMapDetails((value) => !value)}
                t={t}
              />
              {portfolioMapExpanded && (
                <>
                  {portfolioNotebooks.length > 0 && (
                    <div style={portfolioGroupStyle}>
                      <div style={portfolioGroupLabelStyle(t)}>Notebooks</div>
                      {portfolioNotebooks.map((item) => (
                        <PortfolioRow
                          key={item.path}
                          label={item.title}
                          total={item.total}
                          draftReady={item.draftReady}
                          certificationReady={item.certificationReady}
                          blocked={item.blocked}
                          staleOpen={item.staleOpen}
                          expiredOpen={item.expiredOpen}
                          nextAction={item.nextAction}
                          nextActionCount={item.nextActionCount}
                          active={runNotebookFilter === item.path}
                          detail={item.path}
                          t={t}
                          onClick={() => selectPortfolioNotebook(item.path)}
                        />
                      ))}
                      {hiddenPortfolioNotebookCount > 0 && (
                        <PortfolioMoreLine
                          hidden={hiddenPortfolioNotebookCount}
                          noun="notebook"
                          filterLabel="Notebook"
                          t={t}
                        />
                      )}
                    </div>
                  )}
                  {portfolioDomains.length > 0 && (
                    <div style={portfolioGroupStyle}>
                      <div style={portfolioGroupLabelStyle(t)}>Domains</div>
                      {portfolioDomains.map((item) => (
                        <PortfolioRow
                          key={item.domain}
                          label={item.domain}
                          total={item.total}
                          draftReady={item.draftReady}
                          certificationReady={item.certificationReady}
                          blocked={item.blocked}
                          staleOpen={item.staleOpen}
                          expiredOpen={item.expiredOpen}
                          nextAction={item.nextAction}
                          nextActionCount={item.nextActionCount}
                          active={runDomainFilter === item.domain}
                          t={t}
                          onClick={() => selectPortfolioDomain(item.domain)}
                        />
                      ))}
                      {hiddenPortfolioDomainCount > 0 && (
                        <PortfolioMoreLine
                          hidden={hiddenPortfolioDomainCount}
                          noun="domain"
                          filterLabel="Domain"
                          t={t}
                        />
                      )}
                    </div>
                  )}
                  {portfolioOwners.length > 0 && (
                    <div style={portfolioGroupStyle}>
                      <div style={portfolioGroupLabelStyle(t)}>Owners</div>
                      {portfolioOwners.map((item) => (
                        <PortfolioRow
                          key={item.owner}
                          label={item.owner}
                          total={item.total}
                          draftReady={item.draftReady}
                          certificationReady={item.certificationReady}
                          blocked={item.blocked}
                          staleOpen={item.staleOpen}
                          expiredOpen={item.expiredOpen}
                          nextAction={item.nextAction}
                          nextActionCount={item.nextActionCount}
                          active={runOwnerFilter === item.owner}
                          t={t}
                          onClick={() => selectPortfolioOwner(item.owner)}
                        />
                      ))}
                      {hiddenPortfolioOwnerCount > 0 && (
                        <PortfolioMoreLine
                          hidden={hiddenPortfolioOwnerCount}
                          noun="owner"
                          filterLabel="Owner"
                          t={t}
                        />
                      )}
                    </div>
                  )}
                  {portfolioIntents.length > 0 && (
                    <div style={portfolioGroupStyle}>
                      <div style={portfolioGroupLabelStyle(t)}>Research patterns</div>
                      {portfolioIntents.map((item) => (
                        <PortfolioRow
                          key={item.intent}
                          label={formatResearchIntent(item.intent)}
                          total={item.total}
                          draftReady={item.draftReady}
                          certificationReady={item.certificationReady}
                          blocked={item.blocked}
                          staleOpen={item.staleOpen}
                          expiredOpen={item.expiredOpen}
                          nextAction={item.nextAction}
                          nextActionCount={item.nextActionCount}
                          active={runIntentFilter === item.intent}
                          t={t}
                          onClick={() => selectPortfolioIntent(item.intent)}
                        />
                      ))}
                      {hiddenPortfolioIntentCount > 0 && (
                        <PortfolioMoreLine
                          hidden={hiddenPortfolioIntentCount}
                          noun="pattern"
                          filterLabel="Pattern"
                          t={t}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {visibleWorklistItems.length > 0 && (
            <div style={worklistBoxStyle(t)} aria-label="Research priority worklist">
              <div style={coverageHeaderStyle(t)}>
                <span>Priority worklist</span>
                <span style={countPillStyle(t)}>
                  {visibleWorklistItems.length}/{worklistItems.length} next
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {visibleWorklistItems.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openWorklistItem(item)}
                    style={worklistItemStyle(t, item.tone, activeRun?.id === item.run?.id && !draftMode)}
                    title={`${item.actionLabel}: ${item.reason}`}
                  >
                    <span style={worklistIndexStyle(t, item.tone)}>{index + 1}</span>
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 850 }}>{item.title}</span>
                        <span style={runChipStyle(t, item.tone)}>{item.actionLabel}</span>
                      </span>
                      <span style={runMetaStyle(t)}>{item.detail}</span>
                      <span style={worklistReasonStyle(t, item.tone)} title={item.reason}>
                        <span style={{ fontWeight: 900, color: toneColor(t, item.tone), flexShrink: 0 }}>Why</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.reason}</span>
                      </span>
                    </span>
                    <span style={{ flexShrink: 0, color: toneColor(t, item.tone), fontSize: 10, fontWeight: 900 }}>
                      {item.statusLabel}
                    </span>
                  </button>
                ))}
              </div>
              {hiddenWorklistCount > 0 && (
                <div style={runMetaStyle(t)}>
                  Showing {visibleWorklistItems.length} of {worklistItems.length} priority items.
                  <button
                    type="button"
                    onClick={() => setWorklistVisibleLimit((value) => value + RESEARCH_WORKLIST_PAGE_SIZE)}
                    style={inlineTextButtonStyle(t)}
                  >
                    Show {nextWorklistPageCount} more
                  </button>
                </div>
              )}
              {visibleWorklistItems.length > RESEARCH_WORKLIST_INITIAL_LIMIT && (
                <div style={runMetaStyle(t)}>
                  Expanded priority queue.
                  <button
                    type="button"
                    onClick={() => setWorklistVisibleLimit(RESEARCH_WORKLIST_INITIAL_LIMIT)}
                    style={inlineTextButtonStyle(t)}
                  >
                    Show fewer
                  </button>
                </div>
              )}
            </div>
          )}
          {showSourceCoverage && (
            <div style={coverageBoxStyle(t)} aria-label="Notebook source coverage">
              <CollapsibleOverviewHeader
                title="Source coverage"
                summary={sourceCoverageSummary}
                expanded={sourceCoverageExpanded}
                onToggle={() => setShowSourceCoverageDetails((value) => !value)}
                t={t}
              />
              {sourceCoverageExpanded && (
                <>
                  <div style={coverageFilterStripStyle(t)} aria-label="Source coverage filters">
                    <QueueActionButton
                      label="All"
                      count={sourceCoverageItems.length}
                      active={sourceCoverageFilter === 'all'}
                      tone="neutral"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('all')}
                    />
                    <QueueActionButton
                      label="New"
                      count={sourceCoverageCounts.unresearched}
                      active={sourceCoverageFilter === 'unresearched'}
                      tone="warning"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('unresearched')}
                    />
                    <QueueActionButton
                      label="Changed"
                      count={sourceCoverageCounts.changed}
                      active={sourceCoverageFilter === 'changed'}
                      tone="warning"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('changed')}
                    />
                    <QueueActionButton
                      label="Missing"
                      count={sourceCoverageCounts.missing}
                      active={sourceCoverageFilter === 'missing'}
                      tone="error"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('missing')}
                    />
                    <QueueActionButton
                      label="Synced"
                      count={sourceCoverageCounts.synced}
                      active={sourceCoverageFilter === 'synced'}
                      tone="success"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('synced')}
                    />
                    <QueueActionButton
                      label="Unknown"
                      count={sourceCoverageCounts.unknown}
                      active={sourceCoverageFilter === 'unknown'}
                      tone="neutral"
                      t={t}
                      onClick={() => selectSourceCoverageFilter('unknown')}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {coverageVisibleItems.map((item) => (
                      <button
                        key={item.cell.id}
                        type="button"
                        onClick={() => openSourceCoverageItem(item)}
                        style={coverageItemStyle(t, item.status, selectedCellId === item.cell.id)}
                      >
                        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span style={coverageDotStyle(t, item.status)} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 800 }}>{item.cell.name}</span>
                          </span>
                          <span style={runMetaStyle(t)}>
                            {item.cell.type.toUpperCase()} · {sourceCoverageDetail(item)}
                          </span>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                          <span style={runChipStyle(t, sourceCoverageTone(item))}>{sourceCoverageLabel(item)}</span>
                          <span style={smallActionButtonStyle(t, false)}>{item.run ? 'Open' : 'Start'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {coverageMatchedCount === 0 && (
                    <div style={emptyStyle(t)}>No source cells match the current coverage or search filter.</div>
                  )}
                  {hiddenCoverageCount > 0 && (
                    <div style={runMetaStyle(t)}>
                      Showing {coverageVisibleItems.length} of {coverageMatchedCount} matching source cells.
                      <button
                        type="button"
                        onClick={() => setCoverageVisibleLimit((value) => value + RESEARCH_COVERAGE_PAGE_SIZE)}
                        style={inlineTextButtonStyle(t)}
                      >
                        Show {nextCoveragePageCount} more
                      </button>
                    </div>
                  )}
                  {coverageVisibleItems.length > RESEARCH_COVERAGE_INITIAL_LIMIT && (
                    <div style={runMetaStyle(t)}>
                      Expanded source coverage list.
                      <button
                        type="button"
                        onClick={() => setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT)}
                        style={inlineTextButtonStyle(t)}
                      >
                        Show less
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <div style={queueStripStyle(t)} aria-label="Research review queue">
            <QueueActionButton
              label="Source fixes"
              count={nextActionCount('resolve_source')}
              active={nextActionFilter === 'resolve_source'}
              tone="warning"
              t={t}
              onClick={() => selectQueueAction('resolve_source')}
            />
            <QueueActionButton
              label="Blockers"
              count={nextActionCount('fix_blockers')}
              active={nextActionFilter === 'fix_blockers'}
              tone="error"
              t={t}
              onClick={() => selectQueueAction('fix_blockers')}
            />
            <QueueActionButton
              label="Review SQL"
              count={nextActionCount('review_sql')}
              active={nextActionFilter === 'review_sql'}
              tone="warning"
              t={t}
              onClick={() => selectQueueAction('review_sql')}
            />
            <QueueActionButton
              label="Review context"
              count={nextActionCount('review_context')}
              active={nextActionFilter === 'review_context'}
              tone="warning"
              t={t}
              onClick={() => selectQueueAction('review_context')}
            />
            <QueueActionButton
              label="Run preview"
              count={nextActionCount('run_preview')}
              active={nextActionFilter === 'run_preview'}
              tone="accent"
              t={t}
              onClick={() => selectQueueAction('run_preview')}
            />
            <QueueActionButton
              label="Reuse"
              count={nextActionCount('reuse_existing')}
              active={nextActionFilter === 'reuse_existing'}
              tone="success"
              t={t}
              onClick={() => selectQueueAction('reuse_existing')}
            />
            <QueueActionButton
              label="Create draft"
              count={nextActionCount('create_dql_draft')}
              active={nextActionFilter === 'create_dql_draft'}
              tone="accent"
              t={t}
              onClick={() => selectQueueAction('create_dql_draft')}
            />
            <QueueActionButton
              label="Certify"
              count={nextActionCount('open_certification')}
              active={nextActionFilter === 'open_certification'}
              tone="success"
              t={t}
              onClick={() => selectQueueAction('open_certification')}
            />
            <QueueActionButton
              label="Complete"
              count={nextActionCount('complete_review')}
              active={nextActionFilter === 'complete_review'}
              tone="neutral"
              t={t}
              onClick={() => selectQueueAction('complete_review')}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ ...fieldShellStyle(t), position: 'relative' }}>
              <span style={labelStyle(t)}>Search</span>
              <Search size={13} strokeWidth={2} color={t.textMuted} style={{ position: 'absolute', left: 8, bottom: 8 }} aria-hidden="true" />
              <input
                value={runSearch}
                onChange={(event) => setRunSearch(event.target.value)}
                placeholder="Question, owner, domain, cell, status"
                style={{ ...inputStyle(t), paddingLeft: 27 }}
              />
            </label>
          </div>
          <div style={advancedFilterShellStyle(t, activeAdvancedFilters.length > 0)}>
            <button
              type="button"
              onClick={() => setShowAdvancedFilters((value) => !value)}
              aria-expanded={showAdvancedFilters}
              style={advancedFilterToggleStyle(t)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 0 }}>
                <SlidersHorizontal size={13} strokeWidth={2} aria-hidden="true" />
                Filters
                {activeAdvancedFilters.length > 0 && <span style={countPillStyle(t)}>{activeAdvancedFilters.length}</span>}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: activeAdvancedFilters.length > 0 ? t.textSecondary : t.textMuted }}>
                {advancedFilterLabel}
              </span>
              <ChevronDown
                size={14}
                strokeWidth={2}
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  transform: showAdvancedFilters ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 120ms ease',
                }}
              />
            </button>
            {showAdvancedFilters && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Scope</span>
                  <select
                    value={runScope}
                    onChange={(event) => {
                      const nextScope = event.target.value as ResearchScope;
                      setRunScope(nextScope);
                      if (nextScope === 'notebook') setRunNotebookFilter('');
                      if (nextScope === 'project') {
                        setSourceSyncFilter('all');
                        setSourceCoverageFilter('all');
                        setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT);
                      }
                      setPageOffset(0);
                    }}
                    style={selectStyle(t)}
                  >
                    <option value="notebook">Notebook</option>
                    <option value="project">Project</option>
                  </select>
                </label>
	                <label style={fieldShellStyle(t)}>
	                  <span style={labelStyle(t)}>Notebook</span>
	                  <input
	                    value={runNotebookFilter}
                      list={NOTEBOOK_FILTER_DATALIST_ID}
	                    onChange={(event) => {
	                      const next = event.target.value;
	                      setRunNotebookFilter(next);
	                      if (next.trim()) {
	                        setRunScope('project');
                        setSourceSyncFilter('all');
                        setSourceCoverageFilter('all');
                        setCoverageVisibleLimit(RESEARCH_COVERAGE_INITIAL_LIMIT);
                      }
	                      setPageOffset(0);
	                    }}
	                    placeholder={runScope === 'notebook' ? 'Current notebook' : 'All notebooks'}
	                    style={inputStyle(t)}
	                  />
                    <datalist id={NOTEBOOK_FILTER_DATALIST_ID}>
                      {notebookOptions.map((item) => (
                        <option key={item.path} value={item.path} label={`${item.title} (${item.total})`} />
                      ))}
                    </datalist>
	                </label>
	                <label style={fieldShellStyle(t)}>
	                  <span style={labelStyle(t)}>Domain</span>
	                  <input
	                    value={runDomainFilter}
                      list={DOMAIN_FILTER_DATALIST_ID}
	                    onChange={(event) => setRunDomainFilter(event.target.value)}
	                    placeholder="All domains"
	                    style={inputStyle(t)}
	                  />
                    <datalist id={DOMAIN_FILTER_DATALIST_ID}>
                      {domainOptions.map((item) => (
                        <option key={item.domain} value={item.domain} label={`${item.total}`} />
                      ))}
                    </datalist>
	                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Owner</span>
                  <input
                    value={runOwnerFilter}
                    list={OWNER_FILTER_DATALIST_ID}
                    onChange={(event) => setRunOwnerFilter(event.target.value)}
                    placeholder="All owners"
                    style={inputStyle(t)}
                  />
                  <datalist id={OWNER_FILTER_DATALIST_ID}>
                    {ownerOptions.map((item) => (
                      <option key={item.owner} value={item.owner} label={`${item.total}`} />
                    ))}
                  </datalist>
                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Show</span>
                  <select value={runFilter} onChange={(event) => setRunFilter(event.target.value as RunFilter)} style={selectStyle(t)}>
                    <option value="open_work">Open work</option>
                    <option value="all">All history</option>
                    <option value="ready">Ready</option>
                    <option value="draft">Needs review</option>
                    <option value="dql_draft">DQL draft</option>
                    <option value="draft_ready">Draft ready</option>
                    <option value="certification_ready">Cert ready</option>
                    <option value="blocked">Blocked</option>
                    <option value="stale_open">Stale open</option>
                    <option value="expired_open">30d open</option>
                    <option value="completed">Completed</option>
                    <option value="rejected">Rejected</option>
                    <option value="reuse_existing">Reuse existing</option>
                    <option value="extend_existing">Extend existing</option>
                    <option value="create_replacement">Replacement</option>
                    <option value="create_new">Create new</option>
                    <option value="error">Errors</option>
                  </select>
                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Intent</span>
                  <select value={runIntentFilter} onChange={(event) => setRunIntentFilter(event.target.value as NotebookResearchIntent | '')} style={selectStyle(t)}>
                    <option value="">All intents</option>
                    {intentOptions.map((item) => (
                      <option key={item.intent} value={item.intent}>
                        {formatResearchIntent(item.intent)} ({item.total})
                      </option>
                    ))}
                  </select>
                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Order</span>
                  <select value={runSort} onChange={(event) => setRunSort(event.target.value as NotebookResearchSort)} style={selectStyle(t)}>
                    <option value="priority">Work queue</option>
                    <option value="updated_desc">Recent activity</option>
                  </select>
                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Source</span>
                  <select
                    value={sourceSyncFilter}
                    onChange={(event) => selectSourceSyncFilter(event.target.value as SourceSyncFilter)}
                    disabled={runScope !== 'notebook'}
                    title={runScope === 'notebook' ? 'Filter current notebook source-cell state' : 'Source state is available in notebook scope only'}
                    style={selectStyle(t, runScope !== 'notebook')}
                  >
                    <option value="all">All sources</option>
                    <option value="changed">Changed ({sourceStateCounts.changed})</option>
                    <option value="missing">Missing ({sourceStateCounts.missing})</option>
                    <option value="synced">Synced ({sourceStateCounts.synced})</option>
                    <option value="unknown">Untracked ({sourceStateCounts.unknown})</option>
                  </select>
                </label>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Next</span>
                  <select value={nextActionFilter} onChange={(event) => setNextActionFilter(event.target.value as ResearchNextActionFilter)} style={selectStyle(t)}>
                    <option value="all">All next actions ({nextActionTotal})</option>
                    <option value="resolve_source">Source fixes ({nextActionCount('resolve_source')})</option>
                    <option value="fix_blockers">Blockers ({nextActionCount('fix_blockers')})</option>
                    <option value="review_sql">Review SQL ({nextActionCount('review_sql')})</option>
                    <option value="review_context">Review context ({nextActionCount('review_context')})</option>
                    <option value="run_preview">Run preview ({nextActionCount('run_preview')})</option>
                    <option value="reuse_existing">Reuse decisions ({nextActionCount('reuse_existing')})</option>
                    <option value="create_dql_draft">Create draft ({nextActionCount('create_dql_draft')})</option>
                    <option value="open_certification">Certify draft ({nextActionCount('open_certification')})</option>
                    <option value="complete_review">Complete review ({nextActionCount('complete_review')})</option>
                    <option value="continue_review">Continue review ({nextActionCount('continue_review')})</option>
                  </select>
                </label>
              </div>
            )}
          </div>
          {activeFilterChips.length > 0 && (
            <div style={activeFilterChipRowStyle(t)} aria-label="Active research filters">
              {activeFilterChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={chip.onClear}
                  disabled={busy}
                  style={activeFilterChipStyle(t, busy)}
                  title={`Clear ${chip.label}`}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.label}</span>
                  <X size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {totalRuns === 0 && (
              <div style={emptyStyle(t)}>
                {runSearch || runScope !== 'notebook' || runNotebookFilter || runFilter !== DEFAULT_RUN_FILTER || runDomainFilter || runOwnerFilter || runIntentFilter || sourceSyncFilter !== 'all' || sourceCoverageFilter !== 'all' || nextActionFilter !== 'all'
                  ? 'No runs match the current filter.'
                  : runFilter === DEFAULT_RUN_FILTER
                    ? 'No open research work. Switch Show to All history to review completed, certified, or rejected runs.'
                  : `No research runs for this ${runScope === 'notebook' ? 'notebook' : 'project'} yet.`}
              </div>
            )}
            {totalRuns > 0 && visibleRuns.length === 0 && (
              <div style={emptyStyle(t)}>
                No runs match the current source or next-action filter on this page.
              </div>
            )}
            {activeRun && !activeRunVisible && (
              <div style={hiddenSelectionStyle(t)}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  Selected research is outside the current page or hidden by active queue filters.
                </span>
                <button type="button" onClick={showSelectedRunInQueue} disabled={busy} style={smallActionButtonStyle(t, busy)}>
                  Show selected
                </button>
                {firstVisibleRun && (
                  <button type="button" onClick={openFirstVisibleRun} disabled={busy} style={smallActionButtonStyle(t, busy)}>
                    Open first
                  </button>
                )}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
              {visibleRuns.map((run) => {
                const syncStatus = researchSourceSyncForRun(run, sourceCellById, notebookPath);
                const nextAction = researchNextAction(run, syncStatus);
                const parameterReview = runParameterReviewSummary(run);
                const workflowSummary = researchWorkflowSummary(run, syncStatus, nextAction);
                const ageState = researchAgeState(run);
                const gateState = researchGateState(run);
                return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => openResearchRun(run, { openNotebook: true })}
                  style={runButtonStyle(t, activeRun?.id === run.id && !draftMode)}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      {statusIcon(run, t)}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.title}</span>
                    </span>
                    <span style={runMetaStyle(t)}>
                      {researchRunLocationLabel(run, notebookTitleByPath, notebookPath)} · {formatRunAge(run.updatedAt)}
                    </span>
                    <span style={workflowProgressLineStyle(t, workflowSummary.tone)} title={workflowSummary.title}>
                      <span style={{ fontWeight: 900, color: toneColor(t, workflowSummary.tone), flexShrink: 0 }}>{workflowSummary.progress}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workflowSummary.label}</span>
                    </span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                      {run.domain && <span style={runChipStyle(t, 'neutral')}>{run.domain}</span>}
                      {run.owner && <span style={runChipStyle(t, 'neutral')}>{run.owner}</span>}
                      <span style={runChipStyle(t, 'neutral')}>{formatResearchIntent(run.intent)}</span>
                      {syncStatus === 'changed' && <span style={runChipStyle(t, 'warning')}>Cell changed</span>}
                      {syncStatus === 'missing' && <span style={runChipStyle(t, 'error')}>Cell missing</span>}
                      <span style={runChipStyle(t, researchRunHasEvidence(run) ? 'success' : 'warning')}>
                        {researchRunHasEvidence(run) ? 'Evidence saved' : 'Needs evidence'}
                      </span>
                      <span style={runChipStyle(t, runReadinessTone(run))}>{runReadinessLabel(run)}</span>
                      {parameterReview && (
                        <span style={runChipStyle(t, parameterReview.tone)} title={parameterReview.title}>
                          {parameterReview.chipLabel}
                        </span>
                      )}
                      {ageState.stale && (
                        <span style={runChipStyle(t, ageState.tone)} title={ageState.detail}>
                          {ageState.label}
                        </span>
                      )}
                      {gateState.status !== 'passed' && (
                        <span style={runChipStyle(t, gateState.tone)} title={gateState.detail}>
                          {gateState.label}
                        </span>
                      )}
                      {run.dqlPromotionAction && <span style={runChipStyle(t, promotionActionTone(run.dqlPromotionAction))}>{formatPromotionAction(run.dqlPromotionAction)}</span>}
                      {run.resultPreview && <span style={runChipStyle(t, 'neutral')}>{runPreviewLabel(run)}</span>}
                      {run.draftBlockPath && <span style={runChipStyle(t, 'accent')}>Draft saved</span>}
                    </span>
                    <span style={nextActionLineStyle(t, nextAction.tone)}>
                      <span style={{ fontWeight: 900, color: toneColor(t, nextAction.tone), flexShrink: 0 }}>Next</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextAction.label}</span>
                    </span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end', flexShrink: 0 }}>
                    <span style={statusPillStyle(t, run)}>{runStatusLabel(run)}</span>
                    {run.reviewChecklist?.blockers.length ? <span style={runChipStyle(t, 'error')}>{run.reviewChecklist.blockers.length} blocker{run.reviewChecklist.blockers.length === 1 ? '' : 's'}</span> : null}
                  </span>
                </button>
                );
              })}
            </div>
            {(totalRunsForLabel > RESEARCH_PAGE_SIZE || pageOffset > 0) && (
              <div style={pagerStyle(t)}>
                <span>{pagerLabel(pageOffsetForLabel, pageEnd, totalRunsForLabel, visibleRuns.length, sourceSyncFilter, nextActionFilter)}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    disabled={busy || pageOffset === 0}
                    onClick={() => setPageOffset((offset) => Math.max(0, offset - RESEARCH_PAGE_SIZE))}
                    style={smallActionButtonStyle(t, busy || pageOffset === 0)}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={busy || pageEnd >= totalRunsForLabel}
                    onClick={() => setPageOffset((offset) => offset + RESEARCH_PAGE_SIZE)}
                    style={smallActionButtonStyle(t, busy || pageEnd >= totalRunsForLabel)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {activeRun && activeRunExternalNotebook && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Source notebook</span>
              <span style={runChipStyle(t, 'warning')}>Open required</span>
            </div>
            <div style={nextActionCardStyle(t, 'warning')}>
              <div style={{ fontSize: 12, fontWeight: 850, color: t.textPrimary }}>{activeRunNotebookTitle}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, color: t.textMuted }}>
                This research item belongs to {activeRun.notebookPath}. Open that notebook before syncing source SQL, previewing, checking reuse, or creating a DQL draft.
              </div>
              {onOpenNotebookFile && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                  <button type="button" onClick={() => openSourceNotebookForRun(activeRun)} disabled={busy} style={primaryButtonStyle(t, busy)}>
                    <ExternalLink size={14} strokeWidth={2} />
                    Open notebook
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {activeRun && activeNextAction && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Selected next step</span>
              <span style={runChipStyle(t, activeNextAction.tone)}>{activeNextAction.label}</span>
            </div>
            <div style={nextActionCardStyle(t, activeNextAction.tone)}>
              <div style={{ fontSize: 12, fontWeight: 850, color: t.textPrimary }}>{activeRun.title}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, color: t.textMuted }}>{activeNextAction.detail}</div>
              {activeNextActionCommand && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                  <button
                    type="button"
                    onClick={performActiveNextAction}
                    disabled={activeNextActionCommandDisabled}
                    style={primaryButtonStyle(t, activeNextActionCommandDisabled)}
                  >
                    <Check size={14} strokeWidth={2} />
                    {activeNextActionCommand}
                  </button>
                  {activeNextActionCommandDisabled && draftDisabledReason && activeNextAction.kind === 'create_dql_draft' && (
                    <span style={{ color: t.textMuted, fontSize: 11, lineHeight: 1.35 }}>{draftDisabledReason}</span>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {activeRun && activeWorkflowStages.length > 0 && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Research workflow</span>
              <span style={countPillStyle(t)}>{activeWorkflowStages.filter((stage) => stage.status === 'done').length}/{activeWorkflowStages.length} complete</span>
            </div>
            <div style={workflowGridStyle}>
              {activeWorkflowStages.map((stage, index) => (
                <WorkflowStage key={stage.id} index={index + 1} stage={stage} t={t} />
              ))}
            </div>
          </section>
        )}

        {activeRun && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Research dossier</span>
              <span style={statusPillStyle(t, activeRun)}>{runStatusLabel(activeRun)}</span>
            </div>
            <div style={dossierGridStyle}>
              {activeDossierItems.map((item) => (
                <div key={item.label} style={dossierItemStyle(t, item.tone)}>
                  <div style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', color: toneColor(t, item.tone) }}>{item.label}</div>
                  <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 800, color: t.textPrimary }}>{item.value}</div>
                  <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, lineHeight: 1.35, color: t.textMuted }}>{item.detail}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeRun && activeResearchPlan && (
          <section style={sectionStyle(t)}>
            <div style={sectionHeaderStyle(t)}>
              <span>Research plan</span>
              <span style={runChipStyle(t, researchPlanPathTone(activeResearchPlan.promotion.path))}>
                {formatResearchPlanPath(activeResearchPlan.promotion.path)}
              </span>
            </div>
            <div style={planGridStyle}>
              <PlanStat label="SQL" value={formatResearchPlanSqlState(activeResearchPlan.sqlState)} detail={activeResearchPlan.grain ? `Grain: ${activeResearchPlan.grain}` : 'Grain not declared'} tone={activeResearchPlan.sqlState === 'reviewed' ? 'success' : activeResearchPlan.sqlState === 'generated' ? 'warning' : 'error'} t={t} />
              <PlanStat label="Preview" value={formatResearchPlanPreview(activeResearchPlan)} detail={activeResearchPlan.preview.rowCount === undefined ? 'No row count yet' : `${activeResearchPlan.preview.rowCount.toLocaleString()} row${activeResearchPlan.preview.rowCount === 1 ? '' : 's'}`} tone={activeResearchPlan.preview.status === 'ready' ? 'success' : activeResearchPlan.preview.status === 'error' ? 'error' : 'warning'} t={t} />
              <PlanStat label="Evidence" value={`${activeResearchPlan.evidence.evidenceCount} saved`} detail={`${activeResearchPlan.evidence.relationCount} relations · ${activeResearchPlan.evidence.missingContextCount} gaps`} tone={activeResearchPlan.evidence.evidenceCount > 0 ? 'success' : 'warning'} t={t} />
              <PlanStat label="Parameters" value={activeResearchPlan.parameterPolicy.length ? `${activeResearchPlan.parameterPolicy.length} found` : 'Static check'} detail={activeResearchPlan.parameterPolicy.slice(0, 3).map((item) => item.name).join(', ') || 'No dynamic parameters detected'} tone={activeResearchPlan.parameterPolicy.some((item) => item.policy === 'dynamic') ? 'success' : 'warning'} t={t} />
            </div>
            {activeResearchPlan.allowedFilters.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {activeResearchPlan.allowedFilters.slice(0, 8).map((filter) => (
                  <span key={filter} style={countPillStyle(t)}>filter: {filter}</span>
                ))}
              </div>
            )}
            {activeResearchPlan.reviewFocus.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {activeResearchPlan.reviewFocus.slice(0, 4).map((item, index) => (
                  <div key={`${item}-${index}`} style={evidenceStyle(t)}>{item}</div>
                ))}
              </div>
            )}
          </section>
        )}

        <section style={sectionStyle(t)}>
          <div style={sectionHeaderStyle(t)}>
            <span>Reviewed SQL</span>
            <span style={countPillStyle(t)}>{currentIntentLabel}</span>
          </div>
          {activeSourceSync === 'changed' && (
            <div style={warningStyle(t)}>
              Source cell changed since this research run was seeded. Sync from the notebook cell, or keep the reviewed SQL as standalone evidence before rerunning or creating a DQL draft.
            </div>
          )}
          {activeSourceSync === 'missing' && (
            <div style={errorStyle(t)}>
              Source cell is missing from the notebook. Keep the reviewed SQL as standalone evidence before rerunning or creating a DQL draft.
            </div>
          )}
          {activeSourceTrust && (
            <div style={nextActionCardStyle(t, activeSourceTrust.tone)}>
              <div style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', color: toneColor(t, activeSourceTrust.tone) }}>Source trust</div>
              <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary }}>{activeSourceTrust.label}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, color: t.textMuted }}>{activeSourceTrust.detail}</div>
            </div>
          )}
          <textarea
            value={reviewedSql}
            onChange={(event) => setReviewedSql(event.target.value)}
            spellCheck={false}
            placeholder="AI-generated, selected source-cell, or pasted SQL appears here for review before DQL promotion."
            style={textareaStyle(t, 190, true)}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={saveEdits} disabled={busy || !activeRun} style={secondaryButtonStyle(t, busy || !activeRun)}>
              <Check size={14} strokeWidth={2} />
              Save review
            </button>
            <button type="button" onClick={insertSqlCell} disabled={!reviewedSql.trim()} style={secondaryButtonStyle(t, !reviewedSql.trim())}>
              <Send size={14} strokeWidth={2} />
              Insert SQL
            </button>
            <button type="button" onClick={insertNoteCell} disabled={!activeRun} style={secondaryButtonStyle(t, !activeRun)}>
              <FileText size={14} strokeWidth={2} />
              Add note
            </button>
            <button type="button" onClick={syncSourceFromCell} disabled={busy || activeSourceSync !== 'changed'} style={secondaryButtonStyle(t, busy || activeSourceSync !== 'changed')}>
              <RefreshCw size={14} strokeWidth={2} />
              Sync source
            </button>
            <button type="button" onClick={useReviewedSqlStandalone} disabled={busy || !sourceNeedsResolution || !reviewedSql.trim()} style={secondaryButtonStyle(t, busy || !sourceNeedsResolution || !reviewedSql.trim())}>
              <Unlink size={14} strokeWidth={2} />
              Use reviewed SQL
            </button>
          </div>
        </section>

        {activeRun && (
          <>
            {reviewChecklist && (
              <section style={sectionStyle(t)}>
                <div style={sectionHeaderStyle(t)}>
                  <span>Review checklist</span>
                  <span style={decisionPillStyle(t, reviewChecklist.readyForCertificationReview ? 'create_new' : reviewChecklist.readyForDqlDraft ? 'extend_existing' : 'review_required')}>
                    {reviewChecklist.readyForCertificationReview ? 'certification ready' : reviewChecklist.readyForDqlDraft ? 'draft ready' : 'needs work'}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                  {reviewChecklist.items.map((item) => (
                    <div key={item.id} style={checklistItemStyle(t, item.status)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={checkDotStyle(t, item.status)} />
                        <span style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                      </div>
                      <div style={{ color: t.textMuted, fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>{item.detail}</div>
                    </div>
                  ))}
                </div>
                {reviewChecklist.blockers.slice(0, 3).map((blocker, index) => (
                  <div key={`blocker-${index}`} style={errorStyle(t)}>{blocker}</div>
                ))}
                {reviewChecklist.warnings.slice(0, 3).map((warning, index) => (
                  <div key={`check-warning-${index}`} style={warningStyle(t)}>{warning}</div>
                ))}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void updateResearchReviewStatus(
                      'certified',
                      'Research marked certified and removed from active work.',
                      undefined,
                      activeRun.draftBlockPath
                        ? `Reviewer marked this notebook research certified after DQL draft review: ${activeRun.draftBlockPath}.`
                        : 'Reviewer marked this notebook research certified after DQL draft review.',
                    )}
                    disabled={busy || activeRun.reviewStatus === 'certified' || !reviewChecklist.readyForCertificationReview}
                    style={primaryButtonStyle(t, busy || activeRun.reviewStatus === 'certified' || !reviewChecklist.readyForCertificationReview)}
                    title={reviewChecklist.readyForCertificationReview
                      ? 'Close this research run after the linked DQL draft has been certified.'
                      : 'Certification requires reviewed SQL, evidence, preview, DQL draft, and resolved reuse decisions.'}
                  >
                    <BookOpenCheck size={14} strokeWidth={2} />
                    Mark certified
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateResearchReviewStatus(
                      'completed',
                      'Research marked complete.',
                      undefined,
                      'Reviewer marked this notebook research complete without certifying a new saved query.',
                    )}
                    disabled={busy || activeRun.reviewStatus === 'completed'}
                    style={secondaryButtonStyle(t, busy || activeRun.reviewStatus === 'completed')}
                  >
                    <Check size={14} strokeWidth={2} />
                    Complete
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateResearchReviewStatus('rejected', 'Research rejected and removed from active work.', 'Research rejected by reviewer.')}
                    disabled={busy || activeRun.reviewStatus === 'rejected'}
                    style={secondaryButtonStyle(t, busy || activeRun.reviewStatus === 'rejected')}
                  >
                    <X size={14} strokeWidth={2} />
                    Reject
                  </button>
                  {(activeRun.reviewStatus === 'completed' || activeRun.reviewStatus === 'certified' || activeRun.reviewStatus === 'rejected') && (
                    <button
                      type="button"
                      onClick={() => void updateResearchReviewStatus(
                        'needs_review',
                        'Research reopened for review.',
                        undefined,
                        'Reviewer reopened this notebook research run for another pass.',
                      )}
                      disabled={busy}
                      style={secondaryButtonStyle(t, busy)}
                    >
                      <RefreshCw size={14} strokeWidth={2} />
                      Reopen
                    </button>
                  )}
                </div>
              </section>
            )}

            <section style={sectionStyle(t)}>
              <div style={sectionHeaderStyle(t)}>
                <span>DQL draft</span>
                {activeRun.draftBlockPath && <span style={countPillStyle(t)}>created</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: activeRun.draftBlockPath ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
                <label style={fieldShellStyle(t)}>
                  <span style={labelStyle(t)}>Owner</span>
                  <input value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle(t)} />
                </label>
                <button type="button" onClick={promoteToDql} disabled={draftDisabled} style={primaryButtonStyle(t, draftDisabled)} title={draftDisabledReason}>
                  <BookOpenCheck size={14} strokeWidth={2} />
                  Create draft
                </button>
                {activeRun.draftBlockPath && (
                  <button type="button" onClick={openDqlDraft} disabled={openingDraft} style={secondaryButtonStyle(t, openingDraft)}>
                    {openingDraft ? <Loader2 size={14} strokeWidth={2} /> : <ExternalLink size={14} strokeWidth={2} />}
                    Open draft
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={checkDqlReuse}
                  disabled={reuseCheckDisabled}
                  style={secondaryButtonStyle(t, reuseCheckDisabled)}
                  title={sourceNeedsResolution ? 'Resolve source evidence before checking reuse' : 'Check reviewed SQL against existing saved queries before creating a draft'}
                >
                  {checkingReuse ? <Loader2 size={14} strokeWidth={2} /> : <Search size={14} strokeWidth={2} />}
                  Check reuse
                </button>
                {activeRun.dqlPromotionAction && (
                  <span style={decisionPillStyle(t, activeRun.dqlPromotionAction)}>{formatPromotionAction(activeRun.dqlPromotionAction)}</span>
                )}
              </div>
              {activeRun.draftBlockPath && <div style={pathStyle(t)}>{activeRun.draftBlockPath}</div>}
              {dqlPromotion && (
                <div style={promotionBoxStyle(t)}>
                  <div style={promotionHeaderStyle(t)}>
                    <span>Promotion decision</span>
                    <span style={decisionPillStyle(t, dqlPromotion.recommendedAction)}>{formatPromotionAction(dqlPromotion.recommendedAction)}</span>
                  </div>
                  {promotionMatches.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {promotionMatches.slice(0, 3).map((match, index) => (
                        <div key={`${match.objectKey ?? match.name}-${index}`} style={matchCardStyle(t)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{match.name}</span>
                            <span style={{ flexShrink: 0, color: t.textMuted }}>{Math.round(match.score * 100)}%</span>
                          </div>
                          <div style={runMetaStyle(t)}>{formatMatchKind(match.kind)} · {formatPromotionAction(match.recommendedAction)}</div>
                          <div style={{ color: t.textMuted, fontSize: 11, lineHeight: 1.35, marginTop: 4 }}>{match.reason}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={paragraphStyle(t)}>No reusable DQL duplicate was found in the selected project context.</div>
                  )}
                  {Boolean((promotionCandidate?.parameterPolicy.length ?? 0) + (promotionCandidate?.allowedFilters.length ?? 0)) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {(promotionCandidate?.parameterPolicy ?? []).slice(0, 6).map((param) => (
                        <span key={param.name} style={countPillStyle(t)}>{param.name}: {param.policy}</span>
                      ))}
                      {(promotionCandidate?.allowedFilters ?? []).slice(0, 6).map((filter) => (
                        <span key={filter} style={countPillStyle(t)}>filter: {filter}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {activeRun.summary && (
              <section style={sectionStyle(t)}>
                <div style={sectionHeaderStyle(t)}>
                  <span>Research summary</span>
                  {activeRun.display?.component && <span style={countPillStyle(t)}>{activeRun.display.component}</span>}
                </div>
                <p style={paragraphStyle(t)}>{activeRun.summary}</p>
                {activeRun.recommendation && <p style={paragraphStyle(t)}>{activeRun.recommendation}</p>}
                {activeRun.warnings.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {activeRun.warnings.slice(0, 4).map((warning, index) => (
                      <div key={`${warning}-${index}`} style={warningStyle(t)}>{warning}</div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {hasSavedContext && (
              <section style={sectionStyle(t)}>
                <div style={sectionHeaderStyle(t)}>
                  <span>Saved context</span>
                  <span style={countPillStyle(t)}>
                    {savedContextSummaries.length + savedContextRelations.length} items
                  </span>
                </div>
                <div style={contextPreviewHeaderStyle(t)}>
                  {savedContextTrust && <span style={runChipStyle(t, 'success')}>{savedContextTrust}</span>}
                  {savedContextRoute?.route && <span style={runChipStyle(t, 'neutral')}>{savedContextRoute.route}</span>}
                  {savedContextRoute?.intent && <span style={runChipStyle(t, 'neutral')}>{savedContextRoute.intent}</span>}
                  {savedContextPackId && <span style={countPillStyle(t)}>{savedContextPackId}</span>}
                </div>
                {savedContextRoute?.reason && <p style={paragraphStyle(t)}>{savedContextRoute.reason}</p>}
                {savedContextSummaries.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {savedContextSummaries.slice(0, 5).map((item, index) => (
                      <div key={`${item.title}-${index}`} style={evidenceStyle(t)}>
                        <div style={{ fontSize: 11, fontWeight: 850, color: t.textPrimary }}>{item.title}</div>
                        <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>{item.objectType ?? 'metadata evidence'}</div>
                        <div style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.4, marginTop: 4 }}>{item.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
                {savedContextRelations.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {savedContextRelations.slice(0, 10).map((relation) => (
                      <span
                        key={relation.relation}
                        style={countPillStyle(t)}
                        title={relation.columns.length ? relation.columns.join(', ') : relation.source}
                      >
                        {relation.name}{relation.columns.length ? ` · ${relation.columns.length} cols` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {savedContextMissing.slice(0, 4).map((item, index) => (
                  <div key={`${item.kind}-${index}`} style={item.severity === 'blocking' ? errorStyle(t) : warningStyle(t)}>
                    {item.kind}: {item.message}
                  </div>
                ))}
              </section>
            )}

            {activeRun.resultPreview && (
              <section style={sectionStyle(t)}>
                <div style={sectionHeaderStyle(t)}>
                  <span>Preview</span>
                  <span style={countPillStyle(t)}>{activeRun.resultPreview.rowCount ?? activeRun.resultPreview.rows.length} rows</span>
                </div>
                <div style={{ maxHeight: 260, overflow: 'auto' }}>
                  <TableOutput result={activeRun.resultPreview} themeMode={state.themeMode} />
                </div>
              </section>
            )}

            {evidenceItems.length > 0 && (
              <section style={sectionStyle(t)}>
                <div style={sectionHeaderStyle(t)}>
                  <span>Evidence</span>
                  <span style={countPillStyle(t)}>{evidenceItems.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {evidenceItems.slice(0, 8).map((item, index) => (
                    <div key={index} style={evidenceStyle(t)}>
                      {item}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
function inferDomain(path?: string, categories?: string[]): string {
  const category = categories?.find((item) => item && item.trim());
  if (category) return category.trim();
  const match = path?.match(/(?:^|\/)domains\/([^/]+)/);
  if (match) return match[1];
  return '';
}

function slugName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'research_sql';
}

function seedQuestionForCell(cell: SourceCellOption): string {
  const cleanName = cell.name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `What reusable business logic does ${cleanName || 'this query'} represent, and should it become a saved query?`;
}

function researchQuestionFromInput(question: string, source: SourceCellOption | null): string {
  const clean = question.trim();
  if (clean) return clean;
  return source ? seedQuestionForCell(source) : '';
}

function inferResearchIntentFromQuestion(question: string): NotebookResearchIntent {
  const text = question.toLowerCase();
  if (/\b(why|drop|increase|decrease|change|changed|trend|over time|week over week|month over month|year over year|yoy|mom)\b/.test(text)) {
    return 'diagnose_change';
  }
  if (/\b(driver|drivers|contribute|contribution|breakdown|explain|attributed|rank|ranking|top|bottom|leader|led)\b/.test(text)) {
    return 'driver_breakdown';
  }
  if (/\b(compare|versus| vs |segment|cohort|region|category|group|between)\b/.test(text)) {
    return 'segment_compare';
  }
  if (/\b(customer|account|player|team|product|order|entity|profile|detail|drill|drilldown)\b/.test(text)) {
    return 'entity_drilldown';
  }
  if (/\b(anomaly|anomalies|outlier|unexpected|spike|dip|unusual|exception)\b/.test(text)) {
    return 'anomaly_investigation';
  }
  if (/\b(trust|certify|duplicate|conflict|definition|lineage|validate|validation|replacement)\b/.test(text)) {
    return 'trust_gap_review';
  }
  return 'ad_hoc_analysis';
}

function researchPatternForIntent(intent: NotebookResearchIntent): ResearchPattern {
  return RESEARCH_PATTERNS.find((pattern) => pattern.id === intent) ?? RESEARCH_PATTERNS[0];
}

function researchPatternContext(pattern: ResearchPattern) {
  return {
    intent: pattern.id,
    label: pattern.label,
    dqlTarget: pattern.dqlTarget,
    focus: pattern.focus,
  };
}

function researchNoteMarkdown(run: NotebookResearchRun, sourceSync?: SourceSyncStatus | null): string {
  const checklist = run.reviewChecklist;
  const promotion = run.dqlPromotion;
  const candidate = promotion?.candidates[0];
  const matches = promotion?.similarityMatches ?? candidate?.similarityMatches ?? [];
  const evidence = selectedEvidence(run).slice(0, 5);
  const evidenceRecord = researchEvidenceRecord(run);
  const route = researchRouteDecision(run, evidenceRecord);
  const contextPackId = run.contextPackId ?? stringFromRecord(evidenceRecord, 'contextPackId');
  const trustLabel = researchTrustLabel(evidenceRecord);
  const evidenceSummaries = researchEvidenceSummaries(evidenceRecord).slice(0, 5);
  const allowedRelations = researchAllowedRelations(evidenceRecord).slice(0, 6);
  const missingContext = researchMissingContext(evidenceRecord).slice(0, 6);
  const previewRows = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length;
  const sourceTrust = sourceTrustSummary(run, sourceSync);
  const pattern = researchPatternForIntent(run.intent);
  const sections = [
    `### ${run.title}`,
    '',
    `**Question:** ${run.question}`,
    `**Research pattern:** ${formatResearchIntent(run.intent)} -> ${pattern.dqlTarget}`,
    run.domain ? `**Domain:** ${run.domain}` : '',
    run.owner ? `**Owner:** ${run.owner}` : '',
    run.sourceCellName ? `**Source cell:** ${run.sourceCellName}` : '',
    sourceTrust ? `**Source trust:** ${sourceTrust.label} - ${sourceTrust.detail}` : '',
    run.sourceCellFingerprint ? `**Source fingerprint:** \`${run.sourceCellFingerprint}\`` : '',
    trustLabel ? `**Trust:** ${trustLabel}` : '',
    contextPackId ? `**Context pack:** \`${contextPackId}\`` : '',
    route ? `**Route:** ${route.route}${route.intent ? ` / ${route.intent}` : ''}${route.reason ? ` - ${route.reason}` : ''}` : '',
    `**Status:** ${runStatusLabel(run)}${checklist ? ` · ${checklist.readyForCertificationReview ? 'certification ready' : checklist.readyForDqlDraft ? 'draft ready' : 'needs work'}` : ''}`,
    '',
    run.summary ? `**Summary**\n${run.summary}` : '',
    run.recommendation ? `**Recommendation**\n${run.recommendation}` : '',
    previewRows !== undefined ? `**Preview:** ${previewRows.toLocaleString()} row${previewRows === 1 ? '' : 's'}${run.resultPreview?.columns.length ? `, ${run.resultPreview.columns.length} column${run.resultPreview.columns.length === 1 ? '' : 's'}` : ''}` : '',
    run.draftBlockPath ? `**DQL draft:** \`${run.draftBlockPath}\`` : '',
    promotion ? [
      '**DQL promotion decision**',
      `- Action: ${formatPromotionAction(promotion.recommendedAction)}`,
      candidate?.parameterPolicy.length ? `- Parameters: ${candidate.parameterPolicy.slice(0, 8).map((item) => `${item.name} (${item.policy})`).join(', ')}` : '',
      candidate?.allowedFilters.length ? `- Allowed filters: ${candidate.allowedFilters.slice(0, 8).join(', ')}` : '',
      matches.length ? `- Similar saved queries: ${matches.slice(0, 3).map((match) => `${match.name} (${formatMatchKind(match.kind)}, ${Math.round(match.score * 100)}%)`).join('; ')}` : '- Similar saved queries: none found in selected context',
    ].filter(Boolean).join('\n') : '',
    checklist ? [
      '**Review checklist**',
      ...checklist.items.map((item) => `- ${checklistStatusLabel(item.status)} ${item.label}: ${item.detail}`),
    ].join('\n') : '',
    evidenceSummaries.length ? [
      '**Context summaries**',
      ...evidenceSummaries.map((item) => `- ${item.title}${item.objectType ? ` (${item.objectType})` : ''}: ${item.detail}`),
    ].join('\n') : '',
    allowedRelations.length ? [
      '**Allowed SQL context**',
      ...allowedRelations.map((relation) => `- ${relation.name || relation.relation}: ${relation.source || 'metadata'}${relation.columns.length ? ` (${relation.columns.slice(0, 8).join(', ')})` : ''}`),
    ].join('\n') : '',
    missingContext.length ? [
      '**Missing context**',
      ...missingContext.map((item) => `- ${item.severity}: ${item.kind} - ${item.message}`),
    ].join('\n') : '',
    checklist?.blockers.length ? `**Blockers**\n${checklist.blockers.map((item) => `- ${item}`).join('\n')}` : '',
    checklist?.warnings.length || run.warnings.length ? `**Warnings**\n${[...(checklist?.warnings ?? []), ...run.warnings].slice(0, 8).map((item) => `- ${item}`).join('\n')}` : '',
    evidence.length ? `**Evidence**\n${evidence.map((item) => `- ${item}`).join('\n')}` : '',
    '',
    `**Next action:** ${researchNoteNextAction(run)}`,
  ];
  return sections.filter((section) => section && section.trim()).join('\n\n');
}

function researchRegisterMarkdown(input: {
  notebookTitle: string;
  notebookPath: string;
  counts: {
    total: number;
    needsReview: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    dqlDrafts: number;
    errors: number;
    sourceLinked: number;
  };
  diagnostics: NotebookResearchDiagnostics | null;
  sourceCellCount: number;
  currentSourceCoveredCount: number;
  coverageItems: SourceCoverageItem[];
  portfolio: {
    notebooks: Array<{ title: string; path: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>;
    domains: Array<{ domain: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>;
    owners: Array<{ owner: string; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>;
    intents: Array<{ intent: NotebookResearchIntent; total: number; draftReady: number; certificationReady: number; blocked: number; staleOpen: number; expiredOpen: number; nextAction?: DurableNotebookResearchNextActionFilter; nextActionCount?: number }>;
    groupCounts: { notebooks: number; domains: number; owners: number; intents: number };
  };
  runs: NotebookResearchRun[];
  totalRuns: number;
  runLimit: number;
  limitCaveat: string;
  filterSummary: string[];
  worklistItems: ResearchWorklistItem[];
}): string {
  const now = new Date().toISOString();
	  const worklistRows = input.worklistItems.slice(0, 20).map((item, index) => {
	    const syncStatus = item.sourceItem && item.sourceItem.status !== 'unresearched' ? item.sourceItem.status : null;
	    const next = item.run ? researchNextAction(item.run, syncStatus) : null;
	    const workflow = item.run && next ? researchWorkflowSummary(item.run, syncStatus, next) : null;
	    return [
	      String(index + 1),
	      markdownTableCell(item.title),
	      markdownTableCell(workflow ? `${workflow.progress} ${workflow.label}` : 'Source coverage'),
	      markdownTableCell(item.actionLabel),
	      markdownTableCell(item.reason),
	      markdownTableCell(item.statusLabel),
	      markdownTableCell(item.detail),
	    ];
	  });
  const coverageRows = input.coverageItems.slice(0, 100).map((item) => {
    const next = item.nextAction ?? (item.run ? researchNextAction(item.run, item.status === 'unresearched' ? null : item.status) : null);
    return [
      markdownTableCell(item.cell.name),
      markdownTableCell(sourceCoverageLabel(item)),
      markdownTableCell(next?.label ?? 'Start research'),
      markdownTableCell(item.run?.draftBlockPath ?? ''),
    ];
  });
	  const runRows = input.runs.slice(0, 50).map((run) => {
    const coverage = input.coverageItems.find((item) => item.run?.id === run.id);
    const syncStatus = coverage && coverage.status !== 'unresearched' ? coverage.status : null;
    const next = researchNextAction(run, syncStatus);
    const workflow = researchWorkflowSummary(run, syncStatus, next);
    const age = researchAgeState(run);
    const gate = researchGateState(run);
    return [
      markdownTableCell(run.title),
      markdownTableCell(run.domain ?? 'uncategorized'),
      markdownTableCell(run.owner ?? ''),
      markdownTableCell(formatResearchIntent(run.intent)),
      markdownTableCell(`${workflow.progress} ${workflow.label}`),
      markdownTableCell(formatResearchRegisterPlan(run)),
      markdownTableCell(runReadinessLabel(run)),
      markdownTableCell(gate.label),
      markdownTableCell(age.label),
	      markdownTableCell(runParameterReviewLabel(run)),
	      markdownTableCell(next.label),
	      markdownTableCell(next.detail),
	      markdownTableCell(run.sourceCellName ?? ''),
	    ];
		  });
  const portfolioRows = [
    ...input.portfolio.notebooks.map((item) => researchRegisterPortfolioRow({
      group: 'Notebook',
      label: item.title,
      detail: item.path,
      total: item.total,
      blocked: item.blocked,
      draftReady: item.draftReady,
      certificationReady: item.certificationReady,
      staleOpen: item.staleOpen,
      expiredOpen: item.expiredOpen,
      nextAction: item.nextAction,
      nextActionCount: item.nextActionCount,
    })),
    ...input.portfolio.domains.map((item) => researchRegisterPortfolioRow({
      group: 'Domain',
      label: item.domain,
      detail: '',
      total: item.total,
      blocked: item.blocked,
      draftReady: item.draftReady,
      certificationReady: item.certificationReady,
      staleOpen: item.staleOpen,
      expiredOpen: item.expiredOpen,
      nextAction: item.nextAction,
      nextActionCount: item.nextActionCount,
    })),
    ...input.portfolio.owners.map((item) => researchRegisterPortfolioRow({
      group: 'Owner',
      label: item.owner,
      detail: '',
      total: item.total,
      blocked: item.blocked,
      draftReady: item.draftReady,
      certificationReady: item.certificationReady,
      staleOpen: item.staleOpen,
      expiredOpen: item.expiredOpen,
      nextAction: item.nextAction,
      nextActionCount: item.nextActionCount,
    })),
    ...input.portfolio.intents.map((item) => researchRegisterPortfolioRow({
      group: 'Pattern',
      label: formatResearchIntent(item.intent),
      detail: '',
      total: item.total,
      blocked: item.blocked,
      draftReady: item.draftReady,
      certificationReady: item.certificationReady,
      staleOpen: item.staleOpen,
      expiredOpen: item.expiredOpen,
      nextAction: item.nextAction,
      nextActionCount: item.nextActionCount,
    })),
  ];
  const portfolioShown = {
    notebooks: input.portfolio.notebooks.length,
    domains: input.portfolio.domains.length,
    owners: input.portfolio.owners.length,
    intents: input.portfolio.intents.length,
  };
  const portfolioHidden = {
    notebooks: Math.max(0, input.portfolio.groupCounts.notebooks - portfolioShown.notebooks),
    domains: Math.max(0, input.portfolio.groupCounts.domains - portfolioShown.domains),
    owners: Math.max(0, input.portfolio.groupCounts.owners - portfolioShown.owners),
    intents: Math.max(0, input.portfolio.groupCounts.intents - portfolioShown.intents),
  };
  const promotionRows = researchRegisterPromotionRows(input.runs);
  const duplicateReviewCount = promotionRows
    .filter((row) => row.kind === 'reuse_existing' || row.kind === 'extend_existing' || row.kind === 'create_replacement')
    .reduce((sum, row) => sum + row.count, 0);
  const pendingPromotionCount = promotionRows.find((row) => row.kind === 'pending')?.count ?? 0;
  const promotionRunCount = promotionRows.reduce((sum, row) => sum + row.count, 0);
	  const healthLines = input.diagnostics ? researchRegisterHealthLines(input.diagnostics) : [];
	  const lines = [
    '## Notebook Research Register',
    '',
    `**Notebook:** ${input.notebookTitle || input.notebookPath || 'Untitled notebook'}`,
    input.notebookPath ? `**Path:** \`${input.notebookPath}\`` : '',
    `**Generated:** ${now}`,
    input.filterSummary.length ? `**Filters:** ${input.filterSummary.join(' · ')}` : '**Filters:** none',
    `**Included runs:** ${input.runs.length.toLocaleString()}${input.totalRuns > input.runs.length ? ` of ${input.totalRuns.toLocaleString()}` : ''}${input.totalRuns > input.runLimit ? ` · capped at ${input.runLimit.toLocaleString()}` : ''}`,
    input.limitCaveat ? `**Limit note:** ${input.limitCaveat}` : '',
    '',
    [
      `**Runs:** ${input.counts.total.toLocaleString()}`,
      `**Covered cells:** ${Math.min(input.currentSourceCoveredCount, input.sourceCellCount).toLocaleString()}/${input.sourceCellCount.toLocaleString()}`,
      `**Needs review:** ${input.counts.needsReview.toLocaleString()}`,
      `**Draft ready:** ${input.counts.draftReady.toLocaleString()}`,
      `**Cert ready:** ${input.counts.certificationReady.toLocaleString()}`,
      `**Blocked:** ${input.counts.blocked.toLocaleString()}`,
      `**Stale:** ${input.counts.staleOpen.toLocaleString()}`,
      `**30d+:** ${input.counts.expiredOpen.toLocaleString()}`,
      `**Drafts:** ${input.counts.dqlDrafts.toLocaleString()}`,
      `**Errors:** ${input.counts.errors.toLocaleString()}`,
    ].join(' · '),
    promotionRows.length ? `**DQL promotion decisions:** ${duplicateReviewCount.toLocaleString()} reuse/extension/replacement review${duplicateReviewCount === 1 ? '' : 's'} · ${pendingPromotionCount.toLocaleString()} pending · ${promotionRunCount.toLocaleString()} run${promotionRunCount === 1 ? '' : 's'} summarized` : '**DQL promotion decisions:** none captured yet',
	    healthLines.length ? '### Project Health' : '',
	    healthLines.length ? healthLines.join('\n') : '',
	    '',
    '### DQL Promotion Decisions',
    '',
    promotionRows.length
      ? [
          '| Decision | Runs | Example evidence |',
          '|---|---|---|',
          ...promotionRows.map((row) => `| ${markdownTableCell(row.label)} | ${row.count.toLocaleString()} | ${markdownTableCell(row.evidence)} |`),
        ].join('\n')
      : 'No DQL promotion or reuse decisions have been captured for the current register filters.',
    '',
    '### Portfolio Map',
    '',
    [
      portfolioSummaryLabel(input.portfolio.groupCounts.notebooks, 'notebook', portfolioShown.notebooks),
      portfolioSummaryLabel(input.portfolio.groupCounts.domains, 'domain', portfolioShown.domains),
      portfolioSummaryLabel(input.portfolio.groupCounts.owners, 'owner', portfolioShown.owners),
      portfolioSummaryLabel(input.portfolio.groupCounts.intents, 'pattern', portfolioShown.intents),
    ].join(' · '),
    portfolioRows.length
      ? [
          '| Group | Name | Runs | Next action | Blocked | Stale | 30d+ | Draft ready | Cert ready | Detail |',
          '|---|---|---|---|---|---|---|---|---|---|',
          ...portfolioRows.map((row) => `| ${row.join(' | ')} |`),
          portfolioHidden.notebooks || portfolioHidden.domains || portfolioHidden.owners || portfolioHidden.intents
            ? `\nHidden groups: ${[
                portfolioHidden.notebooks ? `${portfolioHidden.notebooks.toLocaleString()} notebook${portfolioHidden.notebooks === 1 ? '' : 's'}` : '',
                portfolioHidden.domains ? `${portfolioHidden.domains.toLocaleString()} domain${portfolioHidden.domains === 1 ? '' : 's'}` : '',
                portfolioHidden.owners ? `${portfolioHidden.owners.toLocaleString()} owner${portfolioHidden.owners === 1 ? '' : 's'}` : '',
                portfolioHidden.intents ? `${portfolioHidden.intents.toLocaleString()} pattern${portfolioHidden.intents === 1 ? '' : 's'}` : '',
              ].filter(Boolean).join(', ')}. Use Search or typed filters for complete drilldown.`
            : '',
        ].filter(Boolean).join('\n')
      : 'No notebook, domain, owner, or pattern groups are currently visible.',
    '',
	    '### Priority Worklist',
    '',
    worklistRows.length
      ? [
	          '| # | Item | Workflow | Action | Why next | Status | Detail |',
	          '|---|---|---|---|---|---|---|',
          ...worklistRows.map((row) => `| ${row.join(' | ')} |`),
          input.worklistItems.length > worklistRows.length ? `\nShowing first ${worklistRows.length.toLocaleString()} priority items from the current filters.` : '',
        ].filter(Boolean).join('\n')
      : 'No priority work is currently visible for the selected filters.',
    '',
    '### Research Queue',
    '',
    runRows.length
      ? [
	          '| Title | Domain | Owner | Pattern | Workflow | Plan | Readiness | Gate | Age | Parameters | Next action | Why next | Source cell |',
	          '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
          ...runRows.map((row) => `| ${row.join(' | ')} |`),
          input.runs.length > runRows.length ? `\nShowing first ${runRows.length.toLocaleString()} research runs from the current register snapshot.` : '',
        ].filter(Boolean).join('\n')
      : 'No research runs have been created yet.',
    '',
    '### Source Coverage',
    '',
    coverageRows.length
      ? [
          '| Source cell | Coverage | Next action | DQL draft |',
          '|---|---|---|---|',
          ...coverageRows.map((row) => `| ${row.join(' | ')} |`),
          input.coverageItems.length > coverageRows.length ? `\nShowing first ${coverageRows.length.toLocaleString()} source cells.` : '',
        ].filter(Boolean).join('\n')
      : 'No SQL or DQL source cells were found in this notebook.',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

function researchRegisterPortfolioRow(input: {
  group: string;
  label: string;
  detail: string;
  total: number;
  blocked: number;
  draftReady: number;
  certificationReady: number;
  staleOpen: number;
  expiredOpen: number;
  nextAction?: DurableNotebookResearchNextActionFilter;
  nextActionCount?: number;
}): string[] {
  const nextAction = input.nextAction
    ? `${formatResearchNextActionFilter(input.nextAction)}${input.nextActionCount ? ` (${input.nextActionCount.toLocaleString()})` : ''}`
    : '';
  return [
    markdownTableCell(input.group),
    markdownTableCell(input.label),
    input.total.toLocaleString(),
    markdownTableCell(nextAction),
    input.blocked.toLocaleString(),
    input.staleOpen.toLocaleString(),
    input.expiredOpen.toLocaleString(),
    input.draftReady.toLocaleString(),
    input.certificationReady.toLocaleString(),
    markdownTableCell(input.detail),
  ];
}

function researchRegisterPromotionRows(runs: NotebookResearchRun[]): Array<{ kind: string; label: string; count: number; evidence: string }> {
  const byKind = new Map<string, NotebookResearchRun[]>();
  for (const run of runs) {
    const kind = run.dqlPromotionAction ?? run.dqlPromotion?.recommendedAction ?? 'pending';
    byKind.set(kind, [...(byKind.get(kind) ?? []), run]);
  }
  const order = ['reuse_existing', 'extend_existing', 'create_replacement', 'create_new', 'review_required', 'pending'];
  return order.flatMap((kind) => {
    const grouped = byKind.get(kind) ?? [];
    if (grouped.length === 0) return [];
    return [{
      kind,
      label: kind === 'pending' ? 'Pending promotion review' : formatPromotionAction(kind),
      count: grouped.length,
      evidence: promotionGroupEvidence(grouped),
    }];
  });
}

function promotionGroupEvidence(runs: NotebookResearchRun[]): string {
  const examples = runs.slice(0, 3).map((run) => {
    const match = run.dqlPromotion?.similarityMatches?.[0];
    if (match) return `${run.title} -> ${match.name} (${Math.round(match.score * 100)}%)`;
    if (run.draftBlockPath) return `${run.title} -> ${run.draftBlockPath}`;
    return run.title;
  });
  return examples.join('; ');
}

function isResearchRegisterCell(cell: Cell): boolean {
  if (cell.type !== 'markdown') return false;
  const content = cell.content ?? '';
  return cell.name === RESEARCH_REGISTER_CELL_NAME
    || /^\s*## Notebook Research Register\b/m.test(content);
}

function isExternalNotebookRun(run: NotebookResearchRun | null | undefined, currentNotebookPath: string): boolean {
  return Boolean(run?.notebookPath && currentNotebookPath && run.notebookPath !== currentNotebookPath);
}

function researchSourceSyncForRun(
  run: NotebookResearchRun | null,
  sourceCellById: Map<string, SourceCellOption>,
  currentNotebookPath: string,
): SourceSyncStatus | null {
  if (isExternalNotebookRun(run, currentNotebookPath)) return null;
  return sourceSyncStatus(run, sourceCellById);
}

function notebookFileFromPath(path: string): NotebookFile {
  const name = path.split('/').pop() || 'notebook.dqlnb';
  return {
    name,
    path,
    type: 'notebook',
    folder: path.split('/')[0] || 'notebooks',
  };
}

function notebookDisplayName(path: string, name?: string): string {
  const label = name || path.split('/').pop() || path;
  return label.replace(/\.(dqlnb|ipynb)$/i, '');
}

function researchRunLocationLabel(
  run: NotebookResearchRun,
  notebookTitleByPath: Map<string, string>,
  currentNotebookPath: string,
): string {
  const notebookLabel = run.notebookPath
    ? notebookTitleByPath.get(run.notebookPath) ?? notebookDisplayName(run.notebookPath)
    : '';
  if (run.sourceCellName && isExternalNotebookRun(run, currentNotebookPath)) {
    return `${notebookLabel || run.notebookPath} · ${run.sourceCellName}`;
  }
  return run.sourceCellName || notebookLabel || run.notebookPath;
}

function researchRegisterHealthLines(diagnostics: NotebookResearchDiagnostics): string[] {
  const searchStatus = diagnostics.search.stale
    ? 'stale'
    : diagnostics.search.indexed
      ? 'active'
      : 'fallback';
  const lines = [
    [
      `**Search:** ${searchStatus}`,
      diagnostics.search.indexed ? `${diagnostics.search.indexRows.toLocaleString()} indexed` : 'local scan',
      diagnostics.search.indexVersion ? `index v${diagnostics.search.indexVersion}` : '',
    ].filter(Boolean).join(' · '),
    [
      `**Backlog:** ${diagnostics.counts.activeRuns.toLocaleString()} open`,
      `${diagnostics.counts.closedRuns.toLocaleString()} closed`,
      `${diagnostics.counts.totalRuns.toLocaleString()} total`,
    ].join(' · '),
    [
      `**Aging:** ${diagnostics.health.staleOpenRuns.toLocaleString()} open ${diagnostics.health.staleThresholdDays}+d`,
      `${diagnostics.health.expiredOpenRuns.toLocaleString()} open ${diagnostics.health.expiredThresholdDays}+d`,
      diagnostics.health.oldestOpenUpdatedAt ? `oldest open ${diagnostics.health.oldestOpenUpdatedAt}` : '',
    ].filter(Boolean).join(' · '),
    [
      `**Coverage:** ${diagnostics.counts.sourceLinkedRuns.toLocaleString()} source-linked runs`,
      `${diagnostics.counts.notebooks.toLocaleString()} notebook${diagnostics.counts.notebooks === 1 ? '' : 's'}`,
      `${diagnostics.counts.domains.toLocaleString()} domain${diagnostics.counts.domains === 1 ? '' : 's'}`,
      `${diagnostics.counts.owners.toLocaleString()} owner${diagnostics.counts.owners === 1 ? '' : 's'}`,
    ].join(' · '),
    [
      `**Queue limits:** ${diagnostics.limits.pageSize.toLocaleString()} default page`,
      `${diagnostics.limits.maxPageSize.toLocaleString()} max page`,
      `${diagnostics.limits.sourceCoverageLimit.toLocaleString()} source coverage`,
    ].join(' · '),
  ];
  if (diagnostics.updatedAt.newest) {
    lines.push(`**Latest update:** ${diagnostics.updatedAt.newest}`);
  }
  if (diagnostics.warnings.length > 0) {
    lines.push(`**Warnings:** ${diagnostics.warnings.slice(0, 3).join(' · ')}`);
  }
  return lines;
}

function researchRegisterFilterSummary(input: {
  runScope: ResearchScope;
  runSearch: string;
  runFilter: RunFilter;
  runNotebookFilter: string;
  runDomainFilter: string;
  runOwnerFilter: string;
  runIntentFilter: NotebookResearchIntent | '';
  runSort: NotebookResearchSort;
  sourceSyncFilter: SourceSyncFilter;
  sourceCoverageFilter: SourceCoverageFilter;
  nextActionFilter: ResearchNextActionFilter;
}): string[] {
  const filters = [`Scope: ${input.runScope === 'notebook' ? 'notebook' : 'project'}`];
  if (input.runSearch.trim()) filters.push(`Search: ${input.runSearch.trim()}`);
  filters.push(`Show: ${formatRunFilter(input.runFilter)}`);
  if (input.runNotebookFilter.trim()) filters.push(`Notebook: ${input.runNotebookFilter.trim()}`);
  if (input.runDomainFilter.trim()) filters.push(`Domain: ${input.runDomainFilter.trim()}`);
  if (input.runOwnerFilter.trim()) filters.push(`Owner: ${input.runOwnerFilter.trim()}`);
  if (input.runIntentFilter) filters.push(`Intent: ${formatResearchIntent(input.runIntentFilter)}`);
  if (input.sourceSyncFilter !== 'all') filters.push(`Source: ${formatSourceSyncFilter(input.sourceSyncFilter)}`);
  if (input.sourceCoverageFilter !== 'all') filters.push(`Coverage: ${formatSourceCoverageFilter(input.sourceCoverageFilter)}`);
  if (input.nextActionFilter !== 'all') filters.push(`Next: ${formatResearchNextActionFilter(input.nextActionFilter)}`);
  filters.push(`Order: ${input.runSort === 'priority' ? 'work queue' : 'recent activity'}`);
  return filters;
}

function markdownTableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() || ' ';
}

function runParameterReviewLabel(run: NotebookResearchRun): string {
  return runParameterReviewSummary(run)?.registerLabel ?? '';
}

function formatResearchRegisterPlan(run: NotebookResearchRun): string {
  const plan = run.researchPlan;
  if (!plan) return 'No plan';
  const parts = [
    formatResearchPlanPath(plan.promotion.path),
    formatResearchPlanSqlState(plan.sqlState),
    plan.preview.status === 'ready' && plan.preview.rowCount !== undefined ? `${plan.preview.rowCount} rows` : formatResearchPlanPreview(plan),
  ];
  if (plan.grain) parts.push(`grain: ${plan.grain}`);
  return parts.join('; ');
}

function runParameterReviewSummary(run: NotebookResearchRun): { chipLabel: string; registerLabel: string; tone: ResearchTone; title: string } | null {
  const promotedPolicy = run.dqlPromotion?.candidates.flatMap((candidate) => candidate.parameterPolicy ?? []) ?? [];
  const dynamicPromoted = promotedPolicy.filter((item) => item.policy === 'dynamic');
  if (dynamicPromoted.length > 0) {
    const label = dynamicPromoted.slice(0, 4).map((item) => item.name).join(', ');
    return {
      chipLabel: `Params: ${label}`,
      registerLabel: label,
      tone: 'success',
      title: 'Reusable dynamic parameters were detected for this DQL promotion candidate.',
    };
  }
  if (promotedPolicy.length > 0) {
    const label = promotedPolicy.slice(0, 4).map((item) => `${item.name} (${item.policy})`).join(', ');
    return {
      chipLabel: `Params: ${label}`,
      registerLabel: label,
      tone: 'warning',
      title: 'Parameter policy was generated during DQL promotion. Review static or review-required parameters before certification.',
    };
  }
  const item = run.reviewChecklist?.items.find((check) => check.id === 'parameters');
  if (!item) return null;
  if (item.status === 'passed') {
    const match = item.detail.match(/: (.+)\.$/);
    const label = match?.[1] ?? 'Dynamic params';
    return {
      chipLabel: `Params: ${label}`,
      registerLabel: label,
      tone: 'success',
      title: item.detail,
    };
  }
  if (item.status === 'warning') {
    return {
      chipLabel: 'Static scope',
      registerLabel: 'Review static scope',
      tone: 'warning',
      title: item.detail,
    };
  }
  if (item.status === 'blocked') {
    return {
      chipLabel: 'Param blocker',
      registerLabel: 'Parameter blocker',
      tone: 'error',
      title: item.detail,
    };
  }
  return {
    chipLabel: 'Params pending',
    registerLabel: 'Pending',
    tone: 'neutral',
    title: item.detail,
  };
}

function checklistStatusLabel(status: string): string {
  if (status === 'passed') return '[passed]';
  if (status === 'blocked') return '[blocked]';
  if (status === 'warning') return '[review]';
  return '[pending]';
}

function researchEvidenceRecord(run: NotebookResearchRun): Record<string, unknown> | null {
  return run.evidence && typeof run.evidence === 'object' && !Array.isArray(run.evidence)
    ? run.evidence as Record<string, unknown>
    : null;
}

function researchRunHasEvidence(run: NotebookResearchRun): boolean {
  if (run.contextPackId) return true;
  const evidence = researchEvidenceRecord(run);
  if (!evidence) return false;
  if (stringFromRecord(evidence, 'contextPackId')) return true;
  return ['selectedEvidence', 'citations', 'evidenceRoles', 'evidenceSummaries'].some((key) => {
    const value = evidence[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function stringFromRecord(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function researchTrustLabel(evidence: Record<string, unknown> | null): string | undefined {
  const trust = nestedRecord(evidence, 'trustStatus');
  return stringFromRecord(trust, 'label');
}

function researchRouteDecision(
  run: NotebookResearchRun,
  evidence: Record<string, unknown> | null,
): { route: string; intent?: string; reason?: string } | null {
  const source = run.routeDecision && typeof run.routeDecision === 'object' && !Array.isArray(run.routeDecision)
    ? run.routeDecision as Record<string, unknown>
    : nestedRecord(evidence, 'routeDecision');
  const route = stringFromRecord(source, 'route');
  if (!route) return null;
  return {
    route,
    intent: stringFromRecord(source, 'intent'),
    reason: stringFromRecord(source, 'reason'),
  };
}

function researchEvidenceSummaries(evidence: Record<string, unknown> | null): Array<{ title: string; detail: string; objectType?: string }> {
  const raw = evidence?.evidenceSummaries;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Array<{ title: string; detail: string; objectType?: string }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const title = stringFromRecord(record, 'title') ?? stringFromRecord(record, 'name');
    const detail = stringFromRecord(record, 'detail') ?? stringFromRecord(record, 'reason');
    if (!title || !detail) return [];
    return [{
      title,
      detail,
      objectType: stringFromRecord(record, 'objectType'),
    }];
  });
}

function researchAllowedRelations(evidence: Record<string, unknown> | null): Array<{ relation: string; name: string; source?: string; columns: string[] }> {
  const allowed = nestedRecord(evidence, 'allowedSqlContext');
  const diagnostics = nestedRecord(evidence, 'retrievalDiagnostics');
  const raw = Array.isArray(allowed?.relations)
    ? allowed.relations
    : Array.isArray(diagnostics?.selectedRelations)
      ? diagnostics.selectedRelations
      : [];
  return raw.flatMap((item): Array<{ relation: string; name: string; source?: string; columns: string[] }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const relation = stringFromRecord(record, 'relation') ?? stringFromRecord(record, 'name');
    if (!relation) return [];
    return [{
      relation,
      name: stringFromRecord(record, 'name') ?? relation,
      source: stringFromRecord(record, 'source'),
      columns: Array.isArray(record.columns) ? record.columns.map(String).slice(0, 16) : [],
    }];
  });
}

function researchMissingContext(evidence: Record<string, unknown> | null): Array<{ kind: string; message: string; severity: string }> {
  const raw = evidence?.missingContext;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Array<{ kind: string; message: string; severity: string }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const message = stringFromRecord(record, 'message');
    if (!message) return [];
    return [{
      kind: stringFromRecord(record, 'kind') ?? 'metadata',
      message,
      severity: stringFromRecord(record, 'severity') ?? 'warning',
    }];
  });
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function researchNoteNextAction(run: NotebookResearchRun): string {
  return researchNextAction(run).detail;
}

function isDurableNextActionFilter(value: ResearchNextActionFilter): value is DurableNotebookResearchNextActionFilter {
  return value === 'fix_blockers'
    || value === 'review_sql'
    || value === 'review_context'
    || value === 'run_preview'
    || value === 'reuse_existing'
    || value === 'create_dql_draft'
    || value === 'open_certification'
    || value === 'complete_review'
    || value === 'continue_review';
}

function runFilterRequest(filter: RunFilter): {
  status?: NotebookResearchStatus;
  reviewStatus?: NotebookResearchReviewStatus;
  promotionAction?: NotebookResearchDqlPromotionAction;
  readiness?: NotebookResearchReadinessFilter;
  age?: NotebookResearchAgeFilter;
  activeOnly?: boolean;
} {
  if (filter === 'open_work') return { activeOnly: true };
  if (filter === 'ready') return { status: 'ready' };
  if (filter === 'error') return { status: 'error' };
  if (filter === 'draft') return { reviewStatus: 'needs_review' };
  if (filter === 'dql_draft') return { reviewStatus: 'draft_created' };
  if (filter === 'completed') return { reviewStatus: 'completed' };
  if (filter === 'rejected') return { reviewStatus: 'rejected' };
  if (filter === 'draft_ready' || filter === 'certification_ready' || filter === 'blocked') {
    return { readiness: filter };
  }
  if (filter === 'stale_open' || filter === 'expired_open') {
    return { age: filter };
  }
  if (filter === 'reuse_existing' || filter === 'extend_existing' || filter === 'create_replacement' || filter === 'create_new') {
    return { promotionAction: filter };
  }
  return {};
}

function researchRunMatchesLocalListFilters(
  run: NotebookResearchRun,
  filters: {
    runSearch: string;
    runFilter: RunFilter;
    runNotebookFilter: string;
    runDomainFilter: string;
    runOwnerFilter: string;
    runIntentFilter: NotebookResearchIntent | '';
  },
): boolean {
  const request = runFilterRequest(filters.runFilter);
  if (request.activeOnly && isClosedResearchRun(run)) return false;
  if (request.status && run.status !== request.status) return false;
  if (request.reviewStatus && run.reviewStatus !== request.reviewStatus) return false;
  if (request.promotionAction && run.dqlPromotionAction !== request.promotionAction) return false;
  if (request.readiness === 'draft_ready' && !run.reviewChecklist?.readyForDqlDraft) return false;
  if (request.readiness === 'certification_ready' && !run.reviewChecklist?.readyForCertificationReview) return false;
  if (request.readiness === 'blocked' && !(run.status === 'error' || run.reviewChecklist?.blockers.length)) return false;
  if (request.age === 'stale_open' && (isClosedResearchRun(run) || researchAgeState(run).daysOpen < 7)) return false;
  if (request.age === 'expired_open' && (isClosedResearchRun(run) || researchAgeState(run).daysOpen < 30)) return false;
  if (filters.runNotebookFilter.trim() && run.notebookPath !== filters.runNotebookFilter.trim()) return false;
  if (filters.runDomainFilter.trim()) {
    const expected = filters.runDomainFilter.trim().toLowerCase();
    const actual = (run.domain ?? 'uncategorized').trim().toLowerCase();
    if (actual !== expected) return false;
  }
  if (filters.runOwnerFilter.trim()) {
    const expected = filters.runOwnerFilter.trim().toLowerCase();
    const actual = (run.owner ?? '').trim().toLowerCase();
    if (actual !== expected) return false;
  }
  if (filters.runIntentFilter && run.intent !== filters.runIntentFilter) return false;
  if (!researchRunMatchesSearch(run, filters.runSearch)) return false;
  return true;
}

function researchRunMatchesSearch(run: NotebookResearchRun, search: string): boolean {
  return researchTextMatchesSearch(search, [
    run.id,
    run.title,
    run.question,
    run.domain ?? 'uncategorized',
    run.owner ?? '',
    run.intent,
    run.sourceCellId ?? '',
    run.sourceCellName ?? '',
    run.sourceCellFingerprint ?? '',
    run.notebookPath,
    run.summary ?? '',
    run.recommendation ?? '',
    run.warnings.join(' '),
    run.draftBlockPath ?? '',
    run.dqlPromotionAction ?? '',
    run.generatedSql ?? '',
    run.reviewedSql ?? '',
    researchSearchText(run.context),
    researchSearchText(run.resultPreview),
    researchSearchText(run.evidence),
    researchSearchText(run.researchPlan),
    run.contextPackId ?? '',
    researchSearchText(run.routeDecision),
    researchSearchText(run.display),
    run.error ?? '',
    run.dqlImportId ?? '',
    run.dqlCandidateIds.join(' '),
    researchSearchText(run.dqlPromotion),
  ]);
}

function sourceCoverageItemMatchesSearch(item: SourceCoverageItem, search: string): boolean {
  const run = item.run;
  return researchTextMatchesSearch(search, [
    item.cell.id,
    item.cell.name,
    item.cell.type,
    item.cell.fingerprint,
    item.cell.sql,
    item.status,
    run?.id,
    run?.title,
    run?.question,
    run?.domain,
    run?.intent,
    run?.sourceCellId,
    run?.sourceCellName,
    run?.sourceCellFingerprint,
    run?.summary,
    run?.recommendation,
    run?.generatedSql,
    run?.reviewedSql,
    run ? researchSearchText(run.context) : '',
    run ? researchSearchText(run.evidence) : '',
    run ? researchSearchText(run.researchPlan) : '',
    run?.dqlPromotionAction,
    run ? researchSearchText(run.dqlPromotion) : '',
  ]);
}

function researchTextMatchesSearch(search: string, values: unknown[]): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const haystack = values.map((value) => researchSearchText(value)).join(' ').toLowerCase();
  const tokens = researchSearchTokens(query);
  if (tokens.length) return tokens.every((token) => haystack.includes(token));
  return haystack.includes(query);
}

function researchSearchTokens(search: string): string[] {
  const tokens = search
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length >= 2)
    .slice(0, 12) ?? [];
  return Array.from(new Set(tokens));
}

function researchSearchText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 20_000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, 20_000);
  } catch {
    return '';
  }
}

function isClosedResearchRun(run: NotebookResearchRun): boolean {
  return run.reviewStatus === 'completed' || run.reviewStatus === 'certified' || run.reviewStatus === 'rejected';
}

function sortNotebookResearchRunsForDisplay(
  runs: NotebookResearchRun[],
  sort: NotebookResearchSort,
  sourceCellById: Map<string, SourceCellOption>,
): NotebookResearchRun[] {
  const sorted = [...runs];
  if (sort === 'updated_desc') {
    return sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  }
  return sorted.sort((a, b) => {
    const aPriority = researchRunWorkQueuePriority(a, sourceSyncStatus(a, sourceCellById));
    const bPriority = researchRunWorkQueuePriority(b, sourceSyncStatus(b, sourceCellById));
    const aAge = researchAgeState(a);
    const bAge = researchAgeState(b);
    const aGate = researchGateState(a);
    const bGate = researchGateState(b);
    return aPriority - bPriority
      || researchGatePriority(aGate) - researchGatePriority(bGate)
      || Number(bAge.stale) - Number(aAge.stale)
      || bAge.daysOpen - aAge.daysOpen
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.title.localeCompare(b.title);
  });
}

function researchRunWorkQueuePriority(run: NotebookResearchRun, syncStatus?: SourceSyncStatus | null): number {
  const action = researchNextAction(run, syncStatus).kind;
  switch (action) {
    case 'resolve_source':
      return 0;
    case 'fix_blockers':
      return 1;
    case 'review_sql':
      return 2;
    case 'review_context':
      return 3;
    case 'run_preview':
      return 4;
    case 'reuse_existing':
      return 5;
    case 'create_dql_draft':
      return 6;
    case 'open_certification':
      return 7;
    case 'complete_review':
      return 8;
    case 'continue_review':
    default:
      return 9;
  }
}

function pagerLabel(
  offset: number,
  pageEnd: number,
  total: number,
  visibleCount: number,
  sourceFilter: SourceSyncFilter,
  nextFilter: ResearchNextActionFilter,
): string {
  if (total === 0) return '0';
  const range = `${offset + 1}-${pageEnd} of ${total}`;
  if (sourceFilter === 'all' && nextFilter === 'all') return range;
  return `${visibleCount} shown · ${range}`;
}

function runStatusLabel(run: NotebookResearchRun): string {
  if (run.reviewStatus === 'completed') return 'complete';
  if (run.reviewStatus === 'rejected') return 'rejected';
  if (run.reviewStatus === 'certified') return 'certified';
  if (run.dqlPromotionAction) {
    if (run.dqlPromotionAction === 'reuse_existing') return 'reuse';
    if (run.dqlPromotionAction === 'extend_existing') return 'extend';
    if (run.dqlPromotionAction === 'create_replacement') return 'replace';
    if (run.dqlPromotionAction === 'create_new') return 'new';
  }
  return run.reviewStatus === 'draft_created' ? 'draft' : run.status;
}

type ResearchTone = 'success' | 'error' | 'accent' | 'neutral' | 'warning';
type ResearchNextAction = {
  kind: ResearchNextActionKind;
  label: string;
  detail: string;
  tone: ResearchTone;
};
type ResearchSourceTrust = {
  label: string;
  detail: string;
  tone: ResearchTone;
};
type ResearchDossierItem = {
  label: string;
  value: string;
  detail: string;
  tone: ResearchTone;
};
type ResearchWorkflowStageStatus = 'done' | 'active' | 'review' | 'blocked' | 'pending';
type ResearchWorkflowStage = {
  id: string;
  label: string;
  detail: string;
  status: ResearchWorkflowStageStatus;
  tone: ResearchTone;
};
type ResearchWorkflowSummary = {
  progress: string;
  label: string;
  title: string;
  tone: ResearchTone;
};
type SourceCoverageItem = {
  cell: SourceCellOption;
  run: NotebookResearchRun | null;
  status: 'unresearched' | 'changed' | 'missing' | 'synced' | 'unknown';
  nextAction?: ResearchNextAction;
};

function sourceTrustSummary(run: NotebookResearchRun, sourceSync?: SourceSyncStatus | null): ResearchSourceTrust {
  if (!run.sourceCellId) {
    const standalone = run.warnings.find((warning) => /standalone evidence/i.test(warning));
    return {
      label: 'Standalone reviewed SQL',
      detail: standalone ?? 'This research run is not linked to a current notebook source cell.',
      tone: 'neutral',
    };
  }
  if (sourceSync === 'synced') {
    return {
      label: 'Source synced',
      detail: run.sourceCellName
        ? `Reviewed SQL matches notebook cell "${run.sourceCellName}".`
        : 'Reviewed SQL matches the linked notebook source cell.',
      tone: 'success',
    };
  }
  if (sourceSync === 'changed') {
    return {
      label: 'Source changed',
      detail: run.sourceCellName
        ? `Notebook cell "${run.sourceCellName}" changed after this research run was saved.`
        : 'The linked notebook source cell changed after this research run was saved.',
      tone: 'warning',
    };
  }
  if (sourceSync === 'missing') {
    return {
      label: 'Source missing',
      detail: run.sourceCellName
        ? `Notebook cell "${run.sourceCellName}" is no longer present in the notebook.`
        : 'The linked notebook source cell is no longer present in the notebook.',
      tone: 'error',
    };
  }
  return {
    label: 'Source untracked',
    detail: run.sourceCellName
      ? `Notebook cell "${run.sourceCellName}" is linked, but no comparable fingerprint is stored.`
      : 'A source cell is linked, but no comparable fingerprint is stored.',
    tone: 'warning',
  };
}

function researchDossierItems(run: NotebookResearchRun, sourceSync?: SourceSyncStatus | null): ResearchDossierItem[] {
  const evidence = researchEvidenceRecord(run);
  const sourceTrust = sourceTrustSummary(run, sourceSync);
  const gate = researchGateState(run);
  const route = researchRouteDecision(run, evidence);
  const summaries = researchEvidenceSummaries(evidence);
  const relations = researchAllowedRelations(evidence);
  const missingContext = researchMissingContext(evidence);
  const selected = selectedEvidence(run);
  const hasEvidence = researchRunHasEvidence(run);
  const hasReviewedSql = Boolean(run.reviewedSql?.trim());
  const hasGeneratedSql = Boolean(run.generatedSql?.trim());
  const previewRows = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length;
  const hasPreview = previewRows !== undefined && (previewRows > 0 || Boolean(run.resultPreview?.columns.length));
  const dqlTone = run.draftBlockPath
    ? 'accent'
    : run.dqlPromotionAction === 'reuse_existing'
      ? 'success'
      : run.reviewStatus === 'rejected'
        ? 'error'
        : 'neutral';
  return [
    {
      label: 'Review',
      value: runReadinessLabel(run),
      detail: `Updated ${formatRunAge(run.updatedAt)}`,
      tone: runReadinessTone(run),
    },
    {
      label: 'Gate',
      value: gate.label,
      detail: gate.detail,
      tone: gate.tone,
    },
    {
      label: 'Owner',
      value: run.owner ?? 'Unassigned',
      detail: run.owner ? 'Research owner saved for review handoff' : 'Assign an owner before certification review',
      tone: run.owner ? 'neutral' : 'warning',
    },
    {
      label: 'Source',
      value: sourceTrust.label,
      detail: sourceTrust.detail,
      tone: sourceTrust.tone,
    },
    {
      label: 'SQL',
      value: hasReviewedSql ? 'Reviewed' : hasGeneratedSql ? 'Generated' : 'Missing',
      detail: run.sourceCellName || run.notebookPath,
      tone: hasReviewedSql ? 'success' : hasGeneratedSql ? 'warning' : 'error',
    },
    {
      label: 'Evidence',
      value: hasEvidence ? `${Math.max(1, selected.length + summaries.length)} saved` : 'Missing',
      detail: `${relations.length.toLocaleString()} relation${relations.length === 1 ? '' : 's'} · ${missingContext.length.toLocaleString()} gap${missingContext.length === 1 ? '' : 's'}`,
      tone: hasEvidence ? 'success' : 'warning',
    },
    {
      label: 'Preview',
      value: hasPreview ? runPreviewLabel(run) : run.status === 'error' ? 'Failed' : 'Not run',
      detail: run.lastRunAt ? `Last run ${formatRunAge(run.lastRunAt)}` : 'No preview timestamp',
      tone: hasPreview ? 'success' : run.status === 'error' ? 'error' : 'accent',
    },
    {
      label: 'DQL',
      value: run.draftBlockPath ? 'Draft saved' : run.dqlPromotionAction === 'reuse_existing' ? 'Reuse found' : 'No draft',
      detail: run.draftBlockPath ?? (run.dqlPromotionAction ? formatPromotionAction(run.dqlPromotionAction) : 'Promotion pending'),
      tone: dqlTone,
    },
    {
      label: 'Route',
      value: route?.route ?? 'No route',
      detail: route?.reason ?? 'Context route not saved',
      tone: missingContext.some((item) => item.severity === 'blocking') ? 'warning' : route ? 'neutral' : 'warning',
    },
  ];
}

function isActionableResearchRun(run: NotebookResearchRun, syncStatus?: SourceSyncStatus | null): boolean {
  return researchNextAction(run, syncStatus).kind !== 'continue_review';
}

function runReadinessLabel(run: NotebookResearchRun): string {
  if (run.reviewStatus === 'completed') return 'Completed';
  if (run.reviewStatus === 'rejected') return 'Rejected';
  if (run.reviewChecklist?.readyForCertificationReview) return 'Cert ready';
  if (run.reviewChecklist?.readyForDqlDraft) return 'Draft ready';
  if (run.reviewChecklist?.blockers.length || run.status === 'error') return 'Blocked';
  return 'Needs work';
}

function runReadinessTone(run: NotebookResearchRun): ResearchTone {
  if (run.reviewStatus === 'completed') return 'success';
  if (run.reviewStatus === 'rejected') return 'error';
  if (run.reviewChecklist?.readyForCertificationReview) return 'success';
  if (run.reviewChecklist?.readyForDqlDraft) return 'accent';
  if (run.reviewChecklist?.blockers.length || run.status === 'error') return 'error';
  if (run.reviewChecklist?.warnings.length) return 'warning';
  return 'neutral';
}

function researchGateState(run: NotebookResearchRun): ResearchGateState {
  const checklist = run.reviewChecklist;
  if (!checklist) {
    return {
      label: 'Checklist pending',
      detail: 'Refresh or run research to build the review checklist.',
      tone: 'warning',
      status: 'pending',
      count: 0,
    };
  }
  const blockedItem = checklist.items.find((item) => item.status === 'blocked');
  if (checklist.blockers.length > 0 || blockedItem) {
    return {
      label: `Blocked: ${blockedItem?.label ?? 'Review'}`,
      detail: checklist.blockers[0] ?? blockedItem?.detail ?? 'Resolve the blocked review gate before promotion.',
      tone: 'error',
      status: 'blocked',
      count: Math.max(checklist.blockers.length, blockedItem ? 1 : 0),
    };
  }
  const warningItem = checklist.items.find((item) => item.status === 'warning');
  if (checklist.warnings.length > 0 || warningItem) {
    return {
      label: `Review: ${warningItem?.label ?? 'Warning'}`,
      detail: checklist.warnings[0] ?? warningItem?.detail ?? 'Review warning before certification.',
      tone: 'warning',
      status: 'warning',
      count: Math.max(checklist.warnings.length, warningItem ? 1 : 0),
    };
  }
  const pendingItem = checklist.items.find((item) => item.status === 'pending');
  if (pendingItem) {
    return {
      label: `Next: ${pendingItem.label}`,
      detail: pendingItem.detail,
      tone: 'neutral',
      status: 'pending',
      count: 1,
    };
  }
  return {
    label: 'Gate clear',
    detail: checklist.readyForCertificationReview
      ? 'All certification review gates are satisfied.'
      : 'No blockers or warnings are currently reported.',
    tone: 'success',
    status: 'passed',
    count: 0,
  };
}

function researchAgeState(run: NotebookResearchRun): ResearchAgeState {
  const time = Date.parse(run.updatedAt);
  if (!Number.isFinite(time)) {
    return {
      label: 'Unknown age',
      detail: 'The last update timestamp is missing or invalid.',
      tone: 'warning',
      daysOpen: 0,
      stale: false,
    };
  }
  const daysOpen = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  const closed = isClosedResearchRun(run);
  if (closed) {
    return {
      label: formatRunAge(run.updatedAt),
      detail: 'Closed research is kept for audit history.',
      tone: 'neutral',
      daysOpen,
      stale: false,
    };
  }
  if (daysOpen >= 30) {
    return {
      label: `${daysOpen.toLocaleString()}d 30d+`,
      detail: 'Open research has not changed in 30 or more days. Revalidate SQL, evidence, and promotion decision.',
      tone: 'error',
      daysOpen,
      stale: true,
    };
  }
  if (daysOpen >= 7) {
    return {
      label: `${daysOpen.toLocaleString()}d stale`,
      detail: 'Open research is older than 7 days. Confirm it is still relevant before promotion.',
      tone: 'warning',
      daysOpen,
      stale: true,
    };
  }
  return {
    label: formatRunAge(run.updatedAt),
    detail: 'Recently updated research.',
    tone: 'neutral',
    daysOpen,
    stale: false,
  };
}

function sourceCoverageTone(item: SourceCoverageItem): ResearchTone {
  if (!item.run) return 'warning';
  if (item.status === 'changed') return 'warning';
  if (item.status === 'missing') return 'error';
  if (item.status === 'unknown') return 'neutral';
  return runReadinessTone(item.run);
}

function sourceCoverageLabel(item: SourceCoverageItem): string {
  if (!item.run) return 'Not started';
  if (item.status === 'changed') return 'Changed';
  if (item.status === 'missing') return 'Missing';
  if (item.status === 'unknown') return 'Linked';
  return runReadinessLabel(item.run);
}

function sourceCoverageDetail(item: SourceCoverageItem): string {
  if (!item.run) return 'Click Start to create a research run from this cell.';
  const next = item.nextAction?.label ?? researchNextAction(item.run).label;
  const age = researchAgeState(item.run);
  const gate = researchGateState(item.run);
  return [
    formatResearchIntent(item.run.intent),
    next,
    gate.status !== 'passed' ? gate.label : '',
    age.stale ? age.label : '',
  ].filter(Boolean).join(' · ');
}

function sourceCoveragePriority(item: SourceCoverageItem): number {
  if (!item.run) return 0;
  if (item.status === 'missing') return 1;
  if (item.status === 'changed') return 2;
  if (item.nextAction && item.nextAction.kind !== 'continue_review') return 3;
  if (item.status === 'unknown') return 4;
  return 5;
}

function buildResearchWorklist(input: {
  runScope: ResearchScope;
  sourceCoverageItems: SourceCoverageItem[];
  visibleRuns: NotebookResearchRun[];
  sourceCellById: Map<string, SourceCellOption>;
  currentNotebookPath: string;
  sourceCoverageFilter: SourceCoverageFilter;
  nextActionFilter: ResearchNextActionFilter;
}): ResearchWorklistItem[] {
  const items: ResearchWorklistItem[] = [];
  const includedRunIds = new Set<string>();

  if (input.runScope === 'notebook') {
    for (const sourceItem of input.sourceCoverageItems) {
      if (!sourceItem.run) {
        if (input.sourceCoverageFilter !== 'all' && input.sourceCoverageFilter !== 'unresearched') continue;
	        items.push({
	          id: `source:${sourceItem.cell.id}`,
	          title: sourceItem.cell.name,
	          detail: `${sourceItem.cell.type.toUpperCase()} · new source cell · create research draft`,
	          reason: 'No saved research run is linked to this source cell yet.',
	          actionLabel: 'Start research',
	          statusLabel: 'new',
	          tone: 'warning',
          priority: worklistActionPriority('review_sql') + 20,
          sourceItem,
        });
        continue;
      }

	      const action = sourceItem.nextAction ?? researchNextAction(sourceItem.run, sourceItem.status === 'unresearched' ? null : sourceItem.status);
	      const age = researchAgeState(sourceItem.run);
	      const gate = researchGateState(sourceItem.run);
	      const reason = researchWorklistReason(action, gate, age, sourceItem.status);
	      if (input.nextActionFilter !== 'all' && action.kind !== input.nextActionFilter) continue;
	      if (action.kind === 'continue_review' && input.sourceCoverageFilter === 'all') continue;
	      includedRunIds.add(sourceItem.run.id);
	      items.push({
	        id: `source:${sourceItem.cell.id}:${sourceItem.run.id}`,
	        title: sourceItem.run.title || sourceItem.cell.name,
	        detail: [
	          sourceItem.cell.name,
	          sourceItem.run.domain ?? 'uncategorized',
	          formatResearchIntent(sourceItem.run.intent),
	          sourceCoverageLabel(sourceItem),
	          gate.status !== 'passed' ? gate.label : '',
	          age.stale ? age.label : '',
	        ].filter(Boolean).join(' · '),
	        reason,
	        actionLabel: action.label,
	        statusLabel: runReadinessLabel(sourceItem.run),
        tone: gate.status !== 'passed' && action.tone === 'neutral'
          ? gate.tone
          : age.stale && action.tone === 'neutral' ? age.tone : action.tone,
        priority: worklistActionPriority(action.kind, sourceItem.status)
          + researchGatePriorityOffset(gate)
          + (age.stale ? -0.25 : 0),
        run: sourceItem.run,
        sourceItem,
      });
    }
  }

	  for (const run of input.visibleRuns) {
	    if (includedRunIds.has(run.id)) continue;
	    const syncStatus = researchSourceSyncForRun(run, input.sourceCellById, input.currentNotebookPath);
	    const action = researchNextAction(run, syncStatus);
	    const age = researchAgeState(run);
	    const gate = researchGateState(run);
	    const reason = researchWorklistReason(action, gate, age, syncStatus);
	    const sourceStateLabel = isExternalNotebookRun(run, input.currentNotebookPath)
	      ? 'source notebook'
	      : syncStatus
	        ? formatSourceSyncFilter(syncStatus)
	        : 'standalone';
    if (input.nextActionFilter !== 'all' && action.kind !== input.nextActionFilter) continue;
    if (action.kind === 'continue_review') continue;
    items.push({
      id: `run:${run.id}`,
      title: run.title,
      detail: [
	        run.sourceCellName || run.notebookPath,
	        run.domain ?? 'uncategorized',
	        formatResearchIntent(run.intent),
	        sourceStateLabel,
	        gate.status !== 'passed' ? gate.label : '',
	        age.stale ? age.label : '',
	      ].filter(Boolean).join(' · '),
	      reason,
	      actionLabel: action.label,
	      statusLabel: runReadinessLabel(run),
      tone: gate.status !== 'passed' && action.tone === 'neutral'
        ? gate.tone
        : age.stale && action.tone === 'neutral' ? age.tone : action.tone,
      priority: worklistActionPriority(action.kind, syncStatus)
        + researchGatePriorityOffset(gate)
        + (age.stale ? -0.25 : 0),
      run,
    });
  }

  return items.sort((a, b) => {
    return a.priority - b.priority
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id);
  });
}

function researchGatePriority(gate: ResearchGateState): number {
  switch (gate.status) {
    case 'blocked':
      return 0;
    case 'warning':
      return 1;
    case 'pending':
      return 2;
    case 'passed':
    default:
      return 3;
  }
}

function researchGatePriorityOffset(gate: ResearchGateState): number {
  switch (gate.status) {
    case 'blocked':
      return -0.35;
    case 'warning':
      return -0.2;
    case 'pending':
      return -0.1;
    case 'passed':
    default:
      return 0;
  }
}

function researchWorklistReason(
  action: ResearchNextAction,
  gate: ResearchGateState,
  age: ResearchAgeState,
  sourceStatus?: SourceSyncStatus | SourceCoverageStatus | null,
): string {
  if (sourceStatus === 'missing' || sourceStatus === 'changed') {
    return `${action.label}: ${action.detail}`;
  }
  if (gate.status === 'blocked') {
    return `${gate.label}: ${gate.detail}`;
  }
  if (gate.status === 'warning' && action.kind !== 'complete_review') {
    return `${gate.label}: ${gate.detail}`;
  }
  if (age.stale) {
    return `${age.label}: ${age.detail}`;
  }
  return action.detail;
}

function worklistActionPriority(kind: ResearchNextActionKind, sourceStatus?: SourceSyncStatus | SourceCoverageStatus | null): number {
  if (sourceStatus === 'missing') return 0;
  if (sourceStatus === 'changed') return 1;
  switch (kind) {
    case 'resolve_source':
      return 2;
    case 'fix_blockers':
      return 3;
    case 'review_sql':
      return 4;
    case 'review_context':
      return 5;
    case 'run_preview':
      return 6;
    case 'reuse_existing':
      return 7;
    case 'create_dql_draft':
      return 8;
    case 'open_certification':
      return 9;
    case 'complete_review':
      return 10;
    case 'continue_review':
    default:
      return 20;
  }
}

function portfolioGroupPriority(group: { nextAction?: DurableNotebookResearchNextActionFilter }): number {
  return group.nextAction ? worklistActionPriority(group.nextAction) : 99;
}

function sortNotebookPortfolioGroups<T extends { nextAction?: DurableNotebookResearchNextActionFilter; blocked: number; expiredOpen: number; staleOpen: number; certificationReady: number; draftReady: number; total: number; title: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => portfolioGroupPriority(a) - portfolioGroupPriority(b)
    || b.blocked - a.blocked
    || b.expiredOpen - a.expiredOpen
    || b.staleOpen - a.staleOpen
    || b.certificationReady - a.certificationReady
    || b.draftReady - a.draftReady
    || b.total - a.total
    || a.title.localeCompare(b.title));
}

function sortDomainPortfolioGroups<T extends { nextAction?: DurableNotebookResearchNextActionFilter; blocked: number; expiredOpen: number; staleOpen: number; certificationReady: number; draftReady: number; total: number; domain: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => portfolioGroupPriority(a) - portfolioGroupPriority(b)
    || b.blocked - a.blocked
    || b.expiredOpen - a.expiredOpen
    || b.staleOpen - a.staleOpen
    || b.certificationReady - a.certificationReady
    || b.draftReady - a.draftReady
    || b.total - a.total
    || a.domain.localeCompare(b.domain));
}

function sortOwnerPortfolioGroups<T extends { nextAction?: DurableNotebookResearchNextActionFilter; blocked: number; expiredOpen: number; staleOpen: number; certificationReady: number; draftReady: number; total: number; owner: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => portfolioGroupPriority(a) - portfolioGroupPriority(b)
    || b.blocked - a.blocked
    || b.expiredOpen - a.expiredOpen
    || b.staleOpen - a.staleOpen
    || b.certificationReady - a.certificationReady
    || b.draftReady - a.draftReady
    || b.total - a.total
    || a.owner.localeCompare(b.owner));
}

function sortIntentPortfolioGroups<T extends { nextAction?: DurableNotebookResearchNextActionFilter; blocked: number; expiredOpen: number; staleOpen: number; certificationReady: number; draftReady: number; total: number; intent: NotebookResearchIntent }>(items: T[]): T[] {
  return [...items].sort((a, b) => portfolioGroupPriority(a) - portfolioGroupPriority(b)
    || b.blocked - a.blocked
    || b.expiredOpen - a.expiredOpen
    || b.staleOpen - a.staleOpen
    || b.certificationReady - a.certificationReady
    || b.draftReady - a.draftReady
    || b.total - a.total
    || formatResearchIntent(a.intent).localeCompare(formatResearchIntent(b.intent)));
}

function portfolioSummaryLabel(total: number, noun: string, visible: number): string {
  const count = total.toLocaleString();
  const label = `${count} ${noun}${total === 1 ? '' : 's'}`;
  return visible > 0 && total > visible ? `${label} (top ${visible.toLocaleString()})` : label;
}

function researchNextAction(run: NotebookResearchRun, syncStatus?: SourceSyncStatus | null): ResearchNextAction {
  const checklist = run.reviewChecklist;
  const hasReviewedSql = Boolean(run.reviewedSql?.trim());
  const hasGeneratedSql = Boolean(run.generatedSql?.trim());
  const hasPreview = Boolean(run.resultPreview?.columns.length || (run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0) > 0);
  const hasEvidence = researchRunHasEvidence(run);
  if (run.reviewStatus === 'completed') {
    return {
      kind: 'continue_review',
      label: 'Research complete',
      detail: 'This investigation is closed. Reopen it if the source logic needs more review.',
      tone: 'success',
    };
  }
  if (run.reviewStatus === 'rejected') {
    return {
      kind: 'continue_review',
      label: 'Research rejected',
      detail: 'This investigation is closed as rejected. Reopen it only if the SQL or business question becomes relevant again.',
      tone: 'error',
    };
  }
  if (syncStatus === 'changed') {
    return {
      kind: 'resolve_source',
      label: 'Resolve changed source',
      detail: 'Sync from the notebook cell, or keep the reviewed SQL as standalone evidence before rerun or DQL draft creation.',
      tone: 'warning',
    };
  }
  if (syncStatus === 'missing') {
    return {
      kind: 'resolve_source',
      label: 'Resolve missing source',
      detail: 'The original notebook cell is gone. Keep reviewed SQL as standalone evidence if it is still the approved logic.',
      tone: 'error',
    };
  }
  if (run.status === 'error') {
    return {
      kind: 'fix_blockers',
      label: 'Fix failed preview',
      detail: run.error ?? 'Fix the SQL or connection error, then rerun research.',
      tone: 'error',
    };
  }
  if (checklist?.blockers.length) {
    return {
      kind: 'fix_blockers',
      label: 'Fix checklist blockers',
      detail: checklist.blockers[0] ?? 'Resolve blockers before DQL promotion.',
      tone: 'error',
    };
  }
  if (!hasReviewedSql && hasGeneratedSql) {
    return {
      kind: 'review_sql',
      label: 'Review generated SQL',
      detail: 'Save reviewed SQL before promoting this research into a reusable saved query.',
      tone: 'warning',
    };
  }
  if (!hasReviewedSql && !hasGeneratedSql) {
    return {
      kind: 'review_sql',
      label: 'Add or generate SQL',
      detail: 'Use a source cell, paste SQL, or ask the agent to generate SQL from metadata context.',
      tone: 'error',
    };
  }
  if (!hasEvidence) {
    return {
      kind: 'review_context',
      label: 'Review metadata context',
      detail: 'Preview and save metadata evidence before DQL draft creation.',
      tone: 'warning',
    };
  }
  if (!hasPreview) {
    return {
      kind: 'run_preview',
      label: 'Run bounded preview',
      detail: 'Validate the reviewed SQL and collect preview evidence before certification review.',
      tone: 'accent',
    };
  }
  if (run.dqlPromotionAction === 'reuse_existing') {
    return {
      kind: 'reuse_existing',
      label: 'Reuse existing saved query',
      detail: 'A similar reusable saved query was found. Mark complete if it should be reused, or document why this should become a replacement.',
      tone: 'success',
    };
  }
  if (!run.draftBlockPath && checklist?.readyForDqlDraft) {
    return {
      kind: 'create_dql_draft',
      label: 'Create DQL draft',
      detail: 'Reviewed SQL and preview evidence are ready for duplicate checking and draft saved query creation.',
      tone: 'accent',
    };
  }
  if (run.draftBlockPath && checklist?.readyForCertificationReview) {
    return {
      kind: 'open_certification',
      label: 'Open draft for certification',
      detail: 'Review metadata, tests, lineage, and duplicate evidence before certifying the saved query.',
      tone: 'success',
    };
  }
  if (run.draftBlockPath) {
    return {
      kind: 'complete_review',
      label: 'Complete draft review',
      detail: 'Open the DQL draft and finish any remaining metadata, tests, or evidence review.',
      tone: 'warning',
    };
  }
  if (checklist?.warnings.length) {
    return {
      kind: 'complete_review',
      label: 'Review warnings',
      detail: checklist.warnings[0] ?? 'Inspect warnings before creating a reusable saved query.',
      tone: 'warning',
    };
  }
  return {
    kind: 'continue_review',
    label: 'Continue research review',
    detail: 'Review SQL, preview results, and evidence before deciding whether to create or reuse a saved query.',
    tone: 'neutral',
  };
}

function researchWorkflowStages(
  run: NotebookResearchRun,
  syncStatus: SourceSyncStatus | null,
  nextAction: ResearchNextAction | null,
): ResearchWorkflowStage[] {
  const hasReviewedSql = Boolean(run.reviewedSql?.trim());
  const hasGeneratedSql = Boolean(run.generatedSql?.trim());
  const hasSql = hasReviewedSql || hasGeneratedSql;
  const hasEvidence = researchRunHasEvidence(run);
  const previewRows = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0;
  const hasPreview = Boolean(run.resultPreview?.columns.length || previewRows > 0);
  const parameterReview = runParameterReviewSummary(run);
  const sourceBlocked = syncStatus === 'changed' || syncStatus === 'missing';
  const closed = isClosedResearchRun(run);

  const sourceDetail = syncStatus === 'changed'
    ? 'Notebook cell changed since review'
    : syncStatus === 'missing'
      ? 'Original source cell is missing'
      : syncStatus === 'synced'
        ? `Synced to ${run.sourceCellName ?? 'source cell'}`
        : run.sourceCellId
          ? 'Source linked; fingerprint missing'
          : 'Metadata or standalone SQL';

  const sqlDetail = hasReviewedSql
    ? 'Reviewer-approved SQL saved'
    : hasGeneratedSql
      ? 'Generated SQL needs review'
      : 'Add, paste, or generate SQL';

  const contextDetail = hasEvidence
    ? 'Context evidence saved'
    : 'Preview and save metadata context';

  const previewDetail = run.status === 'error'
    ? run.error ?? 'Preview failed'
    : hasPreview
      ? `${previewRows.toLocaleString()} preview row${previewRows === 1 ? '' : 's'}`
      : 'Run bounded preview';

  const parameterDetail = parameterReview?.chipLabel
    ?? (hasPreview ? 'Check duplicates and parameter policy' : 'Runs after preview');
  const parameterStatus: ResearchWorkflowStageStatus = parameterReview?.tone === 'error'
    ? 'blocked'
    : parameterReview?.tone === 'warning'
      ? 'review'
      : run.dqlPromotionAction || parameterReview?.tone === 'success'
        ? 'done'
        : hasPreview
          ? 'active'
          : 'pending';

  const dqlDetail = run.draftBlockPath
    ? 'Draft saved'
    : run.dqlPromotionAction === 'reuse_existing'
      ? 'Reuse existing saved query'
      : 'Create or open DQL draft';

  return [
    {
      id: 'source',
      label: 'Source',
      detail: sourceDetail,
      status: sourceBlocked ? 'blocked' : 'done',
      tone: syncStatus === 'missing' ? 'error' : sourceBlocked || syncStatus === 'unknown' ? 'warning' : 'success',
    },
    {
      id: 'sql',
      label: 'SQL',
      detail: sqlDetail,
      status: hasReviewedSql ? 'done' : hasGeneratedSql || nextAction?.kind === 'review_sql' ? 'active' : 'blocked',
      tone: hasReviewedSql ? 'success' : hasGeneratedSql ? 'warning' : 'error',
    },
    {
      id: 'context',
      label: 'Context',
      detail: contextDetail,
      status: hasEvidence ? 'done' : nextAction?.kind === 'review_context' ? 'active' : hasSql ? 'pending' : 'blocked',
      tone: hasEvidence ? 'success' : 'warning',
    },
    {
      id: 'preview',
      label: 'Preview',
      detail: previewDetail,
      status: hasPreview ? 'done' : run.status === 'error' ? 'blocked' : nextAction?.kind === 'run_preview' || nextAction?.kind === 'fix_blockers' ? 'active' : hasEvidence ? 'pending' : 'blocked',
      tone: hasPreview ? 'success' : run.status === 'error' ? 'error' : 'accent',
    },
    {
      id: 'reuse_parameters',
      label: 'Reuse + params',
      detail: parameterDetail,
      status: parameterStatus,
      tone: parameterReview?.tone ?? (hasPreview ? 'warning' : 'neutral'),
    },
    {
      id: 'dql',
      label: 'DQL + certify',
      detail: dqlDetail,
      status: run.draftBlockPath || closed ? 'done' : nextAction?.kind === 'create_dql_draft' || nextAction?.kind === 'open_certification' || nextAction?.kind === 'complete_review' ? 'active' : 'pending',
      tone: run.draftBlockPath || closed ? 'success' : nextAction?.kind === 'create_dql_draft' ? 'accent' : 'neutral',
    },
  ];
}

function researchWorkflowSummary(
  run: NotebookResearchRun,
  syncStatus: SourceSyncStatus | null,
  nextAction: ResearchNextAction,
): ResearchWorkflowSummary {
  const stages = researchWorkflowStages(run, syncStatus, nextAction);
  const completed = stages.filter((stage) => stage.status === 'done').length;
  const current = stages.find((stage) => stage.status === 'blocked')
    ?? stages.find((stage) => stage.status === 'active')
    ?? stages.find((stage) => stage.status === 'review')
    ?? stages.find((stage) => stage.status === 'pending')
    ?? stages[stages.length - 1];
  const statusLabel = current.status === 'done'
    ? 'done'
    : current.status === 'active'
      ? 'now'
      : current.status === 'review'
        ? 'review'
        : current.status === 'blocked'
          ? 'blocked'
          : 'next';
  return {
    progress: `${completed}/${stages.length}`,
    label: `${current.label} ${statusLabel}`,
    title: `${current.label}: ${current.detail}`,
    tone: current.tone,
  };
}

function researchNextActionCommandLabel(
  kind: ResearchNextActionKind,
  input: {
    sourceSync?: SourceSyncStatus | null;
    hasContextPreview: boolean;
    hasDraft: boolean;
  },
): string {
  switch (kind) {
    case 'resolve_source':
      return input.sourceSync === 'changed' ? 'Sync source' : 'Use reviewed SQL';
    case 'fix_blockers':
      return 'Rerun preview';
    case 'review_sql':
      return 'Save review';
    case 'review_context':
      return input.hasContextPreview ? 'Save evidence' : 'Preview context';
    case 'run_preview':
      return 'Run preview';
    case 'reuse_existing':
      return 'Complete reuse';
    case 'create_dql_draft':
      return 'Create draft';
    case 'open_certification':
      return input.hasDraft ? 'Open draft' : 'Add note';
    case 'complete_review':
      return input.hasDraft ? 'Open draft' : 'Add note';
    case 'continue_review':
    default:
      return 'Add note';
  }
}

function promotionActionTone(action?: string): ResearchTone {
  if (action === 'reuse_existing') return 'success';
  if (action === 'extend_existing' || action === 'create_replacement') return 'warning';
  if (action === 'create_new') return 'accent';
  return 'neutral';
}

function runPreviewLabel(run: NotebookResearchRun): string {
  const rows = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0;
  return `${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`;
}

function formatResearchIntent(value?: NotebookResearchIntent): string {
  switch (value) {
    case 'diagnose_change':
      return 'Diagnose change';
    case 'driver_breakdown':
      return 'Driver breakdown';
    case 'segment_compare':
      return 'Segment compare';
    case 'entity_drilldown':
      return 'Entity drilldown';
    case 'anomaly_investigation':
      return 'Anomaly investigation';
    case 'trust_gap_review':
      return 'Trust review';
    default:
      return 'Ad hoc analysis';
  }
}

function formatRunFilter(value: RunFilter): string {
  switch (value) {
    case 'open_work':
      return 'Open work';
    case 'ready':
      return 'Ready';
    case 'draft':
      return 'Needs review';
    case 'error':
      return 'Errors';
    case 'dql_draft':
      return 'DQL draft';
    case 'draft_ready':
      return 'Draft ready';
    case 'certification_ready':
      return 'Certification ready';
    case 'blocked':
      return 'Blocked';
    case 'stale_open':
      return 'Stale open';
    case 'expired_open':
      return '30d open';
    case 'completed':
      return 'Completed';
    case 'rejected':
      return 'Rejected';
    case 'reuse_existing':
      return 'Reuse existing';
    case 'extend_existing':
      return 'Extend existing';
    case 'create_replacement':
      return 'Replacement';
    case 'create_new':
      return 'Create new';
    case 'all':
    default:
      return 'All history';
  }
}

function formatSourceSyncFilter(value: SourceSyncFilter): string {
  switch (value) {
    case 'changed':
      return 'Changed';
    case 'missing':
      return 'Missing';
    case 'synced':
      return 'Synced';
    case 'unknown':
      return 'Untracked';
    case 'all':
    default:
      return 'All sources';
  }
}

function formatSourceCoverageFilter(value: SourceCoverageFilter): string {
  switch (value) {
    case 'unresearched':
      return 'New source cells';
    case 'changed':
      return 'Changed source cells';
    case 'missing':
      return 'Missing source cells';
    case 'synced':
      return 'Synced source cells';
    case 'unknown':
      return 'Untracked source cells';
    case 'all':
    default:
      return 'All source cells';
  }
}

function formatResearchNextActionFilter(value: ResearchNextActionFilter): string {
  switch (value) {
    case 'resolve_source':
      return 'Source fixes';
    case 'fix_blockers':
      return 'Blockers';
    case 'review_sql':
      return 'Review SQL';
    case 'review_context':
      return 'Review context';
    case 'run_preview':
      return 'Run preview';
    case 'reuse_existing':
      return 'Reuse decisions';
    case 'create_dql_draft':
      return 'Create draft';
    case 'open_certification':
      return 'Certify draft';
    case 'complete_review':
      return 'Complete review';
    case 'continue_review':
      return 'Continue review';
    case 'all':
    default:
      return 'All next actions';
  }
}

function formatResearchPlanSqlState(value: NonNullable<NotebookResearchRun['researchPlan']>['sqlState']): string {
  if (value === 'reviewed') return 'Reviewed SQL';
  if (value === 'generated') return 'Generated SQL';
  return 'Needs SQL';
}

function formatResearchPlanPreview(plan: NonNullable<NotebookResearchRun['researchPlan']>): string {
  if (plan.preview.status === 'ready') return 'Preview ready';
  if (plan.preview.status === 'error') return 'Preview failed';
  return 'Not run';
}

function formatResearchPlanPath(value: NonNullable<NotebookResearchRun['researchPlan']>['promotion']['path']): string {
  switch (value) {
    case 'review_context':
      return 'Review context';
    case 'run_preview':
      return 'Run preview';
    case 'reuse_existing':
      return 'Reuse saved query';
    case 'create_dql_draft':
      return 'Create draft';
    case 'open_certification':
      return 'Open certification';
    case 'complete_review':
      return 'Complete review';
    case 'needs_sql':
    default:
      return 'Needs SQL';
  }
}

function researchPlanPathTone(value: NonNullable<NotebookResearchRun['researchPlan']>['promotion']['path']): ResearchTone {
  if (value === 'reuse_existing' || value === 'open_certification') return 'success';
  if (value === 'create_dql_draft') return 'accent';
  if (value === 'run_preview' || value === 'review_context') return 'warning';
  if (value === 'needs_sql') return 'error';
  return 'neutral';
}

function formatRunAge(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'updated recently';
  const diff = Date.now() - time;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

function selectedEvidence(run: NotebookResearchRun | null): string[] {
  if (!run?.evidence || typeof run.evidence !== 'object') return [];
  const evidence = run.evidence as Record<string, unknown>;
  const selected = Array.isArray(evidence.selectedEvidence) ? evidence.selectedEvidence : [];
  return selected.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item);
    const raw = item as Record<string, unknown>;
    return [
      typeof raw.role === 'string' ? raw.role : undefined,
      typeof raw.name === 'string' ? raw.name : typeof raw.title === 'string' ? raw.title : undefined,
      typeof raw.reason === 'string' ? raw.reason : typeof raw.summary === 'string' ? raw.summary : undefined,
    ].filter(Boolean).join(' - ') || JSON.stringify(raw).slice(0, 160);
  }).filter(Boolean);
}

function contextPreviewEvidence(preview: NotebookResearchContextPreview): string[] {
  const evidence = preview.evidence.map((item) => {
    return [
      item.role,
      item.name,
      item.reason,
    ].filter(Boolean).join(' - ');
  });
  const summaries = preview.summaries.map((item) => {
    return [
      item.objectType,
      item.title,
      item.detail || item.reason,
    ].filter(Boolean).join(' - ');
  });
  const rejected = preview.topRejected.slice(0, 2).map((item) => {
    return `Rejected: ${item.name} - ${item.reason}`;
  });
  return [...evidence, ...summaries, ...rejected].filter(Boolean);
}

function contextPreviewEvidencePayload(preview: NotebookResearchContextPreview): Record<string, unknown> {
  return {
    trustStatus: {
      label: preview.trustLabel ?? 'Metadata context preview',
      reviewRequired: true,
    },
    contextPackId: preview.contextPackId,
    routeDecision: preview.routeDecision,
    selectedEvidence: preview.evidence.map((item, index) => ({
      objectKey: item.objectKey,
      objectType: item.objectType,
      name: item.name,
      role: item.role,
      reason: item.reason,
      rank: index + 1,
    })),
    evidenceSummaries: preview.summaries,
    allowedSqlContext: {
      relations: preview.relations,
    },
    retrievalDiagnostics: {
      selectedEvidence: preview.evidence.map((item, index) => ({
        objectKey: item.objectKey,
        objectType: item.objectType,
        name: item.name,
        reason: item.reason,
        rank: index + 1,
      })),
      selectedRelations: preview.relations,
      topRejected: preview.topRejected,
    },
    missingContext: preview.missingContext,
    warnings: preview.warnings,
    savedFrom: 'notebook_context_preview',
    savedAt: new Date().toISOString(),
  };
}

function statusIcon(run: NotebookResearchRun, t: Theme) {
  if (run.status === 'running') return <Loader2 size={13} strokeWidth={2} color={t.accent} aria-hidden="true" />;
  if (run.status === 'ready') return <Check size={13} strokeWidth={2} color={t.success} aria-hidden="true" />;
  if (run.status === 'error') return <X size={13} strokeWidth={2} color={t.error} aria-hidden="true" />;
  return <Bot size={13} strokeWidth={2} color={t.textMuted} aria-hidden="true" />;
}

function MetricBox({
  label,
  value,
  tone,
  t,
  active = false,
  onClick,
  title,
  disableWhenZero = true,
}: {
  label: string;
  value: number | string;
  tone: ResearchTone;
  t: Theme;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  disableWhenZero?: boolean;
}) {
  const color = tone === 'success'
    ? t.success
    : tone === 'error'
      ? t.error
      : tone === 'warning'
        ? t.warning
        : tone === 'accent'
          ? t.accent
          : t.textSecondary;
  const disabled = Boolean(onClick && disableWhenZero && typeof value === 'number' && value === 0 && !active);
  const displayColor = disabled ? t.textMuted : color;
  const content = (
    <>
      <span style={{ fontSize: 13, fontWeight: 800, color: displayColor }}>{value}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700 }}>{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={disabled ? `No ${label.toLowerCase()} items in the current queue` : title}
        style={metricBoxStyle(t, color, active, true, disabled)}
      >
        {content}
      </button>
    );
  }
  return (
    <div style={metricBoxStyle(t, color, active, false, false)}>
      {content}
    </div>
  );
}

function ResearchDiagnosticsLine({ diagnostics, t }: { diagnostics: NotebookResearchDiagnostics; t: Theme }) {
  const searchTone: ResearchTone = diagnostics.search.stale
    ? 'warning'
    : diagnostics.search.indexed
      ? 'success'
      : 'warning';
  const searchLabel = diagnostics.search.stale
    ? 'Search index stale'
    : diagnostics.search.indexed
      ? 'Indexed search'
      : 'Search fallback';
  const warnings = diagnostics.warnings.slice(0, 2);
  return (
    <div style={diagnosticsLineStyle(t)}>
      <DiagnosticsPill
        label={searchLabel}
        detail={diagnostics.search.indexed ? `${diagnostics.search.indexRows.toLocaleString()} indexed` : 'local scan'}
        tone={searchTone}
        t={t}
      />
      <DiagnosticsPill
        label={`${diagnostics.counts.activeRuns.toLocaleString()} open`}
        detail={`${diagnostics.counts.totalRuns.toLocaleString()} total`}
        tone={diagnostics.counts.activeRuns > 500 ? 'warning' : 'neutral'}
        t={t}
      />
      <DiagnosticsPill
        label={`${diagnostics.counts.notebooks.toLocaleString()} notebooks`}
        detail={`${diagnostics.counts.domains.toLocaleString()} domains · ${diagnostics.counts.owners.toLocaleString()} owners`}
        tone="neutral"
        t={t}
      />
      <DiagnosticsPill
        label={`${diagnostics.counts.sourceLinkedRuns.toLocaleString()} linked`}
        detail={`page ${diagnostics.limits.pageSize}/${diagnostics.limits.maxPageSize}`}
        tone="neutral"
        t={t}
      />
      <DiagnosticsPill
        label={`${diagnostics.health.staleOpenRuns.toLocaleString()} stale`}
        detail={`${diagnostics.health.expiredOpenRuns.toLocaleString()} ${diagnostics.health.expiredThresholdDays}+d`}
        tone={diagnostics.health.expiredOpenRuns > 0 ? 'error' : diagnostics.health.staleOpenRuns > 0 ? 'warning' : 'neutral'}
        t={t}
      />
      {warnings.map((warning) => (
        <span key={warning} title={warning} style={diagnosticsWarningStyle(t)}>
          {warning}
        </span>
      ))}
    </div>
  );
}

function DiagnosticsPill({
  label,
  detail,
  tone,
  t,
}: {
  label: string;
  detail: string;
  tone: ResearchTone;
  t: Theme;
}) {
  const color = toneColor(t, tone);
  return (
    <span style={diagnosticsPillStyle(t, color)}>
      <span style={{ color, fontWeight: 850 }}>{label}</span>
      <span style={{ color: t.textMuted }}>{detail}</span>
    </span>
  );
}

function QueueActionButton({
  label,
  count,
  active,
  tone,
  t,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone: ResearchTone;
  t: Theme;
  onClick: () => void;
}) {
  const color = toneColor(t, tone);
  const disabled = count === 0 && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={queueActionButtonStyle(t, color, active, disabled)}
      title={disabled
        ? `No ${label.toLowerCase()} items in the current queue`
        : `${count.toLocaleString()} ${label.toLowerCase()} ${count === 1 ? 'item' : 'items'}`}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={queueActionCountStyle(disabled ? t.textMuted : color)}>{count > 99 ? '99+' : count}</span>
    </button>
  );
}

function CollapsibleOverviewHeader({
  title,
  summary,
  expanded,
  onToggle,
  t,
}: {
  title: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  t: Theme;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      style={overviewToggleStyle(t, expanded)}
    >
      <span style={{ color: t.textSecondary, fontSize: 11, fontWeight: 850, flexShrink: 0 }}>{title}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.textMuted, fontSize: 11, textAlign: 'left' }}>
        {summary}
      </span>
      <ChevronDown
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          color: t.textMuted,
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 120ms ease',
        }}
      />
    </button>
  );
}

function PortfolioRow({
  label,
  total,
  draftReady,
  certificationReady,
  blocked,
  staleOpen,
  expiredOpen,
  nextAction,
  nextActionCount,
  active,
  detail,
  t,
  onClick,
}: {
  label: string;
  total: number;
  draftReady: number;
  certificationReady: number;
  blocked: number;
  staleOpen: number;
  expiredOpen: number;
  nextAction?: DurableNotebookResearchNextActionFilter;
  nextActionCount?: number;
  active: boolean;
  detail?: string;
  t: Theme;
  onClick: () => void;
}) {
  const tone: ResearchTone = blocked > 0
    ? 'error'
    : expiredOpen > 0
      ? 'error'
      : staleOpen > 0
        ? 'warning'
    : certificationReady > 0
      ? 'success'
      : draftReady > 0
        ? 'accent'
        : 'neutral';
  const nextLabel = nextAction ? formatResearchNextActionFilter(nextAction) : undefined;
  const nextCount = typeof nextActionCount === 'number' && nextActionCount > 0 ? nextActionCount : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      style={portfolioRowStyle(t, tone, active)}
      title={[
        `${label}: ${total.toLocaleString()} research ${total === 1 ? 'run' : 'runs'}`,
        nextLabel && nextCount ? `Next: ${nextLabel} (${nextCount.toLocaleString()})` : undefined,
        expiredOpen > 0 ? `${expiredOpen.toLocaleString()} open 30d+` : undefined,
        staleOpen > 0 ? `${staleOpen.toLocaleString()} stale open` : undefined,
      ].filter(Boolean).join(' · ')}
    >
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: t.textPrimary, fontSize: 11, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ color: t.textMuted, fontSize: 10, fontWeight: 700 }}>
          {detail ? `${detail} · ` : ''}{total.toLocaleString()} run{total === 1 ? '' : 's'}
          {nextLabel && nextCount ? ` · next: ${nextLabel}` : ''}
        </span>
      </span>
      <span style={portfolioMetricsStyle}>
        {nextLabel && nextCount && <span style={runChipStyle(t, tone)}>{nextLabel} · {nextCount}</span>}
        {blocked > 0 && <span style={runChipStyle(t, 'error')}>{blocked} blocked</span>}
        {expiredOpen > 0 && <span style={runChipStyle(t, 'error')}>{expiredOpen} 30d+</span>}
        {staleOpen > 0 && <span style={runChipStyle(t, 'warning')}>{staleOpen} stale</span>}
        {certificationReady > 0 && <span style={runChipStyle(t, 'success')}>{certificationReady} cert</span>}
        {draftReady > 0 && <span style={runChipStyle(t, 'accent')}>{draftReady} draft</span>}
      </span>
    </button>
  );
}

function PortfolioMoreLine({
  hidden,
  noun,
  filterLabel,
  t,
}: {
  hidden: number;
  noun: string;
  filterLabel: string;
  t: Theme;
}) {
  return (
    <div style={portfolioMoreLineStyle(t)}>
      +{hidden.toLocaleString()} more {noun}{hidden === 1 ? '' : 's'} · use Search or {filterLabel} filter
    </div>
  );
}

function WorkflowStage({
  index,
  stage,
  t,
}: {
  index: number;
  stage: ResearchWorkflowStage;
  t: Theme;
}) {
  const statusLabel = stage.status === 'done'
    ? 'Done'
    : stage.status === 'active'
      ? 'Now'
      : stage.status === 'review'
        ? 'Review'
        : stage.status === 'blocked'
          ? 'Blocked'
          : 'Next';
  return (
    <div style={workflowStageStyle(t, stage)}>
      <span style={workflowStageIndexStyle(t, stage)}>
        {stage.status === 'done' ? <Check size={12} strokeWidth={2.5} /> : index}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 850, color: t.textPrimary }}>{stage.label}</span>
          <span style={workflowStageStatusStyle(t, stage)}>{statusLabel}</span>
        </span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, lineHeight: 1.35, color: t.textMuted }}>{stage.detail}</span>
      </span>
    </div>
  );
}

function PlanStat({
  label,
  value,
  detail,
  tone,
  t,
}: {
  label: string;
  value: string;
  detail: string;
  tone: ResearchTone;
  t: Theme;
}) {
  const color = toneColor(t, tone);
  return (
    <div style={planStatStyle(t, tone)}>
      <div style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', color }}>{label}</div>
      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 850, color: t.textPrimary }}>{value}</div>
      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, lineHeight: 1.35, color: t.textMuted }}>{detail}</div>
    </div>
  );
}

function toneColor(t: Theme, tone: ResearchTone): string {
  if (tone === 'success') return t.success;
  if (tone === 'error') return t.error;
  if (tone === 'warning') return t.warning;
  if (tone === 'accent') return t.accent;
  return t.textMuted;
}

function formatPromotionAction(value?: string): string {
  switch (value) {
    case 'reuse_existing':
      return 'Reuse existing';
    case 'extend_existing':
      return 'Extend existing';
    case 'create_replacement':
      return 'Create replacement';
    case 'create_new':
      return 'Create new';
    case 'review_required':
      return 'Review required';
    default:
      return 'Review required';
  }
}

function formatMatchKind(value?: string): string {
  switch (value) {
    case 'exact_sql_match':
      return 'Exact SQL match';
    case 'parameterized_duplicate':
      return 'Parameterized duplicate';
    case 'business_duplicate':
      return 'Business duplicate';
    case 'near_variant':
      return 'Near variant';
    case 'source_variant':
      return 'Source variant';
    case 'new_logic':
      return 'New logic';
    default:
      return value ? value.replace(/_/g, ' ') : 'Similar saved query';
  }
}

function panelStyle(t: Theme): CSSProperties {
  return {
    width: 430,
    maxWidth: '42vw',
    flexShrink: 0,
    borderLeft: `1px solid ${t.headerBorder}`,
    background: t.sidebarBg,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };
}

function promotionBoxStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 7,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    fontFamily: t.font,
  };
}

function promotionHeaderStyle(t: Theme): CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    alignItems: 'center',
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
  };
}

function decisionPillStyle(t: Theme, action?: string): CSSProperties {
  const color = action === 'reuse_existing'
    ? t.success
    : action === 'extend_existing' || action === 'create_replacement'
      ? t.warning
      : action === 'create_new'
        ? t.accent
        : t.textMuted;
  return {
    flexShrink: 0,
    borderRadius: 999,
    background: `${color}18`,
    color,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 800,
  };
}

function checklistItemStyle(t: Theme, status: string): CSSProperties {
  const color = checklistStatusColor(t, status);
  return {
    border: `1px solid ${color}44`,
    background: `${color}10`,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    minWidth: 0,
    fontFamily: t.font,
  };
}

function checkDotStyle(t: Theme, status: string): CSSProperties {
  const color = checklistStatusColor(t, status);
  return {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: color,
    flexShrink: 0,
  };
}

function checklistStatusColor(t: Theme, status: string): string {
  if (status === 'passed') return t.success;
  if (status === 'blocked') return t.error;
  if (status === 'warning') return t.warning;
  return t.textMuted;
}

function matchCardStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    minWidth: 0,
  };
}

function headerStyle(t: Theme): CSSProperties {
  return {
    height: 48,
    borderBottom: `1px solid ${t.headerBorder}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    background: t.headerBg,
  };
}

const bodyStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const summaryGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 6,
};

const dossierGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
};

const workflowGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
};

const planGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
};

const portfolioGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
};

const portfolioMetricsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 4,
  flexWrap: 'wrap',
  flexShrink: 0,
};

function portfolioMoreLineStyle(t: Theme): CSSProperties {
  return {
    color: t.textMuted,
    fontSize: 10,
    fontWeight: 800,
    padding: '2px 8px 0 8px',
  };
}

function queueStripStyle(t: Theme): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 6,
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 7,
    padding: 7,
  };
}

function overviewToggleStyle(t: Theme, expanded: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 30,
    border: `1px solid ${expanded ? t.cellBorderActive : t.cellBorder}`,
    background: expanded ? t.sidebarItemActive : t.cellBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: '6px 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontFamily: t.font,
    minWidth: 0,
  };
}

function coverageBoxStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 7,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    fontFamily: t.font,
  };
}

function worklistBoxStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 7,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    fontFamily: t.font,
  };
}

function portfolioBoxStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 7,
    padding: 8,
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 8,
    fontFamily: t.font,
    minWidth: 0,
  };
}

function portfolioGroupLabelStyle(t: Theme): CSSProperties {
  return {
    color: t.textMuted,
    fontSize: 10,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
}

function portfolioRowStyle(t: Theme, tone: ResearchTone, active: boolean): CSSProperties {
  const color = toneColor(t, tone);
  return {
    width: '100%',
    minHeight: 40,
    border: `1px solid ${active ? color : t.cellBorder}`,
    borderLeft: `3px solid ${color}`,
    background: active ? `${color}14` : t.cellBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: '7px 8px',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 8,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: t.font,
    minWidth: 0,
  };
}

function coverageHeaderStyle(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
    minWidth: 0,
  };
}

function worklistItemStyle(t: Theme, tone: ResearchTone, active: boolean): CSSProperties {
  const color = toneColor(t, tone);
  return {
    width: '100%',
    minHeight: 48,
    border: `1px solid ${active ? color : t.cellBorder}`,
    borderLeft: `3px solid ${color}`,
    background: active ? `${color}14` : t.cellBg,
    color: t.textPrimary,
    borderRadius: 6,
    padding: '7px 8px',
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 8,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: t.font,
    minWidth: 0,
  };
}

function worklistIndexStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    width: 22,
    height: 22,
    borderRadius: 999,
    background: `${color}16`,
    color,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 900,
    lineHeight: 1,
    flexShrink: 0,
  };
}

function coverageFilterStripStyle(_t: Theme): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 5,
  };
}

function coverageItemStyle(t: Theme, status: SourceCoverageItem['status'], active: boolean): CSSProperties {
  const color = status === 'unresearched'
    ? t.warning
    : status === 'changed'
      ? t.warning
      : status === 'missing'
        ? t.error
        : status === 'synced'
          ? t.success
          : t.textMuted;
  return {
    width: '100%',
    minHeight: 42,
    border: `1px solid ${active ? t.accent : t.cellBorder}`,
    borderLeft: `3px solid ${color}`,
    background: active ? `${t.accent}10` : t.cellBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: '7px 8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: t.font,
    minWidth: 0,
  };
}

function coverageDotStyle(t: Theme, status: SourceCoverageItem['status']): CSSProperties {
  const color = status === 'unresearched'
    ? t.warning
    : status === 'changed'
      ? t.warning
      : status === 'missing'
        ? t.error
        : status === 'synced'
          ? t.success
          : t.textMuted;
  return {
    width: 7,
    height: 7,
    borderRadius: 999,
    background: color,
    flexShrink: 0,
  };
}

function titleStyle(t: Theme): CSSProperties {
  return { fontSize: 13, color: t.textPrimary, fontWeight: 700, fontFamily: t.font };
}

function subtitleStyle(t: Theme): CSSProperties {
  return { fontSize: 10, color: t.textMuted, fontFamily: t.font, marginTop: 1 };
}

function sectionStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };
}

function sectionHeaderStyle(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: t.textPrimary,
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0,
    fontFamily: t.font,
  };
}

function fieldShellStyle(_t: Theme): CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
}

function advancedFilterShellStyle(t: Theme, active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? `${t.accent}55` : t.cellBorder}`,
    background: active ? t.sidebarItemActive : t.cellBg,
    borderRadius: 7,
    padding: 7,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };
}

function advancedFilterToggleStyle(t: Theme): CSSProperties {
  return {
    width: '100%',
    minHeight: 28,
    border: 'none',
    background: 'transparent',
    color: t.textSecondary,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 0,
    fontSize: 11,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: 'pointer',
    minWidth: 0,
  };
}

function activeFilterChipRowStyle(_t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
    minWidth: 0,
  };
}

function activeFilterChipStyle(t: Theme, disabled: boolean): CSSProperties {
  return {
    maxWidth: '100%',
    minHeight: 24,
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    color: disabled ? t.textMuted : t.textSecondary,
    borderRadius: 999,
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

function patternCardStyle(t: Theme): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1.4fr)',
    gap: 8,
    alignItems: 'center',
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    borderRadius: 6,
    padding: '7px 8px',
    fontSize: 11,
    lineHeight: 1.35,
    minWidth: 0,
  };
}

function contextPreviewHeaderStyle(_t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
  };
}

function labelStyle(t: Theme): CSSProperties {
  return { fontSize: 10, color: t.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, fontFamily: t.font };
}

function textareaStyle(t: Theme, minHeight: number, mono = false): CSSProperties {
  return {
    minHeight,
    resize: 'vertical',
    border: `1px solid ${t.inputBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 6,
    padding: 9,
    fontSize: mono ? 12 : 13,
    lineHeight: 1.5,
    fontFamily: mono ? t.fontMono : t.font,
    outline: 'none',
  };
}

function inputStyle(t: Theme): CSSProperties {
  return {
    height: 30,
    border: `1px solid ${t.inputBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 6,
    padding: '0 8px',
    fontSize: 12,
    fontFamily: t.font,
    outline: 'none',
  };
}

function selectStyle(t: Theme, disabled = false): CSSProperties {
  return {
    ...inputStyle(t),
    width: '100%',
    cursor: disabled ? 'not-allowed' : 'default',
    opacity: disabled ? 0.62 : 1,
  };
}

function primaryButtonStyle(t: Theme, disabled: boolean): CSSProperties {
  return {
    minHeight: 30,
    border: `1px solid ${disabled ? t.btnBorder : t.accent}`,
    background: disabled ? t.btnBg : t.accent,
    color: disabled ? t.textMuted : '#ffffff',
    borderRadius: 6,
    padding: '0 10px',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: t.font,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.65 : 1,
  };
}

function secondaryButtonStyle(t: Theme, disabled: boolean): CSSProperties {
  return {
    minHeight: 30,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: disabled ? t.textMuted : t.textPrimary,
    borderRadius: 6,
    padding: '0 10px',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: t.font,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

function smallActionButtonStyle(t: Theme, disabled: boolean): CSSProperties {
  return {
    minHeight: 24,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: disabled ? t.textMuted : t.textSecondary,
    borderRadius: 6,
    padding: '0 7px',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: t.font,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    textTransform: 'none',
  };
}

function inlineTextButtonStyle(t: Theme): CSSProperties {
  return {
    border: 'none',
    background: 'transparent',
    color: t.accent,
    fontFamily: t.font,
    fontSize: 10,
    fontWeight: 800,
    padding: '0 0 0 6px',
    cursor: 'pointer',
  };
}

function iconButtonStyle(t: Theme): CSSProperties {
  return {
    width: 28,
    height: 28,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    background: t.btnBg,
    color: t.textSecondary,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  };
}

function metricBoxStyle(t: Theme, color: string, active: boolean, clickable: boolean, disabled = false): CSSProperties {
  return {
    minHeight: 44,
    border: `1px solid ${active ? color : t.cellBorder}`,
    background: active ? `${color}18` : `${color}10`,
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    minWidth: 0,
    fontFamily: t.font,
    cursor: disabled ? 'not-allowed' : clickable ? 'pointer' : 'default',
    opacity: disabled ? 0.55 : 1,
    padding: 0,
    textAlign: 'center',
  };
}

function diagnosticsLineStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    borderRadius: 6,
    padding: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
    minWidth: 0,
    fontFamily: t.font,
  };
}

function diagnosticsPillStyle(t: Theme, color: string): CSSProperties {
  return {
    minHeight: 22,
    borderRadius: 999,
    border: `1px solid ${color}2e`,
    background: `${color}0d`,
    color: t.textSecondary,
    padding: '2px 7px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10,
    lineHeight: 1.2,
    maxWidth: '100%',
  };
}

function diagnosticsWarningStyle(t: Theme): CSSProperties {
  return {
    minHeight: 22,
    borderRadius: 999,
    border: `1px solid ${t.warning}3a`,
    background: `${t.warning}12`,
    color: t.warning,
    padding: '2px 7px',
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 10,
    fontWeight: 750,
    lineHeight: 1.2,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

function dossierItemStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    minWidth: 0,
    minHeight: 58,
    border: `1px solid ${color}34`,
    borderLeft: `3px solid ${color}`,
    background: `${color}0d`,
    borderRadius: 6,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 3,
    fontFamily: t.font,
  };
}

function workflowStageStyle(t: Theme, stage: ResearchWorkflowStage): CSSProperties {
  const color = toneColor(t, stage.tone);
  return {
    minWidth: 0,
    minHeight: 54,
    border: `1px solid ${stage.status === 'active' || stage.status === 'blocked' ? `${color}55` : t.cellBorder}`,
    borderLeft: `3px solid ${color}`,
    background: stage.status === 'pending' ? t.inputBg : `${color}0d`,
    borderRadius: 6,
    padding: 7,
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr)',
    alignItems: 'center',
    gap: 7,
    fontFamily: t.font,
  };
}

function workflowStageIndexStyle(t: Theme, stage: ResearchWorkflowStage): CSSProperties {
  const color = toneColor(t, stage.tone);
  return {
    width: 20,
    height: 20,
    borderRadius: 999,
    background: stage.status === 'pending' ? t.cellBg : `${color}18`,
    color,
    border: `1px solid ${color}44`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 900,
    flexShrink: 0,
  };
}

function workflowStageStatusStyle(t: Theme, stage: ResearchWorkflowStage): CSSProperties {
  const color = toneColor(t, stage.tone);
  return {
    flexShrink: 0,
    borderRadius: 999,
    background: `${color}14`,
    color,
    padding: '1px 5px',
    fontSize: 9,
    fontWeight: 850,
    textTransform: 'uppercase',
  };
}

function planStatStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    minWidth: 0,
    minHeight: 58,
    border: `1px solid ${color}34`,
    background: `${color}0c`,
    borderRadius: 6,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 3,
    fontFamily: t.font,
  };
}

function queueActionButtonStyle(t: Theme, color: string, active: boolean, disabled = false): CSSProperties {
  return {
    minWidth: 0,
    minHeight: 28,
    border: `1px solid ${active ? color : t.cellBorder}`,
    background: active ? `${color}16` : t.cellBg,
    color: disabled ? t.textMuted : active ? color : t.textSecondary,
    borderRadius: 6,
    padding: '0 7px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    fontSize: 11,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    textAlign: 'left',
  };
}

function queueActionCountStyle(color: string): CSSProperties {
  return {
    flexShrink: 0,
    minWidth: 20,
    height: 18,
    borderRadius: 999,
    padding: '0 6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `${color}16`,
    color,
    fontSize: 10,
    fontWeight: 900,
    lineHeight: 1,
  };
}

function runButtonStyle(t: Theme, active: boolean): CSSProperties {
  return {
    minHeight: 92,
    border: `1px solid ${active ? t.accent : t.cellBorder}`,
    background: active ? `${t.accent}14` : t.inputBg,
    color: t.textPrimary,
    borderRadius: 6,
    padding: 8,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    cursor: 'pointer',
    fontFamily: t.font,
    fontSize: 12,
    textAlign: 'left',
  };
}

function runChipStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    borderRadius: 999,
    background: `${color}14`,
    color,
    padding: '2px 6px',
    fontSize: 10,
    fontWeight: 800,
    lineHeight: 1.2,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

function runMetaStyle(t: Theme): CSSProperties {
  return {
    color: t.textMuted,
    fontSize: 10,
    fontFamily: t.font,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

function nextActionLineStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    marginTop: 5,
    padding: '4px 6px',
    borderLeft: `2px solid ${color}`,
    borderRadius: 4,
    background: `${color}0f`,
    color: t.textSecondary,
    fontSize: 10,
    lineHeight: 1.25,
    maxWidth: '100%',
  };
}

function workflowProgressLineStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    color: t.textMuted,
    fontSize: 10,
    lineHeight: 1.3,
    border: `1px solid ${color}22`,
    background: `${color}0b`,
    borderRadius: 5,
    padding: '3px 5px',
    width: 'fit-content',
    maxWidth: '100%',
  };
}

function nextActionCardStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    border: `1px solid ${color}40`,
    borderLeft: `3px solid ${color}`,
    background: `${color}10`,
    borderRadius: 6,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontFamily: t.font,
  };
}

function hiddenSelectionStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.accent}33`,
    background: `${t.accent}10`,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    lineHeight: 1.35,
    fontFamily: t.font,
  };
}

function pagerStyle(t: Theme): CSSProperties {
  return {
    minHeight: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: t.textMuted,
    fontSize: 11,
    fontFamily: t.font,
  };
}

function worklistReasonStyle(t: Theme, tone: ResearchTone): CSSProperties {
  const color = toneColor(t, tone);
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    color: t.textMuted,
    fontSize: 10,
    lineHeight: 1.3,
    borderLeft: `2px solid ${color}55`,
    paddingLeft: 6,
    maxWidth: '100%',
  };
}

function statusPillStyle(t: Theme, run: NotebookResearchRun): CSSProperties {
  const color = run.reviewStatus === 'completed' || run.reviewStatus === 'certified'
    ? t.success
    : run.reviewStatus === 'rejected'
      ? t.error
      : run.status === 'ready'
        ? t.success
        : run.status === 'error'
          ? t.error
          : run.status === 'running'
            ? t.accent
            : t.textMuted;
  return {
    flexShrink: 0,
    borderRadius: 999,
    background: `${color}18`,
    color,
    padding: '2px 6px',
    fontSize: 10,
    fontWeight: 700,
  };
}

function countPillStyle(t: Theme): CSSProperties {
  return {
    flexShrink: 0,
    borderRadius: 999,
    background: t.pillBg,
    color: t.textSecondary,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'none',
  };
}

function paragraphStyle(t: Theme): CSSProperties {
  return { margin: 0, color: t.textSecondary, fontSize: 12, lineHeight: 1.5, fontFamily: t.font };
}

function errorStyle(t: Theme): CSSProperties {
  return { ...warningStyle(t), color: t.error, background: `${t.error}12`, borderColor: `${t.error}44` };
}

function noticeStyle(t: Theme): CSSProperties {
  return { ...warningStyle(t), color: t.success, background: `${t.success}12`, borderColor: `${t.success}44` };
}

function warningStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.warning}44`,
    background: `${t.warning}12`,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: t.font,
  };
}

function evidenceStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    lineHeight: 1.4,
    fontFamily: t.font,
  };
}

function emptyStyle(t: Theme): CSSProperties {
  return { color: t.textMuted, fontSize: 12, lineHeight: 1.5, fontFamily: t.font, padding: '4px 0' };
}

function pathStyle(t: Theme): CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    color: t.textSecondary,
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    fontFamily: t.fontMono,
    overflowWrap: 'anywhere',
  };
}
