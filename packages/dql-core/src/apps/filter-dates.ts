/**
 * The one date rule for App page filters. Every tile type uses it: Dataset
 * fields, Metrics (semantic) tiles, Saved query (block) tiles and App draft
 * tiles.
 *
 * - A date range is start-inclusive and end-exclusive at the day AFTER the
 *   chosen end date: `>= start AND < end + 1 day`. Picking 1–31 March keeps
 *   every row on 31 March, including timestamps late in the day.
 * - A one-sided range is open on the other side: only a start means "from
 *   that day" (`>= start`), only an end means "until that day" (`< end + 1`).
 * - A single date is that whole day: `>= day AND < day + 1`, so it matches a
 *   timestamp column too (an `=` would only match midnight).
 * - A relative date (`last_7_days`, `month_to_date`, …) resolves to a calendar
 *   range first, with "today" taken in the filter's timezone (UTC when none).
 * - Calendar boundaries are compared as calendar dates on every column type,
 *   timestamps included: `ordered_at < '2025-07-01'` keeps 23:30 on 30 June
 *   and drops 00:30 on 1 July. That is the same calendar the time buckets use
 *   (`DATE_TRUNC('month', ordered_at)` groups by the column's own clock), so a
 *   range ending 30 June never puts a row into a July bucket. Turning the
 *   boundary into an instant in the filter's timezone would compare a
 *   different calendar from the buckets' (B5). The filter's timezone only
 *   decides what "today" is for a relative date.
 * - Block parameters for ranges (`<name>_start` / `<name>_end`) receive the
 *   chosen calendar dates as-is: the `_end` parameter is the INCLUSIVE last
 *   day, because that is what a hand-written `BETWEEN :start AND :end` on a
 *   DATE column expects. An open side receives the earliest or latest date
 *   (`0001-01-01` / `9999-12-31`). Only generated WHERE clauses use the
 *   exclusive next-day bound.
 *
 * Browser-safe: no Node imports.
 */

/**
 * Calendar boundaries of one resolved date filter. At least one side is
 * present; a missing side is open ("from" / "until").
 */
export interface DashboardDateFilterBounds {
  /** First day, inclusive (YYYY-MM-DD). Absent for an "until" range. */
  startDate?: string;
  /** Last chosen day, inclusive (YYYY-MM-DD). This is what `_end` parameters receive. Absent for a "from" range. */
  endDate?: string;
  /** The day after `endDate` (YYYY-MM-DD). Generated WHERE clauses use `< endExclusiveDate`. */
  endExclusiveDate?: string;
}

export type DashboardDateFilterResolution =
  /** Calendar dates: apply `>= startDate` and `< endExclusiveDate` (each when present). */
  | { kind: 'calendar'; bounds: DashboardDateFilterBounds }
  /**
   * Explicit, non-calendar boundaries (full timestamps, or numbers such as
   * seasons). They are already precise, so they stay an inclusive BETWEEN
   * (or `>=` / `<=` when one side is open) rather than guessing an extra day.
   */
  | { kind: 'explicit'; start?: unknown; end?: unknown }
  | { kind: 'error'; message: string };

/** What an open start of a range parameter receives (`<name>_start`). */
export const DASHBOARD_DATE_OPEN_START = '0001-01-01';
/** What an open end of a range parameter receives (`<name>_end`). */
export const DASHBOARD_DATE_OPEN_END = '9999-12-31';

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
  if (!isDashboardDateFilterType(input.type) || isEmptyDashboardDateValue(input.value)) return null;
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
  const range = dateRangeEnds(input.value);
  if (!range) return { kind: 'error', message: `${label} requires a start date, an end date, or both.` };
  const present = [range.start, range.end].filter((end) => end !== undefined);
  if (present.every((end) => typeof end === 'string' && isCalendarDate(end))) {
    const start = range.start as string | undefined;
    const end = range.end as string | undefined;
    if (start && end && start > end) return { kind: 'error', message: `${label} starts after it ends.` };
    return { kind: 'calendar', bounds: calendarBounds(start, end) };
  }
  return { kind: 'explicit', ...(range.start !== undefined ? { start: range.start } : {}), ...(range.end !== undefined ? { end: range.end } : {}) };
}

/**
 * The comparisons a generated WHERE clause needs for one resolved calendar
 * date filter: `column >= start` and `column < endExclusive`, each only when
 * that side is present.
 *
 * Every column type compares calendar dates, timestamps included, so the
 * filter uses the same calendar as the time buckets (see the header). The
 * column kind is kept in the signature for callers that cast the bound.
 */
