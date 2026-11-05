import {
  DQLContext,
  askDql,
  searchBlocks,
  getBlock,
  queryViaBlock,
  querySemanticModel,
  queryViaMetadata,
  expandContext,
  lineageImpact,
  certify,
  suggestBlock,
  kgSearch,
  inspectMetadataContext,
  searchMetadata,
  getTableSchema,
  validateSql,
  resolveAnalyticalPath,
  explainRelationshipProof,
} from '@zlens/mcp';
import {
  dqlToolDefinitionsForSurface,
  getDqlToolDefinition,
  openMetadataCatalog,
  type DqlToolName,
} from '@zlens/agent';
import { tableName } from '@zlens/core';

export interface AgentTool {
  /** Callable when named, never declared to a model (see AgentToolDefinition.hidden). */
  hidden?: boolean;
  /** The advertised tool whose admission this hidden tool shares. */
  aliasOf?: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<unknown>;
}

export function buildAgentTools(ctx: DQLContext): AgentTool[] {
  const handlers = nativeToolHandlers(ctx);
  return dqlToolDefinitionsForSurface('native').map((definition) => {
    const handler = handlers[definition.name];
    if (!handler) throw new Error(`Native ZLens tool handler is missing for ${definition.name}`);
    return registryTool(definition.name, handler);
  });
}

function registryTool(name: DqlToolName, run: AgentTool['run']): AgentTool {
  const definition = getDqlToolDefinition(name);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run,
  };
}

function nativeToolHandlers(ctx: DQLContext): Partial<Record<DqlToolName, AgentTool['run']>> {
  return {
    ask_dql: async (args) => askDql(ctx, args as Parameters<typeof askDql>[1]),
    query_semantic_model: async (args) => querySemanticModel(ctx, args as Parameters<typeof querySemanticModel>[1]),
    kg_search: async (args) => kgSearch(ctx, args as Parameters<typeof kgSearch>[1]),
    search_blocks: async (args) => searchBlocks(ctx, args as Parameters<typeof searchBlocks>[1]),
    get_block: async (args) => getBlock(ctx, args as Parameters<typeof getBlock>[1]),
    query_via_block: async (args) => queryViaBlock(ctx, args as Parameters<typeof queryViaBlock>[1]),
    inspect_metadata_context: async (args) => inspectMetadataContext(ctx, args as Parameters<typeof inspectMetadataContext>[1]),
    query_via_metadata: async (args) => queryViaMetadata(ctx, args as Parameters<typeof queryViaMetadata>[1]),
    expand_context: async (args) => expandContext(ctx, args as Parameters<typeof expandContext>[1]),
    lineage_impact: async (args) => lineageImpact(ctx, args as Parameters<typeof lineageImpact>[1]),
    certify: async (args) => certify(ctx, args as Parameters<typeof certify>[1]),
    suggest_block: async (args) => suggestBlock(ctx, args as Parameters<typeof suggestBlock>[1]),
    // Schema-discovery tools (P3): give the answer loop the same relation/column/
    // join-key discovery Claude Code gets over MCP, so it can find and validate a
    // join instead of declining.
    search_metadata: async (args) => searchMetadata(ctx, args as Parameters<typeof searchMetadata>[1]),
    validate_sql: async (args) => validateSql(ctx, args as Parameters<typeof validateSql>[1]),
    resolve_analytical_path: async (args) => resolveAnalyticalPath(ctx, args as Parameters<typeof resolveAnalyticalPath>[1]),
    explain_relationship_proof: async (args) => explainRelationshipProof(ctx, args as Parameters<typeof explainRelationshipProof>[1]),
    get_table_schema: async (args) => {
      const params = args as Parameters<typeof getTableSchema>[1];
      const result = getTableSchema(ctx, params);
      if (result.found) return result;
      // Manifest miss: fall back to the live-scanned warehouse schema cached in the
      // metadata catalog. A raw table dbt never wrapped is invisible to the manifest
      // but may have been captured by a prior information_schema scan.
      return lookupRuntimeTableSchema(ctx.projectRoot, params.table) ?? result;
    },
  };
}

/**
 * Resolve a table's columns from the live-scanned warehouse schema snapshot stored
 * in the metadata catalog (`.dql/cache/metadata.sqlite`) — the fallback for
 * `get_table_schema` when a table isn't in the dbt manifest. Read-only; returns
 * undefined when there's no snapshot or no match.
 */
export function lookupRuntimeTableSchema(projectRoot: string, table: string): Record<string, unknown> | undefined {
  const needle = table.trim().toLowerCase();
  if (!needle) return undefined;
  const bareNeedle = needle.split('.').pop();
  const catalog = openMetadataCatalog(projectRoot);
  try {
    const snapshot = catalog.latestRuntimeSchemaSnapshot();
    if (!snapshot) return undefined;
    const match = snapshot.tables.find((entry) => {
      const candidates = [entry.relation, entry.name, entry.schema && entry.name ? `${entry.schema}.${entry.name}` : undefined]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => value.toLowerCase());
      const bareTable = tableName(entry.relation ?? '').toLowerCase();
      if (bareTable) candidates.push(bareTable);
      return candidates.includes(needle) || (bareNeedle !== undefined && bareTable === bareNeedle);
    });
    if (!match) return undefined;
    return {
      found: true,
      source: 'runtime_schema',
      name: match.name ?? match.relation,
      qualifiedRelation: match.relation,
      refForm: null,
      columns: match.columns.map((column) => ({
        name: column.name,
        type: column.type ?? null,
        description: column.description ?? null,
      })),
      joinKeys: [],
      note: 'Resolved from the live-scanned warehouse schema (not modeled in dbt). Verify column names before relying on this in a certified block.',
    };
  } finally {
    catalog.close();
  }
}
