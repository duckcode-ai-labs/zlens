import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZLensMark } from '../shell/ZLensMark';
import type { Theme } from '../../themes/notebook-theme';
import {
  api,
  type DbtOnboardingJob,
  type DbtOnboardingPreviewResponse,
  type DbtOnboardingStatusResponse,
  type DomainDiscoveryApplyResponse,
  type DomainDiscoveryProposal,
  type DomainDiscoveryResponse,
  type OnboardingCapabilities,
} from '../../api/client';
import {
  normalizeOnboardingJob,
  onboardingErrorView,
  resolveDbtResumeStage,
  type DbtOnboardingStage,
} from './setup-wizard-model';
import { ModelSourceChooser } from './ModelSourceChooser';
import { existingProjectFromStatus, type ModelSource } from './setup-model-source';

type StartTarget = 'modeling' | 'skills' | 'ask' | 'block';

interface DbtOnboardingFlowProps {
  t: Theme;
  initialProjectDir?: string;
  onBack: () => void;
  onClose: () => void;
  onComplete: () => void;
  onOpen: (target: StartTarget) => void;
  /**
   * The Welcome screen's "Where does your data model live?" answered with
   * something other than dbt: Guided Setup continues with that choice.
   */
  onChooseModelSource?: (source: Exclude<ModelSource, 'dbt'>) => void;
}

const STAGES: Array<{ id: DbtOnboardingStage; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'inspect', label: 'Artifacts' },
  { id: 'domains', label: 'Domains' },
  { id: 'domain-model', label: 'Model' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'ready', label: 'Start' },
];

function progressIndex(stage: DbtOnboardingStage): number {
  if (stage === 'building') return 1;
  return Math.max(0, STAGES.findIndex((item) => item.id === stage));
}

function confidenceLabel(value: DomainDiscoveryProposal['confidence']): string {
  return typeof value === 'number' ? `${Math.round(value * (value <= 1 ? 100 : 1))}%` : value;
}

function artifactLabel(path: string | null | undefined): string {
  return path ? path : 'Optional · not available';
}

function proposalIsSafeDefault(proposal: DomainDiscoveryProposal): boolean {
  const highConfidence = proposal.confidence === 'high'
    || (typeof proposal.confidence === 'number' && proposal.confidence >= 0.8);
  return highConfidence && !proposal.requiresHumanDecision && (proposal.conflicts?.length ?? 0) === 0;
}

function optionalCapabilityMessages(capabilities?: OnboardingCapabilities): string[] {
  const messages: string[] = [];
  const ai = capabilities?.ai;
  const warehouse = capabilities?.warehouse;
  if (ai === false || (typeof ai === 'object' && !ai.available)) {
    messages.push(typeof ai === 'object' && ai.message ? ai.message : 'AI assistance is unavailable; deterministic discovery remains available.');
  }
  if (warehouse === false || (typeof warehouse === 'object' && !warehouse.available)) {
    messages.push(typeof warehouse === 'object' && warehouse.message ? warehouse.message : 'Warehouse validation can be connected later; certification remains incomplete until then.');
  }
  return messages;
}

