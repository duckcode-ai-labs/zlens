import type { Theme } from '../../themes/notebook-theme';
import React, { useMemo, useState } from 'react';
import { ArrowRight, BookOpenText, Blocks, FileText, Home, ListChecks, Workflow, type LucideIcon } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import type { NotebookFile } from '../../store/types';
import {
  compareNotebookResearchSummaries,
  notebookResearchSummaryDetail,
  notebookResearchSummaryLabel,
  notebookResearchNextActionLabel,
  notebookResearchSummaryTone,
  notebookResearchSummaryTitle,
  type NotebookResearchOwnerSummary,
  type NotebookResearchSummaryTone,
  type NotebookResearchSummary,
  useNotebookResearchSummary,
} from './useNotebookResearchSummary';

interface WelcomeScreenProps {
  onOpenFile: (file: NotebookFile) => void;
  onOpenResearchFile?: (file: NotebookFile, options?: { ownerFilter?: string }) => void;
}

type ResearchQueueItem = {
  summary: NotebookResearchSummary;
  file?: NotebookFile;
};

type ResearchQueueTotals = {
  total: number;
  draftReady: number;
  certificationReady: number;
  blocked: number;
  staleOpen: number;
  expiredOpen: number;
  missingNotebooks: number;
};

const RESEARCH_QUEUE_COMPACT_LIMIT = 3;
const RESEARCH_QUEUE_EXPANDED_LIMIT = 12;
const RESEARCH_OWNER_FOCUS_LIMIT = 3;

