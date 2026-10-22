import type { NotebookResearchRun } from '../api/client';
import type { Cell } from '../store/types';
import { extractSqlFromText } from './block-studio';

export const NOTEBOOK_RESEARCH_CHANGED_EVENT = 'dql:notebook-research-changed';

export type NotebookResearchChangedDetail = {
  notebookPath?: string;
  sourceCellId?: string;
  runId?: string;
  reason?: string;
};

export type NotebookResearchSourceCellOption = {
  id: string;
  name: string;
  type: 'sql' | 'dql';
  sql: string;
  fingerprint: string;
};

export type NotebookResearchSourceSyncStatus = 'synced' | 'changed' | 'missing' | 'unknown';

export type CellResearchStateKind =
  | 'new'
  | 'changed'
  | 'missing'
  | 'blocked'
  | 'review_sql'
  | 'review_context'
  | 'run_preview'
  | 'reuse'
  | 'draft_ready'
  | 'cert_ready'
  | 'complete'
  | 'done'
  | 'unknown';

export type CellResearchState = {
  kind: CellResearchStateKind;
  label: string;
  title: string;
  run?: NotebookResearchRun;
  syncStatus?: NotebookResearchSourceSyncStatus | null;
};

export function emitNotebookResearchChanged(detail: NotebookResearchChangedDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<NotebookResearchChangedDetail>(NOTEBOOK_RESEARCH_CHANGED_EVENT, { detail }));
}

export function notebookResearchSourceCellOption(cell: Cell): NotebookResearchSourceCellOption | null {
  if (cell.type !== 'sql' && cell.type !== 'dql') return null;
  const sql = cell.type === 'sql'
    ? cell.content.trim()
    : extractSqlFromText(cell.content)?.trim() ?? '';
  if (!sql) return null;
  return {
    id: cell.id,
    name: cell.name || `${cell.type.toUpperCase()} ${cell.id.slice(-4)}`,
    type: cell.type,
    sql,
    fingerprint: fingerprintNotebookResearchSql(sql),
  };
}

export function notebookResearchSourceCellOptionFromMissingRun(run: NotebookResearchRun): NotebookResearchSourceCellOption {
  const id = run.sourceCellId ?? run.id;
  const sql = run.reviewedSql?.trim() || run.generatedSql?.trim() || '';
  return {
    id,
    name: run.sourceCellName || `Deleted source ${id.slice(-4)}`,
    type: 'sql',
    sql,
    fingerprint: run.sourceCellFingerprint || (sql ? fingerprintNotebookResearchSql(sql) : ''),
  };
}

