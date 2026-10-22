import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeDashboardTileChartConfig, normalizeDashboardChartType, summarizeDashboardKpiResult } from './dashboard-chart-config';
import { autoLayoutDashboardItems } from './dashboard-layout';
import { formatDashboardValue } from './dashboard-format';
import { prepareStakeholderItems } from './dashboard-presentation';
import { CHART_TYPE_OPTIONS } from '../output/ChartOutput';

async function dashboardHelpers() {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  return import('./DashboardRenderer');
}

describe('Dashboard KPI display contract (UI-004)', () => {
  it('normalizes legacy field and documented valueField options to the KPI measure', () => {
    expect(mergeDashboardTileChartConfig({
      i: 'orders', x: 0, y: 0, w: 3, h: 2,
      title: 'Orders this month',
      viz: { type: 'kpi', options: { field: 'order_count' } },
    } as any, { chart: 'line', x: 'order_month', y: 'revenue' })).toMatchObject({
      chart: 'kpi',
      y: 'order_count',
    });

    expect(mergeDashboardTileChartConfig({
      i: 'revenue', x: 0, y: 0, w: 3, h: 2,
      title: 'Current revenue',
      viz: { type: 'single_value', options: { valueField: 'revenue', format: 'currency' } },
    } as any)).toMatchObject({ chart: 'kpi', y: 'revenue', format: 'currency' });
  });

  it('summarizes repeated KPI rows to the same total used by dashboard facts', () => {
    expect(summarizeDashboardKpiResult({
      columns: ['order_month', 'revenue'],
      rows: [
        { order_month: '2026-06-01', revenue: 120.25 },
        { order_month: '2026-07-01', revenue: 79.75 },
      ],
      rowCount: 2,
      executionTime: 4,
    }, 'revenue')).toEqual({
      columns: ['revenue'],
      rows: [{ revenue: 200 }],
      rowCount: 1,
      executionTime: 4,
    });
  });
});

