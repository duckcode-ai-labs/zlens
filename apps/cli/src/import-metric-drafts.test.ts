import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDialect, loadSemanticLayerFromDir } from '@zlens/core';
import { extractTableauWorkbook } from './bi-import/tableau.js';
import {
  approveMetricDrafts,
  approvedText,
  discardMetricDrafts,
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
        <metadata-record class='column'><remote-name>ordered_at</remote-name><local-name>[ordered_at]</local-name><parent-name>[orders]</parent-name><local-type>date</local-type></metadata-record>
      </metadata-records>
    </connection>
    <column caption='Total Sales' datatype='real' name='[Calculation_1]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([sales])' /></column>
    <column caption='East Sales' datatype='real' name='[Calculation_2]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM(IF [region] = &quot;East&quot; THEN [sales] END)' /></column>
    <column caption='Profit Ratio' datatype='real' name='[Calculation_3]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([profit]) / SUM([sales])' /></column>
    <column caption='Discounts' datatype='real' name='[Calculation_4]' role='measure' type='quantitative'><calculation class='tableau' formula='SUM([discount])' /></column>
  </datasource>
</datasources></workbook>`;

const TABLES: WarehouseTableSummary[] = [
  { id: 'analytics.orders', name: 'orders', schema: 'analytics', relation: 'analytics.orders', kind: 'table', columns: [{ name: 'Region' }, { name: 'sales' }, { name: 'profit' }, { name: 'discount' }, { name: 'ordered_at' }] },
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
      // A ratio's value comes from the SQL the semantic layer composes for it.
      if (/ratio_inputs/.test(sql)) return [{ profit_ratio: 56.09 / 460.74 }];
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
    // The second import only found them waiting: they are the first import's to approve.
    expect(importDraftsToApprove(root, again)).toEqual([]);
    expect(importDraftsToApprove(root, unchecked).sort()).toEqual(['discounts', 'east_sales', 'profit_ratio', 'total_sales']);
  });

  it('runs a ratio through the SQL the layer composes, and does not write one the database refuses', async () => {
    const root = project();
    const sent: string[] = [];
    const record = await makeImportMetricDrafts(input(root, {
      run: async (sql) => {
        sent.push(sql);
        if (/discount/.test(sql)) throw new Error('permission denied for column discount');
        if (/ratio_inputs/.test(sql)) throw new Error('function round(double precision, integer) does not exist');
        return [{ zlens_m0: 1, zlens_m1: 2, zlens_m2: 3 }];
      },
    }));
    expect(sent.some((sql) => sql.includes('1.0 * ratio_inputs.sum_of_profit / NULLIF(ratio_inputs.total_sales, 0)'))).toBe(true);
    expect(record.items.find((item) => item.calculation === 'Profit Ratio')).toMatchObject({ outcome: 'failed', reason: 'function round(double precision, integer) does not exist' });
    expect(existsSync(join(root, 'semantic-layer/metrics/_drafts/sales/profit_ratio.yaml'))).toBe(false);
  });

  it('says when the file reads another schema or server, and keeps a check value out of the files with a host', async () => {
    const root = project();
    const record = await makeImportMetricDrafts(input(root, {
      listTables: async () => [{ ...TABLES[0]!, schema: 'staging', id: 'staging.orders' }],
      connection: { database: 'shop', server: 'localhost' },
      privateValues: true,
    }));
    const notes = record.items.find((item) => item.calculation === 'Total Sales')!.notes.join(' ');
    expect(notes).toContain('The file reads server db.acme.internal; ZLens is connected to localhost.');
    expect(notes).toContain('The file reads analytics.orders; ZLens found staging.orders, the only table of that name.');
    expect(record.items.find((item) => item.calculation === 'Total Sales')!.value).toBe(460.74);
    const yaml = readFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/total_sales.yaml'), 'utf-8');
    expect(yaml).toContain('ran: true');
    expect(yaml).not.toContain('460.74');
  });

  it('quotes reserved words, and escapes text the way each database reads it', async () => {
    const root = project();
    const record = await makeImportMetricDrafts(input(root, {
      listTables: async () => [{ ...TABLES[0]!, name: 'orders', columns: [{ name: 'Region' }, { name: 'sales' }, { name: 'user' }, { name: 'discount' }, { name: 'profit' }] }],
      calculations: (() => {
        const file = extractTableauWorkbook(WORKBOOK.replace('<remote-name>discount</remote-name>', '<remote-name>user</remote-name>'), 'legacy/Sales.twb');
        return { calculations: file.inventory!.calculations, models: file.models! };
      })(),
      check: false,
    }));
    expect(record.items.find((item) => item.calculation === 'Discounts')!.inWords).toBe('sum("user"), on analytics.orders');
    expect(getDialect('postgresql').quoteString("it's \\ ok")).toBe("'it''s \\ ok'");
    expect(getDialect('snowflake').quoteString("it's \\ ok")).toBe("'it''s \\\\ ok'");
  });
});

describe('approving metric drafts', () => {
  it('moves the draft\'s text out of _drafts with status certified, who and when, and brings a ratio\'s parts', async () => {
    const root = project();
    await makeImportMetricDrafts(input(root));
    const before = readFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/profit_ratio.yaml'), 'utf-8');
    const approved = approveMetricDrafts(root, ['profit_ratio'], 'maya@retail.example', new Date('2026-11-01T09:00:00Z'));
    expect(approved.filter((item) => !item.dimension).map((item) => item.name)).toEqual(['sum_of_profit', 'total_sales', 'profit_ratio']);
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

  it('brings the columns of a metric\'s table as dimensions, so the metric can group by them', async () => {
    const root = project();
    const record = await makeImportMetricDrafts(input(root));
    expect(record.dimensions.map((dimension) => dimension.name)).toEqual(['region', 'ordered_at']);
    expect(record.dimensions[0]).toMatchObject({ table: 'analytics.orders', path: 'semantic-layer/dimensions/_drafts/sales/region.yaml' });
    // Drafts answer nothing, and a metric alone cannot group.
    expect(loadSemanticLayerFromDir(join(root, 'semantic-layer')).listDimensions()).toHaveLength(0);

    const approved = approveMetricDrafts(root, ['total_sales'], 'maya');
    expect(approved.filter((item) => item.dimension).map((item) => item.to)).toEqual(['semantic-layer/dimensions/sales/ordered_at.yaml', 'semantic-layer/dimensions/sales/region.yaml']);
    expect(readFileSync(join(root, 'semantic-layer/dimensions/sales/region.yaml'), 'utf-8')).toContain('status: certified');
    const layer = loadSemanticLayerFromDir(join(root, 'semantic-layer'));
    expect(layer.getDimension('ordered_at')).toMatchObject({ isTimeDimension: true, type: 'date', sql: 'ordered_at' });
    const byRegion = layer.composeQuery({ metrics: ['total_sales'], dimensions: ['region'], driver: 'postgres' });
    expect(byRegion?.sql).toContain('"Region" AS region');
    expect(byRegion?.sql).toContain('GROUP BY "Region"');
    const byMonth = layer.composeQuery({ metrics: ['total_sales'], dimensions: [], timeDimension: { name: 'ordered_at', granularity: 'month' }, driver: 'postgres' });
    expect(byMonth?.sql).toContain("DATE_TRUNC('month'");

    // A second import finds them on the column, and drafts none again.
    const again = await makeImportMetricDrafts(input(root, { importId: 'imp_test2' }));
    expect(again.dimensions).toEqual([]);
  });

  it('takes dimension drafts away with the last metric draft on their table', async () => {
    const root = project();
    await makeImportMetricDrafts(input(root));
    discardMetricDrafts(root, ['east_sales']);
    expect(existsSync(join(root, 'semantic-layer/dimensions/_drafts/sales/region.yaml'))).toBe(true);
    discardMetricDrafts(root, ['total_sales', 'sum_of_profit', 'profit_ratio']);
    expect(existsSync(join(root, 'semantic-layer/dimensions/_drafts'))).toBe(false);
  });

  it('writes no dimension for a table with no metric written, or when the metrics live in dbt', async () => {
    const root = project();
    const none = await makeImportMetricDrafts(input(root, { run: async () => { throw new Error('nope'); } }));
    expect(none.dimensions).toEqual([]);
    expect(existsSync(join(root, 'semantic-layer/dimensions'))).toBe(false);
    const dbt = await makeImportMetricDrafts(input(root, { metricsLiveElsewhere: 'dbt' }));
    expect(dbt.dimensions).toEqual([]);
  });

  it('moves all of them or none, and refuses a part that is gone', async () => {
    const root = project();
    await makeImportMetricDrafts(input(root));
    // The ratio's target is taken, so its parts must not move either.
    mkdirSync(join(root, 'semantic-layer/metrics/sales'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer/metrics/sales/profit_ratio.yaml'), 'not yaml a metric: [');
    expect(() => approveMetricDrafts(root, ['profit_ratio'], 'maya')).toThrow('already exists');
    expect(existsSync(join(root, 'semantic-layer/metrics/_drafts/sales/total_sales.yaml'))).toBe(true);
    rmSync(join(root, 'semantic-layer/metrics/sales/profit_ratio.yaml'));
    discardMetricDrafts(root, ['sum_of_profit', 'sum_of_profit']);
    expect(() => approveMetricDrafts(root, ['profit_ratio'], 'maya')).toThrow('built from sum_of_profit, which is neither a metric nor a draft');
  });

  it('uses the file\'s real path, refuses a name that leaves the folder, and will not split a file of several metrics', () => {
    const root = project();
    const drafts = join(root, 'semantic-layer/metrics/_drafts/sales');
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(root, 'victim.txt'), 'keep me');
    writeFileSync(join(drafts, 'bad_path.yaml'), 'name: bad_path\ntype: sum\nsql: a\ntable: t\nstatus: draft\nsource:\n  extra:\n    path: ../victim.txt\n');
    writeFileSync(join(drafts, 'bad_name.yaml'), 'name: ../../../pwned\ntype: sum\nsql: a\ntable: t\nstatus: draft\n');
    writeFileSync(join(drafts, 'pair.yaml'), 'metrics:\n  - name: m1\n    type: sum\n    sql: a\n    table: t\n  - name: m2\n    type: sum\n    sql: b\n    table: t\n');
    expect(discardMetricDrafts(root, ['bad_path'])).toEqual(['bad_path']);
    expect(readFileSync(join(root, 'victim.txt'), 'utf-8')).toBe('keep me');
    expect(existsSync(join(drafts, 'bad_path.yaml'))).toBe(false);
    expect(() => approveMetricDrafts(root, ['../../../pwned'], 'maya')).toThrow('not a plain name');
    expect(() => approveMetricDrafts(root, ['m1'], 'maya')).toThrow('holds several metrics');
    expect(() => discardMetricDrafts(root, ['m1'])).toThrow('holds several metrics');
    expect(existsSync(join(drafts, 'pair.yaml'))).toBe(true);
  });

  it('sets the status line once, adding it when the file has none', () => {
    expect(approvedText('name: a\nstatus: draft\napprovedBy: old\ntype: sum\n', 'me', 'T')).toBe('name: a\nstatus: certified\napprovedBy: "me"\napprovedAt: T\ntype: sum\n');
    expect(approvedText('name: a\ntype: sum\n', 'me', 'T')).toBe('name: a\nstatus: certified\napprovedBy: "me"\napprovedAt: T\ntype: sum\n');
  });
});
