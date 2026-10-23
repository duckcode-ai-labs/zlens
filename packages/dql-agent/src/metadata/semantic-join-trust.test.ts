import { describe, expect, it } from 'vitest';
import { relationshipValidationProofFingerprint, type DQLManifest, type SemanticJoinStep } from '@zlens/core';
import { assessSemanticJoinTrust } from './semantic-join-trust.js';

/**
 * A semantic compile is From Metrics only when every join it takes is a
 * certified DQL relationship. Found on 2026-10-23: "How many large orders did
 * each location get?" compiled orders → locations through the draft
 * relationship order_to_location and was labelled Governed.
 */
describe('assessSemanticJoinTrust', () => {
  const ordersToLocations: SemanticJoinStep = {
    left: 'orders', right: 'locations',
    leftTable: '"jaffle"."marts"."fct_orders"', rightTable: '"jaffle"."marts"."dim_locations"',
    keys: [{ from: 'location_id', to: 'location_id' }],
  };

  it('certifies a compile that takes no join', () => {
    expect(assessSemanticJoinTrust([], manifest())).toEqual({ certified: true, joins: [] });
    expect(assessSemanticJoinTrust(undefined, manifest())).toEqual({ certified: true, joins: [] });
  });

  it('does not certify a join through a draft relationship, and names it', () => {
    const trust = assessSemanticJoinTrust([ordersToLocations], manifest());
    expect(trust.certified).toBe(false);
    expect(trust.joins[0]).toMatchObject({
      from: 'fct_orders', to: 'dim_locations', relationshipName: 'order_to_location', status: 'draft', certified: false,
    });
    expect(trust.caveat).toContain('relationship "order_to_location", which is draft, not certified');
    expect(trust.caveat).toContain('Certify the relationship in Modeling');
  });

  it('certifies a join through a certified relationship with a valid warehouse proof', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_location = certifiedRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id');
    const trust = assessSemanticJoinTrust([ordersToLocations], value);
    expect(trust.certified).toBe(true);
    expect(trust.caveat).toBeUndefined();
    expect(trust.joins[0]).toMatchObject({ relationshipId: 'commerce::relationship::order_to_location', certified: true });
  });

  it('matches the relationship whichever way the compiler took the join', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_location = certifiedRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id');
    const reversed: SemanticJoinStep = {
      left: 'locations', right: 'orders', leftTable: ordersToLocations.rightTable, rightTable: ordersToLocations.leftTable, keys: [{ from: 'location_id', to: 'location_id' }],
    };
    expect(assessSemanticJoinTrust([reversed], value).certified).toBe(true);
  });

  it('does not certify a certified relationship whose proof no longer holds', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_location = { ...certifiedRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id'), staleCertification: true };
    const trust = assessSemanticJoinTrust([ordersToLocations], value);
    expect(trust.certified).toBe(false);
    expect(trust.caveat).toContain('certified but its proof does not hold');
  });

  it('does not certify a join no relationship models, or one on other keys', () => {
    const unmodeled = assessSemanticJoinTrust([{ ...ordersToLocations, rightTable: 'jaffle.marts.dim_stores' }], manifest());
    expect(unmodeled.certified).toBe(false);
    expect(unmodeled.caveat).toContain('fct_orders → dim_stores is not modeled as a DQL relationship');

    const value = manifest();
    value.modeling!.relationships.order_to_location = certifiedRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id');
    const otherKeys = assessSemanticJoinTrust([{ ...ordersToLocations, keys: [{ from: 'billing_location_id', to: 'location_id' }] }], value);
    expect(otherKeys.certified).toBe(false);
    expect(otherKeys.joins[0]!.reason).toContain('No DQL relationship joins fct_orders to dim_locations on billing_location_id = location_id');
  });

  it('needs every join certified: one draft join among certified ones is enough to refuse', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_location = certifiedRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id');
    const ordersToCustomers: SemanticJoinStep = {
      left: 'orders', right: 'customers', leftTable: 'marts.fct_orders', rightTable: 'marts.dim_customers', keys: [{ from: 'customer_id', to: 'customer_id' }],
    };
    const trust = assessSemanticJoinTrust([ordersToLocations, ordersToCustomers], value);
    expect(trust.certified).toBe(false);
    expect(trust.joins.map((join) => join.certified)).toEqual([true, false]);
    expect(trust.caveat).toContain('order_to_customer');
    expect(trust.caveat).not.toContain('order_to_location');
  });

  it('refuses every join when the project models no relationships', () => {
    const value = manifest();
    delete value.modeling;
    expect(assessSemanticJoinTrust([ordersToLocations], value).certified).toBe(false);
  });
});

