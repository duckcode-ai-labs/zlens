/**
 * Lineage Builder — assembles the full answer-layer lineage graph.
 *
 * Walks DQL blocks and semantic layer definitions to build a complete
 * LineageGraph connecting source tables → blocks → metrics → charts,
 * with domain boundaries and certification edges.
 */

import { isDeprecatedStatus, resolveBlockReference } from '../manifest/retirement.js';
import { readerTableName } from './reader-functions.js';
import { extractTablesFromSql } from './sql-parser.js';
import { LineageGraph, getLayerForNodeType } from './lineage-graph.js';

// ---- Input types (kept simple to avoid coupling to specific packages) ----

export interface LineageBlockInput {
  name: string;
  sql: string;
  domain?: string;
  owner?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  certifiedBy?: string;
  /** Block type: custom, semantic, etc. */
  blockType?: string;
  /** Metric reference for semantic blocks */
  metricRef?: string;
  /** Metric references for semantic blocks */
  metricsRef?: string[];
  /** Dimension references for semantic blocks */
  dimensionsRef?: string[];
  /** Chart type from visualization config */
  chartType?: string;
  /** Materialized table/view name */
  materializedAs?: string;
  /** File path of the block definition */
  filePath?: string;
  description?: string;
  businessOutcome?: string;
  reviewCadence?: string;
  tests?: string[];
  /** Business glossary terms this block implements or depends on. */
  termRefs?: string[];
  pattern?: string;
  grain?: string;
  entities?: string[];
  declaredOutputs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  parameterPolicy?: Array<{ name: string; policy: string }>;
  filterBindings?: Array<{ filter: string; binding: string }>;
  sourceSystems?: string[];
  replacementFor?: string[];
  /** Deprecated block: the block reference that supersedes it. */
  replacedBy?: string;
  /** Deprecated block: retirement date, YYYY-MM-DD. */
  deprecatedOn?: string;
}

export interface LineageMetricInput {
  name: string;
  table: string;
  domain?: string;
  type: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  owner?: string;
  filePath?: string;
  description?: string;
  sql?: string;
  tags?: string[];
}

export interface LineageDimensionInput {
  name: string;
  table: string;
  domain?: string;
  type?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  owner?: string;
  filePath?: string;
  description?: string;
  sql?: string;
  tags?: string[];
}

export interface LineageBuilderOptions {
  /** Known block names for implicit dependency resolution */
  blockNames?: Set<string>;
  dbtModels?: LineageDbtModelInput[];
  dashboards?: LineageDashboardInput[];
  businessViews?: LineageBusinessViewInput[];
  terms?: LineageTermInput[];
  domains?: LineageDomainInput[];
  /**
   * Apps (consumption-layer artifacts) that contain dashboards. App nodes sit
   * above the matching dashboard nodes in the graph and inherit the App's
   * declared `domain` so cross-domain analysis remains accurate.
   */
  apps?: LineageAppInput[];
}

export interface LineageDomainInput {
  name: string;
  owner?: string;
  businessOwner?: string;
  boundedContext?: string;
  filePath?: string;
  sourceSystems?: string[];
  primaryTerms?: string[];
  reviewCadence?: string;
  businessOutcome?: string;
  tags?: string[];
}

export interface LineageBusinessViewInput {
  name: string;
  domain?: string;
  owner?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  filePath?: string;
  description?: string;
  businessOutcome?: string;
  reviewCadence?: string;
  blockRefs: string[];
  businessViewRefs: string[];
  termRefs?: string[];
  declaredTermRefs?: string[];
}

export interface LineageTermInput {
  name: string;
  domain?: string;
  owner?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  termType?: string;
  filePath?: string;
  description?: string;
  identifiers?: string[];
  synonyms?: string[];
  businessOutcome?: string;
  reviewCadence?: string;
}

export interface LineageAppInput {
  id: string;
  name: string;
  domain?: string;
  owner?: string;
  filePath?: string;
  /** Dashboard ids contained by this App (matched against `dashboard:<id>` nodes). */
  dashboards: string[];
}

