/**
 * Years shown as years (V11: seasons read "2,014" in App tiles and tables, and in the Ask and notebook
 * result grids). A column whose name says it holds years (YEAR, FISCAL_YEAR, ORDER_YEAR, SEASON, FY) shows
 * its whole numbers in 1800–2200 with no thousands separator, on every surface that formats numbers.
 * Pure: no I/O.
 */

/** A column of years by its name; NBA seasons are named by their year. */
const YEAR_NAME_RE = /(?:^|_)(?:year|yr|season|fy)$|^(?:year|season)_(?:id|num|number|label|name|start)$/i;
/** "points per season" is a number of things, not a year. */
const PER_YEAR_NAME_RE = /(?:^|_)per_(?:year|yr|season)$/i;
const FIRST_YEAR = 1800;
const LAST_YEAR = 2200;

/** `fiscalYear`, `Fiscal Year` and `fiscal-year` all read as `fiscal_year`. */
function snakeColumnName(column: string): string {
  return column.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_');
}

/** Whether a column holds years, by its name. */
export function isYearLikeColumn(column: string): boolean {
  const name = snakeColumnName(column);
  return YEAR_NAME_RE.test(name) && !PER_YEAR_NAME_RE.test(name);
}

/** A whole number in the years people mean (1800–2200), else undefined. */
export function yearOf(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string' && /^\s*\d{4}\s*$/.test(value) ? Number(value) : undefined;
  return numeric !== undefined && Number.isInteger(numeric) && numeric >= FIRST_YEAR && numeric <= LAST_YEAR ? numeric : undefined;
}

/** A value of a year-like column as a year ("2014"), or undefined when the column or the value is not one. */
export function formatYearValue(column: string, value: unknown): string | undefined {
  if (!isYearLikeColumn(column)) return undefined;
  const year = yearOf(value);
  return year === undefined ? undefined : String(year);
}
