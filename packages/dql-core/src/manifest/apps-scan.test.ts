import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './builder.js';
import { tileQueryHash } from '../apps/tile-query.js';

let projectRoot: string;

function writeBlock(name: string, body: string) {
  writeFileSync(
    join(projectRoot, 'blocks', `${name}.dql`),
    body,
    'utf-8',
  );
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-apps-scan-'));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'test' }));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('buildManifest with apps + dashboards', () => {
  it('returns empty apps/dashboards when apps/ is missing', () => {
    writeBlock('revenue_total', `block "revenue_total" { domain = "growth" sql = "SELECT 1 AS revenue" }`);
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.apps).toBeUndefined();
    expect(manifest.dashboards).toBeUndefined();
  });

  it('discovers apps and dashboards and resolves block refs', () => {
    writeBlock(
      'revenue_total',
      `block "revenue_total" {
  domain = "growth"
  type = "custom"
  query = """SELECT 1 AS revenue"""
}`,
    );

    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });

    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth — CXO',
      domain: 'growth',
      owners: ['alice@acme.com'],
      members: [{ userId: 'alice@acme.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'weekly-overview' },
    }));

    writeFileSync(join(appDir, 'dashboards', 'weekly-overview.dqld'), JSON.stringify({
      version: 1,
      id: 'weekly-overview',
      metadata: { title: 'Weekly Overview', domain: 'growth' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'kpi', x: 0, y: 0, w: 3, h: 2,
            block: { blockId: 'revenue_total' },
            viz: { type: 'single_value' } },
        ],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });

    expect(Object.keys(manifest.blocks)).toContain('revenue_total');

    expect(Object.keys(manifest.apps ?? {})).toEqual(['growth-cxo']);
    expect(Object.keys(manifest.dashboards ?? {})).toEqual(['growth-cxo/weekly-overview']);

    const dashboard = manifest.dashboards!['growth-cxo/weekly-overview'];
    expect(dashboard.appId).toBe('growth-cxo');
    expect(dashboard.qualifiedId).toBe('growth-cxo/weekly-overview');
    expect(dashboard.blockIds).toEqual(['revenue_total']);
    expect(dashboard.unresolvedRefs).toEqual([]);

    const app = manifest.apps!['growth-cxo'];
    expect(app.dashboards).toEqual(['growth-cxo/weekly-overview']);
    expect(app.homepage).toEqual({ type: 'dashboard', id: 'weekly-overview' });

    // Lineage: app:growth-cxo node, dashboard:growth-cxo/weekly-overview node, edge between.
    const ids = new Set(manifest.lineage.nodes.map((n) => n.id));
    expect(ids.has('app:growth-cxo')).toBe(true);
    expect(ids.has('dashboard:growth-cxo/weekly-overview')).toBe(true);
    expect(ids.has('block:revenue_total')).toBe(true);

    const edge = manifest.lineage.edges.find(
      (e) => e.source === 'dashboard:growth-cxo/weekly-overview' && e.target === 'app:growth-cxo',
    );
    expect(edge?.type).toBe('contains');

    const blockToDashboard = manifest.lineage.edges.find(
      (e) => e.source === 'block:revenue_total' && e.target === 'dashboard:growth-cxo/weekly-overview',
    );
    expect(blockToDashboard?.type).toBe('contains');
  });

  it('discovers domain-first apps and dashboards and resolves domain block path refs', () => {
    const domainDir = join(projectRoot, 'domains', 'growth');
    mkdirSync(join(domainDir, 'blocks'), { recursive: true });
    writeFileSync(join(domainDir, 'domain.dql'), `domain "growth" { owner = "growth-analytics" }`, 'utf-8');
    writeFileSync(join(domainDir, 'blocks', 'growth_kpi.dql'), `block "Growth KPI" {
  domain = "growth"
  type = "custom"
  status = "certified"
  description = "Growth KPI"
  owner = "growth-analytics"
  query = """SELECT 1 AS revenue"""
}`, 'utf-8');

    const appDir = join(domainDir, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['alice@acme.com'],
      members: [{ userId: 'alice@acme.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'weekly-overview' },
    }), 'utf-8');
    writeFileSync(join(appDir, 'dashboards', 'weekly-overview.dqld'), JSON.stringify({
      version: 1,
      id: 'weekly-overview',
      metadata: { title: 'Weekly Overview', domain: 'growth' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          {
            i: 'kpi',
            x: 0,
            y: 0,
            w: 3,
            h: 2,
            block: { ref: 'domains/growth/blocks/growth_kpi.dql' },
            viz: { type: 'single_value' },
          },
        ],
      },
    }), 'utf-8');

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });

    expect(manifest.apps?.['growth-cxo']).toMatchObject({
      id: 'growth-cxo',
      domain: 'growth',
      filePath: 'domains/growth/apps/growth-cxo',
      dashboards: ['growth-cxo/weekly-overview'],
    });
    expect(manifest.dashboards?.['growth-cxo/weekly-overview']).toMatchObject({
      appId: 'growth-cxo',
      domain: 'growth',
      blockPathRefs: ['Growth KPI'],
      unresolvedRefs: [],
      filePath: 'domains/growth/apps/growth-cxo/dashboards/weekly-overview.dqld',
    });

    const ids = new Set(manifest.lineage.nodes.map((node) => node.id));
    expect(ids.has('app:growth-cxo')).toBe(true);
    expect(ids.has('dashboard:growth-cxo/weekly-overview')).toBe(true);
    expect(ids.has('block:Growth KPI')).toBe(true);
    expect(manifest.lineage.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'block:Growth KPI',
        target: 'dashboard:growth-cxo/weekly-overview',
        type: 'contains',
      }),
    ]));
  });

  it('records diagnostics for unresolved block refs and unknown homepage', () => {
    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth',
      domain: 'growth',
      owners: ['alice@acme.com'],
      members: [{ userId: 'alice@acme.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'does-not-exist' },
    }));
    writeFileSync(join(appDir, 'dashboards', 'd1.dqld'), JSON.stringify({
      version: 1,
      id: 'd1',
      metadata: { title: 'D1' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'a', x: 0, y: 0, w: 3, h: 2,
            block: { blockId: 'ghost' },
            viz: { type: 'line' } },
        ],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    const messages = (manifest.diagnostics ?? []).map((d) => d.message);
    expect(messages.some((m) => m.includes('unresolved block refs: ghost'))).toBe(true);
    expect(messages.some((m) => m.includes('homepage references unknown dashboard "does-not-exist"'))).toBe(true);
  });

  it('reports v3 Dataset source and field drift during compile before a page can publish', () => {
    const blockSource = `block "Orders Dataset" {
  domain = "growth"
  type = "custom"
  status = "certified"
  grain = {
    entities = ["order_line"]
    keys = ["order_line_id"]
    keyEvidence = "proof.orders"
  }
  fields {
    order_line_id { role = "key", type = "string" }
    region { role = "dimension", type = "string" }
    net_amount { role = "attribute", type = "number" }
  }
  measures {
    revenue { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }
  }
  query = """SELECT order_line_id, region, net_amount FROM order_lines"""
}`;
    writeBlock('orders_dataset', blockSource);
    const sourcePath = 'blocks/orders_dataset.dql';
    const sourceId = `app:block:growth:${createHash('sha256').update(`${sourcePath}\u0000Orders Dataset`).digest('hex').slice(0, 20)}`;
    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@example.test'],
      members: [{ userId: 'owner@example.test', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'field-overview' },
    }));
    writeFileSync(join(appDir, 'dashboards', 'field-overview.dqld'), JSON.stringify({
      version: 3,
      id: 'field-overview',
      metadata: { title: 'Field overview', domain: 'growth' },
      datasets: [{
        id: 'orders', sourceId, sourceRevision: 'sha256:revision-before-source-edit', snapshotId: 'snapshot-at-authoring', contractFingerprint: 'contract-at-authoring',
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'removed-field', x: 0, y: 0, w: 6, h: 3,
          sourceId, sourceRevision: 'sha256:revision-before-source-edit',
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'removed_measure' }] },
          viz: { type: 'bar' },
        }],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    const diagnostics = manifest.diagnostics ?? [];
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'drift', severity: 'error', message: expect.stringContaining('APP_DATASET_SOURCE_DRIFT') }),
      expect.objectContaining({ kind: 'drift', severity: 'error', message: expect.stringContaining('APP_DATASET_FIELD_DRIFT') }),
    ]));
  });

  it('does not report drift for a saved query\'s result fields or a related table\'s fields, and still reports a column that went away (doctor)', () => {
    writeBlock('monthly_revenue', `block "monthly_revenue" {
  domain = "growth"
  type = "custom"
  status = "certified"
  query = """SELECT date_trunc('month', order_date) AS month, SUM(net_amount) AS gross_revenue, AVG(net_amount) AS avg_line FROM order_lines GROUP BY 1"""
}`);
    writeBlock('orders_dataset', `block "Orders Dataset" {
  domain = "growth"
  type = "custom"
  status = "certified"
  grain = {
    entities = ["order_line"]
    keys = ["order_line_id"]
    keyEvidence = "proof.orders"
  }
  fields {
    order_line_id { role = "key", type = "string" }
    customer_id { role = "dimension", type = "string" }
    net_amount { role = "attribute", type = "number" }
  }
  measures {
    revenue { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }
  }
  query = """SELECT order_line_id, customer_id, net_amount FROM order_lines"""
}`);
    const idOf = (path: string, name: string) => `app:block:growth:${createHash('sha256').update(`${path}\u0000${name}`).digest('hex').slice(0, 20)}`;
    const revisionOf = (file: string) => `sha256:${createHash('sha256').update(readFileSync(join(projectRoot, 'blocks', file), 'utf8')).digest('hex')}`;
    const monthlyId = idOf('blocks/monthly_revenue.dql', 'monthly_revenue');
    const ordersId = idOf('blocks/orders_dataset.dql', 'Orders Dataset');
    const appDir = join(projectRoot, 'apps', 'growth');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1, id: 'growth', name: 'Growth', domain: 'growth', owners: ['owner@example.test'],
      members: [{ userId: 'owner@example.test', roles: ['owner'] }], roles: [{ id: 'owner' }], policies: [],
      homepage: { type: 'dashboard', id: 'overview' },
    }));
    const tile = (i: string, sourceId: string, revision: string, query: Record<string, unknown>) => ({ i, x: 0, y: 0, w: 6, h: 3, sourceId, sourceRevision: revision, query, viz: { type: 'bar' } });
    const page = (items: unknown[]) => JSON.stringify({
      version: 3, id: 'overview', metadata: { title: 'Overview', domain: 'growth' },
      datasets: [
        { id: 'monthly', sourceId: monthlyId, sourceRevision: revisionOf('monthly_revenue.dql'), snapshotId: 's', contractFingerprint: 'c' },
        { id: 'orders', sourceId: ordersId, sourceRevision: revisionOf('orders_dataset.dql'), snapshotId: 's', contractFingerprint: 'c' },
      ],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items },
    });
    writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), page([
      tile('by-month', monthlyId, revisionOf('monthly_revenue.dql'), { dimensions: [{ field: 'month', timeGrain: 'quarter' }], measures: [{ measure: 'gross_revenue' }, { measure: 'max_avg_line' }, { measure: 'count_of_rows' }] }),
      tile('by-customer', ordersId, revisionOf('orders_dataset.dql'), { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'revenue' }] }),
    ]));
    const drift = () => (buildManifest({ projectRoot, dqlVersion: 'test' }).diagnostics ?? []).filter((d) => d.kind === 'drift').map((d) => d.message);
    expect(drift()).toEqual([]);

    // A column the saved query no longer returns is still drift.
    writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), page([
      tile('gone', monthlyId, revisionOf('monthly_revenue.dql'), { dimensions: [{ field: 'region' }], measures: [{ measure: 'net_revenue' }] }),
    ]));
    expect(drift()).toEqual([
      expect.stringContaining('APP_DATASET_FIELD_DRIFT: Tile gone selects dimension region'),
      expect.stringContaining('APP_DATASET_FIELD_DRIFT: Tile gone selects measure net_revenue'),
    ]);
  });

  it('records virtual v3 App Dataset tile lineage without fabricating offline SQL', () => {
    const blockSource = `block "Orders Dataset" {
  domain = "growth"
  type = "custom"
  status = "certified"
  grain = {
    entities = ["order_line"]
    keys = ["order_line_id"]
    keyEvidence = "proof.orders"
  }
  fields {
    order_line_id { role = "key", type = "string" }
    region { role = "dimension", type = "string" }
    net_amount { role = "attribute", type = "number" }
  }
  measures {
    revenue { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }
  }
  query = """SELECT order_line_id, region, net_amount FROM order_lines"""
}`;
    writeBlock('orders_dataset', blockSource);
    const sourcePath = 'blocks/orders_dataset.dql';
    const sourceId = `app:block:growth:${createHash('sha256').update(`${sourcePath}\u0000Orders Dataset`).digest('hex').slice(0, 20)}`;
    const sourceRevision = `sha256:${createHash('sha256').update(blockSource).digest('hex')}`;
    const semanticSourceId = 'app:semantic:commerce:orders';
    const query = {
      dimensions: [{ field: 'region' }],
      measures: [{ measure: 'revenue' }],
      filters: [{ field: 'region', op: 'eq', values: ['CA'] }],
    };
    const dashboardDocument = {
      version: 3,
      id: 'dataset-overview',
      metadata: { title: 'Dataset overview', domain: 'growth' },
      datasets: [
        { id: 'orders', sourceId, sourceRevision, snapshotId: 'snapshot.orders', contractFingerprint: 'contract.orders' },
        { id: 'semantic-orders', sourceId: semanticSourceId, sourceRevision: 'semantic.r1', snapshotId: 'snapshot.semantic', contractFingerprint: 'contract.semantic' },
      ],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          {
            i: 'revenue-by-region', x: 0, y: 0, w: 6, h: 3,
            sourceId, sourceRevision, query,
            viz: { type: 'bar' },
          },
          {
            i: 'semantic-revenue', x: 6, y: 0, w: 6, h: 3,
            sourceId: semanticSourceId, sourceRevision: 'semantic.r1',
            query: { dimensions: [], measures: [{ measure: 'revenue' }] },
            viz: { type: 'single_value' },
          },
        ],
      },
    };
    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@example.test'],
      members: [{ userId: 'owner@example.test', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'dataset-overview' },
    }));
    const dashboardPath = join(appDir, 'dashboards', 'dataset-overview.dqld');
    writeFileSync(dashboardPath, JSON.stringify(dashboardDocument));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    const dashboard = manifest.dashboards?.['growth-cxo/dataset-overview'];
    const blockTile = dashboard?.datasetTiles?.find((tile) => tile.id === 'revenue-by-region');
    const semanticTile = dashboard?.datasetTiles?.find((tile) => tile.id === 'semantic-revenue');
    expect(blockTile).toMatchObject({
      sourceId,
      sourceRevision,
      contractFingerprint: 'contract.orders',
      sourceKind: 'block_dataset',
      selectedOutputs: { dimensions: ['region'], measures: ['revenue'], filters: ['region'], having: [] },
    });
    const expectedQueryFingerprint = `sha256:${createHash('sha256').update(JSON.stringify({ query: tileQueryHash(query) })).digest('hex')}`;
    expect(blockTile?.queryFingerprint).toBe(expectedQueryFingerprint);
    expect(blockTile?.dependencyFingerprint).toMatch(/^sha256:/);
    expect(semanticTile).toMatchObject({ sourceId: semanticSourceId, sourceKind: 'semantic_dataset' });

    const blockTileNode = manifest.lineage.nodes.find((node) => node.id === 'app_tile:growth-cxo/dataset-overview:revenue-by-region');
    const blockSourceNode = manifest.lineage.nodes.find((node) => node.id === `dataset_source:${blockTile?.sourceFingerprint}`);
    const semanticSourceNode = manifest.lineage.nodes.find((node) => node.id === `dataset_source:${semanticTile?.sourceFingerprint}`);
    expect(blockTileNode?.metadata).toMatchObject({
      sourceId,
      sourceRevision,
      contractFingerprint: 'contract.orders',
      queryFingerprint: expectedQueryFingerprint,
      dependencyFingerprint: blockTile?.dependencyFingerprint,
    });
    expect(blockTileNode?.metadata).not.toHaveProperty('physicalSqlFingerprint');
    expect(semanticSourceNode?.metadata).toMatchObject({
      sourceKind: 'semantic_dataset',
      physicalSqlAvailability: 'unavailable_offline',
    });
    expect(semanticSourceNode?.metadata).not.toHaveProperty('physicalSqlFingerprint');
    expect(manifest.lineage.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'block:Orders Dataset', target: blockSourceNode?.id, type: 'contains' }),
      expect.objectContaining({ source: blockSourceNode?.id, target: blockTileNode?.id, type: 'feeds' }),
      expect.objectContaining({ source: blockTileNode?.id, target: 'dashboard:growth-cxo/dataset-overview', type: 'contains' }),
    ]));

    // A saved query edit changes only the virtual tile's authored dependency
    // fingerprint. It never creates an offline physical SQL identity.
    dashboardDocument.layout.items[0].query = {
      dimensions: [{ field: 'region' }],
      measures: [{ measure: 'revenue', alias: 'regional_revenue' }],
      filters: [{ field: 'region', op: 'eq', values: ['CA'] }],
    };
    writeFileSync(dashboardPath, JSON.stringify(dashboardDocument));
    const queryChanged = buildManifest({ projectRoot, dqlVersion: 'test' });
    const changedTile = queryChanged.dashboards?.['growth-cxo/dataset-overview'].datasetTiles?.find((tile) => tile.id === 'revenue-by-region');
    expect(changedTile?.queryFingerprint).not.toBe(blockTile?.queryFingerprint);
    expect(changedTile?.dependencyFingerprint).not.toBe(blockTile?.dependencyFingerprint);

    // A source edit remains a compile-time dependent drift until the page is
    // explicitly rebound to the new exact source revision.
    const updatedBlockSource = blockSource.replace('net_amount FROM order_lines', 'net_amount FROM order_lines WHERE region IS NOT NULL');
    writeBlock('orders_dataset', updatedBlockSource);
    const sourceDrift = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(sourceDrift.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'drift', message: expect.stringContaining('APP_DATASET_SOURCE_DRIFT') }),
    ]));
    const updatedSourceRevision = `sha256:${createHash('sha256').update(updatedBlockSource).digest('hex')}`;
    dashboardDocument.datasets[0].sourceRevision = updatedSourceRevision;
    dashboardDocument.layout.items[0].sourceRevision = updatedSourceRevision;
    writeFileSync(dashboardPath, JSON.stringify(dashboardDocument));
    const rebound = buildManifest({ projectRoot, dqlVersion: 'test' });
    const reboundTile = rebound.dashboards?.['growth-cxo/dataset-overview'].datasetTiles?.find((tile) => tile.id === 'revenue-by-region');
    expect(reboundTile?.sourceFingerprint).not.toBe(changedTile?.sourceFingerprint);
    expect(reboundTile?.dependencyFingerprint).not.toBe(changedTile?.dependencyFingerprint);
    expect((rebound.diagnostics ?? []).some((diagnostic) => diagnostic.message.includes('APP_DATASET_SOURCE_DRIFT'))).toBe(false);
  });

  it('reports a config error when a v1/v2 dashboard contains v3 Dataset authoring', () => {
    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@example.test'],
      members: [{ userId: 'owner@example.test', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'invalid-dataset-page' },
    }));
    writeFileSync(join(appDir, 'dashboards', 'invalid-dataset-page.dqld'), JSON.stringify({
      version: 2,
      id: 'invalid-dataset-page',
      metadata: { title: 'Invalid Dataset page' },
      datasets: [{
        id: 'orders', sourceId: 'source.orders', sourceRevision: 'source.v1', snapshotId: 'snapshot.v1', contractFingerprint: 'contract.v1',
      }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue', x: 0, y: 0, w: 4, h: 2,
          sourceId: 'source.orders', sourceRevision: 'source.v1',
          query: { dimensions: [], measures: [{ measure: 'revenue' }] },
          viz: { type: 'single_value' },
        }],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'config',
        severity: 'error',
        message: expect.stringContaining('require dashboard version 3'),
      }),
    ]));
    expect(manifest.dashboards?.['growth-cxo/invalid-dataset-page']).toBeUndefined();
  });
});
