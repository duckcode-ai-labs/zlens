import { describe, expect, it } from 'vitest';
import { dqlToolNamesForSurface, getDqlToolDefinition, type DqlToolName } from '@zlens/agent';
import { DQL_MCP_INSTRUCTIONS, __test__ } from '../server.js';
import { mcpToolAnnotations } from '../tool-annotations.js';
import type { DQLContext } from '../context.js';
import { approveHintInput, listHintsInput, recordCorrectionInput } from '../tools/hints.js';
import { certifyInput } from '../tools/certify.js';
import { expandContextInput } from '../tools/expand-context.js';
import { getBlockInput } from '../tools/get-block.js';
import { feedbackRecordInput, inspectMetadataContextInput, kgSearchInput } from '../tools/kg.js';
import { lineageImpactInput } from '../tools/lineage-impact.js';
import { listProposalsInput } from '../tools/list-proposals.js';
import { getTableSchemaInput, searchMetadataInput, validateSqlInput } from '../tools/metadata.js';
import { queryViaBlockInput } from '../tools/query-via-block.js';
import { querySemanticModelInput } from '../tools/query-semantic-model.js';
import { queryViaMetadataInput } from '../tools/query-via-metadata.js';
import {
  describeDatasetInput,
  listDatasetsInput,
  previewTileQueryInput,
  queryDatasetInput,
} from '../tools/datasets.js';
import { searchBlocksInput } from '../tools/search-blocks.js';
import { listDimensionsInput, listMetricsInput } from '../tools/semantic.js';
import { suggestBlockInput } from '../tools/suggest-block.js';
import { askDqlInput, buildDqlAppInput, buildDqlBlockInput, inspectDqlProjectInput } from '../tools/workflows.js';
import { listAppsInput, listNotebooksInput } from '../tools/apps-notebooks.js';

