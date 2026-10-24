import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
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