export function WelcomeScreen({ onOpenFile, onOpenResearchFile }: WelcomeScreenProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const hostUi = useHostUi();
  const readOnlyFiles = hostReadOnly(hostUi, 'files');
  const readOnlyBlocks = hostReadOnly(hostUi, 'block_library');
  const fileSignature = state.files.map((file) => file.path).join('|');
  const { byPath: researchByNotebookPath, summaries, ownerSummaries } = useNotebookResearchSummary({ refreshKey: fileSignature });
  const notebookFilesByPath = useMemo(() => {
    const map = new Map<string, NotebookFile>();
    for (const file of state.files) {
      if (file.type === 'notebook' || file.type === 'workbook') map.set(file.path, file);
    }
    return map;
  }, [state.files]);
  const researchWorkspaceStats = useMemo(() => (
    summaries.reduce((stats, summary) => {
      if (summary.total <= 0) return stats;
      stats.totalResearch += summary.total;
      if (notebookFilesByPath.has(summary.path)) {
        stats.openResearch += summary.total;
        stats.openNotebooks += 1;
      } else {
        stats.missingResearch += summary.total;
        stats.missingNotebooks += 1;
      }
      return stats;
    }, {
      totalResearch: 0,
      openResearch: 0,
      openNotebooks: 0,
      missingResearch: 0,
      missingNotebooks: 0,
    })
  ), [notebookFilesByPath, summaries]);
  const activeResearchCount = researchWorkspaceStats.totalResearch;
  const recentResearchLabel = [
    `${researchWorkspaceStats.openResearch.toLocaleString()} AI history`,
    `${researchWorkspaceStats.openNotebooks.toLocaleString()} notebook${researchWorkspaceStats.openNotebooks === 1 ? '' : 's'}`,
    ownerSummaries.length > 0
      ? `${ownerSummaries.length.toLocaleString()} owner${ownerSummaries.length === 1 ? '' : 's'}`
      : undefined,
    researchWorkspaceStats.missingNotebooks > 0
      ? `${researchWorkspaceStats.missingNotebooks.toLocaleString()} missing`
      : undefined,
  ].filter(Boolean).join(' · ');
  const researchQueueItems = useMemo(() => (
    summaries
      .filter((summary) => summary.total > 0)
      .map((summary) => ({ summary, file: notebookFilesByPath.get(summary.path) }))
      .sort(compareResearchQueueItems)
  ), [notebookFilesByPath, summaries]);
  const recentFiles = useMemo(() => (
    state.files
      .filter((file) => file.type === 'notebook' || file.type === 'workbook')
      .map((file) => ({ file, researchSummary: researchByNotebookPath.get(file.path) }))
      .sort(compareRecentNotebookFiles)
      .slice(0, 5)
  ), [researchByNotebookPath, state.files]);
  const researchQueueTotals = useMemo(() => (
    summaries.reduce((totals, summary) => {
      if (!notebookFilesByPath.has(summary.path)) return totals;
      return {
        total: totals.total + summary.total,
        draftReady: totals.draftReady + summary.draftReady,
        certificationReady: totals.certificationReady + summary.certificationReady,
        blocked: totals.blocked + summary.blocked,
        staleOpen: totals.staleOpen + summary.staleOpen,
        expiredOpen: totals.expiredOpen + summary.expiredOpen,
        missingNotebooks: researchWorkspaceStats.missingNotebooks,
      };
    }, {
      total: 0,
      draftReady: 0,
      certificationReady: 0,
      blocked: 0,
      staleOpen: 0,
      expiredOpen: 0,
      missingNotebooks: researchWorkspaceStats.missingNotebooks,
    })
  ), [notebookFilesByPath, researchWorkspaceStats.missingNotebooks, summaries]);

  // The one notebook (if any) whose saved AI history we open from the compact
  // "Open history" affordance — the first research run that still has its file.
  const primaryResearchFile = useMemo(() => {
    for (const summary of summaries) {
      if (summary.total <= 0) continue;
      const file = notebookFilesByPath.get(summary.path);
      if (file) return file;
    }
    return undefined;
  }, [summaries, notebookFilesByPath]);
  const openHistory = () => {
    if (!primaryResearchFile) return;
    if (onOpenResearchFile) onOpenResearchFile(primaryResearchFile);
    else onOpenFile(primaryResearchFile);
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.appBg,
        padding: 28,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          width: 'min(720px, 100%)',
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 8,
          background: t.cellBg,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
          <div>
            <h1 style={{ margin: 0, color: t.textPrimary, fontSize: 24, lineHeight: 1.2, fontWeight: 800 }}>
              Notebook workspace
            </h1>
            <p style={{ margin: '8px 0 0', color: t.textSecondary, fontSize: 13, lineHeight: 1.55, maxWidth: 520 }}>
              Open a notebook to explore data — write SQL/DQL, chart the results, and
              save what is reusable as a saved query. Create a new one to start a focused analysis.
            </p>
          </div>
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: 'var(--color-accent-purple-soft)',
              color: 'var(--color-accent-purple)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <BookOpenText size={20} strokeWidth={2} aria-hidden="true" />
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {!readOnlyFiles && (
            <ActionButton
              label="New Notebook"
              Icon={BookOpenText}
              primary
              onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
              t={t}
            />
          )}
          {!readOnlyBlocks && (
            <ActionButton
              label="New saved query"
              Icon={Blocks}
              onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
              t={t}
            />
          )}
          <ActionButton
            label="Home"
            Icon={Home}
            onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'apps' })}
            t={t}
          />
        </div>

        {/* Recent notebooks — the primary content: open one to keep working. */}
        <div style={{ borderTop: `1px solid ${t.cellBorder}`, paddingTop: 16 }}>
          <div
            style={{
              color: t.textMuted,
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Recent notebooks
          </div>
          {recentFiles.length === 0 ? (
            <div style={{ color: t.textMuted, fontSize: 13 }}>No notebooks yet — create one to get started.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {recentFiles.map(({ file, researchSummary }) => (
                <RecentFile
                  key={file.path}
                  file={file}
                  researchSummary={researchSummary}
                  onOpen={() => onOpenFile(file)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>

        {/* Saved AI history — a quiet, secondary pointer. Reopen only for audit /
            review / DQL promotion. Orphaned runs (deleted notebooks) are hidden here
            and live behind "Open history". */}
        {researchWorkspaceStats.openResearch > 0 && primaryResearchFile && (
          <button
            type="button"
            onClick={openHistory}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
              border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.inputBg,
              color: t.textSecondary, padding: '10px 12px', cursor: 'pointer', fontFamily: t.font,
            }}
          >
            <ListChecks size={16} strokeWidth={2} color={t.accent} aria-hidden="true" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 750, color: t.textPrimary }}>Saved AI history</span>
              <span style={{ display: 'block', fontSize: 11, color: t.textMuted, marginTop: 1, lineHeight: 1.4 }}>
                {researchWorkspaceStats.openResearch.toLocaleString()} saved run{researchWorkspaceStats.openResearch === 1 ? '' : 's'} across{' '}
                {researchWorkspaceStats.openNotebooks.toLocaleString()} notebook{researchWorkspaceStats.openNotebooks === 1 ? '' : 's'} — reopen for audit, review, or DQL promotion.
              </span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.accent, fontSize: 12, fontWeight: 850, flexShrink: 0 }}>
              Open history
              <ArrowRight size={14} strokeWidth={2.1} aria-hidden="true" />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function ResearchQueueOverview({
  items,
  totals,
  ownerSummaries,
  onOpenFile,
  onOpenResearchFile,
  t,
}: {
  items: ResearchQueueItem[];
  totals: ResearchQueueTotals;
  ownerSummaries: NotebookResearchOwnerSummary[];
  onOpenFile: (file: NotebookFile) => void;
  onOpenResearchFile?: (file: NotebookFile, options?: { ownerFilter?: string }) => void;
  t: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryItem = items.find((item) => item.file);
  const primaryFile = primaryItem?.file;
  const openResearchFile = (file: NotebookFile, options?: { ownerFilter?: string }) => {
    if (onOpenResearchFile) {
      onOpenResearchFile(file, options);
      return;
    }
    onOpenFile(file);
  };
  const visibleLimit = expanded ? RESEARCH_QUEUE_EXPANDED_LIMIT : RESEARCH_QUEUE_COMPACT_LIMIT;
  const visibleItems = items.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const expandableCount = Math.max(0, Math.min(items.length, RESEARCH_QUEUE_EXPANDED_LIMIT) - RESEARCH_QUEUE_COMPACT_LIMIT);
  const canExpand = items.length > RESEARCH_QUEUE_COMPACT_LIMIT;
  const visibleOwnerSummaries = ownerSummaries.slice(0, RESEARCH_OWNER_FOCUS_LIMIT);
  return (
    <section
      aria-label="Project AI history"
      style={{
        borderTop: `1px solid ${t.cellBorder}`,
        borderBottom: `1px solid ${t.cellBorder}`,
        padding: '14px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: t.textPrimary, fontSize: 13, fontWeight: 850, display: 'flex', alignItems: 'center', gap: 7 }}>
            <ListChecks size={15} strokeWidth={2} color={t.accent} aria-hidden="true" />
            Project AI history
          </div>
          <div style={{ marginTop: 3, color: t.textMuted, fontSize: 12, lineHeight: 1.4 }}>
            Reopen saved AI work only when you need audit, review, or DQL promotion context.
          </div>
        </div>
        {primaryFile && (
          <button
            type="button"
            onClick={() => openResearchFile(primaryFile)}
            style={{
              height: 30,
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              background: t.accent,
              color: 'var(--accent-on, #fff)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '0 10px',
              fontSize: 12,
              fontWeight: 850,
              fontFamily: t.font,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Open history
            <ArrowRight size={14} strokeWidth={2.1} aria-hidden="true" />
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8 }}>
        <QueueMetric label="AI history" value={totals.total} color={t.accent} t={t} />
        <QueueMetric label="Draft ready" value={totals.draftReady} color={t.accent} t={t} />
        <QueueMetric label="Cert ready" value={totals.certificationReady} color={t.success} t={t} />
        <QueueMetric label="Blocked" value={totals.blocked} color={t.error} t={t} />
        {totals.expiredOpen > 0 && (
          <QueueMetric label="30d+" value={totals.expiredOpen} color={t.error} t={t} />
        )}
        {totals.staleOpen > 0 && (
          <QueueMetric label="Stale" value={totals.staleOpen} color={t.warning} t={t} />
        )}
        {totals.missingNotebooks > 0 && (
          <QueueMetric label="Missing" value={totals.missingNotebooks} color={t.warning} t={t} />
        )}
      </div>

      {visibleOwnerSummaries.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <span style={{ color: t.textMuted, fontSize: 11, fontWeight: 800 }}>Owner focus</span>
          {visibleOwnerSummaries.map((owner) => {
            const color = researchToneColor(notebookResearchOwnerSummaryTone(owner), t);
            const disabled = !primaryFile;
            return (
              <button
                key={owner.owner}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (primaryFile) openResearchFile(primaryFile, { ownerFilter: owner.owner });
                }}
                title={disabled ? 'Open a notebook before filtering AI history by owner.' : notebookResearchOwnerSummaryTitle(owner)}
                style={{
                  minWidth: 0,
                  maxWidth: 180,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  border: `1px solid ${color}44`,
                  background: `${color}12`,
                  color,
                  borderRadius: 999,
                  padding: '2px 8px',
                  fontSize: 10,
                  fontWeight: 850,
                  fontFamily: t.font,
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                {owner.owner} · {notebookResearchOwnerSummaryLabel(owner)}
              </button>
            );
          })}
        </div>
      )}

      {visibleItems.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {visibleItems.map((item) => (
            <ResearchQueueRow
              key={item.summary.path}
              item={item}
              onOpenFile={openResearchFile}
              t={t}
            />
          ))}
        </div>
      )}
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          style={{
            height: 28,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 6,
            background: t.btnBg,
            color: t.textSecondary,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '0 10px',
            fontSize: 12,
            fontWeight: 800,
            fontFamily: t.font,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Show fewer' : `Show ${expandableCount.toLocaleString()} more`}
          {expanded && hiddenCount > 0 && (
            <span style={{ color: t.textMuted, fontWeight: 700 }}>
              {hiddenCount.toLocaleString()} more not shown
            </span>
          )}
        </button>
      )}
    </section>
  );
}

function QueueMetric({ label, value, color, t }: { label: string; value: number; color: string; t: Theme }) {
  return (
    <div
      style={{
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        border: `1px solid ${color}33`,
        borderRadius: 6,
        background: `${color}0f`,
        padding: '7px 9px',
      }}
    >
      <span style={{ color: t.textMuted, fontSize: 11, fontWeight: 750 }}>{label}</span>
      <span style={{ color, fontSize: 13, fontWeight: 900 }}>{value.toLocaleString()}</span>
    </div>
  );
}

function ResearchQueueRow({
  item,
  onOpenFile,
  t,
}: {
  item: ResearchQueueItem;
  onOpenFile: (file: NotebookFile) => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const missingFile = !item.file;
  const color = missingFile ? t.warning : researchSummaryColor(item.summary, t);
  const disabled = missingFile;
  const name = item.file?.name.replace(/\.(dqlnb|dql)$/i, '') || item.summary.title;
  const detail = missingFile
    ? `Missing notebook file · ${notebookResearchSummaryDetail(item.summary)}`
    : notebookResearchSummaryDetail(item.summary);
  const title = missingFile
    ? `${notebookResearchSummaryTitle(item.summary)} · Missing notebook file`
    : notebookResearchSummaryTitle(item.summary);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (item.file) onOpenFile(item.file);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 34,
        border: `1px solid ${hovered && !disabled ? t.accent : t.cellBorder}`,
        borderRadius: 6,
        background: hovered && !disabled ? t.sidebarItemHover : t.inputBg,
        color: disabled ? t.textMuted : t.textSecondary,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: t.font,
      }}
      title={title}
    >
      <BookOpenText size={14} strokeWidth={2} color={color} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2, textAlign: 'left' }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: disabled ? t.textMuted : t.textSecondary }}>
          {name}
        </span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: t.textMuted }}>
          {detail}
        </span>
      </span>
      <span
        style={{
          border: `1px solid ${color}44`,
          background: `${color}12`,
          color,
          borderRadius: 999,
          padding: '2px 7px',
          fontSize: 10,
          fontWeight: 850,
          flexShrink: 0,
        }}
      >
        {missingFile ? 'Missing file' : notebookResearchSummaryLabel(item.summary, { includeCount: true })}
      </span>
    </button>
  );
}

