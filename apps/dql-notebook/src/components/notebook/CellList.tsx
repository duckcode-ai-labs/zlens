import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDispatch, useNotebookStore, makeCell } from '../../store/NotebookStore';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { themes } from '../../themes/notebook-theme';
import { CellComponent } from '../cells/Cell';
import { AddCellBar } from './AddCellBar';
import { api, type NotebookResearchRun } from '../../api/client';
import { BlockPicker, type BlockEntry } from '../blocks/BlockPicker';
import {
  deriveCellResearchState,
  NOTEBOOK_RESEARCH_CHANGED_EVENT,
  type NotebookResearchChangedDetail,
  notebookResearchSourceCellOption,
  notebookResearchSourceSyncStatus,
} from '../../utils/notebook-research';
import { NOTEBOOK_CELL_FOCUS_EVENT } from '../../utils/notebook-cell-focus';

interface CellListProps {
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
  onStartResearch?: (cellId: string, prompt?: string) => void;
  researchRefreshKey?: number;
}

export function CellList({ registerCellRef, onStartResearch, researchRefreshKey }: CellListProps) {
  const state = useNotebookStore(useShallow((store) => ({
    activeFile: store.activeFile,
    appMode: store.appMode,
    cells: store.cells,
    inspectorOpen: store.inspectorOpen,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const { executeCell } = useQueryExecution();
  const t = themes[state.themeMode];
  const sourceCells = useMemo(
    () => state.cells.map(notebookResearchSourceCellOption).filter((cell): cell is NonNullable<typeof cell> => Boolean(cell)),
    [state.cells],
  );
  const sourceCellById = useMemo(() => new Map(sourceCells.map((cell) => [cell.id, cell])), [sourceCells]);
  const sourceCellSignature = useMemo(
    () => sourceCells.map((cell) => `${cell.id}:${cell.fingerprint}`).join('|'),
    [sourceCells],
  );
  const [researchRunsByCellId, setResearchRunsByCellId] = useState<Map<string, NotebookResearchRun>>(new Map());

  // focusedCellId: the cell selected in command mode (not editing)
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  // Track last "d" keypress time for double-d detection
  const lastDPressRef = useRef<number>(0);

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const handleGutterClick = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
  }, []);

  useEffect(() => {
    const focusInsertedCell = (event: Event) => {
      const cellId = (event as CustomEvent<{ cellId?: string }>).detail?.cellId;
      if (!cellId) return;
      setFocusedCellId(cellId);
      window.requestAnimationFrame(() => {
        const target = Array.from(document.querySelectorAll<HTMLElement>('[data-cell-id]'))
          .find((element) => element.dataset.cellId === cellId);
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
    window.addEventListener(NOTEBOOK_CELL_FOCUS_EVENT, focusInsertedCell);
    return () => window.removeEventListener(NOTEBOOK_CELL_FOCUS_EVENT, focusInsertedCell);
  }, []);

  useEffect(() => {
    if (focusedCellId && state.inspectorOpen) {
      dispatch({ type: 'SET_INSPECTOR_CONTEXT', context: { kind: 'cell', cellId: focusedCellId } });
    }
  }, [focusedCellId, state.inspectorOpen, dispatch]);

  useEffect(() => {
    const notebookPath = state.activeFile?.path;
    if (!notebookPath || sourceCells.length === 0) {
      setResearchRunsByCellId(new Map());
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let loadingCoverage = false;
    const loadCoverage = () => {
      if (loadingCoverage || document.visibilityState !== 'visible') return;
      loadingCoverage = true;
      api.listNotebookResearchSourceCoverage({
        path: notebookPath,
        sourceCellIds: sourceCells.map((cell) => cell.id),
        sourceCells: sourceCells.map((cell) => ({
          id: cell.id,
          name: cell.name,
          type: cell.type,
          fingerprint: cell.fingerprint,
        })),
        limit: Math.max(100, Math.min(2_000, sourceCells.length * 4)),
      })
        .then((coverage) => {
          if (cancelled) return;
          const next = new Map<string, NotebookResearchRun>();
          for (const run of coverage.runs) {
            if (run.sourceCellId && !next.has(run.sourceCellId)) {
              next.set(run.sourceCellId, run);
            }
          }
          setResearchRunsByCellId(next);
        })
        .catch(() => {
          if (!cancelled) setResearchRunsByCellId(new Map());
        })
        .finally(() => { loadingCoverage = false; });
    };

    loadCoverage();
    const handleResearchChanged = (event: Event) => {
      const detail = (event as CustomEvent<NotebookResearchChangedDetail>).detail;
      if (detail?.notebookPath && detail.notebookPath !== notebookPath) return;
      loadCoverage();
    };
    window.addEventListener(NOTEBOOK_RESEARCH_CHANGED_EVENT, handleResearchChanged);
    timer = window.setInterval(loadCoverage, 15_000);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTEBOOK_RESEARCH_CHANGED_EVENT, handleResearchChanged);
      if (timer) window.clearInterval(timer);
    };
  }, [researchRefreshKey, sourceCellSignature, state.activeFile?.path]);

  // Global keyboard handler for command mode shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focusedCellId) return;

      // If the event target is an input/textarea/contenteditable, skip
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'INPUT' ||
        target.isContentEditable ||
        // CodeMirror editor is focused
        target.closest('.cm-editor')
      ) {
        setFocusedCellId(null);
        return;
      }

      const cells = state.cells;
      const idx = cells.findIndex((c) => c.id === focusedCellId);
      if (idx === -1) return;

      switch (e.key) {
        case 'a': {
          e.preventDefault();
          const cell = makeCell('sql');
          if (idx === 0) {
            // Prepend: add then move up from position 1 → 0
            dispatch({ type: 'ADD_CELL', cell, afterId: cells[0].id });
            dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'up' });
          } else {
            const afterId = cells[idx - 1].id;
            dispatch({ type: 'ADD_CELL', cell, afterId });
          }
          setFocusedCellId(cell.id);
          break;
        }

        case 'b': {
          e.preventDefault();
          const cell = makeCell('sql');
          dispatch({ type: 'ADD_CELL', cell, afterId: focusedCellId });
          setFocusedCellId(cell.id);
          break;
        }

        case 'd': {
          e.preventDefault();
          const now = Date.now();
          if (now - lastDPressRef.current <= 500) {
            // Double-d: delete cell
            dispatch({ type: 'DELETE_CELL', id: focusedCellId });
            // Focus adjacent cell
            if (cells.length > 1) {
              const newFocusIdx = idx > 0 ? idx - 1 : 1;
              setFocusedCellId(cells[newFocusIdx]?.id ?? null);
            } else {
              setFocusedCellId(null);
            }
            lastDPressRef.current = 0;
          } else {
            lastDPressRef.current = now;
          }
          break;
        }

        case 'Enter': {
          if (e.shiftKey) {
            e.preventDefault();
            const cell = cells[idx];
            if (cell && cell.type !== 'markdown') {
              executeCell(cell.id);
            }
          }
          break;
        }

        default:
          break;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusedCellId, state.cells, dispatch, executeCell]);

  // Clear focus when clicking outside any cell
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-cell-id]')) {
        setFocusedCellId(null);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Make the dragged element semi-transparent
    const target = e.currentTarget as HTMLElement;
    setTimeout(() => { target.style.opacity = '0.4'; }, 0);
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragIndex(null);
    setDropIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      dispatch({ type: 'REORDER_CELL', fromIndex: dragIndex, toIndex });
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, dispatch]);

  if (state.cells.length === 0) {
    return (
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '0 24px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <EmptyState t={t} />
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: '0 24px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {state.appMode === 'studio' && <AddCellBar afterId={undefined} />}

      {state.cells.map((cell, index) => (
        <React.Fragment key={cell.id}>
          <div
            ref={(el) => registerCellRef(cell.id, el)}
            data-cell-id={cell.id}
            draggable={state.appMode === 'studio'}
            onDragStart={state.appMode === 'studio' ? (e) => handleDragStart(e, index) : undefined}
            onDragEnd={state.appMode === 'studio' ? handleDragEnd : undefined}
            onDragOver={state.appMode === 'studio' ? (e) => handleDragOver(e, index) : undefined}
            onDrop={state.appMode === 'studio' ? (e) => handleDrop(e, index) : undefined}
            onClick={(e) => {
              // Select cell on gutter/header click but not editor area
              const target = e.target as HTMLElement;
              if (
                !target.closest('.cm-editor') &&
                !target.closest('textarea') &&
                !target.closest('input')
              ) {
                setFocusedCellId(cell.id);
              }
            }}
            style={{
              outline: focusedCellId === cell.id ? `2px solid ${t.accent}40` : 'none',
              outlineOffset: 2,
              borderRadius: 10,
              transition: 'outline 0.1s, transform 0.15s',
              position: 'relative',
              // Drop indicator
              ...(dropIndex === index && dragIndex !== null && dragIndex !== index
                ? { borderTop: `2px solid ${t.accent}` }
                : {}),
            }}
          >
            {/* Drag handle — visible on hover */}
            <div
              style={{
                position: 'absolute',
                left: -20,
                top: 8,
                width: 16,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'grab',
                color: t.textMuted,
                opacity: 0,
                transition: 'opacity 0.15s',
                zIndex: 5,
              }}
              className="drag-handle"
            >
              <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
                <circle cx="2" cy="2" r="1.2" />
                <circle cx="6" cy="2" r="1.2" />
                <circle cx="2" cy="7" r="1.2" />
                <circle cx="6" cy="7" r="1.2" />
                <circle cx="2" cy="12" r="1.2" />
                <circle cx="6" cy="12" r="1.2" />
              </svg>
            </div>
            <CellComponent
              cell={cell}
              index={index}
              onStartResearch={onStartResearch}
              researchState={deriveCellResearchState(
                sourceCellById.get(cell.id) ?? null,
                researchRunsByCellId.get(cell.id) ?? null,
                notebookResearchSourceSyncStatus(researchRunsByCellId.get(cell.id) ?? null, sourceCellById),
              )}
            />
          </div>
          {state.appMode === 'studio' && <AddCellBar afterId={cell.id} />}
        </React.Fragment>
      ))}

      {/* Global style for drag handle visibility */}
      <style>{`
        [data-cell-id]:hover .drag-handle { opacity: 0.5 !important; }
        [data-cell-id]:hover .drag-handle:hover { opacity: 1 !important; }
      `}</style>
    </div>
  );
}

