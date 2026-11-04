import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMeaningFiles, relationColumnsFingerprint, relationMeaning, writeMeaningFile, type DQLManifest, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { recordRuntimeSchemaSnapshot, SCHEMA_SYNC_SOURCE } from '@zlens/agent';
import { draftedMeaningRelations } from './ask-pipeline-host/vocabulary-source.js';
import { routeAction } from './host/route-actions.js';
import { draftMeanings } from './meaning-draft.js';
import { acceptMeanings, meaningCatalog, meaningsOverview, meaningTableDetail, saveMeaningEdit } from './meaning-routes.js';

const lines: WarehouseCatalogRelationV1 = {
  id: 'warehouse.sales.lines', schema: 'sales', name: 'lines', relation: 'sales.lines', kind: 'table',
  columns: [{ name: 'price', type: 'numeric' }, { name: 'tax', type: 'numeric', comment: 'Tax on this line' }],
};
const bare: WarehouseCatalogRelationV1 = { id: 'warehouse.sales.bare', schema: 'sales', name: 'bare', relation: 'sales.bare', kind: 'table', columns: [{ name: 'a' }] };
const snapshot = { relations: [lines, bare] };
const manifest = { modeling: { entities: { orders: { dbtUniqueId: lines.id, domain: 'sales_area' } } } } as unknown as DQLManifest;

