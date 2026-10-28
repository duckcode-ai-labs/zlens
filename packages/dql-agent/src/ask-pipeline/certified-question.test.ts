import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { certifiedBlockForQuestion, normalizeQuestion, readByCertifiedQuestion } from './certified-question.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

/**
 * Sandbox gate W1, round 4: the certify loop asked "Which adjusters handle the
 * most open claims?", a creator built and certified a block from the request,
 * and the same words asked again through the API came back AI-generated
 * twice. The model had read the question as claim rows (grouping by claim_id,
 * showing claim_type), and no block entails that reading. A block that
 * records the question it was certified for answers it before any model
 * reads it.
 */
const QUESTION = 'Which adjusters handle the most open claims?';
const BLOCK_SQL = "SELECT adjuster_id, adjuster_name, COUNT(*) AS open_claims FROM claims WHERE status = 'open' GROUP BY adjuster_id, adjuster_name ORDER BY open_claims DESC";

function harbor(block: Partial<NonNullable<VocabularySource['blocks']>[number]> = {}, more: NonNullable<VocabularySource['blocks']> = []): VocabularySource {
  return {
    metrics: [{ name: 'claim_count', model: 'claims', label: 'Claims filed', aggregation: 'count' }],
    dimensions: [{ name: 'region', model: 'claims', label: 'Region', dataType: 'string' }],
    blocks: [{
      name: 'W1 R-100 claimed amount answer', domain: 'claims', certified: true, description: 'Open claims per adjuster, built for request R-100.',
      sql: BLOCK_SQL, examples: [QUESTION],
      contract: extractBlockContract({ name: 'W1 R-100 claimed amount answer', domain: 'claims', sql: BLOCK_SQL, declaredOutputs: ['adjuster_id', 'adjuster_name', 'open_claims'] }),
      ...block,
    }, ...more],
    relations: [{ schema: 'main', name: 'claims', columns: [{ name: 'claim_id', dataType: 'VARCHAR' }, { name: 'claim_type', dataType: 'VARCHAR' }, { name: 'adjuster_id', dataType: 'VARCHAR' }, { name: 'status', dataType: 'VARCHAR' }] }],
  };
}

/** Nova Pro's round-4 reading: the question as claim rows, not as the block. */
function columnShaped(vocabulary: ReturnType<typeof buildVocabularyIndex>): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  const column = (name: string) => vocabulary.entries.find((entry) => entry.kind === 'column' && entry.ref.toLowerCase().endsWith(`.${name}`))?.ref ?? `column:main.claims.${name}`;
  const reply = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'List open claims with their adjuster and claim type',
    measures: [{ ref: column('claim_id'), aggregation: 'count' }], groupBy: [{ ref: column('claim_id'), role: 'categorical' }], display: [column('claim_type')],
    filters: [{ ref: column('status'), op: 'eq', values: ['open'] }], unresolved: [], provenance: {}, expectedShape: 'grouped',
  });
  return { name: 'ollama', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return reply; } };
}

const ask = (question: string, vocabulary: ReturnType<typeof buildVocabularyIndex>, provider: AgentProvider) => runAskPipeline({
  question, vocabulary, provider, explorationAuto: true, clauseCoverage: false,
  prepareDeps: {
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    draftSql: async () => ({ sql: 'SELECT claim_id, claim_type FROM main.claims WHERE status = \'open\'', relations: ['main.claims'], proof: [] }),
  },
  executeDeps: { run: async () => ({ columns: ['adjuster_id', 'adjuster_name', 'open_claims'], rows: [{ adjuster_id: 'A1', adjuster_name: 'Ana', open_claims: 7 }], rowCount: 1, executionTimeMs: 1 }) },
});

