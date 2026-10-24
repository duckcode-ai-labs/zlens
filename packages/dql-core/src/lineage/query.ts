import { LineageGraph, type LineageGraphJSON, type LineageNode, type LineageEdge, type LineageNodeType, type LineageLayer, getLayerForNodeType, isDataFlowEdge } from './lineage-graph.js';

export interface LineageQuery {
  focus?: string;
  search?: string;
  types?: LineageNodeType[];
  domain?: string;
  upstreamDepth?: number;
  downstreamDepth?: number;
}

export interface LineageQueryResult {
  graph: LineageGraphJSON;
  focalNode?: LineageNode;
  matches?: Array<{ node: LineageNode; score: number }>;
}

export interface Business360Asset {
  id: string;
  name: string;
  type: LineageNodeType;
  layer: LineageLayer;
  domain?: string;
  status?: LineageNode['status'];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface Business360Edge {
  source: string;
  target: string;
  type: LineageEdge['type'];
}

export interface Business360Gap {
  code:
    | 'missing_definition'
    | 'missing_composition'
    | 'missing_owner'
    | 'missing_terms'
    | 'missing_grain'
    | 'missing_outputs'
    | 'missing_reusable_filters'
    | 'missing_tests'
    | 'stale_review'
    | 'missing_sources'
    | 'missing_consumers';
  severity: 'info' | 'warning';
  message: string;
}

export type Business360Reusability = 'dynamic' | 'partial_dynamic' | 'static';

export interface Business360BlockContract {
  block: Business360Asset;
  pattern?: string;
  grain?: string;
  entities: string[];
  outputs: string[];
  dimensions: string[];
  allowedFilters: string[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  filterBindings: Array<{ filter: string; binding: string }>;
  sourceSystems: string[];
  replacementFor: string[];
  reusability: Business360Reusability;
}

export interface Business360Result {
  focus: Business360Asset;
  businessDefinition: {
    terms: Business360Asset[];
    definedArtifacts: Business360Asset[];
    definedByTerms: Business360Asset[];
    metadata: Record<string, unknown>;
  };
  businessComposition: {
    includedArtifacts: Business360Asset[];
    parentViews: Business360Asset[];
  };
  technicalSources: {
    sourceTables: Business360Asset[];
    dbtModels: Business360Asset[];
    dbtSources: Business360Asset[];
    upstreamBlocks: Business360Asset[];
    upstreamPathCount: number;
  };
  consumers: {
    dashboards: Business360Asset[];
    apps: Business360Asset[];
    notebooks: Business360Asset[];
    downstreamViews: Business360Asset[];
    downstreamBlocks: Business360Asset[];
  };
  replacementHistory: {
    replaces: Business360Asset[];
    replacedBy: Business360Asset[];
    replacementRefs: string[];
  };
  blockContracts: Business360BlockContract[];
  gaps: Business360Gap[];
  evidence: {
    nodes: Business360Asset[];
    edges: Business360Edge[];
  };
}

/** Public v2 alias for the enterprise impact view shape. */
export type Business360ResultV2 = Business360Result;

export interface Business360Options {
  /** Maximum upstream/downstream traversal depth (default 12). */
  maxDepth?: number;
}

const NODE_PREFIXES: LineageNodeType[] = [
  'app',
  'block',
  'business_view',
  'dashboard',
  'notebook',
  'dbt_model',
  'dbt_source',
  'source_table',
  'term',
  'metric',
  'dimension',
  'domain',
  'chart',
];

export function queryLineage(graph: LineageGraph, query: LineageQuery): LineageQueryResult {
  const matches = query.search ? searchLineage(graph, query.search) : [];
  const focalNode = query.focus ? resolveFocusNode(graph, query.focus) : undefined;

  // A focus that does not resolve must NOT silently widen to the whole project.
  // It used to: asking for `block:<transient AI block>` — which is never in the
  // graph, because notebook AI blocks are unsaved — returned every node in the
  // project, so a cell displayed an unrelated project-wide graph that looked like
  // demo data. An unresolvable focus is an empty result; callers detect it via
  // `focalNode === undefined`.
  const focusRequested = Boolean(query.focus);
  let resultGraph = focalNode
    ? buildFocusedSubgraph(
        graph,
        focalNode.id,
        query.upstreamDepth,
        query.downstreamDepth,
      )
    : focusRequested
      ? graph.subgraph(() => false)
      : graph;

  if (query.types?.length || query.domain) {
    const allowedTypes = query.types ? new Set(query.types) : null;
    resultGraph = resultGraph.subgraph((node) => {
      if (allowedTypes && !allowedTypes.has(node.type)) return false;
      if (query.domain && node.domain !== query.domain) return false;
      return true;
    });
  }

  if (!query.focus && query.search) {
    const matchIds = new Set(matches.map((match) => match.node.id));
    resultGraph = graph.subgraph((node) => {
      if (query.domain && node.domain !== query.domain) return false;
      if (query.types?.length && !query.types.includes(node.type)) return false;
      return matchIds.has(node.id);
    });
  }

  return {
    graph: resultGraph.toJSON(),
    focalNode,
    matches,
  };
}

/**
 * Build a business-first 360 view around a term, block, business view,
 * dashboard, app, or notebook.
 *
 * Terms expand through outgoing `defines` edges first, then technical sources
 * and consuming artifacts are traced from the artifacts the term defines.
 */
export function queryBusiness360(
  graph: LineageGraph,
  focalNodeId: string,
  options: Business360Options = {},
): Business360Result | null {
  const focus = resolveFocusNode(graph, focalNodeId);
  if (!focus) return null;

  const maxDepth = options.maxDepth ?? 12;
  const seedIds = new Set<string>([focus.id]);
  const definedArtifacts = focus.type === 'term'
    ? targetsForEdges(graph.getOutgoingEdges(focus.id).filter((edge) => edge.type === 'defines'), graph)
    : [];
  for (const artifact of definedArtifacts) seedIds.add(artifact.id);
  const directlyComposedArtifacts = focus.type === 'business_view'
    ? incomingSourcesByType(graph, focus.id, 'composes', ['block', 'business_view'])
    : [];
  for (const artifact of directlyComposedArtifacts) seedIds.add(artifact.id);
  const directlyContainedDomainArtifacts = focus.type === 'domain'
    ? outgoingTargetsByType(graph, focus.id, 'contains', ['term', 'block', 'business_view', 'app'])
    : [];
  for (const artifact of directlyContainedDomainArtifacts) {
    if (artifact.type !== 'app') seedIds.add(artifact.id);
  }

  const upstreamNodes = collectReachableNodes(graph, seedIds, 'upstream', maxDepth);
  const downstreamNodes = collectReachableNodes(graph, seedIds, 'downstream', maxDepth);
  const seedNodes = [...seedIds]
    .map((id) => graph.getNode(id))
    .filter((node): node is LineageNode => Boolean(node));

  const definedByTerms = focus.type === 'term'
    ? []
    : incomingSourcesByType(graph, focus.id, 'defines', ['term']);
  const terms = uniqueNodes([
    ...(focus.type === 'term' ? [focus] : []),
    ...definedByTerms,
    ...directlyContainedDomainArtifacts.filter((node) => node.type === 'term'),
    ...upstreamNodes.filter((node) => node.type === 'term'),
  ]);

  const includedArtifacts = uniqueNodes([
    ...directlyComposedArtifacts,
    ...directlyContainedDomainArtifacts.filter((node) => node.type === 'block' || node.type === 'business_view'),
    ...seedNodes.flatMap((node) => incomingSourcesByType(graph, node.id, 'composes', ['block', 'business_view'])),
    ...upstreamNodes.filter((node) => node.type === 'block' || node.type === 'business_view'),
  ]).filter((node) => node.id !== focus.id && !definedArtifacts.some((artifact) => artifact.id === node.id));

  const parentViews = uniqueNodes(
    seedNodes.flatMap((node) => outgoingTargetsByType(graph, node.id, 'composes', ['business_view'])),
  );

  const sourceTables = upstreamNodes.filter((node) => node.type === 'source_table');
  const dbtModels = upstreamNodes.filter((node) => node.type === 'dbt_model');
  const dbtSources = upstreamNodes.filter((node) => node.type === 'dbt_source');
  const upstreamBlocks = upstreamNodes
    .filter((node) => node.type === 'block')
    .filter((node) => !seedIds.has(node.id));

  const dashboards = downstreamNodes.filter((node) => node.type === 'dashboard');
  const apps = uniqueNodes([
    ...downstreamNodes.filter((node) => node.type === 'app'),
    ...directlyContainedDomainArtifacts.filter((node) => node.type === 'app'),
  ]);
  const notebooks = downstreamNodes.filter((node) => node.type === 'notebook');
  const downstreamViews = downstreamNodes
    .filter((node) => node.type === 'business_view')
    .filter((node) => !seedIds.has(node.id));
  const downstreamBlocks = downstreamNodes
    .filter((node) => node.type === 'block')
    .filter((node) => !seedIds.has(node.id));
  const replacementHistory = buildReplacementHistory(graph, focus);
  const blockContractNodes = uniqueNodes([
    ...seedNodes.filter((node) => node.type === 'block'),
    ...definedArtifacts.filter((node) => node.type === 'block'),
    ...includedArtifacts.filter((node) => node.type === 'block'),
    ...upstreamBlocks,
    ...downstreamBlocks,
  ]);
  const blockContracts = blockContractNodes.map(blockContractForNode);

  const evidenceNodes = uniqueNodes([
    focus,
    ...seedNodes,
    ...terms,
    ...definedArtifacts,
    ...definedByTerms,
    ...includedArtifacts,
    ...parentViews,
    ...sourceTables,
    ...dbtModels,
    ...dbtSources,
    ...upstreamBlocks,
    ...dashboards,
    ...apps,
    ...notebooks,
    ...downstreamViews,
    ...downstreamBlocks,
    ...replacementHistory.replaces,
    ...replacementHistory.replacedBy,
  ]);
  const evidenceNodeIds = new Set(evidenceNodes.map((node) => node.id));
  const evidenceEdges = graph.getAllEdges()
    .filter((edge) => evidenceNodeIds.has(edge.source) && evidenceNodeIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type }));

