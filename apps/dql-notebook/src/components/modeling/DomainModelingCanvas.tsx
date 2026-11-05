import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, NodeResizeControl, Position, ReactFlow, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import { Link2, Maximize2, Plus } from 'lucide-react';
import type { DbtNodeAuthoringDetail, ManifestDbtFirstModeling, ManifestModelEntity } from '@zlens/core';
import { themes } from '../../themes/notebook-theme';
import { entityKindColor, entityRecords, resolveEntityRecordKey } from './domain-studio-model';
import { relationshipStatusView } from './relationship-builder-model';
import { areaStubs, mapLevel, type AreaStub } from './model-map-levels';
import { MapOverview } from './MapOverview';

export type ColumnDisplayMode = 'keys' | 'relevant' | 'all';
export type ModelingViewMode = 'business' | 'data';
export type DiagramLayoutMode = 'auto' | 'grid' | 'star';
export type DiagramDensity = 'compact' | 'normal' | 'wide';
export type RelationshipDraft = {
  from: string;
  to: string;
  fromColumn?: string;
  toColumn?: string;
};

type Theme = (typeof themes)['dark'];
type EntityNodeData = {
  recordKey: string;
  entity: ManifestModelEntity;
  detail?: DbtNodeAuthoringDetail;
  relation?: string;
  selected: boolean;
  viewMode: ModelingViewMode;
  columnMode: ColumnDisplayMode;
  density: DiagramDensity;
  theme: Theme;
  onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void;
  onResize: (id: string, width: number) => void;
};

