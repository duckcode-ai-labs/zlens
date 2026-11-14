import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useEffect, useRef } from 'react';
import {
  BookOpenText,
  ChartNoAxesCombined,
  CircleGauge,
  FlaskConical,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { NotebookFile } from '../../store/types';
import { authoredDomainOptions } from '../domains/authored-domain-options';
import { notebookFileStem } from './artifact-location';
import {
  buildTemplateCells,
  NOTEBOOK_TEMPLATE_CELL_SUMMARIES,
  NOTEBOOK_TEMPLATE_DESCRIPTIONS,
  NOTEBOOK_TEMPLATE_LABELS,
  type NotebookTemplate,
} from './notebook-templates';
import { useSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';

interface NewNotebookModalProps {
  onFileOpened: (file: NotebookFile) => void;
}

const NOTEBOOK_TEMPLATE_ICONS: Record<NotebookTemplate, LucideIcon> = {
  blank: BookOpenText,
  analysis: ChartNoAxesCombined,
  metric_diagnostic: CircleGauge,
  data_quality: ShieldCheck,
  experiment: FlaskConical,
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

function validateName(name: string): string | null {
  if (!name.trim()) return 'Name is required.';
  if (!/^[a-zA-Z0-9\-_ ]+$/.test(name)) return 'Only letters, numbers, hyphens, underscores, and spaces allowed.';
  return null;
}

export function NewNotebookModal({ onFileOpened }: NewNotebookModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [name, setName] = useState('');
  const [template, setTemplate] = useState<NotebookTemplate>('blank');
  const [ownerDomain, setOwnerDomain] = useState('');
  // Shared by default: this is the behaviour every existing notebook has, and
  // quietly hiding new work from the team would be the worse surprise.
  const [visibility, setVisibility] = useState<'private' | 'shared'>('shared');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The app for Snowflake serves one person and has no Git: no "who is this for", no file paths.
  const snowflakeApp = useSnowflakeApp();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const domainOptions = authoredDomainOptions(state.authoredDomains);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dispatch]);

  const handleCreate = async () => {
    const validationError = validateName(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    setCreating(true);
    setError(null);

    const slug = slugify(name);
    const stem = notebookFileStem(slug);
    const cells = buildTemplateCells(template);

    try {
      const result = await api.createNotebook(slug, template, {
        ...(ownerDomain ? { ownerDomain, usesDomains: [ownerDomain] } : {}),
        visibility,
      });
      const file: NotebookFile = {
        name: `${stem}.dqlnb`,
        path: result.path,
        type: 'notebook',
        folder: 'notebooks',
        isNew: true,
        visibility: result.visibility ?? visibility,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({
        type: 'OPEN_FILE',
        file,
        cells,
        title: name.trim(),
      });
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
      onFileOpened(file);
    } catch {
      // Server not available — create locally
      const path = `notebooks/${stem}.dqlnb`;
      const file: NotebookFile = {
        name: `${stem}.dqlnb`,
        path,
        type: 'notebook',
        folder: 'notebooks',
        isNew: true,
        visibility,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({
        type: 'OPEN_FILE',
        file,
        cells,
        title: name.trim(),
      });
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
      onFileOpened(file);
    } finally {
      setCreating(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: t.modalOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-notebook-title"
        style={{
          background: t.modalBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 14,
          width: 700,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'min(760px, calc(100vh - 48px))',
          boxShadow: '0 24px 72px rgba(0,0,0,0.38)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            borderBottom: `1px solid ${t.cellBorder}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, display: 'inline-grid', placeItems: 'center', color: t.accent, background: 'var(--accent-dim)', flexShrink: 0 }}>
              <BookOpenText size={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <div>
              <h2
                id="new-notebook-title"
                style={{
                  fontSize: 17,
                  fontWeight: 750,
                  color: t.textPrimary,
                  fontFamily: t.font,
                  margin: 0,
                }}
              >
                Create notebook
              </h2>
              <p style={{ margin: '3px 0 0', color: t.textMuted, fontSize: 11.5, lineHeight: 1.35, fontFamily: t.font }}>
                {snowflakeApp
                  ? 'Choose how much starter structure you want. Templates only add cells.'
                  : 'Choose who this notebook is for and how much starter structure you want. Templates only add cells.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close create notebook"
            onClick={() => dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' })}
            style={{
              width: 28,
              height: 28,
              display: 'inline-grid',
              placeItems: 'center',
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              cursor: 'pointer',
              color: t.textMuted,
              padding: 0,
              borderRadius: 7,
              flexShrink: 0,
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 13, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(210px, 0.72fr)', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
              <label
                htmlFor="new-notebook-name"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: t.textSecondary,
                  fontFamily: t.font,
                }}
              >
                Notebook name
              </label>
              <input
                id="new-notebook-name"
                ref={nameRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                placeholder="e.g. Customer retention analysis"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${error ? t.error : t.inputBorder}`,
                  borderRadius: 6,
                  color: t.textPrimary,
                  fontSize: 13,
                  fontFamily: t.font,
                  padding: '8px 12px',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                }}
              />
              {error && (
                <span style={{ fontSize: 11, color: t.error, fontFamily: t.font }}>
                  {error}
                </span>
              )}
              {name && !error && !snowflakeApp && (
                <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
                  {visibility === 'private'
                    ? `Private path: .dql/local/private/notebooks/${notebookFileStem(slugify(name))}.dqlnb`
                    : `Git path: notebooks/${notebookFileStem(slugify(name))}.dqlnb`}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: t.textSecondary, fontFamily: t.font }}>
                Domain context
              </label>
              <select
                aria-label="Notebook owner domain"
                value={ownerDomain}
                onChange={(event) => setOwnerDomain(event.target.value)}
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 6,
                  color: t.textPrimary,
                  fontSize: 13,
                  fontFamily: t.font,
                  padding: '8px 12px',
                  outline: 'none',
                }}
              >
                <option value="">Global / cross-domain</option>
                {domainOptions.map((domain) => (
                  <option key={domain.value} value={domain.value}>
                    {domain.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 10.5, lineHeight: 1.3, color: t.textMuted, fontFamily: t.font }}>
                {snowflakeApp
                  ? "Optional. Lists this notebook under the domain's Used by tab."
                  : "Optional. Lists this notebook under the domain's Used by tab without moving the Git file."}
              </span>
            </div>
          </div>

          {snowflakeApp ? null : <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: t.textSecondary, fontFamily: t.font }}>
              Who is this for
            </label>
            <div role="radiogroup" aria-label="Notebook visibility" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <VisibilityOption
                selected={visibility === 'shared'}
                onSelect={() => setVisibility('shared')}
                label="Shared with the team"
                description="Saved in notebooks/. Git tracks it, so the team reviews it and keeps or discards it."
                t={t}
              />
              <VisibilityOption
                selected={visibility === 'private'}
                onSelect={() => setVisibility('private')}
                label="Private to me"
                description="Saved outside Git. Nobody else sees it and no commit includes it until you publish it."
                t={t}
              />
            </div>
          </div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: t.textSecondary,
                fontFamily: t.font,
              }}
            >
              Starting point
            </label>
            <div style={{ padding: '6px 9px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textMuted, fontSize: 10.5, lineHeight: 1.35, fontFamily: t.font }}>
              Templates only add starter cells. They do not change execution, permissions, governance, or where the notebook is saved.
            </div>
            <div role="radiogroup" aria-label="Notebook starting point" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              {(Object.keys(NOTEBOOK_TEMPLATE_LABELS) as NotebookTemplate[]).map((tmpl) => (
                <TemplateOption
                  key={tmpl}
                  value={tmpl}
                  selected={template === tmpl}
                  onSelect={() => setTemplate(tmpl)}
                  label={NOTEBOOK_TEMPLATE_LABELS[tmpl]}
                  description={NOTEBOOK_TEMPLATE_DESCRIPTIONS[tmpl]}
                  cellSummary={NOTEBOOK_TEMPLATE_CELL_SUMMARIES[tmpl]}
                  Icon={NOTEBOOK_TEMPLATE_ICONS[tmpl]}
                  t={t}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: `1px solid ${t.cellBorder}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: t.cellBg,
          }}
        >
          <button
            onClick={() => dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' })}
            style={{
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 8,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '8px 15px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            style={{
              background: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 8,
              color: 'var(--accent-fg)',
              cursor: creating || !name.trim() ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '8px 16px',
              opacity: creating || !name.trim() ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <BookOpenText size={14} aria-hidden="true" />
            {creating ? 'Creating…' : 'Create notebook'}
          </button>
        </div>
      </div>
    </div>
  );
}

function VisibilityOption({
  selected,
  onSelect,
  label,
  description,
  t,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
  t: Theme;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        position: 'relative',
        display: 'grid',
        gap: 4,
        padding: '10px 28px 10px 10px',
        borderRadius: 10,
        border: `1px solid ${selected ? t.accent : t.inputBorder}`,
        background: selected ? 'var(--accent-dim)' : t.cellBg,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: t.font,
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 750, color: t.textPrimary }}>{label}</span>
      <span style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.3 }}>{description}</span>
      <span aria-hidden="true" style={{ position: 'absolute', right: 10, top: 10, width: 14, height: 14, borderRadius: 999, border: `1.5px solid ${selected ? t.accent : t.textMuted}`, display: 'inline-grid', placeItems: 'center' }}>
        {selected ? <span style={{ width: 7, height: 7, borderRadius: 999, background: t.accent }} /> : null}
      </span>
    </button>
  );
}

function TemplateOption({
  value,
  selected,
  onSelect,
  label,
  description,
  cellSummary,
  Icon,
  t,
}: {
  value: NotebookTemplate;
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
  cellSummary: string;
  Icon: LucideIcon;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${label}. ${cellSummary}`}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '30px minmax(0, 1fr)',
        gridColumn: value === 'blank' ? '1 / -1' : undefined,
        alignItems: 'start',
        gap: 9,
        minHeight: value === 'blank' ? 60 : 88,
        padding: '10px',
        borderRadius: 10,
        border: `1px solid ${selected ? t.accent : hovered ? t.textMuted : t.inputBorder}`,
        background: selected ? 'var(--accent-dim)' : hovered ? t.sidebarItemHover : t.cellBg,
        color: t.textPrimary,
        cursor: 'pointer',
        transition: 'all 0.15s',
        textAlign: 'left',
        fontFamily: t.font,
      }}
    >
      <span style={{ width: 30, height: 30, borderRadius: 8, display: 'inline-grid', placeItems: 'center', color: selected ? t.accent : t.textSecondary, background: selected ? t.cellBg : t.btnBg, border: `1px solid ${selected ? `${t.accent}40` : t.btnBorder}` }}>
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 750, color: t.textPrimary }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.3 }}>
          {description}
        </span>
        <span style={{ marginTop: 1, fontSize: 10, color: selected ? t.accent : t.textMuted, fontWeight: 650 }}>
          {cellSummary}
        </span>
      </span>
      <span aria-hidden="true" style={{ position: 'absolute', right: 10, top: 10, width: 14, height: 14, borderRadius: 999, border: `1.5px solid ${selected ? t.accent : t.textMuted}`, display: 'inline-grid', placeItems: 'center' }}>
        {selected ? <span style={{ width: 7, height: 7, borderRadius: 999, background: t.accent }} /> : null}
      </span>
    </button>
  );
}
