import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { api } from '../../api/client';
import { useDispatch } from '../../store/NotebookStore';
import {
  CERTIFY_FIRST_HOW,
  CERTIFY_FIRST_WHY,
  CERTIFY_GUIDE_CHANGED_EVENT,
  certifiedSavedQueryCount,
  certifyFirstView,
  certifyGuideDismissed,
  certifyStepAction,
  certifyStepNote,
  setCertifyGuideDismissed,
  type CertifyFirstView,
  type CertifyStep,
  type CertifyStepLabel,
} from './certify-first';

/** How many steps show before "Show more". */
const FIRST_STEPS = 5;

/**
 * The certify-first guide on Ask's home (see certify-first.ts): loads the
 * saved query library and the Ask history, and shows nothing when ten or more
 * saved queries are certified, when it was dismissed, or when either list
 * cannot be read.
 */
export function CertifyFirstCard({ onAsk }: { onAsk: (question: string) => void }): JSX.Element | null {
  const dispatch = useDispatch();
  const [dismissed, setDismissed] = useState(() => certifyGuideDismissed());
  const [view, setView] = useState<CertifyFirstView | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const changed = () => {
      setDismissed(certifyGuideDismissed());
      setVersion((current) => current + 1);
    };
    window.addEventListener(CERTIFY_GUIDE_CHANGED_EVENT, changed);
    // Certifying (or saving) a saved query anywhere changes the count.
    window.addEventListener('dql:block-library-invalidated', changed);
    return () => {
      window.removeEventListener(CERTIFY_GUIDE_CHANGED_EVENT, changed);
      window.removeEventListener('dql:block-library-invalidated', changed);
    };
  }, []);

  useEffect(() => {
    if (dismissed) return undefined;
    let cancelled = false;
    void Promise.all([api.getBlockLibrary(), api.listAgentRuns({ limit: 200 }).catch(() => null)])
      .then(([library, history]) => {
        if (cancelled) return;
        // A library that could not be read is not an empty one: say nothing rather than "nothing is certified".
        if (library.error || !history) {
          setView(null);
          return;
        }
        setView(certifyFirstView({ certified: certifiedSavedQueryCount(library.blocks), runs: history.runs }));
      })
      .catch(() => { if (!cancelled) setView(null); });
    return () => { cancelled = true; };
  }, [dismissed, version]);

  const openDraft = useCallback((path: string) => {
    const file = { name: path.split('/').pop() ?? path, path, type: 'block' as const, folder: 'blocks' };
    void api.openBlockStudio(path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload })).catch(() => undefined);
  }, [dispatch]);

  if (dismissed || !view) return null;
  return (
    <CertifyFirstCardView
      view={view}
      onOpenDraft={openDraft}
      onAsk={onAsk}
      onDismiss={() => {
        setCertifyGuideDismissed(true);
        setDismissed(true);
      }}
    />
  );
}

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 10,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-2)',
  color: 'var(--text-primary)',
  minWidth: 0,
};
const muted: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.5 };
const smallButton: React.CSSProperties = {
  flexShrink: 0,
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid var(--border-default)',
  background: 'var(--bg-1)',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const primaryButton: React.CSSProperties = { ...smallButton, border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--accent-fg)' };

/** The colour that tells the labels apart, beside the words (never instead of them). */
const LABEL_TONE: Record<CertifyStepLabel, string> = {
  Certified: 'var(--status-success)',
  'From Metrics': 'var(--accent)',
  'AI-generated': 'var(--status-warning)',
  'Not in this data': 'var(--text-tertiary)',
  'No answer': 'var(--text-tertiary)',
};

function LabelPill({ label }: { label: CertifyStepLabel }) {
  return (
    <span
      data-testid="certify-step-label"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border-subtle)', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: LABEL_TONE[label] }} />
      {label}
    </span>
  );
}

