import { createHash } from 'node:crypto';
import { noEgress } from '@zlens/connectors';
import type { EffectiveDbtCloudSemanticSettings } from './semantic-runtime-settings.js';

export interface DbtCloudSemanticQueryRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
}

export interface DbtCloudSemanticTestResult {
  ok: boolean;
  message: string;
  dialect?: string;
  metricCount?: number;
  metricNames?: string[];
  semanticCatalogFingerprint?: string;
  metricInventoryComplete?: boolean;
}

export interface DbtCloudSemanticCompileResult {
  sql: string;
  engine: 'dbt-cloud';
}

export interface DbtCloudSemanticMetricInventory {
  names: string[];
  totalItems: number;
  fingerprint: string;
  complete: boolean;
}

type FetchLike = typeof fetch;

export async function testDbtCloudSemanticConnection(
  settings: EffectiveDbtCloudSemanticSettings,
  fetchImpl: FetchLike = fetch,
  options: { includeMetricInventory?: boolean } = {},
): Promise<DbtCloudSemanticTestResult> {
  assertConfigured(settings);
  const data = await graphqlRequest<{
    environmentInfo?: { dialect?: string | null };
    metricsPaginated?: { totalItems?: number | null };
  }>(settings, {
    query: `query DqlSemanticRuntimeTest($environmentId: BigInt!) {
      environmentInfo(environmentId: $environmentId) { dialect }
      metricsPaginated(environmentId: $environmentId, pageNum: 1, pageSize: 1) { totalItems }
    }`,
    variables: { environmentId: settings.environmentId },
  }, fetchImpl);
  const dialect = data.environmentInfo?.dialect ?? undefined;
  const metricCount = typeof data.metricsPaginated?.totalItems === 'number'
    ? data.metricsPaginated.totalItems
    : undefined;
  const inventory = options.includeMetricInventory === false
    ? undefined
    : await listDbtCloudSemanticMetrics(settings, fetchImpl);
  return {
    ok: true,
    message: `Test passed${dialect ? ` · ${dialect}` : ''}${metricCount !== undefined ? ` · ${metricCount.toLocaleString()} metrics` : ''}.`,
    dialect,
    metricCount,
    ...(inventory ? {
      metricNames: inventory.names,
      semanticCatalogFingerprint: inventory.fingerprint,
      metricInventoryComplete: inventory.complete,
    } : {}),
  };
}

/**
 * API-004/PERF-002: capture a bounded, deterministic inventory of the metrics
 * that the configured dbt Cloud environment can actually resolve. Local dbt
 * artifacts are authoring evidence; this inventory is the compiler capability
 * proof and must never be inferred from a count alone.
 */
export async function listDbtCloudSemanticMetrics(
  settings: EffectiveDbtCloudSemanticSettings,
  fetchImpl: FetchLike = fetch,
): Promise<DbtCloudSemanticMetricInventory> {
  assertConfigured(settings);
  const pageSize = 500;
  const maxPages = 100;
  const names = new Set<string>();
  let pageNum = 1;
  let totalPages = 1;
  let totalItems = 0;
  do {
    const data = await graphqlRequest<{
      metricsPaginated?: {
        items?: Array<{ name?: string | null }>;
        totalPages?: number | null;
        totalItems?: number | null;
      };
    }>(settings, {
      query: `query DqlSemanticMetricInventory($environmentId: BigInt!, $pageNum: Int!, $pageSize: Int!) {
        metricsPaginated(environmentId: $environmentId, pageNum: $pageNum, pageSize: $pageSize) {
          items { name }
          totalPages
          totalItems
        }
      }`,
      variables: {
        environmentId: settings.environmentId,
        pageNum,
        pageSize,
      },
    }, fetchImpl);
    const page = data.metricsPaginated;
    for (const item of page?.items ?? []) {
      const name = item.name?.trim();
      if (name) names.add(name);
    }
    totalPages = Math.max(1, page?.totalPages ?? 1);
    totalItems = Math.max(totalItems, page?.totalItems ?? names.size);
    pageNum += 1;
  } while (pageNum <= totalPages && pageNum <= maxPages);

  const ordered = Array.from(names).sort((left, right) => left.localeCompare(right));
  const complete = totalPages <= maxPages && ordered.length === totalItems;
  return {
    names: ordered,
    totalItems,
    complete,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({
        environmentId: settings.environmentId,
        metrics: ordered,
        totalItems,
        complete,
      }))
      .digest('hex'),
  };
}

