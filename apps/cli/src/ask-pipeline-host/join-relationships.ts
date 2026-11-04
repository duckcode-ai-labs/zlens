import { assessAnalyticalRelationship } from '@zlens/agent';
import type { DQLManifest } from '@zlens/core';
import { normalizeRelationName } from './vocabulary-source.js';

/**
 * MODELING RELATIONSHIPS MEET AI-WRITTEN SQL.
 *
 * Joins over tables stay the AI's to write (owner direction, 178eeeb0). What
 * a person certified in Modeling still binds it: when the statement joins two
 * tables a certified relationship connects, it must join them on exactly the
 * certified keys. Every join the statement makes is also recorded with the
 * relationship behind it (or none), so the answer can say how its tables were
 * joined and offer to save an undeclared join as a relationship.
 */

export type RelationshipJoinLevel = 'certified' | 'validated' | 'draft' | 'stale';

export interface ModelingRelationshipEdge {
  relationshipId: string;
  name: string;
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  level: RelationshipJoinLevel;
  cardinality: string;
}

const LEVEL_RANK: Record<RelationshipJoinLevel, number> = { certified: 3, validated: 2, stale: 1, draft: 0 };

/** The table each modeled entity is bound to, under every name the entity goes by. */
function entityRelations(manifest: DQLManifest | undefined): Map<string, string> {
  const relationOf = new Map<string, string>();
  for (const [recordKey, entity] of Object.entries(manifest?.modeling?.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    for (const key of [recordKey, entity.id, entity.localId, entity.qualifiedId]) if (key) relationOf.set(key, relation);
  }
  return relationOf;
}

/**
 * The two tables each modeled relationship joins, a table joined to itself
 * included, under its qualified id and its local id. A local id two domains
 * share maps to null: which tables it means can't be told from it alone.
 */
export function modelingRelationshipTables(manifest: DQLManifest | undefined): Map<string, { from: string; to: string } | null> {
  const relationOf = entityRelations(manifest);
  const tables = new Map<string, { from: string; to: string } | null>();
  for (const [recordKey, relationship] of Object.entries(manifest?.modeling?.relationships ?? {})) {
    const from = relationOf.get(relationship.from);
    const to = relationOf.get(relationship.to);
    if (!from || !to) continue;
    for (const key of new Set([recordKey, relationship.id, relationship.qualifiedId].filter((item): item is string => Boolean(item)))) tables.set(key, { from, to });
    if (relationship.localId) {
      const seen = tables.get(relationship.localId);
      tables.set(relationship.localId, seen === undefined || (seen && seen.from === from && seen.to === to) ? { from, to } : null);
    }
  }
  return tables;
}

/** Every relationship on the map as an edge between warehouse relations, with what Ask may do with it. */
export function modelingRelationshipEdges(manifest: DQLManifest | undefined): ModelingRelationshipEdge[] {
  const modeling = manifest?.modeling;
  if (!modeling) return [];
  const relationOf = entityRelations(manifest);
  const edges: ModelingRelationshipEdge[] = [];
  for (const relationship of Object.values(modeling.relationships ?? {})) {
    if (relationship.status === 'deprecated' || relationship.keys.length === 0) continue;
    const fromRelation = relationOf.get(relationship.from);
    const toRelation = relationOf.get(relationship.to);
    if (!fromRelation || !toRelation || fromRelation === toRelation) continue;
    const level: RelationshipJoinLevel = assessAnalyticalRelationship(relationship, manifest).executable
      ? 'certified'
      : relationship.status === 'certified'
        ? 'stale'
        : relationship.validation?.status === 'passed' && relationship.status !== 'draft' ? 'validated' : 'draft';
    edges.push({ relationshipId: relationship.qualifiedId ?? relationship.id, name: relationship.localId ?? relationship.id, fromRelation, toRelation, keys: relationship.keys, level, cardinality: relationship.cardinality });
  }
  return edges;
}

/**
 * What the team wrote about each modeled table: the entity's business name and
 * context. "The agent who sold the policy" is often said only here, about a
 * bridge whose columns are an id and a role code.
 */
export function modelingEntityTexts(manifest: DQLManifest | undefined): Array<{ relation: string; text: string }> {
  const out: Array<{ relation: string; text: string }> = [];
  for (const entity of Object.values(manifest?.modeling?.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    const text = [entity.businessName, entity.businessContext].filter(Boolean).join(' ');
    if (relation && text) out.push({ relation, text });
  }
  return out;
}

/** Two spellings of a relation agree on schema and table; a bare table name matches on the table alone. */
export function sameRelation(left: string, right: string): boolean {
  const a = normalizeRelationName(left)?.toLowerCase();
  const b = normalizeRelationName(right)?.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes('.') && b.includes('.')) return false;
  return a.split('.').pop() === b.split('.').pop();
}

export interface SqlJoinPair { left: { relation: string; column: string }; right: { relation: string; column: string } }

export interface SqlJoinUse {
  relations: [string, string];
  /** The key pairs the statement joins on, oriented `relations[0]` → `relations[1]`. */
  keys: Array<{ from: string; to: string }>;
  /** The strongest relationship between the two relations, if any. */
  relationship?: ModelingRelationshipEdge;
  /** Its keys oriented like `keys`. */
  relationshipKeys?: Array<{ from: string; to: string }>;
  /** The statement joins on exactly the relationship's keys. */
  matchesRelationship: boolean;
}

const bare = (column: string) => column.replace(/["`\[\]]/g, '').toLowerCase();
const pairKey = (pair: { from: string; to: string }) => `${bare(pair.from)}=${bare(pair.to)}`;

/** The statement's joins, one per pair of relations, each with the relationship that connects them. */
export function classifySqlJoins(pairs: SqlJoinPair[], edges: ModelingRelationshipEdge[]): SqlJoinUse[] {
  const uses: SqlJoinUse[] = [];
  for (const pair of pairs) {
    let use = uses.find((item) => (sameRelation(item.relations[0], pair.left.relation) && sameRelation(item.relations[1], pair.right.relation))
      || (sameRelation(item.relations[0], pair.right.relation) && sameRelation(item.relations[1], pair.left.relation)));
    if (!use) {
      use = { relations: [pair.left.relation, pair.right.relation], keys: [], matchesRelationship: false };
      uses.push(use);
    }
    const forward = sameRelation(use.relations[0], pair.left.relation);
    const key = forward ? { from: pair.left.column, to: pair.right.column } : { from: pair.right.column, to: pair.left.column };
    if (!use.keys.some((existing) => pairKey(existing) === pairKey(key))) use.keys.push(key);
  }
  for (const use of uses) {
    const candidates = edges
      .map((edge) => sameRelation(edge.fromRelation, use.relations[0]) && sameRelation(edge.toRelation, use.relations[1])
        ? { edge, keys: edge.keys }
        : sameRelation(edge.fromRelation, use.relations[1]) && sameRelation(edge.toRelation, use.relations[0])
          ? { edge, keys: edge.keys.map((key) => ({ from: key.to, to: key.from })) }
          : undefined)
      .filter((item): item is { edge: ModelingRelationshipEdge; keys: Array<{ from: string; to: string }> } => Boolean(item));
    const matching = candidates.filter((candidate) => sameKeys(candidate.keys, use.keys));
    const best = (matching.length ? matching : candidates).sort((a, b) => LEVEL_RANK[b.edge.level] - LEVEL_RANK[a.edge.level])[0];
    if (!best) continue;
    use.relationship = best.edge;
    use.relationshipKeys = best.keys;
    use.matchesRelationship = matching.includes(best);
  }
  return uses;
}

function sameKeys(declared: Array<{ from: string; to: string }>, used: Array<{ from: string; to: string }>): boolean {
  const wanted = new Set(declared.map(pairKey));
  // A statement's parser reads the first equality of each ON clause, so a
  // multi-key join can show fewer pairs than it has: every pair read must be
  // declared, and at least one must be read.
  return used.length > 0 && used.every((key) => wanted.has(pairKey(key)));
}

/** Whether the statement text joins on a key pair, in either order and with any qualifiers. */
function joinsOn(sql: string, key: { from: string; to: string }): boolean {
  const escape = (value: string) => bare(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const side = (column: string) => `(?:[\\w$"\`\\[\\]]+\\.)*["\`\\[]?${escape(column)}["\`\\]]?`;
  return new RegExp(`${side(key.from)}\\s*=\\s*${side(key.to)}|${side(key.to)}\\s*=\\s*${side(key.from)}`, 'i').test(sql);
}

/**
 * A certified relationship's keys are the only way to join its two relations.
 * Returns one plain-language failure per certified relationship the statement
 * joins on other keys, or on only part of a multi-key relationship.
 */
export function certifiedJoinViolations(sql: string, uses: SqlJoinUse[]): string[] {
  return uses.flatMap((use) => {
    if (use.relationship?.level !== 'certified' || !use.relationshipKeys) return [];
    const complete = use.matchesRelationship && use.relationshipKeys.every((key) => joinsOn(sql, key));
    if (complete) return [];
    const [left, right] = use.relations;
    const show = (keys: Array<{ from: string; to: string }>) => keys.map((key) => `${left}.${key.from} = ${right}.${key.to}`).join(' AND ');
    return [`it joins ${left} and ${right} on ${show(use.keys)}, but the certified relationship ${use.relationship.name} joins them on ${show(use.relationshipKeys)}; join on exactly those keys`];
  });
}

/**
 * The relations a fact relation reaches without multiplying its rows: the
 * "one" side of a validated or certified relationship. Research breaks a
 * change down by their columns too, and the join it needs is one a person
 * checked in the warehouse.
 */
export function joinableRelations(edges: ModelingRelationshipEdge[], relations: string[]): string[] {
  const reached: string[] = [];
  const add = (relation: string) => {
    if (!relations.some((known) => sameRelation(known, relation)) && !reached.some((known) => sameRelation(known, relation))) reached.push(relation);
  };
  for (const edge of edges) {
    if (edge.level !== 'certified' && edge.level !== 'validated') continue;
    for (const relation of relations) {
      if ((edge.cardinality === 'many_to_one' || edge.cardinality === 'one_to_one') && sameRelation(edge.fromRelation, relation)) add(edge.toRelation);
      if ((edge.cardinality === 'one_to_many' || edge.cardinality === 'one_to_one') && sameRelation(edge.toRelation, relation)) add(edge.fromRelation);
    }
  }
  return reached;
}

export interface LedgerJoin {
  source: 'dql_relationship' | 'ai_sql';
  relationshipId?: string;
  name?: string;
  authority: RelationshipJoinLevel | 'none';
  relations: string[];
  keys: Array<{ from: string; to: string }>;
}

/** What the receipt records for each join: the relationship it followed, or that the AI joined without one. */
export function ledgerJoins(uses: SqlJoinUse[]): LedgerJoin[] {
  return uses.map((use) => (use.relationship && use.matchesRelationship
    ? { source: 'dql_relationship', relationshipId: use.relationship.relationshipId, name: use.relationship.name, authority: use.relationship.level, relations: [...use.relations], keys: use.keys }
    : { source: 'ai_sql', authority: 'none', relations: [...use.relations], keys: use.keys, ...(use.relationship ? { relationshipId: use.relationship.relationshipId, name: use.relationship.name } : {}) }));
}

/** A path of modeled relationships that connects two chosen tables. */
export interface ModeledJoinPath {
  between: [string, string];
  /** Edges in walking order; `edge.fromRelation`/`toRelation` keep the relationship's own direction. */
  edges: ModelingRelationshipEdge[];
  /** Tables on the path that were not chosen. */
  through: string[];
}

// A certified hop is the cheapest; a draft hop is allowed but costs more than
// a three-hop certified route, so certified knowledge wins whenever it reaches
// within the hop limit. A stale certification counts as a draft.
const HOP_COST: Record<RelationshipJoinLevel, number> = { certified: 1, validated: 1.5, stale: 3.5, draft: 3.5 };
// A route that climbs to a table and comes back down (claim -> insurable object
// <- coverage detail) relates the two ends only by a parent they share: every
// claim on an object meets every coverage on it. It is kept as a last resort,
// costlier than any route of direct links.
const SHARED_PARENT_COST = 10;

/** Walking an edge toward its "one" side climbs; toward its "many" side descends. */
function stepDirection(edge: ModelingRelationshipEdge, forward: boolean): 'up' | 'down' | 'level' {
  const cardinality = edge.cardinality.toLowerCase();
  if (cardinality === 'one_to_one') return 'level';
  if (cardinality === 'many_to_one') return forward ? 'up' : 'down';
  if (cardinality === 'one_to_many') return forward ? 'down' : 'up';
  if (cardinality === 'many_to_many') return 'down';
  return 'level';
}

/**
 * THE TABLES BETWEEN. A question names the tables it is about (claims,
 * policies); the tables that connect them (a coverage bridge) are rarely named,
 * so an AI drafting SQL over only the named tables finds "no column links
 * claim to policy" although the team modeled exactly that link. For every pair
 * of chosen tables, the cheapest route over the Modeling map (certified hops
 * preferred, at most `maxHops`) is found; its intermediate tables are added
 * (at most `maxAdded`, cheapest routes first) and its hops become join hints.
 * Nothing here is a gate: the AI still chooses the joins, and certified keys
 * still bind any join it makes (`certifiedJoinViolations`).
 */
export function modeledJoinPaths(
  chosen: string[],
  edges: ModelingRelationshipEdge[],
  options: { maxHops?: number; maxAdded?: number } = {},
): { paths: ModeledJoinPath[]; added: string[] } {
  const maxHops = options.maxHops ?? 3;
  const maxAdded = options.maxAdded ?? 4;
  const nodeOf = (relation: string): string | undefined => {
    for (const edge of edges) {
      if (sameRelation(edge.fromRelation, relation)) return edge.fromRelation;
      if (sameRelation(edge.toRelation, relation)) return edge.toRelation;
    }
    return undefined;
  };
  const neighbours = new Map<string, Array<{ to: string; edge: ModelingRelationshipEdge }>>();
  const link = (from: string, to: string, edge: ModelingRelationshipEdge) => {
    if (!neighbours.has(from)) neighbours.set(from, []);
    neighbours.get(from)!.push({ to, edge });
  };
  for (const edge of edges) {
    link(edge.fromRelation, edge.toRelation, edge);
    link(edge.toRelation, edge.fromRelation, edge);
  }
  const chosenNodes = [...new Set(chosen.map(nodeOf).filter((node): node is string => Boolean(node)))];
  const isChosen = (node: string) => chosenNodes.includes(node);

  const cheapest = (start: string, goal: string) => cheapestRoute(start, goal, neighbours, maxHops, (node) => node !== goal && isChosen(node));

  const routes: Array<{ cost: number; path: ModeledJoinPath }> = [];
  for (let i = 0; i < chosenNodes.length; i += 1) {
    for (let j = i + 1; j < chosenNodes.length; j += 1) {
      const route = cheapest(chosenNodes[i]!, chosenNodes[j]!);
      if (!route) continue;
      routes.push({ cost: route.cost, path: { between: [chosenNodes[i]!, chosenNodes[j]!], edges: route.edges, through: route.nodes.slice(1, -1) } });
    }
  }
  routes.sort((a, b) => a.cost - b.cost);
  const added: string[] = [];
  const paths: ModeledJoinPath[] = [];
  for (const { path } of routes) {
    const fresh = path.through.filter((node) => !added.includes(node));
    if (added.length + fresh.length > maxAdded) continue;
    added.push(...fresh);
    paths.push(path);
  }
  return { paths, added };
}

type Neighbours = Map<string, Array<{ to: string; edge: ModelingRelationshipEdge }>>;

/**
 * Dijkstra over a small graph; ties keep the first-declared relationship. The
 * search state is the table and whether the route has climbed yet, so a route
 * that climbs and then descends pays SHARED_PARENT_COST and loses to any route
 * of direct links that reaches.
 */
function cheapestRoute(start: string, goal: string, neighbours: Neighbours, maxHops: number, blocked: (node: string) => boolean): { cost: number; nodes: string[]; edges: ModelingRelationshipEdge[]; sharedParent: boolean } | undefined {
  type Here = { node: string; climbed: boolean; cost: number; hops: number; nodes: string[]; edges: ModelingRelationshipEdge[]; sharedParent: boolean };
  const keyOf = (node: string, climbed: boolean) => `${node}|${climbed ? 1 : 0}`;
  const best = new Map<string, Here>([[keyOf(start, false), { node: start, climbed: false, cost: 0, hops: 0, nodes: [start], edges: [], sharedParent: false }]]);
  const open = [keyOf(start, false)];
  while (open.length > 0) {
    open.sort((a, b) => best.get(a)!.cost - best.get(b)!.cost);
    const here = best.get(open.shift()!)!;
    if (here.node === goal) return { cost: here.cost, nodes: here.nodes, edges: here.edges, sharedParent: here.sharedParent };
    if (here.hops >= maxHops) continue;
    for (const { to, edge } of neighbours.get(here.node) ?? []) {
      // A route runs through tables nobody chose; it never detours through another chosen table.
      if (blocked(to)) continue;
      if (here.nodes.includes(to)) continue;
      const direction = stepDirection(edge, edge.fromRelation === here.node);
      const descendsAfterClimb = here.climbed && direction === 'down';
      const cost = here.cost + HOP_COST[edge.level] + (descendsAfterClimb ? SHARED_PARENT_COST : 0);
      const climbed = here.climbed || direction === 'up';
      const key = keyOf(to, climbed);
      const known = best.get(key);
      if (known && known.cost <= cost) continue;
      best.set(key, { node: to, climbed, cost, hops: here.hops + 1, nodes: [...here.nodes, to], edges: [...here.edges, edge], sharedParent: here.sharedParent || descendsAfterClimb });
      if (!open.includes(key)) open.push(key);
    }
  }
  return undefined;
}

/**
 * SHARED-PARENT SHORTCUTS. Two tables that both only reference a third (a
 * claim and a coverage detail each name the insured object) are not linked by
 * it: joined through it, or on the two references directly, every claim on
 * an object meets every coverage on it, and totals land on coverages the claim
 * was never made against. When the Modeling map connects the two tables by a
 * route of certified or validated direct links, the statement must follow
 * that route. One plain-language failure per such join; none when the shared
 * parent is the only modeled connection (then it is what the team modeled).
 */
export function sharedParentShortcuts(uses: SqlJoinUse[], edges: ModelingRelationshipEdge[]): string[] {
  // The parents a table references, with the columns it references them by.
  const upTo = (relation: string) => edges.flatMap((edge) => {
    const cardinality = edge.cardinality.toLowerCase();
    if (cardinality === 'many_to_one' && sameRelation(edge.fromRelation, relation)) return [{ parent: edge.toRelation, columns: new Set(edge.keys.map((key) => bare(key.from))) }];
    if (cardinality === 'one_to_many' && sameRelation(edge.toRelation, relation)) return [{ parent: edge.fromRelation, columns: new Set(edge.keys.map((key) => bare(key.to))) }];
    return [];
  });
  const shortcuts: Array<{ left: string; right: string; parent: string }> = [];
  const note = (left: string, right: string, parent: string) => {
    if (sameRelation(left, right)) return;
    if (!shortcuts.some((item) => (sameRelation(item.left, left) && sameRelation(item.right, right)) || (sameRelation(item.left, right) && sameRelation(item.right, left)))) shortcuts.push({ left, right, parent });
  };
  // On the two references directly: left.ref = right.ref, both keys of one parent.
  for (const use of uses) {
    if (use.matchesRelationship) continue;
    const [left, right] = use.relations;
    for (const leftParent of upTo(left)) {
      for (const rightParent of upTo(right)) {
        if (!sameRelation(leftParent.parent, rightParent.parent)) continue;
        if (use.keys.some((key) => leftParent.columns.has(bare(key.from)) && rightParent.columns.has(bare(key.to)))) note(left, right, leftParent.parent);
      }
    }
  }
  // Through the parent itself: left -> parent <- right, each on its own reference.
  const climbs = uses.flatMap((use) => {
    const cardinality = use.relationship?.cardinality.toLowerCase();
    if (!use.matchesRelationship || !use.relationship) return [];
    if (cardinality === 'many_to_one') return [{ child: use.relationship.fromRelation, parent: use.relationship.toRelation, relations: use.relations }];
    if (cardinality === 'one_to_many') return [{ child: use.relationship.toRelation, parent: use.relationship.fromRelation, relations: use.relations }];
    return [];
  });
  for (let i = 0; i < climbs.length; i += 1) {
    for (let j = i + 1; j < climbs.length; j += 1) {
      if (sameRelation(climbs[i]!.parent, climbs[j]!.parent)) note(climbs[i]!.relations.find((relation) => sameRelation(relation, climbs[i]!.child)) ?? climbs[i]!.child, climbs[j]!.relations.find((relation) => sameRelation(relation, climbs[j]!.child)) ?? climbs[j]!.child, climbs[i]!.parent);
    }
  }
  if (shortcuts.length === 0) return [];
  const neighbours: Neighbours = new Map();
  for (const edge of edges) {
    if (edge.level !== 'certified' && edge.level !== 'validated') continue;
    if (!neighbours.has(edge.fromRelation)) neighbours.set(edge.fromRelation, []);
    if (!neighbours.has(edge.toRelation)) neighbours.set(edge.toRelation, []);
    neighbours.get(edge.fromRelation)!.push({ to: edge.toRelation, edge });
    neighbours.get(edge.toRelation)!.push({ to: edge.fromRelation, edge });
  }
  const nodeOf = (relation: string) => [...neighbours.keys()].find((node) => sameRelation(node, relation));
  return shortcuts.flatMap(({ left, right, parent }) => {
    const start = nodeOf(left);
    const goal = nodeOf(right);
    if (!start || !goal) return [];
    const route = cheapestRoute(start, goal, neighbours, 3, () => false);
    if (!route || route.sharedParent) return [];
    const name = (relation: string) => relation.split('.').pop()!.replace(/["`\[\]]/g, '');
    const shown = route.nodes.map(name).join(' -> ');
    return [`it relates ${name(left)} to ${name(right)} through ${name(parent)}, which both only reference, so each ${name(left)} row meets every ${name(right)} row of the same ${name(parent)}; the Modeling map connects them as ${shown}: join along that route`];
  });
}

/** A table that only marks rows of another: it holds nothing but the one-to-one key. */
export interface MarkerTable {
  marker: string;
  base: string;
  /** Key pairs oriented marker → base. */
  keys: Array<{ from: string; to: string }>;
  relationshipName: string;
}

/**
 * MARKER TABLES. A modeled one-to-one relationship whose one side has no
 * column besides its key (a `premium` table holding only a policy amount id)
 * says that side is a kind of the other: its rows mark which base rows belong
 * to it, and the values live on the base. An AI drafting SQL over the marker
 * alone finds "no amount column" and stops; told what the marker means, it
 * joins the base to it and uses the base's values.
 */
export function markerTables(
  relations: string[],
  edges: ModelingRelationshipEdge[],
  columnsOf: (relation: string) => string[],
): MarkerTable[] {
  const found: MarkerTable[] = [];
  const onlyKeys = (relation: string, keys: string[]) => {
    const columns = columnsOf(relation).map((column) => column.toLowerCase());
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    return columns.length > 0 && columns.every((column) => wanted.has(column));
  };
  for (const edge of edges) {
    if (edge.cardinality !== 'one_to_one') continue;
    const sides: Array<[string, string, Array<{ from: string; to: string }>]> = [
      [edge.fromRelation, edge.toRelation, edge.keys],
      [edge.toRelation, edge.fromRelation, edge.keys.map((key) => ({ from: key.to, to: key.from }))],
    ];
    for (const [marker, base, keys] of sides) {
      const chosen = relations.find((relation) => sameRelation(relation, marker));
      if (!chosen) continue;
      if (!onlyKeys(chosen, keys.map((key) => key.from))) continue;
      // A base that is itself only keys marks nothing; skip a key-only pair.
      const baseChosen = relations.find((relation) => sameRelation(relation, base));
      if (baseChosen && onlyKeys(baseChosen, keys.map((key) => key.to))) continue;
      if (found.some((item) => sameRelation(item.marker, marker) && sameRelation(item.base, base))) continue;
      found.push({ marker: chosen, base: baseChosen ?? base, keys, relationshipName: edge.name });
    }
  }
  return found;
}

/** The line an AI drafting SQL reads for one marker table. */
export function markerTableLine(item: MarkerTable): string {
  const name = (relation: string) => relation.split('.').pop()!.replace(/"/g, '');
  const on = item.keys.map((key) => `${item.marker}.${key.from} = ${item.base}.${key.to}`).join(' AND ');
  return `- ${item.marker} holds no values of its own (only its key): a row in it marks the ${item.base} row with the same key as a ${name(item.marker).replace(/_/g, ' ')} (modeled one-to-one: ${item.relationshipName}). For "${name(item.marker).replace(/_/g, ' ')}" values, use the ${item.base} rows that have a matching ${item.marker} row (JOIN ${item.marker} ON ${on}); the values are the columns of ${item.base}.`;
}

/** A table whose rows people know by a business number, beside an internal key. */
export interface BusinessIdentifier { relation: string; key: string; identifier: string }

const nameTokens = (name: string) => name.replace(/"/g, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * BUSINESS IDENTIFIERS. Many tables carry an internal key (Policy_Identifier)
 * and a number people use (Policy_Number, Company_Claim_Number). An answer
 * that lists policies by the internal key alone is correct and useless to a
 * reader; which of the two a drafted statement showed varied from run to run.
 * Found from names alone: a key named after the table (<table>_id,
 * <table>_identifier) and exactly one other column named after the table that
 * ends in number, code or no. Nothing is emitted when that is ambiguous.
 */
export function businessIdentifiers(relations: string[], columnsOf: (relation: string) => string[]): BusinessIdentifier[] {
  const found: BusinessIdentifier[] = [];
  for (const relation of relations) {
    const table = nameTokens(relation.split('.').pop()!);
    if (table.length === 0) continue;
    const stem = table[table.length - 1]!;
    const columns = columnsOf(relation);
    const key = columns.find((column) => {
      const tokens = nameTokens(column);
      const last = tokens[tokens.length - 1];
      return (last === 'id' || last === 'identifier') && tokens.slice(0, -1).join('_') === table.join('_');
    });
    if (!key) continue;
    const candidates = columns.filter((column) => {
      if (column === key) return false;
      const tokens = nameTokens(column);
      const last = tokens[tokens.length - 1]!;
      return ['number', 'code', 'no', 'num'].includes(last) && tokens.slice(0, -1).includes(stem) && !tokens.some((token) => ['type', 'status', 'role', 'category', 'postal', 'zip'].includes(token));
    });
    if (candidates.length === 1) found.push({ relation, key, identifier: candidates[0]! });
  }
  return found;
}

/** The line an AI drafting SQL reads for one business identifier. */
export function businessIdentifierLine(item: BusinessIdentifier): string {
  const name = item.relation.split('.').pop()!.replace(/"/g, '');
  return `- ${name} rows are known to people by ${item.identifier}; ${item.key} is the internal key. When the answer lists or groups ${name} rows, show ${item.identifier} beside ${item.key}.`;
}
