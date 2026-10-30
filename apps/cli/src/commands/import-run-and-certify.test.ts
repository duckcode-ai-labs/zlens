import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIFlags } from '../args.js';
import {
  createBlockStudioImportSession,
  readBlockStudioImportCandidate,
  writeBlockStudioImportCandidate,
} from '../block-studio-import.js';

/**
 * `zlens import sql` runs each draft once, and `zlens certify --from-import`
 * checks (or with --apply certifies) every draft of one import. Both go
 * through the runtime routes the Import SQL page uses; here the runtime is
 * replaced by a recording fake, so these tests cover what the commands ask
 * for and what they report.
 */

const runtime = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body?: any }>,
  check: (_source: string): { status: number; body: any } => ({ status: 200, body: { ok: true, blockers: [] } }),
  certify: (_candidateId: string): { ok: true; path: string } | { ok: false; reason: string } => ({ ok: true, path: 'blocks/finance/x.dql' }),
  preview: (_candidateId: string): { ok: true; rowCount: number } | { ok: false; reason: string } => ({ ok: true, rowCount: 3 }),
}));

vi.mock('../import-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../import-runtime.js')>();
  return {
    ...original,
    withImportRuntime: vi.fn(async (_root: string, _flags: unknown, work: (call: any) => Promise<unknown>) => work(async (method: string, path: string, body?: any) => {
      runtime.calls.push({ method, path, body });
      return runtime.check(body?.source ?? '');
    })),
    certifyImportCandidate: vi.fn(async (_call: unknown, _importId: string, candidateId: string) => runtime.certify(candidateId)),
    previewImportCandidate: vi.fn(async (_call: unknown, _importId: string, candidateId: string) => runtime.preview(candidateId)),
  };
});

const { runCertify } = await import('./certify.js');
const { runImport } = await import('./import.js');

const roots: string[] = [];
let logs: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
  runtime.calls = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    format: 'json', verbose: false, help: false, version: false, check: false, open: null, input: '', outDir: '',
    port: null, host: null, chart: '', domain: '', owner: '', queryOnly: false, template: '', connection: '',
    skipTests: false, force: false, http: false, ...overrides,
  };
}

/** A project with one import of two drafts, each saved as a draft file. */
function projectWithImport(): { root: string; importId: string; ids: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'dql-import-certify-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }));
  const session = createBlockStudioImportSession(root, {
    inputMode: 'paste',
    sources: [{ path: 'reports.sql', content: '-- name: Monthly revenue\nselect 1 as revenue;\n-- name: Store revenue for a period\nselect 2 as revenue where 1 = :start_date;' }],
    domain: 'finance',
    owner: 'analytics@jaffle.shop',
  });
  mkdirSync(join(root, 'blocks', '_drafts', 'finance'), { recursive: true });
  for (const candidate of session.candidates) {
    const path = `blocks/_drafts/finance/${candidate.id}.dql`;
    writeFileSync(join(root, path), candidate.dqlSource);
    writeBlockStudioImportCandidate(root, session.id, { ...candidate, savedPath: path, draftSave: { status: 'saved', path } });
  }
  return { root, importId: session.id, ids: session.candidates.map((candidate) => candidate.id) };
}

const output = () => JSON.parse(logs.join('\n'));

describe('zlens certify --from-import', () => {
  it('checks every draft of the latest import as certified source, and reports each with a plain reason', async () => {
    const { root, ids } = projectWithImport();
    runtime.check = (source) => (source.includes(':start_date') || source.includes('${start_date}')
      ? { status: 200, body: { ok: false, blockers: ['Provide required parameters: start_date.'] } }
      : { status: 200, body: { ok: true, blockers: [] } });
    process.chdir(root);
    await runCertify('', flags({ fromImport: 'latest' }));

    expect(runtime.calls.map((call) => call.path)).toEqual(['/api/block-studio/certification-check', '/api/block-studio/certification-check']);
    expect(runtime.calls.every((call) => /status = "certified"/.test(call.body.source))).toBe(true);
    expect(output().results).toEqual([
      { candidateId: ids[0], name: 'Monthly Revenue', status: 'ready' },
      { candidateId: ids[1], name: 'Store Revenue For A Period', status: 'blocked', reason: 'Needs a default value: start_date.' },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('with --apply certifies what the draft file says now, and skips drafts already certified', async () => {
    const { root, importId, ids } = projectWithImport();
    const fixed = join(root, 'blocks', '_drafts', 'finance', `${ids[1]}.dql`);
    writeFileSync(fixed, readFileSync(fixed, 'utf-8').replace(/start_date: \w+/, 'start_date = "2024-01-01"'));
    const done = readBlockStudioImportCandidate(root, importId, ids[0]);
    writeBlockStudioImportCandidate(root, importId, { ...done, dqlSource: done.dqlSource.replace('status = "draft"', 'status = "certified"'), reviewStatus: 'saved', savedPath: 'blocks/finance/monthly-revenue.dql' });
    runtime.certify = (candidateId) => ({ ok: true, path: `blocks/finance/${candidateId}.dql` });
    process.chdir(root);
    await runCertify('', flags({ fromImport: importId, apply: true }));

    expect(output().results).toEqual([
      { candidateId: ids[0], name: 'Monthly Revenue', status: 'already-certified', path: 'blocks/finance/monthly-revenue.dql' },
      { candidateId: ids[1], name: 'Store Revenue For A Period', status: 'certified', path: `blocks/finance/${ids[1]}.dql` },
    ]);
    // The edit in the draft file is what the page's Certify certified.
    expect(readBlockStudioImportCandidate(root, importId, ids[1]).dqlSource).toContain('start_date = "2024-01-01"');
    expect(process.exitCode).toBeUndefined();
  });

  it('says how to start when there is no import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-import-certify-empty-'));
    roots.push(root);
    process.chdir(root);
    await runCertify('', flags({ fromImport: 'latest', format: 'text' }));
    expect(process.exitCode).toBe(1);
    expect(runtime.calls).toEqual([]);
  });
});

describe('zlens import sql', () => {
  it('runs each draft once and counts the ones that need a fix by kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-import-preview-'));
    roots.push(root);
    writeFileSync(join(root, 'reports.sql'), '-- name: Monthly revenue\nselect 1 as revenue;\n-- name: Broken\nselect TOP 10 x from t;\n-- name: Also broken\nselect TOP 5 y from t;');
    let call = 0;
    runtime.preview = () => (call++ === 0 ? { ok: true, rowCount: 12 } : { ok: false, reason: 'Does not parse on this connection: syntax error at or near "10".' });
    process.chdir(root);
    await runImport('sql', ['reports.sql'], flags({ format: 'text', owner: 'analytics@jaffle.shop', domain: 'finance', provider: 'deterministic' }));
    const text = logs.join('\n');
    expect(text).toContain('ran: 12 rows');
    expect(text).toContain('needs a fix: Does not parse on this connection: syntax error at or near "10".');
    expect(text).toContain('Ran: 1 of 3 drafts. Need a fix: 2.');
    expect(text).toContain('2 × Does not parse on this connection');
    expect(text).toMatch(/Certify the ones that pass the checks: zlens certify --from-import imp_\w+ --apply/);
  });
});
