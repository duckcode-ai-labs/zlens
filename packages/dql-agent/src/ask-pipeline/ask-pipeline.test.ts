import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { applyDerivedColumns, classifyWarehouseError, executeCandidate, statementFailure, warehouseDiagnosis, type WarehouseFailure } from './execute.js';
import { ANALYTICAL_INTENT_JSON_SCHEMA, describeIntent, intentExecutionFingerprint, intentRefs, parseIntent, unaccountedInheritedRefs, type AnalyticalIntentV1 } from './intent.js';
import { isGovernedEntry, readingLane, applyGovernedDefaults, applySelectedMeaning, auditLedger, bindExactNames, freezeSuperlativeShape, droppedChange, identityClauseWords, keepMembersApart, unmetFacets, preferGovernedDefinition, relativePeriodProblem, scopedColumnOf, buildIntentSystemPrompt, buildLedger, calendarBasisProblem, droppedGrain, droppedYears, proveClauseCoverage, proveTimeRoles, resolveIntent, widenedPopulation, unaccountedQuestionWords, uncoveredQuestionTerms, coverageStates, validateIntentRefs, facetStem, promoteSoleMeasureScope, timeAxesFor } from './resolve-intent.js';
import { bindSemanticRequest } from './prepare/index.js';
import { composeAnsweredText, composeFailedText, describeResultColumns, formatValue } from './outcomes.js';
import { applyMemberSelection, bindNamedSubject, memberOptionId, namesInQuestion, parseMemberOption, pinnedRefsFor, proveSubjectMatchesPopulation, retiredBlockNamedBy, runAskPipeline, unmetDisplayObligation } from './pipeline.js';
import { fillPeriodGaps } from './execute.js';
import { suggestSameGrainColumns, suggestSameRelationFields, buildVocabularyIndex, renderCard, trigramSimilarity, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { extractFirstJsonObject } from '../providers/structured-output.js';

const TOP_BEVERAGE_SQL = `
    SELECT
      customers.customer_name,
      SUM(order_items.product_price) AS beverage_revenue,
      COUNT(DISTINCT order_items.order_id) AS beverage_orders,
      COUNT(DISTINCT products.product_id) AS beverage_product_types
    FROM dev.order_items AS order_items
    JOIN dev.products AS products ON order_items.product_id = products.product_id
    JOIN dev.orders AS orders ON order_items.order_id = orders.order_id
    JOIN dev.customers AS customers ON orders.customer_id = customers.customer_id
    WHERE products.is_drink_item = true
    GROUP BY customers.customer_name
    ORDER BY beverage_revenue DESC, beverage_product_types DESC, customer_name
    LIMIT 10`;

const jaffle: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', label: 'Revenue', description: 'Sum of product prices (pretax product revenue).', aggregation: 'sum' },
    { name: 'drink_revenue', model: 'order_item', label: 'Drink Revenue', description: 'Revenue from drink items.', aggregation: 'sum', aliases: ['beverage revenue'] },
    { name: 'food_revenue', model: 'order_item', label: 'Food Revenue', aggregation: 'sum' },
    { name: 'order_total', model: 'orders', label: 'Order Total', description: 'Total including tax.', aggregation: 'sum' },
    { name: 'lifetime_spend_pretax', model: 'customers', label: 'Lifetime Spend Pretax', aggregation: 'sum' },
    { name: 'lifetime_spend', model: 'customers', label: 'Lifetime Spend', aggregation: 'sum' },
    { name: 'supply_cost', model: 'supplies', label: 'Supply Cost', aggregation: 'sum' },
    { name: 'customers', model: 'customers', label: 'Customers', description: 'Count of customers.', aggregation: 'count_distinct' },
  ],
  dimensions: [
    { name: 'customer_name', model: 'customers', dataType: 'string' },
    { name: 'customer_type', model: 'customers', dataType: 'string' },
    { name: 'product_type', model: 'products', dataType: 'string' },
    { name: 'product_name', model: 'products', dataType: 'string' },
    { name: 'supply_name', model: 'supplies', dataType: 'string' },
    { name: 'product_id', model: 'supplies', dataType: 'string' },
    { name: 'is_drink_item', model: 'order_item', dataType: 'boolean' },
    { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
  entities: [
    { name: 'customer', model: 'customers', type: 'primary' },
    { name: 'product', model: 'products', type: 'primary' },
    { name: 'order_id', model: 'orders', type: 'primary' },
  ],
  blocks: [
    {
      name: 'customer_profile', domain: 'commerce', certified: true, description: 'Customer lifetime profile. One row per customer.',
      contract: extractBlockContract({ name: 'customer_profile', domain: 'commerce', entities: ['customer'], sql: 'SELECT customer_name, customer_type, lifetime_spend FROM dev.customers ORDER BY lifetime_spend DESC, customer_name', declaredOutputs: ['customer_name', 'customer_type', 'lifetime_spend'] }),
    },
    {
      name: 'top_beverage_customers', domain: 'commerce', certified: true, description: 'Top customers ranked by beverage revenue.',
      contract: extractBlockContract({ name: 'top_beverage_customers', domain: 'commerce', sql: TOP_BEVERAGE_SQL, declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'] }),
      examples: ['Who are the top customers by beverage revenue?'],
    },
  ],
  relations: [
    { schema: 'dev', name: 'orders', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'customer_id', dataType: 'VARCHAR' }, { name: 'order_total', dataType: 'DOUBLE' }, { name: 'ordered_at', dataType: 'TIMESTAMP' }] },
    { schema: 'dev', name: 'supplies', columns: [{ name: 'supply_uuid', dataType: 'VARCHAR' }, { name: 'product_id', dataType: 'VARCHAR' }, { name: 'supply_name', dataType: 'VARCHAR' }, { name: 'supply_cost', dataType: 'DOUBLE' }] },
  ],
};

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return {
    name: 'ollama',
    calls,
    available: async () => true,
    generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; },
  };
}

describe('block contract', () => {
  it('reads measures, grouping, static scope, ordering and limit from a simple SELECT', () => {
    const contract = extractBlockContract({ name: 'top_beverage_customers', sql: TOP_BEVERAGE_SQL });
    expect(contract.structural).toBe(true);
    expect(contract.measures.map((m) => `${m.output}:${m.aggregate}:${m.sourceColumn ?? ''}`)).toEqual([
      'beverage_revenue:sum:product_price', 'beverage_orders:count_distinct:order_id', 'beverage_product_types:count_distinct:product_id',
    ]);
    expect(contract.groupBy).toEqual(['customer_name']);
    expect(contract.staticScope).toEqual([{ column: 'is_drink_item', op: 'is_true', values: [] }]);
    expect(contract.orderBy?.[0]).toEqual({ column: 'beverage_revenue', direction: 'desc' });
    expect(contract.limit).toBe(10);
  });
  it('declared outputs win and a non-structural block keeps only declarations', () => {
    const contract = extractBlockContract({ name: 'x', sql: 'WITH a AS (SELECT 1) SELECT * FROM a UNION SELECT 2', declaredOutputs: ['n'], dimensions: ['n'] });
    expect(contract.structural).toBe(false);
    expect(contract.outputs).toEqual(['n']);
    expect(contract.groupBy).toEqual(['n']);
  });
});

describe('vocabulary index', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  it('holds every object with an exact ref and resolves names and bare ids', () => {
    expect(vocabulary.get('metric:order_item.drink_revenue')?.kind).toBe('metric');
    expect(vocabulary.resolve('order_item.drink_revenue')?.ref).toBe('metric:order_item.drink_revenue');
    expect(vocabulary.resolve('customer_name')?.ref).toBe('dimension:customers.customer_name');
    expect(vocabulary.resolve('Drink Revenue')?.ref).toBe('metric:order_item.drink_revenue');
    expect(vocabulary.resolve('revenue', ['metric'])?.ref).toBe('metric:order_item.revenue');
  });
  it('tolerates spelling: "bevereage" finds the drink metrics and "catogery" finds product_type', () => {
    expect(trigramSimilarity('bevereage', 'beverage')).toBeGreaterThan(0.6);
    const drink = vocabulary.lookup('bevereage', { limit: 5 }).map((hit) => hit.entry.ref);
    expect(drink).toContain('metric:order_item.drink_revenue');
    // Nothing here is called "category", so a lone misspelling proposes nothing rather than a guess…
    expect(vocabulary.lookup('catogery', { limit: 5 })).toHaveLength(0);
    // …while the surrounding words still find the product dimension.
    expect(vocabulary.lookup('product catogery', { limit: 5 }).map((hit) => hit.entry.ref)).toContain('dimension:products.product_type');
  });
  it('assigns roles: names are labels, entities are keys, timestamps are time', () => {
    expect(vocabulary.get('dimension:customers.customer_name')?.roles).toEqual(['label']);
    expect(vocabulary.get('entity:customers.customer')?.roles).toEqual(['key']);
    expect(vocabulary.get('dimension:order_item.ordered_at')?.roles).toEqual(['time']);
    expect(vocabulary.get('dimension:order_item.is_drink_item')?.roles).toEqual(['boolean']);
  });
  it('renders deterministic cards with the block contract visible and a budget that still names every kind', () => {
    const cards = vocabulary.renderCards({ seeds: ['beverage', 'customers'] });
    expect(cards).toContain('block:commerce.top_beverage_customers');
    expect(cards).toContain('scope: is_drink_item is_true');
    expect(cards).toContain('limit 10');
    expect(vocabulary.renderCards({ seeds: ['beverage'] })).toBe(cards.replace(/x/g, 'x'));
    const small = vocabulary.renderCards({ maxChars: 600, seeds: ['beverage'] });
    expect(small).toContain('of');
    expect(small).toContain('not shown here still exists');
  });
});

describe('intent contract', () => {
  it('parses a valid intent and rejects a shapeless one', () => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking', unresolved: [], provenance: {} });
    expect(parsed.intent?.limit).toBe(10);
    expect(parseIntent({ kind: 'analytics', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).errors.length).toBeGreaterThan(0);
    expect(parseIntent('nope').errors[0]?.message).toContain('not a JSON object');
  });
  it('execution fingerprint ignores prose and provenance', () => {
    const base = parseIntent({ version: 1, kind: 'analytics', reading: 'a', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } }).intent!;
    const other = { ...base, reading: 'b', provenance: {} };
    expect(intentExecutionFingerprint(base)).toBe(intentExecutionFingerprint(other));
    expect(describeIntent(base)).toContain('metric:order_item.revenue');
  });
  it('a follow-up that drops an inherited ref without saying so is caught', () => {
    const prior = parseIntent({ version: 1, kind: 'analytics', reading: 'a', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: [], filters: [], expectedShape: 'ranking', limit: 10, unresolved: [], provenance: {} }).intent!;
    const next = parseIntent({ version: 1, kind: 'analytics', reading: 'b', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'entity:customers.customer': 'removed:new subject' } }).intent!;
    expect(unaccountedInheritedRefs(prior, next)).toEqual(['metric:order_item.drink_revenue']);
  });
});

describe('intent resolution', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const good = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Top 10 customers by beverage revenue, showing names',
    measures: [{ ref: 'metric:order_item.drink_revenue' }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
    display: ['dimension:customers.customer_name'], filters: [],
    ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10,
    expectedShape: 'ranking', unresolved: [], provenance: { 'metric:order_item.drink_revenue': 'q:beverage', 'entity:customers.customer': 'q:customers' },
  });
  it('the prompt teaches identity, per-measure scope, literals and clarification', () => {
    const prompt = buildIntentSystemPrompt({ cards: vocabulary.renderCards(), hasPrior: true });
    expect(prompt).toContain('IDENTITY IS THE KEY');
    expect(prompt).toContain('RESTRICTS ONLY THE MEASURE');
    expect(prompt).toContain('FOLLOW-UP');
    expect(prompt).toContain('metric:order_item.drink_revenue');
  });
  it('a valid reply resolves in one dispatch', async () => {
    const provider = scripted([good]);
    const result = await resolveIntent({ question: 'who are the top customers for beverage product category', vocabulary, provider });
    expect(result.status).toBe('resolved');
    expect(result.attempts).toBe(1);
    if (result.status === 'resolved') expect(result.intent.display).toEqual(['dimension:customers.customer_name']);
  });
  it('an invented ref is corrected once with the nearest authorized refs, then accepted', async () => {
    const bad = good.replace('metric:order_item.drink_revenue', 'metric:beverage_revenue');
    const provider = scripted([bad, good]);
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'top beverage customers', vocabulary, provider, onDispatch: (event) => dispatches.push(event.purpose) });
    expect(dispatches).toEqual(['resolve', 'correct']);
    expect(result.status).toBe('resolved');
    const correction = provider.calls[1]!.at(-1)!.content;
    expect(correction).toContain('metric:beverage_revenue is not in the vocabulary');
    expect(correction).toContain('metric:order_item.drink_revenue');
  });
  it('grouping by a label is refused with the key suggested', () => {
    const intent = parseIntent(JSON.parse(good.replace('"groupBy":[{"ref":"entity:customers.customer","role":"key"}]', '"groupBy":[{"ref":"dimension:customers.customer_name","role":"key"}]'))).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems.some((problem) => problem.message.includes('is a label'))).toBe(true);
  });
  it('a conversation reply and a material clarification each end the turn without execution', async () => {
    const hello = JSON.stringify({ version: 1, kind: 'conversation', reading: 'greeting', reply: 'Hi! Ask me about revenue, customers or orders.', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {} });
    expect((await resolveIntent({ question: 'hi', vocabulary, provider: scripted([hello]) })).status).toBe('conversation');
    const ambiguous = JSON.stringify({ version: 1, kind: 'analytics', reading: 'total revenue', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [{ clause: 'total revenue', options: ['metric:order_item.revenue', 'metric:orders.order_total'], material: true, question: 'Do you mean product revenue before tax, or order totals including tax?' }], provenance: {} });
    const result = await resolveIntent({ question: 'how much money did we take', vocabulary, provider: scripted([ambiguous]) });
    expect(result.status).toBe('clarify');
    if (result.status === 'clarify') expect(result.options).toHaveLength(2);
    // The same ambiguity when the question NAMES one option is the governed default, not a question back.
    const defaulted = await resolveIntent({ question: 'total revenue', vocabulary, provider: scripted([ambiguous]) });
    expect(defaulted.status).toBe('resolved');
    if (defaulted.status === 'resolved') expect(defaulted.intent.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue']);
  });
  it('a clarification-only reply that the governed default resolves is sent back for the rest of the question, never executed as a scalar', async () => {
    const bareTrend = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly revenue trend', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'trend', unresolved: [{ clause: 'revenue by month', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true, question: 'Gross order revenue or product revenue?' }], provenance: {} });
    const full = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly product revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], expectedShape: 'trend', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:order_item.ordered_at': 'q:by month' } });
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'revenue by month', vocabulary, provider: scripted([bareTrend, full]), onDispatch: (event) => dispatches.push(event.purpose) });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.groupBy).toEqual([{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }]);
    expect(dispatches).toHaveLength(2);
    const stubborn = await resolveIntent({ question: 'revenue by month', vocabulary, provider: scripted([bareTrend, bareTrend]) });
    expect(stubborn.status).toBe('clarify');
    if (stubborn.status === 'clarify') expect(stubborn.question).toBe('Gross order revenue or product revenue?');
    expect(unaccountedQuestionWords('what is the total revenue', parseIntent(JSON.parse(full)).intent!, vocabulary)).toEqual([]);
    expect(unaccountedQuestionWords('revenue for Ryan Byrd by month', parseIntent(JSON.parse(full)).intent!, vocabulary)).toEqual(['ryan', 'byrd']);
  });
  it('prose that never becomes JSON fails with a typed reason after the bounded attempts', async () => {
    const result = await resolveIntent({ question: 'x', vocabulary, provider: scripted(['I cannot help with that.']) });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('unparseable');
    expect(extractFirstJsonObject('text {"a":1} more')).toEqual({ a: 1 });
  });
});

describe('governed defaults', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('an exact metric name resolves the ambiguity and the ranking order follows the replaced measure', () => {
    const next = intent({
      measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
      ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5,
      unresolved: [{ clause: 'revenue', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true }],
      provenance: { 'metric:orders.order_total': 'q:revenue' },
    });
    applyGovernedDefaults(next, 'top 5 customers by revenue', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue']);
    expect(next.ordering).toEqual({ ref: 'metric:order_item.revenue', direction: 'desc' });
    expect(next.provenance['metric:order_item.revenue']).toMatch(/^q:revenue/);
  });
  it('a word spent on the grain never names the default measure: "customers" is the grain, not the customer count', () => {
    // No certified precedent applies here (no key grain), so the clause must stay open.
    const next = intent({
      measures: [{ ref: 'metric:customers.customers' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }],
      unresolved: [{ clause: 'top customers', options: ['metric:customers.lifetime_spend', 'metric:customers.lifetime_spend_pretax', 'metric:customers.customers'], material: true }],
    });
    applyGovernedDefaults(next, 'who are the top customers by type', vocabulary);
    expect(next.unresolved[0]!.material).toBe(true);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:customers.customers']);
  });
  it('a material clause with one option the intent already uses is a reachability worry, not an ambiguity', () => {
    const next = intent({
      measures: [{ ref: 'metric:order_item.food_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }],
      unresolved: [{ clause: 'food revenue by product', options: ['metric:order_item.food_revenue'], material: true, question: 'Is product reachable from order_item?' }],
    });
    applyGovernedDefaults(next, 'food revenue by product', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.unresolved[0]!.question).toMatch(/host proves reachability/);
  });
});

describe('host proofs on the interpreted intent', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a label finer than the grain is replaced by the grain entity\'s own label', () => {
    const next = validateIntentRefs(intent({
      measures: [{ ref: 'metric:supplies.supply_cost' }], groupBy: [{ ref: 'dimension:supplies.product_id', role: 'key' }], display: ['dimension:supplies.supply_name'],
    }), vocabulary);
    expect(next.problems).toEqual([]);
    expect(next.intent.display).toEqual(['dimension:products.product_name']);
    expect(next.intent.provenance['dimension:supplies.supply_name']).toMatch(/finer than the grain products/);
  });
  it('a customer name beside the customer key is the grain\'s label and stays', () => {
    const next = validateIntentRefs(intent({
      measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
    }), vocabulary);
    expect(next.intent.display).toEqual(['dimension:customers.customer_name']);
  });
  it('a follow-up keeps the previous period unless the message names one', () => {
    const prior = intent({
      measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
      time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } }, expectedShape: 'ranking',
    });
    const edit = () => intent({ measures: [{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], provenance: { 'metric:order_item.revenue': 'inherited', 'entity:customers.customer': 'inherited' }, expectedShape: 'ranking' });
    const kept = validateIntentRefs(edit(), vocabulary, prior, 'also show the number of orders');
    expect(kept.problems).toEqual([]);
    expect(kept.intent.time?.window).toEqual({ start: '2025-01-01', end: '2026-01-01' });
    expect(kept.intent.provenance['time:dimension:order_item.ordered_at']).toBe('inherited');
    const renamed = validateIntentRefs(edit(), vocabulary, prior, 'same for all time');
    expect(renamed.intent.time?.window).toBeUndefined();
  });
  it('a follow-up made only of the previous analysis\'s words (misspelt) cannot replace its measures on the first reading', () => {
    const prior = intent({
      reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:top customers for beverage product category' }, expectedShape: 'ranking',
    });
    const replaced = intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], provenance: { 'metric:order_item.drink_revenue': 'removed:asks for products', 'entity:customers.customer': 'removed:asks for products', 'dimension:customers.customer_name': 'removed:asks for products' } });
    const first = validateIntentRefs(replaced, vocabulary, prior, 'I need to get the bevereage catogery');
    expect(first.problems.map((problem) => problem.path)).toEqual(['measures']);
    expect(first.problems[0]!.message).toMatch(/corrects that analysis rather than replacing it/);
    const newSubject = validateIntentRefs(replaced, vocabulary, prior, 'what is the Ryan Byrd revenue by product');
    expect(newSubject.problems).toEqual([]);
    const second = validateIntentRefs(replaced, vocabulary, prior, undefined);
    expect(second.problems).toEqual([]);
  });
  it('a generic classifier word ("catogery") names nothing new even when the previous analysis never used it', () => {
    const prior = intent({
      reading: 'Rank customers by their beverage revenue, showing the top customers along with customer name', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:beverage revenue', 'dimension:customers.customer_name': 'q:customer name' }, expectedShape: 'ranking',
    });
    const replaced = intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], provenance: { 'metric:order_item.drink_revenue': 'removed:asks for products' } });
    const first = validateIntentRefs(replaced, vocabulary, prior, 'I need to get the bevereage catogery');
    expect(first.followUpReplacement).toMatch(/corrects that analysis rather than replacing it/);
  });
});

describe('the intent schema survives strict validators', () => {
  it('uses anyOf, never a union type keyword (the Claude Code CLI validates in Ajv strict mode)', () => {
    expect(JSON.stringify(ANALYTICAL_INTENT_JSON_SCHEMA)).not.toMatch(/"type":\[/);
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'in', values: ['a', 2, true], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    expect(parsed.intent?.filters[0]?.values).toEqual(['a', 2, true]);
  });
});

describe('certified precedent and the second follow-up reading', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('"top customers" resolves to the measure the certified customer block ranks by', () => {
    const next = intent({
      measures: [{ ref: 'metric:customers.customers' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], limit: 10,
      unresolved: [{ clause: 'top customers', options: ['metric:customers.lifetime_spend', 'metric:customers.lifetime_spend_pretax', 'metric:customers.customers'], material: true }],
    });
    applyGovernedDefaults(next, 'who are the top customers', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:customers.lifetime_spend']);
    expect(next.provenance['metric:customers.lifetime_spend']).toMatch(/certified precedent block:commerce.customer_profile/);
  });
  it('a second reading that still replaces the previous analysis becomes a clarification between the two', async () => {
    const prior = intent({
      reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:top customers for beverage product category' },
    });
    const replaced = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Beverage revenue by product', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], display: [], filters: [], unresolved: [], expectedShape: 'ranking',
      provenance: { 'entity:customers.customer': 'removed:asks for products', 'dimension:customers.customer_name': 'removed:asks for products' },
    }).replace('metric:order_item.drink_revenue', 'metric:order_item.revenue');
    const provider = scripted([replaced, replaced]);
    const result = await resolveIntent({ question: 'I need to get the bevereage catogery', vocabulary, provider, prior });
    expect(result.status).toBe('clarify');
    if (result.status === 'clarify') {
      expect(result.options).toEqual(['metric:order_item.drink_revenue', 'metric:order_item.revenue']);
      expect(result.question).toMatch(/Keep the previous analysis/);
    }
    expect(result.attempts).toBe(2);
  });
});

describe('"not modeled" is checked against the whole vocabulary', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a gap claimed for words that name a numeric column is sent back with the column as a measure', () => {
    const next = validateIntentRefs(intent({ groupBy: [{ ref: 'entity:products.product', role: 'key' }], unresolved: [{ clause: 'supply cost by product', options: [], material: true }] }), vocabulary);
    const problem = next.problems.find((candidate) => candidate.path === 'unresolved');
    expect(problem?.message).toMatch(/is modeled: .*column:dev.supplies.supply_cost/);
    expect(problem?.message).toMatch(/as a measure/);
  });
  it('a gap for words that name nothing stands', () => {
    const next = validateIntentRefs(intent({ unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true }] }), vocabulary);
    expect(next.problems.filter((candidate) => candidate.path === 'unresolved')).toEqual([]);
  });
});

describe('an empty aggregate is not an answer about a member', () => {
  const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  const candidate = { tier: 'semantic' as const, trust: 'governed' as const, sql: "SELECT SUM(x) AS revenue FROM t WHERE customer_name = 'Ryan byrd'", proof: [] };
  it('a single all-null row over a member filter is reported as no rows matched', async () => {
    const outcome = await executeCandidate(candidate, intent, { run: async () => ({ columns: ['revenue'], rows: [{ revenue: null }], rowCount: 1, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.code).toBe('no_rows_matched'); expect(outcome.message).toMatch(/no rows matched "Ryan byrd"/); }
  });
  it('a real value passes', async () => {
    const outcome = await executeCandidate(candidate, intent, { run: async () => ({ columns: ['revenue'], rows: [{ revenue: 2581 }], rowCount: 1, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(true);
  });
});

describe('the discovery path: what the cards cut is still modeled (CTX-010)', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const reply = (raw: Record<string, unknown>) => JSON.stringify({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw });
  const dimensionsExcept = (ref: string) => vocabulary.entries.filter((entry) => entry.kind === 'dimension' && entry.ref !== ref).map((entry) => entry.ref);
  const run = (question: string, provider: AgentProvider, rankedRefs: string[]) => runAskPipeline({
    question, vocabulary, provider, prepareDeps: {}, cardBudget: 700, clauseCoverage: false, context: { rankedRefs },
    executeDeps: { run: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1, executionTimeMs: 1 }) },
  });
  it('hydration pins what the question names ahead of ranking, even under a budget that cuts the section', () => {
    const pinned = pinnedRefsFor('top customers by beverage revenue showing customer_name', vocabulary);
    expect(pinned).toContain('dimension:customers.customer_name');
    expect(pinned).toContain('metric:order_item.drink_revenue');
    const ranked = dimensionsExcept('dimension:customers.customer_name');
    const tight = vocabulary.renderCardsDetailed({ maxChars: 700, seeds: ['revenue'], rankedRefs: ranked });
    expect(tight.refs).not.toContain('dimension:customers.customer_name');
    expect(tight.truncated).toContainEqual({ kind: 'dimension', shown: 7, total: 8 });
    const hydrated = vocabulary.renderCardsDetailed({ maxChars: 700, seeds: ['revenue'], rankedRefs: ranked, pinnedRefs: pinned });
    expect(hydrated.refs).toContain('dimension:customers.customer_name');
    expect(hydrated.text).toContain('not shown here still exists');
  });
  it('a ref the cards did not show is still authorized: the reading is accepted and the ledger records it as unrendered', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply({ groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }] }) };
    const outcome = await run('revenue by kind of customer', provider, dimensionsExcept('dimension:customers.customer_type'));
    expect(outcome.receipt.context?.rendered?.truncated).toContainEqual({ kind: 'dimension', shown: 7, total: 8 });
    expect(outcome.receipt.context?.selected?.refs).toContain('dimension:customers.customer_type');
    expect(outcome.receipt.context?.selected?.unrendered).toEqual(['dimension:customers.customer_type']);
    expect(outcome.receipt.failure).toBeUndefined();
    expect(outcome.receipt.dispatches).toHaveLength(1);
  });
  it('a clause the cards had no room for comes back as one correction carrying the card, and the corrected reading is accepted', async () => {
    const provider = scripted([
      reply({ unresolved: [{ clause: 'supply_name', options: [], material: true }] }),
      reply({ groupBy: [{ ref: 'dimension:supplies.supply_name', role: 'categorical' }] }),
    ]);
    const outcome = await run('revenue by supplier', provider, dimensionsExcept('dimension:supplies.supply_name'));
    expect(provider.calls).toHaveLength(2);
    const correction = String(provider.calls[1]!.at(-1)!.content);
    // Retrieval comes first: the clause's own words name the entry, so the re-ask carries its card.
    expect(correction).toMatch(/"supply_name" is modeled: dimension:supplies\.supply_name|were not shown before/);
    expect(correction).toMatch(/not shown before/);
    expect(correction).toContain(renderCard(vocabulary.get('dimension:supplies.supply_name')!));
    expect(outcome.receipt.failure).toBeUndefined();
    expect(outcome.receipt.context?.selected?.refs).toContain('dimension:supplies.supply_name');
    // A ref that WAS shown gets no card again.
    const shown = scripted([reply({ unresolved: [{ clause: 'product_type', options: [], material: true }] }), reply({ groupBy: [{ ref: 'dimension:products.product_type', role: 'categorical' }] })]);
    await run('revenue by product kind', shown, ['dimension:products.product_type']);
    expect(String(shown.calls[1]!.at(-1)!.content)).not.toContain('Entries you were not shown before');
  });
  it('a material clause that carries its own question is an ambiguity, not a modeling gap', async () => {
    const asking: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply({ measures: [], unresolved: [{ clause: 'ranking basis', options: [], material: true, question: "Should 'top customers' be ranked by lifetime spend or by lifetime order count?" }] }) };
    const gap = await run('who are the top customers by spend or by orders?', asking, []);
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') {
      expect(gap.gap).toBe('ambiguous');
      expect(gap.text).toContain('it can be read more than one way');
      expect(gap.text).not.toContain('does not model it');
    }
  });
  it('a clause that asks why, or what we should do, is an unsupported gap even when its words name metrics — never a re-ask, never "not modeled"', async () => {
    const provider = scripted([reply({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }], unresolved: [{ clause: 'why revenue is down and which customers should we invest in', options: [], material: true }] })]);
    const gap = await run('why is revenue down by customer type and which customers should we invest in?', provider, []);
    expect(provider.calls).toHaveLength(1);
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') {
      expect(gap.gap).toBe('unsupported');
      expect(gap.text).toContain('Answerable from this reading');
    }
  });
  it('a clause nothing in the whole inventory holds is the only "not modeled"', async () => {
    const unmodeled: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply({ unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true }] }) };
    const gap = await run('revenue and the weather in Philadelphia', unmodeled, []);
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') expect(gap.gap).toBe('not_modeled');
  });
});

