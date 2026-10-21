import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appStudioDraftPath,
  createAppBuildHandoffDraft,
  ensureAgentProjectReady,
  matchAppSourceCatalogRecords,
  MetadataCatalog,
  queryAppSourceCatalog,
  rankAppSourcesByTrust,
  registerAppSourceRecordDecorator,
  resolveAppSourceCatalogRecords,
  shortlistAppSources,
} from './index.js';
import type { AppSourceCatalogRecord } from './index.js';

describe('AppSourceCatalogService', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-source-catalog-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ name: 'app-source-test' }));
    mkdirSync(join(projectRoot, 'domains', 'sales', 'blocks'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'customer', 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'performance.dql'), `block "Performance" {
  domain = "sales"
  status = "certified"
  description = "Revenue trend by order date and region"
  dimensions = ["order_date", "region"]
  allowedFilters = ["order_date", "region"]
  query = """SELECT order_date, region, SUM(revenue) AS revenue FROM orders GROUP BY 1, 2"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'customer', 'blocks', 'performance.dql'), `block "Performance" {
  domain = "customer"
  status = "draft"
  description = "New customer growth by week and segment"
  dimensions = ["week", "customer_segment"]
  allowedFilters = ["week", "customer_segment"]
  query = """SELECT week, customer_segment, COUNT(*) AS customers FROM customers GROUP BY 1, 2"""
}`);
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('PRD-007 API-014 keeps duplicate names and discovers drafts without making them governed', async () => {
    await ensureAgentProjectReady(projectRoot);
    const governed = queryAppSourceCatalog(projectRoot, { limit: 1, sourcePolicy: 'governed_only' });

    expect(governed.total).toBe(2);
    expect(governed.items).toHaveLength(1);
    expect(governed.nextCursor).toBeTruthy();
    expect(governed.facets.lifecycles).toMatchObject({ certified: 1, draft: 1 });

    const second = queryAppSourceCatalog(projectRoot, {
      limit: 1,
      cursor: governed.nextCursor,
      sourcePolicy: 'governed_only',
    });
    const all = [...governed.items, ...second.items];
    expect(new Set(all.map((source) => source.sourceId)).size).toBe(2);
    expect(new Set(all.map((source) => source.sourcePath)).size).toBe(2);
    const draft = all.find((source) => source.lifecycle === 'draft');
    expect(draft).toMatchObject({
      trust: 'review_required',
      eligibility: { discoverable: true, localPreview: false, projectPublish: false },
    });

    const reviewLane = queryAppSourceCatalog(projectRoot, {
      query: 'new customer growth',
      sourcePolicy: 'include_review_required',
    });
    expect(reviewLane.items[0]).toMatchObject({ lifecycle: 'draft', eligibility: { localPreview: true, projectPublish: false } });

    const resolved = resolveAppSourceCatalogRecords(projectRoot, all.map((source) => source.sourceId), 'include_review_required');
    expect(resolved.missingSourceIds).toEqual([]);
    expect(resolved.items).toHaveLength(2);

    expect(() => queryAppSourceCatalog(projectRoot, {
      limit: 1,
      cursor: governed.nextCursor,
      sourcePolicy: 'include_review_required',
    })).toThrow(/catalog changed/i);
  });

  it('applies the runtime\'s record decorator to every catalog read, and a failing one changes nothing (D2)', async () => {
    await ensureAgentProjectReady(projectRoot);
    const unregister = registerAppSourceRecordDecorator(projectRoot, (record) => ({ ...record, reasons: [...record.reasons, 'decorated'] }));
    try {
      const page = queryAppSourceCatalog(projectRoot, { sourcePolicy: 'include_review_required' });
      expect(page.items.every((item) => item.reasons.includes('decorated'))).toBe(true);
      const resolved = resolveAppSourceCatalogRecords(projectRoot, page.items.map((item) => item.sourceId), 'include_review_required');
      expect(resolved.items.every((item) => item.reasons.includes('decorated'))).toBe(true);
      expect(matchAppSourceCatalogRecords(projectRoot, { blockNames: ['Performance'] }, 'include_review_required').items[0]!.reasons).toContain('decorated');
    } finally {
      unregister();
    }
    expect(queryAppSourceCatalog(projectRoot, { sourcePolicy: 'include_review_required' }).items.some((item) => item.reasons.includes('decorated'))).toBe(false);
    const removeFailing = registerAppSourceRecordDecorator(projectRoot, () => { throw new Error('boom'); });
    try {
      expect(queryAppSourceCatalog(projectRoot, { sourcePolicy: 'include_review_required' }).items).toHaveLength(2);
    } finally {
      removeFailing();
    }
  });

  it('PRD-007 excludes generated legacy drafts until an explicit reusable tag is present', async () => {
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'legacy-analysis.dql'), `block "Legacy generated analysis" {
  domain = "sales"
  status = "draft"
  source_question = "Why did revenue change?"
  query = """SELECT 1 AS value"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'tagged-legacy-analysis.dql'), `block "Tagged legacy generated analysis" {
  domain = "sales"
  status = "draft"
  tags = ["ai-generated"]
  query = """SELECT 4 AS value"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'manual-semantic-draft.dql'), `block "Manual semantic request draft" {
  domain = "sales"
  status = "draft"
  requested_filters = ["region=West"]
  requested_dimensions = ["month"]
  time_dimension = "order_date"
  granularity = "month"
  limit = 12
  draft_path = "blocks/_drafts/manual-semantic-draft.dql"
  query = """SELECT 5 AS value"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'saved-analysis.dql'), `block "Saved generated analysis" {
  domain = "sales"
  status = "draft"
  tags = ["app-source"]
  source_question = "Why did revenue change?"
  query = """SELECT 2 AS value"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'certified-history.dql'), `block "Certified generated history" {
  domain = "sales"
  status = "certified"
  source_question = "Historical generated provenance"
  query = """SELECT 3 AS value"""
}`);

    await ensureAgentProjectReady(projectRoot);
    const page = queryAppSourceCatalog(projectRoot, {
      sourcePolicy: 'include_review_required',
      limit: 20,
    });
    const names = page.items.map((item) => item.name);

    expect(names).not.toContain('Legacy generated analysis');
    expect(names).not.toContain('Tagged legacy generated analysis');
    expect(names).toContain('Manual semantic request draft');
    expect(names).toContain('Saved generated analysis');
    expect(names).toContain('Certified generated history');
    expect(page.items.find((item) => item.name === 'Saved generated analysis')).toMatchObject({
      lifecycle: 'draft',
      trust: 'review_required',
    });
  });

  it('keeps review-required sources out of the AI shortlist when the App uses only certified data', async () => {
    await ensureAgentProjectReady(projectRoot);

    const certifiedOnly = shortlistAppSources(projectRoot, 'performance customer growth revenue', { sourcePolicy: 'governed_only' });
    expect(certifiedOnly.items.length).toBeGreaterThan(0);
    expect(certifiedOnly.items.every((source) => source.trust === 'certified')).toBe(true);
    expect(certifiedOnly.items.map((source) => source.domain)).toEqual(['sales']);

    const reviewAllowed = shortlistAppSources(projectRoot, 'performance customer growth revenue', { sourcePolicy: 'include_review_required' });
    expect(reviewAllowed.items.map((source) => source.lifecycle).sort()).toEqual(['certified', 'draft']);

    // An explicitly required source still resolves; its own policy check is the caller's.
    const draftId = reviewAllowed.items.find((source) => source.lifecycle === 'draft')!.sourceId;
    const required = resolveAppSourceCatalogRecords(projectRoot, [draftId], 'governed_only');
    expect(required.items).toHaveLength(1);
    expect(required.items[0]).toMatchObject({ trust: 'review_required', eligibility: { localPreview: false } });
  });

  it('orders catalog pages and the AI shortlist by trust after relevance', async () => {
    await ensureAgentProjectReady(projectRoot);
    // The draft matches the prompt best, yet a certified source leads the page.
    const page = queryAppSourceCatalog(projectRoot, { query: 'performance', sourcePolicy: 'include_review_required' });
    expect(page.items.map((source) => source.trust)).toEqual(['certified', 'review_required']);
    const shortlist = shortlistAppSources(projectRoot, 'performance', { sourcePolicy: 'include_review_required' });
    expect(shortlist.items.map((source) => source.trust)).toEqual(['certified', 'review_required']);
  });

  it('ranks certified Datasets, then Metrics, then saved queries, then sources that need review', () => {
    const source = (id: string, patch: Partial<AppSourceCatalogRecord>): AppSourceCatalogRecord => ({
      sourceId: id,
      qualifiedIdentity: id,
      sourceRevision: 'r1',
      snapshotId: 's1',
      kind: 'block',
      lifecycle: 'certified',
      trust: 'certified',
      executable: true,
      name: id,
      title: id,
      sourcePath: `${id}.dql`,
      executionRef: `${id}.dql`,
      tags: [],
      capabilities: { measures: [], dimensions: [], outputs: [], filters: [], allowedVisualizations: [], parameters: [] },
      eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
      reasons: [],
      ...patch,
    });
    const dataset = { kind: 'block' } as unknown as NonNullable<AppSourceCatalogRecord['capabilities']['dataset']>;
    const fields = { ...source('x', {}).capabilities, dataset };
    const ranked = rankAppSourcesByTrust([
      source('review-dataset', { trust: 'review_required', lifecycle: 'draft', capabilities: fields }),
      source('saved-query-a', {}),
      source('metrics', { kind: 'semantic' }),
      source('dataset-a', { capabilities: fields }),
      source('review-query', { trust: 'review_required', lifecycle: 'review' }),
      source('saved-query-b', {}),
      source('dataset-b', { capabilities: fields }),
      source('metrics-model', { capabilities: { ...source('x', {}).capabilities, semanticModelId: 'orders' } }),
    ]);
    expect(ranked.map((item) => item.sourceId)).toEqual([
      'dataset-a',
      'dataset-b',
      'metrics',
      'metrics-model',
      'saved-query-a',
      'saved-query-b',
      'review-dataset',
      'review-query',
    ]);
  });

  it('PERF-003 pages and exact-searches a 4,000-source warm index within response budgets', () => {
    const catalog = new MetadataCatalog(join(projectRoot, '.dql', 'cache', 'app-scale.sqlite'));
    try {
      const objects = Array.from({ length: 4_000 }, (_, index) => ({
        objectKey: `app:block:sales:${String(index).padStart(4, '0')}`,
        objectType: 'dql_block_source',
        name: `Sales source ${index}`,
        fullName: `sales::block::Sales source ${index}`,
        domain: index % 2 ? 'sales' : 'customer',
        owner: 'analytics',
        status: index % 3 ? 'draft' : 'certified',
        description: index === 3_999 ? 'late-position executive renewal signal' : `bounded App source ${index}`,
        sourcePath: `blocks/scale/source-${index}.dql`,
        payload: { tags: ['scale'], allowedFilters: ['order_date'], dimensions: ['region'] },
      }));
      catalog.rebuild({
        projectRoot,
        manifest: { generatedAt: '2026-08-10T00:00:00.000Z' } as never,
        objects,
        edges: [], diagnostics: [], compileConflicts: [],
        fingerprint: 'scale-4000', generatedAt: '2026-08-10T00:00:00.000Z',
      });

      const started = performance.now();
      const page = catalog.queryObjectsPage({
        query: 'late-position executive renewal signal',
        objectTypes: ['dql_block_source'],
        limit: 50,
      });
      const elapsed = performance.now() - started;
      expect(page.total).toBe(1);
      expect(page.items[0]?.objectKey).toBe('app:block:sales:3999');
      expect(page.items).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(500_000);
      expect(elapsed).toBeLessThan(500);
      const exactStarted = performance.now();
      const exact = catalog.getObjectsByKeys(['app:block:sales:3999']);
      const exactElapsed = performance.now() - exactStarted;
      expect(exact[0]?.sourcePath).toBe('blocks/scale/source-3999.dql');
      expect(exactElapsed).toBeLessThan(100);
    } finally {
      catalog.close();
    }
  });

  it('D9 matches the blocks an Ask or MCP build named, certified first, and reports names it cannot find', async () => {
    await ensureAgentProjectReady(projectRoot);
    const matched = matchAppSourceCatalogRecords(projectRoot, { blockNames: ['performance', 'No Such Block'] }, 'include_review_required');
    expect(matched.items).toHaveLength(1);
    expect(matched.items[0]).toMatchObject({ name: 'Performance', domain: 'sales', trust: 'certified' });
    expect(matched.unmatched).toEqual(['No Such Block']);
  });

  it('D9 makes an AI App draft with the picked data, its gaps and only certified data unless review data was kept', async () => {
    await ensureAgentProjectReady(projectRoot);
    const all = queryAppSourceCatalog(projectRoot, { sourcePolicy: 'include_review_required' }).items;
    const certified = all.filter((source) => source.trust === 'certified');
    const draft = createAppBuildHandoffDraft({
      goal: 'Sales performance for leadership',
      domain: 'sales',
      sources: all,
      gaps: [{ question: 'Why is churn rising?' }, { question: 'why is churn rising?' }],
    });
    expect(draft).toMatchObject({
      appId: 'sales-performance-for-leadership',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
      frame: expect.objectContaining({ goal: 'Sales performance for leadership' }),
    });
    expect(draft.sources.map((source) => source.id)).toEqual(certified.map((source) => source.sourceId));
    expect(draft.pages).toHaveLength(1);
    expect(draft.pages[0]).toMatchObject({ metadata: expect.objectContaining({ domain: 'sales' }), layout: expect.objectContaining({ items: [] }) });
    expect(draft.requirements.map((requirement) => requirement.question)).toEqual(['Why is churn rising?']);
    expect(draft.coverage).toEqual([expect.objectContaining({ status: 'gap', sourceIds: [] })]);
    expect(appStudioDraftPath(draft.id)).toBe(`/?appDraft=${draft.id}`);

    const withReview = createAppBuildHandoffDraft({ goal: 'Sales and customers', sources: all, sourcePolicy: 'include_review_required' });
    expect(withReview.sources).toHaveLength(all.length);
    expect(withReview.sources.find((source) => source.trustState === 'review_required')).toMatchObject({ reviewStatus: 'required' });
  });
});