function EmptyState({ t }: { t: Theme }) {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const dispatch = useDispatch();
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);

  const insertBoundBlock = async (block: BlockEntry) => {
    try {
      await api.openBlockStudio(block.path);
    } catch (error) {
      console.error('Failed to bind block cell', error);
      window.alert(`Couldn't load block ${block.path}.`);
      return;
    }
    const blockReference = `@block(${JSON.stringify(block.name)})`;
    const cell = makeCell('dql', blockReference);
    cell.name = block.name;
    cell.blockBinding = {
      path: block.path,
      state: 'bound',
      originalContent: blockReference,
    };
    dispatch({ type: 'ADD_CELL', cell });
    setBlockPickerOpen(false);
  };

  const startActionStyle: React.CSSProperties = {
    minHeight: 58,
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    color: t.textPrimary,
    borderRadius: 8,
    padding: '9px 11px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: t.font,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '28px 0 56px',
        gap: 16,
        color: t.textSecondary,
        width: 'min(760px, 100%)',
        margin: '0 auto',
      }}
    >
      <div>
        <div style={{ font: `750 18px ${t.font}`, color: t.textPrimary }}>
          What are you researching?
        </div>
        <div style={{ marginTop: 4, font: `12px/1.5 ${t.font}`, color: t.textMuted }}>
          Start from trusted work when it exists, or explore directly with DQL, AI, and local data.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <button type="button" style={{ ...startActionStyle, borderColor: t.accent }} onClick={() => setBlockPickerOpen((open) => !open)}>
          <strong style={{ display: 'block', color: t.accent }}>Use existing block</strong>
          <span style={{ display: 'block', color: t.textMuted, fontSize: 10.5, marginTop: 3 }}>Search certified and draft reusable analysis.</span>
        </button>
        <button type="button" style={startActionStyle} onClick={() => window.dispatchEvent(new CustomEvent('dql:open-notebook-ai'))}>
          <strong style={{ display: 'block' }}>Ask Notebook AI</strong>
          <span style={{ display: 'block', color: t.textMuted, fontSize: 10.5, marginTop: 3 }}>Research blocks, semantic models, dbt, and data.</span>
        </button>
        <button type="button" style={startActionStyle} onClick={() => dispatch({ type: 'ADD_CELL', cell: makeCell('dql') })}>
          <strong style={{ display: 'block' }}>Create DQL query</strong>
          <span style={{ display: 'block', color: t.textMuted, fontSize: 10.5, marginTop: 3 }}>Build a governed or exploratory query.</span>
        </button>
        <button type="button" style={startActionStyle} onClick={() => window.dispatchEvent(new CustomEvent('dql:open-dataset-import'))}>
          <strong style={{ display: 'block' }}>Import local data</strong>
          <span style={{ display: 'block', color: t.textMuted, fontSize: 10.5, marginTop: 3 }}>Bring CSV, Parquet, or JSON into the research.</span>
        </button>
      </div>

      {blockPickerOpen && (
        <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 10, background: t.cellBg }}>
          <BlockPicker
            themeMode={themeMode}
            compact={false}
            onPick={(block) => void insertBoundBlock(block)}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => dispatch({ type: 'ADD_CELL', cell: makeCell('markdown', '## Research note\n\n') })}
        style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', color: t.accent, cursor: 'pointer', font: `700 11px ${t.font}`, padding: 0 }}
      >
        + Add a research note instead
      </button>
    </div>
  );
}