describe('a concept is discovery, not an identity (A-005)', () => {
  const source: VocabularySource = {
    ...jaffle,
    relations: [
      ...(jaffle.relations ?? []),
      { schema: 'dev', name: 'customers', columns: [{ name: 'customer_id', dataType: 'VARCHAR' }, { name: 'customer_name', dataType: 'VARCHAR' }] },
    ],
    concepts: [{ id: 'shopper', domain: 'commerce', name: 'Shopper', synonyms: ['buyer'], bindings: [{ entityRef: 'relation:dev.customers', domain: 'commerce', role: 'canonical', grain: 'customer_id' }, { entityRef: 'relation:dev.orders', domain: 'commerce', role: 'conformed', grain: 'order_id' }] }],
  };
  const vocabulary = buildVocabularyIndex(source);
  it('renders the concept card and resolves its synonym, but never admits it as a measure, grouping, display or filter', () => {
    expect(vocabulary.renderCards({ seeds: ['shopper'] })).toContain('concept:commerce.shopper');
    expect(vocabulary.resolve('buyer', ['concept'])?.ref).toBe('concept:commerce.shopper');
    expect(vocabulary.resolve('shopper', ['dimension', 'entity', 'column'])).toBeUndefined();
  });
  it('a concept ref in a grouping becomes one material clarification listing the bindings, and the grouping is not executed on a binding chosen by the host', () => {
    const validation = validateIntentRefs(parseIntent({
      version: 1, kind: 'analytics', reading: 'revenue by shopper', measures: [{ ref: 'metric:order_item.revenue' }],
      groupBy: [{ ref: 'concept:commerce.shopper', role: 'key' }], display: ['concept:commerce.shopper'], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!, vocabulary);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.groupBy).toEqual([]);
    expect(validation.intent.display).toEqual([]);
    expect(validation.intent.unresolved).toEqual([expect.objectContaining({ clause: 'Shopper', material: true, options: ['relation:dev.customers', 'relation:dev.orders'] })]);
    expect(validation.intent.unresolved[0]!.question).toContain('known under several keys');
    expect(validation.intent.unresolved[0]!.question).toContain('customer_id, commerce');
  });
  it('a concept with one binding is not a choice: no options, and its definition goes with the clause instead of "which of them"', () => {
    const single = buildVocabularyIndex({ ...source, concepts: [{ id: 'member', domain: 'commerce', name: 'Loyalty member', description: 'A customer with an active loyalty enrolment.', bindings: [{ entityRef: 'relation:dev.customers', domain: 'commerce', role: 'canonical', grain: 'customer_id' }] }] });
    const validation = validateIntentRefs(parseIntent({
      version: 1, kind: 'analytics', reading: 'revenue by loyalty member', measures: [{ ref: 'metric:order_item.revenue' }],
      groupBy: [{ ref: 'concept:commerce.member', role: 'key' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!, single);
    expect(validation.intent.groupBy).toEqual([]);
    expect(validation.intent.unresolved).toEqual([expect.objectContaining({ clause: 'Loyalty member', material: true, options: [] })]);
    expect(validation.intent.unresolved[0]!.question).not.toMatch(/several keys|which of them/i);
    expect(validation.intent.unresolved[0]!.question).toContain('active loyalty enrolment');
  });
});

describe('a part the policy or a concept answered for is covered (item 6 of the NBA validation)', () => {
  const vocabulary = buildVocabularyIndex({
    ...jaffle,
    dimensions: [...(jaffle.dimensions ?? []), { name: 'participated', model: 'order_item', dataType: 'boolean', physical: { relation: 'dev.order_items', column: 'participated' } }],
    concepts: [{ id: 'participating_item', domain: 'commerce', name: 'Participating order item', synonyms: ['appearance'], bindings: [{ entityRef: 'relation:dev.orders', domain: 'commerce' }] }],
  });
  const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:order_item.participated', op: 'eq', values: [true], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  it('"participating" is met by a filter on "participated", and by the policy text that added it', () => {
    expect(unmetFacets('total revenue, including revenue and only participating rows', intent, vocabulary)).toEqual([]);
    const bare = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(unmetFacets('total revenue, including revenue and only participating rows', bare, vocabulary, { policyTexts: ['added dimension:order_item.participated eq true'] })).toEqual([]);
    expect(unmetFacets('total revenue, including revenue and the weather', bare, vocabulary)).toEqual(['the weather']);
    expect(facetStem('participating')).toBe(facetStem('participated'));
    expect(facetStem('participation')).toBe(facetStem('participated'));
  });

  it('credits a used measure only when its bound expression or dbt lineage embodies a listed facet', () => {
    const expressionVocabulary = buildVocabularyIndex({
      metrics: [
        { name: 'points_scored', model: 'player_game', label: 'Points scored', aggregation: 'sum', description: 'Participating appearances are important.', physical: { relation: 'dev.player_game', expr: 'SUM(CASE WHEN "dev"."player_game"."participated" = TRUE THEN "dev"."player_game"."points" ELSE 0 END)', aggregate: 'sum' } },
        { name: 'games_played', model: 'player_game', label: 'Games played', aggregation: 'count_distinct', physical: { relation: 'dev.player_game', expr: 'COUNT(DISTINCT "dev"."player_game"."game_id")', aggregate: 'count_distinct' } },
      ],
      relations: [{ schema: 'dev', name: 'player_game', columns: [{ name: 'points' }, { name: 'participated' }, { name: 'game_id' }] }],
    });
    const reading = parseIntent({
      version: 1, kind: 'analytics', reading: 'x',
      measures: [{ ref: 'metric:player_game.points_scored' }, { ref: 'metric:player_game.games_played' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }).intent!;
    expect(unmetFacets('Show games played and points, including only games he participated in.', reading, expressionVocabulary)).toEqual([]);

    const proseOnly = buildVocabularyIndex({
      metrics: [
        { name: 'points_scored', model: 'player_game', label: 'Points scored', aggregation: 'sum', description: 'Participating appearances are important.', physical: { relation: 'dev.player_game', expr: 'SUM("dev"."player_game"."points")', aggregate: 'sum' } },
        { name: 'games_played', model: 'player_game', label: 'Games played', aggregation: 'count_distinct', physical: { relation: 'dev.player_game', expr: 'COUNT(DISTINCT "dev"."player_game"."game_id")', aggregate: 'count_distinct' } },
      ],
      relations: [{ schema: 'dev', name: 'player_game', columns: [{ name: 'points' }, { name: 'participated' }, { name: 'game_id' }] }],
    });
    expect(unmetFacets('Show games played and points, including only games he participated in.', reading, proseOnly)).toEqual(['only games he participated in']);

    const lineageVocabulary = buildVocabularyIndex({
      metrics: [
        { name: 'won_games', model: 'season', label: 'Won games', aggregation: 'sum', physical: { relation: 'dev.season', expr: 'SUM("dev"."season"."wins")', aggregate: 'sum' } },
        { name: 'games_played', model: 'season', label: 'Games played', aggregation: 'count', physical: { relation: 'dev.season', expr: 'COUNT("dev"."season"."game_id")', aggregate: 'count' } },
      ],
      relations: [{ schema: 'dev', name: 'season', columns: [{ name: 'wins' }, { name: 'game_id' }], columnLineage: { wins: ['team_won'] } }],
    });
    const lineageReading = parseIntent({
      version: 1, kind: 'analytics', reading: 'x',
      measures: [{ ref: 'metric:season.won_games' }, { ref: 'metric:season.games_played' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }).intent!;
    expect(unmetFacets('Show won games, including only games the team won.', lineageReading, lineageVocabulary)).toEqual([]);
  });
});

describe('the ledger names the relations an execution read, joins or not (item 7 of the NBA validation)', () => {
  it('an AI-written statement over one table records that table under used.relations and no join', async () => {
    const vocabulary = buildVocabularyIndex({ relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'order_total', dataType: 'NUMBER' }] }] });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total order value.', measures: [{ ref: 'column:dev.orders.order_total', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const outcome = await runAskPipeline({ question: 'total order value', vocabulary, provider, explorationAuto: true, clauseCoverage: false, prepareDeps: { draftSql: async () => ({ sql: 'SELECT SUM(order_total) AS order_total FROM dev.orders', relations: ['dev.orders'], proof: [] }) }, executeDeps: { run: async () => ({ columns: ['order_total'], rows: [{ order_total: 5 }], rowCount: 1, executionTimeMs: 1 }) } });
    expect(outcome.kind).toBe('answered');
    expect(outcome.receipt.context?.used?.relations).toEqual(['dev.orders']);
    expect(outcome.receipt.context?.used?.joins).toEqual([]);
  });
});

describe('a reading may not add a breakdown the question did not ask for', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const grouped = (question: string) => validateIntentRefs(parseIntent({
    version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }],
    groupBy: [{ ref: 'entity:products.product', role: 'key' }], display: ['dimension:products.product_name'], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
  }).intent!, vocabulary, undefined, question);
  it('"beverage revenue" is a total: a product grouping is sent back; "by product", "top products" and a named field keep it', () => {
    expect(grouped('beverage revenue').problems.map((problem) => problem.path)).toEqual(['groupBy']);
    expect(grouped('beverage revenue by product').problems).toEqual([]);
    expect(grouped('top beverage products').problems).toEqual([]);
    expect(grouped('beverage revenue for each product name').problems).toEqual([]);
    expect(grouped('which products sell the most beverages').problems).toEqual([]);
    // A word the reading cannot account for may be the breakdown, misspelt.
    expect(grouped('I need to get the bevereage catogery').problems).toEqual([]);
    expect(grouped('show scoring leaders').problems).toEqual([]);
  });
  it('a certified block that breaks the measure down, named as the measure of a total question, is sent back with the metric to read instead', () => {
    const byBlock = validateIntentRefs(parseIntent({
      version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'block:commerce.top_beverage_customers' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!, vocabulary, undefined, 'beverage revenue');
    expect(byBlock.problems).toEqual([expect.objectContaining({ path: 'measures', message: expect.stringContaining('breaks the measure down by customer_name'), suggestions: expect.arrayContaining(['metric:order_item.drink_revenue']) })]);
    expect(validateIntentRefs(parseIntent({
      version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'block:commerce.top_beverage_customers' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking',
    }).intent!, vocabulary, undefined, 'top customers by beverage revenue').problems).toEqual([]);
  });
});

describe('no partial answers: a clause nothing models stays material', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a material clause with no options is never demoted', () => {
    const next = intent({
      measures: [{ ref: 'metric:order_item.revenue' }],
      unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true, question: 'What is weather?' }],
    });
    applyGovernedDefaults(next, 'revenue and the weather in Philadelphia', vocabulary);
    expect(next.unresolved[0]!.material).toBe(true);
  });
  it('the gap names the reading that was answerable, and executes nothing', async () => {
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Total revenue alongside the weather.', measures: [{ ref: 'metric:order_item.revenue' }],
      groupBy: [], display: [], filters: [], unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true }], provenance: {}, expectedShape: 'scalar',
    });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'total revenue and the weather in Philadelphia', vocabulary, provider, prepareDeps: {},
      executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') {
      expect(outcome.gap).toBe('not_modeled');
      expect(outcome.text).toMatch(/Answerable from this reading: .*Revenue/);
    }
    expect(executed).toBe(0);
  });
});

describe('an empty aggregate under any restriction is not an answer', () => {
  const base = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' };
  const candidate = { tier: 'semantic' as const, trust: 'governed' as const, sql: 'SELECT SUM(x) AS revenue FROM t', proof: [] };
  const nullRow = async () => ({ columns: ['revenue'], rows: [{ revenue: null }], rowCount: 1, executionTimeMs: 1 });
  it('a null scalar under a time window names the window', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2027-01-01', end: '2028-01-01' } } }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: "SELECT SUM(x) AS revenue FROM t WHERE ordered_at >= '2027-01-01' AND ordered_at < '2028-01-01'" }, windowed, { run: nullRow });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('no_rows_matched');
      expect(outcome.message).toMatch(/no rows fell inside the window 2027-01-01\.\.2028-01-01/);
      expect(outcome.cause).toEqual({ kind: 'window', start: '2027-01-01', end: '2028-01-01' });
    }
  });
  it('nulls beside a zero count under a member literal are no rows at all; plain zeros are a member who scored nothing', async () => {
    const named = parseIntent({ ...base, measures: [{ ref: 'metric:order_item.revenue' }, { ref: 'metric:customers.customers' }], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Curry'], source: 'question' }] }).intent!;
    const sql = "SELECT SUM(x) AS revenue, COUNT(DISTINCT c) AS customers FROM t WHERE customer_name = 'Curry'";
    const mixed = await executeCandidate({ ...candidate, sql }, named, { run: async () => ({ columns: ['revenue', 'customers'], rows: [{ revenue: null, customers: 0 }], rowCount: 1, executionTimeMs: 1 }) });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.cause).toEqual({ kind: 'member', literals: ['Curry'] });
    const zeros = await executeCandidate({ ...candidate, sql }, named, { run: async () => ({ columns: ['revenue', 'customers'], rows: [{ revenue: 0, customers: 0 }], rowCount: 1, executionTimeMs: 1 }) });
    expect(zeros.ok).toBe(true);
  });
  it('a null scalar under a boolean scope names the predicate', async () => {
    const scoped = parseIntent({ ...base, measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }] }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: 'SELECT SUM(x) AS revenue FROM t WHERE is_drink_item' }, scoped, { run: nullRow });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/no rows matched the restriction on dimension:order_item.is_drink_item/);
  });
  it('zero rows under a window is the same gap: an engine that filters before aggregating returns nothing, not null', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: 'SELECT SUM(x) AS revenue FROM t WHERE ordered_at >= ? AND ordered_at < ?', params: ['2031-01-01', '2032-01-01'] }, windowed, { run: async () => ({ columns: ['revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toEqual({ kind: 'window', start: '2031-01-01', end: '2032-01-01' });
  });
  it('a query that does not bind the window bounds never runs', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }).intent!;
    let ran = 0;
    const outcome = await executeCandidate(candidate, windowed, { run: async () => { ran += 1; return { columns: ['revenue'], rows: [{ revenue: 637444 }], rowCount: 1, executionTimeMs: 1 }; } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.code).toBe('filter_not_applied'); expect(outcome.message).toMatch(/does not apply the time window 2031-01-01\.\.2032-01-01/); }
    expect(ran).toBe(0);
  });
  it('an unrestricted null scalar or empty result is still an answer: the table is empty', async () => {
    const outcome = await executeCandidate(candidate, parseIntent(base).intent!, { run: nullRow });
    expect(outcome.ok).toBe(true);
    const empty = await executeCandidate(candidate, parseIntent(base).intent!, { run: async () => ({ columns: ['revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) });
    expect(empty.ok).toBe(true);
  });
});

describe('calendar cells render as dates, never through the host timezone', () => {
  it('a UTC-midnight instant is the calendar day; other values are untouched', () => {
    expect(formatValue('2025-03-01T00:00:00.000Z')).toBe('2025-03-01');
    expect(formatValue('2025-03-01T00:00:00Z')).toBe('2025-03-01');
    expect(formatValue(new Date('2025-12-01T00:00:00.000Z'))).toBe('2025-12-01');
    expect(formatValue('2025-03-01T13:45:00.000Z')).toBe('2025-03-01T13:45:00.000Z');
    expect(formatValue(1234.5)).toBe('1234.50');
    expect(formatValue('Philadelphia')).toBe('Philadelphia');
  });
});

describe('a question word is covered when the used measure embodies it', () => {
  const source: VocabularySource = {
    metrics: [{ name: 'drink_revenue', model: 'order_item', label: 'Drink Revenue', description: 'The revenue from drinks in each order.', aggregation: 'sum', expr: 'SUM(case when is_drink_item then product_price else 0 end)' }],
    dimensions: [{ name: 'is_drink_item', model: 'order_item', dataType: 'boolean' }],
    terms: [{ name: 'Beverage', description: 'Filter on products.is_drink_item = true for beverage analysis.' }],
  };
  const local = buildVocabularyIndex(source);
  it('"beverage" is covered by drink_revenue through the term that names is_drink_item', () => {
    const used = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(uncoveredQuestionTerms('total beverage revenue', used, local)).toEqual([]);
  });
  it('a term whose definition the used measures do not embody is still reported', () => {
    const withoutRule = buildVocabularyIndex({ ...source, terms: [{ name: 'Beverage', description: 'Drinks sold at the counter.' }] });
    const used = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(uncoveredQuestionTerms('total beverage revenue', used, withoutRule)).toEqual(['beverage']);
  });
});

describe('coverage is satisfied through lineage and the reading\'s own names; the rest is a restriction or a question (Codex E03/E09)', () => {
  const source: VocabularySource = {
    metrics: [
      { name: 'wins', model: 'team_season', label: 'Wins', aggregation: 'sum', expr: 'SUM(CASE WHEN team_won THEN 1 ELSE 0 END)', physical: { relation: 'dev.team_facts', expr: 'SUM(CASE WHEN "dev"."team_facts"."team_won" THEN 1 ELSE 0 END)', aggregate: 'sum' } },
      { name: 'losses', model: 'team_season', label: 'Losses', aggregation: 'sum', expr: 'SUM(CASE WHEN team_lost THEN 1 ELSE 0 END)' },
      { name: 'games', model: 'team_season', label: 'Games', aggregation: 'count', expr: 'COUNT(game_id)' },
    ],
    relations: [{ schema: 'dev', name: 'team_facts', columns: [{ name: 'team_won', dataType: 'BOOLEAN' }, { name: 'team_lost', dataType: 'BOOLEAN' }, { name: 'game_id', dataType: 'INTEGER' }] }],
  };
  const local = buildVocabularyIndex(source);
  const reading = (measures: Array<Record<string, unknown>>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures, groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  it('"team_won" is satisfied by the wins metric whose expression embodies it', () => {
    expect(uncoveredQuestionTerms('Using team-game rows where team_won=true and source season=2017, show the top five team nicknames by count of those rows', reading([{ ref: 'metric:team_season.wins' }]), local)).toEqual([]);
  });
  it('"losses" is satisfied by a measure the reading itself named losses', () => {
    expect(uncoveredQuestionTerms('show wins, losses and win percentage', reading([{ ref: 'metric:team_season.wins' }, { ref: 'column:dev.team_facts.team_lost', aggregation: 'sum', alias: 'losses' }]), local)).toEqual([]);
  });
  it('"team_won" is satisfied through the season model\'s column lineage when wins is a STORED column — and only for that column', () => {
    const stored = buildVocabularyIndex({
      metrics: [{ name: 'wins', model: 'team_season', label: 'Wins', aggregation: 'sum', physical: { relation: 'TRANSFORMED.local_team_season_facts', expr: 'SUM("TRANSFORMED"."local_team_season_facts"."wins")', aggregate: 'sum' } }],
      relations: [{ schema: 'TRANSFORMED', name: 'local_team_season_facts', columns: [{ name: 'wins', dataType: 'INTEGER' }, { name: 'home_games', dataType: 'INTEGER' }], columnLineage: { wins: ['team_won'], home_games: ['is_home'] } },
        { schema: 'TRANSFORMED', name: 'local_team_game_facts', columns: [{ name: 'team_won', dataType: 'BOOLEAN' }, { name: 'is_home', dataType: 'BOOLEAN' }] }],
    });
    const wins = reading([{ ref: 'metric:team_season.wins' }]);
    expect(uncoveredQuestionTerms('team-game rows where team_won=true in source season 2017, top five by count', wins, stored)).toEqual([]);
    // is_home feeds home_games, not wins: a restriction on it is NOT satisfied by reading wins.
    expect(uncoveredQuestionTerms('wins where is_home = true', wins, stored)).toEqual(['is_home']);
  });
  it('a restriction the reading did not apply is UNSATISFIED; a word merely mentioned is UNCERTAIN', () => {
    const dropped = uncoveredQuestionTerms('count of team-game rows where team_won = true', reading([{ ref: 'metric:team_season.games' }]), local);
    expect(dropped).toEqual(['team_won']);
    expect(coverageStates('count of team-game rows where team_won = true', dropped)).toEqual([{ word: 'team_won', state: 'unsatisfied' }]);
    const mentioned = uncoveredQuestionTerms('show wins and losses by team', reading([{ ref: 'metric:team_season.wins' }]), local);
    expect(mentioned).toEqual(['losses']);
    expect(coverageStates('show wins and losses by team', mentioned)).toEqual([{ word: 'losses', state: 'uncertain' }]);
    expect(coverageStates('only losses, please', ['losses'])).toEqual([{ word: 'losses', state: 'unsatisfied' }]);
  });
});

describe('retrieve, then re-ask: a clause left unresolved while naming a relation is a retrieval gap first', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [{ schema: 'ada', name: 'ada_sfdc_opportunity', columns: [{ name: 'opportunity_id', dataType: 'VARCHAR' }, { name: 'amount', dataType: 'NUMBER', description: 'Opportunity amount' }, { name: 'opportunity_outcome', dataType: 'VARCHAR' }, { name: 'close_date', dataType: 'DATE' }] }],
  });
  const first = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Count of lost opportunities. The project has opportunity relations (ada.ada_sfdc_opportunity) but no column or metric for it is exposed.', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [{ clause: 'lost opportunities count', options: [], material: true, question: 'Can you confirm the exact column?' }], provenance: {} });
  const second = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Count of lost opportunities', measures: [{ ref: 'column:ada.ada_sfdc_opportunity.opportunity_id', aggregation: 'count', scope: [{ ref: 'column:ada.ada_sfdc_opportunity.opportunity_outcome', op: 'eq', values: ['lost'], source: 'question' }] }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'column:ada.ada_sfdc_opportunity.opportunity_id': 'q:lost opportunities count' } });
  it('the interpreter is sent the relation\'s columns once and reads the clause with them', async () => {
    const seen: string[] = [];
    const provider = { name: 'scripted', available: async () => true, generate: async (messages: Array<{ role: string; content: string }>) => { seen.push(messages.at(-1)!.content); return seen.length === 1 ? first : second; } };
    const expanded: string[][] = [];
    const result = await resolveIntent({
      question: 'Lost opportunities count', vocabulary, provider: provider as never, maxAttempts: 2,
      renderedCards: { refs: ['relation:ada.ada_sfdc_opportunity'], rendered: {}, chars: {}, totalChars: 0, truncated: [], text: '' } as never,
      expand: async (need) => { expanded.push(need.clauses); return { vocabulary, cards: ['- column:ada.ada_sfdc_opportunity.opportunity_outcome [text]', '- column:ada.ada_sfdc_opportunity.amount [numeric] Opportunity amount'], note: 'discovery' }; },
    });
    expect(expanded).toEqual([['lost opportunities count']]);
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.measures[0]?.ref).toBe('column:ada.ada_sfdc_opportunity.opportunity_id');
    expect(seen[1]).toContain('were not shown before');
    expect(seen[1]).toContain('a COUNT of things is');
    expect(seen[1]).toContain('column:ada.ada_sfdc_opportunity.amount');
  });
  it('with nothing new to show, the clarification stands', async () => {
    const provider = { name: 'scripted', available: async () => true, generate: async () => first };
    const result = await resolveIntent({ question: 'Lost opportunities count', vocabulary, provider: provider as never, maxAttempts: 2, expand: async () => undefined });
    expect(result.status).toBe('clarify');
  });
});

describe('a wrong time axis is corrected with the real date fields, and a repeated miss is a question, not a dead end', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'lost_amount', model: 'opportunity', aggregation: 'sum', physical: { relation: 'ada.ada_sfdc_opportunity', expr: 'SUM(ada.ada_sfdc_opportunity.amount)', aggregate: 'sum' } }],
    dimensions: [
      { name: 'close_date', model: 'opportunity', dataType: 'date', isTime: true, physical: { relation: 'ada.ada_sfdc_opportunity', column: 'close_date' } },
      { name: 'metric', model: 'ccu_daily', dataType: 'string', physical: { relation: 'sm.ccu_daily', column: 'metric' } },
      { name: 'usage_date', model: 'ccu_daily', dataType: 'date', isTime: true, physical: { relation: 'sm.ccu_daily', column: 'usage_date' } },
    ],
  });
  const wrong = { version: 1, kind: 'analytics', reading: 'lost amount by month', measures: [{ ref: 'metric:opportunity.lost_amount' }], groupBy: [{ ref: 'dimension:ccu_daily.metric', role: 'time', grain: 'month' }], display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {} };
  it('the correction suggests the measure\'s own date first', () => {
    const validation = validateIntentRefs(parseIntent(wrong).intent!, vocabulary);
    const problem = validation.problems.find((item) => /not a time dimension/.test(item.message))!;
    expect(problem.suggestions).toEqual(['dimension:opportunity.close_date', 'dimension:ccu_daily.usage_date']);
    expect(timeAxesFor(parseIntent(wrong).intent!, vocabulary)[0]).toBe('dimension:opportunity.close_date');
  });
  it('two readings with the same wrong axis end in a clarification listing the dates', async () => {
    const provider = { name: 'scripted', available: async () => true, generate: async () => JSON.stringify(wrong) };
    const result = await resolveIntent({ question: 'lost amount by month', vocabulary, provider: provider as never, maxAttempts: 2 });
    expect(result.status).toBe('clarify');
    if (result.status === 'clarify') {
      expect(result.options).toEqual(['dimension:opportunity.close_date', 'dimension:ccu_daily.usage_date']);
      expect(result.question).toContain('Which of these should it use');
    }
  });
});