export function dashboardDateBoundsForColumn(
  bounds: DashboardDateFilterBounds,
  _column?: 'date' | 'timestamp' | 'unknown',
): { start?: string; endExclusive?: string } {
  return {
    ...(bounds.startDate ? { start: bounds.startDate } : {}),
    ...(bounds.endExclusiveDate ? { endExclusive: bounds.endExclusiveDate } : {}),
  };
}

/**
 * The two ends of a range value, either of which may be open: `{start, end}`,
 * `{from, to}`, `{min, max}` or a two-item array. `null` when the shape is not
 * a range or both ends are empty.
 */
export function dateRangeEnds(value: unknown): { start?: unknown; end?: unknown } | null {
  let start: unknown;
  let end: unknown;
  if (Array.isArray(value)) {
    if (value.length !== 2) return null;
    [start, end] = value;
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    start = record.start ?? record.from ?? record.min;
    end = record.end ?? record.to ?? record.max;
  } else {
    return null;
  }
  const ends = {
    ...(!isEmptyDateValue(start) ? { start } : {}),
    ...(!isEmptyDateValue(end) ? { end } : {}),
  };
  return Object.keys(ends).length ? ends : null;
}

/**
 * True when a date filter value has nothing to apply: empty, an empty list,
 * or a range whose start and end are both empty. A one-sided range is not
 * empty: it means "from" or "until".
 */
export function isEmptyDashboardDateValue(value: unknown): boolean {
  if (isEmptyDateValue(value)) return true;
  if (Array.isArray(value)) return value.every(isEmptyDateValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const rangeKeys = ['start', 'end', 'from', 'to', 'min', 'max'];
    return keys.every((key) => rangeKeys.includes(key)) && keys.every((key) => isEmptyDateValue(record[key]));
  }
  return false;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2025-03-01` reads "1 Mar 2025". Anything else is returned as written. */
export function formatDashboardCalendarDate(value: string): string {
  if (!isCalendarDate(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * How a date range control describes its value: "From 1 Mar 2025",
 * "Until 30 Jun 2025", "1 Mar 2025 – 30 Jun 2025", or `null` when empty.
 */
export function describeDashboardDateRange(value: unknown): string | null {
  const range = dateRangeEnds(value);
  if (!range) return null;
  const start = typeof range.start === 'string' ? formatDashboardCalendarDate(range.start.slice(0, 10)) : range.start === undefined ? undefined : String(range.start);
  const end = typeof range.end === 'string' ? formatDashboardCalendarDate(range.end.slice(0, 10)) : range.end === undefined ? undefined : String(range.end);
  if (start && end) return `${start} – ${end}`;
  return start ? `From ${start}` : `Until ${end}`;
}

/** Both ends of a closed range: `{start, end}`, `{from, to}`, `{min, max}` or a two-item array. */
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

function calendarBounds(startDate: string | undefined, endDate: string | undefined): DashboardDateFilterBounds {
  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate, endExclusiveDate: nextCalendarDate(endDate) } : {}),
  };
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

/**
 * The quick choices of a date range control (new-user round 3, problem 9),
 * as every Tableau and Power BI user expects them. Each fills the range with
 * calendar dates ending today, in the filter's timezone.
 */
export const DATE_RANGE_PRESETS = [
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'month_to_date', label: 'This month' },
  { id: 'quarter_to_date', label: 'This quarter' },
  { id: 'year_to_date', label: 'This year' },
] as const;

export type DateRangePresetId = typeof DATE_RANGE_PRESETS[number]['id'];

/** The range a preset stands for today: `{ start, end }`, both inclusive calendar dates. */
export function dateRangePresetValue(preset: string, today: string): { start: string; end: string } | undefined {
  if (!DATE_RANGE_PRESETS.some((entry) => entry.id === preset) || !isCalendarDate(today)) return undefined;
  return resolveRelativeDateRange(preset, today);
}

/**
 * Which quick choice a range is today: a preset id, `custom` for any other
 * range, or `''` when nothing is chosen.
 */
export function matchingDateRangePreset(value: unknown, today: string): DateRangePresetId | 'custom' | '' {
  const ends = value && typeof value === 'object' && !Array.isArray(value) ? value as { start?: unknown; end?: unknown } : {};
  const start = typeof ends.start === 'string' ? ends.start.trim() : '';
  const end = typeof ends.end === 'string' ? ends.end.trim() : '';
  if (!start && !end) return '';
  const match = DATE_RANGE_PRESETS.find((preset) => {
    const range = dateRangePresetValue(preset.id, today);
    return range && range.start === start && range.end === end;
  });
  return match?.id ?? 'custom';
}

/** Today's calendar date in a filter's timezone, else in the reader's own. */
export function todayForDateFilter(timezone: string | undefined, now: Date = new Date()): string {
  try {
    return calendarDateInTimezone(now, timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