export function DomainModelingCanvas({ modeling, ghostEntityIds, ghostRelationshipIds, relationByDbtId, detailsByDbtId, selectedDomain, selectedAreaId, selectedId, viewMode, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, resetLayoutToken, focusRequest, onVisibleDbtIdsChange, onSelectEntity, onSelectRelationship, onEditRelationship, onDraftRelationship, onAddRelatedModel, onAddModel, onCreateDomain, onEditEntity, onOpenAi, onOpenDomain, onOpenArea, theme }: { modeling: ManifestDbtFirstModeling; ghostEntityIds?: ReadonlySet<string>; ghostRelationshipIds?: ReadonlySet<string>; relationByDbtId: Record<string, string | undefined>; detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>; selectedDomain: string | null; selectedAreaId: string | null; selectedId: string | null; viewMode: ModelingViewMode; columnMode: ColumnDisplayMode; search: string; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean; resetLayoutToken: number; focusRequest?: { id: string; token: number }; onVisibleDbtIdsChange: (uniqueIds: string[]) => void; onSelectEntity: (id: string) => void; onSelectRelationship: (id: string) => void; onEditRelationship?: (recordKey: string) => void; onDraftRelationship: (draft: RelationshipDraft) => void; onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void; onAddModel: () => void; onCreateDomain: () => void; onEditEntity: (id: string) => void; onOpenAi: (id: string) => void; onOpenDomain?: (domain: string) => void; onOpenArea?: (areaId: string) => void; theme: Theme }) {
  // The map's zoom level (model-at-scale design S5): a large model opens on
  // its Domains, a Domain on its areas, an area on its tables. "Show every
  // table" draws the tables of the level in view anyway.
  const [showAllAt, setShowAllAt] = useState<string | null>(null);
  const levelKey = selectedDomain ?? '';
  const level = useMemo(() => (showAllAt === levelKey ? { kind: 'tables' as const } : mapLevel(modeling, selectedDomain, selectedAreaId, search)), [modeling, selectedDomain, selectedAreaId, search, showAllAt, levelKey]);
  const layoutKey = `dql-model-layout:${selectedAreaId ?? selectedDomain ?? 'all'}`;
  const sizeKey = `${layoutKey}:sizes`;
  const [savedPositions, setSavedPositions] = useState<Record<string, { x: number; y: number }>>(() => readPositions(layoutKey));
  const [savedSizes, setSavedSizes] = useState<Record<string, number>>(() => readSizes(sizeKey));
  useEffect(() => setSavedPositions(readPositions(layoutKey)), [layoutKey]);
  useEffect(() => setSavedSizes(readSizes(sizeKey)), [sizeKey]);
  useEffect(() => {
    if (!resetLayoutToken) return;
    localStorage.removeItem(layoutKey);
    localStorage.removeItem(sizeKey);
    setSavedPositions({});
    setSavedSizes({});
  }, [resetLayoutToken]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  // Prototype relationship popover: clicking an edge (or its pill label) opens
  // a 316px context card at the pointer with join, cardinality, and proof.
  const [relPopover, setRelPopover] = useState<{ x: number; y: number; recordKey: string } | null>(null);
  const handleResize = (id: string, width: number) => { const next = { ...savedSizes, [id]: Math.round(width) }; setSavedSizes(next); localStorage.setItem(sizeKey, JSON.stringify(next)); };
  const { nodes: graphNodes, edges } = useMemo(() => buildGraph(modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedAreaId, selectedId, viewMode, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, savedPositions, savedSizes, onAddRelatedModel, handleResize, theme, ghostEntityIds, ghostRelationshipIds), [modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedAreaId, selectedId, viewMode, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, savedPositions, savedSizes, onAddRelatedModel, theme, ghostEntityIds, ghostRelationshipIds]);
  // An area's joins into areas it does not draw, folded into one stub per area.
  const stubs = useMemo<AreaStub[]>(() => (selectedAreaId && level.kind === 'tables' ? areaStubs(modeling, selectedAreaId, new Set(graphNodes.map((node) => node.id))) : []), [modeling, selectedAreaId, level.kind, graphNodes]);
  const flowNodes = useMemo(() => {
    if (!stubs.length) return graphNodes as Node[];
    const right = Math.max(0, ...graphNodes.map((node) => node.position.x)) + 460;
    return [...graphNodes, ...stubs.map((stub, index): Node => ({ id: stub.id, type: 'stub', position: { x: right, y: index * 110 }, data: { stub, theme }, draggable: true, connectable: false }))];
  }, [graphNodes, stubs, theme]);
  const flowEdges = useMemo(() => (stubs.length ? [...edges, ...stubs.flatMap((stub) => stub.from.map((from): Edge => ({ id: `${stub.id}:${from}`, source: from, target: stub.id, type: 'smoothstep', style: { strokeDasharray: '5 5', stroke: 'var(--border-strong)' }, markerEnd: { type: MarkerType.ArrowClosed } })))] : edges), [edges, stubs]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  useEffect(() => setNodes(flowNodes), [flowNodes, setNodes]);
  const visibleDbtIds = level.kind === 'tables' ? graphNodes.map((node) => (node.data as EntityNodeData).entity.dbtUniqueId) : [];
  const visibleDbtKey = visibleDbtIds.join('|');
  useEffect(() => onVisibleDbtIdsChange(visibleDbtIds), [onVisibleDbtIdsChange, visibleDbtKey]);
  if (level.kind !== 'tables') {
    return (
      <MapOverview
        level={level}
        theme={theme}
        onOpenDomain={(domain) => onOpenDomain?.(domain)}
        onOpenArea={(areaId) => (areaId ? onOpenArea?.(areaId) : setShowAllAt(levelKey))}
        onShowAll={() => setShowAllAt(levelKey)}
      />
    );
  }
  if (!graphNodes.length)
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          placeItems: 'center',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 12,
          height: '100%',
          color: theme.textMuted,
        }}
      >
        <strong style={{ color: theme.textPrimary }}>{search.trim() ? `No models or columns match “${search.trim()}”.` : 'Start your model'}</strong>
        {!search.trim() && <><span>Add a dbt model, then connect its columns to define governed analytical relationships.</span><div style={{ display: 'flex', gap: 8 }}><button onClick={onCreateDomain} style={emptyAction(theme)}><Plus size={13} /> Create domain</button><button onClick={onAddModel} style={emptyAction(theme, true)}><Link2 size={13} /> Add models</button></div></>}
      </div>
    );
  const handleConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    onDraftRelationship({
      from: connection.source,
      to: connection.target,
      fromColumn: parseColumnHandle(connection.sourceHandle),
      toColumn: parseColumnHandle(connection.targetHandle),
    });
  };
  const popoverRelationship = relPopover ? modeling.relationships[relPopover.recordKey] : undefined;
  return (
    <div style={{ height: '100%', position: 'relative' }} onClick={() => { setContextMenu(null); setRelPopover(null); }}>
    <style>{MODELING_CANVAS_STYLES}</style>
    <ReactFlow key={`${layoutMode}:${density}:${visibleLimit}:${resetLayoutToken}:${search}`} nodes={nodes} edges={flowEdges} onNodesChange={onNodesChange} nodeTypes={{ entity: EntityNode, stub: StubNode }} fitView fitViewOptions={{ padding: 0.16 }} minZoom={0.2} maxZoom={1.8} nodesDraggable nodesConnectable onConnect={handleConnect} onNodeDragStop={(_, node) => { const next = { ...savedPositions, [node.id]: node.position }; setSavedPositions(next); localStorage.setItem(layoutKey, JSON.stringify(next)); }} onNodeClick={(_, node) => { if (node.type === 'stub') { const stub = (node.data as { stub: AreaStub }).stub; if (stub.areaId) onOpenArea?.(stub.areaId); else onOpenDomain?.(stub.domain); return; } onSelectEntity(node.id); }} onNodeDoubleClick={(_, node) => { if (node.type !== 'stub') onEditEntity(node.id); }} onNodeContextMenu={(event, node) => { event.preventDefault(); if (node.type !== 'stub') setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id }); }} onEdgeClick={(event, edge) => { event.stopPropagation(); onSelectRelationship(edge.id); setRelPopover({ x: Math.min(event.clientX, window.innerWidth - 340), y: Math.min(event.clientY, window.innerHeight - 320), recordKey: edge.id }); }} colorMode={theme.appBg.toLowerCase().includes('0') ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}>
      {/* Pans/zooms to a model picked from the toolbar search. */}
      <FocusController focusRequest={focusRequest} />
      {/* Fits the view again when the map opens another Domain or area. */}
      <FitViewController fitKey={`${selectedDomain ?? ''}|${selectedAreaId ?? ''}|${flowNodes.length}`} />
      {/* Prototype dot grid: 22px spacing on the Paper canvas. */}
      <Background color="var(--border-strong)" gap={22} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => domainColor(String((node.data as Partial<EntityNodeData>).entity?.domain ?? (node.data as { stub?: AreaStub }).stub?.domain ?? ''))} maskColor={`${theme.appBg}bb`} />
    </ReactFlow>
    {contextMenu && <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 50, width: 178, border: `1px solid ${theme.headerBorder}`, borderRadius: 7, background: theme.cellBg, boxShadow: '0 12px 32px #0004', padding: 4 }} onClick={(event) => event.stopPropagation()}><MenuAction label="Inspect model" onClick={() => { onSelectEntity(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Edit model" onClick={() => { onEditEntity(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Ask about this model" onClick={() => { onOpenAi(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Start relationship" onClick={() => { onDraftRelationship({ from: contextMenu.nodeId, to: '' }); setContextMenu(null); }} theme={theme} /></div>}
    {relPopover && popoverRelationship && (
      <RelationshipPopover
        relationship={popoverRelationship}
        entities={modeling.entities}
        x={relPopover.x}
        y={relPopover.y}
        theme={theme}
        onClose={() => setRelPopover(null)}
        onEdit={onEditRelationship ? () => { onEditRelationship(relPopover.recordKey); setRelPopover(null); } : undefined}
        onViewProof={() => { onSelectRelationship(relPopover.recordKey); setRelPopover(null); }}
      />
    )}
    </div>
  );
}

// Prototype (Domain Studio Redesign) relationship popover: 316px card at the
// click point — title + proof badge, from ⇄ to chips with cardinality, the
// join in a mono box, business context, proof status, Edit / View join proof.
function RelationshipPopover({ relationship, entities, x, y, theme, onClose, onEdit, onViewProof }: {
  relationship: ManifestDbtFirstModeling['relationships'][string];
  entities: ManifestDbtFirstModeling['entities'];
  x: number;
  y: number;
  theme: Theme;
  onClose: () => void;
  onEdit?: () => void;
  onViewProof: () => void;
}) {
  const status = relationshipStatusView(relationship);
  const joinLabel = relationship.keys.map((key) => `${key.from} = ${key.to}`).join(' and ') || 'No join keys declared';
  // Chips read as friendly entity names, not raw "domain::entity::id" keys.
  const nameOf = (ref: string) => {
    const entity = entities[ref] ?? Object.values(entities).find((item) => item.id === ref || item.localId === ref);
    return entity?.businessName || entity?.localId || ref.split('::').pop() || ref;
  };
  const chip = (label: string) => (
    <span style={{ padding: '3px 8px', borderRadius: 6, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid rgba(107,93,211,0.2)', fontFamily: theme.fontMono, fontSize: 11.5, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
  );
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{ position: 'fixed', left: x, top: y, zIndex: 60, width: 316, background: theme.cellBg, border: `1px solid ${theme.headerBorder}`, borderRadius: 12, boxShadow: '0 12px 34px rgba(26,26,26,0.16)', overflow: 'hidden', fontFamily: theme.font }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)' }}>
        <Link2 size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{relationship.localId}</span>
        <span style={{ flexShrink: 0, border: `1px solid ${status.color}`, color: status.color, borderRadius: 999, padding: '2px 8px', fontSize: 9.5, fontWeight: 700 }}>{status.label}</span>
        <button type="button" onClick={onClose} title="Close" style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 5, border: 'none', background: 'none', color: theme.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>×</button>
      </div>
      <div style={{ padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
          {chip(nameOf(relationship.from))}
          <span style={{ color: theme.textMuted, fontSize: 10.5, fontWeight: 650, whiteSpace: 'nowrap' }}>{relationship.cardinality.replace(/_/g, ' ')}</span>
          {chip(nameOf(relationship.to))}
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: theme.textMuted, marginBottom: 4 }}>Join</div>
          <div style={{ fontSize: 11, fontFamily: theme.fontMono, color: theme.textPrimary, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '7px 9px', overflowWrap: 'anywhere' }}>{joinLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: theme.textMuted, marginBottom: 4 }}>Business context</div>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: theme.textSecondary }}>
            {relationship.description || `${relationship.from} ${relationship.verb ?? 'relates to'} ${relationship.to}. Add a business description so agents can pick this route with confidence.`}
          </div>
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.5, color: theme.textSecondary }}>{status.meaning}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onEdit ? (
            <button type="button" onClick={onEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 27, padding: '0 11px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11.5, fontWeight: 650, cursor: 'pointer', fontFamily: theme.font }}>Edit relationship</button>
          ) : null}
          <button type="button" onClick={onViewProof} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 27, padding: '0 11px', borderRadius: 7, border: `1px solid ${theme.headerBorder}`, background: theme.cellBg, color: theme.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: theme.font }}>View details</button>
        </div>
      </div>
    </div>
  );
}

