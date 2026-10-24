import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import {
  Blocks,
  BookOpenText,
  ChartColumnBig,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Network,
  Plus,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { PanelFrame } from '@zlens/ui';
import { useNotebook } from '../../store/NotebookStore';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile } from '../../store/types';
import {
  compareNotebookResearchSummaries,
  notebookResearchSummaryLabel,
  notebookResearchSummaryTitle,
  notebookResearchSummaryTone,
  type NotebookResearchSummaryTone,
  type NotebookResearchSummary,
  useNotebookResearchSummary,
} from '../notebook/useNotebookResearchSummary';
import {
  buildFileLibraryTree,
  fileLibraryFolder,
  type FileLibraryTreeNode,
} from './file-library-tree';

interface FilesPanelProps {
  onOpenFile: (file: NotebookFile) => void;
}

type FolderKey = 'notebooks' | 'blocks' | 'terms' | 'business-views' | 'dashboards';

const FOLDER_LABELS: Record<FolderKey, string> = {
  notebooks: 'Notebooks',
  blocks: 'Saved queries',
  terms: 'Business Terms',
  'business-views': 'Business Views',
  dashboards: 'Dashboards',
};

const FOLDER_DESCRIPTIONS: Partial<Record<FolderKey, string>> = {
  terms: 'Certified vocabulary linked to saved queries and business views.',
  'business-views': 'Business compositions built from saved queries, terms, and other views.',
};

// Dashboards section is hidden when empty — keeps the UI clean on projects
// that haven't authored a dashboard yet, without removing the artifact type.
const HIDE_WHEN_EMPTY: Record<FolderKey, boolean> = {
  notebooks: false,
  blocks: false,
  terms: true,
  'business-views': true,
  dashboards: true,
};

const FILE_ICON_META: Partial<Record<NotebookFile['type'], { Icon: LucideIcon; color: string }>> = {
  notebook: { Icon: BookOpenText, color: 'var(--color-accent-purple)' },
  workbook: { Icon: BookOpenText, color: 'var(--color-accent-purple)' },
  block: { Icon: Blocks, color: 'var(--color-accent-green)' },
  term: { Icon: FileText, color: 'var(--color-accent-cyan)' },
  business_view: { Icon: Workflow, color: 'var(--color-accent-yellow)' },
  dashboard: { Icon: ChartColumnBig, color: 'var(--color-accent-blue)' },
};

const FOLDER_ICON_COLORS: Record<FolderKey, string> = {
  notebooks: 'var(--color-accent-purple)',
  blocks: 'var(--color-accent-green)',
  terms: 'var(--color-accent-cyan)',
  'business-views': 'var(--color-accent-yellow)',
  dashboards: 'var(--color-accent-blue)',
};

function FileTypeIcon({
  type,
  active,
  hovered,
}: {
  type: NotebookFile['type'];
  active: boolean;
  hovered: boolean;
}) {
  const meta = FILE_ICON_META[type] ?? { Icon: FileText, color: 'var(--color-text-tertiary)' };
  const Icon = meta.Icon;
  return (
    <Icon
      size={15}
      strokeWidth={1.9}
      color={active || hovered ? meta.color : 'currentColor'}
      aria-hidden="true"
    />
  );
}

function FolderTypeIcon({
  folderKey,
  expanded,
  hovered,
}: {
  folderKey: FolderKey;
  expanded: boolean;
  hovered: boolean;
}) {
  const Icon = expanded ? FolderOpen : Folder;
  return (
    <Icon
      size={15}
      strokeWidth={1.9}
      color={expanded || hovered ? FOLDER_ICON_COLORS[folderKey] : 'currentColor'}
      aria-hidden="true"
    />
  );
}

function displayName(file: NotebookFile): string {
  return file.name.replace(/\.(dqlnb|dql)$/, '');
}

function lineageNodeIdForFile(file: NotebookFile): string {
  const name = displayName(file);
  switch (file.type) {
    case 'block':
      return `block:${name}`;
    case 'dashboard':
      return `dashboard:${name}`;
    case 'notebook':
    case 'workbook':
      return `notebook:${name}`;
    case 'term':
      return `term:${name}`;
    case 'business_view':
      return `business_view:${name}`;
    default:
      return name;
  }
}

