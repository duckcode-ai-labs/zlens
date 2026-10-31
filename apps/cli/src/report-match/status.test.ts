import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DimensionDefinition, MetricDefinition } from '@zlens/core';
import { importDraftsToApprove, importDraftsWithMatches, listMetricDrafts, type ImportMetricDrafts } from '../import-metric-drafts.js';
import { matchWords, readMatchRecords, writeMatchRecords, type MatchRecord } from './record.js';
import { runComparison, type CompareDeps } from './run.js';
import { catalogWithDrafts, latestMatch, metricMatchStatus, queryChanged, receiptLines, standingRecord, type MatchCatalog } from './status.js';

const metric = (name: string, label: string, extra: Partial<MetricDefinition> = {}): MetricDefinition => ({ name, label, description: '', domain: 'sales', type: 'sum', sql: name, table: 'analytics.orders', ...extra });
const dimension = (name: string, label: string): DimensionDefinition => ({ name, label, description: '', sql: name, type: 'string', table: 'analytics.orders' });

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'report-status-'));
  roots.push(root);
  return root;
}

const catalog: MatchCatalog = {
  metrics: [metric('total_sales', 'Total Sales', { sql: 'sales' }), metric('sum_of_profit', 'Sum of Profit', { sql: 'profit' })],
  dimensions: [dimension('region', 'Region')],
};

function deps(rows: Array<Record<string, unknown>>, sql = 'select 1'): CompareDeps {
  return {
    catalog: { ...catalog, columnsOf: () => [{ name: 'store_id', sql: 'store_id' }] },
    driver: 'postgresql',
    connection: { driver: 'postgresql' },
    worksheet: () => undefined,
    run: async () => ({ rows, truncated: false }),
    savedQuery: async (name) => ({ name, sql }),
    now: new Date('2026-11-02T10:14:03Z'),
  };
}

async function compared(root: string, text: string, rows: Array<Record<string, unknown>>, filters: string[] = []) {
  const outcome = await runComparison({ file: { name: 'Sales by Region.csv', bytes: Buffer.from(text) }, filters }, deps(rows));
  writeMatchRecords(root, outcome, { comparedBy: 'maya@retail.example', via: 'screen' });
}

