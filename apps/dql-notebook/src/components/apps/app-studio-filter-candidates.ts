import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';

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
};

export type StudioFilterCandidate = {
  id: string;
  sourceNames: string[];
  affectedTileCount: number;
  pageCount: number;
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
  mappingKeys: string[];
  tileCount: number;
};

/** The Dataset a new filter's field comes from: the first Dataset tile using it, on the active page first. */
export function filterPrimarySourceId(mappings: StudioFilterTileMapping[], activePageId?: string): string | undefined {
  const dataset = mappings.filter((mapping) => mapping.supported && mapping.datasetId && mapping.sourceId);
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
    if (mapping.datasetField.toLowerCase() !== primary.datasetField!.toLowerCase()) continue;
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
      mappingKeys: [mapping.key],
      tileCount: 1,
    });
  }
  return [...groups.values()].sort((left, right) => left.datasetName.localeCompare(right.datasetName));
}

function datasetDisplayName(source: AppStudioBuildDraft['sources'][number] | undefined, fallback: string): string {
  const identity = source?.qualifiedIdentity ?? fallback;
  const name = source?.capabilities?.dataset?.label?.trim()
    || identity.match(/::block::(.+?)::[0-9a-f]+$/i)?.[1]
    || identity.split('::').at(-1)
    || identity;
  // "top_customers" reads "Top Customers"; a name with spaces is kept as written.
  return /\s/.test(name) ? name : name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  return [...fieldIds]
    .map((id) => {
      const mappings = filterTileMappingsForField(pages, catalog, id, runtimeFields, boundSources).filter((mapping) => mapping.supported);
      return {
        id,
        sourceNames: [...new Set(mappings.map((mapping) => mapping.sourceName))].sort(),
        affectedTileCount: mappings.length,
        pageCount: new Set(mappings.map((mapping) => mapping.pageId)).size,
      };
    })
    .filter((candidate) => candidate.affectedTileCount > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
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
): StudioFilterTileMapping[] {
  return pages.flatMap((page) => dataTiles(page).map((tile) => {
    const datasetMapping = datasetMappingForTile(page, tile, fieldId, boundSources);
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
        };
      }
      return {
        key: studioFilterMappingKey(page.id, tile.i),
        pageId: page.id,
        pageTitle: page.metadata.title,
        tileId: tile.i,
        tileTitle: tile.title || tile.i,
        sourceName,
        supported: false,
        reason: `${fieldId.replace(/_/g, ' ')} is not an approved physical field on this Dataset source.`,
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
        reason: `${fieldId.replace(/_/g, ' ')} is not exposed by ${sourceName}.`,
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
): { datasetId: string; field: string; type: string; role: string } | null {
  if (!(tile.query || tile.driver) || !tile.sourceId || !tile.sourceRevision) return null;
  const source = boundSources.find((candidate) => candidate.id === tile.sourceId);
  const descriptor = source?.capabilities?.dataset;
  const binding = page.datasets?.find((candidate) => (
    candidate.sourceId === tile.sourceId
    && candidate.sourceRevision === tile.sourceRevision
  ));
  if (!descriptor || !binding) return null;
  const normalized = normalizeFieldId(fieldId);
  const physical = descriptor.fields.find((field) => (
    field.kind === 'physical'
    && field.status === 'approved'
    && (normalizeFieldId(field.name) === normalized || normalizeFieldId(field.qualifiedId) === normalized)
  ));
  return physical && physical.kind === 'physical'
    ? { datasetId: binding.id, field: physical.name, type: physical.type, role: physical.role }
    : null;
}

function normalizeFieldId(value: string): string {
  return value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.').at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
}

function sourceNameForTile(
  tile: StudioTile,
  catalog: AppBlockRecommendation[],
  boundSources: AppStudioBuildDraft['sources'],
): string {
  const bound = tile.sourceId ? boundSources.find((source) => source.id === tile.sourceId) : undefined;
  if (bound) return bound.qualifiedIdentity ?? bound.sourceRef;
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return source.name;
  if (tile.semantic) return tile.semantic.id;
  if (tile.draftAnalysis) return tile.draftAnalysis.ref;
  return tile.title || tile.i;
}
