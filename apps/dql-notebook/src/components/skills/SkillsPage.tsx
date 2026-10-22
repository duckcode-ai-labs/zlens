// Spec 16 — Skills authoring & management.
//
// A "skill" is a shared business-context file (`skills/*.skill.md`) the agent
// applies per question: definitions ("revenue = recognized, not bookings"),
// rules ("always exclude test accounts"), vocabulary, and preferred
// metrics/blocks. This page lets users author them without touching raw
// markdown, and tags each as Project (shared) or Personal (me).
//
// The page calls the shared Skills CRUD contract via `api.*`. The endpoints may
// not exist in every build — every load/save path degrades gracefully to an
// inline message and never crashes.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CommaListInput } from '../common/CommaListInput';
import type { CSSProperties } from 'react';
import { GraduationCap, Plus, Pencil, Trash2, X, Sparkles, Loader2, AlertTriangle, RefreshCw, FolderOpen, Upload } from 'lucide-react';
import { api, type ContextAuthoringProposalV1 } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import type { Skill, SkillPathSettings, Domain } from '../../store/types';
import { skillMatchesModelingScope, skillMatchesSourcePaths } from './modeling-scope';
import { authoredDomainOptionsWithCurrent } from '../domains/authored-domain-options';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId } from '../agent/UnifiedAgentRunPanel';
import { ContextProposalReviewDrawer } from '../modeling/ContextProposalReviewDrawer';

type FormMode = { kind: 'create' } | { kind: 'edit'; skill: Skill };

/**
 * Identifier normalization applied WHILE the user types.
 *
 * The full `slugify` trims and strips leading/trailing separators, so applying
 * it per keystroke made the space bar do nothing at all: the separator it
 * produced was immediately stripped as trailing, the character vanished, and a
 * second word could never be started. Here the separator is kept, so a space
 * visibly becomes "-" and typing continues; `slugify` still runs on blur and on
 * save to settle the value.
 */
