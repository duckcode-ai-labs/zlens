import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest, collectInputFiles, modelingModeOf } from './builder.js';
import { applyModelingChanges, isWarehouseNodeId, loadWarehouseNodeAuthoringDetail, previewModelingChange, previewModelingChanges, type ModelingAuthoringChange } from './dbt-first-authoring.js';
import {
  WAREHOUSE_CATALOG_PATH,
  diffWarehouseCatalogs,
  normalizeWarehouseCatalog,
  readWarehouseCatalog,
  resolveWarehouseRelation,
  warehouseRelationId,
  writeWarehouseCatalog,
  type WarehouseCatalogRelationV1,
} from './warehouse-catalog.js';

const relation = (schema: string, name: string, columns: string[], extra: Partial<WarehouseCatalogRelationV1> = {}): WarehouseCatalogRelationV1 => ({
  id: warehouseRelationId({ database: 'acme', schema, name }),
  database: 'ACME',
  schema,
  name,
  relation: `ACME.${schema}.${name}`,
  kind: 'table',
  columns: columns.map((column) => ({ name: column, type: 'VARCHAR' })),
  ...extra,
});

const CATALOG = {
  version: 1 as const,
  driver: 'snowflake',
  connectionId: 'default',
  scopes: [{ catalogOrDatabase: 'ACME', schemas: ['SALES'] }],
  capturedAt: '2026-09-18T00:00:00.000Z',
  relations: [
    relation('SALES', 'ORDERS', ['ORDER_ID', 'CUSTOMER_ID', 'AMOUNT'], {
      primaryKey: ['ORDER_ID'],
      comment: 'One row per order.',
      foreignKeys: [{ columns: ['CUSTOMER_ID'], references: { relation: 'ACME.SALES.CUSTOMERS', columns: ['CUSTOMER_ID'] } }],
    }),
    relation('SALES', 'CUSTOMERS', ['CUSTOMER_ID', 'NAME'], { primaryKey: ['CUSTOMER_ID'] }),
    relation('ARCHIVE', 'CUSTOMERS', ['CUSTOMER_ID', 'NAME']),
  ],
};

describe('the warehouse catalog snapshot', () => {
  it('is fingerprinted without its capture time, and sorted, so a rebuild is reproducible', () => {
    const a = normalizeWarehouseCatalog(CATALOG);
    const b = normalizeWarehouseCatalog({ ...CATALOG, capturedAt: '2027-01-01T00:00:00.000Z', relations: [...CATALOG.relations].reverse() });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.relations.map((item) => item.id)).toEqual(['warehouse.acme.archive.customers', 'warehouse.acme.sales.customers', 'warehouse.acme.sales.orders']);
    const changed = normalizeWarehouseCatalog({ ...CATALOG, relations: [relation('SALES', 'ORDERS', ['ORDER_ID'])] });
    expect(changed.fingerprint).not.toBe(a.fingerprint);
  });

  it('resolves an authored relation by any qualification, and refuses an ambiguous one', () => {
    expect(resolveWarehouseRelation(CATALOG, 'orders').relation?.id).toBe('warehouse.acme.sales.orders');
    expect(resolveWarehouseRelation(CATALOG, '"ACME"."SALES"."ORDERS"').relation?.id).toBe('warehouse.acme.sales.orders');
    expect(resolveWarehouseRelation(CATALOG, 'customers').ambiguous).toHaveLength(2);
    expect(resolveWarehouseRelation(CATALOG, 'sales.customers').relation?.id).toBe('warehouse.acme.sales.customers');
    expect(resolveWarehouseRelation(CATALOG, 'missing').relation).toBeUndefined();
    // The stable id resolves too: authoring tools pass it.
    expect(resolveWarehouseRelation(CATALOG, 'warehouse.acme.archive.customers').relation?.relation).toBe('ACME.ARCHIVE.CUSTOMERS');
  });
});

