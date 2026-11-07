import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_MAX_UNMATCHED_SHARE, relationshipKeyTypes, relationshipValidationProofFingerprint, type DQLManifest, type ManifestFanoutPolicy, type ManifestRelationshipCardinality, type ManifestRelationshipValidationEvidence, type ManifestRelationshipValidationScope } from '@zlens/core';

/**
 * ONE PROOF, TWO ASKERS. Domain Studio's Validate action and Ask's warehouse
 * proof used to ask the warehouse different questions about the same pair of
 * relations and write down different evidence. This is the one statement and
 * the one evidence shape both use now: whoever ran it, the evidence is what a
 * certification reuses (REL-005).
 */

export interface RelationshipValidationSpec {
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  /** The key columns' types when known, so the proof fingerprint notices a type change. */
  keyTypes?: Array<{ from?: string; to?: string }>;
  /**
   * The largest share of "from" rows with a key that may find no "to" row
   * (many-to-one and one-to-one). Omitted: DEFAULT_MAX_UNMATCHED_SHARE. Set
   * only when the relationship declares it, so it joins the proof then.
   */
  maxUnmatchedShare?: number;
  /** `referenced_keys`: judge the "one" side's uniqueness over the keys the join reaches only. */
  scope?: ManifestRelationshipValidationScope;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertSafeRelationshipIdentifier(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) throw new Error(`Unsafe SQL identifier in relationship validation: ${identifier}`);
  return identifier;
}

export function quoteQualifiedRelation(relation: string, quote: (identifier: string) => string): string {
  return relation.replace(/"/g, '').split('.').filter(Boolean).map((part) => quote(assertSafeRelationshipIdentifier(part))).join('.');
}

/** Engines on which `rows` is a reserved word and cannot name a column. */
// `rows` is a reserved word there: Snowflake refused every join check with it (live, 2026-11-07); BigQuery reserves it too.
const ROWS_RESERVED = new Set(['mysql', 'mariadb', 'snowflake', 'bigquery']);

/**
 * The validation statement: row counts, null keys, max rows per key on both
 * sides (over the whole table, and over the keys the other side references),
 * joined rows, rows the join would drop, and how many distinct keys those rows
 * hold. Aggregates only: no row value leaves the warehouse.
 *
 * Joined and dropped rows are summed from per-key row counts rather than by
 * running the join: a many-to-many candidate (two big tables sharing a
 * five-value channel id) would otherwise make the warehouse enumerate billions
 * of row pairs. The counts are exact either way; a row whose key is NULL never
 * joins, and is counted as dropped, as a real join would drop it. The
 * referenced-key maxima join the per-key counts too, one row per key.
 *
 * `dialect` renames the inner `rows` alias on engines that reserve the word
 * (MySQL, MariaDB); every other engine gets the same statement text. A proof
 * keeps the query fingerprint it was written with, so evidence recorded with
 * the earlier statement text stays current.
 */
export function relationshipValidationSql(spec: RelationshipValidationSpec, quote: (identifier: string) => string, dialect?: string): string {
  if (!spec.keys.length) throw new Error('At least one join key pair is required.');
  const safeQuote = (identifier: string) => quote(assertSafeRelationshipIdentifier(identifier));
  const fromRelation = quoteQualifiedRelation(spec.fromRelation, quote);
  const toRelation = quoteQualifiedRelation(spec.toRelation, quote);
  const fromNull = spec.keys.map((key) => `f.${safeQuote(key.from)} IS NULL`).join(' OR ');
  const toNull = spec.keys.map((key) => `t.${safeQuote(key.to)} IS NULL`).join(' OR ');
  const join = spec.keys.map((key) => `f.${safeQuote(key.from)} = t.${safeQuote(key.to)}`).join(' AND ');
  const fromKeys = spec.keys.map((key) => safeQuote(key.from)).join(', ');
  const toKeys = spec.keys.map((key) => safeQuote(key.to)).join(', ');
  const rows = dialect && ROWS_RESERVED.has(dialect.toLowerCase()) ? 'row_total' : 'rows';
  return `WITH
from_counts AS (SELECT COUNT(*) AS ${rows}, SUM(CASE WHEN ${fromNull} THEN 1 ELSE 0 END) AS null_keys FROM ${fromRelation} f),
to_counts AS (SELECT COUNT(*) AS ${rows}, SUM(CASE WHEN ${toNull} THEN 1 ELSE 0 END) AS null_keys FROM ${toRelation} t),
from_keys AS (SELECT ${fromKeys}, COUNT(*) AS key_count FROM ${fromRelation} GROUP BY ${fromKeys}),
to_keys AS (SELECT ${toKeys}, COUNT(*) AS key_count FROM ${toRelation} GROUP BY ${toKeys}),
from_max AS (SELECT COALESCE(MAX(key_count), 0) AS max_per_key FROM from_keys),
to_max AS (SELECT COALESCE(MAX(key_count), 0) AS max_per_key FROM to_keys),
joined AS (SELECT COALESCE(SUM(f.key_count * t.key_count), 0) AS ${rows} FROM from_keys f JOIN to_keys t ON ${join}),
unmatched AS (SELECT COALESCE(SUM(f.key_count), 0) AS ${rows} FROM from_keys f LEFT JOIN to_keys t ON ${join} WHERE t.key_count IS NULL),
unmatched_keyed AS (SELECT COALESCE(SUM(f.key_count), 0) AS ${rows}, COUNT(*) AS key_values FROM from_keys f LEFT JOIN to_keys t ON ${join} WHERE t.key_count IS NULL AND NOT (${fromNull})),
referenced_max AS (SELECT COALESCE(MAX(f.key_count), 0) AS max_from_per_key, COALESCE(MAX(t.key_count), 0) AS max_to_per_key FROM from_keys f JOIN to_keys t ON ${join})
SELECT from_counts.${rows} AS from_rows, to_counts.${rows} AS to_rows, joined.${rows} AS joined_rows,
  from_counts.null_keys AS from_null_keys, to_counts.null_keys AS to_null_keys,
  unmatched.${rows} AS unmatched_from, from_max.max_per_key AS max_from_per_key, to_max.max_per_key AS max_to_per_key,
  unmatched_keyed.${rows} AS unmatched_keyed_from, unmatched_keyed.key_values AS unmatched_key_values,
  referenced_max.max_to_per_key AS max_to_per_referenced_key, referenced_max.max_from_per_key AS max_from_per_referenced_key
FROM from_counts, to_counts, joined, unmatched, from_max, to_max, unmatched_keyed, referenced_max`;
}

const numeric = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
  return 0;
};