  const gaps = buildBusiness360Gaps({
    focus,
    definedArtifacts,
    includedArtifacts,
    terms,
    definedByTerms,
    replacementHistory,
    blockContracts,
    sourceCount: sourceTables.length + dbtModels.length + dbtSources.length,
    consumerCount: dashboards.length + apps.length + notebooks.length,
  });

  return {
    focus: assetForNode(focus),
    businessDefinition: {
      terms: nodesToAssets(terms),
      definedArtifacts: nodesToAssets(definedArtifacts),
      definedByTerms: nodesToAssets(definedByTerms),
      metadata: focus.metadata ?? {},
    },
    businessComposition: {
      includedArtifacts: nodesToAssets(includedArtifacts),
      parentViews: nodesToAssets(parentViews),
    },
    technicalSources: {
      sourceTables: nodesToAssets(sourceTables),
      dbtModels: nodesToAssets(dbtModels),
      dbtSources: nodesToAssets(dbtSources),
      upstreamBlocks: nodesToAssets(upstreamBlocks),
      upstreamPathCount: countTechnicalUpstreamPaths(graph, seedIds, maxDepth),
    },
    consumers: {
      dashboards: nodesToAssets(dashboards),
      apps: nodesToAssets(apps),
      notebooks: nodesToAssets(notebooks),
      downstreamViews: nodesToAssets(downstreamViews),
      downstreamBlocks: nodesToAssets(downstreamBlocks),
    },
    replacementHistory: {
      replaces: nodesToAssets(replacementHistory.replaces),
      replacedBy: nodesToAssets(replacementHistory.replacedBy),
      replacementRefs: replacementHistory.replacementRefs,
    },
    blockContracts,
    gaps,
    evidence: {
      nodes: nodesToAssets(evidenceNodes),
      edges: evidenceEdges,
    },
  };
}

