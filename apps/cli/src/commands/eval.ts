/**
 * `zlens eval` — Routing-accuracy harness for the DQL answer agent.
 *
 * Replays a golden set of questions through the EXISTING agent router
 * (`planAgentAnswer`) and scores how well DQL routes each question:
 * certified vs generated vs missing-context (refusal), which certified block
 * it selected, and whether the answer grain matches.
 *
 * The golden set comes from two sources:
 *   1. Every certified block's `examples[].question` in the compiled manifest.
 *      These expect route = certified and expect that same block to be selected.
 *   2. Optional `eval/*.yaml` files in the project, each a list (or { cases: [] })
 *      of `{ question, expectRoute, expectBlock?, expectGrain?, expectRefuse?, name? }`.
 *      These let a repo express the harder categories the block examples cannot:
 *      generated (Tier-2), insufficient-context (refusal), conflict, wrong-grain.
 *
 * This command READS the router output only. It never executes SQL against a
 * warehouse and never changes routing, the manifest schema, or the DQL language.
 *
 * Usage:
 *   zlens eval [path]                          Replay the golden set, print a report
 *   zlens eval [path] --format json            Emit a machine-readable JSON report
 *   zlens eval [path] --min-route-accuracy 0.9 Fail (exit 1) below this route accuracy
 *   zlens eval [path] --min-refusal 0.8        Fail (exit 1) below this refusal recall
 *   zlens eval [path] --min-answer-rate 0.9    Fail below answer rate on answerable cases
 *   zlens eval [path] --no-examples            Skip manifest block examples (yaml only)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  buildManifest,
  resolveDbtManifestPath,
  type DQLManifest,
  type ManifestBlock,
} from '@zlens/core';
import { planAgentAnswer, type PlanAgentAnswerResult } from '@zlens/agent';
import type { CLIFlags } from '../args.js';

/** Spec-facing route labels. The router speaks certified/generated_sql/research/clarify. */
export type EvalRoute = 'certified' | 'generated' | 'missing_context' | 'research';

/** The categories the harness can express and score. */
export type EvalCategory =
  | 'certified'
  | 'generated'
  | 'insufficient_context'
  | 'conflict'
  | 'wrong_grain'
  | 'question_plan'
  | 'follow_up';

export interface EvalCase {
  /** Stable label for the report. Defaults to the question. */
  name: string;
  question: string;
  /** Where this case came from. */
  source: 'block_example' | 'yaml';
  /** Which scoring category this case exercises. */
  category: EvalCategory;
  /**
   * Prior turn replayed before this question. Its context pack is handed to the
   * follow-up (priorContextPackId + topic relation), so thread bugs — sticky
   * metric carry, poisoned working state, member-binding follow-ups — are
   * expressible as golden cases.
   */
  priorQuestion?: string;
  /** How this question relates to the prior turn. Default: continuation. */
  topicRelation?: 'continuation' | 'refinement' | 'return' | 'shift';
  /** Measures the prior turn answered with (models sticky-metric carry). */
  priorMeasures?: string[];
  expectRoute?: EvalRoute;
  /** Block name we expect the router to select (only meaningful for certified). */
  expectBlock?: string;
  /** Grain we expect the selected block to carry. */
  expectGrain?: string;
  /** When true, we expect a safe refusal (route = missing_context). */
  expectRefuse?: boolean;
  /** Terms that must appear among the question plan's metric terms (case-insensitive contains). */
  expectMetricTerms?: string[];
  /** Terms that must NOT appear among the metric terms (sticky-carry guard). */
  expectNoMetricTerms?: string[];
  /** Phrases that must survive as member filters in the requested shape. */
  expectFilters?: string[];
  /** Phrases that must NOT appear as member filters (governed-name misparse guard). */
  expectNoFilters?: string[];
  /** Object keys that must be present in the retrieved context pack. */
  expectEvidence?: string[];
}

