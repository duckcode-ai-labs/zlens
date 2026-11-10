import type { CSSProperties } from 'react';
import type { AppStudioBuildDraft } from '../../../api/client';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { ThemeMode } from '../../../themes/notebook-theme';
import { DatasetQueryPreview } from './DraftTile';
import type { ProposedTileChange } from './proposal-preview';
import { humanize } from './studio-ui';

type Tile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

/**
 * A tile an AI proposal would add or change, drawn on the canvas before
 * anything is saved. Dataset tiles run their proposed query live; other
 * sources run when the proposal is applied.
 */
export function ProposedTileCard({
  tile,
  change,
  before,
  descriptor,
  columns,
  themeMode,
  kept = true,
  onToggleKept,
}: {
  tile: Tile;
  change: Extract<ProposedTileChange, 'added' | 'updated'>;
  before?: Tile;
  descriptor?: DatasetDescriptor;
  /** Grid columns available at the current preview width. */
  columns: number;
  themeMode: ThemeMode;
  /** False when the author declined this proposed tile. */
  kept?: boolean;
  /** Present only for tiles the author may decline on their own. */
  onToggleKept?: () => void;
}): JSX.Element {
  const title = tile.title || humanize(tile.i);
  const renamed = change === 'updated' && before && (before.title || humanize(before.i)) !== title;
  const bodyHeight = Math.max(120, tile.h * 68 - 64);
  return <article
    className={`studio-component-card proposal-tile ${change}${kept ? '' : ' skipped'}`}
    aria-label={`${change === 'added' ? 'Proposed tile' : 'Proposed change'}: ${title}`}
    style={{ '--studio-tile-width': Math.min(tile.w, columns), minHeight: tile.text ? undefined : Math.max(150, tile.h * 68) } as CSSProperties}
  >
    <header>
      <span className={`proposal-badge ${change}`}>{change === 'added' ? 'PROPOSED' : 'PROPOSED CHANGE'}</span>
      <strong>{title}</strong>
      {renamed ? <small className="proposal-was">was “{before!.title || humanize(before!.i)}”</small> : null}
      {onToggleKept
        ? <label className="proposal-keep">
          <input type="checkbox" checked={kept} onChange={onToggleKept} aria-label={`Keep ${title}`} />
          Keep
        </label>
        : null}
    </header>
    <div className="draft-body" style={{ minHeight: tile.text ? 0 : bodyHeight }}>
      {tile.text
        ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div>
        : tile.query && tile.sourceId
          // Drawn on its shelves, as it will be once applied: rows SEASON, colour GAME_TYPE, never SEASON as a value (new-user test V9).
          ? <DatasetQueryPreview sourceId={tile.sourceId} descriptor={descriptor} query={tile.query} visualization={tile.viz.type} {...(tile.viz.encoding ? { encoding: tile.viz.encoding } : {})} themeMode={themeMode} height={bodyHeight - 20} />
          : <div className="draft-empty loading"><span>{humanize(tile.viz.type)} · runs when you apply</span></div>}
    </div>
  </article>;
}
