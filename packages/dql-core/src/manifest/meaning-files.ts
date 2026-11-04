/**
 * WHAT THE DATA MEANS, as tracked files (AI first draft, 2026-11-02).
 *
 * A database with no comments has a proven map of tables and joins and no word
 * of what any of it means. These files hold the missing words: what one row of
 * a table is, what each column holds, and what else people call the table. One
 * file per table under `meanings/`, so a review shows in a pull request.
 *
 * An entry says who wrote it. `source: ai` is an unreviewed draft: it can help
 * find a table and it is labelled wherever it is used, and it never raises an
 * answer's trust. `source: person` is someone's own words and is never
 * overwritten by a later draft. A warehouse comment outranks a draft, and a
 * person's edit outranks both.
 *
 * Each file records a fingerprint of the table's columns. When the columns
 * change the drafts on that table go stale and stop being used; a person's
 * words stay, because the column they describe is still checked by name.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { WarehouseCatalogRelationV1 } from './warehouse-catalog.js';

/** Where the files live, relative to the project root. */
export const MEANINGS_DIR = 'meanings';

export type MeaningSource = 'ai' | 'person';

export interface MeaningEntryV1 {
  description: string;
  source: MeaningSource;
  /** The model that drafted it; absent on a person's words. */
  model?: string;
  /** The day it was drafted or edited, `YYYY-MM-DD`. */
  date?: string;
  /** What the draft was read from, for the person reviewing it. */
  evidence?: string[];
}

export interface MeaningTableEntryV1 extends MeaningEntryV1 {
  /** Other names people use for this table. */
  otherNames?: string[];
}

export interface MeaningFileV1 {
  version: 1;
  /** The warehouse relation id (`warehouse.<database>.<schema>.<name>`). */
  id: string;
  /** The relation as queried, for the person reading the file. */
  relation: string;
  /** Fingerprint of the columns the entries were written against. */
  columnsFingerprint: string;
  table?: MeaningTableEntryV1;
  columns: Record<string, MeaningEntryV1>;
}

/** The words that apply to one table right now, after staleness and precedence. */
export interface RelationMeaning {
  /** The table's description, when a draft or a person supplies it. */
  description?: { text: string; source: MeaningSource };
  otherNames: string[];
  /** Keyed by lower-cased column name. */
  columns: Map<string, { text: string; source: MeaningSource }>;
}

/** A fingerprint of a table's columns: its names and types, in any order. */
export function relationColumnsFingerprint(relation: Pick<WarehouseCatalogRelationV1, 'columns'>): string {
  const columns = relation.columns.map((column) => `${column.name.toLowerCase()}:${(column.type ?? '').toLowerCase()}`).sort();
  return createHash('sha256').update(columns.join('\n')).digest('hex').slice(0, 16);
}

/**
 * The file that holds a relation's meanings: its id without the `warehouse.`
 * prefix. Two ids that clean to one name (`order items` and `order_items`, or
 * `Orders` and `orders` on a filesystem that ignores case) get a short hash, so
 * one table's file can never be another's.
 */
