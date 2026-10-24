import React, { useEffect, useState } from 'react';
import { Boxes, Database, FolderOpen, GitBranch, Layers, RefreshCw } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import type { WaitingWarehouseDrafts } from '../../api/client';
import { stagingLeftOutSentence, waitingDraftsSentence } from '../modeling/proposal-review-words';
import {
  databaseOnlyUnavailable,
  EXISTING_PROJECT_TITLE,
  existingRefreshLabel,
  MODEL_SOURCE_OPTIONS,
  type DraftOutcome,
  type ExistingProject,
  type ModelSource,
  type ProjectSyncStep,
} from './setup-model-source';

const ICONS: Record<ModelSource, React.ReactNode> = {
  dbt: <GitBranch size={16} aria-hidden="true" />,
  warehouse: <Database size={16} aria-hidden="true" />,
  both: <Layers size={16} aria-hidden="true" />,
  existing: <FolderOpen size={16} aria-hidden="true" />,
};

/**
 * "Where does your data model live?" — native radio buttons styled as cards,
 * so arrow keys, Tab and screen readers work as they do for any radio group.
 * Guided Setup step 1 and the Welcome screen use the same chooser.
 */
export function ModelSourceChooser({
  value,
  onChange,
  existing,
  dbtOnly = false,
  name = 'zlens-model-source',
  t,
}: {
  value: ModelSource | null;
  onChange: (source: ModelSource) => void;
  /** What this folder's dql.config.json already sets up, if anything. */
  existing: ExistingProject | null;
  /** An update that must reapply the dbt project first. */
  dbtOnly?: boolean;
  name?: string;
  t: Theme;
}) {
  const card = (id: ModelSource, title: string, body: React.ReactNode, disabled: boolean, note?: string | null) => {
    const selected = value === id;
    const inputId = `${name}-${id}`;
    return (
      <label
        key={id}
        htmlFor={inputId}
        data-model-source={id}
        style={{
          position: 'relative',
          display: 'flex',
          gap: 11,
          alignItems: 'flex-start',
          border: `1.5px solid ${selected ? t.accent : t.headerBorder}`,
          borderRadius: 12,
          background: selected ? 'var(--accent-dim)' : t.cellBg,
          padding: '13px 14px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          // A card that explains why it is unavailable keeps that note readable.
          opacity: disabled && !note ? 0.6 : 1,
          fontFamily: t.font,
          minWidth: 0,
        }}
      >
        <input
          id={inputId}
          type="radio"
          name={name}
          value={id}
          checked={selected}
          disabled={disabled}
          onChange={() => onChange(id)}
          aria-labelledby={`${inputId}-title`}
          aria-describedby={note ? `${inputId}-body ${inputId}-note` : `${inputId}-body`}
          style={{ marginTop: 3, accentColor: t.accent, flexShrink: 0 }}
        />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <span id={`${inputId}-title`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 750, color: t.textPrimary }}>
            <span style={{ color: selected ? t.accent : t.textSecondary, display: 'inline-flex' }}>{ICONS[id]}</span>
            {title}
          </span>
          <span id={`${inputId}-body`} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5, opacity: disabled && note ? 0.6 : 1 }}>{body}</span>
          {note ? <span id={`${inputId}-note`} data-model-source-note="" style={{ fontSize: 11.5, color: t.textPrimary, lineHeight: 1.5, borderTop: `1px solid ${t.headerBorder}`, paddingTop: 6 }}>{note}</span> : null}
        </span>
      </label>
    );
  };

  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <legend style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        Where does your data model live?
      </legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {MODEL_SOURCE_OPTIONS.map((option) => {
          const unavailable = option.id === 'warehouse' ? databaseOnlyUnavailable(existing) : null;
          return card(option.id, option.title, option.body, (dbtOnly && option.id !== 'dbt') || (Boolean(unavailable) && value !== 'warehouse'), unavailable);
        })}
      </div>
      {card(
        'existing',
        EXISTING_PROJECT_TITLE,
        existing
          ? <>This folder&apos;s <code style={{ fontFamily: t.fontMono }}>dql.config.json</code> already sets up the data model: <strong style={{ color: t.textPrimary }}>{existing.label}</strong>{existing.detail ? ` · ${existing.detail}` : ''}. Test the connection and continue — no modeling questions.</>
          : <>For a folder whose <code style={{ fontFamily: t.fontMono }}>dql.config.json</code> already sets up the data model, such as a teammate&apos;s repository: start ZLens in that folder (<code style={{ fontFamily: t.fontMono }}>zlens notebook path/to/project</code>). This folder has no data model yet.</>,
        dbtOnly || !existing,
      )}
    </fieldset>
  );
}

