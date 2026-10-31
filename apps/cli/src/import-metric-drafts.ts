import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  getDialect,
  loadSemanticLayerFromDir,
  loadSemanticMetricDraftsFromDir,
  serializeMetricDefinitionToYaml,
  type MetricDefinition,
} from '@zlens/core';
import type { CalculationKind } from './bi-import/calculations.js';
import { convertCalculationsToMetricDrafts, type MetricDraft, type ResolvedTable } from './bi-import/metric-drafts.js';
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
  now?: Date;
}

const DRAFTS_DIR = join('semantic-layer', 'metrics', '_drafts');

export async function makeImportMetricDrafts(input: MakeImportMetricDraftsInput): Promise<ImportMetricDrafts> {
  const ranAt = (input.now ?? new Date()).toISOString();
  const semanticDir = join(input.projectRoot, 'semantic-layer');
  const existingMetrics = existsSync(semanticDir) ? loadSemanticLayerFromDir(semanticDir).listMetrics() : [];
  const existingDrafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
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
  const dialect = getDialect(input.driver);
  const fold = FOLDS[input.driver.trim().toLowerCase()];
  const name = (part: string) => (needsQuotes(part, fold) ? dialect.quoteIdentifier(part) : part);
  const resolveTable = tables
    ? (source: BiTableSource): ResolvedTable | { error: string } => {
      const matched = matchTable(source, tables!);
      if ('error' in matched) return matched;
      const notes: string[] = [];
      const database = input.connection?.database?.trim();
      if (source.database && database && source.database.toLowerCase() !== database.toLowerCase()) {
        notes.push(`The file reads database ${source.database}${source.server ? ` on ${source.server}` : ''}; ZLens is connected to ${database}. Compare the value with the old report.`);
      }
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
  });

  const draftsByName = new Map(converted.drafts.map((draft) => [draft.definition.name, draft]));
  const values = new Map<string, number | null>();
  const failures = new Map<string, string>();
  const written = Boolean(tables) && !input.metricsLiveElsewhere;
  if (written && input.check) {
    await checkDrafts(converted.drafts, input.run, values, failures);
    for (const draft of converted.drafts) {
      if (!draft.combine) continue;
      const parts = 'numerator' in draft.combine ? [draft.combine.numerator, draft.combine.denominator] : draft.combine.metrics;
      const failed = parts.find((part) => failures.has(part));
      if (failed) failures.set(draft.definition.name, `Its part ${failed} did not run: ${failures.get(failed)}`);
      else values.set(draft.definition.name, combinedValue(draft, values));
    }
  }

  // Write each draft that ran (or every draft when the check is skipped), parts first.
  const paths = new Map<string, string>();
  if (written) {
    for (const draft of converted.drafts) {
      if (failures.has(draft.definition.name)) continue;
      const definition = withCheck(draft.definition, input.check ? values.get(draft.definition.name) : undefined, input.check, ranAt, input.importId, draft);
      const path = join(DRAFTS_DIR, slug(input.domain), `${draft.definition.name}.yaml`);
      mkdirSync(join(input.projectRoot, dirname(path)), { recursive: true });
      writeFileSync(join(input.projectRoot, path), serializeMetricDefinitionToYaml(definition), 'utf-8');
      paths.set(draft.definition.name, path.replaceAll('\\', '/'));
    }
  }

  const items = converted.conversions.map((conversion): ImportMetricDraftItem => {
    const calculation = conversion.calculation;
    const draft = conversion.metric ? draftsByName.get(conversion.metric) : undefined;
    const failure = conversion.outcome === 'drafted' && conversion.metric ? failures.get(conversion.metric) : undefined;
    const parts = draft?.combine ? ('numerator' in draft.combine ? [draft.combine.numerator, draft.combine.denominator] : draft.combine.metrics) : undefined;
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
      notes: conversion.notes,
      ...(parts ? { parts: parts.filter((part) => draftsByName.has(part)) } : {}),
    };
  });

  const result: ImportMetricDrafts = {
    ...base,
    written,
    ...(input.metricsLiveElsewhere ? { notWrittenReason: input.metricsLiveElsewhere } : tablesError ? { notWrittenReason: `ZLens could not read the database's tables: ${tablesError}` } : {}),
    checked: written && input.check,
    items,
  };
  return result;
}

