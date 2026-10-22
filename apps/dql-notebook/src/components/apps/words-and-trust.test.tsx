import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReaderTrustBadge } from './ReaderTrust';
import { readerTileReceipt, readerTileTrust } from './reader-trust';
import { pageShowsSummary, readerPageParts, SUMMARY_OPTION } from './reader-page-structure';
import { UNPUBLISHED_CHANGES, draftStatusWords, previewSettledWords, rowCountWords } from './app-studio-words';
import { allDataCertifiedLabel, appCardSeal, appCertificationRollup } from './app-certification';
import { CertifiedReceiptNote } from './builder/CertifiedReceiptNote';
import { DataPanel } from './builder/DataPanel';
import { columnKindBadge, TableOutput } from '../output/TableOutput';

/**
 * Phase 3 of the new-user fixes: "Certified by <name> · <date>" everywhere
 * a Certified badge appears (D5), and plain words with technical details on
 * request (D6).
 */
const today = new Date().toISOString();
const certifiedTile = (certification?: Record<string, unknown>) => ({
  tileId: 'revenue',
  status: 'ok' as const,
  blockPath: 'blocks/commerce/revenue.dql',
  dataset: { trust: 'certified' as const, sourceId: 'source.orders', validation: { outcome: 'covered' as const, adaptations: [] } },
  result: { columns: ['revenue'], rows: [{ revenue: 10 }], rowCount: 1, resultFingerprint: 'sha256:abcdef0123456789abcdef' },
  ...(certification ? { certification } : {}),
});
const item = { i: 'revenue', x: 0, y: 0, w: 4, h: 3, title: 'Revenue', owner: 'Finance', query: { measures: [{ measure: 'revenue' }] }, viz: { type: 'kpi' } } as never;
const run = { runId: 'app_run_123456789abcdef', snapshotId: 'snap_abcdef0123456789', filterFingerprint: 'f1' };

const badge = (tile: ReturnType<typeof certifiedTile>, open = false) => {
  const trust = readerTileTrust(item, tile as never)!;
  return renderToStaticMarkup(
    <ReaderTrustBadge trust={trust} freshness="Updated just now" receipt={readerTileReceipt(item, tile as never, run, Date.now())} open={open} onOpenChange={() => undefined} />,
  );
};