export interface EvalCaseResult {
  name: string;
  question: string;
  source: EvalCase['source'];
  category: EvalCategory;
  passed: boolean;
  /** What the router actually did. */
  actualRoute: EvalRoute;
  actualBlock?: string;
  actualGrain?: string;
  hasBlockingMissingContext: boolean;
  /** Per-check expectations + outcomes for the human report and JSON. */
  expectRoute?: EvalRoute;
  expectBlock?: string;
  expectGrain?: string;
  expectRefuse?: boolean;
  routeMatch?: boolean;
  blockMatch?: boolean;
  grainMatch?: boolean;
  refusalMatch?: boolean;
  /** Question-plan shape outcomes (metric terms + member filters + evidence). */
  planShapeMatch?: boolean;
  /**
   * Was the expected block RETRIEVED at all, regardless of whether the router
   * then chose it? Separates a retrieval miss from a routing miss — without it
   * a drop in `blockSelectionAccuracy` cannot tell you which half broke.
   */
  retrievedExpectedBlock?: boolean;
  failures: string[];
  trace: EvalTraceStage[];
}

export interface EvalTraceStage {
  stage: 'context' | 'route' | 'scoring';
  status: 'passed' | 'failed' | 'not_run' | 'info';
  message: string;
  payload?: unknown;
}

export interface EvalScores {
  total: number;
  passed: number;
  /** answer rate: non-refusal route / cases that did not expect a safe refusal. */
  answerRate: number | null;
  /** route accuracy: cases whose expected route matched / cases with a route expectation. */
  routeAccuracy: number | null;
  /** block-selection accuracy: correct block / cases that expected a specific block. */
  blockSelectionAccuracy: number | null;
  /** grain-match precision: correct grain / cases that expected a specific grain. */
  grainMatchPrecision: number | null;
  /**
   * executable candidate recall: expected block present in the retrieved
   * context / cases that expected a specific block. The router can only choose
   * from what retrieval surfaced, so this bounds every selection metric above.
   */
  executableCandidateRecall: number | null;
  /** refusal precision: true refusals / all router refusals across the set. */
  refusalPrecision: number | null;
  /** refusal recall: refusals correctly produced / cases that expected a refusal. */
  refusalRecall: number | null;
}

export type EvalRouteDistribution = Record<EvalRoute, number>;
export type EvalCategoryDistribution = Record<EvalCategory, number>;
export type EvalSourceDistribution = Record<EvalCase['source'], number>;

export interface EvalDistributions {
  /** Router-selected cascade tier for each case. This is the PR drift signal. */
  actualRoutes: EvalRouteDistribution;
  /** Expected tier coverage from the golden set, when authored. */
  expectedRoutes: EvalRouteDistribution;
  categories: EvalCategoryDistribution;
  sources: EvalSourceDistribution;
}

export interface EvalReport {
  ok: boolean;
  scores: EvalScores;
  distributions: EvalDistributions;
  thresholds: { minRouteAccuracy: number | null; minRefusal: number | null; minAnswerRate: number | null; minCandidateRecall: number | null };
  results: EvalCaseResult[];
}

const ZERO_RESULTS: EvalCaseResult[] = [];

/** Map the router's route vocabulary onto the spec's route labels. */
export function mapRoute(route: PlanAgentAnswerResult['routeDecision']['route']): EvalRoute {
  switch (route) {
    case 'certified':
      return 'certified';
    case 'generated_sql':
      return 'generated';
    case 'clarify':
      return 'missing_context';
    case 'research':
      return 'research';
    default:
      return 'missing_context';
  }
}

function blockNameFromObjectKey(objectKey: string | undefined): string | undefined {
  if (!objectKey) return undefined;
  // Certified block keys are minted as `dql:block:<name>`.
  return objectKey.replace(/^dql:block:/, '');
}

function isCertified(block: ManifestBlock): boolean {
  return String(block.status ?? '').toLowerCase() === 'certified';
}

function normalizeGrain(grain: string | undefined): string {
  return String(grain ?? '').trim().toLowerCase();
}

