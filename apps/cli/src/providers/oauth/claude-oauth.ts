import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import {
  completeProviderHttpDispatch,
  prepareProviderHttpDispatch,
  runAnthropicNativeToolLoop,
  anthropicToolLoopPost,
  type AgentProvider,
  type AgentMessage,
  type AgentToolDefinition,
  type NativeToolLoopResult,
  type ProviderRunOptions,
  type ProviderToolLoopOptions,
} from '@zlens/agent';
import {
  getClaudeCredentials,
  setClaudeCredentials,
  clearOAuthProvider,
  type ClaudeOAuthCredentials,
} from './oauth-store.js';
import { ClaudeCodeCliProvider } from '../subscription-cli.js';

/**
 * Claude Pro/Max subscription login via OAuth 2.0 + PKCE, and a provider that
 * drives `api.anthropic.com` with the resulting bearer token (no API key).
 *
 * Ported from the reference coding-extension flow. Tokens are stored in the
 * `chmod 600` `.dql/oauth-credentials.json` file rather than VSCode secrets.
 *
 * NOTE (governance / ToS): this reuses the official Claude Code OAuth client id
 * to authenticate a user's *subscription*. It is subject to Anthropic's terms —
 * the client id can be revoked and accounts can be rate-limited/flagged. The
 * provider falls back to the CLI-passthrough path when not connected.
 */
export const CLAUDE_OAUTH_CONFIG = {
  authorizationEndpoint: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'http://localhost:54545/callback',
  scopes: 'org:create_api_key user:profile user:inference',
  callbackPort: 54545,
} as const;

/** Claude subscription models exposed after login (latest generation; default first). */
export const CLAUDE_OAUTH_MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'] as const;
export const CLAUDE_OAUTH_DEFAULT_MODEL = 'claude-sonnet-5';

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest().toString('base64url');
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Claude Code identifies the caller with a synthetic `user_<hash>_account_<uuid>_session_<uuid>` id. */
export function generateUserId(email?: string): string {
  const userHash = email
    ? crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)
    : crypto.randomBytes(8).toString('hex');
  const accountUuid = crypto.randomUUID().replace(/-/g, '');
  const sessionUuid = crypto.randomUUID().replace(/-/g, '');
  return `user_${userHash}_account_${accountUuid}_session_${sessionUuid}`;
}

export function buildAuthorizationUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLAUDE_OAUTH_CONFIG.clientId,
    redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
    scope: CLAUDE_OAUTH_CONFIG.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_type: 'code',
    state,
  });
  return `${CLAUDE_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  email?: string;
}

function parseTokenResponse(data: unknown): TokenResponse {
  const d = data as Partial<TokenResponse> | undefined;
  if (!d || typeof d.access_token !== 'string' || typeof d.expires_in !== 'number') {
    throw new Error('Claude OAuth: malformed token response');
  }
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, email: d.email };
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string, state: string): Promise<ClaudeOAuthCredentials> {
  const response = await fetch(CLAUDE_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH_CONFIG.clientId,
      redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Claude OAuth token exchange failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
  const token = parseTokenResponse(await response.json());
  if (!token.refresh_token) throw new Error('Claude OAuth: token exchange did not return a refresh_token');
  return {
    type: 'claude',
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expired: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    email: token.email,
  };
}

export async function refreshAccessToken(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
  const response = await fetch(CLAUDE_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLAUDE_OAUTH_CONFIG.clientId, refresh_token: credentials.refresh_token }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Claude OAuth token refresh failed: ${response.status} ${await response.text().catch(() => response.statusText)}`);
  }
  const token = parseTokenResponse(await response.json());
  return {
    type: 'claude',
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? credentials.refresh_token,
    expired: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    email: token.email ?? credentials.email,
  };
}

export function isTokenExpired(credentials: ClaudeOAuthCredentials): boolean {
  const bufferMs = 5 * 60 * 1000;
  return Date.now() >= new Date(credentials.expired).getTime() - bufferMs;
}

