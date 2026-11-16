import { describe, expect, it } from 'vitest';
import { CORTEX_HELP, aiTurnedOff, brandsAllowed, cortexSignInLine, modelInUseLine, providerAllowed, testThenSave } from './provider-choices';

const BRANDS = [
  { key: 'claude', modes: { subscription: 'claude-code', api: 'anthropic' } },
  { key: 'openai', modes: { subscription: 'codex', api: 'openai' } },
  { key: 'ollama', modes: { local: 'ollama' } },
] as const;

describe('the model providers an install lets a person choose (ZLENS_MODEL_PROVIDERS)', () => {
  it('keeps every brand and way in when the server marks nothing (no switch), as before', () => {
    const providers: Array<{ id: 'anthropic' | 'ollama'; allowed?: boolean }> = [{ id: 'anthropic' }, { id: 'ollama' }];
    expect(brandsAllowed([...BRANDS], providers).map((brand) => brand.key)).toEqual(['claude', 'openai', 'ollama']);
    expect(aiTurnedOff(providers)).toBe(false);
    expect(providerAllowed(providers, 'gemini')).toBe(true);
  });

  it('keeps only the allowed ways in, and drops a brand with none left', () => {
    const providers = [
      { id: 'claude-code' as const, allowed: false },
      { id: 'anthropic' as const, allowed: true },
      { id: 'codex' as const, allowed: false },
      { id: 'openai' as const, allowed: false },
      { id: 'ollama' as const, allowed: true },
    ];
    expect(brandsAllowed([...BRANDS], providers)).toEqual([
      { key: 'claude', modes: { api: 'anthropic' } },
      { key: 'ollama', modes: { local: 'ollama' } },
    ]);
    expect(providerAllowed(providers, 'openai')).toBe(false);
  });

  it('says AI is off when no provider is allowed (none), never when the list is still loading', () => {
    expect(aiTurnedOff([{ allowed: false }, { allowed: false }])).toBe(true);
    expect(aiTurnedOff([])).toBe(false);
  });
});

describe('Snowflake Cortex in Settings', () => {
  const brands = [
    { key: 'claude', modes: { subscription: 'claude-code', api: 'anthropic' } },
    { key: 'cortex', modes: { snowflake: 'cortex' } },
  ] as const;

  it('is the only brand left on an install that allows only Cortex (ZLENS_MODEL_PROVIDERS=cortex)', () => {
    const providers = [
      { id: 'claude-code' as const, allowed: false },
      { id: 'anthropic' as const, allowed: false },
      { id: 'cortex' as const, allowed: true },
    ];
    expect(brandsAllowed([...brands], providers)).toEqual([{ key: 'cortex', modes: { snowflake: 'cortex' } }]);
    expect(aiTurnedOff(providers)).toBe(false);
  });

  it('names the connection and method it signs in with, or says why it cannot', () => {
    expect(cortexSignInLine({ connectionSignIn: { connection: 'snowflake', method: 'key_pair' } })).toEqual({ ok: true, text: 'Signs in through the Snowflake connection “snowflake” with its key pair.' });
    expect(cortexSignInLine({ connectionSignIn: { connection: 'app', method: 'oauth' } }).text).toContain('OAuth token');
    const problem = 'Snowflake Cortex signs in with your Snowflake connection\'s key pair, programmatic access token or OAuth token; this connection uses a password.';
    expect(cortexSignInLine({ connectionSignIn: { connection: 'app', method: 'password', problem } })).toEqual({ ok: false, text: problem });
    expect(CORTEX_HELP.join(' ')).toContain('cross-region inference');
  });
});

/**
 * V4 tester: "llama3.1-70b" in Settings » AI provider » Model, then "Test, save & activate": a green "Snowflake
 * Cortex answered" line, no refusal, and a blank field after a reload, so nobody could tell which model was in use.
 */
describe('Test, save & activate says the outcome of both steps', () => {
  const refusal = 'ZLens asks Claude through Snowflake Cortex. Name a Claude model that Cortex offers in your account, such as claude-sonnet-5-5 (not "llama3.1-70b").';

  it('shows the save\'s refusal in place of the test\'s success', async () => {
    const outcome = await testThenSave(
      async () => ({ ok: true, message: 'Snowflake Cortex answered through Cortex SQL (model llama3.1-70b).' }),
      async () => { throw new Error(refusal); },
    );
    expect(outcome).toEqual({ ok: false, failed: 'save', message: refusal });
  });

  it('shows the test\'s refusal, and never saves, when the test refuses', async () => {
    let saved = false;
    const outcome = await testThenSave(async () => ({ ok: false, message: refusal }), async () => { saved = true; return {}; });
    expect(outcome).toEqual({ ok: false, failed: 'test', message: refusal });
    expect(saved).toBe(false);
  });

  it('says the test passed only once the save went through', async () => {
    const outcome = await testThenSave(async () => ({ ok: true, message: 'Snowflake Cortex responded: OK' }), async () => ({ providers: [] }));
    expect(outcome).toEqual({ ok: true, message: 'Snowflake Cortex responded: OK', saved: { providers: [] } });
  });

  it('says which model is in use, the default when none is saved', () => {
    expect(modelInUseLine({ defaultModel: 'claude-sonnet-5-5' })).toBe('In use: claude-sonnet-5-5 (the default)');
    expect(modelInUseLine({ model: ' ', defaultModel: 'claude-sonnet-5-5' })).toBe('In use: claude-sonnet-5-5 (the default)');
    expect(modelInUseLine({ model: 'claude-opus-5', defaultModel: 'claude-sonnet-5-5' })).toBe('In use: claude-opus-5');
    expect(modelInUseLine({})).toBeNull();
    expect(modelInUseLine(undefined)).toBeNull();
  });
});
