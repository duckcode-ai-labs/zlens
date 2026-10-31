import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DimensionDefinition, MetricDefinition } from '@zlens/core';
import { extractTableauWorkbook } from '../bi-import/tableau.js';
import { matchReportMarkdown, matchWords, readComparisonDetail, readMatchRecords, writeComparisonDetail, writeMatchRecords } from './record.js';
import { readExport } from './read-export.js';
import { compareOptionProblem, ComparisonStopped, ExportRefused, queryFingerprint, runComparison, type CompareDeps, type CompareRequest } from './run.js';

const metric = (name: string, label: string, extra: Partial<MetricDefinition> = {}): MetricDefinition => ({ name, label, description: '', domain: 'sales', type: 'sum', sql: name, table: 'analytics.orders', ...extra });
const dimension = (name: string, label: string, extra: Partial<DimensionDefinition> = {}): DimensionDefinition => ({ name, label, description: '', sql: name, type: 'string', table: 'analytics.orders', ...extra });

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function deps(rows: Array<Record<string, unknown>>, overrides: Partial<CompareDeps> = {}): CompareDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    catalog: {
      metrics: [
        metric('total_sales', 'Total Sales', { sql: 'sales' }),
        metric('east_sales', 'East Sales', { sql: 'sales', filter: "region = 'East'", source: { provider: 'tableau', objectType: 'measure', objectId: 'x', extra: { notes: ['Data source Orders joins 2 tables.'] } } }),
        metric('sum_of_profit', 'Sum of Profit', { sql: 'profit' }),
        metric('profit_ratio', 'Profit Ratio', { type: 'custom', sql: 'profit_ratio', table: '', metricType: 'ratio', typeParams: { numerator: 'sum_of_profit', denominator: 'total_sales' } }),
      ],
      dimensions: [dimension('region', 'Region'), dimension('ordered_at', 'Ordered At', { type: 'date', isTimeDimension: true })],
      columnsOf: () => [{ name: 'store_id', sql: 'store_id' }],
    },
    driver: 'postgresql',
    connection: { driver: 'postgresql', database: 'shop' },
    worksheet: (name) => (name === 'Sales by Region' ? { name, filters: [{ field: 'Ordered At', words: 'Ordered At >= 2026-01-01' }] } : undefined),
    run: async (sql) => {
      sent.push(sql);
      return { rows, truncated: false };
    },
    savedQuery: async (name) => (name === 'Revenue' ? { name: 'Revenue', sql: 'select region, sum(sales) as revenue from analytics.orders group by 1' } : undefined),
    now: new Date('2026-11-02T10:14:03Z'),
    ...overrides,
  };
}

const request = (text: string, extra: Partial<CompareRequest> = {}): CompareRequest => ({ file: { name: 'Sales by Region.csv', bytes: Buffer.from(text) }, ...extra });
const byRegion = 'Region,Total Sales\nEast,$10.50\nWest,$20.25\n';
const rows = [{ region: 'East', total_sales: 10.5 }, { region: 'West', total_sales: 20.25 }];