export async function compileDbtCloudSemanticQuery(
  settings: EffectiveDbtCloudSemanticSettings,
  request: DbtCloudSemanticQueryRequest,
  fetchImpl: FetchLike = fetch,
): Promise<DbtCloudSemanticCompileResult> {
  assertConfigured(settings);
  if (!request.savedQuery && request.metrics.length === 0) {
    throw new Error('dbt Cloud semantic query requires at least one metric or a saved query.');
  }
  const variables: Record<string, unknown> = {
    environmentId: settings.environmentId,
    metrics: request.metrics.map((name) => ({ name })),
    groupBy: [
      ...request.dimensions.map((name) => ({ name })),
      ...(request.timeDimension
        ? [{ name: request.timeDimension.name, grain: normalizeGranularity(request.timeDimension.granularity) }]
        : []),
    ],
    where: buildWhereClauses(request.filters ?? []).map((sql) => ({ sql })),
    orderBy: (request.orderBy ?? []).map((order) => request.dimensions.includes(order.name)
      || request.timeDimension?.name === order.name
      ? { groupBy: { name: order.name }, descending: order.direction === 'desc' }
      : { metric: { name: order.name }, descending: order.direction === 'desc' }),
    limit: boundedLimit(request.limit),
    savedQuery: request.savedQuery,
  };
  const declarations = [
    '$environmentId: BigInt!',
    '$metrics: [MetricInput!]',
    '$groupBy: [GroupByInput!]',
    '$where: [WhereInput!]',
    '$orderBy: [OrderByInput!]',
    '$limit: Int',
    '$savedQuery: String',
  ].join(', ');
  const data = await graphqlRequest<{ compileSql?: { sql?: string | null } }>(settings, {
    query: `mutation DqlCompileSemanticQuery(${declarations}) {
      compileSql(
        environmentId: $environmentId
        metrics: $metrics
        groupBy: $groupBy
        where: $where
        orderBy: $orderBy
        limit: $limit
        savedQuery: $savedQuery
      ) { sql }
    }`,
    variables,
  }, fetchImpl);
  const sql = data.compileSql?.sql?.trim();
  if (!sql) throw new Error('dbt Cloud Semantic Layer compiled the request but returned no SQL.');
  return { sql, engine: 'dbt-cloud' };
}

export async function listDbtCloudCompatibleDimensions(
  settings: EffectiveDbtCloudSemanticSettings,
  metrics: string[],
  fetchImpl: FetchLike = fetch,
): Promise<Array<{ name: string; description?: string; type?: string; granularities: string[] }>> {
  assertConfigured(settings);
  if (metrics.length === 0) return [];
  const pageSize = 500;
  const dimensions: Array<{ name: string; description?: string; type?: string; granularities: string[] }> = [];
  let pageNum = 1;
  let totalPages = 1;
  do {
    const data = await graphqlRequest<{
      dimensionsPaginated?: {
        items?: Array<{ name?: string; description?: string | null; type?: string | null; queryableGranularities?: string[] | null }>;
        totalPages?: number | null;
      };
    }>(settings, {
      query: `query DqlCompatibleDimensions($environmentId: BigInt!, $metrics: [MetricInput!]!, $pageNum: Int!, $pageSize: Int!) {
        dimensionsPaginated(environmentId: $environmentId, metrics: $metrics, pageNum: $pageNum, pageSize: $pageSize) {
          items { name description type queryableGranularities }
          totalPages
        }
      }`,
      variables: {
        environmentId: settings.environmentId,
        metrics: metrics.map((name) => ({ name })),
        pageNum,
        pageSize,
      },
    }, fetchImpl);
    for (const item of data.dimensionsPaginated?.items ?? []) {
      if (!item.name) continue;
      dimensions.push({
        name: item.name,
        description: item.description ?? undefined,
        type: item.type ?? undefined,
        granularities: item.queryableGranularities ?? [],
      });
    }
    totalPages = Math.max(1, data.dimensionsPaginated?.totalPages ?? 1);
    pageNum += 1;
  } while (pageNum <= totalPages && pageNum <= 100);
  return dimensions;
}

