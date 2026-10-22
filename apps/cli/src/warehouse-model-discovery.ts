/**
 * Draft a model from the warehouse itself (RFC 0007, `zlens model discover` in
 * warehouse-first and hybrid modeling).
 *
 * The warehouse catalog snapshot already holds what a person would use to
 * draw the map by hand: tables and their comments, declared primary and
 * foreign keys, view definitions that join tables, and column names that say
 * which table they point at. This turns that evidence into draft domains,
 * entities and relationships, each relationship citing why it was proposed.
 * Optionally it asks the warehouse how each join behaves, with the same one
 * statement the Modeling page's Validate uses, and proposes the cardinality it
 * saw. Everything stays a draft: AI and heuristics draft, people certify.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isTechnicalSchema,
  meaningfulDatabaseName,
  resolveWarehouseRelation,
  sentenceCaseName,
  stagingDuplicates,
  type DQLManifest,
  type ManifestFanoutPolicy,
  type ManifestRelationshipCardinality,
  type ManifestRelationshipValidationEvidence,
  type ModelingAuthoringChange,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';
import { looksLikePlaceholder, profileRelationshipOnWarehouse, suggestRelationshipKeys } from '@zlens/agent';

export type RelationshipEvidenceSource = 'declared_foreign_key' | 'view_join' | 'query_history' | 'shared_key' | 'named_for_table' | 'same_name';

/** A join seen in the warehouse's recent query history, and how often. */
export interface ObservedJoin {
  left: { relation: string; column: string };
  right: { relation: string; column: string };
  count: number;
}

export interface DiscoveredDomain {
  id: string;
  name: string;
  /** Already a Domain Package in the project. */
  existing: boolean;
}

export interface DiscoveredEntity {
  id: string;
  domain: string;
  relationId: string;
  relation: string;
  kind: WarehouseCatalogRelationV1['kind'];
  businessName: string;
  description?: string;
  grain?: string;
  keys: string[];
  /** Where the grain came from: a declared primary key, or a naming-convention column the warehouse showed unique. */
  grainSource?: 'primary_key' | 'unique_column';
  /** A naming-convention key not yet shown unique; the grain stays unset until it is. */
  grainCandidate?: string;
  /** The qualified id of the entity that already binds this relation. */
  existing?: string;
}

