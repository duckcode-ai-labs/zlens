/**
 * Fields from related tables (design D2, "Datasets follow the joins ZLens
 * already knows").
 *
 * A table Dataset (Orders) shows the fields of the tables its rows point to
 * through a checked many-to-one relationship: each order has one customer and
 * one location, so Customer Name and Location Name are just fields of Orders.
 * Joining such a table never adds Orders rows, so every total stays the same.
 * A relationship the other way (one customer has many orders) is never
 * followed: it would count each customer once per order. The field list says
 * so instead ("Orders per customer: add it from Orders").
 *
 * This module is pure: the relationships come from the model the caller
 * already has (Modeling and dbt relationships, MetricFlow entities, joins
 * drafted and checked in setup), and the caller checks the related key's
 * uniqueness on the warehouse whenever the existing evidence does not cover
 * it. Nothing here runs SQL or decides what a relationship is.
 */
import type { DatasetDescriptor, DatasetJoin, DatasetPhysicalField } from './descriptor.js';
import { singularWords, tableColumnKind, wordsFor } from './table-draft.js';

/** One relationship between two relations, from whichever source knows it. */
export interface RelatedRelationshipEdge {
  /** The relationship's id in its source (a model relationship id, a drafted proposal operation, a dbt test). */
  id: string;
  origin: DatasetJoin['origin'];
  /** The two relations as the model names them (compared without quotes or case). */
  fromRelation: string;
  toRelation: string;
  /** The two tables' plain names ("orders", "customers"). */
  fromTable: string;
  toTable: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many' | 'unknown';
  /** A certified, current relationship keeps a tile's trust; anything else needs review. */
  certified: boolean;
  /**
   * What the relationship's warehouse check showed. `current` is true only
   * when the evidence still matches the relationship (a certified join whose
   * proof is current); `fromUnique`/`toUnique` say whether each side's key
   * was unique. `failed` is a check that did not pass.
   */
  evidence?: { current: boolean; fromUnique?: boolean; toUnique?: boolean; failed?: boolean };
}

export interface DiscoveredDatasetJoins {
  joins: DatasetJoin[];
  fields: DatasetPhysicalField[];
  notes: string[];
}

const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_SUFFIX = /^(.+?)_(id|key|code|uuid|number|no)$/i;
/** A related table with very many columns shows its first ones; nobody scrolls past this. */
const DEFAULT_MAX_COLUMNS = 60;

/** A relation compared the way the warehouse resolves it: no quotes, no case. */
export function bareRelation(relation: string): string {
  return relation.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.').trim().toLowerCase();
}

/** "location__location_name" → { join: "location", column: "location_name" }; undefined for an own column. */
export function relatedFieldParts(name: string): { join: string; column: string } | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*__[A-Za-z0-9_]*[A-Za-z0-9]$/.test(name)) return undefined;
  const index = name.lastIndexOf('__');
  const join = name.slice(0, index);
  const column = name.slice(index + 2);
  return join && column && !column.startsWith('_') ? { join, column } : undefined;
}

/**
 * A related field in lower-case words: "location name" for
 * location__location_name, "customer city" for customer__city, "region name"
 * for customer__region__region_name. The column's own words when they already
 * name the table, else the table's words first.
 */
export function relatedFieldWords(name: string): string | undefined {
  const parts = relatedFieldParts(name);
  if (!parts) return undefined;
  const table = wordsFor(parts.join.split('__').pop() ?? parts.join).toLowerCase();
  const column = wordsFor(parts.column).toLowerCase();
  return column === table || column.startsWith(`${table} `) ? column : `${table} ${column}`;
}

function inverse(cardinality: RelatedRelationshipEdge['cardinality']): RelatedRelationshipEdge['cardinality'] {
  if (cardinality === 'many_to_one') return 'one_to_many';
  if (cardinality === 'one_to_many') return 'many_to_one';
  return cardinality;
}

/** One way along an edge: from `relation` to `target`. */
interface DirectedEdge {
  edge: RelatedRelationshipEdge;
  relation: string;
  target: string;
  targetTable: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: RelatedRelationshipEdge['cardinality'];
  /** Whether the evidence shows the target's key unique; undefined when there is none. */
  targetUnique?: boolean;
}

function directed(edges: RelatedRelationshipEdge[]): DirectedEdge[] {
  return edges.flatMap((edge) => [
    { edge, relation: edge.fromRelation, target: edge.toRelation, targetTable: edge.toTable, keys: edge.keys, cardinality: edge.cardinality, targetUnique: edge.evidence?.toUnique },
    { edge, relation: edge.toRelation, target: edge.fromRelation, targetTable: edge.fromTable, keys: edge.keys.map((pair) => ({ from: pair.to, to: pair.from })), cardinality: inverse(edge.cardinality), targetUnique: edge.evidence?.fromUnique },
  ]);
}

