import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { detectFolderContents, runInit } from './init.js';
import { loadSkills } from '@zlens/agent';

const INIT_FLAGS = {
  check: false,
  chart: '',
  domain: '',
  format: 'json' as const,
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
  skipTests: false,
  version: false,
};

const DBT_SEMANTIC_YAML = `semantic_models:
  - name: orders
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: ordered_at
    entities:
      - name: order
        type: primary
        expr: order_id
    dimensions:
      - name: ordered_at
        type: time
        type_params:
          time_granularity: day
    measures:
      - name: order_total
        agg: sum
        expr: order_total
metrics:
  - name: order_total
    type: simple
    type_params:
      measure: order_total
`;

describe('runInit', () => {
  it('prints project-local-safe next commands for existing-repo installs (E2E-005)', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-init-commands-'));
    const projectDir = join(targetDir, 'demo-project');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });

      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('npx zlens doctor');
      expect(output).toContain('npx zlens notebook');
    } finally {
      spy.mockRestore();
    }
  });

  it('scaffolds a domain-first OSS project with visible shared skills', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'dql-init-'));
    const projectDir = join(targetDir, 'demo-project');

    await runInit(projectDir, INIT_FLAGS);

    const contents = readdirSync(projectDir);
    expect(contents).toContain('apps');
    expect(contents).toContain('domains');
    expect(contents).toContain('skills');
    expect(contents).toContain('tests');
    expect(contents).toContain('dql.config.json');
    expect(contents).toContain('notebooks');

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      project: string;
      connections?: Record<string, unknown>;
    };
    expect(config.project).toBe('demo-project');
    expect(config.connections).toBeUndefined();
    // New projects opt in to field-based Dataset tiles (APP-007 keeps
    // existing projects off until their owner turns it on).
    expect((config as { apps?: { datasets?: boolean } }).apps).toEqual({ datasets: true });

    const notebook = readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8');
    expect(notebook).toContain('DQL');
    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('**/.dql/cache/');
    expect(gitignore.split(/\r?\n/).map((line) => line.trim())).not.toContain('.dql/');

    // `zlens init` seeds the editable starter skills (spec 16).
    expect(loadSkills(projectDir).skills.map((skill) => skill.id).sort()).toEqual([
      'block-authoring',
      'domain-rules',
      'metrics-glossary',
      'sql-conventions',
    ]);
  });

  it('detects a Jaffle Shop-style dbt project and DuckDB file', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-'));
    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');

    await runInit(projectDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      defaultConnectionName: string;
      connections: { default: { filepath: string } };
      semanticLayer: { provider: string; projectPath: string };
      manifestVersion: number;
      modeling: { mode: string };
      dbt: { projectDir: string; manifestPath: string };
    };

    expect(config.defaultConnectionName).toBe('default');
    expect(config.connections.default.filepath).toBe('jaffle_shop.duckdb');
    expect(config.semanticLayer.provider).toBe('dbt');
    expect(config.semanticLayer.projectPath).toBe('.');
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
    expect(config.dbt).toEqual({ projectDir: '.', manifestPath: 'target/manifest.json' });
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });

  it('keeps DQL isolated under ./dql while wiring to a parent dbt repo', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-parent-'));
    const dqlDir = join(repoDir, 'dql');
    writeFileSync(join(repoDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');

    await runInit(dqlDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(dqlDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath: string };
      dbt: { projectDir: string; manifestPath: string };
      manifestVersion: number;
      modeling: { mode: string };
    };
    const contents = readdirSync(dqlDir);

    expect(contents).toContain('apps');
    expect(contents).toContain('domains');
    expect(contents).toContain('skills');
    expect(contents).toContain('tests');
    expect(contents).toContain('notebooks');
    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '..' });
    expect(config.dbt).toEqual({ projectDir: '..', manifestPath: 'target/manifest.json' });
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
  });

  it('keeps dbt semantic definitions read-only instead of copying them into DQL', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-semantic-'));
    const metricsDir = join(projectDir, 'models', 'metrics');
    mkdirSync(metricsDir, { recursive: true });

    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');
    writeFileSync(join(metricsDir, 'orders.yml'), DBT_SEMANTIC_YAML);

    await runInit(projectDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath?: string };
      manifestVersion: number;
      modeling: { mode: string };
    };

    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '.' });
    expect(config.manifestVersion).toBe(3);
    expect(config.modeling).toEqual({ mode: 'dbt-first' });
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });

  it('references parent dbt semantic definitions without importing local copies', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-parent-semantic-'));
    const dqlDir = join(repoDir, 'dql');
    const metricsDir = join(repoDir, 'models', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(repoDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(metricsDir, 'orders.yml'), DBT_SEMANTIC_YAML);

    await runInit(dqlDir, INIT_FLAGS);

    const config = JSON.parse(readFileSync(join(dqlDir, 'dql.config.json'), 'utf-8')) as {
      semanticLayer: { provider: string; projectPath?: string };
      dbt: { projectDir: string; manifestPath: string };
    };

    expect(config.semanticLayer).toEqual({ provider: 'dbt', projectPath: '..' });
    expect(config.dbt).toEqual({ projectDir: '..', manifestPath: 'target/manifest.json' });
    expect(readdirSync(dqlDir)).not.toContain('semantic-layer');
  });

  it('preserves an existing project config and content when force only patches missing directories', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-existing-'));
    const originalConfig = {
      project: 'legacy-project',
      manifestVersion: 2,
      semanticLayer: { provider: 'dql', path: './semantic-layer' },
    };
    writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: "jaffle_shop"\n');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify(originalConfig, null, 2) + '\n');
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n.dql/\n');
    mkdirSync(join(projectDir, 'notebooks'), { recursive: true });
    writeFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'existing notebook\n');

    await runInit(projectDir, { ...INIT_FLAGS, force: true });

    expect(JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'))).toEqual(originalConfig);
    expect(readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8')).toBe('existing notebook\n');
    expect(readdirSync(projectDir)).toEqual(expect.arrayContaining(['apps', 'domains', 'skills', 'tests']));
    expect(readdirSync(join(projectDir, 'skills'))).toEqual([]);
    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('**/.dql/cache/');
    expect(gitignore).toContain('**/.dql/connectors/');
    expect(gitignore.split(/\r?\n/).map((line) => line.trim())).not.toContain('.dql/');
    expect(readdirSync(projectDir)).not.toContain('semantic-layer');
  });
  it('makes a folder with only a database file a Database only project, with no conflicting --warehouse-first advice (D7)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-db-only-'));
    const projectDir = join(root, 'shop');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('DuckDB file: jaffle_shop.duckdb');
      expect(output).toContain('Project type: Database only');
      expect(output).not.toContain('--warehouse-first');
      expect(output).not.toContain('No dbt project?');
    } finally {
      spy.mockRestore();
    }
    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'));
    expect(config.modeling).toEqual({ mode: 'warehouse-first' });
    expect(config.manifestVersion).toBe(3);
    expect(config.semanticLayer).toEqual({ provider: 'dql' });
    expect(config.connections.default).toEqual({ driver: 'duckdb', filepath: 'jaffle_shop.duckdb' });
    expect(config.dbt).toBeUndefined();
  });

  it('makes a folder with a SQLite file a Database only project; a .db file is read by its header', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-sqlite-'));
    const projectDir = join(root, 'shop');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'notes.db'), 'not a database');
    writeFileSync(join(projectDir, 'shop.db'), Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(84)]));
    expect(detectFolderContents(projectDir)).toMatchObject({ isDbt: false, duckdbPath: null, sqlitePath: 'shop.db', dataFolder: null });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('SQLite file: shop.db');
      expect(output).toContain('Project type: Database only');
    } finally {
      spy.mockRestore();
    }
    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'));
    expect(config.modeling).toEqual({ mode: 'warehouse-first' });
    expect(config.connections.default).toEqual({ driver: 'sqlite', filepath: 'shop.db' });
  });

  it('reads a .db file that DuckDB wrote as the DuckDB database', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-duckdb-db-'));
    const header = Buffer.alloc(64);
    header.write('DUCK', 8, 'latin1');
    writeFileSync(join(root, 'warehouse.db'), header);
    expect(detectFolderContents(root)).toMatchObject({ duckdbPath: 'warehouse.db', sqlitePath: null, dataFolder: null });
  });

  it('makes a folder of CSV or Parquet files a Database only project where each file is a table', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-files-'));
    const projectDir = join(root, 'shop');
    mkdirSync(join(projectDir, 'data'), { recursive: true });
    writeFileSync(join(projectDir, 'data', 'orders.csv'), 'id,amount\n1,10\n');
    writeFileSync(join(projectDir, 'data', 'customers.parquet'), '');
    writeFileSync(join(projectDir, 'data', 'notes.txt'), 'not data');
    writeFileSync(join(projectDir, 'README.md'), '# Shop');
    expect(detectFolderContents(projectDir).dataFolder).toEqual({ path: 'data', files: ['customers.parquet', 'orders.csv'] });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('Data files: 2 data files in data/: customers.parquet, orders.csv');
      expect(output).toContain('Project type: Database only');
    } finally {
      spy.mockRestore();
    }
    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'));
    expect(config.modeling).toEqual({ mode: 'warehouse-first' });
    expect(config.connections.default).toEqual({ driver: 'file', filepath: ':memory:', dataFolder: 'data' });
  });

  it('lets a dbt project or a database file win over data files beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-precedence-'));
    writeFileSync(join(root, 'export.csv'), 'a\n1\n');
    writeFileSync(join(root, 'shop.duckdb'), '');
    expect(detectFolderContents(root)).toMatchObject({ duckdbPath: 'shop.duckdb', sqlitePath: null, dataFolder: null });
    const dbt = mkdtempSync(join(tmpdir(), 'dql-init-precedence-dbt-'));
    writeFileSync(join(dbt, 'dbt_project.yml'), 'name: shop\n');
    writeFileSync(join(dbt, 'seed.csv'), 'a\n1\n');
    expect(detectFolderContents(dbt)).toMatchObject({ isDbt: true, dataFolder: null });
    // A tool's settings at the top of a folder are not data.
    const settings = mkdtempSync(join(tmpdir(), 'dql-init-settings-'));
    writeFileSync(join(settings, 'renovate.json'), '{}');
    writeFileSync(join(settings, 'vercel.json'), '{}');
    expect(detectFolderContents(settings).dataFolder).toBeNull();
  });

  it('leaves an empty folder undecided for Guided Setup and never suggests a flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-empty-'));
    const projectDir = join(root, 'empty');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('Guided Setup asks whether you use dbt or a database only');
      expect(output).not.toContain('--warehouse-first');
    } finally {
      spy.mockRestore();
    }
    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'));
    expect(config.modeling).toBeUndefined();
    expect(config.connections).toBeUndefined();
  });

  it('does not create the "Example Customer Rollup" placeholder block in the welcome notebook (D7)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-welcome-'));
    const projectDir = join(root, 'shop');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'jaffle_shop.duckdb'), '');
    await runInit(projectDir, INIT_FLAGS);
    const welcome = readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf-8');
    expect(welcome).not.toContain('Example Customer Rollup');
    expect(welcome).not.toContain('"type": "dql"');
  });
});