export interface DiscoveredRelationship {
  id: string;
  domain: string;
  from: string;
  to: string;
  fromDomain: string;
  toDomain: string;
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  evidence: Array<{ source: RelationshipEvidenceSource; reason: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  /** From the warehouse, when discovery ran with validation. */
  validation?: ManifestRelationshipValidationEvidence;
  /** Why validation could not run for this relationship. */
  validationError?: string;
}

/** A drafted join discovery holds back, with the reason, so a person can still write it knowingly. */
export interface WithheldRelationship extends DiscoveredRelationship {
  reason: string;
}

/** A join discovery found again but does not propose, because a reviewer removed or rejected it. */
export interface DismissedRelationship {
  from: string;
  to: string;
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  reason: string;
}

/**
 * What reviewers decided about drafted joins, kept in `.dql/modeling-discovery.json`
 * (shared in git, like the catalog snapshot): a join discovery wrote as a
 * draft (`applied`) and one a reviewer turned down (`rejected`). A join that
 * was applied and is no longer modeled was removed by a reviewer; neither is
 * proposed again.
 */
export interface DiscoveryDecision {
  /** Warehouse relation ids, as the catalog snapshot names them. */
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  decision: 'applied' | 'rejected';
  at: string;
  reason?: string;
}

export interface DiscoveryLedgerV1 {
  version: 1;
  relationships: DiscoveryDecision[];
}

export const DISCOVERY_LEDGER_PATH = '.dql/modeling-discovery.json';

export interface WarehouseDiscoveryReport {
  catalogFingerprint: string;
  capturedAt: string;
  relations: number;
  domains: DiscoveredDomain[];
  entities: DiscoveredEntity[];
  relationships: DiscoveredRelationship[];
  /** Relationships already modeled, left alone. */
  existingRelationships: number;
  /**
   * Staging copies left out because a final table holds the same thing
   * (`stg_customers` beside `customers`). Drafted only with "Show staging tables".
   */
  stagingHidden?: Array<{ relation: string; finalRelation: string }>;
  /** The modeled joins as `<relation id>|<relation id>|<from>=<to>` (lower case), so later checks leave them alone too. */
  modeledJoins?: string[];
  /** Joins found but not proposed because a reviewer removed or rejected them. */
  dismissed?: DismissedRelationship[];
  /** Their signatures, in the modeledJoins form, so later checks leave them alone too. */
  dismissedJoins?: string[];
  /** Joins only a name suggested that the warehouse did not back (validation only). */
  withheld?: WithheldRelationship[];
  validated: boolean;
  /** Opt-in query-history evidence: how much was read, or why it could not be. */
  queryHistory?: { statements: number; joins: number } | { error: string };
}

const EVIDENCE_ORDER: RelationshipEvidenceSource[] = ['declared_foreign_key', 'view_join', 'query_history', 'shared_key', 'named_for_table', 'same_name'];
/** Column types that are never join keys: measures, flags and timestamps. */
const NON_KEY_TYPE = /^(double|float|real|decimal|numeric|money|bool|boolean|date|time|timestamp|datetime|interval|json|jsonb|blob|bytea|array|struct|map)/i;
/** A column named like a key: `id`, `<thing>_id`, `_key`, `_code`, `_uuid`, `_ref`, `_number`, `_no`. */
const KEY_LIKE_NAME = /^(id|uuid|key)$|_(id|key|code|uuid|ref|number|no)$/i;
/** Types a surrogate key is stored as: whole numbers and uuids. */
const KEY_TYPE = /^(int|integer|bigint|smallint|tinyint|hugeint|ubigint|uinteger|usmallint|utinyint|serial|bigserial|smallserial|uuid)\b/i;

/**
 * Whether a column can be a drafted join key (new-user round 2, problem 5):
 * named like a key, declared as a key, or a whole number or uuid (whose
 * uniqueness the data then has to prove). A product name that happens to be
 * unique is a label, not a key: joining on it drafted a second Product join.
 */
export function keyLikeColumn(relation: WarehouseCatalogRelationV1, column: { name: string; type?: string }): boolean {
  if (KEY_LIKE_NAME.test(column.name)) return true;
  const lower = column.name.toLowerCase();
  if ((relation.primaryKey ?? []).some((key) => key.toLowerCase() === lower)) return true;
  if ((relation.foreignKeys ?? []).some((foreignKey) => foreignKey.columns.some((key) => key.toLowerCase() === lower))) return true;
  return Boolean(column.type && KEY_TYPE.test(column.type.trim()));
}

/** A name shared by this many tables or more is an audit or housekeeping column, not a key. */
const MAX_TABLES_SHARING_A_KEY = 12;
/** Share of the referencing side's values that may be missing on the unique side. */
const MAX_UNMATCHED_SHARE = 0.05;

/**
 * Whether reading a relation costs no more than reading a table: a base
 * table, or a view that only projects one relation (no join, grouping,
 * aggregate, window or union). A view that joins or aggregates can take
 * minutes to compute, so the data checks leave it out; its joins are still
 * drafted from declared keys, view SQL and names, for a person to validate.
 */
export function cheapToRead(relation: WarehouseCatalogRelationV1): boolean {
  if (relation.kind === 'table') return true;
  if (relation.kind !== 'view' || !relation.viewSql) return false;
  const body = relation.viewSql.replace(/'[^']*'/g, "''");
  return !/\b(join|group\s+by|having|distinct|union|intersect|except|over\s*\(|window)\b/i.test(body)
    && !/\b(sum|count|avg|min|max|median|array_agg|string_agg|listagg|group_concat)\s*\(/i.test(body)
    && (body.match(/\bfrom\b/gi) ?? []).length === 1;
}
/** A join seen fewer times than this in query history is noise, not evidence. */
const MIN_OBSERVED_JOINS = 2;
const GENERIC_SCHEMAS = new Set(['main', 'public', 'dbo', 'default']);
/** Evidence that is only a column name: the data has to back it before it is proposed. */
const NAME_ONLY_EVIDENCE = new Set<RelationshipEvidenceSource>(['same_name', 'named_for_table', 'shared_key']);
/** A column named like a reference: two tables that both carry it should agree on it for a joined row. */
const REFERENCE_NAME = /_(id|key|code|no)$/i;
/** Joined rows must agree on the tables' other shared references at least this often. */
const MIN_CORROBORATION = 0.5;
const TABLE_PREFIX = /^(stg|dim|fct|fact|int|base|raw|src|tbl|vw|v)_+/i;

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned || 'relation'}`;
}

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('sses') || name.endsWith('xes') || name.endsWith('ches') || name.endsWith('shes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function baseName(relation: WarehouseCatalogRelationV1): string {
  return singular(relation.name.toLowerCase().replace(TABLE_PREFIX, ''));
}

function titleCase(value: string): string {
  return value.split(/[_\s]+/).filter(Boolean).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
}

function columnNamed(relation: WarehouseCatalogRelationV1, name: string): string | undefined {
  return relation.columns.find((column) => column.name.toLowerCase() === name.toLowerCase())?.name;
}

/** A table's columns named as its row identity, after `<table>_id` and `id`: `<table>_uuid`, `uuid`, `<table>_key`. */
function identityColumns(relation: WarehouseCatalogRelationV1): string[] {
  const base = baseName(relation);
  return [`${base}_uuid`, 'uuid', `${base}_key`].flatMap((name) => columnNamed(relation, name) ?? []);
}

/** Draft domains, entities and relationships from the catalog snapshot. Pure: reads nothing else. */
export function discoverWarehouseModel(input: {
  snapshot: WarehouseCatalogSnapshotV1;
  manifest?: DQLManifest;
  /** Put every entity into this one domain. */
  domain?: string;
  /** Names the domain when the database's own name says nothing (`memory`, `postgres`). */
  projectName?: string;
  /**
   * The database's name: a DuckDB or SQLite file (`jaffle_shop.duckdb`) or the
   * catalog. A schema named for a pipeline layer or environment (`dev`, `main`,
   * `public`) maps into one Domain named after it ("Jaffle shop").
   */
  databaseName?: string;
  /** Leave out staging copies of tables a final table already holds (`stg_customers` beside `customers`). */
  hideStagingDuplicates?: boolean;
  /** Existing Domain Package ids. */
  existingDomains?: Iterable<string>;
  /** Opt-in: joins seen in recent query history. */
  observedJoins?: ObservedJoin[];
  /** What reviewers decided about earlier drafts (`.dql/modeling-discovery.json`). */
  decisions?: DiscoveryDecision[];
}): WarehouseDiscoveryReport {
  const existingDomains = new Set(input.existingDomains ?? []);
  const boundEntities = new Map<string, { qualifiedId: string; localId: string; domain: string }>();
  for (const entity of Object.values(input.manifest?.modeling?.entities ?? {})) {
    if (entity.dbtUniqueId) boundEntities.set(entity.dbtUniqueId, { qualifiedId: entity.qualifiedId ?? entity.id, localId: entity.localId ?? entity.id, domain: entity.domain });
  }
  // Staging copies of a final table wait behind "Show staging tables"; one
  // the model already binds stays.
  const relationById = new Map(input.snapshot.relations.map((relation) => [relation.id, relation]));
  const stagingHidden = input.hideStagingDuplicates
    ? [...stagingDuplicates(input.snapshot.relations)].filter(([id]) => !boundEntities.has(id))
    : [];
  const hiddenIds = new Set(stagingHidden.map(([id]) => id));
  const snapshot = hiddenIds.size
    ? { ...input.snapshot, relations: input.snapshot.relations.filter((relation) => !hiddenIds.has(relation.id)) }
    : input.snapshot;

  // The first Domain is named after the data, never a raw schema name such as
  // `dev` (new-user round 2, Q3): the database file or catalog ("Jaffle
  // shop"), else the project. A schema named for a business area (`sales`)
  // keeps its own Domain, and so does a schema Domain the project already has.
  const domainNames = new Map<string, string>();
  const databaseDomain = (() => {
    const name = meaningfulDatabaseName(
      input.databaseName,
      ...input.snapshot.relations.map((relation) => relation.database),
      ...input.snapshot.scopes.map((scope) => scope.catalogOrDatabase),
    ) ?? input.projectName ?? 'warehouse';
    return { id: slug(name), name: sentenceCaseName(name) };
  })();
  const domainOf = (relation: WarehouseCatalogRelationV1): string => {
    if (input.domain) {
      const id = slug(input.domain);
      domainNames.set(id, input.domain.trim());
      return id;
    }
    const schema = relation.schema?.toLowerCase();
    if (schema && !GENERIC_SCHEMAS.has(schema) && (!isTechnicalSchema(schema) || existingDomains.has(slug(schema)))) return slug(schema);
    domainNames.set(databaseDomain.id, databaseDomain.name);
    return databaseDomain.id;
  };

  // Entities: one per relation, named for what a row is.
  const entities: DiscoveredEntity[] = [];
  const byRelationId = new Map<string, DiscoveredEntity>();
  const usedIds = new Map<string, Set<string>>();
  for (const relation of snapshot.relations) {
    const bound = boundEntities.get(relation.id);
    const domain = bound?.domain ?? domainOf(relation);
    const taken = usedIds.get(domain) ?? new Set<string>();
    usedIds.set(domain, taken);
    let id = bound?.localId ?? slug(baseName(relation));
    if (!bound && taken.has(id)) id = slug(relation.name);
    if (!bound && taken.has(id)) id = slug(`${relation.schema ?? ''}_${relation.name}`);
    taken.add(id);
    const primaryKey = relation.primaryKey ?? [];
    const candidate = primaryKey.length === 0
      ? columnNamed(relation, `${baseName(relation)}_id`) ?? columnNamed(relation, 'id')
      : undefined;
    const entity: DiscoveredEntity = {
      id,
      domain,
      relationId: relation.id,
      relation: relation.relation,
      kind: relation.kind,
      businessName: titleCase(baseName(relation)),
      ...(relation.comment ? { description: relation.comment } : {}),
      ...(primaryKey.length ? { grain: primaryKey.join(', '), grainSource: 'primary_key' as const } : {}),
      keys: primaryKey,
      ...(candidate ? { grainCandidate: candidate } : {}),
      ...(bound ? { existing: bound.qualifiedId } : {}),
    };
    entities.push(entity);
    byRelationId.set(relation.id, entity);
  }

  // Relationships: many-to-one from the table that holds the reference.
  const candidates = new Map<string, DiscoveredRelationship>();
  const identifyingKey = (relation: WarehouseCatalogRelationV1, columns: string[]): boolean => {
    const pk = (relation.primaryKey ?? []).map((column) => column.toLowerCase()).sort().join(',');
    return pk.length > 0 && pk === columns.map((column) => column.toLowerCase()).sort().join(',');
  };
  const propose = (
    from: WarehouseCatalogRelationV1,
    to: WarehouseCatalogRelationV1,
    keys: Array<{ from: string; to: string }>,
    source: RelationshipEvidenceSource,
    reason: string,
  ): void => {
    if (from.id === to.id || keys.length === 0) return;
    const fromEntity = byRelationId.get(from.id)!;
    const toEntity = byRelationId.get(to.id)!;
    const signature = `${from.id}|${to.id}|${keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).sort().join('&')}`;
    const current = candidates.get(signature);
    if (current) {
      if (!current.evidence.some((item) => item.source === source)) current.evidence.push({ source, reason });
      return;
    }
    const toIsIdentified = identifyingKey(to, keys.map((pair) => pair.to));
    candidates.set(signature, {
      id: '',
      domain: fromEntity.domain,
      from: fromEntity.id,
      to: toEntity.id,
      fromDomain: fromEntity.domain,
      toDomain: toEntity.domain,
      fromRelation: from.relation,
      toRelation: to.relation,
      keys,
      evidence: [{ source, reason }],
      // A reference to the other table's declared key reads many-to-one; the
      // warehouse profile confirms or corrects it.
      cardinality: toIsIdentified ? 'many_to_one' : 'unknown',
      fanout: toIsIdentified ? 'safe' : 'unknown',
    });
  };

  for (const relation of snapshot.relations) {
    for (const foreignKey of relation.foreignKeys ?? []) {
      const target = resolveWarehouseRelation(snapshot, foreignKey.references.relation).relation;
      if (!target || foreignKey.columns.length !== foreignKey.references.columns.length) continue;
      propose(relation, target, foreignKey.columns.map((column, index) => ({ from: column, to: foreignKey.references.columns[index]! })), 'declared_foreign_key', `${relation.name} declares a foreign key${foreignKey.name ? ` (${foreignKey.name})` : ''} on ${foreignKey.columns.join(', ')} to ${target.name}`);
    }
  }

  for (const view of snapshot.relations) {
    if (!view.viewSql) continue;
    for (const join of viewJoins(view.viewSql)) {
      const left = resolveWarehouseRelation(snapshot, join.left.relation).relation;
      const right = resolveWarehouseRelation(snapshot, join.right.relation).relation;
      if (!left || !right || left.id === right.id) continue;
      if (!columnNamed(left, join.left.column) || !columnNamed(right, join.right.column)) continue;
      const leftKey = columnNamed(left, join.left.column)!;
      const rightKey = columnNamed(right, join.right.column)!;
      // The side joined on its own declared key is the "one" side.
      const [from, to, keys] = identifyingKey(left, [leftKey]) && !identifyingKey(right, [rightKey])
        ? [right, left, [{ from: rightKey, to: leftKey }]] as const
        : [left, right, [{ from: leftKey, to: rightKey }]] as const;
      propose(from, to, [...keys], 'view_join', `view ${view.name} joins ${from.name}.${keys[0]!.from} = ${to.name}.${keys[0]!.to}`);
    }
  }

  // Query history (opt-in): joins people already run, seen often enough.
  for (const observed of input.observedJoins ?? []) {
    if (observed.count < MIN_OBSERVED_JOINS) continue;
    const left = resolveWarehouseRelation(snapshot, observed.left.relation).relation;
    const right = resolveWarehouseRelation(snapshot, observed.right.relation).relation;
    if (!left || !right || left.id === right.id) continue;
    const leftKey = columnNamed(left, observed.left.column);
    const rightKey = columnNamed(right, observed.right.column);
    if (!leftKey || !rightKey) continue;
    const [from, to, keys] = identifyingKey(left, [leftKey]) && !identifyingKey(right, [rightKey])
      ? [right, left, [{ from: rightKey, to: leftKey }]] as const
      : [left, right, [{ from: leftKey, to: rightKey }]] as const;
    propose(from, to, [...keys], 'query_history', `recent queries joined ${from.name}.${keys[0]!.from} = ${to.name}.${keys[0]!.to} ${observed.count} times`);
  }

  // Naming: `customer_id` on orders points at customers.
  const byBaseName = new Map<string, WarehouseCatalogRelationV1[]>();
  for (const relation of snapshot.relations) {
    // Views count as much as tables: dbt builds models as views by default.
    const name = baseName(relation);
    byBaseName.set(name, [...(byBaseName.get(name) ?? []), relation]);
  }
  for (const relation of snapshot.relations) {
    // Views count as much as tables: dbt builds models as views by default.
    for (const column of relation.columns) {
      const match = /^(.+?)_(id|key|code|number|no)$/i.exec(column.name);
      if (!match) continue;
      const named = singular(match[1]!.toLowerCase());
      const candidates = (byBaseName.get(named) ?? []).filter((target) => target.id !== relation.id);
      // `products` beats `stg_products` for product_id; otherwise an
      // ambiguous name (two schemas, two prefixes) is left for a person.
      const exact = candidates.filter((target) => singular(target.name.toLowerCase()) === named);
      const targets = exact.length === 1 ? exact : candidates;
      if (targets.length !== 1) continue;
      const target = targets[0]!;
      const suggestion = suggestRelationshipKeys({
        fromColumns: relation.columns.map((item) => item.name),
        toColumns: target.columns.map((item) => item.name),
        fromRelation: relation.relation,
        toRelation: target.relation,
      }).find((item) => item.keys.length === 1 && item.keys[0]!.from.toLowerCase() === column.name.toLowerCase() && item.source !== 'dbt_test');
      if (!suggestion) continue;
      // A shared name is evidence only when it is the other table's key.
      if (suggestion.source === 'same_name' && !identifyingKey(target, [suggestion.keys[0]!.to]) && baseName(target) !== singular(match[1]!.toLowerCase())) continue;
      propose(relation, target, suggestion.keys, suggestion.source as RelationshipEvidenceSource, suggestion.reason);
    }
  }

  // Leave relationships that are already modeled alone.
  const modeled = new Set<string>();
  for (const relationship of Object.values(input.manifest?.modeling?.relationships ?? {})) {
    const fromEntity = input.manifest?.modeling?.entities[relationship.from];
    const toEntity = input.manifest?.modeling?.entities[relationship.to];
    if (!fromEntity?.dbtUniqueId || !toEntity?.dbtUniqueId) continue;
    const keys = relationship.keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).sort().join('&');
    modeled.add(`${fromEntity.dbtUniqueId}|${toEntity.dbtUniqueId}|${keys}`);
    modeled.add(`${toEntity.dbtUniqueId}|${fromEntity.dbtUniqueId}|${relationship.keys.map((pair) => `${pair.to.toLowerCase()}=${pair.from.toLowerCase()}`).sort().join('&')}`);
  }
  // A join a reviewer rejected, or removed after discovery wrote it, stays
  // out: finding it again is not new evidence.
  const dismissedBy = new Map<string, string>();
  const modeledNow = new Set([...modeled].map((signature) => signature.toLowerCase()));
  for (const decision of input.decisions ?? []) {
    const signature = joinSignature(decision.from, decision.to, decision.keys);
    const removed = decision.decision === 'applied' && !modeledNow.has(signature);
    if (decision.decision !== 'rejected' && !removed) continue;
    const reason = decision.decision === 'rejected'
      ? `rejected by a reviewer${decision.reason ? `: ${decision.reason}` : ''}`
      : 'removed by a reviewer after discovery drafted it';
    dismissedBy.set(signature, reason);
    dismissedBy.set(joinSignature(decision.to, decision.from, decision.keys.map((pair) => ({ from: pair.to, to: pair.from }))), reason);
  }
  const relationships: DiscoveredRelationship[] = [];
  const dismissed: DismissedRelationship[] = [];
  const relationshipIds = new Map<string, Set<string>>();
  let existingRelationships = 0;
  for (const [signature, relationship] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (modeled.has(signature)) {
      existingRelationships += 1;
      continue;
    }
    const dismissal = dismissedBy.get(joinSignature(signature.split('|')[0]!, signature.split('|')[1]!, relationship.keys));
    if (dismissal) {
      dismissed.push({ from: relationship.from, to: relationship.to, fromRelation: relationship.fromRelation, toRelation: relationship.toRelation, keys: relationship.keys, reason: dismissal });
      continue;
    }
    relationship.evidence.sort((a, b) => EVIDENCE_ORDER.indexOf(a.source) - EVIDENCE_ORDER.indexOf(b.source));
    const taken = relationshipIds.get(relationship.domain) ?? new Set<string>();
    relationshipIds.set(relationship.domain, taken);
    let id = slug(`${relationship.from}_to_${relationship.to}`);
    if (taken.has(id)) id = slug(`${relationship.from}_to_${relationship.to}_by_${relationship.keys.map((pair) => pair.from).join('_')}`);
    taken.add(id);
    relationships.push({ ...relationship, id });
  }

  const domainIds = [...new Set(entities.map((entity) => entity.domain))].sort();
  return {
    catalogFingerprint: snapshot.fingerprint,
    capturedAt: snapshot.capturedAt,
    relations: input.snapshot.relations.length,
    domains: domainIds.map((id) => ({ id, name: domainNames.get(id) ?? titleCase(id), existing: existingDomains.has(id) })),
    entities,
    relationships,
    existingRelationships,
    ...(stagingHidden.length ? { stagingHidden: stagingHidden.map(([id, finalId]) => ({ relation: relationById.get(id)?.relation ?? id, finalRelation: relationById.get(finalId)?.relation ?? finalId })) } : {}),
    modeledJoins: [...modeled].map((signature) => signature.toLowerCase()).sort(),
    ...(dismissed.length ? { dismissed } : {}),
    ...(dismissedBy.size ? { dismissedJoins: [...dismissedBy.keys()].sort() } : {}),
    validated: false,
  };
}

/** One spelling for a join, whichever list it comes from: `<from id>|<to id>|<from>=<to>&…`, lower case, keys sorted. */
export function joinSignature(fromRelationId: string, toRelationId: string, keys: Array<{ from: string; to: string }>): string {
  return `${fromRelationId}|${toRelationId}|${keys.map((pair) => `${pair.from}=${pair.to}`.toLowerCase()).sort().join('&')}`.toLowerCase();
}

/** Reviewer decisions about drafted joins; an unreadable or missing file is no decisions. */
export function readDiscoveryLedger(projectRoot: string): DiscoveryLedgerV1 {
  const path = join(projectRoot, DISCOVERY_LEDGER_PATH);
  if (!existsSync(path)) return { version: 1, relationships: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiscoveryLedgerV1>;
    const relationships = Array.isArray(parsed.relationships) ? parsed.relationships.filter((item): item is DiscoveryDecision =>
      Boolean(item) && typeof item.from === 'string' && typeof item.to === 'string' && Array.isArray(item.keys)
      && (item.decision === 'applied' || item.decision === 'rejected')) : [];
    return { version: 1, relationships };
  } catch {
    return { version: 1, relationships: [] };
  }
}

/**
 * Record decisions about drafted joins. One entry per join; a rejection is
 * never downgraded to "applied" by a later apply of the same join.
 */
export function recordDiscoveryDecisions(projectRoot: string, decisions: DiscoveryDecision[]): void {
  if (decisions.length === 0) return;
  const ledger = readDiscoveryLedger(projectRoot);
  const bySignature = new Map(ledger.relationships.map((item) => [joinSignature(item.from, item.to, item.keys), item]));
  for (const decision of decisions) {
    const signature = joinSignature(decision.from, decision.to, decision.keys);
    const current = bySignature.get(signature);
    if (current?.decision === 'rejected' && decision.decision === 'applied') continue;
    bySignature.set(signature, decision);
  }
  const relationships = [...bySignature.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
  const path = join(projectRoot, DISCOVERY_LEDGER_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, relationships }, null, 2)}\n`, 'utf8');
}

