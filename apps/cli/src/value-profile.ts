/**
 * THE VALUE PROFILE: what the warehouse's columns actually hold.
 *
 * A column list says `order_moment_delivered TEXT`; it does not say the text
 * reads `12/31/2021 11:45 PM`, that an id is padded with a space, or that a
 * status is spelled `delivered` and not `Delivered`. A drafter that cannot see
 * the stored values guesses them, and a query that parses no date or matches
 * no key runs and returns a wrong number. A few example values per column, and
 * the range of each number, are what an analyst reads before writing SQL.
 *
 * Those values leave the machine with the drafting prompt, so the profile is
 * opt-in: `agent.valueProfile.mode: "sampled"` in dql.config.json. Off (the
 * default) means no value is read and any profile read earlier is removed.
 *
 * What it never does:
 * - read a column whose name says it holds contact details, credentials,
 *   identity documents, accounts, personal names or pay, or a name column of a
 *   table of people (customers, users, employees…); a project can exclude more;
 * - keep a sampled value that itself looks like an email address, a phone or
 *   social security number, a URL or a credential, whatever the column is called;
 * - run, or reach a prompt, under an RFC 0010 host: a host's row policies,
 *   column visibility and person credentials decide what each reader may see,
 *   and a profile read once by the syncing connection would show every reader
 *   the same values;
 * - reach git: it is a cache (`.dql/cache/value-profile.json`), rebuilt at
 *   every schema sync and ignored when it describes another catalog.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDialect, type WarehouseCatalogSnapshotV1 } from '@zlens/core';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';

export const VALUE_PROFILE_PATH = join('.dql', 'cache', 'value-profile.json');

export interface ColumnValueProfile {
  /** The most frequent stored values, as text, at most three. */
  examples?: string[];
  min?: string;
  max?: string;
}

export interface ValueProfileV1 {
  version: 1;
  /** The catalog this profile describes: a profile of another catalog is not used. */
  catalogFingerprint: string;
  capturedAt: string;
  /** By relation as the catalog spells it, then by column name. */
  relations: Record<string, Record<string, ColumnValueProfile>>;
  /** Columns left out because their names mark them sensitive. */
  skippedSensitive: number;
  /**
   * Text columns whose sampled values could identify someone: no value shared
   * by enough rows, or too many distinct values with letters in them. None of
   * their values was kept. Absent in profiles written before it.
   */
  skippedIdentifying?: number;
}

export interface ValueProfilePolicy {
  mode: 'off' | 'sampled';
  /** More column-name patterns to leave out, as case-insensitive regular expressions. */
  exclude: RegExp[];
  /**
   * When set, only columns matching one of these are read: the safe choice on
   * a warehouse whose column names don't say what they hold. Matched against
   * the column name and against `table.column`.
   */
  include: RegExp[];
}

/** What a sync reports about the profile: what was read, why nothing was, or the error. */
export type ValueProfileSummary =
  | { relations: number; columns: number; skippedSensitive: number; skippedIdentifying: number }
  | { skipped: string }
  | { error: string };

/**
 * Column names that hold contact details, credentials, identity documents,
 * financial accounts, personal names or pay. Their values are never read,
 * whatever the project says.
 */
const SENSITIVE_COLUMN = /(e_?mail|phone|mobile|fax|ssn|social_?security|national_?id|passport|licen[cs]e_?(no|num)|password|passwd|secret|token|api_?key|credential|credit_?card|card_?(no|num)|cvv|iban|account_?(no|num)|routing|street|address|postal|zip_?code|birth|dob\b|ip_?addr|salary|wage|tax_?id|user_?name|login|(first|last|middle|given|family|full|maiden)_?name|surname)/i;

