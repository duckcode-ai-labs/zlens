import type { CellChartConfig, QueryResult } from '../../store/types';
import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { coerceTrustState, getDashboardItemBlockId, getDqlGenUi, roleForDisplayComponent } from './dashboard-tile-model';
import { settleGridLayout } from '@zlens/core/apps/grid-layout';
import { nonMeasureColumnRole, isRankColumnName } from '@zlens/core/apps/result-measures';
import { formatDashboardValue, formatGenUiLabel, isNumericColumn, type DashboardStory } from './dashboard-format';
import { formatDashboardFilterValue } from './dashboard-filter-words';

/**
 * How a dashboard is presented to a stakeholder: which tiles the read-only
 * view hides, where they sit, and the deterministic Business Story.
 *
 * Extracted from `DashboardRenderer.tsx`. All pure — no React, no I/O — which
 * is what makes the visibility rules testable.
 */
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type DashboardRunTile = DashboardRunResponse['tiles'][number];

export function isStakeholderHiddenReviewTile(item: DashboardLayoutItem): boolean {
  if (getDashboardItemBlockId(item) || item.aiPin) return false;
  const genUi = getDqlGenUi(item);
  const component = genUi?.component ?? item.display?.component;
  const role = genUi?.role ?? roleForDisplayComponent(component);
  const trustState = coerceTrustState(String(genUi?.trustState ?? item.display?.trustState ?? 'review_required'));
  if (component === 'TrustCallout' || component === 'ResearchActions' || role === 'trust' || role === 'research') return true;
  if (component !== 'NarrativePanel' && component !== 'BusinessBrief') return false;
  if (trustState === 'certified') return false;
  const text = [
    item.title,
    item.text?.markdown,
    item.display?.rationale,
    genUi?.rationale,
    genUi?.insightTitle,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(draft ready|review-required|review required|missing evidence|missing proof|trust gap|research drilldown|promote to a certified block|generated review placeholder|generated section)\b/.test(text);
}

export function prepareStakeholderItems(
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
  cols: number,
): DashboardLayoutItem[] {
  const deduped = items.filter((item) => {
    return !isReviewRequiredAiPinStakeholderTile(item, tileResults.get(item.i))
      && !isRedundantStaticStakeholderTile(item, items, tileResults)
      && !isDuplicateAiPinStakeholderTile(item, items, tileResults);
  });
  // The reader keeps the author's placement (RFC 0008 step 5). Hidden tiles
  // leave a gap, which settling closes; nothing is re-ranked.
  return settleGridLayout(deduped, cols);
}

function isReviewRequiredAiPinStakeholderTile(item: DashboardLayoutItem, tile?: DashboardRunTile): boolean {
  if (!item.aiPin) return false;
  const certification = tile?.aiPin?.certification;
  const reviewStatus = tile?.aiPin?.reviewStatus;
  return certification !== 'certified' && reviewStatus !== 'certified';
}

function isDuplicateAiPinStakeholderTile(
  item: DashboardLayoutItem,
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
): boolean {
  if (!item.aiPin) return false;
  const fingerprint = aiPinStakeholderFingerprint(item, tileResults.get(item.i));
  if (!fingerprint) return false;
  const index = items.findIndex((candidate) => candidate.i === item.i);
  return items.some((candidate, candidateIndex) => {
    if (candidate.i === item.i || candidateIndex >= index || !candidate.aiPin) return false;
    return aiPinStakeholderFingerprint(candidate, tileResults.get(candidate.i)) === fingerprint;
  });
}

function aiPinStakeholderFingerprint(item: DashboardLayoutItem, tile?: DashboardRunTile): string {
  const pin = tile?.aiPin;
  const plan = pin?.analysisPlan && typeof pin.analysisPlan === 'object'
    ? pin.analysisPlan as Record<string, unknown>
    : null;
  const question = normalizeAiPinText(pin?.question) || normalizeAiPinText(item.title);
  const sourceBlock = normalizeAiPinText(plan?.sourceBlockId);
  const sourceTile = normalizeAiPinText(plan?.sourceTileId);
  const result = pin?.result ? aiPinResultFingerprint(pin.result) : '';
  if (!question && !sourceBlock && !sourceTile) return '';
  return [question, sourceBlock, sourceTile, result].filter(Boolean).join('|');
}

function normalizeAiPinText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aiPinResultFingerprint(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as { columns?: unknown; rows?: unknown };
  const columns = Array.isArray(record.columns) ? record.columns.map((column) => String(column).toLowerCase()).join(',') : '';
  const rows = Array.isArray(record.rows) ? record.rows.slice(0, 8).map((row) => stableFingerprintValue(row)).join(';') : '';
  return columns || rows ? `${columns}:${rows}` : '';
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprintValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${key}:${stableFingerprintValue(record[key])}`).join(',')}}`;
}

function isRedundantStaticStakeholderTile(
  item: DashboardLayoutItem,
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
): boolean {
  if (item.parameterBindings?.length || item.aiPin || !getDashboardItemBlockId(item)) return false;
  const tile = tileResults.get(item.i);
  const fingerprint = tile?.result ? stakeholderResultFingerprint(tile.result) : null;
  if (!fingerprint) return false;
  return items.some((candidate) => {
    if (candidate.i === item.i || !isFilterAwareStakeholderItem(candidate, tileResults.get(candidate.i))) return false;
    const candidateTile = tileResults.get(candidate.i);
    const candidateFingerprint = candidateTile?.result ? stakeholderResultFingerprint(candidateTile.result) : null;
    return Boolean(candidateFingerprint && sameStakeholderFingerprint(fingerprint, candidateFingerprint));
  });
}

function isFilterAwareStakeholderItem(item: DashboardLayoutItem, tile?: DashboardRunTile): boolean {
  return Boolean(item.parameterBindings?.length || tile?.filters?.applied?.length);
}

function stakeholderResultFingerprint(result: QueryResult): { columns: string; label: string; metric: string; metricValue: string } | null {
  const rows = result.rows ?? [];
  if (!rows.length) return null;
  const columns = result.columns?.length ? result.columns : Object.keys(rows[0] ?? {});
  if (!columns.length) return null;
  const labelColumn = pickStoryLabelColumn(columns, rows);
  const metricColumn = pickStoryMetricColumn(columns, rows);
  const first = rows[0];
  return {
    columns: columns.map((column) => column.toLowerCase()).sort().join('|'),
    label: labelColumn ? canonicalStakeholderValue(first[labelColumn]) : '',
    metric: metricColumn?.toLowerCase() ?? '',
    metricValue: metricColumn ? canonicalStakeholderValue(first[metricColumn]) : '',
  };
}

function sameStakeholderFingerprint(
  left: NonNullable<ReturnType<typeof stakeholderResultFingerprint>>,
  right: NonNullable<ReturnType<typeof stakeholderResultFingerprint>>,
): boolean {
  return left.columns === right.columns
    && left.label === right.label
    && left.metric === right.metric
    && left.metricValue === right.metricValue;
}

function canonicalStakeholderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildDashboardStory(
  items: DashboardLayoutItem[],
  tileResults: Map<string, DashboardRunTile>,
  variables: Record<string, unknown>,
  filters?: DashboardDocumentResponse['dashboard']['filters'],
): DashboardStory | null {
  const candidate = items
    .map((item, index) => ({ item, tile: tileResults.get(item.i), index }))
    .filter((entry): entry is { item: DashboardLayoutItem; tile: DashboardRunTile; index: number } => {
      return entry.tile?.status === 'ok'
        && Boolean(entry.tile.result)
        && Array.isArray(entry.tile.result?.rows)
        && entry.tile.result.rows.length > 0;
    })
    .sort((a, b) => {
      const scoreA = storyTileScore(a.item, a.tile, a.index);
      const scoreB = storyTileScore(b.item, b.tile, b.index);
      return scoreB - scoreA;
    })[0];
  if (!candidate?.tile.result) return null;

  const result = candidate.tile.result;
  const rows = result.rows;
  const columns = result.columns ?? Object.keys(rows[0] ?? {});
  if (!columns.length) return null;

  const genUi = getDqlGenUi(candidate.item);
  const labelColumn = pickStoryLabelColumn(columns, rows, genUi?.fieldHints?.label);
  const metricColumn = pickStoryMetricColumn(columns, rows, genUi?.fieldHints?.value ?? genUi?.fieldHints?.y);
  // Who leads: the row ranked first when the result is a ranking, otherwise
  // the largest value of the measure, never simply the first row returned.
  const rankColumn = columns.find((column) => column !== metricColumn && isRankColumnName(column) && isNumericColumn(column, rows));
  const ordered = rankColumn
    ? [...rows].sort((a, b) => (toStoryNumber(a[rankColumn]) ?? Number.POSITIVE_INFINITY) - (toStoryNumber(b[rankColumn]) ?? Number.POSITIVE_INFINITY))
    : metricColumn
      ? [...rows].sort((a, b) => (toStoryNumber(b[metricColumn]) ?? Number.NEGATIVE_INFINITY) - (toStoryNumber(a[metricColumn]) ?? Number.NEGATIVE_INFINITY))
      : rows;
  const first = ordered[0]!;
  const second = ordered[1];
  const labelValues = labelColumn ? rows.map((row) => row[labelColumn]) : [];
  const metricValues = metricColumn ? rows.map((row) => row[metricColumn]) : [];
  const firstLabel = labelColumn ? formatDashboardValue(labelColumn, first[labelColumn], labelValues) : 'The leading result';
  const secondLabel = second && labelColumn ? formatDashboardValue(labelColumn, second[labelColumn], labelValues) : null;
  const firstMetric = metricColumn ? toStoryNumber(first[metricColumn]) : null;
  const secondMetric = metricColumn && second ? toStoryNumber(second[metricColumn]) : null;
  const metricLabel = metricColumn ? storyMetricLabel(metricColumn) : null;
  const filterChips = storyFilterChips(variables, filters);
  const filterPhrase = filterChips.length ? 'under the selected app filters' : 'in the current dashboard view';
  const sourceTitle = candidate.item.title ?? candidate.tile.title ?? getDashboardItemBlockId(candidate.item) ?? 'Dashboard result';
  const rowCount = result.rowCount ?? rows.length;
  const trust = candidate.tile.certificationStatus === 'certified'
    ? 'certified'
    : coerceTrustState(String(candidate.item.display?.trustState ?? genUi?.trustState ?? 'review_required'));
  const title = metricLabel ? `${formatGenUiLabel(metricLabel)} snapshot` : 'Dashboard snapshot';

  let summary: string;
  if (metricColumn && metricLabel && firstMetric !== null) {
    const leading = `${firstLabel} leads ${metricLabel} with ${formatDashboardValue(metricColumn, firstMetric, metricValues, { compact: true })}`;
    if (secondLabel && secondMetric !== null && Number.isFinite(firstMetric - secondMetric)) {
      const gap = Math.abs(firstMetric - secondMetric);
      summary = `${leading}, ahead of ${secondLabel} by ${formatDashboardValue(metricColumn, gap, metricValues, { compact: true })} ${filterPhrase}.`;
    } else {
      summary = `${leading} ${filterPhrase}.`;
    }
  } else {
    summary = `${sourceTitle} returned ${rowCount} ${rowCount === 1 ? 'row' : 'rows'} ${filterPhrase}.`;
  }

  return {
    title,
    summary,
    sourceTitle,
    trust,
    filters: filterChips,
    chips: [
      `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`,
      columns.length ? `${columns.length} fields` : '',
    ].filter(Boolean),
  };
}

function storyTileScore(item: DashboardLayoutItem, tile: DashboardRunTile, index: number): number {
  const genUi = getDqlGenUi(item);
  const component = genUi?.component ?? item.display?.component;
  const result = tile.result;
  let score = 1000 - index;
  if (tile.certificationStatus === 'certified') score += 500;
  if (getDashboardItemBlockId(item)) score += 180;
  if (tile.filters?.applied?.length) score += 260;
  if (item.parameterBindings?.length) score += 220;
  if (component === 'RankingPanel' || component === 'EvidenceTable' || component === 'KpiMetric') score += 120;
  if (item.viz.type === 'table' || item.viz.type === 'bar' || item.viz.type === 'kpi') score += 70;
  if (result && pickStoryMetricColumn(result.columns, result.rows)) score += 80;
  if (result && pickStoryLabelColumn(result.columns, result.rows)) score += 50;
  return score;
}

function pickStoryLabelColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  const hinted = pickHintedColumn(columns, hint);
  if (hinted) return hinted;
  return columns.find((column) => /\b(player|customer|account|team|segment|category|name|label|title|entity)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows) && !/\b(date|time|year|month|id)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows));
}

function pickStoryMetricColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  const hinted = pickHintedColumn(columns, hint);
  if (hinted && isNumericColumn(hinted, rows)) return hinted;
  // A rank, an id, a year or a code is numeric and still a label.
  return columns
    .filter((column) => isNumericColumn(column, rows) && nonMeasureColumnRole(column) === undefined)
    .sort((a, b) => storyMetricRank(a) - storyMetricRank(b))[0];
}

function pickHintedColumn(columns: string[], hint?: string): string | undefined {
  const normalizedHint = hint?.toLowerCase().trim();
  if (!normalizedHint) return undefined;
  return columns.find((column) => {
    const lower = column.toLowerCase();
    return lower === normalizedHint || lower.includes(normalizedHint) || normalizedHint.includes(lower);
  });
}

function storyMetricRank(column: string): number {
  const lower = column.toLowerCase();
  if (/(total|revenue|amount|points|score|value|sales|arr|mrr)/.test(lower)) return 1;
  if (/(count|orders|games|customers|rows|volume)/.test(lower)) return 2;
  if (/(rate|pct|percent|ratio|margin|average|avg)/.test(lower)) return 3;
  if (/(rank|position|index)/.test(lower)) return 20;
  if (/(date|year|month|day|week|id)/.test(lower)) return 90;
  return 30;
}

