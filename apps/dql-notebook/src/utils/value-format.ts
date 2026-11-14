import { formatYearValue, isYearLikeColumn } from '@zlens/core/apps/year-values';

export { formatYearValue, isYearLikeColumn };

export type DisplayValueKind =
  | 'currency'
  | 'percent'
  | 'integer'
  | 'number'
  | 'year'
  | 'month'
  | 'date'
  | 'boolean'
  | 'json'
  | 'text';

const CURRENCY_NAME_RE = /(?:^|_)(?:revenue|sales|spend|amount|price|cost|profit|margin|income|expense|balance|budget|bookings|arr|mrr|gmv|fee|fees|charge|charges|tax|value)(?:_|$)/i;
const PERCENT_NAME_RE = /(?:^|_)(?:percent|percentage|pct|ratio|share|conversion|churn|retention|utilization)(?:_|$)/i;
const INTEGER_NAME_RE = /(?:^|_)(?:count|orders?|customers?|accounts?|users?|products?|items?|units?|quantity|rank|position|days?|months?|years?|distinct)(?:_|$)/i;
const AVERAGE_NAME_RE = /(?:^|_)(?:average|avg|mean)(?:_|$)/i;
const MONTH_NAME_RE = /(?:^|_)(?:month|monthly|month_num|month_number|month_of_year)$/i;
const DATE_NAME_RE = /(?:^|_)(?:date|day|month|quarter|year|time|timestamp|daily|weekly|monthly|quarterly|yearly|hourly)(?:_|$)|_(?:at|on)$/i;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z?$/;

/**
 * A column of identifiers by its name (GAME_ID, TEAM_ID, PLAYER_KEY, ZIP_CODE, playerId): its whole numbers are
 * codes, never quantities, so they show as stored ("22100330", not "22,100,330": new-user test V12).
 */
const IDENTIFIER_NAME_RE = /(?:^|_)(?:id|key|code|uuid)$/i;

export function isIdentifierColumn(column: string): boolean {
  const name = column.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_');
  // A count of ids ("COUNT(DISTINCT PLAYER_ID)", "player_id_count") is a quantity.
  if (/[()]/.test(name) || /(?:^|_)(?:count|total|sum|avg|average|num_of)(?:_|$)/i.test(name)) return false;
  return IDENTIFIER_NAME_RE.test(name);
}

