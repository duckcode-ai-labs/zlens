import type { AppStudioAiProposal, ProviderSettings } from '../../api/client';
import { APP_STUDIO_AI_ACTIVITY_LABELS } from './app-studio-ai-activity';

/**
 * Honest when no AI is connected (design D4).
 *
 * App Studio has two planners behind the same buttons: a connected AI provider,
 * and the built-in keyword matcher the server uses when none is configured
 * (its proposals carry `plannerProvenance.mode: 'deterministic'`). Everything
 * the author reads about a plan says which one made it: "AI picked 3 sources"
 * only when an AI did, "Suggested from keywords · no AI connected" otherwise.
 *
 * One rule for every entry point: what the keyword matcher can do (describe an
 * App, suggest tiles for a page, revise) is offered as keyword suggestions with
 * the same label; what only an AI can do (change one tile, design a layout) says
 * "Connect an AI provider" instead. Pure: no React, no fetches.
 */

export type AppStudioPlannerVoice = 'ai' | 'keywords';

export const KEYWORD_SUGGESTIONS_LABEL = 'Suggested from keywords · no AI connected';
export const CONNECT_AI_TO_DESCRIBE = 'Connect an AI provider to describe an App';
export const CONNECT_AI_ACTION = 'Connect an AI provider';
export const TRY_KEYWORD_SUGGESTIONS = 'Try keyword suggestions';

/**
 * Whether an AI provider is connected, from `GET /api/settings/providers`.
 * The server's own answer (`assistAvailable`, which also counts a host's model)
 * wins; older servers only list providers, and then a provider that is enabled
 * and configured counts, the same rule the server uses to pick one.
 */
export function appStudioAiConnected(settings: {
  providers?: readonly Pick<ProviderSettings, 'enabled' | 'configured'>[];
  assistAvailable?: boolean;
} | null | undefined): boolean {
  if (!settings) return false;
  if (typeof settings.assistAvailable === 'boolean') return settings.assistAvailable;
  return (settings.providers ?? []).some((provider) => provider.enabled && provider.configured);
}

/**
 * The tab the Build new App form opens on: Describe with AI only when an AI
 * provider is connected. Until the settings answer (`undefined`) it opens on
 * Start manually, so a person with no AI never lands on an AI form first.
 */
export function appStudioDefaultLaunchMode(aiConnected: boolean | undefined): 'ai' | 'manual' {
  return aiConnected === true ? 'ai' : 'manual';
}

/**
 * Who made (or will make) a plan. A proposal's server-issued provenance is the
 * truth; before one exists, the provider settings decide. A proposal stored
 * before provenance existed keeps the AI words, as before.
 */
export function appStudioPlannerVoice(
  proposal: Pick<AppStudioAiProposal, 'plannerProvenance'> | null | undefined,
  aiConnected: boolean | undefined,
): AppStudioPlannerVoice {
  const mode = proposal?.plannerProvenance?.mode;
  if (mode === 'deterministic') return 'keywords';
  if (mode === 'ai') return 'ai';
  return aiConnected === false ? 'keywords' : 'ai';
}

export const APP_STUDIO_KEYWORD_ACTIVITY_LABELS = [
  'Reading the words in your request',
  'Matching them to certified tables, Metrics and saved queries',
  'Checking trust and capabilities',
  'Preparing source review',
] as const;

/** The words App Studio uses for a plan, by who made it. */
export interface AppStudioPlannerWords {
  /** The Data step heading once the plan is in. */
  pickedHeading: (count: number) => string;
  /** The Data step heading while the plan runs. */
  pendingHeading: string;
  intro: string;
  /** The list of picked sources and its aria label. */
  picksTitle: string;
  /** Picks the author removed. */
  removedTitle: string;
  notesTitle: string;
  notesLabel: string;
  activityLabel: string;
  activitySteps: readonly string[];
  errorTitle: string;
  retryLabel: string;
  /** "Remove X from the AI picks". */
  removeFrom: string;
  emptyPicksHint: string;
  /** The tile review on the canvas. */
  reviewEyebrow: string;
  reviewPaneLabel: string;
  understood: string;
  discardLabel: string;
  bannerLabel: string;
  /** A source picked only as context, with no tile. */
  contextOnly: string;
}

