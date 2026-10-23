import {
  resolveTrustLabel,
  type ComposeQueryOptions,
  type DqlArtifactReference,
  type SemanticLayer,
} from '@zlens/core';
import {
  buildAnalysisQuestionPlan,
  composeSemanticQueryForQuestion,
  semanticDqlArtifactName,
  renderSemanticDqlArtifact,
  upsertGeneratedDqlArtifactDraft,
  type GeneratedDraftBlock,
} from '@zlens/agent';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';
import { readEnv } from '@zlens/core';
import { fetchRuntime, runtimeUnreachableMessage } from '../runtime-fetch.js';
import { findCertifiedBlockCoverage, type CertifiedCoverageResult } from './certified-coverage.js';

export const querySemanticModelInput = zodInputShapeForTool('query_semantic_model');

const DEFAULT_QUERY_SEMANTIC_MODEL_ROW_LIMIT = 200;

export async function querySemanticModel(
  ctx: DQLContext,
  args: {
    question?: string;
    metrics?: string[];
    dimensions?: string[];
    timeDimension?: { name: string; granularity: string };
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    rowLimit?: number;
    saveDraft?: boolean;
    dryRun?: boolean;
    serverUrl?: string;
    driver?: string;
    tableMapping?: Record<string, string>;
  },
) {
  const layer = ctx.semanticLayer;
  const available = semanticInventory(layer);
  if (available.metrics.length === 0) {
    return {
      matched: false,
      reason: 'No semantic metrics are available in this project.',
      available,
    };
  }

  const explicitMetrics = args.metrics?.map((metric) => metric.trim()).filter(Boolean) ?? [];
  if (explicitMetrics.length > 0) {
    const composeOptions: ComposeQueryOptions = {
      metrics: explicitMetrics,
      dimensions: args.dimensions ?? [],
      ...(args.timeDimension ? { timeDimension: args.timeDimension } : {}),
      ...(args.filters?.length ? { filters: args.filters } : {}),
      ...(args.orderBy?.length ? { orderBy: args.orderBy } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.driver ? { driver: args.driver } : {}),
      ...(args.tableMapping ? { tableMapping: args.tableMapping } : {}),
    };
    const composed = layer.composeQuery(composeOptions);
    if (!composed) {
      return {
        matched: false,
        reason: semanticCompileGap(layer, composeOptions),
        requested: composeOptions,
        available,
      };
    }
    const artifactName = semanticDqlArtifactName({
      question: args.question ?? explicitMetrics.join(', '),
      metrics: explicitMetrics,
      domain: layer.listMetrics().find((metric) => metric.name === explicitMetrics[0])?.domain,
      titleFallback: layer.listMetrics().find((metric) => metric.name === explicitMetrics[0])?.label ?? explicitMetrics[0],
      dimensions: args.dimensions ?? [],
      filters: args.filters ?? [],
      timeDimension: args.timeDimension,
      orderBy: args.orderBy,
      limit: args.limit,
    });
    const domain = layer.listMetrics().find((metric) => metric.name === explicitMetrics[0])?.domain;
    const dqlArtifact: DqlArtifactReference & { kind: 'semantic_block' } = {
      kind: 'semantic_block' as const,
      name: artifactName,
      source: renderSemanticDqlArtifact({
        name: artifactName,
        question: args.question ?? explicitMetrics.join(', '),
        metrics: explicitMetrics,
        domain,
        titleFallback: layer.listMetrics().find((metric) => metric.name === explicitMetrics[0])?.label ?? explicitMetrics[0],
        dimensions: args.dimensions ?? [],
        filters: args.filters ?? [],
        timeDimension: args.timeDimension,
        orderBy: args.orderBy,
        limit: args.limit,
      }),
      metrics: explicitMetrics,
      dimensions: args.dimensions ?? [],
      ...(args.filters?.length ? { filters: args.filters } : {}),
      ...(args.timeDimension ? { timeDimension: args.timeDimension } : {}),
      ...(args.orderBy?.length ? { orderBy: args.orderBy } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    };
    const certified = await findCertifiedBlockCoverage(ctx, {
      question: args.question?.trim() || undefined,
      members: { metrics: explicitMetrics, dimensions: args.dimensions ?? [], timeDimension: args.timeDimension, filters: args.filters },
    });
    const draftBlock = saveSemanticDraft(ctx.projectRoot, {
      saveDraft: args.saveDraft ?? (certified.block ? false : undefined),
      name: artifactName,
      question: args.question ?? explicitMetrics.join(', '),
      domain,
      dqlArtifact,
      outputs: semanticArtifactOutputs(dqlArtifact),
    });
    const preview = await previewSemanticQuery(ctx, {
      sql: composed.sql,
      title: args.question ?? explicitMetrics.join(', '),
      dryRun: args.dryRun,
      serverUrl: args.serverUrl,
      rowLimit: args.rowLimit,
    });
    const trust = semanticCompileTrustStatus(draftBlock, preview.error, certified);
    return {
      ...certifiedCoverageFields(certified),
      matched: true,
      uncertified: true,
      reviewStatus: 'draft_ready',
      certification: 'governed',
      trustLabelInfo: trust.trustLabelInfo,
      trustStatus: trust,
      mode: 'explicit_members',
      metrics: explicitMetrics,
      dimensions: args.dimensions ?? [],
      filters: args.filters ?? [],
      ...(args.timeDimension ? { timeDimension: args.timeDimension } : {}),
      ...(args.orderBy?.length ? { orderBy: args.orderBy } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      sql: composed.sql,
      composeResult: composed,
      ...preview,
      draftBlock,
      dqlArtifact: draftBlock
        ? { ...dqlArtifact, sourcePath: dqlArtifact.sourcePath ?? draftBlock.path }
        : dqlArtifact,
    };
  }

  const question = args.question?.trim();
  if (!question) {
    return {
      matched: false,
      reason: 'Provide either metrics[] for explicit semantic compilation or question for deterministic member selection.',
      available,
    };
  }

  const result = composeSemanticQueryForQuestion({
    semanticLayer: layer,
    question,
    questionPlan: buildAnalysisQuestionPlan(question),
    driver: args.driver,
    tableMapping: args.tableMapping,
  });
  const certified = await findCertifiedBlockCoverage(ctx, {
    question,
    members: result
      ? { metrics: result.metrics, dimensions: result.dimensions, timeDimension: result.timeDimension, filters: result.filters }
      : { metrics: [], dimensions: [] },
  });
  if (!result) {
    return {
      ...certifiedCoverageFields(certified),
      matched: false,
      reason: 'No semantic match: no semantic metric with a compatible dimension and time grain matches the question by name or label. Do not substitute another metric; answer through ask_dql\'s generated route instead.',
      available,
    };
  }

  const draftBlock = saveSemanticDraft(ctx.projectRoot, {
    saveDraft: args.saveDraft ?? (certified.block ? false : undefined),
    name: result.dqlArtifact.name ?? result.metric,
    question,
    domain: layer.listMetrics().find((metric) => metric.name === result.metric)?.domain,
    dqlArtifact: result.dqlArtifact,
    outputs: semanticArtifactOutputs(result.dqlArtifact),
  });
  const preview = await previewSemanticQuery(ctx, {
    sql: result.sql,
    title: question,
    dryRun: args.dryRun,
    serverUrl: args.serverUrl,
    rowLimit: args.rowLimit,
  });
  const trust = semanticCompileTrustStatus(draftBlock, preview.error, certified);

  return {
    ...certifiedCoverageFields(certified),
    matched: true,
    uncertified: true,
    reviewStatus: 'draft_ready',
    certification: 'governed',
    trustLabelInfo: trust.trustLabelInfo,
    trustStatus: trust,
    mode: 'question_selection',
    metric: result.metric,
    metrics: result.metrics,
    dimensions: result.dimensions,
    filters: result.filters,
    ...(result.timeDimension ? { timeDimension: result.timeDimension } : {}),
    ...(result.orderBy?.length ? { orderBy: result.orderBy } : {}),
    ...(result.limit ? { limit: result.limit } : {}),
    sql: result.sql,
    composeResult: result.composeResult,
    ...preview,
    draftBlock,
    dqlArtifact: draftBlock
      ? { ...result.dqlArtifact, sourcePath: result.dqlArtifact.sourcePath ?? draftBlock.path }
      : result.dqlArtifact,
  };
}

/**
 * Why an explicit selection did not compile, in the modeler's words: the
 * metric the native engine cannot run (an offset-window derived metric, say)
 * or the dimension the metrics cannot reach. Falls back to a generic sentence.
 */
function semanticCompileGap(layer: SemanticLayer, options: ComposeQueryOptions): string {
  const gaps = [
    ...options.metrics.map((metric) => layer.explainNativeMetricGap?.(metric)),
    ...(options.metrics.every((metric) => !layer.explainNativeMetricGap?.(metric))
      ? (options.dimensions ?? []).map((dimension) => layer.explainDimensionGap?.(options.metrics, dimension))
      : []),
  ].filter((gap): gap is string => Boolean(gap));
  return gaps.length > 0
    ? `No semantic match: ${gaps.join(' ')}`
    : 'No semantic match: the semantic layer could not compile the requested metric/dimension selection.';
}

/**
 * Leads the result, so an agent reads it before the compiled draft: the
 * certified block that answers this, or what the certified check found.
 */
function certifiedCoverageFields(certified: CertifiedCoverageResult) {
  if (certified.block) {
    return {
      certifiedBlock: certified.block,
      nextTool: 'query_via_block' as const,
      recommendedAction: `Certified block "${certified.block.name}"${certified.block.grain ? ` (${certified.block.grain})` : ''} answers this. Call query_via_block with { name: "${certified.block.name}" } and answer from it. This semantic compile is an uncertified draft; do not say that no certified block exists.`,
    };
  }
  return {
    certifiedCheck: { checked: certified.checked, ...(certified.route ? { askDqlRoute: certified.route } : {}) },
    ...(certified.checked ? {} : { recommendedAction: 'Certified blocks were not checked for this request. Call ask_dql with the user\'s question before answering from this draft.' }),
  };
}

/**
 * A semantic compile reads only governed metrics and dimensions, and the
 * compiler (not a model) writes its SQL. The Ask page heads the same answer
 * "Answer from Metrics" (`trustState: governed`), so MCP labels it From Metrics too:
 * above AI-Generated, below Certified. The saved draft still needs review
 * before it can be certified.
 */
function semanticCompileTrustStatus(draftBlock?: GeneratedDraftBlock, executionError?: string, certified?: CertifiedCoverageResult) {
  return {
    label: 'From Metrics: semantic compile',
    uncertified: true,
    reviewStatus: 'draft_ready',
    certification: 'governed',
    trustLabelInfo: resolveTrustLabel('governed'),
    draftPath: draftBlock?.path,
    promotionPath: draftBlock ? 'zlens certify --from-draft' : undefined,
    caveats: [
      certifiedCaveat(certified),
      'From Metrics: semantic-layer members were compiled deterministically. Not certified: review the DQL artifact before certifying it.',
      'semantic_draft_review_required',
      ...(executionError ? [`Execution caveat: ${executionError}`] : []),
    ],
  };
}

function certifiedCaveat(certified: CertifiedCoverageResult | undefined): string {
  if (certified?.block) {
    return `Certified block "${certified.block.name}" answers this; use query_via_block for the certified answer.`;
  }
  if (certified?.checked) return 'No certified block exactly answered this question.';
  return 'Certified blocks were not checked; ask_dql decides whether a certified block answers the question.';
}

async function previewSemanticQuery(
  ctx: DQLContext,
  input: {
    sql: string;
    title: string;
    dryRun?: boolean;
    serverUrl?: string;
    rowLimit?: number;
  },
) {
  const rowLimit = normalizedPreviewRowLimit(input.rowLimit);
  if (input.dryRun) {
    return {
      executionStatus: 'dry_run',
      reason: 'dryRun=true; SQL not executed. Returned semantic DQL artifact and compiled SQL only.',
      maxRowsReturned: rowLimit,
    };
  }

  const safety = buildSemanticPreviewSql(input.sql, rowLimit);
  if (!safety.ok) {
    return {
      executionStatus: 'rejected',
      error: safety.error,
      maxRowsReturned: rowLimit,
    };
  }

  const base = input.serverUrl ?? readEnv('ZLENS_RUNTIME_URL') ?? 'http://127.0.0.1:3474';
  const url = `${base.replace(/\/$/, '')}/api/notebook/execute`;
  let response: Response;
  try {
    response = await fetchRuntime(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cell: {
          id: `mcp-semantic-${semanticPreviewSlug(input.title)}`,
          type: 'sql',
          source: safety.sql,
          title: input.title,
        },
      }),
    });
  } catch (err) {
    return {
      executionStatus: 'runtime_unavailable',
      error: runtimeUnreachableMessage(base, ctx.projectRoot, err, 'The preview needs it (dryRun=true returns the compiled SQL without it)'),
      maxRowsReturned: rowLimit,
    };
  }

  if (!response.ok) {
    return {
      executionStatus: 'runtime_error',
      error: `Runtime returned ${response.status}: ${await response.text()}`,
      maxRowsReturned: rowLimit,
    };
  }

  const payload = (await response.json()) as {
    result?: {
      columns?: Array<{ name: string; type?: string }>;
      rows?: unknown[];
      executionTime?: number;
    };
    error?: string;
  };
  if (payload.error) {
    return {
      executionStatus: 'execution_failed',
      error: payload.error,
      maxRowsReturned: rowLimit,
    };
  }

  const rows = payload.result?.rows ?? [];
  const returnedRows = rows.slice(0, rowLimit);
  return {
    executionStatus: 'executed',
    rowCount: rows.length,
    returnedRowCount: returnedRows.length,
    maxRowsReturned: rowLimit,
    rowsTruncated: rows.length > returnedRows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: returnedRows,
  };
}

