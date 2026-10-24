import React, { useMemo, useState, useRef, useEffect } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, CellChartConfig, QueryResult, ThemeMode } from '../../store/types';
import { renderChart, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';
import { NoSemanticBindingNote } from './SemanticFieldPicker';
import { CellEmptyState } from './CellEmptyState';

interface ChartCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

type ColumnKind = ChartColumnRole;

function kindIcon(kind: ColumnKind): string {
  if (kind === 'measure') return '#';
  if (kind === 'temporal') return '📅';
  return 'A';
}

function kindColor(kind: ColumnKind, t: Theme): string {
  if (kind === 'measure') return t.accent;
  if (kind === 'temporal') return t.warning;
  return t.success;
}

interface SlotKey {
  key: keyof Pick<CellChartConfig, 'x' | 'y' | 'color' | 'facet' | 'size'>;
  label: string;
}

const SLOTS: SlotKey[] = [
  { key: 'x', label: 'X-axis' },
  { key: 'y', label: 'Y-axis' },
  { key: 'color', label: 'Color' },
  { key: 'facet', label: 'Faceting' },
];

const DEFAULT_CHART_CONFIG: CellChartConfig = { chart: 'bar' };

const COLUMN_DRAG_MIME = 'application/x-dql-chart-column';

type DragPayload = { column: string; fromSlot?: SlotKey['key'] };

function writeDragPayload(dt: DataTransfer, payload: DragPayload) {
  dt.effectAllowed = 'move';
  dt.setData(COLUMN_DRAG_MIME, JSON.stringify(payload));
  dt.setData('text/plain', payload.column);
}

function readDragPayload(dt: DataTransfer): DragPayload | null {
  const raw = dt.getData(COLUMN_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

export function ChartCell({ cell, cells, index, themeMode, onUpdate }: ChartCellProps) {
  const t: Theme = themes[themeMode];
  const config = cell.chartConfig ?? DEFAULT_CHART_CONFIG;
  const chartType = (config.chart ?? 'bar') as ChartType;

  const upstream = useMemo(() => {
    const name = cell.upstream;
    if (!name) return undefined;
    return cells.find((c) => c.name === name);
  }, [cell.upstream, cells]);

  const upstreamOptions = useMemo(() => {
    return cells
      .slice(0, index)
      .filter((c) => c.name && c.result);
  }, [cells, index]);

  const result: QueryResult | undefined = upstream?.result;

  const classified = useMemo(() => classifyColumns(result), [result]);

  // Semantic refs win: @metric → measure, @dim → dimension. Raw columns keep
  // the inferred role so the chart builder still works pre-semantic-binding.
  const columnKinds = useMemo(() => {
    if (!result) return new Map<string, ColumnKind>();
    const map = new Map<string, ColumnKind>();
    const metricSet = new Set(classified.metrics);
    const dimSet = new Set(classified.dimensions);
    for (const col of result.columns) {
      if (metricSet.has(col)) map.set(col, 'measure');
      else if (dimSet.has(col)) map.set(col, 'dimension');
      else map.set(col, columnKindToChartRole(inferColumnKind(col, result.rows)));
    }
    return map;
  }, [result, classified]);

  const measures = useMemo(() => {
    if (!result) return [] as string[];
    return result.columns.filter((c) => columnKinds.get(c) === 'measure');
  }, [result, columnKinds]);

  const dimensions = useMemo(() => {
    if (!result) return [] as string[];
    return result.columns.filter((c) => columnKinds.get(c) !== 'measure');
  }, [result, columnKinds]);

  const updateConfig = (patch: Partial<CellChartConfig>) => {
    onUpdate({ chartConfig: { ...config, ...patch } });
  };

  if (!cell.upstream || !result) {
    return (
      <CellEmptyState
        theme={t}
        accentColor="#a371f7"
        cellLabel="Chart"
        cellName={cell.name}
        description="Charts render from an upstream dataframe — the rows of a named SQL, DQL, or Saved query cell above. Drag measures to Y, dimensions to X."
        upstreamOptions={upstreamOptions}
        onPick={(name) => onUpdate({ upstream: name })}
      />
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: t.cellBg,
        borderTop: `1px solid ${t.cellBorder}`,
        borderRight: `1px solid ${t.cellBorder}`,
        borderBottom: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid #a371f7`,
        borderRadius: 6,
        overflow: 'hidden',
        fontFamily: t.font,
      }}
    >
      {/* Chart header strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: `1px solid ${t.cellBorder}`,
          background: `${t.tableHeaderBg}60`,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: t.fontMono,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: '#a371f7',
            background: '#a371f718',
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
          }}
        >
          Chart
        </span>
        {cell.name && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>
        )}
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
          · df: {cell.upstream}
        </span>
        <button
          onClick={() => onUpdate({ upstream: undefined })}
          title="Change upstream dataframe"
          style={{
            fontSize: 10,
            background: 'transparent',
            border: `1px solid ${t.btnBorder}`,
            borderRadius: 3,
            color: t.textMuted,
            padding: '1px 6px',
            cursor: 'pointer',
            fontFamily: t.fontMono,
          }}
        >
          change
        </button>
        <div style={{ flex: 1 }} />
        <select
          value={chartType}
          onChange={(e) => updateConfig({ chart: e.target.value })}
          style={{
            fontSize: 11,
            fontFamily: t.font,
            background: t.editorBg,
            color: t.textSecondary,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 3,
            padding: '2px 6px',
            outline: 'none',
          }}
        >
          {CHART_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* 3-panel body */}
      <div style={{ display: 'grid', gridTemplateColumns: '200px 240px 1fr', minHeight: 320 }}>
        {/* Left: Measures / Dimensions */}
        <div
          style={{
            borderRight: `1px solid ${t.cellBorder}`,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflow: 'auto',
          }}
        >
          {!classified.hasSemanticBinding && <NoSemanticBindingNote theme={t} />}
          <ColumnGroup
            label="Measures"
            columns={measures}
            kinds={columnKinds}
            theme={t}
            onPick={(col) => updateConfig({ y: col })}
            pickHint="Y-axis"
          />
          <ColumnGroup
            label="Dimensions"
            columns={dimensions}
            kinds={columnKinds}
            theme={t}
            onPick={(col) => updateConfig({ x: col })}
            pickHint="X-axis"
          />
        </div>

        {/* Middle: Data tab with axis slots */}
        <div
          style={{
            borderRight: `1px solid ${t.cellBorder}`,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${t.cellBorder}`, paddingBottom: 4 }}>
            <TabPill label="Data" active theme={t} />
            <TabPill label="Style" theme={t} />
          </div>
          {SLOTS.map((slot) => (
            <AxisSlot
              key={slot.key}
              slotKey={slot.key}
              label={slot.label}
              value={config[slot.key]}
              columns={result.columns}
              kinds={columnKinds}
              theme={t}
              onAssign={(column, fromSlot) => {
                const patch: Partial<CellChartConfig> = { [slot.key]: column };
                if (fromSlot && fromSlot !== slot.key) patch[fromSlot] = undefined;
                updateConfig(patch);
              }}
              onClear={() => updateConfig({ [slot.key]: undefined })}
            />
          ))}
        </div>

        {/* Right: live preview */}
        <div style={{ padding: 10, minWidth: 0, overflow: 'hidden' }}>
          {renderChart(chartType, result, themeMode, config)}
        </div>
      </div>
    </div>
  );
}

function ColumnGroup({
  label,
  columns,
  kinds,
  theme,
  onPick,
  pickHint,
}: {
  label: string;
  columns: string[];
  kinds: Map<string, ColumnKind>;
  theme: Theme;
  onPick: (col: string) => void;
  pickHint: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: theme.textMuted,
          textTransform: 'uppercase',
          fontFamily: theme.font,
          padding: '0 2px',
        }}
      >
        {label}
      </div>
      {columns.length === 0 && (
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.font, padding: '2px 2px' }}>None</span>
      )}
      {columns.map((col) => {
        const kind = kinds.get(col) ?? 'dimension';
        return (
          <button
            key={col}
            onClick={() => onPick(col)}
            draggable
            onDragStart={(e) => writeDragPayload(e.dataTransfer, { column: col })}
            title={`Drag to an axis slot, or click to set as ${pickHint}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 6px',
              background: 'transparent',
              border: `1px solid transparent`,
              borderRadius: 4,
              cursor: 'grab',
              textAlign: 'left',
              color: theme.textPrimary,
              fontFamily: theme.fontMono,
              fontSize: 11,
              transition: 'border-color 0.1s, background 0.1s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = theme.cellBorder;
              (e.currentTarget as HTMLButtonElement).style.background = theme.tableRowHover;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <span
              style={{
                fontSize: 9,
                fontFamily: theme.fontMono,
                fontWeight: 700,
                color: kindColor(kind, theme),
                width: 14,
                textAlign: 'center',
              }}
            >
              {kindIcon(kind)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {col}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TabPill({ label, active, theme }: { label: string; active?: boolean; theme: Theme }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: theme.font,
        fontWeight: 600,
        color: active ? theme.textPrimary : theme.textMuted,
        padding: '3px 10px',
        borderRadius: 3,
        background: active ? theme.tableHeaderBg : 'transparent',
        cursor: active ? 'default' : 'not-allowed',
      }}
    >
      {label}
    </span>
  );
}

function AxisSlot({
  slotKey,
  label,
  value,
  columns,
  kinds,
  theme,
  onAssign,
  onClear,
}: {
  slotKey: SlotKey['key'];
  label: string;
  value: string | undefined;
  columns: string[];
  kinds: Map<string, ColumnKind>;
  theme: Theme;
  onAssign: (column: string, fromSlot?: SlotKey['key']) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(COLUMN_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const payload = readDragPayload(e.dataTransfer);
    if (!payload) return;
    e.preventDefault();
    onAssign(payload.column, payload.fromSlot);
    setOpen(false);
  };

  const slotBorder = dragOver ? theme.accent : value ? `${theme.accent}77` : theme.cellBorder;
  const slotBg = dragOver ? `${theme.accent}22` : value ? `${theme.accent}10` : theme.editorBg;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: theme.textMuted,
          textTransform: 'uppercase',
          fontFamily: theme.font,
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          background: slotBg,
          border: `1px dashed ${slotBorder}`,
          borderRadius: 4,
          cursor: 'pointer',
          color: value ? theme.textPrimary : theme.textMuted,
          fontFamily: theme.fontMono,
          fontSize: 11,
          textAlign: 'left',
          transition: 'background 0.1s, border-color 0.1s',
        }}
      >
        {value ? (
          <>
            <span
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                writeDragPayload(e.dataTransfer, { column: value, fromSlot: slotKey });
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'grab', minWidth: 0 }}
            >
              <span style={{ color: kindColor(kinds.get(value) ?? 'dimension', theme), fontWeight: 700, width: 14 }}>
                {kindIcon(kinds.get(value) ?? 'dimension')}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClear();
                setOpen(false);
              }}
              title="Clear"
              style={{ color: theme.textMuted, fontSize: 10, padding: '0 4px' }}
            >
              ✕
            </span>
          </>
        ) : (
          <span>{dragOver ? 'drop to set' : '+ drop column'}</span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            right: 0,
            zIndex: 10,
            background: theme.cellBg,
            border: `1px solid ${theme.cellBorder}`,
            borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
            padding: 4,
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          {columns.map((col) => (
            <button
              key={col}
              onClick={() => {
                onAssign(col);
                setOpen(false);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                background: 'transparent',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
                textAlign: 'left',
                color: theme.textPrimary,
                fontFamily: theme.fontMono,
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = theme.tableRowHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              <span style={{ color: kindColor(kinds.get(col) ?? 'dimension', theme), fontWeight: 700, width: 14 }}>
                {kindIcon(kinds.get(col) ?? 'dimension')}
              </span>
              <span>{col}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
