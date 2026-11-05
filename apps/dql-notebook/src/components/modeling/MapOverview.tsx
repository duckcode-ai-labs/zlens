import React from 'react';
import { ArrowRight, Layers } from 'lucide-react';
import type { themes } from '../../themes/notebook-theme';
import type { MapJoin, MapLevel } from './model-map-levels';

type Theme = (typeof themes)['dark'];

/**
 * The map's overview levels (model-at-scale design S5): a large model's
 * Domains, or one Domain's subject areas, as cards with their tables and
 * where their joins lead. A card opens the next level; a join opens the
 * Domain or area it reaches.
 */
export function MapOverview({ level, theme, onOpenDomain, onOpenArea, onShowAll }: {
  level: Exclude<MapLevel, { kind: 'tables' }>;
  theme: Theme;
  onOpenDomain: (domain: string) => void;
  /** `null` opens the Domain's default area: its tables, drawn in full. */
  onOpenArea: (areaId: string | null) => void;
  onShowAll: () => void;
}): JSX.Element {
  // A join opens the area it reaches; one into a Domain's default files opens that Domain (its own, drawn in full).
  const openJoin = (join: MapJoin) => {
    if (join.areaId) return onOpenArea(join.areaId);
    if (level.kind === 'areas' && join.domain === level.domain) return onOpenArea(null);
    return onOpenDomain(join.domain);
  };
  const intro = level.kind === 'domains'
    ? `${level.tables.toLocaleString('en-US')} tables in ${level.cards.length} Domains. Open a Domain to see its areas.`
    : `${level.name}: ${level.tables.toLocaleString('en-US')} tables in ${level.cards.length} areas. Open an area to see its tables.`;
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 20px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Layers size={15} style={{ color: theme.textMuted }} />
        <span style={{ fontSize: 12.5, color: theme.textSecondary, flex: 1, minWidth: 220 }}>{intro}</span>
        <button type="button" onClick={onShowAll} style={{ border: '1px solid var(--border-default)', borderRadius: 7, background: theme.cellBg, color: theme.textPrimary, padding: '6px 11px', cursor: 'pointer', fontSize: 11.5 }}>Show every table</button>
      </div>
      <div role="list" aria-label={level.kind === 'domains' ? 'Domains' : 'Areas'} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {level.cards.map((card) => {
          const key = level.kind === 'domains' ? (card as Extract<MapLevel, { kind: 'domains' }>['cards'][number]).domain : String((card as Extract<MapLevel, { kind: 'areas' }>['cards'][number]).areaId);
          const open = () => (level.kind === 'domains' ? onOpenDomain(key) : onOpenArea((card as Extract<MapLevel, { kind: 'areas' }>['cards'][number]).areaId));
          const facts = level.kind === 'domains'
            ? `${card.tables.toLocaleString('en-US')} table${card.tables === 1 ? '' : 's'} · ${(card as Extract<MapLevel, { kind: 'domains' }>['cards'][number]).areas} area${(card as Extract<MapLevel, { kind: 'domains' }>['cards'][number]).areas === 1 ? '' : 's'}`
            : `${card.tables.toLocaleString('en-US')} table${card.tables === 1 ? '' : 's'}${(card as Extract<MapLevel, { kind: 'areas' }>['cards'][number]).edge ? ` · ${(card as Extract<MapLevel, { kind: 'areas' }>['cards'][number]).edge} from other areas at its edge` : ''}`;
          return (
            <div key={key} role="listitem" style={{ border: `1px solid ${card.shared ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 10, background: theme.cellBg, padding: 12, display: 'grid', gap: 8 }}>
              <button type="button" onClick={open} aria-label={`Open ${card.name}`} style={{ all: 'unset', cursor: 'pointer', display: 'grid', gap: 4 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <b style={{ fontSize: 13.5, color: theme.textPrimary }}>{card.name}</b>
                  {card.shared ? <span style={{ fontSize: 9.5, fontWeight: 650, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 999, padding: '1px 6px' }}>Shared</span> : null}
                  <ArrowRight size={13} style={{ marginLeft: 'auto', color: theme.textMuted }} />
                </span>
                <span style={{ fontSize: 11, color: theme.textSecondary }}>{facts}</span>
                {card.shared ? <span style={{ fontSize: 10.5, color: theme.textMuted }}>Read by several areas; modeled once.</span> : null}
              </button>
              {card.joins.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                  <span style={{ fontSize: 10.5, color: theme.textMuted }}>Joins:</span>
                  {card.joins.slice(0, 6).map((join) => (
                    <button key={`${join.domain}|${join.areaId ?? ''}`} type="button" onClick={() => openJoin(join)} title={`Open ${join.name}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, background: 'transparent', color: theme.textSecondary, padding: '2px 8px', fontSize: 10.5, cursor: 'pointer' }}>
                      {join.name} {join.count}
                    </button>
                  ))}
                  {card.joins.length > 6 ? <span style={{ fontSize: 10.5, color: theme.textMuted }}>+{card.joins.length - 6} more</span> : null}
                </div>
              ) : <span style={{ fontSize: 10.5, color: theme.textMuted }}>No joins to other {level.kind === 'domains' ? 'Domains' : 'areas'} yet.</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
