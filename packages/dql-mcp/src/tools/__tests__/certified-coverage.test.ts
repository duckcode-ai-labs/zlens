import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemanticLayer } from '@zlens/core';

import { DQLContext } from '../../context.js';
import { querySemanticModel } from '../query-semantic-model.js';
import { inspectDqlProject } from '../workflows.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

// A Claude Desktop recording (no agent guide file) went inspect_dql_project →
// query_semantic_model for "How has revenue changed by month?" and answered
// "No certified block answers this question yet" while monthly_revenue was
// certified at exactly that grain. These tests pin what each step now says.

const jaffleGolden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/cli/test/fixtures/jaffle-golden');

function revenueLayer() {
  return new SemanticLayer({
    metrics: [
      { name: 'order_total', label: 'Order Total', description: 'Order total.', domain: 'commerce', sql: 'order_total', type: 'sum', table: 'orders' },
      { name: 'tax_paid', label: 'Tax Paid', description: 'Tax paid.', domain: 'commerce', sql: 'tax_paid', type: 'sum', table: 'orders' },
    ],
    dimensions: [
      { name: 'metric_time', label: 'Metric Time', description: 'Order time.', sql: 'ordered_at', type: 'time', table: 'orders', isTimeDimension: true },
      { name: 'store', label: 'Store', description: 'Store.', sql: 'location_name', type: 'string', table: 'orders' },
    ],
  });
}

const monthlyRevenue = makeManifestBlock({
  name: 'monthly_revenue',
  domain: 'commerce',
  filePath: 'domains/commerce/blocks/monthly_revenue.dql',
  grain: 'one row per calendar month',
  dimensions: ['month'],
  description: 'Monthly gross order revenue and order count.',
  sql: `SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS gross_revenue, COUNT(*) AS order_count
        FROM dev.orders GROUP BY 1 ORDER BY 1`,
});

describe('certified blocks come first for clients without a guide file', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-certified-coverage-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('inspect_dql_project lists the certified blocks with their grains and sends the agent to ask_dql', async () => {
    const ctx = makeCtx(
      { monthly_revenue: monthlyRevenue, draft_one: makeManifestBlock({ name: 'draft_one', status: 'draft' }) },
      { projectRoot: tmpProject, semanticLayer: revenueLayer() } as never,
    );
    const out = await inspectDqlProject(ctx, { refresh: false });

    expect(out.blocks).toEqual({ total: 2, certified: 1, draft: 1 });
    expect(out.certifiedBlocks).toEqual([{
      name: 'monthly_revenue',
      domain: 'commerce',
      grain: 'one row per calendar month',
      description: 'Monthly gross order revenue and order count.',
    }]);
    expect(out.nextTool).toBe('ask_dql');
    expect(out.recommendedNextStep).toMatch(/^Call ask_dql with the user's question next, before query_semantic_model/);
    // The list comes before the semantic inventory in the result.
    expect(Object.keys(out).indexOf('certifiedBlocks')).toBeLessThan(Object.keys(out).indexOf('semantic'));
  });

  it('query_semantic_model names the certified block that covers the metric and grain, first, and saves no draft', async () => {
    const ctx = makeCtx({ monthly_revenue: monthlyRevenue }, { projectRoot: tmpProject, semanticLayer: revenueLayer() } as never);
    const out = await querySemanticModel(ctx, {
      metrics: ['order_total'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      dryRun: true,
    }) as Record<string, any>;

    expect(Object.keys(out)[0]).toBe('certifiedBlock');
    expect(out.certifiedBlock).toMatchObject({
      name: 'monthly_revenue',
      grain: 'one row per calendar month',
      matchedBy: 'metric_and_grain',
      nextTool: 'query_via_block',
      queryViaBlockArgs: { name: 'monthly_revenue' },
    });
    expect(out.nextTool).toBe('query_via_block');
    expect(out.recommendedAction).toContain('do not say that no certified block exists');
    // The compile itself stays an uncertified draft, and never says "no certified block".
    expect(out.uncertified).toBe(true);
    expect(out.trustLabelInfo.base).toBe('AI-Generated');
    expect(out.trustStatus.caveats[0]).toBe('Certified block "monthly_revenue" answers this; use query_via_block for the certified answer.');
    expect(JSON.stringify(out)).not.toContain('No certified block exactly answered');
    expect(out.draftBlock).toBeUndefined();
    expect(existsSync(join(tmpProject, 'blocks', '_drafts'))).toBe(false);
  });

  it.each([
    ['a filter', { filters: [{ dimension: 'store', operator: 'equals', values: ['Philadelphia'] }] }],
    ['another dimension', { dimensions: ['store'] }],
    ['another grain', { timeDimension: { name: 'metric_time', granularity: 'week' } }],
    ['another measure', { metrics: ['tax_paid'] }],
  ])('does not claim the certified block for %s', async (_label, change) => {
    const ctx = makeCtx({ monthly_revenue: monthlyRevenue }, { projectRoot: tmpProject, semanticLayer: revenueLayer() } as never);
    const out = await querySemanticModel(ctx, {
      metrics: ['order_total'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      dryRun: true,
      saveDraft: false,
      ...change,
    }) as Record<string, any>;

    expect(out.certifiedBlock).toBeUndefined();
    // Without a question the router did not run, so the result must not say none exists.
    expect(out.certifiedCheck).toEqual({ checked: false });
    expect(out.recommendedAction).toContain('Call ask_dql');
    expect(out.trustStatus.caveats[0]).toBe('Certified blocks were not checked; ask_dql decides whether a certified block answers the question.');
  });

  it('does not claim a certified block whose SQL filters or joins', async () => {
    const filtered = { ...monthlyRevenue, sql: `SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS r FROM dev.orders WHERE is_food_order GROUP BY 1` };
    const ctx = makeCtx({ monthly_revenue: filtered }, { projectRoot: tmpProject, semanticLayer: revenueLayer() } as never);
    const out = await querySemanticModel(ctx, {
      metrics: ['order_total'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      dryRun: true,
      saveDraft: false,
    }) as Record<string, any>;
    expect(out.certifiedBlock).toBeUndefined();
  });

  describe('on the jaffle-golden sample, through the ask_dql router', () => {
    let project: string;

    beforeEach(() => {
      project = join(tmpProject, 'jaffle');
      cpSync(jaffleGolden, project, { recursive: true });
    });

    it('a question the router sends to a certified block names that block', async () => {
      const out = await querySemanticModel(new DQLContext({ projectRoot: project }), {
        question: 'How has revenue changed by month?',
        dryRun: true,
      }) as Record<string, any>;

      expect(out.certifiedBlock).toMatchObject({
        name: 'monthly_revenue',
        grain: 'one row per calendar month',
        matchedBy: 'router',
        queryViaBlockArgs: { name: 'monthly_revenue', question: 'How has revenue changed by month?' },
      });
      expect(out.nextTool).toBe('query_via_block');
      expect(out.draftBlock).toBeUndefined();
    }, 60_000);

    it('a question with no certified answer says the check ran and found none', async () => {
      const out = await querySemanticModel(new DQLContext({ projectRoot: project }), {
        question: 'Which store location had the most orders in 2025?',
        dryRun: true,
        saveDraft: false,
      }) as Record<string, any>;

      expect(out.certifiedBlock).toBeUndefined();
      expect(out.certifiedCheck).toEqual({ checked: true, askDqlRoute: 'generated_sql' });
      expect(out.trustStatus.caveats[0]).toBe('No certified block exactly answered this question.');
    }, 60_000);
  });
});