// Prototype (Domain Studio Redesign) entity card: kind-square header with a
// mono name + uppercase kind, business view = description + owner/grain pills,
// data view = ER column rows with PK/FK glyphs. Handles/resize/plus preserved.
/** A stub for an area's joins into another area: "Finance › Revenue · 4 joins", which opens that area. */
function StubNode({ data }: NodeProps<Node<{ stub: AreaStub; theme: Theme }>>) {
  const { stub, theme } = data;
  return (
    <div title={`Open ${stub.label.split(' · ')[0]}`} style={{ minWidth: 190, maxWidth: 260, border: '1.5px dashed var(--border-strong)', borderRadius: 10, background: theme.cellBg, padding: '10px 12px', cursor: 'pointer' }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <b style={{ display: 'block', fontSize: 12, color: theme.textPrimary }}>→ {stub.label}</b>
      <small style={{ color: theme.textMuted, fontSize: 10.5 }}>In another area. Click to open it.</small>
    </div>
  );
}

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  const { recordKey, entity, detail, relation, selected, viewMode, columnMode, density, theme, onAddRelatedModel, onResize } = data;
  const [collapsed, setCollapsed] = useState(density === 'compact');
  const color = domainColor(entity.domain);
  const kindColor = entityKindColor(entity.analyticalRole);
  const kindLabel = entity.analyticalRole && entity.analyticalRole !== 'unknown' ? entity.analyticalRole : 'entity';
  const columns = detail?.columns ?? [];
  const keys = new Set(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? []));
  const fkColumns = new Set(columns.filter((column) => !keys.has(column.name) && /(^|_)id$/.test(column.name)).map((column) => column.name));
  const visibleColumns = collapsed || viewMode === 'business' ? [] : columnMode === 'all' ? columns.slice(0, 16) : columnMode === 'keys' ? columns.filter((column) => keys.has(column.name)).slice(0, 10) : columns.filter((column) => keys.has(column.name) || column.tests.length > 0).slice(0, 10);
  const concepts = entity.conceptRefs?.length ? entity.conceptRefs.join(', ') : titleCase(entity.localId ?? entity.id);
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 236,
        borderRadius: 10,
        overflow: 'visible',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        boxShadow: selected ? '0 1px 6px rgba(107,93,211,0.14)' : '0 1px 4px rgba(26,26,26,0.05)',
        background: theme.cellBg,
        color: theme.textPrimary,
      }}
    >
      <NodeResizeControl position="bottom-right" resizeDirection="horizontal" minWidth={240} maxWidth={620} onResizeEnd={(_, params) => onResize(recordKey, params.width)} style={{ width: 16, height: 16, border: 0, background: 'transparent', color: theme.textMuted }}><span title="Drag to resize model" style={{ display: 'grid', placeItems: 'center' }}><Maximize2 size={12} /></span></NodeResizeControl>
      {collapsed && viewMode === 'data' && <Handle className="dql-modeling-handle" id="entity-target" type="target" position={Position.Left} style={handleStyle(color)} />}
      <button className="nodrag" title="Add a related model" onClick={(event) => { event.stopPropagation(); onAddRelatedModel({ from: recordKey }); }} style={{ position: 'absolute', right: -9, top: -9, zIndex: 5, width: 22, height: 22, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 999, border: `2px solid ${theme.cellBg}`, background: 'var(--accent)', color: '#fff', cursor: 'pointer', boxShadow: '0 1px 4px rgba(107,93,211,0.3)' }}><Plus size={12} /></button>
      {/* header: kind square · mono name · KIND */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)', borderRadius: '8.5px 8.5px 0 0' }}>
        <span style={{ width: 8, height: 8, borderRadius: 2.5, background: kindColor, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: theme.textPrimary, fontFamily: theme.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {viewMode === 'business' ? entity.businessName || titleCase(entity.localId ?? entity.id) : (entity.localId ?? entity.id)}
        </span>
        <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: kindColor }}>{kindLabel}</span>
        {viewMode === 'data' && <button className="nodrag" title={collapsed ? 'Expand columns' : 'Collapse columns'} onClick={(event) => { event.stopPropagation(); setCollapsed((value) => !value); }} style={{ border: 0, background: 'transparent', color: theme.textMuted, cursor: 'pointer', padding: 0, flexShrink: 0 }}>{collapsed ? '▾' : '▴'}</button>}
      </div>
      {viewMode === 'business' ? (
        <>
          <div title={entity.businessContext} style={{ padding: '9px 12px 7px', fontSize: 11.5, lineHeight: 1.5, color: theme.textSecondary, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {entity.businessContext || concepts}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px', flexWrap: 'wrap' }}>
            {entity.owner ? <span style={{ fontSize: 10, color: theme.textMuted, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', borderRadius: 999, padding: '2px 7px' }}>{entity.owner}</span> : null}
            <span style={{ fontSize: 10, color: theme.textMuted, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', borderRadius: 999, padding: '2px 7px' }}>
              {entity.grain ? `1 row = ${entity.grain}` : entity.domain}
            </span>
          </div>
        </>
      ) : null}
      {visibleColumns.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            maxHeight: 242,
            overflow: 'auto',
          }}
        >
          {visibleColumns.map((column) => (
            <div
              key={column.name}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '4px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 11,
              }}
            >
              <Handle className="dql-modeling-handle" id={`target:${column.name}`} type="target" position={Position.Left} style={{ ...handleStyle(color), top: '50%' }} />
              <span style={{ flexShrink: 0, width: 17, fontSize: 8.5, fontWeight: 700, fontFamily: theme.fontMono, color: keys.has(column.name) ? 'var(--pk)' : fkColumns.has(column.name) ? 'var(--fk)' : 'transparent' }}>
                {keys.has(column.name) ? 'PK' : fkColumns.has(column.name) ? 'FK' : '·'}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: theme.textSecondary, fontFamily: theme.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: keys.has(column.name) ? 700 : 500 }}>{column.name}</span>
              <span style={{ flexShrink: 0, fontSize: 9.5, color: theme.textMuted, fontFamily: theme.fontMono }}>{column.type ?? ''}</span>
              <Handle className="dql-modeling-handle" id={`source:${column.name}`} type="source" position={Position.Right} style={{ ...handleStyle(color), top: '50%' }} />
            </div>
          ))}
          {columns.length > visibleColumns.length && (
            <div
              style={{
                padding: '6px 12px',
                color: theme.textMuted,
                fontSize: 9,
              }}
            >
              + {columns.length - visibleColumns.length} more dbt-owned columns
            </div>
          )}
        </div>
      )}
      {(collapsed || viewMode === 'business') && <><Handle className="dql-modeling-handle" id="entity-target" type="target" position={Position.Left} style={handleStyle(color)} /><Handle className="dql-modeling-handle" id="entity-source" type="source" position={Position.Right} style={handleStyle(color)} /></>}
    </div>
  );
}

