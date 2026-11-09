import { readSnowflakePrivateKey, readSnowflakeTokenFile, type ConnectionConfig } from '@zlens/connectors';
import {
  CortexClaudeProvider,
  cortexBaseUrl,
  snowflakeHost,
  snowflakeKeyPairToken,
  snowflakeTokenFileToken,
  type CortexToken,
} from '@zlens/agent';

/**
 * SNOWFLAKE CORTEX SIGNS IN WITH THE PROJECT'S OWN SNOWFLAKE CONNECTION. There is
 * no API key to paste: Cortex uses the account, user and credential the project
 * already queries Snowflake with (the default connection, or one the Cortex
 * settings name). Only the credentials Cortex's REST API accepts as a bearer
 * token work: a key pair (ZLens mints the JWT), a programmatic access token, or
 * an OAuth token (Snowflake's container token among them).
 */

/** A project connection as the server reads it, secrets and `${VAR}`s filled in; `error` when it cannot be read. */
export interface ProjectConnectionLookupResult {
  name?: string;
  connection: ConnectionConfig | null;
  error?: string;
}

/** Finds a project connection by name, or the project's default connection without one. */
export type ProjectConnectionLookup = (projectRoot: string, name?: string) => ProjectConnectionLookupResult;

// The server registers how it reads connections (local-runtime.ts). Provider settings
// cannot read dql.config.json on their own: the default connection, a person's own
// connections and saved secrets are the server's rules, and repeating them here
// would let the two disagree about which connection Cortex signs in with.
let projectConnectionLookup: ProjectConnectionLookup | undefined;

export function setProjectConnectionLookup(lookup: ProjectConnectionLookup | undefined): void {
  projectConnectionLookup = lookup;
}

