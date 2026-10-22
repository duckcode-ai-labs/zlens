import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppPlan, AppSourceCatalogRecord } from '@zlens/agent';
import type { AppBuildDraft, AppBuildDraftSource, DashboardDocument, DatasetDescriptor } from '@zlens/core';
import { appBuildPreviewIntentFingerprint, loadDashboardDocument } from '@zlens/core';
import { defaultLocalAppsDbPath, defaultPersonaRegistry, LocalAppStorage } from '@zlens/project';
import {
  __test__,
  addAskResultToAppBuildDraft,
  approveAppSemanticTiles,
  applyAppAutopilotChange,
  createAppAiBuildSession,
  createAppPackage,
  createStoredAppBuildDraft,
  createDashboardForApp,
  createNotebookForApp,
  deleteAppPackage,
  restoreAppPackage,
  generateAppPackage,
  getAppAiBuildSession,
  handleAppsApi,
  appBuildDraftTrust,
  markStoredAppBuildDraftPreflighted,
  publishStoredAppBuildDraft,
  promoteAppForStakeholders,
  renameApp,
  previewNotebookForApp,
  preflightStoredAppBuildDraft,
  prepareAppAutopilotChange,
  proposeAppAiBuild,
  proposeAppBuildDraftOperations,
  recommendBlocks,
  recommendDashboardTile,
  recommendVisualization,
  matchAppDraftForQuestion,
  openAppAiBuildInStudio,
  writeDashboardForTest,
} from './apps-api.js';

const tempDirs: string[] = [];

interface TestBlockSpec {
  name: string;
  domain: string;
  status: string;
  tags: string[];
  description: string;
  chart: string;
  query?: string;
  allowedFilters?: string[];
  filterBindings?: Array<{ filter: string; binding: string }>;
  dimensions?: string[];
  params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
}

afterEach(() => {
  defaultPersonaRegistry.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes the App an AI build session planned, the way the App generator does. */
async function generateAppFromSessionPlan(root: string, session: Awaited<ReturnType<typeof proposeAppAiBuild>>, plan = session.plan as AppPlan) {
  const { KGStore, defaultKgPath, generateAppFromPlan, reindexProject } = await import('@zlens/agent');
  await reindexProject(root, { kgPath: defaultKgPath(root) });
  const kg = new KGStore(defaultKgPath(root));
  try {
    return generateAppFromPlan(root, plan, kg, { overwrite: true });
  } finally {
    kg.close();
  }
}

function publishedDatasetDescriptor(
  sourceId: string,
  kind: 'block' | 'semantic',
  sourceRevision: string,
  contractFingerprint: string,
): DatasetDescriptor {
  return {
    version: 1,
    id: `dataset:${sourceId}`,
    kind,
    sourceRevision,
    snapshotId: 'published-snapshot',
    contractRef: {
      kind: kind === 'semantic' ? 'semantic_model' : 'block_source',
      id: sourceId,
      fingerprint: contractFingerprint,
    },
    binding: {
      sourceQualifiedId: sourceId,
      sourceRevision,
      contractFingerprint,
      state: 'target_required',
    },
    label: `${kind} orders`,
    domain: 'commerce',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof:order-lines' },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: `${sourceId}:order_line_id`, type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'region', qualifiedId: `${sourceId}:region`, type: 'string', role: 'dimension', status: 'approved' },
      {
        kind: 'measure', name: 'revenue', qualifiedId: `${sourceId}:revenue`, aggregation: 'sum', from: 'net_amount',
        dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
      },
    ],
    operations: ['filter', 'group', 'trend'],
    execution: { route: kind === 'semantic' ? 'semantic' : 'certified', ...(kind === 'semantic' ? { adapterId: 'native' } : {}) },
  };
}

function publishedDatasetCatalogRecord(
  sourceId: string,
  kind: 'block' | 'semantic',
  sourceRevision: string,
  dataset: DatasetDescriptor,
): AppSourceCatalogRecord {
  return {
    sourceId,
    qualifiedIdentity: sourceId,
    sourceRevision,
    snapshotId: 'current-catalog-snapshot',
    kind,
    lifecycle: 'certified',
    trust: 'certified',
    executable: true,
    name: sourceId.split(':').at(-1) ?? sourceId,
    title: `${kind} orders`,
    domain: 'commerce',
    sourcePath: kind === 'semantic' ? 'semantic/order-lines.yaml' : 'domains/commerce/blocks/order-lines.dql',
    executionRef: kind === 'semantic' ? 'order_lines' : 'domains/commerce/blocks/order-lines.dql',
    tags: ['commerce'],
    capabilities: {
      measures: ['revenue'],
      dimensions: ['region'],
      outputs: ['revenue'],
      filters: ['region'],
      allowedVisualizations: ['kpi', 'table'],
      dataset,
      parameters: [],
    },
    eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
    reasons: [],
  };
}

/** A persisted source card is deliberately just historic input in these API
 * tests. The PATCH boundary must replace it with the current catalog record. */
function publishedDatasetDraftSource(record: AppSourceCatalogRecord): AppBuildDraftSource {
  const certified = record.lifecycle === 'certified' && record.trust === 'certified';
  return {
    id: record.sourceId,
    kind: record.kind === 'semantic' ? 'governed_semantic' : 'block',
    sourceRef: record.executionRef,
    qualifiedIdentity: record.qualifiedIdentity,
    sourcePath: record.sourcePath,
    executionRef: record.executionRef,
    snapshotId: record.snapshotId,
    sourceRevision: record.sourceRevision,
    sourceFingerprint: record.sourceRevision,
    lifecycle: record.lifecycle,
    capabilities: record.capabilities,
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'not_required' : 'required',
  };
}

function publishedDatasetPage(input: {
  id: string;
  title: string;
  sourceId: string;
  sourceRevision: string;
  contractFingerprint: string;
  tileId: string;
  tileTitle: string;
  query: NonNullable<DashboardDocument['layout']['items'][number]['query']>;
  viz: DashboardDocument['layout']['items'][number]['viz']['type'];
}): DashboardDocument {
  const datasetId = `dataset-${input.id}`;
  return {
    version: 3,
    id: input.id,
    metadata: {
      title: input.title,
      domain: 'commerce',
      audience: 'operators',
      visibility: 'shared',
      lifecycle: 'certified',
    },
    datasets: [{
      id: datasetId,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      snapshotId: 'published-snapshot',
      contractFingerprint: input.contractFingerprint,
    }],
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [{
        i: input.tileId,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        query: input.query,
        viz: { type: input.viz },
        title: input.tileTitle,
        sourceClass: input.sourceId.startsWith('app:semantic:') ? 'governed_semantic' : 'certified_block',
        trustState: 'certified',
        reviewStatus: 'certified',
      }],
    },
  };
}

