import type {
  ConnectionMetadataScopeV1,
  WarehouseMetadataDiscovery,
} from '../../api/client';

/**
 * What Ask reads from a connection, chosen from what the project has
 * (simplification plan Z2, decision Z-D4): with dbt, the tables dbt builds,
 * plus any schemas listed; without dbt, the schemas listed. There is no
 * "index mode" to pick.
 */
export function metadataScopeMode(hasDbt: boolean, scopes: ConnectionMetadataScopeV1['scopes']): ConnectionMetadataScopeV1['mode'] {
  if (!hasDbt) return 'selected_scopes';
  return scopes.length > 0 ? 'dbt_plus_selected' : 'dbt_relations';
}

export function formatMetadataScopeEditor(scopes: ConnectionMetadataScopeV1['scopes']): string {
  return scopes
    .map((scope) => `${scope.catalogOrDatabase}: ${scope.schemas.join(', ')}`)
    .join('\n');
}

export function parseMetadataScopeEditor(value: string): ConnectionMetadataScopeV1['scopes'] {
  const grouped = new Map<string, { catalogOrDatabase: string; schemas: Set<string> }>();
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const catalogOrDatabase = line.slice(0, separator).trim();
    const schemas = line.slice(separator + 1).split(',').map((schema) => schema.trim()).filter(Boolean);
    if (!catalogOrDatabase || schemas.length === 0) continue;
    const key = catalogOrDatabase.toLowerCase();
    const current = grouped.get(key) ?? { catalogOrDatabase, schemas: new Set<string>() };
    for (const schema of schemas) current.schemas.add(schema);
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).map((scope) => ({
    catalogOrDatabase: scope.catalogOrDatabase,
    schemas: Array.from(scope.schemas),
  }));
}

export function metadataScopeIncludes(
  scopes: ConnectionMetadataScopeV1['scopes'],
  catalogOrDatabase: string,
  schema: string,
): boolean {
  return scopes.some((scope) =>
    scope.catalogOrDatabase.toLowerCase() === catalogOrDatabase.toLowerCase()
    && scope.schemas.some((candidate) => candidate.toLowerCase() === schema.toLowerCase()));
}

export function toggleAdditionalMetadataScope(
  scopes: ConnectionMetadataScopeV1['scopes'],
  catalogOrDatabase: string,
  schema: string,
  selected: boolean,
): ConnectionMetadataScopeV1['scopes'] {
  const grouped = new Map(scopes.map((scope) => [
    scope.catalogOrDatabase.toLowerCase(),
    {
      catalogOrDatabase: scope.catalogOrDatabase,
      schemas: new Map(scope.schemas.map((candidate) => [candidate.toLowerCase(), candidate])),
    },
  ]));
  const key = catalogOrDatabase.toLowerCase();
  const current = grouped.get(key) ?? {
    catalogOrDatabase,
    schemas: new Map<string, string>(),
  };
  if (selected) current.schemas.set(schema.toLowerCase(), schema);
  else current.schemas.delete(schema.toLowerCase());
  if (current.schemas.size > 0) grouped.set(key, current);
  else grouped.delete(key);
  return Array.from(grouped.values()).map((scope) => ({
    catalogOrDatabase: scope.catalogOrDatabase,
    schemas: Array.from(scope.schemas.values()),
  }));
}

export function additionalDiscoveredSchemaCount(
  discovery: WarehouseMetadataDiscovery,
): number {
  return discovery.scopes.reduce(
    (count, scope) => count + scope.schemas.filter((schema) => !schema.inDbtProject).length,
    0,
  );
}

/**
 * The one schema discovery found, when it found exactly one and the dbt
 * project reads none: Guided Setup ticks it, as there is nothing to choose
 * (a folder of data files, a SQLite file, a one-schema database).
 */
export function onlyDiscoveredSchema(
  discovery: WarehouseMetadataDiscovery,
): { catalogOrDatabase: string; schema: string } | null {
  if (discovery.dbtScopes.length > 0) return null;
  const all = discovery.scopes.flatMap((scope) => scope.schemas.map((schema) => ({ catalogOrDatabase: scope.catalogOrDatabase, schema: schema.name })));
  return all.length === 1 ? all[0]! : null;
}

/**
 * A value that is a generated identifier, such as `LOCAL_88B5DE228E554CBCCCF7F634`:
 * it means nothing to a person, so the panel never prints it (design D7).
 */
