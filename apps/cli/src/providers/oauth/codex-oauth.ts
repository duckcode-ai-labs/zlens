import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import {
  completeProviderHttpDispatch,
  prepareProviderHttpDispatch,
  type AgentProvider,
  type AgentMessage,
  type ProviderRunOptions,
} from '@zlens/agent';
import {
  getCodexCredentials,
  setCodexCredentials,
  clearOAuthProvider,
  type CodexOAuthCredentials,
} from './oauth-store.js';
import { CodexCliProvider } from '../subscription-cli.js';

/**
 * ChatGPT Plus/Pro subscription login via OpenAI OAuth 2.0 + PKCE, and a provider
 * that drives the ChatGPT Codex backend with the resulting bearer token.
 *
 * Ported from the reference coding-extension flow. Tokens live in the `chmod 600`
 * `.dql/oauth-credentials.json` file. Same ToS caveat as the Claude flow: this
 * reuses the official Codex OAuth client id against a subscription; the provider
 * falls back to the CLI-passthrough path when not connected.
 */
export const CODEX_OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: 'openid profile email offline_access',
  callbackPort: 1455,
} as const;

const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// ChatGPT-account Codex supports a *narrower* set than API-key Codex — the versioned
// `-codex` models (e.g. gpt-5.2-codex) are API-only and 400 with "not supported when
// using Codex with a ChatGPT account". These are the models a ChatGPT Plus/Pro login
// can actually call. See https://developers.openai.com/codex/models (default first).
export const CODEX_OAUTH_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export const CODEX_OAUTH_DEFAULT_MODEL = 'gpt-5.5';

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest().toString('base64url');
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function buildAuthorizationUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CODEX_OAUTH_CONFIG.clientId,
    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
    scope: CODEX_OAUTH_CONFIG.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_type: 'code',
    state,
    codex_cli_simplified_flow: 'true',
    originator: 'roo-code',
  });
  return `${CODEX_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

export function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  const claims = parseJwtClaims(tokens.access_token);
  return claims ? extractAccountIdFromClaims(claims) : undefined;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  email?: string;
}

function parseTokenResponse(data: unknown): TokenResponse {
  const d = data as Partial<TokenResponse> | undefined;
  if (!d || typeof d.access_token !== 'string' || typeof d.expires_in !== 'number') {
    throw new Error('Codex OAuth: malformed token response');
  }
  return { access_token: d.access_token, refresh_token: d.refresh_token, id_token: d.id_token, expires_in: d.expires_in, email: d.email };
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<CodexOAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    code,
    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
    code_verifier: codeVerifier,
  });
  const response = await fetch(CODEX_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth token exchange failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
  const token = parseTokenResponse(await response.json());
  if (!token.refresh_token) throw new Error('Codex OAuth: token exchange did not return a refresh_token');
  return {
    type: 'openai-codex',
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    email: token.email,
    accountId: extractAccountId({ id_token: token.id_token, access_token: token.access_token }),
  };
}

export async function refreshAccessToken(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    refresh_token: credentials.refresh_token,
  });
  const response = await fetch(CODEX_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth token refresh failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
  const token = parseTokenResponse(await response.json());
  return {
    type: 'openai-codex',
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? credentials.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    email: token.email ?? credentials.email,
    accountId: extractAccountId({ id_token: token.id_token, access_token: token.access_token }) ?? credentials.accountId,
  };
}

export function isTokenExpired(credentials: CodexOAuthCredentials): boolean {
  const bufferMs = 5 * 60 * 1000;
  return Date.now() >= credentials.expires - bufferMs;
}

export class CodexOAuthManager {
  private pendingAuth: { codeVerifier: string; state: string; server?: http.Server; resolve?: (creds: CodexOAuthCredentials) => void; reject?: (err: Error) => void } | null = null;
  private refreshPromise: Promise<CodexOAuthCredentials> | null = null;

  constructor(private readonly projectRoot: string) {}

  cancelAuthorizationFlow(): void {
    const prior = this.pendingAuth;
    this.pendingAuth = null;
    if (!prior) return;
    // Settle the in-flight callback promise so its port + closure are released.
    if (prior.reject) prior.reject(new Error('Authorization flow superseded'));
    if (prior.server) {
      try { prior.server.close(); } catch { /* noop */ }
    }
  }

  /** True while a login is in flight (callback server listening). */
  isPending(): boolean {
    return this.pendingAuth !== null;
  }

  startAuthorizationFlow(): string {
    this.cancelAuthorizationFlow();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    this.pendingAuth = { codeVerifier, state };
    return buildAuthorizationUrl(codeChallenge, state);
  }

  async waitForCallback(): Promise<CodexOAuthCredentials> {
    if (!this.pendingAuth) throw new Error('No pending authorization flow');
    const pending = this.pendingAuth;
    const { codeVerifier, state } = pending;

    return new Promise<CodexOAuthCredentials>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${CODEX_OAUTH_CONFIG.callbackPort}`);
          if (url.pathname !== '/auth/callback') {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const code = url.searchParams.get('code');
          const receivedState = url.searchParams.get('state');
          if (!code || !receivedState) {
            res.writeHead(400);
            res.end('Missing code or state');
            return;
          }
          if (receivedState !== state) {
            res.writeHead(400);
            res.end('Invalid state');
            return;
          }
          const credentials = await exchangeCodeForTokens(code, codeVerifier);
          setCodexCredentials(this.projectRoot, credentials);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:system-ui;padding:40px">Signed in to ChatGPT. You can close this tab and return to ZLens.</body></html>');
          server.close();
          this.pendingAuth = null;
          resolve(credentials);
        } catch (error) {
          try { res.writeHead(500); res.end('Authentication failed'); } catch { /* noop */ }
          try { server.close(); } catch { /* noop */ }
          this.pendingAuth = null;
          reject(error);
        }
      });
      pending.server = server;
      const timeout = setTimeout(() => {
        try { server.close(); } catch { /* noop */ }
        if (this.pendingAuth === pending) this.pendingAuth = null;
        reject(new Error('Codex OAuth callback timed out'));
      }, 5 * 60 * 1000);
      server.on('close', () => clearTimeout(timeout));
      // The loopback port may be taken, or unreachable from the browser (a
      // codespace, a container, a remote host). Keep the flow open so the
      // pasted-address path below can still finish it; the timeout ends it.
      server.on('error', () => { /* completeFromRedirect still works */ });
      server.listen(CODEX_OAUTH_CONFIG.callbackPort);
    });
  }

  /**
   * Finishes the pending sign-in from the address the browser landed on, for
   * when the browser can't reach this machine's loopback port (ZLens in a
   * codespace, a container or on another host): the provider still redirects
   * to `/auth/callback` on the person's own computer, which shows an error page whose
   * address carries the code. Accepts that full address or just its query.
   */
  async completeFromRedirect(redirect: string): Promise<CodexOAuthCredentials> {
    const pending = this.pendingAuth;
    if (!pending) throw new Error('No sign-in is in progress. Click "Sign in with ChatGPT" again.');
    const text = redirect.trim();
    let params: URLSearchParams;
    try {
      params = text.includes('?') ? new URL(text, 'http://localhost').searchParams : new URLSearchParams(text.replace(/^[?#]/, ''));
    } catch {
      throw new Error('That doesn\'t look like the address from your browser. Copy the whole address bar.');
    }
    const providerError = params.get('error');
    if (providerError) throw new Error(`Sign-in was not completed: ${params.get('error_description') || providerError}.`);
    const code = params.get('code');
    const receivedState = params.get('state');
    if (!code || !receivedState) throw new Error('That address has no sign-in code. Copy the whole address bar after you sign in.');
    if (receivedState !== pending.state) throw new Error('That address is from a different sign-in. Click "Sign in" again and paste the new address.');
    const credentials = await exchangeCodeForTokens(code, pending.codeVerifier);
    setCodexCredentials(this.projectRoot, credentials);
    this.pendingAuth = null;
    if (pending.server) { try { pending.server.close(); } catch { /* noop */ } }
    pending.resolve?.(credentials);
    return credentials;
  }

  async getAccessToken(): Promise<string | null> {
    let creds = getCodexCredentials(this.projectRoot);
    if (!creds) return null;
    if (isTokenExpired(creds)) {
      try {
        if (!this.refreshPromise) this.refreshPromise = refreshAccessToken(creds);
        creds = await this.refreshPromise;
        this.refreshPromise = null;
        setCodexCredentials(this.projectRoot, creds);
      } catch {
        this.refreshPromise = null;
        return null;
      }
    }
    return creds.access_token;
  }

  getAccountId(): string | null {
    return getCodexCredentials(this.projectRoot)?.accountId ?? null;
  }

  getEmail(): string | null {
    return getCodexCredentials(this.projectRoot)?.email ?? null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  signOut(): void {
    this.cancelAuthorizationFlow();
    clearOAuthProvider(this.projectRoot, 'codex');
  }
}

export function codexOAuthConnected(projectRoot: string): boolean {
  return getCodexCredentials(projectRoot) !== null;
}

/** Format DQL messages into the ChatGPT Codex Responses `input` shape. */
function formatInput(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const formatted: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'user') {
      formatted.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.content.trim()) formatted.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
    }
  }
  return formatted;
}