/** A whole-number value of an identifier column, as stored; undefined for anything else. */
export function formatIdentifierValue(column: string, value: unknown): string | undefined {
  if (!isIdentifierColumn(column)) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return value.trim();
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function explicitKind(format?: string): DisplayValueKind | undefined {
  if (format === 'currency' || format === 'percent' || format === 'number') return format;
  if (format === 'duration') return 'number';
  return undefined;
}

/** Infer display semantics from the governed field name and sampled values. */
export function inferDisplayValueKind(column: string, values: unknown[] = [], format?: string): DisplayValueKind {
  const explicit = explicitKind(format);
  if (explicit) return explicit;
  if (MONTH_NAME_RE.test(column)) return 'month';
  if (isYearLikeColumn(column)) return 'year';
  if (DATE_NAME_RE.test(column)) return 'date';
  if (AVERAGE_NAME_RE.test(column) && CURRENCY_NAME_RE.test(column)) return 'currency';
  if (PERCENT_NAME_RE.test(column)) return 'percent';
  if (AVERAGE_NAME_RE.test(column)) return 'number';
  if (INTEGER_NAME_RE.test(column)) return 'integer';
  if (CURRENCY_NAME_RE.test(column)) return 'currency';

  const populated = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (populated.length === 0) return 'text';
  if (populated.every((value) => typeof value === 'boolean')) return 'boolean';
  if (populated.every((value) => numericValue(value) !== undefined)) return 'number';
  if (populated.every((value) => typeof value === 'string' && YEAR_MONTH_RE.test(value))) return 'month';
  if (populated.every((value) => typeof value === 'string' && (ISO_DATE_RE.test(value) || ISO_TIMESTAMP_RE.test(value) || TIME_ONLY_RE.test(value)))) return 'date';
  if (populated.every((value) => typeof value === 'object')) return 'json';
  return 'text';
}

function numberOptions(compact: boolean, integer = false): Intl.NumberFormatOptions {
  return compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : integer
      ? { maximumFractionDigits: 0 }
      : { maximumFractionDigits: 2 };
}

/** The units contract a result may carry per column; it wins over every name heuristic. */
export interface DisplayColumnMeta {
  kind: 'currency' | 'percent' | 'number' | 'count' | 'duration' | 'date' | 'text' | 'boolean';
  unit?: string;
  decimals?: number;
  grain?: string;
  /** Author's choice for this field: short numbers (1.2K). */
  notation?: 'compact';
  /** Author's choice for this field: exactly this many decimals. */
  fixedDecimals?: number;
}

function kindFromMeta(meta: DisplayColumnMeta): DisplayValueKind {
  switch (meta.kind) {
    case 'count': return 'integer';
    case 'date': return meta.grain === 'month' ? 'month' : meta.grain === 'year' ? 'year' : 'date';
    case 'duration': return 'number';
    default: return meta.kind;
  }
}

export function formatDisplayValue(
  column: string,
  value: unknown,
  values: unknown[] = [],
  options: { compact?: boolean; format?: string; meta?: DisplayColumnMeta } = {},
): string {
  if (value === null || value === undefined) return '';
  // A year is a year whatever the column's number format says, unless it is money or a share.
  if (options.meta?.kind !== 'currency' && options.meta?.kind !== 'percent' && options.format !== 'currency' && options.format !== 'percent') {
    const year = formatYearValue(column, value);
    if (year !== undefined) return year;
    // An identifier is a code: no thousands separator, no compact "22.1M".
    const identifier = formatIdentifierValue(column, value);
    if (identifier !== undefined) return identifier;
  }
  const numeric = numericValue(value);
  // Percentage points are a difference of percentages, never re-scaled.
  if (options.meta?.kind === 'percent' && options.meta.unit === 'percentage_points' && numeric !== undefined) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: options.meta.decimals ?? 1 }).format(numeric)} pp`;
  }
  const kind = options.meta ? kindFromMeta(options.meta) : inferDisplayValueKind(column, values, options.format);
  // A field's own format, set on the tile's shelves, wins over the view's.
  const compact = options.meta?.notation === 'compact' ? true : options.meta?.fixedDecimals !== undefined ? false : Boolean(options.compact);
  const fixed = options.meta?.fixedDecimals;

  if (kind === 'year') {
    const year = typeof value === 'string' && (ISO_DATE_RE.test(value) || ISO_TIMESTAMP_RE.test(value))
      ? Number(value.slice(0, 4))
      : numeric;
    if (year !== undefined && Number.isInteger(year)) {
      return new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 0 }).format(year);
    }
  }
  if (kind === 'month') {
    const formattedMonth = formatMonth(value);
    if (formattedMonth) return formattedMonth;
  }
  if (kind === 'date' && typeof value === 'string') {
    const formattedDate = formatDate(value);
    if (formattedDate) return formattedDate;
  }
  if (numeric !== undefined) {
    if (kind === 'currency') {
      // A Dataset measure owns its currency. Legacy results without a
      // governed unit retain the established USD fallback.
      const currency = options.meta?.unit && /^[A-Z]{3}$/.test(options.meta.unit) ? options.meta.unit : 'USD';
      const compactDigits = fixed ?? 1;
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        // Compact currency sets its minimum explicitly: Node 24's ICU changed
        // the implied minimum ($60 instead of $60.0). Keep the currency's own
        // digits, capped at the compact maximum, on every Node version.
        ...(compact
          ? { notation: 'compact', minimumFractionDigits: Math.min(currencyFractionDigits(currency), compactDigits), maximumFractionDigits: compactDigits }
          : { minimumFractionDigits: fixed ?? 2, maximumFractionDigits: fixed ?? 2 }),
      }).format(numeric);
    }
    if (kind === 'percent') {
      // A declared fraction is a fraction whatever its magnitude; only an undeclared value is guessed.
      const normalized = options.meta?.unit === 'fraction' ? numeric : Math.abs(numeric) <= 1 ? numeric : numeric / 100;
      return new Intl.NumberFormat('en-US', { style: 'percent', ...(fixed !== undefined ? { minimumFractionDigits: fixed } : {}), maximumFractionDigits: fixed ?? options.meta?.decimals ?? 2 }).format(normalized);
    }
    if (fixed !== undefined && !compact) return new Intl.NumberFormat('en-US', { minimumFractionDigits: fixed, maximumFractionDigits: fixed }).format(numeric);
    return new Intl.NumberFormat('en-US', numberOptions(compact, kind === 'integer')).format(numeric);
  }
  if (kind === 'boolean') return value ? 'Yes' : 'No';
  if (kind === 'json' || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function currencyFractionDigits(currency: string): number {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().minimumFractionDigits ?? 2;
}

export function formatChartValue(column: string, value: number, format?: string, meta?: DisplayColumnMeta): string {
  return formatDisplayValue(column, value, [value], { compact: true, format, ...(meta ? { meta } : {}) });
}

function formatMonth(value: unknown): string | undefined {
  const numeric = numericValue(value);
  if (numeric !== undefined && Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2000, numeric - 1, 1)));
  }
  if (typeof value !== 'string') return undefined;
  const yearMonth = YEAR_MONTH_RE.exec(value);
  const isoDate = ISO_DATE_RE.exec(value)
    ?? (ISO_TIMESTAMP_RE.test(value) ? ISO_DATE_RE.exec(value.slice(0, 10)) : null);
  const match = yearMonth ?? isoDate;
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatDate(value: string): string | undefined {
  const timeOnly = TIME_ONLY_RE.exec(value);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = Number(timeOnly[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2000, 0, 1, hour, minute, second)));
  }
  const dateOnly = ISO_DATE_RE.exec(value);
  if (dateOnly) {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))));
  }
  if (!ISO_TIMESTAMP_RE.test(value)) return undefined;
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(hasTimeZone ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  const midnightUtc = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(midnightUtc ? {} : { hour: 'numeric', minute: '2-digit' }),
    timeZone: 'UTC',
  }).format(date);
}
