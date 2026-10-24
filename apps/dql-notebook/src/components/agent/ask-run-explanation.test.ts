import { describe, expect, it } from 'vitest';
import { REFUSAL_SENTENCES, containsInternalCode, explainAskRun, isAskPipelineReceipt, plainReason, plainRefs, rowCountWords, type RunExplanation } from './ask-run-explanation';

const base = (overrides: Record<string, unknown>) => ({ version: 1, dispatches: [], tiers: [], candidates: [], refusals: [], story: [], timings: {}, ...overrides });

const semanticAnswer = base({
  reading: 'Total ignored usage for Capital One by day.',
  intent: { kind: 'analytics', reading: 'Total ignored usage for Capital One by day.', unresolved: [] },
  dispatches: [{ purpose: 'intent:resolve', ms: 24_100, reply: '{"version":1}', label: 'read', attempt: 1, at: 1 }],
  tiers: [
    { round: 0, tier: 'certified', outcome: 'skipped', detail: 'no_certified_block: the project has no certified block' },
    { round: 0, tier: 'semantic', outcome: 'prepared' },
  ],
  refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block' }],
  executed: { tier: 'semantic', rowCount: 30, ms: 400, proofs: [] },
  timings: { resolve: 24_100, prepare: 900, execute: 400, total: 26_000, context: 800 },
  context: { used: { relations: ['usage.daily_facts'], joins: [], tier: 'semantic' } },
  warehouse: { attempts: 1, failures: 0, executions: 1 },
});

