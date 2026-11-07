/**
 * Connection secrets live outside `dql.config.json`.
 *
 * The config is shared through git, so a password typed on the Connections
 * page is written to `.dql/local/private/connection-secrets.json` (git-ignored,
 * readable only by this user) and the config keeps a `${secret:<conn>.<field>}`
 * reference in its place. The API never sends a stored secret back to the
 * browser: a saved secret reads as a mask, and saving the mask keeps it.
 *
 * Literal secrets already in a config, and `${ENV_VAR}` references, keep
 * working unchanged; a literal moves to the private file the next time the
 * connection is saved from the page.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Connection fields that hold a secret. `sshTunnel.*` and `storage.*.*` fields are nested; each catalog's are added by its name (`secretFieldsOf`). */
export const SECRET_FIELDS = [
  'password',
  'token',
  'privateKey',
  'privateKeyPassphrase',
  'passcode',
  'oauthClientSecret',
  'proxyPassword',
  'secretAccessKey',
  'sessionToken',
  'serviceAccountJson',
  'sshTunnel.password',
  'sshTunnel.privateKey',
  'sshTunnel.passphrase',
  // A file connection's buckets (`storage`): keys only when not the cloud's own sign-in.
  'storage.s3.secretAccessKey',
  'storage.s3.sessionToken',
  'storage.gcs.secret',
  'storage.azure.connectionString',
  'storage.r2.secret',
] as const;

/**
 * Secret fields of each entry of a connection's `catalogs` (an Iceberg REST
 * client secret or token, a Unity Catalog token, a DuckLake catalog's database
 * password). A catalog is a list entry: its fields are named by the catalog's
 * name (`catalogs.lake.token`), so reordering the list keeps each secret.
 */
const CATALOG_SECRET_KEYS = ['clientSecret', 'token', 'password'] as const;
const CATALOG_SECRET_FIELD = new RegExp(`^catalogs\\.([^.]+)\\.(${CATALOG_SECRET_KEYS.join('|')})$`);

/** Every secret field of one connection: the fixed ones, and each named catalog's. */
function secretFieldsOf(connection: Record<string, unknown>): string[] {
  const catalogs = Array.isArray(connection.catalogs) ? connection.catalogs : [];
  const names = catalogs
    .map((catalog) => (catalog && typeof catalog === 'object' ? (catalog as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '' && !name.includes('.'));
  return [...SECRET_FIELDS, ...[...new Set(names)].flatMap((name) => CATALOG_SECRET_KEYS.map((key) => `catalogs.${name}.${key}`))];
}

/** What the API shows for a saved secret. Saving it back keeps the stored value. */
export const SECRET_MASK = '••••••••';

const SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/;

type Secrets = Record<string, Record<string, string>>;

export function connectionSecretsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'private', 'connection-secrets.json');
}

function readSecrets(projectRoot: string): Secrets {
  const path = connectionSecretsPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Secrets : {};
  } catch {
    return {};
  }
}

function writeSecrets(projectRoot: string, secrets: Secrets): void {
  const path = connectionSecretsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on file systems without POSIX modes.
  }
}

/** A list entry by its `name` (a connection's `catalogs`). */
function entryIndex(list: unknown[], name: string): number {
  return list.findIndex((entry) => Boolean(entry) && typeof entry === 'object' && (entry as Record<string, unknown>).name === name);
}

function getField(connection: Record<string, unknown>, field: string): unknown {
  let current: unknown = connection;
  for (const part of field.split('.')) {
    if (Array.isArray(current)) {
      current = current[entryIndex(current, part)];
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a field, copying each nested object (and list) on the way (the connection given is never shared with the caller's). */
function setField(connection: Record<string, unknown>, field: string, value: unknown): void {
  const [head, ...rest] = field.split('.');
  if (!rest.length) {
    if (value === undefined) delete connection[head];
    else connection[head] = value;
    return;
  }
  const nested = connection[head];
  if (Array.isArray(nested)) {
    // A list entry named by the next part (`catalogs.lake.token`).
    const [name, ...inner] = rest;
    const index = entryIndex(nested, name!);
    if (index < 0 || !inner.length) return;
    const list = [...nested];
    const entry = { ...(list[index] as Record<string, unknown>) };
    setField(entry, inner.join('.'), value);
    list[index] = entry;
    connection[head] = list;
    return;
  }
  if (!nested || typeof nested !== 'object') return;
  const copy = { ...(nested as Record<string, unknown>) };
  setField(copy, rest.join('.'), value);
  connection[head] = copy;
}

function isReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{[^}]+\}$/.test(value.trim());
}

/**
 * Connections as the API shows them: every saved secret is the mask. An
 * `${ENV_VAR}` reference is not a secret and is shown as written.
 */
export function redactConnections(connections: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(connections)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      out[name] = value;
      continue;
    }
    const copy = { ...(value as Record<string, unknown>) };
    if (copy.credentials !== undefined) copy.credentials = SECRET_MASK;
    for (const field of secretFieldsOf(copy)) {
      const current = getField(copy, field);
      if (typeof current !== 'string' || current === '') continue;
      if (isReference(current) && !SECRET_REFERENCE.test(current)) continue;
      setField(copy, field, SECRET_MASK);
    }
    out[name] = copy;
  }
  return out;
}

/**
 * Store the secrets of connections saved from the page. A new literal goes to
 * the private file and becomes a reference; the mask keeps whatever was saved
 * before; an empty value removes the secret. Secrets of connections that no
 * longer exist are dropped.
 */
