// First-run teaching panel — "learn blocks by example before you build one".
//
// A brand-new user doesn't yet know what a DQL block IS. Telling them to "build
// a governed block" is meaningless. So onboarding step 3 instead SHOWS them a
// few important blocks DQL already drafted from their dbt context, fully formed,
// and lets them open "See details" to understand exactly what a block is: what
// it measures, the SQL behind it, the questions it answers, and why it can be
// trusted. Only once the concept lands do we point them at building their own.
//
// Data comes from the same propose engine the Get Started page uses
// (`/api/propose`, dryRun) — `getProposeReadiness` returns ranked DRAFT
// candidates; `proposePreview(slug)` lazily fills in SQL + outputs + examples +
// verdict on demand. Nothing here certifies or writes anything.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Sparkles,
  ChevronDown,
  ChevronRight,
  Loader2,
  Blocks as BlocksIcon,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
} from 'lucide-react';
import { TrustBadge } from '@zlens/ui';
import { api } from '../../api/client';
import { controlStyle } from '../../themes/control-tokens';
import { useNotebook } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';
import type { ProposeReadiness, ProposePlanCandidate } from '../../store/types';

const MAX_STARTERS = 3;

export function StarterBlocks({
  t,
  aiReady = true,
  onSetupAi,
}: {
  t: Theme;
  aiReady?: boolean;
  onSetupAi?: () => void;
}): JSX.Element {
  const { dispatch } = useNotebook();
  const [readiness, setReadiness] = useState<ProposeReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Block suggestions come from the AI provider — don't fetch until it's on.
    if (!aiReady) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .getProposeReadiness({ limit: MAX_STARTERS })
      .then((r) => {
        if (!cancelled) setReadiness(r);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aiReady]);

  // Pick the few highest-value candidates across domains as teaching examples.
  const starters = useMemo<ProposePlanCandidate[]>(() => {
    if (!readiness?.ready) return [];
    const all = readiness.plan.domains.flatMap((d) => d.candidates);
    return [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, MAX_STARTERS);
  }, [readiness]);

  const reviewAll = useCallback(() => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'readiness' });
  }, [dispatch]);

  const buildOwn = useCallback(() => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
  }, [dispatch]);

  // AI is the engine for block suggestions. Without a provider configured, don't
  // show a deterministic catalog that looks random — guide the user to set up AI.
  if (!aiReady) {
    return (
      <div style={panelStyle(t)}>
        <style>{STARTER_STYLES}</style>
        <div style={headStyle}>
          <span style={headIconStyle(t)}>
            <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 760, color: t.textPrimary }}>
              Turn on AI to generate starter saved queries
            </div>
            <p style={{ margin: '3px 0 0', fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>
              Saved query suggestions are drafted by <strong>your AI provider</strong> from your dbt models and
              data — that's where the value is. Connect a provider (OpenAI, Anthropic, Gemini, or a local
              Ollama) and ZLens will propose a few important saved queries you can learn from and certify.
            </p>
          </div>
        </div>
        <div style={footerStyle(t)}>
          <span style={{ fontSize: 12, color: t.textMuted }}>
            AI also powers governed answers and research — it's the heart of ZLens.
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {onSetupAi ? (
              <button type="button" onClick={onSetupAi} style={primaryBtnStyle(t)}>
                Connect an AI provider
                <ArrowRight size={14} strokeWidth={2.2} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" onClick={buildOwn} style={ghostBtnStyle(t)}>
              <BlocksIcon size={14} strokeWidth={2} aria-hidden="true" />
              Build one by hand
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle(t)}>
      <style>{STARTER_STYLES}</style>

      <div style={headStyle}>
        <span style={headIconStyle(t)}>
          <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 760, color: t.textPrimary }}>
            New here? Start with saved queries ZLens built for you
          </div>
          <p style={{ margin: '3px 0 0', fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>
            A <strong>saved query</strong> is a reusable piece of analytics — one trusted metric or
            query your whole team can reuse across answers and Apps. Here are a few important ones ZLens
            drafted from your dbt models. Open <em>See details</em> on each to understand exactly what it
            measures and the SQL behind it — then build your own.
          </p>
        </div>
      </div>

      {loading ? (
        <div style={skeletonWrapStyle}>
          {Array.from({ length: MAX_STARTERS }).map((_, i) => (
            <div key={i} className="dql-starter-skel" style={skeletonStyle(t)} />
          ))}
        </div>
      ) : starters.length > 0 ? (
        <>
          <div style={cardsWrapStyle}>
            {starters.map((candidate, index) => (
              <StarterCard key={candidate.slug} candidate={candidate} index={index} t={t} />
            ))}
          </div>
          <div style={footerStyle(t)}>
            <span style={{ fontSize: 12, color: t.textMuted }}>
              Open a suggested saved query to edit it, or build one from scratch.
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={reviewAll} style={primaryBtnStyle(t)}>
                Open saved query suggestions
                <ArrowRight size={14} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button type="button" onClick={buildOwn} style={ghostBtnStyle(t)}>
                <BlocksIcon size={14} strokeWidth={2} aria-hidden="true" />
                Build my own
              </button>
            </div>
          </div>
        </>
      ) : (
        <div style={emptyStyle(t)}>
          <HelpCircle size={16} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: t.textMuted }} />
          <div style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: t.textSecondary, lineHeight: 1.5 }}>
              {readiness && !readiness.ready && readiness.reason
                ? readiness.reason
                : 'No starter saved queries to suggest yet — connect a dbt project so ZLens can read your models, or build your first saved query by hand to see how it works.'}
            </span>
            <button type="button" onClick={buildOwn} style={ghostBtnStyle(t)}>
              <BlocksIcon size={14} strokeWidth={2} aria-hidden="true" />
              Build a saved query
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// One teaching example: a fully-formed block shown as a card, with a "See
// details" disclosure that lazily fetches the SQL + outputs + examples + verdict
// so a newcomer can read what the block actually is.
function StarterCard({
  candidate,
  index,
  t,
}: {
  candidate: ProposePlanCandidate;
  index: number;
  t: Theme;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<ProposePlanCandidate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !preview && !previewLoading) {
        setPreviewLoading(true);
        setPreviewError(null);
        api
          .proposePreview(candidate.slug)
          .then((res) => setPreview(res.candidate))
          .catch((err) => setPreviewError(err instanceof Error ? err.message : 'Could not load the details.'))
          .finally(() => setPreviewLoading(false));
      }
      return next;
    });
  }, [candidate.slug, preview, previewLoading]);

  const detail = preview ?? candidate;
  const why = candidate.evidence.slice(0, 2).join(' · ');
  const headline = candidate.description || why || 'A governed metric drafted from your dbt model.';

  return (
    <div
      className="dql-starter-card"
      style={{ ...cardStyle(t), animationDelay: `${index * 70}ms` }}
    >
      <button type="button" onClick={toggle} aria-expanded={expanded} style={cardHeaderBtnStyle}>
        <span style={cardNumStyle(t)}>{index + 1}</span>
        <span style={{ display: 'grid', gap: 4, minWidth: 0, flex: 1, textAlign: 'left' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 720, color: t.textPrimary }}>{candidate.model}</span>
            <TrustBadge state="ai_generated" />
            {candidate.pattern ? <span style={tagStyle(t)}>{candidate.pattern}</span> : null}
            {candidate.grain ? <span style={{ fontSize: 11, color: t.textMuted }}>grain {candidate.grain}</span> : null}
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>{headline}</span>
        </span>
        <span style={seeDetailsStyle(t)}>
          {expanded ? <ChevronDown size={13} strokeWidth={2.2} /> : <ChevronRight size={13} strokeWidth={2.2} />}
          {expanded ? 'Hide' : 'See details'}
        </span>
      </button>

      {expanded ? (
        <div style={cardBodyStyle(t)}>
          {previewLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted }}>
              <Loader2 size={13} className="dql-starter-spin" /> Loading the SQL and what it measures…
            </div>
          ) : previewError ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.warning }}>
              <AlertTriangle size={14} /> {previewError}
            </div>
          ) : (
            <>
              {detail.description ? (
                <Field label="What it is" t={t}>
                  <span style={{ fontSize: 12.5, color: t.textSecondary, lineHeight: 1.5 }}>{detail.description}</span>
                </Field>
              ) : null}

              {(detail.outputs ?? []).length > 0 ? (
                <Field label="What it measures" t={t}>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {detail.outputs!.map((output) => (
                      <span key={output} style={chipStyle(t)}>{output}</span>
                    ))}
                  </span>
                </Field>
              ) : null}

              {(detail.examples ?? []).length > 0 ? (
                <Field label="Answers questions like" t={t}>
                  <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 3 }}>
                    {detail.examples!.slice(0, 3).map((ex) => (
                      <li key={ex} style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>{ex}</li>
                    ))}
                  </ul>
                </Field>
              ) : null}

              <Field label="The SQL behind it" t={t}>
                {detail.sqlPreview ? (
                  <pre style={codeStyle(t)}>
                    <code style={{ fontFamily: t.fontMono, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.textPrimary }}>
                      {detail.sqlPreview.trim()}
                    </code>
                  </pre>
                ) : (
                  <span style={{ fontSize: 11.5, color: t.textMuted }}>SQL preview is not available for this model yet.</span>
                )}
              </Field>

              <TrustLine verdict={detail.certifierVerdict} t={t} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children, t }: { label: string; children: React.ReactNode; t: Theme }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>
        {label}
      </span>
      {children}
    </div>
  );
}

