import { describe, it, expect } from 'vitest';
import {
  parseDashboardDocument,
  extractDashboardBlockRefs,
  isBlockIdRef,
  type DashboardDocument,
} from './dashboard-document.js';

const minimal: DashboardDocument = {
  version: 1,
  id: 'weekly-overview',
  metadata: { title: 'Weekly Overview' },
  layout: {
    kind: 'grid',
    cols: 12,
    rowHeight: 80,
    items: [
      {
        i: 'kpi',
        x: 0, y: 0, w: 3, h: 2,
        block: { blockId: 'revenue_total' },
        viz: { type: 'single_value' },
      },
      {
        i: 'trend',
        x: 3, y: 0, w: 9, h: 4,
        block: { ref: 'blocks/revenue_trend.dql' },
        viz: { type: 'line' },
      },
    ],
  },
};

describe('the auto-written Summary (D6)', () => {
  it('is off unless the author added it, and old pages stay unchanged', () => {
    expect(parseDashboardDocument(JSON.stringify(minimal)).document?.metadata).toEqual({ title: 'Weekly Overview' });
    expect(parseDashboardDocument(JSON.stringify({ ...minimal, metadata: { title: 'W', summary: true } })).document?.metadata.summary).toBe(true);
    expect(parseDashboardDocument(JSON.stringify({ ...minimal, metadata: { title: 'W', summary: 'yes' } })).document?.metadata).not.toHaveProperty('summary');
  });
});

