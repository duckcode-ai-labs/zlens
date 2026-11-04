import { describe, expect, it } from 'vitest';
import { pinnedRefsFor } from './pipeline.js';
import { projectVocabularySource, rankedRefsFromPack  } from './vocabulary-from-pack.js';
import { buildVocabularyIndex, clipText, grainText, renderCard, type VocabularySource } from './vocabulary.js';
import type { EligibleContextSet, LocalContextSkill } from '../metadata/catalog.js';

const base: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', label: 'Revenue', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
    { name: 'gross_revenue', model: 'ledger', label: 'Gross revenue', aggregation: 'sum', physical: { relation: 'dev.ledger', expr: '"dev"."ledger"."amount"', aggregate: 'sum' } },
    { name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."points"', aggregate: 'sum' } },
  ],
  dimensions: [
    { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
    { name: 'account_name', model: 'ledger', dataType: 'string', physical: { relation: 'dev.ledger', column: 'account_name' } },
  ],
  relations: [
    { schema: 'dev', name: 'customers', columns: [{ name: 'customer_id', dataType: 'VARCHAR' }, { name: 'customer_name', dataType: 'VARCHAR' }] },
    { schema: 'dev', name: 'ledger', columns: [{ name: 'account_name', dataType: 'VARCHAR' }] },
  ],
  terms: [{ name: 'Revenue', synonyms: ['sales'], description: 'Money paid for orders.', rules: ['Use product_price for product revenue.'], domain: 'commerce' }, { name: 'Gross revenue', domain: 'finance' }],
};

const eligible = (domains: string[], objects: EligibleContextSet['objects']): EligibleContextSet => ({
  objects, domains, fingerprint: 'sha256:test',
  counts: objects.reduce<Record<string, number>>((acc, object) => ({ ...acc, [object.objectType]: (acc[object.objectType] ?? 0) + 1 }), {}),
});
const skill = (over: Partial<LocalContextSkill>): LocalContextSkill => ({
  objectKey: 'skill:beverage', id: 'beverage-analysis', domain: 'commerce', domains: ['commerce'], modelAreaRefs: [], triggers: ['beverage', 'drinks'], exclusions: [],
  preferredMetrics: ['revenue'], preferredBlocks: [], preferredDimensions: [], requiredFilters: [], clarifyWhen: [], vocabulary: { drinks: 'metric:order_item.revenue' },
  guidance: 'Use the certified beverage blocks first.', guidanceTruncated: false, sourceRefs: [], provenance: 'test', ...over,
});

