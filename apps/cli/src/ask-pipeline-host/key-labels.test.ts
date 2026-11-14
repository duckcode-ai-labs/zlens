import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { createAskPipelineRouteExecutor } from './host.js';
import { keyLabelLine, keyLabels, labelColumnOf, unnamedGroupingKeys, unnamedKeyFailure, type EntityKey, type KeyReference } from './key-labels.js';
import type { ModelingRelationshipEdge } from './join-relationships.js';

/**
 * "What is the average order value at each store?" over the Jaffle Shop
 * sample: the orders carry only `location_id` (a UUID); the store's name is on
 * `locations`. Five recorded runs of the claude-code drafter grouped by
 * `orders.location_id` with no join, and the answer listed UUIDs.
 */
const ORDERS = '"jaffle_shop"."dev"."orders"';
const LOCATIONS = '"jaffle_shop"."dev"."locations"';
const CUSTOMERS = '"jaffle_shop"."dev"."customers"';
const ITEMS = '"jaffle_shop"."dev"."order_items"';
const PRODUCTS = '"jaffle_shop"."dev"."products"';
const columns: Record<string, string[]> = {
  [ORDERS]: ['order_id', 'location_id', 'customer_id', 'order_total', 'ordered_at'],
  [LOCATIONS]: ['location_id', 'location_name', 'tax_rate', 'opened_date'],
  [CUSTOMERS]: ['customer_id', 'customer_name', 'customer_type'],
  [ITEMS]: ['order_item_id', 'order_id', 'product_id', 'product_name', 'product_price'],
  [PRODUCTS]: ['product_id', 'product_name', 'product_type', 'product_description'],
};
const tables = Object.keys(columns);
const columnsOf = (relation: string) => columns[tables.find((table) => table.toLowerCase() === relation.toLowerCase()) ?? relation] ?? [];
/** A semantic model's bare name (`locations`) resolves to the one warehouse table it is. */
const resolve = (relation: string) => tables.find((table) => table.split('.').pop()!.replace(/"/g, '') === relation.split('.').pop()!.replace(/"/g, ''));

const orderToLocation: ModelingRelationshipEdge = {
  relationshipId: 'commerce::relationship::order_to_location', name: 'order_to_location',
  fromRelation: 'dev.orders', toRelation: 'dev.locations', keys: [{ from: 'location_id', to: 'location_id' }], level: 'draft', cardinality: 'many_to_one',
};
// The sample's semantic models: orders has a foreign `location`, locations its primary.
const entities: EntityKey[] = [
  { name: 'location', type: 'foreign', relation: 'orders', column: 'location_id' },
  { name: 'customer', type: 'foreign', relation: 'orders', column: 'customer_id' },
  { name: 'location', type: 'primary', relation: 'locations', column: 'location_id' },
  { name: 'customer', type: 'primary', relation: 'customers', column: 'customer_id' },
  { name: 'product', type: 'foreign', relation: 'order_items', column: 'product_id' },
  { name: 'product', type: 'primary', relation: 'products', column: 'product_id' },
];

const BARE_KEY = `SELECT location_id, SUM(order_total) / COUNT(DISTINCT order_id) AS average_order_value\nFROM ${ORDERS}\nGROUP BY location_id\nORDER BY location_id\nLIMIT 500`;
const BARE_KEY_ALIASED = `SELECT\n  o.location_id,\n  SUM(o.order_total) / COUNT(DISTINCT o.order_id) AS average_order_value\nFROM ${ORDERS} AS o\nGROUP BY o.location_id\nORDER BY average_order_value DESC\nLIMIT 500`;
const JOINED = `SELECT l.location_id, l.location_name, SUM(o.order_total) / COUNT(DISTINCT o.order_id) AS average_order_value\nFROM ${ORDERS} o\nJOIN ${LOCATIONS} l ON o.location_id = l.location_id\nGROUP BY l.location_id, l.location_name\nORDER BY average_order_value DESC`;

describe('the column that names a table\'s rows', () => {
  it('prefers <thing>_name, then a plain name column, and never guesses between unrelated names', () => {
    expect(labelColumnOf(columns[LOCATIONS]!, ['locations'])).toBe('location_name');
    expect(labelColumnOf(columns[PRODUCTS]!, ['products'])).toBe('product_name');
    expect(labelColumnOf(['id', 'name', 'email'], ['accounts'])).toBe('name');
    expect(labelColumnOf(['team_id', 'coach_name', 'arena_name'], ['teams'])).toBeUndefined();
    expect(labelColumnOf(['location_id', 'tax_rate'], ['locations'])).toBeUndefined();
  });
});