describe('Apps command center API helpers', () => {
  it('recommends certified domain and tag matches before unrelated blocks', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    writeBlock(root, 'finance/cost.dql', {
      name: 'Cost Total',
      domain: 'finance',
      status: 'certified',
      tags: ['cost'],
      description: 'Finance cost KPI',
      chart: 'bar',
    });
    writeBlock(root, 'growth/draft.dql', {
      name: 'Draft Pipeline',
      domain: 'growth',
      status: 'draft',
      tags: ['cxo'],
      description: 'Draft pipeline',
      chart: 'line',
    });

    const blocks = recommendBlocks(root, {
      domain: 'growth',
      tags: ['cxo'],
      purpose: 'executive revenue',
      certifiedOnly: true,
    });

    expect(blocks.map((block) => block.name)).toEqual(['Revenue Total']);
    expect(blocks[0].reasons).toContain('domain match');
  });

  it('falls back to certified blocks for generic AI app prompts and token-matches business prompts', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top NBA Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring', 'player'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });
    writeBlock(root, 'finance/revenue.dql', {
      name: 'Revenue Total',
      domain: 'finance',
      status: 'certified',
      tags: ['revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const generic = recommendBlocks(root, {
      purpose: 'Build an analytics app from my certified DQL blocks and available warehouse tables.',
      certifiedOnly: true,
    });
    expect(generic.map((block) => block.name)).toEqual(expect.arrayContaining(['Top NBA Scorers', 'Revenue Total']));
    expect(generic.every((block) => block.status === 'certified')).toBe(true);

    const nba = recommendBlocks(root, {
      purpose: 'Build an NBA player performance app showing top scorers.',
      certifiedOnly: true,
    });
    expect(nba[0].name).toBe('Top NBA Scorers');
    expect(nba[0].reasons).toContain('context match');
  });

  it('never exposes semantic terms as addable App block sources', () => {
    const root = createProject();
    writeBlock(root, 'commerce/monthly-revenue.dql', {
      name: 'Monthly Revenue',
      domain: 'commerce',
      status: 'certified',
      tags: ['revenue'],
      description: 'Executable monthly revenue trend',
      chart: 'line',
    });
    const termsDir = join(root, 'domains', 'commerce', 'terms');
    mkdirSync(termsDir, { recursive: true });
    writeFileSync(join(termsDir, 'revenue.dql'), 'term "Revenue" {\n  domain = "commerce"\n  status = "certified"\n  description = "Business meaning of gross revenue"\n}\n', 'utf-8');

    const blocks = recommendBlocks(root, { domain: 'commerce', purpose: 'revenue', certifiedOnly: true });
    expect(blocks.map((block) => block.name)).toEqual(['Monthly Revenue']);
  });

  it('deduplicates migrated block copies and exposes declared App filters and dimensions (UI-022)', () => {
    const root = createProject();
    const spec = {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
      allowedFilters: ['customer_type'],
      filterBindings: [{ filter: 'region', binding: 'customer_region' }],
      dimensions: ['month'],
    };
    writeBlock(root, 'growth/revenue.dql', spec);
    writeDomainBlock(root, 'growth', 'revenue.dql', spec);

    const blocks = recommendBlocks(root, { certifiedOnly: true });
    expect(blocks.filter((block) => block.id === 'Revenue Total')).toHaveLength(1);
    expect(blocks.find((block) => block.id === 'Revenue Total')).toMatchObject({
      path: 'domains/growth/blocks/revenue.dql',
      filterIds: ['customer_type', 'region'],
      dimensionIds: ['month'],
    });
  });

  it('creates canonical App folders and dashboard references without duplicating blocks', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
      filterBindings: [{ filter: 'region', binding: 'customer_region' }],
    });

    const result = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      tags: ['weekly'],
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(root, 'apps/growth-cxo/dql.app.json'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/README.md'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/notebooks'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/drafts'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/blocks'))).toBe(false);

    const app = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dql.app.json'), 'utf-8'));
    expect(app.visibility).toBe('private');
    expect(app.lifecycle).toBe('draft');
    expect(app.audience).toBe('executive');

    const dashboard = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.version).toBe(2);
    expect(dashboard.metadata.visibility).toBe('private');
    expect(dashboard.metadata.lifecycle).toBe('draft');
    expect(dashboard.layout.items[0].block).toEqual({ blockId: 'Revenue Total' });
    expect(dashboard.layout.items[0].display).toMatchObject({
      mode: 'block_hint',
      component: 'KpiMetric',
      trustState: 'certified',
    });
    expect(dashboard.layout.items[0].filterBindings).toEqual([
      { filter: 'region', binding: 'customer_region', mode: 'predicate' },
    ]);
    expect(dashboard.filters).toEqual([{ id: 'region', label: 'Region', type: 'select', bindsTo: 'region' }]);
    expect(result.app.dashboards).toEqual([{ id: 'overview', title: 'Overview' }]);
  });

  it('keeps manual creation private and rejects non-certified block selections', () => {
    const root = createProject();
    writeDomainBlock(root, 'growth', 'draft-revenue.dql', {
      name: 'Draft Revenue',
      domain: 'growth',
      status: 'draft',
      tags: ['revenue'],
      description: 'Unreviewed revenue logic',
      chart: 'single_value',
    });

    const result = createAppPackage(root, {
      name: 'Unsafe Growth',
      domain: 'growth',
      selectedBlockIds: ['Draft Revenue'],
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/certified saved queries only/i);
    expect(existsSync(join(root, 'apps/unsafe-growth'))).toBe(false);
  });

  it('names a described App from the first line of the description, at most 60 characters (B9)', () => {
    const root = createProject();
    const draft = createStoredAppBuildDraft(root, {
      goal: 'A weekly revenue dashboard: revenue by month, the top regions, and the latest orders.\nA page for a sales manager.',
      authoringMode: 'ai',
    });
    expect(draft.name).toBe('A weekly revenue dashboard: revenue by month, the top');
    expect(draft.name.length).toBeLessThanOrEqual(60);
    expect(draft.frame.goal).toContain('A page for a sales manager.');
  });

  it('keeps the unified manual draft local until atomic Publish to Project', () => {
    const root = createProject();
    const draft = createStoredAppBuildDraft(root, {
      appId: 'revenue-studio',
      name: 'Revenue Studio',
      goal: 'Revenue Studio',
      audience: 'finance leaders',
      domain: 'finance',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    });

    expect(existsSync(join(root, 'apps/revenue-studio'))).toBe(false);
    expect(draft.state).toBe('local_draft');
    const preflighted = markStoredAppBuildDraftPreflighted(root, draft);
    expect(existsSync(join(root, 'apps/revenue-studio'))).toBe(false);
    const result = publishStoredAppBuildDraft(root, preflighted);

    expect(result.app).toMatchObject({ id: 'revenue-studio', visibility: 'shared', lifecycle: 'review' });
    expect(result.draft).toMatchObject({ state: 'project_published', revision: 2 });
    const page = JSON.parse(readFileSync(join(root, 'apps/revenue-studio/dashboards/overview.dqld'), 'utf-8'));
    expect(page).toMatchObject({
      version: 2,
      metadata: { visibility: 'shared', lifecycle: 'review' },
      layout: { responsive: { wide: { cols: 12 }, medium: { cols: 6 }, narrow: { cols: 1 } } },
    });
    expect(existsSync(join(root, '.dql/local/app-build-staging', draft.id))).toBe(false);
  });

  it('keeps alerts, governance and other App files when a published App is republished (evaluation I1)', () => {
    const root = createProject();
    const first = createStoredAppBuildDraft(root, {
      appId: 'revenue-studio', name: 'Revenue Studio', goal: 'Revenue Studio', domain: 'finance',
      authoringMode: 'manual', sourcePolicy: 'governed_only',
    });
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, first));
    const appDir = join(root, 'apps/revenue-studio');
    const appPath = join(appDir, 'dql.app.json');
    const app = JSON.parse(readFileSync(appPath, 'utf-8'));
    app.schedules = [{
      id: 'alerts-overview', cron: '0 8 * * *', dashboard: 'overview', deliver: [], digest: false,
      monitors: [{ id: 'low', binding: 'kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 } }],
    }];
    app.members = [...app.members, { userId: 'ana@local', displayName: 'Ana', roles: ['viewer'] }];
    writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');
    writeFileSync(join(appDir, 'notebooks', 'analysis.dqlnb'), '{"cells":[]}\n');
    writeFileSync(join(appDir, 'drafts', 'note.md'), 'kept\n');
    writeFileSync(join(appDir, 'dashboards', 'retired.dqld'), readFileSync(join(appDir, 'dashboards', 'overview.dqld'), 'utf-8').replace('"id": "overview"', '"id": "retired"'));

    const edit = createStoredAppBuildDraft(root, {
      baseAppId: 'revenue-studio', name: 'Revenue Studio v2', goal: 'Revenue Studio', authoringMode: 'manual', sourcePolicy: 'governed_only',
    });
    const withoutRetired = { ...edit, pages: edit.pages.filter((page) => page.id !== 'retired') };
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, withoutRetired));

    const republished = JSON.parse(readFileSync(appPath, 'utf-8'));
    expect(republished.name).toBe('Revenue Studio v2');
    expect(republished.schedules).toEqual(app.schedules);
    expect(republished.members).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'ana@local' })]));
    expect(readFileSync(join(appDir, 'notebooks', 'analysis.dqlnb'), 'utf-8')).toBe('{"cells":[]}\n');
    expect(readFileSync(join(appDir, 'drafts', 'note.md'), 'utf-8')).toBe('kept\n');
    // Pages belong to the draft: one removed there is removed here.
    expect(existsSync(join(appDir, 'dashboards', 'retired.dqld'))).toBe(false);
    expect(existsSync(join(appDir, 'dashboards', 'overview.dqld'))).toBe(true);
  });

  // New-user round 2, problem 10: the card read "Governed analytical App for Sales Manager Manual", never written by anyone.
  it('keeps the description the author wrote, and fills a plain one only when there is none', () => {
    const root = createProject();
    const plain = createStoredAppBuildDraft(root, { appId: 'sales-manual', name: 'Sales Manager Manual', domain: 'finance', authoringMode: 'manual', sourcePolicy: 'governed_only' });
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, plain));
    const appPath = join(root, 'apps/sales-manual/dql.app.json');
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).description).toBe('A dashboard of live numbers for Finance.');

    // The author writes a description; a republish without a new one keeps it.
    const app = JSON.parse(readFileSync(appPath, 'utf-8'));
    writeFileSync(appPath, JSON.stringify({ ...app, description: 'Weekly numbers for the sales managers.' }, null, 2) + '\n');
    const edit = createStoredAppBuildDraft(root, { baseAppId: 'sales-manual', name: 'Sales Manager Manual', authoringMode: 'manual', sourcePolicy: 'governed_only' });
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, edit));
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).description).toBe('Weekly numbers for the sales managers.');

    // What the author typed for the App is its description.
    const typed = createStoredAppBuildDraft(root, { appId: 'typed', name: 'Revenue', goal: 'Revenue by month for the weekly review', authoringMode: 'ai', sourcePolicy: 'governed_only' });
    publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, typed));
    const description = JSON.parse(readFileSync(join(root, 'apps/typed/dql.app.json'), 'utf-8')).description;
    expect(description).toBe('Revenue by month for the weekly review');
    expect(description).not.toMatch(/Governed analytical/);
  });

  it('rehydrates published source bindings for safe editing and returns every page from the App route', async () => {
    const root = createProject();
    const created = createAppPackage(root, {
      name: 'Published Sales Review',
      domain: 'sales',
      dashboardTitle: 'Overview',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const appId = created.app.id;
    const overviewPath = join(root, 'apps', appId, 'dashboards', 'overview.dqld');
    const overview = JSON.parse(readFileSync(overviewPath, 'utf-8'));
    const sourceId = 'app:block:sales:stable-source';
    const sourceRevision = 'sha256:published-source-revision';
    overview.layout.items = [{
      i: 'sales-trend', x: 0, y: 0, w: 6, h: 4,
      sourceId, sourceRevision,
      block: { ref: 'blocks/sales/sales-trend.dql' },
      viz: { type: 'line' },
      title: 'Sales trend',
      sourceClass: 'certified_block',
      trustState: 'certified',
      reviewStatus: 'certified',
      review: { status: 'not_required', sourceFingerprint: sourceRevision },
    }];
    overview.layout.responsive = undefined;
    writeFileSync(overviewPath, JSON.stringify(overview, null, 2) + '\n', 'utf-8');
    const pageTwo = {
      ...overview,
      id: 'page-2',
      metadata: { ...overview.metadata, title: 'Regional detail' },
      layout: { ...overview.layout, items: [{ ...overview.layout.items[0], i: 'regional-sales', title: 'Regional sales' }] },
    };
    writeFileSync(join(root, 'apps', appId, 'dashboards', 'page-2.dqld'), JSON.stringify(pageTwo, null, 2) + '\n', 'utf-8');

    const appResponse = await invokeAppsApi(root, `/api/apps/${appId}`, 'GET', {});
    expect(appResponse).toMatchObject({ handled: true, status: 200 });
    expect((appResponse.payload as any).dashboards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'overview', itemCount: 1 }),
      expect.objectContaining({ id: 'page-2', itemCount: 1 }),
    ]));

    const editDraft = createStoredAppBuildDraft(root, {
      baseAppId: appId,
      name: 'Published Sales Review',
      goal: 'Safely edit the published App',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    });
    expect(editDraft.pages).toHaveLength(2);
    expect(editDraft.sources).toEqual([
      expect.objectContaining({
        id: sourceId,
        sourceRef: 'blocks/sales/sales-trend.dql',
        sourceRevision,
        lifecycle: 'certified',
        trustState: 'certified',
      }),
    ]);
    expect(editDraft.pages.flatMap((page) => page.layout.items)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId, sourceRevision }),
    ]));
  });

  it('restores published v3 Dataset pages from current exact catalog records and keeps drift repairable', () => {
    const root = createProject();
    const created = createAppPackage(root, {
      name: 'Published Dataset Restore',
      domain: 'commerce',
      dashboardTitle: 'Overview',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const blockId = 'app:block:commerce:orders';
    const semanticId = 'app:semantic:commerce:orders';
    const blockRevision = 'sha256:block-published';
    const semanticRevision = 'sha256:semantic-published';
    const blockContract = 'sha256:block-contract';
    const semanticContract = 'sha256:semantic-contract';
    const blockDataset = publishedDatasetDescriptor(blockId, 'block', blockRevision, blockContract);
    const semanticDataset = publishedDatasetDescriptor(semanticId, 'semantic', semanticRevision, semanticContract);
    const overview = publishedDatasetPage({
      id: 'overview',
      title: 'Overview',
      sourceId: blockId,
      sourceRevision: blockRevision,
      contractFingerprint: blockContract,
      tileId: 'revenue-kpi',
      tileTitle: 'Revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const detail = publishedDatasetPage({
      id: 'detail',
      title: 'Semantic detail',
      sourceId: semanticId,
      sourceRevision: semanticRevision,
      contractFingerprint: semanticContract,
      tileId: 'semantic-revenue',
      tileTitle: 'Semantic revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'table',
    });
    writeFileSync(join(root, 'apps', created.app.id, 'dashboards', 'overview.dqld'), JSON.stringify(overview, null, 2) + '\n');
    writeFileSync(join(root, 'apps', created.app.id, 'dashboards', 'detail.dqld'), JSON.stringify(detail, null, 2) + '\n');

    const records = [
      publishedDatasetCatalogRecord(blockId, 'block', blockRevision, blockDataset),
      publishedDatasetCatalogRecord(semanticId, 'semantic', semanticRevision, semanticDataset),
    ];
    const restored = createStoredAppBuildDraft(root, {
      baseAppId: created.app.id,
      name: 'Published Dataset Restore',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    }, {
      resolvePublishedDatasetSources: (ids) => ({
        snapshotId: 'current-catalog-snapshot',
        items: records.filter((record) => ids.includes(record.sourceId)),
        missingSourceIds: [],
      }),
    });

    expect(restored.pages.map((page) => page.id).sort()).toEqual(['detail', 'overview']);
    expect(restored.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'overview',
        datasets: [expect.objectContaining({ sourceId: blockId, sourceRevision: blockRevision, contractFingerprint: blockContract })],
        layout: expect.objectContaining({ items: [expect.objectContaining({ sourceId: blockId, sourceRevision: blockRevision, query: expect.any(Object) })] }),
      }),
      expect.objectContaining({
        id: 'detail',
        datasets: [expect.objectContaining({ sourceId: semanticId, sourceRevision: semanticRevision, contractFingerprint: semanticContract })],
        layout: expect.objectContaining({ items: [expect.objectContaining({ sourceId: semanticId, sourceRevision: semanticRevision, query: expect.any(Object) })] }),
      }),
    ]));
    expect(restored.sources.find((source) => source.id === blockId)).toMatchObject({
      id: blockId,
      kind: 'block',
      sourceRevision: blockRevision,
      snapshotId: 'current-catalog-snapshot',
      trustState: 'certified',
      capabilities: { dataset: blockDataset },
    });
    expect(restored.sources.find((source) => source.id === semanticId)).toMatchObject({
      id: semanticId,
      kind: 'governed_semantic',
      sourceRevision: semanticRevision,
      snapshotId: 'current-catalog-snapshot',
      trustState: 'certified',
      capabilities: { dataset: semanticDataset },
    });
    expect(restored.reviewTasks).toEqual([]);

    const revisionDrift = createStoredAppBuildDraft(root, {
      baseAppId: created.app.id,
      name: 'Published Dataset Restore',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    }, {
      resolvePublishedDatasetSources: (ids) => ({
        snapshotId: 'later-catalog-snapshot',
        items: records
          .map((record) => record.sourceId === blockId
            ? { ...record, sourceRevision: 'sha256:block-current' }
            : record)
          .filter((record) => ids.includes(record.sourceId)),
        missingSourceIds: [],
      }),
    });
    const staleBlock = revisionDrift.sources.find((source) => source.id === blockId);
    expect(staleBlock).toMatchObject({
      id: blockId,
      sourceRevision: blockRevision,
      lifecycle: 'unknown',
      trustState: 'review_required',
      reviewStatus: 'required',
    });
    expect(staleBlock?.capabilities).toBeUndefined();
    expect(revisionDrift.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'overview', datasets: [expect.objectContaining({ sourceId: blockId, sourceRevision: blockRevision, contractFingerprint: blockContract })] }),
      expect.objectContaining({ id: 'detail', datasets: [expect.objectContaining({ sourceId: semanticId, sourceRevision: semanticRevision, contractFingerprint: semanticContract })] }),
    ]));
    expect(revisionDrift.reviewTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: blockId, message: expect.stringContaining('changed Dataset source revision') }),
    ]));
    expect(preflightStoredAppBuildDraft(root, revisionDrift).join('\n')).toContain('no longer exposes a field-based Dataset contract');
  });

  it('rejects a forged certified semantic Dataset PATCH and stale receipt when current authority is review-required', async () => {
    const root = createProject();
    const sourceId = 'app:semantic:commerce:orders';
    const sourceRevision = 'sha256:semantic-stable-revision';
    const contractFingerprint = 'sha256:semantic-stable-contract';
    const dataset = publishedDatasetDescriptor(sourceId, 'semantic', sourceRevision, contractFingerprint);
    const page = publishedDatasetPage({
      id: 'overview',
      title: 'Semantic overview',
      sourceId,
      sourceRevision,
      contractFingerprint,
      tileId: 'semantic-revenue',
      tileTitle: 'Semantic revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const certifiedCatalog = publishedDatasetCatalogRecord(sourceId, 'semantic', sourceRevision, dataset);
    const reviewCatalog: AppSourceCatalogRecord = {
      ...certifiedCatalog,
      lifecycle: 'review',
      trust: 'review_required',
      eligibility: {
        discoverable: true,
        localPreview: true,
        projectPublish: false,
        reasonCodes: ['REVIEW_REQUIRED_SOURCE'],
      },
    };
    const initial = createStoredAppBuildDraft(root, {
      name: 'Semantic authority guard',
      goal: 'Prevent a forged semantic Dataset source from publishing.',
      authoringMode: 'manual',
      sourcePolicy: 'include_review_required',
      template: 'blank',
    });
    const reviewTask = {
      id: 'review-semantic-source',
      message: 'Semantic source needs governed review.',
      status: 'open' as const,
      sourceId,
      pageId: page.id,
      tileId: 'semantic-revenue',
    };
    const forgedSource: AppBuildDraftSource = {
      id: sourceId,
      kind: 'governed_semantic' as const,
      sourceRef: certifiedCatalog.executionRef,
      qualifiedIdentity: certifiedCatalog.qualifiedIdentity,
      sourcePath: certifiedCatalog.sourcePath,
      executionRef: certifiedCatalog.executionRef,
      snapshotId: certifiedCatalog.snapshotId,
      sourceRevision,
      sourceFingerprint: sourceRevision,
      lifecycle: 'certified' as const,
      capabilities: certifiedCatalog.capabilities,
      trustState: 'certified' as const,
      reviewStatus: 'not_required' as const,
    };
    const forgedDraft: AppBuildDraft = {
      ...initial,
      pages: [page],
      sources: [forgedSource],
      reviewTasks: [reviewTask],
      previewReceipts: [{
        id: 'settled-semantic-run',
        pageId: page.id,
        revision: initial.revision,
        snapshotId: 'snapshot-a',
        filterFingerprint: 'filters-a',
        resultFingerprint: 'results-a',
        intentFingerprint: '',
        createdAt: '2026-09-11T00:00:00.000Z',
      }],
    };
    const forgedIntentFingerprint = appBuildPreviewIntentFingerprint(forgedDraft, page.id);
    forgedDraft.previewReceipts = forgedDraft.previewReceipts?.map((receipt) => ({ ...receipt, intentFingerprint: forgedIntentFingerprint }));
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      storage.saveAppBuildDraft(forgedDraft);
    } finally {
      storage.close();
    }
    const sourceAuthority = async (sourceIds: string[]) => {
      expect(sourceIds).toEqual([sourceId]);
      return [reviewCatalog];
    };
    const verifyAppBuildPreview = async () => ({
      ok: true as const,
      snapshotId: 'snapshot-a',
      filterFingerprint: 'filters-a',
      resultFingerprint: 'results-a',
      intentFingerprint: forgedIntentFingerprint,
    });

    const forgedPatch = await invokeAppsApi(root, `/api/app-builds/${forgedDraft.id}`, 'PATCH', {
      expectedRevision: forgedDraft.revision,
      operations: [
        {
          type: 'upsert_source',
          source: {
            ...forgedSource,
            lifecycle: 'certified',
            trustState: 'certified',
            reviewStatus: 'not_required',
          },
        },
        { type: 'remove_review_task', taskId: reviewTask.id },
      ],
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview });
    expect(forgedPatch).toMatchObject({ handled: true, status: 400 });
    expect((forgedPatch.payload as any).error).toContain('APP_BUILD_DATASET_REVIEW_TASK_REQUIRED');

    // Simulate a legacy/stored earlier receipt whose local source card still
    // claims certification after the same source id, revision, and contract
    // were downgraded in the authoritative catalog. Preflight must fail from
    // current lifecycle/eligibility, not trust the stored card or receipt.
    const preflight = await invokeAppsApi(root, `/api/app-builds/${forgedDraft.id}/preflight`, 'POST', {
      expectedRevision: forgedDraft.revision,
      proposalHash: forgedDraft.proposalHash,
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview });
    expect(preflight).toMatchObject({ handled: true, status: 400 });
    expect((preflight.payload as any).errors.join('\n')).toContain('APP_BUILD_DATASET_SOURCE_AUTHORITY_STALE');
  });

  it('refreshes a changed Dataset source only with explicit review policy and current server authority (APP-056)', async () => {
    const root = createProject();
    const sourceId = 'app:block:commerce:orders';
    const oldRevision = 'sha256:orders-before-source-change';
    const currentRevision = 'sha256:orders-after-source-change';
    const oldContract = 'sha256:orders-before-contract';
    const currentContract = 'sha256:orders-after-contract';
    const oldDataset = publishedDatasetDescriptor(sourceId, 'block', oldRevision, oldContract);
    const currentDataset: DatasetDescriptor = {
      ...publishedDatasetDescriptor(sourceId, 'block', currentRevision, currentContract),
      lifecycle: 'review',
      trust: 'review_required',
    };
    const oldCatalog = publishedDatasetCatalogRecord(sourceId, 'block', oldRevision, oldDataset);
    const currentCatalog: AppSourceCatalogRecord = {
      ...publishedDatasetCatalogRecord(sourceId, 'block', currentRevision, currentDataset),
      lifecycle: 'review',
      trust: 'review_required',
      eligibility: {
        discoverable: true,
        localPreview: true,
        projectPublish: false,
        reasonCodes: ['REVIEW_REQUIRED_SOURCE'],
      },
    };
    const oldPage = publishedDatasetPage({
      id: 'overview',
      title: 'Orders',
      sourceId,
      sourceRevision: oldRevision,
      contractFingerprint: oldContract,
      tileId: 'revenue',
      tileTitle: 'Revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const currentPage = publishedDatasetPage({
      id: 'overview',
      title: 'Orders',
      sourceId,
      sourceRevision: currentRevision,
      contractFingerprint: currentContract,
      tileId: 'revenue',
      tileTitle: 'Revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const initial = createStoredAppBuildDraft(root, {
      name: 'Refresh changed Dataset',
      goal: 'Keep the App bound to the current Dataset revision.',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
      template: 'blank',
    });
    const stored: AppBuildDraft = {
      ...initial,
      sources: [publishedDatasetDraftSource(oldCatalog)],
      pages: [oldPage],
      reviewTasks: [{
        id: 'orders-source-changed',
        message: 'Refresh the changed Dataset source.',
        status: 'open',
        sourceId,
        pageId: oldPage.id,
        tileId: 'revenue',
      }],
    };
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      storage.saveAppBuildDraft(stored);
    } finally {
      storage.close();
    }
    const sourceAuthority = async (sourceIds: string[]) => {
      expect(sourceIds).toEqual([sourceId]);
      return [currentCatalog];
    };
    // Browser policy alone cannot opt a governed-only App into a review source.
    const withoutPolicy = await invokeAppsApi(root, `/api/app-builds/${stored.id}`, 'PATCH', {
      expectedRevision: stored.revision,
      operations: [
        { type: 'upsert_source', source: { ...publishedDatasetDraftSource(oldCatalog), lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_page', page: currentPage },
      ],
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(withoutPolicy).toMatchObject({ handled: true, status: 400 });
    expect((withoutPolicy.payload as any).error).toContain('include_review_required policy');

    const refreshed = await invokeAppsApi(root, `/api/app-builds/${stored.id}`, 'PATCH', {
      expectedRevision: stored.revision,
      operations: [
        { type: 'set_source_policy', sourcePolicy: 'include_review_required' },
        // This intentionally claims the old certified card. The API must
        // replace it with currentCatalog rather than trust these fields.
        { type: 'upsert_source', source: { ...publishedDatasetDraftSource(oldCatalog), lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_page', page: currentPage },
        {
          type: 'set_review_task',
          task: {
            id: 'orders-current-review',
            message: 'Current source requires review.',
            status: 'open',
            sourceId,
            pageId: currentPage.id,
            tileId: 'revenue',
          },
        },
      ],
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(refreshed).toMatchObject({ handled: true, status: 200 });
    const rebound = (refreshed.payload as any).draft as AppBuildDraft;
    expect(rebound).toMatchObject({ sourcePolicy: 'include_review_required' });
    expect(rebound.sources).toEqual([expect.objectContaining({
      id: sourceId,
      sourceRevision: currentRevision,
      lifecycle: 'review',
      trustState: 'review_required',
      reviewStatus: 'required',
      capabilities: expect.objectContaining({ dataset: expect.objectContaining({
        sourceRevision: currentRevision,
        contractRef: expect.objectContaining({ fingerprint: currentContract }),
      }) }),
    })]);
    expect(rebound.pages[0]).toMatchObject({
      datasets: [expect.objectContaining({ sourceRevision: currentRevision, contractFingerprint: currentContract })],
      layout: { items: [expect.objectContaining({ sourceRevision: currentRevision, trustState: 'review_required' })] },
    });

    // The same current card is not a blank check: an invalid field query is
    // rejected before persistence, leaving the repaired binding intact.
    const invalid = await invokeAppsApi(root, `/api/app-builds/${stored.id}`, 'PATCH', {
      expectedRevision: rebound.revision,
      operations: [{
        type: 'update_tile',
        pageId: currentPage.id,
        tileId: 'revenue',
        patch: {
          query: { dimensions: [], measures: [{ measure: 'missing_revenue' }], respectsGlobalFilters: true },
        },
      }],
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(invalid).toMatchObject({ handled: true, status: 400 });
    expect((invalid.payload as any).error).toContain('APP_BUILD_DATASET_QUERY_REJECTED');
    const afterInvalid = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      expect(afterInvalid.getAppBuildDraft(stored.id)).toMatchObject({ revision: rebound.revision });
    } finally {
      afterInvalid.close();
    }
  });

  it('refuses to publish a tile that reads a field through an uncertified join under "Only certified data"', async () => {
    const root = createProject();
    const sourceId = 'app:block:commerce:orders-with-location';
    const sourceRevision = 'sha256:orders-with-location';
    const contractFingerprint = 'sha256:orders-with-location-contract';
    const withJoin = (trust: 'certified' | 'review_required'): DatasetDescriptor => {
      const base = publishedDatasetDescriptor(sourceId, 'block', sourceRevision, contractFingerprint);
      return {
        ...base,
        fields: [
          ...base.fields,
          { kind: 'physical', name: 'location__location_name', qualifiedId: `${sourceId}:location__location_name`, type: 'string', role: 'dimension', status: 'approved', related: { join: 'location', column: 'location_name' } },
        ],
        joins: [{
          id: 'location',
          label: 'Location',
          table: 'locations',
          relation: 'main.locations',
          keys: [{ from: 'location_id', to: 'location_id' }],
          cardinality: 'many_to_one',
          trust,
          origin: 'drafted',
          relationshipId: 'proposal_setup:rel_orders_locations',
          uniqueness: 'current',
          sentence: 'each order has one location',
        }],
      };
    };
    const draftedCatalog = publishedDatasetCatalogRecord(sourceId, 'block', sourceRevision, withJoin('review_required'));
    const certifiedCatalog = publishedDatasetCatalogRecord(sourceId, 'block', sourceRevision, withJoin('certified'));
    const page = publishedDatasetPage({
      id: 'overview',
      title: 'Orders',
      sourceId,
      sourceRevision,
      contractFingerprint,
      tileId: 'revenue-by-location',
      tileTitle: 'Revenue by location',
      query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'bar',
    });
    const saveDraft = (sourcePolicy: 'governed_only' | 'include_review_required') => {
      const initial = createStoredAppBuildDraft(root, {
        name: `Joined orders ${sourcePolicy}`,
        goal: 'Revenue by location.',
        authoringMode: 'manual',
        sourcePolicy,
        template: 'blank',
      });
      const draft: AppBuildDraft = { ...initial, sources: [publishedDatasetDraftSource(draftedCatalog)], pages: [page] };
      const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
      try {
        storage.saveAppBuildDraft(draft);
      } finally {
        storage.close();
      }
      return draft;
    };
    const preflight = async (draft: AppBuildDraft, catalog: AppSourceCatalogRecord, route = 'preflight') => {
      const response = await invokeAppsApi(root, `/api/app-builds/${draft.id}/${route}`, 'POST', {
        expectedRevision: draft.revision,
        proposalHash: draft.proposalHash,
      }, { resolveDatasetSourceAuthority: async () => [catalog] });
      return { status: response.status, errors: ((response.payload as { errors?: string[]; error?: string }).errors ?? []) };
    };

    const governed = saveDraft('governed_only');
    const refused = await preflight(governed, draftedCatalog);
    expect(refused.status).toBe(400);
    const tileErrors = refused.errors.filter((error) => error.startsWith('APP_BUILD_TILE_NEEDS_REVIEW'));
    expect(tileErrors).toEqual([
      'APP_BUILD_TILE_NEEDS_REVIEW: overview/revenue-by-location: Revenue by location uses the join to Location, which is not certified yet. This App uses only certified data: certify the join in Modeling, remove the related field, or allow data that needs review.',
    ]);
    // Publish repeats the same check; it never publishes past it.
    const publishRefused = await preflight(governed, draftedCatalog, 'publish-to-project');
    expect(publishRefused.status).toBe(400);
    expect(publishRefused.errors.some((error) => error.startsWith('APP_BUILD_TILE_NEEDS_REVIEW'))).toBe(true);

    // Certified in Modeling since: the current model decides, so it passes this check.
    const afterCertify = await preflight(governed, certifiedCatalog);
    expect(afterCertify.errors.some((error) => error.startsWith('APP_BUILD_TILE_NEEDS_REVIEW'))).toBe(false);

    // "Also allow data that needs review": the tile publishes as Needs review.
    const allowed = await preflight(saveDraft('include_review_required'), draftedCatalog);
    expect(allowed.errors.some((error) => error.startsWith('APP_BUILD_TILE_NEEDS_REVIEW'))).toBe(false);
  });

  it('allows opted-in review Dataset preview evidence but refuses governed-only preview and Project publication (APP-058)', async () => {
    const root = createProject();
    const sourceId = 'app:block:commerce:review-orders';
    const sourceRevision = 'sha256:review-orders-source';
    const contractFingerprint = 'sha256:review-orders-contract';
    const reviewDataset: DatasetDescriptor = {
      ...publishedDatasetDescriptor(sourceId, 'block', sourceRevision, contractFingerprint),
      lifecycle: 'review',
      trust: 'review_required',
    };
    const reviewCatalog: AppSourceCatalogRecord = {
      ...publishedDatasetCatalogRecord(sourceId, 'block', sourceRevision, reviewDataset),
      lifecycle: 'review',
      trust: 'review_required',
      eligibility: {
        discoverable: true,
        localPreview: true,
        projectPublish: false,
        reasonCodes: ['REVIEW_REQUIRED_SOURCE'],
      },
    };
    const certifiedPresentationPage = publishedDatasetPage({
      id: 'overview',
      title: 'Review orders',
      sourceId,
      sourceRevision,
      contractFingerprint,
      tileId: 'review-revenue',
      tileTitle: 'Review revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    // This matches the persisted source/page state after an explicit current
    // review-source refresh. Attaching receipt evidence must not need to
    // rewrite presentation fields or change the executed intent.
    const page: DashboardDocument = {
      ...certifiedPresentationPage,
      layout: {
        ...certifiedPresentationPage.layout,
        items: certifiedPresentationPage.layout.items.map((tile) => ({
          ...tile,
          sourceClass: 'exploratory_analysis',
          trustState: 'review_required',
          reviewStatus: 'review_required',
          review: { status: 'required', sourceFingerprint: sourceRevision },
        })),
      },
    };
    const initial = createStoredAppBuildDraft(root, {
      name: 'Review preview authority',
      goal: 'Preview a review-required Dataset locally without granting publication.',
      authoringMode: 'manual',
      sourcePolicy: 'include_review_required',
      template: 'blank',
    });
    const reviewDraft: AppBuildDraft = {
      ...initial,
      sources: [publishedDatasetDraftSource(reviewCatalog)],
      pages: [page],
      reviewTasks: [{
        id: 'review-orders-task',
        message: 'Review the current Dataset source before Project publication.',
        status: 'open',
        sourceId,
        pageId: page.id,
        tileId: 'review-revenue',
      }],
    };
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      storage.saveAppBuildDraft(reviewDraft);
    } finally {
      storage.close();
    }
    const sourceAuthority = async (sourceIds: string[]) => {
      expect(sourceIds).toEqual([sourceId]);
      return [reviewCatalog];
    };
    const purposes: Array<'local_preview' | 'project_publish'> = [];
    const verifyPreview = async (input: {
      purpose: 'local_preview' | 'project_publish';
      intentFingerprint: string;
    }) => {
      purposes.push(input.purpose);
      if (input.purpose === 'project_publish') {
        return { ok: false as const, error: 'Dataset is review-required and cannot be published.' };
      }
      return {
        ok: true as const,
        snapshotId: 'snapshot-review',
        filterFingerprint: 'filters-review',
        resultFingerprint: 'results-review',
        intentFingerprint: input.intentFingerprint,
      };
    };
    const receipt = {
      id: 'review-local-preview',
      pageId: page.id,
      revision: reviewDraft.revision,
      snapshotId: 'snapshot-review',
      filterFingerprint: 'filters-review',
      resultFingerprint: 'results-review',
      createdAt: '2026-09-11T00:00:00.000Z',
    };

    const savedPreview = await invokeAppsApi(root, `/api/app-builds/${reviewDraft.id}`, 'PATCH', {
      expectedRevision: reviewDraft.revision,
      operations: [{ type: 'set_preview_receipt', receipt }],
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(savedPreview).toMatchObject({ handled: true, status: 200 });
    expect(purposes).toEqual(['local_preview']);

    const savedDraft = (savedPreview.payload as { draft: AppBuildDraft }).draft;
    expect(savedDraft.sources).toEqual([expect.objectContaining({
      id: sourceId,
      lifecycle: 'review',
      trustState: 'review_required',
      reviewStatus: 'required',
    })]);
    expect(savedDraft.pages[0]?.layout.items[0]).toMatchObject({
      trustState: 'review_required',
      reviewStatus: 'review_required',
    });
    const publication = await invokeAppsApi(root, `/api/app-builds/${reviewDraft.id}/preflight`, 'POST', {
      expectedRevision: savedDraft.revision,
      proposalHash: savedDraft.proposalHash,
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(publication).toMatchObject({ handled: true, status: 400 });
    expect((publication.payload as { errors: string[] }).errors.join('\n')).toContain('APP_BUILD_DATASET_PUBLICATION_INELIGIBLE');
    expect(purposes).toContain('project_publish');

    const governedInitial = createStoredAppBuildDraft(root, {
      name: 'Governed-only review refusal',
      goal: 'Reject review-required sources until local preview policy is explicitly enabled.',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
      template: 'blank',
    });
    const governedDraft: AppBuildDraft = {
      ...governedInitial,
      sources: [publishedDatasetDraftSource(reviewCatalog)],
      pages: [page],
    };
    const governedStorage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      governedStorage.saveAppBuildDraft(governedDraft);
    } finally {
      governedStorage.close();
    }
    const governedReceipt = {
      ...receipt,
      id: 'governed-only-review-preview',
      revision: governedDraft.revision,
    };
    const rejectedPreview = await invokeAppsApi(root, `/api/app-builds/${governedDraft.id}`, 'PATCH', {
      expectedRevision: governedDraft.revision,
      operations: [{ type: 'set_preview_receipt', receipt: governedReceipt }],
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(rejectedPreview).toMatchObject({ handled: true, status: 400 });
    expect((rejectedPreview.payload as { error: string }).error).toContain('requires include_review_required policy');
  });

  it('previews a checked Dataset under "Only certified data" and refuses to publish it until it is certified (design Q1)', async () => {
    const root = createProject();
    const sourceId = 'app:block:commerce:checked-orders';
    const sourceRevision = 'sha256:checked-orders-source';
    const contractFingerprint = 'sha256:checked-orders-contract';
    const checkedDataset: DatasetDescriptor = {
      ...publishedDatasetDescriptor(sourceId, 'block', sourceRevision, contractFingerprint),
      lifecycle: 'review',
      trust: 'review_required',
    };
    const checkedCatalog: AppSourceCatalogRecord = {
      ...publishedDatasetCatalogRecord(sourceId, 'block', sourceRevision, checkedDataset),
      lifecycle: 'review',
      trust: 'review_required',
      eligibility: { discoverable: true, localPreview: true, projectPublish: false, reasonCodes: ['CHECKED_NEEDS_CERTIFYING'] },
      check: { by: 'kranthi@example.test', name: 'Kranthi', at: '2026-10-22T09:00:00.000Z', checks: ['Row key: each row is one order'] },
    };
    // The same Dataset without a check record: plain "needs review" data.
    const uncheckedCatalog: AppSourceCatalogRecord = { ...checkedCatalog, eligibility: { ...checkedCatalog.eligibility, localPreview: false, reasonCodes: ['ENABLE_REVIEW_REQUIRED_SOURCES'] } };
    delete (uncheckedCatalog as { check?: unknown }).check;
    const base = publishedDatasetPage({
      id: 'overview',
      title: 'Checked orders',
      sourceId,
      sourceRevision,
      contractFingerprint,
      tileId: 'checked-revenue',
      tileTitle: 'Checked revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const page: DashboardDocument = {
      ...base,
      layout: {
        ...base.layout,
        items: base.layout.items.map((tile) => ({
          ...tile,
          sourceClass: 'exploratory_analysis',
          trustState: 'review_required',
          reviewStatus: 'review_required',
          review: { status: 'required', sourceFingerprint: sourceRevision },
        })),
      },
    };
    const initial = createStoredAppBuildDraft(root, {
      name: 'Checked data',
      goal: 'Build with checked data, certify before publishing.',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
      template: 'blank',
    });
    const draft: AppBuildDraft = {
      ...initial,
      sources: [{ ...publishedDatasetDraftSource(checkedCatalog), checked: true }],
      pages: [page],
    };
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      storage.saveAppBuildDraft(draft);
    } finally {
      storage.close();
    }
    let current = checkedCatalog;
    const sourceAuthority = async () => [current];
    const verifyPreview = async (input: { purpose: 'local_preview' | 'project_publish'; intentFingerprint: string }) => ({
      ok: true as const,
      snapshotId: 'snapshot-checked',
      filterFingerprint: 'filters-checked',
      resultFingerprint: 'results-checked',
      intentFingerprint: input.intentFingerprint,
    });
    const receipt = {
      id: 'checked-local-preview',
      pageId: page.id,
      revision: draft.revision,
      snapshotId: 'snapshot-checked',
      filterFingerprint: 'filters-checked',
      resultFingerprint: 'results-checked',
      createdAt: '2026-10-22T09:05:00.000Z',
    };
    // Tiles work right away: the preview is accepted under "Only certified data".
    const savedPreview = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision,
      operations: [{ type: 'set_preview_receipt', receipt }],
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(savedPreview, JSON.stringify(savedPreview.payload)).toMatchObject({ handled: true, status: 200 });
    const saved = (savedPreview.payload as { draft: AppBuildDraft }).draft;
    expect(saved.sourcePolicy).toBe('governed_only');
    expect(saved.sources).toEqual([expect.objectContaining({ id: sourceId, checked: true, trustState: 'review_required' })]);

    // Publishing is refused, saying what to do.
    const preflight = await invokeAppsApi(root, `/api/app-builds/${draft.id}/preflight`, 'POST', {
      expectedRevision: saved.revision,
      proposalHash: saved.proposalHash,
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(preflight).toMatchObject({ handled: true, status: 400 });
    expect((preflight.payload as { errors: string[] }).errors.join('\n')).toMatch(/APP_BUILD_DATASET_NOT_CERTIFIED: Checked revenue uses block orders, which is checked but not certified yet\. Certify it before publishing\./);
    const publish = await invokeAppsApi(root, `/api/app-builds/${draft.id}/publish-to-project`, 'POST', {
      expectedRevision: saved.revision,
      proposalHash: saved.proposalHash,
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(publish.status).not.toBe(200);
    expect(publish.status).not.toBe(201);

    // Data nobody checked stays out of a governed-only preview, as before.
    current = uncheckedCatalog;
    const rejected = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: saved.revision,
      operations: [{ type: 'set_preview_receipt', receipt: { ...receipt, id: 'unchecked-preview', revision: saved.revision } }],
    }, { resolveDatasetSourceAuthority: sourceAuthority, verifyAppBuildPreview: verifyPreview });
    expect(rejected).toMatchObject({ handled: true, status: 400 });
  });

  it('refuses a client-issued preview receipt invalidation', async () => {
    const root = createProject();
    const draft = createStoredAppBuildDraft(root, {
      name: 'Receipt invalidation boundary',
      goal: 'Keep preview receipt invalidation inside the active runtime.',
      authoringMode: 'manual',
      template: 'blank',
    });
    const response = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision,
      operations: [{ type: 'clear_preview_receipt', pageId: 'overview', expectedReceiptId: 'app_run_old' }],
    });
    expect(response).toMatchObject({ handled: true, status: 400 });
    expect((response.payload as { error: string }).error).toContain('receipt invalidation is issued only by the active App runtime');
  });

  it('atomically replaces an unavailable Dataset placeholder only when no old Dataset tile or binding remains', async () => {
    const root = createProject();
    const missingSourceId = 'app:block:commerce:missing-orders';
    const replacementSourceId = 'app:block:commerce:current-orders';
    const missingRevision = 'sha256:missing-orders-revision';
    const replacementRevision = 'sha256:current-orders-revision';
    const missingContract = 'sha256:missing-orders-contract';
    const replacementContract = 'sha256:current-orders-contract';
    const missingPage = publishedDatasetPage({
      id: 'overview',
      title: 'Unavailable orders',
      sourceId: missingSourceId,
      sourceRevision: missingRevision,
      contractFingerprint: missingContract,
      tileId: 'orders-revenue',
      tileTitle: 'Orders revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const replacementDataset = publishedDatasetDescriptor(
      replacementSourceId,
      'block',
      replacementRevision,
      replacementContract,
    );
    const replacementCatalog = publishedDatasetCatalogRecord(
      replacementSourceId,
      'block',
      replacementRevision,
      replacementDataset,
    );
    const replacementPage = publishedDatasetPage({
      id: 'overview',
      title: 'Current orders',
      sourceId: replacementSourceId,
      sourceRevision: replacementRevision,
      contractFingerprint: replacementContract,
      tileId: 'orders-revenue',
      tileTitle: 'Orders revenue',
      query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      viz: 'kpi',
    });
    const missingPlaceholder: AppBuildDraftSource = {
      id: missingSourceId,
      kind: 'block',
      sourceRef: missingSourceId,
      sourceRevision: missingRevision,
      sourceFingerprint: missingRevision,
      lifecycle: 'unknown',
      trustState: 'review_required',
      reviewStatus: 'required',
    };
    const replacementClaim: AppBuildDraftSource = {
      id: replacementSourceId,
      kind: 'review_block',
      sourceRef: 'browser-forged-source',
      sourceRevision: 'sha256:browser-forged-revision',
      sourceFingerprint: 'sha256:browser-forged-revision',
      lifecycle: 'review',
      trustState: 'review_required',
      reviewStatus: 'required',
    };
    const saveDraft = (name: string, page: DashboardDocument) => {
      const initial = createStoredAppBuildDraft(root, {
        name,
        goal: 'Repair an unavailable Dataset binding with an explicit current source.',
        authoringMode: 'manual',
        sourcePolicy: 'include_review_required',
        template: 'blank',
      });
      const task = {
        id: `${initial.id}-repair-missing-source`,
        message: 'Rebind the unavailable Dataset source.',
        status: 'open' as const,
        sourceId: missingSourceId,
        pageId: page.id,
        tileId: 'orders-revenue',
      };
      const draft: AppBuildDraft = {
        ...initial,
        sources: [missingPlaceholder],
        pages: [page],
        reviewTasks: [task],
      };
      const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
      try {
        storage.saveAppBuildDraft(draft);
      } finally {
        storage.close();
      }
      return { draft, task };
    };
    const authorityCalls: string[][] = [];
    const sourceAuthority = async (sourceIds: string[]) => {
      authorityCalls.push([...sourceIds]);
      return sourceIds.includes(replacementSourceId) ? [replacementCatalog] : [];
    };

    const { draft: original, task } = saveDraft('Replace unavailable Dataset', missingPage);
    // An unchanged placeholder never regains authority merely because another
    // current Dataset happens to be discoverable.
    const unchangedPreflight = await invokeAppsApi(root, `/api/app-builds/${original.id}/preflight`, 'POST', {
      expectedRevision: original.revision,
      proposalHash: original.proposalHash,
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(unchangedPreflight).toMatchObject({ handled: true, status: 400 });
    expect((unchangedPreflight.payload as any).errors.join('\n')).toContain('APP_BUILD_DATASET_AUTHORITY_UNAVAILABLE');
    expect(authorityCalls.at(-1)).toEqual([missingSourceId]);

    const replacementPatch = await invokeAppsApi(root, `/api/app-builds/${original.id}`, 'PATCH', {
      expectedRevision: original.revision,
      operations: [
        { type: 'remove_source', sourceId: missingSourceId },
        { type: 'upsert_source', source: replacementClaim },
        { type: 'upsert_page', page: replacementPage },
        { type: 'remove_review_task', taskId: task.id },
      ],
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(replacementPatch).toMatchObject({ handled: true, status: 200 });
    expect(authorityCalls.at(-1)).toEqual([replacementSourceId]);
    const repaired = (replacementPatch.payload as any).draft as AppBuildDraft;
    expect(repaired.sources).toEqual([expect.objectContaining({
      id: replacementSourceId,
      kind: 'block',
      sourceRef: replacementCatalog.executionRef,
      sourceRevision: replacementRevision,
      lifecycle: 'certified',
      trustState: 'certified',
      reviewStatus: 'not_required',
      capabilities: expect.objectContaining({
        dataset: expect.objectContaining({
          contractRef: expect.objectContaining({ fingerprint: replacementContract }),
        }),
      }),
    })]);
    expect(repaired.pages[0]?.datasets).toEqual([expect.objectContaining({
      sourceId: replacementSourceId,
      sourceRevision: replacementRevision,
      contractFingerprint: replacementContract,
    })]);

    // Page bindings are authority-bearing too. Leaving the old binding or
    // field tile behind keeps the missing source in the final graph and fails
    // the whole atomic edit rather than persisting a partially repaired draft.
    const danglingPage: DashboardDocument = {
      ...replacementPage,
      datasets: [
        ...replacementPage.datasets!,
        { ...missingPage.datasets![0]!, id: 'missing-orders-binding' },
      ],
      layout: {
        ...replacementPage.layout,
        items: [
          ...replacementPage.layout.items,
          { ...missingPage.layout.items[0]!, i: 'still-missing-orders', y: 4 },
        ],
      },
    };
    const { draft: dangling, task: danglingTask } = saveDraft('Reject dangling Dataset authority', missingPage);
    const danglingPatch = await invokeAppsApi(root, `/api/app-builds/${dangling.id}`, 'PATCH', {
      expectedRevision: dangling.revision,
      operations: [
        { type: 'remove_source', sourceId: missingSourceId },
        { type: 'upsert_source', source: replacementClaim },
        { type: 'upsert_page', page: danglingPage },
        { type: 'remove_review_task', taskId: danglingTask.id },
      ],
    }, { resolveDatasetSourceAuthority: sourceAuthority });
    expect(danglingPatch).toMatchObject({ handled: true, status: 400 });
    expect((danglingPatch.payload as any).error).toContain('APP_BUILD_DATASET_SOURCE_DRIFT');
    expect((danglingPatch.payload as any).error).toContain(missingSourceId);
    expect(authorityCalls.at(-1)).toEqual(expect.arrayContaining([missingSourceId, replacementSourceId]));
    // The server validates the complete final graph before storage. A failed
    // repair must not leave a partially replaced source, page binding, or
    // resolved task behind for the next Studio load.
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      const persisted = storage.getAppBuildDraft(dangling.id);
      expect(persisted?.revision).toBe(dangling.revision);
      expect(persisted?.sources).toHaveLength(1);
      expect(persisted?.sources[0]?.id).toBe(missingSourceId);
      expect(persisted?.sources[0]).not.toHaveProperty('capabilities');
      expect(persisted?.pages[0]?.datasets?.[0]).toMatchObject({ sourceId: missingSourceId, sourceRevision: missingRevision });
      expect(persisted?.pages[0]?.layout.items[0]).toMatchObject({ sourceId: missingSourceId, sourceRevision: missingRevision });
      expect(persisted?.reviewTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: danglingTask.id, status: 'open' }),
      ]));
    } finally {
      storage.close();
    }
  });

  it('adds a certified Ask answer to the editable draft without writing Project App source', () => {
    const root = createProject();
    writeBlock(root, 'revenue/monthly-revenue.dql', {
      name: 'Monthly Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'monthly'],
      description: 'Monthly governed revenue',
      chart: 'line',
      allowedFilters: ['month'],
    });
    const draft = createStoredAppBuildDraft(root, {
      name: 'Ask Revenue',
      goal: 'Track monthly revenue',
      domain: 'revenue',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
    });

    const result = addAskResultToAppBuildDraft(root, draft.id, {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      pageId: draft.pages[0].id,
      title: 'Monthly revenue from Ask',
      question: 'How is monthly revenue trending?',
      certifiedBlockId: 'Monthly Revenue',
      visualization: 'line',
    });

    expect(result.draft.revision).toBe(draft.revision + 1);
    expect(result.draft.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'certified_block', trustState: 'certified' }),
    ]));
    expect(result.draft.pages[0].layout.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        i: result.tileId,
        block: expect.objectContaining({ blockId: expect.any(String) }),
        sourceClass: 'certified_block',
        trustState: 'certified',
      }),
    ]));
    expect(existsSync(join(root, 'apps', draft.appId))).toBe(false);

    const duplicate = addAskResultToAppBuildDraft(root, draft.id, {
      expectedRevision: result.draft.revision,
      expectedProposalHash: result.draft.proposalHash,
      pageId: draft.pages[0].id,
      title: 'Monthly revenue from Ask',
      question: 'How is monthly revenue trending?',
      certifiedBlockId: 'Monthly Revenue',
      visualization: 'line',
    });
    expect(duplicate.deduped).toBe(true);
    expect(duplicate.draft.revision).toBe(result.draft.revision);
  });

  it('routes Ask new-App creation and result addition through POST App Build endpoints (API-013, UI-005)', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/monthly-revenue.dql', {
      name: 'Monthly Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'monthly'],
      description: 'Monthly governed revenue',
      chart: 'line',
    });

    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Ask Revenue',
      goal: 'How is monthly revenue trending?',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
      template: 'blank',
      entrypoint: 'ask',
    });
    expect(created).toMatchObject({ handled: true, status: 201, payload: { ok: true } });
    const draft = (created.payload as { draft: ReturnType<typeof createStoredAppBuildDraft> }).draft;

    const added = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ask-results`, 'POST', {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      pageId: draft.pages[0].id,
      title: 'Monthly revenue from Ask',
      question: 'How is monthly revenue trending?',
      certifiedBlockId: 'Monthly Revenue',
      visualization: 'line',
    });

    expect(added).toMatchObject({
      handled: true,
      status: 201,
      payload: { ok: true, deduped: false, pageId: draft.pages[0].id },
    });
    expect(existsSync(join(root, 'apps', draft.appId))).toBe(false);
  });

  it('materializes exploratory Ask SQL as local review DQL rather than inline dashboard SQL', () => {
    const root = createProject();
    const draft = createStoredAppBuildDraft(root, {
      name: 'Ask Exploration',
      goal: 'Explore customer risk',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
    });

    const result = addAskResultToAppBuildDraft(root, draft.id, {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      title: 'Customers at risk',
      question: 'Which customers are at risk?',
      answer: 'Review the customers with unusually low activity.',
      sql: 'SELECT customer_id, activity_score FROM customers WHERE activity_score < 10',
      visualization: 'table',
    });

    const source = result.draft.sources.find((candidate) => candidate.kind === 'review_dql');
    expect(source).toMatchObject({ trustState: 'review_required', reviewStatus: 'required' });
    expect(result.draft.sourcePolicy).toBe('include_review_required');
    expect(result.draft.reviewTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: source?.id, tileId: result.tileId, status: 'open' }),
    ]));
    expect(JSON.stringify(result.draft.pages)).not.toContain('SELECT customer_id');
    expect(source?.sourceRef).toBeTruthy();
    const artifact = readFileSync(join(root, '.dql', 'local', 'app-builds', draft.id, source!.sourceRef), 'utf-8');
    expect(artifact).toContain('status = "review"');
    expect(artifact).toContain('SELECT customer_id');
    expect(existsSync(join(root, 'apps', draft.appId))).toBe(false);
  });

  it('does not turn legacy unscoped AI reminders into hidden publication gates', () => {
    const root = createProject();
    const draft = createStoredAppBuildDraft(root, {
      appId: 'readiness-studio',
      name: 'Readiness Studio',
      goal: 'Monitor readiness',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    });
    const legacyReminder = {
      ...draft,
      reviewTasks: [{ id: 'ai-review-1', message: 'Review every scoped analysis memo before stakeholder use.', status: 'open' as const }],
    };
    expect(preflightStoredAppBuildDraft(root, legacyReminder)).toEqual([]);

    const placeholderRequirement = {
      ...draft,
      requirements: [{ id: 'primary', question: draft.name, role: 'breakdown' as const, required: true, measures: [], dimensions: ['month'], filters: [] }],
      coverage: [{ requirementId: 'primary', status: 'gap' as const, sourceIds: [], componentIds: [], reasons: [] }],
    };
    expect(preflightStoredAppBuildDraft(root, placeholderRequirement)).toEqual([]);

    const scopedTask = {
      ...draft,
      reviewTasks: [{ id: 'review-overview', message: 'Confirm the Overview evidence.', status: 'open' as const, pageId: draft.pages[0].id }],
    };
    expect(preflightStoredAppBuildDraft(root, scopedTask)).toContain('Review task is still open: Confirm the Overview evidence.');
  });

  it('accepts an explicitly unsupported tile as a governed filter exclusion', () => {
    const root = createProject();
    writeBlock(root, 'commerce/customer-profile.dql', {
      name: 'Customer Profile',
      domain: 'commerce',
      status: 'certified',
      tags: ['customer'],
      description: 'Governed customer profile',
      chart: 'table',
      allowedFilters: ['customer_name'],
    });
    const block = recommendBlocks(root, { certifiedOnly: true })[0];
    const draft = createStoredAppBuildDraft(root, {
      name: 'Customer Filter App',
      goal: 'Review customers',
      domain: 'commerce',
      authoringMode: 'manual',
      sourcePolicy: 'governed_only',
    });
    const page = {
      ...draft.pages[0],
      filters: [{ id: 'customer_name', label: 'Customer Name', type: 'select' as const, bindsTo: 'customer_name' }],
      layout: {
        ...draft.pages[0].layout,
        items: [
          {
            i: 'customer-profile', x: 0, y: 0, w: 6, h: 4,
            block: { blockId: block.id }, viz: { type: 'table' as const },
            filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' as const, capability: 'preflight_required' as const }],
            review: { status: 'not_required' as const, sourceFingerprint: block.fingerprint },
          },
          {
            i: 'revenue-trend', x: 6, y: 0, w: 6, h: 4,
            block: { blockId: block.id }, viz: { type: 'line' as const },
            filterBindings: [{ filter: 'customer_name', capability: 'unsupported' as const, unsupportedReason: 'Customer Name is not exposed by Revenue Trend.' }],
            review: { status: 'not_required' as const, sourceFingerprint: block.fingerprint },
          },
        ],
      },
    };
    const readyDraft = {
      ...draft,
      sources: [{ id: `block:${block.id}`, kind: 'certified_block' as const, sourceRef: block.id, sourceFingerprint: block.fingerprint, trustState: 'certified' as const, reviewStatus: 'not_required' as const }],
      pages: [page],
      previewReceipts: [{ id: 'run-customer-filter', pageId: page.id, revision: draft.revision, snapshotId: 'snapshot', filterFingerprint: 'filters', resultFingerprint: 'results', createdAt: draft.updatedAt }],
    };

    expect(preflightStoredAppBuildDraft(root, readyDraft)).toEqual([]);
    const unversionedDraft = {
      ...readyDraft,
      sources: [{
        id: `block:${block.id}`,
        kind: 'certified_block' as const,
        sourceRef: block.id,
        trustState: 'certified' as const,
        reviewStatus: 'not_required' as const,
      }],
      pages: [{
        ...page,
        layout: {
          ...page.layout,
          items: page.layout.items.map((tile) => ({
            ...tile,
            sourceRevision: undefined,
            review: { status: 'not_required' as const },
          })),
        },
      }],
    };
    const unversionedErrors = preflightStoredAppBuildDraft(root, unversionedDraft);
    expect(unversionedErrors).toContain(`Source block:${block.id} has no bound source revision; refresh it before Project publication.`);
    expect(unversionedErrors).toContain('overview/customer-profile has no bound source revision; refresh the certified saved query before publication.');
    expect(() => publishStoredAppBuildDraft(root, {
      ...unversionedDraft,
      state: 'preflight_ready' as const,
      preflightReceipt: {
        id: 'unversioned-preflight',
        revision: unversionedDraft.revision,
        proposalHash: unversionedDraft.proposalHash,
        sourceFingerprint: 'sha256:unversioned',
        createdAt: unversionedDraft.updatedAt,
      },
    })).toThrow(/has no bound source revision/);
    expect(existsSync(join(root, 'apps', unversionedDraft.appId))).toBe(false);
    const missingExclusion = {
      ...readyDraft,
      pages: [{ ...page, layout: { ...page.layout, items: page.layout.items.map((tile) => tile.i === 'revenue-trend' ? { ...tile, filterBindings: [] } : tile) } }],
    };
    expect(preflightStoredAppBuildDraft(root, missingExclusion)).toContain('overview/revenue-trend has no choice for filter Customer Name. Open the Filters tab and set this tile to Applies or Does not apply.');
    // The Filters tab's "Does not apply" choice is stored and resolves the tile.
    const authorDoesNotApply = {
      ...readyDraft,
      pages: [{ ...page, layout: { ...page.layout, items: page.layout.items.map((tile) => tile.i === 'revenue-trend'
        ? { ...tile, filterBindings: [{ filter: 'customer_name', capability: 'unsupported' as const, unsupportedReason: 'Author: does not apply' }] }
        : tile) } }],
    };
    expect(preflightStoredAppBuildDraft(root, authorDoesNotApply)).toEqual([]);
    // A linked tile that has not run in a settled preview still needs one.
    expect(preflightStoredAppBuildDraft(root, { ...readyDraft, previewReceipts: [] }).some((issue) => (
      issue.includes('overview/customer-profile does not have a preflighted binding for filter Customer Name.')
    ))).toBe(true);
  });

  it('deletes only the selected App package and moves it to recoverable local trash', () => {
    const root = createProject();
    const first = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@local'],
      selectedBlockIds: [],
    });
    const second = createAppPackage(root, {
      name: 'Finance CXO',
      domain: 'finance',
      owners: ['owner@local'],
      selectedBlockIds: [],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok) return;
    const deleted = deleteAppPackage(root, 'growth-cxo', { expectedFingerprint: first.app.fingerprint });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.deletedPath).toBe('apps/growth-cxo');
    expect(existsSync(join(root, 'apps/growth-cxo'))).toBe(false);
    expect(existsSync(join(root, deleted.trashPath, 'package', 'dql.app.json'))).toBe(true);
    expect(deleted.trashPath).toContain('.dql/local/trash/apps/');
    expect(existsSync(join(root, 'apps/finance-cxo/dql.app.json'))).toBe(true);
    expect(deleteAppPackage(root, '../finance-cxo', { expectedFingerprint: 'sha256:nope' })).toMatchObject({ ok: false, status: 400 });

    const restored = restoreAppPackage(root, deleted.recoveryId);
    expect(restored).toMatchObject({ ok: true, id: 'growth-cxo', restoredPath: 'apps/growth-cxo' });
    expect(existsSync(join(root, 'apps/growth-cxo/dql.app.json'))).toBe(true);
  });

  it('creates App packages globally with exact domain backlinks when a domain folder exists', () => {
    const root = createProject();
    mkdirSync(join(root, 'domains', 'growth'), { recursive: true });
    writeDomainBlock(root, 'growth', 'revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const result = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toContain('apps/growth-cxo/dql.app.json');
    expect(result.paths).toContain('apps/growth-cxo/dashboards/overview.dqld');
    expect(existsSync(join(root, 'domains/growth/apps/growth-cxo/dql.app.json'))).toBe(false);
    expect(existsSync(join(root, 'apps/growth-cxo/dql.app.json'))).toBe(true);
    expect(result.app.filePath).toBe('apps/growth-cxo');
    expect(result.app.dashboards).toEqual([{ id: 'overview', title: 'Overview' }]);

    const appDocument = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dql.app.json'), 'utf-8'));
    expect(appDocument).toMatchObject({ ownerDomain: 'growth', usesDomains: ['growth'], requiredExports: [] });
    const dashboard = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.layout.items[0].block).toEqual({ blockId: 'Revenue Total' });

    const newDashboard = createDashboardForApp(root, 'growth-cxo', { title: 'Forecast Review' });
    expect(newDashboard.ok).toBe(true);
    if (!newDashboard.ok) return;
    expect(newDashboard.path).toBe('apps/growth-cxo/dashboards/forecast-review.dqld');
    expect(existsSync(join(root, newDashboard.path))).toBe(true);

    const notebook = createNotebookForApp(root, 'growth-cxo', {
      name: 'Board Notes',
      role: 'analysis',
      visibility: 'shared',
    });
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.path).toBe('apps/growth-cxo/notebooks/board-notes.dqlnb');
    expect(existsSync(join(root, notebook.path))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, notebook.path), 'utf-8')).metadata).toMatchObject({
      ownerDomain: 'growth', usesDomains: ['growth'], requiredExports: [],
    });

    const updated = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dql.app.json'), 'utf-8'));
    expect(updated.notebooks[0]).toMatchObject({ path: notebook.path, role: 'analysis' });
  });

  it('generates an AppPlan-backed App package for the UI builder', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    writeBlock(root, 'revenue/revenue_by_month.dql', {
      name: 'Revenue by Month',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'trend'],
      description: 'Monthly revenue trend',
      chart: 'line',
    });

    const result = await generateAppPackage(root, {
      prompt: 'Build a weekly revenue health app with revenue KPI and monthly trend.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
      selectedBlockIds: ['Revenue by Month'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan as { appId: string };
    const validation = result.validation as { certifiedTiles: number };
    expect(result.app?.id).toBe(plan.appId);
    expect(result.dashboardId).toBe('overview');
    expect(validation.certifiedTiles).toBeGreaterThan(0);
    expect(result.generated.paths).toContain(`apps/${plan.appId}/dql.app.json`);
    expect(result.generated.paths).toContain(`apps/${plan.appId}/dashboards/overview.dqld`);
    expect(existsSync(join(root, `apps/${plan.appId}/dql.app.json`))).toBe(true);
    expect(existsSync(join(root, `apps/${plan.appId}/dashboards/overview.dqld`))).toBe(true);
    const dashboard = JSON.parse(readFileSync(join(root, `apps/${plan.appId}/dashboards/overview.dqld`), 'utf-8'));
    expect(dashboard.layout.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          block: { blockId: 'Revenue by Month' },
        }),
      ]),
    );
  });

  it('blocks App generation instead of writing an empty stakeholder dashboard when no certified blocks match', async () => {
    const root = createProject();

    const result = await generateAppPackage(root, {
      prompt: 'Build a revenue app for leadership without any certified blocks.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No certified saved queries matched strongly enough');
    expect(result.error).toContain('ZLens did not write an empty dashboard');
    expect(existsSync(join(root, 'apps/revenue-app-for-leadership-without-any-certified-blocks'))).toBe(false);
  });

  it('stores AI build sessions with generated paths and review tasks', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await createAppAiBuildSession(root, {
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(session.status).toBe('ready');
    expect(session.appId).toBeTruthy();
    expect(session.generatedPaths.some((path) => path.endsWith('/dql.app.json'))).toBe(true);
    expect(session.reviewTasks.length).toBeGreaterThan(0);
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.id).toBe(session.id);
  });

  it('stores a blocked AI build session when no certified blocks can anchor the app', async () => {
    const root = createProject();

    const session = await createAppAiBuildSession(root, {
      prompt: 'Build a revenue app for leadership without any certified blocks.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(session.status).toBe('error');
    expect(session.generatedPaths).toEqual([]);
    expect(session.error).toContain('No certified saved queries matched strongly enough');
    expect(session.warnings.join(' ')).toContain('No certified saved queries matched strongly enough');
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.status).toBe('error');
  });

  it('proposes an app build with a confirmable tile list and writes no app files', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await proposeAppAiBuild(root, {
      sessionId: 'app_build_test_resume_001',
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
    });

    expect(session.status).toBe('proposed');
    expect(session.id).toBe('app_build_test_resume_001');
    expect(session.generatedPaths).toEqual([]);
    expect(session.proposal).toBeTruthy();
    expect(session.proposal!.tiles.length).toBeGreaterThan(0);
    expect(session.proposal!.tiles.every((tile) => tile.certification === 'certified')).toBe(true);
    expect(session.proposal!.tiles.every((tile) => tile.selectedByDefault)).toBe(true);
    // Nothing on disk yet: the plan's app dir must not exist until commit.
    expect(existsSync(join(root, 'apps'))).toBe(false);
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.status).toBe('proposed');
  });

  it('keeps uncovered requirements as visible gaps and never persists generated SQL or local aiPins', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const asked: string[] = [];
    const session = await proposeAppAiBuild(root, {
      // "why" guarantees a driver-analysis coverage gap from the deterministic planner.
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async (question) => {
        asked.push(question);
        // Governance: even when the governed loop reports a CERTIFIED match, a
        // gap-fill tile must NOT inherit the certified label — it is new AI output.
        return {
          kind: 'certified_metric',
          text: `Generated answer for: ${question}`,
          sql: 'SELECT region, revenue FROM analytics.revenue_by_region',
          suggestedViz: 'bar',
          certification: 'certified',
          block: { nodeId: 'block:some_certified', name: 'Some Certified Block' },
          result: {
            columns: ['region', 'revenue'],
            rows: [{ region: 'NA', revenue: 100 }, { region: 'EU', revenue: 80 }],
            rowCount: 2,
          },
        } as never;
      },
    });

    expect(session.status).toBe('proposed');
    expect(asked).toEqual([]);
    const generatedTiles = session.proposal!.tiles.filter((tile) => tile.source === 'ai_generated');
    expect(generatedTiles).toEqual([]);
    expect(session.proposal!.coverage.generatedTiles).toBe(0);
    expect(session.proposal!.gaps.length).toBeGreaterThan(0);

    const generated = await generateAppFromSessionPlan(root, session);
    const dashboardPath = generated.paths.find((path) => path.endsWith('.dqld'));
    expect(dashboardPath).toBeTruthy();
    const doc = JSON.parse(readFileSync(join(root, dashboardPath!), 'utf-8')) as {
      story?: { goal: string; eligibleTileIds?: string[] };
      layout: { items: Array<{ aiPin?: { id: string }; text?: { markdown: string }; sectionId?: string; trustState?: string; reviewStatus?: string }> };
    };
    const aiPinItems = doc.layout.items.filter((item) => item.aiPin);
    expect(aiPinItems).toEqual([]);
    expect(doc.story?.goal).toContain('explain why revenue is changing');
    expect(doc.layout.items.some((item) => item.text?.markdown?.includes('SELECT '))).toBe(false);
  });

  it('proposes Personal Draft exploration as an unselected review tile and writes no App', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
      mode: 'personal',
      exploreGaps: true,
      maxGeneratedTiles: 1,
    }, {
      generateGovernedAnswer: async (question) => ({
        text: `Exploration for ${question}`,
        sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
        suggestedViz: 'bar',
        result: {
          columns: ['region', 'revenue'],
          rows: [{ region: 'NA', revenue: 100 }],
          rowCount: 1,
        },
      } as never),
    });

    expect(session.status).toBe('proposed');
    expect(session.proposal?.intent).toEqual({ target: 'personal', initialVisibility: 'private' });
    const exploratory = session.proposal!.tiles.find((tile) => tile.source === 'ai_generated' && !tile.error);
    expect(exploratory).toMatchObject({
      selectedByDefault: false,
      sourceClass: 'exploratory_analysis',
      reviewStatus: 'required',
      preflight: { status: 'passed' },
    });
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });

  it('does not generate uncovered SQL unless the user explicitly requests the gap action', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    const draft = createStoredAppBuildDraft(root, {
      name: 'Revenue Drivers',
      goal: 'Explain why revenue is changing',
      domain: 'revenue',
      authoringMode: 'ai',
      sourcePolicy: 'include_review_required',
      template: 'operational_dashboard',
    });

    let generated = false;
    const proposal = await proposeAppBuildDraftOperations(root, draft, {
      prompt: 'Build a revenue app and explain why revenue is changing.',
    }, {
      generateGovernedAnswer: async (question) => {
        generated = true;
        return {
          text: `Exploration for ${question}`,
          sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
          suggestedViz: 'bar',
          result: { columns: ['region', 'revenue'], rows: [{ region: 'NA', revenue: 100 }], rowCount: 1 },
        } as never;
      },
    });

    const reviewSource = proposal.operations.find((operation) => operation.type === 'upsert_source' && operation.source.kind === 'review_dql');
    expect(generated).toBe(false);
    expect(reviewSource).toBeUndefined();
    const page = proposal.operations.find((operation) => operation.type === 'upsert_page');
    expect(page?.type === 'upsert_page' ? page.page.layout.items : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: expect.stringMatching(/^app:block:/) }),
    ]));
    expect(JSON.stringify(page)).not.toContain('SELECT region');
  });

  it('carries the planner reason onto each AI tile and keeps review-required data out when only certified data is allowed', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    writeBlock(root, 'revenue/draft_revenue.dql', {
      name: 'Draft Revenue Split',
      domain: 'revenue',
      status: 'draft',
      tags: ['revenue'],
      description: 'Draft revenue split by region',
      chart: 'bar',
    });
    const draft = createStoredAppBuildDraft(root, {
      name: 'Revenue',
      goal: 'Track revenue',
      domain: 'revenue',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
      template: 'operational_dashboard',
    });

    const proposal = await proposeAppBuildDraftOperations(root, draft, { prompt: 'Build a revenue app.' });

    const sources = proposal.operations.flatMap((operation) => operation.type === 'upsert_source' ? [operation.source] : []);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.trustState === 'certified')).toBe(true);
    expect(proposal.candidateSourceIds?.some((id) => id.includes('draft_revenue'))).toBeFalsy();
    const page = proposal.operations.find((operation) => operation.type === 'upsert_page');
    const tiles = page?.type === 'upsert_page' ? page.page.layout.items.filter((item) => item.sourceId) : [];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.sourceEvidence).toEqual([expect.objectContaining({
        source: tile.sourceId,
        kind: 'planner_rationale',
        reason: expect.stringMatching(/\S/),
        trustState: 'certified',
      })]);
    }
    expect(proposal.summary).toMatchObject({ certifiedSources: sources.length, semanticSources: 0 });
  });

  it('uses one catalog for all-draft AI and manual composition, with explicit gap generation (PRD-007, API-014)', async () => {
    const root = createProject();
    writeBlock(root, 'sales/orders-by-region.dql', {
      name: 'Orders by Region',
      domain: 'sales',
      status: 'draft',
      tags: ['orders', 'region'],
      description: 'Draft regional order totals',
      chart: 'bar',
      dimensions: ['region'],
      allowedFilters: ['order_date', 'region'],
    });

    const manualCreated = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Manual Draft Sources', goal: 'Show orders by region', authoringMode: 'manual',
      sourcePolicy: 'include_review_required', domain: 'sales',
    });
    const manualDraft = (manualCreated.payload as any).draft;
    const catalog = await invokeAppsApi(
      root,
      `/api/app-builds/${manualDraft.id}/source-candidates?q=orders&limit=50`,
      'GET',
      {},
    );
    expect(catalog).toMatchObject({ handled: true, status: 200, payload: { ok: true } });
    const draftSource = (catalog.payload as any).items[0];
    expect(draftSource).toMatchObject({
      lifecycle: 'draft',
      trust: 'review_required',
      eligibility: { discoverable: true, localPreview: true, projectPublish: false },
    });

    const framed = await invokeAppsApi(root, `/api/app-builds/${manualDraft.id}`, 'PATCH', {
      expectedRevision: manualDraft.revision,
      expectedProposalHash: manualDraft.proposalHash,
      operations: [{
        type: 'set_requirements',
        requirements: [{
          id: 'regional-orders', question: 'Orders by region', role: 'breakdown', required: true,
          measures: [], dimensions: ['region'], filters: ['order_date'],
        }],
        coverage: [{
          requirementId: 'regional-orders', status: 'gap', sourceIds: [], componentIds: [],
          reasons: ['No selected source covers this requirement.'],
        }],
      }],
    });
    const framedManualDraft = (framed.payload as any).draft;

    const manualCompose = await invokeAppsApi(root, `/api/app-builds/${manualDraft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: framedManualDraft.revision,
      expectedProposalHash: framedManualDraft.proposalHash,
      selections: [{ sourceId: draftSource.sourceId, pageId: 'overview', view: 'chart' }],
    });
    const composedManual = (manualCompose.payload as any).draft;
    expect(composedManual).toMatchObject({ version: 3, sourcePolicy: 'include_review_required' });
    expect(composedManual.sources[0]).toMatchObject({
      id: draftSource.sourceId, kind: 'block', lifecycle: 'draft', trustState: 'review_required',
    });
    expect(composedManual.pages[0].layout.items[0]).toMatchObject({
      sourceId: draftSource.sourceId, sourceRevision: draftSource.sourceRevision,
    });
    expect(composedManual.coverage).toEqual([
      expect.objectContaining({
        requirementId: 'regional-orders', status: 'covered',
        sourceIds: [draftSource.sourceId], componentIds: [composedManual.pages[0].layout.items[0].i],
      }),
    ]);

    const aiCreated = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'AI Draft Sources', goal: 'Build regional orders and explain order growth', authoringMode: 'ai',
      sourcePolicy: 'include_review_required', domain: 'sales',
    });
    const aiDraft = (aiCreated.payload as any).draft;
    let planningCalls = 0;
    const proposalResponse = await invokeAppsApi(root, `/api/app-builds/${aiDraft.id}/ai-proposals`, 'POST', {
      prompt: 'Build regional orders and explain order growth',
      expectedRevision: aiDraft.revision,
      proposalHash: aiDraft.proposalHash,
    }, {
      planAppBuild: async () => {
        planningCalls += 1;
        return {
          content: JSON.stringify({
            frame: { goal: 'Regional order health', metrics: ['orders'], dimensions: ['region'], filters: ['order_date'] },
            requirements: [
              { id: 'r-orders', question: 'Orders by region', role: 'breakdown', required: true, measures: ['orders'], dimensions: ['region'], filters: ['order_date'] },
              { id: 'r-growth', question: 'Explain order growth', role: 'trend', required: true, measures: ['orders'], dimensions: ['week'], filters: ['order_date'] },
            ],
            components: [
              { id: 'orders-chart', title: 'Orders by region', sourceId: draftSource.sourceId, requirementIds: ['r-orders'], role: 'breakdown', view: 'bar', rationale: 'Exact regional draft block' },
            ],
          }),
          providerId: 'claude-code',
        };
      },
    });
    expect(proposalResponse.status, JSON.stringify(proposalResponse.payload)).toBe(201);
    const proposal = (proposalResponse.payload as any).proposal;
    expect(planningCalls).toBe(1);
    expect(proposal.plannerProvenance).toEqual({
      version: 1,
      mode: 'ai',
      providerInvocation: 'succeeded',
      providerId: 'claude-code',
    });
    expect(JSON.parse(readFileSync(join(root, '.dql', 'local', 'app-builds', aiDraft.id, 'proposals', `${proposal.id}.json`), 'utf8'))).toMatchObject({
      plannerProvenance: proposal.plannerProvenance,
    });
    expect(proposal.summary).toMatchObject({ requirements: 2, covered: 0, gaps: 2, certifiedSources: 0 });
    expect(proposal.defaultSelectedSourceIds).toEqual([draftSource.sourceId]);

    const contextProposal = {
      version: 1,
      id: 'context-gap-order-growth',
      origin: 'ai',
      status: 'proposed',
      trustState: 'review_required',
      createdAt: '2026-09-11T00:00:00.000Z',
      baseSnapshotId: 'snapshot-order-growth',
      dependencyFingerprints: {},
      operations: [{ id: 'dataset-draft:order-growth', kind: 'dataset_draft' }],
      patches: [{ path: 'domains/sales/blocks/_drafts/order-growth.dql', before: '', after: 'block "Order growth review Dataset" {}', changed: true, owner: 'dql', operationId: 'dataset-draft:order-growth' }],
      diagnostics: [{ code: 'DATASET_DRAFT_REVIEW_REQUIRED', severity: 'info', message: 'Review required.' }],
      impact: { files: 1, modelingChanges: 0, skillChanges: 0, dbtSourceChanges: 0, datasetChanges: 1 },
      proposalHash: 'context-gap-order-growth-hash',
    } as any;
    let gapInput: Record<string, unknown> | undefined;
    const gapResponse = await invokeAppsApi(
      root,
      `/api/app-builds/${aiDraft.id}/ai-proposals/${proposal.id}/gaps`,
      'POST',
      { expectedRevision: aiDraft.revision, expectedProposalHash: aiDraft.proposalHash, requirementId: 'r-growth' },
      {
        createDatasetGapProposal: async (input) => {
          gapInput = input as unknown as Record<string, unknown>;
          return contextProposal;
        },
      },
    );
    expect(gapResponse.status, JSON.stringify(gapResponse.payload)).toBe(201);
    expect(gapResponse.payload).toMatchObject({
      ok: true,
      requirementId: 'r-growth',
      contextProposal: { id: 'context-gap-order-growth', trustState: 'review_required' },
    });
    expect((gapResponse.payload as any).proposal).toBeUndefined();
    expect(gapInput).toMatchObject({ appBuildId: aiDraft.id, requirement: { id: 'r-growth' } });
    expect(existsSync(join(root, '.dql', 'local', 'app-builds', aiDraft.id, 'order-growth.dql'))).toBe(false);
  });

  it('PR3 keeps the Start form domain on the draft and the Add data catalog filters by it', async () => {
    const root = createProject();
    writeBlock(root, 'sales/orders.dql', {
      name: 'Sales Orders', domain: 'sales', status: 'certified', tags: ['orders'], description: 'Orders by region', chart: 'bar',
    });
    writeBlock(root, 'finance/margin.dql', {
      name: 'Finance Margin', domain: 'finance', status: 'certified', tags: ['margin'], description: 'Gross margin', chart: 'bar',
    });
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Sales App', goal: 'Sales health', authoringMode: 'manual', sourcePolicy: 'governed_only', domain: 'sales',
    });
    expect(created.status, JSON.stringify(created.payload)).toBe(201);
    const draft = (created.payload as any).draft;
    const domain = draft.pages[0].metadata.domain;
    expect(domain).toBe('sales');

    const scoped = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=100&domain=${encodeURIComponent(domain)}`, 'GET', {});
    expect((scoped.payload as any).items.map((item: any) => item.name)).toEqual(['Sales Orders']);
    const all = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=100`, 'GET', {});
    expect((all.payload as any).items.map((item: any) => item.name).sort()).toEqual(['Finance Margin', 'Sales Orders']);

    // "All domains" on the Start form sends no domain; the server keeps `general`.
    const unscoped = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Any App', goal: 'Anything', authoringMode: 'manual', sourcePolicy: 'governed_only',
    });
    expect((unscoped.payload as any).draft.pages[0].metadata.domain).toBe('general');
  });

  it('records the App\'s tile trust at publish, and is certified only when every tile is — joins from the current model included (B6)', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const publishWith = async (appId: string, sourcePolicy: 'governed_only' | 'include_review_required', descriptorFor?: (sourceId: string) => DatasetDescriptor | undefined) => {
      const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
        appId, name: appId, goal: 'Revenue by region', authoringMode: 'manual', sourcePolicy, domain: 'commerce',
      });
      const draft = (created.payload as any).draft;
      const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=100`, 'GET', {});
      const dataset = ((catalog.payload as any).items as any[]).find((item) => item.capabilities?.dataset);
      const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
        mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
        selections: [{ sourceId: dataset.sourceId, pageId: 'overview', view: 'chart', title: 'Revenue by region', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } }],
      });
      expect(composed.status, JSON.stringify(composed.payload)).toBe(200);
      const composedDraft = (composed.payload as any).draft as AppBuildDraft;
      // A settled preview of the page, as the Studio records before Publish.
      const settled: AppBuildDraft = { ...composedDraft, previewReceipts: [{ id: 'run-1', pageId: 'overview', revision: composedDraft.revision, snapshotId: 'snapshot', filterFingerprint: 'filters', resultFingerprint: 'results', createdAt: composedDraft.updatedAt }] };
      const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
      try {
        storage.saveAppBuildDraft(settled);
      } finally {
        storage.close();
      }
      expect(preflightStoredAppBuildDraft(root, settled)).toEqual([]);
      publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, settled), { descriptorFor });
      return { dataset, settled, written: JSON.parse(readFileSync(join(root, `apps/${appId}/dql.app.json`), 'utf-8')) };
    };

    // Every tile certified: the App is certified and records 1 of 1.
    const all = await publishWith('all-certified', 'governed_only');
    expect(all.written).toMatchObject({ lifecycle: 'certified', tileTrust: { certified: 1, total: 1 } });
    expect(__test__.collectAppsList(root).find((entry) => entry.id === 'all-certified')).toMatchObject({ certification: 'certified', tileTrust: { certified: 1, total: 1 } });

    // The current model reads Region through a join nobody certified, allowed
    // with "Allow data that needs review": the App is not certified.
    const withReviewJoin = (descriptor: DatasetDescriptor): DatasetDescriptor => ({
      ...descriptor,
      fields: descriptor.fields.map((field) => (field.name === 'region' ? { ...field, related: { join: 'region', column: 'region' } } as typeof field : field)),
      joins: [{ id: 'region', label: 'Region', table: 'regions', relation: 'main.regions', keys: [{ from: 'region', to: 'region' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'proposal:rel', uniqueness: 'current', sentence: 'each order line has one region' }],
    });
    const allowed = await publishWith('review-allowed', 'include_review_required', (sourceId) => {
      const stored = all.settled.sources.find((source) => source.id === sourceId)?.capabilities?.dataset as DatasetDescriptor | undefined;
      return stored ? withReviewJoin(stored) : undefined;
    });
    expect(allowed.written.lifecycle).toBe('review');
    expect(allowed.written.certifiedBy).toBeUndefined();
    expect(allowed.written.tileTrust).toEqual({ certified: 0, total: 1 });
    expect(__test__.collectAppsList(root).find((entry) => entry.id === 'review-allowed')).toMatchObject({ certification: 'uncertified', tileTrust: { certified: 0, total: 1 } });
    // The same answer the Studio and the App header give.
    const trust = appBuildDraftTrust(allowed.settled, (sourceId) => withReviewJoin(allowed.settled.sources.find((source) => source.id === sourceId)!.capabilities!.dataset as DatasetDescriptor));
    expect([trust.label, trust.reviewAllowed]).toEqual(['0 of 1 tile certified', 1]);
  });

  it('PR3 connects data before any tile; data no tile uses never blocks Publish and is not written (design D4)', async () => {
    const root = createProject();
    writeBlock(root, 'sales/draft-orders.dql', {
      name: 'Draft Orders', domain: 'sales', status: 'draft', tags: ['orders'], description: 'Unreviewed orders', chart: 'bar',
    });
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      appId: 'data-first', name: 'Data First', goal: 'Order health', authoringMode: 'manual', sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=100`, 'GET', {});
    const items = (catalog.payload as any).items as any[];
    const dataset = items.find((item) => item.capabilities?.dataset);
    const review = items.find((item) => item.name === 'Draft Orders');
    expect(dataset).toMatchObject({ trust: 'certified' });
    expect(review).toMatchObject({ trust: 'review_required', eligibility: { localPreview: false } });
    // The Add data browser sends the catalog card as the API builds it for a composed tile.
    const draftSource = (item: any) => ({
      id: item.sourceId, kind: item.kind === 'semantic' ? 'governed_semantic' : 'block',
      sourceRef: item.executionRef, qualifiedIdentity: item.qualifiedIdentity, sourcePath: item.sourcePath, executionRef: item.executionRef,
      snapshotId: item.snapshotId, sourceRevision: item.sourceRevision, sourceFingerprint: item.sourceRevision,
      lifecycle: item.lifecycle, capabilities: item.capabilities,
      trustState: item.trust === 'certified' ? 'certified' : 'review_required',
      reviewStatus: item.trust === 'certified' ? 'not_required' : 'required',
    });

    // Data that needs review is refused while only certified data is allowed.
    const refused = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      operations: [{ type: 'upsert_source', source: draftSource(review) }],
    });
    expect(refused.status).toBe(400);

    const patched = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      operations: [
        { type: 'set_source_policy', sourcePolicy: 'include_review_required' },
        { type: 'upsert_source', source: draftSource(dataset) },
        { type: 'upsert_source', source: draftSource(review) },
      ],
    });
    expect(patched.status, JSON.stringify(patched.payload)).toBe(200);
    const connected = (patched.payload as any).draft as AppBuildDraft;
    expect(connected.sources.map((source) => source.id).sort()).toEqual([dataset.sourceId, review.sourceId].sort());
    expect(connected.sources.find((source) => source.id === dataset.sourceId)?.capabilities?.dataset).toBeTruthy();
    expect(connected.pages[0]!.layout.items).toEqual([]);

    expect(preflightStoredAppBuildDraft(root, connected)).toEqual([]);
    const result = publishStoredAppBuildDraft(root, markStoredAppBuildDraftPreflighted(root, connected));
    expect(result.draft.state).toBe('project_published');
    const page = readFileSync(join(root, 'apps/data-first/dashboards/overview.dqld'), 'utf-8');
    expect(page).not.toContain(review.sourceId);
    expect(page).not.toContain(dataset.sourceId);

    // Once a tile uses the review data, it blocks publishing again.
    const second = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      appId: 'data-second', name: 'Data Second', goal: 'Orders', authoringMode: 'manual', sourcePolicy: 'include_review_required',
    });
    const secondDraft = (second.payload as any).draft;
    const composed = await invokeAppsApi(root, `/api/app-builds/${secondDraft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: secondDraft.revision, expectedProposalHash: secondDraft.proposalHash,
      selections: [{ sourceId: review.sourceId, pageId: 'overview', view: 'table' }],
    });
    expect(composed.status, JSON.stringify(composed.payload)).toBe(200);
    expect(preflightStoredAppBuildDraft(root, (composed.payload as any).draft).join(' ')).toMatch(/review-required and cannot be published/);
  });

  it('stores a field-builder query with its v3 Dataset binding atomically (APP-031)', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Order line field App', goal: 'Explore order line revenue by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    expect(source).toMatchObject({
      lifecycle: 'certified', trust: 'certified',
      capabilities: { dataset: { kind: 'block', fields: expect.arrayContaining([expect.objectContaining({ name: 'region', kind: 'physical' }), expect.objectContaining({ name: 'revenue', kind: 'measure' })]) } },
    });

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'chart', title: 'Revenue by region',
        query: {
          dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }],
          filters: [{ field: 'region', op: 'in', values: ['US', 'CA'] }],
          orderBy: [{ alias: 'revenue', direction: 'desc' }], respectsGlobalFilters: true,
        },
      }],
    });
    expect(composed).toMatchObject({ handled: true, status: 200, payload: { ok: true } });
    const saved = (composed.payload as any).draft;
    expect(saved.pages[0]).toMatchObject({ version: 3 });
    expect(saved.pages[0].datasets).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: source.sourceId, sourceRevision: source.sourceRevision }),
    ]));
    expect(saved.pages[0].layout.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Revenue by region',
        sourceId: source.sourceId,
        query: expect.objectContaining({
          dimensions: [{ field: 'region' }],
          measures: [{ measure: 'revenue' }],
          filters: [{ field: 'region', op: 'in', values: ['US', 'CA'] }],
        }),
      }),
    ]));

    const rejected = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: saved.revision, expectedProposalHash: saved.proposalHash,
      selections: [{ sourceId: source.sourceId, pageId: 'overview', view: 'chart', query: { dimensions: [{ field: 'unapproved_field' }], measures: [{ measure: 'revenue' }] } }],
    });
    expect(rejected.status).toBe(409);
    expect((rejected.payload as any).error).toContain('APP_BUILD_DATASET_QUERY_REJECTED');

    const scalarVisualizationRejected = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: saved.revision, expectedProposalHash: saved.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'kpi', title: 'Hidden fields must fail',
        query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
      }],
    });
    expect(scalarVisualizationRejected.status).toBe(409);
    expect((scalarVisualizationRejected.payload as any).error).toContain('APP_BUILD_DATASET_VISUALIZATION_INVALID');
    expect((scalarVisualizationRejected.payload as any).error).toContain('exactly one selected measure');

    const groupedScalarRejected = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: saved.revision, expectedProposalHash: saved.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'kpi', title: 'Grouped KPI must fail',
        query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      }],
    });
    expect(groupedScalarRejected.status).toBe(409);
    expect((groupedScalarRejected.payload as any).error).toContain('APP_BUILD_DATASET_VISUALIZATION_INVALID');
    expect((groupedScalarRejected.payload as any).error).toContain('can group only by one date');
  });

  it('AGT-026 persists several query-bound Dataset tiles from one source without false requirement coverage', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'AI Dataset tiles', goal: 'Review revenue and order volume by region', authoringMode: 'ai',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const provider = async () => JSON.stringify({
      frame: { goal: 'Commerce overview' },
      requirements: [
        { id: 'revenue', question: 'Revenue', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
        { id: 'regional-revenue', question: 'Revenue by region', role: 'breakdown', required: true, measures: ['revenue'], dimensions: ['region'], filters: [] },
        { id: 'orders', question: 'Order count', role: 'kpi', required: true, measures: ['order_count'], dimensions: [], filters: [] },
      ],
      components: [
        { id: 'revenue-kpi', title: 'Revenue', sourceId: source.sourceId, requirementIds: ['revenue'], role: 'kpi', view: 'kpi', rationale: 'Total', query: { dimensions: [], measures: [{ measure: 'revenue' }] } },
        { id: 'regional-revenue', title: 'Revenue by region', sourceId: source.sourceId, requirementIds: ['regional-revenue'], role: 'breakdown', view: 'bar', rationale: 'Breakdown', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } },
        { id: 'orders-kpi', title: 'Order count', sourceId: source.sourceId, requirementIds: ['orders'], role: 'kpi', view: 'kpi', rationale: 'Count', query: { dimensions: [], measures: [{ measure: 'order_count' }] } },
        // This valid revenue query cannot cover the distinct order-count
        // requirement merely because the source card advertises both fields.
        { id: 'wrong-coverage', title: 'Order count', sourceId: source.sourceId, requirementIds: ['orders'], role: 'kpi', view: 'kpi', rationale: 'Wrong', query: { dimensions: [], measures: [{ measure: 'revenue' }] } },
      ],
      pages: [
        { id: 'overview', title: 'Overview', componentIds: ['revenue-kpi', 'regional-revenue', 'wrong-coverage'], sections: [{ id: 'kpis', title: 'Key metrics', kind: 'kpi_band', componentIds: ['revenue-kpi', 'wrong-coverage'] }, { id: 'trend', title: 'Regional performance', kind: 'insight', componentIds: ['regional-revenue'] }] },
        { id: 'details', title: 'Order details', componentIds: ['orders-kpi'], sections: [{ id: 'appendix', title: 'Orders', kind: 'appendix', componentIds: ['orders-kpi'] }] },
      ],
      filters: [{ id: 'region', label: 'Region', field: 'region', scope: 'app', componentIds: ['revenue-kpi', 'regional-revenue', 'wrong-coverage', 'orders-kpi'] }],
      navigation: [{ fromComponentId: 'regional-revenue', toPageId: 'details' }],
      crossFilters: [{ fromComponentId: 'regional-revenue', fromField: 'region', toComponentId: 'wrong-coverage', toField: 'region' }],
      detailDrills: [{ pageId: 'details', componentId: 'orders-kpi', fields: ['region'] }],
    });

    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: draft.frame.goal, expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    }, { planAppBuild: provider });
    expect(proposed.status).toBe(201);
    const proposal = (proposed.payload as any).proposal;
    const pageOperation = proposal.operations.find((operation: any) => operation.type === 'upsert_page' && operation.page.id === 'overview');
    expect(pageOperation.page).toMatchObject({ version: 3 });
    expect(pageOperation.page.datasets).toEqual([
      expect.objectContaining({ sourceId: source.sourceId, sourceRevision: source.sourceRevision }),
    ]);
    expect(pageOperation.page.layout.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ i: 'revenue-kpi', sourceId: source.sourceId, sourceRevision: source.sourceRevision, query: { dimensions: [], measures: [{ measure: 'revenue' }] } }),
      expect.objectContaining({ i: 'regional-revenue', sourceId: source.sourceId, query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } }),
      expect.objectContaining({ i: 'wrong-coverage', sourceId: source.sourceId, query: { dimensions: [], measures: [{ measure: 'revenue' }] } }),
    ]));
    expect(pageOperation.page.layout.items.every((item: any) => item.block === undefined)).toBe(true);
    expect(pageOperation.page.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kpis', kind: 'kpi_band' }),
      expect.objectContaining({ id: 'trend', kind: 'insight' }),
    ]));
    const detailPageOperation = proposal.operations.find((operation: any) => operation.type === 'upsert_page' && operation.page.id === 'details');
    expect(detailPageOperation.page.metadata.title).toBe('Order details');
    expect(detailPageOperation.page.layout.items.find((item: any) => item.i === 'orders-kpi')).toMatchObject({
      query: { measures: [{ measure: 'order_count' }] },
    });
    expect(proposal.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'set_filter', pageId: 'overview', filter: expect.objectContaining({ id: 'region', scope: { app: true } }) }),
      expect.objectContaining({ type: 'set_filter', pageId: 'details', filter: expect.objectContaining({ id: 'region', scope: { app: true } }) }),
      expect.objectContaining({ type: 'set_interactions', pageId: 'overview', interactions: expect.objectContaining({
        crossFilter: expect.objectContaining({ mappings: [expect.objectContaining({ fromTileId: 'regional-revenue', fromField: 'region', toField: 'region' })] }),
        navigate: [expect.objectContaining({ fromTile: 'regional-revenue', toPage: 'details', carryFilters: ['region'] })],
      }) }),
      expect.objectContaining({ type: 'set_interactions', pageId: 'details', interactions: expect.objectContaining({ detail: expect.objectContaining({ columns: ['region'] }) }) }),
    ]));
    const requirements = proposal.operations.find((operation: any) => operation.type === 'set_requirements');
    expect(requirements.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'revenue', status: 'covered', componentIds: ['revenue-kpi'] }),
      expect.objectContaining({ requirementId: 'regional-revenue', status: 'covered', componentIds: ['regional-revenue'] }),
      expect.objectContaining({ requirementId: 'orders', status: 'covered', componentIds: ['orders-kpi'] }),
    ]));

    // Re-resolving authority is necessary, but it cannot silently upgrade a
    // server-issued proposal to a newer Dataset definition. The proposal must
    // be regenerated after a source revision or contract change.
    const changedRevision = `sha256:${'d'.repeat(64)}`;
    const changedContract = `sha256:${'e'.repeat(64)}`;
    const staleAuthority = async (sourceIds: string[]) => sourceIds.map((sourceId) => {
      expect(sourceId).toBe(source.sourceId);
      return {
        ...source,
        sourceRevision: changedRevision,
        capabilities: {
          ...source.capabilities,
          dataset: {
            ...source.capabilities.dataset,
            sourceRevision: changedRevision,
            contractRef: { ...source.capabilities.dataset.contractRef, fingerprint: changedContract },
            binding: {
              ...source.capabilities.dataset.binding,
              sourceRevision: changedRevision,
              contractFingerprint: changedContract,
            },
          },
        },
      };
    });
    const staleCompose = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: [source.sourceId],
      expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
    }, { resolveDatasetSourceAuthority: staleAuthority });
    expect(staleCompose.status).toBe(409);
    expect((staleCompose.payload as any).error).toContain('APP_BUILD_DATASET_PROPOSAL_STALE');
    const unchanged = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'GET', {});
    expect((unchanged.payload as any).draft.revision).toBe(draft.revision);

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: [source.sourceId],
      expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
    });
    expect(composed.status).toBe(200);
    const saved = (composed.payload as any).draft;
    expect(saved.pages[0].datasets).toEqual([
      expect.objectContaining({ sourceId: source.sourceId, sourceRevision: source.sourceRevision }),
    ]);
    expect(saved.pages[0].layout.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ i: 'revenue-kpi', query: expect.objectContaining({ measures: [{ measure: 'revenue' }] }) }),
      expect.objectContaining({ i: 'regional-revenue', query: expect.objectContaining({ dimensions: [{ field: 'region' }] }) }),
      expect.objectContaining({ i: 'wrong-coverage', query: expect.objectContaining({ measures: [{ measure: 'revenue' }] }) }),
    ]));
    expect(saved.pages.find((page: any) => page.id === 'details')).toMatchObject({
      metadata: { title: 'Order details' },
      filters: [expect.objectContaining({ id: 'region', scope: { app: true } })],
      layout: { items: [expect.objectContaining({ i: 'orders-kpi', query: expect.objectContaining({ measures: [{ measure: 'order_count' }] }) })] },
      interactions: { detail: expect.objectContaining({ columns: ['region'] }) },
    });
    expect(saved.pages.find((page: any) => page.id === 'overview')).toMatchObject({
      filters: [expect.objectContaining({ id: 'region', scope: { app: true } })],
      interactions: expect.objectContaining({
        navigate: [expect.objectContaining({ fromTile: 'regional-revenue', toPage: 'details', carryFilters: ['region'] })],
      }),
    });
  });

  it('RFC-0009 Show Me picks the chart for AI tiles and lays their fields on shelves', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Regional App', goal: 'Understand revenue by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const byRegion = { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] };
    const provider = async () => JSON.stringify({
      frame: { goal: 'Revenue by region' },
      requirements: [
        { id: 'breakdown', question: 'Revenue by region', role: 'breakdown', required: true, measures: ['revenue'], dimensions: ['region'], filters: [] },
        { id: 'rows', question: 'Revenue rows by region', role: 'detail', required: true, measures: ['revenue'], dimensions: ['region'], filters: [] },
      ],
      components: [
        // Region is not a date: a line would join categories as if in time order.
        { id: 'by-region', title: 'Revenue by region', sourceId: source.sourceId, requirementIds: ['breakdown'], role: 'breakdown', view: 'line', rationale: 'Split', query: byRegion },
        { id: 'region-table', title: 'Revenue table', sourceId: source.sourceId, requirementIds: ['rows'], role: 'detail', view: 'bar', rationale: 'Rows', query: byRegion },
      ],
      pages: [{ id: 'overview', title: 'Overview', componentIds: ['by-region', 'region-table'], sections: [{ id: 'main', title: 'Revenue', kind: 'grid', componentIds: ['by-region', 'region-table'] }] }],
      filters: [], navigation: [], crossFilters: [], detailDrills: [],
    });
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: 'Revenue by region', expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    }, { planAppBuild: provider });
    expect(proposed.status).toBe(201);
    const page = (proposed.payload as any).proposal.operations.find((operation: any) => operation.type === 'upsert_page').page;
    const tile = (id: string) => page.layout.items.find((item: any) => item.i === id);
    expect(tile('by-region').viz).toEqual({ type: 'bar', encoding: { version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] } });
    // A detail component stays a table.
    expect(tile('region-table').viz).toEqual({ type: 'table' });
  });

  it('RFC-0008 page AI adds to the page the author has open and lets them decline single tiles', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Regional App', goal: 'Understand revenue by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);

    // A second page with one tile the author built by hand.
    const withPage = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision,
      operations: [{
        type: 'upsert_page',
        page: {
          version: 3, id: 'regions', datasets: [],
          metadata: { title: 'Regions', description: 'Hand-written page', domain: 'commerce' },
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
        },
      }],
    });
    expect(withPage.status).toBe(200);
    const paged = (withPage.payload as any).draft;
    const manual = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: paged.revision, expectedProposalHash: paged.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'regions', view: 'chart', title: 'Revenue by region',
        query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      }],
    });
    expect(manual.status).toBe(200);
    const before = (manual.payload as any).draft;
    const handTileId = before.pages.find((page: any) => page.id === 'regions').layout.items[0].i;
    const overviewBefore = before.pages.find((page: any) => page.id === 'overview');

    // The planner names its page "overview", but the author asked on Regions.
    const provider = async () => JSON.stringify({
      frame: { goal: 'A different goal the planner made up' },
      requirements: [
        { id: 'revenue', question: 'Revenue', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
        { id: 'orders', question: 'Order count', role: 'kpi', required: true, measures: ['order_count'], dimensions: [], filters: [] },
      ],
      components: [
        { id: 'revenue-kpi', title: 'Revenue', sourceId: source.sourceId, requirementIds: ['revenue'], role: 'kpi', view: 'kpi', rationale: 'Total', query: { dimensions: [], measures: [{ measure: 'revenue' }] },
          // The planner may style a chart; a malformed field is dropped, not fatal.
          style: { format: 'compact', referenceLines: [{ value: 1000, label: 'Target' }], labels: 'sometimes' } },
        { id: 'orders-kpi', title: 'Order count', sourceId: source.sourceId, requirementIds: ['orders'], role: 'kpi', view: 'kpi', rationale: 'Count', query: { dimensions: [], measures: [{ measure: 'order_count' }] } },
      ],
      pages: [{ id: 'overview', title: 'Planner title', componentIds: ['revenue-kpi', 'orders-kpi'], sections: [{ id: 'kpis', title: 'Key metrics', kind: 'kpi_band', componentIds: ['revenue-kpi', 'orders-kpi'] }] }],
      filters: [], navigation: [], crossFilters: [], detailDrills: [],
    });
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: 'Add headline KPIs', expectedRevision: before.revision, proposalHash: before.proposalHash, pageId: 'regions',
    }, { planAppBuild: provider });
    expect(proposed.status).toBe(201);
    const proposal = (proposed.payload as any).proposal;
    expect(proposal).toMatchObject({ mode: 'add', targetPageId: 'regions', prompt: 'Add headline KPIs' });
    expect(proposal.proposedTileIds).toEqual(['revenue-kpi', 'orders-kpi']);
    const pageOps = proposal.operations.filter((operation: any) => operation.type === 'upsert_page');
    expect(pageOps.map((operation: any) => operation.page.id)).toEqual(['regions']);
    const regions = pageOps[0].page;
    // The hand-built tile, title and description stay; new tiles go below it.
    expect(regions.metadata).toMatchObject({ title: 'Regions', description: 'Hand-written page' });
    expect(regions.layout.items.map((item: any) => item.i)).toEqual([handTileId, 'revenue-kpi', 'orders-kpi']);
    // AI-written style lands on the tile exactly as the Studio panel writes it.
    // Show Me (RFC 0009) picks the chart and lays the fields on shelves.
    expect(regions.layout.items[1].viz).toEqual({ type: 'single_value', encoding: { version: 1, columns: [], rows: [{ measure: 'revenue' }] }, style: { format: 'compact', referenceLines: [{ value: 1000, label: 'Target' }] } });
    expect(regions.layout.items[2].viz).toEqual({ type: 'single_value', encoding: { version: 1, columns: [], rows: [{ measure: 'order_count' }] } });
    const handTile = regions.layout.items[0];
    expect(regions.layout.items[1].y).toBeGreaterThanOrEqual(handTile.y + handTile.h);
    // The App goal is the author's, not the planner's.
    expect(proposal.operations.find((operation: any) => operation.type === 'set_frame').frame.goal).toBe('Understand revenue by region');

    const unknownTile = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: [source.sourceId], rejectedTileIds: [handTileId],
      expectedRevision: before.revision, expectedProposalHash: before.proposalHash,
    });
    expect(unknownTile.status).toBe(409);
    expect((unknownTile.payload as any).error).toContain('APP_BUILD_TILE_NOT_IN_PROPOSAL');

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: [source.sourceId], rejectedTileIds: ['orders-kpi'],
      expectedRevision: before.revision, expectedProposalHash: before.proposalHash,
    });
    expect(composed.status).toBe(200);
    expect((composed.payload as any).tileIds).toEqual(['revenue-kpi']);
    const saved = (composed.payload as any).draft;
    expect(saved.pages.find((page: any) => page.id === 'regions').layout.items.map((item: any) => item.i))
      .toEqual([handTileId, 'revenue-kpi']);
    // Overview was never touched.
    expect(saved.pages.find((page: any) => page.id === 'overview')).toEqual(overviewBefore);
    // Earlier requirements survive; the declined tile's requirement stays a gap.
    const coverage = new Map(saved.coverage.map((item: any) => [item.requirementId, item.status]));
    expect(coverage.get('revenue')).toBe('covered');
    expect(coverage.get('orders')).toBe('gap');
  });

  it('RFC-0008 replace mode still rebuilds the page from the plan when the author asks for it', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Replace App', goal: 'Revenue overview', authoringMode: 'manual', sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const manual = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      selections: [{ sourceId: source.sourceId, pageId: 'overview', view: 'chart', title: 'Old chart', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } }],
    });
    const before = (manual.payload as any).draft;
    const provider = async () => JSON.stringify({
      frame: { goal: 'Revenue overview' },
      requirements: [{ id: 'revenue', question: 'Revenue', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] }],
      components: [{ id: 'revenue-kpi', title: 'Revenue', sourceId: source.sourceId, requirementIds: ['revenue'], role: 'kpi', view: 'kpi', rationale: 'Total', query: { dimensions: [], measures: [{ measure: 'revenue' }] } }],
      pages: [{ id: 'overview', title: 'Overview', componentIds: ['revenue-kpi'], sections: [] }],
      filters: [], navigation: [], crossFilters: [], detailDrills: [],
    });
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: 'Start over with one KPI', expectedRevision: before.revision, proposalHash: before.proposalHash, mode: 'replace',
    }, { planAppBuild: provider });
    const proposal = (proposed.payload as any).proposal;
    expect(proposal.mode).toBe('replace');
    const page = proposal.operations.find((operation: any) => operation.type === 'upsert_page').page;
    expect(page.layout.items.map((item: any) => item.i)).toEqual(['revenue-kpi']);
  });


  it('D4 keyword suggestions note what they did not match, and never block publishing with it', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Keyword App', goal: 'Revenue by region', authoringMode: 'ai', sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    // No planAppBuild hook: no AI provider, so the keyword matcher plans.
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: 'Revenue by region. Keep it short and clear.', expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    });
    expect(proposed.status).toBe(201);
    const proposal = (proposed.payload as any).proposal;
    expect(proposal.plannerProvenance).toMatchObject({ mode: 'deterministic', providerInvocation: 'not_attempted' });
    const requirements = proposal.operations.find((operation: any) => operation.type === 'set_requirements');
    expect(requirements.requirements.length).toBeGreaterThan(0);
    expect(requirements.requirements.every((requirement: any) => requirement.required === false)).toBe(true);
    expect(requirements.coverage.some((item: any) => item.status === 'gap')).toBe(true);

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: proposal.defaultSelectedSourceIds,
      expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
    });
    expect(composed.status).toBe(200);
    const saved = (composed.payload as any).draft;
    // The gap is still there to read ("Not covered yet"), but it is no publish fix.
    expect(saved.coverage.some((item: any) => item.status === 'gap')).toBe(true);
    expect(preflightStoredAppBuildDraft(root, saved).join('\n')).not.toContain('Required App question is unresolved');
  });

  it('D4 a proposal never adds a tile the page already shows, and its question stays covered', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Revise App', goal: 'Revenue by region', authoringMode: 'manual', sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const manual = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'chart', title: 'Revenue by region',
        query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      }],
    });
    expect(manual.status).toBe(200);
    const before = (manual.payload as any).draft;
    const handTileId = before.pages[0].layout.items[0].i;
    // The plan asks for the same chart again (sorted differently) and one new KPI.
    const provider = async () => JSON.stringify({
      frame: { goal: 'Revenue by region' },
      requirements: [
        { id: 'by-region', question: 'Revenue by region', role: 'breakdown', required: true, measures: ['revenue'], dimensions: ['region'], filters: [] },
        { id: 'orders', question: 'Order count', role: 'kpi', required: true, measures: ['order_count'], dimensions: [], filters: [] },
      ],
      components: [
        { id: 'region-again', title: 'Revenue by region', sourceId: source.sourceId, requirementIds: ['by-region'], role: 'breakdown', view: 'bar', rationale: 'Regions',
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }] } },
        { id: 'orders-kpi', title: 'Order count', sourceId: source.sourceId, requirementIds: ['orders'], role: 'kpi', view: 'kpi', rationale: 'Count', query: { dimensions: [], measures: [{ measure: 'order_count' }] } },
      ],
      pages: [{ id: 'overview', title: 'Overview', componentIds: ['region-again', 'orders-kpi'], sections: [] }],
      filters: [], navigation: [], crossFilters: [], detailDrills: [],
    });
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: 'Revise the page', expectedRevision: before.revision, proposalHash: before.proposalHash, pageId: 'overview',
    }, { planAppBuild: provider });
    expect(proposed.status).toBe(201);
    const proposal = (proposed.payload as any).proposal;
    expect(proposal.proposedTileIds).toEqual(['orders-kpi']);
    const page = proposal.operations.find((operation: any) => operation.type === 'upsert_page').page;
    expect(page.layout.items.map((item: any) => item.i)).toEqual([handTileId, 'orders-kpi']);
    expect(proposal.warnings).toContain('Revenue by region is already on this page, so it wasn\'t added again.');
    const coverage = proposal.operations.find((operation: any) => operation.type === 'set_requirements').coverage;
    expect(coverage.find((item: any) => item.requirementId === 'by-region')).toMatchObject({ status: 'covered', componentIds: [handTileId] });

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'ai', proposalId: proposal.id, selectedSourceIds: proposal.defaultSelectedSourceIds,
      expectedRevision: before.revision, expectedProposalHash: before.proposalHash,
    });
    expect(composed.status).toBe(200);
    const saved = (composed.payload as any).draft;
    expect(saved.pages[0].layout.items.map((item: any) => item.i)).toEqual([handTileId, 'orders-kpi']);
    expect(new Map(saved.coverage.map((item: any) => [item.requirementId, item.status])).get('by-region')).toBe('covered');
  });

  it('APP-065 prepares and atomically applies a source-pinned universal App Autopilot Dataset change', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Copilot Dataset App', goal: 'Review revenue', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const initial = (created.payload as any).draft;
    const candidates = await invokeAppsApi(root, `/api/app-builds/${initial.id}/source-candidates?limit=50`, 'GET', {});
    const source = (candidates.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const composed = await invokeAppsApi(root, `/api/app-builds/${initial.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: initial.revision, expectedProposalHash: initial.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'kpi', title: 'Revenue',
        query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
      }],
    });
    expect(composed.status).toBe(200);
    const draft = (composed.payload as any).draft;
    const tile = draft.pages[0].layout.items.find((item: any) => item.query?.measures?.[0]?.measure === 'revenue');

    const proposal = await prepareAppAutopilotChange(root, {
      draftId: draft.id,
      pageId: 'overview',
      tileId: tile.i,
      intent: { action: 'group_tile', request: 'Group this tile by Region', field: 'region' },
      runId: 'run_app_autopilot',
      artifactId: 'app_autopilot:run_app_autopilot',
    });
    expect(proposal).toMatchObject({
      version: 1,
      runId: 'run_app_autopilot',
      artifactId: 'app_autopilot:run_app_autopilot',
      draftId: draft.id,
      pageId: 'overview',
      tileId: tile.i,
      intent: { action: 'group_tile', request: 'Group this tile by Region', field: 'region' },
      planningMode: 'universal_agent',
      source: {
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        contractFingerprint: source.capabilities.dataset.contractRef.fingerprint,
      },
      operations: [{
        type: 'update_tile', pageId: 'overview', tileId: tile.i,
        patch: { query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' } },
      }],
    });
    expect(JSON.stringify(proposal)).not.toMatch(/select\s|remove_source|browser-forged/i);
    const unchanged = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'GET', {});
    expect((unchanged.payload as any).draft).toMatchObject({
      revision: draft.revision,
      proposalHash: draft.proposalHash,
    });
    expect((unchanged.payload as any).draft.pages[0].layout.items.find((item: any) => item.i === tile.i).query.dimensions).toEqual([]);

    const changedRevision = `sha256:${'f'.repeat(64)}`;
    const changedContract = `sha256:${'a'.repeat(64)}`;
    const staleAuthority = async (sourceIds: string[]) => sourceIds.map((sourceId) => {
      expect(sourceId).toBe(source.sourceId);
      return {
        ...source,
        sourceRevision: changedRevision,
        capabilities: {
          ...source.capabilities,
          dataset: {
            ...source.capabilities.dataset,
            sourceRevision: changedRevision,
            contractRef: { ...source.capabilities.dataset.contractRef, fingerprint: changedContract },
            binding: {
              ...source.capabilities.dataset.binding,
              sourceRevision: changedRevision,
              contractFingerprint: changedContract,
            },
          },
        },
      };
    });
    await expect(applyAppAutopilotChange(root, {
      draftId: draft.id,
      proposalId: proposal.id,
      runId: proposal.runId,
      artifactId: proposal.artifactId,
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      proposalHash: proposal.proposalHash,
    }, staleAuthority)).rejects.toThrow('APP_AUTOPILOT_CHANGE_STALE');
    const stillUnchanged = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'GET', {});
    expect((stillUnchanged.payload as any).draft.revision).toBe(draft.revision);

    const accepted = await applyAppAutopilotChange(root, {
      draftId: draft.id,
      proposalId: proposal.id,
      runId: proposal.runId,
      artifactId: proposal.artifactId,
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      proposalHash: proposal.proposalHash,
    });
    expect(accepted.deduped).toBe(false);
    const saved = accepted.draft;
    expect(saved.revision).toBe(draft.revision + 1);
    expect(saved.previewReceipts).toBeUndefined();
    expect(saved.pages[0].layout.items.find((item: any) => item.i === tile.i)).toMatchObject({
      title: 'Revenue by Region',
      viz: { type: 'bar' },
      query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
    });
    const repeatedApply = await applyAppAutopilotChange(root, {
      draftId: draft.id,
      proposalId: proposal.id,
      runId: proposal.runId,
      artifactId: proposal.artifactId,
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      proposalHash: proposal.proposalHash,
    });
    expect(repeatedApply).toMatchObject({ deduped: true, proposalId: proposal.id, draft: { revision: saved.revision } });

    // A compound presentation request is one immutable proposal and one
    // atomic update_tile operation. It does not create a partial title-only or
    // visualization-only draft revision before the explicit guarded Apply.
    const compound = await prepareAppAutopilotChange(root, {
      draftId: saved.id,
      pageId: 'overview',
      tileId: tile.i,
      intent: {
        action: 'change_visualization',
        request: 'Change the title to Revenue Trend by Region and show this as a line chart.',
        title: 'Revenue Trend by Region',
        visualization: 'line',
      },
      runId: 'run_app_autopilot_compound',
      artifactId: 'app_autopilot:run_app_autopilot_compound',
    });
    expect(compound.operations).toEqual([{
      type: 'update_tile', pageId: 'overview', tileId: tile.i,
      patch: { title: 'Revenue Trend by Region', viz: { type: 'line' } },
    }]);
    const beforeCompoundApply = await invokeAppsApi(root, `/api/app-builds/${saved.id}`, 'GET', {});
    expect((beforeCompoundApply.payload as any).draft.pages[0].layout.items.find((item: any) => item.i === tile.i)).toMatchObject({
      title: 'Revenue by Region', viz: { type: 'bar' },
    });
    const compoundApplied = await applyAppAutopilotChange(root, {
      draftId: saved.id,
      proposalId: compound.id,
      runId: compound.runId,
      artifactId: compound.artifactId,
      expectedRevision: saved.revision,
      expectedProposalHash: saved.proposalHash,
      proposalHash: compound.proposalHash,
    });
    expect(compoundApplied).toMatchObject({ deduped: false, draft: { revision: saved.revision + 1 } });
    expect(compoundApplied.draft.pages[0].layout.items.find((item: any) => item.i === tile.i)).toMatchObject({
      title: 'Revenue Trend by Region', viz: { type: 'line' },
    });

    await expect(prepareAppAutopilotChange(root, {
      draftId: saved.id,
      pageId: 'overview',
      tileId: tile.i,
      intent: { action: 'group_tile', request: 'SELECT region FROM orders', field: 'region' },
      runId: 'run_app_autopilot_invalid',
      artifactId: 'app_autopilot:run_app_autopilot_invalid',
    })).rejects.toThrow('APP_AUTOPILOT_INTENT_INVALID');
    await expect(prepareAppAutopilotChange(root, {
      draftId: compoundApplied.draft.id,
      pageId: 'overview',
      tileId: tile.i,
      intent: { action: 'unknown_action' as any, request: 'Change the title to Revenue.' },
      runId: 'run_app_autopilot_unknown_action',
      artifactId: 'app_autopilot:run_app_autopilot_unknown_action',
    })).rejects.toThrow('APP_AUTOPILOT_INTENT_INVALID');
  });

  it('APP-064 routes an explicit uncovered App requirement to an immutable typed Dataset draft proposal', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Gap review App', goal: 'Show retention health', authoringMode: 'ai',
      sourcePolicy: 'include_review_required', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);
    const plan = async () => JSON.stringify({
      frame: { goal: 'Show retention health' },
      requirements: [{
        id: 'retention-health', question: 'Retention health', role: 'kpi', required: true,
        measures: ['retention_score'], dimensions: [], filters: [],
      }],
      // It names an unapproved field. The planner keeps the requirement visible
      // as a gap; the App API must not materialize this as a SQL tile.
      components: [{
        id: 'invalid-retention', title: 'Retention health', sourceId: source.sourceId,
        requirementIds: ['retention-health'], role: 'kpi', view: 'kpi', rationale: 'Not an approved Dataset measure',
        query: { dimensions: [], measures: [{ measure: 'retention_score' }] },
      }],
    });
    const proposed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: draft.frame.goal, expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    }, { planAppBuild: plan });
    expect(proposed.status, JSON.stringify(proposed.payload)).toBe(201);
    const proposal = (proposed.payload as any).proposal;
    const gapRequirement = proposal.operations.find((operation: any) => operation.type === 'set_requirements').coverage
      .find((coverage: any) => coverage.status === 'gap');
    // The provider's malformed field query deliberately falls back to a
    // deterministic requirement, whose id is server-issued. The explicit gap
    // request must use that current id instead of preserving provider text.
    expect(gapRequirement).toEqual(expect.objectContaining({ status: 'gap' }));
    expect(JSON.stringify(proposal.operations)).not.toContain('SELECT ');

    let gapInput: Record<string, unknown> | undefined;
    const contextProposal = {
      version: 1,
      id: 'context-gap-retention',
      origin: 'ai',
      status: 'proposed',
      trustState: 'review_required',
      createdAt: '2026-09-11T00:00:00.000Z',
      baseSnapshotId: 'snapshot-gap',
      dependencyFingerprints: {},
      operations: [{ id: 'dataset-draft:retention', kind: 'dataset_draft' }],
      patches: [{ path: 'domains/commerce/blocks/_drafts/retention-health.dql', before: '', after: 'block "Retention review Dataset" {}', changed: true, owner: 'dql', operationId: 'dataset-draft:retention' }],
      diagnostics: [{ code: 'DATASET_DRAFT_REVIEW_REQUIRED', severity: 'info', message: 'Review required.' }],
      impact: { files: 1, modelingChanges: 0, skillChanges: 0, dbtSourceChanges: 0, datasetChanges: 1 },
      proposalHash: 'context-gap-hash',
    } as any;
    const generated = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals/${proposal.id}/gaps`, 'POST', {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      requirementId: gapRequirement.requirementId,
      domain: 'commerce',
      sourceRelation: 'review_retention_source',
    }, {
      createDatasetGapProposal: async (input) => {
        gapInput = input as unknown as Record<string, unknown>;
        return contextProposal;
      },
    });
    expect(generated.status).toBe(201);
    expect(generated.payload).toMatchObject({ ok: true, requirementId: gapRequirement.requirementId, contextProposal: { id: 'context-gap-retention', trustState: 'review_required' } });
    expect((generated.payload as any).proposal).toBeUndefined();
    expect(gapInput).toMatchObject({ appBuildId: draft.id, requirement: { id: gapRequirement.requirementId }, domain: 'commerce', sourceRelation: 'review_retention_source' });

    const stale = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals/${proposal.id}/gaps`, 'POST', {
      expectedRevision: draft.revision + 1,
      expectedProposalHash: draft.proposalHash,
      requirementId: gapRequirement.requirementId,
    }, { createDatasetGapProposal: async () => contextProposal });
    expect(stale.status).toBe(409);
    expect((stale.payload as any).error).toContain('APP_BUILD_PROPOSAL_CONFLICT');
  });

  it('reports field-based Dataset tiles as on when the runtime does not turn them off (APP-007)', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Default Dataset App', goal: 'Explore revenue by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    });
    const draft = (created.payload as any).draft;
    const unset = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    expect(unset).toMatchObject({ status: 200, payload: { features: { datasets: true } } });
    const on = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {}, { datasetsEnabled: true });
    expect(on).toMatchObject({ status: 200, payload: { features: { datasets: true } } });
  });

  it('reports and enforces apps.datasets: false as the off-switch (APP-007)', async () => {
    const root = createProject();
    writeDatasetBlock(root, 'commerce/order-lines.dql');
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Feature-gated Dataset App', goal: 'Explore revenue by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'commerce',
    }, { datasetsEnabled: false });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {}, { datasetsEnabled: false });
    expect(catalog).toMatchObject({ status: 200, payload: { features: { datasets: false } } });
    const source = (catalog.payload as any).items.find((item: any) => item.capabilities?.dataset?.id);

    const blocked = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      selections: [{
        sourceId: source.sourceId, pageId: 'overview', view: 'chart',
        query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      }],
    }, { datasetsEnabled: false });
    expect(blocked.status).toBe(409);
    expect((blocked.payload as any).error).toContain('APP_DATASETS_FEATURE_DISABLED');
  });

  it('keeps exact source additions authoritative across proposal revisions and review policy (PRD-007, AGT-026, API-014)', async () => {
    const root = createProject();
    writeBlock(root, 'sales/revenue.dql', {
      name: 'Revenue KPI', domain: 'sales', status: 'certified', tags: ['revenue'],
      description: 'Certified revenue total', chart: 'single_value', query: 'SELECT 1 AS revenue',
    });
    writeBlock(root, 'sales/orders.dql', {
      name: 'Revenue Order Detail', domain: 'sales', status: 'certified', tags: ['orders', 'revenue'],
      description: 'Certified weekly order trend', chart: 'line', dimensions: ['order_week'],
    });
    writeBlock(root, 'sales/margin.dql', {
      name: 'Margin Review', domain: 'sales', status: 'draft', tags: ['margin'],
      description: 'Draft margin analysis', chart: 'bar', dimensions: ['region'],
    });
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Sales Decisions', goal: 'Track revenue, orders, and margin', authoringMode: 'ai',
      sourcePolicy: 'governed_only', domain: 'sales',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const catalogItems = (catalog.payload as any).items as any[];
    const revenue = catalogItems.find((source) => source.name === 'Revenue KPI');
    const orders = catalogItems.find((source) => source.name === 'Revenue Order Detail');
    const margin = catalogItems.find((source) => source.name === 'Margin Review');
    const provider = async () => JSON.stringify({
      frame: { goal: 'Track sales decisions' },
      requirements: [
        { id: 'revenue', question: 'Revenue KPI', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
        { id: 'margin', question: 'Profit margin', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
      ],
      components: [{ id: 'revenue-kpi', title: 'Revenue KPI', sourceId: revenue.sourceId, requirementIds: ['revenue', 'margin'], role: 'kpi', view: 'kpi', rationale: 'Provider incorrectly claimed margin coverage from revenue' }],
    });
    const initial = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: draft.frame.goal, expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    }, { planAppBuild: provider });
    const initialProposal = (initial.payload as any).proposal;

    const revised = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals/${initialProposal.id}/revisions`, 'POST', {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      selectedSourceIds: [revenue.sourceId],
      additionalSourceIds: [orders.sourceId],
    }, { planAppBuild: provider });
    expect(revised.status).toBe(201);
    const revisedProposal = (revised.payload as any).proposal;
    expect(revisedProposal.defaultSelectedSourceIds).toEqual([revenue.sourceId, orders.sourceId]);
    expect(revisedProposal.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'upsert_source', source: expect.objectContaining({ id: orders.sourceId }) }),
      expect.objectContaining({ type: 'upsert_page', page: expect.objectContaining({
        layout: expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ sourceId: orders.sourceId })]) }),
      }) }),
    ]));
    const revisedRequirements = revisedProposal.operations.find((operation: any) => operation.type === 'set_requirements');
    expect(revisedRequirements.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'margin', status: 'gap', sourceIds: [], componentIds: [] }),
    ]));

    const blocked = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals/${revisedProposal.id}/revisions`, 'POST', {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      selectedSourceIds: [revenue.sourceId, orders.sourceId],
      additionalSourceIds: [margin.sourceId],
    }, { planAppBuild: provider });
    expect(blocked).toMatchObject({ status: 400, payload: { ok: false } });
    expect((blocked.payload as any).error).toContain('APP_BUILD_REVIEW_POLICY_REQUIRED');

    const enabled = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'PATCH', {
      expectedRevision: draft.revision,
      expectedProposalHash: draft.proposalHash,
      operations: [{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }],
    });
    const reviewDraft = (enabled.payload as any).draft;
    const reviewProposalResponse = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: reviewDraft.frame.goal,
      expectedRevision: reviewDraft.revision,
      proposalHash: reviewDraft.proposalHash,
      selectedBlockIds: [revenue.sourceId, orders.sourceId, margin.sourceId],
    }, { planAppBuild: provider });
    expect(reviewProposalResponse.status).toBe(201);
    const reviewProposal = (reviewProposalResponse.payload as any).proposal;
    expect(reviewProposal.defaultSelectedSourceIds).toHaveLength(3);
    expect(reviewProposal.defaultSelectedSourceIds).toEqual(expect.arrayContaining([revenue.sourceId, orders.sourceId, margin.sourceId]));
    expect(reviewProposal.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'upsert_source', source: expect.objectContaining({ id: margin.sourceId, trustState: 'review_required' }) }),
    ]));
  });

  it('atomically enables the review lane during manual draft composition (API-014, UI-023)', async () => {
    const root = createProject();
    writeBlock(root, 'sales/margin.dql', {
      name: 'Margin Review', domain: 'sales', status: 'draft', tags: ['margin'],
      description: 'Draft margin analysis', chart: 'bar', dimensions: ['region'],
    });
    const created = await invokeAppsApi(root, '/api/app-builds', 'POST', {
      name: 'Margin Decisions', goal: 'Review margin by region', authoringMode: 'manual',
      sourcePolicy: 'governed_only', domain: 'sales',
    });
    const draft = (created.payload as any).draft;
    const catalog = await invokeAppsApi(root, `/api/app-builds/${draft.id}/source-candidates?limit=50`, 'GET', {});
    const source = (catalog.payload as any).items.find((item: any) => item.name === 'Margin Review');
    const request = {
      mode: 'manual', expectedRevision: draft.revision, expectedProposalHash: draft.proposalHash,
      selections: [{ sourceId: source.sourceId, pageId: 'overview', view: 'chart' }],
    };

    const blocked = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', request);
    expect((blocked.payload as any).error).toContain('APP_BUILD_REVIEW_POLICY_REQUIRED');

    const composed = await invokeAppsApi(root, `/api/app-builds/${draft.id}/compose`, 'POST', {
      ...request,
      enableReviewRequired: true,
    });
    expect(composed.status).toBe(200);
    expect((composed.payload as any).draft).toMatchObject({
      sourcePolicy: 'include_review_required',
      sources: [expect.objectContaining({ id: source.sourceId, lifecycle: 'draft', trustState: 'review_required' })],
      reviewTasks: [expect.objectContaining({ sourceId: source.sourceId, status: 'open' })],
    });
  });

  it('lazily migrates v2 only when source identity is unique and exposes ambiguity as a blocker', async () => {
    const root = createProject();
    const duplicate = {
      name: 'Performance', status: 'draft', tags: ['performance'],
      description: 'Performance dashboard source', chart: 'bar',
    };
    writeBlock(root, 'sales/performance.dql', { ...duplicate, domain: 'sales' });
    writeBlock(root, 'customer/performance.dql', { ...duplicate, domain: 'customer' });
    const draft = createStoredAppBuildDraft(root, {
      name: 'Legacy Performance', goal: 'Monitor performance', authoringMode: 'manual',
      sourcePolicy: 'include_review_required',
    });
    const legacy = {
      ...draft,
      version: 2,
      sources: [{
        id: 'review-block:Performance', kind: 'review_block', sourceRef: 'Performance',
        trustState: 'review_required', reviewStatus: 'required',
      }],
      pages: draft.pages.map((page) => ({
        ...page,
        layout: {
          ...page.layout,
          items: [{
            i: 'performance', x: 0, y: 0, w: 6, h: 4, title: 'Performance',
            block: { blockId: 'Performance' }, viz: { type: 'bar' },
          }],
        },
      })),
    };
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      storage.saveAppBuildDraft(legacy as never);
    } finally {
      storage.close();
    }

    const response = await invokeAppsApi(root, `/api/app-builds/${draft.id}`, 'GET', {});
    const migrated = (response.payload as any).draft;
    expect(migrated.version).toBe(3);
    expect(migrated.sources[0]).toMatchObject({
      id: 'review-block:Performance', lifecycle: 'unknown', trustState: 'review_required',
    });
    expect(migrated.reviewTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'open', sourceId: 'review-block:Performance', message: expect.stringContaining('ambiguous') }),
    ]));
  });

  it('retains bounded App repair evidence and only makes a successful repaired preview selectable', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue', domain: 'revenue', status: 'certified', tags: ['revenue'], description: 'Revenue KPI', chart: 'single_value',
    });
    const repairedSql = 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region';
    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app and explain why revenue is changing.',
      domain: 'revenue', owner: 'owner@local', mode: 'personal', exploreGaps: true, maxGeneratedTiles: 1,
    }, {
      generateGovernedAnswer: async () => ({
        kind: 'uncertified',
        text: 'Review the repaired regional analysis.',
        sql: repairedSql,
        result: { columns: ['region', 'revenue'], rows: [{ region: 'NA', revenue: 100 }], rowCount: 1 },
        appBuilderRepair: {
          version: 1,
          status: 'repaired',
          source: 'query_generator',
          mode: 'ai',
          attemptedAt: '2026-08-02T00:00:00.000Z',
          originalFailure: 'Column revenue_total was not found.',
          originalSqlFingerprint: `sha256:${'a'.repeat(64)}`,
          repairedSqlFingerprint: `sha256:${createHash('sha256').update(repairedSql).digest('hex')}`,
          approvalEligible: false,
          message: 'AI repair executed successfully on the same data target. Review the repaired query.',
        },
      } as never),
    });

    const repairedTile = session.proposal?.tiles.find((tile) => tile.source === 'ai_generated');
    expect(repairedTile).toMatchObject({
      sql: repairedSql,
      selectedByDefault: false,
      preflight: { status: 'passed' },
      repair: { status: 'repaired', mode: 'ai', approvalEligible: false },
    });
    expect(repairedTile?.error).toBeUndefined();

    const failed = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app and explain why revenue is changing.',
      domain: 'revenue', owner: 'owner@local', mode: 'personal', exploreGaps: true, maxGeneratedTiles: 1,
    }, {
      generateGovernedAnswer: async () => ({
        kind: 'no_answer',
        text: 'The query failed.',
        sql: 'SELECT missing_column FROM analytics.orders',
        executionError: 'Column missing_column was not found.',
        appBuilderRepair: {
          version: 1,
          status: 'failed',
          source: 'query_generator',
          attemptedAt: '2026-08-02T00:00:00.000Z',
          originalFailure: 'Column missing_column was not found.',
          approvalEligible: false,
          message: 'The bounded repair could not complete.',
        },
      } as never),
    });
    expect(failed.proposal?.tiles.find((tile) => tile.source === 'ai_generated')).toMatchObject({
      error: 'Column missing_column was not found.',
      preflight: { status: 'blocked' },
      repair: { status: 'failed', approvalEligible: false },
    });
  });

  it('keeps gaps as research questions when no provider is available and lists other failures transparently', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    // No provider configured → gaps stay research questions, no error-tile noise.
    const offline = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async () => {
        throw new Error('No AI provider is configured. Configure one in Settings.');
      },
    });
    expect(offline.status).toBe('proposed');
    expect(offline.proposal!.tiles.some((tile) => tile.error)).toBe(false);
    expect(offline.proposal!.gaps.length).toBeGreaterThan(0);

    // Provider failures cannot change the proposal because App Builder does not
    // use generated SQL as dashboard content.
    const failed = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async () => {
        throw new Error('model timed out');
      },
    });
    expect(failed.status).toBe('proposed');
    const errorTiles = failed.proposal!.tiles.filter((tile) => tile.error);
    expect(errorTiles).toEqual([]);
    expect(failed.proposal!.gaps.length).toBeGreaterThan(0);
  });

  it('proposes no certified tiles and writes no App when nothing certified matches (apps need a certified anchor)', async () => {
    const root = createProject();
    // No certified blocks in the project → the proposal has 0 certified tiles.
    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a leadership app about revenue with no certified coverage.',
      domain: 'revenue',
      owner: 'owner@local',
    });
    // Propose still succeeds (it can surface gaps), but with zero certified tiles.
    if (session.status === 'proposed') {
      expect(session.proposal!.coverage.certifiedTiles).toBe(0);
      const certifiedIds = session.proposal!.tiles.filter((tile) => tile.certification === 'certified').map((tile) => tile.id);
      expect(certifiedIds).toEqual([]);
    } else {
      // Or propose itself reports the coverage error — either way, no app is created.
      expect(session.status).toBe('error');
    }
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });

  it('survives the whole authoring round trip: build, rename, add a tile, reload (UI-017, E2E-016)', async () => {
    // The flow the user actually performs had no coverage at all, which is how
    // "cannot rename", "no save", and "add does not stick" all shipped together.
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue', domain: 'revenue', status: 'certified', tags: ['revenue'], description: 'Revenue KPI', chart: 'single_value',
    });

    // 1. Build from the AI plan, editing the brief on the way through.
    const session = await proposeAppAiBuild(root, { prompt: 'Build a revenue app for leadership.', domain: 'revenue', owner: 'owner@local' });
    expect(session.status).toBe('proposed');
    const plan = session.plan as AppPlan;
    const firstTileId = plan.pages[0].tiles.find((tile) => tile.kind === 'certified_block')!.id;
    const generated = await generateAppFromSessionPlan(root, session, {
      ...plan,
      name: 'Leadership Revenue',
      pages: plan.pages.map((page) => ({
        ...page,
        tiles: page.tiles.map((tile) => (tile.id === firstTileId ? { ...tile, title: 'Revenue right now' } : tile)),
      })),
    });
    const appId = plan.appId;
    const appPath = join(root, `apps/${appId}/dql.app.json`);
    const dashboardPath = join(root, generated.paths.find((path) => path.endsWith('.dqld'))!);

    // The brief's edits reached disk.
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).name).toBe('Leadership Revenue');
    const builtTitles = JSON.parse(readFileSync(dashboardPath, 'utf-8')).layout.items.map((item: { title?: string }) => item.title);
    expect(builtTitles).toContain('Revenue right now');

    // 2. Rename the App and the page after the build.
    const dashboardId = JSON.parse(readFileSync(dashboardPath, 'utf-8')).id;
    expect(renameApp(root, appId, { name: 'Exec Revenue' }).ok).toBe(true);
    expect(renameApp(root, appId, { pageTitle: 'Revenue Overview', dashboardId }).ok).toBe(true);

    // 3. Add an Ask result as a tile.
    const pinned = __test__.createAiPinTile(root, appId, {
      dashboardId,
      title: 'Revenue by region',
      answer: 'EMEA leads.',
      question: 'How does revenue split by region?',
      certification: 'ai_generated',
      reviewStatus: 'needs_review',
      result: { columns: ['region', 'revenue'], rows: [{ region: 'EMEA', revenue: 900 }], rowCount: 1 },
    });
    expect(pinned.ok).toBe(true);

    // 4. Reload from disk: every change survived, and nothing clobbered anything else.
    const app = JSON.parse(readFileSync(appPath, 'utf-8'));
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    expect(app.name).toBe('Exec Revenue');
    expect(app.id).toBe(appId);
    expect(dashboard.metadata.title).toBe('Revenue Overview');
    const titles = dashboard.layout.items.map((item: { title?: string }) => item.title);
    expect(titles).toContain('Revenue right now');
    expect(titles).toContain('Revenue by region');
    // The pin is a real tile on the page, not only a SQLite row.
    expect(dashboard.layout.items.some((item: { aiPin?: unknown }) => Boolean(item.aiPin))).toBe(true);
  });

  it('renames an App and a page on disk without moving the App id (UI-017)', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue', domain: 'revenue', status: 'certified', tags: ['revenue'], description: 'Revenue KPI', chart: 'single_value',
    });
    const created = createAppPackage(root, {
      name: 'Revenue App', domain: 'revenue', dashboardTitle: 'Overview', selectedBlockIds: ['Total Revenue'], owners: ['owner@local'],
    });
    expect(created.ok).toBe(true);
    const appPath = join(root, 'apps/revenue-app/dql.app.json');
    const dashboardPath = join(root, 'apps/revenue-app/dashboards/overview.dqld');

    const renamed = renameApp(root, 'revenue-app', { name: 'Executive Revenue' });
    expect(renamed.ok).toBe(true);
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).name).toBe('Executive Revenue');
    // The id is also the folder name and is referenced by deep links, so a
    // rename must never move the package.
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).id).toBe('revenue-app');
    expect(existsSync(join(root, 'apps/revenue-app'))).toBe(true);

    const pageRenamed = renameApp(root, 'revenue-app', { pageTitle: 'Revenue Overview', dashboardId: 'overview' });
    expect(pageRenamed.ok).toBe(true);
    expect(JSON.parse(readFileSync(dashboardPath, 'utf-8')).metadata.title).toBe('Revenue Overview');

    // A stale fingerprint must not clobber a concurrent edit.
    const stale = renameApp(root, 'revenue-app', { name: 'Nope', expectedFingerprint: 'sha256:stale' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('APP_CHANGED');
    expect(JSON.parse(readFileSync(appPath, 'utf-8')).name).toBe('Executive Revenue');

    expect(renameApp(root, 'missing-app', { name: 'X' }).ok).toBe(false);
    // Nothing to change is a request error, not a silent success.
    expect(renameApp(root, 'revenue-app', {}).ok).toBe(false);
  });

  it('proposes an AI page for an existing App without rewriting its content (API-009, UI-017)', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue', domain: 'revenue', status: 'certified', tags: ['revenue'], description: 'Revenue KPI', chart: 'single_value',
    });
    const created = createAppPackage(root, {
      name: 'Revenue App', domain: 'revenue', dashboardTitle: 'Overview', selectedBlockIds: ['Total Revenue'], owners: ['owner@local'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const appPath = join(root, 'apps/revenue-app/dql.app.json');
    const originalDashboardPath = join(root, 'apps/revenue-app/dashboards/overview.dqld');
    const originalAppSource = readFileSync(appPath, 'utf-8');
    const originalDashboardSource = readFileSync(originalDashboardPath, 'utf-8');

    const session = await proposeAppAiBuild(root, {
      prompt: 'Add a revenue driver page for leadership', existingAppId: 'revenue-app',
    });
    expect(session.status).toBe('proposed');
    expect(session.appId).toBe('revenue-app');
    expect(session.dashboardId).not.toBe('overview');
    expect(readFileSync(appPath, 'utf-8')).toBe(originalAppSource);
    expect(readFileSync(originalDashboardPath, 'utf-8')).toBe(originalDashboardSource);
  });

  it('returns a research proposal without creating an investigation when context is required', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    const result = await __test__.askAppQuestion({
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    }, 'nba-performance', {
      question: 'Why did the top scorer change between seasons?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      runInvestigation: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route).toBe('investigation');
    expect(result.investigation).toBeUndefined();
    expect(result.answer).toContain('Add the comparison, filters, timeframe, and decision context');
    expect(result.followUps).toEqual(expect.arrayContaining(['Add analysis context', 'Create saved query draft']));
    expect(result.decision).toMatchObject({
      mode: 'analysis',
      requiresContext: true,
      usesCertifiedResult: true,
    });
    expect(result.decision.reason).toContain('changed');
    expect(result.proposal).toMatchObject({
      type: 'research_investigation',
      requiredContext: true,
      reviewRequired: true,
      blockId: 'Top Scorers',
    });
  });

  it('fails App Copilot closed when the active persona belongs to another App', async () => {
    const root = createProject();
    const first = createAppPackage(root, { name: 'Revenue App', domain: 'revenue', dashboardTitle: 'Revenue', owners: ['owner@local'], selectedBlockIds: [] });
    const second = createAppPackage(root, { name: 'Growth App', domain: 'growth', dashboardTitle: 'Growth', owners: ['owner@local'], selectedBlockIds: [] });
    expect(first.ok && second.ok).toBe(true);
    defaultPersonaRegistry.set({ userId: 'owner@local', roles: ['owner'], attributes: {}, rlsContext: {}, appId: 'growth-app' });
    const result = await __test__.askAppQuestion({
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/revenue-app/ask'), path: '/api/apps/revenue-app/ask',
    }, 'revenue-app', { question: 'What changed?' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/active persona belongs to App "growth-app"/);
  });

  it('APP-066 routes a Dataset chart question only through server-issued current run context', async () => {
    const root = createProject();
    const appResult = createAppPackage(root, {
      name: 'Commerce App', domain: 'commerce', dashboardTitle: 'Overview', owners: ['owner@local'], selectedBlockIds: [],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    const calls: unknown[] = [];
    const context = {
      version: 1 as const,
      appId: 'commerce-app', dashboardId: 'overview', tileId: 'revenue', runId: 'run-current', evidenceScope: 'full_dashboard' as const,
      snapshotId: 'snapshot-current', dashboardFingerprint: 'sha256:dashboard',
      source: { sourceId: 'source.orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract', lifecycle: 'certified', trust: 'certified' },
      authoredQuery: { dimensions: [], measures: [{ measure: 'revenue' }] }, authoredQueryFingerprint: 'sha256:authored',
      executionQueryFingerprint: 'sha256:query', filterFingerprint: 'sha256:filters', parameterFingerprint: 'sha256:params', interactionFingerprint: 'sha256:interaction', executionFingerprint: 'sha256:execution', resultFingerprint: 'sha256:result', schemaFingerprint: 'sha256:schema', personaPolicyFingerprint: 'sha256:persona',
      effectiveFilters: { region: 'CA' }, appliedFilters: [{ field: 'region', op: 'eq' as const, values: ['CA'], placement: 'where' as const }], unboundFilters: [],
      result: { columns: ['revenue'], rows: [{ revenue: 60 }], rowCount: 1 },
    };
    const result = await __test__.askAppQuestion({
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/commerce-app/ask'), path: '/api/apps/commerce-app/ask',
      planResearch: async () => { throw new Error('chart questions must not route to generic research'); },
      answerDatasetChart: async (input: unknown) => {
        calls.push(input);
        return {
          ok: true as const,
          answer: 'Revenue is 60 for Region = CA.',
          answerMode: 'provider' as const,
          trustState: 'certified' as const,
          reviewStatus: 'certified' as const,
          citations: [{ kind: 'dataset_query', name: 'Orders Dataset' }],
          followUps: ['Rerun the chart before asking again after changes'],
          context,
        };
      },
    }, 'commerce-app', {
      question: 'What does this chart show?', dashboardId: 'overview', tileId: 'revenue', runId: 'run-current',
      variables: { region: 'US' }, context: { rows: [{ revenue: 130 }], trust: 'browser-claimed' },
    });

    expect(calls).toEqual([{
      appId: 'commerce-app', dashboardId: 'overview', tileId: 'revenue', runId: 'run-current', question: 'What does this chart show?',
    }]);
    expect(result).toMatchObject({
      ok: true, route: 'dataset_chart_answer', answer: 'Revenue is 60 for Region = CA.', answerMode: 'provider',
      trustState: 'certified', analyticalContext: { source: { sourceRevision: 'sha256:source' }, effectiveFilters: { region: 'CA' } },
    });

    const stale = await __test__.askAppQuestion({
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/commerce-app/ask'), path: '/api/apps/commerce-app/ask',
      answerDatasetChart: async () => ({ ok: false as const, error: 'The Dataset source changed after this chart ran. Run the current chart again.' }),
    }, 'commerce-app', {
      question: 'What does this chart show?', dashboardId: 'overview', tileId: 'revenue', runId: 'run-current',
    });
    expect(stale).toEqual({ ok: false, error: 'The Dataset source changed after this chart ran. Run the current chart again.' });
  });

  it('routes an OFF-tile question through the governed answer loop, not the focused tile', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers', domain: 'nba', status: 'certified', tags: ['nba'],
      description: 'Top NBA player scoring output', chart: 'bar',
      query: 'SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance', domain: 'nba', dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'], owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    expect(createDashboardForApp(root, 'nba-performance', { id: 'team-view', title: 'Team View' }).ok).toBe(true);

    let governedCalls = 0;
    let receivedAppContext: unknown;
    const ctx = {
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
      // Governed loop returns a DIFFERENT answer than the focused-tile narration.
      generateGovernedAnswer: async (_q: string, appContext?: unknown) => {
        governedCalls += 1;
        receivedAppContext = appContext;
        return {
          kind: 'uncertified', certification: 'ai_generated', reviewStatus: 'draft_ready',
          text: 'Assists leader: Chris Paul with 892 assists.',
          answer: 'Assists leader: Chris Paul with 892 assists.',
          citations: [{ kind: 'block', name: 'assists_by_player' }],
        } as any;
      },
    };

    // A tile is focused ("Top Scorers"), but the question is about a different metric.
    const result = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'who are the players with the most assists?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(governedCalls).toBe(1);
    expect(result.route).toBe('generated_answer');
    expect(result.answer).toContain('Chris Paul');
    expect(result.trustState).toBe('review_required');
    expect(receivedAppContext).toMatchObject({
      version: 1,
      app: { id: 'nba-performance', domain: 'nba' },
      focus: { dashboardId: 'nba-overview', blockId: 'Top Scorers' },
      dashboards: expect.arrayContaining([
        expect.objectContaining({ id: 'nba-overview', tiles: expect.arrayContaining([expect.objectContaining({ blockId: 'Top Scorers' })]) }),
        expect.objectContaining({ id: 'team-view' }),
      ]),
    });
  });

  it('narrates the focused tile ONLY for questions about it, without calling the governed loop', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers', domain: 'nba', status: 'certified', tags: ['nba'],
      description: 'Top NBA player scoring output', chart: 'bar',
      query: 'SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance', domain: 'nba', dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'], owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    let governedCalls = 0;
    const ctx = {
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
      generateGovernedAnswer: async (_q: string) => { governedCalls += 1; return { kind: 'no_answer', text: '' } as any; },
    };

    const result = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'explain this result',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(governedCalls).toBe(0);
    expect(result.route).toBe('certified_answer');
  });

  it('reuses an existing App report for the same follow-up question and context', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance`,
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    const ctx = {
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    };
    const selectedContext = {
      activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5',
      selectedBlock: {
        blockId: 'Top Scorers',
        blockPath: 'blocks/nba/top-scorers.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'total_points'],
        resultSample: [
          { player_name: 'Grant Jerrett', total_points: 1179 },
          { player_name: 'Gary Harris', total_points: 418 },
        ],
      },
    };

    const first = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'Why is the scorer table concentrated?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: selectedContext,
    });
    const second = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'Why is the scorer table concentrated?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: {
        selectedBlock: selectedContext.selectedBlock,
        activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5',
      },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.investigation?.id).toBe(second.investigation?.id);
    expect(first.investigation?.evidence).toMatchObject({
      routeDecision: {
        mode: 'analysis',
        requiresContext: true,
        usesCertifiedResult: true,
      },
      planner: {
        routeDecision: {
          mode: 'analysis',
        },
      },
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      expect(storage.listAppInvestigations('nba-performance')).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  it('routes simple tile questions to certified answers with an explicit decision contract', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance`,
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    const result = await __test__.askAppQuestion({
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    }, 'nba-performance', {
      question: 'Explain the visible scorer result for executives.',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: {
        selectedBlock: {
          blockId: 'Top Scorers',
          title: 'Top Scorers',
          certificationStatus: 'certified',
          columns: ['player_name', 'total_points'],
          sampleRows: [
            { player_name: 'Grant Jerrett', total_points: 1179 },
            { player_name: 'Gary Harris', total_points: 418 },
          ],
        },
      },
      runInvestigation: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route).toBe('certified_answer');
    expect(result.decision).toMatchObject({
      mode: 'answer',
      requiresContext: false,
      usesCertifiedResult: true,
    });
    expect(result.decision.reason).toContain('selected certified result');
    expect(result.answer).toContain('Trusted source');
  });

  it('recommends governed visualization metadata from result shape and block hints', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });

    const result = recommendVisualization(root, {
      blockRef: 'Top Scorers',
      prompt: 'Show top NBA players by points',
      resultSchema: { columns: [{ name: 'player_name', type: 'string' }, { name: 'total_points', type: 'number' }] },
      rowSample: [{ player_name: 'Grant Jerrett', total_points: 357 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display).toMatchObject({
      mode: 'block_hint',
      component: 'RankingPanel',
      defaultVisualization: 'bar',
      trustState: 'certified',
      reviewStatus: 'certified',
      fieldHints: { label: 'player_name', value: 'total_points' },
    });
    expect(result.evidence.some((entry) => entry.source.endsWith('nba/top-scorers.dql'))).toBe(true);
  });

  it('replaces an incompatible model bar preference with a time-series visualization', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      prompt: 'How has revenue changed by month?',
      defaultVisualization: 'bar',
      resultSchema: { columns: [{ name: 'month', type: 'date' }, { name: 'revenue', type: 'number' }] },
      rowSample: [{ month: '2026-01-01', revenue: 100 }, { month: '2026-02-01', revenue: 120 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.defaultVisualization).toBe('line');
    expect(result.warnings).toContain('Preferred visualization bar did not fit the returned result shape; using line instead.');
  });

  it('selects Sankey for a source-to-target flow and binds all three fields', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      prompt: 'Show revenue flow from product category to product as a supply-chain Sankey',
      resultSchema: { columns: [
        { name: 'product_category', type: 'string' },
        { name: 'product_name', type: 'string' },
        { name: 'product_revenue', type: 'number' },
      ] },
      rowSample: [
        { product_category: 'Beverage', product_name: 'Coffee', product_revenue: 1200.5 },
        { product_category: 'Beverage', product_name: 'Tea', product_revenue: 900 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.defaultVisualization).toBe('sankey');
    expect(result.display.component).toBe('EvidenceTable');
    expect(result.display.fieldHints).toMatchObject({
      source: 'product_category',
      target: 'product_name',
      value: 'product_revenue',
      x: 'product_category',
      y: 'product_revenue',
      color: 'product_name',
      format: 'currency',
    });
  });

  it('binds Sankey fields in the order named by the question and ignores unrelated dimensions', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      prompt: 'Show revenue by product type and product name as a source-to-target flow.',
      resultSchema: { columns: [
        { name: 'product_name', type: 'string' },
        { name: 'customer_type', type: 'string' },
        { name: 'product_type', type: 'string' },
        { name: 'revenue', type: 'number' },
      ] },
      rowSample: [{ product_name: 'Coffee', customer_type: 'new', product_type: 'Beverage', revenue: 1200.5 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.defaultVisualization).toBe('sankey');
    expect(result.display.fieldHints).toMatchObject({
      source: 'product_type',
      target: 'product_name',
      value: 'revenue',
      x: 'product_type',
      color: 'product_name',
    });
  });

  it('uses question intent to choose composition, correlation, and multi-measure charts', () => {
    const root = createProject();
    const composition = recommendVisualization(root, {
      prompt: 'Show revenue share by category',
      resultSchema: { columns: ['category', 'revenue'] },
      rowSample: [{ category: 'A', revenue: 60 }, { category: 'B', revenue: 40 }],
    });
    const correlation = recommendVisualization(root, {
      prompt: 'Show the relationship between discount and revenue',
      resultSchema: { columns: ['discount', 'revenue'] },
      rowSample: [{ discount: 5, revenue: 100 }, { discount: 10, revenue: 80 }],
    });
    const comparison = recommendVisualization(root, {
      prompt: 'Compare customers',
      resultSchema: { columns: ['customer_name', 'revenue', 'order_count'] },
      rowSample: [{ customer_name: 'A', revenue: 100, order_count: 2 }],
    });

    expect(composition.ok && composition.display.defaultVisualization).toBe('donut');
    expect(correlation.ok && correlation.display.defaultVisualization).toBe('scatter');
    expect(comparison.ok && comparison.display.defaultVisualization).toBe('grouped_bar');
  });

  it('recommends dashboard tile metadata with filter bindings and source evidence', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      filterBindings: [{ filter: 'season', binding: 'game_date_est' }],
    });
    const app = createAppPackage(root, {
      name: 'NBA App',
      domain: 'nba',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: ['Top Scorers'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const result = recommendDashboardTile(root, 'nba-app', 'overview', {
      blockRef: 'Top Scorers',
      prompt: 'Top scorers by season',
      resultSchema: { columns: [{ name: 'player_name', type: 'string' }, { name: 'total_points', type: 'number' }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.trustState).toBe('certified');
    expect(result.filterBindings).toEqual([{ filter: 'season', binding: 'game_date_est', mode: 'predicate' }]);
    expect(result.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'block:Top Scorers', trustState: 'certified' }),
    ]));
  });

  it('promotes app files to review-ready shared artifacts and strips local AI pin tiles', () => {
    const root = createProject();
    const app = createAppPackage(root, {
      name: 'NBA App',
      domain: 'nba',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    const dashboardPath = join(root, 'apps/nba-app/dashboards/overview.dqld');
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    dashboard.layout.items.push({
      i: 'pin',
      x: 0, y: 0, w: 6, h: 3,
      aiPin: { id: 'pin_1' },
      viz: { type: 'text' },
      title: 'AI summary',
      display: {
        mode: 'ai_generated',
        component: 'NarrativePanel',
        defaultVisualization: 'text',
        allowedVisualizations: ['text'],
        layoutIntent: 'standard',
        rationale: 'local pin',
        trustState: 'review_required',
        reviewStatus: 'review_required',
      },
    });
    writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

    const result = promoteAppForStakeholders(root, 'nba-app');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedLocalTiles).toBe(1);
    const promotedApp = JSON.parse(readFileSync(join(root, 'apps/nba-app/dql.app.json'), 'utf-8'));
    const promotedDashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    expect(promotedApp.visibility).toBe('shared');
    expect(promotedApp.lifecycle).toBe('review');
    expect(promotedDashboard.layout.items).toHaveLength(0);
    expect(promotedDashboard.metadata.lifecycle).toBe('review');
  });

  it('records who certified an App and when, drops it on any other lifecycle, and lists it with the last update (D5, D6)', () => {
    const root = createProject();
    const app = createAppPackage(root, { name: 'Certified App', domain: 'revenue', owners: ['owner@local'], tags: [], selectedBlockIds: [] });
    expect(app.ok).toBe(true);
    const appPath = join(root, 'apps/certified-app/dql.app.json');

    const certified = promoteAppForStakeholders(root, 'certified-app', { lifecycle: 'certified' });
    expect(certified.ok).toBe(true);
    const written = JSON.parse(readFileSync(appPath, 'utf-8'));
    expect(written).toMatchObject({ lifecycle: 'certified', certifiedBy: expect.any(String), certifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(written.certifiedBy.trim()).not.toBe('');
    const listed = __test__.collectAppsList(root).find((entry) => entry.id === 'certified-app')!;
    expect(listed).toMatchObject({ certification: 'certified', certifiedBy: written.certifiedBy, certifiedAt: written.certifiedAt, updatedAt: expect.stringMatching(/^\d{4}-/) });

    const reviewed = promoteAppForStakeholders(root, 'certified-app', { lifecycle: 'review' });
    expect(reviewed.ok).toBe(true);
    const after = JSON.parse(readFileSync(appPath, 'utf-8'));
    expect(after.lifecycle).toBe('review');
    expect(after.certifiedBy).toBeUndefined();
    expect(after.certifiedAt).toBeUndefined();
  });

  it('blocks shared publication while an app contains exploratory draft analysis', () => {
    const root = createProject();
    const app = createAppPackage(root, {
      name: 'Exploration App',
      domain: 'revenue',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    const appPath = join(root, 'apps/exploration-app/dql.app.json');
    const beforeManifest = readFileSync(appPath, 'utf-8');
    const dashboardPath = join(root, 'apps/exploration-app/dashboards/overview.dqld');
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    dashboard.layout.items.push({
      i: 'draft-driver', x: 0, y: 0, w: 6, h: 3,
      draftAnalysis: { ref: 'drafts/draft-driver.dql', artifactFingerprint: 'sha256:draft' },
      viz: { type: 'bar' },
      sourceClass: 'exploratory_analysis',
      review: { status: 'required', sourceFingerprint: 'sha256:draft' },
      trustState: 'review_required',
      reviewStatus: 'review_required',
    });
    writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

    const result = promoteAppForStakeholders(root, 'exploration-app');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.readiness?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'exploratory_source', tileId: 'draft-driver' }),
    ]));
    expect(readFileSync(appPath, 'utf-8')).toBe(beforeManifest);
  });

  it('publishes semantic Apps only after snapshot-bound run approval', () => {
    const root = createProject();
    const app = createAppPackage(root, {
      name: 'Semantic App', domain: 'revenue', owners: ['owner@local'], tags: [], selectedBlockIds: [],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    const dashboardPath = join(root, 'apps/semantic-app/dashboards/overview.dqld');
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    dashboard.layout.items.push({
      i: 'semantic-revenue', x: 0, y: 0, w: 6, h: 3,
      semantic: {
        id: 'semantic-revenue', provider: 'metricflow', metrics: ['revenue'], semanticModelRefs: ['orders'],
        qualifiedMetricIds: ['metric:revenue'], qualifiedModelIds: ['semantic_model:orders'],
        resolvedPlanFingerprint: 'sha256:plan', definitionFingerprint: 'sha256:definition', snapshotId: 'proposal-snapshot',
      },
      viz: { type: 'single_value' },
      sourceClass: 'governed_semantic',
      review: { status: 'required', sourceFingerprint: 'sha256:definition' },
      trustState: 'review_required', reviewStatus: 'review_required',
    });
    writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

    const blocked = promoteAppForStakeholders(root, 'semantic-app');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.readiness?.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(['semantic_review', 'semantic_preflight']));

    const loaded = loadDashboardDocument(dashboardPath).document!;
    const expectedDashboardFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(loaded)).digest('hex')}`;
    const approved = approveAppSemanticTiles(root, 'semantic-app', 'overview', {
      tileIds: ['semantic-revenue'], runId: 'app_run_verified', snapshotId: 'execution-snapshot',
      expectedDashboardFingerprint, reviewer: 'analyst@local',
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.dashboard.layout.items[0]).toMatchObject({
      semantic: { snapshotId: 'execution-snapshot' },
      review: { status: 'approved', preflightReceiptId: 'app_run_verified', reviewedBy: 'analyst@local' },
    });

    const published = promoteAppForStakeholders(root, 'semantic-app');
    expect(published.ok).toBe(true);
  });

  it('rejects unsupported governed visualization combinations', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      component: 'KpiMetric',
      defaultVisualization: 'scatter',
      resultSchema: { columns: ['x', 'y'] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('KpiMetric cannot use scatter');
  });

  it('builds selected-block SQL for review-required driver research', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `-- Imported analyst SQL with comments should still be eligible for read-only research.
SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });

    const generated = __test__.buildDeterministicInvestigationSql(root, {
      question: 'Break this down by player driver.',
      intent: 'driver_breakdown',
      sourceBlockId: 'Top Scorers',
      selected: {
        blockId: 'Top Scorers',
        blockPath: 'blocks/nba/top-scorers.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'season', 'total_points'],
        resultSample: [
          { player_name: 'Stephen Curry', season: '2025', total_points: 325 },
          { player_name: 'LeBron James', season: '2025', total_points: 302 },
        ],
      },
    });

    expect(generated).toBeDefined();
    if (!generated) return;
    expect(generated.sourceBlockPath).toBe('blocks/nba/top-scorers.dql');
    expect(generated.sourceBlockName).toBe('Top Scorers');
    expect(generated.sql).toContain('WITH dql_source AS');
    expect(generated.sql).toContain('FROM NBA_GAMES.RAW.fct_player_performance');
    expect(generated.sql).not.toContain('ORDER BY total_points DESC');
    expect(generated.sql).not.toContain('LIMIT 10');
    expect(generated.sql).toContain('GROUP BY "player_name"');
    expect(generated.sql).toContain('SUM("total_points") AS "total_points"');
    expect(generated.sql).toContain('LIMIT 20');
  });

  it('renders block parameters from app filters and defaults before building investigation SQL', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers-parameterized.dql', {
      name: 'Top Scorers Parameterized',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring', 'parameterized'],
      description: 'Reusable top NBA scorer block with season and top-N parameters',
      chart: 'bar',
      params: {
        season_start: 2015,
        season_end: 2015,
        top_n: 5,
      },
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
WHERE season BETWEEN \${season_start} AND \${season_end}
  AND player_rank <= \${top_n}`,
    });

    const generated = __test__.buildDeterministicInvestigationSql(root, {
      question: 'Break this down by player driver.',
      intent: 'driver_breakdown',
      sourceBlockId: 'Top Scorers Parameterized',
      context: {
        activeFilters: {
          season_start: 2016,
          season_end: 2017,
        },
      },
      selected: {
        blockId: 'Top Scorers Parameterized',
        blockPath: 'blocks/nba/top-scorers-parameterized.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'season', 'total_points'],
        resultSample: [
          { player_name: 'Grant Jerrett', season: 2017, total_points: 1179 },
          { player_name: 'Gary Harris', season: 2017, total_points: 418 },
        ],
      },
    });

    expect(generated).toBeDefined();
    if (!generated) return;
    expect(generated.sql).not.toContain('${');
    expect(generated.sql).toContain('season BETWEEN 2016 AND 2017');
    expect(generated.sql).toContain('player_rank <= 5');
    expect(generated.sql).toContain('GROUP BY "player_name"');
  });

  it('rebuilds failed report SQL from certified block context without certifying the report', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    const executedSql: string[] = [];
    try {
      const investigation = storage.createAppInvestigation({
        appId: 'nba-app',
        dashboardId: 'overview',
        sourceBlockId: 'Top Scorers',
        question: 'Break this down by player driver.',
        intent: 'driver_breakdown',
        generatedSql: 'SELECT * FROM missing_table',
        context: {
          blockId: 'Top Scorers',
          blockPath: 'blocks/nba/top-scorers.dql',
          certificationStatus: 'certified',
          selectedBlock: {
            blockId: 'Top Scorers',
            blockPath: 'blocks/nba/top-scorers.dql',
            certificationStatus: 'certified',
            columns: ['player_name', 'season', 'total_points'],
            resultSample: [
              { player_name: 'Grant Jerrett', season: '2017', total_points: 1179 },
              { player_name: 'Gary Harris', season: '2017', total_points: 418 },
            ],
          },
        },
      });

      const rebuilt = await __test__.runAppInvestigation({
        projectRoot: root,
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/nba-app/investigations/run'),
        path: '/api/apps/nba-app/investigations/run',
        executeSql: async (sql: string) => {
          executedSql.push(sql);
          return {
            columns: ['player_name', 'total_points', 'row_count'],
            rows: [
              { player_name: 'Grant Jerrett', total_points: 1179, row_count: 1 },
              { player_name: 'Gary Harris', total_points: 418, row_count: 1 },
            ],
          };
        },
      }, storage, investigation, { repairMode: 'rebuild_from_certified' });

      expect(rebuilt.generatedSql).toContain('FROM NBA_GAMES.RAW.fct_player_performance');
      expect(rebuilt.generatedSql).not.toContain('missing_table');
      expect(rebuilt.status).toBe('ready');
      expect(rebuilt.reviewStatus).toBe('needs_review');
      expect(rebuilt.error).toBeUndefined();
      expect(executedSql[0]).toContain('dql_research_preview');
      expect((rebuilt.evidence as any).planner.repairMode).toBe('rebuild_from_certified');
      expect((rebuilt.evidence as any).planner.generationSource).toBe('selected_block_metadata');
    } finally {
      storage.close();
    }
  });

  it('uses provider memo generation after deterministic SQL preview evidence is available', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    const memoRequests: any[] = [];
    try {
      const investigation = storage.createAppInvestigation({
        appId: 'nba-app',
        dashboardId: 'overview',
        sourceBlockId: 'Top Scorers',
        question: 'Why did the top player change?',
        intent: 'driver_breakdown',
        context: {
          blockId: 'Top Scorers',
          blockPath: 'blocks/nba/top-scorers.dql',
          certificationStatus: 'certified',
          selectedBlock: {
            blockId: 'Top Scorers',
            blockPath: 'blocks/nba/top-scorers.dql',
            certificationStatus: 'certified',
            columns: ['player_name', 'season', 'total_points'],
            resultSample: [
              { player_name: 'Grant Jerrett', season: '2017', total_points: 1179 },
              { player_name: 'Gary Harris', season: '2017', total_points: 418 },
            ],
          },
        },
      });

      const updated = await __test__.runAppInvestigation({
        projectRoot: root,
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/nba-app/investigations/run'),
        path: '/api/apps/nba-app/investigations/run',
        executeSql: async () => ({
          columns: ['player_name', 'total_points', 'row_count'],
          rows: [
            { player_name: 'Grant Jerrett', total_points: 1179, row_count: 1 },
            { player_name: 'Gary Harris', total_points: 418, row_count: 1 },
          ],
        }),
        generateInvestigationSql: async (input) => {
          memoRequests.push(input);
          return {
            providerUsed: 'mock-provider',
            answer: `## Executive answer
Grant Jerrett leads the current scoring result with 1,179 points, ahead of Gary Harris at 418.

## Business readout
- Grant Jerrett: 1,179 points
- Gary Harris: 418 points

The stakeholder story should focus on scorer concentration while a reviewer confirms the season filter and player grain.

## Next action
Validate the scorer window, then pin this memo or draft a reusable DQL block.`,
            evidence: { source: 'mock memo provider' },
            citations: [{ kind: 'block', name: 'Top Scorers' }],
          };
        },
      }, storage, investigation);

      expect(memoRequests).toHaveLength(1);
      expect(memoRequests[0].mode).toBe('memo_only');
      expect(memoRequests[0].generatedSql).toContain('WITH dql_source AS');
      expect(memoRequests[0].metrics.currentValue).toBe(1597);
      expect(memoRequests[0].resultPreviews.length).toBeGreaterThan(0);
      expect(updated.summary).toContain('Grant Jerrett leads');
      expect(updated.reportSections?.map((section) => section.title)).toEqual(expect.arrayContaining([
        'Executive answer',
        'Business readout',
        'Next action',
      ]));
      expect((updated.evidence as any).planner.generationSource).toBe('selected_block_metadata');
      expect((updated.evidence as any).planner.memoSource).toBe('ai_provider');
      expect((updated.evidence as any).planner.memoProviderUsed).toBe('mock-provider');
      expect(updated.reviewStatus).toBe('needs_review');
    } finally {
      storage.close();
    }
  });

  it('reports unresolved generated SQL parameters before preview execution', () => {
    const rendered = __test__.renderSqlTemplateParams(
      'SELECT * FROM scores WHERE season = ${season} LIMIT ${top_n}',
      { season: 2017 },
    );

    expect(rendered.sql).toContain('season = 2017');
    expect(rendered.unresolved).toEqual(['top_n']);
    expect(__test__.unresolvedSqlTemplateParams(rendered.sql)).toEqual(['top_n']);
  });

  it('ranks research driver cards by business measures before row counts', () => {
    const preview = {
      result: {
        columns: ['PLAYER_NAME', 'TOTAL_POINTS', 'row_count'],
        rows: [
          { PLAYER_NAME: 'LeBron James', TOTAL_POINTS: 14473, row_count: 11 },
          { PLAYER_NAME: 'James Harden', TOTAL_POINTS: 14464, row_count: 11 },
        ],
      },
    };

    const cards = __test__.buildPreviewDriverCards(preview, 'driver_breakdown');
    const metric = __test__.buildPreviewMetricSnapshot(preview, 'Top 10 Goal Scorers');

    expect(cards[0]).toMatchObject({
      title: 'LeBron James',
      value: 14473,
      evidenceLabel: 'TOTAL_POINTS',
    });
    expect(metric).toMatchObject({
      metric: 'TOTAL_POINTS',
      currentValue: 28937,
    });
  });

  it('summarizes selected ranked tile metrics as top value, next comparison, and gap', () => {
    const metric = __test__.buildMetricSnapshot({
      title: 'Top scorers',
      columns: ['PLAYER_NAME', 'TOTAL_POINTS', 'GAMES_PLAYED'],
      sampleRows: [
        { PLAYER_NAME: 'Grant Jerrett', TOTAL_POINTS: 1179, GAMES_PLAYED: 68 },
        { PLAYER_NAME: 'Gary Harris', TOTAL_POINTS: 418, GAMES_PLAYED: 58 },
        { PLAYER_NAME: 'Emmanuel Mudiay', TOTAL_POINTS: 348, GAMES_PLAYED: 56 },
      ],
    });

    expect(metric).toMatchObject({
      metric: 'TOTAL_POINTS',
      currentLabel: 'Top value',
      currentValue: 1179,
      currentDetail: 'Grant Jerrett / TOTAL_POINTS',
      baselineLabel: 'Next comparison',
      baselineValue: 418,
      baselineDetail: 'Gary Harris / TOTAL_POINTS',
      deltaLabel: 'Top gap',
      delta: 761,
      deltaDetail: 'difference between Grant Jerrett and Gary Harris',
      rowsReviewed: 3,
    });
  });

  it('writes app research summaries with concrete ranked values instead of generic process text', () => {
    const summary = __test__.buildInvestigationSummary(
      'driver_breakdown',
      'Why did the top scorer change?',
      { title: 'Top scorers' },
      {
        metric: 'TOTAL_POINTS',
        currentValue: 1179,
        baselineValue: 418,
        delta: 761,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
        baselineDetail: 'Gary Harris / TOTAL_POINTS',
      },
      [{ title: 'Grant Jerrett' }],
    );

    expect(summary).toContain('Grant Jerrett leads on TOTAL_POINTS with 1,179');
    expect(summary).toContain('versus 418 for Gary Harris');
    expect(summary).toContain('gap of 761');
    expect(summary).toContain('review-required until SQL, grain, filters, and lineage are confirmed');
    expect(summary).not.toContain('this review-required analysis answers');
  });

  it('builds governed app report sections from ranked preview proof', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'driver_breakdown',
      question: 'Why is the scorer table concentrated?',
      context: { actionMode: 'research' },
      selected: {
        title: 'Top scorers',
        blockId: 'Top Scorers',
        tileId: 'top-scorers-tile',
      },
      metrics: {
        metric: 'TOTAL_POINTS',
        currentLabel: 'Top value',
        currentValue: 1179,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
        baselineLabel: 'Next comparison',
        baselineValue: 418,
        baselineDetail: 'Gary Harris / TOTAL_POINTS',
        deltaLabel: 'Top gap',
        delta: 761,
        deltaDetail: 'difference between Grant Jerrett and Gary Harris',
      },
      drivers: [
        { title: 'Grant Jerrett', contribution: '+1,179' },
        { title: 'Gary Harris', contribution: '+418' },
      ],
      summary: 'Grant Jerrett leads on TOTAL_POINTS with 1,179 versus 418 for Gary Harris, a gap of 761.',
      recommendation: 'Review the driver proof before promotion.',
    });

    expect(sections.map((section) => section.kind)).toEqual([
      'executive_answer',
      'business_interpretation',
      'key_numbers',
      'recommended_next_step',
      'review_boundary',
    ]);
    expect(sections[0].body).toContain('Grant Jerrett leads');
    expect(sections[1]).toMatchObject({ id: 'driver-readout', title: 'Driver readout' });
    expect(sections[1].body).toContain('Grant Jerrett is the strongest visible driver');
    expect(sections[2].bullets).toEqual(expect.arrayContaining([
      'Top value: 1,179 (Grant Jerrett / TOTAL_POINTS)',
      'Top gap: 761 (difference between Grant Jerrett and Gary Harris)',
    ]));
    expect(sections[2].body).toContain('bounded preview');
    expect(sections[4].body).toContain('source proof');
    expect(sections.map((section) => section.body).join('\n')).not.toMatch(/current evidence|source evidence|AI-generated research/i);
    expect(sections[0].evidenceRefs).toEqual(expect.arrayContaining(['block:Top Scorers', 'tile:top-scorers-tile']));
  });

  it('shapes report sections to the analyst intent instead of one fixed template', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare scoring by player segment',
      context: { actionMode: 'research', activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 3' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {
        metric: 'TOTAL_POINTS',
        currentLabel: 'Top value',
        currentValue: 1179,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
      },
      drivers: [{ title: 'Grant Jerrett', contribution: '+1,179' }],
      summary: 'Grant Jerrett is the top segment row.',
      recommendation: 'Confirm segment grouping before promotion.',
    });

    expect(sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      'Segment readout',
      'Segment numbers',
    ]));
    expect(sections.map((section) => section.title)).not.toContain('Analysis focus');
    expect(sections.find((section) => section.id === 'segment-readout')?.body).toContain('segment readout');
  });

  it('adds missing comparison and SQL repair sections only when needed', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'diagnose_change',
      question: 'Why did the top player change?',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {},
      drivers: [],
      summary: 'The selected result is current-state only.',
      recommendation: 'Add a prior-period block.',
      baselineGap: true,
      sqlError: 'invalid identifier PLAYER_ID',
      sqlErrorKind: 'sql_repair',
    });

    expect(sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'missing-comparison',
      'sql-repair-path',
    ]));
    expect(sections.find((section) => section.id === 'change-explanation')?.body).toContain('current-state answer');
    expect(sections.find((section) => section.id === 'sql-repair-path')?.body).toContain('edit the SQL');
  });

  it('classifies warehouse/runtime preview failures separately from SQL repair', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare top scorers',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {},
      drivers: [],
      summary: 'The report is based on selected dashboard context.',
      recommendation: 'Resume the warehouse and refresh.',
      sqlError: "Snowflake query failed: Warehouse 'COMPUTE_WH' is suspended.",
      sqlErrorKind: 'runtime_unavailable',
    });

    expect(sections.map((section) => section.id)).toContain('preview-unavailable');
    expect(sections.map((section) => section.id)).not.toContain('sql-repair-path');
    expect(sections.find((section) => section.id === 'preview-unavailable')?.body).toContain('warehouse or execution runtime is unavailable');
  });

  it('classifies AI SQL generation timeout separately from SQL preview timeout', () => {
    expect(__test__.classifySqlPreviewError('AI SQL generation timed out after 12s.')).toBe('ai_generation_timeout');
    expect(__test__.classifySqlPreviewError('Generated SQL preview timed out after 12s.')).toBe('timeout');

    const sections = __test__.buildInvestigationReportSections({
      intent: 'trust_gap_review',
      question: 'Validate the scorer gap',
      context: { actionMode: 'evidence' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'TOTAL_POINTS', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '+1,179' }],
      summary: 'Grant Jerrett leads the selected scorer result.',
      recommendation: 'Use certified evidence and retry SQL generation if deeper proof is needed.',
      hasReportEvidence: true,
      sqlError: 'AI SQL generation timed out after 12s. ZLens continued with deterministic app evidence and kept the analysis review-required.',
      sqlErrorKind: 'ai_generation_timeout',
    });

    expect(sections.map((section) => section.id)).toContain('ai-generation-timeout');
    expect(sections.map((section) => section.id)).not.toContain('preview-timeout');
    expect(sections.find((section) => section.id === 'ai-generation-timeout')?.body).toContain('certified app evidence only');
    expect(sections.find((section) => section.id === 'ai-generation-timeout')?.body).toContain('provide reviewed SQL');
    expect(sections.find((section) => section.id === 'recommended-next-step')?.body).not.toContain('Simplify the generated SQL');
  });

  it('keeps runtime preview failures out of the main report when selected evidence exists', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare top scorers',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'total_points', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '1179 points' }],
      summary: 'Grant Jerrett leads the selected scorer result.',
      recommendation: 'Use selected evidence and refresh the trace later.',
      hasReportEvidence: true,
      sqlError: "Snowflake query failed: Warehouse 'COMPUTE_WH' is suspended.",
      sqlErrorKind: 'runtime_unavailable',
    });

    expect(sections.map((section) => section.id)).not.toContain('preview-unavailable');
    expect(sections.find((section) => section.id === 'executive-answer')?.body).toContain('Grant Jerrett leads');
    expect(sections.find((section) => section.id === 'key-numbers')?.bullets?.join(' ')).toContain('1,179');
  });

  it('preserves provider-written Markdown report sections while keeping trace out of the main memo', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'diagnose_change',
      question: 'Why did the top player change?',
      context: { actionMode: 'research', activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'total_points', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '1179 points' }],
      summary: 'Fallback summary should not replace provider memo.',
      recommendation: 'Validate the scorer window before promotion.',
      agentAnswer: `## Executive answer
Grant Jerrett leads the selected scoring window because the current result is heavily concentrated in one player row.

## Driver story
- Grant Jerrett: 1,179 points
- Gary Harris: 418 points

The gap is large enough that stakeholders should review source grain before treating it as a player-performance conclusion.

## Caveats
The answer is review-required until SQL, filters, and lineage are validated.

## SQL
\`\`\`sql
SELECT * FROM hidden_trace
\`\`\``,
    });

    expect(sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      'Executive answer',
      'Driver story',
      'Caveats',
      'Review boundary',
    ]));
    expect(sections.find((section) => section.title === 'Driver story')?.bullets).toEqual([
      'Grant Jerrett: 1,179 points',
      'Gary Harris: 418 points',
    ]);
    expect(sections.map((section) => section.title)).not.toContain('SQL');
    expect(JSON.stringify(sections)).not.toContain('hidden_trace');
    expect(sections.find((section) => section.title === 'Executive answer')?.body).not.toContain('Fallback summary');
  });

  it('uses stakeholder report sections when pinning an app insight', () => {
    const answer = __test__.investigationNarrativeAnswer({
      id: 'inv_top_scorers',
      appId: 'nba-app',
      title: 'Top scorer research',
      question: 'Why did the top player change?',
      intent: 'driver_breakdown',
      status: 'ready',
      reviewStatus: 'needs_review',
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
      summary: 'Fallback summary should not be used.',
      recommendation: 'Fallback recommendation should not be used.',
      evidence: [],
      resultPreviews: [],
      driverCards: [],
      reportSections: [
        {
          id: 'executive-answer',
          kind: 'executive_answer',
          title: 'Executive answer',
          body: 'Grant Jerrett leads on total points in the selected period.',
          tone: 'answer',
          evidenceRefs: ['block:Top Scorers'],
        },
        {
          id: 'key-numbers',
          kind: 'key_numbers',
          title: 'Key numbers',
          body: 'The visible ranked result shows the following values.',
          tone: 'insight',
          bullets: ['Grant Jerrett: 1,179 points', 'Gary Harris: 418 points'],
        },
        {
          id: 'review-boundary',
          kind: 'review_boundary',
          title: 'Review boundary',
          body: 'This analysis is review-required until SQL and source proof are validated.',
          tone: 'review',
        },
      ],
    });

    expect(answer).toContain('## Executive answer');
    expect(answer).toContain('Grant Jerrett leads on total points');
    expect(answer).toContain('- Grant Jerrett: 1,179 points');
    expect(answer).not.toContain('Review boundary');
    expect(answer).not.toContain('_Evidence:');
    expect(answer).not.toContain('Fallback summary');
  });

  it('reuses matching pinned app insights instead of adding duplicate dashboard tiles', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['revenue'],
      description: 'Revenue KPI',
      chart: 'bar',
    });
    const app = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const input = {
      dashboardId: 'overview',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      sourceTier: 'metadata_research',
      certification: 'ai_generated' as const,
      reviewStatus: 'needs_review' as const,
      refreshCadence: 'none' as const,
      chartConfig: { chart: 'table' },
      result: {
        columns: ['account', 'revenue'],
        rows: [{ account: 'Acme', revenue: 1200 }],
        rowCount: 1,
      },
      analysisPlan: {
        sourceBlockId: 'Revenue Total',
        sourceTileId: 'revenue-total',
      },
    };

    const first = __test__.createAiPinTile(root, 'growth-cxo', input);
    const second = __test__.createAiPinTile(root, 'growth-cxo', input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.deduped).toBe(true);
    expect((second.pin as { id: string }).id).toBe((first.pin as { id: string }).id);
    const dashboard = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.layout.items.filter((item: { aiPin?: unknown }) => Boolean(item.aiPin))).toHaveLength(1);
  });

  it('preserves transient DQL parameters when adding a review-required answer to an app (PRD-001, AGT-002, AGT-006)', () => {
    const root = createProject();
    const app = createAppPackage(root, {
      name: 'Parameterized Analysis',
      domain: 'growth',
      purpose: 'Review generated parameterized analysis',
      audience: 'analyst',
      owners: ['owner@local'],
      selectedBlockIds: [],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const created = __test__.createAiPinTile(root, 'parameterized-analysis', {
      dashboardId: 'overview',
      title: 'Customer beverage spend',
      answer: 'Review-required generated answer.',
      question: 'Who spent most on beverages?',
      certification: 'ai_generated',
      reviewStatus: 'needs_review',
      analysisPlan: {
        dqlArtifact: {
          kind: 'semantic_block',
          source: 'block "customer_beverage_spend" { status = "draft" type = "semantic" metric = "customer_spend" dimensions = ["customer_name"] params { category: string = "Beverage" top_n: number = 10 } parameterPolicy { category = "dynamic" top_n = "dynamic" } filterBindings { category = "product_category" top_n = "limit" } }',
          name: 'customer_beverage_spend',
          persistence: 'transient',
          trustState: 'governed',
          parameters: [
            { name: 'category', type: 'string', required: false, default: 'Beverage', policy: 'dynamic', binding: { kind: 'semantic_filter', field: 'product_category', operator: 'equals' } },
            { name: 'top_n', type: 'number', required: false, default: 10, policy: 'dynamic', binding: { kind: 'limit' } },
          ],
          parameterValues: { category: 'Beverage', top_n: 10 },
        },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const dashboard = JSON.parse(readFileSync(join(root, 'apps/parameterized-analysis/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'category', type: 'string', default: 'Beverage', bindsTo: 'product_category' }),
      expect.objectContaining({ id: 'top_n', type: 'number', default: 10 }),
    ]));
    expect(dashboard.layout.items.at(-1)).toMatchObject({
      trustState: 'review_required',
      reviewStatus: 'review_required',
      parameterBindings: expect.arrayContaining([
        expect.objectContaining({ param: 'category', source: 'dashboard_filter', filter: 'category', parameterType: 'string' }),
        expect.objectContaining({ param: 'top_n', source: 'dashboard_filter', filter: 'top_n', parameterType: 'number' }),
      ]),
    });
  });

  it('reports deduped local pinned insights in app summaries', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['revenue'],
      description: 'Revenue KPI',
      chart: 'bar',
    });
    const app = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const first = __test__.createAiPinTile(root, 'growth-cxo', {
      dashboardId: 'overview',
      tileId: 'qa-pin-one',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      result: { columns: ['account', 'revenue'], rows: [{ account: 'Acme', revenue: 1200 }] },
      analysisPlan: { sourceBlockId: 'Revenue Total', sourceTileId: 'revenue-total' },
    });
    const second = __test__.createAiPinTile(root, 'growth-cxo', {
      dashboardId: 'overview',
      tileId: 'qa-pin-two',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      result: { columns: ['account', 'revenue'], rows: [{ account: 'Acme', revenue: 1200 }] },
      analysisPlan: { sourceBlockId: 'Revenue Total', sourceTileId: 'revenue-total' },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const loaded = __test__.collectAppsList(root).find((entry) => entry.id === 'growth-cxo');
    expect(loaded?.aiPins).toBe(1);
    const details = __test__.loadAppById(root, 'growth-cxo');
    expect(details?.aiPins).toHaveLength(1);
  });

  it('bounds generated SQL preview so app research can finish with a review caveat', async () => {
    const previous = process.env.ZLENS_APP_RESEARCH_PREVIEW_TIMEOUT_MS;
    process.env.ZLENS_APP_RESEARCH_PREVIEW_TIMEOUT_MS = '500';
    try {
      const result = await __test__.runGeneratedSqlPreview({
        projectRoot: createProject(),
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/test/investigations/test/run'),
        path: '/api/apps/test/investigations/test/run',
        executeSql: () => new Promise(() => undefined),
      }, 'SELECT 1 AS x');

      expect(result.preview).toBeUndefined();
      expect(result.fatal).toBe(false);
      expect(result.error).toContain('preview timed out');
    } finally {
      if (previous === undefined) delete process.env.ZLENS_APP_RESEARCH_PREVIEW_TIMEOUT_MS;
      else process.env.ZLENS_APP_RESEARCH_PREVIEW_TIMEOUT_MS = previous;
    }
  });

  it('creates and previews App-owned notebooks', () => {
    const root = createProject();
    const appResult = createAppPackage(root, {
      name: 'Fraud Ops',
      domain: 'cards',
      dashboardTitle: 'Daily Review',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    expect(existsSync(join(root, 'apps/fraud-ops/dashboards/daily-review.dqld'))).toBe(true);

    const notebook = createNotebookForApp(root, 'fraud-ops', {
      name: 'Investigation Notes',
      role: 'analysis',
      visibility: 'shared',
    });
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.path).toBe('apps/fraud-ops/notebooks/investigation-notes.dqlnb');
    expect(existsSync(join(root, notebook.path))).toBe(true);

    const app = JSON.parse(readFileSync(join(root, 'apps/fraud-ops/dql.app.json'), 'utf-8'));
    expect(app.notebooks[0]).toMatchObject({
      path: notebook.path,
      role: 'analysis',
      visibility: 'shared',
    });

    const preview = previewNotebookForApp(root, 'fraud-ops', notebook.path);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect((preview.preview as { title?: string; cells?: unknown[] }).title).toBe('Investigation Notes');
    expect((preview.preview as { cells: unknown[] }).cells.length).toBeGreaterThan(0);
  });
});

describe('Ask App proposals open in App Studio (design D9)', () => {
  const revenueBlock = {
    name: 'Total Revenue', domain: 'revenue', status: 'certified', tags: ['revenue', 'kpi'], description: 'Executive revenue KPI', chart: 'single_value',
  };

  it('opens the proposal as an App Studio draft with the kept data required, and writes no App files', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', revenueBlock);
    const prompt = 'Build a revenue app for leadership and explain why revenue is changing.';
    const session = await proposeAppAiBuild(root, { prompt, domain: 'revenue', owner: 'owner@local' });
    expect(session.status).toBe('proposed');
    const kept = session.proposal!.tiles.filter((tile) => !tile.error).map((tile) => tile.id);
    expect(session.proposal!.gaps.length).toBeGreaterThan(0);

    const opened = await invokeAppsApi(root, `/api/apps/ai-builds/${session.id}/open-in-studio`, 'POST', {
      selectedTileIds: kept,
      expectedProposalHash: session.proposalHash,
      appName: 'Leadership Revenue',
    });
    expect(opened.status).toBe(201);
    const payload = opened.payload as { ok: true; draft: AppBuildDraft; sources: Array<{ title: string; kind: string; trust: string; reason: string }>; notCoveredYet: string[] };
    const draft = payload.draft;
    expect(draft).toMatchObject({
      name: 'Leadership Revenue',
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
      frame: expect.objectContaining({ goal: prompt }),
    });
    expect(draft.pages[0]?.metadata.domain).toBe('revenue');
    // The page is empty: App Studio builds the tiles after the Data step.
    expect(draft.pages.every((page) => page.layout.items.length === 0)).toBe(true);
    expect(draft.sources).toEqual([expect.objectContaining({ kind: 'block', trustState: 'certified', qualifiedIdentity: expect.stringContaining('Total Revenue') })]);
    expect(payload.sources).toEqual([expect.objectContaining({ title: 'Total Revenue', trust: 'Certified', reason: expect.stringContaining('Ask picked it') })]);
    // Ask's own gaps are not copied: App Studio plans again from the goal.
    expect(payload.notCoveredYet).toEqual([]);
    expect(draft.requirements).toEqual([]);

    // Nothing reached the project; the draft is in the local App Studio store.
    expect(existsSync(join(root, 'apps'))).toBe(false);
    expect(getAppAiBuildSession(root, session.id)).toMatchObject({ status: 'ready', studioDraftId: draft.id });
    const listed = await invokeAppsApi(root, '/api/app-builds', 'GET', {});
    expect((listed.payload as { drafts: AppBuildDraft[] }).drafts.map((candidate) => candidate.id)).toContain(draft.id);

    // The App Studio planner proposes the kept data (it is required) and
    // finds what it does not cover itself.
    const proposal = await invokeAppsApi(root, `/api/app-builds/${draft.id}/ai-proposals`, 'POST', {
      prompt: draft.frame.goal,
      expectedRevision: draft.revision,
      proposalHash: draft.proposalHash,
      selectedBlockIds: draft.sources.map((source) => source.id),
      mode: 'add',
    });
    expect(proposal.status).toBe(201);
    const operations = (proposal.payload as { proposal: { operations: Array<Record<string, any>> } }).proposal.operations;
    expect(operations.some((operation) => operation.type === 'upsert_source' && operation.source.id === draft.sources[0]!.id)).toBe(true);
    const requirements = operations.find((operation) => operation.type === 'set_requirements')!;
    expect(requirements.requirements.length).toBeGreaterThan(0);

    // Opening the same proposal again returns the same draft.
    const again = await invokeAppsApi(root, `/api/apps/ai-builds/${session.id}/open-in-studio`, 'POST', {
      selectedTileIds: kept,
      expectedProposalHash: session.proposalHash,
    });
    expect(again.status).toBe(200);
    expect((again.payload as { draft: AppBuildDraft }).draft.id).toBe(draft.id);
  });

  it('lists AI-written SQL under Not covered yet and allows data that needs review only when the author kept it', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', revenueBlock);
    const propose = () => proposeAppAiBuild(root, {
      prompt: 'Build a revenue app and explain why revenue is changing.',
      domain: 'revenue', owner: 'owner@local', mode: 'personal', exploreGaps: true, maxGeneratedTiles: 1,
    }, {
      generateGovernedAnswer: async (question) => ({
        text: `Exploration for ${question}`,
        sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
        suggestedViz: 'bar',
        result: { columns: ['region', 'revenue'], rows: [{ region: 'NA', revenue: 100 }], rowCount: 1 },
      } as never),
    });

    const session = await propose();
    const draftSql = session.proposal!.tiles.find((tile) => tile.source === 'ai_generated' && !tile.error)!;
    expect(draftSql).toBeTruthy();
    const certified = session.proposal!.tiles.filter((tile) => tile.certification === 'certified').map((tile) => tile.id);
    const opened = await openAppAiBuildInStudio(root, session.id, {
      selectedTileIds: [...certified, draftSql.id],
      expectedProposalHash: session.proposalHash,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.draft.sourcePolicy).toBe('include_review_required');
    expect(opened.notCoveredYet).toContain(draftSql.question || draftSql.title);
    // No AI-written SQL became an App tile, a draft source or a file.
    expect(opened.draft.pages.flatMap((page) => page.layout.items)).toEqual([]);
    expect(opened.draft.sources.some((source) => source.kind === 'review_dql' || source.kind === 'exploratory_sql')).toBe(false);
    expect(existsSync(join(root, 'apps'))).toBe(false);
    expect(existsSync(join(root, '.dql', 'local', 'app-builds', opened.draft.id))).toBe(false);
    // App Studio keeps the question under "Not covered yet" when it plans pages.
    const planned = await invokeAppsApi(root, `/api/app-builds/${opened.draft.id}/ai-proposals`, 'POST', {
      prompt: opened.draft.frame.goal,
      expectedRevision: opened.draft.revision,
      proposalHash: opened.draft.proposalHash,
      selectedBlockIds: opened.draft.sources.map((source) => source.id),
      mode: 'add',
    });
    expect(planned.status).toBe(201);
    const setRequirements = (planned.payload as { proposal: { operations: Array<Record<string, any>> } }).proposal.operations
      .find((operation) => operation.type === 'set_requirements')!;
    const carried = setRequirements.requirements.find((candidate: { question: string }) => candidate.question === (draftSql.question || draftSql.title));
    expect(carried).toBeTruthy();
    expect(setRequirements.coverage.find((candidate: { requirementId: string }) => candidate.requirementId === carried.id)?.status).toBe('gap');

    // Not kept: the draft stays on "Only certified data".
    const second = await propose();
    // The saved queries Ask kept get their result fields read first (design D1).
    const readSavedQueryFields = vi.fn(async (_sourceIds: string[]) => undefined);
    const notKept = await openAppAiBuildInStudio(root, second.id, {
      selectedTileIds: second.proposal!.tiles.filter((tile) => tile.certification === 'certified').map((tile) => tile.id),
      expectedProposalHash: second.proposalHash,
    }, { readSavedQueryFields });
    expect(notKept.ok && notKept.draft.sourcePolicy).toBe('governed_only');
    expect(readSavedQueryFields).toHaveBeenCalledTimes(1);
    expect(readSavedQueryFields.mock.calls[0]![0]).toEqual(notKept.ok ? notKept.draft.sources.map((source) => source.id) : []);
  });

  it('refuses a stale proposal and no longer serves the direct App write route', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', revenueBlock);
    const session = await proposeAppAiBuild(root, { prompt: 'Build a revenue app for leadership.', domain: 'revenue', owner: 'owner@local' });
    const ids = session.proposal!.tiles.map((tile) => tile.id);
    const stale = await invokeAppsApi(root, `/api/apps/ai-builds/${session.id}/open-in-studio`, 'POST', { selectedTileIds: ids, expectedProposalHash: 'wrong' });
    expect(stale.status).toBe(409);
    const commit = await invokeAppsApi(root, `/api/apps/ai-builds/${session.id}/commit`, 'POST', { selectedTileIds: ids, expectedProposalHash: session.proposalHash });
    expect(commit.status).not.toBe(201);
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-app-api-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  return root;
}

describe('Dataset tile review-draft save API', () => {
  it('passes only identifiers and optimistic guards to the server-owned runtime evidence hook', async () => {
    const root = createProject();
    const received: unknown[] = [];
    const result = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/revenue/save-as-block',
      'POST',
      {
        runId: 'app_run_1',
        expectedRevision: 4,
        expectedProposalHash: 'sha256:draft',
        name: 'Revenue total',
        domain: 'commerce',
        description: 'Current governed total',
        // Browser SQL/rows must not become input authority at this boundary.
        sql: 'SELECT unsafe_client_sql',
        result: { rows: [{ revenue: 999 }] },
      },
      {
        saveDatasetTileAsBlock: async (input) => {
          received.push(input);
          return {
            ok: true,
            path: 'domains/commerce/blocks/_drafts/revenue-total.dql',
            status: 'draft',
            provenanceFingerprint: 'sha256:provenance',
            replacementEligible: false,
            replacementMessage: 'Saved as a fixed-value review draft.',
          };
        },
      },
    );
    expect(result.handled).toBe(true);
    expect(result.status).toBe(201);
    expect(received).toEqual([{
      draftId: 'build-1',
      dashboardId: 'overview',
      tileId: 'revenue',
      runId: 'app_run_1',
      expectedRevision: 4,
      expectedProposalHash: 'sha256:draft',
      name: 'Revenue total',
      domain: 'commerce',
      description: 'Current governed total',
    }]);

    const invalid = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/revenue/save-as-block',
      'POST',
      { runId: 'app_run_1', expectedRevision: '4', expectedProposalHash: 'sha256:draft' },
      { saveDatasetTileAsBlock: async () => { throw new Error('must not be called'); } },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toMatchObject({ code: 'DATASET_TILE_SAVE_INVALID_REQUEST' });
  });

  it('passes only review-draft identifiers and optimistic guards to the replacement proof hook', async () => {
    const root = createProject();
    const received: unknown[] = [];
    const result = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/revenue/replace-with-block',
      'POST',
      {
        runId: 'app_run_1',
        expectedRevision: 4,
        expectedProposalHash: 'sha256:draft',
        blockPath: 'domains/commerce/blocks/_drafts/revenue-total.dql',
        enableReviewRequired: true,
        // Neither client SQL/results nor a browser trust assertion reaches the
        // authority-bearing same-scope proof closure.
        sql: 'SELECT unsafe_client_sql',
        result: { rows: [{ revenue: 999 }] },
        trustState: 'certified',
      },
      {
        replaceDatasetTileWithReviewBlock: async (input) => {
          received.push(input);
          return { ok: false, code: 'DATASET_TILE_REPLACE_TEST_REFUSAL', error: 'server-owned proof refused', status: 409 };
        },
      },
    );
    expect(result.handled).toBe(true);
    expect(result.status).toBe(409);
    expect(received).toEqual([{
      draftId: 'build-1',
      dashboardId: 'overview',
      tileId: 'revenue',
      runId: 'app_run_1',
      expectedRevision: 4,
      expectedProposalHash: 'sha256:draft',
      blockPath: 'domains/commerce/blocks/_drafts/revenue-total.dql',
      enableReviewRequired: true,
    }]);

    const invalid = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/revenue/replace-with-block',
      'POST',
      {
        runId: 'app_run_1', expectedRevision: 4, expectedProposalHash: 'sha256:draft',
        blockPath: 'domains/commerce/blocks/_drafts/revenue-total.dql', enableReviewRequired: 'yes',
      },
      { replaceDatasetTileWithReviewBlock: async () => { throw new Error('must not be called'); } },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toMatchObject({ code: 'DATASET_TILE_REPLACE_INVALID_REQUEST' });
  });
});

describe('Legacy semantic-to-Dataset conversion API', () => {
  it('passes only route identities and optimistic guards to the server-owned preview and accept hooks', async () => {
    const root = createProject();
    const previewed: unknown[] = [];
    const accepted: unknown[] = [];
    const hooks = {
      previewSemanticTileConversion: async (input: unknown) => {
        previewed.push(input);
        return { ok: false as const, code: 'SEMANTIC_CONVERSION_TEST_REFUSAL', error: 'server-owned mapping refused', status: 409 };
      },
      acceptSemanticTileConversion: async (input: unknown) => {
        accepted.push(input);
        return { ok: false as const, code: 'SEMANTIC_CONVERSION_TEST_REFUSAL', error: 'server-owned proof refused', status: 409 };
      },
    };

    const preview = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/legacy-revenue/preview-semantic-conversion',
      'POST',
      {
        expectedRevision: 4,
        expectedProposalHash: 'sha256:draft',
        // Client payload cannot supply source identity, query, SQL, rows, or a proof.
        sourceId: 'untrusted-source',
        query: { measures: [{ measure: 'untrusted' }] },
        sql: 'SELECT unsafe_client_sql',
        result: { rows: [{ revenue: 999 }] },
        equivalenceProofFingerprint: 'sha256:forged',
      },
      hooks,
    );
    expect(preview.status).toBe(409);
    expect(previewed).toEqual([{
      draftId: 'build-1', dashboardId: 'overview', tileId: 'legacy-revenue',
      expectedRevision: 4, expectedProposalHash: 'sha256:draft',
    }]);

    const accept = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/legacy-revenue/semantic-conversions/conv_1/accept',
      'POST',
      {
        expectedRevision: 4,
        expectedProposalHash: 'sha256:draft',
        sourceId: 'untrusted-source',
        query: { measures: [{ measure: 'untrusted' }] },
        sql: 'SELECT unsafe_client_sql',
        result: { rows: [{ revenue: 999 }] },
      },
      hooks,
    );
    expect(accept.status).toBe(409);
    expect(accepted).toEqual([{
      draftId: 'build-1', dashboardId: 'overview', tileId: 'legacy-revenue', proposalId: 'conv_1',
      expectedRevision: 4, expectedProposalHash: 'sha256:draft',
    }]);

    const invalid = await invokeAppsApi(
      root,
      '/api/app-builds/build-1/dashboards/overview/tiles/legacy-revenue/preview-semantic-conversion',
      'POST',
      { expectedRevision: '4', expectedProposalHash: 'sha256:draft' },
      hooks,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toMatchObject({ code: 'SEMANTIC_TILE_CONVERSION_INVALID_REQUEST' });
    expect(previewed).toHaveLength(1);
  });
});

async function invokeAppsApi(
  projectRoot: string,
  path: string,
  method: string,
  body: unknown,
  hooks: Partial<Pick<Parameters<typeof handleAppsApi>[0],
    'planAppBuild' | 'generateGovernedAnswer' | 'datasetsEnabled' | 'resolveDatasetSourceAuthority' | 'verifyAppBuildPreview' | 'createDatasetGapProposal' | 'saveDatasetTileAsBlock' | 'replaceDatasetTileWithReviewBlock' | 'previewSemanticTileConversion' | 'acceptSemanticTileConversion'
  >> = {},
): Promise<{ handled: boolean; status: number; payload: unknown }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as IncomingMessage;
  req.method = method;
  let status = 0;
  let responseBody = '';
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) responseBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      return this;
    },
  } as unknown as ServerResponse;
  const url = new URL(`http://local.test${path}`);
  const handled = await handleAppsApi({
    req,
    res,
    url,
    path: url.pathname,
    projectRoot,
    ...hooks,
  });
  return { handled, status, payload: responseBody ? JSON.parse(responseBody) : undefined };
}