function buildSemanticPreviewSql(sql: string, limit: number): { ok: true; sql: string } | { ok: false; error: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: 'Semantic SQL preview is empty.' };
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '').trim();
  const scanSql = stripSqlStringsAndComments(withoutTrailingSemicolon).trim();
  if (!/^(select|with)\b/i.test(scanSql)) {
    return { ok: false, error: 'Semantic SQL preview only supports read-only SELECT or WITH queries.' };
  }
  if (scanSql.includes(';')) {
    return { ok: false, error: 'Semantic SQL preview only supports one statement.' };
  }
  const forbiddenPattern = new RegExp(`\\b(${SEMANTIC_PREVIEW_FORBIDDEN_SQL.join('|')})\\b`, 'i');
  const forbidden = scanSql.match(forbiddenPattern)?.[1];
  if (forbidden) {
    return { ok: false, error: `Semantic SQL preview rejected unsupported statement keyword: ${forbidden.toUpperCase()}.` };
  }
  return {
    ok: true,
    sql: `SELECT * FROM (\n${withoutTrailingSemicolon}\n) AS dql_mcp_semantic_preview LIMIT ${normalizedPreviewRowLimit(limit)}`,
  };
}

const SEMANTIC_PREVIEW_FORBIDDEN_SQL = [
  'alter',
  'analyze',
  'attach',
  'call',
  'copy',
  'create',
  'delete',
  'detach',
  'drop',
  'execute',
  'grant',
  'insert',
  'install',
  'load',
  'merge',
  'pragma',
  'reset',
  'revoke',
  'set',
  'truncate',
  'update',
  'vacuum',
];

function normalizedPreviewRowLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_QUERY_SEMANTIC_MODEL_ROW_LIMIT), 1), 10000);
}

function semanticPreviewSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'semantic-query';
}

function stripSqlStringsAndComments(sql: string): string {
  let output = '';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      output += '  ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < sql.length) output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < sql.length) {
        output += '  ';
        index += 1;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      output += ' ';
      while (index + 1 < sql.length) {
        index += 1;
        output += sql[index] === '\n' ? '\n' : ' ';
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 1;
            output += ' ';
            continue;
          }
          break;
        }
      }
      continue;
    }
    output += current;
  }
  return output;
}

function saveSemanticDraft(
  projectRoot: string,
  input: {
    saveDraft?: boolean;
    name: string;
    question: string;
    domain?: string;
    dqlArtifact: DqlArtifactReference & { kind: 'semantic_block' };
    outputs: string[];
  },
): GeneratedDraftBlock | undefined {
  if (input.saveDraft === false) return undefined;
  return upsertGeneratedDqlArtifactDraft(projectRoot, {
    slug: input.name,
    question: input.question,
    proposedContractId: `${input.domain ?? 'semantic'}.Unknown.${input.name}`,
    proposedDomain: input.domain,
    dqlArtifact: input.dqlArtifact,
    outputs: input.outputs,
    routeIntent: 'semantic_compile',
    validationWarnings: ['semantic_draft_review_required'],
  });
}

function semanticArtifactOutputs(artifact: { metrics?: string[]; dimensions?: string[]; timeDimension?: { name: string; granularity: string } }): string[] {
  return Array.from(new Set([
    ...(artifact.dimensions ?? []),
    ...(artifact.timeDimension ? [`${artifact.timeDimension.name}_${artifact.timeDimension.granularity}`] : []),
    ...(artifact.metrics ?? []),
  ]));
}

function semanticInventory(layer: SemanticLayer) {
  return {
    metrics: layer.listMetrics().slice(0, 80).map((metric) => ({
      name: metric.name,
      label: metric.label,
      domain: metric.domain,
      status: metric.status,
      table: metric.table,
      type: metric.type,
      description: metric.description,
    })),
    dimensions: layer.listDimensions().slice(0, 120).map((dimension) => ({
      name: dimension.name,
      label: dimension.label,
      domain: dimension.domain,
      status: dimension.status,
      table: dimension.table,
      type: dimension.type,
      isTimeDimension: dimension.isTimeDimension,
      description: dimension.description,
    })),
  };
}
