import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORTEX_DEFAULT_EMBEDDING_MODEL,
  CortexEmbeddingProvider,
  useCortexEmbeddingSql,
  type CortexEmbeddingSql,
} from './cortex.js';
import { clearProjectEmbeddingCache, projectEmbeddingProvider } from './project-embeddings.js';
import { embedSearchQuery, embeddingOptionsFromEnv, embeddingProviderFromIndexedId, hybridRank, resolveEmbeddingProvider } from './provider.js';

/** A stand-in for AI_EMBED: each text's vector says how long it was, so tests can see which text it came from. */
function fakeCortex(dimensions = 768, format: 'string' | 'array' = 'string') {
  const statements: Array<{ statement: string; texts: string[] }> = [];
  const sql: CortexEmbeddingSql = async (statement, binds) => {
    const texts = JSON.parse(String(binds[0])) as string[];
    statements.push({ statement, texts });
    return texts.map((text, index) => {
      const vector = Array.from({ length: dimensions }, (_, i) => (i === 0 ? text.length : 0));
      return { I: index, V: format === 'string' ? JSON.stringify(vector) : vector };
    });
  };
  return { sql, statements };
}

afterEach(() => {
  useCortexEmbeddingSql(undefined);
  clearProjectEmbeddingCache();
  vi.unstubAllEnvs();
});

