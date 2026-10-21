/**
 * The one date rule for App page filters. Every tile type uses it: Dataset
 * fields, Metrics (semantic) tiles, Saved query (block) tiles and App draft
 * tiles.
 *
 * - A date range is start-inclusive and end-exclusive at the day AFTER the
 *   chosen end date: `>= start AND < end + 1 day`. Picking 1–31 March keeps
 *   every row on 31 March, including timestamps late in the day.
 * - A single date is that whole day: `>= day AND < day + 1`, so it matches a
 *   timestamp column too (an `=` would only match midnight).
 * - A relative date (`last_7_days`, `month_to_date`, …) resolves to a calendar
 *   range first, with "today" taken in the filter's timezone (UTC when none).
 * - A timestamp column turns calendar boundaries into instants in the filter's
 *   timezone. ZLens only does this where it knows the column is a timestamp
 *   (Dataset fields); elsewhere the calendar dates are compared as written and
 *   the warehouse reads them in its own session timezone.
 * - Block parameters for ranges (`<name>_start` / `<name>_end`) receive the
 *   chosen calendar dates as-is: the `_end` parameter is the INCLUSIVE last
 *   day, because that is what a hand-written `BETWEEN :start AND :end` on a
 *   DATE column expects. Only generated WHERE clauses use the exclusive
 *   next-day bound.
 *
 * Browser-safe: no Node imports.
 */

/** Calendar boundaries of one resolved date filter. */
export interface DashboardDateFilterBounds {
  /** First day, inclusive (YYYY-MM-DD). */
  startDate: string;
  /** Last chosen day, inclusive (YYYY-MM-DD). This is what `_end` parameters receive. */
  endDate: string;
  /** The day after `endDate` (YYYY-MM-DD). Generated WHERE clauses use `< endExclusiveDate`. */
  endExclusiveDate: string;
}

export type DashboardDateFilterResolution =
  /** Calendar dates: apply `>= startDate` and `< endExclusiveDate`. */
  | { kind: 'calendar'; bounds: DashboardDateFilterBounds }
  /**
   * Explicit, non-calendar boundaries (full timestamps, or numbers such as
   * seasons). They are already precise, so they stay an inclusive BETWEEN
   * rather than guessing an extra day.
   */
  | { kind: 'explicit'; start: unknown; end: unknown }
  | { kind: 'error'; message: string };

export type DashboardDateFilterType = 'date' | 'daterange' | 'relative_date';

/** Filter types the date rule owns. */
export function isDashboardDateFilterType(type: string | undefined): type is DashboardDateFilterType {
  return type === 'date' || type === 'daterange' || type === 'relative_date';
}

/**
 * Resolve a date filter's value to boundaries. Returns `null` for an empty
 * value (nothing to apply) or a filter type the date rule does not own.
 */
export function resolveDashboardDateFilter(input: {
  filterId: string;
  type: string | undefined;
  value: unknown;
  timezone?: string;
  /** Reference instant for relative dates; the caller's clock by default. */
  now?: Date;
}): DashboardDateFilterResolution | null {
  if (!isDashboardDateFilterType(input.type) || isEmptyDateValue(input.value)) return null;
  const label = input.filterId;
  if (input.type === 'relative_date') {
    const values = Array.isArray(input.value) ? input.value : [input.value];
    if (values.length !== 1 || typeof values[0] !== 'string') {
      return { kind: 'error', message: `${label} requires one relative date such as last_30_days.` };
    }
    let today: string;
    try {
      today = calendarDateInTimezone(input.now ?? new Date(), input.timezone ?? 'UTC');
    } catch {
      return { kind: 'error', message: `${label} declares an unknown timezone ${input.timezone}.` };
    }
    const range = resolveRelativeDateRange(values[0], today);
    if (!range) {
      return { kind: 'error', message: `${label} uses an unknown relative date ${values[0]}. Use last_N_days, today, yesterday, month_to_date, quarter_to_date, or year_to_date.` };
    }
    return { kind: 'calendar', bounds: calendarBounds(range.start, range.end) };
  }
  if (input.type === 'date') {
    const single = Array.isArray(input.value) ? input.value : [input.value];
    if (single.length !== 1) return { kind: 'error', message: `${label} requires one date.` };
    const day = calendarDatePart(single[0]);
    if (!day) return { kind: 'error', message: `${label} requires an ISO date such as 2026-03-31.` };
    return { kind: 'calendar', bounds: calendarBounds(day, day) };
  }
  const range = dateRangeParts(input.value);
  if (!range) return { kind: 'error', message: `${label} requires exactly two values for a range.` };
  if (typeof range.start === 'string' && typeof range.end === 'string'
    && isCalendarDate(range.start) && isCalendarDate(range.end)) {
    if (range.start > range.end) return { kind: 'error', message: `${label} starts after it ends.` };
    return { kind: 'calendar', bounds: calendarBounds(range.start, range.end) };
  }
  return { kind: 'explicit', start: range.start, end: range.end };
}

