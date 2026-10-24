import React, { useState, useMemo, useCallback, type CSSProperties } from 'react';
import { Braces, CalendarDays, Hash, ToggleLeft, Type, type LucideIcon } from 'lucide-react';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import type { QueryResult } from '../../store/types';
import { inferColumnKind, type ColumnKind } from '../../utils/column-kind';
import { formatDisplayValue } from '../../utils/value-format';
import { useHostUi } from '../../host/host-ui';
import { EXPORT_LABELS, type ExportFormat } from '../../api/exports';
import {
  CONDITIONAL_TONE_LABELS,
  conditionalCell,
  conditionalStats,
  type ConditionalTone,
  type DashboardConditionalFormat,
} from '@zlens/core/apps/conditional-format';

interface TableOutputProps {
  result: QueryResult;
  themeMode: ThemeMode;
  /** Lets full-screen result viewers use the available vertical space. */
  maxHeight?: CSSProperties['maxHeight'];
  /** App surfaces use a compact first page while retaining every row for paging and export. */
  initialPageSize?: number;
  /** Optional App-level selection hook. It receives the actual settled row;
   * callers remain responsible for matching it to an explicit field mapping. */
  onRowClick?: (row: Record<string, unknown>, pointer?: { x: number; y: number }) => void;
  /** Colour scales, data bars and threshold rules per measure column (App tiles). */
  conditionalFormats?: DashboardConditionalFormat[];
  /**
   * A file made on the server (RFC 0010 HH-17). With a host, downloads go
   * only this way — the host decides what may leave — so without it a hosted
   * table offers none; without a host, CSV and JSON are saved from the table.
   */
  onExport?: (format: ExportFormat) => Promise<unknown>;
  /** What an empty result says; an App tile says "No matching rows for these filters." */
  emptyMessage?: string;
}

const TONE_COLORS: Record<ConditionalTone, string> = {
  good: 'var(--status-success)',
  warning: 'var(--status-warning)',
  bad: 'var(--status-error)',
  neutral: 'var(--text-secondary)',
};

/** A rule's state as an icon with its name: colour is never the only signal. */
export function ConditionalToneIcon({ tone }: { tone: ConditionalTone }): JSX.Element {
  const color = TONE_COLORS[tone];
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" role="img" aria-label={CONDITIONAL_TONE_LABELS[tone]} style={{ flex: 'none', marginRight: 6, verticalAlign: '-2px' }}>
      <title>{CONDITIONAL_TONE_LABELS[tone]}</title>
      {tone === 'good' ? <><circle cx="8" cy="8" r="7" fill={color} /><path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg-2, #fff)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>
        : tone === 'warning' ? <><path d="M8 1.5l7 12.5H1z" fill={color} /><path d="M8 6v3.6M8 11.6v.4" stroke="var(--bg-2, #fff)" strokeWidth="1.8" strokeLinecap="round" /></>
        : tone === 'bad' ? <><circle cx="8" cy="8" r="7" fill={color} /><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--bg-2, #fff)" strokeWidth="1.8" strokeLinecap="round" /></>
        : <circle cx="8" cy="8" r="4" fill={color} />}
    </svg>
  );
}

const PAGE_SIZES = [10, 25, 50, 100, 500] as const;

type SortDir = 'asc' | 'desc' | null;

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return !isNaN(Number(value)) && value.trim() !== '';
  return false;
}

/**
 * A column's type as an icon with a plain-word tooltip (D6): Number, Text,
 * Date, Yes/No or Structured, instead of a bare "#", "A" or "D".
 */
