import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { __test__, runApp } from './app.js';

const tempDirs: string[] = [];

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    format: 'json',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('runApp', () => {
  it('creates a private local draft without writing project App source', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-new-domain-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }), 'utf-8');
    mkdirSync(join(projectRoot, 'domains', 'customer'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousCwd = process.cwd();

    try {
      process.chdir(projectRoot);
      await runApp('new', ['customer-360'], flags({
        domain: 'customer',
        owner: 'customer-analytics@local',
      }));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      created: true,
      id: 'customer-360',
      projectSourceWritten: false,
      draft: {
        appId: 'customer-360',
        authoringMode: 'manual',
        state: 'local_draft',
        pages: [{ metadata: { domain: 'customer', visibility: 'private', lifecycle: 'draft' } }],
      },
    });
    // No per-App data rule is written for a new App (T3).
    expect(payload.draft).not.toHaveProperty('sourcePolicy');
    expect(existsSync(join(projectRoot, 'domains', 'customer', 'apps', 'customer-360', 'dql.app.json'))).toBe(false);
    expect(existsSync(join(projectRoot, 'apps', 'customer-360', 'dql.app.json'))).toBe(false);
    expect(__test__.collectApps(projectRoot)).toEqual([]);
    expect(existsSync(join(projectRoot, '.dql', 'local', 'apps.sqlite'))).toBe(true);
  });

  it('lists apps from an explicit project path', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-list-path-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }), 'utf-8');
    mkdirSync(join(projectRoot, 'apps', 'nba-performance', 'dashboards'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'nba-performance', 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'nba-performance',
      name: 'NBA Performance',
      domain: 'nba',
      visibility: 'shared',
      lifecycle: 'draft',
      owners: ['sports-analytics@local'],
      members: [],
      roles: [],
      policies: [],
      rlsBindings: [],
      schedules: [],
      homepage: { type: 'dashboard', id: 'overview' },
    }, null, 2), 'utf-8');
    writeFileSync(join(projectRoot, 'apps', 'nba-performance', 'dashboards', 'overview.dqld'), JSON.stringify({
      version: 1,
      id: 'overview',
      metadata: {
        title: 'Overview',
        domain: 'nba',
        visibility: 'shared',
        lifecycle: 'draft',
      },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
    }, null, 2), 'utf-8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runApp('ls', [projectRoot], flags());

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.apps).toHaveLength(1);
    expect(payload.apps[0]).toMatchObject({
      id: 'nba-performance',
      domain: 'nba',
      filePath: 'apps/nba-performance',
      dashboards: [{ id: 'overview', title: 'Overview' }],
    });
  });
});

describe('zlens app check', () => {
  it('reports each tile\'s source and trust as publication checks them', async () => {
    const { cpSync } = await import('node:fs');
    const { checkAppPublication } = await import('../apps-api.js');
    const root = mkdtempSync(join(tmpdir(), 'dql-app-check-'));
    try {
      cpSync(join(import.meta.dirname, '../../test/fixtures/app-datasets-pilot'), root, { recursive: true });
      expect(checkAppPublication(root, 'no-such-app')).toBeNull();
      const result = checkAppPublication(root, 'commerce-pilot')!;
      expect(result.app).toMatchObject({ id: 'commerce-pilot', domain: 'commerce' });
      const tiles = result.pages.flatMap((page) => page.tiles);
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) {
        expect(['block', 'semantic', 'dataset', 'exploratory', 'content']).toContain(tile.source);
        expect(tile.check === 'fails').toBe(tile.problems.length > 0);
      }
      expect(result.ready).toBe(result.blockers.length === 0);

      // A page that no longer loads fails the check instead of being skipped.
      const pagePath = join(root, 'apps/commerce-pilot/dashboards/overview.dqld');
      writeFileSync(pagePath, readFileSync(pagePath, 'utf8').replace(/"datasets": \[[\s\S]*?\n  \],/, '"datasets": [],'));
      const broken = checkAppPublication(root, 'commerce-pilot')!;
      expect(broken.ready).toBe(false);
      expect(broken.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'page_invalid', dashboardId: 'overview', message: expect.stringContaining('does not load') })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('App files that do not load', () => {
  it('names the file and the reason instead of dropping the App', async () => {
    const { cpSync } = await import('node:fs');
    const { unloadableApps } = await import('./app.js');
    const root = mkdtempSync(join(tmpdir(), 'dql-app-unloadable-'));
    try {
      cpSync(join(import.meta.dirname, '../../test/fixtures/app-datasets-pilot'), root, { recursive: true });
      expect(unloadableApps(root)).toEqual([]);
      const appPath = join(root, 'apps/commerce-pilot/dql.app.json');
      const app = JSON.parse(readFileSync(appPath, 'utf8'));
      app.policies[0].allowedRoles = ['finance-leaders'];
      writeFileSync(appPath, JSON.stringify(app, null, 2));
      expect(unloadableApps(root)).toEqual([{ path: 'apps/commerce-pilot/dql.app.json', problems: [expect.stringContaining('undeclared role "finance-leaders"')] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a tile bound to a retired block', () => {
  it('is not certified for a new publish, and the check names the replacement', async () => {
    const { checkAppPublication } = await import('../apps-api.js');
    const root = mkdtempSync(join(tmpdir(), 'dql-app-retired-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'blocks'), { recursive: true });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'retired' }));
    writeFileSync(join(root, 'blocks', 'claims_summary.dql'), 'block "Claims Summary" {\n  status = "deprecated"\n  replacedBy = "Claims Dataset"\n  deprecatedOn = "2026-09-30"\n  domain = "claims"\n  type = "custom"\n  query = """SELECT 1 AS claims"""\n}\n');
    writeFileSync(join(root, 'blocks', 'claims_dataset.dql'), 'block "Claims Dataset" {\n  status = "certified"\n  domain = "claims"\n  type = "custom"\n  query = """SELECT 1 AS claims"""\n}\n');
    const appDir = join(root, 'apps', 'claims-ops');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({ version: 1, id: 'claims-ops', name: 'Claims Ops', domain: 'claims', owners: ['a@example.com'], members: [{ userId: 'a@example.com', roles: ['owner'] }], roles: [{ id: 'owner' }], policies: [] }));
    writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), JSON.stringify({
      version: 1, id: 'overview', metadata: { title: 'Overview', domain: 'claims' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'kpi', x: 0, y: 0, w: 3, h: 2, block: { blockId: 'Claims Summary' }, viz: { type: 'single_value' } }] },
    }));
    const result = checkAppPublication(root, 'claims-ops')!;
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'block_not_certified',
      tileId: 'kpi',
      message: 'overview/kpi uses retired saved query Claims Summary, replaced by Claims Dataset; it no longer resolves to a certified saved query.',
    }));
  });
});

describe('zlens app build arguments', () => {
  it('explains that build takes a project path when given an App id', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-build-id-'));
    tempDirs.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }), 'utf-8');
    const previousCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      await expect(runApp('build', ['nba-performance'], flags())).rejects.toThrow(
        /"nba-performance" is not a project folder\. zlens app build \[path\] builds every App/,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
