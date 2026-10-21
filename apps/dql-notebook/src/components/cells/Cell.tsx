import type { Theme } from "../../themes/notebook-theme";
import { CommaListInput } from '../common/CommaListInput';
import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useShallow } from 'zustand/react/shallow';
import {
  Check,
  Database,
  MessageSquarePlus,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { makeCell, makeCellId, notebookStoreApi, useDispatch, useNotebookStore } from "../../store/NotebookStore";
import { controlStyle } from '../../themes/control-tokens';
import { themes } from "../../themes/notebook-theme";
import { useQueryExecution } from "../../hooks/useQueryExecution";
import { SQLCellEditor, type SQLCellEditorHandle } from "./SQLCellEditor";
import { MarkdownCellEditor } from "./MarkdownCellEditor";
import { ParamCell } from "./ParamCell";
import { PlaceholderCell } from "./PlaceholderCell";
import { DataframeChip } from "./DataframeChip";
import { ChartCell } from "./ChartCell";
import { FilterCell } from "./FilterCell";
import { SingleValueCell } from "./SingleValueCell";
import { PivotCell } from "./PivotCell";
import { TableCell } from "./TableCell";
import { ChatCell } from "./ChatCell";
import { SnippetPicker } from "./SnippetPicker";
import { teachCorrectionEligibility } from './teach-correction';
import {
  buildTeachCorrectionDraft,
  parseTeachLessonLines,
  teachScopeHasRecallAnchor,
  teachScopeLabels,
  type TeachCorrectionScope,
} from './teach-correction-draft';
import { SaveAsBlockModal } from "../modals/SaveAsBlockModal";
import {
  deriveBlockSource,
  type DerivedBlockSource,
} from "../../utils/derive-block-source";
import { TableOutput } from "../output/TableOutput";
import {
  ChartOutput,
  detectChartType,
  resolveChartType,
  renderChart,
  CHART_TYPE_OPTIONS,
} from "../output/ChartOutput";
import type { ChartType } from "../output/ChartOutput";
import { ErrorOutput } from "../output/ErrorOutput";
import { CellLineage } from "./CellLineage";
import type { Cell, BlockBinding, BlockParameterDefinition } from "../../store/types";
import type { CellResearchState } from "../../utils/notebook-research";
import { format as formatSQL } from "sql-formatter";
import { api, type DatasetSource } from "../../api/client";
import { useHostUi } from "../../host/host-ui";
import { exportQuery } from "../../api/exports";
import { CellChrome } from "@zlens/ui";
import { CombineDataPanel, type CombineDataRequest } from '../notebook/CombineDataPanel';
import { buildCombinedDatasetCell } from '../../utils/dataset-references';
import { BlockParameterControls } from '../parameters/BlockParameterControls';
import { NotebookDqlParameterEditor } from '../parameters/NotebookDqlParameterEditor';
import { canBackgroundRepairNotebookCell, notebookRepairErrorMessage } from '../../utils/notebook-background-repair';
import { DQL_CELL_EXAMPLE, dqlCellHoldsPlainSql, queryCellKindLabel } from '../../utils/dql-cell-content';

interface CellProps {
  cell: Cell;
  index: number;
  onStartResearch?: (cellId: string, prompt?: string) => void;
  researchState?: CellResearchState | null;
}

function GutterWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 2 }}>
      <div style={{ width: 40, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function CellToolbarWrap({
  cell,
  t,
  onRun,
  onMoveUp,
  onMoveDown,
  onDelete,
  children,
}: {
  cell: Cell;
  t: Theme;
  onRun?: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const borderColor = getCellBorderColor(cell, t);
  const typeColor = TYPE_COLORS[cell.type] ?? t.accent;
  const title = cell.name ? (
    <span
      style={{
        color: t.textSecondary,
        fontSize: 12,
        fontFamily: t.fontMono,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
        maxWidth: 200,
      }}
    >
      {cell.name}
    </span>
  ) : undefined;
  const actions = hovered ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {onRun && (
        <HeaderActionBtn title="Run cell (Shift+Enter)" onClick={onRun} t={t} run>
          <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
          </svg>
        </HeaderActionBtn>
      )}
      <HeaderActionBtn title="Move up" onClick={onMoveUp} t={t}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1-1.06 1.06L8.75 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z" />
        </svg>
      </HeaderActionBtn>
      <HeaderActionBtn title="Move down" onClick={onMoveDown} t={t}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.53 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L2.97 9.28a.75.75 0 0 1 1.06-1.06l2.72 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.72-2.97a.75.75 0 0 1 1.06 0Z" />
        </svg>
      </HeaderActionBtn>
      <HeaderActionBtn title="Delete cell" onClick={onDelete} t={t} danger>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
        </svg>
      </HeaderActionBtn>
    </div>
  ) : undefined;
  return (
    <CellChrome
      typeLabel={TYPE_LABELS[cell.type] ?? cell.type.toUpperCase()}
      typeColor={typeColor}
      accent={borderColor}
      idleBorder={t.cellBorder}
      background={t.cellBg}
      headerBackground={`${t.tableHeaderBg}80`}
      active={hovered || cell.status !== 'idle'}
      title={title}
      actions={actions}
      status={<InlineStatus cell={cell} t={t} />}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </CellChrome>
  );
}

const TYPE_LABELS: Record<string, string> = {
  sql: "QUERY",
  markdown: "MD",
  dql: "DQL",
  param: "PARAM",
  chart: "CHART",
  pivot: "PIVOT",
  single_value: "SINGLE VALUE",
  filter: "FILTER",
  table: "TABLE",
  map: "MAP",
  writeback: "WRITEBACK",
  python: "PYTHON",
  chat: "CHAT",
};

// v1.4 cell-type palette — ported from DQL New-UI handoff
// (dql-primitives.jsx). Each key resolves to a per-theme --cell-*
// token declared in packages/dql-ui/src/styles/tokens.css so paper
// and white themes pick up their own tuned ink.
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function makeTypeColors(): Record<string, string> {
  return {
    sql: cssVar('--cell-sql', '#3b8ef0'),
    markdown: cssVar('--cell-md', '#2fb97a'),
    dql: cssVar('--cell-insight', '#ffc857'),
    param: cssVar('--cell-inputs', '#9aa0ae'),
    chart: cssVar('--cell-chart', '#b067f7'),
    pivot: cssVar('--cell-pivot', '#e5a84d'),
    single_value: cssVar('--cell-single', '#b067f7'),
    filter: cssVar('--cell-filter', '#f26a6a'),
    table: cssVar('--cell-table', '#5dd1c8'),
    map: cssVar('--cell-goal', '#61d095'),
    writeback: cssVar('--cell-callout', '#ff7ac6'),
    python: cssVar('--cell-sql', '#3b8ef0'),
    chat: cssVar('--cell-chat', '#8a8f9b'),
  };
}

const TYPE_COLORS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, key: string) {
    return makeTypeColors()[key];
  },
});

interface PlaceholderMeta {
  title: string;
  subtitle: string;
  color: string;
  badge?: string;
}

const PLACEHOLDER_META: Partial<Record<string, PlaceholderMeta>> = {
  map: {
    title: 'Map',
    subtitle: 'Geospatial visualization — lat/lon points and choropleths from an upstream dataframe. Lands in v0.11 on the dql-compiler geo pipeline.',
    color: '#7ce38b',
    badge: 'v0.11',
  },
  writeback: {
    title: 'Writeback',
    subtitle: 'Governed output sink — writes a dataframe back to your warehouse with block tests gating the commit. Lands in v0.11.',
    color: '#d2a8ff',
    badge: 'v0.11',
  },
  python: {
    title: "Python (legacy)",
    subtitle:
      "This legacy cell is preserved for compatibility. Execution stays disabled until a secure kernel, dependency environment, cancellation, resource limits, and dataframe exchange are available.",
    color: "#3572a5",
    badge: "Unavailable",
  },
};

function getCellBorderColor(cell: Cell, t: Theme): string {
  if (cell.blockBinding) {
    return cell.blockBinding.state === 'forked' ? t.warning : t.success;
  }
  switch (cell.status) {
    case 'running':
      return t.cellBorderRunning;
    case 'success':
      return t.success;
    case 'error':
      return t.error;
    default:
      return t.cellBorder;
  }
}

// v1.3.3 Hex handoff — inline status chip that lives in the cell-header row
// (replaces the legacy `[1]` left-gutter badge). Shows a compact dot +
// optional duration. Running uses a subtle pulsing ring.
function InlineStatus({ cell, t }: { cell: Cell; t: Theme }) {
  const { status } = cell;
  if (status === 'idle' && cell.executionCount === undefined) return null;

  let dotColor = t.textMuted;
  let text = '';
  if (status === 'running') {
    dotColor = t.cellBorderRunning;
    text = 'Running…';
  } else if (status === 'error') {
    dotColor = t.error;
    text = 'Error';
  } else if (cell.executionCount !== undefined) {
    dotColor = t.success;
    if (cell.result?.executionTime !== undefined) {
      const ms = cell.result.executionTime;
      text = ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
    } else {
      text = `[${cell.executionCount}]`;
    }
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        fontFamily: t.font,
        color: t.textMuted,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: dotColor,
          boxShadow: status === 'running' ? `0 0 0 3px ${dotColor}33` : undefined,
          animation: status === 'running' ? 'pulse 1.2s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }}
      />
      {text}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
    </span>
  );
}

function ExecutionBadge({ cell, t }: { cell: Cell; t: Theme }) {
  let label = '';
  let color = t.textMuted;
  let timeLabel = '';

  if (cell.status === 'running') {
    label = '[*]';
    color = t.cellBorderRunning;
  } else if (cell.status === 'error') {
    label = '[!]';
    color = t.error;
  } else if (cell.executionCount !== undefined) {
    label = `[${cell.executionCount}]`;
    color = t.textMuted;
    if (cell.result?.executionTime !== undefined) {
      const ms = cell.result.executionTime;
      timeLabel = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    }
  } else {
    label = '[ ]';
    color = t.textMuted;
  }

  return (
    <div
      style={{
        width: 40,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        flexShrink: 0,
        gap: 2,
      }}
    >
      <span
        style={{
          fontFamily: t.fontMono,
          fontSize: 11,
          color,
          lineHeight: 1.4,
          userSelect: 'none',
          transition: 'color 0.2s',
        }}
      >
        {cell.status === 'running' ? (
          <span style={{ display: 'inline-block', animation: 'spin 0.8s linear infinite' }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke={color} strokeWidth="1.5" strokeDasharray="14 7" />
            </svg>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </span>
        ) : label}
      </span>
      {timeLabel && (
        <span style={{ fontFamily: t.fontMono, fontSize: 8, color: t.textMuted, lineHeight: 1, userSelect: 'none' }}>
          {timeLabel}
        </span>
      )}
    </div>
  );
}

interface BlockFields {
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  blockType: string;
}

function parseBlockFields(content: string): BlockFields | null {
  if (!/^\s*block\s+"/i.test(content.trim())) return null;
  const str = (key: string) =>
    content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const tagsMatch = content.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  const tags = tagsMatch
    ? (tagsMatch[1].match(/"([^"]*)"/g) ?? []).map((s: string) => s.slice(1, -1))
    : [];
  return {
    domain: str('domain'),
    owner: str('owner'),
    description: str('description'),
    blockType: str('type') || 'custom',
    tags,
  };
}

function setBlockStringField(content: string, key: string, value: string): string {
  const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  return re.test(content) ? content.replace(re, `$1"${value.replace(/"/g, '\\"')}"`) : content;
}

function setBlockTags(content: string, tags: string[]): string {
  const tagStr = tags.map((t: string) => `"${t}"`).join(', ');
  const re = /(\btags\s*=\s*)\[[^\]]*\]/i;
  return re.test(content) ? content.replace(re, `$1[${tagStr}]`) : content;
}

function BoundBlockParameterControls({
  binding,
  t,
  onChange,
}: {
  binding: BlockBinding;
  t: Theme;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const [parameters, setParameters] = useState<BlockParameterDefinition[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    void api.openBlockStudio(binding.path)
      .then((payload) => {
        if (!cancelled) setParameters(payload.validation.parameters ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setParameters([]);
          setLoadError(true);
        }
      });
    return () => { cancelled = true; };
  }, [binding.path]);

  const current = binding.parameterValues ?? {};
  const parameterNames = new Set(parameters.map((parameter) => parameter.name));
  const staleOverrides = Object.keys(current).filter((name) => !parameterNames.has(name));
  if (parameters.length === 0 && staleOverrides.length === 0 && !loadError) return null;
  return (
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.cellBorder}`, background: t.appBg }}>
      <div style={{ marginBottom: 6, fontSize: 10.5, fontWeight: 750, color: t.textSecondary }}>
        Block inputs <span style={{ fontWeight: 400, color: t.textMuted }}>· defaults come from the block; notebook overrides stay here</span>
      </div>
      {loadError && (
        <div style={{ marginBottom: 6, fontSize: 10.5, color: t.error }}>
          Could not load this block's parameter contract. The saved overrides were not changed.
        </div>
      )}
      {staleOverrides.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, fontSize: 10.5, color: t.warning }}>
          <span>Block definition changed. Unknown overrides: {staleOverrides.join(', ')}.</span>
          <button
            type="button"
            onClick={() => onChange(Object.fromEntries(Object.entries(current).filter(([name]) => parameterNames.has(name))))}
            style={binderBtnStyle(t, t.warning)}
          >
            Remove stale
          </button>
        </div>
      )}
      <BlockParameterControls
        parameters={parameters}
        values={current}
        onChange={(name, value) => onChange({ ...current, [name]: value })}
        onReset={(name) => {
          const next = { ...current };
          delete next[name];
          onChange(next);
        }}
        t={t}
      />
    </div>
  );
}

function InlineDqlParameterControls({
  source,
  values,
  t,
  onChange,
}: {
  source: string;
  values: Record<string, unknown>;
  t: Theme;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const [parameters, setParameters] = useState<BlockParameterDefinition[]>([]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.validateBlockStudio(source)
        .then((validation) => {
          if (cancelled) return;
          setParameters(validation.parameters ?? []);
        })
        .catch(() => { if (!cancelled) setParameters([]); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [source]);

  if (parameters.length === 0) return null;
  return (
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.cellBorder}`, background: t.appBg }}>
      <div style={{ marginBottom: 6, fontSize: 10.5, fontWeight: 750, color: t.textSecondary }}>
        Run with <span style={{ fontWeight: 400, color: t.textMuted }}>· change values for this notebook without changing DQL defaults</span>
      </div>
      <BlockParameterControls
        parameters={parameters}
        values={values}
        onChange={(name, value) => onChange({ ...values, [name]: value })}
        onReset={(name) => {
          const next = { ...values };
          delete next[name];
          onChange(next);
        }}
        t={t}
      />
    </div>
  );
}

