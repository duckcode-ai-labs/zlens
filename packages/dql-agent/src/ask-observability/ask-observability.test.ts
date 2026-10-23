import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ASK_TRACE_OBSERVER_V1, attachAskTraceObserverV1, createAskTraceObserverV1, isAskTraceIssueSpanV1 } from './observer.js';
import { finalizeAgentRunTraceV1, recordAuthoritativePlanFreezeV1, recordAuthoritativeRouterDecisionV1, recordEngineTraceEventV1 } from './instrumentation.js';
import { createAskTracePortableBundleV1, exportAskTraceBundleV1, replayAskTraceReceiptV1, validateAskTraceBundleV1 } from './portable.js';
import { AskTraceSqliteStoreV1 } from './store.js';
import { assertSafeTraceValue, canonicalJson, fingerprint, sha256 } from './utils.js';
import type { AskTraceDataV1, AskTraceEnvelopeV1, AskTraceLinkV1, AskTraceSpanV1, CandidateDecisionV1 } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureStore(): { directory: string; store: AskTraceSqliteStoreV1 } {
  const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-'));
  dirs.push(directory);
  return { directory, store: new AskTraceSqliteStoreV1({ path: join(directory, 'ask-observability.sqlite') }) };
}

/**
 * The observer is deliberately constrained to this tiny store surface. Keeping
 * its normal-path tests in memory makes the redaction/ID/fail-open contract
 * deterministic even when a developer's Node ABI cannot load better-sqlite3.
 */
class MemoryTraceStore {
  private readonly traces = new Map<string, AskTraceDataV1>();
  status() { return { available: true, schemaVersion: 1, recordingEnabled: true } as const; }
  begin(envelope: AskTraceEnvelopeV1) { this.traces.set(envelope.traceId, { envelope, spans: [], candidateDecisions: [], links: [] }); return { accepted: true } as const; }
  appendSpan(span: AskTraceSpanV1) { const trace = this.traces.get(span.traceId); if (trace) trace.spans = [...trace.spans.filter((item) => item.spanId !== span.spanId), span]; return { accepted: Boolean(trace) } as const; }
  appendCandidate(candidate: CandidateDecisionV1) { const trace = this.traces.get(candidate.traceId); if (trace) trace.candidateDecisions = [...trace.candidateDecisions, candidate]; return { accepted: Boolean(trace) } as const; }
  appendLink(link: AskTraceLinkV1) { const trace = this.traces.get(link.sourceTraceId); if (trace) trace.links = [...trace.links, link]; return { accepted: Boolean(trace) } as const; }
  finalize(envelope: AskTraceEnvelopeV1) { const trace = this.traces.get(envelope.traceId); if (trace) trace.envelope = envelope; return { accepted: Boolean(trace) } as const; }
  markPartial() {}
  getByRun(runId: string) { return [...this.traces.values()].find((trace) => trace.envelope.runId === runId); }
}

function memoryObserver(input: { runId: string; mode?: 'ask' | 'research' } = { runId: 'run-memory' }) {
  const store = new MemoryTraceStore();
  const observer = createAskTraceObserverV1({
    store: store as unknown as AskTraceSqliteStoreV1,
    runId: input.runId,
    surface: 'cli',
    mode: input.mode ?? 'ask',
    questionFingerprint: 'sha256:question-fixture',
  });
  return { store, observer };
}


const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const NO_AGE_LIMIT = { detailMaxAgeMs: TEN_YEARS_MS, summaryMaxAgeMs: TEN_YEARS_MS };

