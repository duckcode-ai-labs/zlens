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
export const CORTEX_DEFAULT_MODEL = 'claude-sonnet-5-5';

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
 * Runs one SQL statement with binds on the Snowflake connection Cortex signs in with; returns the rows. `signal`
 * ends the statement: the runner must cancel it in Snowflake, so the warehouse stops too (the Snowflake driver
 * cancels a running statement when its signal aborts).
 */
export type CortexSqlRunner = (sql: string, binds: unknown[], options?: { signal?: AbortSignal }) => Promise<Array<Record<string, unknown>>>;

/**
 * THE CLAUDE MODELS ASK FALLS BACK TO, in order, when Cortex does not offer the model ZLens chose itself in the
 * account's region. Cortex reaches most Claude models only through cross-region inference, so which ones an account
 * reaches depends on its CORTEX_ENABLED_CROSS_REGION setting. From Snowflake's "Model availability" table (checked
 * 25 Nov 2026, https://docs.snowflake.com/en/user-guide/snowflake-cortex/model-availability):
 * - claude-sonnet-5-5: Any region, AWS Global, AWS US, AWS EU, AWS APJ, AWS AU; not AWS JP (Japan's default).
 * - claude-opus-5-5: the same, and AWS JP.
 * - claude-sonnet-4-6: every AWS group (US, EU, APJ, JP, AU), and in-region in AWS Europe West 2 (London).
 * - claude-sonnet-4-5: every AWS group, and AWS US Gov.
 * No Claude model is offered through the Azure or Google Cloud groups, so an account whose setting allows only those,
 * or is DISABLED (the default in São Paulo, the Middle East and Africa), needs its admin to change the setting.
 */
export const CORTEX_CLAUDE_FALLBACK_MODELS: readonly string[] = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5']);

/** The one statement that lets an installed ZLens app (or a role) use Cortex; only an ACCOUNTADMIN can run it. */
export function cortexGrantStatement(grantee: { appName?: string; role?: string } = {}): string {
  if (grantee.appName?.trim()) return `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ${grantee.appName.trim()}`;
  if (grantee.role?.trim()) return `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ${grantee.role.trim()}`;
  return 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION <app name>';
}

/** The account setting that lets Cortex reach Claude in another Snowflake region; only an ACCOUNTADMIN can set it. */
export const CORTEX_CROSS_REGION_STATEMENT = "ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'";

/**
 * The model Ask uses on a host after a fallback, and the one it was chosen instead of, per route: Cortex's REST
 * Messages endpoint and SQL `AI_COMPLETE` need not offer the same model ids (live 25 Nov 2026: another Cortex
 * endpoint answered "unknown model" for claude-sonnet-5-5 where /v1/messages took it), so a fallback found on one
 * route is never assumed on the other. Kept for the process: the readiness check at start finds it again after a
 * restart, and "Check again" forgets it, so an account whose admin has since allowed cross-region inference returns
 * to the default.
 */
const modelChoices = new Map<string, { model: string; instead: string }>();

function modelChoiceKey(host: string, route: 'rest' | 'sql'): string {
  return `${bareHost(host).toLowerCase()}|${route}`;
}

/** The model Ask uses on this host (on its current route, or `route`) instead of the one ZLens chose, when Cortex did not offer that one. */
export function cortexModelChoice(host: string, route: 'rest' | 'sql' = cortexRoute(host)): { model: string; instead: string } | undefined {
  const choice = modelChoices.get(modelChoiceKey(host, route));
  return choice ? { ...choice } : undefined;
}

/** Tests and "Check again": forget a fallback. */
export function resetCortexModelChoice(host?: string): void {
  if (!host) {
    modelChoices.clear();
    return;
  }
  modelChoices.delete(modelChoiceKey(host, 'rest'));
  modelChoices.delete(modelChoiceKey(host, 'sql'));
}

/**
 * WHEN SNOWFLAKE REFUSES THE CORTEX REST API. An account (in practice, a whole organization) can be
 * refused the REST endpoints with 403 `003001` "This account is not allowed to access this endpoint"
 * while Cortex through SQL (`AI_COMPLETE`) keeps working for the same roles (seen live 2026-11-09).
 * ZLens then answers through SQL on the same Snowflake connection, and remembers the refusal per
 * host for a while, so every request does not pay a refused round trip first; after that it tries
 * REST again, so it returns to REST once Snowflake re-enables it.
 */
