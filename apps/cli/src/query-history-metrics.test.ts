import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSemanticLayerFromDir, loadSemanticMetricDraftsFromDir, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { listMetricDrafts } from './import-metric-drafts.js';
import { routeAction } from './host/route-actions.js';
import { draftMetricsFromHistory, metricNameFor, repeatedAggregates } from './query-history-metrics.js';
import { queryHistorySql } from './warehouse-model-discovery.js';

const lines: WarehouseCatalogRelationV1 = { id: 'warehouse.sales.invoicelines', schema: 'sales', name: 'invoicelines', relation: 'wwi.sales.invoicelines', kind: 'table', columns: [{ name: 'extendedprice' }, { name: 'taxamount' }, { name: 'quantity' }, { name: 'invoiceid' }] };
const invoices: WarehouseCatalogRelationV1 = { id: 'warehouse.sales.invoices', schema: 'sales', name: 'invoices', relation: 'wwi.sales.invoices', kind: 'table', columns: [{ name: 'invoiceid' }, { name: 'customerid' }] };
const snapshot = { relations: [lines, invoices] };

describe('reading what queries repeat', () => {
  const statement = (text: string, user = 'a', calls?: number) => ({ text, user, ...(calls ? { calls } : {}) });

  it('counts an expression across statements and people, whatever its alias or case', () => {
    const [top] = repeatedAggregates([
      statement('select sum(il.extendedprice - il.taxamount) from sales.invoicelines il', 'a'),
      statement('SELECT SUM(extendedprice - taxamount) AS revenue FROM sales.invoicelines GROUP BY invoiceid', 'b'),
      statement('select sum(x.EXTENDEDPRICE - x.TAXAMOUNT) from wwi.sales.invoicelines x join sales.invoices i on i.invoiceid = x.invoiceid', 'a'),
    ], snapshot);
    expect(top).toMatchObject({ aggregate: 'sum', expression: 'extendedprice - taxamount', runs: 3, statements: 3, people: 2 });
    expect(top?.relation.name).toBe('invoicelines');
  });

  it('counts the runs a warehouse keeps on one row', () => {
    const [top] = repeatedAggregates([statement('select sum(quantity) from sales.invoicelines', 'a', 412)], snapshot);
    expect(top?.runs).toBe(412);
    expect(top?.statements).toBe(1);
  });

  it('one statement repeating an expression counts once', () => {
    expect(repeatedAggregates([statement('select sum(quantity), sum(quantity) * 2 from sales.invoicelines')], snapshot)).toEqual([]);
  });

  it('leaves out what was run only once', () => {
    expect(repeatedAggregates([statement('select sum(quantity) from sales.invoicelines')], snapshot)).toEqual([]);
  });

  it('keeps no literal: an expression holding one is left out', () => {
    const texts = [`select sum(case when customername = 'Jane Doe' then quantity end) from sales.invoicelines`, 'select sum(quantity * $1) from sales.invoicelines', 'select sum(quantity * ?) from sales.invoicelines'];
    expect(repeatedAggregates(texts.flatMap((text) => [statement(text), statement(text)]), snapshot)).toEqual([]);
  });

  it('a name that is not a column of a known table is left out', () => {
    const text = 'select sum(imagined) from sales.invoicelines';
    expect(repeatedAggregates([statement(text), statement(text)], snapshot)).toEqual([]);
    const elsewhere = 'select sum(amount) from other.ledger';
    expect(repeatedAggregates([statement(elsewhere), statement(elsewhere)], snapshot)).toEqual([]);
  });

  it('a bare column across two tables is not guessed', () => {
    const text = 'select sum(quantity) from sales.invoicelines il join sales.invoices i on i.invoiceid = il.invoiceid';
    expect(repeatedAggregates([statement(text), statement(text)], snapshot)).toEqual([]);
  });

  it('an expression across two tables is left out', () => {
    const text = 'select sum(il.quantity * i.customerid) from sales.invoicelines il join sales.invoices i on i.invoiceid = il.invoiceid';
    expect(repeatedAggregates([statement(text), statement(text)], snapshot)).toEqual([]);
  });

  it('COUNT(*) is left out and COUNT(DISTINCT x) is kept', () => {
    const text = 'select count(*), count(distinct customerid) from sales.invoices';
    const found = repeatedAggregates([statement(text), statement(text)], snapshot);
    expect(found.map((item) => [item.aggregate, item.expression])).toEqual([['count_distinct', 'customerid']]);
  });

  it('a subquery is left out', () => {
    const text = 'select sum((select max(quantity) from sales.invoicelines)) from sales.invoices';
    expect(repeatedAggregates([statement(text), statement(text)], snapshot).filter((item) => item.aggregate === 'sum')).toEqual([]);
  });

  it('a name says what the expression says', () => {
    expect(metricNameFor({ aggregate: 'sum', expression: 'extendedprice - taxamount', relation: lines })).toBe('total_invoicelines_extendedprice_taxamount');
    expect(metricNameFor({ aggregate: 'count_distinct', expression: 'customerid', relation: invoices })).toBe('distinct_invoices_customerid');
  });
});

