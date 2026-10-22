import React, { useEffect, useMemo, useState } from 'react';
import { ZLensMark } from '../shell/ZLensMark';
import { ArrowLeft, ArrowRight, Boxes, FileText, LayoutDashboard, MessageCircleQuestion, Sparkles } from 'lucide-react';
import { api, type ProviderSettings, type SetupLaunchResponse, type WaitingWarehouseDrafts, type WarehouseCatalogSummary } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { ConnectionRuntimeSettings } from '../settings/SettingsPage';
import { DbtProjectEditor, type DbtProjectConfigured } from '../settings/DbtProjectEditor';
import { DraftModelsCard, ExistingProjectSyncCard, ModelSourceChooser } from './ModelSourceChooser';
import {
  draftErrorMessage,
  draftOutcome,
  draftsFromWarehouse,
  existingProjectFromStatus,
  initialModelSource,
  modelingModeForSource,
  rememberProposalForModeling,
  rowsPrivacy,
  setupFinishTarget,
  setupStepTitles,
  type SetupStartTarget,
  stepOneBlocker,
  databaseOnlyUnavailable,
  stepTwoCopy,
  synchronizeExistingProject,
  type DraftOutcome,
  type ExistingProject,
  type ModelSource,
  type ProjectSyncStep,
} from './setup-model-source';
import { requestBuildNewApp } from '../apps/app-library-launch';

type SetupState = 'missing' | 'configured' | 'passed';
type SetupTarget = SetupStartTarget;

function hasRealConnection(connections: Record<string, unknown>): boolean {
  return Object.values(connections).some((value) => {
    if (!value || typeof value !== 'object') return false;
    const connection = value as Record<string, unknown>;
    const driver = String(connection.driver ?? connection.type ?? '').toLowerCase();
    if (driver !== 'duckdb') return Boolean(driver);
    const filepath = String(connection.filepath ?? connection.path ?? '').trim();
    return Boolean(filepath && filepath !== ':memory:');
  });
}

/** The default connection is a database file (DuckDB with a path). */
function databaseFileConnection(info: { default?: string; connections?: Record<string, unknown> }): boolean {
  const connection = info.default ? info.connections?.[info.default] : undefined;
  if (!connection || typeof connection !== 'object') return false;
  const record = connection as Record<string, unknown>;
  const driver = String(record.driver ?? record.type ?? '').toLowerCase();
  const filepath = String(record.filepath ?? record.path ?? '').trim();
  return driver === 'duckdb' && Boolean(filepath) && filepath !== ':memory:';
}

function providerSummary(provider: ProviderSettings | null): string {
  if (!provider) return 'No AI provider configured.';
  return `${provider.label}${provider.model ? ` · ${provider.model}` : ''}`;
}

