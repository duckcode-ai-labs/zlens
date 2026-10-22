/**
 * Tile trust from the joins a tile reads (design D2, publish rule).
 *
 * A Dataset tile that reads a field from a related table runs through the
 * join to that table. A certified join keeps the tile's trust; a join nobody
 * certified yet (drafted in setup, or a dbt test) makes the tile Needs review.
 * "Only certified data" means every tile, not only every source: a certified
 * Orders Dataset with a drafted Orders → Location join does not publish under
 * that rule.
 *
 * A tile reads a related field through its query (groupings, filters, detail
 * columns, calculation conditions), its driver analysis, or a page filter
 * mapped to it through the related field. This module has no Node imports so
 * the publish check in the browser and on the server share one rule.
 */
import type { DatasetDescriptor, DatasetJoin } from '../datasets/descriptor.js';
import { datasetFieldForFilter, datasetJoinsUsed } from '../datasets/related-fields.js';

export interface JoinTrustTileLike {
  i: string;
  title?: string;
  sourceId?: string;
  sourceRevision?: string;
  query?: {
    dimensions?: Array<{ field: string }>;
    filters?: Array<{ field: string }>;
    detailColumns?: string[];
    calculations?: Array<{ expr?: unknown }>;
  };
  driver?: { dimensions?: string[]; filters?: Array<{ field: string }> };
}

export interface JoinTrustPageLike {
  id: string;
  metadata?: { title?: string };
  datasets?: Array<{ id: string; sourceId: string; sourceRevision?: string }>;
  filters?: Array<{
    id: string;
    label?: string;
    scope?: { tileIds?: string[] };
    datasetBindings?: Record<string, { field: string; tileIds?: string[] }>;
  }>;
  layout: { items: readonly JoinTrustTileLike[] };
}

export interface AppTileNeedingJoinReview {
  pageId: string;
  pageTitle?: string;
  tileId: string;
  tileTitle?: string;
  sourceId: string;
  /** The joins on the tile's path that are not certified, parents first. */
  joins: DatasetJoin[];
  /** Related fields the tile's own query or driver reads through those joins. */
  relatedFields: string[];
  /** Page filters that reach the tile through one of those joins. */
  filterIds: string[];
}

/** The page filters mapped to a tile, with the Dataset field each one reads. */
function tileFilterFields(page: JoinTrustPageLike, tile: JoinTrustTileLike): Array<{ filterId: string; field: string }> {
  const dataset = page.datasets?.find((candidate) => candidate.sourceId === tile.sourceId
    && (!tile.sourceRevision || !candidate.sourceRevision || candidate.sourceRevision === tile.sourceRevision));
  if (!dataset) return [];
  return (page.filters ?? []).flatMap((filter) => {
    if (filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)) return [];
    const binding = filter.datasetBindings?.[dataset.id];
    if (!binding?.field || (binding.tileIds && !binding.tileIds.includes(tile.i))) return [];
    return [{ filterId: filter.id, field: binding.field }];
  });
}

function joinsFor(descriptor: DatasetDescriptor, fields: { dimensions?: Array<{ field: string }>; filters?: Array<{ field: string }>; detailColumns?: string[]; calculations?: Array<{ expr?: unknown }> }): DatasetJoin[] {
  return datasetJoinsUsed(descriptor, fields);
}

/**
 * Every join a tile can run through: the joins its own query and driver read,
 * and the joins of every page filter mapped to it, whether or not a reader
 * picked a value. Trust is a property of the page, decided when it is built
 * and published, not of the current filter values (B6): a tile a Customer
 * filter reaches through a drafted join is Needs review before anyone picks
 * a customer, so its label never changes under a reader's hand.
 */