/** Read a validation result row, case-insensitively, into the evidence shape Domain Studio certifies against. */
export function relationshipEvidenceFromRow(row: Record<string, unknown>, spec: RelationshipValidationSpec, sql: string, checkedAt = new Date()): ManifestRelationshipValidationEvidence {
  const get = (name: string): unknown => row[name] ?? row[name.toUpperCase()];
  const has = (name: string): boolean => get(name) !== undefined && get(name) !== null;
  const maxFromPerKey = numeric(get('max_from_per_key'));
  const maxToPerKey = numeric(get('max_to_per_key'));
  // A row from an older statement lacks the referenced-key maxima; they then
  // equal the whole-table ones, which are never smaller.
  const maxToPerReferencedKey = has('max_to_per_referenced_key') ? numeric(get('max_to_per_referenced_key')) : maxToPerKey;
  const maxFromPerReferencedKey = has('max_from_per_referenced_key') ? numeric(get('max_from_per_referenced_key')) : maxFromPerKey;
  const scoped = spec.scope === 'referenced_keys';
  const cardinalityHolds = (fromMax: number, toMax: number): boolean => spec.cardinality === 'one_to_one'
    ? fromMax <= 1 && toMax <= 1
    : spec.cardinality === 'one_to_many'
      ? fromMax <= 1
      : spec.cardinality === 'many_to_one'
        ? toMax <= 1
        : false;
  const wholeTableHolds = cardinalityHolds(maxFromPerKey, maxToPerKey);
  const referencedHolds = cardinalityHolds(maxFromPerReferencedKey, maxToPerReferencedKey);
  const cardinalityPassed = scoped ? referencedHolds : wholeTableHolds;

  const fromRows = numeric(get('from_rows'));
  const fromNullKeys = numeric(get('from_null_keys'));
  const unmatchedFrom = numeric(get('unmatched_from'));
  const unmatchedKeyedFrom = has('unmatched_keyed_from') ? numeric(get('unmatched_keyed_from')) : Math.max(0, unmatchedFrom - fromNullKeys);
  const keyedFrom = Math.max(0, fromRows - fromNullKeys);
  const unmatchedShare = keyedFrom > 0 ? unmatchedKeyedFrom / keyedFrom : 0;
  const maxUnmatchedShare = spec.maxUnmatchedShare ?? DEFAULT_MAX_UNMATCHED_SHARE;
  const unmatchedKeyValues = has('unmatched_key_values') ? numeric(get('unmatched_key_values')) : undefined;
  // Every "from" row should find its "to" row when the join points at a parent
  // (many-to-one, one-to-one); a parent without children (one-to-many) is normal.
  const coverageJudged = spec.cardinality === 'many_to_one' || spec.cardinality === 'one_to_one';
  const coveragePassed = !coverageJudged || unmatchedShare <= maxUnmatchedShare;
  const policyPassed = spec.fanout === 'safe' && cardinalityPassed && coveragePassed;
  const queryFingerprint = createHash('sha256').update(sql).digest('hex');

  const findings: string[] = [];
  if (spec.fanout !== 'safe') findings.push(`Only a join with the safe fanout policy can pass (declared: ${spec.fanout}).`);
  if (!cardinalityPassed) findings.push(cardinalityFinding(spec, { maxFromPerKey, maxToPerKey, maxFromPerReferencedKey, maxToPerReferencedKey }, scoped, referencedHolds));
  else if (scoped && !wholeTableHolds) findings.push(`The declared cardinality holds over the keys this join reaches (validation_scope: referenced_keys), not over the whole table (up to ${Math.max(spec.cardinality === 'one_to_many' ? maxFromPerKey : maxToPerKey, 1)} rows per key there).`);
  if (unmatchedKeyedFrom > 0) {
    const counted = `${count(unmatchedKeyedFrom)} of ${count(keyedFrom)} ${relationName(spec.fromRelation)} rows with a key (${percent(unmatchedShare)}) find no ${relationName(spec.toRelation)} row`;
    const placeholder = looksLikePlaceholder({ unmatchedKeyedFrom, unmatchedKeyValues, keyedFrom }) ? '; they all hold the same key value, which reads as a placeholder rather than a reference' : '';
    if (!coverageJudged) findings.push(`${counted}${placeholder}.`);
    else if (!coveragePassed) findings.push(`${counted}${placeholder}, more than the ${percent(maxUnmatchedShare)} allowed. If those rows are expected (an optional parent), declare max_unmatched_share on the relationship and validate again; a join that must keep them needs a LEFT JOIN.`);
    else findings.push(`${counted}${placeholder} (within the ${percent(maxUnmatchedShare)} allowed); a join that must keep them needs a LEFT JOIN.`);
  }
  const headline = policyPassed
    ? 'Warehouse evidence matches the declared cardinality and safe fanout policy.'
    : 'Warehouse evidence does not prove the declared cardinality and safe fanout policy.';
  return {
    status: policyPassed ? 'passed' : 'failed',
    checkedAt: checkedAt.toISOString(),
    queryFingerprint,
    proofFingerprint: relationshipValidationProofFingerprint({
      fromRelation: spec.fromRelation, toRelation: spec.toRelation, keys: spec.keys, cardinality: spec.cardinality, fanout: spec.fanout, queryFingerprint,
      ...(spec.keyTypes ? { keyTypes: spec.keyTypes } : {}),
      ...(spec.maxUnmatchedShare !== undefined ? { maxUnmatchedShare: spec.maxUnmatchedShare } : {}),
      ...(scoped ? { scope: spec.scope } : {}),
    }),
    fromRows,
    toRows: numeric(get('to_rows')),
    joinedRows: numeric(get('joined_rows')),
    fromNullKeys,
    toNullKeys: numeric(get('to_null_keys')),
    unmatchedFrom,
    maxFromPerKey,
    maxToPerKey,
    unmatchedKeyedFrom,
    ...(unmatchedKeyValues !== undefined ? { unmatchedKeyValues } : {}),
    unmatchedShare: Math.round(unmatchedShare * 1_000_000) / 1_000_000,
    maxUnmatchedShare,
    maxToPerReferencedKey,
    maxFromPerReferencedKey,
    ...(scoped ? { scope: spec.scope } : {}),
    message: [headline, ...findings].join(' '),
  };
}

