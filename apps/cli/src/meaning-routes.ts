/**
 * What the review screen reads and writes: every table's standing, one table's
 * words, a person's edit, and Accept. See meaning-files.ts for what each source
 * of words may do. Accepting takes the AI label off; it certifies nothing.
 */

import { dbtMeaningRelations } from '@zlens/agent';
import {
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
  const written = [...(file?.table ? [file.table] : []), ...entries.values()];
  const drafts = written.filter((entry) => entry.source === 'ai').length;
  const inUse = (name: string) => {
    const entry = entries.get(name.toLowerCase());
    return entry !== undefined && (entry.source === 'person' || !stale);
  };
  const describedColumns = relation.columns.filter((column) => column.comment || inUse(column.name)).length;
  const table = file?.table;
  const state: MeaningTableState = drafts > 0 && stale
    ? 'stale'
    : drafts > 0
      ? 'needs_review'
      : written.length > 0
        ? 'reviewed'
        : relation.comment || describedColumns > 0
          ? 'described'
          : 'undescribed';
  const description = table && !(table.source === 'ai' && (relation.comment || stale)) ? table.description : relation.comment;
  return {
    id: relation.id,
    relation: relation.relation,
    ...(relation.schema ? { schema: relation.schema } : {}),
    name: relation.name,
    kind: relation.kind,
    ...(domain ? { domain } : {}),
    state,
    ...(description ? { description, source: description === relation.comment ? 'warehouse' as const : table!.source } : {}),
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
  return {
    ...summarize(relation, file, domainsByRelation(manifest).get(id)),
    otherNames: file?.table?.otherNames ?? [],
    ...(file?.table?.model ? { model: file.table.model } : {}),
    ...(file?.table?.date ? { date: file.table.date } : {}),
    evidence: file?.table?.evidence ?? [],
    columnDetails: relation.columns.map((column) => {
      const entry = entries.get(column.name.toLowerCase());
      const usable = entry && (entry.source === 'person' || (!stale && !column.comment)) ? entry : undefined;
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
  const names = edit.otherNames === undefined
    ? file.table?.otherNames ?? []
    : [...new Set(edit.otherNames.map(trimmed).filter(Boolean))].slice(0, MAX_OTHER_NAMES);
  const description = edit.description === undefined ? file.table?.description ?? '' : trimmed(edit.description);
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
    const reviewed = (entry: MeaningEntryV1): MeaningEntryV1 => {
      if (entry.source !== 'ai') return entry;
      const { evidence: _evidence, ...kept } = entry;
      return { ...kept, source: 'person', date };
    };
    const columnsChanged = Object.values(file.columns).some((entry) => entry.source === 'ai');
    if (!columnsChanged && file.table?.source !== 'ai') continue;
    if (meaningFileStale(file, relation)) {
      outcome.skippedStale += 1;
      continue;
    }
    writeMeaningFile(projectRoot, {
      ...file,
      ...(file.table ? { table: { ...reviewed(file.table), ...(file.table.otherNames ? { otherNames: file.table.otherNames } : {}) } } : {}),
      columns: Object.fromEntries(Object.entries(file.columns).map(([name, entry]) => [name, reviewed(entry)])),
    });
    outcome.accepted += 1;
  }
  return outcome;
}