describe('Certified by <name> · <date> (D5)', () => {
  it('names who certified a tile and when, on the badge and its receipt', () => {
    const html = badge(certifiedTile({ by: 'maria@acme.com', name: 'Maria Lopez', at: today, checks: ['Row key: each row is one order (order_id is filled and different on all 3 rows)', 'run'] }), true);
    expect(html).toMatch(/Certified by Maria Lopez · \d{1,2} [A-Z][a-z]{2}/);
    expect(html).not.toContain('maria@acme.com');
    // The receipt lists the checks that passed, in plain words.
    expect(html).toContain('<dt>Checks passed</dt>');
    expect(html).toContain('<li>Row key: each row is one order (order_id is filled and different on all 3 rows)</li><li>Ran without errors</li>');
  });

  it('says "Certified · <date>" when no person was recorded, and "Certified" for an old certification', () => {
    expect(badge(certifiedTile({ by: 'local', at: today }))).toMatch(/<span>Certified · \d{1,2} [A-Z][a-z]{2}<\/span>/);
    const old = badge(certifiedTile());
    expect(old).toContain('<span>Certified</span>');
    // With nothing to date it, the badge keeps its freshness.
    expect(old).toContain('Updated just now');
  });

  it('the App header and the Apps card say the tile count; who and when are on each tile (T2)', () => {
    expect(allDataCertifiedLabel('Certified by Maria · 21 Oct')).toBe('All tiles certified');
    expect(allDataCertifiedLabel(undefined)).toBe('All tiles certified');
    const rollup = appCertificationRollup([item], 0, [certifiedTile({ name: 'Maria', at: today })] as never);
    expect(rollup.label).toBe('All tiles certified');
    expect(rollup.byline).toMatch(/^Certified by Maria · /);
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0, certifiedBy: 'Maria', certifiedAt: '2026-10-21T09:00:00.000Z' }).label)
      .toBe('All tiles certified');
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0 }).label).toBe('All tiles certified');
  });

  it('the Apps card, the App header and the publish check say the same thing when a tile is not certified (B6, T2)', () => {
    // Recorded at publish: 3 of 4 tiles certified, so the card never says "App certified", even after a reload.
    const card = appCardSeal({ lifecycle: 'review', certification: 'uncertified', draftCount: 0, publishedTrust: { certified: 3, total: 4 } });
    expect(card).toEqual({ certified: false, label: '3 of 4 tiles certified' });
    // An App certified before this was recorded still yields to the stored or run count.
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0, publishedTrust: { certified: 3, total: 4 } }).certified).toBe(false);
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0, publishedTrust: { certified: 4, total: 4 }, certifiedBy: 'Maria', certifiedAt: '2026-10-21T09:00:00.000Z' }).label).toBe('All tiles certified');
    // The App header's words for the same tiles.
    const reviewTile = { ...certifiedTile(), dataset: { ...certifiedTile().dataset, joins: [{ trust: 'review_required' }] } };
    const items = [item, { ...(item as object), i: 'b' }, { ...(item as object), i: 'c' }, { ...(item as object), i: 'd' }] as never;
    const header = appCertificationRollup(items, 0, [
      certifiedTile(), { ...certifiedTile(), tileId: 'b' }, { ...certifiedTile(), tileId: 'c' }, { ...reviewTile, tileId: 'd' },
    ] as never);
    expect(header.label).toBe(card.label);
  });

  it('shows the result of "I vouch for this — certify" with who, when and the checks', () => {
    const html = renderToStaticMarkup(<CertifiedReceiptNote name="Orders" certification={{ by: 'maria@acme.com', at: today, checks: ['Number formats: Subtotal: shown in dollars (stored as cents)', 'tests'] }} />);
    expect(html).toMatch(/Orders · Certified by Maria · \d{1,2} [A-Z][a-z]{2}/);
    expect(html).toContain('<li>Number formats: Subtotal: shown in dollars (stored as cents)</li>');
    expect(html).toContain('<li>Its tests passed</li>');
  });

  it('names the certifier on the Data list rows', () => {
    const html = renderToStaticMarkup(
      <DataPanel
        appData={[{ id: 'source.orders', sourceId: 'source.orders', name: 'orders', domain: 'commerce', status: 'certified', trust: 'certified', lifecycle: 'certified', owner: null, tags: [], path: 'orders', fingerprint: 'x', lastModified: '', description: '', score: 0, reasons: [], certification: { name: 'Maria', at: today } }]}
        active={null}
        target={{ kind: 'none' }}
        disabled={false}
        defaultPickerOpen
        onChoose={() => undefined}
        onPickField={() => undefined}
        onAddData={() => undefined}
        onAddSavedQuery={() => undefined}
        onAddContent={() => undefined}
      />,
    );
    expect(html).toMatch(/Saved query · Certified by Maria · \d{1,2} [A-Z][a-z]{2}/);
  });
});

