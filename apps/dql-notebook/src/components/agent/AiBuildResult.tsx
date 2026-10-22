// Spec 14 (part B) — the unified AI BUILD surface.
//
// Build is split from Ask. Ask answers a question through the governed Q&A
// loop (`UnifiedAgentRunPanel`). Build *generates* SQL/DQL and renders a
// clean ARTIFACT CARD — never a chat transcript, never the answer loop's
// internals. This component owns:
//   • a target toggle  Cell ⇄ Block
//   • a prompt box (+ optional context: active cell SQL / selection)
//   • the POST /api/ai/build call (api.aiBuild, coded to the shared contract)
//   • two result cards:
//       - target:'cell'  → SQL preview + "Insert preview" / "Refine" / "Discard"
//       - target:'block' → semantic name, "AI-generated · draft" badge, one-line
//         description, collapsible SQL, outputs chips, grain, examples,
//         "what's missing to certify", "Open in Block Studio" / "Refine" /
//         "Discard"
//
// The Build card NEVER shows self-correction text, evidence-tier tables,
// reviewStatus, "USE EXISTING DRAFT" / "DRAFT REVIEW" / "No draft file path
// returned", or "Continuing from …". On failure it shows one plain sentence and
// a Refine affordance.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Blocks,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  GitCompareArrows,
  GraduationCap,
  Hammer,
  Loader2,
  RotateCcw,
  Search,
  Sparkles,
  SquarePen,
  SquarePlus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { controlStyle } from '../../themes/control-tokens';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import type { AiBuildResult as AiBuildResultPayload, AiBuildTarget, AiBuildMode, AiRoute, NotebookFile } from '../../store/types';
import { authoredDomainOptionsWithCurrent } from '../domains/authored-domain-options';

interface AiBuildResultProps {
  themeMode: ThemeMode;
  /** Initial Build target (the front doors choose this). */
  initialTarget?: AiBuildTarget;
  /** Lock the target toggle (e.g. a "Build DQL block" front door). */
  lockTarget?: boolean;
  /** Optional pre-filled prompt (e.g. "Refine with AI" from a proposal row). */
  initialPrompt?: string;
  /** Context handed to the build: the active SQL cell + any selection. */
  context?: { cellSql?: string; selection?: string };
  /** Insert/replace the active SQL cell's source from a review-required SQL preview (target:'cell'). */
  onInsertCell?: (sql: string) => void;
  /** Open the generated draft block in Block Studio (target:'block'). */
  onOpenBlock?: (path: string, name: string) => void;
  /**
   * Preset prompts shown as one-click chips above the box. Each may pin a
   * target (e.g. "Build DQL block" → 'block'); clicking runs the build.
   */
  quickActions?: Array<{ label: string; prompt: string; target?: AiBuildTarget }>;
  // ── Spec 17 (part A) — open straight into "Modify existing block" ──────────
  /** Initial block-build mode: 'create' (default) or 'edit'. */
  initialMode?: AiBuildMode;
  /** Pre-selected block path to modify (used with initialMode:'edit'). */
  initialBlockPath?: string;
}

type BuildPhase = 'idle' | 'building' | 'ready' | 'error';

const TARGET_LABEL: Record<AiBuildTarget, string> = {
  cell: 'Cell',
  block: 'Saved query',
};

