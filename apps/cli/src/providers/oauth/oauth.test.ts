import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthorizationUrl as claudeAuthUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateUserId,
  ClaudeOAuthProvider,
  ClaudeOAuthManager,
  CLAUDE_OAUTH_CONFIG,
} from './claude-oauth.js';
import {
  buildAuthorizationUrl as codexAuthUrl,
  extractAccountId,
  CodexOAuthProvider,
  CodexOAuthManager,
  CODEX_OAUTH_CONFIG,
} from './codex-oauth.js';
import {
  setClaudeCredentials,
  setCodexCredentials,
  getClaudeCredentials,
  getCodexCredentials,
  clearOAuthProvider,
} from './oauth-store.js';
import { ClaudeCodeCliProvider } from '../subscription-cli.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dql-oauth-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('PKCE + authorize URL', () => {
  it('code challenge is base64url(SHA256(verifier))', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256').update(verifier).digest().toString('base64url');
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });

  it('Claude authorize URL carries PKCE S256 + client id + redirect + state', () => {
    const url = new URL(claudeAuthUrl('CHALLENGE', 'STATE123'));
    expect(url.origin + url.pathname).toBe(CLAUDE_OAUTH_CONFIG.authorizationEndpoint);
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('Codex authorize URL carries PKCE S256 + codex flow flags', () => {
    const url = new URL(codexAuthUrl('CH', 'ST'));
    expect(url.searchParams.get('client_id')).toBe(CODEX_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('generateUserId embeds a stable email hash', () => {
    const id = generateUserId('a@b.com');
    const hash = createHash('sha256').update('a@b.com').digest('hex').slice(0, 16);
    expect(id.startsWith(`user_${hash}_account_`)).toBe(true);
  });
});

describe('Codex JWT account-id extraction', () => {
  function jwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
  }
  it('reads chatgpt_account_id from the id_token', () => {
    const token = jwt({ chatgpt_account_id: 'acct_123' });
    expect(extractAccountId({ id_token: token, access_token: 'x.y.z' })).toBe('acct_123');
  });
  it('falls back to the namespaced claim, then organizations', () => {
    expect(extractAccountId({ id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ns_1' } }), access_token: 'a.b.c' })).toBe('ns_1');
    expect(extractAccountId({ id_token: jwt({ organizations: [{ id: 'org_9' }] }), access_token: 'a.b.c' })).toBe('org_9');
  });
  it('returns undefined for a non-JWT token', () => {
    expect(extractAccountId({ access_token: 'not-a-jwt' })).toBeUndefined();
  });
});

describe('oauth token store', () => {
  it('round-trips and clears Claude credentials with 0600 perms', () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'tok', refresh_token: 'ref', expired: new Date(Date.now() + 3.6e6).toISOString(), email: 'me@x.com' });
    expect(getClaudeCredentials(root)?.email).toBe('me@x.com');
    clearOAuthProvider(root, 'claude');
    expect(getClaudeCredentials(root)).toBeNull();
  });
});

describe('ClaudeOAuthProvider request', () => {
  it('uses a healthy Claude Code CLI for readiness when a saved OAuth session cannot refresh', async () => {
    setClaudeCredentials(root, {
      type: 'claude',
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
      expired: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('revoked', { status: 401 })));
    const cliAvailable = vi.spyOn(ClaudeCodeCliProvider.prototype, 'available').mockResolvedValue(true);
    try {
      const provider = new ClaudeOAuthProvider({ projectRoot: root });
      await expect(provider.available()).resolves.toBe(true);
      expect(cliAvailable).toHaveBeenCalledTimes(1);
      expect(provider.getReadinessFailure()).toBeUndefined();
    } finally {
      cliAvailable.mockRestore();
    }
  });

  it('keeps a stale OAuth failure typed when the same-provider CLI fallback is unavailable', async () => {
    setClaudeCredentials(root, {
      type: 'claude',
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
      expired: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('revoked', { status: 401 })));
    const cliAvailable = vi.spyOn(ClaudeCodeCliProvider.prototype, 'available').mockResolvedValue(false);
    try {
      const provider = new ClaudeOAuthProvider({ projectRoot: root });
      await expect(provider.available()).resolves.toBe(false);
      expect(provider.getReadinessFailure()).toMatchObject({ code: 'CLAUDE_OAUTH_CLI_UNAVAILABLE' });
    } finally {
      cliAvailable.mockRestore();
    }
  });

  it('keeps a valid OAuth session preferred over the Claude Code CLI', async () => {
    setClaudeCredentials(root, {
      type: 'claude',
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
      expired: new Date(Date.now() + 3.6e6).toISOString(),
    });
    const cliAvailable = vi.spyOn(ClaudeCodeCliProvider.prototype, 'available').mockResolvedValue(true);
    try {
      await expect(new ClaudeOAuthProvider({ projectRoot: root }).available()).resolves.toBe(true);
      expect(cliAvailable).not.toHaveBeenCalled();
    } finally {
      cliAvailable.mockRestore();
    }
  });

  it('sends Bearer + oauth beta headers + Claude Code preamble + effort thinking', async () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'TOK', refresh_token: 'REF', expired: new Date(Date.now() + 3.6e6).toISOString() });
    let captured: { headers: Record<string, string>; body: any } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'answer' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const provider = new ClaudeOAuthProvider({ projectRoot: root, model: 'claude-sonnet-4-5' });
    const dispatches: unknown[] = [];
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    const out = await provider.generate([{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'high',
      onProviderDispatch: (event) => { dispatches.push(event); return event.envelope; },
      onProviderDispatchComplete: (event) => { completions.push(event); },
    });
    expect(out).toBe('answer');
    expect(captured?.headers.Authorization).toBe('Bearer TOK');
    expect(captured?.headers['Anthropic-Beta']).toContain('oauth-2025-04-20');
    expect(captured?.body.system[0].text).toContain('Claude Code');
    expect(captured?.body.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });
    expect(dispatches).toHaveLength(1);
    expect(completions).toEqual([
      expect.objectContaining({ settlement: 'transport', outcome: 'ok' }),
      expect.objectContaining({ settlement: 'result', outcome: 'ok' }),
    ]);
  });

  it('records a successful transport followed by a malformed-result failure', async () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'TOK', refresh_token: 'REF', expired: new Date(Date.now() + 3.6e6).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(new ClaudeOAuthProvider({ projectRoot: root }).generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow(/no assistant text/i);
    expect(completions).toEqual([
      expect.objectContaining({ settlement: 'transport', outcome: 'ok' }),
      expect.objectContaining({ settlement: 'result', outcome: 'error' }),
    ]);
  });

  it('throws a clear error when there is no credential at all', async () => {
    const provider = new ClaudeOAuthProvider({ projectRoot: root });
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Sign in with Claude/);
  });
});

