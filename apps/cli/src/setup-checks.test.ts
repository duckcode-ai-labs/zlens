import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WarehouseCatalogRelationV1, WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { boundedReads, warehouseSampleClause } from './read-budget.js';
import { CheckStatementFailure, SetupCheckCache } from './setup-check-cache.js';
import { validateWarehouseDiscovery, type WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

/**
 * Onboarding design P4: the background checks read whole tables up to the row
 * budget and a block sample above it (decision D5), run small tables first,
 * and keep every answer so a resume repeats no finished check.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'zlens-setup-checks-'));
  roots.push(root);
  return root;
};

const table = (name: string, rows: number | undefined, kind: WarehouseCatalogRelationV1['kind'] = 'table'): WarehouseCatalogRelationV1 => ({
  id: `warehouse.SALES.PUBLIC.${name}`,
  name,
  relation: `SALES.PUBLIC.${name}`,
  kind,
  columns: [{ name: `${name}_ID`, type: 'NUMBER' }, { name: 'CUSTOMER_ID', type: 'NUMBER' }],
  ...(rows !== undefined ? { rowCountEstimate: rows } : {}),
});

describe('block samples above the row budget (decision D5)', () => {
  const orders = table('ORDERS', 1_200_000_000);
  const customers = table('CUSTOMERS', 5_000_000);
  const snapshot = { relations: [orders, customers, table('ORDERS_V', undefined, 'view')] };

  it('reads a large table a check is about from a block sample, and says so', async () => {
    const ran: string[] = [];
    const bounded = boundedReads({ run: async (sql) => { ran.push(sql); return { rows: [] }; }, snapshot, warehouseSample: { dialect: 'snowflake', rowBudget: 10_000_000 } });
    await bounded.run('SELECT COUNT(*) AS row_count, COUNT(DISTINCT "ORDERS_ID") AS nd_0 FROM "SALES"."PUBLIC"."ORDERS"');
    expect(ran[0]).toBe('SELECT COUNT(*) AS row_count, COUNT(DISTINCT "ORDERS_ID") AS nd_0 FROM (SELECT * FROM "SALES"."PUBLIC"."ORDERS" SAMPLE SYSTEM (0.8333))');
    expect(bounded.sampled().get('SALES.PUBLIC.ORDERS')).toBe('a sample of ORDERS: about 10 million of 1.2 billion rows');
    expect(bounded.notes()).toEqual([{ relation: 'SALES.PUBLIC.ORDERS', kind: 'sampled', text: 'ORDERS: checked on a block sample of about 10 million of 1.2 billion rows. What the draft says of it holds in that sample.' }]);
  });

  it('a table under the budget, a view, and a table a check only looks values up in are read whole', async () => {
    const ran: string[] = [];
    const bounded = boundedReads({ run: async (sql) => { ran.push(sql); return { rows: [] }; }, snapshot, warehouseSample: { dialect: 'snowflake', rowBudget: 10_000_000 } });
    await bounded.run('SELECT COUNT(*) FROM "SALES"."PUBLIC"."CUSTOMERS"');
    await bounded.run('SELECT COUNT(*) FROM "SALES"."PUBLIC"."ORDERS_V"');
    // A join check: the child side is the subject; the parent it looks values up in stays whole.
    const join = 'SELECT COUNT(*) FROM "SALES"."PUBLIC"."CUSTOMERS" c WHERE c."CUSTOMER_ID" NOT IN (SELECT "CUSTOMER_ID" FROM "SALES"."PUBLIC"."ORDERS")';
    await bounded.run(join, { sample: ['SALES.PUBLIC.CUSTOMERS'] });
    expect(ran).toEqual(['SELECT COUNT(*) FROM "SALES"."PUBLIC"."CUSTOMERS"', 'SELECT COUNT(*) FROM "SALES"."PUBLIC"."ORDERS_V"', join]);
    expect(bounded.sampled().size).toBe(0);
  });

  it('samples per dialect, and not where the warehouse has no block sample', () => {
    expect(warehouseSampleClause('snowflake')?.(1.5)).toBe('SAMPLE SYSTEM (1.5)');
    expect(warehouseSampleClause('duckdb')?.(1.5)).toBe('USING SAMPLE 1.5 PERCENT (system)');
    expect(warehouseSampleClause('postgresql')).toBeUndefined();
  });

  it('without the setup option, warehouse tables run exactly as before', async () => {
    const ran: string[] = [];
    const bounded = boundedReads({ run: async (sql) => { ran.push(sql); return { rows: [] }; }, snapshot });
    await bounded.run('SELECT COUNT(*) FROM "SALES"."PUBLIC"."ORDERS"');
    expect(ran).toEqual(['SELECT COUNT(*) FROM "SALES"."PUBLIC"."ORDERS"']);
  });
});

describe('kept answers: a resume repeats no finished check', () => {
  it('serves every statement answered before, and asks only the new ones', async () => {
    const root = project();
    const asked: string[] = [];
    const warehouse = async (sql: string) => { asked.push(sql); return { rows: [{ N: BigInt(7), AT: new Date('2026-01-02T00:00:00Z'), S: 'x' }] }; };
    const first = SetupCheckCache.open(root, 'catalog-1');
    const run = first.wrap(warehouse);
    await run('SELECT 1');
    await run('SELECT 2');
    expect(asked).toHaveLength(2);

    // Stopped, restarted: the same catalog keeps the answers, with their types.
    const resumed = SetupCheckCache.open(root, 'catalog-1');
    const again = resumed.wrap(warehouse);
    expect((await again('SELECT 1')).rows).toEqual([{ N: BigInt(7), AT: new Date('2026-01-02T00:00:00Z'), S: 'x' }]);
    await again('SELECT 2');
    await again('SELECT 3');
    expect(asked).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    await again('SELECT 1');
    expect(resumed.hits).toBe(3);
    expect(resumed.resumed).toBe(2);
    expect(resumed.asked).toBe(1);

    // A new read (another catalog) starts afresh.
    const other = SetupCheckCache.open(root, 'catalog-2');
    await other.wrap(warehouse)('SELECT 1');
    expect(asked).toHaveLength(4);
  });

  it('keeps a statement that ran over the time limit, so a resume does not wait for it again; check it anyway asks again', async () => {
    const root = project();
    let calls = 0;
    const slow = async () => {
      calls += 1;
      throw Object.assign(new Error('Snowflake query exceeded the 60000ms deadline.'), { vendorCode: 'TIMEOUT' });
    };
    const options = { relationsOf: () => ['SALES.PUBLIC.ORDERS'], isTimeout: (error: unknown) => (error as { vendorCode?: string }).vendorCode === 'TIMEOUT' };
    const cache = SetupCheckCache.open(root, 'c');
    await expect(cache.wrap(slow, options)('SELECT big')).rejects.toThrow('deadline');
    const resumed = SetupCheckCache.open(root, 'c');
    const failure = await resumed.wrap(slow, options)('SELECT big').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckStatementFailure);
    expect((failure as CheckStatementFailure).timedOut).toBe(true);
    expect(calls).toBe(1);
    expect(resumed.failures()).toEqual([{ relations: ['SALES.PUBLIC.ORDERS'], error: 'Snowflake query exceeded the 60000ms deadline.', timedOut: true }]);
    expect(resumed.forgetFailures(['sales.public.orders'])).toBe(1);
    await expect(SetupCheckCache.open(root, 'c').wrap(slow, options)('SELECT big')).rejects.toThrow('deadline');
    expect(calls).toBe(2);
  });

  it('a statement Stop cancelled is not kept: a resume asks it', async () => {
    const root = project();
    const controller = new AbortController();
    const cache = SetupCheckCache.open(root, 'c');
    const run = cache.wrap(async () => { controller.abort(); throw new Error('cancelled'); }, { signal: controller.signal });
    await expect(run('SELECT 1')).rejects.toThrow('cancelled');
    expect(SetupCheckCache.open(root, 'c').size).toBe(0);
  });
});

describe('small tables first, as drafted (onboarding design P4)', () => {
  const snapshot = {
    relations: [table('BIG', 900_000_000), table('SMALL', 1_000), table('MID', 2_000_000)].map((relation) => ({ ...relation, columns: [{ name: `${relation.name}_ID`, type: 'NUMBER' }] })),
  } as unknown as WarehouseCatalogSnapshotV1;
  const report = {
    entities: snapshot.relations.map((relation) => ({ id: relation.name.toLowerCase(), domain: 'sales', relationId: relation.id, relation: relation.relation, name: relation.name, grainCandidate: `${relation.name}_ID` })),
    relationships: [],
  } as unknown as WarehouseDiscoveryReport;

  it('checks keys from the smallest table up, reports its counts, and keeps the drafted order', async () => {
    const order: string[] = [];
    const steps: Array<{ kind: string; done: number; total: number }> = [];
    const checked = await validateWarehouseDiscovery(report, snapshot, async (sql) => {
      order.push(/"PUBLIC"\."(\w+)"/.exec(sql)?.[1] ?? sql);
      return { rows: [{ row_count: 10, nn_0: 10, nd_0: 10 }] };
    }, (identifier) => `"${identifier}"`, { smallFirst: true, onProgress: (step) => steps.push(step) });
    expect(order).toEqual(['SMALL', 'MID', 'BIG']);
    expect(checked.entities.map((entity) => entity.relation)).toEqual(['SALES.PUBLIC.BIG', 'SALES.PUBLIC.SMALL', 'SALES.PUBLIC.MID']);
    expect(checked.entities.map((entity) => entity.grain)).toEqual(['BIG_ID', 'SMALL_ID', 'MID_ID']);
    expect(steps.filter((step) => step.kind === 'keys').map((step) => step.done)).toEqual([1, 2, 3]);
  });

  it('without it, the order is the drafted one, as before', async () => {
    const order: string[] = [];
    await validateWarehouseDiscovery(report, snapshot, async (sql) => {
      order.push(/"PUBLIC"\."(\w+)"/.exec(sql)?.[1] ?? sql);
      return { rows: [] };
    }, (identifier) => `"${identifier}"`);
    expect(order).toEqual(['BIG', 'SMALL', 'MID']);
  });
});

const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

describe('block samples on real DuckDB (onboarding design P4)', () => {
  duckDbIt('a key check over the budget reads a block sample: a duplicate proves "not unique", none makes it likely unique', async () => {
    const root = project();
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(root, 'big.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    try {
      await executor.executePositional('CREATE TABLE events AS SELECT range AS event_id, range % 1000 AS customer_id FROM range(400000)', [], connection);
      const events: WarehouseCatalogRelationV1 = { id: 'warehouse.big.main.events', name: 'events', relation: 'big.main.events', kind: 'table', rowCountEstimate: 400_000, columns: [{ name: 'event_id', type: 'BIGINT' }, { name: 'customer_id', type: 'BIGINT' }] };
      const seen: string[] = [];
      const bounded = boundedReads({
        run: async (sql) => { seen.push(sql); return { rows: (await executor.executePositional(sql, [], connection)).rows as Array<Record<string, unknown>> }; },
        snapshot: { relations: [events] },
        warehouseSample: { dialect: 'duckdb', rowBudget: 50_000 },
      });
      const unique = (await bounded.run('SELECT COUNT(*) AS row_count, COUNT(DISTINCT event_id) AS nd FROM big.main.events')).rows[0]!;
      expect(seen[0]).toContain('USING SAMPLE 12.5 PERCENT (system)');
      expect(Number(unique.row_count)).toBeGreaterThan(0);
      expect(Number(unique.row_count)).toBeLessThan(400_000);
      expect(Number(unique.nd)).toBe(Number(unique.row_count));
      const repeated = (await bounded.run('SELECT COUNT(*) AS row_count, COUNT(DISTINCT customer_id) AS nd FROM big.main.events')).rows[0]!;
      expect(Number(repeated.nd)).toBeLessThan(Number(repeated.row_count));
      expect(bounded.sampled().get('big.main.events')).toBe('a sample of events: about 50,000 of 400,000 rows');
    } finally {
      await executor.disconnect();
    }
  }, 60_000);
});