describe('a comparison from start to finish', () => {
  it('builds the same table from metrics and compares it, writing nothing', async () => {
    const context = deps(rows);
    const outcome = await runComparison(request(byRegion), context);
    expect(context.sent[0]).toContain('GROUP BY region');
    expect(outcome.comparison.verdict).toBe('matches');
    expect(outcome.report).toBe('Sales by Region');
    expect(outcome.target).toMatchObject({ kind: 'metrics', metrics: ['total_sales'], dimensions: ['region'] });
    expect(outcome.mapping.Region).toBe('the dimension region');
    expect(outcome.querySha256.total_sales).toHaveLength(64);
  });

  it('adds a stated filter to the query, or refuses it; it never drops one', async () => {
    const context = deps(rows);
    const outcome = await runComparison(request(byRegion, { filters: ['ordered_at >= 2026-01-01'] }), context);
    expect(context.sent[0]).toContain("WHERE ordered_at >= '2026-01-01'");
    expect(outcome.filters.stated).toEqual(['ordered_at >= 2026-01-01']);
    await expect(runComparison(request(byRegion, { filters: ['region like East'] }), deps(rows))).rejects.toThrow(ComparisonStopped);
    await expect(runComparison(request(byRegion, { filters: ['nothing = 1'] }), deps(rows))).rejects.toThrow('--waive');
  });

  it('will not call it Matches while a filter it can see is unanswered', async () => {
    const unanswered = await runComparison(request(byRegion, { worksheet: 'Sales by Region' }), deps(rows));
    expect(unanswered.comparison).toMatchObject({ verdict: 'not-proven', missing: ['Nobody stated or waived the filter on Ordered At.'] });
    expect(unanswered.filters.seen).toEqual(['Ordered At >= 2026-01-01']);
    const stated = await runComparison(request(byRegion, { worksheet: 'Sales by Region', filters: ['Ordered At >= 2026-01-01'] }), deps(rows));
    expect(stated.comparison.verdict).toBe('matches');
    const waived = await runComparison(request(byRegion, { worksheet: 'Sales by Region', waive: ['Ordered At: covers every row'] }), deps(rows));
    expect(waived.comparison.verdict).toBe('matches');
    expect(waived.filters.waived).toEqual(['Ordered At: covers every row']);
    await expect(runComparison(request(byRegion, { worksheet: 'Sales by Region', waive: ['Ordered At'] }), deps(rows))).rejects.toThrow('has no reason');
    await expect(runComparison(request(byRegion, { worksheet: 'Other' }), deps(rows))).rejects.toThrow('No imported workbook');
  });

  it('counts Power BI\'s filter line as a filter to answer', async () => {
    const text = `Applied filters: Region is East\n${byRegion}`;
    expect((await runComparison(request(text), deps(rows))).comparison.verdict).toBe('not-proven');
    expect((await runComparison(request(text, { waive: ['Applied filters: this export has every region'] }), deps(rows))).comparison.verdict).toBe('matches');
  });

  it('counts a part of the file it did not read like an unanswered filter', async () => {
    const context = deps(rows);
    const table = { ...readExport(Buffer.from(byRegion), 'a.csv'), unread: ['the hidden sheet Old'] };
    const withUnread = { ...context, readFile: async () => table };
    const held = await runComparison(request(byRegion), withUnread);
    expect(held.comparison.verdict).toBe('not-proven');
    expect(held.filters.seen).toContain('the hidden sheet Old');
    expect((await runComparison(request(byRegion, { waive: ['Applied filters: an old copy'] }), withUnread)).comparison.verdict).toBe('matches');
  });

  it('does not let another waiver, or one stated filter, answer the whole line', async () => {
    const text = `Applied filters: Region is East, Year is 2026\n${byRegion}`;
    expect((await runComparison(request(text, { waive: ['Colour: x'] }), deps(rows))).comparison.verdict).toBe('not-proven');
    expect((await runComparison(request(text, { filters: ['region = East'] }), deps(rows))).comparison.verdict).toBe('not-proven');
  });

  it('tries a percent at 100 times only for a definition that multiplies by 100', async () => {
    const points = metric('profit_pct', 'Profit %', { type: 'custom', sql: 'profit_pct', table: '', metricType: 'derived', typeParams: { expr: 'sum_of_profit / NULLIF(total_sales, 0) * 100', metrics: ['sum_of_profit', 'total_sales'] } });
    const context = deps([{ region: 'East', profit_pct: 14.9 }]);
    const held = await runComparison(request('Region,Profit %\nEast,14.9%\n'), { ...context, catalog: { ...context.catalog, metrics: [...context.catalog.metrics, points] } });
    expect(held.comparison.numbers[0]!.percentPoints).toBe(true);
    const ratio = await runComparison(request('Region,Profit Ratio\nEast,14.9%\n'), deps([{ region: 'East', profit_ratio: 14.9 }]));
    expect(ratio.comparison.verdict).toBe('differs');
  });

  it('runs on the tables and joins of the real layer, and fingerprints without them', async () => {
    const sent: string[] = [];
    const context = deps(rows, { tableMapping: { 'analytics.orders': 'main.orders' }, run: async (sql) => { sent.push(sql); return { rows, truncated: false }; } });
    const mapped = await runComparison(request(byRegion), context);
    expect(sent[0]).toContain('main.orders');
    const plain = await runComparison(request(byRegion), deps(rows));
    expect(mapped.querySha256).toEqual(plain.querySha256);
  });

  it('passes a saved query\'s bound parameters to the run', async () => {
    const seen: unknown[] = [];
    const context = deps([{ region: 'East', revenue: 1.5 }], {
      savedQuery: async (name) => ({ name, sql: 'select region, revenue from t where year = $1', sqlParams: [{ name: 'year', position: 1 }], variables: { year: 2026 } }),
      run: async (_sql, saved) => { seen.push(saved); return { rows: [{ region: 'East', revenue: 1.5 }], truncated: false }; },
    });
    await runComparison({ file: { name: 'q.csv', bytes: Buffer.from('region,revenue\nEast,1.50\n') }, query: 'Revenue', parameters: { year: 2026 } }, context);
    expect(seen[0]).toEqual({ sqlParams: [{ name: 'year', position: 1 }], variables: { year: 2026 } });
  });

  it('caps the tolerance, so no report can agree with anything', async () => {
    await expect(runComparison(request(byRegion, { tolerance: '5000%' }), deps(rows))).rejects.toThrow('The most is 10%');
    expect((await runComparison(request(byRegion, { tolerance: '10%' }), deps(rows))).tolerance).toBe('10%');
  });

  it('refuses options of the wrong type, which would lose a filter', () => {
    expect(compareOptionProblem({ filters: 'region = East' })).toContain('filters must be a list');
    expect(compareOptionProblem({ worksheet: 5 })).toContain('worksheet must be text');
    expect(compareOptionProblem({ map: { 'Total Sales': 5 } })).toContain('map must be');
    expect(compareOptionProblem({ fileRows: 'yes' })).toContain('fileRows must be');
    expect(compareOptionProblem({ filters: ['a = b'], map: { a: 'b' }, parameters: { year: 2026 }, fileRows: true, worksheet: 'x' })).toBeNull();
  });

  it('is Not proven when the database\'s result was cut, and passes on what a draft says', async () => {
    const cut = await runComparison(request(byRegion), deps(rows, { run: async () => ({ rows, truncated: true }) }));
    expect(cut.comparison).toMatchObject({ verdict: 'not-proven', missing: ["ZLens's result was cut by a row limit."] });
    const noted = await runComparison(request('Region,East Sales\nEast,$1.00\n'), deps([{ region: 'East', east_sales: 2 }]));
    expect(noted.comparison.reasons).toContain('Data source Orders joins 2 tables.');
  });

  it('compares a typed number with the ungrouped metric', async () => {
    const context = deps([{ total_sales: 2297200.86 }]);
    const outcome = await runComparison({ metric: 'total_sales', value: '2,297,200.86' }, context);
    expect(context.sent[0]).not.toContain('GROUP BY');
    expect(outcome.comparison.verdict).toBe('matches');
    await expect(runComparison({ metric: 'nope', value: '1' }, deps([]))).rejects.toThrow('no metric or metric draft named nope');
    await expect(runComparison({ value: '1' }, deps([]))).rejects.toThrow('--value needs --metric');
  });

  it('compares a saved query\'s own rows, and sends filters to its parameters', async () => {
    const context = deps([{ region: 'East', revenue: 10.5 }]);
    const outcome = await runComparison(request('Region,Revenue\nEast,$10.50\n', { query: 'Revenue' }), context);
    expect(outcome.comparison.verdict).toBe('matches');
    expect(outcome.target).toEqual({ kind: 'query', name: 'Revenue', parameters: {} });
    await expect(runComparison(request(byRegion, { query: 'Nope' }), deps([]))).rejects.toThrow('no saved query named Nope');
    await expect(runComparison(request(byRegion, { query: 'Revenue', filters: ['region = East'] }), deps([]))).rejects.toThrow('--param');
  });

  it('refuses a tolerance that is not a percent, and a file it can\'t read', async () => {
    await expect(runComparison(request(byRegion, { tolerance: '5' }), deps(rows))).rejects.toThrow('takes a percent');
    await expect(runComparison({ file: { name: 'x.pbix', bytes: Buffer.from('x') } }, deps(rows))).rejects.toThrow(ExportRefused);
  });

  it('changes the fingerprint when the query or its filters change, spacing inside it included', () => {
    expect(queryFingerprint(" select 'a  b' ", [])).toBe(queryFingerprint("select 'a  b'", []));
    expect(queryFingerprint("select 'a  b'", [])).not.toBe(queryFingerprint("select 'a b'", []));
    expect(queryFingerprint('select 1', [])).not.toBe(queryFingerprint('select 2', []));
    expect(queryFingerprint('select 1', [])).not.toBe(queryFingerprint('select 1', ['x']));
  });
});