describe('the vocabulary is a view over the pack', () => {
  it('keeps the whole source when the pack carries no eligible set, and adds nothing it did not select', () => {
    const projected = projectVocabularySource(base, { objects: [], skills: [], appliedHints: [] });
    expect(projected.source.metrics).toHaveLength(3);
    expect(projected.dropped).toEqual({});
    expect(projected.source.skills).toEqual([]);
  });

  it('with no domain pinned, an entry the catalog never indexed is kept and counted as unindexed, never cut', () => {
    const pack = {
      objects: [], skills: [], appliedHints: [],
      eligible: eligible([], [
        { objectKey: 'semantic:metric:order_item.revenue', objectType: 'semantic_metric', name: 'order_item.revenue' },
        { objectKey: 'semantic:dimension:customers.customer_name', objectType: 'semantic_dimension', name: 'customers.customer_name' },
      ]),
    };
    const projected = projectVocabularySource(base, pack);
    expect(projected.source.metrics).toHaveLength(base.metrics!.length);
    expect(projected.source.dimensions).toHaveLength(base.dimensions!.length);
    expect(projected.dropped).toEqual({});
    expect(projected.unindexed).toEqual({ metric: base.metrics!.length - 1, dimension: base.dimensions!.length - 1 });
    expect(projected.admitted.metric).toBe(base.metrics!.length);
  });

  it('projects onto the envelope: an object outside the admitted domains is not in the vocabulary', () => {
    const pack = {
      objects: [], skills: [], appliedHints: [],
      eligible: eligible(['commerce'], [
        { objectKey: 'semantic:metric:order_item.revenue', objectType: 'semantic_metric', name: 'order_item.revenue', domain: 'commerce' },
        { objectKey: 'semantic:metric:points_scored', objectType: 'semantic_metric', name: 'points_scored' },
        { objectKey: 'semantic:dimension:customers.customer_name', objectType: 'semantic_dimension', name: 'customers.customer_name', domain: 'commerce' },
        { objectKey: 'dbt:model:customers', objectType: 'dbt_model', name: 'customers', payload: { relation: 'dev.customers' } },
        { objectKey: 'dql:term:Revenue', objectType: 'dql_term', name: 'Revenue', domain: 'commerce' },
      ]),
    };
    const projected = projectVocabularySource(base, pack);
    expect(projected.source.metrics!.map((metric) => metric.name)).toEqual(['revenue', 'points_scored']);
    expect(projected.source.dimensions!.map((dimension) => dimension.name)).toEqual(['customer_name']);
    expect(projected.source.relations!.map((relation) => relation.name)).toEqual(['customers']);
    expect(projected.source.terms!.map((term) => term.name)).toEqual(['Revenue']);
    expect(projected.dropped).toEqual({ metric: 1, dimension: 1, relation: 1, term: 1 });
    // The finance metric is not "not modeled": it is outside this envelope.
    const vocabulary = buildVocabularyIndex(projected.source);
    expect(vocabulary.get('metric:ledger.gross_revenue')).toBeUndefined();
    expect(vocabulary.get('metric:order_item.revenue')).toBeDefined();
  });

  it('a kind the catalog does not index is left whole rather than emptied', () => {
    const pack = { objects: [], skills: [], appliedHints: [], eligible: eligible(['commerce'], [{ objectKey: 'dql:term:Revenue', objectType: 'dql_term', name: 'Revenue', domain: 'commerce' }]) };
    const projected = projectVocabularySource(base, pack);
    expect(projected.source.metrics).toHaveLength(3);
    expect(projected.admitted.metric).toBe(3);
    expect(projected.source.terms).toHaveLength(1);
  });

  it('adds declared relationships with their authority, the selected skills as an overlay, approved hints and the domain header', () => {
    const pack = {
      objects: [], appliedHints: [{ hintId: 'h1', title: 'Tax', guidance: 'Product revenue excludes tax.', lesson: { category: 'metric', rule: 'exclude tax' } as never, scopeReason: 'commerce', score: 1 }],
      skills: [skill({})],
      domainBriefing: { domainId: 'commerce', name: 'Commerce', description: 'Revenue and customers.', intentExamples: ['Who are the top customers?'], terms: [], caveats: ['Order and product revenue differ by tax.'], requiredFilters: [] },
      eligible: eligible([], [
        { objectKey: 'dql:relationship:commerce::relationship::order_to_customer', objectType: 'relationship', name: 'commerce::relationship::order_to_customer', domain: 'commerce', status: 'draft', description: 'Each order is placed by one customer.', payload: { localId: 'order_to_customer', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', automaticJoinAllowed: false, verb: 'placed by' } },
      ]),
    };
    const projected = projectVocabularySource(base, pack);
    expect(projected.source.relationships).toEqual([expect.objectContaining({ id: 'order_to_customer', from: 'order', to: 'customer', joinAuthority: 'draft', verb: 'placed by' })]);
    expect(projected.source.skills![0]).toMatchObject({ ref: 'skill:beverage-analysis', preferredRefs: ['metric:order_item.revenue'], vocabulary: { drinks: 'metric:order_item.revenue' } });
    expect(projected.source.hints).toEqual([{ id: 'h1', title: 'Tax', guidance: 'Product revenue excludes tax.' }]);
    expect(projected.source.domain).toMatchObject({ id: 'commerce', caveats: ['Order and product revenue differ by tax.'] });

    const vocabulary = buildVocabularyIndex(projected.source);
    // The skill's word is an alias of the ref it names; the preferred ref knows the skill.
    expect(vocabulary.resolve('drinks', ['metric'])?.ref).toBe('metric:order_item.revenue');
    expect(vocabulary.get('metric:order_item.revenue')?.preferredBy).toEqual(['skill:beverage-analysis']);
    const cards = vocabulary.renderCardsDetailed({ header: projected.source.domain, include: { skill: ['skill:beverage-analysis'] } });
    expect(cards.text).toMatch(/^DOMAIN commerce/);
    expect(cards.text).toContain('RELATIONSHIPS (');
    expect(cards.text).toContain('draft; declared, not proven');
    expect(cards.text).toContain('SKILLS (');
    expect(cards.text).toContain('"drinks" → metric:order_item.revenue');
    expect(cards.text).toContain('APPROVED CORRECTIONS (');
    expect(cards.text).toContain('rules: Use product_price for product revenue.');
    expect(cards.text).not.toContain('lookup_vocabulary');
    expect(cards.refs).toContain('relationship:commerce.order_to_customer');
  });

  it('an unselected skill never reaches the page or the aliases', () => {
    const projected = projectVocabularySource(base, { objects: [], skills: [skill({ id: 'selected', vocabulary: { drinks: 'metric:order_item.revenue' } })], appliedHints: [] });
    const vocabulary = buildVocabularyIndex(projected.source);
    const cards = vocabulary.renderCardsDetailed({ include: { skill: ['skill:selected'] } });
    expect(cards.text).toContain('skill:selected');
    // A skill the pack did not select is simply absent: no alias, no card.
    expect(vocabulary.resolve('coffee', ['metric'])).toBeUndefined();
    expect(cards.text).not.toContain('skill:unselected');
  });

  it('the fingerprint changes when what the model reads changes, not only when refs change', () => {
    const one = buildVocabularyIndex(base).fingerprint;
    const withRule = buildVocabularyIndex({ ...base, terms: [{ ...base.terms![0]!, rules: ['Different rule.'] }, base.terms![1]!] }).fingerprint;
    const withAlias = buildVocabularyIndex({ ...base, metrics: [{ ...base.metrics![0]!, aliases: ['turnover'] }, ...base.metrics!.slice(1)] }).fingerprint;
    expect(withRule).not.toBe(one);
    expect(withAlias).not.toBe(one);
  });

  it('per-section caps keep every section present and honest about truncation', () => {
    const many: VocabularySource = { metrics: Array.from({ length: 60 }, (_, index) => ({ name: `metric_${index}`, model: 'm', description: 'x'.repeat(150) })) };
    const cards = buildVocabularyIndex(many).renderCardsDetailed({ sectionCaps: { metric: 2_000 } });
    expect(cards.truncated).toEqual([expect.objectContaining({ kind: 'metric', total: 60 })]);
    expect(cards.rendered.metric).toBeLessThan(60);
    expect(cards.text).toContain('an entry not shown here still exists');
  });

  it('ranked refs render first, and pinned refs render before ranked ones', () => {
    const vocabulary = buildVocabularyIndex(base);
    const ranked = vocabulary.renderCardsDetailed({ rankedRefs: ['metric:points_scored'], sectionCaps: { metric: 200 } });
    expect(ranked.refs.filter((ref) => ref.startsWith('metric:'))[0]).toBe('metric:points_scored');
    const pinned = vocabulary.renderCardsDetailed({ rankedRefs: ['metric:points_scored'], pinnedRefs: ['metric:ledger.gross_revenue'], sectionCaps: { metric: 200 } });
    expect(pinned.refs.filter((ref) => ref.startsWith('metric:'))[0]).toBe('metric:ledger.gross_revenue');
  });

  it('the question\'s own words are pinned exactly, never fuzzily', () => {
    const vocabulary = buildVocabularyIndex(base);
    expect(pinnedRefsFor('what is gross revenue by account name', vocabulary)).toEqual(expect.arrayContaining(['metric:ledger.gross_revenue', 'dimension:ledger.account_name']));
    expect(pinnedRefsFor('what is gros revenu', vocabulary)).not.toContain('metric:ledger.gross_revenue');
  });

  it('ranked refs are derived from the pack objects by type', () => {
    expect(rankedRefsFromPack([
      { objectKey: 'a', objectType: 'semantic_metric', name: 'order_item.revenue' },
      { objectKey: 'b', objectType: 'dbt_model', name: 'customers', payload: { relation: '"jaffle"."dev"."customers"' } },
      { objectKey: 'c', objectType: 'dql_block', name: 'top_customers', domain: 'commerce' },
    ])).toEqual(['metric:order_item.revenue', 'relation:dev.customers', 'block:commerce.top_customers']);
  });
});

describe('a business concept is projected with its bindings as resolvable refs', () => {
  it('offers each binding as the entity\'s relation, once, from the ranked objects and the eligible set', () => {
    const entity = (qualifiedId: string, relation: string) => ({ objectKey: `dql:entity:${qualifiedId}`, objectType: 'dql_entity', name: qualifiedId.split('::').pop()!, payload: { qualifiedId, relation } });
    const concept = { objectKey: 'dql:concept:commerce::concept::customer', objectType: 'concept', name: 'customer', domain: 'commerce', status: 'reviewed', payload: { localId: 'customer', name: 'Customer', synonyms: ['buyer'], bindings: [{ entity: 'commerce::entity::customer', domain: 'commerce', role: 'canonical', grain: 'customer_id' }, { entity: 'growth::entity::acquisition', domain: 'growth', role: 'conformed' }] } };
    const pack = {
      objects: [concept] as never[], skills: [], appliedHints: [],
      eligible: eligible([], [concept, entity('commerce::entity::customer', '"warehouse"."dev"."customers"'), entity('growth::entity::acquisition', 'dev.customer_acquisition')]),
    };
    const projected = projectVocabularySource(base, pack);
    expect(projected.source.concepts).toEqual([{
      id: 'customer', domain: 'commerce', name: 'Customer', synonyms: ['buyer'], status: 'reviewed',
      bindings: [
        { entityRef: 'relation:dev.customers', domain: 'commerce', role: 'canonical', grain: 'customer_id' },
        { entityRef: 'relation:dev.customer_acquisition', domain: 'growth', role: 'conformed' },
      ],
    }]);
    expect(projected.admitted.concept).toBe(1);
    const vocabulary = buildVocabularyIndex(projected.source);
    expect(vocabulary.get('concept:commerce.customer')?.kind).toBe('concept');
    expect(vocabulary.resolve('buyer', ['concept'])?.ref).toBe('concept:commerce.customer');
  });
});

describe('columns the retrieval ranked reach the vocabulary and lead their relation card', () => {
  const base = { relations: [{ schema: 'ada', name: 'ada_sfdc_opportunity', columns: Array.from({ length: 60 }, (_, index) => ({ name: `col_${String(index).padStart(2, '0')}` })) }] };
  const objects = [
    { objectKey: 'dbt:column:ada_sfdc_opportunity.amount', objectType: 'dbt_column', name: 'amount', fullName: 'ada_sfdc_opportunity.amount', description: 'Opportunity amount', payload: { relation: '"DB"."ada"."ada_sfdc_opportunity"', type: 'NUMBER' } },
    { objectKey: 'dbt:column:ada_sfdc_opportunity.col_59', objectType: 'dbt_column', name: 'col_59', fullName: 'ada_sfdc_opportunity.col_59', payload: { model: 'ada_sfdc_opportunity', type: 'VARCHAR' } },
    { objectKey: 'dbt:column:elsewhere.x', objectType: 'dbt_column', name: 'x', fullName: 'elsewhere.x', payload: { relation: 'other.elsewhere' } },
  ] as never[];
  it('a ranked column merges into its relation with its type and description; a column of an unadmitted relation is not', () => {
    const projected = projectVocabularySource(base as never, { objects, skills: [], appliedHints: [] });
    const relation = projected.source.relations![0]!;
    expect(relation.columns.find((column) => column.name === 'amount')).toEqual({ name: 'amount', dataType: 'NUMBER', description: 'Opportunity amount' });
    expect(relation.columns.find((column) => column.name === 'col_59')?.dataType).toBe('VARCHAR');
    expect(projected.source.relations).toHaveLength(1);
    expect(rankedRefsFromPack(objects)).toEqual(['column:ada.ada_sfdc_opportunity.amount', 'column:ada_sfdc_opportunity.col_59', 'column:other.elsewhere.x']);
  });
  it('the ranked columns lead the relation card instead of the first forty names', () => {
    const projected = projectVocabularySource(base as never, { objects, skills: [], appliedHints: [] });
    const index = buildVocabularyIndex(projected.source);
    const card = index.renderCardsDetailed({ rankedRefs: rankedRefsFromPack(objects) }).text.split('\n').find((line) => line.startsWith('- relation:ada.ada_sfdc_opportunity'))!;
    expect(card).toMatch(/columns: (amount, col_59|col_59, amount)/);
    expect(card).toContain(', ...');
    expect(index.withEntries([{ ref: 'column:ada.ada_sfdc_opportunity.new_col', kind: 'column', name: 'new_col', aliases: [], model: 'ada.ada_sfdc_opportunity', roles: ['numeric'], dataType: 'NUMBER' }]).get('column:ada.ada_sfdc_opportunity.new_col')?.dataType).toBe('NUMBER');
  });
});

describe('a modeled entity on its relation card', () => {
  const source = (meaning: { businessContext?: string; grain?: string; deprecated?: boolean }): VocabularySource => ({
    relations: [{ name: 'player_seasons', schema: 'nba', columns: [{ name: 'player_id' }, { name: 'season' }] }],
    relationMeaning: { 'nba.player_seasons': { businessName: 'Player season', domain: 'nba', ...meaning } },
  } as unknown as VocabularySource);
  const card = (meaning: Parameters<typeof source>[0]) => {
    const entry = buildVocabularyIndex(source(meaning)).entries.find((item) => item.kind === 'relation');
    return entry ? renderCard(entry) : '';
  };

  it('says the grain once, however it was written', () => {
    expect(card({ grain: 'one row per player per season (player_id, season)' })).toContain(' one row per player per season (player_id, season)');
    expect(card({ grain: 'one row per player per season (player_id, season)' })).not.toContain('one row per one row');
    expect(card({ grain: 'player_id, season' })).toContain(' one row per player_id, season');
  });

  it('keeps a long business context to a sentence end, past 160 characters', () => {
    const context = 'A player\'s totals for one season, 2003-2022, all game types combined. Counts only games the player played. Use for season leaders and per-game averages. For career figures, sum the totals across rows and recompute ratios from the sums.';
    const rendered = card({ businessContext: context });
    expect(rendered).toContain('For career figures, sum the totals across rows and recompute ratios from the sums.');
    expect(rendered).not.toMatch(/ Use$/);
  });

  it('marks a relation whose entity is deprecated, or that a drafted table pick prefers another over', () => {
    expect(card({ deprecated: true })).toContain('deprecated: do not use for answers');
    expect(card({})).not.toContain('deprecated');
    expect(card({ useInstead: { relation: 'nba.player_seasons', reason: 'covers season 2009–2019; player_seasons covers season 2003–2022' } }))
      .toContain('a drafted table pick prefers nba.player_seasons (covers season 2009–2019; player_seasons covers season 2003–2022)');
  });
});

describe('clipText and grainText', () => {
  it('cut at a sentence end, else at a word', () => {
    expect(clipText('One two three. Four five six.', 20)).toBe('One two three.');
    expect(clipText('One. Two three four.', 12)).toBe('One. Two…');
    expect(clipText('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(clipText('  short  text ', 40)).toBe('short text');
  });

  it('read a grain after "one row per"', () => {
    expect(grainText('One row per game')).toBe('game');
    expect(grainText('1 row for each order')).toBe('order');
    expect(grainText('order_id')).toBe('order_id');
  });
});
