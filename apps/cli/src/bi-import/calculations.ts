/**
 * Sorting Tableau calculated fields and Power BI DAX by how they move to
 * ZLens, for `zlens migrate assess` (and the calculations-to-metrics drafts
 * that build on it):
 *
 * - simple: one aggregate (`SUM([Sales])`, `DISTINCTCOUNT(Orders[customer_id])`): one metric.
 * - filtered: one aggregate with a condition (`SUM(IF [Region]="East" THEN [Sales] END)`,
 *   `CALCULATE(SUM(Orders[total]), Orders[status] = "paid")`): one metric with a filter.
 * - ratio: aggregates combined with arithmetic (`SUM([Profit]) / SUM([Sales])`, `DIVIDE([A], [B])`): one metric.
 * - row-level: a value per row (`[Price] * [Qty]`, a DAX calculated column): a column or dimension.
 * - advanced: a level of detail expression, a table calculation, time
 *   intelligence, an iterator, a condition on totals, or a value that depends
 *   on who is viewing: rewrite it by hand or with a coding agent.
 *
 * The rules read the formula's text (comments and strings removed); they do
 * not run it. A formula that builds on another calculation takes the harder
 * of the two kinds.
 */

export type CalculationKind = 'simple' | 'filtered' | 'ratio' | 'row-level' | 'advanced';

export interface BiCalculation {
  name: string;
  formula: string;
  language: 'tableau' | 'dax';
  /** measure: a DAX measure or a Tableau field; column: a DAX calculated column; table: a DAX calculated table. */
  role: 'measure' | 'column' | 'table';
  /** The Tableau data source or the Power BI table it belongs to. */
  owner?: string;
  /** The file it was read from. */
  sourcePath: string;
  /**
   * The other calculations it uses, by name, when the reader knows them
   * (Tableau names fields by internal name, so a column and a calculation can
   * share a caption). Without it, a `[Name]` matching a calculation counts.
   */
  references?: string[];
  /** Tableau: the field's internal name (`Calculation_1234`), which other formulas use. */
  id?: string;
  /** Tableau: the formula as stored, naming fields by internal name, for turning it into a metric. */
  rawFormula?: string;
}

export interface ClassifiedCalculation extends BiCalculation {
  kind: CalculationKind;
  /** Why, in plain words: what makes an advanced calculation advanced. */
  reason: string;
}

export const CALCULATION_KIND_LABELS: Record<CalculationKind, string> = {
  simple: 'Simple: one aggregate',
  filtered: 'Filtered: one aggregate with a condition',
  ratio: 'Ratio: aggregates combined',
  'row-level': 'Row-level: a value per row',
  advanced: 'Advanced',
};

// ── Reading a formula ───────────────────────────────────────────────────────

/**
 * A formula read once, left to right, so a `//` inside a string, an
 * apostrophe in a field name (`[Last Year's Sales]`) or a function's name
 * inside a field name (`[Total (copy)]`) is never taken for code. All three
 * keep the formula's length, so a position in one is the same in the others.
 */
interface ScannedFormula {
  /** Comments blanked, string contents blanked: what the formula computes, with its names. */
  code: string;
  /** `code` with every name blanked too (inside `[…]`, and DAX's quoted table names): what the rules read. */
  shape: string;
  /** Comments removed, strings kept: for showing. */
  display: string;
}

