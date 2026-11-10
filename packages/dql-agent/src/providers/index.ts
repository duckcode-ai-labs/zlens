/**
 * Provider registry. The `pickProvider()` helper falls back through the
 * configured list and returns the first one that has its credentials.
 *
 * Order is intentional: closed-source first (Claude → OpenAI → Gemini),
 * Ollama last as the local-only fallback.
 */

import type { AgentProvider, ProviderName } from './types.js';
import { ClaudeProvider, normalizeAnthropicBaseUrl } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider, normalizeGeminiBaseUrl } from './gemini.js';
import { OllamaProvider, ollamaBaseUrl, ollamaNotRunning, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';

export { extractProviderUsage, extractStreamedClaudeUsage, recordProviderUsage, setProviderUsageListener, type ProviderUsage, type ProviderUsageLine, type ProviderUsageListener } from './usage-ledger.js';
export { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';

export type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  ProviderName,
  ProviderDispatchEvent,
  ProviderDispatchCompletionEvent,
  ProviderDispatchCompletionObserver,
  ProviderDispatchRejectionEvent,
  ProviderDispatchRejectionObserver,
  ProviderDispatchObserver,
  ProviderDispatchOperation,
  ProviderRunOptions,
  ProviderCurrentToolPolicy,
  ProviderPhysicalDispatchPhaseResolver,
  ProviderToolLoopOptions,
  NativeToolLoopStop,
  NativeToolLoopResult,
} from './types.js';
export { streamOrGenerate } from './types.js';
export { PROVIDER_DISPATCH_PHYSICAL_CEILING, providerDispatchLimit, prepareProviderHttpDispatch, completeProviderHttpDispatch, fetchProviderHttpDispatch } from './dispatch.js';
export { ClaudeProvider, OpenAIProvider, GeminiProvider, OllamaProvider, normalizeAnthropicBaseUrl, normalizeGeminiBaseUrl, ollamaBaseUrl, ollamaNotRunning, DEFAULT_OLLAMA_BASE_URL };
export { runAnthropicNativeToolLoop, anthropicToolLoopPost, type AnthropicToolLoopTransport } from './claude.js';
export {
  bedrockClaudeTransport,
  createBedrockClaudeProvider,
  createVertexClaudeProvider,
  defaultAwsCredentials,
  defaultGoogleAccessToken,
  signAwsRequest,
  vertexClaudeTransport,
  vertexHost,
  type AwsCredentials,
  type BedrockClaudeOptions,
  type GoogleAccessToken,
  type VertexClaudeOptions,
} from './claude-cloud.js';
export {
  CORTEX_DEFAULT_MODEL,
  CortexClaudeProvider,
  cortexBaseUrl,
  cortexClaudeTransport,
  isCortexClaudeProvider,
  snowflakeHost,
  snowflakeJwtAccount,
  snowflakeKeyPairJwt,
  snowflakeKeyPairToken,
  snowflakeTokenFileToken,
  CORTEX_REST_RETRY_AFTER_MS,
  cortexFailureInWords,
  cortexRoute,
  cortexSqlComplete,
  isCortexRestRefusal,
  messagesRequestAsPrompt,
  resetCortexRoute,
  type CortexSqlRunner,
  type CortexClaudeOptions,
  type CortexToken,
  type CortexTokenType,
} from './claude-cortex.js';
export {
  BedrockConverseProvider,
  bedrockConverseTransport,
  createBedrockConverseProvider,
  type BedrockConverseOptions,
} from './bedrock-converse.js';
export type { ProviderHttpTransport } from './dispatch.js';
export type { ReasoningEffort, GeminiReasoningStyle, ThinkingMode } from './reasoning-effort.js';
export {
  REASONING_EFFORTS,
  isReasoningEffort,
  coerceReasoningEffort,
  clampReasoningEffort,
  bumpReasoningEffort,
  supportsReasoningEffort,
  geminiReasoningStyle,
  effortToThinkingBudget,
  THINKING_MODES,
  isThinkingMode,
  coerceThinkingMode,
  resolveThinkingMode,
} from './reasoning-effort.js';

const FALLBACK_ORDER: ProviderName[] = ['claude', 'openai', 'gemini', 'ollama'];

export function buildProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case 'claude':
      return new ClaudeProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
    case 'bedrock':
      throw new Error('bedrock: needs a region and a model; the host builds it with createBedrockConverseProvider');
  }
}

/**
 * Pick a provider:
 *   - If `preferred` is set, return it (no availability check, fail-fast at use time).
 *   - Otherwise probe FALLBACK_ORDER and return the first available.
 *   - If nothing is available, return the Ollama provider (so callers get
 *     a usable error message at generate time).
 */
export async function pickProvider(preferred?: ProviderName): Promise<AgentProvider> {
  if (preferred) return buildProvider(preferred);
  for (const name of FALLBACK_ORDER) {
    const p = buildProvider(name);
    if (await p.available()) return p;
  }
  return buildProvider('ollama');
}
