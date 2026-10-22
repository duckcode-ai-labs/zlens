import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureMetadataCatalogFresh } from '@zlens/agent';
import { checkAppsPublishing, checkDuckDBDependency, checkNodeVersion, isSnowflakeSupportedNodeVersion, runDoctor, semanticMetricWords } from './doctor.js';

const tempDirs: string[] = [];

describe('Snowflake Node runtime support', () => {
  it('accepts supported LTS majors and rejects unsupported majors', () => {
    expect(isSnowflakeSupportedNodeVersion('20.19.0')).toBe(true);
    expect(isSnowflakeSupportedNodeVersion('22.18.0')).toBe(true);
    expect(isSnowflakeSupportedNodeVersion('24.4.1')).toBe(true);
    expect(isSnowflakeSupportedNodeVersion('26.5.0')).toBe(false);
  });
});

describe('App publishing check (T3)', () => {
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });
  const project = (config: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'dql-doctor-apps-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'dql.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return root;
  };

  it('says publishing is not blocked by trust by default, and when the project requires certified tiles', () => {
    expect(checkAppsPublishing(project({ project: 'p' }))).toMatchObject({ name: 'App publishing', ok: true, detail: expect.stringContaining('not blocked by trust') });
    expect(checkAppsPublishing(project({ apps: { requireCertifiedToPublish: true } }))).toMatchObject({ ok: true, detail: expect.stringContaining('every tile must be certified to publish') });
  });

  it('flags a setting that is not true or false', () => {
    expect(checkAppsPublishing(project({ apps: { requireCertifiedToPublish: 'yes' } }))).toMatchObject({ ok: false, detail: expect.stringContaining('apps.requireCertifiedToPublish must be true or false.') });
  });
});

describe('Node.js check', () => {
  it('passes Node 20, 22 and 24, warns on a newer Node, fails below 20', () => {
    for (const version of ['20.19.0', '22.18.0', '24.15.0']) {
      expect(checkNodeVersion(version)).toEqual({ name: 'Node.js', ok: true, detail: `version=${version} (supported: Node 20, 22 or 24)` });
    }
    const node26 = checkNodeVersion('26.12.0');
    expect(node26.ok).toBe(true);
    expect(node26.advisory).toBe(true);
    expect(node26.detail).toContain('not supported yet');
    expect(node26.detail).toContain("ZLens's DuckDB driver has no prebuilt binary for Node 26 yet; use Node 24 LTS or 22.");
    expect(checkNodeVersion('18.20.4').ok).toBe(false);
  });
});

describe('DuckDB connector check', () => {
  it('names the Node to use when DuckDB has no prebuilt binary for this one', () => {
    const projectDir = makeProject('dql-doctor-duckdb-node26-');
    const check = checkDuckDBDependency(projectDir, '26.12.0');
    expect(check.ok).toBe(false);
    expect(check.detail.split('\n')[0]).toBe("ZLens's DuckDB driver has no prebuilt binary for Node 26 yet; use Node 24 LTS or 22.");
  });

  it('still says "missing; install" on Node 24', () => {
    const projectDir = makeProject('dql-doctor-duckdb-node24-');
    const check = checkDuckDBDependency(projectDir, '24.15.0');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('missing; install from the notebook Connections page');
  });
});

