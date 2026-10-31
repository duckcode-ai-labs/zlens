import type { DimensionDefinition, MetricDefinition } from '@zlens/core';
import { classifyCalculations, formulaWithoutComments, type BiCalculation, type ClassifiedCalculation } from './calculations.js';
import { FormulaError, parseFormula, type FormulaNode } from './formula.js';
import type { BiCalculationModel, BiDataType, BiLiteral, BiModelField, BiModelTable, BiSourceFilter, BiTableSource } from './types.js';

/**
 * Tableau calculated fields and DAX measures as ZLens metric drafts (D3).
 *
 * A simple calculation (one aggregate), a filtered one (one aggregate with a
 * condition on the same table) or a ratio (aggregates combined with
 * arithmetic) becomes a draft in `semantic-layer/metrics/_drafts/`, placed on
 * the database table and column the BI tool read. Anything outside the rules
 * is left out, naming what stopped it. Drafts answer nothing until a person
 * approves them.
 */

export interface MetricDraftOptions {
  /** The domain the drafts are written under (`imported` unless the person picks one). */
  domain: string;
  owner?: string;
  importedAt: string;
  /**
   * The database table a BI table reads, as the connected database names it,
   * with its columns; or why it is not there. Without it, the table and
   * columns are written as the file names them (for `zlens migrate assess`).
   */
  resolveTable?: (source: BiTableSource, table: BiModelTable, model: BiCalculationModel) => ResolvedTable | { error: string };
  /** The project's metrics: one with the same definition is reused, and no draft takes a metric's name. */
  existingMetrics?: MetricDefinition[];
  /** Metric drafts already on disk: one with the same definition is reused (a second import of the same file), and their names are taken. */
  existingDrafts?: MetricDefinition[];
  /** Other names already taken. */
  takenNames?: Iterable<string>;
  /** The project's dimensions and dimension drafts: one on the same column is not drafted again. */
  existingDimensions?: DimensionDefinition[];
  /** A text value as this database's SQL writes it. Without it, the standard form (`'it''s'`). */
  stringLiteral?: (value: string) => string;
}

export interface ResolvedTable {
  /** The table as a metric's `table:` names it (`analytics.orders`). */
  sql: string;
  /** Column (lower case) → the column as SQL (`"Order ID"`). Without it, columns are taken as the file names them. */
  columns?: Map<string, string>;
  /** Said on every draft on this table: the file reads another server or database than ZLens's connection. */
  notes?: string[];
}

export interface MetricDraft {
  definition: MetricDefinition;
  /** The definition in words: `sum of sales where region = 'East', on analytics.orders`. */
  inWords: string;
  /** For a simple or filtered draft: its aggregate as SQL, to run over all rows on its table. */
  check?: { table: string; expression: string; emptyValues?: string };
  /** For a ratio or derived draft: how its value comes from its parts' values. */
  combine?: { numerator: string; denominator: string } | { expr: string; metrics: string[] };
  /** The calculation it was drafted for, or the one it is a part of. */
  calculation: string;
  part: boolean;
}

export type ConversionOutcome = 'drafted' | 'reused' | 'left-out' | 'row-level' | 'advanced';

export interface CalculationConversion {
  calculation: ClassifiedCalculation;
  outcome: ConversionOutcome;
  /** drafted: the draft's name; reused: the existing metric's name. */
  metric?: string;
  reason?: string;
  notes: string[];
  inWords?: string;
}

export interface MetricDraftsResult {
  conversions: CalculationConversion[];
  /** Every draft to write: the calculations' own, and the parts a ratio needs. */
  drafts: MetricDraft[];
  /**
   * The text, date and true/false columns of the tables those drafts read, as
   * dimension drafts: a metric groups only by dimensions, and a project that
   * starts from a workbook has none. They come with the metrics when approved.
   */
  dimensions: DimensionDefinition[];
}

// ── Values while translating ────────────────────────────────────────────────

type AggregateFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';

interface TableInfo {
  /** Identity within this run: the BI table and the model it is in. */
  key: string;
  sql: string;
  bi: BiModelTable;
  model: BiCalculationModel;
  columns?: Map<string, string>;
  notes: string[];
}

/** A value per row: a column, a constant, or arithmetic and conditions over one table's columns. */
interface Row {
  k: 'row';
  sql: string;
  table?: TableInfo;
  type: BiDataType;
  /** The columns it reads (lower case), to find a filter on a column already filtered. */
  columns: Set<string>;
  literal?: BiLiteral;
  /** DAX: the column it is, for the blank and case rules of a comparison. */
  column?: { sql: string; type: BiDataType };
  /**
   * DAX `+` or `-` of columns, each read as 0 when blank. Right inside SUM. A
   * row where both are blank is blank in DAX, which AVERAGE, MIN, MAX and
   * COUNT skip, but 0 here.
   */
  blankAsZero?: boolean;
}

/** One aggregate on one table: a simple or filtered metric. */
interface Part {
  fn: AggregateFn;
  sql: string;
  table: TableInfo;
  filter?: string;
  filterColumns: Set<string>;
  label: string;
  /** The calculation that is this aggregate, when it is one. */
  from?: BiCalculation;
  notes: string[];
  /** DAX DISTINCTCOUNT counts an empty value as one more: the column, to count empty values in the check. */
  countsBlank?: string;
}

type Tree =
  | { k: 'part'; part: Part }
  | { k: 'number'; text: string }
  | { k: 'op'; op: '+' | '-' | '*' | '/'; left: Tree; right: Tree }
  | { k: 'negate'; operand: Tree }
  | { k: 'fn'; name: 'COALESCE' | 'ROUND' | 'ABS'; args: Tree[] };

interface Measure {
  k: 'measure';
  tree: Tree;
}

type Value = Row | Measure;

class LeftOut extends Error {}

/** Said when DISTINCTCOUNT reuses a metric: nothing ran, so whether the column has empty values is not known. */
const COUNTS_BLANK_NOTE = "Power BI's DISTINCTCOUNT counts an empty value as one more, and the metric it reuses does not: the two differ by one if the column has empty values.";

/** Column types a question groups by. Numbers are what metrics add up. */
const DIMENSION_TYPES: Partial<Record<BiDataType, DimensionDefinition['type']>> = { string: 'string', date: 'date', boolean: 'boolean' };

const AGGREGATE_WORDS: Record<AggregateFn, string> = {
  sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count', count_distinct: 'Distinct count',
};

const TABLEAU_AGGREGATES: Record<string, AggregateFn> = { SUM: 'sum', AVG: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTD: 'count_distinct' };
const DAX_AGGREGATES: Record<string, AggregateFn> = {
  SUM: 'sum', AVERAGE: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'count_distinct', DISTINCTCOUNTNOBLANK: 'count_distinct',
};

// ── Converting ──────────────────────────────────────────────────────────────

export function convertCalculationsToMetricDrafts(
  calculations: BiCalculation[],
  models: BiCalculationModel[],
  options: MetricDraftOptions,
): MetricDraftsResult {
  const classified = classifyCalculations(calculations);
  const converter = new Converter(calculations, models, options);
  // `classified` keeps the order: each is its calculation with a kind added.
  const conversions = classified.map((calculation, index) => converter.convert(calculation, calculations[index]!));
  return { conversions, drafts: converter.drafts(), dimensions: converter.dimensions() };
}

class Converter {
  private readonly byKey = new Map<string, MetricDraft>();
  private readonly ordered: MetricDraft[] = [];
  private readonly taken = new Set<string>();
  private readonly existing = new Map<string, { name: string; draft: boolean }>();
  private readonly tables = new Map<string, TableInfo | { error: string }>();
  private readonly translated = new Map<BiCalculation, Value | LeftOut>();
  /** Notes found while translating each calculation (and the ones it builds on). */
  private readonly notesOf = new Map<BiCalculation, Set<string>>();
  private readonly stack = new Set<BiCalculation>();
  private readonly text: (value: string) => string;
  /** The tables this run's calculations read, for their dimensions. */
  private readonly readTables = new Map<string, TableInfo>();