function BlockBindingChip({
  binding,
  t,
  onRevert,
  onCustomize,
  onUnbind,
}: {
  binding: BlockBinding;
  t: Theme;
  onRevert: () => void | Promise<void>;
  onCustomize: () => void | Promise<void>;
  onUnbind: () => void;
}) {
  const isForked = binding.state === 'forked';
  const accent = isForked ? t.warning : t.success;
  const label = isForked ? 'FORKED' : 'BOUND';
  const helpText = isForked
    ? 'Local edits have diverged from the block file — Revert to discard, or Save as Block to promote as a new version.'
    : 'This cell mirrors the block file. Edit to fork locally.';
  return (
    <div
      title={helpText}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        borderBottom: `1px solid ${t.cellBorder}`,
        background: `${accent}10`,
        fontFamily: t.fontMono,
        fontSize: 11,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: accent,
          background: `${accent}24`,
          border: `1px solid ${accent}55`,
          borderRadius: 3,
          padding: '1px 5px',
        }}
      >
        {label}
      </span>
      <span style={{ color: t.textSecondary }}>{binding.path}</span>
      {binding.version && <span style={{ color: t.textMuted }}>· v{binding.version}</span>}
      {!isForked && (
        <span title="Bound cells track the block file — edits fork locally" style={{ color: t.textMuted }}>
          🔒
        </span>
      )}
      <div style={{ flex: 1 }} />
      {isForked && (
        <button
          onClick={onRevert}
          title="Discard local edits and restore the block file body"
          style={binderBtnStyle(t, accent)}
        >
          Revert
        </button>
      )}
      {!isForked && (
        <button
          onClick={onCustomize}
          title="Load the block source into this notebook and customize a local copy"
          style={binderBtnStyle(t, accent)}
        >
          Customize copy
        </button>
      )}
      <button
        onClick={onUnbind}
        title="Detach this cell from the block file"
        style={binderBtnStyle(t, t.btnBorder)}
      >
        Unbind
      </button>
    </div>
  );
}

function binderBtnStyle(t: Theme, border: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 4,
    color: t.textSecondary,
    fontSize: 10,
    fontFamily: t.font,
    fontWeight: 600,
    letterSpacing: '0.04em',
    padding: '1px 7px',
    cursor: 'pointer',
  };
}

function BlockGovernanceBar({
  content,
  onChange,
  t,
}: {
  content: string;
  onChange: (next: string) => void;
  t: Theme;
}) {
  const fields = parseBlockFields(content);
  if (!fields) return null;

  // These are editable fields, but they were drawn with `cellBorder` on a tinted
  // row — in the light theme that border is almost invisible, so the row read as
  // static labels and nobody could tell what was clickable.
  const fieldStyle = {
    background: t.cellBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '3px 7px',
    outline: 'none',
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 700,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    marginRight: 4,
    flexShrink: 0,
  };

  const groupStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap' as const,
        gap: '4px 12px',
        padding: '5px 10px',
        borderBottom: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}40`,
      }}
    >
      <div style={groupStyle}>
        <span style={labelStyle}>domain</span>
        <input
          style={{ ...fieldStyle, width: 80 }}
          value={fields.domain}
          placeholder="e.g. finance"
          onChange={e => onChange(setBlockStringField(content, 'domain', e.target.value))}
        />
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>owner</span>
        <input
          style={{ ...fieldStyle, width: 90 }}
          value={fields.owner}
          placeholder="e.g. data-team"
          onChange={e => onChange(setBlockStringField(content, 'owner', e.target.value))}
        />
      </div>
      <div style={groupStyle}>
        <span style={labelStyle}>tags</span>
        <CommaListInput
          style={{ ...fieldStyle, width: 110 }}
          values={fields.tags}
          placeholder="revenue, kpi"
          onChange={(tags) => onChange(setBlockTags(content, tags))}
        />
      </div>
      <div style={{ ...groupStyle, flex: 1 }}>
        <span style={labelStyle}>description</span>
        <input
          style={{ ...fieldStyle, flex: 1, minWidth: 120 }}
          value={fields.description}
          placeholder="What this block measures"
          onChange={e => onChange(setBlockStringField(content, 'description', e.target.value))}
        />
      </div>
    </div>
  );
}

function RunningOutput({
  cellType,
  cellName,
  t,
  onCancel,
}: {
  cellType: string;
  cellName?: string;
  t: Theme;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - started), 250);
    return () => window.clearInterval(id);
  }, []);
  const seconds = elapsed < 1000 ? `${Math.max(1, Math.round(elapsed))}ms` : `${(elapsed / 1000).toFixed(1)}s`;
  const stage = cellType === 'dql'
    ? elapsed < 1200 ? 'Preparing DQL block' : elapsed < 5000 ? 'Executing generated SQL' : 'Waiting for warehouse response'
    : elapsed < 1200 ? 'Preparing SQL' : elapsed < 5000 ? 'Executing query' : 'Waiting for database response';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'grid',
        gap: 10,
        padding: 14,
        minHeight: 92,
        background: `${t.cellBorderRunning}0f`,
        borderTop: `1px solid ${t.cellBorder}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: t.cellBorderRunning,
            boxShadow: `0 0 0 4px ${t.cellBorderRunning}22`,
            animation: 'pulse 1.2s ease-in-out infinite',
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>{stage}</div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3 }}>
            {cellName || cellType.toUpperCase()} · {seconds}
          </div>
        </div>
        <button
          onClick={onCancel}
          style={{
            border: `1px solid ${t.error}`,
            background: `${t.error}12`,
            color: t.error,
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: t.font,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.45 }}>
        The result table will appear here when execution finishes. Errors will replace this status card with details.
      </div>
    </div>
  );
}

// v1.3 Track 5 — cell types that are "developer affordances" and collapse
// to a one-line strip in App mode. Viewer types (markdown, chart, single_value,
// pivot, table, map, filter) render as today. The plan's full per-type chrome
// stripping lands in Track 6 along with CellChrome.
const APP_MODE_HIDDEN_CELL_TYPES = new Set<string>([
  'sql',
  'dql',
  'param',
  'writeback',
  'python',
  'chat',
]);

