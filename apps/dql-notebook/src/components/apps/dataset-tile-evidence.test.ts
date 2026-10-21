import { describe, expect, it } from 'vitest';
import { tileQueryHash, type TileQuery } from '@zlens/core/apps/tile-query';
import type { DashboardRunResponse } from '../../api/client';
import {
  datasetTileNotices,
  isCurrentDatasetTileEvidence,
  presentDatasetTileEvidence,
} from './dataset-tile-evidence';

const query: TileQuery = {
  dimensions: [{ field: 'region' }],
  measures: [{ measure: 'revenue' }],
};

const actualNestedBlockRuntimeTile = {
  tileId: 'revenue-by-region',
  status: 'ok' as const,
  tileType: 'dataset' as const,
  result: {
    columns: ['region', 'revenue'],
    rows: [{ region: 'CA', revenue: 60 }],
    rowCount: 1,
  },
  artifact: {
    version: 1 as const,
    sourceKind: 'dataset_query' as const,
    name: 'Revenue by region',
    sourcePath: 'blocks/order-lines.dqld',
    authoredQuerySpec: JSON.stringify({
      version: 3,
      kind: 'dataset_tile_query',
      boundParameterEvidence: [{ name: 'as_of', kind: 'string', valueFingerprint: 'sha256:parameter-a' }],
    }),
    sql: 'WITH ds AS (SELECT * FROM order_lines) SELECT region, SUM(net_amount) AS revenue FROM ds WHERE region = ?',
    trustState: 'certified' as const,
    executionTarget: { target: 'connection' as const, connectionName: 'warehouse' },
  },
  dataset: {
    sourceId: 'source.order-lines',
    sourceRevision: 'sha256:source-a',
    contractFingerprint: 'sha256:contract-a',
    authoredQueryFingerprint: tileQueryHash(query),
    parameterEvidence: [{ name: 'as_of', kind: 'string' as const, valueFingerprint: 'sha256:parameter-a' }],
    executionProvenance: {
      version: 1 as const,
      kind: 'block_runtime' as const,
      sourceId: 'source.order-lines',
      sourceRevision: 'sha256:source-a',
      contractFingerprint: 'sha256:contract-a',
      queryFingerprint: 'sha256:query-a',
      filterFingerprint: 'sha256:filter-a',
      executionFingerprint: 'sha256:execution-a',
      parameterFingerprint: 'sha256:parameters-a',
      compiledSqlFingerprint: 'sha256:compiled-a',
      executedSqlFingerprint: 'sha256:executed-a',
      resultFingerprint: 'sha256:result-a',
      targetFingerprint: 'sha256:target-a',
    },
  },
} satisfies DashboardRunResponse['tiles'][number];

