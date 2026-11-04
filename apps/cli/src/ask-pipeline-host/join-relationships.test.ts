import { describe, expect, it } from 'vitest';
import { joinKeyPairs } from '@zlens/agent';
import type { DQLManifest } from '@zlens/core';
import { businessIdentifierLine, businessIdentifiers, certifiedJoinViolations, classifySqlJoins, joinableRelations, ledgerJoins, markerTableLine, markerTables, modeledJoinPaths, modelingRelationshipTables, sameRelation, sharedParentShortcuts, type ModelingRelationshipEdge } from './join-relationships.js';

const certified: ModelingRelationshipEdge = {
  relationshipId: 'commerce::relationship::orders_to_customers', name: 'orders_to_customers',
  fromRelation: 'dev.orders', toRelation: 'dev.customers', keys: [{ from: 'customer_id', to: 'customer_id' }], level: 'certified', cardinality: 'many_to_one',
};
const draft: ModelingRelationshipEdge = {
  relationshipId: 'commerce::relationship::items_to_products', name: 'items_to_products',
  fromRelation: 'dev.order_items', toRelation: 'dev.products', keys: [{ from: 'product_id', to: 'product_id' }], level: 'draft', cardinality: 'many_to_one',
};

const uses = (sql: string, edges = [certified, draft]) => classifySqlJoins(joinKeyPairs(sql), edges);

describe('the tables a modeled relationship joins', () => {
  const entity = (domain: string, localId: string, model: string) => ({ id: `${domain}::entity::${localId}`, localId, qualifiedId: `${domain}::entity::${localId}`, domain, dbtUniqueId: `model.nba.${model}` });
  const relationship = (domain: string, localId: string, from: string, to: string) => ({ id: `${domain}::relationship::${localId}`, localId, qualifiedId: `${domain}::relationship::${localId}`, from: `${domain}::entity::${from}`, to: `${domain}::entity::${to}`, keys: [{ from: 'player_id', to: 'player_id' }] });
  const manifest = {
    dbtProvenance: { nodes: Object.fromEntries(['player_game_facts', 'player_season_facts', 'team_game_facts'].map((model) => [`model.nba.${model}`, { relation: `"nba"."transformed"."${model}"` }])) },
    modeling: {
      entities: Object.fromEntries([entity('nba', 'player_game', 'player_game_facts'), entity('nba', 'player_season', 'player_season_facts'), entity('nba', 'team_game', 'team_game_facts'), entity('archive', 'player_game', 'team_game_facts')].map((item) => [item.qualifiedId, item])),
      relationships: Object.fromEntries([
        relationship('nba', 'player_game_to_player_season', 'player_game', 'player_season'),
        relationship('nba', 'team_game_to_opponent_line', 'team_game', 'team_game'),
        relationship('nba', 'rolls_up', 'player_game', 'player_season'),
        relationship('archive', 'rolls_up', 'player_game', 'player_game'),
      ].map((item) => [item.qualifiedId, item])),
    },
  } as unknown as DQLManifest;

  it('names the two tables its entities are bound to, a table joined to itself included', () => {
    const tables = modelingRelationshipTables(manifest);
    expect(tables.get('nba::relationship::player_game_to_player_season')).toEqual({ from: 'transformed.player_game_facts', to: 'transformed.player_season_facts' });
    expect(tables.get('player_game_to_player_season')).toEqual(tables.get('nba::relationship::player_game_to_player_season'));
    expect(tables.get('team_game_to_opponent_line')).toEqual({ from: 'transformed.team_game_facts', to: 'transformed.team_game_facts' });
  });

  it('a local id two domains share names no tables on its own', () => {
    const tables = modelingRelationshipTables(manifest);
    expect(tables.get('rolls_up')).toBeNull();
    expect(tables.get('nba::relationship::rolls_up')).toEqual({ from: 'transformed.player_game_facts', to: 'transformed.player_season_facts' });
  });
});