function storyMetricLabel(column: string): string {
  return formatGenUiLabel(column).toLowerCase();
}

export function storyFilterChips(
  variables: Record<string, unknown>,
  filters?: DashboardDocumentResponse['dashboard']['filters'],
): Array<{ label: string; value: string }> {
  const declared = new Map((filters ?? []).map((filter) => [filter.id, filter]));
  return Object.entries(variables)
    .filter(([key, value]) => {
      if (/^(smartView|persona|dashboardId|appId)$/i.test(key)) return false;
      if (key.startsWith('__')) return false;
      if (value === null || value === undefined || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      // A date or number range is a filter too: it reads in words below.
      return typeof value !== 'object' || Array.isArray(value) || formatDashboardFilterValue(value, declared.get(key)) !== null;
    })
    .slice(0, 6)
    .map(([key, value]) => ({
      label: declared.get(key)?.label?.trim() || formatGenUiLabel(key),
      value: Array.isArray(value)
        ? value.map((entry) => formatStoryFilterValue(key, entry)).join(', ')
        : typeof value === 'object'
          ? formatDashboardFilterValue(value, declared.get(key)) ?? ''
          : formatStoryFilterValue(key, value),
    }));
}

function formatStoryFilterValue(key: string, value: unknown): string {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (/(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatDashboardValue(key, value, [value]);
}

function toStoryNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}
