import React, { useState, useEffect, useRef } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { NotebookFile } from '../../store/types';
import { blockGitPath } from './artifact-location';
import { authoredDomainOptions } from '../domains/authored-domain-options';

interface NewBlockModalProps {
  onFileOpened: (file: NotebookFile) => void;
}

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

export function NewBlockModal({ onFileOpened }: NewBlockModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [name, setName] = useState('');
  const [blockType, setBlockType] = useState<'custom' | 'semantic'>(state.newBlockModalDefaultType);
  const [domain, setDomain] = useState('');
  const [folderPath, setFolderPath] = useState('');
  // Shared by default, matching every block that already exists.
  const [visibility, setVisibility] = useState<'private' | 'shared'>('shared');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const domains = state.authoredDomains;
  const domainOptions = authoredDomainOptions(domains);

  useEffect(() => {
    setBlockType(state.newBlockModalDefaultType);
  }, [state.newBlockModalDefaultType]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
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

    try {
      const result = await api.createBlock(name.trim(), {
        blockType,
        ...(domain ? { domain } : {}),
        ...(folderPath.trim() ? { folderPath: folderPath.trim() } : {}),
        visibility,
      });
      const file: NotebookFile = {
        name: `${slug}.dql`,
        path: result.path,
        type: 'block',
        folder: result.path.split('/').slice(0, -1).join('/'),
        isNew: true,
        visibility: result.visibility ?? visibility,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
      onFileOpened(file);
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        setError('A saved query with this name already exists.');
      } else {
        setError(e.message ?? 'Failed to create saved query.');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
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
        style={{
          background: t.modalBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 12,
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: t.textPrimary,
              fontFamily: t.font,
              margin: 0,
            }}
          >
            New saved query
          </h2>
          <button
            onClick={() => dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' })}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: t.textMuted,
              fontSize: 18,
              lineHeight: 1,
              padding: '2px 4px',
              borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              onClick={() => setBlockType('custom')}
              style={{
                background: blockType === 'custom' ? `${t.accent}18` : t.btnBg,
                border: `1px solid ${blockType === 'custom' ? t.accent : t.btnBorder}`,
                borderRadius: 8,
                color: blockType === 'custom' ? t.accent : t.textSecondary,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: t.font,
                padding: '10px 12px',
                textAlign: 'left',
              }}
            >
              SQL query
              <span style={{ display: 'block', marginTop: 3, color: t.textMuted, fontWeight: 400, fontSize: 11 }}>
                Build from dbt models, tables, and SELECT queries.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setBlockType('semantic')}
              style={{
                background: blockType === 'semantic' ? `${t.accent}18` : t.btnBg,
                border: `1px solid ${blockType === 'semantic' ? t.accent : t.btnBorder}`,
                borderRadius: 8,
                color: blockType === 'semantic' ? t.accent : t.textSecondary,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: t.font,
                padding: '10px 12px',
                textAlign: 'left',
              }}
            >
              Query from metrics
              <span style={{ display: 'block', marginTop: 3, color: t.textMuted, fontWeight: 400, fontSize: 11 }}>
                Build from dbt/DQL metrics and dimensions.
              </span>
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: t.textSecondary, fontFamily: t.font }}>
              Who is this for
            </label>
            <div role="radiogroup" aria-label="Saved query visibility" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {([
                { value: 'shared' as const, label: 'Shared with the team', description: 'Git tracks it, so the team reviews it.' },
                { value: 'private' as const, label: 'Private to me', description: 'Outside Git until you publish it.' },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={visibility === option.value}
                  onClick={() => setVisibility(option.value)}
                  style={{
                    display: 'grid',
                    gap: 3,
                    padding: '9px 10px',
                    borderRadius: 8,
                    border: `1px solid ${visibility === option.value ? t.accent : t.inputBorder}`,
                    background: visibility === option.value ? 'var(--accent-dim)' : t.inputBg,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: t.font,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{option.label}</span>
                  <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.3 }}>{option.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: t.textSecondary,
                fontFamily: t.font,
              }}
            >
              Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              placeholder="revenue-summary"
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
            {name && !error && (
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
                {visibility === 'private'
                  ? `Private path: .dql/local/private/blocks/${folderPath.trim() ? `${folderPath.trim().replace(/^\/+|\/+$/g, '')}/` : ''}${slugify(name)}.dql`
                  : `Git path: ${blockGitPath(domains, domain, folderPath, slugify(name))}`}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, fontWeight: 500, color: t.textSecondary, fontFamily: t.font }}>
              Domain
              <select
                aria-label="Saved query domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 6,
                  color: t.textPrimary,
                  fontSize: 13,
                  fontFamily: t.font,
                  padding: '8px 10px',
                  outline: 'none',
                }}
              >
                <option value="">Global / cross-domain</option>
                {domainOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, fontWeight: 500, color: t.textSecondary, fontFamily: t.font }}>
              Folder
              <input
                aria-label="Saved query folder"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder="reporting/monthly"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 6,
                  color: t.textPrimary,
                  fontSize: 13,
                  fontFamily: t.fontMono,
                  padding: '8px 10px',
                  outline: 'none',
                }}
              />
            </label>
          </div>

          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              fontFamily: t.font,
              lineHeight: 1.5,
              padding: '8px 12px',
              background: t.pillBg,
              borderRadius: 6,
            }}
          >
            {blockType === 'semantic'
              ? 'Saved queries built from metrics use governed metrics, dimensions, and chart intent. They do not start with raw SQL.'
              : 'SQL blocks are reusable SELECT queries stored in the blocks/ folder. Use them for dbt models, tables, and imported SQL.'}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: `1px solid ${t.cellBorder}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <button
            onClick={() => dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' })}
            style={{
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 6,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '7px 16px',
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
              borderRadius: 6,
              color: '#ffffff',
              cursor: creating || !name.trim() ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '7px 20px',
              opacity: creating || !name.trim() ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {creating ? 'Creating...' : 'Create saved query'}
          </button>
        </div>
      </div>
    </div>
  );
}
