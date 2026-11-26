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