function buildGraph(modeling: ManifestDbtFirstModeling, relationByDbtId: Record<string, string | undefined>, detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>, selectedDomain: string | null, selectedAreaId: string | null, selectedId: string | null, viewMode: ModelingViewMode, columnMode: ColumnDisplayMode, search: string, layoutMode: DiagramLayoutMode, density: DiagramDensity, visibleLimit: number, dimUnrelated: boolean, showEdgeLabels: boolean, savedPositions: Record<string, { x: number; y: number }>, savedSizes: Record<string, number>, onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void, onResize: (id: string, width: number) => void, theme: Theme, ghostEntityIds?: ReadonlySet<string>, ghostRelationshipIds?: ReadonlySet<string>): { nodes: Node<EntityNodeData>[]; edges: Edge[] } {
  const selectedArea = selectedAreaId ? modeling.areas[selectedAreaId] : undefined;
  const areaEntityIds = new Set(selectedArea ? [...selectedArea.entityIds, ...selectedArea.referencedEntityIds] : []);
  const visibleRelationships = Object.entries(modeling.relationships).flatMap(([recordKey, relationship]) => {
    const from = resolveEntityRecordKey(modeling, relationship.from);
    const to = resolveEntityRecordKey(modeling, relationship.to);
    return from && to ? [{ recordKey, relationship, from, to }] : [];
  }).filter(({ recordKey, from, to }) => {
    if (selectedArea) return selectedArea.relationshipIds.includes(recordKey);
    if (!selectedDomain) return true;
    return modeling.entities[from]?.domain === selectedDomain || modeling.entities[to]?.domain === selectedDomain;
  });
  const relatedIds = new Set(visibleRelationships.flatMap(({ from, to }) => [from, to]));
  const normalizedSearch = search.trim().toLowerCase();
  let entities = entityRecords(modeling).filter(({ recordKey, entity }) => {
    if (selectedArea && !areaEntityIds.has(recordKey) && !relatedIds.has(recordKey)) return false;
    if (selectedDomain && entity.domain !== selectedDomain && !relatedIds.has(recordKey)) return false;
    if (!normalizedSearch) return true;
    const detail = detailsByDbtId[entity.dbtUniqueId];
    return [recordKey, entity.id, entity.qualifiedId, entity.domain, detail?.relation, ...(detail?.columns.map((column) => column.name) ?? [])].some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch));
  });
  // Enterprise manifests can contain thousands of entities. The canvas is a
  // focused workspace, not a catalog renderer: keep the graph bounded and use
  // search/areas to choose which neighborhood is drawn.
  const effectiveVisibleLimit = Math.min(200, visibleLimit > 0 ? visibleLimit : 50);
  if (entities.length > effectiveVisibleLimit) {
    const degree = new Map<string, number>();
    for (const relationship of visibleRelationships) { degree.set(relationship.from, (degree.get(relationship.from) ?? 0) + 1); degree.set(relationship.to, (degree.get(relationship.to) ?? 0) + 1); }
    entities = [...entities].sort((a, b) => {
      if (a.recordKey === selectedId) return -1;
      if (b.recordKey === selectedId) return 1;
      return (degree.get(b.recordKey) ?? 0) - (degree.get(a.recordKey) ?? 0) || a.recordKey.localeCompare(b.recordKey);
    }).slice(0, effectiveVisibleLimit);
  }
  const domains = [...new Set(entities.map(({ entity }) => entity.domain))].sort();
  const nodes: Node<EntityNodeData>[] = [];
  domains.forEach((domain, domainIndex) =>
    entities
      .filter(({ entity }) => entity.domain === domain)
      .sort((a, b) => a.recordKey.localeCompare(b.recordKey))
      .forEach(({ recordKey, entity }, index) => {
        const detail = detailsByDbtId[entity.dbtUniqueId];
        const columnCount = viewMode === 'business' ? 0 : visibleColumnCount(entity, detail, columnMode);
        const width = savedSizes[recordKey] ?? autoNodeWidth(entity, detail, relationByDbtId[entity.dbtUniqueId], density);
        nodes.push({
          id: recordKey,
          type: 'entity',
          position: { x: domainIndex * 390, y: index * 190 },
          data: {
            recordKey,
            entity,
            detail,
            relation: relationByDbtId[entity.dbtUniqueId],
            selected: selectedId === recordKey,
            viewMode,
            columnMode,
            density,
            theme,
            onAddRelatedModel,
            onResize,
          },
          style: {
            width,
            height: 116 + columnCount * 29,
            // A proposed model is outlined, not filled: visibly part of the
            // diagram, visibly not yet saved.
            ...(ghostEntityIds?.has(recordKey)
              ? { outline: '2px dashed var(--accent)', outlineOffset: 2, opacity: 0.9, borderRadius: 12 }
              : {}),
          },
        });
      }),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = visibleRelationships
    .filter(({ from, to }) => nodeIds.has(from) && nodeIds.has(to))
    .map(({ recordKey, relationship, from, to }) => {
      // The edge shows the same status the legend and inspector name.
      const color = relationshipStatusView(relationship).color;
      const keyLabel = relationship.keys.map((key) => `${key.from} → ${key.to}`).join(', ');
      const firstKey = relationship.keys[0];
      const fromEntity = modeling.entities[from];
      const toEntity = modeling.entities[to];
      const fromColumns = fromEntity ? visibleColumnNames(fromEntity, detailsByDbtId[fromEntity.dbtUniqueId], columnMode) : new Set<string>();
      const toColumns = toEntity ? visibleColumnNames(toEntity, detailsByDbtId[toEntity.dbtUniqueId], columnMode) : new Set<string>();
      // Prototype edge pill reads as a short business phrase ("placed by · N:1");
      // the join keys and fanout live in the relationship popover, not the label.
      const verbLabel = relationship.verb?.trim();
      const label = verbLabel || keyLabel;
      const isGhost = ghostRelationshipIds?.has(recordKey) ?? false;
      return {
        id: recordKey,
        source: from,
        target: to,
        // Business view renders only entity-level handles, so column handles would make ReactFlow drop the edge.
        sourceHandle: viewMode === 'data' && firstKey && fromColumns.has(firstKey.from) ? `source:${firstKey.from}` : undefined,
        targetHandle: viewMode === 'data' && firstKey && toColumns.has(firstKey.to) ? `target:${firstKey.to}` : undefined,
        type: 'default',
        label: showEdgeLabels ? `${label} · ${cardinalitySymbol(relationship.cardinality)}${isGhost ? ' · proposed' : ''}` : undefined,
        animated: isGhost,
        markerEnd: { type: MarkerType.ArrowClosed, color: isGhost || selectedId === recordKey ? 'var(--accent)' : color },
        // Edges take their status color; the selected edge turns accent. A
        // proposed edge is dashed and translucent so it reads as pending
        // review rather than as part of the committed model.
        style: {
          stroke: isGhost || selectedId === recordKey ? 'var(--accent)' : color,
          strokeWidth: selectedId === recordKey ? 2 : 1.5,
          cursor: 'pointer',
          ...(isGhost ? { strokeDasharray: '6 4', opacity: 0.85 } : {}),
        },
        labelStyle: {
          fill: selectedId === recordKey ? 'var(--accent)' : theme.textSecondary,
          fontSize: 10.5,
          fontWeight: 650,
          cursor: 'pointer',
        },
        labelBgStyle: { fill: theme.cellBg, fillOpacity: 1, stroke: selectedId === recordKey ? 'var(--accent)' : theme.headerBorder, strokeWidth: 1 },
        labelBgPadding: [9, 4] as [number, number],
        labelBgBorderRadius: 999,
      };
    });
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    ranksep: density === 'compact' ? 90 : density === 'wide' ? 190 : 135,
    nodesep: density === 'compact' ? 35 : density === 'wide' ? 90 : 60,
    marginx: 35,
    marginy: 35,
  });
  // Tables with no join on the map would all land in one rank, a single tall
  // column (an area of 47 tables and a few joins): the joined ones are laid
  // out as a graph, and the rest go in a grid beside them.
  const joined = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const isolated = layoutMode === 'auto' ? nodes.filter((node) => !joined.has(node.id)) : [];
  const isolatedIds = new Set(isolated.map((node) => node.id));
  nodes.filter((node) => !isolatedIds.has(node.id)).forEach((node) =>
    graph.setNode(node.id, {
      width: Number(node.style?.width ?? baseNodeWidth(density)),
      height: Number(node.style?.height ?? 100),
    }),
  );
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  if (layoutMode === 'auto') Dagre.layout(graph);
  const graphRight = Math.max(0, ...nodes.filter((node) => !isolatedIds.has(node.id)).map((node) => {
    const p = graph.node(node.id) as { x: number } | undefined;
    return p ? p.x + Number(node.style?.width ?? baseNodeWidth(density)) / 2 : 0;
  }));
  const isolatedColumns = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
  nodes.forEach((node) => {
    const saved = savedPositions[node.id];
    if (saved) { node.position = saved; return; }
    if (isolatedIds.has(node.id)) { const index = isolated.indexOf(node); node.position = { x: graphRight + 140 + (index % isolatedColumns) * 340, y: Math.floor(index / isolatedColumns) * 240 }; return; }
    if (layoutMode === 'grid') { const index = nodes.indexOf(node); const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length))); node.position = { x: (index % cols) * 360, y: Math.floor(index / cols) * 260 }; return; }
    if (layoutMode === 'star') { const index = nodes.indexOf(node); if (index === 0) { node.position = { x: 0, y: 0 }; return; } const angle = ((index - 1) / Math.max(1, nodes.length - 1)) * Math.PI * 2; node.position = { x: Math.cos(angle) * 460, y: Math.sin(angle) * 330 }; return; }
    const p = graph.node(node.id) as { x: number; y: number } | undefined;
    if (p)
      node.position = {
        x: p.x - Number(node.style?.width ?? baseNodeWidth(density)) / 2,
        y: p.y - Number(node.style?.height ?? 100) / 2,
      };
  });
  if (dimUnrelated && selectedId && modeling.entities[selectedId]) {
    const connected = new Set<string>([selectedId]);
    for (const relationship of visibleRelationships) { if (relationship.from === selectedId) connected.add(relationship.to); if (relationship.to === selectedId) connected.add(relationship.from); }
    for (const node of nodes) node.style = { ...node.style, opacity: connected.has(node.id) ? 1 : 0.18, transition: 'opacity 160ms ease' };
  }
  return { nodes, edges };
}

