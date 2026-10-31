import React, { useEffect, useMemo, useState } from 'react';
import { Blocks, Box, ChevronDown, ChevronRight, Database, FileText, Folder, FolderOpen, Layers, NotebookPen, Plus, Search, Trash2, Upload } from 'lucide-react';
import { api, DqlApiError } from '../../api/client';
import { hostProposesCertification, hostReadOnly, useHostUi } from '../../host/host-ui';
import { insertSemanticReference } from '../../editor/semantic-completions';
import { controlStyle } from '../../themes/control-tokens';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type { ExecutionTarget, NotebookFile } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import type { BlockEntry } from '../blocks/block-types';
import { BlockStatusBadge, blockDisplayStatus } from '../blocks/BlockStatusBadge';
import { SemanticTreeView } from './CatalogTree';
import { blockDomains, filterBlocksForDomain } from './block-domain-filter';
import { buildNotebookSemanticBlock } from './semantic-notebook-source';
import { blockFolderLabel, buildBlockLibraryTree, type BlockLibraryTreeNode } from './block-library-tree';
import { buildFileLibraryTree, type FileLibraryTreeNode } from './file-library-tree';
import { DomainScopeSelect } from './DomainScopeSelect';
import { filterNotebookFiles, notebookDomains } from './notebook-sidebar';
import { authoredDomainOptions } from '../domains/authored-domain-options';
import { DbtDatabaseList } from './DbtDatabaseList';
import {
  buildSemanticTreeFromLayer,
  scopeSemanticTreeForComposition,
  type SemanticCompositionScopeState,
} from '../../utils/semantic-tree';

export type BuildTab = 'notebooks' | 'semantic' | 'database' | 'blocks';

const TABS: { id: BuildTab; label: string; icon: React.ComponentType<any> }[] = [
  { id: 'notebooks', label: 'Notebooks', icon: FileText },
  { id: 'semantic', label: 'Semantic', icon: Layers },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'blocks', label: 'Saved queries', icon: Blocks },
];

// Paper-handoff status dots: certified green · draft amber · review blue.
const STATUS_COLOR: Record<string, string> = {
  certified: 'var(--status-success)', published: 'var(--status-success)', deprecated: 'var(--status-error)',
  draft: 'var(--status-warning)', pending: 'var(--status-warning)', review: '#4a74c9', in_review: '#4a74c9', proposed: '#4a74c9',
};

/**
 * Unified, database-studio-style sidebar for the Build section. Four clean tabs —
 * Notebooks (list + new), Semantic (metrics/dimensions), Database (tables/columns),
 * Blocks — with no studio/setup chrome. Click a notebook to open it; click a
 * metric/dimension/table/column to insert it into the active editor (or a new SQL
 * cell); click a block to open it in the builder.
 */
