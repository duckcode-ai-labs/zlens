import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  SemanticLayer,
  getDialect,
  loadSemanticDimensionDraftsFromDir,
  loadSemanticLayerFromDir,
  loadSemanticMetricDraftsFromDir,
  serializeDimensionDefinitionToYaml,
  serializeMetricDefinitionToYaml,
  type DimensionDefinition,
  type MetricDefinition,
} from '@zlens/core';
import type { CalculationKind } from './bi-import/calculations.js';
import { convertCalculationsToMetricDrafts, isPlainSqlName, type MetricDraft, type ResolvedTable } from './bi-import/metric-drafts.js';
import type { BiTableSource } from './bi-import/types.js';
import type { ImportCalculations } from './block-studio-import.js';
import type { WarehouseTableSummary } from './datasets/table-dataset.js';

/**
 * The import's metric drafts (D3): a BI file's simple, filtered and ratio
 * calculations, placed on the connected database's tables, run once over all
 * rows, and written to `semantic-layer/metrics/_drafts/<domain>/`, where they
 * answer nothing until a person approves them. Approving moves a draft's text
 * out of `_drafts/` with `status: certified`, who approved it and when.
 */

export type ImportMetricDraftOutcome = 'drafted' | 'reused' | 'failed' | 'left-out' | 'row-level' | 'advanced';

export interface ImportMetricDraftItem {
  calculation: string;
  formula: string;
  language: 'tableau' | 'dax';
  sourcePath: string;
  owner?: string;
  kind: CalculationKind;
  outcome: ImportMetricDraftOutcome;
  /** drafted: the draft's name; reused: the metric (or draft) it already is. */
  metric?: string;
  /** The draft file, relative to the project. */
  path?: string;
  inWords?: string;
  /** The value over all rows, when the check ran; null when the database returned no value. */
  value?: number | null;
  /** Why it was left out, or the database's error when its check failed. */
  reason?: string;
  notes: string[];
  /** A ratio or derived draft's simple parts, approved with it. */
  parts?: string[];
}

export interface ImportMetricDrafts {
  importId: string;
  domain: string;
  ranAt: string;
  /** False when nothing was written (the project's metrics live in dbt, or the database's tables could not be read). */
  written: boolean;
  notWrittenReason?: string;
  /** Whether the drafts were run once on the database (`--no-check` skips it). */
  checked: boolean;
  items: ImportMetricDraftItem[];
  /** The columns of the drafts' tables written as dimension drafts: what the metrics can group by once approved. */
  dimensions: Array<{ name: string; label: string; table: string; path: string }>;
}

export interface MakeImportMetricDraftsInput {
  projectRoot: string;
  importId: string;
  domain: string;
  owner?: string;
  calculations: ImportCalculations;
  /** Set when the project's metrics live elsewhere (dbt): every draft is listed, none is written (M8). */
  metricsLiveElsewhere?: string;
  /** The connected database's tables and columns. */
  listTables: () => Promise<WarehouseTableSummary[]>;
  driver: string;
  /** The database and server ZLens is connected to, to say when a file reads another. */
  connection?: { database?: string; server?: string };
  /** Runs one read-only statement on the connected database. */
  run: (sql: string) => Promise<Array<Record<string, unknown>>>;
  check: boolean;
  /**
   * With a host, a check's value is computed under the importer's row rules,
   * so it stays in their own import record and out of the project's files.
   */
  privateValues?: boolean;
  now?: Date;
}

const DRAFTS_DIR = join('semantic-layer', 'metrics', '_drafts');
const DIMENSION_DRAFTS_DIR = join('semantic-layer', 'dimensions', '_drafts');

