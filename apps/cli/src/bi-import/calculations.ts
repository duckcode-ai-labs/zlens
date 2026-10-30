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

const ORDER: CalculationKind[] = ['simple', 'filtered', 'ratio', 'row-level', 'advanced'];
const harder = (a: CalculationKind, b: CalculationKind): CalculationKind => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

// ── Tableau ─────────────────────────────────────────────────────────────────

const TABLEAU_AGGREGATES = /\b(?:SUM|AVG|MIN|MAX|COUNTD?|MEDIAN|ATTR|STDEVP?|VARP?|PERCENTILE|COLLECT|CORR|COVARP?)\s*\(/i;
const TABLEAU_SIMPLE = /^(?:SUM|AVG|MIN|MAX|COUNTD?|MEDIAN)\s*\((.*)\)$/is;
const TABLEAU_ADVANCED: Array<[RegExp, string]> = [
  [/\{/, 'A level of detail expression ({FIXED …}, {INCLUDE …}, {EXCLUDE …}).'],
  [/\b(?:RUNNING_\w+|WINDOW_\w+|LOOKUP|PREVIOUS_VALUE|RANK(?:_\w+)?|INDEX|FIRST|LAST|SIZE|TOTAL)\s*\(/i, 'A table calculation (RUNNING_SUM, WINDOW_…, RANK, LOOKUP, TOTAL).'],
  [/\b(?:USERNAME|USERDOMAIN|FULLNAME|ISMEMBEROF|ISUSERNAME|ISFULLNAME|USERATTRIBUTE\w*)\s*\(/i, 'Depends on who is viewing (USERNAME, ISMEMBEROF): a row rule, not a metric.'],
  [/\b(?:RAWSQL\w*|RAWSQLAGG\w*|SCRIPT_\w+|MODEL_\w+)\s*\(/i, 'Pass-through SQL or an analytics extension (RAWSQL, SCRIPT_…).'],
];

/** The formula without comments and with string literals emptied, so names inside them do not count. */
function tableauCode(formula: string): string {
  return formula
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim();
}

/** `[Name]` and `[Source].[Name]` references, as the name inside the last brackets. */
function tableauReferences(code: string): string[] {
  return Array.from(code.matchAll(/(?:\[[^\]]+\]\.)?\[([^\]]+)\]/g), (match) => match[1]!.trim());
}

// ── DAX ─────────────────────────────────────────────────────────────────────

const DAX_AGGREGATES = /\b(?:SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|COUNTBLANK|COUNTROWS|DISTINCTCOUNT|DISTINCTCOUNTNOBLANK|MEDIAN|CALCULATE)\s*\(/i;
const COLUMN_REF = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][\w ]*)?\[[^\]]+\]`;
const DAX_SIMPLE = new RegExp(String.raw`^(?:(?:SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|DISTINCTCOUNT|DISTINCTCOUNTNOBLANK|MEDIAN)\s*\(\s*${COLUMN_REF}\s*\)|COUNTROWS\s*\(\s*(?:'(?:[^']|'')+'|[A-Za-z_]\w*)\s*\))$`, 'i');
const DAX_FILTER_ARG = new RegExp(String.raw`^${COLUMN_REF}\s*(?:=|==|<>|<=|>=|<|>|IN\b)\s*(?:\{[^}]*\}|[^,{}]+)$`, 'i');
const DAX_ADVANCED: Array<[RegExp, string]> = [
  [/\b(?:TOTAL[YQM]TD|DATES[YQM]TD|SAMEPERIODLASTYEAR|DATEADD|PARALLELPERIOD|PREVIOUS(?:DAY|MONTH|QUARTER|YEAR)|NEXT(?:DAY|MONTH|QUARTER|YEAR)|DATESBETWEEN|DATESINPERIOD|(?:OPENING|CLOSING)BALANCE\w*|(?:START|END)OF(?:MONTH|QUARTER|YEAR))\s*\(/i, 'Time intelligence (TOTALYTD, SAMEPERIODLASTYEAR, DATEADD …).'],
  [/\b(?:SUMX|AVERAGEX|MINX|MAXX|COUNTX|COUNTAX|PRODUCTX|CONCATENATEX|RANKX|MEDIANX|PERCENTILEX\.\w+)\s*\(/i, 'An iterator (SUMX, AVERAGEX, RANKX …) that works row by row over a table.'],
  [/\b(?:ALL|ALLEXCEPT|ALLSELECTED|ALLNOBLANKROW|REMOVEFILTERS|KEEPFILTERS|FILTER|CALCULATETABLE|USERELATIONSHIP|CROSSFILTER|TREATAS)\s*\(/i, 'Changes which rows count (ALL, FILTER, REMOVEFILTERS, USERELATIONSHIP …).'],
  [/\b(?:SELECTEDVALUE|HASONEVALUE|HASONEFILTER|ISFILTERED|ISCROSSFILTERED|ISINSCOPE|VALUES|EARLIER|EARLIEST|LOOKUPVALUE|RELATEDTABLE)\s*\(/i, 'Depends on the report\'s filters or another table (SELECTEDVALUE, VALUES, LOOKUPVALUE …).'],
  [/\b(?:SUMMARIZE|SUMMARIZECOLUMNS|ADDCOLUMNS|SELECTCOLUMNS|TOPN|GENERATE\w*|UNION|INTERSECT|EXCEPT|NATURAL\w+JOIN|CROSSJOIN|DATATABLE|GROUPBY)\s*\(/i, 'Builds a table (SUMMARIZE, TOPN, ADDCOLUMNS …).'],
  [/\b(?:USERPRINCIPALNAME|USERNAME|USEROBJECTID|CUSTOMDATA)\s*\(/i, 'Depends on who is viewing (USERPRINCIPALNAME): a row rule, not a metric.'],
  [/\bVAR\b/i, 'Uses variables (VAR … RETURN).'],
];

function daxCode(formula: string): string {
  return formula
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?:\/\/|--)[^\n\r]*/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bare `[Name]` references (no table before them): measures, in a measure. */
function daxMeasureReferences(code: string): string[] {
  return Array.from(code.matchAll(/(^|[^\w'\]])\[([^\]]+)\]/g), (match) => match[2]!.trim());
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas. */
function callArguments(code: string, open: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"') {
      const close = code.indexOf('"', index + 1);
      index = close < 0 ? code.length : close;
    } else if (char === '(' || char === '{') depth += 1;
    else if (char === ')' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(code.slice(start, index).trim());
        return { args, end: index };
      }
    } else if (char === ',' && depth === 1) {
      args.push(code.slice(start, index).trim());
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
    if (visiting.has(calculation)) return { kind: 'advanced', reason: 'refers to itself through other calculations' };
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
  const code = tableauCode(calculation.formula);
  for (const [pattern, reason] of TABLEAU_ADVANCED) if (pattern.test(code)) return { kind: 'advanced', reason };
  const referenced = (calculation.references ?? tableauReferences(code)).map(lookup).filter((found): found is BiCalculation => Boolean(found));
  const references = referenced.map((found) => ({ found, verdict: verdictOf(found) }));
  const advanced = references.find((reference) => reference.verdict.kind === 'advanced');
  if (advanced) return { kind: 'advanced', reason: `Builds on ${advanced.found.name}, which is advanced.` };
  const aggregatedReference = references.some((reference) => reference.verdict.kind !== 'row-level');
  const aggregates = TABLEAU_AGGREGATES.test(code);
  if (!aggregates && !aggregatedReference) {
    return { kind: 'row-level', reason: /^(?:''|""|-?[\d.]+|TRUE|FALSE|#[^#]+#)$/i.test(code) ? 'A constant value.' : 'A value for each row: a column or dimension.' };
  }
  const outer = TABLEAU_SIMPLE.exec(code);
  if (outer && !TABLEAU_AGGREGATES.test(outer[1]!) && !aggregatedReference && balanced(outer[1]!)) {
    return /\b(?:IF|IIF|CASE)\b/i.test(outer[1]!)
      ? { kind: 'filtered', reason: 'One aggregate of a condition: a metric with a filter.' }
      : { kind: 'simple', reason: 'One aggregate: a metric.' };
  }
  if (/\b(?:IF|IIF|CASE)\b/i.test(outsideAggregates(code))) return { kind: 'advanced', reason: 'A condition on aggregated values.' };
  const base: Verdict = { kind: 'ratio', reason: 'Aggregates combined with arithmetic: a metric built from other metrics.' };
  return references.reduce<Verdict>((verdict, reference) => (harder(verdict.kind, reference.verdict.kind) === verdict.kind ? verdict : { kind: reference.verdict.kind, reason: verdict.reason }), base);
}

function daxVerdict(
  calculation: BiCalculation,
  lookup: (name: string) => BiCalculation | undefined,
  verdictOf: (calculation: BiCalculation) => Verdict,
): Verdict {
  const code = daxCode(calculation.formula);
  if (calculation.role === 'table') return { kind: 'advanced', reason: 'A calculated table.' };
  for (const [pattern, reason] of DAX_ADVANCED) if (pattern.test(code)) return { kind: 'advanced', reason };
  if (calculation.role === 'column') {
    return DAX_AGGREGATES.test(code)
      ? { kind: 'advanced', reason: 'A calculated column that aggregates (row context to filter context).' }
      : { kind: 'row-level', reason: 'A calculated column: a value for each row.' };
  }
  const references = daxMeasureReferences(code).map(lookup).filter((found): found is BiCalculation => Boolean(found)).map((found) => ({ found, verdict: verdictOf(found) }));
  const advanced = references.find((reference) => reference.verdict.kind === 'advanced');
  if (advanced) return { kind: 'advanced', reason: `Builds on ${advanced.found.name}, which is advanced.` };
  if (DAX_SIMPLE.test(code)) return { kind: 'simple', reason: 'One aggregate: a metric.' };
  const calculate = /^CALCULATE\s*\(/i.exec(code);
  if (calculate) {
    const call = callArguments(code, calculate[0].length - 1);
    if (call && call.end === code.length - 1 && call.args.length >= 2) {
      const [expression, ...filters] = call.args;
      const measure = /^\[([^\]]+)\]$/.exec(expression!);
      const inner = measure ? references.find((reference) => reference.found.name.toLowerCase() === measure[1]!.toLowerCase())?.verdict.kind : DAX_SIMPLE.test(expression!) ? 'simple' : undefined;
      if (inner === 'simple' && filters.every((filter) => filter.split(/\s*(?:&&|\|\|)\s*/).every((part) => DAX_FILTER_ARG.test(part)))) {
        return { kind: 'filtered', reason: 'One aggregate with a filter: a metric with a filter.' };
      }
    }
    return { kind: 'advanced', reason: 'CALCULATE with filters that are not simple column conditions.' };
  }
  if (/\b(?:IF|SWITCH)\s*\(/i.test(code)) return { kind: 'advanced', reason: 'A condition on aggregated values (IF, SWITCH).' };
  if (!DAX_AGGREGATES.test(code) && references.length === 0) return { kind: 'row-level', reason: 'No aggregate: a constant or a value per row.' };
  if (references.length === 1 && /^\[[^\]]+\]$/.test(code)) return { ...references[0]!.verdict, reason: `The same as ${references[0]!.found.name}.` };
  const base: Verdict = { kind: 'ratio', reason: 'Aggregates combined with arithmetic (or DIVIDE): a metric built from other metrics.' };
  return references.reduce<Verdict>((verdict, reference) => (harder(verdict.kind, reference.verdict.kind) === 'advanced' ? { kind: 'advanced', reason: verdict.reason } : verdict), base);
}

/** A formula without its comments, for showing: what it computes, not the notes about it. */
export function formulaWithoutComments(formula: string, language: BiCalculation['language']): string {
  const lineComment = language === 'tableau' ? /\/\/[^\n\r]*/g : /(?:\/\/|--)[^\n\r]*/g;
  return formula.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(lineComment, ' ').replace(/\s+/g, ' ').trim();
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
