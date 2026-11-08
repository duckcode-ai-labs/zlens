import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@zlens/core';
import { catalogKeyTypes, looksLikePlaceholder, relationshipEvidenceFromRow, relationshipValidationSql, validateRelationshipOnWarehouse } from './relationship-validation.js';

const quote = (identifier: string) => `"${identifier}"`;
const spec = { fromRelation: 'analytics.marts.fct_orders', toRelation: 'analytics.marts.dim_customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one' as const, fanout: 'safe' as const };
const passingRow = { from_rows: 10, to_rows: 5, joined_rows: 10, from_null_keys: 0, to_null_keys: 0, unmatched_from: 0, max_from_per_key: 5, max_to_per_key: 1 };

describe('the one relationship proof', () => {
  it('asks the warehouse one statement: counts, null keys, rows per key on both sides, joined rows and rows the join would drop', () => {
    const sql = relationshipValidationSql(spec, quote);
    expect(sql).toContain('FROM "analytics"."marts"."fct_orders" f');
    // Joined and dropped rows come from per-key counts, never from running a possibly many-to-many join.
    expect(sql).toContain('from_keys AS (SELECT "customer_id", COUNT(*) AS key_count FROM "analytics"."marts"."fct_orders" GROUP BY "customer_id")');
    expect(sql).toContain('FROM from_keys f JOIN to_keys t ON f."customer_id" = t."customer_id"');
    expect(sql).toContain('FROM from_keys f LEFT JOIN to_keys t ON f."customer_id" = t."customer_id" WHERE t.key_count IS NULL');
    expect(sql).not.toMatch(/"fct_orders" f (?:LEFT )?JOIN "analytics"/);
    for (const column of ['from_rows', 'to_rows', 'joined_rows', 'from_null_keys', 'to_null_keys', 'unmatched_from', 'max_from_per_key', 'max_to_per_key']) expect(sql).toContain(`AS ${column}`);
    expect(() => relationshipValidationSql({ ...spec, keys: [{ from: 'customer_id; drop table x', to: 'customer_id' }] }, quote)).toThrow();
    // The counts equal the ones a real join gives: NULL keys, unmatched keys and a many-to-many key included.
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE f (k INTEGER, j INTEGER); CREATE TABLE t (k INTEGER, j INTEGER);
        INSERT INTO f VALUES (1,1),(1,1),(1,2),(2,1),(NULL,1),(3,NULL),(9,9);
        INSERT INTO t VALUES (1,1),(1,1),(1,1),(2,1),(2,2),(NULL,1),(3,NULL)`);
      for (const keys of [[{ from: 'k', to: 'k' }], [{ from: 'k', to: 'k' }, { from: 'j', to: 'j' }]]) {
        const grouped = db.prepare(relationshipValidationSql({ ...spec, fromRelation: 'f', toRelation: 't', keys }, quote)).get() as Record<string, number>;
        const on = keys.map((key) => `f.${key.from} = t.${key.to}`).join(' AND ');
        const direct = db.prepare(`SELECT (SELECT COUNT(*) FROM f JOIN t ON ${on}) AS joined_rows,
          (SELECT COUNT(*) FROM f LEFT JOIN t ON ${on} WHERE t.${keys[0]!.to} IS NULL) AS unmatched_from`).get() as Record<string, number>;
        expect({ joined_rows: grouped.joined_rows, unmatched_from: grouped.unmatched_from }).toEqual(direct);
      }
    } finally {
      db.close();
    }
    // The text is the same on every engine but those where `rows` is reserved (MySQL/MariaDB, and
    // Snowflake and BigQuery: Snowflake refused every join check with it, live 2026-11-07), where the
    // inner alias is renamed; the columns read back are unchanged.
    expect(relationshipValidationSql(spec, quote, 'duckdb')).toBe(sql);
    expect(sql).toContain('COUNT(*) AS rows');
    for (const dialect of ['mysql', 'snowflake', 'bigquery']) {
      const renamed = relationshipValidationSql(spec, (identifier) => `\`${identifier}\``, dialect);
      expect(renamed, dialect).not.toMatch(/\bAS rows\b|\.rows\b/);
      expect(renamed, dialect).toContain('from_counts.row_total AS from_rows');
    }
  });
  it('reads the same evidence whoever ran it, and the declared cardinality decides pass or fail', async () => {
    const checkedAt = new Date('2026-09-09T00:00:00.000Z');
    const sql = relationshipValidationSql(spec, quote);
    const direct = relationshipEvidenceFromRow(passingRow, spec, sql, checkedAt);
    const viaWarehouse = await validateRelationshipOnWarehouse(spec, async () => ({ rows: [passingRow] }), quote, checkedAt);
    expect(viaWarehouse).toEqual(direct);
    expect(direct).toMatchObject({ status: 'passed', fromRows: 10, toRows: 5, joinedRows: 10, unmatchedFrom: 0, maxToPerKey: 1 });
    // Upper-cased columns (Snowflake) read the same.
    const upper = Object.fromEntries(Object.entries(passingRow).map(([key, value]) => [key.toUpperCase(), value]));
    expect(relationshipEvidenceFromRow(upper, spec, sql, checkedAt)).toEqual(direct);
    // Two customers per key is not many_to_one; the evidence says so instead of hiding it.
    expect(relationshipEvidenceFromRow({ ...passingRow, max_to_per_key: 2 }, spec, sql, checkedAt).status).toBe('failed');
    expect(relationshipEvidenceFromRow(passingRow, { ...spec, fanout: 'attribution_required' }, sql, checkedAt).status).toBe('failed');
  });
  it('the proof fingerprint changes when a key data type changes, and is unchanged by types nobody knows', () => {
    const sql = relationshipValidationSql(spec, quote);
    const untyped = relationshipEvidenceFromRow(passingRow, spec, sql).proofFingerprint;
    const unknownTypes = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{}] }, sql).proofFingerprint;
    const integer = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'integer', to: 'integer' }] }, sql).proofFingerprint;
    const varchar = relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'integer', to: 'varchar' }] }, sql).proofFingerprint;
    expect(unknownTypes).toBe(untyped);
    expect(integer).not.toBe(untyped);
    expect(varchar).not.toBe(integer);
    expect(relationshipEvidenceFromRow(passingRow, { ...spec, keyTypes: [{ from: 'INTEGER', to: 'Integer' }] }, sql).proofFingerprint).toBe(integer);
  });
});

