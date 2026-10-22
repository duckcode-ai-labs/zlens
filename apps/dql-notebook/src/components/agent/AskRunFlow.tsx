/**
 * "How it was answered" for an Ask pipeline run: the numbered steps the run
 * took, each with its outcome, time and reason in plain words; opening a step
 * shows its AI calls and replies, its checks, the SQL it wrote and what it did.
 * Rendered from `explainAskRun`; the DQL and SQL tabs stay where they are.
 */
import { useState } from 'react';
import type React from 'react';
import { Check, ChevronDown, ChevronRight, GitBranch, X } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import { OUTCOME_WORDS, formatRunMs, type RunAiCall, type RunCheck, type RunDataUsed, type RunExplanation, type RunStep } from './ask-run-explanation';

export type AskRunFlowTab = 'dql' | 'sql' | 'data' | 'checks';

const ENDING_COLORS = (t: Theme): Record<RunExplanation['ending'], string> => ({
  answered: t.success,
  gap: t.warning,
  clarify: t.accent,
  failed: t.error,
  conversation: t.textMuted,
});

function stepColor(step: Pick<RunStep, 'kind' | 'outcome'>, t: Theme): string {
  if (step.outcome === 'failed') return t.error;
  if (step.kind === 'gap') return t.warning;
  if (step.outcome === 'done') return t.success;
  return t.textMuted;
}

const sectionLabel = (t: Theme): React.CSSProperties => ({ fontSize: 10.5, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '10px 0 5px' });
const codeBlock = (t: Theme, maxHeight = 220): React.CSSProperties => ({ margin: '4px 0 0', maxHeight, overflow: 'auto', border: `1px solid ${t.headerBorder}`, background: t.editorBg, color: t.textPrimary, borderRadius: 7, padding: 8, fontSize: 11, lineHeight: 1.45, fontFamily: t.fontMono, whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
const linkButton = (t: Theme): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: t.accent, fontSize: 11.5, fontFamily: t.font, fontWeight: 650 });

function chip(text: string, color: string, t: Theme): JSX.Element {
  return <span style={{ border: `1px solid ${color}`, color, borderRadius: 999, padding: '0 6px', fontSize: 10, fontWeight: 650, lineHeight: '15px', whiteSpace: 'nowrap', fontFamily: t.font }}>{text}</span>;
}

function sentSize(chars: number | undefined): string {
  if (chars === undefined) return '';
  return chars >= 1_000 ? `${Math.round(chars / 1_000)}k characters sent` : `${chars} characters sent`;
}

const CALL_OUTCOME_WORDS: Record<NonNullable<RunAiCall['outcome']>, string> = { sql: 'Wrote SQL', declined: 'Declined', rejected: 'Rejected', error: 'Error', accepted: 'Answers it', revise: 'Asked for a revision' };

