import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeWarehouseCatalog, warehouseRelationId, type DQLManifest, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { cheapToRead, discoverWarehouseModel, inferSharedKeyJoins, observedJoinsFromQueries, queryHistorySql, validateWarehouseDiscovery, viewJoins, warehouseDiscoveryChanges } from './warehouse-model-discovery.js';

const table = (schema: string, name: string, columns: string[], extra: Partial<WarehouseCatalogRelationV1> = {}): WarehouseCatalogRelationV1 => ({
  id: warehouseRelationId({ schema, name }),
  schema,
  name,
  relation: `${schema}.${name}`,
  kind: 'table',
  columns: columns.map((column) => ({ name: column, type: 'INTEGER' })),
  ...extra,
});

const snapshot = normalizeWarehouseCatalog({
  version: 1,
  driver: 'sqlite',
  connectionId: 'default',
  scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
  capturedAt: '2026-09-18T00:00:00.000Z',
  relations: [
    table('main', 'customers', ['customer_id', 'name'], { primaryKey: ['customer_id'], comment: 'One row per customer' }),
    table('main', 'orders', ['order_id', 'customer_id', 'amount'], {
      primaryKey: ['order_id'],
      foreignKeys: [{ columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] } }],
    }),
    // No declared keys at all: only the names say how it joins.
    table('main', 'products', ['id', 'title']),
    table('main', 'order_items', ['order_id', 'line_no', 'product_id', 'quantity']),
    table('main', 'stg_products', ['id', 'title']),
    {
      ...table('main', 'order_lines', ['order_id', 'title']),
      kind: 'view',
      viewSql: 'CREATE VIEW order_lines AS SELECT i.order_id, p.title FROM order_items AS i JOIN products p ON i.product_id = p.id',
    },
  ],
});

