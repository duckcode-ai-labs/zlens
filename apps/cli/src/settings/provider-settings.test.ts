import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cortexModelRefusal,
  getEffectiveProviderConfig,
  isCortexClaudeModel,
  listProviderSettings,
  saveProviderSettings,
} from './provider-settings.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-provider-settings-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ANTHROPIC_REASONING_EFFORT;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.ZLENS_OPENAI_COMPAT_BASE_URL;
  delete process.env.ZLENS_OPENAI_COMPAT_MODEL;
});

describe('provider configured state', () => {
  it('does not report default Ollama or empty hosted providers as configured', () => {
    const providers = listProviderSettings(root);
    expect(providers.find((p) => p.id === 'ollama')).toMatchObject({ enabled: false, configured: false });
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({ enabled: false, configured: false });
  });

  it('reports native API-key and local providers from saved or environment configuration', () => {
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'sk-ant-test', baseUrl: 'https://gateway.example/anthropic' });
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    const providers = listProviderSettings(root);
    expect(providers.find((p) => p.id === 'anthropic')).toMatchObject({ enabled: true, configured: true, hasApiKey: true });
    expect(providers.find((p) => p.id === 'ollama')).toMatchObject({ enabled: true, configured: true });
  });

  it('requires both base URL and model for a custom OpenAI-compatible provider', () => {
    saveProviderSettings(root, { id: 'custom-openai', enabled: true, baseUrl: 'https://gateway.example/v1' });
    expect(listProviderSettings(root).find((p) => p.id === 'custom-openai')!.configured).toBe(false);
    saveProviderSettings(root, { id: 'custom-openai', model: 'enterprise-model' });
    expect(listProviderSettings(root).find((p) => p.id === 'custom-openai')).toMatchObject({ configured: true, hasApiKey: false });
  });

  it('preserves a stored secret when a later edit omits the key and never returns it raw', () => {
    saveProviderSettings(root, { id: 'openai', apiKey: 'sk-secret-value', model: 'gpt-enterprise' });
    saveProviderSettings(root, { id: 'openai', apiKey: '', baseUrl: 'https://gateway.example/v1' });
    expect(getEffectiveProviderConfig(root, 'openai').apiKey).toBe('sk-secret-value');
    const redacted = listProviderSettings(root).find((p) => p.id === 'openai')!;
    expect(redacted.apiKeyPreview).not.toContain('secret');
    expect(JSON.stringify(redacted)).not.toContain('sk-secret-value');
  });

  it('treats native-provider Base URL and model as optional readiness inputs', () => {
    saveProviderSettings(root, { id: 'openai', apiKey: 'openai-key' });
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'anthropic-key', baseUrl: 'https://anthropic.enterprise.example/v1' });
    saveProviderSettings(root, { id: 'gemini', apiKey: 'gemini-key', model: 'gemini-enterprise' });
    const providers = listProviderSettings(root);
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({ configured: true, baseUrl: undefined, model: undefined });
    expect(providers.find((p) => p.id === 'anthropic')).toMatchObject({ configured: true, baseUrl: 'https://anthropic.enterprise.example/v1' });
    expect(providers.find((p) => p.id === 'gemini')).toMatchObject({ configured: true, model: 'gemini-enterprise' });
  });

  it('marks an explicitly enabled subscription provider as configured without inventing a key', () => {
    saveProviderSettings(root, { id: 'claude-code', enabled: true, model: 'claude-sonnet-5' });
    expect(listProviderSettings(root).find((p) => p.id === 'claude-code')).toMatchObject({ configured: true, hasApiKey: false });
  });
});

describe('a host\'s own model (RFC 0010 HH-5)', () => {
  it('has an empty local config instead of failing, for ids ZLens does not know (bedrock, vertex)', () => {
    expect(getEffectiveProviderConfig(root, 'bedrock' as never)).toEqual({ enabled: true });
    expect(getEffectiveProviderConfig(root, 'vertex' as never).reasoningEffort).toBeUndefined();
  });
});

