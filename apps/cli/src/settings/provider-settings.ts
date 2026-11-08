import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnv } from '@zlens/core';
import {
  coerceReasoningEffort,
  supportsReasoningEffort as providerSupportsReasoningEffort,
  type ReasoningEffort,
} from '@zlens/agent';

export type ProviderSettingsId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai' | 'claude-code' | 'codex';

/**
 * Reasoning-effort ceiling for a provider. `'auto'` (the default when unset)
 * lets the agent pick effort per task/route up to `high`; an explicit level caps
 * it there. See `@zlens/agent`'s reasoning-effort helpers.
 */
export type ReasoningEffortSetting = ReasoningEffort | 'auto';

/**
 * How a provider authenticates:
 * - `api_key`: paste an API key (or set the env var).
 * - `local`: a local daemon, no credential (Ollama).
 * - `subscription_cli`: authenticated by an installed coding CLI's own login
 *   (Claude Code / Codex) — no API key; usability is "installed + logged in".
 */
export type ProviderAuthMode = 'api_key' | 'local' | 'subscription_cli';

export interface ProviderSettingsInput {
  id: ProviderSettingsId;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Reasoning-effort ceiling. `'auto'` clears it; omitted leaves it unchanged. */
  reasoningEffort?: ReasoningEffortSetting;
}

export interface StoredProviderSettings extends ProviderSettingsInput {
  updatedAt: string;
  /** Persisted ceiling — `'auto'` is normalized to `undefined` on write. */
  reasoningEffort?: ReasoningEffort;
}

export interface RedactedProviderSettings {
  id: ProviderSettingsId;
  label: string;
  enabled: boolean;
  active: boolean;
  hasApiKey: boolean;
  /** Required non-secret configuration is present. Reachability still requires an explicit test. */
  configured: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  model?: string;
  source: 'local' | 'env' | 'none';
  envVars: string[];
  /** How this provider authenticates (drives the settings UI). */
  authMode: ProviderAuthMode;
  /** For subscription_cli providers: the CLI binary the user must install + log into. */
  command?: string;
  /** Reasoning-effort ceiling (`'auto'` when unset). Only meaningful for reasoning-capable providers. */
  reasoningEffort: ReasoningEffortSetting;
  /** Whether this provider has a reasoning surface at all (drives whether the UI shows the control). */
  supportsReasoningEffort: boolean;
  /** Whether this install lets it be chosen at all (ZLENS_MODEL_PROVIDERS); a provider that is not is never used. */
  allowed: boolean;
}

export interface EffectiveProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  /** Resolved ceiling (local → env), `undefined` means auto (no cap). */
  reasoningEffort?: ReasoningEffort;
}

interface StoredProviderState {
  activeProvider?: ProviderSettingsId;
  providers: Partial<Record<ProviderSettingsId, StoredProviderSettings>>;
}

type ProviderMeta = {
  label: string;
  authMode: ProviderAuthMode;
  command?: string;
  keyEnv?: string;
  modelEnv?: string;
  baseUrlEnv?: string;
  /** Env override for the reasoning-effort ceiling (reasoning-capable providers only). */
  reasoningEffortEnv?: string;
  /**
   * The low-level provider family whose reasoning-effort translation this
   * settings id maps to (`null` = no reasoning surface). Used to decide whether
   * the UI shows a reasoning-effort control for the configured model.
   */
  reasoningFamily?: 'claude' | 'openai' | 'gemini' | null;
};