describe('drafting a model from the warehouse catalog', () => {
  it('drafts entities with declared grains and joins with the evidence for each', () => {
    const report = discoverWarehouseModel({ snapshot, projectName: 'Shop' });
    expect(report.domains).toEqual([{ id: 'shop', name: 'Shop', existing: false }]);
    const entity = (id: string) => report.entities.find((item) => item.id === id);
    expect(entity('customer')).toMatchObject({ relation: 'main.customers', grain: 'customer_id', keys: ['customer_id'], grainSource: 'primary_key', description: 'One row per customer' });
    expect(entity('product')).toMatchObject({ relation: 'main.products', keys: [], grainCandidate: 'id' });
    expect(entity('product')?.grain).toBeUndefined();
    // `stg_products` strips to "product" too; the second keeps its own name.
    expect(entity('stg_products')).toMatchObject({ relation: 'main.stg_products' });

    const joins = Object.fromEntries(report.relationships.map((item) => [item.id, item]));
    expect(joins.order_to_customer).toMatchObject({
      from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe',
    });
    expect(joins.order_to_customer!.evidence.map((item) => item.source)).toEqual(['declared_foreign_key', 'same_name']);
    // The view's join and the naming convention agree on order_items → products.
    expect(joins.order_item_to_product).toMatchObject({ keys: [{ from: 'product_id', to: 'id' }], cardinality: 'unknown' });
    expect(joins.order_item_to_product!.evidence.map((item) => item.source)).toEqual(['view_join', 'named_for_table']);
    // order_items.order_id names orders.
    expect(joins.order_item_to_order).toMatchObject({ keys: [{ from: 'order_id', to: 'order_id' }], cardinality: 'many_to_one' });
  });

  it('leaves relations already bound and joins already modeled alone', () => {
    const manifest = {
      modeling: {
        entities: {
          'sales::entity::buyer': { id: 'sales::entity::buyer', qualifiedId: 'sales::entity::buyer', localId: 'buyer', domain: 'sales', dbtUniqueId: 'warehouse.main.customers' },
          'sales::entity::purchase': { id: 'sales::entity::purchase', qualifiedId: 'sales::entity::purchase', localId: 'purchase', domain: 'sales', dbtUniqueId: 'warehouse.main.orders' },
        },
        relationships: {
          'sales::relationship::purchase_buyer': { from: 'sales::entity::purchase', to: 'sales::entity::buyer', keys: [{ from: 'customer_id', to: 'customer_id' }] },
        },
      },
    } as unknown as DQLManifest;
    const report = discoverWarehouseModel({ snapshot, manifest, projectName: 'shop', existingDomains: ['sales'] });
    expect(report.entities.find((item) => item.relationId === 'warehouse.main.customers')).toMatchObject({ id: 'buyer', domain: 'sales', existing: 'sales::entity::buyer' });
    expect(report.existingRelationships).toBe(1);
    expect(report.relationships.some((item) => item.from === 'purchase' && item.to === 'buyer')).toBe(false);
    // A new join to an existing entity crosses from the project domain into sales.
    const crossDomain = report.relationships.find((item) => item.to === 'purchase');
    expect(crossDomain).toMatchObject({ fromDomain: 'shop', toDomain: 'sales' });
    const changes = warehouseDiscoveryChanges(report, { owner: 'owner@shop.test' });
    expect(changes.filter((change) => change.operation === 'upsert_domain').map((change) => (change.value as { id: string }).id)).toEqual(['shop']);
    expect(changes.some((change) => change.operation === 'upsert_entity' && (change.value as { dbtModel: string }).dbtModel === 'warehouse.main.customers')).toBe(false);
    const relationship = changes.find((change) => change.operation === 'upsert_relationship' && (change.value as { to: string }).to === 'sales::entity::purchase');
    expect(relationship?.value).toMatchObject({ from: 'order_item', crossDomain: true, status: 'draft' });
  });

  it('checks joins and naming-key grains on the warehouse, and proposes the cardinality it saw', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER, name TEXT);
      CREATE TABLE orders (order_id INTEGER, customer_id INTEGER, amount INTEGER);
      CREATE TABLE products (id INTEGER, title TEXT);
      CREATE TABLE order_items (order_id INTEGER, line_no INTEGER, product_id INTEGER, quantity INTEGER);
      CREATE TABLE stg_products (id INTEGER, title TEXT);
      INSERT INTO customers VALUES (1, 'a'), (2, 'b');
      INSERT INTO orders VALUES (10, 1, 5), (11, 1, 6), (12, 2, 7);
      INSERT INTO products VALUES (100, 'x'), (101, 'y');
      INSERT INTO order_items VALUES (10, 1, 100, 1), (10, 2, 101, 1), (11, 1, 100, 3), (12, 1, 999, 1);
      INSERT INTO stg_products VALUES (100, 'x'), (100, 'x again');
    `);
    const sql: string[] = [];
    const execute = async (statement: string) => { sql.push(statement); return { rows: db.prepare(statement).all() as Array<Record<string, unknown>> }; };
    const report = await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot, projectName: 'shop' }), snapshot, execute, (identifier) => `"${identifier}"`);
    expect(report.validated).toBe(true);
    expect(report.entities.find((item) => item.id === 'product')).toMatchObject({ grain: 'id', keys: ['id'], grainSource: 'unique_column' });
    // A repeated id is not a grain.
    expect(report.entities.find((item) => item.id === 'stg_products')?.grain).toBeUndefined();
    const joins = Object.fromEntries(report.relationships.map((item) => [item.id, item]));
    expect(joins.order_item_to_product).toMatchObject({ cardinality: 'many_to_one', fanout: 'safe' });
    expect(joins.order_item_to_product!.validation).toMatchObject({ unmatchedFrom: 1 });
    expect(joins.order_to_customer!.validation).toMatchObject({ status: 'passed', unmatchedFrom: 0 });
    // Aggregates only: no statement reads a row's values.
    expect(sql.every((statement) => /COUNT\(/i.test(statement))).toBe(true);
    db.close();
  });
});

describe('joins the data proves, on a warehouse that declares no keys', () => {
  it('proposes a join where a shared column is unique on one side and contained on the other, and nothing else', async () => {
    const t = (name: string, columns: Array<[string, string]>, rows: number) => ({
      id: warehouseRelationId({ schema: 'app', name }), schema: 'app', name, relation: `app.${name}`, kind: 'table' as const,
      columns: columns.map(([column, type]) => ({ name: column, type })), rowCountEstimate: rows,
    });
    const bare = normalizeWarehouseCatalog({
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'app', schemas: ['app'] }], capturedAt: '2026-09-19T00:00:00.000Z',
      relations: [
        t('shops', [['Cust_Code', 'TEXT'], ['name', 'TEXT'], ['status', 'TEXT']], 3),
        t('sales', [['Order_Ref', 'INTEGER'], ['Cust_Code', 'TEXT'], ['status', 'TEXT'], ['name', 'TEXT'], ['total', 'DOUBLE']], 5),
        t('refunds', [['Order_Ref', 'INTEGER'], ['total', 'DOUBLE']], 2),
      ],
    });
    const db = new Database(':memory:');
    db.exec(`
      ATTACH ':memory:' AS app;
      CREATE TABLE app.shops (Cust_Code TEXT, name TEXT, status TEXT);
      CREATE TABLE app.sales (Order_Ref INTEGER, Cust_Code TEXT, status TEXT, name TEXT, total DOUBLE);
      CREATE TABLE app.refunds (Order_Ref INTEGER, total DOUBLE);
      INSERT INTO app.shops VALUES ('C1', 'North', 'open'), ('C2', 'South', 'open'), ('C3', 'East', 'closed');
      INSERT INTO app.sales VALUES (1, 'C1', 'open', 'x', 10), (2, 'C1', 'open', 'y', 20), (3, 'C2', 'closed', 'z', 30), (4, 'C3', 'open', 'w', 40), (5, 'C2', 'open', 'v', 50);
      INSERT INTO app.refunds VALUES (2, 20), (5, 50);
    `);
    const execute = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    const drafted = discoverWarehouseModel({ snapshot: bare, projectName: 'app' });
    // Names alone say nothing here: no declared keys, no `_id` columns.
    expect(drafted.relationships).toEqual([]);
    const inferred = await inferSharedKeyJoins(drafted, bare, execute, (identifier) => `"${identifier}"`);
    const joins = inferred.relationships.map((item) => `${item.from}.${item.keys[0]!.from} -> ${item.to}.${item.keys[0]!.to} (${item.cardinality})`).sort();
    expect(joins).toEqual([
      'refund.Order_Ref -> sale.Order_Ref (one_to_one)',
      'sale.Cust_Code -> shop.Cust_Code (many_to_one)',
    ]);
    // `name` is unique in shops and sales but its values are not contained
    // either way; `status` repeats; `total` is a measure type: none is a join.
    expect(inferred.relationships.every((item) => item.evidence[0]!.source === 'shared_key')).toBe(true);
    expect(inferred.entities.find((entity) => entity.id === 'shop')).toMatchObject({ grain: 'Cust_Code', grainSource: 'unique_column' });
    expect(inferred.entities.find((entity) => entity.id === 'sale')).toMatchObject({ grain: 'Order_Ref' });
    db.close();
  });
});

// New-user round 2, problem 5: database-only setup drafted order_item → product
// on product_name next to the product_id join: two identical "Order Items → Product" groups.
describe('joins are drafted on keys, never on names', () => {
  it('drafts the product_id join and no second join on product_name; a unique name alone is not a key', async () => {
    const t = (name: string, columns: Array<[string, string]>, rows: number) => ({
      id: warehouseRelationId({ schema: 'main', name }), schema: 'main', name, relation: `main.${name}`, kind: 'table' as const,
      columns: columns.map(([column, type]) => ({ name: column, type })), rowCountEstimate: rows,
    });
    const bare = normalizeWarehouseCatalog({
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }], capturedAt: '2026-10-22T00:00:00.000Z',
      relations: [
        t('products', [['product_id', 'TEXT'], ['product_name', 'TEXT'], ['product_price', 'DOUBLE']], 3),
        t('order_items', [['order_item_id', 'TEXT'], ['product_id', 'TEXT'], ['product_name', 'TEXT']], 4),
        t('stores', [['store_name', 'TEXT'], ['city', 'TEXT']], 2),
        t('visits', [['visit_ref', 'INTEGER'], ['store_name', 'TEXT']], 3),
      ],
    });
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE products (product_id TEXT, product_name TEXT, product_price DOUBLE);
      CREATE TABLE order_items (order_item_id TEXT, product_id TEXT, product_name TEXT);
      CREATE TABLE stores (store_name TEXT, city TEXT);
      CREATE TABLE visits (visit_ref INTEGER, store_name TEXT);
      INSERT INTO products VALUES ('p1', 'Latte', 4.5), ('p2', 'Mocha', 5), ('p3', 'Bagel', 3);
      INSERT INTO order_items VALUES ('i1', 'p1', 'Latte'), ('i2', 'p2', 'Mocha'), ('i3', 'p1', 'Latte'), ('i4', 'p3', 'Bagel');
      INSERT INTO stores VALUES ('North', 'Brooklyn'), ('South', 'Philadelphia');
      INSERT INTO visits VALUES (1, 'North'), (2, 'South'), (3, 'North');
    `);
    const execute = async (sql: string) => ({ rows: db.prepare(sql.replace(/"main"\./g, '')).all() as Array<Record<string, unknown>> });
    const drafted = discoverWarehouseModel({ snapshot: bare, projectName: 'shop' });
    const inferred = await inferSharedKeyJoins(drafted, bare, execute, (identifier) => `"${identifier}"`);
    const joins = inferred.relationships.map((item) => `${item.from}.${item.keys.map((pair) => pair.from).join('+')} -> ${item.to}`).sort();
    expect(joins).toEqual(['order_item.product_id -> product']);
    expect(inferred.relationships.some((item) => item.keys.some((pair) => /name/.test(pair.from)))).toBe(false);
    db.close();
  });
});

