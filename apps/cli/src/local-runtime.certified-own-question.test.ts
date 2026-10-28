import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import type { AgentProvider, AgentRunRequest } from '@zlens/agent';
import { buildManifest } from '@zlens/core';
import { startLocalServer } from './local-runtime.js';
import { createAskPipelineRouteExecutor } from './ask-pipeline-host/host.js';
import { buildVocabularySource } from './ask-pipeline-host/vocabulary-source.js';

/**
 * Sandbox gate W1, round 4 (zlens 8ea16d9c): "Which adjusters handle the most
 * open claims?" was asked, became request R-100, a creator built a block from
 * the pre-filled draft, certified it, it was reviewed, merged and deployed,
 * and the worker's library listed it certified. The same words asked again
 * through `POST /api/agent-runs` came back AI-generated twice: the model read
 * the question as claim rows ("grouping by claim_id is not an output of the
 * block; display of claim_type is not an output of the block"), and the
 * certified tier only matches the reading. A block that records the question
 * it was certified for (`examples`) answers it before any model reads it.
 */

const QUESTION = 'Which adjusters handle the most open claims?';
const BLOCK_NAME = 'W1 R-100 claimed amount answer';
const DRAFT_PATH = 'blocks/_drafts/claims/w1-r-100-claimed-amount-answer.dql';
const BLOCK_SQL = `SELECT a.adjuster_id, a.adjuster_name, COUNT(*) AS open_claims
FROM main.claims c JOIN main.adjusters a ON c.adjuster_id = a.adjuster_id
WHERE c.status = 'open'
GROUP BY a.adjuster_id, a.adjuster_name
ORDER BY open_claims DESC`;

/** The draft as the pre-fill writes it from the request: the question is its first example. */
const draftSource = (examples = `  examples = [{ question = "${QUESTION}" }]\n`) => `block "${BLOCK_NAME}" {
  domain = "claims"
  type = "custom"
  status = "draft"
  owner = "cole@example.com"
  description = "Answers the question of request R-100. Built by the live check."
  tags = ["request:R-100", "live-check-w1"]
${examples}  pattern = "custom"
  grain = "one row per adjuster_id, adjuster_name"
  outputs = ["adjuster_id", "adjuster_name", "open_claims"]
  entities = ["adjuster"]
  sourceSystems = ["main.claims", "main.adjusters"]
  reviewCadence = "monthly"

  query = """
${BLOCK_SQL}
  """

  tests {
    assert row_count > 0
  }
}
`;

const ROWS = [
  { adjuster_id: 'A-7', adjuster_name: 'Ana Ruiz', open_claims: 14 },
  { adjuster_id: 'A-2', adjuster_name: 'Cole Park', open_claims: 9 },
];

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function project(source = draftSource()): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-own-question-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'certified_own_question' }));
  mkdirSync(join(projectRoot, 'blocks/_drafts/claims'), { recursive: true });
  writeFileSync(join(projectRoot, DRAFT_PATH), source);
  return projectRoot;
}

const executeQuery = vi.fn(async (statement: string) => {
  if (statement.includes('information_schema')) return { columns: [], rows: [], rowCount: 0, executionTime: 1, executionTimeMs: 1 };
  return { columns: ['adjuster_id', 'adjuster_name', 'open_claims'], rows: ROWS, rowCount: ROWS.length, executionTime: 1, executionTimeMs: 1 };
});
const executePositional = vi.fn(async () => ({ columns: ['adjuster_id', 'adjuster_name', 'open_claims'], rows: ROWS, rowCount: ROWS.length, executionTime: 1, executionTimeMs: 1 }));
const executor = { executeQuery, executePositional } as unknown as QueryExecutor;

/** Certify through Block Studio's explicit Certify route, as the creator does. */
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

interface Pipeline { tiers: Array<{ tier: string; outcome: string; detail?: string }>; story?: Array<{ phase: string; title: string }> }
interface Run { trustState?: string; answer?: string; artifacts: Array<{ payload: { askPipeline?: Pipeline } }> }