/** Case/underscore/space-insensitive matching for plan-shape expectations. */
function normalizeTerm(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

/**
 * Build the golden set from a compiled manifest plus optional eval/*.yaml.
 * Each certified block contributes one case per example question.
 */
export function collectEvalCases(
  manifest: DQLManifest,
  yamlCases: EvalCase[],
  includeBlockExamples: boolean,
): EvalCase[] {
  const cases: EvalCase[] = [];

  if (includeBlockExamples) {
    for (const block of Object.values(manifest.blocks ?? {})) {
      if (!isCertified(block)) continue;
      for (const example of block.examples ?? []) {
        const question = example.question?.trim();
        if (!question) continue;
        cases.push({
          name: `${block.name} · ${question}`,
          question,
          source: 'block_example',
          category: 'certified',
          expectRoute: 'certified',
          expectBlock: block.name,
          expectGrain: block.grain,
        });
      }
    }
  }

  cases.push(...yamlCases);
  return cases;
}

/** Score a single case against the router's decision. Pure + unit-testable. */
export function scoreCase(
  testCase: EvalCase,
  plan: PlanAgentAnswerResult,
  manifest: DQLManifest,
): EvalCaseResult {
  const actualRoute = mapRoute(plan.routeDecision.route);
  const actualBlock = blockNameFromObjectKey(plan.routeDecision.exactObjectKey);
  const actualGrain = actualBlock ? manifest.blocks?.[actualBlock]?.grain : undefined;
  const hasBlockingMissingContext = (plan.missingContext ?? []).some(
    (item) => item.severity === 'blocking',
  );
  // Certified block keys are minted as `dql:block:<name>`.
  //
  // Only measured when retrieval actually returned objects. An empty pack means
  // recall is UNKNOWN, not zero — scoring it as a miss would turn every
  // stubbed or context-free plan into a false retrieval failure.
  const retrievedObjects = plan.contextPack?.objects ?? [];
  const retrievedExpectedBlock = testCase.expectBlock === undefined || retrievedObjects.length === 0
    ? undefined
    : retrievedObjects.some((object) =>
      blockNameFromObjectKey(object.objectKey) === testCase.expectBlock);

  const failures: string[] = [];

  // Refusal expectation takes precedence: a refusal means route = missing_context.
  const expectRoute = testCase.expectRefuse ? 'missing_context' : testCase.expectRoute;

  let routeMatch: boolean | undefined;
  if (expectRoute !== undefined) {
    routeMatch = actualRoute === expectRoute;
    if (!routeMatch) failures.push(`route expected ${expectRoute}, got ${actualRoute}`);
  }

  let refusalMatch: boolean | undefined;
  if (testCase.expectRefuse !== undefined) {
    const actuallyRefused = actualRoute === 'missing_context';
    refusalMatch = actuallyRefused === testCase.expectRefuse;
    if (!refusalMatch) {
      failures.push(
        testCase.expectRefuse
          ? `expected a safe refusal, got route ${actualRoute}`
          : `expected no refusal, but router refused`,
      );
    }
  }

  let blockMatch: boolean | undefined;
  if (testCase.expectBlock !== undefined) {
    blockMatch = actualBlock === testCase.expectBlock;
    if (!blockMatch) {
      failures.push(`block expected ${testCase.expectBlock}, got ${actualBlock ?? 'none'}`);
    }
  }

  if (retrievedExpectedBlock === false) {
    failures.push(`retrieval did not surface expected block ${testCase.expectBlock}`);
  }

  let grainMatch: boolean | undefined;
  if (testCase.expectGrain !== undefined) {
    grainMatch = normalizeGrain(actualGrain) === normalizeGrain(testCase.expectGrain);
    if (!grainMatch) {
      failures.push(`grain expected ${testCase.expectGrain}, got ${actualGrain ?? 'none'}`);
    }
  }

  let planShapeMatch: boolean | undefined;
  const hasPlanExpectations = Boolean(
    testCase.expectMetricTerms?.length
    || testCase.expectNoMetricTerms?.length
    || testCase.expectFilters?.length
    || testCase.expectNoFilters?.length
    || testCase.expectEvidence?.length,
  );
  if (hasPlanExpectations) {
    const questionPlan = plan.contextPack?.questionPlan;
    const metricTerms = (questionPlan?.metricTerms ?? []).map(normalizeTerm);
    const filters = (questionPlan?.requestedShape?.filters ?? []).map(normalizeTerm);
    const objectKeys = new Set((plan.contextPack?.objects ?? []).map((object) => object.objectKey));
    const planFailures: string[] = [];

    for (const term of testCase.expectMetricTerms ?? []) {
      if (!metricTerms.some((actual) => actual.includes(normalizeTerm(term)))) {
        planFailures.push(`metric terms missing "${term}" (got: ${metricTerms.join(', ') || 'none'})`);
      }
    }
    for (const term of testCase.expectNoMetricTerms ?? []) {
      if (metricTerms.some((actual) => actual.includes(normalizeTerm(term)))) {
        planFailures.push(`metric terms must not carry "${term}" (got: ${metricTerms.join(', ')})`);
      }
    }
    for (const phrase of testCase.expectFilters ?? []) {
      if (!filters.some((actual) => actual.includes(normalizeTerm(phrase)))) {
        planFailures.push(`member filter "${phrase}" was dropped (got: ${filters.join(', ') || 'none'})`);
      }
    }
    for (const phrase of testCase.expectNoFilters ?? []) {
      if (filters.some((actual) => actual.includes(normalizeTerm(phrase)))) {
        planFailures.push(`"${phrase}" was misparsed as a member filter (got: ${filters.join(', ')})`);
      }
    }
    for (const objectKey of testCase.expectEvidence ?? []) {
      if (!objectKeys.has(objectKey)) {
        planFailures.push(`context pack is missing evidence ${objectKey}`);
      }
    }

    planShapeMatch = planFailures.length === 0;
    failures.push(...planFailures);
  }

  const result: Omit<EvalCaseResult, 'trace'> = {
    name: testCase.name,
    question: testCase.question,
    source: testCase.source,
    category: testCase.category,
    passed: failures.length === 0,
    actualRoute,
    actualBlock,
    actualGrain,
    hasBlockingMissingContext,
    expectRoute,
    expectBlock: testCase.expectBlock,
    expectGrain: testCase.expectGrain,
    expectRefuse: testCase.expectRefuse,
    routeMatch,
    blockMatch,
    grainMatch,
    refusalMatch,
    planShapeMatch,
    ...(retrievedExpectedBlock !== undefined ? { retrievedExpectedBlock } : {}),
    failures,
  };
  return {
    ...result,
    trace: buildRoutingEvalTrace(testCase, plan, result),
  };
}

function buildRoutingEvalTrace(
  testCase: EvalCase,
  plan: PlanAgentAnswerResult,
  result: Omit<EvalCaseResult, 'trace'>,
): EvalTraceStage[] {
  const contextPack = plan.contextPack;
  const routeDecision = plan.routeDecision;
  return [
    {
      stage: 'context',
      status: contextPack ? 'passed' : 'not_run',
      message: contextPack
        ? `Context pack ${plan.contextPackId} selected ${contextPack.objects?.length ?? 0} object(s).`
        : 'No context pack was returned by the router.',
      payload: contextPack
        ? {
            contextPackId: plan.contextPackId,
            selectedObjectCount: contextPack.objects?.length ?? 0,
            allowedRelationCount: contextPack.allowedSqlContext?.relations?.length ?? 0,
            selectedRelations: contextPack.retrievalDiagnostics?.selectedRelations?.slice(0, 12).map((relation) => relation.relation) ?? [],
            missingContext: plan.missingContext,
            warnings: plan.warnings,
          }
        : undefined,
    },
    {
      stage: 'route',
      status: routeDecision ? 'passed' : 'failed',
      message: routeDecision
        ? `Router selected ${result.actualRoute}${result.actualBlock ? ` via ${result.actualBlock}` : ''}.`
        : 'Router did not return a route decision.',
      payload: {
        route: routeDecision?.route,
        mappedRoute: result.actualRoute,
        intent: routeDecision?.intent,
        reason: routeDecision?.reason,
        trustLabel: routeDecision?.trustLabel,
        reviewStatus: routeDecision?.reviewStatus,
        exactObjectKey: routeDecision?.exactObjectKey,
        selectedEvidence: routeDecision?.selectedEvidence?.slice(0, 12),
      },
    },
    {
      stage: 'scoring',
      status: result.passed ? 'passed' : 'failed',
      message: result.passed
        ? 'Case passed all configured expectations.'
        : `Case failed ${result.failures.length} expectation(s).`,
      payload: {
        category: testCase.category,
        expected: {
          route: result.expectRoute,
          block: result.expectBlock,
          grain: result.expectGrain,
          refuse: result.expectRefuse,
        },
        actual: {
          route: result.actualRoute,
          block: result.actualBlock,
          grain: result.actualGrain,
          hasBlockingMissingContext: result.hasBlockingMissingContext,
        },
        failures: result.failures,
      },
    },
  ];
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

/** Aggregate per-case results into the spec's score set. Pure + unit-testable. */
export function computeScores(results: EvalCaseResult[]): EvalScores {
  const routeCases = results.filter((r) => r.expectRoute !== undefined);
  const blockCases = results.filter((r) => r.expectBlock !== undefined);
  const grainCases = results.filter((r) => r.expectGrain !== undefined);
  const refusalExpected = results.filter((r) => r.expectRefuse === true);
  const answerExpected = results.filter((r) => r.expectRefuse !== true);

  // Refusal precision: of every case where the router refused, how many should have?
  const routerRefused = results.filter((r) => r.actualRoute === 'missing_context');
  const routerRefusedCorrectly = routerRefused.filter((r) => r.expectRefuse === true);

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    answerRate: ratio(
      answerExpected.filter((r) => r.actualRoute !== 'missing_context').length,
      answerExpected.length,
    ),
    routeAccuracy: ratio(routeCases.filter((r) => r.routeMatch).length, routeCases.length),
    blockSelectionAccuracy: ratio(
      blockCases.filter((r) => r.blockMatch).length,
      blockCases.length,
    ),
    grainMatchPrecision: ratio(grainCases.filter((r) => r.grainMatch).length, grainCases.length),
    executableCandidateRecall: ratio(
      blockCases.filter((r) => r.retrievedExpectedBlock).length,
      blockCases.length,
    ),
    refusalPrecision: ratio(routerRefusedCorrectly.length, routerRefused.length),
    refusalRecall: ratio(
      refusalExpected.filter((r) => r.refusalMatch).length,
      refusalExpected.length,
    ),
  };
}

function emptyRouteDistribution(): EvalRouteDistribution {
  return {
    certified: 0,
    generated: 0,
    missing_context: 0,
    research: 0,
  };
}

function emptyCategoryDistribution(): EvalCategoryDistribution {
  return {
    certified: 0,
    generated: 0,
    insufficient_context: 0,
    conflict: 0,
    wrong_grain: 0,
    question_plan: 0,
    follow_up: 0,
  };
}

function emptySourceDistribution(): EvalSourceDistribution {
  return {
    block_example: 0,
    yaml: 0,
  };
}

/** Aggregate stable PR-facing distribution counters from scored cases. */
export function computeDistributions(results: EvalCaseResult[]): EvalDistributions {
  const actualRoutes = emptyRouteDistribution();
  const expectedRoutes = emptyRouteDistribution();
  const categories = emptyCategoryDistribution();
  const sources = emptySourceDistribution();

  for (const result of results) {
    actualRoutes[result.actualRoute] += 1;
    categories[result.category] += 1;
    sources[result.source] += 1;
    if (result.expectRoute) expectedRoutes[result.expectRoute] += 1;
    if (result.expectRefuse === true && !result.expectRoute) {
      expectedRoutes.missing_context += 1;
    }
  }

  return { actualRoutes, expectedRoutes, categories, sources };
}

interface RawYamlCase {
  name?: string;
  question?: string;
  priorQuestion?: string;
  topicRelation?: string;
  priorMeasures?: string[];
  expectRoute?: string;
  expectBlock?: string;
  expectGrain?: string;
  expectRefuse?: boolean;
  expectMetricTerms?: string[];
  expectNoMetricTerms?: string[];
  expectFilters?: string[];
  expectNoFilters?: string[];
  expectEvidence?: string[];
  category?: string;
}

function normalizeTopicRelation(value: string | undefined): EvalCase['topicRelation'] {
  const v = value?.trim().toLowerCase();
  if (v === 'continuation' || v === 'refinement' || v === 'return' || v === 'shift') return v;
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeYamlRoute(value: string | undefined): EvalRoute | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'certified') return 'certified';
  if (v === 'generated' || v === 'generated_sql') return 'generated';
  if (v === 'missing_context' || v === 'missing-context' || v === 'clarify' || v === 'refuse') {
    return 'missing_context';
  }
  if (v === 'research') return 'research';
  return undefined;
}

