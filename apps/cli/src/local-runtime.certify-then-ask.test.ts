import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import type { AgentProvider, AgentRunRequest } from '@zlens/agent';
import { buildManifest } from '@zlens/core';
import { startLocalServer } from './local-runtime.js';
import { blockSourceStatus, withBlockStatus } from './certification-receipt.js';
import { createAskPipelineRouteExecutor } from './ask-pipeline-host/host.js';
import { buildVocabularySource, namedBlockNotServed } from './ask-pipeline-host/vocabulary-source.js';

/**
 * ZLens 0.1.0 second pre-publish e2e, N4. A block imported from SQL, saved as
 * a draft and then explicitly certified was never used by Ask: the import had
 * tagged the draft `review-required`, Certify only flipped its status, and
 * Ask's vocabulary silently skips a certified block that still says it needs
 * review. Naming the block then sent the question to AI-written SQL, which
 * refused because it did not filter on "Eligible" and "Players".
 *
 * Here the evidence block is certified through the product's Certify route
 * and asked about through the Ask host, by name and without naming it.
 */

const BLOCK_NAME = 'Eligible Top Players With Player ID';
const DRAFT_PATH = 'blocks/_drafts/nba/eligible-top-players-with-player-id.dql';
const draftSource = (extra = '') => `block "${BLOCK_NAME}" {
    status = "draft"
    domain = "nba"
    type = "custom"
    description = "Ranks the top 5 NBA players by summed points scored across games dated in 2016 or 2017, including distinct games played, using TRANSFORMED.int_player_stats."
    tags = ["transformed", "player", "points", "nba", "review-required", "top-scorers", "2016-2017"]
    owner = "e2e-test"
    pattern = "ranking"
    grain = "player_id"
    entities = ["player"]
    outputs = ["player_id", "player_name", "total_points", "games_played"]
    dimensions = ["player_id", "player_name"]
    allowedFilters = ["top_n"]
    parameterPolicy {
        top_n = "dynamic"
    }
    sourceSystems = ["TRANSFORMED.int_player_stats"]
    reviewCadence = "quarterly"${extra}

    params {
        top_n = 5
    }

    query = """
SELECT
  player_id,
  player_name,
  SUM(COALESCE(pts, 0)) AS total_points,
  COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN 2016 AND 2017
  AND player_id IS NOT NULL
  AND player_name IS NOT NULL
GROUP BY player_id, player_name
ORDER BY total_points DESC, player_id ASC
LIMIT \${top_n}
    """

    tests {
        assert row_count > 0
    }
}
`;

const ROWS = [
  { player_id: 201935, player_name: 'James Harden', total_points: 5534, games_played: 189 },
  { player_id: 2544, player_name: 'LeBron James', total_points: 5331, games_played: 214 },
  { player_id: 201566, player_name: 'Russell Westbrook', total_points: 5252, games_played: 198 },
  { player_id: 201939, player_name: 'Stephen Curry', total_points: 5251, games_played: 201 },
  { player_id: 201142, player_name: 'Kevin Durant', total_points: 4835, games_played: 188 },
];

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function project(source = draftSource()): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certify-then-ask-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'certify_then_ask' }));
  mkdirSync(join(projectRoot, 'blocks/_drafts/nba'), { recursive: true });
  writeFileSync(join(projectRoot, DRAFT_PATH), source);
  return projectRoot;
}

const executeQuery = vi.fn(async (statement: string) => {
  if (statement.includes('information_schema')) return { columns: [], rows: [], rowCount: 0, executionTime: 1, executionTimeMs: 1 };
  return { columns: ['player_id', 'player_name', 'total_points', 'games_played'], rows: ROWS, rowCount: ROWS.length, executionTime: 1, executionTimeMs: 1 };
});
// The warehouse binds the block's row count as a positional parameter, as DuckDB does.
const executePositional = vi.fn(async (_statement: string, params: unknown[]) => ({ columns: ['player_id', 'player_name', 'total_points', 'games_played'], rows: ROWS.slice(0, Number(params[0] ?? ROWS.length)), rowCount: ROWS.length, executionTime: 1, executionTimeMs: 1 }));
const executor = { executeQuery, executePositional } as unknown as QueryExecutor;

