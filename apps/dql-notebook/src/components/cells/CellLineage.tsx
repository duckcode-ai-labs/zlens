import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../api/client';
import type { Cell } from '../../store/types';
import { findHandleNames } from '../../utils/handles';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  STATUS_COLORS,
  type LineageNode,
  type LineagePath,
  type CompletePathResult,
} from '../lineage/lineage-constants';
import { LineagePathBreadcrumb } from '../lineage/LineagePathBreadcrumb';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';

interface SqlSourceRef {
  name: string;
  alias?: string;
  kind: 'table' | 'cte' | 'ref';
}

interface SqlJoinRef {
  type: string;
  table: string;
  alias?: string;
  condition?: string;
}

interface SqlLineageSummary {
  sources: SqlSourceRef[];
  ctes: string[];
  joins: SqlJoinRef[];
  filters: string[];
  groupBy: string[];
  orderBy: string[];
  outputs: string[];
  semanticRefs: { metrics: string[]; dimensions: string[] };
  warnings: string[];
}

interface BusinessContextMatch {
  source: string;
  node: LineageNode;
  score: number;
}

interface NotebookDownstreamRef {
  id: string;
  label: string;
  type: string;
  handle?: string;
}

const SQL_ALIAS_STOP_WORDS = new Set([
  'where',
  'on',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'group',
  'order',
  'having',
  'limit',
  'qualify',
  'union',
  'as',
]);

const BUSINESS_CONTEXT_TYPES = new Set([
  'term',
  'business_view',
  'block',
  'metric',
  'dimension',
  'domain',
  'dbt_model',
  'source_table',
  'dbt_source',
]);

