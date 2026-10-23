import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  dqlToolDefinitionsForSurface,
  getDqlToolDefinition,
  type DqlToolName,
  type DqlToolSurface,
} from '@zlens/agent';
import { DQLContext, findProjectRoot } from './context.js';
import { zodRawShapeFromJsonSchema } from './tool-schema.js';
import { searchBlocks } from './tools/search-blocks.js';
import { getBlock } from './tools/get-block.js';
import { queryViaBlock } from './tools/query-via-block.js';
import { listMetrics, listDimensions } from './tools/semantic.js';
import { lineageImpact } from './tools/lineage-impact.js';
import { certify } from './tools/certify.js';
import { suggestBlock } from './tools/suggest-block.js';
import { expandContext } from './tools/expand-context.js';
import { querySemanticModel } from './tools/query-semantic-model.js';
import { queryViaMetadata } from './tools/query-via-metadata.js';
import { answerQuestion, buildBlockFromPrompt } from './tools/governed.js';
import {
  describeDataset,
  listDatasets,
  previewTileQuery,
  queryDataset,
} from './tools/datasets.js';
import { listProposals } from './tools/list-proposals.js';
import {
  feedbackRecord,
  inspectMetadataContext,
  kgSearch,
} from './tools/kg.js';
import {
  askDql,
  buildDqlApp,
  buildDqlBlock,
  inspectDqlProject,
} from './tools/workflows.js';
import {
  approveHint,
  listHints,
  recordCorrection,
} from './tools/hints.js';
import {
  getTableSchema,
  explainRelationshipProof,
  resolveAnalyticalPath,
  searchMetadata,
  validateSql,
} from './tools/metadata.js';
import { listApps, listNotebooks } from './tools/apps-notebooks.js';
import { mcpToolAnnotations } from './tool-annotations.js';
import { readEnv } from '@zlens/core';

export interface CreateServerOptions {
  projectRoot?: string;
  version?: string;
  /**
   * `agentic` is the default bounded surface for LLM clients. `full` exposes
   * the historical expert/admin MCP surface for explicit maintenance sessions.
   */
  toolProfile?: McpToolProfile;
}

export type McpToolProfile = 'agentic' | 'full';

interface McpToolRegistration {
  name: DqlToolName;
  inputSchema: Record<string, z.ZodTypeAny>;
  run(args: any): unknown | Promise<unknown>;
}