/** Lower is better: a certified model relationship, then the model, then a setup draft, then a dbt test. */
function edgeRank(edge: RelatedRelationshipEdge): number {
  return (edge.certified ? 0 : 4) + (edge.origin === 'model' ? 0 : edge.origin === 'drafted' ? 1 : 2);
}

/** A staging or raw copy of a table ("stg_customers"), which a mart of the same rows supersedes. */
const STAGING_TABLE = /^(stg|staging|raw|base|src|source)_/i;

/**
 * The relationships with lesser copies left out: one foreign key ("each
 * order's customer_id") is followed to one table. A dbt project often has a
 * `relationships` test from orders.customer_id to stg_customers while its
 * semantic model joins the same column to customers; both are true, but two
 * Customer joins make every Customer field ambiguous (a Customer Name filter
 * could not reach Orders). For each foreign key, a relationship to another
 * table is dropped when a better-ranked one exists (a certified model join
 * over a dbt test), or an equally ranked one whose table is not a staging
 * copy. Joins of one key to two equally good tables are both kept.
 */
export function withoutSupersededEdges(edges: RelatedRelationshipEdge[]): RelatedRelationshipEdge[] {
  const foreignKey = (edge: RelatedRelationshipEdge): { key: string; target: string; targetTable: string } | undefined => {
    const keys = (side: 'from' | 'to') => edge.keys.map((pair) => pair[side].toLowerCase()).sort().join(',');
    if (edge.cardinality === 'many_to_one' || edge.cardinality === 'one_to_one') {
      return { key: `${bareRelation(edge.fromRelation)}|${keys('from')}`, target: bareRelation(edge.toRelation), targetTable: edge.toTable };
    }
    if (edge.cardinality === 'one_to_many') {
      return { key: `${bareRelation(edge.toRelation)}|${keys('to')}`, target: bareRelation(edge.fromRelation), targetTable: edge.fromTable };
    }
    return undefined;
  };
  const groups = new Map<string, Array<{ edge: RelatedRelationshipEdge; target: string; staging: boolean }>>();
  for (const edge of edges) {
    const fk = foreignKey(edge);
    if (!fk || edge.evidence?.failed) continue;
    const staging = STAGING_TABLE.test(fk.targetTable) || STAGING_TABLE.test(fk.target.split('.').pop() ?? '');
    groups.set(fk.key, [...(groups.get(fk.key) ?? []), { edge, target: fk.target, staging }]);
  }
  const dropped = new Set<RelatedRelationshipEdge>();
  for (const group of groups.values()) {
    for (const candidate of group) {
      const better = group.some((other) => other.target !== candidate.target && (
        edgeRank(other.edge) < edgeRank(candidate.edge)
        || (edgeRank(other.edge) === edgeRank(candidate.edge) && candidate.staging && !other.staging)
      ));
      if (better) dropped.add(candidate.edge);
    }
  }
  return dropped.size ? edges.filter((edge) => !dropped.has(edge)) : edges;
}

/** Many-to-one or one-to-one, safe by its evidence (or rechecked before use), and not a failed check. */
function followable(step: DirectedEdge): boolean {
  if (step.cardinality !== 'many_to_one' && step.cardinality !== 'one_to_one') return false;
  if (step.edge.evidence?.failed) return false;
  // Evidence that the "one" side repeats a key rules the join out, current or not.
  if (step.targetUnique === false) return false;
  return step.keys.length > 0 && step.keys.every((pair) => PLAIN_IDENTIFIER.test(pair.from) && PLAIN_IDENTIFIER.test(pair.to));
}

function joinStem(keys: Array<{ from: string; to: string }>, targetTable: string): string {
  const single = keys.length === 1 ? keys[0]!.from.match(KEY_SUFFIX)?.[1] : undefined;
  const stem = (single ?? singularWords(targetTable).replace(/\s+/g, '_')).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/__+/g, '_');
  return /^[a-z]/.test(stem) ? stem : `t_${stem || 'table'}`;
}