/**
 * The two boundaries a generated WHERE clause compares a column with:
 * `column >= start AND column < endExclusive`.
 *
 * - `date` / `unknown` columns compare calendar dates.
 * - `timestamp` columns compare instants at local midnight in `timezone`.
 *   A timestamp column needs a declared timezone: guessing one would shift
 *   the day boundary silently.
 */
export function dashboardDateBoundsForColumn(
  bounds: DashboardDateFilterBounds,
  column: 'date' | 'timestamp' | 'unknown',
  timezone?: string,
): { start: string; endExclusive: string } | { error: string } {
  if (column !== 'timestamp') return { start: bounds.startDate, endExclusive: bounds.endExclusiveDate };
  if (!timezone) return { error: 'requires a declared IANA timezone before it can bound timestamp values.' };
  try {
    return {
      start: calendarDateBoundaryInTimezone(bounds.startDate, timezone),
      endExclusive: calendarDateBoundaryInTimezone(bounds.endExclusiveDate, timezone),
    };
  } catch {
    return { error: `declares an unknown timezone ${timezone}.` };
  }
}

/** `{start, end}`, `{from, to}`, `{min, max}` or a two-item array. */
export function dateRangeParts(value: unknown): { start: unknown; end: unknown } | null {
  if (Array.isArray(value)) {
    if (value.length !== 2 || isEmptyDateValue(value[0]) || isEmptyDateValue(value[1])) return null;
    return { start: value[0], end: value[1] };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const start = record.start ?? record.from ?? record.min;
    const end = record.end ?? record.to ?? record.max;
    if (!isEmptyDateValue(start) && !isEmptyDateValue(end)) return { start, end };
  }
  return null;
}

function calendarBounds(startDate: string, endDate: string): DashboardDateFilterBounds {
  return { startDate, endDate, endExclusiveDate: nextCalendarDate(endDate) };
}

/** `2026-03-31` or the date part of `2026-03-31T10:00:00Z`; otherwise null. */
function calendarDatePart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.trim().slice(0, 10);
  return isCalendarDate(day) && (value.trim().length === 10 || /^[T ]/.test(value.trim().slice(10))) ? day : null;
}

function isEmptyDateValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

/**
 * Resolve a relative-date preset to an inclusive calendar range. `today` is
 * the calendar date in the filter's timezone. `last_N_days` includes today:
 * last_7_days is today and the six days before it.
 */
export function resolveRelativeDateRange(preset: string, today: string): { start: string; end: string } | undefined {
  const [year, month, day] = today.split('-').map(Number);
  const shift = (days: number) => new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  const lastDays = /^last_(\d{1,4})_days$/.exec(preset);
  if (lastDays) {
    const count = Number(lastDays[1]);
    if (count < 1 || count > 3660) return undefined;
    return { start: shift(-(count - 1)), end: today };
  }
  if (preset === 'today') return { start: today, end: today };
  if (preset === 'yesterday') return { start: shift(-1), end: shift(-1) };
  if (preset === 'month_to_date') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (preset === 'quarter_to_date') {
    const quarterMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
    return { start: `${today.slice(0, 4)}-${quarterMonth}-01`, end: today };
  }
  if (preset === 'year_to_date') return { start: `${today.slice(0, 4)}-01-01`, end: today };
  return undefined;
}

/** The calendar date an instant falls on in `timezone`. */
export function calendarDateInTimezone(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function nextCalendarDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Convert a local calendar midnight in `timezone` to a UTC timestamp without
 * treating a daylight-saving day as a fixed 24-hour duration.
 */
export function calendarDateBoundaryInTimezone(date: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const requested = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = requested;
  // One correction resolves ordinary offsets; a second resolves a DST
  // transition at local midnight without assuming a 24-hour calendar day.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += requested - observed;
  }
  return new Date(instant).toISOString();
}