describe('parseDashboardDocument', () => {
  it('parses both blockId and ref forms', () => {
    const { document, errors } = parseDashboardDocument(JSON.stringify(minimal));
    expect(errors).toEqual([]);
    expect(document?.layout.items).toHaveLength(2);
    // Docs without sections stay section-free (old dashboards unaffected).
    expect(document?.sections).toBeUndefined();
    expect(document?.layout.items.every((item) => item.sectionId === undefined)).toBe(true);
  });

  it('round-trips story sections and tile section membership', () => {
    const story: DashboardDocument = {
      ...minimal,
      sections: [
        { id: 'exec_summary', title: 'Executive summary', kind: 'exec_summary', narrative: 'Revenue is up 12%.', order: 0 },
        { id: 'kpi_band', title: 'Key metrics', kind: 'kpi_band', order: 1 },
        { id: 'appendix', title: 'AI-generated analysis — needs review', kind: 'appendix', order: 2 },
      ],
      layout: {
        ...minimal.layout,
        items: minimal.layout.items.map((item, index) => ({
          ...item,
          sectionId: index === 0 ? 'kpi_band' : 'appendix',
        })),
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(story));
    expect(errors).toEqual([]);
    expect(document?.sections).toHaveLength(3);
    expect(document?.sections?.[0]).toMatchObject({ id: 'exec_summary', kind: 'exec_summary', narrative: 'Revenue is up 12%.', order: 0 });
    expect(document?.layout.items[0]?.sectionId).toBe('kpi_band');
    expect(document?.layout.items[1]?.sectionId).toBe('appendix');
    // Full round-trip: serialize the parsed doc and parse again.
    const again = parseDashboardDocument(JSON.stringify(document));
    expect(again.errors).toEqual([]);
    expect(again.document?.sections).toEqual(document?.sections);
  });

  it('skips malformed sections instead of failing the dashboard', () => {
    const messy = {
      ...minimal,
      sections: [
        { id: 'ok', title: 'Fine', kind: 'insight', order: 0 },
        { id: '', title: 'missing id', kind: 'insight' },
        { id: 'bad-kind', title: 'nope', kind: 'hero' },
        'not-an-object',
      ],
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(messy));
    expect(errors).toEqual([]);
    expect(document?.sections).toHaveLength(1);
    expect(document?.sections?.[0]?.id).toBe('ok');
  });

  it('parses OSS metadata and notebook-style chart options', () => {
    const doc = {
      ...minimal,
      metadata: {
        title: 'Weekly Overview',
        domain: 'cards',
        subdomain: 'fraud',
        groups: ['daily-ops'],
        audience: 'ops',
        visibility: 'shared',
        lifecycle: 'review',
      },
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'scatter',
            x: 0, y: 0, w: 6, h: 3,
            block: { blockId: 'fraud_points' },
            viz: { type: 'scatter', options: { chart: 'scatter', x: 'risk_score', y: 'amount', color: 'merchant' } },
          },
        ],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.metadata.subdomain).toBe('fraud');
    expect(document?.metadata.groups).toEqual(['daily-ops']);
    expect(document?.layout.items[0].viz.options?.chart).toBe('scatter');
  });

  it('round-trips v2 responsive layouts and qualified filter controls', () => {
    const doc: DashboardDocument = {
      ...minimal,
      version: 2,
      filters: [{
        id: 'order-period',
        label: 'Order period',
        type: 'relative_date',
        bindsTo: 'ordered_at',
        field: { name: 'ordered_at', relation: 'analytics.orders', provider: 'duckdb' },
        required: true,
        scope: { page: 'weekly-overview', tileIds: ['kpi', 'trend'] },
        optionSource: { mode: 'distinct_query', sourceRef: 'analytics.orders', field: 'ordered_at', snapshotId: 'snapshot-1', limit: 100 },
        dependsOn: ['region'],
      }],
      layout: {
        ...minimal.layout,
        responsive: {
          medium: { kind: 'grid', cols: 6, rowHeight: 80, items: minimal.layout.items },
          narrow: {
            kind: 'grid', cols: 1, rowHeight: 80,
            items: minimal.layout.items.map((item, y) => ({ ...item, x: 0, y, w: 1 })),
          },
        },
      },
    };

    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));

    expect(errors).toEqual([]);
    expect(document?.version).toBe(2);
    expect(document?.filters?.[0]).toMatchObject({
      label: 'Order period',
      type: 'relative_date',
      field: { name: 'ordered_at', relation: 'analytics.orders' },
      required: true,
      scope: { page: 'weekly-overview', tileIds: ['kpi', 'trend'] },
      optionSource: { mode: 'distinct_query', snapshotId: 'snapshot-1' },
    });
    expect(document?.layout.responsive?.medium?.cols).toBe(6);
    expect(document?.layout.responsive?.narrow?.items[1]).toMatchObject({ x: 0, y: 1, w: 1 });
  });

  it('accepts field Dataset bindings only in v3 while preserving legacy navigation', () => {
    const fieldDatasetDocument = {
      id: 'dataset-overview',
      metadata: { title: 'Dataset Overview' },
      datasets: [{
        id: 'orders',
        sourceId: 'source.orders',
        sourceRevision: 'source.v1',
        snapshotId: 'snapshot.v1',
        contractFingerprint: 'contract.v1',
      }],
      filters: [{
        id: 'region', type: 'select', datasetBindings: { orders: { field: 'region' } },
      }],
      interactions: {
        crossFilter: {
          mappings: [{ fromTileId: 'revenue-by-region', fromField: 'region', toDataset: 'orders', toField: 'region' }],
        },
        detail: { dataset: 'orders', columns: ['order_line_id'] },
        navigate: [{ fromTile: 'revenue-by-region', toPage: 'detail', carryFilters: ['region'] }],
      },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue-by-region', x: 0, y: 0, w: 6, h: 3,
          sourceId: 'source.orders', sourceRevision: 'source.v1',
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
          viz: { type: 'bar' },
        }],
      },
    };

    for (const version of [1, 2] as const) {
      const parsed = parseDashboardDocument(JSON.stringify({ ...fieldDatasetDocument, version }));
      expect(parsed.document).toBeNull();
      expect(parsed.errors.map((error) => error.message).join('\n')).toMatch(/require dashboard version 3/);
    }

    const v3 = parseDashboardDocument(JSON.stringify({ ...fieldDatasetDocument, version: 3 }));
    expect(v3.errors).toEqual([]);
    expect(v3.document?.version).toBe(3);

    const legacyNavigation = parseDashboardDocument(JSON.stringify({
      ...minimal,
      version: 2,
      interactions: { navigate: [{ fromTile: 'kpi', toPage: 'detail', carryFilters: [] }] },
    }));
    expect(legacyNavigation.errors).toEqual([]);
    expect(legacyNavigation.document?.interactions?.navigate).toHaveLength(1);
  });

  it('round-trips explicit legacy semantic conversion provenance without making it executable authority', () => {
    const provenance = {
      version: 1,
      kind: 'semantic_tile_conversion_provenance',
      legacyIdentityFingerprint: 'sha256:legacy-identity',
      legacyTileFingerprint: 'sha256:legacy-tile',
      legacyPayload: {
        semantic: {
          id: 'legacy-revenue',
          provider: 'native',
          metrics: ['revenue'],
        },
      },
      datasetId: 'orders',
      sourceRevision: 'source.v1',
      contractFingerprint: 'contract.v1',
      queryFingerprint: 'sha256:query',
      equivalenceProofFingerprint: 'sha256:equivalence',
      convertedAt: '2026-09-11T00:00:00.000Z',
    };
    const converted = {
      version: 3,
      id: 'converted-overview',
      metadata: { title: 'Converted overview' },
      datasets: [{
        id: 'orders',
        sourceId: 'source.orders',
        sourceRevision: 'source.v1',
        snapshotId: 'snapshot.v1',
        contractFingerprint: 'contract.v1',
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue', x: 0, y: 0, w: 4, h: 2,
          sourceId: 'source.orders', sourceRevision: 'source.v1',
          query: { dimensions: [], measures: [{ measure: 'revenue' }] },
          semanticTileConversionProvenance: provenance,
          viz: { type: 'kpi' },
        }],
      },
    };

    const parsed = parseDashboardDocument(JSON.stringify(converted));
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.layout.items[0]?.semanticTileConversionProvenance).toEqual(provenance);

    const roundTripped = parseDashboardDocument(JSON.stringify(parsed.document));
    expect(roundTripped.errors).toEqual([]);
    expect(roundTripped.document?.layout.items[0]?.semanticTileConversionProvenance).toEqual(provenance);

    const malformed = parseDashboardDocument(JSON.stringify({
      ...converted,
      layout: {
        ...converted.layout,
        items: [{
          ...converted.layout.items[0],
          semanticTileConversionProvenance: { version: 1, kind: 'semantic_tile_conversion_provenance' },
        }],
      },
    }));
    expect(malformed.document).toBeNull();
    expect(malformed.errors.map((error) => error.message).join('\n')).toContain('semanticTileConversionProvenance');
  });

  it('rejects Dataset field filter IDs that collide with dashboard parameters while retaining explicit source bindings', () => {
    const datasetPage = {
      version: 3,
      id: 'dataset-parameter-boundary',
      metadata: { title: 'Dataset parameter boundary' },
      datasets: [{
        id: 'orders',
        sourceId: 'source.orders',
        sourceRevision: 'source.v1',
        snapshotId: 'snapshot.v1',
        contractFingerprint: 'contract.v1',
      }],
      filters: [{
        id: 'region',
        type: 'select',
        datasetBindings: { orders: { field: 'region' } },
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue', x: 0, y: 0, w: 6, h: 3,
          sourceId: 'source.orders', sourceRevision: 'source.v1',
          query: { dimensions: [], measures: [{ measure: 'revenue' }] },
          viz: { type: 'kpi' },
        }],
      },
    };

    const collision = parseDashboardDocument(JSON.stringify({
      ...datasetPage,
      params: [{ id: 'region', type: 'string' }],
    }));
    expect(collision.document).toBeNull();
    expect(collision.errors.map((error) => error.message).join('\n')).toContain('params.region conflicts with filters.region');

    const explicitlyNamedSourceInput = parseDashboardDocument(JSON.stringify({
      ...datasetPage,
      params: [{ id: 'as_of', type: 'date' }],
      layout: {
        ...datasetPage.layout,
        items: datasetPage.layout.items.map((item) => ({
          ...item,
          parameterBindings: [{
            param: 'reviewed_region_parameter',
            source: 'dashboard_filter',
            filter: 'region',
          }],
        })),
      },
    }));
    expect(explicitlyNamedSourceInput.errors).toEqual([]);
    expect(explicitlyNamedSourceInput.document?.layout.items[0]?.parameterBindings).toEqual([{
      param: 'reviewed_region_parameter', source: 'dashboard_filter', filter: 'region',
    }]);

    const legacyOverlap = parseDashboardDocument(JSON.stringify({
      ...minimal,
      version: 2,
      params: [{ id: 'region', type: 'string' }],
      filters: [{ id: 'region', type: 'select' }],
    }));
    expect(legacyOverlap.errors).toEqual([]);
    expect(legacyOverlap.document?.version).toBe(2);
  });

  it('rejects a v3 Dataset scalar tile that would hide selected fields', () => {
    const base = {
      version: 3,
      id: 'dataset-scalar-contract',
      metadata: { title: 'Dataset scalar contract' },
      datasets: [{
        id: 'orders', sourceId: 'source.orders', sourceRevision: 'source.v1',
        snapshotId: 'snapshot.v1', contractFingerprint: 'contract.v1',
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
          sourceId: 'source.orders', sourceRevision: 'source.v1',
          query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
          viz: { type: 'single_value' },
        }],
      },
    };

    const multipleMeasures = parseDashboardDocument(JSON.stringify(base));
    expect(multipleMeasures.document).toBeNull();
    expect(multipleMeasures.errors.map((error) => error.message).join('\n')).toContain('exactly one selected measure');

    const grouped = parseDashboardDocument(JSON.stringify({
      ...base,
      layout: {
        ...base.layout,
        items: [{
          ...base.layout.items[0],
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
        }],
      },
    }));
    expect(grouped.document).toBeNull();
    expect(grouped.errors.map((error) => error.message).join('\n')).toContain('can group only by one date');
  });

  it('preserves exact Dataset component inclusions and rejects foreign tile references', () => {
    const document = {
      version: 3,
      id: 'dataset-component-scope',
      metadata: { title: 'Dataset component scope' },
      datasets: [
        { id: 'orders', sourceId: 'source.orders', sourceRevision: 'source.v1', snapshotId: 'snapshot.v1', contractFingerprint: 'contract.v1' },
        { id: 'customers', sourceId: 'source.customers', sourceRevision: 'customers.v1', snapshotId: 'snapshot.v1', contractFingerprint: 'customers.contract.v1' },
      ],
      filters: [{
        id: 'region', type: 'select', scope: { app: true },
        datasetBindings: { orders: { field: 'region', tileIds: ['revenue'] } },
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          {
            i: 'revenue', x: 0, y: 0, w: 6, h: 3,
            sourceId: 'source.orders', sourceRevision: 'source.v1',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] },
            viz: { type: 'kpi' },
          },
          {
            i: 'monthly-revenue', x: 6, y: 0, w: 6, h: 3,
            sourceId: 'source.orders', sourceRevision: 'source.v1',
            query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
            viz: { type: 'bar' },
          },
          {
            i: 'customer-revenue', x: 0, y: 3, w: 6, h: 3,
            sourceId: 'source.customers', sourceRevision: 'customers.v1',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] },
            viz: { type: 'kpi' },
          },
        ],
      },
    };

    const parsed = parseDashboardDocument(JSON.stringify(document));
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.filters?.[0]?.datasetBindings).toEqual({
      orders: { field: 'region', tileIds: ['revenue'] },
    });
    expect(parseDashboardDocument(JSON.stringify(parsed.document)).document?.filters?.[0]?.datasetBindings).toEqual({
      orders: { field: 'region', tileIds: ['revenue'] },
    });

    const legacyAllTiles = parseDashboardDocument(JSON.stringify({
      ...document,
      filters: [{ ...document.filters[0], datasetBindings: { orders: { field: 'region' } } }],
    }));
    expect(legacyAllTiles.errors).toEqual([]);
    expect(legacyAllTiles.document?.filters?.[0]?.datasetBindings).toEqual({ orders: { field: 'region' } });

    const explicitNone = parseDashboardDocument(JSON.stringify({
      ...document,
      filters: [{ ...document.filters[0], datasetBindings: { orders: { field: 'region', tileIds: [] } } }],
    }));
    expect(explicitNone.errors).toEqual([]);
    expect(explicitNone.document?.filters?.[0]?.datasetBindings).toEqual({ orders: { field: 'region', tileIds: [] } });

    const explicitUnboundPage = parseDashboardDocument(JSON.stringify({
      ...document,
      filters: [{ ...document.filters[0], datasetBindings: {} }],
    }));
    expect(explicitUnboundPage.errors).toEqual([]);
    expect(explicitUnboundPage.document?.filters?.[0]?.datasetBindings).toEqual({});
    expect(parseDashboardDocument(JSON.stringify(explicitUnboundPage.document)).document?.filters?.[0]?.datasetBindings).toEqual({});

    const unknownTile = parseDashboardDocument(JSON.stringify({
      ...document,
      filters: [{ ...document.filters[0], datasetBindings: { orders: { field: 'region', tileIds: ['missing'] } } }],
    }));
    expect(unknownTile.document).toBeNull();
    expect(unknownTile.errors.map((error) => error.message).join('\n')).toContain('references unknown tile missing');

    const foreignDatasetTile = parseDashboardDocument(JSON.stringify({
      ...document,
      filters: [{ ...document.filters[0], datasetBindings: { orders: { field: 'region', tileIds: ['customer-revenue'] } } }],
    }));
    expect(foreignDatasetTile.document).toBeNull();
    expect(foreignDatasetTile.errors.map((error) => error.message).join('\n')).toContain('does not resolve to that exact Dataset binding');
  });

  it('preserves Sankey source, target, and value bindings', () => {
    const doc = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'supply-flow',
          x: 0, y: 0, w: 8, h: 4,
          block: { blockId: 'supply_flow' },
          viz: { type: 'sankey', options: { chart: 'sankey', x: 'source', color: 'target', y: 'amount' } },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.layout.items[0].viz).toMatchObject({
      type: 'sankey',
      options: { chart: 'sankey', x: 'source', color: 'target', y: 'amount' },
    });
  });

  it('parses governed display metadata on dashboard tiles', () => {
    const doc = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'ranking',
            x: 0, y: 0, w: 8, h: 4,
            block: { blockId: 'top_scorers' },
            viz: { type: 'bar' },
            display: {
              mode: 'block_hint',
              component: 'RankingPanel',
              defaultVisualization: 'bar',
              allowedVisualizations: ['bar', 'table'],
              fieldHints: { label: 'player_name', value: 'total_points' },
              layoutIntent: 'wide',
              rationale: 'Consumer surface uses ranking view for NBA analysis.',
              trustState: 'certified',
              reviewStatus: 'certified',
            },
          },
        ],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.layout.items[0].display).toMatchObject({
      component: 'RankingPanel',
      allowedVisualizations: ['bar', 'table'],
      fieldHints: { label: 'player_name', value: 'total_points' },
    });
  });

  it('preserves app filter, parameter, evidence, and trust metadata on tiles', () => {
    const doc = {
      ...minimal,
      filters: [{ id: 'season', type: 'select', options: ['2016', '2017'], bindsTo: 'game_date_est' }],
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'scorers',
            x: 0, y: 0, w: 8, h: 4,
            block: { blockId: 'top_scorers' },
            viz: { type: 'bar' },
            filterBindings: [
              { filter: 'season', binding: 'game_date_est', mode: 'semantic', paramNames: ['season_year'], required: true, capability: 'preflight_required' },
            ],
            parameterBindings: [
              { param: 'season_year', source: 'dashboard_filter', filter: 'season', parameterType: 'number', required: true, default: 2017, policy: 'dynamic' },
            ],
            sourceEvidence: [
              { source: 'block:top_scorers', reason: 'Certified scorer ranking block.', kind: 'block', trustState: 'certified' },
            ],
            trustState: 'certified',
            reviewStatus: 'certified',
          },
        ],
      },
    };

    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));

    expect(errors).toEqual([]);
    expect(document?.layout.items[0]).toMatchObject({
      filterBindings: [{ filter: 'season', binding: 'game_date_est', mode: 'semantic', paramNames: ['season_year'], required: true, capability: 'preflight_required' }],
      parameterBindings: [{ param: 'season_year', source: 'dashboard_filter', filter: 'season', parameterType: 'number', required: true, default: 2017, policy: 'dynamic' }],
      sourceEvidence: [{ source: 'block:top_scorers', reason: 'Certified scorer ranking block.', kind: 'block', trustState: 'certified' }],
      trustState: 'certified',
      reviewStatus: 'certified',
    });
  });

  it('round-trips governed semantic queries and a runtime story evidence plan', () => {
    const doc = {
      ...minimal,
      story: {
        version: 1,
        goal: 'Explain beverage revenue and its customer drivers.',
        audience: 'Revenue leadership',
        eligibleTileIds: ['beverage-revenue'],
        driverTileIds: ['beverage-revenue'],
      },
      layout: {
        ...minimal.layout,
        items: [{
          i: 'beverage-revenue', x: 0, y: 0, w: 8, h: 4,
          semantic: {
            id: 'beverage-revenue',
            provider: 'metricflow',
            metrics: ['revenue'],
            dimensions: ['customer_name', 'product_category'],
            filters: [{ field: 'product_category', operator: '=', value: 'Beverage' }],
            orderBy: [{ field: 'revenue', direction: 'desc' }],
            limit: 10,
            semanticModelRefs: ['orders'],
            qualifiedMetricIds: ['revenue.metrics.revenue'],
            qualifiedModelIds: ['revenue.semantic_models.orders'],
            resolvedPlanFingerprint: 'sha256:resolved-plan-v1',
            definitionFingerprint: 'sha256:semantic-v1',
            snapshotId: 'snapshot-1',
          },
          viz: { type: 'bar' },
          trustState: 'review_required',
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.story).toMatchObject({ goal: 'Explain beverage revenue and its customer drivers.' });
    expect(document?.layout.items[0]?.semantic).toMatchObject({
      metrics: ['revenue'],
      provider: 'metricflow',
      qualifiedMetricIds: ['revenue.metrics.revenue'],
      qualifiedModelIds: ['revenue.semantic_models.orders'],
      resolvedPlanFingerprint: 'sha256:resolved-plan-v1',
    });
  });

  it('round-trips an explicitly accepted app-scoped analysis draft', () => {
    const doc = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'new-analysis', x: 0, y: 0, w: 8, h: 4,
          draftAnalysis: {
            ref: 'drafts/new-analysis.dql',
            artifactFingerprint: 'sha256:draft-v1',
            snapshotId: 'snapshot-1',
            executionReceiptId: 'receipt-1',
          },
          viz: { type: 'bar' },
          sourceClass: 'exploratory_analysis',
          review: {
            status: 'required',
            sourceFingerprint: 'sha256:draft-v1',
            preflightReceiptId: 'receipt-1',
          },
          trustState: 'review_required',
          reviewStatus: 'review_required',
        }],
      },
    };

    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));

    expect(errors).toEqual([]);
    expect(document?.layout.items[0]).toMatchObject({
      draftAnalysis: {
        ref: 'drafts/new-analysis.dql',
        artifactFingerprint: 'sha256:draft-v1',
        executionReceiptId: 'receipt-1',
      },
      sourceClass: 'exploratory_analysis',
      review: { status: 'required', preflightReceiptId: 'receipt-1' },
    });
  });

  it('rejects semantic sources without reviewed model references or fingerprints', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'semantic', x: 0, y: 0, w: 8, h: 4,
          semantic: { id: 'semantic', provider: 'native', metrics: ['revenue'], semanticModelRefs: [] },
          viz: { type: 'bar' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.map((error) => error.message).join('\n')).toMatch(/semanticModelRefs|definitionFingerprint/);
  });

  it('errors on unknown viz type', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: { blockId: 'z' },
          viz: { type: 'spaghetti' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/viz\.type must be in/);
  });

  it('errors when block ref is missing', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: {},
          viz: { type: 'line' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/must have a block, semantic, draftAnalysis, text, or aiPin source/);
  });

  it('rejects non-grid layouts (single supported kind today)', () => {
    const bad = {
      ...minimal,
      layout: { ...minimal.layout, kind: 'flex' },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/layout\.kind must be "grid"/);
  });
});

describe('extractDashboardBlockRefs', () => {
  it('separates id refs from path refs', () => {
    const refs = extractDashboardBlockRefs(minimal);
    expect(refs.byId).toEqual(['revenue_total']);
    expect(refs.byPath).toEqual(['blocks/revenue_trend.dql']);
  });
});

describe('isBlockIdRef', () => {
  it('recognises by-id refs', () => {
    expect(isBlockIdRef({ blockId: 'foo' })).toBe(true);
    expect(isBlockIdRef({ ref: 'blocks/foo.dql' })).toBe(false);
  });
});
