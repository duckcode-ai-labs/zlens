import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { startNotebookServer, type NotebookServer } from '../../support/server';
import { Director, prepareContext } from './director';
import { ScreencastRecorder } from './recorder';

/**
 * `clip(id, body)` — one feature clip. Each clip gets fresh copies of the
 * prepared sample project (see ./sample-project.ts and ../clips-setup.ts),
 * its own `zlens notebook` server, the pinned theme, a visible pointer, and a
 * screencast recorder writing to <work>/raw/<id>/ for scripts/docs-clips.mjs
 * to encode.
 *
 * Ask needs a model. Servers replay the clip's committed cassettes
 * (./cassettes/<id>/), which hold the real model responses recorded by
 * `pnpm docs:clips --record-ask`; a replay miss is an error, never a live
 * call. Recording uses the locally configured subscription provider
 * (ZLENS_CLIPS_PROVIDER, default claude-code) and never an API key.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const cassetteRoot = join(here, '..', 'cassettes');

export interface Sample {
  /** This clip's scratch dir (fresh each run). */
  workDir: string;
  /** The dbt-built clone of the Jaffle Shop sample (read-only). */
  cloneDir: string;
  /** The DuckDB connector directory to copy into other projects. */
  connectorsDir: string;
  /** A fresh copy of the prepared sample project. */
  freshProject(name?: string): string;
  /** Environment that makes git (and so ZLens's owner lookup) see the sample's analyst. */
  gitEnv: NodeJS.ProcessEnv;
  /**
   * Serve a project with `zlens notebook` (stopped after the clip). `ai: false`
   * serves it with no AI provider and no cassettes, so AI features use the
   * built-in planner and nothing reaches a model, even with --record-ask.
   */
  serve(projectDir: string, options?: { ai?: boolean }): Promise<NotebookServer>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the clips through \`pnpm docs:clips\` (clips-setup.ts sets it).`);
  return value;
}

/** Blanks every AI provider the server could pick up from the environment (as the browser journeys do). */
const NO_AI_PROVIDER: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ZLENS_OPENAI_COMPAT_API_KEY: '',
  OLLAMA_BASE_URL: '', OLLAMA_MODEL: '', ZLENS_EVAL_CASSETTE_DIR: '', ZLENS_EVAL_CASSETTE_MODE: '',
};

export function askMode(): 'replay' | 'record' {
  return process.env.ZLENS_CLIPS_ASK_MODE === 'record' ? 'record' : 'replay';
}

const test = base.extend<{ clipId: string; sample: Sample; director: Director }>({
  clipId: async ({}, use, testInfo) => {
    await use(testInfo.title);
  },

  sample: async ({ clipId }, use) => {
    const workDir = join(env('ZLENS_CLIPS_WORK_DIR'), 'runs', clipId);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const servers: NotebookServer[] = [];
    const cassettes = join(cassetteRoot, clipId);
    const mode = askMode();
    if (mode === 'record') rmSync(cassettes, { recursive: true, force: true });
    // Everything the clips run sees the sample's analyst as the git user, never the recorder's own identity.
    const gitConfig = join(workDir, 'gitconfig');
    writeFileSync(gitConfig, '[user]\n\tname = Jaffle Analyst\n\temail = analytics@jaffle.shop\n[init]\n\tdefaultBranch = main\n');
    const gitEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };

    const sample: Sample = {
      workDir,
      cloneDir: env('ZLENS_CLIPS_CLONE_DIR'),
      connectorsDir: env('ZLENS_CLIPS_CONNECTORS_DIR'),
      gitEnv,
      freshProject(name = 'jaffle-shop-duckdb') {
        const projectDir = join(workDir, name);
        cpSync(env('ZLENS_CLIPS_TEMPLATE_DIR'), projectDir, { recursive: true });
        return projectDir;
      },
      async serve(projectDir, { ai = true } = {}) {
        if (ai && mode === 'record') {
          // The provider the recording uses, set the way Settings → AI provider does.
          const provider = process.env.ZLENS_CLIPS_PROVIDER || 'claude-code';
          mkdirSync(join(projectDir, '.dql'), { recursive: true });
          writeFileSync(join(projectDir, '.dql', 'provider-settings.json'), `${JSON.stringify({
            version: 1,
            activeProvider: provider,
            providers: { [provider]: { id: provider, enabled: true, updatedAt: new Date().toISOString() } },
          }, null, 2)}\n`);
        }
        if (ai) mkdirSync(cassettes, { recursive: true });
        const server = await startNotebookServer({
          projectDir,
          workDir: join(workDir, `server-${servers.length + 1}`),
          env: ai
            ? { ...gitEnv, ZLENS_EVAL_CASSETTE_DIR: cassettes, ZLENS_EVAL_CASSETTE_MODE: mode }
            : { ...gitEnv, ...NO_AI_PROVIDER },
        });
        servers.push(server);
        return server;
      },
    };
    try {
      await use(sample);
    } finally {
      for (const server of servers) await server.stop();
    }
  },

  director: async ({ page, context, clipId }, use, testInfo) => {
    await prepareContext(context);
    const rawDir = join(env('ZLENS_CLIPS_WORK_DIR'), 'raw', clipId);
    rmSync(rawDir, { recursive: true, force: true });
    const recorder = new ScreencastRecorder(page, rawDir);
    const director = new Director(page, recorder);
    try {
      await use(director);
    } finally {
      // A failed journey leaves no timeline.json, so nothing half-recorded is encoded.
      await recorder.finish(testInfo.status === testInfo.expectedStatus);
    }
  },
});

/** Wait until the workbench has drawn with its real fonts (as the journeys do). */
export async function waitForWorkbench(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => {
      const inter = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Inter');
      return inter.length > 0 && inter.every((face) => face.status === 'loaded');
    }), { message: 'every Inter font file has loaded' })
    .toBe(true);
}

/** Open the workbench at `path` and start recording once it has drawn. */
export async function openAndRecord(page: Page, director: Director, url: string): Promise<void> {
  await page.goto(url);
  await waitForWorkbench(page);
  await page.waitForTimeout(400);
  await director.recorder.begin();
  await director.settlePointer();
  await director.beat(600);
}

export function clip(id: string, body: Parameters<typeof test>[2]): void {
  test(id, body);
}

export { expect, test };
