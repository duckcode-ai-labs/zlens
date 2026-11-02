import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { readByOwnWords } from './lexical-reading.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

/**
 * Sandbox gate W1b: "Claims filed by region" came back Governed one run and
 * "AI-generated answer" the next, because the live model chose the route. A
 * question that is only a governed metric and dimensions, by their own words,
 * is read without the model and answered through the semantic tier.
 */
const harbor: VocabularySource = {
  metrics: [
    { name: 'claim_count', model: 'claims', label: 'Claims filed', aliases: ['claims submitted'], aggregation: 'count' },
    { name: 'paid_amount', model: 'claims', label: 'Paid amount', aggregation: 'sum' },
    { name: 'policy_count', model: 'policies', label: 'Policies in force', aggregation: 'count' },
  ],
  dimensions: [
    { name: 'region', model: 'claims', label: 'Region', aliases: ['territory'], dataType: 'string' },
    { name: 'claim_status', model: 'claims', label: 'Claim status', dataType: 'string' },
    { name: 'channel', model: 'policies', label: 'Channel', dataType: 'string' },
    { name: 'filed_at', model: 'claims', label: 'Filed at', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
  blocks: [{
    name: 'open_claims_by_adjuster', domain: 'claims', certified: true, description: 'Open claims per adjuster.',
    contract: extractBlockContract({ name: 'open_claims_by_adjuster', domain: 'claims', sql: 'SELECT adjuster, COUNT(*) AS open_claims FROM claims GROUP BY adjuster', declaredOutputs: ['adjuster', 'open_claims'] }),
  }],
  relations: [{ schema: 'main', name: 'claims', columns: [{ name: 'region', dataType: 'VARCHAR' }, { name: 'claim_id', dataType: 'VARCHAR' }] }],
};
const vocabulary = buildVocabularyIndex(harbor);

const GENERATED_SQL = 'SELECT region, COUNT(*) AS claims FROM main.claims GROUP BY region';
/** A model that, asked to read the question, names the raw table instead of the semantic layer. */
function wandering(): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  const column = vocabulary.entries.find((entry) => entry.kind === 'column' && entry.ref.endsWith('region'));
  const reply = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Count claims per region from the claims table', measures: [{ ref: column?.ref ?? 'column:main.claims.claim_id', aggregation: 'count' }],
    groupBy: [{ ref: column?.ref ?? 'column:main.claims.region', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
  });
  return { name: 'ollama', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return reply; } };
}

const ask = (question: string, provider: AgentProvider, extra: Record<string, unknown> = {}) => runAskPipeline({
  question, vocabulary, provider, explorationAuto: true, clauseCoverage: false,
  prepareDeps: {
    compileSemantic: async () => ({ sql: 'SELECT region, COUNT(*) AS claim_count FROM main.claims GROUP BY region', engine: 'native' }),
    draftSql: async () => ({ sql: GENERATED_SQL, relations: ['main.claims'], proof: [] }),
  },
  executeDeps: { run: async () => ({ columns: ['region', 'claim_count'], rows: [{ region: 'West', claim_count: 3 }], rowCount: 1, executionTimeMs: 1 }) },
  ...extra,
});

