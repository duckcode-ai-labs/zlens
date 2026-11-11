/**
 * "How it was answered" for an AI chat outside Ask (a notebook, an App,
 * a saved query), and the "View steps" link on an answer.
 *
 * It opens over the view it came from, so "Back" leaves that view exactly as
 * it was. It says the same things the Ask page says for the same run:
 *   1. why there is no answer, when there is none: the chat card's own
 *      heading and sentence, then the step where the run stopped;
 *   2. the run's steps from its own record (the same view as Ask);
 *   3. where the time went: each step in plain words, repeated steps folded
 *      into one row with a count.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, CheckCircle2, Clock, Wrench, XCircle } from 'lucide-react';
import type { AgentRun } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { MainView } from '../../store/types';
import { themes, type Theme } from '../../themes/notebook-theme';
import { AskRunFlow } from './AskRunFlow';
import { agentStepsBackLabel, buildAgentStepRows, formatStepMs, isGenericRouteReason, stoppingSteps, type AgentStepRow } from './agent-steps';
import { plainRefs, type RunExplanation } from './ask-run-explanation';
import { askRunAnswerPayload, askRunNoAnswer, useAskRunExplanation, type AskRunNoAnswer } from './UnifiedAgentRunPanel';

export function AgentLogPage(): JSX.Element {
  const { state, dispatch } = useNotebook();
  return (
    <AgentStepsView
      run={state.agentLogRun}
      fromView={state.agentLogFromView}
      t={themes[state.themeMode]}
      onBack={() => dispatch({ type: 'CLOSE_AGENT_LOG' })}
    />
  );
}

/** The page for one run; "Back" (or Escape) returns to the view it was opened from. */
export function AgentStepsView({ run, fromView, t, onBack }: { run: AgentRun | undefined; fromView: MainView | undefined; t: Theme; onBack: () => void }): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backRef.current?.focus();
  }, [run?.id]);

  if (!run) {
    return (
      <div style={{ padding: 32, color: t.textMuted, fontFamily: t.font }}>
        No answer selected. Open one from “How it was answered” on an AI answer.
      </div>
    );
  }

  return (
    <div
      onKeyDown={(event) => {
        // Escape goes back, and stays here: the view underneath must not see it.
        if (event.key === 'Escape') {
          event.stopPropagation();
          onBack();
        }
      }}
      style={{ padding: '20px 28px 32px', fontFamily: t.font, color: t.textPrimary, maxWidth: 900, margin: '0 auto' }}
    >
      <button ref={backRef} type="button" onClick={onBack} style={backLinkStyle(t)}>
        <ArrowLeft size={14} /> {agentStepsBackLabel(fromView)}
      </button>
      <RunSteps run={run} t={t} />
    </div>
  );
}

function RunSteps({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  const payload = useMemo(() => askRunAnswerPayload(run), [run]);
  const { explanation } = useAskRunExplanation(run, payload);
  const noAnswer = askRunNoAnswer(run);
  const rows = useMemo(() => buildAgentStepRows(run), [run]);
  const routeReason = typeof (run.routeDecision as { reason?: unknown } | undefined)?.reason === 'string'
    ? (run.routeDecision as { reason: string }).reason
    : undefined;
  return (
    <>
      <Header run={run} t={t} noAnswer={noAnswer} />
      {noAnswer ? <WhyNoAnswer noAnswer={noAnswer} explanation={explanation} t={t} /> : null}
      {explanation ? (
        <section style={{ marginBottom: 24 }}>
          <SectionTitle t={t}>Step by step</SectionTitle>
          <AskRunFlow explanation={explanation} t={t} />
        </section>
      ) : null}
      <Timeline rows={rows} t={t} />
      {!explanation && !isGenericRouteReason(routeReason) ? (
        <section style={{ marginBottom: 22 }}>
          <SectionTitle t={t}>How it chose to answer</SectionTitle>
          <div style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.5 }}>{plainRefs(routeReason!)}</div>
        </section>
      ) : null}
      {!explanation && run.evaluations.length > 0 ? <Checks run={run} t={t} /> : null}
    </>
  );
}

/** The badge words the Ask page's "How it was answered" panel uses for the same run. */
function outcomeWords(run: AgentRun, noAnswer: AskRunNoAnswer | undefined): string {
  if (noAnswer?.kind === 'cancelled') return 'Cancelled';
  if (noAnswer?.kind === 'clarify') return 'Needs clarification';
  if (noAnswer) return 'Blocked';
  if (run.trustState === 'certified') return 'Certified';
  if (run.trustState === 'governed' || run.trustState === 'grounded') return 'From Metrics';
  return 'AI-generated';
}

function Header({ run, t, noAnswer }: { run: AgentRun; t: Theme; noAnswer: AskRunNoAnswer | undefined }): JSX.Element {
  const totalMs = durationMs(run.startedAt, run.completedAt);
  const words = outcomeWords(run, noAnswer);
  const tone = noAnswer?.kind === 'blocked' ? t.error : noAnswer ? t.textMuted : run.trustState === 'certified' ? t.success : t.accent;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, lineHeight: 1.35 }}>{run.question}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={tonePillStyle(t, tone)}>{words}</span>
        {totalMs != null && totalMs > 0 ? (
          <span style={pillStyle(t)}><Clock size={12} /> {formatStepMs(totalMs)} in all</span>
        ) : null}
      </div>
    </div>
  );
}

