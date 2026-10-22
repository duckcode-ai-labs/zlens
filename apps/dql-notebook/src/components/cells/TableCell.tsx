import React, { useMemo } from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, QueryResult, TableCellConfig, ThemeMode } from '../../store/types';
import { TableOutput } from '../output/TableOutput';
import { CellEmptyState } from './CellEmptyState';

interface TableCellProps {
  cell: Cell;
  cells: Cell[];
  index: number;
  themeMode: ThemeMode;
  onUpdate: (updates: Partial<Cell>) => void;
}

const ACCENT = '#79c0ff';

export function TableCell({ cell, cells, index, themeMode, onUpdate }: TableCellProps) {
  const t: Theme = themes[themeMode];
  const config: TableCellConfig = cell.tableConfig ?? {};

  const upstream = useMemo(() => {
    const name = cell.upstream ?? config.upstream;
    if (!name) return undefined;
    return cells.find((c) => c.name === name);
  }, [cell.upstream, config.upstream, cells]);

  const upstreamOptions = useMemo(
    () => cells.slice(0, index).filter((c) => c.name && c.result),
    [cells, index],
  );

  const result: QueryResult | undefined = upstream?.result;

  const visibleColumns = config.visibleColumns;
  const projected: QueryResult | undefined = useMemo(() => {
    if (!result) return undefined;
    if (!visibleColumns || visibleColumns.length === 0) return result;
    const available = new Set(result.columns);
    const keep = visibleColumns.filter((c) => available.has(c));
    if (keep.length === 0) return result;
    return { ...result, columns: keep };
  }, [result, visibleColumns]);

  if (!upstream || !projected) {
    return (
      <CellEmptyState
        theme={t}
        accentColor={ACCENT}
        cellLabel="Table"
        cellName={cell.name}
        description="Renders an upstream dataframe — the rows of a named SQL, DQL, or Saved query cell above — as a sortable, exportable table. Use visibleColumns in tableConfig to pin a subset."
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
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${ACCENT}`,
        borderRadius: 6,
        overflow: 'hidden',
        fontFamily: t.font,
      }}
    >
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
            color: ACCENT,
            background: `${ACCENT}18`,
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
          }}
        >
          Table
        </span>
        {cell.name && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>
        )}
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
          · df: {cell.upstream ?? config.upstream}
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
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
          {projected.rows.length.toLocaleString()} rows · {projected.columns.length} cols
        </span>
      </div>

      <TableOutput result={projected} themeMode={themeMode} />
    </div>
  );
}