describe('AI-written joins against Modeling relationships', () => {
  it('matches relation spellings on schema and table', () => {
    expect(sameRelation('"jaffle"."dev"."orders"', 'dev.orders')).toBe(true);
    expect(sameRelation('orders', 'dev.orders')).toBe(true);
    expect(sameRelation('prod.orders', 'dev.orders')).toBe(false);
  });

  it('passes a join on the certified keys, written in either direction', () => {
    const sql = 'SELECT c.customer_name, SUM(o.order_total) FROM dev.customers c JOIN dev.orders o ON c.customer_id = o.customer_id GROUP BY 1';
    const joined = uses(sql);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ matchesRelationship: true, relationship: { name: 'orders_to_customers' } });
    expect(certifiedJoinViolations(sql, joined)).toEqual([]);
    expect(ledgerJoins(joined)).toEqual([{ source: 'dql_relationship', relationshipId: certified.relationshipId, name: 'orders_to_customers', authority: 'certified', relations: ['dev.customers', 'dev.orders'], keys: [{ from: 'customer_id', to: 'customer_id' }] }]);
  });

  it('refuses a certified pair of tables joined on other keys, naming the keys to use', () => {
    const sql = 'SELECT COUNT(*) FROM dev.orders o JOIN dev.customers c ON o.order_id = c.customer_id';
    const joined = uses(sql);
    const violations = certifiedJoinViolations(sql, joined);
    expect(violations).toEqual(['it joins dev.orders and dev.customers on dev.orders.order_id = dev.customers.customer_id, but the certified relationship orders_to_customers joins them on dev.orders.customer_id = dev.customers.customer_id; join on exactly those keys']);
    expect(ledgerJoins(joined)[0]).toMatchObject({ source: 'ai_sql', authority: 'none', name: 'orders_to_customers' });
  });

  it('holds a multi-key certified relationship to all of its keys', () => {
    const edge: ModelingRelationshipEdge = { ...certified, keys: [{ from: 'customer_id', to: 'customer_id' }, { from: 'region', to: 'region' }] };
    const partial = 'SELECT 1 FROM dev.orders o JOIN dev.customers c ON o.customer_id = c.customer_id';
    expect(certifiedJoinViolations(partial, uses(partial, [edge]))).toHaveLength(1);
    const full = 'SELECT 1 FROM dev.orders o JOIN dev.customers c ON o.customer_id = c.customer_id AND o.region = c.region';
    expect(certifiedJoinViolations(full, uses(full, [edge]))).toEqual([]);
  });

  it('reaches the one side of validated and certified relationships only', () => {
    const validated: ModelingRelationshipEdge = { ...draft, relationshipId: 'v', name: 'v', level: 'validated' };
    const customersToOrders: ModelingRelationshipEdge = { ...certified, fromRelation: 'dev.customers', toRelation: 'dev.orders', cardinality: 'one_to_many', keys: [{ from: 'customer_id', to: 'customer_id' }] };
    expect(joinableRelations([certified, draft], ['dev.orders'])).toEqual(['dev.customers']);
    expect(joinableRelations([customersToOrders], ['dev.orders'])).toEqual(['dev.customers']);
    // A draft is not reached; the many side of a relationship is never reached.
    expect(joinableRelations([draft], ['dev.order_items'])).toEqual([]);
    expect(joinableRelations([certified], ['dev.customers'])).toEqual([]);
    expect(joinableRelations([validated], ['order_items'])).toEqual(['dev.products']);
  });

  it('never gates a draft relationship or a join nobody declared, but records both', () => {
    const sql = 'SELECT p.product_name, SUM(i.product_price) FROM dev.order_items i JOIN dev.products p ON i.product_id = p.product_id JOIN dev.locations l ON i.location_id = l.location_id GROUP BY 1';
    const joined = uses(sql);
    expect(certifiedJoinViolations(sql, joined)).toEqual([]);
    expect(ledgerJoins(joined)).toEqual([
      { source: 'dql_relationship', relationshipId: draft.relationshipId, name: 'items_to_products', authority: 'draft', relations: ['dev.order_items', 'dev.products'], keys: [{ from: 'product_id', to: 'product_id' }] },
      { source: 'ai_sql', authority: 'none', relations: ['dev.order_items', 'dev.locations'], keys: [{ from: 'location_id', to: 'location_id' }] },
    ]);
  });
});

