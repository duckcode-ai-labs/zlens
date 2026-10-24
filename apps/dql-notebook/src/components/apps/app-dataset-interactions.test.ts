import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import { savedQueryResultDescriptor } from '@zlens/core/datasets/result-fields';
import type { DashboardDocumentResponse } from '../../api/client';
import {
  buildDatasetCrossFilter,
  datasetAffectedTileIds,
  datasetCrossFilterFields,
  datasetHierarchyDrillCandidates,
  datasetMarkActions,
  datasetMarkSelectionForRow,
  buildDatasetHierarchyDrill,
  appendDatasetHierarchyDrill,
  popDatasetHierarchyDrill,
  proposeDatasetCrossFilterLinks,
  carriedNavigationVariables,
  replaceDatasetCrossFilter,
} from './app-dataset-interactions';

const page = {
  version: 3,
  id: 'overview',
  metadata: { title: 'Overview' },
  datasets: [
    { id: 'orders', sourceId: 'source-orders', sourceRevision: 'sha256:orders', snapshotId: 'snapshot', contractFingerprint: 'sha256:contract' },
    { id: 'customers', sourceId: 'source-customers', sourceRevision: 'sha256:customers', snapshotId: 'snapshot', contractFingerprint: 'sha256:contract-customers' },
  ],
  interactions: {
    crossFilter: {
      enabled: true,
      mappings: [{ fromTileId: 'orders-by-region', fromField: 'region', toDataset: 'customers', toField: 'region' }],
    },
  },
  layout: {
    kind: 'grid', cols: 12, rowHeight: 80,
    items: [{
      i: 'orders-by-region', x: 0, y: 0, w: 6, h: 4,
      sourceId: 'source-orders', sourceRevision: 'sha256:orders',
      query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      viz: { type: 'bar' },
    }],
  },
} as unknown as DashboardDocumentResponse['dashboard'];