describe('what the verdict says about rows the join loses', () => {
  const checkedAt = new Date('2026-09-23T00:00:00.000Z');
  it('fails a many-to-one join that loses more keyed rows than allowed, and says how many', () => {
    const sql = relationshipValidationSql(spec, quote);
    // 12 of 100 order rows point at a customer that does not exist.
    const row = { ...passingRow, from_rows: 100, joined_rows: 88, unmatched_from: 12, unmatched_keyed_from: 12, unmatched_key_values: 1 };
    const evidence = relationshipEvidenceFromRow(row, spec, sql, checkedAt);
    expect(evidence).toMatchObject({ status: 'failed', unmatchedKeyedFrom: 12, unmatchedShare: 0.12, maxUnmatchedShare: 0.05, unmatchedKeyValues: 1 });
    expect(evidence.message).toMatch(/12 of 100 fct_orders rows with a key \(12%\) find no dim_customers row/);
    expect(evidence.message).toMatch(/same key value.*placeholder/);
    expect(evidence.message).toMatch(/more than the 5% allowed/);
    // A person who expects the gap says so on the relationship; the proof records it.
    const allowed = relationshipEvidenceFromRow(row, { ...spec, maxUnmatchedShare: 0.15 }, sql, checkedAt);
    expect(allowed).toMatchObject({ status: 'passed', maxUnmatchedShare: 0.15 });
    expect(allowed.proofFingerprint).not.toBe(evidence.proofFingerprint);
  });

  it('passes a small gap but reports it, and never counts null keys as lost', () => {
    const sql = relationshipValidationSql(spec, quote);
    const small = relationshipEvidenceFromRow({ ...passingRow, from_rows: 100, joined_rows: 98, unmatched_from: 2, unmatched_keyed_from: 2, unmatched_key_values: 2 }, spec, sql, checkedAt);
    expect(small.status).toBe('passed');
    expect(small.message).toMatch(/2 of 100 fct_orders rows with a key \(2%\) find no dim_customers row \(within the 5% allowed\)/);
    // A deleted customer's two orders share one missing key: too few rows to read as a placeholder.
    const deleted = relationshipEvidenceFromRow({ ...passingRow, from_rows: 1000, joined_rows: 998, unmatched_from: 2, unmatched_keyed_from: 2, unmatched_key_values: 1 }, spec, sql, checkedAt);
    expect(deleted.message).not.toMatch(/placeholder/);
    expect(looksLikePlaceholder({ unmatchedKeyedFrom: 417, unmatchedKeyValues: 1, keyedFrom: 34_000 })).toBe(true);
    // 40 orders have no customer at all: they reference nothing and lose nothing.
    const nulls = relationshipEvidenceFromRow({ ...passingRow, from_rows: 100, joined_rows: 60, from_null_keys: 40, unmatched_from: 40, unmatched_keyed_from: 0 }, spec, sql, checkedAt);
    expect(nulls).toMatchObject({ status: 'passed', unmatchedShare: 0 });
    // A parent without children is normal: one-to-many is not judged on coverage.
    const parent = relationshipEvidenceFromRow({ ...passingRow, max_from_per_key: 1, max_to_per_key: 4, unmatched_from: 50, unmatched_keyed_from: 50, from_rows: 100 }, { ...spec, cardinality: 'one_to_many' }, sql, checkedAt);
    expect(parent.status).toBe('passed');
  });

  it('a row from the older statement is judged on the same terms', () => {
    const sql = relationshipValidationSql(spec, quote);
    const legacy = relationshipEvidenceFromRow({ ...passingRow, from_rows: 100, joined_rows: 80, from_null_keys: 5, unmatched_from: 25 }, spec, sql, checkedAt);
    // 25 unmatched less 5 without a key: 20 of 95.
    expect(legacy).toMatchObject({ status: 'failed', unmatchedKeyedFrom: 20, maxToPerReferencedKey: 1 });
  });
});

