import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  meaningFilePath,
  meaningFileStale,
  meaningFilesHaveWords,
  meaningHasDraft,
  meaningText,
  readMeaningFiles,
  relationColumnsFingerprint,
  relationMeaning,
  writeMeaningFile,
  type MeaningFileV1,
} from './meaning-files.js';

const columns = [{ name: 'extendedprice', type: 'numeric' }, { name: 'taxamount', type: 'numeric', comment: 'Tax on this line' }];
const relation = { columns };

function file(over: Partial<MeaningFileV1> = {}): MeaningFileV1 {
  return {
    version: 1,
    id: 'warehouse.wwi.sales.invoicelines',
    relation: 'wwi.sales.invoicelines',
    columnsFingerprint: relationColumnsFingerprint(relation),
    table: { description: 'One row per product on an invoice.', source: 'ai', model: 'm', date: '2026-11-02', otherNames: ['revenue lines'] },
    columns: {
      extendedprice: { description: 'Line total including tax', source: 'ai' },
      taxamount: { description: 'A draft that must lose to the comment', source: 'ai' },
    },
    ...over,
  };
}

describe('meaning files', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'meanings-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reads back what it wrote, and sees an edit made by hand', () => {
    writeMeaningFile(root, file());
    expect(readMeaningFiles(root).get('warehouse.wwi.sales.invoicelines')?.table?.otherNames).toEqual(['revenue lines']);
    const path = meaningFilePath(root, 'warehouse.wwi.sales.invoicelines');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('One row per product', 'One row per stock item'));
    expect(readMeaningFiles(root).get('warehouse.wwi.sales.invoicelines')?.table?.description).toContain('stock item');
  });

  it('writes one line per column, so a review reads like a list', () => {
    writeMeaningFile(root, file());
    const text = readFileSync(meaningFilePath(root, 'warehouse.wwi.sales.invoicelines'), 'utf-8');
    expect(text).toContain('  extendedprice: {description: Line total including tax, source: ai}');
  });

  it('keeps a relation id inside the meanings folder', () => {
    expect(meaningFilePath(root, 'warehouse.../../etc/passwd').startsWith(join(root, 'meanings'))).toBe(true);
    expect(meaningFilePath(root, 'warehouse.../../etc/passwd')).not.toContain('/../');
  });

  it('two ids that clean to one name never share a file', () => {
    expect(meaningFilePath(root, 'warehouse.db.sales.order items')).not.toBe(meaningFilePath(root, 'warehouse.db.sales.order_items'));
    expect(meaningFilePath(root, 'dbt.model.shop.Orders').toLowerCase()).not.toBe(meaningFilePath(root, 'dbt.model.shop.orders').toLowerCase());
    expect(meaningFilePath(root, 'warehouse.db.sales.order_items')).toBe(join(root, 'meanings', 'db.sales.order_items.yaml'));
  });

  it('ignores a file that does not parse, and reads the rest', () => {
    writeMeaningFile(root, file());
    writeFileSync(join(root, 'meanings', 'broken.yaml'), 'version: [');
    expect(readMeaningFiles(root).size).toBe(1);
  });

  it('a warehouse comment outranks a draft', () => {
    const meaning = relationMeaning(file(), relation)!;
    expect(meaning.columns.get('extendedprice')?.text).toBe('Line total including tax');
    expect(meaning.columns.has('taxamount')).toBe(false);
  });

  it("a person's words outrank a warehouse comment", () => {
    const edited = file({ columns: { taxamount: { description: 'Tax in the local currency', source: 'person' } } });
    expect(relationMeaning(edited, relation)!.columns.get('taxamount')).toEqual({ text: 'Tax in the local currency', source: 'person' });
  });

  it('a changed column list stops a draft being used', () => {
    const changed = { columns: [...columns, { name: 'discount', type: 'numeric' }] };
    expect(meaningFileStale(file(), changed)).toBe(true);
    expect(relationMeaning(file(), changed)).toBeUndefined();
  });

  it("a person's words outlive a schema change", () => {
    const changed = { columns: [...columns, { name: 'discount', type: 'numeric' }] };
    const edited = file({ columns: { extendedprice: { description: 'Line total', source: 'person' }, taxamount: { description: 'old draft', source: 'ai' } } });
    const meaning = relationMeaning(edited, changed)!;
    expect(meaning.columns.get('extendedprice')?.source).toBe('person');
    expect(meaning.columns.size).toBe(1);
    expect(meaning.description).toBeUndefined();
  });

  it('a column the table no longer has says nothing', () => {
    const gone = file({ columns: { dropped_column: { description: 'Was here once', source: 'person' } } });
    expect(relationMeaning(gone, relation)?.columns.size).toBe(0);
  });

  it('the fingerprint ignores column order and case', () => {
    expect(relationColumnsFingerprint({ columns: [...columns].reverse() })).toBe(relationColumnsFingerprint(relation));
    expect(relationColumnsFingerprint({ columns: [{ name: 'ExtendedPrice', type: 'NUMERIC' }, columns[1]!] })).toBe(relationColumnsFingerprint(relation));
  });

  it('a file with no words does not make a project one that uses meanings', () => {
    writeMeaningFile(root, file({ table: undefined, columns: {} }));
    expect(meaningFilesHaveWords(readMeaningFiles(root))).toBe(false);
    writeMeaningFile(root, file());
    expect(meaningFilesHaveWords(readMeaningFiles(root))).toBe(true);
  });

  it('an unreviewed draft always says so, and a reviewed one does not', () => {
    const meaning = relationMeaning(file(), relation)!;
    expect(meaningText(meaning.description!)).toBe('AI draft: One row per product on an invoice.');
    expect(meaningHasDraft(meaning)).toBe(true);
    expect(meaningText({ text: 'Checked', source: 'person' })).toBe('Checked');
    const reviewed = relationMeaning(file({ table: { description: 'Checked', source: 'person' }, columns: {} }), relation)!;
    expect(meaningHasDraft(reviewed)).toBe(false);
  });
});