const PROVIDER_META: Record<ProviderSettingsId, ProviderMeta> = {
  anthropic: { label: 'Anthropic Claude', authMode: 'api_key', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', baseUrlEnv: 'ANTHROPIC_BASE_URL', reasoningEffortEnv: 'ANTHROPIC_REASONING_EFFORT', reasoningFamily: 'claude' },
  openai: { label: 'OpenAI', authMode: 'api_key', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', baseUrlEnv: 'OPENAI_BASE_URL', reasoningEffortEnv: 'OPENAI_REASONING_EFFORT', reasoningFamily: 'openai' },
  gemini: { label: 'Google Gemini', authMode: 'api_key', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', baseUrlEnv: 'GEMINI_BASE_URL', reasoningEffortEnv: 'GEMINI_REASONING_EFFORT', reasoningFamily: 'gemini' },
  ollama: { label: 'Ollama', authMode: 'local', modelEnv: 'OLLAMA_MODEL', baseUrlEnv: 'OLLAMA_BASE_URL', reasoningFamily: null },
  'custom-openai': { label: 'Custom OpenAI-compatible', authMode: 'api_key', keyEnv: 'ZLENS_OPENAI_COMPAT_API_KEY', modelEnv: 'ZLENS_OPENAI_COMPAT_MODEL', baseUrlEnv: 'ZLENS_OPENAI_COMPAT_BASE_URL', reasoningEffortEnv: 'ZLENS_OPENAI_COMPAT_REASONING_EFFORT', reasoningFamily: 'openai' },
  'claude-code': { label: 'Claude subscription (Claude Code CLI)', authMode: 'subscription_cli', command: 'claude', modelEnv: 'CLAUDE_CODE_MODEL', reasoningFamily: null },
  codex: { label: 'ChatGPT subscription (Codex CLI)', authMode: 'subscription_cli', command: 'codex', modelEnv: 'CODEX_MODEL', reasoningFamily: null },
};

/**
 * Does the provider's currently-configured model expose a reasoning surface?
 * Reasoning-family providers with an unset model default to `true` (the user
 * will typically pick an o-series/gpt-5/Opus/2.5 model); a set model is checked
 * against the family's capability so we never show a control that no-ops.
 */
function providerReasoningSupported(meta: ProviderMeta, model: string | undefined): boolean {
  if (meta.authMode !== 'api_key' || !meta.reasoningFamily) return false;
  if (!model) return true;
  return providerSupportsReasoningEffort(meta.reasoningFamily, model);
}

export function providerSettingsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'provider-settings.json');
}

/**
 * ZLENS_MODEL_PROVIDERS: the model providers this install lets a person choose, as settings ids
 * separated by commas (`anthropic,ollama`), or `none` for no model at all. Unset: every provider.
 * For a packaged app whose installer chose the model. Unknown ids are ignored.
 */
export function allowedModelProviders(env: NodeJS.ProcessEnv = process.env): ProviderSettingsId[] | null {
  const raw = readEnv('ZLENS_MODEL_PROVIDERS', env)?.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'none') return [];
  return raw.split(',').map((id) => id.trim().toLowerCase()).filter(isProviderSettingsId);
}

/** Whether this install lets `id` be chosen. A host's own model (no settings id) is the host's call. */
export function modelProviderAllowed(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = allowedModelProviders(env);
  if (allowed === null || !isProviderSettingsId(id)) return true;
  return allowed.includes(id);
}

export function listProviderSettings(projectRoot: string): RedactedProviderSettings[] {
  // A provider this install does not allow is listed as off, never configured or active.
  return listAllProviderSettings(projectRoot).map((provider) => modelProviderAllowed(provider.id)
    ? provider
    : { ...provider, enabled: false, configured: false, active: false, allowed: false });
}

