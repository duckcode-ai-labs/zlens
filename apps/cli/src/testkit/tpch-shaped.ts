/**
 * Small TPC-H-shaped tables for model-draft tests: the eight TPC-H tables,
 * their column names and the shape of their keys, generated in a few
 * thousand rows (no download). Copied as a reviewer copies the sample with
 * CREATE TABLE AS: no declared primary or foreign keys. Free text is unique
 * per row the way TPC-H's is (every C_ADDRESS, C_COMMENT, N_COMMENT,
 * R_COMMENT), with a few O_COMMENT repeats, so a drafter that does not know
 * `C_CUSTKEY` is a key picks the comment instead (V2 review, F1).
 */

import { normalizeWarehouseCatalog, warehouseRelationId, type WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { draftIdentityJoins } from '../model-joins.js';
import { draftTablePicks } from '../model-layers.js';
import { draftWordsAndRules } from '../model-profile.js';
import { discoverWarehouseModel, validateWarehouseDiscovery, type WarehouseDiscoveryReport } from '../warehouse-model-discovery.js';

type Kind = 'key' | 'int' | 'money' | 'text' | 'date';

/** Column types as each warehouse's catalog reports them: Snowflake's information schema says NUMBER, TEXT, DATE. */
const TYPES: Record<'snowflake' | 'duckdb', Record<Kind, string>> = {
  snowflake: { key: 'NUMBER', int: 'NUMBER', money: 'NUMBER', text: 'TEXT', date: 'DATE' },
  duckdb: { key: 'INTEGER', int: 'INTEGER', money: 'DECIMAL(15,2)', text: 'VARCHAR', date: 'DATE' },
};

const TABLES: Record<string, Array<[string, Kind]>> = {
  REGION: [['R_REGIONKEY', 'key'], ['R_NAME', 'text'], ['R_COMMENT', 'text']],
  NATION: [['N_NATIONKEY', 'key'], ['N_NAME', 'text'], ['N_REGIONKEY', 'key'], ['N_COMMENT', 'text']],
  CUSTOMER: [['C_CUSTKEY', 'key'], ['C_NAME', 'text'], ['C_ADDRESS', 'text'], ['C_NATIONKEY', 'key'], ['C_PHONE', 'text'], ['C_ACCTBAL', 'money'], ['C_MKTSEGMENT', 'text'], ['C_COMMENT', 'text']],
  ORDERS: [['O_ORDERKEY', 'key'], ['O_CUSTKEY', 'key'], ['O_ORDERSTATUS', 'text'], ['O_TOTALPRICE', 'money'], ['O_ORDERDATE', 'date'], ['O_ORDERPRIORITY', 'text'], ['O_CLERK', 'text'], ['O_SHIPPRIORITY', 'int'], ['O_COMMENT', 'text']],
  PART: [['P_PARTKEY', 'key'], ['P_NAME', 'text'], ['P_BRAND', 'text'], ['P_SIZE', 'int'], ['P_RETAILPRICE', 'money'], ['P_COMMENT', 'text']],
  SUPPLIER: [['S_SUPPKEY', 'key'], ['S_NAME', 'text'], ['S_ADDRESS', 'text'], ['S_NATIONKEY', 'key'], ['S_PHONE', 'text'], ['S_ACCTBAL', 'money'], ['S_COMMENT', 'text']],
  PARTSUPP: [['PS_PARTKEY', 'key'], ['PS_SUPPKEY', 'key'], ['PS_AVAILQTY', 'int'], ['PS_SUPPLYCOST', 'money'], ['PS_COMMENT', 'text']],
  LINEITEM: [['L_ORDERKEY', 'key'], ['L_PARTKEY', 'key'], ['L_SUPPKEY', 'key'], ['L_LINENUMBER', 'int'], ['L_QUANTITY', 'money'], ['L_EXTENDEDPRICE', 'money'], ['L_RETURNFLAG', 'text'], ['L_SHIPDATE', 'date'], ['L_COMMENT', 'text']],
};

/** The four tables the reviewer packet copies. */
export const REVIEWER_PACKET_TABLES = ['REGION', 'NATION', 'CUSTOMER', 'ORDERS'];
export const TPCH_TABLES = Object.keys(TABLES);
export const TPCH_SIZES = { regions: 5, nations: 25, customers: 150, orders: 1500, parts: 200, suppliers: 10 };

const WORDS = ['carefully', 'final', 'deposits', 'detect', 'slyly', 'agai', 'furiously', 'regular', 'accounts', 'haggle', 'blithely', 'ironic', 'packages', 'nag', 'quickly', 'express', 'pinto', 'beans', 'sleep', 'even'];
/** Unique free text for row `n` of a table: three words and a number, as dbgen's comments read. */
const text = (salt: number, n: number) => `${WORDS[(n * 7 + salt) % WORDS.length]} ${WORDS[(n * 3 + salt * 5) % WORDS.length]} ${WORDS[(n + salt * 11) % WORDS.length]} ${n * 31 + salt}`;
const sql = (value: string | number) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`);
const day = (offset: number) => new Date(Date.UTC(1992, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
const pad = (value: number, width: number) => String(value).padStart(width, '0');
/** TPC-H's sparse order keys: eight used of every 32. */
const orderKey = (index: number) => Math.floor((index - 1) / 8) * 32 + ((index - 1) % 8) + 1;
/** The four suppliers of a part. */
const supplierOf = (part: number, slot: number) => ((part + slot * 3) % TPCH_SIZES.suppliers) + 1;

/** CREATE TABLE and INSERT statements for every table, in DuckDB's types (SQLite reads them too). */
export function tpchStatements(): string[] {
  const rows: Record<string, Array<Array<string | number>>> = Object.fromEntries(TPCH_TABLES.map((name) => [name, []]));
  const regions = ['AFRICA', 'AMERICA', 'ASIA', 'EUROPE', 'MIDDLE EAST'];
  regions.forEach((name, key) => rows.REGION!.push([key, name, text(1, key)]));
  for (let key = 0; key < TPCH_SIZES.nations; key += 1) rows.NATION!.push([key, `NATION ${pad(key, 2)}`, key % TPCH_SIZES.regions, text(2, key)]);
  const segments = ['AUTOMOBILE', 'BUILDING', 'FURNITURE', 'HOUSEHOLD', 'MACHINERY'];
  for (let key = 1; key <= TPCH_SIZES.customers; key += 1) {
    const nation = (key * 7) % TPCH_SIZES.nations;
    rows.CUSTOMER!.push([key, `Customer#${pad(key, 9)}`, `${text(3, key)} street`, nation, `${10 + nation}-${pad(key * 37 % 1000, 3)}-${pad(key, 4)}`, ((key * 977) % 1_000_000) / 100, segments[key % 5]!, text(4, key)]);
  }
  // As in TPC-H, a third of the customers (every third key) places no orders.
  const buyers = Array.from({ length: TPCH_SIZES.customers }, (_, index) => index + 1).filter((key) => key % 3 !== 0);
  const statuses = ['F', 'O', 'P'];
  const priorities = ['1-URGENT', '2-HIGH', '3-MEDIUM', '4-NOT SPECIFIED', '5-LOW'];
  const orders: Array<{ key: number; date: string; comment: string }> = [];
  for (let index = 1; index <= TPCH_SIZES.orders; index += 1) {
    let date = day(((index * 37) % 400) * 6);
    let comment = text(5, index);
    // 20 comments repeat the order before; 5 of those share its date too.
    if (index % 75 === 0) comment = orders[index - 2]!.comment;
    if (index % 300 === 0) date = orders[index - 2]!.date;
    orders.push({ key: orderKey(index), date, comment });
    rows.ORDERS!.push([orderKey(index), buyers[(index * 13) % buyers.length]!, statuses[index % 3]!, ((index * 7919) % 50_000_000) / 100, date, priorities[index % 5]!, `Clerk#${pad((index * 11) % 50, 9)}`, 0, comment]);
  }
  for (let key = 1; key <= TPCH_SIZES.parts; key += 1) rows.PART!.push([key, `part ${text(6, key)}`, `Brand#${(key % 5) + 1}${(key % 4) + 1}`, (key % 50) + 1, 900 + key / 10, text(7, key)]);
  for (let key = 1; key <= TPCH_SIZES.suppliers; key += 1) rows.SUPPLIER!.push([key, `Supplier#${pad(key, 9)}`, `${text(8, key)} road`, (key * 3) % 7, `${10 + key}-${pad(key, 3)}-0000`, key * 100.5, text(9, key)]);
  for (let part = 1; part <= TPCH_SIZES.parts; part += 1) {
    for (let slot = 0; slot < 4; slot += 1) rows.PARTSUPP!.push([part, supplierOf(part, slot), (part * slot) % 9999 + 1, ((part + slot) % 1000) + 1.5, text(10, part * 4 + slot)]);
  }
  orders.forEach((order, index) => {
    const lines = ((index + 1) % 7) + 1;
    for (let line = 1; line <= lines; line += 1) {
      const part = (((index + 1) * 13 + line * 7) % TPCH_SIZES.parts) + 1;
      rows.LINEITEM!.push([order.key, part, supplierOf(part, (index + line) % 4), line, (line % 50) + 1, line * 101.25, line % 3 === 0 ? 'R' : 'N', day(((index * 37) % 400) * 6 + line), text(11, index * 8 + line)]);
    }
  });
  const statements: string[] = [];
  for (const [name, columns] of Object.entries(TABLES)) {
    statements.push(`CREATE TABLE ${name} (${columns.map(([column, kind]) => `${column} ${TYPES.duckdb[kind]}`).join(', ')})`);
    const all = rows[name]!;
    for (let start = 0; start < all.length; start += 500) {
      statements.push(`INSERT INTO ${name} VALUES ${all.slice(start, start + 500).map((row) => `(${row.map(sql).join(', ')})`).join(', ')}`);
    }
  }
  return statements;
}

