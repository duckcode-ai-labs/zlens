import type { DimensionDefinition, MetricDefinition } from '@zlens/core';
import { ComparisonStopped, type ComparisonPlan, type KeyColumn, type NumberColumn } from './compare.js';
import { decimalStyleOf, isEmptyCell, parseDateCell, parseNumberCell, type DateGrain, type ExportTable } from './read-export.js';

/**
 * Working out what an export's columns are: which are keys, which are numbers,
 * and what each is compared with. A column's role comes from what it matches
 * first and how it looks second, because a year is a key that looks like a
 * number. The mapping is always shown and recorded, and anything uncertain
 * stops and asks rather than comparing the wrong thing.
 */

export interface TargetCatalog {
  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  /** The columns of a table, each as SQL writes it. */
  columnsOf?: (table: string) => Array<{ name: string; sql: string }> | undefined;
}

export interface TargetChoices {
  /** A column to a metric or dimension: `Sales=total_sales`. */
  map?: Record<string, string>;
  /** Columns that are keys, whatever they look like. */
  keys?: string[];
  /** Columns the person chose to leave out. */
  ignore?: string[];
}

export interface ResolvedTarget {
  plan: ComparisonPlan;
  metrics: MetricDefinition[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  /** Dimensions made for this comparison only, for a key column with none. */
  throwaway: DimensionDefinition[];
  /** Each column and what it was compared with, in words. */
  mapping: Record<string, string>;
}

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

type Shape = 'empty' | 'date' | 'plain-number' | 'marked-number' | 'text';

/** How a column looks. A whole number with no marks may be a year or an id; `02134` is text. */
export function columnShape(cells: string[]): Shape {
  const present = cells.filter((cell) => !isEmptyCell(cell));
  if (!present.length) return 'empty';
  if (present.every((cell) => parseDateCell(cell) || parseDateCell(cell, 'dmy'))) return 'date';
  const { style } = decimalStyleOf(present);
  if (present.some((cell) => /^0\d/.test(cell.trim()) && /^\d+$/.test(cell.trim()))) return 'text';
  if (!present.every((cell) => parseNumberCell(cell, style))) return 'text';
  return present.every((cell) => /^-?\d+$/.test(cell.trim())) ? 'plain-number' : 'marked-number';
}

const GRAIN_WORDS: Record<string, DateGrain> = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

/** `Month of Order Date` and `MONTH(Order Date)`: the field and the grain. */
function grainOfHeader(header: string): { grain: DateGrain; field: string } | null {
  const match = /^(day|week|month|quarter|year)\s+of\s+(.+)$/i.exec(header) ?? /^(day|week|month|quarter|year)\((.+)\)$/i.exec(header);
  return match ? { grain: GRAIN_WORDS[match[1]!.toLowerCase()]!, field: match[2]!.trim() } : null;
}

const AGGREGATES: Array<[RegExp, MetricDefinition['type']]> = [
  [/^sum\((.+)\)$/i, 'sum'], [/^sum of (.+)$/i, 'sum'],
  [/^avg\((.+)\)$/i, 'avg'], [/^average of (.+)$/i, 'avg'],
  [/^min\((.+)\)$/i, 'min'], [/^(?:min|minimum) of (.+)$/i, 'min'],
  [/^max\((.+)\)$/i, 'max'], [/^(?:max|maximum) of (.+)$/i, 'max'],
  [/^(?:cntd|countd)\((.+)\)$/i, 'count_distinct'], [/^(?:distinct count|count distinct|count \(distinct\)) of (.+)$/i, 'count_distinct'],
  [/^(?:cnt|count)\((.+)\)$/i, 'count'], [/^count of (.+)$/i, 'count'],
];

function namesOf(metric: { name: string; label?: string; synonyms?: string[] }): string[] {
  return [metric.name, metric.label ?? '', ...(metric.synonyms ?? [])].map(normalize).filter(Boolean);
}

/** The metrics a column's name can mean. */
function metricsFor(header: string, metrics: MetricDefinition[]): MetricDefinition[] {
  const wanted = normalize(header);
  const named = metrics.filter((metric) => namesOf(metric).includes(wanted));
  if (named.length) return named;
  // Tableau writes a calculation that aggregates as `AGG(Profit Ratio)`.
  const aggregated = /^agg\((.+)\)$/i.exec(header);
  if (aggregated) return metricsFor(aggregated[1]!, metrics);
  for (const [pattern, type] of AGGREGATES) {
    const field = pattern.exec(header)?.[1];
    if (!field) continue;
    const column = normalize(field);
    return metrics.filter((metric) => metric.type === type && !metric.filter && !metric.metricType && normalize(metric.sql.replace(/^1\.0 \* /, '')) === column);
  }
  return [];
}

function dimensionsFor(header: string, dimensions: DimensionDefinition[]): DimensionDefinition[] {
  const wanted = normalize(header);
  return dimensions.filter((dimension) => namesOf(dimension).includes(wanted));
}

/** The tables a metric reads: a ratio's are its parts'. */
function tablesOf(metric: MetricDefinition, all: MetricDefinition[]): string[] {
  if (metric.table) return [metric.table];
  const params = (metric.typeParams ?? {}) as Record<string, unknown>;
  const named = (value: unknown) => (typeof value === 'string' ? value : (value as { name?: string } | undefined)?.name);
  const parts = [named(params.numerator), named(params.denominator), ...(Array.isArray(params.metrics) ? params.metrics.map(named) : [])];
  return parts.flatMap((part) => {
    const found = all.find((candidate) => candidate.name === part);
    return found ? tablesOf(found, all.filter((candidate) => candidate !== metric)) : [];
  });
}

export function resolveMetricTarget(table: ExportTable, catalog: TargetCatalog, choices: TargetChoices = {}): ResolvedTarget {
  const ignored = new Set((choices.ignore ?? []).map(normalize));
  const forcedKeys = new Set((choices.keys ?? []).map(normalize));
  const mapped = new Map(Object.entries(choices.map ?? {}).map(([header, target]) => [normalize(header), target]));
  for (const header of [...(choices.ignore ?? []), ...(choices.keys ?? []), ...Object.keys(choices.map ?? {})]) {
    if (!table.headers.some((candidate) => normalize(candidate) === normalize(header))) throw new ComparisonStopped(`The file has no column ${header}. It has ${table.headers.join(', ')}.`);
  }
  const cellsOf = (index: number) => table.rows.map((row) => row[index] ?? '');
  const numbers: Array<NumberColumn & { metric: MetricDefinition }> = [];
  const keyHeaders: Array<{ header: string; shape: Shape; index: number; dimension?: DimensionDefinition }> = [];
  const notCompared: string[] = [];
  const mapping: Record<string, string> = {};

  table.headers.forEach((header, index) => {
    if (ignored.has(normalize(header))) {
      mapping[header] = 'left out, as asked';
      return;
    }
    const shape = columnShape(cellsOf(index));
    const target = mapped.get(normalize(header));
    const isKey = forcedKeys.has(normalize(header));
    const nameToMatch = target ?? header;
    let metricMatches = isKey ? [] : metricsFor(nameToMatch, catalog.metrics);
    let dimensionMatches = dimensionsFor(grainOfHeader(nameToMatch)?.field ?? nameToMatch, catalog.dimensions);
    if (target && !metricMatches.length && !dimensionMatches.length) throw new ComparisonStopped(`There is no metric or dimension named ${target}.`);
    // How the column looks settles a name that means both.
    if (metricMatches.length && dimensionMatches.length) {
      if (shape === 'text' || shape === 'date') metricMatches = [];
      else if (shape === 'marked-number') dimensionMatches = [];
    }
    if (metricMatches.length && dimensionMatches.length) {
      throw new ComparisonStopped(`${header} could be the metric ${metricMatches[0]!.name} or the dimension ${dimensionMatches[0]!.name}. Say which: --map "${header}=${metricMatches[0]!.name}", or --key "${header}".`);
    }
    if (metricMatches.length > 1) {
      throw new ComparisonStopped(`${header} could be any of these metrics: ${metricMatches.map((metric) => metric.name).join(', ')}. Say which: --map "${header}=${metricMatches[0]!.name}".`);
    }
    if (metricMatches.length === 1) {
      if (shape === 'text' || shape === 'date') throw new ComparisonStopped(`${header} matches the metric ${metricMatches[0]!.name}, but its values are not numbers.`);
      const metric = metricMatches[0]!;
      numbers.push({ header, output: metric.name, name: metric.name, metric });
      return;
    }
    if (dimensionMatches.length > 1) {
      // Several tables can have a `region`; the metric's own table decides, below.
      keyHeaders.push({ header, shape, index });
      return;
    }
    if (dimensionMatches.length === 1) {
      keyHeaders.push({ header, shape, index, dimension: dimensionMatches[0]! });
      return;
    }
    if (shape === 'marked-number' && !isKey) {
      notCompared.push(header);
      mapping[header] = 'not compared: no metric matches it';
      return;
    }
    if (shape === 'empty' && !isKey) {
      notCompared.push(header);
      mapping[header] = 'not compared: the column is empty';
      return;
    }
    keyHeaders.push({ header, shape, index });
  });

  if (!numbers.length && !table.headers.some((header) => mapping[header]?.startsWith('not compared'))) {
    throw new ComparisonStopped(`No column of the file matches a metric. It has ${table.headers.join(', ')}. Map one with --map "Column=metric_name", or name a saved query with --query.`);
  }

  // Keys.
  const metricTables = Array.from(new Set(numbers.flatMap((number) => tablesOf(number.metric, catalog.metrics))));
  const homeTable = metricTables.length === 1 ? metricTables[0]! : undefined;
  const dimensions: string[] = [];
  const throwaway: DimensionDefinition[] = [];
  const keys: KeyColumn[] = [];
  let timeDimension: ResolvedTarget['timeDimension'];

  for (const key of keyHeaders) {
    const grained = grainOfHeader(mapped.get(normalize(key.header)) ?? key.header);
    const field = grained?.field ?? mapped.get(normalize(key.header)) ?? key.header;
    let dimension = key.dimension;
    if (!dimension) {
      const candidates = dimensionsFor(field, catalog.dimensions);
      const onHome = candidates.filter((candidate) => candidate.table === homeTable);
      if (onHome.length === 1) dimension = onHome[0];
      else if (candidates.length === 1) dimension = candidates[0];
      else if (candidates.length > 1) throw new ComparisonStopped(`${key.header} could be any of these dimensions: ${candidates.map((candidate) => candidate.name).join(', ')}. Say which with --map.`);
    }
    const isDate = key.shape === 'date' || Boolean(grained) || Boolean(dimension?.isTimeDimension);
    if (!dimension && homeTable) {
      // A column of the metric's table with no dimension (a year): usable for this comparison only.
      const column = catalog.columnsOf?.(homeTable)?.find((candidate) => normalize(candidate.name) === normalize(field));
      if (column) {
        dimension = {
          name: `key_${normalize(field)}`,
          label: key.header,
          description: '',
          sql: column.sql,
          type: isDate ? 'date' : 'string',
          table: homeTable,
          ...(isDate ? { isTimeDimension: true } : {}),
        };
        throwaway.push(dimension);
      }
    }
    if (!dimension) {
      throw new ComparisonStopped(`${key.header} changes the rows, and nothing matches it${homeTable ? ` on ${homeTable}` : ''}. Map it with --map "${key.header}=dimension_name", or compare a saved query with --query.`);
    }
    if (isDate) {
      if (timeDimension) {
        throw new ComparisonStopped(`The file has two date columns (${keys.find((candidate) => candidate.kind === 'date')?.header} and ${key.header}). ZLens groups by one date at one grain: export a single date column, or compare a saved query.`);
      }
      const values = table.rows.map((row) => row[key.index] ?? '').filter((cell) => !isEmptyCell(cell));
      const grain = grained?.grain ?? grainOfValues(values, key.header);
      if (grained && grained.grain !== 'year' && !values.every((cell) => parseDateCell(cell) || parseDateCell(cell, 'dmy'))) {
        throw new ComparisonStopped(`${key.header} holds "${values[0]}", which does not say which year it is. Export the full date, such as January 2026.`);
      }
      if (grain === 'year' && !values.every((cell) => /^\d{4}$/.test(cell.trim()) || parseDateCell(cell))) {
        throw new ComparisonStopped(`${key.header} holds "${values[0]}", which ZLens cannot read as a year.`);
      }
      timeDimension = { name: dimension.name, granularity: grain };
      keys.push({ header: key.header, output: `${dimension.name}_${grain}`, kind: 'date', grain });
      mapping[key.header] = `${grain} of the dimension ${dimension.name}`;
    } else {
      dimensions.push(dimension.name);
      keys.push({ header: key.header, output: dimension.name, kind: 'text' });
      mapping[key.header] = throwaway.includes(dimension) ? `the column ${dimension.sql}, for this comparison` : `the dimension ${dimension.name}`;
    }
  }
  for (const number of numbers) mapping[number.header] = `the metric ${number.name}`;

  return {
    plan: { keys, numbers: numbers.map(({ header, output, name }) => ({ header, output, name })), notCompared },
    metrics: numbers.map((number) => number.metric),
    dimensions,
    ...(timeDimension ? { timeDimension } : {}),
    throwaway,
    mapping,
  };
}

function grainOfValues(values: string[], header: string): DateGrain {
  const grains = new Set(values.map((cell) => (parseDateCell(cell) ?? parseDateCell(cell, 'dmy'))?.grain).filter(Boolean));
  if (grains.size > 1) throw new ComparisonStopped(`${header} mixes dates and periods, so it has no single grain.`);
  return (grains.values().next().value as DateGrain | undefined) ?? 'day';
}

/** A saved query's columns are the target: names decide, and how a column looks says key or number. */
export function resolveQueryTarget(table: ExportTable, resultColumns: string[], choices: TargetChoices = {}): { plan: ComparisonPlan; mapping: Record<string, string> } {
  const ignored = new Set((choices.ignore ?? []).map(normalize));
  const forcedKeys = new Set((choices.keys ?? []).map(normalize));
  const mapped = new Map(Object.entries(choices.map ?? {}).map(([header, target]) => [normalize(header), target]));
  const keys: KeyColumn[] = [];
  const numbers: NumberColumn[] = [];
  const notCompared: string[] = [];
  const mapping: Record<string, string> = {};
  table.headers.forEach((header, index) => {
    if (ignored.has(normalize(header))) {
      mapping[header] = 'left out, as asked';
      return;
    }
    const wanted = normalize(mapped.get(normalize(header)) ?? grainOfHeader(header)?.field ?? header);
    const output = resultColumns.find((column) => normalize(column) === wanted);
    const shape = columnShape(table.rows.map((row) => row[index] ?? ''));
    const looksNumeric = shape === 'marked-number' || shape === 'plain-number' || shape === 'empty';
    if (!output) {
      if (looksNumeric && !forcedKeys.has(normalize(header))) {
        notCompared.push(header);
        mapping[header] = 'not compared: the saved query has no such column';
        return;
      }
      throw new ComparisonStopped(`${header} changes the rows, and the saved query has no such column. It has ${resultColumns.join(', ')}. Map it with --map "${header}=column".`);
    }
    mapping[header] = `the column ${output}`;
    if (forcedKeys.has(normalize(header)) || !looksNumeric) {
      if (shape === 'date') keys.push({ header, output, kind: 'date', grain: grainOfHeader(header)?.grain ?? 'day' });
      else keys.push({ header, output, kind: 'text' });
    } else {
      numbers.push({ header, output, name: output });
    }
  });
  return { plan: { keys, numbers, notCompared }, mapping };
}

// ── Filters a person states ─────────────────────────────────────────────────

export interface StatedFilter {
  text: string;
  field: string;
  operator: string;
  values: string[];
}

const FILTER_OPERATORS: Record<string, string> = { '=': 'equals', '!=': 'not_equals', '<>': 'not_equals', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', in: 'in', between: 'between' };

/**
 * `order_date >= 2024-01-01`, `region in (East, West)`, `order_date between
 * 2024-01-01 and 2024-12-31`. The form is strict: anything else is refused, so
 * nothing is applied differently from how a person meant it.
 */
export function parseStatedFilter(text: string): StatedFilter {
  const refused = () => new ComparisonStopped(`ZLens can't read the filter "${text}". Write a field, one of = != > >= < <= in between, and values: order_date >= 2024-01-01. Filters it can't express can be waived with --waive.`);
  const match = /^\s*(.+?)\s*(>=|<=|!=|<>|=|>|<|\s+in\s+|\s+between\s+)\s*(.+?)\s*$/i.exec(text);
  if (!match) throw refused();
  const field = match[1]!.trim();
  const operator = FILTER_OPERATORS[match[2]!.trim().toLowerCase()];
  if (!operator || /[()=<>!]/.test(field)) throw refused();
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const quotedWhole = /^(['"]).*\1$/.test(match[3]!.trim());
  if (operator === 'in') {
    const list = /^\((.*)\)$/.exec(match[3]!.trim())?.[1] ?? match[3]!;
    const values = list.split(',').map(unquote).filter(Boolean);
    if (!values.length) throw refused();
    return { text, field, operator, values };
  }
  if (operator === 'between') {
    const parts = match[3]!.split(/\s+and\s+/i);
    if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) throw refused();
    return { text, field, operator, values: parts.map(unquote) };
  }
  // An unquoted `or` is a condition this form can't hold.
  if (!quotedWhole && /\s(?:or|and)\s/i.test(match[3]!)) throw refused();
  return { text, field, operator, values: [unquote(match[3]!)] };
}

/** The filter's field as a dimension the query can use, or a column of the metric's table for this comparison. */
export function resolveFilterField(field: string, catalog: TargetCatalog, target: Pick<ResolvedTarget, 'metrics' | 'throwaway'>): string {
  const tables = Array.from(new Set(target.metrics.flatMap((metric) => tablesOf(metric, catalog.metrics))));
  const candidates = dimensionsFor(field, [...catalog.dimensions, ...target.throwaway]);
  const onHome = candidates.filter((candidate) => tables.includes(candidate.table));
  if (onHome.length === 1) return onHome[0]!.name;
  if (candidates.length === 1) return candidates[0]!.name;
  if (candidates.length > 1) throw new ComparisonStopped(`The filter's field ${field} could be any of these dimensions: ${candidates.map((candidate) => candidate.name).join(', ')}.`);
  if (tables.length === 1) {
    const column = catalog.columnsOf?.(tables[0]!)?.find((candidate) => normalize(candidate.name) === normalize(field));
    if (column) {
      const dimension: DimensionDefinition = { name: `filter_${normalize(field)}`, label: field, description: '', sql: column.sql, type: 'string', table: tables[0]! };
      target.throwaway.push(dimension);
      return dimension.name;
    }
  }
  throw new ComparisonStopped(`The filter's field ${field} is not a dimension, or a column of ${tables.join(', ') || 'the metric\'s table'}. Waive it with --waive "${field}: reason", or use --file-rows.`);
}

/** Whether a filter ZLens can see was answered: stated on that field, or waived. */
export function isFilterAnswered(known: string, stated: string[], waived: string[]): boolean {
  const wanted = normalize(known);
  return stated.some((field) => normalize(field) === wanted) || waived.some((text) => normalize(text.split(':')[0] ?? '') === wanted);
}
