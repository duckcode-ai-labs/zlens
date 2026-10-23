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
  return 'Search: meaning-based';
}

/** The line under the switch: whether this computer can run it. */
export function localEmbeddingsHint(input: { reachable: boolean; installed: string[] }): string {
  if (!input.reachable) return 'Ollama is not running on this computer. Start it, then turn this on.';
  if (!input.installed.includes(LOCAL_EMBEDDING_MODEL)) return `Ollama is running. Turning this on downloads ${LOCAL_EMBEDDING_MODEL} (about 270 MB) into Ollama first.`;
  return `Ollama is running with ${LOCAL_EMBEDDING_MODEL}. ZLens uses it only when this is on.`;
}
