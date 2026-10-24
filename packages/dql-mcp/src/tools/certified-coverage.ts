import { ensureMetadataCatalogFresh, planAgentAnswer } from '@zlens/agent';
import type { DQLContext } from '../context.js';

/**
 * Does a certified block already answer what `query_semantic_model` was asked
 * to compile? A client with no agent guide file (Claude Desktop) can reach the
 * semantic compiler without calling `ask_dql`; this check keeps it from
 * presenting an uncertified draft as the only answer.
 *
 * Two checks, in order:
 *  - `router`: the question goes through the same planner `ask_dql` uses, so
 *    both tools agree on whether a certified block answers it.
 *  - `metric_and_grain`: for the compiled members, a certified block that
 *    aggregates the same measure on the same table at the same time grain,
 *    with the same other dimensions and no filters.
 */
export interface CertifiedBlockCoverage {
  name: string;
  domain: string | null;
  grain: string | null;
  description: string | null;
  sourcePath: string | null;
  matchedBy: 'router' | 'metric_and_grain';
  nextTool: 'query_via_block';
  queryViaBlockArgs: { name: string; question?: string };
}

export interface CertifiedCoverageResult {
  /** False when the router could not run; the caller must not claim that no certified block exists. */
  checked: boolean;
  /** The `ask_dql` route for the question, when the router ran. */
  route?: string;
  block?: CertifiedBlockCoverage;
}

export interface SemanticMemberSelection {
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: unknown[];
}

export async function findCertifiedBlockCoverage(
  ctx: DQLContext,
  input: { question?: string; members: SemanticMemberSelection },
): Promise<CertifiedCoverageResult> {
  let checked = false;
  let route: string | undefined;
  if (input.question) {
    try {
      await ensureMetadataCatalogFresh(ctx.projectRoot).catch(() => undefined);
      const planned = await planAgentAnswer(ctx.projectRoot, { question: input.question, limit: 100, surface: 'mcp' });
      checked = true;
      route = planned.routeDecision.route;
      const exactKey = planned.routeDecision.exactObjectKey;
      if (route === 'certified' && exactKey) {
        const object = planned.contextPack.objects.find((candidate) => candidate.objectKey === exactKey);
        const name = object?.name ?? exactKey.replace(/^dql:block:/, '');
        const block = certifiedManifestBlock(ctx, name);
        if (block) return { checked, route, block: coverage(block, 'router', input.question) };
      }
    } catch {
      // The structural check below still runs; `checked` stays false unless it matches.
    }
  }

  const structural = certifiedBlockForMembers(ctx, input.members);
  if (structural) return { checked: true, route, block: coverage(structural, 'metric_and_grain', input.question) };
  return { checked, route };
}

type ManifestBlockLike = {
  name: string;
  status?: string;
  domain?: string;
  grain?: string;
  description?: string;
  filePath?: string;
  sql?: string;
  dimensions?: string[];
  metricRef?: string;
  metricRefs?: string[];
};

function certifiedBlocks(ctx: DQLContext): ManifestBlockLike[] {
  return Object.values((ctx.manifest?.blocks ?? {}) as Record<string, ManifestBlockLike>)
    .filter((block) => block.status === 'certified');
}

function certifiedManifestBlock(ctx: DQLContext, name: string): ManifestBlockLike | undefined {
  return certifiedBlocks(ctx).find((block) => block.name === name);
}

function coverage(
  block: ManifestBlockLike,
  matchedBy: CertifiedBlockCoverage['matchedBy'],
  question: string | undefined,
): CertifiedBlockCoverage {
  return {
    name: block.name,
    domain: block.domain ?? null,
    grain: block.grain ?? null,
    description: block.description ?? null,
    sourcePath: block.filePath ?? null,
    matchedBy,
    nextTool: 'query_via_block',
    queryViaBlockArgs: { name: block.name, ...(question ? { question } : {}) },
  };
}

/**
 * One metric at one time grain (plus the same other dimensions), no filters: the shape of a certified trend block like `monthly_revenue`.
 */
export function certifiedBlockForMembers(
  ctx: DQLContext,
  members: SemanticMemberSelection,
): ManifestBlockLike | undefined {
  const granularity = members.timeDimension?.granularity?.toLowerCase();
  if (!granularity || members.metrics.length !== 1 || (members.filters?.length ?? 0) > 0) return undefined;
  const layer = ctx.semanticLayer;
  const metric = layer?.listMetrics().find((candidate) => candidate.name === members.metrics[0]);
  if (!metric || metric.filter || (metric.filters && Object.keys(metric.filters).length > 0)) return undefined;
  const aggregate = metricAggregateSql(metric.sql, metric.type);
  const table = relationLeaf(metric.table);
  if (!aggregate || !table) return undefined;

  const timeNames = new Set(
    (layer?.listDimensions() ?? []).filter((dimension) => dimension.isTimeDimension).map((dimension) => dimension.name),
  );
  const otherDimensions = members.dimensions.filter((dimension) => !timeNames.has(dimension));

  for (const block of certifiedBlocks(ctx)) {
    if (block.metricRef === metric.name || block.metricRefs?.includes(metric.name)) {
      if (mentionsGrain(block, granularity)) return block;
      continue;
    }
    const sql = normalizeSql(block.sql ?? '');
    if (!sql.includes(aggregate) || /\bwhere\b|\bjoin\b|\bhaving\b/.test(sql)) continue;
    const from = sql.match(/\bfrom\s+([a-z0-9_."`]+)/)?.[1];
    if (!from || relationLeaf(from) !== table) continue;
    if (!mentionsGrain(block, granularity)) continue;
    const blockOthers = (block.dimensions ?? []).filter((dimension) => !grainWord(granularity).test(dimension.toLowerCase()));
    if (!sameSet(blockOthers, otherDimensions)) continue;
    return block;
  }
  return undefined;
}

function metricAggregateSql(sql: string | undefined, type: string | undefined): string | undefined {
  const expression = normalizeSql(sql ?? '');
  if (!expression) return undefined;
  if (/^[a-z_]+\(/.test(expression)) return expression;
  if (type === 'sum' || type === 'avg' || type === 'min' || type === 'max' || type === 'count') return `${type}(${expression})`;
  if (type === 'count_distinct') return `count(distinct ${expression})`;
  return undefined;
}

function mentionsGrain(block: ManifestBlockLike, granularity: string): boolean {
  const word = grainWord(granularity);
  return word.test((block.grain ?? '').toLowerCase())
    || (block.dimensions ?? []).some((dimension) => word.test(dimension.toLowerCase()))
    || normalizeSql(block.sql ?? '').includes(`date_trunc('${granularity}'`);
}

function grainWord(granularity: string): RegExp {
  const adjective = granularity === 'day' ? 'daily' : `${granularity}ly`;
  return new RegExp(`\\b(${granularity}|${adjective})\\b`);
}

function relationLeaf(relation: string | undefined): string | undefined {
  const leaf = relation?.split('.').pop()?.replace(/["`]/g, '').trim().toLowerCase();
  return leaf || undefined;
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
}

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left.map((value) => value.toLowerCase()));
  const b = new Set(right.map((value) => value.toLowerCase()));
  return a.size === b.size && [...a].every((value) => b.has(value));
}