/**
 * The interpreter Nova Pro was in round 4: it reads the question as claim
 * rows (a count per claim_id, showing claim_type), never as the block.
 */
function asker(projectRoot: string) {
  const manifest = buildManifest({ projectRoot });
  const provider: AgentProvider & { calls: number } = {
    name: 'ollama', calls: 0, available: async () => true,
    generate: async () => {
      provider.calls += 1;
      return JSON.stringify({
        version: 1, kind: 'analytics', reading: 'List open claims with their claim type, counted per claim',
        measures: [{ ref: 'column:main.claims.claim_id', aggregation: 'count' }], groupBy: [{ ref: 'column:main.claims.claim_id', role: 'categorical' }], display: ['column:main.claims.claim_type'],
        filters: [{ ref: 'column:main.claims.status', op: 'eq', values: ['open'] }], unresolved: [], provenance: {}, expectedShape: 'grouped',
      });
    },
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
      const result = await run({ runId: `run:${Math.random().toString(36).slice(2)}`, request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => undefined }) as unknown as Run;
      return { trust: result.trustState, answer: result.answer ?? '', pipeline: result.artifacts[0]?.payload.askPipeline };
    },
  };
}

describe('a certified block answers the question it was certified for, whatever the model reads', () => {
  it('the certified block carries its question into the vocabulary', async () => {
    const projectRoot = project();
    const certified = await certifyThroughProduct(projectRoot, draftSource());
    expect(certified.status, JSON.stringify(certified.body)).toBe(200);
    expect(readFileSync(join(projectRoot, certified.body.path as string), 'utf-8')).toContain(`examples = [{ question = "${QUESTION}" }]`);
    const served = buildVocabularySource({ manifest: buildManifest({ projectRoot }) }).blocks ?? [];
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ name: BLOCK_NAME, certified: true, examples: [QUESTION] });
  }, 60_000);

  it('the recorded question, word for word, is Certified without the interpreter in the loop', async () => {
    const projectRoot = project();
    expect((await certifyThroughProduct(projectRoot, draftSource())).status).toBe(200);
    const { ask, provider } = asker(projectRoot);
    for (const asked of [QUESTION, 'which adjusters handle the most open claims', '  Which adjusters handle the most open claims?  ']) {
      const { trust, pipeline, answer } = await ask(asked);
      expect(pipeline?.tiers.find((tier) => tier.tier === 'certified'), asked).toMatchObject({ outcome: 'prepared' });
      expect(trust, asked).toBe('certified');
      expect(answer, asked).toMatch(/Ana Ruiz/);
      expect(pipeline?.story?.some((entry) => entry.phase === 'read' && entry.title.includes(`certified saved query ${BLOCK_NAME} answers`)), asked).toBe(true);
    }
    expect(provider.calls).toBe(0);
  }, 60_000);

  it('a different question still goes through the interpreter, and its column-shaped reading is not the block', async () => {
    const projectRoot = project();
    expect((await certifyThroughProduct(projectRoot, draftSource())).status).toBe(200);
    const { ask, provider } = asker(projectRoot);
    const { trust, pipeline } = await ask('Which adjusters handle the most closed claims?');
    expect(provider.calls).toBeGreaterThan(0);
    expect(trust).not.toBe('certified');
    expect(pipeline?.tiers.find((tier) => tier.tier === 'certified')?.outcome ?? 'refused').not.toBe('prepared');
  }, 60_000);

  it('without the recorded question, the same words are left to the interpreter (round 4)', async () => {
    const projectRoot = project(draftSource(''));
    expect((await certifyThroughProduct(projectRoot, draftSource(''))).status).toBe(200);
    const { ask, provider } = asker(projectRoot);
    const { trust } = await ask(QUESTION);
    expect(provider.calls).toBeGreaterThan(0);
    expect(trust).not.toBe('certified');
  }, 60_000);
});
