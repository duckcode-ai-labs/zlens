import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBlockReplacement, type DQLManifest, type SemanticLayer, type WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { blocksNamedByQuestion, buildVocabularyIndex, extractBlockContract, parsePhysicalIdentifier, physicalRelationBinding, physicalRelationIdentity, physicalRelationText, mergePhysicalRelationBinding, renderPhysicalIdentifier, type PhysicalRelationBindingV1, type VocabularyEntry, type VocabularyIndex, type VocabularySource } from '@zlens/agent';

/**
 * The whole authorized vocabulary of a project, from the objects the host
 * already holds: the semantic layer (metrics, measures, dimensions,
 * entities, models and their join graph), the DQL manifest (certified
 * blocks with their SQL, business terms) and the dbt sources it recorded
 * (physical relations and documented columns). Physical bindings let the
 * relational tier express what the semantic engines cannot.
 */

export interface VocabularySourceInput {
  semanticLayer?: SemanticLayer;
  manifest?: DQLManifest;
  /** Runtime relations the host has introspected, when the manifest has no dbt sources. */
  relations?: Array<{ database?: string; schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }>; /** Manifest-only relation metadata used for relation selection, never rendered as full column vocabulary until hydration. */ embeddedColumns?: Array<{ name: string; dataType?: string; description?: string }>; columnCompleteness?: 'complete' | 'partial' | 'unknown'; binding?: PhysicalRelationBindingV1; observedAt?: string; truncated?: boolean }>;
  /** The warehouse driver, so a physical expression is written as that warehouse reads names (Snowflake: unquoted plain names). */
  driver?: string;
  /** Active execution database when dbt provenance did not qualify a relation. */
  defaultDatabase?: string;
  /** Snapshot and redacted target identity are carried with runtime observations. */
  snapshotId?: string;
  executionTargetFingerprint?: string;
}

/**
 * Certification is one state. A block whose status says certified while its
 * own description or tags say it still needs review is contradictory
 * metadata, and a contradiction is never served as certified evidence. The
 * reason is returned in words, so a question that names such a block is told
 * why it was not used instead of being silently answered from elsewhere.
 */
export function certifiedBlockContradiction(block: { description?: string; tags?: string[] }): string | undefined {
  if ((block.tags ?? []).some((tag) => /review[\s-]*required/i.test(tag))) {
    return 'it is marked certified but still carries the review-required tag, so Ask does not serve it as certified. Certify it again in Saved queries (certifying removes the tag), or remove the tag from its source';
  }
  if (/review[\s-]*required/i.test(block.description ?? '')) {
    return 'it is marked certified but its description says it is review-required, so Ask does not serve it as certified. Edit the description and certify it again';
  }
  return undefined;
}

/**
 * Why a block a question names as a block ("using the certified block X") is
 * not one Ask can answer from, in words, or undefined when it is served. A
 * retired block with a replacement is answered from the replacement and is
 * not reported here.
 */
export function namedBlockNotServed(question: string, manifest: DQLManifest | undefined): string | undefined {
  const blocks = Object.values(manifest?.blocks ?? {});
  if (blocks.length === 0) return undefined;
  const named = blocksNamedByQuestion(question, blocks.map((block) => block.name));
  for (const name of named) {
    const block = blocks.find((candidate) => candidate.name === name)!;
    const status = (block.status ?? 'draft').toLowerCase();
    if (status === 'certified') {
      const reason = certifiedBlockContradiction(block);
      // A served certified block of the same name answers; this one is not the answer.
      if (reason && !blocks.some((other) => other !== block && other.name === name && (other.status ?? '').toLowerCase() === 'certified' && !certifiedBlockContradiction(other))) return `The saved query "${block.name}" was not used: ${reason}.`;
      continue;
    }
    if (status === 'deprecated') {
      if (resolveBlockReplacement(blocks, block)?.replacement) continue;
      return `The saved query "${block.name}" was not used: it is retired and names no replacement. Ask about what it measured without naming it, or restore it in Saved queries.`;
    }
    return `The saved query "${block.name}" was not used: it is a ${status === 'review' ? 'saved query in review' : 'draft'}, not certified, and Ask only answers from certified saved queries. Certify it in Saved queries, or ask the question without naming the saved query for a review-required answer.`;
  }
  return undefined;
}

/** `"jaffle_shop"."dev"."customers"` and `jaffle_shop.dev.customers` become `dev.customers`. */
export function normalizeRelationName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = parsePhysicalIdentifier(value).map((part) => part.value.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.slice(-2).join('.');
}

const MAX_EMBEDDED_MANIFEST_COLUMNS = 60_000;
/** A catalog relation's columns reach the vocabulary; a pathological table does not drown it. */
const MAX_CATALOG_COLUMNS_PER_RELATION = 400;
const MAX_EMBEDDED_MANIFEST_DESCRIPTIONS = 2_000;

/**
 * The compiled DQL manifest intentionally keeps dbt provenance small: it
 * points to the immutable dbt artifact instead of copying every physical
 * column into the workspace manifest.  Ask still needs those names to choose
 * a relation on a manifest-only project, especially when the catalog has
 * suppressed individual column objects above the enterprise threshold.
 *
 * This returns relation-level search metadata only. `embeddedColumns` is not
 * converted into column vocabulary entries; the host hydrates one of the
 * selected relations from the current catalog/warehouse before the provider
 * can bind or validate a physical field. A bounded/failed hydration remains
 * partial rather than proving the other documented fields absent.
 */
interface DbtArtifactNode {
  uniqueId: string;
  resourceType: string;
  relationName?: string;
  alias?: string;
  identifier?: string;
  name?: string;
  schema?: string;
  database?: string;
  description?: string;
  columns: Array<{ name: string; dataType?: string; description?: string }>;
  /** What each output column is computed from, by column name (lowercased), from the model's SQL. */
  lineage?: Record<string, string[]>;
}

/**
 * The dbt artifact is read ONCE per (path, mtime, size) and kept as a slim
 * node list. Reading it per vocabulary build costs a full parse of a
 * 50–250 MB file for every question that discovers a relation, and two
 * consumers (relation selection, column lineage) used to parse it separately.
 */
const dbtArtifactCache = new Map<string, { key: string; nodes: DbtArtifactNode[] }>();
const DBT_ARTIFACT_LINEAGE_MAX_BYTES = 250 * 1024 * 1024;

export function dbtArtifactNodes(path: string | undefined): DbtArtifactNode[] {
  if (!path || !existsSync(path)) return [];
  let key: string;
  let size = 0;
  try {
    const stat = statSync(path);
    size = stat.size;
    key = `${stat.mtimeMs}|${stat.size}`;
  } catch {
    return [];
  }
  const cached = dbtArtifactCache.get(path);
  if (cached?.key === key) return cached.nodes;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      nodes?: Record<string, Record<string, unknown>>;
      sources?: Record<string, Record<string, unknown>>;
    };
    const nodes: DbtArtifactNode[] = [];
    for (const [uniqueId, node] of [...Object.entries(raw.nodes ?? {}), ...Object.entries(raw.sources ?? {})]) {
      const resourceType = typeof node.resource_type === 'string' ? node.resource_type : '';
      if (resourceType !== 'model' && resourceType !== 'source') continue;
      const columnsRecord = node.columns && typeof node.columns === 'object' && !Array.isArray(node.columns)
        ? node.columns as Record<string, unknown>
        : {};
      let described = 0;
      const columns: DbtArtifactNode['columns'] = [];
      for (const [columnKey, candidate] of Object.entries(columnsRecord)) {
        if (columns.length >= MAX_EMBEDDED_MANIFEST_COLUMNS) break;
        const column = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
        const columnName = typeof column.name === 'string' && column.name.trim() ? column.name : columnKey;
        if (!columnName) continue;
        const type = typeof column.data_type === 'string' ? column.data_type : typeof column.type === 'string' ? column.type : undefined;
        const description = typeof column.description === 'string' && described < MAX_EMBEDDED_MANIFEST_DESCRIPTIONS
          ? column.description
          : undefined;
        if (description) described += 1;
        columns.push({ name: columnName, ...(type ? { dataType: type } : {}), ...(description ? { description } : {}) });
      }
      const sql = resourceType === 'model' && size <= DBT_ARTIFACT_LINEAGE_MAX_BYTES
        ? [node.compiled_code, node.compiled_sql, node.raw_code, node.raw_sql].find((value): value is string => typeof value === 'string')
        : undefined;
      const lineage = sql ? columnLineageFromSql(sql) : undefined;
      nodes.push({
        uniqueId,
        resourceType,
        ...(typeof node.relation_name === 'string' ? { relationName: node.relation_name } : {}),
        ...(typeof node.alias === 'string' ? { alias: node.alias } : {}),
        ...(typeof node.identifier === 'string' ? { identifier: node.identifier } : {}),
        ...(typeof node.name === 'string' ? { name: node.name } : {}),
        ...(typeof node.schema === 'string' ? { schema: node.schema } : {}),
        ...(typeof node.database === 'string' ? { database: node.database } : {}),
        ...(typeof node.description === 'string' && node.description ? { description: node.description } : {}),
        columns,
        ...(lineage && Object.keys(lineage).length ? { lineage } : {}),
      });
    }
    dbtArtifactCache.clear();
    dbtArtifactCache.set(path, { key, nodes });
    return nodes;
  } catch {
    // A source artifact may be replaced between snapshots. The host falls
    // back to the already-recorded provenance and warehouse discovery; it
    // never treats a failed artifact read as evidence that a column is gone.
    return [];
  }
}

