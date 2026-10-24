import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatasetGrainProofV1, ManifestBlock, MetricCapabilityContract } from '@zlens/core';
import {
  SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH,
  loadSavedQueryResultColumns,
  recordSavedQueryResultColumns,
  savedQueryResultDescriptorFromManifestBlock,
} from './result-columns.js';
import { appSourceTrustTier } from '../app-source-catalog.js';
import {
  datasetBindingAuthorityForManifestBlock,
  datasetBlockProofMaterial,
  datasetDescriptorFromManifestBlock,
  datasetDescriptorFromSemanticMetrics,
  datasetDescriptorFromSemanticMetric,
} from './registry.js';

function blockFixture(): ManifestBlock {
  return {
    name: 'order_lines_dataset',
    filePath: 'domains/commerce/blocks/order_lines_dataset.dql',
    domain: 'commerce',
    status: 'certified',
    blockType: 'custom',
    sql: 'SELECT order_line_id, order_date, region, net_amount, cost_amount FROM order_lines',
    rawTableRefs: ['order_lines'],
    tableDependencies: ['raw.commerce.order_lines'],
    refDependencies: [],
    allDependencies: ['raw.commerce.order_lines'],
    tests: [],
    datasetGrain: {
      entities: ['order_line'],
      keys: ['order_line_id'],
      keyEvidence: 'proof.order-lines',
      timeGrain: 'day',
    },
    datasetFields: [
      { name: 'order_line_id', role: 'key', type: 'string' },
      { name: 'order_date', role: 'time', type: 'date', grains: ['day', 'month'], primary: true },
      { name: 'region', role: 'dimension', type: 'string' },
      { name: 'net_amount', role: 'attribute', type: 'number' },
      { name: 'cost_amount', role: 'attribute', type: 'number' },
    ],
    datasetMeasures: [
      { name: 'net_amount', aggregation: 'sum', from: 'net_amount', additive: 'additive', allowedAggs: ['sum'] },
      { name: 'margin_rate', aggregation: 'ratio', numerator: 'net_amount', denominator: 'cost_amount', additive: 'semi_additive', allowedAggs: ['ratio'] },
    ],
  };
}

function proofFor(block: ManifestBlock, sourceRevision = 'source-v1', targetFingerprint = 'warehouse-a'): DatasetGrainProofV1 {
  const material = datasetBlockProofMaterial({ block, sourceId: 'commerce::block::order_lines_dataset', sourceRevision });
  if (!material) throw new Error('fixture must be a dataset');
  return {
    version: 1,
    id: 'proof.order-lines',
    status: 'passed',
    sourceFingerprint: sourceRevision,
    queryFingerprint: material.queryFingerprint,
    keyFingerprint: material.keyFingerprint,
    parameterFingerprint: material.parameterFingerprint,
    targetFingerprint,
    snapshotId: material.scope.snapshotId,
    snapshotFingerprint: material.scope.snapshotFingerprint,
    checkedAt: '2026-09-10T00:00:00.000Z',
    uniqueness: { rowCount: 4, distinctKeyCount: 4, nullKeyCount: 0, duplicateKeyCount: 0 },
  };
}

function authorityFor(block: ManifestBlock, sourceRevision = 'source-v1', targetFingerprint = 'warehouse-a') {
  const authority = datasetBindingAuthorityForManifestBlock({
    block,
    sourceId: 'commerce::block::order_lines_dataset',
    sourceRevision,
    runtimeSnapshotId: 'runtime-snapshot',
    activeTargetFingerprint: targetFingerprint,
  });
  if (!authority) throw new Error('fixture must have authority');
  return authority;
}