export async function makeImportMetricDrafts(input: MakeImportMetricDraftsInput): Promise<ImportMetricDrafts> {
  const ranAt = (input.now ?? new Date()).toISOString();
  const semanticDir = join(input.projectRoot, 'semantic-layer');
  const existingMetrics = existsSync(semanticDir) ? loadSemanticLayerFromDir(semanticDir).listMetrics() : [];
  const existingDrafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
  const existingDimensions = existsSync(semanticDir) ? [...loadSemanticLayerFromDir(semanticDir).listDimensions(), ...loadSemanticDimensionDraftsFromDir(semanticDir)] : [];
  const base = { importId: input.importId, domain: input.domain, ranAt };

  let tables: WarehouseTableSummary[] | null = null;
  let tablesError: string | undefined;
  if (!input.metricsLiveElsewhere) {
    try {
      tables = await input.listTables();
    } catch (error) {
      tablesError = error instanceof Error ? error.message : String(error);
    }
  }
  const driver = input.driver.trim().toLowerCase();
  const dialect = getDialect(driver);
  const name = sqlNamer(driver);
  const resolveTable = tables
    ? (source: BiTableSource): ResolvedTable | { error: string } => {
      const matched = matchTable(source, tables!);
      if ('error' in matched) return matched;
      const notes = connectionNotes(source, matched, input.connection);
      return {
        sql: [matched.schema, matched.name].filter(Boolean).map((part) => name(part!)).join('.'),
        columns: new Map(matched.columns.map((column) => [column.name.toLowerCase(), name(column.name)])),
        notes,
      };
    }
    : undefined;

  const converted = convertCalculationsToMetricDrafts(input.calculations.calculations, input.calculations.models, {
    domain: input.domain,
    ...(input.owner ? { owner: input.owner } : {}),
    importedAt: ranAt,
    ...(resolveTable ? { resolveTable } : {}),
    existingMetrics,
    existingDrafts,
    existingDimensions,
    stringLiteral: (value) => dialect.quoteString(value),
  });

  const draftsByName = new Map(converted.drafts.map((draft) => [draft.definition.name, draft]));
  const values = new Map<string, number | null>();
  const failures = new Map<string, string>();
  const checkNotes = new Map<string, string[]>();
  const written = Boolean(tables) && !input.metricsLiveElsewhere;
  if (written && input.check) {
    await checkDrafts(converted.drafts, input.run, values, failures, checkNotes);
    const layerMetrics = [...existingDrafts, ...existingMetrics, ...converted.drafts.map((draft) => draft.definition)];
    await checkCombinedDrafts(converted.drafts, layerMetrics, driver, input.run, values, failures, checkNotes);
    for (const draft of converted.drafts) {
      const notes = checkNotes.get(draft.definition.name);
      // A count of empty values comes from the importer's rows too, so with a host it stays in their record.
      if (!notes?.length || input.privateValues) continue;
      const extra = draft.definition.source!.extra!;
      extra.notes = Array.from(new Set([...((extra.notes as string[] | undefined) ?? []), ...notes]));
    }
  }

  // Write each draft that ran (or every draft when the check is skipped), parts first.
  const paths = new Map<string, string>();
  if (written) {
    for (const draft of converted.drafts) {
      if (failures.has(draft.definition.name)) continue;
      const definition = withCheck(draft.definition, input.check ? values.get(draft.definition.name) : undefined, input.check, ranAt, input.importId, draft, Boolean(input.privateValues));
      const path = join(DRAFTS_DIR, slug(input.domain), `${draft.definition.name}.yaml`);
      mkdirSync(join(input.projectRoot, dirname(path)), { recursive: true });
      writeFileSync(join(input.projectRoot, path), serializeMetricDefinitionToYaml(definition), 'utf-8');
      paths.set(draft.definition.name, path.replaceAll('\\', '/'));
    }
  }

  // Dimensions come only with a metric that was written: alone they would wait for a metric that never comes.
  const writtenTables = new Set(converted.drafts.filter((draft) => paths.has(draft.definition.name)).map((draft) => draft.definition.table).filter(Boolean));
  const dimensions: ImportMetricDrafts['dimensions'] = [];
  for (const dimension of converted.dimensions) {
    if (!written || !writtenTables.has(dimension.table)) continue;
    const path = join(DIMENSION_DRAFTS_DIR, slug(input.domain), `${dimension.name}.yaml`);
    mkdirSync(join(input.projectRoot, dirname(path)), { recursive: true });
    writeFileSync(join(input.projectRoot, path), serializeDimensionDefinitionToYaml(dimension), 'utf-8');
    dimensions.push({ name: dimension.name, label: dimension.label, table: dimension.table, path: path.replaceAll('\\', '/') });
  }

  const items = converted.conversions.map((conversion): ImportMetricDraftItem => {
    const calculation = conversion.calculation;
    const draft = conversion.metric ? draftsByName.get(conversion.metric) : undefined;
    const failure = conversion.outcome === 'drafted' && conversion.metric ? failures.get(conversion.metric) : undefined;
    const parts = draft?.combine ? partsOf(draft) : undefined;
    return {
      calculation: calculation.name,
      formula: calculation.formula,
      language: calculation.language,
      sourcePath: calculation.sourcePath,
      ...(calculation.owner ? { owner: calculation.owner } : {}),
      kind: calculation.kind,
      outcome: failure ? 'failed' : conversion.outcome,
      ...(conversion.metric ? { metric: conversion.metric } : {}),
      ...(conversion.metric && paths.get(conversion.metric) ? { path: paths.get(conversion.metric) } : {}),
      ...(conversion.inWords ? { inWords: conversion.inWords } : {}),
      ...(conversion.metric && values.has(conversion.metric) ? { value: values.get(conversion.metric) } : {}),
      ...(failure ? { reason: failure } : conversion.reason && conversion.outcome !== 'drafted' ? { reason: conversion.reason } : {}),
      notes: Array.from(new Set([...conversion.notes, ...((conversion.metric && checkNotes.get(conversion.metric)) || [])])),
      ...(parts ? { parts: parts.filter((part) => draftsByName.has(part)) } : {}),
    };
  });

  const result: ImportMetricDrafts = {
    ...base,
    written,
    ...(input.metricsLiveElsewhere ? { notWrittenReason: input.metricsLiveElsewhere } : tablesError ? { notWrittenReason: `ZLens could not read the database's tables: ${tablesError}` } : {}),
    checked: written && input.check,
    items,
    dimensions,
  };
  return result;
}