function cardinalityFinding(
  spec: RelationshipValidationSpec,
  measured: { maxFromPerKey: number; maxToPerKey: number; maxFromPerReferencedKey: number; maxToPerReferencedKey: number },
  scoped: boolean,
  referencedHolds: boolean,
): string {
  if (spec.cardinality !== 'many_to_one' && spec.cardinality !== 'one_to_many' && spec.cardinality !== 'one_to_one') {
    return `A ${spec.cardinality} join cannot pass; declare the cardinality the data shows.`;
  }
  const from = relationName(spec.fromRelation);
  const to = relationName(spec.toRelation);
  const repeats: string[] = [];
  const toRepeat = scoped ? measured.maxToPerReferencedKey : measured.maxToPerKey;
  const fromRepeat = scoped ? measured.maxFromPerReferencedKey : measured.maxFromPerKey;
  if (spec.cardinality !== 'one_to_many' && toRepeat > 1) repeats.push(`${to} holds up to ${count(toRepeat)} rows for one key${scoped ? ' the join reaches' : ''}`);
  if (spec.cardinality !== 'many_to_one' && fromRepeat > 1) repeats.push(`${from} holds up to ${count(fromRepeat)} rows for one key${scoped ? ' the join reaches' : ''}`);
  const finding = `The declared ${spec.cardinality} does not hold: ${repeats.join(', and ')}.`;
  // Unique for the rows the join reaches though not across the whole table:
  // say so, and how to certify it on that scope.
  return !scoped && referencedHolds
    ? `${finding} Over the keys this join reaches it does hold (each appears once); declare validation_scope: referenced_keys to certify the join on that scope.`
    : finding;
}