function writeBlock(
  root: string,
  relPath: string,
  block: TestBlockSpec,
): void {
  writeBlockFile(join(root, 'blocks', relPath), block);
}

/** A real v3 block declaration for the App field-builder API contract. */
function writeDatasetBlock(root: string, relPath: string): void {
  const path = join(root, 'blocks', relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `block "Order lines" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  description = "Governed order line Dataset"
  owner = "analytics@local"
  tags = ["orders", "revenue"]
  grain = {
    entities = ["order_line"]
    keys = ["order_line_id"]
    keyEvidence = "proof.order-lines"
  }
  fields {
    order_line_id { role = "key", type = "string" }
    region { role = "dimension", type = "string" }
    net_amount { role = "attribute", type = "number" }
  }
  measures {
    revenue { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }
    order_count { agg = "count", from = "order_line_id", additive = "additive", allowedAggs = ["count"] }
  }
  query = """
SELECT order_line_id, region, net_amount FROM order_lines
"""
  visualization { chart = "bar" }
}
`);
}

function writeDomainBlock(
  root: string,
  domain: string,
  relPath: string,
  block: TestBlockSpec,
): void {
  writeBlockFile(join(root, 'domains', domain, 'blocks', relPath), block);
}

function writeBlockFile(
  abs: string,
  block: TestBlockSpec,
): void {
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `block "${block.name}" {
  domain = "${block.domain}"
  status = "${block.status}"
  type = "custom"
  description = "${block.description}"
  owner = "analytics@local"
  tags = [${block.tags.map((tag) => `"${tag}"`).join(', ')}]
${block.dimensions?.length ? `  dimensions = [${block.dimensions.map((dimension) => `"${dimension}"`).join(', ')}]` : ''}
${block.allowedFilters?.length ? `  allowedFilters = [${block.allowedFilters.map((filter) => `"${filter}"`).join(', ')}]` : ''}
${formatTestFilterBindings(block)}
${formatTestParams(block)}

  query = """
${block.query ?? 'SELECT 1 AS value'}
"""

  visualization {
    chart = "${block.chart}"
  }
}
`);
}