describe('a question that is only a governed metric and dimensions is read by its own words', () => {
  it.each([
    ['Claims filed by region'],
    ['claims filed by territory'],
    ['Show me claims submitted by region?'],
    ['What are the Claims filed for each Region'],
  ])('%s is a governed semantic answer, whatever the model answers, every time', async (question) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const provider = wandering();
      const outcome = await ask(question, provider);
      expect(outcome.kind).toBe('answered');
      if (outcome.kind !== 'answered') return;
      expect(outcome.candidate.tier).toBe('semantic');
      expect(outcome.candidate.trust).toBe('governed');
      expect(outcome.intent.measures.map((measure) => measure.ref)).toEqual(['metric:claims.claim_count']);
      expect(outcome.intent.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.region']);
    }
  });

  it('a question the thread reads as an edit of the last answer goes to the model (thread-sensitive reading is covered in lexical-reading-guards.test.ts)', async () => {
    const provider = wandering();
    const first = await ask('Claims filed by region', wandering());
    if (first.kind !== 'answered') throw new Error('expected an answer');
    const outcome = await ask('Claims filed by region', provider, {
      prior: { ...first.intent, measures: [{ ref: 'metric:claims.paid_amount' }] },
      priorExecuted: true, conversation: { summary: 'The last answer was an AI-drafted paid amount by channel.' },
    });
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(outcome).toBeDefined();
  });

  it('keeps today\'s model-driven path when the question is not only a metric and dimensions', async () => {
    for (const question of [
      'Claims filed by region last quarter',
      'top 5 regions by claims filed',
      'Claims filed by region for open claims',
      'Claims filed by month',
      'Claims filed by channel',
      'Claims filed by',
      'region',
    ]) expect(readByOwnWords(question, vocabulary), question).toBeUndefined();
    const provider = wandering();
    const outcome = await ask('Claims filed by region last quarter', provider);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(outcome.kind === 'answered' ? outcome.candidate.tier : 'not answered').not.toBe('semantic');
  });

  it('keeps the model path when a name belongs to two entries', async () => {
    const twice = buildVocabularyIndex({
      ...harbor,
      dimensions: [...harbor.dimensions!, { name: 'sales_region', model: 'claims', label: 'Region', dataType: 'string' }],
    });
    expect(readByOwnWords('Claims filed by region', twice)).toBeUndefined();
  });

  it('keeps the model path when a certified block carries the same words', async () => {
    const withBlock = buildVocabularyIndex({
      ...harbor,
      blocks: [...harbor.blocks!, {
        name: 'claims_filed_by_region', domain: 'claims', certified: true, description: 'Claims filed by region.',
        contract: extractBlockContract({ name: 'claims_filed_by_region', domain: 'claims', sql: 'SELECT region, COUNT(*) AS claim_count FROM claims GROUP BY region', declaredOutputs: ['region', 'claim_count'] }),
      }],
    });
    expect(readByOwnWords('claims filed by region', withBlock)).toBeUndefined();
  });

  it('keeps the model path when the dimension cannot be reached from the metric', () => {
    expect(readByOwnWords('Claims filed by channel', vocabulary)).toBeUndefined();
    expect(readByOwnWords('Policies in force by channel', vocabulary)?.measures.map((measure) => measure.ref)).toEqual(['metric:policies.policy_count']);
  });
});

/**
 * Enterprise walkthrough D4 (2026-11-02): "What is the total claimed amount by
 * product?" was From Metrics for one person and Blocked for the next, because
 * the model read it, and once read it as `product = "product"` beside the
 * group-by. "Total" is the sum the metric already is, and "product" on two
 * models is the one on the metric's model: the question is read here, every
 * time; and the model's self-named filter, where it is asked anyway, is dropped.
 */
const insurer: VocabularySource = {
  metrics: [
    { name: 'claimed_amount', model: 'claims', label: 'Claimed amount', aggregation: 'sum' },
    { name: 'claim_count', model: 'claims', label: 'Claims', aggregation: 'count' },
    { name: 'avg_claim_size', model: 'claims', label: 'Average claim size', aggregation: 'avg' },
    { name: 'payment_amount', model: 'claim_payments', label: 'Payment amount', aggregation: 'sum' },
  ],
  dimensions: [
    { name: 'product', model: 'claims', label: 'Product', dataType: 'string' },
    { name: 'product', model: 'claim_payments', label: 'Product', dataType: 'string' },
    { name: 'region', model: 'claims', label: 'Region', dataType: 'string' },
  ],
};
const insurerVocabulary = buildVocabularyIndex(insurer);
/** The intent Nova Pro returned for Wes: the group-by, and a filter whose value is the dimension's own name. */
const WES_INTENT = {
  version: 1, kind: 'analytics', reading: 'Total claimed amount by product, for product',
  measures: [{ ref: 'metric:claims.claimed_amount', aggregation: 'sum' }],
  groupBy: [{ ref: 'dimension:claims.product', role: 'key' }],
  display: [], filters: [{ ref: 'dimension:claims.product', op: 'eq', values: ['product'], source: 'question' }],
  unresolved: [], provenance: {}, expectedShape: 'grouped',
};
function novaForWes(): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return { name: 'bedrock', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return JSON.stringify(WES_INTENT); } };
}
const askInsurer = (question: string, provider: AgentProvider, compiled: Array<{ filters: unknown }>) => runAskPipeline({
  question, vocabulary: insurerVocabulary, provider, explorationAuto: true, clauseCoverage: false,
  prepareDeps: {
    compileSemantic: async (request) => { compiled.push({ filters: request.filters ?? [] }); return { sql: `SELECT product, SUM(claimed_amount) AS claimed_amount FROM claims${(request.filters ?? []).length ? ' WHERE product = ?' : ''} GROUP BY product`, engine: 'native' }; },
  },
  executeDeps: { run: async (sql) => (sql.includes('WHERE')
    ? { columns: ['product', 'claimed_amount'], rows: [], rowCount: 0, executionTimeMs: 1 }
    : { columns: ['product', 'claimed_amount'], rows: [{ product: 'Auto', claimed_amount: 3 }, { product: 'Home', claimed_amount: 2 }], rowCount: 2, executionTimeMs: 1 }) },
});

