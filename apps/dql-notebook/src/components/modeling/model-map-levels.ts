import type { ManifestDbtFirstModeling } from '@zlens/core';
import { DEFAULT_MODEL_AREA_ID } from '@zlens/core/modeling-ids';

/**
 * The map's three zoom levels (model-at-scale design S5). A large model opens
 * on its Domains, each with its tables and its joins to the others; a Domain
 * opens on its subject areas; an area opens on its tables, with the Shared
 * tables it reads at its edge and its joins into other areas folded into one
 * stub per area. A small model, or a search, opens straight on the tables.
 */

/** Above this many tables, the map opens on an overview instead of drawing every table. */
export const OVERVIEW_THRESHOLD = 60;

export interface MapJoin {
  /** Another Domain, or another area's qualified id (`null` for a Domain's default area). */
  domain: string;
  areaId?: string | null;
  name: string;
  count: number;
}

export interface DomainCard {
  domain: string;
  name: string;
  tables: number;
  areas: number;
  shared: boolean;
  joins: MapJoin[];
}

export interface AreaCard {
  /** The area's qualified id; `null` for tables in the Domain's default files. */
  areaId: string | null;
  name: string;
  tables: number;
  shared: boolean;
  /** Tables of other areas shown read-only at its edge. */
  edge: number;
  joins: MapJoin[];
}

export type MapLevel =
  | { kind: 'domains'; tables: number; cards: DomainCard[] }
  | { kind: 'areas'; domain: string; name: string; tables: number; cards: AreaCard[] }
  | { kind: 'tables' };

type Modeling = Pick<ManifestDbtFirstModeling, 'entities' | 'relationships' | 'areas'> & Partial<Pick<ManifestDbtFirstModeling, 'packages'>>;

const words = (id: string) => {
  const text = id.replace(/[._-]+/g, ' ').trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : id;
};

/** Where each table sits, and each join's two ends, read once. */
function placements(modeling: Modeling) {
  const byReference = new Map<string, string>();
  for (const [recordKey, entity] of Object.entries(modeling.entities)) {
    byReference.set(recordKey, recordKey);
    if (entity.qualifiedId) byReference.set(entity.qualifiedId, recordKey);
  }
  // A local id resolves only when it names one table.
  const localCounts = new Map<string, string[]>();
  for (const [recordKey, entity] of Object.entries(modeling.entities)) localCounts.set(entity.id, [...(localCounts.get(entity.id) ?? []), recordKey]);
  const resolve = (reference: string) => byReference.get(reference) ?? (localCounts.get(reference)?.length === 1 ? localCounts.get(reference)![0] : undefined);
  // The default area a new model lands in (`core`) and a Domain's files
  // outside any area are one place on the map: not in a subject area yet.
  const areaOf = (recordKey: string): string | null => {
    const areaId = modeling.entities[recordKey]?.areaId;
    return areaId && modeling.areas[areaId] && modeling.areas[areaId]!.localId !== DEFAULT_MODEL_AREA_ID ? areaId : null;
  };
  const joins = Object.values(modeling.relationships).flatMap((relationship) => {
    const from = resolve(relationship.from);
    const to = resolve(relationship.to);
    return from && to ? [{ from, to }] : [];
  });
  return { areaOf, joins };
}

const domainName = (modeling: Modeling, domain: string) => (modeling.packages?.[domain] as { name?: string } | undefined)?.name ?? (domain === 'shared' ? 'Shared' : words(domain));
/** How the map and pickers name an area: the default area a new model lands in (`core`) is not one (simplification plan Z3). */
export function areaLabel(area: { localId?: string; name?: string } | undefined, fallback = ''): string {
  if (!area || area.localId === DEFAULT_MODEL_AREA_ID) return 'Not in an area yet';
  return area.name ?? fallback;
}

const areaName = (modeling: Modeling, areaId: string | null) => (areaId && modeling.areas[areaId]?.localId !== DEFAULT_MODEL_AREA_ID ? areaLabel(modeling.areas[areaId], words(areaId.split('::').pop() ?? areaId)) : 'Not in an area yet');
const isShared = (modeling: Modeling, areaId: string | null, domain: string) => (areaId ? modeling.areas[areaId]?.shared === true : false) || domain === 'shared';

