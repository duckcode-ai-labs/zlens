/**
 * Layers, row identity, and one table per business thing (RFC 0012).
 *
 * A dbt project, or any layered warehouse, often holds one business thing
 * several times: a raw table, a staging view that renames it, a history
 * snapshot, a modeled table, and sometimes an older or narrower modeled table
 * beside the current one. Ask answered from whichever it found first; on the
 * NBA project that was a table covering 2009–2019 beside one covering
 * 2003–2022. This gives every table a layer, finds what one row is from the
 * data, groups the tables that hold the same rows, and proposes one table per
 * group, with a reason a person can check for every other one.
 *
 * Every fact comes from counting queries (COUNT, COUNT DISTINCT, and MIN/MAX
 * of a period column such as a season or a date). Nothing here certifies or
 * removes a table: a proposal is a draft a person reviews.
 */

import { readFileSync } from 'node:fs';
import { resolveWarehouseRelation, tableEntityKey, type WarehouseCatalogRelationV1, type WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { KEY_LIKE_NAME, NON_KEY_TYPE, statementTables, type DiscoveredEntity, type WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

/** Where a table sits in the pipeline. `final` is a modeled fact or dimension. */
export type TableLayer = 'raw' | 'staging' | 'intermediate' | 'snapshot' | 'final';

/** What one row is, found on the data. */
export interface RowIdentity {
  /** The columns, as the table spells them. */
  columns: string[];
  rows: number;
  /** Rows beyond the first for a repeated key: 0 when the columns are unique. */
  duplicates: number;
  source: 'declared_key' | 'dbt_test' | 'searched';
}

/** The range a table covers on a period column (a season, a year, a date). */
export interface PeriodCoverage {
  column: string;
  min: string;
  max: string;
  distinct: number;
}

export interface LookAlikeMember {
  relation: string;
  /** The drafted entity's id and Domain. */
  entity: string;
  domain: string;
  layer: TableLayer;
  rows?: number;
  /** Distinct row identities. */
  keys?: number;
  duplicates?: number;
  period?: PeriodCoverage;
  /** `pick`: the table to answer from; `use_instead`: a look-alike Ask should prefer the pick over. */
  verdict: 'pick' | 'use_instead';
  /** Why not this one, in measured terms. */
  reason?: string;
}

/** Tables that hold the same rows: the same row identity, or one only renames or filters the other. */
export interface LookAlikeGroup {
  /** What one row is, in the first pick's column names. */
  identity: string[];
  /** The relation proposed to answer from. */
  pick: string;
  members: LookAlikeMember[];
}

/** A drafted table Ask should prefer another one over, with the measured reason. */
export interface UseInstead {
  entity: string;
  domain: string;
  relation: string;
  reason: string;
}

/** What dbt says about the model, source, snapshot or seed behind a relation. */
export interface DbtRelationFacts {
  uniqueId: string;
  resourceType: 'model' | 'source' | 'snapshot' | 'seed';
  /** The file it is defined in (`models/staging/stg_orders.sql`). */
  path?: string;
  materialized?: string;
  /** Upstream dbt unique ids. */
  dependsOn: string[];
  /** Column sets dbt tests hold unique (`unique`, `unique_combination_of_columns`). */
  uniqueTests: string[][];
  /** Data tests on it, and exposures that use it. */
  tests: number;
  exposures: number;
}

type Run = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

const LAYER_RANK: Record<TableLayer, number> = { snapshot: 0, raw: 1, staging: 2, intermediate: 3, final: 4 };
const FOLDER_LAYER: Array<[RegExp, TableLayer]> = [
  [/^(staging|stage|stg|src|base)$/i, 'staging'],
  [/^(intermediate|int)$/i, 'intermediate'],
  [/^(marts?|dims?|dimensions?|fcts?|facts?|core|reporting|presentation|gold)$/i, 'final'],
  [/^snapshots?$/i, 'snapshot'],
  [/^(seeds?|raw|landing|bronze)$/i, 'raw'],
];
const PREFIX_LAYER: Array<[RegExp, TableLayer]> = [
  [/^raw_/i, 'raw'],
  [/^(stg|staging|src|base)_/i, 'staging'],
  [/^(int|intermediate)_/i, 'intermediate'],
  [/^(dim|fct|fact|mart|agg|rpt)_/i, 'final'],
  [/^(scd|snap|snapshot)_/i, 'snapshot'],
];
const SCHEMA_LAYER: Array<[RegExp, TableLayer]> = [
  [/^(raw|landing|source|sources|bronze|ingest|ingestion)$/i, 'raw'],
  [/^(staging|stg|silver)$/i, 'staging'],
  [/^(intermediate|int)$/i, 'intermediate'],
  [/^(marts?|analytics|reporting|presentation|gold)$/i, 'final'],
  [/^snapshots?$/i, 'snapshot'],
];
/** dbt's snapshot bookkeeping: never part of what a row is. */
const DBT_META_COLUMN = /^dbt_(scd_id|updated_at|valid_from|valid_to|is_deleted)$/i;
/** Columns named for a period: one row per season, per year, per day. */
const PERIOD_NAME = /^(season|year|fiscal_year|month|week|quarter|period|date|day)(_id)?$|_(date|year|month|week|season|period)$/i;
/** Coarse periods first: a season or year says what a table covers better than a date does. */
const COARSE_PERIOD = /^(season|year|fiscal_year)(_id)?$|_(season|year)$/i;
const TEXT_TYPE = /^(varchar|char|text|string|nvarchar|character)/i;
const DATE_TYPE = /^date\b/i;
/** Repeated rows a near identity may have: 0.5%. Above it, the columns are not what a row is. */
const NEAR_UNIQUE_SHARE = 0.005;
/** Tables whose identities differ by less than this hold the same rows. */
const SAME_COVERAGE = 0.95;
/** A narrower table's other columns that must be in the wider one for it to replace it. */
const NARROWER_COLUMN_SHARE = 0.8;
const MAX_IDENTITY_CANDIDATES = 12;
const MAX_COMBINATIONS_PER_SIZE = 16;

const num = (row: Record<string, unknown>, name: string): number => Number(row[name] ?? row[name.toUpperCase()]);
const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/**
 * A table's layer and the evidence for it, strongest first: what dbt says it
 * is, dbt's snapshot columns, its dbt folder, its name prefix, its schema,
 * and whether it is a view that only renames a raw table. A table nothing
 * marks as earlier is final.
 */
export function tableLayer(
  relation: WarehouseCatalogRelationV1,
  facts: { dbt?: DbtRelationFacts; copyOf?: { name: string; layer: TableLayer } } = {},
): { layer: TableLayer; evidence: string } {
  const dbt = facts.dbt;
  if (dbt?.resourceType === 'source') return { layer: 'raw', evidence: 'a dbt source' };
  if (dbt?.resourceType === 'seed') return { layer: 'raw', evidence: 'a dbt seed' };
  if (dbt?.resourceType === 'snapshot') return { layer: 'snapshot', evidence: 'a dbt snapshot' };
  const columns = new Set(relation.columns.map((column) => column.name.toLowerCase()));
  if (columns.has('dbt_valid_from') && columns.has('dbt_valid_to')) return { layer: 'snapshot', evidence: 'has dbt_valid_from and dbt_valid_to' };
  if (dbt?.path) {
    const parts = dbt.path.replace(/\\/g, '/').split('/').filter(Boolean);
    for (const folder of parts.slice(parts[0] === 'models' ? 1 : 0, -1)) {
      const match = FOLDER_LAYER.find(([pattern]) => pattern.test(folder));
      if (match) return { layer: match[1], evidence: `in the dbt folder ${folder}/` };
    }
  }
  const prefix = PREFIX_LAYER.find(([pattern]) => pattern.test(relation.name));
  if (prefix) return { layer: prefix[1], evidence: `named ${relation.name.match(prefix[0])![0]}…` };
  const schema = relation.schema ? SCHEMA_LAYER.find(([pattern]) => pattern.test(relation.schema!)) : undefined;
  if (schema) return { layer: schema[1], evidence: `in the ${relation.schema} schema` };
  if (facts.copyOf?.layer === 'raw') return { layer: 'staging', evidence: `a view that renames ${facts.copyOf.name}` };
  return { layer: 'final', evidence: 'nothing marks it as raw, staging or intermediate' };
}

/**
 * The one relation a view only renames, casts or filters (no join, grouping,
 * aggregate, union or window), as its SQL spells it; undefined otherwise.
 * Common table expressions are followed: `WITH t AS (SELECT * FROM src)
 * SELECT … FROM t` reads `src`.
 */
export function projectionSource(viewSql: string): string | undefined {
  const text = viewSql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'[^']*'/g, "''");
  if (/\b(join|group\s+by|having|distinct|union|intersect|except|over\s*\(|window|qualify)\b/i.test(text)) return undefined;
  if (/\b(sum|count|avg|min|max|median|array_agg|string_agg|listagg|group_concat|any_value)\s*\(/i.test(text)) return undefined;
  const ctes = new Set([...text.matchAll(/(?:\bwith|,)\s*(?:recursive\s+)?["`]?([A-Za-z_][\w$]*)["`]?\s+as\s*\(/gi)].map((match) => match[1]!.toLowerCase()));
  const read = new Set([...statementTables(text).values()].filter((name) => !ctes.has(name.toLowerCase())).map((name) => name.toLowerCase()));
  if (read.size === 0) return undefined;
  // `statementTables` keys a table by its spelled and bare name: one table is one spelling.
  const spelled = [...read].filter((name) => ![...read].some((other) => other !== name && other.endsWith(`.${name}`)));
  return spelled.length === 1 ? [...statementTables(text).values()].find((name) => name.toLowerCase() === spelled[0]) : undefined;
}

/**
 * Column names shared by two or more tables, and the words table names use.
 * A column's canonical name drops a prefix that names a table
 * (`details_game_id` → `game_id`, `games_game_id` → `game_id`) but keeps a
 * role (`home_team_id`, `opponent_team_id`), and reads `season_id` as
 * `season` where tables also say `season`.
 */
export function columnVocabulary(relations: readonly WarehouseCatalogRelationV1[]): { shared: Set<string>; tableWords: Set<string>; tablesWith: Map<string, number> } {
  const counts = new Map<string, number>();
  for (const relation of relations) {
    for (const name of new Set(relation.columns.map((column) => column.name.toLowerCase()))) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const tableWords = new Set(relations.flatMap((relation) => relation.name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)));
  return { shared: new Set([...counts].filter(([, count]) => count >= 2).map(([name]) => name)), tableWords, tablesWith: counts };
}

export function canonicalColumn(name: string, vocabulary: { shared: Set<string>; tableWords: Set<string> }, tableName?: string): string {
  let lower = name.toLowerCase();
  // A bare `id` is the table's own: `raw_customers.id` is `customer_id`.
  if (tableName && /^(id|uuid|key|pk)$/.test(lower)) lower = `${tableEntityKey(tableName)}_${lower === 'pk' ? 'id' : lower}`;
  const words = lower.split('_');
  for (let index = 1; index < words.length - 1; index += 1) {
    const rest = words.slice(index).join('_');
    if (vocabulary.shared.has(rest) && words.slice(0, index).every((word) => vocabulary.tableWords.has(word))) {
      lower = rest;
      break;
    }
  }
  const bare = lower.replace(/_id$/, '');
  return bare !== lower && vocabulary.shared.has(bare) ? bare : lower;
}

function isPeriodColumn(column: { name: string; type?: string }): boolean {
  const type = column.type?.trim() ?? '';
  if (DATE_TYPE.test(type)) return true;
  return PERIOD_NAME.test(column.name) && !/^(double|float|real|decimal|numeric|bool|boolean|time|timestamp|datetime|interval)/i.test(type);
}

/**
 * What one row is: the fewest columns (one to three) that are never null and
 * unique, tried from declared keys and dbt tests first, then from key-like
 * and period columns. When no set is unique, the smallest one with at most
 * 0.5% repeated rows is returned with its count of repeats ("29 games
 * duplicated"). Counting queries only: COUNT and COUNT DISTINCT, and the
 * number of distinct combinations.
 */
export async function findRowIdentity(
  relation: WarehouseCatalogRelationV1,
  run: Run,
  quote: (identifier: string) => string,
  options: {
    hints?: Array<{ columns: string[]; source: 'declared_key' | 'dbt_test' }>;
    currentRowsOnly?: string;
    /** How many tables carry a column: a key other tables share says what a row is better than a counter only this table has. */
    sharedBy?: (column: string) => number;
  } = {},
): Promise<RowIdentity | undefined> {
  // A history snapshot repeats a key once per version: its identity is read
  // on the current rows (`dbt_valid_to IS NULL`).
  const table = `${relation.relation.split('.').map(quote).join('.')}${options.currentRowsOnly ? ` WHERE ${quote(options.currentRowsOnly)} IS NULL` : ''}`;
  const columnNamed = (name: string) => relation.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  const hints = (options.hints ?? [])
    .map((hint) => ({ columns: hint.columns.map((name) => columnNamed(name)?.name), source: hint.source }))
    .filter((hint): hint is { columns: string[]; source: 'declared_key' | 'dbt_test' } => hint.columns.length > 0 && hint.columns.every(Boolean));
  // Tier 0: declared or named like a key; tier 1: a period; tier 2 (only when
  // nothing else identifies a row): a short text label, such as a team name.
  const tierOf = new Map<string, number>();
  for (const column of relation.columns) {
    if (DBT_META_COLUMN.test(column.name)) continue;
    const type = column.type?.trim() ?? '';
    if (KEY_LIKE_NAME.test(column.name) && !(type && NON_KEY_TYPE.test(type))) tierOf.set(column.name, 0);
    else if (isPeriodColumn(column)) tierOf.set(column.name, 1);
    else if (TEXT_TYPE.test(type)) tierOf.set(column.name, 2);
  }
  for (const hint of hints) for (const column of hint.columns) if (!tierOf.has(column) || tierOf.get(column)! > 0) tierOf.set(column, 0);
  const ranked = [...tierOf.keys()].sort((a, b) => tierOf.get(a)! - tierOf.get(b)! || a.localeCompare(b));
  const candidates = [...ranked.filter((name) => tierOf.get(name)! < 2).slice(0, MAX_IDENTITY_CANDIDATES), ...ranked.filter((name) => tierOf.get(name) === 2).slice(0, 6)];
  if (candidates.length === 0) return undefined;

  const first = (await run(`SELECT COUNT(*) AS row_count, ${candidates.map((column, index) => `COUNT(${quote(column)}) AS nn_${index}, COUNT(DISTINCT ${quote(column)}) AS nd_${index}`).join(', ')} FROM ${table}`)).rows[0] ?? {};
  const rows = num(first, 'row_count');
  if (!(rows > 0)) return undefined;
  const distinct = new Map<string, number>();
  candidates.forEach((column, index) => {
    if (num(first, `nn_${index}`) === rows) distinct.set(column, num(first, `nd_${index}`));
  });

  const groups = async (sets: string[][]): Promise<number[]> => {
    const parts = sets.map((set, index) => `(SELECT COUNT(*) FROM (SELECT 1 AS one FROM ${table} GROUP BY ${set.map(quote).join(', ')}) g${index}) AS c${index}`);
    const row = (await run(`SELECT ${parts.join(', ')}`)).rows[0] ?? {};
    return sets.map((_, index) => num(row, `c${index}`));
  };
  const counted = (set: string[], groupCount: number, source: RowIdentity['source']): RowIdentity => ({ columns: set, rows, duplicates: rows - groupCount, source });

  for (const hint of hints) {
    if (!hint.columns.every((column) => distinct.has(column))) continue;
    const [groupCount] = hint.columns.length === 1 ? [distinct.get(hint.columns[0]!)!] : await groups([hint.columns]);
    if (groupCount === rows) return counted(hint.columns, groupCount!, hint.source);
  }

  // Smallest first. Within a size, a unique set wins, else the set with the
  // fewest repeats, if they are few. Columns other tables share first
  // ((player_id, season) before (career_season_number, player_id), team_id
  // before opponent_team_id), then keys before periods, then the coarsest
  // combination: (player_id, season) before (player_id, first_game_date).
  const shared = (set: string[]) => set.reduce((sum, column) => sum + (options.sharedBy?.(column) ?? 0), 0);
  const usable = [...distinct.keys()].filter((column) => distinct.get(column)! > 1 || rows === 1);
  for (const withLabels of [false, true]) {
    const pool = usable.filter((column) => withLabels || tierOf.get(column)! < 2);
    if (withLabels && pool.length === usable.filter((column) => tierOf.get(column)! < 2).length) break;
    for (let size = 1; size <= 3; size += 1) {
      const sets = combinations(pool, size)
        .filter((set) => !withLabels || set.some((column) => tierOf.get(column) === 2))
        .filter((set) => set.reduce((product, column) => product * distinct.get(column)!, 1) >= rows * (1 - NEAR_UNIQUE_SHARE))
        .sort((a, b) => shared(b) - shared(a) || tierSum(a, tierOf) - tierSum(b, tierOf) || product(a, distinct) - product(b, distinct) || a.join().localeCompare(b.join()))
        .slice(0, MAX_COMBINATIONS_PER_SIZE);
      if (sets.length === 0) continue;
      const counts = size === 1 ? sets.map((set) => distinct.get(set[0]!)!) : await groups(sets);
      const exact = sets.findIndex((_, index) => counts[index] === rows);
      if (exact >= 0) return counted(sets[exact]!, counts[exact]!, 'searched');
      const near = sets
        .map((set, index) => ({ set, count: counts[index]! }))
        .filter((item) => rows - item.count <= rows * NEAR_UNIQUE_SHARE)
        .sort((a, b) => b.count - a.count)[0];
      if (near) return counted(near.set, near.count, 'searched');
    }
  }
  return undefined;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 1) return items.map((item) => [item]);
  return items.flatMap((item, index) => combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]));
}
const tierSum = (set: string[], tierOf: Map<string, number>) => set.reduce((sum, column) => sum + tierOf.get(column)!, 0);
const product = (set: string[], distinct: Map<string, number>) => set.reduce((total, column) => total * distinct.get(column)!, 1);

/** The period a table covers, on its coarsest period column (a season before a date). */
async function measurePeriod(relation: WarehouseCatalogRelationV1, column: string, run: Run, quote: (identifier: string) => string): Promise<PeriodCoverage | undefined> {
  const table = relation.relation.split('.').map(quote).join('.');
  const row = (await run(`SELECT MIN(${quote(column)}) AS lo, MAX(${quote(column)}) AS hi, COUNT(DISTINCT ${quote(column)}) AS n FROM ${table}`)).rows[0] ?? {};
  const value = (name: string) => {
    const raw = row[name] ?? row[name.toUpperCase()];
    if (raw === null || raw === undefined) return undefined;
    return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
  };
  const min = value('lo');
  const max = value('hi');
  return min !== undefined && max !== undefined ? { column, min, max, distinct: num(row, 'n') } : undefined;
}

function comparePeriodValue(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b);
}

/** `b` covers all of `a` and clearly more of it. */
function widerPeriod(b: PeriodCoverage, a: PeriodCoverage): boolean {
  return comparePeriodValue(b.min, a.min) <= 0 && comparePeriodValue(b.max, a.max) >= 0 && b.distinct >= a.distinct * 1.1 && b.distinct > a.distinct;
}

function periodText(period: PeriodCoverage): string {
  return period.min === period.max ? `${period.column} ${period.min} only` : `${period.column} ${period.min}–${period.max}`;
}

/** dbt facts by relation (`database.schema.alias` and `schema.alias`, lower case), read from dbt's manifest.json. */
export function readDbtRelationFacts(manifestPath: string): Map<string, DbtRelationFacts> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  const facts = new Map<string, DbtRelationFacts>();
  const byId = new Map<string, DbtRelationFacts>();
  const add = (uniqueId: string, node: Record<string, unknown>, resourceType: DbtRelationFacts['resourceType']) => {
    const name = text(node.alias) ?? text(node.identifier) ?? text(node.name);
    if (!name) return;
    const fact: DbtRelationFacts = {
      uniqueId,
      resourceType,
      ...(text(node.original_file_path) ?? text(node.path) ? { path: text(node.original_file_path) ?? text(node.path) } : {}),
      ...(text(record(node.config).materialized) ? { materialized: text(record(node.config).materialized) } : {}),
      dependsOn: (record(node.depends_on).nodes as unknown[] | undefined ?? []).filter((id): id is string => typeof id === 'string'),
      uniqueTests: [],
      tests: 0,
      exposures: 0,
    };
    byId.set(uniqueId, fact);
    const schema = text(node.schema);
    const database = text(node.database);
    if (schema) facts.set(`${schema}.${name}`.toLowerCase(), fact);
    if (schema && database) facts.set(`${database}.${schema}.${name}`.toLowerCase(), fact);
  };
  for (const [uniqueId, value] of Object.entries(record(manifest.nodes))) {
    const node = record(value);
    const type = node.resource_type;
    if (type === 'model' || type === 'snapshot' || type === 'seed') add(uniqueId, node, type);
  }
  for (const [uniqueId, value] of Object.entries(record(manifest.sources))) add(uniqueId, record(value), 'source');
  for (const value of Object.values(record(manifest.nodes))) {
    const node = record(value);
    if (node.resource_type !== 'test') continue;
    const target = byId.get(text(node.attached_node) ?? (record(node.depends_on).nodes as string[] | undefined ?? []).find((id) => byId.has(id)) ?? '');
    if (!target) continue;
    target.tests += 1;
    const meta = record(node.test_metadata);
    const kwargs = record(meta.kwargs);
    const testName = text(meta.name);
    const column = text(kwargs.column_name) ?? text(node.column_name);
    if (testName === 'unique' && column) target.uniqueTests.push([column]);
    if (testName === 'unique_combination_of_columns' && Array.isArray(kwargs.combination_of_columns)) {
      target.uniqueTests.push(kwargs.combination_of_columns.filter((item): item is string => typeof item === 'string'));
    }
  }
  for (const value of Object.values(record(manifest.exposures))) {
    for (const id of (record(record(value).depends_on).nodes as string[] | undefined ?? [])) {
      const target = byId.get(id);
      if (target) target.exposures += 1;
    }
  }
  return facts;
}

interface Measured {
  entity: DiscoveredEntity;
  relation: WarehouseCatalogRelationV1;
  layer: TableLayer;
  layerEvidence: string;
  identity?: RowIdentity;
  canonicalIdentity?: string;
  period?: PeriodCoverage;
  dbt?: DbtRelationFacts;
}

/**
 * Give each drafted entity a layer and a row identity found on the data,
 * group the tables that hold the same rows, and propose one per group. Every
 * other member gets `useInstead`, with the measured reason: it covers less
 * (fewer rows, or a shorter period), its rows repeat where the pick's do not,
 * it is an earlier layer, or the pick is built from it. Tables nothing tells
 * apart stay as they are. A pick whose rows a wider table holds over a longer
 * period (a 2009–2019 roster beside player games for 2003–2022) points at
 * that table too.
 */
export async function draftTablePicks(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  run: Run,
  quote: (identifier: string) => string,
  options: { dbt?: Map<string, DbtRelationFacts>; readViews?: (relation: WarehouseCatalogRelationV1) => boolean; maxTables?: number } = {},
): Promise<WarehouseDiscoveryReport> {
  const relationById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const vocabulary = columnVocabulary(snapshot.relations);
  const dbtOf = (relation: WarehouseCatalogRelationV1) => options.dbt?.get(relation.relation.toLowerCase()) ?? options.dbt?.get(`${relation.schema ?? ''}.${relation.name}`.toLowerCase());
  const relationOfDbt = new Map<string, string>();
  for (const relation of snapshot.relations) {
    const dbt = dbtOf(relation);
    if (dbt) relationOfDbt.set(dbt.uniqueId, relation.id);
  }

  // Lineage: a view that only renames or filters one relation is a copy of
  // it; dbt's depends_on says what every model is built from.
  const copyOf = new Map<string, string>();
  const parents = new Map<string, Set<string>>();
  for (const relation of snapshot.relations) {
    const ups = new Set<string>();
    if (relation.viewSql) {
      const source = projectionSource(relation.viewSql);
      const parent = source ? resolveWarehouseRelation(snapshot, source).relation : undefined;
      if (parent && parent.id !== relation.id) copyOf.set(relation.id, parent.id);
      for (const name of new Set(statementTables(relation.viewSql).values())) {
        const read = resolveWarehouseRelation(snapshot, name).relation;
        if (read && read.id !== relation.id) ups.add(read.id);
      }
    }
    for (const id of dbtOf(relation)?.dependsOn ?? []) {
      const read = relationOfDbt.get(id);
      if (read && read !== relation.id) ups.add(read);
    }
    parents.set(relation.id, ups);
  }
  const builtFrom = (child: string, ancestor: string, seen = new Set<string>()): boolean => {
    for (const parent of parents.get(child) ?? []) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        if (builtFrom(parent, ancestor, seen)) return true;
      }
    }
    return false;
  };

  // Layers: tables first, then the views that rename them.
  const measured: Measured[] = [];
  const layerOf = new Map<string, TableLayer>();
  for (const entity of report.entities) {
    const relation = relationById.get(entity.relationId);
    if (!relation) continue;
    const { layer, evidence } = tableLayer(relation, { dbt: dbtOf(relation) });
    layerOf.set(relation.id, layer);
    measured.push({ entity, relation, layer, layerEvidence: evidence, dbt: dbtOf(relation) });
  }
  for (const item of measured) {
    const parent = copyOf.get(item.relation.id);
    if (!parent || item.layer !== 'final' || item.layerEvidence !== 'nothing marks it as raw, staging or intermediate') continue;
    const parentRelation = relationById.get(parent);
    const parentLayer = layerOf.get(parent) ?? (parentRelation ? tableLayer(parentRelation, { dbt: dbtOf(parentRelation) }).layer : undefined);
    if (parentRelation && parentLayer) {
      const verdict = tableLayer(item.relation, { dbt: item.dbt, copyOf: { name: parentRelation.name, layer: parentLayer } });
      item.layer = verdict.layer;
      item.layerEvidence = verdict.evidence;
    }
  }

  // Row identity, on the tables the data checks may read.
  const readable = (relation: WarehouseCatalogRelationV1) => relation.columns.length > 0 && (options.readViews?.(relation) ?? true);
  let read = 0;
  for (const item of measured) {
    if (!readable(item.relation) || read >= (options.maxTables ?? 500)) continue;
    read += 1;
    const hints = [
      ...((item.relation.primaryKey ?? []).length ? [{ columns: item.relation.primaryKey!, source: 'declared_key' as const }] : []),
      ...(item.dbt?.uniqueTests ?? []).map((columns) => ({ columns, source: 'dbt_test' as const })),
    ];
    const validTo = item.layer === 'snapshot' ? item.relation.columns.find((column) => column.name.toLowerCase() === 'dbt_valid_to')?.name : undefined;
    try {
      const sharedBy = (column: string) => Math.max(vocabulary.tablesWith.get(column.toLowerCase()) ?? 0, vocabulary.tablesWith.get(canonicalColumn(column, vocabulary, item.relation.name)) ?? 0);
      item.identity = await findRowIdentity(item.relation, run, quote, { hints, sharedBy, ...(validTo ? { currentRowsOnly: validTo } : {}) });
    } catch { /* a table that cannot be read gets no identity */ }
    // Only an identity with a key in it groups tables: two tables of one row
    // per day are not the same thing because both are daily.
    const columns = item.identity?.columns ?? [];
    if (columns.some((column) => !isPeriodColumn(item.relation.columns.find((candidate) => candidate.name === column)!))) {
      item.canonicalIdentity = columns.map((column) => canonicalColumn(column, vocabulary, item.relation.name)).sort().join(',');
    }
  }

  // Groups: a copy and what it copies, and tables with the same identity.
  const root = new Map<string, string>(measured.map((item) => [item.relation.id, item.relation.id]));
  const find = (id: string): string => {
    let current = id;
    while (root.get(current) !== current) current = root.get(current)!;
    root.set(id, current);
    return current;
  };
  const union = (a: string, b: string) => {
    if (root.has(a) && root.has(b)) root.set(find(a), find(b));
  };
  for (const [child, parent] of copyOf) union(child, parent);
  const byIdentity = new Map<string, string>();
  for (const item of measured) {
    if (!item.canonicalIdentity) continue;
    const other = byIdentity.get(item.canonicalIdentity);
    if (other) union(item.relation.id, other);
    else byIdentity.set(item.canonicalIdentity, item.relation.id);
  }
  const groups = new Map<string, Measured[]>();
  for (const item of measured) groups.set(find(item.relation.id), [...(groups.get(find(item.relation.id)) ?? []), item]);

  // Coverage: each member's period on the period column the group shares.
  const periodColumnOf = (relation: WarehouseCatalogRelationV1, canonical?: string): string | undefined => {
    const periods = relation.columns.filter((column) => !DBT_META_COLUMN.test(column.name) && isPeriodColumn(column));
    const wanted = canonical ? periods.filter((column) => canonicalColumn(column.name, vocabulary) === canonical) : periods;
    return (wanted.find((column) => COARSE_PERIOD.test(column.name)) ?? wanted[0])?.name;
  };
  const measureOne = async (item: Measured, canonical?: string) => {
    const column = periodColumnOf(item.relation, canonical);
    if (!column || item.period || !readable(item.relation)) return;
    try {
      item.period = await measurePeriod(item.relation, column, run, quote);
    } catch { /* no period */ }
  };
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const counts = new Map<string, number>();
    for (const item of members) {
      for (const column of new Set(item.relation.columns.filter((c) => isPeriodColumn(c) && !DBT_META_COLUMN.test(c.name)).map((c) => canonicalColumn(c.name, vocabulary)))) {
        counts.set(column, (counts.get(column) ?? 0) + 1);
      }
    }
    const shared = [...counts].filter(([, count]) => count >= 2).map(([column]) => column)
      .sort((a, b) => Number(COARSE_PERIOD.test(b)) - Number(COARSE_PERIOD.test(a)) || counts.get(b)! - counts.get(a)! || a.localeCompare(b))[0];
    if (shared) for (const item of members) await measureOne(item, shared);
  }

  // Order each group: the best table first.
  const keysOf = (item: Measured) => (item.identity ? item.identity.rows - item.identity.duplicates : undefined);
  const lookAlikes: LookAlikeGroup[] = [];
  const useInstead = new Map<string, UseInstead>();
  const kept: Measured[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) {
      kept.push(...members);
      continue;
    }
    const maxKeys = Math.max(0, ...members.map((item) => keysOf(item) ?? 0));
    const maxPeriods = Math.max(0, ...members.map((item) => item.period?.distinct ?? 0));
    const bucket = (share: number) => (share >= SAME_COVERAGE ? 1 : share);
    const periodShare = (item: Measured) => bucket(!item.period || maxPeriods === 0 ? 1 : item.period.distinct / maxPeriods);
    const keyShare = (item: Measured) => bucket(keysOf(item) === undefined || maxKeys === 0 ? 1 : keysOf(item)! / maxKeys);
    // The pick holds as many rows: an earlier layer or a repeating copy can be
    // set aside without losing any. Fewer rows alone is never a reason: a
    // table of active customers beside all customers is not a worse copy.
    const holdsAsMany = (pick: Measured, item: Measured) => keysOf(pick) === undefined || keysOf(item) === undefined || keysOf(pick)! >= keysOf(item)! * SAME_COVERAGE;
    const reasonAgainst = (item: Measured, pick: Measured): string | undefined => {
      const pickName = pick.relation.name;
      if (item.layer === 'snapshot' && pick.layer !== 'snapshot') return `a history table (${item.layerEvidence}); ${pickName} holds the current rows`;
      if (item.period && pick.period && widerPeriod(pick.period, item.period)) return `covers ${periodText(item.period)}; ${pickName} covers ${periodText(pick.period)}`;
      if (!holdsAsMany(pick, item)) return undefined;
      const repeats = item.identity?.duplicates ?? 0;
      const pickRepeats = pick.identity?.duplicates ?? 0;
      if (repeats > pickRepeats) return `${plural(repeats, 'row')} repeat on ${item.identity!.columns.join(', ')}; ${pickName} has ${pickRepeats === 0 ? 'none' : pickRepeats.toLocaleString('en-US')}`;
      if (LAYER_RANK[item.layer] < LAYER_RANK[pick.layer]) return `a ${item.layer} table (${item.layerEvidence}); ${pickName} is the ${pick.layer} table with the same rows`;
      if (builtFrom(pick.relation.id, item.relation.id)) return `${pickName} is built from it, with the same rows`;
      return undefined;
    };
    const ordered = [...members].sort((a, b) =>
      Number(a.layer === 'snapshot') - Number(b.layer === 'snapshot')
      || periodShare(b) - periodShare(a)
      || (a.identity?.duplicates ?? 0) - (b.identity?.duplicates ?? 0)
      || LAYER_RANK[b.layer] - LAYER_RANK[a.layer]
      || Number(builtFrom(b.relation.id, a.relation.id)) - Number(builtFrom(a.relation.id, b.relation.id))
      || keyShare(b) - keyShare(a)
      || ((b.dbt?.tests ?? 0) + (b.dbt?.exposures ?? 0)) - ((a.dbt?.tests ?? 0) + (a.dbt?.exposures ?? 0))
      || a.relation.name.localeCompare(b.relation.name));
    const pick = ordered[0]!;
    const group: LookAlikeGroup = { identity: pick.identity?.columns ?? [], pick: pick.relation.relation, members: [] };
    for (const item of ordered) {
      const reason = item === pick ? undefined : reasonAgainst(item, pick);
      if (reason) useInstead.set(item.relation.id, { entity: pick.entity.id, domain: pick.entity.domain, relation: pick.relation.relation, reason });
      else kept.push(item);
      group.members.push({
        relation: item.relation.relation,
        entity: item.entity.id,
        domain: item.entity.domain,
        layer: item.layer,
        ...(item.identity ? { rows: item.identity.rows, keys: keysOf(item)!, duplicates: item.identity.duplicates } : {}),
        ...(item.period ? { period: item.period } : {}),
        verdict: reason ? 'use_instead' : 'pick',
        ...(reason ? { reason } : {}),
      });
    }
    lookAlikes.push(group);
  }

  // A kept table whose rows a wider table holds over a longer period.
  const canonicalColumns = (item: Measured) => new Set(item.relation.columns.filter((column) => !DBT_META_COLUMN.test(column.name)).map((column) => canonicalColumn(column.name, vocabulary, item.relation.name)));
  for (const item of kept) if (item.identity && item.identity.duplicates === 0) await measureOne(item);
  for (const narrow of kept) {
    if (!narrow.identity || !narrow.period || useInstead.has(narrow.relation.id)) continue;
    const identity = narrow.identity.columns.map((column) => canonicalColumn(column, vocabulary, narrow.relation.name));
    const periodCanonical = canonicalColumn(narrow.period.column, vocabulary);
    const others = [...canonicalColumns(narrow)].filter((column) => !identity.includes(column) && column !== periodCanonical);
    for (const wide of kept) {
      if (wide === narrow || useInstead.has(wide.relation.id) || !wide.period || canonicalColumn(wide.period.column, vocabulary) !== periodCanonical) continue;
      const columns = canonicalColumns(wide);
      if (!identity.every((column) => columns.has(column)) || !columns.has(periodCanonical)) continue;
      if (others.length > 0 && others.filter((column) => columns.has(column)).length / others.length < NARROWER_COLUMN_SHARE) continue;
      if (!widerPeriod(wide.period, narrow.period)) continue;
      const reason = `covers ${periodText(narrow.period)}; ${wide.relation.name} holds the same ${narrow.identity.columns.join(', ')} for ${wide.period.min}–${wide.period.max}`;
      useInstead.set(narrow.relation.id, { entity: wide.entity.id, domain: wide.entity.domain, relation: wide.relation.relation, reason });
      for (const group of lookAlikes) {
        const member = group.members.find((candidate) => candidate.relation === narrow.relation.relation);
        if (member) Object.assign(member, { verdict: 'use_instead', reason, period: narrow.period });
      }
      break;
    }
  }

  const byRelation = new Map(measured.map((item) => [item.relation.id, item]));
  const entities = report.entities.map((entity): DiscoveredEntity => {
    const item = byRelation.get(entity.relationId);
    if (!item) return entity;
    const exact = item.identity && item.identity.duplicates === 0 ? item.identity : undefined;
    return {
      ...entity,
      layer: item.layer,
      layerEvidence: item.layerEvidence,
      ...(item.identity ? { identity: item.identity } : {}),
      ...(!entity.grain && exact ? { grain: exact.columns.join(', '), keys: exact.columns, grainSource: 'unique_column' as const } : {}),
      ...(useInstead.has(entity.relationId) ? { useInstead: useInstead.get(entity.relationId)! } : {}),
    };
  });
  return { ...report, entities, ...(lookAlikes.length ? { lookAlikes: lookAlikes.sort((a, b) => a.pick.localeCompare(b.pick)) } : {}) };
}