export function fingerprintNotebookResearchSql(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function sourceFingerprintForReviewedSql(source: NotebookResearchSourceCellOption | null, sql?: string): string | undefined {
  if (!source || !sql?.trim()) return undefined;
  return fingerprintNotebookResearchSql(sql) === source.fingerprint ? source.fingerprint : undefined;
}

export function notebookResearchSourceSyncStatus(
  run: NotebookResearchRun | null,
  sourceCellById: Map<string, NotebookResearchSourceCellOption>,
): NotebookResearchSourceSyncStatus | null {
  if (!run?.sourceCellId) return null;
  const source = sourceCellById.get(run.sourceCellId);
  if (!source) return 'missing';
  if (!run.sourceCellFingerprint) return 'unknown';
  return run.sourceCellFingerprint === source.fingerprint ? 'synced' : 'changed';
}

export function deriveCellResearchState(
  source: NotebookResearchSourceCellOption | null,
  run?: NotebookResearchRun | null,
  syncStatus?: NotebookResearchSourceSyncStatus | null,
): CellResearchState | null {
  if (!source) return null;
  if (!run) {
    return {
      kind: 'new',
      label: 'AI: New',
      title: 'Ask AI from this source cell.',
      syncStatus: null,
    };
  }
  if (syncStatus === 'changed') {
    return {
      kind: 'changed',
      label: 'AI history changed',
      title: 'This source cell changed after the saved AI history. Ask AI again before promotion.',
      run,
      syncStatus,
    };
  }
  if (syncStatus === 'missing') {
    return {
      kind: 'missing',
      label: 'AI history missing',
      title: 'The linked source cell is missing. Keep the reviewed SQL as standalone evidence or resolve the source.',
      run,
      syncStatus,
    };
  }
  if (run.status === 'running') {
    return {
      kind: 'run_preview',
      label: 'AI running',
      title: 'AI preview is running.',
      run,
      syncStatus,
    };
  }
  if (run.reviewStatus === 'completed' || run.reviewStatus === 'certified') {
    return {
      kind: 'done',
      label: run.reviewStatus === 'certified' ? 'AI certified' : 'AI done',
      title: 'This AI history item is closed.',
      run,
      syncStatus,
    };
  }
  if (run.status === 'error' || run.reviewChecklist?.blockers.length) {
    return {
      kind: 'blocked',
      label: 'AI blocked',
      title: run.error || run.reviewChecklist?.blockers[0] || 'Resolve this AI history blocker before DQL promotion.',
      run,
      syncStatus,
    };
  }
  if (run.reviewStatus === 'rejected') {
    return {
      kind: 'done',
      label: 'AI rejected',
      title: 'This AI history item was rejected and is closed.',
      run,
      syncStatus,
    };
  }
  const hasReviewedSql = Boolean(run.reviewedSql?.trim());
  const hasGeneratedSql = Boolean(run.generatedSql?.trim());
  const hasEvidence = Boolean(
    run.contextPackId
    || (Array.isArray(run.evidence) && run.evidence.length > 0)
    || (run.evidence && typeof run.evidence === 'object' && Object.keys(run.evidence as Record<string, unknown>).length > 0),
  );
  const hasPreview = Boolean(run.resultPreview?.columns.length || (run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0) > 0);
  if (!hasReviewedSql && hasGeneratedSql) {
    return {
      kind: 'review_sql',
      label: 'AI: Review SQL',
      title: 'Review generated SQL before promoting this work into a reusable saved query.',
      run,
      syncStatus,
    };
  }
  if (!hasReviewedSql && !hasGeneratedSql) {
    return {
      kind: 'review_sql',
      label: 'AI: Add SQL',
      title: 'Add, paste, or generate SQL for this research item.',
      run,
      syncStatus,
    };
  }
  if (!hasEvidence) {
    return {
      kind: 'review_context',
      label: 'AI: Context',
      title: 'Save metadata evidence before DQL draft creation.',
      run,
      syncStatus,
    };
  }
  if (!hasPreview) {
    return {
      kind: 'run_preview',
      label: 'AI: Preview',
      title: 'Run a bounded preview before DQL promotion.',
      run,
      syncStatus,
    };
  }
  if (run.dqlPromotionAction === 'reuse_existing') {
    return {
      kind: 'reuse',
      label: 'AI: Reuse',
      title: 'A similar certified saved query was found. Review whether this should reuse existing logic.',
      run,
      syncStatus,
    };
  }
  if (run.draftBlockPath && run.reviewChecklist?.readyForCertificationReview) {
    return {
      kind: 'cert_ready',
      label: 'AI: Certify',
      title: 'The DQL draft is ready for certification review.',
      run,
      syncStatus,
    };
  }
  if (!run.draftBlockPath && run.reviewChecklist?.readyForDqlDraft) {
    return {
      kind: 'draft_ready',
      label: 'AI: Draft ready',
      title: 'Reviewed SQL and evidence are ready for DQL draft creation.',
      run,
      syncStatus,
    };
  }
  if (run.draftBlockPath) {
    return {
      kind: 'complete',
      label: 'AI: Draft saved',
      title: 'Open the DQL draft and complete metadata, tests, lineage, and certification review.',
      run,
      syncStatus,
    };
  }
  return {
    kind: 'unknown',
    label: 'AI: Review',
    title: 'Continue the AI history review workflow.',
    run,
    syncStatus,
  };
}