/**
 * Ask the warehouse how each drafted join behaves and whether a naming-key
 * grain is unique. One statement per relationship (the Modeling page's
 * Validate statement) and one per grain candidate; metadata-free aggregates
 * only, never row values.
 */
/**
 * Joins the data proves, for a warehouse that declares no keys. A column name
 * shared by several tables is a key where it is unique and never null in one
 * of them, and a join where the other tables' values are found there (at most
 * 5% missing). Names are only where to look: whether a column is a key is
 * decided by the data, never by how it is spelled. Aggregates only.
 */
export async function inferSharedKeyJoins(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  options: { maxChecks?: number } = {},
): Promise<WarehouseDiscoveryReport> {
  const quoteRelation = (relation: string) => relation.split('.').map(quote).join('.');
  // Tables and simple views alike (dbt builds models as views by default);
  // a view that joins or aggregates is left out of the data checks.
  const tables = snapshot.relations.filter((relation) => relation.columns.length > 0 && cheapToRead(relation));
  const holders = new Map<string, Array<{ relation: WarehouseCatalogRelationV1; column: string }>>();
  for (const relation of tables) {
    for (const column of relation.columns) {
      if (column.type && NON_KEY_TYPE.test(column.type)) continue;
      if (!keyLikeColumn(relation, column)) continue;
      const key = column.name.toLowerCase();
      holders.set(key, [...(holders.get(key) ?? []), { relation, column: column.name }]);
    }
  }
  const shared = [...holders.entries()].filter(([, list]) => list.length >= 2 && list.length <= MAX_TABLES_SHARING_A_KEY);
  if (shared.length === 0) return report;
  let checks = 0;
  const budget = options.maxChecks ?? 400;
  const num = (row: Record<string, unknown>, name: string) => Number(row[name] ?? row[name.toUpperCase()]);

  // 1. Which shared columns are unique and never null in which tables: one statement per table.
  const unique = new Set<string>();
  const byTable = new Map<string, Array<{ relation: WarehouseCatalogRelationV1; column: string }>>();
  for (const [, list] of shared) for (const item of list) byTable.set(item.relation.id, [...(byTable.get(item.relation.id) ?? []), item]);
  for (const items of byTable.values()) {
    if (checks++ >= budget) break;
    const relation = items[0]!.relation;
    const parts = items.map((item, index) => `COUNT(${quote(item.column)}) AS nn_${index}, COUNT(DISTINCT ${quote(item.column)}) AS nd_${index}`);
    try {
      const row = (await execute(`SELECT COUNT(*) AS row_count, ${parts.join(', ')} FROM ${quoteRelation(relation.relation)}`)).rows[0] ?? {};
      const rows = num(row, 'row_count');
      items.forEach((item, index) => {
        if (rows > 0 && num(row, `nn_${index}`) === rows && num(row, `nd_${index}`) === rows) unique.add(`${relation.id}|${item.column.toLowerCase()}`);
      });
    } catch { /* a table that cannot be read proposes nothing */ }
  }

  // 2. Containment: the other tables' values are found in the unique side.
  const entityOf = new Map(report.entities.map((entity) => [entity.relationId, entity]));
  // Joins already drafted in this report, or already modeled, are left alone
  // (either direction), identified by table id.
  const relationIdOf = new Map(report.entities.map((entity) => [`${entity.domain}::${entity.id}`, entity.relationId]));
  const known = new Set<string>([...(report.modeledJoins ?? []), ...(report.dismissedJoins ?? [])]);
  // Two tables that already have a join keep that one: a second join between
  // them on another shared column draws two identical groups ("Order Items →
  // Product" twice), whichever columns it matches on. A join a reviewer
  // removed or rejected is not replaced by another one between the same tables.
  const joinedPairs = new Set<string>();
  for (const signature of [...(report.modeledJoins ?? []), ...(report.dismissedJoins ?? [])]) {
    const [fromId, toId] = signature.split('|');
    if (fromId && toId) joinedPairs.add(`${fromId}|${toId}`).add(`${toId}|${fromId}`);
  }
  for (const item of report.relationships) {
    const fromId = relationIdOf.get(`${item.fromDomain}::${item.from}`);
    const toId = relationIdOf.get(`${item.toDomain}::${item.to}`);
    if (fromId && toId) {
      known.add(`${fromId}|${toId}|${item.keys.map((pair) => `${pair.from}=${pair.to}`).join('&')}`.toLowerCase());
      joinedPairs.add(`${fromId}|${toId}`.toLowerCase()).add(`${toId}|${fromId}`.toLowerCase());
    }
  }
  const added: DiscoveredRelationship[] = [];
  const referencedBy = new Map<string, number>();
  for (const [, list] of shared) {
    const targets = list.filter((item) => unique.has(`${item.relation.id}|${item.column.toLowerCase()}`));
    for (const target of targets) {
      for (const source of list) {
        if (source.relation.id === target.relation.id) continue;
        // Two tables unique on the same column (a subtype and its parent): the
        // smaller one points at the larger, checked the same way.
        const sourceUnique = unique.has(`${source.relation.id}|${source.column.toLowerCase()}`);
        if (sourceUnique && targets.length > 1 && (source.relation.rowCountEstimate ?? 0) > (target.relation.rowCountEstimate ?? 0)) continue;
        if (checks++ >= budget) break;
        try {
          const row = (await execute(`SELECT COUNT(${quote(source.column)}) AS referencing, COUNT(CASE WHEN ${quote(source.column)} IS NOT NULL AND ${quote(source.column)} NOT IN (SELECT ${quote(target.column)} FROM ${quoteRelation(target.relation.relation)} WHERE ${quote(target.column)} IS NOT NULL) THEN 1 END) AS unmatched FROM ${quoteRelation(source.relation.relation)}`)).rows[0] ?? {};
          const referencing = num(row, 'referencing');
          const unmatched = num(row, 'unmatched');
          if (!(referencing > 0) || unmatched > referencing * MAX_UNMATCHED_SHARE) continue;
          const from = entityOf.get(source.relation.id);
          const to = entityOf.get(target.relation.id);
          if (!from || !to) continue;
          const signature = `${source.relation.id}|${target.relation.id}|${source.column}=${target.column}`.toLowerCase();
          const reverse = `${target.relation.id}|${source.relation.id}|${target.column}=${source.column}`.toLowerCase();
          if (known.has(signature) || known.has(reverse)) continue;
          if (joinedPairs.has(`${source.relation.id}|${target.relation.id}`.toLowerCase())) continue;
          known.add(signature);
          joinedPairs.add(`${source.relation.id}|${target.relation.id}`.toLowerCase()).add(`${target.relation.id}|${source.relation.id}`.toLowerCase());
          referencedBy.set(`${target.relation.id}|${target.column.toLowerCase()}`, (referencedBy.get(`${target.relation.id}|${target.column.toLowerCase()}`) ?? 0) + 1);
          added.push({
            id: '',
            domain: from.domain,
            from: from.id,
            to: to.id,
            fromDomain: from.domain,
            toDomain: to.domain,
            fromRelation: source.relation.relation,
            toRelation: target.relation.relation,
            keys: [{ from: source.column, to: target.column }],
            evidence: [{ source: 'shared_key', reason: `${target.column} is unique in ${target.relation.name}, and ${referencing - unmatched} of ${referencing} ${source.relation.name} values are found there` }],
            cardinality: sourceUnique ? 'one_to_one' : 'many_to_one',
            fanout: 'safe',
          });
        } catch { /* an unreadable pair proposes nothing */ }
      }
    }
  }

  // 3. A table's grain is its own key when the data shows it unique (`<table>_id`),
  // otherwise the unique column other tables point at (the most-referenced
  // one). Counting only the joins found here made a label the grain: products
  // got `product_name`, because the `product_id` joins were already drafted by
  // name and so were never counted.
  const entities = report.entities.map((entity) => {
    if (entity.grain) return entity;
    const ownKey = entity.grainCandidate;
    if (ownKey && unique.has(`${entity.relationId}|${ownKey.toLowerCase()}`)) return { ...entity, grain: ownKey, keys: [ownKey], grainSource: 'unique_column' as const };
    const referenced = [...referencedBy.entries()].filter(([key]) => key.startsWith(`${entity.relationId}|`)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (referenced.length === 0) return entity;
    const column = tables.find((relation) => relation.id === entity.relationId)?.columns.find((item) => `${entity.relationId}|${item.name.toLowerCase()}` === referenced[0]![0])?.name;
    return column ? { ...entity, grain: column, keys: [column], grainSource: 'unique_column' as const } : entity;
  });

  // Ids as discovery names them: `<from>_to_<to>`, with the key when a pair has several.
  const taken = new Map<string, Set<string>>();
  for (const item of report.relationships) taken.set(item.domain, new Set([...(taken.get(item.domain) ?? []), item.id]));
  for (const item of added) {
    const ids = taken.get(item.domain) ?? new Set<string>();
    taken.set(item.domain, ids);
    let id = slug(`${item.from}_to_${item.to}`);
    if (ids.has(id)) id = slug(`${item.from}_to_${item.to}_by_${item.keys[0]!.from}`);
    ids.add(id);
    item.id = id;
  }
  return { ...report, entities, relationships: [...report.relationships, ...added] };
}

export async function validateWarehouseDiscovery(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  options: { maxRelationships?: number; dialect?: string } = {},
): Promise<WarehouseDiscoveryReport> {
  // Joins the data proves come first, then every draft is checked the same way.
  report = await inferSharedKeyJoins(report, snapshot, execute, quote);
  const typesOf = new Map(snapshot.relations.map((relation) => [relation.relation, new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.type?.toLowerCase()]))]));
  const quoteRelation = (relation: string) => relation.split('.').map(quote).join('.');
  const relationById = new Map(snapshot.relations.map((relation) => [relation.relation, relation]));
  const cheap = (relation: string) => { const found = relationById.get(relation); return found ? cheapToRead(found) : false; };
  const entities: DiscoveredEntity[] = [];
  for (const entity of report.entities) {
    // The naming-convention key first, then the table's other identity
    // columns (`<table>_uuid`, `uuid`, `<table>_key`): supplies repeat
    // `supply_id` once per product, and `supply_uuid` is the row's identity.
    const catalogRelation = relationById.get(entity.relation);
    const candidates = [...(entity.grainCandidate ? [entity.grainCandidate] : []), ...(catalogRelation ? identityColumns(catalogRelation) : [])]
      .filter((column, index, all) => all.findIndex((other) => other.toLowerCase() === column.toLowerCase()) === index);
    if (entity.grain || candidates.length === 0 || !cheap(entity.relation)) {
      entities.push(entity);
      continue;
    }
    try {
      const parts = candidates.map((candidate, index) => `COUNT(${quote(candidate)}) AS nn_${index}, COUNT(DISTINCT ${quote(candidate)}) AS nd_${index}`);
      const row = (await execute(`SELECT COUNT(*) AS row_count, ${parts.join(', ')} FROM ${quoteRelation(entity.relation)}`)).rows[0] ?? {};
      const read = (name: string) => Number(row[name] ?? row[name.toUpperCase()]);
      const rows = read('row_count');
      const grain = candidates.find((_, index) => rows > 0 && read(`nn_${index}`) === rows && read(`nd_${index}`) === rows);
      entities.push(grain ? { ...entity, grain, keys: [grain], grainSource: 'unique_column' } : entity);
    } catch {
      entities.push(entity);
    }
  }
  const limit = options.maxRelationships ?? 200;
  const relationships: DiscoveredRelationship[] = [];
  const withheld: WithheldRelationship[] = [...(report.withheld ?? [])];
  const columnsOf = new Map(snapshot.relations.map((relation) => [relation.relation, relation.columns]));
  for (const [index, relationship] of report.relationships.entries()) {
    if (index >= limit) {
      relationships.push({ ...relationship, validationError: `not validated: discovery validates at most ${limit} relationships per run` });
      continue;
    }
    if (!cheap(relationship.fromRelation) || !cheap(relationship.toRelation)) {
      relationships.push({ ...relationship, validationError: 'not validated: a view that joins or aggregates is only checked when a person validates it' });
      continue;
    }
    try {
      const keyTypes = relationship.keys.map((pair) => ({ from: typesOf.get(relationship.fromRelation)?.get(pair.from.toLowerCase()), to: typesOf.get(relationship.toRelation)?.get(pair.to.toLowerCase()) }));
      const profile = await profileRelationshipOnWarehouse({ fromRelation: relationship.fromRelation, toRelation: relationship.toRelation, keys: relationship.keys, keyTypes }, execute, quote, new Date(), options.dialect);
      const checked: DiscoveredRelationship = { ...relationship, cardinality: profile.proposed.cardinality, fanout: profile.proposed.fanout, validation: profile.evidence };
      // A column name is where to look, not evidence: a join only a name
      // suggests is proposed when the data backs it as a reference.
      const nameOnly = relationship.evidence.every((item) => NAME_ONLY_EVIDENCE.has(item.source));
      const objection = nameOnly ? await nameOnlyObjection(checked, columnsOf, execute, quote) : undefined;
      if (objection) withheld.push({ ...checked, reason: objection });
      else relationships.push(checked);
    } catch (error) {
      relationships.push({ ...relationship, validationError: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error) });
    }
  }
  return { ...report, entities, relationships, ...(withheld.length ? { withheld } : {}), validated: true };
}