/** Extract a block name from DQL cell content: block "name" { ... } */
function extractBlockName(content: string): string | null {
  const m = content.match(/^\s*block\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

function emptySqlLineage(): SqlLineageSummary {
  return {
    sources: [],
    ctes: [],
    joins: [],
    filters: [],
    groupBy: [],
    orderBy: [],
    outputs: [],
    semanticRefs: { metrics: [], dimensions: [] },
    warnings: [],
  };
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function normalizeIdentifier(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, '').trim();
}

function sourceKey(source: SqlSourceRef): string {
  return `${source.kind}:${source.name.toLowerCase()}:${source.alias ?? ''}`;
}

function dedupeSources(sources: SqlSourceRef[]): SqlSourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = sourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitTopLevelComma(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = input[i - 1];
    if (quote) {
      current += ch;
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function isKeywordAt(input: string, keyword: string, index: number): boolean {
  const normalizedKeyword = keyword.replace(/\s+/g, ' ');
  const before = index === 0 ? '' : input[index - 1];
  if (before && /[a-zA-Z0-9_]/.test(before)) return false;
  let pos = index;
  for (const part of normalizedKeyword.split(' ')) {
    while (/\s/.test(input[pos] ?? '')) pos += 1;
    if (input.slice(pos, pos + part.length).toLowerCase() !== part.toLowerCase()) return false;
    pos += part.length;
  }
  const after = input[pos] ?? '';
  return !after || !/[a-zA-Z0-9_]/.test(after);
}

function findTopLevelKeyword(input: string, keyword: string, start = 0): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    const prev = input[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && isKeywordAt(input, keyword, i)) return i;
  }
  return -1;
}

function topLevelClause(input: string, keyword: string, stopKeywords: string[]): string {
  const start = findTopLevelKeyword(input, keyword);
  if (start < 0) return '';
  let contentStart = start + keyword.length;
  while (/\s/.test(input[contentStart] ?? '')) contentStart += 1;
  const stops = stopKeywords
    .map((stop) => findTopLevelKeyword(input, stop, contentStart))
    .filter((idx) => idx >= 0);
  const end = stops.length > 0 ? Math.min(...stops) : input.length;
  return input.slice(contentStart, end).trim();
}

function safeAlias(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeIdentifier(value);
  return SQL_ALIAS_STOP_WORDS.has(normalized.toLowerCase()) ? undefined : normalized;
}

function parenContextBefore(input: string, index: number): { depth: number; segment: string } {
  const stack: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < index; i += 1) {
    const ch = input[i];
    const prev = input[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      stack.pop();
    }
  }
  const lastOpen = stack[stack.length - 1];
  return {
    depth: stack.length,
    segment: lastOpen === undefined ? '' : input.slice(lastOpen + 1, index),
  };
}

function isQuerySourceKeyword(sql: string, keywordIndex: number): boolean {
  const context = parenContextBefore(sql, keywordIndex);
  if (context.depth === 0) return true;
  return /\bSELECT\b/i.test(context.segment);
}

function analyzeSqlLineage(content: string): SqlLineageSummary {
  const sql = stripSqlComments(content);
  if (!sql.trim()) return emptySqlLineage();

  const warnings: string[] = [];
  const ctes = [...sql.matchAll(/\b(?:WITH|,)\s+([a-zA-Z_][\w]*)\s+AS\s*\(/gi)]
    .map((m) => m[1])
    .filter(Boolean);
  const cteSet = new Set(ctes.map((name) => name.toLowerCase()));

  const sources: SqlSourceRef[] = [];
  const fromJoinPattern = /\b(FROM|JOIN)\s+([a-zA-Z_][\w.]*)\s*(?:AS\s+)?([a-zA-Z_][\w]*)?/gi;
  for (const m of sql.matchAll(fromJoinPattern)) {
    if (!isQuerySourceKeyword(sql, m.index ?? 0)) continue;
    const name = normalizeIdentifier(m[2]);
    if (!name || SQL_ALIAS_STOP_WORDS.has(name.toLowerCase())) continue;
    sources.push({
      name,
      alias: safeAlias(m[3]),
      kind: cteSet.has(name.toLowerCase()) ? 'cte' : 'table',
    });
  }

  for (const m of sql.matchAll(/\bref\s*\(\s*["']([^"']+)["']\s*\)/gi)) {
    sources.push({ name: normalizeIdentifier(m[1]), kind: 'ref' });
  }

  const joins: SqlJoinRef[] = [];
  const joinPattern = /\b((?:LEFT|RIGHT|FULL|INNER|CROSS)?\s*JOIN)\s+([a-zA-Z_][\w.]*)\s*(?:AS\s+)?([a-zA-Z_][\w]*)?([\s\S]*?)(?=\b(?:LEFT|RIGHT|FULL|INNER|CROSS)?\s*JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bQUALIFY\b|\bLIMIT\b|$)/gi;
  for (const m of sql.matchAll(joinPattern)) {
    if (!isQuerySourceKeyword(sql, m.index ?? 0)) continue;
    const conditionMatch = m[4]?.match(/\bON\b\s+([\s\S]*)/i);
    joins.push({
      type: m[1].replace(/\s+/g, ' ').trim().toUpperCase(),
      table: normalizeIdentifier(m[2]),
      alias: safeAlias(m[3]),
      condition: conditionMatch ? conditionMatch[1].trim().replace(/\s+/g, ' ') : undefined,
    });
  }

  const selectClause = topLevelClause(sql, 'SELECT', ['FROM']);
  const whereClause = topLevelClause(sql, 'WHERE', ['GROUP BY', 'HAVING', 'QUALIFY', 'ORDER BY', 'LIMIT']);
  const groupClause = topLevelClause(sql, 'GROUP BY', ['HAVING', 'QUALIFY', 'ORDER BY', 'LIMIT']);
  const orderClause = topLevelClause(sql, 'ORDER BY', ['LIMIT']);
  const outputs = selectClause ? splitTopLevelComma(selectClause).slice(0, 20) : [];
  const filters = whereClause ? [whereClause.replace(/\s+/g, ' ')] : [];
  const groupBy = groupClause ? splitTopLevelComma(groupClause).slice(0, 12) : [];
  const orderBy = orderClause ? splitTopLevelComma(orderClause).slice(0, 12) : [];

  if (ctes.length > 0) {
    warnings.push('CTEs are included. Review CTE-to-final-query dependencies before certifying.');
  }
  if (/\bSELECT\s+\*/i.test(sql)) {
    warnings.push('SELECT * detected. Outputs may drift when upstream schema changes.');
  }
  if (sources.length === 0 && /\bSELECT\b/i.test(sql)) {
    warnings.push('No source tables detected. This may be a literal query, parameter query, or unsupported SQL shape.');
  }

  return {
    sources: dedupeSources(sources),
    ctes,
    joins,
    filters,
    groupBy,
    orderBy,
    outputs,
    semanticRefs: extractSemanticRefs(sql),
    warnings,
  };
}

/** Extract @metric() and @dim() references from SQL */
function extractSemanticRefs(sql: string): { metrics: string[]; dimensions: string[] } {
  const metrics: string[] = [];
  const dimensions: string[] = [];
  for (const m of sql.matchAll(/@metric\s*\(\s*([^)]+)\s*\)/gi)) {
    metrics.push(m[1].replace(/['"]/g, '').trim());
  }
  for (const m of sql.matchAll(/@dim\s*\(\s*([^)]+)\s*\)/gi)) {
    dimensions.push(m[1].replace(/['"]/g, '').trim());
  }
  return { metrics, dimensions };
}

function displayNodeType(node: LineageNode): string {
  return TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase();
}

function findDownstreamCells(cells: Cell[] | undefined, cellId: string | undefined, cellName: string | undefined): NotebookDownstreamRef[] {
  if (!cells?.length) return [];
  const handles = new Set<string>();
  if (cellName?.trim()) handles.add(cellName.trim());
  if (cellId?.trim()) handles.add(cellId.trim());
  if (handles.size === 0) return [];

  const downstream: NotebookDownstreamRef[] = [];
  cells.forEach((cell, index) => {
    if (cell.id === cellId) return;
    const usedHandles = findHandleNames(cell.content).filter((handle) => handles.has(handle));
    const upstreamMatches = cell.upstream && handles.has(cell.upstream) ? [cell.upstream] : [];
    const match = [...new Set([...usedHandles, ...upstreamMatches])][0];
    if (!match) return;
    downstream.push({
      id: cell.id,
      label: cell.name || `Cell ${index + 1}`,
      type: cell.type,
      handle: match,
    });
  });
  return downstream;
}

function MiniNode({ node, t }: { node: LineageNode; t: Theme }) {
  const color = NODE_TYPE_COLORS[node.type] ?? '#8b949e';
  const label = TYPE_LABELS[node.type] ?? node.type.slice(0, 3).toUpperCase();
  const statusColor = node.status ? STATUS_COLORS[node.status] : undefined;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 0',
        fontSize: 11,
        color: t.textPrimary,
      }}
    >
      <span style={{ color, fontSize: 9, fontWeight: 700, width: 26, flexShrink: 0 }}>{label}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {node.name}
      </span>
      {node.domain && (
        <span style={{ fontSize: 9, color: t.textMuted }}>{node.domain}</span>
      )}
      {statusColor && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
      )}
    </div>
  );
}

function LineageCard({ title, t, children }: { title: string; t: Theme; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 6,
        background: t.cellBg,
        padding: 8,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: t.textMuted, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ color: t.textPrimary, lineHeight: 1.45 }}>{children}</div>
    </section>
  );
}

