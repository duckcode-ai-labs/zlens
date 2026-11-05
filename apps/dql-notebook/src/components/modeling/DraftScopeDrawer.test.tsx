import { describe, expect, it } from 'vitest';
import type { DraftScopeResponse } from '../../api/client';
import { areaRow, layerNote, pickSummary, warehouseNote } from './DraftScopeDrawer';

const choices: DraftScopeResponse['choices'] = {
  tables: 4896,
  budget: 150,
  layers: { business: 476, intermediate: 245, aside: 1063, snapshot: 163, staging: 1580, raw: 1414 },
  areas: [],
};
const preview = (over: Partial<DraftScopeResponse['preview']>): DraftScopeResponse['preview'] => ({ description: 'area:sales', asked: 122, drafted: 122, budget: 150, leftOut: 0, leftOutSample: [], ...over });

describe('the draft picker (model-at-scale design S3)', () => {
  it('says how many tables can be answered from, and what the other layers hold', () => {
    expect(layerNote(choices)).toBe('476 business tables to answer from. 4,465 more are not offered by area: 245 intermediate, 1,063 team workspace and legacy, 163 snapshots, 1,580 staging, 1,414 raw.');
    expect(layerNote({ ...choices, layers: { business: 12, intermediate: 0, aside: 0, snapshot: 0, staging: 0, raw: 0 } })).toBe('12 business tables to answer from.');
  });

  it('names a Domain, an area and the Shared area, with what they read', () => {
    expect(areaRow({ select: 'domain:sales_and_marketing', domain: 'sales_and_marketing', tables: 111, reads: 41 })).toEqual({ title: 'Sales and marketing', detail: '111 tables, and 41 they read · the whole Domain' });
    expect(areaRow({ select: 'area:sales_and_marketing.sales', domain: 'sales_and_marketing', area: 'sales', tables: 46, reads: 76 })).toEqual({ title: 'Sales', detail: '46 tables, and 76 they read' });
    expect(areaRow({ select: 'domain:shared', domain: 'shared', shared: true, tables: 1, reads: 0 }).detail).toBe('1 table · read by several areas; drafted once, with the first area that reads them');
  });

  it('says what a pick drafts before anything runs, and what the budget leaves for later', () => {
    expect(pickSummary(false, false, undefined)).toBe('Pick an area, some tables or a selector.');
    expect(pickSummary(true, true, undefined)).toBe('Counting…');
    expect(pickSummary(true, false, preview({ asked: 0, drafted: 0 }))).toBe('Nothing in the project matches this pick.');
    expect(pickSummary(true, false, preview({ asked: 1, drafted: 1 }))).toBe('1 table picked. Only this table is read from the warehouse and checked.');
    expect(pickSummary(true, false, preview({}))).toBe('122 tables picked. Only these are read from the warehouse and checked.');
    expect(pickSummary(true, false, preview({ asked: 233, drafted: 150, leftOut: 83 }))).toBe('233 tables picked. ZLens drafts the 150 most important now and lists the other 83: business tables first, then the ones dbt exposures use, then the ones many models read.');
  });
});

describe('a hybrid project drafts its warehouse tables too', () => {
  it('says which warehouse tables it drafts, and that dbt\'s tables are never drafted twice', () => {
    expect(warehouseNote({ tables: 23, dbtBuilt: 26, schemas: ['netsuite', 'zendesk'] })).toBe('23 warehouse tables dbt does not build, in netsuite, zendesk. The 26 synced tables dbt builds are drafted as dbt models, never twice; joins to the ones already in the model are drafted too.');
    expect(warehouseNote({ tables: 0, dbtBuilt: 4, schemas: [] })).toBe('No warehouse tables outside dbt yet (the 4 synced tables dbt builds are drafted as dbt models). Choose their schemas in Settings → Connections → Sync schema.');
    expect(warehouseNote(undefined)).toBe('Reading the warehouse catalog…');
  });
});
