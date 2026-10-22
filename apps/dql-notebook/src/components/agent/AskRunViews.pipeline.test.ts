import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AskTraceDataV1 } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import type * as PanelModule from './UnifiedAgentRunPanel';
import type * as TracePageModule from './AskTracePage';

let panel: typeof PanelModule;
let tracePage: typeof TracePageModule;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/ask/traces/run-v9' } });
  panel = await import('./UnifiedAgentRunPanel');
  tracePage = await import('./AskTracePage');
});

const v9 = {
  version: 1, candidates: [], story: [], dispatches: [{ purpose: 'intent:resolve', ms: 9_000, label: 'read' }],
  tiers: [{ round: 0, tier: 'certified', outcome: 'skipped' }, { round: 0, tier: 'semantic', outcome: 'prepared' }],
  refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block' }],
  executed: { tier: 'semantic', rowCount: 12, ms: 300, proofs: [] },
  timings: { total: 11_000 },
};

describe('Ask pipeline runs in the inspector', () => {
  it('a pipeline run gets How it answered, DQL, SQL, Data used and Checks; older runs keep their tabs', () => {
    expect(panel.askInspectorTabsForState({ analytical: false, blocked: false, hasDql: true, hasSql: true, hasLineage: true, pipeline: true, hasChecks: true }).map((tab) => tab.id))
      .toEqual(['how', 'dql', 'sql', 'data', 'checks']);
    expect(panel.askInspectorTabsForState({ analytical: false, blocked: true, hasDql: false, hasSql: false, hasLineage: false, pipeline: true, hasChecks: false }).map((tab) => tab.id))
      .toEqual(['how', 'data']);
    expect(panel.askInspectorTabsForState({ analytical: false, blocked: false, hasDql: true, hasSql: true, hasLineage: false }).map((tab) => tab.id))
      .toEqual(['dql', 'sql', 'trust']);
  });

  it('opens on How it answered for answered and gap runs carrying the pipeline record', () => {
    const answered = { id: 'a', diagnosticReceiptV9: v9, artifacts: [{ id: 'x', kind: 'answer', title: 'x', trustState: 'governed', payload: { sql: 'SELECT 1' } }] };
    expect(panel.preferredAskInspectorTab(answered as never, answered.artifacts[0] as never)).toBe('how');
    const gap = { id: 'g', artifacts: [{ id: 'y', kind: 'answer', title: 'No answer', trustState: 'blocked', payload: { kind: 'no_answer', askPipeline: v9 } }] };
    expect(panel.hasAskPipelineReceipt(gap as never)).toBe(true);
    expect(panel.preferredAskInspectorTab(gap as never, gap.artifacts[0] as never)).toBe('how');
    expect(panel.hasAskPipelineReceipt({ diagnosticReceiptV9: { mode: 'authoritative_v2' }, artifacts: [] } as never)).toBe(false);
  });
});

describe('Ask pipeline runs on the trace page', () => {
  const trace = (overrides: Partial<AskTraceDataV1> = {}): AskTraceDataV1 => ({
    envelope: {
      version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-v9', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:q',
      status: 'completed', recordingStatus: 'complete', startedAt: '2026-09-12T10:00:00.000Z', spanCount: 1, candidateDecisionCount: 0, droppedRecordCount: 0,
    },
    spans: [], candidateDecisions: [], links: [],
    ...overrides,
  } as AskTraceDataV1);

  it('tells the run as a headline and numbered steps instead of the older summaries', () => {
    const markup = renderToStaticMarkup(createElement(tracePage.TraceDecisionStory, { trace: trace({ runtimeReceiptV9: v9, runtimeAnswerV1: { status: 'completed', sql: 'SELECT 1' } }), t: themes.paper, onSelectSpan: () => undefined }));
    expect(markup).toContain('Answered from the semantic layer.');
    expect(markup).toContain('Certified saved queries');
    expect(markup).toContain('No certified saved query matches this question.');
    expect(markup).not.toContain('Canonical decision summary unavailable');
  });

  it('shows a recorded object as indented JSON, cut when long, instead of a field count', () => {
    expect(tracePage.traceValueDisplay({ tier: 'semantic', rows: 2 })).toBe('{\n  "tier": "semantic",\n  "rows": 2\n}');
    expect(tracePage.traceValueDisplay([])).toBe('None');
    const long = tracePage.traceValueDisplay({ text: 'x'.repeat(3_000) });
    expect(long).toMatch(/\n… \d+ more characters$/);
    expect(long.length).toBeLessThan(2_100);
  });
});
