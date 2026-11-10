/**
 * Pluggable semantic retrieval (Part B).
 *
 * `EmbeddingProvider` is the interface real providers (a local model, an API)
 * plug into. The DEFAULT provider is a deterministic, offline, hashed-token
 * vector — NO heavy model dependency is added. FTS5/BM25 remains the safe
 * default ranker; hybrid ranking blends FTS relevance with cosine similarity
 * from the configured provider.
 *
 * Determinism matters: the default provider must produce identical vectors for
 * identical text so tests are stable offline.
 */

import { createHash } from 'node:crypto';
import { CORTEX_DEFAULT_EMBEDDING_MODEL, CortexEmbeddingProvider, isCortexEmbeddingModel } from './cortex.js';
import { readEnv } from '@zlens/core';

export interface EmbeddingProvider {
  /** Provider id, surfaced in diagnostics, e.g. "hashed-token-v1". */
  readonly id: string;
  /** Vector dimensionality. */
  readonly dimensions: number;
  /** Embed a batch of texts. Must be deterministic for the default provider. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Embed a search question. Models trained with an instruction in front of questions (Snowflake Cortex's
   * arctic models) add it here; without this method a question is embedded like any text.
   */
  embedQuery?(text: string): Promise<number[]>;
  /** Texts per `embed` call that suit this provider when a whole index is rebuilt (default 96). */
  readonly preferredBatchSize?: number;
}

/** A search question's vector: the provider's question form when it has one. */
export async function embedSearchQuery(provider: EmbeddingProvider, text: string): Promise<number[]> {
  if (provider.embedQuery) return provider.embedQuery(text);
  const [vector] = await provider.embed([text]);
  return vector ?? [];
}

/** Cosine similarity in [-1, 1]; 0 for degenerate vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/**
 * Deterministic, dependency-free embedding via the hashing trick: each token is
 * hashed to a bucket and a sign; counts accumulate into a fixed-width vector,
 * then the vector is L2-normalised. Captures lexical overlap so semantically
 * similar (shared-token) texts score higher under cosine similarity — enough to
 * make hybrid ranking testable offline without any model.
 */
export class HashedTokenEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hashed-token-v1';
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = Math.max(16, dimensions);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const h = hashToken(token);
      const bucket = h % this.dimensions;
      const sign = (h >>> 8) % 2 === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    // L2 normalise so cosine reduces to a dot product and magnitudes are comparable.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

function hashToken(token: string): number {
  const digest = createHash('sha1').update(token).digest();
  // First 4 bytes as an unsigned int.
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

/** The safe default provider: deterministic + offline. */
export function defaultEmbeddingProvider(): EmbeddingProvider {
  return new HashedTokenEmbeddingProvider();
}

/** Minimal fetch signature so the OpenAI provider stays dependency-free and testable. */
export type EmbeddingFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
  fetchImpl?: EmbeddingFetch;
}