// Plain-language trust line — teaches that a block is "certified-ready" only
// once grain/outputs/context are set; otherwise it's an AI draft to review.
function TrustLine({ verdict, t }: { verdict?: { blocking: string[]; warnings: string[]; ready: boolean }; t: Theme }): JSX.Element {
  const ready = Boolean(verdict?.ready && verdict.blocking.length === 0);
  return (
    <Field label="Can you trust it" t={t}>
      {ready ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.success }}>
          <CheckCircle2 size={14} /> Grain, outputs, and context are set — ready to certify.
        </span>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: t.warning, lineHeight: 1.45 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          An AI draft — a person reviews and certifies it before your team relies on it. That review step is what makes a saved query trustworthy.
        </span>
      )}
    </Field>
  );
}

const panelStyle = (t: Theme): CSSProperties => ({
  border: `1px solid ${t.cellBorder}`,
  borderRadius: 12,
  background: t.cellBg,
  padding: 16,
  display: 'grid',
  gap: 14,
});

const headStyle: CSSProperties = { display: 'flex', gap: 11, alignItems: 'flex-start' };

const headIconStyle = (t: Theme): CSSProperties => ({
  flex: 'none',
  width: 32,
  height: 32,
  borderRadius: 9,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: `${t.accent}18`,
  color: t.accent,
});

