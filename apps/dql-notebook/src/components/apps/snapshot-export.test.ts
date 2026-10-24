import { describe, expect, it } from 'vitest';
import { buildStoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import { buildSnapshotBody } from './snapshot-export';

const item = (i: string, type: string, extra: Record<string, unknown> = {}) => ({ i, x: 0, y: 0, w: 6, h: 4, title: i, viz: { type }, ...extra }) as never;
const tile = (tileId: string, extra: Record<string, unknown>) => ({ tileId, status: 'ok', ...extra }) as never;

const kpi = tile('revenue', {
  tileType: 'dataset',
  dataset: { trust: 'certified', validation: { outcome: 'covered' } },
  result: { columns: ['revenue'], rows: [{ revenue: 145 }], rowCount: 1, executionTime: 1, columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] },
});
const trend = tile('trend', {
  tileType: 'dataset',
  dataset: { trust: 'draft' },
  result: { columns: ['month', 'revenue'], rows: [{ month: '2026-02-01', revenue: 30 }, { month: '2026-03-01', revenue: 55 }], rowCount: 2, executionTime: 1 },
});
const catalog = buildStoryBindingCatalog([kpi, trend]);

/** The server refuses these in a snapshot body; the builder must never produce them. */
const ACTIVE = /<\s*(script|iframe|object|embed|link|meta|form|input|button)\b|<[a-z][^>]*\son[a-z]+\s*=|<[a-z][^>]*\s(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i;

describe('signed snapshot bodies (RFC 0008 step 10)', () => {
  it('lays out a dashboard on a 12-column grid with each tile’s trust label', () => {
    const { body, tileIds } = buildSnapshotBody({
      items: [
        item('trend', 'line', { x: 6, y: 0, w: 6 }),
        item('revenue', 'kpi', { x: 0, y: 0, w: 6 }),
        item('note', 'text', { x: 0, y: 4, w: 12, text: { markdown: '## Notes <b>\n\nChecked **weekly**.' } }),
      ],
      tiles: [kpi, trend],
      catalog,
      cols: 12,
      rowHeight: 80,
    });
    expect(body.startsWith('<section class="snap-grid">')).toBe(true);
    // Reading order follows the grid: row, then column.
    expect(body.indexOf('<h2>revenue</h2>')).toBeLessThan(body.indexOf('<h2>trend</h2>'));
    expect(body).toContain('grid-column:1 / span 6');
    expect(body).toContain('grid-column:7 / span 6');
    expect(body).toContain('<span class="snap-tile-trust certified">Certified</span>');
    expect(body).toContain('<span class="snap-tile-trust review">Not certified yet</span>');
    expect(body).toContain('<div class="dql-tile-kpi">$145</div>');
    expect(body).toContain('<svg');
    expect(body).toContain('<h3>Notes &lt;b&gt;</h3><p>Checked <strong>weekly</strong>.</p>');
    expect(tileIds.sort()).toEqual(['revenue', 'trend']);
    expect(body).not.toMatch(ACTIVE);
  });

  it('maps a 24-column page onto the 12-column snapshot grid', () => {
    const { body } = buildSnapshotBody({ items: [item('revenue', 'kpi', { x: 12, w: 12 })], tiles: [kpi], catalog, cols: 24, rowHeight: 40 });
    expect(body).toContain('grid-column:7 / span 6');
  });

  it('fills a story’s bound figures from this run and embeds its tiles', () => {
    const { body, tileIds } = buildSnapshotBody({
      items: [item('revenue', 'kpi'), item('trend', 'line')],
      tiles: [kpi, trend],
      catalog,
      cols: 12,
      rowHeight: 80,
      narrative: { version: 1, presentation: 'story', blocks: [
        { id: 'a', kind: 'text', markdown: 'Revenue was {{revenue.revenue}}; *unknown* was {{nope.value}}.' },
        { id: 'b', kind: 'tile', tileId: 'trend' },
      ] } as never,
    });
    expect(body).toContain('<p>Revenue was <span class="dql-story-value">$145</span>; <em>unknown</em> was <span class="dql-story-value">—</span>.</p>');
    // Trust counts the embedded tile and the tile each figure comes from.
    expect(tileIds.sort()).toEqual(['revenue', 'trend']);
    expect(body).not.toMatch(ACTIVE);
  });

  it('draws a governed HTML page with values and tiles, and never draws markup that fails the check', () => {
    const page = buildSnapshotBody({
      items: [item('trend', 'line')],
      tiles: [kpi, trend],
      catalog,
      cols: 12,
      rowHeight: 80,
      canvas: { version: 1, html: '<section><h1>Board pack</h1><p>Revenue <dql-value bind="revenue.revenue"></dql-value></p><dql-tile tile="trend"></dql-tile></section>' },
    });
    expect(page.body).toContain('<span class="dql-value" data-bind="revenue.revenue" title="revenue — revenue">$145</span>');
    expect(page.body).toContain('<div class="dql-tile" data-tile="trend">');
    expect(page.tileIds.sort()).toEqual(['revenue', 'trend']);
    expect(page.body).not.toMatch(ACTIVE);

    const unsafe = buildSnapshotBody({
      items: [item('revenue', 'kpi')],
      tiles: [kpi],
      catalog,
      cols: 12,
      rowHeight: 80,
      canvas: { version: 1, html: '<p onclick="steal()">Hi</p>' },
    });
    // A page that fails the governed check falls back to the plain grid.
    expect(unsafe.body.startsWith('<section class="snap-grid">')).toBe(true);
    expect(unsafe.body).not.toContain('steal');
  });
});