/** Database only and Both, after Apply and synchronize: draft entities and joins for review. */
export function DraftModelsCard({
  busy,
  canDraft,
  outcome,
  onDraft,
  waiting = null,
  includeStaging = false,
  onToggleStaging,
  onRename,
  t,
}: {
  busy: boolean;
  canDraft: boolean;
  outcome: DraftOutcome | null;
  onDraft: () => void;
  /** The drafts that wait for review on the server (kept until saved or discarded). */
  waiting?: WaitingWarehouseDrafts | null;
  /** Staging copies are drafted too. */
  includeStaging?: boolean;
  onToggleStaging?: (include: boolean) => void;
  /** Draft again into a Domain with this name. */
  onRename?: (name: string) => void;
  t: Theme;
}) {
  const [renaming, setRenaming] = useState(false);
  const domain = outcome?.domain ?? waiting?.domains[0];
  const [name, setName] = useState(domain ?? '');
  useEffect(() => { if (!renaming) setName(domain ?? ''); }, [domain, renaming]);
  const drafted = Boolean(outcome?.ok && outcome.proposalId) || Boolean(waiting);
  const hidden = outcome?.stagingHidden ?? [];
  const smallButton: React.CSSProperties = { height: 26, padding: '0 10px', borderRadius: 7, border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 11, fontWeight: 650, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: t.font };
  return (
    <section aria-label="Draft my models" style={{ maxWidth: 640, border: `1px solid ${drafted ? 'var(--status-success-border)' : t.headerBorder}`, borderRadius: 12, background: t.cellBg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Boxes size={16} aria-hidden="true" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>Draft my models</div>
          <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5, marginTop: 2 }}>
            ZLens drafts models and joins from the synchronized tables&apos; keys, names and view SQL and checks each join on the data. You review and certify them in Modeling.
          </div>
        </div>
        <button
          type="button"
          onClick={onDraft}
          disabled={busy || !canDraft}
          style={{ height: 32, padding: '0 13px', borderRadius: 8, border: 'none', background: t.accent, color: 'var(--accent-fg)', fontSize: 12, fontWeight: 700, cursor: busy || !canDraft ? 'not-allowed' : 'pointer', opacity: busy || !canDraft ? 0.55 : 1, fontFamily: t.font, flexShrink: 0 }}
        >
          {busy ? 'Drafting…' : 'Draft my models'}
        </button>
      </div>
      {!canDraft && !outcome && !waiting ? (
        <div style={{ fontSize: 10.5, color: t.textMuted }}>Choose schemas and Apply and synchronize first.</div>
      ) : null}
      {outcome ? (
        <div role={outcome.ok ? 'status' : 'alert'} style={{ fontSize: 11.5, lineHeight: 1.5, color: outcome.ok ? (outcome.proposalId ? 'var(--status-success)' : t.textSecondary) : 'var(--status-error)' }}>
          {outcome.message}
        </div>
      ) : null}
      {waiting ? (
        <div aria-label="Drafts waiting" style={{ fontSize: 11.5, lineHeight: 1.5, color: t.textSecondary }}>{waitingDraftsSentence(waiting)}</div>
      ) : outcome?.ok && outcome.proposalId ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: t.textSecondary }}>They are kept until you review or discard them in Modeling.</div>
      ) : null}
      {drafted && domain && onRename ? (
        <div aria-label="Domain name" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: t.textSecondary }}>
          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const next = name.trim();
                if (!next) return;
                setRenaming(false);
                if (next !== domain) onRename(next);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <label htmlFor="setup-domain-name">Domain name</label>
              <input id="setup-domain-name" value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} style={{ height: 26, borderRadius: 7, border: `1px solid ${t.headerBorder}`, background: t.appBg, color: t.textPrimary, padding: '0 8px', fontFamily: t.font, fontSize: 11.5 }} />
              <button type="submit" disabled={busy || !name.trim()} style={smallButton}>Save name</button>
              <button type="button" onClick={() => setRenaming(false)} style={smallButton}>Cancel</button>
            </form>
          ) : (
            <>
              <span>Your tables go in the Domain <strong style={{ color: t.textPrimary }}>{domain}</strong>, named after your database.</span>
              <button type="button" disabled={busy} onClick={() => setRenaming(true)} style={smallButton}>Rename</button>
            </>
          )}
        </div>
      ) : null}
      {onToggleStaging && (hidden.length || includeStaging) ? (
        <div aria-label="Staging tables" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: t.textSecondary }}>
          <span style={{ flex: 1, minWidth: 0 }}>{includeStaging ? 'Staging tables are drafted too.' : stagingLeftOutSentence(hidden)}</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: busy ? 'not-allowed' : 'pointer' }}>
            <input type="checkbox" checked={includeStaging} disabled={busy} onChange={(event) => onToggleStaging(event.target.checked)} />
            Show staging tables
          </label>
        </div>
      ) : null}
    </section>
  );
}