describe('AskTraceSqliteStoreV1 and observer', () => {
  it('records W3C-shaped IDs, pre-pruning lifecycle evidence, and a compact run reference', () => {
    const { store, observer } = memoryObserver({ runId: 'run-office-fixture' });
    const retrieval = observer.startSpan({
      name: 'retrieval.vector', stage: 'retrieval',
      payload: { kind: 'retrieval', source: 'vector', lane: 'vector', candidateCount: 3, coverage: 'available' },
    });
    observer.recordCandidateDecision({
      candidateId: 'semantic:metric:revenue', role: 'metric', source: 'semantic', lane: 'vector', laneRank: 1,
      decision: 'retrieved', reasonCode: 'exact_name_match', compatibilityCode: 'compatible',
    });
    observer.recordCandidateDecision({
      candidateId: 'dbt:column:analytics.accounts.owner_email', role: 'entity_label', source: 'dbt_manifest', lane: 'lexical', laneRank: 4,
      decision: 'excluded', reasonCode: 'entity_label_mismatch', compatibilityCode: 'missing_dimension',
    });
    observer.finishSpan(retrieval, { outcome: 'ok', reasonCode: 'completed' });
    const reference = observer.finalize({ status: 'completed', trustState: 'review_required', selectedTier: 'exploratory_sql' });
    const trace = store.getByRun('run-office-fixture');

    expect(reference).toMatchObject({ version: 1, recordingStatus: 'complete', storeSchemaVersion: 1 });
    expect(reference?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace?.envelope.rootSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace?.candidateDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'retrieved', candidateId: 'semantic:metric:revenue' }),
      expect.objectContaining({ decision: 'excluded', reasonCode: 'entity_label_mismatch' }),
    ]));
    expect(JSON.stringify(trace)).not.toContain('Lost opportunities count');
  });

  it('rejects raw SQL at the persistence boundary before a store can write it', () => {
    expect(() => assertSafeTraceValue({ kind: 'stage', sql: 'SELECT customer_email FROM customers' })).toThrow('ASK_TRACE_UNSAFE_PAYLOAD');
  });

  it('accepts a content-safe lineage Research payload without graph paths or target text', () => {
    expect(() => assertSafeTraceValue({
      kind: 'research',
      branchId: 'h1',
      hypothesisFingerprint: 'sha256:lineage-hypothesis',
      evidenceKind: 'lineage_graph',
      verdict: 'inconclusive',
      lineageStatus: 'completed',
      lineageResolution: 'exact_name',
      upstreamNodeCount: 2,
      downstreamNodeCount: 1,
      upstreamRouteCount: 1,
      downstreamRouteCount: 1,
      lineageMaxDepth: 6,
      lineageMaxRoutes: 12,
      lineageMaxNodes: 96,
      lineageMaxEdges: 160,
      lineageTruncated: false,
    })).not.toThrow();
  });

  it('returns an explicit no-op observer when local storage cannot initialize', () => {
    const { store } = fixtureStore();
    const observer = createAskTraceObserverV1({ store, runId: 'run-unavailable', surface: 'cli', mode: 'ask', questionFingerprint: 'sha256:unavailable' });
    if (!store.status().available) expect(observer).toMatchObject({ enabled: false, recordingStatus: 'unavailable' });
    store.close();
  });

  it('fails open without changing an Ask-owned object when trace begin is rejected', () => {
    const rejecting = {
      status: () => ({ available: true, schemaVersion: 1, recordingEnabled: true } as const),
      begin: () => ({ accepted: false, dropped: 'store_cap' } as const),
    };
    const observer = createAskTraceObserverV1({
      store: rejecting as unknown as AskTraceSqliteStoreV1,
      runId: 'run-rejected-store', surface: 'cli', mode: 'ask', questionFingerprint: 'sha256:rejected',
    });
    const askOwned = { route: 'generated', trustState: 'review_required' };
    attachAskTraceObserverV1(askOwned, observer);

    expect(observer).toMatchObject({ enabled: false, recordingStatus: 'unavailable' });
    expect(observer.finalize({ status: 'completed' })).toBeUndefined();
    expect(askOwned).toEqual({ route: 'generated', trustState: 'review_required' });
    expect(Object.keys(askOwned)).not.toContain(String(ASK_TRACE_OBSERVER_V1));
    expect(Object.getOwnPropertyDescriptor(askOwned, ASK_TRACE_OBSERVER_V1)?.enumerable).toBe(false);
  });

  it('projects an accepted result checksum into the trace without retaining result rows', () => {
    const { store, observer } = memoryObserver({ runId: 'run-result-fingerprint' });
    recordEngineTraceEventV1(observer, {
      id: 'run-result-fingerprint:event:1',
      runId: 'run-result-fingerprint',
      type: 'artifact.created',
      at: '2026-08-22T00:00:00.000Z',
      message: 'Created answer artifact.',
      route: 'semantic_answer',
      trustState: 'governed',
      payload: {
        id: 'answer:result-fingerprint',
        kind: 'answer',
        title: 'Answer from Metrics',
        trustState: 'governed',
        payload: {
          result: {
            resultFingerprint: 'a'.repeat(64),
            rowCount: 2,
            // The producer receives this opaque raw result, but the trace
            // projection must never persist it.
            rows: [['Synthetic Customer', 100]],
          },
        },
      },
    });
    const trace = store.getByRun('run-result-fingerprint');
    const resultSpan = trace?.spans.find((span) => span.name === 'result.normalize');

    expect(resultSpan?.payload).toMatchObject({
      kind: 'result',
      resultFingerprint: 'a'.repeat(64),
      rowCount: 2,
      trustState: 'governed',
    });
    expect(JSON.stringify(resultSpan)).not.toContain('Synthetic Customer');
  });

  it('projects authoritative model selection with the retrieved role instead of a generic context role', () => {
    const { store, observer } = memoryObserver({ runId: 'run-model-role' });
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'answer',
      source: 'llm',
      retrievalEvidence: {
        candidateCount: 2,
        candidateIds: ['semantic:metric:revenue', 'semantic:dimension:customer.name'],
        candidateTraceMetadata: [
          { candidateId: 'semantic:metric:revenue', role: 'metric', source: 'semantic' },
          { candidateId: 'semantic:dimension:customer.name', role: 'entity_label', source: 'semantic' },
        ],
      },
      meaningResolution: {
        selectedConceptIds: ['semantic:metric:revenue'],
        rejectedCandidates: [{ id: 'semantic:dimension:customer.name' }],
      },
    } as never);
    observer.finalize({ status: 'completed' });
    const decisions = store.getByRun('run-model-role')!.candidateDecisions;

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'semantic:metric:revenue', role: 'metric', source: 'semantic', decision: 'model_selected', reasonCode: 'model_selected' }),
      expect.objectContaining({ candidateId: 'semantic:dimension:customer.name', role: 'entity_label', source: 'semantic', decision: 'model_rejected', reasonCode: 'model_rejected' }),
    ]));
    expect(decisions.some((decision) => decision.decision === 'model_selected' && decision.role === 'context')).toBe(false);
  });

  it('does not promote expected skipped stages, but retains terminal skipped gaps and post-freeze failures', () => {
    const { store, observer } = memoryObserver({ runId: 'run-issue-eligibility' });
    const meaning = observer.startSpan({
      name: 'meaning.resolve',
      stage: 'meaning',
      payload: { kind: 'meaning', selectedCandidateIds: [], rejectedCandidateIds: [], source: 'heuristic' },
    });
    observer.finishSpan(meaning, { outcome: 'skipped', reasonCode: 'unknown' });
    const terminalGap = observer.startSpan({
      name: 'cascade.clarify_or_gap',
      stage: 'cascade',
      payload: { kind: 'cascade', decision: { planFrozen: false, stopReason: 'coverage_gap', sourceCoverage: [], attempts: [] } },
    });
    observer.finishSpan(terminalGap, { outcome: 'skipped', reasonCode: 'cascade_unavailable' });
    observer.finalize({ status: 'completed' });

    const trace = store.getByRun('run-issue-eligibility');
    expect(trace?.envelope.firstIssueSpanId).toBe(terminalGap);
    expect(isAskTraceIssueSpanV1({ outcome: 'skipped', reasonCode: 'unknown' })).toBe(false);
    expect(isAskTraceIssueSpanV1({ outcome: 'skipped', reasonCode: 'cascade_ineligible' })).toBe(false);
    expect(isAskTraceIssueSpanV1({ outcome: 'skipped', reasonCode: 'cascade_unavailable' })).toBe(true);
    expect(isAskTraceIssueSpanV1({ outcome: 'error', reasonCode: 'post_freeze_failure' })).toBe(true);
  });

  it('keeps fiscal clarification anchored on the authoritative cascade rather than skipped meaning resolution', () => {
    const { store, observer } = memoryObserver({ runId: 'run-fiscal-clarification' });
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'clarify',
      source: 'heuristic',
      requiresClarification: true,
      retrievalEvidence: { candidateCount: 0, candidateIds: [] },
      analyticalCascadeDecision: {
        version: 1,
        requirements: {
          version: 1,
          measures: ['lost_opportunity_count', 'lost_amount'],
          dimensions: ['month'],
          entityTerms: [],
          entityDisplayTerms: [],
          memberTerms: ['competitor:datadog'],
          time: { role: 'time_axis', grain: 'month', fiscalPeriod: 'FY26', requiresDeclaredFiscalCalendar: true },
        },
        sourceCoverage: [],
        attempts: [{
          version: 1,
          tier: 'clarify_or_gap',
          outcome: 'ambiguous',
          candidateIds: [],
          reason: 'declared fiscal calendar and date role are required',
          planFrozen: false,
        }],
        planFrozen: false,
        stopReason: 'ambiguous',
      },
    } as never);
    finalizeAgentRunTraceV1(observer, {
      status: 'needs_clarification',
      trustState: 'blocked',
      completedAt: '2026-08-22T12:00:01.000Z',
    } as never);

    const trace = store.getByRun('run-fiscal-clarification')!;
    const meaning = trace.spans.find((span) => span.name === 'meaning.resolve');
    const cascade = trace.spans.find((span) => span.name === 'cascade.evaluate');
    const clarification = trace.spans.find((span) => span.name === 'cascade.clarify_or_gap');
    expect(meaning).toMatchObject({ outcome: 'skipped', reasonCode: 'unknown' });
    expect(isAskTraceIssueSpanV1(meaning!)).toBe(false);
    expect(cascade).toMatchObject({ outcome: 'ok', reasonCode: 'cascade_ambiguous' });
    expect(clarification).toMatchObject({ outcome: 'skipped', reasonCode: 'cascade_ambiguous' });
    expect(trace.envelope).toMatchObject({
      status: 'completed',
      terminalOutcome: 'needs_clarification',
      firstIssueSpanId: clarification?.spanId,
    });
    expect((cascade?.payload as { decision?: { requiresDeclaredFiscalCalendar?: boolean } }).decision?.requiresDeclaredFiscalCalendar).toBe(true);
    const strict = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' });
    expect(strict.trace.envelope).toMatchObject({ terminalOutcome: 'needs_clarification' });
    expect(strict.trace.envelope.firstIssueSpanId).toBe(strict.trace.spans.find((span) => span.name === 'cascade.clarify_or_gap')?.spanId);
  });

  it('marks an actual meaning rejection as an issue without relabeling the authoritative cascade', () => {
    const { store, observer } = memoryObserver({ runId: 'run-meaning-rejected' });
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'block',
      source: 'llm',
      retrievalEvidence: { candidateCount: 1, candidateIds: ['semantic:metric:revenue'] },
      meaningResolutionErrorCode: 'invalid_evidence_reference',
      analyticalCascadeDecision: {
        version: 1,
        requirements: {
          version: 1,
          measures: ['revenue'],
          dimensions: [],
          entityTerms: [],
          entityDisplayTerms: [],
          memberTerms: [],
        },
        sourceCoverage: [],
        attempts: [{
          version: 1,
          tier: 'clarify_or_gap',
          outcome: 'unavailable',
          candidateIds: [],
          reason: 'The supplied meaning binding was rejected.',
          planFrozen: false,
        }],
        planFrozen: false,
        stopReason: 'coverage_gap',
      },
    } as never);
    finalizeAgentRunTraceV1(observer, {
      status: 'blocked',
      trustState: 'blocked',
      completedAt: '2026-08-22T12:00:01.000Z',
    } as never);

    const trace = store.getByRun('run-meaning-rejected')!;
    const meaning = trace.spans.find((span) => span.name === 'meaning.resolve');
    const cascade = trace.spans.find((span) => span.name === 'cascade.evaluate');
    expect(meaning).toMatchObject({ outcome: 'error', reasonCode: 'meaning_rejected' });
    expect(isAskTraceIssueSpanV1(meaning!)).toBe(true);
    expect(cascade).toMatchObject({ outcome: 'ok', reasonCode: 'cascade_unavailable' });
  });

  it('projects a router-owned missing relationship proof through trace, strict export, and receipt replay', () => {
    const { directory } = fixtureStore();
    const { store, observer } = memoryObserver({ runId: 'run-missing-relationship-proof' });
    const cascade = {
      version: 1,
      requirements: {
        version: 1,
        measures: [], dimensions: ['account'], entityTerms: ['account'], entityDisplayTerms: ['account name'], memberTerms: [],
      },
      sourceCoverage: [{
        version: 1, source: 'governed_relational', status: 'available',
        candidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
      }],
      attempts: [{
        version: 1, tier: 'governed_relational', outcome: 'denied',
        candidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
        reason: 'The relationship requires approved attribution before it can authorize a ranking.',
        planFrozen: false,
      }],
      terminalGap: {
        version: 1,
        code: 'MISSING_RELATIONSHIP',
        requirement: 'certified_relationship_or_allocation_proof',
        witnessCandidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
      },
      planFrozen: false,
      stopReason: 'denied',
    } as const;
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'block', source: 'heuristic', retrievalEvidence: { candidateCount: 1, candidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'] },
      terminalOutcome: {
        kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP', message: 'not persisted in trace payload',
        candidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
        gap: {
          code: 'MISSING_RELATIONSHIP', missing: ['a certified relationship proof'],
          witnessCandidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
        },
      },
      analyticalCascadeDecision: cascade,
    } as never);
    observer.finalize({ status: 'blocked', trustState: 'blocked' });

    const trace = store.getByRun('run-missing-relationship-proof')!;
    const cascadeSpans = trace.spans.filter((span) => span.payload.kind === 'cascade');
    expect(cascadeSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'cascade.evaluate', outcome: 'denied', reasonCode: 'cascade_denied',
        payload: expect.objectContaining({ decision: expect.objectContaining({
          terminalGap: {
            code: 'MISSING_RELATIONSHIP',
            requirement: 'certified_relationship_or_allocation_proof',
            witnessCandidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
          },
        }) }),
      }),
      expect.objectContaining({
        name: 'cascade.governed_relational', outcome: 'denied', reasonCode: 'cascade_denied',
      }),
    ]));
    expect(JSON.stringify(cascadeSpans)).not.toContain('not persisted in trace payload');

    const out = join(directory, 'relationship-proof-bundle');
    exportAskTraceBundleV1(trace, {
      profile: 'strict',
      outputDirectory: out,
      provenance: 'recorded',
      runReceipt: {
        diagnosticReceiptV3: {
          version: 3,
          planFrozen: false,
          finalStopReason: 'analytical_modeling_gap',
          terminalGap: cascade.terminalGap,
          cascade,
        },
      },
    });
    expect(validateAskTraceBundleV1(out)).toMatchObject({ valid: true, errors: [] });
    expect(replayAskTraceReceiptV1(out)).toMatchObject({ valid: true, errors: [] });
    const strict = JSON.parse(readFileSync(join(out, 'trace.json'), 'utf8')) as AskTraceDataV1;
    const strictGap = strict.spans
      .filter((span) => span.payload.kind === 'cascade')
      .map((span) => span.payload.decision.terminalGap)
      .find((gap) => gap?.code === 'MISSING_RELATIONSHIP');
    expect(strictGap).toMatchObject({
      code: 'MISSING_RELATIONSHIP',
      requirement: 'certified_relationship_or_allocation_proof',
      witnessCandidateIds: [expect.stringMatching(/^candidate_[0-9a-f]{16}$/)],
    });
  });

  it('prioritizes a terminal frozen-semantic compilation failure over a recoverable certified miss', () => {
    const { store, observer } = memoryObserver({ runId: 'run-frozen-semantic-failure' });
    const cascade = {
      version: 1,
      requirements: {
        version: 1,
        measures: ['revenue'], dimensions: [], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [],
      },
      sourceCoverage: [
        { source: 'certified', status: 'available', candidateIds: [] },
        { source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] },
      ],
      attempts: [
        { version: 1, tier: 'certified', outcome: 'unavailable', candidateIds: [], reason: 'no exact certified answer', planFrozen: false },
        { version: 1, tier: 'semantic', outcome: 'executable', candidateIds: ['semantic:metric:revenue'], reason: 'semantic plan is complete', planFrozen: true },
      ],
      selectedTier: 'semantic',
      planFrozen: true,
      stopReason: 'selected',
    } as const;
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'answer', source: 'heuristic', retrievalEvidence: { candidateCount: 1, candidateIds: ['semantic:metric:revenue'] },
      analyticalCascadeDecision: cascade,
    } as never);
    // A failed answer artifact has no accepted result fingerprint. The event
    // must not manufacture `result.normalize: ok` before finalization.
    recordEngineTraceEventV1(observer, {
      id: 'run-frozen-semantic-failure:event:1', runId: 'run-frozen-semantic-failure', type: 'artifact.created',
      at: '2026-08-22T12:00:00.000Z', message: 'Created blocked answer artifact.', route: 'semantic_answer', trustState: 'blocked',
      payload: {
        id: 'answer:frozen-semantic-failure', kind: 'answer', title: 'Blocked semantic answer', trustState: 'blocked',
        payload: { analyticalFailure: { code: 'COMPILATION_FAILED', phase: 'compilation', safeActions: ['edit_dql'] } },
      },
    });
    finalizeAgentRunTraceV1(observer, {
      id: 'run-frozen-semantic-failure', status: 'blocked', route: 'semantic_answer', trustState: 'blocked',
      completedAt: '2026-08-22T12:00:01.000Z', routeDecision: { analyticalCascadeDecision: cascade },
      artifacts: [{ id: 'answer:frozen-semantic-failure', kind: 'answer', title: 'Blocked semantic answer', trustState: 'blocked', payload: { analyticalFailure: { code: 'COMPILATION_FAILED', phase: 'compilation', safeActions: ['edit_dql'] } } }],
    } as never);

    const trace = store.getByRun('run-frozen-semantic-failure')!;
    const certified = trace.spans.find((span) => span.name === 'cascade.certified');
    const freeze = trace.spans.find((span) => span.name === 'plan.freeze');
    const terminal = trace.spans.find((span) => span.name === 'semantic.compile' && span.reasonCode === 'post_freeze_failure');

    expect(certified).toMatchObject({ outcome: 'unavailable', reasonCode: 'cascade_unavailable' });
    expect(freeze).toMatchObject({ outcome: 'ok', reasonCode: 'plan_frozen' });
    expect(terminal).toMatchObject({ outcome: 'error', reasonCode: 'post_freeze_failure', payload: { kind: 'result', failureCode: 'COMPILATION_FAILED', safeAction: 'edit_dql' } });
    expect(trace.envelope.firstIssueSpanId).toBe(terminal?.spanId);
    expect(trace.spans.some((span) => span.name === 'result.normalize' && span.outcome === 'ok')).toBe(false);
    expect(trace.spans.some((span) => span.name === 'sql.execute')).toBe(false);
  });

  it('projects a Research root deadline as a typed run-deadline incident rather than an unknown trace error', () => {
    const { store, observer } = memoryObserver({ runId: 'run-research-deadline' });
    finalizeAgentRunTraceV1(observer, {
      id: 'run-research-deadline',
      requestedMode: 'research',
      status: 'blocked',
      route: 'research',
      trustState: 'blocked',
      completedAt: '2026-08-24T12:00:00.000Z',
      artifacts: [],
      diagnosticReceipt: {
        version: 1,
        runId: 'run-research-deadline',
        phase: 'research.run',
        steps: [],
        artifacts: [],
        evaluations: [],
        failure: {
          code: 'RESEARCH_RUN_DEADLINE',
          phase: 'research.run',
          message: 'Research reached its bounded run deadline before finalization.',
          recoverable: true,
          safeActions: ['inspect_failure'],
        },
      },
    } as never);

    const trace = store.getByRun('run-research-deadline')!;
    const deadline = trace.spans.find((span) => span.name === 'research.synthesize' && span.reasonCode === 'run_deadline');
    expect(deadline).toMatchObject({ outcome: 'error', payload: { kind: 'research', branchStopReason: 'run_deadline' } });
    expect(trace.envelope.firstIssueSpanId).toBe(deadline?.spanId);
  });

  it('projects a frozen certified connection setup failure without inventing SQL or provider work', () => {
    const { store, observer } = memoryObserver({ runId: 'run-frozen-certified-connection' });
    const cascade = {
      version: 1,
      requirements: {
        version: 1,
        measures: ['revenue'], dimensions: [], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [],
      },
      sourceCoverage: [{ source: 'certified', status: 'available', candidateIds: ['revenue_operations::block::Top Customers by Revenue'] }],
      attempts: [
        {
          version: 1,
          tier: 'certified',
          outcome: 'executable',
          candidateIds: ['revenue_operations::block::Top Customers by Revenue'],
          reason: 'certified plan is complete',
          planFrozen: true,
        },
      ],
      selectedTier: 'certified',
      planFrozen: true,
      stopReason: 'selected',
    } as const;
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'answer', source: 'heuristic', retrievalEvidence: { candidateCount: 1, candidateIds: ['revenue_operations::block::Top Customers by Revenue'] },
      analyticalCascadeDecision: cascade,
    } as never);
    finalizeAgentRunTraceV1(observer, {
      id: 'run-frozen-certified-connection',
      status: 'blocked',
      route: 'certified_answer',
      trustState: 'blocked',
      completedAt: '2026-08-22T12:00:01.000Z',
      routeDecision: { analyticalCascadeDecision: cascade },
      artifacts: [{
        id: 'answer:frozen-certified-connection', kind: 'answer', title: 'Blocked certified answer', trustState: 'blocked',
        payload: {
          observabilityExecutionFailure: {
            version: 1, phase: 'execution', cause: 'connection_not_configured', safeAction: 'configure_connection',
          },
        },
      }],
    } as never);

    const trace = store.getByRun('run-frozen-certified-connection')!;
    const terminal = trace.spans.find((span) => span.name === 'result.normalize' && span.reasonCode === 'post_freeze_failure');

    expect(terminal).toMatchObject({
      outcome: 'error',
      reasonCode: 'post_freeze_failure',
      payload: {
        kind: 'result',
        failureCode: 'CONNECTION_NOT_CONFIGURED',
        safeAction: 'configure_connection',
      },
    });
    expect(trace.envelope.firstIssueSpanId).toBe(terminal?.spanId);
    expect(trace.spans.some((span) => span.name === 'sql.execute' || span.stage === 'provider')).toBe(false);
    expect(JSON.stringify(trace)).not.toContain('No database connection is configured');
  });

  it('projects no governed or exploratory attempt after a frozen semantic tier', () => {
    const { store, observer } = memoryObserver({ runId: 'run-frozen-cascade-prefix' });
    const cascade = {
      version: 1,
      requirements: {
        version: 1,
        measures: ['bcm run rate'], dimensions: [], entityTerms: ['account'], entityDisplayTerms: ['account name'], memberTerms: [],
      },
      sourceCoverage: [],
      attempts: [
        { version: 1, tier: 'certified', outcome: 'unavailable', candidateIds: [], reason: 'No certified tuple.', planFrozen: false },
        { version: 1, tier: 'semantic', outcome: 'executable', candidateIds: ['semantic:account_revenue:bcm_run_rate'], reason: 'Semantic tuple froze.', planFrozen: true },
        // Simulate a stale pre-built fallback receipt from a legacy caller.
        { version: 1, tier: 'governed_relational', outcome: 'ineligible', candidateIds: ['dql:relationship:account_revenue_to_account'], reason: 'Must not appear after freeze.', planFrozen: false },
        { version: 1, tier: 'exploratory_sql', outcome: 'executable', candidateIds: ['dbt:model:fct_account_revenue'], reason: 'Must not appear after freeze.', planFrozen: false },
      ],
      selectedTier: 'semantic',
      planFrozen: true,
      stopReason: 'selected',
    } as const;
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'answer', source: 'heuristic', retrievalEvidence: { candidateCount: 1, candidateIds: ['semantic:account_revenue:bcm_run_rate'] },
      analyticalCascadeDecision: cascade,
    } as never);
    observer.finalize({ status: 'completed', trustState: 'blocked', selectedTier: 'semantic' });

    const trace = store.getByRun('run-frozen-cascade-prefix')!;
    const cascadeSpan = trace.spans.find((span) => span.name === 'cascade.evaluate');
    const attempts = (cascadeSpan?.payload as { decision?: { attempts?: Array<{ tier: string; planFrozen: boolean }> } }).decision?.attempts;
    expect(attempts?.map((attempt) => [attempt.tier, attempt.planFrozen])).toEqual([
      ['certified', false],
      ['semantic', true],
    ]);
    expect(trace.spans.map((span) => span.name)).not.toEqual(expect.arrayContaining([
      'cascade.governed_relational',
      'cascade.exploratory_sql',
    ]));
  });
});

