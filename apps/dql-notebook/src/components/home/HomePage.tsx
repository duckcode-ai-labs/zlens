import type { Theme } from '../../themes/notebook-theme';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Blocks,
  BookOpenText,
  Check,
  Database,
  FileJson,
  GitBranch,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { BlockStudioDbtStatus, NotebookFile, SemanticLayerState, SettingsTab, SidebarPanel } from '../../store/types';
import { api } from '../../api/client';
import { SetupWizard } from '../modals/SetupWizard';
import { StarterBlocks } from './StarterBlocks';

type StepState = 'ready' | 'active' | 'waiting' | 'optional';

interface ConnectionInfo {
  default: string;
  connections: Record<string, unknown>;
  dbtProfiles?: Array<{ id: string; profileName: string; targetName: string; missingFields: string[] }>;
}

interface WorkflowStep {
  id: string;
  number: string;
  title: string;
  body: string;
  state: StepState;
  Icon: LucideIcon;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  evidence: string[];
}

const ARTIFACTS = [
  ['dql-manifest.json', 'Compiled project graph for lineage, trust, Apps, and AI context.'],
  ['semantic-layer/', 'Imported or authored metrics, dimensions, models, and saved queries.'],
  ['connections', 'Warehouse credentials and schema status for executing saved queries.'],
  ['blocks/', 'Reusable DQL blocks built from dbt objects, SQL, tables, or semantic metrics.'],
  ['notebooks/', 'Analysis workspaces where users explore, edit, and assemble saved queries.'],
  ['apps/', 'Published consumption surfaces for stakeholders.'],
];

