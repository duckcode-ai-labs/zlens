import { renderToStaticMarkup } from 'react-dom/server';
import { tileQueryHash } from '@zlens/core/apps/tile-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AppStudioV2Module from './AppStudioV2';
import { summarizeAppStudioAiPlan, appStudioNewDataSources } from './app-studio-ai-plan';
import { aiProposal, marginMetrics, orderLinesDataset } from './builder/app-data.fixtures';

// AppStudioV2 pulls in most of the Studio (charts, the AI panel, every builder
// panel), so its first import can take several seconds on a busy machine. Load
// it once here, under the hook timeout, so that time is not charged to
// whichever test happens to run first.
let studio: typeof AppStudioV2Module;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  studio = await import('./AppStudioV2');
});

async function studioTilePreview() {
  return studio.StudioTilePreview;
}

async function datasetSourceAuthoringDialog() {
  return studio.DatasetSourceAuthoringDialog;
}

async function datasetSourceRebindReviewDialog() {
  return studio.DatasetSourceRebindReviewDialog;
}

async function appAutopilotReviewCard() {
  return studio.AppAutopilotReviewCard;
}

async function appAutopilotRepairShortcut() {
  return {
    availability: studio.appAutopilotRepairShortcutAvailability,
    examplePrompts: studio.appAutopilotExamplePrompts,
    context: studio.appAutopilotContext,
    presentationContextKey: studio.appAutopilotPresentationContextKey,
  };
}

async function componentInspector() {
  return studio.ComponentInspector;
}

describe('Studio Dataset mark interaction (APP-041)', () => {
  it('passes the source-qualified row callback into an interactive bar mark', async () => {
    const onSelectDatasetMark = vi.fn();
    const StudioTilePreview = await studioTilePreview();
    const markup = renderToStaticMarkup(
      <StudioTilePreview
        tile={{
          i: 'revenue-by-region', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
          viz: { type: 'bar' },
        } as any}
        run={{
          tileId: 'revenue-by-region', status: 'ok', tileType: 'dataset',
          result: {
            columns: ['region', 'revenue'],
            rows: [{ region: 'CA', revenue: 60 }],
            rowCount: 1,
            executionTime: 1,
          },
        } as any}
        loading={false}
        themeMode="paper"
        crossFilterFields={['region']}
        onSelectDatasetMark={onSelectDatasetMark}
      />,
    );

    // Each mark is a real button, reachable by keyboard.
    expect(markup).toContain('<button type="button" aria-label="Select CA">');
  });

  it('shows the server-declared unsaved hierarchy drill and Back control on an actual Dataset result', async () => {
    const StudioTilePreview = await studioTilePreview();
    const markup = renderToStaticMarkup(
      <StudioTilePreview
        tile={{
          i: 'revenue-by-customer', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
          query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] },
          viz: { type: 'bar' },
        } as any}
        run={{
          tileId: 'revenue-by-customer', status: 'ok', tileType: 'dataset',
          result: { columns: ['customer_id', 'revenue'], rows: [{ customer_id: 'C-001', revenue: 70 }], rowCount: 1, executionTime: 1 },
          dataset: {
            hierarchy: {
              activeSteps: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', values: ['C-001'] }],
              candidates: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id' }],
            },
          },
        } as any}
        loading={false}
        themeMode="paper"
        onDrillDatasetMark={vi.fn()}
        onDrillBack={vi.fn()}
      />,
    );

    expect(markup).toContain('Explore hierarchy · unsaved');
    expect(markup).toContain('Click a Customer Id mark to drill to Order Id.');
    expect(markup).toContain('>Up one level<');
    expect(markup).toContain('aria-label="Select C-001"');
  });

  it('keeps filter and hierarchy mark behavior as an explicit Studio choice when both are declared', async () => {
    const StudioTilePreview = await studioTilePreview();
    const markup = renderToStaticMarkup(
      <StudioTilePreview
        tile={{
          i: 'customer-revenue', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
          query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' },
        } as any}
        run={{
          tileId: 'customer-revenue', status: 'ok', tileType: 'dataset',
          result: { columns: ['customer_id', 'revenue'], rows: [{ customer_id: 'C-001', revenue: 70 }], rowCount: 1, executionTime: 1 },
          dataset: { hierarchy: { activeSteps: [], candidates: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id' }] } },
        } as any}
        loading={false}
        themeMode="paper"
        crossFilterFields={['customer_id']}
        onSelectDatasetMark={vi.fn()}
        onDrillDatasetMark={vi.fn()}
      />,
    );
    expect(markup).toContain('Click action');
    expect(markup).toContain('Filter linked tiles');
    expect(markup).toContain('Drill to Order Id');
  });

  it('shows an actionable scalar Dataset error for empty and one-row malformed results', async () => {
    const StudioTilePreview = await studioTilePreview();
    const tile = {
      i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
      sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
      query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
      viz: { type: 'single_value' },
    } as any;
    const render = (rows: Array<Record<string, unknown>>) => renderToStaticMarkup(
      <StudioTilePreview
        tile={tile}
        run={{
          tileId: tile.i, status: 'ok', tileType: 'dataset',
          result: { columns: ['revenue', 'order_count'], rows, rowCount: rows.length, executionTime: 1 },
        } as any}
        loading={false}
        themeMode="paper"
      />,
    );

    // Result cardinality never makes two selected measures safe for a scalar
    // view; the author sees a repair path before a hidden value can render.
    for (const markup of [render([]), render([{ revenue: 130, order_count: 6 }])]) {
      expect(markup).toContain('Chart needs attention');
      expect(markup).toContain('exactly one selected measure');
      expect(markup).toContain('Choose Table');
    }
  });
});