/** AI calls with what each was for, how long it took, how much was sent and what came back. */
export function AiCallList({ calls, t, openReplies = false }: { calls: RunAiCall[]; t: Theme; openReplies?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {calls.map((call, index) => (
        <div key={`${call.label}-${index}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '6px 8px', background: 'var(--bg-1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11.5, color: t.textPrimary }}>
            <span style={{ fontWeight: 650 }}>{call.label}</span>
            {call.outcome ? chip(CALL_OUTCOME_WORDS[call.outcome], call.outcome === 'sql' || call.outcome === 'accepted' ? t.success : call.outcome === 'declined' ? t.textMuted : call.outcome === 'revise' ? t.warning : t.error, t) : null}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10.5, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{[formatRunMs(call.ms), sentSize(call.promptChars)].filter(Boolean).join(' · ')}</span>
          </div>
          {call.reply ? (
            <details open={openReplies} style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textMuted, listStyle: 'none' }}>Reply</summary>
              <pre style={codeBlock(t, 260)}>{call.reply}</pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The checks a statement was held to, grouped by the draft they judged. */
export function AskRunChecks({ checks, t }: { checks: RunCheck[]; t: Theme }): JSX.Element {
  if (checks.length === 0) return <div style={{ fontSize: 12, color: t.textMuted }}>No checks were recorded for this answer.</div>;
  const attempts = [...new Set(checks.map((check) => check.attempt))];
  const grouped = attempts.length > 1 || (attempts[0] ?? 0) > 1;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {attempts.map((attempt) => {
        const group = checks.filter((check) => check.attempt === attempt);
        return (
          <div key={String(attempt)} style={{ display: 'grid', gap: 5 }}>
            {grouped && attempt !== undefined ? <div style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary }}>Draft {attempt}</div> : null}
            {group.map((check, index) => (
              <div key={`${check.label}-${index}`} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', gap: 7, alignItems: 'start' }}>
                <span aria-label={check.passed ? 'Passed' : 'Failed'} style={{ color: check.passed ? t.success : t.error, lineHeight: '16px' }}>
                  {check.passed ? <Check size={12} strokeWidth={2.4} /> : <X size={12} strokeWidth={2.4} />}
                </span>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <span style={{ display: 'block', fontSize: 12, color: t.textPrimary, fontWeight: 600 }}>{check.label}</span>
                  {check.message ? <span style={{ display: 'block', fontSize: 11.5, color: t.textMuted, lineHeight: 1.45 }}>{check.message}</span> : null}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** What the answer read: tables, joins, metrics, filters and the rules applied. */
export function AskRunDataUsed({ data, t }: { data: RunDataUsed; t: Theme }): JSX.Element {
  const sections: Array<[string, string[]]> = ([
    ['Certified saved query', data.certifiedBlock ? [data.certifiedBlock] : []],
    ['Metrics', data.metrics],
    ['Dimensions', data.dimensions],
    ['Tables', data.tables],
    ['Joins', data.joins],
    ['Filters applied', data.filters],
    ['Required filters and policies', data.policies],
    ['Notes', data.notes],
  ] as Array<[string, string[]]>).filter(([, values]) => values.length > 0);
  if (sections.length === 0) return <div style={{ fontSize: 12, color: t.textMuted }}>Nothing was recorded about the data this answer used.</div>;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {sections.map(([label, values]) => (
        <div key={label}>
          <div style={sectionLabel(t)}>{label}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 3 }}>
            {values.map((value) => (
              <li key={value} style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45, overflowWrap: 'anywhere', fontFamily: label === 'Tables' || label === 'Filters applied' ? t.fontMono : t.font }}>{value}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FlowStep({ step, last, open, onToggle, t, onOpenTab }: { step: RunStep; last: boolean; open: boolean; onToggle: () => void; t: Theme; onOpenTab?: (tab: AskRunFlowTab) => void }): JSX.Element {
  const color = stepColor(step, t);
  const expandable = step.aiCalls.length > 0 || step.checks.length > 0 || step.notes.length > 0 || step.story.length > 0 || Boolean(step.sql);
  const sqlLines = step.sql?.split('\n') ?? [];
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', columnGap: 10 }}>
      <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ width: 20, height: 20, borderRadius: 999, border: `1.5px solid ${color}`, color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 700, background: 'var(--bg-2)', flexShrink: 0 }}>{step.n}</span>
        {last ? null : <span style={{ flex: 1, width: 1.5, minHeight: 10, background: 'var(--border-subtle)' }} />}
      </span>
      <div style={{ minWidth: 0, paddingBottom: last ? 0 : 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
          {expandable ? (
            <button type="button" aria-expanded={open} onClick={onToggle} className="dql-hover" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: t.textPrimary, fontSize: 12.5, fontWeight: 650, fontFamily: t.font, textAlign: 'left' }}>
              {step.title}
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          ) : (
            <span style={{ color: t.textPrimary, fontSize: 12.5, fontWeight: 650 }}>{step.title}</span>
          )}
          {chip(OUTCOME_WORDS[step.outcome], color, t)}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{formatRunMs(step.ms)}</span>
        </div>
        <div style={{ marginTop: 2, fontSize: 11.5, lineHeight: 1.45, color: step.outcome === 'done' ? t.textSecondary : t.textMuted, overflowWrap: 'anywhere' }}>{step.reason}</div>
        {open ? (
          <div style={{ marginTop: 4 }}>
            {step.aiCalls.length ? (<><div style={sectionLabel(t)}>AI calls</div><AiCallList calls={step.aiCalls} t={t} /></>) : null}
            {step.sql ? (
              <>
                <div style={sectionLabel(t)}>SQL it wrote</div>
                <pre style={codeBlock(t, 160)}>{sqlLines.slice(0, 12).join('\n')}{sqlLines.length > 12 ? '\n…' : ''}</pre>
                {onOpenTab ? <button type="button" onClick={() => onOpenTab('sql')} style={{ ...linkButton(t), marginTop: 5 }}>Open SQL tab</button> : null}
              </>
            ) : null}
            {step.checks.length ? (<><div style={sectionLabel(t)}>Checks</div><AskRunChecks checks={step.checks} t={t} /></>) : null}
            {step.notes.length ? (
              <>
                <div style={sectionLabel(t)}>Notes</div>
                <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 3 }}>
                  {step.notes.map((note) => <li key={note} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45 }}>{note}</li>)}
                </ul>
              </>
            ) : null}
            {step.story.length ? (
              <>
                <div style={sectionLabel(t)}>What it did</div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {step.story.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} style={{ fontSize: 11.5, lineHeight: 1.45, color: entry.state === 'done' ? t.textSecondary : t.textMuted }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{entry.title}</span>
                        <span style={{ fontSize: 10.5, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{formatRunMs(entry.ms)}</span>
                      </div>
                      {entry.detail ? (
                        <details>
                          <summary style={{ cursor: 'pointer', fontSize: 10.5, color: t.textMuted, listStyle: 'none' }}>Details</summary>
                          <pre style={codeBlock(t, 180)}>{entry.detail}</pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function AskRunFlow({ explanation, t, onOpenTab, onOpenTrace }: { explanation: RunExplanation; t: Theme; onOpenTab?: (tab: AskRunFlowTab) => void; onOpenTrace?: () => void }): JSX.Element {
  // A step that failed opens by itself: that is where the reader will look first.
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(explanation.steps.filter((step) => step.outcome === 'failed').map((step) => [step.id, true])));
  const color = ENDING_COLORS(t)[explanation.ending];
  const summary = [
    explanation.totalMs !== undefined ? `Worked for ${formatRunMs(explanation.totalMs) || 'under a second'}` : '',
    `${explanation.steps.length} step${explanation.steps.length === 1 ? '' : 's'}`,
    explanation.aiCalls.length ? `${explanation.aiCalls.length} AI call${explanation.aiCalls.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  const footer = [
    explanation.timings.aiMs ? `AI ${formatRunMs(explanation.timings.aiMs)}` : '',
    explanation.timings.warehouseMs !== undefined ? `Warehouse ${formatRunMs(explanation.timings.warehouseMs) || 'under 50 ms'}` : '',
    explanation.timings.contextMs !== undefined ? `Context ${formatRunMs(explanation.timings.contextMs) || 'under 50 ms'}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div role="status" style={{ border: '1px solid var(--border-subtle)', borderLeft: `3px solid ${color}`, borderRadius: 8, padding: '9px 11px', background: 'var(--bg-1)' }}>
        <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{explanation.headline}</div>
        <div style={{ marginTop: 3, fontSize: 11, color: t.textMuted }}>{summary}</div>
      </div>
      <ol aria-label="How it was answered" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {explanation.steps.map((step, index) => (
          <FlowStep
            key={step.id}
            step={step}
            last={index === explanation.steps.length - 1}
            open={Boolean(open[step.id])}
            onToggle={() => setOpen((current) => ({ ...current, [step.id]: !current[step.id] }))}
            t={t}
            onOpenTab={onOpenTab}
          />
        ))}
      </ol>
      {footer || onOpenTrace ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <span style={{ fontSize: 11, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{footer}</span>
          <span style={{ flex: 1 }} />
          {onOpenTrace ? (
            <button type="button" className="dql-hover" onClick={onOpenTrace} title="Open the decision flow for this run" style={linkButton(t)}>
              <GitBranch size={12} /> Open full trace
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