export function columnKindBadge(kind: ColumnKind): { Icon: LucideIcon; label: string; color: string } {
  switch (kind) {
    case 'numeric': return { Icon: Hash, label: 'Number', color: '#79c0ff' };
    case 'date': return { Icon: CalendarDays, label: 'Date', color: '#e3b341' };
    case 'bool': return { Icon: ToggleLeft, label: 'Yes/No', color: '#a371f7' };
    case 'json': return { Icon: Braces, label: 'Structured', color: '#ff7b72' };
    case 'string':
    default: return { Icon: Type, label: 'Text', color: '#56d364' };
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

// ─── Export Utilities ─────────────────────────────────────────────────────────

export function exportCSV(result: QueryResult, filename?: string) {
  const escape = (v: string) => {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const header = result.columns.map(escape).join(',');
  const rows = result.rows.map((row) =>
    result.columns.map((col) => escape(formatCell(row[col]))).join(',')
  );
  const csv = [header, ...rows].join('\n');
  downloadBlob(csv, (filename || 'export') + '.csv', 'text/csv');
}

export function exportJSON(result: QueryResult, filename?: string) {
  const json = JSON.stringify(result.rows, null, 2);
  downloadBlob(json, (filename || 'export') + '.json', 'application/json');
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Sort Arrow ───────────────────────────────────────────────────────────────

function SortArrow({ dir, color }: { dir: SortDir; color: string }) {
  if (!dir) return (
    <svg width="8" height="10" viewBox="0 0 8 10" fill={color} opacity={0.3} style={{ marginLeft: 3, flexShrink: 0 }}>
      <path d="M4 0L7 3.5H1L4 0Z" />
      <path d="M4 10L1 6.5H7L4 10Z" />
    </svg>
  );
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" fill={color} style={{ marginLeft: 3, flexShrink: 0 }}>
      {dir === 'asc' ? <path d="M4 0L7 4H1L4 0Z" /> : <path d="M4 10L1 6H7L4 10Z" />}
    </svg>
  );
}

// ─── TableOutput ──────────────────────────────────────────────────────────────

/**
 * The row count above a table. When the result holds only the first rows of
 * a larger one (rowCount is the full count), it says so, so the table agrees
 * with "Live · 935 rows" next to it.
 */
export function tableRowCountLabel(input: { rangeStart: number; rangeEnd: number; loaded: number; total?: number; matching?: number }): string {
  const { rangeStart, rangeEnd, loaded, matching } = input;
  const total = typeof input.total === 'number' && input.total > loaded ? input.total : undefined;
  if (matching !== undefined) {
    return `Showing ${rangeStart}–${rangeEnd} of ${matching} matching (${total ? `first ${loaded.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : loaded} total)`;
  }
  if (total) return `Showing ${rangeStart}–${rangeEnd} of the first ${loaded.toLocaleString('en-US')} rows · ${total.toLocaleString('en-US')} in total`;
  return `Showing ${rangeStart}–${rangeEnd} of ${loaded} ${loaded === 1 ? 'row' : 'rows'}`;
}

export function TableOutput({ result, themeMode, maxHeight = 440, initialPageSize = 50, onRowClick, conditionalFormats, onExport, emptyMessage }: TableOutputProps) {
  const hosted = useHostUi().host;
  const [exportNote, setExportNote] = useState<string | null>(null);
  const serverExport = (format: ExportFormat) => {
    setExportNote(null);
    void onExport?.(format).catch((error: unknown) => setExportNote(error instanceof Error ? error.message : String(error)));
  };
  const t = themes[themeMode];
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filterText, setFilterText] = useState('');
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES.includes(initialPageSize as (typeof PAGE_SIZES)[number]) ? initialPageSize : 50);
  const [page, setPage] = useState(0);

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null); }
      else setSortDir('asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
    setPage(0);
  }, [sortCol, sortDir]);

  const metaOf = useCallback((col: string) => result.columnsMeta?.find((meta) => meta.name === col), [result.columnsMeta]);

  // Filter rows on what the reader sees as well as the raw value: "$1,317"
  // and "1317" both find the row.
  const filteredRows = useMemo(() => {
    if (!filterText.trim()) return result.rows;
    const lower = filterText.toLowerCase();
    return result.rows.filter((row) =>
      result.columns.some((col) => {
        const val = row[col];
        if (val === null || val === undefined) return false;
        if (String(val).toLowerCase().includes(lower)) return true;
        try { return formatDisplayValue(col, val, [], { meta: metaOf(col) }).toLowerCase().includes(lower); } catch { return false; }
      })
    );
  }, [result.rows, result.columns, filterText, metaOf]);

  // Sort rows
  const sortedRows = useMemo(() => {
    if (!sortCol || !sortDir) return filteredRows;
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      const cmp = compareValues(a[sortCol], b[sortCol]);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [filteredRows, sortCol, sortDir]);

  // Infer column types for typed header icons
  const columnKinds = useMemo(() => {
    const map = new Map<string, ColumnKind>();
    for (const col of result.columns) map.set(col, inferColumnKind(col, result.rows));
    return map;
  }, [result.columns, result.rows]);
  const columnValues = useMemo(() => new Map(
    result.columns.map((column) => [column, result.rows.map((row) => row[column])]),
  ), [result.columns, result.rows]);
  // Scales and bars are drawn against every row, not the page shown.
  const conditional = useMemo(() => new Map((conditionalFormats ?? [])
    .filter((format) => result.columns.includes(format.column))
    .map((format) => [format.column, { format, stats: conditionalStats(columnValues.get(format.column) ?? []) }])), [conditionalFormats, result.columns, columnValues]);

  // Track scroll to drop a soft shadow under the sticky header.
  const [scrolled, setScrolled] = useState(false);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const displayRows = sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rangeStart = sortedRows.length === 0 ? 0 : safePage * pageSize + 1;
  const rangeEnd = Math.min((safePage + 1) * pageSize, sortedRows.length);

  if (result.columns.length === 0) {
    return (
      <div style={{ padding: '12px 16px', color: t.textMuted, fontSize: 12, fontFamily: t.font, fontStyle: 'italic' }}>
        {emptyMessage ?? 'Query executed successfully. No columns to display.'}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar: filter + export + pagination */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        borderBottom: `1px solid ${t.tableBorder}`, background: `${t.tableHeaderBg}60`, flexWrap: 'wrap',
      }}>
        {/* Filter */}
        <div style={{ position: 'relative', flex: '0 1 200px', minWidth: 120 }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill={t.textMuted} style={{ position: 'absolute', left: 6, top: 6 }}>
            <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
          </svg>
          <input
            value={filterText}
            onChange={(e) => { setFilterText(e.target.value); setPage(0); }}
            placeholder="Filter rows..."
            style={{
              width: '100%', background: t.inputBg, border: `1px solid ${t.inputBorder}`,
              borderRadius: 4, color: t.textPrimary, fontSize: 11, fontFamily: t.font,
              padding: '3px 8px 3px 22px', outline: 'none',
            }}
          />
          {filterText && (
            <button onClick={() => setFilterText('')} style={{
              position: 'absolute', right: 4, top: 3, background: 'none', border: 'none',
              color: t.textMuted, cursor: 'pointer', fontSize: 12, padding: '0 2px',
            }}>×</button>
          )}
        </div>

        {/* Row count */}
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {tableRowCountLabel({ rangeStart, rangeEnd, loaded: result.rows.length, total: result.rowCount, matching: filterText ? sortedRows.length : undefined })}
        </span>

        <div style={{ flex: 1 }} />

        {/* Export buttons: made on the server when a host decides what may leave (HH-17). */}
        {onExport ? (
          <>
            {exportNote ? <span role="alert" style={{ fontSize: 11, color: t.error, fontFamily: t.font, maxWidth: 320 }}>{exportNote}</span> : null}
            {(['csv', 'json', 'xlsx'] as const).map((format) => <ExportBtn key={format} label={EXPORT_LABELS[format]} onClick={() => serverExport(format)} t={t} />)}
          </>
        ) : hosted ? null : (
          <>
            <ExportBtn label="CSV" onClick={() => exportCSV(result)} t={t} />
            <ExportBtn label="JSON" onClick={() => exportJSON(result)} t={t} />
          </>
        )}

        {/* Page size selector */}
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
          style={{
            background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 3,
            color: t.textSecondary, fontSize: 11, fontFamily: t.font, padding: '2px 4px', outline: 'none',
          }}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>{s} / page</option>
          ))}
        </select>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <PagBtn disabled={safePage === 0} onClick={() => setPage(0)} t={t}>«</PagBtn>
            <PagBtn disabled={safePage === 0} onClick={() => setPage(safePage - 1)} t={t}>‹</PagBtn>
            <span style={{ fontSize: 11, color: t.textSecondary, fontFamily: t.font, padding: '0 4px' }}>
              {safePage + 1}/{totalPages}
            </span>
            <PagBtn disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} t={t}>›</PagBtn>
            <PagBtn disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} t={t}>»</PagBtn>
          </div>
        )}
      </div>

      {/* Table */}
      <div
        style={{ maxHeight, overflow: 'auto', position: 'relative' }}
        onScroll={(e) => setScrolled((e.target as HTMLDivElement).scrollTop > 0)}
      >
        <table style={{
          width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'auto',
          fontSize: 12.5, fontFamily: t.fontMono,
        }}>
          <thead>
            <tr>
              {result.columns.map((col) => {
                const kind = columnKinds.get(col) ?? 'string';
                const numericHeader = kind === 'numeric';
                return (
                  <th
                    key={col}
                    onClick={() => handleSort(col)}
                    style={{
                      background: t.tableHeaderBg, color: t.textSecondary, fontWeight: 600,
                      fontSize: 11, textAlign: numericHeader ? 'right' : 'left', padding: '8px 14px',
                      borderBottom: `1px solid ${t.tableBorder}`,
                      minWidth: 80, maxWidth: 320, whiteSpace: 'nowrap',
                      position: 'sticky', top: 0, zIndex: 1, fontFamily: t.font,
                      letterSpacing: '0.03em', overflow: 'hidden', textOverflow: 'ellipsis',
                      cursor: 'pointer', userSelect: 'none',
                      boxShadow: scrolled ? `0 2px 4px -2px rgba(0,0,0,0.18)` : 'none',
                      transition: 'background 0.1s, box-shadow 0.18s',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: numericHeader ? 'flex-end' : 'flex-start' }}>
                      {(() => {
                        const badge = columnKindBadge(kind);
                        return (
                          <span
                            title={badge.label}
                            aria-label={badge.label}
                            role="img"
                            className="dql-column-kind"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: `color-mix(in srgb, ${badge.color} 45%, var(--text-primary, currentColor))`,
                              background: `${badge.color}15`,
                              border: `1px solid ${badge.color}40`,
                              borderRadius: 3,
                              width: 16,
                              height: 16,
                              flexShrink: 0,
                            }}
                          >
                            <badge.Icon size={11} strokeWidth={2.2} aria-hidden="true" />
                          </span>
                        );
                      })()}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={metaOf(col)?.label ? col : undefined}>{metaOf(col)?.label ?? col}</span>
                      <SortArrow dir={sortCol === col ? sortDir : null} color={sortCol === col ? t.accent : t.textMuted} />
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIdx) => {
              const isHovered = hoveredRow === rowIdx;
              const isOdd = rowIdx % 2 === 1;
              const baseBg = isOdd ? t.tableHeaderBg : 'transparent';
              return (
                <tr
                  key={rowIdx}
                  onMouseEnter={() => setHoveredRow(rowIdx)}
                  onMouseLeave={() => setHoveredRow(null)}
                  onClick={onRowClick ? (event) => onRowClick(row, { x: event.clientX, y: event.clientY }) : undefined}
                  style={{ transition: 'background 0.1s', cursor: onRowClick ? 'pointer' : undefined }}
                >
                  {result.columns.map((col) => {
                    const value = row[col];
                    const isNull = value === null || value === undefined;
                    const numericAlign = isNumeric(value);
                    const rule = conditional.get(col);
                    const cell = rule ? conditionalCell(rule.format, value, rule.stats) : undefined;
                    return (
                      <td
                        key={col}
                        style={{
                          padding: '7px 14px',
                          borderBottom: `1px solid ${t.tableBorder}`,
                          background: cell?.background && !isHovered ? cell.background : isHovered ? t.tableRowHover : baseBg,
                          ...(cell?.bar ? { backgroundImage: `linear-gradient(90deg, ${cell.bar.color} ${cell.bar.width}%, transparent ${cell.bar.width}%)` } : {}),
                          color: isNull ? t.textMuted : t.textPrimary,
                          fontStyle: isNull ? 'italic' : 'normal',
                          fontVariantNumeric: numericAlign ? 'tabular-nums' : 'normal',
                          textAlign: numericAlign ? 'right' : 'left',
                          whiteSpace: 'nowrap', maxWidth: 320,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          transition: 'background 0.1s',
                        }}
                      >
                        {cell?.tone ? <ConditionalToneIcon tone={cell.tone} /> : null}
                        {isNull ? '—' : formatDisplayValue(col, value, columnValues.get(col) ?? [], { meta: metaOf(col) })}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Hex-style footer: page picker · View · Format · Columns · Totals · row count */}
      <div
        style={{
          padding: '5px 10px',
          color: t.textMuted,
          fontSize: 11,
          fontFamily: t.font,
          borderTop: `1px solid ${t.tableBorder}`,
          background: `${t.tableHeaderBg}60`,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <PagBtn disabled={safePage === 0} onClick={() => setPage(safePage - 1)} t={t}>‹</PagBtn>
            {renderPageLinks(totalPages, safePage).map((p, i) =>
              p === '…' ? (
                <span key={`gap-${i}`} style={{ color: t.textMuted, fontSize: 11, padding: '0 2px' }}>…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p - 1)}
                  style={{
                    background: p - 1 === safePage ? `${t.accent}20` : 'transparent',
                    border: 'none',
                    color: p - 1 === safePage ? t.accent : t.textSecondary,
                    fontSize: 11,
                    fontFamily: t.font,
                    fontWeight: p - 1 === safePage ? 700 : 400,
                    padding: '1px 6px',
                    borderRadius: 3,
                    cursor: 'pointer',
                    minWidth: 20,
                  }}
                >
                  {p}
                </button>
              ),
            )}
            <PagBtn disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} t={t}>›</PagBtn>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            fontFamily: t.font,
            marginLeft: 6,
            whiteSpace: 'nowrap',
          }}
        >
          {sortedRows.length.toLocaleString()} {sortedRows.length === 1 ? 'row' : 'rows'}
          {filterText && result.rows.length !== sortedRows.length && ` of ${result.rows.length.toLocaleString()}`}
        </span>
      </div>
    </div>
  );
}

function renderPageLinks(total: number, current: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const cur = current + 1;
  const pages: Array<number | '…'> = [1];
  if (cur > 3) pages.push('…');
  for (let p = Math.max(2, cur - 1); p <= Math.min(total - 1, cur + 1); p++) pages.push(p);
  if (cur < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

function ExportBtn({ label, onClick, t }: { label: string; onClick: () => void; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.btnHover : 'transparent',
        border: `1px solid ${hovered ? t.btnBorder : 'transparent'}`,
        borderRadius: 3, cursor: 'pointer',
        color: hovered ? t.textSecondary : t.textMuted,
        fontSize: 11, fontFamily: t.font, fontWeight: 600,
        padding: '2px 6px', transition: 'all 0.15s',
        display: 'flex', alignItems: 'center', gap: 3,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
        <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.779a.749.749 0 1 1 1.06-1.06l1.97 1.97Z" />
      </svg>
      {label}
    </button>
  );
}

function PagBtn({ disabled, onClick, children, t }: { disabled: boolean; onClick: () => void; children: React.ReactNode; t: Theme }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? t.textMuted : t.textSecondary, fontSize: 12, fontFamily: t.font,
        padding: '0 3px', opacity: disabled ? 0.4 : 1, transition: 'opacity 0.1s',
      }}
    >
      {children}
    </button>
  );
}