/** A stored value that is itself personal data or a secret, whatever its column is called. */
const SENSITIVE_VALUE = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Phone numbers, without taking a date (2021-12-31) or a plain number for one.
  /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
  /\+\d[\d\s().-]{8,}\d/,
  /(?:https?|ftp):\/\/|\bwww\./i,
  /\bbearer\s+[a-z0-9._~+/-]{8,}/i,
  /\b(?:sk|pk|rk)_[a-z0-9_-]{8,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const EXAMPLE_CHARS = 40;
const MAX_COLUMNS_PER_RELATION = 80;
const SAMPLE_ROWS = 50_000;
/**
 * A value is kept only when this many sampled rows share it. Names, emails,
 * addresses and free text are close to one value per row, so they never
 * qualify, whatever their column is called; a status or a category does.
 */
export const MIN_SHARED_ROWS = 3;
/**
 * A column with more distinct values than this, or whose values don't repeat
 * on average, is not a list of categories. Its examples are kept only when
 * they hold no letters (dates, times, codes of digits): names, places and free
 * text have letters, and a name repeated on many rows (a person recorded on
 * each invoice, or each version of a customer in an archive) is still a name.
 */
export const MAX_CATEGORY_VALUES = 50;
const MONTHS_AND_MARKERS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|mon|tue|wed|thu|fri|sat|sun|am|pm|utc|gmt)\b|(?<=\d)[tz](?=\d|$)/gi;

/** Whether a value holds no letters but those a date or time is written with. */
export function letterFree(value: string): boolean {
  return !/\p{L}/u.test(value.replace(MONTHS_AND_MARKERS, ''));
}

/** A range is kept to two significant figures: the scale, not one row's exact value. */
const RANGE_FIGURES = 2;

function patterns(values: unknown): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of Array.isArray(values) ? values : []) {
    try { out.push(new RegExp(String(pattern), 'i')); } catch { /* an invalid pattern matches nothing */ }
  }
  return out;
}

export function resolveValueProfilePolicy(config: { agent?: { valueProfile?: { mode?: string; exclude?: string[]; include?: string[] } } } | undefined): ValueProfilePolicy {
  const configured = config?.agent?.valueProfile;
  return { mode: configured?.mode === 'sampled' ? 'sampled' : 'off', exclude: patterns(configured?.exclude), include: patterns(configured?.include) };
}

/** Whether `include` lets this column be read: no list means every column a name rule doesn't stop. */
export function includedColumn(column: string, policy: Pick<ValueProfilePolicy, 'include'>, relation?: string): boolean {
  if (!policy.include.length) return true;
  const table = relation?.split('.').pop()?.replace(/^"|"$/g, '') ?? '';
  return policy.include.some((pattern) => pattern.test(column) || (table !== '' && pattern.test(`${table}.${column}`)));
}

/** A number rounded to two significant figures, as text: 171233410.25 -> 170000000, 0.987 -> 0.99. */
export function roundedRange(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return value;
  return String(Number(number.toPrecision(RANGE_FIGURES)));
}

/** Tables of people: a name column there is a person's name. */
const PEOPLE_RELATION = /(customer|user|employee|person|people|patient|member|contact|client|student|staff|driver|subscriber|player|guest|applicant|insured|holder)s?$/i;

export function isSensitiveColumn(column: string, policy: Pick<ValueProfilePolicy, 'exclude'>, relation?: string): boolean {
  if (SENSITIVE_COLUMN.test(column) || policy.exclude.some((pattern) => pattern.test(column))) return true;
  const table = relation?.split('.').pop()?.replace(/^"|"$/g, '') ?? '';
  return /name/i.test(column) && PEOPLE_RELATION.test(table);
}

export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE.some((pattern) => pattern.test(value));
}

const NUMERIC_TYPE = /\b(int|integer|bigint|smallint|tinyint|hugeint|real|float|double|numeric|decimal|number)\b/i;

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const rendered = value instanceof Date ? value.toISOString() : String(value);
  return rendered.length > EXAMPLE_CHARS ? `${rendered.slice(0, EXAMPLE_CHARS - 1)}…` : rendered;
}

