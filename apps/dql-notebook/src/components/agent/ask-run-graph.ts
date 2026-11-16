/**
 * THE DECISION FLOW OF ONE ASK RUN, as a left-to-right graph: every AI call,
 * tier, round of checks and warehouse run in the order it happened, ending in
 * how the turn ended. Pure; the trace page draws it with ReactFlow.
 */
import Dagre from '@dagrejs/dagre';
import { OUTCOME_WORDS, formatRunMs, type RunAiCall, type RunCheck, type RunExplanation, type RunStep, type RunStepOutcome } from './ask-run-explanation';

export type DecisionNodeKind = 'call' | 'tier' | 'checks' | 'warehouse' | 'end' | 'step';

export interface DecisionNode {
  id: string;
  kind: DecisionNodeKind;
  /** The explanation step this node belongs to. */
  stepId: string;
  title: string;
  subtitle?: string;
  outcome: RunStepOutcome;
  ms?: number;
  /** How many same-kind nodes this one stands for when a long run is collapsed. */
  count?: number;
  calls?: RunAiCall[];
  checks?: RunCheck[];
}

export interface DecisionEdge { id: string; source: string; target: string; label?: string }
export interface DecisionFlow { nodes: DecisionNode[]; edges: DecisionEdge[] }

export const DECISION_FLOW_MAX_NODES = 40;
export const DECISION_NODE_WIDTH = 188;
export const DECISION_NODE_HEIGHT = 62;

const END_KINDS = new Set(['answer', 'gap', 'clarify', 'failed', 'conversation']);
const TIER_KINDS = new Set(['certified', 'semantic', 'relational']);
const END_WORDS: Record<string, string> = { answer: 'Answered', gap: 'No answer', clarify: 'Asked which you meant', failed: 'Stopped', conversation: 'Replied' };
const SEVERITY: Record<RunStepOutcome, number> = { done: 0, skipped: 1, not_reached: 1, not_found: 2, refused: 2, failed: 3 };

// A drafting call that wrote no SQL found nothing in the data that answers the question.
const callOutcome = (call: RunAiCall): RunStepOutcome => (call.outcome === 'declined' ? 'not_found' : call.outcome === 'error' || call.outcome === 'rejected' ? 'failed' : 'done');

function stepNode(step: RunStep): DecisionNode {
  const kind: DecisionNodeKind = END_KINDS.has(step.kind) ? 'end' : TIER_KINDS.has(step.kind) ? 'tier' : step.kind === 'warehouse' ? 'warehouse' : 'step';
  const subtitle = kind === 'end' ? (step.outcome === 'not_found' ? OUTCOME_WORDS.not_found : END_WORDS[step.kind])
    : step.kind === 'warehouse' && step.rows !== undefined ? `${step.rows} row${step.rows === 1 ? '' : 's'}`
    : OUTCOME_WORDS[step.outcome];
  return { id: step.id, kind, stepId: step.id, title: step.title, subtitle, outcome: step.outcome, ...(step.ms !== undefined ? { ms: step.ms } : {}) };
}

function checksNode(stepId: string, checks: RunCheck[], attempt: number | undefined, index: number): DecisionNode {
  const passed = checks.filter((check) => check.passed).length;
  return {
    id: `checks-${attempt ?? 'all'}-${index}`,
    kind: 'checks',
    stepId,
    title: attempt ? `Checks on draft ${attempt}` : 'Checks',
    subtitle: `${passed} of ${checks.length} passed`,
    outcome: passed === checks.length ? 'done' : 'failed',
    checks,
  };
}

/** Consecutive nodes of the same kind and title become one node that says how many it stands for. */
function collapseRuns(nodes: DecisionNode[]): DecisionNode[] {
  const out: DecisionNode[] = [];
  const shape = (node: DecisionNode) => `${node.kind}:${node.title.replace(/\d+/g, '#')}`;
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last && last.kind !== 'end' && shape(last) === shape(node)) {
      const count = (last.count ?? 1) + 1;
      const ms = (last.ms ?? 0) + (node.ms ?? 0);
      const calls = [...(last.calls ?? []), ...(node.calls ?? [])];
      const checks = [...(last.checks ?? []), ...(node.checks ?? [])];
      out[out.length - 1] = {
        ...last,
        count,
        subtitle: `${count} times`,
        outcome: SEVERITY[node.outcome] > SEVERITY[last.outcome] ? node.outcome : last.outcome,
        ...(ms ? { ms } : {}),
        ...(calls.length ? { calls } : {}),
        ...(checks.length ? { checks } : {}),
      };
      continue;
    }
    out.push(node);
  }
  return out;
}

