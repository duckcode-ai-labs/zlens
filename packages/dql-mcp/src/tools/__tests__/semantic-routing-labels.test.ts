import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DQLContext } from '../../context.js';
import { querySemanticModel } from '../query-semantic-model.js';
import { askDql } from '../workflows.js';

// Found on 2026-10-23 by calling the MCP tools (ZLens 0.2.3) against the
// jaffle-shop demo, for a Claude Desktop recording that shows Certified,
// Governed and needs-review answers. jaffle-golden has the same blocks and
// semantic layer, and reproduces each case on 0.2.4.

const jaffleGolden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/cli/test/fixtures/jaffle-golden');

describe('MCP routing, metric choice and trust labels on jaffle-golden', () => {
  let project: string;
  let ctx: DQLContext;

  beforeAll(() => {
    project = join(mkdtempSync(join(tmpdir(), 'dql-semantic-routing-')), 'jaffle-golden');
    cpSync(jaffleGolden, project, { recursive: true });
    ctx = new DQLContext({ projectRoot: project });
  });

  afterAll(() => {
    rmSync(dirname(project), { recursive: true, force: true });
  });

  const semantic = (args: Parameters<typeof querySemanticModel>[1]) =>
    querySemanticModel(ctx, { dryRun: true, saveDraft: false, ...args }) as Promise<Record<string, any>>;

  describe('certified route only when the block returns the requested measure', () => {
    it('does not answer "large orders" from monthly_revenue, whose order_count counts every order', async () => {
      const out = await askDql(ctx, { question: 'How many large orders did we get each month?' }) as Record<string, any>;
      expect(out.route).not.toBe('certified');
      expect(out.exactCertifiedBlock).toBeUndefined();
      expect(out.trustLabel.base).not.toBe('Certified');
      expect(out.routeReason).toContain('large_orders');
    }, 60_000);

    it('still answers monthly revenue from monthly_revenue', async () => {
      const out = await askDql(ctx, { question: 'How has revenue changed by month?' }) as Record<string, any>;
      expect(out.route).toBe('certified');
      expect(out.exactCertifiedBlock?.name).toBe('monthly_revenue');
    }, 60_000);
  });

  describe('query_semantic_model picks the metric the question names', () => {
    it('average order value by customer type', async () => {
      const out = await semantic({ question: 'What is the average order value by customer type?' });
      expect(out).toMatchObject({ matched: true, metrics: ['average_order_value'], dimensions: ['customer_type'] });
    }, 60_000);

    it('average order value for new versus returning customers', async () => {
      const out = await semantic({ question: 'What is the average order value for new versus returning customers?' });
      expect(out).toMatchObject({ matched: true, metrics: ['average_order_value'], dimensions: ['customer_type'] });
    }, 60_000);

    it('share of revenue from food each month', async () => {
      const out = await semantic({ question: 'What share of revenue comes from food each month?' });
      expect(out).toMatchObject({ matched: true, metrics: ['food_revenue_pct'] });
      expect(out.timeDimension).toMatchObject({ granularity: 'month' });
    }, 60_000);

    it('large orders each month keep the month grain', async () => {
      const out = await semantic({ question: 'How many large orders did we get each month?' });
      expect(out).toMatchObject({ matched: true, metrics: ['large_orders'] });
      expect(out.timeDimension).toMatchObject({ granularity: 'month' });
    }, 60_000);

    it('compiles an explicit derived metric', async () => {
      const out = await semantic({ metrics: ['average_order_value'], dimensions: ['customer_type'] });
      expect(out.matched).toBe(true);
      expect(out.sql).toContain('AS average_order_value');
      expect(out.sql).toContain('GROUP BY customer_type');
    }, 60_000);

    it('says "No semantic match", and why, for a metric the native engine cannot run', async () => {
      const out = await semantic({ metrics: ['revenue_growth_mom'] });
      expect(out.matched).toBe(false);
      expect(out.reason).toContain('No semantic match');
      expect(out.reason).toContain('offset window');
    }, 60_000);
  });

  describe('a semantic compile reads Governed, as the Ask page does', () => {
    it('labels the compile and its DQL artifact Governed, and never Certified', async () => {
      const out = await semantic({ question: 'What is the average order value by customer type?' });
      expect(out.trustLabelInfo).toMatchObject({ id: 'governed', base: 'Governed' });
      expect(out.dqlArtifact.trustState).toBe('governed');
      expect(out.certification).toBe('governed');
      expect(out.uncertified).toBe(true);
    }, 60_000);

    it('ask_dql sends a question the semantic layer answers to query_semantic_model, not to AI SQL', async () => {
      const out = await askDql(ctx, { question: 'How many large orders did we get each month?' }) as Record<string, any>;
      expect(out.nextTool).toBe('query_semantic_model');
      expect(out.semanticCandidate).toMatchObject({ metric: 'large_orders', trustLabel: { base: 'Governed' } });
      expect(out.recommendedAction).toContain('query_semantic_model');
    }, 60_000);

    it('ask_dql keeps AI SQL for a question no semantic metric names, or a date range it cannot apply', async () => {
      for (const question of ['How many employees work at each store?', 'Which store location had the most orders in 2025?']) {
        const out = await askDql(ctx, { question }) as Record<string, any>;
        expect(out.nextTool).toBe('query_via_metadata');
        expect(out.semanticCandidate).toBeUndefined();
      }
    }, 60_000);

    it('lists Governed in the ask_dql answer contract', async () => {
      const out = await askDql(ctx, { question: 'What is the average order value by customer type?' }) as Record<string, any>;
      expect(out.answerContract.trustLabels).toEqual(['Certified', 'Governed', 'Reviewed', 'AI-Generated', 'Insufficient-Context', 'Conflict']);
    }, 60_000);
  });
});