describe('Dataset execution evidence presentation (APP-030)', () => {
  it('projects actual nested block runtime SQL and provenance without parameter values or a fabricated provider receipt', () => {
    const presentation = presentDatasetTileEvidence(actualNestedBlockRuntimeTile);

    expect(presentation).toMatchObject({
      executedSql: expect.stringContaining('WITH ds AS'),
      authoredQuerySpec: expect.stringContaining('dataset_tile_query'),
      receipt: {
        kind: 'provider_receipt_unavailable',
        notice: expect.stringContaining('No provider execution receipt'),
      },
    });
    expect(presentation?.parameterEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Parameter 1', value: 'as_of · string' }),
      expect.objectContaining({ label: 'as_of binding', value: 'sha256:parameter-a' }),
    ]));
    expect(presentation?.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Execution target', value: 'sha256:target-a' }),
      expect.objectContaining({ label: 'Executed SQL', value: 'sha256:executed-a' }),
    ]));
    expect(JSON.stringify(presentation)).not.toContain('2026-09-11');
  });

  it('whitelists a semantic provider receipt and never serializes arbitrary provider fields', () => {
    const semanticTile = {
      ...actualNestedBlockRuntimeTile,
      dataset: {
        ...actualNestedBlockRuntimeTile.dataset,
        executionProvenance: { ...actualNestedBlockRuntimeTile.dataset.executionProvenance, kind: 'semantic_runtime' as const },
        semanticReceipt: {
          receiptId: 'semantic-receipt:1',
          runId: 'semantic-run:1',
          snapshotId: 'semantic-snapshot:1',
          adapterId: 'native',
          executionTargetFingerprint: 'sha256:target-a',
          compiledSqlFingerprint: 'sha256:compiled-a',
          executedSqlFingerprint: 'sha256:executed-a',
          parameterFingerprint: 'sha256:semantic-parameters',
          queryId: 'query-1',
          resultFingerprint: 'sha256:result-a',
          outcome: 'succeeded',
          rowCount: 1,
          providerSecret: 'must-not-be-presented',
        },
      },
    } satisfies DashboardRunResponse['tiles'][number];

    const presentation = presentDatasetTileEvidence(semanticTile);
    expect(presentation?.receipt).toMatchObject({
      kind: 'semantic_provider_receipt',
      rows: expect.arrayContaining([
        expect.objectContaining({ label: 'Receipt', value: 'semantic-receipt:1' }),
        expect.objectContaining({ label: 'Adapter', value: 'native' }),
        expect.objectContaining({ label: 'Returned rows', value: '1' }),
      ]),
    });
    expect(JSON.stringify(presentation)).not.toContain('must-not-be-presented');
  });

  it('rejects retained evidence after a source or TileQuery change and reports unavailable provider SQL honestly', () => {
    expect(isCurrentDatasetTileEvidence({
      sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a', query,
    }, actualNestedBlockRuntimeTile)).toBe(true);
    expect(isCurrentDatasetTileEvidence({
      sourceId: 'source.order-lines', sourceRevision: 'sha256:source-b', query,
    }, actualNestedBlockRuntimeTile)).toBe(false);
    expect(isCurrentDatasetTileEvidence({
      sourceId: 'source.order-lines', sourceRevision: 'sha256:source-a',
      query: { dimensions: [], measures: [{ measure: 'revenue' }] },
    }, actualNestedBlockRuntimeTile)).toBe(false);

    const noSql = presentDatasetTileEvidence({
      ...actualNestedBlockRuntimeTile,
      artifact: { ...actualNestedBlockRuntimeTile.artifact, sql: undefined },
    });
    expect(noSql?.executedSql).toBeUndefined();
    expect(noSql?.executedSqlUnavailable).toContain('Provider SQL was unavailable');
  });
});

describe('dataset tile notices shared by Studio and the viewer', () => {
  it('names excluded and unlinked page filters and discloses grain adaptations', () => {
    const notices = datasetTileNotices({
      tileId: 't1', status: 'ok', tileType: 'dataset',
      dataset: {
        unboundFilters: [
          { filterId: 'region', code: 'DATASET_TILE_EXCLUDED', message: 'Region is excluded from Revenue by month.' },
          { filterId: 'sales_channel', code: 'FILTER_MAPPING_MISSING', message: 'Sales channel is not mapped to Orders.' },
        ],
        validation: { outcome: 'adapted', adaptations: [{ kind: 'aggregate_time_rollup', message: "Rolled up from the Dataset's day grain to month." }] },
      },
    } as never);
    expect(notices.map((notice) => [notice.kind, notice.label])).toEqual([
      ['excluded', 'Not filtered by region'],
      ['not_linked', 'Not filtered by sales channel'],
      ['adapted', 'Rolled up over time'],
    ]);
    expect(notices[2]?.detail).toContain('day grain to month');
  });

  it('says a tile rolled up a saved query\'s certified result (design D1)', () => {
    const notices = datasetTileNotices({
      tileId: 't1', status: 'ok', tileType: 'dataset',
      dataset: { unboundFilters: [], validation: { outcome: 'adapted', adaptations: [{ kind: 'saved_query_rollup', message: 'Rolled up from the certified result of monthly_revenue.' }] } },
    } as never);
    expect(notices).toEqual([{ key: 'adaptation:saved_query_rollup', kind: 'adapted', label: 'Rolled up from a saved query', detail: 'Rolled up from the certified result of monthly_revenue.' }]);
  });

  it('says nothing for a covered tile with every filter applied', () => {
    expect(datasetTileNotices({ tileId: 't1', status: 'ok', dataset: { unboundFilters: [], validation: { outcome: 'covered', adaptations: [] } } } as never)).toEqual([]);
    expect(datasetTileNotices(undefined)).toEqual([]);
  });
});