/**
 * Real embeddings via an OpenAI-compatible `/embeddings` endpoint (dependency-free
 * over fetch). Opt-in: only constructed when an API key is configured. Falls back
 * to the hashed provider at the resolver level when unavailable, so offline and
 * un-keyed projects keep working deterministically.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: EmbeddingFetch;

  constructor(options: OpenAIEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.dimensions = options.dimensions ?? 1536;
    this.id = `openai:${this.model}`;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<EmbeddingFetch>);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = payload.data ?? [];
    // Preserve request order via the returned index.
    const out: number[][] = new Array(texts.length).fill(null).map(() => []);
    rows.forEach((row, i) => {
      const index = typeof row.index === 'number' ? row.index : i;
      out[index] = row.embedding ?? [];
    });
    return out;
  }
}

export interface OllamaEmbeddingOptions {
  endpoint?: string;
  model?: string;
  dimensions?: number;
  fetchImpl?: EmbeddingFetch;
}

/**
 * Local-first embeddings via an Ollama server (raw fetch to `/api/embed`, no SDK).
 * Opt-in: only constructed when an Ollama endpoint is configured. Keeps DQL fully
 * local — a stakeholder can run a real embedder on their own machine with no data
 * leaving it. Falls back to the hashed provider at the resolver level when absent.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: EmbeddingFetch;

  constructor(options: OllamaEmbeddingOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = options.model ?? 'nomic-embed-text';
    this.dimensions = options.dimensions ?? 768;
    this.id = `ollama:${this.model}`;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<EmbeddingFetch>);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(`${this.endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Ollama embedding request failed (${response.status})`);
    const payload = await response.json() as { embeddings?: number[][] };
    const embeddings = payload.embeddings ?? [];
    // Ollama returns embeddings in request order.
    return texts.map((_, i) => embeddings[i] ?? []);
  }
}

/**
 * Content-hash cache around any provider so repeated texts (block example
 * questions, metric labels) are embedded once. Bounded LRU-ish by insertion order.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly preferredBatchSize?: number;
  private readonly inner: EmbeddingProvider;
  private readonly cache = new Map<string, number[]>();
  private readonly maxEntries: number;

  constructor(inner: EmbeddingProvider, maxEntries = 4096) {
    this.inner = inner;
    this.id = `cached:${inner.id}`;
    this.dimensions = inner.dimensions;
    this.preferredBatchSize = inner.preferredBatchSize;
    if (inner.embedQuery) {
      this.embedQuery = async (text: string): Promise<number[]> => {
        const key = `query:${createHash('sha1').update(text).digest('hex')}`;
        const hit = this.cache.get(key);
        if (hit) return hit;
        const vector = await embedSearchQuery(this.inner, text);
        this.put(key, vector);
        return vector;
      };
    }
    this.maxEntries = maxEntries;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const missingByKey = new Map<string, string>();
    const keys = texts.map((text) => {
      const key = createHash('sha1').update(text).digest('hex');
      if (!this.cache.has(key) && !missingByKey.has(key)) missingByKey.set(key, text);
      return key;
    });
    const resolvedThisBatch = new Map<string, number[]>();
    const missing = Array.from(missingByKey, ([key, text]) => ({ key, text }));
    if (missing.length > 0) {
      const vectors = await this.inner.embed(missing.map((entry) => entry.text));
      missing.forEach((entry, i) => {
        const vector = vectors[i] ?? [];
        resolvedThisBatch.set(entry.key, vector);
        this.put(entry.key, vector);
      });
    }
    // A single batch may exceed maxEntries. Early vectors can be evicted before
    // this method returns, so retain the batch-local result instead of returning
    // empty vectors or introducing order bias.
    return keys.map((key) => this.cache.get(key) ?? resolvedThisBatch.get(key) ?? []);
  }

  /** Present only when the wrapped provider has a question form, so other providers embed exactly as before. */
  readonly embedQuery?: (text: string) => Promise<number[]>;

  private put(key: string, vector: number[]): void {
    this.cache.set(key, vector);
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

/**
 * Wrap a real provider so a transient failure (Ollama down, API error) degrades to
 * the deterministic hashed provider instead of breaking retrieval. A single embed()
 * batch is all-real or all-fallback, so dimensions stay consistent within a call.
 */
export class ResilientEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly preferredBatchSize?: number;
  private readonly inner: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider;
  private warned = false;

  constructor(inner: EmbeddingProvider, fallback: EmbeddingProvider = defaultEmbeddingProvider()) {
    this.inner = inner;
    this.fallback = fallback;
    this.id = `resilient:${inner.id}`;
    this.dimensions = inner.dimensions;
    this.preferredBatchSize = inner.preferredBatchSize;
    if (inner.embedQuery) {
      this.embedQuery = async (text: string): Promise<number[]> => {
        try {
          return await embedSearchQuery(this.inner, text);
        } catch (err) {
          if (!this.warned) {
            this.warned = true;
            console.warn(`Embedding provider ${this.inner.id} failed; falling back to hashed embeddings. ${(err as Error).message}`);
          }
          return embedSearchQuery(this.fallback, text);
        }
      };
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      return await this.inner.embed(texts);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`Embedding provider ${this.inner.id} failed; falling back to hashed embeddings. ${(err as Error).message}`);
      }
      return this.fallback.embed(texts);
    }
  }

  /** Present only when the wrapped provider has a question form. */
  readonly embedQuery?: (text: string) => Promise<number[]>;
}