describe('query-history evidence (opt-in)', () => {
  it('counts the joins recent queries ran, once per statement, and keeps no query text', () => {
    const observed = observedJoinsFromQueries([
      'select * from main.customers c join main.orders o on o.customer_id = c.customer_id where c.name = \'Ann\'',
      'SELECT count(*) FROM main.orders AS o JOIN main.customers AS c ON c.customer_id = o.customer_id AND c.customer_id = o.customer_id',
      'select 1 from main.products p join main.order_items i on i.product_id = p.id',
    ]);
    expect(observed).toEqual([
      { left: { relation: 'main.customers', column: 'customer_id' }, right: { relation: 'main.orders', column: 'customer_id' }, count: 2 },
      { left: { relation: 'main.order_items', column: 'product_id' }, right: { relation: 'main.products', column: 'id' }, count: 1 },
    ]);
    expect(JSON.stringify(observed)).not.toContain('Ann');
  });

  it('adds a join seen often enough as evidence, and ignores one seen once', () => {
    const bare = normalizeWarehouseCatalog({ ...snapshot, relations: snapshot.relations.map((relation) => ({ ...relation, foreignKeys: undefined, viewSql: undefined })) });
    const report = discoverWarehouseModel({
      snapshot: bare,
      projectName: 'shop',
      observedJoins: [
        { left: { relation: 'main.customers', column: 'customer_id' }, right: { relation: 'main.orders', column: 'customer_id' }, count: 5 },
        { left: { relation: 'main.stg_products', column: 'id' }, right: { relation: 'main.order_items', column: 'product_id' }, count: 1 },
      ],
    });
    const join = report.relationships.find((item) => item.from === 'order' && item.to === 'customer');
    expect(join?.evidence[0]).toEqual({ source: 'query_history', reason: 'recent queries joined orders.customer_id = customers.customer_id 5 times' });
    expect(report.relationships.some((item) => item.to === 'stg_products')).toBe(false);
  });

  it('reads history only where the warehouse keeps it', () => {
    expect(queryHistorySql('snowflake', { database: 'ACME' })).toContain('"ACME".INFORMATION_SCHEMA.QUERY_HISTORY');
    expect(queryHistorySql('postgres')).toContain('pg_stat_statements');
    expect(queryHistorySql('databricks')).toContain('system.query.history');
    expect(queryHistorySql('bigquery', { location: 'EU' })).toContain('`region-eu`.INFORMATION_SCHEMA.JOBS_BY_PROJECT');
    expect(queryHistorySql('duckdb')).toBeUndefined();
    expect(queryHistorySql('sqlite')).toBeUndefined();
  });
});

