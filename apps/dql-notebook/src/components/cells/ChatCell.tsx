import { themes } from '../../themes/notebook-theme';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { Cell, ChatCellConfig, ThemeMode } from '../../store/types';
import {
  UnifiedAgentRunPanel,
  type ThreadItem,
  type InsertDqlPayload,
  type SqlNotebookDraftMeta,
} from '../agent/UnifiedAgentRunPanel';
import { correctionProvenanceForDraft } from '../../utils/answer-to-notebook';

interface ChatCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

/**
 * Resolve upstream SQL for the chat context: an explicit `@handle` upstream, else
 * the nearest prior SQL/DQL cell's content.
 */
function findUpstreamSql(cells: Cell[], index: number, handle?: string): string | undefined {
  if (handle) {
    const named = cells.find((c) => c.name === handle);
    if (named?.content) return named.content;
  }
  for (let i = index - 1; i >= 0; i--) {
    const c = cells[i];
    if ((c.type === 'sql' || c.type === 'dql') && c.content) return c.content;
  }
  return undefined;
}

/** A collision-free cell name derived from the answer title (or a stable fallback). */
function uniqueSqlCellName(title: string | undefined, cells: Cell[]): string {
  const fallback = 'ai_sql_draft';
  const base = (title || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || fallback;
  const taken = new Set(cells.map((item) => item.name).filter(Boolean));
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Chat cell — runs on the shared governed agent-run panel (`UnifiedAgentRunPanel`),
 * the same experience as Ask, the app copilot, and Block Studio. Generated SQL is
 * inserted as a review-required cell right after this one, and the conversation is
 * persisted into the cell's `chatConfig.thread` so it survives reloads.
 */
export function ChatCell({ cell, cells, index, themeMode, onUpdate }: ChatCellProps) {
  const { dispatch } = useNotebook();
  const t = themes[themeMode];
  const config: ChatCellConfig = { history: [], ...cell.chatConfig };

  const insertGeneratedSqlCell = (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const sqlCell = makeCell('sql', trimmed);
    sqlCell.name = uniqueSqlCellName(title, cells);
    sqlCell.correctionProvenance = correctionProvenanceForDraft({
      question: meta?.question,
      generatedSql: trimmed,
      sourceRunId: meta?.sourceRunId,
    });
    dispatch({ type: 'ADD_CELL', cell: sqlCell, afterId: cell.id });
  };

  // DQL-first insertion (default): a self-contained query cell seeded with the
  // governed answer's compiled SQL + result + chart config, carrying the DQL as
  // provenance for display + save-as-block.
  const insertGeneratedDqlCell = (payload: InsertDqlPayload) => {
    const sql = (payload.sql ?? payload.dqlArtifact?.source ?? '').trim();
    if (!sql) return;
    const dqlSource = payload.dqlArtifact?.source?.trim();
    const sqlCell = makeCell(dqlSource ? 'dql' : 'sql', dqlSource || sql);
    sqlCell.name = uniqueSqlCellName(payload.title ?? payload.dqlArtifact?.name, cells);
    if (payload.result) {
      sqlCell.result = payload.result;
      sqlCell.status = 'success';
      sqlCell.executionCount = 1;
    }
    if (payload.chartConfig) sqlCell.chartConfig = payload.chartConfig;
    sqlCell.correctionProvenance = correctionProvenanceForDraft({
      question: payload.question,
      generatedSql: payload.sql ?? payload.dqlArtifact?.compiledSql,
      generatedDql: dqlSource,
      sourceRunId: payload.sourceRunId,
    });
    if (payload.dqlArtifact) {
      sqlCell.dqlArtifact = {
        source: payload.dqlArtifact.source,
        sql: payload.sql,
        name: payload.dqlArtifact.name,
        sourcePath: payload.dqlArtifact.sourcePath,
        kind: payload.dqlArtifact.kind,
        metrics: payload.dqlArtifact.metrics,
        dimensions: payload.dqlArtifact.dimensions,
        parameters: payload.dqlArtifact.parameters,
        parameterValues: payload.dqlArtifact.parameterValues,
        persistence: payload.dqlArtifact.persistence,
        trustState: payload.dqlArtifact.trustState,
        compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
        ...(payload.question ? { question: payload.question } : {}),
      };
      sqlCell.dqlParameterValues = payload.dqlArtifact.parameterValues;
    }
    dispatch({ type: 'ADD_CELL', cell: sqlCell, afterId: cell.id });
  };

  const upstreamSql = findUpstreamSql(cells, index, config.upstream);

  return (
    <div style={{ height: 'min(560px, 68vh)', display: 'flex', minHeight: 0, background: t.cellBg, borderRadius: 6, overflow: 'hidden' }}>
      <UnifiedAgentRunPanel
        themeMode={themeMode}
        title="Chat"
        scopeHint="Ask a metric, SQL draft, comparison, or dashboard — grounded in your saved queries and semantic layer"
        audience="analyst"
        initialMode="auto"
        workspaceContext={upstreamSql ? { upstreamSql } : undefined}
        initialItems={(config.thread as ThreadItem[] | undefined) ?? undefined}
        onItemsChange={(items) => onUpdate({ chatConfig: { ...config, thread: items } })}
        threadId={config.threadId}
        onThreadIdChange={(id) => onUpdate({ chatConfig: { ...config, threadId: id } })}
        onInsertSql={insertGeneratedSqlCell}
        onInsertDql={insertGeneratedDqlCell}
      />
    </div>
  );
}
