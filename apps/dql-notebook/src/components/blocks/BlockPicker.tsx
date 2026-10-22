import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../store/types';
import { STATUS_COLORS, type BlockEntry } from './block-types';
import { useNotebook } from '../../store/NotebookStore';
import { authoredDomainIds, authoredDomainOptions } from '../domains/authored-domain-options';

export type { BlockEntry } from './block-types';

interface BlockPickerProps {
  themeMode: ThemeMode;
  onPick: (block: BlockEntry) => void;
  autoFocus?: boolean;
  /** Compact popover layout (used by AddCellBar). Sidebar passes false for full card layout. */
  compact?: boolean;
}

export function BlockPicker({ themeMode, onPick, autoFocus = true, compact = true }: BlockPickerProps) {
  const { state } = useNotebook();
  const t = themes[themeMode];
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getBlockLibrary()
      .then((result) => { if (!cancelled) setBlocks(result.blocks); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (autoFocus) {
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const domainIds = useMemo(() => authoredDomainIds(state.authoredDomains), [state.authoredDomains]);
  const domains = useMemo(() => authoredDomainOptions(state.authoredDomains), [state.authoredDomains]);
  const hasUnassigned = useMemo(() => blocks.some((block) => !domainIds.has(block.domain?.trim() ?? '')), [blocks, domainIds]);
  const statuses = useMemo(() => [...new Set(blocks.map((b) => b.status))].sort(), [blocks]);

  const filtered = useMemo(() => blocks.filter((b) => {
    if (search) {
      const needle = search.toLowerCase();
      const evidence = [
        b.name,
        b.description,
        b.llmContext,
        b.domain,
        b.status,
        b.owner,
        ...(b.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!evidence.includes(needle)) return false;
    }
    if (domainFilter === 'uncategorized' && domainIds.has(b.domain?.trim() ?? '')) return false;
    if (domainFilter && domainFilter !== 'uncategorized' && (!domainIds.has(domainFilter) || b.domain !== domainFilter)) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    return true;
  }).sort((a, b) => {
    const certified = Number(b.status === 'certified') - Number(a.status === 'certified');
    return certified || a.name.localeCompare(b.name);
  }), [blocks, search, domainFilter, statusFilter, domainIds]);

  const selectStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '4px 6px',
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: compact ? 340 : undefined }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search question, saved query, domain, owner, or tag…"
          aria-label="Search existing saved queries"
          style={{ ...selectStyle, flex: 1, padding: '6px 8px' }}
        />
        <select aria-label="Filter saved queries by domain" value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
          <option value="">All domains</option>
          {domains.map((domain) => <option key={domain.value} value={domain.value}>{domain.label}</option>)}
          {hasUnassigned ? <option value="uncategorized">Unassigned</option> : null}
        </select>
        <select aria-label="Filter saved queries by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">Any</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {!loading && (
        <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, padding: '0 2px' }}>
          {filtered.length} reusable {filtered.length === 1 ? 'saved query' : 'saved queries'} · certified results are listed first
        </div>
      )}
      <div
        style={{
          maxHeight: compact ? 220 : 420,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 4,
        }}
      >
        {loading ? (
          <EmptyNote t={t}>Loading saved queries...</EmptyNote>
        ) : filtered.length === 0 ? (
          <EmptyNote t={t}>{blocks.length === 0 ? 'No saved queries yet. Save a cell as a saved query to get started.' : 'No saved queries match your filters.'}</EmptyNote>
        ) : (
          filtered.map((block) => (
            <BlockRow
              key={block.path}
              block={block}
              onClick={() => onPick(block)}
              t={t}
              compact={compact}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyNote({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div style={{ padding: 16, textAlign: 'center', fontSize: 11, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic' }}>
      {children}
    </div>
  );
}

function BlockRow({
  block,
  onClick,
  t,
  compact,
}: {
  block: BlockEntry;
  onClick: () => void;
  t: Theme;
  compact: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[block.status] ?? t.textMuted;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? `${t.accent}14` : 'transparent',
        border: 'none',
        borderBottom: `1px solid ${t.cellBorder}`,
        cursor: 'pointer',
        padding: compact ? '8px 10px' : '10px 12px',
        textAlign: 'left' as const,
        fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary }}>{block.name}</span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: statusColor,
            background: `${statusColor}18`,
            padding: '1px 6px',
            borderRadius: 4,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {block.status}
        </span>
      </div>
      {block.description && (
        <div
          style={{
            fontSize: 11,
            color: t.textMuted,
            lineHeight: 1.3,
            marginBottom: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {block.description}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: t.textMuted }}>
        <span style={{ background: t.pillBg, padding: '1px 6px', borderRadius: 4 }}>{block.domain || 'no domain'}</span>
        {block.owner && <span>by {block.owner}</span>}
        {(block.tags ?? []).slice(0, compact ? 2 : 4).map((tag) => (
          <span key={tag} style={{ background: t.pillBg, padding: '1px 6px', borderRadius: 4 }}>#{tag}</span>
        ))}
      </div>
    </button>
  );
}