export function AiBuildResult({
  themeMode,
  initialTarget = 'cell',
  lockTarget = false,
  initialPrompt = '',
  context,
  onInsertCell,
  onOpenBlock,
  quickActions,
  initialMode = 'create',
  initialBlockPath,
}: AiBuildResultProps): JSX.Element {
  const t = themes[themeMode];
  const { dispatch } = useNotebook();
  const openSkills = useCallback(() => { dispatch({ type: 'SET_MAIN_VIEW', view: 'skills' }); }, [dispatch]);
  // An edit request can arrive for either target; coerce to Block since editing
  // an existing block is a block-target operation.
  const [target, setTarget] = useState<AiBuildTarget>(initialMode === 'edit' ? 'block' : initialTarget);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [phase, setPhase] = useState<BuildPhase>('idle');
  const [result, setResult] = useState<AiBuildResultPayload | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);
  const lastPromptRef = useRef('');

  // Spec 17 (part A) — New block vs. Modify existing.
  const [blockMode, setBlockMode] = useState<AiBuildMode>(initialMode);
  const [blockPath, setBlockPath] = useState<string | undefined>(initialBlockPath);
  // Spec 17 (part B) — domain this build is scoped to (id of a first-class domain).
  const [domain, setDomain] = useState<string | undefined>(undefined);

  // "drafting as <owner>" — best-effort, never blocks (spec part D).
  useEffect(() => {
    let cancelled = false;
    api.getIdentity()
      .then((id) => { if (!cancelled && id?.owner) setOwner(id.owner); })
      .catch(() => { /* identity is optional */ });
    return () => { cancelled = true; };
  }, []);

  const runBuild = useCallback(async (text: string, buildTarget: AiBuildTarget) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // "Modify existing" requires a chosen block before it can run.
    const editing = buildTarget === 'block' && blockMode === 'edit';
    if (editing && !blockPath) return;
    lastPromptRef.current = trimmed;
    setPhase('building');
    setErrorText(null);
    setInserted(false);
    try {
      const built = await api.aiBuild({
        prompt: trimmed,
        context,
        target: buildTarget,
        ...(owner ? { owner } : {}),
        ...(buildTarget === 'block' ? { mode: blockMode } : {}),
        ...(editing && blockPath ? { blockPath } : {}),
        ...(domain ? { domain } : {}),
      });
      setResult(built);
      setPhase('ready');
    } catch (error) {
      // One plain sentence — no stack, no internals.
      setErrorText(error instanceof Error && error.message ? error.message : 'Could not build that. Try rewording the request.');
      setResult(null);
      setPhase('error');
    }
  }, [context, owner, blockMode, blockPath, domain]);

  const onSubmit = useCallback(() => { void runBuild(prompt, target); }, [prompt, runBuild, target]);

  const onQuickAction = useCallback((action: { prompt: string; target?: AiBuildTarget }) => {
    const nextTarget = action.target && !lockTarget ? action.target : target;
    if (action.target && !lockTarget) setTarget(action.target);
    setPrompt(action.prompt);
    void runBuild(action.prompt, nextTarget);
  }, [lockTarget, runBuild, target]);

  // "Refine" re-prompts from the current text, keeping the same target.
  const onRefine = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setErrorText(null);
    setInserted(false);
    if (!prompt.trim() && lastPromptRef.current) setPrompt(lastPromptRef.current);
  }, [prompt]);

  const onDiscard = useCallback(() => {
    setResult(null);
    setErrorText(null);
    setInserted(false);
    setPhase('idle');
  }, []);

  const building = phase === 'building';
  const editingBlock = target === 'block' && blockMode === 'edit';
  const editMissingBlock = editingBlock && !blockPath;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', overflow: 'auto' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        {/* Target toggle: Cell ⇄ Block */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div role="group" aria-label="Build target" style={segmentGroupStyle(t)}>
            {(['cell', 'block'] as AiBuildTarget[]).map((value) => {
              const active = target === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={lockTarget && !active}
                  onClick={() => { if (!lockTarget) { setTarget(value); onDiscard(); } }}
                  aria-pressed={active}
                  style={segmentButtonStyle(t, active, lockTarget && !active)}
                >
                  {value === 'cell' ? <SquarePlus size={13} strokeWidth={2} /> : <Blocks size={13} strokeWidth={2} />}
                  {TARGET_LABEL[value]}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            {target === 'cell'
              ? 'Create a review-required SQL preview for a notebook cell.'
              : blockMode === 'edit'
                ? 'Rewrite an existing draft saved query.'
                : 'Generate a reusable draft saved query.'}
          </span>
          {owner && (
            <span
              title="Drafts are attributed to you"
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted, fontFamily: t.font }}
            >
              <UserRound size={12} strokeWidth={2} />
              drafting as {owner}
            </span>
          )}
        </div>

        {/* Spec 17 (part B) — domain picker (block builds only) */}
        {target === 'block' ? (
          <DomainPicker t={t} value={domain} onChange={setDomain} />
        ) : null}

        {/* Spec 17 (part A) — New block vs. Modify existing (block builds only) */}
        {target === 'block' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div role="group" aria-label="Saved query build mode" style={segmentGroupStyle(t)}>
              {(['create', 'edit'] as AiBuildMode[]).map((value) => {
                const active = blockMode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setBlockMode(value);
                      onDiscard();
                      if (value === 'create') setBlockPath(undefined);
                    }}
                    aria-pressed={active}
                    style={segmentButtonStyle(t, active, false)}
                  >
                    {value === 'create' ? <SquarePlus size={13} strokeWidth={2} /> : <SquarePen size={13} strokeWidth={2} />}
                    {value === 'create' ? 'New saved query' : 'Modify existing'}
                  </button>
                );
              })}
            </div>
            {blockMode === 'edit' ? (
              <BlockPicker t={t} selectedPath={blockPath} onSelect={(path) => { setBlockPath(path); onDiscard(); }} />
            ) : null}
          </div>
        ) : null}

        {/* Quick actions (preset prompts) */}
        {quickActions && quickActions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={building}
                onClick={() => onQuickAction(action)}
                style={{ ...ghostButtonStyle(t), opacity: building ? 0.6 : 1 }}
              >
                <Sparkles size={12} strokeWidth={2} /> {action.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Prompt box */}
        <div style={{ display: 'grid', gap: 7 }}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSubmit();
              }
            }}
            rows={3}
            placeholder={target === 'cell'
              ? 'Describe the preview SQL you want, e.g. "monthly revenue by region for the last 12 months".'
              : blockMode === 'edit'
                ? 'Describe the change, e.g. "add a 12-month trailing window and exclude test accounts".'
                : 'Describe the reusable saved query, e.g. "active customers by signup cohort".'}
            style={textareaStyle(t)}
          />
          {context?.cellSql ? (
            <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
              Using the active SQL cell{context.selection ? ' and your selection' : ''} as context.
            </div>
          ) : null}
          {editMissingBlock ? (
            <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
              Pick the saved query you want to modify above.
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={onSubmit}
              disabled={building || !prompt.trim() || editMissingBlock}
              style={{ ...primaryButtonStyle(t), opacity: building || !prompt.trim() || editMissingBlock ? 0.6 : 1 }}
            >
              {building ? <Loader2 size={13} strokeWidth={2} /> : <Hammer size={13} strokeWidth={2} />}
              {building ? (editingBlock ? 'Updating…' : 'Building…') : editingBlock ? 'Update saved query' : 'Build'}
            </button>
          </div>
        </div>

        {/* Result / error */}
        {phase === 'error' && (
          <BuildErrorCard t={t} message={errorText ?? 'Could not build that.'} onRefine={onRefine} />
        )}
        {phase === 'ready' && result?.target === 'cell' && (
          <CellResultCard
            t={t}
            sql={result.sql}
            explanation={result.explanation}
            appliedSkills={result.appliedSkills}
            diagnostics={result.diagnostics}
            route={result.route}
            inserted={inserted}
            onInsert={() => { onInsertCell?.(result.sql); setInserted(true); }}
            onRefine={onRefine}
            onDiscard={onDiscard}
            onOpenSkills={openSkills}
          />
        )}
        {phase === 'ready' && result?.target === 'block' && (
          <BlockResultCard
            t={t}
            result={result}
            owner={owner}
            editing={editingBlock}
            onOpen={() => onOpenBlock?.(result.path, result.name)}
            onRefine={onRefine}
            onDiscard={onDiscard}
            onOpenSkills={openSkills}
          />
        )}
      </div>
    </div>
  );
}

