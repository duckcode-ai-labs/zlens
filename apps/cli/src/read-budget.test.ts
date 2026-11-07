import { describe, expect, it } from 'vitest';
import type { WarehouseCatalogRelationV1 } from '@zlens/core';
import { ReadBudgetError, boundedReads, estimateRead, readBudgetFromEnv } from './read-budget.js';
import { lakeReaderCall } from './lake-sizes.js';
import { markSampledFacts, warehouseDiscoveryChanges, type WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

const MB = 1e6;
/** Ethereum transactions as sync records them: 100 files of 15 GB, `hash` the large column. */
const transactions: WarehouseCatalogRelationV1 = {
  id: 'warehouse.memory.main.eth_transactions',
  name: 'eth_transactions',
  relation: 'memory.main.eth_transactions',
  kind: 'view',
  viewSql: "CREATE TEMP VIEW eth_transactions AS SELECT * FROM read_parquet('s3://chain/tx/**/*.parquet', (hive_partitioning = CAST('t' AS BOOLEAN)));",
  columns: [
    { name: 'hash', type: 'VARCHAR', bytesEstimate: 240_000 * MB },
    { name: 'block_number', type: 'BIGINT', bytesEstimate: 100 * MB },
    { name: 'value', type: 'DOUBLE', bytesEstimate: 14_000 * MB },
    { name: 'date', type: 'VARCHAR' },
  ],
  rowCountEstimate: 3_700_000_000,
  bytesEstimate: 1_500_000 * MB,
  sizeFrom: 'footers of 16 of 100 files (estimated)',
};
const blocks: WarehouseCatalogRelationV1 = {
  id: 'warehouse.memory.main.eth_blocks',
  name: 'eth_blocks',
  relation: 'memory.main.eth_blocks',
  kind: 'view',
  viewSql: "CREATE TEMP VIEW eth_blocks AS SELECT * FROM read_parquet('s3://chain/blocks/**/*.parquet')",
  columns: [{ name: 'number', type: 'BIGINT', bytesEstimate: 100 * MB }, { name: 'hash', type: 'VARCHAR', bytesEstimate: 1_800 * MB }],
  rowCountEstimate: 27_000_000,
  bytesEstimate: 20_000 * MB,
  sizeFrom: 'footers of 16 of 4,118 files (estimated)',
};
const local: WarehouseCatalogRelationV1 = {
  id: 'warehouse.memory.main.events', name: 'events', relation: 'memory.main.events', kind: 'view',
  viewSql: "CREATE VIEW events AS SELECT * FROM read_csv_auto('/data/events/*.csv')",
  columns: [{ name: 'id', type: 'BIGINT' }, { name: 'kind', type: 'VARCHAR' }],
  bytesEstimate: 3_000 * MB, sizeFrom: 'listing of 2 files',
};
const warehouseTable: WarehouseCatalogRelationV1 = { id: 'warehouse.db.main.orders', name: 'orders', relation: 'db.main.orders', kind: 'table', columns: [{ name: 'id' }], rowCountEstimate: 9_000_000_000 };
const icebergTable: WarehouseCatalogRelationV1 = {
  id: 'warehouse.ice.sales.orders', name: 'big_orders', relation: 'ice.sales.big_orders', kind: 'table', database: 'ice',
  columns: [{ name: 'order_id', type: 'BIGINT' }], rowCountEstimate: 2_000_000_000, sizeFrom: 'Iceberg manifests',
};

/** 100 files of 15 GB each, listed in order. */
const txFiles = Array.from({ length: 100 }, (_, index) => ({ file: `s3://chain/tx/date=${String(index).padStart(3, '0')}/part.parquet`, size: 15_000 * MB }));
const blockFiles = Array.from({ length: 10 }, (_, index) => ({ file: `s3://chain/blocks/${index}.parquet`, size: 2_000 * MB }));
const csvFiles = [{ file: '/data/events/a.csv', size: 1_000 * MB }, { file: '/data/events/b.csv', size: 2_000 * MB }];

function engine() {
  const ran: string[] = [];
  const run = async (sql: string) => {
    ran.push(sql);
    if (sql.includes("read_blob('s3://chain/tx/")) return { rows: txFiles };
    if (sql.includes("read_blob('s3://chain/blocks/")) return { rows: blockFiles };
    if (sql.includes("read_blob('/data/events/")) return { rows: csvFiles };
    return { rows: [{ n: 1 }] };
  };
  return { run, ran };
}
const snapshot = { relations: [transactions, blocks, local, warehouseTable, icebergTable] };
const budget = { remote: 256 * MB, local: 4_000 * MB };

describe('what a statement reads', () => {
  it('the named columns of a Parquet table; COUNT(*) alone reads nothing; a CSV file is read whole', () => {
    const call = lakeReaderCall(transactions.viewSql)!;
    expect(estimateRead(transactions, [transactions.columns[0]!], call)).toBe(240_000 * MB);
    expect(estimateRead(transactions, [], call)).toBe(0);
    expect(estimateRead(local, [local.columns[0]!], lakeReaderCall(local.viewSql))).toBe(3_000 * MB);
    // Rows only (a catalog table): each column by its type's width.
    expect(estimateRead(icebergTable, icebergTable.columns, undefined)).toBe(2_000_000_000 * 8);
  });

  it('ZLENS_READ_BUDGET_MB sets both budgets', () => {
    expect(readBudgetFromEnv({ ZLENS_READ_BUDGET_MB: '5' })).toEqual({ remote: 5 * MB, local: 5 * MB });
    expect(readBudgetFromEnv({})).toEqual({ remote: 256 * MB, local: 4_000 * MB });
  });
});

describe('the read budget', () => {
  it('runs a statement within the budget, or on tables with no size, exactly as written', async () => {
    const { run, ran } = engine();
    const bounded = boundedReads({ run, snapshot, budget });
    const small = 'SELECT COUNT(*) AS n, COUNT(DISTINCT "block_number") AS d FROM "memory"."main"."eth_transactions"';
    await bounded.run(small);
    await bounded.run('SELECT COUNT(DISTINCT "id") FROM "db"."main"."orders"');
    await bounded.run('SELECT COUNT(*) AS n FROM "memory"."main"."eth_transactions"');
    expect(ran).toEqual([small, 'SELECT COUNT(DISTINCT "id") FROM "db"."main"."orders"', 'SELECT COUNT(*) AS n FROM "memory"."main"."eth_transactions"']);
    expect(bounded.notes()).toEqual([]);
  });

  it('a table none of whose files fits the budget is not read', async () => {
    const { run, ran } = engine();
    const bounded = boundedReads({ run, snapshot, budget });
    // hash is 16% of each 15 GB file: 2.4 GB of it in one file, more than 256 MB.
    await expect(bounded.run('SELECT COUNT(*) AS row_count, COUNT("hash") AS nn_0, COUNT(DISTINCT "hash") AS nd_0 FROM "memory"."main"."eth_transactions"')).rejects.toThrow(ReadBudgetError);
    expect(ran.filter((statement) => !statement.includes('read_blob'))).toEqual([]);
    expect(bounded.notes()).toEqual([{
      relation: 'memory.main.eth_transactions',
      kind: 'skipped',
      text: 'eth_transactions: 1 check skipped: a check reads at most 256 MB of a remote table, and even one of its files holds more, up to about 240 GB (hash).',
    }]);
  });

  it('a sample stands in for the table: spread files, the view\'s own reader options, the same files for each statement', async () => {
    const { run, ran } = engine();
    const bounded = boundedReads({ run, snapshot, budget: { remote: 12_000 * MB, local: budget.local } });
    const sql = 'SELECT COUNT(*) AS row_count, COUNT(DISTINCT "hash") AS nd FROM "memory"."main"."eth_transactions"';
    await bounded.run(sql);
    await bounded.run(sql);
    const [first, second] = ran.filter((statement) => statement.includes('read_parquet(['));
    expect(first).toBe(second);
    // 2.4 GB of hash a file: five files fit 12 GB, spread from the first file to the last.
    expect(first).toMatch(/^SELECT COUNT\(\*\) AS row_count, COUNT\(DISTINCT "hash"\) AS nd FROM \(SELECT \* FROM read_parquet\(\[/);
    expect(first!.match(/s3:\/\/chain\/tx\//g)).toHaveLength(5);
    expect(first).toContain("'s3://chain/tx/date=000/part.parquet'");
    expect(first).toContain("'s3://chain/tx/date=050/part.parquet'");
    expect(first).toContain(", (hive_partitioning = CAST('t' AS BOOLEAN))))");
    // The listing is read once.
    expect(ran.filter((statement) => statement.includes('read_blob'))).toHaveLength(1);
    expect(bounded.notes()).toEqual([{
      relation: 'memory.main.eth_transactions',
      kind: 'sampled',
      text: 'eth_transactions: checked on 5 of 100 files spread across it, about 185 million of 3.7 billion rows. What the draft says of it holds in that sample.',
    }]);
    expect(bounded.sampled()).toEqual(new Map([['memory.main.eth_transactions', 'a sample of eth_transactions: 5 of 100 files, about 185 million of 3.7 billion rows']]));
  });

  it('never samples the side a check looks values up in: the check is skipped and says why', async () => {
    const { run, ran } = engine();
    const bounded = boundedReads({ run, snapshot, budget });
    const containment = 'SELECT COUNT("transaction_hash") AS referencing, COUNT(CASE WHEN "transaction_hash" NOT IN (SELECT "hash" FROM "memory"."main"."eth_transactions") THEN 1 END) AS unmatched FROM "memory"."main"."eth_blocks"';
    await expect(bounded.run(containment, { sample: ['memory.main.eth_blocks'] })).rejects.toThrow(ReadBudgetError);
    await expect(bounded.run(containment, { sample: ['memory.main.eth_blocks'] })).rejects.toThrow(/^eth_transactions is looked up whole here, and that reads about 240 GB of eth_transactions \(hash\)/);
    expect(ran).toEqual([]);
    expect(bounded.notes()).toEqual([{
      relation: 'memory.main.eth_transactions',
      kind: 'skipped',
      text: 'eth_transactions: 2 checks that look values up in it skipped: a lookup reads the whole table, up to about 240 GB (hash), and a check reads at most 256 MB of a remote table.',
    }]);
  });

  it('samples the subject and reads the looked-up side whole when that fits', async () => {
    const { run, ran } = engine();
    const bounded = boundedReads({ run, snapshot, budget: { remote: 300 * MB, local: budget.local } });
    const validation = 'WITH from_counts AS (SELECT COUNT(*) AS rows FROM "memory"."main"."eth_transactions" f), to_keys AS (SELECT "number", COUNT(*) AS key_count FROM "memory"."main"."eth_blocks" GROUP BY "number") SELECT * FROM from_counts, to_keys WHERE "value" > 0 AND "block_number" > 0';
    await bounded.run(validation, { sample: ['memory.main.eth_transactions'] });
    const statement = ran.at(-1)!;
    expect(statement).toContain('FROM (SELECT * FROM read_parquet([');
    expect(statement).toContain('FROM "memory"."main"."eth_blocks" GROUP BY');
  });

  it('a table it cannot sample by file, over the budget, is not read', async () => {
    const { run } = engine();
    const bounded = boundedReads({ run, snapshot, budget });
    await expect(bounded.run('SELECT COUNT(DISTINCT "order_id") FROM "ice"."sales"."big_orders"')).rejects.toThrow(/^big_orders cannot be sampled by file/);
    expect(bounded.notes()[0]!.text).toBe('big_orders: 1 check skipped: its rows cannot be sampled by file yet, and reading it takes up to about 16 GB (order_id), more than the 256 MB of a remote table a check reads.');
  });

  it('a local table has the local budget: a CSV folder of 3 GB is read as written', async () => {
    const { run, ran } = engine();
    await boundedReads({ run, snapshot, budget }).run('SELECT COUNT(DISTINCT kind) FROM memory.main.events');
    expect(ran).toEqual(['SELECT COUNT(DISTINCT kind) FROM memory.main.events']);
    const tight = engine();
    const bounded = boundedReads({ run: tight.run, snapshot, budget: { remote: budget.remote, local: 1_500 * MB } });
    await bounded.run('SELECT COUNT(DISTINCT kind) FROM memory.main.events');
    // Whole CSV files: the 1 GB file fits, the 2 GB one does not.
    expect(tight.ran.at(-1)).toBe("SELECT COUNT(DISTINCT kind) FROM (SELECT * FROM read_csv_auto(['/data/events/a.csv']))");
  });
});

describe('what the draft measured on a sample says so', () => {
  const report: WarehouseDiscoveryReport = {
    catalogFingerprint: 'f', capturedAt: 'now', relations: 2, domains: [{ id: 'chain', name: 'Chain', existing: false }],
    entities: [
      { id: 'transaction', domain: 'chain', relationId: transactions.id, relation: transactions.relation, kind: 'view', businessName: 'Transaction', description: 'One row per hash: 1,000 rows.', keys: ['hash'], grain: 'hash' },
      { id: 'block', domain: 'chain', relationId: blocks.id, relation: blocks.relation, kind: 'view', businessName: 'Block', keys: [] },
    ],
    relationships: [{
      id: 'transaction_to_block', domain: 'chain', from: 'transaction', to: 'block', fromDomain: 'chain', toDomain: 'chain', fromRelation: transactions.relation, toRelation: blocks.relation,
      keys: [{ from: 'block_number', to: 'number' }], evidence: [{ source: 'named_for_table', reason: 'block_number names eth_blocks' }], cardinality: 'many_to_one', fanout: 'safe',
      validation: { status: 'passed', checkedAt: 'now', queryFingerprint: 'q', fromRows: 10, toRows: 5, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 3, maxToPerKey: 1 },
    }],
    rules: [{ id: 'transaction_repeats', domain: 'chain', kind: 'custom', expression: 'eth_transactions holds 1,000 rows.', entities: ['transaction'], evidence: { query: 'q', measured: { rows: 1000 }, checkedAt: 'now' } }],
    existingRelationships: 0,
    validated: true,
  };
  const sample = 'a sample of eth_transactions: 5 of 100 files, about 185 million of 3.7 billion rows';

  it('the entity, its rules and its joins name the sample', () => {
    const marked = markSampledFacts(report, new Map([[transactions.relation, sample]]));
    expect(marked.entities[0]).toMatchObject({ sampled: sample, description: `One row per hash: 1,000 rows. Measured on ${sample}.` });
    expect(marked.entities[1]!.sampled).toBeUndefined();
    expect(marked.rules![0]!.expression).toBe(`eth_transactions holds 1,000 rows. (measured on ${sample})`);
    expect(marked.rules![0]!.evidence.measured.sample).toBe(sample);
    expect(marked.relationships[0]!.sampled).toBe(sample);
    expect(markSampledFacts(report, new Map())).toBe(report);
  });

  it('a join checked on a sample is written without validation evidence: a person validates it on the whole tables to certify it', () => {
    const changes = warehouseDiscoveryChanges(markSampledFacts(report, new Map([[transactions.relation, sample]])));
    const join = changes.find((change) => change.operation === 'upsert_relationship')!.value as unknown as Record<string, unknown>;
    expect(join.validation).toBeUndefined();
    expect(join.rationale).toBe(`block_number names eth_blocks; checked on ${sample}; validate it on the whole tables to certify it`);
    const whole = warehouseDiscoveryChanges(report).find((change) => change.operation === 'upsert_relationship')!.value as unknown as Record<string, unknown>;
    expect(whole.validation).toMatchObject({ status: 'passed' });
  });
});

describe('which columns a statement reads', () => {
  it('a * straight from the table reads all of it; a * over a WITH result reads what that names', async () => {
    const { run, ran: seen } = engine();
    const bounded = boundedReads({ run, snapshot, budget: { remote: 20_000 * MB, local: budget.local } });
    await bounded.run('WITH k AS (SELECT "block_number" FROM "memory"."main"."eth_transactions") SELECT * FROM k');
    expect(seen.at(-1)).toBe('WITH k AS (SELECT "block_number" FROM "memory"."main"."eth_transactions") SELECT * FROM k');
    await bounded.run('SELECT * FROM "memory"."main"."eth_transactions" LIMIT 5');
    expect(seen.at(-1)).toMatch(/^SELECT \* FROM \(SELECT \* FROM read_parquet\(\[/);
  });
});
