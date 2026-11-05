import type {
  LocalContextPack,
  MetadataAllowedSqlRelation,
  MetadataCatalog,
  RuntimeSchemaColumn,
  RuntimeSchemaTable,
} from '../metadata/catalog.js';
import { metadataObjectToAllowedSqlRelation } from '../metadata/catalog.js';
import type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
} from '../metadata/sql-context-validation.js';
import { tableKey, tableName } from '@zlens/core';

const RELATION_OBJECT_TYPES = ['dbt_model', 'dbt_source', 'warehouse_table', 'runtime_table'];
const COLUMN_OBJECT_TYPES = ['dbt_column', 'runtime_column', 'warehouse_column'];

export interface GroundingExpansionRequest {
  question: string;
  sql: string;
  code: SqlContextValidationCode;
  offending?: SqlContextValidationOffending;
  contextPack?: LocalContextPack;
  schemaContext?: RuntimeSchemaTable[];
}

export interface GroundingExpansionResult {
  relations: MetadataAllowedSqlRelation[];
  schemaContext?: RuntimeSchemaTable[];
  notes: string[];
}

export type GroundingContextExpander = (
  request: GroundingExpansionRequest,
) => Promise<GroundingExpansionResult | undefined> | GroundingExpansionResult | undefined;

export interface MergedGroundingContext {
  contextPack?: LocalContextPack;
  schemaContext: RuntimeSchemaTable[];
  notes: string[];
}

export function applyGroundingExpansion(
  contextPack: LocalContextPack | undefined,
  schemaContext: RuntimeSchemaTable[] = [],
  expansion: GroundingExpansionResult | undefined,
): MergedGroundingContext {
  if (!expansion || (expansion.relations.length === 0 && (expansion.schemaContext?.length ?? 0) === 0)) {
    return { contextPack, schemaContext, notes: [] };
  }
  const relations = mergeAllowedRelations([
    ...(contextPack?.allowedSqlContext?.relations ?? []),
    ...expansion.relations,
  ]);
  const mergedPack = contextPack
    ? {
        ...contextPack,
        allowedSqlContext: {
          relations,
          sourceBlockSql: contextPack.allowedSqlContext?.sourceBlockSql ?? [],
        },
        warnings: uniqueStrings([
          ...(contextPack.warnings ?? []),
          ...expansion.notes.map((note) => `Re-grounded metadata context: ${note}`),
        ]),
      }
    : contextPack;
  return {
    contextPack: mergedPack,
    schemaContext: mergeRuntimeSchemaTables(schemaContext, expansion.schemaContext ?? relationsToRuntimeTables(expansion.relations)),
    notes: expansion.notes,
  };
}

export function expandGroundingFromCatalog(
  catalog: MetadataCatalog,
  request: GroundingExpansionRequest,
): GroundingExpansionResult | undefined {
  if (request.code !== 'unknown_relation' && request.code !== 'unknown_column') return undefined;
  // Resolve EVERY unknown relation in one pass. Re-grounding is budgeted to a
  // single attempt, so expanding only the first left multi-table SQL permanently
  // refused even though the missing tables were all sitting in the catalog.
  const relationNames = request.offending?.relations?.length
    ? request.offending.relations
    : request.offending?.relation
      ? [request.offending.relation]
      : [undefined];
  const columnName = request.offending?.column;
  const relations: MetadataAllowedSqlRelation[] = [];
  const runtimeTables: RuntimeSchemaTable[] = [];
  const notes: string[] = [];

  for (const relationName of relationNames) {
    for (const relation of findRuntimeRelations(catalog, relationName, columnName)) {
      relations.push(runtimeTableToAllowedRelation(relation, 'runtime schema snapshot'));
      runtimeTables.push(relation);
    }
    for (const relation of findCatalogRelations(catalog, relationName, columnName)) {
      relations.push(relation);
    }
  }

  // Scale the cap with how many relations we are actually resolving — a fixed 8
  // silently truncated a multi-table repair, re-creating the same refusal the
  // expansion exists to prevent. Still bounded so a broad match cannot flood the
  // prompt budget.
  const expansionLimit = Math.min(32, Math.max(8, relationNames.length * 6));
  const mergedRelations = mergeAllowedRelations(relations).slice(0, expansionLimit);
  const mergedRuntimeTables = mergeRuntimeSchemaTables(runtimeTables, relationsToRuntimeTables(mergedRelations)).slice(0, expansionLimit);
  for (const relation of mergedRelations) {
    const selectedColumns = columnName
      ? relation.columns.filter((column) => namesEqual(column.name, columnName)).map((column) => column.name)
      : relation.columns.slice(0, 6).map((column) => column.name);
    notes.push(`${relation.relation}${selectedColumns.length > 0 ? ` columns: ${selectedColumns.join(', ')}` : ''}`);
  }

  if (mergedRelations.length === 0 && mergedRuntimeTables.length === 0) return undefined;
  return {
    relations: mergedRelations,
    schemaContext: mergedRuntimeTables,
    notes: uniqueStrings(notes).slice(0, expansionLimit),
  };
}

