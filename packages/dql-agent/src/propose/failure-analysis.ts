/**
 * Auto-drafted improvement proposals from failures (W4.2).
 *
 * The learning flywheel closes only when repeated failures turn into concrete,
 * reviewable improvements — the way Snowflake's agentic semantic-model improvement
 * and Anthropic's correction-harvesting loops work. This clusters failure signals
 * (downvotes, corrections, refusals) by scope and drafts a structured improvement
 * proposal per cluster (review a shaky block, consolidate repeated corrections,
 * investigate a recurring refusal). Deterministic and reviewable — every proposal
 * lands as a DRAFT for a human to approve, never an automatic mutation. An LLM can
 * later enrich each draft's prose; the clustering + proposal structure do not need one.
 */
import type { KGStore } from '../kg/sqlite-fts.js';

export type FailureSignalKind = 'downvote' | 'correction' | 'refusal';

export interface FailureSignal {
  kind: FailureSignalKind;
  question: string;
  blockId?: string;
  scope?: { metric?: string; domain?: string; dbtModel?: string };
  count?: number;
}

export type ImprovementProposalKind = 'review_block' | 'consolidate_corrections' | 'investigate_refusals';

export interface ImprovementProposal {
  kind: ImprovementProposalKind;
  scopeKey: string;
  summary: string;
  signalCount: number;
  evidence: string[];
}

function scopeKeyForSignal(signal: FailureSignal): string {
  if (signal.blockId) return `block:${signal.blockId}`;
  const scope = signal.scope ?? {};
  return scope.metric ? `metric:${scope.metric}`
    : scope.dbtModel ? `dbtModel:${scope.dbtModel}`
    : scope.domain ? `domain:${scope.domain}`
    : 'unscoped';
}

const KIND_TO_PROPOSAL: Record<FailureSignalKind, ImprovementProposalKind> = {
  downvote: 'review_block',
  correction: 'consolidate_corrections',
  refusal: 'investigate_refusals',
};

function summarize(kind: ImprovementProposalKind, scopeKey: string, count: number): string {
  switch (kind) {
    case 'review_block':
      return `${count} downvotes concentrated on ${scopeKey} — review this saved query's SQL/grain or recertify.`;
    case 'consolidate_corrections':
      return `${count} corrections share ${scopeKey} — consolidate into a governed hint or metric definition.`;
    case 'investigate_refusals':
      return `${count} refusals share ${scopeKey} — the catalog likely lacks coverage; add a metric, saved query, or synonym.`;
  }
}

/**
 * Cluster failure signals by (kind, scope) and emit one improvement proposal per
 * cluster reaching `minCluster` signals, most-frequent first.
 */
export function analyzeFailureClusters(signals: FailureSignal[], minCluster = 2): ImprovementProposal[] {
  const clusters = new Map<string, { kind: FailureSignalKind; scopeKey: string; count: number; evidence: Set<string> }>();
  for (const signal of signals) {
    const scopeKey = scopeKeyForSignal(signal);
    if (scopeKey === 'unscoped' && !signal.question.trim()) continue;
    const key = `${signal.kind}\0${scopeKey}`;
    const cluster = clusters.get(key) ?? { kind: signal.kind, scopeKey, count: 0, evidence: new Set<string>() };
    cluster.count += signal.count ?? 1;
    if (signal.question.trim()) cluster.evidence.add(signal.question.trim());
    clusters.set(key, cluster);
  }
  return [...clusters.values()]
    .filter((cluster) => cluster.count >= minCluster)
    .map((cluster) => {
      const proposalKind = KIND_TO_PROPOSAL[cluster.kind];
      return {
        kind: proposalKind,
        scopeKey: cluster.scopeKey,
        summary: summarize(proposalKind, cluster.scopeKey, cluster.count),
        signalCount: cluster.count,
        evidence: [...cluster.evidence].slice(0, 5),
      };
    })
    .sort((a, b) => b.signalCount - a.signalCount || a.scopeKey.localeCompare(b.scopeKey));
}

/**
 * KG-backed convenience: gather downvote clusters from feedback and any extra
 * signals (corrections/refusals the caller collected from git traces / answer
 * evidence) and return reviewable improvement proposals. Off-answer-path.
 */
export function improvementProposalsFromKg(
  kg: KGStore,
  options: { minCluster?: number; extraSignals?: FailureSignal[] } = {},
): ImprovementProposal[] {
  const minCluster = options.minCluster ?? 2;
  const downvoteSignals: FailureSignal[] = kg.downvotedBlocks(minCluster).map((row) => ({
    kind: 'downvote',
    question: row.question ?? '',
    blockId: row.blockId,
    count: row.downs,
  }));
  return analyzeFailureClusters([...downvoteSignals, ...(options.extraSignals ?? [])], minCluster);
}
