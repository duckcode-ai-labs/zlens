import type {
  ConnectionMetadataScopeV1,
  WarehouseMetadataDiscovery,
} from '../../api/client';

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