function CellAiHistoryBadge({
  state,
  t,
  onClick,
}: {
  state: CellResearchState;
  t: Theme;
  onClick: () => void;
}) {
  const accent = researchStateColor(state, t);
  return (
    <button
      type="button"
      title={state.title}
      aria-label={`${state.label}. ${state.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        height: 22,
        maxWidth: 170,
        minWidth: 0,
        border: `1px solid ${accent}55`,
        background: `${accent}12`,
        color: accent,
        borderRadius: 4,
        padding: '0 7px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        fontFamily: t.font,
        fontWeight: 800,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 1,
      }}
    >
      <Sparkles size={11} strokeWidth={2.2} style={{ flexShrink: 0 }} aria-hidden="true" />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{state.label}</span>
    </button>
  );
}

function shouldShowAiHistoryBadge(state: CellResearchState): boolean {
  return state.kind === 'changed' || state.kind === 'missing' || state.kind === 'blocked';
}

function researchStateColor(state: CellResearchState, t: Theme): string {
  switch (state.kind) {
    case 'changed':
    case 'review_sql':
    case 'review_context':
    case 'complete':
      return t.warning;
    case 'missing':
    case 'blocked':
      return t.error;
    case 'reuse':
    case 'cert_ready':
    case 'done':
      return t.success;
    case 'draft_ready':
    case 'run_preview':
      return t.accent;
    case 'new':
    case 'unknown':
    default:
      return t.textMuted;
  }
}

function evidenceJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ExecutionTrustPanel({ cell, t }: { cell: Cell; t: Theme }) {
  const execution = cell.execution;
  if (!execution) return null;

  const statusColor = execution.status === "success"
    ? t.success
    : execution.status === "cancelled" || execution.status === "blocked"
      ? t.warning
      : t.error;
  const dqlSource = cell.dqlArtifact?.source ?? (cell.type === "dql" ? cell.content : undefined);
  const targetLabel = execution.executionTarget?.target === "local"
    ? "Local DuckDB"
    : execution.executionTarget?.connectionName
      ? `Connection: ${execution.executionTarget.connectionName}`
      : "No target recorded";
  const semanticSteps = execution.semanticTrace?.steps ?? [];
  const semanticBindings = execution.semanticTrace?.bindings ?? [];
  const codeBlockStyle: React.CSSProperties = {
    margin: "5px 0 0",
    padding: "7px 8px",
    maxHeight: 190,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 6,
    background: t.editorBg,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: 10.5,
    lineHeight: 1.45,
  };
  const sectionLabelStyle: React.CSSProperties = {
    color: t.textMuted,
    fontSize: 9.5,
    fontWeight: 800,
    letterSpacing: ".045em",
    textTransform: "uppercase",
  };

  return (
    <details
      style={{
        borderTop: `1px solid ${t.cellBorder}`,
        padding: "7px 12px",
        background: `${t.tableHeaderBg}28`,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: t.textSecondary,
          fontSize: 11,
          fontWeight: 750,
        }}
      >
        <ShieldCheck size={12} color={statusColor} />
        Trust &amp; Steps
        <span style={{ color: statusColor, textTransform: "capitalize" }}>{execution.status}</span>
        <span style={{ color: t.textMuted, fontWeight: 500 }}>
          {execution.engine ?? (cell.type === "dql" ? "DQL compiler" : "warehouse SQL")}
          {" · "}{execution.durationMs} ms
        </span>
        <span
          title={execution.runId}
          style={{
            marginLeft: "auto",
            maxWidth: 190,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: t.textMuted,
            fontFamily: t.fontMono,
            fontSize: 9.5,
            fontWeight: 500,
          }}
        >
          {execution.runId}
        </span>
      </summary>

      <div style={{ display: "grid", gap: 10, paddingTop: 9, fontFamily: t.font }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
            gap: 6,
          }}
        >
          {[
            ["Cell", execution.cellId],
            ["Route", execution.route],
            ["Target", targetLabel],
            ["Started", execution.startedAt],
          ].map(([label, value]) => (
            <div key={label} style={{ minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 6, padding: "6px 7px", background: t.cellBg }}>
              <div style={sectionLabelStyle}>{label}</div>
              <div title={value} style={{ marginTop: 2, color: t.textSecondary, fontFamily: label === "Started" ? t.font : t.fontMono, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {dqlSource && (
          <div>
            <div style={sectionLabelStyle}>1 · Governed DQL request</div>
            <pre style={codeBlockStyle}>{dqlSource}</pre>
          </div>
        )}

        {execution.compiledSql && (
          <div>
            <div style={sectionLabelStyle}>{dqlSource ? "2" : "1"} · Compiled SQL</div>
            <pre style={codeBlockStyle}>{execution.compiledSql}</pre>
          </div>
        )}

        {execution.executedSql && execution.executedSql !== execution.compiledSql && (
          <div>
            <div style={sectionLabelStyle}>Executed SQL</div>
            <pre style={codeBlockStyle}>{execution.executedSql}</pre>
          </div>
        )}

        {(semanticSteps.length > 0 || semanticBindings.length > 0) && (
          <div>
            <div style={sectionLabelStyle}>Semantic compiler trace</div>
            {semanticSteps.length > 0 && (
              <ol style={{ margin: "6px 0 0", paddingLeft: 20, color: t.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>
                {semanticSteps.map((step, stepIndex) => (
                  <li key={step.id ?? `${stepIndex}:${step.label ?? "step"}`}>
                    <strong>{step.label ?? step.id ?? `Step ${stepIndex + 1}`}</strong>
                    {step.status ? ` · ${step.status}` : ""}
                    {step.detail ? ` — ${step.detail}` : ""}
                  </li>
                ))}
              </ol>
            )}
            {semanticBindings.length > 0 && <pre style={codeBlockStyle}>{evidenceJson(semanticBindings)}</pre>}
          </div>
        )}

        {(execution.targetBinding || execution.executionReceipt) && (
          <div>
            <div style={sectionLabelStyle}>Target binding &amp; execution receipt</div>
            <pre style={codeBlockStyle}>{evidenceJson({
              targetBinding: execution.targetBinding,
              executionReceipt: execution.executionReceipt,
            })}</pre>
          </div>
        )}

        {execution.repair && (
          <div style={{ border: `1px solid ${t.warning}55`, borderRadius: 6, padding: "7px 8px", background: `${t.warning}0d` }}>
            <div style={{ ...sectionLabelStyle, color: t.warning }}>
              Background repair · {execution.repair.mode}
            </div>
            <div style={{ marginTop: 4, color: t.textSecondary, fontSize: 11, lineHeight: 1.45 }}>
              The original failed run remains below for review. The repair changed only this notebook cell and reran it on the same target.
            </div>
            <pre style={codeBlockStyle}>{evidenceJson({
              sourceRunId: execution.repair.sourceRunId,
              originalError: execution.repair.originalError,
              originalSource: execution.repair.originalSource,
              originalCompiledSql: execution.repair.originalCompiledSql,
              originalExecutedSql: execution.repair.originalExecutedSql,
            })}</pre>
          </div>
        )}

        {execution.error && (
          <div style={{ border: `1px solid ${t.error}55`, borderRadius: 6, padding: "7px 8px", background: `${t.error}0d` }}>
            <div style={{ ...sectionLabelStyle, color: t.error }}>
              Failure · {execution.error.code ?? "EXECUTION_FAILED"}
              {execution.error.phase ? ` · ${execution.error.phase}` : ""}
            </div>
            <div style={{ marginTop: 4, color: t.textPrimary, fontSize: 11, lineHeight: 1.45 }}>{execution.error.message}</div>
            {execution.error.details !== undefined && <pre style={codeBlockStyle}>{evidenceJson(execution.error.details)}</pre>}
          </div>
        )}
      </div>
    </details>
  );
}

function CellComponentInner({ cell, index, onStartResearch, researchState }: CellProps) {
  // With a host, a SQL cell's download is its statement run again for the file (HH-17).
  const hostedExport = useHostUi().host;
  const state = useNotebookStore(useShallow((store) => ({
    activeFile: store.activeFile,
    appMode: store.appMode,
    schemaTables: store.schemaTables,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const cells = notebookStoreApi.getState().cells;
  const t = themes[state.themeMode];
  const { executeCell, executeDependents, cancelCell } = useQueryExecution();

  const [cellHovered, setCellHovered] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(cell.name ?? '');
  const [showOutput, setShowOutput] = useState(true);
  const [viewMode, setViewMode] = useState<"chart" | "table" | "profile">(
    "table",
  );
  const [selectedChartType, setSelectedChartType] = useState<ChartType | null>(
    null,
  );
  const [chartDropdownOpen, setChartDropdownOpen] = useState(false);
  const [chartConfigOpen, setChartConfigOpen] = useState(false);
  const [chartRecommendBusy, setChartRecommendBusy] = useState(false);
  const [chartRecommendNote, setChartRecommendNote] = useState<string | null>(null);
  const [saveAsBlockOpen, setSaveAsBlockOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteKind, setNoteKind] = useState<NonNullable<Cell['annotations']>[number]['kind']>('note');
  const [connectionNames, setConnectionNames] = useState<string[]>([]);
  const [defaultConnection, setDefaultConnection] = useState("default");
  const [staging, setStaging] = useState(false);
  const [combineOpen, setCombineOpen] = useState(Boolean(cell.mixedSourcePlan));
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const liveCellRef = useRef(cell);
  liveCellRef.current = cell;

  useEffect(() => {
    if (cell.type !== "sql" && cell.type !== "dql") return;
    let cancelled = false;
    void api
      .getConnections()
      .then((payload) => {
        if (cancelled) return;
        setConnectionNames(Object.keys(payload.connections ?? {}));
        setDefaultConnection(payload.default || "default");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cell.type]);

  const derivedBlock = useMemo<DerivedBlockSource | null>(
    () => {
      if (!saveAsBlockOpen) return null;
      // A governed-DQL cell saves its DQL source (not the compiled SQL).
      if (cell.dqlArtifact?.source) {
        return {
          content: cell.dqlArtifact.source,
          suggestedName: cell.dqlArtifact.name,
          derivedFromUpstream: true,
        };
      }
      return deriveBlockSource(cell, cells);
    },
    [saveAsBlockOpen, cell, cells]
  );
  const canSaveAsBlock =
    cell.type === 'sql' || cell.type === 'dql' || cell.type === 'chart'
    || cell.type === 'pivot' || cell.type === 'single_value'
    || cell.type === 'filter' || cell.type === 'table';

  const borderColor = getCellBorderColor(cell, t);
  const isExecutable = cell.type !== 'markdown' && cell.type !== 'param';

  // Editor ref for imperative undo/reset
  const editorRef = useRef<SQLCellEditorHandle | null>(null);
  // Track the last-saved content for "Reset to saved" functionality
  const savedContentRef = useRef<string>(cell.content);
  const [isDirty, setIsDirty] = useState(false);

  // Build schema map for SQL autocomplete: { tableName: ['col1', 'col2'] }
  // useMemo ensures stable reference — only changes when schemaTables content changes
  const editorSchema = useMemo(
    () =>
      state.schemaTables.length > 0
        ? Object.fromEntries(
            state.schemaTables.map((tbl) => [tbl.name, tbl.columns.map((c) => c.name)])
          )
        : undefined,
    [state.schemaTables]
  );

  useEffect(() => {
    if (cell.status === 'success' && cell.result) {
      const chartType = resolveChartType(cell.result, cell.chartConfig);
      setSelectedChartType(chartType !== 'table' ? chartType : null);
      setViewMode(chartType !== 'table' ? 'chart' : 'table');
    }
  }, [cell.status, cell.result, cell.chartConfig]);

  const handleRun = useCallback(() => {
    if (isExecutable) {
      setRepairNotice(null);
      setRepairError(null);
      executeCell(cell.id);
    }
  }, [cell.id, executeCell, isExecutable]);

  const handleContentChange = useCallback(
    (content: string) => {
      const updates: Partial<Cell> = { content };
      const binding = cell.blockBinding;
      if (binding?.originalContent !== undefined) {
        const diverged = content.trim() !== binding.originalContent.trim();
        const nextState = diverged ? 'forked' : 'bound';
        if (nextState !== binding.state) {
          updates.blockBinding = { ...binding, state: nextState };
        }
      }
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates });
      setIsDirty(content !== savedContentRef.current);
      setRepairNotice(null);
      setRepairError(null);
    },
    [cell.id, cell.blockBinding, dispatch]
  );

  const handleReset = useCallback(() => {
    const original = savedContentRef.current;
    dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { content: original } });
    editorRef.current?.resetTo(original);
    setIsDirty(false);
  }, [cell.id, dispatch]);

  const handleFormat = useCallback(() => {
    if (!cell.content.trim()) return;
    try {
      const formatted = formatSQL(cell.content, {
        language: 'sql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 1,
      });
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { content: formatted } });
    } catch {
      // If formatter fails (e.g. invalid SQL), leave as-is
    }
  }, [cell.content, cell.id, dispatch]);

  const handleFixAndRun = useCallback(() => {
    handleFormat();
    setTimeout(() => executeCell(cell.id), 80);
  }, [handleFormat, executeCell, cell.id]);

  const handleBackgroundRepair = useCallback(async () => {
    if (!canBackgroundRepairNotebookCell(cell) || !cell.error || repairing) return;
    const originalSource = cell.content;
    const originalExecution = cell.execution;
    const originalError = cell.error;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const runId = `cellrepair_${cell.id}_${startedMs}`;
    setRepairing(true);
    setRepairError(null);
    setRepairNotice(null);
    try {
      const repaired = await api.repairNotebookCellExecution(cell, cell.error, {
        notebookPath: state.activeFile?.path,
        cellId: cell.id,
        cellName: cell.name,
        source: cell.type === 'dql' ? 'notebook_dql_cell' : 'notebook_sql_cell',
        runId,
      });
      const liveCell = liveCellRef.current;
      if (
        liveCell.content !== originalSource
        || liveCell.error !== originalError
        || liveCell.execution?.runId !== originalExecution?.runId
      ) {
        throw new Error('The cell changed while repair was running. Its stale repair was not applied.');
      }
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      const result = {
        ...repaired.result,
        executionTime: repaired.result.executionTime ?? durationMs,
        rowCount: repaired.result.rowCount ?? repaired.result.rows.length,
      };
      const blockBinding = cell.blockBinding
        ? { ...cell.blockBinding, state: 'forked' as const }
        : undefined;
      const dqlArtifact = cell.type === 'dql' && cell.dqlArtifact
        ? {
            ...cell.dqlArtifact,
            source: repaired.source,
            sql: repaired.repairedSql,
            compiledSql: repaired.compiledSql ?? repaired.repairedSql,
            trustState: 'review_required' as const,
            reviewState: 'review_required' as const,
          }
        : cell.dqlArtifact;
      dispatch({
        type: 'UPDATE_CELL',
        id: cell.id,
        updates: {
          content: repaired.source,
          status: 'success',
          result,
          error: undefined,
          executionCount: (cell.executionCount ?? 0) + 1,
          executionTarget: repaired.executionTarget ?? cell.executionTarget,
          stale: false,
          fromSnapshot: false,
          ...(blockBinding ? { blockBinding } : {}),
          ...(dqlArtifact ? { dqlArtifact } : {}),
          execution: {
            version: 1,
            runId,
            cellId: cell.id,
            route: cell.type === 'dql' ? 'notebook_dql_cell' : 'notebook_sql_cell',
            status: 'success',
            startedAt,
            completedAt,
            durationMs,
            executionTarget: repaired.executionTarget ?? cell.executionTarget,
            compiledSql: repaired.compiledSql ?? repaired.repairedSql,
            executedSql: repaired.executedSql ?? repaired.repairedSql,
            executionReceipt: repaired.executionReceipt,
            repair: {
              mode: repaired.repairMode,
              sourceRunId: originalExecution?.runId,
              originalSource,
              originalCompiledSql: originalExecution?.compiledSql,
              originalExecutedSql: originalExecution?.executedSql,
              originalError: originalExecution?.error ?? {
                message: originalError,
                phase: 'execution',
              },
            },
          },
        },
      });
      dispatch({
        type: 'APPEND_QUERY_LOG',
        entry: {
          id: makeCellId(),
          cellName: cell.name ?? cell.id,
          rows: result.rowCount,
          time: result.executionTime,
          ts: new Date(),
        },
      });
      setIsDirty(true);
      setRepairNotice(repaired.source === originalSource
        ? 'Retried successfully.'
        : `Fixed and reran. Review the changed ${cell.type === 'dql' ? 'DQL' : 'SQL'} before saving.`);
    } catch (error) {
      setRepairError(notebookRepairErrorMessage(error));
    } finally {
      setRepairing(false);
    }
  }, [cell, dispatch, repairing, state.activeFile?.path]);

  const onCellUpdate = useCallback(
    (updates: Partial<Cell>) => dispatch({ type: 'UPDATE_CELL', id: cell.id, updates }),
    [dispatch, cell.id]
  );

  const addExploreCell = useCallback((type: 'filter' | 'pivot' | 'chart' | 'single_value') => {
    let upstream = cell.name?.trim();
    if (!upstream) {
      const base = `result_${index + 1}`;
      upstream = base;
      let suffix = 2;
      while (notebookStoreApi.getState().cells.some((candidate) => candidate.id !== cell.id && candidate.name === upstream)) {
        upstream = `${base}_${suffix}`;
        suffix += 1;
      }
      dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { name: upstream } });
    }

    const next = makeCell(type);
    next.upstream = upstream;
    next.dependencies = [{ cellId: cell.id, output: upstream }];
    const stepName = type === 'single_value' ? 'kpi' : type;
    const stepBase = `${upstream}_${stepName}`;
    let nextName = stepBase;
    let nextSuffix = 2;
    while (notebookStoreApi.getState().cells.some((candidate) => candidate.name === nextName)) {
      nextName = `${stepBase}_${nextSuffix}`;
      nextSuffix += 1;
    }
    next.name = nextName;
    if (type === 'filter' && next.filterConfig) {
      next.filterConfig = { ...next.filterConfig, upstream };
    }
    if (type === 'pivot' && next.pivotConfig) {
      next.pivotConfig = { ...next.pivotConfig, upstream };
    }
    if (type === 'single_value' && next.singleValueConfig) {
      next.singleValueConfig = { ...next.singleValueConfig, upstream };
    }
    dispatch({ type: 'ADD_CELL', cell: next, afterId: cell.id });
  }, [cell.id, cell.name, dispatch, index]);

  const handleRecommendChart = useCallback(async () => {
    if (!cell.result) return;
    setChartRecommendBusy(true);
    setChartRecommendNote(null);
    const response = await api.recommendVisualization({
      resultSchema: { columns: cell.result.columns },
      rowSample: cell.result.rows.slice(0, 5) as Array<Record<string, unknown>>,
      prompt: [cell.name, cell.content].filter(Boolean).join(' ').slice(0, 600),
    });
    setChartRecommendBusy(false);
    if (!response.ok) {
      setChartRecommendNote(response.error);
      return;
    }
    const chart = normalizeNotebookChartType(response.display.defaultVisualization);
    const hints = response.display.fieldHints ?? {};
    setSelectedChartType(chart !== 'table' ? chart : null);
    setViewMode(chart !== 'table' ? 'chart' : 'table');
    onCellUpdate({
      chartConfig: {
        ...cell.chartConfig,
        chart,
        x: hints.x ?? hints.label ?? cell.chartConfig?.x,
        y: hints.y ?? hints.value ?? cell.chartConfig?.y,
        color: hints.color ?? cell.chartConfig?.color,
      },
    });
    setChartRecommendNote(`${response.display.component} · ${response.display.defaultVisualization}`);
  }, [cell.chartConfig, cell.content, cell.name, cell.result, onCellUpdate]);

  const handleStageLocally = useCallback(async () => {
    if (!cell.content.trim() || staging) return;
    const previewRows = cell.result?.rowCount ?? cell.result?.rows.length ?? 0;
    const confirmed = window.confirm(
      `Copy a bounded warehouse result into the local analysis workspace?\n\nCurrent result: ${previewRows.toLocaleString()} rows\nLimits: 100,000 rows, 250 MB, 120 seconds\n\nThe staged snapshot is ignored by Git, records lineage, and expires after 7 days.`,
    );
    if (!confirmed) return;
    setStaging(true);
    try {
      const response = await api.stageDataset({
        sql: cell.content,
        connectionName:
          cell.executionTarget?.connectionName ?? defaultConnection,
        name: `${cell.name ?? "warehouse_result"} snapshot`,
        confirmed: true,
        blockPath: cell.blockBinding?.path ?? cell.dqlArtifact?.sourcePath,
      });
      const dataset = response.dataset;
      const next = makeLocalDatasetQueryCell(dataset);
      dispatch({ type: "ADD_CELL", cell: next, afterId: cell.id });
      dispatch({
        type: "SET_SCHEMA",
        tables: [
          ...state.schemaTables.filter((table) => table.name !== dataset.alias),
          {
            name: dataset.alias,
            path: dataset.sourcePath,
            source: "file",
            objectType: "staged_dataset",
            columns: dataset.profile.columns.map((column) => ({
              name: column.name,
              type: column.type,
            })),
          },
        ],
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setStaging(false);
    }
  }, [cell, defaultConnection, dispatch, staging, state.schemaTables]);

  const handleCombineLocally = useCallback(async (request: CombineDataRequest) => {
    if (!cell.content.trim() || staging) return;
    setStaging(true);
    try {
      const response = await api.stageDataset({
        sql: cell.content,
        connectionName: cell.executionTarget?.connectionName ?? defaultConnection,
        name: `${cell.name ?? 'warehouse_result'} snapshot`,
        confirmed: true,
        blockPath: cell.blockBinding?.path ?? cell.dqlArtifact?.sourcePath,
      });
      const staged = response.dataset;
      const next = buildCombinedDatasetCell({
        staged: { ...staged, columns: staged.profile.columns.map((column) => column.name) },
        local: { ...request.dataset, columns: request.dataset.profile.columns.map((column) => column.name) },
        warehouseKey: request.warehouseKey,
        localKey: request.localKey,
        joinType: request.joinType,
        sourceCell: cell,
      });
      dispatch({ type: 'ADD_CELL', cell: next, afterId: cell.id });
      dispatch({
        type: 'SET_SCHEMA',
        tables: [
          ...state.schemaTables.filter((table) => table.name !== staged.alias),
          {
            name: staged.alias,
            path: staged.sourcePath,
            source: 'file',
            objectType: 'staged_dataset',
            datasetId: staged.id,
            fileFingerprint: staged.fileFingerprint,
            storageMode: staged.storageMode,
            refreshedAt: staged.refreshedAt,
            trustState: staged.trustState,
            columns: staged.profile.columns.map((column) => ({ name: column.name, type: column.type })),
          },
        ],
      });
      setCombineOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setStaging(false);
    }
  }, [cell, defaultConnection, dispatch, staging, state.schemaTables]);

  const handleDelete = () => {
    dispatch({ type: 'DELETE_CELL', id: cell.id });
  };

  const handleMoveUp = () => {
    dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'up' });
  };

  const handleMoveDown = () => {
    dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'down' });
  };

  const toolbarProps = {
    cell,
    t,
    onMoveUp: handleMoveUp,
    onMoveDown: handleMoveDown,
    onDelete: handleDelete,
  };

  // v1.3 Track 5 — hidden-in-App-view strip. Placed after all hooks to honor
  // Rules of Hooks; flipping appMode must not change the hook count.
  // v1.3.3: Reader mode reuses the App hide-list (same stakeholder visibility).
  if (state.appMode !== 'studio' && APP_MODE_HIDDEN_CELL_TYPES.has(cell.type)) {
    return (
      <div
        style={{
          marginTop: 8,
          marginBottom: 8,
          padding: '6px 10px',
          borderRadius: 6,
          border: `1px dashed ${t.cellBorder}`,
          background: t.cellBg,
          color: t.textMuted,
          fontSize: 11,
          fontFamily: t.font,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ opacity: 0.7 }}>◎</span>
        <span>
          {cell.type.toUpperCase()} cell hidden in App view
          {cell.name ? ` · ${cell.name}` : ''}
        </span>
      </div>
    );
  }

  if (cell.type === 'param') {
    return (
      <CellToolbarWrap {...toolbarProps} onRun={() => executeDependents(cell.id)}>
        <ParamCell cell={cell} themeMode={state.themeMode} onApplyParam={executeDependents} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'pivot') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <PivotCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'single_value') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <SingleValueCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'filter') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <FilterCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'chart') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <ChartCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'table') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <TableCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }
  if (cell.type === 'chat') {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <ChatCell cell={cell} cells={cells} index={index} themeMode={state.themeMode} onUpdate={onCellUpdate} />
      </CellToolbarWrap>
    );
  }

  const placeholder = PLACEHOLDER_META[cell.type];
  if (placeholder) {
    return (
      <CellToolbarWrap {...toolbarProps}>
        <PlaceholderCell
          cell={cell}
          themeMode={state.themeMode}
          title={placeholder.title}
          subtitle={placeholder.subtitle}
          color={placeholder.color}
          badge={placeholder.badge}
        />
      </CellToolbarWrap>
    );
  }

  const commitName = () => {
    setNameEditing(false);
    dispatch({
      type: 'UPDATE_CELL',
      id: cell.id,
      updates: { name: nameDraft.trim() || undefined },
    });
  };

  const hasOutput = (cell.result || cell.error || cell.status === 'running') && cell.type !== 'markdown';
  // canChart: explicit chartConfig overrides heuristic detection
  const canChart = cell.result
    ? resolveChartType(cell.result, cell.chartConfig) !== 'table'
    : false;

  return (
    <div
      onMouseEnter={() => setCellHovered(true)}
      onMouseLeave={() => setCellHovered(false)}
      style={{
        display: 'flex',
        gap: 0,
        marginBottom: 2,
      }}
    >
      {saveAsBlockOpen && derivedBlock && (
        <SaveAsBlockModal
          cell={cell}
          initialContent={derivedBlock.derivedFromUpstream ? derivedBlock.content : undefined}
          initialName={derivedBlock.suggestedName}
          initialDescription={derivedBlock.suggestedDescription}
          onClose={() => setSaveAsBlockOpen(false)}
          onSaved={({ path, name }) => {
            dispatch({
              type: 'FILE_ADDED',
              file: {
                name,
                path,
                type: 'block',
                folder: 'blocks',
              },
            });
          }}
        />
      )}
      {/* v1.3.3 Hex handoff — left gutter removed; status moved inline
          into the cell header via <InlineStatus />. */}

      {/* Cell body */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: 8,
          border: `1px solid ${cellHovered || cell.status !== 'idle' ? borderColor : t.cellBorder}`,
          background: t.cellBg,
          boxShadow: cell.status !== 'idle'
            ? `0 0 0 3px ${borderColor}14, 0 1px 2px rgba(0,0,0,0.04)`
            : '0 1px 2px rgba(0,0,0,0.02)',
          overflow: 'hidden',
          transition: 'border-color 0.2s',
        }}
      >
        {/* Cell header */}
        <div
          style={{
            minHeight: 38,
            display: 'flex',
            alignItems: 'center',
            padding: '7px 12px',
            gap: 8,
            rowGap: 6,
            background: 'transparent',
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              flex: '1 1 260px',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: TYPE_COLORS[cell.type] ?? t.accent,
                flexShrink: 0,
              }}
            />
            <span
              title={cell.type === 'dql' ? 'DQL cell — write a governed block (type, owner, description, tests) or an @block("…") reference' : cell.type === 'sql' ? 'SQL cell — write raw SQL, use @metric()/@dim() refs, reference other cells with {{name}}' : undefined}
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0,
                color: t.textSecondary,
                flexShrink: 0,
                whiteSpace: 'nowrap' as const,
              }}
            >
              {TYPE_LABELS[cell.type]}
            </span>

            {nameEditing ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') setNameEditing(false);
                }}
                style={{
                  background: t.appBg,
                  border: `1px solid ${t.cellBorderActive}`,
                  borderRadius: 5,
                  color: t.textSecondary,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  padding: '2px 6px',
                  outline: 'none',
                  width: 170,
                  minWidth: 100,
                }}
              />
            ) : cell.name ? (
              <span
                onClick={() => {
                  setNameDraft(cell.name ?? '');
                  setNameEditing(true);
                }}
                title="Click to rename"
                style={{
                  color: t.textSecondary,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  cursor: 'text',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  maxWidth: 260,
                  minWidth: 0,
                }}
              >
                {cell.name}
              </span>
            ) : null}

            <InlineStatus cell={cell} t={t} />

            {(cell.type === 'sql' || cell.type === 'dql') && (
              <DataframeChip
                cells={cells}
                index={index}
                content={cell.content}
                themeMode={state.themeMode}
                onInsertHandle={(name) => {
                  const token = `{{${name}}}`;
                  const current = cell.content ?? '';
                  if (current.includes(token)) return;
                  const next = current.trim().length === 0
                    ? `SELECT * FROM ${token}`
                    : `${current.replace(/\s*$/, '')} ${token}`;
                  handleContentChange(next);
                }}
              />
            )}

            {researchState &&
              shouldShowAiHistoryBadge(researchState) &&
              onStartResearch && (
                <CellAiHistoryBadge
                  state={researchState}
                  t={t}
                  onClick={() => onStartResearch(cell.id)}
                />
              )}
            {cell.stale && (
              <span
                title="An upstream cell changed. Run this cell again."
                style={{ color: t.warning, fontSize: 10, fontWeight: 700 }}
              >
                stale
              </span>
            )}
          </div>

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 5,
              flex: '0 0 auto',
              marginLeft: 'auto',
            }}
          >
            {cellHovered && (cell.type === 'sql' || cell.type === 'dql') && (
              <SnippetPicker
                themeMode={state.themeMode}
                cellType={cell.type}
                onInsert={(code) => handleContentChange(code)}
              />
            )}

            {cellHovered && (cell.type === 'sql' || cell.type === 'dql') && (
              <button
                type="button"
                title="Format SQL (clean up whitespace and keywords)"
                onClick={handleFormat}
                style={cellHeaderTextButtonStyle(t)}
              >
                Format
              </button>
            )}

            {isDirty && (cell.type === 'sql' || cell.type === 'dql') && (
              <button
                type="button"
                title="Reset to last saved version (discard changes)"
                onClick={handleReset}
                style={cellHeaderTextButtonStyle(t, 'danger')}
              >
                Reset
              </button>
            )}

            {cellHovered && onStartResearch && (cell.type === 'sql' || cell.type === 'dql') && (
              <button
                type="button"
                title="Ask AI to explain, fix, find reuse, or prepare DQL from this cell"
                onClick={() => onStartResearch(cell.id)}
                style={cellHeaderTextButtonStyle(t, 'accent')}
              >
                Ask AI
              </button>
            )}

            {cellHovered && canSaveAsBlock && (
              <button
                type="button"
                title="Save this cell as a reusable block"
                onClick={() => setSaveAsBlockOpen(true)}
                style={cellHeaderTextButtonStyle(t)}
              >
                Save Block
              </button>
            )}

            {(cellHovered ||
              notesOpen ||
              (cell.annotations?.length ?? 0) > 0) && (
              <button
                type="button"
                title="Add or review a cell note"
                onClick={() => setNotesOpen((open) => !open)}
                style={cellHeaderTextButtonStyle(
                  t,
                  notesOpen ? "accent" : undefined,
                )}
              >
                <MessageSquarePlus size={11} aria-hidden="true" />
                Note
                {cell.annotations?.length ? ` ${cell.annotations.length}` : ""}
              </button>
            )}

            {cellHovered && !cell.name && !nameEditing && (
              <HeaderActionBtn
                title="Name this cell"
                onClick={() => {
                  setNameDraft('');
                  setNameEditing(true);
                }}
                t={t}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
                </svg>
              </HeaderActionBtn>
            )}

            {cellHovered && isExecutable && cell.status === 'running' ? (
              <HeaderActionBtn title="Cancel execution" onClick={() => cancelCell(cell.id)} t={t} danger>
                <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                  <rect x="2" y="2" width="6" height="6" rx="1" />
                </svg>
              </HeaderActionBtn>
            ) : cellHovered && isExecutable ? (
              <HeaderActionBtn title="Run cell (Shift+Enter)" onClick={handleRun} t={t} run>
                <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                  <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
                </svg>
              </HeaderActionBtn>
            ) : null}

            {cellHovered && (
              <>
                <HeaderActionBtn title="Move up" onClick={handleMoveUp} t={t}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1-1.06 1.06L8.75 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z" />
                  </svg>
                </HeaderActionBtn>
                <HeaderActionBtn title="Move down" onClick={handleMoveDown} t={t}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12.53 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L2.97 9.28a.75.75 0 0 1 1.06-1.06l2.72 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.72-2.97a.75.75 0 0 1 1.06 0Z" />
                  </svg>
                </HeaderActionBtn>
                <HeaderActionBtn title="Delete cell" onClick={handleDelete} t={t} danger>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
                  </svg>
                </HeaderActionBtn>
              </>
            )}
          </div>
        </div>

        {(cell.type === "sql" || cell.type === "dql") && (
          <QueryTargetBar
            cell={cell}
            connectionNames={connectionNames}
            defaultConnection={defaultConnection}
            t={t}
            onChange={(executionTarget) => onCellUpdate({ executionTarget })}
          />
        )}

        {cell.type === 'dql' && !cell.blockBinding && (
          <DqlCellGuide
            content={cell.content}
            t={t}
            onInsertExample={() => {
              handleContentChange(DQL_CELL_EXAMPLE);
              editorRef.current?.resetTo(DQL_CELL_EXAMPLE);
            }}
            onSwitchToSql={() => dispatch({
              type: 'UPDATE_CELL',
              id: cell.id,
              updates: { type: 'sql', status: 'idle', error: undefined, result: undefined, execution: undefined },
            })}
          />
        )}

        {/* Governance bar — shown for DQL cells that contain a block declaration */}
        {cell.type === 'dql' && (
          <BlockGovernanceBar
            content={cell.content}
            onChange={handleContentChange}
            t={t}
          />
        )}

        {cell.blockBinding && (
          <BlockBindingChip
            binding={cell.blockBinding}
            t={t}
            onRevert={async () => {
              const binding = cell.blockBinding;
              if (!binding) return;
              try {
                const payload = await api.openBlockStudio(binding.path);
                const blockReference = `@block(${JSON.stringify(payload.metadata.name)})`;
                dispatch({
                  type: 'UPDATE_CELL',
                  id: cell.id,
                  updates: {
                    content: blockReference,
                    blockBinding: { ...binding, state: 'bound', originalContent: blockReference },
                  },
                });
                editorRef.current?.resetTo(blockReference);
              } catch (error) {
                console.error('Failed to revert bound cell', error);
              }
            }}
            onCustomize={async () => {
              const binding = cell.blockBinding;
              if (!binding) return;
              try {
                const payload = await api.openBlockStudio(binding.path);
                dispatch({
                  type: 'UPDATE_CELL',
                  id: cell.id,
                  updates: {
                    content: payload.source,
                    dqlParameterValues: { ...(binding.parameterValues ?? {}) },
                    blockBinding: { ...binding, state: 'forked' },
                  },
                });
                editorRef.current?.resetTo(payload.source);
                setIsDirty(true);
              } catch (error) {
                console.error('Failed to customize bound cell', error);
              }
            }}
            onUnbind={() => {
              dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { blockBinding: undefined } });
            }}
          />
        )}

        {cell.type === 'dql' && (!cell.blockBinding || cell.blockBinding.state === 'forked') && (
          <>
            <NotebookDqlParameterEditor source={cell.content} onSourceChange={handleContentChange} t={t} />
            <InlineDqlParameterControls
              source={cell.content}
              values={cell.dqlParameterValues ?? {}}
              t={t}
              onChange={(dqlParameterValues) => dispatch({
                type: 'UPDATE_CELL',
                id: cell.id,
                updates: { dqlParameterValues },
              })}
            />
          </>
        )}

        {cell.blockBinding?.state === 'bound' && (
          <BoundBlockParameterControls
            binding={cell.blockBinding}
            t={t}
            onChange={(parameterValues) => dispatch({
              type: 'UPDATE_CELL',
              id: cell.id,
              updates: { blockBinding: { ...cell.blockBinding!, parameterValues } },
            })}
          />
        )}

        {/* Editor area */}
        {cell.type === 'markdown' ? (
          <MarkdownCellEditor
            value={cell.content}
            onChange={handleContentChange}
            themeMode={state.themeMode}
          />
        ) : (
          <SQLCellEditor
            value={cell.content}
            onChange={handleContentChange}
            onRun={handleRun}
            themeMode={state.themeMode}
            schema={editorSchema}
            errorMessage={cell.status === 'error' ? cell.error : undefined}
            editorRef={editorRef}
          />
        )}

        {/* Governed DQL provenance: AI/Explore-generated query cells carry the DQL
            they were built from. Shown as the primary artifact (DQL-first), with a
            one-click save to a reusable block when not already backed by one. */}
        {cell.dqlArtifact && (cell.type === 'sql' || cell.type === 'dql') && (
          <details style={{ borderTop: `1px solid ${t.cellBorder}`, padding: '6px 12px', background: `${t.tableHeaderBg}40` }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: t.textSecondary }}>
              <ShieldCheck size={12} color={t.accent} />
              Governed DQL
              {cell.dqlArtifact.sourcePath ? (
                <span style={{ fontWeight: 400, color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cell.dqlArtifact.sourcePath}</span>
              ) : (
                <button
                  type="button"
                  title="Save this governed DQL as a reusable block"
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); setSaveAsBlockOpen(true); }}
                  style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: t.accent, fontFamily: t.font, fontSize: 10.5, fontWeight: 700, padding: '1px 4px' }}
                >
                  Save as DQL block
                </button>
              )}
            </summary>
            <pre style={{ margin: '6px 0 0', fontFamily: t.fontMono, fontSize: 11, whiteSpace: 'pre-wrap', color: t.textSecondary, maxHeight: 200, overflow: 'auto' }}>{cell.dqlArtifact.source}</pre>
          </details>
        )}

        {(cell.type === 'sql' || cell.type === 'dql') && (
          cell.correctionProvenance && !(
            cell.dqlArtifact?.sourcePath
            || cell.dqlArtifact?.persistence === 'saved'
            || cell.dqlArtifact?.trustState === 'certified'
            || cell.dqlArtifact?.reviewState === 'certified'
          ) ? (
            teachCorrectionEligibility(cell).reason === 'ready' ? (
              <TeachCorrectionBar cell={cell} t={t} />
            ) : (
              <div
                data-teach-state={teachCorrectionEligibility(cell).reason}
                style={{ borderTop: `1px solid ${t.cellBorder}`, padding: '5px 12px', background: `${t.accent}0A`, color: t.textMuted, font: `500 10.5px ${t.font}` }}
              >
                <strong style={{ color: t.textSecondary }}>AI draft.</strong>{' '}
                {teachCorrectionEligibility(cell).reason === 'missing_generated_sql'
                  ? <>Original SQL evidence is missing. Reopen this draft from Ask or Notebook AI before teaching it.</>
                  : teachCorrectionEligibility(cell).reason === 'run_required' || teachCorrectionEligibility(cell).reason === 'execution_mismatch'
                    ? <>Draft changed. Run this exact cell successfully to unlock <strong style={{ color: t.accent }}>Teach ZLens</strong>.</>
                    : <>Edit this cell and run it successfully; then <strong style={{ color: t.accent }}>Teach ZLens</strong> appears below the editor. Teaching creates a review candidate and never certifies automatically.</>}
              </div>
            )
          ) : cell.dqlArtifact && (
            cell.dqlArtifact.sourcePath
            || cell.dqlArtifact.persistence === 'saved'
            || cell.dqlArtifact.trustState === 'certified'
            || cell.dqlArtifact.reviewState === 'certified'
          ) ? (
            <div style={{ borderTop: `1px solid ${t.cellBorder}`, padding: '5px 12px', background: `${t.warning}0A`, color: t.textMuted, font: `500 10.5px ${t.font}` }}>
              <strong style={{ color: t.textSecondary }}>Saved governed DQL.</strong>{' '}
              Notebook edits are a draft for block review and recertification; they do not create Teach ZLens learning or overwrite the source automatically.
            </div>
          ) : null
        )}

        <ExecutionTrustPanel cell={cell} t={t} />

        {notesOpen && (
          <CellNotes
            cell={cell}
            value={noteDraft}
            kind={noteKind}
            onValueChange={setNoteDraft}
            onKindChange={setNoteKind}
            onAdd={() => {
              const body = noteDraft.trim();
              if (!body) return;
              onCellUpdate({
                annotations: [
                  ...(cell.annotations ?? []),
                  {
                    id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    body,
                    kind: noteKind,
                    createdAt: new Date().toISOString(),
                  },
                ],
              });
              setNoteDraft("");
            }}
            onRemove={(id) =>
              onCellUpdate({
                annotations: (cell.annotations ?? []).filter(
                  (note) => note.id !== id,
                ),
              })
            }
            t={t}
          />
        )}

        {/* Output area */}
        {hasOutput && (
          <div
            style={{
              borderTop: `1px solid ${t.cellBorder}`,
            }}
          >
            {/* Output meta bar */}
            <div
              style={{
                height: 28,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                gap: 10,
                borderBottom: cell.result && showOutput ? `1px solid ${t.cellBorder}` : 'none',
                background: `${t.tableHeaderBg}60`,
              }}
            >
              {cell.result && (
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: t.font,
                    color: t.textMuted,
                  }}
                >
                  {(() => {
                    const count = cell.result.rowCount ?? cell.result.rows.length;
                    return `${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`;
                  })()}
                  {cell.result.executionTime !== undefined && (
                    <> · {cell.result.executionTime < 1000
                      ? `${Number(cell.result.executionTime.toFixed(1))}ms`
                      : `${(cell.result.executionTime / 1000).toFixed(2)}s`}
                    </>
                  )}
                </span>
              )}
              {cell.fromSnapshot && cell.result && (
                <span
                  title="Result loaded from the last saved run; re-run to refresh."
                  style={{
                    fontSize: 10,
                    fontFamily: t.font,
                    color: t.textMuted,
                    border: `1px solid ${t.btnBorder}`,
                    borderRadius: 3,
                    padding: '0 6px',
                    lineHeight: '16px',
                  }}
                >
                  cached
                </span>
              )}
              {cell.error && (
                <span style={{ fontSize: 11, fontFamily: t.font, color: t.error }}>
                  Error
                </span>
              )}
              {cell.result &&
                cell.type === "sql" &&
                cell.executionTarget?.target !== "local" && (
                  <>
                    <button
                      type="button"
                      disabled={staging}
                      onClick={() => setCombineOpen((open) => !open)}
                      title="Combine this warehouse result with an imported local dataset"
                      style={{
                        border: `1px solid ${combineOpen ? t.accent : t.btnBorder}`,
                        background: combineOpen ? `${t.accent}18` : t.btnBg,
                        color: combineOpen ? t.accent : t.textSecondary,
                        borderRadius: 4,
                        padding: "2px 7px",
                        font: `800 10px ${t.font}`,
                        cursor: staging ? "wait" : "pointer",
                      }}
                    >
                      {cell.mixedSourcePlan ? "Finish CSV join" : "Combine with local data"}
                    </button>
                    <button
                      type="button"
                      disabled={staging}
                      onClick={() => void handleStageLocally()}
                      title="Copy this bounded warehouse result into the local analysis workspace"
                      style={{
                        border: `1px solid ${t.btnBorder}`,
                        background: t.btnBg,
                        color: t.textSecondary,
                        borderRadius: 4,
                        padding: "2px 7px",
                        font: `700 10px ${t.font}`,
                        cursor: staging ? "wait" : "pointer",
                      }}
                    >
                      {staging ? "Staging…" : "Stage only"}
                    </button>
                  </>
                )}
              {cell.result && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} aria-label="Explore this result">
                  <span style={{ font: `700 9px ${t.font}`, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    Explore
                  </span>
                  <ExploreStepButton label="Filter" t={t} onClick={() => addExploreCell('filter')} />
                  <ExploreStepButton label="Pivot" t={t} onClick={() => addExploreCell('pivot')} />
                  <ExploreStepButton label="Chart" t={t} onClick={() => addExploreCell('chart')} />
                  <ExploreStepButton label="KPI" t={t} onClick={() => addExploreCell('single_value')} />
                </div>
              )}
              <div style={{ flex: 1 }} />

              {/* Chart type selector + Table toggle */}
              {cell.result && showOutput && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, position: 'relative' }}>
                  {/* Table button */}
                  <button
                    onClick={() => { setViewMode('table'); setChartDropdownOpen(false); }}
                    style={{
                      padding: '1px 7px', fontSize: 10, fontFamily: t.font, borderRadius: 3,
                      border: `1px solid ${viewMode === 'table' ? t.accent : t.btnBorder}`,
                      background: viewMode === 'table' ? `${t.accent}20` : 'transparent',
                      color: viewMode === 'table' ? t.accent : t.textMuted,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    Table
                  </button>
                  <button
                    onClick={() => {
                      setViewMode("profile");
                      setChartDropdownOpen(false);
                    }}
                    style={{
                      padding: "1px 7px",
                      fontSize: 10,
                      fontFamily: t.font,
                      borderRadius: 3,
                      border: `1px solid ${viewMode === "profile" ? t.accent : t.btnBorder}`,
                      background:
                        viewMode === "profile"
                          ? `${t.accent}20`
                          : "transparent",
                      color: viewMode === "profile" ? t.accent : t.textMuted,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    Profile
                  </button>
                  {/* Chart type dropdown trigger */}
                  <div style={{ position: 'relative' }}>
                    <button
                      onClick={() => {
                        if (viewMode === 'chart' && chartDropdownOpen) {
                          setChartDropdownOpen(false);
                        } else {
                          setViewMode('chart');
                          setChartDropdownOpen((p) => !p);
                        }
                      }}
                      style={{
                        padding: '1px 7px', fontSize: 10, fontFamily: t.font, borderRadius: 3,
                        border: `1px solid ${viewMode === 'chart' ? t.accent : t.btnBorder}`,
                        background: viewMode === 'chart' ? `${t.accent}20` : 'transparent',
                        color: viewMode === 'chart' ? t.accent : t.textMuted,
                        cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', gap: 3,
                      }}
                    >
                      {selectedChartType ? CHART_TYPE_OPTIONS.find((o) => o.value === selectedChartType)?.label ?? 'Chart' : 'Chart'}
                      <svg width="6" height="6" viewBox="0 0 8 8" fill="currentColor">
                        <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </button>
                    {chartDropdownOpen && (
                      <ChartTypeDropdown
                        selected={selectedChartType}
                        onSelect={(ct) => {
                          setSelectedChartType(ct);
                          setViewMode('chart');
                          setChartDropdownOpen(false);
                        }}
                        onClose={() => setChartDropdownOpen(false)}
                        t={t}
                      />
                    )}
                  </div>
                  <button
                    onClick={() => void handleRecommendChart()}
                    disabled={chartRecommendBusy}
                    title="Recommend chart from result fields"
                    style={{
                      padding: '1px 7px', fontSize: 10, fontFamily: t.font, borderRadius: 3,
                      border: `1px solid ${chartRecommendBusy ? t.btnBorder : t.accent}`,
                      background: chartRecommendBusy ? 'transparent' : `${t.accent}14`,
                      color: chartRecommendBusy ? t.textMuted : t.accent,
                      cursor: chartRecommendBusy ? 'wait' : 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    {chartRecommendBusy ? '...' : 'Suggest'}
                  </button>
                  {chartRecommendNote && (
                    <span
                      title={chartRecommendNote}
                      style={{
                        maxWidth: 150,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 10,
                        color: t.textMuted,
                        fontFamily: t.font,
                      }}
                    >
                      {chartRecommendNote}
                    </span>
                  )}
                  {/* Config gear */}
                  {viewMode === 'chart' && (
                    <button
                      onClick={() => setChartConfigOpen((p) => !p)}
                      title="Chart configuration"
                      style={{
                        padding: '1px 5px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                        border: `1px solid ${chartConfigOpen ? t.accent : t.btnBorder}`,
                        background: chartConfigOpen ? `${t.accent}20` : 'transparent',
                        color: chartConfigOpen ? t.accent : t.textMuted,
                        transition: 'all 0.15s', display: 'flex', alignItems: 'center',
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.386.506.798.704 1.23.315.698.043 1.44-.476 1.89l-.815.806a.338.338 0 0 0-.079.262c.02.267.02.538 0 .805a.338.338 0 0 0 .079.262l.815.806c.52.45.79 1.192.476 1.89a7.22 7.22 0 0 1-.704 1.23c-.428.609-1.176.806-1.82.63l-1.103-.303c-.066-.019-.176-.011-.299.071a5.09 5.09 0 0 1-.668.386c-.133.066-.194.158-.212.224l-.288 1.107c-.169.645-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.29-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.09 5.09 0 0 1-.668-.387c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a7.12 7.12 0 0 1-.704-1.23c-.315-.698-.043-1.44.476-1.89l.815-.806a.338.338 0 0 0 .079-.262 6.08 6.08 0 0 1 0-.805.338.338 0 0 0-.079-.262l-.815-.806c-.52-.45-.79-1.192-.476-1.89a7.22 7.22 0 0 1 .704-1.23c.428-.609 1.176-.806 1.82-.63l1.103.303c.066.019.176.011.299-.071.214-.143.437-.272.668-.386.133-.066.194-.158.212-.224L6.54 1.29C6.71.645 7.256.095 7.999.031 8.236.01 8.474 0 8.713 0H8ZM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
                      </svg>
                    </button>
                  )}
                </div>
              )}

              <button
                onClick={() => setShowOutput((s) => !s)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: t.textMuted,
                  fontSize: 11,
                  fontFamily: t.font,
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="currentColor"
                  style={{ transform: showOutput ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                >
                  <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
                </svg>
                {showOutput ? 'Hide' : 'Show'}
              </button>
            </div>

            {combineOpen && cell.result && (
              <CombineDataPanel
                warehouseColumns={cell.result.columns}
                warehouseRows={cell.result.rows as Array<Record<string, unknown>>}
                warehouseRowCount={cell.result.rowCount ?? cell.result.rows.length}
                busy={staging}
                t={t}
                onCancel={() => setCombineOpen(false)}
                onCombine={(request) => void handleCombineLocally(request)}
                suggestedPlan={cell.mixedSourcePlan}
              />
            )}

            {showOutput && (
              <>
                {repairNotice && !cell.error && (
                  <div
                    role="status"
                    style={{
                      padding: '8px 12px',
                      borderLeft: `3px solid ${t.success}`,
                      background: `${t.success}10`,
                      color: t.textSecondary,
                      font: `500 11px ${t.font}`,
                    }}
                  >
                    {repairNotice}
                  </div>
                )}
                {cell.status === 'running' && isExecutable && (
                  <RunningOutput
                    cellType={cell.type}
                    cellName={cell.name}
                    t={t}
                    onCancel={() => cancelCell(cell.id)}
                  />
                )}
                {cell.error && (
                  <ErrorOutput
                    message={cell.error}
                    errorCode={cell.execution?.error?.code}
                    themeMode={state.themeMode}
                    onFix={cell.type === 'sql' ? handleFixAndRun : undefined}
                    onBackgroundRepair={canBackgroundRepairNotebookCell(cell)
                      ? () => void handleBackgroundRepair()
                      : undefined}
                    repairing={repairing}
                    repairError={repairError}
                    editableArtifactLabel={cell.type === 'dql' ? 'DQL' : 'SQL'}
                    schemaTables={state.schemaTables}
                  />
                )}
                {cell.result &&
                  !cell.error &&
                  (viewMode === "profile" ? (
                    <ResultProfile cell={cell} t={t} />
                  ) : viewMode === "chart" && selectedChartType ? (
                    <>
                      {renderChart(selectedChartType, cell.result, state.themeMode, cell.chartConfig)}
                      {chartConfigOpen && (
                        <ChartConfigPanel
                          columns={cell.result.columns}
                          chartConfig={cell.chartConfig}
                          onChange={(cfg) => dispatch({ type: 'UPDATE_CELL', id: cell.id, updates: { chartConfig: { ...cell.chartConfig, ...cfg } } })}
                          t={t}
                        />
                      )}
                    </>
                  ) : (
                    <TableOutput
                      result={cell.result}
                      themeMode={state.themeMode}
                      onExport={hostedExport && cell.type === 'sql' && cell.content.trim()
                        ? (format) => exportQuery({ sql: cell.content, format, ...(cell.name ? { title: cell.name } : {}), ...(cell.executionTarget ? { executionTarget: cell.executionTarget } : {}) })
                        : undefined}
                    />
                  )
                )}
              </>
            )}
          </div>
        )}

        {/* Inline lineage panel for SQL/DQL cells */}
        {isExecutable && (
          <CellLineage
            cellContent={cell.content}
            cellType={cell.type as 'sql' | 'dql'}
            compiledSql={cell.dqlArtifact?.compiledSql ?? cell.dqlArtifact?.sql}
            cellId={cell.id}
            cellName={cell.name}
            cells={cells}
            themeMode={state.themeMode}
            t={t}
            onFocusNode={(nodeId) => {
              dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
              dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
            }}
          />
        )}
      </div>
    </div>
  );
}

export const CellComponent = React.memo(
  CellComponentInner,
  (previous, next) => (
    previous.cell === next.cell
    && previous.index === next.index
    && previous.onStartResearch === next.onStartResearch
    && JSON.stringify(previous.researchState ?? null) === JSON.stringify(next.researchState ?? null)
  ),
);

function normalizeNotebookChartType(value: string): ChartType {
  const normalized = value.toLowerCase().replace(/-/g, '_');
  const chartValue = normalized === 'grouped_bar'
    ? 'grouped-bar'
    : normalized === 'stacked_bar'
      ? 'stacked-bar'
      : normalized;
  const match = CHART_TYPE_OPTIONS.find((option) => option.value === chartValue);
  return match?.value ?? 'table';
}

function makeLocalDatasetQueryCell(dataset: DatasetSource): Cell {
  const cell = makeCell(
    "sql",
    `SELECT *\nFROM "${dataset.alias.replace(/"/g, '""')}"\nLIMIT 100`,
  );
  cell.name = `${dataset.alias}_analysis`;
  cell.executionTarget = { target: "local" };
  cell.datasetRefs = [
    {
      id: dataset.id,
      alias: dataset.alias,
      role: "staged",
      fingerprint: dataset.fileFingerprint,
    },
  ];
  return cell;
}

