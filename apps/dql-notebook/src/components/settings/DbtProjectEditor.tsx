import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  api,
  type DbtOnboardingJob,
  type DbtOnboardingPreviewResponse,
  type DbtOnboardingStatusResponse,
  type MetricFlowInstallerStatus,
  type MetricFlowWarehouseAdapter,
  type SemanticRuntimeSettingsResponse,
} from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { AdvancedDisclosure } from '../modals/AdvancedDisclosure';
import { dbtPreparationFromResponse } from './dbt-preparation-model';
import { watchMetricFlowInstall } from './metricflow-install-watch';

function looksLikeGitRepository(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/i.test(value.trim());
}

function sourcePayload(source: string) {
  const value = source.trim();
  if (!value) return {};
  return looksLikeGitRepository(value) ? { repoUrl: value } : { projectDir: value };
}

export type DbtProjectConfigured = {
  name: string;
  path: string;
  summary: string;
  readiness: 'preparing' | 'ready';
  readinessDetail?: string;
};

const RUNTIME_LABEL: Record<string, string> = {
  auto: 'Auto',
  native: 'Native (DQL)',
  'metricflow-cli': 'Local MetricFlow',
  'dbt-cloud': 'dbt Cloud',
};

export function DbtProjectEditor({
  compact = false,
  reapplyRequired = false,
  onConfigured,
}: {
  compact?: boolean;
  reapplyRequired?: boolean;
  onConfigured?: (project: DbtProjectConfigured) => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [status, setStatus] = useState<DbtOnboardingStatusResponse | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<DbtOnboardingPreviewResponse | null>(null);
  const [preparation, setPreparation] = useState<DbtOnboardingJob | null>(null);
  const [busy, setBusy] = useState<'loading' | 'preview' | 'apply' | 'refresh' | null>('loading');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [semanticRuntime, setSemanticRuntime] = useState<SemanticRuntimeSettingsResponse | null>(null);
  const [semanticHost, setSemanticHost] = useState('');
  const [semanticEnvironmentId, setSemanticEnvironmentId] = useState('');
  const [semanticToken, setSemanticToken] = useState('');
  const [semanticBusy, setSemanticBusy] = useState<'test' | 'apply' | null>(null);
  const [semanticMessage, setSemanticMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [metricFlowInstaller, setMetricFlowInstaller] = useState<MetricFlowInstallerStatus | null>(null);
  const [metricFlowAdapter, setMetricFlowAdapter] = useState<MetricFlowWarehouseAdapter | ''>('');
  const [metricFlowStarting, setMetricFlowStarting] = useState(false);

  const loadSemanticRuntime = useCallback(async () => {
    const runtime = await api.getSemanticRuntimeSettings();
    setSemanticRuntime(runtime);
    setSemanticHost(runtime.dbtCloud.host ?? '');
    setSemanticEnvironmentId(runtime.dbtCloud.environmentId ?? '');
    setSemanticToken('');
    return runtime;
  }, []);

  const loadMetricFlowInstaller = useCallback(async () => {
    const installer = await api.getMetricFlowInstallerStatus();
    setMetricFlowInstaller(installer);
    setMetricFlowAdapter((current) => current || installer.recommendedAdapter || installer.supportedAdapters[0] || '');
    return installer;
  }, []);

  const loadStatus = useCallback(async () => {
    const [next, dbt] = await Promise.all([
      api.getOnboardingStatus(),
      api.getBlockStudioDbtStatus().catch(() => null),
    ]);
    setStatus(next);
    setPreparation(next.preparation ?? null);
    const configured = next.dbt?.configured === true || Boolean(dbt?.configured && dbt.artifacts.manifest.exists);
    setProjectReady(configured);
    const configuredSource = next.dbt?.repoUrl || next.dbt?.projectDir || dbt?.projectPath || '';
    setSource(configured ? configuredSource : '');
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void loadStatus()
      .catch((error) => alive && setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) }))
      .finally(() => alive && setBusy(null));
    return () => { alive = false; };
  }, [loadStatus]);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadSemanticRuntime(), loadMetricFlowInstaller()]).catch((error) => {
      if (alive) setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    });
    return () => { alive = false; };
  }, [loadMetricFlowInstaller, loadSemanticRuntime]);

  useEffect(() => {
    const job = metricFlowInstaller?.job;
    if (!job || (job.state !== 'queued' && job.state !== 'running')) return;
    let cancelled = false;
    void watchMetricFlowInstall({
      jobId: job.id,
      loadStatus: loadMetricFlowInstaller,
      isCancelled: () => cancelled,
      onCompleted: async (next) => {
        await loadSemanticRuntime();
        const layer = await api.getSemanticLayer();
        if (cancelled) return;
        dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
        setSemanticMessage({ ok: true, text: next.job?.message || 'Local MetricFlow is installed and ready.' });
      },
      onFailed: (next) => {
        if (cancelled) return;
        setSemanticMessage({
          ok: false,
          text: next.job?.error || next.job?.message || 'Local MetricFlow installation failed.',
        });
      },
    }).catch((error) => {
      if (!cancelled) setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [dispatch, loadMetricFlowInstaller, loadSemanticRuntime, metricFlowInstaller?.job?.id]);

  useEffect(() => {
    if (!preparation || (preparation.status !== 'queued' && preparation.status !== 'running')) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await api.getOnboardingJob(preparation.id);
        if (!alive) return;
        const next = dbtPreparationFromResponse(response);
        if (!next) return;
        setPreparation(next);
        if (next.status === 'completed') {
          await loadStatus();
          if (alive) setMessage({ ok: true, text: next.message || 'dbt metadata and governed search indexes are ready.' });
        } else if (next.status === 'failed' || next.status === 'cancelled') {
          setMessage({ ok: false, text: next.error || next.message || `dbt preparation ${next.status}.` });
        } else {
          timer = window.setTimeout(() => void poll(), 650);
        }
      } catch (error) {
        if (alive) setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
      }
    };
    timer = window.setTimeout(() => void poll(), 350);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadStatus, preparation?.id, preparation?.status]);

  const inspect = async () => {
    setBusy('preview');
    setMessage(null);
    try {
      const next = await api.previewDbtOnboarding(sourcePayload(source));
      setPreview(next);
      setMessage({
        ok: true,
        text: `Preview ready: ${next.counts.models ?? 0} models, ${next.counts.sources ?? 0} sources, ${next.counts.metrics ?? 0} metrics. Nothing has changed yet.`,
      });
    } catch (error) {
      setPreview(null);
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    setMessage(null);
    try {
      const applied = await api.applyDbtOnboarding({
        ...(preview.repoUrl
          ? { repoUrl: preview.repoUrl, branch: preview.branch, subPath: preview.subPath }
          : { projectDir: preview.projectDir }),
        manifestPath: preview.manifestPath,
        profilesDir: preview.profilesDir,
        expectedFingerprint: preview.fingerprint,
      });
      const nextPreparation = dbtPreparationFromResponse(applied);
      if (nextPreparation) setPreparation(nextPreparation);
      const nextStatus = await loadStatus();
      await loadMetricFlowInstaller();
      const observedPreparation = nextStatus.preparation ?? nextPreparation;
      const summary = `${preview.counts.models ?? 0} models · ${preview.counts.sources ?? 0} sources · ${preview.counts.metrics ?? 0} metrics`;
      setMessage({
        ok: true,
        text: observedPreparation?.status === 'completed'
          ? observedPreparation.message || `Connected ${preview.projectName || preview.projectDir}. Governed search is ready.`
          : observedPreparation
          ? `Connected ${preview.projectName || preview.projectDir}. ZLens is preparing ${summary} for fast governed search in the background.`
          : `Applied ${preview.projectName || preview.projectDir}. ${summary}.`,
      });
      onConfigured?.({
        name: preview.projectName || 'dbt project',
        path: preview.projectDir,
        summary,
        readiness: observedPreparation?.status === 'completed' ? 'ready' : 'preparing',
        readinessDetail: observedPreparation?.message,
      });
      setPreview(null);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setMessage(null);
    try {
      const current = await api.previewDbtOnboarding({});
      const refreshed = await api.refreshDbtOnboarding({ expectedFingerprint: current.fingerprint });
      const nextPreparation = dbtPreparationFromResponse(refreshed);
      if (nextPreparation) setPreparation(nextPreparation);
      const nextStatus = await loadStatus();
      const observedPreparation = nextStatus.preparation ?? nextPreparation;
      setMessage({
        ok: true,
        text: observedPreparation?.status === 'completed'
          ? observedPreparation.message || 'dbt artifacts and governed search indexes are ready.'
          : observedPreparation
            ? 'dbt artifacts refreshed. Governed search indexes are updating in the background.'
            : 'dbt artifacts refreshed from the configured project.',
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const semanticPayload = () => ({
    preference: semanticRuntime?.preference ?? 'auto',
    dbtCloud: {
      host: semanticHost,
      environmentId: semanticEnvironmentId,
      serviceToken: semanticToken,
    },
  });

  const applyRuntimePreference = async (preference: 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud') => {
    setSemanticBusy('apply');
    setSemanticMessage(null);
    try {
      const result = await api.setSemanticRuntimePreference(preference);
      setSemanticRuntime(result);
      setSemanticMessage({ ok: true, text: `Preferred runtime set to ${RUNTIME_LABEL[preference] ?? preference}.` });
    } catch (error) {
      setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSemanticBusy(null);
    }
  };

  const testSemanticRuntime = async () => {
    setSemanticBusy('test');
    setSemanticMessage(null);
    try {
      const result = await api.testDbtCloudSemanticRuntime(semanticPayload());
      setSemanticMessage({ ok: result.ok, text: result.message || result.error || 'dbt Cloud Semantic Layer test failed.' });
    } finally {
      setSemanticBusy(null);
    }
  };

  const applySemanticRuntime = async () => {
    setSemanticBusy('apply');
    setSemanticMessage(null);
    try {
      const result = await api.applyDbtCloudSemanticRuntime(semanticPayload());
      setSemanticRuntime(result);
      setSemanticToken('');
      setSemanticMessage({
        ok: true,
        text: `${result.dbtCloud.testMessage || 'dbt Cloud Semantic Layer tested.'} Compilation is now bound to the active warehouse target.`,
      });
    } catch (error) {
      setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSemanticBusy(null);
    }
  };

  const installMetricFlow = async () => {
    if (!metricFlowAdapter) {
      setSemanticMessage({ ok: false, text: 'Choose the warehouse adapter used by this dbt project.' });
      return;
    }
    setMetricFlowStarting(true);
    setSemanticMessage(null);
    try {
      const result = await api.installMetricFlow(metricFlowAdapter);
      setMetricFlowInstaller((current) => current ? { ...current, job: result.job } : {
        job: result.job,
        recommendedAdapter: metricFlowAdapter,
        supportedAdapters: [metricFlowAdapter],
        projectConfigured: true,
        semanticManifestFound: false,
      });
    } catch (error) {
      setSemanticMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setMetricFlowStarting(false);
    }
  };

  const configured = projectReady;
  const metricFlowJob = metricFlowInstaller?.job ?? null;
  const metricFlowInstalling = metricFlowStarting || metricFlowJob?.state === 'queued' || metricFlowJob?.state === 'running';
  const metricFlowFailed = metricFlowJob?.state === 'failed';
  const preparing = preparation?.status === 'queued' || preparation?.status === 'running';
  const preparationFailed = preparation?.status === 'failed' || preparation?.status === 'cancelled';
  // Until the status has loaded, say so: "dbt project missing" flashed on
  // first start in a folder that already is a configured dbt project (Codex F01).
  const checking = busy === 'loading' && !status;
  const foundUnapplied = !configured && Boolean(status?.dbt?.projectFound);
  const projectStatusTitle = reapplyRequired
    ? 'Reapply required after ZLens update'
    : checking
    ? 'Checking the dbt project…'
    : preparationFailed
    ? 'dbt project needs attention'
    : preparing
      ? 'Preparing governed search'
      : configured
        ? 'dbt project ready'
        : foundUnapplied
          ? 'dbt project found in this folder'
          : 'No dbt project yet';
  const projectStatusDetail = reapplyRequired
    ? 'Review the prefilled project, choose Preview, then Reapply project.'
    : checking
    ? "Reading this folder's dbt settings."
    : preparation?.message
    ?? (configured
      ? status?.dbt?.repoUrl || status?.dbt?.projectDir || 'Configured dbt project.'
      : foundUnapplied
        ? 'Preview it, then apply it.'
        : 'Choose a local path or Git repository.');
  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', height: 36, borderRadius: 8,
    border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.textPrimary,
    padding: '0 11px', fontFamily: t.fontMono, fontSize: 12, outline: 'none',
  };
  const secondary: React.CSSProperties = {
    height: 32, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.headerBorder}`,
    background: t.cellBg, color: t.textSecondary, fontFamily: t.font, fontSize: 12,
    fontWeight: 650, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
  };

  return (
    <div style={{ width: 'min(680px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!compact ? (
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary }}>Project &amp; dbt</div>
          <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Preview a local project or Git repository before ZLens replaces the active dbt configuration.
          </div>
        </div>
      ) : null}

      <div style={{ border: `1px solid ${reapplyRequired ? 'var(--status-warning-border)' : preparationFailed ? 'var(--status-error-border)' : preparing ? 'var(--status-info-border)' : configured ? 'var(--status-success-border)' : 'var(--border-subtle)'}`, borderRadius: 12, background: t.cellBg, padding: '14px 16px', display: 'flex', gap: 11, alignItems: 'center' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: reapplyRequired ? 'var(--status-warning)' : preparationFailed ? 'var(--status-error)' : preparing ? 'var(--status-info)' : configured ? 'var(--status-success)' : 'var(--status-warning)', background: reapplyRequired ? 'var(--status-warning-bg)' : preparationFailed ? 'var(--status-error-bg)' : preparing ? 'var(--status-info-bg)' : configured ? 'var(--status-success-bg)' : 'var(--status-warning-bg)' }}>
          {reapplyRequired ? <RefreshCw size={17} /> : preparationFailed ? <AlertCircle size={17} /> : preparing ? <LoaderCircle className="dql-dbt-preparing-icon" size={17} /> : configured ? <CheckCircle2 size={17} /> : <GitBranch size={17} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>{projectStatusTitle}</div>
          <div style={{ fontSize: 11.5, color: preparationFailed ? 'var(--status-error)' : t.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {projectStatusDetail}
          </div>
          {preparing ? <div aria-label="dbt preparation progress" style={{ width: 'min(360px, 100%)', height: 3, borderRadius: 999, background: 'var(--border-subtle)', marginTop: 7, overflow: 'hidden' }}><span style={{ display: 'block', width: `${Math.max(8, preparation?.progress ?? 8)}%`, height: '100%', borderRadius: 999, background: t.accent, transition: 'width 180ms ease' }} /></div> : null}
        </div>
        {configured && !reapplyRequired ? <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} style={secondary}><RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button> : null}
      </div>

      <style>{`@keyframes dql-dbt-preparing-spin { to { transform: rotate(360deg); } } .dql-dbt-preparing-icon { animation: dql-dbt-preparing-spin 1s linear infinite; } @media (prefers-reduced-motion: reduce) { .dql-dbt-preparing-icon { animation: none; } }`}</style>

      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 16, display: 'grid', gap: 10 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary }}>Local dbt project path or Git repository URL</span>
          <input value={source} onChange={(event) => { setSource(event.target.value); setPreview(null); }} placeholder=". or https://github.com/org/analytics.git" style={input} />
        </label>
        {preview ? (
          <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 11px', color: t.textSecondary, fontSize: 11.5, lineHeight: 1.5 }}>
            <strong style={{ color: t.textPrimary }}>{preview.projectName || preview.projectDir}</strong><br />
            {preview.counts.models ?? 0} models · {preview.counts.sources ?? 0} sources · {preview.counts.metrics ?? 0} metrics<br />
            <span style={{ fontFamily: t.fontMono }}>{preview.manifestPath}</span>
          </div>
        ) : null}
        {message ? <div role={message.ok ? 'status' : 'alert'} style={{ fontSize: 11.5, lineHeight: 1.5, color: message.ok ? 'var(--status-success)' : 'var(--status-error)' }}>{message.text}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={() => void inspect()} disabled={Boolean(busy)} style={secondary}>{busy === 'preview' ? 'Inspecting…' : 'Preview'}</button>
          {preview ? <button type="button" onClick={() => void apply()} disabled={Boolean(busy)} style={{ ...secondary, border: 'none', background: t.accent, color: '#fff' }}>{busy === 'apply' ? 'Applying…' : reapplyRequired ? 'Reapply project' : 'Apply project'}</button> : null}
        </div>
      </div>

      {/* Guided Setup (compact) keeps the adapters under Advanced (design D7). */}
      <AdvancedDisclosure enabled={compact} hint="semantic execution adapters" t={t}>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 16, display: 'grid', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>Semantic execution adapters</div>
          <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Adapter code is included with ZLens. Auto selects one ready adapter in priority order: dbt Cloud, local MetricFlow, then native for simple metrics. Once selected, an adapter failure is shown directly and never silently downgraded.
          </div>
          {semanticRuntime?.dbtCloud.configured ? (
            <div style={{ fontSize: 10.5, color: semanticRuntime.dbtCloud.targetBindingState === 'bound' && semanticRuntime.dbtCloud.metricInventoryState === 'complete' ? 'var(--status-success)' : 'var(--status-warning)', marginTop: 6, lineHeight: 1.5 }}>
              dbt Cloud target: {semanticRuntime.dbtCloud.targetBindingState === 'bound'
                ? `bound · ${semanticRuntime.dbtCloud.executionTargetFingerprint?.slice(0, 12)}`
                : 'reapply required before execution'}
              <br />
              Metric inventory: {semanticRuntime.dbtCloud.metricInventoryState}
              {semanticRuntime.dbtCloud.semanticCatalogFingerprint
                ? ` · ${semanticRuntime.dbtCloud.semanticCatalogFingerprint.slice(0, 12)}`
                : ' · reapply required'}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary }}>Preferred runtime</label>
            <select
              value={semanticRuntime?.preference ?? 'auto'}
              onChange={(event) => { void applyRuntimePreference(event.target.value as 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud'); }}
              disabled={semanticBusy === 'apply'}
              style={{ fontSize: 11.5, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border-subtle)', background: t.cellBg, color: t.textPrimary, fontFamily: t.font }}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="dbt-cloud">dbt Cloud</option>
              <option value="metricflow-cli">Local MetricFlow</option>
              <option value="native">Native (DQL)</option>
            </select>
            {semanticRuntime?.runtime.active ? (
              <span style={{ fontSize: 10.5, color: t.textMuted }}>
                Active: <strong style={{ color: t.textSecondary }}>{RUNTIME_LABEL[semanticRuntime.runtime.active] ?? semanticRuntime.runtime.active}</strong>
                {semanticRuntime.preference && semanticRuntime.preference !== 'auto' && semanticRuntime.preference !== semanticRuntime.runtime.active
                  ? ` (preferred ${RUNTIME_LABEL[semanticRuntime.preference] ?? semanticRuntime.preference} is not ready)`
                  : ''}
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 7 }}>
          {(semanticRuntime?.runtime.adapters ?? []).map((adapter) => (
            <div key={adapter.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, padding: '9px 10px', display: 'grid', gap: adapter.id === 'metricflow-cli' ? 10 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, marginTop: 4, background: adapter.ready ? 'var(--status-success)' : adapter.configured ? 'var(--status-warning)' : 'var(--text-muted)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: t.textPrimary }}>{adapter.label}</span>
                    {semanticRuntime?.runtime.active === adapter.id ? <span style={{ fontSize: 9, fontWeight: 700, color: t.accent }}>ACTIVE</span> : null}
                  </div>
                  <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2, lineHeight: 1.4 }}>{adapter.detail}</div>
                </div>
                <span style={{ fontSize: 9.5, color: adapter.ready ? 'var(--status-success)' : t.textMuted }}>{adapter.ready ? 'Ready' : adapter.configured ? 'Configured' : 'Setup required'}</span>
              </div>

              {adapter.id === 'metricflow-cli' && (!adapter.ready || metricFlowJob) ? (
                <div style={{ marginLeft: 17, paddingTop: 9, borderTop: '1px solid var(--border-subtle)', display: 'grid', gap: 8 }}>
                  {!adapter.ready ? (
                    <>
                      <div style={{ fontSize: 10.5, color: t.textSecondary, lineHeight: 1.45 }}>
                        Install into an isolated <code style={{ fontFamily: t.fontMono }}>.dql/runtimes/metricflow</code> environment. ZLens never uses sudo or changes system Python.
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select
                          aria-label="MetricFlow warehouse adapter"
                          value={metricFlowAdapter}
                          onChange={(event) => setMetricFlowAdapter(event.target.value as MetricFlowWarehouseAdapter)}
                          disabled={metricFlowInstalling}
                          style={{ ...input, width: 160, height: 32, fontFamily: t.font }}
                        >
                          {(metricFlowInstaller?.supportedAdapters ?? []).map((candidate) => (
                            <option key={candidate} value={candidate}>{candidate === 'postgres' ? 'PostgreSQL' : candidate.charAt(0).toUpperCase() + candidate.slice(1)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void installMetricFlow()}
                          disabled={!configured || metricFlowInstalling || !metricFlowAdapter}
                          style={{ ...secondary, border: 'none', background: t.accent, color: '#fff', opacity: !configured || metricFlowInstalling || !metricFlowAdapter ? 0.55 : 1, cursor: !configured || metricFlowInstalling ? 'not-allowed' : 'pointer' }}
                        >
                          {metricFlowInstalling ? <LoaderCircle className="dql-dbt-preparing-icon" size={12} style={{ verticalAlign: -2, marginRight: 6 }} /> : <Download size={12} style={{ verticalAlign: -2, marginRight: 6 }} />}
                          {metricFlowInstalling ? 'Installing…' : 'Install local MetricFlow'}
                        </button>
                      </div>
                      {!configured ? <div style={{ fontSize: 9.5, color: t.textMuted }}>Connect the dbt project first, then install its matching runtime.</div> : null}
                    </>
                  ) : null}

                  {metricFlowJob ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <div role={metricFlowFailed ? 'alert' : 'status'} style={{ fontSize: 10.5, color: metricFlowFailed ? 'var(--status-error)' : metricFlowJob.state === 'completed' ? 'var(--status-success)' : t.textSecondary, lineHeight: 1.45 }}>
                        {metricFlowJob.message}
                      </div>
                      {(metricFlowJob.state === 'queued' || metricFlowJob.state === 'running') ? (
                        <div aria-label="MetricFlow installation progress" style={{ height: 3, borderRadius: 999, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                          <span style={{ display: 'block', height: '100%', width: `${Math.max(4, metricFlowJob.progress)}%`, background: t.accent, transition: 'width 180ms ease' }} />
                        </div>
                      ) : null}
                      {metricFlowJob.error || metricFlowJob.logs.length > 0 ? (
                        <details>
                          <summary style={{ cursor: 'pointer', fontSize: 9.5, color: t.textMuted }}>{metricFlowFailed ? 'View error and manual details' : 'View installation details'}</summary>
                          <pre style={{ margin: '7px 0 0', maxHeight: 130, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: t.fontMono, fontSize: 9, lineHeight: 1.45, color: metricFlowFailed ? 'var(--status-error)' : t.textMuted }}>{[...metricFlowJob.logs.slice(-30), ...(metricFlowJob.error ? [metricFlowJob.error] : [])].join('\n')}</pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: t.textSecondary }}>dbt Cloud Semantic Layer</summary>
          <div style={{ display: 'grid', gap: 9, marginTop: 11 }}>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Host</span>
              <input value={semanticHost} onChange={(event) => setSemanticHost(event.target.value)} placeholder="semantic-layer.cloud.getdbt.com" style={input} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Environment ID</span>
              <input value={semanticEnvironmentId} onChange={(event) => setSemanticEnvironmentId(event.target.value)} placeholder="123456" style={input} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 650, color: t.textSecondary }}>Service token</span>
              <input type="password" value={semanticToken} onChange={(event) => setSemanticToken(event.target.value)} placeholder={semanticRuntime?.dbtCloud.serviceTokenPreview || 'Semantic Layer service token'} autoComplete="off" style={input} />
              <span style={{ fontSize: 9.5, color: t.textMuted }}>Requires Semantic Layer and Metadata permissions. Leave blank to preserve the stored token.</span>
            </label>
            {semanticMessage ? <div role={semanticMessage.ok ? 'status' : 'alert'} style={{ fontSize: 11, color: semanticMessage.ok ? 'var(--status-success)' : 'var(--status-error)' }}>{semanticMessage.text}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => void testSemanticRuntime()} disabled={Boolean(semanticBusy)} style={secondary}>{semanticBusy === 'test' ? 'Testing…' : 'Test draft'}</button>
              <button type="button" onClick={() => void applySemanticRuntime()} disabled={Boolean(semanticBusy)} style={{ ...secondary, border: 'none', background: t.accent, color: '#fff' }}>{semanticBusy === 'apply' ? 'Testing & binding…' : 'Test, bind & save'}</button>
            </div>
          </div>
        </details>
      </div>
      </AdvancedDisclosure>
    </div>
  );
}