describe('App dashboard interaction contract', () => {
  it('APP-066 enables Ask about chart only for a settled published Dataset run', async () => {
    const { canAskDatasetChart } = await dashboardHelpers();
    const tile = {
      tileId: 'revenue',
      status: 'ok',
      tileType: 'dataset',
      result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1, executionTime: 1 },
      dataset: {
        sourceId: 'source.orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
        queryFingerprint: 'sha256:query', filterFingerprint: 'sha256:filter', executionFingerprint: 'sha256:execution',
      },
    } as any;
    expect(canAskDatasetChart(tile, false, 'app_run_current', true)).toBe(true);
    expect(canAskDatasetChart(tile, true, 'app_run_current', true)).toBe(false);
    expect(canAskDatasetChart(tile, false, undefined, true)).toBe(false);
    expect(canAskDatasetChart({ ...tile, status: 'error' }, false, 'app_run_current', true)).toBe(false);
    expect(canAskDatasetChart({ ...tile, tileType: 'block' }, false, 'app_run_current', true)).toBe(false);
  });

  it('makes a published Dataset mark choose explicitly between its declared filter and hierarchy drill', async () => {
    const { TileBody } = await dashboardHelpers();
    const item = {
      i: 'customer-revenue', x: 0, y: 0, w: 6, h: 4,
      sourceId: 'source.orders', sourceRevision: 'sha256:orders',
      query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] },
      viz: { type: 'bar' },
    } as any;
    const markup = renderToStaticMarkup(createElement(TileBody, {
      item,
      tile: {
        tileId: item.i, status: 'ok', tileType: 'dataset',
        result: { columns: ['customer_id', 'revenue'], rows: [{ customer_id: 'C-001', revenue: 70 }], rowCount: 1, executionTime: 1 },
        dataset: { hierarchy: { activeSteps: [], candidates: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id' }] } },
      },
      loading: false,
      error: null,
      themeMode: 'paper',
      crossFilterFields: ['customer_id'],
      onSelectDatasetMark: vi.fn(),
      onDrillDatasetMark: vi.fn(),
    } as any));
    expect(markup).toContain('Click action');
    expect(markup).toContain('Filter linked tiles');
    expect(markup).toContain('Drill to Order Id');
  });

  it('keeps published Dataset scalar rendering actionable instead of hiding fields', async () => {
    const { datasetTileVisualizationDisplayError } = await dashboardHelpers();
    const base = {
      i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
      sourceId: 'source.orders', sourceRevision: 'source.v1',
      viz: { type: 'single_value' },
    } as any;

    expect(datasetTileVisualizationDisplayError({
      ...base,
      query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
    })).toContain('exactly one selected measure');
    expect(datasetTileVisualizationDisplayError({
      ...base,
      query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
    })).toContain('can group only by one date');
    expect(datasetTileVisualizationDisplayError({
      ...base,
      query: { dimensions: [], measures: [{ measure: 'revenue' }] },
    })).toBeUndefined();
    expect(datasetTileVisualizationDisplayError({
      ...base,
      query: { dimensions: [], measures: [], detail: true, detailColumns: ['order_id'], limit: 50 },
      viz: { type: 'table' },
    })).toBeUndefined();
  });

  it('renders redacted Dataset execution evidence in the published viewer without relabeling the authored spec as DQL', async () => {
    const { TileEvidencePanel, canOpenTileInNotebook } = await dashboardHelpers();
    const item = {
      i: 'revenue-by-region', x: 0, y: 0, w: 6, h: 4,
      sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
      query: {
        dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }],
        comparison: {
          version: 1, timeField: 'order_date', timeRole: 'event_time', calendarId: 'calendar:gregorian', timezone: 'America/Chicago', grain: 'month', completenessPolicy: 'closed_period',
          periods: [
            { id: 'current_period', kind: 'absolute', start: '2026-03-01T06:00:00.000Z', end: '2026-04-01T05:00:00.000Z' },
            { id: 'comparison_period', kind: 'absolute', start: '2026-02-01T06:00:00.000Z', end: '2026-03-01T06:00:00.000Z' },
          ],
          basePeriodId: 'current_period', comparisonPeriodIds: ['comparison_period'], alignment: 'calendar_period', outputs: ['value', 'absolute_delta', 'percent_delta'], zeroDenominatorPolicy: 'null',
        },
      },
      viz: { type: 'bar' },
    } as any;
    const tile = {
      tileId: item.i, status: 'ok', tileType: 'dataset',
      result: { columns: ['region', 'revenue'], rows: [{ region: 'CA', revenue: 60 }], rowCount: 1, executionTime: 1 },
      // This is the real Dataset runtime envelope, intentionally different
      // from legacy `filter`/`skipped` output. Rendering the opened panel must
      // not assume legacy fields are present.
      filters: {
        applied: [{ field: 'region', op: 'in', values: ['CA'], placement: 'where' }],
        unbound: [{ filterId: 'period', code: 'DATASET_TILE_EXCLUDED', message: 'Period is explicitly excluded from this Dataset tile.' }],
      },
      artifact: {
        version: 1, sourceKind: 'dataset_query', name: 'Revenue by region', trustState: 'certified',
        authoredQuerySpec: '{"kind":"dataset_tile_query","boundParameterEvidence":[{"name":"as_of","valueFingerprint":"sha256:param"}]}',
        sql: 'SELECT region, SUM(net_amount) AS revenue FROM order_lines WHERE region = ?',
      },
      dataset: {
        sourceId: item.sourceId, sourceRevision: item.sourceRevision,
        authoredQueryFingerprint: 'a4a1566bdc6e9caa98db35667a38443af1a7a4e33b921fc20f6049d2e326dc84',
        parameterEvidence: [{ name: 'as_of', kind: 'string', valueFingerprint: 'sha256:param' }],
        executionProvenance: {
          version: 1, kind: 'block_runtime', sourceId: item.sourceId, sourceRevision: item.sourceRevision,
          contractFingerprint: 'sha256:contract', queryFingerprint: 'sha256:query', filterFingerprint: 'sha256:filter',
          executionFingerprint: 'sha256:execution', parameterFingerprint: 'sha256:params', targetFingerprint: 'sha256:target',
        },
      },
    } as any;

    // The concrete hash is supplied by the shared core helper rather than a
    // field-name fallback. This mirrors the server's nested response shape.
    const { tileQueryHash } = await import('@zlens/core/apps/tile-query');
    tile.dataset.authoredQueryFingerprint = tileQueryHash(item.query);
    const renderPanel = (tab: 'how' | 'dql' | 'sql') => renderToStaticMarkup(createElement(TileEvidencePanel, {
      item,
      tile,
      tab,
      onTab: () => undefined,
      onClose: () => undefined,
    }));
    const dql = renderPanel('dql');
    const sql = renderPanel('sql');
    const how = renderPanel('how');

    expect(dql).toContain('Authored query spec');
    expect(dql).toContain('dataset_tile_query');
    expect(dql).not.toContain('>DQL<');
    expect(sql).toContain('Executed SQL');
    expect(sql).toContain('SELECT region, SUM(net_amount)');
    expect(how).toContain('Bound parameters');
    expect(how).toContain('No provider execution receipt was returned');
    expect(how).toContain('region (in)');
    expect(how).toContain('1 explicitly unmapped dashboard filter');
    expect(how).toContain('Period comparison');
    expect(how).toContain('2026-03-01 to before 2026-04-01');
    expect(how).toContain('Field queries cannot be opened in Notebook yet.');
    expect(how).not.toContain('Open in Notebook');
    // The same predicate guards the click handler, so direct callers cannot
    // turn a declarative Dataset TileQuery into a fake sql_block handoff.
    expect(canOpenTileInNotebook(tile)).toBe(false);
    expect(canOpenTileInNotebook({
      tileId: 'legacy', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1, executionTime: 1 },
      artifact: { version: 1, sourceKind: 'certified_block', name: 'Revenue', trustState: 'certified', dql: 'block revenue {}' },
    })).toBe(true);
    expect(canOpenTileInNotebook({
      tileId: 'semantic', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1, executionTime: 1 },
      artifact: { version: 1, sourceKind: 'semantic_query', name: 'Revenue', trustState: 'certified', sql: 'SELECT 60 AS revenue' },
    })).toBe(true);
  });

  it('renders opened legacy and semantic evidence panels with their own runtime filter envelopes', async () => {
    const { TileEvidencePanel } = await dashboardHelpers();
    const legacyItem = {
      i: 'legacy-orders', x: 0, y: 0, w: 3, h: 2,
      block: { blockId: 'orders' }, viz: { type: 'kpi' }, title: 'Orders',
    } as any;
    const legacy = renderToStaticMarkup(createElement(TileEvidencePanel, {
      item: legacyItem,
      tile: {
        tileId: legacyItem.i, status: 'ok', tileType: 'block',
        result: { columns: ['orders'], rows: [{ orders: 6 }], rowCount: 1, executionTime: 1 },
        filters: {
          applied: [{ filter: 'region', binding: 'region', mode: 'predicate', paramNames: [] }],
          skipped: [{ filter: 'as_of', reason: 'not accepted by this saved block' }],
        },
        invocation: { resolvedParameters: [{ name: 'region', value: 'CA', source: 'surface' }], unresolvedParameters: [], auditId: 'legacy-run' },
        artifact: { version: 1, sourceKind: 'certified_block', name: 'Orders', trustState: 'certified' },
      } as any,
      tab: 'how', onTab: () => undefined, onClose: () => undefined,
    }));
    expect(legacy).toContain('region');
    expect(legacy).toContain('1 skipped');
    expect(legacy).toContain('region (surface)');

    const semanticItem = {
      i: 'semantic-revenue', x: 0, y: 0, w: 3, h: 2,
      sourceId: 'semantic.commerce', sourceRevision: 'sha256:semantic-a',
      query: { dimensions: [], measures: [{ measure: 'revenue' }] }, viz: { type: 'kpi' }, title: 'Semantic revenue',
    } as any;
    const { tileQueryHash } = await import('@zlens/core/apps/tile-query');
    const semantic = renderToStaticMarkup(createElement(TileEvidencePanel, {
      item: semanticItem,
      tile: {
        tileId: semanticItem.i, status: 'ok', tileType: 'dataset',
        result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1, executionTime: 1 },
        filters: { applied: [{ field: 'region', op: 'eq', values: ['CA'], placement: 'where' }], unbound: [] },
        artifact: { version: 1, sourceKind: 'dataset_query', name: 'Semantic revenue', trustState: 'certified', sql: 'SELECT SUM(net_amount) AS revenue FROM order_lines' },
        dataset: {
          sourceId: semanticItem.sourceId, sourceRevision: semanticItem.sourceRevision,
          authoredQueryFingerprint: tileQueryHash(semanticItem.query),
          executionProvenance: {
            version: 1, kind: 'semantic_runtime', sourceId: semanticItem.sourceId, sourceRevision: semanticItem.sourceRevision,
            contractFingerprint: 'sha256:contract', queryFingerprint: 'sha256:query', filterFingerprint: 'sha256:filter',
            executionFingerprint: 'sha256:execution', parameterFingerprint: 'sha256:parameters',
          },
          semanticReceipt: { receiptId: 'receipt-1', adapterId: 'native', outcome: 'succeeded' },
        },
      } as any,
      tab: 'how', onTab: () => undefined, onClose: () => undefined,
    }));
    expect(semantic).toContain('Metrics run');
    expect(semantic).toContain('native');
    expect(semantic).toContain('region (eq)');
  });

  it('merges an affected-tile refresh without retaining whole-dashboard evidence', async () => {
    const { mergePartialDashboardRun } = await dashboardHelpers();
    const previous = {
      appId: 'commerce', dashboardId: 'overview', persona: null,
      runId: 'run-full', snapshotId: 'snap', filterFingerprint: 'filter-a', resultFingerprint: 'result-a', personaFingerprint: 'persona',
      facts: [{ id: 'fact', tileId: 'orders', kind: 'value', label: 'Revenue', value: 10, evidenceRef: 'run-full', trustState: 'certified' }],
      story: { headline: 'Full story', paragraphs: [], claims: [], evidenceRefs: [], trustState: 'certified', generatedBy: 'deterministic' },
      filterOptions: [{ filterId: 'region', values: ['CA'], truncated: false, sourceTileIds: ['orders'] }],
      tiles: [
        { tileId: 'orders', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 10 }], rowCount: 1, executionTime: 1 } },
        { tileId: 'customers', status: 'ok', result: { columns: ['customers'], rows: [{ customers: 3 }], rowCount: 1, executionTime: 1 } },
      ],
    } as any;
    const partial = {
      ...previous,
      runId: 'run-partial', filterFingerprint: 'filter-b', resultFingerprint: 'result-b',
      partial: true, executedTileIds: ['orders'], facts: [],
      story: { headline: 'Partial dashboard refresh', paragraphs: [], claims: [], evidenceRefs: [], trustState: 'draft_ready', generatedBy: 'deterministic' },
      tiles: [{ tileId: 'orders', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 20 }], rowCount: 1, executionTime: 1 } }],
    } as any;

    const merged = mergePartialDashboardRun(previous, partial, [
      { i: 'orders', x: 0, y: 0, w: 6, h: 3, viz: { type: 'kpi' } },
      { i: 'customers', x: 6, y: 0, w: 6, h: 3, viz: { type: 'kpi' } },
    ] as any);

    expect(merged.partial).toBe(true);
    expect(merged.tiles.map((tile) => [tile.tileId, tile.result?.rows[0]])).toEqual([
      ['orders', { revenue: 20 }],
      ['customers', { customers: 3 }],
    ]);
    expect(merged.facts).toEqual([]);
    expect(merged.filterOptions).toBeUndefined();
  });

  it('prepares a clean auto-layout without mutating the saved layout', async () => {
        const saved = [
      { i: 'chart', x: 7, y: 8, w: 2, h: 1, viz: { type: 'bar' }, title: 'Chart' },
      { i: 'heading', x: 3, y: 4, w: 2, h: 2, viz: { type: 'heading' }, title: 'Summary' },
      { i: 'kpi', x: 9, y: 2, w: 8, h: 5, viz: { type: 'kpi' }, title: 'Revenue' },
    ] as any;

    const preview = autoLayoutDashboardItems(saved, 12);

    expect(preview.map((item) => item.i)).toEqual(['heading', 'kpi', 'chart']);
    expect(preview[0]).toMatchObject({ x: 0, y: 0 });
    expect(saved[0]).toMatchObject({ x: 7, y: 8, w: 2, h: 1 });
  });

  it('always offers table as a non-persistent viewer alternative for a generated chart', async () => {
    const { getGeneratedVizOptions } = await dashboardHelpers();
    const options = getGeneratedVizOptions({
      i: 'trend', x: 0, y: 0, w: 6, h: 3,
      viz: { type: 'line' },
      title: 'Revenue trend',
    } as any, { allowedVisualizations: ['line', 'area'] });

    expect(options.map((option) => option.value)).toEqual(['table', 'line', 'area']);
  });

  it('projects v1 geometry deterministically for medium and narrow containers', async () => {
    const { projectDashboardItems } = await dashboardHelpers();
    const wide = [
      { i: 'kpi', x: 0, y: 0, w: 3, h: 2, viz: { type: 'kpi' } },
      { i: 'trend', x: 3, y: 0, w: 9, h: 4, viz: { type: 'line' } },
    ] as any;

    expect(projectDashboardItems(wide, 6)).toMatchObject([
      { i: 'kpi', x: 0, y: 0, w: 2 },
      { i: 'trend', x: 0, y: 2, w: 5 },
    ]);
    expect(projectDashboardItems(wide, 1)).toMatchObject([
      { i: 'kpi', x: 0, y: 0, w: 1 },
      { i: 'trend', x: 0, y: 2, w: 1 },
    ]);
  });

  it('formats AI-pinned evidence and summaries with business meaning', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    const rows = [
      { monthly: '2016-09-01T00:00:00.000Z', type: 'food_and_drink', revenue: 9839.34 },
      { monthly: '2016-09-01T00:00:00.000Z', type: 'drink', revenue: 6676.87 },
    ];

    expect(formatDashboardValue('monthly', rows[0].monthly, rows.map((row) => row.monthly))).toBe('Sep 2016');
    expect(formatDashboardValue('revenue', rows[0].revenue, rows.map((row) => row.revenue))).toBe('$9,839.34');
    expect(formatDashboardValue('type', rows[0].type, rows.map((row) => row.type))).toBe('food and drink');
    expect(computeTileInsight({
      status: 'ok',
      result: { columns: ['type', 'revenue'], rows, rowCount: 2, executionTime: 4 },
    } as any)).toBe('food and drink leads Revenue at $9.8K.');
  });

  it('never states a share of a total the rows do not prove (RFC 0008 evaluation P0)', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    // A driver tile's folded rows repeat March once per breakdown: summing
    // them made "$30 (25%)" of a $40 March. Its checked summary is used instead.
    const driverTile = {
      status: 'ok',
      tileType: 'driver',
      driver: { summary: 'Revenue rose by 10. The largest move was US (region): +10, 100% of the change.', dimensions: [] },
      result: {
        columns: ['dimension', 'member', 'current'],
        rows: [
          { dimension: 'region', member: 'US', current: 30 }, { dimension: 'region', member: 'CA', current: 10 },
          { dimension: 'customer', member: 'C-001', current: 30 }, { dimension: 'customer', member: 'C-002', current: 10 },
          { dimension: 'order', member: 'O-1', current: 30 }, { dimension: 'order', member: 'O-2', current: 10 },
        ],
        rowCount: 6,
        executionTime: 1,
      },
    } as any;
    expect(computeTileInsight(driverTile, { i: 'why', x: 0, y: 0, w: 6, h: 4, viz: { type: 'waterfall' }, driver: {} } as any))
      .toBe('Revenue rose by 10. The largest move was US (region): +10, 100% of the change.');
    // A block's distinct counts do not add up across rows, so no percent is shown.
    const distinct = computeTileInsight({
      status: 'ok',
      result: { columns: ['month', 'customers'], rows: [{ month: 'Jan', customers: 2 }, { month: 'Feb', customers: 2 }], rowCount: 2, executionTime: 1 },
    } as any);
    expect(distinct).not.toMatch(/%/);
  });

  it('keeps grouped Dataset insight at its displayed grain and uses governed percent metadata', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    const insight = computeTileInsight({
      status: 'ok',
      tileType: 'dataset',
      result: {
        columns: ['order_month', 'margin_rate'],
        columnsMeta: [{ name: 'margin_rate', kind: 'percent', unit: 'fraction', decimals: 1 }],
        rows: [
          { order_month: '2026-01-01', margin_rate: 0.6 },
          { order_month: '2026-02-01', margin_rate: 0.5 },
        ],
        rowCount: 2,
        executionTime: 4,
      },
    } as any, {
      i: 'monthly-margin', x: 0, y: 0, w: 6, h: 4,
      query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'margin_rate' }] },
      viz: { type: 'bar' },
    } as any);

    expect(insight).toContain('60%');
    expect(insight).toBe('Jan 2026 reports Margin Rate at 60%.');
    expect(insight).not.toContain('(55%)');
  });
});