/** Test seam: forget every cached dbt artifact. */
export function resetDbtArtifactCache(): void {
  dbtArtifactCache.clear();
}

const warehouseCatalogCache = new Map<string, { key: string; snapshot?: WarehouseCatalogSnapshotV1 }>();

function warehouseCatalogSnapshot(path: string): WarehouseCatalogSnapshotV1 | undefined {
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}|${stat.size}`;
  } catch {
    return undefined;
  }
  const cached = warehouseCatalogCache.get(path);
  if (cached?.key === key) return cached.snapshot;
  let snapshot: WarehouseCatalogSnapshotV1 | undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WarehouseCatalogSnapshotV1;
    snapshot = parsed?.version === 1 && Array.isArray(parsed.relations) ? parsed : undefined;
  } catch {
    snapshot = undefined;
  }
  warehouseCatalogCache.clear();
  warehouseCatalogCache.set(path, { key, snapshot });
  return snapshot;
}

/** What a warehouse declares about one table: what one row is and how it points at others. */
export interface DeclaredRelationKeys {
  relation: string;
  primaryKey?: string[];
  foreignKeys: Array<{ columns: string[]; references: { relation: string; columns: string[] } }>;
}

/** The declared keys of a warehouse-first project's tables, looked up by any spelling of a table. */
export interface WarehouseFirstCatalog {
  /** Every relation the synced catalog lists. */
  size: number;
  keysOf(relation: string): DeclaredRelationKeys | undefined;
}

/** A relation's parts, unquoted and lowercased: how a catalog spelling and a quoted SQL spelling meet. */
function foldedRelation(relation: string): string {
  return parsePhysicalIdentifier(relation).map((part) => part.value.toLowerCase()).join('.');
}

/**
 * THE WAREHOUSE-FIRST CATALOG, with the keys the warehouse declares.
 *
 * Only for a project with no dbt project (RFC 0007 warehouse-first): there the
 * synced catalog is the whole schema and the only account of how its tables
 * join. A primary key says what one row is; a foreign key says how two tables
 * connect. A plain text-to-SQL prompt reads both from `CREATE TABLE`; the
 * drafter had neither. Returns undefined for a dbt or hybrid project (even a
 * hybrid one whose dbt manifest is unreadable right now), whose prompts stay
 * as they are.
 */
export function warehouseFirstCatalog(manifest: DQLManifest | undefined, projectRoot: string | undefined): WarehouseFirstCatalog | undefined {
  const provenance = manifest?.dbtProvenance;
  if (!provenance?.warehouseCatalogPath || provenance.manifestPath || !projectRoot) return undefined;
  if (manifest?.modeling?.mode && manifest.modeling.mode !== 'warehouse-first') return undefined;
  const snapshot = warehouseCatalogSnapshot(join(projectRoot, provenance.warehouseCatalogPath));
  if (!snapshot) return undefined;
  const exact = new Map<string, DeclaredRelationKeys>();
  const folded = new Map<string, DeclaredRelationKeys | null>();
  for (const relation of snapshot.relations) {
    const keys: DeclaredRelationKeys = {
      relation: relation.relation,
      ...(relation.primaryKey?.length ? { primaryKey: relation.primaryKey } : {}),
      foreignKeys: (relation.foreignKeys ?? []).map((key) => ({ columns: key.columns, references: { relation: key.references.relation, columns: key.references.columns } })),
    };
    exact.set(physicalRelationIdentity(relation.relation), keys);
    // Two tables that differ only by case or quoting are told apart only exactly.
    const name = foldedRelation(relation.relation);
    folded.set(name, folded.has(name) ? null : keys);
  }
  return {
    size: snapshot.relations.length,
    keysOf: (relation) => exact.get(physicalRelationIdentity(relation)) ?? folded.get(foldedRelation(relation)) ?? undefined,
  };
}

/**
 * RFC 0007: in warehouse-first and hybrid modeling the warehouse catalog
 * snapshot plays the dbt artifact's part — table and column comments become
 * relation search metadata, exactly as dbt descriptions do.
 */
function warehouseCatalogRelations(manifest: DQLManifest | undefined, projectRoot: string | undefined): NonNullable<VocabularySourceInput['relations']> {
  const catalogPath = manifest?.dbtProvenance?.warehouseCatalogPath;
  if (!catalogPath || !projectRoot) return [];
  const snapshot = warehouseCatalogSnapshot(join(projectRoot, catalogPath));
  if (!snapshot) return [];
  const admitted = new Set(Object.keys(manifest?.dbtProvenance?.nodes ?? {}));
  return snapshot.relations
    .filter((relation) => admitted.has(relation.id))
    .map((relation) => ({
      ...(relation.database ? { database: relation.database } : {}),
      ...(relation.schema ? { schema: relation.schema } : {}),
      name: relation.name,
      ...(relation.comment ? { description: relation.comment } : {}),
      // THE WAREHOUSE CATALOG IS THE COLUMNS, NOT A HINT ABOUT THEM. A dbt
      // manifest keeps columns off the relation because a large one carries
      // tens of thousands of them for ranking alone; a warehouse catalog is
      // the schema ZLens synced, bounded by the scope the user chose, and it
      // is complete. Leaving these off the relation showed Ask a warehouse as
      // a list of bare table names — it then reported columns it had never
      // been shown as missing, and declined questions the tables could answer.
      columns: relation.columns.slice(0, MAX_CATALOG_COLUMNS_PER_RELATION).map((column) => ({
        name: column.name,
        ...(column.type ? { dataType: column.type } : {}),
        ...(column.comment ? { description: column.comment } : {}),
      })),
      columnCompleteness: (relation.columns.length <= MAX_CATALOG_COLUMNS_PER_RELATION ? 'complete' : 'partial') as 'complete' | 'partial',
    }));
}

export function embeddedManifestRelations(manifest: DQLManifest | undefined, projectRoot?: string): NonNullable<VocabularySourceInput['relations']> {
  const warehouse = warehouseCatalogRelations(manifest, projectRoot);
  const nodes = dbtArtifactNodes(manifest?.dbtProvenance?.manifestPath);
  if (nodes.length === 0) return warehouse;
  const admitted = new Set(Object.keys(manifest?.dbtProvenance?.nodes ?? {}));
  const result: NonNullable<VocabularySourceInput['relations']> = [];
  for (const node of nodes) {
    if (admitted.size > 0 && !admitted.has(node.uniqueId)) continue;
    const exact = manifest?.dbtProvenance?.nodes[node.uniqueId]?.relation;
    const physical = parsePhysicalIdentifier(exact ?? node.relationName ?? '');
    const name = physical.at(-1)?.value ?? node.alias ?? node.identifier ?? node.name;
    if (!name) continue;
    const schema = physical.at(-2)?.value ?? node.schema;
    const database = physical.at(-3)?.value ?? node.database;
    result.push({
      ...(database ? { database } : {}),
      ...(schema ? { schema } : {}),
      name,
      ...(node.description ? { description: node.description } : {}),
      columns: [],
      // Shared with the cache on purpose: the source builder copies what it keeps.
      ...(node.columns.length ? { embeddedColumns: node.columns } : {}),
      columnCompleteness: 'partial',
    });
  }
  return [...result, ...warehouse];
}

const AGGREGATES = new Set(['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median']);
const isIdentifier = (value: string | undefined): value is string => Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));

const SQL_WORDS = new Set(['case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'true', 'false', 'is', 'in', 'like', 'ilike', 'distinct', 'as', 'between', 'exists', 'cast', 'interval', 'date', 'timestamp', 'integer', 'bigint', 'varchar', 'double', 'decimal', 'numeric', 'boolean', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Qualify every bare column reference inside an expression with its relation
 * so a joined query is unambiguous (`product_price` exists on order lines AND
 * products). Known columns are qualified first; any other bare identifier that
 * is not a keyword, a function call, a number or part of a string literal is
 * treated as a column of the same relation.
 */
const AGGREGATE_CALL = /^(sum|count|avg|min|max|median)\s*\(([\s\S]+)\)$/i;
const NESTED_AGGREGATE = /\b(sum|count|avg|min|max|median)\s*\(/i;

/**
 * A native DQL metric or dimension declares its own relation and expression
 * (`table`, `sql`, `type`) and carries no dbt cube or measure. Read the
 * aggregate out of the expression when the author wrote one ("SUM(points)"),
 * and take the declared type when they wrote the bare column ("points"). An
 * expression that mixes aggregates (a ratio of sums) is left to the semantic
 * engine: wrapping it in another aggregate would change its meaning.
 */
const SAFE_FORMULA = /^[\sA-Za-z0-9_."'(),+\-*\/]+$/;
/**
 * A native metric written as a formula of aggregates over its own columns.
 * Accepted when every function is an aggregate or NULLIF/COALESCE, the
 * arithmetic is + - * / and parentheses, and at least one aggregate is
 * present; anything else (a subquery, a window, a CASE the formula regex
 * cannot vouch for) stays with the semantic engine.
 */
export function nativeFormulaBinding(sql: string | number | undefined): string | undefined {
  // YAML hands a numeric expression (dbt's `expr: 1` count measure) over as a number.
  const text = (sql == null ? '' : String(sql)).trim();
  if (!text || !SAFE_FORMULA.test(text) || !NESTED_AGGREGATE.test(text)) return undefined;
  if (/\b(select|from|where|over|partition|join|union|case|when|with|limit|order)\b/i.test(text)) return undefined;
  const functions = [...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]!.toLowerCase());
  if (!functions.every((name) => AGGREGATES.has(name) || name === 'nullif' || name === 'coalesce' || name === 'cast')) return undefined;
  // A single bare aggregate call is the simple path's job, not a formula.
  if (nativeAggregateBinding(text, undefined)) return undefined;
  return text;
}

export function nativeAggregateBinding(sql: string | number | undefined, declaredType: string | undefined): { expr: string; aggregate: string } | undefined {
  // YAML hands a numeric expression (dbt's `expr: 1` count measure) over as a number.
  const text = (sql == null ? '' : String(sql)).trim();
  if (!text) return undefined;
  const call = AGGREGATE_CALL.exec(text);
  if (call) {
    // The outer parentheses must close the call, not two calls side by side.
    let depth = 0;
    for (let at = 0; at < call[2]!.length; at += 1) {
      const char = call[2]![at];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (depth < 0) return undefined;
    }
    if (depth !== 0) return undefined;
    let aggregate = call[1]!.toLowerCase();
    let inner = call[2]!.trim();
    if (aggregate === 'count' && /^distinct\s+/i.test(inner)) { aggregate = 'count_distinct'; inner = inner.replace(/^distinct\s+/i, ''); }
    if (NESTED_AGGREGATE.test(inner)) return undefined;
    return AGGREGATES.has(aggregate) && inner ? { expr: inner, aggregate } : undefined;
  }
  if (NESTED_AGGREGATE.test(text)) return undefined;
  const aggregate = (declaredType ?? '').toLowerCase();
  return AGGREGATES.has(aggregate) ? { expr: text, aggregate } : undefined;
}

export function qualifyExpression(expr: string, relation: string, columns: Iterable<string>, quote: (name: string) => string = (name) => `"${name}"`): string {
  // `split('.')` turns a quoted Snowflake database such as
  // `"Db.With.Dot"` into three unrelated identifiers.  Relation bindings
  // intentionally retain quote semantics, so expression rendering does too.
  const quoted = parsePhysicalIdentifier(relation)
    .map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : quote(part.value))
    .join('.');
  const literals: string[] = [];
  let out = expr.replace(/'(?:[^']|'')*'/g, (literal) => { literals.push(literal); return `__lit${literals.length - 1}__`; });
  const known = new Set([...columns].map((column) => column.toLowerCase()));
  out = out.replace(/(?<![\w."])([A-Za-z_][A-Za-z0-9_]*)(?![\w"]|\s*\()/g, (match, identifier: string) => {
    const lower = identifier.toLowerCase();
    if (/^__lit\d+__$/.test(identifier) || SQL_WORDS.has(lower)) return match;
    if (known.has(lower) || !/^\d/.test(identifier)) return `${quoted}.${quote(identifier)}`;
    return match;
  });
  return out.replace(/__lit(\d+)__/g, (_m, index: string) => literals[Number(index)]!);
}

/**
 * A metric's declared scope, read from every shape a project may write it in:
 * a MetricFlow `{{ Dimension('order_id__is_drink_order') }} = true` template, a
 * plain predicate a native DQL metric declares (`participated = true`), or a
 * bare boolean column. A filter this cannot read is reported as `unparsed`, so
 * the caller can refuse a physical binding instead of dropping the scope and
 * answering a different question at the highest trust it has.
 */
export interface MetricFilterSpec {
  predicates: Array<{ column: string; condition: string; entityPath: string[] }>;
  unparsed: string[];
}

const DIMENSION_TEMPLATE = /^\{\{\s*Dimension\(\s*'([^']+)'\s*\)\s*\}\}\s*(=|!=|<>|>=|<=|>|<|in|not in)\s*(.+?)\s*$/i;
const PLAIN_PREDICATE = /^([A-Za-z_][A-Za-z0-9_]*)\s+(=|!=|<>|>=|<=|>|<|is not|is|in|not in)\s+(.+?)$/i;
const TIGHT_PREDICATE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|<>|>=|<=|>|<)\s*(.+?)$/i;
const BARE_BOOLEAN = /^([A-Za-z_][A-Za-z0-9_]*)$/;

export function parseMetricFilter(filter: unknown): MetricFilterSpec {
  const templates: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') templates.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
  };
  collect(filter);
  const spec: MetricFilterSpec = { predicates: [], unparsed: [] };
  for (const template of templates) {
    const text = template.trim();
    if (!text) continue;
    const dimension = DIMENSION_TEMPLATE.exec(text);
    if (dimension) {
      const parts = dimension[1]!.split('__');
      spec.predicates.push({ column: parts[parts.length - 1]!, entityPath: parts.slice(0, -1), condition: `${dimension[2]} ${dimension[3]}` });
      continue;
    }
    // A composite predicate names columns this cannot qualify one by one; the
    // semantic engine owns it.
    if (/\bor\b/i.test(text) || /\band\b/i.test(text) || text.includes('{{')) { spec.unparsed.push(text); continue; }
    const plain = PLAIN_PREDICATE.exec(text) ?? TIGHT_PREDICATE.exec(text);
    if (plain) { spec.predicates.push({ column: plain[1]!, entityPath: [], condition: `${plain[2]} ${plain[3]}` }); continue; }
    const bare = BARE_BOOLEAN.exec(text);
    if (bare) { spec.predicates.push({ column: bare[1]!, entityPath: [], condition: '= true' }); continue; }
    spec.unparsed.push(text);
  }
  return spec;
}

/**
 * A scoped aggregate. The scope goes INSIDE the aggregate so several measures
 * of one relation keep their own populations. Only a sum reads 0 for an
 * excluded row; a count, a distinct count or an extremum must see NULL, or the
 * excluded rows would be counted after all.
 */
export function scopedAggregateExpression(base: string, aggregate: string, predicates: string[]): string {
  if (predicates.length === 0) return base;
  return `CASE WHEN ${predicates.join(' AND ')} THEN ${base}${aggregate === 'sum' ? ' ELSE 0' : ''} END`;
}

export function buildVocabularySource(input: VocabularySourceInput): VocabularySource {
  const source: VocabularySource = { metrics: [], measures: [], dimensions: [], entities: [], models: [], blocks: [], relations: [], terms: [] };
  const relationColumns = new Map<string, Set<string>>();
  // dbt column descriptions: the fallback definition for a semantic dimension that declares none.
  const columnDescriptions = new Map<string, string>();
  const relationSeen = new Set<string>();
  // `schema.table` is only a compatibility alias. A Snowflake project can
  // legitimately expose DB_A.PUBLIC.EVENTS and DB_B.PUBLIC.EVENTS in one
  // snapshot, so the source's internal key must retain physical identity.
  const relationItems = new Map<string, NonNullable<VocabularySource['relations']>[number]>();
  // Exact physical identity -> source key. A linear scan here is quadratic in
  // the relation count and was measured at 21 s for 4,700 dbt models; the
  // office-scale project pays that on every source build.
  const relationKeyByIdentity = new Map<string, string>();
  // The same object ignoring quote state and case: dbt-duckdb writes
  // provenance quoted (`"nba"."dev"."t"`) and a warehouse describes the
  // object unquoted. A warehouse observation asked for by that name IS the
  // object; it merges here instead of founding a second relation whose
  // columns nobody can reach.
  const relationKeyByLooseIdentity = new Map<string, string>();
  const looseIdentity = (binding: PhysicalRelationBindingV1) => [binding.database, binding.schema, binding.table].filter(Boolean).map((part) => part!.value.toLowerCase()).join('.');
  const relationKeyByLower = new Map<string, string>();
  // A physical name inside an expression is written as this warehouse reads it,
  // and a relation carries its database on a warehouse that addresses objects
  // across databases (Snowflake), from the manifest's provenance.
  const physicalQuote = (name: string) => renderPhysicalIdentifier(name, input.driver, (value) => `"${value.replace(/"/g, '""')}"`);
  // A two-part logical name can exist in more than one Snowflake database.
  // Retain that ambiguity here; a later physical binding must name one exact
  // database instead of letting the last manifest node win.
  const physicalCandidates = new Map<string, Set<string>>();
  const addPhysicalCandidate = (logical: string | undefined, physical: string | undefined) => {
    const normalized = normalizeRelationName(logical ?? physical);
    if (!normalized || !physical?.trim()) return;
    const candidates = physicalCandidates.get(normalized.toLowerCase()) ?? new Set<string>();
    // Preserve the exact dbt spelling here. This map supplies physical
    // qualification to semantic expressions before bindings are attached, so
    // it must not lower-case, strip quotes, or collapse a quoted database.
    candidates.add(physical.trim());
    physicalCandidates.set(normalized.toLowerCase(), candidates);
  };
  for (const node of Object.values(input.manifest?.dbtProvenance?.nodes ?? {})) {
    const relation = (node as { relation?: string }).relation;
    const logical = normalizeRelationName(relation);
    addPhysicalCandidate(logical, relation);
  }
  // dbt sources can carry physical database provenance even when the compact
  // provenance-node inventory has no entry for them. Seed the same
  // collision-aware lookup before semantic expressions are rendered; otherwise
  // a semantic `PUBLIC.EVENTS` metric silently uses the connection's default
  // database while the source binding correctly says `DB_B.PUBLIC.EVENTS`.
  for (const item of Object.values(input.manifest?.sources ?? {})) {
    const dbt = item.dbtModel;
    if (!dbt?.database || !dbt.schema || !item.name) continue;
    const logical = `${dbt.schema}.${item.name}`;
    const physical = [dbt.database, dbt.schema, item.name]
      .map((part) => physicalQuote(part))
      .join('.');
    addPhysicalCandidate(logical, physical);
  }
  const physicalOf = (relation: string): string | undefined => {
    const candidates = physicalCandidates.get((normalizeRelationName(relation) ?? relation).toLowerCase());
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  };
  const databaseOf = (relation: string): string | undefined => {
    const parts = physicalOf(relation) ? parsePhysicalIdentifier(physicalOf(relation)!) : [];
    const database = parts.length >= 3 ? parts.at(-3) : undefined;
    return database ? (database.quoted ? `"${database.value.replace(/"/g, '""')}"` : database.value) : undefined;
  };
  const addressed = (relation: string) => physicalOf(relation)
    ?? (input.driver?.toLowerCase() === 'snowflake' && relation.split('.').length === 2 && databaseOf(relation) ? `${databaseOf(relation)}.${relation}` : relation);

  // A relation may be described more than once: by a partial dbt manifest
  // (a few documented columns, no types) and by the warehouse itself (every
  // column, typed). The first description is not the last word: later ones
  // ADD the columns and types the earlier lacked, so a column the manifest
  // never mentioned is still a column, and a typed literal compiles by type.
  const addRelation = (relation: { database?: string; schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }>; embeddedColumns?: Array<{ name: string; dataType?: string; description?: string }>; domain?: string; columnLineage?: Record<string, string[]>; columnCompleteness?: 'complete' | 'partial' | 'unknown'; binding?: PhysicalRelationBindingV1; observedAt?: string; truncated?: boolean }) => {
    // Case-insensitive: the warehouse spells CONSUMPTION_METRICS.HEADER, the
    // manifest consumption_metrics.header — one relation, the first spelling
    // kept as the key every later lookup uses.
    const spelled = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
    const logicalKey = relationKeyByLower.get(spelled.toLowerCase()) ?? spelled;
    const bindingDriver = relation.binding?.driver ?? input.driver;
    const bindingSnapshot = relation.binding?.snapshotId ?? input.snapshotId;
    const bindingTarget = relation.binding?.executionTargetFingerprint ?? input.executionTargetFingerprint;
    const relationBindingInput: PhysicalRelationBindingV1 = relation.binding ? {
      ...relation.binding,
      ...(bindingDriver ? { driver: bindingDriver } : {}),
      ...(bindingSnapshot ? { snapshotId: bindingSnapshot } : {}),
      ...(bindingTarget ? { executionTargetFingerprint: bindingTarget } : {}),
    } : physicalRelationBinding({
      logicalRelation: logicalKey,
      physicalRelation: physicalOf(logicalKey) ?? [relation.database ?? databaseOf(logicalKey) ?? (input.driver?.toLowerCase() === 'snowflake' ? input.defaultDatabase : undefined), relation.schema, relation.name].filter(Boolean).join('.'),
      driver: input.driver,
      snapshotId: input.snapshotId,
      executionTargetFingerprint: input.executionTargetFingerprint,
      source: relation.columnCompleteness === 'complete' ? 'runtime_catalog' : 'dbt_manifest',
      columns: relation.columns.map((column) => ({ name: column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) })),
      columnCompleteness: relation.columnCompleteness ?? 'partial',
      ...(relation.observedAt ? { observedAt: relation.observedAt } : {}),
      ...(relation.truncated ? { truncated: true } : {}),
    });
    let relationBinding = relationBindingInput;
    const identity = physicalRelationIdentity(physicalRelationText(relationBinding));
    const observed = relationBinding.source === 'warehouse_probe' || relationBinding.source === 'runtime_catalog' || relation.columnCompleteness === 'complete';
    const looseExistingKey = observed ? relationKeyByLooseIdentity.get(looseIdentity(relationBinding)) : undefined;
    const exactExistingKey = relationKeyByIdentity.get(identity) ?? looseExistingKey;
    if (!relationKeyByIdentity.has(identity) && looseExistingKey) {
      // Adopt the provenance spelling so the merge below sees one identity.
      const prior = relationItems.get(looseExistingKey)?.binding;
      if (prior) relationBinding = { ...relationBinding, ...(prior.database ? { database: prior.database } : {}), ...(prior.schema ? { schema: prior.schema } : {}), table: prior.table };
    }
    // The first spelling remains a legacy compatibility key. A second exact
    // database receives its full physical identity as the source key; it must
    // never merge into, or overwrite, the first database's columns.
    const key = exactExistingKey
      ?? (relationSeen.has(logicalKey) ? physicalRelationText(relationBinding) : logicalKey);
    if (relationSeen.has(key)) {
      const existing = relationItems.get(key);
      if (existing && relation.columnLineage) existing.columnLineage = { ...(existing.columnLineage ?? {}), ...relation.columnLineage };
      if (existing && relation.domain) {
        // Ownership is the set of every entity bound to the relation, in no order.
        existing.domains = [...new Set([...(existing.domains ?? (existing.domain ? [existing.domain] : [])), relation.domain])].sort();
        existing.domain = existing.domains[0];
      }
      const names = relationColumns.get(key) ?? new Set<string>();
      for (const column of relation.columns) {
        const known = existing?.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
        if (!known) { existing?.columns.push(column); names.add(column.name); }
        else if (!known.dataType && column.dataType) known.dataType = column.dataType;
        if (column.description && !columnDescriptions.has(`${key}.${column.name}`)) columnDescriptions.set(`${key}.${column.name}`, column.description);
      }
      relationColumns.set(key, names);
      if (existing && relation.embeddedColumns?.length) {
        const seenEmbedded = new Set((existing.embeddedColumns ?? []).map((column) => column.name.toLowerCase()));
        for (const column of relation.embeddedColumns) {
          if (!seenEmbedded.has(column.name.toLowerCase())) {
            (existing.embeddedColumns ??= []).push({ ...column });
            seenEmbedded.add(column.name.toLowerCase());
          }
        }
      }
      if (existing && !existing.description && relation.description) existing.description = relation.description;
      if (existing) {
        const prior = existing.binding;
        if (prior) {
          const merged = mergePhysicalRelationBinding(prior, relationBinding);
          // A cross-database collision stays explicit in the binding rather
          // than silently moving a logical relation to another Snowflake DB.
          if (merged.binding) existing.binding = merged.binding;
          else {
            // No route is allowed to reuse the first binding after dbt
            // described the same logical schema.table in another database.
            // A missing binding is an explicit ambiguity that discovery and
            // the SQL validator can surface; it is never a current-database
            // fallback.
            relationKeyByIdentity.delete(physicalRelationIdentity(physicalRelationText(prior)));
            relationKeyByLooseIdentity.delete(looseIdentity(prior));
            existing.binding = undefined;
            existing.columnCompleteness = 'unknown';
          }
        } else {
          existing.binding = relationBinding;
          relationKeyByIdentity.set(physicalRelationIdentity(physicalRelationText(relationBinding)), key);
          relationKeyByLooseIdentity.set(looseIdentity(relationBinding), key);
        }
        if (relation.columnCompleteness === 'complete') existing.columnCompleteness = 'complete';
        else if (!existing.columnCompleteness) existing.columnCompleteness = relation.columnCompleteness ?? 'partial';
      }
      return;
    }
    relationSeen.add(key);
    if (!relationKeyByLower.has(spelled.toLowerCase())) relationKeyByLower.set(spelled.toLowerCase(), logicalKey);
    relationKeyByLower.set(key.toLowerCase(), key);
    relationColumns.set(key, new Set(relation.columns.map((column) => column.name)));
    for (const column of relation.columns) if (column.description) columnDescriptions.set(`${key}.${column.name}`, column.description);
    const added = { ...relation, ...(relation.domain ? { domains: [relation.domain] } : {}), binding: relationBinding, columnCompleteness: relation.columnCompleteness ?? 'partial', columns: relation.columns.map((column) => ({ ...column })), ...(relation.embeddedColumns?.length ? { embeddedColumns: relation.embeddedColumns.map((column) => ({ ...column })) } : {}) };
    source.relations!.push(added);
    relationItems.set(key, added);
    relationKeyByIdentity.set(physicalRelationIdentity(physicalRelationText(relationBinding)), key);
    relationKeyByLooseIdentity.set(looseIdentity(relationBinding), key);
  };

  // Physical relations: dbt sources recorded in the manifest, then anything the host introspected.
  for (const item of Object.values(input.manifest?.sources ?? {})) {
    const dbt = item.dbtModel;
    if (!dbt) continue;
    const columns = Object.values(dbt.columns ?? {}).map((column) => ({ name: column.name, ...(column.type ? { dataType: column.type } : {}), ...(column.description ? { description: column.description } : {}) }));
    // `dbtModel.database` is the provenance for this logical source.  Dropping
    // it creates an unqualified manifest relation beside the qualified runtime
    // observation of the *same* target.  The interpreter then renders the
    // partial alias while validation sees the complete one.  Keep the exact
    // database here so the normal exact-binding merge can add the discovered
    // columns to the legacy `schema.table` relation.  Cross-database sources
    // remain separate because `addRelation()` keys their full bindings apart.
    addRelation({
      ...(dbt.database ? { database: dbt.database } : {}),
      ...(dbt.schema ? { schema: dbt.schema } : {}),
      name: item.name,
      ...(dbt.description ? { description: dbt.description } : {}),
      columns,
    });
  }
  // The warehouse's description first (native bindings need the columns), under the names the host asked for.
  for (const relation of input.relations ?? []) addRelation(relation);
  // Every MODELED ENTITY's relation is a physical relation the interpreter may
  // read, whether or not a cube or a dbt source describes it: a table-bound
  // native layer plus Domain Studio bindings is a complete configuration, and
  // the warehouse probe fills the columns. The entity's domain is the
  // relation's owner, which is what a pinned domain admits or excludes.
  for (const entity of Object.values(input.manifest?.modeling?.entities ?? {})) {
    const relation = normalizeRelationName(input.manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    const [schema, name] = relation.includes('.') ? [relation.split('.')[0], relation.split('.').slice(1).join('.')] : [undefined, relation];
    addRelation({ ...(schema ? { schema } : {}), name, ...(entity.businessContext ? { description: entity.businessContext } : {}), columns: [], ...(entity.domain ? { domain: entity.domain } : {}) });
  }

  const layer = input.semanticLayer;
  if (layer) {
    const cubes = layer.listCubes();
    const relationOfCube = new Map<string, string>();
    for (const cube of cubes) {
      const relation = normalizeRelationName(cube.table) ?? cube.name;
      relationOfCube.set(cube.name, relation);
      if (!relationSeen.has(relation)) {
        addRelation({ ...(relation.includes('.') ? { schema: relation.split('.')[0] } : {}), name: relation.split('.').pop()!, ...(cube.description ? { description: cube.description } : {}), columns: [...cube.dimensions.map((d) => ({ name: leafName(cube.name, d.name), dataType: d.type })), ...cube.measures.map((m) => ({ name: leafName(cube.name, m.name) }))] });
      }
    }
    const columnsOf = (cubeName: string) => relationColumns.get(relationOfCube.get(cubeName) ?? '') ?? new Set<string>();
    // Reachability: which cubes can reach a given cube through the join graph (bounded for very large layers).
    const reach = new Map<string, string[]>();
    if (cubes.length <= 200) {
      for (const target of cubes) {
        reach.set(target.name, cubes.filter((from) => from.name === target.name || layer.findJoinPath(from.name, target.name).length > 0).map((from) => from.name));
      }
    }
    const measures = layer.listMeasures();
    const measureByKey = new Map(measures.map((measure) => [`${measure.cube ?? ''}:${measure.name}`, measure]));
    // A model's default time role, for measures that do not name their own.
    const modelTime = new Map<string, string>();
    for (const model of layer.listSemanticModels()) {
      const declared = (model.defaults as { agg_time_dimension?: unknown } | undefined)?.agg_time_dimension;
      if (typeof declared === 'string' && declared) modelTime.set(model.name, declared);
    }
    const timeRoleOf = (model: string | undefined, measure: { aggTimeDimension?: string } | undefined, metric?: { aggTimeDimension?: string }): string | undefined =>
      metric?.aggTimeDimension ?? measure?.aggTimeDimension ?? (model ? modelTime.get(model) : undefined);
    const displayFormatOf = (name: string): { kind: 'currency' | 'percent' | 'number' | 'count' | 'duration'; currency?: string; decimals?: number } | undefined => {
      const format = layer.displayFormatFor(name);
      return format ? { kind: format.kind, ...(format.currency ? { currency: format.currency } : {}), ...(format.decimals !== undefined ? { decimals: format.decimals } : {}) } : undefined;
    };
    const cubeColumns = (cubeName: string) => new Set([...columnsOf(cubeName), ...(cubes.find((cube) => cube.name === cubeName)?.dimensions.map((d) => d.name) ?? []), ...(cubes.find((cube) => cube.name === cubeName)?.measures.map((m) => m.name) ?? [])]);
    for (const metric of layer.listMetrics()) {
      const model = metric.cube ?? metric.semanticModelIds?.[0];
      const measureName = (metric.typeParams?.measure as { name?: string } | undefined)?.name ?? metric.name;
      const measure = model ? (measureByKey.get(`${model}:${measureName}`) ?? measureByKey.get(`${model}:${metric.name}`)) : undefined;
      const relation = model ? relationOfCube.get(model) : undefined;
      const aggregate = (measure?.agg ?? metric.aggregation ?? metric.type)?.toLowerCase();
      const simple = !metric.metricType || metric.metricType === 'simple';
      const filterSpec = parseMetricFilter(metric.filter);
      const filters = filterSpec.predicates;
      // A filtered simple metric binds physically only when every filter column
      // lives on the metric's own model AND every declared filter was read: a
      // scope this cannot express must not be silently dropped.
      const knownColumns = model ? cubeColumns(model) : new Set<string>();
      const localFilters = filterSpec.unparsed.length === 0 && filters.every((filter) => knownColumns.has(filter.column));
      let physical: { relation: string; expr: string; aggregate: string } | undefined;
      // A measure may write its whole aggregate ("COUNT(DISTINCT claim_id)") as well as a bare column.
      // Read the aggregate out of the text, so the binding is "count_distinct of claim_id" and not an
      // aggregate over an aggregate; a mix of aggregates is left to the semantic engine.
      const written = relation && measure && aggregate && AGGREGATES.has(aggregate) ? nativeAggregateBinding(measure.expr ?? measure.name, aggregate) : undefined;
      if (relation && written && simple && localFilters) {
        const base = qualifyExpression(written.expr, addressed(relation), knownColumns, physicalQuote);
        const expr = scopedAggregateExpression(base, written.aggregate, filters.map((filter) => `${qualifyExpression(filter.column, addressed(relation), knownColumns, physicalQuote)} ${filter.condition}`));
        physical = { relation, expr, aggregate: written.aggregate };
      }
      // A derived or ratio metric binds physically ONLY when plain SQL can
      // express it: every input a simple metric with no offset, window,
      // cumulative grain or input filter, and no two inputs the same metric
      // under different aliases (the prior-period trick). Anything with a
      // time feature is the semantic engine's alone; the relational tier
      // must refuse it rather than approximate it.
      let derived: { expr: string; inputs: Array<{ alias: string; ref: string }> } | undefined = undefined;
      let engineOnly: string | undefined;
      if (!physical && (metric.metricType === 'derived' || metric.metricType === 'ratio')) {
        type InputSpec = { name?: string; alias?: string; offset_window?: unknown; offset_to_grain?: unknown; filter?: unknown };
        const params = metric.typeParams as { expr?: string; metrics?: InputSpec[]; numerator?: InputSpec | string; denominator?: InputSpec | string; window?: unknown; grain_to_date?: unknown; cumulative_type_params?: unknown } | undefined;
        const spec = (value: InputSpec | string | undefined): InputSpec | undefined => typeof value === 'string' ? { name: value } : value;
        const numerator = spec(params?.numerator);
        const denominator = spec(params?.denominator);
        const expression = metric.metricType === 'ratio' && numerator?.name && denominator?.name ? `${numerator.name} / ${denominator.name}` : params?.expr;
        const inputs: InputSpec[] = metric.metricType === 'ratio' ? [numerator, denominator].filter((item): item is InputSpec => Boolean(item?.name)) : (params?.metrics ?? []).filter((item) => item.name);
        const timeFeature = inputs.find((item) => item.offset_window || item.offset_to_grain);
        const filtered = inputs.find((item) => item.filter);
        const names = inputs.map((item) => item.name);
        if (timeFeature) engineOnly = `a prior-period offset on ${timeFeature.name}`;
        else if (params?.window || params?.grain_to_date || params?.cumulative_type_params) engineOnly = 'a cumulative window';
        else if (filtered) engineOnly = `an input-level filter on ${filtered.name}`;
        else if (new Set(names).size !== names.length) engineOnly = 'the same input metric under several aliases';
        if (!engineOnly) {
          const bound = inputs.map((item) => {
            const inputMetric = layer.listMetrics().find((candidate) => candidate.name === item.name);
            const inputModel = inputMetric?.cube ?? inputMetric?.semanticModelIds?.[0];
            const inputMeasureName = (inputMetric?.typeParams?.measure as { name?: string } | undefined)?.name ?? item.name;
            const inputMeasure = inputModel ? measureByKey.get(`${inputModel}:${inputMeasureName}`) : undefined;
            const agg = inputMeasure?.agg?.toLowerCase();
            if (!inputMetric || !inputModel || !inputMeasure || !agg || !AGGREGATES.has(agg) || (inputMetric.metricType && inputMetric.metricType !== 'simple')) return undefined;
            const inputRelation = relationOfCube.get(inputModel);
            if (!inputRelation) return undefined;
            const inner = qualifyExpression(inputMeasure.expr ?? inputMeasure.name, addressed(inputRelation), cubeColumns(inputModel), physicalQuote);
            return { alias: item.alias ?? item.name!, ref: `metric:${inputModel}.${inputMetric.name}`, sql: agg === 'count_distinct' ? `COUNT(DISTINCT ${inner})` : `${agg.toUpperCase()}(${inner})`, relation: inputRelation };
          });
          if (expression && bound.length && bound.every(Boolean)) {
            const relations = new Set(bound.map((item) => item!.relation));
            if (relations.size === 1) {
              // One relation: the formula over the aggregates is one SELECT.
              let expr = metric.metricType === 'ratio' ? `${numerator!.name} / NULLIF(${denominator!.name}, 0)` : expression;
              for (const item of bound) expr = expr.replace(new RegExp(`\\b${item!.alias}\\b`, 'g'), `(${item!.sql})`);
              physical = { relation: bound[0]!.relation, expr, aggregate: 'derived' };
            } else {
              // Several relations: each input is aggregated on its own
              // relation and the formula is evaluated afterwards.
              derived = { expr: expression, inputs: bound.map((item) => ({ alias: item!.alias, ref: item!.ref })) };
            }
          }
        }
      }
      // A native DQL metric has no cube and no measure, only its own table,
      // expression and type. Without this binding the interpreter can name a
      // metric that discovery admitted and no governed tier can execute.
      if (!physical && !derived && !engineOnly && simple) {
        const nativeRelation = normalizeRelationName(metric.table);
        const nativeColumns = nativeRelation ? relationColumns.get(nativeRelation) : undefined;
        const native = nativeRelation && nativeColumns ? nativeAggregateBinding(metric.sql, metric.type ?? metric.aggregation) : undefined;
        // A native metric may declare the rows its definition counts
        // ("participated = true"): the scope binds with the aggregate, or the
        // metric stays with the semantic engine.
        const scopable = filterSpec.unparsed.length === 0 && filters.every((filter) => filter.entityPath.length === 0 && nativeColumns?.has(filter.column));
        if (nativeRelation && nativeColumns && native && scopable) {
          const base = qualifyExpression(native.expr, addressed(nativeRelation), nativeColumns, physicalQuote);
          const expr = scopedAggregateExpression(base, native.aggregate, filters.map((filter) => `${qualifyExpression(filter.column, addressed(nativeRelation), nativeColumns, physicalQuote)} ${filter.condition}`));
          physical = { relation: nativeRelation, expr, aggregate: native.aggregate };
        } else if (nativeRelation && nativeColumns && native && !scopable) {
          engineOnly = 'a declared scope the relational tier cannot bind to this relation';
        }
      }
      // A native metric whose expression is a formula OF aggregates over its
      // own table (points per game = SUM(points) / NULLIF(SUM(games), 0))
      // binds as a derived aggregate: the formula is emitted as written inside
      // the grouped query, never wrapped in another SUM or AVG.
      if (!physical && !derived && !engineOnly) {
        const nativeRelation = normalizeRelationName(metric.table);
        const formula = nativeRelation && relationColumns.has(nativeRelation) ? nativeFormulaBinding(metric.sql) : undefined;
        // A formula of aggregates cannot carry a per-row scope: the scope
        // belongs inside each aggregate, and this one is written as a whole.
        if (nativeRelation && formula && filters.length === 0 && filterSpec.unparsed.length === 0) physical = { relation: nativeRelation, expr: qualifyExpression(formula, addressed(nativeRelation), relationColumns.get(nativeRelation) ?? [], physicalQuote), aggregate: 'derived' };
        else if (nativeRelation && formula) engineOnly = 'a scoped formula of aggregates';
      }
      if (!physical && !derived && !engineOnly && metric.metricType && metric.metricType !== 'simple') engineOnly = `a ${metric.metricType} metric the relational tier cannot compose`;
      const scopeNote = filters.length ? ` Only where ${filters.map((filter) => `${filter.column} ${filter.condition}`).join(' and ')}.` : '';
      const kindNote = engineOnly ? ` (${metric.metricType} metric: semantic engine only, ${engineOnly})` : !simple && !physical && !derived ? ` (${metric.metricType} metric: semantic engine only)` : '';
      const timeRole = timeRoleOf(model, measure, metric);
      const displayFormat = displayFormatOf(metric.name);
      source.metrics!.push({
        name: metric.name, ...(model ? { model } : {}), label: metric.label, description: `${metric.description ?? ''}${scopeNote}${kindNote}`.trim(),
        ...(aggregate ? { aggregation: aggregate } : {}), ...(metric.metricType ? { type: metric.metricType } : {}), expr: metric.sql, sourceId: metric.name,
        ...(metric.status ? { status: metric.status } : {}), ...(physical ? { physical } : {}),
        ...(metric.synonyms?.length ? { aliases: metric.synonyms } : {}),
        ...(timeRole ? { aggTimeDimension: timeRole } : {}), ...(displayFormat ? { displayFormat } : {}),
        ...(derived ? { derived } : {}), ...(engineOnly ? { engineOnly } : {}),
      });
    }
    const metricNames = new Set(layer.listMetrics().map((metric) => metric.name));
    for (const measure of measures) {
      if (!measure.cube || metricNames.has(measure.name)) continue;
      const relation = relationOfCube.get(measure.cube);
      const aggregate = measure.agg?.toLowerCase();
      const timeRole = timeRoleOf(measure.cube, measure);
      const displayFormat = displayFormatOf(measure.name);
      source.measures!.push({
        name: measure.name, model: measure.cube, label: measure.label, description: measure.description, ...(aggregate ? { aggregation: aggregate } : {}),
        ...(measure.expr ? { expr: measure.expr } : {}), sourceId: measure.name,
        ...(relation && aggregate && AGGREGATES.has(aggregate) ? { physical: { relation, expr: qualifyExpression(measure.expr ?? measure.name, addressed(relation), cubeColumns(measure.cube), physicalQuote), aggregate } } : {}),
        ...(timeRole ? { aggTimeDimension: timeRole } : {}), ...(displayFormat ? { displayFormat } : {}),
      });
    }
    // A native DQL dimension names its own table instead of a cube. Its home
    // is that relation, and its model name is the relation's own leaf so the
    // ref stays stable (dimension:<table>.<name>).
    const dimensionHome = (dimension: { cube?: string; table?: string }): { model: string; relation?: string } | undefined => {
      if (dimension.cube) return { model: dimension.cube, ...(relationOfCube.get(dimension.cube) ? { relation: relationOfCube.get(dimension.cube) } : {}) };
      const relation = normalizeRelationName(dimension.table);
      if (!relation || !relationColumns.has(relation)) return undefined;
      return { model: relation.split('.').pop()!, relation };
    };
    const timeNames = new Set<string>();
    for (const dimension of layer.listTimeDimensions(undefined, { includeVariants: true })) {
      const home = dimensionHome(dimension);
      if (!home) continue;
      const name = leafName(home.model, dimension.name);
      timeNames.add(`${home.model}:${name}`);
      const relation = home.relation;
      const timeExpression = dimension.expr ?? dimension.sql;
      const column = timeExpression === undefined || timeExpression === '' ? name : isIdentifier(timeExpression) ? timeExpression : undefined;
      source.dimensions!.push({
        name, model: home.model, label: dimension.label, description: dimension.description || (relation && column ? columnDescriptions.get(`${relation}.${column}`) : undefined), dataType: 'timestamp', isTime: true,
        ...(dimension.granularities?.length ? { timeGrains: dimension.granularities } : {}), sourceId: `${home.model}.${dimension.name}`, ...(dimension.source?.objectType === 'dbt_column' ? { inventory: true } : {}),
        ...(reach.get(home.model)?.length ? { reachableFrom: reach.get(home.model) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const dimension of layer.listDimensions(undefined, { includeVariants: true })) {
      const home = dimensionHome(dimension);
      if (!home) continue;
      const name = leafName(home.model, dimension.name);
      if (timeNames.has(`${home.model}:${name}`)) continue;
      const relation = home.relation;
      // A dimension with no expression IS its column; dbt names it once.
      const expression = dimension.expr ?? dimension.sql;
      const column = expression === undefined || expression === '' ? name : isIdentifier(expression) ? expression : undefined;
      source.dimensions!.push({
        name, model: home.model, label: dimension.label, description: dimension.description || (relation && column ? columnDescriptions.get(`${relation}.${column}`) : undefined), dataType: dimension.type,
        ...(dimension.isTimeDimension ? { isTime: true } : {}), sourceId: `${home.model}.${dimension.name}`, ...(dimension.source?.objectType === 'dbt_column' ? { inventory: true } : {}),
        ...(reach.get(home.model)?.length ? { reachableFrom: reach.get(home.model) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const entity of layer.listEntities()) {
      if (!entity.cube) continue;
      const relation = relationOfCube.get(entity.cube);
      const column = isIdentifier(entity.expr ?? entity.name) ? (entity.expr ?? entity.name) : undefined;
      source.entities!.push({
        name: entity.name, model: entity.cube, type: entity.type, label: entity.label, description: entity.description, sourceId: `${entity.cube}.${entity.name}`,
        ...(reach.get(entity.cube)?.length ? { reachableFrom: reach.get(entity.cube) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const model of layer.listSemanticModels()) {
      source.models!.push({ name: model.name, label: model.label, description: model.description, ...(relationOfCube.get(model.name) ? { relation: relationOfCube.get(model.name) } : {}) });
    }
  }

  // Retired blocks never answer. A retired block that names its replacement
  // lends its name to that replacement, so a question that still asks for the
  // old block reaches the new one (and the run says it did).
  const manifestBlocks = Object.values(input.manifest?.blocks ?? {});
  const supersededBy = new Map<string, Array<{ name: string; deprecatedOn?: string }>>();
  for (const block of manifestBlocks) {
    const replacement = resolveBlockReplacement(manifestBlocks, block)?.replacement;
    if (!replacement) continue;
    const list = supersededBy.get(replacement.name) ?? [];
    list.push({ name: block.name, ...(block.deprecatedOn ? { deprecatedOn: block.deprecatedOn } : {}) });
    supersededBy.set(replacement.name, list);
  }
  for (const block of manifestBlocks) {
    const certified = (block.status ?? '').toLowerCase() === 'certified';
    if (!certified) continue;
    if (certifiedBlockContradiction(block)) continue;
    source.blocks!.push({
      name: block.name, ...(block.domain ? { domain: block.domain } : {}), ...(block.description ? { description: block.description } : {}), certified, status: block.status,
      ...(block.filePath ? { sourcePath: block.filePath } : {}),
      ...(block.owner?.trim() ? { owner: block.owner.trim() } : {}),
      contract: extractBlockContract({
        name: block.name, domain: block.domain, sql: block.sql, declaredOutputs: block.declaredOutputs, dimensions: block.dimensions, allowedFilters: block.allowedFilters,
        parameters: block.parameters?.map((parameter) => parameter.name), grain: block.grain, entities: block.entities, tableDependencies: block.tableDependencies, rawTableRefs: block.rawTableRefs,
        metricMappings: block.metricMappings,
      }),
      ...(block.examples?.length ? { examples: block.examples.map((example) => example.question) } : {}),
      ...(block.tags?.length ? { tags: block.tags } : {}), sql: block.sql,
      ...(supersededBy.get(block.name)?.length ? { supersedes: supersededBy.get(block.name) } : {}),
    });
  }
  for (const term of Object.values(input.manifest?.terms ?? {})) {
    if ((term.status ?? '').toLowerCase() === 'deprecated') continue;
    // A term's rules and caveats are kept apart from its description: the
    // card renders them as `rules:` so the reader knows they govern the word.
    const rules = [...((term as { businessRules?: string[] }).businessRules ?? []), ...((term as { caveats?: string[] }).caveats ?? [])];
    const identifiers = (term as { identifiers?: string[] }).identifiers ?? [];
    source.terms!.push({
      name: term.name, ...(term.synonyms?.length || identifiers.length ? { synonyms: [...new Set([...(term.synonyms ?? []), ...identifiers])] } : {}),
      ...(term.description ? { description: term.description } : {}), ...(rules.length ? { rules } : {}),
      ...(term.metricRefs?.length ? { metricRefs: term.metricRefs } : {}), ...(term.domain ? { domain: term.domain } : {}),
    });
  }
  // What each column of a dbt model is COMPUTED FROM, read once from the
  // model's own SQL: `wins` in the season facts is SUM(CASE WHEN team_won …)
  // over the game facts, so a question that says "team_won" is satisfied by
  // a reading of `wins`. Attached to the relation, per column, host-only.
  for (const [relation, lineage] of Object.entries(modelColumnLineage(input.manifest))) {
    const [schema, name] = relation.includes('.') ? [relation.split('.')[0], relation.split('.').slice(1).join('.')] : [undefined, relation];
    addRelation({ ...(schema ? { schema } : {}), name, columns: [], columnLineage: lineage });
  }
  // Keep semantic refs backward compatible (`schema.table`) while attaching
  // the one executable binding their compiler, relational composer, drafter,
  // validator and executor must share.  If a short alias reaches two physical
  // databases, no binding is attached through that alias; preparation can
  // report the ambiguity without reading from an arbitrary current database.
  const bindingByLogical = new Map<string, PhysicalRelationBindingV1[]>();
  for (const relation of source.relations ?? []) {
    if (!relation.binding) continue;
    const keys = new Set([relation.binding.logicalRelation, relation.schema ? `${relation.schema}.${relation.name}` : relation.name, ...(relation.binding.aliases ?? [])]);
    for (const key of keys) {
      const normalized = normalizeRelationName(key)?.toLowerCase();
      if (!normalized) continue;
      const bindings = bindingByLogical.get(normalized) ?? [];
      bindings.push(relation.binding);
      bindingByLogical.set(normalized, bindings);
    }
  }
  const bindingFor = (relation: string | undefined): PhysicalRelationBindingV1 | undefined => {
    const normalized = normalizeRelationName(relation)?.toLowerCase();
    if (!normalized) return undefined;
    const candidates = bindingByLogical.get(normalized) ?? [];
    const physical = new Map(candidates.map((binding) => [physicalRelationIdentity(physicalRelationText(binding)), binding]));
    return physical.size === 1 ? [...physical.values()][0] : undefined;
  };
  const attachBinding = <T extends { physical?: VocabularyEntry['physical'] }>(items: T[] | undefined) => {
    for (const item of items ?? []) {
      if (!item.physical?.relation || item.physical.binding) continue;
      const binding = bindingFor(item.physical.relation);
      // `physical.relation` KEEPS the logical spelling (`dev.customers`): it is
      // what column refs are written with and what every comparison in the
      // pipeline reads (a numeric dimension read as its column, the time axis
      // a metric owns, the relations a reading names). The exact
      // database-qualified name travels in `binding`, and every statement
      // (composer, probes, drafter, validator) renders from the binding.
      // Rewriting the logical field here silently broke those comparisons on
      // any project whose provenance carries a database.
      if (binding) item.physical = { ...item.physical, binding };
    }
  };
  attachBinding(source.metrics);
  attachBinding(source.measures);
  attachBinding(source.dimensions);
  attachBinding(source.entities);
  // What a modeled thing IS: the business context and grain a Domain Studio
  // entity binding carries, attached to the physical relation it binds.
  const nodes = input.manifest?.dbtProvenance?.nodes ?? {};
  for (const entity of Object.values(input.manifest?.modeling?.entities ?? {})) {
    const relation = normalizeRelationName((nodes as Record<string, { relation?: string } | undefined>)[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    source.relationMeaning = source.relationMeaning ?? {};
    source.relationMeaning[relation] = {
      ...(entity.businessName ? { businessName: entity.businessName } : {}),
      ...(entity.businessContext ? { businessContext: entity.businessContext } : {}),
      ...(entity.grain ? { grain: entity.grain } : {}),
      ...(entity.domain ? { domain: entity.domain } : {}),
    };
  }
  return source;
}

const SQL_KEYWORDS = new Set(['select', 'from', 'where', 'as', 'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'true', 'false', 'is', 'in', 'distinct', 'group', 'by', 'order', 'having', 'on', 'join', 'left', 'right', 'inner', 'outer', 'over', 'partition', 'between', 'like', 'cast', 'integer', 'int', 'varchar', 'text', 'date', 'timestamp', 'boolean', 'double', 'decimal', 'numeric', 'bigint', 'interval', 'coalesce', 'nullif', 'sum', 'count', 'avg', 'min', 'max', 'round', 'abs', 'lower', 'upper', 'trim', 'concat', 'extract', 'year', 'month', 'day', 'with', 'union', 'all', 'limit', 'asc', 'desc', 'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value', 'if', 'ifnull', 'iff', 'greatest', 'least', 'current_date', 'current_timestamp', 'exists', 'any', 'some', 'values', 'using', 'natural', 'cross', 'full', 'filter', 'within', 'try_cast', 'date_trunc', 'datediff', 'dateadd', 'floor', 'ceil', 'ceiling', 'string', 'char', 'float', 'real', 'smallint', 'tinyint']);

/**
 * The identifiers each output column of a SELECT is computed from, by column
 * name. Only the outermost select list is read; an expression's alias is the
 * column, its own tokens (minus keywords, functions and literals) are its
 * lineage; a bare column is its own lineage. Anything the parser cannot read
 * yields no lineage — a missing entry is never a false satisfaction.
 */
export function columnLineageFromSql(sql: string): Record<string, string[]> {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
  // The outermost SELECT list: from the LAST top-level `select` (a CTE's body is not the model's output) to its FROM.
  let depth = 0; let selectAt = -1; let fromAt = -1;
  const lower = text.toLowerCase();
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\bselect\b/.test(lower.slice(Math.max(0, index - 1), index + 7)) && lower.startsWith('select', index) && (index === 0 || !/[a-z0-9_]/.test(lower[index - 1]!))) { selectAt = index; fromAt = -1; }
    else if (depth === 0 && selectAt >= 0 && fromAt < 0 && lower.startsWith('from', index) && !/[a-z0-9_]/.test(lower[index - 1] ?? ' ') && !/[a-z0-9_]/.test(lower[index + 4] ?? ' ')) fromAt = index;
  }
  if (selectAt < 0 || fromAt < 0) return {};
  const list = text.slice(selectAt + 'select'.length, fromAt).replace(/^\s*distinct\b/i, '');
  const items: string[] = []; let current = ''; depth = 0;
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { items.push(current); current = ''; } else current += char;
  }
  items.push(current);
  const out: Record<string, string[]> = {};
  for (const raw of items) {
    const item = raw.trim();
    if (!item || item === '*' || item.endsWith('.*')) continue;
    const aliased = /^(.*?)\s+as\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/i.exec(item);
    const expression = aliased ? aliased[1]! : item;
    const alias = aliased ? aliased[2]! : (/"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/.exec(item)?.[1] ?? '');
    if (!alias) continue;
    // A token followed by `(` is a function, not a column.
    const tokens = [...new Set([...expression.replace(/'[^']*'/g, ' ').matchAll(/([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g)].filter((match) => !match[2]).map((match) => match[1]!.toLowerCase()).filter((token) => !SQL_KEYWORDS.has(token) && !/^\d/.test(token)))];
    // A qualified reference `t.col` contributes col; the qualifier is not a column.
    const qualified = new Set((expression.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*"?[A-Za-z_]/g) ?? []).map((match) => match.split('.')[0]!.trim().toLowerCase()));
    out[alias.toLowerCase()] = tokens.filter((token) => !qualified.has(token) && token !== alias.toLowerCase() || (token === alias.toLowerCase() && !aliased));
  }
  return out;
}

/** Column lineage for every dbt model of the manifest, keyed by `schema.table`, from the model SQL the (cached) dbt artifact carries. */
export function modelColumnLineage(manifest: DQLManifest | undefined): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const node of dbtArtifactNodes(manifest?.dbtProvenance?.manifestPath)) {
    if (node.resourceType !== 'model' || !node.lineage) continue;
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[node.uniqueId]?.relation);
    if (relation) out[relation] = node.lineage;
  }
  return out;
}

/**
 * The dbt model inventory names a column dimension `<model>.<column>`; the
 * vocabulary names the column once (`dimension:<model>.<column>`, physical
 * column `<column>`), never `<model>.<model>.<column>`.
 */
export function leafName(cube: string, name: string): string {
  return name.startsWith(`${cube}.`) ? name.slice(cube.length + 1) : name;
}

export function buildProjectVocabulary(input: VocabularySourceInput): VocabularyIndex {
  return buildVocabularyIndex(buildVocabularySource(input));
}

export type { VocabularyEntry };
