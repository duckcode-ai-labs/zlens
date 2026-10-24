/**
 * Dataset descriptors are the small, UI-facing projection of DQL's richer
 * analytical contracts.  They deliberately do not replace a metric capability
 * contract: callers must resolve `contractRef` before compiling a query.
 *
 * The module is dependency-free so App Studio, the CLI, and the agent catalog
 * can exchange the same Git-owned shape without importing a runtime adapter.
 */

export type DatasetKind = 'block' | 'semantic';
export type DatasetTrust = 'certified' | 'review_required';
export type DatasetLifecycle = 'certified' | 'review' | 'draft' | 'pending_recertification' | 'deprecated' | 'unknown';
export type DatasetFieldType = 'string' | 'number' | 'boolean' | 'date' | 'timestamp';
export type DatasetFieldRole = 'dimension' | 'key' | 'time' | 'attribute';
export type DatasetFieldStatus = 'approved' | 'suggested';
import type { DatasetAggregateExpressionV1, DatasetMeasureAggregation } from './aggregate-expression.js';
import { isDatasetAggregateExpression } from './aggregate-expression.js';

export type { DatasetMeasureAggregation } from './aggregate-expression.js';
export type DatasetAdditivity = 'additive' | 'semi_additive' | 'non_additive';
export type DatasetOperation = 'filter' | 'group' | 'trend' | 'compare' | 'rank' | 'detail' | 'having';
export type DatasetExecutionRoute = 'certified' | 'semantic' | 'governed_sql';

export interface DatasetContractRef {
  kind: 'metric_capability' | 'block_source' | 'semantic_model';
  id: string;
  fingerprint: string;
}

/**
 * The source declaration and the live target are deliberately separate.
 *
 * A catalog can truthfully show a certified declaration before a local
 * connection has been selected. It must not pretend that the declaration has
 * already been checked against the current project snapshot and warehouse.
 * The runtime turns `target_required` into `valid` (or a typed failure) before
 * it executes a field-based tile or allows it through publication preflight.
 */
export interface DatasetSourceBinding {
  sourceQualifiedId: string;
  sourceRevision: string;
  contractFingerprint: string;
  state: 'target_required' | 'valid' | 'missing' | 'invalid' | 'stale';
  activeSnapshotId?: string;
  activeSnapshotFingerprint?: string;
  activeTargetFingerprint?: string;
  proofId?: string;
}

export interface DatasetGrain {
  /** Stable entity identities, not display labels. */
  entityIds: string[];
  /** Physical key fields that have evidence for the declared grain. */
  keyFields: string[];
  /** Reviewed uniqueness/fanout proof reference. A result preview is not proof. */
  keyEvidence?: string;
  /** Optional time grain of an already-aggregated source. */
  timeGrain?: string;
  timeBucketBy?: string;
  /** True only for a reviewed aggregate source. It constrains rollups. */
  aggregate?: boolean;
  description?: string;
}

export interface DatasetPhysicalField {
  kind: 'physical';
  name: string;
  qualifiedId: string;
  /**
   * Exact provider member reference selected when this field was projected
   * from a semantic capability. The stable qualifiedId remains the governed
   * identity used for validation, evidence, and persisted query intent; this
   * reference is only the adapter input needed to compile that same approved
   * member. It is deliberately absent for block-backed physical columns.
   */
  semanticReference?: string;
  type: DatasetFieldType;
  role: DatasetFieldRole;
  status: DatasetFieldStatus;
  time?: { grains: string[]; baseGrain?: string; primary?: boolean };
  hierarchy?: { id: string; level: number };
  /**
   * A field of a related table (design D2): the column `column` of the table
   * the Dataset's join `join` reaches. Absent for the Dataset's own columns.
   */
  related?: { join: string; column: string };
}

