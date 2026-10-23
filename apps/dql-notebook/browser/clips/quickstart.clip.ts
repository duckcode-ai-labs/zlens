import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from '../support/server';
import { clip, expect } from './support/clip-test';
import { runCaptured, startCaptured, Terminal } from './support/terminal';

const SAMPLE_EXCLUDES = new Set(['.git', '.venv', 'dbt_packages', 'logs', 'node_modules', '.dql', 'dql-manifest.json', '.zlens-clips-built']);

/**
 * Get started, as the README and the quickstart do it: the Jaffle Shop sample
 * (dbt already built) is itself a ZLens workspace, so in its folder run
 * `npm install`, install the DuckDB driver, `npm run sync` and
 * `npm run notebook`, walk Guided Setup (the dbt project at `.`, the sample's
 * DuckDB connection already configured and tested), and run a first query.
 *
 * Every command is really run. `npm install` installs the @zlens/cli the
 * sample's package.json names; after it, the folder's `zlens` command is
 * pointed at this repo's build, so the sync and the workbench shown are the
 * current source.
 */
clip('quickstart', async ({ page, sample, director }) => {
  const sampleDir = join(sample.workDir, 'jaffle-shop-duckdb');
  cpSync(sample.cloneDir, sampleDir, {
    recursive: true,
    filter: (source) => !SAMPLE_EXCLUDES.has(source.slice(sample.cloneDir.length + 1).split('/')[0] ?? ''),
  });
  // No browser may open on the recording machine: `zlens notebook` opens one with `open`/`xdg-open`.
  const shims = join(sample.workDir, 'shims');
  mkdirSync(shims, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(shims, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(shims, name), 0o755);
  }
  const env = {
    ...sample.gitEnv,
    PATH: `${shims}:${process.env.PATH ?? ''}`,
    ZLENS_METRICFLOW_BIN: join(sample.workDir, 'no-metricflow', 'mf'),
    npm_config_update_notifier: 'false',
  };
  const terminal = new Terminal(page, director, [[dirname(sampleDir), '~']]);

  await terminal.open('jaffle-shop-duckdb — zsh');
  await director.recorder.begin();

  await terminal.prompt('~/jaffle-shop-duckdb');
  await terminal.type('npm install');
  director.recorder.cutStart();
  const install = runCaptured('npm install --no-audit --no-fund', { cwd: sampleDir, env });
  director.recorder.cutEnd();
  expect(install.status, install.output).toBe(0);
  await terminal.print(install.output);
  // Show the current source: the folder's `zlens` command runs this repo's build.
  const bin = join(sampleDir, 'node_modules', '.bin', 'zlens');
  rmSync(bin, { force: true });
  writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(repoRoot, 'apps', 'cli', 'dist', 'index.js'))} "$@"\n`);
  chmodSync(bin, 0o755);

  await terminal.prompt('~/jaffle-shop-duckdb');
  await terminal.type('npm install --prefix .dql/connectors duckdb');
  director.recorder.cutStart();
  const driver = runCaptured('npm install --prefix .dql/connectors --no-audit --no-fund duckdb', { cwd: sampleDir, env });
  director.recorder.cutEnd();
  expect(driver.status, driver.output).toBe(0);
  await terminal.print(driver.output);

  await terminal.prompt('~/jaffle-shop-duckdb');
  await terminal.type('npm run sync');
  director.recorder.cutStart();
  const sync = runCaptured('npm run sync', { cwd: sampleDir, env });
  director.recorder.cutEnd();
  expect(sync.status, sync.output).toBe(0);
  expect(sync.output).toContain('dbt sync complete');
  await terminal.print(sync.output, 6);
  await director.beat(1000);

  await terminal.prompt('~/jaffle-shop-duckdb');
  await terminal.type('npm run notebook');
  director.recorder.cutStart();
  const server = await startCaptured('npm run notebook', { cwd: sampleDir, env, ready: /Notebook ready: (http:\/\/127\.0\.0\.1:\d+)/ });
  director.recorder.cutEnd();
  try {
    await terminal.print(server.output, 2);
    await director.beat(1500);

    // The workbench opens on Guided Setup: this folder is already a ZLens project on its dbt project.
    await page.goto(server.match[1]!);
    await expect(page.getByRole('radio', { name: /Open an existing ZLens project/ })).toBeChecked({ timeout: 60_000 });
    await director.settlePointer();
    await director.beat(1600);
    await director.point(page.getByText(/already sets up the data model/).first());
    await director.beat(1200);
    await director.click(page.getByRole('button', { name: 'Continue to credentials' }));

    // The sample's DuckDB connection is already configured and tested.
    await director.fastForward(() => expect(page.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 }));
    await expect(page.getByText(/DuckDB · configured/).first()).toBeVisible();
    await director.beat(600);
    await director.point(page.getByText(/Test passed/).first());
    await director.beat(1600);
    await director.click(page.getByRole('button', { name: 'Continue to optional AI' }));
    await director.click(page.getByRole('button', { name: 'Skip AI for now' }));
    await director.click(page.getByRole('button', { name: 'Finish setup' }), { after: 900 });

    // A first query against a dbt model, in the starter notebook.
    await director.click(page.getByRole('button', { name: 'Notebooks', exact: true }).first());
    await director.click(page.getByRole('button', { name: /^welcome/ }).first(), { after: 900 });
    const editor = page.locator('.cm-content').first();
    await editor.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await director.beat(700);
    await director.click(editor, { after: 200 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('select customer_name, lifetime_spend from dev.customers order by 2 desc limit 5', { delay: 20 });
    await page.keyboard.press('Escape');
    await director.press('Shift+Enter', 300);
    await director.fastForward(() => expect(page.getByText('Trust & Steps').first()).toBeVisible({ timeout: 60_000 }));
    await page.getByText('Trust & Steps').first().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await director.beat(900);
    director.poster();
    await director.beat(2600);
  } finally {
    server.stop();
  }
});