function findRuntimeRelations(
  catalog: MetadataCatalog,
  relationName: string | undefined,
  columnName: string | undefined,
): RuntimeSchemaTable[] {
  const snapshot = catalog.latestRuntimeSchemaSnapshot();
  if (!snapshot) return [];
  return snapshot.tables.filter((table) => {
    if (relationName && !relationMatches(table.relation, relationName, table.name)) return false;
    if (columnName && !table.columns.some((column) => namesEqual(column.name, columnName))) return false;
    return Boolean(relationName || columnName);
  });
}

function findCatalogRelations(
  catalog: MetadataCatalog,
  relationName: string | undefined,
  columnName: string | undefined,
): MetadataAllowedSqlRelation[] {
  const relations: MetadataAllowedSqlRelation[] = [];
  catalog.scanObjects({ objectTypes: RELATION_OBJECT_TYPES, batchSize: 500 }, (objects) => {
    for (const object of objects) {
      const relation = metadataObjectToAllowedSqlRelation(object);
      if (!relation) continue;
      if (relationName && !relationMatches(relation.relation, relationName, relation.name)) continue;
      if (columnName && relation.columns.length > 0 && !relation.columns.some((column) => namesEqual(column.name, columnName))) continue;
      if (relationName || columnName) relations.push(relation);
    }
  });

  catalog.scanObjects({ objectTypes: COLUMN_OBJECT_TYPES, batchSize: 500 }, (objects) => {
    for (const object of objects) {
      if (columnName && !namesEqual(object.name, columnName)) continue;
      const relation = metadataObjectToAllowedSqlRelation(object);
      if (!relation) continue;
      if (relationName && !relationMatches(relation.relation, relationName, relation.name)) continue;
      relations.push(relation);
    }
  });
  return relations;
}

function runtimeTableToAllowedRelation(
  table: RuntimeSchemaTable,
  source: string,
): MetadataAllowedSqlRelation {
  return {
    relation: table.relation,
    name: table.name ?? (tableName(table.relation) || table.relation),
    source,
    columnCompleteness: 'complete',
    columns: table.columns,
  };
}

function relationsToRuntimeTables(relations: MetadataAllowedSqlRelation[]): RuntimeSchemaTable[] {
  return relations.map((relation) => ({
    relation: relation.relation,
    name: relation.name,
    source: relation.source,
    columnCompleteness: relation.columnCompleteness,
    columns: relation.columns,
  }));
}

function mergeAllowedRelations(relations: MetadataAllowedSqlRelation[]): MetadataAllowedSqlRelation[] {
  const byRelation = new Map<string, MetadataAllowedSqlRelation>();
  for (const relation of relations) {
    const key = tableKey(relation.relation, 'object');
    if (!key) continue;
    const existing = byRelation.get(key);
    if (!existing) {
      byRelation.set(key, {
          ...relation,
          columns: mergeColumns([], relation.columns),
      });
      continue;
    }
    const existingComplete = existing.columnCompleteness === 'complete';
    const incomingComplete = relation.columnCompleteness === 'complete';
    const authoritative = existingComplete
      ? mergeMatchingColumnMetadata(existing.columns, relation.columns)
      : incomingComplete
        ? mergeMatchingColumnMetadata(relation.columns, existing.columns)
        : mergeColumns(existing.columns, relation.columns);
    byRelation.set(key, {
      ...(incomingComplete && !existingComplete ? relation : existing),
      objectKey: existing.objectKey ?? relation.objectKey,
      source: existing.source === relation.source ? existing.source : 'expanded metadata context',
      columnCompleteness: mergeRelationCompleteness(existing.columnCompleteness, relation.columnCompleteness),
      columns: authoritative,
    });
  }
  return Array.from(byRelation.values());
}