/** Postgres and Redshift fold unquoted names to lower case, Snowflake and Oracle to upper case. */
const FOLDS: Record<string, 'lower' | 'upper'> = { postgres: 'lower', postgresql: 'lower', redshift: 'lower', snowflake: 'upper', oracle: 'upper' };

/** A table or column name as this database's SQL must write it. */
export function sqlNamer(driver: string): (name: string) => string {
  const normalized = driver.trim().toLowerCase();
  const dialect = getDialect(normalized);
  const fold = FOLDS[normalized];
  return (name) => (needsQuotes(name, fold) ? dialect.quoteIdentifier(name) : name);
}

function needsQuotes(name: string, fold: 'lower' | 'upper' | undefined): boolean {
  if (!isPlainSqlName(name)) return true;
  if (fold === 'lower') return name !== name.toLowerCase();
  if (fold === 'upper') return name !== name.toUpperCase();
  return false;
}

/** Where the file reads something other than what ZLens is connected to: the same table name need not be the same numbers. */
function connectionNotes(source: BiTableSource, matched: WarehouseTableSummary, connection: MakeImportMetricDraftsInput['connection']): string[] {
  const compare = 'Compare the value with the old report.';
  const known = (value: string | undefined) => value?.trim().toLowerCase() ?? '';
  const database = known(source.database);
  const server = known(source.server);
  const connectedDatabase = known(connection?.database);
  const connectedServer = known(connection?.server);
  const notes: string[] = [];
  if (database && connectedDatabase && database !== connectedDatabase) {
    notes.push(`The file reads database ${source.database}${source.server ? ` on ${source.server}` : ''}; ZLens is connected to ${connection!.database}. ${compare}`);
    // A server may be written in part: `acme` and `acme.snowflakecomputing.com` are one account.
  } else if (server && connectedServer && !server.includes(connectedServer) && !connectedServer.includes(server)) {
    notes.push(`The file reads server ${source.server}; ZLens is connected to ${connection!.server}. ${compare}`);
  }
  if (source.schema && matched.schema && source.schema.toLowerCase() !== matched.schema.toLowerCase()) {
    notes.push(`The file reads ${source.schema}.${source.table}; ZLens found ${matched.schema}.${matched.name}, the only table of that name. ${compare}`);
  }
  return notes;
}

/**
 * The connected database's table for a BI file's: schema and table ignoring
 * case, else the table name alone when only one table has it.
 */