function listAllProviderSettings(projectRoot: string): RedactedProviderSettings[] {
  const state = readStoredProviderState(projectRoot);
  const stored = state.providers;
  return (Object.keys(PROVIDER_META) as ProviderSettingsId[]).map((id) => {
    const meta = PROVIDER_META[id];
    const local = stored[id];
    const envKey = meta.keyEnv ? process.env[meta.keyEnv] : undefined;
    const hasLocalKey = Boolean(local?.apiKey?.trim());
    const hasEnvKey = Boolean(envKey?.trim());
    const resolvedBaseUrl = local?.baseUrl || (meta.baseUrlEnv ? process.env[meta.baseUrlEnv] : undefined);
    const resolvedModel = local?.model || (meta.modelEnv ? process.env[meta.modelEnv] : undefined);
    // Subscription CLI providers carry no API key — their usability is "installed +
    // logged in", checked at runtime. In settings they're simply on/off (default off).
    if (meta.authMode === 'subscription_cli') {
      const enabled = local?.enabled ?? false;
      return {
        id,
        label: meta.label,
        enabled,
        active: state.activeProvider === id,
        hasApiKey: false,
        configured: enabled,
        baseUrl: undefined,
        model: resolvedModel,
        source: enabled ? 'local' : 'none',
        envVars: [meta.modelEnv].filter(Boolean) as string[],
        authMode: meta.authMode,
        command: meta.command,
        reasoningEffort: 'auto',
        supportsReasoningEffort: false,
        allowed: true,
      };
    }
    const configured = id === 'ollama'
      ? Boolean(resolvedBaseUrl?.trim() || resolvedModel?.trim())
      : id === 'custom-openai'
        ? Boolean(resolvedBaseUrl?.trim() && resolvedModel?.trim())
        : hasLocalKey || hasEnvKey;
    return {
      id,
      label: meta.label,
      enabled: local?.enabled ?? configured,
      active: state.activeProvider === id,
      hasApiKey: hasLocalKey || hasEnvKey,
      configured,
      apiKeyPreview: hasLocalKey ? previewSecret(local!.apiKey!) : hasEnvKey ? `${meta.keyEnv}=set` : undefined,
      baseUrl: resolvedBaseUrl,
      model: resolvedModel,
      source: hasLocalKey || local?.baseUrl || local?.model ? 'local' : hasEnvKey || envHas(meta) ? 'env' : 'none',
      envVars: [meta.keyEnv, meta.modelEnv, meta.baseUrlEnv, meta.reasoningEffortEnv].filter(Boolean) as string[],
      authMode: meta.authMode,
      command: meta.command,
      reasoningEffort: resolveReasoningEffortSetting(local, meta) ?? 'auto',
      supportsReasoningEffort: providerReasoningSupported(meta, resolvedModel),
      allowed: true,
    };
  });
}

/** Resolve a provider's stored/env reasoning-effort ceiling, or `undefined` for auto. */
function resolveReasoningEffortSetting(
  local: StoredProviderSettings | undefined,
  meta: ProviderMeta,
): ReasoningEffort | undefined {
  if (local?.reasoningEffort) return local.reasoningEffort;
  if (meta.reasoningEffortEnv) return coerceReasoningEffort(process.env[meta.reasoningEffortEnv]);
  return undefined;
}

export function getEffectiveProviderConfig(projectRoot: string, id: ProviderSettingsId): EffectiveProviderConfig {
  const stored = readStoredProviderState(projectRoot).providers[id];
  const meta = PROVIDER_META[id];
  // A host's own model (RFC 0010 HH-5, e.g. `bedrock` or `vertex`) has no local settings.
  if (!meta) return { enabled: true };
  if (!modelProviderAllowed(id)) return { enabled: false };
  return {
    apiKey: stored?.apiKey || (meta.keyEnv ? process.env[meta.keyEnv] : undefined),
    baseUrl: stored?.baseUrl || (meta.baseUrlEnv ? process.env[meta.baseUrlEnv] : undefined),
    model: stored?.model || (meta.modelEnv ? process.env[meta.modelEnv] : undefined),
    enabled: stored?.enabled ?? true,
    reasoningEffort: resolveReasoningEffortSetting(stored, meta),
  };
}

export function getActiveProvider(projectRoot: string): ProviderSettingsId | undefined {
  const active = readStoredProviderState(projectRoot).activeProvider;
  return active && modelProviderAllowed(active) ? active : undefined;
}