function inferCategory(raw: RawYamlCase, route: EvalRoute | undefined): EvalCategory {
  const explicit = raw.category?.trim().toLowerCase();
  if (explicit === 'certified') return 'certified';
  if (explicit === 'generated') return 'generated';
  if (explicit === 'insufficient_context' || explicit === 'refusal') return 'insufficient_context';
  if (explicit === 'conflict') return 'conflict';
  if (explicit === 'wrong_grain') return 'wrong_grain';
  if (explicit === 'question_plan') return 'question_plan';
  if (explicit === 'follow_up') return 'follow_up';
  // Infer from expectations when the author did not label it.
  if (raw.priorQuestion) return 'follow_up';
  if (raw.expectRefuse) return 'insufficient_context';
  if (route === 'missing_context') return 'insufficient_context';
  if (route === 'generated') return 'generated';
  if (
    raw.expectMetricTerms || raw.expectNoMetricTerms
    || raw.expectFilters || raw.expectNoFilters || raw.expectEvidence
  ) {
    return 'question_plan';
  }
  return 'certified';
}

/** Load and normalize all `eval/*.yaml` cases for a project. */
export function loadYamlEvalCases(projectRoot: string): EvalCase[] {
  const evalDir = join(projectRoot, 'eval');
  if (!existsSync(evalDir)) return [];

  const files = readdirSync(evalDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const cases: EvalCase[] = [];

  for (const file of files.sort()) {
    const raw = loadYaml(readFileSync(join(evalDir, file), 'utf-8')) as
      | RawYamlCase[]
      | { cases?: RawYamlCase[] }
      | null;
    const rawCases = Array.isArray(raw) ? raw : raw?.cases ?? [];
    for (const rc of rawCases) {
      const question = rc.question?.trim();
      if (!question) continue;
      const route = normalizeYamlRoute(rc.expectRoute);
      cases.push({
        name: rc.name?.trim() || `${file} · ${question}`,
        question,
        source: 'yaml',
        category: inferCategory(rc, route),
        priorQuestion: rc.priorQuestion?.trim() || undefined,
        topicRelation: normalizeTopicRelation(rc.topicRelation),
        priorMeasures: stringList(rc.priorMeasures),
        expectRoute: route,
        expectBlock: rc.expectBlock?.trim() || undefined,
        expectGrain: rc.expectGrain?.trim() || undefined,
        expectRefuse: typeof rc.expectRefuse === 'boolean' ? rc.expectRefuse : undefined,
        expectMetricTerms: stringList(rc.expectMetricTerms),
        expectNoMetricTerms: stringList(rc.expectNoMetricTerms),
        expectFilters: stringList(rc.expectFilters),
        expectNoFilters: stringList(rc.expectNoFilters),
        expectEvidence: stringList(rc.expectEvidence),
      });
    }
  }

  return cases;
}

/**
 * Run the full eval: build (or read) the manifest, collect cases, replay each
 * through the router, score, and assemble the report. Side-effect free except
 * for invoking the (read-only) router. Returns a structured report.
 */
export async function runEvalHarness(
  projectRoot: string,
  options: {
    includeBlockExamples: boolean;
    minRouteAccuracy: number | null;
    minRefusal: number | null;
    minAnswerRate?: number | null;
    minCandidateRecall?: number | null;
  },
): Promise<EvalReport> {
  const manifest = buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });

  const yamlCases = loadYamlEvalCases(projectRoot);
  const cases = collectEvalCases(manifest, yamlCases, options.includeBlockExamples);

  const results: EvalCaseResult[] = [];
  for (const testCase of cases) {
    // Thread cases replay the prior turn first so the follow-up sees exactly
    // what a live conversation would: the prior context pack + topic relation.
    let priorContextPackId: string | undefined;
    if (testCase.priorQuestion) {
      const priorPlan = await planAgentAnswer(projectRoot, {
        question: testCase.priorQuestion,
        surface: 'cli',
      });
      priorContextPackId = priorPlan.contextPackId;
    }
    const plan = await planAgentAnswer(projectRoot, {
      question: testCase.question,
      surface: 'cli',
      ...(testCase.priorQuestion
        ? {
            priorContextPackId,
            conversationTopicRelation: testCase.topicRelation ?? 'continuation',
            followUp: {
              kind: 'generic' as const,
              sourceQuestion: testCase.priorQuestion,
              ...(testCase.priorMeasures ? { priorMeasures: testCase.priorMeasures } : {}),
            },
          }
        : {}),
    });
    results.push(scoreCase(testCase, plan, manifest));
  }

  const scores = computeScores(results.length > 0 ? results : ZERO_RESULTS);
  const distributions = computeDistributions(results.length > 0 ? results : ZERO_RESULTS);
  const minAnswerRate = options.minAnswerRate ?? null;
  const minCandidateRecall = options.minCandidateRecall ?? null;
  const ok = meetsThresholds(scores, options.minRouteAccuracy, options.minRefusal, minAnswerRate, minCandidateRecall);

  return {
    ok,
    scores,
    distributions,
    thresholds: {
      minCandidateRecall,
      minRouteAccuracy: options.minRouteAccuracy,
      minRefusal: options.minRefusal,
      minAnswerRate,
    },
    results,
  };
}