describe('published Dataset interactions (APP-041)', () => {
  it('allows only a declared source-tile dimension mapping and keeps its source revision', () => {
    const tile = page.layout.items[0]!;
    expect(datasetCrossFilterFields(page, tile)).toEqual(['region']);
    expect(buildDatasetCrossFilter(page, tile, 'region', ['CA', 'CA', null])).toEqual({
      crossFilter: {
        fromTileId: 'orders-by-region',
        fromSourceId: 'source-orders',
        fromSourceRevision: 'sha256:orders',
        field: 'region',
        values: ['CA'],
      },
    });
  });

  it('does not turn a matching output name into a field-name-only mapping', () => {
    const tile = page.layout.items[0]!;
    const noMapping = {
      ...page,
      interactions: { crossFilter: { mappings: [] } },
    } as DashboardDocumentResponse['dashboard'];
    // Keep only on the tile's own Dataset is the same field, not a guess (RFC 0009 step 6a).
    expect(buildDatasetCrossFilter(noMapping, tile, 'region', ['CA']).crossFilter).toMatchObject({ field: 'region', values: ['CA'] });
    // Without its own Dataset binding on the page, a matching name links nothing.
    const unbound = { ...noMapping, datasets: [] } as DashboardDocumentResponse['dashboard'];
    expect(buildDatasetCrossFilter(unbound, tile, 'region', ['CA'])).toMatchObject({ error: expect.stringContaining('No filter link is set up') });
  });

  it('replaces only the same source-qualified result mark', () => {
    const current = [{ fromTileId: 'orders-by-region', fromSourceId: 'source-orders', fromSourceRevision: 'sha256:orders', field: 'region', values: ['CA'] }];
    expect(replaceDatasetCrossFilter(current, {
      fromTileId: 'orders-by-region', fromSourceId: 'source-orders', fromSourceRevision: 'sha256:orders', field: 'region', values: ['US'],
    })).toEqual([{ fromTileId: 'orders-by-region', fromSourceId: 'source-orders', fromSourceRevision: 'sha256:orders', field: 'region', values: ['US'] }]);
  });

  it('uses the same declared-field selection for a chart mark and a table row', () => {
    expect(datasetMarkSelectionForRow(['region'], { region: 'CA', revenue: 60 })).toEqual({ field: 'region', values: ['CA'] });
    expect(datasetMarkSelectionForRow(['region'], { region: null, revenue: 60 })).toBeUndefined();
  });

  it('schedules only the declared source and mapped Dataset targets for a mark refresh', () => {
    const withTarget = {
      ...page,
      layout: {
        ...page.layout,
        items: [
          ...page.layout.items,
          {
            i: 'customers-by-region', x: 6, y: 0, w: 6, h: 4,
            sourceId: 'source-customers', sourceRevision: 'sha256:customers',
            query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'customer_count' }] },
            viz: { type: 'table' },
          },
          {
            i: 'unrelated-orders', x: 0, y: 4, w: 6, h: 4,
            sourceId: 'source-orders', sourceRevision: 'sha256:orders-other',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] },
            viz: { type: 'kpi' },
          },
        ],
      },
    } as DashboardDocumentResponse['dashboard'];

    expect(datasetAffectedTileIds(withTarget, [{
      fromTileId: 'orders-by-region',
      fromSourceId: 'source-orders',
      fromSourceRevision: 'sha256:orders',
      field: 'region',
      values: ['CA'],
    }])).toEqual(['customers-by-region', 'orders-by-region']);
  });

  it('builds a drill only from an explicit active Dataset hierarchy and retains the selected physical key', () => {
    const descriptor = hierarchyDescriptor();
    const query = {
      dimensions: [{ field: 'customer_id' }],
      measures: [{ measure: 'revenue' }],
      orderBy: [{ alias: 'customer_id', direction: 'asc' as const }],
    };
    expect(datasetHierarchyDrillCandidates(descriptor, query)).toEqual([
      { hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id' },
    ]);
    // Never offered when the runtime would refuse it (RFC 0009 evaluation E4):
    // the next level is already grouped, or the tile shows row details.
    expect(datasetHierarchyDrillCandidates(descriptor, { ...query, dimensions: [{ field: 'customer_id' }, { field: 'order_id' }] })).toEqual([]);
    expect(datasetHierarchyDrillCandidates(descriptor, { ...query, detail: true, detailColumns: ['customer_id', 'order_id'], limit: 100 })).toEqual([]);
    expect(buildDatasetHierarchyDrill(descriptor, query, 'customer_id', { customer_id: 'C-001', revenue: 70 })).toMatchObject({
      status: 'ready',
      candidate: { hierarchyId: 'commerce_customer_orders', toField: 'order_id' },
      query: {
        dimensions: [{ field: 'order_id' }],
        filters: [{ field: 'customer_id', op: 'eq', values: ['C-001'] }],
        orderBy: [{ alias: 'order_id', direction: 'asc' }],
      },
    });
    // An attractive display label has no authority to choose a relationship.
    expect(buildDatasetHierarchyDrill(descriptor, query, 'Customer', { Customer: 'C-001' })).toMatchObject({
      status: 'blocked',
      code: 'HIERARCHY_UNKNOWN',
    });
  });

  it('keeps viewer hierarchy exploration as a source-qualified ephemeral stack and supports Back', () => {
    const first = appendDatasetHierarchyDrill([], 'orders-by-customer', {
      hierarchyId: 'commerce_customer_orders',
      fromField: 'customer_id',
      fromAlias: 'customer_id',
      toField: 'order_id',
    }, { customer_id: 'C-001', revenue: 70 });
    expect(first).toEqual({
      drills: [{
        tileId: 'orders-by-customer',
        steps: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', values: ['C-001'] }],
      }],
    });
    const second = appendDatasetHierarchyDrill(first.drills!, 'orders-by-customer', {
      hierarchyId: 'commerce_order_lines',
      fromField: 'order_id',
      fromAlias: 'order_id',
      toField: 'order_line_id',
    }, { order_id: 'O-100' });
    expect(second.drills?.[0]?.steps).toHaveLength(2);
    expect(popDatasetHierarchyDrill(second.drills!, 'orders-by-customer')).toEqual(first.drills);
    expect(appendDatasetHierarchyDrill([], 'orders-by-customer', {
      hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id',
    }, { customer_id: null })).toMatchObject({ error: expect.stringContaining('concrete') });
  });

  it('makes a mapped filter and each server-declared hierarchy transition separate mark actions', () => {
    expect(datasetMarkActions(['customer_id'], [
      { hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'order_id' },
      { hierarchyId: 'commerce_customer_contacts', fromField: 'customer_id', fromAlias: 'customer_id', toField: 'contact_id' },
    ])).toEqual([
      { id: 'filter', kind: 'filter' },
      expect.objectContaining({ kind: 'drill', candidate: expect.objectContaining({ toField: 'order_id' }) }),
      expect.objectContaining({ kind: 'drill', candidate: expect.objectContaining({ toField: 'contact_id' }) }),
    ]);
  });
});

