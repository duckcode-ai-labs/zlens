import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Bot, ChevronDown, Code2, FileInput, Plus, Search } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';
import type { BlockEntry } from '../blocks/block-types';
import { askedQuestionKey, mostAskedQuestions, type ListedRun } from './most-asked';

/**
 * SAVED QUERIES, opened on the list (the trust flow approved 2026-11-27). Two states only: a draft waits for a
 * person's review; a certified saved query answers Ask and dashboards with no AI. The list replaces the "Create
 * saved queries" cards: Drafts and Certified tabs, the Drafts tab filtered by Queries or Metrics and sorted most
 * asked first (counted from Ask's chat runs), Import, and New with Ask AI and Build manually under it. Each row says
 * where it came from: an Ask answer saved with Save, an imported SQL, Tableau or Power BI file, or one written here.
 */

export type SavedQueriesTab = 'drafts' | 'certified';
export type SavedQueriesKind = 'all' | 'queries' | 'metrics';

export interface MetricDraftEntry {
  name: string;
  label: string;
  path: string;
  domain?: string;
  inWords?: string;
  importId?: string;
}

export interface SavedQueryRow {
  key: string;
  kind: 'query' | 'metric';
  name: string;
  /** Where it came from, in a line: "From Ask · asked 4 times · saved by TEST_ADMIN". */
  source: string;
  askedTimes: number;
  /** "Draft", "Changed since certified", "Certified". */
  state: string;
  path: string;
  importId?: string;
  lastModified?: string;
}

const DRAFT_STATES = new Set(['draft', 'review', 'proposed', 'pending_recertification']);

const IMPORT_KIND_WORDS: Record<string, string> = {
  'tableau-workbook': 'Tableau',
  'powerbi-project': 'Power BI',
};

function askedWords(times: number): string | null {
  if (times <= 0) return null;
  return times === 1 ? 'asked once' : `asked ${times} times`;
}

/** The file an import read it from, as a person names it: `reports/Warriors.twbx#Season` → `Warriors.twbx`. */
function importedFileName(path: string | undefined): string | null {
  if (!path) return null;
  const file = path.split('#')[0]!.split('/').filter(Boolean).pop();
  return file || null;
}

/** One line on where a saved query came from. */
export function savedQuerySourceLine(block: Pick<BlockEntry, 'owner' | 'sourceQuestion' | 'importedFrom' | 'automaticDraft'>, askedTimes: number): string {
  const parts: string[] = [];
  if (block.importedFrom) {
    parts.push(`From ${IMPORT_KIND_WORDS[block.importedFrom.kind] ?? 'SQL'}`);
    const file = importedFileName(block.importedFrom.path);
    if (file) parts.push(file);
  } else if (block.sourceQuestion || block.automaticDraft) {
    parts.push('From Ask');
    const asked = askedWords(askedTimes);
    if (asked) parts.push(asked);
    if (block.owner && !block.automaticDraft) parts.push(`saved by ${block.owner}`);
  } else {
    parts.push('Written here');
    if (block.owner) parts.push(block.owner);
  }
  return parts.join(' · ');
}

/**
 * The rows a tab shows: drafts (saved queries waiting for review, and metric drafts) or certified saved queries,
 * most asked first, then the most recently changed. Retired saved queries are in neither.
 */
