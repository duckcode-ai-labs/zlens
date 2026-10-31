import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticLayerFromDir } from '@zlens/core';
import { extractTableauWorkbook } from './bi-import/tableau.js';
import {
  approveMetricDrafts,
  approvedText,
  discardMetricDrafts,
  evaluate,
  importDraftsToApprove,
  listMetricDrafts,
  makeImportMetricDrafts,
  MetricDraftApprovalError,
  type MakeImportMetricDraftsInput,
} from './import-metric-drafts.js';
import type { WarehouseTableSummary } from './datasets/table-dataset.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-metric-drafts-'));
  roots.push(root);
  return root;
}

const WORKBOOK = `<?xml version='1.0' encoding='utf-8' ?>
<workbook><datasources>
  <datasource caption='Orders' inline='true' name='federated.abc' version='18.1'>
    <connection class='federated'>
      <named-connections><named-connection caption='db' name='postgres.1'><connection class='postgres' dbname='shop' server='db.acme.internal' /></named-connection></named-connections>
      <relation connection='postgres.1' name='orders' table='[analytics].[orders]' type='table' />
      <metadata-records>
        <metadata-record class='column'><remote-name>Region</remote-name><local-name>[region]</local-name><parent-name>[orders]</parent-name><local-type>string</local-type></metadata-record>
        <metadata-record class='column'><remote-name>sales</remote-name><local-name>[sales]</local-name><parent-name>[orders]</parent-name><local-type>real</local-type></metadata-record>
        <metadata-record class='column'><remote-name>profit</remote-name><local-name>[profit]</local-name><parent-name>[orders]</parent-name><local-type>real</local-type></metadata-record>
        <metadata-record class='column'><remote-name>discount</remote-name><local-name>[discount]</local-name><parent-name>[orders]</parent-name><local-type>real</local-type></metadata-record>
      </metadata-records>
    </connection>
    <column caption='Total Sales' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([sales])' /></column>
    <column caption='East Sales' datatype='real' name='[Calculation_2]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM(IF [region] = &quot;East&quot; THEN [sales] END)' /></column>
    <column caption='Profit Ratio' datatype='real' name='[Calculation_3]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([profit]) / SUM([sales])' /></column>
    <column caption='Discounts' datatype='real' name='[Calculation_4]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([discount])' /></column>
  </datasource>
</datasources></workbook>`;

const TABLES: WarehouseTableSummary[] = [
  { id: 'analytics.orders', name: 'orders', schema: 'analytics', relation: 'analytics.orders', kind: 'table', columns: [{ name: 'Region' }, { name: 'sales' }, { name: 'profit' }, { name: 'discount' }] },
  { id: 'public.orders', name: 'orders', schema: 'public', relation: 'public.orders', kind: 'table', columns: [{ name: 'id' }] },
];

function input(root: string, overrides: Partial<MakeImportMetricDraftsInput> = {}): MakeImportMetricDraftsInput {
  const file = extractTableauWorkbook(WORKBOOK, 'legacy/Sales.twb');
  return {
    projectRoot: root,
    importId: 'imp_test1',
    domain: 'sales',
    owner: 'maya@retail.example',
    calculations: { calculations: file.inventory!.calculations, models: file.models! },
    listTables: async () => TABLES,
    driver: 'postgres',
    connection: { database: 'shop_dev' },
    // One query per table; a query naming `discount` fails, as a column the connection's role cannot read would.
    run: async (sql) => {
      if (/discount/.test(sql)) throw new Error('permission denied for column discount');
      const row: Record<string, unknown> = {};
      const values: Record<string, number> = { 'sum(sales)': 460.74, "sum(case when \"Region\" = 'East' then sales end)": 150.75, 'sum(profit)': 56.09 };
      for (const [expression, column] of Array.from(sql.matchAll(/(?:select |, )(.+?) as (zlens_m\d+)/g), (match) => [match[1]!, match[2]!])) row[column] = values[expression] ?? null;
      return [row];
    },
    check: true,
    now: new Date('2026-10-31T12:00:00Z'),
    ...overrides,
  };
}

