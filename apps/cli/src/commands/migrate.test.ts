import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { applyModelingMigration, planModelingMigration, runMigrate } from './migrate.js';

const tempDirs: string[] = [];

function baseFlags(overrides: Partial<CLIFlags> = {}): CLIFlags {
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

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-migrate-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  mkdirSync(join(dir, 'blocks'), { recursive: true });
  writeFileSync(join(dir, 'blocks', 'orders.dql'), `block "Customer Orders" {
  domain = "Customer Success"
  type = "custom"
  query = """SELECT * FROM orders"""
}`);
  return dir;
}

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function modelingProject(options: { missingBinding?: boolean; targetCollision?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-modeling-migrate-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), `${JSON.stringify({ project: 'commerce', manifestVersion: 2 }, null, 2)}\n`);
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
    nodes: {
      'model.shop.fct_orders': {
        resource_type: 'model', name: 'fct_orders', alias: 'fct_orders', database: 'analytics', schema: 'commerce',
      },
    },
    sources: {},
  }));
  const domainRoot = join(root, 'domains', 'commerce');
  mkdirSync(join(domainRoot, 'modeling'), { recursive: true });
  mkdirSync(join(domainRoot, 'apps', 'revenue-review'), { recursive: true });
  mkdirSync(join(domainRoot, 'notebooks'), { recursive: true });
  writeFileSync(join(domainRoot, 'domain.dql'), '// dql-format: 1\n\ndomain "Commerce" {\n  id = "commerce"\n}\n');
  writeFileSync(join(domainRoot, 'modeling', 'entities.dql.yaml'), `# legacy split source\nentities:\n  - id: order\n    dbt_model: ${options.missingBinding ? 'missing_orders' : 'fct_orders'}\n    grain: order_id\n`);
  writeFileSync(join(domainRoot, 'modeling', 'relationships.dql.yaml'), 'relationships:\n  - id: order_self\n    from: order\n    to: order\n    status: review\n');
  writeFileSync(join(domainRoot, 'apps', 'revenue-review', 'dql.app.json'), `${JSON.stringify({
    version: 1,
    id: 'revenue-review',
    name: 'Revenue review',
    domain: 'commerce',
    lifecycle: 'review',
    owners: ['analytics@example.com'],
    members: [], roles: [], policies: [],
  }, null, 2)}\n`);
  writeFileSync(join(domainRoot, 'notebooks', 'orders.dqlnb'), `${JSON.stringify({
    dqlnbVersion: 2,
    version: 1,
    title: 'Orders',
    metadata: { lifecycle: 'review', createdWith: 'dql' },
    cells: [],
  }, null, 2)}\n`);
  if (options.targetCollision) {
    mkdirSync(join(root, 'apps', 'revenue-review'), { recursive: true });
    writeFileSync(join(root, 'apps', 'revenue-review', 'dql.app.json'), '{}\n');
  }
  return root;
}