/**
 * A checked many-to-one (or one-to-one) join a table Dataset follows to show
 * a related table's fields (design D2, "Datasets follow the joins ZLens
 * already knows"). Each order has one customer, so joining customers to
 * orders never adds order rows. A join reaches one table; a second hop names
 * the first as its `parent`. The server recomputes joins from its own
 * relationship sources on every run; a join in a stored descriptor is never
 * execution authority.
 */
export interface DatasetJoin {
  /** Plain identifier, the prefix of its fields' names: `customer`, `customer__region`. */
  id: string;
  /** The join this one starts from; absent for a join from the Dataset's own table. */
  parent?: string;
  /** The related table in words, singular: "Customer". */
  label: string;
  /** The related table's name as people know it: "customers". */
  table: string;
  /** The related relation as SQL names it. */
  relation: string;
  /** Column pairs: `from` on the parent side (the Dataset or the parent join), `to` on the related table. */
  keys: Array<{ from: string; to: string }>;
  cardinality: 'many_to_one' | 'one_to_one';
  /** A certified relationship keeps a tile's trust; a drafted one makes it Needs review. */
  trust: 'certified' | 'review_required';
  /** Where the relationship comes from: the model (Modeling, dbt, semantic), a setup draft, or a dbt test. */
  origin: 'model' | 'drafted' | 'dbt_test';
  /** The relationship's id in its source. */
  relationshipId: string;
  /**
   * `current`: warehouse evidence already shows the related table's key is
   * unique. `recheck`: the runtime checks it (a bounded query) before a tile
   * uses the join.
   */
  uniqueness: 'current' | 'recheck';
  /** "each order has one customer" */
  sentence: string;
  /**
   * A join someone certified that changed since (its keys, cardinality or a
   * side's grain moved): who certified it and when, so receipts say
   * "Changed since it was certified on 22 Oct". Absent otherwise.
   */
  changedSinceCertified?: { at: string; by?: string; name?: string };
}

export interface DatasetMeasureField {
  kind: 'measure';
  name: string;
  qualifiedId: string;
  /**
   * Exact provider metric reference selected from the semantic model that
   * owns this Dataset. Canonical metricId stays in the contract/evidence;
   * this value is only the executable adapter member reference.
   */
  semanticReference?: string;
  aggregation: DatasetMeasureAggregation;
  /** Physical input for sum/count/distinct count. */
  from?: string;
  /** M1's approved governed ratio is a ratio of sums, stored as 0..1. */
  numerator?: string;
  denominator?: string;
  /** Owned aggregate AST for an M2 calculated measure. */
  expression?: DatasetAggregateExpressionV1;
  expressionFingerprint?: string;
  /** Exact physical time field supporting an explicitly time-additive entity measure. */
  timeBucketBy?: string;
  dependsOn: string[];
  additivity: { entities: DatasetAdditivity; time: DatasetAdditivity; nonAdditiveDimensionIds?: string[] };
  allowedAggs: DatasetMeasureAggregation[];
  format?: { kind: 'number' | 'currency' | 'percent'; currency?: string; decimals?: number };
  metricId?: string;
  status: DatasetFieldStatus;
}

export type DatasetField = DatasetPhysicalField | DatasetMeasureField;

/**
 * Fields read from a saved query's result (design D1, "everything you add has
 * fields"). A saved query (a block with no Dataset definition) is offered on
 * the same shelves as a Dataset: its output columns are the fields, and tiles
 * compile as a query over its complete result. Nothing here is a row-level
 * contract: the result's own rows are the grain, so a tile either shows them
 * as they are (it groups by every grouping column of the query) or rolls them
 * up, and the receipt says which.
 */