/** Open an existing ZLens project: refresh what its dql.config.json already names. */
export function ExistingProjectSyncCard({
  project,
  busy,
  steps,
  environment = [],
  onSync,
  t,
}: {
  project: ExistingProject;
  busy: boolean;
  steps: ProjectSyncStep[] | null;
  /** `${NAME}` values the connection reads, and whether each is set for this server. */
  environment?: Array<{ name: string; set: boolean }>;
  onSync: () => void;
  t: Theme;
}) {
  const parts = [project.mode !== 'warehouse-first' && project.dbtConfigured ? 'the dbt project' : null, project.warehouseModeling ? 'the saved warehouse schemas' : null].filter(Boolean);
  const action = existingRefreshLabel(project);
  return (
    <section aria-label={action} style={{ maxWidth: 640, border: `1px solid ${steps && steps.length > 0 && steps.every((step) => step.ok) ? 'var(--status-success-border)' : t.headerBorder}`, borderRadius: 12, background: t.cellBg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><RefreshCw size={16} aria-hidden="true" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>{action}</div>
          <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5, marginTop: 2 }}>
            {parts.length ? `Reads ${parts.join(' and ')} again.` : 'Reads this project’s sources again.'} Only needed when the project changed since you last ran zlens sync. Its models and certifications come from the repository.
          </div>
        </div>
        <button
          type="button"
          onClick={onSync}
          disabled={busy}
          style={{ height: 32, padding: '0 13px', borderRadius: 8, border: 'none', background: t.accent, color: 'var(--accent-fg)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.55 : 1, fontFamily: t.font, flexShrink: 0 }}
        >
          {busy ? 'Refreshing…' : action}
        </button>
      </div>
      {environment.length ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.55, color: t.textSecondary }}>
          <div style={{ fontWeight: 650, color: t.textPrimary }}>Environment variables this connection reads</div>
          <ul aria-label="Environment variables" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {environment.map((reference) => (
              <li key={reference.name}>
                <code style={{ fontFamily: t.fontMono }}>{reference.name}</code>
                {' · '}
                <span style={{ color: reference.set ? 'var(--status-success)' : 'var(--status-warning)' }}>{reference.set ? 'set' : 'not set'}</span>
              </li>
            ))}
          </ul>
          {environment.some((reference) => !reference.set)
            ? <div style={{ marginTop: 4 }}>Export the missing ones in the shell that starts <code style={{ fontFamily: t.fontMono }}>zlens notebook</code>, restart it, then test and refresh. Passwords can also be entered above; they stay in the private secrets file.</div>
            : null}
        </div>
      ) : null}
      {steps?.map((step) => (
        <div key={step.kind} role={step.ok ? 'status' : 'alert'} style={{ fontSize: 11.5, lineHeight: 1.5, color: step.ok ? 'var(--status-success)' : 'var(--status-error)' }}>
          {step.message}
        </div>
      ))}
    </section>
  );
}