// ── Cell result ────────────────────────────────────────────────────────────

export interface CellResultCopy {
  heading: string;
  badge: string;
  guidance: string;
  insertLabel: string;
  insertedLabel: string;
}

export function resolveCellResultCopy(): CellResultCopy {
  return {
    heading: 'SQL preview',
    badge: 'Review-required',
    guidance: 'Use this as a notebook preview. For reusable governed analytics, promote the reviewed logic into a DQL draft.',
    insertLabel: 'Insert preview',
    insertedLabel: 'Preview inserted',
  };
}

function CellResultCard({
  t,
  sql,
  explanation,
  appliedSkills,
  diagnostics,
  route,
  inserted,
  onInsert,
  onRefine,
  onDiscard,
  onOpenSkills,
}: {
  t: Theme;
  sql: string;
  explanation?: string;
  appliedSkills?: Array<{ id: string; description?: string }>;
  diagnostics?: AiBuildResultPayload['diagnostics'];
  route?: AiRoute;
  inserted: boolean;
  onInsert: () => void;
  onRefine: () => void;
  onDiscard: () => void;
  onOpenSkills: () => void;
}): JSX.Element {
  const copy = resolveCellResultCopy();
  return (
    <section style={cardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Sparkles size={14} strokeWidth={2} color={t.accent} />
        <div style={{ fontSize: 12.5, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>{copy.heading}</div>
        <span style={aiDraftBadgeStyle(t)}>{copy.badge}</span>
        <RouteBadge t={t} route={route} />
      </div>
      {explanation ? (
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, fontFamily: t.font }}>{explanation}</div>
      ) : null}
      <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.45, fontFamily: t.font }}>
        {copy.guidance}
      </div>
      <CodeBlock t={t} code={sql} />
      <GuidedBySkills t={t} skills={appliedSkills} onOpenSkills={onOpenSkills} />
      <BuildContextLine t={t} diagnostics={diagnostics} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onInsert} disabled={inserted} style={{ ...primaryButtonStyle(t), opacity: inserted ? 0.65 : 1 }}>
          {inserted ? <CheckCircle2 size={13} strokeWidth={2} /> : <SquarePlus size={13} strokeWidth={2} />}
          {inserted ? copy.insertedLabel : copy.insertLabel}
        </button>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine
        </button>
        <button type="button" onClick={onDiscard} style={ghostButtonStyle(t)}>
          <Trash2 size={13} strokeWidth={2} /> Discard
        </button>
      </div>
    </section>
  );
}

