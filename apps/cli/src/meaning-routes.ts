/**
 * What the review screen reads and writes: every table's standing, one table's
 * words, a person's edit, and Accept. See meaning-files.ts for what each source
 * of words may do. Accepting takes the AI label off; it certifies nothing.
 */

import { dbtMeaningRelations } from '@zlens/agent';
import {
  meaningEntryInUse,
  meaningFileStale,
  readMeaningFiles,
  readWarehouseCatalog,
  relationColumnsFingerprint,
  resolveDbtManifestPath,
  writeMeaningFile,
  type DQLManifest,
  type MeaningEntryV1,
  type MeaningFileV1,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';

/**
 * Every table meanings can be written for: the warehouse catalog, and a dbt
 * project's models and sources. A table dbt models counts once, as dbt's.
 */
export function meaningCatalog(projectRoot: string): { relations: WarehouseCatalogRelationV1[]; fingerprint?: string } | undefined {
  const { snapshot } = readWarehouseCatalog(projectRoot);
  const manifestPath = resolveDbtManifestPath(projectRoot);
  const dbt = manifestPath ? dbtMeaningRelations(manifestPath) : [];
  if (!snapshot && dbt.length === 0) return undefined;
  const tail = (relation: string) => relation.toLowerCase().split('.').slice(-2).join('.');
  const modeled = new Set(dbt.map((relation) => tail(relation.relation)));
  return {
    relations: [...dbt, ...(snapshot?.relations ?? []).filter((relation) => !modeled.has(tail(relation.relation)))],
    ...(snapshot ? { fingerprint: snapshot.fingerprint } : {}),
  };
}

export type MeaningTableState = 'needs_review' | 'reviewed' | 'stale' | 'described' | 'undescribed';

export interface MeaningTableSummary {
  id: string;
  relation: string;
  schema?: string;
  name: string;
  kind: WarehouseCatalogRelationV1['kind'];
  /** The domain whose model binds this table; absent when none does. */
  domain?: string;
  state: MeaningTableState;
  description?: string;
  /** Who wrote the description: `warehouse` for a comment. */
  source?: 'ai' | 'person' | 'warehouse';
  columns: number;
  describedColumns: number;
  drafts: number;
}

export interface MeaningTableDetail extends MeaningTableSummary {
  otherNames: string[];
  model?: string;
  date?: string;
  /** What the draft was read from. */
  evidence: string[];
  columnDetails: Array<{ name: string; type?: string; description?: string; source?: 'ai' | 'person' | 'warehouse'; model?: string; date?: string }>;
}

const MAX_DESCRIPTION_CHARS = 500;
const MAX_OTHER_NAMES = 12;

function domainsByRelation(manifest: DQLManifest | undefined): Map<string, string> {
  const domains = new Map<string, string>();
  for (const entity of Object.values(manifest?.modeling?.entities ?? {})) {
    if (entity.dbtUniqueId && entity.domain && !domains.has(entity.dbtUniqueId)) domains.set(entity.dbtUniqueId, entity.domain);
  }
  return domains;
}

function summarize(relation: WarehouseCatalogRelationV1, file: MeaningFileV1 | undefined, domain: string | undefined): MeaningTableSummary {
  const entries = new Map(Object.entries(file?.columns ?? {}).map(([name, entry]) => [name.toLowerCase(), entry]));
  const stale = file ? meaningFileStale(file, relation) : false;
  const comments = new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.comment]));
  // Only what is in use counts: a draft behind a comment is hidden everywhere,
  // so it is neither shown, counted nor offered for Accept.
  const live = [
    ...(meaningEntryInUse(file?.table, stale, relation.comment) ? [file!.table!] : []),
    ...[...entries].filter(([name, entry]) => comments.has(name) && meaningEntryInUse(entry, stale, comments.get(name))).map(([, entry]) => entry),
  ];
  const drafts = live.filter((entry) => entry.source === 'ai').length;
  // Drafts that would be in use but for a column change: these want a redraft.
  const staleDrafts = stale && (
    (file?.table?.source === 'ai' && !relation.comment)
    || [...entries].some(([name, entry]) => entry.source === 'ai' && comments.has(name) && !comments.get(name))
  );
  const describedColumns = relation.columns.filter((column) => column.comment || meaningEntryInUse(entries.get(column.name.toLowerCase()), stale, undefined)).length;
  const table = meaningEntryInUse(file?.table, stale, relation.comment) ? file!.table : undefined;
  const state: MeaningTableState = staleDrafts
    ? 'stale'
    : drafts > 0
      ? 'needs_review'
      : live.length > 0
        ? 'reviewed'
        : relation.comment || describedColumns > 0
          ? 'described'
          : 'undescribed';
  const description = table?.description ?? relation.comment;
  return {
    id: relation.id,
    relation: relation.relation,
    ...(relation.schema ? { schema: relation.schema } : {}),
    name: relation.name,
    kind: relation.kind,
    ...(domain ? { domain } : {}),
    state,
    ...(description ? { description, source: table ? table.source : 'warehouse' as const } : {}),
    columns: relation.columns.length,
    describedColumns,
    drafts,
  };
}