/** Which level the map opens on, and what the overview shows. */
export function mapLevel(modeling: Modeling, selectedDomain: string | null, selectedAreaId: string | null, search: string, threshold = OVERVIEW_THRESHOLD): MapLevel {
  if (search.trim() || selectedAreaId) return { kind: 'tables' };
  const entities = Object.entries(modeling.entities);
  const { areaOf, joins } = placements(modeling);
  if (!selectedDomain) {
    const domains = [...new Set(entities.map(([, entity]) => entity.domain))];
    if (domains.length < 2 || entities.length <= threshold) return { kind: 'tables' };
    const cards = domains.map((domain): DomainCard => {
      const own = entities.filter(([, entity]) => entity.domain === domain);
      const counts = new Map<string, number>();
      for (const { from, to } of joins) {
        const a = modeling.entities[from]!.domain;
        const b = modeling.entities[to]!.domain;
        if (a === b || (a !== domain && b !== domain)) continue;
        const other = a === domain ? b : a;
        counts.set(other, (counts.get(other) ?? 0) + 1);
      }
      return {
        domain,
        name: domainName(modeling, domain),
        tables: own.length,
        areas: new Set(own.map(([recordKey]) => areaOf(recordKey))).size,
        shared: domain === 'shared',
        joins: [...counts].map(([other, count]) => ({ domain: other, name: domainName(modeling, other), count })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
      };
    }).sort((a, b) => Number(b.shared) - Number(a.shared) || b.tables - a.tables || a.name.localeCompare(b.name));
    return { kind: 'domains', tables: entities.length, cards };
  }
  const own = entities.filter(([, entity]) => entity.domain === selectedDomain);
  const areaIds = [...new Set(own.map(([recordKey]) => areaOf(recordKey)))];
  if (areaIds.length < 2 || own.length <= threshold) return { kind: 'tables' };
  const placeOf = (recordKey: string) => `${modeling.entities[recordKey]!.domain}|${areaOf(recordKey) ?? ''}`;
  const cards = areaIds.map((areaId): AreaCard => {
    const key = `${selectedDomain}|${areaId ?? ''}`;
    const counts = new Map<string, MapJoin>();
    for (const { from, to } of joins) {
      const a = placeOf(from);
      const b = placeOf(to);
      if (a === b || (a !== key && b !== key)) continue;
      const other = a === key ? to : from;
      const otherDomain = modeling.entities[other]!.domain;
      const otherArea = areaOf(other);
      const id = `${otherDomain}|${otherArea ?? ''}`;
      const name = otherDomain === selectedDomain ? areaName(modeling, otherArea) : `${domainName(modeling, otherDomain)}${otherArea && !isShared(modeling, otherArea, otherDomain) ? ` › ${areaName(modeling, otherArea)}` : ''}`;
      const current = counts.get(id) ?? { domain: otherDomain, areaId: otherArea, name, count: 0 };
      current.count += 1;
      counts.set(id, current);
    }
    return {
      areaId,
      name: areaName(modeling, areaId),
      tables: own.filter(([recordKey]) => areaOf(recordKey) === areaId).length,
      shared: isShared(modeling, areaId, selectedDomain),
      edge: areaId ? modeling.areas[areaId]?.referencedEntityIds.length ?? 0 : 0,
      joins: [...counts.values()].sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
    };
  // Shared first, the tables not in an area yet last, the rest by size.
  }).sort((a, b) => Number(b.shared) - Number(a.shared) || Number(a.areaId === null) - Number(b.areaId === null) || b.tables - a.tables || a.name.localeCompare(b.name));
  return { kind: 'areas', domain: selectedDomain, name: domainName(modeling, selectedDomain), tables: own.length, cards };
}

export interface AreaStub {
  id: string;
  /** "Finance › Revenue · 4 joins" */
  label: string;
  domain: string;
  areaId: string | null;
  count: number;
  /** The tables inside the area these joins start from. */
  from: string[];
}

/**
 * An area's joins to tables the area diagram does not draw, one stub per
 * other area (design S5), so the diagram stays one area's tables and still
 * says where its joins lead.
 */
export function areaStubs(modeling: Modeling, areaId: string, shown: ReadonlySet<string>): AreaStub[] {
  const area = modeling.areas[areaId];
  if (!area) return [];
  const { areaOf, joins } = placements(modeling);
  const inside = new Set(Object.keys(modeling.entities).filter((recordKey) => modeling.entities[recordKey]!.areaId === areaId));
  const stubs = new Map<string, AreaStub>();
  for (const { from, to } of joins) {
    const fromIn = inside.has(from);
    const toIn = inside.has(to);
    if (fromIn === toIn) continue;
    const other = fromIn ? to : from;
    if (shown.has(other)) continue;
    const domain = modeling.entities[other]!.domain;
    const otherArea = areaOf(other);
    const id = `stub:${domain}|${otherArea ?? ''}`;
    const name = domain === area.domain ? areaName(modeling, otherArea) : `${domainName(modeling, domain)}${otherArea && !isShared(modeling, otherArea, domain) ? ` › ${areaName(modeling, otherArea)}` : ''}`;
    const current = stubs.get(id) ?? { id, label: name, domain, areaId: otherArea, count: 0, from: [] };
    current.count += 1;
    const start = fromIn ? from : to;
    if (!current.from.includes(start)) current.from.push(start);
    stubs.set(id, current);
  }
  return [...stubs.values()].map((stub) => ({ ...stub, label: `${stub.label} · ${stub.count} join${stub.count === 1 ? '' : 's'}` })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
