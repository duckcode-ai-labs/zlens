import React, { useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';

/** What a DuckDB or file connection reads from its data folder (the server's `DataFolderStatus`). */
export interface DataFolderStatusView {
  /** The folder as the project names it: `data`, `.`. */
  folder: string;
  tables: Array<{ name: string; source: string; kind: string }>;
  catalogs: Array<{ name: string; source: string; kind: string }>;
  skipped: Array<{ name: string; kind: string }>;
  problems: Array<{ source: string; name: string; reason: string }>;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line: `Reads 6 tables and 1 attached database from data/ · 2 not read`. */
export function describeDataFolderStatus(status: DataFolderStatusView): string {
  const where = status.folder === '.' ? 'the project folder' : status.folder === '' ? 'its sources' : /:\/\//.test(status.folder) ? status.folder : `${status.folder}/`;
  const read = [plural(status.tables.length, 'table')];
  if (status.catalogs.length) read.push(plural(status.catalogs.length, 'attached database'));
  const notRead = status.skipped.length + status.problems.length;
  return `Reads ${read.join(' and ')} from ${where}${notRead ? ` · ${notRead} not read` : ''}`;
}

/**
 * A data folder's tables, attached databases and what is not read (and why),
 * under a file or DuckDB connection: nothing in the folder is skipped without a
 * word. What could not be read is always shown; the rest opens on demand.
 */
export function DataFolderSummary({ status, t, card = false }: { status: DataFolderStatusView; t: Theme; /** Its own card (Guided Setup), not a section of a connection's card. */ card?: boolean }) {
  const [open, setOpen] = useState(false);
  const row = (key: string, cells: Array<{ text: string; mono?: boolean; color?: string }>) => (
    <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
      {cells.map((cell, index) => (
        <span
          key={index}
          style={{
            fontSize: 11,
            fontFamily: cell.mono ? t.fontMono : t.font,
            color: cell.color ?? (index === 0 ? t.textPrimary : t.textSecondary),
            flexShrink: index === cells.length - 1 ? 1 : 0,
            minWidth: index === cells.length - 1 ? 0 : 110,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: index === cells.length - 1 ? 'normal' : 'nowrap',
          }}
        >
          {cell.text}
        </span>
      ))}
    </div>
  );
  const heading = (text: string) => (
    <div style={{ marginTop: 8, marginBottom: 3, fontSize: 10, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>
      {text}
    </div>
  );
  const hasDetails = status.tables.length + status.catalogs.length + status.skipped.length > 0;
  return (
    <section
      aria-label="Data folder"
      style={card
        ? { border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: '12px 18px', maxWidth: 640 }
        : { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${t.cellBorder}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: t.textSecondary, fontFamily: t.font }}>{describeDataFolderStatus(status)}</span>
        <div style={{ flex: 1 }} />
        {hasDetails && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            style={{ background: 'transparent', border: `1px solid ${t.btnBorder}`, borderRadius: 3, cursor: 'pointer', color: t.textMuted, fontSize: 10, fontFamily: t.font, padding: '1px 6px' }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {status.problems.length > 0 && (
        <div role="status">
          {heading('Could not read')}
          {status.problems.map((problem) => row(`problem:${problem.source}`, [
            { text: problem.source, mono: true },
            { text: problem.reason, color: t.warning },
          ]))}
        </div>
      )}
      {open && (
        <>
          {status.tables.length > 0 && heading('Tables')}
          {status.tables.map((table) => row(`table:${table.name}`, [
            { text: table.name, mono: true },
            { text: table.source, mono: true, color: t.textMuted },
            { text: table.kind },
          ]))}
          {status.catalogs.length > 0 && heading('Attached read-only: tables are catalog.schema.table')}
          {status.catalogs.map((catalog) => row(`catalog:${catalog.name}`, [
            { text: catalog.name, mono: true },
            { text: catalog.source, mono: true, color: t.textMuted },
            { text: catalog.kind.replace(/, attached as .*$/, '') },
          ]))}
          {status.skipped.length > 0 && heading('Not read as tables')}
          {status.skipped.map((item) => row(`skip:${item.name}`, [
            { text: item.name, mono: true },
            { text: item.kind },
          ]))}
        </>
      )}
    </section>
  );
}