function slugifyWhileTyping(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function emptyDraft(): Skill {
  return {
    id: '',
    scope: 'project',
    description: '',
    body: '',
    preferredMetrics: [],
    preferredBlocks: [],
    vocabulary: {},
    sourcePath: '',
  };
}

export function SkillsPage({
  embedded = false,
  domainFilter = null,
  modelAreaFilter = null,
  sourcePathFilter,
}: {
  embedded?: boolean;
  domainFilter?: string | null;
  modelAreaFilter?: string | null;
  sourcePathFilter?: string[];
} = {}): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<{
    metrics: string[];
    blocks: string[];
    modelingRefs: string[];
  }>({ metrics: [], blocks: [], modelingRefs: [] });
  // Spec 17 (part B) — only authored Domain pages feed the form's picker.
  const domains = state.authoredDomains;
  const [pathSettings, setPathSettings] = useState<SkillPathSettings | null>(null);
  const [showPathEditor, setShowPathEditor] = useState(false);
  const [pathDraft, setPathDraft] = useState('skills');
  const [savingPath, setSavingPath] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [showSkillsAi, setShowSkillsAi] = useState(false);
  const [proposal, setProposal] = useState<ContextAuthoringProposalV1 | null>(null);
  const [skillCorrection, setSkillCorrection] = useState<{ skillId: string; question?: string; feedback?: string } | null>(() => {
    try {
      const raw = window.sessionStorage.getItem('dql-skill-ai-correction');
      if (!raw) return null;
      window.sessionStorage.removeItem('dql-skill-ai-correction');
      return JSON.parse(raw) as { skillId: string; question?: string; feedback?: string };
    } catch { return null; }
  });
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api
      .getSkills()
      .then((res) => {
        if (cancelled) return;
        setSkills(Array.isArray(res?.skills) ? res.skills : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSkills([]);
        setLoadError(error instanceof Error && error.message ? error.message : 'Could not load skills. Is the local ZLens server running?');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Options are best-effort — a failure just leaves the multi-selects empty.
    void api
      .getSkillOptions()
      .then((res) => {
        if (cancelled) return;
        setOptions({
          metrics: Array.isArray(res?.metrics) ? res.metrics : [],
          blocks: Array.isArray(res?.blocks) ? res.blocks : [],
          modelingRefs: Array.isArray(res?.modelingRefs) ? res.modelingRefs : [],
        });
      })
      .catch(() => {
        if (!cancelled) setOptions({ metrics: [], blocks: [], modelingRefs: [] });
      });
    void api
      .getSkillPathSettings()
      .then((result) => {
        if (cancelled) return;
        setPathSettings(result);
        setPathDraft(result.path);
      })
      .catch(() => {
        if (!cancelled) setPathSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => { if (skillCorrection) setShowSkillsAi(true); }, [skillCorrection]);

  const sorted = useMemo(() => {
    return skills
      .filter((skill) => skillMatchesModelingScope(skill, domainFilter, modelAreaFilter))
      .filter((skill) => skillMatchesSourcePaths(skill, sourcePathFilter))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [skills, domainFilter, modelAreaFilter, sourcePathFilter]);
  // A skill with no domain applies to every question, so a domain view lists
  // it too: the page shows everything Ask may use here, not only what lives here.
  const projectWide = useMemo(() => (
    domainFilter
      ? skills.filter((skill) => !skill.domain && !(skill.domains?.length)).sort((a, b) => a.id.localeCompare(b.id))
      : []
  ), [skills, domainFilter]);

  const handleSaved = useCallback((saved: Skill) => {
    setSkills((prev) => {
      const idx = prev.findIndex((s) => (s.qualifiedId ?? s.id) === (saved.qualifiedId ?? saved.id));
      if (idx === -1) return [...prev, saved];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    setForm(null);
  }, []);

  // Publishing moves the file into the shared Skills folder and gives the
  // skill its shared identity, so the row is replaced rather than patched.
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const publishSkill = useCallback(async (skill: Skill) => {
    const identity = skill.qualifiedId ?? skill.id;
    setPublishing(identity);
    setPublishError(null);
    try {
      const result = await api.publishSkill(identity);
      if (!result.ok) {
        setPublishError(result.error ?? 'Could not publish this skill.');
        return;
      }
      const published = result.skill;
      setSkills((prev) => {
        const rest = prev.filter((s) => (s.qualifiedId ?? s.id) !== identity);
        return published ? [...rest, published] : rest;
      });
      if (!published) void api.getSkills().then((res) => setSkills(res.skills)).catch(() => undefined);
    } catch (error) {
      setPublishError(error instanceof Error && error.message ? error.message : 'Could not publish this skill.');
    } finally {
      setPublishing(null);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const identity = pendingDelete.qualifiedId ?? pendingDelete.id;
      await api.deleteSkill(identity);
      setSkills((prev) => prev.filter((s) => (s.qualifiedId ?? s.id) !== identity));
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error && error.message ? error.message : 'Could not delete this skill.');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete]);

  const saveSkillPath = useCallback(async () => {
    setSavingPath(true);
    setPathError(null);
    try {
      const result = await api.updateSkillPath(pathDraft);
      setPathSettings(result);
      setPathDraft(result.path);
      setShowPathEditor(false);
      load();
    } catch (error) {
      setPathError(error instanceof Error && error.message ? error.message : 'Could not use this Skills folder.');
    } finally {
      setSavingPath(false);
    }
  }, [load, pathDraft]);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg }}>
      <div
        style={{
          maxWidth: 980,
          margin: '0 auto',
          padding: embedded ? '18px 20px 40px' : '22px 28px 40px',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 18,
            marginBottom: 18,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <GraduationCap size={20} strokeWidth={1.9} color={t.accent} />
              <div
                style={{
                  fontSize: embedded ? 18 : 22,
                  fontWeight: 700,
                  color: t.textPrimary,
                }}
              >
                {modelAreaFilter ? `${modelAreaFilter.split('::').at(-1)?.replace(/_/g, ' ')} skills` : domainFilter ? `${domainFilter} skills` : 'All skills'}
              </div>
            </div>
            <div
              style={{
                fontSize: 13,
                color: t.textMuted,
                marginTop: 6,
                maxWidth: 680,
                lineHeight: 1.5,
              }}
            >
              Definitions, vocabulary, and instructions the AI follows when answering{modelAreaFilter ? ' in this subject area' : domainFilter ? ' in this domain' : ''}. Ask uses a skill only when the question contains one of its trigger words or vocabulary — drafts never guide answers.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, color: t.textMuted, fontSize: 10.5, minWidth: 0 }}>
              <FolderOpen size={12} strokeWidth={1.8} />
              <span>Skill folder</span>
              <code style={{ color: t.textSecondary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathSettings?.path ?? 'skills'}</code>
              {pathSettings ? <span>· {pathSettings.exists ? `${pathSettings.skillCount} loaded${sourcePathFilter ? ` · ${sorted.length} shown here` : ''}` : pathSettings.skillCount > 0 ? `${pathSettings.skillCount} loaded from domain folders · this folder is not created yet` : 'not found'}</span> : null}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <button type="button" onClick={() => load()} title="Refresh" style={ghostButton(t)}>
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </button>
            <button type="button" onClick={() => { setPathError(null); setShowPathEditor((value) => !value); }} style={ghostButton(t)}>
              <FolderOpen size={13} strokeWidth={2} /> Skill folder
            </button>
            <button type="button" onClick={() => setShowSkillsAi((value) => !value)} style={ghostButton(t)}>
              <Sparkles size={13} strokeWidth={2} /> Skills AI
            </button>
            <button type="button" onClick={() => setForm({ kind: 'create' })} style={primaryButton(t)}>
              <Plus size={14} strokeWidth={2.2} /> Add skill
            </button>
          </div>
        </div>

        {showPathEditor ? (
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, padding: '12px 14px', marginBottom: 16, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textPrimary }}>Use an existing Skills folder</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                aria-label="Existing Skills folder"
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && pathDraft.trim() && !savingPath) void saveSkillPath(); }}
                placeholder="skills or ../skills"
                style={{ ...inputStyle(t), flex: 1, fontFamily: t.fontMono }}
              />
              <button type="button" onClick={() => setShowPathEditor(false)} disabled={savingPath} style={ghostButton(t)}>Cancel</button>
              <button type="button" onClick={() => void saveSkillPath()} disabled={!pathDraft.trim() || savingPath} style={{ ...primaryButton(t), opacity: pathDraft.trim() && !savingPath ? 1 : 0.55 }}>
                {savingPath ? <Loader2 size={13} strokeWidth={2} /> : null}{savingPath ? 'Connecting…' : 'Use folder'}
              </button>
            </div>
            <div style={{ fontSize: 10.5, lineHeight: 1.45, color: t.textMuted }}>
              Relative paths start from the ZLens project. If it is in a <code style={{ fontFamily: t.fontMono }}>/dql</code> folder inside your dbt repo, use <code style={{ fontFamily: t.fontMono }}>../skills</code>. Existing <code style={{ fontFamily: t.fontMono }}>.skill.md</code> and Markdown skill files are loaded in place and stay Git-owned by that repo.
            </div>
            {pathSettings?.resolvedPath ? <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.fontMono, overflowWrap: 'anywhere' }}>Resolved: {pathSettings.resolvedPath}</div> : null}
            {pathError ? <InlineNote t={t} tone="error">{pathError}</InlineNote> : null}
          </div>
        ) : null}

        {showSkillsAi ? <SkillsAiPanel themeMode={state.themeMode} domain={domainFilter} modelAreaId={modelAreaFilter} selectedSkill={form?.kind === 'edit' ? form.skill : skills.find((skill) => (skill.qualifiedId ?? skill.id) === skillCorrection?.skillId || skill.id === skillCorrection?.skillId)} correction={skillCorrection} onCorrectionStarted={() => setSkillCorrection(null)} onReviewProposal={setProposal} /> : null}

        {/* Body states */}
        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: t.textMuted,
              fontSize: 13,
              padding: '40px 0',
            }}
          >
            <Loader2 size={15} strokeWidth={2} /> Loading skills…
          </div>
        ) : loadError ? (
          <ErrorPanel t={t} message={loadError} onRetry={() => load()} />
        ) : sorted.length === 0 && projectWide.length === 0 ? (
          <EmptyState t={t} onAdd={() => setForm({ kind: 'create' })} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {publishError ? <InlineNote t={t} tone="error">{publishError}</InlineNote> : null}
            {sorted.length === 0 ? (
              <div style={{ fontSize: 12, color: t.textMuted, border: `1px dashed ${t.btnBorder}`, borderRadius: 9, padding: 14 }}>
                No skills belong to {domainFilter} yet. Add one with the words people use when they ask about it.
              </div>
            ) : null}
            {sorted.map((skill) => (
              <SkillRow
                key={skill.qualifiedId ?? skill.id}
                skill={skill}
                t={t}
                onEdit={() => setForm({ kind: 'edit', skill })}
                onPublish={() => void publishSkill(skill)}
                publishing={publishing === (skill.qualifiedId ?? skill.id)}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(skill);
                }}
              />
            ))}
            {projectWide.length ? (
              <>
                <div style={{ marginTop: 12, fontSize: 12, fontWeight: 750, color: t.textPrimary }}>
                  Project-wide skills <span style={{ color: t.textMuted, fontWeight: 600 }}>· {projectWide.length} · apply to every domain</span>
                </div>
                {projectWide.map((skill) => (
                  <SkillRow
                    key={skill.qualifiedId ?? skill.id}
                    skill={skill}
                    t={t}
                    onEdit={() => setForm({ kind: 'edit', skill })}
                    onPublish={() => void publishSkill(skill)}
                    publishing={publishing === (skill.qualifiedId ?? skill.id)}
                    onDelete={() => {
                      setDeleteError(null);
                      setPendingDelete(skill);
                    }}
                  />
                ))}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Add / Edit drawer */}
      {form ? <SkillFormDrawer mode={form} options={options} domains={domains} defaultDomain={domainFilter} defaultModelArea={modelAreaFilter} existingIds={skills.map((s) => s.id)} t={t} onClose={() => setForm(null)} onSaved={handleSaved} /> : null}

      {/* Delete confirm */}
      {pendingDelete ? (
        <ConfirmDeleteDialog
          skill={pendingDelete}
          t={t}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (!deleting) setPendingDelete(null);
          }}
          onConfirm={confirmDelete}
        />
      ) : null}
      {proposal ? <ContextProposalReviewDrawer proposal={proposal} theme={t} onClose={() => setProposal(null)} onCommitted={() => { setProposal(null); load(); }} /> : null}
    </div>
  );
}

