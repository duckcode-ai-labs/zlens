import { describe, expect, it } from 'vitest';
import type { ManifestDbtFirstModeling } from '@zlens/core';
import { areaStubs, mapLevel } from './model-map-levels';

// Shared (account, date); Sales and marketing with a Sales area, a Marketing
// area and one table in its default files; Finance in its default files.
const area = (domain: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({
  [`${domain}::model_area::${id}`]: { id: `${domain}::model_area::${id}`, localId: id, qualifiedId: `${domain}::model_area::${id}`, domain, name, intentExamples: [], entityIds: [], relationshipIds: [], referencedEntityIds: [], sourcePath: '', ...extra },
});
const entity = (domain: string, id: string, areaId?: string) => ({
  [`${domain}::entity::${id}`]: { id, qualifiedId: `${domain}::entity::${id}`, domain, dbtUniqueId: `model.x.${id}`, ...(areaId ? { areaId: `${domain}::model_area::${areaId}` } : {}) },
});
const join = (id: string, from: string, to: string) => ({ [id]: { id, from, to, keys: [] } });
const modeling = {
  packages: { sales_and_marketing: { name: 'Sales and marketing' } },
  areas: {
    ...area('shared', 'shared', 'Shared', { shared: true }),
    ...area('sales_and_marketing', 'sales', 'Sales', { referencedEntityIds: ['shared::entity::account'] }),
    ...area('sales_and_marketing', 'marketing', 'Marketing'),
  },
  entities: {
    ...entity('shared', 'account', 'shared'),
    ...entity('shared', 'date', 'shared'),
    ...entity('sales_and_marketing', 'opportunity', 'sales'),
    ...entity('sales_and_marketing', 'pipeline', 'sales'),
    ...entity('sales_and_marketing', 'campaign', 'marketing'),
    ...entity('sales_and_marketing', 'touchpoint'),
    ...entity('finance', 'invoice'),
  },
  relationships: {
    ...join('r1', 'sales_and_marketing::entity::pipeline', 'sales_and_marketing::entity::opportunity'),
    ...join('r2', 'sales_and_marketing::entity::opportunity', 'shared::entity::account'),
    ...join('r3', 'sales_and_marketing::entity::campaign', 'shared::entity::account'),
    ...join('r4', 'finance::entity::invoice', 'shared::entity::account'),
    ...join('r5', 'finance::entity::invoice', 'sales_and_marketing::entity::opportunity'),
    ...join('r6', 'sales_and_marketing::entity::touchpoint', 'sales_and_marketing::entity::campaign'),
  },
} as unknown as ManifestDbtFirstModeling;

describe('the map opens on the level the model needs (model-at-scale design S5)', () => {
  it('opens a large model on its Domains, Shared first, with the joins between them', () => {
    const level = mapLevel(modeling, null, null, '', 3);
    expect(level.kind).toBe('domains');
    if (level.kind !== 'domains') return;
    expect(level.cards.map((card) => [card.name, card.tables, card.areas])).toEqual([
      ['Shared', 2, 1],
      ['Sales and marketing', 4, 3],
      ['Finance', 1, 1],
    ]);
    expect(level.cards[0]!.joins).toEqual([{ domain: 'finance', name: 'Finance', count: 1 }, { domain: 'sales_and_marketing', name: 'Sales and marketing', count: 2 }].sort((a, b) => b.count - a.count));
    expect(level.cards[1]!.joins.map((item) => `${item.name} ${item.count}`)).toEqual(['Shared 2', 'Finance 1']);
  });

  it('opens a Domain on its areas, with where their joins lead', () => {
    const level = mapLevel(modeling, 'sales_and_marketing', null, '', 3);
    expect(level.kind).toBe('areas');
    if (level.kind !== 'areas') return;
    expect(level.cards.map((card) => [card.name, card.tables, card.edge])).toEqual([
      ['Sales', 2, 1],
      ['Marketing', 1, 0],
      ['Not in an area yet', 1, 0],
    ]);
    const sales = level.cards[0]!;
    expect(sales.joins.map((item) => `${item.name} ${item.count}`)).toEqual(['Finance 1', 'Shared 1']);
    expect(level.cards[1]!.joins.map((item) => `${item.name} ${item.count}`)).toEqual(['Not in an area yet 1', 'Shared 1']);
  });

  it('opens on the tables for a small model, a search, or a chosen area', () => {
    expect(mapLevel(modeling, null, null, '').kind).toBe('tables');
    expect(mapLevel(modeling, null, null, 'invoice', 3).kind).toBe('tables');
    expect(mapLevel(modeling, 'sales_and_marketing', 'sales_and_marketing::model_area::sales', '', 3).kind).toBe('tables');
    expect(mapLevel(modeling, 'finance', null, '', 0).kind).toBe('tables');
  });

  it('counts the default area a new model lands in with a Domain’s tables outside any area', () => {
    const withCore = {
      ...modeling,
      areas: { ...modeling.areas, ...area('finance', 'core', 'Acme analytics') },
      entities: { ...modeling.entities, ...entity('finance', 'payment', 'core') },
    } as unknown as ManifestDbtFirstModeling;
    const level = mapLevel(withCore, 'finance', null, '', 0);
    // One place, not two: `core` (named after the project) and the files outside any area.
    expect(level.kind).toBe('tables');
    const domains = mapLevel(withCore, null, null, '', 3);
    expect(domains.kind === 'domains' && domains.cards.find((card) => card.domain === 'finance')).toMatchObject({ tables: 2, areas: 1 });
  });

  it('folds an area’s joins into other areas into one stub per area', () => {
    // The Sales diagram draws its two tables and the Shared account at its edge.
    const shown = new Set(['sales_and_marketing::entity::pipeline', 'sales_and_marketing::entity::opportunity', 'shared::entity::account']);
    expect(areaStubs(modeling, 'sales_and_marketing::model_area::sales', shown)).toEqual([
      { id: 'stub:finance|', label: 'Finance · 1 join', domain: 'finance', areaId: null, count: 1, from: ['sales_and_marketing::entity::opportunity'] },
    ]);
    expect(areaStubs(modeling, 'sales_and_marketing::model_area::marketing', new Set(['sales_and_marketing::entity::campaign'])).map((stub) => stub.label)).toEqual(['Not in an area yet · 1 join', 'Shared · 1 join']);
  });
});