/** Certify through Block Studio's explicit Certify route, as the UI does. */
async function certifyThroughProduct(projectRoot: string, source: string): Promise<{ status: number; body: Record<string, any> }> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection: { driver: 'file' }, preferredPort: 0, captureServer: (created) => { server = created; } });
    const response = await fetch(`http://127.0.0.1:${port}/api/block-studio/certify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, path: DRAFT_PATH }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

interface Pipeline { tiers: Array<{ tier: string; outcome: string; detail?: string }>; context?: { admitted?: { byKind?: Record<string, number> } } }
interface Run { trustState?: string; answer?: string; artifacts: Array<{ payload: { askPipeline?: Pipeline } }> }

function asker(projectRoot: string, reply: Record<string, unknown>) {
  const manifest = buildManifest({ projectRoot });
  const provider: AgentProvider & { calls: number } = {
    name: 'ollama', calls: 0, available: async () => true,
    generate: async () => { provider.calls += 1; return JSON.stringify({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...reply }); },
  };
  const run = createAskPipelineRouteExecutor({
    projectRoot,
    executor,
    resolveConnection: async () => ({ driver: 'duckdb', path: ':memory:' } as ConnectionConfig),
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: `snapshot:${Date.now()}`, manifest }),
    selectProvider: async () => provider,
    priorIntent: () => undefined,
    compileSemantic: async () => { throw new Error('no semantic layer is loaded'); },
    autoExploration: true,
  });
  return {
    provider,
    ask: async (question: string) => {
      const result = await run({ runId: 'run:nba', request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => undefined }) as unknown as Run;
      return { trust: result.trustState, answer: result.answer ?? '', pipeline: result.artifacts[0]?.payload.askPipeline };
    },
  };
}

const NAMED = `Using the certified block ${BLOCK_NAME}, who are the top 5 NBA players by total points for 2016 and 2017?`;
const BLOCK_REF = `block:nba.${BLOCK_NAME}`;

describe('a block certified through the product is the answer Ask gives first', () => {
  it('Certify removes the review-required lifecycle tag, so the block is served as certified', async () => {
    const projectRoot = project();
    const certified = await certifyThroughProduct(projectRoot, draftSource());
    expect(certified.status, JSON.stringify(certified.body)).toBe(200);
    const path = certified.body.path as string;
    const source = readFileSync(join(projectRoot, path), 'utf-8');
    expect(blockSourceStatus(source)).toBe('certified');
    expect(source).not.toMatch(/review-required/);
    expect(source).toMatch(/tags = \["transformed", "player", "points", "nba", "top-scorers", "2016-2017"\]/);
    const companion = readFileSync(join(projectRoot, certified.body.companionPath as string), 'utf-8');
    expect(companion).toContain('reviewStatus: certified');
    expect(companion).not.toMatch(/review-required/);
    const served = buildVocabularySource({ manifest: buildManifest({ projectRoot }) }).blocks ?? [];
    expect(served.map((block) => block.name)).toEqual([BLOCK_NAME]);
  }, 60_000);

  it('a question that names it is answered by it (the e2e reading left it to AI SQL)', async () => {
    const projectRoot = project();
    expect((await certifyThroughProduct(projectRoot, draftSource())).status).toBe(200);
    const { ask, provider } = asker(projectRoot, { reading: 'Using the certified block, list the top 5 NBA players by total points for 2016 and 2017.', unresolved: [{ clause: `certified block ${BLOCK_NAME}`, options: [], material: true }] });
    const { trust, pipeline, answer } = await ask(NAMED);
    expect(pipeline?.context?.admitted?.byKind?.block).toBe(1);
    expect(pipeline?.tiers.find((tier) => tier.tier === 'certified')).toMatchObject({ outcome: 'prepared' });
    expect(trust).toBe('certified');
    expect(answer).not.toMatch(/Eligible|does not apply/);
    expect(provider.calls).toBe(1);
  }, 60_000);

  it('a matching question that does not name it is answered by it', async () => {
    const projectRoot = project();
    expect((await certifyThroughProduct(projectRoot, draftSource())).status).toBe(200);
    const { ask } = asker(projectRoot, { reading: 'Rank the top 5 NBA players by total points scored across games dated in 2016 or 2017.', measures: [{ ref: BLOCK_REF }] });
    const { trust, pipeline } = await ask('Who are the top 5 NBA players by total points for 2016 and 2017?');
    expect(pipeline?.tiers.find((tier) => tier.tier === 'certified')).toMatchObject({ outcome: 'prepared' });
    expect(trust).toBe('certified');
  }, 60_000);

  it('a certified block that still says review-required is named with the reason and what to do, at once', async () => {
    // A block certified before this fix: status flipped, tag kept.
    const projectRoot = project();
    mkdirSync(join(projectRoot, 'blocks/nba'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks/nba/eligible-top-players-with-player-id.dql'), draftSource().replace('status = "draft"', 'status = "certified"'));
    rmSync(join(projectRoot, DRAFT_PATH));
    const { ask, provider } = asker(projectRoot, { measures: [{ ref: BLOCK_REF }] });
    const started = Date.now();
    const { trust, answer } = await ask(NAMED);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(provider.calls).toBe(0);
    expect(trust).toBe('blocked');
    expect(answer).toMatch(/The saved query "Eligible Top Players With Player ID" was not used: it is marked certified but still carries the review-required tag/);
    expect(answer).toMatch(/Certify it again in Saved queries/);
  }, 60_000);

  it('a draft named as a block says it is a draft; a question that merely equals a draft title is not refused', () => {
    const projectRoot = project();
    const manifest = buildManifest({ projectRoot });
    expect(namedBlockNotServed(NAMED, manifest)).toMatch(/is a draft, not certified, and Ask only answers from certified saved queries/);
    expect(namedBlockNotServed('Who are the eligible top players with player id?', manifest)).toBeUndefined();
  });

  it('Certify refuses a description that still says review-required, instead of certifying a block Ask would skip', async () => {
    const source = draftSource().replace('description = "Ranks', 'description = "Review-required draft. Ranks');
    const projectRoot = project(source);
    const refused = await certifyThroughProduct(projectRoot, source);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body.blockers)).toMatch(/description still says .{0,4}review required/);
    expect(refused.body.checklist.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'description_review_required', action: 'fix_description' })]));
    expect(blockSourceStatus(readFileSync(join(projectRoot, DRAFT_PATH), 'utf-8'))).toBe('draft');
  }, 60_000);

  it('the certify transform keeps every other tag and the status line in place', () => {
    const certified = withBlockStatus(draftSource(), 'certified');
    expect(certified).toContain('status = "certified"');
    expect(certified).toContain('tags = ["transformed", "player", "points", "nba", "top-scorers", "2016-2017"]');
    expect(withBlockStatus(draftSource(), 'draft')).toContain('"review-required"');
  });
});