describe('meaning search through Snowflake Cortex', () => {
  it('embeds texts with AI_EMBED in batches of 500, the model written into the statement and the texts bound', async () => {
    const { sql, statements } = fakeCortex();
    const provider = new CortexEmbeddingProvider({ model: 'snowflake-arctic-embed-m-v1.5', sql });
    expect(provider.id).toBe('cortex:snowflake-arctic-embed-m-v1.5');
    expect(provider.dimensions).toBe(768);
    expect(new CortexEmbeddingProvider({ sql }).id).toBe('cortex:snowflake-arctic-embed-l-v2.0');
    expect(provider.preferredBatchSize).toBe(500);
    const texts = Array.from({ length: 1200 }, (_, i) => 'x'.repeat(i + 1));
    const vectors = await provider.embed(texts);
    expect(vectors).toHaveLength(1200);
    expect(vectors[1199]![0]).toBe(1200);
    expect(statements.map((entry) => entry.texts.length)).toEqual([500, 500, 200]);
    expect(statements[0]!.statement).toBe("SELECT f.index AS I, AI_EMBED('snowflake-arctic-embed-m-v1.5', f.value::STRING)::ARRAY AS V FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f");
  });

  it('puts the model\'s instruction in front of a search question, and nothing in front of the texts searched', async () => {
    const { sql, statements } = fakeCortex(1024, 'array');
    const provider = new CortexEmbeddingProvider({ model: 'snowflake-arctic-embed-l-v2.0', sql });
    await provider.embedQuery('customers who left');
    await provider.embed(['column CUSTOMERS.CHURNED_FLAG: true when the account cancelled']);
    expect(statements[0]!.texts).toEqual(['query: customers who left']);
    expect(statements[1]!.texts).toEqual(['column CUSTOMERS.CHURNED_FLAG: true when the account cancelled']);
    const m = fakeCortex();
    await new CortexEmbeddingProvider({ model: 'snowflake-arctic-embed-m-v1.5', sql: m.sql }).embedQuery('revenue');
    expect(m.statements[0]!.texts).toEqual(['Represent this sentence for searching relevant passages: revenue']);
  });

  it('cuts texts the model cannot read and never sends an empty one', async () => {
    const { sql, statements } = fakeCortex();
    await new CortexEmbeddingProvider({ model: 'snowflake-arctic-embed-m-v1.5', sql }).embed(['y'.repeat(5000), '   ']);
    expect(statements[0]!.texts[0]).toHaveLength(1800);
    expect(statements[0]!.texts[1]).toBe(' ');
  });

  it('accepts only the models it knows (the name goes into the SQL text), and says why when it cannot embed', async () => {
    expect(() => new CortexEmbeddingProvider({ model: "x'); DROP TABLE t; --" })).toThrow('does not use the Cortex embedding model');
    await expect(new CortexEmbeddingProvider().embed(['a'])).rejects.toThrow('runs inside the ZLens server');
    const short = fakeCortex(10);
    await expect(new CortexEmbeddingProvider({ sql: short.sql }).embed(['a'])).rejects.toThrow('returned 10 numbers for snowflake-arctic-embed-l-v2.0');
    const missing: CortexEmbeddingSql = async () => [];
    await expect(new CortexEmbeddingProvider({ sql: missing }).embed(['a'])).rejects.toThrow('fewer vectors');
  });

  it('never pays twice for a text: vectors are kept on disk per project and model, and a repeat in one call is sent once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-cortex-cache-'));
    try {
      const cachePath = join(root, '.dql', 'cache', 'cortex-embeddings.sqlite');
      const { sql, statements } = fakeCortex(1024);
      const first = await new CortexEmbeddingProvider({ sql, cachePath }).embed(['orders', 'customers', 'orders']);
      expect(statements).toHaveLength(1);
      expect(statements[0]!.texts).toEqual(['orders', 'customers']);
      expect(first[2]).toEqual(first[0]);
      // A new provider (a restart) reads the same cache: only the new text goes to Cortex.
      const again = await new CortexEmbeddingProvider({ sql, cachePath }).embed(['customers', 'payments']);
      expect(statements).toHaveLength(2);
      expect(statements[1]!.texts).toEqual(['payments']);
      expect(again[0]![0]).toBe('customers'.length);
      // Another model has its own vectors.
      const m = fakeCortex(768);
      await new CortexEmbeddingProvider({ model: 'snowflake-arctic-embed-m-v1.5', sql: m.sql, cachePath }).embed(['customers']);
      expect(m.statements).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the SQL runner the server registers', async () => {
    const { sql, statements } = fakeCortex(1024);
    useCortexEmbeddingSql(sql);
    await new CortexEmbeddingProvider().embed(['a']);
    expect(statements).toHaveLength(1);
  });

  it('is chosen by a project setting, by ZLENS_EMBEDDINGS=cortex (the Snowflake app), and from an index built with it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-cortex-embed-'));
    try {
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ ai: { embeddings: { provider: 'cortex', model: 'snowflake-arctic-embed-l-v2.0' } } }));
      expect(projectEmbeddingProvider(root, {}).id).toBe('cached:resilient:cortex:snowflake-arctic-embed-l-v2.0');
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ ai: { embeddings: { provider: 'cortex', model: 'not-a-model' } } }));
      clearProjectEmbeddingCache();
      expect(projectEmbeddingProvider(root, {}).id).toBe(`cached:resilient:cortex:${CORTEX_DEFAULT_EMBEDDING_MODEL}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(embeddingOptionsFromEnv({ ZLENS_EMBEDDINGS: 'cortex' })).toEqual({ cortexModel: CORTEX_DEFAULT_EMBEDDING_MODEL });
    expect(embeddingOptionsFromEnv({ ZLENS_EMBEDDINGS: 'cortex', ZLENS_CORTEX_EMBED_MODEL: 'snowflake-arctic-embed-l-v2.0' })).toEqual({ cortexModel: 'snowflake-arctic-embed-l-v2.0' });
    expect(embeddingProviderFromIndexedId('cached:resilient:cortex:snowflake-arctic-embed-m-v1.5')?.id).toBe('cached:resilient:cortex:snowflake-arctic-embed-m-v1.5');
    expect(embeddingProviderFromIndexedId('cached:resilient:cortex:unknown')).toBeUndefined();
  });

  it('asks questions in their question form through the cache and the fallback, and falls back to word search when Cortex fails', async () => {
    const { sql, statements } = fakeCortex(1024);
    useCortexEmbeddingSql(sql);
    const provider = resolveEmbeddingProvider({ cortexModel: CORTEX_DEFAULT_EMBEDDING_MODEL });
    await embedSearchQuery(provider, 'revenue');
    await embedSearchQuery(provider, 'revenue');
    expect(statements).toHaveLength(1);
    expect(statements[0]!.texts[0]).toBe('query: revenue');
    // Hybrid ranking embeds the question as a question and the items as texts.
    await hybridRank('who left', [{ item: 1, ftsScore: 1, text: 'cancelled accounts' }], { alpha: 0.5, provider });
    expect(statements.at(-2)!.texts[0]).toBe('query: who left');
    expect(statements.at(-1)!.texts).toEqual(['cancelled accounts']);
    useCortexEmbeddingSql(async () => { throw new Error('AI_EMBED refused'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fallback = resolveEmbeddingProvider({ cortexModel: CORTEX_DEFAULT_EMBEDDING_MODEL });
    expect((await embedSearchQuery(fallback, 'another question')).length).toBe(256);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
