import type { DomainDiscoveryReport, WarehouseCatalogRelationV1 } from '@zlens/core';
import type { DbtNode } from './dbt-model-discovery.js';
import { tableLayer, type DbtRelationFacts, type TableLayer } from './model-layers.js';

/**
 * Which tables one `zlens model draft` run drafts (model-at-scale design S3,
 * S4, decision S-D3). A large project is drafted a piece at a time: a scope
 * picks the tables, and a budget caps one run. Over the budget, the most
 * important tables are drafted and the rest are listed, never dropped
 * silently: business tables before staging and raw ones, then tables an
 * exposure uses, then tables many models read.
 *
 * `--select` takes dbt's own way of picking, one or more terms, any of which
 * may match:
 * - `fct_orders`, `fct_*`: a model, seed, snapshot or source table by name;
 * - `+fct_orders` / `fct_orders+`: with everything it reads / that reads it,
 *   and `2+fct_orders` / `fct_orders+1` for that many steps;
 * - `path:models/marts`, `tag:finance`, `schema:sales*`, `package:jaffle`,
 *   `source:stripe`;
 * - `domain:finance`, `area:sales`: the Domain or subject area the domain
 *   finder proposes. An area or domain brings the business tables its
 *   tables read, as the scope picker counts them ("46 tables, and 76 they
 *   read").
 */

export const DEFAULT_DRAFT_BUDGET = 150;

export interface DraftScopeOptions {
  select?: string[];
  /** Add the tables within this many lineage steps of the picked ones, both ways. */
  hops?: number;
  /** Tables drafted in one run (default 150). */
  budget?: number;
}

export interface DraftScopeLeftOut {
  uniqueId: string;
  relation: string;
  layer: TableLayer;
}

export interface DraftScope {
  /** What was asked, in words ("the whole project", "area:sales and the tables they read"). */
  description: string;
  /** Tables the scope named, before the budget. */
  asked: number;
  /** The dbt unique ids drafted. */
  ids: string[];
  budget: number;
  /** Named by the scope but over the budget, most important first. */
  leftOut: DraftScopeLeftOut[];
  /** The project's subject areas and Domains with their table counts, to pick from next. */
  areas: Array<{ id: string; tables: number }>;
}

export interface NodeFacts {
  node: DbtNode;
  name: string;
  path?: string;
  tags: string[];
  packageName?: string;
  sourceName?: string;
  resourceType?: string;
}

export interface DraftScopeInput {
  nodes: readonly DbtNode[];
  dbtManifest: Record<string, unknown>;
  facts: Map<string, DbtRelationFacts>;
  domains: DomainDiscoveryReport;
}

/** The project's tables as one graph: lineage, layer, rank tier and proposed area. Built once, read by every pick. */
export interface DraftScopeGraph {
  byId: Map<string, NodeFacts>;
  dbtFacts: Map<string, DbtRelationFacts>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  membership: Map<string, DomainDiscoveryReport['memberships'][number]>;
  layerOf: Map<string, TableLayer>;
  tierOf: Map<string, number>;
  /** The tables a business question is answered from: final tables outside team workspaces and legacy folders. */
  business: (id: string) => boolean;
}