/**
 * Why a join only a column name suggests is not a reference, or undefined
 * when the warehouse backs it. Three ways a shared name misleads:
 * - the values are not found on the other side (or the key repeats there);
 * - the rows that miss all hold one value, a placeholder such as 0 or -1;
 * - two tables each number their own rows 1, 2, 3…, so every value is found
 *   but the joined rows disagree on the other references both tables carry.
 * Aggregates only.
 */
async function nameOnlyObjection(
  relationship: DiscoveredRelationship,
  columnsOf: Map<string, WarehouseCatalogRelationV1['columns']>,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
): Promise<string | undefined> {
  const evidence = relationship.validation;
  if (!evidence) return undefined;
  const fromName = relationship.fromRelation.split('.').pop()!;
  const toName = relationship.toRelation.split('.').pop()!;
  const keyText = relationship.keys.map((pair) => pair.from).join(', ');
  if (evidence.status !== 'passed') return `only the column name suggests it, and the warehouse does not back it: ${evidence.message ?? 'validation failed'}`;
  const lost = evidence.unmatchedKeyedFrom ?? 0;
  if (looksLikePlaceholder({ ...evidence, keyedFrom: evidence.fromRows - evidence.fromNullKeys })) {
    return `${lost.toLocaleString('en-US')} ${fromName} rows hold one ${keyText} value that is nowhere in ${toName}, a placeholder, so the name alone does not make ${keyText} a reference`;
  }
  if (evidence.maxFromPerKey > 1 || evidence.maxToPerKey > 1) return undefined;
  // One-to-one on a name: corroborate on the other references both tables carry.
  const keyColumns = new Set(relationship.keys.flatMap((pair) => [pair.from.toLowerCase(), pair.to.toLowerCase()]));
  const toColumns = new Map((columnsOf.get(relationship.toRelation) ?? []).map((column) => [column.name.toLowerCase(), column]));
  const shared = (columnsOf.get(relationship.fromRelation) ?? []).flatMap((column) => {
    const other = toColumns.get(column.name.toLowerCase());
    if (!other || keyColumns.has(column.name.toLowerCase()) || !REFERENCE_NAME.test(column.name)) return [];
    if ((column.type && NON_KEY_TYPE.test(column.type)) || (other.type && NON_KEY_TYPE.test(other.type))) return [];
    return [{ from: column.name, to: other.name }];
  }).slice(0, 4);
  if (shared.length === 0) return undefined;
  const quoteRelation = (relation: string) => relation.split('.').map(quote).join('.');
  const on = relationship.keys.map((pair) => `f.${quote(pair.from)} = t.${quote(pair.to)}`).join(' AND ');
  const comparable = shared.map((pair) => `f.${quote(pair.from)} IS NOT NULL AND t.${quote(pair.to)} IS NOT NULL`).join(' AND ');
  const agree = shared.map((pair) => `f.${quote(pair.from)} = t.${quote(pair.to)}`).join(' AND ');
  const row = (await execute(`SELECT COUNT(*) AS compared, SUM(CASE WHEN ${agree} THEN 1 ELSE 0 END) AS agreeing FROM ${quoteRelation(relationship.fromRelation)} f JOIN ${quoteRelation(relationship.toRelation)} t ON ${on} WHERE ${comparable}`)).rows[0] ?? {};
  const compared = Number(row.compared ?? row.COMPARED ?? 0);
  const agreeing = Number(row.agreeing ?? row.AGREEING ?? 0);
  if (!(compared > 0) || agreeing / compared >= MIN_CORROBORATION) return undefined;
  const columns = shared.map((pair) => pair.from).join(', ');
  return `every ${keyText} value is found in ${toName}, but ${(compared - agreeing).toLocaleString('en-US')} of ${compared.toLocaleString('en-US')} joined rows disagree on ${columns}: the two tables number their rows separately and the values match by coincidence, not as a reference`;
}