// ── Block result ─────────────────────────────────────────────────────────────

function BlockResultCard({
  t,
  result,
  owner,
  editing,
  onOpen,
  onRefine,
  onDiscard,
  onOpenSkills,
}: {
  t: Theme;
  result: Extract<AiBuildResultPayload, { target: 'block' }>;
  owner: string | null;
  editing: boolean;
  onOpen: () => void;
  onRefine: () => void;
  onDiscard: () => void;
  onOpenSkills: () => void;
}): JSX.Element {
  const [sqlOpen, setSqlOpen] = useState(false);
  const { name, description, sqlPreview, grain, outputs, examples, certifierVerdict, appliedSkills, diagnostics, route, previousSql } = result;
  // Spec 17 (part A) — an edit shows a before/after diff instead of a single
  // SQL pane. We treat the build as an edit when the backend returned the
  // block's prior SQL (or when the surface launched in edit mode).
  const isEdit = editing || typeof previousSql === 'string';
  return (
    <section style={cardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Blocks size={14} strokeWidth={2} color={t.accent} />
        <div style={{ fontSize: 13, fontWeight: 850, color: t.textPrimary, fontFamily: t.font }}>{name}</div>
        <span style={aiDraftBadgeStyle(t)}>{isEdit ? 'AI-edited · draft' : 'AI-generated · draft'}</span>
        {grain ? <span style={metaPillStyle(t)}>grain {grain}</span> : null}
        <RouteBadge t={t} route={route} />
      </div>
      {description ? (
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, fontFamily: t.font }}>{description}</div>
      ) : null}

      {/* SQL — a before/after diff for edits, a single pane for new blocks. */}
      {isEdit && typeof previousSql === 'string' ? (
        <SqlDiffBlock t={t} previousSql={previousSql} nextSql={sqlPreview} />
      ) : (
        <div>
          <button type="button" onClick={() => setSqlOpen((open) => !open)} style={disclosureToggleStyle(t)}>
            {sqlOpen ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
            {sqlOpen ? 'Hide SQL this saved query will run' : 'Show SQL this saved query will run'}
          </button>
          {sqlOpen ? <div style={{ marginTop: 7 }}><CodeBlock t={t} code={sqlPreview} /></div> : null}
        </div>
      )}

      {outputs.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <SectionLabel t={t}>Outputs</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {outputs.map((output) => <span key={output} style={chipStyle(t)}>{output}</span>)}
          </div>
        </div>
      ) : null}

      {examples.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <SectionLabel t={t}>Answers questions like</SectionLabel>
          <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 3 }}>
            {examples.slice(0, 3).map((example) => (
              <li key={example} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45, fontFamily: t.font }}>{example}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <CertifierVerdictBlock t={t} verdict={certifierVerdict} />

      <GuidedBySkills t={t} skills={appliedSkills} onOpenSkills={onOpenSkills} />
      <BuildContextLine t={t} diagnostics={diagnostics} />

      {owner ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          <UserRound size={12} strokeWidth={2} /> drafting as {owner}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onOpen} style={primaryButtonStyle(t)}>
          {isEdit ? <SquarePen size={13} strokeWidth={2} /> : <Blocks size={13} strokeWidth={2} />}
          {isEdit ? 'Update the saved query' : 'Open in Saved queries'}
        </button>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine
        </button>
        <button type="button" onClick={onDiscard} style={ghostButtonStyle(t)}>
          <Trash2 size={13} strokeWidth={2} /> Discard
        </button>
      </div>
    </section>
  );
}

