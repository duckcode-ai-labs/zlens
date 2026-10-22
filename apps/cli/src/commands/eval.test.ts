import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Resolve fixtures relative to this test file, not process.cwd(), so the suite
// passes whether vitest runs from the repo root or the apps/cli package dir.
const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
import type { DQLManifest } from '@zlens/core';
import { planAgentAnswer, type PlanAgentAnswerResult } from '@zlens/agent';
import {
  collectEvalCases,
  computeDistributions,
  computeScores,
  loadYamlEvalCases,
  mapRoute,
  meetsThresholds,
  runEval,
  runEvalHarness,
  scoreCase,
  type EvalCase,
} from './eval.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Synthetic router-result builders (keeps unit tests deterministic) ----

function makePlan(overrides: {
  route: PlanAgentAnswerResult['routeDecision']['route'];
  exactObjectKey?: string;
  blocking?: boolean;
  metricTerms?: string[];
  filters?: string[];
  objectKeys?: string[];
}): PlanAgentAnswerResult {
  const missingContext = overrides.blocking
    ? [{ kind: 'metadata' as const, message: 'no safe source', severity: 'blocking' as const }]
    : [];
  const contextPack = {
    questionPlan: {
      metricTerms: overrides.metricTerms ?? [],
      requestedShape: { filters: overrides.filters ?? [] },
    },
    objects: (overrides.objectKeys ?? []).map((objectKey) => ({ objectKey })),
  } as unknown as PlanAgentAnswerResult['contextPack'];
  return {
    contextPackId: 'pack-1',
    contextPack,
    routeDecision: {
      route: overrides.route,
      intent: 'exact_certified_lookup',
      reason: 'test',
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: overrides.exactObjectKey,
      selectedEvidence: [],
      missingContext,
      followUps: [],
    },
    evidenceRoles: [] as PlanAgentAnswerResult['evidenceRoles'],
    allowedSqlContext: { relations: [], sourceBlockSql: [] },
    missingContext,
    warnings: [],
    freshness: {} as PlanAgentAnswerResult['freshness'],
  };
}

function makeManifest(
  blocks: Record<string, { status?: string; grain?: string; examples?: { question: string }[] }>,
): DQLManifest {
  const fullBlocks: DQLManifest['blocks'] = {};
  for (const [name, b] of Object.entries(blocks)) {
    fullBlocks[name] = {
      name,
      filePath: `blocks/${name}.dql`,
      status: b.status,
      grain: b.grain,
      examples: b.examples,
    } as DQLManifest['blocks'][string];
  }
  return { blocks: fullBlocks } as DQLManifest;
}

describe('mapRoute', () => {
  it('maps the router vocabulary onto spec route labels', () => {
    expect(mapRoute('certified')).toBe('certified');
    expect(mapRoute('generated_sql')).toBe('generated');
    expect(mapRoute('clarify')).toBe('missing_context');
    expect(mapRoute('research')).toBe('research');
  });
});

describe('collectEvalCases', () => {
  it('turns each certified block example into a certified-expecting case', () => {
    const manifest = makeManifest({
      revenue_total: {
        status: 'certified',
        grain: 'week',
        examples: [{ question: 'What was revenue last week?' }],
      },
      draft_block: {
        status: 'draft',
        examples: [{ question: 'ignored because not certified' }],
      },
    });
    const cases = collectEvalCases(manifest, [], true);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      source: 'block_example',
      category: 'certified',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      expectGrain: 'week',
    });
  });

  it('skips block examples when includeBlockExamples is false', () => {
    const manifest = makeManifest({
      revenue_total: { status: 'certified', examples: [{ question: 'q' }] },
    });
    const yaml: EvalCase[] = [
      { name: 'y', question: 'q2', source: 'yaml', category: 'certified', expectRoute: 'certified' },
    ];
    const cases = collectEvalCases(manifest, yaml, false);
    expect(cases).toHaveLength(1);
    expect(cases[0].source).toBe('yaml');
  });
});

