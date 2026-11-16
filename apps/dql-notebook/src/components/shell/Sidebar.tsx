import React, { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../../api/client';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { BuildSidebar } from '../panels/BuildSidebar';
import { buildCatalogFooter } from '../panels/build-footer';
import { useSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { LineagePanel } from '../panels/LineagePanel';
import { GitPanel } from '../panels/GitPanel';
import { AppsPanel } from '../panels/AppsPanel';
import type { NotebookFile } from '../../store/types';

interface SidebarProps {
  onOpenFile: (file: NotebookFile) => void;
}

const PANEL_TITLES: Record<string, string> = {
  files: 'Build',
  block_library: 'Build',
  lineage: 'Lineage',
  connection: 'Connection',
  git: 'Git',
  apps: 'Apps',
};

export function Sidebar({ onOpenFile }: SidebarProps) {
  const state = useNotebookStore(useShallow((store) => ({
    blockStudioDbtStatus: store.blockStudioDbtStatus,
    schemaTables: store.schemaTables,
    semanticLayer: store.semanticLayer,
    sidebarPanel: store.sidebarPanel,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const hostUi = useHostUi();
  const snowflakeApp = useSnowflakeApp();
  const t = themes[state.themeMode];
  const [collapseHover, setCollapseHover] = useState(false);
  // Match Block Studio's explorer width so all four Build tabs retain their
  // labels and the catalog rows have the same information density.
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const [resizing, setResizing] = useState(false);
  const [blockDomain, setBlockDomain] = useState('');
  const widthRef = useRef(sidebarWidth);

  const panel = state.sidebarPanel;
  const buildPanel = panel === 'files' || panel === 'block_library';
  const buildFooter = state.semanticLayer.loading
    ? 'Loading semantic metrics…'
    : buildCatalogFooter({
      provider: state.semanticLayer.provider,
      dbtModels: state.blockStudioDbtStatus?.counts.models,
      warehouseTables: state.schemaTables.length,
      metrics: state.semanticLayer.metrics.length,
      snowflakeApp,
    });

  // The dbt model count is a local artifact read (no warehouse call); load it
  // once if no other view has yet, so the footer can count dbt models.
  const dbtStatusLoaded = state.blockStudioDbtStatus !== null;
  useEffect(() => {
    if (!buildPanel || dbtStatusLoaded) return undefined;
    let active = true;
    void api.getBlockStudioDbtStatus()
      .then((status) => { if (active) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [buildPanel, dbtStatusLoaded, dispatch]);

  // Block Studio loads this context before rendering its footer. Do the same in
  // the Notebook explorer so the shared footer never reports a stale 0 metrics.
  useEffect(() => {
    if (!buildPanel) return undefined;
    let active = true;
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    void api.getSemanticLayer()
      .then((layer) => { if (active) dispatch({ type: 'SET_SEMANTIC_LAYER', layer }); })
      .catch(() => undefined)
      .finally(() => { if (active) dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false }); });
    return () => { active = false; };
  }, [buildPanel, dispatch]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(560, Math.max(180, startW + (ev.clientX - startX)));
      widthRef.current = next;
      setSidebarWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      style={{
        width: sidebarWidth,
        flexShrink: 0,
        background: t.sidebarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Build owns its integrated tab/collapse header, like Block Studio. */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: buildPanel ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px 0 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            color: t.textSecondary,
            fontFamily: t.font,
          }}
        >
          {PANEL_TITLES[panel ?? ''] ?? ''}
        </span>
        <button
          title="Collapse sidebar"
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          onMouseEnter={() => setCollapseHover(true)}
          onMouseLeave={() => setCollapseHover(false)}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: collapseHover ? t.textPrimary : t.textMuted,
            padding: '2px 4px',
            borderRadius: 4,
            fontSize: 14,
            lineHeight: 1,
            transition: 'color 0.15s',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          ‹
        </button>
      </div>

      {/* Panel content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {buildPanel && (
          <BuildSidebar
            defaultTab={panel === 'block_library' ? 'blocks' : 'notebooks'}
            tabs={['notebooks', 'semantic', 'database', 'blocks']}
            onOpenFile={onOpenFile}
            blockDomain={blockDomain}
            onBlockDomainChange={setBlockDomain}
            onNewBlock={hostReadOnly(hostUi, 'block_library') ? undefined : () => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
            onCollapse={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            footer={buildFooter}
            footerStatus={state.semanticLayer.loading ? 'loading' : 'ready'}
          />
        )}
        {panel === 'lineage' && <LineagePanel />}
        {panel === 'connection' && <ConnectionPanel />}
        {panel === 'git' && <GitPanel />}
        {panel === 'apps' && <AppsPanel onOpenFile={onOpenFile} />}
      </div>

      {/* Resize handle on right edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 6,
          height: '100%',
          cursor: 'col-resize',
          background: resizing ? t.accent : 'transparent',
          zIndex: 10,
          transition: resizing ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = `${t.accent}40`; }}
        onMouseLeave={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
    </div>
  );
}