/** Every table's standing, in a fixed order. */
export function meaningsOverview(projectRoot: string, snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>, manifest: DQLManifest | undefined): MeaningTableSummary[] {
  const files = readMeaningFiles(projectRoot);
  const domains = domainsByRelation(manifest);
  return [...snapshot.relations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((relation) => summarize(relation, files.get(relation.id), domains.get(relation.id)));
}

/** One table's words, column by column. */
export function meaningTableDetail(projectRoot: string, snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>, manifest: DQLManifest | undefined, id: string): MeaningTableDetail | undefined {
  const relation = snapshot.relations.find((item) => item.id === id);
  if (!relation) return undefined;
  const file = readMeaningFiles(projectRoot).get(id);
  const entries = new Map(Object.entries(file?.columns ?? {}).map(([name, entry]) => [name.toLowerCase(), entry]));
  const stale = file ? meaningFileStale(file, relation) : false;
  // A stale draft's names, model and evidence are not offered: saving the
  // screen would otherwise make them a person's words.
  // Other names are in use whenever their draft is current, even where a comment covers the description.
  const table = file?.table && (file.table.source === 'person' || !stale) ? file.table : undefined;
  return {
    ...summarize(relation, file, domainsByRelation(manifest).get(id)),
    otherNames: table?.otherNames ?? [],
    ...(table?.model ? { model: table.model } : {}),
    ...(table?.date ? { date: table.date } : {}),
    evidence: table?.evidence ?? [],
    columnDetails: relation.columns.map((column) => {
      const entry = entries.get(column.name.toLowerCase());
      const usable = meaningEntryInUse(entry, stale, column.comment) ? entry : undefined;
      return {
        name: column.name,
        ...(column.type ? { type: column.type } : {}),
        ...(usable
          ? { description: usable.description, source: usable.source, ...(usable.model ? { model: usable.model } : {}), ...(usable.date ? { date: usable.date } : {}) }
          : column.comment
            ? { description: column.comment, source: 'warehouse' as const }
            : {}),
      };
    }),
  };
}

function emptyFile(relation: WarehouseCatalogRelationV1): MeaningFileV1 {
  return { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: relationColumnsFingerprint(relation), columns: {} };
}

const trimmed = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);

/**
 * A person's edit. An empty description removes that entry. What is not named
 * is left as it is, so saving one column doesn't review the rest of the table.
 * Other names belong to a table's description, so they need one.
 */
export function saveMeaningEdit(
  projectRoot: string,
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
  edit: { id: string; description?: string; otherNames?: string[]; columns?: Record<string, string> },
  date: string,
): 'saved' | 'no_table' | 'needs_description' {
  const relation = snapshot.relations.find((item) => item.id === edit.id);
  if (!relation) return 'no_table';
  const file = readMeaningFiles(projectRoot).get(edit.id) ?? emptyFile(relation);
  const next: MeaningFileV1 = { ...file, columns: { ...file.columns } };
  const person = (description: string): MeaningEntryV1 => ({ description, source: 'person', date });
  const stale = meaningFileStale(file, relation);
  // What the table says now: only words in use carry over into a person's save.
  const current = meaningEntryInUse(file.table, stale, relation.comment) ? file.table : undefined;
  const names = edit.otherNames === undefined
    ? current?.otherNames ?? []
    : [...new Set(edit.otherNames.map(trimmed).filter(Boolean))].slice(0, MAX_OTHER_NAMES);
  const description = edit.description === undefined ? current?.description ?? '' : trimmed(edit.description);
  if (edit.description !== undefined || edit.otherNames !== undefined) {
    if (!description && names.length > 0) return 'needs_description';
    if (description) next.table = { ...person(description), ...(names.length ? { otherNames: names } : {}) };
    else delete next.table;
  }
  const known = new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.name]));
  for (const [name, text] of Object.entries(edit.columns ?? {})) {
    const column = known.get(name.toLowerCase());
    if (!column) continue;
    const words = trimmed(text);
    if (words) next.columns[column] = person(words);
    else delete next.columns[column];
  }
  writeMeaningFile(projectRoot, next);
  return 'saved';
}

/**
 * Accept: a person read these drafts and keeps them. The words stay and the AI
 * label comes off. A stale draft can't be accepted: the columns it describes
 * have changed, so it has to be redrafted or edited first.
 */
export function acceptMeanings(
  projectRoot: string,
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
  ids: string[],
  date: string,
): { accepted: number; skippedStale: number } {
  const files = readMeaningFiles(projectRoot);
  const outcome = { accepted: 0, skippedStale: 0 };
  for (const id of new Set(ids)) {
    const relation = snapshot.relations.find((item) => item.id === id);
    const file = files.get(id);
    if (!relation || !file) continue;
    if (!Object.values(file.columns).some((entry) => entry.source === 'ai') && file.table?.source !== 'ai') continue;
    if (meaningFileStale(file, relation)) {
      outcome.skippedStale += 1;
      continue;
    }
    // Only drafts in use are accepted. A draft behind a warehouse comment or a
    // dbt description was never shown, so it stays a draft, out of use.
    const comments = new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.comment]));
    const reviewed = (entry: MeaningEntryV1, comment: string | undefined): MeaningEntryV1 => {
      if (entry.source !== 'ai' || comment) return entry;
      const { evidence: _evidence, ...kept } = entry;
      return { ...kept, source: 'person', date };
    };
    writeMeaningFile(projectRoot, {
      ...file,
      ...(file.table ? { table: { ...reviewed(file.table, relation.comment), ...(file.table.otherNames ? { otherNames: file.table.otherNames } : {}) } } : {}),
      columns: Object.fromEntries(Object.entries(file.columns).map(([name, entry]) => [name, reviewed(entry, comments.get(name.toLowerCase()))])),
    });
    outcome.accepted += 1;
  }
  return outcome;
}