/** The catalog snapshot sync would read for `tables` (no declared keys), with each warehouse's type names. */
export function tpchSnapshot(tables: string[], flavor: 'snowflake' | 'duckdb', driver: string): WarehouseCatalogSnapshotV1 {
  return normalizeWarehouseCatalog({
    version: 1,
    driver,
    connectionId: 'default',
    scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
    capturedAt: '2026-11-15T00:00:00.000Z',
    relations: tables.map((name) => ({
      id: warehouseRelationId({ schema: 'main', name }),
      schema: 'main',
      name,
      relation: `main.${name}`,
      kind: 'table' as const,
      columns: TABLES[name]!.map(([column, kind]) => ({ name: column, type: TYPES[flavor][kind] })),
    })),
  });
}

type Run = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** The first-open draft, step for step as `checkDraftOnWarehouse` runs it. */
export async function draftOnWarehouse(snapshot: WarehouseCatalogSnapshotV1, run: Run, dialect: string): Promise<WarehouseDiscoveryReport> {
  const validated = await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot, projectName: 'Review' }), snapshot, run, quote, { dialect });
  const picked = await draftTablePicks(validated, snapshot, run, quote);
  const joined = await draftIdentityJoins(picked, snapshot, run, quote, { dialect });
  return draftWordsAndRules(joined, snapshot, run, quote, { checkedAt: new Date('2026-11-15T00:00:00.000Z') });
}