describe('runMigrate modeling (CFG-002, MIG-001, MIG-002)', () => {
  it('dry-run is fingerprinted and writes nothing', async () => {
    const projectRoot = modelingProject();
    const beforeConfig = readFileSync(join(projectRoot, 'dql.config.json'), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('modeling', baseFlags({ input: projectRoot, to: 'dbt-first', dryRun: true }));

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report).toMatchObject({ mode: 'dry-run', status: 'ready' });
    expect(report.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.productMoves).toHaveLength(2);
    expect(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')).toBe(beforeConfig);
    expect(existsSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'entities.dql.yaml'))).toBe(true);
    expect(existsSync(join(projectRoot, 'apps', 'revenue-review'))).toBe(false);
  });

  it('applies atomically and a second apply is a no-op', async () => {
    const projectRoot = modelingProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('modeling', baseFlags({ input: projectRoot, to: 'dbt-first', apply: true }));
    const first = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(first.status).toBe('applied');
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8'))).toMatchObject({
      project: 'commerce',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
    });
    const model = readFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'model.dql.yaml'), 'utf8');
    expect(model).toContain('dbt_model: model.shop.fct_orders');
    expect(model).toContain('status: review');
    expect(existsSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'entities.dql.yaml'))).toBe(false);
    const app = JSON.parse(readFileSync(join(projectRoot, 'apps', 'revenue-review', 'dql.app.json'), 'utf8'));
    expect(app).toMatchObject({ lifecycle: 'review', ownerDomain: 'commerce', usesDomains: ['commerce'] });
    const notebook = JSON.parse(readFileSync(join(projectRoot, 'notebooks', 'orders.dqlnb'), 'utf8'));
    expect(notebook.metadata).toMatchObject({ lifecycle: 'review', ownerDomain: 'commerce', usesDomains: ['commerce'] });

    await runMigrate('modeling', baseFlags({ input: projectRoot, to: 'dbt-first', apply: true }));
    const second = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(second).toMatchObject({ mode: 'applied', status: 'noop', written: [], removed: [] });
  });

  it('stops on ambiguous target collisions before any write', async () => {
    const projectRoot = modelingProject({ targetCollision: true });
    const beforeConfig = readFileSync(join(projectRoot, 'dql.config.json'), 'utf8');
    const beforeLegacy = readFileSync(join(projectRoot, 'domains', 'commerce', 'apps', 'revenue-review', 'dql.app.json'), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('modeling', baseFlags({ input: projectRoot, to: 'dbt-first', apply: true }));

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.status).toBe('blocked');
    expect(report.ambiguities).toContainEqual(expect.objectContaining({ code: 'TARGET_COLLISION', path: 'apps/revenue-review' }));
    expect(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')).toBe(beforeConfig);
    expect(readFileSync(join(projectRoot, 'domains', 'commerce', 'apps', 'revenue-review', 'dql.app.json'), 'utf8')).toBe(beforeLegacy);
    expect(existsSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'model.dql.yaml'))).toBe(false);
  });

  it('reports every known lossy field while preserving unresolved semantics', async () => {
    const projectRoot = modelingProject({ missingBinding: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('modeling', baseFlags({ input: projectRoot, to: 'dbt-first', dryRun: true }));

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_DBT_BINDING' }),
      expect.objectContaining({ code: 'YAML_COMMENTS' }),
    ]));
    expect(readFileSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'entities.dql.yaml'), 'utf8')).toContain('missing_orders');
  });

  it('rejects an approved plan when its source fingerprint changes', () => {
    const projectRoot = modelingProject();
    const plan = planModelingMigration(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), `${JSON.stringify({ project: 'changed-after-preview', manifestVersion: 2 }, null, 2)}\n`);

    expect(() => applyModelingMigration(projectRoot, plan)).toThrow(/SOURCE_CHANGED/);
    expect(existsSync(join(projectRoot, 'domains', 'commerce', 'modeling', 'model.dql.yaml'))).toBe(false);
    expect(existsSync(join(projectRoot, 'apps', 'revenue-review'))).toBe(false);
  });
});