function hierarchyDescriptor(): DatasetDescriptor {
  return {
    version: 1,
    id: 'app:block:commerce:orders',
    kind: 'block',
    sourceRevision: 'sha256:orders',
    snapshotId: 'snapshot',
    contractRef: { kind: 'block_source', id: 'commerce::orders', fingerprint: 'sha256:contract' },
    binding: {
      sourceQualifiedId: 'commerce::orders',
      sourceRevision: 'sha256:orders',
      contractFingerprint: 'sha256:contract',
      state: 'valid',
    },
    label: 'Orders',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'customer_id', qualifiedId: 'customer_id', type: 'string', role: 'dimension', status: 'approved', hierarchy: { id: 'commerce_customer_orders', level: 0 } },
      { kind: 'physical', name: 'order_id', qualifiedId: 'order_id', type: 'string', role: 'dimension', status: 'approved', hierarchy: { id: 'commerce_customer_orders', level: 1 } },
      { kind: 'physical', name: 'net_amount', qualifiedId: 'net_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
    ],
    operations: ['filter', 'group'],
    execution: { route: 'governed_sql' },
  };
}

describe('cross-filter link proposals', () => {
  const physical = (name: string, type: string, status = 'approved') => ({ kind: 'physical', name, qualifiedId: `f.${name}`, type, role: 'dimension', status });
  const descriptor = (label: string, fields: unknown[]) => ({ label, fields }) as never;
  const orders = descriptor('Orders', [physical('region', 'string'), physical('order_date', 'date')]);
  const revenue = descriptor('Revenue model', [physical('region', 'string')]);
  const targets = descriptor('Targets', [physical('region', 'number')]);
  const page = {
    id: 'overview',
    datasets: [
      { id: 'orders', sourceId: 's.orders', sourceRevision: 'r1' },
      { id: 'revenue', sourceId: 's.revenue', sourceRevision: 'r1' },
      { id: 'targets', sourceId: 's.targets', sourceRevision: 'r1' },
    ],
    layout: { items: [] },
  } as never;
  const byId: Record<string, unknown> = { orders, revenue, targets };
  const tile = { i: 'by-region', sourceId: 's.orders', sourceRevision: 'r1', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } } as never;

  it('proposes only same-name, same-type approved fields and leaves the choice to the author', () => {
    const proposal = proposeDatasetCrossFilterLinks({ page, tile, descriptorFor: (binding) => byId[binding.id] as never });
    expect(proposal).toEqual({
      fromField: 'region',
      fieldLabel: 'region',
      mappings: [
        { fromTileId: 'by-region', fromField: 'region', toDataset: 'orders', toField: 'region' },
        { fromTileId: 'by-region', fromField: 'region', toDataset: 'revenue', toField: 'region' },
      ],
      targetLabels: ['Orders', 'Revenue model'],
    });
  });

  it('proposes nothing once the field is mapped, or for time and detail tiles', () => {
    const mapped = { ...(page as object), interactions: { crossFilter: { mappings: [{ fromTileId: 'by-region', fromField: 'region', toDataset: 'orders', toField: 'region' }] } } } as never;
    expect(proposeDatasetCrossFilterLinks({ page: mapped, tile, descriptorFor: (binding) => byId[binding.id] as never })).toBeUndefined();
    const monthly = { ...(tile as object), query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] } } as never;
    expect(proposeDatasetCrossFilterLinks({ page, tile: monthly, descriptorFor: (binding) => byId[binding.id] as never })).toBeUndefined();
    const detail = { ...(tile as object), query: { dimensions: [], measures: [], detail: true, detailColumns: ['region'], limit: 10 } } as never;
    expect(proposeDatasetCrossFilterLinks({ page, tile: detail, descriptorFor: (binding) => byId[binding.id] as never })).toBeUndefined();
  });
});