describe('normalizeQuestion', () => {
  it.each([
    ['Which adjusters handle the most open claims?', 'which adjusters handle the most open claims'],
    ['  which   ADJUSTERS handle the most open claims ', 'which adjusters handle the most open claims'],
    ['Which adjusters handle the most open claims?!', 'which adjusters handle the most open claims'],
    ['Which adjusters handle the most open claims.', 'which adjusters handle the most open claims'],
    ['“Which adjusters handle the most open claims”', 'which adjusters handle the most open claims'],
    ['Who’s the top adjuster?', "who's the top adjuster"],
  ])('%s → %s', (text, expected) => {
    expect(normalizeQuestion(text)).toBe(expected);
  });

  it('keeps punctuation inside the question', () => {
    expect(normalizeQuestion('Open claims, by region (West)?')).toBe('open claims, by region (west)');
  });
});

describe('a certified block that records its question', () => {
  it('is found for the question in any case, spacing or trailing punctuation', () => {
    const vocabulary = buildVocabularyIndex(harbor());
    for (const asked of [QUESTION, 'which adjusters handle the most open claims', '  Which adjusters   handle the most open claims?? ', 'WHICH ADJUSTERS HANDLE THE MOST OPEN CLAIMS.']) {
      expect(certifiedBlockForQuestion(asked, vocabulary)?.name, asked).toBe('W1 R-100 claimed amount answer');
    }
  });

  it('is found through a description that is the question verbatim (the draft the product writes)', () => {
    const vocabulary = buildVocabularyIndex(harbor({ description: `${QUESTION} `, examples: [] }));
    expect(certifiedBlockForQuestion(QUESTION.toLowerCase(), vocabulary)?.name).toBe('W1 R-100 claimed amount answer');
  });

  it('is not found for a different question, a question it only contains, or a draft', () => {
    const vocabulary = buildVocabularyIndex(harbor());
    expect(certifiedBlockForQuestion('Which adjusters handle the most closed claims?', vocabulary)).toBeUndefined();
    expect(certifiedBlockForQuestion('Which adjusters handle the most open claims in the West?', vocabulary)).toBeUndefined();
    expect(certifiedBlockForQuestion('adjusters', vocabulary)).toBeUndefined();
    expect(certifiedBlockForQuestion(QUESTION, buildVocabularyIndex(harbor({ certified: false, status: 'draft' })))).toBeUndefined();
  });

  it('is not chosen when two certified blocks record the same question', () => {
    const twin = harbor().blocks![0]!;
    const vocabulary = buildVocabularyIndex(harbor({}, [{ ...twin, name: 'Open claims per adjuster (copy)' }]));
    expect(certifiedBlockForQuestion(QUESTION, vocabulary)).toBeUndefined();
  });

  it('reads the question as that block, with nothing else asked for', () => {
    const vocabulary = buildVocabularyIndex(harbor());
    const read = readByCertifiedQuestion(QUESTION, vocabulary);
    expect(read?.block.ref).toBe('block:claims.W1 R-100 claimed amount answer');
    expect(read?.intent).toMatchObject({ reading: QUESTION, measures: [{ ref: 'block:claims.W1 R-100 claimed amount answer' }], groupBy: [], display: [], filters: [], expectedShape: 'ranking' });
  });
});

describe('the pipeline answers a recorded question from its block before any model reads it', () => {
  it('serves the block certified without asking the model, whatever it would have read', async () => {
    const vocabulary = buildVocabularyIndex(harbor());
    const provider = columnShaped(vocabulary);
    const outcome = await ask(QUESTION, vocabulary, provider);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.candidate.sourceRef).toBe('block:claims.W1 R-100 claimed amount answer');
    expect(provider.calls).toHaveLength(0);
    expect(outcome.receipt.story?.some((entry) => entry.phase === 'read' && /certified saved query W1 R-100 claimed amount answer answers/.test(entry.title))).toBe(true);
    expect(outcome.receipt.uncovered ?? []).toEqual([]);
  });

  it('a question the block does not record still goes through the model (and its column-shaped reading is not the block)', async () => {
    const vocabulary = buildVocabularyIndex(harbor());
    const provider = columnShaped(vocabulary);
    const outcome = await ask('List every open claim with its adjuster and claim type', vocabulary, provider);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(outcome.kind === 'answered' && outcome.candidate.tier === 'certified').toBe(false);
  });
});