export function HomePage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const counts = countFiles(state.files);
  const semanticCounts = countSemanticObjects(state.semanticLayer);
  const dbtStatus = state.blockStudioDbtStatus;
  const sourceCounts = {
    models: Math.max(semanticCounts.models, dbtStatus?.counts.semanticModels ?? 0, dbtStatus?.counts.models ?? 0),
    metrics: Math.max(semanticCounts.metrics, dbtStatus?.counts.metrics ?? 0),
    dimensions: semanticCounts.dimensions,
    savedQueries: Math.max(semanticCounts.savedQueries, dbtStatus?.counts.savedQueries ?? 0),
  };
  const schemaCounts = countSchema(state.schemaTables);

  const [connections, setConnections] = useState<ConnectionInfo | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api.getConnections().then((info) => {
      if (!cancelled) setConnections(info as ConnectionInfo);
    });

    // AI is optional. This flag means a provider has a complete saved/env
    // configuration; reachability is still established by an explicit test.
    void api.getProviderSettings()
      .then((res) => {
        if (!cancelled) setAiReady(res.providers.some((p) => p.enabled && p.configured));
      })
      .catch(() => { /* leave aiReady false */ });

    void api.getBlockStudioDbtStatus()
      .then((status: BlockStudioDbtStatus) => {
        if (!cancelled) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status: null });
      });

    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    void api.getSemanticLayer()
      .then((layer) => {
        if (!cancelled) dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      })
      .finally(() => {
        if (!cancelled) dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
      });

    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps()
      .then((apps) => {
        if (!cancelled) dispatch({ type: 'SET_APPS', apps });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'SET_APPS', apps: [] });
      })
      .finally(() => {
        if (!cancelled) dispatch({ type: 'SET_APPS_LOADING', loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const connectionCount = Object.keys(connections?.connections ?? {}).length;
  const dbtProfileCount = connections?.dbtProfiles?.length ?? 0;
  const dbtArtifactsReady = Boolean(dbtStatus?.artifacts.manifest.exists || dbtStatus?.artifacts.semanticManifest.exists);
  const sourceReady = dbtArtifactsReady || state.semanticLayer.available || semanticCounts.total > 0 || counts.blocks > 0;
  const connectionReady = connectionCount > 0 || state.schemaTables.length > 0;
  const dqlReady = counts.blocks > 0;
  const notebookReady = counts.notebooks > 0;
  const appReady = state.apps.length > 0;

  const currentStep = !sourceReady
    ? 'source'
    : !connectionReady
      ? 'connection'
      : !dqlReady
        ? 'build'
        : 'notebook';

  const openPanel = (panel: SidebarPanel) => {
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
  };

  const openSettingsTab = (tab: SettingsTab) => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
  };

  const openSemanticBlock = () => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
    dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'semantic' });
  };

  const openSqlImport = () => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'imports' });
  };

  const refreshAfterSemanticImport = async () => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    try {
      const [layer, files] = await Promise.all([
        api.getSemanticLayer(),
        api.listNotebooks(),
      ]);
      dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      dispatch({ type: 'SET_FILES', files });
    } finally {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
    }
  };

  const steps: WorkflowStep[] = useMemo(() => [
    {
      id: 'source',
      number: '1',
      title: 'Connect dbt and compile context',
      body: 'Start with the dbt repo or semantic source. Import models, metrics, dimensions, and compile the local manifest context that ZLens uses for lineage and AI.',
      state: sourceReady ? 'ready' : currentStep === 'source' ? 'active' : 'waiting',
      Icon: GitBranch,
      primaryLabel: sourceReady ? 'Refresh semantic import' : 'Connect dbt repo',
      onPrimary: () => setSetupWizardOpen(true),
      secondaryLabel: 'Browse lineage',
      onSecondary: () => openPanel('lineage'),
      evidence: [
        `${sourceCounts.models} semantic models`,
        `${sourceCounts.metrics} metrics`,
        `${sourceCounts.dimensions} dimensions`,
        `${counts.blocks + counts.businessViews} DQL artifacts`,
      ],
    },
    {
      id: 'connection',
      number: '2',
      title: 'Connect database and test access',
      body: 'Use dbt profiles.yml where your runtime already resolves it, or enter warehouse credentials directly. Test the connection and refresh schema before building saved queries.',
      state: connectionReady ? 'ready' : currentStep === 'connection' ? 'active' : 'waiting',
      Icon: Database,
      primaryLabel: connectionReady ? 'Manage connections' : 'Add database connection',
      onPrimary: () => openSettingsTab('database'),
      secondaryLabel: 'Open connections',
      onSecondary: () => openSettingsTab('database'),
      evidence: [
        `${connectionCount} connection${connectionCount === 1 ? '' : 's'}`,
        `${dbtProfileCount} dbt profile target${dbtProfileCount === 1 ? '' : 's'}`,
        `${schemaCounts.tables} tables`,
        `${schemaCounts.columns} columns`,
      ],
    },
    {
      id: 'ai',
      number: '3',
      title: 'Connect an AI provider (optional)',
      body: 'AI powers governed Ask and assisted authoring. Without it, SQL execution, dbt metadata, lineage, deterministic helpers, and other non-AI paths remain available.',
      state: aiReady ? 'ready' : 'optional',
      Icon: Sparkles,
      primaryLabel: aiReady ? 'Manage AI providers' : 'Connect AI provider',
      onPrimary: () => openSettingsTab('ai'),
      secondaryLabel: 'Open settings',
      onSecondary: () => openSettingsTab('ai'),
      evidence: [
        aiReady ? 'Provider configured — test in Settings to verify' : 'Optional · works without AI',
      ],
    },
    {
      id: 'build',
      number: '4',
      title: 'Build governed saved queries',
      body: 'Build reviewed reusable saved queries from dbt and semantic context. Use AI suggestions when configured, or work deterministically in Saved queries.',
      state: dqlReady ? 'ready' : currentStep === 'build' ? 'active' : 'waiting',
      Icon: Blocks,
      primaryLabel: dqlReady ? 'Open saved query suggestions' : 'Suggest saved queries with AI',
      onPrimary: () => dispatch({ type: 'SET_MAIN_VIEW', view: 'readiness' }),
      secondaryLabel: 'Open Saved queries',
      onSecondary: () => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' }),
      evidence: [
        `${counts.blocks} saved queries`,
        `${counts.terms} business terms`,
        `${counts.businessViews} business views`,
      ],
    },
    {
      id: 'notebook',
      number: '5',
      title: 'Analyze in notebooks and publish to Apps',
      body: 'Search, add, and edit notebooks around reviewed saved queries. When the answer is ready, promote it into an App for stakeholder consumption.',
      state: notebookReady || appReady ? 'ready' : currentStep === 'notebook' ? 'active' : 'waiting',
      Icon: BookOpenText,
      primaryLabel: notebookReady ? 'Open notebooks' : 'Create notebook',
      onPrimary: () => {
        if (notebookReady) openPanel('files');
        else dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      },
      secondaryLabel: appReady ? 'Open Apps' : 'Build App',
      onSecondary: () => openPanel('apps'),
      evidence: [
        `${counts.notebooks} notebooks`,
        `${state.apps.length} apps`,
        `${state.apps.reduce((sum, app) => sum + app.dashboards.length, 0)} dashboards`,
      ],
    },
  ], [
    aiReady,
    appReady,
    connectionCount,
    connectionReady,
    counts.blocks,
    counts.businessViews,
    counts.notebooks,
    counts.terms,
    currentStep,
    dqlReady,
    dbtProfileCount,
    notebookReady,
    schemaCounts.columns,
    schemaCounts.tables,
    sourceCounts.dimensions,
    sourceCounts.metrics,
    sourceReady,
    state.apps,
  ]);

  const readyCount = steps.filter((step) => step.state === 'ready' || step.state === 'optional').length;
  const currentStepObj = steps.find((step) => step.id === currentStep) ?? steps[0];
  const focusStep = steps.find((step) => step.id === selectedStepId) ?? currentStepObj;
  const allReady = steps.every((step) => step.state === 'ready' || step.state === 'optional');

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        background: t.appBg,
      }}
    >
      <style>{HOME_PAGE_STYLES}</style>
      <main className="dql-home-page">
        <section className="dql-home-hero dql-home-fade" style={{ animationDelay: '0ms' }}>
          <div className="dql-home-hero-copy">
            <div className="dql-home-brand-row">
              <span className="dql-home-logo">ZLens</span>
              <span style={{ color: t.textMuted }}>Guided setup</span>
            </div>
            <h1 style={{ color: t.textPrimary }}>
              {allReady ? 'Your workspace is ready' : 'Set up your analytics workspace'}
            </h1>
            <p className="dql-home-lead" style={{ color: t.textSecondary }}>
              {allReady
                ? 'Source, database, saved queries, notebooks and Apps are all connected. Jump back into building.'
                : 'Connect your data, build reviewed saved queries, then deliver with notebooks and Apps.'}
            </p>
            <div className="dql-home-cta-row">
              <button className="dql-home-primary-btn" onClick={currentStepObj.onPrimary}>
                <currentStepObj.Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                {currentStepObj.primaryLabel}
                <ArrowRight size={15} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="dql-home-progress-badge" style={{ borderColor: t.cellBorder, background: t.inputBg }}>
            <ProgressRing ready={readyCount} total={steps.length} t={t} />
            <div>
              <strong style={{ color: t.textPrimary }}>{readyCount} of {steps.length} satisfied</strong>
              <span style={{ color: t.textMuted }}>{allReady ? 'All set up' : nextActionShort(currentStep)}</span>
            </div>
          </div>
        </section>

        <section className="dql-home-stepper dql-home-fade" aria-label="ZLens setup steps" style={{ animationDelay: '60ms' }}>
          {steps.map((step, index) => (
            <Stepper
              key={step.id}
              step={step}
              index={index}
              total={steps.length}
              selected={focusStep?.id === step.id}
              t={t}
              onSelect={() => setSelectedStepId(step.id)}
            />
          ))}
        </section>

        {focusStep && (
          <section className="dql-home-fade" style={{ animationDelay: '120ms' }}>
            <StepFocusCard step={focusStep} t={t} />
          </section>
        )}

        {/* First-run teaching: when the user is on the "build blocks" step and has
            no blocks yet, show a few AI-drafted starter blocks inline so they can
            learn the concept by example before building their own. */}
        {focusStep?.id === 'build' && !dqlReady && (
          <section className="dql-home-fade" style={{ animationDelay: '150ms' }}>
            <StarterBlocks t={t} aiReady={aiReady} onSetupAi={() => openSettingsTab('ai')} />
          </section>
        )}

        <section className="dql-home-metrics dql-home-fade" style={{ animationDelay: '180ms' }}>
          <MetricChip label="Saved queries" value={counts.blocks} Icon={Blocks} t={t} />
          <MetricChip label="Notebooks" value={counts.notebooks} Icon={BookOpenText} t={t} />
          <MetricChip label="Apps" value={state.apps.length} Icon={Workflow} t={t} />
          <MetricChip label="Tables" value={schemaCounts.tables} Icon={Database} t={t} />
          <MetricChip label="Metrics" value={sourceCounts.metrics} Icon={Network} t={t} />
        </section>

        <details className="dql-home-details dql-home-fade" style={{ animationDelay: '240ms', borderColor: t.cellBorder, background: t.cellBg }}>
          <summary style={{ color: t.textSecondary }}>
            <span>Project details</span>
            <span className="dql-home-details-hint" style={{ color: t.textMuted }}>catalog, schema, and artifacts</span>
          </summary>
          <div className="dql-home-details-body">
            <div className="dql-home-context-grid">
              <ContextPanel
                title="Source objects"
                description="Trusted inputs from dbt and semantic imports."
                Icon={GitBranch}
                t={t}
                rows={[
                  ['dbt project', dbtStatus?.projectName ?? (dbtStatus?.configured ? 'Configured' : 'Not detected')],
                  ['manifest.json', artifactLabel(dbtStatus?.artifacts.manifest)],
                  ['semantic_manifest.json', artifactLabel(dbtStatus?.artifacts.semanticManifest)],
                  ['Semantic models', String(sourceCounts.models)],
                  ['Metrics', String(sourceCounts.metrics)],
                  ['Dimensions', String(sourceCounts.dimensions)],
                ]}
                actionLabel="Connect or refresh"
                onAction={() => setSetupWizardOpen(true)}
              />
              <ContextPanel
                title="Database catalog"
                description="Connection and schema determine whether saved queries run."
                Icon={Database}
                t={t}
                rows={[
                  ['Default connection', connections?.default ?? 'Unknown'],
                  ['Connection profiles', String(connectionCount)],
                  ['dbt profile targets', String(dbtProfileCount)],
                  ['Schemas', String(schemaCounts.schemas)],
                  ['Tables', String(schemaCounts.tables)],
                  ['Columns', String(schemaCounts.columns)],
                ]}
                actionLabel="Open connections"
                onAction={() => openPanel('connection')}
              />
              <ContextPanel
                title="Authoring inventory"
                description="Versioned files that move into notebooks and Apps."
                Icon={FileJson}
                t={t}
                rows={[
                  ['Saved queries', String(counts.blocks)],
                  ['Business terms', String(counts.terms)],
                  ['Business views', String(counts.businessViews)],
                  ['Notebooks', String(counts.notebooks)],
                  ['Apps', String(state.apps.length)],
                ]}
                actionLabel="Open Saved queries"
                onAction={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' })}
              />
            </div>
            <div className="dql-home-artifact-list">
              {ARTIFACTS.map(([name, description]) => (
                <div key={name} className="dql-home-artifact-row" style={{ borderColor: t.cellBorder }}>
                  <code style={{ color: t.textPrimary }}>{name}</code>
                  <span style={{ color: t.textSecondary }}>{description}</span>
                </div>
              ))}
            </div>
          </div>
        </details>
      </main>

      {setupWizardOpen && (
        <SetupWizard
          detectedProvider={state.semanticLayer.provider}
          onClose={() => setSetupWizardOpen(false)}
          onImported={() => void refreshAfterSemanticImport()}
        />
      )}
    </div>
  );
}