describe('the import\'s metric drafts', () => {
  it('places drafts on the connected database\'s table, runs them once, and writes only those that ran', async () => {
    const root = project();
    const record = await makeImportMetricDrafts(input(root));
    expect(record).toMatchObject({ importId: 'imp_test1', written: true, checked: true });
    const byName = Object.fromEntries(record.items.map((item) => [item.calculation, item]));
    expect(byName['Total Sales']).toMatchObject({ outcome: 'drafted', metric: 'total_sales', value: 460.74, path: 'semantic-layer/metrics/_drafts/sales/total_sales.yaml' });
    // Postgres folds unquoted names to lower case, so the column made with capitals is quoted.
    expect(byName['East Sales']).toMatchObject({ outcome: 'drafted', value: 150.75, inWords: `sum(sales) where "Region" = 'East', on analytics.orders` });
    expect(byName['Profit Ratio']).toMatchObject({ outcome: 'drafted', metric: 'profit_ratio', parts: ['sum_of_profit', 'total_sales'] });
    expect(byName['Profit Ratio']!.value).toBeCloseTo(56.09 / 460.74, 10);
    expect(byName.Discounts).toMatchObject({ outcome: 'failed', reason: 'permission denied for column discount' });
    expect(byName.Discounts!.path).toBeUndefined();
    expect(existsSync(join(root, 'semantic-layer/metrics/_drafts/sales/discounts.yaml'))).toBe(false);

    const yaml = readFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/east_sales.yaml'), 'utf-8');
    expect(yaml).toContain('status: draft');
    expect(yaml).toContain('owner: maya@retail.example');
    expect(yaml).toContain('value: 150.75');
    expect(yaml).toContain('The file reads database shop on db.acme.internal; ZLens is connected to shop_dev.');
    // Drafts answer nothing: the layer the project answers from does not have them.
    expect(loadSemanticLayerFromDir(join(root, 'semantic-layer')).listMetrics()).toHaveLength(0);
  });

  it('picks the table by schema, and says when a file\'s table is not in the database', async () => {
    const root = project();
    const missing = await makeImportMetricDrafts(input(root, { listTables: async () => TABLES.filter((table) => table.schema === 'public').map((table) => ({ ...table, name: 'customers' })) }));
    expect(missing.items.find((item) => item.calculation === 'Total Sales')).toMatchObject({ outcome: 'left-out', reason: expect.stringContaining('analytics.orders is not in the connected database') });
  });

  it('writes nothing when the project\'s metrics live in dbt, and lists each definition (M8)', async () => {
    const root = project();
    const record = await makeImportMetricDrafts(input(root, { metricsLiveElsewhere: 'This project\'s metrics live in dbt, so ZLens wrote no metric drafts. Add these definitions there.' }));
    expect(record).toMatchObject({ written: false, checked: false, notWrittenReason: expect.stringContaining('live in dbt') });
    expect(record.items.find((item) => item.calculation === 'East Sales')).toMatchObject({ outcome: 'drafted', inWords: "sum(sales) where Region = 'East', on analytics.orders" });
    expect(existsSync(join(root, 'semantic-layer'))).toBe(false);
  });

  it('writes the drafts without running them with --no-check, and a second import of the same file reuses them', async () => {
    const root = project();
    const unchecked = await makeImportMetricDrafts(input(root, { check: false, run: async () => { throw new Error('should not run'); } }));
    expect(unchecked.checked).toBe(false);
    expect(readFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/total_sales.yaml'), 'utf-8')).toContain('ran: false');
    const again = await makeImportMetricDrafts(input(root, { importId: 'imp_test2', check: false }));
    expect(again.items.find((item) => item.calculation === 'Total Sales')).toMatchObject({ outcome: 'reused', metric: 'total_sales', reason: 'Total Sales is already the metric draft total_sales.' });
    expect(again.items.find((item) => item.calculation === 'Profit Ratio')).toMatchObject({ outcome: 'reused', metric: 'profit_ratio' });
    expect(importDraftsToApprove(root, again).sort()).toEqual(['discounts', 'east_sales', 'profit_ratio', 'total_sales']);
  });
});

describe('approving metric drafts', () => {
  it('moves the draft\'s text out of _drafts with status certified, who and when, and brings a ratio\'s parts', async () => {
    const root = project();
    await makeImportMetricDrafts(input(root));
    const before = readFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/profit_ratio.yaml'), 'utf-8');
    const approved = approveMetricDrafts(root, ['profit_ratio'], 'maya@retail.example', new Date('2026-11-01T09:00:00Z'));
    expect(approved.map((item) => item.name)).toEqual(['sum_of_profit', 'total_sales', 'profit_ratio']);
    expect(approved[2]).toEqual({ name: 'profit_ratio', from: 'semantic-layer/metrics/_drafts/sales/profit_ratio.yaml', to: 'semantic-layer/metrics/sales/profit_ratio.yaml' });
    const after = readFileSync(join(root, 'semantic-layer/metrics/sales/profit_ratio.yaml'), 'utf-8');
    expect(after).toBe(before.replace('status: draft', 'status: certified\napprovedBy: "maya@retail.example"\napprovedAt: 2026-11-01T09:00:00.000Z'));
    const layer = loadSemanticLayerFromDir(join(root, 'semantic-layer'));
    expect(layer.getMetric('profit_ratio')).toMatchObject({ status: 'certified', synonyms: ['Profit Ratio'] });
    expect(layer.composeQuery({ metrics: ['profit_ratio'], dimensions: [], driver: 'postgres' })).not.toBeNull();
    expect(listMetricDrafts(root).map((draft) => draft.name)).toEqual(['east_sales']);
  });

  it('refuses a name a metric already has, and discards on request', async () => {
    const root = project();
    await makeImportMetricDrafts(input(root));
    mkdirSync(join(root, 'semantic-layer/metrics'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer/metrics/east_sales.yaml'), 'name: east_sales\ntype: sum\nsql: amount\ntable: orders\n');
    expect(() => approveMetricDrafts(root, ['east_sales'], 'maya')).toThrow(MetricDraftApprovalError);
    expect(() => approveMetricDrafts(root, ['nope'], 'maya')).toThrow('There is no metric draft named nope.');
    expect(discardMetricDrafts(root, ['east_sales'])).toEqual(['east_sales']);
    expect(listMetricDrafts(root).map((draft) => draft.name)).not.toContain('east_sales');
  });

  it('sets the status line once, adding it when the file has none', () => {
    expect(approvedText('name: a\nstatus: draft\napprovedBy: old\ntype: sum\n', 'me', 'T')).toBe('name: a\nstatus: certified\napprovedBy: "me"\napprovedAt: T\ntype: sum\n');
    expect(approvedText('name: a\ntype: sum\n', 'me', 'T')).toBe('name: a\nstatus: certified\napprovedBy: "me"\napprovedAt: T\ntype: sum\n');
  });
});

describe('a derived draft\'s value from its parts', () => {
  it('evaluates arithmetic with SQL\'s empty values', () => {
    const values: Record<string, number | null> = { a: 56.09, b: 460.74, z: 0, n: null };
    const value = (name: string) => values[name] ?? null;
    expect(evaluate('a / NULLIF(b, 0) * 100', value)).toBeCloseTo(12.1739, 3);
    expect(evaluate('a / NULLIF(z, 0)', value)).toBeNull();
    expect(evaluate('COALESCE(n, 0) - COALESCE(a, 0)', value)).toBeCloseTo(-56.09, 5);
    expect(evaluate('ROUND(-a, 1)', value)).toBe(-56.1);
  });
});