function mergeRelationCompleteness(
  left: MetadataAllowedSqlRelation['columnCompleteness'],
  right: MetadataAllowedSqlRelation['columnCompleteness'],
): MetadataAllowedSqlRelation['columnCompleteness'] {
  // Only an EXPLICIT 'complete' marks the merged relation complete. Unknown
  // (undefined) stays advisory ('partial') so a freshly-expanded relation with a
  // guessed column list can't trigger a false unknown_column after re-grounding.
  if (left === 'complete' || right === 'complete') return 'complete';
  return 'partial';
}

function mergeRuntimeSchemaTables(
  left: RuntimeSchemaTable[],
  right: RuntimeSchemaTable[],
): RuntimeSchemaTable[] {
  const byRelation = new Map<string, RuntimeSchemaTable>();
  for (const table of [...left, ...right]) {
    const key = tableKey(table.relation, 'object');
    if (!key) continue;
    const existing = byRelation.get(key);
    if (!existing) {
      byRelation.set(key, {
          ...table,
          columns: mergeColumns([], table.columns),
      });
      continue;
    }
    const existingComplete = existing.columnCompleteness === 'complete';
    const incomingComplete = table.columnCompleteness === 'complete';
    byRelation.set(key, {
      ...(incomingComplete && !existingComplete ? table : existing),
      description: existing.description ?? table.description,
      source: existing.source === table.source ? existing.source : 'expanded metadata context',
      columnCompleteness: existingComplete || incomingComplete ? 'complete' : 'partial',
      columns: existingComplete
        ? mergeMatchingColumnMetadata(existing.columns, table.columns)
        : incomingComplete
          ? mergeMatchingColumnMetadata(table.columns, existing.columns)
          : mergeColumns(existing.columns, table.columns),
    });
  }
  return Array.from(byRelation.values());
}

/** Enrich an authoritative column set without adding names absent from it. */
function mergeMatchingColumnMetadata<T extends RuntimeSchemaColumn>(
  authoritative: T[],
  advisory: T[],
): T[] {
  const advisoryByName = new Map(advisory.map((column) => [normalizeName(column.name), column] as const));
  return authoritative.map((column) => {
    const metadata = advisoryByName.get(normalizeName(column.name));
    return {
      ...column,
      type: column.type ?? metadata?.type,
      description: column.description ?? metadata?.description,
      sampleValues: uniqueStrings([...(column.sampleValues ?? []), ...(metadata?.sampleValues ?? [])]).slice(0, 8),
    };
  });
}

function mergeColumns<T extends RuntimeSchemaColumn>(left: T[], right: T[]): T[] {
  const byName = new Map<string, T>();
  for (const column of [...left, ...right]) {
    const key = normalizeName(column.name);
    if (!key) continue;
    const existing = byName.get(key);
    byName.set(key, existing
      ? {
          ...existing,
          type: existing.type ?? column.type,
          description: existing.description ?? column.description,
          sampleValues: uniqueStrings([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])]).slice(0, 8),
        }
      : column);
  }
  return Array.from(byName.values());
}

function relationMatches(candidate: string, wanted: string, candidateName?: string): boolean {
  const wantedKeys = relationKeys(wanted);
  return Array.from(relationKeys(candidate)).some((key) => wantedKeys.has(key))
    || (candidateName ? Array.from(relationKeys(candidateName)).some((key) => wantedKeys.has(key)) : false);
}

function relationKeys(relation: string): Set<string> {
  const normalized = tableKey(relation, 'object');
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return keys;
}

function namesEqual(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value: string): string {
  return value.replace(/["`]/g, '').trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