export interface DatasetResultOrigin {
  /** The saved query whose result rows the fields read (its block name). */
  savedQuery: string;
  /**
   * The saved query's own grouping columns: one result row per combination.
   * Empty when the query is not a grouped aggregate, so no tile is "as is".
   */
  groupBy: string[];
  /** Measures that only show a value as it is (averages, ratios): they never roll up. */
  asIs: string[];
  /** Where the column types came from: the block's declared contract, a run, or a one-row read. */
  typesFrom: 'contract' | 'run' | 'probe';
  /**
   * The saved query keeps only its first N rows (an outer `LIMIT N`, a Top N).
   * A tile that rolls those rows up totals the top N only, never everything.
   */
  keepsFirstRows?: number;
}

export interface DatasetDescriptor {
  version: 1;
  id: string;
  kind: DatasetKind;
  sourceRevision: string;
  snapshotId: string;
  contractRef: DatasetContractRef;
  /** Target-bound proof state. Source lifecycle remains a declaration. */
  binding: DatasetSourceBinding;
  label: string;
  domain?: string;
  lifecycle: DatasetLifecycle;
  trust: DatasetTrust;
  grain: DatasetGrain;
  fields: DatasetField[];
  operations: DatasetOperation[];
  execution: { route: DatasetExecutionRoute; adapterId?: string };
  /** Present only for fields read from a saved query's result (see DatasetResultOrigin). */
  result?: DatasetResultOrigin;
  /** Joins whose related tables' fields this Dataset shows (design D2). Absent when it follows none. */
  joins?: DatasetJoin[];
  /** Plain lines about joins the Dataset does not follow: "Orders per customer: add it from Orders". */
  joinNotes?: string[];
}

/** True for the read-only fields of a saved query's result, not a row-level Dataset. */
export function isSavedQueryResultDataset(descriptor: Pick<DatasetDescriptor, 'result'> | null | undefined): boolean {
  return Boolean(descriptor?.result);
}

export function datasetPhysicalFields(descriptor: DatasetDescriptor): DatasetPhysicalField[] {
  return descriptor.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical');
}

export function datasetMeasures(descriptor: DatasetDescriptor): DatasetMeasureField[] {
  return descriptor.fields.filter((field): field is DatasetMeasureField => field.kind === 'measure');
}

export function datasetPhysicalField(descriptor: DatasetDescriptor, name: string): DatasetPhysicalField | undefined {
  const normalized = name.trim().toLowerCase();
  return descriptor.fields.find((field): field is DatasetPhysicalField => field.kind === 'physical'
    && (field.name.toLowerCase() === normalized || field.qualifiedId.toLowerCase() === normalized));
}

export function datasetMeasureField(descriptor: DatasetDescriptor, name: string): DatasetMeasureField | undefined {
  const normalized = name.trim().toLowerCase();
  return descriptor.fields.find((field): field is DatasetMeasureField => field.kind === 'measure'
    && (field.name.toLowerCase() === normalized || field.qualifiedId.toLowerCase() === normalized));
}

/**
 * Compatibility lookup for presentation code. Query compilation must use the
 * typed helpers above because `net_amount` may intentionally exist as both a
 * physical input column and an approved sum measure.
 */
