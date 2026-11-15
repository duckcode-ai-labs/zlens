import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { WarehouseCatalogRelationV1 } from '@zlens/core';
import { findRowIdentity } from './model-layers.js';
import { PACKET_JOINS, PACKET_KEYS, REVIEWER_PACKET_TABLES, TPCH_TABLES, descriptionOf, draftOnWarehouse, grainsOf, identitiesOf, joinsOf, tpchSnapshot, tpchStatements } from './testkit/tpch-shaped.js';
import { columnPrefix, columnStem, ownKeyColumn } from './warehouse-model-discovery.js';

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
type Run = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

function tpch() {
  const db = new Database(':memory:');
  for (const statement of tpchStatements()) db.exec(statement);
  const run: Run = async (sql) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
  return { run };
}

describe('model drafts on TPC-H copies with no declared keys (V2 review, F1)', () => {
  // As Snowflake's catalog reports the copied tables (NUMBER, TEXT, DATE), and as DuckDB's does.
  it.each(['snowflake', 'duckdb'] as const)('drafts one row per *KEY, and the three joins the reviewer packet needs (%s types)', async (flavor) => {
    const { run } = tpch();
    const report = await draftOnWarehouse(tpchSnapshot(REVIEWER_PACKET_TABLES, flavor, 'sqlite'), run, 'sqlite');

    // The *KEY column, never the unique comment, address or (date, comment).
    expect(identitiesOf(report)).toEqual(PACKET_KEYS);
    expect(grainsOf(report)).toEqual(PACKET_KEYS);
    expect(joinsOf(report)).toEqual(PACKET_JOINS);
    expect(report.relationships.find((item) => item.keys[0]!.from === 'O_CUSTKEY')!.evidence[0]).toEqual({
      source: 'shared_key',
      reason: 'C_CUSTKEY is unique in CUSTOMER, and 1500 of 1500 ORDERS values are found there',
    });

    const description = (name: string) => descriptionOf(report, name);
    expect(description('CUSTOMER')).toBe('One row per C_CUSTKEY: 150 rows.');
    expect(description('NATION')).toBe('One row per N_NATIONKEY: 25 rows.');
    expect(description('REGION')).toBe('One row per R_REGIONKEY: 5 rows.');
    expect(description('ORDERS')).toMatch(/^One row per O_ORDERKEY: 1,500 rows; O_ORDERDATE 1992-01-01–/);
    // No rule drafted from a wrong key: orders do not repeat.
    for (const rule of report.rules ?? []) {
      expect(rule.id).not.toMatch(/repeat/);
      expect(rule.expression).not.toMatch(/COMMENT|ADDRESS/);
    }
  });

  it('drafts every TPC-H table: a line item is (L_ORDERKEY, L_LINENUMBER), and it joins PARTSUPP on two columns', async () => {
    const { run } = tpch();
    const report = await draftOnWarehouse(tpchSnapshot(TPCH_TABLES, 'duckdb', 'sqlite'), run, 'sqlite');
    expect(identitiesOf(report)).toEqual({
      ...PACKET_KEYS,
      PART: 'P_PARTKEY', SUPPLIER: 'S_SUPPKEY', PARTSUPP: 'PS_PARTKEY, PS_SUPPKEY', LINEITEM: 'L_LINENUMBER, L_ORDERKEY',
    });
    expect(joinsOf(report)).toEqual([
      ...PACKET_JOINS,
      'LINEITEM → ORDERS on L_ORDERKEY=O_ORDERKEY · many_to_one · passed',
      'LINEITEM → PART on L_PARTKEY=P_PARTKEY · many_to_one · passed',
      'LINEITEM → PARTSUPP on L_PARTKEY=PS_PARTKEY, L_SUPPKEY=PS_SUPPKEY · many_to_one · passed',
      'LINEITEM → SUPPLIER on L_SUPPKEY=S_SUPPKEY · many_to_one · passed',
      'PARTSUPP → PART on PS_PARTKEY=P_PARTKEY · many_to_one · passed',
      'PARTSUPP → SUPPLIER on PS_SUPPKEY=S_SUPPKEY · many_to_one · passed',
      'SUPPLIER → NATION on S_NATIONKEY=N_NATIONKEY · many_to_one · passed',
    ].sort());
  });

  it('never makes free text a row identity, and keeps a short label where no key is named', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE notes (n_comment VARCHAR, n_address VARCHAR, n_segment VARCHAR);
      CREATE TABLE teams (team_name VARCHAR, city VARCHAR, note VARCHAR);
    `);
    for (let row = 1; row <= 40; row += 1) {
      db.prepare('INSERT INTO notes VALUES (?, ?, ?)').run(`comment ${row}`, `${row} main street`, `segment ${row % 4}`);
      db.prepare('INSERT INTO teams VALUES (?, ?, ?)').run(`Team ${row}`, `City ${row % 5}`, `note ${row}`);
    }
    const run: Run = async (sql) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    const relation = (name: string, columns: string[]): WarehouseCatalogRelationV1 => ({ id: `warehouse.${name}`, schema: 'main', name, relation: `main.${name}`, kind: 'table', columns: columns.map((column) => ({ name: column, type: 'VARCHAR' })) });
    expect(await findRowIdentity(relation('notes', ['n_comment', 'n_address', 'n_segment']), run, quote)).toBeUndefined();
    expect(await findRowIdentity(relation('teams', ['team_name', 'city', 'note']), run, quote)).toMatchObject({ columns: ['team_name'], duplicates: 0 });
  });

  it('reads a column prefix only where the table names its columns that way', () => {
    const relation = (name: string, columns: string[]) => ({ name, columns: columns.map((column) => ({ name: column })) });
    const customer = relation('CUSTOMER', ['C_CUSTKEY', 'C_NAME', 'C_NATIONKEY', 'C_COMMENT']);
    expect(columnPrefix(customer)).toBe('c');
    expect(columnStem(customer, 'C_NATIONKEY')).toBe('nationkey');
    expect(ownKeyColumn(customer, 'C_CUSTKEY')).toBe(true);
    expect(ownKeyColumn(customer, 'C_NATIONKEY')).toBe(false);
    expect(columnPrefix(relation('PARTSUPP', ['PS_PARTKEY', 'PS_SUPPKEY', 'PS_AVAILQTY']))).toBe('ps');
    expect(columnPrefix(relation('store_sales', ['ss_item_sk', 'ss_customer_sk', 'ss_quantity']))).toBe('ss');
    // A bare id after the prefix stays the table's own.
    expect(columnStem(relation('orders', ['o_id', 'o_date', 'o_total']), 'o_id')).toBe('o_id');
    // No prefix: jaffle-shop names, a flag prefix that does not spell the table, too few columns.
    expect(columnPrefix(relation('orders', ['order_id', 'customer_id', 'order_date']))).toBeUndefined();
    expect(columnPrefix(relation('payments', ['is_paid', 'is_refunded', 'is_late']))).toBeUndefined();
    expect(columnPrefix(relation('customers', ['c_id']))).toBeUndefined();
    expect(ownKeyColumn(relation('customers', ['customer_id', 'name']), 'customer_id')).toBe(true);
    expect(ownKeyColumn(relation('orders', ['order_id', 'customer_id']), 'customer_id')).toBe(false);
  });
});