  constructor(
    private readonly calculations: BiCalculation[],
    private readonly models: BiCalculationModel[],
    private readonly options: MetricDraftOptions,
  ) {
    this.text = options.stringLiteral ?? sqlString;
    const known = (metric: MetricDefinition, draft: boolean) => {
      this.taken.add(metric.name.toLowerCase());
      // Only a filter written as text can be compared; a metric with another filter form is never "the same".
      if (metric.filter === undefined || metric.filter === null || typeof metric.filter === 'string') {
        const key = definitionKey(metric.table, metric.type, metric.sql, metric.filter ?? undefined);
        if (!metric.metricType && metric.table && metric.type !== 'custom' && !this.existing.has(key)) this.existing.set(key, { name: metric.name, draft });
      }
      const combined = combinedKey(metric.metricType, metric.typeParams);
      if (combined && !this.existing.has(combined)) this.existing.set(combined, { name: metric.name, draft });
    };
    for (const metric of options.existingMetrics ?? []) known(metric, false);
    for (const metric of options.existingDrafts ?? []) known(metric, true);
    for (const name of options.takenNames ?? []) this.taken.add(name.toLowerCase());
  }

  drafts(): MetricDraft[] {
    return this.ordered;
  }

  dimensions(): DimensionDefinition[] {
    const existing = this.options.existingDimensions ?? [];
    const onColumn = new Set(existing.map((dimension) => `${dimension.table.trim().toLowerCase()}\u0000${dimension.sql.trim()}`));
    const names = new Set([...this.taken, ...existing.map((dimension) => dimension.name.toLowerCase())]);
    const drafted: DimensionDefinition[] = [];
    for (const table of this.readTables.values()) {
      for (const field of table.model.fields) {
        if (field.table !== table.bi.name || !DIMENSION_TYPES[field.dataType]) continue;
        let sql: string;
        try {
          sql = this.column(field, table.model).sql;
        } catch {
          // A column the database lacks or Power Query changes is no dimension.
          continue;
        }
        const key = `${table.sql.trim().toLowerCase()}\u0000${sql}`;
        if (onColumn.has(key)) continue;
        onColumn.add(key);
        const label = field.caption ?? field.name;
        const base = metricName(label);
        // The same name on another table, or a metric's: the table says which.
        let name = names.has(base) ? `${metricName(table.bi.name)}_${base}` : base;
        for (let suffix = 2; names.has(name); suffix += 1) name = `${metricName(table.bi.name)}_${base}_${suffix}`;
        names.add(name);
        const tool = table.model.tool;
        drafted.push({
          name,
          label,
          description: `Column ${field.column} of ${table.sql}, from ${table.model.tool === 'tableau' ? 'Tableau data source' : 'Power BI model'} ${table.model.name}.`,
          domain: this.options.domain,
          status: 'draft',
          sql,
          type: DIMENSION_TYPES[field.dataType]!,
          table: table.sql,
          ...(field.dataType === 'date' ? { isTimeDimension: true } : {}),
          ...(this.options.owner ? { owner: this.options.owner } : {}),
          tags: ['imported', tool, 'human-review'],
          source: {
            provider: tool,
            objectType: 'field',
            objectId: `${table.model.sourcePath}#${table.model.name}/${field.name}`,
            objectName: label,
            importedAt: this.options.importedAt,
          },
        });
      }
    }
    return drafted;
  }

  convert(calculation: ClassifiedCalculation, original: BiCalculation): CalculationConversion {
    if (calculation.kind === 'advanced') return { calculation, outcome: 'advanced', reason: calculation.reason, notes: [] };
    if (calculation.kind === 'row-level') return { calculation, outcome: 'row-level', reason: calculation.reason, notes: [] };
    if (calculation.language === 'dax' && calculation.role !== 'measure') return { calculation, outcome: 'row-level', reason: calculation.reason, notes: [] };
    const model = this.modelOf(calculation);
    if (!model) return { calculation, outcome: 'left-out', reason: 'ZLens could not read where its fields come from.', notes: [] };
    if (model.noTables) return { calculation, outcome: 'left-out', reason: `Data source ${model.name}: ${model.noTables}`, notes: [] };
    if (model.unreadableFilters.length) return { calculation, outcome: 'left-out', reason: model.unreadableFilters[0]!, notes: [] };
    const value = this.valueOf(original);
    if (value instanceof LeftOut) return { calculation, outcome: 'left-out', reason: value.message, notes: [] };
    if (value.k === 'row') return { calculation, outcome: 'row-level', reason: 'A value for each row: a column or dimension.', notes: [] };
    try {
      return this.draft(calculation, original, value.tree);
    } catch (error) {
      return { calculation, outcome: 'left-out', reason: leftOutReason(error), notes: [] };
    }
  }

  private modelOf(calculation: BiCalculation): BiCalculationModel | undefined {
    return this.models.find((model) => model.sourcePath === calculation.sourcePath && (model.tool === 'powerbi' ? calculation.language === 'dax' : model.name === calculation.owner));
  }

  /** A calculation's value, translated once; a calculation that refers to itself is left out. */
  private valueOf(calculation: BiCalculation): Value | LeftOut {
    const known = this.translated.get(calculation);
    if (known) return known;
    if (this.stack.has(calculation)) return new LeftOut(`${calculation.name} refers to itself through other calculations.`);
    const model = this.modelOf(calculation);
    if (!model) return new LeftOut(`ZLens could not read where the fields of ${calculation.name} come from.`);
    this.stack.add(calculation);
    let value: Value | LeftOut;
    try {
      const node = parseFormula(calculation.language === 'tableau' ? calculation.rawFormula ?? calculation.formula : calculation.formula, calculation.language);
      const context: Context = { calculation, model, notes: new Set(), homeTable: calculation.language === 'dax' && calculation.role === 'column' ? calculation.owner : undefined };
      this.notesOf.set(calculation, context.notes);
      value = this.translate(node, context);
    } catch (error) {
      // One calculation ZLens cannot read never stops the rest.
      value = new LeftOut(leftOutReason(error));
    } finally {
      this.stack.delete(calculation);
    }
    this.translated.set(calculation, value);
    return value;
  }

  // ── The tree to values ────────────────────────────────────────────────────

  private translate(node: FormulaNode, context: Context): Value {
    const dax = context.calculation.language === 'dax';
    switch (node.k) {
      case 'number': {
        const text = plainNumber(node);
        return constant(text, /^\d+$/.test(text) ? 'integer' : 'number', { kind: 'number', value: node.value });
      }
      case 'string':
        return constant(this.text(node.value), 'string', { kind: 'string', value: node.value });
      case 'date':
        return constant(this.text(node.value), 'date', { kind: 'date', value: node.value });
      case 'boolean':
        return constant(node.value ? 'true' : 'false', 'boolean', { kind: 'boolean', value: node.value });
      case 'null':
        return constant('null', 'unknown', { kind: 'null' });
      case 'field':
        return dax ? this.daxReference(node, context) : this.tableauField(node, context);
      case 'table':
        throw new LeftOut(`It uses the table ${node.name} outside COUNTROWS.`);
      case 'unsupported':
        throw new LeftOut(`It uses ${node.what}, which ZLens does not translate.`);
      case 'negate': {
        const operand = this.translate(node.operand, context);
        if (operand.k === 'measure') return { k: 'measure', tree: { k: 'negate', operand: operand.tree } };
        return { ...numeric(operand, '-'), sql: `-${wrap(operand.sql)}`, literal: undefined, column: undefined };
      }
      case 'not':
        return this.condition(node, context);
      case 'in':
      case 'binary':
        if (node.k === 'in' || ['=', '==', '<>', '<', '>', '<=', '>=', 'and', 'or'].includes(node.op)) return this.condition(node, context);
        return this.arithmetic(node, context);
      case 'if':
        throw new LeftOut('It uses IF outside an aggregate: a condition on aggregated values or a value per row.');
      case 'call':
        return this.call(node, context);
    }
  }