/** The reviewed-change batch that writes a discovery report as drafts. Existing entities and domains are kept as they are. */
export function warehouseDiscoveryChanges(report: WarehouseDiscoveryReport, options: { owner?: string } = {}): ModelingAuthoringChange[] {
  const changes: ModelingAuthoringChange[] = [];
  for (const domain of report.domains) {
    if (domain.existing) continue;
    changes.push({ operation: 'upsert_domain', value: { id: domain.id, name: domain.name, ...(options.owner ? { owner: options.owner } : {}), description: 'Drafted from the warehouse catalog; review before governance use.' } });
  }
  for (const entity of report.entities) {
    if (entity.existing) continue;
    changes.push({
      operation: 'upsert_entity',
      value: {
        id: entity.id,
        domain: entity.domain,
        dbtModel: entity.relationId,
        businessName: entity.businessName,
        ...(entity.description ? { businessContext: entity.description } : {}),
        ...(entity.grain ? { grain: entity.grain, keys: entity.keys } : {}),
        status: 'draft',
      },
    });
  }
  for (const relationship of report.relationships) {
    const crossDomain = relationship.fromDomain !== relationship.toDomain;
    changes.push({
      operation: 'upsert_relationship',
      value: {
        id: relationship.id,
        domain: relationship.domain,
        // The relationship lives in the "from" entity's domain.
        from: relationship.from,
        to: crossDomain ? `${relationship.toDomain}::entity::${relationship.to}` : relationship.to,
        keys: relationship.keys,
        cardinality: relationship.cardinality,
        fanout: relationship.fanout,
        status: 'draft',
        ...(crossDomain ? { crossDomain: true } : {}),
        rationale: relationship.evidence.map((item) => item.reason).join('; '),
        ...(relationship.validation ? { validation: relationship.validation } : {}),
      },
    });
  }
  return changes;
}

