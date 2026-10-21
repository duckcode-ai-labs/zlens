import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppStudioAiProposal } from '../../api/client';
import type * as AppStudioV2Module from './AppStudioV2';
import {
  appStudioAiConnected,
  appStudioAskWords,
  appStudioDefaultLaunchMode,
  appStudioPlannerVoice,
  appStudioPlannerWords,
  KEYWORD_SUGGESTIONS_LABEL,
} from './app-studio-ai-voice';
import { appStudioAiDataModel, appStudioPickedDraftSources, summarizeAppStudioAiPlan } from './app-studio-ai-plan';
import { localPublicationSteps, publicationBlockerCount, unresolvedPublicationRequirements } from './app-studio-publish-readiness';
import { aiProposal, draftWith, marginMetrics, orderLinesDataset } from './builder/app-data.fixtures';
import { DataStep, type DataStepAiProps } from './builder/DataStep';

/**
 * Honest when no AI is connected (design D4): Start manually by default, keyword
 * suggestions labelled as such everywhere, their gaps notes and never publish
 * blockers, and a revise that never counts the page's own tiles as new.
 */

let studio: typeof AppStudioV2Module;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  studio = await import('./AppStudioV2');
});

const AI_PROPOSAL: AppStudioAiProposal = {
  ...aiProposal(),
  plannerProvenance: { version: 1, mode: 'ai', providerInvocation: 'succeeded', providerId: 'anthropic' },
};

describe('whether an AI provider is connected', () => {
  it('trusts the server answer, else an enabled and configured provider', () => {
    expect(appStudioAiConnected({ providers: [], assistAvailable: true })).toBe(true);
    expect(appStudioAiConnected({ providers: [{ enabled: true, configured: true }], assistAvailable: false })).toBe(false);
    expect(appStudioAiConnected({ providers: [{ enabled: true, configured: true }] })).toBe(true);
    expect(appStudioAiConnected({ providers: [{ enabled: false, configured: true }, { enabled: true, configured: false }] })).toBe(false);
    expect(appStudioAiConnected(null)).toBe(false);
  });

  it('opens Build new App on Start manually unless AI is connected', () => {
    expect(appStudioDefaultLaunchMode(true)).toBe('ai');
    expect(appStudioDefaultLaunchMode(false)).toBe('manual');
    expect(appStudioDefaultLaunchMode(undefined)).toBe('manual');
  });

  it('takes the plan voice from the proposal first, then the settings', () => {
    expect(appStudioPlannerVoice(aiProposal(), true)).toBe('keywords');
    expect(appStudioPlannerVoice(AI_PROPOSAL, false)).toBe('ai');
    expect(appStudioPlannerVoice(null, false)).toBe('keywords');
    expect(appStudioPlannerVoice(null, undefined)).toBe('ai');
    expect(appStudioPlannerVoice({}, true)).toBe('ai');
  });

  it('never says AI picked in the keyword voice, and keeps the AI words with a provider', () => {
    const keywords = appStudioPlannerWords('keywords');
    expect(keywords.pickedHeading(3)).toBe('Suggested from keywords · no AI connected');
    expect(JSON.stringify({ ...keywords, pickedHeading: keywords.pickedHeading(3) })).not.toMatch(/AI picked|from AI|AI proposal|AI PROPOSAL/);
    expect(appStudioPlannerWords('ai').pickedHeading(3)).toBe('AI picked 3 sources');
    expect(appStudioAskWords('keywords').revise).toBe('Suggest from keywords');
    expect(appStudioAskWords('ai').revise).toBe('Revise with AI');
  });
});

describe('Build new App form without AI', () => {
  const launch = (config: Partial<AppStudioV2Module.AppStudioLaunchConfig>, aiConnected?: boolean) => {
    const AppStudioLaunchSurface = studio.AppStudioLaunchSurface;
    return renderToStaticMarkup(<AppStudioLaunchSurface
      config={{ mode: 'ai', prompt: '', name: 'Untitled Analytics App', template: 'operational_dashboard', sourcePolicy: 'governed_only', ...config }}
      aiConnected={aiConnected}
      onConnectAi={vi.fn()}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
    />);
  };

  it('asks to connect a provider on the AI tab, with keyword suggestions second', () => {
    const markup = launch({ mode: 'ai' }, false);
    expect(markup).toContain('Connect an AI provider to describe an App');
    expect(markup).toContain('>Connect an AI provider</button>');
    expect(markup).toContain('>Try keyword suggestions</button>');
    expect(markup).not.toContain('Generate editable App');
    expect(markup).not.toContain('AI picks your certified data');
  });

  it('labels keyword suggestions once chosen', () => {
    const markup = launch({ mode: 'ai', keywordSuggestions: true, prompt: 'Revenue' }, false);
    expect(markup).toContain(KEYWORD_SUGGESTIONS_LABEL);
    expect(markup).toContain('Suggest from keywords');
    expect(markup).toContain('What decision should this App support?');
    expect(markup).not.toContain('Generate editable App');
    expect(markup).not.toContain('AI picks your certified data');
  });

  it('is unchanged with a provider', () => {
    const markup = launch({ mode: 'ai' }, true);
    expect(markup).toContain('AI picks your certified data and drafts a first version');
    expect(markup).toContain('Generate editable App');
    expect(markup).not.toContain('Connect an AI provider');
  });

  it('opens on Start manually by default without AI', () => {
    const markup = launch({ mode: appStudioDefaultLaunchMode(false), template: 'blank' }, false);
    expect(markup).toMatch(/aria-selected="true" class="on"><svg[^]*?Start manually/);
    expect(markup).toContain('What should this App be called?');
  });
});

