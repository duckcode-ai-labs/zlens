import React, { useEffect, useMemo, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import {
  EDGE_TITLES,
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  type LineageEdge,
  type LineageNode,
} from '../lineage/lineage-constants';

interface FocusedGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  focalNode: LineageNode | null;
}

function displayName(name: string): string {
  return name.replace(/\.(dqlnb|dql)$/i, '');
}

function nodeIdForFile(type: string, name: string): string {
  return `${type}:${displayName(name)}`;
}

export function BusinessArtifactView() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const file = state.activeFile;
  const nodeId = file && (file.type === 'term' || file.type === 'business_view')
    ? nodeIdForFile(file.type, file.name)
    : null;

  const [graph, setGraph] = useState<FocusedGraph>({ nodes: [], edges: [], focalNode: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    api
      .queryLineage({ focus: nodeId, upstreamDepth: 3, downstreamDepth: 3 })
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
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const upstream = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.target === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.source) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const downstream = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.source === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.target) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);

  if (!file || !nodeId) {
    return (
      <div style={{ flex: 1, padding: 24, color: t.textMuted }}>
        Select a business term or business view from Explorer.
      </div>
    );
  }

  const nodeType = focal?.type ?? file.type;
  const color = NODE_TYPE_COLORS[nodeType] ?? t.accent;
  const label = TYPE_LABELS[nodeType] ?? nodeType.toUpperCase();
  const filePath = focal?.metadata?.path ?? focal?.metadata?.filePath ?? file.path;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--color-bg-primary)' }}>
      <div style={{ padding: '22px 28px 18px', borderBottom: `1px solid ${t.headerBorder}`, background: t.appBg }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span
                style={{
                  color: t.appBg,
                  background: color,
                  borderRadius: 5,
                  padding: '3px 7px',
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: 0,
                }}
                title={TYPE_TITLES[nodeType] ?? nodeType}
              >
                {label}
              </span>
              <span style={{ color: t.textMuted, fontSize: 12 }}>
                Lineage · ↑ {upstream.length} · ↓ {downstream.length}
              </span>
            </div>
            <h1 style={{ margin: 0, fontSize: 26, lineHeight: 1.15, color: t.textPrimary }}>
              {focal?.name ?? displayName(file.name)}
            </h1>
            <div style={{ marginTop: 7, color: t.textMuted, fontSize: 13 }}>
              {file.type === 'term'
                ? 'Business definition used by saved queries, views, dashboards, and AI agents.'
                : 'Business composition built from trusted terms, saved queries, and other business views.'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) minmax(420px, 1fr)', gap: 18 }}>
        <section style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          {focal && <MetadataPanel node={focal} t={t} />}
          <ConnectionPanel title="Upstream" connections={upstream} t={t} />
          <ConnectionPanel title="Downstream" connections={downstream} t={t} />
          <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 12, color: t.textMuted, fontSize: 12, background: t.sidebarBg }}>
            <div style={{ fontWeight: 800, color: t.textSecondary, marginBottom: 6 }}>Source file</div>
            <div style={{ overflowWrap: 'anywhere' }}>{String(filePath)}</div>
          </div>
        </section>

        <section
          style={{
            minHeight: 520,
            border: `1px solid ${t.headerBorder}`,
            borderRadius: 8,
            background: t.sidebarBg,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.headerBorder}` }}>
            <div style={{ fontWeight: 800, color: t.textPrimary, fontSize: 14 }}>Focused lineage</div>
            <div style={{ color: t.textMuted, fontSize: 12, marginTop: 3 }}>
              Technical inputs and business composition for this {file.type === 'term' ? 'term' : 'view'}.
            </div>
          </div>
          <div style={{ height: 470, padding: 12 }}>
            {loading ? (
              <div style={{ color: t.textMuted, fontSize: 12 }}>Loading lineage...</div>
            ) : graph.nodes.length === 0 ? (
              <div style={{ color: t.textMuted, fontSize: 12 }}>No lineage available.</div>
            ) : (
              <MiniLineageGraph
                nodes={graph.nodes}
                edges={graph.edges}
                focalNodeId={nodeId}
                height="100%"
                onNodeClick={(clickedId) => {
                  dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: clickedId });
                }}
                interactive
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetadataPanel({ node, t }: { node: LineageNode; t: Theme }) {
  const metadata = node.metadata ?? {};
  const rows: Array<{ label: string; value: string }> = [];

  if (node.domain) rows.push({ label: 'Domain', value: node.domain });
  if (node.owner) rows.push({ label: 'Owner', value: node.owner });
  if (node.status) rows.push({ label: 'Status', value: node.status });
  if (node.type === 'term' && typeof metadata.termType === 'string') rows.push({ label: 'Term Type', value: metadata.termType });
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
  if (typeof metadata.decisionUse === 'string' && metadata.decisionUse.trim()) {
    rows.push({ label: 'Decision Use', value: metadata.decisionUse });
  }
  if (typeof metadata.reviewCadence === 'string' && metadata.reviewCadence.trim()) {
    rows.push({ label: 'Review Cadence', value: metadata.reviewCadence });
  }

  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.sidebarBg, padding: 12 }}>
      <div style={{ fontWeight: 800, color: t.textPrimary, marginBottom: 10 }}>Business metadata</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'grid', gap: 3 }}>
            <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{row.label}</div>
            <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionPanel({
  title,
  connections,
  t,
}: {
  title: string;
  connections: Array<{ edge: LineageEdge; node: LineageNode }>;
  t: Theme;
}) {
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.sidebarBg, padding: 12 }}>
      <div style={{ fontWeight: 800, color: t.textPrimary, marginBottom: 10 }}>{title}</div>
      {connections.length === 0 ? (
        <div style={{ color: t.textMuted, fontSize: 12 }}>No {title.toLowerCase()} connections in this focused window.</div>
      ) : (
        <div style={{ display: 'grid', gap: 7 }}>
          {connections.slice(0, 8).map(({ edge, node }) => {
            const color = NODE_TYPE_COLORS[node.type] ?? t.textMuted;
            return (
              <div key={`${edge.source}-${edge.target}-${edge.type}`} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, minWidth: 0, fontSize: 12 }}>
                <span style={{ color: t.textMuted }}>{EDGE_TITLES[edge.type] ?? edge.type}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      color: t.appBg,
                      background: color,
                      borderRadius: 3,
                      padding: '1px 4px',
                      fontSize: 9,
                      fontWeight: 800,
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
          {connections.length > 8 && (
            <div style={{ color: t.textMuted, fontSize: 12 }}>
              {connections.length - 8} more connection{connections.length - 8 === 1 ? '' : 's'} in the graph
            </div>
          )}
        </div>
      )}
    </div>
  );
}