describe('scoreCase', () => {
  const manifest = makeManifest({
    revenue_total: { status: 'certified', grain: 'week' },
    customer_revenue: { status: 'certified', grain: 'customer_id' },
  });

  it('passes a certified-exact case (route + block + grain)', () => {
    const testCase: EvalCase = {
      name: 'certified',
      question: 'What was revenue last week?',
      source: 'block_example',
      category: 'certified',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      expectGrain: 'week',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(true);
    expect(result.actualBlock).toBe('revenue_total');
    expect(result.actualGrain).toBe('week');
    expect(result.routeMatch && result.blockMatch && result.grainMatch).toBe(true);
    expect(result.trace.map((stage) => stage.stage)).toEqual(['context', 'route', 'scoring']);
    expect(result.trace.find((stage) => stage.stage === 'route')).toMatchObject({
      status: 'passed',
      payload: {
        route: 'certified',
        mappedRoute: 'certified',
        exactObjectKey: 'dql:block:revenue_total',
      },
    });
  });

  it('scores a generated (Tier-2) case', () => {
    const testCase: EvalCase = {
      name: 'generated',
      question: 'revenue by region ranked',
      source: 'yaml',
      category: 'generated',
      expectRoute: 'generated',
    };
    const result = scoreCase(testCase, makePlan({ route: 'generated_sql' }), manifest);
    expect(result.passed).toBe(true);
    expect(result.actualRoute).toBe('generated');
  });

  it('scores an insufficient-context refusal case', () => {
    const testCase: EvalCase = {
      name: 'refusal',
      question: 'unanswerable question with no source',
      source: 'yaml',
      category: 'insufficient_context',
      expectRefuse: true,
    };
    const result = scoreCase(testCase, makePlan({ route: 'clarify', blocking: true }), manifest);
    expect(result.passed).toBe(true);
    expect(result.actualRoute).toBe('missing_context');
    expect(result.refusalMatch).toBe(true);
    expect(result.hasBlockingMissingContext).toBe(true);
  });

  it('fails a refusal case when the router answered instead of refusing', () => {
    const testCase: EvalCase = {
      name: 'refusal-should-have-happened',
      question: 'q',
      source: 'yaml',
      category: 'insufficient_context',
      expectRefuse: true,
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.refusalMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('expected a safe refusal');
  });

  it('detects a wrong-grain mismatch even when route + block match', () => {
    const testCase: EvalCase = {
      name: 'wrong-grain',
      question: 'revenue per customer',
      source: 'yaml',
      category: 'wrong_grain',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
      // We expect customer_id grain, but revenue_total is week grain.
      expectGrain: 'customer_id',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:revenue_total' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.grainMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('grain expected customer_id');
  });

  it('detects a conflict / wrong-block selection', () => {
    const testCase: EvalCase = {
      name: 'conflict',
      question: 'ambiguous revenue question',
      source: 'yaml',
      category: 'conflict',
      expectRoute: 'certified',
      expectBlock: 'revenue_total',
    };
    const result = scoreCase(
      testCase,
      makePlan({ route: 'certified', exactObjectKey: 'dql:block:customer_revenue' }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.blockMatch).toBe(false);
    expect(result.failures.join(' ')).toContain('block expected revenue_total, got customer_revenue');
  });
});

describe('computeScores', () => {
  it('aggregates route, block, grain, and refusal scores', () => {
    const manifest = makeManifest({
      a: { status: 'certified', grain: 'week' },
      b: { status: 'certified', grain: 'customer_id' },
    });
    const results = [
      // certified-exact, fully correct
      scoreCase(
        { name: '1', question: 'q1', source: 'block_example', category: 'certified', expectRoute: 'certified', expectBlock: 'a', expectGrain: 'week' },
        makePlan({ route: 'certified', exactObjectKey: 'dql:block:a' }),
        manifest,
      ),
      // generated, correct route
      scoreCase(
        { name: '2', question: 'q2', source: 'yaml', category: 'generated', expectRoute: 'generated' },
        makePlan({ route: 'generated_sql' }),
        manifest,
      ),
      // refusal expected and produced
      scoreCase(
        { name: '3', question: 'q3', source: 'yaml', category: 'insufficient_context', expectRefuse: true },
        makePlan({ route: 'clarify', blocking: true }),
        manifest,
      ),
      // wrong grain: route ok, grain wrong
      scoreCase(
        { name: '4', question: 'q4', source: 'yaml', category: 'wrong_grain', expectRoute: 'certified', expectBlock: 'a', expectGrain: 'customer_id' },
        makePlan({ route: 'certified', exactObjectKey: 'dql:block:a' }),
        manifest,
      ),
    ];
    const scores = computeScores(results);
    expect(scores.total).toBe(4);
    // Case 3 is an expected safe refusal, so answer rate is measured over the
    // three answerable cases only; all three returned a non-refusal route.
    expect(scores.answerRate).toBe(1);
    // route expectations on cases 1, 2, 4 — all routes matched
    expect(scores.routeAccuracy).toBe(1);
    // block expectations on cases 1, 4 — both selected block a
    expect(scores.blockSelectionAccuracy).toBe(1);
    // grain expectations on cases 1 (pass) and 4 (fail) => 0.5
    expect(scores.grainMatchPrecision).toBe(0.5);
    // only case 3 refused, and it was correct => precision 1, recall 1
    expect(scores.refusalPrecision).toBe(1);
    expect(scores.refusalRecall).toBe(1);
  });

  it('returns null scores when a dimension has no expectations', () => {
    const scores = computeScores([]);
    expect(scores.answerRate).toBeNull();
    expect(scores.routeAccuracy).toBeNull();
    expect(scores.refusalRecall).toBeNull();
  });
});

describe('computeDistributions', () => {
  it('tracks actual cascade tiers, authored expectations, categories, and sources', () => {
    const manifest = makeManifest({
      a: { status: 'certified', grain: 'week' },
    });
    const results = [
      scoreCase(
        {
          name: 'certified',
          question: 'q1',
          source: 'block_example',
          category: 'certified',
          expectRoute: 'certified',
          expectBlock: 'a',
        },
        makePlan({ route: 'certified', exactObjectKey: 'dql:block:a' }),
        manifest,
      ),
      scoreCase(
        {
          name: 'generated',
          question: 'q2',
          source: 'yaml',
          category: 'generated',
          expectRoute: 'generated',
        },
        makePlan({ route: 'generated_sql' }),
        manifest,
      ),
      scoreCase(
        {
          name: 'refusal',
          question: 'q3',
          source: 'yaml',
          category: 'insufficient_context',
          expectRefuse: true,
        },
        makePlan({ route: 'clarify', blocking: true }),
        manifest,
      ),
      scoreCase(
        {
          name: 'research',
          question: 'q4',
          source: 'yaml',
          category: 'conflict',
          expectRoute: 'research',
        },
        makePlan({ route: 'research' }),
        manifest,
      ),
    ];

    expect(computeDistributions(results)).toEqual({
      actualRoutes: {
        certified: 1,
        generated: 1,
        missing_context: 1,
        research: 1,
      },
      expectedRoutes: {
        certified: 1,
        generated: 1,
        missing_context: 1,
        research: 1,
      },
      categories: {
        certified: 1,
        generated: 1,
        insufficient_context: 1,
        conflict: 1,
        wrong_grain: 0,
        question_plan: 0,
        follow_up: 0,
      },
      sources: {
        block_example: 1,
        yaml: 3,
      },
    });
  });
});

describe('meetsThresholds', () => {
  const base = {
    total: 10,
    passed: 9,
    routeAccuracy: 0.9,
    blockSelectionAccuracy: 0.8,
    grainMatchPrecision: 0.7,
    refusalPrecision: 1,
    refusalRecall: 0.85,
    answerRate: 0.9,
    executableCandidateRecall: 0.95,
  };

  it('fails when executable candidate recall is below its threshold', () => {
    // Recall bounds selection: if retrieval never surfaced the block, no router
    // change can fix block accuracy, and the report must say which half broke.
    expect(meetsThresholds(base, null, null, null, 0.98)).toBe(false);
    expect(meetsThresholds(base, null, null, null, 0.9)).toBe(true);
    expect(meetsThresholds({ ...base, executableCandidateRecall: null }, null, null, null, 0.98)).toBe(true);
  });

  it('passes when above both thresholds', () => {
    expect(meetsThresholds(base, 0.85, 0.8)).toBe(true);
  });

  it('fails when route accuracy is below the route threshold', () => {
    expect(meetsThresholds(base, 0.95, null)).toBe(false);
  });

  it('fails when refusal recall is below the refusal threshold', () => {
    expect(meetsThresholds(base, null, 0.9)).toBe(false);
  });

  it('fails when answer rate is below the answer-rate threshold', () => {
    expect(meetsThresholds(base, null, null, 0.95)).toBe(false);
  });

  it('ignores a threshold when the dimension has no measurable data (null score)', () => {
    expect(meetsThresholds({ ...base, refusalRecall: null }, null, 0.9)).toBe(true);
    expect(meetsThresholds({ ...base, answerRate: null }, null, null, 1)).toBe(true);
  });
});

describe('loadYamlEvalCases', () => {
  it('loads and normalizes eval/*.yaml cases including expectRefuse shorthand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-eval-yaml-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'routing.yaml'),
      [
        '- question: "rank revenue by region"',
        '  expectRoute: generated',
        '- question: "what is the meaning of life?"',
        '  expectRefuse: true',
        '- name: "explicit conflict"',
        '  question: "ambiguous revenue"',
        '  expectRoute: certified',
        '  expectBlock: "revenue_total"',
        '  category: conflict',
      ].join('\n'),
    );
    const cases = loadYamlEvalCases(dir);
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({ category: 'generated', expectRoute: 'generated', source: 'yaml' });
    expect(cases[1]).toMatchObject({ category: 'insufficient_context', expectRefuse: true });
    expect(cases[2]).toMatchObject({ category: 'conflict', expectBlock: 'revenue_total' });
  });

  it('returns [] when there is no eval directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-eval-empty-'));
    tempDirs.push(dir);
    expect(loadYamlEvalCases(dir)).toEqual([]);
  });
});

