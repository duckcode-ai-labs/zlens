import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * The report check, end to end (V13 13-16): compare a saved query with the old
 * report's export, rename the query, certify it, and read the receipt. The
 * comparison follows the query to its new name, the receipt says it matches,
 * and inside Snowflake the receipt names the Snowflake user who certified it.
 */

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const DRAFT_PATH = 'blocks/_drafts/nba/wins-by-season.dql';
const FINAL_NAME = 'warriors_regular_season_wins_2014_2018';

const blockSource = (name: string) => `block "${name}" {
  status = "draft"
  domain = "nba"
  type = "custom"
  description = "Golden State Warriors regular-season wins by season, 2014 to 2018."
  owner = "test_admin"
  tags = ["nba"]
  outputs = ["SEASON", "WINS"]
  query = """SELECT season AS SEASON, COUNT(*) AS WINS FROM games WHERE team = 'GSW' AND won GROUP BY 1 ORDER BY 1"""
  tests {
    assert row_count > 0
  }
}
`;

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-report-check-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'report_check' }));
  mkdirSync(join(root, 'blocks/_drafts/nba'), { recursive: true });
  writeFileSync(join(root, DRAFT_PATH), blockSource('WINS By SEASON'));
  return root;
}

const seasons = [[2014, 67], [2015, 73], [2016, 67], [2017, 58], [2018, 57]].map(([season, wins]) => ({ SEASON: season, WINS: wins }));
const oldReport = { name: 'warriors_regular_wins_2014_2018.csv', base64: Buffer.from('SEASON,WINS\n2014,67\n2015,73\n2016,67\n2017,58\n2018,57\n').toString('base64') };

async function serve(root: string, options: { snowflake?: boolean; user?: string } = {}) {
  const executor = { executeQuery: vi.fn(async () => ({ columns: ['SEASON', 'WINS'], rows: seasons, rowCount: seasons.length, executionTime: 1 })) } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    preferredPort: 0,
    ...(options.snowflake ? { snowflakeIngress: {} } : {}),
    captureServer: (created: Server) => { servers.push(created); },
  } as Parameters<typeof startLocalServer>[0]);
  const headers = { 'Content-Type': 'application/json', ...(options.user ? { 'Sf-Context-Current-User': options.user } : {}) };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  /** Block Studio's Certify: start the operation and wait for its result. */
  const certify = async (source: string, path: string): Promise<Record<string, any>> => {
    const started = await call('POST', '/api/block-studio/certifications', { source, path });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let operation: Record<string, any> = started.body.operation;
    for (let attempt = 0; attempt < 500 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      operation = (await call('GET', `/api/operations/${encodeURIComponent(operation.id)}`)).body;
    }
    expect(operation.status, JSON.stringify(operation)).toBe('succeeded');
    return operation.result;
  };
  /** Compare the old report with the saved query, as its page does, and record it. */
  const compareAndRecord = async (query: string, path: string) => {
    const compared = await call('POST', '/api/report-match/compare', { file: oldReport, query, queryPath: path });
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    const recorded = await call('POST', '/api/report-match/record', { id: compared.body.comparison.id, via: 'screen' });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    return { comparison: compared.body.comparison, recording: compared.body.recording, recorded: recorded.body.recorded as string[] };
  };
  return { call, certify, compareAndRecord };
}

const receiptOf = (result: Record<string, any>) => result.block?.metadata?.certification as { certifiedBy: string; certifiedByName?: string; checks?: string[]; warnings?: string[] };

describe('the receipt records the match, after the query is renamed', () => {
  it('compares with the key it proposes, keeps the record through the rename, and puts the match on the receipt', async () => {
    const root = newProject();
    const { call, certify, compareAndRecord } = await serve(root);

    // Several rows, no key named: SEASON tells them apart, so there is a verdict.
    const { comparison, recording, recorded } = await compareAndRecord('WINS By SEASON', DRAFT_PATH);
    expect(comparison.comparison).toMatchObject({ verdict: 'matches', values: { compared: 5, equal: 5 } });
    expect(comparison.keysProposed).toEqual(['SEASON']);
    expect(comparison.target).toMatchObject({ kind: 'query', name: 'WINS By SEASON' });
    expect(recording).toBe('with-compare');
    expect(recorded).toHaveLength(1);

    // Renamed, then certified.
    const result = await certify(blockSource(FINAL_NAME), DRAFT_PATH);
    expect(result.outcome).toBe('certified');
    const receipt = receiptOf(result);
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(receipt.checks).toContain(`Matches warriors_regular_wins_2014_2018 · every value compared (5 of 5 at whole numbers, ${day})`);
    expect(receipt.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('warriors_regular_wins')]));

    // The record moved with the query: its page finds it under the new name, and the old name has none.
    expect(existsSync(join(root, recorded[0]!))).toBe(false);
    const record = loadYaml(readFileSync(join(root, `semantic-layer/report-matches/query/${FINAL_NAME}.yaml`), 'utf-8')) as { matches: Array<{ report: string; verdict: string }> };
    expect(record.matches[0]).toMatchObject({ report: 'warriors_regular_wins_2014_2018', verdict: 'matches' });
    const page = await call('GET', `/api/report-match/query?name=${encodeURIComponent(FINAL_NAME)}`);
    expect(page.body.match).toMatchObject({ verdict: 'matches', report: 'warriors_regular_wins_2014_2018' });
    expect(page.body.match.words).toContain('every value compared');
    expect((await call('GET', `/api/report-match/query?name=${encodeURIComponent('WINS By SEASON')}`)).body.match).toBeNull();
  });

  it('finds a comparison made under the name the file still has, when the rename comes with Certify', async () => {
    const root = newProject();
    const { call, compareAndRecord } = await serve(root);
    await compareAndRecord('WINS By SEASON', DRAFT_PATH);
    // This Certify writes the receipt before it saves the new name: the receipt reads the name the file had.
    const certified = await call('POST', '/api/block-studio/certify', { source: blockSource(FINAL_NAME), path: DRAFT_PATH });
    expect(certified.status, JSON.stringify(certified.body)).toBe(200);
    expect(certified.body.metadata.certification.checks.some((check: string) => check.startsWith('Matches warriors_regular_wins_2014_2018 · every value compared'))).toBe(true);
    expect(existsSync(join(root, `semantic-layer/report-matches/query/${FINAL_NAME}.yaml`))).toBe(true);
  });
});

describe('who certified it, inside Snowflake', () => {
  it('is the Snowflake user who signed in, on the receipt and on the comparison', async () => {
    const root = newProject();
    const { certify, compareAndRecord } = await serve(root, { snowflake: true, user: 'TEST_ADMIN' });
    const { recorded } = await compareAndRecord('WINS By SEASON', DRAFT_PATH);
    const record = loadYaml(readFileSync(join(root, recorded[0]!), 'utf-8')) as { matches: Array<{ comparedBy: string }> };
    expect(record.matches[0]!.comparedBy).toBe('TEST_ADMIN');
    const receipt = receiptOf(await certify(blockSource(FINAL_NAME), DRAFT_PATH));
    expect(receipt.certifiedBy).toBe('TEST_ADMIN');
    expect(receipt.certifiedBy).not.toBe('local');
  });

  it('is never read from the header outside Snowflake', async () => {
    const root = newProject();
    const { certify } = await serve(root, { user: 'TEST_ADMIN' });
    const receipt = receiptOf(await certify(blockSource(FINAL_NAME), DRAFT_PATH));
    expect(receipt.certifiedBy).not.toBe('TEST_ADMIN');
    expect(receipt.certifiedByName ?? '').not.toBe('TEST_ADMIN');
  });
});
