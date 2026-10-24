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
// From Metrics and needs-review answers. jaffle-golden has the same blocks and
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

  describe('a semantic compile reads From Metrics, as the Ask page does', () => {
    it('labels a single-table compile and its DQL artifact From Metrics, and never Certified', async () => {
      const out = await semantic({ question: 'How many large orders did we get each month?' });
      expect(out.metrics).toEqual(['large_orders']);
      expect(out.composeResult.joinPath).toEqual([]);
      expect(out.trustLabelInfo).toMatchObject({ id: 'governed', base: 'From Metrics', display: 'From Metrics' });
      expect(out.dqlArtifact.trustState).toBe('governed');
      expect(out.certification).toBe('governed');
      expect(out.aiGenerated).toBe(false);
      expect(out.relationshipProof).toEqual({ certified: true, joins: [] });
      // uncertified: no certified block backs it; it does not make the answer AI-generated.
      expect(out.uncertified).toBe(true);
    }, 60_000);
  });

  // Found on 2026-10-23 in a Claude Desktop recording on 0.2.5: the compile
  // joined orders to locations through order_to_location, a draft
  // relationship, and was labelled Governed; Claude itself called it "an
  // uncertified, AI-generated semantic compile".
  describe('a semantic compile is From Metrics only when every join is a certified relationship', () => {
    it('labels a compile through the draft order_to_location join AI-Generated, and names the relationship', async () => {
      const out = await semantic({ question: 'How many large orders did each location get?' });
      expect(out.metrics).toEqual(['large_orders']);
      expect(out.dimensions).toEqual(['location_name']);
      expect(out.composeResult.joinPath).toHaveLength(1);
      expect(out.certification).toBe('ai_generated');
      expect(out.aiGenerated).toBe(true);
      expect(out.trustLabelInfo).toMatchObject({ id: 'ai_generated', base: 'AI-Generated', display: 'AI-Generated · uncertified join' });
      expect(out.trustStatus.label).toBe('AI-Generated: semantic compile through an uncertified join');
      expect(out.dqlArtifact.trustState).toBe('review_required');
      expect(out.relationshipProof.certified).toBe(false);
      expect(out.relationshipProof.joins[0]).toMatchObject({ from: 'orders', to: 'locations', relationshipName: 'order_to_location', status: 'draft', certified: false });
      expect(out.trustStatus.caveats.join(' ')).toContain('relationship "order_to_location", which is draft, not certified');
    }, 60_000);

    it('labels the same explicit-member compile the same way', async () => {
      const out = await semantic({ metrics: ['large_orders'], dimensions: ['location_name'] });
      expect(out.certification).toBe('ai_generated');
      expect(out.trustLabelInfo.base).toBe('AI-Generated');
    }, 60_000);

    it('names every draft join of a two-hop compile', async () => {
      const out = await semantic({ question: 'How much revenue did each location make?' });
      expect(out.certification).toBe('ai_generated');
      expect(out.relationshipProof.joins.map((join: { relationshipName: string }) => join.relationshipName)).toEqual(['order_item_to_order', 'order_to_location']);
      expect(out.trustStatus.caveats.join(' ')).toContain('order_item_to_order');
    }, 60_000);

    it('keeps From Metrics for a ratio compiled from one table (average order value by customer type reads customers only)', async () => {
      const out = await semantic({ question: 'What is the average order value by customer type?' });
      expect(out.metric).toBe('average_order_value');
      expect(out.composeResult.joinPath).toEqual([]);
      expect(out.certification).toBe('governed');
    }, 60_000);

    it('ask_dql names the AI-Generated label for a compile that needs a draft join', async () => {
      const out = await askDql(ctx, { question: 'How many large orders did each location get?' }) as Record<string, any>;
      expect(out.nextTool).toBe('query_semantic_model');
      expect(out.semanticCandidate.trustLabel).toMatchObject({ id: 'ai_generated', base: 'AI-Generated' });
      expect(out.semanticCandidate.joinCaveat).toContain('order_to_location');
      expect(out.recommendedAction).toContain('AI-Generated');
    }, 60_000);

    it('ask_dql sends a question the semantic layer answers to query_semantic_model, not to AI SQL', async () => {
      const out = await askDql(ctx, { question: 'How many large orders did we get each month?' }) as Record<string, any>;
      expect(out.nextTool).toBe('query_semantic_model');
      expect(out.semanticCandidate).toMatchObject({ metric: 'large_orders', trustLabel: { base: 'From Metrics' } });
      expect(out.recommendedAction).toContain('query_semantic_model');
    }, 60_000);

    it('ask_dql keeps AI SQL for a question no semantic metric names, or a date range it cannot apply', async () => {
      for (const question of ['How many employees work at each store?', 'Which store location had the most orders in 2025?']) {
        const out = await askDql(ctx, { question }) as Record<string, any>;
        expect(out.nextTool).toBe('query_via_metadata');
        expect(out.semanticCandidate).toBeUndefined();
      }
    }, 60_000);

    it('lists From Metrics in the ask_dql answer contract', async () => {
      const out = await askDql(ctx, { question: 'What is the average order value by customer type?' }) as Record<string, any>;
      expect(out.answerContract.trustLabels).toEqual(['Certified', 'From Metrics', 'Reviewed', 'AI-Generated', 'Insufficient-Context', 'Conflict']);
    }, 60_000);
  });

  describe('the semantic route answers only when it expresses every breakdown and filter in the question', () => {
    const busiestHour = 'What was the busiest hour of the day for orders in Philadelphia?';

    it('query_semantic_model does not answer the busiest hour of the day in Philadelphia with the orders total', async () => {
      const out = await semantic({ question: busiestHour });
      expect(out.matched).toBe(false);
      expect(out.sql).toBeUndefined();
      expect(out.trustLabelInfo).toBeUndefined();
      expect(out.nearestMetric).toBe('orders');
      expect(out.unexpressed).toEqual(['filter "Philadelphia"', 'breakdown "hour of the day"']);
      expect(out.nextTool).toBe('query_via_metadata');
      expect(out.reason).toMatch(/^No semantic match/);
    }, 60_000);

    it('query_semantic_model does not answer large orders in Brooklyn in March 2025 with all large orders', async () => {
      const out = await semantic({ question: 'How many large orders in Brooklyn in March 2025?' });
      expect(out.matched).toBe(false);
      expect(out.unexpressed).toEqual(['date range "in March 2025"', 'filter "Brooklyn"']);
    }, 60_000);

    it('refuses explicit members that leave out part of the question they come with', async () => {
      const out = await semantic({
        question: busiestHour,
        metrics: ['orders'],
        filters: [{ dimension: 'location_name', operator: 'equals', values: ['Philadelphia'] }],
      });
      expect(out.matched).toBe(false);
      expect(out.unexpressed).toEqual(['breakdown "hour of the day"']);
    }, 60_000);

    it('compiles the location filter when the question names it with its dimension', async () => {
      const out = await semantic({ question: 'How many orders at the Philadelphia location?' });
      expect(out.matched).toBe(true);
      expect(out.metrics).toEqual(['orders']);
      expect(out.filters).toEqual([{ dimension: 'location_name', operator: 'equals', values: ['Philadelphia'] }]);
      expect(out.sql).toContain("location_name = 'Philadelphia'");
    }, 60_000);

    it('ask_dql sends the question to query_via_metadata and says what the metric cannot express', async () => {
      const out = await askDql(ctx, { question: busiestHour }) as Record<string, any>;
      expect(out.nextTool).toBe('query_via_metadata');
      expect(out.semanticCandidate).toBeUndefined();
      expect(out.semanticGap).toEqual({ nearestMetric: 'orders', unexpressed: ['filter "Philadelphia"', 'breakdown "hour of the day"'] });
      expect(out.recommendedAction).toContain('hour of the day');
    }, 60_000);
  });
});
