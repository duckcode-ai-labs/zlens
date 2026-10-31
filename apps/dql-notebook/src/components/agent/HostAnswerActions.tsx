import { useCallback, useEffect, useState } from 'react';
import type { AgentRun } from '../../api/client';
import { fetchHostAnswerStatuses, runHostAnswerAction, useHostPage, useHostUi, type HostAnswerAction, type HostAnswerStatus } from '../../host/host-ui';
import { useDispatch } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';

/** The action that asks for a certified version of an answer. It starts from the SQL the AI ran, so ZLens offers it only where there is some. */
const CERTIFY_ACTION = 'certify';
/** The action that says an answer looks wrong. It takes a one-line note before it is sent. */
const WRONG_ACTION = 'wrong';

/** Whether an answer needs a person's review before anyone relies on it. */
export function answerNeedsReview(run: Pick<AgentRun, 'status' | 'trustState'>): boolean {
  return run.status === 'needs_review' || run.trustState === 'review_required';
}

const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** Whether SQL ran to give this answer: a result with its statement, which survives withheld figures (HH-14) and a run rebuilt from a thread. */
export function answerRanSql(run: Partial<Pick<AgentRun, 'artifacts'>>): boolean {
  return (run.artifacts ?? []).some((artifact) => {
    const payload = artifact.payload as { result?: { sql?: unknown }; sql?: unknown; executionError?: unknown } | null | undefined;
    if (!payload?.result || hasText(payload.executionError)) return false;
    return hasText(payload.result.sql) || hasText(payload.sql);
  });
}

/** An AI-generated answer that ran SQL: never a block, a refusal, a failure, a clarification or a conversational reply. */
export function answerCanBeCertified(run: Pick<AgentRun, 'status' | 'trustState'> & Partial<Pick<AgentRun, 'artifacts'>>): boolean {
  return run.trustState === 'review_required' && (run.status === 'needs_review' || run.status === 'completed') && answerRanSql(run);
}

/** Which of the host's answer actions fit this answer: review ones, and those for questions ZLens could not answer. */
export function actionsForAnswer(run: Pick<AgentRun, 'status' | 'trustState'> & Partial<Pick<AgentRun, 'artifacts'>>, actions: HostAnswerAction[]): { kind: 'review' | 'unanswered' | 'answered'; actions: HostAnswerAction[] } | null {
  const answered = run.status === 'completed' && (run.trustState === 'certified' || run.trustState === 'governed' || run.trustState === 'grounded');
  const kind = run.status === 'blocked' ? 'unanswered' : answerNeedsReview(run) ? 'review' : answered ? 'answered' : null;
  if (!kind) return null;
  const fitting = actions.filter((action) => (action.on ?? ['review']).includes(kind) && (action.id !== CERTIFY_ACTION || answerCanBeCertified(run)));
  return fitting.length ? { kind, actions: fitting } : null;
}

/** What goes to the host with an action; a note only when the person wrote one. */
export function answerActionInput(run: Pick<AgentRun, 'id' | 'question' | 'trustState'>, note?: string): { runId: string; question: string; trustState?: string; note?: string } {
  const written = note?.trim();
  return { runId: run.id, question: run.question, ...(run.trustState ? { trustState: run.trustState } : {}), ...(written ? { note: written } : {}) };
}

/**
 * The host's part in an answer (RFC 0010 HH-9, HH-10). Once the host is
 * reviewing it — a request is open, an analyst checked it, it became certified
 * — that status shows here. Before that, an answer that needs review offers
 * the host's actions, e.g. "Ask an analyst to check this". Nothing without a
 * host.
 */
export function HostAnswerActions({ run, t }: { run: AgentRun; t: Theme }) {
  const hostUi = useHostUi();
  const [status, setStatus] = useState<HostAnswerStatus | null>(null);
  const refresh = useCallback(() => {
    fetchHostAnswerStatuses([run.id]).then((statuses) => setStatus(statuses[run.id] ?? null)).catch(() => undefined);
  }, [run.id]);
  useEffect(() => {
    if (hostUi.host) refresh();
  }, [hostUi.host, refresh]);

  if (!hostUi.host) return null;
  if (status) return <HostAnswerStatusView status={status} t={t} />;
  const fitting = actionsForAnswer(run, hostUi.answerActions);
  if (!fitting) return null;
  if (fitting.kind === 'answered') return <HostQuietActions run={run} actions={fitting.actions} onSent={refresh} t={t} />;
  return <HostAnswerActionButtons run={run} kind={fitting.kind} actions={fitting.actions} onSent={refresh} t={t} />;
}

const STATUS_TONE: Record<HostAnswerStatus['state'], 'accent' | 'warning' | 'muted'> = {
  requested: 'warning',
  in_progress: 'warning',
  checked: 'accent',
  certified: 'accent',
  declined: 'muted',
};