export function savedQueryRows(input: {
  blocks: ReadonlyArray<BlockEntry>;
  metricDrafts: ReadonlyArray<MetricDraftEntry>;
  runs: ReadonlyArray<ListedRun>;
  tab: SavedQueriesTab;
  kind: SavedQueriesKind;
  search?: string;
}): SavedQueryRow[] {
  const asked = new Map(mostAskedQuestions(input.runs).map((entry) => [entry.key, entry.askedTimes]));
  const askedOf = (block: BlockEntry) => Math.max(
    block.sourceQuestion ? asked.get(askedQuestionKey(block.sourceQuestion)) ?? 0 : 0,
    block.askedTimes ?? 0,
  );
  const live = input.blocks.filter((block) => !block.replacedBy && !block.deprecatedOn && block.status !== 'deprecated');
  const queries: SavedQueryRow[] = (input.kind === 'metrics' && input.tab === 'drafts' ? [] : live)
    .filter((block) => (input.tab === 'certified' ? block.status === 'certified' : DRAFT_STATES.has(block.status)))
    .map((block) => {
      const times = askedOf(block);
      return {
        key: `query:${block.path}`,
        kind: 'query' as const,
        name: block.name,
        source: savedQuerySourceLine(block, times),
        askedTimes: times,
        state: block.status === 'certified' ? 'Certified' : block.status === 'pending_recertification' ? 'Changed since certified' : 'Draft',
        path: block.path,
        lastModified: block.lastModified,
      };
    });
  const metrics: SavedQueryRow[] = input.tab === 'drafts' && input.kind !== 'queries'
    ? input.metricDrafts.map((draft) => ({
      key: `metric:${draft.path}`,
      kind: 'metric' as const,
      name: draft.label || draft.name,
      source: draft.importId ? 'From an import' : 'Metric draft',
      askedTimes: 0,
      state: 'Draft',
      path: draft.path,
      ...(draft.importId ? { importId: draft.importId } : {}),
    }))
    : [];
  const words = input.search?.trim().toLowerCase();
  return [...queries, ...metrics]
    .filter((row) => !words || `${row.name} ${row.source}`.toLowerCase().includes(words))
    .sort((left, right) => right.askedTimes - left.askedTimes
      || String(right.lastModified ?? '').localeCompare(String(left.lastModified ?? ''))
      || left.name.localeCompare(right.name));
}

/** The tab the list opens on: Drafts, unless there are none and something is certified. */
export function openingSavedQueriesTab(counts: { drafts: number; certified: number }): SavedQueriesTab {
  return counts.drafts === 0 && counts.certified > 0 ? 'certified' : 'drafts';
}

