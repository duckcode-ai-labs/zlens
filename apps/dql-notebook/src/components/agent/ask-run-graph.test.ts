import { describe, expect, it } from 'vitest';
import { explainAskRun } from './ask-run-explanation';
import { DECISION_FLOW_MAX_NODES, decisionFlowGraph, layoutDecisionFlow, type DecisionFlow } from './ask-run-graph';

const receipt = (overrides: Record<string, unknown>) => ({ version: 1, candidates: [], refusals: [], story: [], tiers: [], dispatches: [], timings: {}, ...overrides });

const aiRun = receipt({
  intent: { kind: 'analytics', reading: 'Lost opportunities to Splunk.' },
  tiers: [{ round: 0, tier: 'certified', outcome: 'skipped' }, { round: 97, tier: 'exploratory', outcome: 'prepared' }],
  refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block' }],
  dispatches: [
    { purpose: 'intent:resolve', ms: 12_000, label: 'read' },
    { purpose: 'intent:draft', ms: 5_000, label: 'draft', outcome: 'sql', reply: 'SELECT 1' },
    { purpose: 'intent:draft', ms: 4_000, label: 'fix', outcome: 'sql', reply: 'SELECT 2' },
  ],
  checks: [
    { id: 'stated_values', label: 'Applies every value the question states', passed: false, message: 'misses Splunk', attempt: 1 },
    { id: 'stated_values', label: 'Applies every value the question states', passed: true, message: 'applies Splunk', attempt: 2 },
  ],
  executed: { tier: 'exploratory', rowCount: 3, ms: 90, proofs: [] },
});

const expectConnected = (flow: DecisionFlow) => {
  const ids = new Set(flow.nodes.map((node) => node.id));
  expect(ids.size).toBe(flow.nodes.length);
  for (const edge of flow.edges) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
  }
};

describe('the decision flow graph of an Ask run', () => {
  it('puts each AI call, tier, round of checks and the warehouse run in order, with a fix edge into the redraft', () => {
    const flow = decisionFlowGraph(explainAskRun({ receipt: aiRun, payload: {}, status: 'completed' })!);
    expect(flow.nodes.map((node) => [node.kind, node.title, node.outcome])).toEqual([
      ['call', 'Read the question', 'done'],
      ['tier', 'Certified saved queries', 'skipped'],
      ['call', 'Drafted SQL', 'done'],
      ['checks', 'Checks on draft 1', 'failed'],
      ['call', 'Fixed a failed check', 'done'],
      ['checks', 'Checks on draft 2', 'done'],
      ['warehouse', 'Ran on the warehouse', 'done'],
      ['end', 'Answer', 'done'],
    ]);
    expectConnected(flow);
    expect(flow.edges).toHaveLength(flow.nodes.length - 1);
    expect(flow.edges.find((edge) => edge.target.endsWith('call-2'))?.label).toBe('fix');
    expect(flow.edges.find((edge) => edge.source === 'tier-certified')?.label).toBe('not answered');
  });

  it('lays the flow out left to right with finite positions', () => {
    const flow = decisionFlowGraph(explainAskRun({ receipt: aiRun, payload: {}, status: 'completed' })!);
    const positions = layoutDecisionFlow(flow);
    const xs = flow.nodes.map((node) => positions.get(node.id)!.x);
    for (const value of [...xs, ...flow.nodes.map((node) => positions.get(node.id)!.y)]) expect(Number.isFinite(value)).toBe(true);
    for (let index = 1; index < xs.length; index += 1) expect(xs[index]!).toBeGreaterThan(xs[index - 1]!);
  });

  it('a declined draft is a refused node, and a reading that failed after its call keeps the failed step', () => {
    const declined = decisionFlowGraph(explainAskRun({
      receipt: receipt({ dispatches: [{ purpose: 'intent:resolve', ms: 1_000 }, { purpose: 'intent:draft', ms: 900, label: 'draft', outcome: 'declined' }], refusals: [{ tier: 'exploratory', code: 'exploration_declined', message: 'nothing records churn' }], tiers: [{ round: 97, tier: 'exploratory', outcome: 'refused' }] }),
      payload: { gap: { message: 'nothing records churn' } },
      status: 'blocked',
    })!);
    expect(declined.nodes.find((node) => node.title === 'Drafted SQL')?.outcome).toBe('refused');
    expect(declined.nodes.some((node) => node.id === 'ai-sql')).toBe(false);
    expect(declined.nodes.at(-1)).toMatchObject({ kind: 'end', subtitle: 'No answer' });

    const failedRead = decisionFlowGraph(explainAskRun({
      receipt: receipt({ dispatches: [{ purpose: 'intent:resolve', ms: 60_000 }], failure: { stage: 'resolve', message: 'the AI model took too long' } }),
      payload: { failedStage: 'resolve', executionError: 'timeout' },
      status: 'blocked',
    })!);
    expect(failedRead.nodes.map((node) => [node.id, node.outcome])).toContainEqual(['read', 'failed']);
    expectConnected(failedRead);
  });

  it('a very long run collapses repeated calls into one node that says how many', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ purpose: 'intent:draft', ms: 100, label: index === 0 ? 'draft' : 'redraft', outcome: 'sql' }));
    const flow = decisionFlowGraph(explainAskRun({ receipt: receipt({ dispatches: many, tiers: [{ round: 97, tier: 'exploratory', outcome: 'prepared' }], executed: { tier: 'exploratory', rowCount: 1, ms: 5, proofs: [] } }), payload: {}, status: 'completed' })!);
    expect(flow.nodes.length).toBeLessThanOrEqual(DECISION_FLOW_MAX_NODES);
    expect(flow.nodes.find((node) => node.title === 'Redrafted after a warehouse error')).toMatchObject({ count: 59, subtitle: '59 times' });
    expectConnected(flow);
  });
});