function matchTable(source: BiTableSource, tables: WarehouseTableSummary[]): WarehouseTableSummary | { error: string } {
  const written = [source.schema, source.table].filter(Boolean).join('.');
  const named = tables.filter((table) => table.name.toLowerCase() === source.table.toLowerCase());
  const exact = source.schema ? named.filter((table) => (table.schema ?? '').toLowerCase() === source.schema!.toLowerCase()) : [];
  if (exact.length === 1) return exact[0]!;
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    return { error: `${written} matches ${named.length} tables in the connected database (${named.slice(0, 3).map((table) => [table.schema, table.name].filter(Boolean).join('.')).join(', ')}), so ZLens did not pick one.` };
  }
  return { error: `${written} is not in the connected database. Connect the database the file reads, or read its tables first (Settings → Connection → Find available databases & schemas).` };
}

/** One query per table computes every draft on it; when it fails, each draft runs alone so one bad column does not stop the rest. */
async function checkDrafts(
  drafts: MetricDraft[],
  run: (sql: string) => Promise<Array<Record<string, unknown>>>,
  values: Map<string, number | null>,
  failures: Map<string, string>,
  notes: Map<string, string[]>,
): Promise<void> {
  const byTable = new Map<string, MetricDraft[]>();
  for (const draft of drafts) {
    if (!draft.check) continue;
    byTable.set(draft.check.table, [...(byTable.get(draft.check.table) ?? []), draft]);
  }
  const query = async (table: string, group: MetricDraft[]) => {
    const columns = group.flatMap((draft, index) => [
      `${draft.check!.expression} as zlens_m${index}`,
      ...(draft.check!.emptyValues ? [`${draft.check!.emptyValues} as zlens_e${index}`] : []),
    ]);
    const rows = await run(`select ${columns.join(', ')} from ${table}`);
    const row = rows[0] ?? {};
    group.forEach((draft, index) => {
      values.set(draft.definition.name, numberOrNull(pick(row, `zlens_m${index}`)));
      const empty = draft.check!.emptyValues ? numberOrNull(pick(row, `zlens_e${index}`)) : null;
      if (empty && empty > 0) {
        notes.set(draft.definition.name, [`The column has ${empty.toLocaleString('en-US')} empty value${empty === 1 ? '' : 's'}: Power BI's DISTINCTCOUNT counts them as one more, so this count is one lower than Power BI's.`]);
      }
    });
  };
  for (const [table, group] of byTable) {
    try {
      await query(table, group);
    } catch {
      for (const draft of group) {
        try {
          await query(table, [draft]);
        } catch (error) {
          failures.set(draft.definition.name, error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : String(error));
        }
      }
    }
  }
}

