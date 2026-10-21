/**
 * How a block's `tests { assert … }` lines are checked against its result.
 * Block Studio (Run and Certify), `zlens certify` and `zlens test` all use
 * this, so a test means the same thing wherever it runs.
 *
 * - `assert row_count <op> <n>` compares the number of result rows.
 * - `assert <column> <op> <value>` must hold for every row of the result; the
 *   first row that breaks it is reported. An empty result has no row that
 *   breaks it (add `assert row_count > 0` to require rows).
 * - `assert <column> IN [a, b, …]` holds when every row's value is one of the
 *   listed values.
 *
 * `==`, `!=` and `IN` compare numbers as numbers and anything else as text;
 * `>`, `>=`, `<` and `<=` need numbers, so a null or non-numeric value fails them.
 */

export interface BlockTestAssertionInput {
  field: string;
  operator: string;
  expected: unknown;
}

export interface BlockTestAssertionOutcome {
  passed: boolean;
  /** The value checked: the row count, or the column value of the first row that failed (else of the first row). */
  actual?: unknown;
  error?: string;
}

/** The plain value of a test's expected side (a parsed literal or identifier node, or a value already evaluated). */
export function blockTestExpectedValue(expected: unknown): unknown {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const node = expected as { value?: unknown; name?: unknown; kind?: unknown; elements?: unknown };
    if (node.kind === 'ArrayLiteral' && Array.isArray(node.elements)) return node.elements.map(blockTestExpectedValue);
    if (Object.prototype.hasOwnProperty.call(node, 'value')) return node.value;
    if (Object.prototype.hasOwnProperty.call(node, 'name')) return node.name;
  }
  return expected;
}

export function formatBlockTestExpected(expected: unknown): string {
  const value = blockTestExpectedValue(expected);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => formatBlockTestExpected(item)).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function blockTestAssertionName(test: BlockTestAssertionInput): string {
  return `assert ${test.field} ${test.operator} ${formatBlockTestExpected(test.expected)}`;
}

export function evaluateBlockTestAssertion(
  test: BlockTestAssertionInput,
  result: { rows: Array<Record<string, unknown>>; columns: string[] },
): BlockTestAssertionOutcome {
  const expected = blockTestExpectedValue(test.expected);
  const operator = test.operator === '=' ? '==' : test.operator.toUpperCase() === 'IN' ? 'IN' : test.operator;
  if (operator === 'IN' && !Array.isArray(expected)) {
    return { passed: false, error: `IN needs a list of values, like ${test.field} IN ["a", "b"]` };
  }
  if (test.field === 'row_count') {
    const actual = result.rows.length;
    const passed = compareBlockTestValue(actual, operator, expected);
    return passed
      ? { passed, actual }
      : { passed, actual, error: `${actual} ${operator} ${formatBlockTestExpected(expected)} is false` };
  }
  if (!result.columns.includes(test.field)) {
    return { passed: false, error: `Column '${test.field}' not found in results` };
  }
  for (let index = 0; index < result.rows.length; index += 1) {
    const actual = result.rows[index]?.[test.field];
    if (compareBlockTestValue(actual, operator, expected)) continue;
    const failing = result.rows.slice(index).filter((row) => !compareBlockTestValue(row?.[test.field], operator, expected)).length;
    return {
      passed: false,
      actual,
      error: `${failing} of ${result.rows.length} rows fail: row ${index + 1} has ${test.field} = ${formatValue(actual)}, and ${formatValue(actual)} ${operator} ${formatBlockTestExpected(expected)} is false`,
    };
  }
  return { passed: true, actual: result.rows[0]?.[test.field] };
}

function compareBlockTestValue(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case '==': return sameValue(actual, expected);
    case '!=': return !sameValue(actual, expected);
    case 'IN': return Array.isArray(expected) && expected.some((candidate) => sameValue(actual, candidate));
    case '>': case '>=': case '<': case '<=': {
      const a = numberValue(actual);
      const e = numberValue(expected);
      if (a === null || e === null) return false;
      if (operator === '>') return a > e;
      if (operator === '>=') return a >= e;
      if (operator === '<') return a < e;
      return a <= e;
    }
    default: return false;
  }
}

function sameValue(actual: unknown, expected: unknown): boolean {
  const a = numberValue(actual);
  const e = numberValue(expected);
  if (a !== null && e !== null) return a === e;
  return String(actual ?? 'null') === String(expected ?? 'null');
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