describe('Studio Dataset source authoring (APP-055)', () => {
  it('shows declared grain and reviewable exact-field candidates before it can create a source proposal', async () => {
    const DatasetSourceAuthoringDialog = await datasetSourceAuthoringDialog();
    const markup = renderToStaticMarkup(
      <DatasetSourceAuthoringDialog
        source={{
          id: 'source.daily', sourceId: 'source.daily', qualifiedIdentity: 'commerce::block::Daily Dataset::abc',
          sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', snapshotId: 'snapshot-a',
          name: 'Daily Dataset', domain: 'commerce', status: 'certified', owner: null, tags: [], path: 'domains/commerce/blocks/daily.dql', fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lastModified: '', description: '', score: 1, reasons: [], lifecycle: 'certified', trust: 'certified',
          capabilities: {
            measures: ['revenue'], dimensions: ['order_date'], outputs: [], filters: [], parameters: [],
            dataset: {
              version: 1, id: 'source.daily', kind: 'block', sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', snapshotId: 'snapshot-a',
              contractRef: { kind: 'block_source', id: 'commerce::block::Daily Dataset', fingerprint: 'sha256:contract' },
              binding: { sourceQualifiedId: 'commerce::block::Daily Dataset', sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', contractFingerprint: 'sha256:contract', state: 'target_required' },
              label: 'Daily Dataset', lifecycle: 'certified', trust: 'certified',
              grain: { entityIds: ['customer_day'], keyFields: ['customer_day_id', 'order_date'], keyEvidence: 'proof.customer-day', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
              fields: [
                { kind: 'physical', name: 'customer_day_id', qualifiedId: 'field:key', type: 'string', role: 'key', status: 'approved' },
                { kind: 'physical', name: 'order_date', qualifiedId: 'field:date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day'] } },
                { kind: 'physical', name: 'daily_revenue', qualifiedId: 'field:revenue', type: 'number', role: 'attribute', status: 'approved' },
                { kind: 'physical', name: 'daily_margin', qualifiedId: 'field:margin', type: 'number', role: 'attribute', status: 'approved' },
                { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'daily_revenue', dependsOn: ['daily_revenue'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
              ],
              operations: ['filter', 'group'], execution: { route: 'governed_sql' },
            },
          },
          eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
        } as any}
        disabled={false}
        onClose={() => undefined}
        onPreview={() => undefined}
      />,
    );

    expect(markup).toContain('What is one row?');
    expect(markup).toContain('Define fields');
    // Ids and proof references sit under a collapsed Technical details toggle (D6).
    expect(markup).toMatch(/<details class="dql-technical-details"><summary>Technical details<\/summary>[\s\S]*proof\.customer-day[\s\S]*<\/details>/);
    expect(markup).not.toMatch(/<details[^>]*open/);
    expect(markup).not.toContain('Native grain proposal');
    expect(markup).toContain('Column types');
    expect(markup).toContain('Native time bucket');
    expect(markup).toContain('order_date role');
    expect(markup).toContain('Gross margin');
    expect(markup).toContain('SUM(daily_revenue) - SUM(daily_margin)');
    expect(markup).toContain('Aggregate formula');
    expect(markup).toContain('Review source change');
    expect(markup).toContain('does not change this App’s data');
  });

  it('asks before refreshing a changed Dataset binding, and says it does not certify the data', async () => {
    const DatasetSourceRebindReviewDialog = await datasetSourceRebindReviewDialog();
    const markup = renderToStaticMarkup(
      <DatasetSourceRebindReviewDialog title="Order lines Dataset" disabled={false} onCancel={() => undefined} onConfirm={() => undefined} />,
    );
    expect(markup).toContain('Refresh data');
    expect(markup).toContain('not certified yet');
    expect(markup).not.toMatch(/needs review/i);
    expect(markup).toContain('does not certify the data');
  });
});

describe('Studio Dataset period comparison authoring (APP-060)', () => {
  it('offers an explicit calendar-period control from an approved Dataset time field', async () => {
    const { TileQueryEditor } = await import('./builder/TileQueryEditor');
    const descriptor = {
      version: 1, id: 'source.orders', kind: 'block', sourceRevision: 'sha256:orders', snapshotId: 'snapshot-1',
      contractRef: { kind: 'block_source', id: 'commerce::orders', fingerprint: 'sha256:contract' },
      binding: { sourceQualifiedId: 'commerce::orders', sourceRevision: 'sha256:orders', contractFingerprint: 'sha256:contract', state: 'valid' },
      label: 'Orders', lifecycle: 'certified', trust: 'certified',
      grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
      fields: [
        { kind: 'physical', name: 'order_date', qualifiedId: 'field:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
        { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      ],
      operations: ['filter', 'group', 'compare', 'having'], execution: { route: 'governed_sql' },
    } as any;
    const markup = renderToStaticMarkup(
      <TileQueryEditor
        descriptor={descriptor}
        query={{ dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true }}
        disabled={false}
        onChange={vi.fn()}
        idPrefix="period-comparison"
      />,
    );

    expect(markup).toContain('Compare periods');
    expect(markup).toContain('Compare two calendar periods');
    expect(markup).toContain('Shows current, prior, difference, and change together.');
    expect(markup).toContain('Filter totals');
    expect(markup).toContain('Applies after the selected measures are aggregated.');
  });
});

describe('Studio App Autopilot repair shortcut (APP-065)', () => {
  it('shows repair only for a current API-shaped failed Dataset tile', async () => {
    const { availability, examplePrompts, context, presentationContextKey } = await appAutopilotRepairShortcut();
    const selectedTile = {
      i: 'monthly-revenue', sourceId: 'source.order-lines', sourceRevision: 'sha256:orders',
      query: { dimensions: [{ field: 'order_date', grain: 'month' }], measures: [{ measure: 'revenue' }] },
      viz: { type: 'bar' },
    } as any;
    const preview = (status: 'ok' | 'error', extra: Record<string, unknown> = {}) => ({
      appId: 'build_1', dashboardId: 'overview', persona: null, runId: 'app_run_1', snapshotId: 'snapshot_1',
      filterFingerprint: 'sha256:filters', resultFingerprint: 'sha256:result', personaFingerprint: 'sha256:persona',
      facts: [], story: { facts: [], narrative: '' },
      tiles: [{ tileId: 'monthly-revenue', tileType: 'dataset', status, ...extra }],
    } as any);

    const healthy = availability(selectedTile, preview('ok'));
    expect(healthy).toBe('healthy');
    expect(examplePrompts(healthy).map((prompt) => prompt.label)).not.toContain('Repair selected tile');
    // `incomplete` is a page-level summary, not a partial refresh. A failure
    // on another tile does not make this selected settled tile repairable.
    const healthyWithOtherFailure = {
      ...preview('ok'),
      incomplete: { failedTileIds: ['another-tile'], message: '1 component needs attention' },
      tiles: [
        { tileId: 'monthly-revenue', tileType: 'dataset', status: 'ok' },
        { tileId: 'another-tile', tileType: 'dataset', status: 'error' },
      ],
    } as any;
    expect(availability(selectedTile, healthyWithOtherFailure)).toBe('healthy');

    // A full preview can be incomplete because this Dataset tile failed. It
    // remains a current server-reported diagnostic, so the repair shortcut is
    // available instead of being globally disabled.
    const failedPreview = {
      ...preview('error'),
      runId: 'app_run_failed_1',
      incomplete: { failedTileIds: ['monthly-revenue'], message: '1 component needs attention' },
    };
    const failed = availability(selectedTile, failedPreview);
    expect(failed).toBe('failed_tile');
    expect(examplePrompts(failed)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Repair selected tile',
        prompt: 'What is the smallest governed repair needed before this selected tile can answer its intended question?',
      }),
    ]));
    const failedContext = context({ id: 'build_1', appId: 'app_1' } as any, { id: 'overview' } as any, selectedTile, failedPreview);
    expect(failedContext).toMatchObject({
      surface: 'app_autopilot', appBuildId: 'build_1', appId: 'app_1',
      pageId: 'overview', tileId: 'monthly-revenue', previewRunId: 'app_run_failed_1',
    });
    expect(presentationContextKey({
      draftId: 'build_1', pageId: 'overview', tileId: 'monthly-revenue', previewRunId: 'app_run_failed_1',
    })).toBe('build_1:overview:monthly-revenue:app_run_failed_1');

    const stale = availability(selectedTile, { ...preview('error'), stale: true });
    expect(stale).toBe('preview_required');
    expect(examplePrompts(stale).map((prompt) => prompt.label)).not.toContain('Repair selected tile');
    expect(availability(selectedTile, null)).toBe('preview_required');
  });
});

