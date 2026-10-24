import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelFrame } from '@zlens/ui';
import {
  api,
  DqlApiError,
  type SemanticRuntimePathCandidate,
  type SemanticRuntimeTrace,
} from '../../api/client';
import { insertSemanticReference, serializeSemanticDragRef } from '../../editor/semantic-completions';
import { makeCell, useNotebook } from '../../store/NotebookStore';
import type {
  ExecutionTarget,
  QueryResult,
  SemanticLayerDiagnostics,
  SemanticObjectDetail,
  SemanticTreeNode,
} from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { MetricDetailPanel } from './MetricDetailPanel';
import { SemanticSearchBar } from './SemanticSearchBar';
import { SemanticTreeNode as TreeRow } from './SemanticTreeNode';
import { SetupWizard } from '../modals/SetupWizard';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import { buildNotebookSemanticBlock } from './semantic-notebook-source';

function PanelSectionHeader({ label, count, t }: { label: string; count?: number; t: Theme }) {
  return (
    <div
      style={{
        padding: '8px 10px 4px',
        fontSize: 10,
        fontWeight: 700,
        color: t.textMuted,
        fontFamily: t.font,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      {label}
      {typeof count === 'number' ? ` · ${count}` : ''}
    </div>
  );
}

const PROVIDER_CARDS = [
  { id: 'dbt' as const, label: 'dbt', color: '#ff694a', desc: 'Import semantic models, metrics, and dimensions' },
  { id: 'cubejs' as const, label: 'Cube.js', color: '#7a77ff', desc: 'Import cubes, measures, joins, and pre-aggregations' },
  { id: 'snowflake' as const, label: 'Snowflake', color: '#29b5e8', desc: 'Introspect semantic views for metrics and dimensions' },
];

type SemanticDiagnosticIssue = NonNullable<SemanticLayerDiagnostics['issues']>[number];

function SetupState({
  t,
  provider,
  diagnostics,
  errors,
  onOpenWizard,
  onRefresh,
}: {
  t: Theme;
  provider: string | null;
  diagnostics?: SemanticLayerDiagnostics | null;
  errors?: string[];
  onOpenWizard: () => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px', fontFamily: t.font }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.textPrimary, marginBottom: 4 }}>
        Connect your Semantic Layer
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
        Import metrics and dimensions from your existing data stack to build certified saved queries.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {PROVIDER_CARDS.map((p) => {
          const isDetected = provider === p.id;
          return (
            <button key={p.id} onClick={onOpenWizard} style={{
              background: t.inputBg,
              border: `1px solid ${isDetected ? p.color : t.cellBorder}`,
              borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
              textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
              transition: 'border-color 0.15s',
            }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: p.color, flexShrink: 0,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                    {p.label}
                  </span>
                  {isDetected && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, color: p.color, fontFamily: t.font,
                      background: `${p.color}18`, padding: '1px 6px', borderRadius: 6,
                    }}>Detected</span>
                  )}
                </div>
                <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{p.desc}</span>
              </div>
            </button>
          );
        })}
      </div>

      <SemanticDiagnosticsCard t={t} diagnostics={diagnostics ?? null} fallbackErrors={errors} />

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onOpenWizard} style={{
          background: t.accent, border: 'none', borderRadius: 6, color: '#fff',
          cursor: 'pointer', fontSize: 12, fontFamily: t.font, fontWeight: 500, padding: '7px 16px',
        }}>Setup Wizard</button>
        <button onClick={onRefresh} style={{
          background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 6,
          color: t.textSecondary, cursor: 'pointer', fontSize: 12, fontFamily: t.font, padding: '7px 14px',
        }}>Refresh</button>
      </div>
    </div>
  );
}

