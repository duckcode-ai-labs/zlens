import type { TileQuery } from '@zlens/core';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';
import { readEnv } from '@zlens/core';
import { fetchRuntime, runtimeUnreachableMessage } from '../runtime-fetch.js';
import { governedAnswerPointer } from './next-step.js';

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3474';

export const listDatasetsInput = zodInputShapeForTool('list_datasets');
export const describeDatasetInput = zodInputShapeForTool('describe_dataset');
export const previewTileQueryInput = zodInputShapeForTool('preview_tile_query');
export const queryDatasetInput = zodInputShapeForTool('query_dataset');

type DatasetRequest = {
  sourceId: string;
  query: TileQuery;
  parameters?: Record<string, unknown>;
  serverUrl?: string;
};

type RuntimeResponse = Record<string, unknown>;

function runtimeBase(serverUrl?: string): string {
  return (serverUrl ?? readEnv('ZLENS_RUNTIME_URL') ?? DEFAULT_RUNTIME_URL).replace(/\/$/, '');
}

function runtimeUnavailable(base: string, projectRoot: string, error: unknown) {
  return {
    ok: false as const,
    runtimeUnavailable: true as const,
    error: runtimeUnreachableMessage(base, projectRoot, error, 'App Dataset tools need it'),
  };
}

async function requestRuntime(
  ctx: DQLContext,
  path: string,
  init: RequestInit,
  serverUrl?: string,
): Promise<{ payload: RuntimeResponse; status: number } | ReturnType<typeof runtimeUnavailable>> {
  const base = runtimeBase(serverUrl);
  let response: Response;
  try {
    response = await fetchRuntime(`${base}${path}`, init);
  } catch (error) {
    return runtimeUnavailable(base, ctx.projectRoot, error);
  }
  const payload = await response.json().catch(async () => ({
    error: `ZLens runtime returned ${response.status}: ${await response.text().catch(() => '')}`,
  })) as RuntimeResponse;
  return { payload, status: response.status };
}

function isUnavailable(value: unknown): value is ReturnType<typeof runtimeUnavailable> {
  return Boolean(value && typeof value === 'object' && (value as { runtimeUnavailable?: unknown }).runtimeUnavailable === true);
}

function runtimeError(status: number, payload: RuntimeResponse) {
  const message = typeof payload.error === 'string' ? payload.error : `ZLens runtime returned ${status}.`;
  return { ok: false as const, error: message };
}

/**
 * Keep the MCP boundary intentionally small. The runtime owns catalog lookup,
 * query validation, source freshness, target identity, proofs, and execution;
 * this adapter only forwards the typed request and projects its safe envelope.
 */
function projectDatasetRuntime(payload: RuntimeResponse) {
  return {
    ok: payload.ok === true,
    ...(payload.version !== undefined ? { version: payload.version } : {}),
    ...(payload.source !== undefined ? { source: payload.source } : {}),
    ...(payload.query !== undefined ? { query: payload.query } : {}),
    ...(payload.validation !== undefined ? { validation: payload.validation } : {}),
    ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
    ...(payload.partial !== undefined ? { partial: payload.partial } : {}),
    ...(payload.publicationEvidence !== undefined ? { publicationEvidence: payload.publicationEvidence } : {}),
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.trustState !== undefined ? { trustState: payload.trustState } : {}),
    ...(payload.filters !== undefined ? { filters: payload.filters } : {}),
    ...(payload.receipt !== undefined ? { receipt: payload.receipt } : {}),
    ...(payload.diagnostics !== undefined ? { diagnostics: payload.diagnostics } : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}

export async function listDatasets(
  ctx: DQLContext,
  args: { query?: string; serverUrl?: string },
) {
  const search = new URLSearchParams();
  if (args.query?.trim()) search.set('query', args.query.trim());
  const response = await requestRuntime(
    ctx,
    `/api/app-datasets${search.size > 0 ? `?${search}` : ''}`,
    { method: 'GET' },
    args.serverUrl,
  );
  if (isUnavailable(response)) return response;
  if (response.status < 200 || response.status >= 300) return runtimeError(response.status, response.payload);
  const datasets = (response.payload.datasets ?? []) as unknown[];
  const pointer = datasets.length === 0
    ? governedAnswerPointer(ctx, 'No App Datasets are approved here; Datasets are warehouse tables approved for App tiles, not the governed answers.')
    : undefined;
  return {
    ok: true as const,
    version: response.payload.version,
    snapshotId: response.payload.snapshotId,
    datasets,
    total: response.payload.total ?? 0,
    ...(pointer ?? {}),
  };
}

export async function describeDataset(
  ctx: DQLContext,
  args: { sourceId: string; serverUrl?: string },
) {
  const sourceId = args.sourceId?.trim();
  if (!sourceId) return { ok: false as const, error: 'Provide a non-empty sourceId.' };
  const response = await requestRuntime(
    ctx,
    `/api/app-datasets?${new URLSearchParams({ sourceId })}`,
    { method: 'GET' },
    args.serverUrl,
  );
  if (isUnavailable(response)) return response;
  if (response.status < 200 || response.status >= 300) return runtimeError(response.status, response.payload);
  return {
    ok: true as const,
    version: response.payload.version,
    snapshotId: response.payload.snapshotId,
    dataset: response.payload.dataset,
  };
}

export async function previewTileQuery(ctx: DQLContext, args: DatasetRequest) {
  return runDatasetRequest(ctx, '/api/app-datasets/preview', args);
}

export async function queryDataset(ctx: DQLContext, args: DatasetRequest) {
  return runDatasetRequest(ctx, '/api/app-datasets/run', args);
}

async function runDatasetRequest(ctx: DQLContext, path: string, args: DatasetRequest) {
  const sourceId = args.sourceId?.trim();
  if (!sourceId || !args.query) return { ok: false as const, error: 'Provide sourceId and a typed TileQuery.' };
  const response = await requestRuntime(
    ctx,
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Deliberately exclude serverUrl and all caller-provided authority.
      body: JSON.stringify({
        sourceId,
        query: args.query,
        ...(args.parameters ? { parameters: args.parameters } : {}),
      }),
    },
    args.serverUrl,
  );
  if (isUnavailable(response)) return response;
  if (response.status < 200 || response.status >= 300) return runtimeError(response.status, response.payload);
  return projectDatasetRuntime(response.payload);
}