describe('warehouse catalog drift', () => {
  it('names added and removed relations and columns, and type changes', () => {
    const next = {
      relations: [
        relation('SALES', 'ORDERS', ['ORDER_ID', 'CUSTOMER_ID', 'CHANNEL'], { columns: [{ name: 'ORDER_ID', type: 'NUMBER' }, { name: 'CUSTOMER_ID', type: 'VARCHAR' }, { name: 'CHANNEL', type: 'VARCHAR' }] }),
        relation('SALES', 'CUSTOMERS', ['CUSTOMER_ID', 'NAME']),
        relation('SALES', 'RETURNS', ['RETURN_ID']),
      ],
    };
    const previous = { relations: CATALOG.relations.map((item) => item.name === 'ORDERS' ? { ...item, columns: [{ name: 'ORDER_ID', type: 'NUMBER' }, { name: 'CUSTOMER_ID', type: 'NUMBER' }, { name: 'AMOUNT', type: 'NUMBER' }] } : item) };
    const drift = diffWarehouseCatalogs(previous, next);
    expect(drift).toEqual({
      addedRelations: ['ACME.SALES.RETURNS'],
      removedRelations: ['ACME.ARCHIVE.CUSTOMERS'],
      addedColumns: ['ACME.SALES.ORDERS.CHANNEL'],
      removedColumns: ['ACME.SALES.ORDERS.AMOUNT'],
      changedColumnTypes: ['ACME.SALES.ORDERS.CUSTOMER_ID: NUMBER → VARCHAR'],
      changedRelationIds: ['warehouse.acme.archive.customers', 'warehouse.acme.sales.orders'],
    });
    expect(diffWarehouseCatalogs(undefined, next).changedRelationIds).toEqual([]);
  });
});

