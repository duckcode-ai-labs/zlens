import { describe, expect, it } from 'vitest';
import {
  datasetAuthoringChangeForDefinition,
  datasetAuthoringChangeForMeasure,
  datasetCalculatedMeasureCandidates,
  datasetSourceDefinitionDraft,
  datasetSourceAuthoringModel,
} from './app-dataset-source-authoring';

const source = {
  id: 'app:block:commerce:daily-customer',
  sourceId: 'app:block:commerce:daily-customer',
  qualifiedIdentity: 'commerce::block::Daily customer Dataset::abc123',
  sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  snapshotId: 'snapshot-a',
  name: 'Daily customer Dataset',
  domain: 'commerce', status: 'certified', owner: null, tags: [],
  path: 'domains/commerce/blocks/customer-daily.dql', fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lastModified: '', description: '', score: 1, reasons: [],
  lifecycle: 'certified' as const, trust: 'certified' as const,
  capabilities: {
    measures: ['revenue'], dimensions: ['order_date'], outputs: [], filters: [], parameters: [],
    dataset: {
      version: 1 as const,
      id: 'app:block:commerce:daily-customer', kind: 'block' as const,
      sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', snapshotId: 'snapshot-a',
      contractRef: { kind: 'block_source' as const, id: 'commerce::block::Daily customer Dataset', fingerprint: 'sha256:contract' },
      binding: { sourceQualifiedId: 'commerce::block::Daily customer Dataset', sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', contractFingerprint: 'sha256:contract', state: 'target_required' as const },
      label: 'Daily customer Dataset', lifecycle: 'certified' as const, trust: 'certified' as const,
      grain: { entityIds: ['customer_day'], keyFields: ['customer_day_id', 'order_date'], keyEvidence: 'proof.customer-day', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
      fields: [
        { kind: 'physical' as const, name: 'customer_day_id', qualifiedId: 'field:key', type: 'string' as const, role: 'key' as const, status: 'approved' as const },
        { kind: 'physical' as const, name: 'order_date', qualifiedId: 'field:date', type: 'date' as const, role: 'time' as const, status: 'approved' as const, time: { grains: ['day', 'month'], primary: true } },
        { kind: 'physical' as const, name: 'daily_revenue', qualifiedId: 'field:revenue', type: 'number' as const, role: 'attribute' as const, status: 'approved' as const },
        { kind: 'physical' as const, name: 'daily_margin', qualifiedId: 'field:margin', type: 'number' as const, role: 'attribute' as const, status: 'approved' as const },
        { kind: 'physical' as const, name: 'daily_orders', qualifiedId: 'field:orders', type: 'number' as const, role: 'attribute' as const, status: 'approved' as const },
        { kind: 'measure' as const, name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum' as const, from: 'daily_revenue', dependsOn: ['daily_revenue'], additivity: { entities: 'additive' as const, time: 'additive' as const }, allowedAggs: ['sum' as const], format: { kind: 'currency' as const, currency: 'USD' }, status: 'approved' as const },
      ],
      operations: ['filter', 'group'], execution: { route: 'governed_sql' as const },
    },
  },
  eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
} as any;

describe('Dataset source authoring proposal model (APP-055)', () => {
  it('projects native grain evidence and reviewable candidates from exact approved physical fields', () => {
    const model = datasetSourceAuthoringModel(source);
    expect(model?.grain).toMatchObject({ keys: ['customer_day_id', 'order_date'], timeBucketBy: 'order_date', keyEvidence: 'proof.customer-day' });
    expect(model?.candidates.map((candidate) => [candidate.id, candidate.expression, candidate.additivity])).toEqual([
      ['candidate:gross_margin', 'SUM(daily_revenue) - SUM(daily_margin)', 'non_additive'],
      ['candidate:margin_rate', 'SUM(daily_margin) / NULLIF(SUM(daily_revenue), 0)', 'non_additive'],
      ['candidate:average_order_value', 'SUM(daily_revenue) / NULLIF(SUM(daily_orders), 0)', 'non_additive'],
    ]);
  });

  it('builds a complete hash-bound source patch without changing source trust or silently declaring additivity', () => {
    const descriptor = source.capabilities.dataset;
    const change = datasetAuthoringChangeForMeasure(source, descriptor, {
      name: 'gross_margin', expression: 'SUM(daily_revenue) - SUM(daily_margin)', aggregation: 'sum',
      additivity: 'non_additive', format: 'currency', currency: 'USD',
    });
    expect(change).toMatchObject({
      targetQualifiedId: source.qualifiedIdentity,
      targetPath: source.path,
      expectedSourceHash: source.sourceRevision,
      patch: {
        grain: { timeBucketBy: 'order_date' },
        fields: expect.arrayContaining([expect.objectContaining({ name: 'daily_revenue', role: 'attribute' })]),
        measures: expect.arrayContaining([
          expect.objectContaining({ name: 'revenue', additive: 'additive', entityAdditive: 'additive' }),
          expect.objectContaining({ name: 'gross_margin', expression: 'SUM(daily_revenue) - SUM(daily_margin)', additive: 'non_additive', allowedAggs: ['sum'] }),
        ]),
      },
    });
    expect(datasetCalculatedMeasureCandidates(descriptor).every((candidate) => candidate.evidence.includes('proof') || candidate.evidence.includes('Candidate') || candidate.evidence.includes('Ratio'))).toBe(true);
  });

  it('prepares reviewed native-grain, key, time-role, and time-grain changes without inventing a physical field', () => {
    const descriptor = source.capabilities.dataset;
    const definition = datasetSourceDefinitionDraft(descriptor);
    definition.grain.entities = 'customer_day, region_day';
    definition.grain.keys = 'customer_day_id, order_date';
    definition.grain.keyEvidence = 'proof:customer-day-v2';
    definition.grain.timeGrain = 'day';
    definition.grain.timeBucketBy = 'order_date';
    definition.grain.aggregate = true;
    const date = definition.fields.find((field) => field.name === 'order_date')!;
    date.grains = 'day, month, quarter';
    date.primary = true;
    const revenue = definition.fields.find((field) => field.name === 'daily_revenue')!;
    revenue.role = 'dimension';

    const change = datasetAuthoringChangeForDefinition(source, descriptor, definition);
    expect(change.patch.grain).toEqual(expect.objectContaining({
      entities: ['customer_day', 'region_day'], keys: ['customer_day_id', 'order_date'],
      keyEvidence: 'proof:customer-day-v2', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true,
    }));
    expect(change.patch.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'order_date', role: 'time', grains: ['day', 'month', 'quarter'], primary: true }),
      expect.objectContaining({ name: 'daily_revenue', role: 'dimension' }),
    ]));
    expect(change.patch.fields?.find((field) => field.name === 'daily_revenue')).not.toHaveProperty('type');
    expect(change.patch.fields?.find((field) => field.name === 'daily_revenue')).not.toHaveProperty('status');
    expect(change.patch.measures).toHaveLength(1);

    expect(() => datasetAuthoringChangeForDefinition(source, descriptor, {
      ...definition,
      fields: [...definition.fields, { ...definition.fields[0]!, name: 'invented_browser_field' }],
    })).toThrow('compiled from this source');
  });

  it('refuses a no-op declaration and a time bucket whose field is not a date/time role', () => {
    const descriptor = source.capabilities.dataset;
    expect(() => datasetAuthoringChangeForDefinition(source, descriptor, datasetSourceDefinitionDraft(descriptor)))
      .toThrow('Change a field role');
    const definition = datasetSourceDefinitionDraft(descriptor);
    definition.grain.timeBucketBy = 'daily_revenue';
    expect(() => datasetAuthoringChangeForDefinition(source, descriptor, definition)).toThrow('Time bucket');
  });

  it('does not invent a Dataset authoring target for semantic sources or duplicate a measure', () => {
    expect(datasetSourceAuthoringModel({ ...source, capabilities: { ...source.capabilities, dataset: { ...source.capabilities.dataset, kind: 'semantic' } } })).toBeUndefined();
    // A saved query's result fields (design D1) are read, never authored here.
    expect(datasetSourceAuthoringModel({ ...source, capabilities: { ...source.capabilities, dataset: { ...source.capabilities.dataset, result: { savedQuery: 'orders', groupBy: [], asIs: [], typesFrom: 'probe' } } } })).toBeUndefined();
    expect(() => datasetAuthoringChangeForMeasure(source, source.capabilities.dataset, {
      name: 'revenue', expression: 'SUM(daily_revenue)', aggregation: 'sum', additivity: 'non_additive', format: 'number',
    })).toThrow('already exists');
  });
});