function manifest(): DQLManifest {
  const models: Array<[string, string]> = [
    ['order', 'fct_orders'],
    ['customer', 'dim_customers'],
    ['location', 'dim_locations'],
  ];
  return {
    manifestVersion: 3,
    dqlVersion: '2.0.0',
    generatedAt: '2026-10-23T00:00:00.000Z',
    project: 'jaffle',
    projectRoot: '/fixture',
    blocks: {},
    businessViews: {},
    terms: {},
    notebooks: {},
    metrics: {},
    dimensions: {},
    sources: {},
    lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    dbtProvenance: {
      manifestPath: '/fixture/target/manifest.json',
      manifestFingerprint: 'manifest',
      nodes: Object.fromEntries(models.map(([, name]) => [`model.jaffle.${name}`, {
        uniqueId: `model.jaffle.${name}`,
        resourceType: 'model' as const,
        name,
        relation: `jaffle.marts.${name}`,
        identityFingerprint: name,
        available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
      }])),
      metricFlow: {},
    },
    modeling: {
      mode: 'dbt-first',
      packages: {},
      entities: Object.fromEntries(models.map(([id, name]) => [id, {
        id: `commerce::entity::${id}`, localId: id, qualifiedId: `commerce::entity::${id}`, dbtUniqueId: `model.jaffle.${name}`,
        domain: 'commerce', grain: `${id}_id`, keys: [`${id}_id`], sourcePath: 'modeling/model.dql.yaml', identityFingerprint: id,
      }])),
      relationships: {
        order_to_customer: draftRelationship('order_to_customer', 'order', 'customer', 'customer_id'),
        order_to_location: draftRelationship('order_to_location', 'order', 'location', 'location_id'),
      },
      contracts: {},
      conformance: {},
      rules: {},
      domainLineage: [],
    },
  } as DQLManifest;
}

function draftRelationship(id: string, from: string, to: string, key: string) {
  return {
    id,
    localId: id,
    qualifiedId: `commerce::relationship::${id}`,
    from,
    to,
    keys: [{ from: key, to: key }],
    cardinality: 'many_to_one' as const,
    fanout: 'safe' as const,
    status: 'draft' as const,
    crossDomain: false,
    sourcePath: 'modeling/model.dql.yaml',
    fingerprint: id,
    staleCertification: false,
    automaticJoinAllowed: false,
  };
}

function certifiedRelationship(id: string, from: string, to: string, fromModel: string, toModel: string, key: string) {
  const queryFingerprint = `${id}-validation-query`;
  return {
    ...draftRelationship(id, from, to, key),
    status: 'certified' as const,
    automaticJoinAllowed: true,
    certificationFingerprint: `${id}-certification`,
    validation: {
      status: 'passed' as const,
      checkedAt: '2026-10-22T00:00:00.000Z',
      queryFingerprint,
      proofFingerprint: relationshipValidationProofFingerprint({
        fromRelation: `jaffle.marts.${fromModel}`,
        toRelation: `jaffle.marts.${toModel}`,
        keys: [{ from: key, to: key }],
        cardinality: 'many_to_one',
        fanout: 'safe',
        queryFingerprint,
      }),
      fromRows: 10,
      toRows: 5,
      joinedRows: 10,
      fromNullKeys: 0,
      toNullKeys: 0,
      unmatchedFrom: 0,
      maxFromPerKey: 5,
      maxToPerKey: 1,
    },
  };
}
