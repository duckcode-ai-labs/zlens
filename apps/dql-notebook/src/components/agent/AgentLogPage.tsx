/**
 * Agent Steps (agent_log) page.
 *
 * A dedicated, shareable view of ONE agent run's trace — opened by the "View steps"
 * link on any AI answer. It answers the two questions users actually ask about a
 * run: "what did the agent do?" and "where did the time go?". Built entirely from
 * the AgentRun the engine already returns (events carry `at` timestamps; the run
 * carries route decision, plan, evaluations, and trust), so it needs no new backend.
 */
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, CheckCircle2, XCircle, Clock, GitBranch, Wrench } from 'lucide-react';
import type { AgentRun, AgentRunEvent } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';

export function AgentLogPage(): JSX.Element {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const run = state.agentLogRun;

  if (!run) {
    return (
      <div style={{ padding: 32, color: t.textMuted, fontFamily: t.font }}>
        No agent run selected. Open one from the “View steps” link on an AI answer.
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 28px', fontFamily: t.font, color: t.textPrimary, maxWidth: 900, margin: '0 auto' }}>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })}
        style={backLinkStyle(t)}
      >
        <ArrowLeft size={14} /> Back to Ask AI
      </button>

      <Header run={run} t={t} />
      <Timeline run={run} t={t} />
      {routeDecisionInfo(run).reason && <RouteRationale run={run} t={t} />}
      {run.evaluations.length > 0 && <Checks run={run} t={t} />}
    </div>
  );
}

function Header({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  const totalMs = durationMs(run.startedAt, run.completedAt);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, lineHeight: 1.35 }}>{run.question}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={pillStyle(t)}><GitBranch size={12} /> {routeLabel(run.route)}</span>
        <span style={trustPillStyle(t, run.trustState)}>{trustLabel(run.trustState)}</span>
        {totalMs != null && (
          <span style={pillStyle(t)}><Clock size={12} /> {formatMs(totalMs)} total</span>
        )}
        <span style={{ ...pillStyle(t), color: t.textMuted }}>{run.status}</span>
      </div>
    </div>
  );
}

interface TimelineRow {
  key: string;
  label: string;
  detail?: string;
  deltaMs: number;
  isTool: boolean;
}

function Timeline({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  const rows = useMemo(() => buildTimeline(run), [run]);
  const slowest = rows.reduce((max, r) => Math.max(max, r.deltaMs), 0);
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionTitle t={t}>What the agent did · where the time went</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((row) => {
          const isSlowest = slowest > 0 && row.deltaMs === slowest && row.deltaMs >= 250;
          return (
            <div
              key={row.key}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 8,
                background: isSlowest ? withAlpha(t.warning, 0.1) : t.cellBg,
                border: `1px solid ${isSlowest ? withAlpha(t.warning, 0.4) : t.cellBorder}`,
              }}
            >
              <span style={{ marginTop: 1, color: row.isTool ? t.accent : t.textMuted, flexShrink: 0 }}>
                {row.isTool ? <Wrench size={13} /> : <span style={{ fontSize: 13 }}>•</span>}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{row.label}</div>
                {row.detail && (
                  <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2, wordBreak: 'break-word' }}>{row.detail}</div>
                )}
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  color: isSlowest ? t.warning : t.textMuted,
                  fontWeight: isSlowest ? 600 : 400,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {row.deltaMs > 0 ? `+${formatMs(row.deltaMs)}` : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {slowest >= 1000 && (
        <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8 }}>
          The highlighted step took the longest. Long generation/tool steps usually mean the
          question fell through to LLM generation — a governed metric or certified saved query would answer it instantly.
        </div>
      )}
    </section>
  );
}

function RouteRationale({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  const decision = routeDecisionInfo(run);
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionTitle t={t}>Why this route</SectionTitle>
      <div style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.5 }}>
        {decision.reason}
        {typeof decision.confidence === 'number' && (
          <span style={{ color: t.textMuted }}> · confidence {(decision.confidence * 100).toFixed(0)}%</span>
        )}
      </div>
    </section>
  );
}

/** The client re-exports AgentRun with a loosely-typed routeDecision; read it safely. */
function routeDecisionInfo(run: AgentRun): { reason?: string; confidence?: number } {
  const decision = run.routeDecision as { reason?: unknown; confidence?: unknown } | undefined;
  return {
    reason: typeof decision?.reason === 'string' ? decision.reason : undefined,
    confidence: typeof decision?.confidence === 'number' ? decision.confidence : undefined,
  };
}