  private tableauField(node: Extract<FormulaNode, { k: 'field' }>, context: Context): Value {
    if (node.table && /^parameters$/i.test(node.table)) throw new LeftOut(`It uses the parameter ${node.name}.`);
    if (node.table) throw new LeftOut(`It reads [${node.table}].[${node.name}], a field of another data source.`);
    const scope = this.calculations.filter((calculation) => calculation !== context.calculation && calculation.language === 'tableau' && calculation.sourcePath === context.calculation.sourcePath && calculation.owner === context.calculation.owner);
    const fields = context.model.fields;
    const byId = scope.find((calculation) => calculation.id === node.name);
    const field = fields.find((candidate) => candidate.name === node.name);
    const byCaption = scope.find((calculation) => calculation.name === node.name);
    const fieldByCaption = fields.find((candidate) => candidate.caption === node.name);
    const lower = node.name.toLowerCase();
    const calculation = byId ?? (field ? undefined : byCaption);
    if (calculation) return this.reference(calculation, context);
    const found = field ?? fieldByCaption
      ?? fields.find((candidate) => candidate.name.toLowerCase() === lower || candidate.caption?.toLowerCase() === lower);
    if (!found) {
      // Without a metadata record the field's table is unknown; when no table is a database table, that is why.
      const tables = context.model.tables;
      if (tables.length && tables.every((table) => table.noTable)) throw new LeftOut(`Data source ${context.model.name} reads ${tables.length === 1 ? tables[0]!.name : `${tables.length} relations`}. ${tables[0]!.noTable}`);
      throw new LeftOut(`ZLens could not find the field [${node.name}] in data source ${context.model.name}.`);
    }
    return this.column(found, context.model);
  }

  private daxReference(node: Extract<FormulaNode, { k: 'field' }>, context: Context): Value {
    const lower = node.name.toLowerCase();
    const sameFile = (calculation: BiCalculation) => calculation !== context.calculation && calculation.language === 'dax' && calculation.sourcePath === context.calculation.sourcePath;
    const tableName = node.table ?? context.homeTable;
    if (tableName) {
      const table = tableName.toLowerCase();
      const calculated = this.calculations.find((calculation) => sameFile(calculation) && calculation.role === 'column' && calculation.name.toLowerCase() === lower && (calculation.owner ?? '').toLowerCase() === table);
      if (calculated) {
        const value = this.reference(calculated, context);
        if (value.k !== 'row') throw new LeftOut(`The calculated column ${calculated.name} aggregates.`);
        return value;
      }
      const field = context.model.fields.find((candidate) => candidate.name.toLowerCase() === lower && candidate.table.toLowerCase() === table);
      if (field) return this.column(field, context.model);
    }
    const measure = this.calculations.find((calculation) => sameFile(calculation) && calculation.role === 'measure' && calculation.name.toLowerCase() === lower
      && (!node.table || (calculation.owner ?? '').toLowerCase() === node.table.toLowerCase()));
    if (measure) return this.reference(measure, context);
    throw new LeftOut(`ZLens could not find ${node.table ? `${node.table}[${node.name}]` : `[${node.name}]`} in the model.`);
  }

  /** Another calculation used in this one: its value, as a part named after it when it is one aggregate. */
  private reference(calculation: BiCalculation, context: Context): Value {
    const value = this.valueOf(calculation);
    if (value instanceof LeftOut) throw new LeftOut(`It builds on ${calculation.name}: ${value.message}`);
    for (const note of this.notesOf.get(calculation) ?? []) context.notes.add(note);
    if (value.k === 'measure' && value.tree.k === 'part' && !value.tree.part.from) {
      return { k: 'measure', tree: { k: 'part', part: { ...value.tree.part, label: calculation.name, from: calculation } } };
    }
    return value;
  }

  private column(field: BiModelField, model: BiCalculationModel): Row {
    const bi = model.tables.find((table) => table.name === field.table);
    const label = field.caption ?? field.name;
    if (!bi) throw new LeftOut(`ZLens could not tell which table the field ${label} is in.`);
    if (bi.noTable) throw new LeftOut(`The field ${label} is in ${bi.name}. ${bi.noTable}`);
    const table = this.table(bi, model);
    const changedType = bi.changedTypes?.[field.column.toLowerCase()];
    if (changedType) throw new LeftOut(`Power Query changes the column ${field.column} to ${changedType}, so the database's values differ from the report's.`);
    let sql = quoteName(field.column);
    if (table.columns) {
      const found = table.columns.get(field.column.toLowerCase());
      if (!found) throw new LeftOut(`The column ${field.column} is not in ${table.sql}.`);
      sql = found;
    }
    return { k: 'row', sql, table, type: field.dataType, columns: new Set([field.column.toLowerCase()]), column: { sql, type: field.dataType } };
  }

  private table(bi: BiModelTable, model: BiCalculationModel): TableInfo {
    const key = `${model.sourcePath}\u0000${model.name}\u0000${bi.name}`;
    let known = this.tables.get(key);
    if (!known) {
      const source = bi.source!;
      const resolved = this.options.resolveTable
        ? this.options.resolveTable(source, bi, model)
        : { sql: [source.schema, source.table].filter(Boolean).map((part) => quoteName(part!)).join('.') };
      known = 'error' in resolved ? resolved : { key, sql: resolved.sql, bi, model, ...(resolved.columns ? { columns: resolved.columns } : {}), notes: resolved.notes ?? [] };
      this.tables.set(key, known);
    }
    if ('error' in known) throw new LeftOut(known.error);
    return known;
  }

  /** `divides`: DAX DIVIDE, which gives a blank for 0 as a metric does. */
  private arithmetic(node: Extract<FormulaNode, { k: 'binary' }>, context: Context, divides = false): Value {
    const op = node.op;
    if (op === '&') throw new LeftOut('It joins text with &, which no metric does.');
    if (op === '%' || op === '^') throw new LeftOut(`It uses ${op === '%' ? 'the remainder %' : 'the power ^'}, which ZLens does not translate.`);
    const left = this.translate(node.left, context);
    const right = this.translate(node.right, context);
    const dax = context.calculation.language === 'dax';
    if (left.k === 'measure' || right.k === 'measure') {
      const tree = (value: Value): Tree => {
        if (value.k === 'measure') return value.tree;
        if (value.literal?.kind === 'number') return { k: 'number', text: value.sql };
        throw new LeftOut('It mixes a value per row with an aggregate.');
      };
      let leftTree = tree(left);
      let rightTree = tree(right);
      if (dax && (op === '+' || op === '-')) {
        // A blank counts as 0 in DAX + and -.
        leftTree = blankAsZero(leftTree);
        rightTree = blankAsZero(rightTree);
        context.notes.add('Where both sides are empty, Power BI shows an empty value; the metric shows 0.');
      }
      if (op === '/' && dax && !divides && rightTree.k !== 'number') context.notes.add('Power BI shows infinity when the denominator is 0; the metric shows an empty value.');
      return { k: 'measure', tree: { k: 'op', op: op as '+' | '-' | '*' | '/', left: leftTree, right: rightTree } };
    }
    const a = numeric(left, op);
    const b = numeric(right, op);
    const table = sameTable(a, b);
    // A blank counts as 0 in DAX + and -, row by row too.
    const addsBlanks = dax && (op === '+' || op === '-');
    const operand = (row: Row) => (addsBlanks && !row.literal ? `coalesce(${row.sql}, 0)` : wrap(row.sql));
    const sql = op === '/' ? `${wrap(a.sql)} * 1.0 / nullif(${b.sql}, 0)` : `${operand(a)} ${op} ${operand(b)}`;
    if (op === '/' && dax && !divides && !b.literal) context.notes.add('Power BI gives infinity for a division by 0 in a row; the metric gives an empty value.');
    const blankAsZeroRow = addsBlanks || a.blankAsZero || b.blankAsZero;
    return {
      k: 'row',
      sql,
      ...(table ? { table } : {}),
      type: op !== '/' && a.type === 'integer' && b.type === 'integer' ? 'integer' : 'number',
      columns: new Set([...a.columns, ...b.columns]),
      ...(blankAsZeroRow ? { blankAsZero: true } : {}),
    };
  }