describe('OAuth flow lifecycle', () => {
  it('isPending tracks the in-flight flow and clears on cancel', () => {
    const m = new ClaudeOAuthManager(root);
    expect(m.isPending()).toBe(false);
    const url = m.startAuthorizationFlow();
    expect(url).toContain('claude.ai/oauth/authorize');
    expect(m.isPending()).toBe(true);
    m.cancelAuthorizationFlow();
    expect(m.isPending()).toBe(false);
  });

  it('cancel settles the pending callback promise (no dangling flow)', async () => {
    const m = new ClaudeOAuthManager(root);
    m.startAuthorizationFlow();
    const pending = m.waitForCallback();
    m.cancelAuthorizationFlow(); // supersede
    await expect(pending).rejects.toThrow(/superseded/i);
    expect(m.isPending()).toBe(false);
  });
});

describe('CodexOAuthProvider request', () => {
  it('sends Bearer + ChatGPT-Account-Id and accumulates text deltas from the SSE stream', async () => {
    setCodexCredentials(root, { type: 'openai-codex', access_token: 'CTOK', refresh_token: 'CREF', expires: Date.now() + 3.6e6, accountId: 'acct_9' });
    let captured: Record<string, string> | undefined;
    const sse = 'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
                'data: {"type":"response.completed"}\n\n';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const provider = new CodexOAuthProvider({ projectRoot: root });
    const dispatches: unknown[] = [];
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    const out = await provider.generate([{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'medium',
      onProviderDispatch: (event) => { dispatches.push(event); return event.envelope; },
      onProviderDispatchComplete: (event) => { completions.push(event); },
    });
    expect(out).toBe('Hello');
    expect(captured?.Authorization).toBe('Bearer CTOK');
    expect(captured?.['ChatGPT-Account-Id']).toBe('acct_9');
    expect(dispatches).toHaveLength(1);
    expect(completions).toEqual([
      expect.objectContaining({ settlement: 'transport', outcome: 'ok' }),
      expect.objectContaining({ settlement: 'result', outcome: 'ok' }),
    ]);
  });

  it('records a successful stream transport followed by an invalid-result failure', async () => {
    setCodexCredentials(root, { type: 'openai-codex', access_token: 'CTOK', refresh_token: 'CREF', expires: Date.now() + 3.6e6 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"response.completed"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(new CodexOAuthProvider({ projectRoot: root }).generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow(/no assistant text/i);
    expect(completions).toEqual([
      expect.objectContaining({ settlement: 'transport', outcome: 'ok' }),
      expect.objectContaining({ settlement: 'result', outcome: 'error' }),
    ]);
  });

  it.each([
    ['Claude', () => {
      setClaudeCredentials(root, { type: 'claude', access_token: 'TOK', refresh_token: 'REF', expired: new Date(Date.now() + 3.6e6).toISOString() });
      return new ClaudeOAuthProvider({ projectRoot: root });
    }],
    ['Codex', () => {
      setCodexCredentials(root, { type: 'openai-codex', access_token: 'TOK', refresh_token: 'REF', expires: Date.now() + 3.6e6 });
      return new CodexOAuthProvider({ projectRoot: root });
    }],
  ])('records the %s physical attempt when fetch fails', async (_label, createProvider) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); }));
    const dispatches: unknown[] = [];
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(createProvider().generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatch: (event) => { dispatches.push(event); return event.envelope; },
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow();
    expect(dispatches).toHaveLength(1);
    expect(completions).toEqual([expect.objectContaining({ settlement: 'transport', outcome: 'cancelled' })]);
  });

  it('records a network transport failure without a false successful result', async () => {
    setClaudeCredentials(root, { type: 'claude', access_token: 'TOK', refresh_token: 'REF', expired: new Date(Date.now() + 3.6e6).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const completions: Array<{ settlement?: string; outcome?: string }> = [];
    await expect(new ClaudeOAuthProvider({ projectRoot: root }).generate([{ role: 'user', content: 'hi' }], {
      onProviderDispatchComplete: (event) => { completions.push(event); },
    })).rejects.toThrow(/fetch failed/i);
    expect(completions).toEqual([expect.objectContaining({ settlement: 'transport', outcome: 'error' })]);
  });

  it('flushes a final text delta even when the stream lacks a trailing blank line', async () => {
    setCodexCredentials(root, { type: 'openai-codex', access_token: 'C', refresh_token: 'R', expires: Date.now() + 3.6e6 });
    const sse = 'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":"two"}'; // no trailing \n\n
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const provider = new CodexOAuthProvider({ projectRoot: root });
    expect(await provider.generate([{ role: 'user', content: 'hi' }])).toBe('onetwo');
  });
});

describe('finishing a sign-in from the pasted browser address (ZLens not on this computer)', () => {
  const tokenResponse = () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('refuses when no sign-in is in progress', async () => {
    const m = new ClaudeOAuthManager(root);
    await expect(m.completeFromRedirect('http://localhost:54545/callback?code=c&state=s')).rejects.toThrow(/No sign-in is in progress/);
  });

  it('refuses an address from a different sign-in and keeps the flow open', async () => {
    const m = new ClaudeOAuthManager(root);
    m.startAuthorizationFlow();
    await expect(m.completeFromRedirect('http://localhost:54545/callback?code=c&state=not-this-one')).rejects.toThrow(/different sign-in/);
    expect(m.isPending()).toBe(true);
    m.cancelAuthorizationFlow();
  });

  it('refuses an address without a code, and passes on a provider error', async () => {
    const m = new ClaudeOAuthManager(root);
    m.startAuthorizationFlow();
    await expect(m.completeFromRedirect('http://localhost:54545/callback')).rejects.toThrow(/no sign-in code/);
    await expect(m.completeFromRedirect('http://localhost:54545/callback?error=access_denied')).rejects.toThrow(/not completed: access_denied/);
    m.cancelAuthorizationFlow();
  });

  it('Claude: exchanges the code, saves the credentials and settles the waiting flow', async () => {
    const m = new ClaudeOAuthManager(root);
    const state = new URL(m.startAuthorizationFlow()).searchParams.get('state')!;
    const waiting = m.waitForCallback();
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    await m.completeFromRedirect(`  ${CLAUDE_OAUTH_CONFIG.redirectUri}?code=the-code&state=${state}  `);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).code).toBe('the-code');
    expect(getClaudeCredentials(root)?.access_token).toBe('at');
    expect(m.isPending()).toBe(false);
    await expect(waiting).resolves.toMatchObject({ access_token: 'at' });
  });

  it('ChatGPT: accepts just the query string and saves the credentials', async () => {
    const m = new CodexOAuthManager(root);
    const state = new URL(m.startAuthorizationFlow()).searchParams.get('state')!;
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
    await m.completeFromRedirect(`?code=the-code&state=${state}`);
    expect(getCodexCredentials(root)?.access_token).toBe('at');
    expect(m.isPending()).toBe(false);
  });
});