describe('carrying a clicked mark into a detail page', () => {
  const page = {
    id: 'overview',
    datasets: [{ id: 'orders', sourceId: 's.orders', sourceRevision: 'r1' }],
    filters: [
      { id: 'region', type: 'multiselect', datasetBindings: { orders: { field: 'region' } } },
      { id: 'channel', type: 'select', datasetBindings: { orders: { field: 'channel' } } },
    ],
    layout: { items: [] },
  } as never;
  const tile = { i: 'by-region', sourceId: 's.orders', sourceRevision: 'r1', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } } as never;
  const mark = { fromTileId: 'by-region', fromSourceId: 's.orders', fromSourceRevision: 'r1', field: 'region', values: ['US'] };

  it('uses the clicked values for a carried filter bound to the same field', () => {
    expect(carriedNavigationVariables({ page, tile, carryFilterIds: ['region'], variables: {}, crossFilters: [mark] })).toEqual({ region: ['US'] });
  });

  it('keeps an explicit page value, ignores other fields, and ignores marks from other tiles', () => {
    expect(carriedNavigationVariables({ page, tile, carryFilterIds: ['region'], variables: { region: ['CA'] }, crossFilters: [mark] })).toEqual({ region: ['CA'] });
    expect(carriedNavigationVariables({ page, tile, carryFilterIds: ['channel'], variables: {}, crossFilters: [mark] })).toEqual({});
    expect(carriedNavigationVariables({ page, tile, carryFilterIds: ['region'], variables: {}, crossFilters: [{ ...mark, fromTileId: 'other' }] })).toEqual({});
  });
});

describe('click-to-filter on a saved query\'s result fields (design D1)', () => {
  const result = savedQueryResultDescriptor({
    sourceId: 'source-top', sourceRevision: 'sha256:top', savedQuery: 'top_customers', qualifiedId: 'orders::block::top_customers',
    lifecycle: 'certified', certified: true, typesFrom: 'probe',
    columns: [{ name: 'customer_name', type: 'VARCHAR' }, { name: 'lifetime_spend', type: 'DOUBLE' }],
  })!;
  const orders = savedQueryResultDescriptor({
    sourceId: 'source-lines', sourceRevision: 'sha256:lines', savedQuery: 'order_lines', qualifiedId: 'orders::block::order_lines',
    lifecycle: 'certified', certified: true, typesFrom: 'probe',
    columns: [{ name: 'customer_name', type: 'VARCHAR' }, { name: 'net_amount', type: 'DOUBLE' }],
  })!;
  const resultPage = {
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [
      { id: 'top', sourceId: 'source-top', sourceRevision: 'sha256:top', snapshotId: 's', contractFingerprint: result.contractRef.fingerprint },
      { id: 'lines', sourceId: 'source-lines', sourceRevision: 'sha256:lines', snapshotId: 's', contractFingerprint: orders.contractRef.fingerprint },
    ],
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      items: [{
        i: 'spend', x: 0, y: 0, w: 6, h: 4, sourceId: 'source-top', sourceRevision: 'sha256:top',
        query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] }, viz: { type: 'bar' },
      }],
    },
  } as unknown as DashboardDocumentResponse['dashboard'];

  it('keeps only a clicked customer on the tile\'s own saved query, and offers to link the same column elsewhere', () => {
    const tile = resultPage.layout.items[0]!;
    expect(buildDatasetCrossFilter(resultPage, tile, 'customer_name', ['Ada'])).toEqual({
      crossFilter: { fromTileId: 'spend', fromSourceId: 'source-top', fromSourceRevision: 'sha256:top', field: 'customer_name', values: ['Ada'] },
    });
    const proposal = proposeDatasetCrossFilterLinks({
      page: resultPage,
      tile,
      descriptorFor: (binding) => (binding.id === 'top' ? result : orders) as DatasetDescriptor,
    });
    expect(proposal?.mappings).toEqual([
      { fromTileId: 'spend', fromField: 'customer_name', toDataset: 'top', toField: 'customer_name' },
      { fromTileId: 'spend', fromField: 'customer_name', toDataset: 'lines', toField: 'customer_name' },
    ]);
  });
});