  /**
   * A condition on one table's columns, as SQL. DAX comparisons follow DAX's
   * rules for blanks and text. A DAX comparison is true or false, never empty,
   * so `NOT` is pushed down to the comparison (`NOT T[x] = 1` is `T[x] <> 1`
   * by DAX's rules) rather than written as SQL's `not`, which drops empty rows.
   */
  private condition(node: FormulaNode, context: Context, negated = false): Row {
    const dax = context.calculation.language === 'dax';
    if (node.k === 'binary' && (node.op === 'and' || node.op === 'or')) {
      const left = this.condition(node.left, context, negated);
      const right = this.condition(node.right, context, negated);
      const table = sameTable(left, right);
      const op = negated ? (node.op === 'and' ? 'or' : 'and') : node.op;
      const side = (row: Row) => (op === 'and' ? andOperand(row.sql) : row.sql);
      return { k: 'row', sql: `${side(left)} ${op} ${side(right)}`, ...(table ? { table } : {}), type: 'boolean', columns: new Set([...left.columns, ...right.columns]) };
    }
    if (node.k === 'not') {
      if (dax) return this.condition(node.operand, context, !negated);
      const operand = this.condition(node.operand, context);
      return { ...operand, sql: `not ${wrap(operand.sql)}`, literal: undefined, column: undefined };
    }
    if (node.k === 'in') {
      const operand = this.rowOf(node.operand, context);
      const values = node.values.map((value) => this.rowOf(value, context));
      if (!values.length) throw new LeftOut('It compares with an empty list.');
      if (values.some((value) => !value.literal)) throw new LeftOut('It compares with a list that is not plain values.');
      const sql = dax ? daxIn(operand, values, operand.table?.bi, this.text, negated) : `${operand.sql} in (${values.map((value) => value.sql).join(', ')})`;
      return { k: 'row', sql, ...(operand.table ? { table: operand.table } : {}), type: 'boolean', columns: operand.columns };
    }
    if (node.k === 'binary' && ['=', '==', '<>', '<', '>', '<=', '>='].includes(node.op)) {
      let left = this.rowOf(node.left, context);
      let right = this.rowOf(node.right, context);
      let op = node.op;
      if (dax) {
        if (left.literal && !right.literal) {
          [left, right] = [right, left];
          op = flip(op);
        }
        if (!right.literal || !left.column) throw new LeftOut('It compares two columns; a DAX filter compares a column with a value.');
        if (left.table?.bi.mode === 'dual' && left.column.type === 'string') context.notes.add(`Table ${left.table.bi.name} is dual: Power BI can compare its text either ignoring case or as the database does.`);
        const sql = daxComparison(left, negated ? opposite(op) : op, right, left.table?.bi, this.text);
        return { k: 'row', sql, ...(left.table ? { table: left.table } : {}), type: 'boolean', columns: left.columns };
      }
      const table = sameTable(left, right);
      return { k: 'row', sql: `${left.sql} ${op} ${right.sql}`, ...(table ? { table } : {}), type: 'boolean', columns: new Set([...left.columns, ...right.columns]) };
    }
    if (node.k === 'call' && (node.name === 'ISNULL' || node.name === 'ISBLANK')) {
      if (node.name !== (dax ? 'ISBLANK' : 'ISNULL') || node.args.length !== 1) throw new LeftOut(`It uses ${node.name} in a form ZLens does not translate.`);
      const operand = this.rowOf(node.args[0]!, context);
      return { k: 'row', sql: `${wrap(operand.sql)} is ${negated ? 'not ' : ''}null`, ...(operand.table ? { table: operand.table } : {}), type: 'boolean', columns: operand.columns };
    }
    if (negated) throw new LeftOut('It uses NOT on a value ZLens does not translate.');
    const value = this.rowOf(node, context);
    if (value.type !== 'boolean' && value.type !== 'unknown') throw new LeftOut('It uses a value as a condition.');
    return value;
  }

  private rowOf(node: FormulaNode, context: Context): Row {
    const value = this.translate(node, context);
    if (value.k === 'measure') throw new LeftOut('It compares an aggregate: a condition on aggregated values.');
    return value;
  }