async function graphqlRequest<T>(
  settings: EffectiveDbtCloudSemanticSettings,
  body: { query: string; variables?: Record<string, unknown> },
  fetchImpl: FetchLike,
): Promise<T> {
  // An install with no internet access (an app inside Snowflake) never calls an outside service.
  if (noEgress()) throw new Error('This install has no internet access (ZLENS_NO_EGRESS), so it cannot use the dbt Cloud Semantic Layer.');
  assertConfigured(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('dbt Cloud Semantic Layer request timed out.')), 10_000);
  try {
    const response = await fetchImpl(settings.endpoint!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.serviceToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok) {
      throw new Error(`dbt Cloud Semantic Layer request failed (${response.status}).`);
    }
    if (payload.errors?.length) {
      throw new Error(`dbt Cloud Semantic Layer: ${payload.errors.map((error) => error.message || 'GraphQL error').join(' ')}`);
    }
    if (!payload.data) throw new Error('dbt Cloud Semantic Layer returned no data.');
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

function assertConfigured(settings: EffectiveDbtCloudSemanticSettings): asserts settings is EffectiveDbtCloudSemanticSettings & {
  endpoint: string;
  environmentId: string;
  serviceToken: string;
} {
  if (!settings.endpoint || !settings.environmentId || !settings.serviceToken) {
    throw new Error('dbt Cloud Semantic Layer requires Host, Environment ID, and Service Token.');
  }
}

function normalizeGranularity(value: string): string {
  const normalized = value.trim().toUpperCase();
  const allowed = new Set(['SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
  if (!allowed.has(normalized)) throw new Error(`Unsupported dbt semantic time granularity: ${value}`);
  return normalized;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

function buildWhereClauses(filters: NonNullable<DbtCloudSemanticQueryRequest['filters']>): string[] {
  return filters.flatMap((filter) => {
    if (filter.expression?.trim()) return [filter.expression.trim()];
    if (!filter.dimension || !filter.operator) return [];
    const values = filter.values ?? [];
    const quote = (value: string) => /^-?\d+(\.\d+)?$/.test(value.trim())
      ? value.trim()
      : `'${value.replace(/'/g, "''")}'`;
    const member = `{{ Dimension('${filter.dimension.replace(/'/g, "''")}') }}`;
    const first = values[0] ?? '';
    switch (filter.operator) {
      case 'equals':
        return values.length <= 1
          ? [`${member} = ${quote(first)}`]
          : [`${member} IN (${values.map(quote).join(', ')})`];
      case 'not_equals': return [`${member} != ${quote(first)}`];
      case 'in': return values.length > 0 ? [`${member} IN (${values.map(quote).join(', ')})`] : [];
      case 'not_in': return values.length > 0 ? [`${member} NOT IN (${values.map(quote).join(', ')})`] : [];
      case 'greater_than': return [`${member} > ${quote(first)}`];
      case 'greater_than_or_equal': return [`${member} >= ${quote(first)}`];
      case 'less_than': return [`${member} < ${quote(first)}`];
      case 'less_than_or_equal': return [`${member} <= ${quote(first)}`];
      case 'contains': return [`${member} LIKE ${quote(`%${first}%`)}`];
      default: return [];
    }
  });
}