export function FilesPanel({ onOpenFile }: FilesPanelProps) {
  const { state, dispatch } = useNotebook();
  const readOnly = hostReadOnly(useHostUi(), 'files');
  const t = themes[state.themeMode];

  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    notebooks: true,
    blocks: false,
    terms: true,
    'business-views': true,
    dashboards: false,
  });
  const fileSignature = state.files.map((file) => file.path).join('|');
  const { byPath: researchByNotebookPath } = useNotebookResearchSummary({ refreshKey: fileSignature });

  const grouped: Record<FolderKey, NotebookFile[]> = {
    notebooks: [],
    blocks: [],
    terms: [],
    'business-views': [],
    dashboards: [],
  };

  for (const f of state.files) {
    const key = fileLibraryFolder(f);
    if (key) grouped[key].push(f);
  }

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <PanelFrame
      title="Files"
      bodyPadding={0}
      actions={readOnly ? undefined : (
        <button
          type="button"
          onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
          title="Create notebook"
          aria-label="Create notebook"
          style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${t.accent}55`, background: 'var(--accent-dim)', color: t.accent, display: 'inline-grid', placeItems: 'center', cursor: 'pointer' }}
        >
          <BookOpenText size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    >

      {state.filesLoading && (
        <div style={{ padding: '8px 14px', color: t.textMuted, fontSize: 12, fontFamily: t.font }}>
          Loading files…
        </div>
      )}

      {/* Folder groups */}
      {(Object.keys(FOLDER_LABELS) as FolderKey[]).map((key) => {
        const files = grouped[key];
        if (HIDE_WHEN_EMPTY[key] && files.length === 0) return null;
        const expanded = expandedFolders[key];
        const onAdd = readOnly ? undefined : key === 'notebooks'
          ? () => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })
          : key === 'blocks'
            ? () => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })
            : undefined;

        return (
          <div key={key}>
            <FolderHeader
              label={FOLDER_LABELS[key]}
              count={files.length}
              folderKey={key}
              expanded={expanded}
              onToggle={() => toggleFolder(key)}
              onAdd={onAdd}
              t={t}
            />
            {expanded && (
              <div>
                {FOLDER_DESCRIPTIONS[key] && (
                  <div
                    style={{
                      padding: '0 14px 5px 32px',
                      color: t.textMuted,
                      fontSize: 11,
                      fontFamily: t.font,
                      lineHeight: 1.35,
                    }}
                  >
                    {FOLDER_DESCRIPTIONS[key]}
                  </div>
                )}
                {files.length === 0 ? (
                  <div
                    style={{
                      padding: '4px 14px 4px 32px',
                      fontSize: 12,
                      color: t.textMuted,
                      fontFamily: t.font,
                      fontStyle: 'italic',
                    }}
                  >
                    No {FOLDER_LABELS[key].toLowerCase()}
                  </div>
                ) : (
                  <FileLibraryTree
                    nodes={buildFileLibraryTree(sortFilesForFolder(files, key, researchByNotebookPath), key)}
                    activePath={state.activeFile?.path}
                    researchByNotebookPath={key === 'notebooks' ? researchByNotebookPath : new Map()}
                    onOpenFile={onOpenFile}
                    onShowLineage={(file) => {
                      const nodeId = lineageNodeIdForFile(file);
                      dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
                      dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
                    }}
                    t={t}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </PanelFrame>
  );
}

function FileLibraryTree({
  nodes,
  activePath,
  researchByNotebookPath,
  onOpenFile,
  onShowLineage,
  t,
  depth = 0,
}: {
  nodes: FileLibraryTreeNode[];
  activePath?: string;
  researchByNotebookPath: Map<string, NotebookResearchSummary>;
  onOpenFile: (file: NotebookFile) => void;
  onShowLineage: (file: NotebookFile) => void;
  t: Theme;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => node.kind === 'folder' ? (
        <NestedFolder
          key={`folder:${node.path}`}
          node={node}
          activePath={activePath}
          researchByNotebookPath={researchByNotebookPath}
          onOpenFile={onOpenFile}
          onShowLineage={onShowLineage}
          t={t}
          depth={depth}
        />
      ) : (
        <FileRow
          key={node.file.path}
          file={node.file}
          active={activePath === node.file.path}
          researchSummary={researchByNotebookPath.get(node.file.path)}
          onClick={() => onOpenFile(node.file)}
          onShowLineage={() => onShowLineage(node.file)}
          depth={depth}
          t={t}
        />
      ))}
    </>
  );
}

function NestedFolder({
  node,
  activePath,
  researchByNotebookPath,
  onOpenFile,
  onShowLineage,
  t,
  depth,
}: {
  node: Extract<FileLibraryTreeNode, { kind: 'folder' }>;
  activePath?: string;
  researchByNotebookPath: Map<string, NotebookResearchSummary>;
  onOpenFile: (file: NotebookFile) => void;
  onShowLineage: (file: NotebookFile) => void;
  t: Theme;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: `4px 8px 4px ${24 + depth * 14}px`,
          border: 0,
          background: 'transparent',
          color: t.textMuted,
          cursor: 'pointer',
          fontFamily: t.font,
          fontSize: 11,
          textAlign: 'left',
        }}
      >
        <ChevronRight size={11} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
        {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      </button>
      {expanded ? (
        <FileLibraryTree
          nodes={node.children}
          activePath={activePath}
          researchByNotebookPath={researchByNotebookPath}
          onOpenFile={onOpenFile}
          onShowLineage={onShowLineage}
          t={t}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}

function sortFilesForFolder(
  files: NotebookFile[],
  folderKey: FolderKey,
  researchByNotebookPath: Map<string, NotebookResearchSummary>,
): NotebookFile[] {
  return [...files].sort((a, b) => {
    if (folderKey === 'notebooks') {
      const aSummary = researchByNotebookPath.get(a.path);
      const bSummary = researchByNotebookPath.get(b.path);
      if (aSummary && bSummary) {
        const researchOrder = compareNotebookResearchSummaries(aSummary, bSummary);
        if (researchOrder !== 0) return researchOrder;
      }
      if (aSummary) return -1;
      if (bSummary) return 1;
    }
    return displayName(a).localeCompare(displayName(b));
  });
}

function FolderHeader({
  label,
  count,
  folderKey,
  expanded,
  onToggle,
  onAdd,
  t,
}: {
  label: string;
  count: number;
  folderKey: FolderKey;
  expanded: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const [addHover, setAddHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        background: hovered ? t.sidebarItemHover : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 0 3px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textSecondary,
          fontSize: 11,
          fontWeight: 600,
          fontFamily: t.font,
          letterSpacing: 0,
          textTransform: 'uppercase' as const,
          textAlign: 'left' as const,
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: expanded || hovered ? FOLDER_ICON_COLORS[folderKey] : t.textMuted,
            transition: 'color 0.12s',
            flexShrink: 0,
          }}
        >
          <FolderTypeIcon folderKey={folderKey} expanded={expanded} hovered={hovered} />
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        {count > 0 && (
          <span
            style={{
              background: t.pillBg,
              color: t.textMuted,
              borderRadius: 10,
              padding: '0 5px',
              fontSize: 10,
              fontWeight: 500,
            }}
          >
            {count}
          </span>
        )}
      </button>
      {onAdd && hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          title={`New ${label.slice(0, -1)}`}
          style={{
            background: addHover ? t.btnHover : 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            color: addHover ? t.accent : t.textMuted,
            fontSize: 14,
            lineHeight: 1,
            padding: '2px 8px',
            marginRight: 4,
            flexShrink: 0,
            transition: 'color 0.1s',
          }}
        >
          <Plus size={14} strokeWidth={2.1} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function FileRow({
  file,
  active,
  onClick,
  onShowLineage,
  researchSummary,
  depth = 0,
  t,
}: {
  file: NotebookFile;
  active: boolean;
  onClick: () => void;
  onShowLineage?: () => void;
  researchSummary?: NotebookResearchSummary;
  depth?: number;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const [lineageHover, setLineageHover] = useState(false);
  // Lineage button only makes sense for artifacts the lineage graph indexes.
  const lineageEligible = file.type === 'notebook' || file.type === 'block' || file.type === 'dashboard' || file.type === 'term' || file.type === 'business_view';
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        background: active ? t.sidebarItemActive : hovered ? t.sidebarItemHover : 'transparent',
        borderLeft: active ? `2px solid ${t.accent}` : '2px solid transparent',
        transition: 'background 0.1s',
      }}
    >
      <button
        onClick={onClick}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `4px 8px 4px ${24 + depth * 14}px`,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: active ? t.textPrimary : hovered ? t.textPrimary : t.textSecondary,
          fontSize: 13,
          fontFamily: t.font,
          textAlign: 'left' as const,
          transition: 'color 0.1s',
          overflow: 'hidden',
          paddingRight: hovered && lineageEligible ? 34 : 8,
        }}
      >
        <span
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            color: active ? t.accent : t.textMuted,
            transition: 'color 0.12s',
          }}
        >
          <FileTypeIcon type={file.type} active={active} hovered={hovered} />
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {displayName(file)}
        </span>
        {file.isNew && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: t.accent,
              background: t.sidebarItemActive,
              borderRadius: 4,
              padding: '1px 4px',
              flexShrink: 0,
            }}
          >
            NEW
          </span>
        )}
        {researchSummary && researchSummary.total > 0 && (
          <ResearchBadge summary={researchSummary} t={t} />
        )}
      </button>
      {hovered && lineageEligible && onShowLineage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShowLineage();
          }}
          onMouseEnter={() => setLineageHover(true)}
          onMouseLeave={() => setLineageHover(false)}
          aria-label={`Show lineage for ${displayName(file)}`}
          title="Show lineage"
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: lineageHover ? t.btnHover : 'transparent',
            border: 'none',
            borderRadius: 4,
            color: lineageHover ? t.accent : t.textMuted,
            cursor: 'pointer',
          }}
        >
          <Network size={14} strokeWidth={1.9} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ResearchBadge({ summary, t }: { summary: NotebookResearchSummary; t: Theme }) {
  const color = researchToneColor(notebookResearchSummaryTone(summary), t);
  return (
    <span
      title={notebookResearchSummaryTitle(summary)}
      style={{
        minWidth: 0,
        maxWidth: 122,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        borderRadius: 999,
        border: `1px solid ${color}44`,
        background: `${color}12`,
        color,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 800,
        lineHeight: '16px',
      }}
    >
      {notebookResearchSummaryLabel(summary, { includeCount: true })}
    </span>
  );
}

function researchToneColor(tone: NotebookResearchSummaryTone, t: Theme): string {
  switch (tone) {
    case 'error':
      return t.error;
    case 'warning':
      return t.warning;
    case 'success':
      return t.success;
    case 'accent':
      return t.accent;
    case 'neutral':
    default:
      return t.textMuted;
  }
}