describe('a restriction every measure carries is the population', () => {
  it('two measures scoped identically to drink items become a population filter; a scope only one carries stays a scope', () => {
    const shared = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [
      { ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [true] }] },
      { ref: 'metric:order_item.order_items', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [true] }, { ref: 'dimension:order_item.is_food_item', op: 'is_false', values: [false] }] },
    ], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }).intent!;
    promoteSoleMeasureScope(shared);
    expect(shared.filters.map((p) => p.ref)).toEqual(['dimension:order_item.is_drink_item']);
    expect(shared.measures[0]!.scope).toBeUndefined();
    expect(shared.measures[1]!.scope?.map((p) => p.ref)).toEqual(['dimension:order_item.is_food_item']);
    expect(shared.provenance['filter:dimension:order_item.is_drink_item']).toContain('every measure carries');
    const different = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [
      { ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [true] }] },
      { ref: 'metric:order_item.order_items' },
    ], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }).intent!;
    promoteSoleMeasureScope(different);
    expect(different.filters).toEqual([]);
    expect(different.measures[0]!.scope).toHaveLength(1);
  });
});

describe('a time window without an axis', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const windowed = (measure: string) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: measure }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', time: { window: { start: '2031-01-01', end: '2032-01-01', expression: 'in 2031' } } }).intent!;
  it("is bound to the measure's own time axis when the model has exactly one, and says so", () => {
    const next = validateIntentRefs(windowed('metric:order_item.revenue'), vocabulary);
    expect(next.intent.time?.ref).toBe('dimension:order_item.ordered_at');
    expect(next.intent.provenance['dimension:order_item.ordered_at']).toMatch(/host:time window "in 2031"/);
  });
  it('stays unbound when the model declares no time dimension', () => {
    const next = validateIntentRefs(windowed('metric:customers.lifetime_spend'), vocabulary);
    expect(next.intent.time?.ref).toBeUndefined();
  });
});

describe('contract v1.1: derived ratio and population', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const legacy = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', limit: 10, ordering: { ref: 'measure:0', direction: 'desc' } };
  it('an intent without the new fields parses and fingerprints exactly as before', () => {
    const parsed = parseIntent(legacy).intent!;
    expect(parsed.population).toBeUndefined();
    expect(parsed.measures[0]!.derived).toBeUndefined();
    // Pinned: the execution fingerprint of this legacy intent must never move.
    expect(intentExecutionFingerprint(parsed)).toBe(intentExecutionFingerprint(parseIntent({ ...legacy, population: 'matching' }).intent!));
    expect(intentExecutionFingerprint(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(intentExecutionFingerprint(parseIntent({ ...legacy, population: 'all' }).intent!)).not.toBe(intentExecutionFingerprint(parsed));
  });
  it('a derived ratio needs no ref: one is synthesized, and its parts are its refs', () => {
    const parsed = parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }] }).intent!;
    expect(parsed.measures[0]).toEqual({ ref: 'ratio:metric:order_item.revenue/metric:orders.orders', derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' });
    expect(intentRefs(parsed)).toEqual(['dimension:customers.customer_name', 'entity:customers.customer', 'metric:order_item.revenue', 'metric:orders.orders']);
    expect(describeIntent(parsed, (ref) => ref.split('.').pop()!)).toMatch(/^revenue per orders/);
    expect(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue' } }] }).errors[0]?.path).toBe('measures[0].derived');
  });
  it('ratio parts are canonicalised as metrics or measures; a column part needs its aggregation', () => {
    const ok = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }] }).intent!, vocabulary);
    expect(ok.intent.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
    expect(ok.intent.measures[0]!.ref).toBe('ratio:metric:order_item.revenue/metric:orders.orders');
    const bad = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'column:dev.orders.order_total', denominator: 'metric:orders.orders' } }] }).intent!, vocabulary);
    expect(bad.problems.some((problem) => problem.path === 'measures[0].derived.numerator' && /needs numeratorAggregation/.test(problem.message))).toBe(true);
    const column = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'column:dev.orders.order_total', numeratorAggregation: 'sum', denominator: 'column:dev.orders.order_id', denominatorAggregation: 'count_distinct' } }] }).intent!, vocabulary);
    expect(column.problems).toEqual([]);
  });
  it('population "all" rewrites the key to the entity\'s primary owner and needs a key', () => {
    const source: VocabularySource = {
      metrics: [{ name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } }],
      entities: [
        { name: 'location', model: 'orders', type: 'foreign', physical: { relation: 'dev.orders', column: 'location_id' } },
        { name: 'location', model: 'locations', type: 'primary', physical: { relation: 'dev.locations', column: 'location_id' } },
      ],
      dimensions: [{ name: 'location_name', model: 'locations', dataType: 'string', physical: { relation: 'dev.locations', column: 'location_name' } }],
    };
    const local = buildVocabularyIndex(source);
    const base = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:orders.order_total' }], display: ['dimension:locations.location_name'], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', population: 'all' };
    const rewritten = validateIntentRefs(parseIntent({ ...base, groupBy: [{ ref: 'entity:orders.location', role: 'key' }] }).intent!, local);
    expect(rewritten.problems).toEqual([]);
    expect(rewritten.intent.groupBy[0]!.ref).toBe('entity:locations.location');
    expect(rewritten.intent.provenance['entity:locations.location']).toMatch(/host:population "all"/);
    const keyless = validateIntentRefs(parseIntent({ ...base, groupBy: [] }).intent!, local);
    expect(keyless.problems.some((problem) => /exactly one entity key/.test(problem.message))).toBe(true);
  });
});

describe('time roles under one window', () => {
  const source: VocabularySource = {
    metrics: [
      { name: 'revenue', model: 'order_item', aggregation: 'sum', aggTimeDimension: 'ordered_at', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
      { name: 'orders', model: 'orders', aggregation: 'count', aggTimeDimension: 'ordered_at', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_id"', aggregate: 'count' } },
      { name: 'customers', model: 'customers', aggregation: 'count_distinct', aggTimeDimension: 'first_ordered_at', physical: { relation: 'dev.customers', expr: '"dev"."customers"."customer_id"', aggregate: 'count_distinct' } },
    ],
    dimensions: [
      { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } },
      { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.orders', column: 'ordered_at' } },
      { name: 'first_ordered_at', model: 'customers', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.customers', column: 'first_ordered_at' } },
      { name: 'metric_time', model: 'order_item', dataType: 'timestamp', isTime: true },
    ],
  };
  const local = buildVocabularyIndex(source);
  const windowed = (measures: unknown[], time: Record<string, unknown> = {}, provenance: Record<string, string> = {}) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures, groupBy: [], display: [], filters: [], unresolved: [], provenance, expectedShape: 'scalar', time: { ...time, window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } } }).intent!;
  it('the card says which time a metric aggregates over', () => {
    expect(local.get('metric:customers.customers')?.timeRef).toBe('dimension:customers.first_ordered_at');
    expect(local.renderCards()).toMatch(/metric:customers\.customers \[[^\]]*time first_ordered_at/);
  });
  it('one shared role (the same-named order date on two models) becomes the window axis, and a metric_time axis is replaced by it', () => {
    const intent = windowed([{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }]);
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBe('dimension:order_item.ordered_at');
    expect(intent.unresolved).toEqual([]);
    const kept = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.orders' }], { ref: 'dimension:orders.ordered_at' }, { 'dimension:orders.ordered_at': 'q:in 2025' });
    proveTimeRoles(kept, local);
    expect(kept.time?.ref).toBe('dimension:orders.ordered_at');
    expect(intent.provenance['dimension:order_item.ordered_at']).toMatch(/host:time window "in 2025"/);
    const generic = windowed([{ ref: 'metric:order_item.revenue' }], { ref: 'dimension:order_item.metric_time' });
    proveTimeRoles(generic, local);
    expect(generic.time?.ref).toBe('dimension:order_item.ordered_at');
  });
  it('two roles become one bounded clarification, never a silent choice', () => {
    const intent = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:customers.customers' }]);
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBeUndefined();
    expect(intent.unresolved).toHaveLength(1);
    expect(intent.unresolved[0]).toMatchObject({ clause: 'in 2025', material: true, options: ['dimension:order_item.ordered_at', 'dimension:customers.first_ordered_at'] });
    expect(intent.unresolved[0]!.question).toMatch(/different time for these measures/);
  });
  it('an axis the question named itself is kept and the difference is disclosed', () => {
    const intent = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:customers.customers' }], { ref: 'dimension:customers.first_ordered_at' }, { 'dimension:customers.first_ordered_at': 'q:first acquired in 2025' });
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBe('dimension:customers.first_ordered_at');
    expect(intent.unresolved).toEqual([]);
    expect(intent.provenance['dimension:customers.first_ordered_at']).toMatch(/applies on first_ordered_at to every measure/);
  });
  it('the semantic tier compiles both parts of a ratio and divides after execution; ordering by the ratio is relational', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const bound = bindSemanticRequest(intent, local);
    expect(bound.request?.metrics).toEqual(['revenue', 'orders']);
    expect(bound.derived).toEqual([{ alias: 'aov', numerator: 'revenue', denominator: 'orders' }]);
    const windowedRatio = { ...intent, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } }, provenance: { 'dimension:order_item.ordered_at': 'host:time window "in 2025" applied on the measures\' time role' } };
    expect(bindSemanticRequest(windowedRatio, local).request?.filters).toEqual([{ dimension: 'order_item.ordered_at', operator: 'gte', values: ['2025-01-01'] }, { dimension: 'order_item.ordered_at', operator: 'lt', values: ['2026-01-01'] }]);
    // On MetricFlow and dbt Cloud a host-chosen window is every metric's own aggregation time.
    expect(bindSemanticRequest(windowedRatio, local, 'metricflow-cli').request?.filters?.map((filter) => filter.dimension)).toEqual(['metric_time', 'metric_time']);
    expect(bindSemanticRequest(windowedRatio, local, 'native').request?.filters?.map((filter) => filter.dimension)).toEqual(['order_item.ordered_at', 'order_item.ordered_at']);
    // A month trend over a measure's own aggregation time is `metric_time` on
    // MetricFlow (offset metrics resolve only on it), ordered by the same item.
    const trend = { ...intent, measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time' as const, grain: 'month' as const }], ordering: { ref: 'dimension:order_item.ordered_at', direction: 'asc' as const }, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-07-01', end: '2025-09-01' } } };
    const onMetricFlow = bindSemanticRequest(trend, local, 'metricflow-cli').request!;
    expect(onMetricFlow.timeDimension).toEqual({ name: 'metric_time', granularity: 'month' });
    expect(onMetricFlow.orderBy).toEqual([{ name: 'metric_time', direction: 'asc' }]);
    expect(onMetricFlow.filters?.map((filter) => filter.dimension)).toEqual(['metric_time', 'metric_time']);
    const onNative = bindSemanticRequest(trend, local, 'native').request!;
    expect(onNative.timeDimension).toEqual({ name: 'order_item.ordered_at', granularity: 'month' });
    expect(onNative.orderBy).toEqual([{ name: 'order_item.ordered_at', direction: 'asc' }]);
    // A time the question chose on another model stays concrete everywhere.
    const cohort = { ...trend, groupBy: [{ ref: 'dimension:customers.first_ordered_at', role: 'time' as const, grain: 'year' as const }], ordering: undefined, time: undefined };
    expect(bindSemanticRequest(cohort, local, 'metricflow-cli').request?.timeDimension).toEqual({ name: 'customers.first_ordered_at', granularity: 'year' });
    const ordered = bindSemanticRequest({ ...intent, ordering: { ref: 'measure:0', direction: 'desc' } }, local);
    expect(ordered.refusal?.message).toMatch(/ordering by the ratio/);
    const population = bindSemanticRequest({ ...intent, population: 'all' }, local);
    expect(population.refusal?.code).toBe('not_semantic');
    const divided = applyDerivedColumns({ columns: ['revenue', 'orders'], rows: [{ revenue: 546503, orders: 53559 }, { revenue: 10, orders: 0 }], rowCount: 2, executionTimeMs: 1 }, bound.derived!);
    expect(divided.columns).toEqual(['aov']);
    expect(divided.rows[0]!.aov).toBeCloseTo(10.2038, 3);
    expect(divided.rows[1]!.aov).toBeNull();
    const kept = applyDerivedColumns({ columns: ['revenue', 'orders'], rows: [{ revenue: 4, orders: 2 }], rowCount: 1, executionTimeMs: 1 }, [{ alias: 'aov', numerator: 'revenue', denominator: 'orders', keepInputs: true }]);
    expect(kept.columns).toEqual(['revenue', 'orders', 'aov']);
  });
});

describe('a derived metric card shows what it divides', () => {
  it('renders the formula and the time role, so a lifetime ratio is never mistaken for a period one', () => {
    const local = buildVocabularyIndex({ metrics: [{ name: 'average_order_value', model: 'customers', label: 'Average Order Value', type: 'derived', expr: 'lifetime_spend_pretax / count_lifetime_orders', aggTimeDimension: 'first_ordered_at', description: 'LTV pre-tax / number of orders' }] });
    expect(local.renderCards()).toMatch(/metric:customers\.average_order_value \[[^\]]*time first_ordered_at\] = lifetime_spend_pretax \/ count_lifetime_orders LTV pre-tax/);
  });
});

describe('the units contract of a result', () => {
  const source: VocabularySource = {
    metrics: [
      { name: 'revenue', model: 'order_item', label: 'Revenue', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
      { name: 'orders', model: 'orders', aggregation: 'count', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_id"', aggregate: 'count' } },
      { name: 'drink_revenue_pct', model: 'order_item', type: 'ratio', expr: 'drink_revenue / revenue' },
      { name: 'revenue_growth_mom', model: 'order_item', type: 'derived', displayFormat: { kind: 'percent', decimals: 1 } },
      { name: 'order_total', model: 'orders', aggregation: 'sum', displayFormat: { kind: 'currency', currency: 'USD' } },
      { name: 'order_count_sum', model: 'orders', label: 'Orders placed', aggregation: 'sum', expr: '1', physical: { relation: 'dev.orders', expr: '1', aggregate: 'sum' } },
      { name: 'count_order_items', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."count_order_items"', aggregate: 'sum' } },
    ],
    dimensions: [{ name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } }, { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  };
  const local = buildVocabularyIndex(source);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw }).intent!;
  it('reads currency, counts, ratios, derived formats and time grains from the vocabulary, not from the values', () => {
    const intent = make({
      measures: [{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.orders' }, { ref: 'metric:order_item.drink_revenue_pct' }, { ref: 'metric:order_item.revenue_growth_mom' }, { ref: 'metric:orders.order_total' }, { derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }, { ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: ['dimension:customers.customer_name'],
    });
    const meta = describeResultColumns(intent, { columns: ['customer_id', 'customer_name', 'ordered_at_month', 'revenue', 'orders', 'drink_revenue_pct', 'revenue_growth_mom', 'order_total', 'aov', 'mystery'], rows: [{ mystery: 'x' }] }, local);
    const kinds = Object.fromEntries(meta.map((item) => [item.name, `${item.kind}${item.unit ? `:${item.unit}` : ''}${item.grain ? `@${item.grain}` : ''}`]));
    expect(kinds).toEqual({ customer_id: 'text', customer_name: 'text', ordered_at_month: 'date@month', revenue: 'currency:USD', orders: 'count', drink_revenue_pct: 'percent:fraction', revenue_growth_mom: 'percent:fraction', order_total: 'currency:USD', aov: 'currency:USD', mystery: 'text' });
    expect(meta.find((item) => item.name === 'revenue_growth_mom')?.decimals).toBe(1);
    expect(meta.find((item) => item.name === 'revenue')?.ref).toBe('metric:order_item.revenue');
    const counts = describeResultColumns(make({ measures: [{ ref: 'metric:orders.order_count_sum' }, { ref: 'metric:orders.count_order_items' }] }), { columns: ['order_count_sum', 'count_order_items'], rows: [] }, local);
    expect(counts.map((item) => item.kind)).toEqual(['count', 'count']);
    const growth = buildVocabularyIndex({ metrics: [{ name: 'revenue_growth_mom', model: 'order_item', type: 'derived', expr: '(current_revenue - revenue_prev_month)*100/revenue_prev_month' }] });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:order_item.revenue_growth_mom' }] }), { columns: ['revenue_growth_mom'], rows: [] }, growth)[0]).toMatchObject({ kind: 'percent', unit: 'percentage_points' });
  });
  it('an aggregated Boolean is a number, and only an unaggregated Boolean is a flag (Codex E09)', () => {
    const booleans = buildVocabularyIndex({
      metrics: [{ name: 'losses', model: 'team_season', aggregation: 'sum', dataType: 'boolean', physical: { relation: 'dev.team_facts', expr: 'SUM("dev"."team_facts"."team_lost")', aggregate: 'sum' } }],
      relations: [{ schema: 'dev', name: 'team_facts', columns: [{ name: 'team_lost', dataType: 'BOOLEAN' }, { name: 'home_game', dataType: 'BOOLEAN' }] }],
    });
    const intent = make({ measures: [{ ref: 'metric:team_season.losses' }, { ref: 'column:dev.team_facts.team_lost', aggregation: 'sum', alias: 'lost_games' }], display: ['column:dev.team_facts.home_game'] });
    const meta = describeResultColumns(intent, { columns: ['losses', 'lost_games', 'home_game'], rows: [{ losses: 24, lost_games: 24, home_game: true }] }, booleans);
    expect(meta.map((item) => `${item.name}:${item.kind}`)).toEqual(['losses:number', 'lost_games:number', 'home_game:boolean']);
  });
  it('a semantic column name that qualifies the dimension still finds its meta', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
    const meta = describeResultColumns(intent, { columns: ['order_item__ordered_at__month', 'revenue'], rows: [] }, local);
    expect(meta[0]).toMatchObject({ name: 'order_item__ordered_at__month', kind: 'date', grain: 'month' });
  });
  it('formatValue renders by the contract: fractions as percentages, points as pp, counts whole', () => {
    expect(formatValue(0.6263, { name: 'x', kind: 'percent', unit: 'fraction' })).toBe('62.6%');
    expect(formatValue(10.84, { name: 'x', kind: 'percent', unit: 'percentage_points' })).toBe('10.8 pp');
    expect(formatValue(2085.0, { name: 'x', kind: 'count' })).toBe('2085');
    expect(formatValue(2735.7, { name: 'x', kind: 'currency', unit: 'USD' })).toBe('2735.70');
    expect(formatValue(2735.7)).toBe('2735.70');
  });
  it('the answer names shared identities and certified caveats', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'] });
    const text = composeAnsweredText(intent, { columns: ['customer_id', 'customer_name', 'revenue'], rows: [{ customer_id: 'a', customer_name: 'Jordan Lee', revenue: 17 }, { customer_id: 'b', customer_name: 'Jordan Lee', revenue: 11 }], rowCount: 2, executionTimeMs: 1 }, local, 'governed', { notes: ['customer_name: "jordan lee" is stored as "Jordan Lee"', 'identity: 2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id'] });
    expect(text).toMatch(/2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id\./);
    expect(text).not.toMatch(/stored as/);
    const certified = composeAnsweredText(intent, { columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1, executionTimeMs: 1 }, local, 'certified', { caveats: ['the block groups by customer_name (a label) with no identity key, so two entities sharing a name would merge; recertify it with the entity key to keep them apart'] });
    expect(certified).toMatch(/Source: a certified saved query\. the block groups by customer_name .* recertify it with the entity key to keep them apart\.$/);
  });

  it('never reads raw UUIDs out: an id beside its name is left to the table, and rows keyed only by UUIDs are said to be', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: [] });
    const brooklyn = '40e6ddd6-b8f6-4e17-8bd6-5e53966809d2';
    const philly = '4b6c2304-2b9e-41e4-942a-cf11a1819378';
    const named = composeAnsweredText(intent, { columns: ['location_id', 'location_name', 'average_order_value'], rows: [{ location_id: brooklyn, location_name: 'Brooklyn', average_order_value: 10.01 }, { location_id: philly, location_name: 'Philadelphia', average_order_value: 11.29 }], rowCount: 2, executionTimeMs: 1 }, local, 'review_required');
    expect(named).toContain('Leading rows: Brooklyn · 10.01 | Philadelphia · 11.29.');
    expect(named).not.toContain(brooklyn);
    const keyed = composeAnsweredText(intent, { columns: ['location_id', 'average_order_value'], rows: [{ location_id: philly, average_order_value: 11.29 }, { location_id: brooklyn, average_order_value: 10.01 }], rowCount: 2, executionTimeMs: 1 }, local, 'review_required');
    expect(keyed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(keyed).toContain('Leading rows: 11.29 | 10.01. The rows are identified by location_id, internal key with no name beside it in this result.');
    // A readable key with no name beside it is still read out (a store number is not a UUID).
    const readable = composeAnsweredText(intent, { columns: ['store_code', 'orders'], rows: [{ store_code: 'BK-1', orders: 3 }, { store_code: 'PH-2', orders: 4 }], rowCount: 2, executionTimeMs: 1 }, local, 'review_required');
    expect(readable).toContain('Leading rows: BK-1 · 3 | PH-2 · 4.');
  });
});

describe('the name wins: a question word that exactly names a metric binds to it', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw }).intent!;
  it('unqualified revenue replaces a confidently chosen sibling, and the provenance says why', () => {
    const intent = make({ measures: [{ ref: 'metric:orders.order_total' }], provenance: { 'metric:orders.order_total': 'q:How much revenue do we have' } });
    applyGovernedDefaults(intent, 'How much revenue do we have?', vocabulary);
    expect(intent.measures[0]!.ref).toBe('metric:order_item.revenue');
    expect(intent.provenance['metric:order_item.revenue']).toMatch(/governed default: the question names the metric "revenue"/);
    expect(intent.reading).toBe('x; measured as Revenue because the question names the metric "revenue".');
  });
  it('a qualifier keeps the gross reading, and a metric the question names by alias stays', () => {
    const gross = make({ measures: [{ ref: 'metric:orders.order_total' }] });
    applyGovernedDefaults(gross, 'How much revenue do we have including tax?', vocabulary);
    expect(gross.measures[0]!.ref).toBe('metric:orders.order_total');
    const beverage = make({ measures: [{ ref: 'metric:order_item.drink_revenue' }] });
    applyGovernedDefaults(beverage, 'what is the beverage revenue', vocabulary);
    expect(beverage.measures[0]!.ref).toBe('metric:order_item.drink_revenue');
  });
  it('the rule also reaches ratio parts and ordering, and never fires when the question names several metrics', () => {
    const ratio = make({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:orders.order_total', denominator: 'metric:orders.orders' }, alias: 'aov' }], ordering: { ref: 'metric:orders.order_total', direction: 'desc' } });
    bindExactNames(ratio, ' what is revenue per order ', new Set(), vocabulary);
    expect(ratio.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
    expect(ratio.measures[0]!.ref).toBe('ratio:metric:order_item.revenue/metric:orders.orders');
    expect(ratio.ordering?.ref).toBe('metric:order_item.revenue');
    const two = make({ measures: [{ ref: 'metric:orders.order_total' }] });
    bindExactNames(two, ' compare revenue and order total ', new Set(), vocabulary);
    expect(two.measures[0]!.ref).toBe('metric:orders.order_total');
  });
  it('a measure whose own name spends the word is kept; only the sibling that does not is rebound', () => {
    // "beverage revenue" read as drink_revenue has used "revenue" (no alias needed).
    const plain = buildVocabularyIndex({ ...jaffle, metrics: jaffle.metrics!.map((metric) => metric.name === 'drink_revenue' ? { ...metric, aliases: [] } : metric) });
    const beverage = make({ measures: [{ ref: 'metric:order_item.drink_revenue' }] });
    bindExactNames(beverage, ' beverage revenue ', new Set(), plain);
    expect(beverage.measures[0]!.ref).toBe('metric:order_item.drink_revenue');
    const both = make({ measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:order_item.drink_revenue' }] });
    bindExactNames(both, ' total revenue and beverage revenue give me both ', new Set(), plain);
    expect(both.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue', 'metric:order_item.drink_revenue']);
  });
  it('an entity noun in the question ("customers") is never the named metric, even without a grouping', () => {
    const intent = make({ measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['new'], source: 'question' }] }, { ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' }] }] });
    bindExactNames(intent, ' how much revenue comes from new versus returning customers ', new Set(), vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue', 'metric:order_item.revenue']);
    expect(intent.measures[0]!.scope?.[0]?.values).toEqual(['new']);
  });
  it('a ratio or derived metric the question names never rebinds the parts of a composed ratio', () => {
    const withAov = buildVocabularyIndex({ ...jaffle, metrics: [...jaffle.metrics!, { name: 'average_order_value', model: 'customers', label: 'Average Order Value', type: 'ratio', expr: 'lifetime_spend_pretax / count_lifetime_orders', aggregation: 'sum' }] });
    const ratio = make({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'average_order_value' }] });
    bindExactNames(ratio, ' what is the average order value ', new Set(), withAov);
    expect(ratio.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
  });
});

describe('a restriction on the only measure restricts the population', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw }).intent!;
  const scope = [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }];
  it('the sole scoped measure becomes a population filter with host provenance', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue', scope }], groupBy: [{ ref: 'entity:order_item.product', role: 'key' }] });
    applyGovernedDefaults(intent, 'beverage revenue by product', vocabulary);
    expect(intent.measures[0]!.scope).toBeUndefined();
    expect(intent.filters).toEqual(scope);
    expect(intent.provenance['filter:dimension:order_item.is_drink_item']).toMatch(/restricts the population/);
  });
  it('two measures, a ratio, or an explicit whole population keep their scopes', () => {
    const two = make({ measures: [{ ref: 'metric:order_item.revenue', scope }, { ref: 'metric:order_item.revenue' }] });
    applyGovernedDefaults(two, 'beverage revenue and revenue', vocabulary);
    expect(two.measures[0]!.scope).toEqual(scope);
    const all = make({ measures: [{ ref: 'metric:order_item.revenue', scope }], groupBy: [{ ref: 'entity:order_item.product', role: 'key' }], population: 'all' });
    applyGovernedDefaults(all, 'beverage revenue for every product', vocabulary);
    expect(all.measures[0]!.scope).toEqual(scope);
    expect(all.filters).toEqual([]);
  });
});