describe('what stays after a comparison', () => {
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-report-match-'));
    roots.push(root);
    return root;
  };

  it('keeps one record per metric, its own verdict, and no values', async () => {
    const root = project();
    const outcome = await runComparison(request('Region,Total Sales,Sum of Profit\nEast,$10.50,$1.00\n'), deps([{ region: 'East', total_sales: 10.5, sum_of_profit: 2 }]));
    const paths = writeMatchRecords(root, outcome, { comparedBy: 'maya@retail.example', via: 'cli' });
    expect(paths).toEqual(['semantic-layer/report-matches/metric/total_sales.yaml', 'semantic-layer/report-matches/metric/sum_of_profit.yaml']);
    expect(readMatchRecords(root, 'metric', 'total_sales')[0]).toMatchObject({ verdict: 'matches', values: { compared: 1, equal: 1 }, comparedBy: 'maya@retail.example', via: 'cli', precision: '2 decimals' });
    expect(readMatchRecords(root, 'metric', 'sum_of_profit')[0]).toMatchObject({ verdict: 'differs', values: { compared: 1, equal: 0 } });
    const text = readFileSync(join(root, paths[0]!), 'utf-8');
    expect(text).not.toContain('10.5');
    expect(text).not.toContain('East,');
  });

  it('keeps the newest first, in words a receipt can use', async () => {
    const root = project();
    const first = await runComparison(request(byRegion), deps(rows));
    writeMatchRecords(root, first, { comparedBy: 'a', via: 'cli' });
    writeMatchRecords(root, { ...first, comparedAt: '2026-12-01T00:00:00Z', tool: 'tableau' }, { comparedBy: 'b', via: 'cli' });
    const records = readMatchRecords(root, 'metric', 'total_sales');
    expect(records.map((record) => record.comparedBy)).toEqual(['b', 'a']);
    expect(matchWords(records[0]!)).toBe('Matches Sales by Region (Tableau), 2026-12-01: 2 of 2 values at 2 decimals');
  });

  it('keeps a name that is not plain inside the folder', async () => {
    const root = project();
    const outcome = await runComparison(request(byRegion), deps(rows));
    const odd = { ...outcome, target: { kind: 'query' as const, name: '../../escape', parameters: {} }, querySha256: { query: 'x' } };
    expect(writeMatchRecords(root, odd, { comparedBy: 'a', via: 'cli' })[0]).toMatch(/^semantic-layer\/report-matches\/query\/[^/]*escape-[0-9a-f]{8}\.yaml$/);
  });

  it('keeps the differences per person, and reads no one else\'s', async () => {
    const root = project();
    const outcome = await runComparison(request(byRegion), deps(rows));
    writeComparisonDetail(root, 'p-one', outcome);
    expect(readComparisonDetail(root, 'p-one', outcome.id)?.id).toBe(outcome.id);
    expect(readComparisonDetail(root, 'p-two', outcome.id)).toBeNull();
    expect(() => readComparisonDetail(root, 'p-one', '../../etc')).toThrow('Invalid comparison id');
  });

  it('writes a report with each verdict, its filters and its differences', async () => {
    const differs = await runComparison(request(byRegion), deps([{ region: 'East', total_sales: 10.5 }, { region: 'West', total_sales: 99 }]));
    const page = matchReportMarkdown([differs], [{ file: 'odd.csv', reason: 'No column matches.' }], '2026-11-02T00:00:00Z');
    expect(page).toContain('0 of 2 exports match, 1 differs, 0 not proven, 1 could not be compared');
    expect(page).toContain('| Sales by Region | Differs | 2 of 2 | 1 of 2 | none stated | total_sales |');
    expect(page).toContain('| West | Total Sales | $20.25 | 99 |');
    expect(page).toContain('| odd.csv | Could not be compared |');
  });
});