function WhyNoAnswer({ noAnswer, explanation, t }: { noAnswer: AskRunNoAnswer; explanation: RunExplanation | undefined; t: Theme }): JSX.Element {
  const tone = noAnswer.kind === 'blocked' ? t.error : t.textMuted;
  const steps = noAnswer.kind === 'blocked' ? stoppingSteps(explanation) : [];
  return (
    <section
      role="status"
      aria-label={noAnswer.kind === 'blocked' ? 'Why there is no answer' : noAnswer.heading}
      style={{ marginBottom: 24, border: `1px solid ${withAlpha(tone, 0.4)}`, borderLeft: `3px solid ${tone}`, borderRadius: 8, padding: '12px 14px', background: t.cellBg }}
    >
      <div style={{ fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.6, color: t.textMuted, marginBottom: 6 }}>
        {noAnswer.kind === 'blocked' ? 'Why there is no answer' : noAnswer.kind === 'clarify' ? 'Why it asked you' : 'Why it stopped'}
      </div>
      <div style={{ fontSize: 14, fontWeight: 650, color: tone, marginBottom: noAnswer.text ? 4 : 0 }}>{noAnswer.heading}</div>
      {noAnswer.text ? (
        <div style={{ fontSize: 13, lineHeight: 1.55, color: t.textPrimary, overflowWrap: 'anywhere' }}>{noAnswer.text}</div>
      ) : null}
      {steps.length ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary }}>Where it stopped</div>
          {steps.map((step) => (
            <div key={step.id} style={{ fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary, overflowWrap: 'anywhere' }}>
              <span style={{ fontWeight: 600, color: t.textPrimary }}>{step.title}:</span> {clip(step.reason, 320)}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Timeline({ rows, t }: { rows: AgentStepRow[]; t: Theme }): JSX.Element | null {
  if (rows.length === 0) return null;
  const slowest = rows.reduce((max, row) => Math.max(max, row.ms), 0);
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionTitle t={t}>Where the time went</SectionTitle>
      <ol aria-label="Where the time went" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((row) => {
          const isSlowest = slowest >= 250 && row.ms === slowest;
          const time = formatStepMs(row.ms);
          return (
            <li
              key={row.key}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 8,
                background: isSlowest ? withAlpha(t.warning, 0.1) : t.cellBg,
                border: `1px solid ${isSlowest ? withAlpha(t.warning, 0.4) : t.cellBorder}`,
              }}
            >
              <span aria-hidden="true" style={{ marginTop: 1, color: row.state === 'failed' ? t.error : row.tool ? t.accent : t.textMuted, flexShrink: 0 }}>
                {row.tool ? <Wrench size={13} /> : row.state === 'failed' ? <XCircle size={13} /> : <span style={{ fontSize: 13 }}>•</span>}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: row.state === 'missed' ? t.textMuted : t.textPrimary }}>
                  {row.label}
                  {row.count > 1 ? <span style={{ color: t.textMuted, fontWeight: 400 }}> · {row.count} times</span> : null}
                </div>
                {row.detail ? (
                  <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2, overflowWrap: 'anywhere' }}>{row.detail}</div>
                ) : null}
                {row.count > 1 && row.longestMs >= 1_000 && row.longestMs < row.ms ? (
                  <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 2 }}>The longest took {formatStepMs(row.longestMs)}.</div>
                ) : null}
              </div>
              <span
                style={{
                  fontSize: 12, fontFamily: t.fontMono, flexShrink: 0, whiteSpace: 'nowrap',
                  color: isSlowest ? t.warning : t.textMuted, fontWeight: isSlowest ? 600 : 400,
                }}
              >
                {time || '—'}
              </span>
            </li>
          );
        })}
      </ol>
      {slowest >= 1_000 ? (
        <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8, lineHeight: 1.5 }}>
          Each time is how long the step took after the one before it. The highlighted step took the longest. Waiting for
          the AI model is usually the slow part; a certified saved query or a metric answers without it.
        </div>
      ) : null}
    </section>
  );
}

function Checks({ run, t }: { run: AgentRun; t: Theme }): JSX.Element {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionTitle t={t}>Checks</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {run.evaluations.map((evaluation) => (
          <div key={evaluation.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
            <span style={{ marginTop: 1, color: evaluation.passed ? t.success : t.error, flexShrink: 0 }}>
              {evaluation.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            </span>
            <div>
              <span style={{ fontWeight: 500 }}>{plainRefs(evaluation.label)}</span>
              {!evaluation.passed && evaluation.message ? (
                <span style={{ color: t.textMuted }}> — {plainRefs(evaluation.message)}</span>
              ) : null}
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

// ── Small helpers ────────────────────────────────────────────────────────────

function durationMs(from?: string, to?: string): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function withAlpha(color: string, alpha: number): string {
  // Accepts #rgb/#rrggbb; falls back to the raw color for non-hex themes.
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const hex = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function backLinkStyle(t: Theme): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16,
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: t.textSecondary, fontSize: 13, fontFamily: t.font, padding: 0,
  };
}

function pillStyle(t: Theme): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, padding: '3px 9px', borderRadius: 999,
    background: t.pillBg, border: `1px solid ${t.cellBorder}`, color: t.textSecondary,
  };
}

function tonePillStyle(t: Theme, tone: string): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, padding: '3px 9px', borderRadius: 999,
    background: withAlpha(tone, 0.12), border: `1px solid ${withAlpha(tone, 0.4)}`, color: tone, fontWeight: 600,
  };
}
