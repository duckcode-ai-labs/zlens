import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppBuildProposal, AppBuildProposalTile, DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { unbuildableSelectedTiles } from './AppBuildProposalPanel';
import {
  addDashboardFilterToDocument,
  dashboardFilterCandidates,
  dashboardFilterCoverage,
  deriveDashboardFilters,
  removeDashboardFilterFromDocument,
} from './dashboard-filters';
import { semanticApprovalState } from './app-semantic-approval';
import { appCertificationRollup, appLifecycleLabel } from './app-certification';

type RuntimeFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number] & {
  sourceBlockId?: string;
};

function dashboardWithItem(item: DashboardDocumentResponse['dashboard']['layout']['items'][number]): DashboardDocumentResponse['dashboard'] {
  return {
    version: 1,
    id: 'overview',
    metadata: { title: 'Overview' },
    filters: [{ id: 'category', type: 'string', default: 'Beverage' }],
    layout: { kind: 'grid', cols: 12, rowHeight: 32, items: [item] },
  };
}

describe('App dashboard filter wiring (UI-001, E2E-001)', () => {
  it('keeps a block parameter as an input instead of probing it as an output column', () => {
    const [filter] = deriveDashboardFilters(dashboardWithItem({
      i: 'parameter-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Runtime Parameter Acceptance' },
      viz: { type: 'table' },
      parameterBindings: [{
        param: 'category',
        source: 'dashboard_filter',
        filter: 'category',
        parameterType: 'string',
        default: 'Beverage',
      }],
    }));

    expect((filter as RuntimeFilter).sourceBlockId).toBeUndefined();
    expect(filter.bindsTo).toBeUndefined();
  });

  it('uses only a predicate binding as the source for categorical output options', () => {
    const [filter] = deriveDashboardFilters(dashboardWithItem({
      i: 'predicate-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Revenue by Category' },
      viz: { type: 'table' },
      filterBindings: [{ filter: 'category', binding: 'category_name', mode: 'predicate' }],
    }));

    expect((filter as RuntimeFilter).sourceBlockId).toBe('Revenue by Category');
    expect(filter.bindsTo).toBe('category_name');
  });

  it('keeps an option-less select when a governed predicate binding can resolve its options', () => {
    const dashboard = dashboardWithItem({
      i: 'customer-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Customer profile' },
      viz: { type: 'table' },
      filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' }],
    });
    dashboard.filters = [{ id: 'customer_name', label: 'Customer Name', type: 'select', bindsTo: 'customer_name' }];

    const [filter] = deriveDashboardFilters(dashboard);

    expect(filter).toMatchObject({ id: 'customer_name', sourceBlockId: 'Customer profile' });
  });

  it('keeps a persisted v3 App Dataset filter with a distinct option source visible in a saved viewer', async () => {
    // This is the persisted published-App shape: no static options or legacy
    // sourceBlockId, an exact Dataset binding for Revenue by Region, and an
    // explicit empty binding that leaves the monthly tile at its full scope.
    const dashboard = {
      version: 3,
      id: 'overview',
      metadata: { title: 'Overview' },
      datasets: [
        { id: 'dataset_orders', sourceId: 'source.orders', sourceRevision: 'source-v1', snapshotId: 'snapshot-v1', contractFingerprint: 'contract-orders' },
        { id: 'dataset_monthly', sourceId: 'source.monthly', sourceRevision: 'source-v1', snapshotId: 'snapshot-v1', contractFingerprint: 'contract-monthly' },
      ],
      filters: [{
        id: 'region', label: 'Region', type: 'select', bindsTo: 'region', field: { name: 'region' },
        scope: { app: true },
        datasetBindings: {
          dataset_orders: { field: 'region', tileIds: ['revenue-by-region'] },
          dataset_monthly: { field: 'region', tileIds: [] },
        },
        optionSource: { mode: 'distinct_query', field: 'region', limit: 100 },
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          {
            i: 'revenue-by-region', x: 0, y: 0, w: 6, h: 4, title: 'Revenue by Region',
            sourceId: 'source.orders', sourceRevision: 'source-v1',
            query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' },
          },
          {
            i: 'monthly-revenue', x: 6, y: 0, w: 6, h: 4, title: 'Monthly Revenue',
            sourceId: 'source.monthly', sourceRevision: 'source-v1',
            query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' },
          },
        ],
      },
    } as unknown as DashboardDocumentResponse['dashboard'];

    const filters = deriveDashboardFilters(dashboard);
    expect(filters).toEqual([expect.objectContaining({
      id: 'region',
      scope: { app: true },
      optionSource: { mode: 'distinct_query', field: 'region', limit: 100 },
      datasetBindings: expect.objectContaining({
        dataset_orders: { field: 'region', tileIds: ['revenue-by-region'] },
        dataset_monthly: { field: 'region', tileIds: [] },
      }),
    })]);
    // AppWorkspaceSurface calls this exact helper before it renders the saved
    // viewer control. A persisted Dataset filter must reach the control row
    // even without static options or a legacy block id.
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const { DashboardFilterControls } = await import('./app-dashboard-filters');
    const markup = renderToStaticMarkup(createElement(DashboardFilterControls, {
      filters,
      values: {},
      onChange: () => undefined,
    }));
    expect(markup).toContain('aria-label="Region"');
    expect(markup).toContain('placeholder="Region"');
    expect(dashboardFilterCoverage(dashboard, 'region')).toMatchObject({
      applied: ['revenue-by-region'],
      unaffected: [expect.objectContaining({
        tileId: 'monthly-revenue',
        reason: 'Excluded by this filter’s linked-component selection.',
      })],
    });
  });

  it('adds and removes a manual page filter together with its proven tile binding', () => {
    const dashboard = dashboardWithItem({
      i: 'customer-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Customer profile' },
      viz: { type: 'table' },
    });
    dashboard.filters = [];
    const added = addDashboardFilterToDocument(dashboard, 'customer_type', {
      tiles: [{
        tileId: 'customer-tile',
        filterableColumns: [{ column: 'customer_type', predicateTarget: 'customer_type' }],
      }],
    });

    expect(added.filters).toContainEqual({ id: 'customer_type', type: 'select', bindsTo: 'customer_type' });
    expect(added.layout.items[0].filterBindings).toContainEqual({
      filter: 'customer_type',
      binding: 'customer_type',
      mode: 'predicate',
    });
    expect(dashboardFilterCoverage(added, 'customer_type').applied).toEqual(['customer-tile']);

    const removed = removeDashboardFilterFromDocument(added, 'customer_type');
    expect(removed.filters).toEqual([]);
    expect(removed.layout.items[0].filterBindings).toEqual([]);
  });
});