describe('technical details on request (D6)', () => {
  it('keeps fingerprints, ids and file paths under a collapsed Technical details toggle', () => {
    const html = badge(certifiedTile({ name: 'Maria', at: today }), true);
    const [plain, technical] = html.split('<details class="dql-technical-details">');
    expect(technical).toBeDefined();
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(technical).toContain('<summary>Technical details</summary>');
    expect(technical).toContain('Result fingerprint');
    expect(technical).toContain('Run');
    expect(technical).toContain('blocks/commerce/revenue.dql');
    expect(plain).not.toContain('fingerprint');
    expect(plain).not.toContain('app_run_');
    expect(plain).toContain('Last refreshed');
  });

  it('writes the appendix in plain words, ids under Technical details', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
    const { ReviewAppendix, appendixTrustWords } = await import('./DashboardRenderer');
    expect(appendixTrustWords('draft_ready')).toBe('Some sources not certified yet');
    expect(appendixTrustWords('certified')).toBe('All sources certified');
    const html = renderToStaticMarkup(<ReviewAppendix
      run={{ ...run, tiles: [], story: { headline: 'x', paragraphs: [], claims: [], evidenceRefs: ['blocks/commerce/revenue.dql'], trustState: 'draft_ready', generatedBy: 'deterministic' } } as never}
      variables={{}}
      ranAtMs={Date.UTC(2026, 9, 21, 9, 30)}
    />);
    const [plain, technical] = html.split('<details class="dql-technical-details">');
    expect(plain).toContain('Last refreshed');
    expect(plain).toContain('Some sources not certified yet');
    expect(plain).not.toContain('draft_ready');
    expect(plain).not.toContain('app_run_');
    expect(technical).toContain('app_run_123456789abcdef');
    expect(technical).toContain('draft_ready');
    vi.unstubAllGlobals();
  });

  it('writes the appendix filters with their labels and in words, and counts data sources', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
    const { ReviewAppendix } = await import('./DashboardRenderer');
    const appendix = (variables: Record<string, unknown>, tiles: unknown[]) => renderToStaticMarkup(<ReviewAppendix
      run={{ ...run, tiles, story: { headline: 'x', paragraphs: [], claims: [], evidenceRefs: ['blocks/commerce/revenue.dql'], trustState: 'certified', generatedBy: 'deterministic' } } as never}
      variables={variables}
      filters={[
        { id: 'ordered_at', type: 'daterange', label: 'Ordered At' },
        { id: 'customer_name', type: 'multiselect' },
      ]}
    />);
    const ok = { status: 'ok', tileType: 'dataset' };
    const html = appendix(
      { ordered_at: { start: '2025-01-01', end: '2025-06-30' }, customer_name: ['Angela Moyer'], smartView: 'x' },
      [
        { ...ok, tileId: 'a', dataset: { sourceId: 'orders' } },
        { ...ok, tileId: 'b', dataset: { sourceId: 'orders' } },
        { ...ok, tileId: 'c', dataset: { sourceId: 'customers' } },
        { status: 'ok', tileType: 'text', tileId: 'intro' },
      ],
    );
    expect(html).not.toContain('[object Object]');
    expect(html).toContain('Ordered At: 1 Jan 2025 – 30 Jun 2025');
    expect(html).toContain('Customer Name: Angela Moyer');
    expect(html).not.toContain('smartView');
    expect(html).toContain('2 data sources');
    expect(html).not.toContain('1 sources');
    const fromOnly = appendix({ ordered_at: { start: '2025-01-01' } }, [{ ...ok, tileId: 'a', dataset: { sourceId: 'orders' } }]);
    expect(fromOnly).toContain('Ordered At: From 1 Jan 2025');
    expect(fromOnly).toContain('1 data source ·');
    expect(appendix({ ordered_at: {}, customer_name: [] }, [])).toContain('No filters');
    vi.unstubAllGlobals();
  });

  it('shows column types as icons with Number, Text and Date tooltips', () => {
    expect(['numeric', 'string', 'date'].map((kind) => columnKindBadge(kind as never).label)).toEqual(['Number', 'Text', 'Date']);
    const html = renderToStaticMarkup(<TableOutput result={{ columns: ['amount', 'name', 'ordered_on'], rows: [{ amount: 1, name: 'A', ordered_on: '2026-10-21' }], rowCount: 1 }} themeMode="light" />);
    expect(html).toContain('title="Number"');
    expect(html).toContain('title="Text"');
    expect(html).toContain('title="Date"');
    expect(html).not.toMatch(/>[#AD]<\/span>/);
  });
});

