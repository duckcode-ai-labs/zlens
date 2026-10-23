import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoUpgradeProjectEmbeddings,
  clearProjectEmbeddingCache,
  embeddingOptionsFromSettings,
  isHashedEmbeddingProvider,
  projectEmbeddingProvider,
} from './project-embeddings.js';

const dirs: string[] = [];
function project(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-embed-'));
  dirs.push(dir);
  if (config) writeFileSync(join(dir, 'dql.config.json'), JSON.stringify(config));
  clearProjectEmbeddingCache();
  return dir;
}
afterEach(() => {
  clearProjectEmbeddingCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('project embedding provider', () => {
  it('falls back to the offline hashed provider when nothing is configured', () => {
    // This is what every project runs today: retrieval works, but it is lexical.
    const provider = projectEmbeddingProvider(project(), {});
    expect(isHashedEmbeddingProvider(provider)).toBe(true);
  });

  it('resolves a real provider from project settings', () => {
    // Previously this was reachable only via an environment variable that no
    // product surface mentioned, so in practice nobody had semantic retrieval.
    const root = project({ ai: { embeddings: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' } } });
    const provider = projectEmbeddingProvider(root, {});
    expect(isHashedEmbeddingProvider(provider)).toBe(false);
    expect(provider.id).toContain('nomic-embed-text');
  });

  it('prefers an explicit project setting over the environment', () => {
    const root = project({ ai: { embeddings: { provider: 'ollama', endpoint: 'http://project:11434', model: 'project-model' } } });
    const provider = projectEmbeddingProvider(root, { ZLENS_OLLAMA_EMBED_URL: 'http://env:11434', ZLENS_OLLAMA_EMBED_MODEL: 'env-model' });
    expect(provider.id).toContain('project-model');
  });

  it('still honours the environment when the project says nothing', () => {
    const provider = projectEmbeddingProvider(project(), { ZLENS_OLLAMA_EMBED_URL: 'http://env:11434', ZLENS_OLLAMA_EMBED_MODEL: 'env-model' });
    expect(provider.id).toContain('env-model');
  });

  it('ignores an incomplete or malformed configuration rather than breaking retrieval', () => {
    // ollama with no endpoint, and unparseable JSON, must both degrade to hashed
    // instead of throwing — retrieval failing closed would take Ask down.
    expect(isHashedEmbeddingProvider(projectEmbeddingProvider(project({ ai: { embeddings: { provider: 'ollama' } } }), {}))).toBe(true);
    const broken = mkdtempSync(join(tmpdir(), 'dql-embed-bad-'));
    dirs.push(broken);
    writeFileSync(join(broken, 'dql.config.json'), '{not json');
    clearProjectEmbeddingCache();
    expect(isHashedEmbeddingProvider(projectEmbeddingProvider(broken, {}))).toBe(true);
  });

  it('never uses a general OPENAI_API_KEY as implicit consent to export catalog text', () => {
    const provider = projectEmbeddingProvider(project(), { OPENAI_API_KEY: 'sk-should-be-ignored' });
    expect(isHashedEmbeddingProvider(provider)).toBe(true);
  });

  it('maps settings to resolver options', () => {
    expect(embeddingOptionsFromSettings({ provider: 'ollama', endpoint: 'http://x:11434', model: 'm' }))
      .toEqual({ ollamaEndpoint: 'http://x:11434', ollamaModel: 'm' });
    expect(embeddingOptionsFromSettings({ provider: 'openai', apiKey: 'k', model: 'text-embedding-3-small' }))
      .toEqual({ openaiApiKey: 'k', model: 'text-embedding-3-small' });
    expect(embeddingOptionsFromSettings({ provider: 'hashed' })).toEqual({});
  });
});

/**
 * Codex end-to-end report, 23 Oct 2026: a database-only project switched to
 * local Ollama embeddings (nomic-embed-text) by itself because Ollama was
 * running. Local embeddings are now the person's choice.
 */
describe('local embeddings only when the project chooses them', () => {
  const deps = (local: { endpoint: string; model: string } | null, indexed = 'hashed-token-v1') => ({
    probeLocalOllamaEmbeddings: vi.fn(async () => local),
    upgradeVectorIndexForProject: vi.fn(async (_root: string, provider: { id: string }) => ({
      upgraded: provider.id !== indexed,
      providerId: provider.id,
    })),
    setProcessDefaultEmbeddingProvider: vi.fn(),
  });
  afterEach(() => vi.unstubAllEnvs());
  const outsideTests = () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('ZLENS_EMBEDDINGS_AUTODETECT', undefined as unknown as string);
    vi.stubEnv('DQL_EMBEDDINGS_AUTODETECT', undefined as unknown as string);
    vi.stubEnv('ZLENS_OLLAMA_EMBED_URL', undefined as unknown as string);
    vi.stubEnv('ZLENS_OPENAI_API_KEY', undefined as unknown as string);
  };

  it('a new project stays word-based with Ollama running, and only offers the local model', async () => {
    outsideTests();
    const mocks = deps({ endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    const result = await autoUpgradeProjectEmbeddings(project({ project: 'p' }), mocks);
    expect(result).toEqual({ providerId: 'hashed-token-v1', upgraded: false, reason: 'not_chosen', localModel: 'nomic-embed-text' });
    expect(mocks.setProcessDefaultEmbeddingProvider).not.toHaveBeenCalled();
    // Only the word-based index is ever asked for.
    expect(mocks.upgradeVectorIndexForProject.mock.calls.map(([, provider]) => (provider as { id: string }).id)).toEqual(['hashed-token-v1']);
  });

  it('an index an earlier version switched by itself goes back to word-based search', async () => {
    outsideTests();
    const mocks = deps(null, 'ollama:nomic-embed-text');
    const result = await autoUpgradeProjectEmbeddings(project({ project: 'p' }), mocks);
    expect(result).toEqual({ providerId: 'hashed-token-v1', upgraded: false, reason: 'not_chosen', restored: true });
  });

  it('a project that chose embeddings keeps them unchanged', async () => {
    outsideTests();
    const mocks = deps({ endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    const root = project({ ai: { embeddings: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' } } });
    expect(await autoUpgradeProjectEmbeddings(root, mocks)).toMatchObject({ providerId: 'ollama', upgraded: false, reason: 'configured' });
    expect(mocks.probeLocalOllamaEmbeddings).not.toHaveBeenCalled();
    expect(mocks.upgradeVectorIndexForProject).not.toHaveBeenCalled();
  });

  it('an operator can opt in to automatic local embeddings, or turn the probe off', async () => {
    outsideTests();
    vi.stubEnv('ZLENS_EMBEDDINGS_AUTODETECT', 'on');
    const on = deps({ endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    expect(await autoUpgradeProjectEmbeddings(project({ project: 'p' }), on)).toMatchObject({ upgraded: true, model: 'nomic-embed-text' });
    expect(on.setProcessDefaultEmbeddingProvider).toHaveBeenCalledTimes(1);
    vi.stubEnv('ZLENS_EMBEDDINGS_AUTODETECT', 'off');
    const off = deps({ endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    expect(await autoUpgradeProjectEmbeddings(project({ project: 'p' }), off)).toMatchObject({ reason: 'disabled' });
    expect(off.probeLocalOllamaEmbeddings).not.toHaveBeenCalled();
  });
});
