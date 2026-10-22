/**
 * Shared lineage constants, types, and color mappings.
 * Centralizes all lineage-related visual constants to avoid duplication
 * across LineageDAG, LineagePanel, CellLineage, and BlockStudio.
 */

// ---- Shared TypeScript interfaces ----

export interface LineageNode {
  id: string;
  type: string;
  name: string;
  layer?: string;
  domain?: string;
  status?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface LineageEdge {
  source: string;
  target: string;
  type: string;
  sourceDomain?: string;
  targetDomain?: string;
}

export interface LineagePath {
  nodes: LineageNode[];
  edges: LineageEdge[];
  layers: string[];
}

export interface CompletePathResult {
  focalNode: LineageNode;
  upstreamPaths: LineagePath[];
  downstreamPaths: LineagePath[];
  layerSummary: Record<string, number>;
}

// ---- Node type colors ----

// Paper-handoff lineage palette (Lineage Redesign.dc.html): mid-tone hues
// that read on the warm Paper canvas and stay legible on obsidian/white.
export const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8a8d96',
  dbt_model: '#4a74c9',
  dbt_source: '#4a74c9',
  term: '#0a6b5e',
  block: '#b26b1f',
  business_view: '#c14545',
  metric: '#5b4fd1',
  dimension: '#0a6b5e',
  domain: '#7c5cff',
  chart: '#c14590',
  notebook: '#2e8b57',
  dashboard: '#2e8b57',
  app: '#2e8b57',
};

// ---- Short type labels (for badges) ----

export const TYPE_LABELS: Record<string, string> = {
  source_table: 'TBL',
  dbt_model: 'DBT',
  dbt_source: 'SRC',
  term: 'TERM',
  block: 'BLK',
  business_view: 'VIEW',
  metric: 'MET',
  dimension: 'DIM',
  domain: 'DOM',
  chart: 'CHT',
  notebook: 'NB',
  dashboard: 'DASH',
  app: 'APP',
};

// ---- Full type titles ----

export const TYPE_TITLES: Record<string, string> = {
  source_table: 'Source Table',
  dbt_model: 'dbt Model',
  dbt_source: 'dbt Source',
  term: 'Business Term',
  block: 'Saved query',
  business_view: 'Business View',
  metric: 'Metric',
  dimension: 'Dimension',
  domain: 'Domain',
  chart: 'Chart',
  notebook: 'Notebook',
  dashboard: 'Dashboard',
  app: 'App',
};

// ---- Edge type colors ----

export const EDGE_TYPE_COLORS: Record<string, string> = {
  reads_from: '#8b949e',
  feeds_into: '#56d364',
  defines: '#39c5cf',
  composes: '#f2cc60',
  aggregates: '#388bfd',
  visualizes: '#f778ba',
  depends_on: '#ff7b72',
  contains: '#d2a8ff',
  crosses_domain: '#d2a8ff',
  certified_by: '#56d364',
  replaced_by: '#f85149',
};

// ---- Edge type titles ----

export const EDGE_TITLES: Record<string, string> = {
  reads_from: 'reads from',
  feeds_into: 'feeds into',
  defines: 'defines',
  composes: 'composes into',
  aggregates: 'aggregates into',
  visualizes: 'visualizes',
  depends_on: 'dbt depends on',
  contains: 'contains',
  crosses_domain: 'crosses domain',
  certified_by: 'certified by',
  replaced_by: 'replaced by',
};

/**
 * Edges drawn with a visible label and a dashed line: they record a
 * relationship, not data flow. A retired block points at its replacement.
 */
export function lineageEdgeLabel(type: string): string | undefined {
  return type === 'replaced_by' ? EDGE_TITLES.replaced_by : undefined;
}

// ---- Lineage layer constants ----

export type LineageLayerName = 'source' | 'transform' | 'answer' | 'consumption';

export const LAYER_COLORS: Record<LineageLayerName, string> = {
  source: '#79c0ff',
  transform: '#ff7b72',
  answer: '#56d364',
  consumption: '#d2a8ff',
};

export const LAYER_LABELS: Record<LineageLayerName, string> = {
  source: 'Sources',
  transform: 'Transform',
  answer: 'Answer',
  consumption: 'Consumption',
};

export const LAYER_ORDER: LineageLayerName[] = ['source', 'transform', 'answer', 'consumption'];

// ---- Filter groups ----

export const LINEAGE_NODE_TYPE_ORDER = [
  'term',
  'business_view',
  'block',
  'metric',
  'dimension',
  'domain',
  'source_table',
  'dbt_source',
  'dbt_model',
  'chart',
  'notebook',
  'dashboard',
  'app',
] as const;

export const TECHNICAL_LINEAGE_NODE_TYPES = [
  'source_table',
  'dbt_source',
  'dbt_model',
] as const;

/** Governed business meaning, including the semantic and certified answer layer. */
export const DOMAIN_LINEAGE_NODE_TYPES = [
  'term',
  'domain',
  'business_view',
  'metric',
  'dimension',
  'block',
] as const;

/** @deprecated Prefer DOMAIN_LINEAGE_NODE_TYPES for the user-facing lineage mode. */
export const BUSINESS_LINEAGE_NODE_TYPES = [
  ...DOMAIN_LINEAGE_NODE_TYPES,
] as const;

export const CONSUMPTION_LINEAGE_NODE_TYPES = [
  'block',
  'business_view',
  'chart',
  'notebook',
  'dashboard',
  'app',
] as const;

// ---- Status colors ----

export const STATUS_COLORS: Record<string, string> = {
  certified: '#56d364',
  draft: '#8b949e',
  review: '#e3b341',
  deprecated: '#f85149',
};

// ---- Helpers ----

/** Get the layer for a node based on its type (fallback if layer not set) */
export function getNodeLayer(node: LineageNode): LineageLayerName {
  if (node.layer) return node.layer as LineageLayerName;
  switch (node.type) {
    case 'source_table':
    case 'dbt_source':
      return 'source';
    case 'dbt_model':
      return 'transform';
    case 'term':
    case 'block':
    case 'business_view':
    case 'metric':
    case 'dimension':
    case 'domain':
      return 'answer';
    case 'chart':
    case 'notebook':
    case 'dashboard':
    case 'app':
      return 'consumption';
    default:
      return 'answer';
  }
}

/** Format a node label with its type badge for display */
export function formatNodeLabel(node: LineageNode): string {
  const label = TYPE_LABELS[node.type] ?? node.type.slice(0, 3).toUpperCase();
  return `[${label}] ${node.name}`;
}
