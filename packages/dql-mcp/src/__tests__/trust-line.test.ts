import { describe, expect, it } from 'vitest';
import type { DQLContext } from '../context.js';
import { trustLineFor, withTrustLine } from '../trust-line.js';
import { DQL_MCP_INSTRUCTIONS } from '../server.js';

const ctx = {
  projectRoot: '/tmp/project',
  manifest: { blocks: { monthly_revenue: { name: 'monthly_revenue', status: 'certified', owner: 'analytics@jaffle.shop' } } },
} as unknown as DQLContext;

describe('trust line', () => {
  it('leads a certified block result with the label, the saved query and its owner', () => {
    const out = withTrustLine(ctx, 'query_via_block', { block: 'monthly_revenue', trustLabel: 'Certified', rows: [{ month: '2024-09-01' }] });
    expect(out).toMatchObject({ trustLine: '🟢 Certified · saved query monthly_revenue · owner analytics@jaffle.shop' });
    expect(Object.keys(out as object)[0]).toBe('trustLine');
  });

  it('marks a downgraded certified block amber and keeps its qualifier', () => {
    expect(trustLineFor(ctx, 'query_via_block', { block: 'monthly_revenue', trustLabel: 'Certified · stale data', rows: [] }))
      .toBe('🟡 Certified · stale data · saved query monthly_revenue · owner analytics@jaffle.shop');
  });

  it('labels a semantic compile From Metrics, or AI-Generated through an uncertified join', () => {
    expect(trustLineFor(ctx, 'query_semantic_model', {
      matched: true, metrics: ['large_orders'], rows: [], trustLabelInfo: { id: 'governed', display: 'From Metrics' },
      trustStatus: { draftPath: 'blocks/_drafts/monthly_large_orders.dql' },
    })).toBe('🔵 From Metrics · metric large_orders · not certified · draft saved for review at blocks/_drafts/monthly_large_orders.dql');
    expect(trustLineFor(ctx, 'query_semantic_model', {
      matched: true, metrics: ['food_orders'], rows: [], trustLabelInfo: { id: 'ai_generated', display: 'AI-Generated · uncertified join' },
    })).toBe('🟠 AI-Generated · uncertified join · metric food_orders · needs review');
    expect(trustLineFor(ctx, 'query_semantic_model', { matched: false })).toBeUndefined();
  });

  it('labels generated SQL AI-Generated and needs review, only once it ran', () => {
    expect(trustLineFor(ctx, 'query_via_metadata', {
      rows: [{ customer_name: 'A' }], trustStatus: { reviewStatus: 'draft_ready', draftPath: 'blocks/_drafts/top_customers.dql' },
    })).toBe('🟠 AI-Generated · SQL written for this question · needs review · draft saved for review at blocks/_drafts/top_customers.dql');
    // A dry run or a route plan has no rows, so no line.
    expect(trustLineFor(ctx, 'query_via_metadata', { trustStatus: { reviewStatus: 'draft_ready' } })).toBeUndefined();
    expect(trustLineFor(ctx, 'query_via_metadata', { rows: [], trustStatus: { reviewStatus: 'rejected' } })).toBeUndefined();
  });

  it('gives no line for failures, non-answer tools, or answer_question without a label', () => {
    expect(trustLineFor(ctx, 'query_via_block', { ok: false, error: 'runtime down' })).toBeUndefined();
    expect(trustLineFor(ctx, 'list_datasets', { ok: true, datasets: [] })).toBeUndefined();
    expect(trustLineFor(ctx, 'answer_question', { ok: false, modelUnavailable: true, error: 'no model' })).toBeUndefined();
    expect(trustLineFor(ctx, 'answer_question', { ok: true, trustLabelInfo: { id: 'certified', display: 'Certified' } })).toBe('🟢 Certified');
    const unchanged = { ok: true, datasets: [] };
    expect(withTrustLine(ctx, 'list_datasets', unchanged)).toBe(unchanged);
  });

  it('tells the client to open its answer with the line, word for word', () => {
    expect(DQL_MCP_INSTRUCTIONS).toContain('Start your answer with it, word for word');
  });
});