describe('tables between the chosen ones, over the Modeling map', () => {
  const hop = (from: string, to: string, key: string, level: ModelingRelationshipEdge['level'] = 'certified'): ModelingRelationshipEdge => ({
    relationshipId: `${from}_${to}`, name: `${from}_${to}`, fromRelation: `main.${from}`, toRelation: `main.${to}`,
    keys: [{ from: key, to: key }], level, cardinality: 'many_to_one',
  });
  // claim -> claim_coverage -> coverage_detail -> policy, plus a draft shortcut and an unrelated branch.
  const edges = [
    hop('claim_coverage', 'claim', 'claim_id'),
    hop('claim_coverage', 'coverage_detail', 'coverage_id'),
    hop('coverage_detail', 'policy', 'policy_id'),
    hop('claim', 'policy', 'policy_ref', 'draft'),
    hop('policy', 'agent', 'agent_id'),
  ];

  it('adds the bridge tables on the certified route between two named tables', () => {
    const { paths, added } = modeledJoinPaths(['"db"."main"."claim"', '"db"."main"."policy"'], edges.filter((edge) => edge.level === 'certified'));
    expect(added).toEqual(['main.claim_coverage', 'main.coverage_detail']);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.edges.map((edge) => edge.name)).toEqual(['claim_coverage_claim', 'claim_coverage_coverage_detail', 'coverage_detail_policy']);
  });

  it('prefers a certified route of up to three hops over a direct draft join', () => {
    const route = modeledJoinPaths(['main.claim', 'main.policy'], edges);
    expect(route.added).toEqual(['main.claim_coverage', 'main.coverage_detail']);
    expect(route.paths[0]!.edges.every((edge) => edge.level === 'certified')).toBe(true);
    // Beyond the hop limit the draft join is the only route, and it is used.
    const short = modeledJoinPaths(['main.claim', 'main.policy'], edges, { maxHops: 2 });
    expect(short.added).toEqual([]);
    expect(short.paths[0]!.edges[0]!.level).toBe('draft');
  });

  it('respects the hop and size limits and never routes through another chosen table', () => {
    const certified = edges.filter((edge) => edge.level === 'certified');
    expect(modeledJoinPaths(['main.claim', 'main.policy'], certified, { maxHops: 2 }).paths).toEqual([]);
    expect(modeledJoinPaths(['main.claim', 'main.policy'], certified, { maxAdded: 1 }).added).toEqual([]);
    const viaChosen = modeledJoinPaths(['main.claim', 'main.coverage_detail', 'main.agent'], certified);
    expect(viaChosen.paths.every((path) => !path.through.some((node) => ['main.claim', 'main.coverage_detail', 'main.agent'].includes(node)))).toBe(true);
    expect(viaChosen.added).toEqual(['main.claim_coverage', 'main.policy']);
  });

  it('adds nothing for one table, unmodeled tables, or tables already joined directly', () => {
    expect(modeledJoinPaths(['main.claim'], edges).added).toEqual([]);
    expect(modeledJoinPaths(['main.orders', 'main.customers'], edges).paths).toEqual([]);
    const direct = modeledJoinPaths(['main.policy', 'main.agent'], edges);
    expect(direct.added).toEqual([]);
    expect(direct.paths[0]!.edges[0]!.name).toBe('policy_agent');
  });
});

describe('marker tables: a key-only side of a one-to-one relationship', () => {
  const edge = (from: string, to: string, key: string, cardinality = 'one_to_one'): ModelingRelationshipEdge => ({
    relationshipId: `${from}_${to}`, name: `${from}_is_${to}`, fromRelation: `main.${from}`, toRelation: `main.${to}`, keys: [{ from: key, to: key }], level: 'certified', cardinality,
  });
  const columns: Record<string, string[]> = {
    '"db"."main"."loss_payment"': ['Claim_Amount_Identifier'],
    '"db"."main"."claim_amount"': ['Claim_Amount_Identifier', 'Claim_Identifier', 'Claim_Amount'],
    '"db"."main"."policy"': ['policy_id', 'policy_number'],
    '"db"."main"."policy_extra"': ['policy_id', 'note'],
  };
  const columnsOf = (relation: string) => columns[relation] ?? [];

  it('names the marker, its base and the join, whichever direction the relationship was declared', () => {
    const found = markerTables(['"db"."main"."loss_payment"', '"db"."main"."claim_amount"'], [edge('claim_amount', 'loss_payment', 'Claim_Amount_Identifier')], columnsOf);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ marker: '"db"."main"."loss_payment"', base: '"db"."main"."claim_amount"' });
    expect(markerTableLine(found[0]!)).toContain('For "loss payment" values, use the "db"."main"."claim_amount" rows that have a matching "db"."main"."loss_payment" row (JOIN "db"."main"."loss_payment" ON "db"."main"."loss_payment".Claim_Amount_Identifier = "db"."main"."claim_amount".Claim_Amount_Identifier)');
  });

  it('names the base even when only the marker was chosen, and ignores tables with columns of their own or other cardinalities', () => {
    const onlyMarker = markerTables(['"db"."main"."loss_payment"'], [edge('loss_payment', 'claim_amount', 'Claim_Amount_Identifier')], columnsOf);
    expect(onlyMarker.map((item) => item.base)).toEqual(['main.claim_amount']);
    expect(markerTables(['"db"."main"."policy"', '"db"."main"."policy_extra"'], [edge('policy_extra', 'policy', 'policy_id')], columnsOf)).toEqual([]);
    expect(markerTables(['"db"."main"."loss_payment"'], [edge('loss_payment', 'claim_amount', 'Claim_Amount_Identifier', 'many_to_one')], columnsOf)).toEqual([]);
  });
});

