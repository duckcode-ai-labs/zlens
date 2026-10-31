/**
 * Node-only filesystem loaders for the YAML semantic layer.
 *
 * This module is intentionally separate from `yaml-loader.ts` (which is
 * browser-safe: pure string/object parsing and serialization) because it
 * imports `node:fs`/`node:path`. Keeping the filesystem traversal here means
 * the browser-reachable barrel never drags node builtins into a browser
 * bundle. Node consumers import filesystem loaders from here (or the semantic
 * barrel, which re-exports from here); browser consumers use the pure helpers
 * in `yaml-loader.ts`.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
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
} from './semantic-layer.js';
import { expandDefinitions, addIfNamed } from './yaml-loader.js';

/**
 * Load a SemanticLayer from a directory on disk.
 * Expected structure:
 *   semanticLayerDir/
 *     metrics/       → *.yaml metric definitions
 *     dimensions/    → *.yaml dimension definitions
 *     entities/      → *.yaml entity definitions
 *     semantic_models/ → *.yaml semantic model declarations
 *     hierarchies/   → *.yaml hierarchy definitions
 *     cubes/         → *.yaml cube definitions
 *     segments/      → *.yaml segment definitions
 *     pre_aggregations/ → *.yaml pre-aggregation definitions
 *     blocks/        → *.yaml block companion definitions (metadata only, not loaded into layer)
 *
 * `_drafts/` folders are skipped: a draft answers nothing until a person
 * approves it out of there. {@link loadSemanticMetricDraftsFromDir} reads them
 * for review.
 */
export function loadSemanticLayerFromDir(semanticLayerDir: string): SemanticLayer {
  const layer = new SemanticLayer();

  const subdirs: Array<{ folder: string; keys: string[]; loader: (raw: Record<string, unknown>) => void }> = [
    { folder: 'metrics', keys: ['metrics'], loader: (raw) => addIfNamed(parseMetricDefinition(raw), (item) => layer.addMetric(item)) },
    { folder: 'dimensions', keys: ['dimensions'], loader: (raw) => addIfNamed(parseDimensionDefinition(raw), (item) => layer.addDimension(item)) },
    { folder: 'entities', keys: ['entities'], loader: (raw) => addIfNamed(parseEntityDefinition(raw), (item) => layer.addEntity(item)) },
    { folder: 'semantic_models', keys: ['semantic_models', 'semanticModels'], loader: (raw) => addIfNamed(parseSemanticModelDefinition(raw), (item) => layer.addSemanticModel(item)) },
    { folder: 'hierarchies', keys: ['hierarchies'], loader: (raw) => addIfNamed(parseHierarchyDefinition(raw), (item) => layer.addHierarchy(item)) },
    { folder: 'cubes', keys: ['cubes'], loader: (raw) => addIfNamed(parseCubeDefinition(raw), (item) => layer.addCube(item)) },
    { folder: 'segments', keys: ['segments'], loader: (raw) => addIfNamed(parseSegmentDefinition(raw), (item) => layer.addSegment(item)) },
    { folder: 'pre_aggregations', keys: ['pre_aggregations', 'preAggregations'], loader: (raw) => addIfNamed(parsePreAggregationDefinition(raw), (item) => layer.addPreAggregation(item)) },
  ];

  for (const { folder, keys, loader } of subdirs) {
    const dir = join(semanticLayerDir, folder);
    if (!existsSync(dir)) continue;
    for (const filePath of collectYamlFiles(dir)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const raw = yaml.load(content) as Record<string, unknown>;
        if (raw && typeof raw === 'object') {
          for (const item of expandDefinitions(raw, keys)) {
            loader(withLocalSemanticSource(item, semanticLayerDir, filePath, folder));
          }
        }
      } catch {
        // Skip malformed YAML files
      }
    }
  }

  return layer;
}

/**
 * The metric drafts under `metrics/_drafts/` (composted, or converted from a
 * BI file), for the places that review them. Never added to a layer.
 */
export function loadSemanticMetricDraftsFromDir(semanticLayerDir: string): MetricDefinition[] {
  const dir = join(semanticLayerDir, 'metrics', '_drafts');
  if (!existsSync(dir)) return [];
  const drafts: MetricDefinition[] = [];
  for (const filePath of collectYamlFiles(dir, { includeDrafts: true })) {
    try {
      const raw = yaml.load(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') continue;
      for (const item of expandDefinitions(raw, ['metrics'])) {
        addIfNamed(parseMetricDefinition(withLocalSemanticSource(item, semanticLayerDir, filePath, 'metrics')), (metric) => drafts.push(metric));
      }
    } catch {
      // Skip malformed YAML files
    }
  }
  return drafts;
}

function withLocalSemanticSource(
  raw: Record<string, unknown>,
  semanticLayerDir: string,
  filePath: string,
  folder: string,
): Record<string, unknown> {
  const existing = raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)
    ? raw.source as Record<string, unknown>
    : {};
  const existingExtra = existing.extra && typeof existing.extra === 'object' && !Array.isArray(existing.extra)
    ? existing.extra as Record<string, unknown>
    : {};
  const relativePath = relative(semanticLayerDir, filePath).replace(/\\/g, '/');
  const objectName = typeof raw.name === 'string' ? raw.name : undefined;
  return {
    ...raw,
    source: {
      ...existing,
      provider: typeof existing.provider === 'string' ? existing.provider : 'dql',
      objectType: typeof existing.objectType === 'string' ? existing.objectType : semanticObjectTypeForFolder(folder),
      objectId: typeof existing.objectId === 'string' ? existing.objectId : objectName ?? relativePath,
      objectName: typeof existing.objectName === 'string' ? existing.objectName : objectName,
      extra: {
        ...existingExtra,
        path: typeof existingExtra.path === 'string' ? existingExtra.path : relativePath,
        raw: existingExtra.raw ?? raw,
      },
    },
  };
}

function semanticObjectTypeForFolder(folder: string): string {
  if (folder === 'entities') return 'entity';
  if (folder === 'semantic_models') return 'semantic_model';
  if (folder === 'pre_aggregations') return 'pre_aggregation';
  return folder.replace(/s$/, '');
}

function collectYamlFiles(dir: string, options: { includeDrafts?: boolean } = {}): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        if (entry === '_drafts' && !options.includeDrafts) continue;
        results.push(...collectYamlFiles(filePath, options));
      } else if (stat.isFile() && (extname(entry) === '.yaml' || extname(entry) === '.yml')) {
        results.push(filePath);
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return results;
}
