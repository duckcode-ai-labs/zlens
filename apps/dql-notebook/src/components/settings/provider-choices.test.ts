import { describe, expect, it } from 'vitest';
import { aiTurnedOff, brandsAllowed, providerAllowed } from './provider-choices';

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