export function decisionFlowGraph(explanation: RunExplanation): DecisionFlow {
  const checkStep = explanation.steps.find((step) => step.kind === 'checks');
  const aiStep = explanation.steps.find((step) => step.kind === 'ai_sql');
  const byAttempt = new Map<number, RunCheck[]>();
  for (const check of checkStep?.checks ?? []) {
    if (check.attempt !== undefined) byAttempt.set(check.attempt, [...(byAttempt.get(check.attempt) ?? []), check]);
  }
  // Checks sit after the draft they judged, so a failed check and its fix read in order.
  const checksInline = Boolean(checkStep && aiStep && aiStep.aiCalls.length > 0 && byAttempt.size > 0);

  let nodes: DecisionNode[] = [];
  for (const step of explanation.steps) {
    if (step.kind === 'checks') {
      const loose = checksInline ? step.checks.filter((check) => check.attempt === undefined) : step.checks;
      if (loose.length) nodes.push(checksNode(step.id, loose, undefined, nodes.length));
      continue;
    }
    if (step.aiCalls.length === 0) {
      nodes.push(stepNode(step));
      continue;
    }
    step.aiCalls.forEach((call, index) => {
      const subtitle = [formatRunMs(call.ms), call.outcome === 'declined' ? 'found nothing' : call.outcome === 'error' ? 'error' : ''].filter(Boolean).join(' · ');
      nodes.push({
        id: `${step.id}-call-${index + 1}`,
        kind: 'call',
        stepId: step.id,
        title: call.label,
        ...(subtitle ? { subtitle } : {}),
        outcome: callOutcome(call),
        ...(call.ms !== undefined ? { ms: call.ms } : {}),
        calls: [call],
      });
      const group = step.kind === 'ai_sql' && checksInline ? byAttempt.get(index + 1) : undefined;
      if (group) nodes.push(checksNode(checkStep!.id, group, index + 1, nodes.length));
    });
    if (step.kind === 'ai_sql' && checksInline) {
      for (const [attempt, group] of byAttempt) if (attempt > step.aiCalls.length) nodes.push(checksNode(checkStep!.id, group, attempt, nodes.length));
    }
    // A step that did not succeed keeps its own node when no call already shows why.
    if (step.outcome !== 'done' && !step.aiCalls.some((call) => callOutcome(call) === step.outcome)) nodes.push(stepNode(step));
  }

  if (nodes.length > DECISION_FLOW_MAX_NODES) nodes = collapseRuns(nodes);
  const edges = nodes.slice(1).map((node, index): DecisionEdge => {
    const source = nodes[index]!;
    const label = /^Fixed/.test(node.title) ? 'fix'
      : /^Redrafted/.test(node.title) ? 'retry'
      : /^Looked again/.test(node.title) ? 'more tables'
      : source.kind === 'tier' && source.outcome !== 'done' ? 'not answered'
      : undefined;
    return { id: `edge-${source.id}-${node.id}`, source: source.id, target: node.id, ...(label ? { label } : {}) };
  });
  return { nodes, edges };
}

/** Top-left positions for each node, laid out left to right. */
export function layoutDecisionFlow(flow: DecisionFlow): Map<string, { x: number; y: number }> {
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 46, nodesep: 24, marginx: 16, marginy: 16 });
  for (const node of flow.nodes) graph.setNode(node.id, { width: DECISION_NODE_WIDTH, height: DECISION_NODE_HEIGHT });
  for (const edge of flow.edges) graph.setEdge(edge.source, edge.target);
  Dagre.layout(graph);
  return new Map(flow.nodes.map((node) => {
    const position = graph.node(node.id);
    return [node.id, { x: position.x - DECISION_NODE_WIDTH / 2, y: position.y - DECISION_NODE_HEIGHT / 2 }];
  }));
}