describe('Parameter filter coverage (F6)', () => {
  it('counts a tile whose block parameter a page control drives, after a run too', () => {
    const dashboard: DashboardDocumentResponse['dashboard'] = {
      version: 1,
      id: 'overview',
      metadata: { title: 'Business Overview' },
      filters: [{ id: 'season', type: 'select', bindsTo: 'game_date_est.year' }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 32,
        items: [
          {
            i: 'codex-scorers', x: 0, y: 0, w: 6, h: 4,
            block: { blockId: 'Codex Top Scorers' },
            viz: { type: 'table' },
            filterBindings: [{ filter: 'season', binding: 'game_date_est.year', unsupportedReason: 'No matching certified block parameter or allowed filter was declared.' }],
          },
          {
            i: 'top-players', x: 6, y: 0, w: 6, h: 4,
            block: { blockId: 'Top Players By Total Points 2016 2017' },
            viz: { type: 'bar' },
            parameterBindings: [
              { param: 'season_start', source: 'variable', field: 'season_start' },
              { param: 'season_end', source: 'variable', field: 'season_end' },
              { param: 'top_n', source: 'variable', field: 'top_n' },
            ],
          },
        ],
      },
    } as DashboardDocumentResponse['dashboard'];
    const run = { tiles: [{ tileId: 'codex-scorers', filterableColumns: [{ column: 'player_name' }] }, { tileId: 'top-players', filterableColumns: [] }] };
    for (const filterId of ['season_start', 'season_end', 'top_n']) {
      const coverage = dashboardFilterCoverage(dashboard, filterId, run);
      expect(coverage.applied).toEqual(['top-players']);
      expect(coverage.unaffected.map((tile) => tile.tileId)).toEqual(['codex-scorers']);
      expect(coverage.filterable).toBe(2);
    }
  });
});

