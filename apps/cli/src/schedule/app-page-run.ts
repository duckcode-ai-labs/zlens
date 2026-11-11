import type { QueryRunResult } from './types.js';
import { formatYearValue } from '@zlens/core';

/** One tile as the App runtime settled it for a full page run. */
export interface AppPageRunTile {
  tileId: string;
  title?: string;
  status: string;
  tileType?: string;
  vizType?: string;
  certificationStatus?: string | null;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs?: number;
  sql?: string;
  error?: string;
  /** The tile as the runtime returned it: bound figures, trust and driver results are read from it. */
  raw?: Record<string, unknown>;
}

/** Runs one App page exactly as a reader sees it and returns every tile. */
export type AppPageRunner = (appId: string, dashboardId: string) => Promise<AppPageRunTile[]>;

/**
 * A page runner backed by a ZLens runtime. Scheduled runs go through the same
 * full-page run endpoint the App reader uses, so every tile kind (blocks,
 * Datasets, semantic queries) runs with the same checks and defaults, and a
 * tile that needs review is never delivered as if it were certified.
 *
 * A runtime bound beyond loopback answers API calls only with its bearer
 * token (`ZLENS_SERVER_TOKEN`); pass it as `token`.
 */
export function createRuntimePageRunner(runtimeBase: string, fetchImpl: typeof fetch = fetch, token?: string): AppPageRunner {
  const base = runtimeBase.replace(/\/$/, '');
  return async (appId, dashboardId) => {
    const response = await fetchImpl(
      `${base}/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/run`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ fullRun: true, variables: {} }),
      },
    );
    const payload = await response.json().catch(() => ({})) as { error?: unknown; tiles?: unknown };
    if (!response.ok) {
      throw new Error(typeof payload.error === 'string' ? payload.error : `The App page run failed with HTTP ${response.status}.`);
    }
    return (Array.isArray(payload.tiles) ? payload.tiles : []).map(parseTile);
  };
}

function parseTile(raw: unknown): AppPageRunTile {
  const tile = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const result = tile.result && typeof tile.result === 'object' ? tile.result : {};
  const rows = Array.isArray(result.rows) ? result.rows as Array<Record<string, unknown>> : [];
  const columns = Array.isArray(result.columns)
    ? result.columns.map((column: unknown) => (typeof column === 'string' ? column : String((column as { name?: unknown })?.name ?? ''))).filter(Boolean)
    : rows[0] ? Object.keys(rows[0]) : [];
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  return {
    tileId: String(tile.tileId ?? ''),
    title: text(tile.title),
    status: String(tile.status ?? 'error'),
    tileType: text(tile.tileType),
    vizType: text(tile.viz?.type),
    certificationStatus: text(tile.certificationStatus) ?? text(tile.trustState) ?? null,
    columns,
    rows,
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length,
    durationMs: typeof result.executionTime === 'number' ? result.executionTime : undefined,
    sql: text(result.sql) ?? text(tile.sql),
    error: text(tile.error) ?? text(tile.message) ?? (tile.status && tile.status !== 'ok' ? `Tile status: ${tile.status}` : undefined),
    raw: tile,
  };
}

const SINGLE_VALUE = new Set(['kpi', 'single_value', 'gauge']);

/**
 * The scheduled run as records and a digest a reader can act on: each KPI's
 * value, each chart's row count, the tiles that failed and why, and a trust
 * word per tile. Text tiles are not queries and are left out.
 */
export function summarizeAppPageRun(
  pageTitle: string,
  tiles: AppPageRunTile[],
  previewRows: number,
): { queries: QueryRunResult[]; markdown: string } {
  const dataTiles = tiles.filter((tile) => tile.tileType !== 'text');
  const queries: QueryRunResult[] = dataTiles.map((tile) => ({
    chartId: tile.tileId,
    sql: tile.sql ?? '',
    rowCount: tile.rowCount,
    durationMs: tile.durationMs ?? 0,
    ...(tile.status === 'ok' ? { preview: tile.rows.slice(0, previewRows) } : { error: tile.error ?? `Tile status: ${tile.status}` }),
  }));
  const ok = dataTiles.filter((tile) => tile.status === 'ok');
  const failed = dataTiles.filter((tile) => tile.status !== 'ok');
  const lines = [`# ${pageTitle}`, ''];
  lines.push(`${ok.length} of ${dataTiles.length} tiles ran${failed.length ? `; ${failed.length} did not` : ''}.`, '');
  for (const tile of ok) lines.push(`- ${describeTile(tile)}`);
  if (failed.length) {
    lines.push('', 'Did not run:');
    for (const tile of failed) lines.push(`- ${tile.title ?? tile.tileId}: ${tile.error ?? tile.status}`);
  }
  return { queries, markdown: lines.join('\n') };
}

function describeTile(tile: AppPageRunTile): string {
  const title = tile.title ?? tile.tileId;
  const trust = trustWord(tile.certificationStatus);
  const value = SINGLE_VALUE.has(tile.vizType ?? '') ? singleValue(tile) : undefined;
  const body = value !== undefined ? `**${value}**` : `${tile.rowCount} ${tile.rowCount === 1 ? 'row' : 'rows'}`;
  return `${title}: ${body}${trust ? ` (${trust})` : ''}`;
}

function singleValue(tile: AppPageRunTile): string | undefined {
  if (tile.rows.length !== 1) return undefined;
  const row = tile.rows[0]!;
  const column = tile.columns.find((name) => typeof row[name] === 'number') ?? tile.columns[0];
  if (!column) return undefined;
  const value = row[column];
  // A season or year reads 2014, never 2,014 (V11).
  const year = formatYearValue(column, value);
  if (year !== undefined) return year;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return value === null || value === undefined ? undefined : String(value);
}

function trustWord(status: string | null | undefined): string | undefined {
  if (!status) return undefined;
  if (/certified/i.test(status)) return 'certified';
  if (/review/i.test(status)) return 'needs review';
  if (/governed|semantic/i.test(status)) return 'governed';
  return undefined;
}