/**
 * Project-scoped manager: owns the pending-auth state during a login and the
 * lazy access-token refresh. File-backed, so the login flow (backend endpoints)
 * and the provider (`generate`) see the same credentials.
 */
export class ClaudeOAuthManager {
  private pendingAuth: { codeVerifier: string; state: string; server?: http.Server; resolve?: (creds: ClaudeOAuthCredentials) => void; reject?: (err: Error) => void } | null = null;
  private refreshPromise: Promise<ClaudeOAuthCredentials> | null = null;

  constructor(private readonly projectRoot: string) {}

  cancelAuthorizationFlow(): void {
    const prior = this.pendingAuth;
    this.pendingAuth = null;
    if (!prior) return;
    // Settle the in-flight callback promise so its port + closure are released
    // deterministically (server.close() alone would leave the promise dangling).
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

  /** Starts the loopback callback server on the fixed OAuth port and resolves when the browser returns. */
  async waitForCallback(): Promise<ClaudeOAuthCredentials> {
    if (!this.pendingAuth) throw new Error('No pending authorization flow');
    const pending = this.pendingAuth;
    const { codeVerifier, state } = pending;

    return new Promise<ClaudeOAuthCredentials>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${CLAUDE_OAUTH_CONFIG.callbackPort}`);
          if (url.pathname !== '/callback') {
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
          const credentials = await exchangeCodeForTokens(code, codeVerifier, receivedState);
          setClaudeCredentials(this.projectRoot, credentials);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:system-ui;padding:40px">Signed in to Claude. You can close this tab and return to ZLens.</body></html>');
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
        reject(new Error('Claude OAuth callback timed out'));
      }, 5 * 60 * 1000);
      server.on('close', () => clearTimeout(timeout));
      // The loopback port may be taken, or unreachable from the browser (a
      // codespace, a container, a remote host). Keep the flow open so the
      // pasted-address path below can still finish it; the timeout ends it.
      server.on('error', () => { /* completeFromRedirect still works */ });
      server.listen(CLAUDE_OAUTH_CONFIG.callbackPort);
    });
  }

  /** Returns a valid access token, refreshing (and persisting) if within the expiry buffer. */
  /**
   * Finishes the pending sign-in from the address the browser landed on, for
   * when the browser can't reach this machine's loopback port (ZLens in a
   * codespace, a container or on another host): the provider still redirects
   * to `/callback` on the person's own computer, which shows an error page whose
   * address carries the code. Accepts that full address or just its query.
   */
  async completeFromRedirect(redirect: string): Promise<ClaudeOAuthCredentials> {
    const pending = this.pendingAuth;
    if (!pending) throw new Error('No sign-in is in progress. Click "Sign in with Claude" again.');
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
    const credentials = await exchangeCodeForTokens(code, pending.codeVerifier, receivedState);
    setClaudeCredentials(this.projectRoot, credentials);
    this.pendingAuth = null;
    if (pending.server) { try { pending.server.close(); } catch { /* noop */ } }
    pending.resolve?.(credentials);
    return credentials;
  }

  async getAccessToken(): Promise<string | null> {
    let creds = getClaudeCredentials(this.projectRoot);
    if (!creds) return null;
    if (isTokenExpired(creds)) {
      try {
        if (!this.refreshPromise) this.refreshPromise = refreshAccessToken(creds);
        creds = await this.refreshPromise;
        this.refreshPromise = null;
        setClaudeCredentials(this.projectRoot, creds);
      } catch {
        this.refreshPromise = null;
        return null;
      }
    }
    return creds.access_token;
  }

  getEmail(): string | null {
    return getClaudeCredentials(this.projectRoot)?.email ?? null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  signOut(): void {
    this.cancelAuthorizationFlow();
    clearOAuthProvider(this.projectRoot, 'claude');
  }
}

/** True if a Claude subscription is connected (a credential exists on disk). */
export function claudeOAuthConnected(projectRoot: string): boolean {
  return getClaudeCredentials(projectRoot) !== null;
}

const ANTHROPIC_OAUTH_BETAS = [
  'prompt-caching-2024-07-31',
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
].join(',');

/** effort → extended-thinking token budget (matches the reference flow). */
function thinkingFor(effort: ProviderRunOptions['reasoningEffort'], maxTokens: number): { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } {
  const budget = effort === 'high' ? 20000 : effort === 'medium' ? 8192 : effort === 'low' ? 2048 : 0;
  if (budget <= 0) return { type: 'disabled' };
  const clamped = Math.min(budget, Math.floor(maxTokens * 0.8));
  // Anthropic requires budget_tokens >= 1024; if the output cap leaves no room, skip thinking.
  if (clamped < 1024) return { type: 'disabled' };
  return { type: 'enabled', budget_tokens: clamped };
}

/**
 * AgentProvider that drives Claude via the subscription OAuth token. Requires a
 * prior `Sign in with Claude`. The "You are Claude Code…" system preamble and the
 * `oauth-2025-04-20` beta header are required for the subscription API to accept
 * the request.
 */
export class ClaudeOAuthProvider implements AgentProvider {
  readonly name = 'claude' as const;
  private readonly manager: ClaudeOAuthManager;
  private readonly projectRoot: string;
  private readonly defaultModel: string;
  private readonly maxTokens: number;
  private readonly cliModel?: string;
  private cliFallback?: ClaudeCodeCliProvider;
  /**
   * A readiness failure is intentionally redacted and only exposed to the
   * server-owned preflight boundary.  `AgentProvider.available()` remains a
   * boolean because providers are consumed by generic agent surfaces too.
   */
  private readinessFailure?: Error & { code?: string };

  constructor(opts: { projectRoot: string; model?: string }) {
    this.manager = new ClaudeOAuthManager(opts.projectRoot);
    this.projectRoot = opts.projectRoot;
    this.defaultModel = opts.model || CLAUDE_OAUTH_DEFAULT_MODEL;
    this.cliModel = opts.model;
    this.maxTokens = 32768;
  }

  private cliFallbackProvider(): ClaudeCodeCliProvider {
    if (!this.cliFallback) this.cliFallback = new ClaudeCodeCliProvider({ model: this.cliModel });
    return this.cliFallback;
  }

  /**
   * Readiness must mirror generation: a stored OAuth record is preferred, but
   * an expired or unrefreshable record must not hide a healthy, same-provider
   * Claude Code CLI login.  This is not cross-provider failover.
   */
  async available(): Promise<boolean> {
    this.readinessFailure = undefined;
    if (await this.manager.isAuthenticated()) return true;
    if (!claudeOAuthConnected(this.projectRoot)) return false;
    if (await this.cliFallbackProvider().available().catch(() => false)) return true;
    this.readinessFailure = Object.assign(
      new Error('The saved Claude OAuth session could not be refreshed and the Claude Code CLI is not ready.'),
      { code: 'CLAUDE_OAUTH_CLI_UNAVAILABLE' },
    );
    return false;
  }

  /** Typed, redacted context for a false `available()` result. */
  getReadinessFailure(): Error | undefined {
    return this.readinessFailure;
  }

  /**
   * NATIVE TOOL CALLING ON A SUBSCRIPTION.
   *
   * Without this the governed Ask loop had to fall back to its text protocol
   * for every subscription user: one fenced-JSON tool call per turn, the whole
   * transcript re-serialized and re-sent each time, tool arguments validated
   * only after the fact. The subscription endpoint is the same Messages API the
   * API-key provider already drives natively — it differs in how the request is
   * authorized, not in what it can do — so the loop is shared and the
   * difference stays here.
   *
   * The static prefix (the Claude Code preamble and the analyst system prompt)
   * is marked cacheable: it is identical on every turn of a turn-heavy loop,
   * and the prompt-caching beta is already enabled on this transport.
   */
  async generateWithTools(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options: ProviderToolLoopOptions = {},
  ): Promise<NativeToolLoopResult> {
    const accessToken = await this.manager.getAccessToken();
    if (!accessToken) {
      // No usable subscription credential: fall back exactly as generate()
      // does. The CLI transport has no native tool protocol, so the caller's
      // text loop takes over from here.
      if (claudeOAuthConnected(this.projectRoot)) {
        const cliFallback = this.cliFallbackProvider();
        if (await cliFallback.available()) return cliFallback.generate(messages, options);
      }
      throw new Error('Your Claude subscription session expired. Open Settings → Claude subscription and click "Sign in with Claude" again.');
    }
    if (tools.length === 0) return this.generate(messages, options);
    const userId = generateUserId(this.manager.getEmail() || undefined);
    const maxTokens = options.maxTokens ?? this.maxTokens;
    return runAnthropicNativeToolLoop({
      label: 'claude (subscription)',
      endpoint: 'https://api.anthropic.com/v1/messages',
      defaultModel: this.defaultModel,
      // The shared loop's API-key default of 1024 is far too small for a
      // turn that must emit a tool call AND a business answer; a truncated
      // tool_use is indistinguishable from prose to any caller.
      defaultMaxTokens: maxTokens,
      headers: () => ({
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': ANTHROPIC_OAUTH_BETAS,
      }),
      // The subscription API requires the Claude Code preamble as the first
      // system block. Marking the prefix ephemeral lets the unchanged analyst
      // prompt be served from cache on every follow-up turn.
      buildSystem: (text) => [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ...(text ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : []),
      ],
      reasoning: (_model, runOptions) => ({
        thinking: thinkingFor(runOptions.reasoningEffort, runOptions.maxTokens ?? maxTokens),
        metadata: { user_id: userId },
      }),
      post: anthropicToolLoopPost,
    }, messages, tools, options);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const accessToken = await this.manager.getAccessToken();
    if (!accessToken) {
      // A credential exists but is unusable (expired + refresh failed, or revoked):
      // honor the OAuth-first, CLI-fallback contract. With no credential at all,
      // prompt to sign in.
      if (claudeOAuthConnected(this.projectRoot)) {
        const cliFallback = this.cliFallbackProvider();
        if (await cliFallback.available()) {
          return cliFallback.generate(messages, options);
        }
      }
      throw new Error('Your Claude subscription session expired. Open Settings → Claude subscription and click "Sign in with Claude" again.');
    }
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const userId = generateUserId(this.manager.getEmail() || undefined);
    const maxTokens = options.maxTokens ?? this.maxTokens;

    const dispatch = {
      provider: this.name,
      operation: 'generate',
      attemptIndex: 1,
      options,
      envelope: {
      model: options.model || this.defaultModel,
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ...(systemText ? [{ type: 'text', text: systemText }] : []),
      ],
      messages: turns,
      thinking: thinkingFor(options.reasoningEffort, maxTokens),
      metadata: { user_id: userId },
      },
    } as const;
    const body = prepareProviderHttpDispatch(dispatch);
    let transportSettled = false;
    let transportSucceeded = false;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Anthropic-Version': '2023-06-01',
          'Anthropic-Beta': ANTHROPIC_OAUTH_BETAS,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      transportSettled = true;
      transportSucceeded = res.ok;
      completeProviderHttpDispatch(dispatch, {
        settlement: 'transport',
        outcome: res.ok ? 'ok' : 'error',
        httpStatus: res.status,
      });
      if (!res.ok) {
        throw new Error(`claude (subscription): ${res.status} ${await res.text().catch(() => res.statusText)}`);
      }
      const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      if (!Array.isArray(json.content)) {
        throw Object.assign(new Error('Claude subscription returned a malformed response.'), {
          code: 'PROVIDER_RESULT_MALFORMED',
        });
      }
      const text = json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (!text.trim()) {
        throw Object.assign(new Error('Claude subscription returned no assistant text.'), {
          code: 'PROVIDER_RESULT_MALFORMED',
        });
      }
      completeProviderHttpDispatch(dispatch, { settlement: 'result', outcome: 'ok' });
      return text;
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