export interface EmbeddingResolveOptions {
  /** A Snowflake Cortex embedding model (`snowflake-arctic-embed-m-v1.5`): meaning search inside Snowflake. */
  cortexModel?: string;
  /** Where Cortex vectors already paid for are kept (the project's `.dql/cache`). */
  cortexCachePath?: string;
  /** Local Ollama endpoint (preferred for local-first OSS), e.g. http://127.0.0.1:11434. */
  ollamaEndpoint?: string;
  ollamaModel?: string;
  /** API key for an OpenAI-compatible embeddings endpoint. */
  openaiApiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: EmbeddingFetch;
}

/**
 * Pick the best available embedding provider: a LOCAL Ollama embedder when an
 * endpoint is configured (preferred — keeps data on-machine), else a real
 * OpenAI-compatible embedder when an API key is set, else the safe deterministic
 * hashed-token provider. All real providers are wrapped in a content-hash cache.
 * This is the single place config chooses an embedder, so retrieval/matching call
 * sites just call resolveEmbeddingProvider().
 */
/** Default local Ollama endpoint auto-detection targets. */
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const OLLAMA_EMBED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'bge-m3', 'snowflake-arctic-embed'];

export interface LocalOllamaEmbeddings {
  endpoint: string;
  model: string;
}

/**
 * Zero-config semantic search: probe a locally-running Ollama for a pulled embedding
 * model, so OSS users who have Ollama get real semantic recall without setting any
 * env var. Returns the endpoint + the first available embedding model, or null when
 * Ollama isn't reachable or has no embedding model pulled. Deliberately NOT called by
 * the library's default resolver (that stays deterministic-hashed for tests/CI) — the
 * app runtime calls this once at startup and exports the result via env.
 */