function cardinalitySymbol(value: string): string { return value === 'one_to_one' ? '1:1' : value === 'one_to_many' ? '1:N' : value === 'many_to_one' ? 'N:1' : value === 'many_to_many' ? 'N:N' : '?'; }
// Centers the viewport on the model chosen from the toolbar search dropdown.
/**
 * The view fits once when the canvas first appears; a new Domain or area
 * brings other tables, so it fits again once they are placed (otherwise the
 * view stays on where the last level's tables were).
 */
function FitViewController({ fitKey }: { fitKey: string }) {
  const flow = useReactFlow();
  useEffect(() => {
    const timer = window.setTimeout(() => void flow.fitView({ padding: 0.16, duration: 250 }), 80);
    return () => window.clearTimeout(timer);
  }, [fitKey, flow]);
  return null;
}

function FocusController({ focusRequest }: { focusRequest?: { id: string; token: number } }) {
  const flow = useReactFlow();
  const lastToken = useRef(-1);
  useEffect(() => {
    if (!focusRequest || focusRequest.token === lastToken.current) return;
    lastToken.current = focusRequest.token;
    // Let the graph settle (search clearing can remount nodes) before centering.
    const timer = window.setTimeout(() => {
      const node = flow.getNode(focusRequest.id);
      if (!node) return;
      const width = Number(node.measured?.width ?? node.width ?? node.style?.width ?? 280);
      const height = Number(node.measured?.height ?? node.height ?? node.style?.height ?? 120);
      flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: Math.max(0.85, flow.getZoom()), duration: 500 });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [focusRequest, flow]);
  return null;
}

function MenuAction({ label, onClick, theme }: { label: string; onClick: () => void; theme: Theme }) { return <button onClick={onClick} style={{ width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '7px 8px', background: 'transparent', color: theme.textPrimary, fontSize: 11, cursor: 'pointer' }}>{label}</button>; }

function visibleColumnCount(entity: ManifestModelEntity, detail: DbtNodeAuthoringDetail | undefined, mode: ColumnDisplayMode): number {
  return visibleColumnNames(entity, detail, mode).size;
}

function visibleColumnNames(entity: ManifestModelEntity, detail: DbtNodeAuthoringDetail | undefined, mode: ColumnDisplayMode): Set<string> {
  const columns = detail?.columns ?? [];
  if (mode === 'all') return new Set(columns.slice(0, 16).map((column) => column.name));
  const keys = new Set(entity.keys.length ? entity.keys : detail?.dqlMeta?.keys ?? []);
  if (mode === 'keys') return new Set(columns.filter((column) => keys.has(column.name)).slice(0, 10).map((column) => column.name));
  return new Set(columns.filter((column) => keys.has(column.name) || column.tests.length > 0).slice(0, 10).map((column) => column.name));
}

function baseNodeWidth(density: DiagramDensity): number { return density === 'compact' ? 250 : density === 'wide' ? 340 : 280; }
function autoNodeWidth(entity: ManifestModelEntity, detail: DbtNodeAuthoringDetail | undefined, relation: string | undefined, density: DiagramDensity): number {
  const longest = Math.max(titleCase(entity.localId ?? entity.id).length, relation?.length ?? 0, detail?.description?.length ?? 0, ...((detail?.columns ?? []).map((column) => column.name.length)));
  return Math.min(density === 'wide' ? 440 : 380, baseNodeWidth(density) + Math.max(0, longest - 34) * 2);
}

function readPositions(key: string): Record<string, { x: number; y: number }> {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, { x?: unknown; y?: unknown }>; return Object.fromEntries(Object.entries(value).filter(([, point]) => typeof point.x === 'number' && typeof point.y === 'number')) as Record<string, { x: number; y: number }>; }
  catch { return {}; }
}