describe('Published Dataset filter presentation (APP-066)', () => {
  it('uses settled Dataset runtime scope instead of legacy binding inference', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const { canAskDatasetChart, dashboardTileFilterNotices } = await import('./DashboardRenderer');
    const sourceId = 'app:block:commerce:a04df7dc095ea53854d5';
    const sourceRevision = 'sha256:8d04284976bfc83fb38838aa2cb988bb71430763cb05f1f4e79a4ac52b5ba609';
    const linkedItem = {
      i: 'component-1', title: 'Revenue by Region', x: 0, y: 0, w: 6, h: 4,
      sourceId, sourceRevision,
      query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      viz: { type: 'bar' },
      // Persisted Dataset mappings live on dashboard.filters.datasetBindings,
      // so this deliberate empty legacy list must not imply an unfiltered tile.
      filterBindings: [],
    } as DashboardDocumentResponse['dashboard']['layout']['items'][number];
    const linkedTile = {
      tileId: 'component-1', tileType: 'dataset', status: 'ok',
      result: { columns: ['region', 'revenue'], rows: [{ region: 'CA', revenue: 60 }], rowCount: 1 },
      dataset: {
        sourceId, sourceRevision,
        appliedFilters: [{ field: 'region', op: 'eq', values: ['CA'] }],
        unboundFilters: [],
      },
    } as DashboardRunResponse['tiles'][number];
    const linked = dashboardTileFilterNotices({
      item: linkedItem,
      tile: linkedTile,
      activeVariables: { region: ['CA'] },
    });
    expect(linked).toEqual({ unfilteredNotice: null, datasetUnboundNotices: [] });
    // The filter run still has a real settled Dataset envelope and its
    // server-issued run id, so the existing Ask affordance stays available.
    expect(canAskDatasetChart(linkedTile, false, 'app_run_ca', true)).toBe(true);

    const excluded = dashboardTileFilterNotices({
      item: {
        ...linkedItem,
        i: 'order-lines-dataset-chart',
        title: 'Monthly Revenue',
        query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
      },
      tile: {
        ...linkedTile,
        tileId: 'order-lines-dataset-chart',
        result: { columns: ['order_date_month', 'revenue'], rows: [{ order_date_month: '2026-01-01', revenue: 60 }], rowCount: 3 },
        dataset: {
          ...(linkedTile.dataset ?? {}),
          appliedFilters: [],
          unboundFilters: [{
            filterId: 'region',
            code: 'DATASET_TILE_EXCLUDED',
            message: 'Region is excluded from Monthly Revenue by this filter’s linked-component selection.',
          }],
        },
      } as never,
      activeVariables: { region: ['CA'] },
    });
    expect(excluded.unfilteredNotice).toBeNull();
    expect(excluded.datasetUnboundNotices).toEqual([expect.objectContaining({
      filterId: 'region',
      code: 'DATASET_TILE_EXCLUDED',
    })]);
  });
});

describe('App semantic repair approval (AGT-023, UI-018)', () => {
  it('does not treat an AI-repaired semantic preview as governed approval evidence', () => {
    const run = {
      tiles: [{
        tileId: 'semantic-revenue',
        status: 'ok',
        tileType: 'semantic',
        repair: {
          version: 1,
          status: 'repaired',
          source: 'semantic_query',
          mode: 'ai',
          attemptedAt: '2026-08-02T00:00:00.000Z',
          originalFailure: 'Column not found.',
          approvalEligible: false,
          message: 'AI repair completed; review required.',
        },
      }],
    } as never;

    expect(semanticApprovalState(['semantic-revenue'], run)).toEqual({
      ready: false,
      repairedTileIds: ['semantic-revenue'],
    });
    const unrepairedRun = {
      tiles: [{ tileId: 'semantic-revenue', status: 'ok', tileType: 'semantic' }],
    } as never;
    expect(semanticApprovalState(['semantic-revenue'], unrepairedRun)).toEqual({ ready: true, repairedTileIds: [] });
  });
});

