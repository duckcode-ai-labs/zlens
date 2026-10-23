import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticLayer } from '@zlens/core';

import { expandContext } from '../expand-context.js';
import { inspectMetadataContext } from '../kg.js';
import { querySemanticModel } from '../query-semantic-model.js';
import { queryViaMetadata } from '../query-via-metadata.js';
import { makeCtx } from './_helpers.js';

describe('agentic analytics tools', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-agentic-tools-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('compiles explicit semantic members into SQL and a DQL artifact', async () => {
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
      ],
      dimensions: [
        {
          name: 'order_channel',
          label: 'Order Channel',
          description: 'Channel where the order was placed.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
        },
        {
          name: 'order_month',
          label: 'Order Month',
          description: 'Order month.',
          sql: 'order_date',
          type: 'time',
          table: 'orders',
          isTimeDimension: true,
        },
      ],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      metrics: ['total_revenue'],
      dimensions: ['order_channel'],
      timeDimension: { name: 'order_month', granularity: 'month' },
      orderBy: [{ name: 'total_revenue', direction: 'desc' }],
      limit: 10,
      dryRun: true,
    });

    expect(out).toMatchObject({
      matched: true,
      uncertified: true,
      reviewStatus: 'draft_ready',
      certification: 'governed',
      trustLabelInfo: {
        id: 'governed',
        display: 'From Metrics',
      },
      trustStatus: {
        label: 'From Metrics: semantic compile',
        uncertified: true,
        reviewStatus: 'draft_ready',
        certification: 'governed',
        draftPath: 'blocks/_drafts/monthly_revenue_by_order_channel.dql',
        promotionPath: 'zlens certify --from-draft',
      },
      mode: 'explicit_members',
      metrics: ['total_revenue'],
      dimensions: ['order_channel'],
      executionStatus: 'dry_run',
      maxRowsReturned: 200,
    });
    expect((out as { sql: string }).sql).toContain('SUM(amount) AS total_revenue');
    expect((out as { sql: string }).sql).toContain('channel AS order_channel');
    expect((out as { dqlArtifact: { name: string } }).dqlArtifact.name).toBe('monthly_revenue_by_order_channel');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('block "monthly_revenue_by_order_channel"');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('type = "semantic"');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain(
      'metrics = ["total_revenue"]',
    );
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain(
      'dimensions = ["order_channel"]',
    );
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('order_by = ["total_revenue desc"]');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('limit = 10');
    expect((out as { draftBlock: { path: string; askedTimes: number } }).draftBlock).toMatchObject({
      path: 'blocks/_drafts/monthly_revenue_by_order_channel.dql',
      askedTimes: 1,
    });
    expect((out as { dqlArtifact: { sourcePath?: string } }).dqlArtifact.sourcePath).toBe(
      'blocks/_drafts/monthly_revenue_by_order_channel.dql',
    );
    const draft = readFileSync(join(tmpProject, 'blocks/_drafts/monthly_revenue_by_order_channel.dql'), 'utf-8');
    expect(draft).toContain('type = "semantic"');
    expect(draft).toContain('route_intent = "semantic_compile"');
    expect(draft).toContain('validation_warnings = ["semantic_draft_review_required"]');
  });

  it('executes semantic compile through a bounded preview by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          columns: [{ name: 'total_revenue', type: 'number' }],
          rows: [{ total_revenue: 42 }, { total_revenue: 84 }],
          executionTime: 7,
        },
      }),
    } as unknown as Response)));
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
      ],
      dimensions: [],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      metrics: ['total_revenue'],
      rowLimit: 1,
      serverUrl: 'http://runtime.test',
    });

    expect(out).toMatchObject({
      matched: true,
      executionStatus: 'executed',
      rowCount: 2,
      returnedRowCount: 1,
      maxRowsReturned: 1,
      rowsTruncated: true,
      durationMs: 7,
      rows: [{ total_revenue: 42 }],
      columns: [{ name: 'total_revenue', type: 'number' }],
    });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe('http://runtime.test/api/notebook/execute');
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.cell.type).toBe('sql');
    expect(body.cell.source).toContain('SELECT * FROM (');
    expect(body.cell.source).toContain('SUM(amount) AS total_revenue');
    expect(body.cell.source).toContain('AS dql_mcp_semantic_preview LIMIT 1');
  });

  it('can compile semantic members without saving a draft', async () => {
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
      ],
      dimensions: [],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      metrics: ['total_revenue'],
      saveDraft: false,
      dryRun: true,
    });

    expect(out).toMatchObject({
      matched: true,
      mode: 'explicit_members',
      draftBlock: undefined,
    });
    expect((out as { dqlArtifact: { sourcePath?: string } }).dqlArtifact.sourcePath).toBeUndefined();
  });

  it('selects multiple semantic metrics from a natural-language question', async () => {
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
        {
          name: 'order_count',
          label: 'Order Count',
          description: 'Count of orders.',
          domain: 'orders',
          sql: 'order_id',
          type: 'count',
          table: 'orders',
        },
      ],
      dimensions: [
        {
          name: 'order_channel',
          label: 'Order Channel',
          description: 'Channel where the order was placed.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
        },
      ],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      question: 'Show revenue and orders by channel',
      dryRun: true,
    });

    expect(out).toMatchObject({
      matched: true,
      uncertified: true,
      reviewStatus: 'draft_ready',
      certification: 'governed',
      trustStatus: {
        label: 'From Metrics: semantic compile',
        caveats: expect.arrayContaining(['semantic_draft_review_required']),
      },
      mode: 'question_selection',
      metrics: expect.arrayContaining(['total_revenue', 'order_count']),
      dimensions: ['order_channel'],
      executionStatus: 'dry_run',
    });
    expect((out as { sql: string }).sql).toContain('SUM(amount) AS total_revenue');
    expect((out as { sql: string }).sql).toContain('COUNT(order_id) AS order_count');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('metrics = [');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('"total_revenue"');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('"order_count"');
  });

  it('preserves order and limit for natural-language semantic top-N questions', async () => {
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
      ],
      dimensions: [
        {
          name: 'order_channel',
          label: 'Order Channel',
          description: 'Channel where the order was placed.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
        },
      ],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      question: 'Show top 5 channels by revenue',
      dryRun: true,
    });

    expect(out).toMatchObject({
      matched: true,
      mode: 'question_selection',
      orderBy: [{ name: 'total_revenue', direction: 'desc' }],
      limit: 5,
    });
    expect((out as { sql: string }).sql).toContain('ORDER BY total_revenue DESC');
    expect((out as { sql: string }).sql).toContain('LIMIT 5');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('order_by = ["total_revenue desc"]');
    expect((out as { dqlArtifact: { source: string } }).dqlArtifact.source).toContain('limit = 5');
  });

  it('does not compile a semantic query when requested dimensions are unavailable', async () => {
    const layer = new SemanticLayer({
      metrics: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: 'Total booked revenue.',
          domain: 'orders',
          sql: 'amount',
          type: 'sum',
          table: 'orders',
        },
      ],
      dimensions: [
        {
          name: 'order_channel',
          label: 'Order Channel',
          description: 'Channel where the order was placed.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
        },
      ],
    });

    const out = await querySemanticModel(makeCtx({}, { projectRoot: tmpProject, semanticLayer: layer } as never), {
      question: 'Show revenue by product',
    });

    expect(out).toMatchObject({
      matched: false,
      reason: expect.stringContaining('No semantic match'),
    });
  });

  it('expands an existing context pack so metadata queries can retry with a known relation', async () => {
    seedOrderSupplyProject(tmpProject);
    const ctx = makeCtx({}, { projectRoot: tmpProject } as never);

    // 'balanced' (ranked, top-k) keeps the pack narrow so `supplies` is genuinely
    // absent and the reject -> expand_context -> retry flow is exercised. Note:
    // 'exploratory' would hand the model the whole small catalog (full_catalog
    // mode), which intentionally makes this rejection path moot.
    const inspected = await inspectMetadataContext(ctx, {
      question: 'Show order totals by order date',
      limit: 1,
      strictness: 'balanced',
    });
    const contextPackId = inspected.contextPack.id;

    const rejected = await queryViaMetadata(ctx, {
      question: 'Show order totals by order date',
      contextPackId,
      proposedSql: 'SELECT supply_id, supply_name FROM SHOP.ANALYTICS.supplies',
      dryRun: true,
    });

    expect((rejected as { reviewStatus: string }).reviewStatus).toBe('rejected');
    expect((rejected as { errorCode: string }).errorCode).toBe('unknown_relation');

    const expanded = await expandContext(ctx, {
      contextPackId,
      relations: ['SHOP.ANALYTICS.supplies'],
      question: 'Include supply details with the previous order context',
    });

    expect(expanded).toMatchObject({
      ok: true,
      previousContextPackId: contextPackId,
      nextTool: 'query_via_metadata',
      regroundAttemptsUsed: 1,
      repairBudget: {
        attemptsUsed: 1,
        attemptsRemaining: 0,
      },
    });
    expect((expanded as { contextPackId: string }).contextPackId).not.toBe(contextPackId);
    expect((expanded as { addedRelations: Array<{ relation: string; columns: Array<{ name: string }> }> }).addedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'SHOP.ANALYTICS.supplies',
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'supply_id' }),
            expect.objectContaining({ name: 'supply_name' }),
          ]),
        }),
      ]),
    );

    const retried = await queryViaMetadata(ctx, {
      question: 'Include supply details with the previous order context',
      contextPackId: (expanded as { contextPackId: string }).contextPackId,
      proposedSql: 'SELECT supply_id, supply_name FROM SHOP.ANALYTICS.supplies',
      dryRun: true,
      outputs: ['supply_id', 'supply_name'],
    });

    expect((retried as { reviewStatus: string }).reviewStatus).toBe('draft_ready');
    expect((retried as { proposedSql: string }).proposedSql).toContain('SHOP.ANALYTICS.supplies');

    // A second expansion on the widened pack reports a real, incremented attempt
    // count (1 → 2), not a hardcoded 1.
    const expandedAgain = await expandContext(ctx, {
      contextPackId: (expanded as { contextPackId: string }).contextPackId,
      relations: ['SHOP.ANALYTICS.products'],
      question: 'Also include product details',
    });
    expect(expandedAgain).toMatchObject({
      ok: true,
      regroundAttemptsUsed: 2,
      repairBudget: { attemptsUsed: 2, attemptsRemaining: 0 },
    });
  });
});

function seedOrderSupplyProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'jaffle_shop' }), 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'jaffle_shop' },
      nodes: {
        'model.jaffle_shop.orders': {
          resource_type: 'model',
          name: 'orders',
          alias: 'orders',
          database: 'SHOP',
          schema: 'ANALYTICS',
          description: 'Order fact table with revenue and order dates.',
          depends_on: { nodes: [] },
          columns: {
            order_id: { name: 'order_id', data_type: 'text', description: 'Order identifier.' },
            order_date: { name: 'order_date', data_type: 'date', description: 'Date the order was placed.' },
            total_amount: { name: 'total_amount', data_type: 'number', description: 'Order total amount.' },
          },
        },
        'model.jaffle_shop.supplies': {
          resource_type: 'model',
          name: 'supplies',
          alias: 'supplies',
          database: 'SHOP',
          schema: 'ANALYTICS',
          description: 'Supply lookup table with supply names and costs.',
          depends_on: { nodes: [] },
          columns: {
            supply_id: { name: 'supply_id', data_type: 'text', description: 'Supply identifier.' },
            supply_name: { name: 'supply_name', data_type: 'text', description: 'Supply name.' },
            supply_cost: { name: 'supply_cost', data_type: 'number', description: 'Unit supply cost.' },
          },
        },
        'model.jaffle_shop.products': {
          resource_type: 'model',
          name: 'products',
          alias: 'products',
          database: 'SHOP',
          schema: 'ANALYTICS',
          description: 'Product lookup table with product names and prices.',
          depends_on: { nodes: [] },
          columns: {
            product_id: { name: 'product_id', data_type: 'text', description: 'Product identifier.' },
            product_name: { name: 'product_name', data_type: 'text', description: 'Product name.' },
            product_price: { name: 'product_price', data_type: 'number', description: 'Unit product price.' },
          },
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}