export const CORTEX_REST_RETRY_AFTER_MS = 15 * 60_000;
const restRefusedUntil = new Map<string, number>();

/** Whether a Cortex REST response is Snowflake refusing the endpoint for the account (not a bad request). */
export function isCortexRestRefusal(status: number, body: string): boolean {
  return status === 403 && /003001|not allowed to access this endpoint/i.test(body);
}

/** How this host is answered now: `sql` while a REST refusal is remembered, else `rest`. */
export function cortexRoute(host: string, now: number = Date.now()): 'rest' | 'sql' {
  const until = restRefusedUntil.get(bareHost(host).toLowerCase());
  return until !== undefined && until > now ? 'sql' : 'rest';
}

/** Tests and the server: forget a remembered refusal. */
export function resetCortexRoute(host?: string): void {
  if (host) restRefusedUntil.delete(bareHost(host).toLowerCase());
  else restRefusedUntil.clear();
}

function rememberRestRefusal(host: string, now: number = Date.now()): void {
  restRefusedUntil.set(bareHost(host).toLowerCase(), now + CORTEX_REST_RETRY_AFTER_MS);
}

type MessagesContent = string | Array<{ type?: string; text?: string }>;

function contentText(content: MessagesContent | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((block) => block?.type === 'text' || typeof block?.text === 'string').map((block) => block.text ?? '').join('');
}

/**
 * A Messages request as the one text `AI_COMPLETE` takes: the system text first, then the turns,
 * labelled when there is more than one. Claude reads instructions given this way as it reads them in
 * the system field.
 */
export function messagesRequestAsPrompt(body: { system?: MessagesContent; messages?: Array<{ role?: string; content?: MessagesContent }> }): string {
  const system = contentText(body.system).trim();
  const turns = (body.messages ?? []).map((turn) => ({ role: turn.role === 'assistant' ? 'Assistant' : 'User', text: contentText(turn.content).trim() })).filter((turn) => turn.text);
  const conversation = turns.length === 1 && turns[0]!.role === 'User'
    ? turns[0]!.text
    : turns.map((turn) => `${turn.role}:\n${turn.text}`).join('\n\n');
  return system ? `${system}\n\n${conversation}` : conversation;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-zlens-cortex-route': 'sql' } });
}

function sseResponse(text: string, usage: { input_tokens: number; output_tokens: number }, model: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'cortex-sql', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-zlens-cortex-route': 'sql' } });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** `work`, or the signal's reason as soon as it aborts: the caller stops waiting while Snowflake cancels the statement. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/**
 * One Messages request answered through `AI_COMPLETE` on the Snowflake connection, returned as the
 * Messages API would answer it (JSON, or server-sent events for a streamed request). Tool calls have
 * no SQL route, so a request with tools is refused with a plain reason.
 *
 * CANCEL ON GIVE-UP. When Ask stops waiting (its deadline, the person's Stop, or a long request no one polls any
 * more), `signal` aborts: the runner cancels the statement in Snowflake, so the warehouse stops too, and this
 * throws the abort at once instead of waiting for Snowflake to confirm. Before, the statement ran on to the
 * driver's 120 s limit after Ask had given up.
 */
export async function cortexSqlComplete(sql: CortexSqlRunner, requestBody: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(requestBody) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'cortex: the request is not JSON' } });
  }
  const model = typeof body.model === 'string' && body.model ? body.model : CORTEX_DEFAULT_MODEL;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return jsonResponse(503, { type: 'error', error: { type: 'api_error', message: 'Snowflake refuses the Cortex REST API for this account, and tool calls have no route through Cortex SQL.' } });
  }
  const parameters: Record<string, unknown> = {};
  if (typeof body.max_tokens === 'number') parameters.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') parameters.temperature = body.temperature;
  const prompt = messagesRequestAsPrompt(body as Parameters<typeof messagesRequestAsPrompt>[0]);
  let text = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const statement = 'SELECT AI_COMPLETE(model => ?, prompt => ?, model_parameters => PARSE_JSON(?), show_details => TRUE) AS R';
    const binds = [model, prompt, JSON.stringify(parameters)];
    const rows = await untilAborted(signal ? sql(statement, binds, { signal }) : sql(statement, binds), signal);
    const raw = rows[0]?.R ?? rows[0]?.r ?? Object.values(rows[0] ?? {})[0];
    const detail = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { choices?: Array<{ messages?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
    text = detail?.choices?.[0]?.messages ?? '';
    usage = { input_tokens: detail?.usage?.prompt_tokens ?? 0, output_tokens: detail?.usage?.completion_tokens ?? 0 };
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    // One line: Snowflake can put the reason on the line after "SQL compilation error:".
    const message = (error instanceof Error ? error.message : String(error)).split('\n').map((line) => line.trim()).filter(Boolean).join(' ').slice(0, 500);
    return jsonResponse(502, { type: 'error', error: { type: 'api_error', message: `Cortex through SQL failed: ${message}` } });
  }
  if (body.stream === true) return sseResponse(text, usage, model);
  return jsonResponse(200, { id: 'cortex-sql', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });
}