describe('ZLens MCP server instructions', () => {
  it('describe exact certified routing and dynamic metadata SQL for custom grains', () => {
    expect(DQL_MCP_INSTRUCTIONS).toContain('exact saved block');
    expect(DQL_MCP_INSTRUCTIONS).toContain('direct KPI');
    expect(DQL_MCP_INSTRUCTIONS).toContain('named customer/user/account');
    expect(DQL_MCP_INSTRUCTIONS).toContain('custom filters, rankings');
    expect(DQL_MCP_INSTRUCTIONS).toContain('query_via_metadata');
    expect(DQL_MCP_INSTRUCTIONS).toContain('query_semantic_model');
    expect(DQL_MCP_INSTRUCTIONS).toContain('expand_context');
    expect(DQL_MCP_INSTRUCTIONS).toContain('strictness: "exploratory"');
    expect(DQL_MCP_INSTRUCTIONS).toContain('uncertified: true');
    expect(DQL_MCP_INSTRUCTIONS).toContain('followUp.priorResultRef');
    expect(DQL_MCP_INSTRUCTIONS).toContain('followUp.priorDqlArtifact');
    expect(DQL_MCP_INSTRUCTIONS).toContain('previous results');
    expect(DQL_MCP_INSTRUCTIONS).toContain('ask_dql');
    expect(DQL_MCP_INSTRUCTIONS).toContain('suggest_block');
  });

  it('put ask_dql first and the semantic layer only after it (Claude Desktop has no guide file)', () => {
    // A Claude Desktop recording skipped ask_dql for query_semantic_model and
    // said no certified block existed while monthly_revenue was certified.
    const askFirst = DQL_MCP_INSTRUCTIONS.indexOf('1. Call `ask_dql` first');
    expect(askFirst).toBeGreaterThan(-1);
    expect(askFirst).toBeLessThan(DQL_MCP_INSTRUCTIONS.indexOf('`query_semantic_model` before deep dbt'));
    expect(DQL_MCP_INSTRUCTIONS).toContain('before `query_semantic_model`, `list_datasets`, or any SQL');
    expect(DQL_MCP_INSTRUCTIONS).toContain('2. If it returns route `certified`, call `query_via_block`');
    expect(DQL_MCP_INSTRUCTIONS).toContain('Semantic compile, only after `ask_dql` returned no certified block');
    expect(DQL_MCP_INSTRUCTIONS).toContain('If its result names a `certifiedBlock`, call `query_via_block`');
    expect(DQL_MCP_INSTRUCTIONS).toContain('Never tell the user that no certified block answers a question unless `ask_dql` said so');
    expect(DQL_MCP_INSTRUCTIONS).not.toMatch(/use `query_semantic_model` before deep dbt or warehouse search\. Return/);
  });

  it('name only tools the profile serves (agents were sent to tools they could not see)', () => {
    for (const profile of ['agentic', 'full'] as const) {
      const served = new Set(__test__.buildMcpToolRegistrations({} as DQLContext, profile).map((tool) => tool.name));
      const everyTool = new Set(dqlToolNamesForSurface('mcp'));
      const named = [...__test__.dqlMcpInstructionsForProfile(profile).matchAll(/`([a-z][a-z0-9_]+)`/g)]
        .map((match) => match[1]!)
        .filter((word) => everyTool.has(word as DqlToolName));
      expect(named.length).toBeGreaterThan(10);
      for (const name of named) expect(served.has(name as DqlToolName), `${profile} instructions name ${name}`).toBe(true);
    }
  });

  it('registers the bounded MCP agentic profile by default', () => {
    const registrations = __test__.buildMcpToolRegistrations({} as DQLContext);

    expect(registrations.map((tool) => tool.name)).toEqual(dqlToolNamesForSurface('mcp_agentic'));
    expect(registrations).toHaveLength(27);
    expect(registrations.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'ask_dql',
        'query_semantic_model',
        'inspect_metadata_context',
        'query_via_metadata',
        'resolve_analytical_path',
        'explain_relationship_proof',
        'expand_context',
        'inspect_dql_project',
        'list_datasets',
        'describe_dataset',
        'preview_tile_query',
        'query_dataset',
        // Governed-generation tools (DQL generates end-to-end; UI parity).
        'answer_question',
        'build_block_from_prompt',
        // Apps and notebooks.
        'build_dql_app',
        'list_apps',
        'list_notebooks',
      ]),
    );
    expect(registrations.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        'feedback_record',
        'record_correction',
        'approve_hint',
        'list_hints',
      ]),
    );
  });

  it('can register the full expert/admin MCP surface explicitly', () => {
    const registrations = __test__.buildMcpToolRegistrations({} as DQLContext, 'full');

    expect(registrations.map((tool) => tool.name)).toEqual(dqlToolNamesForSurface('mcp'));
    expect(registrations.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'build_dql_app',
        'feedback_record',
        'record_correction',
        'approve_hint',
        'list_hints',
      ]),
    );
  });

  it('derives registered MCP input schemas from the canonical registry', () => {
    const registrations = __test__.buildMcpToolRegistrations({} as DQLContext);

    for (const registration of registrations) {
      const registrySchema = getDqlToolDefinition(registration.name).inputSchema;
      const registryProperties = registrySchema.properties && typeof registrySchema.properties === 'object' && !Array.isArray(registrySchema.properties)
        ? Object.keys(registrySchema.properties).sort()
        : [];
      expect(Object.keys(registration.inputSchema).sort()).toEqual(registryProperties);
    }

    const askDql = registrations.find((tool) => tool.name === 'ask_dql');
    expect(askDql?.inputSchema.question.safeParse(undefined).success).toBe(false);
    expect(askDql?.inputSchema.focusObjectKey.safeParse(undefined).success).toBe(true);

    const semantic = registrations.find((tool) => tool.name === 'query_semantic_model');
    expect(semantic?.inputSchema.metrics.safeParse(['total_revenue']).success).toBe(true);
    expect(semantic?.inputSchema.timeDimension.safeParse({ name: 'order_date', granularity: 'month' }).success).toBe(true);
    expect(semantic?.inputSchema.orderBy.safeParse([{ name: 'total_revenue', direction: 'sideways' }]).success).toBe(false);
    expect(semantic?.inputSchema.saveDraft.safeParse(false).success).toBe(true);
    expect(semantic?.inputSchema.dryRun.safeParse(true).success).toBe(true);
    expect(semantic?.inputSchema.rowLimit.safeParse(25).success).toBe(true);

    const metadata = registrations.find((tool) => tool.name === 'query_via_metadata');
    expect(metadata?.inputSchema.followUp.safeParse({
      kind: 'contextual',
      priorResultRef: {
        id: 'turn_1',
        columns: ['product_id', 'supply_id'],
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        source: 'block "previous_product_supply" { query = """SELECT product_id, supply_id FROM supplies""" }',
      },
    }).success).toBe(true);
  });

  it('derives exported tool input schemas from the canonical registry', () => {
    const toolProperties = (name: DqlToolName) =>
      Object.keys(getDqlToolDefinition(name).inputSchema.properties as Record<string, unknown>).sort();

    const exportedInputs: Record<DqlToolName, Record<string, unknown>> = {
      ask_dql: askDqlInput,
      query_semantic_model: querySemanticModelInput,
      kg_search: kgSearchInput,
      search_blocks: searchBlocksInput,
      get_block: getBlockInput,
      query_via_block: queryViaBlockInput,
      inspect_metadata_context: inspectMetadataContextInput,
      expand_context: expandContextInput,
      query_via_metadata: queryViaMetadataInput,
      list_metrics: listMetricsInput,
      list_dimensions: listDimensionsInput,
      lineage_impact: lineageImpactInput,
      certify: certifyInput,
      suggest_block: suggestBlockInput,
      search_metadata: searchMetadataInput,
      get_table_schema: getTableSchemaInput,
      validate_sql: validateSqlInput,
      inspect_dql_project: inspectDqlProjectInput,
      list_datasets: listDatasetsInput,
      describe_dataset: describeDatasetInput,
      preview_tile_query: previewTileQueryInput,
      query_dataset: queryDatasetInput,
      build_dql_block: buildDqlBlockInput,
      build_dql_app: buildDqlAppInput,
      list_proposals: listProposalsInput,
      feedback_record: feedbackRecordInput,
      record_correction: recordCorrectionInput,
      approve_hint: approveHintInput,
      list_hints: listHintsInput,
      list_apps: listAppsInput,
      list_notebooks: listNotebooksInput,
    };
    for (const [name, input] of Object.entries(exportedInputs) as Array<[DqlToolName, Record<string, unknown>]>) {
      expect(Object.keys(input).sort()).toEqual(toolProperties(name));
    }

    expect(askDqlInput.question.safeParse(undefined).success).toBe(false);
    expect(querySemanticModelInput.saveDraft.safeParse(false).success).toBe(true);
    expect(queryViaBlockInput.name.safeParse(undefined).success).toBe(false);
    expect(expandContextInput.relations.safeParse(['SHOP.ANALYTICS.supplies']).success).toBe(true);
    expect(expandContextInput.relations.safeParse([]).success).toBe(false);
    expect(expandContextInput.relations.safeParse(Array.from({ length: 17 }, (_, index) => `relation_${index}`)).success).toBe(false);
    expect(kgSearchInput.kinds.safeParse(['block', 'metric']).success).toBe(true);
    expect(inspectMetadataContextInput.strictness.safeParse('exploratory').success).toBe(true);
    expect(lineageImpactInput.focus.safeParse('block:revenue').success).toBe(true);
    expect(certifyInput.name.safeParse('Revenue').success).toBe(true);
    expect(suggestBlockInput.sql.safeParse('SELECT 1').success).toBe(true);
    expect(listMetricsInput.domain.safeParse('finance').success).toBe(true);
    expect(searchMetadataInput.query.safeParse(undefined).success).toBe(false);
    expect(getTableSchemaInput.table.safeParse('orders').success).toBe(true);
    expect(validateSqlInput.sql.safeParse('SELECT 1').success).toBe(true);
    expect(inspectDqlProjectInput.refresh.safeParse(false).success).toBe(true);
    expect(describeDatasetInput.sourceId.safeParse('app:block:commerce:orders').success).toBe(true);
    expect(queryDatasetInput.query.safeParse({ dimensions: [], measures: [{ measure: 'revenue' }] }).success).toBe(true);
    expect(queryDatasetInput.query.safeParse({ sql: 'SELECT 1', dimensions: [], measures: [] }).success).toBe(false);
    expect(buildDqlAppInput.prompt.safeParse(undefined).success).toBe(false);
    expect(buildDqlBlockInput.sql.safeParse('SELECT 1').success).toBe(true);
    expect(listProposalsInput.since.safeParse('2026-07-01T00:00:00Z').success).toBe(true);
    expect(feedbackRecordInput.rating.safeParse('up').success).toBe(true);
    expect(feedbackRecordInput.rating.safeParse('meh').success).toBe(false);
    expect(recordCorrectionInput.scope.safeParse({ domain: 'orders' }).success).toBe(true);
    expect(approveHintInput.decision.safeParse('approved').success).toBe(true);
    expect(approveHintInput.decision.safeParse('maybe').success).toBe(false);
    expect(listHintsInput.status.safeParse('approved').success).toBe(true);
    expect(queryViaMetadataInput.followUp.safeParse({
      kind: 'contextual',
      priorResultRef: {
        id: 'turn_1',
        columns: ['product_id', 'supply_id'],
      },
      priorDqlArtifact: {
        kind: 'semantic_block',
        source: 'block "monthly_revenue" { type = "semantic" metric = "total_revenue" }',
      },
    }).success).toBe(true);
  });

  it('keeps full-profile instructions scoped to explicit expert/admin sessions', () => {
    expect(__test__.dqlMcpInstructionsForProfile('agentic')).not.toContain('Full expert profile only');
    expect(__test__.dqlMcpInstructionsForProfile('full')).toContain('Full expert profile only');
    expect(__test__.dqlMcpInstructionsForProfile('full')).toContain('record_correction');
  });

  it('tells MCP clients in the answer tools\' descriptions to lead with the trust line', () => {
    const descriptions = Object.fromEntries(
      __test__.buildMcpToolRegistrations({ projectRoot: '/tmp/p' } as never).map((tool) => [tool.name, __test__.toolDescription(tool.name)]),
    );
    for (const name of ['query_via_block', 'query_semantic_model', 'query_via_metadata', 'answer_question']) {
      expect(descriptions[name]).toContain('start your answer with that line');
    }
    expect(descriptions.ask_dql).not.toContain('trustLine');
  });

  it('sends the trust line as its own plain-text block after the JSON, with the rule to show it first', () => {
    const wrapped = __test__.wrap({ trustLine: '🟢 Certified · saved query monthly_revenue', rows: [] }, 'query_via_block');
    expect(JSON.parse(wrapped.content[0]!.text)).toMatchObject({ trustLine: '🟢 Certified · saved query monthly_revenue' });
    expect(wrapped.content[1]?.text).toContain('Start your answer with this trust line');
    expect(wrapped.content[1]?.text).toContain('**🟢 Certified · saved query monthly_revenue**');
  });

  it('compacts MCP tool JSON by default to reduce token load', () => {
    const previous = process.env.ZLENS_MCP_PRETTY_JSON;
    try {
      delete process.env.ZLENS_MCP_PRETTY_JSON;
      const wrapped = __test__.wrap({ answer: 'ok', rows: [{ id: 1 }] });
      expect(wrapped.content[0]?.text).toBe('{"answer":"ok","rows":[{"id":1}]}');
      expect(wrapped.content).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.ZLENS_MCP_PRETTY_JSON;
      else process.env.ZLENS_MCP_PRETTY_JSON = previous;
    }
  });
});