export function looksLikeGeneratedId(value: string): boolean {
  const text = value.trim();
  return /^[A-Za-z]*_?[0-9A-Fa-f]{16,}$/.test(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

type DiscoveredSize = NonNullable<WarehouseMetadataDiscovery['scopes'][number]['schemas'][number]['size']>;

/** 1,240 below ten thousand; 31K, 3.1M, 3.1B above. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 10_000) return rounded.toLocaleString('en-US');
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, unit] of units) {
    if (Math.abs(rounded) >= size) {
      const scaled = rounded / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`;
    }
  }
  return rounded.toLocaleString('en-US');
}

export function compactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One schema's size in a few words: "42 tables · 31M rows · 2.2 GB · 30 with keys declared". */
export function schemaSizeWords(size: DiscoveredSize): string {
  const parts = [`${size.tables.toLocaleString('en-US')} table${size.tables === 1 ? '' : 's'}${size.views > 0 && size.views === size.tables ? ' (views)' : size.views > 0 ? ` (${size.views.toLocaleString('en-US')} view${size.views === 1 ? '' : 's'})` : ''}`];
  if (size.rows !== undefined && size.rows > 0) parts.push(`${compactCount(size.rows)} rows`);
  if (size.bytes !== undefined && size.bytes > 0) parts.push(compactBytes(size.bytes));
  if (size.tablesWithKeys > 0) parts.push(`${size.tablesWithKeys.toLocaleString('en-US')} with keys declared`);
  return parts.join(' · ');
}

export interface SelectedScopeTotals {
  schemas: number;
  /** Of those, the ones the warehouse gave a size for. */
  sized: number;
  tables: number;
  rows: number;
  bytes: number;
  tablesWithKeys: number;
  largeTables: number;
  /** Columns per database, for the per-database read limit. */
  columnsByDatabase: Array<{ catalogOrDatabase: string; columns: number }>;
}

/** The size of what is ticked (schemas a dbt project reads are read relation by relation, so they are left out). */
export function selectedScopeTotals(
  discovery: WarehouseMetadataDiscovery,
  selected: ConnectionMetadataScopeV1['scopes'],
): SelectedScopeTotals {
  const totals: SelectedScopeTotals = { schemas: 0, sized: 0, tables: 0, rows: 0, bytes: 0, tablesWithKeys: 0, largeTables: 0, columnsByDatabase: [] };
  for (const scope of discovery.scopes) {
    let columns = 0;
    for (const schema of scope.schemas) {
      if (schema.inDbtProject || !metadataScopeIncludes(selected, scope.catalogOrDatabase, schema.name)) continue;
      totals.schemas += 1;
      if (!schema.size) continue;
      totals.sized += 1;
      totals.tables += schema.size.tables;
      totals.rows += schema.size.rows ?? 0;
      totals.bytes += schema.size.bytes ?? 0;
      totals.tablesWithKeys += schema.size.tablesWithKeys;
      totals.largeTables += schema.size.largeTables ?? 0;
      columns += schema.size.columns ?? 0;
    }
    if (columns > 0) totals.columnsByDatabase.push({ catalogOrDatabase: scope.catalogOrDatabase, columns });
  }
  return totals;
}

/**
 * What is ticked is more than one Apply and synchronize reads: said before
 * anything runs (onboarding design, "Too big at once"). Null when it fits or
 * the sizes are unknown.
 */
export function scopeOverLimits(
  totals: SelectedScopeTotals,
  limits: WarehouseMetadataDiscovery['limits'],
): string | null {
  if (!limits) return null;
  const over = totals.columnsByDatabase.find((entry) => entry.columns > limits.columnsPerDatabase);
  if (over) {
    return `These schemas in ${over.catalogOrDatabase} hold ${over.columns.toLocaleString('en-US')} columns; ZLens reads up to ${limits.columnsPerDatabase.toLocaleString('en-US')} per database at once. Choose fewer schemas.`;
  }
  if (totals.tables > limits.tables) {
    return `These schemas hold ${totals.tables.toLocaleString('en-US')} tables; ZLens reads up to ${limits.tables.toLocaleString('en-US')} at once. Choose fewer schemas.`;
  }
  return null;
}

/** "Selected: 3 schemas · 1,240 tables · 3.1B rows · 410 GB · 26 over 10M rows". */
export function selectedScopeWords(totals: SelectedScopeTotals, checkRowBudget?: number): string {
  if (totals.schemas === 0) return 'Nothing selected yet.';
  const parts = [`${totals.schemas.toLocaleString('en-US')} schema${totals.schemas === 1 ? '' : 's'}`];
  if (totals.sized > 0) {
    parts.push(`${totals.tables.toLocaleString('en-US')} table${totals.tables === 1 ? '' : 's'}`);
    if (totals.rows > 0) parts.push(`${compactCount(totals.rows)} rows`);
    if (totals.bytes > 0) parts.push(compactBytes(totals.bytes));
    if (totals.largeTables > 0 && checkRowBudget) parts.push(`${totals.largeTables.toLocaleString('en-US')} over ${compactCount(checkRowBudget)} rows`);
  }
  return `Selected: ${parts.join(' · ')}`;
}

/** "Check faster" (decision D6): each size's credits an hour, and how much sooner it finishes, roughly. */
const SIZE_CREDITS: Record<'XSMALL' | 'SMALL' | 'MEDIUM', number> = { XSMALL: 1, SMALL: 2, MEDIUM: 4 };

/**
 * The background checks on a larger size of the app's own warehouse (onboarding design P7): about that many
 * times sooner, for about the same credits (each size doubles the credits an hour). Rough: a check that waits
 * on one large table gains less. Exported for tests.
 */
export function checkSizeWords(checkSeconds: number, size: 'XSMALL' | 'SMALL' | 'MEDIUM'): string {
  const factor = SIZE_CREDITS[size];
  const seconds = checkSeconds / factor;
  const credits = (seconds / 3600) * factor;
  const time = seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s` : seconds < 5400 ? `about ${Math.round(seconds / 60)} min` : `about ${Math.round(seconds / 360) / 10} h`;
  const label = size === 'XSMALL' ? 'X-Small' : size === 'SMALL' ? 'Small' : 'Medium';
  return `${label}: ${time}, ${credits < 0.05 ? 'under 0.05' : `about ${credits.toFixed(1)}`} credits${size === 'XSMALL' ? '' : `, then back to X-Small`}`;
}

/** Decision D4: with this many tables or fewer in all, every schema is ticked for the person. */
export const PRESELECT_TABLE_LIMIT = 100;

/**
 * What the picker ticks by itself (onboarding design D4): every schema when
 * the warehouse sized them all and they hold 100 tables or fewer in all; the
 * one schema there is; otherwise nothing, and the person chooses.
 */
export function preselectedScopes(discovery: WarehouseMetadataDiscovery): ConnectionMetadataScopeV1['scopes'] {
  const only = onlyDiscoveredSchema(discovery);
  if (only) return [{ catalogOrDatabase: only.catalogOrDatabase, schemas: [only.schema] }];
  if (discovery.dbtScopes.length > 0) return [];
  const schemas = discovery.scopes.flatMap((scope) => scope.schemas.filter((schema) => !schema.inDbtProject).map((schema) => ({ scope, schema })));
  if (schemas.length === 0 || schemas.some(({ schema }) => !schema.size)) return [];
  const tables = schemas.reduce((count, { schema }) => count + (schema.size?.tables ?? 0), 0);
  if (tables === 0 || tables > PRESELECT_TABLE_LIMIT) return [];
  return discovery.scopes
    .map((scope) => ({ catalogOrDatabase: scope.catalogOrDatabase, schemas: scope.schemas.filter((schema) => !schema.inDbtProject).map((schema) => schema.name) }))
    .filter((scope) => scope.schemas.length > 0);
}

function roughDuration(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} min`;
  return `about ${Math.round(minutes / 6) / 10} h`;
}

/**
 * The two estimates the picker shows (onboarding design, "Choose your data"):
 * reading names, and the background data checks. Rough, from the sizes alone,
 * and said to be estimates; credits only where ZLens runs on the app's own
 * X-Small warehouse (one credit an hour).
 */
export function setupEstimates(
  totals: SelectedScopeTotals,
  options: { checkRowBudget?: number; credits?: boolean } = {},
): { names: string; checks: string; namesSeconds: number; checkSeconds: number } {
  const columns = totals.columnsByDatabase.reduce((count, entry) => count + entry.columns, 0);
  const namesSeconds = 4 + totals.tables / 200 + columns / 5_000;
  const budget = options.checkRowBudget ?? 10_000_000;
  // A key check per table without a declared key, joins between them, and the rows the checks read, capped per table.
  const unkeyed = Math.max(0, totals.tables - totals.tablesWithKeys);
  const checkSeconds = 2 * unkeyed + 0.5 * totals.tablesWithKeys + Math.min(totals.rows, totals.tables * budget) / 5e6;
  const credits = options.credits ? `, ${checkSeconds / 3600 < 0.05 ? 'under 0.05' : `about ${(Math.round(checkSeconds / 360) / 10).toFixed(1)}`} credits on the app's X-Small warehouse` : '';
  return {
    names: `Reading names: ${roughDuration(namesSeconds)}.`,
    checks: `Checking the data in the background: ${roughDuration(checkSeconds)}${credits} (estimate).`,
    namesSeconds,
    checkSeconds,
  };
}
