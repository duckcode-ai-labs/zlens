import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { EmbeddingSettings } from './EmbeddingSettings';
import { CORTEX_EMBEDDINGS_OPTION, cortexEmbeddingsHint, LOCAL_EMBEDDINGS_OPTION, localEmbeddingsHint, searchModeLabel } from './embedding-reindex-model';

vi.mock('../../api/client', () => ({ api: {} }));

/**
 * Codex end-to-end report, 23 Oct 2026: local Ollama embeddings were adopted
 * without the person choosing them, and Setup showed "active: hashed-token-v1".
 */
describe('Search settings: word-based unless you turn on local embeddings', () => {
  it('says what search does in words', () => {
    expect(searchModeLabel({ provider: 'hashed' }, false)).toBe('Search: word-based');
    expect(searchModeLabel(null, false)).toBe('Search: word-based');
    expect(searchModeLabel({ provider: 'ollama', model: 'nomic-embed-text' }, true)).toBe('Search: meaning-based · local Ollama (nomic-embed-text)');
    // A saved setting whose index is not built yet is still word-based until it is.
    expect(searchModeLabel({ provider: 'ollama', model: 'nomic-embed-text' }, false)).toBe('Search: word-based');
  });

  it('says whether this computer can run the local model', () => {
    expect(localEmbeddingsHint({ reachable: false, installed: [] })).toMatch(/not running/);
    expect(localEmbeddingsHint({ reachable: true, installed: [] })).toMatch(/downloads nomic-embed-text/);
    expect(localEmbeddingsHint({ reachable: true, installed: ['nomic-embed-text'] })).toMatch(/only when this is on/);
  });

  it('opens word-based with the local switch off and the engineering id under Technical details', () => {
    const html = renderToStaticMarkup(<EmbeddingSettings t={themes.paper} />);
    expect(html).toContain('Search: word-based');
    expect(html).toContain(LOCAL_EMBEDDINGS_OPTION.replace('—', '—'));
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-checked="false"/);
    const details = html.indexOf('Technical details');
    expect(details).toBeGreaterThan(-1);
    expect(html.indexOf('Embedder in use')).toBeGreaterThan(details);
    expect(html).not.toContain('active: ');
    expect(html).not.toMatch(/Lexical only|hashed embedder/);
  });

  it('offers Snowflake Cortex search only where the project connection is Snowflake, and says what it costs', () => {
    expect(searchModeLabel({ provider: 'cortex', model: 'snowflake-arctic-embed-m-v1.5' }, true)).toBe('Search: meaning-based · Snowflake Cortex (snowflake-arctic-embed-m-v1.5)');
    expect(cortexEmbeddingsHint({ available: true })).toMatch(/AI_EMBED on your Snowflake connection.*about a cent/);
    expect(cortexEmbeddingsHint({ available: false, reason: 'Snowflake Cortex search needs the project connection to be Snowflake.' })).toBe('Snowflake Cortex search needs the project connection to be Snowflake.');
    // Before the settings load (and on a project that is not on Snowflake) the switch is not there.
    const html = renderToStaticMarkup(<EmbeddingSettings t={themes.paper} />);
    expect(html).not.toContain(CORTEX_EMBEDDINGS_OPTION);
  });
});