export function draftScopeGraph(input: DraftScopeInput): DraftScopeGraph {
  const byId = new Map(input.nodes.map((node) => [node.uniqueId, nodeFacts(node, input.dbtManifest)]));
  // dbt's facts are keyed by relation; this reads them by unique id.
  const dbtFacts = new Map([...input.facts.values()].map((fact) => [fact.uniqueId, fact]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const id of byId.keys()) parents.set(id, [...new Set(dbtFacts.get(id)?.dependsOn ?? [])].filter((parent) => byId.has(parent) && parent !== id));
  for (const [id, ids] of parents) for (const parent of ids) children.set(parent, [...(children.get(parent) ?? []), id]);
  const membership = new Map(input.domains.memberships.map((item) => [item.dbtUniqueId, item]));
  const layerOf = new Map([...byId].map(([id, facts]) => [id, layerFor(facts, dbtFacts.get(id))]));
  const tierOf = new Map([...byId].map(([id, facts]) => [id, rankTier(facts, layerOf.get(id)!)]));
  return { byId, dbtFacts, parents, children, membership, layerOf, tierOf, business: (id) => tierOf.get(id)! <= 1 };
}

export function resolveDraftScope(input: DraftScopeInput | DraftScopeGraph, options: DraftScopeOptions = {}): DraftScope {
  const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : DEFAULT_DRAFT_BUDGET;
  const graph = 'byId' in input ? input : draftScopeGraph(input);
  const { byId, dbtFacts, parents, children, membership, layerOf, tierOf, business } = graph;

  const terms = (options.select ?? []).flatMap((value) => value.split(/[\s,]+/)).map((term) => term.trim()).filter(Boolean);
  let picked: Set<string>;
  if (terms.length === 0) {
    picked = new Set(byId.keys());
  } else {
    picked = new Set();
    for (const term of terms) for (const id of selectTerm(term, byId, parents, children, membership, business)) picked.add(id);
  }
  const hops = options.hops && options.hops > 0 ? Math.floor(options.hops) : 0;
  if (hops > 0) for (const id of walk([...picked], (id) => [...(parents.get(id) ?? []), ...(children.get(id) ?? [])], hops)) picked.add(id);

  const exposures = (id: string) => dbtFacts.get(id)?.exposures ?? 0;
  const readers = (id: string) => children.get(id)?.length ?? 0;
  const ranked = [...picked].sort((a, b) => tierOf.get(a)! - tierOf.get(b)!
    || exposures(b) - exposures(a)
    || readers(b) - readers(a)
    || byId.get(a)!.name.localeCompare(byId.get(b)!.name));
  const ids = ranked.slice(0, budget);
  const leftOut = ranked.slice(budget).map((id) => ({ uniqueId: id, relation: byId.get(id)!.node.relation, layer: layerOf.get(id)! }));

  const areaCounts = new Map<string, number>();
  for (const item of membership.values()) {
    if (!item.proposedDomain || !byId.has(item.dbtUniqueId) || !business(item.dbtUniqueId)) continue;
    const id = item.proposedArea ? `area:${item.proposedArea}` : `domain:${item.proposedDomain.split('.')[0]}`;
    areaCounts.set(id, (areaCounts.get(id) ?? 0) + 1);
  }
  return {
    description: terms.length === 0 ? 'the whole project' : `${terms.join(' ')}${hops ? ` and ${hops} step${hops === 1 ? '' : 's'} around` : ''}`,
    asked: picked.size,
    ids,
    budget,
    leftOut,
    areas: [...areaCounts].map(([id, tables]) => ({ id, tables })).sort((a, b) => b.tables - a.tables || a.id.localeCompare(b.id)),
  };
}

/** A table named for the business layer (`dim_`, `fct_`, `mart_`…). */
const BUSINESS_NAME = /^(dim|dims|fct|fact|facts|mart|rpt|agg|bdg|obt)_/i;
/** Folders of team copies and old tables: kept, but drafted after the business layer. */
const ASIDE_FOLDER = /(^|_)(legacy|workspaces?|sandbox|scratch|archive|archived|deprecated|tmp|temp)(_|$)/i;

/**
 * Most important first: business tables named for the layer, other final
 * tables, intermediate ones, team workspaces and legacy tables, snapshots,
 * staging, raw.
 */
function rankTier(facts: NodeFacts, layer: TableLayer): number {
  if (layer === 'raw') return 6;
  if (layer === 'staging') return 5;
  if (layer === 'snapshot') return 4;
  const folders = (facts.path ?? '').replace(/\\/g, '/').split('/').slice(0, -1);
  if (folders.some((folder) => ASIDE_FOLDER.test(folder)) || /^wk_/i.test(facts.name)) return 3;
  if (layer === 'intermediate') return 2;
  return BUSINESS_NAME.test(facts.name) || folders.some((folder) => /^marts?$/i.test(folder)) ? 0 : 1;
}

function nodeFacts(node: DbtNode, dbtManifest: Record<string, unknown>): NodeFacts {
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
  const raw = record(record(dbtManifest.nodes)[node.uniqueId] ?? record(dbtManifest.sources)[node.uniqueId]);
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const tags = [...(Array.isArray(raw.tags) ? raw.tags : []), ...(Array.isArray(record(raw.config).tags) ? record(raw.config).tags as unknown[] : [])]
    .filter((tag): tag is string => typeof tag === 'string');
  return {
    node,
    name: (node.relation.split('.').pop() ?? node.uniqueId).toLowerCase(),
    ...(text(raw.original_file_path) ? { path: text(raw.original_file_path) } : {}),
    tags: [...new Set(tags.map((tag) => tag.toLowerCase()))],
    ...(text(raw.package_name) ? { packageName: text(raw.package_name) } : {}),
    ...(text(raw.source_name) ? { sourceName: text(raw.source_name) } : {}),
    ...(text(raw.resource_type) ? { resourceType: text(raw.resource_type) } : {}),
  };
}

function layerFor(facts: NodeFacts, dbt: DbtRelationFacts | undefined): TableLayer {
  const relation: WarehouseCatalogRelationV1 = {
    id: facts.node.uniqueId,
    schema: facts.node.schema,
    name: facts.name,
    relation: facts.node.relation,
    kind: 'table',
    columns: [],
  };
  return tableLayer(relation, dbt ? { dbt } : {}).layer;
}

function selectTerm(
  term: string,
  byId: Map<string, NodeFacts>,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  membership: Map<string, DomainDiscoveryReport['memberships'][number]>,
  business: (id: string) => boolean,
): string[] {
  const method = term.match(/^(path|tag|schema|package|source|domain|area):(.+)$/i);
  if (method) {
    const kind = method[1]!.toLowerCase();
    const value = method[2]!;
    const matches = globMatcher(value.toLowerCase());
    const ids = [...byId].filter(([id, facts]) => {
      if (kind === 'path') return Boolean(facts.path && (facts.path.toLowerCase().startsWith(value.toLowerCase().replace(/\/?$/, '/')) || facts.path.toLowerCase() === value.toLowerCase() || matches(facts.path.toLowerCase())));
      if (kind === 'tag') return facts.tags.some(matches);
      if (kind === 'schema') return matches(facts.node.schema.toLowerCase());
      if (kind === 'package') return Boolean(facts.packageName && matches(facts.packageName.toLowerCase()));
      if (kind === 'source') return Boolean(facts.sourceName && matches(facts.sourceName.toLowerCase()));
      const item = membership.get(id);
      if (!item?.proposedDomain) return false;
      if (kind === 'domain') return matches(item.proposedDomain.split('.')[0]!.toLowerCase());
      return Boolean(item.proposedArea && (matches(item.proposedArea.toLowerCase()) || matches(`${item.proposedDomain}.${item.proposedArea}`.toLowerCase())));
    }).map(([id]) => id);
    // A Domain or subject area drafts its business tables, not its team
    // workspaces, legacy or staging tables (decision S-D2), and brings the
    // business tables they read.
    if (kind === 'domain' || kind === 'area') {
      const tables = ids.filter(business);
      return [...tables, ...walk(tables, (id) => (parents.get(id) ?? []).filter(business), Number.POSITIVE_INFINITY)];
    }
    return ids;
  }
  const graph = term.match(/^(\d*\+)?([^+]+)(\+\d*)?$/);
  if (!graph) return [];
  const [, up, name, down] = graph;
  const matches = globMatcher(name!.toLowerCase());
  const start = [...byId].filter(([, facts]) => matches(facts.name) || matches(facts.node.uniqueId.split('.').pop()!.toLowerCase())).map(([id]) => id);
  const steps = (operator: string | undefined, before: boolean) => {
    if (!operator) return 0;
    const digits = before ? operator.slice(0, -1) : operator.slice(1);
    return digits ? Number(digits) : Number.POSITIVE_INFINITY;
  };
  return [
    ...start,
    ...walk(start, (id) => parents.get(id) ?? [], steps(up, true)),
    ...walk(start, (id) => children.get(id) ?? [], steps(down, false)),
  ];
}

/** Every id within `steps` of the start along `next`, the start excluded. */
function walk(start: string[], next: (id: string) => string[], steps: number): string[] {
  const seen = new Set(start);
  const found: string[] = [];
  let frontier = start;
  for (let step = 0; step < steps && frontier.length > 0; step += 1) {
    const following: string[] = [];
    for (const id of frontier) {
      for (const neighbour of next(id)) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        found.push(neighbour);
        following.push(neighbour);
      }
    }
    frontier = following;
  }
  return found;
}

