import type { Cell, CellChartConfig, SingleValueCellConfig } from '../store/types';

export interface DerivedBlockSource {
  /** Raw .dql block body (SQL + optional visualization block). */
  content: string;
  /** Suggested block name for the prefill. */
  suggestedName?: string;
  /** Suggested description for the prefill. */
  suggestedDescription?: string;
  /** Whether the cell carries its own content (sql/dql) vs deriving from an upstream. */
  derivedFromUpstream: boolean;
  /** User-facing reason this cell can't be promoted yet, if any. */
  blocker?: string;
}

function findUpstreamSql(cell: Cell, cells: Cell[]): { name?: string; sql: string } | null {
  const upstreamName = cell.upstream
    ?? cell.singleValueConfig?.upstream
    ?? cell.filterConfig?.upstream
    ?? cell.pivotConfig?.upstream
    ?? cell.tableConfig?.upstream;
  if (!upstreamName) return null;
  const upstream = cells.find((c) => c.name === upstreamName && (c.type === 'sql' || c.type === 'dql'));
  if (!upstream || !upstream.content.trim()) return null;
  return { name: upstream.name, sql: upstream.content.trim() };
}

function visualizationBlockFor(cfg: CellChartConfig | undefined): string {
  if (!cfg || !cfg.chart) return '';
  const lines = [`chart = "${cfg.chart}"`];
  if (cfg.x) lines.push(`x = ${cfg.x}`);
  if (cfg.y) lines.push(`y = ${cfg.y}`);
  if (cfg.color) lines.push(`color = ${cfg.color}`);
  if (cfg.facet) lines.push(`facet = ${cfg.facet}`);
  return `\n  visualization {\n    ${lines.join('\n    ')}\n  }`;
}

function singleValueVisualization(cfg: SingleValueCellConfig | undefined): string {
  if (!cfg) return '';
  const lines = [`chart = "kpi"`];
  if (cfg.metric) lines.push(`y = ${cfg.metric}`);
  if (cfg.format) lines.push(`format = "${cfg.format}"`);
  if (cfg.label) lines.push(`label = "${cfg.label.replace(/"/g, '\\"')}"`);
  return `\n  visualization {\n    ${lines.join('\n    ')}\n  }`;
}

function wrapAsBlockBody(sql: string, viz: string): string {
  const indented = sql.replace(/^/gm, '    ');
  return `  query = """\n${indented}\n  """${viz}`;
}

export function deriveBlockSource(cell: Cell, cells: Cell[]): DerivedBlockSource {
  if (cell.type === 'sql' || cell.type === 'dql') {
    return {
      content: cell.content,
      suggestedName: cell.name,
      derivedFromUpstream: false,
      blocker: cell.content.trim() ? undefined : 'Cell is empty — add a SQL query first.',
    };
  }

  if (cell.type === 'markdown' || cell.type === 'param' || cell.type === 'map' || cell.type === 'writeback' || cell.type === 'python') {
    return {
      content: '',
      derivedFromUpstream: false,
      blocker: `${cell.type} cells cannot be promoted to saved queries yet.`,
    };
  }

  const upstream = findUpstreamSql(cell, cells);
  if (!upstream) {
    return {
      content: '',
      derivedFromUpstream: true,
      blocker: 'No upstream SQL cell is wired — pick an upstream dataframe before saving as a saved query.',
    };
  }

  let viz = '';
  let suggestedName: string | undefined;
  let suggestedDescription: string | undefined;
  switch (cell.type) {
    case 'chart':
      viz = visualizationBlockFor(cell.chartConfig);
      suggestedName = cell.name ?? (upstream.name ? `${upstream.name}_chart` : 'chart_block');
      suggestedDescription = cell.chartConfig?.title
        ?? (cell.chartConfig?.chart ? `${cell.chartConfig.chart} of ${upstream.name ?? 'upstream'}` : undefined);
      break;
    case 'single_value':
      viz = singleValueVisualization(cell.singleValueConfig);
      suggestedName = cell.name
        ?? (cell.singleValueConfig?.label ? cell.singleValueConfig.label : `${upstream.name ?? 'metric'}_kpi`);
      suggestedDescription = cell.singleValueConfig?.label;
      break;
    case 'filter':
    case 'pivot':
    case 'table':
      suggestedName = cell.name ?? (upstream.name ? `${upstream.name}_${cell.type}` : `${cell.type}_block`);
      break;
  }

  return {
    content: wrapAsBlockBody(upstream.sql, viz),
    suggestedName,
    suggestedDescription,
    derivedFromUpstream: true,
  };
}