describe('whether a record still speaks for what was compared', () => {
  const good = [{ region: 'East', total_sales: 10.5, sum_of_profit: 2 }];

  it('holds while the question compiles the same, wherever the metric now lives', async () => {
    const root = project();
    await compared(root, 'Region,Total Sales\nEast,$10.50\n', good);
    const moved = { ...catalog, metrics: catalog.metrics.map((item) => ({ ...item, status: 'certified' as const, label: 'Approved' })) };
    expect(metricMatchStatus(root, 'total_sales', moved)).toMatchObject({ verdict: 'matches', changed: false });
    expect(metricMatchStatus(root, 'total_sales', catalog)!.words).toContain('Matches Sales by Region');
  });

  it('says Changed since compared when the definition changes, or goes away', async () => {
    const root = project();
    await compared(root, 'Region,Total Sales\nEast,$10.50\n', good);
    const edited = { ...catalog, metrics: [metric('total_sales', 'Total Sales', { sql: 'sales - discount' })] };
    expect(metricMatchStatus(root, 'total_sales', edited)!.changed).toBe(true);
    expect(metricMatchStatus(root, 'total_sales', { ...catalog, metrics: [] })!.changed).toBe(true);
  });

  it('compiles a ratio again, so a changed part changes it', async () => {
    const root = project();
    const ratio = metric('profit_ratio', 'Profit Ratio', { type: 'custom', sql: 'profit_ratio', table: '', metricType: 'ratio', typeParams: { numerator: 'sum_of_profit', denominator: 'total_sales' } });
    const withRatio = { ...catalog, metrics: [...catalog.metrics, ratio] };
    const outcome = await runComparison({ file: { name: 'r.csv', bytes: Buffer.from('Region,Profit Ratio\nEast,10.0%\n') } }, { ...deps([{ region: 'East', profit_ratio: 0.1 }]), catalog: withRatio });
    writeMatchRecords(root, outcome, { comparedBy: 'm', via: 'cli' });
    expect(metricMatchStatus(root, 'profit_ratio', withRatio)!.changed).toBe(false);
    const changedPart = { ...withRatio, metrics: withRatio.metrics.map((item) => (item.name === 'sum_of_profit' ? { ...item, sql: 'profit - tax' } : item)) };
    expect(metricMatchStatus(root, 'profit_ratio', changedPart)!.changed).toBe(true);
  });

  it('recompiles with the filters and throwaway keys that were compared', async () => {
    const root = project();
    await compared(root, 'store_id,Total Sales\n1,$10.50\n', [{ store_id: 1, total_sales: 10.5 }], ['region = East']);
    const [record] = readMatchRecords(root, 'metric', 'total_sales');
    expect(record!.asked!.throwaway).toHaveLength(1);
    expect(record!.asked!.filters[0]).toMatchObject({ dimension: 'region', values: ['value1'] });
    expect(metricMatchStatus(root, 'total_sales', catalog)!.changed).toBe(false);
  });

  it('holds no values from the old report in the record', async () => {
    const root = project();
    await compared(root, 'Region,Total Sales\nEast,$10.50\n', good);
    expect(JSON.stringify(readMatchRecords(root, 'metric', 'total_sales'))).not.toContain('10.5');
  });

  it('keeps no filter value in the record, and can still tell when the question changes', async () => {
    const root = project();
    await compared(root, 'Region,Total Sales\nEast,$10.50\n', good, ['region = ACME renewal']);
    const text = readFileSync(join(root, 'semantic-layer/report-matches/metric/total_sales.yaml'), 'utf8');
    expect(text).not.toContain('ACME');
    expect(readMatchRecords(root, 'metric', 'total_sales')[0]!.filters.stated).toEqual(['region equals']);
    expect(metricMatchStatus(root, 'total_sales', catalog)!.changed).toBe(false);
    expect(metricMatchStatus(root, 'total_sales', { ...catalog, metrics: [metric('total_sales', 'Total Sales', { sql: 'other' })] })!.changed).toBe(true);
  });

  it('has nothing to say with no record', () => {
    expect(metricMatchStatus(project(), 'total_sales', catalog)).toBeUndefined();
  });

  it('says so when a record file can\'t be read, rather than saying nothing', () => {
    const root = project();
    mkdirSync(join(root, 'semantic-layer/report-matches/metric'), { recursive: true });
    for (const damaged of ['matches: [', '<<<<<<< HEAD\nmatches:\n=======\n', 'matches:\n  - report: x\n']) {
      writeFileSync(join(root, 'semantic-layer/report-matches/metric/total_sales.yaml'), damaged);
      expect(latestMatch(root, 'metric', 'total_sales')).toBe('unreadable');
      expect(metricMatchStatus(root, 'total_sales', catalog)).toMatchObject({ unreadable: true, verdict: 'not-proven' });
    }
  });

  it('checks a saved query against its compiled SQL and parameters', async () => {
    const root = project();
    const sql = "select region, sum(sales) as revenue from t where region = 'North  East' group by 1";
    const context = deps([{ region: 'East', revenue: 1.5 }]);
    const outcome = await runComparison({ file: { name: 'q.csv', bytes: Buffer.from('region,revenue\nEast,1.50\n') }, query: 'Revenue', parameters: { year: 'secret 2026' } }, { ...context, savedQuery: async (name) => ({ name, sql, variables: { year: 'secret 2026' } }) });
    writeMatchRecords(root, outcome, { comparedBy: 'm', via: 'cli' });
    const record = latestMatch(root, 'query', 'Revenue') as MatchRecord;
    expect(record.parameterNames).toEqual(['year']);
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(queryChanged(record, sql, { year: 'secret 2026' })).toBe(false);
    // A changed default binds other rows, with the same SQL.
    expect(queryChanged(record, sql, { year: '2025' })).toBe(true);
    // Inside a quoted value, whitespace is the value.
    expect(queryChanged(record, sql.replace('North  East', 'North East'), { year: 'secret 2026' })).toBe(true);
  });
});