function capitalized(words: string): string {
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/**
 * The joins a table Dataset follows and the related fields they bring, from
 * the relationships the model knows. `baseRelation` is the table the Dataset
 * reads; `columnsOf` lists a related table's columns. Up to `maxHops` (2)
 * many-to-one hops are followed, each one many-to-one; a one-to-many
 * relationship from the Dataset's own table becomes a note instead.
 */
export function discoverDatasetJoins(input: {
  descriptor: DatasetDescriptor;
  baseRelation: string;
  edges: RelatedRelationshipEdge[];
  columnsOf: (relation: string) => Array<{ name: string; type?: string }> | undefined;
  maxHops?: number;
  maxColumnsPerTable?: number;
}): DiscoveredDatasetJoins {
  const { descriptor } = input;
  const empty: DiscoveredDatasetJoins = { joins: [], fields: [], notes: [] };
  // A saved query's result or an already-aggregated source has no row a related table describes.
  if (descriptor.kind !== 'block' || descriptor.result || descriptor.grain.aggregate) return empty;
  const base = bareRelation(input.baseRelation);
  if (!base) return empty;
  const maxHops = Math.max(1, Math.min(2, input.maxHops ?? 2));
  const maxColumns = input.maxColumnsPerTable ?? DEFAULT_MAX_COLUMNS;
  const steps = directed(withoutSupersededEdges(input.edges));
  const ownColumns = new Set(descriptor.fields.filter((field) => field.kind === 'physical' && !field.related).map((field) => field.name.toLowerCase()));
  const takenNames = new Set(descriptor.fields.map((field) => field.name.toLowerCase()));
  const baseEntity = (descriptor.grain.entityIds[0] ?? '').split('::').pop()?.replace(/_/g, ' ').trim().toLowerCase() || 'row';
  const joins: DatasetJoin[] = [];
  const fields: DatasetPhysicalField[] = [];
  const notes: string[] = [];
  const reached = new Set<string>([base]);

  const best = (candidates: DirectedEdge[]): DirectedEdge[] => {
    // One join per (target, keys): the best-ranked source of the same relationship wins.
    const byKey = new Map<string, DirectedEdge>();
    for (const step of candidates) {
      const key = `${bareRelation(step.target)}|${step.keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).sort().join(',')}`;
      const current = byKey.get(key);
      if (!current || edgeRank(step.edge) < edgeRank(current.edge)) byKey.set(key, step);
    }
    return [...byKey.values()].sort((left, right) => left.targetTable.localeCompare(right.targetTable) || edgeRank(left.edge) - edgeRank(right.edge));
  };

  const addJoin = (step: DirectedEdge, parent: DatasetJoin | undefined, fromEntity: string): DatasetJoin | undefined => {
    const columns = (input.columnsOf(step.target) ?? []).filter((column) => PLAIN_IDENTIFIER.test(column.name));
    const keyColumns = new Set(step.keys.map((pair) => pair.to.toLowerCase()));
    const shown = columns.filter((column) => !keyColumns.has(column.name.toLowerCase())).slice(0, maxColumns);
    if (shown.length === 0) return undefined;
    const stem = joinStem(step.keys, step.targetTable);
    let id = parent ? `${parent.id}__${stem}` : stem;
    for (let suffix = 2; joins.some((join) => join.id === id) || [...takenNames].some((name) => name.startsWith(`${id}__`)); suffix += 1) {
      id = `${parent ? `${parent.id}__` : ''}${stem}_${suffix}`;
    }
    const targetWords = singularWords(step.targetTable);
    const label = capitalized(wordsFor(stem.split('__').pop() ?? stem).toLowerCase());
    const join: DatasetJoin = {
      id,
      ...(parent ? { parent: parent.id } : {}),
      label,
      table: step.targetTable,
      relation: step.target,
      keys: step.keys.map((pair) => ({ ...pair })),
      cardinality: step.cardinality === 'one_to_one' ? 'one_to_one' : 'many_to_one',
      trust: step.edge.certified ? 'certified' : 'review_required',
      origin: step.edge.origin,
      relationshipId: step.edge.id,
      uniqueness: step.edge.evidence?.current && step.targetUnique === true ? 'current' : 'recheck',
      sentence: `each ${fromEntity} has one ${targetWords}`,
    };
    joins.push(join);
    for (const column of shown) {
      const name = `${id}__${column.name}`;
      if (takenNames.has(name.toLowerCase())) continue;
      takenNames.add(name.toLowerCase());
      const kind = tableColumnKind(column.type);
      const time = kind === 'date' || kind === 'timestamp';
      fields.push({
        kind: 'physical',
        name,
        qualifiedId: `${descriptor.id}::related::${id}::${column.name}`,
        type: kind,
        role: time ? 'time' : 'dimension',
        status: 'approved',
        ...(time ? { time: { grains: [...TIME_GRAINS] } } : {}),
        related: { join: id, column: column.name },
      });
    }
    return join;
  };

  // Hop one: from the Dataset's own table, along keys that are its own fields.
  const fromBase = steps.filter((step) => bareRelation(step.relation) === base && bareRelation(step.target) !== base);
  const firstHops = best(fromBase.filter((step) => followable(step) && step.keys.every((pair) => ownColumns.has(pair.from.toLowerCase()))));
  for (const step of firstHops) reached.add(bareRelation(step.target));
  const firstJoins: Array<{ join: DatasetJoin; step: DirectedEdge }> = [];
  for (const step of firstHops) {
    const join = addJoin(step, undefined, baseEntity);
    if (join) firstJoins.push({ join, step });
  }
  // One customer has many orders: not followed, and said so once per table.
  const noted = new Set<string>();
  for (const step of fromBase) {
    if (step.cardinality !== 'one_to_many' || noted.has(bareRelation(step.target))) continue;
    noted.add(bareRelation(step.target));
    const many = wordsFor(step.targetTable);
    notes.push(`${many} per ${baseEntity}: add it from ${many}. One ${baseEntity} has many ${many.toLowerCase()}, so following that join here would count each ${baseEntity} more than once.`);
  }
  // Hop two: from each related table, again many-to-one, to a table not reached yet.
  if (maxHops >= 2) {
    for (const { join: parent, step: parentStep } of firstJoins) {
      const parentColumns = new Set((input.columnsOf(parentStep.target) ?? []).map((column) => column.name.toLowerCase()));
      const parentRelation = bareRelation(parentStep.target);
      const candidates = steps.filter((step) => bareRelation(step.relation) === parentRelation
        && !reached.has(bareRelation(step.target))
        && followable(step)
        && step.keys.every((pair) => parentColumns.has(pair.from.toLowerCase())));
      for (const step of best(candidates)) {
        if (reached.has(bareRelation(step.target))) continue;
        reached.add(bareRelation(step.target));
        addJoin(step, parent, singularWords(parentStep.targetTable));
      }
    }
  }
  return { joins, fields, notes };
}

/** The descriptor with its related fields, joins and notes; the same object when there are none. */
export function withDatasetJoins(descriptor: DatasetDescriptor, discovered: DiscoveredDatasetJoins): DatasetDescriptor {
  if (!discovered.joins.length && !discovered.notes.length) return descriptor;
  const own = descriptor.fields.filter((field) => !(field.kind === 'physical' && field.related));
  return {
    ...descriptor,
    fields: [...own, ...discovered.fields],
    ...(discovered.joins.length ? { joins: discovered.joins } : {}),
    ...(discovered.notes.length ? { joinNotes: discovered.notes } : {}),
  };
}

/** The descriptor without related fields, joins or notes (what its own block declares). */
export function withoutDatasetJoins(descriptor: DatasetDescriptor): DatasetDescriptor {
  if (!descriptor.joins && !descriptor.joinNotes && !descriptor.fields.some((field) => field.kind === 'physical' && field.related)) return descriptor;
  const { joins: _joins, joinNotes: _notes, ...rest } = descriptor;
  return { ...rest, fields: descriptor.fields.filter((field) => !(field.kind === 'physical' && field.related)) };
}

/**
 * Copy the related fields and joins the server discovered onto a descriptor
 * rebuilt from the same block (the runtime's proof-bound one). Fields the
 * rebuilt descriptor already declares are kept as they are.
 */
export function adoptDatasetJoins(descriptor: DatasetDescriptor, from: DatasetDescriptor | undefined): DatasetDescriptor {
  if (!from?.joins?.length) return descriptor;
  return withDatasetJoins(descriptor, {
    joins: from.joins,
    fields: from.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical' && Boolean(field.related)),
    notes: from.joinNotes ?? [],
  });
}

/** Field names a query reads: groupings, filters, detail columns and calculation conditions. */
export function tileQueryFieldNames(query: {
  dimensions?: Array<{ field: string }>;
  filters?: Array<{ field: string }>;
  detailColumns?: string[];
  calculations?: Array<{ expr?: unknown }>;
}): Set<string> {
  const names = new Set<string>();
  for (const dimension of query.dimensions ?? []) names.add(dimension.field.toLowerCase());
  for (const filter of query.filters ?? []) names.add(filter.field.toLowerCase());
  for (const column of query.detailColumns ?? []) names.add(column.toLowerCase());
  const visit = (expr: unknown): void => {
    if (!expr || typeof expr !== 'object') return;
    const record = expr as { where?: Array<{ field?: unknown }>; left?: unknown; right?: unknown };
    for (const filter of record.where ?? []) if (typeof filter.field === 'string') names.add(filter.field.toLowerCase());
    visit(record.left);
    visit(record.right);
  };
  for (const calculation of query.calculations ?? []) visit(calculation.expr);
  return names;
}

/** The related fields a query reads, in the descriptor's order. */
export function datasetRelatedFieldsUsed(descriptor: DatasetDescriptor, query: Parameters<typeof tileQueryFieldNames>[0]): DatasetPhysicalField[] {
  const names = tileQueryFieldNames(query);
  return descriptor.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical'
    && Boolean(field.related)
    && (names.has(field.name.toLowerCase()) || names.has(field.qualifiedId.toLowerCase())));
}

