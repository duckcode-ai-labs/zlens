import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { QUICK_CALC_LABELS, formatTileCalcExpr } from '@zlens/core/apps/tile-calcs';
import {
  readerTileTrust as coreReaderTileTrust,
  isDataTileForTrust as coreIsDataTileForTrust,
  type ReaderTrust,
  type ReaderTrustItem,
  type ReaderTrustTile,
} from '@zlens/core/apps/reader-trust';

/**
 * The reader's trust vocabulary lives in dql-core (RFC 0008 step 6, shared
 * with signed snapshots and digests in step 10). This module adds what only
 * the reader needs: freshness and the receipt behind a tile.
 */
export { READER_TRUST_LABELS, certifiedByLabel, plainCertificationChecks, readerTrustCounts, readerTrustSummary } from '@zlens/core/apps/reader-trust';
export type { CertificationByline, ReaderTrust, ReaderTrustState } from '@zlens/core/apps/reader-trust';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

export function isDataTileForTrust(item: LayoutItem, tile?: RunTile): boolean {
  return coreIsDataTileForTrust(item as ReaderTrustItem, tile as ReaderTrustTile | undefined);
}

export function readerTileTrust(item: LayoutItem, tile?: RunTile): ReaderTrust | null {
  return coreReaderTileTrust(item as ReaderTrustItem, tile as ReaderTrustTile | undefined);
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function relativeAge(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(thenMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * How fresh a tile's numbers are. A cached Dataset result says when it was
 * cached; anything else ran when this page run settled.
 */
export function readerTileFreshness(tile: RunTile | undefined, ranAtMs: number | undefined, nowMs: number): string | null {
  const cachedAt = tile?.dataset?.cacheDelivery?.cachedAt;
  const cachedMs = cachedAt ? Date.parse(cachedAt) : NaN;
  if (Number.isFinite(cachedMs)) return `Cached ${relativeAge(cachedMs, nowMs)}`;
  if (tile?.status === 'ok' && ranAtMs !== undefined) return `Updated ${relativeAge(ranAtMs, nowMs)}`;
  return null;
}

export interface ReceiptRow {
  label: string;
  value: string;
  /** Fingerprints and ids are shown in a monospace face and can be copied. */
  code?: boolean;
  /**
   * Ids, hashes, file paths and fingerprints: shown only under the
   * collapsed **Technical details** toggle (D6).
   */
  technical?: boolean;
  /** Several items (the checks that passed), shown as a list. */
  list?: string[];
}

/** The rows a person reads first, and the ones kept under Technical details. */
export function splitTechnicalRows(rows: ReceiptRow[]): { plain: ReceiptRow[]; technical: ReceiptRow[] } {
  return { plain: rows.filter((row) => !row.technical), technical: rows.filter((row) => row.technical) };
}

const short = (value: string | undefined | null) => (value ? (value.length > 16 ? `${value.slice(0, 12)}…` : value) : undefined);

/**
 * The receipt behind a tile's numbers: where they came from, which filters
 * applied, when they ran, and the fingerprints that let anyone check the
 * result was not changed. Only rows with evidence are returned.
 */
export function readerTileReceipt(
  item: LayoutItem,
  tile: RunTile | undefined,
  run: Pick<DashboardRunResponse, 'runId' | 'snapshotId' | 'filterFingerprint'> | null,
  ranAtMs: number | undefined,
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const push = (label: string, value: string | undefined | null, code = false, technical = code) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') rows.push({ label, value: String(value), ...(code ? { code } : {}), ...(technical ? { technical } : {}) });
  };
  const source = tile?.artifact?.name ?? tile?.citation?.name ?? tile?.blockPath ?? item.block?.blockId ?? tile?.dataset?.sourceId;
  push('Source', source);
  const trust = readerTileTrust(item, tile);
  // Who certified it and when, and the checks that passed (D5).
  if (trust?.state === 'certified' && trust.byline && trust.byline !== 'Certified') push('Certified', trust.byline);
  if (trust?.state === 'certified' && trust.checks?.length) rows.push({ label: 'Checks passed', value: trust.checks.join(' · '), list: trust.checks });
  push('Source file', tile?.artifact?.sourcePath ?? tile?.citation?.path ?? tile?.blockPath, false, true);
  push('Owner', item.owner);
  // How related tables were joined, in plain words (design D2).
  const joins = (tile?.dataset as { joins?: Array<{ sentence?: string }> } | undefined)?.joins ?? [];
  if (joins.length) rows.push({ label: 'Joined', value: joins.map((join) => join.sentence).join(' · '), list: joins.flatMap((join) => (join.sentence ? [join.sentence] : [])) });
  // Every calculation's expression, so a reader can see how a number was made.
  push('Calculations', calculationWords(item.query as TileQuery | undefined).join(' · ') || undefined);
  const applied = tile?.filters?.applied ?? [];
  push('Filters', applied.length
    ? applied.map((filter) => `${filter.field ?? filter.filter ?? 'filter'} ${filter.op && filter.op !== '=' && filter.op !== 'in' ? `${filter.op} ` : ''}${formatFilterValue(filter.values)}`).join(' · ')
    : 'None applied');
  const rowCount = tile?.result?.rowCount ?? tile?.result?.rows?.length;
  push('Rows', rowCount !== undefined ? rowCount.toLocaleString() : undefined);
  push('Last refreshed', ranAtMs !== undefined ? new Date(ranAtMs).toLocaleString() : undefined);
  push('Cached at', tile?.dataset?.cacheDelivery?.cachedAt ? new Date(tile.dataset.cacheDelivery.cachedAt).toLocaleString() : undefined);
  push('Result fingerprint', short(tile?.result?.resultFingerprint ?? tile?.dataset?.executionProvenance?.resultFingerprint ?? (tile as { resultFingerprint?: string } | undefined)?.resultFingerprint), true);
  push('SQL fingerprint', short(tile?.dataset?.executionProvenance?.executedSqlFingerprint ?? (tile as { compiledSqlFingerprint?: string } | undefined)?.compiledSqlFingerprint), true);
  push('Snapshot', short(run?.snapshotId), true);
  push('Run', short(run?.runId), true);
  return rows;
}

function calculationWords(query: TileQuery | undefined): string[] {
  return (query?.calculations ?? []).map((calculation) => {
    const name = calculation.label ?? calculation.id;
    if (calculation.expr) return `${name} = ${formatTileCalcExpr(calculation.expr)}`;
    const quick = calculation.quick!;
    const words = `${QUICK_CALC_LABELS[quick.kind]} of ${quick.of}${quick.within ? ` within each ${quick.within}` : ''}`;
    return calculation.label ? `${calculation.label} = ${words.toLowerCase()}` : words;
  });
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? 'any');
}