export function storeConnectionSecrets(
  projectRoot: string,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
  options: {
    /** New name → old name, for a connection renamed on the page. */
    renames?: Record<string, string>;
    /** A secret the page could not have sent, e.g. from the dbt profile it was imported from. */
    fallback?: (connection: string, field: string) => string | undefined;
  } = {},
): Record<string, unknown> {
  const secrets = readSecrets(projectRoot);
  const next: Secrets = {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      out[name] = value;
      continue;
    }
    const connection = { ...(value as Record<string, unknown>) };
    const priorName = previous[name] !== undefined ? name : options.renames?.[name] ?? name;
    const before = previous[priorName] && typeof previous[priorName] === 'object' ? previous[priorName] as Record<string, unknown> : {};
    if (connection.credentials === SECRET_MASK) connection.credentials = before.credentials;
    if (connection.credentials && typeof connection.credentials === 'object' && !connection.serviceAccountJson) {
      // An inline key object is a secret too: it moves out as JSON text.
      connection.serviceAccountJson = JSON.stringify(connection.credentials);
      delete connection.credentials;
    }
    for (const field of secretFieldsOf(connection)) {
      const current = getField(connection, field);
      if (current === SECRET_MASK) {
        // Unchanged on the page: keep the stored secret where it lives now.
        const kept = getField(before, field);
        const reference = typeof kept === 'string' ? kept.match(SECRET_REFERENCE)?.[1] : undefined;
        if (reference) {
          const stored = lookupSecret(secrets, reference);
          if (stored !== undefined) {
            putSecret(next, name, field, stored);
            setField(connection, field, referenceFor(name, field));
            continue;
          }
        }
        if (typeof kept === 'string' && kept !== '' && !SECRET_REFERENCE.test(kept)) {
          if (isReference(kept)) {
            setField(connection, field, kept);
          } else {
            putSecret(next, name, field, kept);
            setField(connection, field, referenceFor(name, field));
          }
          continue;
        }
        const fallback = options.fallback?.(name, field);
        if (fallback) {
          if (isReference(fallback)) {
            setField(connection, field, fallback);
          } else {
            putSecret(next, name, field, fallback);
            setField(connection, field, referenceFor(name, field));
          }
          continue;
        }
        setField(connection, field, undefined);
        continue;
      }
      if (typeof current !== 'string' || current === '') {
        if (current === '') setField(connection, field, undefined);
        continue;
      }
      if (isReference(current)) {
        const reference = current.match(SECRET_REFERENCE)?.[1];
        const stored = reference ? lookupSecret(secrets, reference) : undefined;
        if (stored !== undefined) {
          putSecret(next, name, field, stored);
          setField(connection, field, referenceFor(name, field));
        }
        continue;
      }
      putSecret(next, name, field, current);
      setField(connection, field, referenceFor(name, field));
    }
    out[name] = connection;
  }
  writeSecrets(projectRoot, next);
  return out;
}

function referenceFor(connection: string, field: string): string {
  return `\${secret:${connection}.${field}}`;
}

function putSecret(secrets: Secrets, connection: string, field: string, value: string): void {
  (secrets[connection] ??= {})[field] = value;
}

function lookupSecret(secrets: Secrets, reference: string): string | undefined {
  // `<connection>.<field>` where the field may itself be `sshTunnel.password` or `catalogs.lake.token`.
  for (const field of SECRET_FIELDS) {
    const suffix = `.${field}`;
    if (reference.endsWith(suffix)) {
      const connection = reference.slice(0, -suffix.length);
      const value = secrets[connection]?.[field];
      if (value !== undefined) return value;
    }
  }
  const parts = reference.split('.');
  for (let start = 1; start < parts.length; start += 1) {
    const field = parts.slice(start).join('.');
    if (!CATALOG_SECRET_FIELD.test(field)) continue;
    const value = secrets[parts.slice(0, start).join('.')]?.[field];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Replace `${secret:...}` references with the stored values. A reference
 * whose secret is missing is an error that names the connection, never a
 * sign-in attempt with the reference text as the password.
 */
export function resolveSecretReferences<T extends object>(connection: T, projectRoot: string): T {
  let secrets: Secrets | null = null;
  const resolveValue = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const match = value.trim().match(SECRET_REFERENCE);
    if (!match) return value;
    secrets ??= readSecrets(projectRoot);
    const stored = lookupSecret(secrets, match[1]!);
    if (stored === undefined) {
      throw new Error(`The saved secret ${match[1]} is missing from .dql/local/private/connection-secrets.json. Re-enter it on the Connections page.`);
    }
    return stored;
  };
  // Nested settings (`sshTunnel`, `storage.s3`, `sources`) at any depth.
  const resolveDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolveDeep);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([inner, nested]) => [inner, resolveDeep(nested)]));
    }
    return resolveValue(value);
  };
  return resolveDeep(connection) as T;
}


/**
 * A person's own connections for this project, outside git:
 * `.dql/local/private/connections.json` = `{ defaultConnection?, connections }`.
 * Each named connection replaces a shared one of the same name, and its
 * `defaultConnection` wins. A host's command line
 * writes the development copy an admin named here, so a laptop never needs
 * Production's credentials; without the file nothing changes.
 */
export function privateConnectionsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'private', 'connections.json');
}

export function readPrivateConnections(projectRoot: string): { defaultConnection?: string; connections: Record<string, Record<string, unknown>> } | undefined {
  const path = privateConnectionsPath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { defaultConnection?: unknown; connections?: unknown };
    const connections = parsed.connections && typeof parsed.connections === 'object' && !Array.isArray(parsed.connections)
      ? Object.fromEntries(Object.entries(parsed.connections as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])))
      : {};
    const defaultConnection = typeof parsed.defaultConnection === 'string' && parsed.defaultConnection.trim() ? parsed.defaultConnection.trim() : undefined;
    return { ...(defaultConnection ? { defaultConnection } : {}), connections };
  } catch {
    return undefined;
  }
}