export function BuildSidebar({ defaultTab, onOpenFile, tabs, onInsertText, onSemanticCompose, blockDomain = '', onBlockDomainChange, onNewBlock, onOpenBlock, onDeleteBlock, blockLibraryRefreshKey = 0, footer, footerStatus = 'ready', onCollapse }: {
  defaultTab?: BuildTab;
  onOpenFile?: (file: NotebookFile) => void;
  /** Which tabs to show (default all four). Block Studio omits 'notebooks'. */
  tabs?: BuildTab[];
  /** Override the insert action (e.g. Block Studio appends to the block draft). */
  onInsertText?: (text: string) => void;
  /** Apply one governed metric/dimension selection to a Block Studio draft. */
  onSemanticCompose?: (metrics: string[], dimensions: string[]) => void;
  /** Domain scope for the Blocks tab. An empty value shows all domains. */
  blockDomain?: string;
  onBlockDomainChange?: (domain: string) => void;
  /** Shows a "+" new-block button beside the search input (Block Studio). */
  onNewBlock?: () => void;
  /** Lets a hosting authoring surface guard dirty work before opening a block. */
  onOpenBlock?: (block: BlockEntry) => void;
  /** Requests the guarded delete flow for one exact saved block. */
  onDeleteBlock?: (block: BlockEntry) => void;
  /** Explicit refresh signal after a save, move, or delete changes disk layout. */
  blockLibraryRefreshKey?: number;
  /** Optional status footer line (e.g. "dbt synced · 42 models · 5 metrics"). */
  footer?: React.ReactNode;
  footerStatus?: 'ready' | 'loading' | 'warning';
  /** Renders a collapse chevron at the end of the tab bar. */
  onCollapse?: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const readOnlyFiles = hostReadOnly(useHostUi(), 'files');
  const t = themes[state.themeMode];
  // Respect the host's tab order (the prototype puts Blocks first in Block Studio).
  const visibleTabs = tabs
    ? tabs.map((id) => TABS.find((x) => x.id === id)).filter((x): x is typeof TABS[number] => Boolean(x))
    : TABS;
  const [tab, setTab] = useState<BuildTab>(defaultTab ?? visibleTabs[0]?.id ?? 'notebooks');
  const [search, setSearch] = useState('');
  const [notebookDomain, setNotebookDomain] = useState('');

  useEffect(() => { if (defaultTab) setTab(defaultTab); }, [defaultTab]);

  // Host-provided insert wins; otherwise insert into the focused editor, else a new SQL cell.
  const insertText = onInsertText ?? ((text: string) => {
    if (!insertSemanticReference(text)) {
      dispatch({ type: 'ADD_CELL', cell: makeCell('sql', text) });
    }
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: t.cellBg, fontFamily: t.font }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '6px 6px 0', borderBottom: `1px solid ${t.headerBorder}` }}>
        {visibleTabs.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              title={label}
              style={{
                flex: visibleTabs.length > 3 ? '1 1 auto' : 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
                background: 'transparent', color: active ? t.accent : t.textMuted, cursor: 'pointer',
                fontSize: 11, fontWeight: 700, padding: '6px 3px 7px',
              }}
            >
              <Icon size={13} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            </button>
          );
        })}
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse explorer"
            style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 13, padding: '0 6px', flexShrink: 0 }}
          >
            ‹
          </button>
        ) : null}
      </div>

      {/* Compact tab toolbar. Notebook creation lives beside notebook search
          instead of occupying a full-width content row. */}
      {tab === 'notebooks' ? (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, display: 'flex', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: t.textMuted }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notebooks…"
              aria-label="Search notebooks"
              style={{
                width: '100%', boxSizing: 'border-box', background: t.inputBg, border: `1px solid ${t.inputBorder}`,
                borderRadius: 6, color: t.textPrimary, fontSize: 12, fontFamily: t.font, padding: '6px 8px 6px 26px', outline: 'none',
              }}
            />
          </div>
          {!readOnlyFiles && <button
            type="button"
            onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
            title="Create notebook"
            aria-label="Create notebook"
            style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 7, border: `1px solid ${t.accent}55`, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <NotebookPen size={14} strokeWidth={2} aria-hidden="true" />
          </button>}
        </div>
      ) : (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, display: 'flex', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: t.textMuted }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}…`}
              style={{
                width: '100%', boxSizing: 'border-box', background: t.inputBg, border: `1px solid ${t.inputBorder}`,
                borderRadius: 6, color: t.textPrimary, fontSize: 12, fontFamily: t.font, padding: '6px 8px 6px 26px', outline: 'none',
              }}
            />
          </div>
          {onNewBlock ? (
            <button
              type="button"
              onClick={onNewBlock}
              title="New saved query"
              style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'notebooks' && onOpenFile && (
          <NotebooksList
            t={t}
            onOpenFile={onOpenFile}
            search={search}
            domain={notebookDomain}
            onDomainChange={setNotebookDomain}
          />
        )}
        {tab === 'semantic' && <SemanticList t={t} search={search} onInsert={insertText} notebookMode={!onInsertText || Boolean(onSemanticCompose)} onSemanticCompose={onSemanticCompose} />}
        {tab === 'database' && <DbtDatabaseList t={t} search={search} onInsert={insertText} />}
        {tab === 'blocks' && <BlocksList t={t} search={search} domain={blockDomain} onDomainChange={onBlockDomainChange} onOpenBlock={onOpenBlock} onDeleteBlock={onDeleteBlock} refreshKey={blockLibraryRefreshKey} />}
      </div>

      {footer ? (
        <div style={{ padding: '9px 12px', borderTop: `1px solid ${t.headerBorder}`, fontSize: 10.5, color: t.textMuted, display: 'flex', alignItems: 'center', gap: 6, fontFamily: t.font }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: footerStatus === 'ready' ? 'var(--status-success)' : 'var(--status-warning)', flexShrink: 0 }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{footer}</span>
        </div>
      ) : null}
    </div>
  );
}

const rowStyle = (t: Theme, active = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0, boxSizing: 'border-box',
  padding: '6px 10px', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
  background: active ? `${t.accent}14` : 'transparent', cursor: 'pointer', textAlign: 'left',
  fontFamily: t.font, color: t.textPrimary,
});

function EmptyNote({ text, t }: { text: string; t: Theme }) {
  return <div style={{ padding: '16px 12px', fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{text}</div>;
}

function NotebooksList({ t, onOpenFile, search, domain, onDomainChange }: {
  t: Theme;
  onOpenFile: (file: NotebookFile) => void;
  search: string;
  domain: string;
  onDomainChange: (domain: string) => void;
}) {
  const { state, dispatch } = useNotebook();
  const readOnlyFiles = hostReadOnly(useHostUi(), 'files');
  const [pendingDelete, setPendingDelete] = useState<NotebookFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const domains = notebookDomains(state.files, state.authoredDomains);
  const selectedDomain = domains.includes(domain) ? domain : '';
  const authoredOptions = authoredDomainOptions(state.authoredDomains);
  const domainOptions = [
    ...authoredOptions.filter((option) => domains.includes(option.value)),
    ...(domains.includes('uncategorized') ? [{ value: 'uncategorized', label: 'Unassigned' }] : []),
  ];
  const allNotebooks = filterNotebookFiles(state.files, '', selectedDomain, state.authoredDomains);
  const notebooks = filterNotebookFiles(state.files, search, selectedDomain, state.authoredDomains);
  const notebookTree = buildFileLibraryTree(notebooks, 'notebooks');
  const scopeLabel = selectedDomain === 'uncategorized' ? 'unassigned' : selectedDomain || 'all domains';

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.deleteNotebook(pendingDelete.path);
      if (!result.ok) {
        setDeleteError(result.error ?? 'Could not delete this notebook.');
        return;
      }
      dispatch({ type: 'FILE_REMOVED', path: pendingDelete.path });
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  // Publishing moves the file, so the open editor has to follow it: saving
  // against the old draft path would quietly recreate the private copy.
  const publish = async (file: NotebookFile) => {
    setPublishing(file.path);
    setPublishError(null);
    try {
      const result = await api.publishNotebook(file.path);
      if (!result.ok || !result.path) {
        setPublishError(result.error ?? 'Could not publish this notebook.');
        return;
      }
      const published: NotebookFile = { ...file, path: result.path, folder: 'notebooks', visibility: 'shared' };
      dispatch({ type: 'FILE_REMOVED', path: file.path });
      dispatch({ type: 'FILE_ADDED', file: published });
      if (state.activeFile?.path === file.path) onOpenFile(published);
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error));
    } finally {
      setPublishing(null);
    }
  };
  return (
    <div>
      <DomainScopeSelect
        id="notebook-domain-filter"
        ariaLabel="Notebook domain"
        value={selectedDomain}
        options={domainOptions}
        onChange={onDomainChange}
        summary={<>{notebooks.length} notebook{notebooks.length === 1 ? '' : 's'} · {scopeLabel}</>}
        t={t}
      />
      {notebooks.length === 0 ? (
        <EmptyNote
          text={allNotebooks.length === 0
            ? (selectedDomain ? `No notebooks are related to ${scopeLabel} yet.` : 'No notebooks yet. Use the notebook icon above to create one.')
            : `No ${scopeLabel} notebooks match “${search.trim()}”.`}
          t={t}
        />
      ) : (
        <NotebookLibraryTree
          nodes={notebookTree}
          activePath={state.activeFile?.path}
          onOpenFile={onOpenFile}
          onDelete={readOnlyFiles ? undefined : (file) => { setDeleteError(null); setPendingDelete(file); }}
          onPublish={readOnlyFiles ? undefined : (file) => void publish(file)}
          publishingPath={publishing}
          t={t}
        />
      )}
      {publishError ? (
        <div style={{ padding: '8px 12px', fontSize: 11.5, color: t.error, fontFamily: t.font }}>{publishError}</div>
      ) : null}
      {/* Reveal the destructive action on hover only, and colour it red on
          approach — the row's primary action is opening the notebook. */}
      <style>{`
        .dql-nb-delete { opacity: 0; transition: opacity .12s, color .12s, background .12s, border-color .12s; }
        .dql-nb-row:hover .dql-nb-delete { opacity: 1; }
        .dql-nb-delete:hover { color: ${t.error} !important; background: ${t.error}12 !important; border-color: ${t.error}44 !important; }
        .dql-nb-delete:focus-visible { opacity: 1; }
        .dql-nb-publish { opacity: 0; transition: opacity .12s, color .12s, background .12s, border-color .12s; }
        .dql-nb-row:hover .dql-nb-publish { opacity: 1; }
        .dql-nb-publish:hover { color: ${t.accent} !important; background: var(--accent-dim) !important; border-color: ${t.accent}44 !important; }
        .dql-nb-publish:focus-visible { opacity: 1; }
      `}</style>
      {pendingDelete ? (
        <DeleteNotebookDialog
          file={pendingDelete}
          t={t}
          busy={deleting}
          error={deleteError}
          onCancel={() => { setPendingDelete(null); setDeleteError(null); }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

function NotebookLibraryTree({
  nodes,
  activePath,
  onOpenFile,
  onDelete,
  onPublish,
  publishingPath,
  t,
  depth = 0,
}: {
  nodes: FileLibraryTreeNode[];
  activePath?: string;
  onOpenFile: (file: NotebookFile) => void;
  onDelete?: (file: NotebookFile) => void;
  onPublish?: (file: NotebookFile) => void;
  publishingPath: string | null;
  t: Theme;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => node.kind === 'folder' ? (
        <NotebookFolder
          key={`notebook-folder:${node.path}`}
          node={node}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onDelete={onDelete}
          onPublish={onPublish}
          publishingPath={publishingPath}
          t={t}
          depth={depth}
        />
      ) : (
        <NotebookFileRow
          key={node.file.path}
          file={node.file}
          active={activePath === node.file.path}
          onOpenFile={onOpenFile}
          onDelete={onDelete}
          onPublish={onPublish}
          publishing={publishingPath === node.file.path}
          t={t}
          depth={depth}
        />
      ))}
    </>
  );
}

function NotebookFolder({
  node,
  activePath,
  onOpenFile,
  onDelete,
  onPublish,
  publishingPath,
  t,
  depth,
}: {
  node: Extract<FileLibraryTreeNode, { kind: 'folder' }>;
  activePath?: string;
  onOpenFile: (file: NotebookFile) => void;
  onDelete?: (file: NotebookFile) => void;
  onPublish?: (file: NotebookFile) => void;
  publishingPath: string | null;
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
        title={node.path}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          boxSizing: 'border-box',
          padding: `5px 8px 5px ${10 + depth * 14}px`,
          border: 'none',
          borderBottom: `1px solid ${t.cellBorder}`,
          background: 'transparent',
          color: t.textMuted,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: t.font,
          fontSize: 11,
          fontWeight: depth === 0 ? 700 : 600,
        }}
      >
        <ChevronRight size={11} style={{ transform: expanded ? 'rotate(90deg)' : undefined, flexShrink: 0 }} />
        {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      </button>
      {expanded ? (
        <NotebookLibraryTree
          nodes={node.children}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onDelete={onDelete}
          onPublish={onPublish}
          publishingPath={publishingPath}
          t={t}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}

export function NotebookFileRow({
  file,
  active,
  onOpenFile,
  onDelete,
  onPublish,
  publishing,
  t,
  depth,
}: {
  file: NotebookFile;
  active: boolean;
  onOpenFile: (file: NotebookFile) => void;
  onDelete?: (file: NotebookFile) => void;
  onPublish?: (file: NotebookFile) => void;
  publishing: boolean;
  t: Theme;
  depth: number;
}) {
  const isPrivate = file.visibility === 'private';
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }} className="dql-nb-row">
      <button
        type="button"
        onClick={() => onOpenFile(file)}
        style={{ ...rowStyle(t, active), paddingLeft: 10 + depth * 14, paddingRight: (isPrivate && onPublish ? 24 : 0) + (onDelete ? 30 : 8) }}
        title={`${file.path}${file.ownerDomain ? ` · Owner domain: ${file.ownerDomain}` : ''}${isPrivate ? ' · Private: not in Git until you publish it' : ''}`}
      >
        <FileText size={13} color={t.textMuted} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
          {file.name.replace(/\.dqln?$|\.ipynb$/i, '')}
        </span>
        {isPrivate ? (
          <span
            style={{
              flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
              padding: '1px 5px', borderRadius: 4, color: t.textMuted,
              border: `1px solid ${t.cellBorder}`, background: t.btnBg,
            }}
          >
            Private
          </span>
        ) : null}
      </button>
      {isPrivate && onPublish ? (
        <button
          type="button"
          className="dql-nb-publish"
          onClick={(event) => { event.stopPropagation(); onPublish(file); }}
          disabled={publishing}
          title={`Publish ${file.name} to notebooks/ so the team can see it`}
          aria-label={`Publish ${file.name}`}
          style={{
            position: 'absolute', right: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 5, border: '1px solid transparent',
            background: 'transparent', color: t.textMuted, cursor: publishing ? 'wait' : 'pointer', padding: 0,
          }}
        >
          <Upload size={12} />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="dql-nb-delete"
          onClick={(event) => { event.stopPropagation(); onDelete(file); }}
          title={`Delete ${file.name}`}
          aria-label={`Delete ${file.name}`}
          style={{
            position: 'absolute', right: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 5, border: '1px solid transparent',
            background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: 0,
          }}
        >
          <Trash2 size={12} />
        </button>
      ) : null}
    </div>
  );
}

/** Deleting takes the notebook off the file list, so it asks first. */
function DeleteNotebookDialog({
  file, t, busy, error, onCancel, onConfirm,
}: {
  file: NotebookFile;
  t: Theme;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${file.name}`}
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.34)', display: 'grid', placeItems: 'center' }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(420px, calc(100vw - 40px))', background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 12, padding: 18, display: 'grid', gap: 10, boxShadow: '0 18px 60px rgba(15,23,42,0.22)' }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Delete this notebook?</div>
        <div style={{ fontSize: 12.5, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.5 }}>
          <code style={{ fontFamily: t.fontMono, fontSize: 12 }}>{file.path}</code> moves to a recovery bundle under <code style={{ fontFamily: t.fontMono, fontSize: 12 }}>.dql/local/trash/</code>, so it can be fetched back. Saved queries and metrics it referenced are not affected.
        </div>
        {error ? <div style={{ fontSize: 12, color: t.error, fontFamily: t.font }}>{error}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={controlStyle(t, { variant: 'secondary', size: 'md', disabled: busy })}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} style={controlStyle(t, { variant: 'danger', size: 'md', disabled: busy })}>
            {busy ? 'Deleting…' : 'Delete notebook'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SemanticList({ t, search, onInsert, notebookMode, onSemanticCompose }: { t: Theme; search: string; onInsert: (text: string) => void; notebookMode: boolean; onSemanticCompose?: (metrics: string[], dimensions: string[]) => void }) {
  const { state, dispatch } = useNotebook();
  const tree = useMemo(() => buildSemanticTreeFromLayer(state.semanticLayer), [
    state.semanticLayer.provider,
    state.semanticLayer.metrics,
    state.semanticLayer.measures,
    state.semanticLayer.dimensions,
    state.semanticLayer.timeDimensions,
    state.semanticLayer.entities,
    state.semanticLayer.hierarchies,
    state.semanticLayer.semanticModels,
    state.semanticLayer.savedQueries,
  ]);
  const loading = state.semanticLayer.loading;
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [selectedDimensions, setSelectedDimensions] = useState<Set<string>>(new Set());
  const [compatibleDimensions, setCompatibleDimensions] = useState<Set<string> | null>(null);
  const [compatibilityState, setCompatibilityState] = useState<SemanticCompositionScopeState>('idle');
  const [compatibilityEngine, setCompatibilityEngine] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{
    sql: string;
    rows: number;
    executionTarget?: ExecutionTarget;
    engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget | undefined>();
  const metricsByName = new Map(state.semanticLayer.metrics.map((metric) => [metric.name, metric]));
  const openSemanticRuntimeSettings = () => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
  };

  useEffect(() => {
    let active = true;
    void api.getConnections().then((connections) => {
      if (!active) return;
      setExecutionTarget(connections.default
        ? { target: 'connection', connectionName: connections.default }
        : undefined);
    }).catch(() => {
      if (active) setExecutionTarget(undefined);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    if (selectedMetrics.size === 0) {
      setCompatibleDimensions(null);
      setCompatibilityState('idle');
      setCompatibilityEngine(null);
      setSelectedDimensions(new Set());
      return;
    }
    setCompatibleDimensions(null);
    setCompatibilityState('loading');
    setCompatibilityEngine(null);
    void api.getCompatibility(Array.from(selectedMetrics)).then((compatibility) => {
      if (!active) return;
      const names = new Set(compatibility.dimensions.map((dimension) => dimension.reference ?? dimension.name));
      setCompatibleDimensions(names);
      setCompatibilityState('ready');
      setCompatibilityEngine(compatibility.engine);
      setSelectedDimensions((current) => new Set(Array.from(current).filter((name) => names.has(name))));
    }).catch((compatibilityError) => {
      if (!active) return;
      setCompatibleDimensions(new Set());
      setCompatibilityState('error');
      setCompatibilityEngine(null);
      setSelectedDimensions(new Set());
      setError(compatibilityError instanceof DqlApiError
        ? `${compatibilityError.code ? `${compatibilityError.code}: ` : ''}${compatibilityError.message}`
        : compatibilityError instanceof Error
          ? compatibilityError.message
          : 'Semantic compatibility could not be verified.');
    });
    return () => { active = false; };
  }, [Array.from(selectedMetrics).sort().join('|')]);

  const visibleTree = useMemo(() => {
    if (!tree || !notebookMode) return tree;
    return scopeSemanticTreeForComposition(
      tree,
      selectedMetrics.size,
      compatibleDimensions,
      compatibilityState,
    );
  }, [tree, notebookMode, selectedMetrics.size, compatibleDimensions, compatibilityState]);

  const toggleSelection = (kind: 'metric' | 'dimension', name: string) => {
    setPreview(null);
    setError(null);
    const update = kind === 'metric' ? setSelectedMetrics : setSelectedDimensions;
    update((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const canSelect = (kind: 'metric' | 'dimension', name: string): { allowed: boolean; reason?: string } => {
    if (kind === 'metric') {
      const capability = metricsByName.get(name)?.execution;
      return capability && capability.status !== 'ready'
        ? { allowed: false, reason: capability.reason || 'This metric requires semantic runtime setup.' }
        : { allowed: true };
    }
    if (selectedMetrics.size === 0) return { allowed: false, reason: 'Select a metric first.' };
    if (!compatibleDimensions) return { allowed: false, reason: 'Checking compatibility…' };
    return compatibleDimensions.has(name)
      ? { allowed: true }
      : { allowed: false, reason: 'This dimension has no governed join path to every selected metric.' };
  };

  const selectedKeys = new Set([
    ...Array.from(selectedMetrics).map((name) => `metric:${name}`),
    ...Array.from(selectedDimensions).map((name) => `dimension:${name}`),
  ]);
  const canAddSemanticCell = selectedMetrics.size > 0
    && compatibilityState === 'ready'
    && !previewing;

  const runPreview = async () => {
    if (selectedMetrics.size === 0) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.previewSemanticBuilder({
        metrics: Array.from(selectedMetrics),
        dimensions: Array.from(selectedDimensions),
        executionTarget,
        limit: 50,
      });
      if ('error' in result) {
        setPreview(null);
        setError(result.error);
        return;
      }
      setPreview({
        sql: result.sql,
        rows: result.result.rowCount ?? result.result.rows.length,
        executionTarget,
        engine: result.engine,
      });
    } catch (previewError) {
      setPreview(null);
      setError(previewError instanceof DqlApiError
        ? `${previewError.code ? `${previewError.code}: ` : ''}${previewError.message}`
        : previewError instanceof Error
          ? previewError.message
          : 'The governed semantic preview could not run.');
    } finally {
      setPreviewing(false);
    }
  };

  const addSemanticCell = () => {
    if (!canAddSemanticCell) return;
    const metrics = Array.from(selectedMetrics);
    const dimensions = Array.from(selectedDimensions);
    if (onSemanticCompose) {
      onSemanticCompose(metrics, dimensions);
      setSelectedMetrics(new Set());
      setSelectedDimensions(new Set());
      setPreview(null);
      setError(null);
      return;
    }
    const source = buildNotebookSemanticBlock(metrics, dimensions);
    const cell = makeCell('dql', source);
    cell.executionTarget = preview?.executionTarget ?? executionTarget;
    cell.dqlArtifact = {
      source,
      kind: 'semantic_block',
      metrics,
      dimensions,
      persistence: 'transient',
      trustState: 'governed',
      reviewState: 'draft',
      routeEvidence: [{
        route: 'semantic',
        authoringState: preview ? 'previewed' : 'selected',
        compatibilityState,
        ...(compatibilityEngine ? { compatibilityEngine } : {}),
        ...(preview ? {
          engine: preview.engine,
          executionTarget: preview.executionTarget,
          previewRows: preview.rows,
        } : {}),
      }],
      ...(preview ? { sql: preview.sql, compiledSql: preview.sql } : {}),
    };
    dispatch({ type: 'ADD_CELL', cell });
    setSelectedMetrics(new Set());
    setSelectedDimensions(new Set());
    setPreview(null);
    setError(null);
  };

  if (loading && !tree) return <EmptyNote text="Loading semantic layer…" t={t} />;
  if (!tree || !visibleTree || (tree.children?.length ?? 0) === 0) return <EmptyNote text="No semantic layer imported yet." t={t} />;
  return <div>
    {notebookMode && (
      <div style={{ display: 'grid', gap: 7, padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: 'var(--bg-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 10.5, color: t.textMuted }}>
            {selectedMetrics.size === 0
              ? 'Choose a business metric. Related dimensions appear next.'
              : compatibilityState === 'loading'
                ? 'Checking governed dimensions…'
                : compatibilityState === 'ready'
                  ? `${selectedMetrics.size > 1 ? 'Common governed dimensions' : 'Governed dimensions'} · ${compatibleDimensions?.size ?? 0} available${compatibilityEngine ? ` · ${compatibilityEngine}` : ''}`
                  : `${selectedMetrics.size} metric${selectedMetrics.size === 1 ? '' : 's'} selected`}
          </span>
          <button type="button" onClick={() => void runPreview()} disabled={previewing || selectedMetrics.size === 0} style={{ border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, borderRadius: 5, padding: '4px 7px', fontSize: 10, cursor: selectedMetrics.size ? 'pointer' : 'not-allowed', opacity: selectedMetrics.size ? 1 : .5 }}>
            {previewing ? 'Running…' : 'Preview & run'}
          </button>
          <button type="button" onClick={addSemanticCell} disabled={!canAddSemanticCell} title={canAddSemanticCell ? (onSemanticCompose ? 'Apply this governed selection to the saved query visual builder' : preview ? 'Add the previewed semantic query to the notebook' : 'Add the governed semantic selection now; preview is optional') : 'Select an executable metric and wait for governed compatibility'} style={{ border: 'none', background: t.accent, color: '#fff', borderRadius: 5, padding: '5px 7px', fontSize: 10, fontWeight: 700, cursor: canAddSemanticCell ? 'pointer' : 'not-allowed', opacity: canAddSemanticCell ? 1 : .5 }}>
            {onSemanticCompose ? 'Apply to saved query' : 'Add to cell'}
          </button>
        </div>
        {preview && (
          <div style={{ display: 'grid', gap: 4, padding: '6px 7px', borderRadius: 6, border: '1px solid var(--status-success)', background: 'var(--status-success-bg)', color: t.textSecondary, fontSize: 10 }}>
            <span>Preview succeeded · {preview.rows} row{preview.rows === 1 ? '' : 's'}</span>
            <code style={{ display: 'block', maxHeight: 48, overflow: 'hidden', whiteSpace: 'pre-wrap', fontSize: 9, color: t.textMuted }}>{preview.sql}</code>
          </div>
        )}
        {error && <div role="alert" style={{ display: 'flex', gap: 7, alignItems: 'center', padding: '6px 7px', borderRadius: 6, border: `1px solid ${t.error}40`, background: `${t.error}10`, color: t.error, fontSize: 10, lineHeight: 1.35 }}><span style={{ flex: 1 }}>{error}</span>{/semantic runtime|MetricFlow/i.test(error) ? <button type="button" onClick={openSemanticRuntimeSettings} style={{ border: 'none', background: 'transparent', color: t.accent, fontSize: 9.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set up →</button> : null}</div>}
        {state.semanticLayer.metrics.some((metric) => metric.execution && metric.execution.status !== 'ready') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 9.5, color: t.textMuted }}><span style={{ flex: 1 }}>Complex metrics are imported but need a full semantic runtime to execute.</span><button type="button" onClick={openSemanticRuntimeSettings} style={{ border: 'none', background: 'transparent', color: t.accent, fontSize: 9.5, fontWeight: 700, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}>Set up runtime →</button></div>
        )}
      </div>
    )}
    <SemanticTreeView
      tree={visibleTree}
      themeMode={state.themeMode}
      search={search}
      onInsert={onInsert}
      selectionMode={notebookMode}
      selected={selectedKeys}
      onToggleSelection={toggleSelection}
      canSelect={canSelect}
    />
  </div>;
}

function BlocksList({ t, search, domain, onDomainChange, onOpenBlock, onDeleteBlock, refreshKey }: { t: Theme; search: string; domain: string; onDomainChange?: (domain: string) => void; onOpenBlock?: (block: BlockEntry) => void; onDeleteBlock?: (block: BlockEntry) => void; refreshKey: number }) {
  const hostProposes = hostProposesCertification(useHostUi());
  const { state, dispatch } = useNotebook();
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const blockFileKey = state.files.filter((f) => f.type === 'block').map((f) => f.path).sort().join('|');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getBlockLibrary()
      .then((r) => {
        if (!active) return;
        // A failed refresh keeps the list already shown instead of emptying it.
        if (r.error) setLoadError(r.error);
        else { setBlocks(r.blocks); setLoadError(null); }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [blockFileKey, refreshKey, retryKey]);

  const domains = blockDomains(blocks, state.authoredDomains);
  const selectedDomain = domains.includes(domain) ? domain : '';
  const authoredOptions = authoredDomainOptions(state.authoredDomains);
  const domainOptions = [
    ...authoredOptions.filter((option) => domains.includes(option.value)),
    ...(domains.includes('uncategorized') ? [{ value: 'uncategorized', label: 'Unassigned' }] : []),
  ];
  const filtered = filterBlocksForDomain(blocks, selectedDomain, search, state.authoredDomains);
  const tree = useMemo(() => buildBlockLibraryTree(filtered, selectedDomain), [filtered, selectedDomain]);
  const scopeLabel = selectedDomain === 'uncategorized' ? 'unassigned' : selectedDomain || 'all domains';

  const open = (block: BlockEntry) => {
    if (onOpenBlock) {
      onOpenBlock(block);
      return;
    }
    const file = { name: block.path.split('/').pop() ?? block.name, path: block.path, type: 'block' as const, folder: 'blocks' };
    if (!state.files.some((f) => f.path === block.path)) dispatch({ type: 'FILE_ADDED', file });
    void api.openBlockStudio(block.path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload }));
  };

  // Publishing moves the block and its companion into tracked source. The
  // library is re-read afterwards, so the row loses its Private badge.
  const publish = async (block: BlockEntry) => {
    setPublishing(block.path);
    setPublishError(null);
    try {
      const result = await api.publishBlock(block.path);
      if (!result.ok) {
        setPublishError(result.error ?? 'Could not publish this saved query.');
        return;
      }
      setRetryKey((current) => current + 1);
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error));
    } finally {
      setPublishing(null);
    }
  };

  const draftCount = filtered.filter((block) => blockDisplayStatus(String(block.status ?? 'draft'), block, hostProposes) !== 'certified').length;
  const certifiedNames = new Set(blocks.filter((block) => block.status === 'certified').map((block) => block.name));
  const retry = <button type="button" onClick={() => setRetryKey((current) => current + 1)} style={{ marginLeft: 10, border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', fontSize: 11.5, fontWeight: 650, padding: 0, fontFamily: t.font }}>Retry</button>;

  // Keep the list on screen while it refreshes; only the first load shows a loading note.
  if (loading && blocks.length === 0) return <EmptyNote text="Loading saved queries…" t={t} />;
  if (loadError && blocks.length === 0) {
    return <div role="alert" style={{ padding: '14px 12px', fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>Couldn't load saved queries: {loadError}{retry}</div>;
  }
  if (blocks.length === 0) return <EmptyNote text="No saved queries yet." t={t} />;
  return <div>
    {loadError ? <div role="status" style={{ padding: '6px 12px', fontSize: 11, color: t.warning }}>Showing the last list: {loadError}{retry}</div> : null}
    <DomainScopeSelect
      id="block-domain-filter"
      ariaLabel="Saved query domain"
      value={selectedDomain}
      options={domainOptions}
      onChange={(value) => onDomainChange?.(value)}
      summary={<>{filtered.length} {filtered.length === 1 ? 'saved query' : 'saved queries'}{draftCount ? ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}` : ''} · {scopeLabel}</>}
      t={t}
    />
    {filtered.length === 0
      ? <EmptyNote text={search ? `No ${scopeLabel} saved queries match this search.` : selectedDomain ? `No saved queries in ${selectedDomain} yet.` : 'No saved queries yet.'} t={t} />
      : <BlockTree
          nodes={tree}
          depth={0}
          expandAll={Boolean(search.trim())}
          expandedFolders={expandedFolders}
          onToggleFolder={(path) => setExpandedFolders((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })}
          onOpen={open}
          onDelete={onDeleteBlock}
          onPublish={(block) => void publish(block)}
          publishingPath={publishing}
          certifiedNames={certifiedNames}
          t={t}
        />}
    {publishError ? <div role="alert" style={{ padding: '8px 12px', fontSize: 11.5, color: t.error, fontFamily: t.font }}>{publishError}</div> : null}
  </div>;
}

function BlockTree({
  nodes,
  depth,
  expandAll,
  expandedFolders,
  onToggleFolder,
  onOpen,
  onDelete,
  onPublish,
  publishingPath,
  certifiedNames,
  t,
}: {
  nodes: BlockLibraryTreeNode[];
  depth: number;
  expandAll: boolean;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onOpen: (block: BlockEntry) => void;
  onDelete?: (block: BlockEntry) => void;
  onPublish?: (block: BlockEntry) => void;
  publishingPath?: string | null;
  /** Names of certified blocks, so a draft of one reads as pending edits to it. */
  certifiedNames?: Set<string>;
  t: Theme;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'block') {
          const editsCertified = node.block.status !== 'certified' && /(^|\/)_drafts\//.test(node.block.path) && Boolean(certifiedNames?.has(node.block.name));
          return <BlockRow key={node.block.path} block={node.block} depth={depth} t={t} editsCertified={editsCertified} onOpen={() => onOpen(node.block)} onDelete={onDelete ? () => onDelete(node.block) : undefined} onPublish={onPublish ? () => onPublish(node.block) : undefined} publishing={publishingPath === node.block.path} />;
        }
        const expanded = expandAll || expandedFolders.has(node.path);
        return (
          <React.Fragment key={`folder:${node.path}`}>
            <button
              type="button"
              onClick={() => onToggleFolder(node.path)}
              title={node.path}
              style={{ ...rowStyle(t), paddingLeft: 10 + (depth * 16), borderBottom: 'none', fontWeight: 650 }}
            >
              {expanded ? <ChevronDown size={13} color={t.textMuted} /> : <ChevronRight size={13} color={t.textMuted} />}
              {expanded ? <FolderOpen size={14} color={t.accent} /> : <Folder size={14} color={t.textMuted} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{blockFolderLabel(node.name)}</span>
              <span style={{ fontSize: 10, color: t.textMuted }}>{countTreeBlocks(node.children)}</span>
            </button>
            {expanded ? <BlockTree nodes={node.children} depth={depth + 1} expandAll={expandAll} expandedFolders={expandedFolders} onToggleFolder={onToggleFolder} onOpen={onOpen} onDelete={onDelete} onPublish={onPublish} publishingPath={publishingPath} certifiedNames={certifiedNames} t={t} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

function countTreeBlocks(nodes: BlockLibraryTreeNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === 'block' ? 1 : countTreeBlocks(node.children)), 0);
}

// Prototype block row: blocks glyph · mono name over a meta line · status dot.
// A single click opens the block's detail overview (description lives there).
export function BlockRow({ block, depth = 0, t, onOpen, onDelete, onPublish, publishing = false, editsCertified = false }: { block: BlockEntry; depth?: number; t: Theme; onOpen: () => void; onDelete?: () => void; onPublish?: () => void; publishing?: boolean; editsCertified?: boolean }) {
  const status = blockDisplayStatus(String(block.status ?? 'draft'), block, hostProposesCertification(useHostUi()));
  const dot = STATUS_COLOR[status] ?? t.warning;
  const isPrivate = block.visibility === 'private';
  // Delete is a destructive action: it appears on hover or keyboard focus, not on every row.
  const [active, setActive] = useState(false);
  return (
    <div
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
        padding: `7px 8px 7px ${10 + (depth * 16)}px`, border: 'none', borderRadius: 7, margin: '1px 0',
        background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: t.font,
      }}
    >
      <button type="button" onClick={onOpen} title={block.description || `${block.name} — open`} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}>
        <Blocks size={14} color={t.textMuted} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.name}</span>
          <span style={{ fontSize: 10.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[block.domain, editsCertified ? 'draft · edits to the certified saved query' : status === 'proposed' ? 'certification proposed' : status, status === 'deprecated' && (block.replacement?.name ?? block.replacedBy) ? `replaced by ${block.replacement?.name ?? block.replacedBy}` : null].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      {isPrivate ? (
        <span title="Private: not in Git until you publish it" style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, color: t.textMuted, border: `1px solid ${t.cellBorder}`, background: t.btnBg }}>Private</span>
      ) : null}
      <span title={status} style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: dot }} />
      {isPrivate && onPublish ? (
        <button type="button" aria-label={`Publish ${block.name}`} title={`Publish ${block.name} so the team can see it`} onClick={onPublish} disabled={publishing} style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', color: t.accent, cursor: publishing ? 'wait' : 'pointer', opacity: active ? 1 : 0, transition: 'opacity .12s ease' }}>
          <Upload size={13} />
        </button>
      ) : null}
      {onDelete ? (
        <button type="button" aria-label={`Delete ${block.name}`} title={`Delete ${block.name}`} onClick={onDelete} style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', color: t.error, cursor: 'pointer', opacity: active ? 1 : 0, transition: 'opacity .12s ease' }}>
          <Trash2 size={13} />
        </button>
      ) : null}
    </div>
  );
}
