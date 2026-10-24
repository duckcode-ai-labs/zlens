import type { Theme } from "../../themes/notebook-theme";
import React, { useState, useRef, useEffect } from "react";
import { Upload } from "lucide-react";
import { useNotebook, makeCell } from "../../store/NotebookStore";
import { themes } from "../../themes/notebook-theme";
import type { Cell, CellType } from "../../store/types";
import {
  parseSemanticDragRef,
  SEMANTIC_REF_MIME,
} from "../../editor/semantic-completions";
import { api } from "../../api/client";
import { BlockPicker, type BlockEntry } from "../blocks/BlockPicker";
import { extractSqlFromText } from "../../utils/block-studio";
import {
  BlockIcon,
  SQLCellIcon,
  ParamCellIcon,
  FileText,
  Sparkles,
} from '@zlens/ui/icons';

interface AddCellBarProps {
  afterId?: string;
}

type PaletteType = CellType | "block" | "ai_sql" | "import_data";

type PaletteEntry = {
  type: PaletteType;
  label: string;
  Icon: React.ComponentType<any>;
  color: string;
};

const CORE_PALETTE: PaletteEntry[] = [
  {
    type: "block",
    label: "Saved query",
    Icon: BlockIcon,
    color: "#6b8afd",
  },
  {
    type: "ai_sql",
    label: "Ask AI",
    Icon: Sparkles,
    color: "#f0883e",
  },
  {
    type: "dql",
    label: "DQL",
    Icon: BlockIcon,
    color: "#6b8afd",
  },
  {
    type: "sql",
    label: "SQL",
    Icon: SQLCellIcon,
    color: "#3b8ef0",
  },
  {
    type: "import_data",
    label: "Import",
    Icon: Upload,
    color: "#5dd1c8",
  },
  {
    type: "markdown",
    label: "Note",
    Icon: FileText,
    color: "#2fb97a",
  },
  {
    type: "param",
    label: "Input",
    Icon: ParamCellIcon,
    color: "#9aa0ae",
  },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
        setBlockPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const closeAll = () => {
    setPopoverOpen(false);
    setBlockPickerOpen(false);
  };

  const addCell = (type: CellType) => {
    const cell = makeCell(type);
    dispatch({ type: 'ADD_CELL', cell, afterId });
    closeAll();
  };

  const insertBoundBlockCell = async (block: BlockEntry) => {
    try {
      await api.openBlockStudio(block.path);
    } catch (error) {
      console.error('Failed to bind block cell', error);
      window.alert(`Couldn't load saved query ${block.path}. Check the console for details.`);
      closeAll();
      return;
    }
    const blockReference = `@block(${JSON.stringify(block.name)})`;
    const cell = makeCell('dql', blockReference);
    cell.name = block.name;
    cell.blockBinding = { path: block.path, state: 'bound', originalContent: blockReference };
    dispatch({ type: 'ADD_CELL', cell, afterId });
    closeAll();
  };

  return (
    <div
      ref={containerRef}
      data-testid="add-cell-bar"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SEMANTIC_REF_MIME)) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        const payload = parseSemanticDragRef(event.dataTransfer.getData(SEMANTIC_REF_MIME));
        if (!payload) return;
        event.preventDefault();
        setDropActive(false);
        const cell = makeCell('sql', payload.reference);
        dispatch({ type: 'ADD_CELL', cell, afterId });
        void api.trackUsage(payload.name);
        window.dispatchEvent(new CustomEvent('dql:semantic-used', { detail: { name: payload.name } }));
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDropActive(false);
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        setHovered(true);
        setPopoverOpen(true);
      }}
      style={{
        position: 'relative',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: popoverOpen ? 'default' : 'pointer',
      }}
    >
      {(hovered || popoverOpen || dropActive) && (
        <button
          aria-label="Add cell"
          onClick={() => setPopoverOpen((p) => !p)}
          style={{
            position: 'relative',
            zIndex: 2,
            height: 22,
            padding: '0 10px',
            borderRadius: 11,
            border: `1px solid ${dropActive ? t.accent : t.cellBorderActive}`,
            background: dropActive ? `${t.accent}28` : `${t.accent}18`,
            color: t.accent,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: t.font,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>
          Add cell
        </button>
      )}

      {popoverOpen && (
        <div
          style={{
            position: 'absolute',
            top: 26,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            background: t.modalBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: blockPickerOpen ? 'min(760px, calc(100vw - 48px))' : 'max-content',
            maxWidth: 'calc(100vw - 48px)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 4,
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'flex-start',
              overflowX: 'auto',
              overflowY: 'hidden',
              maxWidth: '100%',
              paddingBottom: 1,
            }}
          >
            {CORE_PALETTE.map((entry) => (
              <PaletteTile
                key={entry.type}
                entry={entry}
                active={entry.type === 'block' && blockPickerOpen}
                onClick={() => {
                  if (entry.type === "block") {
                    setBlockPickerOpen((v) => !v);
                    return;
                  }
                  if (entry.type === 'ai_sql') {
                    // Open the governed Notebook AI drawer at this position — the
                    // same DQL-first cascade as Ask AI, not the legacy SQL dialog.
                    window.dispatchEvent(new CustomEvent('dql:open-notebook-ai', { detail: { afterId } }));
                    closeAll();
                    return;
                  }
                  if (entry.type === "import_data") {
                    window.dispatchEvent(
                      new CustomEvent("dql:open-dataset-import", {
                        detail: { afterId },
                      }),
                    );
                    closeAll();
                    return;
                  }
                  addCell(entry.type as CellType);
                }}
                t={t}
              />
            ))}
          </div>

          {blockPickerOpen && (
            <div
              style={{
                padding: '6px 2px 2px',
                borderTop: `1px solid ${t.cellBorder}`,
              }}
            >
              <BlockPicker
                themeMode={state.themeMode}
                onPick={(block) => void insertBoundBlockCell(block)}
              />
            </div>
          )}

        </div>
      )}
    </div>
  );
}

function PaletteTile({
  entry,
  onClick,
  t,
  active = false,
}: {
  entry: PaletteEntry;
  onClick: () => void;
  t: Theme;
  active?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const highlighted = active || hovered;
  const Icon = entry.Icon;
  return (
    <button
      aria-label={
        entry.type === "ai_sql"
          ? "Ask AI"
          : entry.type === "import_data"
            ? "Import data"
            : `Add ${entry.label} cell`
      }
      data-testid={`add-cell-${entry.type}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={entry.label}
      style={{
        background: highlighted ? `${entry.color}18` : 'transparent',
        border: `1px solid ${highlighted ? entry.color : t.cellBorder}`,
        borderRadius: 8,
        cursor: 'pointer',
        color: highlighted ? entry.color : t.textSecondary,
        fontSize: 11,
        fontFamily: t.font,
        fontWeight: 600,
        padding: '0 11px',
        width: 'auto',
        minWidth: 'max-content',
        height: 40,
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        transition: 'all 0.12s',
      }}
    >
      <span style={{ color: entry.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={16} strokeWidth={1.85} />
      </span>
      <span
        style={{
          whiteSpace: 'nowrap',
          letterSpacing: 0,
        }}
      >
        {entry.label}
      </span>
    </button>
  );
}