// ---- End-to-end: run the REAL router against a temp project ----

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-eval-e2e-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'eval_demo' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'top_scorers.dql'),
    `block "Top 10 Goal Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 NBA players by total points scored."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  llmContext = "Use for top scorers only."
  examples = [{ question = "Who were the top scorers?" }]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  mkdirSync(join(root, 'eval'), { recursive: true });
  writeFileSync(
    join(root, 'eval', 'refusal.yaml'),
    [
      '- name: "off-topic refusal"',
      '  question: "What is the airspeed velocity of an unladen swallow?"',
      '  expectRefuse: true',
    ].join('\n'),
  );
  return root;
}

describe('runEval (end-to-end against the real router)', () => {
  it('passes the checked-in lineage-app golden eval fixture at strict thresholds', async () => {
    const report = await runEvalHarness(join(FIXTURES_ROOT, 'lineage-app'), {
      includeBlockExamples: true,
      minRouteAccuracy: 1,
      minRefusal: 1,
      minAnswerRate: 1,
    });

    expect(report.ok).toBe(true);
    expect(report.scores.total).toBe(7);
    expect(report.scores.answerRate).toBe(1);
    expect(report.scores.routeAccuracy).toBe(1);
    expect(report.scores.refusalRecall).toBe(1);

    // The four authored approval-rate prompts are a Tier-1 contract: each
    // route must stop at the block that owns the SQL `rate` output.  A
    // generated route here would mean an otherwise retrieved block lost its
    // own output contract and Ask AI would unnecessarily invoke generation.
    const approvalRateCases = report.results.filter((result) =>
      result.expectBlock === 'card_approval_rate');
    expect(approvalRateCases).toHaveLength(4);
    for (const result of approvalRateCases) {
      expect(result.actualRoute).toBe('certified');
      expect(result.actualBlock).toBe('card_approval_rate');
      expect(result.failures).toEqual([]);
    }
  });

  it('keeps the lineage approval-rate block from certifying an unrelated measure', async () => {
    const plan = await planAgentAnswer(join(FIXTURES_ROOT, 'lineage-app'), {
      question: 'What is our card revenue?',
      surface: 'cli',
    });

    // AGT-009: exact block retrieval cannot borrow a role from its tags,
    // description, or a neighbouring candidate. The SQL contract owns `rate`,
    // not revenue, so this can continue to a later lane but never certify the
    // approval-rate block.
    expect(plan.routeDecision.route).not.toBe('certified');
    expect(plan.routeDecision.exactObjectKey).not.toBe('dql:block:card_approval_rate');
    expect(plan.routeDecision.blockFit?.missingMeasures).toContain('revenue');
  });

  it('passes the checked-in jaffle supply-chain golden eval fixture at strict thresholds', async () => {
    const report = await runEvalHarness(join(FIXTURES_ROOT, 'jaffle-supply-chain'), {
      includeBlockExamples: true,
      minRouteAccuracy: 1,
      minRefusal: 1,
      minAnswerRate: 1,
    });

    expect(report.ok).toBe(true);
    expect(report.scores.total).toBe(17);
    expect(report.scores.answerRate).toBe(1);
    expect(report.scores.routeAccuracy).toBe(1);
    expect(report.scores.blockSelectionAccuracy).toBe(1);
    expect(report.scores.grainMatchPrecision).toBe(1);
    expect(report.scores.refusalRecall).toBe(1);
    expect(report.results.find((result) => result.name === 'supply chain product order details require generated SQL')).toMatchObject({
      passed: true,
      actualRoute: 'generated',
      expectRoute: 'generated',
    });
  });

  it('emits a JSON report scoring a certified-exact example and a refusal', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEval(projectRoot, [], { format: 'json' } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.scores.total).toBe(2);
    expect(payload.scores.answerRate).toBe(1);
    expect(payload.distributions.actualRoutes.certified).toBe(1);
    expect(Object.values(payload.distributions.actualRoutes).reduce((sum: number, count) => sum + Number(count), 0)).toBe(2);

    const certified = payload.results.find((r: { source: string }) => r.source === 'block_example');
    expect(certified.actualRoute).toBe('certified');
    expect(certified.actualBlock).toBe('Top 10 Goal Scorers');
    expect(certified.passed).toBe(true);
    expect(certified.trace.map((stage: { stage: string }) => stage.stage)).toEqual(['context', 'route', 'scoring']);

    const refusal = payload.results.find((r: { source: string }) => r.source === 'yaml');
    expect(refusal.expectRefuse).toBe(true);
    // An off-topic question must not be answered by a certified block.
    expect(refusal.actualRoute).not.toBe('certified');
  });

  it('wires the threshold gate to the process exit code', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // The certified-exact example routes to `certified`, so route accuracy is 1.
    // A satisfiable threshold (0.5) must therefore pass and leave exitCode unset.
    await runEval(projectRoot, [], { format: 'json', minRouteAccuracy: 0.5 } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.scores.routeAccuracy).toBe(1);
    expect(payload.ok).toBe(true);
    // ok report => exit code stays unset (treated as success by CI).
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when the refusal recall threshold is not met', async () => {
    const projectRoot = seedProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Demand perfect refusal recall. If the router fails to refuse the off-topic
    // yaml case, recall < 1 and the gate must fail (exit 1). If it does refuse,
    // recall is 1 and the report is ok. Either way the exit code must agree with
    // the report's `ok` flag — that is the contract we assert.
    await runEval(projectRoot, [], { format: 'json', minRefusal: 1 } as never);

    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    if (payload.ok) {
      expect(process.exitCode).toBeUndefined();
    } else {
      expect(process.exitCode).toBe(1);
    }
  });
});

describe('runEval --init and the text report', () => {
  function emptyProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'dql-eval-init-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'eval_init' }), 'utf-8');
    return root;
  }

  it('writes a Jaffle-style golden template whose cases load once uncommented', async () => {
    const projectRoot = emptyProject();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEval(projectRoot, [], { format: 'text', init: true } as never);

    const template = readFileSync(join(projectRoot, 'eval', 'golden.yaml'), 'utf-8');
    // The starter used to ship another project's metrics and customers.
    expect(template).not.toMatch(/BCM|Capital One|consumption|campaign/i);
    expect(template).toContain('monthly_revenue');
    expect(template).toContain('Matthew Meyer');

    writeFileSync(
      join(projectRoot, 'eval', 'golden.yaml'),
      template.replace(/^  # (- name:|  )/gm, '  $1'),
      'utf-8',
    );
    const cases = loadYamlEvalCases(projectRoot);
    expect(cases.map((testCase) => [testCase.category, testCase.expectRoute ?? null])).toEqual([
      ['certified', 'certified'],
      ['generated', 'generated'],
      ['follow_up', null],
      ['insufficient_context', null],
    ]);
    expect(cases[1]!.expectFilters).toEqual(['Matthew Meyer']);
    expect(cases[2]!.priorQuestion).toBe('How has revenue changed by month?');
    expect(cases[3]!.expectRefuse).toBe(true);
  });

  it('does not tell the reader to run zlens compile when there are no cases', async () => {
    const projectRoot = emptyProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEval(projectRoot, [], { format: 'text' } as never);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('No eval cases found.');
    expect(output).toContain('zlens eval --init');
    expect(output).not.toContain('zlens compile');
  });

  it('says when a threshold is not applied because no case measures it', async () => {
    const projectRoot = seedProject();
    rmSync(join(projectRoot, 'eval'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEval(projectRoot, [], { format: 'text', minRouteAccuracy: 1, minRefusal: 1 } as never);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('--min-refusal 1  (refusal recall n/a: no case measures this, so it is not applied)');
    expect(output).toContain('--min-route-accuracy 1  (route accuracy 100%)');
    expect(process.exitCode).toBeUndefined();
  });
});

// ---- Question-plan shape + follow-up scoring (accuracy-harness extension) ----

describe('scoreCase plan-shape expectations', () => {
  const manifest = makeManifest({});
  const base: EvalCase = {
    name: 'shape',
    question: 'What is the Previous Day BCM?',
    source: 'yaml',
    category: 'question_plan',
  };

  it('passes when metric terms and filter guards hold', () => {
    const result = scoreCase(
      { ...base, expectMetricTerms: ['previous day bcm'], expectNoFilters: ['Previous Day'] },
      makePlan({ route: 'generated_sql', metricTerms: ['previous day bcm'], filters: [] }),
      manifest,
    );
    expect(result.passed).toBe(true);
    expect(result.planShapeMatch).toBe(true);
  });

  it('fails when a governed name was misparsed as a member filter', () => {
    const result = scoreCase(
      { ...base, expectNoFilters: ['Previous Day'] },
      makePlan({ route: 'generated_sql', filters: ['Previous Day'] }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('misparsed as a member filter');
  });

  it('fails when a real member filter was dropped', () => {
    const result = scoreCase(
      { ...base, expectFilters: ['Capital One'] },
      makePlan({ route: 'generated_sql', filters: [] }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('was dropped');
  });

  it('normalizes case and underscores when matching metric terms', () => {
    const result = scoreCase(
      { ...base, expectMetricTerms: ['previous_day_bcm'] },
      makePlan({ route: 'generated_sql', metricTerms: ['Previous Day BCM total'] }),
      manifest,
    );
    expect(result.planShapeMatch).toBe(true);
  });

  it('guards against sticky metric carry via expectNoMetricTerms', () => {
    const result = scoreCase(
      { ...base, expectNoMetricTerms: ['daily consumption'] },
      makePlan({ route: 'generated_sql', metricTerms: ['daily_consumption'] }),
      manifest,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('must not carry');
  });

  it('checks required evidence object keys in the context pack', () => {
    const found = scoreCase(
      { ...base, expectEvidence: ['semantic:metric:consumption.previous_day_bcm'] },
      makePlan({ route: 'generated_sql', objectKeys: ['semantic:metric:consumption.previous_day_bcm'] }),
      manifest,
    );
    expect(found.passed).toBe(true);

    const missing = scoreCase(
      { ...base, expectEvidence: ['semantic:metric:consumption.previous_day_bcm'] },
      makePlan({ route: 'generated_sql', objectKeys: [] }),
      manifest,
    );
    expect(missing.passed).toBe(false);
    expect(missing.failures.join(' ')).toContain('missing evidence');
  });
});

describe('loadYamlEvalCases follow-up and plan-shape fields', () => {
  it('parses thread and plan-shape expectations from yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-eval-yaml-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'golden.yaml'),
      [
        'cases:',
        '  - name: follow-up switches metric',
        '    priorQuestion: "daily consumption today"',
        '    topicRelation: continuation',
        '    priorMeasures: ["daily_consumption"]',
        '    question: "consumption % by customer"',
        '    expectMetricTerms: ["percent"]',
        '    expectNoMetricTerms: ["daily consumption"]',
        '  - name: title case is not a filter',
        '    question: "What is the Previous Day BCM?"',
        '    expectNoFilters: ["Previous Day"]',
        '    expectEvidence: ["semantic:metric:consumption.previous_day_bcm"]',
      ].join('\n'),
      'utf-8',
    );

    const cases = loadYamlEvalCases(dir);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      category: 'follow_up',
      priorQuestion: 'daily consumption today',
      topicRelation: 'continuation',
      priorMeasures: ['daily_consumption'],
      expectMetricTerms: ['percent'],
      expectNoMetricTerms: ['daily consumption'],
    });
    expect(cases[1]).toMatchObject({
      category: 'question_plan',
      expectNoFilters: ['Previous Day'],
      expectEvidence: ['semantic:metric:consumption.previous_day_bcm'],
    });
  });
});