describe('tile captions never treat a rank, an id or a year as the measure (0.1.0 re-test #1)', () => {
  const ranked = [
    { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534 },
    { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331 },
    { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252 },
    { rank: 4, player_name: 'Stephen Curry', points_2016: 2863, points_2017: 2388, total_points_2016_2017: 5251 },
    { rank: 5, player_name: 'Kevin Durant', points_2016: 2850, points_2017: 1985, total_points_2016_2017: 4835 },
  ];
  const tile = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    status: 'ok',
    result: { columns: Object.keys(rows[0]!), rows, rowCount: rows.length, executionTime: 1 },
    ...extra,
  }) as any;

  it('a ranked top-N table is led by the player ranked first, on the measure it ranks', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    const caption = computeTileInsight(tile(ranked));
    expect(caption).toMatch(/^James Harden is ranked first, with Total Points 2016 2017 at /);
    expect(caption).not.toMatch(/Rank at|Kevin Durant/);
    // Row order does not decide who leads.
    expect(computeTileInsight(tile([...ranked].reverse()))).toMatch(/^James Harden is ranked first/);
  });

  it('a declared measure is the one the caption reports', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    expect(computeTileInsight(tile(ranked, { declaredMeasures: ['points_2017'] }))).toMatch(/^James Harden is ranked first, with Points 2017 at /);
  });

  it('a rank and a name alone say who is ranked first, with no number', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    expect(computeTileInsight(tile(ranked.map(({ rank, player_name }) => ({ rank, player_name }))))).toBe('James Harden is ranked first.');
  });

  it('a table of only ids and years gets no caption', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    expect(computeTileInsight(tile([
      { player_id: 201935, season: 2016, game_year: 2017, team_code: 7 },
      { player_id: 2544, season: 2016, game_year: 2017, team_code: 3 },
    ]))).toBeNull();
  });
  it('a top 5 with no rank column is led on the measure its source orders by', async () => {
    const { computeTileInsight } = await dashboardHelpers();
    const top5 = ranked.map(({ player_name, total_points_2016_2017 }, index) => ({ player_name, total_points: total_points_2016_2017, games_played: 189 + index * 7 }));
    expect(computeTileInsight(tile(top5, { ordering: { kind: 'top_n', reason: 'order_limit', orderColumn: 'total_points', direction: 'desc' } })))
      .toMatch(/^James Harden leads Total Points at /);
    // A bottom N is led by its smallest value, and says so.
    expect(computeTileInsight(tile([...top5].reverse(), { ordering: { kind: 'top_n', reason: 'order_limit', orderColumn: 'total_points', direction: 'asc' } })))
      .toMatch(/^Kevin Durant is lowest, with Total Points at /);
  });
});