function SkillsAiPanel({ themeMode, domain, modelAreaId, selectedSkill, correction, onCorrectionStarted, onReviewProposal }: { themeMode: ThemeMode; domain: string | null; modelAreaId: string | null; selectedSkill?: Skill; correction?: { skillId: string; question?: string; feedback?: string } | null; onCorrectionStarted: () => void; onReviewProposal: (proposal: ContextAuthoringProposalV1) => void }) {
  const t = themes[themeMode];
  const scope = `skills:${domain ?? 'all'}:${modelAreaId ?? 'all'}:${selectedSkill?.qualifiedId ?? selectedSkill?.id ?? 'new'}`;
  const { threadId, onThreadIdChange } = usePersistedAgentThreadId(scope);
  return <section style={{ height: 'min(600px, calc(100vh - 260px))', minHeight: 400, marginBottom: 18, border: '1px solid var(--border-default)', borderRadius: 11, overflow: 'hidden', background: t.cellBg }}>
    <UnifiedAgentRunPanel
      themeMode={themeMode}
      title="Skills AI"
      scopeHint="Skill proposal · metadata only · activation stays separate"
      composerPlaceholder="Describe skill guidance or a correction…"
      initialMode="skill"
      selectedObject={selectedSkill ? { kind: 'skill', id: selectedSkill.qualifiedId ?? selectedSkill.id, title: selectedSkill.id, path: selectedSkill.sourcePath } : modelAreaId ? { kind: 'model_area', id: modelAreaId } : domain ? { kind: 'domain', id: domain } : { kind: 'workspace', title: 'New skill draft' }}
      workspaceContext={{ domain, modelAreaId, targetSkillId: selectedSkill?.qualifiedId ?? selectedSkill?.id, providerSafety: 'metadata_only' }}
      threadId={threadId}
      onThreadIdChange={onThreadIdChange}
      autoRun={correction && selectedSkill ? { text: `${correction.feedback ?? 'Correct this skill.'}\n\nApplied skill: ${selectedSkill.qualifiedId ?? selectedSkill.id}\nQuestion: ${correction.question ?? 'Not retained'}\nSave any corrected version as draft and preserve its analytical policy.`, mode: 'skill', nonce: 1 } : undefined}
      onRunningChange={(running) => { if (running && correction) onCorrectionStarted(); }}
      onReviewAuthoringProposal={(artifact) => {
        const value = artifact.payload as ContextAuthoringProposalV1 | undefined;
        if (value?.version === 1 && value.trustState === 'review_required') onReviewProposal(value);
      }}
      emptyHint="Describe the skill guidance or correction. Skills AI can draft metadata and canonical references, but cannot activate, grant tools, or make joins permissible."
      examplePrompts={[
        { label: 'Create a skill', prompt: 'Create a draft skill for the selected domain and area, with triggers, exclusions, clarification rules, and examples.' },
        { label: 'Improve this skill', prompt: 'Improve the selected skill while preserving its analytical policy and governed references.' },
        { label: 'Add vocabulary rules', prompt: 'Propose vocabulary and clarification guidance for this domain without inventing governed references.' },
      ]}
    />
  </section>;
}

// ── List row ─────────────────────────────────────────────────────────────────