function semanticCapability(): MetricCapabilityContract {
  return {
    metricId: 'semantic:commerce:metric:net_amount',
    semanticModelId: 'semantic:commerce:model:orders',
    measureIds: ['semantic:commerce:measure:net_amount'],
    primaryEntityId: 'semantic:commerce:entity:order_line',
    defaultResultGrainId: 'semantic:commerce:entity:order_line',
    resultGrainIds: ['semantic:commerce:entity:order_line'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [{
      dimensionId: 'semantic:commerce:dimension:region',
      entityId: 'semantic:commerce:entity:order_line',
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      label: 'Region',
      nativeGroupingReference: 'region',
    }],
    timeDimensions: [{
      dimensionId: 'semantic:commerce:dimension:order_date',
      role: 'event_time',
      supportedGrains: ['day', 'month'],
      defaultFor: ['scalar', 'trend'],
    }],
    operations: ['filter', 'group', 'trend', 'rank', 'having'],
    supportedOutputKinds: ['metric_value', 'dimension', 'rank'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    sourceFingerprint: 'semantic-contract-v1',
  };
}

describe('dataset registry', () => {
  it('binds certified block datasets to a caller-provided current target and scoped proof', () => {
    const block = blockFixture();
    const proof = proofFor(block);
    const result = datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map([[proof.id, proof]]),
      authority: authorityFor(block),
    });

    expect(result.proofState).toBe('valid');
    expect(result.descriptor).toMatchObject({
      lifecycle: 'certified',
      trust: 'certified',
      binding: { state: 'valid', activeTargetFingerprint: 'warehouse-a' },
    });
    expect(result.descriptor?.operations).toContain('detail');
  });

  it('keeps declared lifecycle visible before a target is connected and fails stale proofs closed', () => {
    const block = blockFixture();
    const proof = proofFor(block);
    const discovery = datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map([[proof.id, proof]]),
    });
    const changedTarget = datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map([[proof.id, proof]]),
      authority: authorityFor(block, 'source-v1', 'warehouse-b'),
    });
    const changedSource = datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v2',
      proofs: new Map([[proof.id, proof]]),
      authority: authorityFor(block, 'source-v2'),
    });

    expect(discovery).toMatchObject({ proofState: 'target_required', descriptor: { lifecycle: 'certified', trust: 'certified', binding: { state: 'target_required' } } });
    // The declared capability is visible for authoring, while the target
    // binding remains the runtime gate for executing it.
    expect(discovery.descriptor?.operations).toContain('detail');
    expect(changedTarget).toMatchObject({ proofState: 'stale', descriptor: { binding: { state: 'stale' } } });
    expect(changedSource).toMatchObject({ proofState: 'stale', descriptor: { binding: { state: 'stale' } } });
  });

  it('only exposes aggregate grouping controls after the declared native time-bucket contract is complete', () => {
    const aggregate = blockFixture();
    aggregate.datasetGrain = {
      entities: ['customer_day'],
      keys: ['order_line_id', 'order_date'],
      keyEvidence: 'proof.order-lines',
      timeGrain: 'day',
      timeBucketBy: 'order_date',
      aggregate: true,
    };
    const ready = datasetDescriptorFromManifestBlock({
      block: aggregate,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map(),
    });
    const missingBucket = datasetDescriptorFromManifestBlock({
      block: { ...aggregate, datasetGrain: { ...aggregate.datasetGrain, timeBucketBy: undefined } },
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map(),
    });

    expect(ready.descriptor?.operations).toEqual(expect.arrayContaining(['group', 'trend', 'compare', 'rank']));
    expect(missingBucket.descriptor?.operations).not.toEqual(expect.arrayContaining(['group', 'trend', 'compare', 'rank']));
  });

  it('projects a calculated measure only after binding its exact approved physical dependencies', () => {
    const block = blockFixture();
    block.datasetMeasures = [
      ...(block.datasetMeasures ?? []),
      {
        name: 'gross_margin',
        aggregation: 'sum',
        expression: 'SUM(net_amount) - SUM(cost_amount)',
        additive: 'additive',
        allowedAggs: ['sum'],
      },
    ];
    const proof = proofFor(block);
    const result = datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map([[proof.id, proof]]),
      authority: authorityFor(block),
    });
    expect(result.descriptor?.fields).toContainEqual(expect.objectContaining({
      kind: 'measure',
      name: 'gross_margin',
      dependsOn: ['cost_amount', 'net_amount'],
      expressionFingerprint: expect.stringMatching(/^sha256:/),
    }));
  });

  it('fails closed rather than exposing a calculated measure with an unbound input or mismatched aggregation', () => {
    const block = blockFixture();
    block.datasetMeasures = [{
      name: 'unsafe_margin',
      aggregation: 'sum',
      expression: 'SUM(secret_amount) / NULLIF(SUM(net_amount), 0)',
      additive: 'non_additive',
      allowedAggs: ['sum'],
    }];
    expect(datasetDescriptorFromManifestBlock({
      block,
      sourceId: 'commerce::block::order_lines_dataset',
      sourceRevision: 'source-v1',
      proofs: new Map(),
    })).toMatchObject({ proofState: 'not_a_dataset', reason: expect.stringContaining('calculated_expression_invalid') });
  });

  it('projects semantic datasets only from the exact per-metric capability', () => {
    const capability = semanticCapability();
    const projected = datasetDescriptorFromSemanticMetric({
      sourceId: 'semantic:commerce:model:orders:metric:net_amount',
      sourceRevision: 'semantic-source-v1',
      measureName: 'net_amount',
      semanticReference: 'orders.net_amount',
      label: 'Net amount',
      lifecycle: 'certified',
      capability,
      fields: [
        { name: 'region', qualifiedId: 'semantic:commerce:dimension:region', semanticReference: 'region', type: 'string', role: 'dimension', status: 'approved' },
        { name: 'order_date', qualifiedId: 'semantic:commerce:dimension:order_date', semanticReference: 'order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      ],
    });
    const rejected = datasetDescriptorFromSemanticMetric({
      sourceId: 'semantic:commerce:model:orders:metric:net_amount',
      sourceRevision: 'semantic-source-v1',
      measureName: 'net_amount',
      semanticReference: 'orders.net_amount',
      label: 'Net amount',
      lifecycle: 'certified',
      capability: { ...capability, executionCapabilities: [{ route: 'governed_sql' }] },
      fields: [],
    });

    expect(projected.proofState).toBe('target_required');
    expect(projected.descriptor).toMatchObject({
      kind: 'semantic',
      execution: { route: 'semantic', adapterId: 'native' },
      operations: expect.arrayContaining(['filter', 'group', 'trend', 'rank', 'having']),
    });
    expect(projected.descriptor?.operations).not.toContain('compare');
    expect(projected.descriptor?.operations).not.toContain('detail');
    expect(rejected).toEqual({ proofState: 'not_a_dataset', reason: 'semantic_capability_incomplete' });
  });

  it('projects comparison only when every selected semantic metric declares comparison outputs and authority', () => {
    const capability = {
      ...semanticCapability(),
      operations: [...semanticCapability().operations, 'compare'] as const,
      supportedOutputKinds: [...semanticCapability().supportedOutputKinds, 'delta', 'percent_delta'] as const,
    };
    const projected = datasetDescriptorFromSemanticMetric({
      sourceId: 'semantic:commerce:model:orders:metric:net_amount',
      sourceRevision: 'semantic-source-v1',
      measureName: 'net_amount',
      semanticReference: 'orders.net_amount',
      label: 'Net amount',
      lifecycle: 'certified',
      capability,
      fields: [
        { name: 'region', qualifiedId: 'semantic:commerce:dimension:region', semanticReference: 'region', type: 'string', role: 'dimension', status: 'approved' },
        { name: 'order_date', qualifiedId: 'semantic:commerce:dimension:order_date', semanticReference: 'order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      ],
    });

    expect(projected.descriptor?.operations).toContain('compare');
    expect(datasetDescriptorFromSemanticMetrics({
      sourceId: 'app:semantic:commerce:orders',
      sourceRevision: 'semantic-model-source-v1',
      semanticModelId: 'semantic:commerce:model:orders',
      label: 'Orders',
      lifecycle: 'certified',
      measures: [
        { measureName: 'net_amount', semanticReference: 'orders.net_amount', capability, fields: [{ name: 'order_date', qualifiedId: 'semantic:commerce:dimension:order_date', semanticReference: 'order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } }] },
        { measureName: 'order_count', semanticReference: 'orders.order_count', capability: { ...semanticCapability(), metricId: 'semantic:commerce:metric:order_count', measureIds: ['semantic:commerce:measure:order_count'] }, fields: [{ name: 'order_date', qualifiedId: 'semantic:commerce:dimension:order_date', semanticReference: 'order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } }] },
      ],
    }).descriptor?.operations).not.toContain('compare');
  });

  it('groups compatible semantic measures under one model source without merging their authority', () => {
    const netAmount = semanticCapability();
    const orderCount: MetricCapabilityContract = {
      ...semanticCapability(),
      metricId: 'semantic:commerce:metric:order_count',
      measureIds: ['semantic:commerce:measure:order_count'],
      aggregation: 'count_distinct',
      sourceFingerprint: 'semantic-contract-v2',
      // The source only advertises operations every selected metric accepts.
      operations: ['filter', 'group', 'trend', 'having'],
    };
    const fields = [
      { name: 'region', qualifiedId: 'semantic:commerce:dimension:region', semanticReference: 'region', type: 'string' as const, role: 'dimension' as const, status: 'approved' as const },
      { name: 'order_date', qualifiedId: 'semantic:commerce:dimension:order_date', semanticReference: 'order_date', type: 'date' as const, role: 'time' as const, status: 'approved' as const, time: { grains: ['day', 'month'], primary: true } },
    ];
    const projected = datasetDescriptorFromSemanticMetrics({
      sourceId: 'app:semantic:commerce:orders',
      sourceRevision: 'semantic-model-source-v1',
      semanticModelId: 'semantic:commerce:model:orders',
      label: 'Orders',
      lifecycle: 'certified',
      measures: [
        { measureName: 'net_amount', semanticReference: 'orders.net_amount', capability: netAmount, fields },
        { measureName: 'order_count', semanticReference: 'orders.order_count', capability: orderCount, fields },
      ],
    });

    expect(projected.descriptor?.contractRef).toEqual({
      kind: 'semantic_model',
      id: 'semantic:commerce:model:orders',
      fingerprint: 'semantic-model-source-v1',
    });
    expect(projected.descriptor?.fields.filter((field) => field.kind === 'measure')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'net_amount', metricId: netAmount.metricId }),
      expect.objectContaining({ name: 'order_count', metricId: orderCount.metricId }),
    ]));
    expect(projected.descriptor?.operations).toContain('group');
    expect(projected.descriptor?.operations).not.toContain('rank');
  });

  it('fails closed when a model projection has an ambiguous physical name', () => {
    const first = semanticCapability();
    const second: MetricCapabilityContract = {
      ...semanticCapability(),
      metricId: 'semantic:commerce:metric:other',
      measureIds: ['semantic:commerce:measure:other'],
    };
    const result = datasetDescriptorFromSemanticMetrics({
      sourceId: 'app:semantic:commerce:orders',
      sourceRevision: 'semantic-model-source-v1',
      semanticModelId: 'semantic:commerce:model:orders',
      label: 'Orders',
      lifecycle: 'certified',
      measures: [
        { measureName: 'net_amount', semanticReference: 'orders.net_amount', capability: first, fields: [{ name: 'region', qualifiedId: 'semantic:commerce:dimension:region', semanticReference: 'region', type: 'string', role: 'dimension', status: 'approved' }] },
        { measureName: 'other', semanticReference: 'orders.other', capability: second, fields: [{ name: 'region', qualifiedId: 'semantic:commerce:dimension:region_alt', semanticReference: 'region_alt', type: 'string', role: 'dimension', status: 'approved' }] },
      ],
    });
    expect(result).toEqual({ proofState: 'not_a_dataset', reason: 'semantic_field_ambiguous' });
  });
});

describe('saved query result fields (design D1)', () => {
  const savedQuery = (): ManifestBlock => ({
    name: 'monthly_revenue',
    filePath: 'blocks/monthly_revenue.dql',
    domain: 'commerce',
    status: 'certified',
    blockType: 'custom',
    sql: "SELECT date_trunc('month', order_date) AS month, SUM(net_amount) AS gross_revenue FROM order_lines GROUP BY 1",
    rawTableRefs: ['order_lines'],
    tableDependencies: [],
    refDependencies: [],
    allDependencies: [],
    tests: [],
    outputs: [{ name: 'month', sources: [] }, { name: 'gross_revenue', isAggregate: true, sources: [] }],
  });

  it('keeps the columns read for one revision as local state and offers them as fields of that revision only', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-result-columns-'));
    try {
      expect(loadSavedQueryResultColumns(root).size).toBe(0);
      const columns = [{ name: 'month', type: 'date' }, { name: 'gross_revenue', type: 'number' }];
      expect(recordSavedQueryResultColumns(root, { sourceId: 'app:block:commerce:m', sourceRevision: 'sha256:r1', columns, typesFrom: 'probe' })).toBe(true);
      expect(recordSavedQueryResultColumns(root, { sourceId: 'app:block:commerce:m', sourceRevision: 'sha256:r1', columns, typesFrom: 'probe' })).toBe(false);
      expect(JSON.parse(readFileSync(join(root, SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH), 'utf8')).version).toBe(1);
      const observed = loadSavedQueryResultColumns(root).get('app:block:commerce:m');
      const descriptor = savedQueryResultDescriptorFromManifestBlock({ block: savedQuery(), sourceId: 'app:block:commerce:m', sourceRevision: 'sha256:r1', lifecycle: 'certified', observed });
      expect(descriptor).toMatchObject({
        id: 'app:block:commerce:m',
        trust: 'certified',
        contractRef: { kind: 'block_source', id: 'commerce::block::monthly_revenue' },
        result: { savedQuery: 'monthly_revenue', groupBy: ['month'], asIs: [], typesFrom: 'probe' },
      });
      // A changed saved query is read again: the old columns never describe it.
      expect(savedQueryResultDescriptorFromManifestBlock({ block: savedQuery(), sourceId: 'app:block:commerce:m', sourceRevision: 'sha256:r2', lifecycle: 'certified', observed })).toBeUndefined();
      // A block with a Dataset definition, or a semantic block, is not a saved query.
      expect(savedQueryResultDescriptorFromManifestBlock({ block: blockFixture(), sourceId: 'x', sourceRevision: 'sha256:r1', lifecycle: 'certified', observed })).toBeUndefined();
      // A declared contract with every type needs no read.
      const typed = { ...savedQuery(), outputContract: [{ name: 'month', type: 'date' }, { name: 'gross_revenue', type: 'number', role: 'metric' }] };
      expect(savedQueryResultDescriptorFromManifestBlock({ block: typed, sourceId: 'x', sourceRevision: 'sha256:r9', lifecycle: 'review' })).toMatchObject({ trust: 'review_required', result: { typesFrom: 'contract' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a saved query with result fields in the saved query trust tier', () => {
    const descriptor = savedQueryResultDescriptorFromManifestBlock({
      block: { ...savedQuery(), outputContract: [{ name: 'month', type: 'date' }, { name: 'gross_revenue', type: 'number' }] },
      sourceId: 'x', sourceRevision: 'sha256:r1', lifecycle: 'certified',
    })!;
    const capabilities = { measures: [], dimensions: [], outputs: [], filters: [], allowedVisualizations: [], parameters: [] };
    expect(appSourceTrustTier({ kind: 'block', trust: 'certified', capabilities: { ...capabilities, dataset: descriptor } })).toBe(2);
    const { result: _result, ...rowLevel } = descriptor;
    expect(appSourceTrustTier({ kind: 'block', trust: 'certified', capabilities: { ...capabilities, dataset: rowLevel } })).toBe(0);
  });
});