describe('provider reasoning-effort settings', () => {
  it('defaults to auto (no ceiling) when unset', () => {
    const cfg = getEffectiveProviderConfig(root, 'anthropic');
    expect(cfg.reasoningEffort).toBeUndefined();
    const redacted = listProviderSettings(root).find((p) => p.id === 'anthropic')!;
    expect(redacted.reasoningEffort).toBe('auto');
  });

  it('persists an explicit ceiling and reads it back', () => {
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'k', reasoningEffort: 'medium' });
    expect(getEffectiveProviderConfig(root, 'anthropic').reasoningEffort).toBe('medium');
    expect(listProviderSettings(root).find((p) => p.id === 'anthropic')!.reasoningEffort).toBe('medium');
  });

  it("clears the ceiling back to auto when saved as 'auto'", () => {
    saveProviderSettings(root, { id: 'openai', apiKey: 'k', reasoningEffort: 'high' });
    expect(getEffectiveProviderConfig(root, 'openai').reasoningEffort).toBe('high');
    saveProviderSettings(root, { id: 'openai', reasoningEffort: 'auto' });
    expect(getEffectiveProviderConfig(root, 'openai').reasoningEffort).toBeUndefined();
  });

  it('leaves the ceiling unchanged when reasoningEffort is omitted on save', () => {
    saveProviderSettings(root, { id: 'gemini', apiKey: 'k', reasoningEffort: 'low' });
    saveProviderSettings(root, { id: 'gemini', model: 'gemini-2.5-pro' }); // unrelated edit
    expect(getEffectiveProviderConfig(root, 'gemini').reasoningEffort).toBe('low');
  });

  it('falls back to the provider env override when nothing is stored', () => {
    process.env.ANTHROPIC_REASONING_EFFORT = 'high';
    expect(getEffectiveProviderConfig(root, 'anthropic').reasoningEffort).toBe('high');
  });

  it('surfaces model reasoning-capability so the UI can show/hide the control', () => {
    // Default Claude model reasons; a non-reasoning model turns it off.
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'k', model: 'claude-opus-4-7' });
    expect(listProviderSettings(root).find((p) => p.id === 'anthropic')!.supportsReasoningEffort).toBe(true);
    saveProviderSettings(root, { id: 'openai', apiKey: 'k', model: 'gpt-4.1-mini' });
    expect(listProviderSettings(root).find((p) => p.id === 'openai')!.supportsReasoningEffort).toBe(false);
    // Local + subscription providers never expose the control.
    expect(listProviderSettings(root).find((p) => p.id === 'ollama')!.supportsReasoningEffort).toBe(false);
    expect(listProviderSettings(root).find((p) => p.id === 'claude-code')!.supportsReasoningEffort).toBe(false);
  });
});

describe('Snowflake Cortex models (the listing names Claude models only)', () => {
  it('keeps the default when no model is named, and accepts any Claude model Cortex names', () => {
    saveProviderSettings(root, { id: 'cortex', model: '' });
    expect(getEffectiveProviderConfig(root, 'cortex').model).toBeUndefined();
    saveProviderSettings(root, { id: 'cortex', model: ' claude-opus-4-7 ' });
    expect(getEffectiveProviderConfig(root, 'cortex').model).toBe('claude-opus-4-7');
    expect(isCortexClaudeModel('claude-sonnet-5')).toBe(true);
    expect(isCortexClaudeModel('claude-3-5-sonnet')).toBe(true);
  });

  it('refuses a model that is not Claude, and keeps the one saved before', () => {
    saveProviderSettings(root, { id: 'cortex', model: 'claude-sonnet-5' });
    for (const model of ['llama3.1-70b', 'mistral-large2', 'openai-gpt-4.1', 'claude', 'claude-']) {
      expect(() => saveProviderSettings(root, { id: 'cortex', model })).toThrow(/Claude model that Cortex offers/);
    }
    expect(getEffectiveProviderConfig(root, 'cortex').model).toBe('claude-sonnet-5');
  });

  it('says why in one sentence, the same for Save and the test, and names the default model in use', () => {
    expect(cortexModelRefusal(undefined)).toBeUndefined();
    expect(cortexModelRefusal('  ')).toBeUndefined();
    expect(cortexModelRefusal('claude-sonnet-5-5')).toBeUndefined();
    expect(cortexModelRefusal(' llama3.1-70b ')).toBe('ZLens asks Claude through Snowflake Cortex. Name a Claude model that Cortex offers in your account, such as claude-sonnet-5-5 (not "llama3.1-70b").');
    expect(() => saveProviderSettings(root, { id: 'cortex', model: 'llama3.1-70b' })).toThrow(cortexModelRefusal('llama3.1-70b')!);
    expect(listProviderSettings(root).find((p) => p.id === 'cortex')).toMatchObject({ defaultModel: 'claude-sonnet-5-5' });
    // Other providers carry no default of ZLens's own.
    expect(listProviderSettings(root).find((p) => p.id === 'anthropic')?.defaultModel).toBeUndefined();
  });
});
