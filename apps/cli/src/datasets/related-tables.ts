import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bareRelation,
  collectDbtRelationshipTests,
  discoverDatasetJoins,
  withDatasetJoins,
  withoutSupersededEdges,
  type DatasetDescriptor,
  type DatasetJoin,
  type DQLManifest,
  type ManifestBlock,
  type ManifestModelRelationship,
  type ManifestRelationshipValidationEvidence,
  type RelatedRelationshipEdge,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';

/**
 * Fields from related tables (design D2), the server side: where the
 * relationships come from, which table a Dataset reads, the related tables'
 * columns, and the bounded check that the related key is unique before a
 * tile joins it.
 *
 * Relationships are read from the sources the project already has, never a
 * second store: the model (Modeling relationships, imported dbt and
 * MetricFlow relationships, with their warehouse check), joins "Draft my
 * models" drafted and checked in setup (open proposals), and dbt
 * `relationships` tests not yet modeled.
 */

type Columns = Array<{ name: string; type?: string }>;

interface ProposalLike {
  id: string;
  status?: string;
  operations?: ReadonlyArray<{ id?: string; kind?: string; change?: unknown }>;
}

export interface RelatedTablesSources {
  manifest: Pick<DQLManifest, 'modeling' | 'dbtProvenance'>;
  /** Context proposals, newest first (only open ones are drafts). */
  proposals?: ProposalLike[];
  warehouseCatalog?: Pick<WarehouseCatalogSnapshotV1, 'relations'>;
  /** The dbt manifest and catalog, parsed, when the project has them. */
  dbt?: { manifest?: Record<string, unknown>; catalog?: Record<string, unknown> };
}

export interface RelatedTablesContext {
  edges: RelatedRelationshipEdge[];
  columnsOf: (relation: string) => Columns | undefined;
}

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const tableName = (relation: string): string => bareRelation(relation).split('.').pop() ?? relation;

/** Which side's key the warehouse check found unique. */
function evidenceOf(validation: ManifestRelationshipValidationEvidence | undefined, current: boolean): RelatedRelationshipEdge['evidence'] {
  if (!validation) return undefined;
  if (validation.status !== 'passed') return { current: false, failed: true };
  const referenced = validation.scope === 'referenced_keys';
  const toMax = referenced ? validation.maxToPerReferencedKey ?? validation.maxToPerKey : validation.maxToPerKey;
  const fromMax = referenced ? validation.maxFromPerReferencedKey ?? validation.maxFromPerKey : validation.maxFromPerKey;
  return { current, toUnique: Number(toMax) <= 1, fromUnique: Number(fromMax) <= 1 };
}

function validationRecord(value: unknown): ManifestRelationshipValidationEvidence | undefined {
  const raw = object(value);
  const status = raw.status === 'passed' || raw.status === 'failed' || raw.status === 'error' ? raw.status : undefined;
  if (!status) return undefined;
  const number = (key: string) => (typeof raw[key] === 'number' ? raw[key] as number : Number(raw[key]) || 0);
  return {
    status,
    checkedAt: text(raw.checkedAt) ?? '',
    queryFingerprint: text(raw.queryFingerprint) ?? '',
    fromRows: number('fromRows'),
    toRows: number('toRows'),
    joinedRows: number('joinedRows'),
    fromNullKeys: number('fromNullKeys'),
    toNullKeys: number('toNullKeys'),
    unmatchedFrom: number('unmatchedFrom'),
    maxFromPerKey: number('maxFromPerKey'),
    maxToPerKey: number('maxToPerKey'),
    ...(raw.maxToPerReferencedKey !== undefined ? { maxToPerReferencedKey: number('maxToPerReferencedKey') } : {}),
    ...(raw.maxFromPerReferencedKey !== undefined ? { maxFromPerReferencedKey: number('maxFromPerReferencedKey') } : {}),
    ...(raw.scope === 'referenced_keys' ? { scope: 'referenced_keys' as const } : {}),
  };
}

