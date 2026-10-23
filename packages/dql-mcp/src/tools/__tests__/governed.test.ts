import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DQLContext } from '../../context.js';
import { answerQuestion, buildBlockFromPrompt } from '../governed.js';
import { __test__ } from '../../server.js';

function ctxStub(): DQLContext {
  return { projectRoot: '/tmp/proj', refresh: () => {} } as unknown as DQLContext;
}

function mockFetchOnce(status: number, json: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  })) as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('answerQuestion (governed answer via runtime proxy)', () => {
  it('a Research run carries its investigation, compact: headline, drivers with shares, ruled out, caveats, confidence', async () => {
    mockFetchOnce(201, {
      run: {
        question: 'Why did revenue drop in August 2025?', route: 'research', status: 'needs_review', trustState: 'review_required',
        answer: 'Revenue fell 150.00 (15.0%) in August 2025 compared with July 2025.',
        artifacts: [{
          kind: 'research_run', trustState: 'review_required',
          payload: {
            kind: 'investigation',
            investigation: {
              headline: { text: 'Revenue fell 150.00 (15.0%) in August 2025 compared with July 2025.', verdict: 'change' },
              drivers: [{ path: [{ dimension: { label: 'Category' }, member: { label: 'beverage' } }], prior: { value: '300' }, current: { value: '150' }, share: '1', verdict: 'supported', queries: [{ rows: [] }] }],
              ruledOut: [{ dimension: { label: 'Location' } }],
              notInvestigated: [{ dimension: { label: 'Brand' }, reason: 'budget' }],
              caveats: [{ code: 'partial_period', text: 'The data runs only through 2025-08-20.' }],
              confidence: { level: 'medium', reasons: ['the current period is not complete'] },
            },
          },
        }],
        nextActions: [],
      },
    });
    const out = await answerQuestion(ctxStub(), { question: 'Why did revenue drop in August 2025?', requestedMode: 'research' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out as { investigation?: unknown }).investigation).toEqual({
      headline: 'Revenue fell 150.00 (15.0%) in August 2025 compared with July 2025.',
      verdict: 'change',
      drivers: [{ path: 'Category: beverage', prior: '300', current: '150', share: '1', verdict: 'supported' }],
      ruledOut: ['Location'],
      notInvestigated: [{ dimension: 'Brand', reason: 'budget' }],
      caveats: ['The data runs only through 2025-08-20.'],
      confidence: { level: 'medium', reasons: ['the current period is not complete'] },
    });
  });

  it('maps a governed AgentRun into a compact result with sql/rows/trust/dqlArtifact', async () => {
    mockFetchOnce(201, {
      run: {
        question: 'top customers by revenue',
        route: 'generated_answer',
        status: 'needs_review',
        trustState: 'review_required',
        answerKind: 'governed',
        answer: 'Top customers by revenue.',
        summary: 'Review-required answer',
        artifacts: [{
          kind: 'answer',
          trustState: 'review_required',
          payload: {
            proposedSql: 'SELECT customer_name, revenue FROM analytics.customers',
            result: { columns: ['customer_name', 'revenue'], rows: [{ customer_name: 'A', revenue: 10 }], rowCount: 1 },
            dqlArtifact: { kind: 'sql_block', name: 'top_customers', source: 'block "..."' },
            citations: [{ name: 'customers' }],
          },
        }],
        nextActions: [],
      },
    });
    const out = await answerQuestion(ctxStub(), { question: 'top customers by revenue' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.trustState).toBe('review_required');
    expect(out.sql).toContain('analytics.customers');
    expect(out.rowCount).toBe(1);
    expect(out.dqlArtifact).toMatchObject({ kind: 'sql_block', name: 'top_customers' });
    expect(out.trustNote).toMatch(/verbatim/i);
  });

  it('returns a crisp runtime-unavailable result when the runtime is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    const out = await answerQuestion(ctxStub(), { question: 'q' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out as { runtimeUnavailable?: boolean }).runtimeUnavailable).toBe(true);
    expect(out.error).toMatch(/zlens notebook/);
  });

  it('turns a run blocked for lack of an AI model into a clear error that points at the bring-your-own-SQL path', async () => {
    mockFetchOnce(201, {
      run: {
        question: 'How has revenue changed by month?',
        route: 'generated_answer',
        status: 'blocked',
        trustState: 'blocked',
        answer: 'No AI model is configured for this project, so the question could not be interpreted.',
        artifacts: [{
          kind: 'answer',
          trustState: 'blocked',
          payload: { kind: 'no_answer', diagnosticReceipt: { failure: { code: 'EXECUTION_BLOCKED', safeActions: ['retry-after-provider'] } } },
        }],
      },
    });
    const out = await answerQuestion(ctxStub(), { question: 'How has revenue changed by month?' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out as { modelUnavailable?: boolean }).modelUnavailable).toBe(true);
    expect(out.error).toMatch(/no AI model/);
    expect(out.error).toMatch(/ask_dql/);
    expect(out.error).toMatch(/query_via_metadata/);
    // Structured, so a client that skims past the prose still sees where to go.
    expect(out).toMatchObject({ nextTool: 'ask_dql', nextArgs: { question: 'How has revenue changed by month?' } });
  });

  it('rejects an empty question without calling the runtime', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    const out = await answerQuestion(ctxStub(), { question: '  ' });
    expect(out.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('buildBlockFromPrompt (governed NL→block via runtime proxy)', () => {
  it('maps a BuildFromPromptResult into a draft result with a certify promote command', async () => {
    mockFetchOnce(200, {
      status: 'needs_review',
      route: { tier: 'generated_sql', label: 'Generated' },
      draftBlock: { path: 'blocks/_drafts/weekly_revenue_by_region.dql', slug: 'weekly_revenue_by_region', name: 'weekly_revenue_by_region', status: 'draft', askedTimes: 1 },
      dqlArtifact: { kind: 'sql_block', name: 'weekly_revenue_by_region', source: 'block "..."' },
      verdict: { status: 'draft', strikes: [] },
      citations: [],
    });
    const out = await buildBlockFromPrompt(ctxStub(), { prompt: 'weekly revenue by region' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draftBlockPath).toBe('blocks/_drafts/weekly_revenue_by_region.dql');
    expect(out.promote).toContain('zlens certify --from-draft');
    expect(out.trustNote).toMatch(/never present it as certified/i);
  });

  it('maps the runtime\'s real BuildBlockResult (path, sqlPreview, certifierVerdict) instead of dropping it', async () => {
    mockFetchOnce(200, {
      target: 'block',
      path: 'blocks/_drafts/weekly_order_count.dql',
      name: 'weekly_order_count',
      sqlPreview: 'SELECT date_trunc(\'week\', ordered_at) AS week, count(*) AS orders FROM dev.orders GROUP BY 1',
      description: 'Weekly order count.',
      grain: 'one row per week',
      outputs: ['week', 'orders'],
      certifierVerdict: { blocking: ['No test results available'], warnings: [], ready: false },
      reflection: { ready: false, remainingBlocking: ['All tests pass: No test results available'], remainingWarnings: [] },
      route: { tier: 'generated_sql', label: 'Drafted new block weekly_order_count' },
      generation: 'model',
    });
    const out = await buildBlockFromPrompt(ctxStub(), { prompt: 'weekly order count' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draftBlockPath).toBe('blocks/_drafts/weekly_order_count.dql');
    expect(out.sql).toContain('dev.orders');
    expect(out.verdict).toMatchObject({ ready: false });
    expect(out.trustLabel).toBe('AI-Generated');
    expect(out.promote).toBe('zlens certify --from-draft blocks/_drafts/weekly_order_count.dql');
  });

  it('says so when no AI model built it (the offline starter template is not built from the prompt)', async () => {
    mockFetchOnce(200, {
      target: 'block',
      path: 'blocks/_drafts/revenue_by_store.dql',
      name: 'revenue_by_store',
      sqlPreview: 'SELECT 1 AS placeholder',
      certifierVerdict: { blocking: [], warnings: [], ready: false },
      generation: 'offline_template',
    });
    const out = await buildBlockFromPrompt(ctxStub(), { prompt: 'revenue by store' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out as { modelUnavailable?: boolean }).modelUnavailable).toBe(true);
    expect(out.error).toMatch(/could not build this block from your description/);
    expect(out.error).toMatch(/suggest_block/);
    expect(out.error).toContain('blocks/_drafts/revenue_by_store.dql');
  });

  it('rejects edit mode without a blockPath', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    const out = await buildBlockFromPrompt(ctxStub(), { prompt: 'fix it', mode: 'edit' });
    expect(out.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('governed tools are wired end-to-end through the MCP server registration', () => {
  it('dispatches answer_question via the agentic registration → handler → runtime proxy', async () => {
    mockFetchOnce(201, {
      run: {
        question: 'q',
        route: 'certified_answer',
        status: 'completed',
        trustState: 'certified',
        answer: 'Answered from a certified block.',
        artifacts: [{ kind: 'answer', trustState: 'certified', payload: { result: { rowCount: 1 } } }],
      },
    });
    const registrations = __test__.buildMcpToolRegistrations(ctxStub());
    const reg = registrations.find((t) => t.name === 'answer_question');
    expect(reg).toBeDefined();
    const out = (await reg!.run({ question: 'q' })) as { ok: boolean; trustState?: string };
    expect(out.ok).toBe(true);
    expect(out.trustState).toBe('certified');
  });
});
