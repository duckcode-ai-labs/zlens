import { deadlineScale } from './agent-run-engine.js';
import { hypothesesToSteps, planResearchHypotheses, type ResearchAssets } from './agentic/research-agent.js';
/**
 * Research loop (P4) — a grounded, ReAct-style planner for "research / follow-up"
 * questions, so the agent behaves like a real assistant: it DECIDES whether to
 * answer, to research across multiple steps, or to ask a smart follow-up — instead
 * of always generating one query.
 *
 * The "tools" the loop reasons over are DQL's own assets: governed metrics, certified
 * blocks, and their dimensions/lineage. Every step is bound to a REAL asset (no
 * hallucinated tool calls), and every follow-up offers concrete options drawn from
 * the catalog. The first decision reuses the P0 intent controller; this module turns
 * that decision into a grounded plan.
 */

import { decideAgentAction, type AgentAction } from './intent-controller.js';
import type { MetadataAgentIntent } from './metadata/catalog.js';
import { matchSemanticMetric } from './metadata/metric-match.js';
import type { KGNode } from './kg/types.js';
import { authorityIdentitiesForKGNode } from './semantic-identities.js';
import type { PlanBlock } from './app-planner.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { readEnv } from '@zlens/core';

/** One ReAct step: a thought, the asset-bound action, and what observing it tells us. */
export interface ResearchStep {
  thought: string;
  action: {
    kind: 'lookup_metric' | 'lookup_block' | 'breakdown' | 'compare_time' | 'check_lineage' | 'compose_app';
    /** The real asset the action touches (metric/block/dimension name). */
    target: string;
  };
  /** What a successful observation of this step should establish. */
  expectation: string;
}

/** A smart follow-up: the question plus concrete, catalog-grounded options. */
export interface ResearchFollowUp {
  question: string;
  options: string[];
}

export interface ResearchPlan {
  decision: AgentAction;
  confidence: number;
  rationale: string;
  /** The grounded ReAct trace (empty for a pure clarify turn). */
  steps: ResearchStep[];
  /** Present when the agent should ask before researching. */
  followUp?: ResearchFollowUp;
  /** Assets the plan cites (metric/block names). */
  sources: string[];
  /** True when the question is answerable directly (single step, no research needed). */
  done: boolean;
  /** Root analytical contract reused by every research branch. */
  rootPlanId?: string;
  budget: ResearchBudget;
}

export interface ResearchBudget {
  /**
   * Was the literal `1`, which made replanning unexpressible in the type system:
   * an investigation could never respond to what it observed, because it could
   * never call the planner again. Widened so a finding can redirect the run.
   * The wall clock and the run budget remain the real ceiling.
   */
  plannerCalls: number;
  sqlExecutions: 6;
  repairs: 1;
  narratorCalls: 1;
  /**
   * Scaled by `ZLENS_AGENT_DEADLINE_SCALE`, like every other agent deadline. Was
   * the literal `120_000`, which a local model exceeds during planning alone.
   */
  wallClockMs: number;
}

/**
 * The research wall clock, scaled.
 *
 * 120s assumes a hosted model. A local 27B needs ~2 minutes for the planning
 * call alone, so an unscaled budget is exceeded before the first branch runs —
 * the same reason `ZLENS_AGENT_DEADLINE_SCALE` exists for the Ask path. Scaling
 * here keeps ONE knob rather than adding a second authority.
 */
export function researchWallClockMs(): number {
  return Math.round(120_000 * deadlineScale());
}

export const RESEARCH_BUDGET: ResearchBudget = {
  plannerCalls: 2,
  sqlExecutions: 6,
  repairs: 1,
  narratorCalls: 1,
  get wallClockMs() { return researchWallClockMs(); },
};

const TIME_DIM_RE = /(_at$|_date$|_time$|_ts$|^date$|^month$|^week$|^day$|ordered_at|created)/i;

function humanize(name: string): string {
  return name.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function requestedDimensions(question: string): string[] {
  const dims: string[] = [];
  const re = /\bby\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(question.toLowerCase()))) {
    if (m[1] && m[1] !== 'the' && !dims.includes(m[1])) dims.push(m[1]);
  }
  return dims;
}

function blocksForMetric(blocks: PlanBlock[], metric: string | undefined): PlanBlock[] {
  if (!metric) return [];
  const leaf = metric.toLowerCase().split('.').pop();
  return blocks.filter((b) => {
    const ref = (b.metricRef ?? '').toLowerCase();
    return ref === metric.toLowerCase() || ref.split('.').pop() === leaf;
  });
}

function timeDimensionOf(blocks: PlanBlock[]): string | undefined {
  for (const b of blocks) {
    for (const f of [...(b.allowedFilters ?? []), ...(b.dimensions ?? [])]) {
      if (TIME_DIM_RE.test(f)) return f;
    }
  }
  return undefined;
}