export function meaningFilePath(projectRoot: string, id: string): string {
  const bare = id.replace(/^warehouse\./, '');
  const stem = bare.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^\.+/, '_');
  const unique = stem === bare ? stem : `${stem}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  return join(projectRoot, MEANINGS_DIR, `${unique}.yaml`);
}

function asEntry(value: unknown): MeaningEntryV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.description !== 'string' || !item.description.trim()) return undefined;
  const source: MeaningSource = item.source === 'person' ? 'person' : 'ai';
  return {
    description: item.description.trim(),
    source,
    ...(typeof item.model === 'string' ? { model: item.model } : {}),
    ...(typeof item.date === 'string' ? { date: item.date } : {}),
    ...(Array.isArray(item.evidence) ? { evidence: item.evidence.filter((line): line is string => typeof line === 'string') } : {}),
  };
}

function parseMeaningFile(text: string): MeaningFileV1 | undefined {
  const parsed = yaml.load(text) as Record<string, unknown> | null;
  if (!parsed || parsed.version !== 1 || typeof parsed.id !== 'string') return undefined;
  const columns: Record<string, MeaningEntryV1> = {};
  for (const [name, value] of Object.entries((parsed.columns ?? {}) as Record<string, unknown>)) {
    const entry = asEntry(value);
    if (entry) columns[name] = entry;
  }
  const table = asEntry(parsed.table);
  const names = (parsed.table as { otherNames?: unknown } | undefined)?.otherNames;
  return {
    version: 1,
    id: parsed.id,
    relation: typeof parsed.relation === 'string' ? parsed.relation : parsed.id,
    columnsFingerprint: typeof parsed.columnsFingerprint === 'string' ? parsed.columnsFingerprint : '',
    ...(table ? { table: { ...table, ...(Array.isArray(names) ? { otherNames: names.filter((name): name is string => typeof name === 'string') } : {}) } } : {}),
    columns,
  };
}

const meaningFilesCache = new Map<string, { key: string; files: Map<string, MeaningFileV1> }>();

/** Every readable meaning file, by relation id. Reads again only when a file changed. */
export function readMeaningFiles(projectRoot: string): Map<string, MeaningFileV1> {
  const dir = join(projectRoot, MEANINGS_DIR);
  if (!existsSync(dir)) return new Map();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return new Map();
  }
  // A file removed while listing, or a link to nothing, is skipped, never thrown.
  const key = names.map((name) => {
    try {
      const stat = statSync(join(dir, name));
      return `${name}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${name}:gone`;
    }
  }).join('|');
  const cached = meaningFilesCache.get(dir);
  if (cached?.key === key) return cached.files;
  const files = new Map<string, MeaningFileV1>();
  for (const name of names) {
    try {
      const file = parseMeaningFile(readFileSync(join(dir, name), 'utf-8'));
      if (file) files.set(file.id, file);
    } catch { /* a file that doesn't parse says nothing; `zlens model meanings` lists it */ }
  }
  meaningFilesCache.set(dir, { key, files });
  return files;
}

/**
 * Whether any file holds words. A file can hold none: a table the drafter had
 * nothing to add to keeps one so the next run skips it. Only words make a
 * project one that uses meanings.
 */
export function meaningFilesHaveWords(files: Map<string, MeaningFileV1>): boolean {
  for (const file of files.values()) if (file.table || Object.keys(file.columns).length > 0) return true;
  return false;
}

/** Write one table's file. The rename means a reader never sees half a file. */
export function writeMeaningFile(projectRoot: string, file: MeaningFileV1): void {
  const path = meaningFilePath(projectRoot, file.id);
  mkdirSync(join(projectRoot, MEANINGS_DIR), { recursive: true });
  const body = {
    version: 1,
    id: file.id,
    relation: file.relation,
    columnsFingerprint: file.columnsFingerprint,
    ...(file.table ? { table: file.table } : {}),
    columns: file.columns,
  };
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, yaml.dump(body, { lineWidth: -1, sortKeys: false, noRefs: true, flowLevel: 2 }));
  renameSync(temporary, path);
}

/**
 * Whether a file was written against other columns than the table has now.
 * When only some of the columns can be seen, that can't be told, and the file
 * stands: a fresh clone keeps its drafts in use, and a draft run leaves them.
 */
export function meaningFileStale(file: Pick<MeaningFileV1, 'columnsFingerprint'>, relation: Pick<WarehouseCatalogRelationV1, 'columns' | 'columnsIncomplete'>): boolean {
  if (relation.columnsIncomplete) return false;
  return file.columnsFingerprint !== relationColumnsFingerprint(relation);
}

/**
 * The words that apply to a table: a person's words first, then the warehouse's
 * own comment, then a draft that isn't stale. A column the table no longer has
 * says nothing.
 */
export function relationMeaning(file: MeaningFileV1 | undefined, relation: Pick<WarehouseCatalogRelationV1, 'comment' | 'columns' | 'columnsIncomplete'>): RelationMeaning | undefined {
  if (!file) return undefined;
  const stale = meaningFileStale(file, relation);
  const usable = (entry: MeaningEntryV1 | undefined, comment: string | undefined): entry is MeaningEntryV1 => meaningEntryInUse(entry, stale, comment);
  const columns: RelationMeaning['columns'] = new Map();
  const entries = new Map(Object.entries(file.columns).map(([name, entry]) => [name.toLowerCase(), entry]));
  for (const column of relation.columns) {
    const key = column.name.toLowerCase();
    const entry = entries.get(key);
    if (usable(entry, column.comment)) columns.set(key, { text: entry.description, source: entry.source });
  }
  const table = file.table;
  const description = usable(table, relation.comment) ? { text: table.description, source: table.source } : undefined;
  const otherNames = table && (table.source === 'person' || !stale) ? table.otherNames ?? [] : [];
  if (!description && columns.size === 0 && otherNames.length === 0) return undefined;
  return { ...(description ? { description } : {}), otherNames, columns };
}

/** A catalog with its tables' words applied, for a reader outside Ask. */
export function catalogWithMeanings<T extends { relations: WarehouseCatalogRelationV1[] }>(projectRoot: string, snapshot: T): T {
  const files = readMeaningFiles(projectRoot);
  if (files.size === 0) return snapshot;
  return {
    ...snapshot,
    relations: snapshot.relations.map((relation) => {
      const meaning = relationMeaning(files.get(relation.id), relation);
      if (!meaning) return relation;
      return {
        ...relation,
        ...(meaning.description ? { comment: meaningText(meaning.description) } : {}),
        columns: relation.columns.map((column) => {
          const words = meaning.columns.get(column.name.toLowerCase());
          return words ? { ...column, comment: meaningText(words) } : column;
        }),
      };
    }),
  };
}

/** The words as a reader sees them: an unreviewed draft always says so. */
export function meaningText(words: { text: string; source: MeaningSource }): string {
  return words.source === 'ai' ? `AI draft: ${words.text}` : words.text;
}

/**
 * Whether an entry's words are the ones in use: a person's always; a draft only
 * while it's current and nothing the warehouse or dbt says covers the same thing.
 */
export function meaningEntryInUse(entry: MeaningEntryV1 | undefined, stale: boolean, comment: string | undefined): entry is MeaningEntryV1 {
  return Boolean(entry) && (entry!.source === 'person' || (!stale && !comment));
}

/** Whether a table's words include a draft nobody has reviewed. */
export function meaningHasDraft(meaning: RelationMeaning): boolean {
  return meaning.description?.source === 'ai' || [...meaning.columns.values()].some((column) => column.source === 'ai');
}
