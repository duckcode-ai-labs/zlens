// Readiness / Get Started surface — the "AI drafts, humans certify" first-run
// backbone (classify → plan → approve → generate → review).
//
// It calls `/api/propose` (the propose engine, in dryRun preview mode), which
// now returns a DETERMINISTIC, business-only PLAN: the cascade classifier picks
// the small set of business models worth governing, bounded per-domain, and
// reports what it WILL generate vs SKIP — nothing is written by the preview.
// The human reviews the plan, picks a scope, and clicks "Approve & Generate":
// only then are DRAFT blocks materialized (POST /api/propose/generate), and the
// flow routes into the existing per-block review/certify queue. Nothing here
// certifies or auto-promotes — promotion is a separate human action.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CSSProperties } from 'react';
import {
  ShieldCheck,
  Sparkles,
  ArrowRight,
  AlertTriangle,
  RefreshCw,
  Filter,
  Loader2,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Blocks,
  Wand2,
  UserRound,
  GraduationCap,
} from 'lucide-react';
import { TrustBadge } from '@zlens/ui';
import { api } from '../../api/client';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { openAiBuild } from '../../utils/ai-build-bus';
import type { ProposeReadiness, ProposePlanDomain, ProposePlanCandidate, NotebookFile } from '../../store/types';