// Prototype skill card: icon tile + mono id + badges header row, one-line
// description, and a Details toggle that opens the 2-col Apply-when /
// Prefer-these-metrics grid with the full-width Guidance box.
function SkillRow({ skill, t, onEdit, onDelete, onPublish, publishing = false }: { skill: Skill; t: Theme; onEdit: () => void; onDelete: () => void; onPublish?: () => void; publishing?: boolean }): JSX.Element {
  const isPrivate = skill.visibility === 'private';
  const [expanded, setExpanded] = useState(false);
  const domains = skill.domains?.length ? skill.domains : skill.domain ? [skill.domain] : [];
  return (
    <section
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 11,
        background: t.cellBg,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px' }}>
        <span style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <GraduationCap size={14} strokeWidth={1.75} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary, fontFamily: t.fontMono }}>{skill.id}</span>
            {isPrivate ? (
              <span style={starterBadge(t)} title="Outside Git. It shapes no answer until you publish it.">private — not applied</span>
            ) : null}
            {!isPrivate && skill.status === 'draft' ? <span style={starterBadge(t)}>draft — inactive</span> : null}
            {!isPrivate && (skill.status === 'active' || !skill.status) ? <span style={activeBadge(t)}>active</span> : null}
            {domains.map((domain) => (
              <span key={domain} style={domainBadge(t)}>
                {domain}
              </span>
            ))}
            {skill.isStarter ? (
              <span style={starterBadge(t)} title="A dbt-seeded starter — edit it to make it yours">
                <Sparkles size={10} strokeWidth={2.2} /> starter — edit me
              </span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 12,
              color: skill.description ? t.textSecondary : t.textMuted,
              fontStyle: skill.description ? undefined : 'italic',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {skill.description || 'No description yet.'}
          </div>
          <div
            title={skill.sourcePath}
            style={{
              marginTop: 3,
              color: t.textMuted,
              fontSize: 10,
              fontFamily: t.fontMono,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {skill.sourcePath}
          </div>
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)} style={{ ...ghostButton(t), height: 26, padding: '0 10px', fontSize: 11 }} title={expanded ? 'Hide skill details' : 'Show skill details'}>
          {expanded ? 'Hide details' : 'Details'}
        </button>
        {isPrivate && onPublish ? (
          <button type="button" onClick={onPublish} disabled={publishing} style={{ ...ghostButton(t), height: 26, padding: '0 10px', fontSize: 11, gap: 5 }} title="Move this skill into the shared Skills folder, where it starts shaping answers">
            {publishing ? <Loader2 size={12} strokeWidth={2} /> : <Upload size={12} strokeWidth={1.75} />}
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        ) : null}
        <button type="button" onClick={onEdit} style={{ ...iconButton(t), width: 26, height: 26 }} title="Edit skill">
          <Pencil size={12} strokeWidth={1.75} />
        </button>
        <button type="button" onClick={onDelete} style={{ ...iconButton(t), width: 26, height: 26 }} title="Delete skill">
          <Trash2 size={12} strokeWidth={1.75} />
        </button>
      </div>
      {expanded ? (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            padding: '12px 14px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '12px 20px',
          }}
        >
          <SkillPillGroup t={t} label="Apply when" values={skill.triggers} empty="No trigger phrases defined" />
          <SkillPillGroup t={t} label="Prefer these metrics" values={skill.preferredMetrics} empty="No preferred metrics" accent mono />
          <SkillPillGroup t={t} label="Reuse these saved queries" values={skill.preferredBlocks} empty="No preferred saved queries" accent mono />
          <SkillPillGroup t={t} label="Ask first when" values={skill.clarifyWhen} empty="No clarification rule defined" />
          {skill.exclusions?.length ? <SkillPillGroup t={t} label="Avoid when" values={skill.exclusions} empty="" /> : null}
          {skill.modelAreaRefs?.length ? <SkillPillGroup t={t} label="Subject areas" values={skill.modelAreaRefs} empty="" mono /> : null}
          {skill.sourceRefs?.length ? <SkillPillGroup t={t} label="Guided modeling objects" values={skill.sourceRefs} empty="" mono /> : null}
          {skill.body ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={sectionEyebrow(t)}>Guidance</div>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: t.textSecondary,
                  background: 'var(--bg-1)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflow: 'auto',
                }}
              >
                {skill.body}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── Form drawer (add / edit) ─────────────────────────────────────────────────

function SkillFormDrawer({ mode, options, domains, defaultDomain = null, defaultModelArea = null, existingIds, t, onClose, onSaved }: { mode: FormMode; options: { metrics: string[]; blocks: string[]; modelingRefs: string[] }; domains: Domain[]; defaultDomain?: string | null; defaultModelArea?: string | null; existingIds: string[]; t: Theme; onClose: () => void; onSaved: (skill: Skill) => void }): JSX.Element {
  const { dispatch } = useNotebook();
  const editing = mode.kind === 'edit';
  // New skills authored from a domain-scoped list belong to that domain by
  // default — otherwise they would save fine but vanish from the filtered list.
  const [draft, setDraft] = useState<Skill>(() => (mode.kind === 'edit' ? { ...mode.skill } : { ...emptyDraft(), domain: defaultDomain ?? undefined, domains: defaultDomain ? [defaultDomain] : [], modelAreaRefs: defaultModelArea ? [defaultModelArea] : [] }));
  // Track whether the user has manually edited the id slug so name→slug
  // auto-fill stops once they take control (create only).
  const [idTouched, setIdTouched] = useState(editing);
  const [name, setName] = useState(() => (mode.kind === 'edit' ? mode.skill.id : ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof Skill>(key: K, value: Skill[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);
  // A policy field left empty is removed, so an untouched skill saves no policy at all.
  const setPolicy = useCallback(<K extends keyof NonNullable<Skill['analyticalPolicy']>>(key: K, value: NonNullable<Skill['analyticalPolicy']>[K] | undefined) => {
    setDraft((prev) => {
      const next = { ...(prev.analyticalPolicy ?? {}), [key]: value };
      if (value === undefined || value === '') delete next[key];
      return { ...prev, analyticalPolicy: Object.keys(next).length ? next : undefined };
    });
  }, []);
  const findable = (draft.triggers ?? []).length > 0 || Object.keys(draft.vocabulary ?? {}).length > 0;

  const onNameChange = (value: string) => {
    setName(value);
    if (!editing && !idTouched) set('id', slugify(value));
  };

  const idCollision = !editing && draft.id.length > 0 && existingIds.includes(draft.id);
  const canSave = draft.id.trim().length > 0 && draft.body.trim().length > 0 && !idCollision && !saving;
  const domainOptions = authoredDomainOptionsWithCurrent(draft.domain, domains);

  const onSave = useCallback(async () => {
    const payload: Skill = {
      ...draft,
      id: draft.id.trim(),
      description: draft.description?.trim() ? draft.description.trim() : undefined,
      body: draft.body,
      domain: draft.domain?.trim() ? draft.domain.trim() : undefined,
      domains: (draft.domains ?? (draft.domain ? [draft.domain] : [])).map((value) => value.trim()).filter(Boolean),
      modelAreaRefs: (draft.modelAreaRefs ?? []).map((value) => value.trim()).filter(Boolean),
      triggers: (draft.triggers ?? []).map((value) => value.trim()).filter(Boolean),
      exclusions: (draft.exclusions ?? []).map((value) => value.trim()).filter(Boolean),
      preferredDimensions: (draft.preferredDimensions ?? []).map((value) => value.trim()).filter(Boolean),
      requiredFilters: (draft.requiredFilters ?? []).map((value) => value.trim()).filter(Boolean),
      clarifyWhen: (draft.clarifyWhen ?? []).map((value) => value.trim()).filter(Boolean),
      examples: (draft.examples ?? []).map((value) => value.trim()).filter(Boolean),
      sourceRefs: (draft.sourceRefs ?? []).map((value) => value.trim()).filter(Boolean),
    };
    setSaving(true);
    setError(null);
    try {
      const res = editing ? await api.updateSkill(mode.kind === 'edit' ? (mode.skill.qualifiedId ?? mode.skill.id) : payload.id, payload) : await api.createSkill(payload);
      onSaved(res.skill ?? payload);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save this skill. Try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, editing, mode, onSaved]);

  return (
    <div style={drawerScrim} onClick={() => !saving && onClose()}>
      <div style={drawerPanel(t)} onClick={(e) => e.stopPropagation()}>
        {/* Drawer header — prototype: icon tile + title + git subtitle */}
        <div style={drawerHeader(t)}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <GraduationCap size={15} strokeWidth={1.75} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary }}>{editing ? 'Edit skill' : 'New skill'}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 1 }}>
              {draft.visibility === 'private'
                ? 'Private · outside Git · applied only after you publish it'
                : 'Git-backed guidance · applied only when triggers match'}
            </div>
          </div>
          <button type="button" onClick={() => !saving && onClose()} style={{ ...iconButton(t), width: 26, height: 26, border: 'none', background: 'none' }} title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Drawer body — prototype two-column grid: Identity | When to apply,
            Guidance (spans 2 rows) | Prefer these assets. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '18px 22px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px 28px',
            alignContent: 'start',
          }}
        >
          {/* Identity */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionEyebrow(t)}>Identity</div>
            {editing ? null : (
              <div role="radiogroup" aria-label="Skill visibility" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {([
                  { value: 'shared' as const, label: 'Shared with the team', description: 'Saved in Git. Ask applies it once active.' },
                  { value: 'private' as const, label: 'Private to me', description: 'Outside Git. Applies to no answer until you publish it.' },
                ]).map((option) => {
                  const selected = (draft.visibility ?? 'shared') === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => set('visibility', option.value)}
                      style={{
                        display: 'grid',
                        gap: 3,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: `1px solid ${selected ? t.accent : t.btnBorder}`,
                        background: selected ? 'var(--accent-dim)' : t.cellBg,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: t.font,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{option.label}</span>
                      <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.3 }}>{option.description}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Name</span>
              <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Revenue definition" style={inputStyle(t)} />
              <span style={{ fontSize: 10.5, color: t.textMuted }}>
                Saved as{' '}
                <input
                  type="text"
                  value={`${draft.visibility === 'private' ? '.dql/local/private/skills' : 'skills'}/${draft.id}.skill.md`}
                  disabled={editing}
                  onChange={(e) => {
                    setIdTouched(true);
                    set('id', slugifyWhileTyping(e.target.value.replace(/^(?:\.dql\/local\/private\/)?skills\//, '').replace(/\.skill\.md$/, '')));
                  }}
                  onBlur={() => set('id', slugify(draft.id))}
                  title="File name — letters, numbers, and dashes"
                  style={{ border: 'none', background: 'none', outline: 'none', padding: 0, fontFamily: t.fontMono, fontSize: 10.5, color: t.textSecondary, width: `${Math.max(20, draft.id.length + 15)}ch`, borderBottom: editing ? 'none' : `1px dashed ${t.btnBorder}` }}
                />
              </span>
              {idCollision ? (
                <InlineNote t={t} tone="error">
                  A skill with this id already exists.
                </InlineNote>
              ) : null}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Domain</span>
                <select
                  value={draft.domain ?? ''}
                  onChange={(e) => {
                    const domain = e.target.value || undefined;
                    set('domain', domain);
                    set('domains', domain ? [domain] : []);
                  }}
                  style={{ ...inputStyle(t), cursor: 'pointer', color: draft.domain ? t.textPrimary : t.textMuted }}
                >
                  <option value="">{domains.length === 0 ? 'No domains yet' : 'No domain'}</option>
                  {domainOptions.map((domain) => (
                    <option key={domain.value} value={domain.value} disabled={domain.disabled}>
                      {domain.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Type</span>
                <select value={draft.kind ?? 'custom'} onChange={(e) => set('kind', e.target.value as Skill['kind'])} style={{ ...inputStyle(t), cursor: 'pointer' }}>
                  <option value="custom">Custom guidance</option>
                  <option value="domain_reference">Domain reference — broad context</option>
                  <option value="metric_policy">Policy — focused rule</option>
                  <option value="glossary">Glossary</option>
                  <option value="analysis_pattern">Analysis pattern</option>
                  <option value="sql_policy">SQL policy</option>
                </select>
              </label>
            </div>
            <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'domains' })} style={{ border: 'none', background: 'none', padding: 0, fontSize: 10.5, color: t.accent, cursor: 'pointer', fontFamily: t.font, alignSelf: 'flex-start' }} title="Create a new domain on the Modeling page">
              + New domain
            </button>
            <div>
              <span style={{ ...formLabelText(t), display: 'block', marginBottom: 5 }}>Lifecycle</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.btnBorder}`, borderRadius: 7, background: 'var(--bg-1)' }}>
                {(['active', 'draft', 'deprecated'] as const).map((status) => {
                  const selected = (draft.status ?? 'active') === status;
                  return (
                    <button
                      key={status}
                      type="button"
                      onClick={() => set('status', status)}
                      style={{ border: 'none', borderRadius: 5, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, background: selected ? t.cellBg : 'transparent', color: selected ? t.textPrimary : t.textMuted, boxShadow: selected ? '0 1px 3px rgba(26,26,26,0.1)' : 'none', textTransform: 'capitalize' }}
                    >
                      {status}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 10.5, color: t.textMuted, marginLeft: 8 }}>
                {(draft.status ?? 'active') === 'active' ? 'Guides matching answers.' : draft.status === 'draft' ? 'Drafts never guide answers.' : 'Kept in Git for history only.'}
              </span>
            </div>
          </div>

          {/* When to apply */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionEyebrow(t)}>When to apply</div>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Apply when the question mentions</span>
              <ChipInput t={t} values={draft.triggers ?? []} onChange={(next) => set('triggers', next)} placeholder="Add phrase, press Enter" />
              {!findable ? (
                <span role="note" style={{ fontSize: 10.5, color: 'var(--status-warning)', lineHeight: 1.45 }}>
                  Ask uses a skill only when a question contains one of its trigger words or vocabulary. Add at least one, or this skill is never used.
                </span>
              ) : null}
            </label>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Ask first when</span>
              <CommaListInput
                values={draft.clarifyWhen ?? []}
                onChange={(next) => set('clarifyWhen', next)}
                placeholder="e.g. 'sales' could mean revenue or order count"
                style={inputStyle(t)}
              />
            </label>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Avoid when</span>
              <CommaListInput
                values={draft.exclusions ?? []}
                onChange={(next) => set('exclusions', next)}
                placeholder="e.g. question is about pipeline or bookings"
                style={inputStyle(t)}
              />
            </label>
          </div>

          {/* Guidance — spans both rows of the left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, gridRow: 'span 2' }}>
            <div style={sectionEyebrow(t)}>Guidance</div>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>One-line summary</span>
              <input type="text" value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="What rule does this skill encode?" style={inputStyle(t)} />
            </label>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Full guidance</span>
              <textarea value={draft.body} onChange={(e) => set('body', e.target.value)} rows={9} placeholder="Definitions, exclusions, edge cases — written for the agent." style={textareaStyle(t)} />
            </label>
          </div>

          {/* Prefer these assets */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionEyebrow(t)}>Prefer these assets</div>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Metrics</span>
              <MultiSelect t={t} options={options.metrics} optionKind="metrics" selected={draft.preferredMetrics} onChange={(next) => set('preferredMetrics', next)} placeholder="Search metrics…" emptyOptionsHint="No metrics available from the project yet." />
            </label>
            <label style={formLabelCol}>
              <span style={formLabelText(t)}>Saved queries</span>
              <MultiSelect t={t} options={options.blocks} optionKind="blocks" selected={draft.preferredBlocks} onChange={(next) => set('preferredBlocks', next)} placeholder="Search saved queries…" emptyOptionsHint="No saved queries available from the project yet." />
            </label>
          </div>

          {/* Rules Ask enforces: applied to every answer the skill is used for, not guidance the AI may skip. */}
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionEyebrow(t)}>Rules Ask enforces</div>
            <span style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.45 }}>
              Guidance above is advice the AI reads. These rules are applied to every answer this skill is used for: AI-written SQL that leaves out a required filter is not run.
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Required filters</span>
                <textarea
                  value={(draft.requiredFilters ?? []).join('\n')}
                  onChange={(event) => set('requiredFilters', event.target.value.split('\n'))}
                  rows={3}
                  placeholder={"status = 'completed'\nis_test = false"}
                  style={{ ...textareaStyle(t), fontFamily: t.fontMono, fontSize: 11.5 }}
                />
                <span style={{ fontSize: 10.5, color: t.textMuted }}>One per line: a column and the value it must have.</span>
              </label>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Date for periods</span>
                <input type="text" value={draft.analyticalPolicy?.timeRole ?? ''} onChange={(event) => setPolicy('timeRole', event.target.value.trim() || undefined)} placeholder="order_date" style={inputStyle(t)} />
                <span style={{ fontSize: 10.5, color: t.textMuted }}>The date "last month" and "this year" are measured on.</span>
              </label>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Periods</span>
                <select value={draft.analyticalPolicy?.completenessPolicy ?? ''} onChange={(event) => setPolicy('completenessPolicy', (event.target.value || undefined) as NonNullable<Skill['analyticalPolicy']>['completenessPolicy'])} style={{ ...inputStyle(t), cursor: 'pointer' }}>
                  <option value="">Not set</option>
                  <option value="latest_complete">Use the latest complete period</option>
                  <option value="closed_period">Only closed periods</option>
                  <option value="partial_current">Include the current period so far</option>
                </select>
              </label>
              <label style={formLabelCol}>
                <span style={formLabelText(t)}>Rankings use</span>
                <select value={draft.analyticalPolicy?.defaultRankingPeriod ?? ''} onChange={(event) => setPolicy('defaultRankingPeriod', (event.target.value || undefined) as NonNullable<Skill['analyticalPolicy']>['defaultRankingPeriod'])} style={{ ...inputStyle(t), cursor: 'pointer' }}>
                  <option value="">Not set</option>
                  <option value="current">The current period</option>
                  <option value="comparison">The comparison period</option>
                </select>
              </label>
            </div>
          </div>

          {/* Advanced fields the prototype folds away — all wiring preserved. */}
          <details style={{ gridColumn: '1 / -1' }}>
            <summary style={{ fontSize: 11.5, fontWeight: 650, color: t.accent, cursor: 'pointer' }}>Advanced — subject areas, dimensions, and vocabulary</summary>
            <div style={{ display: 'grid', gap: 14, marginTop: 12 }}>
              <Field label="Focused subject areas (optional)" t={t} hint="Comma-separated subject-area ids from the Modeling page. Inside its domain, the skill is used only for these subject areas; it never expands access.">
                <CommaListInput values={draft.modelAreaRefs ?? []} onChange={(next) => set('modelAreaRefs', next)} placeholder="customer_lifecycle, revenue_reporting" style={inputStyle(t)} />
              </Field>
              <Field label="Preferred dimensions" t={t} hint="Business-safe dimensions the agent should prefer when they are compatible.">
                <CommaListInput values={draft.preferredDimensions ?? []} onChange={(next) => set('preferredDimensions', next)} placeholder="region, month" style={inputStyle(t)} />
              </Field>
              <Field label="Qualified models and relationships" t={t} hint="Optional canonical IDs from Modeling. Validated references create guided_by edges; legacy free text cannot authorize joins.">
                <MultiSelect t={t} options={options.modelingRefs} optionKind="modelingRefs" selected={draft.sourceRefs ?? []} onChange={(next) => set('sourceRefs', next)} placeholder="Search qualified models and relationships…" emptyOptionsHint="No governed Modeling references are available yet." />
              </Field>
              <Field label="Vocabulary" t={t} hint="Map your terms to a target, e.g. arr → metric:arr or revenue → block:revenue_by_region.">
                <VocabularyEditor t={t} value={draft.vocabulary} onChange={(next) => set('vocabulary', next)} />
              </Field>
            </div>
          </details>

          {error ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <InlineNote t={t} tone="error">
                {error}
              </InlineNote>
            </div>
          ) : null}
        </div>

        {/* Drawer footer */}
        <div style={drawerFooter(t)}>
          <span style={{ fontSize: 10.5, color: t.textMuted, flex: 1, textAlign: 'left' }}>Saved to Git — review in source control before merging.</span>
          <button type="button" onClick={() => !saving && onClose()} style={ghostButton(t)}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={!canSave} style={{ ...primaryButton(t), opacity: canSave ? 1 : 0.55 }}>
            {saving ? <Loader2 size={13} strokeWidth={2} /> : null}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create skill'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chip input (trigger phrases) ─────────────────────────────────────────────

// Prototype chip box: accent pills with × inside a bordered box, plus an
// inline borderless input. Enter (or comma) adds the phrase.
function ChipInput({ t, values, onChange, placeholder }: { t: Theme; values: string[]; onChange: (next: string[]) => void; placeholder: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const add = (value: string) => {
    const v = value.trim().replace(/,$/, '');
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setQuery('');
  };
  return (
    <div style={chipBox(t)}>
      {values.map((value) => (
        <span key={value} style={accentPill(t)}>
          {value}
          <button type="button" onClick={() => onChange(values.filter((s) => s !== value))} style={pillRemove(t)} title="Remove">
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(query);
          } else if (e.key === 'Backspace' && !query && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => add(query)}
        placeholder={values.length ? '' : placeholder}
        style={chipBoxInput(t)}
      />
    </div>
  );
}

// ── Multi-select (preferred metrics / blocks) ────────────────────────────────

function MultiSelect({ t, options, optionKind, selected, onChange, placeholder, emptyOptionsHint }: { t: Theme; options: string[]; optionKind: 'metrics' | 'blocks' | 'modelingRefs'; selected: string[]; onChange: (next: string[]) => void; placeholder: string; emptyOptionsHint: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const [remoteOptions, setRemoteOptions] = useState<string[]>(options);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .getSkillOptions(query)
        .then((result) => {
          if (!cancelled) setRemoteOptions(optionKind === 'metrics' ? result.metrics : optionKind === 'blocks' ? result.blocks : result.modelingRefs);
        })
        .catch(() => {
          if (!cancelled) setRemoteOptions(options);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [optionKind, options, query]);
  const available = useMemo(
    () =>
      remoteOptions
        .filter((o) => !selected.includes(o))
        .filter((o) => (query ? o.toLowerCase().includes(query.toLowerCase()) : true))
        .slice(0, 8),
    [remoteOptions, selected, query],
  );

  const add = (value: string) => {
    const v = value.trim();
    if (!v || selected.includes(v)) return;
    onChange([...selected, v]);
    setQuery('');
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={chipBox(t)}>
        {selected.map((value) => (
          <span key={value} style={{ ...accentPill(t), fontFamily: t.fontMono }}>
            {value}
            <button type="button" onClick={() => onChange(selected.filter((s) => s !== value))} style={pillRemove(t)} title="Remove">
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(query);
            }
          }}
          placeholder={selected.length ? '' : placeholder}
          style={chipBoxInput(t)}
        />
      </div>
      {available.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {available.map((option) => (
            <button key={option} type="button" onClick={() => add(option)} style={suggestionChip(t)}>
              <Plus size={10} strokeWidth={2.4} /> {option}
            </button>
          ))}
        </div>
      ) : remoteOptions.length === 0 ? (
        <div style={{ fontSize: 11, color: t.textMuted }}>{emptyOptionsHint} You can still type a value and press Enter.</div>
      ) : null}
    </div>
  );
}

// ── Vocabulary editor (term → target rows) ───────────────────────────────────

function VocabularyEditor({ t, value, onChange }: { t: Theme; value: Record<string, string>; onChange: (next: Record<string, string>) => void }): JSX.Element {
  // Edit as an ordered row list so empty/duplicate terms don't collapse while typing.
  const [rows, setRows] = useState<Array<{ term: string; target: string }>>(() => Object.entries(value ?? {}).map(([term, target]) => ({ term, target })));

  const commit = (next: Array<{ term: string; target: string }>) => {
    setRows(next);
    const map: Record<string, string> = {};
    for (const row of next) {
      const term = row.term.trim();
      if (term) map[term] = row.target.trim();
    }
    onChange(map);
  };

  const update = (index: number, patch: Partial<{ term: string; target: string }>) => {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {rows.map((row, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" value={row.term} onChange={(e) => update(index, { term: e.target.value })} placeholder="arr" style={{ ...inputStyle(t), flex: 1 }} />
          <span style={{ color: t.textMuted, fontSize: 13 }}>→</span>
          <input type="text" value={row.target} onChange={(e) => update(index, { target: e.target.value })} placeholder="metric:arr" style={{ ...inputStyle(t), flex: 1.3, fontFamily: t.fontMono }} />
          <button type="button" onClick={() => commit(rows.filter((_, i) => i !== index))} style={iconButton(t)} title="Remove row">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { term: '', target: '' }])} style={{ ...ghostButton(t), justifySelf: 'start' }}>
        <Plus size={12} strokeWidth={2.2} /> Add term
      </button>
    </div>
  );
}

// ── Empty / error states ─────────────────────────────────────────────────────

function EmptyState({ t, onAdd }: { t: Theme; onAdd: () => void }): JSX.Element {
  return (
    <div
      style={{
        border: `1px dashed ${t.cellBorder}`,
        borderRadius: 12,
        background: t.cellBg,
        padding: '34px 28px',
        textAlign: 'center',
        display: 'grid',
        gap: 12,
        justifyItems: 'center',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: `${t.accent}18`,
          color: t.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <GraduationCap size={22} strokeWidth={1.9} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Teach the AI your business rules</div>
      <div
        style={{
          fontSize: 13,
          color: t.textMuted,
          maxWidth: 460,
          lineHeight: 1.55,
        }}
      >
        Skills are the definitions, rules, and vocabulary the AI follows when it answers — like "revenue = recognized, not bookings" or "always exclude test accounts." Add your first one to start guiding every answer.
      </div>
      <button type="button" onClick={onAdd} style={{ ...primaryButton(t), marginTop: 4 }}>
        <Plus size={14} strokeWidth={2.2} /> Add your first skill
      </button>
    </div>
  );
}

function ErrorPanel({ t, message, onRetry }: { t: Theme; message: string; onRetry: () => void }): JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${t.warning}55`,
        borderRadius: 10,
        background: `${t.warning}12`,
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 11,
      }}
    >
      <AlertTriangle size={16} strokeWidth={2} color={t.warning} style={{ marginTop: 1, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>Skills are not available right now</div>
        <div
          style={{
            fontSize: 12.5,
            color: t.textSecondary,
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {message}
        </div>
        <button type="button" onClick={onRetry} style={{ ...ghostButton(t), marginTop: 10 }}>
          <RefreshCw size={13} strokeWidth={2} /> Retry
        </button>
      </div>
    </div>
  );
}

// ── Delete confirm dialog ────────────────────────────────────────────────────

function ConfirmDeleteDialog({ skill, t, deleting, error, onCancel, onConfirm }: { skill: Skill; t: Theme; deleting: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div style={modalScrim} onClick={onCancel}>
      <div style={modalCard(t)} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Trash2 size={16} strokeWidth={2} color={t.error} />
          <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Delete this skill?</div>
        </div>
        <div style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.55 }}>
          <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>{skill.id}</span> will be removed and the AI will stop following it. The file moves to a recovery bundle under <span style={{ fontFamily: t.fontMono }}>.dql/local/trash/</span>, so it can be fetched back.
        </div>
        {error ? (
          <InlineNote t={t} tone="error">
            {error}
          </InlineNote>
        ) : null}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
          }}
        >
          <button type="button" onClick={onCancel} disabled={deleting} style={ghostButton(t)}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={deleting} style={{ ...dangerButton(t), opacity: deleting ? 0.6 : 1 }}>
            {deleting ? <Loader2 size={13} strokeWidth={2} /> : <Trash2 size={13} strokeWidth={2} />}
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function sectionEyebrow(t: Theme): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: t.textMuted,
    marginBottom: 5,
  };
}

// Prototype expanded-card cell: uppercase eyebrow + pill row. Accent pills for
// preferred assets, quiet pills for trigger phrases.
function SkillPillGroup({ t, label, values, empty, accent = false, mono = false }: { t: Theme; label: string; values?: string[]; empty: string; accent?: boolean; mono?: boolean }): JSX.Element {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={sectionEyebrow(t)}>{label}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {values?.length ? (
          values.map((value) => (
            <span
              key={value}
              style={{
                fontSize: 11,
                padding: '3px 9px',
                borderRadius: 999,
                background: accent ? 'var(--accent-dim)' : 'var(--bg-1)',
                color: accent ? t.accent : t.textSecondary,
                border: accent ? `1px solid ${t.accent}33` : '1px solid var(--border-subtle)',
                fontFamily: mono ? t.fontMono : undefined,
              }}
            >
              {value}
            </span>
          ))
        ) : (
          <span style={{ fontSize: 11.5, color: t.textMuted, fontStyle: 'italic' }}>{empty}</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, t, children }: { label: string; hint?: string; t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{label}</label>
      {hint ? (
        <div
          style={{
            fontSize: 11.5,
            color: t.textMuted,
            lineHeight: 1.45,
            marginTop: -2,
          }}
        >
          {hint}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function InlineNote({ t, tone, children }: { t: Theme; tone: 'error' | 'muted'; children: React.ReactNode }): JSX.Element {
  const color = tone === 'error' ? t.error : t.textMuted;
  return <div style={{ fontSize: 11.5, color, lineHeight: 1.45 }}>{children}</div>;
}

function skillChip(t: Theme): CSSProperties {
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

function activeBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 10.5,
    fontWeight: 700,
    color: t.success,
    background: `${t.success}14`,
    border: `1px solid ${t.success}38`,
    borderRadius: 999,
    padding: '2px 7px',
  };
}

function domainBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 10.5,
    fontWeight: 700,
    color: t.accent,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}38`,
    borderRadius: 999,
    padding: '2px 7px',
  };
}

// ── Styles ───────────────────────────────────────────────────────────────────

function primaryButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 13px',
    borderRadius: 7,
    border: `1px solid ${t.accent}`,
    background: t.accent,
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function ghostButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '7px 11px',
    borderRadius: 7,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function dangerButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 13px',
    borderRadius: 7,
    border: `1px solid ${t.error}`,
    background: t.error,
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function iconButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 7,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    cursor: 'pointer',
    flexShrink: 0,
  };
}

function inputStyle(t: Theme): CSSProperties {
  return {
    width: '100%',
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 7,
    background: t.cellBg,
    color: t.textPrimary,
    fontSize: 12.5,
    fontFamily: t.font,
    padding: '8px 10px',
    boxSizing: 'border-box',
  };
}

function textareaStyle(t: Theme): CSSProperties {
  return {
    ...inputStyle(t),
    resize: 'vertical',
    lineHeight: 1.5,
    padding: '9px 11px',
  };
}

function starterBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: t.warning,
    background: `${t.warning}16`,
    border: `1px solid ${t.warning}40`,
    borderRadius: 999,
    padding: '2px 8px',
  };
}

// Prototype chip-box primitives shared by ChipInput and MultiSelect.
function chipBox(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
    border: `1px solid ${t.btnBorder}`,
    background: t.cellBg,
    borderRadius: 7,
    padding: '6px 8px',
  };
}

function chipBoxInput(t: Theme): CSSProperties {
  return {
    flex: 1,
    minWidth: 110,
    border: 'none',
    background: 'none',
    outline: 'none',
    fontSize: 11.5,
    fontFamily: t.font,
    color: t.textPrimary,
    padding: 2,
  };
}

function accentPill(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    padding: '2.5px 8px',
    borderRadius: 999,
    background: 'var(--accent-dim)',
    color: t.accent,
    border: `1px solid ${t.accent}33`,
  };
}

function pillRemove(t: Theme): CSSProperties {
  return {
    border: 'none',
    background: 'none',
    color: t.accent,
    cursor: 'pointer',
    padding: 0,
    fontSize: 12,
    lineHeight: 1,
    fontFamily: t.font,
  };
}

const formLabelCol: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

function formLabelText(t: Theme): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 650,
    color: t.textSecondary,
  };
}

function suggestionChip(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: t.fontMono,
  };
}

// Prototype skill form: a centered modal (min(860px,94vw) × min(640px,90vh),
// radius 14, light scrim) instead of the old right-hand drawer.
const drawerScrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(26, 26, 26, 0.22)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
};

function drawerPanel(t: Theme): CSSProperties {
  return {
    width: 'min(860px, 94vw)',
    height: 'min(640px, 90vh)',
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 14,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 70px rgba(26,26,26,0.22)',
  };
}

function drawerHeader(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '14px 18px',
    borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0,
  };
}

function drawerFooter(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 18px',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-1)',
    flexShrink: 0,
  };
}

const modalScrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.42)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 70,
  padding: 20,
};

function modalCard(t: Theme): CSSProperties {
  return {
    width: 'min(420px, 100%)',
    background: t.cellBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 12,
    padding: 20,
    display: 'grid',
    gap: 13,
    boxShadow: '0 18px 48px rgba(0,0,0,0.3)',
  };
}
