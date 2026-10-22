import { modelAreaLocalId } from '@zlens/core/modeling-ids';
import type { ManifestDbtFirstModeling, ManifestModelArea, ManifestModelEntity, ModelingAuthoringChange } from '@zlens/core';

/**
 * The Modeling page's tabs (`05-domain-studio-ui.md`).
 *
 * One page, one domain and subject area picker, and a tab for each thing Ask
 * reads: the map of models and relationships, the business words, the skills,
 * and the blocks. Notebooks and Apps are not modeling — they only *use* a
 * domain — so they share one "Used by" tab. Join proofs, contracts,
 * interfaces, evaluations, dbt scope and Knowledge 360 are deliberately not
 * tabs: their evidence stays in retrieval, validation and the inspectors.
 */
export type DomainStudioSection =
  | 'diagram'
  | 'terms'
  | 'skills'
  | 'blocks'
  | 'used_by';

export type DomainStudioNavigationItem = {
  id: DomainStudioSection;
  label: string;
};

export type DomainStudioNavigationGroup = {
  label?: string;
  items: DomainStudioNavigationItem[];
};

export const DOMAIN_STUDIO_NAVIGATION: DomainStudioNavigationGroup[] = [
  {
    items: [
      // Modeling AI is not a destination. It is an action on the canvas, so it
      // lives in the Map toolbar and docks beside the diagram it edits.
      { id: 'diagram', label: 'Map' },
      { id: 'terms', label: 'Terms & concepts' },
      { id: 'skills', label: 'Skills' },
      { id: 'blocks', label: 'Saved queries' },
      { id: 'used_by', label: 'Used by' },
    ],
  },
];

const NAVIGATION_IDS = new Set(DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items.map((item) => item.id)));

/** Tabs that were merged: old links still land on the tab that replaced them. */
const RENAMED_SECTIONS: Record<string, DomainStudioSection> = { notebooks: 'used_by', apps: 'used_by' };

export function isDomainStudioSection(value: string | null): value is DomainStudioSection {
  return value !== null && NAVIGATION_IDS.has(value as DomainStudioSection);
}

/** A section from a URL or the mirror: current ids pass, merged ids map, anything else is the map. */
export function normalizeDomainStudioSection(value: string | null | undefined): DomainStudioSection {
  if (typeof value !== 'string') return 'diagram';
  if (isDomainStudioSection(value)) return value;
  return RENAMED_SECTIONS[value] ?? 'diagram';
}

export type EntityRecord = {
  recordKey: string;
  entity: ManifestModelEntity;
};

export type DomainPackageTreeRecord = {
  id: string;
  parent?: string;
  depth: number;
  label: string;
};

export function domainStudioLocationHref(
  href: string,
  location: { domain: string | null; section: DomainStudioSection; modelAreaId?: string | null; selectedId?: string | null },
): string {
  const url = new URL(href);
  if (location.domain) url.searchParams.set('domain', location.domain);
  else url.searchParams.delete('domain');
  url.searchParams.set('domainSection', location.section);
  if (location.modelAreaId) url.searchParams.set('modelArea', location.modelAreaId);
  else url.searchParams.delete('modelArea');
  if (location.selectedId) url.searchParams.set('domainObject', location.selectedId);
  else url.searchParams.delete('domainObject');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Remove Domain Studio-only deep-link state after leaving the workspace. */
export function withoutDomainStudioLocationHref(href: string): string {
  const url = new URL(href);
  for (const key of DOMAIN_STUDIO_LOCATION_PARAMS) {
    url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

const DOMAIN_STUDIO_LOCATION_PARAMS = ['domain', 'domainSection', 'modelArea', 'domainObject'] as const;

/** Where the workspace mirrors its location so a round trip can restore it. */
export const DOMAIN_STUDIO_LOCATION_KEY = 'dql.domain-studio.location';

export type DomainStudioLocation = {
  domain: string | null;
  section: DomainStudioSection;
  modelAreaId: string | null;
  selectedId: string | null;
};

/**
 * Where the workspace should open.
 *
 * The URL is authoritative; the mirror only fills in when the URL carries no
 * Domain Studio state at all. `withoutDomainStudioLocationHref` deliberately
 * strips these params on the way out, so returning to Modeling used to land on
 * "all domains, nothing selected" — which also reset the AI thread key and made
 * the conversation unreachable. An explicit deep link always carries at least
 * `domainSection`, so it still wins over whatever was last visited.
 */
export function resolveDomainStudioLocation(href: string, mirrored?: string | null): DomainStudioLocation {
  const params = new URL(href).searchParams;
  if (DOMAIN_STUDIO_LOCATION_PARAMS.some((key) => params.has(key))) {
    const requestedSection = params.get('domainSection');
    const section = normalizeDomainStudioSection(requestedSection);
    return {
      domain: params.get('domain'),
      section,
      modelAreaId: params.get('modelArea'),
      // Only honour a selected object on an explicit diagram deep link.
      selectedId: requestedSection === 'diagram' ? params.get('domainObject') : null,
    };
  }
  return parseDomainStudioLocation(mirrored);
}

/** Tolerant read of the mirrored location; anything unusable means "no location". */
export function parseDomainStudioLocation(raw?: string | null): DomainStudioLocation {
  const empty: DomainStudioLocation = { domain: null, section: 'diagram', modelAreaId: null, selectedId: null };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof DomainStudioLocation, unknown>>;
    const section = normalizeDomainStudioSection(typeof value.section === 'string' ? value.section : null);
    const text = (input: unknown): string | null => (typeof input === 'string' && input.trim() ? input : null);
    return { domain: text(value.domain), section, modelAreaId: text(value.modelAreaId), selectedId: text(value.selectedId) };
  } catch {
    return empty;
  }
}

/**
 * Conversation identity for the Modeling AI dock.
 *
 * Scoped to the domain only. It used to embed the active area and the selected
 * node, so clicking a different model swapped the thread mid-conversation, and
 * navigating away — which clears those params — produced a key that matched
 * nothing on the way back. Both already travel per turn via `selectedObject`
 * and `workspaceContext`, so the turn stays precise while the conversation
 * stays continuous.
 */
export function modelingThreadScope(domain: string | null): string {
  return `modeling:${domain ?? 'all'}`;
}

/** Stable parent-first ordering for the Domain Studio selector and breadcrumbs. */
export function domainPackageTree(
  packages: Pick<ManifestDbtFirstModeling, 'packages'>['packages'],
): DomainPackageTreeRecord[] {
  const values = Object.values(packages);
  const children = new Map<string | undefined, typeof values>();
  for (const pkg of values) {
    const parent = pkg.parent && packages[pkg.parent] ? pkg.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), pkg]);
  }
  for (const entries of children.values()) entries.sort((a, b) => a.id.localeCompare(b.id));
  const output: DomainPackageTreeRecord[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | undefined, depth: number) => {
    for (const pkg of children.get(parent) ?? []) {
      if (visited.has(pkg.id)) continue;
      visited.add(pkg.id);
      output.push({
        id: pkg.id,
        parent: pkg.parent,
        depth,
        label: depth === 0 ? pkg.id : `${'— '.repeat(depth)}${pkg.id.split('.').at(-1) ?? pkg.id}`,
      });
      visit(pkg.id, depth + 1);
    }
  };
  visit(undefined, 0);
  for (const pkg of values.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!visited.has(pkg.id)) output.push({ id: pkg.id, parent: pkg.parent, depth: 0, label: pkg.id });
  }
  return output;
}