describe('plain words in App Studio (D6)', () => {
  it('replaces engineering status text', () => {
    expect(previewSettledWords(3, 3)).toBe('All tiles up to date');
    expect(previewSettledWords(2, 3)).toBe('2 of 3 tiles up to date');
    expect(rowCountWords(12)).toBe('12 rows');
    expect(rowCountWords(1)).toBe('1 row');
    expect(UNPUBLISHED_CHANGES).toBe('Unpublished changes (only you can see them)');
    expect(draftStatusWords({ published: false, saved: true })).not.toMatch(/locally|draft/i);
    expect(draftStatusWords({ published: true, saved: true })).not.toMatch(/locally|draft/i);
  });

  it('says what clicking a chart does, without the broken sentence', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
    const { crossFilterHint } = await import('./AppStudioV2');
    expect(crossFilterHint({ chart: 'bar', filters: true, sourceLabel: 'customers' })).toBe('Clicking a bar filters other Customers tiles.');
    expect(crossFilterHint({ chart: 'table', filters: true })).toBe('Clicking a row filters other tiles on this data.');
    expect(crossFilterHint({ chart: 'line', filters: false })).toBe('Clicking this chart filters nothing yet.');
    vi.unstubAllGlobals();
  });
});

describe('the auto-written Summary is off by default and the author can add it (D6)', () => {
  it('is off for new and existing pages, on only when the author added it', () => {
    expect(pageShowsSummary(undefined)).toBe(false);
    expect(pageShowsSummary({})).toBe(false);
    expect(pageShowsSummary({ summary: true })).toBe(true);
  });

  it('is offered as a page element in the Data pane', () => {
    const panel = (summaryAdded: boolean) => renderToStaticMarkup(
      <DataPanel appData={[]} active={null} target={{ kind: 'none' }} disabled={false} onChoose={() => undefined} onPickField={() => undefined} onAddData={() => undefined} onAddSavedQuery={() => undefined} onAddContent={() => undefined} summaryAdded={summaryAdded} onToggleSummary={() => undefined} />,
    );
    expect(panel(false)).toContain(`<strong>${SUMMARY_OPTION.label}</strong>`);
    expect(panel(false)).toContain('aria-pressed="false"');
    expect(panel(true)).toContain('<strong>Remove Summary</strong>');
  });
});

describe('Preview shows what readers see (D6)', () => {
  it('lays out the reader page and Preview from one list of parts', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
    const { ReaderPreviewParts } = await import('./ReaderPreviewParts');
    const story = { headline: 'Revenue rose', paragraphs: ['Revenue rose in October.'], claims: [], evidenceRefs: [], trustState: 'certified', generatedBy: 'deterministic' };
    const settled = { ...run, tiles: [certifiedTile({ name: 'Maria', at: today })], story, resultFingerprint: 'r', personaFingerprint: 'p', appId: 'a', dashboardId: 'd', persona: null, facts: [] } as never;
    for (const summary of [false, true]) {
      const parts = readerPageParts({ summary, hasDataTiles: true, mayAsk: true });
      expect(parts).toEqual(summary ? ['ask', 'trust', 'summary', 'tiles'] : ['ask', 'trust', 'tiles']);
      const html = renderToStaticMarkup(<ReaderPreviewParts parts={parts} appName="Sales" items={[item]} run={settled} />);
      expect(html).toContain(`data-reader-parts="${parts.filter((part) => part !== 'tiles').join(' ')}"`);
      expect(html).toContain('aria-label="Ask about Sales"');
      expect(html).toContain('All tiles certified');
      expect(html.includes('aria-label="Summary"')).toBe(summary);
      expect(html.includes('Revenue rose')).toBe(summary);
      expect(html).not.toContain('Business Story');
    }
    vi.unstubAllGlobals();
  });
});