function categoricalDimensionsOf(blocks: PlanBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    for (const f of b.allowedFilters ?? []) {
      if (!TIME_DIM_RE.test(f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

/**
 * Plan how to handle a research / follow-up question. Returns the decision plus a
 * grounded plan: a direct answer, a multi-step research trace, or a follow-up with
 * concrete options. Deterministic + offline; the metric match reuses the spec-17 matcher.
 */
export async function planResearch(input: {
  question: string;
  metrics: KGNode[];
  blocks: PlanBlock[];
  intent?: MetadataAgentIntent;
  isFollowUp?: boolean;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** The user explicitly asked to research/dig deeper — don't collapse to a single-step answer. */
  forceInvestigate?: boolean;
  /** Authoritative root plan. When present, research never re-matches meaning. */
  rootPlan?: ResolvedAnalyticalPlan;
  /** The assets the hypothesis planner may name; when absent they are derived from `metrics` and `blocks`. */
  assets?: ResearchAssets;
  /**
   * Optional. With one, the investigation is planned as competing hypotheses
   * about the question; without one, the deterministic template still runs, so
   * research never depends on a provider being reachable.
   */
  provider?: {
    generate(
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
      options?: Record<string, unknown>,
    ): Promise<string>;
  };
  signal?: AbortSignal;
}): Promise<ResearchPlan> {
  // Prefer a metric that already has certified blocks (so the research plan can use
  // its time/breakdown dimensions), falling back to the best overall match.
  const backedNames = new Set(
    input.blocks
      .map((b) => b.metricRef?.toLowerCase())
      .filter((ref): ref is string => Boolean(ref))
      .flatMap((ref) => [ref, ref.split('.').pop() ?? ref]),
  );
  const backedMetrics = input.metrics.filter(
    (m) => backedNames.has(m.name.toLowerCase()) || backedNames.has(m.name.toLowerCase().split('.').pop() ?? ''),
  );
  const rootMetric = input.rootPlan?.executionId
    ? input.metrics.find((metric) => authorityIdentitiesForKGNode(metric).includes(input.rootPlan!.executionId!))
    : undefined;
  const match = input.rootPlan
    ? null
    : (backedMetrics.length > 0 ? await matchSemanticMetric(input.question, backedMetrics).catch(() => null) : null) ??
      (await matchSemanticMetric(input.question, input.metrics).catch(() => null));
  const metricName = rootMetric?.name ?? match?.metric.name;
  const metricBlocks = blocksForMetric(input.blocks, metricName);

  const decision = input.rootPlan
    ? {
        action: input.rootPlan.capability === 'blocked'
          ? input.rootPlan.resolutionFailure?.outcome === 'clarify'
            ? 'clarify' as const
            : 'block' as const
          : (input.forceInvestigate || input.rootPlan.questionType === 'diagnosis' || input.rootPlan.questionType === 'research')
            ? 'investigate' as const
            : 'answer' as const,
        confidence: input.rootPlan.confidence === 'high' ? 0.9 : input.rootPlan.confidence === 'medium' ? 0.72 : 0.45,
        reason: `Research reuses resolved plan ${input.rootPlan.planId}.`,
        followsUp: Boolean(input.isFollowUp),
        ...(input.rootPlan.clarification ? { clarifyingQuestion: input.rootPlan.clarification } : {}),
      }
    : decideAgentAction({
    question: input.question,
    intent: input.intent ?? 'definition_lookup',
    signals: {
      metricScore: match?.score,
      // Derive from the actual match, not a flat 0.85 that asserts certainty just
      // because a block exists (that silently downgraded forced research to a single answer).
      certifiedScore: metricBlocks.length > 0 ? (match?.score ?? undefined) : undefined,
      hasRetrieval: input.metrics.length > 0 || input.blocks.length > 0,
    },
    isFollowUp: input.isFollowUp,
    history: input.history,
      });

  // When the user explicitly forced research, don't collapse to the single-step "answer"
  // path — investigate. A SOFT "nothing matched cleanly" clarify also becomes an
  // investigation here: the user deliberately asked to research, so we dig rather than
  // stop to ask. Only a genuinely-ambiguous HARD clarify (compose_app too) is honored,
  // since those are meaningfully different intents. (A hard clarify leaves
  // `clarifySoft` unset; the default "nothing governed matched" clarify sets it true.)
  const action: typeof decision.action =
    input.forceInvestigate
      && (decision.action === 'answer' || (decision.action === 'clarify' && decision.clarifySoft === true))
      ? 'investigate'
      : decision.action;

  const sources = new Set<string>();
  if (input.rootPlan) {
    for (const id of input.rootPlan.selectedConceptIds) sources.add(id);
    if (input.rootPlan.executionId) sources.add(input.rootPlan.executionId);
  } else if (metricName) sources.add(metricName);
  for (const b of metricBlocks) sources.add(b.name);

  if (action === 'block') {
    return {
      decision: 'block',
      confidence: decision.confidence,
      rationale: decision.reason,
      steps: [],
      sources: Array.from(sources),
      done: false,
      rootPlanId: input.rootPlan?.rootPlanId ?? input.rootPlan?.planId,
      budget: RESEARCH_BUDGET,
    };
  }

  // ── compose_app: hand off to the app planner (P1). ───────────────────────────
  if (action === 'compose_app') {
    return {
      decision: 'compose_app',
      confidence: decision.confidence,
      rationale: decision.reason,
      steps: [{
        thought: 'This asks to assemble a decision surface, not answer one question.',
        action: { kind: 'compose_app', target: metricName ?? humanize(input.question) },
        expectation: 'A planned app: KPI + trend + breakdowns over the certified saved queries.',
      }],
      sources: Array.from(sources),
      done: false,
      rootPlanId: input.rootPlan?.rootPlanId ?? input.rootPlan?.planId,
      budget: RESEARCH_BUDGET,
    };
  }

  // ── clarify: ask before researching, with concrete options. ──────────────────
  if (action === 'clarify') {
    const followUp = buildFollowUp(input, match, metricBlocks, decision.clarifyingQuestion);
    return {
      decision: 'clarify',
      confidence: decision.confidence,
      rationale: decision.reason,
      steps: [],
      followUp,
      sources: Array.from(sources),
      done: false,
      rootPlanId: input.rootPlan?.rootPlanId ?? input.rootPlan?.planId,
      budget: RESEARCH_BUDGET,
    };
  }

  // ── investigate: a grounded, multi-step ReAct research trace. ────────────────
  if (action === 'investigate') {
    const steps: ResearchStep[] = [];
    const label = metricName ? humanize(metricName) : humanize(input.question);
    const metricTarget = input.rootPlan?.executionId ?? metricName;
    if (metricName) {
      steps.push({
        thought: `Establish the baseline for ${label}.`,
        action: { kind: 'lookup_metric', target: metricTarget! },
        expectation: `The current ${label} value to reason from.`,
      });
    }
    const timeDim = input.rootPlan?.query.dimensions.find((binding) => /date|time|month|week|year/i.test(binding.requested))?.qualifiedId
      ?? (input.rootPlan?.query.timeGrain || input.rootPlan?.query.timeRange ? 'resolved-plan-time' : undefined)
      ?? timeDimensionOf(metricBlocks);
    if (timeDim) {
      steps.push({
        thought: `See how ${label} moved over time to locate the change.`,
        action: { kind: 'compare_time', target: timeDim },
        expectation: `When ${label} shifted, and by how much.`,
      });
    }
    const dims = input.rootPlan
      ? input.rootPlan.query.dimensions
          .filter((binding) => !TIME_DIM_RE.test(binding.requested))
          .map((binding) => binding.qualifiedId ?? binding.requested)
      : requestedDimensions(input.question).filter((d) => !TIME_DIM_RE.test(d))
          .filter((d) => categoricalDimensionsOf(metricBlocks).includes(d));
    const breakdownDim = dims[0] ?? categoricalDimensionsOf(metricBlocks)[0];
    if (breakdownDim) {
      steps.push({
        thought: `Attribute the change — break ${label} down by ${humanize(breakdownDim)}.`,
        action: { kind: 'breakdown', target: breakdownDim },
        expectation: `Which ${humanize(breakdownDim)} segments drove the move.`,
      });
    } else if (metricName) {
      steps.push({
        thought: `No breakdown dimension is certified yet — check lineage for drivers.`,
        action: { kind: 'check_lineage', target: metricTarget! },
        expectation: `Upstream models/metrics that feed ${label}.`,
      });
    }
    // A multifaceted investigation needs at least three independently useful
    // observations when the catalog exposes them. Fill only with a real
    // certified block/lineage asset; never pad the plan with a guessed join or
    // fabricated business explanation. If those assets do not exist the V2
    // ledger declares limited scope instead.
    if (steps.length < 3 && metricBlocks[0]) {
      steps.push({
        thought: `Check the certified definition and limitations for ${label}.`,
        action: { kind: 'lookup_block', target: metricBlocks[0].name },
        expectation: `Whether the certified saved query's scope, filters, and grain qualify the observation.`,
      });
    }
    if (steps.length < 3 && metricName && !steps.some((step) => step.action.kind === 'check_lineage')) {
      steps.push({
        thought: `Inspect lineage evidence for limits around ${label}.`,
        action: { kind: 'check_lineage', target: metricTarget! },
        expectation: `Which modeled inputs can support or limit the requested comparison.`,
      });
    }
    // Hypotheses when a provider can produce them, the template otherwise.
    // The template's steps are always a correct INVESTIGATION — baseline, trend,
    // breakdown — but they are the same three regardless of what was asked, so
    // the dossier reads as a report about a metric rather than an answer to a
    // question. Hypotheses replace the steps only; grounding, budget, and the
    // frozen root plan are unchanged, and an empty result keeps the template.
    const hypothesisSteps = input.provider
      ? hypothesesToSteps(await planResearchHypotheses(
        input.provider,
        input.question,
        input.assets ?? {
          metrics: input.metrics.map((metric) => metric.name),
          blocks: input.blocks.map((block) => block.name),
          dimensions: Array.from(new Set(input.blocks.flatMap((block) =>
            [...(block.dimensions ?? []), ...(block.allowedFilters ?? [])]))),
        },
        {
          ...(input.signal ? { signal: input.signal } : {}),
          // Rides the same multiplier as every other agent deadline. Measured
          // on a local 27B model: a four-hypothesis plan takes 122-149s WARM,
          // so the 20s default guarantees a fallback to the template and the
          // feature never runs at all on local hardware.
          timeoutMs: Math.round(20_000 * deadlineScale()),
        },
      ))
      : [];
    if (readEnv('ZLENS_ORCHESTRATOR_TRACE')) {
      console.warn(hypothesisSteps.length > 0
        ? `[zlens] research plan: ${hypothesisSteps.length} hypotheses — ${hypothesisSteps.map((step) => step.thought).join(' | ').slice(0, 220)}`
        : `[zlens] research plan: deterministic template (${steps.length} steps) — provider=${Boolean(input.provider)} metrics=${input.metrics.length} blocks=${input.blocks.length}`);
    }
    return {
      decision: 'investigate',
      confidence: decision.confidence,
      rationale: hypothesisSteps.length > 0
        ? `${decision.reason} Investigating ${hypothesisSteps.length} competing explanations.`
        : decision.reason,
      // A two-item model response does not meet the multi-branch research
      // contract when the deterministic catalog plan can ground more. Keep it
      // as limited scope only if the catalog itself cannot supply three paths.
      steps: hypothesisSteps.length >= 3 ? hypothesisSteps : steps,
      sources: Array.from(sources),
      done: false,
      rootPlanId: input.rootPlan?.rootPlanId ?? input.rootPlan?.planId,
      budget: RESEARCH_BUDGET,
    };
  }

  // ── answer: a single grounded step. ──────────────────────────────────────────
  const answerStep: ResearchStep = metricBlocks.length > 0
    ? {
        thought: `A certified saved query answers this directly.`,
        action: { kind: 'lookup_block', target: metricBlocks[0].name },
        expectation: `The certified ${humanize(metricBlocks[0].name)} result.`,
      }
    : {
        thought: metricName ? `The governed metric answers this directly.` : `Answer from the catalog.`,
        action: { kind: 'lookup_metric', target: input.rootPlan?.executionId ?? metricName ?? humanize(input.question) },
        expectation: metricName ? `The governed ${humanize(metricName)} value.` : `A grounded answer.`,
      };
  return {
    decision: 'answer',
    confidence: decision.confidence,
    rationale: decision.reason,
    steps: [answerStep],
    sources: Array.from(sources),
    done: true,
    rootPlanId: input.rootPlan?.rootPlanId ?? input.rootPlan?.planId,
    budget: RESEARCH_BUDGET,
  };
}

/**
 * Build a follow-up that offers REAL options: nearby metrics to disambiguate, or the
 * certified breakdown dimensions to pick from — never an open-ended "tell me more".
 */
function buildFollowUp(
  input: { question: string; metrics: KGNode[]; blocks: PlanBlock[] },
  match: { metric: KGNode; score: number } | null,
  metricBlocks: PlanBlock[],
  controllerQuestion: string | undefined,
): ResearchFollowUp {
  // No confident metric → ask which subject, offering the closest catalog metrics.
  if (!match) {
    const options = input.metrics.slice(0, 4).map((m) => humanize(m.name));
    return {
      question: controllerQuestion ?? 'Which metric did you mean?',
      options,
    };
  }
  // A metric matched but the breakdown is ambiguous → offer the certified dimensions.
  const dims = categoricalDimensionsOf(metricBlocks);
  if (dims.length > 0 && requestedDimensions(input.question).length === 0) {
    return {
      question: `How should I break ${humanize(match.metric.name)} down?`,
      options: dims.map(humanize).concat('overall (no breakdown)'),
    };
  }
  return {
    question: controllerQuestion ?? `Do you want ${humanize(match.metric.name)} overall, or filtered to a period?`,
    options: ['overall', 'this year', 'a custom period'],
  };
}