describe('AI Data step with keyword suggestions', () => {
  function aiProps(proposal: AppStudioAiProposal, overrides: Partial<DataStepAiProps> = {}): DataStepAiProps {
    const summary = summarizeAppStudioAiPlan(proposal);
    const picks = new Set(proposal.defaultSelectedSourceIds);
    const voice = appStudioPlannerVoice(proposal, false);
    return {
      status: 'ready', goal: summary.frame!.goal,
      model: appStudioAiDataModel(proposal, summary, picks, [orderLinesDataset, marginMetrics]),
      activitySteps: appStudioPlannerWords(voice).activitySteps, activityIndex: 0,
      voice, onConnectAi: vi.fn(),
      sourcePolicy: 'governed_only', busy: false,
      pickedSources: appStudioPickedDraftSources(proposal, picks),
      onRemovePick: vi.fn(), onAddBack: vi.fn(), onGenerateGap: vi.fn(), onAnswer: vi.fn(), onRevise: vi.fn(), onRetry: vi.fn(), onBuildPages: vi.fn(), onDiscard: vi.fn(),
      ...overrides,
    };
  }
  const render = (ai: DataStepAiProps) => renderToStaticMarkup(<DataStep draft={draftWith()} known={[]} onBack={vi.fn()} onOpenCanvas={vi.fn()} onSkip={vi.fn()} browser={{ disabled: false } as never} ai={ai} />);

  it('says Suggested from keywords, never AI picked, and notes the gaps', () => {
    const markup = render(aiProps(aiProposal()));
    expect(markup).toContain('Suggested from keywords · no AI connected');
    expect(markup).not.toContain('AI picked');
    expect(markup).not.toContain('Notes from AI');
    expect(markup).toContain('aria-label="Keyword suggestions"');
    expect(markup).toContain('>Notes</h3>');
    expect(markup).toContain('Not covered yet');
    expect(markup).toContain('They are notes, not publish blockers');
    expect(markup).toContain('>Connect an AI provider</button>');
  });

  it('labels the activity steps while the keyword matcher runs', () => {
    const markup = render(aiProps(aiProposal(), { status: 'running', model: undefined }));
    expect(markup).toContain('Matching your words to your data');
    expect(markup).toContain('Reading the words in your request');
    expect(markup).not.toContain('AI is picking data');
  });

  it('keeps "AI picked" when an AI made the plan', () => {
    const markup = render(aiProps(AI_PROPOSAL, { voice: 'ai', plannerLabel: 'AI planner response · anthropic' }));
    expect(markup).toContain('AI picked 2 sources');
    expect(markup).not.toContain(KEYWORD_SUGGESTIONS_LABEL);
  });
});

describe('canvas tile review with keyword suggestions', () => {
  const review = (proposal: AppStudioAiProposal, voice: 'ai' | 'keywords') => {
    const AiPlanReview = studio.AiPlanReview;
    return renderToStaticMarkup(<AiPlanReview
      proposal={proposal} summary={summarizeAppStudioAiPlan(proposal)} sourcePolicy="governed_only"
      selectedSourceIds={new Set(proposal.defaultSelectedSourceIds)} busy={false} voice={voice}
      onApply={vi.fn()} onDismiss={vi.fn()} onToggleTile={vi.fn()} onRevise={vi.fn()} onAnswerClarification={vi.fn()} onGenerateGap={vi.fn()}
    />);
  };

  it('labels the review, its notes and gaps as keyword suggestions', () => {
    const markup = review(aiProposal(), 'keywords');
    expect(markup).toContain('KEYWORD SUGGESTIONS');
    expect(markup).toContain('Matched on: <strong>');
    expect(markup).toContain('Suggested from keywords · no AI connected');
    expect(markup).toContain('aria-label="Discard keyword suggestions"');
    expect(markup).toContain('aria-label="Keyword suggestion notes"');
    expect(markup).toContain('They are notes, not publish blockers.');
    expect(markup).not.toMatch(/AI PROPOSAL|AI understood|AI planner notes/);
  });

  it('is unchanged with an AI plan', () => {
    const markup = review(AI_PROPOSAL, 'ai');
    expect(markup).toContain('AI PROPOSAL');
    expect(markup).toContain('AI understood: <strong>');
  });
});