const CARDINALITIES = new Set(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many', 'unknown']);

/** Every relationship the project knows, as edges between relations. */
export function relatedTablesContext(sources: RelatedTablesSources): RelatedTablesContext {
  const nodes = sources.manifest.dbtProvenance?.nodes ?? {};
  const entities = sources.manifest.modeling?.entities ?? {};
  const relationOfNode = (uniqueId: string | undefined) => (uniqueId ? text(nodes[uniqueId]?.relation) : undefined);
  const nameOfNode = (uniqueId: string | undefined, relation: string) => (uniqueId ? text(nodes[uniqueId]?.name) : undefined) ?? tableName(relation);
  const edges: RelatedRelationshipEdge[] = [];

  // The model: Modeling relationships and the dbt / MetricFlow ones imported into it.
  for (const relationship of Object.values(sources.manifest.modeling?.relationships ?? {}) as ManifestModelRelationship[]) {
    if (relationship.status === 'deprecated') continue;
    const fromId = entities[relationship.from]?.dbtUniqueId;
    const toId = entities[relationship.to]?.dbtUniqueId;
    const fromRelation = relationOfNode(fromId);
    const toRelation = relationOfNode(toId);
    if (!fromRelation || !toRelation) continue;
    const certified = relationship.status === 'certified' && !relationship.staleCertification;
    edges.push({
      id: relationship.qualifiedId ?? relationship.id,
      origin: 'model',
      fromRelation,
      toRelation,
      fromTable: nameOfNode(fromId, fromRelation),
      toTable: nameOfNode(toId, toRelation),
      keys: relationship.keys.map((pair) => ({ from: pair.from, to: pair.to })),
      cardinality: relationship.cardinality,
      certified,
      evidence: evidenceOf(relationship.validation, certified && relationship.automaticJoinAllowed),
      // Certified once, changed since: keep who certified it and when (T4).
      ...(!certified && relationship.status === 'certified' && relationship.certification?.at
        ? { previousCertification: { at: relationship.certification.at, ...(relationship.certification.by ? { by: relationship.certification.by } : {}), ...(relationship.certification.name ? { name: relationship.certification.name } : {}) } }
        : {}),
    });
  }

  // Joins drafted (and checked on the data) by "Draft my models" or another open proposal.
  for (const proposal of sources.proposals ?? []) {
    if (proposal.status !== 'proposed') continue;
    const drafted = new Map<string, string>();
    const changes = (proposal.operations ?? []).flatMap((operation) => {
      const change = object(operation.change);
      return operation.kind === 'modeling_change' && change.operation ? [{ operation, change }] : [];
    });
    for (const { change } of changes) {
      const value = object(change.value);
      if (change.operation !== 'upsert_entity') continue;
      const id = text(value.id);
      const domain = text(value.domain) ?? '';
      const node = text(value.dbtModel);
      if (id && node) drafted.set(`${domain}::${id}`, node);
    }
    const nodeOfEntity = (reference: string, domain: string): string | undefined => {
      const scoped = reference.includes('::entity::') ? reference.replace('::entity::', '::') : `${domain}::${reference}`;
      const [scopeDomain, localId] = [scoped.slice(0, scoped.lastIndexOf('::')), scoped.slice(scoped.lastIndexOf('::') + 2)];
      return drafted.get(scoped)
        ?? entities[`${scopeDomain}::entity::${localId}`]?.dbtUniqueId
        ?? Object.values(entities).find((entity) => entity.domain === scopeDomain && entity.localId === localId)?.dbtUniqueId;
    };
    for (const { operation, change } of changes) {
      if (change.operation !== 'upsert_relationship') continue;
      const value = object(change.value);
      const domain = text(value.domain) ?? '';
      const from = text(value.from);
      const to = text(value.to);
      const cardinality = text(value.cardinality) ?? 'unknown';
      if (!from || !to || !CARDINALITIES.has(cardinality)) continue;
      const fromId = nodeOfEntity(from, domain);
      const toId = nodeOfEntity(to, domain);
      const fromRelation = relationOfNode(fromId);
      const toRelation = relationOfNode(toId);
      if (!fromRelation || !toRelation) continue;
      const keys = (Array.isArray(value.keys) ? value.keys : []).flatMap((pair) => {
        const record = object(pair);
        return text(record.from) && text(record.to) ? [{ from: text(record.from)!, to: text(record.to)! }] : [];
      });
      if (!keys.length) continue;
      edges.push({
        id: `${proposal.id}:${text(operation.id) ?? text(value.id) ?? `${from}_${to}`}`,
        origin: 'drafted',
        fromRelation,
        toRelation,
        fromTable: nameOfNode(fromId, fromRelation),
        toTable: nameOfNode(toId, toRelation),
        keys,
        cardinality: cardinality as RelatedRelationshipEdge['cardinality'],
        certified: false,
        evidence: evidenceOf(validationRecord(value.validation), false),
      });
    }
  }

  // dbt `relationships` tests: every value is found on the other side; the
  // other side's key uniqueness is checked on the warehouse before use.
  if (sources.dbt?.manifest) {
    for (const test of collectDbtRelationshipTests(sources.dbt.manifest)) {
      if (test.fromColumn === 'unknown' || test.toColumn === 'unknown') continue;
      const fromRelation = relationOfNode(test.fromDbtUniqueId);
      const toRelation = relationOfNode(test.toDbtUniqueId);
      if (!fromRelation || !toRelation) continue;
      edges.push({
        id: test.testUniqueId,
        origin: 'dbt_test',
        fromRelation,
        toRelation,
        fromTable: nameOfNode(test.fromDbtUniqueId, fromRelation),
        toTable: nameOfNode(test.toDbtUniqueId, toRelation),
        keys: [{ from: test.fromColumn, to: test.toColumn }],
        cardinality: 'many_to_one',
        certified: false,
      });
    }
  }

  // Columns: the warehouse catalog, then the dbt catalog (and manifest columns).
  const columns = new Map<string, Columns>();
  for (const relation of sources.warehouseCatalog?.relations ?? []) {
    columns.set(bareRelation(relation.relation), relation.columns.map((column) => ({ name: column.name, ...(column.type ? { type: column.type } : {}) })));
  }
  const dbtNodes = { ...object(object(sources.dbt?.manifest).nodes), ...object(object(sources.dbt?.manifest).sources) };
  const dbtCatalog = { ...object(object(sources.dbt?.catalog).nodes), ...object(object(sources.dbt?.catalog).sources) };
  for (const [uniqueId, node] of Object.entries(nodes)) {
    const relation = text(node.relation);
    if (!relation || node.resourceType === 'warehouse' || columns.has(bareRelation(relation))) continue;
    const fromCatalog = Object.values(object(object(dbtCatalog[uniqueId]).columns)).flatMap((column) => {
      const record = object(column);
      return text(record.name) ? [{ name: text(record.name)!, ...(text(record.type) ? { type: text(record.type)! } : {}) }] : [];
    });
    const fromManifest = Object.values(object(object(dbtNodes[uniqueId]).columns)).flatMap((column) => {
      const record = object(column);
      return text(record.name) ? [{ name: text(record.name)!, ...(text(record.data_type) ? { type: text(record.data_type)! } : {}) }] : [];
    });
    const list = fromCatalog.length ? fromCatalog : fromManifest;
    if (list.length) columns.set(bareRelation(relation), list);
  }
  return { edges, columnsOf: (relation) => columns.get(bareRelation(relation)) };
}

const COMPLEX_SOURCE = /\b(join|group\s+by|union|intersect|except|having|distinct|qualify|window|over\s*\()/i;

/**
 * The one table a Dataset block reads, when it reads exactly one table with
 * a plain SELECT (Start from a table writes these). A block that joins,
 * groups or unions is not a table Dataset: its rows are not a table's rows.
 */
export function datasetBaseRelation(block: Pick<ManifestBlock, 'sql' | 'rawTableRefs' | 'tableDependencies' | 'refDependencies'>, known: (relation: string) => boolean): string | undefined {
  const refs = [...new Set((block.rawTableRefs?.length ? block.rawTableRefs : block.tableDependencies ?? []).map((ref) => ref.trim()).filter(Boolean))];
  if (refs.length !== 1 || (block.refDependencies?.length ?? 0) > 0) return undefined;
  const sql = (block.sql ?? '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!/^\s*select\b/i.test(sql) || COMPLEX_SOURCE.test(sql)) return undefined;
  return known(refs[0]!) ? refs[0] : undefined;
}

/** A relation as SQL names it: kept when already quoted, else each part quoted for the dialect. */
export function relationSql(relation: string, quote: (identifier: string) => string): string {
  const trimmed = relation.trim();
  if (/["`\[]/.test(trimmed)) return trimmed;
  return trimmed.split('.').map((part) => quote(part.trim())).join('.');
}

/**
 * A table reference as the relationships name it. The warehouse listing says
 * "dev.orders" where a dbt manifest says "jaffle_shop"."dev"."orders": a
 * reference with fewer parts matches the one known relation it ends with,
 * never two.
 */
export function relationResolver(context: Pick<RelatedTablesContext, 'edges'>): (reference: string) => string | undefined {
  const relations = new Set(context.edges.flatMap((edge) => [bareRelation(edge.fromRelation), bareRelation(edge.toRelation)]));
  return (reference: string) => {
    const bare = bareRelation(reference);
    if (relations.has(bare)) return bare;
    const matches = [...relations].filter((relation) => relation.endsWith(`.${bare}`));
    return matches.length === 1 ? matches[0] : undefined;
  };
}

/**
 * The descriptor with the related fields of the tables its base table
 * reaches through checked many-to-one joins; the same descriptor when it
 * reads no single table or the model knows no such join.
 */
export function decorateDatasetDescriptor(input: {
  descriptor: DatasetDescriptor;
  block: Pick<ManifestBlock, 'sql' | 'rawTableRefs' | 'tableDependencies' | 'refDependencies'>;
  context: RelatedTablesContext;
  quote: (identifier: string) => string;
}): DatasetDescriptor {
  const { descriptor, context } = input;
  if (descriptor.kind !== 'block' || descriptor.result || descriptor.grain.aggregate || !context.edges.length) return descriptor;
  const resolve = relationResolver(context);
  const reference = datasetBaseRelation(input.block, (candidate) => Boolean(resolve(candidate)));
  const base = reference ? resolve(reference) : undefined;
  if (!base) return descriptor;
  const discovered = discoverDatasetJoins({ descriptor, baseRelation: base, edges: context.edges, columnsOf: context.columnsOf });
  return withDatasetJoins(descriptor, {
    ...discovered,
    joins: discovered.joins.map((join) => ({ ...join, relation: relationSql(join.relation, input.quote) })),
  });
}

/**
 * The bounded check that a join cannot add rows: does any key value appear
 * more than once on the related table? One row comes back at most.
 */
export function joinUniquenessSql(join: Pick<DatasetJoin, 'relation' | 'keys'>, quote: (identifier: string) => string): string {
  const keys = join.keys.map((pair) => quote(pair.to));
  return [
    'SELECT 1 AS dql_repeated_key',
    `FROM ${join.relation}`,
    `WHERE ${keys.map((key) => `${key} IS NOT NULL`).join(' AND ')}`,
    `GROUP BY ${keys.join(', ')}`,
    'HAVING COUNT(*) > 1',
    'LIMIT 1',
  ].join('\n');
}

/** The plain refusal when a related table repeats a key. */
export function joinRepeatsKeyMessage(join: Pick<DatasetJoin, 'table' | 'keys' | 'sentence'>, datasetLabel: string): string {
  const keys = join.keys.map((pair) => pair.to).join(', ');
  return `JOIN_KEY_NOT_UNIQUE: ${join.table} has more than one row for some ${keys} values, so joining it to ${datasetLabel} would count rows more than once. The model says "${join.sentence}", but the data does not; check the join in Modeling.`;
}

/**
 * The dbt manifest and catalog a project points at, parsed once per
 * fingerprint. Missing or unreadable files read as absent.
 */
const dbtArtifactCache = new Map<string, { manifest?: Record<string, unknown>; catalog?: Record<string, unknown> }>();
export function readDbtArtifacts(provenance: DQLManifest['dbtProvenance']): { manifest?: Record<string, unknown>; catalog?: Record<string, unknown> } | undefined {
  const manifestPath = provenance?.manifestPath;
  if (!manifestPath || !existsSync(manifestPath)) return undefined;
  const key = `${manifestPath}:${provenance?.manifestFingerprint ?? ''}:${provenance?.catalogFingerprint ?? ''}`;
  const cached = dbtArtifactCache.get(key);
  if (cached) return cached;
  const read = (path: string | undefined) => {
    if (!path || !existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
  };
  const artifacts = { manifest: read(manifestPath), catalog: read(provenance?.catalogPath ?? join(dirname(manifestPath), 'catalog.json')) };
  dbtArtifactCache.clear();
  dbtArtifactCache.set(key, artifacts);
  return artifacts;
}

/**
 * The tables a table reaches through a many-to-one join (each order has one
 * customer), by name, for the Add data list ("joins customers, locations").
 */
export function joinableTables(context: RelatedTablesContext, relation: string): string[] {
  // "dev.orders" from the warehouse listing is "jaffle_shop"."dev"."orders" in a dbt project's relationships.
  const base = relationResolver(context)(relation) ?? bareRelation(relation);
  const names = new Set<string>();
  // One table per foreign key, as the field list follows it (orders.customer_id → customers, not also stg_customers).
  for (const edge of withoutSupersededEdges(context.edges)) {
    if (edge.evidence?.failed) continue;
    const forward = bareRelation(edge.fromRelation) === base && (edge.cardinality === 'many_to_one' || edge.cardinality === 'one_to_one') && edge.evidence?.toUnique !== false;
    const backward = bareRelation(edge.toRelation) === base && (edge.cardinality === 'one_to_many' || edge.cardinality === 'one_to_one') && edge.evidence?.fromUnique !== false;
    if (forward && bareRelation(edge.toRelation) !== base) names.add(edge.toTable);
    if (backward && bareRelation(edge.fromRelation) !== base) names.add(edge.fromTable);
  }
  return [...names].sort();
}
