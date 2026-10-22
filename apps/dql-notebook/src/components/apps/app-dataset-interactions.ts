import {
  applyDatasetHierarchyDrill,
  datasetHierarchyFields,
  tileQueryOutputAliases,
  type DatasetHierarchyDrillResult,
  type TileQuery,
} from '@zlens/core/apps/tile-query';
import type { DatasetDescriptor, DatasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { sourceDisplayName } from './source-names';
import type {
  DashboardDatasetCrossFilter,
  DashboardDatasetHierarchyDrill,
  DashboardDocumentResponse,
} from '../../api/client';

type DashboardPage = DashboardDocumentResponse['dashboard'];
type DashboardTile = DashboardPage['layout']['items'][number];

/**
 * Return only fields that the page author explicitly mapped as cross-filter
 * origins. A familiar output label is not an implicit interaction contract.
 */
export function datasetCrossFilterFields(page: DashboardPage, tile: DashboardTile): string[] {
  if (!tile.query) return [];
  const mapped = new Set((page.interactions?.crossFilter?.mappings ?? [])
    .filter((mapping) => mapping.fromTileId === tile.i)
    .map((mapping) => mapping.fromField));
  return tileQueryOutputAliases(tile.query)
    .filter((output) => output.kind === 'dimension' && mapped.has(output.alias))
    .map((output) => output.alias);
}

/** Preserve actual scalar result values and deduplicate them deterministically. */
export function uniqueDatasetMarkValues(values: unknown[]): unknown[] {
  const unique = new Map<string, unknown>();
  for (const value of values) {
    if (value === undefined || value === null || typeof value === 'object') continue;
    const key = JSON.stringify(value);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

export type DatasetHierarchyDrillCandidate = {
  hierarchyId: string;
  fromField: string;
  fromAlias: string;
  toField: string;
};

/**
 * A drill target comes only from an authored physical-field hierarchy and the
 * tile's active grouping. Labels, result column names, and row shapes cannot
 * invent a hierarchy. The returned alias is the one a chart/table actually
 * emitted, so a mark carries the exact selected field value into the core
 * query transition.
 */
export function datasetHierarchyDrillCandidates(
  descriptor: DatasetDescriptor,
  query: TileQuery,
): DatasetHierarchyDrillCandidate[] {
  // Never offer a drill the runtime would refuse: row details, or a next level already grouped.
  if (query.detail) return [];
  const grouped = new Set(query.dimensions.map((dimension) => dimension.field.toLowerCase()));
  return query.dimensions.flatMap((dimension) => {
    const field = datasetPhysicalFieldForReference(descriptor, dimension.field);
    const hierarchyId = field?.hierarchy?.id;
    if (!field || !hierarchyId) return [];
    const levels = datasetHierarchyFields(descriptor, hierarchyId);
    const next = levels.find((candidate) => candidate.hierarchy?.level === field.hierarchy!.level + 1);
    if (!next || grouped.has(next.name.toLowerCase())) return [];
    const fromAlias = dimension.alias ?? (dimension.timeGrain ? `${field.name}_${dimension.timeGrain}` : field.name);
    return [{ hierarchyId, fromField: field.name, fromAlias, toField: next.name }];
  });
}

export type DatasetHierarchyDrillSelection =
  | ({ status: 'ready'; candidate: DatasetHierarchyDrillCandidate } & Extract<DatasetHierarchyDrillResult, { status: 'ready' }>)
  | Extract<DatasetHierarchyDrillResult, { status: 'blocked' }>;

export type RuntimeDatasetHierarchyDrillCandidate = {
  hierarchyId: string;
  fromField: string;
  fromAlias: string;
  toField: string;
};

/** A visible choice for what a chart/table mark does on this exact result. */
export type DatasetMarkAction =
  | { id: 'filter'; kind: 'filter' }
  | { id: string; kind: 'drill'; candidate: RuntimeDatasetHierarchyDrillCandidate };

/**
 * A tile can be both a declared cross-filter origin and a declared hierarchy
 * level. Keep that ambiguity explicit instead of silently changing the mark
 * contract when a hierarchy is added later.
 */
export function datasetMarkActions(
  selectableFields: string[],
  hierarchyCandidates: RuntimeDatasetHierarchyDrillCandidate[],
): DatasetMarkAction[] {
  const actions: DatasetMarkAction[] = selectableFields.length > 0 ? [{ id: 'filter', kind: 'filter' }] : [];
  const seen = new Set<string>();
  for (const candidate of hierarchyCandidates) {
    const id = `drill:${candidate.hierarchyId}:${candidate.fromField}:${candidate.fromAlias}:${candidate.toField}`;
    if (seen.has(id)) continue;
    seen.add(id);
    actions.push({ id, kind: 'drill', candidate });
  }
  return actions;
}

/**
 * Convert one settled row/mark into the immutable next TileQuery. The browser
 * can only choose among declared candidates; core validation rechecks level,
 * values, output aliases, and the resulting operation contract.
 */
export function buildDatasetHierarchyDrill(
  descriptor: DatasetDescriptor,
  query: TileQuery,
  outputAlias: string,
  row: Record<string, unknown>,
): DatasetHierarchyDrillSelection {
  const candidate = datasetHierarchyDrillCandidates(descriptor, query)
    .find((item) => item.fromAlias === outputAlias);
  if (!candidate) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_UNKNOWN',
      message: `No declared hierarchy drill is available from ${outputAlias}.`,
    };
  }
  const values = uniqueDatasetMarkValues([row[outputAlias]]);
  const drilled = applyDatasetHierarchyDrill({
    descriptor,
    query,
    hierarchyId: candidate.hierarchyId,
    fromField: candidate.fromField,
    values,
  });
  return drilled.status === 'ready' ? { ...drilled, candidate } : drilled;
}

/**
 * Add one actual result-mark selection to the ephemeral viewer drill stack.
 * The candidate itself came from the server's current descriptor projection;
 * the server will replay all prior steps against the authored query again.
 */
export function appendDatasetHierarchyDrill(
  current: DashboardDatasetHierarchyDrill[],
  tileId: string,
  candidate: RuntimeDatasetHierarchyDrillCandidate,
  row: Record<string, unknown>,
): { drills?: DashboardDatasetHierarchyDrill[]; error?: string } {
  const values = uniqueDatasetMarkValues([row[candidate.fromAlias]]);
  if (values.length === 0) {
    return { error: `Select a concrete ${candidate.fromAlias} value to drill down.` };
  }
  const existing = current.find((drill) => drill.tileId === tileId);
  const next: DashboardDatasetHierarchyDrill = {
    tileId,
    steps: [
      ...(existing?.steps ?? []),
      { hierarchyId: candidate.hierarchyId, fromField: candidate.fromField, values },
    ],
  };
  return { drills: [...current.filter((drill) => drill.tileId !== tileId), next] };
}

/** Return to the previous declared grouping without mutating the saved page. */
export function popDatasetHierarchyDrill(
  current: DashboardDatasetHierarchyDrill[],
  tileId: string,
): DashboardDatasetHierarchyDrill[] {
  return current.flatMap((drill) => {
    if (drill.tileId !== tileId) return [drill];
    const steps = drill.steps.slice(0, -1);
    return steps.length > 0 ? [{ ...drill, steps }] : [];
  });
}

/**
 * Select one exact, declared dimension value from a table row or chart mark.
 * The caller still resolves the selection through its authored source mapping;
 * this helper only keeps both visual affordances on the same typed path.
 */
export function datasetMarkSelectionForRow(
  selectableFields: string[],
  row: Record<string, unknown>,
): { field: string; values: unknown[] } | undefined {
  for (const field of selectableFields) {
    const values = uniqueDatasetMarkValues([row[field]]);
    if (values.length > 0) return { field, values };
  }
  return undefined;
}

/**
 * Build a source-qualified result-mark selection. This deliberately validates
 * only browser-known invariants; the server revalidates revision, field and
 * target mapping against the active governed Dataset before execution.
 */
export function buildDatasetCrossFilter(
  page: DashboardPage,
  tile: DashboardTile,
  field: string,
  values: unknown[],
  options: { exclude?: boolean } = {},
): { crossFilter?: DashboardDatasetCrossFilter; error?: string } {
  if (!tile.query || !tile.sourceId || !tile.sourceRevision) {
    return { error: 'This result is not backed by a source-qualified tile.' };
  }
  const output = tileQueryOutputAliases(tile.query)
    .find((candidate) => candidate.kind === 'dimension' && candidate.alias === field);
  if (!output) return { error: `“${field}” is not a selectable dimension on this tile.` };
  const mappings = page.interactions?.crossFilter?.mappings.filter((mapping) => (
    mapping.fromTileId === tile.i && mapping.fromField === output.alias
  )) ?? [];
  // Keep only / Exclude on the tile's own Dataset needs no mapping: it is the
  // same Dataset and the same field (RFC 0009 step 6a). A period is not a value.
  const own = tile.query.dimensions.some((dimension) => !dimension.timeGrain && (dimension.alias ?? dimension.field) === output.alias)
    && Boolean(ownDatasetBinding(page, tile));
  if (mappings.length === 0 && !own) return { error: `No filter link is set up for ${field}.` };
  const unknownTarget = mappings.find((mapping) => !page.datasets?.some((dataset) => dataset.id === mapping.toDataset));
  if (unknownTarget) return { error: `The mapping for ${field} refers to data that is no longer on this page.` };
  const selected = uniqueDatasetMarkValues(values);
  if (selected.length === 0) return { error: `Select a concrete ${field} value to filter mapped tiles.` };
  return {
    crossFilter: {
      fromTileId: tile.i,
      fromSourceId: tile.sourceId,
      fromSourceRevision: tile.sourceRevision,
      field: output.alias,
      values: selected,
      ...(options.exclude ? { exclude: true } : {}),
    },
  };
}

/** The page's Dataset binding a tile runs on, if any. */
export function ownDatasetBinding(page: DashboardPage, tile: DashboardTile) {
  return page.datasets?.find((dataset) => dataset.sourceId === tile.sourceId && dataset.sourceRevision === tile.sourceRevision);
}

/** Replace one source-field selection while preserving other selected marks. */
export function replaceDatasetCrossFilter(
  current: DashboardDatasetCrossFilter[],
  next: DashboardDatasetCrossFilter,
): DashboardDatasetCrossFilter[] {
  return [
    ...current.filter((candidate) => !(
      candidate.fromTileId === next.fromTileId
      && candidate.fromSourceId === next.fromSourceId
      && candidate.fromSourceRevision === next.fromSourceRevision
      && candidate.field === next.field
    )),
    next,
  ];
}

export function removeDatasetCrossFilter(
  current: DashboardDatasetCrossFilter[],
  fromTileId: string,
  field: string,
): DashboardDatasetCrossFilter[] {
  return current.filter((candidate) => !(candidate.fromTileId === fromTileId && candidate.field === field));
}

/**
 * Return the authored origin and target tiles affected by the current mark
 * selections. This is only a scheduling hint: the runtime still validates the
 * exact source/revision and mapping before it applies a predicate.
 */
export function datasetAffectedTileIds(
  page: DashboardPage,
  crossFilters: DashboardDatasetCrossFilter[],
): string[] {
  const affected = new Set<string>();
  for (const crossFilter of crossFilters) {
    affected.add(crossFilter.fromTileId);
    // Keep only / Exclude reach every tile on the origin's own Dataset.
    const origin = page.layout.items.find((tile) => tile.i === crossFilter.fromTileId);
    const own = origin ? ownDatasetBinding(page, origin) : undefined;
    if (own) for (const tile of page.layout.items) if (tile.sourceId === own.sourceId && tile.sourceRevision === own.sourceRevision) affected.add(tile.i);
    const mappings = page.interactions?.crossFilter?.mappings ?? [];
    for (const mapping of mappings) {
      if (mapping.fromTileId !== crossFilter.fromTileId || mapping.fromField !== crossFilter.field) continue;
      const binding = page.datasets?.find((dataset) => dataset.id === mapping.toDataset);
      if (!binding) continue;
      for (const tile of page.layout.items) {
        if (tile.sourceId === binding.sourceId && tile.sourceRevision === binding.sourceRevision) affected.add(tile.i);
      }
    }
  }
  return [...affected].sort();
}

function datasetPhysicalFieldForReference(
  descriptor: DatasetDescriptor,
  reference: string,
): DatasetPhysicalField | undefined {
  return descriptor.fields.find((field): field is DatasetPhysicalField => field.kind === 'physical'
    && (field.name === reference || field.qualifiedId === reference));
}

export interface DatasetCrossFilterLinkProposal {
  fromField: string;
  fieldLabel: string;
  mappings: Array<{ fromTileId: string; fromField: string; toDataset: string; toField: string }>;
  targetLabels: string[];
}

/**
 * Suggest cross-filter links for a grouped tile that has none yet. A target is
 * proposed only where a page Dataset has an approved physical field with the
 * same name and type as the tile's grouping field. This is a proposal for the
 * author to confirm with one click; the runtime still filters only through the
 * saved mappings and never matches names on its own.
 */
export function proposeDatasetCrossFilterLinks(input: {
  page: DashboardPage;
  tile: DashboardTile;
  descriptorFor: (binding: NonNullable<DashboardPage['datasets']>[number]) => DatasetDescriptor | undefined;
}): DatasetCrossFilterLinkProposal | undefined {
  const { page, tile } = input;
  if (!tile.query || tile.query.detail || !tile.sourceId) return undefined;
  const ownBinding = (page.datasets ?? []).find((binding) => binding.sourceId === tile.sourceId && binding.sourceRevision === tile.sourceRevision);
  const ownDescriptor = ownBinding ? input.descriptorFor(ownBinding) : undefined;
  if (!ownDescriptor) return undefined;
  const mapped = new Set((page.interactions?.crossFilter?.mappings ?? []).filter((mapping) => mapping.fromTileId === tile.i).map((mapping) => mapping.fromField));
  const outputs = tileQueryOutputAliases(tile.query).filter((output) => output.kind === 'dimension');
  for (const [index, dimension] of tile.query.dimensions.entries()) {
    if (dimension.timeGrain) continue;
    const alias = outputs[index]?.alias;
    if (!alias || mapped.has(alias)) continue;
    const field = datasetPhysicalFieldForReference(ownDescriptor, dimension.field);
    if (!field) continue;
    const mappings: DatasetCrossFilterLinkProposal['mappings'] = [];
    const targetLabels: string[] = [];
    for (const binding of page.datasets ?? []) {
      const descriptor = input.descriptorFor(binding);
      const target = descriptor?.fields.find((candidate): candidate is DatasetPhysicalField => (
        candidate.kind === 'physical'
        && candidate.status === 'approved'
        && candidate.name.toLowerCase() === field.name.toLowerCase()
        && candidate.type === field.type
      ));
      if (!descriptor || !target) continue;
      mappings.push({ fromTileId: tile.i, fromField: alias, toDataset: binding.id, toField: target.name });
      // "Beverage Revenue By Product", never the saved query's id (new-user round 2, problem 9).
      targetLabels.push(sourceDisplayName(descriptor.id, descriptor.label));
    }
    if (mappings.length) return { fromField: alias, fieldLabel: field.name, mappings, targetLabels };
  }
  return undefined;
}

/**
 * Values to carry into a detail page. A carried filter keeps its own page
 * value when it has one. When it has none but the author clicked a mark on the
 * navigating tile, and that filter is bound (on the tile's Dataset) to the same
 * field the mark came from, the clicked values become the carried value — so
 * "click US, open details" opens US details. Nothing is carried by name alone.
 */
export function carriedNavigationVariables(input: {
  page: DashboardPage;
  tile: DashboardTile;
  carryFilterIds: string[];
  variables: Record<string, unknown>;
  crossFilters: DashboardDatasetCrossFilter[];
}): Record<string, unknown> {
  const next = { ...input.variables };
  if (!input.tile.query) return next;
  const binding = (input.page.datasets ?? []).find((candidate) => candidate.sourceId === input.tile.sourceId && candidate.sourceRevision === input.tile.sourceRevision);
  if (!binding) return next;
  const outputs = tileQueryOutputAliases(input.tile.query).filter((output) => output.kind === 'dimension');
  for (const filterId of input.carryFilterIds) {
    const current = next[filterId];
    if (current !== undefined && current !== null && current !== '' && !(Array.isArray(current) && current.length === 0)) continue;
    const filter = input.page.filters?.find((candidate) => candidate.id === filterId);
    const boundField = filter?.datasetBindings?.[binding.id]?.field;
    if (!filter || !boundField) continue;
    for (const mark of input.crossFilters.filter((candidate) => candidate.fromTileId === input.tile.i)) {
      const index = outputs.findIndex((output) => output.alias === mark.field);
      const markField = index >= 0 ? input.tile.query.dimensions[index]?.field : undefined;
      if (markField !== boundField || input.tile.query.dimensions[index]?.timeGrain) continue;
      next[filterId] = filter.type === 'multiselect' || mark.values.length > 1 ? [...mark.values] : mark.values[0];
      break;
    }
  }
  return next;
}
