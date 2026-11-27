/**
 * A SAVED QUERY'S PAGE, FOR REVIEW (the trust flow approved 2026-11-27): one line on how it is worked out, above the
 * SQL (which is folded away), and its checks as a list. Both are read from what the page already has: the query,
 * its last run, its parameters and owner, its declared tests and, once certified, its receipt.
 */

const MAX_FILTER = 140;
const MAX_TABLES = 3;

function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** `ZLENS_DEV.TRANSFORMED."DIM_TEAMS"` → `DIM_TEAMS`. */
function lastPart(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1]!.replace(/^["`[]|["`\]]$/g, '');
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The query with everything inside brackets blanked out (same length), so a clause is found only at its top level. */
function topLevel(sql: string): string {
  // By UTF-16 position, so a clause found here is sliced from the query at the same place.
  let depth = 0;
  let out = '';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === '(') depth += 1;
    out += depth > 0 ? ' ' : char;
    if (char === ')') depth = Math.max(0, depth - 1);
  }
  return out;
}

/** The text of a clause, up to the next clause that ends it, both at the top level of the query. */
function clauseText(sql: string, top: string, start: RegExp, ends: RegExp): string | null {
  const opening = start.exec(top);
  if (!opening) return null;
  const from = opening.index + opening[0].length;
  const closing = ends.exec(top.slice(from));
  return sql.slice(from, closing ? from + closing.index : undefined).trim() || null;
}

/**
 * One line, in plain words, on how a saved query's result is worked out: the tables it reads, the rows it keeps,
 * and what one row of the result is. Null when there is no SQL to read.
 */
export function howItsWorkedOut(sql: string): string | null {
  const text = withoutComments(sql).replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
  if (!text) return null;
  const steps = /^with\b/i.test(text)
    ? [...text.matchAll(/(?:^with\s+(?:recursive\s+)?|,\s*)([A-Za-z_][\w$]*)\s+as\s*\(/gi)].map((match) => match[1]!)
    : [];
  const stepNames = new Set(steps.map((step) => step.toLowerCase()));
  const tables = [...new Set([...text.matchAll(/\b(?:from|join)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))*)/gi)]
    .map((match) => lastPart(match[1]!))
    .filter((name) => !stepNames.has(name.toLowerCase())))];
  const read = tables.length === 0
    ? 'Works out its result'
    : `Reads ${listWords(tables.length > MAX_TABLES ? [...tables.slice(0, MAX_TABLES), `${tables.length - MAX_TABLES} more`] : tables)}`;
  if (steps.length > 0) {
    return `${read}, in ${steps.length} step${steps.length === 1 ? '' : 's'} (${steps.join(', ')}), then gives the last step's rows.`;
  }
  const top = topLevel(text);
  const where = clauseText(text, top, /\bwhere\b/i, /\b(?:group\s+by|having|order\s+by|limit|qualify|union|window)\b/i);
  const groupBy = clauseText(text, top, /\bgroup\s+by\b/i, /\b(?:having|order\s+by|limit|qualify|union|window)\b/i);
  const limit = /\blimit\s+(\d+)\s*$/i.exec(top)?.[1];
  const aggregates = /\b(?:count|sum|avg|min|max)\s*\(/i.test(text);
  const parts = [read];
  if (where) parts.push(`keeps the rows where ${where.length > MAX_FILTER ? `${where.slice(0, MAX_FILTER).trimEnd()}…` : where}`);
  if (groupBy) {
    const columns = groupBy.split(',').map((column) => column.trim()).filter(Boolean);
    parts.push(columns.every((column) => /^\d+$/.test(column))
      ? `and gives one row for each value of its first ${columns.length === 1 ? 'column' : `${columns.length} columns`}`
      : `and gives one row per ${listWords(columns.map(lastPart))}`);
  } else if (aggregates) {
    parts.push('and adds them up into one row');
  } else {
    parts.push('and lists those rows');
  }
  const sentence = parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, ${parts[parts.length - 1]}` : parts.join(', ');
  return `${sentence}${limit ? ` (the first ${limit})` : ''}.`;
}

/** A saved query built from metrics, in the same plain words. */
export function howSemanticIsWorkedOut(fields: { metrics: string[]; dimensions: string[]; timeDimension?: string }): string | null {
  if (fields.metrics.length === 0) return null;
  const by = [...fields.dimensions, ...(fields.timeDimension ? [fields.timeDimension] : [])];
  return `Works out ${listWords(fields.metrics)} from the certified metrics${by.length ? `, one row per ${listWords(by)}` : ''}.`;
}

export interface SavedQueryCheck {
  label: string;
  state: 'passed' | 'not_yet' | 'failed';
  /** Why it is not passed yet, in a few words. */
  detail?: string;
}

/**
 * The checks a person looks at before certifying, as a list. Running it, having no errors, an owner and a default
 * for each parameter are what Certify checks too; its own tests, when it has any, are run by Certify. A certified
 * query shows what its receipt says was checked.
 */
export function savedQueryChecks(input: {
  ran: boolean;
  runFailed?: boolean;
  problems: number;
  owner?: string | null;
  parameters: Array<{ name: string; default?: unknown; required?: boolean }>;
  tests: string[];
  certifiedChecks?: string[];
}): SavedQueryCheck[] {
  if (input.certifiedChecks?.length) return input.certifiedChecks.map((label) => ({ label, state: 'passed' }));
  const missingDefaults = input.parameters.filter((parameter) => parameter.required && (parameter.default === undefined || parameter.default === null || parameter.default === ''));
  return [
    input.runFailed
      ? { label: 'Runs without errors', state: 'failed', detail: 'the last run failed' }
      : input.ran
        ? { label: 'Runs without errors', state: 'passed' }
        : { label: 'Runs without errors', state: 'not_yet', detail: 'press Run' },
    input.problems > 0
      ? { label: 'No problems in the query', state: 'failed', detail: `${input.problems} to fix` }
      : { label: 'No problems in the query', state: 'passed' },
    input.owner?.trim()
      ? { label: `Has an owner: ${input.owner.trim()}`, state: 'passed' }
      : { label: 'Has an owner', state: 'failed', detail: 'add one in the builder' },
    ...(input.parameters.length === 0 ? [] : [missingDefaults.length === 0
      ? { label: input.parameters.length === 1 ? 'Its parameter has a default' : 'Each parameter has a default', state: 'passed' as const }
      : { label: 'Each parameter has a default', state: 'failed' as const, detail: `no default for ${missingDefaults.map((parameter) => parameter.name).join(', ')}` }]),
    // Its own tests run when it is certified, not on Run.
    ...input.tests.map((test) => ({ label: `Test: ${test.replace(/^assert\s+/i, '')}`, state: 'not_yet' as const, detail: 'checked when you certify' })),
  ];
}
