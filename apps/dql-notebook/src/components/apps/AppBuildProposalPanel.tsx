import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Code2, FileSearch, Loader2, ShieldAlert, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import type { AppBuildProposal, AppBuildProposalTile } from '../../api/client';

/** Tile ids that start checked: everything selectable the planner recommends. */
export function defaultProposalSelection(proposal: AppBuildProposal): Set<string> {
  return new Set(proposal.tiles.filter((tile) => !tile.error && tile.selectedByDefault).map((tile) => tile.id));
}

export type UnbuildableTile = { id: string; title: string; reason: string };

/** The one action on an Ask App proposal (design D9). */
export const OPEN_IN_APP_STUDIO_LABEL = 'Open in App Studio';

/**
 * Selected tiles that App Studio will not turn into tiles, and why: AI-written
 * SQL is never added to an App. App Studio lists the question under "Not
 * covered yet", where the author can generate a draft that needs review.
 * Shown before opening, so nothing goes missing without a word.
 */
export function unbuildableSelectedTiles(proposal: AppBuildProposal, selected: Set<string>): UnbuildableTile[] {
  const out: UnbuildableTile[] = [];
  for (const tile of proposal.tiles) {
    if (tile.source !== 'ai_generated' || tile.error || !selected.has(tile.id)) continue;
    out.push({
      id: tile.id,
      title: tile.title,
      reason: tile.sql
        ? 'Draft SQL is not added to an App. App Studio lists this question under Not covered yet, where you can generate a draft that needs review.'
        : 'No query was written for it, so it has nothing to show. App Studio lists it under Not covered yet.',
    });
  }
  return out;
}

/** What the author can change before opening the proposal in App Studio. */
export type AppBuildBriefEdits = {
  appName?: string;
  audience?: string;
};

/**
 * An Ask App proposal before it opens in App Studio: every proposed tile with
 * its trust and an include toggle (a kept tile's data becomes the App's data),
 * uncovered questions under "Not covered yet", and one "Open in App Studio"
 * action. App Studio opens at the Data step; nothing is written to the
 * project until the author publishes.
 */
