import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDbtSourcePatch, applyModelingChange, dbtArtifactReadCount, loadDbtNodeAuthoringDetail, previewDbtSourcePatch, previewModelingChange, resetDbtArtifactReadCount } from './dbt-first-authoring.js';

describe('dbt-first Domain Package authoring', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-authoring-'));
    mkdirSync(join(root, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" { id = "commerce" owner = "data@example.com" }\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('previews and applies a deterministic entity binding without copying dbt schema', () => {
    const change = {
      operation: 'upsert_entity' as const,
      value: { id: 'order', domain: 'commerce', dbtModel: 'model.shop.orders', grain: 'order_id', keys: ['order_id'] },
    };
    const preview = previewModelingChange(root, change);
    expect(preview.patches[0]).toMatchObject({ path: 'domains/commerce/modeling/model.dql.yaml', changed: true });
    expect(preview.patches[0]?.after).toContain('dbt_model: model.shop.orders');
    expect(preview.patches[0]?.after).not.toContain('columns:');

    applyModelingChange(root, change, preview.fingerprint);
    const rebuilt = previewModelingChange(root, change);
    expect(rebuilt.patches[0]?.changed).toBe(false);
  });

  it('writes a drafted table pick as use_instead (RFC 0012)', () => {
    const change = {
      operation: 'upsert_entity' as const,
      value: { id: 'old_order', domain: 'commerce', dbtModel: 'model.shop.old_orders', status: 'draft' as const, useInstead: { entity: 'order', reason: 'covers year 2019–2021; orders covers year 2015–2024' } },
    };
    const after = previewModelingChange(root, change).patches[0]?.after ?? '';
    expect(after).toContain('use_instead:\n      entity: order\n      reason: covers year 2019–2021; orders covers year 2015–2024');
  });

it('removes an authored entity, leaving the domain source intact', () => {
    // Modeling authoring was upsert-only: an entity added by mistake could only
    // be removed by hand-editing YAML.
    const add = (id: string) => {
      const change = { operation: 'upsert_entity' as const, value: { id, domain: 'commerce', dbtModel: `model.shop.${id}s` } };
      applyModelingChange(root, change, previewModelingChange(root, change).fingerprint);
    };
    add('order');
    add('customer');

    const remove = { operation: 'remove_entity' as const, value: { id: 'order', domain: 'commerce' } };
    const preview = previewModelingChange(root, remove);
    expect(preview.patches[0]).toMatchObject({ path: 'domains/commerce/modeling/model.dql.yaml', changed: true });
    applyModelingChange(root, remove, preview.fingerprint);

    const after = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'model.dql.yaml'), 'utf8');
    expect(after).not.toContain('id: order');
    // The sibling must survive — removing one entry is not a file wipe.
    expect(after).toContain('id: customer');

    // Removing something already gone is a no-op, not a crash or a phantom diff.
    expect(previewModelingChange(root, remove).patches[0]?.changed).toBe(false);
  });

  it('removes an authored relationship by id', () => {
    for (const id of ['order', 'customer']) {
      const change = { operation: 'upsert_entity' as const, value: { id, domain: 'commerce', dbtModel: `model.shop.${id}s` } };
      applyModelingChange(root, change, previewModelingChange(root, change).fingerprint);
    }
    const rel = {
      operation: 'upsert_relationship' as const,
      value: { id: 'order_customer', domain: 'commerce', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'customer_id' }] },
    };
    applyModelingChange(root, rel, previewModelingChange(root, rel).fingerprint);

    const remove = { operation: 'remove_relationship' as const, value: { id: 'order_customer', domain: 'commerce' } };
    const preview = previewModelingChange(root, remove);
    expect(preview.patches[0]?.changed).toBe(true);
    applyModelingChange(root, remove, preview.fingerprint);
    expect(readFileSync(join(root, 'domains', 'commerce', 'modeling', 'model.dql.yaml'), 'utf8')).not.toContain('id: order_customer');
  });

  it('refuses to delete a model area that still owns objects', () => {
    mkdirSync(join(root, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    writeFileSync(
      join(root, 'domains', 'commerce', 'modeling', 'areas', 'acquisition.dql.yaml'),
      'domain: commerce\narea:\n  id: acquisition\n  name: Acquisition\nentities:\n  - id: lead\n    dbt_model: model.shop.leads\n',
    );
    // An area OWNS its entities (same file), so deleting it would silently take
    // them with it. Refuse and make the user clear it first.
    expect(() => previewModelingChange(root, { operation: 'remove_area', value: { id: 'acquisition', domain: 'commerce' } }))
      .toThrow(/still owns 1 entity/);
  });

  it('deletes an empty model area file', () => {
    mkdirSync(join(root, 'domains', 'commerce', 'modeling', 'areas'), { recursive: true });
    const areaPath = join(root, 'domains', 'commerce', 'modeling', 'areas', 'acquisition.dql.yaml');
    writeFileSync(areaPath, 'domain: commerce\narea:\n  id: acquisition\n  name: Acquisition\nentities: []\nrelationships: []\n');
    const remove = { operation: 'remove_area' as const, value: { id: 'acquisition', domain: 'commerce' } };
    const preview = previewModelingChange(root, remove);
    expect(preview.patches[0]?.changed).toBe(true);
    applyModelingChange(root, remove, preview.fingerprint);
    expect(existsSync(areaPath)).toBe(false);
  });

  it('rejects an apply when source changed after preview', () => {
    const change = { operation: 'upsert_domain' as const, value: { id: 'growth', name: 'Growth', exports: [] } };
    const preview = previewModelingChange(root, change);
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]?.path).toBe('domains/growth/domain.dql');
    mkdirSync(join(root, 'domains', 'growth'), { recursive: true });
    writeFileSync(join(root, 'domains', 'growth', 'domain.dql'), 'domain "Growth" { id = "growth" owner = "someone@example.com" }\n');
    expect(() => applyModelingChange(root, change, preview.fingerprint)).toThrow(/changed after the preview/);
  });

  it('persists relationship validation evidence in the sparse overlay', () => {
    const change = {
      operation: 'upsert_relationship' as const,
      value: {
        id: 'order_to_customer', domain: 'commerce', from: 'order', to: 'customer',
        keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one' as const,
        fanout: 'safe' as const, status: 'certified' as const,
        validation: {
          status: 'passed' as const, checkedAt: '2026-07-11T00:00:00.000Z', queryFingerprint: 'proof',
          fromRows: 10, toRows: 5, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0,
          unmatchedFrom: 0, maxFromPerKey: 3, maxToPerKey: 1,
        },
      },
    };
    applyModelingChange(root, change);
    const source = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'model.dql.yaml'), 'utf8');
    expect(source).toContain('query_fingerprint: proof');
    expect(source).toContain('max_to_per_key: 1');
  });

  it('edits an existing split source in place during compatibility migration', () => {
    const modeling = join(root, 'domains', 'commerce', 'modeling');
    mkdirSync(modeling, { recursive: true });
    writeFileSync(join(modeling, 'entities.dql.yaml'), 'entities:\n  - id: order\n    dbt_model: model.shop.old_orders\n');
    const preview = previewModelingChange(root, {
      operation: 'upsert_entity',
      value: { id: 'order', domain: 'commerce', dbtModel: 'model.shop.orders' },
    });
    expect(preview.patches[0]?.path).toBe('domains/commerce/modeling/entities.dql.yaml');
  });

  it('keeps a focused model area as one Git-backed source file', () => {
    const area = {
      operation: 'upsert_area' as const,
      value: {
        id: 'customer_lifecycle', domain: 'commerce', name: 'Customer lifecycle',
        description: 'How customers progress from first order to repeat purchase.',
        intentExamples: ['Which customers made a second purchase?'],
        references: ['customer'],
      },
    };
    const areaPreview = previewModelingChange(root, area);
    expect(areaPreview.patches[0]?.path).toBe('domains/commerce/modeling/areas/customer_lifecycle.dql.yaml');
    applyModelingChange(root, area, areaPreview.fingerprint);

    const entity = {
      operation: 'upsert_entity' as const,
      value: {
        id: 'lifecycle_order', domain: 'commerce', areaId: 'customer_lifecycle', dbtModel: 'model.shop.orders',
        businessName: 'Customer order', businessContext: 'An order used to understand repeat purchasing.',
        conceptRefs: ['customer_lifecycle'], analyticalRole: 'event' as const, owner: 'commerce@example.com',
      },
    };
    const entityPreview = previewModelingChange(root, entity);
    expect(entityPreview.patches[0]?.path).toBe('domains/commerce/modeling/areas/customer_lifecycle.dql.yaml');
    applyModelingChange(root, entity, entityPreview.fingerprint);

    const source = readFileSync(join(root, 'domains', 'commerce', 'modeling', 'areas', 'customer_lifecycle.dql.yaml'), 'utf8');
    expect(source).toContain('business_name: Customer order');
    expect(source).toContain('intent_examples:');
    expect(source).toContain('references:');
  });

  it('attaches dbt generic test constraints to their columns', () => {
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', columns: { order_id: {} } },
        'test.shop.unique_orders_order_id': { unique_id: 'test.shop.unique_orders_order_id', resource_type: 'test', name: 'unique_orders_order_id', column_name: 'order_id', test_metadata: { name: 'unique', kwargs: { column_name: 'order_id' } } },
        'test.shop.not_null_orders_order_id': { unique_id: 'test.shop.not_null_orders_order_id', resource_type: 'test', name: 'not_null_orders_order_id', column_name: 'order_id', test_metadata: { name: 'not_null', kwargs: { column_name: 'order_id' } } },
      },
      sources: {},
      child_map: { 'model.shop.orders': ['test.shop.unique_orders_order_id', 'test.shop.not_null_orders_order_id'] },
    }));
    const detail = loadDbtNodeAuthoringDetail(join(target, 'manifest.json'), 'model.shop.orders');
    expect(detail?.columns[0]?.tests).toEqual(['not_null', 'unique']);
    resetDbtArtifactReadCount();
    loadDbtNodeAuthoringDetail(join(target, 'manifest.json'), 'model.shop.orders');
    expect(dbtArtifactReadCount()).toBe(0);
  });

  it('previews and applies dbt-owned descriptions/tests to dbt YAML only', () => {
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'orders.yml'), 'version: 2\nmodels:\n  - name: orders\n    description: Old description\n');
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({
      nodes: {
        'model.shop.orders': {
          unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders',
          patch_path: 'shop://models/orders.yml', original_file_path: 'models/orders.sql',
        },
      },
      sources: {},
    }));
    const input = {
      uniqueId: 'model.shop.orders',
      description: 'One row per order.',
      columns: [{ name: 'order_id', description: 'Order key.', tests: ['unique', 'not_null'] }],
    };
    const preview = previewDbtSourcePatch(root, join(target, 'manifest.json'), input);
    expect(preview.patch.path).toBe('models/orders.yml');
    expect(preview.patch.after).toContain('description: One row per order.');
    expect(preview.patch.after).toContain('data_tests:');
    applyDbtSourcePatch(root, join(target, 'manifest.json'), input, preview.fingerprint);
    expect(readFileSync(join(root, 'models', 'orders.yml'), 'utf8')).toBe(preview.patch.after);
    expect(() => applyDbtSourcePatch(root, join(target, 'manifest.json'), { ...input, description: 'Changed' }, preview.fingerprint)).toThrow(/changed after the preview/);
  });

  it('rejects Domain Package writes redirected through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dql-authoring-outside-'));
    writeFileSync(join(outside, 'domain.dql'), 'domain "Commerce" { id = "commerce" }\n');
    rmSync(join(root, 'domains', 'commerce'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'domains', 'commerce'), 'dir');
    try {
      expect(() => previewModelingChange(root, {
        operation: 'upsert_domain',
        value: { id: 'commerce', name: 'Commerce' },
      })).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects dbt source patches redirected through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dql-dbt-source-outside-'));
    rmSync(join(root, 'models'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'models'), 'dir');
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
      nodes: { 'model.shop.orders': { resource_type: 'model', name: 'orders', patch_path: 'shop://models/orders.yml' } },
      sources: {},
    }));
    try {
      expect(() => previewDbtSourcePatch(root, join(root, 'target', 'manifest.json'), {
        uniqueId: 'model.shop.orders', description: 'Unsafe redirect',
      })).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('concept authoring (A-005)', () => {
  it('previews an upsert_concept as a concepts.dql.yaml list entry and refuses a concept with no binding', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'dql-concept-'));
    mkdirSync(join(root, 'domains', 'commerce', 'modeling'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n}\n');
    const { previewModelingChange } = await import('./dbt-first-authoring.js');
    const preview = previewModelingChange(root, { operation: 'upsert_concept', value: { id: 'customer', domain: 'commerce', name: 'Customer', bindings: [{ entity: 'customer', role: 'canonical', grain: 'customer_id' }, { entity: 'growth:acquisition' }], rule: 'Reconcile on customer_id.', origin: 'ai_draft', status: 'draft' } });
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]!.path).toMatch(/domains\/commerce\/modeling\/(concepts|model)\.dql\.yaml$/);
    expect(preview.patches[0]!.after).toContain('id: customer');
    expect(preview.patches[0]!.after).toContain('role: canonical');
    expect(preview.patches[0]!.after).toContain('origin: ai_draft');
    expect(() => previewModelingChange(root, { operation: 'upsert_concept', value: { id: 'empty', domain: 'commerce', bindings: [] } })).toThrow(/at least one entity binding/);
  });
});