function readSizes(key: string): Record<string, number> {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(value).filter(([, width]) => typeof width === 'number' && width >= 240 && width <= 620)) as Record<string, number>; }
  catch { return {}; }
}

function parseColumnHandle(handle: string | null): string | undefined {
  return handle?.includes(':') ? handle.slice(handle.indexOf(':') + 1) : undefined;
}
function handleStyle(color: string): React.CSSProperties {
  return { background: color, border: '2px solid var(--color-bg-card)', width: 9, height: 9, cursor: 'crosshair' };
}
// Connection handles stay hidden for a clean ER view and fade in only when the
// node is hovered — matching the prototype's dot-free tables.
const MODELING_CANVAS_STYLES = `
.dql-modeling-handle { opacity: 0; transition: opacity 0.12s ease; }
.react-flow__node:hover .dql-modeling-handle,
.dql-modeling-handle.connecting,
.dql-modeling-handle:hover { opacity: 1; }
`;
function emptyAction(theme: Theme, primary = false): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${primary ? theme.accent : theme.headerBorder}`, borderRadius: 6, padding: '7px 10px', color: primary ? theme.accent : theme.textSecondary, background: primary ? `${theme.accent}12` : theme.cellBg, cursor: 'pointer', fontSize: 11, fontWeight: 650 };
}
function titleCase(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
function domainColor(domain: string): string {
  const colors = ['#6d5ce7', '#2e9b63', '#d47822', '#377cc8', '#bd4f8b', '#8a6d3b'];
  let hash = 0;
  for (const char of domain) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}