describe('full-question applicability', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:orders.order_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'trend', ...raw }).intent!;
  it('why and where-to-invest are unsupported operations: a material clause, nothing executes', () => {
    const intent = make({});
    proveClauseCoverage('Why is our revenue down by region, and which region should we invest in?', intent, vocabulary);
    expect(intent.unresolved).toHaveLength(2);
    expect(intent.unresolved[0]).toMatchObject({ material: true, kind: 'unsupported', options: [] });
    expect(intent.unresolved[0]!.question).toMatch(/Research can investigate/);
    // The dropped breakdown is named too, even though the month grouping stands.
    expect(intent.unresolved[1]).toMatchObject({ clause: 'by region', kind: 'not_modeled' });
    const monthly = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
    proveClauseCoverage('revenue by region', monthly, vocabulary);
    expect(monthly.unresolved[0]).toMatchObject({ clause: 'by region', kind: 'not_modeled' });
  });
  it('a breakdown noun nothing models, dropped by the interpreter, is a named gap; one the intent groups by is not', () => {
    const dropped = make({});
    proveClauseCoverage('show revenue by region', dropped, vocabulary);
    expect(dropped.unresolved[0]).toMatchObject({ clause: 'by region', material: true, kind: 'not_modeled' });
    const grouped = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }] });
    proveClauseCoverage('revenue by segment', grouped, vocabulary);
    // Not a gap: at most a stated substitution, never a blocking clause.
    expect(grouped.unresolved.every((clause) => !clause.material)).toBe(true);
    const month = make({ measures: [{ ref: 'metric:order_item.revenue' }] });
    proveClauseCoverage('revenue by month', month, vocabulary);
    expect(month.unresolved).toEqual([]);
  });
  it('the pipeline ends an unsupported clause as a gap that names it and the answerable reading, executing nothing', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly gross revenue trend.', measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'trend' });
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Why is our revenue down by region, and which region should we invest in?', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply }, prepareDeps: {}, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') { expect(outcome.gap).toBe('unsupported'); expect(outcome.text).toMatch(/Research can investigate/); expect(outcome.text).toMatch(/Answerable from this reading/); }
    expect(executed).toBe(0);
    const branch = await runAskPipeline({ question: 'Beverage revenue is high because a few products dominate', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking' }) }, prepareDeps: {}, executeDeps: { run: async () => ({ columns: ['drink_revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) }, clauseCoverage: false });
    // A hypothesis "because ..." is not a why-question: no unsupported clause, the branch prepares normally.
    expect(branch.kind === 'gap' ? branch.gap : 'prepared').not.toBe('unsupported');
    expect(branch.receipt.intent?.unresolved).toEqual([]);
  });
});

describe('definitions in the answer', () => {
  it('a grouped dimension with a governed description is defined in one sentence', () => {
    const local = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum' }],
      dimensions: [{ name: 'customer_type', model: 'customers', dataType: 'string', label: 'Customer type', description: "Options are 'new' or 'returning', indicating if a customer has ordered more than once or has only placed their first order." }],
    });
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }).intent!;
    const text = composeAnsweredText(intent, { columns: ['customer_type', 'revenue'], rows: [{ customer_type: 'new', revenue: 100 }, { customer_type: 'returning', revenue: 900 }], rowCount: 2, executionTimeMs: 1 }, local, 'governed');
    expect(text).toMatch(/Definitions: Customer type: Options are 'new' or 'returning'/);
  });
});

describe('a provider timeout is retried once, under the same run, when the budget allows', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const good = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [],
    expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' },
  });
  const timeout = () => Object.assign(new Error('The AI model did not respond within 60 seconds.'), { code: 'provider_timeout', detail: 'Retry, choose a faster model, or increase ZLENS_SUBSCRIPTION_CLI_TIMEOUT_MS.' });
  function flaky(failures: number, error: () => Error = timeout): AgentProvider & { calls: number } {
    const provider = {
      name: 'ollama', calls: 0, available: async () => true,
      generate: async () => { provider.calls += 1; if (provider.calls <= failures) throw error(); return good; },
    };
    return provider;
  }
  it('the typed code travels through the structured reply', async () => {
    const { generateStructured } = await import('../providers/structured-output.js');
    const reply = await generateStructured(flaky(1), [{ role: 'user', content: 'q' }], {});
    expect(reply.error).toBe('provider_error');
    expect(reply.code).toBe('provider_timeout');
    expect(reply.detail).toContain('did not respond within 60 seconds');
    expect(reply.detail).toContain('ZLENS_SUBSCRIPTION_CLI_TIMEOUT_MS');
  });
  it('one timeout then an answer is one resolution of two dispatches', async () => {
    const provider = flaky(1);
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider, budgetMs: 150_000, onDispatch: (event) => dispatches.push(event.purpose) });
    expect(result.status).toBe('resolved');
    expect(provider.calls).toBe(2);
    expect(dispatches).toEqual(['resolve', 'correct']);
  });
  it('a second timeout ends the turn with the typed code', async () => {
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider: flaky(2), budgetMs: 150_000 });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') { expect(result.code).toBe('provider_timeout'); expect(result.attempts).toBe(2); }
  });
  it('no retry without room for another full dispatch, and none for other provider failures', async () => {
    const provider = flaky(1);
    const short = await resolveIntent({ question: 'revenue', vocabulary, provider, budgetMs: 60_000 });
    expect(short.status).toBe('failed');
    expect(provider.calls).toBe(1);
    const other = flaky(1, () => new Error('Claude Code exited before producing an answer'));
    const failed = await resolveIntent({ question: 'revenue', vocabulary, provider: other, budgetMs: 150_000 });
    expect(failed.status).toBe('failed');
    expect(other.calls).toBe(1);
    if (failed.status === 'failed') expect(failed.code).toBeUndefined();
  });
  it('an empty exit is retried once like a timeout; a usage limit is never retried and keeps its code', async () => {
    const exit = () => Object.assign(new Error('Claude Code exited before producing an answer.'), { code: 'provider_exit', detail: 'empty reply' });
    const recovered = flaky(1, exit);
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider: recovered, budgetMs: 150_000 });
    expect(result.status).toBe('resolved');
    expect(recovered.calls).toBe(2);
    const quota = flaky(5, () => Object.assign(new Error("The AI model's usage limit is reached."), { code: 'provider_quota', detail: "You've hit your session limit · resets 12pm (America/Chicago)" }));
    const limited = await resolveIntent({ question: 'revenue', vocabulary, provider: quota, budgetMs: 150_000 });
    expect(limited.status).toBe('failed');
    expect(quota.calls).toBe(1);
    if (limited.status === 'failed') expect(limited.code).toBe('provider_quota');
    const outcome = await runAskPipeline({ question: 'revenue', vocabulary, provider: flaky(5, () => Object.assign(new Error('x'), { code: 'provider_quota', detail: 'resets 12pm' })), prepareDeps: {}, executeDeps: { run: async () => { throw new Error('must not execute'); } }, deadlineMs: 150_000 });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') { expect(outcome.text).toContain('usage limit is reached'); expect(outcome.text).toContain('resets 12pm'); expect(outcome.receipt.failure?.reason).toBe('provider_quota'); expect(outcome.receipt.dispatches[0]?.promptChars).toBeGreaterThan(100); }
  });
  it('does not retry an authentication failure and preserves its reauthentication action', async () => {
    const auth = flaky(5, () => Object.assign(
      new Error('Claude Code needs authentication. Re-authenticate with `claude /login`, then retry.'),
      { code: 'provider_auth', detail: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.' },
    ));
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider: auth, budgetMs: 150_000 });
    expect(result.status).toBe('failed');
    expect(auth.calls).toBe(1);
    if (result.status === 'failed') expect(result.code).toBe('provider_auth');
    const outcome = await runAskPipeline({
      question: 'revenue',
      vocabulary,
      provider: flaky(5, () => Object.assign(
        new Error('Claude Code needs authentication.'),
        { code: 'provider_auth', detail: 'OAuth access token has expired. Re-authenticate to continue.' },
      )),
      prepareDeps: {},
      executeDeps: { run: async () => { throw new Error('must not execute'); } },
      deadlineMs: 150_000,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.text).toContain('needs authentication');
      expect(outcome.text).toContain('OAuth access token has expired');
      expect(outcome.receipt.failure?.reason).toBe('provider_auth');
    }
  });
  it('the pipeline says it in one sentence and keeps the provider words in the receipt', async () => {
    const outcome = await runAskPipeline({ question: 'revenue', vocabulary, provider: flaky(3), prepareDeps: {}, executeDeps: { run: async () => { throw new Error('must not execute'); } }, deadlineMs: 150_000 });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.text).toBe('This could not be completed while reading the question: the AI model took too long to read the question; retry the same question');
    expect(outcome.text).not.toContain('ZLENS_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(outcome.receipt.failure?.reason).toBe('provider_timeout');
    expect(outcome.receipt.failure?.message).toContain('ZLENS_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(outcome.receipt.dispatches).toHaveLength(2);
  });
});

describe('a compiler refusal reaches the reader as one line', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  it('the gap text carries the first line of the engine message and the receipt keeps it whole', async () => {
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Revenue by customer name', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], display: [], filters: [],
      expectedShape: 'grouped', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:customers.customer_name': 'q:customer name' },
    });
    const engineMessage = 'Dimension customer_name is not reachable from order_item\n  Traceback (most recent call last):\n    File "metricflow/query.py", line 12\n  ValueError: unresolvable';
    const outcome = await runAskPipeline({
      question: 'revenue by customer name', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply },
      prepareDeps: { compileSemantic: async () => { throw new Error(engineMessage); } }, executeDeps: { run: async () => { throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.gap).toBe('unsupported');
    expect(outcome.message).toBe('the semantic engine could not compile this reading: Dimension customer_name is not reachable from order_item');
    expect(outcome.text).not.toContain('Traceback');
    expect(outcome.receipt.refusals.find((refusal) => refusal.code === 'semantic_compile_failed')?.message).toBe(engineMessage);
  });
});

describe('a governed semantic route that fails at runtime falls back to review-required SQL', () => {
  // F3/F4 (ZLens 0.1.0 e2e): the semantic engine failing for a runtime reason
  // (no compatible dimensions from a runtime that cannot read the metric) is
  // not an answer about the data. With AI-written SQL allowed, the question is
  // answered from the tables, review-required, and says why the metric did not run.
  const vocabulary = buildVocabularyIndex(jaffle);
  it('drafts from the schema after the semantic engine fails, and names the engine failure', async () => {
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Revenue by customer name', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], display: [], filters: [],
      expectedShape: 'grouped', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:customers.customer_name': 'q:customer name' },
    });
    const drafted: string[] = [];
    const outcome = await runAskPipeline({
      question: 'revenue by customer name', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply }, clauseCoverage: false, explorationAuto: true,
      prepareDeps: {
        compileSemantic: async () => { throw Object.assign(new Error('Local MetricFlow returned no compatible dimensions for the selected metrics.'), { code: 'SEMANTIC_RUNTIME_REQUIRED' }); },
        draftSql: async (draft) => { drafted.push(draft.reason ?? ''); return { sql: 'SELECT customer_name, SUM(order_total) AS revenue FROM dev.orders GROUP BY customer_name', relations: ['dev.orders'], proof: [] }; },
      },
      executeDeps: { run: async () => ({ columns: ['customer_name', 'revenue'], rows: [{ customer_name: 'Ann', revenue: 10 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(drafted).toHaveLength(1);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('exploratory');
    expect(outcome.candidate.trust).toBe('review_required');
    expect(outcome.receipt.refusals.some((refusal) => refusal.tier === 'semantic')).toBe(true);
    expect(outcome.text).toContain('review the SQL before relying on the numbers');
  });
});

describe('a year the question names is never served as an all-time total', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const bare = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue for 2024', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } });
  const windowed = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue for 2024', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:order_item.ordered_at': 'q:2024' }, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2024-01-01', end: '2025-01-01', expression: '2024' } } });
  it('the window accounts for its years; a missing window leaves the year unaccounted', () => {
    expect(droppedYears('revenue in 2024', parseIntent(JSON.parse(windowed)).intent!, vocabulary)).toEqual([]);
    expect(droppedYears('revenue in 2024', parseIntent(JSON.parse(bare)).intent!, vocabulary)).toEqual(['2024']);
    expect(droppedYears('top 10 customers', parseIntent(JSON.parse(bare)).intent!, vocabulary)).toEqual([]);
  });
  it('the interpreter is sent back once for the window, then the complete intent resolves', async () => {
    const provider = scripted([bare, windowed]);
    const result = await resolveIntent({ question: 'revenue in 2024', vocabulary, provider });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.time?.window?.start).toBe('2024-01-01');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.at(-1)!.content).toMatch(/names the period "2024"/);
  });
  it('a second reading without the window ends as a gap, never a scalar', async () => {
    const outcome = await runAskPipeline({ question: 'revenue in 2024', vocabulary, provider: scripted([bare, bare]), prepareDeps: {}, executeDeps: { run: async () => { throw new Error('must not execute'); } } });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.text).toMatch(/2024/);
  });
});

describe('a label-only certified block is the answer of last resort, after the repair re-ask', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const namesBlock = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'block:commerce.top_beverage_customers' }], groupBy: [], display: [], filters: [], expectedShape: 'ranking', unresolved: [], provenance: { 'block:commerce.top_beverage_customers': 'q:top customers beverage' } });
  const keyed = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking', unresolved: [], provenance: { 'metric:order_item.drink_revenue': 'q:beverage', 'entity:customers.customer': 'q:customers' } });
  const executed = { columns: ['customer_name', 'beverage_revenue'], rows: [{ customer_name: 'A', beverage_revenue: 1 }], rowCount: 1, executionTimeMs: 1 };
  it('an interpreter that re-expresses the analysis by entity gets the keyed governed answer', async () => {
    const provider = scripted([namesBlock, keyed]);
    const outcome = await runAskPipeline({ question: 'who are the top customers for beverage', vocabulary, provider, prepareDeps: { blockSql: (ref) => (ref === 'block:commerce.top_beverage_customers' ? TOP_BEVERAGE_SQL : undefined), compileSemantic: async () => ({ sql: 'SELECT 1', engine: 'native' }) }, executeDeps: { run: async () => executed } });
    expect(provider.calls).toHaveLength(2);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.trust).toBe('governed');
  });
  it('an interpreter that keeps naming the block gets the block as published, with the identity caveat, not a gap', async () => {
    const provider = scripted([namesBlock, namesBlock]);
    const outcome = await runAskPipeline({ question: 'who are the top customers for beverage', vocabulary, provider, prepareDeps: { blockSql: (ref) => (ref === 'block:commerce.top_beverage_customers' ? TOP_BEVERAGE_SQL : undefined) }, executeDeps: { run: async () => executed } });
    expect(provider.calls).toHaveLength(2);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.candidate.trust).toBe('governed');
    expect(outcome.candidate.proof.join(' ')).toMatch(/served as published because no keyed governed answer could be composed/);
    expect(outcome.text).toMatch(/recertify it with the entity key/);
    expect(outcome.receipt.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message))).toBe(false);
  });
});

describe('the original question is preserved through every repair (the obligation ledger)', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const base = { version: 1, kind: 'analytics', groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking' };
  // The first reading names the gap AND carries an invented ref, so the interpreter is sent back once (as NB15 was).
  const firstReading = JSON.stringify({ ...base, reading: 'Which customers had the most double-doubles', measures: [], display: ['dimension:customers.custmer_name'], unresolved: [{ clause: 'double-doubles', options: [], material: true, question: 'Double-doubles are not modeled.' }] });
  const blockReading = JSON.stringify({ ...base, reading: 'Top beverage customers as the closest available measure', measures: [{ ref: 'block:commerce.top_beverage_customers' }], unresolved: [] });
  const monthly = JSON.stringify({ ...base, reading: 'Revenue by month', expectedShape: 'trend', measures: [{ ref: 'metric:order_item.revnue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
  const ranking = JSON.stringify({ ...base, reading: 'Top beverage customers', measures: [{ ref: 'block:commerce.top_beverage_customers' }] });
  it('the ledger records the first reading; a block never discharges a clause through closeness', () => {
    const first = parseIntent(JSON.parse(firstReading)).intent!;
    const ledger = buildLedger('Which customers had the most double-doubles in 2017?', first, vocabulary);
    expect(ledger.clauses).toEqual([{ clause: 'double-doubles', question: 'Double-doubles are not modeled.', words: ['double', 'doubles'] }]);
    const audit = auditLedger('', parseIntent(JSON.parse(blockReading)).intent!, ledger, vocabulary);
    expect(audit.dropped.map((item) => item.clause)).toEqual(['double-doubles']);
    const kept = auditLedger('', first, ledger, vocabulary);
    expect(kept.entries[0]).toMatchObject({ clause: 'double-doubles', disposition: 'unresolved' });
  });
  it('a correction that drops the clause is sent back once; a second drop restores it and the turn is a gap with zero SQL', async () => {
    const provider = scripted([firstReading, blockReading, blockReading]);
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Which customers had the most double-doubles in 2017?', vocabulary, provider, prepareDeps: { blockSql: () => TOP_BEVERAGE_SQL }, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toMatch(/double-doubles/i);
    expect(outcome.receipt.ledger?.entries.map((entry) => entry.disposition)).toContain('restored');
    expect(outcome.receipt.ledger?.clauses).toEqual([{ clause: 'double-doubles' }]);
  });
  it('a monthly grain the first reading carried is an obligation: a ranking does not answer a trend', async () => {
    const provider = scripted([monthly, ranking, ranking]);
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Show monthly revenue totals during 2025', vocabulary, provider, prepareDeps: { blockSql: () => TOP_BEVERAGE_SQL }, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.text).toMatch(/month/);
  });
});

describe('a numeric inventory dimension aggregated is a measure over its column', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'pts', model: 'player_game_stats', dataType: 'number', physical: { relation: 'dev.player_game_stats', column: 'pts' } }, { name: 'player_id', model: 'player_game_stats', dataType: 'string', physical: { relation: 'dev.player_game_stats', column: 'player_id' } }],
    relations: [{ schema: 'dev', name: 'player_game_stats', columns: [{ name: 'pts', dataType: 'DOUBLE' }, { name: 'player_id', dataType: 'VARCHAR' }] }],
  });
  it('the dimension ref is read as the column ref when the aggregation makes it a measure', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum' }], groupBy: [{ ref: 'dimension:player_game_stats.player_id', role: 'key' }], display: [], filters: [], ordering: { ref: 'dimension:player_game_stats.pts', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.measures[0]!.ref).toBe('column:dev.player_game_stats.pts');
    expect(validation.intent.ordering?.ref).toBe('column:dev.player_game_stats.pts');
  });
  it('counting a non-numeric column exposed as a dimension is a measure; ordering by a measure alias names that measure', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum', alias: 'total_points' }, { ref: 'dimension:player_game_stats.player_id', aggregation: 'count_distinct', alias: 'players' }], groupBy: [], display: [], filters: [], ordering: { ref: 'total_points', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.measures[1]!.ref).toBe('column:dev.player_game_stats.player_id');
    expect(validation.intent.ordering?.ref).toBe('measure:0');
    const dressed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum', alias: 'total_points' }], groupBy: [], display: [], filters: [], ordering: { ref: 'metric:total_points', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(validateIntentRefs(dressed, vocabulary).intent.ordering?.ref).toBe('measure:0');
    const notNumeric = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.player_id', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(validateIntentRefs(notNumeric, vocabulary).problems.map((problem) => problem.path)).toEqual(['measures[0].ref']);
  });
});

describe('a why/should question over the previous analysis is never answered as small talk', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const prior = parseIntent({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: [], filters: [], limit: 10, unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
  const chat = JSON.stringify({ version: 1, kind: 'conversation', reading: 'A judgment call', reply: 'Melissa Lopez stands out as the one to build around because she leads the ranking.', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  it('delivers the measured comparison and refuses the judgment, never the interpreter\'s own opinion', async () => {
    // A vocabulary the relational tier can actually compose, so the question
    // reaches an answer rather than a binding refusal.
    const composable = buildVocabularyIndex({
      metrics: [{ name: 'points', label: 'Points', aggregation: 'sum', physical: { relation: 'dev.season_facts', column: 'points', aggregate: 'sum' } }],
      dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } }],
    });
    const ranking = parseIntent({ version: 1, kind: 'analytics', reading: 'Top players by points', measures: [{ ref: 'metric:points' }], groupBy: [{ ref: 'dimension:season_facts.player', role: 'categorical' }], display: [], filters: [], ordering: { ref: 'metric:points', direction: 'desc' }, limit: 10, unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
    const opinion = JSON.stringify({ version: 1, kind: 'conversation', reading: 'A judgment call', reply: 'Melissa Lopez stands out as the one to build around because she leads the ranking.', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const outcome = await runAskPipeline({
      question: 'Which of those players should we build our team around, and why?', vocabulary: composable, provider: scripted([opinion]), prior: ranking,
      prepareDeps: { blockSql: () => undefined, compileSemantic: async () => ({ sql: 'SELECT player_name, SUM(points) FROM dev.season_facts GROUP BY 1 ORDER BY 2 DESC LIMIT 10', engine: 'native' }) },
      executeDeps: { run: async () => ({ columns: ['player', 'points'], rows: [{ player: 'Harden', points: 2888 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    // The judgment is named as NOT computed, and the model's own opinion of
    // who "stands out" never reaches the reader.
    expect(outcome.text).toMatch(/not computed here/);
    expect(outcome.text).toMatch(/Research can investigate/);
    expect(outcome.text).not.toMatch(/stands out/);
  });

  it('a greeting with no prior stays a conversation', async () => {
    const result = await resolveIntent({ question: 'why hello there', vocabulary, provider: scripted([chat]) });
    expect(result.status).toBe('conversation');
  });
});

describe('units of a ratio over columns', () => {
  const nba = buildVocabularyIndex({
    relations: [{ schema: 'dev', name: 'player_game_stats', columns: [{ name: 'pts', dataType: 'DOUBLE' }, { name: 'played', dataType: 'INTEGER' }, { name: 'game_id', dataType: 'VARCHAR' }, { name: 'fgm', dataType: 'DOUBLE' }, { name: 'fga', dataType: 'DOUBLE' }] }],
  });
  const make = (alias: string, den: string, denAgg: string) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias, derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.pts', numeratorAggregation: 'sum', denominator: den, denominatorAggregation: denAgg } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  it('points per game is a number; made over attempted with a pct alias is a fraction', () => {
    const rows = { columns: ['points_per_game'], rows: [{ points_per_game: 28.2 }], rowCount: 1, executionTimeMs: 1 };
    expect(describeResultColumns(make('points_per_game', 'column:dev.player_game_stats.game_id', 'count_distinct'), rows, nba)).toEqual([{ name: 'points_per_game', kind: 'number' }]);
    const pct = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias: 'field_goal_pct', derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.fgm', numeratorAggregation: 'sum', denominator: 'column:dev.player_game_stats.fga', denominatorAggregation: 'sum' } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(describeResultColumns(pct, { columns: ['field_goal_pct'], rows: [{ field_goal_pct: 0.51 }], rowCount: 1, executionTimeMs: 1 }, nba)).toEqual([{ name: 'field_goal_pct', kind: 'percent', unit: 'fraction' }]);
  });
});

describe('a monthly breakdown the reading dropped is never served as a scalar', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const windowedScalar = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly revenue for 2025, unclear which revenue', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'trend', time: { window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } }, unresolved: [{ clause: 'revenue by month', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true, question: 'Gross or product revenue?' }], provenance: {} });
  const monthly = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly product revenue for 2025', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], expectedShape: 'trend', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } }, unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } });
  it('the grain is detected, the interpreter is sent back once, and a stubborn reading ends as a material clause', async () => {
    expect(droppedGrain('revenue by month in 2025', parseIntent(JSON.parse(windowedScalar)).intent!, vocabulary)).toBe('month');
    expect(droppedGrain('revenue by month in 2025', parseIntent(JSON.parse(monthly)).intent!, vocabulary)).toBeUndefined();
    const provider = scripted([windowedScalar, monthly]);
    const result = await resolveIntent({ question: 'revenue by month in 2025', vocabulary, provider });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.groupBy[0]).toMatchObject({ role: 'time', grain: 'month' });
    expect(provider.calls).toHaveLength(2);
    const stubborn = await resolveIntent({ question: 'revenue by month in 2025', vocabulary, provider: scripted([windowedScalar, windowedScalar]) });
    expect(stubborn.status).toBe('clarify');
    if (stubborn.status === 'clarify') expect(stubborn.question).toMatch(/month breakdown/);
  });
});

describe('an ungrounded member literal is disclosed as a text match', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    relations: [
      { schema: 'dev', name: 'order_items', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'product_price', dataType: 'DOUBLE' }] },
      { schema: 'dev', name: 'orders', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'customer_id', dataType: 'VARCHAR' }] },
      { schema: 'dev', name: 'customers', columns: [{ name: 'customer_name', dataType: 'VARCHAR' }] },
    ],
  });
  const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: "Stephen Curry's revenue", measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'contains', values: ['Curry'], source: 'question' }], unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' }, expectedShape: 'scalar' });
  it('the answer says the predicate matched text, never that it identified one person', async () => {
    const joinPath = () => [{ relation: 'dev.orders', on: '"dev"."order_items"."order_id" = "dev"."orders"."order_id"' }, { relation: 'dev.customers', on: '"dev"."orders"."customer_id" = "dev"."customers"."customer_id"' }];
    void joinPath;
    const outcome = await runAskPipeline({ question: "Show Curry's revenue", vocabulary, provider: scripted([reply]), prepareDeps: { compileSemantic: async () => ({ sql: "SELECT SUM(product_price) AS revenue FROM dev.order_items JOIN dev.orders USING (order_id) JOIN dev.customers USING (customer_id) WHERE customer_name LIKE '%Curry%'", engine: 'native' }) }, executeDeps: { run: async () => ({ columns: ['revenue'], rows: [{ revenue: 12 }], rowCount: 1, executionTimeMs: 1 }) } });
    if (outcome.kind !== 'answered') throw new Error(`${outcome.kind}: ${JSON.stringify(outcome.receipt.refusals.map((r) => `${r.tier}:${r.code}:${r.message.slice(0, 200)}`))} ${'text' in outcome ? outcome.text : ''}`);
    expect(outcome.text).toMatch(/matched by text containing "Curry"; that can cover several members/);
    expect(outcome.receipt.warehouse).toEqual({ attempts: 1, failures: 0, executions: 1 });
  });
});

describe('a warehouse failure says which kind it was', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    relations: [{ schema: 'dev', name: 'order_items', columns: [{ name: 'product_price', dataType: 'DOUBLE' }] }],
  });
  const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const failing = async (message: string) => {
    const outcome = await runAskPipeline({ question: 'total revenue', vocabulary, provider: scripted([reply]), prepareDeps: { compileSemantic: async () => ({ sql: 'SELECT SUM(product_price) AS revenue FROM dev.order_items', engine: 'native' }) }, executeDeps: { run: async () => { throw new Error(message); } } });
    if (outcome.kind !== 'failed') throw new Error(`expected a failure, got ${outcome.kind}`);
    return outcome;
  };
  it('classifies the driver message and names the next action, and the receipt keeps the class', async () => {
    expect(classifyWarehouseError('Warehouse \'COMPUTE_WH\' is suspended and cannot be resumed.').class).toBe('warehouse_suspended');
    expect(classifyWarehouseError("Object 'ANALYTICS.DEV.GAMES' does not exist or not authorized.")).toEqual({ class: 'relation_missing', relations: ['ANALYTICS.DEV.GAMES'] });
    expect(classifyWarehouseError('SQL access control error: Insufficient privileges to operate on table \'GAMES\'').class).toBe('relation_denied');
    expect(classifyWarehouseError('syntax error at or near "SELCT"').class).toBe('sql_error');
    const suspended = await failing('Warehouse \'COMPUTE_WH\' is suspended; no active warehouse selected.');
    expect(suspended.text).toMatch(/warehouse is not running.*Resume it/i);
    expect(suspended.receipt.failure?.warehouse?.class).toBe('warehouse_suspended');
    expect(suspended.receipt.warehouse).toEqual({ attempts: 1, failures: 1, executions: 0 });
    const missing = await failing("Object 'ANALYTICS.DEV.ORDER_ITEMS' does not exist or not authorized.");
    expect(missing.text).toMatch(/cannot see ANALYTICS\.DEV\.ORDER_ITEMS.*catalog lists it/i);
    const denied = await failing("Insufficient privileges to operate on table 'ORDER_ITEMS'");
    expect(denied.text).toMatch(/not allowed to read ORDER_ITEMS/i);
    const broken = await failing('syntax error at position 7');
    expect(broken.text).toMatch(/could not be completed on the warehouse: syntax error/);
  });
  it('a provider failure still leaves a receipt that records the failure, so it is never read as a modeling gap', async () => {
    const outcome = await runAskPipeline({ question: 'total revenue', vocabulary, provider: { generate: async () => { throw new Error('the model did not respond'); } } as never, prepareDeps: {}, executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) } });
    expect(outcome.kind).toBe('failed');
    expect(outcome.receipt.failure?.stage).toBe('resolve');
    expect(outcome.receipt.warehouse).toBeUndefined();
  });
});