describe('Dataset chart answer presentation (APP-066)', () => {
  it('renders an exact current-chart answer and keeps interaction evidence non-publishable', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const { DatasetChartAnswerPanel, datasetChartAnswerRequest } = await import('./AppsView');
    const onAsk = vi.fn();
    // The form helper is used by the panel itself, so a caller can vary only
    // the question — never the selected server-issued chart identity.
    expect(datasetChartAnswerRequest(
      { runId: 'app_run_current', tileId: 'monthly-revenue' },
      '  What was the highest month?  ',
    )).toEqual({
      runId: 'app_run_current',
      tileId: 'monthly-revenue',
      question: 'What was the highest month?',
    });
    const markup = renderToStaticMarkup(createElement(DatasetChartAnswerPanel, {
      answer: {
        runId: 'app_run_current', tileId: 'monthly-revenue', state: 'ready',
        answer: {
          ok: true,
          route: 'dataset_chart_answer',
          answerMode: 'deterministic_context_summary',
          answer: 'Monthly revenue is a certified Dataset chart. It returned 3 rows; the first row is revenue = 60. Its effective scope is the full Dataset result. Region is explicitly excluded from this tile, so that filter does not narrow these rows. This is a scoped interaction result and cannot be used as App publication evidence.',
          trustState: 'certified', reviewStatus: 'certified', citations: [{ kind: 'dataset_query', name: 'Orders Dataset' }], followUps: [],
          decision: { mode: 'answer', reason: 'current result', nextAction: 'rerun', requiresContext: false, usesCertifiedResult: false, confidence: 0.9 },
          analyticalContext: {
            version: 1, appId: 'commerce', dashboardId: 'overview', tileId: 'monthly-revenue', runId: 'app_run_current', evidenceScope: 'interaction', snapshotId: 'snapshot', dashboardFingerprint: 'sha256:dashboard',
            source: { sourceId: 'source.orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract', lifecycle: 'certified', trust: 'certified', label: 'Orders Dataset' },
            authoredQueryFingerprint: 'sha256:authored', executionQueryFingerprint: 'sha256:query', filterFingerprint: 'sha256:filter', parameterFingerprint: 'sha256:params', interactionFingerprint: 'sha256:interaction', executionFingerprint: 'sha256:execution', resultFingerprint: 'sha256:result', schemaFingerprint: 'sha256:schema', personaPolicyFingerprint: 'sha256:persona',
          },
        },
      },
      onAsk,
      onClose: () => undefined,
    }));
    expect(markup).toContain('About this chart');
    expect(markup).toContain('Region is explicitly excluded');
    expect(markup).toContain('Scoped interaction evidence');
    expect(markup).toContain('not publishable');
    expect(markup).toContain('Orders Dataset');
    expect(markup).toContain('Ask about this chart');
    expect(markup).toContain('Deterministic context summary');
  });
});