  private call(node: Extract<FormulaNode, { k: 'call' }>, context: Context): Value {
    const dax = context.calculation.language === 'dax';
    const fn = dax ? DAX_AGGREGATES[node.name] : TABLEAU_AGGREGATES[node.name];
    if (fn) {
      // DAX MIN(a, b) and MAX(a, b) with two values are not aggregates.
      if (node.args.length !== 1) throw new LeftOut(`It uses ${node.name} with ${node.args.length} arguments.`);
      return { k: 'measure', tree: { k: 'part', part: this.aggregate(fn, node.name, node.args[0]!, context) } };
    }
    if (dax && node.name === 'COUNTROWS') {
      const [table] = node.args;
      if (node.args.length !== 1 || table?.k !== 'table') throw new LeftOut('It uses COUNTROWS of something other than a table.');
      const bi = context.model.tables.find((candidate) => candidate.name.toLowerCase() === table.name.toLowerCase());
      if (!bi) throw new LeftOut(`ZLens could not find the table ${table.name} in the model.`);
      if (bi.noTable) throw new LeftOut(`The table ${bi.name}: ${bi.noTable}`);
      const info = this.table(bi, context.model);
      return { k: 'measure', tree: { k: 'part', part: { fn: 'count', sql: '*', table: info, filterColumns: new Set(), label: `Count of rows in ${bi.name}`, notes: [] } } };
    }
    if (dax && node.name === 'CALCULATE') return this.calculate(node, context);
    if (dax && node.name === 'DIVIDE') {
      if (node.args.length === 3) throw new LeftOut('It uses DIVIDE with an alternate result, which a metric gives differently when the numerator is blank.');
      if (node.args.length !== 2) throw new LeftOut('It uses DIVIDE with other than two arguments.');
      return this.arithmetic({ k: 'binary', op: '/', left: node.args[0]!, right: node.args[1]! }, context, true);
    }
    if (node.name === 'MEDIAN' || node.name === 'ATTR' || /^(?:STDEV|VAR|PERCENTILE)/.test(node.name)) {
      throw new LeftOut(`It uses ${node.name}, which a ZLens metric has no type for.`);
    }
    if ((node.name === 'ZN' && !dax) || node.name === 'ABS' || node.name === 'ROUND' || (node.name === 'IFNULL' && !dax) || (node.name === 'COALESCE' && dax)) {
      const count = node.args.length;
      const fits = node.name === 'ZN' || node.name === 'ABS' ? count === 1 : node.name === 'ROUND' ? count === 1 || count === 2 : node.name === 'IFNULL' ? count === 2 : count >= 2;
      if (!fits) throw new LeftOut(`It uses ${node.name} with ${count} argument${count === 1 ? '' : 's'}.`);
      const args = node.args.map((arg) => this.translate(arg, context));
      const measures = args.some((arg) => arg.k === 'measure');
      if (measures) {
        const trees = args.map((arg) => {
          if (arg.k === 'measure') return arg.tree;
          if (arg.literal?.kind === 'number') return { k: 'number', text: arg.sql } as Tree;
          throw new LeftOut(`It mixes a value per row with an aggregate in ${node.name}.`);
        });
        if (node.name === 'ZN') return { k: 'measure', tree: { k: 'fn', name: 'COALESCE', args: [trees[0]!, { k: 'number', text: '0' }] } };
        if (node.name === 'IFNULL' || node.name === 'COALESCE') return { k: 'measure', tree: { k: 'fn', name: 'COALESCE', args: trees } };
        return { k: 'measure', tree: { k: 'fn', name: node.name as 'ROUND' | 'ABS', args: trees } };
      }
      const rows = args as Row[];
      let table: TableInfo | undefined;
      for (const row of rows) table = sameTable({ ...row, table }, row);
      const sqlArgs = node.name === 'ZN' ? [rows[0]!.sql, '0'] : rows.map((row) => row.sql);
      const name = node.name === 'ZN' || node.name === 'IFNULL' ? 'coalesce' : node.name.toLowerCase();
      return { k: 'row', sql: `${name}(${sqlArgs.join(', ')})`, ...(table ? { table } : {}), type: rows[0]!.type, columns: new Set(rows.flatMap((row) => [...row.columns])), ...(rows.some((row) => row.blankAsZero) ? { blankAsZero: true } : {}) };
    }
    if (dax && node.name === 'DATE' && node.args.length === 3 && node.args.every((arg) => arg.k === 'number')) {
      const [year, month, day] = node.args.map((arg) => (arg as { value: number }).value) as [number, number, number];
      // DAX rolls DATE(2024, 13, 1) over to the next year, and reads a small year as 19xx.
      const date = new Date(Date.UTC(year, month - 1, day));
      if (year < 1900 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new LeftOut(`It uses DATE(${year}, ${month}, ${day}), which DAX rolls over to another date.`);
      const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return constant(this.text(value), 'date', { kind: 'date', value });
    }
    if (node.name === 'ISNULL' || node.name === 'ISBLANK') return this.condition(node, context);
    throw new LeftOut(`It uses ${node.name}, which ZLens does not translate.`);
  }

  /**
   * One aggregate: its value per row, and a condition when it adds up only
   * some rows (`SUM(IF [Region] = "East" THEN [Sales] END)`). `ELSE 0` keeps
   * the meaning only for SUM.
   */
  private aggregate(fn: AggregateFn, written: string, arg: FormulaNode, context: Context): Part {
    let valueNode = arg;
    let conditionNode: FormulaNode | undefined;
    let elseZero = false;
    if (arg.k === 'if' || (arg.k === 'call' && arg.name === 'IIF' && context.calculation.language === 'tableau')) {
      const branches = arg.k === 'if' ? arg.branches : [{ condition: arg.args[0]!, then: arg.args[1]! }];
      const otherwise = arg.k === 'if' ? arg.otherwise : arg.args[2];
      if (arg.k === 'call' && (arg.args.length < 2 || arg.args.length > 3)) throw new LeftOut('It uses IIF with other than two or three arguments.');
      if (branches.length !== 1) throw new LeftOut('It uses ELSEIF inside the aggregate: more than one condition.');
      elseZero = otherwise?.k === 'number' && otherwise.value === 0;
      if (otherwise && otherwise.k !== 'null' && !(elseZero && fn === 'sum')) {
        throw new LeftOut(elseZero ? `It uses ELSE 0 inside ${written}, which changes what ${written} gives.` : 'It has an ELSE value inside the aggregate.');
      }
      conditionNode = branches[0]!.condition;
      valueNode = branches[0]!.then;
    }
    const value = this.translate(valueNode, context);
    if (value.k === 'measure') throw new LeftOut(`It uses an aggregate inside ${written}.`);
    const condition = conditionNode ? this.condition(conditionNode, context) : undefined;
    const table = value.table ?? condition?.table;
    if (!table) throw new LeftOut(`It uses ${written} of a constant, which reads no table.`);
    if (value.table && condition?.table && value.table.key !== condition.table.key) {
      throw new LeftOut(`Its condition reads ${condition.table.bi.name} and its value reads ${value.table.bi.name}: a filter on another table.`);
    }
    if (value.type === 'string' && (fn === 'sum' || fn === 'avg')) throw new LeftOut(`It uses ${written} of text.`);
    if (value.blankAsZero && fn !== 'sum') throw new LeftOut(`It uses ${written} of a column built with + or -: DAX skips a row where both sides are blank, and a metric would read it as 0.`);
    const label = `${AGGREGATE_WORDS[fn]} of ${describeRow(valueNode, value)}`;
    const notes = [...table.notes];
    if (elseZero) notes.push('With ELSE 0, Tableau shows 0 for a group with no matching rows; a metric leaves that group out when a question groups by a column.');
    const sql = fn === 'avg' && value.type === 'integer' ? `1.0 * ${wrap(value.sql)}` : value.sql;
    const part: Part = {
      fn,
      sql,
      table,
      ...(condition ? { filter: condition.sql } : {}),
      filterColumns: condition?.columns ?? new Set(),
      label,
      notes,
      ...(written === 'DISTINCTCOUNT' ? { countsBlank: value.sql } : {}),
    };
    return this.withSourceFilters(part);
  }

  /** Tableau data source and extract filters narrow every calculation on the data source. */
  private withSourceFilters(part: Part): Part {
    const model = part.table.model;
    const filters: string[] = [];
    for (const filter of model.filters) {
      const field = model.fields.find((candidate) => candidate.name === filter.field);
      if (!field) throw new LeftOut(`A ${filter.from} filter on ${filter.field} reads a calculation, which ZLens does not translate.`);
      if (field.table !== part.table.bi.name) throw new LeftOut(`A ${filter.from} filter on ${field.caption ?? field.name} reads ${field.table}, not ${part.table.bi.name}: a filter on another table.`);
      filters.push(sourceFilterSql(filter, this.column(field, model).sql, this.text));
    }
    const notes = [...part.notes];
    if (model.joins) {
      notes.push(`Data source ${model.name} joins ${model.joins.tables} tables${model.joins.inner.length ? `, with inner joins (${model.joins.inner.join('; ')})` : ''}. Tableau computed this on the joined rows; the metric counts each row of ${part.table.sql} once. Check the value against the old report.`);
    }
    if (model.readsExtract) notes.push(`The workbook reads an extract of data source ${model.name}; the metric reads the live table, so recent rows can differ.`);
    if (!filters.length) return { ...part, notes };
    const filter = andAll([part.filter, ...filters]);
    return { ...part, filter, notes: [...notes, `It includes data source ${model.name}'s ${filters.length === 1 ? 'filter' : 'filters'}.`] };
  }

  private calculate(node: Extract<FormulaNode, { k: 'call' }>, context: Context): Value {
    const [expression, ...filters] = node.args;
    if (!expression || !filters.length) throw new LeftOut('It uses CALCULATE without a filter.');
    const inner = this.translate(expression, context);
    if (inner.k !== 'measure' || inner.tree.k !== 'part') throw new LeftOut('It uses CALCULATE of more than one aggregate.');
    const part = inner.tree.part;
    const conditions: string[] = [];
    const filtered = new Set(part.filterColumns);
    const overriding: string[] = [];
    for (const raw of filters) {
      const keep = raw.k === 'call' && raw.name === 'KEEPFILTERS' && raw.args.length === 1;
      const filter = keep ? (raw as Extract<FormulaNode, { k: 'call' }>).args[0]! : raw;
      const condition = this.condition(filter, context);
      if (!condition.table || condition.table.key !== part.table.key) {
        throw new LeftOut(`It filters on ${condition.table?.bi.name ?? 'another table'}, not ${part.table.bi.name}, where it adds up: a filter on another table.`);
      }
      for (const column of condition.columns) {
        if (filtered.has(column)) throw new LeftOut(`It filters ${column} again, which the measure it builds on already filters.`);
        filtered.add(column);
        if (!keep) overriding.push(column);
      }
      conditions.push(condition.sql);
    }
    const notes = [...part.notes];
    if (overriding.length) {
      notes.push(`In Power BI this measure ignores the report's own filter or grouping on ${overriding.join(', ')}; a metric's filter combines with the question's instead. They agree unless a question filters or groups by ${overriding.join(', ')}.`);
    }
    const filter = andAll([part.filter, ...conditions]);
    return { k: 'measure', tree: { k: 'part', part: { ...part, from: undefined, filter, filterColumns: filtered, label: `${part.label} (${context.calculation.name})`, notes } } };
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  private draft(calculation: ClassifiedCalculation, original: BiCalculation, tree: Tree): CalculationConversion {
    const notes = Array.from(new Set([...treeNotes(tree), ...(this.notesOf.get(original) ?? [])]));
    for (const part of treeParts(tree)) this.readTables.set(part.table.key, part.table);
    if (tree.k === 'part') {
      const part = { ...tree.part, label: calculation.name };
      const existing = this.existing.get(definitionKeyOf(part));
      if (existing) {
        if (part.countsBlank) notes.push(COUNTS_BLANK_NOTE);
        return { calculation, outcome: 'reused', metric: existing.name, reason: `${calculation.name} is already the metric${existing.draft ? ' draft' : ''} ${existing.name}.`, notes, inWords: partWords(part) };
      }
      const draft = this.partDraft({ ...part, notes }, calculation, false);
      return { calculation, outcome: 'drafted', metric: draft.definition.name, notes, inWords: draft.inWords };
    }
    const parts = new Map<Part, string>();
    const nameOf = (part: Part): string => {
      const known = parts.get(part);
      if (known) return known;
      const existing = this.existing.get(definitionKeyOf(part));
      if (existing && part.countsBlank && !notes.includes(COUNTS_BLANK_NOTE)) notes.push(COUNTS_BLANK_NOTE);
      const name = existing?.name ?? this.partDraft(part, calculation, true).definition.name;
      parts.set(part, name);
      return name;
    };
    const definition = calculationDefinition(calculation, this.options);
    let combine: MetricDraft['combine'];
    let inWords: string;
    if (tree.k === 'op' && tree.op === '/' && tree.left.k === 'part' && tree.right.k === 'part') {
      const numerator = nameOf(tree.left.part);
      const denominator = nameOf(tree.right.part);
      combine = { numerator, denominator };
      Object.assign(definition, { metricType: 'ratio', typeParams: { numerator, denominator } });
      inWords = treeWords(tree);
    } else {
      const expr = renderTree(tree, nameOf);
      const metrics = Array.from(new Set(parts.values()));
      if (!metrics.length) throw new LeftOut('It reads no aggregate.');
      combine = { expr, metrics };
      Object.assign(definition, { metricType: 'derived', typeParams: { expr, metrics } });
      inWords = treeWords(tree);
    }
    const same = this.existing.get(combinedKey(definition.metricType, definition.typeParams)!);
    if (same) return { calculation, outcome: 'reused', metric: same.name, reason: `${calculation.name} is already the metric${same.draft ? ' draft' : ''} ${same.name}.`, notes, inWords };
    const name = this.claimName(calculation.name);
    Object.assign(definition, { name, sql: name, type: 'custom', table: '' });
    definition.source!.extra = { ...definition.source!.extra, notes };
    const draft: MetricDraft = { definition, inWords, combine, calculation: calculation.name, part: false };
    this.ordered.push(draft);
    return { calculation, outcome: 'drafted', metric: name, notes, inWords };
  }

  /** A simple or filtered draft, or the one already made with the same definition. */
  private partDraft(part: Part, calculation: ClassifiedCalculation, isPart: boolean): MetricDraft {
    const key = partKey(part);
    const label = isPart ? part.from?.name ?? part.label : calculation.name;
    const known = this.byKey.get(key);
    if (known) {
      // The same definition under another name (a measure that is another measure) is one draft that answers to both.
      const named = !isPart || part.from;
      if (named && known.definition.label !== label && !known.definition.synonyms?.includes(label)) known.definition.synonyms = [...(known.definition.synonyms ?? []), label];
      if (!isPart && known.part) known.part = false;
      return known;
    }
    const owner = isPart ? part.from ?? calculation : calculation;
    const name = this.claimName(label);
    const definition: MetricDefinition = {
      ...calculationDefinition(owner as ClassifiedCalculation, this.options),
      name,
      label,
      type: part.fn,
      sql: part.sql,
      table: part.table.sql,
      ...(part.filter ? { filter: part.filter } : {}),
      synonyms: [label],
    };
    if (isPart && !part.from) {
      definition.description = `Part of ${calculation.name}, from ${describeSource(calculation)}.`;
      definition.source = { ...definition.source!, objectType: 'calculation_part', objectId: `${definition.source!.objectId}#${name}`, objectName: label };
    }
    const inWords = partWords(part);
    definition.source!.extra = {
      ...definition.source!.extra,
      kind: part.filter ? 'filtered' : 'simple',
      readsTable: readsTable(part.table),
      notes: part.notes,
    };
    const draft: MetricDraft = {
      definition,
      inWords,
      check: {
        table: part.table.sql,
        expression: aggregateSql(part),
        ...(part.countsBlank ? { emptyValues: `sum(case when ${part.countsBlank} is null${part.filter ? ` and ${wrap(part.filter)}` : ''} then 1 else 0 end)` } : {}),
      },
      calculation: calculation.name,
      part: isPart,
    };
    this.byKey.set(key, draft);
    this.ordered.push(draft);
    return draft;
  }

  private claimName(label: string): string {
    const base = metricName(label);
    let name = base;
    for (let suffix = 2; this.taken.has(name); suffix += 1) name = `${base}_${suffix}`;
    this.taken.add(name);
    return name;
  }
}

interface Context {
  calculation: BiCalculation;
  model: BiCalculationModel;
  notes: Set<string>;
  /** DAX: a calculated column's own table, which its bare `[Column]` names. */
  homeTable?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function constant(sql: string, type: BiDataType, literal: BiLiteral): Row {
  return { k: 'row', sql, type, columns: new Set(), literal };
}

function numeric(row: Row, op: string): Row {
  if (row.type === 'string') throw new LeftOut(`It uses ${op} on text${op === '+' ? ' (joining text)' : ''}.`);
  if (row.type === 'date') throw new LeftOut(`It uses ${op} on a date, which each database and BI tool computes differently.`);
  return row;
}

function sameTable(a: Row, b: Row): TableInfo | undefined {
  if (a.table && b.table && a.table.key !== b.table.key) throw new LeftOut(`It reads ${a.table.bi.name} and ${b.table.bi.name} in one value: two tables.`);
  return a.table ?? b.table;
}

/** Why a calculation is left out, whatever stopped it. */
function leftOutReason(error: unknown): string {
  if (error instanceof LeftOut || error instanceof FormulaError) return error.message;
  if (error instanceof RangeError) return 'Its formula is nested too deeply for ZLens to read.';
  return `ZLens could not translate it: ${error instanceof Error ? error.message : String(error)}`;
}

/** `.5` → `0.5`, `1e3` → `1000`: a number as metric expressions read it, kept as written so a long one keeps its digits. */
function plainNumber(node: Extract<FormulaNode, { k: 'number' }>): string {
  if (/^\d+(?:\.\d+)?$/.test(node.text)) return node.text;
  const text = String(node.value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new LeftOut(`It uses the number ${node.text}, which ZLens does not translate.`);
  return text;
}

/**
 * The parts of a SQL expression that matter for parentheses, read outside
 * quoted text and quoted names: whether one pair of parentheses holds all of
 * it, and whether it has an `or` of its own.
 */
function sqlShape(sql: string): { wrapped: boolean; topLevelOr: boolean } {
  let depth = 0;
  let firstClose = -1;
  let topLevelOr = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] !== close) break;
          index += 1;
        }
        index += 1;
      }
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0 && firstClose < 0) firstClose = index;
    } else if (depth === 0 && /^ or /i.test(sql.slice(index, index + 4))) {
      topLevelOr = true;
    }
  }
  return { wrapped: sql.startsWith('(') && firstClose === sql.length - 1, topLevelOr };
}