function EmptyLineageText({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ color: t.textMuted, fontSize: 11 }}>{children}</div>;
}

function LineageMiniStat({ label, value, t }: { label: string; value: number; t: Theme }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <strong style={{ color: t.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{value}</strong>
    </div>
  );
}

function LineageDetailBlock({ title, t, children }: { title: string; t: Theme; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
      <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 600 }}>{title}</div>
      <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>{children}</div>
    </div>
  );
}

interface CellLineageProps {
  cellContent: string;
  cellType: 'sql' | 'dql';
  /**
   * Compiled SQL behind a DQL cell. An AI-generated DQL block is TRANSIENT — it
   * is not saved under blocks/, so `block:<name>` is not a project lineage node
   * and there is no saved graph to focus. Its real lineage lives in the SQL it
   * compiles to, so we read the sources from there instead of showing nothing.
   */
  compiledSql?: string;
  cellId?: string;
  cellName?: string;
  cells?: Cell[];
  themeMode: ThemeMode;
  t: Theme;
  /** Called when a node is clicked to focus the full lineage DAG */
  onFocusNode?: (nodeId: string) => void;
}

export function CellLineage({ cellContent, cellType, compiledSql, cellId, cellName, cells, themeMode, t, onFocusNode }: CellLineageProps) {
  const [expanded, setExpanded] = useState(false);
  const [graphHeight, setGraphHeight] = useState(380);
  const graphHeightRef = useRef(graphHeight);
  graphHeightRef.current = graphHeight;
  const [resizing, setResizing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [graphNodes, setGraphNodes] = useState<LineageNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<any[]>([]);
  const [focalNodeId, setFocalNodeId] = useState<string | undefined>();
  const [pathResult, setPathResult] = useState<CompletePathResult | null>(null);
  const [businessMatches, setBusinessMatches] = useState<BusinessContextMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A DQL cell has TWO halves of its lineage and neither alone is complete:
  // the block source declares the governed metrics/dimensions, while the physical
  // relations only appear in the SQL it compiles to. Read the compiled SQL for
  // structure and merge the block's own semantic references back in, so the panel
  // reflects THIS block's logic rather than the project at large.
  const sqlSummary = useMemo(() => {
    const isDql = cellType === 'dql';
    const compiled = compiledSql?.trim();
    if (!isDql || !compiled) return analyzeSqlLineage(cellContent);
    const fromCompiled = analyzeSqlLineage(compiled);
    const fromBlock = analyzeSqlLineage(cellContent);
    const merge = (left: string[], right: string[]) => [...new Set([...left, ...right])];
    return {
      ...fromCompiled,
      semanticRefs: {
        metrics: merge(fromBlock.semanticRefs.metrics, fromCompiled.semanticRefs.metrics),
        dimensions: merge(fromBlock.semanticRefs.dimensions, fromCompiled.semanticRefs.dimensions),
      },
      outputs: fromCompiled.outputs.length > 0 ? fromCompiled.outputs : fromBlock.outputs,
    };
  }, [cellType, cellContent, compiledSql]);
  const downstreamCells = useMemo(
    () => findDownstreamCells(cells, cellId, cellName),
    [cells, cellId, cellName],
  );
  const blockName = cellType === 'dql' ? extractBlockName(cellContent) : null;
  const lookupName = blockName || cellName;
  const isSqlCell = cellType === 'sql';

  /** Resolve the governed business nodes behind the relations this cell reads. */
  const loadBusinessMatchesFromSql = useCallback(async () => {
    const tableSources = sqlSummary.sources.filter((source) => source.kind !== 'cte').slice(0, 6);
    const scopedMatches = await Promise.all(
      tableSources.map(async (source) => {
        const searchName = source.name.split('.').pop() || source.name;
        const result = await api.searchLineage(searchName);
        return (result.matches ?? [])
          .filter(({ node }) => node && BUSINESS_CONTEXT_TYPES.has(String(node.type)))
          .slice(0, 3)
          .map(({ node, score }) => ({ source: source.name, node: node as LineageNode, score }));
      }),
    );
    const seen = new Set<string>();
    setBusinessMatches(
      scopedMatches
        .flat()
        .filter((match) => {
          const key = `${match.source}:${match.node.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8),
    );
  }, [sqlSummary.sources]);

  const loadLineage = useCallback(async () => {
    if (!lookupName && cellType !== 'sql') return;
    setLoading(true);
    setError(null);
    try {
      if (isSqlCell) {
        setGraphNodes([]);
        setGraphEdges([]);
        setFocalNodeId(undefined);
        setPathResult(null);
        await loadBusinessMatchesFromSql();
        return;
      }

      if (lookupName) {
        const nodeId = `block:${lookupName}`;
        setFocalNodeId(nodeId);
        const [graphResult, paths] = await Promise.all([
          api.queryLineage({ focus: nodeId, upstreamDepth: 2, downstreamDepth: 2 }),
          api.fetchLineagePaths(nodeId).catch(() => null),
        ]);
        const resolved = Boolean(graphResult?.focalNode) && (graphResult?.graph?.nodes?.length ?? 0) > 0;
        if (resolved) {
          setGraphNodes(graphResult.graph?.nodes ?? []);
          setGraphEdges(graphResult.graph?.edges ?? []);
          if (paths) setPathResult(paths);
        } else {
          // Transient AI block: no saved project node to focus, so show the
          // relations its compiled SQL actually reads. An unresolved focus used
          // to return the ENTIRE project graph, which rendered as an unrelated
          // "demo" lineage with nothing to do with this cell.
          setFocalNodeId(undefined);
          setGraphNodes([]);
          setGraphEdges([]);
          setPathResult(null);
          await loadBusinessMatchesFromSql();
        }
      } else {
        setFocalNodeId(undefined);
        setGraphNodes([]);
        setGraphEdges([]);
      }
    } catch {
      setError('Failed to load lineage');
    } finally {
      setLoading(false);
    }
  }, [lookupName, cellType, isSqlCell, loadBusinessMatchesFromSql]);

  useEffect(() => {
    if (expanded) {
      loadLineage();
    }
  }, [expanded, loadLineage]);

  const hasSqlContent =
    sqlSummary.sources.length > 0 ||
    sqlSummary.outputs.length > 0 ||
    sqlSummary.joins.length > 0 ||
    sqlSummary.filters.length > 0 ||
    sqlSummary.groupBy.length > 0 ||
    sqlSummary.orderBy.length > 0 ||
    sqlSummary.semanticRefs.metrics.length > 0 ||
    sqlSummary.semanticRefs.dimensions.length > 0 ||
    downstreamCells.length > 0 ||
    businessMatches.length > 0;
  const hasProjectContent = graphNodes.length > 0 || Boolean(pathResult);

  const renderSqlLineageContent = () => (
    <div style={{ padding: '8px 12px 10px', display: 'grid', gap: 8 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 8,
        }}
      >
        <LineageCard title="Technical source trace" t={t}>
          {sqlSummary.sources.length > 0 ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {sqlSummary.sources.map((source) => (
                <div key={sourceKey(source)} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      color: source.kind === 'cte' ? t.textMuted : NODE_TYPE_COLORS.source_table,
                      fontSize: 9,
                      fontWeight: 700,
                      width: 28,
                      flexShrink: 0,
                    }}
                  >
                    {source.kind === 'cte' ? 'CTE' : source.kind === 'ref' ? 'REF' : 'TBL'}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.name}</span>
                  {source.alias && (
                    <span style={{ color: t.textMuted, fontSize: 10, flexShrink: 0 }}>as {source.alias}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyLineageText t={t}>No table references detected.</EmptyLineageText>
          )}
          {sqlSummary.ctes.length > 0 && (
            <div style={{ marginTop: 6, color: t.textMuted }}>
              CTEs: {sqlSummary.ctes.slice(0, 6).join(', ')}
            </div>
          )}
        </LineageCard>

        <LineageCard title="SQL shape" t={t}>
          <LineageMiniStat label="Outputs" value={sqlSummary.outputs.length} t={t} />
          <LineageMiniStat label="Joins" value={sqlSummary.joins.length} t={t} />
          <LineageMiniStat label="Filters" value={sqlSummary.filters.length} t={t} />
          <LineageMiniStat label="Groups" value={sqlSummary.groupBy.length} t={t} />
        </LineageCard>

        <LineageCard title="Reverse notebook impact" t={t}>
          {downstreamCells.length > 0 ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {downstreamCells.slice(0, 6).map((ref) => (
                <div key={ref.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ color: NODE_TYPE_COLORS.notebook, fontSize: 9, fontWeight: 700, width: 28, flexShrink: 0 }}>
                    {ref.type.toUpperCase().slice(0, 4)}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.label}</span>
                  {ref.handle && <span style={{ color: t.textMuted, fontSize: 10 }}>via {`{{${ref.handle}}}`}</span>}
                </div>
              ))}
            </div>
          ) : (
            <EmptyLineageText t={t}>No downstream notebook cells reference this cell yet.</EmptyLineageText>
          )}
        </LineageCard>
      </div>

      {(sqlSummary.joins.length > 0 || sqlSummary.filters.length > 0 || sqlSummary.groupBy.length > 0 || sqlSummary.orderBy.length > 0) && (
        <LineageCard title="Query logic" t={t}>
          {sqlSummary.joins.length > 0 && (
            <LineageDetailBlock title="Joins" t={t}>
              {sqlSummary.joins.slice(0, 6).map((join, index) => (
                <div key={`${join.table}-${index}`} style={{ color: t.textPrimary }}>
                  <strong>{join.type}</strong> {join.table}{join.alias ? ` as ${join.alias}` : ''}
                  {join.condition ? <span style={{ color: t.textMuted }}> on {join.condition}</span> : null}
                </div>
              ))}
            </LineageDetailBlock>
          )}
          {sqlSummary.filters.length > 0 && (
            <LineageDetailBlock title="Filters" t={t}>
              {sqlSummary.filters.map((filter, index) => (
                <code key={index} style={{ color: t.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{filter}</code>
              ))}
            </LineageDetailBlock>
          )}
          {sqlSummary.groupBy.length > 0 && (
            <LineageDetailBlock title="Group by" t={t}>
              <span>{sqlSummary.groupBy.join(', ')}</span>
            </LineageDetailBlock>
          )}
          {sqlSummary.orderBy.length > 0 && (
            <LineageDetailBlock title="Order by" t={t}>
              <span>{sqlSummary.orderBy.join(', ')}</span>
            </LineageDetailBlock>
          )}
        </LineageCard>
      )}

      {sqlSummary.outputs.length > 0 && (
        <LineageCard title="Output fields" t={t}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {sqlSummary.outputs.slice(0, 16).map((output, index) => (
              <span
                key={`${output}-${index}`}
                style={{
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  padding: '2px 6px',
                  borderRadius: 4,
                  border: `1px solid ${t.cellBorder}`,
                  color: t.textPrimary,
                  background: t.inputBg,
                }}
                title={output}
              >
                {output}
              </span>
            ))}
          </div>
        </LineageCard>
      )}

      {(sqlSummary.semanticRefs.metrics.length > 0 || sqlSummary.semanticRefs.dimensions.length > 0 || businessMatches.length > 0) && (
        <LineageCard title="Business context from detected sources" t={t}>
          {sqlSummary.semanticRefs.metrics.length > 0 && (
            <LineageDetailBlock title="Metrics" t={t}>
              <span>{sqlSummary.semanticRefs.metrics.join(', ')}</span>
            </LineageDetailBlock>
          )}
          {sqlSummary.semanticRefs.dimensions.length > 0 && (
            <LineageDetailBlock title="Dimensions" t={t}>
              <span>{sqlSummary.semanticRefs.dimensions.join(', ')}</span>
            </LineageDetailBlock>
          )}
          {businessMatches.length > 0 ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {businessMatches.map((match) => (
                <div key={`${match.source}-${match.node.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      color: NODE_TYPE_COLORS[match.node.type] ?? t.accent,
                      fontSize: 9,
                      fontWeight: 700,
                      width: 34,
                      flexShrink: 0,
                    }}
                  >
                    {displayNodeType(match.node)}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{match.node.name}</span>
                  {match.node.domain && <span style={{ color: t.textMuted, fontSize: 10 }}>{match.node.domain}</span>}
                  <span style={{ marginLeft: 'auto', color: t.textMuted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    from {match.source}
                  </span>
                </div>
              ))}
            </div>
          ) : loading ? (
            <EmptyLineageText t={t}>Looking up scoped business context...</EmptyLineageText>
          ) : (
            <EmptyLineageText t={t}>No matching business terms, metrics, or saved queries found for these sources.</EmptyLineageText>
          )}
        </LineageCard>
      )}

      {sqlSummary.warnings.length > 0 && (
        <LineageCard title="Review notes" t={t}>
          <div style={{ display: 'grid', gap: 3 }}>
            {sqlSummary.warnings.map((warning) => (
              <div key={warning} style={{ color: t.warning }}>{warning}</div>
            ))}
          </div>
        </LineageCard>
      )}

      {!hasSqlContent && (
        <div style={{ color: t.textMuted, padding: '2px 0' }}>
          No SQL lineage dependencies detected for this cell.
        </div>
      )}
    </div>
  );

  if (!cellContent.trim()) return null;

  return (
    <div style={{ borderTop: `1px solid ${t.cellBorder}` }}>
      {/* Toggle bar */}
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: expanded ? `${t.tableHeaderBg}60` : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textMuted,
          fontSize: 10,
          fontFamily: t.font,
          transition: 'background 0.15s',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
          <circle cx="4" cy="4" r="2" />
          <circle cx="12" cy="8" r="2" />
          <circle cx="4" cy="12" r="2" />
          <line x1="6" y1="4" x2="10" y2="8" />
          <line x1="6" y1="12" x2="10" y2="8" />
        </svg>
        <span>{isSqlCell ? 'Cell SQL lineage' : 'Project saved query lineage'}</span>
        {expanded && (
          <span
            style={{
              marginLeft: 2,
              padding: '1px 5px',
              borderRadius: 999,
              border: `1px solid ${t.cellBorder}`,
              color: t.textMuted,
              background: t.inputBg,
              fontSize: 9,
            }}
          >
            {isSqlCell ? 'cell scoped' : 'project graph'}
          </span>
        )}
        <svg
          width="8" height="8" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
        </svg>
        {/* View in DAG button */}
        {expanded && !isSqlCell && lookupName && onFocusNode && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onFocusNode(`block:${lookupName}`);
            }}
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              color: t.accent,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            View in DAG
          </span>
        )}
      </button>

      {/* Lineage content */}
      {expanded && (
        <div style={{ fontSize: 11 }}>
          {isSqlCell ? (
            <>
              {error && <div style={{ color: t.error, padding: '8px 12px 0' }}>{error}</div>}
              {renderSqlLineageContent()}
            </>
          ) : loading ? (
            <div style={{ color: t.textMuted, padding: '8px 12px' }}>Loading lineage...</div>
          ) : error ? (
            <div style={{ color: t.error, padding: '8px 12px' }}>{error}</div>
          ) : (
            <>
              {/* Mini graph — same view as Block Studio, powered by queryLineage.
                  Height is user-resizable via the bottom drag handle so dense
                  DAGs aren't cropped inside the cell. */}
              {graphNodes.length > 0 && focalNodeId && (
                <div style={{ borderBottom: `1px solid ${t.cellBorder}`, position: 'relative' }}>
                  <MiniLineageGraph
                    nodes={graphNodes}
                    edges={graphEdges}
                    focalNodeId={focalNodeId}
                    height={graphHeight}
                    onNodeClick={onFocusNode}
                    interactive={true}
                    layoutMode="flow"
                  />
                  {/* Drag handle to resize graph height */}
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const startY = e.clientY;
                      const startH = graphHeightRef.current;
                      setResizing(true);
                      const onMove = (ev: MouseEvent) => {
                        const next = Math.min(800, Math.max(160, startH + (ev.clientY - startY)));
                        graphHeightRef.current = next;
                        setGraphHeight(next);
                      };
                      const onUp = () => {
                        setResizing(false);
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                    title="Drag to resize lineage view"
                    style={{
                      position: 'absolute', left: 0, right: 0, bottom: -3,
                      height: 6, cursor: 'row-resize',
                      background: resizing ? t.accent : 'transparent',
                      transition: resizing ? 'none' : 'background 0.15s', zIndex: 5,
                    }}
                    onMouseEnter={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = `${t.accent}40`; }}
                    onMouseLeave={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  />
                </div>
              )}

              <div style={{ padding: '6px 12px 8px' }}>
                {/* Complete Paths */}
                {pathResult && (pathResult.upstreamPaths.length > 0 || pathResult.downstreamPaths.length > 0) && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 4 }}>
                      Complete Paths
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {pathResult.upstreamPaths.slice(0, 3).map((path: LineagePath, i: number) => (
                        <LineagePathBreadcrumb
                          key={`up-${i}`}
                          path={path}
                          onNodeClick={onFocusNode}
                          focalNodeId={focalNodeId}
                          t={t}
                        />
                      ))}
                      {pathResult.downstreamPaths.slice(0, 2).map((path: LineagePath, i: number) => (
                        <LineagePathBreadcrumb
                          key={`down-${i}`}
                          path={path}
                          onNodeClick={onFocusNode}
                          focalNodeId={focalNodeId}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* SQL Dependencies */}
                {sqlSummary.sources.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
                      Reads From ({sqlSummary.sources.length})
                    </div>
                    {sqlSummary.sources.map((source) => (
                      <div key={sourceKey(source)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                        <span style={{ color: source.kind === 'cte' ? t.textMuted : NODE_TYPE_COLORS.source_table, fontSize: 9, fontWeight: 700, width: 26 }}>
                          {source.kind === 'cte' ? 'CTE' : source.kind === 'ref' ? 'REF' : 'TBL'}
                        </span>
                        <span>{source.name}</span>
                        {source.alias && <span style={{ color: t.textMuted }}>as {source.alias}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Semantic References */}
                {sqlSummary.semanticRefs.metrics.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
                      Metrics ({sqlSummary.semanticRefs.metrics.length})
                    </div>
                    {sqlSummary.semanticRefs.metrics.map((m) => (
                      <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                        <span style={{ color: NODE_TYPE_COLORS.metric, fontSize: 9, fontWeight: 700, width: 26 }}>MET</span>
                        <span>{m}</span>
                      </div>
                    ))}
                  </div>
                )}

                {sqlSummary.semanticRefs.dimensions.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
                      Dimensions ({sqlSummary.semanticRefs.dimensions.length})
                    </div>
                    {sqlSummary.semanticRefs.dimensions.map((d) => (
                      <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                        <span style={{ color: NODE_TYPE_COLORS.dimension, fontSize: 9, fontWeight: 700, width: 26 }}>DIM</span>
                        <span>{d}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* No lineage found */}
                {!hasProjectContent && sqlSummary.sources.length === 0 && sqlSummary.semanticRefs.metrics.length === 0 && sqlSummary.semanticRefs.dimensions.length === 0 && (
                  <div style={{ color: t.textMuted, padding: '2px 0' }}>
                    No lineage dependencies detected for this cell.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