/** A threshold gate only fails when a configured threshold has measurable data below it. */
export function meetsThresholds(
  scores: EvalScores,
  minRouteAccuracy: number | null,
  minRefusal: number | null,
  minAnswerRate: number | null = null,
  minCandidateRecall: number | null = null,
): boolean {
  if (
    minRouteAccuracy !== null &&
    scores.routeAccuracy !== null &&
    scores.routeAccuracy < minRouteAccuracy
  ) {
    return false;
  }
  if (minRefusal !== null && scores.refusalRecall !== null && scores.refusalRecall < minRefusal) {
    return false;
  }
  if (minAnswerRate !== null && scores.answerRate !== null && scores.answerRate < minAnswerRate) {
    return false;
  }
  // Recall bounds every selection metric: the router can only choose from what
  // retrieval surfaced, so a drop here explains a drop there.
  if (
    minCandidateRecall !== null &&
    scores.executableCandidateRecall !== null &&
    scores.executableCandidateRecall < minCandidateRecall
  ) {
    return false;
  }
  return true;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
}

/** A threshold with no case measuring it is skipped (see meetsThresholds); say so. */
function formatThresholdActual(value: number | null): string {
  return value === null ? 'n/a: no case measures this, so it is not applied' : formatRate(value);
}

function formatCountAndShare(count: number, total: number): string {
  const share = total === 0 ? 'n/a' : formatRate(count / total);
  return `${count} (${share})`;
}