describe('which relations the data checks read', () => {
  it('reads tables and projection views, and leaves out views that join or aggregate', () => {
    const view = (viewSql: string) => ({ id: 'v', name: 'v', relation: 'v', kind: 'view' as const, columns: [{ name: 'a' }], viewSql });
    expect(cheapToRead({ id: 't', name: 't', relation: 't', kind: 'table', columns: [] })).toBe(true);
    expect(cheapToRead(view('CREATE VIEW claim AS SELECT Claim_Identifier, Claim_Open_Date FROM acme.main__seed.Claim;'))).toBe(true);
    expect(cheapToRead(view('CREATE VIEW profits AS SELECT s.prod_id, c.unit_cost FROM costs c JOIN sales s ON c.prod_id = s.prod_id'))).toBe(false);
    expect(cheapToRead(view('CREATE VIEW m AS SELECT prod_id, SUM(amount) FROM sales GROUP BY 1'))).toBe(false);
    expect(cheapToRead(view("CREATE VIEW n AS SELECT 'join' AS word, a FROM t"))).toBe(true);
    expect(cheapToRead({ id: 'w', name: 'w', relation: 'w', kind: 'view', columns: [] })).toBe(false);
  });
});

describe('reading joins out of view SQL', () => {
  it('reads aliased equality joins and ignores what it cannot read', () => {
    expect(viewJoins('select * from sales.orders o left join sales.customers as c on o.customer_id = c.id and o.region = c.region')).toEqual([
      { left: { relation: 'sales.orders', column: 'customer_id' }, right: { relation: 'sales.customers', column: 'id' } },
      { left: { relation: 'sales.orders', column: 'region' }, right: { relation: 'sales.customers', column: 'region' } },
    ]);
    expect(viewJoins('SELECT * FROM "A"."B" JOIN "A"."C" ON "B"."k" = "C"."k"')).toEqual([
      { left: { relation: 'A.B', column: 'k' }, right: { relation: 'A.C', column: 'k' } },
    ]);
    expect(viewJoins('select a.x from a join (select * from b) s on a.id = s.id')).toEqual([]);
    expect(viewJoins('select 1')).toEqual([]);
  });
});