describe('"total X by Y" is read by the semantic layer\'s own words (walkthrough D4)', () => {
  it('reads "What is the total claimed amount by product?" to the metric and the product on its model', () => {
    const reading = readByOwnWords('What is the total claimed amount by product?', insurerVocabulary);
    expect(reading?.measures.map((measure) => measure.ref)).toEqual(['metric:claims.claimed_amount']);
    expect(reading?.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.product']);
    expect(reading?.filters).toEqual([]);
  });

  it('resolves a dimension name two models share to the model that holds the metric', () => {
    expect(readByOwnWords('Payment amount by product', insurerVocabulary)?.groupBy.map((group) => group.ref)).toEqual(['dimension:claim_payments.product']);
    expect(readByOwnWords('Claimed amount by product', insurerVocabulary)?.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.product']);
  });

  it('accepts an aggregate word only when it is the aggregate the metric is', () => {
    for (const question of ['count of claims by region', 'number of claims by region', 'total claims by region', 'sum of claimed amount by product', 'overall claimed amount by product']) {
      expect(readByOwnWords(question, insurerVocabulary), question).toBeDefined();
    }
    // A sum metric asked for as an average, a count asked for as a sum, a derived average asked for as a total: the model reads those.
    for (const question of ['average claimed amount by product', 'mean claimed amount by product', 'sum of claims by region', 'total average claim size by product']) {
      expect(readByOwnWords(question, insurerVocabulary), question).toBeUndefined();
    }
    // The metric whose own label carries the word is still named by it.
    expect(readByOwnWords('Average claim size by product', insurerVocabulary)?.measures.map((measure) => measure.ref)).toEqual(['metric:claims.avg_claim_size']);
  });

  it('answers Wes\'s question From Metrics with the group-by and no filter, whatever the model returns, every time', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const compiled: Array<{ filters: unknown }> = [];
      const outcome = await askInsurer('What is the total claimed amount by product?', novaForWes(), compiled);
      expect(outcome.kind).toBe('answered');
      if (outcome.kind !== 'answered') return;
      expect(outcome.candidate.tier).toBe('semantic');
      expect(outcome.candidate.trust).toBe('governed');
      expect(outcome.intent.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.product']);
      expect(outcome.intent.filters).toEqual([]);
      expect(compiled.at(-1)?.filters).toEqual([]);
      expect(outcome.result.rowCount).toBe(2);
    }
  });

  it('drops the model\'s self-named filter on a question the model does read, and says so on the receipt', async () => {
    const compiled: Array<{ filters: unknown }> = [];
    const provider = novaForWes();
    // "book" names nothing here, so the model reads the question and returns Wes's intent.
    const outcome = await askInsurer('Total claimed amount by product across the book', provider, compiled);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.intent.filters).toEqual([]);
    expect(outcome.intent.groupBy.map((group) => group.ref)).toEqual(['dimension:claims.product']);
    expect(compiled.at(-1)?.filters).toEqual([]);
    expect(outcome.receipt.grounding?.join(' ')).toContain('filter dropped: Product = "product" was the dimension\'s own name');
    expect(outcome.text).not.toContain('nothing about the member');
  });
});