const aiAnswer = base({
  reading: 'Lost opportunities to Splunk in FY26.',
  intent: { kind: 'analytics', reading: 'Lost opportunities to Splunk in FY26.', unresolved: [] },
  dispatches: [
    { purpose: 'intent:resolve', ms: 14_000, reply: '{}', label: 'read', attempt: 1, at: 1 },
    { purpose: 'intent:draft', ms: 5_000, reply: 'SELECT COUNT(*) FROM sales.opportunities', label: 'draft', attempt: 1, outcome: 'sql', at: 2 },
    { purpose: 'intent:draft', ms: 4_000, reply: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'", label: 'fix', attempt: 2, outcome: 'sql', at: 3 },
  ],
  tiers: [{ round: 97, tier: 'exploratory', outcome: 'prepared', detail: 'schema lane' }],
  checks: [
    { id: 'stated_values', label: 'Applies every value the question states', passed: false, message: 'it does not apply "Splunk" from the question', attempt: 1 },
    { id: 'stated_values', label: 'Applies every value the question states', passed: true, message: 'applies Splunk', attempt: 2 },
    { id: 'join_fanout', label: 'Joins do not count rows more than once', passed: true, message: 'no join multiplies the rows it totals', attempt: 2 },
  ],
  story: [{ phase: 'schema', title: 'Drafted SQL over sales.opportunities', state: 'done', detail: 'SELECT …', at: 2 }],
  executed: { tier: 'exploratory', rowCount: 1, ms: 120, proofs: ["applied on the data: competitor = 'Splunk'"] },
  timings: { resolve: 14_000, schema_draft: 9_000, total: 24_000 },
  context: { used: { relations: ['sales.opportunities'], joins: [] } },
  warehouse: { attempts: 1, failures: 0, executions: 1 },
});

const declinedGap = base({
  reading: 'Churn by region.',
  intent: { kind: 'analytics', reading: 'Churn by region.', unresolved: [] },
  dispatches: [{ purpose: 'intent:resolve', ms: 9_000, label: 'read', attempt: 1 }, { purpose: 'intent:draft', ms: 3_000, reply: 'NO_SQL: nothing records churn', label: 'draft', attempt: 1, outcome: 'declined' }],
  tiers: [{ round: 97, tier: 'exploratory', outcome: 'refused', detail: 'exploration_declined: nothing records churn' }],
  refusals: [{ tier: 'exploratory', code: 'exploration_declined', message: 'these tables hold orders only; nothing records churn or region' }],
  timings: { resolve: 9_000, total: 12_000 },
});

const readingFailure = base({
  dispatches: [],
  failure: { stage: 'resolve', reason: 'provider_timeout', message: 'the AI model took too long to read the question; retry the same question' },
});

const warehouseFailure = base({
  reading: 'Revenue by month.',
  intent: { kind: 'analytics', reading: 'Revenue by month.', unresolved: [] },
  dispatches: [{ purpose: 'intent:resolve', ms: 8_000 }],
  tiers: [{ round: 0, tier: 'semantic', outcome: 'prepared' }],
  failure: { stage: 'execute', reason: 'execution_failed', message: "Warehouse 'COMPUTE_WH' is suspended", warehouse: { class: 'warehouse_suspended' } },
  warehouse: { attempts: 1, failures: 1, executions: 0 },
});

const allText = (explanation: RunExplanation) => [explanation.headline, ...explanation.steps.flatMap((step) => [step.title, step.reason, ...step.notes, ...step.checks.map((check) => check.message), ...step.aiCalls.map((call) => call.label)])];

describe('how an Ask run was answered, as steps in plain words', () => {
  it('a semantic answer: read, certified skipped with its reason, semantic compiled, warehouse rows, answered from the semantic layer', () => {
    const explanation = explainAskRun({ receipt: semanticAnswer, payload: { kind: 'uncertified' }, status: 'completed' })!;
    expect(explanation.ending).toBe('answered');
    expect(explanation.steps.map((step) => [step.kind, step.outcome])).toEqual([
      ['read', 'done'], ['certified', 'skipped'], ['semantic', 'done'], ['warehouse', 'done'], ['answer', 'done'],
    ]);
    expect(explanation.steps[1]!.reason).toBe('No certified saved query matches this question.');
    expect(explanation.steps[3]!.reason).toBe('30 rows.');
    expect(explanation.headline).toBe('Answered from the semantic layer.');
    expect(explanation.totalMs).toBe(26_800);
    expect(explanation.dataUsed.tables).toEqual(['usage.daily_facts']);
  });

  it('an AI-SQL answer: governed tiers not needed, two drafting calls, a check that failed and was fixed, and the filters it applied', () => {
    const explanation = explainAskRun({ receipt: aiAnswer, payload: { kind: 'uncertified', sql: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'", proof: [] }, status: 'completed' })!;
    expect(explanation.steps.map((step) => [step.kind, step.outcome])).toEqual([
      ['read', 'done'], ['semantic', 'skipped'], ['ai_sql', 'done'], ['checks', 'done'], ['warehouse', 'done'], ['answer', 'done'],
    ]);
    const ai = explanation.steps.find((step) => step.kind === 'ai_sql')!;
    expect(ai.aiCalls.map((call) => call.label)).toEqual(['Drafted SQL', 'Fixed a failed check']);
    expect(ai.reason).toBe('Wrote one read-only statement over sales.opportunities, redrafted once.');
    expect(ai.sql).toContain("competitor = 'Splunk'");
    expect(explanation.steps.find((step) => step.kind === 'checks')!.reason).toBe('All checks passed after 1 failed check was fixed.');
    expect(explanation.dataUsed.filters).toEqual(["competitor = 'Splunk'"]);
    expect(explanation.headline).toBe('Answered from SQL written by AI from the tables (review before relying on it).');
  });

  it('the result check sits among the drafting calls and is not counted as a redraft', () => {
    const reviewed = base({
      ...aiAnswer,
      dispatches: [
        { purpose: 'intent:resolve', ms: 14_000, reply: '{}', label: 'read', attempt: 1, at: 1 },
        { purpose: 'intent:draft', ms: 5_000, reply: 'SELECT COUNT(*) FROM sales.opportunities', label: 'draft', attempt: 1, outcome: 'sql', at: 2 },
        { purpose: 'intent:review', ms: 2_000, reply: '{"answers": false, "problem": "it does not keep Splunk"}', label: 'review', attempt: 2, outcome: 'revise', at: 3 },
        { purpose: 'intent:draft', ms: 4_000, reply: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'", label: 'revise', attempt: 3, outcome: 'sql', at: 4 },
      ],
    });
    const ai = explainAskRun({ receipt: reviewed, payload: { kind: 'uncertified', sql: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'", proof: [] }, status: 'completed' })!.steps.find((step) => step.kind === 'ai_sql')!;
    expect(ai.aiCalls.map((call) => [call.label, call.outcome])).toEqual([['Drafted SQL', 'sql'], ['Checked the result against the question', 'revise'], ['Revised the SQL after the result check', 'sql']]);
    expect(ai.reason).toBe('Wrote one read-only statement over sales.opportunities, redrafted once.');
  });

  it('a declined gap says the AI looked and found nothing, and that nothing ran', () => {
    const explanation = explainAskRun({ receipt: declinedGap, payload: { kind: 'no_answer', gap: { kind: 'not_modeled', message: 'these tables hold orders only; nothing records churn or region' } }, status: 'blocked' })!;
    expect(explanation.ending).toBe('gap');
    expect(explanation.steps.map((step) => [step.kind, step.outcome])).toEqual([
      ['read', 'done'], ['semantic', 'skipped'], ['ai_sql', 'refused'], ['warehouse', 'not_reached'], ['gap', 'refused'],
    ]);
    expect(explanation.steps[2]!.reason).toBe('The AI looked at the tables and found nothing that answers this: these tables hold orders only; nothing records churn or region.');
    expect(explanation.steps[2]!.aiCalls[0]!.outcome).toBe('declined');
  });

  it('a long gap reads short in the headline, names tables without quotes, and lists what was searched once', () => {
    const message = 'There is no sales region dimension or churn definition (e.g., customer status/inactivity flag) in any listed relation (searched "jaffle_shop"."dev"."orders", "jaffle_shop"."raw"."raw_customers"). Ask for a modeled measure instead.';
    const explanation = explainAskRun({
      receipt: { ...declinedGap, refusals: [{ tier: 'exploratory', code: 'exploration_declined', message }] },
      payload: { gap: { kind: 'not_modeled', message } },
      status: 'blocked',
    })!;
    expect(explanation.headline).toBe('No answer: There is no sales region dimension or churn definition (e.g., customer status/inactivity flag) in any listed relation.');
    expect(explanation.steps.find((step) => step.kind === 'ai_sql')!.reason).toContain('(searched jaffle_shop.dev.orders, jaffle_shop.raw.raw_customers)');
    expect(explanation.steps.find((step) => step.kind === 'gap')!.reason).not.toContain('searched');
    for (const step of explanation.steps) expect(step.reason).not.toContain('"jaffle_shop"');
  });

  it('a reading failure stops at the first step, and a warehouse failure names the warehouse', () => {
    const read = explainAskRun({ receipt: readingFailure, payload: { kind: 'no_answer', executionError: 'the AI model took too long', failedStage: 'resolve' }, status: 'blocked' })!;
    expect(read.ending).toBe('failed');
    expect(read.steps[0]!.outcome).toBe('failed');
    expect(read.headline).toMatch(/^Stopped while reading the question/);
    const warehouse = explainAskRun({ receipt: warehouseFailure, payload: { kind: 'no_answer', executionError: 'suspended', failedStage: 'execute' }, status: 'blocked' })!;
    expect(warehouse.steps.find((step) => step.kind === 'warehouse')).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/^The warehouse is not running\./) });
    expect(warehouse.headline).toMatch(/^Stopped while running on the warehouse/);
  });

  it('a conversation is one step; a run the pipeline did not write is not explained here', () => {
    const chat = explainAskRun({ receipt: base({ intent: { kind: 'conversation', reading: 'A greeting.' } }), status: 'completed' })!;
    expect(chat.steps).toHaveLength(1);
    expect(chat.ending).toBe('conversation');
    expect(explainAskRun({ receipt: { mode: 'authoritative_v2', tierAttempts: [] } })).toBeUndefined();
    expect(isAskPipelineReceipt(undefined)).toBe(false);
  });

  it('data used lists the tables the answer read, never every table the question could have read', () => {
    const certified = explainAskRun({
      receipt: { ...semanticAnswer, executed: { tier: 'certified', rowCount: 12, ms: 8, proofs: [] }, context: { used: { relations: [], joins: [] } }, physicalBindings: [{ relation: '"jaffle_shop"."dev"."customers"', completeness: 'complete', columns: 7 }, { relation: '"jaffle_shop"."dev"."orders"', completeness: 'complete', columns: 9 }] },
      payload: { certifiedBlockRef: 'block:monthly_revenue' },
      status: 'completed',
    })!;
    expect(certified.dataUsed.tables).toEqual([]);
    expect(certified.dataUsed.certifiedBlock).toBe('monthly revenue');
    const quoted = explainAskRun({ receipt: { ...aiAnswer, context: { used: { relations: ['"jaffle_shop"."dev"."orders"'], joins: [] } } }, payload: {}, status: 'completed' })!;
    expect(quoted.dataUsed.tables).toEqual(['jaffle_shop.dev.orders']);
  });

  it('a question that named a retired block says it was answered from the replacement, on the certified step', () => {
    const retired = base({
      reading: 'Paid claims.',
      intent: { kind: 'analytics', reading: 'Paid claims.', unresolved: [] },
      tiers: [{ round: 0, tier: 'certified', outcome: 'prepared' }],
      executed: { tier: 'certified', rowCount: 1, ms: 5, proofs: [] },
      story: [
        { version: 1, phase: 'tier', title: 'Certified blocks: prepared an answer', state: 'done', at: 1 },
        { version: 1, phase: 'tier', title: 'Claims Summary was retired on 2026-09-30; answered from Claims Dataset', state: 'done', at: 2 },
      ],
    });
    const explanation = explainAskRun({ receipt: retired, payload: { certifiedBlockRef: 'block:claims.Claims Dataset' }, status: 'completed' })!;
    const certified = explanation.steps.find((step) => step.id === 'tier-certified')!;
    expect(certified.outcome).toBe('done');
    expect(certified.notes).toContain('Claims Summary was retired on 2026-09-30; answered from Claims Dataset.');
  });

  it('an older pipeline receipt without recorded checks still shows the checks its story holds', () => {
    const older = { ...aiAnswer, checks: undefined, story: [...(aiAnswer.story as unknown[]), { phase: 'schema', title: 'Checked the drafted SQL', state: 'done', detail: 'applies Splunk', at: 4 }] };
    const explanation = explainAskRun({ receipt: older, payload: {}, status: 'completed' })!;
    expect(explanation.steps.find((step) => step.kind === 'checks')!.checks).toEqual([{ label: 'Checked the drafted SQL', passed: true, message: 'applies Splunk' }]);
  });

  it('no step, reason or label carries an internal code, and every refusal code has a sentence', () => {
    for (const [receipt, payload, status] of [[semanticAnswer, { kind: 'uncertified' }, 'completed'], [aiAnswer, { kind: 'uncertified' }, 'completed'], [declinedGap, { gap: { message: 'x' } }, 'blocked'], [warehouseFailure, { failedStage: 'execute' }, 'blocked']] as const) {
      const explanation = explainAskRun({ receipt, payload: payload as Record<string, unknown>, status })!;
      for (const text of allText(explanation)) expect(containsInternalCode(text), text).toBe(false);
    }
    for (const code of ['no_certified_block', 'exploration_not_opted_in', 'semantic_compile_failed', 'exploration_declined', 'execution_failed']) expect(REFUSAL_SENTENCES[code]).toBeTruthy();
    expect(plainRefs('metric:orders.total_revenue by dimension:orders.region sha256:abc123')).toBe('total revenue by region');
    expect(plainReason('semantic_compile_failed', 'the native semantic engine could not compose metrics revenue')).toBe('The semantic engine could not compile this question: the native semantic engine could not compose metrics revenue.');
  });
});

describe('a trace read by someone other than the asker (values withheld)', () => {
  // The shape the server sends a steward reviewing hints (apps/cli host/trace-review.ts): no reading, no AI replies,
  // check labels without messages, story steps titled by their phase, no proofs, the SQL masked.
  const withheld = base({
    intent: { kind: 'analytics', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:sales.opportunities.competitor', op: 'eq' }] },
    dispatches: [
      { purpose: 'intent:resolve', ms: 14_000, label: 'read', attempt: 1, at: 1 },
      { purpose: 'intent:draft', ms: 5_000, label: 'draft', attempt: 1, outcome: 'sql', at: 2 },
      { purpose: 'intent:draft', ms: 4_000, label: 'fix', attempt: 2, outcome: 'sql', at: 3 },
    ],
    tiers: [{ round: 97, tier: 'exploratory', outcome: 'prepared' }],
    checks: [
      { id: 'stated_values', label: 'Applies every value the question states', passed: false, attempt: 1 },
      { id: 'stated_values', label: 'Applies every value the question states', passed: true, attempt: 2 },
    ],
    story: [{ phase: 'schema', title: 'Wrote SQL from the tables', state: 'done', at: 2 }],
    executed: { tier: 'exploratory', rowCountBucket: '2-10', ms: 120, proofs: [] },
    timings: { resolve: 14_000, schema_draft: 9_000, total: 24_000 },
    context: { used: { relations: ['sales.opportunities'], joins: [] } },
    warehouse: { attempts: 1, failures: 0, executions: 1 },
  });

  it('still explains every step, with the check labels standing in for their messages', () => {
    const explanation = explainAskRun({ receipt: withheld, payload: { sql: "SELECT COUNT(*) AS column_1 FROM sales.opportunities WHERE competitor = '?'", sqlLiteralsMasked: true, rowCountBucket: '2-10', columns: ['column_1'] }, status: 'completed' }) as RunExplanation;
    expect(explanation.ending).toBe('answered');
    expect(explanation.steps.map((step) => step.kind)).toEqual(['read', 'semantic', 'ai_sql', 'checks', 'warehouse', 'answer']);
    expect(explanation.aiCalls.every((call) => call.reply === undefined)).toBe(true);
    expect(explanation.steps.find((step) => step.kind === 'checks')!.reason).toBe('All checks passed after 1 failed check was fixed.');
    expect(explanation.steps.find((step) => step.kind === 'ai_sql')!.sql).toContain("'?'");
    expect(explanation.dataUsed.tables).toEqual(['sales.opportunities']);
    // A row-count range, not the count.
    expect(explanation.steps.find((step) => step.kind === 'warehouse')!.reason).toBe('About 2-10 rows.');
    expect(rowCountWords('none')).toBe('No rows');
    expect(rowCountWords('1')).toBe('1 row');
  });
});
