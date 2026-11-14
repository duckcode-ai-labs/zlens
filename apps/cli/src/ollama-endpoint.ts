import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ollama's address on this computer, as it installs by default. */
export const LOCAL_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

const LOCAL_ALIASES = new Set([LOCAL_OLLAMA_ENDPOINT, 'http://localhost:11434', 'http://[::1]:11434']);

export const OLLAMA_ENDPOINT_REFUSED = `Use Ollama on this computer (${LOCAL_OLLAMA_ENDPOINT}), or save its address in Settings » AI provider » Search first.`;

function normalized(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

/** The Ollama endpoint saved in the project's embedding settings (dql.config.json `ai.embeddings.endpoint`), if any. */
export function savedOllamaEndpoint(projectRoot: string): string | undefined {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { ai?: { embeddings?: { endpoint?: unknown } } };
    const endpoint = raw.ai?.embeddings?.endpoint;
    return typeof endpoint === 'string' && endpoint.trim() ? normalized(endpoint) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the Ollama model routes (list installed models, pull one) may send a request: Ollama on this computer,
 * or the endpoint saved in the project's settings. A request cannot point the server at any other address.
 * The value returned is never the request's own string: it is the fixed local address or the saved one.
 */
export function allowedOllamaEndpoint(requested: unknown, saved: string | undefined): string | undefined {
  const asked = typeof requested === 'string' && requested.trim() ? normalized(requested) : LOCAL_OLLAMA_ENDPOINT;
  if (LOCAL_ALIASES.has(asked)) return LOCAL_OLLAMA_ENDPOINT;
  if (saved && asked === saved) return saved;
  return undefined;
}