interface ViewJoin {
  left: { relation: string; column: string };
  right: { relation: string; column: string };
}

/**
 * The equality joins a view's SQL states, as relation.column pairs. A small
 * reader for the common `FROM a [AS] x JOIN b [AS] y ON x.c = y.d` shape; a
 * statement it cannot read yields nothing rather than a guess.
 */
export function viewJoins(sql: string): ViewJoin[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const identifier = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  const qualified = `${identifier}(?:\\s*\\.\\s*${identifier}){0,2}`;
  const reserved = new Set(['on', 'using', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'where', 'group', 'order', 'limit', 'natural', 'lateral', 'union', 'having', 'window', 'qualify']);
  const aliases = new Map<string, string>();
  // The alias may not be a keyword: `FROM a JOIN b` has no alias, and reading
  // JOIN as one would swallow the next table.
  const notKeyword = `(?!(?:${[...reserved].join('|')})\\b)`;
  const tableRef = new RegExp(`\\b(?:from|join)\\s+(${qualified})(?:\\s+(?:as\\s+)?${notKeyword}(${identifier}))?`, 'gi');
  const clean = (value: string) => value.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.');
  for (const match of text.matchAll(tableRef)) {
    const relation = clean(match[1]!);
    if (relation.startsWith('(')) continue;
    const alias = match[2] ? clean(match[2]) : undefined;
    aliases.set((alias ?? relation.split('.').pop()!).toLowerCase(), relation);
    aliases.set(relation.toLowerCase(), relation);
  }
  const joins: ViewJoin[] = [];
  const condition = new RegExp(`(${qualified})\\s*\\.\\s*(${identifier})\\s*=\\s*(${qualified})\\s*\\.\\s*(${identifier})`, 'g');
  for (const on of text.matchAll(/\bon\b(.*?)(?=\b(?:join|left|right|inner|full|cross|where|group|order|limit|union|having|qualify)\b|\)|$)/gi)) {
    for (const match of on[1]!.matchAll(condition)) {
      const leftRelation = aliases.get(clean(match[1]!).toLowerCase());
      const rightRelation = aliases.get(clean(match[3]!).toLowerCase());
      if (!leftRelation || !rightRelation) continue;
      joins.push({ left: { relation: leftRelation, column: clean(match[2]!) }, right: { relation: rightRelation, column: clean(match[4]!) } });
    }
  }
  return joins;
}