export function SetupOnboarding({
  launch,
  onAcknowledged,
}: {
  launch?: SetupLaunchResponse;
  onAcknowledged?: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [projectState, setProjectState] = useState<SetupState>('missing');
  const [databaseState, setDatabaseState] = useState<SetupState>('missing');
  const [aiState, setAiState] = useState<SetupState>('missing');
  const [projectDetail, setProjectDetail] = useState('Choose a local dbt project or Git repository.');
  const [databaseDetail, setDatabaseDetail] = useState('Import a dbt profile or enter warehouse credentials.');
  const [aiProvider, setAiProvider] = useState<ProviderSettings | null>(null);
  const [aiSkipped, setAiSkipped] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [upgradeReapplied, setUpgradeReapplied] = useState(!launch?.requiresDbtReapply);
  const [acknowledgeError, setAcknowledgeError] = useState<string | null>(null);
  // Step 1, "Where does your data model live?" (RFC 0007 §8): dbt, the
  // database's own tables, both, or a project this folder already is.
  const [source, setSource] = useState<ModelSource | null>(null);
  const [existing, setExisting] = useState<ExistingProject | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<DraftOutcome | null>(null);
  // Drafts are kept on the server until saved or discarded (new-user round 2, Q3).
  const [waitingDrafts, setWaitingDrafts] = useState<WaitingWarehouseDrafts | null>(null);
  const [includeStaging, setIncludeStaging] = useState(false);
  const [domainName, setDomainName] = useState<string | null>(null);
  // Value profiles on: the rows sentence says a few column values reach the AI provider.
  const [valueProfileOn, setValueProfileOn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncSteps, setSyncSteps] = useState<ProjectSyncStep[] | null>(null);
  const [environment, setEnvironment] = useState<Array<{ name: string; set: boolean }>>([]);
  const requestedSource = state.setupModelSource;

  const requiresUpgradeReapply = Boolean(
    launch?.reason === 'version_upgrade'
    && launch.requiresDbtReapply
    && !upgradeReapplied,
  );

  useEffect(() => {
    setUpgradeReapplied(!launch?.requiresDbtReapply);
    setAcknowledgeError(null);
    if (launch?.requiresDbtReapply) {
      setStep(1);
      setSource('dbt');
    }
  }, [launch?.requiresDbtReapply, launch?.version]);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.getOnboardingStatus().catch(() => null),
      api.getBlockStudioDbtStatus().catch(() => null),
      api.getConnections().catch(() => null),
      api.getProviderSettings().catch(() => null),
      api.getSetupProgress().catch(() => null),
      api.getWaitingWarehouseDrafts().catch(() => null),
    ]).then(([onboarding, dbt, connectionInfo, providerInfo, progress, waiting]) => {
      if (!alive) return;
      setWaitingDrafts(waiting);
      if (onboarding?.dbt?.configured || (dbt?.configured && dbt.artifacts.manifest.exists)) {
        setProjectState(onboarding?.modeling?.snapshotState === 'ready' ? 'passed' : 'configured');
        setProjectDetail(onboarding?.preparation?.message || onboarding?.dbt?.repoUrl || onboarding?.dbt?.projectDir || dbt?.projectPath || 'dbt project configured');
      }
      const realConnection = Boolean(connectionInfo && hasRealConnection(connectionInfo.connections ?? {}));
      if (connectionInfo && realConnection) {
        setDatabaseState('configured');
        const active = connectionInfo.connections?.[connectionInfo.default];
        const driver = active && typeof active === 'object'
          ? String((active as Record<string, unknown>).driver ?? (active as Record<string, unknown>).type ?? 'Database')
          : 'Database';
        setDatabaseDetail(`${driver} configured — test to verify reachability.`);
        setConnectionId(connectionInfo.default);
      }
      setEnvironment(connectionInfo?.environmentReferences ?? []);
      setValueProfileOn(connectionInfo?.valueProfile === true);
      const catalog = (connectionInfo as { warehouseCatalog?: WarehouseCatalogSummary } | null)?.warehouseCatalog;
      if (catalog?.relations && !catalog.error) setCatalogReady(true);
      const project = existingProjectFromStatus(onboarding, realConnection ? connectionInfo : null);
      setExisting(project);
      // A restart resumes where setup was left (design D7), unless an update must reapply dbt first.
      const resume = progress && !launch?.requiresDbtReapply ? progress : null;
      setSource((current) => current ?? resume?.source ?? initialModelSource({
        requested: requestedSource,
        requiresDbtReapply: Boolean(launch?.requiresDbtReapply),
        existing: project,
        dbtProjectFound: Boolean(onboarding?.dbt?.projectFound),
        hasDomains: (onboarding?.domains?.count ?? 0) > 0,
        databaseFileConnection: Boolean(connectionInfo && databaseFileConnection(connectionInfo)),
      }));
      if (resume) {
        setStep(resume.step);
        if (resume.aiSkipped) setAiSkipped(true);
        if (resume.draft) setDraft(resume.draft);
        if (resume.source === 'warehouse') {
          setProjectState('configured');
          setProjectDetail('Database only · no dbt project');
        }
      }
      const provider = providerInfo?.providers.find((candidate) => candidate.active && candidate.configured)
        ?? providerInfo?.providers.find((candidate) => candidate.enabled && candidate.configured)
        ?? null;
      if (provider) {
        setAiProvider(provider);
        setAiState('configured');
      }
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  // Save the step and answers so a restart resumes here (design D7).
  useEffect(() => {
    if (loading) return;
    void api.saveSetupProgress({
      step: step as 1 | 2 | 3 | 4,
      ...(source ? { source } : {}),
      ...(aiSkipped ? { aiSkipped } : {}),
      ...(draft ? { draft } : {}),
    }).catch(() => undefined);
  }, [loading, step, source, aiSkipped, draft]);

  const acknowledge = async (): Promise<boolean> => {
    setAcknowledging(true);
    setAcknowledgeError(null);
    try {
      await api.acknowledgeSetupLaunch();
      onAcknowledged?.();
      return true;
    } catch (error) {
      setAcknowledgeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setAcknowledging(false);
    }
  };
  const close = () => {
    if (acknowledging || requiresUpgradeReapply) return;
    void acknowledge().then((acknowledged) => {
      if (acknowledged) dispatch({ type: 'CLOSE_SETUP' });
    });
  };
  const finishTo = (target: SetupTarget) => {
    if (acknowledging || requiresUpgradeReapply) return;
    void acknowledge().then((acknowledged) => {
      if (!acknowledged) return;
      // "Build an App" opens the new App form, not only the library (new-user round 2, problem 10).
      if (target === 'apps') requestBuildNewApp();
      dispatch({ type: 'SET_MAIN_VIEW', view: target });
      if (target === 'notebook') dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      dispatch({ type: 'CLOSE_SETUP' });
    });
  };
  const onProjectConfigured = (project: DbtProjectConfigured) => {
    setUpgradeReapplied(true);
    setProjectState(project.readiness === 'ready' ? 'passed' : 'configured');
    setProjectDetail(project.readinessDetail || `${project.name} · ${project.summary}`);
  };
  const onProviderConfigured = (provider: ProviderSettings) => {
    setAiSkipped(false);
    setAiState('passed');
    setAiProvider(provider);
  };

  const chooseSource = (next: ModelSource) => {
    setSource(next);
    setContinueError(null);
  };
  const stepOneBlocked = stepOneBlocker({
    source,
    requiresDbtReapply: requiresUpgradeReapply,
    dbtConfigured: projectState !== 'missing',
    existing,
  });
  /** Leave step 1: turn on warehouse-first or hybrid modeling when the answer needs it. */
  const continueFromStepOne = async () => {
    if (!source || stepOneBlocked) return;
    const mode = modelingModeForSource(source);
    if (!mode) {
      setStep(2);
      return;
    }
    setContinuing(true);
    setContinueError(null);
    try {
      await api.enableWarehouseModeling(mode);
      if (source === 'warehouse') {
        setProjectState('configured');
        setProjectDetail('Database only · no dbt project');
      }
      setStep(2);
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : String(error));
    } finally {
      setContinuing(false);
    }
  };
  const draftModels = async (options: { includeStaging?: boolean; domain?: string | null } = {}) => {
    const staging = options.includeStaging ?? includeStaging;
    const domain = options.domain === undefined ? domainName : options.domain;
    setDrafting(true);
    setDraft(null);
    try {
      const outcome = draftOutcome(await api.draftWarehouseModel({ validate: true, ...(staging ? { includeStaging: true } : {}), ...(domain ? { domain } : {}) }));
      if (outcome.proposalId) rememberProposalForModeling(outcome.proposalId);
      setDraft(outcome);
    } catch (error) {
      setDraft({ ok: false, message: draftErrorMessage(error) });
    } finally {
      setWaitingDrafts(await api.getWaitingWarehouseDrafts().catch(() => null));
      setDrafting(false);
    }
  };
  const toggleStaging = (include: boolean) => {
    setIncludeStaging(include);
    void draftModels({ includeStaging: include });
  };
  const renameDomain = (name: string) => {
    setDomainName(name);
    void draftModels({ domain: name });
  };
  const synchronize = async () => {
    if (!existing) return;
    setSyncing(true);
    setSyncSteps(null);
    try {
      const latest = await api.getConnections().catch(() => null);
      const references = latest?.environmentReferences ?? environment;
      setEnvironment(references);
      setSyncSteps(await synchronizeExistingProject(existing, latest?.default ?? connectionId, api, references));
    } finally {
      setSyncing(false);
    }
  };

  const drafted = Boolean(draft?.proposalId || waitingDrafts);
  const stepTwo = stepTwoCopy(source, existing, valueProfileOn);
  const hint = useMemo(() => {
    if (loading) return 'Loading existing project-local configuration…';
    if (step === 1) {
      if (requiresUpgradeReapply) return `Required for ZLens ${launch?.version}: Preview and Reapply the prefilled dbt project.`;
      if (stepOneBlocked) return stepOneBlocked;
      if (source === 'warehouse') return `Database only · ${rowsPrivacy(valueProfileOn, true)}`;
      if (source === 'existing') return `Existing project · ${existing?.label ?? 'configured'}`;
      return projectState === 'missing'
        ? 'Preview before applying; existing dbt settings stay untouched.'
        : `${projectState === 'passed' ? 'Ready' : 'Configured'} · ${projectDetail}`;
    }
    if (step === 2) {
      if (draftsFromWarehouse(source) && draft?.ok && draft.proposalId) return 'Models drafted · review and certify them in Modeling.';
      return databaseState === 'passed' ? `Test passed · ${databaseDetail}` : databaseState === 'configured' ? databaseDetail : 'A failed test rolls back to the previous connection.';
    }
    if (step === 3) return aiSkipped ? 'AI skipped · limited-AI mode remains available.' : aiState === 'missing' ? 'Optional · skip for now or configure a provider.' : `${aiState === 'passed' ? 'Test passed' : 'Configured'} · ${providerSummary(aiProvider)}`;
    return 'Setup complete';
  }, [aiProvider, aiSkipped, aiState, databaseDetail, databaseState, draft, existing, launch?.version, loading, projectDetail, projectState, requiresUpgradeReapply, source, step, stepOneBlocked, valueProfileOn]);

  const supportingText = t.textSecondary;
  const primaryButton: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px',
    borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12.5,
    fontWeight: 700, cursor: 'pointer', fontFamily: t.font,
  };
  const secondaryButton: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px',
    borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: t.cellBg,
    color: t.textSecondary, fontSize: 12.5, fontWeight: 650, cursor: 'pointer', fontFamily: t.font,
  };
  const launchTitle = launch?.reason === 'version_upgrade'
    ? `ZLens ${launch.version} update review`
    : launch?.reason === 'first_install'
      ? `Welcome to ZLens ${launch.version}`
      : 'Guided Setup';
  const launchNotice = launch?.reason === 'version_upgrade'
    ? requiresUpgradeReapply
      ? `ZLens was updated${launch.acknowledgedVersion ? ` from ${launch.acknowledgedVersion}` : ''} to ${launch.version}. Reapply the prefilled dbt project to rebuild its OSS governed snapshot with this version. Saved paths and credentials remain unchanged until Apply succeeds.`
      : `ZLens was updated${launch.acknowledgedVersion ? ` from ${launch.acknowledgedVersion}` : ''} to ${launch.version}. The dbt project was reapplied with this version; review the remaining saved connections before finishing.`
    : launch?.reason === 'first_install'
      ? `ZLens ${launch.version} is installed. Tell it where your data model lives and connect the database before entering the workspace; AI remains optional.`
      : null;
  const nextDisabled = step === 1 && (Boolean(stepOneBlocked) || continuing || loading);
  const nextLabel = step === 1
    ? (continuing ? 'Setting up…' : source === 'existing' ? 'Continue to credentials' : 'Continue to database')
    : step === 2 ? 'Continue to optional AI' : 'Continue to finish';
  // "Finish setup" goes where the highlighted start card says.
  const finish = setupFinishTarget({ drafted });
  const finishTarget: SetupTarget = finish.target;

  return (
    <div role="dialog" aria-modal="true" aria-label="Guided Setup" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: t.appBg, color: t.textPrimary, display: 'flex', flexDirection: 'column', fontFamily: t.font }}>
      <header style={{ height: 54, flexShrink: 0, borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, display: 'flex', alignItems: 'center', gap: 11, padding: '0 20px' }}>
        <span style={{ display: 'inline-flex', color: t.textPrimary, flexShrink: 0 }}><ZLensMark size={27} /></span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{launchTitle}</div>
          <div style={{ fontSize: 10.5, color: t.textMuted }}>{setupStepTitles(source)}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11.5, color: t.textMuted }}>Step {step} of 4</span>
          <div style={{ display: 'flex', gap: 4 }} aria-hidden>
            {[1, 2, 3, 4].map((number) => <span key={number} style={{ width: 23, height: 4, borderRadius: 999, background: number <= step ? t.accent : t.pillBg }} />)}
          </div>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ width: 'min(760px, calc(100% - 36px))', margin: '0 auto', padding: '26px 0 34px' }}>
          {launchNotice ? (
            <div style={{ marginBottom: 18, border: '1px solid var(--status-info-border)', background: 'var(--status-info-bg)', borderRadius: 10, padding: '11px 13px', color: supportingText, fontSize: 11.5, lineHeight: 1.55 }}>
              {launchNotice}
            </div>
          ) : null}
          {step === 1 ? (
            <SetupSection eyebrow="Step 1 of 4" title="Where does your data model live?" description="ZLens works on a dbt project or straight on your database. You can add the other later in Settings." t={t}>
              {loading ? null : (
                <ModelSourceChooser value={source} onChange={chooseSource} existing={existing} dbtOnly={requiresUpgradeReapply} t={t} />
              )}
              {source === 'dbt' || source === 'both' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 750, color: t.textPrimary }}>Connect your dbt project</h3>
                    <div style={{ marginTop: 4, fontSize: 11.5, color: supportingText, lineHeight: 1.55 }}>
                      {source === 'both'
                        ? "Preview a local project or Git repository and apply it. The next step adds the warehouse schemas dbt doesn't cover."
                        : 'Preview a local project or Git repository, then apply it only after the manifest is valid.'}
                    </div>
                  </div>
                  <DbtProjectEditor compact reapplyRequired={requiresUpgradeReapply} onConfigured={onProjectConfigured} />
                </div>
              ) : null}
              {source === 'warehouse' ? (
                <div style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 10, padding: '12px 13px', fontSize: 11.5, color: supportingText, lineHeight: 1.55 }}>
                  {databaseOnlyUnavailable(existing)
                    ? databaseOnlyUnavailable(existing)
                    : <><strong style={{ color: t.textPrimary }}>Next:</strong> connect your database, choose the schemas to model, Apply and synchronize, then Draft my models. You review and certify the drafts in Modeling before Ask relies on them.</>}
                </div>
              ) : null}
              {continueError ? <div role="alert" style={{ color: 'var(--status-error)', fontSize: 11.5, lineHeight: 1.5 }}>{continueError}</div> : null}
            </SetupSection>
          ) : null}

          {step === 2 ? (
            <SetupSection eyebrow="Step 2 of 4" title={stepTwo.title} description={stepTwo.description} t={t}>
              <ConnectionPanel
                variant="setup"
                setupSource={source}
                onConfigured={(detail) => {
                  setDatabaseState('passed');
                  setDatabaseDetail(detail);
                }}
                onMetadataSynced={(result) => {
                  if (result.warehouseCatalog?.relations && !result.warehouseCatalog.error) setCatalogReady(true);
                }}
              />
              {draftsFromWarehouse(source) ? (
                <DraftModelsCard
                  busy={drafting}
                  canDraft={catalogReady}
                  outcome={draft}
                  onDraft={() => void draftModels()}
                  waiting={waitingDrafts}
                  includeStaging={includeStaging}
                  onToggleStaging={toggleStaging}
                  onRename={renameDomain}
                  t={t}
                />
              ) : null}
              {source === 'existing' && existing ? (
                <ExistingProjectSyncCard project={existing} busy={syncing} steps={syncSteps} environment={environment} onSync={() => void synchronize()} t={t} />
              ) : null}
            </SetupSection>
          ) : null}

          {step === 3 ? (
            <SetupSection eyebrow="Step 3 of 4" title="Set up an AI provider" description="Optional. AI powers governed Ask and assisted authoring; deterministic queries and non-AI product paths remain available without it." badge="Optional" t={t}>
              <ConnectionRuntimeSettings embedded includeMemory={false} section="providers" editorMode="setup" onProviderConfigured={onProviderConfigured} />
              <div style={{ border: '1px solid var(--status-info-border)', background: 'var(--status-info-bg)', borderRadius: 10, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, fontSize: 11.5, color: supportingText, lineHeight: 1.5 }}>Continue in limited-AI mode and configure a provider later in Settings.</div>
                <button type="button" onClick={() => { setAiSkipped(true); setStep(4); }} style={secondaryButton}>Skip AI for now</button>
              </div>
            </SetupSection>
          ) : null}

          {step === 4 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>Step 4 of 4 · Setup complete</div>
                <h2 style={{ margin: '7px 0 0', fontSize: 22, color: t.textPrimary }}>Where do you want to start?</h2>
                {aiState === 'missing' || aiSkipped ? <div style={{ fontSize: 12, color: t.textMuted, marginTop: 7 }}>AI is not configured. Deterministic and non-AI workflows remain available; return to Settings when you want governed Ask.</div> : null}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 11 }}>
                {drafted ? (
                  <StartCard icon={<Boxes size={17} />} title="Review drafted models" body="Check the drafted models and joins, certify the ones that are right, then Ask." action="Open Modeling" onClick={() => finishTo('domains')} t={t} primary={finishTarget === 'domains'} />
                ) : null}
                <StartCard icon={<LayoutDashboard size={17} />} title="Build a dashboard" body="Pick a table from your database and publish a page with live, checked numbers." action="Build an App" onClick={() => finishTo('apps')} t={t} primary={finishTarget === 'apps'} />
                {drafted ? null : (
                  <StartCard icon={<Boxes size={17} />} title="Build your domain" body="Add models, relationships, business terms, and skills." action="Open Modeling" onClick={() => finishTo('domains')} t={t} />
                )}
                <StartCard icon={<MessageCircleQuestion size={17} />} title="Ask" body={aiState === 'missing' || aiSkipped ? 'Open Ask in limited mode; configure AI before a governed model answer.' : 'Ask a business question grounded in your governed context.'} action="Open Ask" onClick={() => finishTo('ask')} t={t} />
                <StartCard icon={<FileText size={17} />} title="Research notebook" body="Work with SQL, DQL, and charts, then save reusable queries." action="New notebook" onClick={() => finishTo('notebook')} t={t} />
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <footer style={{ flexShrink: 0, minHeight: 58, borderTop: `1px solid ${t.headerBorder}`, background: t.headerBg, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 22px' }}>
        {step > 1 ? <button type="button" onClick={() => setStep((current) => Math.max(1, current - 1))} style={secondaryButton}><ArrowLeft size={13} /> Back</button> : null}
        <div style={{ flex: 1 }} />
        <span title={hint} style={{ fontSize: 11, color: t.textMuted, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>
        {acknowledgeError ? <span role="alert" style={{ fontSize: 11, color: 'var(--status-error)', maxWidth: 320 }}>{acknowledgeError}</span> : null}
        <button type="button" disabled={acknowledging || requiresUpgradeReapply} onClick={close} style={{ ...secondaryButton, opacity: acknowledging || requiresUpgradeReapply ? 0.5 : 1, cursor: acknowledging || requiresUpgradeReapply ? 'not-allowed' : 'pointer' }}>
          {acknowledging
            ? 'Saving review…'
            : requiresUpgradeReapply
              ? 'Reapply required'
            : launch?.reason === 'version_upgrade'
              ? 'Close update review'
              : projectState === 'missing' && databaseState === 'missing'
                ? 'Skip setup'
                : 'Close setup'}
        </button>
        {step < 4 ? (
          <button type="button" disabled={nextDisabled} onClick={() => { if (step === 1) void continueFromStepOne(); else setStep((current) => Math.min(4, current + 1)); }} style={{ ...primaryButton, opacity: nextDisabled ? 0.5 : 1, cursor: nextDisabled ? 'not-allowed' : 'pointer' }}>
            {nextLabel} <ArrowRight size={13} />
          </button>
        ) : (
          <button type="button" disabled={acknowledging} onClick={() => finishTo(finishTarget)} style={{ ...primaryButton, opacity: acknowledging ? 0.65 : 1 }}><Sparkles size={13} /> Finish setup · {finish.action}</button>
        )}
      </footer>
    </div>
  );
}

function SetupSection({
  eyebrow,
  title,
  description,
  badge,
  children,
  t,
}: {
  eyebrow: string;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  t: (typeof themes)[keyof typeof themes];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 17 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>{eyebrow}</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 750, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {badge ? <span style={{ border: `1px solid ${t.headerBorder}`, color: t.textMuted, borderRadius: 999, padding: '2px 9px', fontSize: 10, fontWeight: 750 }}>{badge}</span> : null}
        </h2>
        <div style={{ marginTop: 6, fontSize: 12.5, color: t.textSecondary, lineHeight: 1.55 }}>{description}</div>
      </div>
      {children}
    </div>
  );
}

function StartCard({
  icon,
  title,
  body,
  action,
  onClick,
  primary = false,
  t,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onClick: () => void;
  primary?: boolean;
  t: (typeof themes)[keyof typeof themes];
}) {
  return (
    <button type="button" onClick={onClick} style={{ border: `1.5px solid ${primary ? t.accent : t.headerBorder}`, borderRadius: 12, background: primary ? 'var(--accent-dim)' : t.cellBg, padding: 17, textAlign: 'left', cursor: 'pointer', fontFamily: t.font, minHeight: 170, display: 'flex', flexDirection: 'column' }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, color: primary ? t.accent : t.textSecondary, background: primary ? t.cellBg : t.appBg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <span style={{ marginTop: 12, fontSize: 13.5, fontWeight: 750, color: t.textPrimary }}>{title}</span>
      <span style={{ marginTop: 6, fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5 }}>{body}</span>
      <span style={{ marginTop: 'auto', paddingTop: 12, fontSize: 11.5, fontWeight: 700, color: primary ? t.accent : t.textSecondary }}>{action} →</span>
    </button>
  );
}