const ACCENT = 'var(--color-accent-blue, #2563eb)';
const SUCCESS = 'var(--color-accent-green, #16a34a)';

function stepColor(state: StepState, t: Theme): string {
  if (state === 'ready') return SUCCESS;
  if (state === 'active') return t.warning;
  if (state === 'optional') return t.accent;
  return t.textMuted;
}

function Stepper({
  step,
  index,
  total,
  selected,
  t,
  onSelect,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  selected: boolean;
  t: Theme;
  onSelect: () => void;
}) {
  const Icon = step.Icon;
  const badgeStyle = step.state === 'ready'
    ? { background: SUCCESS, borderColor: SUCCESS, color: '#fff' }
    : step.state === 'active'
      ? { background: t.cellBg, borderColor: t.warning, color: t.warning }
      : { background: t.cellBg, borderColor: t.cellBorder, color: t.textMuted };
  return (
    <button
      type="button"
      className={`dql-home-node is-${step.state} ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      style={{ color: t.textSecondary, background: selected ? t.cellBg : 'transparent' }}
    >
      {index < total - 1 ? (
        <span className="dql-home-node-track" aria-hidden="true" style={{ background: step.state === 'ready' ? SUCCESS : t.cellBorder }} />
      ) : null}
      <span className="dql-home-node-badge" aria-hidden="true" style={badgeStyle}>
        {step.state === 'ready' ? <Check size={18} strokeWidth={3} /> : <Icon size={18} strokeWidth={2} />}
      </span>
      <span className="dql-home-node-meta">
        <span className="dql-home-node-title" style={{ color: t.textPrimary }}>{step.title.split(' ').slice(0, 3).join(' ')}</span>
        <span className="dql-home-node-status" style={{ color: stepColor(step.state, t) }}>{statusLabel(step.state)}</span>
      </span>
    </button>
  );
}

function StepFocusCard({ step, t }: { step: WorkflowStep; t: Theme }) {
  const Icon = step.Icon;
  return (
    <article className={`dql-home-focus is-${step.state}`} style={{ borderColor: step.state === 'active' ? t.warning : step.state === 'ready' ? `${SUCCESS}` : t.cellBorder, background: t.cellBg }}>
      <div className="dql-home-focus-icon" style={{ background: `${t.accent}16`, color: t.accent }}>
        <Icon size={20} strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="dql-home-focus-body">
        <div className="dql-home-focus-head">
          <h2 style={{ color: t.textPrimary }}>{step.title}</h2>
          <span className="dql-home-status" style={{ color: stepColor(step.state, t), background: `${stepColor(step.state, t)}1f` }}>{statusLabel(step.state)}</span>
        </div>
        <p style={{ color: t.textSecondary }}>{step.body}</p>
        <div className="dql-home-evidence">
          {step.evidence.map((item) => (
            <span key={item} style={{ borderColor: t.cellBorder, color: t.textMuted }}>{item}</span>
          ))}
        </div>
        <div className="dql-home-card-actions">
          <button className="dql-home-primary-btn dql-home-card-btn" onClick={step.onPrimary}>
            {step.primaryLabel}
            <ArrowRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          {step.secondaryLabel && step.onSecondary && (
            <button className="dql-home-secondary-btn dql-home-card-btn" onClick={step.onSecondary}>
              {step.secondaryLabel}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function MetricChip({ label, value, Icon, t }: { label: string; value: number; Icon: LucideIcon; t: Theme }) {
  return (
    <div className="dql-home-metric" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
      <span className="dql-home-metric-icon" style={{ color: t.accent }}><Icon size={15} strokeWidth={2} aria-hidden="true" /></span>
      <strong style={{ color: t.textPrimary }}>{value.toLocaleString()}</strong>
      <span style={{ color: t.textMuted }}>{label}</span>
    </div>
  );
}

function ProgressRing({ ready, total, t }: { ready: number; total: number; t: Theme }) {
  const pct = total > 0 ? ready / total : 0;
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg className="dql-home-ring" width={44} height={44} viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={r} fill="none" stroke={t.cellBorder} strokeWidth="4" />
      <circle
        cx="22" cy="22" r={r} fill="none"
        stroke={SUCCESS} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 22 22)"
        style={{ transition: 'stroke-dashoffset 700ms ease' }}
      />
      <text x="22" y="26" textAnchor="middle" fontSize="12" fontWeight="800" fill={t.textPrimary}>{ready}</text>
    </svg>
  );
}

function nextActionShort(currentStep: string): string {
  if (currentStep === 'source') return 'Connect a dbt or semantic source';
  if (currentStep === 'connection') return 'Add and test a database';
  if (currentStep === 'ai') return 'Connect an AI provider';
  if (currentStep === 'build') return 'Build your first saved query';
  return 'Open notebooks and publish an App';
}

function ContextPanel({
  title,
  description,
  Icon,
  rows,
  actionLabel,
  onAction,
  t,
}: {
  title: string;
  description: string;
  Icon: LucideIcon;
  rows: Array<[string, string]>;
  actionLabel: string;
  onAction: () => void;
  t: Theme;
}) {
  return (
    <section className="dql-home-context-panel" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
      <div className="dql-home-context-head">
        <div className="dql-home-context-icon" style={{ background: `${t.accent}18`, color: t.accent }}>
          <Icon size={18} strokeWidth={2} aria-hidden="true" />
        </div>
        <div>
          <h2 style={{ color: t.textPrimary }}>{title}</h2>
          <p style={{ color: t.textSecondary }}>{description}</p>
        </div>
      </div>
      <div className="dql-home-context-rows">
        {rows.map(([label, value]) => (
          <div key={label} className="dql-home-context-row" style={{ borderColor: t.cellBorder }}>
            <span style={{ color: t.textMuted }}>{label}</span>
            <strong style={{ color: t.textPrimary }}>{value}</strong>
          </div>
        ))}
      </div>
      <button className="dql-home-link-btn" onClick={onAction}>
        {actionLabel}
        <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </section>
  );
}

function statusLabel(state: StepState): string {
  if (state === 'ready') return 'Ready';
  if (state === 'active') return 'Next';
  if (state === 'optional') return 'Optional';
  return 'Waiting';
}

function nextActionCopy(currentStep: string): string {
  if (currentStep === 'source') {
    return 'Connect a dbt project or semantic source first. ZLens needs source context before it can recommend useful saved queries and lineage.';
  }
  if (currentStep === 'connection') {
    return 'Add a database connection and test it. This confirms ZLens can execute the saved queries created from your source context.';
  }
  if (currentStep === 'build') {
    return 'Create the first reviewed saved query from a semantic metric, dbt model, table, or imported SQL file.';
  }
  return 'Open a notebook, assemble the reviewed saved queries, and publish the answer into an App when it is ready for others.';
}

function artifactLabel(artifact?: { exists: boolean; count?: number }): string {
  if (!artifact) return 'Unknown';
  if (!artifact.exists) return 'Missing';
  return typeof artifact.count === 'number' ? `Ready (${artifact.count})` : 'Ready';
}

function countFiles(files: NotebookFile[]) {
  return files.reduce(
    (acc, file) => {
      if (file.type === 'block') acc.blocks += 1;
      else if (file.type === 'term') acc.terms += 1;
      else if (file.type === 'business_view') acc.businessViews += 1;
      else if (file.type === 'notebook' || file.type === 'workbook') acc.notebooks += 1;
      return acc;
    },
    { notebooks: 0, blocks: 0, terms: 0, businessViews: 0 },
  );
}

function countSemanticObjects(layer: SemanticLayerState) {
  const metrics = layer.metrics.length;
  const measures = layer.measures.length;
  const dimensions = layer.dimensions.length + layer.timeDimensions.length;
  const models = layer.semanticModels.length;
  const savedQueries = layer.savedQueries.length;
  return {
    metrics,
    measures,
    dimensions,
    models,
    savedQueries,
    total: metrics + measures + dimensions + models + savedQueries + layer.entities.length + layer.hierarchies.length,
  };
}

function countSchema(tables: Array<{ name: string; columns: unknown[] }>) {
  const schemas = new Set<string>();
  let columns = 0;
  for (const table of tables) {
    const [schema, ...rest] = table.name.split('.');
    schemas.add(rest.length > 0 ? schema : 'default');
    columns += table.columns.length;
  }
  return { schemas: schemas.size, tables: tables.length, columns };
}

const HOME_PAGE_STYLES = `
.dql-home-page {
  width: min(1080px, calc(100% - 48px));
  margin: 0 auto;
  padding: 28px 0 56px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

@keyframes dql-home-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.dql-home-fade { animation: dql-home-rise 480ms cubic-bezier(0.2,0.7,0.2,1) both; }

.dql-home-hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.dql-home-hero-copy { display: flex; flex-direction: column; gap: 12px; min-width: 0; flex: 1 1 420px; }
.dql-home-brand-row { display: inline-flex; align-items: center; gap: 10px; font: 800 11px var(--font-mono, ui-monospace, monospace); letter-spacing: 0.08em; text-transform: uppercase; }
.dql-home-logo { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 9px; border-radius: 7px; background: var(--color-accent-blue, #2563eb); color: var(--accent-on, #fff); }
.dql-home-hero h1 { margin: 0; font-size: 30px; line-height: 1.1; font-weight: 820; letter-spacing: -0.01em; }
.dql-home-lead { margin: 0; font-size: 14px; line-height: 1.5; max-width: 48ch; }
.dql-home-cta-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }

.dql-home-primary-btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--color-accent-blue, #2563eb); border-radius: 9px; background: var(--color-accent-blue, #2563eb); color: var(--accent-on, #fff); padding: 9px 15px; font: 750 13px var(--font-ui, inherit); cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease; }
.dql-home-primary-btn:hover { filter: brightness(1.06); box-shadow: 0 8px 22px rgba(37,99,235,0.26); transform: translateY(-1px); }
.dql-home-secondary-btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border-color, rgba(0,0,0,0.16)); border-radius: 9px; background: transparent; color: inherit; padding: 9px 14px; font: 700 13px var(--font-ui, inherit); cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dql-home-secondary-btn:hover { border-color: var(--color-accent-blue, #2563eb); }

.dql-home-progress-badge { display: inline-flex; align-items: center; gap: 12px; border: 1px solid; border-radius: 12px; padding: 12px 16px; flex: none; }
.dql-home-progress-badge > div { display: flex; flex-direction: column; }
.dql-home-progress-badge strong { font-size: 14px; }
.dql-home-progress-badge span { font-size: 12px; margin-top: 2px; }

.dql-home-stepper { display: grid; grid-template-columns: repeat(4, 1fr); }
.dql-home-node { position: relative; display: flex; flex-direction: column; align-items: center; gap: 9px; border: 0; cursor: pointer; padding: 8px 8px 10px; border-radius: 12px; transition: background 140ms ease; }
.dql-home-node-track { position: absolute; top: 30px; left: 50%; width: 100%; height: 3px; z-index: 0; border-radius: 2px; transition: background 500ms ease; }
.dql-home-node-badge { position: relative; z-index: 1; width: 46px; height: 46px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; border: 2px solid; transition: transform 200ms ease; }
.dql-home-node.is-ready .dql-home-node-badge { animation: dql-home-pop 380ms cubic-bezier(0.2,1.5,0.4,1) both; }
.dql-home-node.is-active .dql-home-node-badge { animation: dql-home-pulse 1.8s ease-in-out infinite; }
@keyframes dql-home-pop { 0% { transform: scale(0.5); } 60% { transform: scale(1.14); } 100% { transform: scale(1); } }
@keyframes dql-home-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,119,6,0.40); } 50% { box-shadow: 0 0 0 8px rgba(217,119,6,0); } }
.dql-home-node-meta { display: flex; flex-direction: column; align-items: center; gap: 3px; text-align: center; }
.dql-home-node-title { font: 750 12.5px var(--font-ui, inherit); }
.dql-home-node-status { font: 700 9.5px var(--font-mono, ui-monospace, monospace); text-transform: uppercase; letter-spacing: 0.05em; }

.dql-home-focus { display: flex; gap: 14px; border: 1px solid; border-radius: 12px; padding: 16px 18px; }
.dql-home-focus-icon { flex: none; width: 40px; height: 40px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; }
.dql-home-focus-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.dql-home-focus-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dql-home-focus-head h2 { margin: 0; font-size: 16px; font-weight: 780; }
.dql-home-focus-body p { margin: 0; font-size: 13px; line-height: 1.5; }
.dql-home-status { font: 700 9.5px var(--font-mono, ui-monospace, monospace); text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 9px; border-radius: 999px; }
.dql-home-evidence { display: flex; flex-wrap: wrap; gap: 6px; }
.dql-home-evidence span { font: 650 11px var(--font-mono, ui-monospace, monospace); border: 1px solid; border-radius: 999px; padding: 3px 9px; }
.dql-home-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.dql-home-card-btn { font-size: 12.5px; }

.dql-home-metrics { display: flex; flex-wrap: wrap; gap: 10px; }
.dql-home-metric { display: inline-flex; align-items: center; gap: 8px; border: 1px solid; border-radius: 10px; padding: 8px 13px; }
.dql-home-metric strong { font-size: 16px; font-weight: 800; }
.dql-home-metric span { font-size: 12px; }
.dql-home-metric-icon { display: inline-flex; }

.dql-home-details { border: 1px solid; border-radius: 12px; overflow: hidden; }
.dql-home-details > summary { list-style: none; cursor: pointer; padding: 13px 16px; display: flex; align-items: center; gap: 10px; font: 750 13px var(--font-ui, inherit); }
.dql-home-details > summary::-webkit-details-marker { display: none; }
.dql-home-details > summary::after { content: "\\2304"; margin-left: auto; font-size: 14px; transition: transform 200ms ease; }
.dql-home-details[open] > summary::after { transform: rotate(180deg); }
.dql-home-details-hint { font: 600 11.5px var(--font-ui, inherit); }
.dql-home-details-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 14px; }

.dql-home-context-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.dql-home-context-panel { display: flex; flex-direction: column; gap: 10px; border: 1px solid; border-radius: 10px; padding: 14px; }
.dql-home-context-head { display: flex; gap: 10px; align-items: flex-start; }
.dql-home-context-icon { flex: none; width: 34px; height: 34px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; }
.dql-home-context-head h2 { margin: 0; font-size: 13.5px; font-weight: 760; line-height: 1.25; }
.dql-home-context-head p { margin: 3px 0 0; font-size: 12px; line-height: 1.4; }
.dql-home-context-rows { display: flex; flex-direction: column; }
.dql-home-context-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid; font-size: 12.5px; }
.dql-home-context-row:last-child { border-bottom: 0; }
.dql-home-link-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--color-accent-blue, #2563eb); cursor: pointer; font: 750 12.5px var(--font-ui, inherit); padding: 2px 0; margin-top: auto; }
.dql-home-artifact-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.dql-home-artifact-row { display: flex; gap: 10px; align-items: baseline; border: 1px solid; border-radius: 8px; padding: 8px 11px; }
.dql-home-artifact-row code { font: 700 12px var(--font-mono, ui-monospace, monospace); flex: none; }
.dql-home-artifact-row span { font-size: 12px; line-height: 1.4; }

@media (max-width: 880px) {
  .dql-home-stepper { grid-template-columns: repeat(2, 1fr); }
  .dql-home-node-track { display: none; }
  .dql-home-context-grid, .dql-home-artifact-list { grid-template-columns: 1fr; }
  .dql-home-hero { flex-direction: column; align-items: flex-start; }
  .dql-home-focus { flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  .dql-home-fade,
  .dql-home-node.is-ready .dql-home-node-badge,
  .dql-home-node.is-active .dql-home-node-badge { animation: none !important; }
  .dql-home-node-track, .dql-home-primary-btn { transition: none; }
}
`;