function formatTestFilterBindings(block: TestBlockSpec): string {
  if (!block.filterBindings?.length) return '';
  const bindings = block.filterBindings
    .map((entry) => `    ${entry.filter} = "${entry.binding}"`)
    .join('\n');
  return `
  filterBindings {
${bindings}
  }
`;
}

function formatTestParams(block: TestBlockSpec): string {
  if (!block.params || Object.keys(block.params).length === 0) return '';
  const params = Object.entries(block.params)
    .map(([key, value]) => `    ${key} = ${formatTestParamValue(value)}`)
    .join('\n');
  return `
  params {
${params}
  }
`;
}

function formatTestParamValue(value: string | number | boolean | Array<string | number | boolean>): string {
  if (Array.isArray(value)) return `[${value.map(formatTestParamValue).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${value.replace(/"/g, '\\"')}"`;
}

describe('App copilot: the app\'s own drafts', () => {
  const drafts = [
    { name: 'can-you-complete-customers-tax-view', path: 'apps/a/drafts/tax.dql', status: 'review',
      question: 'Can you complete customers tax view', description: 'Tax paid per customer.' },
    { name: 'beverage-margin-by-region', path: 'apps/a/drafts/margin.dql', status: 'review',
      question: 'What is beverage margin by region', description: 'Margin per beverage per region.' },
  ];

  it('offers the draft that covers the question', () => {
    // The governed loop cannot find these — they are never indexed into the
    // manifest — so without this the app silently sits on an answer it has.
    expect(matchAppDraftForQuestion(drafts, 'Can you complete the customers tax view?')?.name)
      .toBe('can-you-complete-customers-tax-view');
    expect(matchAppDraftForQuestion(drafts, 'show beverage margin by region')?.name)
      .toBe('beverage-margin-by-region');
  });

  it('offers nothing when the question is unrelated', () => {
    expect(matchAppDraftForQuestion(drafts, 'What is the weather in Paris?')).toBeUndefined();
    expect(matchAppDraftForQuestion(drafts, 'hello')).toBeUndefined();
  });

  it('does not match on filler words alone', () => {
    // 'can you complete the view' is almost all stopwords; matching on those
    // would offer a random draft for practically any question.
    expect(matchAppDraftForQuestion(
      [{ name: 'unrelated-thing', path: 'p', status: 'review', question: 'Can you complete the view for me' }],
      'can you complete the view',
    )).toBeUndefined();
  });

  it('handles an app with no drafts', () => {
    expect(matchAppDraftForQuestion([], 'anything at all')).toBeUndefined();
    expect(matchAppDraftForQuestion(undefined as never, 'anything at all')).toBeUndefined();
  });
});

