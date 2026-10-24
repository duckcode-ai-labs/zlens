import { tileQueryHash, type TileQuery } from '@zlens/core/apps/tile-query';
import type {
  DashboardDatasetExecutionProvenance,
  DashboardDatasetParameterEvidence,
  DashboardRunResponse,
} from '../../api/client';
import { plainSourceText } from './source-names';
import { formatBusinessLabel } from './app-text';

type DashboardRunTile = DashboardRunResponse['tiles'][number];

export type DatasetEvidenceRow = { label: string; value: string };

/**
 * What a reader must be told about one Dataset tile result, in order: page
 * filters that did not reach it, and permitted adaptations of the Dataset
 * grain (a rollup of an already-aggregated source). Studio and the published
 * viewer render these the same way in substance; each keeps its own styling.
 */
export type DatasetTileNotice = {
  key: string;
  kind: 'excluded' | 'not_linked' | 'adapted' | 'names';
  label: string;
  detail: string;
};

export function datasetTileNotices(tile: DashboardRunTile | undefined, options: { filterLabels?: Record<string, string> } = {}): DatasetTileNotice[] {
  const notices: DatasetTileNotice[] = [];
  const nameOf = (filterId: string) => options.filterLabels?.[filterId] ?? formatBusinessLabel(filterId);
  for (const issue of tile?.dataset?.unboundFilters ?? []) {
    const name = nameOf(issue.filterId);
    notices.push(issue.code === 'DATASET_TILE_EXCLUDED'
      ? { key: `${issue.filterId}:${issue.code}`, kind: 'excluded', label: `Not filtered by ${name}`, detail: plainSourceText(issue.message) }
      : { key: `${issue.filterId}:${issue.code}`, kind: 'not_linked', label: `Not filtered by ${name}`, detail: plainSourceText(issue.message) });
  }
  // Every other data tile reports what the server did with each page filter.
  // A Dataset tile already said so above; text tiles never carry a report.
  if (!tile?.dataset && tile?.tileType !== 'text') {
    for (const entry of tile?.filterReport?.notApplied ?? []) {
      notices.push({ key: `${entry.filter}:${entry.code}`, kind: 'not_linked', label: `Not filtered by ${nameOf(entry.filter)}`, detail: plainSourceText(entry.reason) });
    }
  }
  // A name grouped without a key may merge namesakes (new-user round 3, problem 4).
  for (const warning of tile?.dataset?.nameWarnings ?? []) {
    notices.push({ key: `names:${warning.field}`, kind: 'names', label: 'Names may repeat', detail: warning.message });
  }
  if (tile?.dataset?.validation?.outcome === 'adapted') {
    for (const adaptation of tile.dataset.validation.adaptations) {
      notices.push({
        key: `adaptation:${adaptation.kind}`,
        kind: 'adapted',
        label: adaptation.kind === 'aggregate_time_rollup'
          ? 'Rolled up over time'
          : adaptation.kind === 'saved_query_rollup' ? 'Rolled up from a saved query' : 'Rolled up above the data’s grain',
        detail: adaptation.message,
      });
    }
  }
  return notices;
}

export type DatasetTileEvidencePresentation = {
  authoredQuerySpec?: string;
  authoredQuerySpecUnavailable: string;
  executedSql?: string;
  executedSqlUnavailable: string;
  parameterEvidence: DatasetEvidenceRow[];
  provenance: DatasetEvidenceRow[];
  receipt: {
    kind: 'semantic_provider_receipt' | 'provider_receipt_unavailable';
    rows: DatasetEvidenceRow[];
    notice?: string;
  };
};

/**
 * A browser-safe summary of the settled runtime envelope shared by legacy and
 * Dataset tiles. Dataset filters deliberately expose field/operator identity,
 * while legacy filters expose their authored dashboard filter ID. Values stay
 * out of the evidence drawer in both cases.
 */
export type DashboardTileRunEvidencePresentation = {
  result: string;
  filters?: string;
  parameters?: string;
};