/**
 * Rows that find no match all hold one key value, and enough of them (1% of
 * the keyed rows) that it is not a deleted parent's few children: a
 * placeholder such as 0 or -1 standing in for "none".
 */
export function looksLikePlaceholder(measure: { unmatchedKeyedFrom?: number; unmatchedKeyValues?: number; keyedFrom: number }): boolean {
  const lost = measure.unmatchedKeyedFrom ?? 0;
  return measure.unmatchedKeyValues === 1 && lost > 1 && lost >= measure.keyedFrom * 0.01;
}

function relationName(relation: string): string {
  return relation.replace(/"/g, '').split('.').pop() || relation;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(share: number): string {
  const value = share * 100;
  if (value === 0) return '0%';
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(value >= 1 ? 1 : 2)}%`;
}

/**
 * The cardinality the warehouse shows, and the fanout that follows from it.
 *
 * Asking a person to choose `many_to_one` and `safe` before the data has been
 * looked at meant the defaults (`unknown`) failed every validation. The same
 * statement already measures how many rows share a key on each side, so the
 * builder proposes the answer and the person confirms it.
 */
export function proposeRelationshipCardinality(measure: { fromRows: number; toRows: number; maxFromPerKey: number; maxToPerKey: number }): { cardinality: ManifestRelationshipCardinality; fanout: ManifestFanoutPolicy } {
  if (measure.fromRows <= 0 || measure.toRows <= 0) return { cardinality: 'unknown', fanout: 'unknown' };
  if (measure.maxFromPerKey <= 1 && measure.maxToPerKey <= 1) return { cardinality: 'one_to_one', fanout: 'safe' };
  if (measure.maxToPerKey <= 1) return { cardinality: 'many_to_one', fanout: 'safe' };
  if (measure.maxFromPerKey <= 1) return { cardinality: 'one_to_many', fanout: 'safe' };
  // Keys repeat on both sides: joining multiplies rows, so it is never safe.
  return { cardinality: 'many_to_many', fanout: 'forbidden' };
}

export interface RelationshipProfile {
  proposed: { cardinality: ManifestRelationshipCardinality; fanout: ManifestFanoutPolicy };
  /** Evidence written against the proposed cardinality and fanout, so saving the proposal saves a matching proof. */
  evidence: ManifestRelationshipValidationEvidence;
}

/**
 * Profile a join before its cardinality is known: one statement, the proposed
 * cardinality, and evidence for that proposal (passed when it is joinable).
 */
export async function profileRelationshipOnWarehouse(
  spec: Omit<RelationshipValidationSpec, 'cardinality' | 'fanout'>,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  checkedAt = new Date(),
  dialect?: string,
): Promise<RelationshipProfile> {
  // The statement reads only relations and keys, so it is identical for any declared cardinality.
  const sql = relationshipValidationSql({ ...spec, cardinality: 'unknown', fanout: 'unknown' }, quote, dialect);
  const row = (await execute(sql)).rows[0] ?? {};
  const measured = relationshipEvidenceFromRow(row, { ...spec, cardinality: 'unknown', fanout: 'unknown' }, sql, checkedAt);
  const proposed = proposeRelationshipCardinality(measured);
  const evidence = relationshipEvidenceFromRow(row, { ...spec, ...proposed }, sql, checkedAt);
  return { proposed, evidence };
}

/** Run the one statement and read the one evidence. */
export async function validateRelationshipOnWarehouse(
  spec: RelationshipValidationSpec,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  checkedAt = new Date(),
  dialect?: string,
): Promise<ManifestRelationshipValidationEvidence> {
  const sql = relationshipValidationSql(spec, quote, dialect);
  const result = await execute(sql);
  return relationshipEvidenceFromRow(result.rows[0] ?? {}, spec, sql, checkedAt);
}

/**
 * The join keys' data types as dbt's catalog records them, read from the
 * `catalog.json` beside the manifest the project compiled from. The compiler
 * folds these into the proof fingerprint, so a validator that omits them writes
 * evidence the next compile calls stale; both askers therefore read the same
 * file. Unknown relations or a missing catalog leave every type undefined.
 */
export function catalogKeyTypes(
  manifest: DQLManifest | undefined,
  spec: Pick<RelationshipValidationSpec, 'fromRelation' | 'toRelation' | 'keys'>,
  readCatalog: (path: string) => Record<string, unknown> | undefined = readCatalogFile,
  /** Resolves the warehouse catalog snapshot of warehouse-first and hybrid modeling (RFC 0007). */
  projectRoot?: string,
): Array<{ from?: string; to?: string }> {
  const manifestPath = manifest?.dbtProvenance?.manifestPath;
  const catalog = manifestPath ? readCatalog(join(dirname(manifestPath), 'catalog.json')) : undefined;
  // A warehouse relation's types come from the warehouse catalog snapshot, the
  // same file the compiler reads them from.
  const warehouseCatalogPath = manifest?.dbtProvenance?.warehouseCatalogPath;
  const warehouseCatalog = warehouseCatalogPath && projectRoot ? readCatalog(join(projectRoot, warehouseCatalogPath)) : undefined;
  if (!catalog && !warehouseCatalog) return spec.keys.map(() => ({}));
  const nodes = manifest?.dbtProvenance?.nodes ?? {};
  const nodeOf = (relation: string) => Object.values(nodes)
    .find((node) => node.relation?.toLowerCase() === relation.toLowerCase());
  const typesOf = (relation: string): Map<string, string> | undefined => {
    const node = nodeOf(relation);
    if (!node) return undefined;
    if (node.resourceType === 'warehouse') {
      const relations = (warehouseCatalog?.relations as Array<{ id?: string; columns?: Array<{ name?: unknown; type?: unknown }> }> | undefined) ?? [];
      const found = relations.find((item) => item.id === node.uniqueId);
      if (!found?.columns) return undefined;
      const types = new Map<string, string>();
      for (const column of found.columns) {
        if (typeof column.name === 'string' && typeof column.type === 'string' && column.type) types.set(column.name.toLowerCase(), column.type.toLowerCase());
      }
      return types;
    }
    if (!catalog) return undefined;
    const uniqueId = node.uniqueId;
    const entry = (catalog.nodes as Record<string, unknown> | undefined)?.[uniqueId] ?? (catalog.sources as Record<string, unknown> | undefined)?.[uniqueId];
    const columns = (entry as { columns?: Record<string, { type?: unknown }> } | undefined)?.columns;
    if (!columns) return undefined;
    const types = new Map<string, string>();
    for (const [name, column] of Object.entries(columns)) {
      if (typeof column?.type === 'string' && column.type) types.set(name, column.type.toLowerCase());
    }
    return types;
  };
  return relationshipKeyTypes(spec.keys, typesOf(spec.fromRelation), typesOf(spec.toRelation));
}

function readCatalogFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