export function datasetField(descriptor: DatasetDescriptor, name: string): DatasetField | undefined {
  const normalized = name.trim().toLowerCase();
  const matches = descriptor.fields.filter((field) => field.name.toLowerCase() === normalized || field.qualifiedId.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A JSON-safe normalizer for persisted descriptors and catalog payloads. */
export function normalizeDatasetDescriptor(value: unknown): DatasetDescriptor | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== 1) return undefined;
  const id = text(record.id);
  const kind = enumValue(record.kind, ['block', 'semantic'] as const);
  const sourceRevision = text(record.sourceRevision);
  const snapshotId = text(record.snapshotId);
  const label = text(record.label);
  const lifecycle = enumValue(record.lifecycle, ['certified', 'review', 'draft', 'pending_recertification', 'deprecated', 'unknown'] as const);
  const trust = enumValue(record.trust, ['certified', 'review_required'] as const);
  const contract = objectRecord(record.contractRef);
  const contractKind = enumValue(contract?.kind, ['metric_capability', 'block_source', 'semantic_model'] as const);
  const contractId = text(contract?.id);
  const contractFingerprint = text(contract?.fingerprint);
  const binding = normalizeDatasetSourceBinding(record.binding);
  const grain = normalizeDatasetGrain(record.grain);
  const fields = Array.isArray(record.fields)
    ? record.fields.flatMap((field) => normalizeDatasetField(field) ? [normalizeDatasetField(field)!] : [])
    : [];
  const operations = Array.isArray(record.operations)
    ? record.operations.flatMap((operation) => enumValue(operation, ['filter', 'group', 'trend', 'compare', 'rank', 'detail', 'having'] as const) ? [enumValue(operation, ['filter', 'group', 'trend', 'compare', 'rank', 'detail', 'having'] as const)!] : [])
    : [];
  const execution = objectRecord(record.execution);
  const route = enumValue(execution?.route, ['certified', 'semantic', 'governed_sql'] as const);
  const result = record.result === undefined ? undefined : normalizeDatasetResultOrigin(record.result);
  if (record.result !== undefined && !result) return undefined;
  const joins = record.joins === undefined ? undefined : normalizeDatasetJoins(record.joins);
  if (record.joins !== undefined && !joins) return undefined;
  const joinNotes = record.joinNotes === undefined ? undefined : strings(record.joinNotes);
  if (!id || !kind || !sourceRevision || !snapshotId || !label || !lifecycle || !trust || !contractKind || !contractId || !contractFingerprint || !binding || !grain || !route) return undefined;
  if (fields.length !== (Array.isArray(record.fields) ? record.fields.length : 0)) return undefined;
  if (operations.length !== (Array.isArray(record.operations) ? record.operations.length : 0)) return undefined;
  const names = new Set<string>();
  if (fields.some((field) => {
    const key = `${field.kind}:${field.name.toLowerCase()}`;
    if (names.has(key)) return true;
    names.add(key);
    return false;
  })) return undefined;
  // A related field names a join this descriptor declares.
  const joinIds = new Set((joins ?? []).map((join) => join.id));
  if (fields.some((field) => field.kind === 'physical' && field.related && !joinIds.has(field.related.join))) return undefined;
  return {
    version: 1,
    id,
    kind,
    sourceRevision,
    snapshotId,
    contractRef: { kind: contractKind, id: contractId, fingerprint: contractFingerprint },
    binding,
    label,
    domain: text(record.domain) || undefined,
    lifecycle,
    trust,
    grain,
    fields,
    operations: Array.from(new Set(operations)),
    execution: { route, adapterId: text(execution?.adapterId) || undefined },
    ...(result ? { result } : {}),
    ...(joins?.length ? { joins } : {}),
    ...(joinNotes?.length ? { joinNotes } : {}),
  };
}

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeDatasetJoins(value: unknown): DatasetJoin[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const joins: DatasetJoin[] = [];
  for (const item of value) {
    const record = objectRecord(item);
    const id = text(record?.id);
    const parent = text(record?.parent) || undefined;
    const label = text(record?.label);
    const table = text(record?.table);
    const relation = text(record?.relation);
    const relationshipId = text(record?.relationshipId);
    const sentence = text(record?.sentence);
    const cardinality = enumValue(record?.cardinality, ['many_to_one', 'one_to_one'] as const);
    const trust = enumValue(record?.trust, ['certified', 'review_required'] as const);
    const origin = enumValue(record?.origin, ['model', 'drafted', 'dbt_test'] as const);
    const uniqueness = enumValue(record?.uniqueness, ['current', 'recheck'] as const);
    const rawKeys = Array.isArray(record?.keys) ? record!.keys as unknown[] : [];
    const keys = rawKeys.flatMap((pair) => {
      const keyRecord = objectRecord(pair);
      const from = text(keyRecord?.from);
      const to = text(keyRecord?.to);
      return from && to && PLAIN_IDENTIFIER.test(from) && PLAIN_IDENTIFIER.test(to) ? [{ from, to }] : [];
    });
    if (!id || !PLAIN_IDENTIFIER.test(id) || !label || !table || !relation || !relationshipId || !sentence
      || !cardinality || !trust || !origin || !uniqueness || keys.length === 0 || keys.length !== rawKeys.length) return undefined;
    if (joins.some((join) => join.id === id)) return undefined;
    // A second hop's parent is declared before it.
    if (parent && !joins.some((join) => join.id === parent)) return undefined;
    joins.push({ id, ...(parent ? { parent } : {}), label, table, relation, keys, cardinality, trust, origin, relationshipId, uniqueness, sentence });
  }
  return joins;
}

