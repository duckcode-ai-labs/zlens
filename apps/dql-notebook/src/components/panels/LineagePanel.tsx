import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PanelEmpty } from '@zlens/ui';
import { Briefcase, Database, Monitor, type LucideIcon } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  LAYER_COLORS,
  LAYER_LABELS,
  LAYER_ORDER,
  getNodeLayer,
  type LineageNode,
  type LineageEdge,
  type LineageLayerName,
} from '../lineage/lineage-constants';

function NodeTypeBadge({ type }: { type: string }) {
  const color = NODE_TYPE_COLORS[type] ?? '#8b949e';
  return (
    <span
      style={{
        color,
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        minWidth: 34,
      }}
      title={TYPE_TITLES[type] ?? type}
    >
      {TYPE_LABELS[type] ?? type.slice(0, 4).toUpperCase()}
    </span>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  t: Theme;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%',
        padding: '7px 9px',
        borderRadius: 6,
        border: `1px solid ${t.headerBorder}`,
        background: t.sidebarBg,
        color: t.textPrimary,
        fontSize: 12,
        outline: 'none',
      }}
    />
  );
}

function NodeRow({
  node,
  t,
  onClick,
  secondary,
}: {
  node: LineageNode;
  t: Theme;
  onClick: () => void;
  secondary?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: 6,
        padding: '6px 8px',
        cursor: 'pointer',
        color: t.textPrimary,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <NodeTypeBadge type={node.type} />
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
          }}
          title={node.name}
        >
          {node.name}
        </span>
      </div>
      {(secondary || node.domain) && (
        <div style={{ marginLeft: 40, marginTop: 2, color: t.textMuted, fontSize: 11 }}>
          {secondary ?? node.domain}
        </div>
      )}
    </button>
  );
}

const SECTION_COLLAPSE_THRESHOLD = 30;
const SECTION_EXPAND_CHUNK = 200;