describe('Studio universal App Autopilot review (APP-065)', () => {
  it('shows a universal AgentRun change separately from Apply, without implying an immediate draft change', async () => {
    const AppAutopilotReviewCard = await appAutopilotReviewCard();
    const markup = renderToStaticMarkup(
      <AppAutopilotReviewCard
        proposal={{
          version: 1, id: 'autopilot_revenue_region', runId: 'run_app_autopilot', artifactId: 'app_autopilot:run_app_autopilot',
          draftId: 'build_1', baseRevision: 3, baseProposalHash: 'sha256:draft',
          pageId: 'overview', tileId: 'revenue-kpi', request: 'Group this tile by Region',
          intent: { action: 'group_tile', request: 'Group this tile by Region', field: 'region' },
          source: { sourceId: 'source.orders', sourceRevision: 'sha256:orders', contractFingerprint: 'sha256:contract' },
          planningMode: 'universal_agent',
          operations: [{ type: 'update_tile', pageId: 'overview', tileId: 'revenue-kpi', patch: {
            query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' }, title: 'Revenue by Region',
          } }],
          diagnostics: [{ code: 'APP_AUTOPILOT_SERVER_COMPILED', severity: 'info', message: 'Prepared from approved Dataset fields.' }],
          createdAt: '2026-09-11T00:00:00.000Z', proposalHash: 'sha256:proposal',
        } as any}
        running={false}
        onDiscard={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(markup).toContain('AI TILE CHANGE');
    expect(markup).toContain('Proposed grouping: Region');
    expect(markup).toContain('This has not changed the draft or its source.');
    expect(markup).toContain('>Discard<');
    expect(markup).toContain('>Apply change<');
    expect(markup).not.toContain('Run SQL');
  });
});

describe('Studio Dataset review-draft save (M4-PROM-01)', () => {
  it('offers a separate review-draft save only for a current settled Dataset result', async () => {
    const ComponentInspector = await componentInspector();
    const query = { dimensions: [], measures: [{ measure: 'revenue' }] };
    const tile = {
      i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
      title: 'Revenue', sourceId: 'source.orders', sourceRevision: 'sha256:orders',
      query, viz: { type: 'kpi' },
    } as any;
    const markup = renderToStaticMarkup(
      <ComponentInspector
        tile={tile}
        run={{
          tileId: tile.i, tileType: 'dataset', status: 'ok',
          result: { columns: ['revenue'], rows: [{ revenue: 130 }], rowCount: 1, executionTime: 1 },
          artifact: { sourceKind: 'dataset_query', name: 'Revenue', trustState: 'certified' },
          dataset: {
            sourceId: 'source.orders', sourceRevision: 'sha256:orders',
            authoredQueryFingerprint: tileQueryHash(query),
          },
        } as any}
        pageId="overview"
        page={{ id: 'overview', metadata: { title: 'Overview' }, layout: { items: [tile] } } as any}
        pages={[] as any}
        sources={[] as any}
        disabled={false}
        onOpenSources={vi.fn()}
        onSaveDatasetTileAsBlock={vi.fn()}
        savingDatasetTileAsBlock={false}
        onRefreshDatasetTile={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateInteractions={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(markup).toContain('Save as reusable review draft');
    expect(markup).toContain('This App tile stays unchanged');
    expect(markup).toContain('not certified');
    expect(markup).not.toContain('disabled=""');
  });

  it('labels a cache delivery as display-only and offers a live refresh before save evidence can exist', async () => {
    const ComponentInspector = await componentInspector();
    const query = { dimensions: [], measures: [{ measure: 'revenue' }] };
    const tile = {
      i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
      title: 'Revenue', sourceId: 'source.orders', sourceRevision: 'sha256:orders',
      query, viz: { type: 'kpi' },
    } as any;
    const markup = renderToStaticMarkup(
      <ComponentInspector
        tile={tile}
        run={{
          tileId: tile.i, tileType: 'dataset', status: 'ok',
          result: { columns: ['revenue'], rows: [{ revenue: 130 }], rowCount: 1, executionTime: 1 },
          artifact: { sourceKind: 'dataset_query', name: 'Revenue', trustState: 'certified' },
          dataset: {
            sourceId: 'source.orders', sourceRevision: 'sha256:orders',
            authoredQueryFingerprint: tileQueryHash(query),
            cacheDelivery: {
              version: 1, kind: 'dataset_cache_delivery', cacheKey: 'sha256:cache',
              originalReceiptId: 'app_run_live', sourceRevision: 'sha256:orders',
              contractFingerprint: 'sha256:contract', targetFingerprint: 'sha256:target',
              cachedAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-09-11T00:05:00.000Z',
            },
          },
        } as any}
        pageId="overview"
        page={{ id: 'overview', metadata: { title: 'Overview' }, layout: { items: [tile] } } as any}
        pages={[] as any}
        sources={[] as any}
        disabled={false}
        onOpenSources={vi.fn()}
        onSaveDatasetTileAsBlock={vi.fn()}
        savingDatasetTileAsBlock={false}
        onRefreshDatasetTile={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateInteractions={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(markup).toContain('Cached');
    expect(markup).toContain('not fresh publication or reusable-block evidence');
    expect(markup).toContain('Refresh live data');
    expect(markup).toContain('Refresh live data before saving or replacing this tile.');
    expect(markup).toContain('Save as reusable review draft</button>');
    expect(markup).toContain('disabled=""');
  });

  it('offers an explicit proof-gated replacement only after the separate review draft exists', async () => {
    const ComponentInspector = await componentInspector();
    const query = { dimensions: [], measures: [{ measure: 'revenue' }] };
    const tile = {
      i: 'revenue-kpi', x: 0, y: 0, w: 3, h: 2,
      title: 'Revenue', sourceId: 'source.orders', sourceRevision: 'sha256:orders',
      query, viz: { type: 'kpi' },
    } as any;
    const markup = renderToStaticMarkup(
      <ComponentInspector
        tile={tile}
        run={{
          tileId: tile.i, tileType: 'dataset', status: 'ok',
          result: { columns: ['revenue'], rows: [{ revenue: 130 }], rowCount: 1, executionTime: 1 },
          artifact: { sourceKind: 'dataset_query', name: 'Revenue', trustState: 'certified' },
          dataset: {
            sourceId: 'source.orders', sourceRevision: 'sha256:orders',
            authoredQueryFingerprint: tileQueryHash(query),
          },
        } as any}
        pageId="overview"
        page={{ id: 'overview', metadata: { title: 'Overview' }, layout: { items: [tile] } } as any}
        pages={[] as any}
        sources={[] as any}
        disabled={false}
        onOpenSources={vi.fn()}
        onSaveDatasetTileAsBlock={vi.fn()}
        savingDatasetTileAsBlock={false}
        savedDatasetReviewDraft={{
          ok: true, path: 'domains/commerce/blocks/_drafts/revenue.dql', status: 'draft',
          provenanceFingerprint: 'sha256:provenance', replacementEligible: true,
        }}
        onReplaceDatasetTileWithBlock={vi.fn()}
        replacingDatasetTileWithBlock={false}
        onRefreshDatasetTile={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateInteractions={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(markup).toContain('Saved review draft: domains/commerce/blocks/_drafts/revenue.dql');
    expect(markup).toContain('Replace with this review draft');
    expect(markup).toContain('Save this settled result as a separate review draft');
  });
});

describe('Studio legacy semantic conversion (M4-CONV-01)', () => {
  it('offers only an explicit preview and proof-gated apply for a legacy semantic tile', async () => {
    const ComponentInspector = await componentInspector();
    const tile = {
      i: 'legacy-revenue', x: 0, y: 0, w: 4, h: 2,
      title: 'Legacy revenue',
      semantic: {
        id: 'legacy-revenue', provider: 'native', metrics: ['revenue'], dimensions: [],
        semanticModelRefs: ['orders'], qualifiedMetricIds: ['semantic:commerce:metric:revenue'],
        qualifiedModelIds: ['semantic:commerce:model:orders'], definitionFingerprint: 'sha256:legacy', snapshotId: 'snapshot-current',
      },
      viz: { type: 'kpi' },
    } as any;
    const markup = renderToStaticMarkup(
      <ComponentInspector
        tile={tile}
        pageId="overview"
        page={{ id: 'overview', metadata: { title: 'Overview' }, layout: { items: [tile] } } as any}
        pages={[] as any}
        sources={[] as any}
        disabled={false}
        onOpenSources={vi.fn()}
        onSaveDatasetTileAsBlock={vi.fn()}
        savingDatasetTileAsBlock={false}
        onPreviewLegacySemanticConversion={vi.fn()}
        previewingLegacySemanticConversion={false}
        semanticTileConversionPreview={{
          ok: true,
          proposalId: 'semantic_conversion_1',
          candidate: {
            sourceId: 'app:semantic:commerce:orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] }, queryFingerprint: 'sha256:query',
            provenance: {
              version: 1, kind: 'semantic_tile_conversion_provenance', legacyIdentityFingerprint: 'sha256:legacy-identity',
              legacyTileFingerprint: 'sha256:legacy-tile', legacyPayload: { semantic: { id: 'legacy-revenue' } },
              datasetId: 'app:semantic:commerce:orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
              queryFingerprint: 'sha256:query', equivalenceProofFingerprint: 'sha256:equivalence', convertedAt: '2026-09-11T00:00:00.000Z',
            },
          },
          equivalenceProofFingerprint: 'sha256:equivalence',
        } as any}
        onAcceptLegacySemanticConversion={vi.fn()}
        acceptingLegacySemanticConversion={false}
        onRefreshDatasetTile={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateInteractions={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(markup).toContain('Convert to a field query');
    expect(markup).toContain('Preview Dataset conversion');
    expect(markup).toContain('Mapped source: app:semantic:commerce:orders');
    expect(markup).toContain('Apply Dataset conversion');
    expect(markup).toContain('does not certify the source');
    expect(markup).not.toContain('Run SQL');
  });
});

describe('Studio field-based tiles are on by default (APP-007)', () => {
  const datasetSource = {
    id: 'source.order-lines', sourceId: 'source.order-lines', name: 'order_lines', domain: 'commerce',
    status: 'certified', trust: 'certified', owner: null, tags: [], path: 'blocks/commerce/order-lines.dql', fingerprint: 'sha256:a',
    lastModified: '2026-10-01T00:00:00.000Z', description: 'Order lines', score: 1, reasons: [],
    capabilities: {
      measures: ['revenue'], dimensions: ['region'], outputs: ['region', 'revenue'], filters: [], parameters: [],
      dataset: {
        id: 'dataset.order-lines', kind: 'block', label: 'Order lines', operations: ['group'],
        fields: [
          { name: 'revenue', kind: 'measure', status: 'approved', aggregation: 'sum', dependsOn: ['net_amount'] },
          { name: 'region', kind: 'physical', status: 'approved', role: 'dimension', type: 'string' },
        ],
      },
    },
  };

  async function renderDataPanel(datasetTilesEnabled: boolean): Promise<string> {
    const { DataPanel } = await import('./builder/DataPanel');
    return renderToStaticMarkup(
      <DataPanel
        appData={[datasetSource] as any}
        active={datasetSource as any}
        target={{ kind: 'none' }}
        disabled={false}
        datasetTilesEnabled={datasetTilesEnabled}
        onChoose={vi.fn()}
        onPickField={vi.fn()}
        onAddData={vi.fn()}
        onAddSavedQuery={vi.fn()}
        onAddContent={vi.fn()}
      />,
    );
  }

  it('shows no opt-in banner and lists the Dataset fields when the feature is on', async () => {
    const markup = await renderDataPanel(true);
    expect(markup).not.toContain('Build tiles from Dataset fields');
    expect(markup).not.toContain('Turn on field-based tiles');
    expect(markup).not.toContain('turned off for this project');
    expect(markup).toContain('Measures');
    expect(markup).toContain('Revenue');
  });

  it('shows one plain line and no fields when apps.datasets is false', async () => {
    const markup = await renderDataPanel(false);
    expect(markup).toContain('Field-based tiles are turned off for this project (apps.datasets is false in dql.config.json).');
    expect(markup).not.toContain('Turn on field-based tiles');
    expect(markup).not.toContain('Search fields');
  });
});

describe('Studio honest AI review and App domain (D6, D7, D8)', () => {
  it('uses the App domain from the draft, never the no-domain default', () => {
    const page = (domain?: string) => ({ pages: [{ metadata: { title: 'Overview', ...(domain ? { domain } : {}) } }] }) as never;
    expect(studio.appDraftDomain(page('finance'))).toBe('finance');
    expect(studio.appDraftDomain(page('general'))).toBeUndefined();
    expect(studio.appDraftDomain(page())).toBeUndefined();
    expect(studio.appDraftDomain(null)).toBeUndefined();
  });
});

describe('Canvas AI review keeps only the tiles (design D3, D5)', () => {
  const review = (props: Partial<Parameters<typeof studio.AiPlanReview>[0]> = {}) => {
    const proposal = aiProposal();
    const summary = summarizeAppStudioAiPlan(proposal);
    const AiPlanReview = studio.AiPlanReview;
    return renderToStaticMarkup(
      <AiPlanReview
        proposal={proposal}
        summary={summary}
        sourcePolicy="governed_only"
        selectedSourceIds={new Set(proposal.defaultSelectedSourceIds)}
        busy={false}
        changeCount={2}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
        onToggleTile={vi.fn()}
        onRevise={vi.fn()}
        onAnswerClarification={vi.fn()}
        onGenerateGap={vi.fn()}
        {...props}
      />,
    );
  };

  it('after Build pages: proposed tiles with keep or skip, Apply N changes, Discard and Back to data', () => {
    const markup = review({ showPlanNotes: false, onBackToData: vi.fn(), skippedTileIds: new Set(['margin-kpi']) });
    expect(markup).toContain('Review the tiles');
    expect(markup).toContain('Back to data');
    expect(markup).toContain('Revenue trend');
    expect(markup).toContain('aria-label="Skip Revenue trend"');
    expect(markup).toContain('aria-label="Keep Gross margin"');
    expect(markup).toContain('1</strong> of 2 tiles kept');
    expect(markup).toContain('Apply 2 changes');
    expect(markup).toContain('>Discard</button>');
    // The data lives in the Data step now.
    expect(markup).not.toMatch(/Selected for this App|AI suggestions|More App sources|Apply with|Search proposed and available sources|New data for this App/);
    expect(markup).not.toContain('Revenue by channel was not added');
    expect(markup).not.toContain('Not covered yet');
  });

  it('has no Back to data link when the proposal did not come from the Data step', () => {
    expect(review()).not.toContain('Back to data');
  });

  it('lists the data an Ask AI proposal adds as New data for this App, with the reason', () => {
    const proposal = aiProposal();
    const summary = summarizeAppStudioAiPlan(proposal);
    const selected = new Set(proposal.defaultSelectedSourceIds);
    const margin = proposal.operations.find((operation) => operation.type === 'upsert_source' && operation.source.id === marginMetrics.sourceId);
    // The App already has Margin; only Order lines is new.
    const newSources = appStudioNewDataSources(summary, selected, margin?.type === 'upsert_source' ? [margin.source] : []);
    expect(newSources.map((source) => source.id)).toEqual([orderLinesDataset.sourceId]);
    const markup = review({ newSources });
    expect(markup).toContain('New data for this App: Order Lines');
    expect(markup).toContain('Why: Order lines carries revenue by order date.');
    expect(markup).toContain('Table · Certified');
    expect(markup).not.toContain('New data for this App: Margin');
    // Canvas proposals still show the planner notes and gaps.
    expect(markup).toContain('Revenue by channel was not added because no Dataset has a channel field.');
    expect(markup).toContain('Not covered yet');
  });
});

describe('Publish leaves out data no tile uses (design D4)', () => {
  it('notes connected sources that no tile uses and does not count them as fixes', () => {
    const PublishReadinessDialog = studio.PublishReadinessDialog;
    const unused = (id: string) => ({ id, kind: 'block' as const, sourceRef: `blocks/${id}.dql`, lifecycle: 'draft' as const, trustState: 'review_required' as const, reviewStatus: 'required' as const });
    const draft = {
      version: 3, id: 'build_1', appId: 'revenue-app', name: 'Revenue App', revision: 2, proposalHash: 'hash',
      authoringMode: 'manual', template: 'blank', sourcePolicy: 'include_review_required', state: 'local_draft',
      frame: { goal: 'Revenue', metrics: [], dimensions: [], filters: [] }, requirements: [], coverage: [],
      sources: [unused('orders'), unused('customers')],
      pages: [{ version: 2, id: 'overview', metadata: { title: 'Overview' }, layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] } }],
      reviewTasks: [], createdAt: '', updatedAt: '',
    } as never;
    const markup = renderToStaticMarkup(
      <PublishReadinessDialog
        draft={draft}
        serverIssues={[]}
        busy={false}
        previewRun={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onRunPreview={vi.fn()}
        onRunAllPreviews={vi.fn()}
        onRemoveRequirement={vi.fn()}
        onReviseRequirement={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onResolveTask={vi.fn()}
        onOpenSources={vi.fn()}
        onOpenFilters={vi.fn()}
        onRefreshSources={vi.fn()}
        onApproveSemantic={vi.fn()}
        onRemoveLocalAnalysis={vi.fn()}
      />,
    );
    expect(markup).toContain('2 data sources not used by any tile will not be saved with the App.');
    expect(markup).toContain('Ready to publish');
    expect(markup).not.toContain('Local analysis cannot publish');
  });
});

describe('Publish lists tiles on a join nobody certified, and never blocks on them by default (design D2, T3)', () => {
  const sourceId = 'app:block:commerce:orders';
  const draftWith = (sourcePolicy: 'governed_only' | 'include_review_required') => ({
    version: 3, id: 'build_1', appId: 'orders-app', name: 'Orders', revision: 2, proposalHash: 'hash',
    authoringMode: 'manual', template: 'blank', sourcePolicy, state: 'local_draft',
    frame: { goal: 'Orders', metrics: [], dimensions: [], filters: [] }, requirements: [], coverage: [],
    sources: [{
      id: sourceId, kind: 'block', sourceRef: 'orders', lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required',
      capabilities: { dataset: {
        kind: 'block', trust: 'certified',
        fields: [{ kind: 'physical', name: 'location__location_name', qualifiedId: 'o:location__location_name', type: 'string', role: 'dimension', status: 'approved', related: { join: 'location', column: 'location_name' } }],
        joins: [{ id: 'location', label: 'Location', table: 'locations', relation: 'main.locations', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'proposal_setup:rel_2', uniqueness: 'current', sentence: 'each order has one location' }],
      } },
    }],
    pages: [{
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'orders_ds', sourceId, sourceRevision: 'r', snapshotId: 's', contractFingerprint: 'c' }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{
        i: 'by_location', x: 0, y: 0, w: 6, h: 4, title: 'Revenue by location', sourceId, sourceRevision: 'r',
        query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true }, viz: { type: 'bar' },
      }] },
    }],
    previewReceipts: [{ id: 'run', pageId: 'overview', revision: 2, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'x', createdAt: '' }],
    reviewTasks: [], createdAt: '', updatedAt: '',
  }) as never;
  const dialog = (draft: never, requireCertifiedToPublish = false) => renderToStaticMarkup(
    <studio.PublishReadinessDialog
      draft={draft}
      requireCertifiedToPublish={requireCertifiedToPublish}
      serverIssues={[]}
      busy={false}
      previewRun={null}
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onRunPreview={vi.fn()}
      onRunAllPreviews={vi.fn()}
      onRemoveRequirement={vi.fn()}
      onReviseRequirement={vi.fn()}
      onAnswerQuestion={vi.fn()}
      onResolveTask={vi.fn()}
      onOpenSources={vi.fn()}
      onOpenFilters={vi.fn()}
      onRefreshSources={vi.fn()}
      onApproveSemantic={vi.fn()}
      onRemoveLocalAnalysis={vi.fn()}
    />,
  );

  it('is ready with the tile listed, its join actions, and what readers will see — whatever an old App\'s data rule said', () => {
    for (const sourcePolicy of ['governed_only', 'include_review_required'] as const) {
      const markup = dialog(draftWith(sourcePolicy));
      expect(markup).toContain('Ready to publish');
      expect(markup).toContain('0 of 1 tile certified');
      expect(markup).toContain('aria-label="1 tile not certified yet"');
      expect(markup).toContain('Revenue by location');
      expect(markup).toContain('Uses a join nobody has certified.');
      expect(markup).toContain('Certify the join (recommended)');
      expect(markup).toContain('Remove the related field');
      expect(markup).toContain('Readers will see \u2018Not certified yet\u2019 on 1 tile.');
      expect(markup).toMatch(/<button type="button" class="primary">Publish<\/button>/);
      expect(markup).not.toContain('All checks passed');
      expect(markup).not.toMatch(/needs review|Allow data|data rule|Only certified data/i);
    }
  });

  it('holds publishing with one plain sentence when the project requires certified data', () => {
    const markup = dialog(draftWith('include_review_required'), true);
    expect(markup).not.toContain('Ready to publish');
    expect(markup).toContain('1 fix before publishing');
    expect(markup).toContain('This project requires every tile to be certified before an App is published.');
    expect(markup).toContain('Certify the join (recommended)');
    expect(markup).not.toMatch(/>Publish<\/button>/);
  });
});

describe('Certify at publish (design Q1)', () => {
  const checkedTable = { id: 'app:block:shop:orders', kind: 'block' as const, sourceRef: 'domains/shop/blocks/orders.dql', lifecycle: 'review' as const, trustState: 'review_required' as const, reviewStatus: 'required' as const, checked: true, capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: { kind: 'block', label: 'Orders', trust: 'review_required', fields: [] } } };
  const savedQuery = { id: 'app:block:shop:top', kind: 'block' as const, sourceRef: 'domains/shop/blocks/top.dql', lifecycle: 'draft' as const, trustState: 'review_required' as const, reviewStatus: 'required' as const };
  const draftWith = (sources: unknown[]) => ({
    version: 3, id: 'build_1', appId: 'orders-app', name: 'Orders', revision: 2, proposalHash: 'hash',
    authoringMode: 'manual', template: 'blank', sourcePolicy: 'governed_only', state: 'local_draft',
    frame: { goal: 'Orders', metrics: [], dimensions: [], filters: [] }, requirements: [], coverage: [],
    sources,
    pages: [{
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'orders_ds', sourceId: checkedTable.id, sourceRevision: 'r', snapshotId: 's', contractFingerprint: 'c' }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
        { i: 'kpi', x: 0, y: 0, w: 3, h: 2, title: 'Orders', sourceId: checkedTable.id, sourceRevision: 'r', query: { dimensions: [], measures: [{ measure: 'order_count' }], respectsGlobalFilters: true }, viz: { type: 'single_value' } },
        { i: 'top', x: 3, y: 0, w: 3, h: 2, title: 'Top', block: { ref: 'domains/shop/blocks/top.dql' }, sourceId: savedQuery.id, viz: { type: 'table' } },
      ] },
    }],
    previewReceipts: [{ id: 'run', pageId: 'overview', revision: 2, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'x', createdAt: '' }],
    reviewTasks: [], createdAt: '', updatedAt: '',
  }) as never;
  const dialog = (draft: never, onCertifySource = vi.fn()) => renderToStaticMarkup(
    <studio.PublishReadinessDialog
      draft={draft}
      serverIssues={['APP_BUILD_DATASET_NOT_CERTIFIED: Orders uses Orders, which is checked but not certified yet. Certify it before publishing.']}
      busy={false}
      previewRun={null}
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onRunPreview={vi.fn()}
      onRunAllPreviews={vi.fn()}
      onRemoveRequirement={vi.fn()}
      onReviseRequirement={vi.fn()}
      onAnswerQuestion={vi.fn()}
      onResolveTask={vi.fn()}
      onOpenSources={vi.fn()}
      onOpenFilters={vi.fn()}
      onRefreshSources={vi.fn()}
      onApproveSemantic={vi.fn()}
      onRemoveLocalAnalysis={vi.fn()}
      onCertifySource={onCertifySource}
      sourceName={(source) => (source.id === checkedTable.id ? 'orders' : 'top_customers')}
    />,
  );

  it('lists each tile not certified yet with "Certify now (recommended)", and still publishes (T3)', () => {
    const markup = dialog(draftWith([checkedTable]));
    expect(markup).toContain('Ready to publish');
    expect(markup).toContain('aria-label="2 tiles not certified yet"');
    expect(markup).toContain('Checked, not certified yet. Data: Orders.');
    expect(markup).toContain('aria-label="Certify now: Orders"');
    expect(markup).toContain('Certify now (recommended)');
    expect(markup).toContain('Readers will see \u2018Not certified yet\u2019 on 2 tiles.');
    // The server's old message about the same data is listed once, not again as a separate fix.
    expect(markup).not.toContain('Complete governed validation');
    expect(markup).not.toMatch(/fix before publishing|Only certified data|Needs certifying|Checked ·/);
  });

  it('a saved query not certified yet gets its own Certify now (it opens the saved query, for now)', () => {
    const markup = dialog(draftWith([checkedTable, savedQuery]));
    expect(markup).toContain('aria-label="Certify now: Top Customers"');
    expect(markup).not.toContain('Local analysis cannot publish');
  });

  it('is ready once the data is certified', () => {
    const certified = { ...checkedTable, lifecycle: 'certified' as const, trustState: 'certified' as const, reviewStatus: 'not_required' as const, checked: undefined };
    const markup = renderToStaticMarkup(
      <studio.PublishReadinessDialog
        draft={draftWith([certified])}
        serverIssues={[]}
        busy={false}
        previewRun={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onRunPreview={vi.fn()}
        onRunAllPreviews={vi.fn()}
        onRemoveRequirement={vi.fn()}
        onReviseRequirement={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onResolveTask={vi.fn()}
        onOpenSources={vi.fn()}
        onOpenFilters={vi.fn()}
        onRefreshSources={vi.fn()}
        onApproveSemantic={vi.fn()}
        onRemoveLocalAnalysis={vi.fn()}
      />,
    );
    expect(markup).toContain('Ready to publish');
    expect(markup).toContain('1 of 2 tiles certified');
    // Only the saved query, whose card is not in this App's data, is still listed.
    expect(markup).not.toContain('aria-label="Not certified yet: Orders"');
    expect(markup).toContain('aria-label="Not certified yet: Top"');
  });
});

describe('tile settings row count (B14)', () => {
  it('says how many rows the tile holds when it holds only the first rows', () => {
    expect(studio.liveRowsLabel(935, 500)).toBe('Live · 935 rows · first 500 loaded');
    expect(studio.liveRowsLabel(10, 10)).toBe('Live · 10 rows');
    expect(studio.liveRowsLabel(1)).toBe('Live · 1 row');
  });
});