// Launch blocker: on jaffle-shop-warehouse `zlens model discover --validate`
// chose `product_name` as the grain of products (a label) and no grain for
// supplies, where `product_id` and `supply_uuid` are unique.
describe('a table’s grain is its own identity column', () => {
  it('prefers the unique `<table>_id` over a unique label other tables happen to reference, and finds `<table>_uuid` when the id repeats', async () => {
    const t = (name: string, columns: Array<[string, string]>, rows: number) => ({
      id: warehouseRelationId({ schema: 'dev', name }), schema: 'dev', name, relation: `dev.${name}`, kind: 'table' as const,
      columns: columns.map(([column, type]) => ({ name: column, type })), rowCountEstimate: rows,
    });
    const jaffle = normalizeWarehouseCatalog({
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'dev', schemas: ['dev'] }], capturedAt: '2026-10-16T00:00:00.000Z',
      relations: [
        t('products', [['product_id', 'TEXT'], ['product_name', 'TEXT'], ['product_price', 'INTEGER']], 3),
        t('order_items', [['order_item_id', 'TEXT'], ['product_id', 'TEXT'], ['product_name', 'TEXT']], 4),
        t('supplies', [['supply_uuid', 'TEXT'], ['supply_id', 'TEXT'], ['product_id', 'TEXT'], ['supply_cost', 'INTEGER']], 4),
      ],
    });
    const db = new Database(':memory:');
    db.exec(`
      ATTACH ':memory:' AS dev;
      CREATE TABLE dev.products (product_id TEXT, product_name TEXT, product_price INTEGER);
      CREATE TABLE dev.order_items (order_item_id TEXT, product_id TEXT, product_name TEXT);
      CREATE TABLE dev.supplies (supply_uuid TEXT, supply_id TEXT, product_id TEXT, supply_cost INTEGER);
      INSERT INTO dev.products VALUES ('BEV-1', 'tea', 3), ('BEV-2', 'coffee', 4), ('JAF-1', 'jaffle', 9);
      INSERT INTO dev.order_items VALUES ('i1', 'BEV-1', 'tea'), ('i2', 'BEV-2', 'coffee'), ('i3', 'JAF-1', 'jaffle'), ('i4', 'BEV-1', 'tea');
      INSERT INTO dev.supplies VALUES ('u1', 'SUP-1', 'BEV-1', 1), ('u2', 'SUP-1', 'BEV-2', 1), ('u3', 'SUP-2', 'JAF-1', 2), ('u4', 'SUP-3', 'JAF-1', 1);
    `);
    const execute = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    const report = await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot: jaffle, projectName: 'jaffle' }), jaffle, execute, (identifier) => `"${identifier}"`);
    expect(report.entities.find((entity) => entity.id === 'product')).toMatchObject({ grain: 'product_id', keys: ['product_id'], grainSource: 'unique_column' });
    expect(report.entities.find((entity) => entity.id === 'supply')).toMatchObject({ grain: 'supply_uuid', keys: ['supply_uuid'], grainSource: 'unique_column' });
    expect(report.entities.find((entity) => entity.id === 'order_item')).toMatchObject({ grain: 'order_item_id' });
    // A label is not a key (new-user round 2, problem 5): no second Product join on product_name.
    expect(report.relationships.some((item) => item.keys[0]!.from === 'product_name' && item.to === 'product')).toBe(false);
    expect(report.relationships.filter((item) => item.from === 'order_item' && item.to === 'product').map((item) => item.keys[0]!.from)).toEqual(['product_id']);
    db.close();
  });
});