/** Postgres and Redshift fold unquoted names to lower case, Snowflake and Oracle to upper case. */
const FOLDS: Record<string, 'lower' | 'upper'> = { postgres: 'lower', postgresql: 'lower', redshift: 'lower', snowflake: 'upper', oracle: 'upper' };

function needsQuotes(name: string, fold: 'lower' | 'upper' | undefined): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  if (fold === 'lower') return name !== name.toLowerCase();
  if (fold === 'upper') return name !== name.toUpperCase();
  return false;
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
        const note = `The column has ${empty.toLocaleString('en-US')} empty value${empty === 1 ? '' : 's'}: Power BI's DISTINCTCOUNT counts them as one more, so this count is one lower than Power BI's.`;
        const notes = (draft.definition.source!.extra!.notes as string[] | undefined) ?? [];
        draft.definition.source!.extra!.notes = [...notes, note];
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

/** A ratio's or derived draft's value from its parts' values, as the layer computes it. */
function combinedValue(draft: MetricDraft, values: Map<string, number | null>): number | null {
  const combine = draft.combine!;
  if ('numerator' in combine) {
    const numerator = values.get(combine.numerator) ?? null;
    const denominator = values.get(combine.denominator) ?? null;
    return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
  }
  return evaluate(combine.expr, (name) => values.get(name) ?? null);
}

/** `+ - * /`, parentheses, numbers and NULLIF/COALESCE/ROUND/ABS over named values, with SQL's empty values. */
export function evaluate(expr: string, value: (name: string) => number | null): number | null {
  const tokens = expr.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/(),]/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const arith = (a: number | null, op: string, b: number | null): number | null => {
    if (a === null || b === null) return null;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    return b === 0 ? null : a / b;
  };
  const primary = (): number | null => {
    const token = take();
    if (token === undefined) throw new Error('The expression ends early.');
    if (token === '(') {
      const inner = sum();
      take();
      return inner;
    }
    if (token === '-') {
      const operand = primary();
      return operand === null ? null : -operand;
    }
    if (/^\d/.test(token)) return Number(token);
    if (peek() === '(') {
      take();
      const args: Array<number | null> = [sum()];
      while (peek() === ',') {
        take();
        args.push(sum());
      }
      take();
      const fn = token.toUpperCase();
      if (fn === 'NULLIF') return args[0] === args[1] ? null : args[0] ?? null;
      if (fn === 'COALESCE') return args.find((arg) => arg !== null) ?? null;
      if (fn === 'ABS') return args[0] === null || args[0] === undefined ? null : Math.abs(args[0]);
      if (fn === 'ROUND') {
        if (args[0] === null || args[0] === undefined) return null;
        const places = args[1] ?? 0;
        return Math.round(args[0] * 10 ** places) / 10 ** places;
      }
      throw new Error(`Unknown function ${token}.`);
    }
    return value(token);
  };
  const product = (): number | null => {
    let left = primary();
    while (peek() === '*' || peek() === '/') left = arith(left, take()!, primary());
    return left;
  };
  const sum = (): number | null => {
    let left = product();
    while (peek() === '+' || peek() === '-') left = arith(left, take()!, product());
    return left;
  };
  return sum();
}

function withCheck(definition: MetricDefinition, value: number | null | undefined, checked: boolean, ranAt: string, importId: string, draft: MetricDraft): MetricDefinition {
  const extra = { ...(definition.source?.extra ?? {}) };
  extra.importId = importId;
  extra.inWords = draft.inWords;
  extra.check = checked ? { value: value ?? null, ranAt } : { ran: false };
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
}

export class MetricDraftApprovalError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'NAME_TAKEN') {
    super(message);
  }
}

