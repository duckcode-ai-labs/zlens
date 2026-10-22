import type { AppBlockRecommendation, AppStudioBuildDraft, AppStudioDraftOperation } from '../../api/client';
import { DASHBOARD_FILTER_DOES_NOT_APPLY_REASON } from '@zlens/core/apps/filter-reach';
import type { DatasetJoin, DatasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { datasetFieldForFilter, relatedFieldParts } from '@zlens/core/datasets/related-fields';
import { missingFieldReason, sourceDisplayName } from './source-names';

type StudioPage = AppStudioBuildDraft['pages'][number];
type StudioTile = StudioPage['layout']['items'][number];

export type StudioFilterTileMapping = {
  key: string;
  pageId: string;
  pageTitle: string;
  tileId: string;
  tileTitle: string;
  sourceName: string;
  supported: boolean;
  binding?: string;
  mode?: 'parameter' | 'predicate' | 'semantic';
  /** Exact v3 binding. A Dataset filter is never inferred from a matching
   * field name on another source. */
  datasetId?: string;
  datasetField?: string;
  /** The approved physical field's type and role, for link suggestions (D10). */
  datasetFieldType?: string;
  datasetFieldRole?: string;
  sourceId?: string;
  sourceRevision?: string;
  reason?: string;
  /**
   * A date filter on a tile whose Dataset has no field of the filter's name:
   * that Dataset's own date and time fields, so the author can map one
   * ("Use Ordered At on Order Items"). Never applied on its own.
   */
  dateFieldOptions?: Array<{ field: string; type: string }>;
  /** The filter field this tile's mapped field stands in for (an author's date mapping). */
  mappedFrom?: string;
  /**
   * The join path the filter reaches this tile's Dataset through, in words
   * ("Customer"): a Customer Name filter reaches the Orders trend through
   * its Customer join (design D2). Still linked only when the author says so.
   */
  via?: string;
};

/**
 * An author's explicit field choice per Dataset (by source id) for one
 * filter, e.g. a "Month" date filter that uses `ordered_at` on Order Items.
 */
export type StudioFilterFieldOverrides = Record<string, string>;

export type StudioFilterMappingOptions = {
  fieldOverrides?: StudioFilterFieldOverrides;
  /** The filter is a date control, so tiles without the field offer their own date fields. */
  dateFilter?: boolean;
};

/** Whether a filter control type filters by date. */
export function isStudioDateFilterType(type: string | undefined): boolean {
  return type === 'daterange' || type === 'date' || type === 'relative_date';
}

/**
 * The field overrides a saved filter already carries: each Dataset binding
 * whose field is not the filter's own field (by name).
 */
export function studioFilterFieldOverrides(
  pages: StudioPage[],
  filterId: string,
  fieldId: string,
): StudioFilterFieldOverrides {
  const overrides: StudioFilterFieldOverrides = {};
  for (const page of pages) {
    const filter = page.filters?.find((candidate) => candidate.id === filterId);
    for (const [datasetId, binding] of Object.entries(filter?.datasetBindings ?? {})) {
      const dataset = page.datasets?.find((candidate) => candidate.id === datasetId);
      if (dataset && normalizeFieldId(binding.field) !== normalizeFieldId(fieldId)) overrides[dataset.sourceId] = binding.field;
    }
  }
  return overrides;
}

export type StudioFilterCandidate = {
  id: string;
  sourceNames: string[];
  affectedTileCount: number;
  pageCount: number;
  /** How many of those tiles reach the field only through a join ("2 via a join"). */
  viaJoinCount?: number;
  /** How many of those tiles use it as their Dataset's own main date (Orders → Ordered At). */
  mainDateTileCount?: number;
};

export type StudioRuntimeFilterFields = Record<string, Record<string, Array<{
  column: string;
  predicateTarget: string;
}>>>;

/**
 * Persist field-query filter reach by exact Dataset tile id. A Dataset can
 * back several components, so a bare Dataset-to-field map loses an author's
 * deliberate exclusion when the editor is reopened. An empty tileIds list is
 * meaningful: it records that this Dataset has no selected component.
 */
export function datasetFilterBindingsForSelection(
  mappings: StudioFilterTileMapping[],
  selectedMappingKeys: ReadonlySet<string>,
): Record<string, { field: string; tileIds: string[] }> {
  const groups = new Map<string, { field: string; tileIds: Set<string> }>();
  for (const mapping of mappings) {
    if (!mapping.supported || !mapping.datasetId || !mapping.datasetField) continue;
    const current = groups.get(mapping.datasetId);
    if (current) {
      if (selectedMappingKeys.has(mapping.key)) current.tileIds.add(mapping.tileId);
    } else {
      groups.set(mapping.datasetId, {
        field: mapping.datasetField,
        tileIds: selectedMappingKeys.has(mapping.key) ? new Set([mapping.tileId]) : new Set(),
      });
    }
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([datasetId, binding]) => [datasetId, {
      field: binding.field,
      tileIds: [...binding.tileIds].sort(),
    }]));
}