/** The card itself, without loading: what a test renders. */
export function CertifyFirstCardView({ view, onOpenDraft, onAsk, onDismiss, showAll: initialShowAll = false }: {
  view: CertifyFirstView;
  onOpenDraft: (path: string) => void;
  onAsk: (question: string) => void;
  onDismiss: () => void;
  showAll?: boolean;
}): JSX.Element {
  const [showAll, setShowAll] = useState(initialShowAll);
  const [own, setOwn] = useState('');
  const steps = showAll ? view.steps : view.steps.slice(0, FIRST_STEPS);
  const hidden = view.steps.length - steps.length;
  const askOwn = () => {
    const question = own.trim();
    if (!question) return;
    setOwn('');
    onAsk(question);
  };
  const runStep = (step: CertifyStep) => {
    const action = certifyStepAction(step);
    if (action.kind === 'open_draft' && step.draftPath) onOpenDraft(step.draftPath);
    else onAsk(step.question);
  };
  return (
    <section
      aria-label="Certify your most-asked questions"
      data-testid="certify-first-card"
      style={{ padding: '16px 20px 4px', maxWidth: 1080, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}
    >
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <ShieldCheck size={16} aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.35 }}>{view.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                role="progressbar"
                aria-label="Certified saved queries"
                aria-valuemin={0}
                aria-valuemax={view.goal}
                aria-valuenow={view.certified}
                style={{ flex: '0 1 200px', height: 6, borderRadius: 999, background: 'var(--bg-3)', overflow: 'hidden' }}
              >
                <div style={{ width: `${Math.round((view.certified / view.goal) * 100)}%`, height: '100%', background: 'var(--status-success)' }} />
              </div>
              <span data-testid="certify-first-progress" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{view.progress}</span>
            </div>
          </div>
          <button type="button" onClick={onDismiss} title="Dismiss. Settings » Appearance shows it again." aria-label="Dismiss the certify guide" style={{ ...smallButton, padding: 4, border: 'none', background: 'transparent', color: 'var(--text-tertiary)' }}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div style={muted}>
          {CERTIFY_FIRST_WHY} {CERTIFY_FIRST_HOW}
        </div>
        {view.steps.length ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>From your Ask history, most asked first</div>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((step) => {
                const action = certifyStepAction(step);
                return (
                  <li key={step.runId} data-testid="certify-step" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span title={step.question} style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.question}</span>
                        <LabelPill label={step.label} />
                      </div>
                      <span style={{ ...muted, fontSize: 12 }}>{certifyStepNote(step)}</span>
                    </div>
                    <button type="button" onClick={() => runStep(step)} style={action.kind === 'open_draft' ? primaryButton : smallButton}>{action.label}</button>
                  </li>
                );
              })}
            </ol>
            {hidden > 0 ? (
              <button type="button" onClick={() => setShowAll(true)} style={{ ...smallButton, alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--accent)', padding: 0 }}>
                Show {hidden} more
              </button>
            ) : null}
          </>
        ) : (
          <div style={muted}>Nothing asked yet. Ask the questions your team asks most; they appear here, most asked first.</div>
        )}
        <form
          onSubmit={(event) => { event.preventDefault(); askOwn(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          <label htmlFor="certify-first-own" style={{ ...muted, fontSize: 12 }}>A question you ask often:</label>
          <input
            id="certify-first-own"
            value={own}
            onChange={(event) => setOwn(event.target.value)}
            placeholder="Type it in your own words"
            style={{ flex: '1 1 240px', minWidth: 0, padding: '6px 10px', borderRadius: 7, border: '1px solid var(--border-default)', background: 'var(--bg-1)', color: 'var(--text-primary)', fontSize: 12.5 }}
          />
          <button type="submit" disabled={!own.trim()} style={{ ...smallButton, opacity: own.trim() ? 1 : 0.6, cursor: own.trim() ? 'pointer' : 'default' }}>Ask it</button>
        </form>
      </div>
    </section>
  );
}