function secondaryForNode(node: LineageNode): string | undefined {
  const metadata = node.metadata ?? {};
  const parts: string[] = [];
  if (node.domain) parts.push(node.domain);
  if (node.type === 'term' && typeof metadata.termType === 'string') parts.push(metadata.termType);
  if (node.owner) parts.push(node.owner);
  if (node.status) parts.push(node.status);
  if (node.type === 'business_view' && typeof metadata.description === 'string') parts.push(metadata.description);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function SummaryCard({
  Icon,
  label,
  value,
  detail,
  t,
}: {
  Icon: LucideIcon;
  label: string;
  value: number;
  detail: string;
  t: Theme;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 6,
        padding: '7px 9px',
        background: t.inputBg,
        minWidth: 0,
      }}
      title={detail}
    >
      <Icon size={14} strokeWidth={1.8} color={t.accent} style={{ flexShrink: 0 }} />
      <div
        style={{
          color: t.textMuted,
          fontSize: 10,
          fontWeight: 800,
          textTransform: 'uppercase',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {label}
      </div>
      <div style={{ marginLeft: 'auto', color: t.textPrimary, fontSize: 15, fontWeight: 800, lineHeight: 1, flexShrink: 0 }}>{value}</div>
    </div>
  );
}

function Section({
  title,
  nodes,
  t,
  onSelect,
  secondaryFor,
}: {
  title: string;
  nodes: LineageNode[];
  t: Theme;
  onSelect: (node: LineageNode) => void;
  secondaryFor?: (node: LineageNode) => string | undefined;
}) {
  const large = nodes.length > SECTION_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!large);
  const [visibleCount, setVisibleCount] = useState(SECTION_EXPAND_CHUNK);

  if (nodes.length === 0) return null;
  const shown = !expanded ? 0 : Math.min(visibleCount, nodes.length);
  const remaining = Math.max(0, nodes.length - shown);

  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${t.headerBorder}` }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px 6px',
          color: t.textMuted,
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-block', width: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span>{title}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 500 }}>{nodes.length}</span>
      </button>
      {expanded &&
        nodes
          .slice(0, shown)
          .map((node) => (
            <NodeRow key={node.id} node={node} t={t} onClick={() => onSelect(node)} secondary={secondaryFor?.(node)} />
          ))}
      {expanded && remaining > 0 && (
        <button
          onClick={() => setVisibleCount((c) => c + SECTION_EXPAND_CHUNK)}
          style={{
            width: '100%',
            margin: '4px 0 0',
            padding: '6px 8px',
            background: 'transparent',
            border: 'none',
            color: t.textMuted,
            fontSize: 11,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          Show {Math.min(SECTION_EXPAND_CHUNK, remaining)} more ({remaining} hidden)
        </button>
      )}
    </div>
  );
}

export function LineagePanel({ variant = 'sidebar' }: { variant?: 'sidebar' | 'page' }) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const page = variant === 'page';
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 700 : false);

  const [loading, setLoading] = useState(true);
  const [allNodes, setAllNodes] = useState<LineageNode[]>([]);
  const [allEdges, setAllEdges] = useState<LineageEdge[]>([]);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Array<{ node: LineageNode; score: number }>>([]);

  const loadLineage = useCallback(async () => {
    setLoading(true);
    const data = await api.fetchLineage();
    setAllNodes(data.nodes ?? []);
    setAllEdges(data.edges ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadLineage();
  }, [loadLineage]);

  useEffect(() => {
    if (!page) return;
    const update = () => setCompactLayout(window.innerWidth < 700);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [page]);

  useEffect(() => {
    let cancelled = false;
    if (search.trim().length < 2) {
      setMatches([]);
      return;
    }
    void api.searchLineage(search.trim()).then((result) => {
      if (!cancelled) setMatches(result.matches ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [search]);

  const handleSelectNode = useCallback((node: LineageNode) => {
    dispatch({ type: 'OPEN_LINEAGE_DETAIL', nodeId: node.id });
  }, [dispatch]);

  const [groupBy, setGroupBy] = useState<'type' | 'layer'>('type');

  const grouped = useMemo(() => ({
    terms: allNodes.filter((node) => node.type === 'term'),
    businessViews: allNodes.filter((node) => node.type === 'business_view'),
    dashboards: allNodes.filter((node) => node.type === 'dashboard'),
    notebooks: allNodes.filter((node) => node.type === 'notebook'),
    apps: allNodes.filter((node) => node.type === 'app'),
    charts: allNodes.filter((node) => node.type === 'chart'),
    blocks: allNodes.filter((node) => node.type === 'block'),
    metrics: allNodes.filter((node) => node.type === 'metric'),
    dimensions: allNodes.filter((node) => node.type === 'dimension'),
    dbtModels: allNodes.filter((node) => node.type === 'dbt_model'),
    dbtSources: allNodes.filter((node) => node.type === 'dbt_source'),
    tables: allNodes.filter((node) => node.type === 'source_table'),
    domains: allNodes.filter((node) => node.type === 'domain'),
  }), [allNodes]);

  const summary = useMemo(() => ({
    businessNodes: grouped.terms.length + grouped.businessViews.length,
    businessEdges: allEdges.filter((edge) => edge.type === 'defines' || edge.type === 'composes').length,
    technicalNodes: grouped.tables.length + grouped.dbtSources.length + grouped.dbtModels.length + grouped.metrics.length + grouped.dimensions.length + grouped.blocks.length,
    consumptionNodes: grouped.charts.length + grouped.notebooks.length + grouped.dashboards.length + grouped.apps.length,
  }), [allEdges, grouped]);

  const layerGrouped = useMemo(() => {
    const groups: Record<LineageLayerName, LineageNode[]> = {
      source: [], transform: [], answer: [], consumption: [],
    };
    for (const node of allNodes) {
      const layer = getNodeLayer(node);
      groups[layer].push(node);
    }
    return groups;
  }, [allNodes]);

  if (loading) {
    return <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>Loading lineage...</div>;
  }

  if (allNodes.length === 0) {
    return (
      <div style={{ height: '100%', background: page ? t.sidebarBg : 'transparent', border: page ? `1px solid ${t.headerBorder}` : 'none', borderRadius: page ? 8 : 0 }}>
        <PanelEmpty
          title="No lineage data"
          description="Run `zlens compile` or add notebooks or saved queries first."
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: page ? t.sidebarBg : 'transparent',
        border: page ? `1px solid ${t.headerBorder}` : 'none',
        borderRadius: page ? 8 : 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search lineage..."
          t={t}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {search.trim().length >= 2 && matches.length > 0 && (
          <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
            <div style={{ color: t.textMuted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>
              Search Results
            </div>
            {matches.slice(0, 8).map((match) => (
              <NodeRow
                key={match.node.id}
                node={match.node}
                t={t}
                onClick={() => handleSelectNode(match.node)}
                secondary={match.node.domain}
              />
            ))}
          </div>
        )}

        <div
          style={{
            padding: '8px 12px',
            display: 'grid',
            gridTemplateColumns: page && !compactLayout ? 'repeat(3, minmax(0, 1fr))' : '1fr',
            gap: 6,
            borderBottom: `1px solid ${t.headerBorder}`,
          }}
        >
          <SummaryCard
            Icon={Briefcase}
            label="Business"
            value={summary.businessNodes}
            detail={`${grouped.terms.length} terms · ${grouped.businessViews.length} views · ${summary.businessEdges} edges`}
            t={t}
          />
          <SummaryCard
            Icon={Database}
            label="Technical"
            value={summary.technicalNodes}
            detail={`${grouped.tables.length} tables · ${grouped.dbtModels.length + grouped.dbtSources.length} dbt · ${grouped.blocks.length} saved queries`}
            t={t}
          />
          <SummaryCard
            Icon={Monitor}
            label="Consumption"
            value={summary.consumptionNodes}
            detail={`${grouped.dashboards.length} dashboards · ${grouped.notebooks.length} notebooks · ${grouped.apps.length} apps`}
            t={t}
          />
        </div>

        {/* Layer summary bar */}
        <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', borderBottom: `1px solid ${t.headerBorder}` }}>
          {LAYER_ORDER.map((layer) => {
            const count = layerGrouped[layer].length;
            if (count === 0) return null;
            return (
              <span key={layer} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: t.textMuted }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: LAYER_COLORS[layer], display: 'inline-block' }} />
                {LAYER_LABELS[layer]}: {count}
              </span>
            );
          })}
          <span style={{ flex: 1 }} />
          {/* Group by toggle */}
          <div style={{ display: 'flex', borderRadius: 4, border: `1px solid ${t.headerBorder}`, overflow: 'hidden' }}>
            <button
              onClick={() => setGroupBy('type')}
              style={{
                padding: '2px 6px', fontSize: 9, fontWeight: 700, border: 'none', cursor: 'pointer',
                background: groupBy === 'type' ? `${t.headerBorder}` : 'transparent',
                color: groupBy === 'type' ? t.textPrimary : t.textMuted,
              }}
            >Type</button>
            <button
              onClick={() => setGroupBy('layer')}
              style={{
                padding: '2px 6px', fontSize: 9, fontWeight: 700, border: 'none', cursor: 'pointer',
                borderLeft: `1px solid ${t.headerBorder}`,
                background: groupBy === 'layer' ? `${t.headerBorder}` : 'transparent',
                color: groupBy === 'layer' ? t.textPrimary : t.textMuted,
              }}
            >Layer</button>
          </div>
        </div>

        {groupBy === 'type' ? (
          <>
            <Section title="Business Terms" nodes={grouped.terms} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Business Views" nodes={grouped.businessViews} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Saved queries" nodes={grouped.blocks} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Metrics" nodes={grouped.metrics} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Dimensions" nodes={grouped.dimensions} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Dashboards" nodes={grouped.dashboards} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Notebooks" nodes={grouped.notebooks} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Apps" nodes={grouped.apps} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Charts" nodes={grouped.charts} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="dbt Models" nodes={grouped.dbtModels} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="dbt Sources" nodes={grouped.dbtSources} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Source Tables" nodes={grouped.tables} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
            <Section title="Business Domains" nodes={grouped.domains} t={t} onSelect={handleSelectNode} secondaryFor={secondaryForNode} />
          </>
        ) : (
          <>
            {LAYER_ORDER.map((layer) => (
              <Section
                key={layer}
                title={LAYER_LABELS[layer]}
                nodes={layerGrouped[layer]}
                t={t}
                onSelect={handleSelectNode}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