describe('which record speaks for a metric', () => {
  const record = (verdict: MatchRecord['verdict'], comparedAt: string, extra: Partial<MatchRecord> = {}) => ({ report: 'Sales', verdict, comparedAt, querySha256: 'same', scope: 'all rows', rows: { inFile: 4 }, ...extra }) as MatchRecord;

  it('takes the newest of a report, by when it was compared and not when it was written', async () => {
    const root = project();
    const differs = await runComparison({ file: { name: 'Sales.csv', bytes: Buffer.from('Region,Total Sales\nEast,$99.00\n') } }, deps([{ region: 'East', total_sales: 10.5 }]));
    const matches = await runComparison({ file: { name: 'Sales.csv', bytes: Buffer.from('Region,Total Sales\nEast,$10.50\n') } }, { ...deps([{ region: 'East', total_sales: 10.5 }]), now: new Date('2026-11-01T10:00:00Z') });
    writeMatchRecords(root, differs, { comparedBy: 'm', via: 'cli' });
    writeMatchRecords(root, matches, { comparedBy: 'm', via: 'cli' });
    expect(readMatchRecords(root, 'metric', 'total_sales').map((item) => item.verdict)).toEqual(['differs', 'matches']);
    expect((latestMatch(root, 'metric', 'total_sales') as MatchRecord).verdict).toBe('differs');
  });

  it('does not let a narrower look at the same question clear a Differs', () => {
    const wide = record('differs', '2026-11-01');
    expect(standingRecord([record('matches', '2026-11-02', { rows: { inFile: 1 } as MatchRecord['rows'] }), wide])).toBe(wide);
    expect(standingRecord([record('matches', '2026-11-02', { scope: "the file's rows" }), wide])).toBe(wide);
  });

  it('lets a full comparison, or a changed definition, clear it', () => {
    const fixed = record('matches', '2026-11-02');
    expect(standingRecord([fixed, record('differs', '2026-11-01')])).toBe(fixed);
    const changed = record('matches', '2026-11-02', { querySha256: 'other', rows: { inFile: 1 } as MatchRecord['rows'] });
    expect(standingRecord([changed, record('differs', '2026-11-01')])).toBe(changed);
  });

  it('takes the worst across reports', () => {
    const other = record('differs', '2026-11-01', { report: 'Other' });
    expect(standingRecord([record('matches', '2026-11-02'), other])).toBe(other);
  });
});

describe('what a certification receipt says', () => {
  const base = { report: 'Sales by Region', tool: 'tableau', comparedAt: '2026-11-02T10:14:03Z', values: { compared: 4, equal: 4 }, precision: '2 decimals', scope: 'all rows' };
  const record = (verdict: 'matches' | 'differs' | 'not-proven') => ({ ...base, verdict }) as Parameters<typeof matchWords>[0];

  it('says what a comparison left out, and counts one of only the file\'s rows as a warning', () => {
    const narrow = { ...record('matches'), scope: "the file's rows" };
    expect(receiptLines(narrow, false).checks).toEqual([]);
    expect(receiptLines(narrow, false).warnings[0]).toContain("only the file's rows");
    const limited = { ...record('matches'), mapping: { Profit: 'left out, as asked' }, filters: { stated: [], waived: ['Region: all of them'] } };
    expect(matchWords(limited)).toContain('left out: Profit, 1 filter waived');
  });

  it('warns of a comparison on another connection', () => {
    expect(receiptLines(record('matches'), false, false).warnings[0]).toContain('Compared on another connection');
  });

  it('counts a current match as a check, in plain words', () => {
    expect(receiptLines(record('matches'), false)).toEqual({ checks: ['Matches Sales by Region (Tableau), 2026-11-02: 4 of 4 values at 2 decimals'], warnings: [] });
  });

  it('warns of anything else, and never counts it as passed', () => {
    expect(receiptLines(record('differs'), false).checks).toEqual([]);
    expect(receiptLines(record('differs'), false).warnings[0]).toContain('Differs from Sales by Region');
    expect(receiptLines(record('not-proven'), false).warnings[0]).toContain('Not proven against');
    expect(receiptLines(record('matches'), true).warnings[0]).toContain('Changed since compared');
    expect(receiptLines(record('matches'), true).checks).toEqual([]);
    expect(receiptLines(record('matches'), undefined).warnings[0]).toContain('Not checked against this version');
  });
});