const DQL_MCP_AGENTIC_INSTRUCTIONS =
  'ZLens is a governed analytics MCP server. Start each session with ' +
  '`inspect_dql_project`; it lists the certified blocks and their grains.\n' +
  'Answer order for every analytics question, always:\n' +
  '1. Call `ask_dql` first, before `query_semantic_model`, `list_datasets`, or any SQL. ' +
  'It returns the safe route, trust label, certified candidate when available, ' +
  'allowed SQL context, and next tool.\n' +
  '2. If it returns route `certified`, call `query_via_block` with that block and answer from it.\n' +
  '3. Only when `ask_dql` returns no certified block, use the semantic layer or ' +
  'the generated paths below. Never tell the user that no certified block answers ' +
  'a question unless `ask_dql` said so.\n' +
  '4. When `ask_dql` returns `nextTool: query_semantic_model`, call it with the ' +
  'question before writing any SQL; its answer is labelled From Metrics, or ' +
  'AI-Generated when it joins through a relationship that is not certified.\n' +
  'Two ways to answer: `answer_question` runs ZLens\'s FULL governed cascade and ' +
  'returns the executed answer + rows + canonical trust label + a reviewable ' +
  'draft — use it when you want ZLens to generate for you (same engine + trust ' +
  'guards as the ZLens UI). It needs an AI model set up in ZLens; when it returns ' +
  '`modelUnavailable`, answer through the BYOSQL path instead. The BYOSQL path (`ask_dql` → inspect → ' +
  '`query_via_metadata` with your own SELECT) is for when you want to author the ' +
  'SQL yourself. To create a reusable block from a description, use ' +
  '`build_block_from_prompt` (governed, no SQL authoring); it returns a ' +
  'review-required draft + Certifier verdict and never auto-certifies.\n' +
  'Manifest v3 relationships: before authoring a multi-entity or cross-domain ' +
  'query, call `resolve_analytical_path`; use only its ordered certified key ' +
  'plan. Call `explain_relationship_proof` when the user needs the cardinality, ' +
  'fanout, export/import, warehouse evidence, owner, or stale-state rationale. ' +
  'A dbt dependency edge or an inferred key suggestion never authorizes a join.\n' +
  'Semantic compile, only after `ask_dql` returned no certified block: when the ' +
  'semantic layer contains the requested metric, dimension, or time grain, use ' +
  '`query_semantic_model` before deep dbt or warehouse search. If its result names ' +
  'a `certifiedBlock`, call `query_via_block` with that block instead. Otherwise return ' +
  'the DQL semantic artifact, draft path when present, and compiled SQL, ' +
  'labelled with its `trustLabelInfo.display`: From Metrics (built from semantic ' +
  'metrics and dimensions, every join a certified relationship), or AI-Generated ' +
  'when a join is a draft or unmodeled relationship (its caveat names the join). ' +
  'Its `uncertified: true` means no certified block backs the result and the ' +
  'draft needs review before certification; it does not make a From Metrics ' +
  'answer AI-generated. ' +
  'When it returns `matched: false`, say there is no semantic match; never ' +
  'answer with a different metric.\n' +
  'Tier 1 certified: for an exact saved block or direct KPI, use ' +
  '`search_blocks`/`get_block` for discovery and `query_via_block` only when ' +
  'a certified block grain exactly answers the question.\n' +
  'Tier 2 generated: for named customer/user/account questions, custom filters, ' +
  'rankings, breakdowns, comparisons, drill-throughs, or different grain, use ' +
  'certified assets only as context. Call `inspect_metadata_context`, then `query_via_metadata` with ' +
  'one read-only SELECT/WITH query from the inspected context. Surface ' +
  '`uncertified: true`, the trust status, the returned `dqlArtifact.source`, ' +
  'and draft path verbatim; treat SQL as compiled/preview evidence, not the default artifact.\n' +
  'Follow-ups: when the user refers to prior/previous results, pass `followUp.priorResultRef` ' +
  '(id, question, columns, rowCount, sourceSql if known) and `followUp.priorDqlArtifact` ' +
  '(the previous `dqlArtifact.source` plus metrics/dimensions/filters) into `query_via_metadata`; ' +
  'do not answer a drilldown from vague follow-up prose alone.\n' +
  'Deep research: call `inspect_metadata_context` with `strictness: "exploratory"` ' +
  'before writing SQL when the user asks for broad investigation, many entities, or full context.\n' +
  'Repair loop: if `query_via_metadata` reports an unknown relation that exists ' +
  'in the metadata catalog/runtime schema, call `expand_context` with the prior ' +
  'contextPackId and relation, then retry `query_via_metadata` once with the new contextPackId ' +
  'and `regroundAttemptsUsed: 1`.\n' +
  'Discovery: when the inspected context is missing a table or column you ' +
  'believe exists, DISCOVER it before declining — `search_metadata` finds the ' +
  'governed relation for a business phrase, `get_table_schema` returns its real ' +
  'columns and suggestion-only join keys, and `validate_sql` checks a draft ' +
  'SELECT against the inspected schema and relationship policy. Discovery ' +
  'output is grounding evidence, never join authorization.\n' +
  'Tier 3 missing context: if metadata does not identify a safe table, metric, ' +
  'dimension, or grain, refuse and ask for what is missing.\n' +
  'App Datasets (for App tiles; analytics questions still start with `ask_dql`): ' +
  'use `list_datasets` and `describe_dataset` to discover current ' +
  'approved Dataset capability, then `preview_tile_query` or `query_dataset` with ' +
  'a typed TileQuery. These tools accept no SQL and execute through the same local ' +
  'governed Dataset runtime as App Builder; their results are ephemeral and cannot ' +
  'create App publication evidence.\n' +
  'Trust labels are one canonical vocabulary: Certified, From Metrics, Reviewed, ' +
  'AI-Generated, Insufficient-Context, Conflict (a base label plus an optional ' +
  'qualifier, e.g. "Certified · invariant violated"). Report the trust label ' +
  'verbatim and never upgrade it.\n' +
  'Conflict route: when two certified terms or blocks claim the same concept ' +
  'but disagree, `ask_dql` returns route `conflict` with BOTH definitions and ' +
  'owners. Present both sides and ask the user which is authoritative — never ' +
  'silently pick one.\n' +
  'Use `suggest_block` for reusable draft blocks, `certify` to check a block against ' +
  'the certification rules (a check only; people certify), `lineage_impact` for ' +
  'dependencies and impact, and `kg_search` for the knowledge graph.\n' +
  'Apps and notebooks: `list_apps` lists the Apps with their dashboards, tiles, the ' +
  'block behind each tile and its trust; `build_dql_app` starts a new App as an App ' +
  'Studio draft (certified data only, no App files; give the user its openUrl or openPath ' +
  'so they check the data and publish there; never certifies); `list_notebooks` ' +
  'reads the notebooks.\n' +
  'Never present generated SQL or draft output as certified.';