function buildFocusedSubgraph(
  graph: LineageGraph,
  focusId: string,
  upstreamDepth?: number,
  downstreamDepth?: number,
): LineageGraph {
  const includedIds = new Set<string>([focusId]);

  walkDirection(graph, focusId, 'upstream', normalizeDepth(upstreamDepth), includedIds);
  walkDirection(graph, focusId, 'downstream', normalizeDepth(downstreamDepth), includedIds);
  // A retired block and its replacement are shown side by side: the focus's
  // own `replaced_by` neighbours join the view, without walking past them.
  for (const edge of [...graph.getOutgoingEdges(focusId), ...graph.getIncomingEdges(focusId)]) {
    if (edge.type === 'replaced_by') includedIds.add(edge.source === focusId ? edge.target : edge.source);
  }

  return graph.subgraph((node) => includedIds.has(node.id));
}

function walkDirection(
  graph: LineageGraph,
  startId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
  includedIds: Set<string>,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
  const seen = new Set<string>([startId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(current.id)
      : graph.getOutgoingEdges(current.id);

    for (const edge of edges) {
      if (!isDataFlowEdge(edge)) continue;
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      includedIds.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }
}

function normalizeDepth(depth: number | undefined): number {
  return depth === undefined || !Number.isFinite(depth) || depth < 0
    ? Number.POSITIVE_INFINITY
    : depth;
}

function resolveFocusNode(graph: LineageGraph, rawFocus: string): LineageNode | undefined {
  if (graph.getNode(rawFocus)) return graph.getNode(rawFocus);

  for (const prefix of NODE_PREFIXES) {
    const candidate = graph.getNode(`${prefix}:${rawFocus}`);
    if (candidate) return candidate;
  }

  const normalized = rawFocus.trim().toLowerCase();
  return graph
    .getAllNodes()
    .find((node) => node.name.toLowerCase() === normalized);
}

function collectReachableNodes(
  graph: LineageGraph,
  startIds: Set<string>,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
): LineageNode[] {
  const visited = new Set<string>();
  const queue = [...startIds].map((id) => ({ id, depth: 0 }));

  for (const id of startIds) visited.add(id);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(current.id)
      : graph.getOutgoingEdges(current.id);

    for (const edge of edges) {
      if (!isDataFlowEdge(edge)) continue;
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return sortNodes([...visited]
    .filter((id) => !startIds.has(id))
    .map((id) => graph.getNode(id))
    .filter((node): node is LineageNode => Boolean(node))
    .filter((node) => node.type !== 'domain'));
}

function incomingSourcesByType(
  graph: LineageGraph,
  nodeId: string,
  edgeType: LineageEdge['type'],
  nodeTypes: LineageNodeType[],
): LineageNode[] {
  const allowed = new Set(nodeTypes);
  return sortNodes(targetsForEdges(
    graph.getIncomingEdges(nodeId).filter((edge) => edge.type === edgeType),
    graph,
    'source',
  ).filter((node) => allowed.has(node.type)));
}

function outgoingTargetsByType(
  graph: LineageGraph,
  nodeId: string,
  edgeType: LineageEdge['type'],
  nodeTypes: LineageNodeType[],
): LineageNode[] {
  const allowed = new Set(nodeTypes);
  return sortNodes(targetsForEdges(
    graph.getOutgoingEdges(nodeId).filter((edge) => edge.type === edgeType),
    graph,
  ).filter((node) => allowed.has(node.type)));
}

function targetsForEdges(
  edges: LineageEdge[],
  graph: LineageGraph,
  endpoint: 'source' | 'target' = 'target',
): LineageNode[] {
  return uniqueNodes(edges
    .map((edge) => graph.getNode(endpoint === 'source' ? edge.source : edge.target))
    .filter((node): node is LineageNode => Boolean(node)));
}

function uniqueNodes(nodes: LineageNode[]): LineageNode[] {
  const seen = new Set<string>();
  const unique: LineageNode[] = [];
  for (const node of nodes) {
    if (node.type === 'domain' || seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }
  return sortNodes(unique);
}

function sortNodes(nodes: LineageNode[]): LineageNode[] {
  return [...nodes].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function nodesToAssets(nodes: LineageNode[]): Business360Asset[] {
  return sortNodes(nodes).map(assetForNode);
}

function assetForNode(node: LineageNode): Business360Asset {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    layer: node.layer ?? getLayerForNodeType(node.type),
    domain: node.domain,
    status: node.status,
    owner: node.owner,
    metadata: node.metadata,
  };
}

function blockContractForNode(node: LineageNode): Business360BlockContract {
  const parameterPolicy = parameterPolicyArray(node.metadata?.parameterPolicy);
  const filterBindings = filterBindingArray(node.metadata?.filterBindings);
  const allowedFilters = stringArray(node.metadata?.allowedFilters);
  return {
    block: assetForNode(node),
    pattern: stringValue(node.metadata?.pattern),
    grain: stringValue(node.metadata?.grain),
    entities: stringArray(node.metadata?.entities),
    outputs: stringArray(node.metadata?.declaredOutputs),
    dimensions: stringArray(node.metadata?.dimensions),
    allowedFilters,
    parameterPolicy,
    filterBindings,
    sourceSystems: stringArray(node.metadata?.sourceSystems),
    replacementFor: stringArray(node.metadata?.replacementFor),
    reusability: classifyBlockReusability({ parameterPolicy, filterBindings, allowedFilters }),
  };
}

function classifyBlockReusability(input: {
  parameterPolicy: Array<{ name: string; policy: string }>;
  filterBindings: Array<{ filter: string; binding: string }>;
  allowedFilters: string[];
}): Business360Reusability {
  if (input.parameterPolicy.length > 0 && input.filterBindings.length > 0) return 'dynamic';
  if (input.parameterPolicy.length > 0 || input.filterBindings.length > 0 || input.allowedFilters.length > 0) {
    return 'partial_dynamic';
  }
  return 'static';
}

function buildReplacementHistory(graph: LineageGraph, focus: LineageNode): {
  replaces: LineageNode[];
  replacedBy: LineageNode[];
  replacementRefs: string[];
} {
  const refs = stringArray(focus.metadata?.replacementFor);
  const replaces = uniqueNodes([
    ...refs
      .map((ref) => resolveFocusNode(graph, ref))
      .filter((node): node is LineageNode => Boolean(node)),
    ...graph.getIncomingEdges(focus.id)
      .filter((edge) => edge.type === 'replaced_by')
      .map((edge) => graph.getNode(edge.source))
      .filter((node): node is LineageNode => Boolean(node)),
  ]);
  const focusAliases = new Set([
    focus.id.toLowerCase(),
    focus.name.toLowerCase(),
    `${focus.type}:${focus.name}`.toLowerCase(),
  ]);
  const replacedBy = uniqueNodes([
    // Native retirement: the deprecated block names its replacement.
    ...graph.getOutgoingEdges(focus.id)
      .filter((edge) => edge.type === 'replaced_by')
      .map((edge) => graph.getNode(edge.target))
      .filter((node): node is LineageNode => Boolean(node)),
    // The newer block names what it replaces.
    ...graph.getAllNodes()
      .filter((node) => node.type === 'block')
      .filter((node) => node.id !== focus.id)
      .filter((node) => stringArray(node.metadata?.replacementFor)
        .some((ref) => focusAliases.has(ref.toLowerCase()))),
  ]);

  return { replaces, replacedBy, replacementRefs: refs };
}

function countTechnicalUpstreamPaths(
  graph: LineageGraph,
  startIds: Set<string>,
  maxDepth: number,
): number {
  let count = 0;
  const visited = new Set<string>();

  function walk(nodeId: string, depth: number): void {
    const node = graph.getNode(nodeId);
    if (!node || node.type === 'term' || node.type === 'domain') return;

    if (depth >= maxDepth) return;

    const nextIds = graph.getIncomingEdges(nodeId)
      .filter((edge) => edge.type !== 'defines' && edge.type !== 'crosses_domain' && edge.type !== 'certified_by')
      .map((edge) => edge.source)
      .filter((id) => !visited.has(id))
      .filter((id) => {
        const source = graph.getNode(id);
        return source !== undefined && source.type !== 'term' && source.type !== 'domain';
      });

    if (nextIds.length === 0) {
      if (node.type === 'source_table' || node.type === 'dbt_source' || node.type === 'dbt_model') {
        count++;
      }
      return;
    }

    for (const nextId of nextIds) {
      visited.add(nextId);
      walk(nextId, depth + 1);
      visited.delete(nextId);
    }
  }

  for (const startId of startIds) {
    const start = graph.getNode(startId);
    if (!start || start.type === 'term' || start.type === 'domain') continue;
    visited.add(startId);
    walk(startId, 0);
    visited.delete(startId);
  }

  return count;
}

function buildBusiness360Gaps(input: {
  focus: LineageNode;
  definedArtifacts: LineageNode[];
  includedArtifacts: LineageNode[];
  terms: LineageNode[];
  definedByTerms: LineageNode[];
  replacementHistory: {
    replaces: LineageNode[];
    replacedBy: LineageNode[];
    replacementRefs: string[];
  };
  blockContracts: Business360BlockContract[];
  sourceCount: number;
  consumerCount: number;
}): Business360Gap[] {
  const gaps: Business360Gap[] = [];
  const reviewNodes = uniqueNodesWithDomains([
    input.focus,
    ...input.definedArtifacts,
    ...input.includedArtifacts,
  ]).filter((node) => isGovernedBusinessNode(node));

  if (input.focus.type === 'term' && input.definedArtifacts.length === 0) {
    gaps.push({
      code: 'missing_definition',
      severity: 'warning',
      message: 'This term is not connected to a saved query or business view yet.',
    });
  }

  if (input.focus.type === 'business_view' && input.includedArtifacts.length === 0) {
    gaps.push({
      code: 'missing_composition',
      severity: 'warning',
      message: 'This business view does not include any saved queries or nested business views.',
    });
  }

  const missingOwners = reviewNodes.filter((node) => !node.owner?.trim());
  if (missingOwners.length > 0) {
    gaps.push({
      code: 'missing_owner',
      severity: 'warning',
      message: `${missingOwners.length} governed asset(s) are missing owner metadata: ${sampleNodeLabels(missingOwners)}.`,
    });
  }

  const requiresTerms = input.focus.type === 'domain'
    || input.focus.type === 'block'
    || input.focus.type === 'business_view';
  if (requiresTerms && input.terms.length === 0 && input.definedByTerms.length === 0) {
    gaps.push({
      code: 'missing_terms',
      severity: 'warning',
      message: 'No business terms are connected to this business asset.',
    });
  }

  const blocksForContract = reviewNodes.filter((node) => node.type === 'block');
  const missingGrain = blocksForContract.filter((node) => typeof node.metadata?.grain !== 'string' || node.metadata.grain.trim().length === 0);
  if (missingGrain.length > 0) {
    gaps.push({
      code: 'missing_grain',
      severity: 'warning',
      message: `${missingGrain.length} block(s) are missing grain metadata: ${sampleNodeLabels(missingGrain)}.`,
    });
  }

  const missingOutputs = blocksForContract.filter((node) => stringArray(node.metadata?.declaredOutputs).length === 0);
  if (missingOutputs.length > 0) {
    gaps.push({
      code: 'missing_outputs',
      severity: 'warning',
      message: `${missingOutputs.length} block(s) are missing declared output fields: ${sampleNodeLabels(missingOutputs)}.`,
    });
  }

  const staticContracts = input.blockContracts.filter((contract) => contract.reusability === 'static');
  if (staticContracts.length > 0) {
    gaps.push({
      code: 'missing_reusable_filters',
      severity: 'info',
      message: `${staticContracts.length} saved query contract(s) do not declare reusable parameters or filter bindings: ${staticContracts.slice(0, 5).map((contract) => assetLabel(contract.block)).join(', ')}${staticContracts.length > 5 ? `, +${staticContracts.length - 5} more` : ''}.`,
    });
  }

  const missingTests = blocksForContract.filter((node) => stringArray(node.metadata?.tests).length === 0);
  if (missingTests.length > 0) {
    gaps.push({
      code: 'missing_tests',
      severity: 'warning',
      message: `${missingTests.length} block(s) are missing test assertions: ${sampleNodeLabels(missingTests)}.`,
    });
  }

  const staleReview = reviewNodes.filter((node) => hasStaleOrMissingReviewCadence(node));
  if (staleReview.length > 0) {
    gaps.push({
      code: 'stale_review',
      severity: 'warning',
      message: `${staleReview.length} governed asset(s) need review cadence metadata refreshed: ${sampleNodeLabels(staleReview)}.`,
    });
  }

  if (input.sourceCount === 0) {
    gaps.push({
      code: 'missing_sources',
      severity: 'info',
      message: 'No source tables, dbt sources, or dbt models were found upstream.',
    });
  }

  if (input.consumerCount === 0) {
    gaps.push({
      code: 'missing_consumers',
      severity: 'info',
      message: 'No dashboards, apps, or notebooks were found downstream.',
    });
  }

  return gaps;
}

function isGovernedBusinessNode(node: LineageNode): boolean {
  return node.type === 'domain'
    || node.type === 'term'
    || node.type === 'block'
    || node.type === 'business_view'
    || node.type === 'app'
    || node.type === 'dashboard'
    || node.type === 'notebook';
}

function hasStaleOrMissingReviewCadence(node: LineageNode): boolean {
  if (node.type === 'dashboard' || node.type === 'notebook' || node.type === 'app') return false;
  const value = typeof node.metadata?.reviewCadence === 'string' ? node.metadata.reviewCadence.trim() : '';
  if (!value) return true;
  const days = reviewCadenceDays(value);
  return days == null || days > 180;
}

function reviewCadenceDays(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const known: Record<string, number> = {
    daily: 1,
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 90,
    semiannual: 180,
    semiannually: 180,
    annual: 365,
    annually: 365,
    yearly: 365,
  };
  if (known[normalized] !== undefined) return known[normalized];
  const everyMatch = normalized.match(/^every(\d+)(day|days|week|weeks|month|months)$/);
  if (!everyMatch) return null;
  const amount = Number(everyMatch[1]);
  const unit = everyMatch[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit.startsWith('day')) return amount;
  if (unit.startsWith('week')) return amount * 7;
  return amount * 30;
}

function uniqueNodesWithDomains(nodes: LineageNode[]): LineageNode[] {
  const seen = new Set<string>();
  const unique: LineageNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }
  return sortNodes(unique);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parameterPolicyArray(value: unknown): Array<{ name: string; policy: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as { name?: unknown; policy?: unknown };
    if (typeof candidate.name !== 'string' || typeof candidate.policy !== 'string') return [];
    if (!candidate.name.trim() || !candidate.policy.trim()) return [];
    return [{ name: candidate.name, policy: candidate.policy }];
  });
}

function filterBindingArray(value: unknown): Array<{ filter: string; binding: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as { filter?: unknown; binding?: unknown };
    if (typeof candidate.filter !== 'string' || typeof candidate.binding !== 'string') return [];
    if (!candidate.filter.trim() || !candidate.binding.trim()) return [];
    return [{ filter: candidate.filter, binding: candidate.binding }];
  });
}