/**
 * A Saved query, Metrics or draft tile's filter bindings after the author
 * chose "Applies" or "Does not apply" for one filter in the Filters tab.
 *
 * Both choices are stored. "Applies" is a link the next preview checks;
 * "Does not apply" is an explicit exclusion (`capability: 'unsupported'` with
 * a reason) that readers see as "Not filtered by …" and that never blocks
 * publishing. A tile that cannot take the field (an App-scope filter on a
 * page whose tiles do not expose it) is stored as "Does not apply" with why.
 * Dataset tiles keep their choice on the filter's `datasetBindings` instead.
 */
export function studioTileFilterBindings(input: {
  tile: Pick<StudioTile, 'filterBindings'>;
  filterId: string;
  fieldId: string;
  required: boolean;
  /** Whether the filter is on this tile's page at all. */
  filterOnPage: boolean;
  applies: boolean;
  mapping?: StudioFilterTileMapping;
}): NonNullable<StudioTile['filterBindings']> {
  const rest = (input.tile.filterBindings ?? []).filter((binding) => binding.filter !== input.filterId);
  if (!input.filterOnPage) return rest;
  if (input.applies && input.mapping?.supported) {
    return [...rest, {
      filter: input.filterId,
      binding: input.mapping.binding ?? input.fieldId,
      mode: input.mapping.mode ?? 'predicate',
      required: input.required,
      capability: 'preflight_required',
    }];
  }
  return [...rest, {
    filter: input.filterId,
    capability: 'unsupported',
    unsupportedReason: input.mapping && !input.mapping.supported && input.mapping.reason
      ? input.mapping.reason
      : DASHBOARD_FILTER_DOES_NOT_APPLY_REASON,
  }];
}

/**
 * Filter link suggestions (design D10). A new filter starts linked only to
 * the Dataset whose field the author picked (the first Dataset tile using
 * that field, on this page first) and to non-Dataset tiles that expose it.
 * Other Datasets in the App with an approved dimension of the same name and
 * kind are offered as "Also filter these tiles?", unchecked: nothing links
 * across Datasets by name on its own.
 */
export type StudioFilterLinkSuggestion = {
  sourceId: string;
  datasetName: string;
  field: string;
  /** The join path the filter reaches this Dataset through ("Customer"), design D2. */
  via?: string;
  mappingKeys: string[];
  tileCount: number;
};

/** The Dataset a new filter's field comes from: the first Dataset tile using it, on the active page first. */
export function filterPrimarySourceId(mappings: StudioFilterTileMapping[], activePageId?: string): string | undefined {
  // A Dataset with the field of its own comes before one that reaches it through a join.
  const supported = mappings.filter((mapping) => mapping.supported && mapping.datasetId && mapping.sourceId);
  const dataset = supported.some((mapping) => !mapping.via) ? supported.filter((mapping) => !mapping.via) : supported;
  return (dataset.find((mapping) => mapping.pageId === activePageId) ?? dataset[0])?.sourceId;
}

/** What a new filter links at first: its own Dataset's tiles and non-Dataset tiles that expose the field. */
export function initialFilterMappingKeys(mappings: StudioFilterTileMapping[], primarySourceId: string | undefined): string[] {
  return mappings
    .filter((mapping) => mapping.supported && (!mapping.datasetId || mapping.sourceId === primarySourceId))
    .map((mapping) => mapping.key);
}

function fieldTypeFamily(type: string | undefined): string {
  if (type === 'date' || type === 'timestamp') return 'time';
  return type ?? 'unknown';
}