describe('a warehouse failure names only what the statement wrote', () => {
  // A certified statement over an insurer's claims table, as ZLens wrote it, and the warehouse's words when the host's row
  // rule had rewritten it (the excerpt quotes the rewrite: the rule's predicate and the person's region).
  const written = 'SELECT region, COUNT(*) AS open_claims FROM "harbor"."main"."claims" WHERE status = \'open\' GROUP BY region';
  const drift = 'DuckDB query failed: Binder Error: Referenced column "status" not found in FROM clause!\nCandidate bindings: "claims.loss_date", "claims.claim_type"\nLINE 1: ... OR \'West\' = \'All\')) AS "claims" WHERE status = \'open\' GROUP BY region...\n                                                  ^';
  const aiSql = 'SELECT a.adjuster_id, COUNT(*) AS open_claims FROM "harbor"."main"."claims" c JOIN "harbor"."main"."adjusters" a ON a.adjuster_id = c.adjuster_id WHERE ISNULL(c.status, \'\') = \'open\' GROUP BY 1';
  const unknownFunction = 'DuckDB query failed: Catalog Error: Scalar Function with name isnull does not exist!\nDid you mean "isnan"?\nLINE 1: ...a".adjuster_id = "c".adjuster_id WHERE ISNULL("c".status, \'\') = \'open\' GROUP B...\n                                                  ^\nHint: that table isn\'t in this database — it may be empty or the connection may point at the wrong .duckdb file. Build your dbt models (e.g. `dbt build`) to populate it, then retry.';
  const NOT_TABLES = /\b(West|All|open|status|isnull|isnan|c|a)\b/;

  it('classifies a column or a function the warehouse lacks apart from a missing table, on every engine, naming only the statement\'s own tables', () => {
    expect(classifyWarehouseError(drift, { sql: written })).toEqual({ class: 'column_missing', relations: ['"harbor"."main"."claims"'], column: 'status' });
    expect(classifyWarehouseError(unknownFunction, { sql: aiSql })).toEqual({ class: 'function_missing', relations: [], function: 'isnull' });
    expect(classifyWarehouseError('Binder Error: Values list "c" does not have a column named "status"', { sql: 'SELECT c.status FROM main.claims c' })).toEqual({ class: 'column_missing', relations: ['main.claims'], column: 'status' });
    const cases: Array<[string, string, WarehouseFailure['class'], string[]]> = [
      ['Catalog Error: Table with name claimz does not exist!\nDid you mean "claims"?', 'SELECT * FROM main.claimz', 'relation_missing', ['main.claimz']],
      ['Binder Error: Referenced table "x" not found!\nCandidate tables: "c"', 'SELECT x.region FROM main.claims c', 'sql_error', []],
      // DuckDB, when the table is a subquery (a host's row rule put one in its place).
      ['Binder Error: Values list "c" does not have a column named "status"\nLINE 1: ...WHERE lower("c".status) = \'open\'', 'SELECT a.adjuster_id FROM main.claims c JOIN main.adjusters a ON a.adjuster_id = c.adjuster_id WHERE lower(c.status) = \'open\'', 'column_missing', []],
      ['column "status" does not exist', 'SELECT status FROM public.claims', 'column_missing', ['public.claims']],
      ['function isnull(text, unknown) does not exist', 'SELECT isnull(status, \'\') FROM public.claims', 'function_missing', []],
      ['relation "public.claimz" does not exist', 'SELECT * FROM public.claimz', 'relation_missing', ['public.claimz']],
      ['SQL compilation error:\nerror line 1 at position 7\ninvalid identifier \'C.STATUS\'', 'SELECT c.status FROM claims c', 'column_missing', ['claims']],
      ['SQL compilation error:\nUnknown function ISNULL', 'SELECT ISNULL(status) FROM claims', 'function_missing', []],
      ["SQL compilation error:\nObject 'HARBOR.MAIN.CLAIMZ' does not exist or not authorized.", 'SELECT * FROM harbor.main.claimz JOIN harbor.main.adjusters a ON TRUE', 'relation_missing', ['HARBOR.MAIN.CLAIMZ']],
      ['Unrecognized name: status at [1:40]', 'SELECT status FROM `p.harbor.claims`', 'column_missing', ['`p.harbor.claims`']],
      ['Function not found: isnull at [1:8]', 'SELECT isnull(status) FROM `p.harbor.claims`', 'function_missing', []],
      ['[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter with name `status` cannot be resolved. Did you mean one of the following? [`claim_status`]. SQLSTATE: 42703; line 1 pos 40;\n\'Aggregate [region#1], [region#1, count(1) AS n#2L]\n+- \'Filter (\'status = open)\n   +- SubqueryAlias claims\n      +- Filter ((region#1 = West) OR (West = All))', 'SELECT region, COUNT(*) AS n FROM harbor.claims WHERE status = \'open\' GROUP BY region', 'column_missing', ['harbor.claims']],
    ];
    for (const [message, sql, kind, relations] of cases) {
      const failure = classifyWarehouseError(message, { sql });
      expect(failure.class, message).toBe(kind);
      expect(failure.relations, message).toEqual(relations);
    }
    // Never a literal, an alias, a column or a function named as a table.
    for (const [message, sql] of [[drift, written], [unknownFunction, aiSql], [cases[9]![0], cases[9]![1]]] as const) {
      for (const relation of classifyWarehouseError(message, { sql }).relations) expect(relation).not.toMatch(NOT_TABLES);
    }
    // BigQuery's backquoted path is named by its table.
    const bigquery = classifyWarehouseError('Unrecognized name: status at [1:40]', { sql: 'SELECT status FROM `p.harbor.claims`' });
    expect(composeFailedText('execute', 'Unrecognized name: status at [1:40]', bigquery)).toMatch(/^A column this answer reads \(status\) is not in the claims table on the warehouse\./);
    // A column the warehouse names that the statement does not (a rewrite's own column) is not named.
    expect(classifyWarehouseError('Binder Error: Referenced column "region" not found in FROM clause!', { sql: 'SELECT COUNT(*) FROM main.claims' }).column).toBeUndefined();
  });

  it('without a host the warehouse\'s words follow; with one the answer gives a plain sentence and a reference, never the warehouse\'s words', () => {
    const local = composeFailedText('execute', drift, classifyWarehouseError(drift, { sql: written }));
    expect(local).toMatch(/^A column this answer reads \(status\) is not in the claims table on the warehouse\./);
    expect(local).not.toMatch(/cannot see/);
    expect(local).toContain('The warehouse said: DuckDB query failed');
    const hosted = Object.assign(new Error('Binder Error: Referenced column "status" not found in FROM clause! (reference 0a1b2c3d)'), { warehouseReference: '0a1b2c3d', warehouseDiagnosis: 'DuckDB query failed: Binder Error: Referenced column "status" not found in FROM clause!' });
    const failed = statementFailure(hosted, { sql: written });
    expect(failed.message).toBe('a column this statement reads (status) is not in the claims table on the warehouse (reference 0a1b2c3d)');
    expect(failed.repair).toBe(hosted.warehouseDiagnosis);
    expect(failed.warehouse.reference).toBe('0a1b2c3d');
    const said = composeFailedText('execute', failed.message, failed.warehouse);
    expect(said).toBe('A column this answer reads (status) is not in the claims table on the warehouse. The table may have changed since the answer was defined. Ask your administrator about reference 0a1b2c3d.');
    const fn = statementFailure(Object.assign(new Error('x'), { warehouseReference: 'ffff0000', warehouseDiagnosis: warehouseDiagnosis(unknownFunction) }), { sql: aiSql });
    expect(composeFailedText('execute', fn.message, fn.warehouse)).toBe('The statement calls a function (isnull) that this warehouse does not have. Rephrase the question. Ask your administrator about reference ffff0000.');
    for (const [diagnosis, sql] of [['Catalog Error: Table with name claimz does not exist!', 'SELECT * FROM main.claimz'], ['Parser Error: syntax error at or near "SELEC"', 'SELEC 1'], ["Insufficient privileges to operate on table 'CLAIMS'", 'SELECT * FROM harbor.main.claims'], ["Warehouse 'WH' is suspended.", 'SELECT 1']] as const) {
      const out = statementFailure(Object.assign(new Error('x'), { warehouseReference: '12345678', warehouseDiagnosis: diagnosis }), { sql });
      const text = composeFailedText('execute', out.message, out.warehouse);
      expect(text, diagnosis).toMatch(/Ask your administrator about reference 12345678\.$/);
      expect(text, diagnosis).not.toMatch(/Error|LINE \d|\^|warehouse said|SELEC|dbt build/);
    }
    // The diagnosis stops before the statement excerpt and DQL's single-user advice.
    expect(warehouseDiagnosis(unknownFunction)).toBe('DuckDB query failed: Catalog Error: Scalar Function with name isnull does not exist!\nDid you mean "isnan"?');
  });

  it('a drafted statement the warehouse refuses twice, with a host: the corrective draft gets the diagnosis, the answer and its receipt only the plain sentence', async () => {
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'open_claims', label: 'Open claims', metricType: 'derived', engineOnly: 'a derived metric the relational tier cannot compose' }],
    });
    const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Open claims per adjuster.', measures: [{ ref: 'metric:open_claims' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'table' });
    const previous: Array<{ sql: string; error: string } | undefined> = [];
    let reference = 0;
    const outcome = await runAskPipeline({
      question: 'Which adjusters have the most open claims?', vocabulary, explorationAuto: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => reading },
      prepareDeps: { draftSql: async (input) => { previous.push(input.previous); return { sql: aiSql, relations: ['harbor.main.claims', 'harbor.main.adjusters'], proof: [] }; } },
      executeDeps: { run: async () => { reference += 1; throw Object.assign(new Error('raw words that must not travel'), { warehouseReference: `0000000${reference}`, warehouseDiagnosis: warehouseDiagnosis(unknownFunction) }); } },
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(previous[1]?.error).toBe('DuckDB query failed: Catalog Error: Scalar Function with name isnull does not exist!\nDid you mean "isnan"?');
    expect(outcome.text).toBe('The statement calls a function (isnull) that this warehouse does not have. Rephrase the question. Ask your administrator about reference 00000002.');
    const everything = JSON.stringify(outcome);
    expect(everything).not.toMatch(/Catalog Error|DuckDB query failed|isnan|LINE \d|raw words|dbt build/);
    expect(outcome.receipt.failure?.warehouse).toMatchObject({ class: 'function_missing', reference: '00000002' });
  });
});

describe('a follow-up may not quietly answer for everyone', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [
      { name: 'player_id', model: 'journey', dataType: 'VARCHAR', physical: { relation: 'dev.journey', column: 'player_id' } },
      { name: 'season', model: 'journey', dataType: 'INTEGER', physical: { relation: 'dev.journey', column: 'season' } },
    ],
    relations: [{ schema: 'dev', name: 'journey', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'points' }, { name: 'rebounds' }, { name: 'games_played' }] }],
  });
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw }).intent!;
  const prior = make({
    measures: [{ ref: 'column:dev.journey.points', aggregation: 'sum', alias: 'total_points' }],
    groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }],
    filters: [{ ref: 'dimension:journey.season', op: 'eq', values: ['2017'], source: 'question' }],
    ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10,
  });
  it('names the period, ranking and limit the reading dropped', () => {
    const widened = make({ measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }], groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }] });
    expect(widenedPopulation('Add rebounds for those same players', widened, prior))
      .toEqual(['the restriction on dimension:journey.season', 'the limit of 10', 'the ranking']);
    // Keeping them is not a widening.
    const kept = make({
      measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }],
      groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }],
      filters: [{ ref: 'dimension:journey.season', op: 'eq', values: ['2017'], source: 'inherited' }],
      ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10,
    });
    expect(widenedPopulation('Add rebounds for those same players', kept, prior)).toEqual([]);
    // The user may ask for the wider population.
    expect(widenedPopulation('now show rebounds for all players', widened, prior)).toEqual([]);
    // A new subject accounts for the previous measures as removed.
    const newSubject = make({ measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum' }], provenance: { 'column:dev.journey.points': 'removed:asks about rebounds only' } });
    expect(widenedPopulation('what about rebounds by season', newSubject, prior)).toEqual([]);
  });
  it('the interpreter is corrected once, and a stubborn reading ends as a clarification with zero SQL', async () => {
    const wide = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Rebounds by player', measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }], groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }], display: [], filters: [], unresolved: [], provenance: { 'column:dev.journey.player_id': 'inherited', 'column:dev.journey.points': 'removed:replaced by rebounds' }, expectedShape: 'ranking' });
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'Add total rebounds for those same players', vocabulary, prior, provider: scripted([wide, wide]),
      prepareDeps: { joinPath: () => [] }, executeDeps: { run: async () => { executed += 1; return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }; } },
    });
    expect(executed).toBe(0);
    if (outcome.kind !== 'clarify') throw new Error(`${outcome.kind}: ${JSON.stringify(outcome.receipt.intent?.unresolved ?? [])} dispatches=${outcome.receipt.dispatches.length}`);
    // Either continuity question is safe: the turn ends by asking which
    // population was meant, and no query runs.
    expect(outcome.question).toMatch(/previous analysis (also used|was restricted to)/);
    expect(outcome.question).not.toMatch(/dimension:|column:/);
  });
});

describe('a period named on a field that is not a date', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'season', model: 'journey', dataType: 'INTEGER', physical: { relation: 'dev.journey', column: 'season' } }],
    relations: [{ schema: 'dev', name: 'journey', columns: [{ name: 'season', dataType: 'INTEGER' }, { name: 'points' }] }],
  });
  it('is read as a value on that field instead of failing the whole reading', () => {
    const raw = parseIntent({ version: 1, kind: 'analytics', reading: 'Points in 2017', measures: [{ ref: 'column:dev.journey.points', aggregation: 'sum', alias: 'total_points' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', time: { ref: 'dimension:journey.season', window: { start: '2017-01-01', end: '2018-01-01', expression: 'in 2017' } } }).intent!;
    const validated = validateIntentRefs(raw, vocabulary);
    expect(validated.problems).toEqual([]);
    expect(validated.intent.time).toBeUndefined();
    expect(validated.intent.filters).toEqual([expect.objectContaining({ ref: 'dimension:journey.season', op: 'eq', values: ['2017'] })]);
    expect(validated.intent.provenance['dimension:journey.season']).toMatch(/not a date/);
  });
});

describe('meaning before execution: shares, calendar periods and units', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."total_points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player_id', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
      { name: 'season', model: 'season_facts', dataType: 'number', description: 'Season value carried by the source; it is not silently converted to a calendar year', physical: { relation: 'dev.season_facts', column: 'season' } },
      { name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true, physical: { relation: 'dev.game_facts', column: 'game_date' } },
    ],
    relations: [
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'total_points' }] },
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'game_date', dataType: 'DATE' }, { name: 'points' }] },
    ],
  });
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw }).intent!;
  it('a measure divided by itself becomes a share of the whole period when its name says so, and is sent back otherwise', () => {
    const share = validateIntentRefs(make({ measures: [{ alias: 'share_of_points', derived: { kind: 'ratio', numerator: 'metric:total_points', denominator: 'metric:total_points' } }], groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }] }), vocabulary);
    expect(share.problems).toEqual([]);
    expect(share.intent.measures[0]!.derived?.denominatorScope).toBe('overall');
    expect(share.intent.provenance['measures[0].denominatorScope']).toMatch(/whole period/);
    const rate = validateIntentRefs(make({ measures: [{ alias: 'points_rate', derived: { kind: 'ratio', numerator: 'metric:total_points', denominator: 'metric:total_points' } }] }), vocabulary);
    expect(rate.problems.map((problem) => problem.message)).toEqual([expect.stringMatching(/divided by itself is 1 for every row/)]);
  });
  it('a calendar period restricted on a non-date field is named with the date dimensions that would honour it', () => {
    const seasonal = make({ measures: [{ ref: 'metric:total_points' }], filters: [{ ref: 'dimension:season_facts.season', op: 'in', values: [2016, 2017], source: 'question' }] });
    const basis = calendarBasisProblem('top players by total points in calendar years 2016 and 2017', seasonal, vocabulary);
    expect(basis).toMatchObject({ field: 'dimension:season_facts.season', dates: ['dimension:game_facts.game_date'] });
    expect(basis?.measuresAt[0]).toBe('column:dev.game_facts.points (sum, for metric:total_points)');
    // Without the calendar word the season value is what was asked for.
    expect(calendarBasisProblem('top players by total points in 2017', seasonal, vocabulary)).toBeUndefined();
    // A date restriction honours it.
    const dated = make({ measures: [{ ref: 'metric:total_points' }], time: { ref: 'dimension:game_facts.game_date', window: { start: '2017-01-01', end: '2018-01-01' } } });
    expect(calendarBasisProblem('total points in calendar 2017', dated, vocabulary)).toBeUndefined();
  });
  it('the interpreter is corrected once, then the turn asks which basis was meant, with zero SQL', async () => {
    const seasonal = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Points by season', measures: [{ ref: 'metric:total_points' }], groupBy: [], display: [], filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2017], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'total points in calendar year 2017', vocabulary, provider: scripted([seasonal, seasonal]), prepareDeps: { joinPath: () => [] }, executeDeps: { run: async () => { executed += 1; return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }; } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind === 'clarify') {
      expect(outcome.question).toMatch(/calendar period.*not a date/);
      expect(outcome.options.map((option) => option.ref)).toEqual(['dimension:game_facts.game_date']);
    }
    expect(outcome.receipt.dispatches).toHaveLength(2);
  });
  it('points are a number, never dollars; money words still are', () => {
    const rows = (name: string) => ({ columns: [name], rows: [{ [name]: 12 }], rowCount: 1, executionTimeMs: 1 });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:total_points' }], expectedShape: 'scalar' }), rows('total_points'), vocabulary)[0]).toMatchObject({ name: 'total_points', kind: 'number' });
    const money = buildVocabularyIndex({ metrics: [{ name: 'order_total', aggregation: 'sum' }, { name: 'revenue', aggregation: 'sum' }, { name: 'total_value', aggregation: 'sum' }] });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:order_total' }], expectedShape: 'scalar' }), rows('order_total'), money)[0]!.kind).toBe('currency');
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:revenue' }], expectedShape: 'scalar' }), rows('revenue'), money)[0]!.kind).toBe('currency');
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:total_value' }], expectedShape: 'scalar' }), rows('total_value'), money)[0]!.kind).toBe('number');
  });
});

describe('the same fact at another grain', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."total_points"', aggregate: 'sum' } }],
    relations: [
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id' }, { name: 'total_points', dataType: 'INTEGER' }, { name: 'games_played', dataType: 'INTEGER' }] },
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'game_id', dataType: 'VARCHAR' }, { name: 'game_date', dataType: 'DATE' }, { name: 'points', dataType: 'DOUBLE' }, { name: 'assists', dataType: 'DOUBLE' }] },
    ],
  });
  it('matches a metric and a counted column to the date relation by name stem', () => {
    expect(suggestSameGrainColumns(vocabulary, ['metric:total_points', 'column:dev.season_facts.games_played'], 'dev.game_facts')).toEqual([
      { from: 'metric:total_points', to: 'column:dev.game_facts.points', aggregation: 'sum' },
      { from: 'column:dev.season_facts.games_played', to: 'column:dev.game_facts.game_id', aggregation: 'count_distinct' },
    ]);
    expect(suggestSameGrainColumns(vocabulary, ['column:dev.season_facts.player_id'], 'dev.game_facts')).toEqual([]);
  });
});

describe('the project\'s definition wins over the raw column', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [
      { name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: 'CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."points" ELSE 0 END', aggregate: 'sum' } },
      { name: 'games_played', label: 'Games played', aggregation: 'count_distinct', physical: { relation: 'dev.game_facts', expr: 'CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."game_id" END', aggregate: 'count_distinct' } },
      { name: 'assists_made', label: 'Assists', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."assists"', aggregate: 'sum' } },
      { name: 'assist_total', label: 'Assist total', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."assists"', aggregate: 'sum' } },
    ],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'game_id' }, { name: 'points' }, { name: 'assists' }, { name: 'participated', dataType: 'BOOLEAN' }] }],
  });
  const make = (measures: AnalyticalIntentV1['measures']): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'Points and games in calendar 2017', measures, groupBy: [], display: [], filters: [],
    ordering: { ref: 'column:dev.game_facts.points', direction: 'desc' }, expectedShape: 'ranking', unresolved: [],
    provenance: { 'column:dev.game_facts.points': 'q:total points' },
  });

  it('reads a scoped aggregate through to the column it aggregates', () => {
    expect(scopedColumnOf('CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."points" ELSE 0 END')).toEqual({ column: 'points', scoped: true });
    expect(scopedColumnOf('"dev"."game_facts"."points"')).toEqual({ column: 'points', scoped: false });
    expect(scopedColumnOf('SUM(a) / SUM(b)')).toBeUndefined();
  });

  it('replaces a raw column aggregation by the metric that defines it, and says so when the definition excludes rows', () => {
    const intent = make([
      { ref: 'column:dev.game_facts.points', aggregation: 'sum', alias: 'total_points' },
      { ref: 'column:dev.game_facts.game_id', aggregation: 'count_distinct', alias: 'games_played' },
    ]);
    preferGovernedDefinition(intent, vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:points_scored', 'metric:games_played']);
    expect(intent.measures.every((measure) => measure.aggregation === undefined)).toBe(true);
    expect(intent.ordering!.ref).toBe('metric:points_scored');
    expect(intent.provenance['metric:points_scored']).toContain('governed default: Points scored defines this column');
    expect(intent.reading).toContain('counts only the rows its definition includes');
  });

  it('leaves the raw column alone when the project declares two definitions of it, or none at that aggregation', () => {
    const ambiguous = make([{ ref: 'column:dev.game_facts.assists', aggregation: 'sum', alias: 'assists' }]);
    preferGovernedDefinition(ambiguous, vocabulary);
    expect(ambiguous.measures[0]!.ref).toBe('column:dev.game_facts.assists');
    const otherAggregate = make([{ ref: 'column:dev.game_facts.points', aggregation: 'avg', alias: 'avg_points' }]);
    preferGovernedDefinition(otherAggregate, vocabulary);
    expect(otherAggregate.measures[0]!.ref).toBe('column:dev.game_facts.points');
  });

  it('carries a ratio\'s parts to their governed definitions', () => {
    const intent = make([{ ref: 'ratio:column:dev.game_facts.points/column:dev.game_facts.game_id', alias: 'points_per_game', derived: { kind: 'ratio', numerator: 'column:dev.game_facts.points', numeratorAggregation: 'sum', denominator: 'column:dev.game_facts.game_id', denominatorAggregation: 'count_distinct' } }]);
    preferGovernedDefinition(intent, vocabulary);
    expect(intent.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:points_scored', denominator: 'metric:games_played' });
    expect(intent.measures[0]!.ref).toBe('ratio:metric:points_scored/metric:games_played');
  });
});

describe('a relative period is a population, not a column', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'season', model: 'season_facts', label: 'Source season', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'season' } },
      { name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true, physical: { relation: 'dev.game_facts', column: 'game_date' } },
    ],
  });
  const base: AnalyticalIntentV1 = {
    version: 1, kind: 'analytics', reading: 'Top scorers', measures: [{ ref: 'metric:total_points' }], groupBy: [], display: [], filters: [],
    expectedShape: 'ranking', unresolved: [], provenance: {},
  };

  it('is a problem when the reading restricts no period, however it selects one', () => {
    const selected: AnalyticalIntentV1 = { ...base, measures: [{ ref: 'metric:total_points' }, { ref: 'dimension:season_facts.season', aggregation: 'max', alias: 'current_season' }] };
    expect(relativePeriodProblem('Who are the top scorers this season?', selected, vocabulary)).toMatchObject({ unit: 'season' });
    // A period the question never named is an anchor the reading invented.
    expect(relativePeriodProblem('Who are the top scorers this season?', { ...base, filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2022], source: 'question' }] }, vocabulary)).toMatchObject({ unit: 'season' });
    expect(relativePeriodProblem('Who are the top scorers this season, meaning 2022?', { ...base, filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2022], source: 'question' }] }, vocabulary)).toBeUndefined();
    // A season is not a calendar unit: a window invented for one is world
    // knowledge, not this project's definition.
    expect(relativePeriodProblem('Who are the top scorers this season?', { ...base, time: { ref: 'dimension:game_facts.game_date', window: { start: '2022-10-01', end: '2023-07-01', expression: 'this season' } } }, vocabulary)).toMatchObject({ unit: 'season' });
    // The calendar defines a month, so a window answers "this month".
    expect(relativePeriodProblem('What did we score this month?', { ...base, time: { ref: 'dimension:game_facts.game_date', window: { start: '2022-09-01', end: '2022-10-01', expression: 'this month' } } }, vocabulary)).toBeUndefined();
    expect(relativePeriodProblem('Who are the top scorers in 2017?', base, vocabulary)).toBeUndefined();
  });
});

describe('a clause that asks which ones is answered by identities', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'teams_played', label: 'Teams played', aggregation: 'sum' }],
    dimensions: [{ name: 'team', model: 'team_facts', label: 'Team', dataType: 'number' }, { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string' }],
  });
  const intent = (overrides: Partial<AnalyticalIntentV1>): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'profile', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {}, ...overrides,
  });
  const ledger = { clauses: [{ clause: 'teams (which teams he played for)', words: ['teams', 'which', 'played'], role: 'identity' as const, roleWords: ['teams'] }], measures: [], unaccounted: [] };

  it('reads the identity words out of the clause', () => {
    expect(identityClauseWords('teams (which teams he played for)', vocabulary)).toEqual(['teams']);
    expect(identityClauseWords('how many teams he played for', vocabulary)).toEqual([]);
  });

  it('is not discharged by a measure that counts them, and is discharged by a grouping that names them', () => {
    const counted = intent({ measures: [{ ref: 'metric:teams_played', aggregation: 'sum' }] });
    expect(auditLedger('profile', counted, ledger, vocabulary).entries[0]!.disposition).toBe('dropped');
    const grouped = intent({ groupBy: [{ ref: 'dimension:team_facts.team', role: 'key' }] });
    expect(auditLedger('profile', grouped, ledger, vocabulary).entries[0]!.disposition).toBe('discharged');
  });
});

