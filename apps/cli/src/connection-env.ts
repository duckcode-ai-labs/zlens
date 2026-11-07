/**
 * The environment variables a saved connection reads (`${NAME}` in
 * dql.config.json), and whether each is set for this server. A teammate who
 * opens a configured project (Guided Setup → Open an existing ZLens project)
 * sees which ones to export before the connection can work. Secret-store
 * references (`${secret:...}`) are not environment variables and are skipped.
 * Names only: values never leave the server.
 */
export interface ConnectionEnvironmentReference {
  name: string;
  set: boolean;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function connectionEnvironmentReferences(
  connection: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionEnvironmentReference[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      for (const match of value.matchAll(ENV_REFERENCE)) names.add(match[1]!);
      return;
    }
    // Lists too: a connection's `catalogs` and `sources` (`catalogs[0].token`).
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) visit(nested, depth + 1);
    }
  };
  visit(connection, 0);
  return [...names].sort().map((name) => ({ name, set: typeof env[name] === 'string' && env[name]!.length > 0 }));
}