function globMatcher(pattern: string): (value: string) => boolean {
  if (!/[*?]/.test(pattern)) return (value) => value === pattern;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${source}$`);
  return (value) => regex.test(value);
}

/** What a person can pick from (model-at-scale design S3): the project's size by layer, and its Domains and areas with their tables. */
export interface DraftScopeChoices {
  tables: number;
  budget: number;
  layers: { business: number; intermediate: number; aside: number; snapshot: number; staging: number; raw: number };
  /** Domains, each followed by its areas, the Shared area first. `select` is the term that picks it. */
  areas: Array<{ select: string; domain: string; area?: string; shared?: boolean; tables: number; reads: number }>;
}

export function draftScopeChoices(graph: DraftScopeGraph, budget = DEFAULT_DRAFT_BUDGET): DraftScopeChoices {
  const layers = { business: 0, intermediate: 0, aside: 0, snapshot: 0, staging: 0, raw: 0 };
  const tierLayer: Array<keyof typeof layers> = ['business', 'business', 'intermediate', 'aside', 'snapshot', 'staging', 'raw'];
  for (const tier of graph.tierOf.values()) layers[tierLayer[tier] ?? 'raw'] += 1;
  const members = new Map<string, { domain: string; area?: string; ids: string[] }>();
  for (const [id, item] of graph.membership) {
    if (!item.proposedDomain || !graph.byId.has(id) || !graph.business(id)) continue;
    const domain = item.proposedDomain.split('.')[0]!;
    for (const key of [`domain:${domain}`, ...(item.proposedArea ? [`area:${item.proposedDomain}.${item.proposedArea}`] : [])]) {
      const entry = members.get(key) ?? { domain, ...(key.startsWith('area:') ? { area: item.proposedArea! } : {}), ids: [] };
      entry.ids.push(id);
      members.set(key, entry);
    }
  }
  const reads = (ids: string[]) => {
    const own = new Set(ids);
    return walk(ids, (id) => (graph.parents.get(id) ?? []).filter(graph.business), Number.POSITIVE_INFINITY).filter((id) => !own.has(id)).length;
  };
  const domainRows = [...members].filter(([key]) => key.startsWith('domain:'))
    .sort(([a, x], [b, y]) => Number(b === 'domain:shared') - Number(a === 'domain:shared') || y.ids.length - x.ids.length || a.localeCompare(b));
  const areas: DraftScopeChoices['areas'] = [];
  for (const [key, entry] of domainRows) {
    areas.push({ select: key, domain: entry.domain, ...(entry.domain === 'shared' ? { shared: true } : {}), tables: entry.ids.length, reads: reads(entry.ids) });
    const own = [...members].filter(([areaKey, area]) => areaKey.startsWith('area:') && area.domain === entry.domain)
      .sort(([a, x], [b, y]) => y.ids.length - x.ids.length || a.localeCompare(b));
    for (const [areaKey, area] of own) areas.push({ select: areaKey, domain: area.domain, area: area.area!, tables: area.ids.length, reads: reads(area.ids) });
  }
  return { tables: graph.byId.size, budget, layers, areas };
}

export interface DraftTableMatch {
  id: string;
  name: string;
  relation: string;
  layer: TableLayer;
  business: boolean;
  domain?: string;
  area?: string;
  /** Models that read it. */
  readers: number;
}

/** Tables to start a draft from, by name (design S3 "starting tables"): business tables first, then the most read. */
export function searchDraftTables(graph: DraftScopeGraph, options: { q?: string; businessOnly?: boolean; limit?: number } = {}): { total: number; items: DraftTableMatch[] } {
  const q = (options.q ?? '').trim().toLowerCase();
  const matches = [...graph.byId].filter(([id, facts]) => (!options.businessOnly || graph.business(id))
    && (!q || facts.name.includes(q) || facts.node.relation.toLowerCase().includes(q)));
  const readers = (id: string) => graph.children.get(id)?.length ?? 0;
  matches.sort(([a, x], [b, y]) => graph.tierOf.get(a)! - graph.tierOf.get(b)! || readers(b) - readers(a) || x.name.localeCompare(y.name));
  return {
    total: matches.length,
    items: matches.slice(0, Math.max(1, Math.min(options.limit ?? 50, 200))).map(([id, facts]) => {
      const item = graph.membership.get(id);
      return {
        id,
        name: facts.name,
        relation: facts.node.relation,
        layer: graph.layerOf.get(id)!,
        business: graph.business(id),
        ...(item?.proposedDomain ? { domain: item.proposedDomain.split('.')[0]! } : {}),
        ...(item?.proposedArea ? { area: item.proposedArea } : {}),
        readers: readers(id),
      };
    }),
  };
}
