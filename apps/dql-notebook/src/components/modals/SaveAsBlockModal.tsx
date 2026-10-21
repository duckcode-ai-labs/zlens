import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { Cell } from '../../store/types';
import { authoredDomainOptionsWithCurrent } from '../domains/authored-domain-options';
import { savedBlockGitPath } from './artifact-location';

interface SaveAsBlockModalProps {
  cell: Cell;
  onClose: () => void;
  onSaved?: (result: { path: string; content: string; name: string; status: 'certified' | 'draft'; blockers: string[] }) => void;
  /** Override the starting block source (required for cell types that compute their output). */
  initialContent?: string;
  initialName?: string;
  initialDescription?: string;
  initialTags?: string[];
  initialDomain?: string;
  initialOwner?: string;
}

function RequiredMark() {
  return <span style={{ color: '#ff7b72', marginLeft: 2 }}>*</span>;
}

function extractSemanticRefs(content: string): string[] {
  const refs = new Set<string>();
  const regex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    refs.add(match[2].trim());
  }
  return Array.from(refs);
}

export function SaveAsBlockModal({
  cell,
  onClose,
  onSaved,
  initialContent,
  initialName,
  initialDescription,
  initialTags,
  initialDomain,
  initialOwner,
}: SaveAsBlockModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initialName || cell.name || 'new_block');
  const [domain, setDomain] = useState(initialDomain ?? '');
  const [owner, setOwner] = useState(initialOwner ?? '');
  const [description, setDescription] = useState(initialDescription ?? state.notebookMetadata.description ?? '');
  const [tags, setTags] = useState((initialTags ?? state.notebookMetadata.categories ?? []).join(', '));
  const [content, setContent] = useState(initialContent ?? cell.content);
  // v1.2 Track G — optional agent-facing metadata. Blank values are not written.
  const [llmContext, setLlmContext] = useState('');
  const [invariantsText, setInvariantsText] = useState('');
  const [examples, setExamples] = useState<Array<{ question: string; sql: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const semanticRefs = useMemo(() => extractSemanticRefs(content), [content]);
  const tagList = useMemo(() => tags.split(',').map((s) => s.trim()).filter(Boolean), [tags]);

  const ruleResults: { id: string; label: string; severity: 'error' | 'warning'; passed: boolean }[] = [
    { id: 'has-name', label: 'Block has name', severity: 'error', passed: !!name.trim() },
    { id: 'has-owner', label: 'Block has owner', severity: 'error', passed: !!owner.trim() },
    { id: 'has-description', label: 'Description', severity: 'warning', passed: !!description.trim() },
    { id: 'has-domain', label: 'Domain', severity: 'warning', passed: !!domain.trim() },
    { id: 'has-tags', label: 'Has at least one tag', severity: 'warning', passed: tagList.length > 0 },
    { id: 'has-llm-context', label: 'Has LLM context (for agents)', severity: 'warning', passed: !!llmContext.trim() },
  ];

  const hasErrors = ruleResults.some((r) => r.severity === 'error' && !r.passed);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const knownDomains = authoredDomainOptionsWithCurrent(domain, state.authoredDomains);
  const blockPath = savedBlockGitPath(state.authoredDomains, domain, name);

  const handleSave = async () => {
    if (hasErrors) {
      setError('Enter the block name and owner before saving.');
      return;
    }
    if (!content.trim()) {
      setError('Block content is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const invariantsList = invariantsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const exampleList = examples
        .map((ex) => ({
          question: ex.question.trim(),
          sql: ex.sql.trim() || undefined,
        }))
        .filter((ex) => ex.question);
      const result = await api.saveAsBlock({
        cellId: cell.id,
        notebookPath: state.activeFile?.path ?? null,
        name: name.trim(),
        domain: domain.trim() || undefined,
        owner: owner.trim() || undefined,
        content,
        description: description.trim() || undefined,
        tags: tagList,
        metricRefs: semanticRefs,
        llmContext: llmContext.trim() || undefined,
        examples: exampleList.length > 0 ? exampleList : undefined,
        invariants: invariantsList.length > 0 ? invariantsList : undefined,
        reviewRequired: Boolean(cell.datasetRefs?.length),
        datasetRefs: cell.datasetRefs,
        lineage: cell.dqlArtifact?.lineage,
      });
      const file = {
        name: result.path.split('/').pop() ?? result.path,
        path: result.path,
        type: 'block' as const,
        folder: 'blocks',
      };
      if (!state.files.some((existing) => existing.path === result.path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      const payload = await api.openBlockStudio(result.path);
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
      onSaved?.({ ...result, name: name.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${error ? t.error : t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 13,
    fontFamily: t.font,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: t.modalOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 760,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          overflow: 'auto',
          background: t.modalBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            padding: '20px 24px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
            Save as Block
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 18 }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                Block Name <RequiredMark />
              </label>
              <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                Domain
              </label>
              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                style={inputStyle}
              >
                <option value="">Global / cross-domain</option>
                {knownDomains.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                Owner <RequiredMark />
              </label>
              <input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                style={inputStyle}
                placeholder="data-platform@company.com"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Tags</label>
              <input value={tags} onChange={(e) => setTags(e.target.value)} style={inputStyle} placeholder="revenue, dashboard" />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
              Description
            </label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
          </div>

          <details style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 6, padding: '8px 12px' }}>
            <summary style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, cursor: 'pointer' }}>
              Agent-facing metadata (optional — helps AI tools ground answers on this block)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                  How should an AI describe this block?
                </label>
                <textarea
                  value={llmContext}
                  onChange={(e) => setLlmContext(e.target.value)}
                  rows={3}
                  placeholder="One paragraph. E.g. &quot;Monthly revenue recognized from closed-won deals, grouped by billing month. Excludes refunds.&quot;"
                  style={{ ...inputStyle, fontFamily: t.font, lineHeight: 1.5, resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                  Invariants (one per line)
                </label>
                <textarea
                  value={invariantsText}
                  onChange={(e) => setInvariantsText(e.target.value)}
                  rows={2}
                  placeholder="Revenue is never negative&#10;Each row is a unique month"
                  style={{ ...inputStyle, fontFamily: t.fontMono, lineHeight: 1.5, resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>
                  Example questions (grounding for chat cells)
                </label>
                {examples.map((ex, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <input
                        value={ex.question}
                        onChange={(e) => {
                          const next = [...examples];
                          next[i] = { ...next[i], question: e.target.value };
                          setExamples(next);
                        }}
                        placeholder="What was revenue last month?"
                        style={inputStyle}
                      />
                      <input
                        value={ex.sql}
                        onChange={(e) => {
                          const next = [...examples];
                          next[i] = { ...next[i], sql: e.target.value };
                          setExamples(next);
                        }}
                        placeholder="Optional SQL snippet"
                        style={{ ...inputStyle, fontFamily: t.fontMono, fontSize: 12 }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setExamples(examples.filter((_, idx) => idx !== i))}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${t.cellBorder}`,
                        borderRadius: 6,
                        color: t.textMuted,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '0 10px',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setExamples([...examples, { question: '', sql: '' }])}
                  style={{
                    alignSelf: 'flex-start',
                    background: t.btnBg,
                    border: `1px solid ${t.btnBorder}`,
                    borderRadius: 6,
                    color: t.textSecondary,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontFamily: t.font,
                    padding: '4px 10px',
                  }}
                >
                  + Add example
                </button>
              </div>
            </div>
          </details>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '10px 12px',
              background: t.pillBg,
              borderRadius: 6,
              border: `1px solid ${t.cellBorder}`,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary, fontFamily: t.font, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Governance checks
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ruleResults.map((rule) => {
                const color = rule.passed ? '#3fb950' : rule.severity === 'error' ? '#ff7b72' : '#e3b341';
                const glyph = rule.passed ? '✓' : rule.severity === 'error' ? '✕' : '!';
                return (
                  <span
                    key={rule.id}
                    title={rule.passed ? `${rule.label} — passed` : `${rule.label} — ${rule.severity}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      fontFamily: t.font,
                      color,
                      background: `${color}18`,
                      border: `1px solid ${color}55`,
                      borderRadius: 999,
                      padding: '2px 10px',
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>{glyph}</span>
                    {rule.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              fontFamily: t.fontMono,
              padding: '8px 12px',
              background: t.pillBg,
              borderRadius: 6,
            }}
          >
            {blockPath}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Content Preview</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{
                ...inputStyle,
                minHeight: 220,
                resize: 'vertical',
                fontFamily: t.fontMono,
                lineHeight: 1.5,
              }}
            />
          </div>

          {semanticRefs.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                padding: '10px 12px',
                background: t.pillBg,
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Detected semantic refs:</span>
              {semanticRefs.map((ref) => (
                <span
                  key={ref}
                  style={{
                    fontSize: 11,
                    color: t.accent,
                    fontFamily: t.fontMono,
                    background: `${t.accent}18`,
                    borderRadius: 999,
                    padding: '2px 8px',
                  }}
                >
                  {ref}
                </span>
              ))}
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: t.error, fontFamily: t.font }}>{error}</div>}
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: `1px solid ${t.cellBorder}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 11.5, color: t.textMuted, marginRight: 'auto', alignSelf: 'center' }}>
            {cell.datasetRefs?.length
              ? 'This analysis uses imported or staged data, so it will be saved as a review-required draft. Certification requires project-controlled, contracted, tested, reproducible sources.'
              : 'Saved as a draft block that needs review. Saving never certifies: open it in Block Studio and click Certify when it is ready.'}
          </span>
          <button
            onClick={onClose}
            style={{
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 6,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              padding: '7px 16px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || hasErrors}
            title={hasErrors ? 'Fix governance errors to enable Save' : undefined}
            style={{
              background: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              color: '#fff',
              cursor: saving || hasErrors ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              padding: '7px 20px',
              opacity: saving || hasErrors ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving draft…' : 'Save draft block'}
          </button>
        </div>
      </div>
    </div>
  );
}