/**
 * The statement that lists recent query text a warehouse role can see, per
 * driver; undefined where the warehouse keeps no readable history.
 */
export function queryHistorySql(driver: string, options: { database?: string; location?: string; limit?: number } = {}): string | undefined {
  const limit = Math.max(1, Math.min(options.limit ?? 5_000, 20_000));
  const d = driver.toLowerCase();
  if (d === 'snowflake') {
    const db = options.database ? `"${options.database.replace(/"/g, '""')}".` : '';
    return `SELECT query_text FROM TABLE(${db}INFORMATION_SCHEMA.QUERY_HISTORY(RESULT_LIMIT => ${Math.min(limit, 10_000)})) WHERE execution_status = 'SUCCESS' AND query_type = 'SELECT' AND query_text ILIKE '%join%'`;
  }
  // pg_stat_statements keeps normalized text, with literals already replaced by $n.
  if (d === 'postgres' || d === 'postgresql') return `SELECT query AS query_text FROM pg_stat_statements WHERE query ILIKE '%join%' ORDER BY calls DESC LIMIT ${limit}`;
  if (d === 'databricks') return `SELECT statement_text AS query_text FROM system.query.history WHERE statement_type = 'SELECT' AND execution_status = 'FINISHED' AND lower(statement_text) LIKE '%join%' ORDER BY start_time DESC LIMIT ${limit}`;
  if (d === 'bigquery') {
    const region = `region-${(options.location ?? 'US').toLowerCase()}`;
    return `SELECT query AS query_text FROM \`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE statement_type = 'SELECT' AND state = 'DONE' AND error_result IS NULL AND creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND LOWER(query) LIKE '%join%' LIMIT ${limit}`;
  }
  return undefined;
}

/**
 * Count the equality joins in a set of query texts. The text is read in
 * memory and dropped: only which columns were joined, and how often, is kept.
 */
export function observedJoinsFromQueries(texts: Iterable<string>): ObservedJoin[] {
  const counts = new Map<string, ObservedJoin>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const join of viewJoins(text)) {
      const sides = [join.left, join.right].map((side) => ({ relation: side.relation.toLowerCase(), column: side.column.toLowerCase() }))
        .sort((a, b) => `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`));
      const signature = sides.map((side) => `${side.relation}.${side.column}`).join('=');
      // A statement counts once per join, however often it repeats the join.
      if (seen.has(signature)) continue;
      seen.add(signature);
      const current = counts.get(signature);
      if (current) current.count += 1;
      else counts.set(signature, { left: sides[0]!, right: sides[1]!, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