describe.runIf(sqliteAvailable())('AskTraceSqliteStoreV1 lifecycle (supported SQLite runtime)', () => {
  it('persists a safe clarification terminal outcome through the local trace store', () => {
    const { store } = fixtureStore();
    const observer = createAskTraceObserverV1({
      store,
      runId: 'run-persisted-fiscal-clarification',
      surface: 'cli',
      mode: 'ask',
      questionFingerprint: 'sha256:persisted-fiscal-clarification',
    });
    const meaning = observer.startSpan({
      name: 'meaning.resolve',
      stage: 'meaning',
      payload: { kind: 'meaning', selectedCandidateIds: [], rejectedCandidateIds: [], source: 'heuristic' },
    });
    observer.finishSpan(meaning, { outcome: 'skipped', reasonCode: 'unknown' });
    const clarification = observer.startSpan({
      name: 'cascade.clarify_or_gap',
      stage: 'cascade',
      payload: { kind: 'cascade', decision: { planFrozen: false, stopReason: 'ambiguous', requiresDeclaredFiscalCalendar: true, sourceCoverage: [], attempts: [] } },
    });
    observer.finishSpan(clarification, { outcome: 'skipped', reasonCode: 'cascade_ambiguous' });
    observer.finalize({ status: 'completed', terminalOutcome: 'needs_clarification' });

    expect(store.getByRun('run-persisted-fiscal-clarification')?.envelope).toMatchObject({
      terminalOutcome: 'needs_clarification',
      firstIssueSpanId: clarification,
    });
    store.close();
  });

  it('marks open traces interrupted after a restart without affecting trace history', () => {
    const { directory, store } = fixtureStore();
    const path = join(directory, 'ask-observability.sqlite');
    const envelope = makeEnvelope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'run-interrupted');
    expect(store.begin(envelope).accepted).toBe(true);
    store.close();
    // Fixture traces carry fixed 2026 dates; age retention must not depend on today.
    const restarted = new AskTraceSqliteStoreV1({ path, ...NO_AGE_LIMIT });
    expect(restarted.getByRun('run-interrupted')?.envelope).toMatchObject({ status: 'interrupted', recordingStatus: 'partial' });
    restarted.close();
  });

  it('durably admits an observer root before its first queued flush, then exports a restarted trace', () => {
    const { directory } = fixtureStore();
    const path = join(directory, 'abrupt-root.sqlite');
    const first = new AskTraceSqliteStoreV1({ path, flushIntervalMs: 25 });
    const observer = createAskTraceObserverV1({
      store: first,
      runId: 'run-root-before-flush',
      surface: 'cli',
      mode: 'ask',
      questionFingerprint: 'sha256:root-before-flush',
    });
    expect(observer.enabled).toBe(true);
    // The observer's normal root update is still queued. The transaction in
    // begin() must already have admitted a structurally valid root row.
    expect(first.pendingWriteCount()).toBeGreaterThan(0);
    const reader = new Database(path, { readonly: true });
    try {
      expect(reader.prepare('SELECT span_id, name, ordinal FROM ask_spans WHERE trace_id = ?').get(observer.traceId)).toMatchObject({
        span_id: observer.rootSpanId,
        name: 'ask.run',
        ordinal: 0,
      });
    } finally {
      reader.close();
    }

    // Closing here models a process boundary after asserting the critical
    // pre-flush durability property. Startup converts the unfinished root to
    // an interrupted receipt without having to synthesize missing detail.
    first.close();
    const restarted = new AskTraceSqliteStoreV1({ path });
    const trace = restarted.getByRun('run-root-before-flush')!;
    expect(trace.envelope).toMatchObject({ status: 'interrupted', recordingStatus: 'partial', spanCount: 1 });
    expect(trace.spans.find((span) => span.spanId === observer.rootSpanId)).toMatchObject({
      name: 'ask.run', outcome: 'interrupted', reasonCode: 'interrupted',
    });
    const out = join(directory, 'abrupt-root-bundle');
    exportAskTraceBundleV1(trace, { profile: 'strict', outputDirectory: out, provenance: 'recorded' });
    expect(validateAskTraceBundleV1(out)).toMatchObject({ valid: true, errors: [] });
    restarted.close();
  });

  it('keeps reopened producers bounded and fails open when a WAL writer is contended', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-wal-'));
    dirs.push(directory);
    const path = join(directory, 'wal.sqlite');
    const first = new AskTraceSqliteStoreV1({ path, busyTimeoutMs: 25, flushIntervalMs: 25 });
    const firstTraceId = '12121212121212121212121212121212';
    expect(first.begin(makeEnvelope(firstTraceId, 'run-wal-first')).accepted).toBe(true);
    first.close();

    const reopened = new AskTraceSqliteStoreV1({ path, busyTimeoutMs: 25, flushIntervalMs: 25 });
    const traceId = '13131313131313131313131313131313';
    const envelope = makeEnvelope(traceId, 'run-wal-reopened');
    let locker: Database.Database | undefined;
    try {
      expect(reopened.begin(envelope).accepted).toBe(true);
      expect(reopened.appendSpan(makeStoreSpan(traceId, '2222222222222222', 1)).accepted).toBe(true);
      // A second writer holds the WAL admission lock. The producer already
      // returned; only the scheduled/local batch observes the store failure.
      locker = new Database(path);
      locker.pragma('journal_mode = WAL');
      locker.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      reopened.flushNow();
      expect(performance.now() - started).toBeLessThan(500);
      expect(reopened.status()).toMatchObject({ available: false, reason: 'store_error' });
      expect(reopened.appendSpan(makeStoreSpan(traceId, '3333333333333333', 2))).toMatchObject({
        accepted: false,
        dropped: 'unavailable',
      });
    } finally {
      try { locker?.exec('ROLLBACK'); } catch { /* lock may already be released */ }
      locker?.close();
      reopened.close();
    }
  });

  it('leaves a newer schema unread in read-only inspection mode', () => {
    const { directory } = fixtureStore();
    const path = join(directory, 'newer.sqlite');
    const db = new Database(path);
    db.pragma('user_version = 2');
    db.close();

    const readOnly = new AskTraceSqliteStoreV1({ path, readOnly: true });
    expect(readOnly.status()).toMatchObject({ available: false, readOnly: true, reason: 'unsupported_schema' });
    readOnly.close();
  });

  it('persists a failed allowlisted tool call and keeps the trace active', () => {
    const { store } = fixtureStore();
    const observer = createAskTraceObserverV1({
      store,
      runId: 'run-failed-tool',
      surface: 'cli',
      mode: 'ask',
      questionFingerprint: 'sha256:failed-tool',
    });
    const tool = observer.startSpan({
      name: 'tool.call',
      stage: 'tool',
      payload: {
        kind: 'tool',
        call: { version: 1, toolCallId: 'tool-1', toolKind: 'search_metadata', attemptIndex: 1, safeErrorCode: 'tool_error' },
      },
    });
    observer.finishSpan(tool, {
      outcome: 'error',
      reasonCode: 'tool_failure',
      payload: {
        kind: 'tool',
        call: { version: 1, toolCallId: 'tool-1', toolKind: 'search_metadata', attemptIndex: 1, safeErrorCode: 'tool_error' },
      },
    });
    observer.finalize({ status: 'completed' });

    const trace = store.getByRun('run-failed-tool');
    expect(trace?.envelope.recordingStatus).toBe('complete');
    expect(trace?.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'tool.call',
        outcome: 'error',
        payload: expect.objectContaining({ kind: 'tool', call: expect.objectContaining({ safeErrorCode: 'tool_error' }) }),
      }),
    ]));
    store.close();
  });

  it('batches a bounded producer queue, reports pressure, and enforces trace caps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-queue-'));
    dirs.push(directory);
    const store = new AskTraceSqliteStoreV1({
      path: join(directory, 'queue.sqlite'),
      queueCap: 2,
      flushBatchSize: 128,
      flushIntervalMs: 25,
      // The durable root is structural trace detail and participates in the
      // same cap as physical child spans.
      maxSpansPerTrace: 3,
    });
    const traceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(store.begin(makeEnvelope(traceId, 'run-queue')).accepted).toBe(true);
    expect(store.appendSpan(makeStoreSpan(traceId, '2222222222222222', 1)).accepted).toBe(true);
    expect(store.appendSpan(makeStoreSpan(traceId, '3333333333333333', 2)).accepted).toBe(true);
    // Queue pressure is observed before a producer can make an unbounded
    // SQLite call; it marks only this trace partial and leaves Ask fail-open.
    expect(store.appendSpan(makeStoreSpan(traceId, '4444444444444444', 3))).toMatchObject({ accepted: false, dropped: 'queue_cap' });
    expect(store.pendingWriteCount()).toBe(2);
    expect(store.droppedRecordCount(traceId)).toBe(1);

    const trace = store.getByRun('run-queue');
    expect(trace?.spans).toHaveLength(3);
    expect(trace?.envelope.recordingStatus).toBe('partial');
    store.close();
  });

  it('flushes ordinary producer writes on the bounded 25ms timer instead of a read path', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-timer-'));
    dirs.push(directory);
    const store = new AskTraceSqliteStoreV1({
      path: join(directory, 'timer.sqlite'),
      flushBatchSize: 128,
      flushIntervalMs: 25,
      queueCap: 16,
    });
    const traceId = 'dddddddddddddddddddddddddddddddd';
    try {
      expect(store.begin(makeEnvelope(traceId, 'run-timer')).accepted).toBe(true);
      expect(store.appendSpan(makeStoreSpan(traceId, '2222222222222222', 1)).accepted).toBe(true);
      expect(store.pendingWriteCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(24);
      expect(store.pendingWriteCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.pendingWriteCount()).toBe(0);
      // The public read is now a check rather than the flush trigger.
      expect(store.getByRun('run-timer')?.spans).toHaveLength(2);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it('defers queue-pressure partial accounting into the bounded batch instead of synchronously updating SQLite', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-deferred-drop-'));
    dirs.push(directory);
    const path = join(directory, 'deferred.sqlite');
    const store = new AskTraceSqliteStoreV1({
      path,
      queueCap: 1,
      flushBatchSize: 128,
      flushIntervalMs: 25,
    });
    const traceId = 'abababababababababababababababab';
    try {
      expect(store.begin(makeEnvelope(traceId, 'run-deferred-drop')).accepted).toBe(true);
      expect(store.appendSpan(makeStoreSpan(traceId, '2222222222222222', 1)).accepted).toBe(true);
      expect(store.appendSpan(makeStoreSpan(traceId, '3333333333333333', 2))).toMatchObject({ accepted: false, dropped: 'queue_cap' });
      // The producer path only changes in-memory accounting. The on-disk row
      // remains untouched until the documented coalescing window elapses.
      const raw = new Database(path, { readonly: true });
      expect((raw.prepare('SELECT dropped_record_count FROM ask_traces WHERE trace_id = ?').get(traceId) as { dropped_record_count: number }).dropped_record_count).toBe(0);
      raw.close();
      await vi.advanceTimersByTimeAsync(25);
      const persisted = new Database(path, { readonly: true });
      expect((persisted.prepare('SELECT dropped_record_count FROM ask_traces WHERE trace_id = ?').get(traceId) as { dropped_record_count: number }).dropped_record_count).toBe(1);
      persisted.close();
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it('enforces span/detail/summary retention caps while retaining recent trace summaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-retention-'));
    dirs.push(directory);
    const store = new AskTraceSqliteStoreV1({
      path: join(directory, 'retention.sqlite'),
      maxSpansPerTrace: 3,
      maxDetailedTraces: 1,
      maxSummaryTraces: 2,
      queueCap: 32,
      // Only the count caps are under test; fixed fixture dates must not age out.
      ...NO_AGE_LIMIT,
    });
    const complete = (traceId: string, runId: string, startedAt: string) => {
      const envelope = { ...makeEnvelope(traceId, runId), startedAt };
      expect(store.begin(envelope).accepted).toBe(true);
      expect(store.appendSpan(makeStoreSpan(traceId, '2222222222222222', 1)).accepted).toBe(true);
      store.finalize({ ...envelope, status: 'completed', recordingStatus: 'complete', completedAt: startedAt });
    };
    const first = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const second = 'ffffffffffffffffffffffffffffffff';
    const third = '99999999999999999999999999999999';
    complete(first, 'run-retention-1', '2026-08-22T10:00:00.000Z');
    // Trace-local cap is checked before a producer appends unbounded detail.
    expect(store.appendSpan(makeStoreSpan(first, '3333333333333333', 2)).accepted).toBe(true);
    expect(store.appendSpan(makeStoreSpan(first, '4444444444444444', 3))).toMatchObject({ accepted: false, dropped: 'span_cap' });
    complete(second, 'run-retention-2', '2026-08-22T10:01:00.000Z');
    complete(third, 'run-retention-3', '2026-08-22T10:02:00.000Z');

    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)?.envelope.recordingStatus).toBe('detail_expired');
    expect(store.get(third)?.spans).toHaveLength(2);
    expect(store.list({ limit: 100 }).traces).toHaveLength(2);
    store.close();
  });

  it('filters the paginated trace catalog by persisted receipt fields without retaining question text', () => {
    const { store } = fixtureStore();
    const complete = (traceId: string, runId: string, input: Partial<AskTraceEnvelopeV1>) => {
      const envelope = { ...makeEnvelope(traceId, runId), ...input };
      expect(store.begin(envelope).accepted).toBe(true);
      store.finalize({
        ...envelope,
        status: input.status ?? 'completed',
        recordingStatus: 'complete',
        completedAt: input.startedAt ?? envelope.startedAt,
      });
    };
    complete('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'run-certified', {
      status: 'completed', mode: 'ask', surface: 'cli', trustState: 'certified', selectedTier: 'certified', startedAt: '2026-08-22T10:00:00.000Z',
    });
    complete('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', 'run-review', {
      status: 'blocked', mode: 'research', surface: 'browser', trustState: 'review_required', selectedTier: 'exploratory_sql', startedAt: '2026-08-22T11:00:00.000Z',
    });

    const filtered = store.list({ mode: 'research', surface: 'browser', selectedTier: 'exploratory_sql', limit: 10 });
    expect(filtered).toMatchObject({ total: 1, traces: [expect.objectContaining({ runId: 'run-review', detailAvailable: true })] });
    // `questionFingerprint` is deliberately receipt metadata; the catalog must
    // never persist a raw question or the runtime-only display preview.
    expect(filtered.traces[0]).not.toHaveProperty('question');
    expect(filtered.traces[0]).not.toHaveProperty('questionPreview');
    store.close();
  });

  it('keeps p95 enqueue work below one millisecond on a fresh trace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-perf-'));
    dirs.push(directory);
    const store = new AskTraceSqliteStoreV1({
      path: join(directory, 'perf.sqlite'),
      queueCap: 512,
      flushBatchSize: 512,
      flushIntervalMs: 25,
      maxSpansPerTrace: 512,
    });
    const traceId = 'cccccccccccccccccccccccccccccccc';
    expect(store.begin(makeEnvelope(traceId, 'run-perf')).accepted).toBe(true);
    const timings: number[] = [];
    for (let index = 0; index < 128; index += 1) {
      const started = performance.now();
      expect(store.appendSpan(makeStoreSpan(traceId, `${(index + 10).toString(16).padStart(16, '0')}`, index + 1)).accepted).toBe(true);
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    expect(timings[Math.floor(timings.length * 0.95)]!).toBeLessThanOrEqual(1);
    expect(store.pendingWriteCount()).toBe(128);
    store.close();
  });
});