export type ProbeFetch = (
  url: string,
  init: { method: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function probeLocalOllamaEmbeddings(
  endpoint: string = DEFAULT_OLLAMA_ENDPOINT,
  fetchImpl: ProbeFetch = ((url, init) => fetch(url, init) as ReturnType<ProbeFetch>),
  timeoutMs = 400,
): Promise<LocalOllamaEmbeddings | null> {
  const base = endpoint.replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<EmbeddingFetch>>;
    try {
      response = await fetchImpl(`${base}/api/tags`, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const installed = (payload.models ?? []).map((m) => (m.name ?? m.model ?? '').toLowerCase());
    // Prefer a known embedding model; match on the name stem so "nomic-embed-text:latest" counts.
    const match = OLLAMA_EMBED_MODELS.find((known) => installed.some((name) => name.startsWith(known)));
    const model = match
      ?? installed.find((name) => name.includes('embed'))?.replace(/:.*$/, '');
    return model ? { endpoint: base, model } : null;
  } catch {
    return null; // Ollama not running / not reachable — caller falls back to hashed.
  }
}

export function resolveEmbeddingProvider(options: EmbeddingResolveOptions = {}): EmbeddingProvider {
  if (options.cortexModel) {
    return new CachingEmbeddingProvider(new ResilientEmbeddingProvider(new CortexEmbeddingProvider({
      model: options.cortexModel,
      ...(options.cortexCachePath ? { cachePath: options.cortexCachePath } : {}),
    })));
  }
  if (options.ollamaEndpoint) {
    return new CachingEmbeddingProvider(new ResilientEmbeddingProvider(new OllamaEmbeddingProvider({
      endpoint: options.ollamaEndpoint,
      ...(options.ollamaModel ? { model: options.ollamaModel } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })));
  }
  if (options.openaiApiKey) {
    return new CachingEmbeddingProvider(new ResilientEmbeddingProvider(new OpenAIEmbeddingProvider({
      apiKey: options.openaiApiKey,
      ...(options.model ? { model: options.model } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })));
  }
  return defaultEmbeddingProvider();
}

/**
 * Read embedding config from environment (local-first). Lets retrieval/matching
 * light up a real embedder without threading config through every call site.
 * `ZLENS_OLLAMA_EMBED_URL` / `ZLENS_OLLAMA_EMBED_MODEL` for Ollama; `ZLENS_OPENAI_API_KEY`
 * for an OpenAI-compatible endpoint. A general `OPENAI_API_KEY` is deliberately
 * ignored: answer-provider credentials are not implicit authorization to export
 * enterprise catalog text for retrieval. Absent ⇒ hashed default.
 */
export function embeddingOptionsFromEnv(env: Record<string, string | undefined> = process.env): EmbeddingResolveOptions {
  const options: EmbeddingResolveOptions = {};
  // The ZLens app for Snowflake sets this: meaning search through Cortex, inside the customer's account.
  if (readEnv('ZLENS_EMBEDDINGS', env)?.trim().toLowerCase() === 'cortex') {
    options.cortexModel = readEnv('ZLENS_CORTEX_EMBED_MODEL', env)?.trim() || CORTEX_DEFAULT_EMBEDDING_MODEL;
    return options;
  }
  const ollamaEndpoint = readEnv('ZLENS_OLLAMA_EMBED_URL', env);
  const openaiApiKey = readEnv('ZLENS_OPENAI_API_KEY', env);
  if (ollamaEndpoint) {
    options.ollamaEndpoint = ollamaEndpoint;
    const ollamaModel = readEnv('ZLENS_OLLAMA_EMBED_MODEL', env);
    if (ollamaModel) options.ollamaModel = ollamaModel;
  } else if (openaiApiKey) {
    options.openaiApiKey = openaiApiKey;
    const model = readEnv('ZLENS_OPENAI_EMBED_MODEL', env);
    if (model) options.model = model;
  }
  return options;
}

/**
 * The embedding provider configured via environment (Ollama → OpenAI → hashed).
 * Retrieval/matching call sites use this so a project that configures a real local
 * embedder gets true semantic recall, while offline/unconfigured projects stay on
 * the deterministic hashed provider with byte-identical behavior.
 */
let cachedEnvEmbeddingProvider: { key: string; provider: EmbeddingProvider } | undefined;

/**
 * Stable identity for environment-selected embedding configuration. API keys are
 * hashed rather than retained in the cache key so diagnostics can never expose
 * the credential. Keeping one provider instance is important: real providers are
 * wrapped in `CachingEmbeddingProvider`, and recreating that wrapper at every
 * retrieval call silently discarded the corpus cache between questions.
 */
function envEmbeddingProviderKey(options: EmbeddingResolveOptions): string {
  const credentialHash = options.openaiApiKey
    ? createHash('sha1').update(options.openaiApiKey).digest('hex')
    : '';
  return JSON.stringify({
    ollamaEndpoint: options.ollamaEndpoint ?? '',
    ollamaModel: options.ollamaModel ?? '',
    openaiCredential: credentialHash,
    model: options.model ?? '',
    baseUrl: options.baseUrl ?? '',
  });
}

/**
 * The provider a host registered for this whole process — normally the one
 * the served project configured in `dql.config.json`.
 *
 * Retrieval call sites deep in the library (conversation matching, SQL-lane
 * hybrid ranking) have no project root to resolve settings from, so they fell
 * back to env-or-hashed even while the catalog itself was indexed with a real
 * embedder — one product with two different notions of similarity. A local
 * server serves exactly one project, so a process default is sound; explicit
 * environment configuration still wins as the operator override.
 */
let processDefaultEmbeddingProvider: EmbeddingProvider | undefined;

export function setProcessDefaultEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
  processDefaultEmbeddingProvider = provider;
}

export function envEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const options = embeddingOptionsFromEnv(env);
  if (Object.keys(options).length === 0 && processDefaultEmbeddingProvider) {
    return processDefaultEmbeddingProvider;
  }
  const key = envEmbeddingProviderKey(options);
  if (cachedEnvEmbeddingProvider?.key !== key) {
    cachedEnvEmbeddingProvider = { key, provider: resolveEmbeddingProvider(options) };
  }
  return cachedEnvEmbeddingProvider.provider;
}

/** Test/runtime hook used when provider settings change without restarting. */
export function clearEnvEmbeddingProviderCache(): void {
  cachedEnvEmbeddingProvider = undefined;
}

export interface HybridRankItem<T> {
  item: T;
  /** Text the item is embedded/searched on. */
  text: string;
  /** FTS/BM25-derived relevance in [0, 1] (higher better). */
  ftsScore: number;
}

export interface HybridRankOptions {
  /**
   * Weight on the vector-similarity component in [0, 1]. 0 = pure FTS5 (the safe
   * default). The blended score is `(1 - alpha) * fts + alpha * cosine01`.
   */
  alpha?: number;
  provider?: EmbeddingProvider;
}

export interface HybridRanked<T> {
  item: T;
  ftsScore: number;
  vectorScore: number;
  score: number;
}

/**
 * Blend FTS5 relevance with embedding cosine similarity. When `alpha` is 0 (the
 * default) this is a pure pass-through of the FTS ordering — FTS5 stays the safe
 * default and embeddings are strictly additive/opt-in.
 */
export async function hybridRank<T>(
  query: string,
  items: HybridRankItem<T>[],
  options: HybridRankOptions = {},
): Promise<HybridRanked<T>[]> {
  const alpha = clamp01(options.alpha ?? 0);
  if (alpha === 0 || items.length === 0) {
    return items
      .map((entry) => ({ item: entry.item, ftsScore: entry.ftsScore, vectorScore: 0, score: entry.ftsScore }))
      .sort((a, b) => b.score - a.score);
  }
  const provider = options.provider ?? defaultEmbeddingProvider();
  const [queryVec, ...itemVecs] = provider.embedQuery
    ? [await provider.embedQuery(query), ...await provider.embed(items.map((entry) => entry.text))]
    : await provider.embed([query, ...items.map((entry) => entry.text)]);
  return items
    .map((entry, index) => {
      const cosine = cosineSimilarity(queryVec, itemVecs[index] ?? []);
      const cosine01 = (cosine + 1) / 2; // map [-1,1] → [0,1]
      const score = (1 - alpha) * entry.ftsScore + alpha * cosine01;
      return { item: entry.item, ftsScore: entry.ftsScore, vectorScore: cosine01, score };
    })
    .sort((a, b) => b.score - a.score);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Rebuild the provider that wrote a vector index, from the id recorded beside
 * it.
 *
 * An index is only searchable by the embedder that built it, and provider ids
 * are structured (`cached:resilient:ollama:nomic-embed-text`), so the id is
 * enough to reconstruct one. Without this, a project that re-embedded with a
 * local model in one process answered every later question with an empty
 * vector lane, because an unconfigured project resolves to the hashed default
 * and the two ids never match.
 *
 * Returns undefined for an id this build cannot reconstruct — an OpenAI index
 * needs a key that is not ours to invent — leaving the caller's own resolution
 * in place.
 */
export function embeddingProviderFromIndexedId(
  indexedProviderId: string,
  options: { ollamaEndpoint?: string } = {},
): EmbeddingProvider | undefined {
  const cortex = /(?:^|:)cortex:(.+)$/.exec(indexedProviderId);
  if (cortex) {
    const model = cortex[1]!.trim();
    return isCortexEmbeddingModel(model) ? resolveEmbeddingProvider({ cortexModel: model }) : undefined;
  }
  const ollama = /(?:^|:)ollama:(.+)$/.exec(indexedProviderId);
  if (ollama) {
    const model = ollama[1]!.trim();
    if (!model) return undefined;
    return resolveEmbeddingProvider({
      ollamaEndpoint: options.ollamaEndpoint
        ?? readEnv('ZLENS_OLLAMA_EMBED_URL')
        ?? 'http://127.0.0.1:11434',
      ollamaModel: model,
    });
  }
  return undefined;
}