/**
 * Prototype kind color for a business/data entity card: dimensions are green,
 * event/snapshot (fact-like) are accent purple, bridges warning, unknown grey.
 * The manifest role vocabulary is event | dimension | snapshot | bridge.
 */
export function entityKindColor(role: string | null | undefined): string {
  const value = (role ?? '').toLowerCase();
  if (value === 'dimension') return 'var(--status-success)';
  if (value === 'bridge') return 'var(--status-warning)';
  if (value === 'event' || value === 'snapshot') return 'var(--accent)';
  return 'var(--text-tertiary)';
}

/**
 * Manifest maps are identity-bearing records. Never derive graph identity from
 * `entity.id`: local ids may repeat in different domains.
 */
export function entityRecords(modeling: Pick<ManifestDbtFirstModeling, 'entities'>): EntityRecord[] {
  return Object.entries(modeling.entities).map(([recordKey, entity]) => ({ recordKey, entity }));
}

/** Resolve a relationship endpoint while retaining v2-compatible local ids. */
export function resolveEntityRecordKey(
  modeling: Pick<ManifestDbtFirstModeling, 'entities'>,
  reference: string,
): string | undefined {
  if (modeling.entities[reference]) return reference;
  const matches = entityRecords(modeling).filter(({ entity }) => entity.id === reference || entity.qualifiedId === reference);
  return matches.length === 1 ? matches[0]!.recordKey : undefined;
}

export function domainEntityRecords(
  modeling: Pick<ManifestDbtFirstModeling, 'entities'>,
  domain: string | null,
): EntityRecord[] {
  return entityRecords(modeling).filter(({ entity }) => !domain || entity.domain === domain);
}

/**
 * True when a change only edits DQL-owned prose on an object that already
 * exists — business name, business context, concepts, analytical role, or an
 * area's name/description/examples.
 *
 * These carry no join, lifecycle, or authorization semantics, so they may save
 * directly. Anything that creates an object, rebinds a dbt model, asserts grain
 * or keys, touches a relationship, or moves lifecycle returns false and keeps
 * the full proposal review.
 */
export function isDescriptiveOnlyChange(
  change: ModelingAuthoringChange,
  existingEntity?: ManifestModelEntity,
  existingArea?: ManifestModelArea,
): boolean {
  if (change.operation === 'upsert_entity') {
    if (!existingEntity) return false;
    const value = change.value;
    return value.dbtModel === existingEntity.dbtUniqueId
      && (value.grain ?? undefined) === (existingEntity.grain ?? undefined)
      && JSON.stringify(value.keys ?? []) === JSON.stringify(existingEntity.keys ?? [])
      && (value.status ?? existingEntity.status) === existingEntity.status
      && (value.areaId ?? undefined) === modelAreaLocalId(existingEntity.areaId)
      && value.domain === existingEntity.domain;
  }
  if (change.operation === 'upsert_area') {
    return Boolean(existingArea)
      && change.value.domain === existingArea!.domain
      && change.value.id === existingArea!.localId;
  }
  return false;
}
