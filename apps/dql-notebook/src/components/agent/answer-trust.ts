import type { AgentRun } from '../../api/client';

/**
 * ONE TRUST DECISION, ONE SET OF WORDS.
 *
 * An Ask answer shows its trust four times: the heading, the badge, the note
 * under them and the answer card. The server decides the trust once
 * (`trustState`) and says where the figures came from (the answer payload's
 * `route.tier`). Every label is read from those two here, so the heading can
 * never say "AI-generated answer" over a card that says it came from a
 * certified block, and a governed answer is never badged "AI-generated".
 *
 * The run's `route` is not a source: a certified block served as evidence and
 * an answer composed from declared relationships both resolve to the
 * `generated_answer` route without any SQL the AI wrote.
 */
export type AnswerSource = 'certified_block' | 'block_as_evidence' | 'governed_definitions' | 'ai_sql' | 'app_view';

type RunTrust = Pick<AgentRun, 'route' | 'trustState' | 'artifacts'>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The source the answer payload names, or undefined when it names none. */
export function answerSourceOfPayload(payload: Record<string, unknown>, trustState: string | undefined): AnswerSource | undefined {
  if (recordOf(payload.appView)) return 'app_view';
  const tier = recordOf(payload.route)?.tier;
  if (tier === 'app_view') return 'app_view';
  if (tier === 'certified_block') return trustState === 'certified' ? 'certified_block' : 'block_as_evidence';
  if (tier === 'semantic_metric') return 'governed_definitions';
  if (tier === 'generated_sql') return 'ai_sql';
  return undefined;
}

/** Where a run's answer came from: the answer payload first, the route only for runs that name no source. */
export function answerSourceOf(run: RunTrust): AnswerSource | undefined {
  for (const artifact of run.artifacts ?? []) {
    const payload = recordOf(artifact.payload);
    if (!payload) continue;
    const source = answerSourceOfPayload(payload, run.trustState);
    if (source) return source;
  }
  if (run.route === 'certified_answer') return 'certified_block';
  if (run.route === 'semantic_answer') return 'governed_definitions';
  if (run.route === 'generated_answer') return 'ai_sql';
  return undefined;
}

/** The heading of an answered run. */
export function answerTrustHeading(run: RunTrust): string {
  const source = answerSourceOf(run);
  if (run.trustState === 'certified') return 'Certified answer';
  if (source === 'app_view') return run.trustState === 'governed' ? 'Governed answer from this App' : 'Answer from this App · needs review';
  if (run.trustState === 'governed' || run.trustState === 'grounded') return 'Governed answer';
  if (source === 'block_as_evidence') return 'Answer to review, from a certified saved query';
  if (source === 'governed_definitions') return 'Answer to review, from governed definitions';
  return 'AI-generated answer';
}

/** The badge beside the heading: the same decision in one or two words. */
export function answerTrustBadge(run: RunTrust): string {
  if (run.trustState === 'certified') return 'Certified';
  if (run.trustState === 'governed' || run.trustState === 'grounded') return 'Governed';
  const source = answerSourceOf(run);
  if (source === 'app_view' || source === 'block_as_evidence' || source === 'governed_definitions') return 'Needs review';
  return 'AI-generated';
}