function scanFormula(formula: string, language: BiCalculation['language']): ScannedFormula {
  let code = '';
  let shape = '';
  let display = '';
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  let index = 0;
  const take = (end: number, kind: 'code' | 'string' | 'name' | 'comment') => {
    const text = formula.slice(index, end);
    if (kind === 'comment') {
      code += blank(text);
      shape += blank(text);
      display += ' ';
    } else if (kind === 'string') {
      const inner = text.length >= 2 ? `${text[0]}${blank(text.slice(1, -1))}${text[text.length - 1]}` : blank(text);
      code += inner;
      shape += inner;
      display += text;
    } else if (kind === 'name') {
      code += text;
      shape += text.length >= 2 ? `${text[0]}${'_'.repeat(text.length - 2)}${text[text.length - 1]}` : text;
      display += text;
    } else {
      code += text;
      shape += text;
      display += text;
    }
    index = end;
  };
  /** The end of a quoted run opened at `index` by `quote`, where a doubled quote stays inside. */
  const closing = (quote: string) => {
    let at = index + 1;
    while (at < formula.length) {
      if (formula[at] === quote) {
        if (formula[at + 1] === quote) at += 2;
        else return at + 1;
      } else at += 1;
    }
    return formula.length;
  };
  while (index < formula.length) {
    const char = formula[index]!;
    const next = formula[index + 1];
    if (char === '/' && next === '*') {
      const end = formula.indexOf('*/', index + 2);
      take(end < 0 ? formula.length : end + 2, 'comment');
    } else if ((char === '/' && next === '/') || (language === 'dax' && char === '-' && next === '-')) {
      const end = formula.slice(index).search(/[\r\n]/);
      take(end < 0 ? formula.length : index + end, 'comment');
    } else if (char === '[') {
      // `]]` is a `]` inside the name.
      take(closing(']'), 'name');
    } else if (char === '"' || (char === "'" && language === 'tableau')) {
      take(closing(char), 'string');
    } else if (char === "'" && language === 'dax') {
      // DAX quotes table names in single quotes; they are names, not text.
      take(closing("'"), 'name');
    } else {
      let end = index + 1;
      while (end < formula.length && !/[\/\-\['"]/.test(formula[end]!)) end += 1;
      take(end, 'code');
    }
  }
  return { code, shape, display: display.replace(/\s+/g, ' ').trim() };
}

const ORDER: CalculationKind[] = ['simple', 'filtered', 'ratio', 'row-level', 'advanced'];

// ── Tableau ─────────────────────────────────────────────────────────────────

const TABLEAU_AGGREGATES = /\b(?:SUM|AVG|MIN|MAX|COUNTD?|MEDIAN|ATTR|STDEVP?|VARP?|PERCENTILE|COLLECT|CORR|COVARP?)\s*\(/i;
const TABLEAU_SIMPLE = /^(?:SUM|AVG|MIN|MAX|COUNTD?|MEDIAN)\s*\((.*)\)$/is;
const TABLEAU_ADVANCED: Array<[RegExp, string]> = [
  [/\{/, 'A level of detail expression ({FIXED …}, {INCLUDE …}, {EXCLUDE …}).'],
  [/\b(?:RUNNING_\w+|WINDOW_\w+|LOOKUP|PREVIOUS_VALUE|RANK(?:_\w+)?|INDEX|FIRST|LAST|SIZE|TOTAL)\s*\(/i, 'A table calculation (RUNNING_SUM, WINDOW_…, RANK, LOOKUP, TOTAL).'],
  [/\b(?:USERNAME|USERDOMAIN|FULLNAME|ISMEMBEROF|ISUSERNAME|ISFULLNAME|USERATTRIBUTE\w*)\s*\(/i, 'Depends on who is viewing (USERNAME, ISMEMBEROF): a row rule, not a metric.'],
  [/\b(?:RAWSQL\w*|RAWSQLAGG\w*|SCRIPT_\w+|MODEL_\w+)\s*\(/i, 'Pass-through SQL or an analytics extension (RAWSQL, SCRIPT_…).'],
];

/** `[Name]` and `[Source].[Name]` references, as the name inside the last brackets. */
function tableauReferences(code: string): string[] {
  return Array.from(code.matchAll(/(?:\[(?:[^\]]|\]\])+\]\.)?\[((?:[^\]]|\]\])+)\]/g), (match) => match[1]!.replace(/\]\]/g, ']').trim());
}

// ── DAX ─────────────────────────────────────────────────────────────────────