function ActionButton({
  label,
  Icon,
  onClick,
  primary = false,
  t,
}: {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  primary?: boolean;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 34,
        borderRadius: 6,
        border: `1px solid ${primary ? t.accent : hovered ? t.accent : t.cellBorder}`,
        background: primary ? (hovered ? t.accentHover : t.accent) : hovered ? t.sidebarItemHover : t.inputBg,
        color: primary ? 'var(--accent-on, #fff)' : hovered ? t.textPrimary : t.textSecondary,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 800,
        fontFamily: t.font,
        cursor: 'pointer',
      }}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

function compareResearchQueueItems(a: ResearchQueueItem, b: ResearchQueueItem): number {
  if (a.file && !b.file) return -1;
  if (!a.file && b.file) return 1;
  return compareNotebookResearchSummaries(a.summary, b.summary);
}

function compareRecentNotebookFiles(
  a: { file: NotebookFile; researchSummary?: NotebookResearchSummary },
  b: { file: NotebookFile; researchSummary?: NotebookResearchSummary },
): number {
  if (a.researchSummary && b.researchSummary) {
    const researchOrder = compareNotebookResearchSummaries(a.researchSummary, b.researchSummary);
    if (researchOrder !== 0) return researchOrder;
  }
  if (a.researchSummary) return -1;
  if (b.researchSummary) return 1;
  return a.file.name.localeCompare(b.file.name);
}