describe('a first Domain named after the data, without staging copies (new-user round 2, Q3)', () => {
  const layered = normalizeWarehouseCatalog({
    version: 1,
    driver: 'duckdb',
    connectionId: 'default',
    scopes: [{ catalogOrDatabase: 'jaffle_shop', schemas: ['dev', 'raw', 'sales'] }],
    capturedAt: '2026-10-21T00:00:00.000Z',
    relations: [
      table('dev', 'customers', ['customer_id', 'name'], { database: 'jaffle_shop', primaryKey: ['customer_id'] }),
      table('dev', 'stg_customers', ['customer_id', 'name'], { database: 'jaffle_shop' }),
      table('raw', 'raw_orders', ['id', 'customer'], { database: 'jaffle_shop' }),
      table('dev', 'orders', ['order_id', 'customer_id'], { database: 'jaffle_shop', primaryKey: ['order_id'] }),
      table('sales', 'targets', ['target_id', 'amount'], { database: 'jaffle_shop' }),
    ],
  });

  it('maps dev and raw into one Domain named after the database; a business schema keeps its own', () => {
    const report = discoverWarehouseModel({ snapshot: layered, projectName: 'shop' });
    expect(report.domains).toEqual([
      { id: 'jaffle_shop', name: 'Jaffle shop', existing: false },
      { id: 'sales', name: 'Sales', existing: false },
    ]);
    expect(report.entities.find((item) => item.relation === 'dev.customers')?.domain).toBe('jaffle_shop');
    expect(report.entities.find((item) => item.relation === 'sales.targets')?.domain).toBe('sales');
    // The file name wins over the catalog when the runtime knows it.
    expect(discoverWarehouseModel({ snapshot: layered, databaseName: 'shop_2026' }).domains).toContainEqual({ id: 'shop_2026', name: 'Shop 2026', existing: false });
  });

  it('keeps a schema Domain the project already has, and a Domain the person named', () => {
    expect(discoverWarehouseModel({ snapshot: layered, existingDomains: ['dev'] }).entities.find((item) => item.relation === 'dev.orders')?.domain).toBe('dev');
    expect(discoverWarehouseModel({ snapshot: layered, domain: 'Jaffle Shop Sales' }).domains).toEqual([{ id: 'jaffle_shop_sales', name: 'Jaffle Shop Sales', existing: false }]);
  });

  it('leaves out staging copies of a final table only when asked, and says which', () => {
    const all = discoverWarehouseModel({ snapshot: layered });
    expect(all.entities.map((item) => item.relation)).toContain('dev.stg_customers');
    expect(all.stagingHidden).toBeUndefined();
    const plain = discoverWarehouseModel({ snapshot: layered, hideStagingDuplicates: true });
    expect(plain.entities.map((item) => item.relation).sort()).toEqual(['dev.customers', 'dev.orders', 'sales.targets']);
    expect(plain.stagingHidden).toEqual([
      { relation: 'dev.stg_customers', finalRelation: 'dev.customers' },
      { relation: 'raw.raw_orders', finalRelation: 'dev.orders' },
    ]);
    expect(plain.relations).toBe(5);
  });
});