describe('MCP tool annotations and errors', () => {
  it('gives every tool a title and honest behaviour hints (Codex runs read-only tools without asking)', () => {
    const writers = new Set(['answer_question', 'query_via_metadata', 'query_semantic_model', 'suggest_block', 'build_block_from_prompt', 'build_dql_app', 'build_dql_block', 'feedback_record', 'record_correction', 'approve_hint']);
    for (const name of dqlToolNamesForSurface('mcp')) {
      const annotations = mcpToolAnnotations(name);
      expect(annotations.title, name).toBeTruthy();
      expect(annotations.readOnlyHint, name).toBe(!writers.has(name));
      expect(annotations.destructiveHint, name).toBe(false);
      expect(annotations.openWorldHint, name).toBe(false);
    }
  });

  it('flags a failed call with isError and keeps verdicts and answers as results', () => {
    expect(__test__.isToolError({ error: 'No block named "x".' }, 'get_block')).toBe(true);
    expect(__test__.isToolError({ ok: false, error: 'runtime down' }, 'list_datasets')).toBe(true);
    expect(__test__.isToolError({ found: false, error: 'not found' }, 'explain_relationship_proof')).toBe(true);
    expect(__test__.isToolError({ ok: true, rows: [] }, 'query_dataset')).toBe(false);
    expect(__test__.isToolError({ ok: false, code: 'unknown_column', error: 'no column nope' }, 'validate_sql')).toBe(false);
    expect(__test__.isToolError({ disposition: 'blocked', code: 'unbound_relation' }, 'resolve_analytical_path')).toBe(false);
    expect(__test__.wrap({ error: 'x' }, 'get_block')).toMatchObject({ isError: true });
    expect(__test__.wrap({ ok: true }, 'get_block')).not.toHaveProperty('isError');
  });
});

describe('every surface carries the same scope (CTX-001)', () => {
  it('ask_dql and answer_question accept the four scope selections', () => {
    for (const name of ['ask_dql', 'answer_question'] as DqlToolName[]) {
      const properties = getDqlToolDefinition(name).inputSchema.properties as Record<string, unknown>;
      for (const field of ['domain', 'purpose', 'modelAreaId', 'skillRefs']) expect(properties, `${name}.${field}`).toHaveProperty(field);
    }
  });
});