describe('what a reader of the report is told', () => {
  it('says when a verdict covers less than the whole report', async () => {
    const narrow = await runComparison(request('Region,Total Sales,Discount\nEast,$10.50,$1.00\n', { fileRows: true, tolerance: '5%', ignore: ['Discount'] }), deps([{ region: 'East', total_sales: 10.5 }]));
    const page = matchReportMarkdown([narrow], [], '2026-11-02T00:00:00Z');
    expect(page).toContain("Matches; only the file's rows; within 5%; left out: Discount");
  });

  it('keeps only the newest comparisons of a person', async () => {
    const root = mkdtempSync(join(tmpdir(), 'report-details-'));
    roots.push(root);
    const outcome = await runComparison(request(byRegion), deps(rows));
    for (let index = 0; index < 55; index += 1) writeComparisonDetail(root, 'maya', { ...outcome, id: `cmp_${index.toString(16).padStart(4, '0')}` });
    expect(readdirSync(join(root, '.dql/local/private/comparisons/maya')).length).toBeLessThanOrEqual(50);
    expect(readComparisonDetail(root, 'maya', 'cmp_0036')).not.toBeNull();
  });
});

describe('a worksheet\'s saved filters', () => {
  it('reads the filters that narrow rows, by the field\'s caption, and skips one that keeps everything', () => {
    const file = extractTableauWorkbook(`<workbook><datasources><datasource caption='Orders' name='federated.abc'><connection class='postgres' /><column caption='Order Date' name='[ordered_at]' /></datasource></datasources>
<worksheets>
  <worksheet name='Sales by Region'><table><view>
    <filter class='quantitative' column='[federated.abc].[none:ordered_at:qk]' included-values='in-range'><min>#2026-01-01#</min></filter>
    <filter class='categorical' column='[federated.abc].[none:region:nk]'><groupfilter function='member' level='[none:region:nk]' member='&quot;East&quot;' /></filter>
    <filter class='categorical' column='[federated.abc].[none:segment:nk]'><groupfilter function='level-members' level='[none:segment:nk]' /></filter>
    <filter class='relative-date' column='[federated.abc].[none:shipped:qk]' />
  </view></table></worksheet>
</worksheets></workbook>`, 'Sales.twb');
    expect(file.worksheets).toEqual([{ name: 'Sales by Region', filters: [
      { field: 'Order Date', words: 'Order Date >= 2026-01-01' },
      { field: 'region', words: 'region in (East)' },
      { field: 'shipped', words: 'shipped: a relative-date ZLens cannot read' },
    ] }]);
  });

  it('does not take the choice of measures for a filter on rows', () => {
    const file = extractTableauWorkbook(`<workbook><datasources><datasource name='federated.abc'><connection class='postgres' /></datasource></datasources>
<worksheets><worksheet name='Sales'><table><view>
  <filter class='categorical' column='[federated.abc].[:Measure Names]'><groupfilter function='member' level='[:Measure Names]' member='&quot;Sales&quot;' /></filter>
</view></table></worksheet></worksheets></workbook>`, 'Sales.twb');
    expect(file.worksheets![0]!.filters).toEqual([]);
  });

  it('lists filters on the data source and shared across worksheets on each worksheet', () => {
    const file = extractTableauWorkbook(`<workbook><datasources><datasource name='federated.abc'><connection class='postgres' /><filter class='categorical' column='[none:region:nk]'><groupfilter function='member' level='[none:region:nk]' member='&quot;East&quot;' /></filter></datasource></datasources>
<shared-views><shared-view name='federated.abc'><filter class='categorical' column='[federated.abc].[none:segment:nk]'><groupfilter function='member' level='[none:segment:nk]' member='&quot;SMB&quot;' /></filter></shared-view></shared-views>
<worksheets><worksheet name='Sales'><table><view /></table></worksheet></worksheets></workbook>`, 'Sales.twb');
    expect(file.worksheets![0]!.filters.map((filter) => filter.words)).toEqual(['region in (East)', 'segment in (SMB)']);
  });
});