describe('which table names a key, from metadata the project already has', () => {
  const key: KeyReference = { relation: ORDERS, column: 'location_id' };

  it('a relationship on the Modeling map', () => {
    const [label] = keyLabels([key], { edges: [orderToLocation], relations: tables, columnsOf, resolve });
    expect(label).toEqual({ keyRelation: ORDERS, key: 'location_id', labelRelation: LOCATIONS, labelKey: 'location_id', label: 'location_name', via: 'the draft relationship order_to_location' });
  });

  it('a semantic model\'s foreign entity and the model where it is primary (resolved to the warehouse table)', () => {
    const [label] = keyLabels([key], { edges: [], entities, relations: [], columnsOf, resolve });
    expect(label).toMatchObject({ labelRelation: LOCATIONS, label: 'location_name', via: 'the semantic entity location' });
  });

  it('the column names, when nothing else is declared', () => {
    const [label] = keyLabels([key], { edges: [], relations: tables, columnsOf, resolve });
    expect(label).toMatchObject({ labelRelation: LOCATIONS, labelKey: 'location_id', label: 'location_name', via: 'the column names' });
  });

  it('is general: customers by customer_id, products by product_id, and a key on its own table', () => {
    const labels = keyLabels([
      { relation: ORDERS, column: 'customer_id' },
      { relation: ITEMS, column: 'product_id' },
      { relation: CUSTOMERS, column: 'customer_id' },
    ], { edges: [], entities, relations: tables, columnsOf, resolve });
    expect(labels.map((item) => [item.keyRelation, item.labelRelation, item.label])).toEqual([
      [ORDERS, CUSTOMERS, 'customer_name'],
      [ITEMS, PRODUCTS, 'product_name'],
      [CUSTOMERS, CUSTOMERS, 'customer_name'],
    ]);
  });

  it('names nothing when the target table is unknown, lacks the key, or has no name column', () => {
    expect(keyLabels([key], { edges: [orderToLocation], relations: [], columnsOf: () => [], resolve })).toEqual([]);
    expect(keyLabels([key], { edges: [], relations: tables, columnsOf: (relation) => (relation === LOCATIONS ? ['location_id', 'tax_rate'] : columnsOf(relation)), resolve })).toEqual([]);
    expect(keyLabels([{ relation: ORDERS, column: 'order_total' }], { edges: [orderToLocation], entities, relations: tables, columnsOf, resolve })).toEqual([]);
  });

  it('spells the join for the draft', () => {
    const [label] = keyLabels([key], { edges: [orderToLocation], relations: tables, columnsOf, resolve });
    expect(keyLabelLine(label!)).toBe(`- ${ORDERS}.location_id is a key, not a name: ${LOCATIONS}.location_name names those rows (the draft relationship order_to_location). When the answer groups or lists by location_id, join ${LOCATIONS} ON ${ORDERS}.location_id = ${LOCATIONS}.location_id and show location_name beside location_id.`);
  });
});

describe('a drafted statement that groups by a bare key is sent back', () => {
  const label = (keys: KeyReference[]) => keyLabels(keys, { edges: [orderToLocation], entities, relations: tables, columnsOf, resolve });
  const question = 'What is the average order value at each store?';

  it('flags the statements the drafter actually wrote (bare and aliased)', () => {
    for (const sql of [BARE_KEY, BARE_KEY_ALIASED]) {
      const unnamed = unnamedGroupingKeys(sql, question, label, columnsOf);
      expect(unnamed).toHaveLength(1);
      expect(unnamedKeyFailure(unnamed[0]!)).toBe(`it groups by ${ORDERS}.location_id, a key a reader cannot read, and shows no name for it, although ${LOCATIONS}.location_name names those rows (the draft relationship order_to_location); join ${LOCATIONS} ON ${ORDERS}.location_id = ${LOCATIONS}.location_id and select location_name beside location_id`);
    }
  });

  it('passes a statement that joins the name, by position or by column, with the key beside it', () => {
    expect(unnamedGroupingKeys(JOINED, question, label, columnsOf)).toEqual([]);
    const positional = `SELECT l.location_name, o.location_id, AVG(o.order_total) FROM ${ORDERS} o JOIN ${LOCATIONS} l ON o.location_id = l.location_id GROUP BY 1, 2`;
    expect(unnamedGroupingKeys(positional, question, label, columnsOf)).toEqual([]);
  });

  it('a question that asks for ids, or names the key column, is answered by ids', () => {
    expect(unnamedGroupingKeys(BARE_KEY, 'Average order value per location id', label, columnsOf)).toEqual([]);
    expect(unnamedGroupingKeys(BARE_KEY, 'average order value by location_id', label, columnsOf)).toEqual([]);
  });

  it('a grouping by a column that is not a key, or a key no table names, is left alone', () => {
    expect(unnamedGroupingKeys(`SELECT customer_type, COUNT(*) FROM ${CUSTOMERS} GROUP BY customer_type`, 'orders by customer type', label, columnsOf)).toEqual([]);
    expect(unnamedGroupingKeys(`SELECT order_id, SUM(order_total) FROM ${ORDERS} GROUP BY order_id`, 'total per order', label, columnsOf)).toEqual([]);
  });

  it('revenue by customer and items per product are held to the same rule', () => {
    const byCustomer = `SELECT o.customer_id, SUM(o.order_total) AS revenue FROM ${ORDERS} o GROUP BY o.customer_id`;
    expect(unnamedGroupingKeys(byCustomer, 'revenue by customer', label, columnsOf).map((item) => item.label)).toEqual(['customer_name']);
    const byProduct = `SELECT i.product_id, COUNT(*) AS items_sold FROM ${ITEMS} i GROUP BY i.product_id`;
    // order_items carries the product's name itself; a statement that never reads it is still sent back.
    expect(unnamedGroupingKeys(byProduct, 'items sold per product', label, columnsOf).map((item) => item.label)).toEqual(['product_name']);
    expect(unnamedGroupingKeys(`SELECT i.product_id, i.product_name, COUNT(*) FROM ${ITEMS} i GROUP BY 1, 2`, 'items sold per product', label, columnsOf)).toEqual([]);
  });
});