type PreparedRequest = { url: string; body: string; headers: Record<string, string> };
type SendInit = Omit<RequestInit, 'body' | 'headers'>;

/** One request on this host's current route: REST, or `AI_COMPLETE` while a REST refusal is remembered. */
async function sendCortexOnce(sql: CortexSqlRunner | undefined, host: string, prepared: PreparedRequest, body: string, init: SendInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (sql && cortexRoute(host) === 'sql') return cortexSqlComplete(sql, body, signal ? { signal } : {});
  const response = await fetch(prepared.url, { ...init, headers: prepared.headers, body });
  if (!sql || response.status !== 403) return response;
  const text = await response.clone().text().catch(() => '');
  if (!isCortexRestRefusal(response.status, text)) return response;
  rememberRestRefusal(host);
  console.warn(`[zlens] Snowflake refuses the Cortex REST API for ${bareHost(host)} (003001): answering through Cortex SQL (AI_COMPLETE) for ${CORTEX_REST_RETRY_AFTER_MS / 60_000} minutes, then trying REST again.`);
  return cortexSqlComplete(sql, body, signal ? { signal } : {});
}

/** Whether a response is Cortex saying it does not offer the model asked for (here, in this region). */
async function offersNotThisModel(response: Response): Promise<boolean> {
  if (response.ok || ![400, 404, 502].includes(response.status)) return false;
  const text = await response.clone().text().catch(() => '');
  const kind = cortexFailureKind(`claude: ${response.status} ${text}`)?.kind;
  return kind === 'region' || kind === 'model';
}

function withModel(body: string, model: string): string {
  try {
    return JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), model });
  } catch {
    return body;
  }
}

