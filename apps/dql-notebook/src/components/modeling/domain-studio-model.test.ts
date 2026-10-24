import { describe, expect, it } from 'vitest';
import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@zlens/core';
import { DOMAIN_STUDIO_NAVIGATION, domainPackageTree, domainStudioLocationHref, entityRecords, isDescriptiveOnlyChange, isDomainStudioSection, modelingThreadScope, normalizeDomainStudioSection, parseDomainStudioLocation, resolveDomainStudioLocation, resolveEntityRecordKey, withoutDomainStudioLocationHref } from './domain-studio-model';

function entity(domain: string, localId: string): ManifestModelEntity {
  return {
    id: `${domain}::entity::${localId}`,
    localId,
    qualifiedId: `${domain}::entity::${localId}`,
    domain,
    dbtUniqueId: `model.fixture.${domain}_${localId}`,
    keys: [],
    sourcePath: `domains/${domain}/modeling/entities.dql.yaml`,
    identityFingerprint: `${domain}-${localId}`,
  };
}

function modeling(entities: Record<string, ManifestModelEntity>): Pick<ManifestDbtFirstModeling, 'entities'> {
  return { entities };
}

describe('Domain Studio navigation', () => {
  it('has one tab per thing Ask reads, plus where the domain is used', () => {
    // `05-domain-studio-ui.md`. Modeling AI is deliberately absent: it is an
    // action on the canvas that docks beside the diagram it edits.
    expect(DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items.map((item) => item.label))).toEqual([
      'Map',
      'Terms & concepts',
      'Skills',
      'Saved queries',
      'Used by',
    ]);
    for (const id of ['diagram', 'terms', 'skills', 'blocks', 'used_by']) expect(isDomainStudioSection(id)).toBe(true);
    // Removed sections are not tabs.
    for (const id of ['ai', 'overview', 'knowledge', 'join-proofs', 'contracts', 'notebooks', 'apps']) expect(isDomainStudioSection(id)).toBe(false);
  });

  it('sends old Notebooks and Apps links to Used by and anything unknown to the map', () => {
    expect(normalizeDomainStudioSection('notebooks')).toBe('used_by');
    expect(normalizeDomainStudioSection('apps')).toBe('used_by');
    expect(normalizeDomainStudioSection('terms')).toBe('terms');
    expect(normalizeDomainStudioSection('knowledge')).toBe('diagram');
    expect(normalizeDomainStudioSection(null)).toBe('diagram');
    expect(resolveDomainStudioLocation('https://app.test/n?domain=commerce&domainSection=apps', null).section).toBe('used_by');
    expect(parseDomainStudioLocation('{"section":"notebooks"}').section).toBe('used_by');
  });

  it('orders nested Domain Packages parent-first with simple hierarchy labels', () => {
    expect(domainPackageTree({
      'customers.lifecycle.churn': { id: 'customers.lifecycle.churn', parent: 'customers.lifecycle', filePath: 'domains/customers/lifecycle/churn/domain.dql', exports: [] },
      customers: { id: 'customers', filePath: 'domains/customers/domain.dql', exports: [] },
      'customers.lifecycle': { id: 'customers.lifecycle', parent: 'customers', filePath: 'domains/customers/lifecycle/domain.dql', exports: [] },
      products: { id: 'products', filePath: 'domains/products/domain.dql', exports: [] },
    }).map(({ id, depth, label }) => ({ id, depth, label }))).toEqual([
      { id: 'customers', depth: 0, label: 'customers' },
      { id: 'customers.lifecycle', depth: 1, label: '— lifecycle' },
      { id: 'customers.lifecycle.churn', depth: 2, label: '— — churn' },
      { id: 'products', depth: 0, label: 'products' },
    ]);
  });

  it('round-trips the selected domain, Area, and object without dropping unrelated URL state', () => {
    expect(domainStudioLocationHref('http://127.0.0.1:3474/?theme=paper', {
      domain: 'customers.lifecycle',
      section: 'diagram',
      modelAreaId: 'customers.lifecycle::model_area::retention',
      selectedId: 'customers.lifecycle::entity::orders',
    })).toBe('/?theme=paper&domain=customers.lifecycle&domainSection=diagram&modelArea=customers.lifecycle%3A%3Amodel_area%3A%3Aretention&domainObject=customers.lifecycle%3A%3Aentity%3A%3Aorders');
  });

  it('removes Domain Studio state without dropping unrelated URL state', () => {
    expect(withoutDomainStudioLocationHref(
      'http://127.0.0.1:3474/?theme=paper&domain=core&domainSection=skills&modelArea=core%3A%3Aarea&domainObject=model%3Aorders#token',
    )).toBe('/?theme=paper#token');
  });
});

describe('qualified entity record identity', () => {
  const entities = modeling({
    'commerce::entity::customer': entity('commerce', 'customer'),
    'growth::entity::customer': entity('growth', 'customer'),
  });

  it('uses manifest record keys even when local ids collide', () => {
    expect(entityRecords(entities).map((item) => item.recordKey)).toEqual(['commerce::entity::customer', 'growth::entity::customer']);
  });

  it('does not guess an ambiguous local id', () => {
    expect(resolveEntityRecordKey(entities, 'customer')).toBeUndefined();
    expect(resolveEntityRecordKey(entities, 'growth::entity::customer')).toBe('growth::entity::customer');
  });
});