const tableOf = (relation: string) => relation.split('.').pop()!;
/** Each drafted join as `FROM → TO on keys · cardinality · validation`, sorted. */
export const joinsOf = (report: WarehouseDiscoveryReport) => report.relationships
  .map((item) => `${tableOf(item.fromRelation)} → ${tableOf(item.toRelation)} on ${item.keys.map((pair) => `${pair.from}=${pair.to}`).join(', ')} · ${item.cardinality} · ${item.validation?.status ?? item.validationError}`)
  .sort();
export const identitiesOf = (report: WarehouseDiscoveryReport) => Object.fromEntries(report.entities.map((entity) => [tableOf(entity.relation), entity.identity && `${entity.identity.columns.join(', ')}${entity.identity.duplicates ? ` (${entity.identity.duplicates} repeat)` : ''}`]));
export const grainsOf = (report: WarehouseDiscoveryReport) => Object.fromEntries(report.entities.map((entity) => [tableOf(entity.relation), entity.grain]));
export const descriptionOf = (report: WarehouseDiscoveryReport, name: string) => report.entities.find((entity) => tableOf(entity.relation) === name)?.description;

/** The reviewer packet's tables, as a correct draft has them. */
export const PACKET_KEYS = { REGION: 'R_REGIONKEY', NATION: 'N_NATIONKEY', CUSTOMER: 'C_CUSTKEY', ORDERS: 'O_ORDERKEY' };
export const PACKET_JOINS = [
  'CUSTOMER → NATION on C_NATIONKEY=N_NATIONKEY · many_to_one · passed',
  'NATION → REGION on N_REGIONKEY=R_REGIONKEY · many_to_one · passed',
  'ORDERS → CUSTOMER on O_CUSTKEY=C_CUSTKEY · many_to_one · passed',
];
