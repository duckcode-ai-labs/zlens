/**
 * The warehouse catalog snapshot (RFC 0007, warehouse-first modeling).
 *
 * A team without a dbt project models its warehouse directly: `zlens sync
 * warehouse` reads the selected schemas' tables, views, columns, comments, declared
 * keys and view definitions into one snapshot, and modeling entities bind to
 * those relations with `relation:`. The snapshot holds metadata only, never a
 * row value. It is written deterministically (sorted, and fingerprinted without
 * its capture time) so a manifest built from it is reproducible, exactly as one
 * built from a dbt manifest.json is.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the snapshot lives, relative to the project root. */
export const WAREHOUSE_CATALOG_PATH = '.dql/warehouse-catalog.json';

export interface WarehouseCatalogColumnV1 {
  name: string;
  type?: string;
  comment?: string;
  nullable?: boolean;
}

export interface WarehouseCatalogForeignKeyV1 {
  /** Columns on this relation. */
  columns: string[];
  /** The referenced relation, as a qualified name (`database.schema.table` or `schema.table`). */
  references: { relation: string; columns: string[] };
  name?: string;
}

export interface WarehouseCatalogRelationV1 {
  /** Stable id: `warehouse.<database>.<schema>.<name>`, lower-cased, parts that are absent left out. */
  id: string;
  database?: string;
  schema?: string;
  name: string;
  /** The relation as queried: `database.schema.name` or `schema.name`, as the driver spells it. */
  relation: string;
  kind: 'table' | 'view' | 'materialized_view';
  comment?: string;
  columns: WarehouseCatalogColumnV1[];
  /**
   * The columns are only some of the table's: a dbt model's documented ones,
   * with no catalog.json or schema sync to list the rest (a fresh clone, say).
   * Nothing can be judged stale against them.
   */
  columnsIncomplete?: true;
  /** Declared primary key (enforced or informational). */
  primaryKey?: string[];
  foreignKeys?: WarehouseCatalogForeignKeyV1[];
  /** The view's definition, for lineage and join evidence. */
  viewSql?: string;
  /** From system statistics; never a COUNT(*). */
  rowCountEstimate?: number;
}

export interface WarehouseCatalogSnapshotV1 {
  version: 1;
  driver: string;
  connectionId: string;
  /** The scopes read, as `{ catalogOrDatabase, schemas }`. */
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  /** When the warehouse was read; not part of the fingerprint. */
  capturedAt: string;
  relations: WarehouseCatalogRelationV1[];
  /** sha256 of everything except `capturedAt` and this field. */
  fingerprint: string;
}