/**
 * What a DQL cell expects, in the cell: an empty one shows a DQL example, and
 * plain SQL gets a one-click switch to a SQL cell instead of a parse error.
 */
function DqlCellGuide({
  content,
  t,
  onInsertExample,
  onSwitchToSql,
}: {
  content: string;
  t: Theme;
  onInsertExample: () => void;
  onSwitchToSql: () => void;
}) {
  const empty = !content.trim();
  const holdsSql = dqlCellHoldsPlainSql(content);
  if (!empty && !holdsSql) return null;
  const buttonStyle: React.CSSProperties = {
    background: t.btnBg,
    color: t.textSecondary,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 5,
    padding: "2px 8px",
    font: `600 10.5px ${t.font}`,
    cursor: "pointer",
  };
  return (
    <div
      role={holdsSql ? "alert" : "note"}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "6px 12px",
        borderTop: `1px solid ${t.cellBorder}`,
        background: holdsSql ? `${t.warning}14` : `${t.accent}0a`,
        color: t.textSecondary,
        font: `11px/1.45 ${t.font}`,
      }}
    >
      <span style={{ flex: "1 1 260px" }}>
        {holdsSql
          ? <>This is a <strong>DQL cell</strong>, and this looks like plain SQL. Switch to a SQL cell to run it as SQL.</>
          : <>A <strong>DQL cell</strong> holds a block, a named reusable query: <code style={{ fontFamily: t.fontMono }}>{'block "Name" { query = """SELECT …""" }'}</code>. For plain SQL, use a SQL cell.</>}
      </span>
      <button type="button" onClick={onSwitchToSql} style={{ ...buttonStyle, ...(holdsSql ? { color: t.accent, borderColor: t.accent } : {}) }}>
        Switch to SQL cell
      </button>
      {empty && (
        <button type="button" onClick={onInsertExample} style={buttonStyle}>
          Insert DQL example
        </button>
      )}
    </div>
  );
}