function makeProject(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(projectDir);
  return projectDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runDoctor', () => {
  it('reports retrieval degradations as non-blocking advisories (PERF-002, E2E-005)', async () => {
    const projectDir = makeProject('dql-doctor-');
    mkdirSync(join(projectDir, 'blocks'));
    mkdirSync(join(projectDir, 'semantic-layer'));
    mkdirSync(join(projectDir, 'data'));
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({
      defaultConnection: { driver: 'file', filepath: ':memory:' },
    }, null, 2));
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      dependencies: { duckdb: '^1.1.0' },
    }, null, 2));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(projectDir, {
      check: false,
      chart: '',
      domain: '',
      format: 'text',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: 'starter',
      connection: '',
      verbose: false,
      skipTests: false, version: false,
    });

    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('ZLens Doctor');
    expect(output).toContain('blocks/');
    expect(output).toContain('! Agent retrieval health');
    expect(output).not.toContain('✗ Agent retrieval health');
    expect(output).toContain('npx zlens notebook');
    expect(output).not.toContain('add duckdb for file/duckdb local preview support');
  });

  it('reports enterprise scale counts and cache issues', async () => {
    const projectDir = makeProject('dql-doctor-scale-');
    mkdirSync(join(projectDir, 'domains', 'customer', 'blocks'), { recursive: true });
    mkdirSync(join(projectDir, 'target'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'target', 'manifest.json'), JSON.stringify({
      metadata: { project_name: 'demo' },
      nodes: {
        'model.demo.dim_customer': {
          resource_type: 'model',
          name: 'dim_customer',
          alias: 'dim_customer',
          schema: 'analytics',
          database: 'demo',
          depends_on: { nodes: [] },
          config: { materialized: 'table' },
          columns: {
            customer_id: { name: 'customer_id', description: 'Customer identifier' },
          },
        },
      },
      sources: {},
    }));
    writeFileSync(join(projectDir, 'domains', 'customer', 'domain.dql'), `domain "Customer" {
  owner = "customer-analytics"
}`);
    writeFileSync(join(projectDir, 'domains', 'customer', 'blocks', 'profile.dql'), `block "Customer Profile" {
  domain = "Customer"
  type = "custom"
  pattern = "entity_profile"
  grain = "customer_id"
  entities = ["Customer"]
  outputs = ["customer_id"]
  query = """SELECT customer_id FROM dim_customer"""
}`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runDoctor('scale', {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: '',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.counts.domains).toBe(1);
    expect(report.counts.blocks).toBe(1);
    expect(report.counts.dbtModels).toBe(1);
    expect(report.counts.lineageNodes).toBeGreaterThan(0);
    expect(report.issues.some((issue: { code: string }) => issue.code === 'metadata_catalog_missing')).toBe(true);
  });

  it('runs scale checks against an explicit project path', async () => {
    const projectDir = makeProject('dql-doctor-scale-explicit-');
    mkdirSync(join(projectDir, 'domains', 'revenue', 'blocks'), { recursive: true });
    mkdirSync(join(projectDir, 'semantic-layer', 'dimensions'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'semantic-layer', 'dimensions', 'account.yaml'), `name: account_id
label: Account Id
table: revenue_snapshot
sql: account_id
type: string
`);
    writeFileSync(join(projectDir, 'domains', 'revenue', 'domain.dql'), `domain "Revenue" {
  owner = "finance-analytics"
}`);
    writeFileSync(join(projectDir, 'domains', 'revenue', 'blocks', 'arr.dql'), `block "ARR Snapshot" {
  domain = "Revenue"
  type = "custom"
  status = "certified"
  pattern = "metric_wrapper"
  grain = "account_id"
  outputs = ["account_id", "arr"]
  query = """SELECT account_id, arr FROM revenue_snapshot"""
}`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor('scale', {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false, version: false,
    }, [projectDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.projectRoot).toBe(projectDir);
    expect(report.counts.domains).toBe(1);
    expect(report.counts.blocks).toBe(1);
    expect(report.counts.certifiedBlocks).toBe(1);
    expect(report.counts.semanticDimensions).toBe(1);
  });

  it('does not report missing domain declarations for display-name and folder-slug aliases', async () => {
    const projectDir = makeProject('dql-doctor-scale-domain-alias-');
    mkdirSync(join(projectDir, 'domains', 'nba', 'blocks'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'domains', 'nba', 'domain.dql'), `domain "NBA" {
  owner = "sports-analytics"
  reviewCadence = "monthly"
}`);
    writeFileSync(join(projectDir, 'domains', 'nba', 'blocks', 'top_players.dql'), `block "Top Players" {
  domain = "nba"
  type = "custom"
  pattern = "ranking"
  grain = "player_name"
  outputs = ["player_name", "total_points"]
  query = """SELECT player_name, total_points FROM player_points"""
}`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runDoctor('scale', {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: '',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.issues.some((issue: { code: string; message: string }) =>
      issue.code === 'missing_domain_declarations' && issue.message.includes('nba'),
    )).toBe(false);
  });

  it('surfaces top rejected evidence when retrieval caps exclude matching metadata', async () => {
    const projectDir = makeProject('dql-doctor-scale-rejected-');
    mkdirSync(join(projectDir, 'blocks'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    for (let index = 1; index <= 32; index += 1) {
      writeFileSync(join(projectDir, 'blocks', `coverage_${index}.dql`), `block "Enterprise Metadata Coverage ${index}" {
  domain = "ops"
  type = "custom"
  status = "${index % 2 === 0 ? 'certified' : 'draft'}"
  description = "Enterprise metadata coverage retrieval check ${index}"
  owner = "analytics"
  tags = ["enterprise", "metadata", "coverage"]
  pattern = "ranking"
  grain = "object_id"
  outputs = ["object_id", "score"]
  query = """SELECT ${index} AS object_id, ${index} AS score"""
}`);
    }
    await ensureMetadataCatalogFresh(projectDir, { force: true });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runDoctor('scale', {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: '',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.cache.contextPackObjects).toBeGreaterThan(0);
    expect(report.retrieval.topRejectedEvidence.length).toBeGreaterThan(0);
    expect(report.retrieval.topRejectedEvidence[0]).toEqual(expect.objectContaining({
      objectKey: expect.stringContaining('Enterprise Metadata Coverage'),
      reason: expect.stringContaining('Outside balanced context window'),
    }));
  });

  it('flags tracked local/generated files in git hygiene mode', async () => {
    const projectDir = makeProject('dql-doctor-git-hygiene-');
    mkdirSync(join(projectDir, '.dql', 'cache'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'dql-manifest.json'), JSON.stringify({ generated: true }));
    writeFileSync(join(projectDir, 'analysis.run.json'), JSON.stringify({ rows: [] }));
    writeFileSync(join(projectDir, '.dql', 'cache', 'metadata.sqlite'), 'sqlite');
    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runDoctor('git-hygiene', {
        check: false,
        chart: '',
        domain: '',
        format: 'json',
        help: false,
        open: null,
        input: '',
        outDir: '',
        owner: '',
        port: null,
        queryOnly: false,
        template: '',
        connection: '',
        verbose: false,
        skipTests: false, version: false,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      'compiled_manifest_tracked',
      'run_snapshot_tracked',
      'cache_tracked',
      'database_file_tracked',
    ]));
  });

  it('runs git hygiene checks against an explicit project path', async () => {
    const projectDir = makeProject('dql-doctor-git-hygiene-explicit-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, 'dql-manifest.json'), JSON.stringify({ generated: true }));
    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor('git-hygiene', {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false, version: false,
    }, [projectDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.projectRoot).toBe(projectDir);
    expect(report.issues.map((issue: { code: string }) => issue.code)).toContain('compiled_manifest_tracked');
  });

  it('fails git hygiene when a legacy broad .dql rule hides governed Hint Graph evidence (UI-001, SEC-001, E2E-001)', async () => {
    const projectDir = makeProject('dql-doctor-hidden-hints-');
    mkdirSync(join(projectDir, '.dql', 'hints'), { recursive: true });
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    writeFileSync(join(projectDir, '.gitignore'), '.dql/\n');
    writeFileSync(join(projectDir, '.dql', 'hints', 'customer-region.hint.yaml'), 'version: 3\nid: customer-region\nstatus: approved\n');
    execFileSync('git', ['init'], { cwd: projectDir });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor('git-hygiene', {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir: '',
      owner: '',
      port: null,
      queryOnly: false,
      template: '',
      connection: '',
      verbose: false,
      skipTests: false, version: false,
    }, [projectDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'broad_dql_ignore', path: '.gitignore' }),
      expect.objectContaining({ code: 'governed_source_ignored', path: '.dql/hints/customer-region.hint.yaml' }),
    ]));
    expect(report.commitPolicy.durable).toContain('.dql/hints/**/*.hint.yaml');
    expect(report.commitPolicy.durable).toContain('.dql/evaluations/**/*.hint-evaluation.yaml');
  });
});

// New-user round 2, problem 10: sync said 19 metrics, Setup 19, doctor 24 (19 metrics + 5 measures).
describe('metric counts read the same as sync and Setup', () => {
  it('names dbt metrics and the measures ZLens adds separately', () => {
    const metric = { source: { objectType: 'metric' } };
    const measure = { source: { objectType: 'measure' } };
    expect(semanticMetricWords([...Array(19)].map(() => metric).concat([...Array(5)].map(() => measure)))).toBe('19 metrics and 5 measures');
    expect(semanticMetricWords([metric])).toBe('1 metric');
    expect(semanticMetricWords([metric, metric, {}])).toBe('3 metrics');
    expect(semanticMetricWords([metric, measure])).toBe('1 metric and 1 measure');
  });
});
