// What Ask will do here: the skills, required filters, relationships and
// imports that apply to questions scoped to this domain (and subject area),
// read from the same sources Ask reads. Modeling shows the effect of what is
// authored instead of leaving people to guess it.

import React, { useEffect, useState } from 'react';
import { GraduationCap, Link2, Loader2, ShieldCheck, X } from 'lucide-react';
import { api, type AskImpactResponse } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';
import { RELATIONSHIP_LEVELS } from './relationship-builder-model';

type Theme = (typeof themes)['dark'];

// Section wording for a list of relationships at one level.
const LEVEL_TEXT: Record<AskImpactResponse['relationships'][number]['level'], { title: string; meaning: string }> = {
  certified: { title: 'Joins Ask must use', meaning: 'When Ask writes SQL that joins these models, it must use exactly these keys.' },
  validated: { title: 'Joins Ask prefers', meaning: 'Checked safe to join in the warehouse. Ask prefers these when it writes SQL.' },
  stale: { title: 'Certified joins that need a recheck', meaning: 'Their warehouse check is missing, stale or failed, so Ask treats them as hints until they are checked again.' },
  draft: { title: 'Joins Ask sees as hints', meaning: 'Not checked in the warehouse yet. Certify one to make Ask use its keys.' },
};

export function AskImpactDrawer({ domain, area, areaName, t, onClose }: { domain: string; area?: string | null; areaName?: string; t: Theme; onClose: () => void }) {
  const [impact, setImpact] = useState<AskImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setImpact(null);
    setError(null);
    void api.getAskImpact(domain, area).then((result) => { if (!cancelled) setImpact(result); }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [domain, area]);

  const domainSkills = impact?.skills.filter((skill) => skill.scope === 'domain') ?? [];
  const projectSkills = impact?.skills.filter((skill) => skill.scope === 'project') ?? [];
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.42)', display: 'flex', justifyContent: 'flex-end', zIndex: 120 }} onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label="What Ask will do" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} style={{ width: 'min(560px, 100%)', height: '100%', background: t.appBg, borderLeft: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <ShieldCheck size={16} color={t.accent} />
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 14 }}>What Ask will do</b>
            <div style={{ fontSize: 11, color: t.textMuted }}>For questions scoped to {domain}{areaName ? ` · ${areaName}` : ''}</div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.cellBg, color: t.textSecondary, width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={14} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px', display: 'grid', gap: 18, alignContent: 'start' }}>
          {error ? <div role="alert" style={{ color: t.error, fontSize: 12 }}>{error}</div> : null}
          {!impact && !error ? <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: t.textMuted, fontSize: 12 }}><Loader2 size={13} /> Reading what Ask reads…</div> : null}
          {impact ? (
            <>
              <Section title="Always applied" t={t}>
                {impact.requiredFilters.length
                  ? impact.requiredFilters.map((filter) => <Row key={`${filter.skill}:${filter.text}`} t={t} main={<code>{filter.text}</code>} detail={`required by skill ${filter.skill}; AI-written SQL without it is not run`} />)
                  : <Muted t={t}>No required filters. Add one to a skill when every answer here must filter the same way.</Muted>}
              </Section>

              <Section title="Skills that can guide answers" t={t}>
                {domainSkills.length ? domainSkills.map((skill) => <SkillRow key={skill.id} skill={skill} t={t} />) : <Muted t={t}>No skills belong to this domain yet.</Muted>}
                {projectSkills.length ? (
                  <>
                    <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 6 }}>Project-wide skills, used in every domain</div>
                    {projectSkills.map((skill) => <SkillRow key={skill.id} skill={skill} t={t} />)}
                  </>
                ) : null}
              </Section>

              {(['certified', 'validated', 'stale', 'draft'] as const).map((level) => {
                const rows = impact.relationships.filter((relationship) => relationship.level === level);
                if (!rows.length) return null;
                return (
                  <Section key={level} title={LEVEL_TEXT[level].title} detail={LEVEL_TEXT[level].meaning} t={t}>
                    {rows.map((relationship) => <Row key={relationship.name} t={t} icon={<Link2 size={12} />} main={`${relationship.from} → ${relationship.to}`} detail={`on ${relationship.keys} · ${relationship.name}`} />)}
                  </Section>
                );
              })}
              {impact.relationships.length === 0 ? <Section title="Joins" t={t}><Muted t={t}>No relationships on the map. Ask's SQL joins tables on its own, and nothing checks the keys.</Muted></Section> : null}

              {impact.imports.length ? (
                <Section title="Data shared by other domains" detail="Used only when the question's purpose matches the approved one." t={t}>
                  {impact.imports.map((item) => <Row key={item.id} t={t} main={item.exportRef} detail={`for ${item.purpose || 'no purpose'} · ${item.usable ? 'usable' : `not usable yet (${item.status})`}`} />)}
                </Section>
              ) : null}

              <Section title="Also read" t={t}>
                <Muted t={t}>{impact.terms} term{impact.terms === 1 ? '' : 's'} · {impact.concepts} concept{impact.concepts === 1 ? '' : 's'} · {impact.certifiedBlocks} certified {impact.certifiedBlocks === 1 ? 'saved query' : 'saved queries'}</Muted>
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function SkillRow({ skill, t }: { skill: AskImpactResponse['skills'][number]; t: Theme }) {
  const when = skill.triggers.length ? `when a question mentions ${skill.triggers.slice(0, 4).join(', ')}${skill.triggers.length > 4 ? '…' : ''}` : skill.vocabularyCount ? `when a question uses its ${skill.vocabularyCount} vocabulary word${skill.vocabularyCount === 1 ? '' : 's'}` : 'never: it has no trigger words or vocabulary';
  return (
    <Row
      t={t}
      icon={<GraduationCap size={12} />}
      main={<>{skill.id}{skill.status !== 'active' ? <span style={{ color: t.textMuted }}> · {skill.status}, not used</span> : null}</>}
      detail={[`Used ${when}`, ...skill.policy].join(' · ')}
      warn={!skill.findable || skill.status !== 'active'}
    />
  );
}

function Section({ title, detail, t, children }: { title: string; detail?: string; t: Theme; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ display: 'grid', gap: 6 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 750, color: t.textPrimary }}>{title}</div>
        {detail ? <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2 }}>{detail}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ main, detail, icon, warn, t }: { main: React.ReactNode; detail?: string; icon?: React.ReactNode; warn?: boolean; t: Theme }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: icon ? '16px minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 6, padding: '7px 9px', borderRadius: 8, border: `1px solid ${warn ? 'var(--status-warning)' : t.headerBorder}`, background: t.cellBg }}>
      {icon ? <span style={{ color: t.textMuted, marginTop: 2 }}>{icon}</span> : null}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: t.textPrimary, overflowWrap: 'anywhere' }}>{main}</div>
        {detail ? <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2, lineHeight: 1.4 }}>{detail}</div> : null}
      </div>
    </div>
  );
}

function Muted({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.45 }}>{children}</div>;
}
