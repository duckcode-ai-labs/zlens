import { createHash, randomBytes } from 'node:crypto';
import { SemanticLayer, type CubeDefinition, type DimensionDefinition, type MetricDefinition } from '@zlens/core';
import type { BiWorksheet } from '../bi-import/types.js';
import { compareExport, ComparisonStopped, type CompareOptions, type Comparison, type ComparisonPlan } from './compare.js';
import { ExportRefused, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS, readExport, type ExportTable } from './read-export.js';
import { isFilterAnswered, parseStatedFilter, resolveFilterField, resolveMetricTarget, resolveQueryTarget, type TargetCatalog, type TargetChoices } from './resolve-target.js';

/**
 * One comparison, start to finish: read the file, work out what it is
 * compared with, build the same table, compare. It reads the database and
 * writes nothing; recording the result is a separate step, because on a server
 * the two need different permissions.
 */

export interface CompareRequest extends TargetChoices {
  file?: { name: string; bytes: Buffer };
  /** One number, typed: `--metric total_sales --value 2297200.86`. */
  metric?: string;
  value?: string;
  /** Compare a saved query rather than metrics. */
  query?: string;
  parameters?: Record<string, unknown>;
  /** The report's name, as the person gives it. */
  report?: string;
  /** The Tableau worksheet this is an export of. */
  worksheet?: string;
  filters?: string[];
  /** `Order Date: covers every row`. */
  waive?: string[];
  /** Compare only the file's rows. */
  fileRows?: boolean;
  /** `0.5%`. */
  tolerance?: string;
  dates?: 'mdy' | 'dmy';
}

export interface SavedQueryRun {
  sqlParams?: unknown[];
  variables?: Record<string, unknown>;
}

export interface CompareDeps {
  /** `cubes` carry the joins between tables. */
  catalog: TargetCatalog & { cubes?: CubeDefinition[] };
  /** Semantic table names to the database's: `orders` to `main.orders`. */
  tableMapping?: Record<string, string>;
  driver: string;
  connection: { driver: string; database?: string };
  worksheet: (name: string) => BiWorksheet | undefined;
  /** Runs one read-only statement. `truncated` when a row limit cut it. */
  run: (sql: string, saved?: SavedQueryRun) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>;
  /** Reads the export away from the server's own thread. Without it, here. */
  readFile?: (bytes: Buffer, fileName: string) => Promise<ExportTable>;
  /** A saved query's SQL, and what its parameters bind. */
  savedQuery?: (name: string, parameters: Record<string, unknown>) => Promise<({ name: string; sql: string } & SavedQueryRun) | undefined>;
  now?: Date;
}

export interface CompareOutcome {
  id: string;
  report: string;
  tool?: 'tableau' | 'powerbi';
  worksheet?: string;
  file: { name: string; sha256: string; rows: number };
  comparedAt: string;
  connection: { driver: string; database?: string };
  target:
    | { kind: 'metrics'; metrics: string[]; dimensions: string[]; timeDimension?: { name: string; granularity: string }; filters: Array<{ dimension: string; operator: string; values: string[] }> }
    | { kind: 'query'; name: string; parameters: Record<string, unknown> };
  /** A hash of the compiled SQL and filters: per metric, or `query` for a saved query. */
  querySha256: Record<string, string>;
  mapping: Record<string, string>;
  filters: { stated: string[]; waived: string[]; seen: string[] };
  scope: 'all rows' | "the file's rows";
  tolerance?: string;
  comparison: Comparison;
}

export function queryFingerprint(sql: string, filters: unknown): string {
  return createHash('sha256').update(`${sql.replace(/\s+/g, ' ').trim()}\u0000${JSON.stringify(filters ?? [])}`).digest('hex');
}

/** A layer for one comparison: drafts are in it, as they are not in the answering layer. */
export function comparisonLayer(catalog: { metrics: MetricDefinition[]; dimensions: DimensionDefinition[]; cubes?: CubeDefinition[] }, throwaway: DimensionDefinition[] = []): SemanticLayer {
  const layer = new SemanticLayer();
  for (const cube of catalog.cubes ?? []) layer.addCube(cube);
  for (const metric of catalog.metrics) layer.addMetric(metric);
  for (const dimension of [...catalog.dimensions, ...throwaway]) layer.addDimension(dimension);
  return layer;
}

const TIMES_100 = /\*\s*100(?:\.0*)?\b|\b100(?:\.0*)?\s*\*/;