describe('an answer that could not carry the label the question asked for', () => {
  const label = (ref: string) => ref.split('.').pop()!;
  const intent = (display: string[]): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'teams by wins', measures: [{ ref: 'column:dev.team_season.wins', aggregation: 'sum' }],
    groupBy: [{ ref: 'column:dev.team_season.team_id', role: 'key' }], display, filters: [], expectedShape: 'ranking', unresolved: [], provenance: {},
  });
  const refusals = [{ tier: 'relational' as const, code: 'join_path_required' as const, message: 'no governed join path from dev.team_season to dev.teams', repairable: true }];

  it('names the omission, with the reason the label could not be reached', () => {
    const unmet = unmetDisplayObligation(['column:dev.teams.team_nickname'], intent([]), refusals as never, label);
    expect(unmet?.message).toContain('identified by team_id only');
    expect(unmet?.message).toContain('no governed relationship reaches it');
  });

  it('names the omission for a question that asks WHICH ones, even when no reading asked for the label', () => {
    const unmet = unmetDisplayObligation([], intent([]), [] as never, label, 'Which teams won the most games in the 2017 season?');
    expect(unmet?.message).toContain('no human-readable label');
    // A question that asks for the ids themselves is answered by ids.
    expect(unmetDisplayObligation([], intent([]), [] as never, label, 'Show the team ids and their wins')).toBeUndefined();
    expect(unmetDisplayObligation([], intent([]), [] as never, label, 'How many games were won in 2017?')).toBeUndefined();
  });

  it('says nothing when the label is shown, or when the reading deliberately removed it', () => {
    expect(unmetDisplayObligation(['column:dev.teams.team_nickname'], intent(['column:dev.teams.team_nickname']), refusals as never, label)).toBeUndefined();
    const removed = intent([]);
    removed.provenance['column:dev.teams.team_nickname'] = 'removed:the question asked for ids';
    expect(unmetDisplayObligation(['column:dev.teams.team_nickname'], removed, refusals as never, label)).toBeUndefined();
  });
});

describe('a meaning the user already picked', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', label: 'Total points', aggregation: 'sum' }, { name: 'points_per_game', label: 'Points per game', aggregation: 'avg' }],
    dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string' }],
  });
  const unresolvedIntent = (): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'the best players', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'ranking',
    unresolved: [{ clause: 'best players', material: true, options: ['metric:total_points', 'metric:points_per_game'], question: 'Which measure defines best?' }],
    provenance: {},
  });

  it('carries the chosen ref into the reading, whatever the interpreter wrote', () => {
    const intent = unresolvedIntent();
    applySelectedMeaning(intent, { ref: 'metric:total_points', label: 'Total points' }, vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:total_points']);
    expect(intent.ordering).toEqual({ ref: 'metric:total_points', direction: 'desc' });
    expect(intent.limit).toBe(10);
    expect(intent.unresolved.every((clause) => !clause.material)).toBe(true);
    expect(intent.provenance['metric:total_points']).toContain('clarification');
  });

  it('applies a chosen period basis as the period, drops the basis the user rejected, and adds no breakdown', () => {
    const periodVocabulary = buildVocabularyIndex({
      metrics: [{ name: 'field_goals', label: 'Field goals', aggregation: 'sum' }],
      dimensions: [
        { name: 'season', model: 'season_facts', label: 'Source season', dataType: 'number' },
        { name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true },
      ],
    });
    const intent: AnalyticalIntentV1 = {
      version: 1, kind: 'analytics', reading: 'efficiency in 2017',
      measures: [{ ref: 'metric:field_goals', alias: 'fg' }], groupBy: [], display: [],
      filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2017], source: 'question' }],
      expectedShape: 'ranking', provenance: {},
      unresolved: [{ clause: 'in 2017', material: true, options: ['dimension:season_facts.season', 'dimension:game_facts.game_date'], question: "Does '2017' mean the source season or the calendar year?" }],
    };
    applySelectedMeaning(intent, { ref: 'dimension:game_facts.game_date' }, periodVocabulary);
    expect(intent.time).toEqual({ ref: 'dimension:game_facts.game_date', window: { start: '2017-01-01', end: '2018-01-01', expression: 'in 2017' } });
    expect(intent.filters).toEqual([]);
    expect(intent.groupBy).toEqual([]);
    expect(intent.unresolved.every((clause) => !clause.material)).toBe(true);
  });

  it('groups by a chosen dimension, and never doubles a ref the reading already carries', () => {
    const grouped = unresolvedIntent();
    applySelectedMeaning(grouped, { ref: 'dimension:season_facts.player' }, vocabulary);
    expect(grouped.groupBy).toEqual([{ ref: 'dimension:season_facts.player', role: 'categorical' }]);
    const already: AnalyticalIntentV1 = { ...unresolvedIntent(), measures: [{ ref: 'metric:total_points' }] };
    applySelectedMeaning(already, { ref: 'metric:total_points' }, vocabulary);
    expect(already.measures).toHaveLength(1);
  });

  it('tells the interpreter the choice is made, only when there is one', () => {
    expect(buildIntentSystemPrompt({ cards: '', hasPrior: false, selection: { ref: 'metric:total_points', label: 'Total points' } })).toContain('THE MEANING IS ALREADY CHOSEN');
    expect(buildIntentSystemPrompt({ cards: '', hasPrior: false })).not.toContain('THE MEANING IS ALREADY CHOSEN');
  });
});

describe('a series covers the period it claims', () => {
  const intent = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'monthly points in 2017',
    measures: [{ ref: 'column:dev.game_facts.points', aggregation: 'sum', alias: 'monthly_points' }],
    groupBy: [{ ref: 'dimension:game_facts.game_date', role: 'time', grain: 'month' }],
    display: [], filters: [], expectedShape: 'trend', unresolved: [], provenance: {},
    time: { ref: 'dimension:game_facts.game_date', window: { start: '2017-01-01', end: '2018-01-01', expression: 'calendar 2017' } },
    ...overrides,
  });
  const executed = (months: string[]) => ({
    columns: ['game_date_month', 'monthly_points'],
    rows: months.map((month, index) => ({ game_date_month: `${month}T00:00:00.000Z`, monthly_points: 100 + index })),
    rowCount: months.length, executionTimeMs: 1,
    columnsMeta: [{ name: 'game_date_month', kind: 'date' as const, grain: 'month' }, { name: 'monthly_points', kind: 'number' as const }],
  });

  it('adds the months the warehouse returned nothing for, as zero, in order', () => {
    const filled = fillPeriodGaps(intent(), executed(['2017-01-01', '2017-02-01', '2017-12-01']));
    expect(filled.added).toBe(9);
    expect(filled.result.rowCount).toBe(12);
    expect(filled.result.rows.map((row) => String(row.game_date_month).slice(0, 7))).toEqual([
      '2017-01', '2017-02', '2017-03', '2017-04', '2017-05', '2017-06', '2017-07', '2017-08', '2017-09', '2017-10', '2017-11', '2017-12',
    ]);
    expect(filled.result.rows[6]!.monthly_points).toBe(0);
  });

  it('leaves an average empty rather than calling it zero, and never invents a member', () => {
    const averaged = fillPeriodGaps(intent({ measures: [{ ref: 'column:dev.game_facts.points', aggregation: 'avg', alias: 'avg_points' }] }), {
      ...executed(['2017-01-01']), columns: ['game_date_month', 'avg_points'],
      rows: [{ game_date_month: '2017-01-01T00:00:00.000Z', avg_points: 12 }],
      columnsMeta: [{ name: 'game_date_month', kind: 'date' as const }, { name: 'avg_points', kind: 'number' as const }],
    });
    expect(averaged.result.rows.find((row) => String(row.game_date_month).startsWith('2017-06'))!.avg_points).toBeNull();
    // Another grouping beside the period: which member owns an empty month is not ours to say.
    const grouped = intent({ groupBy: [{ ref: 'dimension:game_facts.game_date', role: 'time', grain: 'month' }, { ref: 'dimension:game_facts.player', role: 'key' }] });
    expect(fillPeriodGaps(grouped, executed(['2017-01-01'])).added).toBe(0);
    // A ranking of periods asks for the top ones, not for all of them.
    expect(fillPeriodGaps(intent({ limit: 3 }), executed(['2017-01-01'])).added).toBe(0);
  });
});

describe('the same field on the relation that carries the period', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } }],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'player_name', dataType: 'VARCHAR' }, { name: 'points', dataType: 'INTEGER' }] }],
  });
  it('moves a name filter to the name column, not to the id that shares its stem', () => {
    expect(suggestSameRelationFields(vocabulary, ['dimension:season_facts.player'], 'dev.game_facts'))
      .toEqual([{ from: 'dimension:season_facts.player', to: 'column:dev.game_facts.player_name' }]);
  });
});

describe('the change the question asked for is a column', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum' }, { name: 'revenue_growth_mom', label: 'Revenue growth', type: 'derived', expr: 'revenue / revenue_prior * 100' }],
    dimensions: [{ name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true }],
  });
  const two = (extra: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'points in 2016 and 2017',
    measures: [{ ref: 'metric:points_scored', alias: 'points_2016' }, { ref: 'metric:points_scored', alias: 'points_2017' }],
    groupBy: [], display: [], filters: [], expectedShape: 'comparison', unresolved: [], provenance: {}, ...extra,
  });

  it('is owed when the reading returns the parts and never subtracts them', () => {
    expect(droppedChange("How did LeBron's total points change from calendar 2016 to calendar 2017? Show the percentage change.", two(), vocabulary)).toBeTruthy();
  });

  it('is discharged by the change measure, by a time breakdown, or by a metric that already means growth', () => {
    const computed = two({ measures: [...two().measures, { ref: 'change:points_2017-points_2016', alias: 'pct', change: { base: 'points_2016', comparison: 'points_2017', as: 'percent' } }] });
    expect(droppedChange('How did points change from 2016 to 2017? Show the percentage change.', computed, vocabulary)).toBeUndefined();
    const trend = two({ groupBy: [{ ref: 'dimension:game_facts.game_date', role: 'time', grain: 'month' }] });
    expect(droppedChange('How did points change month by month?', trend, vocabulary)).toBeUndefined();
    const growthMetric = two({ measures: [{ ref: 'metric:revenue_growth_mom', alias: 'growth' }] });
    expect(droppedChange('What was revenue growth?', growthMetric, vocabulary)).toBeUndefined();
    // One measure is nothing to compare.
    expect(droppedChange('How did points change?', two({ measures: [{ ref: 'metric:points_scored', alias: 'points' }] }), vocabulary)).toBeUndefined();
  });
});

describe('each facet the question listed', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', label: 'Total points', aggregation: 'sum' }, { name: 'double_double_games', label: 'Double-double games', aggregation: 'sum', description: 'A season achievement.' }],
    dimensions: [{ name: 'season', model: 'season_facts', label: 'Source season', dataType: 'number' }, { name: 'teams_played', model: 'season_facts', label: 'Teams played', dataType: 'number' }],
  });
  const profile: AnalyticalIntentV1 = {
    version: 1, kind: 'analytics', reading: 'Grant Jerrett by season',
    measures: [{ ref: 'metric:total_points' }, { ref: 'metric:double_double_games' }, { ref: 'dimension:season_facts.teams_played', aggregation: 'max' }],
    groupBy: [{ ref: 'dimension:season_facts.season', role: 'categorical' }], display: [], filters: [],
    expectedShape: 'grouped', unresolved: [], provenance: {},
  };

  it('names the parts no ref is named for, and passes over the parts that are answered', () => {
    expect(unmetFacets('Give me a complete profile of Grant Jerrett, including his career, teams and achievements.', profile, vocabulary))
      .toEqual(['his career', 'achievements']);
  });

  it('says nothing when the question listed no parts, or every part is carried', () => {
    expect(unmetFacets('Give me a profile of Grant Jerrett.', profile, vocabulary)).toEqual([]);
    expect(unmetFacets('Show his seasons, including total points and teams played.', profile, vocabulary)).toEqual([]);
  });
});

describe('a match that covers several members', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum' }],
    dimensions: [
      { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } },
      { name: 'player_id', model: 'season_facts', label: 'Player ID', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
    ],
  });
  const asked = (op: 'contains' | 'eq' | 'in', values: string[]): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: "Curry's points", measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
    filters: [{ ref: 'dimension:season_facts.player', op, values, source: 'question' }],
    expectedShape: 'scalar', unresolved: [], provenance: {},
  });

  it('groups by the member key and shows the label, so two Currys are two rows', () => {
    const intent = asked('contains', ['Curry']);
    keepMembersApart(intent, vocabulary);
    expect(intent.groupBy).toEqual([{ ref: 'dimension:season_facts.player_id', role: 'key' }]);
    expect(intent.display).toEqual(['dimension:season_facts.player']);
    expect(intent.reading).toContain('several members');
  });

  it('leaves an exact single member, and a reading that already keeps its members apart, alone', () => {
    const exact = asked('eq', ['Stephen Curry']);
    keepMembersApart(exact, vocabulary);
    expect(exact.groupBy).toEqual([]);
    const grouped: AnalyticalIntentV1 = { ...asked('contains', ['Curry']), groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }] };
    keepMembersApart(grouped, vocabulary);
    expect(grouped.groupBy).toHaveLength(1);
  });
});

describe('an empty result names what emptied it', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.season_facts', column: 'points', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } },
      { name: 'fiscal_year', model: 'season_facts', label: 'Fiscal year', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'fiscal_year' } },
    ],
  });
  const run = async (year: number, second: Array<Record<string, unknown>>) => {
    const reading = JSON.stringify({
      version: 1, kind: 'analytics', reading: `Stephen Curry's points in fiscal year ${year}.`,
      measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
      filters: [
        { ref: 'dimension:season_facts.player', op: 'eq', values: ['Stephen Curry'], source: 'question' },
        { ref: 'dimension:season_facts.fiscal_year', op: 'eq', values: [year], source: 'question' },
      ],
      unresolved: [], provenance: {}, expectedShape: 'scalar',
    });
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const outcome = await runAskPipeline({
      question: `Stephen Curry points in fiscal year ${year}`, vocabulary, prepareDeps: { compileSemantic: async (request) => ({ sql: `SELECT SUM(points) AS points_scored FROM dev.season_facts WHERE ${JSON.stringify(request.filters ?? [])}`, engine: 'native' }) },
      provider: { name: 'ollama', available: async () => true, generate: async () => reading },
      executeDeps: { run: async (sql, params) => {
        runs.push({ sql, params: params ?? [] });
        return runs.length === 1 || second.length === 0
          ? { columns: ['points_scored'], rows: [{ points_scored: null }], rowCount: 1, executionTimeMs: 1 }
          : { columns: Object.keys(second[0]!), rows: second, rowCount: second.length, executionTimeMs: 1 };
      } },
      suggestMembers: async () => ['Stephen Curry'],
    });
    return { outcome, runs };
  };

  it('a two-digit year on a year field that matched nothing is read once as 20YY, and the answer says so', async () => {
    const { outcome, runs } = await run(26, [{ points_scored: 2388 }]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(runs).toHaveLength(2);
    expect(runs[1]!.sql).toContain('2026');
    expect(outcome.intent.filters[1]!.values).toEqual([2026]);
    expect(outcome.receipt.grounding?.join(' ')).toMatch(/Fiscal year 26 matched nothing; a two-digit year was read as 2026/);
  });

  it('a member the warehouse holds as spelled is not blamed; the other restrictions are named', async () => {
    const { outcome, runs } = await run(2031, []);
    expect(runs).toHaveLength(1);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toContain('"Stephen Curry" is on the warehouse, but no rows matched it together with Fiscal year eq 2031');
    expect(outcome.text).not.toContain('Check the spelling');
  });
});

describe('an authored semantic metric the engine did not answer', () => {
  it('the gap says why the semantic engine refused, not only that generated SQL will not rebuild it', async () => {
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'pct_dod_core_user_acm', label: '% DOD Core User ACM', metricType: 'derived', engineOnly: 'a derived metric the relational tier cannot compose' }],
    });
    const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'The percent DoD core user ACM.', measures: [{ ref: 'metric:pct_dod_core_user_acm' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const outcome = await runAskPipeline({
      question: 'what is the percent dod core user acm?', vocabulary, explorationOptIn: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => reading },
      prepareDeps: {}, executeDeps: { run: async () => { throw new Error('nothing should run'); } },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toContain('the semantic engine did not answer % DOD Core User ACM (no semantic layer is loaded for this project)');
    expect(outcome.text).not.toContain('fix the semantic compiler o');
  });

  it('with SQL drafting on, the metric is rebuilt from its authored definition and the answer says the engine did not run it', async () => {
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'pct_dod_core_user_acm', label: '% DOD Core User ACM', metricType: 'derived', engineOnly: 'a derived metric the relational tier cannot compose' }],
    });
    const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'The percent DoD core user ACM.', measures: [{ ref: 'metric:pct_dod_core_user_acm' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const reasons: string[] = [];
    const outcome = await runAskPipeline({
      question: 'what is the percent dod core user acm?', vocabulary, explorationAuto: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => reading },
      prepareDeps: { draftSql: async ({ reason }) => { reasons.push(reason ?? ''); return { sql: 'SELECT 0.12 AS pct_dod_core_user_acm FROM usage.daily', relations: ['usage.daily'], proof: [] }; } },
      executeDeps: { run: async () => ({ columns: ['pct_dod_core_user_acm'], rows: [{ pct_dod_core_user_acm: 0.12 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(reasons[0]).toContain('rebuild it exactly from the definition in CONTEXT');
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.text).toContain('the semantic engine did not run % DOD Core User ACM (no semantic layer is loaded for this project)');
    expect(outcome.text).toContain('rebuilding that metric from its authored definition');
  });
});

describe('a name that reads several people is a question, not a sum', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.season_facts', column: 'points', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } },
      { name: 'player_id', model: 'season_facts', label: 'Player ID', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
    ],
  });
  const CURRYS = ['Eddy Curry', 'JamesOn Curry', 'Michael Curry', 'Seth Curry', 'Stephen Curry'];
  const reply = (op: 'eq' | 'in') => JSON.stringify({
    version: 1, kind: 'analytics', reading: "Stephen Curry's points.",
    measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
    filters: [{ ref: 'dimension:season_facts.player', op, values: ['Curry'], source: 'question' }],
    unresolved: [], provenance: {}, expectedShape: 'scalar',
  });
  const provider = (op: 'eq' | 'in'): AgentProvider => ({ name: 'ollama', available: async () => true, generate: async () => reply(op) });
  const run = async (op: 'eq' | 'in', found: string[], rows: Array<Record<string, unknown>>) => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const outcome = await runAskPipeline({
      question: "Show Curry's performance.", vocabulary, provider: provider(op), prepareDeps: { compileSemantic: async (request) => ({ sql: `SELECT SUM(points) AS points_scored FROM dev.season_facts WHERE ${JSON.stringify(request.filters ?? [])}`, engine: 'native' }) },
      executeDeps: { run: async (sql, params) => {
        runs.push({ sql, params: params ?? [] });
        return runs.length === 1
          ? { columns: ['points_scored'], rows: [{ points_scored: null }], rowCount: 1, executionTimeMs: 1 }
          : { columns: Object.keys(rows[0] ?? { points_scored: 0 }), rows, rowCount: rows.length, executionTimeMs: 1 };
      } },
      suggestMembers: async () => found,
    });
    return { outcome, runs };
  };

  it('five members behind one singular name end the turn in a question, and nothing is aggregated', async () => {
    const { outcome, runs } = await run('eq', CURRYS, []);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.question).toMatch(/matches 5 members of Player/);
    expect(outcome.options.map((option) => option.label)).toEqual([...CURRYS, 'All 5, one row each']);
    // Nothing ran a second time, and no answer or result was persisted.
    expect(runs).toHaveLength(1);
    expect(outcome.receipt.grounding?.join(' ')).toMatch(/asked which one instead of adding them together/);
    expect(outcome.receipt.executed?.rowCount).toBe(0);
  });

  it('each option carries the member it names, and the set carries all of them', async () => {
    const { outcome } = await run('eq', CURRYS, []);
    if (outcome.kind !== 'clarify') throw new Error('expected a clarification');
    expect(parseMemberOption(outcome.options[4]!.ref)).toEqual({ ref: 'dimension:season_facts.player', values: ['Stephen Curry'] });
    expect(parseMemberOption(outcome.options[5]!.ref)).toEqual({ ref: 'dimension:season_facts.player', values: CURRYS });
    expect(parseMemberOption('dimension:season_facts.player')).toBeUndefined();
    expect(parseMemberOption(memberOptionId('dimension:x', ['a=b']))).toEqual({ ref: 'dimension:x', values: ['a=b'] });
  });

  it('a member stored in other capitals is the member named, even among many that contain it', async () => {
    const { outcome, runs } = await run('eq', ['CURRY', ...CURRYS, 'Curry Family'], [{ points_scored: 7 }]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(runs).toHaveLength(2);
    expect(outcome.intent.filters[0]).toMatchObject({ op: 'eq', values: ['CURRY'] });
    expect(outcome.receipt.grounding?.join(' ')).toMatch(/"Curry" is stored as "CURRY"/);
  });

  it('one member behind the name is canonicalised and answered, naming only that member', async () => {
    const { outcome, runs } = await run('eq', ['Stephen Curry'], [{ points_scored: 2388 }]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(runs).toHaveLength(2);
    expect(runs[1]!.sql).toContain('Stephen Curry');
    expect(outcome.intent.filters[0]!.values).toEqual(['Stephen Curry']);
  });

  it('a set that widens to several members keeps each one its own row', async () => {
    const { outcome } = await run('in', CURRYS, [{ player_id: 201939, player: 'Stephen Curry', points_scored: 2388 }]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.intent.groupBy).toEqual([{ ref: 'dimension:season_facts.player_id', role: 'key' }]);
    expect(outcome.intent.display).toEqual(['dimension:season_facts.player']);
  });

  it('the member the user chose is the member the query reads', async () => {
    const intent: AnalyticalIntentV1 = {
      version: 1, kind: 'analytics', reading: "Curry's points in 2017.", measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
      filters: [{ ref: 'dimension:season_facts.player', op: 'eq', values: ['Curry'], source: 'question' }],
      expectedShape: 'scalar', unresolved: [], provenance: {},
    };
    applyMemberSelection(intent, { ref: 'dimension:season_facts.player', values: ['Seth Curry'] }, vocabulary);
    expect(intent.filters).toEqual([{ ref: 'dimension:season_facts.player', op: 'eq', values: ['Seth Curry'], source: 'clarification' }]);
    expect(intent.reading).toContain('Seth Curry');
    expect(intent.provenance['dimension:season_facts.player']).toMatch(/member you chose/);
  });

  it('choosing all of them separates them', async () => {
    const intent: AnalyticalIntentV1 = {
      version: 1, kind: 'analytics', reading: "Curry's points.", measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
      filters: [{ ref: 'dimension:season_facts.player', op: 'eq', values: ['Curry'], source: 'question' }],
      expectedShape: 'scalar', unresolved: [], provenance: {},
    };
    applyMemberSelection(intent, { ref: 'dimension:season_facts.player', values: CURRYS }, vocabulary);
    expect(intent.filters[0]!.op).toBe('in');
    expect(intent.groupBy).toEqual([{ ref: 'dimension:season_facts.player_id', role: 'key' }]);
    expect(proveSubjectMatchesPopulation(intent, vocabulary)).toBeUndefined();
  });

  it('a single row that would carry several members is proven impossible before it runs', async () => {
    const merged: AnalyticalIntentV1 = {
      version: 1, kind: 'analytics', reading: "Stephen Curry's points.", measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
      filters: [{ ref: 'dimension:season_facts.player', op: 'in', values: CURRYS, source: 'question' }],
      expectedShape: 'scalar', unresolved: [], provenance: {},
    };
    expect(proveSubjectMatchesPopulation(merged, vocabulary)).toMatch(/reads 5 members .* separates none of them/);
    // A reading that already separates them, and a single member, both pass.
    expect(proveSubjectMatchesPopulation({ ...merged, groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }] }, vocabulary)).toBeUndefined();
    expect(proveSubjectMatchesPopulation({ ...merged, filters: [{ ...merged.filters[0]!, op: 'eq', values: ['Stephen Curry'] }] }, vocabulary)).toBeUndefined();
  });

  it('an interpretation that merges members is never prepared, and says so', async () => {
    const merging: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({
      version: 1, kind: 'analytics', reading: "Stephen Curry's points.", measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [],
      filters: [{ ref: 'dimension:season_facts.player', op: 'in', values: CURRYS, source: 'question' }],
      unresolved: [], provenance: {}, expectedShape: 'scalar',
    }) };
    let executed = 0;
    const outcome = await runAskPipeline({
      question: "Show Stephen Curry's performance.", vocabulary, provider: merging, prepareDeps: { compileSemantic: async (request) => ({ sql: `SELECT SUM(points) AS points_scored FROM dev.season_facts WHERE ${JSON.stringify(request.filters ?? [])}`, engine: 'native' }) },
      executeDeps: { run: async () => { executed += 1; return { columns: ['points_scored'], rows: [{ points_scored: 3002 }], rowCount: 1, executionTimeMs: 1 }; } },
    });
    // The host separates them rather than refusing, so the rows are honest.
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.intent.groupBy).toEqual([{ ref: 'dimension:season_facts.player_id', role: 'key' }]);
    expect(executed).toBe(1);
  });
});

describe('a subject the reading claims is a subject the query reads', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.season_facts', column: 'points', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player_name', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } },
    ],
  });
  const reading = (text: string, filters: AnalyticalIntentV1['filters'] = []): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: text, measures: [{ ref: 'metric:points_scored' }], groupBy: [], display: [], filters,
    expectedShape: 'scalar', unresolved: [], provenance: {},
  });

  it('reads the names a question leans on, and passes over its ordinary words', () => {
    expect(namesInQuestion("How did LeBron James's total points change from calendar 2016 to calendar 2017?", vocabulary)).toContain('LeBron James');
    expect(namesInQuestion('Who scored the most points in calendar year 2017?', vocabulary)).toEqual([]);
    expect(namesInQuestion('Show monthly scoring totals during calendar 2017.', vocabulary)).toEqual([]);
  });

  it('binds the member the reading is about when the warehouse holds it', async () => {
    const intent = reading("Compare LeBron James's total points in 2016 versus 2017.");
    const notes = await bindNamedSubject(intent, "How did LeBron James's total points change?", vocabulary, async () => ['LeBron James']);
    expect(intent.filters).toEqual([{ ref: 'dimension:season_facts.player_name', op: 'eq', values: ['LeBron James'], source: 'question' }]);
    expect(notes[0]).toMatch(/the restriction was missing/);
    expect(intent.provenance['dimension:season_facts.player_name']).toMatch(/the reading's own subject is what the query reads/);
  });

  it('changes nothing when the name is not a member, or the filter already carries it', async () => {
    const absent = reading('Total points for the Lakers.');
    expect(await bindNamedSubject(absent, 'How much did the Lakers score?', vocabulary, async () => [])).toEqual([]);
    expect(absent.filters).toEqual([]);
    const already = reading("LeBron James's points.", [{ ref: 'dimension:season_facts.player_name', op: 'eq', values: ['LeBron James'], source: 'question' }]);
    expect(await bindNamedSubject(already, 'How many points did LeBron James score?', vocabulary, async () => { throw new Error('must not probe'); })).toEqual([]);
    // A BROADER restriction is not that name: "contains Curry" under a reading
    // about Stephen Curry is narrowed to the member the reading claims.
    const broad = reading("Stephen Curry's points.", [{ ref: 'dimension:season_facts.player_name', op: 'contains', values: ['Curry'], source: 'question' }]);
    const narrowed = await bindNamedSubject(broad, "Show Stephen Curry's performance.", vocabulary, async () => ['Seth Curry', 'Stephen Curry']);
    expect(broad.filters).toEqual([{ ref: 'dimension:season_facts.player_name', op: 'eq', values: ['Stephen Curry'], source: 'question' }]);
    expect(narrowed[0]).toMatch(/was broader than that name/);
  });

  it('a name the reading never mentions is not bound, however the question spells it', async () => {
    const unclaimed = reading('Total points by month.');
    let probed = 0;
    expect(await bindNamedSubject(unclaimed, 'Show LeBron James by month.', vocabulary, async () => { probed += 1; return ['LeBron James']; })).toEqual([]);
    expect(probed).toBe(0);
  });
});