function normalizeDatasetResultOrigin(value: unknown): DatasetResultOrigin | undefined {
  const record = objectRecord(value);
  const savedQuery = text(record?.savedQuery);
  const typesFrom = enumValue(record?.typesFrom, ['contract', 'run', 'probe'] as const);
  if (!record || !savedQuery || !typesFrom || !Array.isArray(record.groupBy) || !Array.isArray(record.asIs)) return undefined;
  const keepsFirstRows = typeof record.keepsFirstRows === 'number' && Number.isSafeInteger(record.keepsFirstRows) && record.keepsFirstRows > 0
    ? record.keepsFirstRows
    : undefined;
  return { savedQuery, groupBy: strings(record.groupBy), asIs: strings(record.asIs), typesFrom, ...(keepsFirstRows ? { keepsFirstRows } : {}) };
}

function normalizeDatasetSourceBinding(value: unknown): DatasetSourceBinding | undefined {
  const record = objectRecord(value);
  const sourceQualifiedId = text(record?.sourceQualifiedId);
  const sourceRevision = text(record?.sourceRevision);
  const contractFingerprint = text(record?.contractFingerprint);
  const state = enumValue(record?.state, ['target_required', 'valid', 'missing', 'invalid', 'stale'] as const);
  if (!sourceQualifiedId || !sourceRevision || !contractFingerprint || !state) return undefined;
  return {
    sourceQualifiedId,
    sourceRevision,
    contractFingerprint,
    state,
    activeSnapshotId: text(record?.activeSnapshotId) || undefined,
    activeSnapshotFingerprint: text(record?.activeSnapshotFingerprint) || undefined,
    activeTargetFingerprint: text(record?.activeTargetFingerprint) || undefined,
    proofId: text(record?.proofId) || undefined,
  };
}

function normalizeDatasetGrain(value: unknown): DatasetGrain | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const entityIds = strings(record.entityIds);
  const keyFields = strings(record.keyFields);
  // Semantic datasets can deliberately omit physical keys because their
  // provider may only expose aggregate results. Detail stays unavailable in
  // that case; block-backed datasets are separately required to declare and
  // prove their physical key by the manifest and runtime gates.
  if (entityIds.length === 0) return undefined;
  return {
    entityIds,
    keyFields,
    keyEvidence: text(record.keyEvidence) || undefined,
    timeGrain: text(record.timeGrain) || undefined,
    timeBucketBy: text(record.timeBucketBy) || undefined,
    aggregate: record.aggregate === true || undefined,
    description: text(record.description) || undefined,
  };
}