function SemanticDiagnosticsCard({
  t,
  diagnostics,
  fallbackErrors,
  compact = false,
}: {
  t: Theme;
  diagnostics: SemanticLayerDiagnostics | null;
  fallbackErrors?: string[];
  compact?: boolean;
}) {
  const issues: SemanticDiagnosticIssue[] = diagnostics?.issues?.length
    ? diagnostics.issues
    : diagnostics?.warnings?.map((message) => ({
      severity: 'warning' as const,
      code: 'semantic_warning',
      message,
    })) ?? fallbackErrors?.map((message) => ({
      severity: 'error' as const,
      code: 'semantic_error',
      message,
    })) ?? [];

  if (!diagnostics && issues.length === 0) return null;

  const visibleIssues = compact ? issues.slice(0, 3) : issues.slice(0, 6);
  const source = diagnostics?.sourceOfTruth ?? diagnostics?.provider ?? 'not configured';
  const counts = diagnostics?.counts;
  const countsText = counts
    ? [
      `${counts.semanticModels} models`,
      `${counts.metrics} metrics`,
      `${counts.dimensions} dimensions`,
      `${counts.entities ?? 0} entities`,
    ].join(' · ')
    : null;

  return (
    <div style={{
      background: issues.some((issue) => issue.severity === 'error') ? `${t.error}10` : '#d2992212',
      border: `1px solid ${issues.some((issue) => issue.severity === 'error') ? `${t.error}40` : '#d2992240'}`,
      borderRadius: 8,
      padding: '8px 10px',
      marginBottom: compact ? 0 : 12,
      display: 'grid',
      gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>
          Semantic diagnostics
        </span>
        <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
          {source}
        </span>
      </div>
      {countsText && (
        <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
          {countsText}
        </div>
      )}
      {visibleIssues.map((issue, index) => (
        <div key={`${issue.code}-${index}`} style={{ display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 11, color: issue.severity === 'error' ? t.error : t.textSecondary, fontFamily: t.font, lineHeight: 1.35 }}>
            <strong style={{ textTransform: 'uppercase', fontSize: 9, marginRight: 6 }}>{issue.severity}</strong>
            {issue.message}
          </div>
          {issue.action && (
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, lineHeight: 1.35 }}>
              {issue.action}
            </div>
          )}
          {issue.path && (
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {issue.path}
            </div>
          )}
        </div>
      ))}
      {issues.length > visibleIssues.length && (
        <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
          +{issues.length - visibleIssues.length} more issue{issues.length - visibleIssues.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

interface TreeFilters {
  query: string;
  provider: string;
  domain: string;
  cube: string;
  owner: string;
  tag: string;
  type: string;
}

interface FlatTreeRow {
  node: SemanticTreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

const TREE_ROW_HEIGHT = 31;
const TREE_OVERSCAN = 10;

function filterTree(node: SemanticTreeNode, filters: TreeFilters): SemanticTreeNode | null {
  const q = filters.query.trim().toLowerCase();
  const metaValues = Object.values(node.meta ?? {})
    .filter((value): value is string | number | boolean => value != null)
    .map((value) => String(value).toLowerCase());
  const matchesQuery = !q || node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q) || metaValues.some((value) => value.includes(q));
  const matchesType = !filters.type || node.kind === filters.type || node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group';
  const matchesDomain = !filters.domain || node.kind === 'provider' || node.kind === 'group' || (node.meta?.domain === filters.domain || (node.kind === 'domain' && node.label === filters.domain));
  const matchesProvider = !filters.provider || node.meta?.provider === filters.provider || (node.kind === 'provider' && node.id === `provider:${filters.provider}`);
  const matchesCube = !filters.cube || node.meta?.cube === filters.cube || (node.kind === 'cube' && (node.meta?.cube === filters.cube || node.label === filters.cube));
  const matchesOwner = !filters.owner || node.meta?.owner === filters.owner;
  const matchesTag = !filters.tag || String(node.meta?.tags ?? '').split(',').filter(Boolean).includes(filters.tag);

  const children = (node.children ?? [])
    .map((child) => filterTree(child, filters))
    .filter((child): child is SemanticTreeNode => Boolean(child));

  if (children.length > 0) {
    return { ...node, children, count: node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group' ? children.length : node.count };
  }

  return matchesQuery && matchesType && matchesDomain && matchesProvider && matchesCube && matchesOwner && matchesTag
    ? { ...node, children: [] }
    : null;
}

function countTreeLeaves(node: SemanticTreeNode): number {
  if (!node.children || node.children.length === 0) return node.kind === 'group' || node.kind === 'provider' || node.kind === 'domain' ? 0 : 1;
  return node.children.reduce((sum, child) => sum + countTreeLeaves(child), 0);
}

function collectFacetValues(node: SemanticTreeNode | null, key: string): string[] {
  if (!node) return [];
  const values = new Set<string>();
  const visit = (current: SemanticTreeNode) => {
    const value = current.meta?.[key];
    if (typeof value === 'string' && value.trim()) {
      values.add(value.trim());
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function flattenTreeRows(nodes: SemanticTreeNode[], expanded: Record<string, boolean>, depth: number = 0): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of nodes) {
    const hasChildren = Boolean(node.children && node.children.length > 0);
    const isExpanded = expanded[node.id] ?? (depth < 2);
    rows.push({ node, depth, hasChildren, isExpanded });
    if (hasChildren && isExpanded) {
      rows.push(...flattenTreeRows(node.children ?? [], expanded, depth + 1));
    }
  }
  return rows;
}

export function SemanticPanel() {
  const { state, dispatch } = useNotebook();
  const hostUi = useHostUi();
  const t = themes[state.themeMode];
  const sl = state.semanticLayer;

  const [tree, setTree] = useState<SemanticTreeNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SemanticObjectDetail | null>(null);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [cubeFilter, setCubeFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [selectedDimensions, setSelectedDimensions] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeCandidates, setComposeCandidates] = useState<SemanticRuntimePathCandidate[]>([]);
  const [composePreview, setComposePreview] = useState<{
    sql: string;
    result: QueryResult;
    executionTarget?: ExecutionTarget;
    engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
    semanticTrace?: SemanticRuntimeTrace;
    targetBinding?: Record<string, unknown>;
    executionReceipt?: Record<string, unknown>;
  } | null>(null);
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget | undefined>();
  const [compatibleDimensionNames, setCompatibleDimensionNames] = useState<Set<string> | null>(null);
  const [composeCompatibilityState, setComposeCompatibilityState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [diagnostics, setDiagnostics] = useState<SemanticLayerDiagnostics | null>(null);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);

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

  const handleRefresh = async () => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    try {
      const [layer, nextTree, nextDiagnostics] = await Promise.all([
        api.getSemanticLayer(),
        api.getSemanticTree().catch(() => null),
        api.getSemanticLayerDiagnostics().catch(() => null),
      ]);
      dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      setTree(nextTree);
      setDiagnostics(nextDiagnostics);
    } finally {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
    }
  };

  useEffect(() => {
    if ((sl.metrics.length === 0 && sl.dimensions.length === 0 && !sl.loading) || !tree) {
      void handleRefresh();
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedItem(null);
      return;
    }
    if (selectedId.startsWith('provider:') || selectedId.startsWith('domain:') || selectedId.startsWith('group:')) {
      setSelectedItem(null);
      return;
    }
    void api.getSemanticObject(selectedId)
      .then(setSelectedItem)
      .catch(() => setSelectedItem(null));
  }, [selectedId]);

  const filteredTree = useMemo(() => {
    if (!tree) return null;
    const base = filterTree(tree, {
      query,
      provider: providerFilter,
      domain: domainFilter,
      cube: cubeFilter,
      owner: ownerFilter,
      tag: tagFilter,
      type: typeFilter,
    });
    return base;
  }, [tree, query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const favoritesSet = useMemo(() => new Set(sl.favorites), [sl.favorites]);
  const metricsByName = useMemo(() => new Map(sl.metrics.map((metric) => [metric.name, metric])), [sl.metrics]);
  const dimensionsByReference = useMemo(() => new Map(sl.dimensions.map((dimension) => [
    dimension.reference ?? dimension.name,
    dimension,
  ] as const)), [sl.dimensions]);
  const providerOptions = useMemo(() => collectFacetValues(tree, 'provider'), [tree]);
  const cubeOptions = useMemo(() => collectFacetValues(tree, 'cube'), [tree]);
  const ownerOptions = useMemo(() => collectFacetValues(tree, 'owner'), [tree]);
  const flatRows = useMemo(() => flattenTreeRows(filteredTree?.children ?? [], expanded), [filteredTree, expanded]);
  const totalTreeHeight = flatRows.length * TREE_ROW_HEIGHT;
  const visibleWindow = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
    const endIndex = Math.min(flatRows.length, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN);
    return {
      startIndex,
      endIndex,
      offsetTop: startIndex * TREE_ROW_HEIGHT,
      rows: flatRows.slice(startIndex, endIndex),
    };
  }, [flatRows, scrollTop, viewportHeight]);

  useEffect(() => {
    let cancelled = false;
    setComposePreview(null);
    setComposeError(null);
    setComposeCandidates([]);
    if (selectedMetrics.size === 0) {
      setCompatibleDimensionNames(null);
      setComposeCompatibilityState('idle');
      setSelectedDimensions(new Set());
      return;
    }
    setCompatibleDimensionNames(null);
    setComposeCompatibilityState('loading');
    void api.getCompatibility(Array.from(selectedMetrics)).then((compatibility) => {
      if (!cancelled) {
        const names = new Set(compatibility.dimensions.map((dimension) =>
          dimension.reference ?? dimension.name));
        setCompatibleDimensionNames(names);
        setSelectedDimensions((current) => new Set(Array.from(current).filter((name) => names.has(name))));
        setComposeCompatibilityState('ready');
      }
    }).catch((compatibilityError) => {
      if (cancelled) return;
      setCompatibleDimensionNames(new Set());
      setSelectedDimensions(new Set());
      setComposeCompatibilityState('error');
      // The runtime's own sentence says what to change; the error code stays
      // in the response for diagnostics, not in front of the person.
      setComposeError(compatibilityError instanceof DqlApiError
        ? compatibilityError.message || compatibilityError.nextActions?.[0] || 'Semantic compatibility could not be verified.'
        : compatibilityError instanceof Error
          ? compatibilityError.message
          : 'Semantic compatibility could not be verified.');
    });
    return () => { cancelled = true; };
  }, [Array.from(selectedMetrics).sort().join('|')]);

  useEffect(() => {
    const element = treeContainerRef.current;
    if (!element) return;
    const updateHeight = () => setViewportHeight(element.clientHeight || 400);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight);
      return () => window.removeEventListener('resize', updateHeight);
    }
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => observer.disconnect();
  }, [filteredTree]);

  useEffect(() => {
    setScrollTop(0);
    if (treeContainerRef.current) {
      treeContainerRef.current.scrollTop = 0;
    }
  }, [query, providerFilter, domainFilter, cubeFilter, ownerFilter, tagFilter, typeFilter]);

  const insertMetricOrDimension = async (item: SemanticObjectDetail) => {
    if (item.kind === 'metric') {
      const metric = metricsByName.get(item.name);
      if (metric?.execution && metric.execution.status !== 'ready') {
        setComposeError(metric.execution.reason || 'This metric is not executable with the current semantic runtime.');
        return;
      }
      dispatch({ type: 'ADD_CELL', cell: makeCell('dql', buildNotebookSemanticBlock([item.name], [])) });
      dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.name });
      return;
    }
    const reference = `@dim(${item.reference ?? item.name})`;
    if (!insertSemanticReference(reference)) {
      dispatch({ type: 'ADD_CELL', cell: makeCell('sql', reference) });
    }
    dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.reference ?? item.name });
  };

  const renderLeaf = (node: SemanticTreeNode, depth: number) => {
    const refKind = node.kind === 'metric'
      ? 'metric'
      : node.kind === 'dimension' || node.kind === 'time_dimension'
        ? 'dimension'
        : null;
    const refName = typeof node.meta?.reference === 'string'
      ? node.meta.reference
      : node.id.split(':').slice(1).join(':');
    const technicalName = typeof node.meta?.localName === 'string'
      ? node.meta.localName
      : refName;
    const technicalLabel = typeof node.meta?.cube === 'string'
      && (node.kind === 'dimension' || node.kind === 'time_dimension')
      ? `${technicalName} · ${node.meta.cube}`
      : technicalName;
    const isChecked = refKind === 'metric' ? selectedMetrics.has(refName) : refKind === 'dimension' ? selectedDimensions.has(refName) : false;
    const metricCapability = refKind === 'metric' ? metricsByName.get(refName)?.execution : undefined;
    const metricBlocked = Boolean(metricCapability && metricCapability.status !== 'ready');
    const dimensionBlocked = Boolean(
      selectMode && refKind === 'dimension' && selectedMetrics.size > 0
      && compatibleDimensionNames && !compatibleDimensionNames.has(refName),
    );
    const selectionBlocked = metricBlocked || dimensionBlocked;

    return (
      <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
        {selectMode && refKind && (
          <input
            type="checkbox"
            checked={isChecked}
            disabled={selectionBlocked}
            onChange={() => !selectionBlocked && toggleSelection(refKind, refName)}
            style={{ marginLeft: depth * 12 + 6, marginRight: -depth * 12 - 2, accentColor: t.accent, cursor: 'pointer' }}
          />
        )}
      <TreeRow
        label={node.label}
        secondaryLabel={technicalLabel}
        depth={selectMode && refKind ? 0 : depth}
        badge={node.kind === 'metric' || node.kind === 'dimension' || node.kind === 'segment' || node.kind === 'pre_aggregation' ? node.kind : undefined}
        selected={selectedId === node.id}
        onClick={() => { if (selectMode && refKind && !selectionBlocked) { toggleSelection(refKind, refName); } else { setSelectedId(node.id); } }}
        onDoubleClick={() => {
          if (node.kind === 'metric' || node.kind === 'dimension' || node.kind === 'time_dimension') {
            const object = node.kind === 'metric'
              ? metricsByName.get(node.id.slice('metric:'.length))
              : dimensionsByReference.get(refName);
            if (object) {
              if (node.kind === 'metric') {
                const metric = metricsByName.get(object.name);
                if (!metric?.execution || metric.execution.status === 'ready') {
                  dispatch({ type: 'ADD_CELL', cell: makeCell('dql', buildNotebookSemanticBlock([object.name], [])) });
                  dispatch({ type: 'ADD_SEMANTIC_RECENT', name: object.name });
                } else {
                  setComposeError(metric.execution.reason || 'This metric is not executable with the current semantic runtime.');
                }
              } else {
                const dimension = dimensionsByReference.get(refName);
                if (!dimension) return;
                const ref = `@dim(${dimension.reference ?? dimension.name})`;
                if (!insertSemanticReference(ref)) dispatch({ type: 'ADD_CELL', cell: makeCell('sql', ref) });
              }
            }
          }
        }}
        title={metricBlocked ? metricCapability?.reason ?? undefined : dimensionBlocked ? 'Not compatible with the selected metrics.' : undefined}
        muted={selectionBlocked}
        onFavoriteToggle={refKind
          ? () => void api.toggleFavorite(refName).then((favorites) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites }))
          : undefined}
        favorite={refKind ? favoritesSet.has(refName) : undefined}
        onDragStart={refKind
          ? (event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('text/plain', refName);
              event.dataTransfer.setData('application/dql-semantic-ref', serializeSemanticDragRef(refKind, refName));
            }
          : undefined}
        t={t}
      />
      </div>
    );
  };

  const renderTreeRow = (row: FlatTreeRow): React.ReactNode => {
    const { node, depth, hasChildren, isExpanded } = row;
    if (!hasChildren) return renderLeaf(node, depth);
    return (
      <div key={node.id}>
        <TreeRow
          label={node.label}
          depth={depth}
          count={node.children?.length}
          expanded={isExpanded}
          onToggle={() => setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }))}
          onClick={() => setSelectedId(node.id)}
          selected={selectedId === node.id}
          t={t}
        />
      </div>
    );
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.syncSemanticLayer();
      await handleRefresh();
    } finally {
      setSyncing(false);
    }
  };

  const toggleSelection = (kind: 'metric' | 'dimension', name: string) => {
    setComposePreview(null);
    setComposeError(null);
    setComposeCandidates([]);
    if (kind === 'metric') {
      setSelectedMetrics((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
      });
    } else {
      setSelectedDimensions((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
      });
    }
  };

  const runSemanticPreview = async (dimensions: string[]) => {
    if (selectedMetrics.size === 0) return;
    setComposing(true);
    setComposeError(null);
    setComposeCandidates([]);
    try {
      const result = await api.previewSemanticBuilder({
        metrics: Array.from(selectedMetrics),
        dimensions,
        executionTarget,
        limit: 50,
      });
      if ('error' in result) {
        setComposeError(result.error);
        setComposeCandidates(result.details?.candidates ?? []);
        setComposePreview(null);
        return;
      }
      setComposePreview({
        sql: result.sql,
        result: result.result,
        executionTarget,
        engine: result.engine,
        semanticTrace: result.semanticTrace,
        targetBinding: result.targetBinding,
        executionReceipt: result.executionReceipt,
      });
    } finally {
      setComposing(false);
    }
  };

  const handleCompose = async () => {
    await runSemanticPreview(Array.from(selectedDimensions));
  };

  const handleSelectSemanticPath = async (candidate: SemanticRuntimePathCandidate) => {
    const baseReference = (value: string) => value.replace(/@via\([^)]+\)$/, '');
    const sameDimension = (value: string) => {
      const selected = baseReference(value).toLowerCase();
      const candidateRef = candidate.authoringReference.toLowerCase();
      return selected === candidateRef
        || ((!selected.includes('.') || !candidateRef.includes('.'))
          && selected.split('.').pop() === candidateRef.split('.').pop());
    };
    const nextDimensions = Array.from(selectedDimensions, (dimension) =>
      sameDimension(dimension) ? candidate.selectionReference : dimension);
    setSelectedDimensions(new Set(nextDimensions));
    setComposePreview(null);
    setComposeError(null);
    setComposeCandidates([]);
    await runSemanticPreview(nextDimensions);
  };

  const handleInsertSemanticQuery = () => {
    if (selectedMetrics.size === 0 || composeCompatibilityState !== 'ready' || composing) return;
    const metrics = Array.from(selectedMetrics);
    const dimensions = Array.from(selectedDimensions);
    const source = buildNotebookSemanticBlock(metrics, dimensions);
    const cell = makeCell('dql', source);
    cell.executionTarget = composePreview?.executionTarget ?? executionTarget;
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
        authoringState: composePreview ? 'previewed' : 'selected',
        compatibilityState: composeCompatibilityState,
        ...(composePreview ? {
          engine: composePreview.engine,
          executionTarget: composePreview.executionTarget,
          targetBinding: composePreview.targetBinding,
          executionReceipt: composePreview.executionReceipt,
          previewRows: composePreview.result.rowCount ?? composePreview.result.rows.length,
        } : {}),
      }],
      ...(composePreview ? { sql: composePreview.sql, compiledSql: composePreview.sql } : {}),
    };
    dispatch({
      type: 'ADD_CELL',
      cell,
    });
    for (const metric of selectedMetrics) dispatch({ type: 'ADD_SEMANTIC_RECENT', name: metric });
    setSelectMode(false);
    setSelectedMetrics(new Set());
    setSelectedDimensions(new Set());
    setComposePreview(null);
    setComposeError(null);
    setComposeCandidates([]);
  };

  const handleOpenStudio = () => {
    if (state.activeFile?.type === 'block') {
      void api.openBlockStudio(state.activeFile.path).then((payload) => {
        dispatch({
          type: 'OPEN_BLOCK_STUDIO',
          file: state.activeFile!,
          payload,
        });
      });
      return;
    }
    dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' });
  };

  const openSemanticRuntimeSettings = () => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
  };

  if (!sl.available && !sl.loading) {
    return (
      <>
        <SetupState
          t={t}
          provider={sl.provider}
          diagnostics={diagnostics}
          errors={(state.semanticLayer as any).errors}
          onOpenWizard={() => setWizardOpen(true)}
          onRefresh={() => void handleRefresh()}
        />
        {wizardOpen && (
          <SetupWizard
            detectedProvider={sl.provider}
            onClose={() => setWizardOpen(false)}
            onImported={() => void handleRefresh()}
          />
        )}
      </>
    );
  }

  const treeLeafCount = filteredTree ? countTreeLeaves(filteredTree) : 0;

  return (
    <PanelFrame title="Semantic Layer" bodyPadding={0}>
      <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${t.headerBorder}` }}>
        {sl.provider && (
          <span style={{ fontSize: 9, fontWeight: 600, color: t.accent, background: `${t.accent}18`, borderRadius: 4, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {sl.provider}
          </span>
        )}
        <span style={{ flex: 1, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {sl.metrics.length} metrics · {sl.dimensions.length} dimensions
          {sl.lastSyncTime ? ` · synced ${new Date(sl.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        {/* Without an open block this button creates one, which a read-only viewer cannot do. */}
        {(!hostReadOnly(hostUi, 'block_library') || state.activeFile?.type === 'block') && <button
          onClick={handleOpenStudio}
          style={{ background: t.accent, border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: t.font, padding: '2px 8px' }}
        >
          Open Studio
        </button>}
        <button
          onClick={() => {
            setSelectMode((v) => !v);
            setComposePreview(null);
            setComposeError(null);
            setComposeCandidates([]);
            if (selectMode) {
              setSelectedMetrics(new Set());
              setSelectedDimensions(new Set());
            }
          }}
          style={{
            background: selectMode ? `${t.accent}20` : 'transparent',
            border: `1px solid ${selectMode ? t.accent : t.cellBorder}`,
            borderRadius: 4, color: selectMode ? t.accent : t.textSecondary,
            cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '2px 8px',
          }}
        >
          {selectMode ? 'Cancel' : 'Select'}
        </button>
        <button
          onClick={() => void handleSync()}
          style={{ background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4, color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '2px 6px' }}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button
          onClick={() => void handleRefresh()}
          style={{ background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4, color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '2px 6px' }}
        >
          {sl.loading ? 'Loading…' : 'Refresh'}
        </button>
        </div>

        {diagnostics && (diagnostics.issues?.length || diagnostics.warnings.length) ? (
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
            <SemanticDiagnosticsCard t={t} diagnostics={diagnostics} compact />
          </div>
        ) : null}

        <div style={{ padding: '10px', borderBottom: `1px solid ${t.headerBorder}`, background: `${t.accent}0d`, display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
          Build saved queries
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          Use the full-screen studio to author DQL with semantic metrics, database schemas, validation, results, and visualization in one workspace.
        </div>
      </div>

      <SemanticSearchBar
        query={query}
        provider={providerFilter}
        cube={cubeFilter}
        owner={ownerFilter}
        domain={domainFilter}
        tag={tagFilter}
        type={typeFilter}
        providers={providerOptions}
        cubes={cubeOptions}
        owners={ownerOptions}
        domains={sl.domains}
        tags={sl.tags}
        onQueryChange={setQuery}
        onProviderChange={setProviderFilter}
        onCubeChange={setCubeFilter}
        onOwnerChange={setOwnerFilter}
        onDomainChange={setDomainFilter}
        onTagChange={setTagFilter}
        onTypeChange={setTypeFilter}
        t={t}
      />

      <PanelSectionHeader label="Semantic Tree" count={treeLeafCount} t={t} />
      <div
        ref={treeContainerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ flex: 1, overflowY: 'auto' }}
      >
        <div style={{ height: totalTreeHeight, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: visibleWindow.offsetTop,
              left: 0,
              right: 0,
            }}
          >
            {visibleWindow.rows.map((row) => renderTreeRow(row))}
          </div>
        </div>
      </div>

      <MetricDetailPanel
        item={selectedItem}
        favorite={Boolean(selectedItem && favoritesSet.has(selectedItem.name))}
        onInsert={() => selectedItem && (selectedItem.kind === 'metric' || selectedItem.kind === 'dimension') && void insertMetricOrDimension(selectedItem)}
        onPreview={() => {
          if (!selectedItem?.sql) return;
          const sql = selectedItem.kind === 'cube' && selectedItem.table
            ? `SELECT * FROM ${selectedItem.table} LIMIT 25`
            : selectedItem.sql;
          dispatch({ type: 'ADD_CELL', cell: makeCell('sql', sql) });
        }}
        onCopySql={() => {
          if (selectedItem?.sql) {
            void navigator.clipboard.writeText(selectedItem.sql);
          }
        }}
        onToggleFavorite={() => {
          if (selectedItem && (selectedItem.kind === 'metric' || selectedItem.kind === 'dimension')) {
            void api.toggleFavorite(selectedItem.name).then((favorites) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites }));
          }
        }}
        runtimeBlockedReason={selectedItem?.kind === 'metric'
          ? metricsByName.get(selectedItem.name)?.execution?.status !== 'ready'
            ? metricsByName.get(selectedItem.name)?.execution?.reason ?? undefined
            : undefined
          : undefined}
        onSetupRuntime={openSemanticRuntimeSettings}
        t={t}
      />

      {/* Floating compose bar when items are selected */}
      {selectMode && (selectedMetrics.size > 0 || selectedDimensions.size > 0) && (
        <div style={{
          padding: '8px 12px', borderTop: `1px solid ${t.headerBorder}`,
          background: t.cellBg, display: 'grid', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
              {selectedMetrics.size} metric{selectedMetrics.size !== 1 ? 's' : ''}
              {selectedDimensions.size > 0 ? ` · ${selectedDimensions.size} dimension${selectedDimensions.size !== 1 ? 's' : ''}` : ''}
            </span>
            <button
              onClick={() => void handleCompose()}
              disabled={composing || selectedMetrics.size === 0}
              style={{
                background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary,
                cursor: composing ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
                fontFamily: t.font, padding: '6px 10px', opacity: composing || selectedMetrics.size === 0 ? 0.5 : 1,
              }}
            >
              {composing ? 'Running preview…' : 'Preview & run'}
            </button>
            <button
              onClick={handleInsertSemanticQuery}
              disabled={selectedMetrics.size === 0 || composeCompatibilityState !== 'ready' || composing}
              title={composeCompatibilityState === 'ready'
                ? (composePreview ? 'Add the previewed semantic query to the notebook.' : 'Add the governed semantic selection now; preview is optional.')
                : 'Select an executable metric and wait for governed compatibility.'}
              style={{
                background: t.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: composeCompatibilityState === 'ready' && !composing ? 'pointer' : 'not-allowed',
                fontSize: 11, fontWeight: 600, fontFamily: t.font, padding: '6px 10px',
                opacity: selectedMetrics.size === 0 || composeCompatibilityState !== 'ready' || composing ? 0.5 : 1,
              }}
            >
              Add to cell
            </button>
          </div>
          {composeError && (
            <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10.5, lineHeight: 1.4, color: t.error, background: `${t.error}10`, border: `1px solid ${t.error}30`, borderRadius: 6, padding: '6px 8px' }}>
              <span style={{ flex: 1 }}>{composeError}</span>
              {/semantic runtime|MetricFlow/i.test(composeError) ? <button type="button" onClick={openSemanticRuntimeSettings} style={{ border: 'none', background: 'transparent', color: t.accent, fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set up runtime →</button> : null}
            </div>
          )}
          {composeCandidates.length > 0 ? (
            <div aria-label="Choose a governed semantic path" style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.4 }}>
                This member has multiple valid MetricFlow paths. Choose the governed relationship the metric should use:
              </div>
              {composeCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => void handleSelectSemanticPath(candidate)}
                  disabled={composing}
                  style={{
                    display: 'grid',
                    gap: 2,
                    textAlign: 'left',
                    border: `1px solid ${t.cellBorder}`,
                    borderRadius: 6,
                    background: t.inputBg,
                    color: t.textPrimary,
                    padding: '7px 8px',
                    cursor: composing ? 'not-allowed' : 'pointer',
                    fontFamily: t.font,
                  }}
                >
                  <span style={{ fontSize: 10.5, fontWeight: 700 }}>{candidate.label}</span>
                  <span style={{ fontSize: 9.5, color: t.textMuted, fontFamily: t.fontMono }}>{candidate.runtimeReference}</span>
                </button>
              ))}
            </div>
          ) : null}
          {composePreview && (
            <div style={{ display: 'grid', gap: 5, fontSize: 10.5, color: t.textMuted }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  Preview succeeded
                  {composePreview.engine ? ` · ${composePreview.engine}` : ''}
                  {' · '}{composePreview.result.rowCount ?? composePreview.result.rows.length} row{(composePreview.result.rowCount ?? composePreview.result.rows.length) === 1 ? '' : 's'}
                </span>
                <button type="button" onClick={() => void navigator.clipboard.writeText(composePreview.sql)} style={{ border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', padding: 0, fontSize: 10.5 }}>Copy SQL</button>
              </div>
              {composePreview.semanticTrace?.bindings.length ? (
                <div style={{ display: 'grid', gap: 2, padding: '5px 7px', borderRadius: 6, background: t.inputBg, border: `1px solid ${t.cellBorder}` }}>
                  {composePreview.semanticTrace.bindings.map((binding, index) => (
                    <span key={`${binding.role}:${binding.authoringReference}:${index}`} style={{ fontFamily: t.fontMono, fontSize: 9.5 }}>
                      {binding.authoringReference} → {binding.runtimeReference}
                    </span>
                  ))}
                </div>
              ) : null}
              <pre style={{ margin: 0, maxHeight: 76, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: t.fontMono, fontSize: 9.5, color: t.textSecondary, background: t.editorBg, border: `1px solid ${t.cellBorder}`, borderRadius: 6, padding: '6px 8px' }}>{composePreview.sql}</pre>
            </div>
          )}
        </div>
      )}
    </PanelFrame>
  );
}
