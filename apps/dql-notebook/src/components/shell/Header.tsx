import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { notebookStoreApi, useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { HostPersonMenu } from './HostPersonMenu';
import { hostReadOnly, navKeyForView, readOnlyReason, useHostUi } from '../../host/host-ui';
import { api } from '../../api/client';
import { serializeDqlNotebook } from '../../utils/parse-workbook';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { downloadDashboard } from '../../utils/export-dashboard';
import { setBlockName } from '../../utils/block-studio';
import { TaskCenter } from './TaskCenter';
import { ZLensMark } from './ZLensMark';
import { PAGE_NAMES } from './page-title';
import { createNotebookSaveQueue } from '../../utils/notebook-save-queue';

// Saves to one notebook file are serialized; see utils/notebook-save-queue.ts.
const notebookSaveQueue = createNotebookSaveQueue((path, content) => api.saveNotebook(path, content));
const enqueueNotebookSave = notebookSaveQueue.enqueue;
const notebookSavePending = notebookSaveQueue.pending;

/** The product mark in the Workbench chrome (the ZLens symbol, not a text badge). */
function ProductMark({ t }: { t: Theme }) {
  return (
    <span style={{ display: 'inline-flex', color: t.textPrimary, flexShrink: 0 }}>
      <ZLensMark size={26} />
    </span>
  );
}

export function Header() {
  // The product is ZLens on every page (never "Workbench": business readers use it too).
  const hostUi = useHostUi();
  const productName = 'ZLens';
  const state = useNotebookStore(useShallow((store) => ({
    activeBlockPath: store.activeBlockPath,
    activeFile: store.activeFile,
    appMode: store.appMode,
    autoSave: store.autoSave,
    blockStudioDirty: store.blockStudioDirty,
    blockStudioDraft: store.blockStudioDraft,
    blockStudioMetadata: store.blockStudioMetadata,
    cells: store.cells,
    files: store.files,
    mainView: store.mainView,
    notebookDirty: store.notebookDirty,
    notebookMetadata: store.notebookMetadata,
    notebookTitle: store.notebookTitle,
    savingFile: store.savingFile,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const readOnlyKey = navKeyForView(state.mainView);
  const readOnly = readOnlyKey !== null && hostReadOnly(hostUi, readOnlyKey);
  const t = themes[state.themeMode];
  const { executeAll } = useQueryExecution();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [runHover, setRunHover] = useState(false);
  const [saveHover, setSaveHover] = useState(false);
  const [exportHover, setExportHover] = useState(false);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const currentDirty = state.mainView === 'block_studio' ? state.blockStudioDirty : state.notebookDirty;
  const inNotebookExecutionView = state.mainView === 'notebook';
  // Only notebook/Block Studio are file-editing surfaces; every other view
  // gets a static title and hides the file chip + editor actions.
  const isEditorView = state.mainView === 'notebook' || state.mainView === 'block_studio';
  const hasActiveEditorFile = isEditorView && Boolean(state.activeFile);
  // Every page names itself (the same names as the browser tab, see page-title.ts).
  const VIEW_TITLES: Partial<Record<typeof state.mainView, string>> = {
    ...PAGE_NAMES,
    business_artifact: state.activeFile?.name.replace(/\.(dqlnb|dql)$/i, '') ?? 'Business definition',
    host_page: productName,
  };
  const headerTitle = isEditorView
    ? state.activeFile
      ? state.notebookTitle || 'Untitled'
      : state.mainView === 'block_studio'
        ? 'Saved queries'
        : 'Notebooks'
    : VIEW_TITLES[state.mainView] ?? productName;

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportDropdownOpen) return;
    function handler(e: MouseEvent) {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
        setExportDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportDropdownOpen]);

  const startEditTitle = () => {
    if (readOnly) return;
    setTitleDraft(state.notebookTitle);
    setEditingTitle(true);
  };

  const commitTitle = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== state.notebookTitle) {
      if (state.mainView === 'block_studio' && state.blockStudioMetadata) {
        dispatch({
          type: 'SET_BLOCK_STUDIO_METADATA',
          metadata: {
            ...state.blockStudioMetadata,
            name: titleDraft.trim(),
          },
        });
        dispatch({
          type: 'SET_BLOCK_STUDIO_DRAFT',
          draft: setBlockName(state.blockStudioDraft, titleDraft.trim()),
        });
      } else {
        dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: true });
      }
    }
  };

  const handleSave = useCallback(async () => {
    // Read-only for this person: nothing to save (the host would refuse it).
    if (readOnly) return;
    const runtime = notebookStoreApi.getState();
    if (runtime.mainView === 'block_studio') {
      // Block Studio owns its save: identity, validation, the certified-to-draft
      // rule and the sidebar refresh. A second save path here skipped all of them.
      window.dispatchEvent(new Event('dql:block-studio-save'));
      return;
    }
    if (!runtime.activeFile) return;
    dispatch({ type: 'SET_SAVING', saving: true });
    try {
      {
        const savedFile = runtime.activeFile;
        const savedCells = runtime.cells;
        const savedTitle = runtime.notebookTitle;
        const savedMetadata = runtime.notebookMetadata;
        const content = savedFile.type === 'block'
          ? (savedCells[0]?.content ?? '')
          : serializeDqlNotebook(savedTitle, savedCells, savedMetadata);
        await enqueueNotebookSave(savedFile.path, content);
        const latest = notebookStoreApi.getState();
        if (
          latest.activeFile?.path === savedFile.path
          && latest.cells === savedCells
          && latest.notebookTitle === savedTitle
          && latest.notebookMetadata === savedMetadata
        ) {
          dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: false });
        }
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      const activePath = notebookStoreApi.getState().activeFile?.path;
      if (!activePath || !notebookSavePending(activePath)) dispatch({ type: 'SET_SAVING', saving: false });
    }
  }, [dispatch, readOnly]);

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Auto-save: persist notebook/block edits quickly after inactivity.
  // AI insert/repair actions dispatch ADD_CELL/UPDATE_CELL, so they are covered
  // by the same path as manual edits.
  useEffect(() => {
    if (!state.autoSave || !currentDirty || !state.activeFile || state.mainView === 'block_studio') return;
    const timer = setTimeout(() => {
      handleSave();
    }, 750);
    return () => clearTimeout(timer);
  }, [state.autoSave, currentDirty, state.activeFile, state.cells, state.blockStudioDraft, handleSave]);

  const btnBase = {
    height: 28,
    padding: '0 10px',
    borderRadius: 6,
    border: `1px solid ${t.btnBorder}`,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: t.font,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    transition: 'background 0.15s, color 0.15s',
    whiteSpace: 'nowrap' as const,
  };

  return (
    <div
      style={{
        height: 48,
        flexShrink: 0,
        background: t.headerBg,
        borderBottom: `1px solid ${t.headerBorder}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 8,
        userSelect: 'none',
      }}
    >
      {/* Left: Logo + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <ProductMark t={t as any} />
        <div
          style={{
            width: 1,
            height: 20,
            background: t.headerBorder,
            flexShrink: 0,
          }}
        />
        {state.activeFile && isEditorView && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: state.activeFile.type === 'block' ? '#e3b341' : t.accent,
              background: `${state.activeFile.type === 'block' ? '#e3b341' : t.accent}18`,
              borderRadius: 4,
              padding: '2px 6px',
              fontFamily: t.font,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              flexShrink: 0,
            }}
          >
            {state.activeFile.type}
          </span>
        )}
        {state.activeFile && isEditorView ? (
          editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              style={{
                background: 'transparent',
                border: `1px solid ${t.cellBorderActive}`,
                borderRadius: 4,
                color: t.textPrimary,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: t.font,
                padding: '2px 6px',
                outline: 'none',
                minWidth: 120,
                maxWidth: 320,
              }}
            />
          ) : (
            <span
              onClick={startEditTitle}
              title="Click to rename"
              style={{
                color: t.textPrimary,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: t.font,
                cursor: 'text',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                padding: '2px 4px',
                borderRadius: 4,
                border: '1px solid transparent',
              }}
            >
              {headerTitle}
              {currentDirty && (
                <span style={{ color: t.textMuted, marginLeft: 4 }}>●</span>
              )}
            </span>
          )
        ) : (
          <span
            style={{
              color: t.textSecondary,
              fontSize: 13,
              fontFamily: t.font,
              padding: '2px 4px',
            }}
          >
            {headerTitle || productName}
          </span>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right: actions. Apps are opened from the sidebar, so the header stays
          focused on the active authoring surface. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <TaskCenter />
        {state.appMode === 'studio' && hasActiveEditorFile && state.mainView !== 'block_studio' && (
          <>
            {/* v1.3.3 Hex handoff — Run all pill. Accent purple primary CTA. */}
            <button
              onClick={inNotebookExecutionView ? executeAll : undefined}
              disabled={!state.activeFile || !inNotebookExecutionView}
              onMouseEnter={() => setRunHover(true)}
              onMouseLeave={() => setRunHover(false)}
              style={{
                ...btnBase,
                height: 30,
                padding: '0 14px',
                borderRadius: 999,
                background: t.accent,
                color: '#ffffff',
                border: `1px solid ${t.accent}`,
                opacity: !state.activeFile || !inNotebookExecutionView ? 0.4 : runHover ? 0.9 : 1,
                boxShadow: '0 1px 2px rgba(107,93,211,0.25)',
                gap: 6,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M1.5 1.5l7 3.5-7 3.5V1.5Z" />
              </svg>
              Run all
            </button>
          </>
        )}

        {/* The theme is chosen in Settings » Appearance (and the command palette), not in the header. */}
        {state.appMode === 'studio' && hasActiveEditorFile && state.mainView !== 'block_studio' && (
          <>
        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!state.activeFile || state.savingFile || readOnly}
          onMouseEnter={() => setSaveHover(true)}
          onMouseLeave={() => setSaveHover(false)}
          title={readOnly ? readOnlyReason(hostUi, readOnlyKey ?? 'files') : 'Save (Cmd+S)'}
          style={{
            ...btnBase,
            background: saveHover && state.activeFile ? t.btnHover : t.btnBg,
            color: savedFlash ? t.success : t.textSecondary,
            opacity: !state.activeFile || readOnly ? 0.4 : 1,
            cursor: readOnly ? 'not-allowed' : 'pointer',
          }}
        >
          {state.savingFile ? (
            <>
              <SpinnerIcon />
              Saving…
            </>
          ) : savedFlash ? (
            <>✓ Saved</>
          ) : (
            <>Save</>
          )}
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 20, background: t.headerBorder }} />
          </>
        )}

        {/* v1.3.3 Hex handoff — Share pill (dark ink). Editor views only;
            opens the same export menu the old "Export" button used. */}
        {hasActiveEditorFile && state.mainView !== 'block_studio' && (
        <div ref={exportDropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (state.activeFile) setExportDropdownOpen((o) => !o);
            }}
            disabled={!state.activeFile}
            onMouseEnter={() => setExportHover(true)}
            onMouseLeave={() => setExportHover(false)}
            title="Share / export"
            style={{
              ...btnBase,
              height: 30,
              padding: '0 14px',
              borderRadius: 999,
              background: (exportHover || exportDropdownOpen) && state.activeFile ? '#2a2a30' : '#1a1a1a',
              color: '#ffffff',
              border: '1px solid #1a1a1a',
              opacity: !state.activeFile ? 0.4 : 1,
              gap: 6,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 10.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Zm0-3a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75ZM3 3.75A1.75 1.75 0 0 1 4.75 2h6.586c.464 0 .909.184 1.237.513l1.914 1.914c.329.328.513.773.513 1.237v6.586A1.75 1.75 0 0 1 13.25 14h-8.5A1.75 1.75 0 0 1 3 12.25Z" />
            </svg>
            Share
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: 1, opacity: 0.7 }}>
              <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          {exportDropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: 32,
                right: 0,
                zIndex: 200,
                background: t.modalBg,
                border: `1px solid ${t.cellBorder}`,
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                padding: 4,
                minWidth: 160,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <ExportMenuItem
                label="Export HTML"
                description="Standalone dashboard"
                t={t}
                onClick={() => {
                  downloadDashboard(state.notebookTitle || 'dashboard', state.cells);
                  setExportDropdownOpen(false);
                }}
              />
            </div>
          )}
        </div>
        )}

        {/* RFC 0010 HH-9: the signed-in person and the host's links (only with a host). */}
        <HostPersonMenu />
      </div>
    </div>
  );
}

function ExportMenuItem({
  label,
  description,
  t,
  onClick,
}: {
  label: string;
  description: string;
  t: Theme;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.btnHover : 'transparent',
        border: 'none',
        borderRadius: 5,
        cursor: 'pointer',
        padding: '6px 10px',
        textAlign: 'left' as const,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        transition: 'background 0.12s',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 500, color: t.textPrimary, fontFamily: t.font }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{description}</span>
    </button>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{ animation: 'spin 0.8s linear infinite' }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 7" />
    </svg>
  );
}
