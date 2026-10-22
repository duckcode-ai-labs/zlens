import React, { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { DbtOnboardingFlow } from './DbtOnboardingFlow';

type WizardStep = 'provider' | 'configure' | 'preview' | 'importing' | 'done';
type Provider = 'dbt' | 'cubejs' | 'snowflake';

interface ProviderCard {
  id: Provider;
  label: string;
  description: string;
  icon: string;
  color: string;
}

const PROVIDERS: ProviderCard[] = [
  {
    id: 'dbt',
    label: 'dbt',
    description: 'Connect a dbt project as the read-only source for models, schema, lineage, tests, catalog types, and MetricFlow.',
    icon: 'dbt',
    color: '#ff694a',
  },
  {
    id: 'cubejs',
    label: 'Cube.js',
    description: 'Import cubes, measures, dimensions, joins, and pre-aggregations from Cube.js.',
    icon: 'cube',
    color: '#7a77ff',
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    description: 'Introspect Snowflake semantic views and import metrics and dimensions.',
    icon: 'snow',
    color: '#29b5e8',
  },
];

interface PreviewData {
  provider: string;
  counts: Record<string, number>;
  domains: string[];
  warnings: string[];
  objects: Array<{ kind: string; name: string; label: string; domain: string }>;
}

interface ImportResult {
  manifest: {
    importedAt: string;
    warnings: string[];
    objects: Array<{ kind: string; name: string; label: string; domain: string }>;
  };
  counts: Record<string, number>;
}

interface SetupWizardProps {
  detectedProvider: string | null;
  onClose: () => void;
  onImported: () => void;
}

export function SetupWizard({ detectedProvider, onClose, onImported }: SetupWizardProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [step, setStep] = useState<WizardStep>('provider');
  const [provider, setProvider] = useState<Provider | null>(null);

  // Configure step
  const [projectPath, setProjectPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [subPath, setSubPath] = useState('');
  const [connection, setConnection] = useState('');
  const [sourceMode, setSourceMode] = useState<'local' | 'repo'>('local');
  const [connections, setConnections] = useState<string[]>([]);

  // Preview step
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewHint, setPreviewHint] = useState<string | null>(null);

  // Import step
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importHint, setImportHint] = useState<string | null>(null);

  // Load connections for Snowflake
  useEffect(() => {
    api.getConnections().then((info: any) => {
      if (info?.connections) {
        setConnections(Object.keys(info.connections));
      }
    }).catch(() => {});
  }, []);

  const buildPayload = () => {
    if (!provider) return null;
    if (provider === 'snowflake') {
      return { provider, connection: connection || undefined };
    }
    if (sourceMode === 'repo') {
      return { provider, repoUrl, branch: branch || undefined, subPath: subPath || undefined };
    }
    return { provider, projectPath: projectPath || undefined };
  };

  const handlePreview = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewHint(null);
    try {
      const result = await api.previewSemanticImport(payload);
      setPreviewData(result);
      setStep('preview');
    } catch (e: any) {
      let parsed: any = {};
      try { parsed = JSON.parse(e.message); } catch { parsed = { error: e.message }; }
      setPreviewError(parsed.error ?? e.message ?? 'Preview failed');
      setPreviewHint(parsed.hint ?? null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleImport = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setStep('importing');
    setImportError(null);
    setImportHint(null);
    try {
      const result = await api.importSemanticLayer(payload);
      setImportResult(result);
      setStep('done');
    } catch (e: any) {
      let parsed: any = {};
      try { parsed = JSON.parse(e.message); } catch { parsed = { error: e.message }; }
      setImportError(parsed.error ?? e.message ?? 'Import failed');
      setImportHint(parsed.hint ?? null);
      setStep('preview'); // Go back to preview to show error
    }
  };

  const handleDone = () => {
    onImported();
    onClose();
  };

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const inputStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 13,
    fontFamily: t.font,
    padding: '8px 12px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  };

  const labelStyle = {
    fontSize: 12,
    fontWeight: 500 as const,
    color: t.textSecondary,
    fontFamily: t.font,
    marginBottom: 4,
    display: 'block' as const,
  };

  // CFG-001 / AGT-002: dbt uses the dbt-first onboarding flow. Cube and
  // Snowflake intentionally retain the existing semantic-provider import path.
  if (provider === 'dbt' && step !== 'provider') {
    return (
      <div onClick={handleOverlay} style={{
        position: 'fixed', inset: 0, background: t.modalOverlay,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, backdropFilter: 'blur(4px)',
      }}>
        <DbtOnboardingFlow
          t={t}
          initialProjectDir={projectPath}
          onBack={() => setStep('provider')}
          onClose={onClose}
          onComplete={onImported}
          onChooseModelSource={(modelSource) => {
            // Database only, Both and an existing project continue in Guided Setup.
            onClose();
            dispatch({ type: 'OPEN_SETUP', modelSource });
          }}
          onOpen={(target) => {
            onClose();
            if (target === 'block') {
              dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
              dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' });
              return;
            }
            dispatch({ type: 'SET_MAIN_VIEW', view: target });
          }}
        />
      </div>
    );
  }

  return (
    <div onClick={handleOverlay} style={{
      position: 'fixed', inset: 0, background: t.modalOverlay,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: t.modalBg, border: `1px solid ${t.cellBorder}`,
        borderRadius: 12, width: 560, maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: t.textPrimary, fontFamily: t.font, margin: 0 }}>
            {step === 'done' ? 'Import Complete' : 'Set Up Semantic Layer'}
          </h2>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: t.textMuted, fontSize: 18, lineHeight: 1, padding: '2px 4px', borderRadius: 4,
          }}>×</button>
        </div>

        {/* Step indicator */}
        {step !== 'done' && (
          <div style={{ padding: '12px 24px 0', display: 'flex', gap: 4 }}>
            {(['provider', 'configure', 'preview', 'importing'] as WizardStep[]).map((s, i) => (
              <div key={s} style={{
                flex: 1, height: 3, borderRadius: 2,
                background: (['provider', 'configure', 'preview', 'importing'].indexOf(step) >= i) ? t.accent : t.cellBorder,
                transition: 'background 0.2s',
              }} />
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ padding: '20px 24px 24px', flex: 1, overflowY: 'auto' }}>
          {/* Step 1: Choose Provider */}
          {step === 'provider' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.5 }}>
                Connect dbt for the governed DQL 2.0 path, or import a supported external semantic provider.
              </div>
              {PROVIDERS.map((p) => {
                const isDetected = detectedProvider === p.id;
                const isSelected = provider === p.id;
                return (
                  <button key={p.id} onClick={() => setProvider(p.id)} style={{
                    background: isSelected ? `${p.color}11` : t.inputBg,
                    border: `2px solid ${isSelected ? p.color : t.cellBorder}`,
                    borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
                    textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
                    transition: 'border-color 0.15s, background 0.15s',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                        background: p.color, flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                        {p.label}
                      </span>
                      {isDetected && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: p.color, fontFamily: t.font,
                          background: `${p.color}18`, padding: '2px 8px', borderRadius: 8,
                          marginLeft: 4,
                        }}>
                          Detected
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.4 }}>
                      {p.description}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Step 2: Configure Source */}
          {step === 'configure' && provider && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 13, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.5 }}>
                {provider === 'snowflake'
                  ? 'Select the Snowflake connection to introspect semantic views.'
                  : `Configure the source for your ${provider === 'dbt' ? 'dbt' : 'Cube.js'} project.`}
              </div>

              {provider === 'snowflake' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={labelStyle}>Connection</label>
                  <select value={connection} onChange={(e) => setConnection(e.target.value)} style={inputStyle}>
                    <option value="">Select a connection...</option>
                    {connections.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {connections.length === 0 && (
                    <span style={{ fontSize: 11, color: t.warning ?? '#f0ad4e', fontFamily: t.font }}>
                      No connections configured. Set up a Snowflake connection first.
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setSourceMode('local')} style={{
                      background: sourceMode === 'local' ? t.accent : 'transparent',
                      color: sourceMode === 'local' ? '#fff' : t.textSecondary,
                      border: `1px solid ${sourceMode === 'local' ? t.accent : t.cellBorder}`,
                      borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
                      fontSize: 12, fontFamily: t.font, fontWeight: 500,
                    }}>Local Path</button>
                    <button onClick={() => setSourceMode('repo')} style={{
                      background: sourceMode === 'repo' ? t.accent : 'transparent',
                      color: sourceMode === 'repo' ? '#fff' : t.textSecondary,
                      border: `1px solid ${sourceMode === 'repo' ? t.accent : t.cellBorder}`,
                      borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
                      fontSize: 12, fontFamily: t.font, fontWeight: 500,
                    }}>Git Repository</button>
                  </div>

                  {sourceMode === 'local' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={labelStyle}>Project Path</label>
                      <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)}
                        placeholder={provider === 'dbt' ? '../my-dbt-project' : '../my-cube-project'}
                        style={inputStyle} />
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                        {provider === 'dbt'
                          ? 'Path to the directory containing dbt_project.yml'
                          : 'Path to the directory containing model/ or schema/'}
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={labelStyle}>Repository URL</label>
                        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                          placeholder="https://github.com/org/repo" style={inputStyle} />
                      </div>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <label style={labelStyle}>Branch</label>
                          <input value={branch} onChange={(e) => setBranch(e.target.value)}
                            placeholder="main" style={inputStyle} />
                        </div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <label style={labelStyle}>Sub-path</label>
                          <input value={subPath} onChange={(e) => setSubPath(e.target.value)}
                            placeholder="optional/sub/dir" style={inputStyle} />
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {previewError && (
                <div style={{
                  background: `${t.error}12`, border: `1px solid ${t.error}40`,
                  borderRadius: 8, padding: '10px 14px',
                }}>
                  <div style={{ fontSize: 12, color: t.error, fontFamily: t.font, fontWeight: 600, marginBottom: 4 }}>
                    Validation Failed
                  </div>
                  <div style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.4 }}>
                    {previewError}
                  </div>
                  {previewHint && (
                    <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, marginTop: 6, fontStyle: 'italic' }}>
                      {previewHint}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Preview */}
          {step === 'preview' && previewData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 13, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.5 }}>
                Review what will be imported into your project.
              </div>

              {/* Counts summary */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
              }}>
                {Object.entries(previewData.counts).filter(([, v]) => v > 0).map(([kind, count]) => (
                  <div key={kind} style={{
                    background: t.inputBg, borderRadius: 8, padding: '12px 14px',
                    border: `1px solid ${t.cellBorder}`, textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: t.accent, fontFamily: t.font }}>{count}</div>
                    <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, textTransform: 'capitalize' }}>
                      {kind.replace('_', '-')}s
                    </div>
                  </div>
                ))}
              </div>

              {/* Domains */}
              {previewData.domains.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, marginBottom: 6 }}>
                    Domains
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {previewData.domains.map((d) => (
                      <span key={d} style={{
                        fontSize: 11, fontFamily: t.font, background: t.pillBg,
                        padding: '3px 10px', borderRadius: 8, color: t.textSecondary,
                      }}>{d}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Warnings */}
              {previewData.warnings.length > 0 && (
                <div style={{
                  background: `${t.warning ?? '#f0ad4e'}12`, border: `1px solid ${t.warning ?? '#f0ad4e'}40`,
                  borderRadius: 8, padding: '10px 14px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.warning ?? '#f0ad4e', fontFamily: t.font, marginBottom: 4 }}>
                    Warnings
                  </div>
                  {previewData.warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.4 }}>
                      {w}
                    </div>
                  ))}
                </div>
              )}

              {importError && (
                <div style={{
                  background: `${t.error}12`, border: `1px solid ${t.error}40`,
                  borderRadius: 8, padding: '10px 14px',
                }}>
                  <div style={{ fontSize: 12, color: t.error, fontFamily: t.font, fontWeight: 600, marginBottom: 4 }}>
                    Import Failed
                  </div>
                  <div style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.4 }}>{importError}</div>
                  {importHint && (
                    <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, marginTop: 6, fontStyle: 'italic' }}>{importHint}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Importing */}
          {step === 'importing' && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 16, padding: '32px 0',
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%',
                border: `3px solid ${t.cellBorder}`, borderTopColor: t.accent,
                animation: 'spin 0.8s linear infinite',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontSize: 14, color: t.textSecondary, fontFamily: t.font }}>
                Importing {provider} semantic layer...
              </div>
              <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
                Parsing models, writing YAML files, refreshing state
              </div>
            </div>
          )}

          {/* Step 5: Done */}
          {step === 'done' && importResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0',
              }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 36, height: 36, borderRadius: '50%',
                  background: `${t.success ?? '#28a745'}20`, color: t.success ?? '#28a745',
                  fontSize: 20, fontWeight: 700,
                }}>
                  ✓
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                    Semantic layer imported successfully
                  </div>
                  <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
                    {Object.entries(importResult.counts)
                      .filter(([, v]) => v > 0)
                      .map(([k, v]) => `${v} ${k.replace('_', '-')}${v !== 1 ? 's' : ''}`)
                      .join(', ')}
                  </div>
                </div>
              </div>

              {importResult.manifest.warnings.length > 0 && (
                <div style={{
                  background: `${t.warning ?? '#f0ad4e'}12`, border: `1px solid ${t.warning ?? '#f0ad4e'}40`,
                  borderRadius: 8, padding: '10px 14px',
                }}>
                  {importResult.manifest.warnings.map((w: string, i: number) => (
                    <div key={i} style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>{w}</div>
                  ))}
                </div>
              )}

              <div style={{
                background: t.inputBg, borderRadius: 8, padding: '12px 14px',
                border: `1px solid ${t.cellBorder}`, fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5,
              }}>
                Your semantic definitions are now available in the Semantic Layer browser.
                Use the Guided Builder or drag metrics into your editor to start creating saved queries.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px', borderTop: `1px solid ${t.cellBorder}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            {step !== 'provider' && step !== 'importing' && step !== 'done' && (
              <button onClick={() => {
                if (step === 'configure') setStep('provider');
                else if (step === 'preview') setStep('configure');
              }} style={{
                background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 6,
                color: t.textSecondary, cursor: 'pointer', fontSize: 13, fontFamily: t.font,
                fontWeight: 500, padding: '7px 16px',
              }}>Back</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {step !== 'importing' && (
              <button onClick={onClose} style={{
                background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6,
                color: t.textSecondary, cursor: 'pointer', fontSize: 13, fontFamily: t.font,
                fontWeight: 500, padding: '7px 16px',
              }}>Cancel</button>
            )}

            {step === 'provider' && (
              <button onClick={() => provider && setStep('configure')} disabled={!provider} style={{
                background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6,
                color: '#fff', cursor: provider ? 'pointer' : 'not-allowed', fontSize: 13,
                fontFamily: t.font, fontWeight: 500, padding: '7px 20px',
                opacity: provider ? 1 : 0.5,
              }}>{provider === 'dbt' ? 'Connect dbt' : 'Next'}</button>
            )}

            {step === 'configure' && (
              <button onClick={handlePreview} disabled={previewLoading} style={{
                background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6,
                color: '#fff', cursor: previewLoading ? 'not-allowed' : 'pointer', fontSize: 13,
                fontFamily: t.font, fontWeight: 500, padding: '7px 20px',
                opacity: previewLoading ? 0.6 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>{previewLoading ? 'Validating...' : 'Validate & Preview'}</button>
            )}

            {step === 'preview' && (
              <button onClick={handleImport} style={{
                background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6,
                color: '#fff', cursor: 'pointer', fontSize: 13,
                fontFamily: t.font, fontWeight: 500, padding: '7px 20px',
              }}>Import</button>
            )}

            {step === 'done' && (
              <button onClick={handleDone} style={{
                background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6,
                color: '#fff', cursor: 'pointer', fontSize: 13,
                fontFamily: t.font, fontWeight: 500, padding: '7px 20px',
              }}>Open Semantic Browser</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