describe('Build Brief: tiles App Studio will not build', () => {
  const proposal = (target: 'personal' | 'shared_project', tiles: Array<Partial<AppBuildProposalTile>>) => ({
    intent: { target, initialVisibility: 'private' as const },
    tiles: tiles.map((tile, index) => ({
      id: `t${index}`, source: 'ai_generated', title: `Tile ${index}`, viz: 'table',
      certification: 'ai_generated', sourceClass: 'exploratory_analysis', reviewStatus: 'required',
      preflight: { status: 'passed' }, selectedByDefault: true, ...tile,
    })),
    gaps: [], followUps: [],
    coverage: { certifiedTiles: 0, semanticTiles: 0, generatedTiles: tiles.length, gaps: 0 },
  } as unknown as AppBuildProposal);
  const all = (p: AppBuildProposal) => new Set(p.tiles.map((tile) => tile.id));

  it('lists an AI tile with no query under Not covered yet rather than as a tile', () => {
    const p = proposal('personal', [{ title: 'What is the decision story behind this?' }]);
    const [first, ...rest] = unbuildableSelectedTiles(p, all(p));
    expect(rest).toEqual([]);
    expect(first?.title).toBe('What is the decision story behind this?');
    expect(first?.reason).toMatch(/nothing to show/i);
    expect(first?.reason).toMatch(/Not covered yet/);
  });

  it('never adds Draft SQL to an App, in a Personal Draft or a Shared Project, and names the way forward', () => {
    for (const target of ['personal', 'shared_project'] as const) {
      const p = proposal(target, [{ title: 'Revenue by region', sql: 'select 1' }]);
      expect(unbuildableSelectedTiles(p, all(p))[0]?.reason).toMatch(/Draft SQL is not added to an App.*Not covered yet.*draft DQL/);
    }
  });

  it('never flags a certified block, and never flags a tile the author deselected', () => {
    const certified = proposal('shared_project', [{ source: 'certified_block', blockId: 'revenue', title: 'Revenue' }]);
    expect(unbuildableSelectedTiles(certified, all(certified))).toEqual([]);

    const dropped = proposal('shared_project', [{ title: 'Revenue by region', sql: 'select 1' }]);
    expect(unbuildableSelectedTiles(dropped, new Set())).toEqual([]);
  });
});