export function tileJoinsReachable(page: JoinTrustPageLike, tile: JoinTrustTileLike, descriptor: DatasetDescriptor): {
  joins: DatasetJoin[];
  ownJoins: DatasetJoin[];
  filterJoins: Array<{ filterId: string; field: string; joins: DatasetJoin[] }>;
  ownFields: string[];
} {
  const query = tile.query ?? {};
  const driverFields = {
    dimensions: (tile.driver?.dimensions ?? []).map((field) => ({ field })),
    filters: tile.driver?.filters ?? [],
  };
  const ownFields = [
    ...(query.dimensions ?? []).map((dimension) => dimension.field),
    ...(query.filters ?? []).map((filter) => filter.field),
    ...(query.detailColumns ?? []),
    ...driverFields.dimensions.map((dimension) => dimension.field),
    ...driverFields.filters.map((filter) => filter.field),
  ];
  if (!descriptor.joins?.length) return { joins: [], ownJoins: [], filterJoins: [], ownFields };
  const ownJoins = joinsFor(descriptor, {
    dimensions: [...(query.dimensions ?? []), ...driverFields.dimensions],
    filters: [...(query.filters ?? []), ...driverFields.filters],
    detailColumns: query.detailColumns,
    calculations: query.calculations,
  });
  // A filter mapped by column name reaches a related field the way the
  // runtime resolves it ("customer_name" → Orders' Customer join).
  const filterJoins = tileFilterFields(page, tile).map((entry) => {
    const field = datasetFieldForFilter(descriptor, entry.field)?.field.name ?? entry.field;
    return { ...entry, field, joins: joinsFor(descriptor, { filters: [{ field }] }) };
  });
  const ids = new Set([...ownJoins, ...filterJoins.flatMap((entry) => entry.joins)].map((join) => join.id));
  return { joins: descriptor.joins.filter((join) => ids.has(join.id)), ownJoins, filterJoins, ownFields };
}

/**
 * Every Dataset tile whose path uses a join that is not certified. A tile on
 * a Dataset without joins, or one that reads only its own fields, is never
 * listed. The source's own trust is checked separately.
 *
 * `joinTrust` lets current evidence (a settled run of the page) say a join
 * was certified since the source card was stored.
 */
export function appTilesNeedingJoinReview(input: {
  pages: readonly JoinTrustPageLike[];
  descriptorFor: (sourceId: string) => DatasetDescriptor | undefined;
  joinTrust?: (pageId: string, tileId: string, join: DatasetJoin) => DatasetJoin['trust'];
}): AppTileNeedingJoinReview[] {
  const out: AppTileNeedingJoinReview[] = [];
  for (const page of input.pages) {
    for (const tile of page.layout.items) {
      if (!tile.sourceId || (!tile.query && !tile.driver)) continue;
      const descriptor = input.descriptorFor(tile.sourceId);
      if (!descriptor?.joins?.length) continue;
      const reachable = tileJoinsReachable(page, tile, descriptor);
      const trustOf = (join: DatasetJoin) => input.joinTrust?.(page.id, tile.i, join) ?? join.trust;
      const reviewJoins = new Map<string, DatasetJoin>();
      for (const join of reachable.joins) {
        if (trustOf(join) !== 'certified') reviewJoins.set(join.id, join);
      }
      if (reviewJoins.size === 0) continue;
      // A related field on a review join, or below one (Customer → Region).
      const onReviewPath = (field: string): boolean => joinsFor(descriptor, { filters: [{ field }] })
        .some((join) => reviewJoins.has(join.id));
      out.push({
        pageId: page.id,
        ...(page.metadata?.title ? { pageTitle: page.metadata.title } : {}),
        tileId: tile.i,
        ...(tile.title ? { tileTitle: tile.title } : {}),
        sourceId: tile.sourceId,
        joins: (descriptor.joins ?? []).filter((join) => reviewJoins.has(join.id)),
        relatedFields: Array.from(new Set(reachable.ownFields.filter(onReviewPath))),
        filterIds: Array.from(new Set(reachable.filterJoins.filter((entry) => entry.joins.some((join) => reviewJoins.has(join.id))).map((entry) => entry.filterId))),
      });
    }
  }
  return out;
}

/** "Revenue by location uses the join from Orders to Location, which is not certified yet." */
export function tileJoinReviewSentence(item: AppTileNeedingJoinReview): string {
  const tile = item.tileTitle?.trim() || item.tileId;
  const tables = item.joins.map((join) => join.label || join.table);
  const list = tables.length <= 1 ? tables[0] ?? 'a related table' : `${tables.slice(0, -1).join(', ')} and ${tables.at(-1)}`;
  return `${tile} uses the join to ${list}, which ${item.joins.length === 1 ? 'is' : 'are'} not certified yet.`;
}