export interface LineageDbtModelInput {
  name: string;
  uniqueId: string;
  type: 'model' | 'source';
  dependsOn: string[];
  columns?: Array<{ name: string; type?: string; description?: string }>;
  schema?: string;
  database?: string;
  materialized?: string;
  description?: string;
}

export interface LineageDashboardInput {
  name: string;
  kind?: 'dashboard' | 'notebook';
  blocks: string[];
  charts: string[];
  /** File path of the notebook */
  filePath?: string;
  /** Block names referenced via ref() in SQL cells */
  refDependencies?: string[];
  /** Table names referenced in SQL cells (for tracing non-block SQL) */
  tableDependencies?: string[];
}

/**
 * Build a complete lineage graph from blocks and semantic definitions.
 */
export function buildLineageGraph(
  blocks: LineageBlockInput[],
  metrics: LineageMetricInput[],
  dimensions: LineageDimensionInput[],
  options: LineageBuilderOptions = {},
): LineageGraph {
  const graph = new LineageGraph();
  const blockNames = options.blockNames ?? new Set(blocks.map((b) => b.name));
  const resolveDomain = createDomainResolver(options.domains ?? []);
  const materializedMap = new Map<string, string>();
  const dbtNodeMap = new Map<string, string>();
  const dbtUniqueIdMap = new Map<string, string>();

  for (const block of blocks) {
    materializedMap.set((block.materializedAs ?? block.name).toLowerCase(), block.name);
  }

  for (const dbtModel of options.dbtModels ?? []) {
    const nodeId = `${dbtModel.type === 'model' ? 'dbt_model' : 'dbt_source'}:${dbtModel.name}`;
    dbtNodeMap.set(dbtModel.name.toLowerCase(), nodeId);
    // Also index by schema-qualified name for SQL references like "schema.table"
    if (dbtModel.schema) {
      dbtNodeMap.set(`${dbtModel.schema}.${dbtModel.name}`.toLowerCase(), nodeId);
    }
    if (dbtModel.database && dbtModel.schema) {
      dbtNodeMap.set(`${dbtModel.database}.${dbtModel.schema}.${dbtModel.name}`.toLowerCase(), nodeId);
    }
    dbtUniqueIdMap.set(dbtModel.uniqueId, nodeId);
    const nodeType = dbtModel.type === 'model' ? 'dbt_model' as const : 'dbt_source' as const;
    graph.addNode({
      id: nodeId,
      type: nodeType,
      layer: getLayerForNodeType(nodeType),
      name: dbtModel.name,
      metadata: {
        uniqueId: dbtModel.uniqueId,
        schema: dbtModel.schema,
        database: dbtModel.database,
        materialized: dbtModel.materialized,
        description: dbtModel.description,
      },
      columns: dbtModel.columns,
    });
  }

  for (const dbtModel of options.dbtModels ?? []) {
    const targetId = dbtUniqueIdMap.get(dbtModel.uniqueId);
    if (!targetId) continue;
    for (const dependency of dbtModel.dependsOn) {
      const sourceId = dbtUniqueIdMap.get(dependency);
      if (!sourceId) continue;
      graph.addEdge({
        source: sourceId,
        target: targetId,
        type: 'depends_on',
      });
    }
  }

  // 1. Add first-class domain nodes before terms/blocks/views so the graph has
  // a stable root for domain-scoped Business 360 and cross-domain analysis.
  for (const domain of options.domains ?? []) {
    graph.addNode({
      id: `domain:${domain.name}`,
      type: 'domain',
      layer: 'answer',
      name: domain.name,
      domain: domain.name,
      owner: domain.owner,
      metadata: {
        filePath: domain.filePath,
        businessOwner: domain.businessOwner,
        boundedContext: domain.boundedContext,
        sourceSystems: domain.sourceSystems,
        primaryTerms: domain.primaryTerms,
        reviewCadence: domain.reviewCadence,
        businessOutcome: domain.businessOutcome,
        tags: domain.tags,
      },
    });
  }

  // 1b. Add business term nodes before blocks/views so they can define them.
  for (const term of options.terms ?? []) {
    const domain = resolveDomain(term.domain);
    graph.addNode({
      id: `term:${term.name}`,
      type: 'term',
      layer: 'answer',
      name: term.name,
      domain,
      owner: term.owner,
      status: term.status,
      metadata: {
        termType: term.termType,
        filePath: term.filePath,
        description: term.description,
        identifiers: term.identifiers,
        synonyms: term.synonyms,
        businessOutcome: term.businessOutcome,
        reviewCadence: term.reviewCadence,
      },
    });
    addDomainContainmentEdge(graph, domain, `term:${term.name}`);
  }

  // 2. Add block nodes
  for (const block of blocks) {
    const domain = resolveDomain(block.domain);
    graph.addNode({
      id: `block:${block.name}`,
      type: 'block',
      layer: 'answer',
      name: block.name,
      domain,
      owner: block.owner,
      status: block.status,
      metadata: {
        blockType: block.blockType,
        materializedAs: block.materializedAs,
        filePath: block.filePath,
        description: block.description,
        businessOutcome: block.businessOutcome,
        reviewCadence: block.reviewCadence,
        tests: block.tests,
        pattern: block.pattern,
        grain: block.grain,
        entities: block.entities,
        declaredOutputs: block.declaredOutputs,
        dimensions: block.dimensions,
        allowedFilters: block.allowedFilters,
        parameterPolicy: block.parameterPolicy,
        filterBindings: block.filterBindings,
        sourceSystems: block.sourceSystems,
        replacementFor: block.replacementFor,
        replacedBy: block.replacedBy,
        deprecatedOn: block.deprecatedOn,
      },
    });
    addDomainContainmentEdge(graph, domain, `block:${block.name}`);
  }

  // 2a. Retired blocks: old → new "replaced by" edge. Not a data-flow edge;
  // impact and path traversals skip it (see isDataFlowEdge).
  for (const block of blocks) {
    if (!block.replacedBy || !isDeprecatedStatus(block.status)) continue;
    const replacement = resolveBlockReference(blocks, block.replacedBy);
    if (!replacement || replacement === block) continue;
    graph.addEdge({
      source: `block:${block.name}`,
      target: `block:${replacement.name}`,
      type: 'replaced_by',
      metadata: block.deprecatedOn ? { deprecatedOn: block.deprecatedOn } : undefined,
    });
  }

  // 2b. Add business view nodes before edges so views can compose other views.
  for (const view of options.businessViews ?? []) {
    const domain = resolveDomain(view.domain);
    graph.addNode({
      id: `business_view:${view.name}`,
      type: 'business_view',
      layer: 'answer',
      name: view.name,
      domain,
      owner: view.owner,
      status: view.status,
      metadata: {
        filePath: view.filePath,
        description: view.description,
        businessOutcome: view.businessOutcome,
        reviewCadence: view.reviewCadence,
      },
    });
    addDomainContainmentEdge(graph, domain, `business_view:${view.name}`);
  }

  // 3. Add metric nodes
  for (const metric of metrics) {
    const domain = resolveDomain(metric.domain);
    graph.addNode({
      id: `metric:${metric.name}`,
      type: 'metric',
      layer: 'answer',
      name: metric.name,
      domain,
      owner: metric.owner,
      status: metric.status,
      metadata: {
        type: metric.type,
        table: metric.table,
        sql: metric.sql,
        filePath: metric.filePath,
        description: metric.description,
        tags: metric.tags,
      },
    });
    addDomainContainmentEdge(graph, domain, `metric:${metric.name}`);

    // Metric → source table edge
    const tableNodeId = ensureTableNode(graph, metric.table, dbtNodeMap);
    graph.addEdge({
      source: tableNodeId,
      target: `metric:${metric.name}`,
      type: 'aggregates',
    });
  }

  // 4. Add dimension nodes
  for (const dim of dimensions) {
    const domain = resolveDomain(dim.domain);
    graph.addNode({
      id: `dimension:${dim.name}`,
      type: 'dimension',
      layer: 'answer',
      name: dim.name,
      domain,
      owner: dim.owner,
      status: dim.status,
      metadata: {
        type: dim.type,
        table: dim.table,
        sql: dim.sql,
        filePath: dim.filePath,
        description: dim.description,
        tags: dim.tags,
      },
    });
    addDomainContainmentEdge(graph, domain, `dimension:${dim.name}`);

    const tableNodeId = ensureTableNode(graph, dim.table, dbtNodeMap);
    graph.addEdge({
      source: tableNodeId,
      target: `dimension:${dim.name}`,
      type: 'reads_from',
    });
  }

  // 5. Process each block's SQL for dependencies
  for (const block of blocks) {
    const blockNodeId = `block:${block.name}`;
    const parseResult = extractTablesFromSql(block.sql);

    // ref() calls → block-to-block edges
    for (const ref of parseResult.refs) {
      // A block that ref()s its OWN name is wrapping the same-named dbt model
      // (e.g. block "customers" with `ref('customers')`), not depending on itself.
      // Resolve it to the dbt-model node so the upstream dependency is preserved,
      // and never emit a block self-loop (mirrors the `resolved !== block.name`
      // guard in the table-reference branch below).
      if (ref === block.name) {
        const dbtResolved = dbtNodeMap.get(ref.toLowerCase());
        if (dbtResolved) {
          graph.addEdge({ source: dbtResolved, target: blockNodeId, type: 'reads_from' });
        }
        continue;
      }
      if (blockNames.has(ref)) {
        graph.addEdge({
          source: `block:${ref}`,
          target: blockNodeId,
          type: 'feeds_into',
        });
        addCrossDomainEdgeIfNeeded(graph, `block:${ref}`, blockNodeId);
      }
    }

    // SQL table references
    for (const table of parseResult.tables) {
      const resolved = materializedMap.get(table.toLowerCase());
      const normalizedTable = readerTableName(table).toLowerCase();
      // Try full name first, then strip schema prefix for fallback
      const dbtResolved = dbtNodeMap.get(normalizedTable)
        ?? (normalizedTable.includes('.') ? dbtNodeMap.get(normalizedTable.split('.').pop()!) : undefined);
      if (dbtResolved) {
        graph.addEdge({
          source: dbtResolved,
          target: blockNodeId,
          type: 'reads_from',
        });
      } else if (resolved && resolved !== block.name) {
        // Table matches another block's materialized name
        graph.addEdge({
          source: `block:${resolved}`,
          target: blockNodeId,
          type: 'feeds_into',
        });
        addCrossDomainEdgeIfNeeded(graph, `block:${resolved}`, blockNodeId);
      } else if (!resolved) {
        // External table dependency
        const tableNodeId = ensureTableNode(graph, table, dbtNodeMap);
        graph.addEdge({
          source: tableNodeId,
          target: blockNodeId,
          type: 'reads_from',
        });
      }
    }

    // @metric() references in SQL → block depends on metric
    for (const metRef of parseResult.metricRefs) {
      const metricNodeId = `metric:${metRef}`;
      if (graph.getNode(metricNodeId)) {
        graph.addEdge({
          source: metricNodeId,
          target: blockNodeId,
          type: 'aggregates',
        });
        addCrossDomainEdgeIfNeeded(graph, metricNodeId, blockNodeId);
      }
    }

    // @dim() references in SQL → block depends on dimension
    for (const dimRef of parseResult.dimensionRefs) {
      const dimNodeId = `dimension:${dimRef}`;
      if (graph.getNode(dimNodeId)) {
        graph.addEdge({
          source: dimNodeId,
          target: blockNodeId,
          type: 'reads_from',
        });
      }
    }

    // Semantic block → metric/dimension edges
    if (block.blockType === 'semantic') {
      const metricRefs = block.metricsRef?.length ? block.metricsRef : (block.metricRef ? [block.metricRef] : []);
      for (const metricRef of metricRefs) {
        const metricNodeId = `metric:${metricRef}`;
        if (graph.getNode(metricNodeId)) {
          graph.addEdge({
            source: metricNodeId,
            target: blockNodeId,
            type: 'aggregates',
          });
          addCrossDomainEdgeIfNeeded(graph, metricNodeId, blockNodeId);
        }
      }
      for (const dimensionRef of block.dimensionsRef ?? []) {
        const dimNodeId = `dimension:${dimensionRef}`;
        if (graph.getNode(dimNodeId)) {
          graph.addEdge({
            source: dimNodeId,
            target: blockNodeId,
            type: 'reads_from',
          });
        }
      }
    }

    for (const termRef of block.termRefs ?? []) {
      const termNodeId = `term:${termRef}`;
      if (graph.getNode(termNodeId)) {
        graph.addEdge({
          source: termNodeId,
          target: blockNodeId,
          type: 'defines',
        });
        addCrossDomainEdgeIfNeeded(graph, termNodeId, blockNodeId);
      }
    }

    // Chart visualization edge
    if (block.chartType) {
      const chartNodeId = `chart:${block.name}`;
      const domain = resolveDomain(block.domain);
      graph.addNode({
        id: chartNodeId,
        type: 'chart',
        layer: 'consumption',
        name: `${block.name} (${block.chartType})`,
        domain,
        metadata: { chartType: block.chartType },
      });
      graph.addEdge({
        source: blockNodeId,
        target: chartNodeId,
        type: 'visualizes',
      });
    }

    // Certification is stored as node metadata (status + certifiedBy), not as an edge.
    // Self-loops would confuse graph traversal without adding lineage value.
  }

  for (const view of options.businessViews ?? []) {
    const viewNodeId = `business_view:${view.name}`;
    for (const termRef of view.declaredTermRefs ?? []) {
      const termNodeId = `term:${termRef}`;
      if (!graph.getNode(termNodeId)) continue;
      graph.addEdge({
        source: termNodeId,
        target: viewNodeId,
        type: 'defines',
      });
      addCrossDomainEdgeIfNeeded(graph, termNodeId, viewNodeId);
    }
    for (const blockRef of view.blockRefs) {
      const blockNodeId = `block:${blockRef}`;
      if (!graph.getNode(blockNodeId)) continue;
      graph.addEdge({
        source: blockNodeId,
        target: viewNodeId,
        type: 'composes',
      });
      addCrossDomainEdgeIfNeeded(graph, blockNodeId, viewNodeId);
    }
    for (const viewRef of view.businessViewRefs) {
      const refNodeId = `business_view:${viewRef}`;
      if (!graph.getNode(refNodeId)) continue;
      graph.addEdge({
        source: refNodeId,
        target: viewNodeId,
        type: 'composes',
      });
      addCrossDomainEdgeIfNeeded(graph, refNodeId, viewNodeId);
    }
  }

  for (const dashboard of options.dashboards ?? []) {
    const dashboardId = `dashboard:${dashboard.name}`;
    const nodeType = dashboard.kind ?? 'dashboard';
    graph.addNode({
      id: dashboardId,
      type: nodeType,
      layer: 'consumption',
      name: dashboard.name,
      metadata: { filePath: dashboard.filePath, lineageKind: nodeType },
    });
    for (const blockName of dashboard.blocks) {
      if (!graph.getNode(`block:${blockName}`)) continue;
      // Edge direction: block feeds into dashboard (data flows block → dashboard)
      graph.addEdge({
        source: `block:${blockName}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    for (const chartName of dashboard.charts) {
      if (!graph.getNode(`chart:${chartName}`)) continue;
      graph.addEdge({
        source: `chart:${chartName}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    // Add edges for blocks referenced via ref() in notebook SQL cells
    for (const refBlock of dashboard.refDependencies ?? []) {
      if (!graph.getNode(`block:${refBlock}`)) continue;
      graph.addEdge({
        source: `block:${refBlock}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    // NOTE: We intentionally do NOT create table/dbt_model → dashboard edges
    // from raw draft SQL cells. The correct flow is always:
    //   dbt_source → dbt_model → block → dashboard
    // Draft cells (unbound, no inline block declaration) are exploratory queries
    // and don't represent a formal lineage path. Bound cells (v0.11 Track 5) DO
    // appear: the manifest builder resolves each cell's `blockBinding.path`
    // against `pathToBlockName` and merges the resulting block name into
    // `dashboard.blocks`, so the `block:<name> → dashboard:<name>` edge above
    // (line ~310) covers bound cells without a separate code path here.
  }

  // 4b. Add app nodes and connect to their dashboards.
  for (const app of options.apps ?? []) {
    const appId = `app:${app.id}`;
    const domain = resolveDomain(app.domain);
    graph.addNode({
      id: appId,
      type: 'app',
      layer: 'consumption',
      name: app.name,
      domain,
      owner: app.owner,
      metadata: { filePath: app.filePath, appId: app.id },
    });
    addDomainContainmentEdge(graph, domain, appId);
    for (const dashId of app.dashboards) {
      const dashboardNodeId = `dashboard:${dashId}`;
      if (!graph.getNode(dashboardNodeId)) continue;
      // Data flow: dashboard → app (apps consume the dashboards they contain).
      graph.addEdge({
        source: dashboardNodeId,
        target: appId,
        type: 'contains',
      });
      addCrossDomainEdgeIfNeeded(graph, dashboardNodeId, appId);
    }
  }

  // 5. Add derived domain nodes for legacy projects without domain declarations.
  addDomainNodes(graph);

  return graph;
}

function createDomainResolver(domains: LineageDomainInput[]): (domain: string | undefined) => string | undefined {
  const aliases = new Map<string, string>();
  for (const domain of domains) {
    aliases.set(domain.name, domain.name);
    aliases.set(domainAliasKey(domain.name), domain.name);
    const folderAlias = domain.filePath?.replace(/\\/g, '/').match(/^domains\/([^/]+)\//)?.[1];
    if (folderAlias) aliases.set(domainAliasKey(folderAlias), domain.name);
  }
  return (domain) => {
    if (!domain) return undefined;
    return aliases.get(domain) ?? aliases.get(domainAliasKey(domain)) ?? domain;
  };
}

function domainAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function addDomainContainmentEdge(graph: LineageGraph, domain: string | undefined, targetId: string): void {
  if (!domain) return;
  const domainNodeId = `domain:${domain}`;
  if (!graph.getNode(domainNodeId)) {
    graph.addNode({
      id: domainNodeId,
      type: 'domain',
      layer: 'answer',
      name: domain,
      domain,
    });
  }
  graph.addEdge({
    source: domainNodeId,
    target: targetId,
    type: 'contains',
  });
}

/** Ensure a source_table node exists and return its ID. */
function ensureTableNode(
  graph: LineageGraph,
  rawTableName: string,
  dbtNodeMap?: Map<string, string>,
): string {
  const tableName = readerTableName(rawTableName);
  const dbtNodeId = dbtNodeMap?.get(tableName.toLowerCase());
  if (dbtNodeId) return dbtNodeId;
  const nodeId = `table:${tableName}`;
  if (!graph.getNode(nodeId)) {
    graph.addNode({
      id: nodeId,
      type: 'source_table',
      layer: 'source',
      name: tableName,
    });
  }
  return nodeId;
}


/** Add a crosses_domain edge if source and target are in different domains. */
function addCrossDomainEdgeIfNeeded(graph: LineageGraph, sourceId: string, targetId: string): void {
  const sourceNode = graph.getNode(sourceId);
  const targetNode = graph.getNode(targetId);

  if (sourceNode?.domain && targetNode?.domain && sourceNode.domain !== targetNode.domain) {
    graph.addEdge({
      source: sourceId,
      target: targetId,
      type: 'crosses_domain',
      sourceDomain: sourceNode.domain,
      targetDomain: targetNode.domain,
    });
  }
}

/** Add domain nodes and connect blocks/metrics to their domains. */
function addDomainNodes(graph: LineageGraph): void {
  const domains = graph.getDomains();

  for (const domain of domains) {
    const domainNodeId = `domain:${domain}`;
    if (graph.getNode(domainNodeId)) continue;
    graph.addNode({
      id: domainNodeId,
      type: 'domain',
      layer: 'answer',
      name: domain,
      domain,
    });
  }
}