/** The joins a query needs, parents first; empty when it reads only the Dataset's own fields. */
export function datasetJoinsUsed(descriptor: DatasetDescriptor, query: Parameters<typeof tileQueryFieldNames>[0]): DatasetJoin[] {
  const joins = descriptor.joins ?? [];
  if (!joins.length) return [];
  const byId = new Map(joins.map((join) => [join.id, join]));
  const needed = new Set<string>();
  for (const field of datasetRelatedFieldsUsed(descriptor, query)) {
    let join = byId.get(field.related!.join);
    while (join && !needed.has(join.id)) {
      needed.add(join.id);
      join = join.parent ? byId.get(join.parent) : undefined;
    }
  }
  return joins.filter((join) => needed.has(join.id));
}

/** Whether every join a query needs is certified: a drafted one makes the tile Needs review. */
export function datasetJoinsTrust(joins: DatasetJoin[]): 'certified' | 'review_required' {
  return joins.every((join) => join.trust === 'certified') ? 'certified' : 'review_required';
}

/**
 * The receipt line for one join, in plain words:
 * "Joined to customers on customer_id (each order has one customer — checked)".
 * A second hop says which table it goes through; a drafted join says it
 * needs review.
 */
export function datasetJoinReceiptSentence(join: DatasetJoin, joins: DatasetJoin[] = []): string {
  const parent = join.parent ? joins.find((candidate) => candidate.id === join.parent) : undefined;
  const on = join.keys.map((pair) => (pair.from === pair.to ? pair.from : `${pair.from} = ${pair.to}`)).join(' and ');
  const through = parent ? ` through ${parent.table}` : '';
  const review = join.trust === 'certified' ? '' : '; the join is not certified yet, so it needs review';
  return `Joined to ${join.table}${through} on ${on} (${join.sentence} — checked${review})`;
}