describe('keyword gaps never block publishing', () => {
  type Requirement = { id: string; question: string; role: 'kpi'; required: boolean; measures: string[]; dimensions: string[]; filters: string[] };
  const keywordRequirement: Requirement = { id: 'requirement-2', question: 'Keep it short and clear', role: 'kpi', required: false, measures: [], dimensions: [], filters: [] };
  const realRequirement: Requirement = { ...keywordRequirement, id: 'margin', question: 'Gross margin', required: true, measures: ['margin'] };
  const draft = (requirements: Requirement[]) => ({
    ...draftWith(),
    authoringMode: 'ai',
    requirements,
    coverage: requirements.map((requirement) => ({ requirementId: requirement.id, status: 'gap', sourceIds: [], componentIds: [], reasons: [] })),
  }) as unknown as ReturnType<typeof draftWith>;

  it('does not count a keyword gap as a fix, and still counts a real one', () => {
    expect(unresolvedPublicationRequirements(draft([keywordRequirement]))).toEqual([]);
    expect(publicationBlockerCount(draft([keywordRequirement]))).toBe(0);
    expect(localPublicationSteps(draft([keywordRequirement])).map((step) => step.id)).not.toContain('questions');
    expect(unresolvedPublicationRequirements(draft([keywordRequirement, realRequirement])).map((item) => item.id)).toEqual(['margin']);
  });

  it('shows no "Unanswered App question" for it, and offers keyword suggestions for a real one without AI', () => {
    const PublishReadinessDialog = studio.PublishReadinessDialog;
    const render = (requirements: Requirement[]) => renderToStaticMarkup(<PublishReadinessDialog
      draft={draft(requirements)} serverIssues={[]} busy={false} previewRun={null} reviseLabel={appStudioAskWords('keywords').revise}
      onClose={vi.fn()} onRetry={vi.fn()} onRunPreview={vi.fn()} onRunAllPreviews={vi.fn()} onRemoveRequirement={vi.fn()} onReviseRequirement={vi.fn()}
      onAnswerQuestion={vi.fn()} onResolveTask={vi.fn()} onOpenSources={vi.fn()} onOpenFilters={vi.fn()} onRefreshSources={vi.fn()} onApproveSemantic={vi.fn()} onRemoveLocalAnalysis={vi.fn()}
    />);
    expect(render([keywordRequirement])).not.toContain('Unanswered App question');
    const real = render([keywordRequirement, realRequirement]);
    expect(real).toContain('Unanswered App question');
    expect(real).toContain('Gross margin');
    expect(real).not.toContain('Keep it short and clear');
    expect(real).toContain('Suggest from keywords');
    expect(real).not.toContain('Revise with AI');
  });
});

describe('revise never counts the page\'s own tiles as new', () => {
  it('lists only the tiles an add-mode proposal adds', () => {
    const base = aiProposal();
    const pageOp = base.operations.find((operation) => operation.type === 'upsert_page');
    if (pageOp?.type !== 'upsert_page') throw new Error('fixture has a page');
    const existing = { ...pageOp.page.layout.items[0]!, i: 'hand-made', title: 'Hand made' };
    const proposal: AppStudioAiProposal = {
      ...base,
      mode: 'add',
      proposedTileIds: ['margin-kpi'],
      operations: base.operations.map((operation) => operation.type === 'upsert_page'
        ? { ...operation, page: { ...operation.page, layout: { ...operation.page.layout, items: [existing, ...operation.page.layout.items.filter((item) => item.i === 'margin-kpi')] } } }
        : operation),
    };
    const summary = summarizeAppStudioAiPlan(proposal);
    expect(summary.components.map((component) => component.id)).toEqual(['margin-kpi']);
    const AiPlanReview = studio.AiPlanReview;
    const markup = renderToStaticMarkup(<AiPlanReview
      proposal={proposal} summary={summary} sourcePolicy="governed_only" selectedSourceIds={new Set(proposal.defaultSelectedSourceIds)} busy={false} changeCount={1}
      onApply={vi.fn()} onDismiss={vi.fn()} onToggleTile={vi.fn()} onRevise={vi.fn()} onAnswerClarification={vi.fn()} onGenerateGap={vi.fn()}
    />);
    expect(markup).toContain('1 tile to add');
    expect(markup).toContain('Apply 1 change');
    expect(markup).not.toContain('Hand made');
  });
});