describe('Global filters: coverage and candidates', () => {
  const dash = (items: Array<Record<string, unknown>>, filters: Array<Record<string, unknown>> = []) => ({
    id: 'overview', metadata: { title: 'Overview' },
    filters, layout: { items },
  } as unknown as DashboardDocumentResponse['dashboard']);

  it('reports the tiles a filter actually reaches, not the tiles that mention it', () => {
    // A tile can declare a binding and still be unable to apply it. Counting
    // those as covered is how a filter that narrows half a page looked total.
    const dashboard = dash([
      { i: 'a', title: 'Bound', viz: { type: 'bar' }, filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' }] },
      { i: 'b', title: 'Declared but unusable', viz: { type: 'line' }, filterBindings: [{ filter: 'customer_name', unsupportedReason: 'No matching column' }] },
      { i: 'c', title: 'Unaware', viz: { type: 'table' } },
    ], [{ id: 'customer_name', type: 'select', bindsTo: 'customer_name' }]);

    const coverage = dashboardFilterCoverage(dashboard, 'customer_name');
    expect(coverage.applied).toEqual(['a']);
    expect(coverage.filterable).toBe(3);
    expect(coverage.unaffected.map((tile) => tile.tileId)).toEqual(['b', 'c']);
    expect(coverage.unaffected[0]?.reason).toBe('No matching column');
  });

  it('does not count narrative tiles as missing a filter', () => {
    const dashboard = dash([
      { i: 'a', title: 'Chart', viz: { type: 'bar' }, filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate' }] },
      { i: 'note', title: 'Intro', viz: { type: 'text' }, text: { markdown: 'Hello' } },
      { i: 'head', title: 'Heading', viz: { type: 'heading' } },
    ], [{ id: 'region', type: 'select' }]);
    const coverage = dashboardFilterCoverage(dashboard, 'region');
    expect(coverage.filterable).toBe(1);
    expect(coverage.unaffected).toEqual([]);
  });

  it('keeps an explicitly excluded Dataset component in coverage with its exclusion reason', () => {
    const dashboard = dash([
      {
        i: 'revenue', title: 'Revenue', sourceId: 'source:orders', sourceRevision: 'source-v1', viz: { type: 'kpi' },
        query: { dimensions: [], measures: [{ measure: 'revenue' }] },
      },
      {
        i: 'monthly-revenue', title: 'Monthly Revenue', sourceId: 'source:orders', sourceRevision: 'source-v1', viz: { type: 'bar' },
        query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
      },
    ], [{
      id: 'region', type: 'select', scope: { app: true },
      datasetBindings: { orders: { field: 'region', tileIds: ['revenue'] } },
    }]);
    (dashboard as { datasets?: unknown[] }).datasets = [{
      id: 'orders', sourceId: 'source:orders', sourceRevision: 'source-v1', snapshotId: 'snapshot-v1', contractFingerprint: 'contract-v1',
    }];

    const coverage = dashboardFilterCoverage(dashboard, 'region');
    expect(coverage.applied).toEqual(['revenue']);
    expect(coverage.unaffected).toEqual([{
      tileId: 'monthly-revenue',
      title: 'Monthly Revenue',
      reason: 'Excluded by this filter’s linked-component selection.',
    }]);
  });

  it('offers only the columns the server proved filterable, ranked by reach', () => {
    // The candidate list must come from the server's SQL parse. Guessing from
    // result column names would offer an aggregate output, and filtering that
    // in WHERE changes the measure instead of narrowing it.
    const run = { tiles: [
      { filterableColumns: [{ column: 'customer_name', predicateTarget: 'c.customer_name' }, { column: 'region', predicateTarget: 'c.region' }],
        result: { columns: ['customer_name', 'region', 'revenue'], rows: [{ customer_name: 'Acme', region: 'EMEA', revenue: 10 }] } },
      { filterableColumns: [{ column: 'region', predicateTarget: 'o.region' }],
        result: { columns: ['region', 'revenue'], rows: [{ region: 'AMER' }] } },
      // No filterableColumns: an aggregate-only tile the server refused to offer.
      { result: { columns: ['total_revenue'], rows: [{ total_revenue: 99 }] } },
    ] };
    const candidates = dashboardFilterCandidates(dash([]), run);
    expect(candidates.map((candidate) => candidate.column)).toEqual(['region', 'customer_name']);
    expect(candidates[0]?.tiles).toBe(2);
    expect(candidates.some((candidate) => candidate.column === 'revenue')).toBe(false);
    expect(candidates.some((candidate) => candidate.column === 'total_revenue')).toBe(false);
    expect(candidates[1]?.sampleValues).toContain('Acme');
  });

  it('never re-offers a column that is already a page filter', () => {
    const run = { tiles: [
      { filterableColumns: [{ column: 'region', predicateTarget: 'region' }], result: { columns: ['region'], rows: [] } },
    ] };
    expect(dashboardFilterCandidates(dash([], [{ id: 'region', type: 'select' }]), run)).toEqual([]);
  });
});

describe('Coverage for a filter the author never declared', () => {
  const dash = (items: Array<Record<string, unknown>>, filters: Array<Record<string, unknown>> = []) => ({
    id: 'overview', metadata: { title: 'Overview' }, filters, layout: { items },
  } as unknown as DashboardDocumentResponse['dashboard']);

  it('derives reach from the tiles that offered the column', () => {
    // A viewer-chosen column has no filterBindings anywhere, so reading only the
    // document reported "reaches no tile" right before the page filtered fine.
    const dashboard = dash([
      { i: 'a', title: 'Profiles', viz: { type: 'table' } },
      { i: 'b', title: 'Revenue', viz: { type: 'line' } },
    ]);
    const run = { tiles: [
      { tileId: 'a', filterableColumns: [{ column: 'customer_type', predicateTarget: 'c.customer_type' }] },
      { tileId: 'b', filterableColumns: [] },
    ] };
    const coverage = dashboardFilterCoverage(dashboard, 'customer_type', run);
    expect(coverage.applied).toEqual(['a']);
    expect(coverage.unaffected.map((tile) => tile.tileId)).toEqual(['b']);
  });

  it('still uses the declared bindings when the filter is on the document', () => {
    const dashboard = dash(
      [{ i: 'a', title: 'Profiles', viz: { type: 'table' }, filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate' }] }],
      [{ id: 'region', type: 'select' }],
    );
    // The run disagrees; the author's declaration wins for a declared filter.
    const coverage = dashboardFilterCoverage(dashboard, 'region', { tiles: [{ tileId: 'a', filterableColumns: [] }] });
    expect(coverage.applied).toEqual(['a']);
  });
});

describe('the app header badge is the one aggregate page trust, from the current run', () => {
  type Tile = DashboardDocumentResponse['dashboard']['layout']['items'][number];
  type Run = DashboardRunResponse['tiles'][number];
  const tile = (i: string, extra: Partial<Tile>): Tile => ({ i, x: 0, y: 0, w: 4, h: 4, viz: { type: 'table' }, ...extra } as Tile);
  const ran = (tileId: string, extra: Partial<Run> = {}): Run => ({ tileId, status: 'ok', ...extra } as Run);

  it('never says certified from the saved document alone: before a run, trust is not checked yet', () => {
    const items = [tile('a', { block: { blockId: 'b1' } }), tile('b', { block: { blockId: 'b2' }, sourceClass: 'certified_block', trustState: 'certified' })];
    expect(appCertificationRollup(items)).toMatchObject({ state: 'pending', allCertified: false, label: 'Trust not checked yet' });
    // An empty dashboard certifies nothing.
    expect(appCertificationRollup([], 0, [])).toMatchObject({ certified: 0, total: 0, allCertified: false });
  });

  it('F2: a draft block tile that ran as Needs review makes the header say 0 of 1, never All certified', () => {
    // The fixture App: one bare block reference to a `_drafts` block.
    const items = [tile('top-5', { block: { ref: 'blocks/_drafts/top_5_players_points_2016_2017.dql' } as never })];
    const run = [ran('top-5', { certificationStatus: null, trustState: 'review_required', artifact: { trustState: 'review_required', sourceKind: 'review_block' } } as never)];
    const rollup = appCertificationRollup(items, 0, run);
    expect(rollup).toMatchObject({ certified: 0, total: 1, allCertified: false, state: 'review', label: '0 of 1 tile certified' });
  });

  it('says All tiles certified only when every data tile ran from a certified source and no App change is pending (T2)', () => {
    const items = [tile('a', { block: { blockId: 'b1' } }), tile('b', { block: { blockId: 'b2' } }), tile('c', { text: { markdown: 'Summary' } })];
    const certifiedRun = [ran('a', { certificationStatus: 'certified' }), ran('b', { trustState: 'certified' } as never)];
    expect(appCertificationRollup(items, 0, certifiedRun)).toMatchObject({ certified: 2, total: 2, allCertified: true, label: 'All tiles certified' });
    // A pending App change is named as one, never as a trust word.
    expect(appCertificationRollup(items, 1, certifiedRun)).toMatchObject({ allCertified: false, label: 'All tiles certified · 1 unpublished change' });
    // One tile that is not certified is enough.
    const mixed = [ran('a', { certificationStatus: 'certified' }), ran('b', { trustState: 'review_required' } as never)];
    expect(appCertificationRollup(items, 0, mixed)).toMatchObject({ certified: 1, total: 2, allCertified: false, state: 'partial', label: '1 of 2 tiles certified' });
    // A tile with no run evidence is not certified.
    expect(appCertificationRollup(items, 0, [ran('a', { certificationStatus: 'certified' })]).allCertified).toBe(false);
    // An AI pin is certified only when a person certified it.
    const pinned = [tile('p', { aiPin: { id: 'pin-1' } as never })];
    expect(appCertificationRollup(pinned, 0, [ran('p', { aiPin: { certification: 'review_required' } } as never)]).allCertified).toBe(false);
  });

  it('labels a library card with no stored count in the two words, never "App certified" (T2)', () => {
    expect(appLifecycleLabel('draft', false, 0)).toBe('Not certified yet');
    expect(appLifecycleLabel('review', false, 2)).toBe('Not certified yet · 2 unpublished changes');
    expect(appLifecycleLabel(undefined, true, 0)).toBe('All tiles certified');
    expect(appLifecycleLabel('deprecated', false, 0)).toBe('Retired');
  });
});
