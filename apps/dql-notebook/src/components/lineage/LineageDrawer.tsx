/**
 * LineageDrawer — right-side overlay panel that shows a focused lineage graph
 * for the currently selected node, without yanking the user out of the
 * notebook / block / files view they were working in.
 *
 * Triggered by:
 *  - clicking a node in LineagePanel (sidebar list)
 *  - "View lineage" from the Files panel context menu
 *  - any other "show lineage for X" entry point
 *
 * Supports resizing and compact collapse.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ExternalLink,
  GripVertical,
  Minimize2,
  PanelRightOpen,
  RotateCcw,
  X,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { MiniLineageGraph } from './MiniLineageGraph';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  EDGE_TITLES,
  type LineageNode,
  type LineageEdge,
} from './lineage-constants';

interface FocusedGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  focalNode: LineageNode | null;
}

const MIN_DRAWER_WIDTH = 320;
const COLLAPSED_DRAWER_WIDTH = 48;

function defaultDrawerWidth(): number {
  if (typeof window === 'undefined') return 380;
  return Math.min(420, Math.max(MIN_DRAWER_WIDTH, Math.round(window.innerWidth * 0.42)));
}

function maxDrawerWidth(): number {
  if (typeof window === 'undefined') return 760;
  return Math.max(420, Math.min(880, Math.round(window.innerWidth * 0.72)));
}

function clampDrawerWidth(width: number): number {
  return Math.min(maxDrawerWidth(), Math.max(MIN_DRAWER_WIDTH, width));
}

export function LineageDrawer() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const nodeId = state.lineageDrawerNodeId;

  const [graph, setGraph] = useState<FocusedGraph>({ nodes: [], edges: [], focalNode: null });
  const [loading, setLoading] = useState(false);
  // ReactFlow needs an explicit pixel height — measuring the flex container
  // ensures the graph fills available space instead of collapsing to 0.
  const graphHostRef = useRef<HTMLDivElement>(null);
  const [graphHeight, setGraphHeight] = useState(360);
  const [drawerWidth, setDrawerWidth] = useState(() => defaultDrawerWidth());
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(drawerWidth);

  useEffect(() => {
    const el = graphHostRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.max(160, entry.contentRect.height);
        setGraphHeight(next);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    api
      .queryLineage({ focus: nodeId, upstreamDepth: 2, downstreamDepth: 2 })
      .then((res) => {
        if (cancelled) return;
        setGraph({
          nodes: (res.graph?.nodes ?? []) as LineageNode[],
          edges: (res.graph?.edges ?? []) as LineageEdge[],
          focalNode: (res.focalNode as LineageNode) ?? null,
        });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const focal = graph.focalNode;
  const upstreamCount = focal
    ? graph.edges.filter((e) => e.target === focal.id).length
    : 0;
  const downstreamCount = focal
    ? graph.edges.filter((e) => e.source === focal.id).length
    : 0;
  const focalColor = focal ? NODE_TYPE_COLORS[focal.type] ?? t.textSecondary : t.textSecondary;
  const focalLabel = focal ? TYPE_LABELS[focal.type] ?? focal.type.toUpperCase() : '';
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const upstreamConnections = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.target === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.source) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const downstreamConnections = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.source === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.target) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const filePath = focal?.metadata?.path ?? focal?.metadata?.filePath;

  if (!nodeId) return null;

  const handleNodeClick = (clickedId: string) => {
    if (clickedId === nodeId) return;
    dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId: clickedId });
  };

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (drawerCollapsed) setDrawerCollapsed(false);
    const startX = event.clientX;
    const startWidth = widthRef.current;
    setResizing(true);

    const onMove = (moveEvent: MouseEvent) => {
      const next = clampDrawerWidth(startWidth + (startX - moveEvent.clientX));
      widthRef.current = next;
      setDrawerWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resetWidth = () => {
    const next = defaultDrawerWidth();
    widthRef.current = next;
    setDrawerWidth(next);
    setDrawerCollapsed(false);
  };

  const closeDrawer = () => dispatch({ type: 'CLOSE_LINEAGE_DRAWER' });

  if (drawerCollapsed) {
    return (
      <aside
        aria-label="Collapsed lineage drawer"
        style={{
          width: COLLAPSED_DRAWER_WIDTH,
          flexShrink: 0,
          borderLeft: `1px solid ${t.headerBorder}`,
          background: t.appBg,
          color: t.textPrimary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          padding: '10px 6px',
          overflow: 'hidden',
        }}
      >
        <IconButton title="Show lineage details" onClick={() => setDrawerCollapsed(false)} t={t}>
          <PanelRightOpen size={15} strokeWidth={1.9} />
        </IconButton>
        <IconButton title="Hide lineage drawer" onClick={closeDrawer} t={t}>
          <X size={15} strokeWidth={2} />
        </IconButton>
        <div
          title={focal?.name ?? nodeId}
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            color: t.textMuted,
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            marginTop: 4,
            maxHeight: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {focal?.name ?? 'Lineage'}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Lineage drawer"
      style={{
        width: drawerWidth,
        flexShrink: 0,
        borderLeft: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        color: t.textPrimary,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        animation: 'dql-drawer-slide-in 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      }}
    >
      <div
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        title="Drag to resize. Double-click to reset width."
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 8,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: resizing ? `${t.accent}1f` : 'transparent',
          transition: resizing ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!resizing) e.currentTarget.style.background = `${t.accent}14`;
        }}
        onMouseLeave={(e) => {
          if (!resizing) e.currentTarget.style.background = 'transparent';
        }}
      >
        <div
          style={{
            width: 3,
            height: 44,
            borderRadius: 999,
            background: resizing ? t.accent : t.headerBorder,
            boxShadow: resizing ? `0 0 0 3px ${t.accent}1f` : 'none',
          }}
        />
      </div>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px 11px',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.appBg,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 38,
            padding: '2px 6px',
            background: focalColor,
            color: t.appBg,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0,
            borderRadius: 4,
          }}
          title={focal ? TYPE_TITLES[focal.type] ?? focal.type : ''}
        >
          {focalLabel || 'NODE'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 800, marginBottom: 3 }}>
            Lineage Inspector
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: t.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={focal?.name ?? nodeId}
          >
            {focal?.name ?? nodeId}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>
            Lineage · ↑ {upstreamCount} · ↓ {downstreamCount}
          </div>
        </div>
        <IconButton title="Collapse drawer" onClick={() => setDrawerCollapsed(true)} t={t}>
          <Minimize2 size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton title="Reset width" onClick={resetWidth} t={t}>
          <RotateCcw size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title="Hide lineage drawer"
          onClick={closeDrawer}
          t={t}
        >
          <X size={14} strokeWidth={2} />
        </IconButton>
      </div>

      <div
        style={{
          height: 30,
          padding: '0 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: t.textMuted,
          fontSize: 11,
          flexShrink: 0,
          background: t.sidebarBg,
        }}
      >
        <GripVertical size={13} strokeWidth={1.8} />
        <span>Drag the left edge to resize</span>
        <span style={{ marginLeft: 'auto', color: t.textMuted }}>{drawerWidth}px</span>
      </div>

      {focal && <NodeMetadataSummary node={focal} t={t} />}

      {/* Graph */}
      <div
        ref={graphHostRef}
        style={{
          flex: 1,
          minHeight: 220,
          padding: 12,
          overflow: 'hidden',
          display: 'flex',
          background: t.appBg,
        }}
      >
        {loading ? (
          <div style={{ color: t.textMuted, fontSize: 12, padding: 8 }}>Loading lineage…</div>
        ) : graph.nodes.length === 0 ? (
          <div style={{ color: t.textMuted, fontSize: 12, padding: 8 }}>
            No lineage available for this node.
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MiniLineageGraph
              nodes={graph.nodes}
              edges={graph.edges}
              focalNodeId={nodeId}
              height={Math.max(0, graphHeight - 24)}
              onNodeClick={handleNodeClick}
              interactive
            />
          </div>
        )}
      </div>

      {focal && (
        <div
          style={{
            borderTop: `1px solid ${t.headerBorder}`,
            padding: '10px 12px',
            display: 'grid',
            gap: 10,
            maxHeight: 280,
            overflow: 'auto',
            background: t.sidebarBg,
            flexShrink: 0,
          }}
        >
          <ConnectionList title="Upstream" connections={upstreamConnections} t={t} />
          <ConnectionList title="Downstream" connections={downstreamConnections} t={t} />
        </div>
      )}

      {/* Footer hint */}
      {typeof filePath === 'string' && (
        <div
          style={{
            padding: '8px 14px',
            borderTop: `1px solid ${t.headerBorder}`,
            fontSize: 11,
            color: t.textMuted,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <ExternalLink size={11} strokeWidth={1.75} />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filePath}
          >
            {filePath}
          </span>
        </div>
      )}
    </aside>
  );
}