type DatasetTileBinding = {
  sourceId?: string;
  sourceRevision?: string;
  query?: TileQuery;
};

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function count(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parameterRows(evidence: DashboardDatasetParameterEvidence[] | undefined): DatasetEvidenceRow[] {
  if (!Array.isArray(evidence) || evidence.length === 0) return [{ label: 'Bound parameters', value: 'None' }];
  return evidence.flatMap((parameter, index) => {
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.valueFingerprint !== 'string') return [];
    const cardinality = parameter.kind === 'array'
      ? `array (${typeof parameter.valueCount === 'number' ? parameter.valueCount : 'unknown'} values)`
      : parameter.kind;
    return [
      { label: `Parameter ${index + 1}`, value: `${parameter.name} · ${cardinality}` },
      { label: `${parameter.name} binding`, value: parameter.valueFingerprint },
    ];
  });
}

function provenanceRows(provenance: DashboardDatasetExecutionProvenance | undefined): DatasetEvidenceRow[] {
  if (!provenance) return [];
  const rows: DatasetEvidenceRow[] = [
    { label: 'Runtime', value: provenance.kind === 'semantic_runtime' ? 'Metrics run' : 'Saved query run' },
    { label: 'Data source', value: `${provenance.sourceId} · ${provenance.sourceRevision}` },
    { label: 'Contract', value: provenance.contractFingerprint },
    { label: 'Query', value: provenance.queryFingerprint },
    { label: 'Filters', value: provenance.filterFingerprint },
    { label: 'Execution', value: provenance.executionFingerprint },
    { label: 'Parameter binding', value: provenance.parameterFingerprint },
  ];
  if (provenance.targetFingerprint) rows.push({ label: 'Execution target', value: provenance.targetFingerprint });
  if (provenance.compiledSqlFingerprint) rows.push({ label: 'Compiled SQL', value: provenance.compiledSqlFingerprint });
  if (provenance.executedSqlFingerprint) rows.push({ label: 'Executed SQL', value: provenance.executedSqlFingerprint });
  if (provenance.resultFingerprint) rows.push({ label: 'Result', value: provenance.resultFingerprint });
  return rows;
}

function receiptPresentation(receipt: unknown): DatasetTileEvidencePresentation['receipt'] {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return {
      kind: 'provider_receipt_unavailable',
      rows: [],
      notice: 'No provider execution receipt was returned for this saved query run. Server execution provenance is shown instead.',
    };
  }
  const record = receipt as Record<string, unknown>;
  const rows: DatasetEvidenceRow[] = [];
  const stringFields: Array<[string, string]> = [
    ['Receipt', 'receiptId'],
    ['Run', 'runId'],
    ['Semantic snapshot', 'snapshotId'],
    ['Adapter', 'adapterId'],
    ['Execution target', 'executionTargetFingerprint'],
    ['Compiled SQL', 'compiledSqlFingerprint'],
    ['Executed SQL', 'executedSqlFingerprint'],
    ['Parameter binding', 'parameterFingerprint'],
    ['Query', 'queryId'],
    ['Result', 'resultFingerprint'],
    ['Outcome', 'outcome'],
  ];
  for (const [label, key] of stringFields) {
    const value = text(record, key);
    if (value) rows.push({ label, value });
  }
  const rowCount = count(record, 'rowCount');
  if (rowCount !== undefined) rows.push({ label: 'Returned rows', value: String(rowCount) });
  return {
    kind: 'semantic_provider_receipt',
    rows,
    ...(rows.length === 0 ? { notice: 'The semantic provider returned a receipt with no inspectable fields.' } : {}),
  };
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

function rowAndColumnSummary(result: unknown, status: string): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return status;
  const record = result as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const rowCount = count(record, 'rowCount') ?? (Array.isArray(record.rows) ? rows.length : undefined);
  const columns = Array.isArray(record.columns)
    ? record.columns.length
    : rows.length > 0 && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])
      ? Object.keys(rows[0] as Record<string, unknown>).length
      : undefined;
  if (rowCount !== undefined && columns !== undefined) return `${rowCount} rows · ${columns} columns`;
  if (rowCount !== undefined) return `${rowCount} rows`;
  if (columns !== undefined) return `Result returned · ${columns} columns`;
  return 'Result returned';
}