describe('drafts beside their comparison', () => {
  const draftFile = (root: string, name: string, extra = '') => {
    const dir = join(root, 'semantic-layer/metrics/_drafts/sales');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.yaml`), `name: ${name}\nlabel: ${name}\ndescription: x\ndomain: sales\nsql: ${name}\ntype: sum\ntable: analytics.orders\ntags: []\nowner: x\n${extra}`);
  };
  const imported = (names: string[]): ImportMetricDrafts => ({
    importId: 'imp_1', domain: 'sales', ranAt: 'x', written: true, checked: true, dimensions: [],
    items: names.map((name) => ({ calculation: name, formula: 'x', language: 'tableau', sourcePath: 'a', kind: 'simple', outcome: 'drafted', metric: name, path: `p/${name}`, value: 1, notes: [] })),
  } as ImportMetricDrafts);
  const write = (root: string, kind: 'metric', name: string, verdict: string) => {
    const dir = join(root, 'semantic-layer/report-matches', kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.yaml`), `matches:\n  - report: Sales\n    comparedAt: '2026-11-02T10:14:03Z'\n    connection: { driver: duckdb }\n    querySha256: x\n    values: { compared: 1, equal: 0 }\n    precision: 2 decimals\n    scope: all rows\n    verdict: ${verdict}\n`);
  };

  it('leaves what differs out of Approve all, and says which', () => {
    const root = project();
    for (const name of ['good', 'bad', 'unknown']) draftFile(root, name);
    write(root, 'metric', 'good', 'matches');
    write(root, 'metric', 'bad', 'differs');
    expect(importDraftsToApprove(root, imported(['good', 'bad', 'unknown']))).toEqual({ names: ['good', 'unknown'], leftOut: ['bad'] });
    expect(listMetricDrafts(root).find((draft) => draft.name === 'bad')!.match!.verdict).toBe('differs');
    expect(importDraftsWithMatches(root, imported(['bad'])).items[0]!.match!.verdict).toBe('differs');
  });

  it('leaves out a ratio that would bring a part that differs', () => {
    const root = project();
    draftFile(root, 'bad');
    draftFile(root, 'other');
    draftFile(root, 'ratio', 'metricType: ratio\ntypeParams:\n  numerator: bad\n  denominator: other\n');
    write(root, 'metric', 'bad', 'differs');
    expect(importDraftsToApprove(root, imported(['bad', 'other', 'ratio']))).toEqual({ names: ['other'], leftOut: ['bad', 'ratio'] });
    expect(importDraftsWithMatches(root, imported(['bad', 'other', 'ratio'])).items.map((item) => item.heldBack ?? false)).toEqual([true, false, true]);
  });

  it('finds a part whatever its case, as approving does, and through more than one level', () => {
    const root = project();
    draftFile(root, 'bad');
    draftFile(root, 'other');
    draftFile(root, 'ratio', 'metricType: ratio\ntypeParams:\n  numerator: other\n  denominator: BAD\n');
    draftFile(root, 'outer', 'metricType: ratio\ntypeParams:\n  numerator: other\n  denominator: ratio\n');
    write(root, 'metric', 'bad', 'differs');
    expect(importDraftsToApprove(root, imported(['bad', 'other', 'ratio', 'outer']))).toEqual({ names: ['other'], leftOut: ['bad', 'ratio', 'outer'] });
  });

  it('leaves out a draft whose record can\'t be read, since it could say Differs', () => {
    const root = project();
    draftFile(root, 'good');
    draftFile(root, 'damaged');
    mkdirSync(join(root, 'semantic-layer/report-matches/metric'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer/report-matches/metric/damaged.yaml'), '<<<<<<< HEAD\nmatches: [\n');
    expect(importDraftsToApprove(root, imported(['good', 'damaged']))).toEqual({ names: ['good'], leftOut: ['damaged'] });
  });

  it('takes drafts into the catalog only where nothing approved has their name', () => {
    const root = project();
    draftFile(root, 'total_sales');
    draftFile(root, 'new_one');
    const names = catalogWithDrafts(root, catalog).metrics.map((item) => item.name);
    expect(names.filter((name) => name === 'total_sales')).toHaveLength(1);
    expect(names).toContain('new_one');
  });
});
