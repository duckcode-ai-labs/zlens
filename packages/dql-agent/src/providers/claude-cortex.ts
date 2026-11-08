import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ProviderHttpTransport } from './dispatch.js';
import { ClaudeProvider } from './claude.js';

/**
 * CLAUDE THROUGH SNOWFLAKE CORTEX. Cortex serves Anthropic's Messages API inside
 * the customer's Snowflake account, so a Snowflake customer's prompts stay with
 * Snowflake. The request is the Messages request ZLens already sends (model kept
 * in the body, streaming as Anthropic's own server-sent events); only the
 * address and the sign-in differ:
 *
 * - POST https://{account host}/api/v2/cortex/v1/messages
 * - `Authorization: Bearer <token>` with `X-Snowflake-Authorization-Token-Type`
 *   naming the token: a key-pair JWT minted here (`KEYPAIR_JWT`), a programmatic
 *   access token (`PROGRAMMATIC_ACCESS_TOKEN`) or an OAuth token, such as the one
 *   Snowflake writes into a container at /snowflake/session/token (`OAUTH`).
 *
 * Built from Snowflake's public docs (Cortex REST API, key-pair authentication).
 */

/** The model a Cortex provider uses when none is set; Cortex names Claude models `claude-<family>-<version>`. */
export const CORTEX_DEFAULT_MODEL = 'claude-sonnet-5';

export type CortexTokenType = 'KEYPAIR_JWT' | 'PROGRAMMATIC_ACCESS_TOKEN' | 'OAUTH';

export interface CortexToken {
  token: string;
  type: CortexTokenType;
}

