import React, { useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, ShieldCheck, UserRound } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import { CertifierVerdictBlock } from '../agent/AiBuildResult';
import { BlockStatusBadge } from './BlockStatusBadge';

/** One grounding-evidence item (mirrors DqlGenerationEvidence). */
export interface DraftEvidenceItem {
  name: string;
  kind?: string;
  reason?: string;
  description?: string;
  objectKey?: string;
}

export interface DraftReviewCardProps {
  t: Theme;
  name: string;
  status?: string;                 // draft (default) / generating / ready / blocked / …
  description?: string;
  dql?: string;                    // governed DQL source (shown first — DQL-first)
  sqlPreview?: string;             // compiled SQL the block runs
  grain?: string;
  outputs?: string[];
  dimensions?: string[];
  entities?: string[];
  examples?: string[];
  sourceTables?: string[];
  evidence?: DraftEvidenceItem[];  // "Context used" grounding
  certifierVerdict?: { blocking: string[]; warnings: string[]; ready: boolean };
  owner?: string | null;
  actions?: React.ReactNode;       // caller-supplied action buttons (Open / Save / Refine …)
}

/**
 * The single draft-review surface for a DQL block, shared by the governed AI panel,
 * the SQL-import candidate review, and the propose/readiness flows. Leads with a
 * DRAFT badge and the governed DQL, shows the grounding it was built from
 * (req #4), and surfaces the certifier verdict as "what's left" — never as the lead.
 */
export function DraftReviewCard(props: DraftReviewCardProps) {
  const {
    t, name, status = 'draft', description, dql, sqlPreview, grain,
    outputs = [], dimensions = [], entities = [], examples = [], sourceTables = [],
    evidence = [], certifierVerdict, owner, actions,
  } = props;
  const [dqlOpen, setDqlOpen] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);

  return (
    <section style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg, padding: 14, display: 'grid', gap: 10, fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Blocks size={14} strokeWidth={2} color={t.accent} />
        <div style={{ fontSize: 13, fontWeight: 850, color: t.textPrimary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <BlockStatusBadge status={status} t={t} />
        {grain ? <span style={pill(t)}>grain {grain}</span> : null}
      </div>

      {description ? <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>{description}</div> : null}

      {dql ? (
        <Disclosure open={dqlOpen} onToggle={() => setDqlOpen((v) => !v)} label="Governed DQL" t={t} lead>
          <pre style={code(t)}>{dql}</pre>
        </Disclosure>
      ) : null}
      {sqlPreview ? (
        <Disclosure open={sqlOpen} onToggle={() => setSqlOpen((v) => !v)} label={dql ? 'Compiled SQL preview' : 'SQL this saved query will run'} t={t}>
          <pre style={code(t)}>{sqlPreview}</pre>
        </Disclosure>
      ) : null}

      <ChipRow label="Outputs" items={outputs} t={t} />
      <ChipRow label="Dimensions" items={dimensions} t={t} />
      <ChipRow label="Entities" items={entities} t={t} />

      {examples.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <SectionLabel t={t}>Answers questions like</SectionLabel>
          <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 3 }}>
            {examples.slice(0, 3).map((ex) => <li key={ex} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45 }}>{ex}</li>)}
          </ul>
        </div>
      ) : null}

      {(sourceTables.length > 0 || evidence.length > 0) ? (
        <div style={{ display: 'grid', gap: 6, border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg, padding: 10 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 800, color: t.textSecondary, textTransform: 'uppercase' }}>
            <ShieldCheck size={12} color={t.accent} /> Grounded on
          </div>
          {sourceTables.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {sourceTables.map((tbl) => <span key={tbl} style={pill(t)}>{tbl}</span>)}
            </div>
          ) : null}
          {evidence.slice(0, 5).map((item, i) => (
            <div key={`${item.objectKey ?? item.name}-${i}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 7, padding: 8, background: t.cellBg }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary, overflowWrap: 'anywhere' }}>{item.name}</div>
              <div style={{ fontSize: 10, color: t.textMuted, marginTop: 3 }}>{item.kind}{item.reason ? ` · ${item.reason}` : ''}</div>
              {item.description ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, marginTop: 5 }}>{item.description}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <CertifierVerdictBlock t={t} verdict={certifierVerdict} />

      {owner ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted }}>
          <UserRound size={12} strokeWidth={2} /> drafting as {owner}
        </div>
      ) : null}

      {actions ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div> : null}
    </section>
  );
}

function Disclosure({ open, onToggle, label, t, lead, children }: { open: boolean; onToggle: () => void; label: string; t: Theme; lead?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent',
          cursor: 'pointer', color: lead ? t.accent : t.textSecondary, fontSize: 11.5, fontWeight: lead ? 800 : 700, fontFamily: t.font, padding: 0,
        }}
      >
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        {open ? `Hide ${label.toLowerCase()}` : label}
      </button>
      {open ? <div style={{ marginTop: 7 }}>{children}</div> : null}
    </div>
  );
}

function ChipRow({ label, items, t }: { label: string; items: string[]; t: Theme }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <SectionLabel t={t}>{label}</SectionLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {items.map((item) => <span key={item} style={pill(t)}>{item}</span>)}
      </div>
    </div>
  );
}

function SectionLabel({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>{children}</div>;
}

function pill(t: Theme): React.CSSProperties {
  return { fontSize: 10.5, fontWeight: 700, color: t.textSecondary, background: t.pillBg, borderRadius: 999, padding: '2px 8px', fontFamily: t.fontMono };
}

function code(t: Theme): React.CSSProperties {
  return {
    margin: 0, fontFamily: t.fontMono, fontSize: 11.5, whiteSpace: 'pre-wrap', color: t.textSecondary,
    background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 7, padding: 10, maxHeight: 240, overflow: 'auto',
  };
}