function NodeMetadataSummary({ node, t }: { node: LineageNode; t: Theme }) {
  const metadata = node.metadata ?? {};
  const rows: Array<{ label: string; value: string }> = [];

  if (node.domain) rows.push({ label: 'Domain', value: node.domain });
  if (node.owner) rows.push({ label: 'Owner', value: node.owner });
  if (node.status) rows.push({ label: 'Status', value: node.status });
  if (node.type === 'term' && typeof metadata.termType === 'string') rows.push({ label: 'Term Type', value: metadata.termType });
  if (node.type === 'block' && typeof metadata.blockType === 'string') rows.push({ label: 'Saved query type', value: metadata.blockType });
  if (typeof metadata.materializedAs === 'string') rows.push({ label: 'Materialized As', value: metadata.materializedAs });
  if (Array.isArray(metadata.identifiers) && metadata.identifiers.length > 0) {
    rows.push({ label: 'Identifiers', value: metadata.identifiers.map(String).join(', ') });
  }
  if (Array.isArray(metadata.synonyms) && metadata.synonyms.length > 0) {
    rows.push({ label: 'Synonyms', value: metadata.synonyms.map(String).join(', ') });
  }
  if (typeof metadata.description === 'string' && metadata.description.trim()) {
    rows.push({ label: 'Description', value: metadata.description });
  }
  if (typeof metadata.businessOutcome === 'string' && metadata.businessOutcome.trim()) {
    rows.push({ label: 'Business Outcome', value: metadata.businessOutcome });
  }

  if (rows.length === 0) return null;

  return (
    <div
      style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${t.headerBorder}`,
        display: 'grid',
        gap: 6,
        background: t.sidebarBg,
      }}
    >
      {rows.slice(0, 6).map((row) => (
        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, minWidth: 0 }}>
          <span style={{ color: t.textMuted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{row.label}</span>
          <span
            style={{
              color: t.textSecondary,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: row.value.length > 90 ? 'normal' : 'nowrap',
            }}
            title={row.value}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConnectionList({
  title,
  connections,
  t,
}: {
  title: string;
  connections: Array<{ edge: LineageEdge; node: LineageNode }>;
  t: Theme;
}) {
  if (connections.length === 0) {
    return (
      <div style={{ color: t.textMuted, fontSize: 11 }}>
        {title}: none in this focused window
      </div>
    );
  }

  return (
    <div>
      <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', marginBottom: 5 }}>
        {title}
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {connections.slice(0, 5).map(({ edge, node }) => {
          const color = NODE_TYPE_COLORS[node.type] ?? t.textMuted;
          return (
            <div
              key={`${edge.source}-${edge.target}-${edge.type}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '76px 1fr',
                gap: 8,
                alignItems: 'center',
                fontSize: 11,
                minWidth: 0,
              }}
            >
              <span style={{ color: t.textMuted }}>{EDGE_TITLES[edge.type] ?? edge.type}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span
                  style={{
                    color: t.appBg,
                    background: color,
                    borderRadius: 3,
                    padding: '1px 4px',
                    fontSize: 8,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.name}>
                  {node.name}
                </span>
              </span>
            </div>
          );
        })}
        {connections.length > 5 && (
          <div style={{ color: t.textMuted, fontSize: 11 }}>
            {connections.length - 5} more connection{connections.length - 5 === 1 ? '' : 's'} in the graph
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
  t,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  t: Theme;
}) {
  return (
    <button
      aria-label={title}
      title={title}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 5,
        color: t.textSecondary,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = t.textPrimary;
        e.currentTarget.style.background = t.textPrimary + '0f';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = t.textSecondary;
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