function modelOf(body: string): string | undefined {
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * MODEL FALLBACK BY REGION. The model ZLens chose itself (no one named one) may not be offered in the account's
 * region: the next Claude model in CORTEX_CLAUDE_FALLBACK_MODELS is asked instead, and the first one Cortex answers
 * with is remembered for the host, so later requests go to it directly. Settings and the readiness check say which
 * model Ask uses, so the switch is never silent. When no model is offered, the first refusal is returned: the
 * readiness check then names the account setting the admin changes.
 */
async function sendWithModelFallback(host: string, requested: string, body: string, once: (body: string) => Promise<Response>): Promise<Response> {
  const route = cortexRoute(host);
  const remembered = modelChoices.get(modelChoiceKey(host, route));
  const at = CORTEX_CLAUDE_FALLBACK_MODELS.indexOf(requested);
  const after = at >= 0 ? CORTEX_CLAUDE_FALLBACK_MODELS.slice(at + 1) : CORTEX_CLAUDE_FALLBACK_MODELS;
  const candidates = [...new Set([remembered?.instead === requested ? remembered.model : undefined, requested, ...after].filter((model): model is string => Boolean(model)))];
  let first: Response | undefined;
  for (const model of candidates) {
    const response = await once(model === requested ? body : withModel(body, model));
    if (!(await offersNotThisModel(response))) {
      // Remembered for the route that answered: a REST refusal can move a request to SQL on the way.
      const key = modelChoiceKey(host, response.headers.get('x-zlens-cortex-route') === 'sql' ? 'sql' : 'rest');
      if (model === requested) {
        modelChoices.delete(key);
      } else if (modelChoices.get(key)?.model !== model) {
        modelChoices.set(key, { model, instead: requested });
        console.warn(`[zlens] Snowflake Cortex does not offer ${requested} to this account here: Ask uses ${model}.`);
      }
      return response;
    }
    first ??= response;
  }
  return first!;
}

/**
 * The transport: ZLens's own Messages request, sent with a Snowflake token in
 * place of an Anthropic API key. The URL is the one ClaudeProvider built from the
 * Cortex base URL; the body keeps `model`, and a streamed request stays streamed.
 * With a SQL runner it also answers through `AI_COMPLETE` when the account
 * refuses the REST API (see `isCortexRestRefusal`). With `automaticModel`, a request
 * for that model falls back to another Claude model when Cortex does not offer it
 * in the account's region (see `sendWithModelFallback`). `abandoned` is a second
 * signal that ends a request: a long request no one waits for any more.
 */
export function cortexClaudeTransport(options: {
  token: () => Promise<CortexToken>;
  sql?: CortexSqlRunner;
  host?: string;
  automaticModel?: string;
  abandoned?: () => AbortSignal | undefined;
}): ProviderHttpTransport {
  const transport: ProviderHttpTransport = {
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
  transport.send = async (prepared, init) => {
    const host = options.host ?? new URL(prepared.url).host;
    const abandoned = options.abandoned?.();
    const own = init.signal ?? undefined;
    const signal = abandoned && own ? AbortSignal.any([own, abandoned]) : (abandoned ?? own);
    const sendInit: SendInit = { ...init, ...(signal ? { signal } : {}) };
    const once = (body: string) => sendCortexOnce(options.sql, host, prepared, body, sendInit);
    const requested = modelOf(prepared.body);
    if (!options.automaticModel || requested !== options.automaticModel) return once(prepared.body);
    return sendWithModelFallback(host, requested, prepared.body, once);
  };
  return transport;
}

export interface CortexClaudeOptions {
  /** The Snowflake account's host (see `snowflakeHost`). */
  host: string;
  model?: string;
  /**
   * Whether ZLens chose the model itself (no one named one; the default when `model` is unset). Only such a model
   * falls back to another Claude model when Cortex does not offer it in the account's region: a model a person
   * named stays theirs, and the readiness check says it is not offered.
   */
  automaticModel?: boolean;
  token: () => Promise<CortexToken>;
  /** Runs SQL on the same Snowflake connection: the route when the account refuses the REST API. */
  sql?: CortexSqlRunner;
  /** A second signal that ends every request while it is set: a long request no one waits for any more. */
  abandoned?: () => AbortSignal | undefined;
}

/**
 * Claude through Snowflake Cortex. Underneath it is a ClaudeProvider (its name
 * stays `claude`), so reasoning effort, usage and the wire guards apply as for
 * Anthropic's own API; `via` lets a host tell the two apart.
 */
/**
 * What kind of Cortex failure a provider error is:
 * - `grant`: the role (or the installed app) may not use Cortex: SNOWFLAKE.CORTEX_USER is missing. Through SQL,
 *   `AI_COMPLETE` is an unknown function or not authorized; through REST, a 403 that is not the 003001 refusal
 *   (Snowflake's REST docs: "the default role ... does not have the snowflake.cortex_user database role").
 * - `region`: the model is not offered in the account's region (cross-region inference would reach it).
 * - `model`: Cortex does not know the model (REST: 400 "unknown model").
 * - `tools`, `sql_failed`, `rest_refused`: the REST API is refused (403 003001), and the SQL route could not help.
 * Undefined for anything else (a timeout, a rate limit), which stays as Snowflake said it.
 */
export type CortexFailureKind = 'grant' | 'region' | 'model' | 'tools' | 'sql_failed' | 'rest_refused';

export interface CortexFailure {
  kind: CortexFailureKind;
  /** The HTTP status of the provider's error, when it had one. */
  status?: number;
  /** Snowflake's own message, out of its JSON. */
  detail: string;
}

export function cortexFailureKind(message: string): CortexFailure | undefined {
  const raw = /^claude: (\d{3}) ([\s\S]*)$/.exec(message.trim());
  const status = raw ? Number(raw[1]) : undefined;
  let detail = raw ? raw[2]! : message;
  try {
    const body = JSON.parse(detail) as { message?: unknown; error?: { message?: unknown } };
    const inner = body?.error?.message ?? body?.message;
    if (typeof inner === 'string' && inner.trim()) detail = inner.trim();
  } catch {
    // Not JSON: the body is the detail.
  }
  // Matched on the message and the whole body: Snowflake puts the error code beside the message.
  const text = `${detail} ${raw ? raw[2] : ''}`.toLowerCase();
  const failure = (kind: CortexFailureKind): CortexFailure => ({ kind, ...(status ? { status } : {}), detail });
  const restRefusal = /003001|not allowed to access this endpoint/.test(text);
  if (/not available in (?:this|your) region|unavailable in (?:this|your) region|not (?:available|offered) in (?:the|this|your) (?:account'?s )?region|cross.?region/.test(text)) return failure('region');
  if (/unknown model|invalid model|not a claude model|model\b[^.]{0,80}?\b(?:does not exist|not found|is not supported)/.test(text)) return failure('model');
  if (/ai_complete/.test(text) && /unknown function|does not exist|not authorized|insufficient privileges/.test(text)) return failure('grant');
  if (/cortex_user/.test(text) && !restRefusal) return failure('grant');
  if (status === 403 && !restRefusal && /not authori[sz]ed|insufficient privileges|does not have|access denied|permission/.test(text)) return failure('grant');
  if (/tool calls have no route through cortex sql/.test(text)) return failure('tools');
  if (/cortex through sql failed/.test(text)) return failure('sql_failed');
  if (status === 403 && restRefusal) return failure('rest_refused');
  return undefined;
}

/**
 * A Cortex failure in plain words (approved design D5, 2026-11-09), or undefined when the raw message is
 * already the plainest there is. The HTTP status stays in the text: the run's diagnostics classify by it.
 * `grantee` fills in the grant statement: the installed app's name, else the role ZLens signs in with.
 */
export function cortexFailureInWords(message: string, grantee: { appName?: string; role?: string } = {}): string | undefined {
  const failure = cortexFailureKind(message);
  return failure ? cortexFailureWords(failure, grantee) : undefined;
}

/** The words for a classified failure (see cortexFailureInWords). */
export function cortexFailureWords(failure: CortexFailure, grantee: { appName?: string; role?: string } = {}): string {
  const http = failure.status ? ` (HTTP ${failure.status})` : '';
  switch (failure.kind) {
    case 'grant': {
      const statement = cortexGrantStatement(grantee);
      const where = grantee.appName?.trim() || !grantee.role?.trim() ? 'for the ZLens app' : 'for this role';
      return 'The Snowflake role ZLens signs in with cannot use Cortex. Ask your Snowflake admin to grant it the SNOWFLAKE.CORTEX_USER database role'
        + ` (${where}: ${statement})` + (http || ' (HTTP 403)') + '.';
    }
    case 'region':
      return 'This Claude model is not offered in your Snowflake region. Ask your Snowflake admin to allow cross-region inference'
        + ` (${CORTEX_CROSS_REGION_STATEMENT}), or pick another model in Settings » AI` + http + '.';
    case 'model':
      return 'Snowflake Cortex does not offer this Claude model in your account. Pick another Claude model in Settings » AI,'
        + ` or leave the model empty to use ${CORTEX_DEFAULT_MODEL}` + http + '.';
    case 'tools':
      return 'This step needs tool calls, which Cortex through SQL (AI_COMPLETE) cannot make, and Snowflake keeps the Cortex REST API off for this account'
        + ' (error 003001, as it does for most accounts). Snowflake support can turn the REST API on' + http + '.';
    case 'sql_failed':
      return `Cortex through SQL (AI_COMPLETE) failed: ${failure.detail.replace(/^cortex through sql failed:\s*/i, '').replace(/\.\s*$/, '')}${http}.`;
    case 'rest_refused':
      return 'Snowflake keeps the Cortex REST API off for this account (HTTP 403, error 003001), as it does for most accounts, and here ZLens has no'
        + ' Snowflake connection to ask Cortex through SQL (AI_COMPLETE) instead, the usual route. Ask from the ZLens server or app.';
  }
}

function inPlainWords(error: unknown, grantee: { appName?: string; role?: string } = {}): unknown {
  if (!(error instanceof Error)) return error;
  const words = cortexFailureInWords(error.message, grantee);
  if (!words) return error;
  return Object.assign(new Error(words, { cause: error }), (error as { code?: unknown }).code !== undefined ? { code: (error as { code?: unknown }).code } : {});
}

export class CortexClaudeProvider extends ClaudeProvider {
  readonly via = 'snowflake-cortex' as const;
  /** The Snowflake account host every request goes to. */
  readonly host: string;
  /** The model asked for: the one a person named, else CORTEX_DEFAULT_MODEL. */
  readonly requestedModel: string;
  /** Whether ZLens chose `requestedModel` itself, so it may fall back to another Claude model (see CORTEX_CLAUDE_FALLBACK_MODELS). */
  readonly automaticModel: boolean;
  /** Who the grant in a "cannot use Cortex" message names: the installed app, else the role. */
  readonly grantee: { appName?: string; role?: string };

  constructor(options: CortexClaudeOptions & { grantee?: { appName?: string; role?: string } }) {
    const model = options.model?.trim() || CORTEX_DEFAULT_MODEL;
    const automaticModel = options.automaticModel ?? !options.model?.trim();
    super({
      baseUrl: cortexBaseUrl(options.host),
      model,
      transport: cortexClaudeTransport({
        token: options.token,
        host: options.host,
        ...(options.sql ? { sql: options.sql } : {}),
        ...(options.abandoned ? { abandoned: options.abandoned } : {}),
        ...(automaticModel ? { automaticModel: model } : {}),
      }),
    });
    this.host = bareHost(options.host);
    this.requestedModel = model;
    this.automaticModel = automaticModel;
    this.grantee = { ...options.grantee };
  }

  /** How this provider's requests are answered right now: through the REST API, or through SQL after a refusal. */
  route(): 'rest' | 'sql' {
    return cortexRoute(this.host);
  }

  /** The model Ask uses now, and the one it replaced when Cortex did not offer that one in the account's region. */
  modelInUse(): { model: string; instead?: string } {
    const choice = this.automaticModel ? cortexModelChoice(this.host) : undefined;
    return choice && choice.instead === this.requestedModel ? { model: choice.model, instead: choice.instead } : { model: this.requestedModel };
  }

  // Failures in plain words, not Snowflake's raw JSON.
  override async generate(...args: Parameters<ClaudeProvider['generate']>): ReturnType<ClaudeProvider['generate']> {
    try { return await super.generate(...args); } catch (error) { throw inPlainWords(error, this.grantee); }
  }

  override async generateWithTools(...args: Parameters<ClaudeProvider['generateWithTools']>): ReturnType<ClaudeProvider['generateWithTools']> {
    try { return await super.generateWithTools(...args); } catch (error) { throw inPlainWords(error, this.grantee); }
  }

  override async generateStream(...args: Parameters<ClaudeProvider['generateStream']>): ReturnType<ClaudeProvider['generateStream']> {
    try { return await super.generateStream(...args); } catch (error) { throw inPlainWords(error, this.grantee); }
  }
}

/** Whether a provider is Claude through Snowflake Cortex (checked by shape: a host may load its own copy of this module). */
export function isCortexClaudeProvider(provider: unknown): provider is CortexClaudeProvider {
  return Boolean(provider) && typeof provider === 'object' && (provider as { via?: unknown }).via === 'snowflake-cortex';
}