export function DbtOnboardingFlow({
  t,
  initialProjectDir = '',
  onBack,
  onClose,
  onComplete,
  onOpen,
  onChooseModelSource,
}: DbtOnboardingFlowProps) {
  const [stage, setStage] = useState<DbtOnboardingStage>('connect');
  const [status, setStatus] = useState<DbtOnboardingStatusResponse | null>(null);
  const [projectDir, setProjectDir] = useState(initialProjectDir || '.');
  const [manifestPath, setManifestPath] = useState('target/manifest.json');
  const [profilesDir, setProfilesDir] = useState('');
  const [sourceMode, setSourceMode] = useState<'local' | 'repo'>('local');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [subPath, setSubPath] = useState('');
  const [preview, setPreview] = useState<DbtOnboardingPreviewResponse | null>(null);
  const [job, setJob] = useState<DbtOnboardingJob | null>(null);
  const [discovery, setDiscovery] = useState<DomainDiscoveryResponse | null>(null);
  const [domainApply, setDomainApply] = useState<DomainDiscoveryApplyResponse | null>(null);
  const [selectedProposals, setSelectedProposals] = useState<Set<string>>(new Set());
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [setupSkipped, setSetupSkipped] = useState(false);
  // Prototype story welcome: shown before the dbt steps for first-time setup;
  // resumed sessions (any stage beyond connect) skip straight to their step.
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeSource, setWelcomeSource] = useState<ModelSource>('dbt');
  useEffect(() => {
    if (stage !== 'connect') setShowWelcome(false);
  }, [stage]);
  const mounted = useRef(true);

  const inputStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 7,
    color: t.textPrimary,
    fontSize: 13,
    fontFamily: t.font,
    padding: '9px 11px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const capabilities = discovery?.capabilities ?? preview?.capabilities ?? status?.capabilities;
  const capabilityMessages = optionalCapabilityMessages(capabilities);
  const errorView = error ? onboardingErrorView(error, projectDir, manifestPath) : null;
  const activeIndex = progressIndex(stage);

  useEffect(() => {
    mounted.current = true;
    void api.getOnboardingStatus()
      .then((result) => {
        if (!mounted.current) return;
        setStatus(result);
        if (result.dbt?.projectDir) setProjectDir(result.dbt.projectDir);
        if (result.dbt?.manifestPath) setManifestPath(result.dbt.manifestPath);
        if (result.dbt?.profilesDir) setProfilesDir(result.dbt.profilesDir);
        if (result.dbt?.repoUrl) {
          setSourceMode('repo');
          setRepoUrl(result.dbt.repoUrl);
          setBranch(result.dbt.branch ?? '');
          setSubPath(result.dbt.subPath ?? '');
        }
        setStage(resolveDbtResumeStage(result));
      })
      .catch(() => {
        // A missing status endpoint does not block the deterministic connect path.
      })
      .finally(() => { if (mounted.current) setStatusLoading(false); });
    return () => { mounted.current = false; };
  }, []);

  const inspect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewDbtOnboarding(sourceMode === 'repo'
        ? { repoUrl, branch: branch || undefined, subPath: subPath || undefined, manifestPath, profilesDir: profilesDir || undefined }
        : { projectDir: projectDir || '.', manifestPath, profilesDir: profilesDir || undefined });
      if (!mounted.current) return;
      setPreview(result);
      setProjectDir(result.projectDir || projectDir || '.');
      setManifestPath(result.manifestPath || manifestPath);
      setProfilesDir(result.profilesDir || profilesDir);
      if (result.repoUrl) {
        setSourceMode('repo');
        setRepoUrl(result.repoUrl);
        setBranch(result.branch ?? '');
        setSubPath(result.subPath ?? '');
      }
      setStage('inspect');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [branch, manifestPath, profilesDir, projectDir, repoUrl, sourceMode, subPath]);

  const discoverDomains = useCallback(async (preferAi = useAi) => {
    setLoading(true);
    setError(null);
    try {
      let result: DomainDiscoveryResponse;
      try {
        result = await api.discoverOnboardingDomains({
          snapshotId: status?.snapshotId,
          useAi: preferAi,
        });
      } catch (nextError) {
        const code = (nextError as { code?: string })?.code;
        if (preferAi && code === 'AI_PROVIDER_UNAVAILABLE') {
          setUseAi(false);
          result = await api.discoverOnboardingDomains({ snapshotId: status?.snapshotId, useAi: false });
        } else {
          throw nextError;
        }
      }
      if (!mounted.current) return;
      const proposals = (result.proposals ?? []).map((proposal) => ({ ...proposal, lifecycle: 'draft' as const }));
      const normalized = { ...result, proposals };
      setDiscovery(normalized);
      setSelectedProposals(new Set(proposals.filter(proposalIsSafeDefault).map((proposal) => proposal.id)));
      setStage('domains');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [status?.snapshotId, useAi]);

  const pollJob = useCallback(async (jobId: string) => {
    for (;;) {
      const response = await api.getOnboardingJob(jobId);
      const nextJob = normalizeOnboardingJob(response);
      if (!mounted.current) return;
      setJob(nextJob);
      if (nextJob.status === 'completed') {
        await discoverDomains(useAi);
        return;
      }
      if (nextJob.status === 'failed' || nextJob.status === 'cancelled') {
        throw new Error(nextJob.error || nextJob.message || `Onboarding ${nextJob.status}.`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }, [discoverDomains, useAi]);

  const buildSnapshot = useCallback(async (buildArtifacts: boolean) => {
    setLoading(true);
    setError(null);
    setStage('building');
    try {
      const applied = await api.applyDbtOnboarding({
        ...(sourceMode === 'repo'
          ? { repoUrl, branch: branch || undefined, subPath: subPath || undefined }
          : { projectDir: projectDir || '.' }),
        manifestPath,
        profilesDir: profilesDir || undefined,
        expectedFingerprint: preview?.fingerprint,
        buildArtifacts,
      });
      const appliedJobId = applied.jobId ?? applied.id;
      const refreshed = appliedJobId ? null : await api.refreshDbtOnboarding({
        expectedFingerprint: applied.fingerprint ?? preview?.fingerprint,
        buildArtifacts,
      });
      const jobId = appliedJobId ?? refreshed?.jobId ?? refreshed?.id;
      if (jobId) {
        setJob({ id: jobId, status: ((applied.status ?? refreshed?.status) as DbtOnboardingJob['status']) ?? 'queued' });
        await pollJob(jobId);
      } else {
        await discoverDomains(useAi);
      }
    } catch (nextError) {
      if (mounted.current) {
        setError(nextError);
        setStage(preview ? 'inspect' : 'connect');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [branch, discoverDomains, manifestPath, pollJob, preview, profilesDir, projectDir, repoUrl, sourceMode, subPath, useAi]);

  useEffect(() => {
    if (stage === 'domains' && !discovery && !loading && !statusLoading && !error) void discoverDomains(useAi);
  }, [discoverDomains, discovery, error, loading, stage, statusLoading, useAi]);

  const saveDomains = useCallback(async (mode: 'preview' | 'apply') => {
    if (!discovery) return;
    const selected = discovery.proposals
      .filter((proposal) => selectedProposals.has(proposal.id))
      .map((proposal) => ({ ...proposal, lifecycle: 'draft' as const }));
    if (selected.length === 0) {
      setSetupSkipped(true);
      setStage('domain-model');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.applyOnboardingDomains({
        proposals: selected,
        expectedSourceFingerprint: discovery.sourceFingerprint,
        mode,
      });
      if (!mounted.current) return;
      setDomainApply(result);
      if (mode === 'apply' || result.applied) setStage('domain-model');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [discovery, selectedProposals]);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    try {
      await api.cancelOnboardingJob(job.id);
    } finally {
      setJob((current) => current ? { ...current, status: 'cancelled' } : current);
      setStage('inspect');
      setLoading(false);
    }
  }, [job]);

  const selectedCount = selectedProposals.size;
  const appliedNames = useMemo(
    () => domainApply?.domains?.map((domain) => domain.id) ?? discovery?.proposals.filter((proposal) => selectedProposals.has(proposal.id)).map((proposal) => proposal.name) ?? [],
    [discovery, domainApply, selectedProposals],
  );

  const completeAndOpen = (target: StartTarget) => {
    onComplete();
    onOpen(target);
  };

  // Prototype (Setup Onboarding Redesign): full-screen wizard with a 52px
  // header, clickable pill stepper, and a story welcome before the dbt steps.
  return (
    <div style={{
      background: t.appBg,
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }} role="dialog" aria-modal="true" aria-labelledby="dbt-onboarding-title">
      <style>{`
        @keyframes dql-setup-fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes dql-setup-stage { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }
        @keyframes dql-setup-arrow { 0%, 100% { opacity: 0.35; transform: translateX(0); } 50% { opacity: 1; transform: translateX(3px); } }
        @keyframes dql-setup-flowrail { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
        @keyframes dql-setup-gitdash { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
        @keyframes dql-setup-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
      `}</style>
      <div style={{ height: 52, flexShrink: 0, background: t.cellBg, borderBottom: `1px solid ${t.cellBorder}`, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 10, userSelect: 'none' }}>
        <span style={{ display: 'inline-flex', color: t.textPrimary, flexShrink: 0 }}><ZLensMark size={26} /></span>
        <h2 id="dbt-onboarding-title" style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: t.textPrimary, fontFamily: t.font, whiteSpace: 'nowrap' }}>Set up your workspace</h2>
        <div style={{ flex: 1 }} />
        <div aria-label="dbt onboarding progress" style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${showWelcome ? t.accent : 'var(--status-success-border)'}`, background: showWelcome ? 'var(--accent-dim)' : 'var(--status-success-bg)', fontFamily: t.font, whiteSpace: 'nowrap' }}>
            <span style={{ width: 16, height: 16, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, background: showWelcome ? t.accent : 'var(--status-success)', color: '#fff' }}>{showWelcome ? '0' : '✓'}</span>
            <span style={{ fontSize: 11, fontWeight: 650, color: showWelcome ? t.accent : 'var(--status-success)' }}>Welcome</span>
          </span>
          {STAGES.map((item, index) => {
            const done = !showWelcome && index < activeIndex;
            const active = !showWelcome && index === activeIndex;
            return (
              <span key={item.id} aria-current={active ? 'step' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${active ? t.accent : done ? 'var(--status-success-border)' : t.cellBorder}`, background: active ? 'var(--accent-dim)' : done ? 'var(--status-success-bg)' : 'transparent', fontFamily: t.font, whiteSpace: 'nowrap' }}>
                <span style={{ width: 16, height: 16, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, background: active ? t.accent : done ? 'var(--status-success)' : t.cellBorder, color: active || done ? '#fff' : t.textMuted }}>{done ? '✓' : index + 1}</span>
                <span style={{ fontSize: 11, fontWeight: 650, color: active ? t.accent : done ? 'var(--status-success)' : t.textMuted }}>{item.label}</span>
              </span>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button aria-label="Close setup" onClick={onClose} style={{ height: 28, padding: '0 11px', borderRadius: 7, border: 'none', background: 'none', color: t.textMuted, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap' }}>Skip for now</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ width: 'min(860px, 100% - 48px)', margin: '0 auto', padding: '26px 0 60px' }}>
        {showWelcome ? (
          <WelcomeStory
            t={t}
            chooser={onChooseModelSource ? (
              <ModelSourceChooser
                name="welcome-model-source"
                value={welcomeSource}
                onChange={setWelcomeSource}
                existing={existingProjectFromStatus(status)}
                t={t}
              />
            ) : null}
          />
        ) : (
        <>
        {stage !== 'connect' && stage !== 'inspect' && stage !== 'building' ? null : null}
        {statusLoading && <Notice t={t} title="Checking existing setup…" body="You can resume from the first incomplete step." />}

        {stage === 'connect' && !statusLoading && (
          <Section title="1. Connect the dbt project" description="Point ZLens at the existing dbt project and artifact. ZLens reads these files in place; it does not create a second semantic copy." t={t}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setSourceMode('local')} style={sourceMode === 'local' ? primaryButton(t) : secondaryButton(t)}>Local path</button>
              <button type="button" onClick={() => setSourceMode('repo')} style={sourceMode === 'repo' ? primaryButton(t) : secondaryButton(t)}>Git repository</button>
            </div>
            {sourceMode === 'local' ? (
              <Field label="dbt project directory" hint="Folder containing dbt_project.yml" t={t}>
                <input aria-label="dbt project directory" value={projectDir} onChange={(event) => setProjectDir(event.target.value)} placeholder="." style={inputStyle} />
              </Field>
            ) : (
              <>
                <Field label="Repository URL" hint="HTTPS, SSH, or file URL for a dbt Git repository" t={t}>
                  <input aria-label="dbt repository URL" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/dbt-project.git" style={inputStyle} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label="Branch" hint="Defaults to main" t={t}><input aria-label="dbt repository branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" style={inputStyle} /></Field>
                  <Field label="Sub-path" hint="Optional dbt project folder" t={t}><input aria-label="dbt repository sub-path" value={subPath} onChange={(event) => setSubPath(event.target.value)} placeholder="analytics/dbt" style={inputStyle} /></Field>
                </div>
              </>
            )}
            <Field label="Manifest path" hint="Relative to the dbt project directory" t={t}>
              <input aria-label="dbt manifest path" value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} placeholder="target/manifest.json" style={inputStyle} />
            </Field>
            <Field label="dbt profiles directory" hint="Optional; auto-detected from the dbt project, ZLens project, DBT_PROFILES_DIR, or ~/.dbt" t={t}>
              <input aria-label="dbt profiles directory" value={profilesDir} onChange={(event) => setProfilesDir(event.target.value)} placeholder="Auto-detect" style={inputStyle} />
            </Field>
            <OwnershipCallout t={t} />
          </Section>
        )}

        {stage === 'inspect' && preview && (
          <Section title="2. Review dbt artifacts" description="ZLens will enable Manifest v3 and dbt-first modeling, then build an immutable snapshot from these sources." t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {Object.entries(preview.counts).map(([label, value]) => <CountCard key={label} label={label} value={value} t={t} />)}
            </div>
            <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 8, overflow: 'hidden' }}>
              <ArtifactRow label="manifest.json" value={artifactLabel(preview.artifacts.manifest)} required t={t} />
              <ArtifactRow label="catalog.json" value={artifactLabel(preview.artifacts.catalog)} t={t} />
              <ArtifactRow label="semantic_manifest.json" value={artifactLabel(preview.artifacts.semanticManifest)} t={t} />
              <ArtifactRow label="profiles directory" value={preview.profilesDir || 'Optional · not detected'} t={t} />
            </div>
            <Notice t={t} title="What changes" body="ZLens writes project configuration and a rebuildable snapshot. dbt SQL/YAML and MetricFlow formulas remain the source of truth and are never copied into domain folders." />
            {preview.warnings?.map((warning) => <Notice key={warning} t={t} title="Repository note" body={warning} />)}
          </Section>
        )}

        {stage === 'building' && (
          <Section title="Building the dbt-first snapshot" description="Artifact generation, validation, compile, and indexing are handled as one resumable job. The previous active snapshot remains usable until this completes." t={t}>
            <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: t.textPrimary, font: `600 13px ${t.font}` }}>
                <span>{job?.stage ?? 'Preparing project'}</span><span>{typeof job?.progress === 'number' ? `${job.progress}%` : job?.status ?? 'running'}</span>
              </div>
              <div style={{ height: 7, borderRadius: 8, background: t.cellBorder, marginTop: 12, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, job?.progress ?? 15)}%`, height: '100%', background: t.accent, transition: 'width .2s' }} />
              </div>
              {job?.message && <div style={{ marginTop: 10, color: t.textSecondary, font: `12px/1.5 ${t.font}` }}>{job.message}</div>}
            </div>
          </Section>
        )}

        {stage === 'domains' && (
          <Section title="3. Review discovered domains" description="Proposals use dbt groups, tags, paths, owners, exposures, packages, and MetricFlow evidence. Nothing is certified automatically." t={t}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, color: t.textSecondary, font: `12px/1.45 ${t.font}` }}>
              <input type="checkbox" checked={useAi} onChange={(event) => { setUseAi(event.target.checked); setDiscovery(null); setError(null); }} />
              <span><strong style={{ color: t.textPrimary }}>Use AI to summarize repository evidence</strong><br />Optional and review-only. AI cannot invent membership or set certified lifecycle.</span>
            </label>
            {discovery?.warnings?.map((warning) => <Notice key={warning} t={t} title="Discovery note" body={warning} />)}
            {discovery && discovery.proposals.length === 0 && (
              <Notice t={t} title="No confident domains found" body="Continue to create domains on the Modeling page. Ask remains available in limited-context, review-required mode." />
            )}
            {discovery?.proposals.map((proposal) => {
              const selected = selectedProposals.has(proposal.id);
              return (
                <label key={proposal.id} style={{ display: 'block', border: `1px solid ${selected ? t.accent : t.cellBorder}`, background: selected ? `${t.accent}0d` : t.inputBg, borderRadius: 9, padding: 13, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={selected} onChange={() => {
                      setDomainApply(null);
                      setSelectedProposals((current) => {
                        const next = new Set(current);
                        if (next.has(proposal.id)) next.delete(proposal.id); else next.add(proposal.id);
                        return next;
                      });
                    }} aria-label={`Select ${proposal.name}`} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                        <strong style={{ color: t.textPrimary, font: `600 13px ${t.font}` }}>{proposal.name}</strong>
                        <Pill text={`${confidenceLabel(proposal.confidence)} confidence`} t={t} />
                        <Pill text="Draft only" t={t} tone="warning" />
                        {proposal.requiresHumanDecision && <Pill text="Decision required" t={t} tone="warning" />}
                      </div>
                      {proposal.description && <p style={{ margin: '6px 0 0', color: t.textSecondary, font: `12px/1.45 ${t.font}` }}>{proposal.description}</p>}
                      <div style={{ marginTop: 8, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>
                        Evidence: {proposal.evidence.length > 0 ? proposal.evidence.slice(0, 4).map((item) => `${item.kind}: ${item.value}`).join(' · ') : 'No evidence supplied — manual review required'}
                      </div>
                      {(proposal.conflicts?.length ?? 0) > 0 && <div style={{ marginTop: 6, color: t.warning, font: `11px/1.45 ${t.font}` }}>Conflicts: {proposal.conflicts?.join(' · ')}</div>}
                    </div>
                  </div>
                </label>
              );
            })}
            {(domainApply?.preview?.length ?? 0) > 0 && (
              <div style={{ border: `1px solid ${t.accent}55`, background: `${t.accent}09`, borderRadius: 9, padding: 12 }}>
                <div style={{ color: t.textPrimary, font: `600 12px ${t.font}` }}>Review domain source changes</div>
                <div style={{ marginTop: 4, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>Only sparse DQL domain declarations and bindings will be written. Confirm after reviewing these target files.</div>
                <div style={{ display: 'grid', gap: 6, marginTop: 9 }}>
                  {domainApply?.preview?.map((change) => <div key={`${change.operation}:${change.path}`} style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: 8, color: t.textSecondary, font: `11px ${t.font}` }}><strong>{change.operation}</strong><code style={{ color: t.textPrimary }}>{change.path}</code>{change.summary && <span style={{ gridColumn: '2', color: t.textMuted }}>{change.summary}</span>}</div>)}
                </div>
              </div>
            )}
          </Section>
        )}

        {stage === 'domain-model' && (
          <Section title="4. Build the model" description="The unified canvas adds analytical meaning over dbt provenance. Start small: bind high-value entities and prove only the joins agents may use." t={t}>
            {appliedNames.length > 0 && <Notice t={t} title={`${appliedNames.length} draft domain${appliedNames.length === 1 ? '' : 's'} created`} body={appliedNames.join(' · ')} />}
            {setupSkipped && <Notice t={t} title="Domain setup skipped" body="You can continue, but Ask is limited-context and all generated output requires review until governed paths exist." />}
            <Checklist t={t} items={[
              ['Bind business entities', 'Reference dbt unique IDs; do not duplicate columns or descriptions.'],
              ['Declare analytical grain', 'Add grain only where dbt metadata is insufficient.'],
              ['Prove relationships', 'Cardinality, fanout, key mapping, evidence, and lifecycle control agent joins.'],
              ['Export cross-domain paths', 'Provider exports and consumer imports are required in addition to relationship proof.'],
            ]} />
            <button onClick={() => completeAndOpen('modeling')} style={secondaryButton(t)}>Open Modeling now</button>
          </Section>
        )}

        {stage === 'knowledge' && (
          <Section title="5. Add domain knowledge" description="Skills and terms teach agents vocabulary, policies, examples, exclusions, and when to ask for clarification." t={t}>
            <Checklist t={t} items={[
              ['Terms', 'Define business vocabulary and map synonyms to domain-qualified concepts.'],
              ['Domain skills', 'Add policies, examples, exclusions, and required clarifications for this domain.'],
              ['Evaluations', 'Test retrieval, metric selection, safe joins, refusal, and clarification behavior.'],
              ['Review lifecycle', 'AI may draft from repository evidence, but a person reviews and certifies.'],
            ]} />
            <button onClick={() => completeAndOpen('skills')} style={secondaryButton(t)}>Open Skills now</button>
          </Section>
        )}

        {stage === 'ready' && (
          <Section title="Your dbt-first workspace is ready to continue" description="Choose the next task. Setup is resumable, and trust improves as relationships, skills, evaluations, and certified assets are completed." t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <StartCard title="Ask AI" body={setupSkipped ? 'Limited-context and review-required until domains are governed.' : 'Use the governed cascade; unsafe paths clarify or refuse.'} action="Open Ask" onClick={() => completeAndOpen('ask')} t={t} />
              <StartCard title="Save a query" body="Turn reviewed analysis into a reusable saved query for this domain and evaluate it." action="New saved query" onClick={() => completeAndOpen('block')} t={t} />
              <StartCard title="Modeling" body="Continue models, relationships, terms, and skills." action="Open Modeling" onClick={() => completeAndOpen('modeling')} t={t} />
            </div>
          </Section>
        )}

        {capabilityMessages.map((message) => <Notice key={message} t={t} title="Optional capability" body={message} />)}
        {errorView && (
          <div role="alert" style={{ border: `1px solid ${errorView.optional ? t.warning : t.error}`, background: errorView.optional ? `${t.warning}0d` : `${t.error}0d`, borderRadius: 9, padding: 13, marginTop: 14 }}>
            <div style={{ color: errorView.optional ? t.warning : t.error, font: `600 13px ${t.font}` }}>{errorView.title}</div>
            <div style={{ color: t.textSecondary, font: `12px/1.5 ${t.font}`, marginTop: 5 }}>{errorView.message}</div>
            {errorView.command && <code style={{ display: 'block', marginTop: 9, padding: '8px 10px', borderRadius: 6, background: t.inputBg, color: t.textPrimary, fontSize: 11, overflowX: 'auto' }}>{errorView.command}</code>}
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{errorView.nextActions.map((action) => <li key={action}>{action}</li>)}</ul>
          </div>
        )}
        </>
        )}
      </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '13px 22px', borderTop: `1px solid ${t.cellBorder}`, background: t.cellBg, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {showWelcome && <button onClick={onBack} style={secondaryButton(t)}>Back</button>}
          {!showWelcome && stage === 'connect' && <button onClick={() => setShowWelcome(true)} style={secondaryButton(t)}>Back</button>}
          {!showWelcome && stage !== 'building' && stage !== 'connect' && <button onClick={onClose} style={secondaryButton(t)}>Save & close</button>}
          {!showWelcome && stage === 'building' && job && <button onClick={() => void cancelJob()} style={secondaryButton(t)}>Cancel job</button>}
        </div>
        <span style={{ flex: 1, textAlign: 'center', fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {showWelcome ? '~2 minute read — or skip straight to setup' : 'Setup is resumable — you can save and come back any time.'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {showWelcome && (welcomeSource === 'dbt' || !onChooseModelSource
            ? <button onClick={() => setShowWelcome(false)} style={primaryButton(t)}>Next — connect your dbt project</button>
            : <button onClick={() => onChooseModelSource(welcomeSource)} style={primaryButton(t)}>{welcomeSource === 'warehouse' ? 'Next — connect your database' : welcomeSource === 'both' ? 'Next — connect dbt and your database' : 'Next — open this project'}</button>)}
          {!showWelcome && stage === 'connect' && errorView?.code === 'DBT_MANIFEST_MISSING' && <button disabled={loading} onClick={() => void buildSnapshot(true)} style={secondaryButton(t)}>Build artifacts with DQL</button>}
          {!showWelcome && stage === 'connect' && <button disabled={loading || (sourceMode === 'repo' ? !repoUrl.trim() : !projectDir.trim())} onClick={() => void inspect()} style={primaryButton(t, loading || (sourceMode === 'repo' ? !repoUrl.trim() : !projectDir.trim()))}>{loading ? 'Inspecting…' : errorView?.code === 'DBT_MANIFEST_MISSING' ? 'I ran dbt parse — retry' : 'Inspect artifacts'}</button>}
          {!showWelcome && stage === 'inspect' && <button disabled={loading} onClick={() => void buildSnapshot(false)} style={primaryButton(t, loading)}>{loading ? 'Building…' : 'Apply & build snapshot'}</button>}
          {!showWelcome && stage === 'domains' && !discovery && <button disabled={loading} onClick={() => { setError(null); void discoverDomains(useAi); }} style={primaryButton(t, loading)}>{loading ? 'Discovering…' : 'Retry discovery'}</button>}
          {!showWelcome && stage === 'domains' && discovery && (domainApply?.preview?.length ?? 0) === 0 && <button disabled={loading} onClick={() => void saveDomains('preview')} style={primaryButton(t, loading)}>{loading ? 'Preparing preview…' : selectedCount > 0 ? `Review ${selectedCount} draft domain${selectedCount === 1 ? '' : 's'}` : 'Continue without domains'}</button>}
          {!showWelcome && stage === 'domains' && discovery && (domainApply?.preview?.length ?? 0) > 0 && <button disabled={loading} onClick={() => void saveDomains('apply')} style={primaryButton(t, loading)}>{loading ? 'Applying…' : 'Apply reviewed drafts'}</button>}
          {!showWelcome && stage === 'domain-model' && <button onClick={() => setStage('knowledge')} style={primaryButton(t)}>Continue to knowledge</button>}
          {!showWelcome && stage === 'knowledge' && <button onClick={() => setStage('ready')} style={primaryButton(t)}>Continue</button>}
          {!showWelcome && stage === 'ready' && <button onClick={onClose} style={{ ...primaryButton(t), background: 'var(--status-success)', borderColor: 'var(--status-success)' }}>Finish setup</button>}
        </div>
      </div>
    </div>
  );
}

// ── Prototype story welcome (step 0) ────────────────────────────────────────
// Hero + three chapters with the handoff's animations: floating answer card,
// staggered pipeline stages, pulsing arrows, animated lineage + git rails.
function WelcomeStory({ t, chooser }: { t: Theme; chooser?: React.ReactNode }) {
  const stageCard = (delay: number, opts: { border: string; bg: string; iconBg: string; iconColor: string; title: string; body: string; glow?: boolean }, icon: React.ReactNode) => (
    <div style={{ border: `1.5px solid ${opts.border}`, borderRadius: 10, background: opts.bg, padding: '11px 10px', textAlign: 'center', animation: 'dql-setup-stage 0.5s ease-out both', animationDelay: `${delay}s`, boxShadow: opts.glow ? '0 4px 18px rgba(107,93,211,0.12)' : 'none' }}>
      <div style={{ width: 26, height: 26, borderRadius: 7, background: opts.iconBg, color: opts.iconColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, marginTop: 6 }}>{opts.title}</div>
      <div style={{ fontSize: 10, color: t.textMuted, lineHeight: 1.45, marginTop: 3 }}>{opts.body}</div>
    </div>
  );
  const arrow = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.accent }}>
      <svg style={{ animation: 'dql-setup-arrow 1.6s ease-in-out infinite' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
    </div>
  );
  const loopPill = (label: string, dot: string, opts?: { border?: string; bg?: string; color?: string }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${opts?.border ?? t.cellBorder}`, background: opts?.bg ?? t.cellBg, borderRadius: 999, padding: '4px 12px', fontSize: 11.5, fontWeight: 650, color: opts?.color ?? t.textSecondary }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: dot }} />{label}
    </span>
  );
  const loopArrow = <svg style={{ color: 'var(--border-strong)' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>;
  const connector = (text: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '14px 0 10px' }}>
      <span style={{ width: 1.5, height: 26, background: 'linear-gradient(to bottom, transparent, var(--border-strong))' }} />
      <span style={{ fontSize: 11.5, color: t.textMuted, fontStyle: 'italic' }}>{text}</span>
      <span style={{ width: 1.5, height: 26, background: 'linear-gradient(to bottom, var(--border-strong), transparent)' }} />
    </div>
  );
  const guaranteeCard = (title: string, body: string, icon: React.ReactNode) => (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 11, background: t.cellBg, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: t.textPrimary }}>{icon}{title}</div>
      <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5, marginTop: 4 }}>{body}</div>
    </div>
  );
  const check = (text: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
      <svg style={{ flexShrink: 0, marginTop: 3 }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--status-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      <span style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.55 }}>{text}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, animation: 'dql-setup-fadein 0.25s ease-out', fontFamily: t.font }}>
      {/* hero */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 28, alignItems: 'center' }}>
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid var(--status-info-border)', background: 'var(--accent-dim)', borderRadius: 999, padding: '4px 13px', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.accent }}>
            Welcome to ZLens
          </div>
          <h1 style={{ margin: '12px 0 0', fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', color: t.textPrimary, lineHeight: 1.25 }}>Analytics your AI<br />can&apos;t hallucinate</h1>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
            {check('Sits on your dbt project or straight on your database — your models stay yours')}
            {check(<>Questions route through <strong>certified saved queries</strong> before AI writes SQL</>)}
            {check('Every answer carries a trust label your stakeholders can read')}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-setup-float 4s ease-in-out infinite' }}>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: '12px 14px', boxShadow: '0 8px 28px rgba(26,26,26,0.06)' }}>
            <div style={{ background: 'var(--bg-0)', borderRadius: '12px 12px 3px 12px', padding: '7px 11px', fontSize: 11.5, color: t.textPrimary, width: 'fit-content', marginLeft: 'auto' }}>What was revenue last quarter?</div>
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--status-success)', background: 'var(--status-success-bg)', border: '1px solid var(--status-success-border)', borderRadius: 999, padding: '1.5px 8px' }}>Certified</span>
              <span style={{ fontSize: 10, color: t.textMuted }}>from total_revenue · 0.3s</span>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: t.textPrimary }}>Q2 revenue was <strong>$4.82M</strong>, up 6.4% from Q1.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', fontSize: 10.5, color: t.textMuted, paddingRight: 4 }}>
            Traceable from source table to this answer
          </div>
        </div>
      </div>

      {chooser ? (
        <section aria-labelledby="welcome-model-source-title" style={{ border: '1px solid var(--border-subtle)', borderRadius: 14, background: t.cellBg, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h2 id="welcome-model-source-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>Where does your data model live?</h2>
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>ZLens works on a dbt project or straight on your database — with or without dbt.</div>
          </div>
          {chooser}
        </section>
      ) : null}

      {/* chapter 01 · pipeline */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: t.textMuted, fontFamily: t.fontMono }}>01</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>How a question becomes a trusted answer</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>Five stages, one direction — watch the flow.</div>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 14, background: t.cellBg, padding: '22px 20px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 26px 1fr 26px 1fr 26px 1fr 26px 1fr', alignItems: 'stretch' }}>
          {stageCard(0.1, { border: t.cellBorder, bg: t.appBg, iconBg: 'rgba(74,116,201,0.12)', iconColor: '#4a74c9', title: 'Sources & dbt', body: 'Your warehouse and models — dbt keeps ownership' },
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></svg>)}
          {arrow}
          {stageCard(0.35, { border: 'rgba(10,107,94,0.3)', bg: 'rgba(10,107,94,0.05)', iconBg: 'rgba(10,107,94,0.12)', iconColor: '#0a6b5e', title: 'Domains & modeling', body: 'Business entities, proven joins, skills' },
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0z" /><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3z" /><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5z" /></svg>)}
          {arrow}
          {stageCard(0.6, { border: 'rgba(107,93,211,0.35)', bg: 'var(--accent-dim)', iconBg: 'rgba(107,93,211,0.14)', iconColor: t.accent, title: 'Certified saved queries', body: 'Reusable governed answers — reviewed & certified', glow: true },
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>)}
          {arrow}
          {stageCard(0.85, { border: t.cellBorder, bg: t.appBg, iconBg: 'rgba(178,107,31,0.12)', iconColor: '#b26b1f', title: 'Ask & research', body: 'Ask AI answers + SQL notebooks for deep dives' },
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>)}
          {arrow}
          {stageCard(1.1, { border: 'rgba(46,139,87,0.3)', bg: 'rgba(46,139,87,0.05)', iconBg: 'var(--status-success-bg)', iconColor: 'var(--status-success)', title: 'Generative apps', body: 'Stakeholder apps built from certified saved queries' },
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>)}
        </div>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 999, background: 'linear-gradient(90deg, rgba(74,116,201,0.35), rgba(10,107,94,0.4), rgba(107,93,211,0.5), rgba(178,107,31,0.4), rgba(46,139,87,0.45), rgba(74,116,201,0.35))', backgroundSize: '200% 100%', animation: 'dql-setup-flowrail 5s linear infinite' }} />
            <span style={{ fontSize: 10, color: t.textMuted, whiteSpace: 'nowrap' }}>Lineage — trace any number from source to app, across domains</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 999, background: 'repeating-linear-gradient(90deg, var(--border-strong) 0 14px, transparent 14px 20px)', animation: 'dql-setup-gitdash 1.6s linear infinite' }} />
            <span style={{ fontSize: 10, color: t.textMuted, whiteSpace: 'nowrap' }}>Everything Git-versioned — branch, review, approve like code</span>
          </div>
        </div>
      </div>

      {connector('…and every good answer feeds the loop that makes the next one cheaper.')}

      {/* chapter 02 · trust loop (right-aligned) */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, justifyContent: 'flex-end', textAlign: 'right' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>Certify once, everyone reuses</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>The loop that grows trust — and cuts AI cost with every pass.</div>
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: t.textMuted, fontFamily: t.fontMono }}>02</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', animation: 'dql-setup-fadein 0.5s ease-out both', animationDelay: '1.3s' }}>
        {loopPill('Research freely', '#b26b1f', { color: '#b26b1f' })}
        {loopArrow}
        {loopPill('Review together', 'var(--accent)', { color: 'var(--accent)' })}
        {loopArrow}
        {loopPill('Certify once', 'var(--status-success)', { border: 'var(--status-success-border)', bg: 'var(--status-success-bg)', color: 'var(--status-success)' })}
        {loopArrow}
        {loopPill('Everyone reuses — instantly', '#4a74c9')}
        <span style={{ width: '100%', textAlign: 'right', fontSize: 11, color: t.textMuted, marginTop: 2 }}>A certified saved query answers the same question forever — no regenerated SQL, no second review, no token bill.</span>
      </div>

      {connector('Which is why the numbers survive the hardest room in the company.')}

      {/* chapter 03 · guarantees */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: t.textMuted, fontFamily: t.fontMono }}>03</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>Why it holds up in the boardroom</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>Four guarantees behind every number.</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, animation: 'dql-setup-fadein 0.5s ease-out both', animationDelay: '1.5s' }}>
        {guaranteeCard('High confidence', 'Certified answers at stakeholder precision — every answer carries its trust label.',
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--status-success)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>)}
        {guaranteeCard('Lower AI cost', 'Reusable saved queries answer repeat questions instantly — no regenerated SQL, no wasted tokens.',
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /></svg>)}
        {guaranteeCard('Git-versioned', 'Saved queries, domains, and apps are files — branch, review, and approve like code.',
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#b26b1f" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>)}
        {guaranteeCard('Full lineage', 'Trace any number from source table to app — including across domains.',
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4a74c9" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="M7 12l10-6M7 12l10 6" /></svg>)}
      </div>
    </div>
  );
}

function Section({ title, description, t, children }: { title: string; description: string; t: Theme; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}><div><h3 style={{ margin: 0, color: t.textPrimary, font: `600 15px ${t.font}` }}>{title}</h3><p style={{ margin: '5px 0 0', color: t.textSecondary, font: `12px/1.5 ${t.font}` }}>{description}</p></div>{children}</div>;
}

function Field({ label, hint, t, children }: { label: string; hint: string; t: Theme; children: React.ReactNode }) {
  return <label style={{ display: 'block' }}><span style={{ display: 'block', marginBottom: 5, color: t.textSecondary, font: `600 11px ${t.font}` }}>{label}</span>{children}<span style={{ display: 'block', marginTop: 5, color: t.textMuted, font: `10px ${t.font}` }}>{hint}</span></label>;
}

function OwnershipCallout({ t }: { t: Theme }) {
  return <Notice t={t} title="Read-only dbt ownership" body="Models, columns, descriptions, tests, lineage, catalog types, and MetricFlow formulas stay in dbt. ZLens stores sparse domains, bindings, relationship safety, contracts, skills, saved queries, and evaluations." />;
}

function Notice({ title, body, t }: { title: string; body: string; t: Theme }) {
  return <div style={{ border: `1px solid ${t.cellBorder}`, background: t.inputBg, borderRadius: 8, padding: '10px 12px', marginTop: 10 }}><div style={{ color: t.textPrimary, font: `600 11px ${t.font}` }}>{title}</div><div style={{ marginTop: 3, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{body}</div></div>;
}

function CountCard({ label, value, t }: { label: string; value: number; t: Theme }) {
  return <div style={{ border: `1px solid ${t.cellBorder}`, background: t.inputBg, borderRadius: 8, padding: 12 }}><div style={{ color: t.textPrimary, font: `700 20px ${t.font}` }}>{value}</div><div style={{ color: t.textMuted, font: `11px ${t.font}`, textTransform: 'capitalize' }}>{label}</div></div>;
}

function ArtifactRow({ label, value, required = false, t }: { label: string; value: string; required?: boolean; t: Theme }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 10, padding: '10px 12px', borderBottom: `1px solid ${t.cellBorder}`, color: t.textSecondary, font: `11px ${t.font}` }}><strong style={{ color: t.textPrimary }}>{label}</strong><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span><span>{required ? 'Required' : 'Optional'}</span></div>;
}

function Pill({ text, t, tone }: { text: string; t: Theme; tone?: 'warning' }) {
  const color = tone === 'warning' ? t.warning : t.accent;
  return <span style={{ border: `1px solid ${color}55`, color, background: `${color}0d`, borderRadius: 20, padding: '2px 7px', font: `600 9px ${t.font}` }}>{text}</span>;
}

function Checklist({ items, t }: { items: Array<[string, string]>; t: Theme }) {
  return <div style={{ display: 'grid', gap: 8 }}>{items.map(([title, body], index) => <div key={title} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, border: `1px solid ${t.cellBorder}`, borderRadius: 8, padding: 11 }}><span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', borderRadius: '50%', background: `${t.accent}18`, color: t.accent, font: `600 10px ${t.font}` }}>{index + 1}</span><div><strong style={{ color: t.textPrimary, font: `600 12px ${t.font}` }}>{title}</strong><div style={{ marginTop: 2, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>{body}</div></div></div>)}</div>;
}

function StartCard({ title, body, action, onClick, t }: { title: string; body: string; action: string; onClick: () => void; t: Theme }) {
  return <div style={{ display: 'flex', flexDirection: 'column', minHeight: 145, border: `1px solid ${t.cellBorder}`, borderRadius: 9, padding: 13 }}><strong style={{ color: t.textPrimary, font: `600 13px ${t.font}` }}>{title}</strong><div style={{ flex: 1, marginTop: 6, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{body}</div><button onClick={onClick} style={{ ...primaryButton(t), width: '100%', marginTop: 12 }}>{action}</button></div>;
}

function primaryButton(t: Theme, disabled = false): React.CSSProperties {
  return { border: `1px solid ${t.accent}`, background: t.accent, color: '#fff', borderRadius: 7, padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, font: `600 12px ${t.font}` };
}

function secondaryButton(t: Theme): React.CSSProperties {
  return { border: `1px solid ${t.cellBorder}`, background: t.btnBg, color: t.textSecondary, borderRadius: 7, padding: '8px 13px', cursor: 'pointer', font: `500 12px ${t.font}` };
}