const DQL_MCP_FULL_PROFILE_INSTRUCTIONS =
  '\nFull expert profile only: `build_dql_block` (deprecated alias of ' +
  '`suggest_block`), `list_proposals`, `feedback_record`, ' +
  '`record_correction`, `approve_hint`, `list_hints`, ' +
  '`list_metrics`, and `list_dimensions` are available for maintenance, legacy, ' +
  'and governance-admin workflows. Prefer the bounded governed cascade tools for normal analytics questions.\n' +
  'Correction memory: when an analyst corrects a Tier-2 answer, call ' +
  '`record_correction` with the scope (metric/dbt model/domain/dialect). It ' +
  'creates a scoped CANDIDATE hint that is NOT used until a human runs ' +
  '`approve_hint`. Approval uses the shared fail-closed lifecycle; MCP reviewers ' +
  'must provide an evidence note because MCP does not execute warehouse SQL. ' +
  'Approved hints are folded into matching future Tier-2 drafts ' +
  'AFTER certified routing (never overriding certified answers) and are cited. ' +
  'Use `list_hints` to review pending corrections.';

export const DQL_MCP_INSTRUCTIONS = DQL_MCP_AGENTIC_INSTRUCTIONS;

export function dqlMcpInstructionsForProfile(profile: McpToolProfile): string {
  return profile === 'full'
    ? `${DQL_MCP_AGENTIC_INSTRUCTIONS}${DQL_MCP_FULL_PROFILE_INSTRUCTIONS}`
    : DQL_MCP_AGENTIC_INSTRUCTIONS;
}

export function createDQLMCPServer(options: CreateServerOptions = {}): McpServer {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const ctx = new DQLContext({ projectRoot, dqlVersion: options.version });
  const toolProfile = resolveMcpToolProfile(options.toolProfile);

  const server = new McpServer(
    { name: 'dql-mcp', title: 'ZLens', version: options.version ?? '0.1.0' },
    { instructions: dqlMcpInstructionsForProfile(toolProfile) },
  );

  for (const tool of buildMcpToolRegistrations(ctx, toolProfile)) {
    const annotations = mcpToolAnnotations(tool.name);
    server.registerTool(
      tool.name,
      {
        title: annotations.title,
        description: toolDescription(tool.name),
        inputSchema: tool.inputSchema,
        annotations,
      },
      async (args: any) => wrap(await tool.run(args), tool.name),
    );
  }

  return server;
}

function buildMcpToolRegistrations(ctx: DQLContext, profile: McpToolProfile = 'agentic'): McpToolRegistration[] {
  const handlers = mcpToolHandlers(ctx);
  const surface: DqlToolSurface = profile === 'full' ? 'mcp' : 'mcp_agentic';
  return dqlToolDefinitionsForSurface(surface).map((definition) => {
    const handler = handlers[definition.name];
    if (!handler) throw new Error(`MCP ZLens tool handler is missing for ${definition.name}`);
    return {
      name: definition.name,
      inputSchema: zodRawShapeFromJsonSchema(definition.inputSchema),
      run: handler.run,
    };
  });
}

function resolveMcpToolProfile(explicit?: McpToolProfile): McpToolProfile {
  if (explicit) return explicit;
  const raw = readEnv('ZLENS_MCP_TOOL_PROFILE')?.trim().toLowerCase();
  return raw === 'full' || raw === 'expert' || raw === 'admin' ? 'full' : 'agentic';
}