/**
 * The Dataset's own field and the related ones a filter on `fieldId` can
 * use: its own field of that name first, else the single related field that
 * reads a column of that name ("customer_name" reaches Orders through its
 * Customer join). Several related tables with the column is ambiguous and
 * returns none.
 */
export function datasetFieldForFilter(descriptor: DatasetDescriptor, fieldId: string): { field: DatasetPhysicalField; join?: DatasetJoin } | undefined {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.').at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
  const wanted = normalize(fieldId);
  const wantedColumn = normalize(relatedFieldParts(fieldId.trim())?.column ?? fieldId);
  const approved = descriptor.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical' && field.status === 'approved');
  const own = approved.find((field) => !field.related && (normalize(field.name) === wanted || normalize(field.qualifiedId) === wanted));
  if (own) return { field: own };
  const exact = approved.find((field) => field.related && normalize(field.name) === wanted);
  const byColumn = approved.filter((field) => field.related && normalize(field.related.column) === wantedColumn);
  // The nearest table wins: Orders → Customer → Customer Name before Orders → Location → Region → … of the same name.
  const parentOf = (field: DatasetPhysicalField) => descriptor.joins?.find((join) => join.id === field.related!.join)?.parent;
  const direct = byColumn.filter((field) => !parentOf(field));
  const related = exact ? [exact] : direct.length === 1 ? direct : byColumn;
  if (related.length !== 1) {
    // A related field's own name finds the Dataset's column of that name ("customer__customer_name" → customer_name).
    const ownByColumn = approved.filter((field) => !field.related && normalize(field.name) === wantedColumn);
    return wanted !== wantedColumn && ownByColumn.length === 1 ? { field: ownByColumn[0]! } : undefined;
  }
  const field = related[0]!;
  return { field, join: descriptor.joins?.find((join) => join.id === field.related!.join) };
}