function lookUp(projectRoot: string, name?: string): ProjectConnectionLookupResult {
  if (!projectConnectionLookup) return { connection: null };
  try {
    return projectConnectionLookup(projectRoot, name?.trim() || undefined);
  } catch (error) {
    return { ...(name ? { name } : {}), connection: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** How Cortex would sign in for this project: which connection, its sign-in method, or why it cannot. */
export interface CortexSignIn {
  /** The Snowflake connection's name. */
  connection?: string;
  /** The connection's sign-in method (`key_pair`, `oauth`, `password`, ...). */
  method?: string;
  /** Why Cortex cannot sign in with it, in one plain sentence. Absent when it can. */
  problem?: string;
}

type CortexMethod = 'key_pair' | 'programmatic_access_token' | 'oauth';

const METHOD_WORDS: Record<string, string> = {
  password: 'a password',
  mfa: 'a password with MFA',
  external_browser: 'browser single sign-on',
  oauth_authorization_code: 'OAuth sign-in in the browser',
  oauth_client_credentials: 'OAuth client credentials',
  workload_identity: 'workload identity',
};

/** The way the Snowflake driver signs this connection in: a private key means a key pair, whatever else it says. */
export function snowflakeSignInMethod(connection: ConnectionConfig): string {
  if (connection.privateKey || connection.privateKeyPath) return 'key_pair';
  return connection.authMethod ?? 'password';
}

const UNSET_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/** Whether Cortex can sign in with this connection; `problem` says why not. */
export function cortexSignInWith(name: string | undefined, connection: ConnectionConfig | null, error?: string): CortexSignIn {
  const named = name ? `the connection "${name}"` : 'the connection';
  const base: CortexSignIn = name ? { connection: name } : {};
  if (!connection) {
    if (error) return { ...base, problem: `Snowflake Cortex cannot read ${named}: ${error}` };
    return { ...base, problem: name ? `Snowflake Cortex signs in with ${named}, which this project does not have.` : 'Snowflake Cortex signs in with this project\'s Snowflake connection, and the project has none.' };
  }
  if (connection.driver !== 'snowflake') {
    return { ...base, problem: `Snowflake Cortex signs in with a Snowflake connection; ${named} is a ${connection.driver} connection.` };
  }
  const method = snowflakeSignInMethod(connection);
  const signIn: CortexSignIn = { ...base, method };
  if (method !== 'key_pair' && method !== 'programmatic_access_token' && method !== 'oauth') {
    return { ...signIn, problem: `Snowflake Cortex signs in with your Snowflake connection's key pair, programmatic access token or OAuth token; this connection uses ${METHOD_WORDS[method] ?? method.replace(/_/g, ' ')}.` };
  }
  // A `${VAR}` the server could not fill in would be sent as it is.
  for (const field of ['account', 'host', 'username', 'token', 'tokenFilePath', 'privateKeyPath'] as const) {
    const unset = typeof connection[field] === 'string' ? UNSET_VARIABLE.exec(connection[field] as string) : null;
    if (unset) return { ...signIn, problem: `Snowflake Cortex cannot sign in yet: ${named} reads \${${unset[1]}}, which is not set on this server.` };
  }
  if (!snowflakeHost(connection)) return { ...signIn, problem: `Snowflake Cortex needs the Snowflake account of ${named}.` };
  if (method === 'key_pair') {
    if (!connection.privateKey && !connection.privateKeyPath) return { ...signIn, problem: `Snowflake Cortex signs in with the key pair of ${named}, which has no private key.` };
    if (!connection.username?.trim()) return { ...signIn, problem: `Snowflake Cortex signs in with the key pair as a Snowflake user; ${named} names none.` };
  } else if (!connection.token && !connection.tokenFilePath && !connection.password) {
    return { ...signIn, problem: `Snowflake Cortex signs in with the token of ${named}, which has no token or token file.` };
  }
  return signIn;
}

/** How Cortex signs in for this project (the settings' named connection, else the project's default). */
export function cortexSignIn(projectRoot: string, connectionName?: string): CortexSignIn {
  const found = lookUp(projectRoot, connectionName);
  return cortexSignInWith(found.name ?? (connectionName?.trim() || undefined), found.connection, found.error);
}

/** The Snowflake token Cortex sends for this connection, read or minted on each call (see the agent's token sources). */
function cortexToken(connection: ConnectionConfig): () => Promise<CortexToken> {
  const method = snowflakeSignInMethod(connection) as CortexMethod;
  if (method === 'key_pair') {
    return snowflakeKeyPairToken({
      // The JWT names the account identifier; a connection with only a host names it by the host's first label.
      account: connection.account?.trim() || snowflakeHost(connection)!.split('.')[0]!,
      user: connection.username!,
      privateKey: async () => {
        const key = await readSnowflakePrivateKey(connection);
        if (!key) throw new Error('cortex: the connection has no private key');
        return key;
      },
    });
  }
  const type = method === 'oauth' ? 'OAUTH' : 'PROGRAMMATIC_ACCESS_TOKEN';
  // The same order the Snowflake driver reads them in: the token, its file, the password field.
  if (connection.token) return async () => ({ token: connection.token!, type });
  if (connection.tokenFilePath) return snowflakeTokenFileToken({ type, path: connection.tokenFilePath, read: readSnowflakeTokenFile });
  return async () => ({ token: connection.password ?? '', type });
}

/**
 * Claude through Snowflake Cortex for this project, signed in with its Snowflake
 * connection. Throws the plain-sentence reason when Cortex cannot sign in.
 */
export function createCortexProvider(projectRoot: string, options: { connection?: string; model?: string } = {}): CortexClaudeProvider {
  const found = lookUp(projectRoot, options.connection);
  const signIn = cortexSignInWith(found.name ?? (options.connection?.trim() || undefined), found.connection, found.error);
  if (signIn.problem || !found.connection) throw new Error(signIn.problem ?? 'Snowflake Cortex has no Snowflake connection.');
  return new CortexClaudeProvider({
    host: snowflakeHost(found.connection)!,
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    token: cortexToken(found.connection),
  });
}

/**
 * THE CORTEX DATA BOUNDARY (the sibling of the Ollama-on-this-machine rule).
 * Cortex runs inside a Snowflake account. Signed in through the project's own
 * Snowflake connection — the account the project's data is read from — result
 * values reach no one who does not already hold them, so they may reach the
 * model, as with a model on this machine. Signed in through a connection to any
 * other account it is like any other hosted model. The provider must also be
 * sending to that account (`declaredBaseUrl`, when the provider says).
 */
export function cortexInProjectAccount(projectRoot: string, connectionName?: string, declaredBaseUrl?: string): boolean {
  const project = lookUp(projectRoot);
  if (!project.connection || project.connection.driver !== 'snowflake') return false;
  const cortex = connectionName?.trim() ? lookUp(projectRoot, connectionName) : project;
  if (!cortex.connection || cortex.connection.driver !== 'snowflake') return false;
  if (cortexSignInWith(cortex.name, cortex.connection).problem) return false;
  const projectHost = snowflakeHost(project.connection);
  const cortexHost = snowflakeHost(cortex.connection);
  if (!projectHost || projectHost !== cortexHost) return false;
  return declaredBaseUrl === undefined || declaredBaseUrl === cortexBaseUrl(cortexHost);
}