describe('on the host: the drafted answer shows the store names, never their UUIDs', () => {
  const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const store = { brooklyn: '40e6ddd6-b8f6-4e17-8bd6-5e53966809d2', philadelphia: '4b6c2304-2b9e-41e4-942a-cf11a1819378' };
  const manifest = { sources: {
    orders: { name: 'orders', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.jaffle_shop.orders', schema: 'dev', columns: { order_id: { name: 'order_id' }, location_id: { name: 'location_id' }, order_total: { name: 'order_total' } } } },
    locations: { name: 'locations', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.jaffle_shop.locations', schema: 'dev', columns: { location_id: { name: 'location_id' }, location_name: { name: 'location_name' } } } },
  } };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Average order value per store.', measures: [{ ref: 'metric:shop.aov' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
  const BARE = 'SELECT o.location_id, SUM(o.order_total) / COUNT(DISTINCT o.order_id) AS average_order_value FROM dev.orders o GROUP BY o.location_id';
  const NAMED = 'SELECT l.location_id, l.location_name, SUM(o.order_total) / COUNT(DISTINCT o.order_id) AS average_order_value FROM dev.orders o JOIN dev.locations l ON o.location_id = l.location_id GROUP BY l.location_id, l.location_name';
  const routeFor = (drafts: string[], prompts: string[]) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-key-labels',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      if (sql.includes('information_schema.columns')) {
        const rows = [
          ...(/'orders'/.test(sql) ? ['order_id', 'location_id', 'order_total'].map((column) => ({ table_schema: 'dev', table_name: 'orders', column_name: column, data_type: column === 'order_total' ? 'DOUBLE' : 'VARCHAR' })) : []),
          ...(/'locations'/.test(sql) ? ['location_id', 'location_name'].map((column) => ({ table_schema: 'dev', table_name: 'locations', column_name: column, data_type: 'VARCHAR' })) : []),
        ];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }
      return sql.includes('location_name')
        ? { columns: ['location_id', 'location_name', 'average_order_value'], rowCount: 2, executionTimeMs: 1, rows: [{ location_id: store.philadelphia, location_name: 'Philadelphia', average_order_value: 11.29 }, { location_id: store.brooklyn, location_name: 'Brooklyn', average_order_value: 10.01 }] }
        : { columns: ['location_id', 'average_order_value'], rowCount: 2, executionTimeMs: 1, rows: [{ location_id: store.philadelphia, average_order_value: 11.29 }, { location_id: store.brooklyn, average_order_value: 10.01 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:key-labels', manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return drafts[Math.min(prompts.length - 1, drafts.length - 1)]!;
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  const ask = (route: ReturnType<typeof createAskPipelineRouteExecutor>, question = 'What is the average order value at each store?') => route({
    runId: 'run:key-labels',
    request: { question, requestedMode: 'ask' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });

  it('a statement grouped by the bare key is sent back once with the join to the name, and the answer reads names', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor([BARE, NAMED], prompts));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('NOTE: The previous statement was not run because it groups by dev.orders.location_id, a key a reader cannot read, and shows no name for it, although dev.locations.location_name names those rows');
    expect(prompts[1]).toContain('join dev.locations ON dev.orders.location_id = dev.locations.location_id');
    expect(prompts[1]).toContain('relation:dev.locations');
    expect(result.status).toBe('completed');
    expect(result.answer).toContain('Philadelphia · 11.29; Brooklyn · 10.01');
    expect(result.answer).not.toContain(store.brooklyn);
    const checks = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'key_labels');
    expect(checks.map((check) => check.passed)).toEqual([false, true]);
  });

  it('a draft that will not join the name still runs, and the answer says what identifies its rows instead of listing UUIDs', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor([BARE], prompts));
    expect(prompts).toHaveLength(2);
    expect(result.status).toBe('completed');
    expect(result.answer).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(result.answer).toContain('The rows are identified by location_id, internal key with no name beside it in this result.');
    expect(result.answer).toContain('The rows are grouped by location_id, an internal key; locations.location_name names them, and the statement could not be made to show it.');
  });

  it('a draft that already shows the names is not sent back, and its prompt is unchanged', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor([NAMED], prompts), 'What is the average order value at each location?');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('is a key, not a name');
    expect(result.answer).toContain('Philadelphia · 11.29');
  });
});