/** Strips a scheme and anything after the host, so `https://x.snowflakecomputing.com/` reads as the host. */
function bareHost(value: string): string {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

/**
 * The host of a Snowflake account: the connection's own `host` when it names one
 * (PrivateLink, or the host Snowflake gives a container), else
 * `<account>.snowflakecomputing.com`. Hostnames take a hyphen where an account
 * name has an underscore, and are lower case.
 */
export function snowflakeHost(input: { account?: string; host?: string }): string | undefined {
  if (input.host?.trim()) return bareHost(input.host).toLowerCase();
  if (!input.account?.trim()) return undefined;
  const account = bareHost(input.account).replace(/\.snowflakecomputing\.com$/i, '');
  return `${account.toLowerCase().replace(/_/g, '-')}.snowflakecomputing.com`;
}

/** What ClaudeProvider is given as its base URL; it appends `/v1/messages`. */
export function cortexBaseUrl(host: string): string {
  return `https://${bareHost(host)}/api/v2/cortex`;
}

/**
 * The account as a key-pair JWT names it: upper case, without region or domain.
 * An account locator with its region (`xy12345.us-east-1`) signs as the locator
 * alone; the organization-account form (`myorg-myaccount`) is used as it is.
 * The same rule Snowflake's own connectors apply.
 */
export function snowflakeJwtAccount(account: string): string {
  return bareHost(account).replace(/\.snowflakecomputing\.com$/i, '').split('.')[0]!.toUpperCase();
}

/** A JWT lasts at most an hour on Snowflake. */
const JWT_LIFETIME_SECONDS = 59 * 60;
/** A cached JWT is replaced this long before it runs out, so a long call never carries an expiring one. */
const JWT_RENEW_MARGIN_MS = 5 * 60 * 1000;

/**
 * A key-pair JWT for Snowflake (RS256): `iss` is `ACCOUNT.USER.SHA256:<fingerprint>`,
 * the fingerprint being the base64 SHA-256 of the public key (SPKI DER); `sub` is
 * `ACCOUNT.USER`. `privateKey` is unencrypted PEM (the connectors package decrypts
 * a connection's key).
 */
export function snowflakeKeyPairJwt(input: {
  account: string;
  user: string;
  privateKey: string;
  now?: Date;
  lifetimeSeconds?: number;
}): { token: string; expiresAt: Date } {
  const key = createPrivateKey({ key: input.privateKey, format: 'pem' });
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(der).digest('base64');
  const qualified = `${snowflakeJwtAccount(input.account)}.${input.user.trim().toUpperCase()}`;
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expiresAt = issuedAt + Math.min(input.lifetimeSeconds ?? JWT_LIFETIME_SECONDS, 3600);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: `${qualified}.SHA256:${fingerprint}`, sub: qualified, iat: issuedAt, exp: expiresAt })}`;
  const signature = sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url');
  return { token: `${signed}.${signature}`, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * Minted JWTs, kept for the process: a provider is built for each request, and
 * signing one per call would be wasted work. Keyed by account, user and a hash
 * of the key (never the key itself).
 */
const keyPairTokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * A key-pair sign-in: mints a JWT and reuses it until five minutes before it
 * expires. `privateKey` may be read lazily (a key file is read on the first
 * call that needs a new JWT).
 */
export function snowflakeKeyPairToken(input: {
  account: string;
  user: string;
  privateKey: string | (() => Promise<string>);
  now?: () => Date;
}): () => Promise<CortexToken> {
  return async () => {
    const privateKey = typeof input.privateKey === 'string' ? input.privateKey : await input.privateKey();
    const now = input.now?.() ?? new Date();
    const cacheKey = `${snowflakeJwtAccount(input.account)}.${input.user.trim().toUpperCase()}|${createHash('sha256').update(privateKey).digest('hex')}`;
    const cached = keyPairTokens.get(cacheKey);
    if (cached && cached.expiresAt - JWT_RENEW_MARGIN_MS > now.getTime()) return { token: cached.token, type: 'KEYPAIR_JWT' };
    const minted = snowflakeKeyPairJwt({ account: input.account, user: input.user, privateKey, now });
    keyPairTokens.set(cacheKey, { token: minted.token, expiresAt: minted.expiresAt.getTime() });
    return { token: minted.token, type: 'KEYPAIR_JWT' };
  };
}

/** Reads a token file; an unreadable or empty file fails with its path, never its contents. */
async function readTokenFile(path: string): Promise<string> {
  let token: string;
  try {
    token = (await readFile(path, 'utf-8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`cortex: the sign-in token file ${path} could not be read${code ? ` (${code})` : ''}`);
  }
  if (!token) throw new Error(`cortex: the sign-in token file ${path} is empty`);
  return token;
}

/**
 * A token kept in a file, read again on every call: Snowflake rewrites a
 * container's token file every few minutes, so a token read once goes stale.
 * `read` replaces the plain file read (the CLI passes the connectors' reader,
 * which also expands `~` and `${VAR}`).
 */
export function snowflakeTokenFileToken(input: {
  type: Exclude<CortexTokenType, 'KEYPAIR_JWT'>;
  path: string;
  read?: (path: string) => Promise<string | undefined>;
}): () => Promise<CortexToken> {
  return async () => {
    const token = (await (input.read ?? readTokenFile)(input.path))?.trim();
    if (!token) throw new Error(`cortex: the sign-in token file ${input.path} is empty`);
    return { token, type: input.type };
  };
}

/**
 * The transport: ZLens's own Messages request, sent with a Snowflake token in
 * place of an Anthropic API key. The URL is the one ClaudeProvider built from the
 * Cortex base URL; the body keeps `model`, and a streamed request stays streamed.
 */
export function cortexClaudeTransport(options: { token: () => Promise<CortexToken> }): ProviderHttpTransport {
  return {
    async prepare({ url, body, headers }) {
      if (typeof body.model !== 'string' || !body.model) throw new Error('cortex: a model id is required');
      const { token, type } = await options.token();
      const sent: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        // Never an Anthropic API key: Cortex signs in with the Snowflake token alone.
        if (lower === 'x-api-key' || lower === 'authorization') continue;
        sent[lower] = value;
      }
      sent['content-type'] = 'application/json';
      sent.accept = body.stream === true ? 'text/event-stream' : 'application/json';
      sent.authorization = `Bearer ${token}`;
      sent['x-snowflake-authorization-token-type'] = type;
      return { url, body: JSON.stringify(body), headers: sent };
    },
  };
}

export interface CortexClaudeOptions {
  /** The Snowflake account's host (see `snowflakeHost`). */
  host: string;
  model?: string;
  token: () => Promise<CortexToken>;
}

/**
 * Claude through Snowflake Cortex. Underneath it is a ClaudeProvider (its name
 * stays `claude`), so reasoning effort, usage and the wire guards apply as for
 * Anthropic's own API; `via` lets a host tell the two apart.
 */
export class CortexClaudeProvider extends ClaudeProvider {
  readonly via = 'snowflake-cortex' as const;
  /** The Snowflake account host every request goes to. */
  readonly host: string;

  constructor(options: CortexClaudeOptions) {
    super({ baseUrl: cortexBaseUrl(options.host), model: options.model?.trim() || CORTEX_DEFAULT_MODEL, transport: cortexClaudeTransport(options) });
    this.host = bareHost(options.host);
  }
}

/** Whether a provider is Claude through Snowflake Cortex (checked by shape: a host may load its own copy of this module). */
export function isCortexClaudeProvider(provider: unknown): provider is CortexClaudeProvider {
  return Boolean(provider) && typeof provider === 'object' && (provider as { via?: unknown }).via === 'snowflake-cortex';
}