describe('two-tier authoring write path (00-decisions.md#a-001)', () => {
  const existing: ManifestModelEntity = {
    id: 'order', localId: 'order', qualifiedId: 'commerce::entity::order', domain: 'commerce',
    // The real compiler emits `<domain>::model_area::<localId>`. This fixture
    // used to say `::area::`, matching the buggy split rather than reality,
    // which is why a broken `isDescriptiveOnlyChange` still passed here.
    areaId: 'commerce::model_area::core', dbtUniqueId: 'model.shop.fct_orders',
    businessName: 'Order', grain: 'order_id', keys: ['order_id'], status: 'draft',
    sourcePath: 'domains/commerce/modeling/model.dql.yaml', identityFingerprint: 'fp',
  } as ManifestModelEntity;

  const upsert = (value: Partial<ManifestModelEntity> & Record<string, unknown>) => ({
    operation: 'upsert_entity' as const,
    value: {
      id: 'order', domain: 'commerce', areaId: 'core', dbtModel: 'model.shop.fct_orders',
      grain: 'order_id', keys: ['order_id'], status: 'draft', ...value,
    },
  });

  it('saves prose edits directly: they carry no join or lifecycle meaning', () => {
    expect(isDescriptiveOnlyChange(upsert({ businessContext: 'One completed purchase.' }) as never, existing)).toBe(true);
    expect(isDescriptiveOnlyChange(upsert({ businessName: 'Customer order' }) as never, existing)).toBe(true);
    expect(isDescriptiveOnlyChange(upsert({ analyticalRole: 'event' }) as never, existing)).toBe(true);
  });

  it('keeps the full proposal review for anything structural', () => {
    // Creating an object.
    expect(isDescriptiveOnlyChange(upsert({}) as never, undefined)).toBe(false);
    // Rebinding the dbt model.
    expect(isDescriptiveOnlyChange(upsert({ dbtModel: 'model.shop.stg_orders' }) as never, existing)).toBe(false);
    // Asserting a different grain or keys.
    expect(isDescriptiveOnlyChange(upsert({ grain: 'line_item_id' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ keys: ['order_id', 'customer_id'] }) as never, existing)).toBe(false);
    // Moving lifecycle or ownership.
    expect(isDescriptiveOnlyChange(upsert({ status: 'certified' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ domain: 'growth' }) as never, existing)).toBe(false);
    expect(isDescriptiveOnlyChange(upsert({ areaId: 'billing' }) as never, existing)).toBe(false);
    // Relationships are never descriptive-only.
    expect(isDescriptiveOnlyChange({ operation: 'upsert_relationship', value: { id: 'r' } } as never, existing)).toBe(false);
  });

  it('compares the area on its local id, so an area-owned entity can still save prose directly', () => {
    // The existing entity's `areaId` is qualified; the change carries the local
    // id. Comparing them raw made every area-owned entity look like an area
    // move, so A-001's direct-save path was dead and the save button lied.
    expect(existing.areaId).toContain('::model_area::');
    expect(isDescriptiveOnlyChange(upsert({ businessContext: 'One completed purchase.' }) as never, existing)).toBe(true);
  });
});

describe('Modeling workspace location and conversation identity', () => {
  const mirror = JSON.stringify({ domain: 'commerce', section: 'diagram', modelAreaId: 'commerce::model_area::core', selectedId: 'commerce::entity::order' });

  it('restores the last workspace location when the URL carries no Domain Studio state', () => {
    // The shell strips these params on the way out, so without the mirror a
    // return trip landed on "all domains, nothing selected" — which also reset
    // the AI thread key and orphaned the conversation.
    expect(resolveDomainStudioLocation('https://app.test/notebook', mirror)).toEqual({
      domain: 'commerce', section: 'diagram', modelAreaId: 'commerce::model_area::core', selectedId: 'commerce::entity::order',
    });
  });

  it('lets an explicit deep link win over the mirror', () => {
    expect(resolveDomainStudioLocation('https://app.test/notebook?domain=growth&domainSection=skills', mirror)).toEqual({
      domain: 'growth', section: 'skills', modelAreaId: null, selectedId: null,
    });
  });

  it('honours a deep link that deliberately clears the domain', () => {
    // `?domainSection=diagram` with no `domain` means "all domains" on purpose.
    expect(resolveDomainStudioLocation('https://app.test/notebook?domainSection=diagram', mirror).domain).toBeNull();
  });

  it('round-trips through domainStudioLocationHref', () => {
    const href = `https://app.test${domainStudioLocationHref('https://app.test/n', { domain: 'commerce', section: 'diagram', modelAreaId: 'a', selectedId: 'b' })}`;
    expect(resolveDomainStudioLocation(href, null)).toEqual({ domain: 'commerce', section: 'diagram', modelAreaId: 'a', selectedId: 'b' });
  });

  it('treats unusable mirrored state as no location instead of throwing', () => {
    for (const raw of [null, undefined, '', 'not json', '{"section":"nope"}', '[]']) {
      expect(parseDomainStudioLocation(raw).section).toBe('diagram');
    }
    expect(parseDomainStudioLocation('{"domain":"   "}').domain).toBeNull();
  });

  it('keys the AI conversation on the domain alone', () => {
    // The key used to embed the active area and the selected node, so clicking
    // another model swapped the thread mid-conversation.
    expect(modelingThreadScope('commerce')).toBe(modelingThreadScope('commerce'));
    expect(modelingThreadScope('commerce')).not.toBe(modelingThreadScope('growth'));
    expect(modelingThreadScope(null)).toBe('modeling:all');
  });
});