const GOLDEN_TEMPLATE = `# ZLens golden eval set — replayed by \`zlens eval\` through the real agent router.
# No warehouse queries, no LLM calls: routing, block selection, and question-plan
# shape are scored deterministically, so this file is CI-gateable.
#
# Add one case per question your team actually asks. When the agent gets a
# question wrong, add that question here BEFORE fixing it. The examples below
# use the Jaffle Shop sample's blocks; swap in your own block names.
cases:
  # Tier pick: this question must terminate on a certified block.
  # - name: monthly revenue → certified block
  #   question: "How has revenue changed by month?"
  #   expectRoute: certified
  #   expectBlock: monthly_revenue

  # Member filter: a named customer is a filter the certified block cannot
  # apply (it runs its SQL as written), so the answer is generated, and the
  # name must survive as the filter.
  # - name: named customer → generated, filter kept
  #   question: "Give me the complete profile for Matthew Meyer."
  #   expectRoute: generated
  #   expectFilters: ["Matthew Meyer"]

  # Follow-up metric switch: a follow-up naming a DIFFERENT metric must not
  # stay stuck on the previous turn's metric.
  # - name: follow-up switches metric
  #   priorQuestion: "How has revenue changed by month?"
  #   question: "What about the number of orders by month?"
  #   expectMetricTerms: ["order"]
  #   expectNoMetricTerms: ["revenue"]

  # Safe refusal: questions your data cannot answer should refuse, not guess.
  # - name: unanswerable refuses
  #   question: "What is our employee attrition rate?"
  #   expectRefuse: true
`;