function QueryTargetBar({
  cell,
  connectionNames,
  defaultConnection,
  t,
  onChange,
}: {
  cell: Cell;
  connectionNames: string[];
  defaultConnection: string;
  t: Theme;
  onChange: (target: NonNullable<Cell["executionTarget"]>) => void;
}) {
  const current =
    cell.executionTarget?.target === "local"
      ? "local"
      : `connection:${cell.executionTarget?.connectionName ?? defaultConnection}`;
  // The label names the cell's language: a DQL cell never says "SQL".
  const governedKind = queryCellKindLabel(cell);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        borderTop: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}35`,
      }}
    >
      <Database size={12} color={t.textMuted} aria-hidden="true" />
      <span style={{ color: t.textMuted, fontSize: 10, fontWeight: 700 }}>
        {governedKind}
      </span>
      <span style={{ color: t.textMuted, fontSize: 10 }}>runs on</span>
      <select
        aria-label="Query execution target"
        value={current}
        onChange={(event) => {
          if (event.target.value === "local") onChange({ target: "local" });
          else
            onChange({
              target: "connection",
              connectionName: event.target.value.slice("connection:".length),
            });
        }}
        style={{
          background: t.inputBg,
          color: t.textSecondary,
          border: `1px solid ${t.inputBorder}`,
          borderRadius: 5,
          padding: "2px 6px",
          font: `10px ${t.font}`,
        }}
      >
        <option value="local">Local analysis workspace</option>
        {connectionNames.map((name) => (
          <option key={name} value={`connection:${name}`}>
            {name}
            {name === defaultConnection ? " (default)" : ""}
          </option>
        ))}
        {connectionNames.length === 0 && (
          <option value={`connection:${defaultConnection}`}>
            {defaultConnection}
          </option>
        )}
      </select>
      {cell.datasetRefs?.length ? (
        <span style={{ marginLeft: "auto", color: t.textMuted, fontSize: 10 }}>
          {cell.datasetRefs.length} dataset
          {cell.datasetRefs.length === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}

function CellNotes({
  cell,
  value,
  kind,
  onValueChange,
  onKindChange,
  onAdd,
  onRemove,
  t,
}: {
  cell: Cell;
  value: string;
  kind: NonNullable<Cell['annotations']>[number]['kind'];
  onValueChange: (value: string) => void;
  onKindChange: (kind: NonNullable<Cell['annotations']>[number]['kind']) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  t: Theme;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}30`,
        padding: "9px 12px",
        display: "grid",
        gap: 8,
      }}
    >
      {(cell.annotations ?? []).map((note) => (
        <div
          key={note.id}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            color: t.textSecondary,
            fontSize: 11,
          }}
        >
          <div style={{ flex: 1 }}>
            <span style={{ display: 'inline-flex', marginBottom: 4, border: `1px solid ${t.btnBorder}`, borderRadius: 999, padding: '1px 6px', color: t.textMuted, font: `700 9px ${t.font}`, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {note.kind ?? 'note'}
            </span>
            <div style={{ whiteSpace: "pre-wrap" }}>{note.body}</div>
            <div style={{ color: t.textMuted, fontSize: 9, marginTop: 3 }}>
              {note.author ? `${note.author} · ` : ""}
              {new Date(note.updatedAt ?? note.createdAt).toLocaleString()}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(note.id)}
            style={{
              border: 0,
              background: "transparent",
              color: t.textMuted,
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: 'flex-start' }}>
        <select
          aria-label="Research note type"
          value={kind ?? 'note'}
          onChange={(event) => onKindChange(event.target.value as NonNullable<Cell['annotations']>[number]['kind'])}
          style={{ background: t.inputBg, color: t.textPrimary, border: `1px solid ${t.inputBorder}`, borderRadius: 6, padding: '6px 7px', font: `11px ${t.font}` }}
        >
          <option value="note">Note</option>
          <option value="assumption">Assumption</option>
          <option value="finding">Finding</option>
          <option value="decision">Decision</option>
          <option value="caveat">Caveat</option>
        </select>
        <textarea
          aria-label="Cell note"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Record an assumption, validation note, or takeaway…"
          rows={2}
          style={{
            flex: 1,
            resize: "vertical",
            background: t.inputBg,
            color: t.textPrimary,
            border: `1px solid ${t.inputBorder}`,
            borderRadius: 6,
            padding: "6px 8px",
            font: `11px ${t.font}`,
          }}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!value.trim()}
          style={{
            alignSelf: "flex-end",
            border: `1px solid ${t.accent}`,
            background: `${t.accent}14`,
            color: t.accent,
            borderRadius: 5,
            padding: "5px 9px",
            font: `700 10px ${t.font}`,
            cursor: value.trim() ? "pointer" : "not-allowed",
            opacity: value.trim() ? 1 : 0.5,
          }}
        >
          Add note
        </button>
      </div>
    </div>
  );
}