describe('reviewing what the data means', () => {
  let root: string;
  const draft = (over: Record<string, unknown> = {}) => writeMeaningFile(root, {
    version: 1, id: lines.id, relation: lines.relation, columnsFingerprint: relationColumnsFingerprint(lines),
    table: { description: 'One row per line.', source: 'ai', model: 'm', date: '2026-11-01', otherNames: ['revenue lines'], evidence: ['the names and types of 2 columns'] },
    columns: { price: { description: 'What it sold for', source: 'ai', model: 'm', date: '2026-11-01' } },
    ...over,
  });
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'meaning-routes-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('lists every table with its standing and domain', () => {
    draft();
    const tables = meaningsOverview(root, snapshot, manifest);
    expect(tables.map((table) => [table.name, table.state, table.domain])).toEqual([['bare', 'undescribed', undefined], ['lines', 'needs_review', 'sales_area']]);
    expect(tables[1]).toMatchObject({ source: 'ai', columns: 2, describedColumns: 2, drafts: 2 });
  });

  it('shows who wrote each column, and why a draft says what it says', () => {
    draft();
    const detail = meaningTableDetail(root, snapshot, manifest, lines.id)!;
    expect(detail.columnDetails).toEqual([
      { name: 'price', type: 'numeric', description: 'What it sold for', source: 'ai', model: 'm', date: '2026-11-01' },
      { name: 'tax', type: 'numeric', description: 'Tax on this line', source: 'warehouse' },
    ]);
    expect(detail.evidence).toEqual(['the names and types of 2 columns']);
    expect(detail.otherNames).toEqual(['revenue lines']);
  });

  it('a stale draft is shown as stale and its words are not offered as current', () => {
    draft({ columnsFingerprint: 'old' });
    const detail = meaningTableDetail(root, snapshot, manifest, lines.id)!;
    expect(detail.state).toBe('stale');
    expect(detail.describedColumns).toBe(1);
    expect(detail.description).toBeUndefined();
    expect(detail.columnDetails[0]?.description).toBeUndefined();
  });

  it('an edit is the person\'s, and the rest of the table stays a draft', () => {
    draft();
    expect(saveMeaningEdit(root, snapshot, { id: lines.id, columns: { PRICE: 'Line total  including tax' } }, '2026-11-02')).toBe('saved');
    const file = readMeaningFiles(root).get(lines.id)!;
    expect(file.columns.price).toEqual({ description: 'Line total including tax', source: 'person', date: '2026-11-02' });
    expect(file.table?.source).toBe('ai');
  });

  it("an edit to a column the warehouse commented is the person's and wins", () => {
    saveMeaningEdit(root, snapshot, { id: lines.id, columns: { tax: 'Tax in local currency' } }, '2026-11-02');
    expect(relationMeaning(readMeaningFiles(root).get(lines.id), lines)?.columns.get('tax')?.text).toBe('Tax in local currency');
  });

  it('an empty description removes the entry', () => {
    draft();
    saveMeaningEdit(root, snapshot, { id: lines.id, columns: { price: '  ' } }, '2026-11-02');
    expect(readMeaningFiles(root).get(lines.id)?.columns.price).toBeUndefined();
  });

  it('other names need a table description', () => {
    expect(saveMeaningEdit(root, snapshot, { id: bare.id, otherNames: ['things'] }, '2026-11-02')).toBe('needs_description');
    expect(saveMeaningEdit(root, snapshot, { id: bare.id, description: 'Things', otherNames: ['things', ' things '] }, '2026-11-02')).toBe('saved');
    expect(readMeaningFiles(root).get(bare.id)?.table?.otherNames).toEqual(['things']);
  });

  it('a table not in the catalog is refused, and a column not on the table is ignored', () => {
    expect(saveMeaningEdit(root, snapshot, { id: 'warehouse.gone', description: 'x' }, '2026-11-02')).toBe('no_table');
    saveMeaningEdit(root, snapshot, { id: lines.id, columns: { imaginary: 'x' } }, '2026-11-02');
    expect(readMeaningFiles(root).get(lines.id)?.columns).toEqual({});
  });

  it('Accept takes the AI label off and keeps the words, the model and the other names', () => {
    draft();
    expect(acceptMeanings(root, snapshot, [lines.id], '2026-11-02')).toEqual({ accepted: 1, skippedStale: 0 });
    const file = readMeaningFiles(root).get(lines.id)!;
    expect(file.table).toEqual({ description: 'One row per line.', source: 'person', model: 'm', date: '2026-11-02', otherNames: ['revenue lines'] });
    expect(file.columns.price?.source).toBe('person');
    expect(meaningTableDetail(root, snapshot, manifest, lines.id)?.state).toBe('reviewed');
  });

  it('Accept never takes a stale draft, and a second Accept changes nothing', () => {
    draft({ columnsFingerprint: 'old' });
    expect(acceptMeanings(root, snapshot, [lines.id], '2026-11-02')).toEqual({ accepted: 0, skippedStale: 1 });
    draft();
    acceptMeanings(root, snapshot, [lines.id], '2026-11-02');
    expect(acceptMeanings(root, snapshot, [lines.id], '2026-11-03')).toEqual({ accepted: 0, skippedStale: 0 });
    expect(readMeaningFiles(root).get(lines.id)?.table?.date).toBe('2026-11-02');
  });

  it('Accept never turns a draft hidden behind a warehouse comment into a person\'s words', () => {
    const commented: WarehouseCatalogRelationV1 = { ...lines, comment: 'DBA: one line of an invoice' };
    const snapshotWithComment = { relations: [commented, bare] };
    writeMeaningFile(root, {
      version: 1, id: lines.id, relation: lines.relation, columnsFingerprint: relationColumnsFingerprint(lines),
      table: { description: 'AI table words', source: 'ai' },
      columns: { tax: { description: 'AI tax words', source: 'ai' }, price: { description: 'AI price words', source: 'ai' } },
    });
    acceptMeanings(root, snapshotWithComment, [lines.id], '2026-11-02');
    const file = readMeaningFiles(root).get(lines.id)!;
    expect(file.table?.source).toBe('ai');
    expect(file.columns.tax?.source).toBe('ai');
    expect(file.columns.price?.source).toBe('person');
    expect(relationMeaning(file, commented)?.description).toBeUndefined();
    expect(relationMeaning(file, commented)?.columns.has('tax')).toBe(false);
  });

  it('a draft hidden behind a comment is not counted as waiting for review', () => {
    const commented: WarehouseCatalogRelationV1 = { ...lines, comment: 'DBA words' };
    writeMeaningFile(root, { version: 1, id: lines.id, relation: lines.relation, columnsFingerprint: relationColumnsFingerprint(lines), table: { description: 'AI words', source: 'ai' }, columns: { tax: { description: 'AI tax', source: 'ai' } } });
    const [, summary] = meaningsOverview(root, { relations: [commented, bare] }, manifest);
    expect(summary).toMatchObject({ state: 'described', drafts: 0, description: 'DBA words', source: 'warehouse' });
  });

  it("a stale draft's other names are not offered, and a save can't make them a person's", () => {
    draft({ columnsFingerprint: 'old' });
    expect(meaningTableDetail(root, snapshot, manifest, lines.id)?.otherNames).toEqual([]);
    expect(meaningTableDetail(root, snapshot, manifest, lines.id)?.evidence).toEqual([]);
    expect(saveMeaningEdit(root, snapshot, { id: lines.id, otherNames: ['revenue lines'] }, '2026-11-02')).toBe('needs_description');
    expect(readMeaningFiles(root).get(lines.id)?.table?.source).toBe('ai');
  });

  it('on a hosted server reading needs read, editing is authoring, and a draft needs an administrator', () => {
    expect(routeAction('GET', '/api/meanings')?.action).toBe('project.read');
    expect(routeAction('PUT', '/api/meanings/table')?.action).toBe('dataset.author');
    expect(routeAction('POST', '/api/meanings/accept')?.action).toBe('dataset.author');
    expect(routeAction('POST', '/api/meanings/draft')?.action).toBe('settings.manage');
  });
});