function normalizeDatasetField(value: unknown): DatasetField | undefined {
  const record = objectRecord(value);
  const kind = enumValue(record?.kind, ['physical', 'measure'] as const);
  const name = text(record?.name);
  const qualifiedId = text(record?.qualifiedId);
  const status = enumValue(record?.status, ['approved', 'suggested'] as const);
  if (!kind || !name || !qualifiedId || !status) return undefined;
  if (kind === 'physical') {
    const type = enumValue(record?.type, ['string', 'number', 'boolean', 'date', 'timestamp'] as const);
    const role = enumValue(record?.role, ['dimension', 'key', 'time', 'attribute'] as const);
    if (!type || !role) return undefined;
    const timeRecord = objectRecord(record?.time);
    const hierarchyRecord = objectRecord(record?.hierarchy);
    const grains = strings(timeRecord?.grains);
    const hierarchyId = text(hierarchyRecord?.id);
    const level = hierarchyRecord?.level;
    const relatedRecord = objectRecord(record?.related);
    const relatedJoin = text(relatedRecord?.join);
    const relatedColumn = text(relatedRecord?.column);
    if (record?.related !== undefined && (!relatedJoin || !relatedColumn)) return undefined;
    return {
      kind, name, qualifiedId, type, role, status,
      semanticReference: text(record?.semanticReference) || undefined,
      ...(timeRecord ? { time: { grains, baseGrain: text(timeRecord.baseGrain) || undefined, primary: timeRecord.primary === true || undefined } } : {}),
      ...(hierarchyId && typeof level === 'number' && Number.isInteger(level) ? { hierarchy: { id: hierarchyId, level } } : {}),
      ...(relatedJoin && relatedColumn ? { related: { join: relatedJoin, column: relatedColumn } } : {}),
    };
  }
  const aggregation = enumValue(record?.aggregation, ['sum', 'count', 'count_distinct', 'ratio', 'avg', 'min', 'max'] as const);
  const additivity = objectRecord(record?.additivity);
  const entityAdditivity = enumValue(additivity?.entities, ['additive', 'semi_additive', 'non_additive'] as const);
  const timeAdditivity = enumValue(additivity?.time, ['additive', 'semi_additive', 'non_additive'] as const);
  const allowedAggs = Array.isArray(record?.allowedAggs)
    ? record!.allowedAggs.flatMap((item) => enumValue(item, ['sum', 'count', 'count_distinct', 'ratio', 'avg', 'min', 'max'] as const) ? [enumValue(item, ['sum', 'count', 'count_distinct', 'ratio', 'avg', 'min', 'max'] as const)!] : [])
    : [];
  if (!aggregation || !entityAdditivity || !timeAdditivity || allowedAggs.length === 0) return undefined;
  const dependsOn = strings(record?.dependsOn);
  const format = objectRecord(record?.format);
  const formatKind = enumValue(format?.kind, ['number', 'currency', 'percent'] as const);
  const rawExpression = record?.expression;
  const expressionFingerprint = text(record?.expressionFingerprint) || undefined;
  if (rawExpression !== undefined && (!isDatasetAggregateExpression(rawExpression) || !expressionFingerprint)) return undefined;
  return {
    kind, name, qualifiedId, aggregation,
    semanticReference: text(record?.semanticReference) || undefined,
    from: text(record?.from) || undefined,
    numerator: text(record?.numerator) || undefined,
    denominator: text(record?.denominator) || undefined,
    ...(rawExpression !== undefined ? { expression: rawExpression } : {}),
    expressionFingerprint,
    timeBucketBy: text(record?.timeBucketBy) || undefined,
    dependsOn,
    additivity: { entities: entityAdditivity, time: timeAdditivity, nonAdditiveDimensionIds: strings(additivity?.nonAdditiveDimensionIds).length ? strings(additivity?.nonAdditiveDimensionIds) : undefined },
    allowedAggs: Array.from(new Set(allowedAggs)),
    format: formatKind ? {
      kind: formatKind,
      currency: text(format?.currency) || undefined,
      ...(typeof format?.decimals === 'number' && Number.isInteger(format.decimals) && format.decimals >= 0 && format.decimals <= 6
        ? { decimals: format.decimals }
        : {}),
    } : undefined,
    metricId: text(record?.metricId) || undefined,
    status,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.flatMap((item) => text(item) ? [text(item)] : [])))
    : [];
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T[number] : undefined;
}
