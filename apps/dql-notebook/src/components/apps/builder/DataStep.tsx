import { ArrowLeft, ArrowRight, Database, FileText, Plus, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../../api/client';
import { AddDataBrowser, RemoveDataButton, type AddDataBrowserProps } from './AddDataBrowser';
import { humanize } from './studio-ui';
import { appDataItems, openCanvasLabel, sourceOriginLabel, tilesUsingSource, trustLabel } from './app-data';
import {
  appStudioAiPickedHeading,
  appStudioBuildPagesLabel,
  appStudioCreatesTilesLabel,
  type AppStudioAiDataModel,
  type AppStudioAiPick,
} from '../app-studio-ai-plan';

/**
 * The AI mode of the Data step (design D3, AI path): the data an AI proposal
 * picked, shown before any page is built. Everything here comes from the
 * proposal already on the server; adding data re-plans with it required.
 */
export interface DataStepAiProps {
  /** `running` while a proposal is prepared (the first one or a re-plan). */
  status: 'running' | 'ready' | 'error';
  /** The App's goal (the frame goal, or the prompt while the first plan runs). */
  goal: string;
  /** Absent until the first proposal arrives. */
  model?: AppStudioAiDataModel;
  /** The activity steps (app-studio-ai-activity.ts) and the current one. */
  activitySteps: readonly string[];
  activityIndex: number;
  activityError?: string;
  plannerLabel?: string;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
  busy: boolean;
  /** The picked sources, so the Add data browser marks them Added. */
  pickedSources: AppStudioBuildDraft['sources'];
  onRemovePick: (sourceId: string) => void;
  onAddBack: (sourceId: string, reviewRequired: boolean) => void;
  onGenerateGap: (requirementId: string) => void;
  onAnswer: (questionId: string, answerId: string) => void;
  onRevise: () => void;
  onRetry: () => void;
  /** Close a failed re-plan and keep the picks already shown. */
  onDismissActivityError?: () => void;
  onBuildPages: () => void;
  onDiscard: () => void;
}

export const AI_DATA_STEP_INTRO = 'Check the data before AI builds pages. Remove anything you don’t trust.';

/**
 * The Data step (design D3): an App picks its data before the canvas opens,
 * like a Tableau data source page. Left: the App's data (its draft sources),
 * or in AI mode the sources AI picked. Right: the Add data browser. Nothing
 * new is stored beyond the draft's sources.
 */
export function DataStep({
  draft,
  known,
  error,
  onBack,
  onDismissError,
  onOpenCanvas,
  onSkip,
  browser,
  ai,
}: {
  draft: AppStudioBuildDraft;
  /** Catalog records already seen, so each row can show its domain and owner. */
  known: AppBlockRecommendation[];
  error?: string | null;
  onBack: () => void;
  onDismissError?: () => void;
  onOpenCanvas: () => void;
  onSkip: () => void;
  browser: Omit<AddDataBrowserProps, 'draft' | 'sourcePolicy' | 'draftId'>;
  /** AI mode: the data an AI proposal picked. */
  ai?: DataStepAiProps;
}): JSX.Element {
  if (ai) return <AiDataStep draft={draft} error={error} onBack={onBack} onDismissError={onDismissError} browser={browser} ai={ai} />;
  const items = appDataItems(draft.sources, known);
  return <section className="studio-data-step" aria-labelledby="studio-data-step-title">
    <header className="data-step-header">
      <button type="button" className="ghost-icon" onClick={onBack} aria-label="Back to Apps" title="Back to Apps"><ArrowLeft size={16} /></button>
      <div>
        <small>{draft.name}</small>
        <h1 id="studio-data-step-title">Data for this App</h1>
        <p>Pick the data this App will use. You can add more later from the Data panel.</p>
      </div>
    </header>
    {error ? <div className="studio-error" role="alert">{error}{onDismissError ? <button type="button" onClick={onDismissError} aria-label="Dismiss">×</button> : null}</div> : null}
    <div className="data-step-body">
      <aside className="data-step-list" aria-labelledby="data-step-list-title">
        <div className="data-step-list-head"><h2 id="data-step-list-title">This App's data</h2><small>{items.length} {items.length === 1 ? 'source' : 'sources'}</small></div>
        {items.length ? <ul>
          {items.map((item) => {
            const certified = item.trust ? item.trust === 'certified' : item.status === 'certified';
            const sourceId = item.sourceId ?? item.id;
            return <li key={sourceId}>
              <span className={`add-data-mark ${certified ? 'certified' : 'review'}`}>{certified ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
              <p><strong title={item.name}>{humanize(item.name)}</strong><small>{[sourceOriginLabel(item), trustLabel(certified ? 'certified' : 'review'), item.domain && item.domain !== 'Unassigned' ? humanize(item.domain) : ''].filter(Boolean).join(' · ')}</small></p>
              <RemoveDataButton name={humanize(item.name)} tileCount={tilesUsingSource(draft, sourceId).length} disabled={browser.disabled} onRemove={() => browser.onRemove(sourceId)} />
            </li>;
          })}
        </ul> : <div className="data-step-empty"><Database size={18} aria-hidden="true" /><p><strong>No data yet</strong><small>Add a table, a saved query or Metrics from the list. Everything you add has fields.</small></p></div>}
      </aside>
      <div className="data-step-browser">
        <AddDataBrowser {...browser} draftId={draft.id} draft={draft} sourcePolicy={draft.sourcePolicy} />
      </div>
    </div>
    <footer className="data-step-footer">
      <button type="button" onClick={onSkip}>Skip, start empty</button>
      <button type="button" className="primary" onClick={onOpenCanvas}>{openCanvasLabel(items.length)} <ArrowRight size={14} /></button>
    </footer>
  </section>;
}

function AiDataStep({
  draft,
  error,
  onBack,
  onDismissError,
  browser,
  ai,
}: {
  draft: AppStudioBuildDraft;
  error?: string | null;
  onBack: () => void;
  onDismissError?: () => void;
  browser: Omit<AddDataBrowserProps, 'draft' | 'sourcePolicy' | 'draftId'>;
  ai: DataStepAiProps;
}): JSX.Element {
  const model = ai.model;
  const running = ai.status === 'running';
  const locked = ai.busy || running;
  const reviewAllowed = ai.sourcePolicy === 'include_review_required';
  const pickRow = (pick: AppStudioAiPick, picked: boolean) => {
    const blockedByPolicy = !pick.certified && !reviewAllowed;
    return <li key={pick.id} className={picked ? 'ai-pick' : 'ai-suggestion'}>
      <span className={`add-data-mark ${pick.certified ? 'certified' : 'review'}`}>{pick.certified ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
      <p>
        <strong title={pick.label}>{pick.label}</strong>
        <small>{pick.meta}</small>
        <small className="data-step-tiles">{appStudioCreatesTilesLabel(pick.tileTitles.length)}</small>
        {pick.rationale ? <small className="data-step-why">Why: {pick.rationale}</small> : null}
      </p>
      {picked
        ? <button type="button" className="remove" disabled={locked} onClick={() => ai.onRemovePick(pick.id)} aria-label={`Remove ${pick.label} from the AI picks`}><X size={12} /> Remove</button>
        : <button type="button" className="remove" disabled={locked} onClick={() => ai.onAddBack(pick.id, blockedByPolicy)} aria-label={`${blockedByPolicy ? 'Allow data that needs review and add back' : 'Add back'} ${pick.label}`}><Plus size={12} /> {blockedByPolicy ? 'Allow data that needs review & add' : 'Add back'}</button>}
    </li>;
  };
  const activityLabel = ai.activitySteps[ai.activityIndex] ?? ai.activitySteps[0] ?? '';
  return <section className="studio-data-step ai-data-step" aria-labelledby="studio-data-step-title" aria-busy={running}>
    <header className="data-step-header">
      <button type="button" className="ghost-icon" onClick={onBack} aria-label="Back to Apps" title="Back to Apps"><ArrowLeft size={16} /></button>
      <div>
        <small>{draft.name}</small>
        <h1 id="studio-data-step-title">{model ? appStudioAiPickedHeading(model.picked.length) : 'AI is picking data'}</h1>
        <p className="data-step-goal">For: <strong>{ai.goal}</strong></p>
        <p>{AI_DATA_STEP_INTRO}</p>
        {ai.plannerLabel ? <small className="data-step-provenance">{ai.plannerLabel}</small> : null}
      </div>
    </header>
    {error ? <div className="studio-error" role="alert">{error}{onDismissError ? <button type="button" onClick={onDismissError} aria-label="Dismiss">×</button> : null}</div> : null}
    {running ? <div className="data-step-activity" role="status" aria-live="polite">
      <span className="loading-mark"><Sparkles size={15} /></span>
      <div>
        <strong>{model ? 'Updating the plan with your data' : 'Preparing the plan'}</strong>
        <ol aria-label="AI activity">{ai.activitySteps.map((step, index) => <li key={step} className={index === ai.activityIndex ? 'on' : index < ai.activityIndex ? 'done' : ''} aria-current={index === ai.activityIndex ? 'step' : undefined}>{step}</li>)}</ol>
        <small className="studio-ai-activity-label">{activityLabel}</small>
      </div>
    </div> : null}
    {ai.status === 'error' ? <div className="data-step-activity error" role="alert">
      <div>
        <strong>The AI proposal needs another try</strong>
        <small>{ai.activityError ?? 'App Studio could not prepare the proposal.'}</small>
        <span className="data-step-activity-actions">
          {model && ai.onDismissActivityError ? <button type="button" onClick={ai.onDismissActivityError}>Keep current picks</button> : null}
          <button type="button" className="primary" onClick={ai.onRetry}>Try AI proposal again</button>
        </span>
      </div>
    </div> : null}
    <div className="data-step-body">
      <aside className="data-step-list" aria-labelledby="data-step-list-title">
        <div className="data-step-list-head"><h2 id="data-step-list-title">AI picks</h2><small>{model ? `${model.picked.length} ${model.picked.length === 1 ? 'source' : 'sources'}` : 'Looking…'}</small></div>
        {!model ? <ul className="data-step-skeleton" aria-hidden="true">{[0, 1, 2].map((index) => <li key={index}><span className="add-data-mark" /><p><strong>&nbsp;</strong><small>&nbsp;</small></p></li>)}</ul> : <>
          {model.picked.length ? <ul aria-label="AI picks">{model.picked.map((pick) => pickRow(pick, true))}</ul>
            : <div className="data-step-empty"><Database size={18} aria-hidden="true" /><p><strong>No data picked</strong><small>Add back an AI suggestion, or add data from the list.</small></p></div>}
          {model.suggestions.length ? <section className="data-step-group" aria-labelledby="data-step-suggestions">
            <h3 id="data-step-suggestions">AI suggestions</h3>
            <p>Data you removed stays here.</p>
            <ul aria-label="AI suggestions">{model.suggestions.map((pick) => pickRow(pick, false))}</ul>
          </section> : null}
          {model.warnings.length ? <section className="data-step-group data-step-notes" aria-labelledby="data-step-notes">
            <h3 id="data-step-notes">Notes from AI</h3>
            <ul aria-label="AI planner notes">{model.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
          </section> : null}
          {model.uncovered.length ? <section className="studio-ai-questions" aria-label="Not covered yet">
            <header><strong>Not covered yet</strong><small>{model.uncovered.length} {model.uncovered.length === 1 ? 'gap' : 'gaps'}</small></header>
            {model.uncovered.map((requirement) => <div key={requirement.id}><p>{requirement.question}</p><button type="button" onClick={() => ai.onGenerateGap(requirement.id)} disabled={locked || !reviewAllowed}>{reviewAllowed ? 'Generate draft DQL that needs review' : 'Allow data that needs review to generate'}</button></div>)}
          </section> : null}
          {model.clarifications.length ? <section className="studio-ai-questions" aria-label="AI needs one more decision">
            <header><strong>AI needs one more decision</strong><small>{model.clarifications.length} required</small></header>
            {model.clarifications.map((item) => <fieldset key={item.id}><legend>{item.question}</legend>{item.choices.map((choice) => <button key={choice.id} type="button" onClick={() => ai.onAnswer(item.id, choice.id)} disabled={locked}><strong>{choice.label}</strong>{choice.description ? <small>{choice.description}</small> : null}</button>)}</fieldset>)}
            <button type="button" onClick={ai.onRevise} disabled={locked}>{running ? 'Updating…' : 'Re-run proposal'}</button>
          </section> : null}
        </>}
      </aside>
      <div className="data-step-browser">
        <AddDataBrowser {...browser} disabled={browser.disabled || locked || !model} draftId={draft.id} draft={{ sources: ai.pickedSources, pages: [] }} sourcePolicy={ai.sourcePolicy} />
      </div>
    </div>
    <footer className="data-step-footer">
      <button type="button" onClick={ai.onDiscard} disabled={running}>Discard</button>
      <button
        type="button"
        className="primary"
        onClick={ai.onBuildPages}
        disabled={locked || !model || model.picked.length === 0 || model.clarifications.length > 0}
      ><Sparkles size={14} /> {appStudioBuildPagesLabel(model?.picked.length ?? 0)} <ArrowRight size={14} /></button>
    </footer>
  </section>;
}