function Checks({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionTitle t={t}>Governance checks</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {run.evaluations.map((evaluation) => (
          <div key={evaluation.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
            <span style={{ marginTop: 1, color: evaluation.passed ? t.success : t.error, flexShrink: 0 }}>
              {evaluation.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            </span>
            <div>
              <span style={{ fontWeight: 500 }}>{evaluation.label}</span>
              {!evaluation.passed && evaluation.message && (
                <span style={{ color: t.textMuted }}> — {evaluation.message}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ t, children }: { t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: t.textMuted, marginBottom: 10 }}>
      {children}
    </div>
  );
}

// ── Timeline construction ────────────────────────────────────────────────────

/**
 * Build an ordered, timed row per meaningful event. Each row's `deltaMs` is the
 * gap since the previous event — that gap is where the wall-clock actually went,
 * so the slow step (a generation call, a tool round-trip) stands out.
 */
function buildTimeline(run: AgentRun): TimelineRow[] {
  const events = [...run.events].sort((a, b) => a.at.localeCompare(b.at));
  const rows: TimelineRow[] = [];
  let prevAt = run.startedAt ?? events[0]?.at;
  for (const event of events) {
    const label = eventLabel(event);
    if (!label) continue;
    const delta = durationMs(prevAt, event.at) ?? 0;
    rows.push({
      key: event.id,
      label,
      detail: eventDetail(event),
      deltaMs: delta,
      isTool: isToolEvent(event),
    });
    prevAt = event.at;
  }
  return rows;
}

function isToolEvent(event: AgentRunEvent): boolean {
  const payload = event.payload as { tool?: unknown } | undefined;
  return typeof payload?.tool === 'string';
}

/** Human, specific label for an event — "what the agent is actually doing". */
function eventLabel(event: AgentRunEvent): string | null {
  switch (event.type) {
    case 'run.started': return 'Started';
    case 'route.decided': return `Routed to ${routeLabel(event.route)}`;
    case 'plan.created': return 'Planned the approach';
    case 'step.started': return stepGoalLabel(event) ?? 'Working';
    case 'executor.started': return executorLabel(event.route);
    case 'evaluation.recorded': return 'Checked grounding & trust';
    case 'repair.attempted': return 'Repaired and retried';
    case 'replan.decided': return 'Re-planned';
    case 'escalated': return 'Escalated to a deeper approach';
    case 'artifact.created': return 'Produced the answer';
    case 'step.completed': return 'Step complete';
    case 'run.completed': return 'Done';
    case 'run.cancelled': return 'Stopped by user';
    case 'run.failed': return 'Failed';
    default: return null;
  }
}

function eventDetail(event: AgentRunEvent): string | undefined {
  const payload = event.payload as { tool?: string; message?: string } | undefined;
  if (typeof payload?.tool === 'string') return `tool: ${payload.tool}`;
  if (event.type === 'route.decided' || event.type === 'run.failed' || event.type === 'run.cancelled') return event.message || undefined;
  return undefined;
}

function stepGoalLabel(event: AgentRunEvent): string | null {
  const goal = (event.payload as { goal?: string } | undefined)?.goal;
  return goal ? `Working on: ${truncate(goal, 80)}` : null;
}

function executorLabel(route: AgentRun['route'] | undefined): string {
  switch (route) {
    case 'certified_answer': return 'Searching certified saved queries & governed metrics';
    case 'generated_answer': return 'Composing the answer (semantic compile → generation)';
    case 'research': return 'Researching across governed data';
    case 'app_build': return 'Assembling the app';
    case 'sql_cell': return 'Writing the query';
    case 'dql_block_draft': return 'Drafting the saved query';
    case 'modeling_draft': return 'Drafting modeling changes';
    case 'skill_draft': return 'Drafting Skill guidance';
    case 'conversation': return 'Replying';
    default: return 'Working';
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function routeLabel(route: AgentRun['route'] | undefined): string {
  return route ? route.replace(/_/g, ' ') : 'the answer';
}

function trustLabel(trust: AgentRun['trustState']): string {
  return String(trust).replace(/_/g, ' ');
}

function durationMs(from?: string, to?: string): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function withAlpha(color: string, alpha: number): string {
  // Accepts #rgb/#rrggbb; falls back to the raw color for non-hex themes.
  const hex = color.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return color;
  let r: number, g: number, b: number;
  if (match[1].length === 3) {
    r = parseInt(match[1][0] + match[1][0], 16);
    g = parseInt(match[1][1] + match[1][1], 16);
    b = parseInt(match[1][2] + match[1][2], 16);
  } else {
    r = parseInt(match[1].slice(0, 2), 16);
    g = parseInt(match[1].slice(2, 4), 16);
    b = parseInt(match[1].slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function backLinkStyle(t: Theme): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16,
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: t.textMuted, fontSize: 13, fontFamily: t.font, padding: 0,
  };
}

function pillStyle(t: Theme): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, padding: '3px 9px', borderRadius: 999,
    background: t.pillBg, border: `1px solid ${t.cellBorder}`, color: t.textSecondary,
  };
}

function trustPillStyle(t: Theme, trust: AgentRun['trustState']): CSSProperties {
  const tone = trust === 'certified' ? t.success : trust === 'blocked' ? t.error : t.accent;
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, padding: '3px 9px', borderRadius: 999,
    background: withAlpha(tone, 0.12), border: `1px solid ${withAlpha(tone, 0.4)}`, color: tone, fontWeight: 500,
  };
}