const DAX_AGGREGATES = /\b(?:SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|COUNTBLANK|COUNTROWS|DISTINCTCOUNT|DISTINCTCOUNTNOBLANK|MEDIAN|CALCULATE)\s*\(/i;
const COLUMN_REF = String.raw`(?:'[^']*'|[A-Za-z_][\w ]*)?\[[^\]]+\]`;
const DAX_SIMPLE = new RegExp(String.raw`^(?:(?:SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|DISTINCTCOUNT|DISTINCTCOUNTNOBLANK|MEDIAN)\s*\(\s*${COLUMN_REF}\s*\)|COUNTROWS\s*\(\s*(?:'[^']*'|[A-Za-z_]\w*)\s*\))$`, 'i');
/** A column compared with a value (`T[c] = "x"`, `T[d] >= DATE(2024, 1, 1)`, `T[c] IN {…}`), alone or in KEEPFILTERS. */
const DAX_FILTER_ARG = new RegExp(String.raw`^(?:KEEPFILTERS\s*\(\s*)?${COLUMN_REF}\s*(?:=|==|<>|<=|>=|<|>|IN\b)\s*(?:\{[^}]*\}|[^{}\[\]]+?)\s*\)?$`, 'i');
const DAX_ADVANCED: Array<[RegExp, string]> = [
  [/\b(?:TOTAL[YQM]TD|DATES[YQM]TD|SAMEPERIODLASTYEAR|DATEADD|PARALLELPERIOD|PREVIOUS(?:DAY|MONTH|QUARTER|YEAR)|NEXT(?:DAY|MONTH|QUARTER|YEAR)|DATESBETWEEN|DATESINPERIOD|(?:OPENING|CLOSING)BALANCE\w*|(?:START|END)OF(?:MONTH|QUARTER|YEAR))\s*\(/i, 'Time intelligence (TOTALYTD, SAMEPERIODLASTYEAR, DATEADD …).'],
  [/\b(?:SUMX|AVERAGEX|MINX|MAXX|COUNTX|COUNTAX|PRODUCTX|CONCATENATEX|RANKX|MEDIANX|PERCENTILEX\.\w+)\s*\(/i, 'An iterator (SUMX, AVERAGEX, RANKX …) that works row by row over a table.'],
  [/\b(?:ALL|ALLEXCEPT|ALLSELECTED|ALLNOBLANKROW|REMOVEFILTERS|FILTER|CALCULATETABLE|USERELATIONSHIP|CROSSFILTER|TREATAS)\s*\(/i, 'Changes which rows count (ALL, FILTER, REMOVEFILTERS, USERELATIONSHIP …).'],
  [/\b(?:SELECTEDVALUE|HASONEVALUE|HASONEFILTER|ISFILTERED|ISCROSSFILTERED|ISINSCOPE|VALUES|EARLIER|EARLIEST|LOOKUPVALUE|RELATEDTABLE)\s*\(/i, 'Depends on the report\'s filters or another table (SELECTEDVALUE, VALUES, LOOKUPVALUE …).'],
  [/\b(?:SUMMARIZE|SUMMARIZECOLUMNS|ADDCOLUMNS|SELECTCOLUMNS|TOPN|GENERATE\w*|UNION|INTERSECT|EXCEPT|NATURAL\w+JOIN|CROSSJOIN|DATATABLE|GROUPBY)\s*\(/i, 'Builds a table (SUMMARIZE, TOPN, ADDCOLUMNS …).'],
  [/\b(?:USERPRINCIPALNAME|USERNAME|USEROBJECTID|CUSTOMDATA)\s*\(/i, 'Depends on who is viewing (USERPRINCIPALNAME): a row rule, not a metric.'],
  [/\bVAR\b/i, 'Uses variables (VAR … RETURN).'],
];

/** Every `[Name]` or `Table[Name]` in DAX code, with its table when written, and where it is. */
function daxReferences(code: string): Array<{ table?: string; name: string; start: number; end: number }> {
  return Array.from(code.matchAll(/('(?:[^']|'')*'|[A-Za-z_][\w]*)?\[((?:[^\]]|\]\])+)\]/g), (match) => ({
    ...(match[1] ? { table: match[1].replace(/^'|'$/g, '').replace(/''/g, "'") } : {}),
    name: match[2]!.replace(/\]\]/g, ']').trim(),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas, with where each starts. */
function callArguments(code: string, open: number): { args: Array<{ text: string; start: number }>; end: number } | null {
  const args: Array<{ text: string; start: number }> = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '{') depth += 1;
    else if (char === ')' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push({ text: code.slice(start, index), start });
        return { args, end: index };
      }
    } else if (char === ',' && depth === 1) {
      args.push({ text: code.slice(start, index), start });
      start = index + 1;
    }
  }
  return null;
}

// ── Classifying ─────────────────────────────────────────────────────────────

type Verdict = { kind: CalculationKind; reason: string };

/** Sort calculations into kinds. A formula that refers to another calculation of the same file is at least as hard. */
export function classifyCalculations(calculations: BiCalculation[]): ClassifiedCalculation[] {
  // Tableau refers to a calculation by caption or internal name within a data
  // source; DAX refers to measures by name across the model (one file).
  const scopeOf = (calculation: BiCalculation) => `${calculation.sourcePath}\u0000${calculation.language === 'tableau' ? calculation.owner ?? '' : ''}`;
  const byScope = new Map<string, Map<string, BiCalculation>>();
  for (const calculation of calculations) {
    if (calculation.language === 'dax' && calculation.role !== 'measure') continue;
    const scope = byScope.get(scopeOf(calculation)) ?? new Map<string, BiCalculation>();
    scope.set(calculation.name.toLowerCase(), calculation);
    byScope.set(scopeOf(calculation), scope);
  }
  const verdicts = new Map<BiCalculation, Verdict>();
  const visiting = new Set<BiCalculation>();

  const verdictOf = (calculation: BiCalculation): Verdict => {
    const known = verdicts.get(calculation);
    if (known) return known;
    if (visiting.has(calculation)) return { kind: 'advanced', reason: 'Refers to itself through other calculations.' };
    visiting.add(calculation);
    const scope = byScope.get(scopeOf(calculation)) ?? new Map<string, BiCalculation>();
    const lookup = (name: string) => {
      const found = scope.get(name.toLowerCase());
      return found && found !== calculation ? found : undefined;
    };
    const verdict = calculation.language === 'tableau' ? tableauVerdict(calculation, lookup, verdictOf) : daxVerdict(calculation, lookup, verdictOf);
    visiting.delete(calculation);
    verdicts.set(calculation, verdict);
    return verdict;
  };

  return calculations.map((calculation) => ({ ...calculation, ...verdictOf(calculation) }));
}

function tableauVerdict(
  calculation: BiCalculation,
  lookup: (name: string) => BiCalculation | undefined,
  verdictOf: (calculation: BiCalculation) => Verdict,
): Verdict {
  const { code, shape: rawShape } = scanFormula(calculation.formula, 'tableau');
  const shape = rawShape.trim();
  for (const [pattern, reason] of TABLEAU_ADVANCED) if (pattern.test(shape)) return { kind: 'advanced', reason };
  const referenced = (calculation.references ?? tableauReferences(code)).map(lookup).filter((found): found is BiCalculation => Boolean(found));
  const references = referenced.map((found) => ({ found, verdict: verdictOf(found) }));
  const advanced = references.find((reference) => reference.verdict.kind === 'advanced');
  if (advanced) return { kind: 'advanced', reason: `Builds on ${advanced.found.name}, which is advanced.` };
  // A row-level calculation is a column: aggregating it is still one metric.
  const aggregatedReference = references.some((reference) => reference.verdict.kind !== 'row-level');
  const aggregates = TABLEAU_AGGREGATES.test(shape);
  if (!aggregates && !aggregatedReference) {
    return { kind: 'row-level', reason: /^(?:'\s*'|"\s*"|-?[\d.]+|TRUE|FALSE|#[^#]+#)$/i.test(shape) ? 'A constant value.' : 'A value for each row: a column or dimension.' };
  }
  if (/^ATTR\s*\(\s*\[_*\]\s*\)$/i.test(shape)) return { kind: 'row-level', reason: 'ATTR of a field shows its one value: a dimension.' };
  const outer = TABLEAU_SIMPLE.exec(shape);
  if (outer && !TABLEAU_AGGREGATES.test(outer[1]!) && !aggregatedReference && balanced(outer[1]!)) {
    return /\b(?:IF|IIF|CASE)\b/i.test(outer[1]!)
      ? { kind: 'filtered', reason: 'One aggregate of a condition: a metric with a filter.' }
      : { kind: 'simple', reason: 'One aggregate: a metric.' };
  }
  if (/\b(?:IF|IIF|CASE)\b/i.test(outsideAggregates(shape))) return { kind: 'advanced', reason: 'A condition on aggregated values.' };
  return { kind: 'ratio', reason: 'Aggregates combined with arithmetic: a metric built from other metrics.' };
}

function daxVerdict(
  calculation: BiCalculation,
  lookup: (name: string) => BiCalculation | undefined,
  verdictOf: (calculation: BiCalculation) => Verdict,
): Verdict {
  const scanned = scanFormula(calculation.formula, 'dax');
  // Trimmed the same at both ends, so positions in code and shape still match.
  const lead = scanned.code.length - scanned.code.trimStart().length;
  const code = scanned.code.trim();
  const shape = scanned.shape.slice(lead, lead + code.length);
  if (calculation.role === 'table') return { kind: 'advanced', reason: 'A calculated table.' };
  for (const [pattern, reason] of DAX_ADVANCED) if (pattern.test(shape)) return { kind: 'advanced', reason };
  if (calculation.role === 'column') {
    return DAX_AGGREGATES.test(shape)
      ? { kind: 'advanced', reason: 'A calculated column that aggregates (row context to filter context).' }
      : { kind: 'row-level', reason: 'A calculated column: a value for each row.' };
  }
  // A measure is named `[Name]`, or `Table[Name]` with its home table.
  const measureAt = (reference: ReturnType<typeof daxReferences>[number]) => {
    const found = lookup(reference.name);
    return found && (!reference.table || reference.table.toLowerCase() === (found.owner ?? '').toLowerCase()) ? found : undefined;
  };
  const located = daxReferences(code).map((reference) => ({ ...reference, found: measureAt(reference) }));
  const references = located.filter((reference) => reference.found).map((reference) => ({ ...reference, found: reference.found!, verdict: verdictOf(reference.found!) }));
  const advanced = references.find((reference) => reference.verdict.kind === 'advanced');
  if (advanced) return { kind: 'advanced', reason: `Builds on ${advanced.found.name}, which is advanced.` };
  if (DAX_SIMPLE.test(shape)) return { kind: 'simple', reason: 'One aggregate: a metric.' };
  if (references.length === 1 && references[0]!.start === 0 && references[0]!.end === code.length) {
    return { ...references[0]!.verdict, reason: `The same as ${references[0]!.found.name}.` };
  }

  // Each CALCULATE must be one aggregate (or a simple measure) with column conditions.
  const simpleAt = (text: string, start: number) => {
    const trimmed = text.trim();
    const offset = start + text.indexOf(trimmed);
    if (DAX_SIMPLE.test(trimmed)) return true;
    const reference = references.find((candidate) => candidate.start === offset && candidate.end === offset + trimmed.length);
    return reference?.verdict.kind === 'simple';
  };
  const calls = Array.from(shape.matchAll(/\bCALCULATE\s*\(/gi));
  for (const call of calls) {
    const parsed = callArguments(shape, call.index! + call[0].length - 1);
    const [expression, ...filters] = parsed?.args ?? [];
    const simpleFilters = filters.length > 0 && filters.every((filter) => filter.text.split(/&&|\|\|/).every((part) => DAX_FILTER_ARG.test(part.trim())));
    if (!parsed || !expression || !simpleAt(expression.text, expression.start) || !simpleFilters) {
      return { kind: 'advanced', reason: 'CALCULATE with filters that are not simple column conditions.' };
    }
    if (call.index === 0 && parsed.end === shape.length - 1) return { kind: 'filtered', reason: 'One aggregate with a filter: a metric with a filter.' };
  }
  if (/\b(?:IF|SWITCH)\s*\(/i.test(shape)) return { kind: 'advanced', reason: 'A condition on aggregated values (IF, SWITCH).' };
  if (!DAX_AGGREGATES.test(shape) && references.length === 0) return { kind: 'row-level', reason: 'No aggregate: a constant or a value per row.' };
  return { kind: 'ratio', reason: 'Aggregates combined with arithmetic (or DIVIDE): a metric built from other metrics.' };
}

/** A formula without its comments, for showing: what it computes, not the notes about it. */
export function formulaWithoutComments(formula: string, language: BiCalculation['language']): string {
  return scanFormula(formula, language).display;
}

/** The code with every aggregate call's argument removed, to find a condition outside them. */
function outsideAggregates(code: string): string {
  let result = '';
  let index = 0;
  const pattern = new RegExp(TABLEAU_AGGREGATES.source, 'gi');
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    result += code.slice(index, match.index);
    const call = callArguments(code, match.index + match[0].length - 1);
    index = call ? call.end + 1 : code.length;
    pattern.lastIndex = index;
  }
  return result + code.slice(index);
}

/** Whether `(`…`)` pair up: `SUM([A]) / SUM([B])` is not one call `SUM(…)`. */
function balanced(inner: string): boolean {
  let depth = 0;
  for (const char of inner) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