function filterSummary(filters: DashboardRunTile['filters']): string | undefined {
  if (!filters || typeof filters !== 'object') return undefined;
  const record = filters as Record<string, unknown>;
  const applied = records(record.applied).flatMap((filter) => {
    const legacyFilter = text(filter, 'filter');
    if (legacyFilter) return [legacyFilter];
    const field = text(filter, 'field');
    if (!field) return [];
    const op = text(filter, 'op');
    return [op ? `${field} (${op})` : field];
  });
  const skipped = records(record.skipped).length;
  const unbound = records(record.unbound).length;
  const parts = [applied.length ? applied.join(', ') : 'None applied'];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (unbound > 0) parts.push(`${unbound} explicitly unmapped dashboard filter${unbound === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function parameterSummary(invocation: DashboardRunTile['invocation']): string | undefined {
  if (!invocation || typeof invocation !== 'object') return undefined;
  const record = invocation as Record<string, unknown>;
  const resolved = records(record.resolvedParameters);
  if (!Array.isArray(record.resolvedParameters)) return 'No inspectable parameter bindings returned.';
  const names = resolved.flatMap((parameter) => {
    const name = text(parameter, 'name');
    if (!name) return [];
    const source = text(parameter, 'source');
    return [source ? `${name} (${source})` : name];
  });
  return names.join(', ') || 'None';
}

/**
 * Normalizes the two supported runtime envelopes before evidence rendering.
 * This is intentionally explicit rather than a blanket error boundary: a
 * Dataset response uses `unbound`, and a legacy response uses `skipped`.
 */
export function presentDashboardTileRunEvidence(tile: DashboardRunTile): DashboardTileRunEvidencePresentation {
  const filters = filterSummary(tile.filters);
  const parameters = parameterSummary(tile.invocation);
  return {
    result: rowAndColumnSummary(tile.result, tile.status),
    ...(filters ? { filters } : {}),
    ...(parameters ? { parameters } : {}),
  };
}

/**
 * A Dataset result can only display execution evidence when it still matches
 * the page's exact source revision and declarative TileQuery. Studio clears
 * results on filter changes; this guard also protects a late or retained row
 * if a source or query changes before that reset reaches the UI.
 */
export function isCurrentDatasetTileEvidence(
  item: DatasetTileBinding,
  tile: DashboardRunTile | undefined,
): boolean {
  if (!item.query || !item.sourceId || !item.sourceRevision) return false;
  if (!tile || tile.tileType !== 'dataset' || tile.status !== 'ok' || !tile.dataset) return false;
  return tile.dataset.sourceId === item.sourceId
    && tile.dataset.sourceRevision === item.sourceRevision
    && tile.dataset.authoredQueryFingerprint === tileQueryHash(item.query);
}

/**
 * Browser-safe presentation contract shared by Studio and the published App.
 * It projects only whitelisted server evidence; it never parses or exposes
 * raw parameter values from an authored artifact or a provider receipt.
 */
export function presentDatasetTileEvidence(tile: DashboardRunTile): DatasetTileEvidencePresentation | undefined {
  if (tile.artifact?.sourceKind !== 'dataset_query' || !tile.dataset) return undefined;
  const authoredQuerySpec = typeof tile.artifact.authoredQuerySpec === 'string' && tile.artifact.authoredQuerySpec.trim()
    ? tile.artifact.authoredQuerySpec
    : undefined;
  const executedSql = typeof tile.artifact.sql === 'string' && tile.artifact.sql.trim()
    ? tile.artifact.sql
    : undefined;
  return {
    authoredQuerySpec,
    authoredQuerySpecUnavailable: 'The server did not return a redacted authored field query specification for this result.',
    executedSql,
    executedSqlUnavailable: 'Provider SQL was unavailable for this executed result. The provider returned no inspectable SQL; execution provenance is shown instead.',
    parameterEvidence: parameterRows(tile.dataset.parameterEvidence),
    provenance: provenanceRows(tile.dataset.executionProvenance),
    receipt: receiptPresentation(tile.dataset.semanticReceipt),
  };
}