/**
 * Read the profile of every catalog relation: one MIN/MAX query per relation
 * for its numeric columns, and one most-frequent-values query per other
 * column, each over a bounded sample of rows. Stops at the time budget and
 * keeps what it read.
 */
export async function profileWarehouseValues(input: {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  snapshot: WarehouseCatalogSnapshotV1;
  policy: ValueProfilePolicy;
  budgetMs?: number;
  now?: () => number;
}): Promise<ValueProfileV1> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? 120_000);
  const dialect = getDialect(input.connection.driver);
  const quote = (name: string) => dialect.quoteIdentifier(name);
  const options = { maxRows: 5, maxBytes: 1024 * 1024, deadlineMs: 10_000 };
  const relations: ValueProfileV1['relations'] = {};
  let skippedSensitive = 0;
  let skippedIdentifying = 0;
  const run = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    try {
      const result = await input.executor.executePositional(sql, [], input.connection, options);
      return (result.rows ?? []) as Array<Record<string, unknown>>;
    } catch {
      // A column the engine cannot group or compare is left without a profile.
      return [];
    }
  };
  for (const relation of input.snapshot.relations) {
    if (now() > deadline) break;
    const table = relation.relation.split('.').map((part) => quote(part.replace(/^"|"$/g, ''))).join('.');
    const columns = relation.columns.slice(0, MAX_COLUMNS_PER_RELATION).filter((column) => {
      if (!includedColumn(column.name, input.policy, relation.relation)) return false;
      if (!isSensitiveColumn(column.name, input.policy, relation.relation)) return true;
      skippedSensitive += 1;
      return false;
    });
    const profile: Record<string, ColumnValueProfile> = {};
    const numeric = columns.filter((column) => NUMERIC_TYPE.test(column.type ?? ''));
    if (numeric.length) {
      const select = numeric.flatMap((column, index) => [`MIN(${quote(column.name)}) AS ${quote(`min_${index}`)}`, `MAX(${quote(column.name)}) AS ${quote(`max_${index}`)}`]).join(', ');
      const [row] = await run(`SELECT ${select} FROM (SELECT * FROM ${table} ${dialect.limitClause(SAMPLE_ROWS)}) AS sampled`);
      numeric.forEach((column, index) => {
        const min = roundedRange(text(row?.[`min_${index}`]));
        const max = roundedRange(text(row?.[`max_${index}`]));
        if (min !== undefined || max !== undefined) profile[column.name] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      });
    }
    for (const column of columns) {
      if (numeric.includes(column)) continue;
      if (now() > deadline) break;
      const name = quote(column.name);
      // The three most frequent values, and how many distinct values the sample holds.
      const rows = await run(`SELECT ${quote('value')}, ${quote('n')}, COUNT(*) OVER () AS ${quote('d')}, SUM(${quote('n')}) OVER () AS ${quote('t')} FROM (SELECT ${name} AS ${quote('value')}, COUNT(*) AS ${quote('n')} FROM (SELECT ${name} FROM ${table} ${dialect.limitClause(SAMPLE_ROWS)}) AS sampled WHERE ${name} IS NOT NULL GROUP BY ${name}) AS grouped ORDER BY ${quote('n')} DESC ${dialect.limitClause(3)}`);
      const distinct = Number(rows[0]?.d ?? rows[0]?.D ?? 0);
      const total = Number(rows[0]?.t ?? rows[0]?.T ?? 0);
      // A category repeats: few distinct values, each on two rows or more on average.
      const category = distinct <= MAX_CATEGORY_VALUES && distinct * 2 <= total;
      // Only values enough rows share: what one row holds alone is that row's, not the column's.
      const values = rows
        .filter((row) => Number(row.n ?? row.N) >= MIN_SHARED_ROWS)
        .map((row) => text(row.value ?? row.VALUE))
        .filter((value): value is string => value !== undefined && !isSensitiveValue(value));
      const examples = category || values.every(letterFree) ? values : [];
      // Counted as identifying unless a value pattern (an email, a key) is what emptied it.
      if (rows.length > 0 && examples.length === 0 && !rows.some((row) => isSensitiveValue(text(row.value ?? row.VALUE) ?? ''))) skippedIdentifying += 1;
      if (examples.length) profile[column.name] = { examples };
    }
    if (Object.keys(profile).length) relations[relation.relation] = profile;
  }
  return { version: 1, catalogFingerprint: input.snapshot.fingerprint ?? '', capturedAt: new Date(now()).toISOString(), relations, skippedSensitive, skippedIdentifying };
}