function researchSummaryColor(summary: NotebookResearchSummary, t: Theme): string {
  return researchToneColor(notebookResearchSummaryTone(summary), t);
}

function notebookResearchOwnerSummaryLabel(summary: NotebookResearchOwnerSummary): string {
  if (summary.blocked > 0) return `${summary.blocked.toLocaleString()} blocked`;
  if (summary.expiredOpen > 0) return `${summary.expiredOpen.toLocaleString()} 30d+`;
  if (summary.staleOpen > 0) return `${summary.staleOpen.toLocaleString()} stale`;
  const nextActionLabel = notebookResearchNextActionLabel(summary.nextAction);
  if (nextActionLabel) {
    const count = typeof summary.nextActionCount === 'number' && summary.nextActionCount > 0
      ? summary.nextActionCount
      : undefined;
    return count ? `${nextActionLabel} · ${count.toLocaleString()}` : nextActionLabel;
  }
  if (summary.certificationReady > 0) return `${summary.certificationReady.toLocaleString()} cert`;
  if (summary.draftReady > 0) return `${summary.draftReady.toLocaleString()} draft`;
  return `${summary.total.toLocaleString()} research`;
}

function notebookResearchOwnerSummaryTitle(summary: NotebookResearchOwnerSummary): string {
  const nextActionLabel = notebookResearchNextActionLabel(summary.nextAction);
  return [
    `${summary.owner}: ${summary.total.toLocaleString()} research ${summary.total === 1 ? 'run' : 'runs'}`,
    nextActionLabel && summary.nextActionCount
      ? `Next: ${nextActionLabel} (${summary.nextActionCount.toLocaleString()})`
      : undefined,
    `${summary.draftReady.toLocaleString()} draft ready`,
    `${summary.certificationReady.toLocaleString()} certification ready`,
    `${summary.blocked.toLocaleString()} blocked`,
    `${summary.staleOpen.toLocaleString()} stale open`,
    `${summary.expiredOpen.toLocaleString()} open 30d+`,
  ].filter(Boolean).join(' · ');
}