function ResultProfile({ cell, t }: { cell: Cell; t: Theme }) {
  const result = cell.result;
  if (!result) return null;
  const sample = result.rows.slice(0, 500);
  return (
    <div
      style={{
        padding: 12,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 8,
      }}
    >
      {result.columns.map((column) => {
        const values = sample.map((row) => row[column]);
        const nonNull = values.filter(
          (value) => value !== null && value !== undefined && value !== "",
        );
        const unique = new Set(nonNull.map((value) => String(value))).size;
        const numeric = nonNull.filter(
          (value) =>
            typeof value === "number" ||
            (typeof value === "string" &&
              value.trim() !== "" &&
              Number.isFinite(Number(value))),
        );
        return (
          <div
            key={column}
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 7,
              padding: 9,
              background: t.cellBg,
            }}
          >
            <div
              style={{
                color: t.textPrimary,
                font: `700 11px ${t.fontMono}`,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {column}
            </div>
            <div style={{ color: t.textMuted, fontSize: 10, marginTop: 6 }}>
              {sample.length - nonNull.length} null · {unique} distinct in
              preview
            </div>
            {numeric.length === nonNull.length && numeric.length > 0 && (
              <div
                style={{ color: t.textSecondary, fontSize: 10, marginTop: 3 }}
              >
                min {Math.min(...numeric.map(Number)).toLocaleString()} · max{" "}
                {Math.max(...numeric.map(Number)).toLocaleString()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function cellHeaderTextButtonStyle(
  t: Theme,
  tone: "default" | "accent" | "danger" = "default",
): React.CSSProperties {
  return controlStyle(t, {
    variant: tone === 'accent' ? 'accent' : tone === 'danger' ? 'danger' : 'secondary',
    size: 'xs',
  });
}

function ExploreStepButton({
  label,
  t,
  onClick,
}: {
  label: string;
  t: Theme;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Create a reusable ${label.toLowerCase()} step from this result`}
      style={{
        border: `1px solid ${t.btnBorder}`,
        background: t.btnBg,
        color: t.textSecondary,
        borderRadius: 4,
        padding: '2px 6px',
        font: `700 10px ${t.font}`,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}


/**
 * "You fixed this — teach DQL?"
 *
 * Shown only when an AI-generated cell was EDITED and then ran SUCCESSFULLY, so
 * the captured pair is a correction that demonstrably works rather than an
 * abandoned experiment. Recorded as a candidate; it shapes nobody else's answers
 * until approved in Settings -> Agent learning.
 */
function TeachCorrectionBar({ cell, t }: { cell: Cell; t: Theme }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'dismissed' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const {
    eligible,
    generatedSql: generated,
    correctedSql: current,
    question,
  } = teachCorrectionEligibility(cell);
  const initialDraft = useMemo(() => buildTeachCorrectionDraft(cell, {
    question: question ?? '',
    previousSql: generated,
    correctedSql: current,
    domain: typeof window !== 'undefined'
      ? (() => {
          const domain = new URLSearchParams(window.location.search).get('domain');
          return domain && domain !== 'all' ? domain : undefined;
        })()
      : undefined,
  }), [cell, current, generated, question]);
  const [title, setTitle] = useState(initialDraft.title);
  const [guidance, setGuidance] = useState(initialDraft.guidance);
  const [rationale, setRationale] = useState(initialDraft.rationale);
  const [lesson, setLesson] = useState(initialDraft.lesson);
  const [scope, setScope] = useState<TeachCorrectionScope>(initialDraft.scope);

  if (!eligible || state === 'dismissed') return null;

  if (state === 'saved') {
    return (
      <div
        data-teach-state="saved"
        role="status"
        style={{
          borderTop: `1px solid ${t.success}55`,
          borderBottom: `1px solid ${t.success}33`,
          background: `${t.success}10`,
          padding: '11px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: t.success,
          fontFamily: t.font,
        }}
      >
        <Check size={17} strokeWidth={2.4} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 750 }}>Correction saved for review</div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: t.textMuted }}>
            It remains a candidate until it passes evaluation and you explicitly approve it in Agent learning.
          </div>
        </div>
      </div>
    );
  }

  const teach = async () => {
    if (!title.trim() || !guidance.trim()) {
      setError('Add a short title and reusable lesson before saving.');
      setState('error');
      return;
    }
    if (!teachScopeHasRecallAnchor(scope)) {
      setError('Confirm at least one domain, metric, dbt model, business term, or block so this learning cannot become project-wide by accident.');
      setState('error');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const result = await api.recordAgentCorrection({
        question: question!,
        wrongSql: generated,
        correctedSql: current,
        title: title.trim(),
        guidance: guidance.trim(),
        lesson: {
          ...lesson,
          version: 1,
          rule: guidance.trim(),
        },
        rationale: rationale.trim() || 'Edited in the notebook and ran successfully.',
        scope,
      });
      if (result.ok === false) {
        setError(result.error ?? 'Could not save this correction.');
        setState('error');
        return;
      }
      setState('saved');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setState('error');
    }
  };

  return (
    <div
      data-teach-state={state === 'error' ? 'error' : 'ready'}
      role="region"
      aria-label="Teach ZLens correction"
      style={{
        borderTop: `2px solid ${state === 'error' ? t.error : t.accent}`,
        borderBottom: `1px solid ${state === 'error' ? `${t.error}44` : `${t.accent}44`}`,
        background: state === 'error'
          ? `${t.error}0D`
          : `linear-gradient(90deg, ${t.accent}18 0%, ${t.accent}09 72%, transparent 100%)`,
        padding: '13px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        flexWrap: 'wrap',
        fontFamily: t.font,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          flex: '0 0 32px',
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          color: state === 'error' ? t.error : '#ffffff',
          background: state === 'error' ? `${t.error}18` : t.accent,
          border: `1px solid ${state === 'error' ? `${t.error}44` : t.accent}`,
        }}
      >
        <Sparkles size={17} strokeWidth={2.3} />
      </div>
      <div style={{ flex: '1 1 300px', minWidth: 0 }}>
        <div style={{ color: state === 'error' ? t.error : t.textPrimary, fontSize: 12.5, fontWeight: 750 }}>
          {state === 'error' ? 'This correction was not saved' : 'Teach ZLens from this successful correction'}
        </div>
        <div style={{ marginTop: 3, color: t.textMuted, fontSize: 10.75, lineHeight: 1.45 }}>
          {state === 'error'
            ? (error ?? 'ZLens could not create the review candidate. Try again.')
            : <>Review the before/after SQL, explain the reusable lesson, and confirm where it applies. Saving creates a candidate only.</>}
        </div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginLeft: 'auto' }}>
        <button
          type="button"
          onClick={() => setReviewOpen((open) => !open)}
          title="Review the reusable lesson and its governed scope"
          style={controlStyle(t, { variant: 'primary', size: 'md' })}
        >
          <Sparkles size={14} aria-hidden="true" />
          {reviewOpen ? 'Close review' : 'Review & teach'}
        </button>
        <button
          type="button"
          onClick={() => setState('dismissed')}
          title="Dismiss this suggestion"
          style={controlStyle(t, { variant: 'ghost', size: 'sm' })}
        >
          Not now
        </button>
      </div>
      {reviewOpen ? (
        <div
          data-teach-review
          style={{
            flex: '1 0 100%',
            display: 'grid',
            gap: 12,
            padding: '13px',
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 8,
            background: t.cellBg,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            <details open style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 7, padding: 9 }}>
              <summary style={{ cursor: 'pointer', color: t.textSecondary, fontSize: 11, fontWeight: 700 }}>Before · AI draft</summary>
              <pre style={{ margin: '8px 0 0', color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{generated}</pre>
            </details>
            <details open style={{ border: `1px solid ${t.success}55`, borderRadius: 7, padding: 9 }}>
              <summary style={{ cursor: 'pointer', color: t.success, fontSize: 11, fontWeight: 700 }}>After · successful correction</summary>
              <pre style={{ margin: '8px 0 0', color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{current}</pre>
            </details>
          </div>

          <label style={{ display: 'grid', gap: 4, color: t.textSecondary, fontSize: 10.5, fontWeight: 650 }}>
            Learning title
            <input value={title} onChange={(event) => setTitle(event.target.value)} style={controlStyle(t, { size: 'sm' })} />
          </label>
          <label style={{ display: 'grid', gap: 4, color: t.textSecondary, fontSize: 10.5, fontWeight: 650 }}>
            Reusable lesson
            <textarea
              value={guidance}
              onChange={(event) => {
                setGuidance(event.target.value);
                setLesson((currentLesson) => ({ ...currentLesson, rule: event.target.value }));
              }}
              rows={3}
              placeholder="Explain the business or SQL rule that should guide similar questions."
              style={{ ...controlStyle(t, { size: 'sm' }), resize: 'vertical', lineHeight: 1.45 }}
            />
            <span style={{ color: t.textMuted, fontWeight: 400 }}>This reviewed lesson—not the raw comment—is what matching future questions receive.</span>
          </label>

          <details style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 7, padding: '9px 10px' }}>
            <summary style={{ cursor: 'pointer', color: t.textSecondary, fontSize: 10.5, fontWeight: 700 }}>
              Help ZLens generalize this lesson <span style={{ color: t.textMuted, fontWeight: 400 }}>(optional)</span>
            </summary>
            <div style={{ display: 'grid', gap: 9, paddingTop: 9 }}>
              <label style={{ display: 'grid', gap: 4, color: t.textMuted, fontSize: 10 }}>
                Lesson type
                <select
                  value={lesson.category}
                  onChange={(event) => setLesson({
                    ...lesson,
                    category: event.target.value as typeof lesson.category,
                  })}
                  style={controlStyle(t, { size: 'sm' })}
                >
                  <option value="semantic_rule">Business definition</option>
                  <option value="filter_rule">Filter rule</option>
                  <option value="join_rule">Join rule</option>
                  <option value="aggregation_rule">Aggregation rule</option>
                  <option value="grain_rule">Grain rule</option>
                  <option value="time_rule">Time rule</option>
                  <option value="relation_rule">Table or column rule</option>
                  <option value="dialect_rule">SQL dialect rule</option>
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, color: t.textMuted, fontSize: 10 }}>
                Similar questions <span>one per line; used for retrieval, never as automatic truth</span>
                <textarea
                  value={lesson.intentExamples.join('\n')}
                  onChange={(event) => setLesson({
                    ...lesson,
                    intentExamples: event.target.value.split(/\r?\n/),
                  })}
                  onBlur={() => setLesson({
                    ...lesson,
                    intentExamples: parseTeachLessonLines(lesson.intentExamples.join('\n')),
                  })}
                  rows={3}
                  placeholder={'Revenue by region\nWhich markets generate the most net sales?'}
                  style={{ ...controlStyle(t, { size: 'sm' }), resize: 'vertical', lineHeight: 1.4 }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, color: t.textMuted, fontSize: 10 }}>
                Avoid these known mistakes <span>one per line</span>
                <textarea
                  value={lesson.avoid.join('\n')}
                  onChange={(event) => setLesson({
                    ...lesson,
                    avoid: event.target.value.split(/\r?\n/),
                  })}
                  onBlur={() => setLesson({
                    ...lesson,
                    avoid: parseTeachLessonLines(lesson.avoid.join('\n')),
                  })}
                  rows={2}
                  placeholder="Do not include refunded orders."
                  style={{ ...controlStyle(t, { size: 'sm' }), resize: 'vertical', lineHeight: 1.4 }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, color: t.textMuted, fontSize: 10 }}>
                Expected outcome or result shape
                <input
                  value={lesson.expectedOutcome ?? ''}
                  onChange={(event) => setLesson({
                    ...lesson,
                    expectedOutcome: event.target.value || undefined,
                  })}
                  placeholder="One row per region using net revenue"
                  style={controlStyle(t, { size: 'sm' })}
                />
              </label>
            </div>
          </details>

          <div>
            <div style={{ color: t.textSecondary, fontSize: 10.5, fontWeight: 700, marginBottom: 6 }}>Where should this learning apply?</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 7 }}>
              {([
                ['domain', 'Domain'],
                ['metric', 'Metric'],
                ['dbtModel', 'dbt model'],
                ['term', 'Business term'],
                ['block', 'Block'],
                ['dialect', 'SQL dialect'],
              ] as Array<[keyof TeachCorrectionScope, string]>).map(([field, label]) => (
                <label key={field} style={{ display: 'grid', gap: 3, color: t.textMuted, fontSize: 10 }}>
                  {label}
                  <input
                    value={scope[field] ?? ''}
                    onChange={(event) => setScope({
                      ...scope,
                      [field]: event.target.value || undefined,
                    })}
                    placeholder={`Optional ${label.toLowerCase()}`}
                    style={controlStyle(t, { size: 'sm' })}
                  />
                </label>
              ))}
            </div>
          </div>

          <label style={{ display: 'grid', gap: 4, color: t.textSecondary, fontSize: 10.5, fontWeight: 650 }}>
            Why is this correct? <span style={{ color: t.textMuted, fontWeight: 400 }}>(optional reviewer evidence)</span>
            <textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              rows={2}
              placeholder="Example: Finance defines revenue as net amount and excludes refunded orders."
              style={{ ...controlStyle(t, { size: 'sm' }), resize: 'vertical', lineHeight: 1.45 }}
            />
          </label>

          <div style={{ border: `1px solid ${teachScopeHasRecallAnchor(scope) ? `${t.success}55` : `${t.warning}66`}`, borderRadius: 7, padding: '9px 10px', background: teachScopeHasRecallAnchor(scope) ? `${t.success}08` : `${t.warning}0A`, display: 'grid', gap: 4, fontSize: 10.5 }}>
            <div style={{ color: t.textPrimary, fontWeight: 700 }}>
              Will apply to: {teachScopeLabels(scope).length ? `questions matching ${teachScopeLabels(scope).join(' · ')}` : 'no confirmed scope yet'}
            </div>
            <div style={{ color: t.textMuted }}>
              Will not apply when a confirmed scope value differs. Relations and columns are derived from the corrected SQL and current project snapshot, then used for ranking, drift checks, and review evidence.
            </div>
            {!teachScopeHasRecallAnchor(scope) ? <div style={{ color: t.warning }}>Add at least one domain, metric, model, term, or block before saving.</div> : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void teach()}
              disabled={state === 'saving' || !teachScopeHasRecallAnchor(scope)}
              style={controlStyle(t, { variant: 'primary', size: 'md', disabled: state === 'saving' || !teachScopeHasRecallAnchor(scope) })}
            >
              <Sparkles size={14} aria-hidden="true" />
              {state === 'saving' ? 'Saving candidate…' : 'Save learning candidate'}
            </button>
            <span style={{ color: t.textMuted, fontSize: 10.25 }}>It remains inactive until evaluation and explicit approval in Agent learning.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function HeaderActionBtn({
  title,
  onClick,
  children,
  t,
  accent,
  danger,
  run,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  t: Theme;
  accent?: boolean;
  danger?: boolean;
  /** Execute action — carries the success green so Run reads at a glance. */
  run?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  // Every icon used to sit at `textMuted` until hovered, with a transparent
  // background — so a row of identical grey glyphs gave no clue which one runs
  // the cell and which one deletes it. Intent now shows at REST: green = run,
  // red = destructive, accent = AI/edit, neutral = reorder. Hover only deepens it.
  const tone = run ? t.success : danger ? t.error : accent ? t.accent : undefined;
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 26,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tone
          ? (hovered ? `${tone}24` : `${tone}12`)
          : (hovered ? t.btnHover : 'transparent'),
        border: `1px solid ${tone ? (hovered ? `${tone}66` : `${tone}33`) : (hovered ? t.btnBorder : 'transparent')}`,
        borderRadius: 6,
        cursor: 'pointer',
        color: tone ?? (hovered ? t.textSecondary : t.textMuted),
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function ChartTypeDropdown({
  selected,
  onSelect,
  onClose,
  t,
}: {
  selected: ChartType | null;
  onSelect: (ct: ChartType) => void;
  onClose: () => void;
  t: Theme;
}) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Close on outside click after a small delay
      setTimeout(() => onClose(), 0);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 24,
        right: 0,
        zIndex: 200,
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 4,
        minWidth: 130,
        maxHeight: 280,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {CHART_TYPE_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onSelect(value)}
          onMouseEnter={() => setHoveredItem(value)}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            background: selected === value ? `${t.accent}20` : hoveredItem === value ? t.btnHover : 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            color: selected === value ? t.accent : t.textSecondary,
            fontSize: 11,
            fontFamily: t.font,
            fontWeight: selected === value ? 600 : 400,
            padding: '4px 10px',
            textAlign: 'left' as const,
            transition: 'background 0.1s',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ChartConfigPanel({
  columns,
  chartConfig,
  onChange,
  t,
}: {
  columns: string[];
  chartConfig?: import('../../store/types').CellChartConfig;
  onChange: (cfg: Partial<import('../../store/types').CellChartConfig>) => void;
  t: Theme;
}) {
  const selectStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '3px 6px',
    outline: 'none',
    minWidth: 100,
    flex: 1,
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 700 as const,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    minWidth: 40,
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 16px',
        padding: '8px 12px',
        borderTop: `1px solid ${t.cellBorder}`,
        background: `${t.tableHeaderBg}40`,
      }}
    >
      {/* X axis */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>X axis</span>
        <select style={selectStyle} value={chartConfig?.x ?? ''} onChange={(e) => onChange({ x: e.target.value || undefined })}>
          <option value="">Auto</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Y axis */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>Y axis</span>
        <select style={selectStyle} value={chartConfig?.y ?? ''} onChange={(e) => onChange({ y: e.target.value || undefined })}>
          <option value="">Auto</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Color */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>Color</span>
        <select style={selectStyle} value={chartConfig?.color ?? ''} onChange={(e) => onChange({ color: e.target.value || undefined })}>
          <option value="">None</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 150 }}>
        <span style={labelStyle}>Title</span>
        <input
          style={{ ...selectStyle, fontFamily: t.font }}
          value={chartConfig?.title ?? ''}
          placeholder="Chart title"
          onChange={(e) => onChange({ title: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}
