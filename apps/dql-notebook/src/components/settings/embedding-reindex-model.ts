import type { EmbeddingReindexResult, EmbeddingSettingsResponse } from '../../api/client';

export function embeddingReindexOutcome(
  result: EmbeddingReindexResult,
  current: EmbeddingSettingsResponse,
): { ok: boolean; message: string } {
  if (current.reindexRequired) {
    return {
      ok: false,
      message: `Re-index did not complete — ${result.reason ?? 'the catalog is still using a different embedding index'}.`,
    };
  }
  if (result.upgraded) {
    return { ok: true, message: `Catalog re-embedded with ${current.activeProviderId}.` };
  }
  return { ok: true, message: `No re-index needed — ${result.reason ?? 'already current'}.` };
}

/** The local embedding model Settings offers in one switch. */
export const LOCAL_EMBEDDING_MODEL = 'nomic-embed-text';

/** The switch's words: what it uses and that nothing leaves the computer. */
export const LOCAL_EMBEDDINGS_OPTION = `Use local Ollama embeddings (${LOCAL_EMBEDDING_MODEL}) — runs on this computer, nothing leaves it`;

/**
 * What search does now, in words (Codex G2: "active: hashed-token-v1" was an
 * engineering id outside a technical-details disclosure).
 */
export function searchModeLabel(settings: { provider: string; model?: string } | null | undefined, semantic: boolean): string {
  if (!semantic || !settings || settings.provider === 'hashed') return 'Search: word-based';
  if (settings.provider === 'ollama') return `Search: meaning-based · local Ollama${settings.model ? ` (${settings.model})` : ''}`;
  if (settings.provider === 'openai') return `Search: meaning-based · OpenAI${settings.model ? ` (${settings.model})` : ''}`;
  // The model is under Technical details: the long name squeezed the card's text into a narrow column.
  if (settings.provider === 'cortex') return 'Search: meaning-based · Snowflake Cortex';
  return 'Search: meaning-based';
}

/** The line under the switch: whether this computer can run it. */
export function localEmbeddingsHint(input: { reachable: boolean; installed: string[] }): string {
  if (!input.reachable) return 'Ollama is not running on this computer. Start it, then turn this on.';
  if (!input.installed.includes(LOCAL_EMBEDDING_MODEL)) return `Ollama is running. Turning this on downloads ${LOCAL_EMBEDDING_MODEL} (about 270 MB) into Ollama first.`;
  return `Ollama is running with ${LOCAL_EMBEDDING_MODEL}. ZLens uses it only when this is on.`;
}

/** The Cortex model Settings offers in one switch. */
export const CORTEX_EMBEDDING_MODEL = 'snowflake-arctic-embed-l-v2.0';

/** The Cortex switch's words: where it runs and what it costs. */
export const CORTEX_EMBEDDINGS_OPTION = 'Use Snowflake Cortex for meaning-based search — runs in your Snowflake account';

/** The line under the Cortex switch. */
export function cortexEmbeddingsHint(input: { available: boolean; reason?: string }): string {
  if (!input.available) return input.reason ?? 'Snowflake Cortex search is not available for this project.';
  return 'Descriptions of your tables, columns and metrics are embedded with AI_EMBED on your Snowflake connection. A small project costs about a cent of Snowflake credits to index (hundreds of tables, about $0.35 the first time); after that only new text is embedded.';
}