/** Parentheses around an expression, unless it is one name, one value, or already all inside one pair. */
function wrap(sql: string): string {
  if (/^[\w.]+$|^'(?:[^']|'')*'$|^"(?:[^"]|"")*"$|^`[^`]*`$|^\[[^\]]*\]$/.test(sql)) return sql;
  return sqlShape(sql).wrapped ? sql : `(${sql})`;
}

/** Conditions joined with `and`; one that has a top-level `or` is put in parentheses. */
function andAll(conditions: Array<string | undefined>): string {
  const present = conditions.filter((sql): sql is string => Boolean(sql));
  return present.length === 1 ? present[0]! : present.map(andOperand).join(' and ');
}

function andOperand(sql: string): string {
  return sqlShape(sql).topLevelOr ? `(${sql})` : sql;
}

/** The same comparison with its sides swapped. */
function flip(op: string): string {
  return op === '<' ? '>' : op === '>' ? '<' : op === '<=' ? '>=' : op === '>=' ? '<=' : op;
}

/** The comparison that is true exactly when `op` is false. `!==` is the opposite of DAX's strict `==`. */
function opposite(op: string): string {
  const opposites: Record<string, string> = { '=': '<>', '<>': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!==', '!==': '==' };
  return opposites[op]!;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function literalSql(literal: BiLiteral, text: (value: string) => string): string {
  if (literal.kind === 'null') return 'null';
  if (literal.kind === 'number') return String(literal.value);
  if (literal.kind === 'boolean') return literal.value ? 'true' : 'false';
  return text(literal.value);
}

/**
 * Words a column or table cannot be called without quotes. Most only fail
 * (the check then says so); `user`, `current_date` and the like run and read
 * something else, so a column with such a name gives a wrong number silently.
 */
const RESERVED_SQL_WORDS = new Set([
  'all', 'alter', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'between', 'bigint', 'both', 'by', 'case', 'cast', 'check',
  'collate', 'column', 'constraint', 'create', 'cross', 'current', 'current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time',
  'current_timestamp', 'current_user', 'database', 'date', 'default', 'deferrable', 'delete', 'desc', 'distinct', 'do', 'drop', 'else', 'end', 'except',
  'exists', 'false', 'fetch', 'for', 'foreign', 'from', 'full', 'grant', 'group', 'having', 'if', 'ilike', 'in', 'index', 'initially', 'inner', 'insert',
  'intersect', 'interval', 'into', 'is', 'join', 'key', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural', 'not',
  'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'over', 'partition', 'percent', 'primary', 'qualify', 'range', 'references', 'returning', 'right',
  'row', 'rows', 'schema', 'select', 'session_user', 'set', 'similar', 'some', 'symmetric', 'sysdate', 'system_user', 'table', 'tablesample', 'then', 'time',
  'timestamp', 'to', 'top', 'trailing', 'true', 'unbounded', 'union', 'unique', 'update', 'user', 'using', 'values', 'variadic', 'view', 'when', 'where',
  'window', 'with', 'utc_date', 'utc_time', 'utc_timestamp',
]);

/** Whether a name can be written in SQL without quotes on any database. */
export function isPlainSqlName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_SQL_WORDS.has(name.toLowerCase());
}

/** `Order ID` → `"Order ID"`, `user` → `"user"`; a plain name stays as written. */
function quoteName(name: string): string {
  return isPlainSqlName(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** `Total Sales` → `total_sales`; `_SumTotalPrice` → `sum_total_price`; `Profit %` → `profit_pct`. */
export function metricName(label: string): string {
  const name = label
    .replace(/%/g, ' pct ')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!name) return 'metric';
  return /^\d/.test(name) ? `metric_${name}` : name;
}

/** Two metrics are the same only when table, type, expression and filter are, to the letter: `'a  b'` is not `'a b'`. */
function definitionKey(table: string, type: string, sql: string, filter: string | undefined): string {
  return [table.trim().toLowerCase(), type, sql.trim(), (filter ?? '').trim()].join('\u0000');
}

/** A ratio's or derived metric's identity: its kind and what it combines. */
function combinedKey(metricType: string | undefined, typeParams: Record<string, unknown> | undefined): string | undefined {
  const params = typeParams ?? {};
  const named = (value: unknown) => (typeof value === 'string' ? value : (value as { name?: string } | undefined)?.name ?? '');
  if (metricType === 'ratio') return ['ratio', named(params.numerator), named(params.denominator)].join('\u0000').toLowerCase();
  if (metricType === 'derived' && typeof params.expr === 'string') return ['derived', params.expr.replace(/\s+/g, ' ').trim()].join('\u0000').toLowerCase();
  return undefined;
}

function definitionKeyOf(part: Part): string {
  return definitionKey(part.table.sql, part.fn, part.sql, part.filter);
}

/** A draft of this run: DISTINCTCOUNT stays apart from DISTINCTCOUNTNOBLANK, because its check also counts empty values. */
function partKey(part: Part): string {
  return `${definitionKeyOf(part)}\u0000${part.countsBlank ? 'counts blank' : ''}`;
}

function aggregateSql(part: Part): string {
  const inner = part.fn === 'count' && part.sql === '*'
    ? (part.filter ? `case when ${part.filter} then 1 end` : '*')
    : part.filter ? `case when ${part.filter} then ${part.sql} end` : part.sql;
  if (part.fn === 'count_distinct') return `count(distinct ${inner})`;
  return `${part.fn}(${inner})`;
}

/** A ratio or derived metric in words: its parts' aggregates, and the table once when they share it. */
function treeWords(tree: Tree): string {
  const tables = new Set<string>();
  const words = renderTree(tree, (part) => {
    tables.add(part.table.sql);
    const fn = part.fn === 'count_distinct' ? 'count(distinct ' : `${part.fn}(`;
    return `${fn}${part.sql})${part.filter ? ` where ${part.filter}` : ''}`;
  }).replace(/NULLIF\((.*?), 0\)/g, '$1');
  return tables.size === 1 ? `${words}, on ${[...tables][0]}` : words;
}

function partWords(part: Part): string {
  const fn = part.fn === 'count_distinct' ? 'count(distinct ' : `${part.fn}(`;
  return `${fn}${part.sql})${part.filter ? ` where ${part.filter}` : ''}, on ${part.table.sql}`;
}

function describeRow(node: FormulaNode, value: Row): string {
  if (node.k === 'field') return node.name;
  if (node.k === 'number' && node.text === '1') return 'rows';
  return value.sql.replace(/"/g, '');
}

function readsTable(table: TableInfo): string {
  const source = table.bi.source;
  if (!source) return table.sql;
  const written = [source.schema, source.table].filter(Boolean).join('.');
  const where = [source.server ? `server ${source.server}` : '', source.database ? `database ${source.database}` : ''].filter(Boolean).join(', ');
  return `${written}${source.connector ? ` on ${source.connector}` : ''}${where ? ` (${where})` : ''}`;
}

function describeSource(calculation: BiCalculation): string {
  const file = calculation.sourcePath.split('/').pop() ?? calculation.sourcePath;
  return calculation.language === 'tableau'
    ? `Tableau calculated field ${calculation.name} in ${file}${calculation.owner ? `, data source ${calculation.owner}` : ''}`
    : `Power BI measure ${calculation.name} in ${file}${calculation.owner ? `, table ${calculation.owner}` : ''}`;
}

function calculationDefinition(calculation: ClassifiedCalculation | BiCalculation, options: MetricDraftOptions): MetricDefinition {
  const tool = calculation.language === 'tableau' ? 'tableau' : 'powerbi';
  return {
    name: metricName(calculation.name),
    label: calculation.name,
    description: `From ${describeSource(calculation)}.`,
    domain: options.domain,
    status: 'draft',
    type: 'custom',
    sql: '',
    table: '',
    synonyms: [calculation.name],
    ...(options.owner ? { owner: options.owner } : {}),
    tags: ['imported', tool, 'human-review'],
    source: {
      provider: tool,
      objectType: calculation.language === 'tableau' ? 'calculated_field' : 'measure',
      objectId: `${calculation.sourcePath}#${calculation.owner ?? ''}/${calculation.name}`,
      objectName: calculation.name,
      importedAt: options.importedAt,
      extra: {
        formula: formulaWithoutComments(calculation.formula, calculation.language),
        ...('kind' in calculation ? { kind: calculation.kind } : {}),
      },
    },
  };
}

/**
 * A DAX comparison of a column with a value, as Power BI evaluates it: a blank
 * is 0, "" or false, and imported text ignores case. Strict `==` (and `!==`,
 * its opposite here) does not treat a blank as anything else.
 */
function daxComparison(column: Row, op: string, value: Row, table: BiModelTable | undefined, text: (value: string) => string): string {
  const literal = value.literal!;
  const strict = op === '==' || op === '!==';
  const sqlOp = op === '==' ? '=' : op === '!==' ? '<>' : op;
  // Strictly, the opposite of "is this value" keeps the blank rows.
  const orBlank = (sql: string, blankMatches: boolean) => (blankMatches || op === '!==' ? `(${sql} or ${column.sql} is null)` : sql);
  if (literal.kind === 'null') {
    if (strict) return `${column.sql} is ${op === '!==' ? 'not ' : ''}null`;
    throw new LeftOut('It compares with BLANK(), which also matches 0 and "" in DAX.');
  }
  const type = column.column?.type && column.column.type !== 'unknown' ? column.column.type : literalType(literal);
  if (type === 'string') {
    const insensitive = table?.mode !== 'directQuery';
    const written = literal.kind === 'string' ? literal.value : value.sql;
    const compared = insensitive ? written.toLowerCase() : written;
    const sql = `${insensitive ? `lower(${column.sql})` : column.sql} ${sqlOp} ${text(compared)}`;
    return orBlank(sql, !strict && compare('', op, compared));
  }
  if (type === 'integer' || type === 'number') {
    if (literal.kind !== 'number') throw new LeftOut('It compares a number with a value that is not a number.');
    if (strict) return orBlank(`${column.sql} ${sqlOp} ${value.sql}`, false);
    return compare(0, op, literal.value) ? `coalesce(${column.sql}, 0) ${sqlOp} ${value.sql}` : `${column.sql} ${sqlOp} ${value.sql}`;
  }
  if (type === 'boolean') {
    if (literal.kind !== 'boolean') throw new LeftOut('It compares TRUE/FALSE with another value.');
    if (strict) return orBlank(`${column.sql} ${sqlOp} ${literal.value}`, false);
    return compare(0, op, literal.value ? 1 : 0) ? `coalesce(${column.sql}, false) ${sqlOp} ${literal.value}` : `${column.sql} ${sqlOp} ${literal.value}`;
  }
  if (type === 'date') {
    // A blank date is the earliest date.
    return orBlank(`${column.sql} ${sqlOp} ${value.sql}`, !strict && (op === '<' || op === '<=' || op === '<>'));
  }
  throw new LeftOut('ZLens could not tell the type of the column it compares.');
}

/**
 * DAX `IN` compares strictly: a blank is not 0 or "", and only BLANK() in the
 * list matches one. Imported text still ignores case.
 */
function daxIn(column: Row, values: Row[], table: BiModelTable | undefined, text: (value: string) => string, negated: boolean): string {
  if (!column.column) throw new LeftOut('It compares a value that is not a column with a list.');
  const present = values.filter((value) => value.literal!.kind !== 'null');
  const blank = present.length < values.length;
  const type = column.column.type !== 'unknown' ? column.column.type : literalType(present[0]?.literal ?? { kind: 'null' });
  let target = column.sql;
  let listed = present.map((value) => value.sql);
  if (type === 'string') {
    const insensitive = table?.mode !== 'directQuery';
    if (insensitive) target = `lower(${column.sql})`;
    listed = present.map((value) => {
      const written = value.literal!.kind === 'string' ? (value.literal as { value: string }).value : value.sql;
      return text(insensitive ? written.toLowerCase() : written);
    });
  } else if ((type === 'integer' || type === 'number') && present.some((value) => value.literal!.kind !== 'number')) {
    throw new LeftOut('It compares a number with a list of values that are not numbers.');
  }
  if (!listed.length) return `${column.sql} is ${negated ? 'not ' : ''}null`;
  if (negated) {
    const sql = `${target} not in (${listed.join(', ')})`;
    return blank ? sql : `(${sql} or ${column.sql} is null)`;
  }
  const sql = `${target} in (${listed.join(', ')})`;
  return blank ? `(${sql} or ${column.sql} is null)` : sql;
}

function literalType(literal: BiLiteral): BiDataType {
  if (literal.kind === 'string') return 'string';
  if (literal.kind === 'number') return 'number';
  if (literal.kind === 'date') return 'date';
  if (literal.kind === 'boolean') return 'boolean';
  return 'unknown';
}

function compare(left: string | number, op: string, right: string | number): boolean {
  switch (op) {
    case '=': return left === right;
    case '<>': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    default: return false;
  }
}

function sourceFilterSql(filter: BiSourceFilter, column: string, text: (value: string) => string): string {
  if (filter.kind === 'range') {
    const parts = [filter.min ? `${column} >= ${literalSql(filter.min, text)}` : '', filter.max ? `${column} <= ${literalSql(filter.max, text)}` : ''].filter(Boolean);
    const range = parts.join(' and ') || `${column} is not null`;
    return filter.includeNull ? `(${range} or ${column} is null)` : range;
  }
  const values = filter.values ?? [];
  const nulls = values.some((value) => value.kind === 'null');
  const plain = values.filter((value) => value.kind !== 'null').map((value) => literalSql(value, text));
  if (filter.kind === 'include') {
    const listed = plain.length ? `${column} in (${plain.join(', ')})` : '';
    if (nulls) return listed ? `(${listed} or ${column} is null)` : `${column} is null`;
    return listed || '1 = 0';
  }
  // Tableau keeps empty values a filter does not name.
  const listed = plain.length ? `${column} not in (${plain.join(', ')})` : '';
  if (nulls) return listed ? `${listed}` : `${column} is not null`;
  return listed ? `(${listed} or ${column} is null)` : '1 = 1';
}

/** DAX: a blank counts as 0 in + and -. */
function blankAsZero(tree: Tree): Tree {
  if (tree.k === 'number') return tree;
  if (tree.k === 'fn' && tree.name === 'COALESCE') return tree;
  return { k: 'fn', name: 'COALESCE', args: [tree, { k: 'number', text: '0' }] };
}

/** A derived metric's expression over its parts' names; every division is guarded against 0. */
function renderTree(tree: Tree, nameOf: (part: Part) => string): string {
  const render = (node: Tree, parent?: Tree['k'] | '+' | '-' | '*' | '/', right = false): string => {
    switch (node.k) {
      case 'part': return nameOf(node.part);
      case 'number': return node.text;
      case 'negate': return `-${render(node.operand, '*')}`;
      case 'fn': return `${node.name}(${node.args.map((arg) => render(arg)).join(', ')})`;
      case 'op': {
        const left = render(node.left, node.op);
        const rightSql = node.op === '/' ? `NULLIF(${render(node.right)}, 0)` : render(node.right, node.op, true);
        const sql = `${left} ${node.op} ${rightSql}`;
        const loose = node.op === '+' || node.op === '-';
        const needs = parent === '*' || parent === '/' ? loose || right : (parent === '+' || parent === '-') && right && loose;
        return needs ? `(${sql})` : sql;
      }
    }
  };
  return render(tree);
}

function treeParts(tree: Tree): Part[] {
  if (tree.k === 'part') return [tree.part];
  if (tree.k === 'op') return [...treeParts(tree.left), ...treeParts(tree.right)];
  if (tree.k === 'negate') return treeParts(tree.operand);
  if (tree.k === 'fn') return tree.args.flatMap(treeParts);
  return [];
}

function treeNotes(tree: Tree): string[] {
  return Array.from(new Set(treeParts(tree).flatMap((part) => part.notes)));
}
