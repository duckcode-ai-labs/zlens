import React, { useEffect, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { PanelFrame, PanelEmpty, StatusPill } from '@zlens/ui';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { openAiBuild } from '../../utils/ai-build-bus';
import { STATUS_COLORS, type BlockEntry } from '../blocks/block-types';
import { BlockReplacementLink } from '../blocks/BlockRetirement';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'accent' | 'neutral' | 'error'> = {
  certified: 'success',
  published: 'success',
  deprecated: 'error',
  draft: 'warning',
  pending: 'warning',
  review: 'accent',
};

export function BlockLibraryPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const blockFileKey = state.files
    .filter((file) => file.type === 'block')
    .map((file) => file.path)
    .sort()
    .join('|');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getBlockLibrary()
      .then((result) => {
        if (active) setBlocks(result.blocks);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [blockFileKey]);

  const filtered = blocks.filter((b) => {
    if (search && !b.name.toLowerCase().includes(search.toLowerCase()) && !b.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const visibleBlocks = showAll || search ? filtered : filtered.slice(0, 10);

  const handleOpen = (block: Pick<BlockEntry, 'name' | 'path'>) => {
    const file = {
      name: block.path.split('/').pop() ?? block.name,
      path: block.path,
      type: 'block' as const,
      folder: 'blocks',
    };
    if (!state.files.some((f) => f.path === block.path)) {
      dispatch({ type: 'FILE_ADDED', file });
    }
    void api.openBlockStudio(block.path).then((payload) => {
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    });
  };

  const refresh = () => {
    setLoading(true);
    api.getBlockLibrary()
      .then((r) => setBlocks(r.blocks))
      .finally(() => setLoading(false));
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '7px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const actions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={() => dispatch({ type: 'START_NEW_BLOCK_WORKSPACE' })}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 5,
          color: '#fff', cursor: 'pointer', fontSize: 10, fontWeight: 700, fontFamily: t.font, padding: '4px 8px',
        }}
      >
        <Plus size={11} strokeWidth={2.2} /> New saved query
      </button>
      <button
        onClick={refresh}
        style={{
          background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4,
          color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '3px 8px',
        }}
      >
        Refresh
      </button>
    </div>
  );

  const toolbar = (
    <input
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Search saved queries..."
      style={inputStyle}
    />
  );

  return (
    <PanelFrame
      title="Saved queries"
      status={<span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{filtered.length}</span>}
      actions={actions}
      toolbar={toolbar}
      bodyPadding={0}
    >
      {loading ? (
        <PanelEmpty title="Loading saved queries…" />
      ) : filtered.length === 0 ? (
        <PanelEmpty
          title={blocks.length === 0 ? 'No saved queries yet' : 'No matches'}
          description={
            blocks.length === 0
              ? 'Open the builder to create your first review-ready saved query.'
              : 'No saved queries match your search.'
          }
          action={blocks.length === 0 ? (
            <button
              onClick={() => dispatch({ type: 'START_NEW_BLOCK_WORKSPACE' })}
              style={{ background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '7px 11px' }}
            >
              New saved query
            </button>
          ) : undefined}
        />
      ) : (
        <>
          {visibleBlocks.map((block) => (
            <div
              key={block.path}
              role="button"
              tabIndex={0}
              onClick={() => handleOpen(block)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleOpen(block);
                }
              }}
              className="dql-block-row"
              style={{
                display: 'block', width: '100%', textAlign: 'left', boxSizing: 'border-box',
                background: 'transparent', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
                cursor: 'pointer', padding: '10px 12px',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${t.accent}0a`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                  {block.name}
                </span>
                <StatusPill tone={STATUS_TONE[block.status] ?? 'neutral'}>
                  {block.status}
                </StatusPill>
                {/* Spec 17 (part A) — modify this block with AI (edit mode). */}
                <button
                  type="button"
                  title="Modify with AI"
                  aria-label={`Modify ${block.name} with AI`}
                  className="dql-block-row-modify"
                  onClick={(e) => {
                    e.stopPropagation();
                    openAiBuild({
                      target: 'block',
                      lockTarget: true,
                      mode: 'edit',
                      blockPath: block.path,
                      sourceLabel: `Modifying ${block.name}`,
                    });
                  }}
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    border: `1px solid ${t.btnBorder}`, borderRadius: 6,
                    background: t.btnBg, color: t.accent,
                    cursor: 'pointer', padding: '2px 7px',
                    fontSize: 10, fontWeight: 700, fontFamily: t.font,
                  }}
                >
                  <Sparkles size={11} strokeWidth={2.2} /> Modify
                </button>
              </div>
              {block.description && (
                <div style={{
                  fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.3,
                  marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {block.description}
                </div>
              )}
              {block.status === 'deprecated' && (
                <div style={{ marginBottom: 4 }}>
                  <BlockReplacementLink
                    info={block}
                    t={t}
                    onOpen={(path) => handleOpen({ path, name: block.replacement?.name ?? path })}
                  />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                <span style={{ background: t.pillBg, padding: '1px 6px', borderRadius: 4 }}>
                  {block.domain}
                </span>
                {block.owner && <span>by {block.owner}</span>}
                {block.llmContext && (
                  <span
                    title={block.llmContext}
                    style={{ color: t.accent, fontWeight: 600, letterSpacing: '0.04em' }}
                  >
                    AI
                  </span>
                )}
                <span style={{ marginLeft: 'auto' }}>
                  {new Date(block.lastModified).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
          {!showAll && !search && filtered.length > 10 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                width: '100%',
                background: t.btnBg,
                border: 'none',
                borderBottom: `1px solid ${t.cellBorder}`,
                color: t.accent,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: t.font,
                padding: '10px 12px',
              }}
            >
              Show all {filtered.length} saved queries
            </button>
          )}
        </>
      )}
    </PanelFrame>
  );
}