describe('writeDashboard cross-app guard', () => {
  it('refuses a page that shares no tiles with the one already on disk', async () => {
    // Dashboard ids are unique only within an App. Several apps here have an
    // `overview` page, so a caller holding one App's document and another App's
    // id would silently overwrite the wrong file — which happened in testing.
    const root = mkdtempSync(join(tmpdir(), 'dql-dash-guard-'));
    tempDirs.push(root);
    const page = (appId: string, tileId: string) => ({
      version: 1, id: 'overview',
      metadata: { title: 'Overview', domain: 'd' },
      layout: { kind: 'grid', cols: 12, items: [{ i: tileId, x: 0, y: 0, w: 4, h: 4, viz: { type: 'table' }, block: { blockId: tileId } }] },
    });
    for (const appId of ['alpha', 'beta']) {
      mkdirSync(join(root, 'apps', appId, 'dashboards'), { recursive: true });
      writeFileSync(join(root, 'apps', appId, 'dql.app.json'), JSON.stringify({
        version: 1, id: appId, name: appId, description: appId, visibility: 'shared',
        domain: 'd', groups: [], lifecycle: 'draft', owners: ['t@example.com'], tags: [],
        homepage: { type: 'dashboard', id: 'overview' },
      }));
      writeFileSync(join(root, 'apps', appId, 'dashboards', 'overview.dqld'), JSON.stringify(page(appId, `${appId}_tile`)));
    }

    const wrongApp = writeDashboardForTest(root, 'beta', 'overview', page('alpha', 'alpha_tile'));
    expect(wrongApp.ok).toBe(false);
    expect('error' in wrongApp && wrongApp.error).toMatch(/shares no tiles/);
    // beta's file is untouched.
    expect(readFileSync(join(root, 'apps', 'beta', 'dashboards', 'overview.dqld'), 'utf-8')).toContain('beta_tile');

    // A genuine edit to the same page still saves.
    const sameApp = writeDashboardForTest(root, 'beta', 'overview', {
      ...page('beta', 'beta_tile'),
      filters: [{ id: 'region', type: 'select', bindsTo: 'region' }],
    });
    expect(sameApp.ok).toBe(true);
    expect(readFileSync(join(root, 'apps', 'beta', 'dashboards', 'overview.dqld'), 'utf-8')).toContain('region');
  });
});
