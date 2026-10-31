/**
 * YAML-based semantic layer loader (browser-safe).
 *
 * This module contains only pure string/object parsing and serialization —
 * no filesystem access — so it is safe to include in browser bundles. The
 * node-only directory loaders (`loadSemanticLayerFromDir`) that read from disk
 * live in the sibling `yaml-loader.node.ts` to keep `node:fs`/`node:path` out
 * of the browser-reachable import graph.
 */

import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseEntityDefinition,
  parseSemanticModelDefinition,
  parseHierarchyDefinition,
  parseCubeDefinition,
  parseSegmentDefinition,
  parsePreAggregationDefinition,
  type MetricDefinition,
  type DimensionDefinition,
} from './semantic-layer.js';

/**
 * Load a SemanticLayer from pre-read file contents (no filesystem access needed).
 * Useful for browser contexts or when files are already loaded.
 */
export function loadSemanticLayerFromConfig(
  files: Array<{ path: string; content: string }>,
): SemanticLayer {
  const layer = new SemanticLayer();

  for (const file of files) {
    try {
      const raw = yaml.load(file.content) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') continue;

      const pathLower = file.path.toLowerCase();
      if (pathLower.includes('/metrics/') || pathLower.includes('\\metrics\\')) {
        for (const item of expandDefinitions(raw, ['metrics'])) {
          addIfNamed(parseMetricDefinition(item), (parsed) => layer.addMetric(parsed));
        }
      } else if (pathLower.includes('/dimensions/') || pathLower.includes('\\dimensions\\')) {
        for (const item of expandDefinitions(raw, ['dimensions'])) {
          addIfNamed(parseDimensionDefinition(item), (parsed) => layer.addDimension(parsed));
        }
      } else if (pathLower.includes('/entities/') || pathLower.includes('\\entities\\')) {
        for (const item of expandDefinitions(raw, ['entities'])) {
          addIfNamed(parseEntityDefinition(item), (parsed) => layer.addEntity(parsed));
        }
      } else if (pathLower.includes('/semantic_models/') || pathLower.includes('\\semantic_models\\')) {
        for (const item of expandDefinitions(raw, ['semantic_models', 'semanticModels'])) {
          addIfNamed(parseSemanticModelDefinition(item), (parsed) => layer.addSemanticModel(parsed));
        }
      } else if (pathLower.includes('/hierarchies/') || pathLower.includes('\\hierarchies\\')) {
        for (const item of expandDefinitions(raw, ['hierarchies'])) {
          addIfNamed(parseHierarchyDefinition(item), (parsed) => layer.addHierarchy(parsed));
        }
      } else if (pathLower.includes('/cubes/') || pathLower.includes('\\cubes\\')) {
        for (const item of expandDefinitions(raw, ['cubes'])) {
          addIfNamed(parseCubeDefinition(item), (parsed) => layer.addCube(parsed));
        }
      } else if (pathLower.includes('/segments/') || pathLower.includes('\\segments\\')) {
        for (const item of expandDefinitions(raw, ['segments'])) {
          addIfNamed(parseSegmentDefinition(item), (parsed) => layer.addSegment(parsed));
        }
      } else if (pathLower.includes('/pre_aggregations/') || pathLower.includes('\\pre_aggregations\\')) {
        for (const item of expandDefinitions(raw, ['pre_aggregations', 'preAggregations'])) {
          addIfNamed(parsePreAggregationDefinition(item), (parsed) => layer.addPreAggregation(parsed));
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  return layer;
}

/**
 * Serialize a MetricDefinition back into stable semantic-layer YAML.
 * Used by governance flows that propose human-reviewed semantic changesets.
 */
export function serializeMetricDefinitionToYaml(metric: MetricDefinition): string {
  return dumpSemanticYaml(stripUndefined({
    name: metric.name,
    label: metric.label,
    description: metric.description,
    domain: metric.domain,
    status: metric.status,
    sql: metric.sql,
    type: metric.type,
    table: metric.table,
    filters: metric.filters,
    filter: metric.filter,
    synonyms: metric.synonyms,
    tags: metric.tags,
    owner: metric.owner,
    cube: metric.cube,
    aggregation: metric.aggregation,
    metricType: metric.metricType,
    typeParams: metric.typeParams,
    aggTimeDimension: metric.aggTimeDimension,
    source: serializeSourceMetadata(metric.source),
  }));
}

/**
 * Serialize a DimensionDefinition back into stable semantic-layer YAML.
 * This mirrors the metric serializer so future composting can propose reusable
 * dimensions without hand-building YAML strings.
 */
export function serializeDimensionDefinitionToYaml(dimension: DimensionDefinition): string {
  return dumpSemanticYaml(stripUndefined({
    name: dimension.name,
    label: dimension.label,
    description: dimension.description,
    domain: dimension.domain,
    status: dimension.status,
    sql: dimension.sql,
    type: dimension.type,
    table: dimension.table,
    tags: dimension.tags,
    owner: dimension.owner,
    cube: dimension.cube,
    expr: dimension.expr,
    isTimeDimension: dimension.isTimeDimension,
    typeParams: dimension.typeParams,
    source: serializeSourceMetadata(dimension.source),
  }));
}

/**
 * Expand a raw YAML document into individual definition records. Shared by the
 * browser-safe config loader and the node-only directory loader.
 */
export function expandDefinitions(raw: Record<string, unknown>, collectionKeys: string[]): Record<string, unknown>[] {
  for (const key of collectionKeys) {
    const collection = raw[key];
    if (Array.isArray(collection)) {
      return collection.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    }
  }
  if (typeof raw.name === 'string' && raw.name.trim().length > 0) return [raw];
  return [];
}

function dumpSemanticYaml(value: Record<string, unknown>): string {
  return yaml.dump(value, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function serializeSourceMetadata(source: MetricDefinition['source'] | DimensionDefinition['source']): Record<string, unknown> | undefined {
  if (!source) return undefined;
  return stripUndefined({
    provider: source.provider,
    objectType: source.objectType,
    objectId: source.objectId,
    objectName: source.objectName,
    importedAt: source.importedAt,
    extra: source.extra,
  });
}

/** Add a definition to the layer only when it has a non-empty name. Shared helper. */
export function addIfNamed<T extends { name: string }>(item: T, add: (item: T) => void): void {
  if (item.name.trim().length > 0) add(item);
}