function writeGoldenTemplate(projectRoot: string): void {
  const evalDir = join(projectRoot, 'eval');
  const target = join(evalDir, 'golden.yaml');
  if (existsSync(target)) {
    console.log(`eval/golden.yaml already exists — not overwriting (${target}).`);
    return;
  }
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(target, GOLDEN_TEMPLATE, 'utf-8');
  console.log('Wrote eval/golden.yaml — uncomment and adapt the sample cases, then run `zlens eval`.');
}

export async function runEval(
  pathArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const allArgs = [...(pathArg ? [pathArg] : []), ...rest];
  const positional = allArgs.filter((a) => !a.startsWith('-'));
  const projectRoot = resolve(positional[0] ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error(
      'No ZLens project found (missing dql.config.json). Run from a project root or pass a project path.',
    );
    process.exitCode = 1;
    return;
  }

  if (flags.init) {
    writeGoldenTemplate(projectRoot);
    return;
  }

  const includeBlockExamples = !flags.noExamples;
  const minRouteAccuracy = flags.minRouteAccuracy ?? null;
  const minCandidateRecallFlag = flags.minCandidateRecall ?? null;
  const minRefusal = flags.minRefusal ?? null;
  const minAnswerRate = flags.minAnswerRate ?? null;

  const report = await runEvalHarness(projectRoot, {
    includeBlockExamples,
    minRouteAccuracy,
    minCandidateRecall: minCandidateRecallFlag,
    minRefusal,
    minAnswerRate,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  printReport(report);
  if (!report.ok) process.exitCode = 1;
}

function printReport(report: EvalReport): void {
  const { results, scores, distributions } = report;

  console.log('\n  ZLens Eval — routing accuracy');
  console.log('  ' + '='.repeat(50));

  if (results.length === 0) {
    // eval builds the manifest from source itself: no `zlens compile` needed.
    console.log('\n  No eval cases found.');
    console.log('  Add `examples = [{ question = "..." }]` to certified blocks,');
    console.log('  or add eval/*.yaml cases (`zlens eval --init` writes a starter), then retry.\n');
    return;
  }

  console.log('');
  for (const result of results) {
    const icon = result.passed ? '✓' : '✕';
    const route = `[${result.actualRoute}]`;
    console.log(`  ${icon} ${route} ${result.name}`);
    for (const failure of result.failures) {
      console.log(`      - ${failure}`);
    }
  }

  console.log('\n  Scores');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Cases passed:            ${scores.passed}/${scores.total}`);
  console.log(`  Answer rate:             ${formatRate(scores.answerRate)}`);
  console.log(`  Candidate recall:        ${formatRate(scores.executableCandidateRecall)}`);
  console.log(`  Route accuracy:          ${formatRate(scores.routeAccuracy)}`);
  console.log(`  Block-selection accuracy:${formatRate(scores.blockSelectionAccuracy).padStart(7)}`);
  console.log(`  Grain-match precision:   ${formatRate(scores.grainMatchPrecision)}`);
  console.log(`  Refusal precision:       ${formatRate(scores.refusalPrecision)}`);
  console.log(`  Refusal recall:          ${formatRate(scores.refusalRecall)}`);

  console.log('\n  Cascade distribution');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Certified:               ${formatCountAndShare(distributions.actualRoutes.certified, scores.total)}`);
  console.log(`  Generated:               ${formatCountAndShare(distributions.actualRoutes.generated, scores.total)}`);
  console.log(`  Missing context:         ${formatCountAndShare(distributions.actualRoutes.missing_context, scores.total)}`);
  console.log(`  Research:                ${formatCountAndShare(distributions.actualRoutes.research, scores.total)}`);

  const t = report.thresholds;
  if (t.minRouteAccuracy !== null || t.minRefusal !== null || t.minAnswerRate !== null || t.minCandidateRecall !== null) {
    console.log('\n  Thresholds');
    console.log('  ' + '-'.repeat(50));
    if (t.minCandidateRecall !== null) {
      console.log(`  --min-candidate-recall ${t.minCandidateRecall}  (candidate recall ${formatThresholdActual(scores.executableCandidateRecall)})`);
    }
    if (t.minRouteAccuracy !== null) {
      console.log(`  --min-route-accuracy ${t.minRouteAccuracy}  (route accuracy ${formatThresholdActual(scores.routeAccuracy)})`);
    }
    if (t.minRefusal !== null) {
      console.log(`  --min-refusal ${t.minRefusal}  (refusal recall ${formatThresholdActual(scores.refusalRecall)})`);
    }
    if (t.minAnswerRate !== null) {
      console.log(`  --min-answer-rate ${t.minAnswerRate}  (answer rate ${formatThresholdActual(scores.answerRate)})`);
    }
    console.log(`\n  ${report.ok ? '✓ PASS — thresholds met.' : '✕ FAIL — below configured thresholds.'}`);
  }
  console.log('');
}
