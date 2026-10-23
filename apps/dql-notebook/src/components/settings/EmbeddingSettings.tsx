import React, { useCallback, useEffect, useState } from 'react';
import { Check, Download, Loader2, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { api, type EmbeddingSettingsResponse } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';
import { embeddingReindexOutcome, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDINGS_OPTION, localEmbeddingsHint, searchModeLabel } from './embedding-reindex-model';

type ProviderId = 'hashed' | 'ollama' | 'openai';
interface ModelOption {
  model: string; label: string; dimensions: number; size: string; recommended: boolean; description: string;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/**
 * Search: word-based by default, local Ollama embeddings when the person turns
 * them on. ZLens never switches by itself (Codex end-to-end report, 23 Oct
 * 2026: a project started using nomic-embed-text only because Ollama was
 * running). The provider ids, other models, Test and Re-index sit under
 * Technical details.
 *
 * Embeddings decide whether Ask can match MEANING or only shared words.
 *
 * With the offline hashed default, "how are we doing on drinks" cannot reach a
 * `beverage_revenue` metric no matter how well its description is written —
 * every retrieval lane is lexical. This was configurable only through an
 * environment variable that no product surface mentioned, so in practice no
 * project had semantic retrieval. Naming known-good models and installing them
 * in one click is the difference between a setting people can use and one they
 * never find.
 */
export function EmbeddingSettings({ t, onStatus }: { t: Theme; onStatus?: (message: string) => void }) {
  const [provider, setProvider] = useState<ProviderId>('hashed');
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const [catalog, setCatalog] = useState<{ ollama: ModelOption[]; openai: ModelOption[] }>({ ollama: [], openai: [] });
  const [installed, setInstalled] = useState<string[]>([]);
  const [ollamaReachable, setOllamaReachable] = useState(false);
  const [active, setActive] = useState<{ id: string; semantic: boolean; reindexRequired: boolean }>({ id: '', semantic: false, reindexRequired: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationStatus, setOperationStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const applyCurrentSettings = useCallback((current: EmbeddingSettingsResponse) => {
    setProvider(current.settings.provider);
    setEndpoint(current.settings.endpoint || DEFAULT_ENDPOINT);
    setModel(current.settings.model);
    setApiKeySet(current.settings.apiKeySet);
    setActive({ id: current.activeProviderId, semantic: current.semantic, reindexRequired: current.reindexRequired });
  }, []);

  const refreshModels = useCallback(async (url: string) => {
    try {
      const result = await api.listEmbeddingModels(url);
      setCatalog(result.catalog);
      setInstalled(result.installed);
      setOllamaReachable(result.ollamaReachable);
    } catch { /* the panel still works without the live model list */ }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const current = await api.getEmbeddingSettings();
        applyCurrentSettings(current);
        await refreshModels(current.settings.endpoint || DEFAULT_ENDPOINT);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [applyCurrentSettings, refreshModels]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setOperationStatus(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = (nextProvider: ProviderId, nextModel: string) => run('save', async () => {
    const result = await api.saveEmbeddingSettings({
      provider: nextProvider,
      ...(nextProvider === 'ollama' ? { endpoint } : {}),
      ...(nextModel ? { model: nextModel } : {}),
      ...(nextProvider === 'openai' && apiKey ? { apiKey } : {}),
    });
    setProvider(nextProvider);
    setModel(nextModel);
    if (apiKey) { setApiKeySet(true); setApiKey(''); }
    setActive({ id: result.activeProviderId, semantic: result.semantic, reindexRequired: result.reindexRequired });
    onStatus?.(result.semantic
      ? 'Semantic embeddings enabled. Re-index to apply them to your catalog.'
      : 'Search is word-based.');
  });

  /** One switch: local Ollama embeddings on (pull the model if needed, save, re-embed) or off (word-based, re-embed). */
  const setLocalEmbeddings = (on: boolean) => run('local', async () => {
    if (on) {
      if (!ollamaReachable) throw new Error('Ollama is not running on this computer. Start it, then turn this on.');
      if (!installed.includes(LOCAL_EMBEDDING_MODEL)) {
        await api.installEmbeddingModel(LOCAL_EMBEDDING_MODEL, endpoint);
        await refreshModels(endpoint);
      }
      await api.saveEmbeddingSettings({ provider: 'ollama', endpoint, model: LOCAL_EMBEDDING_MODEL });
    } else {
      await api.saveEmbeddingSettings({ provider: 'hashed' });
    }
    const result = await api.reindexEmbeddings();
    const current = await api.getEmbeddingSettings();
    applyCurrentSettings(current);
    const outcome = embeddingReindexOutcome(result, current);
    setOperationStatus(outcome.ok
      ? { ok: true, message: on ? `Search is meaning-based, with ${LOCAL_EMBEDDING_MODEL} on this computer.` : 'Search is word-based.' }
      : outcome);
    onStatus?.(on ? `Local Ollama embeddings on (${LOCAL_EMBEDDING_MODEL}).` : 'Local embeddings off: search is word-based.');
  });
  const localOn = provider === 'ollama' && model === LOCAL_EMBEDDING_MODEL && active.semantic;

  const options = provider === 'openai' ? catalog.openai : catalog.ollama;
  const card: React.CSSProperties = {
    border: `1px solid ${t.headerBorder}`, borderRadius: 10, padding: 14, background: t.cellBg, marginTop: 14,
  };
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' };
  const input: React.CSSProperties = {
    height: 30, padding: '0 9px', borderRadius: 6, border: `1px solid ${t.btnBorder}`,
    background: t.appBg, color: t.textPrimary, fontSize: 12, fontFamily: t.font, width: '100%',
  };
  const button = (primary?: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 6,
    border: `1px solid ${primary ? t.accent : t.btnBorder}`, background: primary ? t.accent : t.btnBg,
    color: primary ? '#fff' : t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font,
  });

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: t.textPrimary }}>Search</div>
          <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4, lineHeight: 1.5, maxWidth: 620 }}>
            Word-based search matches the words in a question. Meaning-based search also connects "drinks" to a
            <code> beverage_revenue</code> metric. ZLens never switches by itself.
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 9px', borderRadius: 999,
          fontSize: 11, fontWeight: 650,
          background: active.semantic ? 'var(--status-success-bg)' : 'var(--status-warning-bg)',
          color: active.semantic ? 'var(--status-success)' : 'var(--status-warning)',
          border: `1px solid ${active.semantic ? 'var(--status-success-border)' : 'var(--status-warning-border)'}`,
        }}>
          {active.semantic ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
          {searchModeLabel({ provider, model }, active.semantic)}
        </span>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, cursor: busy ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          role="switch"
          aria-checked={localOn}
          checked={localOn}
          disabled={busy !== null}
          onChange={(event) => void setLocalEmbeddings(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>{LOCAL_EMBEDDINGS_OPTION}</span>
          <span style={{ display: 'block', fontSize: 11.5, color: t.textMuted, marginTop: 2, lineHeight: 1.45 }}>
            {busy === 'local' ? <><Loader2 size={11} className="dql-spin" /> Re-embedding the catalog…</> : localEmbeddingsHint({ reachable: ollamaReachable, installed })}
          </span>
        </span>
      </label>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 650, color: t.textSecondary }}>Technical details</summary>

      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        {(['hashed', 'ollama', 'openai'] as ProviderId[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => { setProvider(id); if (id === 'hashed') void save('hashed', ''); }}
            style={{ ...button(provider === id), textTransform: 'capitalize' }}
          >
            {id === 'hashed' ? 'Word-based (default)' : id === 'ollama' ? 'Ollama (local)' : 'OpenAI'}
          </button>
        ))}
      </div>

      {provider === 'ollama' && (
        <div style={{ marginTop: 12 }}>
          <div style={label}>Ollama endpoint</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} onBlur={() => void refreshModels(endpoint)} style={input} placeholder={DEFAULT_ENDPOINT} />
            <span style={{ fontSize: 11, whiteSpace: 'nowrap', color: ollamaReachable ? 'var(--status-success)' : t.textMuted }}>
              {ollamaReachable ? 'reachable' : 'not reachable'}
            </span>
          </div>
          {!ollamaReachable && (
            <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 6, lineHeight: 1.5 }}>
              Start Ollama first — nothing leaves your machine with the local option.
            </div>
          )}
        </div>
      )}

      {provider === 'openai' && (
        <div style={{ marginTop: 12 }}>
          <div style={label}>API key {apiKeySet ? '(stored — leave blank to keep)' : ''}</div>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ ...input, marginTop: 4 }} placeholder={apiKeySet ? '••••••••' : 'sk-…'} />
          <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 6, lineHeight: 1.5 }}>
            Catalog text (metric names, descriptions, business context) is sent to this endpoint to be embedded.
            Your answer-model key is never reused for this.
          </div>
        </div>
      )}

      {provider !== 'hashed' && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>Model</div>
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            {options.map((option) => {
              const isInstalled = provider === 'openai' || installed.includes(option.model);
              const selected = model === option.model;
              return (
                <div
                  key={option.model}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 8,
                    border: `1px solid ${selected ? t.accent : t.btnBorder}`,
                    background: selected ? `${t.accent}0f` : t.appBg,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary, fontFamily: t.fontMono }}>{option.model}</span>
                      {option.recommended && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, background: `${t.accent}18`, borderRadius: 999, padding: '1px 7px' }}>Recommended</span>
                      )}
                      <span style={{ fontSize: 10.5, color: t.textMuted }}>{option.dimensions} dims · {option.size}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 3, lineHeight: 1.45 }}>{option.description}</div>
                  </div>
                  {isInstalled ? (
                    <button type="button" onClick={() => void save(provider, option.model)} disabled={busy !== null} style={button(selected)}>
                      {selected ? <><Check size={12} /> In use</> : 'Use this'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null || !ollamaReachable}
                      onClick={() => void run(`install:${option.model}`, async () => {
                        await api.installEmbeddingModel(option.model, endpoint);
                        await refreshModels(endpoint);
                        await api.saveEmbeddingSettings({ provider: 'ollama', endpoint, model: option.model });
                        setModel(option.model);
                        const current = await api.getEmbeddingSettings();
                        applyCurrentSettings(current);
                        onStatus?.(`${option.model} installed and selected. Re-index to apply it.`);
                      })}
                      style={button(true)}
                    >
                      {busy === `install:${option.model}`
                        ? <><Loader2 size={12} className="dql-spin" /> Installing…</>
                        : <><Download size={12} /> Install</>}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy !== null} onClick={() => void run('test', async () => {
          const result = await api.testEmbeddingProvider();
          onStatus?.(`${result.providerId} responded in ${result.elapsedMs} ms (${result.dimensions} dims).`);
        })} style={button()}>
          {busy === 'test' ? <Loader2 size={12} className="dql-spin" /> : null} Test
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void run('reindex', async () => {
          const result = await api.reindexEmbeddings();
          const current = await api.getEmbeddingSettings();
          applyCurrentSettings(current);
          const outcome = embeddingReindexOutcome(result, current);
          setOperationStatus(outcome);
          onStatus?.(outcome.message);
        })} style={button(active.reindexRequired)}>
          {busy === 'reindex' ? <Loader2 size={12} className="dql-spin" /> : <RefreshCw size={12} />}
          {busy === 'reindex' ? 'Re-indexing…' : 'Re-index catalog'}
        </button>
        <span style={{ fontSize: 11, color: t.textMuted }}>Embedder in use: <code style={{ fontFamily: t.fontMono }}>{active.id || '—'}</code></span>
      </div>
      </details>

      {active.reindexRequired && (
        <div style={{ fontSize: 11.5, color: 'var(--status-warning)', marginTop: 8, lineHeight: 1.5 }}>
          The catalog still holds vectors from the previous embedder. Re-index to search with the new one —
          until then the vector lane keeps using the old index.
        </div>
      )}
      {busy === 'reindex' && (
        <div role="status" style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 8, lineHeight: 1.5 }}>
          Rebuilding the local vector index. This page will update automatically when it finishes.
        </div>
      )}
      {operationStatus && (
        <div role={operationStatus.ok ? 'status' : 'alert'} style={{ fontSize: 11.5, color: operationStatus.ok ? 'var(--status-success)' : 'var(--status-error)', marginTop: 8, lineHeight: 1.5 }}>
          {operationStatus.message}
        </div>
      )}
      {error && <div style={{ fontSize: 11.5, color: t.error, marginTop: 8, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}