const cardsWrapStyle: CSSProperties = { display: 'grid', gap: 8 };

const cardStyle = (t: Theme): CSSProperties => ({
  border: `1px solid ${t.cellBorder}`,
  borderLeft: `3px solid ${t.accent}`,
  borderRadius: 9,
  background: t.appBg,
  overflow: 'hidden',
});

const cardHeaderBtnStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  gap: 11,
  alignItems: 'flex-start',
  padding: 11,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
};

const cardNumStyle = (t: Theme): CSSProperties => ({
  flex: 'none',
  width: 20,
  height: 20,
  borderRadius: 6,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: `${t.accent}18`,
  color: t.accent,
  fontSize: 11,
  fontWeight: 800,
  marginTop: 1,
});

const seeDetailsStyle = (t: Theme): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
  padding: '5px 9px',
  borderRadius: 6,
  border: `1px solid ${t.cellBorder}`,
  background: t.cellBg,
  color: t.textSecondary,
  fontSize: 11,
  fontWeight: 650,
  whiteSpace: 'nowrap',
  alignSelf: 'flex-start',
});

const cardBodyStyle = (t: Theme): CSSProperties => ({
  borderTop: `1px solid ${t.cellBorder}`,
  padding: '11px 11px 12px 42px',
  display: 'grid',
  gap: 11,
});

const tagStyle = (t: Theme): CSSProperties => ({
  fontSize: 10,
  padding: '2px 7px',
  borderRadius: 4,
  background: `${t.textMuted}1f`,
  color: t.textSecondary,
  fontWeight: 600,
});

const chipStyle = (t: Theme): CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${t.cellBorder}`,
  background: t.cellBg,
  color: t.textSecondary,
  fontFamily: t.fontMono,
});

const codeStyle = (t: Theme): CSSProperties => ({
  margin: 0,
  border: `1px solid ${t.cellBorder}`,
  borderRadius: 8,
  background: t.inputBg,
  padding: '9px 11px',
  overflow: 'auto',
  maxHeight: 240,
});

const footerStyle = (t: Theme): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  borderTop: `1px solid ${t.cellBorder}`,
  paddingTop: 12,
});

const primaryBtnStyle = (t: Theme): CSSProperties => controlStyle(t, { variant: 'primary', size: 'md' });

const ghostBtnStyle = (t: Theme): CSSProperties => controlStyle(t, { variant: 'ghost', size: 'md' });

const skeletonWrapStyle: CSSProperties = { display: 'grid', gap: 8 };

const skeletonStyle = (t: Theme): CSSProperties => ({
  height: 56,
  borderRadius: 9,
  border: `1px solid ${t.cellBorder}`,
  background: t.appBg,
});

const emptyStyle = (t: Theme): CSSProperties => ({
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  border: `1px dashed ${t.cellBorder}`,
  borderRadius: 9,
  padding: 14,
  background: t.appBg,
});

const STARTER_STYLES = `
@keyframes dql-starter-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.dql-starter-card { animation: dql-starter-rise 360ms cubic-bezier(0.2,0.7,0.2,1) both; }
.dql-starter-card:hover { border-color: var(--color-accent-blue, #2563eb); }
@keyframes dql-starter-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 0.85; } }
.dql-starter-skel { animation: dql-starter-pulse 1.3s ease-in-out infinite; }
@keyframes dql-starter-spin { to { transform: rotate(360deg); } }
.dql-starter-spin { animation: dql-starter-spin 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .dql-starter-card, .dql-starter-skel, .dql-starter-spin { animation: none !important; }
}
`;
