/**
 * Names, descriptions, concepts and rules drafted from measured facts
 * (RFC 0012, P3 and P4).
 *
 * The NBA business model that removed every wrong-layer answer wrote down the
 * traps with numbers: 109,669 player-game rows are games not played; a game
 * has two team rows, so never join on game_id alone; season 2017 means
 * 2017-18; the first digit of game_id is the game type; 29 games repeat. Each
 * of those is a counting query away. This runs the queries on the tables the
 * draft picked and writes each finding as a rule whose sentence comes from a
 * template, so every number in it is the number the saved query returned.
 *
 * Words come from the same facts: the picked table of a group of look-alikes
 * takes the plain name (`local_player_game_facts` → "Player game"), each
 * entity's description says what one row is, how many there are and what
 * period they cover, and a key several picked tables share with no table of
 * its own (`player_id`) becomes a concept.
 *
 * What leaves the warehouse: counts, the minimum and maximum of a period, the
 * true/false of a flag, and the first character of a code column, only where
 * three or more rows share it (decision M7, the #244 rule).
 */

import type { WarehouseCatalogRelationV1, WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { DBT_META_COLUMN, canonicalColumn, columnVocabulary, isPeriodColumn } from './model-layers.js';
import { KEY_LIKE_NAME, type DiscoveredEntity, type DiscoveredRelationship, type WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

type Run = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** A rule measured on the data, with the query that measured it. */
export interface DiscoveredRule {
  id: string;
  domain: string;
  kind: 'custom' | 'fanout';
  expression: string;
  /** The drafted entities it is about. */
  entities: string[];
  evidence: { query: string; measured: Record<string, string | number>; checkedAt: string };
}

/** A thing several picked tables identify with one key, and no table holds one row of. */
export interface DiscoveredConcept {
  id: string;
  domain: string;
  name: string;
  description: string;
  bindings: Array<{ entity: string; role: 'canonical' | 'conformed'; grain: string }>;
}

const BOOLEAN_TYPE = /^(bool|boolean)\b/i;
const WHOLE_NUMBER_TYPE = /^(int|integer|bigint|smallint|tinyint|hugeint|ubigint|uinteger|number)\b/i;
const FLAG_NAME = /^(is|has|was|did|can|should)_/i;
/** A flag whose smaller side is this share of rows or less splits what a count means. */
const MAX_FLAG_MINORITY = 0.35;
const MIN_FLAG_MINORITY = 0.01;
/** A period with fewer rows than this share of a typical one is short or partial. */
const SHORT_PERIOD = 0.9;
/** A few rows per key is the join trap (two team rows per game); a large constant is a complete panel, not a trap. */
const MAX_ROWS_PER_KEY = 4;
/** A code column's first character takes this many values at most. */
const MAX_CODE_GROUPS = 6;
/** Values a category must be shared by before it may be named (#244). */
const MIN_SHARED_ROWS = 3;
/** The period a table is about: a season, a year or a fiscal year, not an attribute such as `min_year`. */
const MAIN_PERIOD = /^(season|year|fiscal_year)(_id)?$/i;
/** A typical period must hold this many rows before a short one means anything. */
const MIN_TYPICAL_ROWS = 30;
const LAYER_SUFFIX = /_(facts?|fct|cleansed|cleaned|clean|curated|final|current|latest|v\d+)$/i;
const LAYER_PREFIX = /^(stg|staging|src|dim|fct|fact|int|intermediate|base|raw|mart|agg|rpt|tbl|vw)_+/i;

const num = (row: Record<string, unknown>, name: string): number => Number(row[name] ?? row[name.toUpperCase()]);
const value = (row: Record<string, unknown>, name: string): unknown => row[name] ?? row[name.toUpperCase()];
const count = (value: number) => value.toLocaleString('en-US');
const percent = (share: number) => `${Math.floor(share * 100)}%`;
const dateText = (raw: unknown): string | undefined => (raw === null || raw === undefined ? undefined : raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10));
const slug = (text: string) => {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned || 'item'}`;
};
const singular = (word: string) => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : /(sses|xes|ches|shes)$/.test(word) ? word.slice(0, -2) : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
const sentence = (words: string[]) => {
  const text = words.join(' ');
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
};

interface Picked {
  entity: DiscoveredEntity;
  relation: WarehouseCatalogRelationV1;
  table: string;
}

/**
 * Draft names, descriptions and concepts (P3) and measured rules (P4) for a
 * checked discovery report. Rules are measured on the picked tables only:
 * a look-alike's traps are why it was not picked.
 */
export async function draftWordsAndRules(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  run: Run,
  quote: (identifier: string) => string,
  options: {
    readable?: (relation: WarehouseCatalogRelationV1) => boolean;
    checkedAt?: Date;
    /** Qualified ids already in the model: a person's rule or concept is never redrafted over. */
    existing?: { rules?: ReadonlySet<string>; concepts?: ReadonlySet<string> };
  } = {},
): Promise<WarehouseDiscoveryReport> {
  const named = nameEntities(report, snapshot);
  const relationById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const picked: Picked[] = named.entities
    .filter((entity) => !entity.useInstead && relationById.has(entity.relationId) && (options.readable?.(relationById.get(entity.relationId)!) ?? true))
    .map((entity) => ({ entity, relation: relationById.get(entity.relationId)!, table: relationById.get(entity.relationId)!.name }));
  const checkedAt = (options.checkedAt ?? new Date()).toISOString();
  const rules: DiscoveredRule[] = [];
  const add = (rule: Omit<DiscoveredRule, 'evidence'> & { query: string; measured: Record<string, string | number> }) => {
    const { query, measured, ...rest } = rule;
    let id = rest.id;
    for (let index = 2; rules.some((item) => item.domain === rest.domain && item.id === id); index += 1) id = `${rest.id}_${index}`;
    rules.push({ ...rest, id, evidence: { query, measured, checkedAt } });
  };
  const safely = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch {
      return undefined;
    }
  };
  for (const item of picked) await safely(() => flagRules(item, run, quote, add));
  for (const item of picked) await safely(() => rowsPerKeyRule(item, run, quote, add));
  for (const item of picked) await safely(() => repeatRule(item, run, quote, add));
  await safely(() => codeRules(picked, snapshot, run, quote, add));
  await safely(() => periodRules(picked, run, quote, add));
  const periods = new Map<string, { column: string; min: string; max: string }>();
  for (const item of picked) {
    const coverage = await safely(() => coverageOf(item, run, quote));
    if (coverage) periods.set(item.entity.relationId, coverage);
  }
  const entities = named.entities.map((entity) => ({ ...entity, ...describe(entity, named, relationById, periods) }));
  const concepts = draftConcepts({ ...named, entities }, snapshot, picked)
    .filter((concept) => !options.existing?.concepts?.has(`${concept.domain}::concept::${concept.id}`));
  const newRules = rules.filter((rule) => !options.existing?.rules?.has(`${rule.domain}::rule::${rule.id}`));
  return {
    ...named,
    entities,
    ...(newRules.length ? { rules: newRules } : {}),
    ...(concepts.length ? { concepts } : {}),
  };
}

/**
 * The picked table of a group of look-alikes takes the plain name, without
 * layer prefixes and suffixes (`local_player_game_facts` → "Player game",
 * `dim_teams_cleansed` → "Team"); a look-alike holding that name gives it up
 * and is named after its table. Entities already in the model keep theirs.
 */
export function nameEntities(report: WarehouseDiscoveryReport, snapshot: WarehouseCatalogSnapshotV1): WarehouseDiscoveryReport {
  const relationById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const vocabulary = columnVocabulary(snapshot.relations);
  // A leading word several tables share that names no row identity is a
  // layer (`local_` on four NBA tables), not a business thing.
  const identityWords = new Set(report.entities.flatMap((entity) => (entity.identity?.columns ?? []).map((column) => canonicalColumn(column, vocabulary, relationById.get(entity.relationId)?.name).replace(/_(id|key|code|no|number)$/, ''))));
  const firstWords = new Map<string, number>();
  for (const entity of report.entities) {
    const word = relationById.get(entity.relationId)?.name.toLowerCase().split('_')[0];
    if (word) firstWords.set(word, (firstWords.get(word) ?? 0) + 1);
  }
  const plainName = (relation: WarehouseCatalogRelationV1): string => {
    let name = relation.name.toLowerCase();
    for (let guard = 0; guard < 2 && LAYER_PREFIX.test(name); guard += 1) name = name.replace(LAYER_PREFIX, '');
    const first = name.split('_')[0]!;
    if (name.includes('_') && (firstWords.get(first) ?? 0) >= 3 && !identityWords.has(first) && !identityWords.has(singular(first))) name = name.slice(first.length + 1);
    name = name.replace(LAYER_SUFFIX, '');
    const words = name.split('_').filter(Boolean);
    if (words.length) words[words.length - 1] = singular(words[words.length - 1]!);
    return words.join(' ');
  };
  const renames = new Map<string, string>();
  const names = new Map<string, string>();
  const key = (entity: DiscoveredEntity) => `${entity.domain}::${entity.id}`;
  // Picks first, so the plain name goes to the table to answer from.
  const ordered = [...report.entities].filter((entity) => !entity.existing).sort((a, b) => Number(Boolean(a.useInstead)) - Number(Boolean(b.useInstead)));
  // Entities already in the model keep their ids; nothing new may take one.
  const claimed = new Map<string, Set<string>>();
  for (const entity of report.entities.filter((item) => item.existing)) claimed.set(entity.domain, (claimed.get(entity.domain) ?? new Set()).add(entity.id));
  for (const entity of ordered) {
    const relation = relationById.get(entity.relationId);
    if (!relation) continue;
    const plain = plainName(relation);
    const ids = claimed.get(entity.domain) ?? new Set<string>();
    claimed.set(entity.domain, ids);
    const wanted = slug(plain);
    const id = !entity.useInstead && !ids.has(wanted) ? wanted : slug(relation.name);
    ids.add(id);
    names.set(key(entity), !entity.useInstead && id === wanted ? sentence(plain.split(' ')) : entity.businessName);
    if (id !== entity.id) renames.set(key(entity), id);
  }
  // Ids an entity gives up must not collide with another's new id.
  const finalIds = new Map<string, string>();
  for (const entity of report.entities) {
    const id = renames.get(key(entity)) ?? entity.id;
    finalIds.set(key(entity), id);
  }
  const rename = (domain: string, id: string) => finalIds.get(`${domain}::${id}`) ?? id;
  const entities = report.entities.map((entity) => ({
    ...entity,
    id: rename(entity.domain, entity.id),
    businessName: names.get(key(entity)) ?? entity.businessName,
    ...(entity.useInstead ? { useInstead: { ...entity.useInstead, entity: rename(entity.useInstead.domain, entity.useInstead.entity) } } : {}),
  }));
  const relationshipIds = new Map<string, Set<string>>();
  const relationships = report.relationships.map((relationship): DiscoveredRelationship => {
    const from = rename(relationship.fromDomain, relationship.from);
    const to = rename(relationship.toDomain, relationship.to);
    let id = relationship.id;
    if (from !== relationship.from || to !== relationship.to) {
      const role = relationship.id.startsWith(`${relationship.from}_to_`) && relationship.id.endsWith(`_${relationship.to}`)
        ? relationship.id.slice(`${relationship.from}_to_`.length, -relationship.to.length - 1)
        : undefined;
      id = slug(`${from}_to_${role ? `${role}_` : ''}${to}`);
    }
    const ids = relationshipIds.get(relationship.domain) ?? new Set<string>();
    relationshipIds.set(relationship.domain, ids);
    if (ids.has(id)) id = slug(`${id}_by_${relationship.keys.map((pair) => pair.from).join('_')}`);
    ids.add(id);
    return { ...relationship, id, from, to };
  });
  return {
    ...report,
    entities,
    relationships,
    ...(report.lookAlikes ? { lookAlikes: report.lookAlikes.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member, entity: rename(member.domain, member.entity) })) })) } : {}),
  };
}

/** What a row is, how many, and the period covered, from what was measured. */
function describe(
  entity: DiscoveredEntity,
  report: WarehouseDiscoveryReport,
  relationById: Map<string, WarehouseCatalogRelationV1>,
  periods: Map<string, { column: string; min: string; max: string }>,
): Partial<DiscoveredEntity> {
  if (entity.existing || !entity.identity) return {};
  const identity = entity.identity;
  const parts = [`One row per ${identity.columns.join(', ')}${identity.duplicates ? `, except ${count(identity.duplicates)} repeated rows` : ''}: ${count(identity.rows)} rows`];
  const period = periods.get(entity.relationId);
  if (period) parts.push(`${period.column} ${period.min}–${period.max}`);
  const group = report.lookAlikes?.find((item) => item.members.some((member) => member.relation === entity.relation));
  const others = group?.members.filter((member) => member.relation !== entity.relation && member.verdict === 'use_instead').map((member) => member.relation.split('.').pop());
  if (!entity.useInstead && others?.length) parts.push(`answer from this table rather than ${others.join(', ')}`);
  const measured = `${parts.join('; ')}.`;
  const comment = entity.description?.trim();
  return { description: comment ? `${comment.replace(/\.?$/, '.')} ${measured}` : measured };
}

/** A key several picked tables share in their row identity, with no picked table of one row per key: a concept (a Player). */
function draftConcepts(report: WarehouseDiscoveryReport, snapshot: WarehouseCatalogSnapshotV1, picked: Picked[]): DiscoveredConcept[] {
  const vocabulary = columnVocabulary(snapshot.relations);
  const byKey = new Map<string, Picked[]>();
  const ownTable = new Set<string>();
  for (const item of picked) {
    const identity = item.entity.identity;
    if (!identity) continue;
    const keys = identity.columns.filter((column) => KEY_LIKE_NAME.test(column)).map((column) => canonicalColumn(column, vocabulary, item.table));
    // A table of one row per key (even one whose rows repeat a little) is that thing's table.
    if (identity.columns.length === 1 && keys.length === 1) ownTable.add(keys[0]!);
    if (identity.columns.length > 1 && identity.duplicates === 0) for (const keyName of keys) byKey.set(keyName, [...(byKey.get(keyName) ?? []), item]);
  }
  const concepts: DiscoveredConcept[] = [];
  for (const [keyName, items] of byKey) {
    if (items.length < 2 || ownTable.has(keyName)) continue;
    const thing = keyName.replace(/_(id|key|code|no|number)$/, '');
    if (!thing || thing === keyName) continue;
    const ordered = [...items].sort((a, b) => a.entity.identity!.rows - b.entity.identity!.rows);
    const canonical = ordered[0]!;
    const column = canonical.entity.identity!.columns.find((name) => canonicalColumn(name, vocabulary, canonical.table) === keyName)!;
    concepts.push({
      id: slug(thing),
      domain: canonical.entity.domain,
      name: sentence([thing.replace(/_/g, ' ')]),
      description: `A ${thing.replace(/_/g, ' ')}, identified by ${column} in ${ordered.map((item) => item.table).join(' and ')}. No table holds one row per ${thing.replace(/_/g, ' ')}: list them from ${canonical.table}, one row per ${canonical.entity.identity!.columns.join(', ')}.`,
      bindings: ordered.map((item, index) => ({ entity: item.entity.domain === canonical.entity.domain ? item.entity.id : `${item.entity.domain}::entity::${item.entity.id}`, role: index === 0 ? 'canonical' : 'conformed', grain: item.entity.identity!.columns.join(', ') })),
    });
  }
  return concepts.sort((a, b) => a.id.localeCompare(b.id));
}

type AddRule = (rule: Omit<DiscoveredRule, 'evidence'> & { query: string; measured: Record<string, string | number> }) => void;
const tableOf = (item: Picked, quote: (identifier: string) => string) => item.relation.relation.split('.').map(quote).join('.');

/** A true/false column whose smaller side is 1% to 35% of the rows: a count may mean either. */
async function flagRules(item: Picked, run: Run, quote: (identifier: string) => string, add: AddRule): Promise<void> {
  const flags = item.relation.columns.filter((column) => !DBT_META_COLUMN.test(column.name)
    && (BOOLEAN_TYPE.test(column.type ?? '') || (FLAG_NAME.test(column.name) && WHOLE_NUMBER_TYPE.test(column.type ?? ''))));
  if (flags.length === 0) return;
  const truth = (column: { name: string; type?: string }) => (BOOLEAN_TYPE.test(column.type ?? '') ? quote(column.name) : `${quote(column.name)} = 1`);
  const query = `SELECT COUNT(*) AS row_count, ${flags.map((column, index) => `SUM(CASE WHEN ${truth(column)} THEN 1 ELSE 0 END) AS t_${index}, SUM(CASE WHEN NOT (${truth(column)}) THEN 1 ELSE 0 END) AS f_${index}`).join(', ')} FROM ${tableOf(item, quote)}`;
  const row = (await run(query)).rows[0] ?? {};
  const rows = num(row, 'row_count');
  flags.forEach((column, index) => {
    const yes = num(row, `t_${index}`);
    const no = num(row, `f_${index}`);
    const minority = Math.min(yes, no);
    if (!(rows > 0) || minority < rows * MIN_FLAG_MINORITY || minority > rows * MAX_FLAG_MINORITY) return;
    const [few, many, fewValue, manyValue] = no <= yes ? [no, yes, 'false', 'true'] : [yes, no, 'true', 'false'];
    add({
      id: slug(`${item.entity.id}_${column.name}`),
      domain: item.entity.domain,
      kind: 'custom',
      expression: `In ${item.table}, ${count(few)} of ${count(rows)} rows (${percent(few / rows)}) have ${column.name} = ${fewValue} and ${count(many)} have ${column.name} = ${manyValue}: filter on ${column.name} when a count or average should cover only one side.`,
      entities: [item.entity.id],
      query,
      measured: { rows, [`${column.name}_true`]: yes, [`${column.name}_false`]: no },
    });
  });
}

/**
 * The same number of rows for every value of one column of a multi-column
 * identity (two team rows per game): joining on that column alone doubles
 * rows. A flag true on exactly one of them picks one per value.
 */
async function rowsPerKeyRule(item: Picked, run: Run, quote: (identifier: string) => string, add: AddRule): Promise<void> {
  const identity = item.entity.identity;
  if (!identity || identity.duplicates > 0 || identity.columns.length < 2) return;
  const table = tableOf(item, quote);
  const flags = item.relation.columns.filter((column) => BOOLEAN_TYPE.test(column.type ?? ''));
  for (const column of identity.columns.filter((name) => KEY_LIKE_NAME.test(name))) {
    const query = `SELECT MIN(c) AS lo, MAX(c) AS hi, COUNT(*) AS keys FROM (SELECT COUNT(*) AS c FROM ${table} GROUP BY ${quote(column)}) g`;
    const row = (await run(query)).rows[0] ?? {};
    const lo = num(row, 'lo');
    const hi = num(row, 'hi');
    const keys = num(row, 'keys');
    if (!(lo >= 2) || lo !== hi || lo > MAX_ROWS_PER_KEY) continue;
    let picker: string | undefined;
    const measured: Record<string, string | number> = { rows_per_key: lo, keys };
    let flagQuery = '';
    if (flags.length) {
      flagQuery = `SELECT ${flags.map((flag, index) => `SUM(CASE WHEN ${quote(flag.name)} THEN 1 ELSE 0 END) AS t_${index}, COUNT(DISTINCT CASE WHEN ${quote(flag.name)} THEN ${quote(column)} END) AS k_${index}`).join(', ')} FROM ${table}`;
      const flagRow = (await run(flagQuery)).rows[0] ?? {};
      const index = flags.findIndex((_, position) => num(flagRow, `t_${position}`) === keys && num(flagRow, `k_${position}`) === keys);
      if (index >= 0) {
        picker = flags[index]!.name;
        measured[`${picker}_true`] = keys;
      }
    }
    const others = identity.columns.filter((name) => name !== column);
    add({
      id: slug(`${item.entity.id}_rows_per_${column}`),
      domain: item.entity.domain,
      kind: 'fanout',
      expression: `${item.table} has exactly ${lo} rows for every ${column} (${count(keys)} values), one per ${others.join(', ')}: join it on ${identity.columns.join(' and ')} together, never on ${column} alone${picker ? `; ${picker} = true picks one row per ${column}` : ''}.`,
      entities: [item.entity.id],
      query: flagQuery ? `${query};\n${flagQuery}` : query,
      measured,
    });
  }
}

/** A picked table whose identity repeats: count with DISTINCT. */
async function repeatRule(item: Picked, run: Run, quote: (identifier: string) => string, add: AddRule): Promise<void> {
  const identity = item.entity.identity;
  if (!identity || identity.duplicates === 0) return;
  const columns = identity.columns.map(quote).join(', ');
  const query = `SELECT COUNT(*) AS row_count, (SELECT COUNT(*) FROM (SELECT 1 AS one FROM ${tableOf(item, quote)} GROUP BY ${columns}) g) AS keys FROM ${tableOf(item, quote)}`;
  const row = (await run(query)).rows[0] ?? {};
  const rows = num(row, 'row_count');
  const keys = num(row, 'keys');
  if (!(rows > keys)) return;
  add({
    id: slug(`${item.entity.id}_repeats`),
    domain: item.entity.domain,
    kind: 'custom',
    expression: `${item.table} holds ${count(rows)} rows for ${count(keys)} distinct ${identity.columns.join(', ')}: ${count(rows - keys)} rows repeat. Count with COUNT(DISTINCT ${identity.columns.join(', ')}), or answer from a table that holds one row per key.`,
    entities: [item.entity.id],
    query,
    measured: { rows, distinct_keys: keys, repeated_rows: rows - keys },
  });
}

/**
 * A key column whose values all have the same length and whose first
 * character takes two to six values: the first character is a code (a game
 * type). Measured once per column name, on the picked table with the most
 * rows. A character is named only where three or more rows share it.
 */
async function codeRules(picked: Picked[], snapshot: WarehouseCatalogSnapshotV1, run: Run, quote: (identifier: string) => string, add: AddRule): Promise<void> {
  const vocabulary = columnVocabulary(snapshot.relations);
  const seen = new Set<string>();
  const byRows = [...picked].sort((a, b) => (b.entity.identity?.rows ?? 0) - (a.entity.identity?.rows ?? 0));
  for (const item of byRows) {
    for (const column of item.relation.columns) {
      if (!KEY_LIKE_NAME.test(column.name) || isPeriodColumn(column) || DBT_META_COLUMN.test(column.name)) continue;
      const canonical = canonicalColumn(column.name, vocabulary, item.table);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const text = `CAST(${quote(column.name)} AS VARCHAR)`;
      const query = `SELECT SUBSTR(${text}, 1, 1) AS first_char, COUNT(*) AS n, COUNT(DISTINCT ${quote(column.name)}) AS keys, MIN(LENGTH(${text})) AS lo, MAX(LENGTH(${text})) AS hi FROM ${tableOf(item, quote)} WHERE ${quote(column.name)} IS NOT NULL GROUP BY SUBSTR(${text}, 1, 1) ORDER BY 1`;
      const rows = (await run(query)).rows;
      if (rows.length < 2 || rows.length > MAX_CODE_GROUPS) continue;
      const length = num(rows[0]!, 'lo');
      if (!rows.every((row) => num(row, 'lo') === length && num(row, 'hi') === length && num(row, 'n') >= MIN_SHARED_ROWS)) continue;
      const distinct = rows.reduce((sum, row) => sum + num(row, 'keys'), 0);
      if (distinct < 20) continue;
      const groups = rows.map((row) => ({ first: String(value(row, 'first_char')), rows: num(row, 'n') }));
      const largest = [...groups].sort((a, b) => b.rows - a.rows)[0]!;
      add({
        id: slug(`${canonical}_first_character`),
        domain: item.entity.domain,
        kind: 'custom',
        expression: `Every ${column.name} in ${item.table} has ${length} characters, and the first one takes ${groups.length} values: ${groups.map((group) => `${group.first} (${count(group.rows)} rows)`).join(', ')}. The first character is a code, such as a type: filter on it with CAST(${column.name} AS VARCHAR) LIKE '${largest.first}%'.`,
        entities: [item.entity.id],
        query,
        measured: Object.fromEntries([['length', length], ...groups.map((group) => [`first_${group.first}`, group.rows])]),
      });
    }
  }
}

/**
 * What a whole-number period means, and which periods are short. For each
 * period column (a season, a year), on the picked table with the most rows
 * that has a date beside it: the dates in each period say whether the number
 * is the year a period starts (2017 runs into 2018) or ends, and periods with
 * under 90% of a typical period's rows are short or partial.
 */
async function periodRules(picked: Picked[], run: Run, quote: (identifier: string) => string, add: AddRule): Promise<void> {
  const seen = new Set<string>();
  const byRows = [...picked].sort((a, b) => (b.entity.identity?.rows ?? 0) - (a.entity.identity?.rows ?? 0));
  for (const item of byRows) {
    const period = item.relation.columns.find((column) => MAIN_PERIOD.test(column.name) && WHOLE_NUMBER_TYPE.test(column.type ?? ''));
    if (!period || seen.has(period.name.toLowerCase())) continue;
    // The period that is the table's whole identity (a season table) has one row per period.
    if (item.entity.identity?.columns.length === 1 && item.entity.identity.columns[0]!.toLowerCase() === period.name.toLowerCase()) continue;
    const date = item.relation.columns.find((column) => /^date\b/i.test(column.type ?? ''));
    const query = `SELECT ${quote(period.name)} AS period, COUNT(*) AS n${date ? `, MIN(${quote(date.name)}) AS first_day, MAX(${quote(date.name)}) AS last_day` : ''} FROM ${tableOf(item, quote)} WHERE ${quote(period.name)} IS NOT NULL GROUP BY ${quote(period.name)} ORDER BY ${quote(period.name)}`;
    const rows = (await run(query)).rows.map((row) => ({ period: num(row, 'period'), n: num(row, 'n'), first: dateText(value(row, 'first_day')), last: dateText(value(row, 'last_day')) }));
    if (rows.length < 4) continue;
    seen.add(period.name.toLowerCase());
    const label = period.name.toLowerCase().replace(/_id$/, '');
    if (date) {
      const kinds = rows.map((row) => {
        const first = Number(row.first?.slice(0, 4));
        const last = Number(row.last?.slice(0, 4));
        if (first === row.period && last === row.period + 1) return 'starts';
        if (first === row.period - 1 && last === row.period) return 'ends';
        return first === row.period && last === row.period ? 'calendar' : 'other';
      });
      for (const kind of ['starts', 'ends'] as const) {
        if (kinds.filter((item) => item === kind).length < rows.length * 0.6) continue;
        const example = rows.filter((_, index) => kinds[index] === kind)[Math.floor(kinds.filter((item) => item === kind).length / 2)]!;
        add({
          id: slug(`${label}_is_${kind === 'starts' ? 'start' : 'end'}_year`),
          domain: item.entity.domain,
          kind: 'custom',
          expression: `${period.name} is the year a ${label} ${kind}: in ${item.table}, ${period.name} ${example.period} runs from ${example.first} to ${example.last} (${kinds.filter((value) => value === kind).length} of ${rows.length} ${label}s span two calendar years this way).`,
          entities: [item.entity.id],
          query,
          measured: { periods: rows.length, [kind]: kinds.filter((value) => value === kind).length, [`example_${example.period}_first`]: example.first ?? '', [`example_${example.period}_last`]: example.last ?? '' },
        });
      }
    }
    const sorted = rows.map((row) => row.n).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const short = rows.filter((row) => row.n < median * SHORT_PERIOD);
    if (median < MIN_TYPICAL_ROWS || short.length === 0 || short.length > Math.max(3, rows.length / 3)) continue;
    const latest = rows[rows.length - 1]!;
    add({
      id: slug(`${label}_short_periods`),
      domain: item.entity.domain,
      kind: 'custom',
      expression: `In ${item.table}, a typical ${label} holds ${count(median)} rows (${rows.length} ${label}s, ${rows[0]!.period}–${latest.period}); ${short.map((row) => `${row.period} holds ${percent(row.n / median)}${row === latest ? ` (the latest${row.last ? `, through ${row.last}` : ''})` : ''}`).join(', ')}. Compare those ${label}s with care.`,
      entities: [item.entity.id],
      query,
      measured: Object.fromEntries([['typical_rows', median], ...short.map((row) => [`${label}_${row.period}_rows`, row.n])]),
    });
  }
}

/** A picked table's coverage on its coarsest period column, for its description. */
async function coverageOf(item: Picked, run: Run, quote: (identifier: string) => string): Promise<{ column: string; min: string; max: string } | undefined> {
  // A season or year column, else a date: not an attribute such as `min_year`.
  const column = item.relation.columns.find((candidate) => MAIN_PERIOD.test(candidate.name))
    ?? item.relation.columns.find((candidate) => !DBT_META_COLUMN.test(candidate.name) && /^date\b/i.test(candidate.type ?? ''));
  if (!column) return undefined;
  const row = (await run(`SELECT MIN(${quote(column.name)}) AS lo, MAX(${quote(column.name)}) AS hi FROM ${tableOf(item, quote)}`)).rows[0] ?? {};
  const min = dateText(value(row, 'lo'));
  const max = dateText(value(row, 'hi'));
  return min && max ? { column: column.name, min, max } : undefined;
}
