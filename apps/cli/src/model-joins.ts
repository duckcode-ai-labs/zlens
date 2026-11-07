/**
 * Joins drafted from row identity (RFC 0012, P2).
 *
 * Once discovery knows what one row of each table is, a join is a table that
 * carries another table's row identity: under the same names (`game_id,
 * team_id`), through a role (`opponent_team_id`, `home_team_id` → a team's
 * `team_id`), as a period (`season` → a season table's `season_id`), or on
 * itself (a team's game line → the opponent's line of the same game). The
 * warehouse then says whether the values are there, with the one statement
 * the Modeling page's Validate runs. Joins that touch a table the draft says
 * to use another instead of are left out: the pick holds the same rows.
 */

import { looksLikePlaceholder, profileRelationshipOnWarehouse } from '@zlens/agent';
import type { WarehouseCatalogRelationV1, WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { canonicalColumn, columnVocabulary } from './model-layers.js';
import type { ReadHint } from './read-budget.js';
import { KEY_LIKE_NAME, joinSignature, nameOnlyObjection, type DiscoveredEntity, type DiscoveredRelationship, type WarehouseDiscoveryReport, type WithheldRelationship } from './warehouse-model-discovery.js';

/** `hint.sample`: the statement's subject, which a read budget may read from a sample (`read-budget.ts`). */
type Run = (sql: string, hint?: ReadHint) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** A join left out because one side is a look-alike the draft says to use another table instead of. */
export interface LookAlikeJoin {
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  reason: string;
}

/** Share of the referencing rows that may find no row: the same 5% the Validate check allows. */
const MAX_UNMATCHED_SHARE = 0.05;
/** A target whose identity repeats on more rows than this is not what a row is. */
const MAX_TARGET_REPEATS = 0.005;
const MEASURE_TYPE = /^(double|float|real|decimal|numeric|money|bool|boolean|json|blob|bytea|array|struct|map)/i;

interface Candidate {
  from: DiscoveredEntity;
  to: DiscoveredEntity;
  fromRelation: WarehouseCatalogRelationV1;
  toRelation: WarehouseCatalogRelationV1;
  keys: Array<{ from: string; to: string }>;
  role?: string;
}

/**
 * Draft the joins row identities imply, check each on the warehouse, and
 * drop the joins that touch a look-alike. Counting statements only.
 */
export async function draftIdentityJoins(
  report: WarehouseDiscoveryReport,
  snapshot: WarehouseCatalogSnapshotV1,
  run: Run,
  quote: (identifier: string) => string,
  options: { dialect?: string; readable?: (relation: WarehouseCatalogRelationV1) => boolean; maxCandidates?: number } = {},
): Promise<WarehouseDiscoveryReport> {
  const relationById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const vocabulary = columnVocabulary(snapshot.relations);
  const relationIdOf = new Map(report.entities.map((entity) => [`${entity.domain}::${entity.id}`, entity.relationId]));
  const entityByRelation = new Map(report.entities.map((entity) => [entity.relationId, entity]));

  // 1. A join to a look-alike points at the wrong table: the pick holds its rows.
  const lookAlikeOf = (relationship: DiscoveredRelationship) => [`${relationship.fromDomain}::${relationship.from}`, `${relationship.toDomain}::${relationship.to}`]
    .map((key) => entityByRelation.get(relationIdOf.get(key) ?? ''))
    .find((entity) => entity?.useInstead);
  const leftOut: LookAlikeJoin[] = [];
  const relationships: DiscoveredRelationship[] = [];
  for (const relationship of report.relationships) {
    const lookAlike = lookAlikeOf(relationship);
    if (lookAlike) leftOut.push({ from: relationship.from, to: relationship.to, keys: relationship.keys, reason: `joins ${lookAlike.relation.split('.').pop()}, and the draft says to use ${lookAlike.useInstead!.relation.split('.').pop()} instead` });
    else relationships.push(relationship);
  }
  // A join the model already has, or a reviewer removed or rejected, is not proposed again.
  const settled = new Set([...(report.modeledJoins ?? []), ...(report.dismissedJoins ?? [])]);
  const bySignature = new Map<string, DiscoveredRelationship>();
  for (const relationship of relationships) {
    const from = relationIdOf.get(`${relationship.fromDomain}::${relationship.from}`);
    const to = relationIdOf.get(`${relationship.toDomain}::${relationship.to}`);
    if (!from || !to) continue;
    bySignature.set(joinSignature(from, to, relationship.keys), relationship);
    bySignature.set(joinSignature(to, from, relationship.keys.map((pair) => ({ from: pair.to, to: pair.from }))), relationship);
  }

  // 2. Every table a row identity names. A target's identity holds a key
  // (not only periods) and repeats on almost no rows.
  const kept = report.entities.filter((entity) => !entity.useInstead && relationById.has(entity.relationId) && (options.readable?.(relationById.get(entity.relationId)!) ?? true));
  const targets = kept.filter((entity) => entity.identity
    && entity.identity.columns.length <= 3
    && entity.identity.columns.some((column) => KEY_LIKE_NAME.test(column))
    && entity.identity.duplicates <= entity.identity.rows * MAX_TARGET_REPEATS);
  const candidates: Candidate[] = [];
  for (const from of kept) {
    const fromRelation = relationById.get(from.relationId)!;
    for (const to of targets) {
      const toRelation = relationById.get(to.relationId)!;
      const options = to.identity!.columns.map((key) => columnsFor(key, toRelation, fromRelation, vocabulary));
      if (options.some((list) => list.length === 0)) continue;
      const mappings = product(options).filter((mapping) => new Set(mapping.map((item) => item.column.toLowerCase())).size === mapping.length);
      for (const mapping of mappings) {
        const roles = mapping.filter((item) => item.role);
        // The table itself, on its own identity, is no join.
        if (from === to && roles.length === 0) continue;
        // One role per join. On a key of several columns, a role is drafted
        // only on the table itself (the opponent's line of the same game):
        // elsewhere it is a second way to rows the same names already reach,
        // or a path through another join (a game's home team's line).
        if (roles.length > 1 || (roles.length === 1 && mapping.length > 1 && from !== to)) continue;
        candidates.push({ from, to, fromRelation, toRelation, keys: mapping.map((item, index) => ({ from: item.column, to: to.identity!.columns[index]! })), ...(roles[0] ? { role: roles[0].role } : {}) });
      }
    }
  }

  // 3. Check each on the warehouse: the referencing values are there.
  const typesOf = new Map(snapshot.relations.map((relation) => [relation.relation, new Map(relation.columns.map((column) => [column.name.toLowerCase(), column.type?.toLowerCase()]))]));
  const ids = new Map<string, Set<string>>();
  for (const relationship of relationships) ids.set(relationship.domain, new Set([...(ids.get(relationship.domain) ?? []), relationship.id]));
  const added: DiscoveredRelationship[] = [];
  const withheld: WithheldRelationship[] = [...(report.withheld ?? [])];
  const columnsOf = new Map(snapshot.relations.map((relation) => [relation.relation, relation.columns]));
  for (const candidate of candidates.slice(0, options.maxCandidates ?? 300)) {
    const signature = joinSignature(candidate.from.relationId, candidate.to.relationId, candidate.keys);
    const reverse = joinSignature(candidate.to.relationId, candidate.from.relationId, candidate.keys.map((pair) => ({ from: pair.to, to: pair.from })));
    if (settled.has(signature) || settled.has(reverse)) continue;
    const fromText = candidate.fromRelation.name;
    const toText = candidate.toRelation.name;
    const identity = candidate.to.identity!;
    let evidence;
    try {
      const keyTypes = candidate.keys.map((pair) => ({ from: typesOf.get(candidate.fromRelation.relation)?.get(pair.from.toLowerCase()), to: typesOf.get(candidate.toRelation.relation)?.get(pair.to.toLowerCase()) }));
      evidence = await profileRelationshipOnWarehouse({ fromRelation: candidate.fromRelation.relation, toRelation: candidate.toRelation.relation, keys: candidate.keys, keyTypes }, (sql) => run(sql, { sample: [candidate.fromRelation.relation] }), quote, new Date(), options.dialect);
    } catch {
      continue;
    }
    const validation = evidence.evidence;
    const keyed = validation.fromRows - validation.fromNullKeys;
    const unmatched = validation.unmatchedKeyedFrom ?? validation.unmatchedFrom;
    if (!(keyed > 0) || unmatched > keyed * MAX_UNMATCHED_SHARE || looksLikePlaceholder({ ...validation, keyedFrom: keyed })) continue;
    const reason = `${toText} is one row per ${identity.columns.join(', ')}${identity.duplicates ? ` (${identity.duplicates.toLocaleString('en-US')} rows repeat)` : ''}, and ${(keyed - unmatched).toLocaleString('en-US')} of ${keyed.toLocaleString('en-US')} ${fromText} rows find their ${candidate.keys.map((pair) => pair.from).join(', ')} there${candidate.role ? ` (as the ${candidate.role.replace(/_/g, ' ')})` : ''}`;
    const known = bySignature.get(signature);
    if (known) {
      if (!known.evidence.some((item) => item.source === 'row_identity')) known.evidence.push({ source: 'row_identity', reason });
      // A join drafted from a name and never checked takes this check.
      if (!known.validation) Object.assign(known, { cardinality: evidence.proposed.cardinality, fanout: evidence.proposed.fanout, validation });
      continue;
    }
    const taken = ids.get(candidate.from.domain) ?? new Set<string>();
    ids.set(candidate.from.domain, taken);
    let id = slug(`${candidate.from.id}_to_${candidate.role ? `${candidate.role}_` : ''}${candidate.to.id}`);
    if (taken.has(id)) id = slug(`${id}_by_${candidate.keys.map((pair) => pair.from).join('_')}`);
    taken.add(id);
    const drafted: DiscoveredRelationship = {
      id,
      domain: candidate.from.domain,
      from: candidate.from.id,
      to: candidate.to.id,
      fromDomain: candidate.from.domain,
      toDomain: candidate.to.domain,
      fromRelation: candidate.fromRelation.relation,
      toRelation: candidate.toRelation.relation,
      keys: candidate.keys,
      evidence: [{ source: 'row_identity', reason }],
      cardinality: evidence.proposed.cardinality,
      fanout: evidence.proposed.fanout,
      validation,
    };
    // Two tables that number their own rows 1, 2, 3 match by coincidence: the
    // joined rows must agree on the other references both tables carry.
    const objection = validation.status === 'passed' ? await nameOnlyObjection(drafted, columnsOf, (sql) => run(sql, { sample: [drafted.fromRelation] }), quote).catch(() => undefined) : undefined;
    if (objection) {
      withheld.push({ ...drafted, reason: objection.replace(/^only the column name suggests it, and /, '') });
      continue;
    }
    const relationship = drafted;
    bySignature.set(signature, relationship);
    bySignature.set(joinSignature(candidate.to.relationId, candidate.from.relationId, candidate.keys.map((pair) => ({ from: pair.to, to: pair.from }))), relationship);
    added.push(relationship);
  }
  return {
    ...report,
    relationships: [...relationships, ...added],
    ...(withheld.length ? { withheld } : {}),
    ...(leftOut.length ? { lookAlikeJoins: leftOut } : {}),
  };
}

/**
 * The columns of `from` that can hold `key` of `to`: the same name once
 * made comparable (`details_game_id` for `game_id`, `season` for
 * `season_id`), or a role, a prefix that names no table (`opponent_team_id`,
 * `home_team_id` for `team_id`).
 */
function columnsFor(
  key: string,
  to: WarehouseCatalogRelationV1,
  from: WarehouseCatalogRelationV1,
  vocabulary: ReturnType<typeof columnVocabulary>,
): Array<{ column: string; role?: string }> {
  const keyName = canonicalColumn(key, vocabulary, to.name);
  const suffixes = [...new Set([key.toLowerCase(), keyName, keyName.endsWith('_id') ? keyName : `${keyName}_id`])];
  const found: Array<{ column: string; role?: string }> = [];
  for (const column of from.columns) {
    if (column.type && MEASURE_TYPE.test(column.type.trim())) continue;
    const lower = column.name.toLowerCase();
    if (canonicalColumn(column.name, vocabulary, from.name) === keyName) {
      found.push({ column: column.name });
      continue;
    }
    const suffix = suffixes.find((item) => lower.endsWith(`_${item}`) && lower.length > item.length + 1);
    if (!suffix) continue;
    const role = lower.slice(0, -(suffix.length + 1));
    if (role.split('_').every((word) => vocabulary.tableWords.has(word))) continue;
    found.push({ column: column.name, role });
  }
  return found;
}

function product<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((rows, list) => rows.flatMap((row) => list.map((item) => [...row, item])), [[]]);
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned || 'relationship'}`;
}