/** Other Datasets in the App with an approved dimension of the same name and kind (D10). */
export function filterLinkSuggestions(
  mappings: StudioFilterTileMapping[],
  primarySourceId: string | undefined,
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterLinkSuggestion[] {
  if (!primarySourceId) return [];
  const primary = mappings.find((mapping) => mapping.supported && mapping.sourceId === primarySourceId && mapping.datasetField);
  if (!primary) return [];
  const family = fieldTypeFamily(primary.datasetFieldType);
  const groups = new Map<string, StudioFilterLinkSuggestion>();
  for (const mapping of mappings) {
    if (!mapping.supported || !mapping.datasetId || !mapping.datasetField || !mapping.sourceId || mapping.sourceId === primarySourceId) continue;
    if (mapping.datasetFieldRole === 'attribute' || fieldTypeFamily(mapping.datasetFieldType) !== family) continue;
    // The same column, whether the Dataset has it or reaches it through a join (design D2).
    if (filterColumn(mapping.datasetField) !== filterColumn(primary.datasetField!)) continue;
    const current = groups.get(mapping.sourceId);
    if (current) {
      current.mappingKeys.push(mapping.key);
      current.tileCount += 1;
      continue;
    }
    const source = boundSources.find((candidate) => candidate.id === mapping.sourceId);
    groups.set(mapping.sourceId, {
      sourceId: mapping.sourceId,
      datasetName: datasetDisplayName(source, mapping.sourceName),
      field: mapping.datasetField,
      ...(mapping.via ? { via: mapping.via } : {}),
      mappingKeys: [mapping.key],
      tileCount: 1,
    });
  }
  return [...groups.values()].sort((left, right) => left.datasetName.localeCompare(right.datasetName));
}

/** A filter field's column: a related field "customer__customer_name" reads the column customer_name. */
function filterColumn(field: string): string {
  return (relatedFieldParts(field)?.column ?? field).toLowerCase();
}

function datasetDisplayName(source: AppStudioBuildDraft['sources'][number] | undefined, fallback: string): string {
  return sourceDisplayName(source?.qualifiedIdentity ?? fallback, source?.capabilities?.dataset?.label);
}

export function defaultStudioFilterType(fieldId: string): 'daterange' | 'number' | 'select' {
  if (/date|time|month|week|quarter|year|created|updated|ordered|(_at|_on)$/i.test(fieldId)) return 'daterange';
  if (/count|amount|limit|top_?n|score/i.test(fieldId)) return 'number';
  return 'select';
}

/**
 * Filters are authored only from fields already exposed by a governed source.
 * This gives App Studio a Power BI/Tableau-style field picker without turning
 * arbitrary result columns into an unreviewed SQL contract.
 */
export function discoverAppFilterCandidates(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterCandidate[] {
  const fieldIds = new Set<string>();
  for (const page of pages) {
    for (const filter of page.filters ?? []) {
      const fieldId = filter.field?.name ?? filter.bindsTo ?? filter.id;
      if (fieldId) fieldIds.add(fieldId);
    }
    for (const tile of dataTiles(page)) {
      for (const fieldId of governedFieldsForTile(tile, catalog, boundSources)) fieldIds.add(fieldId);
      for (const field of runtimeFields[page.id]?.[tile.i] ?? []) fieldIds.add(field.column);
      for (const binding of tile.filterBindings ?? []) {
        if (binding.binding && binding.capability !== 'unsupported') fieldIds.add(binding.binding);
      }
    }
  }
  // A related field ("customer__customer_name") is the same filter as the
  // column it reads when another source has that column: one candidate, which
  // reaches the joined Dataset through its join.
  const plainIds = new Set([...fieldIds].filter((id) => !relatedFieldParts(id)).map((id) => id.toLowerCase()));
  for (const id of [...fieldIds]) {
    const parts = relatedFieldParts(id);
    if (parts && plainIds.has(parts.column.toLowerCase())) fieldIds.delete(id);
  }
  return [...fieldIds]
    .map((id): StudioFilterCandidate => {
      const mappings = filterTileMappingsForField(pages, catalog, id, runtimeFields, boundSources).filter((mapping) => mapping.supported);
      const viaJoinCount = mappings.filter((mapping) => mapping.via).length;
      const mainDateTileCount = mappings.filter((mapping) => !mapping.via && mappingIsMainDate(mapping, boundSources)).length;
      return {
        id,
        sourceNames: [...new Set(mappings.map((mapping) => mapping.sourceName))].sort(),
        affectedTileCount: mappings.length,
        pageCount: new Set(mappings.map((mapping) => mapping.pageId)).size,
        ...(viaJoinCount ? { viaJoinCount } : {}),
        ...(mainDateTileCount ? { mainDateTileCount } : {}),
      };
    })
    .filter((candidate) => candidate.affectedTileCount > 0)
    // A tile's own main date comes first (Orders → Ordered At), never a related
    // table's date that reaches more tiles through a join (a customer's first order).
    .sort((left, right) => {
      const main = (right.mainDateTileCount ?? 0) - (left.mainDateTileCount ?? 0);
      if (main) return main;
      if (left.mainDateTileCount && right.mainDateTileCount) {
        const via = (left.viaJoinCount ?? 0) - (right.viaJoinCount ?? 0);
        if (via) return via;
      }
      return left.id.localeCompare(right.id);
    });
}

export function discoverPageFilterCandidates(
  page: StudioPage | null,
  catalog: AppBlockRecommendation[],
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterCandidate[] {
  return page ? discoverAppFilterCandidates([page], catalog, runtimeFields, boundSources) : [];
}

/** Returns every data component, including explicit incompatibility reasons. */
export function filterTileMappingsForField(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
  fieldId: string,
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
  options: StudioFilterMappingOptions = {},
): StudioFilterTileMapping[] {
  return pages.flatMap((page) => dataTiles(page).map((tile) => {
    const datasetMapping: { datasetId: string; field: string; type: string; role: string; mappedFrom?: string; via?: string } | null = datasetMappingForTile(page, tile, fieldId, boundSources)
      ?? overriddenDatasetMappingForTile(page, tile, fieldId, boundSources, options.fieldOverrides);
    if (tile.query || tile.driver) {
      const sourceName = sourceNameForTile(tile, catalog, boundSources);
      if (datasetMapping) {
        return {
          key: studioFilterMappingKey(page.id, tile.i),
          pageId: page.id,
          pageTitle: page.metadata.title,
          tileId: tile.i,
          tileTitle: tile.title || tile.i,
          sourceName,
          supported: true,
          binding: datasetMapping.field,
          mode: 'predicate' as const,
          datasetId: datasetMapping.datasetId,
          datasetField: datasetMapping.field,
          datasetFieldType: datasetMapping.type,
          datasetFieldRole: datasetMapping.role,
          sourceId: tile.sourceId,
          sourceRevision: tile.sourceRevision,
          ...(datasetMapping.mappedFrom ? { mappedFrom: datasetMapping.mappedFrom } : {}),
          ...(datasetMapping.via ? { via: datasetMapping.via } : {}),
        };
      }
      const dateFieldOptions = options.dateFilter ? datasetDateFieldsForTile(page, tile, boundSources) : [];
      return {
        key: studioFilterMappingKey(page.id, tile.i),
        pageId: page.id,
        pageTitle: page.metadata.title,
        tileId: tile.i,
        tileTitle: tile.title || tile.i,
        sourceName,
        supported: false,
        reason: missingFieldReason(sourceName, fieldId),
        ...(tile.sourceId ? { sourceId: tile.sourceId } : {}),
        ...(dateFieldOptions.length ? { dateFieldOptions } : {}),
      };
    }
    const fields = governedFieldsForTile(tile, catalog, boundSources);
    const runtimeField = (runtimeFields[page.id]?.[tile.i] ?? []).find((field) => sameStudioFilterField(field.column, fieldId));
    const existing = (tile.filterBindings ?? []).find((binding) =>
      binding.filter === fieldId || binding.binding === fieldId,
    );
    const supported = fields.includes(fieldId)
      || Boolean(runtimeField)
      || Boolean(existing?.binding === fieldId && existing.capability !== 'unsupported');
    const sourceName = sourceNameForTile(tile, catalog, boundSources);
    return {
      key: studioFilterMappingKey(page.id, tile.i),
      pageId: page.id,
      pageTitle: page.metadata.title,
      tileId: tile.i,
      tileTitle: tile.title || tile.i,
      sourceName,
      supported,
      ...(supported ? {
        // App execution filters the settled tile's outer result. Use the
        // approved output column here; predicateTarget is retained only as the
        // server-side proof that this output is a safe, non-aggregate field.
        binding: runtimeField?.column ?? fieldId,
        mode: tile.semantic ? 'semantic' as const : existing?.mode ?? 'predicate' as const,
      } : {
        reason: missingFieldReason(sourceName, fieldId),
      }),
    };
  }));
}

function sameStudioFilterField(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const parts = value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.');
    return (parts[parts.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
  };
  return normalize(left) === normalize(right);
}

export function studioFilterMappingKey(pageId: string, tileId: string): string {
  return `${pageId}:${tileId}`;
}

function dataTiles(page: StudioPage): StudioTile[] {
  // A driver tile explains a Dataset tile and follows the same Dataset filters.
  return page.layout.items.filter((tile) => Boolean(tile.block || tile.semantic || tile.draftAnalysis || tile.query || tile.driver));
}

function governedFieldsForTile(
  tile: StudioTile,
  catalog: AppBlockRecommendation[],
  boundSources: AppStudioBuildDraft['sources'],
): string[] {
  const bound = tile.sourceId ? boundSources.find((source) => source.id === tile.sourceId) : undefined;
  if (tile.query && bound?.capabilities?.dataset) {
    return bound.capabilities.dataset.fields
      .filter((field) => field.kind === 'physical' && field.status === 'approved')
      // The field picker uses one clear display identity. The retained
      // Dataset descriptor resolves this name to its qualified identity at
      // validation time, so the UI never presents duplicate field rows.
      .map((field) => field.name);
  }
  if (bound?.capabilities) {
    return [...new Set([...bound.capabilities.filters, ...bound.capabilities.dimensions])];
  }
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return [...new Set([...(source.filterIds ?? []), ...(source.dimensionIds ?? [])])];
  if (tile.semantic) return tile.semantic.dimensions ?? [];
  if (tile.draftAnalysis) return [];
  return (tile.filterBindings ?? [])
    .filter((binding) => binding.capability !== 'unsupported' && Boolean(binding.binding))
    .map((binding) => binding.binding!);
}

function datasetMappingForTile(
  page: StudioPage,
  tile: StudioTile,
  fieldId: string,
  boundSources: AppStudioBuildDraft['sources'],
): { datasetId: string; field: string; type: string; role: string; via?: string } | null {
  if (!(tile.query || tile.driver) || !tile.sourceId || !tile.sourceRevision) return null;
  const source = boundSources.find((candidate) => candidate.id === tile.sourceId);
  const descriptor = source?.capabilities?.dataset;
  const binding = page.datasets?.find((candidate) => (
    candidate.sourceId === tile.sourceId
    && candidate.sourceRevision === tile.sourceRevision
  ));
  if (!descriptor || !binding) return null;
  // Its own field of that name, else the one related field that reads the
  // column through a checked join ("Orders · via Customer"), design D2.
  const found = datasetFieldForFilter(descriptor, fieldId);
  if (!found) return null;
  const via = found.join ? joinPathWords(descriptor.joins ?? [], found.join.id) : undefined;
  return { datasetId: binding.id, field: found.field.name, type: found.field.type, role: found.field.role, ...(via ? { via } : {}) };
}

/** "Customer" or "Customer → Region": a join's path from its Dataset. */
function joinPathWords(joins: DatasetJoin[], joinId: string): string {
  const chain: string[] = [];
  let join = joins.find((candidate) => candidate.id === joinId);
  while (join && chain.length < 4) {
    chain.unshift(join.label);
    const parent = join.parent;
    join = parent ? joins.find((candidate) => candidate.id === parent) : undefined;
  }
  return chain.join(' → ');
}

/** The Dataset behind a tile and its page binding, when both are current. */
function tileDataset(page: StudioPage, tile: StudioTile, boundSources: AppStudioBuildDraft['sources']) {
  if (!(tile.query || tile.driver) || !tile.sourceId || !tile.sourceRevision) return null;
  const descriptor = boundSources.find((candidate) => candidate.id === tile.sourceId)?.capabilities?.dataset;
  const binding = page.datasets?.find((candidate) => candidate.sourceId === tile.sourceId && candidate.sourceRevision === tile.sourceRevision);
  return descriptor && binding ? { descriptor, binding } : null;
}

/** A tile's Dataset field the author chose for this filter instead of a same-named one. */
function overriddenDatasetMappingForTile(
  page: StudioPage,
  tile: StudioTile,
  fieldId: string,
  boundSources: AppStudioBuildDraft['sources'],
  overrides: StudioFilterFieldOverrides | undefined,
): { datasetId: string; field: string; type: string; role: string; mappedFrom: string } | null {
  const chosen = tile.sourceId ? overrides?.[tile.sourceId] : undefined;
  if (!chosen) return null;
  const dataset = tileDataset(page, tile, boundSources);
  if (!dataset) return null;
  const physical = dataset.descriptor.fields.find((field) => field.kind === 'physical' && field.status === 'approved' && normalizeFieldId(field.name) === normalizeFieldId(chosen));
  return physical && physical.kind === 'physical'
    ? { datasetId: dataset.binding.id, field: physical.name, type: physical.type, role: physical.role, mappedFrom: fieldId }
    : null;
}

/** Whether a mapping's field is its Dataset's own main date field (the time field marked primary). */
function mappingIsMainDate(mapping: StudioFilterTileMapping, boundSources: AppStudioBuildDraft['sources']): boolean {
  if (!mapping.datasetField || !mapping.sourceId) return false;
  const descriptor = boundSources.find((source) => source.id === mapping.sourceId)?.capabilities?.dataset;
  const field = descriptor?.fields.find((candidate) => candidate.kind === 'physical' && !candidate.related && candidate.name === mapping.datasetField);
  return Boolean(field && field.kind === 'physical' && field.time?.primary);
}

/** A tile's approved date and time fields, for mapping a date filter by hand. */
function datasetDateFieldsForTile(
  page: StudioPage,
  tile: StudioTile,
  boundSources: AppStudioBuildDraft['sources'],
): Array<{ field: string; type: string }> {
  const dataset = tileDataset(page, tile, boundSources);
  if (!dataset) return [];
  // The Dataset's own main date first, then its other own dates, then dates of related tables.
  const rank = (field: DatasetPhysicalField) => (field.time?.primary ? 0 : 1) + (field.related ? 2 : 0);
  return dataset.descriptor.fields
    .filter((field): field is DatasetPhysicalField => field.kind === 'physical'
      && field.status === 'approved'
      && (field.type === 'date' || field.type === 'timestamp' || field.role === 'time'))
    .map((field, index) => ({ field, index }))
    .sort((left, right) => rank(left.field) - rank(right.field) || left.index - right.index)
    .map(({ field }) => ({ field: field.name, type: field.type }));
}

function normalizeFieldId(value: string): string {
  return value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.').at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
}

function sourceNameForTile(
  tile: StudioTile,
  catalog: AppBlockRecommendation[],
  boundSources: AppStudioBuildDraft['sources'],
): string {
  // The name a person reads ("Customers"), never the internal identity.
  const bound = tile.sourceId ? boundSources.find((source) => source.id === tile.sourceId) : undefined;
  if (bound) return datasetDisplayName(bound, bound.sourceRef);
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return sourceDisplayName(source.qualifiedIdentity ?? source.name, source.capabilities?.dataset?.label ?? source.name);
  if (tile.semantic) return sourceDisplayName(tile.semantic.id);
  if (tile.draftAnalysis) return sourceDisplayName(tile.draftAnalysis.ref);
  return tile.title || tile.i;
}

/**
 * A page filter a tile just added to the page can take: its field (or a
 * checked join to it) is on the tile's data, but nothing linked it. The tile
 * stays "Not filtered by …" until the author says Apply; this is only the
 * one-click offer ("Customer Name filter can apply to this tile — Apply").
 */
export type StudioTileFilterOffer = {
  filterId: string;
  filterLabel: string;
  pageId: string;
  tileId: string;
  /** The join the filter reaches the tile through ("Customer"), when it is not the tile's own field. */
  via?: string;
  mapping: StudioFilterTileMapping;
};

/** The page filters a tile can take but is not linked to. */
export function tileFilterOffers(input: {
  pages: StudioPage[];
  pageId: string;
  tileId: string;
  catalog: AppBlockRecommendation[];
  runtimeFields?: StudioRuntimeFilterFields;
  boundSources?: AppStudioBuildDraft['sources'];
}): StudioTileFilterOffer[] {
  const page = input.pages.find((candidate) => candidate.id === input.pageId);
  const tile = page?.layout.items.find((candidate) => candidate.i === input.tileId);
  if (!page || !tile) return [];
  const offers: StudioTileFilterOffer[] = [];
  for (const filter of page.filters ?? []) {
    if (studioTileTakesFilter(page, tile, filter.id)) continue;
    const fieldId = filter.field?.name ?? filter.bindsTo ?? filter.id;
    const dateFilter = isStudioDateFilterType(filter.type);
    const fieldOverrides = dateFilter ? studioFilterFieldOverrides(input.pages, filter.id, fieldId) : {};
    const mapping = filterTileMappingsForField([page], input.catalog, fieldId, input.runtimeFields, input.boundSources, {
      dateFilter,
      ...(Object.keys(fieldOverrides).length ? { fieldOverrides } : {}),
    }).find((candidate) => candidate.tileId === tile.i);
    if (!mapping?.supported) continue;
    offers.push({
      filterId: filter.id,
      filterLabel: filter.label?.trim() || filter.id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      pageId: page.id,
      tileId: tile.i,
      ...(mapping.via ? { via: mapping.via } : {}),
      mapping,
    });
  }
  return offers;
}

/** Whether a tile already takes a page filter (a Dataset binding that includes it, or a field link). */
function studioTileTakesFilter(page: StudioPage, tile: StudioTile, filterId: string): boolean {
  const filter = page.filters?.find((candidate) => candidate.id === filterId);
  if (!filter) return false;
  if (filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)) return false;
  if ((tile.query || tile.driver) && tile.sourceId && tile.sourceRevision) {
    return Boolean(page.datasets?.some((dataset) => {
      if (dataset.sourceId !== tile.sourceId || dataset.sourceRevision !== tile.sourceRevision) return false;
      const binding = filter.datasetBindings?.[dataset.id];
      return Boolean(binding && (!binding.tileIds || binding.tileIds.includes(tile.i)));
    }));
  }
  if (tile.parameterBindings?.some((binding) => binding.filter === filterId)) return true;
  return tile.filterBindings?.some((binding) => binding.filter === filterId && binding.capability !== 'unsupported') ?? false;
}

/**
 * The edits that link one tile to a page filter after the author accepted
 * the offer: a Dataset tile joins the filter's binding for its Dataset (the
 * field the binding already uses, else the tile's own or related field); any
 * other tile gets a field link. An earlier "Does not apply" on the tile is
 * replaced.
 */
export function tileFilterOfferOperations(page: StudioPage, offer: StudioTileFilterOffer): AppStudioDraftOperation[] {
  const filter = page.filters?.find((candidate) => candidate.id === offer.filterId);
  const tile = page.layout.items.find((candidate) => candidate.i === offer.tileId);
  if (!filter || !tile || !offer.mapping.supported) return [];
  const operations: AppStudioDraftOperation[] = [];
  const scope = filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)
    ? { ...filter.scope, tileIds: [...filter.scope.tileIds, tile.i].sort() }
    : filter.scope;
  if (offer.mapping.datasetId && offer.mapping.datasetField) {
    const current = filter.datasetBindings?.[offer.mapping.datasetId];
    const binding = current
      ? { ...current, ...(current.tileIds ? { tileIds: [...new Set([...current.tileIds, tile.i])].sort() } : {}) }
      : { field: offer.mapping.datasetField, tileIds: [tile.i] };
    operations.push({
      type: 'set_filter',
      pageId: page.id,
      filter: { ...filter, ...(scope ? { scope } : {}), datasetBindings: { ...(filter.datasetBindings ?? {}), [offer.mapping.datasetId]: binding } },
    });
    const rest = (tile.filterBindings ?? []).filter((item) => item.filter !== filter.id);
    if (rest.length !== (tile.filterBindings ?? []).length) {
      operations.push({ type: 'update_tile', pageId: page.id, tileId: tile.i, patch: { filterBindings: rest } });
    }
    return operations;
  }
  if (scope !== filter.scope) operations.push({ type: 'set_filter', pageId: page.id, filter: { ...filter, scope } });
  operations.push({
    type: 'update_tile',
    pageId: page.id,
    tileId: tile.i,
    patch: {
      filterBindings: studioTileFilterBindings({
        tile,
        filterId: filter.id,
        fieldId: filter.field?.name ?? filter.bindsTo ?? filter.id,
        required: filter.required ?? false,
        filterOnPage: true,
        applies: true,
        mapping: offer.mapping,
      }),
    },
  });
  return operations;
}