describe('one question, one shape', () => {
  const ranking = (limit?: number): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:points' }], groupBy: [], display: [], filters: [],
    ordering: { ref: 'metric:points', direction: 'desc' }, ...(limit === undefined ? {} : { limit }),
    expectedShape: 'ranking', unresolved: [], provenance: {},
  });
  const limitFor = (question: string, limit?: number) => {
    const intent = ranking(limit);
    freezeSuperlativeShape(intent, question);
    return intent.limit;
  };

  it('a singular superlative is one row, however many the interpreter asked for', () => {
    expect(limitFor('Who scored the most points in calendar year 2017?', 10)).toBe(1);
    expect(limitFor('Who made the most three-pointers in 2017?', 10)).toBe(1);
    expect(limitFor('Which player had the best assist-to-turnover ratio?', 25)).toBe(1);
    // A THRESHOLD is not a count: "with at least 20 games" sizes the cohort
    // the question ranks, not the number of rows it asks for.
    expect(limitFor('Who had the best assist-to-turnover ratio in 2017 with at least 20 games?', 10)).toBe(1);
    expect(limitFor('Who led scoring in 2017?', 10)).toBe(1);
  });

  it('a plural subject or a stated count is left exactly as it was', () => {
    expect(limitFor('Who are the top scorers this season?', 10)).toBe(10);
    expect(limitFor('Which teams won the most games in the 2017 season?', 10)).toBe(10);
    expect(limitFor('Who are our top five players by total points?', 5)).toBe(5);
    expect(limitFor('Show me the top ten players by points.', 10)).toBe(10);
    // Nothing superlative, and nothing ordered, are both left alone.
    expect(limitFor('How many points did LeBron James score in 2017?', 10)).toBe(10);
    const unordered: AnalyticalIntentV1 = { ...ranking(10), ordering: undefined };
    freezeSuperlativeShape(unordered, 'Who scored the most points?');
    expect(unordered.limit).toBe(10);
  });

  it('says why the shape is what it is', () => {
    const intent = ranking(10);
    freezeSuperlativeShape(intent, 'Who scored the most points in 2017?');
    expect(intent.provenance.limit).toMatch(/asks which one/);
  });
});

describe('the relations a reading names are described before it is prepared', () => {
  // The manifest documents the game facts with two columns; the warehouse has
  // the player's name there too. Context assembly hydrated neither relation.
  const source: VocabularySource = {
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."points"', aggregate: 'sum' } }],
    dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } }],
    relations: [
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'player_id' }, { name: 'points' }], columnCompleteness: 'partial' },
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'player_name', dataType: 'VARCHAR' }], columnCompleteness: 'complete' },
    ],
  };
  const reading = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Points by player.', measures: [{ ref: 'metric:points_scored' }],
    groupBy: [{ ref: 'dimension:season_facts.player', role: 'key' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
  });
  const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reading };
  const dialect = { quoteIdentifier: (name: string) => `"${name}"`, dateTrunc: (grain: string, expr: string) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit: number) => `LIMIT ${limit}` };

  it('describes the partially documented facts before anything is prepared', async () => {
    const asked: string[][] = [];
    const statements: string[] = [];
    const outcome = await runAskPipeline({
      question: 'points by player', vocabulary: buildVocabularyIndex(source), provider, clauseCoverage: false,
      prepareDeps: { dialect, compileSemantic: async () => ({ sql: 'SELECT player_name, SUM(points) AS points_scored FROM dev.game_facts GROUP BY 1', engine: 'native' }) },
      describeRelations: async (relations) => {
        asked.push(relations);
        return relations.some((relation) => relation.endsWith('game_facts'))
          ? [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'player_name', dataType: 'VARCHAR' }, { name: 'points', dataType: 'INTEGER' }], columnCompleteness: 'complete' as const }]
          : [];
      },
      executeDeps: { run: async (sql) => { statements.push(sql); return { columns: ['player_name', 'points_scored'], rows: [{ player_name: 'James Harden', points_scored: 2888 }], rowCount: 1, executionTimeMs: 1 }; } },
    });
    // Only the relation that was not already complete is described.
    expect(asked).toEqual([['dev.game_facts']]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.receipt.grounding?.join(' ')).toContain('discovery: described 1 relation the reading names (dev.game_facts)');
  });

  it('a reading the semantic engine cannot run goes to AI-written SQL whole, in one reading, and the question is never shrunk', async () => {
    let dispatches = 0;
    const counting: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => { dispatches += 1; return reading; } };
    const drafts: Array<{ reading?: string; reason?: string }> = [];
    const outcome = await runAskPipeline({
      question: 'points by player', vocabulary: buildVocabularyIndex(source), provider: counting, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async (draft) => { drafts.push({ reading: draft.intent?.reading, reason: draft.reason }); return { sql: 'SELECT s.player_name, SUM(g.points) AS points_scored FROM dev.game_facts g JOIN dev.season_facts s ON s.player_id = g.player_id GROUP BY s.player_name', relations: ['dev.game_facts', 'dev.season_facts'], proof: [] }; } },
      executeDeps: { run: async () => ({ columns: ['player_name', 'points_scored'], rows: [{ player_name: 'James Harden', points_scored: 2888 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(dispatches).toBe(1);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.reading).toBe('Points by player.');
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.tier).toBe('exploratory');
  });

  it("a drafted statement runs when it spells the reading's restriction its own way", async () => {
    const restricted = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Points for James Harden.', measures: [{ ref: 'metric:points_scored' }],
      groupBy: [{ ref: 'dimension:season_facts.player', role: 'key' }], display: [], filters: [{ ref: 'dimension:season_facts.player', op: 'eq', values: ['James Harden'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'grouped',
    });
    const outcome = await runAskPipeline({
      question: 'points for the player harden', vocabulary: buildVocabularyIndex(source), provider: { name: 'ollama', available: async () => true, generate: async () => restricted }, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ sql: "SELECT s.player_name, SUM(g.points) AS points_scored FROM dev.game_facts g JOIN dev.season_facts s ON s.player_id = g.player_id WHERE LOWER(s.player_name) LIKE '%harden%' GROUP BY s.player_name", relations: ['dev.game_facts', 'dev.season_facts'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['player_name', 'points_scored'], rows: [{ player_name: 'James Harden', points_scored: 2888 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    expect(outcome.receipt.refusals.some((refusal) => refusal.code === 'filter_not_applied')).toBe(false);
  });
});

import { resolveIntent as resolveIntentForOffice, validateIntentRefs as validateRefsForOffice, proveClauseCoverage } from './resolve-intent.js';

describe('office lost-opportunities readings (1.15.5 screenshots)', () => {
  const Q = 'Lost opportunities count, Lost Amount by month for fiscal year FY26 and competitor involved is Splunk';
  const OPP = 'SALESLOFT_PRODUCTION.opportunities';
  const col = (name: string) => `column:${OPP}.${name}`;
  const vocabulary = buildVocabularyIndex({
    relations: [
      { schema: 'SALESLOFT_PRODUCTION', name: 'opportunities', columnCompleteness: 'complete', columns: [
        { name: 'ID', dataType: 'VARCHAR' }, { name: 'AMOUNT', dataType: 'NUMBER' }, { name: 'IS_CLOSED', dataType: 'BOOLEAN' }, { name: 'IS_WON', dataType: 'BOOLEAN' },
        { name: 'CLOSE_DATE', dataType: 'DATE' }, { name: 'TAGS', dataType: 'VARCHAR' }, { name: 'CUSTOM_FIELDS', dataType: 'VARCHAR' },
      ] },
      { schema: 'sfdc', name: 'opportunity', columnCompleteness: 'complete', columns: [{ name: 'COMPETITOR_C', dataType: 'VARCHAR' }, { name: 'AMOUNT', dataType: 'NUMBER' }] },
    ],
  });
  const lost = [{ ref: col('IS_CLOSED'), op: 'eq', values: [true], source: 'question' }, { ref: col('IS_WON'), op: 'eq', values: [false], source: 'question' }];
  const measures = [
    { ref: col('ID'), aggregation: 'count', alias: 'lost_opportunities_count', scope: lost },
    { ref: col('AMOUNT'), aggregation: 'sum', alias: 'lost_amount', scope: lost },
  ];
  const informed = (extra: Record<string, unknown> = {}) => ({
    version: 1, kind: 'analytics', reading: 'Count of lost opportunities and total lost amount by month for fiscal year FY26, where the competitor involved is Splunk.',
    measures, groupBy: [{ ref: col('CLOSE_DATE'), role: 'time', grain: 'month' }], display: [],
    filters: [{ ref: col('TAGS'), op: 'eq', values: ['Splunk'], source: 'question' }],
    time: { ref: col('CLOSE_DATE'), grain: 'month', window: { start: '2025-02-01', end: '2026-02-01', expression: 'fiscal year FY26' } },
    expectedShape: 'grouped', unresolved: [], provenance: {}, ...extra,
  });

  it('a reading made before the columns were fetched does not hold the informed reading to its stale obligations', async () => {
    const uninformed = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Count of lost opportunities and lost amount; no date or competitor field is visible.', measures, groupBy: [], display: [], filters: [], expectedShape: 'grouped', provenance: {},
      unresolved: [
        { clause: 'fiscal year FY26 time window', options: [], material: true, question: 'Which date column represents the close date? The vocabulary does not expose a time dimension on the opportunity relations.' },
        { clause: 'competitor involved is Splunk', options: [], material: true },
      ],
    });
    const replies = [uninformed, JSON.stringify(informed())];
    let calls = 0;
    const provider = { name: 'scripted', available: async () => true, generate: async () => replies[Math.min(calls++, replies.length - 1)]! };
    const result = await resolveIntentForOffice({
      question: Q, vocabulary, provider: provider as never, maxAttempts: 2, clauseCoverage: false,
      expand: async () => ({ vocabulary, cards: [`- ${col('CLOSE_DATE')} [time]`, `- ${col('TAGS')} [text]`], note: 'discovery' }),
    });
    expect(calls).toBe(2);
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.intent.unresolved.filter((clause) => clause.origin === 'ledger')).toEqual([]);
      expect(result.intent.time?.ref).toBe(col('CLOSE_DATE'));
    }
  });

  it('a restriction the reading is unsure where to apply is asked, with the candidate fields, and nothing runs', async () => {
    const reply = JSON.stringify(informed({ unresolved: [{ clause: 'competitor involved is Splunk', options: [col('TAGS'), col('CUSTOM_FIELDS')], material: false }] }));
    const outcome = await runAskPipeline({
      question: Q, vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply }, clauseCoverage: false, explorationAuto: false,
      prepareDeps: { dialect: { quoteIdentifier: (name) => `"${name}"`, dateTrunc: (grain, expr) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit) => `LIMIT ${limit}` } },
      executeDeps: { run: async () => { throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind === 'clarify') expect(outcome.options.map((option) => option.ref).sort()).toEqual([col('CUSTOM_FIELDS'), col('TAGS')]);
  });

  it('choosing the field moves the restriction onto it instead of grouping by it', () => {
    const intent = parseIntent(informed({ unresolved: [{ clause: 'competitor involved is Splunk', options: [col('TAGS'), col('CUSTOM_FIELDS')], material: true }] })).intent!;
    applySelectedMeaning(intent, { ref: col('CUSTOM_FIELDS') }, vocabulary);
    expect(intent.filters.map((filter) => [filter.ref, filter.op, filter.values])).toEqual([[col('CUSTOM_FIELDS'), 'eq', ['Splunk']]]);
    expect(intent.groupBy.map((group) => group.ref)).toEqual([col('CLOSE_DATE')]);
  });

  it('a column named with its database resolves to the column of that table; an unknown table still does not', () => {
    const reading = parseIntent({
      version: 1, kind: 'analytics', reading: 'Opportunity amount by competitor.', measures: [{ ref: 'column:sfdc.opportunity.AMOUNT', aggregation: 'sum' }],
      groupBy: [{ ref: 'column:nr_silver_datalake_prod.sfdc.opportunity.COMPETITOR_C', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!;
    const validation = validateRefsForOffice(reading, vocabulary);
    expect(validation.problems.filter((problem) => problem.path.startsWith('groupBy'))).toEqual([]);
    expect(validation.intent.groupBy[0]?.ref).toBe('column:sfdc.opportunity.COMPETITOR_C');
    const unknown = parseIntent({ ...JSON.parse(JSON.stringify(reading)), groupBy: [{ ref: 'column:nr_silver_datalake_prod.sfdc.nothere.COMPETITOR_C', role: 'categorical' }] }).intent!;
    expect(validateRefsForOffice(unknown, vocabulary).problems.some((problem) => problem.message.includes('is not in the vocabulary'))).toBe(true);
  });

  it('a follow-up to a question that never ran is not asked to keep or drop that question\'s fields; one that ran still is', () => {
    const prior = parseIntent(informed()).intent!;
    const next = parseIntent({
      version: 1, kind: 'analytics', reading: 'Opportunity amount by competitor.', measures: [{ ref: 'column:sfdc.opportunity.AMOUNT', aggregation: 'sum' }],
      groupBy: [{ ref: 'column:sfdc.opportunity.COMPETITOR_C', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!;
    const question = 'who are the competitors opportunity? Can you give me the list by amount';
    const blocked = (validateRefsForOffice as unknown as (...args: unknown[]) => { problems: Array<{ path: string }> })(next, vocabulary, prior, question, { priorExecuted: false });
    expect(blocked.problems.filter((problem) => problem.path === 'provenance')).toEqual([]);
    const ran = validateRefsForOffice(parseIntent(JSON.parse(JSON.stringify(next))).intent!, vocabulary, prior, question);
    expect(ran.problems.some((problem) => problem.path === 'provenance')).toBe(true);
  });
});


describe('the schema lane: no certified or governed evidence, the AI writes SQL from the tables', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'amount', dataType: 'NUMBER' }, { name: 'status', dataType: 'VARCHAR' }] }],
  });
  const dialect = { quoteIdentifier: (name: string) => `"${name}"`, dateTrunc: (grain: string, expr: string) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit: number) => `LIMIT ${limit}` };
  const invalidReading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Order count by competitor.', measures: [{ ref: 'column:crm.competitor_deals.deal_key', aggregation: 'count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const say = (reply: string): AgentProvider => ({ name: 'ollama', available: async () => true, generate: async () => reply });
  const rows = { columns: ['n'], rows: [{ n: 42 }], rowCount: 1, executionTimeMs: 1 };

  it('a question that could not be read into the governed vocabulary is answered by SQL drafted from the schema, review-required', async () => {
    const asked: Array<{ reason?: string; intent?: unknown }> = [];
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async (draft) => { asked.push({ reason: draft.reason, intent: draft.intent }); return { sql: 'SELECT COUNT(*) AS n FROM dev.orders', relations: ['dev.orders'], proof: ['validated'] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reason).toContain('not in the vocabulary');
    expect((asked[0]!.intent as { reading?: string } | undefined)?.reading).toBe('Order count by competitor.');
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('exploratory');
    expect(outcome.candidate.trust).toBe('review_required');
    expect(outcome.text).toContain('written by AI from the schema of dev.orders');
  });

  it('when the tables do not hold what was asked, the drafter declines and the answer is an honest gap with nothing executed', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Churn rate by region.', measures: [], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'churn rate by region', options: [], material: true }], provenance: {}, expectedShape: 'grouped' });
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'churn rate by region', vocabulary, provider: say(reply), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ declined: 'these tables hold orders only; nothing records churn or region.' }) },
      executeDeps: { run: async () => { executed += 1; return rows; } },
    });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.message).toContain('nothing records churn or region');
  });

  // F3 (ZLens 0.1.0 e2e): with no tables in the project's catalog the drafter
  // could not run, and the answer claimed the project's data "does not
  // describe" a question the same project answers once its tables are back.
  it('when no tables can be read at all, the answer says the data was not checked instead of claiming it does not hold it', async () => {
    const metricsOnly = buildVocabularyIndex({ metrics: [{ name: 'team_wins', model: 'team_season_facts', label: 'Team wins', aggregation: 'sum' }] });
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Which team had the most wins in the 2017 season?', measures: [{ ref: 'metric:team_season_facts.team_wins', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'which team had the most wins in season 2017', options: [], material: true }], provenance: { 'metric:team_season_facts.team_wins': 'q:most wins' }, expectedShape: 'scalar' });
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'Which team had the most wins in season 2017?', vocabulary: metricsOnly, provider: say(reply), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ unavailable: true, error: 'this project lists no tables Ask may read: warehouse modeling is on and no warehouse catalog has been synced yet' }) },
      executeDeps: { run: async () => { executed += 1; return rows; } },
    });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('failed');
    expect(outcome.text).toContain('no warehouse catalog has been synced');
    expect(outcome.text).toContain('was not checked');
    expect(outcome.text).not.toContain("governed data describes");
    expect(outcome.receipt.refusals.map((refusal) => refusal.code)).toContain('exploration_tables_unavailable');
  });

  it('a draft that finds no matching table among readable ones is still the honest "not modeled" gap', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Churn rate by region.', measures: [], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'churn rate by region', options: [], material: true }], provenance: {}, expectedShape: 'grouped' });
    const outcome = await runAskPipeline({
      question: 'churn rate by region', vocabulary, provider: say(reply), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ error: 'no table in this project matches the question' }) },
      executeDeps: { run: async () => rows },
    });
    expect(outcome.kind).toBe('gap');
  });

  it('the model itself failing is not a reason to draft: nothing is asked of it again', async () => {
    let drafts = 0;
    const outcome = await runAskPipeline({
      question: 'how many orders', vocabulary, clauseCoverage: false, explorationAuto: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => { throw Object.assign(new Error('limit'), { code: 'provider_quota', detail: 'resets at noon' }); } },
      prepareDeps: { dialect, draftSql: async () => { drafts += 1; return { sql: 'SELECT 1', relations: [], proof: [] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(drafts).toBe(0);
    expect(outcome.kind).toBe('failed');
  });

  it('a real either/or question stays a question: nothing is drafted in place of the choice', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Orders by the field the question means.', measures: [{ ref: 'column:dev.orders.order_id', aggregation: 'count' }], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'by which field', options: ['column:dev.orders.status', 'column:dev.orders.amount'], material: true, question: 'Group by status or by amount?' }], provenance: {}, expectedShape: 'grouped' });
    let drafts = 0;
    const outcome = await runAskPipeline({
      question: 'orders broken down by the field that matters', vocabulary, provider: say(reply), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => { drafts += 1; return { sql: 'SELECT 1', relations: [], proof: [] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(drafts).toBe(0);
    expect(outcome.kind).toBe('clarify');
  });

  it('a statement the warehouse rejects is redrafted once with the warehouse error, then answered', async () => {
    const previous: Array<{ sql: string; error: string } | undefined> = [];
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async (draft) => { previous.push(draft.previous); return draft.previous ? { sql: 'SELECT COUNT(*) AS n FROM dev.orders', relations: ['dev.orders'], proof: [] } : { sql: 'SELECT COUNT(*) AS n FROM dev.order', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async (sql) => { if (sql.includes('dev.order ') || sql.endsWith('dev.order')) throw new Error("Table 'dev.order' does not exist"); return rows; } },
    });
    expect(previous[0]).toBeUndefined();
    expect(previous[1]).toMatchObject({ sql: 'SELECT COUNT(*) AS n FROM dev.order' });
    expect(previous[1]!.error).toContain("does not exist");
    expect(outcome.kind).toBe('answered');
  });

  it('a reading that names a field the project does not hold is answered from the tables; a declined draft is an honest gap, not a spelling quiz', async () => {
    const nearMiss = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Order count.', measures: [{ ref: 'column:dev.nothere.order_id', aggregation: 'count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const drafted = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(nearMiss), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async (draft) => { expect(draft.reason).toContain('not in the vocabulary'); return { sql: 'SELECT COUNT(*) AS n FROM dev.orders', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(drafted.kind).toBe('answered');
    const declined = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(nearMiss), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ declined: 'no competitor field.' }) },
      executeDeps: { run: async () => rows },
    });
    expect(declined.kind).toBe('gap');
  });

  it('a question with nothing to choose between is answered from the tables when the drafter finds them', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Order count for competitor deals.', measures: [{ ref: 'column:dev.orders.order_id', aggregation: 'count' }], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'involve a competitor', options: [], material: true }], provenance: {}, expectedShape: 'scalar' });
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(reply), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async (draft) => { expect(draft.intent?.reading).toBe('Order count for competitor deals.'); return { sql: "SELECT COUNT(*) AS n FROM dev.orders WHERE status = 'competitor'", relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.trust).toBe('review_required');
  });

  it('the run tells its story in order: what it read, that it asked the AI to write SQL, what it drafted and what ran', async () => {
    const streamed: string[] = [];
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: true,
      onStep: (entry) => streamed.push(entry.title),
      prepareDeps: { dialect, draftSql: async () => ({ sql: 'SELECT COUNT(*) AS n FROM dev.orders', relations: ['dev.orders'], proof: [] }) },
      executeDeps: { run: async () => rows },
    });
    expect(outcome.kind).toBe('answered');
    const story = outcome.receipt.story ?? [];
    expect(story.map((entry) => entry.title)).toEqual(streamed);
    expect(story.map((entry) => entry.title)).toEqual([
      'Asked the AI to read the question',
      'Settled the reading',
      'Asking the AI to write SQL from the tables',
      'Drafted SQL over dev.orders',
      'Ran the AI-drafted query: 1 row',
    ]);
    // A reading over tables nobody governs is not corrected: it goes to the drafter as it is.
    expect(story[1]!.detail).toContain('Order count by competitor.');
    expect(story[2]!.detail).toContain('column:crm.competitor_deals.deal_key');
    expect(story[3]!.detail).toBe('SELECT COUNT(*) AS n FROM dev.orders');
    expect(story.map((entry) => entry.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(story.every((entry, index) => index === 0 || entry.at >= story[index - 1]!.at)).toBe(true);
  });

  it('a drafted statement that failed its checks is not run, and the answer names what it left out', async () => {
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ refused: 'the drafted SQL does not apply "Splunk" from the question' }) },
      executeDeps: { run: async () => { executed += 1; return rows; } },
    });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    expect(outcome.text).toContain('failed a check: the drafted SQL does not apply "Splunk"');
    expect(outcome.receipt.story?.some((entry) => entry.title === 'The drafted SQL failed a check, so it was not run')).toBe(true);
  });

  it('an answer from drafted SQL says what the statement filters on', async () => {
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ sql: "SELECT COUNT(*) AS n FROM dev.orders WHERE status = 'competitor'", relations: ['dev.orders'], proof: ["applied on the data: status = 'competitor'"] }) },
      executeDeps: { run: async () => rows },
    });
    expect(outcome.kind).toBe('answered');
    expect(outcome.text).toContain("it filters on status = 'competitor'");
  });

  it('with AI-drafted SQL turned off for the project, nothing is drafted', async () => {
    let drafts = 0;
    const outcome = await runAskPipeline({
      question: 'how many orders involve a competitor', vocabulary, provider: say(invalidReading), clauseCoverage: false, explorationAuto: false,
      prepareDeps: { dialect, draftSql: async () => { drafts += 1; return { sql: 'SELECT 1', relations: [], proof: [] }; } },
      executeDeps: { run: async () => rows },
    });
    expect(drafts).toBe(0);
    expect(outcome.kind).toBe('failed');
  });
});