describe('Dashboard visualization vocabulary and icons (UI-004)', () => {
  it('gives every renderable chart type its own icon', async () => {
    const { iconForChartType } = await dashboardHelpers();
    // Ten of sixteen types used to fall through to the same bar glyph, and the
    // viz switcher renders one button per allowed type — so a single tile could
    // show a row of seven identical bar icons.
    const icons = CHART_TYPE_OPTIONS.map((option) => {
      const element = iconForChartType(option.value) as { type: unknown };
      return element.type;
    });
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('keeps every renderable chart type and falls back only for types it cannot draw', () => {
    for (const option of CHART_TYPE_OPTIONS) {
      expect(normalizeDashboardChartType(option.value)).toBe(option.value);
    }
    // Underscore and legacy spellings normalize rather than degrade.
    expect(normalizeDashboardChartType('stacked_bar')).toBe('stacked-bar');
    expect(normalizeDashboardChartType('single_value')).toBe('kpi');
    // The client has no renderer for these, so `table` is the honest fallback.
    expect(normalizeDashboardChartType('pivot')).toBe('table');
    expect(normalizeDashboardChartType('map')).toBe('table');
  });
});

describe('Stakeholder view hides review-required pins, edit mode does not (UI-018)', () => {
  const pinItem = { i: 'ai-pin-1', x: 0, y: 0, w: 6, h: 3, aiPin: { id: 'pin-1' }, viz: { type: 'table' }, title: 'Revenue by region' };
  const blockItem = { i: 'revenue', x: 0, y: 3, w: 6, h: 3, block: { blockId: 'Total Revenue' }, viz: { type: 'kpi' }, title: 'Revenue' };

  it('filters an unreviewed pin out of the stakeholder view', async () => {
        const results = new Map([['ai-pin-1', { tileId: 'ai-pin-1', status: 'ok', tileType: 'aiPin', aiPin: { certification: 'ai_generated', reviewStatus: 'needs_review' } }]] as never);
    const visible = prepareStakeholderItems([pinItem, blockItem] as never, results as never, 12);
    expect(visible.map((item) => item.i)).toEqual(['revenue']);
  });

  it('keeps a certified pin in the stakeholder view', async () => {
        const results = new Map([['ai-pin-1', { tileId: 'ai-pin-1', status: 'ok', tileType: 'aiPin', aiPin: { certification: 'certified', reviewStatus: 'certified' } }]] as never);
    const visible = prepareStakeholderItems([pinItem, blockItem] as never, results as never, 12);
    // Adding a certified result must not vanish from the page it was added to.
    expect(visible.map((item) => item.i).sort()).toEqual(['ai-pin-1', 'revenue']);
  });

  it('keeps the author placement and closes the gap a hidden tile leaves (RFC 0008 step 5)', () => {
    const tile = (i: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({ i, x, y, w, h, title: i, viz: { type: 'bar' }, ...extra });
    const items = [
      tile('chart', 0, 0, 8, 4, { block: { blockId: 'b1' } }),
      tile('kpi', 8, 0, 4, 2, { block: { blockId: 'b2' } }),
      tile('pin', 0, 4, 12, 3, { aiPin: { question: 'q' } }),
      tile('table', 0, 7, 12, 3, { block: { blockId: 'b3' } }),
    ];
    const results = new Map([['pin', { tileId: 'pin', status: 'ok', tileType: 'aiPin', aiPin: { certification: 'ai_generated', reviewStatus: 'needs_review' } }]] as never);
    const visible = prepareStakeholderItems(items as never, results as never, 12);
    expect(visible.map((item) => [item.i, item.x, item.y, item.w, item.h])).toEqual([
      ['chart', 0, 0, 8, 4],
      ['kpi', 8, 0, 4, 2],
      ['table', 0, 4, 12, 3],
    ]);
  });
});

describe('Reader tile CSV download', () => {
  it('writes the settled columns in order and quotes commas, quotes, and line breaks', async () => {
    const { resultToCsv } = await dashboardHelpers();
    expect(resultToCsv({
      columns: ['region', 'revenue', 'note'],
      rows: [
        { region: 'US', revenue: 70, note: 'north, east' },
        { region: 'CA', revenue: null, note: 'said "hi"\nthen left' },
      ],
    })).toBe('region,revenue,note\nUS,70,"north, east"\nCA,,"said ""hi""\nthen left"');
  });
});

describe('App story wording follows source trust (F2)', () => {
  it('says verified only when every source behind the story is certified', async () => {
    const { storySourceChipLabel } = await dashboardHelpers();
    expect(storySourceChipLabel({ generatedBy: 'deterministic', trustState: 'certified' })).toBe('Verified result summary');
    expect(storySourceChipLabel({ generatedBy: 'deterministic', trustState: 'review_required' })).toBe('Result summary · some sources not certified yet');
    expect(storySourceChipLabel({ generatedBy: 'ai', trustState: 'review_required' })).not.toMatch(/verified/i);
  });
});