describe('Ask trace portable bundles', () => {
  it('accepts a successful exploratory receipt that freezes after its authoritative pre-freeze selection', () => {
    const { directory } = fixtureStore();
    const { store, observer } = memoryObserver({ runId: 'run-exploratory-freeze-transition' });
    const selected = exploratoryCascadeDecision(false, 'dbt:model:analytics.orders');
    const frozen = exploratoryCascadeDecision(true, 'dbt:model:analytics.orders');
    recordAuthoritativeRouterDecisionV1(observer, {
      action: 'answer', source: 'llm', retrievalEvidence: { candidateCount: 1, candidateIds: ['dbt:model:analytics.orders'] },
      analyticalCascadeDecision: selected,
    } as never);
    // The physical plan freezes only after the selected exploratory route has
    // been validated. Both receipts are authoritative and must survive strict
    // export unchanged.
    recordAuthoritativePlanFreezeV1(observer, frozen);
    for (const name of ['sql.generate', 'sql.validate', 'sql.authorize', 'sql.execute'] as const) {
      const span = observer.startSpan({
        name,
        stage: 'sql',
        payload: { kind: 'sql', execution: { version: 1, tier: 'exploratory_sql', planFingerprint: 'sha256:exploratory-plan', reviewRequired: true } },
      });
      observer.finishSpan(span, { outcome: 'ok', reasonCode: 'completed' });
    }
    const result = observer.startSpan({
      name: 'result.normalize', stage: 'result',
      payload: { kind: 'result', resultFingerprint: 'a'.repeat(64), rowCount: 1, trustState: 'review_required' },
    });
    observer.finishSpan(result, { outcome: 'ok', reasonCode: 'result_accepted' });
    observer.finalize({ status: 'completed', trustState: 'review_required', selectedTier: 'exploratory_sql' });

    const out = join(directory, 'exploratory-transition');
    exportAskTraceBundleV1(store.getByRun('run-exploratory-freeze-transition')!, {
      profile: 'strict', outputDirectory: out, provenance: 'recorded',
    });
    expect(validateAskTraceBundleV1(out)).toMatchObject({ valid: true, errors: [] });
    expect(replayAskTraceReceiptV1(out)).toMatchObject({ valid: true, errors: [] });
  });

  it('rejects exploratory selection bundles without a matching later freeze', () => {
    const { directory } = fixtureStore();
    const missing = memoryObserver({ runId: 'run-exploratory-freeze-missing' });
    const selected = exploratoryCascadeDecision(false, 'dbt:model:analytics.orders');
    recordAuthoritativeRouterDecisionV1(missing.observer, {
      action: 'answer', source: 'llm', retrievalEvidence: { candidateCount: 1, candidateIds: ['dbt:model:analytics.orders'] },
      analyticalCascadeDecision: selected,
    } as never);
    missing.observer.finalize({ status: 'blocked', trustState: 'blocked', selectedTier: 'exploratory_sql' });
    const missingOut = join(directory, 'missing-freeze');
    exportAskTraceBundleV1(missing.store.getByRun('run-exploratory-freeze-missing')!, {
      profile: 'strict', outputDirectory: missingOut, provenance: 'recorded',
    });
    expect(validateAskTraceBundleV1(missingOut)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['Exploratory selection is not frozen.']),
    });

    const mismatched = memoryObserver({ runId: 'run-exploratory-freeze-mismatched' });
    recordAuthoritativeRouterDecisionV1(mismatched.observer, {
      action: 'answer', source: 'llm', retrievalEvidence: { candidateCount: 1, candidateIds: ['dbt:model:analytics.orders'] },
      analyticalCascadeDecision: selected,
    } as never);
    recordAuthoritativePlanFreezeV1(mismatched.observer, exploratoryCascadeDecision(true, 'dbt:model:analytics.invoices'));
    mismatched.observer.finalize({ status: 'blocked', trustState: 'blocked', selectedTier: 'exploratory_sql' });
    const mismatchOut = join(directory, 'mismatched-freeze');
    exportAskTraceBundleV1(mismatched.store.getByRun('run-exploratory-freeze-mismatched')!, {
      profile: 'strict', outputDirectory: mismatchOut, provenance: 'recorded',
    });
    expect(validateAskTraceBundleV1(mismatchOut)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['Exploratory selection is not frozen.']),
    });
  });

  it('exports a deterministic strict receipt that validates and replays without a provider/tool/SQL path', () => {
    const { directory } = fixtureStore();
    const { store, observer } = memoryObserver({ runId: 'run-export' });
    const provider = observer.startSpan({
      name: 'provider.attempt', stage: 'provider',
      payload: { kind: 'provider', attempt: { version: 1, phase: 'meaning_resolution', physicalAttemptIndex: 1, readiness: 'ready', provenance: 'recorded' } },
    });
    observer.finishSpan(provider, { outcome: 'ok', reasonCode: 'completed' });
    observer.finalize({ status: 'completed', trustState: 'certified', selectedTier: 'certified' });
    const trace = store.getByRun('run-export')!;
    const out = join(directory, 'strict-bundle');
    const receipt = exportAskTraceBundleV1(trace, { profile: 'strict', outputDirectory: out, provenance: 'recorded' });

    expect(receipt.canaryPassed).toBe(true);
    expect(validateAskTraceBundleV1(out)).toMatchObject({ valid: true });
    expect(replayAskTraceReceiptV1(out)).toMatchObject({ valid: true });
    const inMemory = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' });
    const repeated = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' });
    expect(repeated).toEqual(inMemory);
    expect(inMemory.trace.envelope.runId).not.toBe(trace.envelope.runId);
  });

  it('strictly allowlists V5 workspace diagnostics and excludes secret-like member values', () => {
    const { store, observer } = memoryObserver({ runId: 'run-v5-allowlist' });
    observer.finalize({ status: 'completed', trustState: 'governed', selectedTier: 'semantic' });
    const trace = store.getByRun('run-v5-allowlist')!;
    const memberValue = 'sk_member_abcdefghijklmnop';
    const bundle = createAskTracePortableBundleV1(trace, {
      profile: 'strict',
      provenance: 'recorded',
      runReceipt: {
        id: 'run-v5-allowlist',
        diagnosticReceiptV5: {
          version: 5,
          runId: 'run-v5-allowlist',
          state: {
            version: 1,
            mode: 'authoritative',
            phase: 'executed',
            questionFingerprint: 'sha256:question',
            kind: 'aggregation',
            requirementCounts: { measures: 1, dimensions: 0, entityTerms: 0, members: 1, filters: 1 },
            mission: { mode: 'ask', taskCount: 1, deferredTaskCount: 0, hypothesisCount: 1 },
            workspace: {
              snapshotId: memberValue,
              sourceFingerprint: memberValue,
              admittedCandidateCount: 1,
              excludedCandidateCount: 0,
              sourceCoverage: [{ source: 'semantic', status: 'available', candidateCount: 1, reason: memberValue }],
              tools: [{ id: `tool:${memberValue}`, kind: 'retrieve_snapshot', status: 'completed', reasonCode: 'snapshot_acquired', member: memberValue }],
              rawMember: memberValue,
            },
            program: { id: 'program:v5', taskCount: 1, candidateCount: 1, requiredRoles: ['metric'], outputAssertionCount: 2 },
            counters: { planningContinuations: 0, toolCalls: 1, executionAttempts: 1, repairAttempts: 0 },
          },
          summary: {
            version: 2, summaryFingerprint: 'sha256:v5-summary', runtimeMode: 'authoritative',
            whatHappened: 'not exported', why: 'not exported', impact: 'not exported', nextAction: 'none',
            selectedCompiler: 'metricflow', programTaskCount: 1, admittedCandidateCount: 1, toolCallCount: 1, executionAttempts: 1,
          },
          businessAnswer: { version: 1, mode: 'facts_only', trustState: 'governed', factIds: ['fact:v5'], limitationCount: 0 },
          finalStopReason: 'governed_semantic_answer',
        },
        // V6 must use the same explicit redaction boundary. In particular,
        // neither its inherited state nor its planning evidence may leak a
        // raw member/requirement value into a strict support bundle.
        diagnosticReceiptV6: {
          version: 6,
          runId: 'run-v5-allowlist',
          state: {
            version: 1,
            mode: 'authoritative',
            phase: 'executed',
            questionFingerprint: 'sha256:question',
            kind: 'aggregation',
            requirementCounts: { measures: 1, dimensions: 0, entityTerms: 0, members: 1, filters: 1 },
            mission: { mode: 'ask', taskCount: 1, deferredTaskCount: 0, hypothesisCount: 1 },
            workspace: {
              snapshotId: memberValue,
              sourceFingerprint: memberValue,
              admittedCandidateCount: 1,
              excludedCandidateCount: 0,
              sourceCoverage: [{ source: 'semantic', status: 'available', candidateCount: 1, reason: memberValue }],
              tools: [{ id: `tool:${memberValue}`, kind: 'retrieve_snapshot', status: 'completed', reasonCode: 'snapshot_acquired', member: memberValue }],
              rawMember: memberValue,
            },
            program: { id: 'program:v6', taskCount: 1, candidateCount: 1, requiredRoles: ['metric'], outputAssertionCount: 2 },
            counters: { planningContinuations: 1, toolCalls: 1, executionAttempts: 1, repairAttempts: 0 },
          },
          summary: {
            version: 2, summaryFingerprint: 'sha256:v6-summary', runtimeMode: 'authoritative',
            whatHappened: 'not exported', why: 'not exported', impact: 'not exported', nextAction: 'none',
            selectedCompiler: 'metricflow', programTaskCount: 1, admittedCandidateCount: 1, toolCallCount: 1, executionAttempts: 1,
          },
          planning: {
            version: 1,
            mode: 'initial_planner',
            plannerCalls: 1,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'valid',
              missingRoles: [],
              candidateIds: [`semantic:${memberValue}`],
              reasonCode: 'immutable_program_verified',
              rawRequirement: memberValue,
            },
          },
          roleCoverage: [{ role: 'metric', candidateCount: 1, rawRequirement: memberValue }],
          cascade: {
            attempts: [{ tier: 'semantic', outcome: 'executable', planFrozen: true, rawMember: memberValue }],
            selectedTier: 'semantic',
            stopReason: 'semantic_complete',
            planFrozen: true,
          },
          origin: { boundary: 'provider', origin: 'provider', impact: 'answer_not_produced', rawMember: memberValue },
          connection: { attempted: false, rawMember: memberValue },
          execution: { attempts: 1, rawMember: memberValue },
          facts: { factCount: 1, resultFingerprint: memberValue, rawMember: memberValue },
          safeNextAction: 'inspect_failure',
          story: [
            { stage: 'retrieval', status: 'completed', reasonCode: 'snapshot_acquired', rawMember: memberValue },
            { stage: 'verification', status: 'completed', reasonCode: 'immutable_program_verified' },
          ],
          finalStopReason: 'governed_semantic_answer',
        },
      },
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(memberValue);
    const workspace = (bundle.runReceipt.runtimeReceiptV5 as { state?: { workspace?: Record<string, unknown> } })?.state?.workspace;
    expect(workspace).toMatchObject({ admittedCandidateCount: 1, excludedCandidateCount: 0 });
    expect(workspace).not.toHaveProperty('rawMember');
    expect((workspace?.tools as Array<{ id: string }>)[0]?.id).not.toContain(memberValue);
    expect((workspace?.sourceCoverage as Array<Record<string, unknown>>)[0]).not.toHaveProperty('reason');
    const runtimeV6 = bundle.runReceipt.runtimeReceiptV6 as {
      state?: { workspace?: Record<string, unknown> };
      planning?: { verification?: { candidateIds?: string[]; missingRoleCount?: number } };
      story?: Array<Record<string, unknown>>;
    };
    expect(runtimeV6).toMatchObject({ version: 6, planning: { mode: 'initial_planner', verification: { missingRoleCount: 0 } } });
    expect(runtimeV6.state?.workspace).not.toHaveProperty('rawMember');
    expect(runtimeV6.planning?.verification?.candidateIds?.[0]).not.toContain(memberValue);
    expect(runtimeV6.planning?.verification).not.toHaveProperty('rawRequirement');
    expect(runtimeV6.story?.[0]).not.toHaveProperty('rawMember');
    expect(runtimeV6).toMatchObject({
      roleCoverage: [{ role: 'metric', candidateCount: 1 }],
      cascade: { selectedTier: 'semantic', planFrozen: true },
      connection: { attempted: false },
      execution: { attempts: 1 },
      facts: { factCount: 1 },
      safeNextAction: 'inspect_failure',
    });
    expect((runtimeV6 as Record<string, unknown>).origin).toEqual({ boundary: 'provider', origin: 'provider', impact: 'answer_not_produced' });
  });

  it('AGT-049 preserves ordinary-role ambiguity and alternatives through the V6 trace receipt', () => {
    const { store, observer } = memoryObserver({ runId: 'run-ordinary-role-ambiguity' });
    observer.finalize({ status: 'completed', terminalOutcome: 'needs_clarification' });
    const trace = store.getByRun('run-ordinary-role-ambiguity')!;
    const receipt = {
      runId: 'run-ordinary-role-ambiguity',
      finalStopReason: 'ordinary_role_inference_ambiguous',
      planning: {
        version: 1,
        mode: 'deterministic_binding',
        plannerCalls: 0,
        revisionCalls: 0,
        verification: {
          version: 1,
          status: 'ambiguous',
          missingRoles: ['categorical_dimension'],
          candidateIds: ['semantic:dimension:location_name', 'semantic:dimension:country_name'],
          reasonCode: 'ordinary_role_inference_ambiguous',
        },
      },
      roleCoverage: [{ role: 'categorical_dimension', candidateCount: 2, state: 'alternatives' }],
      cascade: { attempts: [], planFrozen: false },
      connection: { attempted: false },
      execution: { attempts: 0 },
      facts: { factCount: 0 },
      safeNextAction: 'inspect_failure',
      story: [
        { stage: 'retrieval', status: 'completed', reasonCode: 'snapshot_acquired' },
        { stage: 'role_coverage', status: 'completed', reasonCode: 'ordinary_role_inference_ambiguous' },
        { stage: 'planner', status: 'skipped', reasonCode: 'ordinary_role_inference_ambiguous' },
        { stage: 'verification', status: 'blocked', reasonCode: 'ordinary_role_inference_ambiguous' },
      ],
    };
    const bundle = createAskTracePortableBundleV1(trace, {
      profile: 'strict',
      provenance: 'recorded',
      runReceipt: {
        id: 'run-ordinary-role-ambiguity',
        diagnosticReceiptV6: { version: 6, ...receipt },
      },
    });
    const v6 = bundle.runReceipt.runtimeReceiptV6 as {
      planning?: { verification?: { reasonCode?: string } };
      roleCoverage?: Array<{ role: string; candidateCount: number; state?: string }>;
      story?: Array<{ reasonCode?: string }>;
    };
    expect(v6.planning?.verification?.reasonCode).toBe('ordinary_role_inference_ambiguous');
    expect(v6.roleCoverage).toEqual([{ role: 'categorical_dimension', candidateCount: 2, state: 'alternatives' }]);
    expect(v6.story?.some((step) => step.reasonCode === 'ordinary_role_inference_ambiguous')).toBe(true);
  });

  it('OBS-017 exports the V8 tool receipt as pseudonymous typed evidence without rows, SQL, prompts, or provider payloads', () => {
    const { store, observer } = memoryObserver({ runId: 'run-v8-allowlist' });
    observer.finalize({ status: 'blocked', terminalOutcome: 'blocked' });
    const trace = store.getByRun('run-v8-allowlist')!;
    const privateValue = 'Melissa Davis';
    const privateSecret = 'sk_v8_secret_abcdefghijklmnop';
    const bundle = createAskTracePortableBundleV1(trace, {
      profile: 'strict',
      provenance: 'recorded',
      runReceipt: {
        id: 'run-v8-allowlist',
        diagnosticReceiptV8: {
          version: 8,
          mode: 'authoritative_v2',
          turnClass: 'analytics',
          snapshotId: 'snapshot:office',
          retainedCandidateCount: 24,
          initialCandidateCount: 24,
          expansionCount: 1,
          objective: 'analytics',
          contextCoverage: [{ version: 2, source: 'semantic', status: 'available', admittedCandidateCount: 2, excludedCandidateCount: 0, reasonCodes: ['SOURCE_AVAILABLE', privateValue] }],
          excludedCandidateCount: 0,
          exclusionReasonCodes: ['WORKSPACE_CANDIDATE_CAP', privateSecret],
          observations: [{
            version: 1,
            tool: 'compile_and_run_semantic',
            outcome: 'ineligible',
            tier: 'semantic',
            reasonCode: 'SEMANTIC_TUPLE_INCOMPLETE',
            candidateIds: [`semantic:metric:${privateValue}`],
            planId: `plan:${privateValue}`,
            inputFingerprint: privateSecret,
            outputFingerprint: privateValue,
            origin: 'validation',
            rawSql: 'SELECT * FROM private.customers',
            provider: { phase: 'agent_control', cause: 'gateway', retryable: true, safeAction: 'retry_same_plan', rawResponse: privateSecret },
          }],
          tierAttempts: [{ version: 2, tier: 'semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_TUPLE_INCOMPLETE', candidateIds: [`semantic:metric:${privateValue}`], frozen: false }],
          planFrozen: false,
          terminalOutcome: { version: 2, kind: 'gap', reasonCode: 'ANALYTICAL_COVERAGE_GAP', origin: 'validation', safeAction: 'review_recorded_observations_then_retry' },
          outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' },
          toolDurationMs: 8,
          finalStopReason: 'ANALYTICAL_COVERAGE_GAP',
        },
      },
    });
    const receipt = bundle.runReceipt.runtimeReceiptV8 as Record<string, unknown>;
    const serialized = JSON.stringify(bundle);
    expect(receipt).toMatchObject({ version: 8, mode: 'authoritative_v2', turnClass: 'analytics' });
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(privateSecret);
    expect(serialized).not.toContain('SELECT * FROM');
    expect((receipt.observations as Array<Record<string, unknown>>)[0]).not.toHaveProperty('rawSql');
    expect((receipt.observations as Array<Record<string, unknown>>)[0]).not.toHaveProperty('rawResponse');
  });

  it('OBS-017 retains an unfrozen V8 controller tier in both the canonical envelope and strict portable receipt', () => {
    const { store, observer } = memoryObserver({ runId: 'run-v8-controller-tier-portable' });
    const receipt = {
      version: 8 as const,
      mode: 'authoritative_v2' as const,
      turnClass: 'analytics' as const,
      snapshotId: 'snapshot:v8-controller-tier',
      retainedCandidateCount: 48,
      initialCandidateCount: 24,
      expansionCount: 1,
      objective: 'analytics' as const,
      contextCoverage: [],
      excludedCandidateCount: 0,
      exclusionReasonCodes: [],
      observations: [],
      tierAttempts: [
        { version: 2 as const, tier: 'semantic' as const, outcome: 'unavailable' as const, reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE', candidateIds: [], frozen: false },
        { version: 2 as const, tier: 'governed_relational' as const, outcome: 'unavailable' as const, reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE', candidateIds: [], frozen: false },
      ],
      // No plan is frozen, but the live controller has already advanced to
      // the only remaining lower-tier action. A stale V1 cascade must not
      // overwrite this value in storage or portable support evidence.
      controllerTier: 'exploratory_sql' as const,
      semanticRuntime: {
        version: 1 as const,
        preference: 'metricflow-cli' as const,
        selectedEngine: 'metricflow-cli' as const,
        readiness: 'unavailable' as const,
      },
      planFrozen: false,
      terminalOutcome: { version: 2 as const, kind: 'gap' as const, reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED', origin: 'agent_control' as const },
      outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' as const },
      activity: { providerDispatches: 5, toolCalls: 5, executionAttempts: 0, repairs: 0 },
      toolDurationMs: 5,
      finalStopReason: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
    };
    const run = {
      id: 'run-v8-controller-tier-portable',
      status: 'blocked',
      trustState: 'blocked',
      completedAt: '2026-08-31T12:00:01.000Z',
      artifacts: [],
      diagnosticReceiptV8: receipt,
    };
    finalizeAgentRunTraceV1(observer, run as never);

    const trace = store.getByRun('run-v8-controller-tier-portable')!;
    expect(trace.envelope.selectedTier).toBe('exploratory_sql');
    const strict = createAskTracePortableBundleV1(trace, {
      profile: 'strict',
      provenance: 'recorded',
      runReceipt: run,
    });
    expect(strict.trace.envelope.selectedTier).toBe('exploratory_sql');
    expect(strict.runReceipt.runtimeReceiptV8).toMatchObject({
      version: 8,
      controllerTier: 'exploratory_sql',
      semanticRuntime: {
        preference: 'metricflow-cli',
        selectedEngine: 'metricflow-cli',
        readiness: 'unavailable',
      },
      planFrozen: false,
    });
  });

  it('requires confirmation and scans support-provided reviewed prose before export', () => {
    const { store, observer } = memoryObserver({ runId: 'run-support' });
    observer.finalize({ status: 'completed' });
    const trace = store.getByRun('run-support')!;
    expect(() => createAskTracePortableBundleV1(trace, { profile: 'support' })).toThrow('confirm-reviewed-identifiers');
    expect(() => createAskTracePortableBundleV1(trace, {
      profile: 'support', confirmReviewedIdentifiers: true, reviewedQuestion: 'SELECT revenue FROM private.customers',
    })).toThrow('redaction failed');
  });

  it('pseudonymizes the issue and preserves directed links in strict export, while validating their references', () => {
    const { directory } = fixtureStore();
    const { store, observer } = memoryObserver({ runId: 'run-linked-export' });
    const failed = observer.startSpan({
      name: 'provider.attempt', stage: 'provider',
      payload: { kind: 'provider', attempt: { version: 1, phase: 'generation', physicalAttemptIndex: 1, cause: 'gateway', safeAction: 'retry_same_provider', provenance: 'recorded' } },
    })!;
    observer.finishSpan(failed, { outcome: 'error', reasonCode: 'provider_failure' });
    observer.recordLink({
      kind: 'prior_result', targetTraceId: 'f'.repeat(32), targetRunId: 'run-prior-result', choiceFingerprint: 'sha256:prior-result',
    });
    observer.finalize({ status: 'failed' });
    const trace = store.getByRun('run-linked-export')!;
    const strict = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' });

    expect(strict.trace.envelope.firstIssueSpanId).not.toBe(failed);
    expect(strict.trace.links[0]).toMatchObject({
      sourceTraceId: strict.trace.envelope.traceId,
      sourceRunId: strict.trace.envelope.runId,
    });
    expect(strict.trace.links[0]?.targetTraceId).not.toBe(strict.trace.envelope.traceId);
    expect(strict.trace.links[0]?.targetRunId).not.toBe(strict.trace.envelope.runId);

    const out = join(directory, 'reference-bundle');
    exportAskTraceBundleV1(trace, { profile: 'strict', outputDirectory: out, provenance: 'recorded' });
    const tracePath = join(out, 'trace.json');
    const manifestPath = join(out, 'manifest.json');
    const tampered = JSON.parse(readFileSync(tracePath, 'utf8')) as AskTraceDataV1;
    // Update the checksum and bundle fingerprint to prove semantic reference
    // validation catches a coherent-but-broken directed link.
    tampered.links[0]!.sourceRunId = 'run_bad_reference';
    const traceJson = `${canonicalJson(tampered)}\n`;
    writeFileSync(tracePath, traceJson, 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { checksums: Record<string, string>; profile: string; traceFingerprint?: string; traceId: string; bundleFingerprint: string };
    manifest.checksums['trace.json'] = sha256(traceJson);
    manifest.bundleFingerprint = fingerprint({ checksums: manifest.checksums, profile: manifest.profile, trace: manifest.traceFingerprint ?? manifest.traceId });
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, 'utf8');

    expect(validateAskTraceBundleV1(out)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('broken source run reference')]),
    });
  });

  it('rejects a tampered bundle and receipt replay performs no external work', () => {
    const { directory } = fixtureStore();
    const { store, observer } = memoryObserver({ runId: 'run-tamper' });
    observer.finalize({ status: 'completed', trustState: 'review_required', selectedTier: 'exploratory_sql' });
    const out = join(directory, 'tampered-bundle');
    exportAskTraceBundleV1(store.getByRun('run-tamper')!, { profile: 'strict', outputDirectory: out, provenance: 'recorded' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(replayAskTraceReceiptV1(out)).toMatchObject({ valid: true, errors: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
      // A checked bundle is immutable: modification must be detected before it
      // can be compared or replayed as evidence.
      const tracePath = join(out, 'trace.json');
      writeFileSync(tracePath, `${readFileSync(tracePath, 'utf8')}\n`, 'utf8');
      expect(validateAskTraceBundleV1(out)).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.stringContaining('Checksum mismatch')]) });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function sqliteAvailable(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'dql-ask-observability-probe-'));
  try {
    const store = new AskTraceSqliteStoreV1({ path: join(directory, 'probe.sqlite') });
    const available = store.status().available;
    store.close();
    return available;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function exploratoryCascadeDecision(planFrozen: boolean, candidateId: string) {
  return {
    version: 1,
    requirements: {
      version: 1,
      measures: ['revenue'],
      dimensions: ['channel'],
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      memberTerms: [],
    },
    sourceCoverage: [
      { source: 'certified', status: 'available', candidateIds: [] },
      { source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] },
      { source: 'dbt_manifest', status: 'available', candidateIds: [candidateId] },
    ],
    attempts: [
      { version: 1, tier: 'certified', outcome: 'ineligible', candidateIds: [], reason: 'No complete certified tuple.', planFrozen: false },
      { version: 1, tier: 'semantic', outcome: 'ineligible', candidateIds: ['semantic:metric:revenue'], reason: 'No complete semantic tuple.', planFrozen: false },
      { version: 1, tier: 'governed_relational', outcome: 'ineligible', candidateIds: [], reason: 'No complete governed relational tuple.', planFrozen: false },
      { version: 1, tier: 'exploratory_sql', outcome: 'executable', candidateIds: [candidateId], reason: 'Qualified physical plan is review required.', planFrozen },
    ],
    selectedTier: 'exploratory_sql',
    planFrozen,
    stopReason: 'selected',
  } as const;
}

function makeEnvelope(traceId: string, runId: string): AskTraceEnvelopeV1 {
  return {
    version: 1,
    traceId,
    rootSpanId: '1111111111111111',
    runId,
    surface: 'cli',
    mode: 'ask',
    questionFingerprint: 'sha256:fixture',
    status: 'running',
    recordingStatus: 'recording',
    startedAt: '2026-08-22T12:00:00.000Z',
    spanCount: 0,
    candidateDecisionCount: 0,
    droppedRecordCount: 0,
  };
}

function makeStoreSpan(traceId: string, spanId: string, ordinal: number): AskTraceSpanV1 {
  return {
    version: 1,
    traceId,
    spanId,
    ordinal,
    name: 'tool.call',
    stage: 'tool',
    startedAt: '2026-08-22T12:00:00.000Z',
    outcome: 'ok',
    reasonCode: 'started',
    payload: {
      kind: 'tool',
      call: { version: 1, toolCallId: `tool-${ordinal}`, toolKind: 'search_metadata', attemptIndex: ordinal },
    },
  };
}

describe('the Ask pipeline receipt names the envelope tier', () => {
  it('a pipeline run indexes the tier its receipt executed, mapped onto the cascade vocabulary', () => {
    const { store, observer } = memoryObserver({ runId: 'run-v9-tier' });
    finalizeAgentRunTraceV1(observer, {
      status: 'completed',
      trustState: 'governed',
      completedAt: '2026-09-05T12:00:01.000Z',
      askAgentRuntimeMode: 'pipeline_v3',
      diagnosticReceiptV9: {
        version: 1, vocabularyFingerprint: 'v', dispatches: [{ purpose: 'resolve', ms: 800 }], candidates: [], refusals: [], tiers: [],
        executed: { tier: 'relational', sqlFingerprint: 'f', rowCount: 2, ms: 9, proofs: [] }, timings: {},
      },
    } as never);
    expect(store.getByRun('run-v9-tier')!.envelope.selectedTier).toBe('governed_relational');
  });
});