export function ReadinessPage(): JSX.Element {
  const state = useNotebookStore(useShallow((store) => ({ files: store.files })));
  const dispatch = useDispatch();
  const [readiness, setReadiness] = useState<ProposeReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  // "drafting as <owner>" — best-effort, never blocks (spec part D).
  useEffect(() => {
    let cancelled = false;
    api.getIdentity()
      .then((id) => { if (!cancelled && id?.owner) setOwner(id.owner); })
      .catch(() => { /* identity is optional */ });
    return () => { cancelled = true; };
  }, []);

  // Open a draft block in Block Studio via the canonical OPEN_BLOCK_STUDIO flow.
  const openInBlockStudio = useCallback(async (path: string, name: string) => {
    const file: NotebookFile = {
      name: path.split('/').pop() ?? `${name}.dql`,
      path,
      type: 'block',
      folder: 'blocks',
    };
    if (!state.files.some((f) => f.path === path)) {
      dispatch({ type: 'FILE_ADDED', file });
    }
    const payload = await api.openBlockStudio(path);
    dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
  }, [dispatch, state.files]);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api.getProposeReadiness().then((result) => {
      if (cancelled) return;
      setReadiness(result);
      // Default the approved scope to the entire planned selection.
      const allSlugs = result.ready ? result.plan.domains.flatMap((d) => d.candidates.map((c) => c.slug)) : [];
      setSelected(new Set(allSlugs));
    }).catch(() => {
      if (!cancelled) setReadiness(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const openBlockStudio = useCallback(() => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
  }, [dispatch]);

  const toggleSlug = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const toggleDomain = useCallback((domain: ProposePlanDomain) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const slugs = domain.candidates.map((c) => c.slug);
      const allOn = slugs.every((s) => next.has(s));
      for (const s of slugs) {
        if (allOn) next.delete(s);
        else next.add(s);
      }
      return next;
    });
  }, []);

  // Approve & Generate: materialize drafts for ONLY the approved scope, then
  // open the first saved block directly. OSS has no separate review queue.
  const approveAndGenerate = useCallback(async () => {
    const slugs = [...selected];
    if (slugs.length === 0) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await api.generateProposeDrafts({ slugs });
      if (!result.ready) {
        setGenerateError(result.reason ?? 'Could not generate drafts.');
        return;
      }
      const firstSaved = result.proposals.find((proposal) => proposal.path);
      if (firstSaved?.path) {
        void openInBlockStudio(firstSaved.path, firstSaved.slug);
      } else {
        openBlockStudio();
      }
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  }, [selected, openBlockStudio, openInBlockStudio]);

  const summary = readiness?.summary;
  const plan = readiness?.ready ? readiness.plan : null;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px 40px', display: 'grid', gap: 16 }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={20} />
            <div style={{ fontSize: 22, fontWeight: 750 }}>Get started</div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => openAiBuild({ target: 'block', lockTarget: true, sourceLabel: 'Describe a saved query to draft from your project context.' })}
              style={askAiButtonStyle}
            >
              <Wand2 size={14} /> Ask AI to build a saved query
            </button>
          </div>
          <div style={{ fontSize: 13, opacity: 0.72, maxWidth: 760, lineHeight: 1.55 }}>
            {summary?.modelsScanned
              ? `I scanned your dbt project and found ${summary.businessModels} ${summary.businessModels === 1 ? 'thing' : 'things'} worth governing — here's what each one does. Expand a row to see the SQL it would run and what's still missing to certify. Plumbing and low-value models are left out. Nothing is drafted or certified until you approve it.`
              : "I scanned your dbt project for the business models worth governing — here's what each one does. Expand a row to see the SQL it would run and what's still missing to certify. Nothing is drafted or certified until you approve it."}
          </div>
          {owner ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, opacity: 0.62 }}>
              <UserRound size={12} /> drafting as {owner}
            </div>
          ) : null}
          {/* Spec 16 — discoverability nudge: teach the AI your business rules. */}
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'skills' })}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              alignSelf: 'start',
              marginTop: 2,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-accent-blue, #0b7a75)',
              fontSize: 12,
              fontWeight: 650,
              cursor: 'pointer',
            }}
          >
            <GraduationCap size={13} /> Teach the AI your business rules →
          </button>
        </header>

        {loading ? (
          <div style={emptyStyle}>Classifying dbt models and planning the business seed…</div>
        ) : !readiness ? (
          <div style={emptyStyle}>Could not load readiness.</div>
        ) : !readiness.ready ? (
          <div style={{ ...emptyStyle, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 650 }}>Not ready to propose yet</div>
              <div style={{ opacity: 0.8 }}>{readiness.reason}</div>
              <button type="button" onClick={load} style={refreshBtnStyle}>
                <RefreshCw size={13} /> Re-check
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Plan totals — honest counts: scanned vs business vs excluded. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <Stat label="dbt models scanned" value={summary!.modelsScanned} />
              <Stat label="Business models" value={summary!.businessModels} tone="success" />
              <Stat label="Plumbing excluded" value={summary!.plumbingExcluded} />
              <Stat label="Metrics found" value={summary!.metricsFound} />
            </div>

            {/* R2.2 — review-queue telemetry: how close the drafts are to certified. */}
            {summary!.reviewTelemetry && summary!.reviewTelemetry.existingDrafts > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                <Stat
                  label="Drafts ready for review"
                  value={`${Math.round((summary!.reviewTelemetry.readyForReviewRate ?? 0) * 100)}%`}
                  tone="success"
                />
                <Stat
                  label="Median draft age"
                  value={summary!.reviewTelemetry.medianReviewAgeHours != null
                    ? `${summary!.reviewTelemetry.medianReviewAgeHours.toFixed(1)}h`
                    : '—'}
                />
                <Stat label="Est. review time" value={`~${summary!.reviewTelemetry.estimatedReviewMinutes} min`} />
              </div>
            ) : null}

            {/* Approve gate header */}
            <div style={planBarStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Filter size={16} />
                <div style={{ fontSize: 13 }}>
                  <strong>Will generate {selected.size}</strong>
                  <span style={{ opacity: 0.65 }}>
                    {' '}
                    of {plan!.willGenerate} planned · skipping {plan!.willSkip} · ≤ {plan!.config.maxPerDomain} per domain
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" onClick={load} style={refreshBtnStyle}>
                  <RefreshCw size={13} /> Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void approveAndGenerate()}
                  disabled={generating || selected.size === 0}
                  style={{ ...approveBtnStyle, opacity: generating || selected.size === 0 ? 0.6 : 1 }}
                >
                  {generating ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
                  {generating ? 'Generating…' : <>Approve &amp; generate {selected.size > 0 ? `(${selected.size})` : ''}</>}
                </button>
              </div>
            </div>

            {generateError ? (
              <div style={{ ...emptyStyle, display: 'flex', gap: 8, alignItems: 'center', borderColor: 'var(--status-error, #cf222e)' }}>
                <AlertTriangle size={16} /> {generateError}
              </div>
            ) : null}

            {/* Planned domains + per-candidate evidence (approve gate) */}
            <div style={{ display: 'grid', gap: 12 }}>
              {plan!.domains.length === 0 ? (
                <div style={emptyStyle}>
                  No business models found to govern. Tag a layer in <code>dql.config.json</code>{' '}
                  (<code>propose.businessLayers</code>) or add <code>meta.dql.business</code> to your dbt models.
                </div>
              ) : (
                plan!.domains.map((domain) => (
                  <DomainGroup
                    key={domain.name}
                    domain={domain}
                    selected={selected}
                    onToggleSlug={toggleSlug}
                    onToggleDomain={toggleDomain}
                    onOpenInBlockStudio={openInBlockStudio}
                  />
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={openBlockStudio} style={reviewQueueBtnStyle}>
                Open Saved queries <ArrowRight size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DomainGroup({
  domain,
  selected,
  onToggleSlug,
  onToggleDomain,
  onOpenInBlockStudio,
}: {
  domain: ProposePlanDomain;
  selected: Set<string>;
  onToggleSlug: (slug: string) => void;
  onToggleDomain: (domain: ProposePlanDomain) => void;
  onOpenInBlockStudio: (path: string, name: string) => Promise<void>;
}): JSX.Element {
  const slugs = domain.candidates.map((c) => c.slug);
  const allOn = slugs.every((s) => selected.has(s));
  const someOn = slugs.some((s) => selected.has(s));
  return (
    <div style={domainStyle}>
      <div style={domainHeaderStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = !allOn && someOn;
            }}
            onChange={() => onToggleDomain(domain)}
          />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{domain.name}</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {domain.modelCount} model{domain.modelCount === 1 ? '' : 's'}
          </span>
        </label>
        {domain.owner ? <span style={{ fontSize: 11, opacity: 0.6 }}>owner {domain.owner}</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {domain.candidates.map((candidate) => (
          <CandidateRow
            key={candidate.slug}
            candidate={candidate}
            checked={selected.has(candidate.slug)}
            onToggle={() => onToggleSlug(candidate.slug)}
            onOpenInBlockStudio={onOpenInBlockStudio}
          />
        ))}
      </div>
    </div>
  );
}

// Spec 14 (part A) — each proposal row is a DISCLOSURE: the collapsed row shows
// the checkbox + model name + AI-generated pill + pattern + grain + a "why:"
// line + a Show/Hide toggle. Expanding lazily fetches api.proposePreview(slug)
// once and reveals the artifact: the SQL the draft would run, declared outputs,
// example questions, a plain-language "what's missing to certify" verdict, and
// per-row actions (Open in Block Studio · Refine with AI).
function CandidateRow({
  candidate,
  checked,
  onToggle,
  onOpenInBlockStudio,
}: {
  candidate: ProposePlanCandidate;
  checked: boolean;
  onToggle: () => void;
  onOpenInBlockStudio: (path: string, name: string) => Promise<void>;
}): JSX.Element {
  const evidence = useMemo(() => candidate.evidence.slice(0, 3), [candidate.evidence]);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<ProposePlanCandidate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Lazy-load the preview the first time the row is expanded.
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !preview && !previewLoading) {
        setPreviewLoading(true);
        setPreviewError(null);
        api.proposePreview(candidate.slug)
          .then((res) => setPreview(res.candidate))
          .catch((err) => setPreviewError(err instanceof Error ? err.message : 'Could not load the preview.'))
          .finally(() => setPreviewLoading(false));
      }
      return next;
    });
  }, [candidate.slug, preview, previewLoading]);

  // Merge the lazily-fetched preview over the base candidate so the expanded
  // body shows full detail while the collapsed header always renders.
  const detail = preview ?? candidate;
  const sqlPreview = detail.sqlPreview;
  const outputs = detail.outputs ?? [];
  const examples = detail.examples ?? [];
  const verdict = detail.certifierVerdict;
  const description = detail.description;

  const openInStudio = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      // The draft may not exist yet; generate this single slug first, then open
      // the written draft path. generateProposeDrafts is idempotent (skips
      // existing drafts) and returns the proposal with its path.
      const result = await api.generateProposeDrafts({ slugs: [candidate.slug] });
      const proposal = result.proposals.find((p) => p.slug === candidate.slug) ?? result.proposals[0];
      const path = proposal?.path;
      if (!path) {
        setOpenError('No draft path was returned for this model yet.');
        return;
      }
      await onOpenInBlockStudio(path, candidate.model);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : 'Could not open this draft.');
    } finally {
      setOpening(false);
    }
  }, [candidate.model, candidate.slug, onOpenInBlockStudio]);

  const refineWithAi = useCallback(() => {
    openAiBuild({
      target: 'block',
      lockTarget: true,
      prompt: `Refine the "${candidate.model}" saved query: ${description ?? `a ${candidate.pattern ?? 'business'} model${candidate.grain ? ` at ${candidate.grain} grain` : ''}`}.`,
      sourceLabel: `Refining ${candidate.model}`,
    });
  }, [candidate.grain, candidate.model, candidate.pattern, description]);

  return (
    <div style={{ ...rowCardStyle, opacity: checked ? 1 : 0.7 }}>
      {/* Collapsed header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 10, alignItems: 'start' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          style={{ marginTop: 3 }}
          aria-label={`Include ${candidate.model}`}
        />
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{candidate.model}</span>
            <TrustBadge state="ai_generated" />
            {candidate.pattern ? <Pill>{candidate.pattern}</Pill> : null}
            {candidate.grain ? <span style={{ fontSize: 11, opacity: 0.6 }}>grain {candidate.grain}</span> : null}
          </div>
          {evidence.length > 0 ? (
            <div style={{ fontSize: 11, opacity: 0.66 }}>
              <span style={{ opacity: 0.8 }}>why: </span>
              {evidence.join(' · ')}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={toggleExpanded} aria-expanded={expanded} style={disclosureToggleStyle}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>

      {/* Expanded body */}
      {expanded ? (
        <div style={expandedBodyStyle}>
          {previewLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.75 }}>
              <Loader2 size={13} className="spin" /> Loading the generated SQL and verdict…
            </div>
          ) : previewError ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--status-error, #cf222e)' }}>
              <AlertTriangle size={14} /> {previewError}
            </div>
          ) : (
            <>
              {description ? <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.5 }}>{description}</div> : null}

              <div style={{ display: 'grid', gap: 5 }}>
                <SectionLabel>SQL this saved query will run</SectionLabel>
                {sqlPreview ? (
                  <pre style={codeBlockStyle}>
                    <code style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {sqlPreview.trim()}
                    </code>
                  </pre>
                ) : (
                  <div style={{ fontSize: 11.5, opacity: 0.6 }}>The generated SQL is not available for this model yet.</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={{ display: 'grid', gap: 5, alignContent: 'start' }}>
                  <SectionLabel>Outputs</SectionLabel>
                  {outputs.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {outputs.map((output) => <Chip key={output}>{output}</Chip>)}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>No declared outputs yet.</div>
                  )}
                </div>
                <div style={{ display: 'grid', gap: 5, alignContent: 'start' }}>
                  <SectionLabel>Answers questions like</SectionLabel>
                  {examples.length > 0 ? (
                    <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 3 }}>
                      {examples.slice(0, 3).map((example) => (
                        <li key={example} style={{ fontSize: 11.5, opacity: 0.82, lineHeight: 1.45 }}>{example}</li>
                      ))}
                    </ul>
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>No example questions yet.</div>
                  )}
                </div>
              </div>

              <CertifierVerdict verdict={verdict} />

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => void openInStudio()} disabled={opening} style={{ ...primaryRowButtonStyle, opacity: opening ? 0.65 : 1 }}>
                  {opening ? <Loader2 size={13} className="spin" /> : <Blocks size={13} />}
                  {opening ? 'Opening…' : 'Open in Saved queries'}
                </button>
                <button type="button" onClick={refineWithAi} style={ghostRowButtonStyle}>
                  <Wand2 size={13} /> Refine with AI
                </button>
              </div>
              {openError ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--status-error, #cf222e)' }}>
                  <AlertTriangle size={13} /> {openError}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CertifierVerdict({ verdict }: { verdict?: { blocking: string[]; warnings: string[]; ready: boolean } }): JSX.Element {
  const ready = Boolean(verdict?.ready && verdict.blocking.length === 0);
  const notes = verdict ? [...verdict.blocking, ...verdict.warnings] : [];
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <SectionLabel>What's missing to certify</SectionLabel>
      {ready ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--status-success, #1f883d)' }}>
          <CheckCircle2 size={14} /> Grain, outputs, and context are set.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--status-warning, #9a6700)' }}>
            <AlertTriangle size={14} /> Needs an owner and passing tests before it can be certified.
          </div>
          {notes.length > 0 ? (
            <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 2 }}>
              {notes.map((note) => <li key={note} style={{ fontSize: 11, opacity: 0.78, lineHeight: 1.4 }}>{note}</li>)}
            </ul>
          ) : !verdict ? (
            <div style={{ fontSize: 11, opacity: 0.6 }}>Expand to load the Certifier verdict.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', opacity: 0.55 }}>
      {children}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      padding: '3px 8px',
      borderRadius: 6,
      border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
      background: 'var(--surface-hover, rgba(0,0,0,0.04))',
      fontFamily: 'var(--font-mono, monospace)',
    }}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'success' }) {
  return (
    <div style={{ ...statStyle, borderTop: `2px solid ${tone === 'success' ? 'var(--status-success, #1f883d)' : 'var(--border-color, rgba(0,0,0,0.10))'}` }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--surface-hover, rgba(0,0,0,0.06))', opacity: 0.82 }}>
      {children}
    </span>
  );
}

const domainStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 8,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
  display: 'grid',
  gap: 8,
};

const domainHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  paddingBottom: 6,
  borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))',
};

const rowCardStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderLeft: '3px solid var(--status-warning, #9a6700)',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 10,
  display: 'grid',
  gap: 10,
};

const expandedBodyStyle: CSSProperties = {
  borderTop: '1px solid var(--border-color, rgba(0,0,0,0.08))',
  paddingTop: 10,
  marginLeft: 26,
  display: 'grid',
  gap: 12,
};

const disclosureToggleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  alignSelf: 'start',
};

const codeBlockStyle: CSSProperties = {
  margin: 0,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 8,
  background: 'var(--color-bg-primary, rgba(0,0,0,0.03))',
  padding: '9px 11px',
  overflow: 'auto',
  maxHeight: 280,
};

const primaryRowButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--color-accent-blue, #0b7a75)',
  background: 'var(--color-accent-blue, #0b7a75)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const ghostRowButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const askAiButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 13px',
  borderRadius: 7,
  border: '1px solid var(--color-clay, #b4593f)',
  background: 'var(--color-clay, #b4593f)',
  color: '#fff',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const statStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const planBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 8,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: '10px 12px',
};

const reviewQueueBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const approveBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 13px',
  borderRadius: 6,
  border: '1px solid var(--status-success, #1f883d)',
  background: 'var(--status-success, #1f883d)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const refreshBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const emptyStyle: CSSProperties = {
  border: '1px dashed var(--border-color, rgba(0,0,0,0.16))',
  borderRadius: 8,
  padding: 24,
  fontSize: 13,
  opacity: 0.85,
};