/** A definition that multiplies by 100 holds 14.9 for 14.9%. */
function holdsPoints(metric: MetricDefinition): boolean {
  const expr = (metric.typeParams as { expr?: unknown } | undefined)?.expr;
  return TIMES_100.test(`${metric.sql ?? ''} ${typeof expr === 'string' ? expr : ''}`);
}

const OPTION_TYPES: Record<string, 'text' | 'list' | 'map' | 'object' | 'flag'> = {
  worksheet: 'text', report: 'text', query: 'text', tolerance: 'text', dates: 'text', metric: 'text', value: 'text',
  filters: 'list', waive: 'list', keys: 'list', ignore: 'list',
  map: 'map', parameters: 'object', fileRows: 'flag',
};

export const COMPARE_OPTIONS = Object.keys(OPTION_TYPES);

/** What is wrong with a request's options, if anything. A filter dropped for its type would turn Not proven into Matches. */
export function compareOptionProblem(options: Record<string, unknown>): string | null {
  for (const [name, type] of Object.entries(OPTION_TYPES)) {
    const value = options[name];
    if (value === undefined || value === null) continue;
    const isObject = typeof value === 'object' && !Array.isArray(value);
    const fits = type === 'text' ? typeof value === 'string'
      : type === 'flag' ? typeof value === 'boolean'
        : type === 'list' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
          : type === 'object' ? isObject
            : isObject && Object.values(value as object).every((item) => typeof item === 'string');
    if (!fits) return `${name} must be ${{ text: 'text', flag: 'true or false', list: 'a list of text', object: 'a set of names and values', map: 'a set of names and text' }[type]}.`;
  }
  return null;
}

export async function runComparison(request: CompareRequest, deps: CompareDeps): Promise<CompareOutcome> {
  const table = await tableOf(request, deps);
  const stated = (request.filters ?? []).map(parseStatedFilter);
  const waived = request.waive ?? [];
  for (const text of waived) {
    if (!/^[^:]+:\s*\S/.test(text)) throw new ComparisonStopped(`A waiver needs a field and a reason: --waive "Order Date: covers every row". "${text}" has no reason.`);
  }

  // Filters ZLens can see, each needing an answer.
  const worksheet = request.worksheet ? deps.worksheet(request.worksheet) : undefined;
  if (request.worksheet && !worksheet) throw new ComparisonStopped(`No imported workbook has a worksheet named ${request.worksheet}. Import the workbook first, or leave --worksheet out.`);
  const seen = [...(worksheet?.filters ?? []).map((filter) => filter.words), ...(table.appliedFilters ? [`Applied filters: ${table.appliedFilters}`] : []), ...(table.unread ?? [])];
  const statedFields = stated.map((filter) => filter.field);
  const unanswered = (worksheet?.filters ?? []).filter((filter) => !isFilterAnswered(filter.field, statedFields, waived)).map((filter) => filter.field);
  // The line can name several filters, so stating one does not answer it: the person says it is answered.
  const unseen = [...(table.appliedFilters ? [table.appliedFilters] : []), ...(table.unread ?? [])];
  if (unseen.length && !isFilterAnswered('Applied filters', [], waived)) unanswered.push(...unseen);

  const options: CompareOptions = {
    fileRowsOnly: Boolean(request.fileRows),
    ...(request.tolerance ? { tolerance: parseTolerance(request.tolerance) } : {}),
    unansweredFilters: unanswered,
    filtersStated: stated.length > 0 || waived.length > 0,
    ...(request.dates ? { dateOrder: request.dates } : {}),
  };
  const base = {
    id: `cmp_${randomBytes(8).toString('hex')}`,
    report: request.report?.trim() || reportName(table.fileName),
    ...(table.tool ? { tool: table.tool } : {}),
    ...(request.worksheet ? { worksheet: request.worksheet } : {}),
    file: { name: table.fileName, sha256: table.sha256, rows: table.rows.length },
    comparedAt: (deps.now ?? new Date()).toISOString(),
    connection: deps.connection,
    filters: { stated: stated.map((filter) => filter.text), waived, seen },
    scope: request.fileRows ? ("the file's rows" as const) : ('all rows' as const),
    ...(request.tolerance ? { tolerance: request.tolerance } : {}),
  };

  if (request.query) {
    if (stated.length) throw new ComparisonStopped('--filter applies to metrics. A saved query takes its report parameters with --param.');
    const parameters = request.parameters ?? {};
    const saved = await deps.savedQuery?.(request.query, parameters);
    if (!saved) throw new ComparisonStopped(`There is no saved query named ${request.query}.`);
    const result = await deps.run(saved.sql, { ...(saved.sqlParams ? { sqlParams: saved.sqlParams } : {}), ...(saved.variables ? { variables: saved.variables } : {}) });
    const columns = Object.keys(result.rows[0] ?? {});
    if (!columns.length) throw new ComparisonStopped(`The saved query ${saved.name} returned no rows, so there is nothing to compare.`);
    const { plan, mapping } = resolveQueryTarget(table, columns, request);
    return {
      ...base,
      target: { kind: 'query', name: saved.name, parameters },
      querySha256: { query: queryFingerprint(saved.sql, parameters) },
      mapping,
      comparison: compareExport(table, plan, result.rows, {
        ...options,
        resultIncomplete: result.truncated,
        ...(TIMES_100.test(saved.sql) ? { pointColumns: new Set(plan.numbers.map((number) => number.name)) } : {}),
      }),
    };
  }

  const choices: TargetChoices = request.value !== undefined ? { map: { [table.headers[0]!]: request.metric! } } : request;
  const target = resolveMetricTarget(table, deps.catalog, choices);
  const filters = stated.map((filter) => ({ dimension: resolveFilterField(filter.field, deps.catalog, target), operator: filter.operator, values: filter.values }));
  const layer = comparisonLayer(deps.catalog, target.throwaway);
  const compose = (metrics: string[], tableMapping?: Record<string, string>) => layer.composeQuery({
    metrics,
    dimensions: target.dimensions,
    ...(target.timeDimension ? { timeDimension: target.timeDimension } : {}),
    filters,
    driver: deps.driver,
    ...(tableMapping ? { tableMapping } : {}),
  });
  const names = target.metrics.map((metric) => metric.name);
  const composed = names.length ? compose(names, deps.tableMapping) : null;
  if (names.length && !composed) {
    throw new ComparisonStopped(`ZLens can't build this table from ${names.join(', ')}. A column of another table needs a certified relationship; otherwise compare a saved query with --query.`);
  }
  const result = composed ? await deps.run(composed.sql) : { rows: [], truncated: false };
  // Without the table mapping: a record speaks for the definition, wherever the tables are.
  const querySha256 = Object.fromEntries(names.map((name) => [name, queryFingerprint(compose([name])?.sql ?? '', filters)]));
  return {
    ...base,
    target: {
      kind: 'metrics',
      metrics: names,
      dimensions: target.dimensions,
      ...(target.timeDimension ? { timeDimension: target.timeDimension } : {}),
      filters,
    },
    querySha256,
    mapping: target.mapping,
    comparison: compareExport(table, target.plan, result.rows, {
      ...options,
      resultIncomplete: result.truncated,
      metricNotes: notesOf(target.metrics),
      pointColumns: new Set(target.metrics.filter(holdsPoints).map((metric) => metric.name)),
    }),
  };
}