/**
 * Approve drafts by name: each moves from `metrics/_drafts/<domain>/` to
 * `metrics/<domain>/`, its text unchanged apart from `status: certified`,
 * who approved it and when, and then answers. A ratio or derived draft
 * brings the drafts it is built from. A name a metric already has is refused.
 */
export function approveMetricDrafts(projectRoot: string, names: string[], actor: string, now: Date = new Date()): ApprovedMetric[] {
  const semanticDir = join(projectRoot, 'semantic-layer');
  const drafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
  const byName = new Map(drafts.map((draft) => [draft.name.toLowerCase(), draft]));
  const metrics = existsSync(semanticDir) ? new Set(loadSemanticLayerFromDir(semanticDir).listMetrics().map((metric) => metric.name.toLowerCase())) : new Set<string>();
  const wanted: MetricDefinition[] = [];
  const add = (name: string) => {
    const draft = byName.get(name.toLowerCase());
    if (!draft) {
      if (metrics.has(name.toLowerCase())) return;
      throw new MetricDraftApprovalError(`There is no metric draft named ${name}. List them with zlens semantic drafts.`, 'NOT_FOUND');
    }
    if (wanted.includes(draft)) return;
    for (const part of draftParts(draft)) if (byName.has(part.toLowerCase())) add(part);
    wanted.push(draft);
  };
  for (const name of names) add(name);
  for (const draft of wanted) {
    if (metrics.has(draft.name.toLowerCase())) {
      throw new MetricDraftApprovalError(`A metric named ${draft.name} already exists, so the draft was not approved. Rename the draft (its name: line and file) and approve it again.`, 'NAME_TAKEN');
    }
  }
  const approvedAt = now.toISOString();
  const moved: ApprovedMetric[] = [];
  for (const draft of wanted) {
    const from = join(semanticDir, String(draft.source!.extra!.path));
    const domainFolder = relative(join(semanticDir, 'metrics', '_drafts'), dirname(from));
    const to = join(semanticDir, 'metrics', domainFolder.startsWith('..') ? '' : domainFolder, `${draft.name}.yaml`);
    if (existsSync(to)) throw new MetricDraftApprovalError(`${relative(projectRoot, to)} already exists, so ${draft.name} was not approved.`, 'NAME_TAKEN');
    const text = readFileSync(from, 'utf-8');
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, approvedText(text, actor, approvedAt), 'utf-8');
    rmSync(from);
    moved.push({ name: draft.name, from: relative(projectRoot, from).replaceAll('\\', '/'), to: relative(projectRoot, to).replaceAll('\\', '/') });
  }
  removeEmptyFolders(join(semanticDir, 'metrics', '_drafts'));
  return moved;
}

/** Discard drafts by name: their files are deleted. */
export function discardMetricDrafts(projectRoot: string, names: string[]): string[] {
  const semanticDir = join(projectRoot, 'semantic-layer');
  const drafts = existsSync(semanticDir) ? loadSemanticMetricDraftsFromDir(semanticDir) : [];
  const removed: string[] = [];
  for (const name of names) {
    const draft = drafts.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!draft) throw new MetricDraftApprovalError(`There is no metric draft named ${name}.`, 'NOT_FOUND');
    rmSync(join(semanticDir, String(draft.source!.extra!.path)));
    removed.push(draft.name);
  }
  removeEmptyFolders(join(semanticDir, 'metrics', '_drafts'));
  return removed;
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
    if (statSync(full).isDirectory()) removeEmptyFolders(full);
  }
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
}

/**
 * "Approve all that ran": the drafts an import wrote whose check ran (or all
 * it wrote, when the check was skipped), and the drafts it found already
 * waiting for its calculations (a second import of the same file).
 */
export function importDraftsToApprove(projectRoot: string, record: ImportMetricDrafts): string[] {
  const waiting = new Set(listMetricDrafts(projectRoot).map((draft) => draft.name));
  return Array.from(new Set(record.items
    .filter((item) => (item.outcome === 'drafted' && item.path && (item.value !== undefined || !record.checked)) || item.outcome === 'reused')
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