export function appStudioPlannerWords(voice: AppStudioPlannerVoice): AppStudioPlannerWords {
  if (voice === 'keywords') {
    return {
      pickedHeading: () => KEYWORD_SUGGESTIONS_LABEL,
      pendingHeading: 'Matching your words to your data',
      intro: 'These sources match words in your request. No AI chose them, so check each one and remove anything that doesn’t fit.',
      picksTitle: 'Keyword suggestions',
      removedTitle: 'Removed suggestions',
      notesTitle: 'Notes',
      notesLabel: 'Keyword suggestion notes',
      activityLabel: 'Keyword matching',
      activitySteps: APP_STUDIO_KEYWORD_ACTIVITY_LABELS,
      errorTitle: 'The keyword suggestions need another try',
      retryLabel: 'Try keyword suggestions again',
      removeFrom: 'the keyword suggestions',
      emptyPicksHint: 'Add back a removed suggestion, or add data from the list.',
      reviewEyebrow: 'KEYWORD SUGGESTIONS',
      reviewPaneLabel: 'Keyword suggestions',
      understood: 'Matched on',
      discardLabel: 'Discard keyword suggestions',
      bannerLabel: 'Keyword suggestions',
      contextOnly: 'Matched, but no tile uses it.',
    };
  }
  return {
    pickedHeading: (count) => `AI picked ${count} ${count === 1 ? 'source' : 'sources'}`,
    pendingHeading: 'AI is picking data',
    intro: 'Check the data before AI builds pages. Remove anything you don’t trust.',
    picksTitle: 'AI picks',
    removedTitle: 'AI suggestions',
    notesTitle: 'Notes from AI',
    notesLabel: 'AI planner notes',
    activityLabel: 'AI activity',
    activitySteps: APP_STUDIO_AI_ACTIVITY_LABELS,
    errorTitle: 'The AI proposal needs another try',
    retryLabel: 'Try AI proposal again',
    removeFrom: 'the AI picks',
    emptyPicksHint: 'Add back an AI suggestion, or add data from the list.',
    reviewEyebrow: 'AI PROPOSAL',
    reviewPaneLabel: 'AI proposal',
    understood: 'AI understood',
    discardLabel: 'Discard AI proposal',
    bannerLabel: 'AI proposal',
    contextOnly: 'AI will use this data as context.',
  };
}

/** The words on the Studio's entry points that ask for a plan. */
export interface AppStudioAskWords {
  /** The toolbar button and the side panel's name. */
  toolbar: string;
  panelTitle: string;
  /** The page tab's submit button. */
  proposeAdditions: string;
  proposePage: string;
  /** The empty page and App settings shortcuts. */
  draftPage: string;
  buildOrRevise: string;
  /** The publish review's action for an unanswered question. */
  revise: string;
  /** The page tab's help line. */
  pageHelp: (governedOnly: boolean) => string;
}

export function appStudioAskWords(voice: AppStudioPlannerVoice): AppStudioAskWords {
  if (voice === 'keywords') {
    return {
      toolbar: 'Suggest tiles',
      panelTitle: 'Suggestions',
      proposeAdditions: 'Suggest from keywords',
      proposePage: 'Suggest a new page from keywords',
      draftPage: 'Suggest tiles from keywords',
      buildOrRevise: 'Suggest tiles from keywords',
      revise: 'Suggest from keywords',
      pageHelp: (governedOnly) => `No AI provider is connected, so suggestions match the words you type to ${governedOnly ? 'certified tables, Metrics and saved queries' : 'Tables, Metrics and saved queries, including data that needs review'}. New tiles are added below what is already here, and you keep or skip each one before anything changes.`,
    };
  }
  return {
    toolbar: 'Ask AI',
    panelTitle: 'AI',
    proposeAdditions: 'Propose additions',
    proposePage: 'Propose a new page',
    draftPage: 'Draft with AI',
    buildOrRevise: 'Ask AI to build or revise this page',
    revise: 'Revise with AI',
    pageHelp: (governedOnly) => `${governedOnly ? 'AI plans tiles from certified tables, Metrics and saved queries only.' : 'AI plans tiles from tables, Metrics and saved queries, including data that needs review.'} New tiles are added below what is already here, and you keep or skip each one before anything changes.`,
  };
}
