import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelingModeOf } from '@zlens/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import { acceptsCreate, bareFolderCommand, decideBareFolder } from './bare-folder.js';
import { ensureNotebookProject } from './notebook.js';

const FLAGS = {
  check: false,
  chart: '',
  domain: '',
  format: 'text',
  help: false,
  open: false,
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
} as CLIFlags;

const roots: string[] = [];
function bareFolder(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-bare-'));
  roots.push(root);
  const folder = join(root, 'shop');
  mkdirSync(folder);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  return folder;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('zlens notebook on a folder with no ZLens project (D7)', () => {
  const database = { isDbt: false, dbtProjectDir: null, duckdbPath: 'jaffle_shop.duckdb' };

  it('asks "No ZLens project here. Create one? [Y/n]" in a terminal; Enter and y create it', async () => {
    const ask = vi.fn(async (_question: string) => '');
    await expect(decideBareFolder({ folder: '/work/shop', contents: database, yes: false, interactive: true, ask, cwd: '/work' })).resolves.toEqual({ action: 'create' });
    expect(ask.mock.calls[0]![0]).toContain('No ZLens project here. Create one? [Y/n]');
    expect(ask.mock.calls[0]![0]).toContain('Found the database jaffle_shop.duckdb; the project will be Database only.');
    expect(acceptsCreate('Y')).toBe(true);
    expect(acceptsCreate('yes')).toBe(true);
    expect(acceptsCreate('n')).toBe(false);
  });

  it('a "no" in the terminal creates nothing and says the one command to run later', async () => {
    const decision = await decideBareFolder({ folder: '/work/shop', contents: database, yes: false, interactive: true, ask: async () => 'n', cwd: '/work' });
    expect(decision).toEqual({ action: 'declined', message: 'Nothing was created. To create it later, run:\n\n  npx -p @zlens/cli zlens notebook shop --yes' });
  });

  it('without a terminal it never waits for an answer and prints the single command', async () => {
    const ask = vi.fn(async (_question: string) => 'y');
    const decision = await decideBareFolder({ folder: '/work/my shop', contents: database, yes: false, interactive: false, ask, cwd: '/work' });
    expect(ask).not.toHaveBeenCalled();
    expect(decision.action).toBe('explain');
    expect(decision.action === 'explain' && decision.message).toBe([
      'No ZLens project here: /work/my shop (found the database jaffle_shop.duckdb).',
      'To create one and open it, run:',
      '',
      '  npx -p @zlens/cli zlens notebook "my shop" --yes',
    ].join('\n'));
  });

  it('names a SQLite file or a folder of data files in the question', async () => {
    const ask = vi.fn(async (_question: string) => '');
    await decideBareFolder({ folder: '/work/shop', contents: { isDbt: false, dbtProjectDir: null, duckdbPath: null, sqlitePath: 'shop.sqlite' }, yes: false, interactive: true, ask, cwd: '/work' });
    expect(ask.mock.calls[0]![0]).toContain('Found the database shop.sqlite; the project will be Database only.');
    const files = { isDbt: false, dbtProjectDir: null, duckdbPath: null, dataFolder: { path: '.', files: ['customers.csv', 'items.csv', 'orders.csv', 'stores.csv'] } };
    await decideBareFolder({ folder: '/work/shop', contents: files, yes: false, interactive: true, ask, cwd: '/work' });
    expect(ask.mock.calls[1]![0]).toContain('Found 4 data files: customers.csv, items.csv, orders.csv, …; the project will be Database only, each file a table.');
  });

  it('says what it found but does not read as tables yet, in the question and in the message', async () => {
    const ask = vi.fn(async (_question: string) => '');
    const contents = {
      isDbt: false, dbtProjectDir: null, duckdbPath: null,
      dataFolder: { path: '.', files: ['orders.parquet'] },
      notReadYet: { path: '.', items: [
        { name: 'customers_delta/', kind: 'a Delta Lake table' },
        { name: 'events/', kind: 'a folder of 20 Parquet files, partitioned by year' },
        { name: 'orders_iceberg/', kind: 'an Iceberg table' },
        { name: 'targets.xlsx', kind: 'an Excel workbook' },
      ] },
    };
    await decideBareFolder({ folder: '/work/lake', contents, yes: false, interactive: true, ask, cwd: '/work' });
    expect(ask.mock.calls[0]![0]).toContain('Not read as tables yet: customers_delta/ (a Delta Lake table), events/ (a folder of 20 Parquet files, partitioned by year), orders_iceberg/ (an Iceberg table), …and 1 more.');
    const decision = await decideBareFolder({ folder: '/work/lake', contents, yes: false, interactive: false, cwd: '/work' });
    expect(decision.action === 'explain' && decision.message.split('\n')[1]).toMatch(/^Not read as tables yet: customers_delta\//);
  });

  it('--yes creates without asking', async () => {
    const ask = vi.fn(async (_question: string) => 'n');
    await expect(decideBareFolder({ folder: '/work/shop', contents: database, yes: true, interactive: true, ask })).resolves.toEqual({ action: 'create' });
    expect(ask).not.toHaveBeenCalled();
    expect(bareFolderCommand('/work', '/work')).toBe('npx -p @zlens/cli zlens notebook . --yes');
  });

  it('creates a Database only project from a folder with a DuckDB file, after a yes in the terminal', async () => {
    const folder = bareFolder({ 'jaffle_shop.duckdb': '' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await ensureNotebookProject(folder, FLAGS, { interactive: true, ask: async () => 'y' });
    expect(root).toBe(folder);
    const config = JSON.parse(readFileSync(join(folder, 'dql.config.json'), 'utf8'));
    expect(config.modeling).toEqual({ mode: 'warehouse-first' });
    expect(config.connections.default).toEqual({ driver: 'duckdb', filepath: 'jaffle_shop.duckdb' });
    expect(config.dbt).toBeUndefined();
  });

  it('creates a dbt project when the folder has dbt_project.yml', async () => {
    const folder = bareFolder({ 'dbt_project.yml': 'name: shop\n', 'dev.duckdb': '' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await ensureNotebookProject(folder, { ...FLAGS, yes: true }, { interactive: false });
    const config = JSON.parse(readFileSync(join(folder, 'dql.config.json'), 'utf8'));
    // No mode is written: it follows from the dbt project (simplification plan Z2).
    expect(config.modeling).toBeUndefined();
    expect(modelingModeOf(config)).toBe('dbt-first');
    expect(config.semanticLayer.provider).toBe('dbt');
  });

  it('without a terminal and without --yes it creates nothing and fails with the command', async () => {
    const folder = bareFolder({ 'jaffle_shop.duckdb': '' });
    await expect(ensureNotebookProject(folder, FLAGS, { interactive: false })).rejects.toThrow(/To create one and open it, run:\n\n {2}npx -p @zlens\/cli zlens notebook .* --yes/);
    expect(existsSync(join(folder, 'dql.config.json'))).toBe(false);
  });

  it('opens an existing project without asking', async () => {
    const folder = bareFolder({ 'dql.config.json': '{"project":"shop"}' });
    const ask = vi.fn(async (_question: string) => 'n');
    await expect(ensureNotebookProject(folder, FLAGS, { interactive: true, ask })).resolves.toBe(folder);
    expect(ask).not.toHaveBeenCalled();
  });
});
