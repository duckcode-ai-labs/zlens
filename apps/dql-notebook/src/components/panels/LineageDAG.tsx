import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useShallow } from 'zustand/react/shallow';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { PROJECT_REFRESHED_EVENT } from '../../operations/OperationsProvider';
import {
  NODE_TYPE_COLORS,
  TYPE_TITLES,
  EDGE_TYPE_COLORS,
  EDGE_TITLES,
  lineageEdgeLabel,
  LAYER_ORDER,
  LINEAGE_NODE_TYPE_ORDER,
  TECHNICAL_LINEAGE_NODE_TYPES,
  DOMAIN_LINEAGE_NODE_TYPES,
  getNodeLayer,
  type LineageNode,
  type LineageEdge,
  type LineageLayerName,
} from '../lineage/lineage-constants';
import { lineageSourcesLabel, lineageSourcesOf } from '../lineage/lineage-sources';

type LayoutMode = 'flow' | 'layered';
type Direction = 'LR' | 'TB';


const LINEAGE_PRESETS = [
  {
    key: 'technical',
    label: 'Technical',
    title: 'Physical sources and dbt transformations',
    types: TECHNICAL_LINEAGE_NODE_TYPES,
  },
  {
    key: 'domain',
    label: 'Domain',
    title: 'Business terms, governed domains, semantic metrics, and certified saved queries',
    types: DOMAIN_LINEAGE_NODE_TYPES,
  },
  {
    key: 'end-to-end',
    label: 'End-to-end',
    title: 'Complete path from physical sources through governed meaning to consumption',
    types: LINEAGE_NODE_TYPE_ORDER,
  },
] as const;

// The canvas always scopes to ONE of these — a block, app, or notebook the user
// picks — rather than showing the whole (noisy) project graph. Ordered as tabs.
const FOCUSABLE_TYPES = [
  { type: 'block', label: 'Saved queries' },
  { type: 'app', label: 'Apps' },
  { type: 'notebook', label: 'Notebooks' },
  { type: 'dashboard', label: 'Dashboards' },
] as const;

function layoutGraph(nodes: Node[], edges: Edge[], mode: LayoutMode = 'flow', direction: Direction = 'LR') {
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  const isHorizontal = direction === 'LR';
  graph.setGraph({
    rankdir: direction,
    ranksep: mode === 'layered' ? 120 : (isHorizontal ? 80 : 60),
    nodesep: isHorizontal ? 40 : 50,
    marginx: 32,
    marginy: 32,
  });

  for (const node of nodes) {
    const opts: Record<string, unknown> = { width: 190, height: 58 };
    // In layered mode, assign a rank based on the node's lineage layer
    if (mode === 'layered' && node.data?.layer) {
      const layerIndex = LAYER_ORDER.indexOf(node.data.layer as LineageLayerName);
      if (layerIndex >= 0) opts.rank = layerIndex;
    }
    graph.setNode(node.id, opts);
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  Dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      position: { x: position.x - 95, y: position.y - 29 },
      data: { ...node.data, direction },
    };
  });
}