export function SavedQueriesHome({
  onImport,
  onAskAi,
  onBuildManually,
  onBlankSql,
  onReviewMetricDraft,
  readOnlyReason,
  openNewMenu,
  onNewMenuShown,
  t,
}: {
  onImport?: () => void;
  onAskAi: () => void;
  onBuildManually?: () => void;
  onBlankSql?: () => void;
  /** Opens the import a metric draft came from: it is reviewed and approved there. */
  onReviewMetricDraft: (importId: string) => void;
  readOnlyReason?: string;
  /** Show New saved query's choices at once (the toolbar's New saved query, pressed on a saved query's page). */
  openNewMenu?: boolean;
  onNewMenuShown?: () => void;
  t: Theme;
}) {
  const { dispatch } = useNotebook();
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metricDrafts, setMetricDrafts] = useState<MetricDraftEntry[]>([]);
  const [runs, setRuns] = useState<ListedRun[]>([]);
  const [tab, setTab] = useState<SavedQueriesTab>('drafts');
  const [kind, setKind] = useState<SavedQueriesKind>('all');
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Saving or certifying anywhere changes the list.
    const changed = () => setVersion((current) => current + 1);
    window.addEventListener('dql:block-library-invalidated', changed);
    return () => window.removeEventListener('dql:block-library-invalidated', changed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getBlockLibrary(),
      api.listMetricDrafts().catch(() => []),
      api.listAgentRuns({ limit: 200 }).catch(() => null),
    ]).then(([library, drafts, history]) => {
      if (cancelled) return;
      setBlocks(library.blocks as BlockEntry[]);
      setLoadError(library.error ?? null);
      setMetricDrafts(drafts);
      setRuns((history?.runs ?? []) as unknown as ListedRun[]);
    });
    return () => { cancelled = true; };
  }, [version]);

  useEffect(() => {
    if (!openNewMenu) return;
    setNewOpen(true);
    onNewMenuShown?.();
  }, [openNewMenu, onNewMenuShown]);

  useEffect(() => {
    if (!newOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNewOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [newOpen]);

  const rows = useMemo(
    () => (blocks ? savedQueryRows({ blocks, metricDrafts, runs, tab, kind, search }) : []),
    [blocks, metricDrafts, runs, tab, kind, search],
  );
  const counts = useMemo(() => ({
    drafts: blocks ? savedQueryRows({ blocks, metricDrafts, runs, tab: 'drafts', kind: 'all' }).length : 0,
    certified: blocks ? savedQueryRows({ blocks, metricDrafts, runs, tab: 'certified', kind: 'all' }).length : 0,
  }), [blocks, metricDrafts, runs]);
  // Open on the tab that has something in it, once, unless the person already picked one.
  const tabSettled = useRef(false);
  useEffect(() => {
    if (!blocks || tabSettled.current) return;
    tabSettled.current = true;
    setTab(openingSavedQueriesTab(counts));
  }, [blocks, counts]);
  const pickTab = (next: SavedQueriesTab) => {
    tabSettled.current = true;
    setTab(next);
  };

  const openRow = useCallback((row: SavedQueryRow) => {
    if (row.kind === 'metric') {
      if (row.importId) onReviewMetricDraft(row.importId);
      return;
    }
    const file = { name: row.path.split('/').pop() ?? row.path, path: row.path, type: 'block' as const, folder: 'blocks' };
    void api.openBlockStudio(row.path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload })).catch(() => undefined);
  }, [dispatch, onReviewMetricDraft]);

  const buttonStyle = (primary: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${primary ? t.accent : t.btnBorder}`,
    background: primary ? t.accent : t.btnBg,
    color: primary ? '#ffffff' : t.textPrimary,
    borderRadius: 6,
    padding: '6px 11px',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  const tabStyle = (active: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: 'none',
    borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
    color: active ? t.textPrimary : t.textMuted,
    fontWeight: active ? 700 : 500,
    fontSize: 13,
    fontFamily: t.font,
    padding: '8px 2px',
    marginRight: 16,
    cursor: 'pointer',
  });
  const chipStyle = (selected: boolean): React.CSSProperties => ({
    border: `1px solid ${selected ? t.accent : t.headerBorder}`,
    background: selected ? `${t.accent}14` : 'transparent',
    color: selected ? t.accent : t.textSecondary,
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 11.5,
    fontWeight: 600,
    fontFamily: t.font,
    cursor: 'pointer',
  });
  const newOptions = [
    { label: 'Ask AI', detail: 'Describe it; ZLens drafts it from your project.', Icon: Bot, action: onAskAi },
    onBuildManually && { label: 'Build manually', detail: 'Pick metrics, dimensions, time grain and filters.', Icon: Blocks, action: onBuildManually },
    onBlankSql && { label: 'Blank SQL query', detail: 'Start from an empty query.', Icon: Code2, action: onBlankSql },
  ].filter((option): option is NonNullable<typeof option> => Boolean(option));

  return (
    <div data-testid="saved-queries-home" style={{ height: '100%', overflow: 'auto', padding: 22, display: 'grid', gap: 12, alignContent: 'start', background: t.appBg, fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: t.textPrimary }}>Saved queries</div>
          <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45, marginTop: 5, maxWidth: 560 }}>
            Certified saved queries answer Ask and dashboards with no AI. Drafts wait for you to review and certify them.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {onImport ? (
            <button type="button" onClick={onImport} style={buttonStyle(false)}>
              <FileInput size={13} aria-hidden="true" /> Import
            </button>
          ) : null}
          <div ref={newMenuRef} style={{ position: 'relative' }}>
            <button type="button" aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen((open) => !open)} style={buttonStyle(true)}>
              <Plus size={13} aria-hidden="true" /> New saved query <ChevronDown size={12} aria-hidden="true" />
            </button>
            {newOpen ? (
              <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, width: 280, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 6, display: 'grid', gap: 2 }}>
                {newOptions.map(({ label, detail, Icon, action }) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    onClick={() => { setNewOpen(false); action(); }}
                    style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', gap: 8, alignItems: 'start', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 6, padding: '8px 8px', cursor: 'pointer', color: t.textPrimary, fontFamily: t.font }}
                  >
                    <Icon size={15} color={t.accent} aria-hidden="true" />
                    <span style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
                      <span style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>{detail}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {readOnlyReason && !onBuildManually ? <div style={{ fontSize: 12, color: t.textMuted }}>{readOnlyReason}</div> : null}

      <div role="tablist" aria-label="Saved queries" style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.headerBorder}` }}>
        <button type="button" role="tab" aria-selected={tab === 'drafts'} onClick={() => pickTab('drafts')} style={tabStyle(tab === 'drafts')}>
          Drafts{blocks ? ` (${counts.drafts})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'certified'} onClick={() => pickTab('certified')} style={tabStyle(tab === 'certified')}>
          Certified{blocks ? ` (${counts.certified})` : ''}
        </button>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${t.inputBorder}`, background: t.inputBg, borderRadius: 6, padding: '4px 8px', marginBottom: 6 }}>
          <Search size={12} color={t.textMuted} aria-hidden="true" />
          <input
            aria-label="Search saved queries"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: t.textPrimary, fontSize: 12, fontFamily: t.font, width: 160 }}
          />
        </label>
      </div>

      {tab === 'drafts' ? (
        <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['all', 'queries', 'metrics'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} style={chipStyle(kind === value)}>
              {value === 'all' ? 'All' : value === 'queries' ? 'Queries' : 'Metrics'}
            </button>
          ))}
          <span style={{ fontSize: 11.5, color: t.textMuted, marginLeft: 4 }}>Most asked first</span>
        </div>
      ) : null}

      {loadError ? (
        <div role="alert" style={{ fontSize: 12, color: t.error }}>{loadError}</div>
      ) : !blocks ? (
        <div style={{ fontSize: 12, color: t.textMuted }}>Loading saved queries…</div>
      ) : rows.length === 0 ? (
        <div style={{ border: `1px dashed ${t.headerBorder}`, borderRadius: 8, padding: 16, fontSize: 12.5, color: t.textMuted, lineHeight: 1.5 }}>
          {search.trim()
            ? 'Nothing matches that search.'
            : tab === 'certified'
              ? 'Nothing is certified yet. Open a draft, review what it returns and how it is worked out, then certify it.'
              : 'No drafts. Save an answer from Ask, import the SQL behind your reports, or start a new saved query.'}
        </div>
      ) : (
        <div role="list" style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, overflow: 'hidden' }}>
          {rows.map((row, index) => (
            <div
              key={row.key}
              role="listitem"
              data-testid="saved-query-row"
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 12, alignItems: 'center', padding: '10px 14px', borderTop: index === 0 ? 'none' : `1px solid ${t.headerBorder}` }}
            >
              <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>{row.name}</span>
                <span style={{ fontSize: 11.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.source}{row.state === 'Changed since certified' ? ' · changed since certified' : ''}
                </span>
              </div>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textSecondary, border: `1px solid ${t.headerBorder}`, borderRadius: 999, padding: '2px 8px' }}>
                {row.kind === 'metric' ? 'Metric' : 'Query'}
              </span>
              <button type="button" onClick={() => openRow(row)} disabled={row.kind === 'metric' && !row.importId} style={buttonStyle(false)}>
                {tab === 'certified' ? 'Open' : 'Review'}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'drafts' ? (
        <div style={{ fontSize: 11.5, color: t.textMuted }}>Drafts aren&apos;t used to answer questions until you certify them.</div>
      ) : null}
    </div>
  );
}