describe('runMigrate layout', () => {
  it('previews and applies domain-first layout moves', async () => {
    const projectRoot = tempProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('layout', baseFlags({
      input: projectRoot,
      to: 'domain-first',
      dryRun: true,
    }));

    const dryRunReport = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(dryRunReport.moves).toEqual([
      {
        source: 'blocks/orders.dql',
        target: 'domains/customer-success/blocks/orders.dql',
        kind: 'block',
        domain: 'customer-success',
        status: 'move',
      },
    ]);
    expect(existsSync(join(projectRoot, 'blocks', 'orders.dql'))).toBe(true);
    expect(existsSync(join(projectRoot, 'domains', 'customer-success', 'blocks', 'orders.dql'))).toBe(false);

    await runMigrate('layout', baseFlags({
      input: projectRoot,
      to: 'domain-first',
      force: true,
    }));

    const target = join(projectRoot, 'domains', 'customer-success', 'blocks', 'orders.dql');
    expect(existsSync(join(projectRoot, 'blocks', 'orders.dql'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('block "Customer Orders"');
  });
});

describe('runMigrate parameters', () => {
  it('audits legacy placeholders without rewriting source', async () => {
    const projectRoot = tempProject();
    writeFileSync(join(projectRoot, 'blocks', 'orders.dql'), `block "Customer Orders" {
  domain = "Customer Success"
  type = "custom"
  parameterPolicy { region = "dynamic" }
  query = """SELECT * FROM orders WHERE region = ${'${region}'} AND occurred_at >= ${'${start_date}'}"""
}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMigrate('parameters', baseFlags({ input: projectRoot, check: false }));

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.blocksWithParameters).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'undeclared_placeholder', detail: expect.stringContaining('start_date') }),
      expect.objectContaining({ kind: 'policy_without_definition', detail: expect.stringContaining('region') }),
    ]));
    expect(readFileSync(join(projectRoot, 'blocks', 'orders.dql'), 'utf-8')).toContain('${start_date}');
  });
});

describe('runMigrate <tool>: say what ZLens reads, and import what it can', () => {
  it('imports a Tableau workbook with --input, and points looker at the import instead of claiming to convert it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-migrate-tableau-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(root, 'sales.twb'), `<workbook><datasources><datasource caption='Orders' name='federated.1'><connection class='federated'><named-connections><named-connection name='postgres.1'><connection class='postgres' /></named-connection></named-connections><relation connection='postgres.1' name='Revenue (Custom SQL)' type='text'>select sum(order_total) as revenue from dev.orders</relation></connection></datasource></datasources></workbook>`);
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await runMigrate('tableau', baseFlags({ input: 'sales.twb', domain: 'finance', preview: false }));
      expect(JSON.parse(logs.join('\n')).drafts).toHaveLength(1);

      logs.length = 0;
      await runMigrate('looker', baseFlags());
      const looker = JSON.parse(logs.join('\n'));
      expect(looker.status).toBe('not-built');
      expect(looker.next).toContain('Import them: zlens import sql <folder>');

      logs.length = 0;
      await runMigrate('powerbi', baseFlags());
      expect(JSON.parse(logs.join('\n'))).toMatchObject({ status: 'use-import' });
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });
});

describe('runMigrate assess', () => {
  it('writes the report beside where it runs and prints the summary; --format json prints only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-migrate-assess-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'reports'));
    writeFileSync(join(dir, 'reports', 'revenue.sql'), 'select location_id, sum(order_total) as revenue from dev.orders group by 1;\n');
    const cwd = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(dir);
      await runMigrate('assess', baseFlags({ format: 'text' }), ['reports']);
      expect(readFileSync(join(dir, 'zlens-migration-assessment.md'), 'utf8')).toContain('# Migration assessment');
      expect(log.mock.calls.flat().join('\n')).toContain('Queries:       1 query becomes');

      rmSync(join(dir, 'zlens-migration-assessment.md'));
      log.mockClear();
      await runMigrate('assess', baseFlags({ format: 'json' }), ['reports']);
      expect(JSON.parse(log.mock.calls.flat().join('\n')).queries.drafts).toBe(1);
      expect(existsSync(join(dir, 'zlens-migration-assessment.md'))).toBe(false);

      await runMigrate('assess', baseFlags({ format: 'text', outDir: 'out/assessment.md' }), ['reports']);
      expect(readFileSync(join(dir, 'out', 'assessment.md'), 'utf8')).toContain('| Queries (Custom SQL, native SQL, scripts) | 1 |');
      // --out an existing folder: the report goes in it.
      await runMigrate('assess', baseFlags({ format: 'text', outDir: 'out' }), ['reports']);
      expect(existsSync(join(dir, 'out', 'zlens-migration-assessment.md'))).toBe(true);
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });
});