// Prototype (Lineage Redesign) node card: type dot · mono name · uppercase
// type label in the type color · certified shield. 196px wide.
function DagNode({ data, selected }: NodeProps) {
  const nodeType = data.nodeType as string;
  const color = NODE_TYPE_COLORS[nodeType] ?? 'var(--color-text-tertiary)';
  const direction = (data.direction as Direction) ?? 'LR';
  const targetPos = direction === 'LR' ? Position.Left : Position.Top;
  const sourcePos = direction === 'LR' ? Position.Right : Position.Bottom;
  const dimmed = Boolean(data.dimmed);
  const certified = data.status === 'certified';
  return (
    <div
      style={{
        width: 196,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--color-bg-card)',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        borderRadius: 9,
        padding: '9px 11px',
        boxShadow: selected ? '0 1px 6px rgba(107,93,211,0.16)' : '0 1px 4px rgba(26,26,26,0.05)',
        opacity: dimmed ? 0.3 : 1,
        transition: 'opacity 0.15s ease',
      }}
    >
      <Handle type="target" position={targetPos} style={{ width: 7, height: 7, background: color, border: 'none' }} />
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          title={data.label as string}
          style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--color-text-primary)', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {data.label as string}
        </span>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color }}>
          {TYPE_TITLES[nodeType] ?? nodeType}
        </span>
      </span>
      {certified ? <ShieldCheck size={12} color="var(--status-success)" strokeWidth={2} style={{ flexShrink: 0 }} /> : null}
      <Handle type="source" position={sourcePos} style={{ width: 7, height: 7, background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { dagNode: DagNode };

export function LineageDAG() {
  const state = useNotebookStore(useShallow((store) => ({
    lineageFocusNodeId: store.lineageFocusNodeId,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const t = themes[state.themeMode];

  const [loading, setLoading] = useState(true);
  // Full graph is fetched once, only to populate the entity picker. The canvas
  // never renders it directly — it always scopes to a selected entity.
  const [fullGraph, setFullGraph] = useState<{ nodes: LineageNode[]; edges: LineageEdge[] }>({ nodes: [], edges: [] });
  const [graphData, setGraphData] = useState<{ nodes: LineageNode[]; edges: LineageEdge[] }>({ nodes: [], edges: [] });
  const [focalNode, setFocalNode] = useState<LineageNode | null>(null);
  // The selected block/app/notebook whose lineage the canvas shows.
  const [focalId, setFocalId] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<LineageNode | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Record<string, boolean>>(
    Object.fromEntries(LINEAGE_NODE_TYPE_ORDER.map((type) => [type, true])),
  );
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('flow');
  const [direction, setDirection] = useState<Direction>('LR');
  // Prototype directional focus: clicking a node dims everything that is not
  // an ancestor or descendant of it (computed client-side over visible edges).
  const [dimSelId, setDimSelId] = useState<string | null>(null);
  // Entity picker (Blocks / Apps / Notebooks) — tabbed browse popover.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerType, setPickerType] = useState<string>('block');
  const [pickerQuery, setPickerQuery] = useState('');
  // Always-visible toolbar search to jump to another entity's lineage.
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchQuery, setSwitchQuery] = useState('');

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const loadFullGraph = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.fetchLineage();
      setFullGraph({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFullGraph();
  }, [loadFullGraph]);

  // A block saved, certified or deleted elsewhere changes the project graph.
  // Reload when the server finishes its project refresh (or the block library
  // is invalidated) rather than waiting for a remount or the file watcher.
  useEffect(() => {
    const reload = () => { void loadFullGraph(); };
    window.addEventListener(PROJECT_REFRESHED_EVENT, reload);
    window.addEventListener('dql:block-library-invalidated', reload);
    return () => {
      window.removeEventListener(PROJECT_REFRESHED_EVENT, reload);
      window.removeEventListener('dql:block-library-invalidated', reload);
    };
  }, [loadFullGraph]);

  // What the project's lineage was built from: the dbt manifest, the synced
  // warehouse catalog, or both (never dbt on a project that does not use it).
  const lineageSources = useMemo(() => lineageSourcesOf(fullGraph.nodes), [fullGraph.nodes]);

  // Blocks, apps, and notebooks the user can trace lineage from.
  const entities = useMemo(
    () => fullGraph.nodes
      .filter((node) => FOCUSABLE_TYPES.some((f) => f.type === node.type))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [fullGraph.nodes],
  );

  // Load one entity's scoped upstream+downstream lineage into the canvas.
  const selectEntity = useCallback(async (nodeId: string) => {
    setFocalId(nodeId);
    setPickerOpen(false);
    setDimSelId(null);
    setSelectedNode(null);
    setScopeLoading(true);
    try {
      const result = await api.queryLineage({ focus: nodeId, upstreamDepth: 12, downstreamDepth: 12 });
      setGraphData(result.graph ?? { nodes: [], edges: [] });
      setFocalNode((result.focalNode as LineageNode) ?? null);
    } finally {
      setScopeLoading(false);
    }
  }, []);

  // Return to the picker (clears the deep-link focus so it doesn't re-select).
  const clearEntity = useCallback(() => {
    setFocalId(null);
    setGraphData({ nodes: [], edges: [] });
    setFocalNode(null);
    setSelectedNode(null);
    setDimSelId(null);
    setPickerOpen(false);
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: null });
  }, [dispatch]);

  // Deep link (e.g. "Open in lineage" from another page) selects that entity.
  useEffect(() => {
    if (state.lineageFocusNodeId && state.lineageFocusNodeId !== focalId) {
      void selectEntity(state.lineageFocusNodeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lineageFocusNodeId]);

  const filteredGraph = useMemo(() => {
    const visibleNodeIds = new Set(
      graphData.nodes
        .filter((node) => visibleTypes[node.type] ?? true)
        .map((node) => node.id),
    );
    return {
      nodes: graphData.nodes.filter((node) => visibleNodeIds.has(node.id)),
      edges: graphData.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    };
  }, [graphData, visibleTypes]);

  const activePreset = useMemo(() => {
    for (const preset of LINEAGE_PRESETS) {
      const allowed = new Set<string>(preset.types);
      const matchesPreset = LINEAGE_NODE_TYPE_ORDER.every((type) => (visibleTypes[type] ?? true) === allowed.has(type));
      if (matchesPreset) return preset.key;
    }
    return 'custom';
  }, [visibleTypes]);

  const applyPreset = useCallback((types: readonly string[]) => {
    const allowed = new Set(types);
    setVisibleTypes(Object.fromEntries(LINEAGE_NODE_TYPE_ORDER.map((type) => [type, allowed.has(type)])));
  }, []);

  // Directional reachability for the focus dim: ancestors via reverse edges
  // ∪ descendants via forward edges (never the union of both per hop).
  const dimConnected = useMemo(() => {
    if (!dimSelId) return null;
    const up = new Set([dimSelId]);
    const down = new Set([dimSelId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of filteredGraph.edges) {
        if (up.has(edge.target) && !up.has(edge.source)) { up.add(edge.source); grew = true; }
        if (down.has(edge.source) && !down.has(edge.target)) { down.add(edge.target); grew = true; }
      }
    }
    return new Set([...up, ...down]);
  }, [dimSelId, filteredGraph.edges]);

  useEffect(() => {
    const nodes: Node[] = filteredGraph.nodes.map((node) => ({
      id: node.id,
      type: 'dagNode',
      // Mark the traced entity as selected so it gets the accent border.
      selected: node.id === focalId,
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeType: node.type,
        domain: node.domain,
        status: node.status,
        layer: getNodeLayer(node),
        dimmed: dimConnected ? !dimConnected.has(node.id) : false,
      },
    }));

    const edges: Edge[] = filteredGraph.edges.map((edge, index) => {
      const onPath = dimConnected ? dimConnected.has(edge.source) && dimConnected.has(edge.target) : false;
      const color = onPath ? 'var(--accent)' : EDGE_TYPE_COLORS[edge.type] ?? 'var(--color-text-tertiary)';
      const label = lineageEdgeLabel(edge.type);
      return {
        id: `edge-${index}-${edge.source}-${edge.target}-${edge.type}`,
        source: edge.source,
        target: edge.target,
        ...(label ? { label, labelStyle: { fill: color, fontSize: 10, fontWeight: 600 } } : {}),
        style: {
          stroke: color,
          strokeWidth: onPath ? 2 : 1.5,
          opacity: dimConnected && !onPath ? 0.25 : 1,
          ...(label ? { strokeDasharray: '4 3' } : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 12,
          height: 12,
        },
      };
    });

    setRfNodes(layoutGraph(nodes, edges, layoutMode, direction));
    setRfEdges(edges);
  }, [filteredGraph, layoutMode, direction, dimConnected, focalId, setRfEdges, setRfNodes]);

  // Clicking a node dims off-path nodes on the visible (already-scoped) canvas.
  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setDimSelId(node.id);
    const lineageNode = filteredGraph.nodes.find((item) => item.id === node.id) ?? null;
    setSelectedNode(lineageNode);
  }, [filteredGraph.nodes]);

  const clearDim = useCallback(() => {
    setDimSelId(null);
    setSelectedNode(null);
  }, []);

  const selectedSummary = useMemo(() => {
    if (!selectedNode) return null;
    const incoming = graphData.edges.filter((edge) => edge.target === selectedNode.id).length;
    const outgoing = graphData.edges.filter((edge) => edge.source === selectedNode.id).length;
    return { incoming, outgoing };
  }, [graphData.edges, selectedNode]);

  const focalName = focalNode?.name ?? entities.find((entity) => entity.id === focalId)?.name ?? focalId ?? '';
  const focalType = focalNode?.type ?? entities.find((entity) => entity.id === focalId)?.type ?? 'block';

  // Toolbar search — matches any block/app/notebook/dashboard by name.
  const switchQ = switchQuery.trim().toLowerCase();
  const switchResults = (switchQ ? entities.filter((entity) => entity.name.toLowerCase().includes(switchQ)) : entities).slice(0, 40);

  if (loading) {
    return <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>Loading lineage graph...</div>;
  }

  if (fullGraph.nodes.length === 0) {
    return <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>No lineage graph available yet.</div>;
  }

  // Landing state — nothing traced yet. Pick a block, app, or notebook.
  if (!focalId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-primary)', alignItems: 'center', justifyContent: 'center', padding: 24, overflow: 'auto' }}>
        <div style={{ width: 'min(560px, 100%)', border: `1px solid ${t.headerBorder}`, borderRadius: 14, background: t.cellBg, padding: '22px 22px 18px', boxShadow: '0 1px 4px rgba(26,26,26,0.05)' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Trace lineage</div>
          <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5, fontFamily: t.font }}>
            Pick a saved query, app, or notebook to see its upstream sources and downstream consumers — no project-wide noise.
          </div>
          <div style={{ marginTop: 16 }}>
            <EntityPicker
              t={t}
              entities={entities}
              activeType={pickerType}
              onTypeChange={setPickerType}
              query={pickerQuery}
              onQueryChange={setPickerQuery}
              onSelect={(id) => void selectEntity(id)}
              focalId={focalId}
              listHeight={300}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-primary)' }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: t.sidebarBg }}>
        {/* Traced entity selector + layout toggle + type filters */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setPickerOpen((open) => !open)}
              title="Change the traced entity"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 11px', borderRadius: 8,
                border: `1px solid ${pickerOpen ? t.accent : t.headerBorder}`, background: pickerOpen ? 'var(--accent-dim)' : t.cellBg,
                color: t.textPrimary, cursor: 'pointer', fontFamily: t.font, maxWidth: 320,
              }}
            >
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textMuted }}>Tracing</span>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[focalType] ?? 'var(--color-text-tertiary)', flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, fontWeight: 650, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focalName}</span>
              <span style={{ fontSize: 9, color: t.textMuted }}>▾</span>
            </button>
            {pickerOpen && (
              <>
                <div onClick={() => setPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 31, width: 340, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 11, boxShadow: '0 10px 30px rgba(26,26,26,0.14)', padding: 12 }}>
                  <EntityPicker
                    t={t}
                    entities={entities}
                    activeType={pickerType}
                    onTypeChange={setPickerType}
                    query={pickerQuery}
                    onQueryChange={setPickerQuery}
                    onSelect={(id) => void selectEntity(id)}
                    focalId={focalId}
                    listHeight={240}
                  />
                </div>
              </>
            )}
          </div>

          {/* Always-visible search — jump to another entity's lineage. */}
          <div style={{ position: 'relative', flex: '0 1 300px', minWidth: 160 }}>
            <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: t.textMuted, pointerEvents: 'none' }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              value={switchQuery}
              onChange={(event) => { setSwitchQuery(event.target.value); setSwitchOpen(true); }}
              onFocus={() => setSwitchOpen(true)}
              placeholder="Search another saved query, app, or notebook…"
              style={{ width: '100%', boxSizing: 'border-box', height: 30, padding: '0 10px 0 28px', borderRadius: 8, border: `1px solid ${switchOpen ? t.accent : t.headerBorder}`, background: 'var(--color-bg-sunken)', color: t.textPrimary, fontSize: 12, fontFamily: t.font, outline: 'none' }}
            />
            {switchOpen && (
              <>
                <div onClick={() => setSwitchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 31, width: 'min(340px, 90vw)', maxHeight: 300, overflow: 'auto', background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 11, boxShadow: '0 10px 30px rgba(26,26,26,0.14)', padding: 4 }}>
                  {switchResults.length === 0 ? (
                    <div style={{ padding: '12px 11px', fontSize: 12, color: t.textMuted, fontFamily: t.font }}>No matching saved query, app, or notebook.</div>
                  ) : (
                    switchResults.map((entity) => (
                      <button
                        key={entity.id}
                        onClick={() => { void selectEntity(entity.id); setSwitchQuery(''); setSwitchOpen(false); }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left', padding: '8px 10px', border: 'none', borderRadius: 7, background: entity.id === focalId ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer', fontFamily: t.font }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[entity.type] ?? 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 550, color: t.textPrimary, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entity.name}</span>
                        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textMuted, flexShrink: 0 }}>{TYPE_TITLES[entity.type] ?? entity.type}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
          <div style={{ width: 1, height: 20, background: t.headerBorder, margin: '0 2px' }} />
          {/* Layout mode toggle */}
          <div style={{ display: 'flex', borderRadius: 6, border: `1px solid ${t.headerBorder}`, overflow: 'hidden' }}>
            <button
              onClick={() => setLayoutMode('flow')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: layoutMode === 'flow' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: layoutMode === 'flow' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              }}
            >
              Flow
            </button>
            <button
              onClick={() => setLayoutMode('layered')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                borderLeft: `1px solid ${t.headerBorder}`,
                cursor: 'pointer',
                background: layoutMode === 'layered' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: layoutMode === 'layered' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              }}
            >
              Layered
            </button>
          </div>
          {/* Direction toggle — Horizontal (LR) vs Vertical (TB) */}
          <div style={{ display: 'flex', borderRadius: 6, border: `1px solid ${t.headerBorder}`, overflow: 'hidden', marginRight: 4 }}>
            <button
              title="Horizontal layout (left → right)"
              onClick={() => setDirection('LR')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: direction === 'LR' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: direction === 'LR' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {/* →→ horizontal icon */}
              <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
                <rect x="0" y="2" width="4" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <line x1="4" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M9 3l2 2-2 2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                <rect x="10" y="2" width="4" height="6" rx="1" fill="currentColor"/>
              </svg>
              LR
            </button>
            <button
              title="Vertical layout (top → bottom)"
              onClick={() => setDirection('TB')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                borderLeft: `1px solid ${t.headerBorder}`,
                cursor: 'pointer',
                background: direction === 'TB' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: direction === 'TB' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {/* ↓ vertical icon */}
              <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                <rect x="2" y="0" width="6" height="4" rx="1" fill="currentColor" opacity="0.7"/>
                <line x1="5" y1="4" x2="5" y2="10" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M3 9l2 2 2-2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                <rect x="2" y="10" width="6" height="4" rx="1" fill="currentColor"/>
              </svg>
              TB
            </button>
          </div>
          {/* Stable user-facing views over the same compiler-owned graph. */}
          <div role="group" aria-label="Lineage view" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, marginRight: 4 }}>
            {LINEAGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.types)}
                title={preset.title}
                aria-pressed={activePreset === preset.key}
                style={{
                  padding: '4px 11px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: 5,
                  cursor: 'pointer',
                  fontFamily: t.font,
                  whiteSpace: 'nowrap',
                  background: activePreset === preset.key ? 'var(--accent-dim)' : 'transparent',
                  color: activePreset === preset.key ? t.accent : t.textMuted,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {dimSelId && (
            <>
              <div style={{ flex: 1 }} />
              <button
                onClick={clearDim}
                style={{
                  borderRadius: 7,
                  border: `1px solid ${t.accent}`,
                  background: 'var(--accent-dim)',
                  color: t.accent,
                  cursor: 'pointer',
                  fontSize: 11.5,
                  fontWeight: 650,
                  padding: '5px 11px',
                  whiteSpace: 'nowrap',
                }}
              >
                Show all
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onPaneClick={clearDim}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'var(--bg-canvas)' }}
        >
          {/* Prototype 22px dot grid. */}
          <Background color="var(--border-strong)" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => NODE_TYPE_COLORS[(node.data?.nodeType as string) ?? 'source_table'] ?? 'var(--color-text-tertiary)'}
            maskColor="color-mix(in srgb, var(--color-bg-primary) 55%, transparent)"
            style={{ background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-primary)' }}
          />

          {/* Focus card floats on the viewport (ReactFlow Panel), never on the
              scrolling canvas. Node cards self-label their type in the type
              color and the minimap mirrors it, so there is no legend/chip row. */}
          <Panel position="bottom-left">
            {selectedNode ? (
                <div style={{ width: 264, background: 'var(--color-bg-card)', border: '1px solid var(--color-border-primary)', borderRadius: 11, boxShadow: '0 8px 26px rgba(26,26,26,0.13)', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[selectedNode.type] ?? 'var(--color-text-tertiary)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedNode.name}</span>
                    <button onClick={clearDim} title="Clear focus" style={{ width: 20, height: 20, borderRadius: 5, border: 'none', background: 'none', color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                    {TYPE_TITLES[selectedNode.type] ?? selectedNode.type}
                    {selectedSummary ? ` · ${selectedSummary.incoming} upstream · ${selectedSummary.outgoing} downstream` : ''}
                  </div>
                  {selectedNode.domain ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: 7 }}>Domain: {selectedNode.domain}</div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => { if (selectedNode && selectedNode.id !== focalId) void selectEntity(selectedNode.id); }}
                      disabled={!selectedNode || selectedNode.id === focalId}
                      title={selectedNode?.id === focalId ? 'Already the traced entity' : 'Re-scope lineage to this node'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 650, cursor: selectedNode?.id === focalId ? 'default' : 'pointer', opacity: selectedNode?.id === focalId ? 0.5 : 1 }}
                    >
                      Trace from here
                    </button>
                    <button
                      onClick={() => dispatch({ type: 'OPEN_GLOBAL_AI', autoRun: { text: `Explain the lineage of ${selectedNode.name} — where does it come from and what consumes it?` } })}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--color-border-primary)', background: 'var(--color-bg-card)', color: 'var(--color-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Ask about this
                    </button>
                  </div>
                </div>
              ) : null}
          </Panel>
        </ReactFlow>
      </div>

      {/* Prototype status bar. */}
      <div style={{ height: 28, flexShrink: 0, borderTop: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
        <span>{activePreset === 'custom' ? 'Custom' : LINEAGE_PRESETS.find((preset) => preset.key === activePreset)?.label} lineage of {focalName} · {filteredGraph.nodes.length} nodes · {filteredGraph.edges.length} edges{scopeLoading ? ' · loading…' : ''}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-success)' }} />
          {lineageSourcesLabel(lineageSources)}
        </span>
        <div style={{ flex: 1 }} />
        <span>Click a node to focus its path · click the canvas to clear</span>
      </div>
    </div>
  );
}

// Blocks / Apps / Notebooks picker — tabbed by entity type with a searchable
// list. Shared by the landing card and the toolbar's "Tracing" dropdown.
function EntityPicker({
  t,
  entities,
  activeType,
  onTypeChange,
  query,
  onQueryChange,
  onSelect,
  focalId,
  listHeight,
}: {
  t: Theme;
  entities: LineageNode[];
  activeType: string;
  onTypeChange: (type: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  focalId: string | null;
  listHeight: number;
}) {
  const typesPresent = FOCUSABLE_TYPES.filter((f) => entities.some((e) => e.type === f.type));
  // If the active tab has no entities, fall back to the first populated one.
  const effectiveType = typesPresent.some((f) => f.type === activeType)
    ? activeType
    : (typesPresent[0]?.type ?? activeType);
  const q = query.trim().toLowerCase();
  const list = entities
    .filter((e) => e.type === effectiveType)
    .filter((e) => !q || e.name.toLowerCase().includes(q));
  const activeLabel = FOCUSABLE_TYPES.find((f) => f.type === effectiveType)?.label ?? 'items';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
        {typesPresent.map((f) => {
          const active = f.type === effectiveType;
          const count = entities.filter((e) => e.type === f.type).length;
          return (
            <button
              key={f.type}
              onClick={() => onTypeChange(f.type)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 6, padding: '5px 11px',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font,
                background: active ? 'var(--accent-dim)' : 'transparent', color: active ? t.accent : t.textMuted,
              }}
            >
              {f.label}
              <span style={{ fontSize: 10.5, color: active ? t.accent : t.textMuted, opacity: 0.8 }}>{count}</span>
            </button>
          );
        })}
      </div>

      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={`Search ${activeLabel.toLowerCase()}…`}
        style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: 'var(--color-bg-sunken)', color: t.textPrimary, fontSize: 12, fontFamily: t.font, outline: 'none' }}
      />

      <div style={{ maxHeight: listHeight, overflow: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 8 }}>
        {list.length === 0 ? (
          <div style={{ padding: '14px 12px', fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
            {entities.some((e) => e.type === effectiveType) ? 'No matches.' : `No ${activeLabel.toLowerCase()} in this project yet.`}
          </div>
        ) : (
          list.map((entity, index) => {
            const active = entity.id === focalId;
            return (
              <button
                key={entity.id}
                onClick={() => onSelect(entity.id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
                  padding: '9px 11px', border: 'none', borderTop: index === 0 ? 'none' : `1px solid ${t.headerBorder}`,
                  background: active ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer', fontFamily: t.font,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[entity.type] ?? 'var(--color-text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: active ? 650 : 500, color: t.textPrimary, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entity.name}
                </span>
                {entity.status === 'certified' ? <ShieldCheck size={12} color="var(--status-success)" strokeWidth={2} style={{ flexShrink: 0 }} /> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