function mcpToolHandlers(ctx: DQLContext): Partial<Record<DqlToolName, Pick<McpToolRegistration, 'run'>>> {
  return {
    ask_dql: {
      run: (args) => askDql(ctx, args as Parameters<typeof askDql>[1]),
    },
    query_semantic_model: {
      run: (args) => querySemanticModel(ctx, args as Parameters<typeof querySemanticModel>[1]),
    },
    kg_search: {
      run: (args) => kgSearch(ctx, args as Parameters<typeof kgSearch>[1]),
    },
    search_blocks: {
      run: (args) => searchBlocks(ctx, args as Parameters<typeof searchBlocks>[1]),
    },
    get_block: {
      run: (args) => getBlock(ctx, args as Parameters<typeof getBlock>[1]),
    },
    query_via_block: {
      run: (args) => queryViaBlock(ctx, args as Parameters<typeof queryViaBlock>[1]),
    },
    inspect_metadata_context: {
      run: (args) => inspectMetadataContext(ctx, args as Parameters<typeof inspectMetadataContext>[1]),
    },
    expand_context: {
      run: (args) => expandContext(ctx, args as Parameters<typeof expandContext>[1]),
    },
    query_via_metadata: {
      run: (args) => queryViaMetadata(ctx, args as Parameters<typeof queryViaMetadata>[1]),
    },
    answer_question: {
      run: (args) => answerQuestion(ctx, args as Parameters<typeof answerQuestion>[1]),
    },
    build_block_from_prompt: {
      run: (args) => buildBlockFromPrompt(ctx, args as Parameters<typeof buildBlockFromPrompt>[1]),
    },
    list_metrics: {
      run: (args) => listMetrics(ctx, args as Parameters<typeof listMetrics>[1]),
    },
    list_dimensions: {
      run: (args) => listDimensions(ctx, args as Parameters<typeof listDimensions>[1]),
    },
    lineage_impact: {
      run: (args) => lineageImpact(ctx, args as Parameters<typeof lineageImpact>[1]),
    },
    certify: {
      run: (args) => certify(ctx, args as Parameters<typeof certify>[1]),
    },
    suggest_block: {
      run: (args) => suggestBlock(ctx, args as Parameters<typeof suggestBlock>[1]),
    },
    search_metadata: {
      run: (args) => searchMetadata(ctx, args as Parameters<typeof searchMetadata>[1]),
    },
    get_table_schema: {
      run: (args) => getTableSchema(ctx, args as Parameters<typeof getTableSchema>[1]),
    },
    validate_sql: {
      run: (args) => validateSql(ctx, args as Parameters<typeof validateSql>[1]),
    },
    resolve_analytical_path: {
      run: (args) => resolveAnalyticalPath(ctx, args as Parameters<typeof resolveAnalyticalPath>[1]),
    },
    explain_relationship_proof: {
      run: (args) => explainRelationshipProof(ctx, args as Parameters<typeof explainRelationshipProof>[1]),
    },
    inspect_dql_project: {
      run: (args) => inspectDqlProject(ctx, args as Parameters<typeof inspectDqlProject>[1]),
    },
    list_datasets: {
      run: (args) => listDatasets(ctx, args as Parameters<typeof listDatasets>[1]),
    },
    describe_dataset: {
      run: (args) => describeDataset(ctx, args as Parameters<typeof describeDataset>[1]),
    },
    preview_tile_query: {
      run: (args) => previewTileQuery(ctx, args as Parameters<typeof previewTileQuery>[1]),
    },
    query_dataset: {
      run: (args) => queryDataset(ctx, args as Parameters<typeof queryDataset>[1]),
    },
    build_dql_block: {
      run: (args) => buildDqlBlock(ctx, args as Parameters<typeof buildDqlBlock>[1]),
    },
    build_dql_app: {
      run: (args) => buildDqlApp(ctx, args as Parameters<typeof buildDqlApp>[1]),
    },
    list_proposals: {
      run: (args) => listProposals(ctx, args as Parameters<typeof listProposals>[1]),
    },
    feedback_record: {
      run: (args) => feedbackRecord(ctx, args as Parameters<typeof feedbackRecord>[1]),
    },
    record_correction: {
      run: (args) => recordCorrection(ctx, args as Parameters<typeof recordCorrection>[1]),
    },
    approve_hint: {
      run: (args) => approveHint(ctx, args as Parameters<typeof approveHint>[1]),
    },
    list_hints: {
      run: (args) => listHints(ctx, args as Parameters<typeof listHints>[1]),
    },
    list_apps: {
      run: (args) => listApps(ctx, args as Parameters<typeof listApps>[1]),
    },
    list_notebooks: {
      run: (args) => listNotebooks(ctx, args as Parameters<typeof listNotebooks>[1]),
    },
  };
}

function toolDescription(name: DqlToolName): string {
  return getDqlToolDefinition(name).description;
}

/**
 * Tools whose `ok: false` is the answer itself (a verdict on the input), not a
 * failure of the call: a SQL that fails validation was still validated.
 */
const VERDICT_TOOLS = new Set<string>(['validate_sql']);

/**
 * A result that carries an `error` message (and no `ok: true`) is a failed
 * call: flag it with MCP `isError` so the client and the model treat it as
 * one instead of reading the JSON as an answer. The JSON body is unchanged.
 */
export function isToolError(result: unknown, toolName?: string): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (toolName && VERDICT_TOOLS.has(toolName)) return false;
  const record = result as { ok?: unknown; error?: unknown };
  if (record.ok === true) return false;
  return typeof record.error === 'string' && record.error.trim().length > 0;
}

function wrap(result: unknown, toolName?: string) {
  const text = readEnv('ZLENS_MCP_PRETTY_JSON') === '1'
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  return {
    content: [{ type: 'text' as const, text }],
    ...(isToolError(result, toolName) ? { isError: true } : {}),
  };
}

export const __test__ = {
  buildMcpToolRegistrations,
  isToolError,
  dqlMcpInstructionsForProfile,
  resolveMcpToolProfile,
  wrap,
  zodRawShapeFromJsonSchema,
};