describe('an invented field is answered with fields, and the chosen field is applied', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [
      { schema: 'sales', name: 'opportunity_enhanced', columnCompleteness: 'complete', columns: [{ name: 'OPPORTUNITY_ID', dataType: 'VARCHAR' }, { name: 'AMOUNT', dataType: 'NUMBER' }, { name: 'IS_WON', dataType: 'BOOLEAN' }] },
      { schema: 'sfdc', name: 'opportunity', columnCompleteness: 'complete', columns: [{ name: 'ID', dataType: 'VARCHAR' }, { name: 'COMPETITOR_C', dataType: 'VARCHAR' }] },
      { schema: 'nr_silver_nrdb_dl_stg', name: 'competitor_agent_analysis_v2', columnCompleteness: 'complete', columns: [{ name: 'ANALYSIS_ID', dataType: 'VARCHAR' }, { name: 'WIN_RATE', dataType: 'NUMBER' }] },
    ],
  });
  const dialect = { quoteIdentifier: (name: string) => `"${name}"`, dateTrunc: (grain: string, expr: string) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit: number) => `LIMIT ${limit}` };
  const invented = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Lost amount where the competitor is Splunk.', measures: [{ ref: 'column:sales.opportunity_enhanced.AMOUNT', aggregation: 'sum' }],
    groupBy: [], display: [], filters: [{ ref: 'column:sales.opportunity_enhanced.COMPETITOR_INVOLVED', op: 'eq', values: ['Splunk'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar',
  });
  const say = (reply: string): AgentProvider => ({ name: 'ollama', available: async () => true, generate: async () => reply });

  it('a clarification about a filter offers fields, never tables', async () => {
    const outcome = await runAskPipeline({
      question: 'lost amount where the competitor involved is Splunk', vocabulary, provider: say(invented), clauseCoverage: false, explorationAuto: false,
      prepareDeps: { dialect }, executeDeps: { run: async () => { throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.options.length).toBeGreaterThan(0);
    expect(outcome.options.every((option) => !option.ref.startsWith('relation:'))).toBe(true);
    expect(outcome.options.map((option) => option.ref)).toContain('column:sfdc.opportunity.COMPETITOR_C');
  });

  it('choosing a field rebinds the invented restriction to it, even when the model names the invented field again', async () => {
    const outcome = await runAskPipeline({
      question: 'lost amount where the competitor involved is Splunk', vocabulary, provider: say(invented), clauseCoverage: false, explorationAuto: false,
      selection: { ref: 'column:sfdc.opportunity.COMPETITOR_C', label: 'COMPETITOR_C' },
      prepareDeps: { dialect }, executeDeps: { run: async () => { throw new Error('must not execute'); } },
    });
    const intent = (outcome as { intent?: AnalyticalIntentV1 }).intent ?? outcome.receipt.intent;
    expect(JSON.stringify(intent)).toContain('column:sfdc.opportunity.COMPETITOR_C');
    expect(JSON.stringify(intent)).not.toContain('COMPETITOR_INVOLVED');
    expect(outcome.kind).not.toBe('clarify');
  });
});


describe('the guards read the user, and a grouping must stand for the breakdown', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [
      { schema: 'sales', name: 'opportunity_enhanced', columnCompleteness: 'complete', columns: [{ name: 'OPPORTUNITY_ID', dataType: 'VARCHAR' }, { name: 'AMOUNT', dataType: 'NUMBER' }, { name: 'CLOSE_DATE', dataType: 'DATE' }] },
      { schema: 'salesloft', name: 'opportunities', columnCompleteness: 'complete', columns: [{ name: 'OPPORTUNITY_ID', dataType: 'VARCHAR' }, { name: 'TAGS', dataType: 'VARCHAR', description: 'Semicolon-separated tags added by reps.' }] },
    ],
  });
  const dialect = { quoteIdentifier: (name: string) => `"${name}"`, dateTrunc: (grain: string, expr: string) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit: number) => `LIMIT ${limit}` };
  const say = (reply: string): AgentProvider => ({ name: 'ollama', available: async () => true, generate: async () => reply });

  it('a grouping by tags stands in for sales region only with the substitution said out loud', () => {
    const intent = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'column:sales.opportunity_enhanced.AMOUNT', aggregation: 'sum' }], groupBy: [{ ref: 'column:salesloft.opportunities.TAGS', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as unknown as AnalyticalIntentV1;
    proveClauseCoverage('What is our win rate against Splunk by sales region?', intent, vocabulary);
    expect(intent.unresolved).toEqual([expect.objectContaining({ clause: 'by sales region', material: false, kind: 'not_modeled' })]);
    expect(intent.unresolved[0]!.question).toBe('Nothing in this project is named "sales region"; the answer is broken down by TAGS in its place.');
    const tagged = { ...intent, unresolved: [] } as AnalyticalIntentV1;
    proveClauseCoverage('amount by tags', tagged, vocabulary);
    expect(tagged.unresolved).toEqual([]);
  });

  it("a repair's engine message is never read as a breakdown the user asked for", async () => {
    const monthly = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Lost amount by month.', measures: [{ ref: 'column:sales.opportunity_enhanced.AMOUNT', aggregation: 'sum', alias: 'lost_amount' }], groupBy: [{ ref: 'column:sales.opportunity_enhanced.CLOSE_DATE', role: 'time', grain: 'month' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'trend' });
    const repairText = 'lost amount by month\n\nThe previous interpretation could not be prepared. The engine said: this reading takes the first 10 rows with no ordering, so which rows come back is arbitrary; order by one of lost_amount. Choose refs the engine can bind.';
    const withOwnWords = await resolveIntentForOffice({ question: repairText, coverageQuestion: 'lost amount by month', vocabulary, provider: say(monthly), maxAttempts: 1 });
    expect(JSON.stringify(withOwnWords)).not.toContain('by one');
    const withoutOwnWords = await resolveIntentForOffice({ question: repairText, vocabulary, provider: say(monthly), maxAttempts: 1 });
    expect(JSON.stringify(withoutOwnWords)).toContain('by one');
  });

  it('an answer from drafted SQL over tables says no certified block or semantic metric answers it, never that a table was governed', async () => {
    const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount by tags.', measures: [{ ref: 'column:sales.opportunity_enhanced.AMOUNT', aggregation: 'sum' }], groupBy: [{ ref: 'column:salesloft.opportunities.TAGS', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
    const outcome = await runAskPipeline({
      question: 'amount by tags', vocabulary, provider: say(reading), clauseCoverage: false, explorationAuto: true,
      prepareDeps: { dialect, draftSql: async () => ({ sql: 'SELECT s.TAGS, SUM(e.AMOUNT) AS amount FROM sales.opportunity_enhanced e JOIN salesloft.opportunities s ON s.OPPORTUNITY_ID = e.OPPORTUNITY_ID GROUP BY s.TAGS', relations: ['sales.opportunity_enhanced', 'salesloft.opportunities'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['TAGS', 'amount'], rows: [{ TAGS: 'x', amount: 1 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    expect(outcome.text).toContain('no certified block or semantic metric answers this');
    expect(outcome.text).not.toMatch(/governed relational|governed tables/);
  });
});

describe('two governed sources: certified blocks and authored semantics; everything else is AI-written SQL', () => {
  const source: VocabularySource = {
    metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
    dimensions: [
      { name: 'region', model: 'orders', label: 'Region', dataType: 'string' },
      { name: 'TAGS', model: 'opportunities', label: 'Tags', dataType: 'string', inventory: true },
    ],
    relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'status', dataType: 'VARCHAR' }] }],
  };
  const vocabulary = buildVocabularyIndex(source);
  const reading = (measures: unknown[], groupBy: unknown[] = []) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures, groupBy, display: [], filters: [], unresolved: [], provenance: {}, expectedShape: groupBy.length ? 'grouped' : 'scalar' }).intent!;

  it('a reading is governed only when every ref is an authored semantic object; a dbt column inventory dimension is a column', () => {
    expect(readingLane(reading([{ ref: 'metric:orders.revenue' }], [{ ref: 'dimension:orders.region', role: 'categorical' }]), vocabulary)).toBe('governed');
    expect(readingLane(reading([{ ref: 'metric:orders.revenue' }], [{ ref: 'dimension:opportunities.TAGS', role: 'categorical' }]), vocabulary)).toBe('ai');
    expect(readingLane(reading([{ ref: 'column:dev.orders.amount', aggregation: 'sum' }]), vocabulary)).toBe('ai');
    expect(readingLane(reading([{ ref: 'metric:nowhere.nothing' }]), vocabulary)).toBe('ai');
    // Nothing named yet: governed, unless the reading says nothing governed models it.
    const bare = { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as unknown as AnalyticalIntentV1;
    expect(readingLane(bare, vocabulary)).toBe('governed');
    expect(readingLane({ ...bare, unresolved: [{ clause: 'double-doubles', options: [], material: true }] }, vocabulary)).toBe('ai');
    expect(isGovernedEntry(vocabulary.get('dimension:opportunities.TAGS')!)).toBe(false);
  });

  it('a governed name that does not exist gets its one correction in a governed project; a column that does not exist goes to AI SQL at once', async () => {
    const invented = JSON.stringify({ version: 1, kind: 'analytics', reading: 'invented', measures: [{ ref: 'metric:invented_mart.invented_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const corrected = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Revenue.', measures: [{ ref: 'metric:orders.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const governed = scripted([invented, corrected]);
    const toGoverned = await resolveIntent({ question: 'revenue', vocabulary, provider: governed, aiLane: true, clauseCoverage: false });
    expect(toGoverned.status).toBe('resolved');
    expect(governed.calls).toHaveLength(2);
    if (toGoverned.status === 'resolved') expect(toGoverned.lane).toBeUndefined();
    const column = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount.', measures: [{ ref: 'column:dev.orders.nothere', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    const tables = scripted([column, corrected]);
    const toAi = await resolveIntent({ question: 'amount', vocabulary, provider: tables, aiLane: true, clauseCoverage: false });
    expect(tables.calls).toHaveLength(1);
    if (toAi.status === 'resolved') expect(toAi.lane).toBe('ai');
  });

  it('an answer carries the DQL it ran: a semantic block for a semantic answer, a draft SQL block for AI-written SQL', async () => {
    const reading = (measures: unknown[], groupBy: unknown[]) => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Revenue by region.', measures, groupBy, display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
    const semantic = await runAskPipeline({
      question: 'revenue by region', vocabulary, clauseCoverage: false, explorationAuto: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => reading([{ ref: 'metric:orders.revenue' }], [{ ref: 'dimension:orders.region', role: 'categorical' }]) },
      prepareDeps: { compileSemantic: async () => ({ sql: 'SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region', engine: 'native' }) },
      executeDeps: { run: async () => ({ columns: ['region', 'revenue'], rows: [{ region: 'east', revenue: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(semantic.kind).toBe('answered');
    if (semantic.kind !== 'answered') return;
    const block = semantic.candidate.artifact as { kind: string; source: string; trustState: string; compiledSql: string };
    expect(block.kind).toBe('semantic_block');
    expect(block.source).toContain('revenue');
    expect(block.source).toContain('region');
    expect(block.trustState).toBe('governed');
    expect(block.compiledSql).toContain('GROUP BY region');
    const drafted = await runAskPipeline({
      question: 'amount by status', vocabulary, clauseCoverage: false, explorationAuto: true,
      provider: { name: 'ollama', available: async () => true, generate: async () => reading([{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], [{ ref: 'column:dev.orders.status', role: 'categorical' }]) },
      prepareDeps: { draftSql: async () => ({ sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(drafted.kind).toBe('answered');
    if (drafted.kind !== 'answered') return;
    const sqlBlock = drafted.candidate.artifact as { kind: string; source: string; trustState: string };
    expect(sqlBlock.kind).toBe('sql_block');
    expect(sqlBlock.trustState).toBe('review_required');
    expect(sqlBlock.source).toContain('status = "draft"');
    expect(sqlBlock.source).toContain('SUM(amount)');
  });

  it('a local file path in an engine message never reaches the SQL drafter', async () => {
    const reasons: string[] = [];
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Revenue by region.', measures: [{ ref: 'metric:orders.revenue' }], groupBy: [{ ref: 'dimension:orders.region', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }) };
    await runAskPipeline({
      question: 'revenue by region', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: {
        compileSemantic: async () => { throw new Error('MetricFlow is installed but /var/folders/cs/T/dql-ask-golden-Sr3Yye/target/semantic_manifest.json was not found'); },
        draftSql: async (draft) => { reasons.push(draft.reason ?? ''); return { sql: 'SELECT status AS region, SUM(amount) AS revenue FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }; },
      },
      executeDeps: { run: async () => ({ columns: ['region', 'revenue'], rows: [{ region: 'east', revenue: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(reasons[0]).toContain('MetricFlow is installed but <path> was not found');
    expect(reasons[0]).not.toContain('/var/folders');
  });

  it('a percent the AI-written SQL already multiplied by 100 is shown as points, not multiplied again', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Growth from July to August.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum', alias: 'july' }, { ref: 'column:dev.orders.amount', aggregation: 'sum', alias: 'august' }, { ref: 'change:growth', alias: 'growth_pct', change: { base: 'july', comparison: 'august', as: 'percent' } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const outcome = await runAskPipeline({
      question: 'growth from July to August', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => ({ sql: 'SELECT 1489 AS july, 1609 AS august, (1609 - 1489) * 100.0 / 1489 AS growth_pct FROM dev.orders', relations: ['dev.orders'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['july', 'august', 'growth_pct'], rows: [{ july: 1489, august: 1609, growth_pct: 8.06 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.result.columnsMeta?.find((meta) => meta.name === 'growth_pct')).toMatchObject({ kind: 'percent', unit: 'percentage_points' });
    expect(outcome.text).not.toContain('806');
  });

  it('a governed reading the semantic engine cannot compile goes to AI SQL without a repair re-ask', async () => {
    let dispatches = 0;
    let drafts = 0;
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => { dispatches += 1; return JSON.stringify({ version: 1, kind: 'analytics', reading: 'Revenue by region.', measures: [{ ref: 'metric:orders.revenue' }], groupBy: [{ ref: 'dimension:orders.region', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }); } };
    const outcome = await runAskPipeline({
      question: 'revenue by region', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: {
        compileSemantic: async () => { throw new Error('Dimension region not found for metric revenue'); },
        draftSql: async () => { drafts += 1; return { sql: 'SELECT status AS region, SUM(amount) AS revenue FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }; },
      },
      executeDeps: { run: async () => ({ columns: ['region', 'revenue'], rows: [{ region: 'east', revenue: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(dispatches).toBe(1);
    expect(drafts).toBe(1);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.trust).toBe('review_required');
  });

  it('each AI call is recorded with when it finished, which attempt it was and what it was for', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const outcome = await runAskPipeline({
      question: 'total amount', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => ({ sql: 'SELECT SUM(amount) AS amount FROM dev.orders', relations: ['dev.orders'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['amount'], rows: [{ amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.receipt.dispatches[0]).toMatchObject({ purpose: 'intent:resolve', attempt: 1, label: 'read' });
    expect(typeof outcome.receipt.dispatches[0]!.at).toBe('number');
  });

  it('a reading over tables costs one reading and one draft: no correction rounds before AI-written SQL', async () => {
    let dispatches = 0;
    let drafts = 0;
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => { dispatches += 1; return JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount by status.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [{ ref: 'column:dev.orders.nothere', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }); } };
    const outcome = await runAskPipeline({
      question: 'amount by status', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => { drafts += 1; return { sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async () => ({ columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(dispatches).toBe(1);
    expect(drafts).toBe(1);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.trust).toBe('review_required');
  });

  it('a redraft that looks at the tables and finds nothing for an empty result is an honest no-data gap in its own words', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount in 2030.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const outcome = await runAskPipeline({
      question: 'amount in 2030', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async (draft) => (draft.previous ? { declined: 'the orders only cover 2016 and 2017, so nothing exists for 2030.' } : { sql: "SELECT SUM(amount) AS amount FROM dev.orders WHERE ordered_at >= '2030-01-01'", relations: ['dev.orders'], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['amount'], rows: [{ amount: null }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') {
      expect(outcome.gap).toBe('not_retrieved');
      expect(outcome.text).toContain('only cover 2016 and 2017');
    }
  });

  it('a forecast is an unsupported gap, never answered with a proxy measure', async () => {
    let drafts = 0;
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Closest proxy: amount by status.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [{ ref: 'column:dev.orders.status', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }) };
    const outcome = await runAskPipeline({
      question: 'Which customers are most likely to churn next quarter?', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => { drafts += 1; return { sql: 'SELECT 1', relations: [], proof: [] }; } },
      executeDeps: { run: async () => { throw new Error('nothing runs'); } },
    });
    expect(drafts).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.gap).toBe('unsupported');
  });

  it('a judgment question drafts its measured comparison from the reading and says the judgment is not computed', async () => {
    const asked: string[] = [];
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount by status.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [{ ref: 'column:dev.orders.status', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }) };
    const outcome = await runAskPipeline({
      question: 'Which status should we focus on, and why?', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async (draft) => { asked.push(draft.question); return { sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async () => ({ columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(asked[0]).toBe('Amount by status.');
    expect(outcome.kind).toBe('answered');
    expect(outcome.text).toMatch(/not computed here/);
    expect(outcome.text).toMatch(/Research can investigate/);
  });

  it('a count of zero from AI-written SQL is looked at again once: FY26 written as 26 against a field that stores 2026', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Lost opportunities in FY26.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const previous: Array<string | undefined> = [];
    const outcome = await runAskPipeline({
      question: 'lost opportunities in FY26', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async (draft) => { previous.push(draft.previous?.error); return { sql: draft.previous ? 'SELECT COUNT(*) AS n FROM dev.orders WHERE fiscal_year = 2026' : 'SELECT COUNT(*) AS n FROM dev.orders WHERE fiscal_year = 26', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async (sql) => ({ columns: ['n'], rows: [{ n: sql.includes('2026') ? 6 : 0 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(previous).toHaveLength(2);
    expect(previous[1]).toMatch(/only zeros.*2026/);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.result.rows).toEqual([{ n: 6 }]);
  });

  it('AI-written SQL that returns no rows is redrafted once with how stated values may be stored; a redraft that still finds nothing is an honest no-data gap', async () => {
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount for Capital One.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) };
    const previous: Array<string | undefined> = [];
    const run = (second: Array<Record<string, unknown>>) => runAskPipeline({
      question: 'total amount for "capital one"', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async (draft) => { previous.push(draft.previous?.error); return draft.previous ? { sql: "SELECT SUM(amount) AS amount FROM dev.orders WHERE LOWER(status) LIKE '%capital one%'", relations: ['dev.orders'], proof: [] } : { sql: "SELECT SUM(amount) AS amount FROM dev.orders WHERE status = 'capital one'", relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async (sql) => (sql.includes('LIKE') ? { columns: ['amount'], rows: second, rowCount: second.length, executionTimeMs: 1 } : { columns: ['amount'], rows: [{ amount: null }], rowCount: 1, executionTimeMs: 1 }) },
    });
    const found = await run([{ amount: 42 }]);
    expect(previous[1]).toMatch(/returned no rows.*case-insensitively.*2026/);
    expect(found.kind).toBe('answered');
    if (found.kind === 'answered') expect(found.result.rows).toEqual([{ amount: 42 }]);
    previous.length = 0;
    const still = await run([]);
    expect(previous).toHaveLength(2);
    expect(still.kind).toBe('gap');
    if (still.kind === 'gap') expect(still.gap).toBe('not_retrieved');
  });
});

describe('a retired block is answered from its replacement, and the run says so', () => {
  const source: VocabularySource = {
    blocks: [{
      name: 'Claims Dataset', domain: 'claims', certified: true, description: 'Paid claims, one figure.',
      contract: extractBlockContract({ name: 'Claims Dataset', domain: 'claims', sql: 'SELECT SUM(paid_amount) AS paid_claims FROM dev.claims', declaredOutputs: ['paid_claims'] }),
      sql: 'SELECT SUM(paid_amount) AS paid_claims FROM dev.claims',
      supersedes: [{ name: 'Claims Summary', deprecatedOn: '2026-09-30' }],
    }],
    relations: [{ schema: 'dev', name: 'claims', columns: [{ name: 'claim_id', dataType: 'VARCHAR' }, { name: 'paid_amount', dataType: 'DOUBLE' }] }],
  };
  const vocabulary = buildVocabularyIndex(source);
  const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Paid claims', measures: [{ ref: 'block:claims.Claims Dataset' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'block:claims.Claims Dataset': 'q:claims summary' }, expectedShape: 'scalar' });
  const run = (question: string) => runAskPipeline({
    question, vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reading }, clauseCoverage: false, prepareDeps: {},
    executeDeps: { run: async () => ({ columns: ['paid_claims'], rows: [{ paid_claims: 42 }], rowCount: 1, executionTimeMs: 1 }) },
  });

  it('the retired name is an alias of the replacement, so a question naming it pins the replacement', () => {
    const entry = vocabulary.get('block:claims.Claims Dataset');
    expect(entry?.aliases).toContain('Claims Summary');
    expect(pinnedRefsFor('paid claims from the claims summary', vocabulary)).toContain('block:claims.Claims Dataset');
    expect(retiredBlockNamedBy('what does Claims Summary say?', entry)).toEqual({ name: 'Claims Summary', deprecatedOn: '2026-09-30' });
    expect(retiredBlockNamedBy('summary of claims', entry)).toBeUndefined();
    // The card tells the model what the block replaces.
    expect(renderCard(entry!)).toContain('replaces retired "Claims Summary"');
    expect(renderCard(entry!)).not.toContain('aka Claims Summary');
  });

  it('answers from the replacement with its own certified trust and tells How it answered', async () => {
    const outcome = await run('What are paid claims in the Claims Summary?');
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.candidate.trust).toBe('certified');
    expect(outcome.candidate.sourceRef).toBe('block:claims.Claims Dataset');
    expect(outcome.candidate.proof).toContain('Claims Summary was retired on 2026-09-30; answered from Claims Dataset');
    expect(outcome.receipt.story?.map((step) => step.title)).toContain('Claims Summary was retired on 2026-09-30; answered from Claims Dataset');
  });

  it('a question that does not name the retired block tells no retirement story', async () => {
    const outcome = await run('What are paid claims?');
    expect(outcome.kind).toBe('answered');
    expect(outcome.receipt.story?.some((step) => /was retired/.test(step.title))).toBe(false);
  });
});

describe('draft first where nothing is governed', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'status', dataType: 'VARCHAR' }] }],
  });
  const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Amount by status.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [{ ref: 'column:dev.orders.status', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
  const run = (question: string, draft: (question: string) => { sql: string; relations: string[]; proof: string[] } | { declined: string }, extra: Partial<Parameters<typeof runAskPipeline>[0]> = {}) => {
    const reads: number[] = [];
    const drafted: string[] = [];
    const reasons: string[] = [];
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => { reads.push(1); return reading; } };
    const outcome = runAskPipeline({
      question, vocabulary, provider, clauseCoverage: false, explorationAuto: true, draftFirst: true,
      prepareDeps: { draftSql: async (input) => { drafted.push(input.question); reasons.push(input.reason ?? ''); return draft(input.question); } },
      executeDeps: { run: async () => ({ columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
      ...extra,
    });
    return { outcome, reads, drafted, reasons };
  };
  const ok = { sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] };

  it('drafts from the question as asked, without the reading call, and is told not to invent a term nothing defines', async () => {
    const { outcome, reads, drafted, reasons } = run('total amount by status', () => ok);
    const answered = await outcome;
    expect(answered.kind).toBe('answered');
    expect(reads).toHaveLength(0);
    expect(drafted).toEqual(['total amount by status']);
    expect(reasons[0]).toContain('do not invent a definition or substitute another field; reply NO_SQL naming it');
  });

  it('a question the drafter declines is read as before', async () => {
    let declines = 1;
    const { outcome, reads } = run('total amount by status', () => (declines-- > 0 ? { declined: 'no column holds it' } : ok));
    const answered = await outcome;
    expect(reads.length).toBeGreaterThan(0);
    expect(answered.kind).toBe('answered');
  });

  it('a forecast still goes through the reading, which refuses it', async () => {
    const { outcome, drafted } = run('what will the amount by status be next month, likely to grow?', () => ok);
    const refused = await outcome;
    expect(drafted).toHaveLength(0);
    expect(refused.kind).toBe('gap');
  });

  it('an answer to a clarification and a follow-up edit are read first', async () => {
    const answering = run('the open ones', () => ok, { conversation: { pendingClarification: 'Which statuses count as active?' } });
    await answering.outcome;
    expect(answering.reads.length).toBeGreaterThan(0);
    const prior = parseIntent(JSON.parse(reading)).intent!;
    const edit = run('now only the open ones', () => ok, { prior });
    await edit.outcome;
    expect(edit.reads.length).toBeGreaterThan(0);
  });

  it('without the flag the reading comes first, as before', async () => {
    const { outcome, reads } = run('total amount by status', () => ok, { draftFirst: false });
    await outcome;
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe('the second look at an AI-drafted result', () => {
  const vocabulary = buildVocabularyIndex({
    relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'status', dataType: 'VARCHAR' }] }],
  });
  const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Median of the per-status totals.', measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reading };
  const perStatus = { columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }, { status: 'closed', amount: 9 }], rowCount: 2, executionTimeMs: 1 };
  const oneNumber = { columns: ['median_amount'], rows: [{ median_amount: 6 }], rowCount: 1, executionTimeMs: 1 };
  const run = (options: { verdict?: string; second: 'ok' | 'error' | 'empty' | 'declined'; draftFirst?: boolean; review?: boolean }) => {
    const previous: Array<string | undefined> = [];
    const reviewed: Array<{ question: string; sql: string; rowCount: number }> = [];
    const outcome = runAskPipeline({
      question: 'the median of the total amount per status', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      ...(options.draftFirst ? { draftFirst: true } : {}),
      ...(options.review === false ? {} : { reviewResult: async ({ question, sql, result }) => { reviewed.push({ question, sql, rowCount: result.rowCount }); return options.verdict ? { revise: options.verdict } : undefined; } }),
      prepareDeps: { draftSql: async (draft) => {
        previous.push(draft.previous?.error);
        if (!draft.previous) return { sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] };
        if (options.second === 'declined') return { declined: 'no column holds it' };
        return { sql: options.second === 'error' ? 'SELECT broken' : options.second === 'empty' ? 'SELECT NULL AS median_amount FROM dev.orders WHERE 1 = 0' : 'WITH t AS (SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status) SELECT AVG(amount) AS median_amount FROM t', relations: ['dev.orders'], proof: [] };
      } },
      executeDeps: { run: async (sql) => {
        if (sql.startsWith('SELECT broken')) throw new Error('syntax error near broken');
        if (sql.includes('1 = 0')) return { columns: ['median_amount'], rows: [], rowCount: 0, executionTimeMs: 1 };
        return sql.startsWith('WITH') ? oneNumber : perStatus;
      } },
    });
    return { outcome, previous, reviewed };
  };

  it('a result the review accepts is answered after one draft', async () => {
    const { outcome, previous, reviewed } = run({ second: 'ok' });
    const answered = await outcome;
    expect(reviewed).toHaveLength(1);
    expect(previous).toEqual([undefined]);
    expect(answered.kind).toBe('answered');
    if (answered.kind === 'answered') {
      expect(answered.result.rows).toEqual(perStatus.rows);
      expect(JSON.stringify(answered.receipt.story)).toContain('Checked the result against the question');
    }
  });

  it('a defect the review names is revised once, with the reason, and the revision that runs is the answer', async () => {
    const { outcome, previous, reviewed } = run({ verdict: 'it returns one row per status; the question asks for one number, the median of those totals', second: 'ok' });
    const answered = await outcome;
    expect(reviewed).toHaveLength(1);
    expect(previous[1]).toMatch(/^the statement ran and returned 2 rows, but the result does not answer the question as asked: it returns one row per status/);
    expect(answered.kind).toBe('answered');
    if (answered.kind === 'answered') expect(answered.result.rows).toEqual(oneNumber.rows);
    expect(JSON.stringify(answered.receipt.story)).toContain('Checked the result against the question: revising the SQL once');
  });

  it('a revision that fails, finds nothing or is declined never costs the first answer', async () => {
    for (const second of ['error', 'empty', 'declined'] as const) {
      const answered = await run({ verdict: 'the question asks for one number', second }).outcome;
      expect(answered.kind, second).toBe('answered');
      if (answered.kind === 'answered') expect(answered.result.rows, second).toEqual(perStatus.rows);
    }
  });

  it('an answer drafted straight from the question gets the same review, and a declined revision keeps it', async () => {
    const accepted = run({ second: 'ok', draftFirst: true });
    const first = await accepted.outcome;
    expect(accepted.reviewed).toEqual([{ question: 'the median of the total amount per status', sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', rowCount: 2 }]);
    expect(first.kind).toBe('answered');
    // Draft-first falls through to the reading on a decline; a declined REVISION keeps the first result instead.
    const declined = run({ verdict: 'the question asks for one number', second: 'declined', draftFirst: true });
    const kept = await declined.outcome;
    expect(declined.reviewed).toHaveLength(1);
    expect(kept.kind).toBe('answered');
    if (kept.kind === 'answered') expect(kept.result.rows).toEqual(perStatus.rows);
  });

  it('without a review hook nothing changes', async () => {
    const { outcome, previous, reviewed } = run({ second: 'ok', review: false });
    const answered = await outcome;
    expect(reviewed).toHaveLength(0);
    expect(previous).toEqual([undefined]);
    expect(answered.kind).toBe('answered');
    if (answered.kind === 'answered') expect(JSON.stringify(answered.receipt.story)).not.toContain('Checked the result');
  });
});