export function AppBuildProposalPanel({
  proposal,
  t,
  selected,
  onToggle,
  onCreate,
  busy,
  error,
  compact,
  nameLabel = 'App name',
  defaultName,
}: {
  proposal: AppBuildProposal;
  t: Theme;
  selected: Set<string>;
  onToggle: (tileId: string) => void;
  /** Receives the author's edits; the caller opens the proposal in App Studio. */
  onCreate: (edits: AppBuildBriefEdits) => void;
  busy?: boolean;
  error?: string | null;
  compact?: boolean;
  nameLabel?: string;
  defaultName?: string;
}) {
  // App Studio builds the tiles, so only the App name is edited here.
  const [name, setName] = useState(defaultName ?? '');
  const selectable = proposal.tiles.filter((tile) => !tile.error);
  const failed = proposal.tiles.filter((tile) => tile.error);
  const selectedCount = selectable.filter((tile) => selected.has(tile.id)).length;
  const unbuildable = unbuildableSelectedTiles(proposal, selected);
  const semanticSelected = selectable.filter((tile) => selected.has(tile.id) && tile.certification === 'reviewed_semantic').length;
  const canCreate = selectedCount > 0;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.textPrimary }}>Build Brief</span>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          {proposal.coverage.certifiedTiles} Certified
          {proposal.coverage.semanticTiles > 0 ? ` · ${proposal.coverage.semanticTiles} Metrics` : ''}
          {proposal.coverage.generatedTiles > 0 ? ` · ${proposal.coverage.generatedTiles} Draft SQL` : ''}
          {proposal.coverage.gaps > 0 ? ` · ${proposal.coverage.gaps} not covered yet` : ''}
        </span>
        <span style={{ fontSize: 11, color: t.textMuted }}>Opens as a private App Studio draft</span>
      </div>

      <label style={{ display: 'grid', gap: 3 }}>
        <span style={{ fontSize: 11, color: t.textMuted, fontWeight: 600 }}>{nameLabel}</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={defaultName}
          maxLength={120}
          style={briefInputStyle(t)}
        />
      </label>

      <div style={{ display: 'grid', gap: 6 }}>
        {selectable.map((tile) => (
          <ProposalTileRow
            key={tile.id}
            tile={tile}
            t={t}
            checked={selected.has(tile.id)}
            onToggle={() => onToggle(tile.id)}
            compact={compact}
          />
        ))}
        {failed.map((tile) => (
          <div key={tile.id} style={{ ...tileRowStyle(t), opacity: 0.75 }}>
            <ShieldAlert size={13} color={t.warning} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary }}>{tile.title}</div>
              <div style={{ fontSize: 11, color: t.textMuted, marginTop: 1 }}>{tile.error}</div>
            </div>
          </div>
        ))}
      </div>

      {proposal.gaps.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Not covered yet
          </div>
          {proposal.gaps.map((gap) => (
            <div key={gap.id} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, color: t.textMuted }}>
              <FileSearch size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ lineHeight: 1.4 }}>{gap.question}</span>
            </div>
          ))}
        </div>
      ) : null}

      {unbuildable.length > 0 ? (
        <div
          role="status"
          style={{
            display: 'grid', gap: 5, padding: '9px 11px', borderRadius: 9,
            border: `1px solid ${t.headerBorder}`, background: 'var(--status-warning-bg, rgba(180,120,0,0.08))',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {unbuildable.length === 1 ? '1 selected tile goes to Not covered yet' : `${unbuildable.length} selected tiles go to Not covered yet`}
          </div>
          {unbuildable.map((tile) => (
            <div key={tile.id} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, color: t.textSecondary }}>
              <ShieldAlert size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ lineHeight: 1.45 }}><b>{tile.title}</b> — {tile.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <div style={{ fontSize: 12, color: t.error }}>{error}</div> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="dql-hover"
          onClick={() => onCreate(name.trim() ? { appName: name.trim() } : {})}
          disabled={busy || !canCreate}
          style={createButtonStyle(t, canCreate && !busy)}
        >
          {busy ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <CheckCircle2 size={13} />}
          <span>{busy ? 'Opening App Studio…' : OPEN_IN_APP_STUDIO_LABEL}</span>
        </button>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          {!canCreate
            ? 'Keep at least one tile.'
            : semanticSelected > 0
              ? `App Studio opens at the Data step. ${semanticSelected} Metrics tile${semanticSelected === 1 ? '' : 's'} still need${semanticSelected === 1 ? 's' : ''} a result review. Nothing is written to your project until you publish.`
              : 'App Studio opens at the Data step so you can check the data. Nothing is written to your project until you publish.'}
        </span>
      </div>
    </div>
  );
}

function ProposalTileRow({
  tile,
  t,
  checked,
  onToggle,
  compact,
}: {
  tile: AppBuildProposalTile;
  t: Theme;
  checked: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const certified = tile.certification === 'certified';
  const semantic = tile.certification === 'reviewed_semantic';
  const hasDetail = Boolean(tile.sql || tile.answer || (tile.preview && tile.preview.rows.length > 0));
  return (
    <div style={tileRowStyle(t)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${tile.title}`}
        style={{ marginTop: 2, accentColor: t.accent, cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={tileTitleStyle(t)}>{tile.title}</span>
          {certified ? (
            <span style={badgeStyle(t.success)}>
              <ShieldCheck size={10} /> Certified
            </span>
          ) : semantic ? (
            <span style={badgeStyle(t.accent)}>
              <Sparkles size={10} /> Metrics · Needs review
            </span>
          ) : (
            <span style={badgeStyle(t.warning)}>
              {tile.repair?.status === 'repaired' ? <Wrench size={10} /> : <Sparkles size={10} />}
              {tile.repair?.status === 'repaired' ? 'Draft SQL · repaired · Needs review' : 'Draft SQL · Needs review'}
            </span>
          )}
        </div>
        {tile.description && !compact ? (
          <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2, lineHeight: 1.4 }}>{tile.description}</div>
        ) : null}
        {tile.question && tile.question !== tile.title ? (
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>Answers: {tile.question}</div>
        ) : null}
        {!compact ? (
          <div style={{ fontSize: 11, color: tile.preflight.status === 'passed' ? t.success : tile.preflight.status === 'blocked' ? t.error : t.textMuted, marginTop: 2 }}>
            Preflight: {tile.preflight.status.replace('_', ' ')} · {tile.preflight.message}
          </div>
        ) : null}
        {tile.repair ? (
          <div style={{ fontSize: 11, color: tile.repair.status === 'repaired' ? t.warning : t.error, marginTop: 3, lineHeight: 1.4 }}>
            Repair evidence: {tile.repair.message}
          </div>
        ) : null}
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            style={{ border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, padding: 0, marginTop: 4, fontFamily: t.font }}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Code2 size={11} /> {open ? 'Hide details' : 'Show SQL & preview'}
          </button>
        ) : null}
        {open && tile.answer ? (
          <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 5, lineHeight: 1.4 }}>{tile.answer}</div>
        ) : null}
        {open && tile.sql ? (
          <pre style={sqlStyle(t)}>{tile.sql}</pre>
        ) : null}
        {open && tile.preview && tile.preview.rows.length > 0 ? (
          <MiniPreviewTable preview={tile.preview} t={t} />
        ) : null}
      </div>
    </div>
  );
}

function MiniPreviewTable({ preview, t }: { preview: NonNullable<AppBuildProposalTile['preview']>; t: Theme }) {
  const columns = preview.columns.slice(0, 5);
  const rows = preview.rows.slice(0, 5);
  return (
    <div style={{ marginTop: 5, overflow: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 6 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: t.fontMono, width: '100%' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} style={{ textAlign: 'left', padding: '3px 8px', color: t.textMuted, borderBottom: `1px solid ${t.headerBorder}`, fontWeight: 600, whiteSpace: 'nowrap' }}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} style={{ padding: '3px 8px', color: t.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {typeof preview.rowCount === 'number' && preview.rowCount > rows.length ? (
        <div style={{ fontSize: 11, color: t.textMuted, padding: '3px 8px' }}>{preview.rowCount} rows total</div>
      ) : null}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function tileRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    gap: 9,
    alignItems: 'flex-start',
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: '9px 11px',
  };
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    border: `1px solid ${color}55`,
    color,
    background: `${color}12`,
    borderRadius: 999,
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 600,
  };
}

function sqlStyle(t: Theme): React.CSSProperties {
  return {
    margin: '5px 0 0',
    maxHeight: 140,
    overflow: 'auto',
    border: `1px solid ${t.headerBorder}`,
    background: t.editorBg,
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    fontFamily: t.fontMono,
    color: t.textSecondary,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
  };
}

function createButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: t.font,
    cursor: enabled ? 'pointer' : 'default',
    background: enabled ? t.accent : `${t.accent}55`,
    color: '#fff',
  };
}

function briefInputStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 7,
    padding: '6px 9px',
    fontSize: 12,
    fontFamily: t.font,
    outline: 'none',
  };
}

function tileTitleStyle(t: Theme): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: t.font,
    minWidth: 0,
    flex: '1 1 180px',
  };
}
