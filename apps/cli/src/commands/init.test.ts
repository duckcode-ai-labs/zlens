import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelingModeOf } from '@zlens/core';
import { describe, expect, it, vi } from 'vitest';
import { detectFolderContents, initProjectKind, runInit } from './init.js';
import { describeDatabase } from './bare-folder.js';
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
    // No mode is written: it follows from the dbt project (simplification plan Z2).
    expect(config.modeling).toBeUndefined();
    expect(modelingModeOf(config)).toBe('dbt-first');
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
    // No mode is written: it follows from the dbt project (simplification plan Z2).
    expect(config.modeling).toBeUndefined();
    expect(modelingModeOf(config)).toBe('dbt-first');
  });

  it('--warehouse-first models the database even beside a dbt project, and still finds its DuckDB file', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dql-init-dbt-warehouse-first-'));
    const dqlDir = join(repoDir, 'dql');
    writeFileSync(join(repoDir, 'dbt_project.yml'), 'name: "nba"\n');
    writeFileSync(join(repoDir, 'nba.duckdb'), '');

    await runInit(dqlDir, { ...INIT_FLAGS, warehouseFirst: true });

    const config = JSON.parse(readFileSync(join(dqlDir, 'dql.config.json'), 'utf-8'));
    expect(config.modeling).toEqual({ mode: 'warehouse-first' });
    expect(config.manifestVersion).toBe(3);
    expect(config.dbt).toBeUndefined();
    expect(config.semanticLayer).toEqual({ provider: 'dql' });
    expect(config.connections.default).toEqual({ driver: 'duckdb', filepath: '../nba.duckdb' });
    expect(detectFolderContents(dqlDir, { warehouseFirst: true })).toMatchObject({ isDbt: false, dbtProjectDir: null });
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
    // No mode is written: it follows from the dbt project (simplification plan Z2).
    expect(config.modeling).toBeUndefined();
    expect(modelingModeOf(config)).toBe('dbt-first');
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
    expect(detectFolderContents(projectDir).dataFolder).toMatchObject({ path: 'data', files: ['customers.parquet', 'orders.csv'], catalogs: [] });
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

  it('reads a lake folder: Delta and Iceberg tables and partitioned folders are tables, one line each, and it says what it skips', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-lake-'));
    const put = (path: string, content = '') => {
      mkdirSync(join(projectDir, path, '..'), { recursive: true });
      writeFileSync(join(projectDir, path), content);
    };
    put('orders.parquet');
    put('customers.csv', 'id\n1\n');
    put('customers_delta/_delta_log/00000000000000000000.json', '{}');
    put('customers_delta/part-0.parquet');
    put('orders_iceberg/metadata/00001-abc.metadata.json', '{}');
    put('orders_iceberg/data/00000-0.parquet');
    put('order_events/year=2024/month=1/part-0.parquet');
    put('order_events/year=2025/month=2/part-0.parquet');
    put('lake.ducklake');
    put('clicks.avro');
    put('targets.xlsx');
    put('notes/readme.md', 'not data');
    put('node_modules/pkg/data.csv', 'a\n1\n');
    const contents = detectFolderContents(projectDir);
    expect(contents.dataFolder).toEqual({
      path: '.',
      files: ['customers_delta/', 'customers.csv', 'order_events/', 'orders_iceberg/', 'orders.parquet'],
      tables: [
        { name: 'customers_delta', source: 'customers_delta/', kind: 'Delta Lake table' },
        { name: 'customers', source: 'customers.csv', kind: 'CSV file' },
        { name: 'order_events', source: 'order_events/', kind: '2 Parquet files, partitioned by year, month' },
        { name: 'orders_iceberg', source: 'orders_iceberg/', kind: 'Iceberg table (version 1)' },
        { name: 'orders', source: 'orders.parquet', kind: 'Parquet file' },
      ],
      catalogs: [{ name: 'lake', source: 'lake.ducklake', kind: 'DuckLake catalog, attached as lake' }],
    });
    expect(contents.notReadYet).toEqual({
      path: '.',
      items: [
        { name: 'clicks.avro', kind: 'an Avro file (not read yet)' },
        { name: 'targets.xlsx', kind: 'an Excel workbook ZLens could not open' },
      ],
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('Data files: 5 tables and 1 database file: customers_delta/, customers.csv, order_events/, …');
      expect(output).toContain('Tables (one per file, sheet or folder):');
      expect(output).toMatch(/customers_delta\s+customers_delta\/\s+Delta Lake table/);
      expect(output).toMatch(/orders_iceberg\s+orders_iceberg\/\s+Iceberg table \(version 1\)/);
      expect(output).toMatch(/order_events\s+order_events\/\s+2 Parquet files, partitioned by year, month/);
      expect(output).toContain('Attached read-only (their tables are catalog.schema.table):');
      expect(output).toMatch(/lake\s+lake\.ducklake\s+DuckLake catalog/);
      expect(output).toContain('Not read as tables:');
      expect(output).toMatch(/clicks\.avro\s+an Avro file \(not read yet\)/);
      expect(output).toContain('Project type: Database only');
      expect(output).not.toContain('node_modules');
      expect(output).not.toContain('notes/');
    } finally {
      spy.mockRestore();
    }
    const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf-8'));
    expect(config.connections.default).toEqual({ driver: 'file', filepath: ':memory:', dataFolder: '.' });
  });

  it('makes a folder holding only a lake table a Database only project', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-lake-only-'));
    mkdirSync(join(projectDir, 'data', 'sales_delta', '_delta_log'), { recursive: true });
    writeFileSync(join(projectDir, 'data', 'sales_delta', '_delta_log', '00000000000000000000.json'), '{}');
    const contents = detectFolderContents(projectDir);
    expect(contents.dataFolder).toMatchObject({ path: 'data', files: ['sales_delta/'] });
    expect(describeDatabase(contents)).toBe('1 table in data/: sales_delta/');
    expect(initProjectKind(contents)).toBe('database');
  });

  it('names what it skips even when there is nothing it reads, and leaves the project undecided', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-skipped-only-'));
    mkdirSync(join(projectDir, 'data'), { recursive: true });
    writeFileSync(join(projectDir, 'data', 'clicks.avro'), '');
    const contents = detectFolderContents(projectDir);
    expect(contents.dataFolder).toBeNull();
    expect(contents.notReadYet).toEqual({ path: 'data', items: [{ name: 'clicks.avro', kind: 'an Avro file (not read yet)' }] });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('Data files: none that ZLens reads as tables');
      expect(output).toContain('Not read as tables in data/:');
      expect(output).toContain('Guided Setup asks whether you use dbt or a database only');
    } finally {
      spy.mockRestore();
    }
  });

  it('adds the not-read line to the one-line summary that zlens notebook and npm create zlens print', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-init-lake-summary-'));
    writeFileSync(join(projectDir, 'orders.csv'), 'id\n1\n');
    writeFileSync(join(projectDir, 'clicks.avro'), '');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInit(projectDir, { ...INIT_FLAGS, format: 'text' }, { output: 'summary' });
      const output = spy.mock.calls.flat().join('\n');
      expect(output).toContain('Database only · 1 data file: orders.csv');
      expect(output).toContain('Not read as tables: clicks.avro (an Avro file (not read yet)).');
    } finally {
      spy.mockRestore();
    }
  });

  it('says nothing about lake folders beside a dbt project or a database file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-init-lake-dbt-'));
    writeFileSync(join(root, 'dbt_project.yml'), 'name: shop\n');
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'run.parquet'), '');
    mkdirSync(join(root, 'exports'), { recursive: true });
    writeFileSync(join(root, 'exports', 'a.csv'), 'a\n1\n');
    expect(detectFolderContents(root).notReadYet).toBeNull();
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