function notesOf(metrics: MetricDefinition[]): string[] {
  return Array.from(new Set(metrics.flatMap((metric) => {
    const notes = metric.source?.extra?.notes;
    return Array.isArray(notes) ? notes.map(String) : [];
  })));
}

async function tableOf(request: CompareRequest, deps: CompareDeps): Promise<ExportTable> {
  const metrics = deps.catalog.metrics;
  if (request.value !== undefined) {
    if (!request.metric) throw new ComparisonStopped('--value needs --metric: the metric it is the old number of.');
    const metric = metrics.find((candidate) => candidate.name === request.metric);
    if (!metric) throw new ComparisonStopped(`There is no metric or metric draft named ${request.metric}.`);
    return {
      fileName: `typed value for ${metric.label || metric.name}`,
      sha256: createHash('sha256').update(request.value).digest('hex'),
      headers: [metric.label || metric.name],
      rows: [[request.value]],
      totalsSetAside: 0,
      notes: [],
    };
  }
  if (!request.file) throw new ComparisonStopped('Name an export to compare, or give --metric and --value.');
  return deps.readFile ? deps.readFile(request.file.bytes, request.file.name) : readExport(request.file.bytes, request.file.name);
}

function reportName(fileName: string): string {
  return fileName.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, '');
}

const MAX_TOLERANCE = 0.1;

function parseTolerance(text: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(text);
  if (!match) throw new ComparisonStopped(`--tolerance takes a percent, such as 0.5%. "${text}" is not one.`);
  const tolerance = Number(match[1]) / 100;
  if (tolerance > MAX_TOLERANCE) throw new ComparisonStopped(`A tolerance of ${text} can't show two reports agree. The most is ${MAX_TOLERANCE * 100}%.`);
  return tolerance;
}

export { ComparisonStopped, ExportRefused, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS };
export type { ComparisonPlan };