function pick(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Ratio and derived drafts run the SQL the semantic layer composes for them,
 * all in one query, then alone when that fails: what the check shows is what
 * the approved metric answers, and one the layer cannot run is not written.
 */
async function checkCombinedDrafts(
  drafts: MetricDraft[],
  layerMetrics: MetricDefinition[],
  driver: string,
  run: (sql: string) => Promise<Array<Record<string, unknown>>>,
  values: Map<string, number | null>,
  failures: Map<string, string>,
  notes: Map<string, string[]>,
): Promise<void> {
  const runnable: MetricDraft[] = [];
  for (const draft of drafts) {
    if (!draft.combine) continue;
    const name = draft.definition.name;
    const parts = partsOf(draft);
    const failed = parts.find((part) => failures.has(part));
    if (failed) {
      failures.set(name, `Its part ${failed} did not run: ${failures.get(failed)}`);
      continue;
    }
    runnable.push(draft);
    const inherited = parts.flatMap((part) => notes.get(part) ?? []);
    if (inherited.length) notes.set(name, Array.from(new Set(inherited)));
  }
  if (!runnable.length) return;
  const layer = new SemanticLayer({ metrics: layerMetrics, dimensions: [] });
  const query = async (group: MetricDraft[]) => {
    const composed = layer.composeQuery({ metrics: group.map((draft) => draft.definition.name), dimensions: [], driver });
    if (!composed) throw new Error('The semantic layer cannot compute it, so it would answer nothing.');
    const row = (await run(composed.sql))[0] ?? {};
    for (const draft of group) values.set(draft.definition.name, numberOrNull(pick(row, draft.definition.name)));
  };
  try {
    await query(runnable);
  } catch {
    for (const draft of runnable) {
      try {
        await query([draft]);
      } catch (error) {
        failures.set(draft.definition.name, error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : String(error));
      }
    }
  }
}

function partsOf(draft: MetricDraft): string[] {
  const combine = draft.combine;
  if (!combine) return [];
  return 'numerator' in combine ? [combine.numerator, combine.denominator] : combine.metrics;
}

function withCheck(definition: MetricDefinition, value: number | null | undefined, checked: boolean, ranAt: string, importId: string, draft: MetricDraft, privateValue: boolean): MetricDefinition {
  const extra = { ...(definition.source?.extra ?? {}) };
  extra.importId = importId;
  extra.inWords = draft.inWords;
  extra.check = !checked ? { ran: false } : privateValue ? { ran: true, ranAt } : { value: value ?? null, ranAt };
  if (!(extra.notes as string[] | undefined)?.length) delete extra.notes;
  return { ...definition, source: { ...definition.source!, extra } };
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
}

// ── Reviewing and approving ─────────────────────────────────────────────────

export interface MetricDraftSummary {
  name: string;
  label: string;
  path: string;
  domain?: string;
  /** The definition in words, as the import wrote it. */
  inWords?: string;
  formula?: string;
  value?: number | null;
  checkedAt?: string;
  importId?: string;
  notes: string[];
  /** A ratio or derived draft's parts that are drafts too. */
  parts: string[];
}

export function listMetricDrafts(projectRoot: string): MetricDraftSummary[] {
  const semanticDir = join(projectRoot, 'semantic-layer');
  if (!existsSync(semanticDir)) return [];
  const drafts = loadSemanticMetricDraftsFromDir(semanticDir);
  const names = new Set(drafts.map((draft) => draft.name));
  return drafts.map((draft) => {
    const extra = draft.source?.extra ?? {};
    const check = extra.check as { value?: number | null; ranAt?: string } | undefined;
    return {
      name: draft.name,
      label: draft.label,
      path: `semantic-layer/${String(extra.path ?? '')}`,
      ...(draft.domain ? { domain: draft.domain } : {}),
      ...(typeof extra.inWords === 'string' ? { inWords: extra.inWords } : {}),
      ...(typeof extra.formula === 'string' ? { formula: extra.formula } : {}),
      ...(check && 'value' in check ? { value: check.value ?? null } : {}),
      ...(check?.ranAt ? { checkedAt: check.ranAt } : {}),
      ...(typeof extra.importId === 'string' ? { importId: extra.importId } : {}),
      notes: Array.isArray(extra.notes) ? extra.notes.map(String) : [],
      parts: draftParts(draft).filter((part) => names.has(part)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function draftParts(draft: MetricDefinition): string[] {
  const params = (draft.typeParams ?? {}) as Record<string, unknown>;
  const named = (value: unknown) => (typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : undefined);
  const parts = [named(params.numerator), named(params.denominator), ...(Array.isArray(params.metrics) ? params.metrics.map(named) : [])];
  return parts.filter((part): part is string => Boolean(part));
}

export interface ApprovedMetric {
  name: string;
  from: string;
  to: string;
  /** A dimension of an approved metric's table, which came with it. */
  dimension?: boolean;
}

export class MetricDraftApprovalError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'NAME_TAKEN' | 'INVALID') {
    super(message);
  }
}

/** Metric names are plain, so a name can never lead a file out of its folder. */
const PLAIN_METRIC_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A draft's file path; one holding several definitions cannot be moved or deleted for one of them. */
function singleDraftFile(draft: MetricDefinition, drafts: MetricDefinition[]): string {
  const path = String(draft.source!.extra!.path);
  if (drafts.filter((other) => other.source?.extra?.path === path).length > 1) {
    throw new MetricDraftApprovalError(`semantic-layer/${path} holds several metrics. Put each in its own file, then try again.`, 'INVALID');
  }
  return path;
}

/**
 * Approve drafts by name: each moves from `metrics/_drafts/<domain>/` to
 * `metrics/<domain>/`, its text unchanged apart from `status: certified`,
 * who approved it and when, and then answers. A ratio or derived draft
 * brings the drafts it is built from. Everything is checked first, so either
 * all of them move or none does; a name a metric already has is refused.
 */
export function approveMetricDrafts(projectRoot: string, names: string[], actor: string, now: Date = new Date()): ApprovedMetric[] {
  const semanticDir = join(projectRoot, 'semantic-layer');
  const drafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
  const byName = new Map(drafts.map((draft) => [draft.name.toLowerCase(), draft]));
  const metrics = existsSync(semanticDir) ? new Set(loadSemanticLayerFromDir(semanticDir).listMetrics().map((metric) => metric.name.toLowerCase())) : new Set<string>();
  const wanted: MetricDefinition[] = [];
  const seen = new Set<MetricDefinition>();
  const add = (name: string) => {
    const draft = byName.get(name.toLowerCase());
    if (!draft) {
      if (metrics.has(name.toLowerCase())) return;
      throw new MetricDraftApprovalError(`There is no metric draft named ${name}. List them with zlens semantic drafts.`, 'NOT_FOUND');
    }
    if (seen.has(draft)) return;
    seen.add(draft);
    if (!PLAIN_METRIC_NAME.test(draft.name)) throw new MetricDraftApprovalError(`The draft's name "${draft.name}" is not a plain name (letters, digits and _).`, 'INVALID');
    for (const part of draftParts(draft)) {
      if (!byName.has(part.toLowerCase()) && !metrics.has(part.toLowerCase())) {
        throw new MetricDraftApprovalError(`${draft.name} is built from ${part}, which is neither a metric nor a draft, so it would answer nothing.`, 'NOT_FOUND');
      }
      add(part);
    }
    wanted.push(draft);
  };
  for (const name of names) add(name);
  const moves = wanted.map((draft) => {
    if (metrics.has(draft.name.toLowerCase())) {
      throw new MetricDraftApprovalError(`A metric named ${draft.name} already exists, so the draft was not approved. Rename the draft (its name: line and file) and approve it again.`, 'NAME_TAKEN');
    }
    const from = join(semanticDir, singleDraftFile(draft, drafts));
    const to = join(semanticDir, 'metrics', relative(join(semanticDir, 'metrics', '_drafts'), dirname(from)), `${draft.name}.yaml`);
    if (existsSync(to)) throw new MetricDraftApprovalError(`${relative(projectRoot, to)} already exists, so ${draft.name} was not approved.`, 'NAME_TAKEN');
    return { name: draft.name, from, to };
  });
  const dimensionMoves = dimensionsOfTables(semanticDir, new Set(wanted.map((draft) => draft.table).filter(Boolean)));
  const approvedAt = now.toISOString();
  for (const move of [...moves, ...dimensionMoves]) {
    mkdirSync(dirname(move.to), { recursive: true });
    writeFileSync(move.to, approvedText(readFileSync(move.from, 'utf-8'), actor, approvedAt), 'utf-8');
  }
  for (const move of [...moves, ...dimensionMoves]) rmSync(move.from);
  removeEmptyFolders(join(semanticDir, 'metrics', '_drafts'));
  removeEmptyFolders(join(semanticDir, 'dimensions', '_drafts'));
  const shown = (move: { name: string; from: string; to: string }) => ({ name: move.name, from: relative(projectRoot, move.from).replaceAll('\\', '/'), to: relative(projectRoot, move.to).replaceAll('\\', '/') });
  return [...moves.map(shown), ...dimensionMoves.map((move) => ({ ...shown(move), dimension: true }))];
}

/**
 * The dimension drafts on these tables, to move with their metrics. One whose
 * name is taken, or that is not a plain name in a file of its own, stays a draft:
 * it does not stop the metric.
 */
function dimensionsOfTables(semanticDir: string, tables: Set<string>): Array<{ name: string; from: string; to: string }> {
  const drafts = loadSemanticDimensionDraftsFromDir(semanticDir);
  const taken = new Set(loadSemanticLayerFromDir(semanticDir).listDimensions().map((dimension) => dimension.name.toLowerCase()));
  return drafts.flatMap((draft) => {
    if (!tables.has(draft.table) || taken.has(draft.name.toLowerCase()) || !PLAIN_METRIC_NAME.test(draft.name)) return [];
    if (drafts.filter((other) => other.source?.extra?.path === draft.source?.extra?.path).length > 1) return [];
    const from = join(semanticDir, String(draft.source!.extra!.path));
    const to = join(semanticDir, 'dimensions', relative(join(semanticDir, 'dimensions', '_drafts'), dirname(from)), `${draft.name}.yaml`);
    return existsSync(to) ? [] : [{ name: draft.name, from, to }];
  });
}

/** Discard drafts by name: their files are deleted. */
export function discardMetricDrafts(projectRoot: string, names: string[]): string[] {
  const semanticDir = join(projectRoot, 'semantic-layer');
  const drafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
  const wanted = Array.from(new Set(names.map((name) => name.toLowerCase()))).map((name) => {
    const draft = drafts.find((candidate) => candidate.name.toLowerCase() === name);
    if (!draft) throw new MetricDraftApprovalError(`There is no metric draft named ${name}.`, 'NOT_FOUND');
    return { name: draft.name, file: join(semanticDir, singleDraftFile(draft, drafts)) };
  });
  for (const draft of wanted) rmSync(draft.file);
  // Dimensions wait for a metric on their table: with none left, they go too.
  const waitingTables = new Set(loadSemanticMetricDraftsFromDir(semanticDir).map((draft) => draft.table));
  const discardedTables = new Set(drafts.filter((draft) => wanted.some((item) => item.name === draft.name)).map((draft) => draft.table));
  for (const dimension of loadSemanticDimensionDraftsFromDir(semanticDir)) {
    if (discardedTables.has(dimension.table) && !waitingTables.has(dimension.table)) rmSync(join(semanticDir, String(dimension.source!.extra!.path)), { force: true });
  }
  removeEmptyFolders(join(semanticDir, 'metrics', '_drafts'));
  removeEmptyFolders(join(semanticDir, 'dimensions', '_drafts'));
  return wanted.map((draft) => draft.name);
}

/** The YAML as written, with its `status:` set to certified and who approved it and when after it. */
export function approvedText(text: string, actor: string, approvedAt: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^(?:approvedBy|approvedAt):/.test(line));
  const approval = [`status: certified`, `approvedBy: ${JSON.stringify(actor)}`, `approvedAt: ${approvedAt}`];
  const status = lines.findIndex((line) => /^status:/.test(line));
  if (status >= 0) lines.splice(status, 1, ...approval);
  else {
    const name = lines.findIndex((line) => /^name:/.test(line));
    lines.splice(name >= 0 ? name + 1 : 0, 0, ...approval);
  }
  return lines.join('\n');
}

function removeEmptyFolders(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (lstatSync(full).isDirectory()) removeEmptyFolders(full);
  }
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
}

/**
 * "Approve all that ran": the drafts this import wrote whose check ran (or
 * all it wrote, when the check was skipped). A draft it only found waiting
 * belongs to the import that made it, and is not listed here for a person to
 * see, so it is not approved here either.
 */
export function importDraftsToApprove(projectRoot: string, record: ImportMetricDrafts): string[] {
  const waiting = new Set(listMetricDrafts(projectRoot).map((draft) => draft.name));
  return Array.from(new Set(record.items
    .filter((item) => item.outcome === 'drafted' && item.path && (item.value !== undefined || !record.checked))
    .map((item) => item.metric!)
    .filter((name) => waiting.has(name))));
}

// ── The import's record ─────────────────────────────────────────────────────

export function writeImportMetricDraftsRecord(projectRoot: string, record: ImportMetricDrafts): void {
  const file = join(projectRoot, '.dql', 'imports', record.importId, 'metric-drafts.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

export function readImportMetricDraftsRecord(projectRoot: string, importId: string): ImportMetricDrafts | null {
  if (!/^imp_[A-Za-z0-9_-]+$/.test(importId)) throw new Error(`Invalid import session id: ${importId}`);
  const file = join(projectRoot, '.dql', 'imports', importId, 'metric-drafts.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) as ImportMetricDrafts : null;
}