const lower = (value: string | undefined) => (value ?? '').replace(/["`\[\]]/g, '').trim().toLowerCase();

/** The stable id of a warehouse relation. */
export function warehouseRelationId(parts: { database?: string; schema?: string; name: string }): string {
  return ['warehouse', lower(parts.database), lower(parts.schema), lower(parts.name)].filter(Boolean).join('.');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Sort a snapshot's contents and compute its fingerprint. */
export function normalizeWarehouseCatalog(snapshot: Omit<WarehouseCatalogSnapshotV1, 'fingerprint'> & { fingerprint?: string }): WarehouseCatalogSnapshotV1 {
  const relations = [...snapshot.relations]
    .map((relation) => ({
      ...relation,
      columns: [...relation.columns],
      ...(relation.foreignKeys ? { foreignKeys: [...relation.foreignKeys].sort((a, b) => stable(a).localeCompare(stable(b))) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const scopes = [...snapshot.scopes]
    .map((scope) => ({ catalogOrDatabase: scope.catalogOrDatabase, schemas: [...scope.schemas].sort() }))
    .sort((a, b) => a.catalogOrDatabase.localeCompare(b.catalogOrDatabase));
  const body = { version: 1 as const, driver: snapshot.driver, connectionId: snapshot.connectionId, scopes, relations };
  const fingerprint = createHash('sha256').update(stable(body)).digest('hex');
  return { ...body, capturedAt: snapshot.capturedAt, fingerprint };
}

/** Write the snapshot to the project, sorted and fingerprinted. Returns what was written. */
export function writeWarehouseCatalog(projectRoot: string, snapshot: Omit<WarehouseCatalogSnapshotV1, 'fingerprint'>): WarehouseCatalogSnapshotV1 {
  const normalized = normalizeWarehouseCatalog(snapshot);
  const path = join(projectRoot, WAREHOUSE_CATALOG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/** Read the project's snapshot; `undefined` when there is none or it is not a v1 snapshot. */
export function readWarehouseCatalog(projectRoot: string): { snapshot?: WarehouseCatalogSnapshotV1; path: string; error?: string } {
  const path = join(projectRoot, WAREHOUSE_CATALOG_PATH);
  if (!existsSync(path)) return { path };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WarehouseCatalogSnapshotV1;
    if (parsed?.version !== 1 || !Array.isArray(parsed.relations)) return { path, error: 'not a version 1 warehouse catalog snapshot' };
    return { snapshot: parsed, path };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The snapshot relation an authored `relation:` names. Matching ignores case
 * and quoting and accepts `database.schema.name`, `schema.name` or a bare
 * `name`; a shorter spelling must match exactly one relation.
 */
export function resolveWarehouseRelation(
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
  reference: string,
): { relation?: WarehouseCatalogRelationV1; ambiguous?: WarehouseCatalogRelationV1[] } {
  const byId = snapshot.relations.find((relation) => relation.id === reference.trim().toLowerCase());
  if (byId) return { relation: byId };
  const parts = reference.split('.').map(lower).filter(Boolean);
  if (parts.length === 0) return {};
  const matches = snapshot.relations.filter((relation) => {
    const own = [lower(relation.database), lower(relation.schema), lower(relation.name)].filter(Boolean);
    return parts.length <= own.length && own.slice(own.length - parts.length).join('.') === parts.join('.');
  });
  if (matches.length === 1) return { relation: matches[0] };
  if (matches.length > 1) {
    // A fully qualified spelling that matches one relation exactly wins over suffix matches.
    const exact = matches.filter((relation) => [lower(relation.database), lower(relation.schema), lower(relation.name)].filter(Boolean).join('.') === parts.join('.'));
    return exact.length === 1 ? { relation: exact[0] } : { ambiguous: matches };
  }
  return {};
}

/** What changed in the warehouse between two catalog snapshots. */
export interface WarehouseCatalogDrift {
  addedRelations: string[];
  removedRelations: string[];
  /** `relation.column` */
  addedColumns: string[];
  /** `relation.column` */
  removedColumns: string[];
  /** `relation.column: before → after` */
  changedColumnTypes: string[];
  /** Relation ids whose columns or existence changed. */
  changedRelationIds: string[];
}

/**
 * Compare two snapshots. Relations match by id and columns by name, both
 * ignoring case; a column type change counts only when both sides report a
 * type.
 */
export function diffWarehouseCatalogs(
  previous: Pick<WarehouseCatalogSnapshotV1, 'relations'> | undefined,
  next: Pick<WarehouseCatalogSnapshotV1, 'relations'>,
): WarehouseCatalogDrift {
  const drift: WarehouseCatalogDrift = { addedRelations: [], removedRelations: [], addedColumns: [], removedColumns: [], changedColumnTypes: [], changedRelationIds: [] };
  if (!previous) return drift;
  const before = new Map(previous.relations.map((relation) => [relation.id, relation]));
  const after = new Map(next.relations.map((relation) => [relation.id, relation]));
  const changed = new Set<string>();
  for (const [id, relation] of after) {
    const old = before.get(id);
    if (!old) {
      drift.addedRelations.push(relation.relation);
      continue;
    }
    const oldColumns = new Map(old.columns.map((column) => [column.name.toLowerCase(), column]));
    const newColumns = new Map(relation.columns.map((column) => [column.name.toLowerCase(), column]));
    for (const [name, column] of newColumns) {
      const was = oldColumns.get(name);
      if (!was) {
        drift.addedColumns.push(`${relation.relation}.${column.name}`);
        changed.add(id);
      } else if (was.type && column.type && was.type.toLowerCase() !== column.type.toLowerCase()) {
        drift.changedColumnTypes.push(`${relation.relation}.${column.name}: ${was.type} → ${column.type}`);
        changed.add(id);
      }
    }
    for (const [name, column] of oldColumns) {
      if (!newColumns.has(name)) {
        drift.removedColumns.push(`${relation.relation}.${column.name}`);
        changed.add(id);
      }
    }
  }
  for (const [id, relation] of before) {
    if (!after.has(id)) {
      drift.removedRelations.push(relation.relation);
      changed.add(id);
    }
  }
  drift.changedRelationIds = [...changed].sort();
  for (const list of [drift.addedRelations, drift.removedRelations, drift.addedColumns, drift.removedColumns, drift.changedColumnTypes]) list.sort();
  return drift;
}
