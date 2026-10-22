/**
 * RFC 0007 end to end through the local runtime: a project with no dbt, a
 * real SQLite warehouse, Settings → Sync schema, then Modeling over the
 * warehouse's own relations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

describe('warehouse-first modeling in the local runtime', () => {
  const roots: string[] = [];
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // F3 (ZLens 0.1.0 e2e): "Model my warehouse without dbt" on a project that
  // imports dbt turned it warehouse-first with an empty catalog, and Ask lost
  // every table ("no table in this project matches") for the same question
  // the CLI had answered minutes earlier.
  it('never turns a project that reads dbt into warehouse-first modeling unasked', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-dbt-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json' }, nodes: {}, sources: {} }));
    const config = { project: 'nba', layout: { version: 2, mode: 'oss-dbt-workspace' }, connections: { default: { driver: 'sqlite', filepath: ':memory:' } }, dbtImport: { anchors: ['path:models/'] } };
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify(config));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), preferredPort: 0, captureServer: (created) => { server = created; } });
    const base = `http://127.0.0.1:${port}`;

    const modeling = await fetch(`${base}/api/modeling/dbt-first`);
    expect(modeling.status).toBe(404);
    expect(((await modeling.json()) as { code: string; details: { dbtDetected: boolean } })).toMatchObject({ code: 'DBT_FIRST_NOT_ENABLED', details: { dbtDetected: true } });

    const enabled = await fetch(`${base}/api/modeling/warehouse/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(enabled.status).toBe(409);
    const refusal = await enabled.json() as { code: string; message: string };
    expect(refusal.code).toBe('MODELING_MODE_CONFLICT');
    expect(refusal.message).toContain('already reads a dbt project');
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8'))).toEqual(config);

    // An explicit hybrid choice keeps the dbt models and adds warehouse tables.
    const hybrid = await fetch(`${base}/api/modeling/warehouse/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'hybrid' }) });
    expect(hybrid.status).toBe(200);
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')).modeling).toEqual({ mode: 'hybrid' });
  });

  // Setup's "Database only" card on a dbt-first project: the refusal names the
  // two ways forward instead of an internal mode word.
  it('refuses Database only for a dbt-first project and says to choose Both or start a new folder', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-dbtfirst-'));
    roots.push(projectRoot);
    const config = { project: 'jaffle', manifestVersion: 3, modeling: { mode: 'dbt-first' }, connections: { default: { driver: 'sqlite', filepath: ':memory:' } } };
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify(config));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), preferredPort: 0, captureServer: (created) => { server = created; } });
    const enabled = await fetch(`http://127.0.0.1:${port}/api/modeling/warehouse/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(enabled.status).toBe(409);
    const refusal = await enabled.json() as { code: string; message: string };
    expect(refusal.code).toBe('MODELING_MODE_CONFLICT');
    expect(refusal.message).toContain('This folder is a dbt project');
    expect(refusal.message).toContain('Choose Both');
    expect(refusal.message).toContain('npx create-zlens-app my-analytics --warehouse');
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8'))).toEqual(config);
  });

  it('turns a project without dbt into warehouse-first modeling', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-nodbt-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', connections: { default: { driver: 'sqlite', filepath: ':memory:' } } }));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), preferredPort: 0, captureServer: (created) => { server = created; } });
    const modeling = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`);
    expect(((await modeling.json()) as { details: { dbtDetected: boolean } }).details.dbtDetected).toBe(false);
    const enabled = await fetch(`http://127.0.0.1:${port}/api/modeling/warehouse/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(enabled.status).toBe(200);
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')).modeling).toEqual({ mode: 'warehouse-first' });
  });

  it('syncs the warehouse catalog, lists its relations, binds entities with `relation:` and validates a join on the warehouse', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-runtime-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), amount REAL);
      INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bo');
      INSERT INTO orders VALUES (10, 1, 50), (11, 1, 150), (12, 2, 70);
    `);
    db.close();
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop',
      manifestVersion: 3,
      modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
    }));

    const executor = new QueryExecutor();
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: await response.json() as any };
    };

    // Modeling is available without dbt, and says what to do before a sync.
    const before = await json('/api/modeling/dbt-first');
    expect(before.status).toBe(200);
    expect(before.body.modeling.mode).toBe('warehouse-first');
    expect(before.body.diagnostics.map((item: { message: string }) => item.message).join('\n')).toMatch(/zlens sync warehouse/);

    // Settings → Sync schema reads the catalog as well as Ask's schema metadata.
    const discovery = await json('/api/connections/default/metadata-scope/discovery', { method: 'POST' });
    expect(discovery.body).toMatchObject({ supported: true, scopes: [{ catalogOrDatabase: 'main', schemas: [{ name: 'main' }] }] });
    const synced = await json('/api/connections/default/metadata-scope', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }] }),
    });
    expect(synced.status).toBe(200);
    expect(synced.body.status).toMatchObject({ state: 'ready', relationCount: 2 });
    expect(synced.body.warehouseCatalog).toMatchObject({ relations: 2, connectionId: 'default', warnings: [] });
    expect(existsSync(join(projectRoot, '.dql', 'warehouse-catalog.json'))).toBe(true);
    const status = await json('/api/connections/default/metadata-scope');
    expect(status.body.warehouseCatalog).toMatchObject({ relations: 2, fingerprint: synced.body.warehouseCatalog.fingerprint });

    // The Database browser lists the warehouse relations; their detail comes from the snapshot.
    const inventory = await json('/api/modeling/dbt-first/inventory?physicalOnly=true');
    expect(inventory.status).toBe(200);
    expect(inventory.body.scope).toBe('warehouse_relations');
    expect(inventory.body.items.map((item: { uniqueId: string }) => item.uniqueId).sort()).toEqual(['warehouse.main.customers', 'warehouse.main.orders']);
    const detail = await json('/api/modeling/dbt-first/nodes/warehouse.main.orders');
    expect(detail.body).toMatchObject({ resourceType: 'warehouse', relation: 'main.orders', dqlMeta: { keys: ['order_id'] } });
    expect(detail.body.columns.map((column: { name: string }) => column.name)).toEqual(['order_id', 'customer_id', 'amount']);

    // Modeling authoring writes `relation:` for a warehouse relation.
    const apply = async (change: Record<string, unknown>) => {
      const snapshotId = (await json('/api/modeling/dbt-first')).body.snapshotId;
      const preview = await json('/api/modeling/dbt-first/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change, expectedSnapshotId: snapshotId }) });
      expect(preview.status).toBe(200);
      const applied = await json('/api/modeling/dbt-first/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change, fingerprint: preview.body.fingerprint, expectedSnapshotId: snapshotId }) });
      expect(applied.status).toBe(200);
      return applied.body;
    };
    await apply({ operation: 'upsert_domain', value: { id: 'sales', name: 'Sales', owner: 'sales@shop.test' } });
    await apply({ operation: 'upsert_entity', value: { id: 'order', domain: 'sales', dbtModel: 'warehouse.main.orders' } });
    const applied = await apply({ operation: 'upsert_entity', value: { id: 'customer', domain: 'sales', dbtModel: 'warehouse.main.customers' } });
    expect(applied.modeling.entities['sales::entity::order']).toMatchObject({ dbtUniqueId: 'warehouse.main.orders', relation: 'main.orders', grain: 'order_id' });
    const entityYaml = readFileSync(join(projectRoot, 'domains', 'sales', 'modeling', 'model.dql.yaml'), 'utf-8');
    expect(entityYaml).toContain('relation: main.orders');
    expect(entityYaml).not.toContain('dbt_model');

    // A join is validated by running it on the warehouse, as for dbt models.
    const snapshotId = (await json('/api/modeling/dbt-first')).body.snapshotId;
    const validated = await json('/api/modeling/dbt-first/relationships/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedSnapshotId: snapshotId,
        relationship: { id: 'order_to_customer', domain: 'sales', from: 'sales::entity::order', to: 'sales::entity::customer', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft' },
      }),
    });
    expect(validated.status).toBe(200);
    expect(validated.body.evidence).toMatchObject({ status: 'passed', fromRows: 3, joinedRows: 3, unmatchedFrom: 0 });

    // A person certifies it with that evidence: the compiled join is then
    // automatic for Ask, exactly as a certified dbt join is. The evidence
    // must match the compiler's proof, key types included.
    const certified = await apply({
      operation: 'upsert_relationship',
      value: {
        id: 'order_to_customer', domain: 'sales', from: 'order', to: 'customer',
        keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'certified',
        certifiedAgainst: { from: { grain: 'order_id', keys: ['order_id'] }, to: { grain: 'customer_id', keys: ['customer_id'] } },
        validation: validated.body.evidence,
      },
    });
    expect(certified.modeling.relationships['sales::relationship::order_to_customer']).toMatchObject({
      status: 'certified',
      staleCertification: false,
      automaticJoinAllowed: true,
      keyTypes: [{ from: 'integer', to: 'integer' }],
    });
    expect(certified.diagnostics.map((item: { message: string }) => item.message).join('\n')).not.toMatch(/no longer matches|cannot prove/);

    // The warehouse changes under the model: a re-sync names the drift and
    // what it touches, and the certified join stops being automatic.
    const writer = new Database(join(projectRoot, 'shop.sqlite'));
    writer.exec('ALTER TABLE orders RENAME COLUMN customer_id TO buyer_id; CREATE TABLE returns (return_id INTEGER PRIMARY KEY);');
    writer.close();
    const resynced = await json('/api/connections/default/metadata-sync', { method: 'POST' });
    expect(resynced.status).toBe(200);
    expect(resynced.body.warehouseCatalog.drift).toMatchObject({
      addedRelations: ['main.returns'],
      removedColumns: ['main.orders.customer_id'],
      addedColumns: ['main.orders.buyer_id'],
      affected: ['sales::entity::order', 'sales::relationship::order_to_customer'],
    });
    const afterDrift = (await json('/api/modeling/dbt-first')).body;
    expect(afterDrift.modeling.relationships['sales::relationship::order_to_customer'].automaticJoinAllowed).toBe(false);
    await executor.disconnect();
  }, 60_000);

  it('a sync reads column values only when the project opts in to a value profile, and removes them when it opts out', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-profile-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, status TEXT);
      INSERT INTO customers VALUES (1, 'Ann', 'ann@example.com', 'active'), (2, 'Bo', 'bo@example.com', 'active'), (3, 'Cy', NULL, 'lapsed');
    `);
    db.close();
    const config = (agent?: Record<string, unknown>) => writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
      ...(agent ? { agent } : {}),
    }));
    config();
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), preferredPort: 0, captureServer: (created) => { server = created; } });
    const sync = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/connections/default/metadata-scope`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }] }),
      });
      return await response.json() as { warehouseCatalog?: { relations?: number; valueProfile?: unknown } };
    };
    const profilePath = join(projectRoot, '.dql', 'cache', 'value-profile.json');
    // Setup's rows sentence says when values reach the AI provider (new-user round 2, Q3).
    const valueProfileOn = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json()) as { valueProfile?: boolean }).valueProfile;

    // The default: metadata only, no value read.
    const plain = await sync();
    expect(plain.warehouseCatalog?.relations).toBe(1);
    expect(plain.warehouseCatalog?.valueProfile).toBeUndefined();
    expect(existsSync(profilePath)).toBe(false);
    expect(await valueProfileOn()).toBe(false);

    // Opted in: the values of non-sensitive columns, never the email.
    config({ valueProfile: { mode: 'sampled' } });
    expect(await valueProfileOn()).toBe(true);
    const profiled = await sync();
    expect(profiled.warehouseCatalog?.valueProfile).toMatchObject({ relations: 1, skippedSensitive: 2 });
    const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
    expect(profile.relations['main.customers'].status).toEqual({ examples: ['active', 'lapsed'] });
    // Neither the email nor the customers' names.
    expect(JSON.stringify(profile)).not.toContain('example.com');
    expect(JSON.stringify(profile)).not.toContain('Ann');

    // Opted out again: the next sync removes it.
    config({ valueProfile: { mode: 'off' } });
    await sync();
    expect(existsSync(profilePath)).toBe(false);
    expect(await valueProfileOn()).toBe(false);
  });

  it('drafts the map from the warehouse for review, and adds only the drafts a person keeps', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-discover-runtime-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id));
      CREATE TABLE products (id INTEGER, title TEXT);
      CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER);
      INSERT INTO customers VALUES (1, 'Ann');
      INSERT INTO orders VALUES (10, 1), (11, 1);
      INSERT INTO products VALUES (100, 'x');
      INSERT INTO order_items VALUES (10, 100, 2);
    `);
    db.close();
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
    }));
    const executor = new QueryExecutor();
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, preferredPort: 0, captureServer: (created) => { server = created; } });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };

    // Before a sync there is nothing to draft from, and the error says what to do.
    const early = await post('/api/modeling/warehouse/discover', {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('WAREHOUSE_CATALOG_MISSING');

    const synced = await fetch(`http://127.0.0.1:${port}/api/connections/default/metadata-sync`, { method: 'POST' });
    expect(((await synced.json()) as any).warehouseCatalog).toMatchObject({ relations: 4 });

    const discovered = await post('/api/modeling/warehouse/discover', { validate: true });
    expect(discovered.status).toBe(200);
    const report = discovered.body.report;
    expect(report.validated).toBe(true);
    expect(report.relationships.map((item: { id: string }) => item.id).sort()).toEqual(['order_item_to_order', 'order_item_to_product', 'order_to_customer']);
    expect(report.entities.find((item: { id: string }) => item.id === 'product')).toMatchObject({ grain: 'id', grainSource: 'unique_column' });

    // Keep one join; its two entities come with it, nothing else is written.
    const applied = await post('/api/modeling/warehouse/discover/apply', { validate: true, expectedSnapshotId: discovered.body.snapshotId, relationshipIds: ['order_to_customer'], entityIds: [] });
    expect(applied.status).toBe(200);
    expect(Object.keys(applied.body.modeling.entities).sort()).toEqual(['shop::entity::customer', 'shop::entity::order']);
    expect(applied.body.modeling.relationships['shop::relationship::order_to_customer']).toMatchObject({ status: 'draft', cardinality: 'many_to_one', validation: { status: 'passed' } });

    // A stale review is refused rather than applied over newer sources.
    const stale = await post('/api/modeling/warehouse/discover/apply', { expectedSnapshotId: discovered.body.snapshotId });
    expect(stale.status).toBe(409);

    // Modeling → Draft from warehouse: the rest arrives as an ordinary
    // reviewable proposal, committed through the same path as every other.
    const configBefore = readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8');
    const drafted = await post('/api/modeling/warehouse/discover/proposal', { validate: true });
    expect(drafted.status).toBe(201);
    const proposal = drafted.body.proposal;
    expect(proposal).toMatchObject({ origin: 'warehouse_discovery', trustState: 'review_required' });
    expect(proposal.diagnostics.filter((item: { severity: string }) => item.severity === 'blocking')).toEqual([]);
    const relationshipOps = proposal.operations.filter((operation: any) => operation.change?.operation === 'upsert_relationship');
    expect(relationshipOps.map((operation: any) => operation.change.value.id).sort()).toEqual(['order_item_to_order', 'order_item_to_product']);
    expect(relationshipOps[0].evidence.join(' ')).toMatch(/named for|warehouse check/);
    // Drafting reads; it does not rewrite the project's configuration.
    expect(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')).toBe(configBefore);
    const committed = await post(`/api/context-proposals/${encodeURIComponent(proposal.id)}/commit`, { expectedProposalHash: proposal.proposalHash, idempotencyKey: 'warehouse-draft-1' });
    expect(committed.status).toBe(200);
    const modeling = await (await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first`)).json() as any;
    expect(Object.keys(modeling.modeling.relationships).sort()).toEqual(['shop::relationship::order_item_to_order', 'shop::relationship::order_item_to_product', 'shop::relationship::order_to_customer']);
    expect(modeling.modeling.entities['shop::entity::product']).toMatchObject({ relation: 'main.products', grain: 'id', status: 'draft' });
    // Drafted joins sit in their entity's subject area, where an edit writes them.
    expect(modeling.modeling.relationships['shop::relationship::order_item_to_product'].sourcePath).toBe(modeling.modeling.entities['shop::entity::order_item'].sourcePath);
    expect(modeling.diagnostics.map((item: { message: string }) => item.message).join('\n')).not.toMatch(/duplicate/);
    // Nothing left to draft.
    const again = await post('/api/modeling/warehouse/discover/proposal', {});
    expect(again.body.proposal).toBeNull();

    // Without dbt, metrics are DQL's own: Modeling → New metric writes one the
    // semantic layer loads, and never silently replaces an existing one.
    const metric = { name: 'Units sold', label: 'Units sold', description: 'Quantity: every order line', domain: 'shop', sql: 'quantity', type: 'sum', table: 'main.order_items', ifAbsent: true };
    const created = await post('/api/semantic-layer/metric', metric);
    expect(created.status).toBe(201);
    expect(created.body.path).toBe('semantic-layer/metrics/units_sold.yaml');
    expect((await post('/api/semantic-layer/metric', metric)).status).toBe(409);
    await post('/api/semantic-layer/reload', {});
    const layer = await (await fetch(`http://127.0.0.1:${port}/api/semantic-layer`)).json() as any;
    expect(JSON.stringify(layer)).toContain('units_sold');
    expect(readFileSync(join(projectRoot, 'semantic-layer', 'metrics', 'units_sold.yaml'), 'utf-8')).toContain("description: 'Quantity: every order line'");
    await executor.disconnect();
  }, 60_000);
  // New-user round 2, Q3: a database-only first run in plain words.
  it('drafts one Domain named after the database file, without staging copies, with one grouped note, and keeps the draft until it is saved or discarded', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-run-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'jaffle_shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE stg_customers (customer_id INTEGER, name TEXT);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id));
      CREATE TABLE stg_orders (order_id INTEGER, customer_id INTEGER);
      CREATE TABLE stg_payments (payment_id INTEGER, order_id INTEGER);
      INSERT INTO customers VALUES (1, 'Ann');
      INSERT INTO orders VALUES (10, 1);
    `);
    db.close();
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'sqlite', filepath: './jaffle_shop.sqlite' } },
    }));
    const executor = new QueryExecutor();
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, preferredPort: 0, captureServer: (created) => { server = created; } });
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const waiting = async () => ((await (await fetch(`${base}/api/modeling/warehouse/drafts`)).json()) as any).waiting;
    await fetch(`${base}/api/connections/default/metadata-sync`, { method: 'POST' });
    expect(await waiting()).toBeNull();

    const drafted = await post('/api/modeling/warehouse/discover/proposal', { validate: true });
    expect(drafted.status).toBe(201);
    const { report, proposal } = drafted.body;
    // Named after the file, not the schema "main", and editable later.
    expect(report.domains).toEqual([{ id: 'jaffle_shop', name: 'Jaffle shop', existing: false }]);
    const domainOperation = proposal.operations.find((operation: any) => operation.change?.operation === 'upsert_domain');
    expect(domainOperation.change.value).toMatchObject({ id: 'jaffle_shop', name: 'Jaffle shop' });
    // stg_customers and stg_orders copy a final table; stg_payments is the only copy of payments.
    expect(report.stagingHidden).toEqual([
      { relation: 'main.stg_customers', finalRelation: 'main.customers' },
      { relation: 'main.stg_orders', finalRelation: 'main.orders' },
    ]);
    const bound = proposal.operations.filter((operation: any) => operation.change?.operation === 'upsert_entity').map((operation: any) => operation.change.value.dbtModel).sort();
    expect(bound).toEqual(['warehouse.main.customers', 'warehouse.main.orders', 'warehouse.main.stg_payments']);
    // One plain note for the three tables placed in the default area, with each operation kept for the details.
    const notes = proposal.diagnostics.filter((item: any) => item.code === 'MODEL_AREA_DEFAULTED');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: 'info', message: '3 tables placed in the default area. You can rename or move them later.' });
    expect(notes[0].operationIds).toHaveLength(3);

    // Kept automatically: the draft waits, across reloads, until saved or discarded.
    expect(await waiting()).toMatchObject({ proposalId: proposal.id, models: 3, domains: ['Jaffle shop'], stale: false });

    // "Show staging tables" drafts them too, under a name the person chose, and replaces the first draft.
    const withStaging = await post('/api/modeling/warehouse/discover/proposal', { includeStaging: true, domain: 'Jaffle Shop Sales' });
    expect(withStaging.body.report.stagingHidden).toBeUndefined();
    expect(withStaging.body.report.domains).toEqual([{ id: 'jaffle_shop_sales', name: 'Jaffle Shop Sales', existing: false }]);
    expect(withStaging.body.proposal.operations.filter((operation: any) => operation.change?.operation === 'upsert_entity')).toHaveLength(5);
    expect(await waiting()).toMatchObject({ proposalId: withStaging.body.proposal.id, models: 5 });
    const first = await (await fetch(`${base}/api/context-proposals/${proposal.id}`)).json() as any;
    expect(first.proposal).toMatchObject({ status: 'discarded', supersededBy: withStaging.body.proposal.id });

    // Discard: nothing waits, nothing was written.
    const discarded = await post(`/api/context-proposals/${withStaging.body.proposal.id}/discard`, {});
    expect(discarded.status).toBe(200);
    expect(discarded.body.proposal.status).toBe('discarded');
    expect(await waiting()).toBeNull();
    expect(existsSync(join(projectRoot, 'domains', 'jaffle_shop_sales'))).toBe(false);
    expect((await post('/api/context-proposals/missing-id/discard', {})).status).toBe(404);

    // Save: the saved draft and its older copies stop waiting.
    const again = await post('/api/modeling/warehouse/discover/proposal', { validate: true });
    const committed = await post(`/api/context-proposals/${encodeURIComponent(again.body.proposal.id)}/commit`, { expectedProposalHash: again.body.proposal.proposalHash, idempotencyKey: 'first-run-draft' });
    expect(committed.status).toBe(200);
    expect(await waiting()).toBeNull();
    const modeling = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as any;
    expect(modeling.modeling.packages.jaffle_shop).toMatchObject({ filePath: 'domains/jaffle-shop/domain.dql' });
    expect(readFileSync(join(projectRoot, 'domains', 'jaffle-shop', 'domain.dql'), 'utf-8')).toContain('Jaffle shop');
    expect(Object.keys(modeling.modeling.entities).sort()).toEqual(['jaffle_shop::entity::customer', 'jaffle_shop::entity::order', 'jaffle_shop::entity::payment']);
    await executor.disconnect();
  }, 60_000);
});
