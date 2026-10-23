import { beforeAll, describe, expect, it } from 'vitest';
import { answerSourceOf, answerTrustBadge, answerTrustHeading } from './answer-trust';
import type * as UnifiedAgentRunPanelModule from './UnifiedAgentRunPanel';

let simpleRunTitle: typeof UnifiedAgentRunPanelModule.simpleRunTitle;
let trustExplainer: typeof UnifiedAgentRunPanelModule.trustExplainer;
let askArtifactMeta: typeof UnifiedAgentRunPanelModule.askArtifactMeta;

beforeAll(async () => {
  const panel = await import('./UnifiedAgentRunPanel');
  simpleRunTitle = panel.simpleRunTitle;
  trustExplainer = panel.trustExplainer;
  askArtifactMeta = panel.askArtifactMeta;
});

/** An answered run as the Ask pipeline host returns it (toExecutorResult). */
function answered(trustState: string, tier: string, title: string, route = 'generated_answer') {
  return {
    status: 'completed',
    route,
    trustState,
    artifacts: [{
      id: 'run:answer', kind: 'answer', title, trustState,
      payload: { route: { tier }, trustState, result: { columns: ['product_name'], rows: [{ product_name: 'vanilla ice' }], rowCount: 1 } },
    }],
  } as any;
}

describe('one trust decision for the heading, the badge, the note and the card', () => {
  // Launch blocker: "What is beverage revenue by product?" asked from the
  // Jaffle Growth Review App was served by the certified beverage block as
  // evidence. The run was governed, on the generated_answer route; the
  // heading said "AI-generated answer", the badge "AI-generated" and the note
  // "Built from semantic metrics", over a "Certified block answer" card.
  it('a certified block served as evidence is never headed or badged AI-generated', () => {
    const run = answered('governed', 'certified_block', 'Answer from a certified saved query, not certified for this question');
    expect(answerSourceOf(run)).toBe('block_as_evidence');
    expect(answerTrustHeading(run)).toBe(run.artifacts[0].title);
    expect(simpleRunTitle(run)).toBe(run.artifacts[0].title);
    expect(answerTrustBadge(run)).toBe('From Metrics');
    expect(trustExplainer(run)).toMatch(/certified saved query as published/);
    expect(askArtifactMeta(run.artifacts[0], run.artifacts[0].payload)).toContain('governed');
  });

  it('the same block with a reading that does not cover the question needs review, and still names the block', () => {
    const run = answered('review_required', 'certified_block', 'Answer to review, from a certified saved query');
    expect(answerTrustHeading(run)).toBe('Answer to review, from a certified saved query');
    expect(simpleRunTitle(run)).toBe(run.artifacts[0].title);
    expect(answerTrustBadge(run)).toBe('Needs review');
    expect(trustExplainer(run)).not.toMatch(/AI-generated/);
    expect(askArtifactMeta(run.artifacts[0], run.artifacts[0].payload)).toContain('certified saved query · needs review');
  });

  it('governed definitions downgraded for coverage are not AI-generated either', () => {
    const run = answered('review_required', 'semantic_metric', 'Answer to review, from governed definitions');
    expect(answerTrustHeading(run)).toBe(run.artifacts[0].title);
    expect(answerTrustBadge(run)).toBe('Needs review');
  });

  it('only SQL the AI wrote is headed and badged AI-generated', () => {
    const run = answered('review_required', 'generated_sql', 'AI-drafted answer');
    expect(answerTrustHeading(run)).toBe('AI-generated answer');
    expect(simpleRunTitle(run)).toBe('AI-generated answer');
    expect(answerTrustBadge(run)).toBe('AI-generated');
    expect(askArtifactMeta(run.artifacts[0], run.artifacts[0].payload)).toContain('AI-generated');
  });

  it('a certified answer and a semantic answer read the same everywhere', () => {
    const certified = answered('certified', 'certified_block', 'Certified answer', 'certified_answer');
    expect([answerTrustHeading(certified), simpleRunTitle(certified), answerTrustBadge(certified)]).toEqual(['Certified answer', 'Certified answer', 'Certified']);
    const semantic = answered('governed', 'semantic_metric', 'Semantic answer', 'semantic_answer');
    expect([answerTrustHeading(semantic), simpleRunTitle(semantic), answerTrustBadge(semantic)]).toEqual(['Answer from Metrics', 'Answer from Metrics', 'From Metrics']);
  });

  it('a run that names no source falls back to its route', () => {
    expect(answerSourceOf({ route: 'generated_answer', trustState: 'review_required', artifacts: [] } as any)).toBe('ai_sql');
    expect(answerTrustHeading({ route: 'generated_answer', trustState: 'review_required', artifacts: [] } as any)).toBe('AI-generated answer');
  });
});
