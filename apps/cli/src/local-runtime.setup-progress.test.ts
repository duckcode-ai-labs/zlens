import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor } from '@zlens/connectors';
import { normalizeSetupProgress, startLocalServer } from './local-runtime.js';

/**
 * Guided Setup progress (design D7): the step and answers are saved in
 * `.dql/local/setup-progress.json`, so a restart resumes at the same step;
 * finishing or closing setup clears them.
 */
describe('Guided Setup progress', () => {
  it('keeps only a valid step and answers', () => {
    expect(normalizeSetupProgress({ step: 0 })).toBeNull();
    expect(normalizeSetupProgress({ step: 5 })).toBeNull();
    expect(normalizeSetupProgress(null)).toBeNull();
    expect(normalizeSetupProgress({ step: 2, source: 'nonsense', draft: { ok: true, message: 'Drafted', proposalId: '../etc' } })).toMatchObject({
      version: 1,
      step: 2,
      draft: { ok: true, message: 'Drafted' },
    });
    expect(normalizeSetupProgress({ step: 2, source: 'nonsense' })?.source).toBeUndefined();
  });

  it('saves the step, survives a restart, and is cleared when setup is finished', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-progress-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop' }));
    const servers: Server[] = [];
    const start = async () => {
      let server: Server | undefined;
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), connection: null, preferredPort: 0, captureServer: (created) => { server = created; } });
      servers.push(server!);
      return `http://127.0.0.1:${port}`;
    };
    const stop = (server: Server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); });
    try {
      let base = await start();
      expect(await (await fetch(`${base}/api/onboarding/progress`)).json()).toMatchObject({ progress: null });

      const saved = await fetch(`${base}/api/onboarding/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 2, source: 'warehouse', draft: { ok: true, message: 'Drafted 13 models and 23 joins from 13 tables.', proposalId: 'ctxprop_1' } }),
      });
      expect(saved.status).toBe(200);
      const file = join(projectRoot, '.dql', 'local', 'setup-progress.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, step: 2, source: 'warehouse' });

      // A restart (a new server on the same project) resumes at step 2.
      await stop(servers.pop()!);
      base = await start();
      expect(await (await fetch(`${base}/api/onboarding/progress`)).json()).toMatchObject({
        progress: { step: 2, source: 'warehouse', draft: { ok: true, proposalId: 'ctxprop_1' } },
      });

      const invalid = await fetch(`${base}/api/onboarding/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 9 }) });
      expect(invalid.status).toBe(400);

      // Finishing (or closing) setup clears it: the next start does not resume.
      const acknowledged = await fetch(`${base}/api/onboarding/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(acknowledged.status).toBe(200);
      expect(existsSync(file)).toBe(false);
      expect(await (await fetch(`${base}/api/onboarding/progress`)).json()).toMatchObject({ progress: null });
    } finally {
      for (const server of servers) await stop(server);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