// ── Spec 17 (part A) — before/after SQL diff ─────────────────────────────────
// A simple, readable two-pane line diff. We don't pull in a diff library; we
// classify each line as added / removed / unchanged with a longest-common-
// subsequence walk so the "what changed" reads cleanly for a SQL block.

interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\s+$/g, '').split('\n');
  const b = after.replace(/\s+$/g, '').split('\n');
  const n = a.length;
  const m = b.length;
  // LCS table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: 'remove', text: a[i] });
      i++;
    } else {
      lines.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { lines.push({ kind: 'remove', text: a[i] }); i++; }
  while (j < m) { lines.push({ kind: 'add', text: b[j] }); j++; }
  return lines;
}

function SqlDiffBlock({ t, previousSql, nextSql }: { t: Theme; previousSql: string; nextSql: string }): JSX.Element {
  const [open, setOpen] = useState(true);
  const diff = React.useMemo(() => computeLineDiff(previousSql.trim(), nextSql.trim()), [previousSql, nextSql]);
  const added = diff.filter((line) => line.kind === 'add').length;
  const removed = diff.filter((line) => line.kind === 'remove').length;
  const unchanged = added === 0 && removed === 0;
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setOpen((value) => !value)} style={disclosureToggleStyle(t)}>
          {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
          <GitCompareArrows size={13} strokeWidth={2} />
          {open ? 'Hide what changed' : 'Show what changed'}
        </button>
        {unchanged ? (
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>No SQL changes.</span>
        ) : (
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            <span style={{ color: t.success, fontWeight: 700 }}>+{added}</span>{' '}
            <span style={{ color: t.error, fontWeight: 700 }}>-{removed}</span> line{added + removed === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {open ? (
        <pre style={{ ...codeBlockStyle(t), padding: 0 }}>
          <code style={{ display: 'block', fontFamily: t.fontMono, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {diff.map((line, index) => (
              <span
                key={index}
                style={{
                  display: 'block',
                  padding: '0 11px',
                  color: line.kind === 'add' ? t.success : line.kind === 'remove' ? t.error : t.textPrimary,
                  background:
                    line.kind === 'add' ? `${t.success}14` : line.kind === 'remove' ? `${t.error}14` : 'transparent',
                }}
              >
                <span aria-hidden style={{ userSelect: 'none', opacity: 0.7 }}>
                  {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
                </span>
                {line.text || ' '}
              </span>
            ))}
          </code>
        </pre>
      ) : null}
    </div>
  );
}

// ── Shared "what's missing to certify" ───────────────────────────────────────

export function CertifierVerdictBlock({
  t,
  verdict,
}: {
  t: Theme;
  verdict?: { blocking: string[]; warnings: string[]; ready: boolean };
}): JSX.Element | null {
  if (!verdict) return null;
  const ready = verdict.ready && verdict.blocking.length === 0;
  const notes = ready ? [] : [...verdict.blocking, ...verdict.warnings];
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <SectionLabel t={t}>What's missing to certify</SectionLabel>
      {ready ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.success, fontFamily: t.font }}>
          <CheckCircle2 size={14} strokeWidth={2} />
          Grain, outputs, and context are set.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.warning, fontFamily: t.font }}>
            <AlertTriangle size={14} strokeWidth={2} />
            Needs an owner and passing tests before it can be certified.
          </div>
          {notes.length > 0 ? (
            <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 2 }}>
              {notes.map((note) => (
                <li key={note} style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.4, fontFamily: t.font }}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BuildContextLine({
  t,
  diagnostics,
}: {
  t: Theme;
  diagnostics?: AiBuildResultPayload['diagnostics'];
}): JSX.Element | null {
  if (!diagnostics) return null;
  const semantic = diagnostics.sourceTrust === 'governed_semantic_source';
  const scope = diagnostics.activeDomain ? `domain ${diagnostics.activeDomain}` : 'project metadata';
  const relationCount = diagnostics.allowedRelations.length;
  const warning = diagnostics.warnings[0];
  return (
    <div style={{ display: 'grid', gap: 3, fontSize: 10.5, color: t.textMuted, lineHeight: 1.4, fontFamily: t.font }}>
      <span title={diagnostics.contextPackId ? `Context pack ${diagnostics.contextPackId}` : undefined}>
        {semantic ? 'Built from governed semantic context' : 'Exploratory DBT-grounded draft'} · {scope} · {relationCount} allowed relation{relationCount === 1 ? '' : 's'} · review required
      </span>
      {warning ? <span style={{ color: t.warning }}>{warning}</span> : null}
    </div>
  );
}

// ── Spec 16 — "guided by" transparency line ──────────────────────────────────
// Renders a subtle line crediting the business-context skills that shaped this
// result. Only renders when `appliedSkills` is non-empty (the backend populates
// it). Each skill links to the Skills page so users can see/edit the guidance.

export function GuidedBySkills({
  t,
  skills,
  onOpenSkills,
  onSuggestCorrection,
}: {
  t: Theme;
  skills?: Array<{ id: string; description?: string }>;
  onOpenSkills: () => void;
  onSuggestCorrection?: (skill: { id: string; description?: string }) => void;
}): JSX.Element | null {
  if (!skills || skills.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 5,
        fontSize: 11,
        color: t.textMuted,
        fontFamily: t.font,
      }}
    >
      <GraduationCap size={12} strokeWidth={2} />
      <span>guided by</span>
      {skills.map((skill, index) => (
        <React.Fragment key={skill.id}>
          {index > 0 ? <span aria-hidden style={{ color: t.textMuted }}>,</span> : null}
          <button
            type="button"
            onClick={onOpenSkills}
            title={skill.description ?? `Open the ${skill.id} skill`}
            style={{
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: t.accent,
              fontSize: 11,
              fontWeight: 700,
              fontFamily: t.font,
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {skill.id}
          </button>
        </React.Fragment>
      ))}
      {onSuggestCorrection && skills.length === 1 ? <button type="button" onClick={() => onSuggestCorrection(skills[0]!)} style={{ marginLeft: 5, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-1)', color: t.accent, padding: '3px 7px', cursor: 'pointer', fontSize: 10 }}>Suggest skill correction</button> : null}
    </div>
  );
}

// ── Spec 17 (part C) — route badge ───────────────────────────────────────────
// Subtle, consumer-facing "how this answer was reached" badge. Renders only
// when `route` is present and the tier carries a message. Reused by the cell +
// block build cards and by AgentAnswerCard.

const ROUTE_TIER_STYLE: Record<AiRoute['tier'], { tone: keyof Theme; icon: typeof BadgeCheck } | null> = {
  certified_block: { tone: 'success', icon: BadgeCheck },
  semantic_metric: { tone: 'accent', icon: Sparkles },
  generated_sql: { tone: 'textMuted', icon: FileCode2 },
  business_context: { tone: 'accent', icon: GraduationCap },
  no_answer: null,
};

export function RouteBadge({ t, route }: { t: Theme; route?: AiRoute }): JSX.Element | null {
  if (!route) return null;
  const config = ROUTE_TIER_STYLE[route.tier];
  if (!config) return null; // no_answer → render nothing special
  const Icon = config.icon;
  const tone = (t[config.tone] as string) ?? t.textMuted;
  const label = route.label?.trim() || defaultRouteLabel(route);
  return (
    <span
      title={route.ref ? `${label} (${route.ref})` : label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: tone,
        background: `${tone}14`,
        border: `1px solid ${tone}3a`,
        borderRadius: 999,
        padding: '2px 9px',
        fontFamily: t.font,
        maxWidth: '100%',
      }}
    >
      <Icon size={11} strokeWidth={2.2} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}

/** Fallback label when the backend left `label` empty. */
export function defaultRouteLabel(route: AiRoute): string {
  switch (route.tier) {
    case 'certified_block':
      return route.ref ? `Certified saved query ${route.ref}` : 'Certified saved query';
    case 'semantic_metric':
      return route.ref ? `Answered from metric ${route.ref}` : 'Answered from metric';
    case 'generated_sql':
      return 'Generated SQL preview';
    case 'business_context':
      return 'From business context';
    default:
      return '';
  }
}

// ── Spec 17 (part A) — block picker ("Modify existing") ──────────────────────
// Lists the block library (reusing api.getBlockLibrary) with a filter box, so
// the user can choose which block to rewrite. Graceful empty/error states —
// the library endpoint may be absent, in which case the user can still type a
// path manually.

function BlockPicker({
  t,
  selectedPath,
  onSelect,
}: {
  t: Theme;
  selectedPath?: string;
  onSelect: (path: string) => void;
}): JSX.Element {
  const [blocks, setBlocks] = useState<Array<{ name: string; domain: string; path: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getBlockLibrary()
      .then((res) => {
        if (cancelled) return;
        setBlocks(Array.isArray(res?.blocks) ? res.blocks.map((b) => ({ name: b.name, domain: b.domain, path: b.path })) : []);
      })
      .catch(() => { if (!cancelled) setBlocks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = blocks
    .filter((b) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return b.name.toLowerCase().includes(q) || b.path.toLowerCase().includes(q) || (b.domain ?? '').toLowerCase().includes(q);
    })
    .slice(0, 40);
  const selected = blocks.find((b) => b.path === selectedPath);

  return (
    <div style={{ display: 'grid', gap: 7, border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.cellBg, padding: 9 }}>
      <div style={{ position: 'relative' }}>
        <Search size={13} strokeWidth={2} color={t.textMuted} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={selected ? `Modifying ${selected.name} — search to change` : 'Search saved queries to modify…'}
          style={{
            width: '100%',
            border: `1px solid ${t.btnBorder}`,
            borderRadius: 7,
            background: t.appBg,
            color: t.textPrimary,
            fontSize: 12,
            fontFamily: t.font,
            padding: '7px 9px 7px 28px',
            boxSizing: 'border-box',
          }}
        />
      </div>
      {loading ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: t.textMuted, fontFamily: t.font, padding: '4px 2px' }}>
          <Loader2 size={12} strokeWidth={2} /> Loading saved queries…
        </div>
      ) : blocks.length === 0 ? (
        <div style={{ fontSize: 11.5, color: t.textMuted, fontFamily: t.font, padding: '2px 2px', lineHeight: 1.45 }}>
          No saved queries found. Type the file path of the saved query (a .dql block file) you want to modify, then press Enter.
          <input
            type="text"
            defaultValue={selectedPath ?? ''}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const value = (event.target as HTMLInputElement).value.trim();
                if (value) onSelect(value);
              }
            }}
            placeholder="blocks/revenue_by_region.dql"
            style={{
              marginTop: 6,
              width: '100%',
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 7,
              background: t.appBg,
              color: t.textPrimary,
              fontSize: 12,
              fontFamily: t.fontMono,
              padding: '7px 9px',
              boxSizing: 'border-box',
            }}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 3, maxHeight: 184, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ fontSize: 11.5, color: t.textMuted, fontFamily: t.font, padding: '4px 2px' }}>No saved queries match “{query}”.</div>
          ) : filtered.map((block) => {
            const active = block.path === selectedPath;
            return (
              <button
                key={block.path}
                type="button"
                onClick={() => onSelect(block.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                  width: '100%',
                  border: `1px solid ${active ? t.accent : 'transparent'}`,
                  background: active ? `${t.accent}14` : 'transparent',
                  borderRadius: 6,
                  padding: '6px 8px',
                  cursor: 'pointer',
                }}
              >
                <FileCode2 size={13} strokeWidth={2} color={active ? t.accent : t.textMuted} style={{ flexShrink: 0 }} />
                <span style={{ minWidth: 0, display: 'grid', gap: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.name}</span>
                  <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {block.domain ? `${block.domain} · ` : ''}{block.path}
                  </span>
                </span>
                {active ? <CheckCircle2 size={14} strokeWidth={2} color={t.accent} style={{ marginLeft: 'auto', flexShrink: 0 }} /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Spec 17 (part B) — domain picker ─────────────────────────────────────────
// A "Domain: [pick ▾ / + new]" control populated from api.getDomains. Choosing
// "+ new domain" jumps to the Domains page. Best-effort: an empty/failed list
// just shows "No domains yet".

function DomainPicker({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value?: string;
  onChange: (next: string | undefined) => void;
}): JSX.Element {
  const { state, dispatch } = useNotebook();
  const domains = authoredDomainOptionsWithCurrent(value, state.authoredDomains);

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary, fontFamily: t.font }}>Domain</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        style={{
          border: `1px solid ${t.btnBorder}`,
          borderRadius: 7,
          background: t.btnBg,
          color: value ? t.textPrimary : t.textMuted,
          fontSize: 12,
          fontFamily: t.font,
          padding: '5px 9px',
          cursor: 'pointer',
        }}
      >
        <option value="">{domains.length === 0 ? 'No domains yet' : 'No domain'}</option>
        {domains.map((domain) => (
          <option key={domain.value} value={domain.value} disabled={domain.disabled}>{domain.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'domains' })}
        style={ghostButtonStyle(t)}
        title="Create a new domain on the Modeling page"
      >
        <SquarePlus size={12} strokeWidth={2} /> New
      </button>
    </div>
  );
}

// ── Error ────────────────────────────────────────────────────────────────────

function BuildErrorCard({ t, message, onRefine }: { t: Theme; message: string; onRefine: () => void }): JSX.Element {
  return (
    <section style={{ ...cardStyle(t), borderColor: `${t.error}66` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <AlertTriangle size={15} strokeWidth={2} color={t.error} style={{ marginTop: 1, flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, color: t.textPrimary, lineHeight: 1.5, fontFamily: t.font }}>{message}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine and try again
        </button>
      </div>
    </section>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────

function CodeBlock({ t, code }: { t: Theme; code: string }): JSX.Element {
  return (
    <pre style={codeBlockStyle(t)}>
      <code style={{ fontFamily: t.fontMono, fontSize: 11.5, color: t.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {code.trim()}
      </code>
    </pre>
  );
}

function SectionLabel({ t, children }: { t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>
      {children}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function segmentGroupStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    padding: 2,
    gap: 2,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 8,
    background: t.btnBg,
  };
}

function segmentButtonStyle(t: Theme, active: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 11px',
    borderRadius: 6,
    border: '1px solid transparent',
    background: active ? t.accent : 'transparent',
    color: active ? '#ffffff' : t.textSecondary,
    fontSize: 12,
    fontWeight: active ? 800 : 600,
    fontFamily: t.font,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function textareaStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    resize: 'vertical',
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 8,
    background: t.cellBg,
    color: t.textPrimary,
    fontSize: 12.5,
    fontFamily: t.font,
    lineHeight: 1.5,
    padding: '9px 11px',
    boxSizing: 'border-box',
  };
}

function cardStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    background: t.cellBg,
    padding: 12,
    display: 'grid',
    gap: 10,
  };
}

function codeBlockStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.appBg,
    padding: '9px 11px',
    overflow: 'auto',
    maxHeight: 280,
  };
}

function primaryButtonStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'primary', size: 'md' });
}

function ghostButtonStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'ghost', size: 'md' });
}

function disclosureToggleStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: t.accent,
    fontSize: 11.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function aiDraftBadgeStyle(t: Theme): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    color: t.accent,
    background: `${t.accent}18`,
    border: `1px solid ${t.accent}40`,
    borderRadius: 999,
    padding: '2px 8px',
    fontFamily: t.font,
  };
}

function metaPillStyle(t: Theme): React.CSSProperties {
  return {
    fontSize: 10.5,
    fontWeight: 600,
    color: t.textMuted,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 999,
    padding: '2px 8px',
    fontFamily: t.font,
  };
}

function chipStyle(t: Theme): React.CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    padding: '3px 8px',
    fontFamily: t.fontMono,
  };
}

/** Shared helper: open a draft block path in Block Studio via the canonical flow. */
export function useOpenBlockInStudio(): (path: string, name: string) => Promise<void> {
  const { state, dispatch } = useNotebook();
  return useCallback(async (path: string, name: string) => {
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
}