describe('cardinality over the keys a join reaches', () => {
  // A sprint result joins its race result on race + driver. In the early
  // years a driver could hold several results in one race, so the key is not
  // unique over the whole results table; it is for every key a sprint reaches.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE results (result_id INTEGER, race_id INTEGER, driver_id INTEGER);
    CREATE TABLE sprint_results (result_id INTEGER, race_id INTEGER, driver_id INTEGER);
    INSERT INTO results VALUES (1, 10, 1), (2, 10, 1), (3, 10, 2), (4, 900, 1), (5, 900, 2), (6, 901, 1);
    INSERT INTO sprint_results VALUES (1, 900, 1), (2, 900, 2), (3, 901, 1);
  `);
  const execute = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
  const sprint = { fromRelation: 'sprint_results', toRelation: 'results', keys: [{ from: 'race_id', to: 'race_id' }, { from: 'driver_id', to: 'driver_id' }], cardinality: 'many_to_one' as const, fanout: 'safe' as const };

  it('fails on the whole table and says the join holds over the keys it reaches', async () => {
    const evidence = await validateRelationshipOnWarehouse(sprint, execute, quote);
    expect(evidence).toMatchObject({ status: 'failed', maxToPerKey: 2, maxToPerReferencedKey: 1, unmatchedKeyedFrom: 0 });
    expect(evidence.scope).toBeUndefined();
    expect(evidence.message).toMatch(/results holds up to 2 rows for one key/);
    expect(evidence.message).toMatch(/declare validation_scope: referenced_keys/);
  });

  it('passes when the relationship declares that scope, and the proof records it', async () => {
    const whole = await validateRelationshipOnWarehouse(sprint, execute, quote);
    const scoped = await validateRelationshipOnWarehouse({ ...sprint, scope: 'referenced_keys' }, execute, quote);
    expect(scoped).toMatchObject({ status: 'passed', scope: 'referenced_keys', maxToPerKey: 2, maxToPerReferencedKey: 1 });
    expect(scoped.message).toMatch(/holds over the keys this join reaches/);
    expect(scoped.proofFingerprint).not.toBe(whole.proofFingerprint);
    // The scope proves only the keys reached: a key reached twice still fails.
    db.exec('INSERT INTO sprint_results VALUES (4, 10, 1)');
    const reached = await validateRelationshipOnWarehouse({ ...sprint, scope: 'referenced_keys' }, execute, quote);
    expect(reached).toMatchObject({ status: 'failed', maxToPerReferencedKey: 2 });
    db.exec('DELETE FROM sprint_results WHERE result_id = 4');
  });

  it('measures lost rows and their distinct keys on a real warehouse', async () => {
    db.exec(`
      CREATE TABLE standings (standing_id INTEGER, race_id INTEGER);
      CREATE TABLE standings_ext (standing_id INTEGER, race_id INTEGER);
      INSERT INTO standings VALUES (1, 900), (2, 900), (3, 901);
      INSERT INTO standings_ext VALUES (1, 900), (2, 900), (3, 901), (0, 902), (0, 902), (NULL, 903);
    `);
    const evidence = await validateRelationshipOnWarehouse({ fromRelation: 'standings_ext', toRelation: 'standings', keys: [{ from: 'standing_id', to: 'standing_id' }], cardinality: 'many_to_one', fanout: 'safe' }, execute, quote);
    // Five rows have a key; two hold 0, which is nowhere in standings.
    expect(evidence).toMatchObject({ status: 'failed', fromRows: 6, fromNullKeys: 1, unmatchedFrom: 3, unmatchedKeyedFrom: 2, unmatchedKeyValues: 1, unmatchedShare: 0.4 });
    expect(evidence.message).toMatch(/placeholder/);
  });
});

describe('catalogKeyTypes', () => {
  const manifest = {
    dbtProvenance: {
      manifestPath: '/project/target/manifest.json',
      nodes: {
        'model.commerce.fct_orders': { uniqueId: 'model.commerce.fct_orders', relation: 'analytics.marts.fct_orders' },
        'model.commerce.dim_customers': { uniqueId: 'model.commerce.dim_customers', relation: 'ANALYTICS.MARTS.DIM_CUSTOMERS' },
      },
    },
  } as unknown as DQLManifest;
  const catalog = {
    nodes: {
      'model.commerce.fct_orders': { columns: { customer_id: { type: 'INTEGER' }, order_id: { type: 'VARCHAR' } } },
      'model.commerce.dim_customers': { columns: { CUSTOMER_ID: { type: 'NUMBER(38,0)' } } },
    },
  };
  it('reads the join keys\' types from the catalog beside the manifest, matching relations and columns case-insensitively', () => {
    const paths: string[] = [];
    const types = catalogKeyTypes(manifest, spec, (path) => { paths.push(path); return catalog; });
    expect(paths).toEqual(['/project/target/catalog.json']);
    expect(types).toEqual([{ from: 'integer', to: 'number(38,0)' }]);
  });
  it('leaves every type unknown when the catalog, the manifest or the relation is missing', () => {
    expect(catalogKeyTypes(manifest, spec, () => undefined)).toEqual([{}]);
    expect(catalogKeyTypes(undefined, spec, () => catalog)).toEqual([{}]);
    expect(catalogKeyTypes(manifest, { ...spec, toRelation: 'analytics.marts.dim_products' }, () => catalog)).toEqual([{ from: 'integer', to: undefined }]);
  });
  it('reads a warehouse relation\'s key types from the warehouse catalog snapshot (RFC 0007)', () => {
    const warehouseManifest = {
      dbtProvenance: {
        manifestPath: '',
        warehouseCatalogPath: '.dql/warehouse-catalog.json',
        nodes: {
          'warehouse.analytics.marts.fct_orders': { uniqueId: 'warehouse.analytics.marts.fct_orders', resourceType: 'warehouse', relation: 'analytics.marts.fct_orders' },
          'warehouse.analytics.marts.dim_customers': { uniqueId: 'warehouse.analytics.marts.dim_customers', resourceType: 'warehouse', relation: 'ANALYTICS.MARTS.DIM_CUSTOMERS' },
        },
      },
    } as unknown as DQLManifest;
    const snapshot = {
      relations: [
        { id: 'warehouse.analytics.marts.fct_orders', columns: [{ name: 'CUSTOMER_ID', type: 'BIGINT' }] },
        { id: 'warehouse.analytics.marts.dim_customers', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
      ],
    };
    const paths: string[] = [];
    expect(catalogKeyTypes(warehouseManifest, spec, (path) => { paths.push(path); return snapshot; }, '/project')).toEqual([{ from: 'bigint', to: 'bigint' }]);
    expect(paths).toEqual(['/project/.dql/warehouse-catalog.json']);
    // Without the project root the snapshot cannot be found; nothing is guessed.
    expect(catalogKeyTypes(warehouseManifest, spec, () => snapshot)).toEqual([{}]);
  });
});
