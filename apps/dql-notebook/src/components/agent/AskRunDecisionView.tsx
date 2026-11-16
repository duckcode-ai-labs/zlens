/**
 * The full trace of an Ask pipeline run: a headline with the steps as chips,
 * then the decision flow graph beside the details of the selected node — the
 * AI reply, the checks, the SQL and DQL that ran and a sample of the rows.
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AskTraceDataV1 } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';
import { OUTCOME_WORDS, formatRunMs, rowCountWords, type RunExplanation } from './ask-run-explanation';
import { DECISION_NODE_HEIGHT, DECISION_NODE_WIDTH, decisionFlowGraph, layoutDecisionFlow, type DecisionNode } from './ask-run-graph';
import { AiCallList, AskRunChecks, AskRunDataUsed } from './AskRunFlow';

const nodeColor = (node: Pick<DecisionNode, 'outcome' | 'kind' | 'subtitle'>, t: Theme): string => {
  if (node.outcome === 'failed') return t.error;
  if (node.kind === 'end') return node.subtitle === 'No answer' || node.outcome === 'not_found' ? t.warning : t.accent;
  if (node.outcome === 'done') return t.success;
  return t.textMuted;
};

/** The headline and the steps as a row of chips, at the top of the trace page. */
export function AskRunTraceSummary({ explanation, t }: { explanation: RunExplanation; t: Theme }): JSX.Element {
  const attention = explanation.ending === 'failed' || explanation.ending === 'gap';
  return (
    <section aria-label="Ask decision story" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${explanation.ending === 'failed' ? t.error : attention ? t.warning : t.success}`, borderRadius: 11, background: t.cellBg }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary, lineHeight: 1.45 }}>{explanation.headline}</div>
      <div style={{ marginTop: 3, fontSize: 11.5, color: t.textMuted }}>
        {[explanation.totalMs !== undefined ? `Worked for ${formatRunMs(explanation.totalMs) || 'under a second'}` : '', `${explanation.aiCalls.length} AI call${explanation.aiCalls.length === 1 ? '' : 's'}`, explanation.timings.warehouseMs !== undefined ? `warehouse ${formatRunMs(explanation.timings.warehouseMs) || 'under 50 ms'}` : ''].filter(Boolean).join(' · ')}
      </div>
      <ol aria-label="Steps" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {explanation.steps.map((step) => {
          const color = step.outcome === 'failed' ? t.error : step.kind === 'gap' ? t.warning : step.outcome === 'done' ? t.success : t.textMuted;
          return (
            <li key={step.id} title={step.reason} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', border: `1px solid ${color}`, borderStyle: step.outcome === 'skipped' || step.outcome === 'not_reached' ? 'dashed' : 'solid', borderRadius: 999, fontSize: 11.5, color: t.textSecondary }}>
              <span style={{ color, fontWeight: 700 }}>{step.n}</span>
              {step.title}
              <span style={{ color: t.textMuted }}>{OUTCOME_WORDS[step.outcome]}{step.ms !== undefined && formatRunMs(step.ms) ? ` · ${formatRunMs(step.ms)}` : ''}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export type DecisionNodeData = { node: DecisionNode; t: Theme };

function DecisionFlowNode({ data, selected }: NodeProps): JSX.Element {
  const { node, t } = data as DecisionNodeData;
  const color = nodeColor(node, t);
  const muted = node.outcome === 'skipped' || node.outcome === 'not_reached' || node.outcome === 'refused' || (node.outcome === 'not_found' && node.kind !== 'end');
  return (
    <div style={{ width: DECISION_NODE_WIDTH, height: DECISION_NODE_HEIGHT, boxSizing: 'border-box', background: t.cellBg, border: `${selected ? 2.5 : 1.5}px ${muted ? 'dashed' : 'solid'} ${selected ? t.accent : color}`, borderRadius: 9, padding: '7px 9px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, cursor: 'pointer', boxShadow: selected ? `0 0 0 3px ${t.accent}22` : 'none' }}>
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6, background: color, border: 'none' }} />
      <div style={{ fontSize: 11.5, fontWeight: 650, color: muted ? t.textMuted : t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font }} title={node.title}>
        {node.title}{node.count && node.count > 1 ? ` ×${node.count}` : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.subtitle ?? OUTCOME_WORDS[node.outcome]}</span>
        {node.kind !== 'call' && formatRunMs(node.ms) ? <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatRunMs(node.ms)}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6, background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { decision: DecisionFlowNode };
/** The decision node renderer, shared with the Research investigation flow. */
export const decisionNodeTypes = nodeTypes;

const detailLabel = (t: Theme): React.CSSProperties => ({ fontSize: 10.5, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 6px' });
const detailCode = (t: Theme): React.CSSProperties => ({ margin: 0, maxHeight: 260, overflow: 'auto', border: `1px solid ${t.cellBorder}`, background: t.editorBg, color: t.textPrimary, borderRadius: 7, padding: 9, fontSize: 11, lineHeight: 1.45, fontFamily: t.fontMono, whiteSpace: 'pre-wrap', wordBreak: 'break-word' });

function RowsSample({ answer, t }: { answer: NonNullable<AskTraceDataV1['runtimeAnswerV1']>; t: Theme }): JSX.Element | null {
  const columns = (answer.columns ?? []).map((column) => (typeof column === 'string' ? column : column.name)).filter(Boolean);
  const rows = answer.rowsSample ?? [];
  if (columns.length === 0 || rows.length === 0) return null;
  const cell = (value: unknown) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  return (
    <>
      <div style={detailLabel(t)}>Rows ({answer.rowCount ?? rows.length}{answer.rowCount !== undefined && answer.rowCount > rows.length ? `, first ${rows.length} shown` : ''})</div>
      <div style={{ overflowX: 'auto', border: `1px solid ${t.cellBorder}`, borderRadius: 7 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead><tr>{columns.map((column) => <th key={column} style={{ textAlign: 'left', padding: '5px 7px', background: t.tableHeaderBg, color: t.textMuted, whiteSpace: 'nowrap' }}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column, columnIndex) => (
                  <td key={column} style={{ padding: '4px 7px', borderTop: `1px solid ${t.cellBorder}`, color: t.textSecondary, whiteSpace: 'nowrap' }}>
                    {cell(Array.isArray(row) ? row[columnIndex] : (row as Record<string, unknown>)[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DecisionNodeDetail({ node, explanation, answer, t }: { node: DecisionNode | undefined; explanation: RunExplanation; answer: AskTraceDataV1['runtimeAnswerV1']; t: Theme }): JSX.Element {
  if (!node) return <section style={{ padding: 18, border: `1px solid ${t.cellBorder}`, borderRadius: 11, background: t.cellBg, color: t.textMuted, fontSize: 12 }}>Select a step in the flow to see what happened there.</section>;
  const step = explanation.steps.find((entry) => entry.id === node.stepId);
  const color = nodeColor(node, t);
  const showAnswer = node.kind === 'warehouse' || node.kind === 'end';
  return (
    <section aria-label="Step details" style={{ padding: '16px 18px', minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 11, background: t.cellBg }}>
      {step && step.title !== node.title ? <div style={{ fontSize: 11, color: t.textMuted }}>{step.n}. {step.title}</div> : null}
      <h2 style={{ margin: '2px 0 0', fontSize: 15, color: t.textPrimary }}>{node.title}{node.count && node.count > 1 ? ` ×${node.count}` : ''}</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 11.5, color: t.textMuted }}>
        <span style={{ color, fontWeight: 700 }}>{node.subtitle && node.kind === 'end' ? node.subtitle : OUTCOME_WORDS[node.outcome]}</span>
        {formatRunMs(node.ms) ? <span>{formatRunMs(node.ms)}</span> : null}
      </div>
      {step ? <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>{step.reason}</p> : null}
      {node.calls?.length ? (<><div style={detailLabel(t)}>{node.calls.length === 1 ? 'AI call' : 'AI calls'}</div><AiCallList calls={node.calls} t={t} openReplies={node.calls.length === 1} /></>) : null}
      {node.checks?.length ? (<><div style={detailLabel(t)}>Checks</div><AskRunChecks checks={node.checks} t={t} /></>) : null}
      {showAnswer && answer?.dqlArtifact?.source ? (<><div style={detailLabel(t)}>DQL</div><pre style={detailCode(t)}>{answer.dqlArtifact.source}</pre></>) : null}
      {showAnswer && answer?.sql ? (<><div style={detailLabel(t)}>{answer.sqlLiteralsMasked ? 'SQL that ran (its values shown as ?)' : 'SQL that ran'}</div><pre style={detailCode(t)}>{answer.sql}</pre></>) : null}
      {node.kind === 'warehouse' && answer?.rowCountBucket && !answer.rowsSample ? <p style={{ margin: '10px 0 0', fontSize: 12, color: t.textMuted }}>{rowCountWords(answer.rowCountBucket)}; the rows are the asker's to see.</p> : null}
      {node.kind === 'warehouse' && answer ? <RowsSample answer={answer} t={t} /> : null}
      {node.kind === 'end' ? (<><div style={detailLabel(t)}>Data used</div><AskRunDataUsed data={explanation.dataUsed} t={t} /></>) : null}
      {step?.notes.length ? (<><div style={detailLabel(t)}>Notes</div><ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: t.textSecondary, display: 'grid', gap: 3 }}>{step.notes.map((note) => <li key={note}>{note}</li>)}</ul></>) : null}
      {step?.story.length && node.kind !== 'call' ? (
        <>
          <div style={detailLabel(t)}>What it did</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {step.story.map((entry, index) => (
              <li key={`${entry.at}-${index}`} style={{ fontSize: 12, color: entry.state === 'done' ? t.textSecondary : t.textMuted }}>
                <div style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1, minWidth: 0 }}>{entry.title}</span><span style={{ fontSize: 11, color: t.textMuted }}>{formatRunMs(entry.ms)}</span></div>
                {entry.detail ? <pre style={{ ...detailCode(t), marginTop: 4, maxHeight: 180 }}>{entry.detail}</pre> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function AskRunDecisionView({ trace, explanation, t, isNarrow }: { trace: AskTraceDataV1; explanation: RunExplanation; t: Theme; isNarrow: boolean }): JSX.Element {
  const flow = useMemo(() => decisionFlowGraph(explanation), [explanation]);
  const positions = useMemo(() => layoutDecisionFlow(flow), [flow]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => (flow.nodes.find((node) => node.outcome === 'failed') ?? flow.nodes[flow.nodes.length - 1])?.id);
  // ReactFlow shows a node only once it has measured it, and measurements reach
  // the nodes through onNodesChange: the nodes live in its state, not in props.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(flow.nodes.map((node) => ({
      id: node.id,
      type: 'decision',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, t } satisfies DecisionNodeData,
      selected: node.id === selectedId,
      draggable: false,
    })));
    setEdges(flow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      style: { stroke: t.textMuted, strokeWidth: 1.3 },
      labelStyle: { fontSize: 10, fill: t.textMuted },
      labelBgStyle: { fill: t.cellBg },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: t.textMuted },
    })));
    // The selection is ReactFlow's to track after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, positions, t, setNodes, setEdges]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? 'minmax(0, 1fr)' : 'minmax(0, 1.35fr) minmax(300px, 0.65fr)', gap: 14, alignItems: 'start', margin: '0 0 14px' }}>
      <div aria-label="Decision flow" style={{ height: isNarrow ? 320 : 440, border: `1px solid ${t.cellBorder}`, borderRadius: 11, overflow: 'hidden', background: t.appBg }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={t.cellBorder} gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <DecisionNodeDetail node={flow.nodes.find((node) => node.id === selectedId)} explanation={explanation} answer={trace.runtimeAnswerV1} t={t} />
    </div>
  );
}