export function HostAnswerStatusView({ status, t }: { status: HostAnswerStatus; t: Theme }) {
  const hostPage = useHostPage();
  const dispatch = useDispatch();
  const tone = STATUS_TONE[status.state];
  const color = tone === 'accent' ? t.accent : tone === 'warning' ? t.warning : t.textSecondary;
  return (
    <div data-testid="host-answer-status" data-state={status.state} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderLeft: `3px solid ${color}`, borderRadius: 8, background: t.cellBg }}>
      <div style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.textPrimary }}>{status.label}</span>
        {status.detail ? <span style={{ fontSize: 12, color: t.textSecondary }}>{status.detail}</span> : null}
      </div>
      {status.href ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => { hostPage.openPage({ id: `answer-${status.href}`, label: status.label, href: status.href! }); dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
          style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: 'transparent', color: t.textPrimary, fontSize: 12, fontFamily: t.font, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Open
        </button>
      ) : null}
    </div>
  );
}

/** Sending an action, for either way of showing them: "This looks wrong" waits for its note, the others go at once. */
function useSendAction(run: AgentRun, onSent: () => void, failure: string) {
  const [sending, setSending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [noting, setNoting] = useState<HostAnswerAction | null>(null);
  const send = async (action: HostAnswerAction, note?: string) => {
    setSending(action.id);
    setMessage(null);
    try {
      setMessage({ text: await runHostAnswerAction(action, answerActionInput(run, note)), failed: false });
      setNoting(null);
      onSent();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : failure, failed: true });
    } finally {
      setSending(null);
    }
  };
  const press = (action: HostAnswerAction) => {
    if (action.id !== WRONG_ACTION) void send(action);
    else setNoting(noting ? null : action);
  };
  return { sending, message, noting, send, press, cancelNote: () => setNoting(null) };
}

/** One optional line for the person's own words, sent with the request. */
export function HostNoteBox({ action, sending, onSend, onCancel, t }: {
  action: HostAnswerAction;
  sending: boolean;
  onSend: (note: string) => void;
  onCancel: () => void;
  t: Theme;
}) {
  const [note, setNote] = useState('');
  return (
    <form
      data-testid="host-note-box"
      onSubmit={(event) => { event.preventDefault(); onSend(note); }}
      style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}
    >
      <input
        autoFocus
        aria-label={`${action.label}: note`}
        placeholder="What looks wrong? (optional)"
        value={note}
        maxLength={2000}
        disabled={sending}
        onChange={(event) => setNote(event.target.value)}
        style={{ flex: '1 1 220px', minWidth: 0, padding: '5px 8px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: 'transparent', color: t.textPrimary, fontSize: 12, fontFamily: t.font }}
      />
      <button
        type="submit"
        disabled={sending}
        style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${t.accent}`, background: t.accent, color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: t.font, cursor: 'pointer' }}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
      <button
        type="button"
        disabled={sending}
        onClick={onCancel}
        style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: 'transparent', color: t.textPrimary, fontSize: 12, fontFamily: t.font, cursor: 'pointer' }}
      >
        Cancel
      </button>
    </form>
  );
}

/** On an answer DQL trusts, the host's actions stay out of the way: a small link, e.g. "This looks wrong". */
function HostQuietActions({ run, actions, onSent, t }: { run: AgentRun; actions: HostAnswerAction[]; onSent: () => void; t: Theme }) {
  const { sending, message, noting, send, press, cancelNote } = useSendAction(run, onSent, 'The report was not sent.');
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }} data-testid="host-quiet-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={sending !== null}
          title={action.description}
          onClick={() => press(action)}
          style={{ padding: 0, border: 0, background: 'transparent', color: t.textSecondary, fontSize: 11.5, fontFamily: t.font, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}
        >
          {action.label}
        </button>
      ))}
      {noting ? <HostNoteBox action={noting} sending={sending !== null} onSend={(note) => void send(noting, note)} onCancel={cancelNote} t={t} /> : null}
      {message ? <span role="status" style={{ fontSize: 11.5, color: message.failed ? t.error : t.textSecondary }}>{message.text}</span> : null}
    </div>
  );
}

function HostAnswerActionButtons({ run, kind, actions, onSent, t }: {
  run: AgentRun;
  kind: 'review' | 'unanswered';
  actions: HostAnswerAction[];
  onSent: () => void;
  t: Theme;
}) {
  const { sending, message, noting, send, press, cancelNote } = useSendAction(run, onSent, 'The request was not sent.');
  return (
    <div style={{ display: 'grid', gap: 6, padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.cellBg }} data-testid="host-answer-actions">
      <span style={{ fontSize: 11.5, color: t.textSecondary }}>{kind === 'review' ? 'No certified source answers this yet.' : 'ZLens could not answer this from your certified and governed sources.'}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            className="dql-hover"
            disabled={sending !== null}
            title={action.description}
            onClick={() => press(action)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 12, fontFamily: t.font, fontWeight: 600,
              border: `1px solid ${index === 0 ? t.accent : t.cellBorder}`,
              background: index === 0 ? t.accent : 'transparent',
              color: index === 0 ? '#fff' : t.textPrimary,
            }}
          >
            {sending === action.id && !noting ? 'Sending…' : action.label}
          </button>
        ))}
      </div>
      {noting ? <HostNoteBox action={noting} sending={sending !== null} onSend={(note) => void send(noting, note)} onCancel={cancelNote} t={t} /> : null}
      {message ? <span role="status" style={{ fontSize: 12, color: message.failed ? t.error : t.textSecondary }}>{message.text}</span> : null}
    </div>
  );
}