function notebookResearchOwnerSummaryTone(summary: NotebookResearchOwnerSummary): NotebookResearchSummaryTone {
  if (summary.blocked > 0 || summary.expiredOpen > 0) return 'error';
  if (summary.staleOpen > 0) return 'warning';
  switch (summary.nextAction) {
    case 'fix_blockers':
      return 'error';
    case 'review_sql':
    case 'review_context':
    case 'run_preview':
    case 'reuse_existing':
      return 'warning';
    case 'open_certification':
      return 'success';
    case 'create_dql_draft':
    case 'complete_review':
      return 'accent';
    case 'continue_review':
      return 'neutral';
    default:
      break;
  }
  if (summary.certificationReady > 0) return 'success';
  if (summary.draftReady > 0) return 'accent';
  return 'neutral';
}

function researchToneColor(tone: NotebookResearchSummaryTone, t: Theme): string {
  switch (tone) {
    case 'error':
      return t.error;
    case 'warning':
      return t.warning;
    case 'success':
      return t.success;
    case 'accent':
      return t.accent;
    case 'neutral':
    default:
      return t.textMuted;
  }
}

function RecentFile({
  file,
  researchSummary,
  onOpen,
  t,
}: {
  file: NotebookFile;
  researchSummary?: NotebookResearchSummary;
  onOpen: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = file.type === 'workbook' ? Workflow : FileText;
  const researchTone = researchSummary
    ? researchSummaryColor(researchSummary, t)
    : t.textMuted;
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 36,
        border: `1px solid ${hovered ? t.accent : t.cellBorder}`,
        borderRadius: 6,
        background: hovered ? t.sidebarItemHover : t.inputBg,
        color: hovered ? t.textPrimary : t.textSecondary,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '0 10px',
        cursor: 'pointer',
        fontFamily: t.font,
      }}
    >
      <Icon size={15} strokeWidth={2} color={hovered ? t.accent : t.textMuted} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name.replace(/\.(dqlnb|dql)$/i, '')}
      </span>
      {researchSummary && researchSummary.total > 0 && (
        <span
          title={notebookResearchSummaryTitle(researchSummary)}
          style={{
            border: `1px solid ${researchTone}44`,
            background: `${researchTone}12`,
            color: researchTone,
            borderRadius: 999,
            padding: '2px 7px',
            fontSize: 10,
            fontWeight: 800,
            flexShrink: 0,
          }}
        >
          {notebookResearchSummaryLabel(researchSummary, { includeCount: true })}
        </span>
      )}
      <span style={{ color: t.textMuted, fontSize: 11 }}>{file.type}</span>
    </button>
  );
}