function assetLabel(asset: Business360Asset): string {
  const type = asset.type === 'source_table' ? 'table' : asset.type;
  return `${type}:${asset.name}`;
}

function sampleNodeLabels(nodes: LineageNode[]): string {
  const sample = nodes.slice(0, 5).map((node) => `${node.type}:${node.name}`);
  const suffix = nodes.length > sample.length ? `, +${nodes.length - sample.length} more` : '';
  return `${sample.join(', ')}${suffix}`;
}

function searchLineage(graph: LineageGraph, rawTerm: string): Array<{ node: LineageNode; score: number }> {
  const term = rawTerm.trim().toLowerCase();
  if (!term) return [];

  return graph
    .getAllNodes()
    .map((node) => ({
      node,
      score: scoreMatch(node, term),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name));
}

function scoreMatch(node: LineageNode, term: string): number {
  const name = node.name.toLowerCase();
  const id = node.id.toLowerCase();
  if (name === term || id === term) return 100;
  if (name.startsWith(term)) return 75;
  if (id.startsWith(term)) return 60;
  if (name.includes(term)) return 40;
  if (id.includes(term)) return 30;
  return 0;
}

// ---- Complete Lineage Paths ----

export interface LineagePath {
  /** Nodes in order from start to end of the path */
  nodes: LineageNode[];
  /** Edges connecting the nodes in sequence */
  edges: LineageEdge[];
  /** Layers traversed in order */
  layers: LineageLayer[];
}

export interface CompletePathResult {
  /** The focal node this query centered on */
  focalNode: LineageNode;
  /** Paths from sources (roots) to the focal node */
  upstreamPaths: LineagePath[];
  /** Paths from the focal node to consumption (leaves) */
  downstreamPaths: LineagePath[];
  /** Layer distribution summary */
  layerSummary: Record<LineageLayer, number>;
}

export interface CompletePathOptions {
  /** Maximum traversal depth (default 10) */
  maxDepth?: number;
  /** Maximum number of paths to return per direction (default 20) */
  maxPaths?: number;
}

/**
 * Compute complete lineage paths for a focal node.
 *
 * Upstream paths trace from source roots to the focal node.
 * Downstream paths trace from the focal node to consumption leaves.
 * Paths are deduplicated and capped to avoid explosion on large graphs.
 */
export function queryCompleteLineagePaths(
  graph: LineageGraph,
  focalNodeId: string,
  options: CompletePathOptions = {},
): CompletePathResult | null {
  const focalNode = resolveFocusNode(graph, focalNodeId);
  if (!focalNode) return null;

  const maxDepth = options.maxDepth ?? 10;
  const maxPaths = options.maxPaths ?? 20;

  const upstreamPaths = collectPaths(graph, focalNode.id, 'upstream', maxDepth, maxPaths);
  const downstreamPaths = collectPaths(graph, focalNode.id, 'downstream', maxDepth, maxPaths);

  // Count nodes per layer across all paths
  const layerSummary: Record<LineageLayer, number> = { source: 0, transform: 0, answer: 0, consumption: 0 };
  const counted = new Set<string>();
  for (const path of [...upstreamPaths, ...downstreamPaths]) {
    for (const node of path.nodes) {
      if (!counted.has(node.id)) {
        counted.add(node.id);
        const layer = node.layer ?? getLayerForNodeType(node.type);
        layerSummary[layer]++;
      }
    }
  }
  // Count focal node too
  if (!counted.has(focalNode.id)) {
    const focalLayer = focalNode.layer ?? getLayerForNodeType(focalNode.type);
    layerSummary[focalLayer]++;
  }

  return { focalNode, upstreamPaths, downstreamPaths, layerSummary };
}

/**
 * Collect all root-to-node (upstream) or node-to-leaf (downstream) paths using DFS.
 */
function collectPaths(
  graph: LineageGraph,
  startId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
  maxPaths: number,
): LineagePath[] {
  const paths: LineagePath[] = [];
  const currentPath: string[] = [startId];
  const currentEdges: LineageEdge[] = [];
  const visited = new Set<string>([startId]);

  function dfs(nodeId: string, depth: number): void {
    if (paths.length >= maxPaths) return;
    if (depth >= maxDepth) {
      // Reached max depth — emit this as a path
      emitPath();
      return;
    }

    const edges = direction === 'upstream'
      ? graph.getIncomingEdges(nodeId)
      : graph.getOutgoingEdges(nodeId);

    // Filter to non-visited neighbors
    const nextEdges = edges.filter((e) => {
      if (!isDataFlowEdge(e)) return false;
      if (e.type === 'contains' && graph.getNode(e.source)?.type === 'domain') {
        return false;
      }
      const nextId = direction === 'upstream' ? e.source : e.target;
      return !visited.has(nextId);
    });

    if (nextEdges.length === 0) {
      // Leaf/root — emit the path
      emitPath();
      return;
    }

    for (const edge of nextEdges) {
      if (paths.length >= maxPaths) return;
      const nextId = direction === 'upstream' ? edge.source : edge.target;
      visited.add(nextId);
      currentPath.push(nextId);
      currentEdges.push(edge);
      dfs(nextId, depth + 1);
      currentPath.pop();
      currentEdges.pop();
      visited.delete(nextId);
    }
  }

  function emitPath(): void {
    // Build the path in natural order (source → target)
    const nodeIds = direction === 'upstream' ? [...currentPath].reverse() : [...currentPath];
    const edgesCopy = direction === 'upstream' ? [...currentEdges].reverse() : [...currentEdges];

    const nodes = nodeIds
      .map((id) => graph.getNode(id))
      .filter((n): n is LineageNode => n !== undefined);

    const layers = nodes.map((n) => n.layer ?? getLayerForNodeType(n.type));
    // Deduplicate layers while preserving order
    const seenLayers = new Set<LineageLayer>();
    const uniqueLayers: LineageLayer[] = [];
    for (const layer of layers) {
      if (!seenLayers.has(layer)) {
        seenLayers.add(layer);
        uniqueLayers.push(layer);
      }
    }

    paths.push({ nodes, edges: edgesCopy, layers: uniqueLayers });
  }

  dfs(startId, 0);
  return paths;
}
