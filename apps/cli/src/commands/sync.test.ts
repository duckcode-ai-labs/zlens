import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompile } from './compile.js';
import { readDbtCounts, runSync } from './sync.js';

const baseFlags = {
  format: 'text' as const,
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
};

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-sync-'));
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  mkdirSync(join(root, 'blocks'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'revenue.dql'),
    `block "Revenue" {
  domain = "sales"
  type = "custom"
  query = """SELECT SUM(amount) AS revenue FROM orders"""
}`,
  );
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      nodes: {
        'model.demo.orders': {
          resource_type: 'model',
          name: 'orders',
          alias: 'orders',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: [] },
          tags: [],
        },
      },
      sources: {},
      metadata: { project_name: 'demo' },
    }),
  );
  return root;
}

describe('runSync dbt', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    process.exitCode = 0;
  });

  it('reports cold cache when no prior compile has run', async () => {
    const root = seedProject();
    try {
      await runSync('dbt', [root], baseFlags);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toMatch(/cold/i);
      expect(output).toMatch(/1 model/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports cache HIT when nothing has changed since compile', async () => {
    const root = seedProject();
    try {
      await runCompile(root, [], baseFlags);
      log.mockClear();
      await runSync('dbt', [root], baseFlags);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toMatch(/HIT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a prepared agent snapshot warm when dbt inputs are unchanged', async () => {
    const root = seedProject();
    try {
      // The first sync compiles and prepares the manifest, metadata, and KG.
      await runSync('dbt', [root], baseFlags);
      const manifestPath = join(root, 'dql-manifest.json');
      const firstMtime = statSync(manifestPath).mtimeMs;

      log.mockClear();
      await runSync('dbt', [root], baseFlags);
      const output = log.mock.calls.flat().join('\n');

      expect(output).toMatch(/Cache: HIT/);
      expect(output).toMatch(/reused the matching manifest, metadata catalog, and agent index/i);
      // The unchanged compile must not invalidate source-versioned readiness by
      // rewriting identical generated JSON.
      expect(statSync(manifestPath).mtimeMs).toBe(firstMtime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports MISS with a changed-files list when a tracked file is edited', async () => {
    const root = seedProject();
    try {
      await runCompile(root, [], baseFlags);
      writeFileSync(
        join(root, 'blocks', 'revenue.dql'),
        `block "Revenue" {
  domain = "sales"
  type = "custom"
  query = """SELECT COUNT(*) AS revenue FROM orders"""
}`,
      );
      log.mockClear();
      await runSync('dbt', [root], baseFlags);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toMatch(/MISS/);
      expect(output).toMatch(/revenue\.dql/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--clear wipes the cache', async () => {
    const root = seedProject();
    try {
      await runCompile(root, [], baseFlags);
      const cachePath = join(root, '.dql', 'cache', 'manifest.sqlite');
      expect(existsSync(cachePath)).toBe(true);

      log.mockClear();
      await runSync('dbt', [root, '--clear'], baseFlags);
      // File persists (SQLite schema stays) but entries are gone.
      // Re-running sync should report cold-cache behavior (empty diff path).
      log.mockClear();
      await runSync('dbt', [root], baseFlags);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toMatch(/MISS|cold/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('errors when no dbt manifest is available', async () => {
    const root = seedProject();
    rmSync(join(root, 'target'), { recursive: true, force: true });
    try {
      await runSync('dbt', [root], baseFlags);
      const output = err.mock.calls.flat().join('\n');
      expect(output).toMatch(/dbt manifest/i);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown subcommand', async () => {
    await runSync('models', [], baseFlags);
    const output = err.mock.calls.flat().join('\n');
    expect(output).toMatch(/Usage/);
    expect(process.exitCode).toBe(1);
  });
});

describe('dbt counts (new-user round 2, problem 10)', () => {
  it('counts dbt metrics from the manifest, or from semantic_manifest.json when the manifest has none, and never says 0 for an unreadable file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-sync-counts-'));
    try {
      const manifest = join(root, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ nodes: { a: { resource_type: 'model' } }, metrics: { 'metric.x.revenue': {}, 'metric.x.orders': {} }, semantic_models: { s: {} } }));
      expect(readDbtCounts(manifest)).toEqual({ models: 1, sources: 0, metrics: 2, semanticModels: 1 });
      writeFileSync(manifest, JSON.stringify({ nodes: {} }));
      writeFileSync(join(root, 'semantic_manifest.json'), JSON.stringify({ metrics: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }));
      expect(readDbtCounts(manifest).metrics).toBe(3);
      writeFileSync(manifest, '{ not json');
      expect(readDbtCounts(manifest)).toMatchObject({ unreadable: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