function parseSse(raw: string): Record<string, unknown> | null {
  let eventType: string | undefined;
  let data = '';
  for (const line of raw.split('\n').map((l) => l.trimEnd()).filter(Boolean)) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return eventType ? { ...parsed, type: eventType } : parsed;
  } catch {
    return null;
  }
}

/**
 * AgentProvider that drives ChatGPT Codex via the subscription OAuth token.
 * Streams the Responses SSE and accumulates visible text (reasoning deltas are
 * dropped from the returned string). Requires a prior `Sign in with ChatGPT`.
 */
export class CodexOAuthProvider implements AgentProvider {
  readonly name = 'openai' as const;
  private readonly manager: CodexOAuthManager;
  private readonly projectRoot: string;
  private readonly defaultModel: string;
  private readonly cliModel?: string;
  private readonly sessionId: string;
  private cliFallback?: CodexCliProvider;

  constructor(opts: { projectRoot: string; model?: string }) {
    this.manager = new CodexOAuthManager(opts.projectRoot);
    this.projectRoot = opts.projectRoot;
    this.defaultModel = opts.model || CODEX_OAUTH_DEFAULT_MODEL;
    this.cliModel = opts.model;
    this.sessionId = crypto.randomUUID();
  }

  async available(): Promise<boolean> {
    return this.manager.isAuthenticated();
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const accessToken = await this.manager.getAccessToken();
    if (!accessToken) {
      // Credential present but unusable → CLI fallback; none at all → prompt sign-in.
      if (codexOAuthConnected(this.projectRoot)) {
        if (!this.cliFallback) this.cliFallback = new CodexCliProvider({ model: this.cliModel });
        if (await this.cliFallback.available()) {
          return this.cliFallback.generate(messages, options);
        }
      }
      throw new Error('Your ChatGPT subscription session expired. Open Settings → ChatGPT subscription and click "Sign in with ChatGPT" again.');
    }
    const accountId = this.manager.getAccountId();
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      model: options.model || this.defaultModel,
      input: formatInput(messages.filter((m) => m.role !== 'system')),
      stream: true,
      store: false,
      instructions: systemText || undefined,
    };
    if (options.reasoningEffort) {
      body.reasoning = { effort: options.reasoningEffort, summary: 'auto' };
      body.include = ['reasoning.encrypted_content'];
    }
    const dispatch = {
      provider: this.name,
      operation: 'generate_stream',
      attemptIndex: 1,
      options,
      envelope: body,
    } as const;
    const dispatchBody = prepareProviderHttpDispatch(dispatch);
    let transportSettled = false;
    let transportSucceeded = false;
    try {
      const res = await fetch(`${CODEX_API_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          originator: 'roo-code',
          session_id: this.sessionId,
          'User-Agent': `dql/${os.platform()} node/${process.version.slice(1)}`,
          ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        },
        body: JSON.stringify(dispatchBody),
        signal: options.signal,
      });
      transportSettled = true;
      transportSucceeded = res.ok && Boolean(res.body);
      completeProviderHttpDispatch(dispatch, {
        settlement: 'transport',
        outcome: transportSucceeded ? 'ok' : 'error',
        httpStatus: res.status,
      });
      if (!res.ok || !res.body) {
        throw new Error(`chatgpt (subscription): ${res.status} ${await res.text().catch(() => res.statusText)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let out = '';
      const consume = (raw: string) => {
        const evt = parseSse(raw);
        if (!evt) return;
        const type = evt.type as string | undefined;
        if ((type === 'response.output_text.delta' || type === 'response.text.delta') && typeof evt.delta === 'string') {
          out += evt.delta;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          consume(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
        if (done) break;
      }
      // Flush a final event not terminated by a blank line.
      if (buffer.trim()) consume(buffer);
      if (!out.trim()) {
        throw Object.assign(new Error('ChatGPT subscription returned no assistant text.'), {
          code: 'PROVIDER_RESULT_MALFORMED',
        });
      }
      completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: 'ok' });
      return out;
    } catch (error) {
      const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!transportSettled) {
        completeProviderHttpDispatch(dispatch, { settlement: 'transport', outcome: cancelled ? 'cancelled' : 'error', error });
      } else if (transportSucceeded) {
        completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: cancelled ? 'cancelled' : 'error', error });
      }
      throw error;
    }
  }
}