describe('warehouse-first modeling (RFC 0007)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-first-'));
    writeProject(projectRoot, 'warehouse-first');
    writeWarehouseCatalog(projectRoot, CATALOG);
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('binds entities to warehouse relations, validates relationship keys against their columns, and is reproducible', () => {
    const manifest = buildManifest({ projectRoot });
    expect(manifest.manifestVersion).toBe(3);
    expect(manifest.modeling?.mode).toBe('warehouse-first');
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    expect(manifest.dbtProvenance?.nodes['warehouse.acme.sales.orders']).toMatchObject({ resourceType: 'warehouse', relation: 'ACME.SALES.ORDERS', name: 'ORDERS' });
    expect(manifest.dbtProvenance?.warehouseCatalogPath).toBe(WAREHOUSE_CATALOG_PATH);
    expect(manifest.modeling?.entities['sales::entity::order']).toMatchObject({
      dbtUniqueId: 'warehouse.acme.sales.orders',
      relation: 'SALES.ORDERS',
      // The declared primary key is the grain and key when the author states none.
      grain: 'ORDER_ID',
      keys: ['ORDER_ID'],
    });
    expect(manifest.modeling?.relationships['sales::relationship::order_to_customer']).toMatchObject({ status: 'draft', cardinality: 'many_to_one' });
    expect(manifest).toEqual(buildManifest({ projectRoot }));
    expect(collectInputFiles({ projectRoot })).toContain(join(projectRoot, WAREHOUSE_CATALOG_PATH));
    // The knowledge graph records a warehouse relation as a source table the entity binds to.
    const graph = JSON.stringify(manifest.knowledgeGraph);
    expect(graph).toContain('warehouse::warehouse.acme.sales.orders');
  });

  it('models a thing called `constructor`, or any other JavaScript built-in name', () => {
    // Formula 1 has a constructors table. A plain lookup handed back
    // JavaScript's own `Object.constructor` instead of undefined, so the
    // relationship passed the "unknown entity" guard and then failed to
    // compile: every question about that project was answered "blocked".
    writeWarehouseCatalog(projectRoot, {
      ...CATALOG,
      relations: [...CATALOG.relations, relation('SALES', 'CONSTRUCTORS', ['CONSTRUCTOR_ID', 'NAME'], { primaryKey: ['CONSTRUCTOR_ID'] }), relation('SALES', 'RESULTS', ['RESULT_ID', 'CONSTRUCTOR_ID'], { primaryKey: ['RESULT_ID'] })],
    });
    writeYaml(projectRoot, 'domains/sales/modeling/f1.dql.yaml', `entities:
  - id: constructor
    relation: SALES.CONSTRUCTORS
  - id: toString
    relation: SALES.RESULTS
relationships:
  - id: result_to_constructor
    from: toString
    to: constructor
    keys: [{ from: CONSTRUCTOR_ID, to: CONSTRUCTOR_ID }]
    cardinality: many_to_one
    fanout: safe
    status: draft
`);
    const manifest = buildManifest({ projectRoot });
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    expect(manifest.modeling?.entities['sales::entity::constructor']).toMatchObject({ dbtUniqueId: 'warehouse.acme.sales.constructors', keys: ['CONSTRUCTOR_ID'] });
    expect(manifest.modeling?.relationships['sales::relationship::result_to_constructor']).toMatchObject({
      from: 'sales::entity::toString',
      to: 'sales::entity::constructor',
      cardinality: 'many_to_one',
    });
  });

  it('keeps a reviewed status, and names a status it does not know instead of reading it as draft', () => {
    writeYaml(projectRoot, 'domains/sales/modeling/entities.dql.yaml', `entities:
  - id: order
    relation: SALES.ORDERS
    status: reviewed
  - id: customer
    relation: sales.customers
    status: approved
`);
    const manifest = buildManifest({ projectRoot });
    expect(manifest.modeling?.entities['sales::entity::order']?.status).toBe('reviewed');
    const errors = (manifest.diagnostics ?? []).filter((item) => item.severity === 'error').map((item) => item.message);
    expect(errors).toEqual(['entity "customer" has status "approved", which ZLens does not recognise (it would be read as draft); use one of draft, evaluated, reviewed, certified, deprecated']);
  });

  it('warns when passed evidence shows the join loses more rows than allowed, and keeps the declared threshold and scope in the proof', () => {
    const evidence = `    validation:
      status: passed
      checked_at: '2026-09-01T00:00:00.000Z'
      query_fingerprint: legacy
      from_rows: 100
      to_rows: 10
      joined_rows: 70
      from_null_keys: 0
      to_null_keys: 0
      unmatched_from: 30
      max_from_per_key: 10
      max_to_per_key: 1
`;
    const relationship = (extra: string) => `relationships:
  - id: order_to_customer
    from: order
    to: customer
    keys: [{ from: CUSTOMER_ID, to: CUSTOMER_ID }]
    cardinality: many_to_one
    fanout: safe
    status: draft
${extra}${evidence}`;
    writeYaml(projectRoot, 'domains/sales/modeling/relationships.dql.yaml', relationship(''));
    const legacy = buildManifest({ projectRoot });
    const warning = (legacy.diagnostics ?? []).find((item) => /loses|find no "to" row/.test(item.message));
    expect(warning).toMatchObject({ severity: 'warning' });
    expect(warning?.message).toMatch(/30 of 100 "from" rows with a key \(30%\) find no "to" row, more than the 5% allowed/);

    // A person who expects the gap declares it; the warning goes and the proof changes.
    writeYaml(projectRoot, 'domains/sales/modeling/relationships.dql.yaml', relationship('    max_unmatched_share: 0.4\n    validation_scope: referenced_keys\n'));
    const declared = buildManifest({ projectRoot });
    expect((declared.diagnostics ?? []).some((item) => /find no "to" row/.test(item.message))).toBe(false);
    const declaredRelationship = declared.modeling?.relationships['sales::relationship::order_to_customer'];
    expect(declaredRelationship).toMatchObject({ maxUnmatchedShare: 0.4, validationScope: 'referenced_keys' });

    writeYaml(projectRoot, 'domains/sales/modeling/relationships.dql.yaml', relationship('    max_unmatched_share: 40%\n    validation_scope: some_rows\n'));
    const invalid = (buildManifest({ projectRoot }).diagnostics ?? []).filter((item) => item.severity === 'error').map((item) => item.message);
    expect(invalid).toEqual(expect.arrayContaining([
      expect.stringMatching(/max_unmatched_share must be a number from 0 to 1/),
      expect.stringMatching(/validation_scope must be "referenced_keys"/),
    ]));
  });

  it('writes the threshold, the scope and the new evidence counts back as authored', () => {
    const patch = previewModelingChange(projectRoot, {
      operation: 'upsert_relationship',
      value: {
        id: 'order_to_customer', domain: 'sales', from: 'order', to: 'customer', keys: [{ from: 'CUSTOMER_ID', to: 'CUSTOMER_ID' }],
        cardinality: 'many_to_one', fanout: 'safe', status: 'draft', maxUnmatchedShare: 0.1, validationScope: 'referenced_keys',
        validation: { status: 'passed', checkedAt: '2026-09-23T00:00:00.000Z', queryFingerprint: 'q', fromRows: 10, toRows: 5, joinedRows: 9, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 1, maxFromPerKey: 3, maxToPerKey: 2, unmatchedKeyedFrom: 1, unmatchedKeyValues: 1, unmatchedShare: 0.1, maxUnmatchedShare: 0.1, maxToPerReferencedKey: 1, maxFromPerReferencedKey: 3, scope: 'referenced_keys' },
      },
    });
    const written = patch.patches.map((item) => item.after).join('\n');
    for (const line of ['max_unmatched_share: 0.1', 'validation_scope: referenced_keys', 'unmatched_keyed_from: 1', 'unmatched_key_values: 1', 'max_to_per_referenced_key: 1', 'scope: referenced_keys']) expect(written).toContain(line);
  });

  it('names an unknown or ambiguous relation, and a missing snapshot, in plain words', () => {
    writeYaml(projectRoot, 'domains/sales/modeling/more.dql.yaml', `entities:
  - id: archived_customer
    relation: customers
  - id: ghost
    relation: sales.ghosts
  - id: both
    relation: sales.orders
    dbt_model: model.x.orders
`);
    const messages = (buildManifest({ projectRoot }).diagnostics ?? []).map((item) => item.message).join('\n');
    expect(messages).toMatch(/relation "customers" matches 2 warehouse relations/);
    expect(messages).toMatch(/unknown warehouse relation "sales.ghosts"/);
    expect(messages).toMatch(/exactly one of `dbt_model` or `relation`/);
    rmSync(join(projectRoot, WAREHOUSE_CATALOG_PATH));
    const missing = (buildManifest({ projectRoot }).diagnostics ?? []).map((item) => item.message).join('\n');
    expect(missing).toMatch(/run `zlens sync warehouse`/);
  });

  it('a dbt-first project that authors `relation:` gets a clear message and no warehouse binding', () => {
    writeProject(projectRoot, 'dbt-first');
    const dbtManifestPath = join(projectRoot, 'target', 'manifest.json');
    mkdirSync(dirname(dbtManifestPath), { recursive: true });
    writeFileSync(dbtManifestPath, JSON.stringify({ metadata: { project_name: 'acme' }, nodes: {}, sources: {} }));
    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    const messages = (manifest.diagnostics ?? []).map((item) => item.message).join('\n');
    expect(messages).toMatch(/uses `relation:`, which needs `modeling.mode` "warehouse-first" or "hybrid"/);
    expect(manifest.dbtProvenance?.nodes?.['warehouse.acme.sales.orders']).toBeUndefined();
  });

  it('reports the active mode only with manifest v3', () => {
    expect(modelingModeOf({ manifestVersion: 3, modeling: { mode: 'warehouse-first' } })).toBe('warehouse-first');
    expect(modelingModeOf({ manifestVersion: 3, modeling: { mode: 'hybrid' } })).toBe('hybrid');
    expect(modelingModeOf({ manifestVersion: 3, modeling: { mode: 'dbt-first' } })).toBe('dbt-first');
    expect(modelingModeOf({ manifestVersion: 2, modeling: { mode: 'warehouse-first' } })).toBeUndefined();
    expect(modelingModeOf({})).toBeUndefined();
  });

  it('follows from what the project has when no mode is written (simplification plan Z2)', () => {
    const dbt = { manifestVersion: 3, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' }, connections: { default: {} } };
    expect(modelingModeOf(dbt)).toBe('dbt-first');
    expect(modelingModeOf({ manifestVersion: 3, semanticLayer: { provider: 'dbt' } })).toBe('dbt-first');
    expect(modelingModeOf({ ...dbt, metadataScopes: { default: { mode: 'dbt_relations' } } })).toBe('dbt-first');
    expect(modelingModeOf({ ...dbt, metadataScopes: { default: { mode: 'dbt_plus_selected' } } })).toBe('hybrid');
    expect(modelingModeOf({ manifestVersion: 3, connections: { default: {} } })).toBe('warehouse-first');
    expect(modelingModeOf({ manifestVersion: 3, metadataScopes: { default: { mode: 'selected_scopes' } } })).toBe('warehouse-first');
    expect(modelingModeOf({ manifestVersion: 3 })).toBeUndefined();
    // A written mode wins: a project that chose one keeps it.
    expect(modelingModeOf({ ...dbt, modeling: { mode: 'dbt-first' }, metadataScopes: { default: { mode: 'dbt_plus_selected' } } })).toBe('dbt-first');
    expect(modelingModeOf({ ...dbt, modeling: { mode: 'warehouse-first' } })).toBe('warehouse-first');
    // Manifest v3 is still opted into.
    expect(modelingModeOf({ ...dbt, manifestVersion: 2 })).toBeUndefined();
  });

  it('authors a warehouse relation as `relation:` and describes it from the snapshot', () => {
    expect(isWarehouseNodeId('warehouse.acme.sales.orders')).toBe(true);
    expect(isWarehouseNodeId('model.acme.orders')).toBe(false);
    const preview = previewModelingChange(projectRoot, { operation: 'upsert_entity', value: { id: 'archived_customer', domain: 'sales', dbtModel: 'warehouse.acme.archive.customers' } });
    const after = preview.patches.map((patch) => patch.after).join('\n');
    expect(after).toContain('relation: ACME.ARCHIVE.CUSTOMERS');
    expect(after).not.toContain('dbt_model: warehouse.');
    const dbtPreview = previewModelingChange(projectRoot, { operation: 'upsert_entity', value: { id: 'shipment', domain: 'sales', dbtModel: 'model.acme.shipments' } });
    expect(dbtPreview.patches.map((patch) => patch.after).join('\n')).toContain('dbt_model: model.acme.shipments');
    expect(loadWarehouseNodeAuthoringDetail(projectRoot, 'warehouse.acme.sales.orders')).toMatchObject({
      resourceType: 'warehouse',
      relation: 'ACME.SALES.ORDERS',
      description: 'One row per order.',
      dqlMeta: { keys: ['ORDER_ID'] },
      columns: [{ name: 'ORDER_ID', type: 'VARCHAR', tests: [] }, { name: 'CUSTOMER_ID', type: 'VARCHAR', tests: [] }, { name: 'AMOUNT', type: 'VARCHAR', tests: [] }],
    });
    expect(loadWarehouseNodeAuthoringDetail(projectRoot, 'warehouse.acme.sales.missing')).toBeUndefined();
  });

  it('writes the snapshot where the builder reads it', () => {
    expect(readWarehouseCatalog(projectRoot).snapshot?.relations).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(projectRoot, WAREHOUSE_CATALOG_PATH), 'utf-8')).fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  // Launch blocker: discovery drafts a join into modeling/model.dql.yaml (here
  // the legacy relationships.dql.yaml); certifying it on the Modeling page
  // writes it to the subject area (areas/core.dql.yaml). The draft stayed
  // behind and `zlens model validate` failed with a duplicate relationship.
  it('certifying a drafted join into a subject area moves it there, and the model stays valid', () => {
    writeYaml(projectRoot, 'domains/sales/modeling/relationships.dql.yaml', `relationships:
  - id: order_to_customer
    from: order
    to: customer
    keys: [{ from: CUSTOMER_ID, to: CUSTOMER_ID }]
    cardinality: many_to_one
    fanout: safe
    status: draft
    description: Each order is placed by one customer.
  - id: order_to_archive_customer
    from: order
    to: customer
    keys: [{ from: CUSTOMER_ID, to: CUSTOMER_ID }]
    cardinality: many_to_one
    fanout: safe
    status: draft
`);
    const changes: ModelingAuthoringChange[] = [
      { operation: 'upsert_area', value: { id: 'core', domain: 'sales', name: 'Core models' } },
      { operation: 'upsert_relationship', value: {
        id: 'order_to_customer', domain: 'sales', areaId: 'core', from: 'sales::entity::order', to: 'sales::entity::customer',
        keys: [{ from: 'CUSTOMER_ID', to: 'CUSTOMER_ID' }], cardinality: 'many_to_one', fanout: 'safe', status: 'certified',
        certifiedAgainst: { from: { grain: 'ORDER_ID', keys: ['ORDER_ID'] }, to: { grain: 'CUSTOMER_ID', keys: ['CUSTOMER_ID'] } },
      } },
    ];
    const preview = previewModelingChanges(projectRoot, changes);
    expect(preview.patches.map((patch) => patch.path)).toEqual(['domains/sales/modeling/areas/core.dql.yaml', 'domains/sales/modeling/relationships.dql.yaml']);
    applyModelingChanges(projectRoot, changes, preview.fingerprint);

    const drafts = readFileSync(join(projectRoot, 'domains/sales/modeling/relationships.dql.yaml'), 'utf8');
    expect(drafts).not.toContain('id: order_to_customer\n');
    expect(drafts).toContain('id: order_to_archive_customer');
    const area = readFileSync(join(projectRoot, 'domains/sales/modeling/areas/core.dql.yaml'), 'utf8');
    // The draft's fields the editor does not set travel with it.
    expect(area).toContain('description: Each order is placed by one customer.');
    expect(area).toContain('status: certified');

    const manifest = buildManifest({ projectRoot });
    expect((manifest.diagnostics ?? []).filter((item) => item.severity === 'error').map((item) => item.message)).toEqual([]);
    expect(manifest.modeling?.relationships['sales::relationship::order_to_customer']).toMatchObject({ status: 'certified', sourcePath: 'domains/sales/modeling/areas/core.dql.yaml' });

    // Editing it again in its area is an in-place update, not a second move.
    const again = previewModelingChange(projectRoot, changes[1]!);
    expect(again.patches.filter((patch) => patch.changed).map((patch) => patch.path)).toEqual([]);
  });

  it('an entity edited into a subject area moves there instead of being declared twice', () => {
    mkdirSync(join(projectRoot, 'domains/sales/modeling/areas'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains/sales/modeling/areas/core.dql.yaml'), 'domain: sales\narea:\n  id: core\n  name: Core models\n');
    const change: ModelingAuthoringChange = { operation: 'upsert_entity', value: { id: 'order', domain: 'sales', areaId: 'core', dbtModel: 'warehouse.acme.sales.orders', grain: 'ORDER_ID', keys: ['ORDER_ID'] } };
    const preview = previewModelingChanges(projectRoot, [change]);
    applyModelingChanges(projectRoot, [change], preview.fingerprint);
    expect(readFileSync(join(projectRoot, 'domains/sales/modeling/entities.dql.yaml'), 'utf8')).not.toContain('id: order\n');
    const manifest = buildManifest({ projectRoot });
    expect((manifest.diagnostics ?? []).filter((item) => item.severity === 'error').map((item) => item.message)).toEqual([]);
    expect(manifest.modeling?.entities['sales::entity::order']).toMatchObject({ grain: 'ORDER_ID' });
  });
});

function writeProject(projectRoot: string, mode: 'dbt-first' | 'warehouse-first'): void {
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'acme', manifestVersion: 3, modeling: { mode } }));
  writeYaml(projectRoot, 'domains/sales/domain.dql', `domain "Sales" {
  id = "sales"
  owner = "sales@company.test"
}
`);
  writeYaml(projectRoot, 'domains/sales/modeling/entities.dql.yaml', `entities:
  - id: order
    relation: SALES.ORDERS
  - id: customer
    relation: sales.customers
    business_name: Customer
`);
  writeYaml(projectRoot, 'domains/sales/modeling/relationships.dql.yaml', `relationships:
  - id: order_to_customer
    from: order
    to: customer
    keys: [{ from: CUSTOMER_ID, to: CUSTOMER_ID }]
    cardinality: many_to_one
    fanout: safe
    status: draft
`);
}

function writeYaml(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