export function saveProviderSettings(projectRoot: string, input: ProviderSettingsInput): RedactedProviderSettings[] {
  if (!modelProviderAllowed(input.id)) throw new Error(`The ${input.id} model provider is not available on this install (ZLENS_MODEL_PROVIDERS).`);
  const state = readStoredProviderState(projectRoot);
  const stored = state.providers;
  const existing = stored[input.id];
  const next: StoredProviderSettings = {
    id: input.id,
    enabled: input.enabled ?? existing?.enabled ?? true,
    // Blank secret fields mean "keep the existing secret" across every UI/API
    // surface. We never echo a stored key back merely to make edits possible.
    apiKey: input.apiKey === undefined || input.apiKey.trim() === '' ? existing?.apiKey : input.apiKey.trim(),
    baseUrl: input.baseUrl === undefined ? existing?.baseUrl : input.baseUrl.trim() || undefined,
    model: input.model === undefined ? existing?.model : input.model.trim() || undefined,
    // `undefined` = leave unchanged; `'auto'` = clear the ceiling; a level = set it.
    reasoningEffort: input.reasoningEffort === undefined
      ? existing?.reasoningEffort
      : input.reasoningEffort === 'auto'
        ? undefined
        : coerceReasoningEffort(input.reasoningEffort),
    updatedAt: new Date().toISOString(),
  };
  stored[input.id] = next;
  if (next.enabled === false && state.activeProvider === input.id) {
    state.activeProvider = undefined;
  } else if (next.enabled !== false && providerCanBeActive(input.id, next)) {
    state.activeProvider = input.id;
  }
  writeStoredProviderState(projectRoot, state);
  return listProviderSettings(projectRoot);
}

function readStoredProviderState(projectRoot: string): StoredProviderState {
  const path = providerSettingsPath(projectRoot);
  if (!existsSync(path)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      activeProvider?: ProviderSettingsId;
      providers?: Partial<Record<ProviderSettingsId, StoredProviderSettings>>;
    };
    return {
      activeProvider: isProviderSettingsId(parsed.activeProvider) ? parsed.activeProvider : undefined,
      providers: parsed.providers ?? {},
    };
  } catch {
    return { providers: {} };
  }
}

function writeStoredProviderState(projectRoot: string, state: StoredProviderState): void {
  const path = providerSettingsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    ...(state.activeProvider ? { activeProvider: state.activeProvider } : {}),
    providers: state.providers,
  }, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that support chmod.
  }
}

function envHas(meta: { modelEnv?: string; baseUrlEnv?: string }): boolean {
  return Boolean((meta.modelEnv && process.env[meta.modelEnv]) || (meta.baseUrlEnv && process.env[meta.baseUrlEnv]));
}

function providerCanBeActive(id: ProviderSettingsId, stored: StoredProviderSettings): boolean {
  if (stored.enabled === true) return true;
  const meta = PROVIDER_META[id];
  // Subscription CLI providers need no key/URL — an explicit `enabled: true` (handled
  // above) is the only way to auto-activate them; reaching here means not enabled.
  if (meta.authMode === 'subscription_cli') return false;
  const hasKey = Boolean(stored.apiKey?.trim() || (meta.keyEnv && process.env[meta.keyEnv]?.trim()));
  const hasBaseUrl = Boolean(stored.baseUrl?.trim() || (meta.baseUrlEnv && process.env[meta.baseUrlEnv]?.trim()));
  const hasModel = Boolean(stored.model?.trim() || (meta.modelEnv && process.env[meta.modelEnv]?.trim()));
  if (id === 'ollama') return hasBaseUrl || hasModel;
  if (id === 'custom-openai') return hasBaseUrl;
  return hasKey;
}

export function isProviderSettingsId(value: unknown): value is ProviderSettingsId {
  return value === 'anthropic'
    || value === 'openai'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom-openai'
    || value === 'claude-code'
    || value === 'codex';
}

function previewSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