describe('a dbt project with no catalog.json', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'meaning-routes-dbt-'));
    mkdirSync(join(root, 'target'), { recursive: true });
    // dbt documents one of the four columns, and describes the table.
    writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
      nodes: { 'model.nba.team_game_facts': { resource_type: 'model', name: 'team_game_facts', database: 'nba', schema: 'transformed', relation_name: '"nba"."transformed"."team_game_facts"', description: 'One row per team per game.', columns: { game_id: { name: 'game_id', description: '' } } } },
      sources: {},
    }));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('says which tables a draft would see only the documented columns of', () => {
    expect(meaningCatalog(root)?.columnsUnlisted).toEqual(['nba.transformed.team_game_facts']);
    expect(meaningCatalog(root)?.relations[0]?.columns.map((column) => column.name)).toEqual(['game_id']);
  });

  it('drafts against every column once the schema is synced, and Ask uses the draft', async () => {
    recordRuntimeSchemaSnapshot(root, {
      generationId: 'nba-1',
      source: SCHEMA_SYNC_SOURCE,
      connectionId: 'default',
      tables: [{ relation: 'transformed.team_game_facts', catalogOrDatabase: 'nba', schema: 'transformed', name: 'team_game_facts', columns: [{ name: 'game_id', type: 'BIGINT' }, { name: 'team_id', type: 'BIGINT' }, { name: 'pts', type: 'DOUBLE' }, { name: 'is_home', type: 'BOOLEAN' }] }],
    });
    const catalog = meaningCatalog(root)!;
    expect(catalog.columnsUnlisted).toEqual([]);
    expect(catalog.relations[0]?.columns.map((column) => column.name)).toEqual(['game_id', 'team_id', 'pts', 'is_home']);
    const provider = { name: 'claude', available: async () => true, generate: async () => JSON.stringify({ tables: [{ relation: 'nba.transformed.team_game_facts', columns: { pts: 'Points the team scored in the game', is_home: 'Whether the team played at home' } }] }) };
    const report = await draftMeanings({ projectRoot: root, snapshot: catalog, provider: provider as never, date: '2026-11-03' });
    expect(report).toMatchObject({ tablesDrafted: 1, columnsDrafted: 2, failed: [] });
    // The readers see the same columns, so the draft is current, not stale.
    const manifest = { dbtProvenance: { manifestPath: join(root, 'target', 'manifest.json') } } as unknown as DQLManifest;
    expect(draftedMeaningRelations(manifest, root)).toEqual(['nba.transformed.team_game_facts']);
  });
});