export function writeValueProfile(projectRoot: string, profile: ValueProfileV1): string {
  const path = join(projectRoot, VALUE_PROFILE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  return path;
}

/** Remove the profile: the project switched it off, so no stored value reaches a prompt again. */
export function removeValueProfile(projectRoot: string): void {
  rmSync(join(projectRoot, VALUE_PROFILE_PATH), { force: true });
}

/** The profile of this catalog, or nothing: a profile of an older catalog is not evidence. */
export function readValueProfile(projectRoot: string, catalogFingerprint: string | undefined): ValueProfileV1 | undefined {
  const path = join(projectRoot, VALUE_PROFILE_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const profile = JSON.parse(readFileSync(path, 'utf-8')) as ValueProfileV1;
    if (profile?.version !== 1 || !profile.relations) return undefined;
    if (!catalogFingerprint || profile.catalogFingerprint !== catalogFingerprint) return undefined;
    return profile;
  } catch {
    return undefined;
  }
}

/**
 * The value profile step of a warehouse-first schema sync. Opted in and not
 * under a host: read and written. Otherwise: no value is read, and a profile
 * read earlier is removed so it cannot keep reaching prompts. A profile that
 * fails leaves the catalog sync standing.
 */
export async function refreshValueProfile(input: {
  projectRoot: string;
  config: Parameters<typeof resolveValueProfilePolicy>[0];
  executor: QueryExecutor;
  connection: ConnectionConfig;
  snapshot: WarehouseCatalogSnapshotV1;
  /** An RFC 0010 host serves this runtime: values are never profiled. */
  hosted: boolean;
}): Promise<ValueProfileSummary | undefined> {
  const policy = resolveValueProfilePolicy(input.config);
  if (policy.mode !== 'sampled') {
    removeValueProfile(input.projectRoot);
    return undefined;
  }
  if (input.hosted) {
    removeValueProfile(input.projectRoot);
    return { skipped: 'a host serves this runtime, so what each reader may see is the host\'s to decide; no column values were read' };
  }
  try {
    const profile = await profileWarehouseValues({ executor: input.executor, connection: input.connection, snapshot: input.snapshot, policy });
    writeValueProfile(input.projectRoot, profile);
    return {
      relations: Object.keys(profile.relations).length,
      columns: Object.values(profile.relations).reduce((total, columns) => total + Object.keys(columns).length, 0),
      skippedSensitive: profile.skippedSensitive,
      skippedIdentifying: profile.skippedIdentifying ?? 0,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a profile on disk may reach Ask's drafter now: the project opts in
 * (read at each run, so switching it off takes effect at once) and no host
 * serves the runtime, since a host's policies decide what each reader may see.
 */
export function valueProfileAllowed(config: Parameters<typeof resolveValueProfilePolicy>[0], hosted: boolean): boolean {
  return !hosted && resolveValueProfilePolicy(config).mode === 'sampled';
}

/** One column's profile as prompt text: ` holds 'a', 'b', 'c'` or ` ranges 1 to 8000`. */
export function renderColumnProfile(profile: ColumnValueProfile | undefined): string {
  if (!profile) return '';
  if (profile.examples?.length) return ` holds ${profile.examples.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')}`;
  if (profile.min !== undefined || profile.max !== undefined) return ` ranges ${profile.min ?? '?'} to ${profile.max ?? '?'}`;
  return '';
}