describe('tables linked only by a parent they both reference', () => {
  // A ticket is raised against a service contract through ticket_contracts (a
  // bridge); tickets and contracts also both name the asset involved. Asset
  // edges are declared first, so a search blind to direction would tie on them.
  const edge = (from: string, to: string, keys: Array<{ from: string; to: string }>): ModelingRelationshipEdge => ({
    relationshipId: `svc::relationship::${from}_to_${to}`, name: `${from}_to_${to}`, fromRelation: `dev.${from}`, toRelation: `dev.${to}`, keys, level: 'certified', cardinality: 'many_to_one',
  });
  const edges = [
    edge('tickets', 'assets', [{ from: 'asset_id', to: 'asset_id' }]),
    edge('contracts', 'assets', [{ from: 'asset_id', to: 'asset_id' }]),
    edge('ticket_contracts', 'tickets', [{ from: 'ticket_id', to: 'ticket_id' }]),
    edge('ticket_contracts', 'contracts', [{ from: 'contract_id', to: 'contract_id' }]),
    edge('contracts', 'accounts', [{ from: 'account_id', to: 'account_id' }]),
    edge('ticket_amounts', 'tickets', [{ from: 'ticket_id', to: 'ticket_id' }]),
  ];

  it('routes through the bridge, not up to the shared asset and back down', () => {
    const { paths } = modeledJoinPaths(['dev.tickets', 'dev.accounts'], edges);
    expect(paths[0]!.through).toEqual(['dev.ticket_contracts', 'dev.contracts']);
  });

  it('flags a join through the shared parent, and one on the two references directly, naming the modeled route', () => {
    const through = 'SELECT a.account_id, SUM(m.amount) FROM dev.ticket_amounts m JOIN dev.tickets t ON m.ticket_id = t.ticket_id JOIN dev.assets s ON t.asset_id = s.asset_id JOIN dev.contracts c ON c.asset_id = s.asset_id JOIN dev.accounts a ON c.account_id = a.account_id GROUP BY 1';
    const direct = 'SELECT a.account_id, SUM(m.amount) FROM dev.ticket_amounts m JOIN dev.tickets t ON m.ticket_id = t.ticket_id JOIN dev.contracts c ON c.asset_id = t.asset_id JOIN dev.accounts a ON c.account_id = a.account_id GROUP BY 1';
    for (const sql of [through, direct]) {
      const failures = sharedParentShortcuts(classifySqlJoins(joinKeyPairs(sql), edges), edges);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/relates (tickets to contracts|contracts to tickets) through assets, which both only reference.*tickets -> ticket_contracts -> contracts|contracts -> ticket_contracts -> tickets/);
    }
  });

  it('passes the modeled route, and a shared parent that is the only modeled connection', () => {
    const modeled = 'SELECT a.account_id, SUM(m.amount) FROM dev.ticket_amounts m JOIN dev.tickets t ON m.ticket_id = t.ticket_id JOIN dev.ticket_contracts tc ON tc.ticket_id = t.ticket_id JOIN dev.contracts c ON c.contract_id = tc.contract_id JOIN dev.accounts a ON c.account_id = a.account_id GROUP BY 1';
    // ticket_amounts and ticket_contracts both reference tickets, and nothing else connects them.
    expect(sharedParentShortcuts(classifySqlJoins(joinKeyPairs(modeled), edges), edges)).toEqual([]);
  });
});

describe('business identifiers beside internal keys', () => {
  const columns: Record<string, string[]> = {
    'dev.policy': ['Policy_Identifier', 'Policy_Number', 'Effective_Date', 'Status_Code'],
    'dev.claim': ['Claim_Identifier', 'Company_Claim_Number', 'Catastrophe_Identifier'],
    'dev.orders': ['order_id', 'customer_id', 'order_total'],
    'dev.party_role': ['Party_Role_Code', 'Party_Role_Name'],
    'dev.ticket': ['ticket_id', 'ticket_number', 'ticket_code'],
  };
  const columnsOf = (relation: string) => columns[relation] ?? [];

  it('names the number people use for a table with an internal key', () => {
    const found = businessIdentifiers(['dev.policy', 'dev.claim', 'dev.orders', 'dev.party_role'], columnsOf);
    expect(found).toEqual([
      { relation: 'dev.policy', key: 'Policy_Identifier', identifier: 'Policy_Number' },
      { relation: 'dev.claim', key: 'Claim_Identifier', identifier: 'Company_Claim_Number' },
    ]);
    expect(businessIdentifierLine(found[0]!)).toBe('- policy rows are known to people by Policy_Number; Policy_Identifier is the internal key. When the answer lists or groups policy rows, show Policy_Number beside Policy_Identifier.');
  });

  it('says nothing when two columns could be the identifier', () => {
    expect(businessIdentifiers(['dev.ticket'], columnsOf)).toEqual([]);
  });
});
