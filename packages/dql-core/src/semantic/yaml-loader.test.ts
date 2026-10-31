import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSemanticLayerFromDir, loadSemanticMetricDraftsFromDir } from './yaml-loader.node.js';
import { serializeMetricDefinitionToYaml } from './yaml-loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadSemanticLayerFromDir', () => {
  it('serializes composted metric YAML that round-trips through the loader', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-serializer-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');
    mkdirSync(join(semanticDir, 'metrics', '_drafts', 'finance'), { recursive: true });

    const yaml = serializeMetricDefinitionToYaml({
      name: 'completed_revenue',
      label: 'Completed Revenue',
      description: 'Draft metric composted from certified block usage.',
      domain: 'finance',
      status: 'draft',
      sql: 'SUM(amount)',
      type: 'sum',
      table: 'fact_orders',
      filter: "status = 'completed'",
      tags: ['composted', 'human-review'],
      owner: 'analytics@example.com',
      source: {
        provider: 'dql',
        objectType: 'composted_metric',
        objectId: 'composted:completed_revenue',
        extra: {
          support: 2,
          donorBlocks: ['revenue_by_product', 'revenue_by_region'],
        },
      },
    });
    writeFileSync(join(semanticDir, 'metrics', '_drafts', 'finance', 'completed_revenue.yaml'), yaml);

    // A draft answers nothing: the layer skips `_drafts/`, and review reads it on its own.
    expect(loadSemanticLayerFromDir(semanticDir).getMetric('completed_revenue')).toBeUndefined();
    const metric = loadSemanticMetricDraftsFromDir(semanticDir).find((draft) => draft.name === 'completed_revenue');

    expect(metric).toMatchObject({
      name: 'completed_revenue',
      domain: 'finance',
      status: 'draft',
      sql: 'SUM(amount)',
      type: 'sum',
      table: 'fact_orders',
      filter: "status = 'completed'",
      owner: 'analytics@example.com',
    });
    expect(metric?.source?.extra?.support).toBe(2);
    expect(metric?.source?.extra?.path).toBe('metrics/_drafts/finance/completed_revenue.yaml');
  });

  it('never lets a draft replace the metric of the same name', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-drafts-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');
    mkdirSync(join(semanticDir, 'metrics', '_drafts', 'sales'), { recursive: true });
    mkdirSync(join(semanticDir, 'dimensions', '_drafts'), { recursive: true });
    writeFileSync(join(semanticDir, 'metrics', 'revenue.yaml'), 'name: revenue\ntype: sum\nsql: amount\ntable: orders\nstatus: certified\n');
    writeFileSync(join(semanticDir, 'metrics', '_drafts', 'sales', 'revenue.yaml'), 'name: revenue\ntype: sum\nsql: amount * 2\ntable: orders\nstatus: draft\n');
    writeFileSync(join(semanticDir, 'dimensions', '_drafts', 'region.yaml'), 'name: region\nsql: region\ntable: orders\n');

    const layer = loadSemanticLayerFromDir(semanticDir);
    expect(layer.getMetric('revenue')).toMatchObject({ sql: 'amount', status: 'certified' });
    expect(layer.getDimension('region')).toBeUndefined();
    expect(loadSemanticMetricDraftsFromDir(semanticDir).map((draft) => draft.sql)).toEqual(['amount * 2']);
  });

  it('reads and writes synonyms', () => {
    const yaml = serializeMetricDefinitionToYaml({
      name: 'east_sales',
      label: 'East Sales',
      description: '',
      domain: 'sales',
      sql: 'sales',
      type: 'sum',
      table: 'orders',
      filter: "region = 'East'",
      synonyms: ['East Sales', 'eastern revenue'],
    });
    expect(yaml).toContain('synonyms:');
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-synonyms-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'metrics'), { recursive: true });
    writeFileSync(join(root, 'metrics', 'east_sales.yaml'), yaml);
    writeFileSync(join(root, 'metrics', 'orders.yaml'), 'name: order_count\ntype: count\nsql: "*"\ntable: orders\nsynonyms: orders placed\n');
    const layer = loadSemanticLayerFromDir(root);
    expect(layer.getMetric('east_sales')?.synonyms).toEqual(['East Sales', 'eastern revenue']);
    expect(layer.getMetric('order_count')?.synonyms).toEqual(['orders placed']);
  });

  it('loads nested semantic folders recursively, including segments and pre-aggregations', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-loader-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');

    mkdirSync(join(semanticDir, 'metrics', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'dimensions', 'finance', 'orders'), { recursive: true });
    mkdirSync(join(semanticDir, 'segments', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'pre_aggregations', 'finance'), { recursive: true });
    mkdirSync(join(semanticDir, 'cubes', 'finance'), { recursive: true });

    writeFileSync(join(semanticDir, 'metrics', 'finance', 'gross_revenue.yaml'), [
      'name: gross_revenue',
      'label: Gross Revenue',
      'description: Imported flat metric',
      'domain: finance',
      'status: certified',
      'sql: |',
      '  SUM(amount)',
      'type: sum',
      'table: fact_orders',
      'tags:',
      '  - finance',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'dimensions', 'finance', 'orders', 'sales_channel.yaml'), [
      'name: sales_channel',
      'label: Sales Channel',
      'description: Channel dimension',
      'domain: finance',
      'status: review',
      'sql: |',
      '  channel',
      'type: string',
      'table: fact_orders',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'segments', 'finance', 'high_value_orders.yaml'), [
      'name: high_value_orders',
      'label: High Value Orders',
      'description: Orders above threshold',
      'domain: finance',
      'cube: orders',
      'sql: |',
      '  amount > 1000',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'pre_aggregations', 'finance', 'orders_daily_rollup.yaml'), [
      'name: orders_daily_rollup',
      'label: Orders Daily Rollup',
      'description: Daily rollup for finance',
      'domain: finance',
      'cube: orders',
      'measures:',
      '  - order_total',
      'dimensions:',
      '  - order_status',
      'time_dimension: ordered_at',
      'granularity: day',
      'refresh_key: every 1 hour',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'cubes', 'finance', 'orders.yaml'), [
      'name: orders',
      'label: Orders',
      'description: Finance orders cube',
      'domain: finance',
      'table: fact_orders',
      'sql: |',
      '  SELECT * FROM fact_orders',
      'measures:',
      '  - name: order_total',
      '    label: Order Total',
      '    description: Cube metric',
      '    sql: |',
      '      SUM(amount)',
      '    type: sum',
      'dimensions:',
      '  - name: order_status',
      '    label: Order Status',
      '    description: Order status',
      '    sql: |',
      '      status',
      '    type: string',
      'time_dimensions:',
      '  - name: ordered_at',
      '    label: Ordered At',
      '    description: Order timestamp',
      '    sql: |',
      '      ordered_at',
      '    granularities:',
      '      - day',
      '      - month',
      '',
    ].join('\n'));

    const layer = loadSemanticLayerFromDir(semanticDir);

    expect(layer.getMetric('gross_revenue')?.domain).toBe('finance');
    expect(layer.getMetric('gross_revenue')?.status).toBe('certified');
    expect(layer.getDimension('sales_channel')?.domain).toBe('finance');
    expect(layer.getDimension('sales_channel')?.status).toBe('review');
    expect(layer.getCube('orders')?.measures.map((metric) => metric.name)).toContain('order_total');
    expect(layer.listSegments('finance').map((segment) => segment.name)).toEqual(['high_value_orders']);
    expect(layer.listPreAggregations('finance').map((preAggregation) => preAggregation.name)).toEqual(['orders_daily_rollup']);
    expect(layer.getTimeDimension('ordered_at')).toMatchObject({
      isTimeDimension: true,
      granularities: ['day', 'month'],
    });
    expect(layer.listDomains()).toEqual(['finance']);
    expect(layer.listTags()).toContain('finance');
  });

  it('loads plural collection YAML files without creating blank wrapper definitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-loader-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');

    mkdirSync(join(semanticDir, 'metrics'), { recursive: true });
    mkdirSync(join(semanticDir, 'dimensions'), { recursive: true });

    writeFileSync(join(semanticDir, 'metrics', 'banking.yaml'), [
      'metrics:',
      '  - name: fraud_exposure',
      '    label: Fraud Exposure',
      '    description: Confirmed and review fraud exposure',
      '    domain: risk',
      '    sql: |',
      '      SUM(fraud_amount)',
      '    type: sum',
      '    table: fraud_alerts',
      '  - name: deposit_balance',
      '    label: Deposit Balance',
      '    description: Current deposit balances',
      '    domain: deposits',
      '    sql: |',
      '      SUM(balance)',
      '    type: sum',
      '    table: deposits',
      '',
    ].join('\n'));

    writeFileSync(join(semanticDir, 'dimensions', 'banking.yaml'), [
      'dimensions:',
      '  - name: region',
      '    label: Region',
      '    description: Bank operating region',
      '    domain: banking',
      '    sql: region',
      '    type: string',
      '    table: branches',
      '',
    ].join('\n'));

    const layer = loadSemanticLayerFromDir(semanticDir);

    expect(layer.listMetrics().map((metric) => metric.name).sort()).toEqual(['deposit_balance', 'fraud_exposure']);
    expect(layer.listDimensions().map((dimension) => dimension.name)).toEqual(['region']);
    expect(layer.getMetric('fraud_exposure')?.source).toMatchObject({
      provider: 'dql',
      objectType: 'metric',
      objectId: 'fraud_exposure',
      extra: { path: 'metrics/banking.yaml' },
    });
    expect(layer.getDimension('region')?.source).toMatchObject({
      provider: 'dql',
      objectType: 'dimension',
      objectId: 'region',
      extra: { path: 'dimensions/banking.yaml' },
    });
    expect(layer.getMetric('')).toBeUndefined();
    expect(layer.getDimension('')).toBeUndefined();
  });

  it('loads native model and entity declarations for model-scoped semantic datasets', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-semantic-native-model-'));
    tempDirs.push(root);
    const semanticDir = join(root, 'semantic-layer');
    mkdirSync(join(semanticDir, 'cubes'), { recursive: true });
    mkdirSync(join(semanticDir, 'entities'), { recursive: true });
    mkdirSync(join(semanticDir, 'semantic_models'), { recursive: true });

    writeFileSync(join(semanticDir, 'cubes', 'orders.yaml'), [
      'name: orders',
      'domain: commerce',
      'table: order_lines',
      'measures:',
      '  - name: semantic_revenue',
      '    sql: SUM(net_amount)',
      '    type: sum',
      'dimensions:',
      '  - name: region',
      '    sql: region',
      '    type: string',
      'time_dimensions:',
      '  - name: order_date',
      '    sql: order_date',
      '    granularities: [day, month]',
      '',
    ].join('\n'));
    writeFileSync(join(semanticDir, 'entities', 'order_line.yaml'), [
      'name: order_line',
      'cube: orders',
      'table: order_lines',
      'type: primary',
      'expr: order_line_id',
      '',
    ].join('\n'));
    writeFileSync(join(semanticDir, 'semantic_models', 'orders.yaml'), [
      'name: orders',
      'domain: commerce',
      'table: order_lines',
      'entities: [order_line]',
      'measures: [semantic_revenue]',
      'dimensions: [region]',
      'time_dimensions: [order_date]',
      '',
    ].join('\n'));

    const layer = loadSemanticLayerFromDir(semanticDir);

    expect(layer.getEntity('order_line')).toMatchObject({
      cube: 'orders',
      type: 'primary',
      source: { objectType: 'entity' },
    });
    expect(layer.getSemanticModel('orders')).toMatchObject({
      entities: ['order_line'],
      measures: ['semantic_revenue'],
      dimensions: ['region'],
      timeDimensions: ['order_date'],
      source: { objectType: 'semantic_model' },
    });
    expect(layer.listMeasures().map((measure) => measure.name)).toContain('semantic_revenue');
  });
});
