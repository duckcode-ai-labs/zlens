import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  savedQueryGroupByFromOutputs,
  savedQueryKeepsFirstRows,
  savedQueryResultDescriptor,
  type DatasetDescriptor,
  type ManifestBlock,
} from '@zlens/core';

/**
 * The column types of saved query results (design D1), read once per saved
 * query revision and kept as local runtime state beside the grain proofs. It
 * is never generated into Git: a fresh checkout reads them again through the
 * ordinary execution path the first time a saved query's fields are needed.
 */
export const SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH = '.dql/local/datasets/result-columns.json';

export interface SavedQueryResultColumnsEntry {
  sourceId: string;
  sourceRevision: string;
  columns: Array<{ name: string; type?: string }>;
  typesFrom: 'run' | 'probe';
  observedAt: string;
}

/** Entries keyed by `sourceId`. A corrupt file is treated as empty: the columns are read again. */
export function loadSavedQueryResultColumns(projectRoot: string): Map<string, SavedQueryResultColumnsEntry> {
  const entries = new Map<string, SavedQueryResultColumnsEntry>();
  const path = join(projectRoot, SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH);
  if (!existsSync(path)) return entries;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return entries;
    for (const candidate of raw.entries) {
      const entry = normalizeEntry(candidate);
      if (entry) entries.set(entry.sourceId, entry);
    }
  } catch {
    // Local cache only.
  }
  return entries;
}

/** Record one saved query revision's columns. Returns true when the stored entry changed. */
export function recordSavedQueryResultColumns(projectRoot: string, entry: Omit<SavedQueryResultColumnsEntry, 'observedAt'> & { observedAt?: string }): boolean {
  const entries = loadSavedQueryResultColumns(projectRoot);
  const next: SavedQueryResultColumnsEntry = {
    sourceId: entry.sourceId,
    sourceRevision: entry.sourceRevision,
    columns: entry.columns.map((column) => ({ name: column.name, ...(column.type ? { type: column.type } : {}) })),
    typesFrom: entry.typesFrom,
    observedAt: entry.observedAt ?? new Date().toISOString(),
  };
  const previous = entries.get(entry.sourceId);
  if (previous && previous.sourceRevision === next.sourceRevision && JSON.stringify(previous.columns) === JSON.stringify(next.columns)) return false;
  entries.set(next.sourceId, next);
  const path = join(projectRoot, SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: [...entries.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)) }, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return true;
}

/** A saved query: a block with SQL and no Dataset definition (and not a semantic block). */
export function isPlainSavedQueryBlock(block: Pick<ManifestBlock, 'sql' | 'blockType' | 'datasetGrain' | 'datasetFields' | 'datasetMeasures'>): boolean {
  return Boolean(block.sql?.trim())
    && block.blockType !== 'semantic'
    && !block.datasetGrain
    && !block.datasetFields?.length
    && !block.datasetMeasures?.length;
}

/**
 * The result fields of one saved query, when its column types are known: the
 * block's declared output contract when every column has a type, otherwise
 * the columns last read for this exact revision. Undefined until then.
 */
export function savedQueryResultDescriptorFromManifestBlock(input: {
  block: ManifestBlock;
  sourceId: string;
  sourceRevision: string;
  lifecycle: DatasetDescriptor['lifecycle'];
  observed?: SavedQueryResultColumnsEntry;
}): DatasetDescriptor | undefined {
  const { block } = input;
  if (!isPlainSavedQueryBlock(block)) return undefined;
  const contract = block.outputContract ?? [];
  const contractTyped = contract.length > 0 && contract.every((output) => Boolean(output.name?.trim() && output.type?.trim()));
  const observed = input.observed && input.observed.sourceRevision === input.sourceRevision ? input.observed : undefined;
  const columns = contractTyped ? contract.map((output) => ({ name: output.name, type: output.type })) : observed?.columns;
  if (!columns?.length) return undefined;
  const qualifiedId = `${block.domain ?? 'global'}::block::${block.name}`;
  return savedQueryResultDescriptor({
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    savedQuery: block.name,
    qualifiedId,
    ...(block.domain ? { domain: block.domain } : {}),
    lifecycle: input.lifecycle,
    certified: input.lifecycle === 'certified',
    columns,
    groupBy: savedQueryGroupByFromOutputs(block.outputs),
    typesFrom: contractTyped ? 'contract' : observed!.typesFrom,
    keepsFirstRows: savedQueryKeepsFirstRows(block.sql),
  });
}

function normalizeEntry(value: unknown): SavedQueryResultColumnsEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId.trim() : '';
  const sourceRevision = typeof record.sourceRevision === 'string' ? record.sourceRevision.trim() : '';
  const typesFrom = record.typesFrom === 'run' || record.typesFrom === 'probe' ? record.typesFrom : undefined;
  if (!sourceId || !sourceRevision || !typesFrom || !Array.isArray(record.columns)) return undefined;
  const columns = record.columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const name = typeof (column as Record<string, unknown>).name === 'string' ? ((column as Record<string, unknown>).name as string).trim() : '';
    const type = typeof (column as Record<string, unknown>).type === 'string' ? ((column as Record<string, unknown>).type as string).trim() : '';
    return name ? [{ name, ...(type ? { type } : {}) }] : [];
  });
  if (!columns.length) return undefined;
  return { sourceId, sourceRevision, columns, typesFrom, observedAt: typeof record.observedAt === 'string' ? record.observedAt : '' };
}