describe('the history statement', () => {
  it('reads who ran what on each warehouse that keeps history', () => {
    expect(queryHistorySql('postgres', { aggregates: true })).toContain('userid::text AS query_user');
    expect(queryHistorySql('postgres', { aggregates: true })).toContain('calls AS query_calls');
    expect(queryHistorySql('snowflake', { aggregates: true })).toContain('user_name AS query_user');
    expect(queryHistorySql('databricks', { aggregates: true })).toContain('executed_by AS query_user');
    expect(queryHistorySql('bigquery', { aggregates: true })).toContain('user_email AS query_user');
    expect(queryHistorySql('sqlite', { aggregates: true })).toBeUndefined();
  });

  it('the join statement is unchanged', () => {
    expect(queryHistorySql('postgres')).toContain("ILIKE '%join%'");
    expect(queryHistorySql('postgres')).not.toContain('query_user');
  });
});

describe('writing metric drafts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'history-metrics-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const aggregate = { relation: lines, aggregate: 'sum' as const, expression: 'extendedprice - taxamount', runs: 412, statements: 40, people: 9 };
  const draft = (run: (sql: string) => Promise<Array<Record<string, unknown>>>, extra = {}) => draftMetricsFromHistory({ projectRoot: root, aggregates: [aggregate], domain: 'sales', driver: 'postgres', run, now: new Date('2026-11-02T00:00:00Z'), ...extra });

  it('runs each draft once over all rows, on the warehouse', async () => {
    const run = vi.fn(async (_sql: string) => [{ value: '171233410.25' }]);
    const [item] = await draft(run);
    expect(run).toHaveBeenCalledWith('SELECT SUM(extendedprice - taxamount) AS value FROM sales.invoicelines');
    expect(item).toMatchObject({ value: 171233410.25, runs: 412, people: 9 });
    expect(item?.inWords).toBe('SUM(extendedprice - taxamount) on sales.invoicelines. Seen in 412 runs by 9 people.');
  });

  it('a draft answers nothing, and the review commands read it', async () => {
    await draft(async () => [{ value: 12 }]);
    const semantic = join(root, 'semantic-layer');
    expect(loadSemanticLayerFromDir(semantic).listMetrics()).toEqual([]);
    expect(loadSemanticMetricDraftsFromDir(semantic).map((metric) => metric.name)).toEqual(['total_invoicelines_extendedprice_taxamount']);
    expect(listMetricDrafts(root)[0]).toMatchObject({ value: 12, formula: 'SUM(extendedprice - taxamount)' });
  });

  it('a draft that does not run is not written, and says why', async () => {
    const [item] = await draft(async () => { throw new Error('permission denied\nmore'); });
    expect(item?.failed).toBe('permission denied');
    expect(item?.path).toBeUndefined();
    expect(listMetricDrafts(root)).toEqual([]);
  });

  it('a name already taken is left alone', async () => {
    await draft(async () => [{ value: 1 }]);
    expect(await draft(async () => [{ value: 2 }])).toEqual([]);
    expect(listMetricDrafts(root)[0]?.value).toBe(1);
  });

  it('with a host the value stays out of the file', async () => {
    const [item] = await draft(async () => [{ value: 12 }], { privateValues: true });
    expect(readFileSync(join(root, item!.path!), 'utf-8')).not.toContain('value: 12');
  });

  it('spells names as the warehouse needs them', async () => {
    const run = vi.fn(async (_sql: string) => [{ VALUE: 1 }]);
    await draftMetricsFromHistory({ projectRoot: root, aggregates: [{ ...aggregate, relation: { ...lines, schema: 'SALES', name: 'INVOICELINES', columns: [{ name: 'EXTENDEDPRICE' }, { name: 'TAXAMOUNT' }] } }], domain: 'sales', driver: 'snowflake', run });
    expect(run.mock.calls[0]![0]).toContain('SUM(EXTENDEDPRICE - TAXAMOUNT)');
  });

  it('on a hosted server this needs an administrator', () => {
    expect(routeAction('POST', '/api/semantic-layer/metric-drafts/from-history')?.action).toBe('settings.manage');
  });
});
