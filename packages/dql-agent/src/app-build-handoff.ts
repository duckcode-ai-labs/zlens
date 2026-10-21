import {
  appNameFromGoal,
  createAppBuildDraft,
  createBlankAppBuildPage,
  newAppBuildDraftId,
  suggestAppId,
  type AppBuildDraft,
  type AppBuildDraftSource,
  type AppBuildRequirement,
  type AppBuildRequirementCoverage,
  type AppBuildSourcePolicy,
} from '@zlens/core';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';

/**
 * One AI engine for Apps (design D9). An App that AI builds from Ask
 * (`app_build`) or from an MCP client (`build_dql_app`) becomes a local App
 * Studio draft, never App files: the data it picked becomes the App's data,
 * the questions it could not cover are listed as "Not covered yet", and App
 * Studio opens it at the AI Data step. Nothing reaches the project until the
 * author publishes through the publish checks.
 */

/** App Studio plans with at most this many required sources at once. */
export const APP_BUILD_HANDOFF_SOURCE_LIMIT = 12;

export interface AppBuildHandoffGap {
  question: string;
  reason?: string;
}

export interface AppBuildHandoffInput {
  /** The request, kept as the App's goal; App Studio plans pages from it. */
  goal: string;
  name?: string;
  domain?: string;
  audience?: string;
  /** The data AI picked. App Studio requires these when it plans pages. */
  sources: AppSourceCatalogRecord[];
  /** "Only certified data" unless review data was explicitly included. */
  sourcePolicy?: AppBuildSourcePolicy;
  /** Questions with no certified data yet, AI-written SQL included. */
  gaps?: AppBuildHandoffGap[];
}

/** A picked source in the App Studio words: Dataset, Metrics or Saved query; Certified or Needs review. */
export interface AppBuildHandoffSourceSummary {
  sourceId: string;
  title: string;
  kind: 'Dataset' | 'Metrics' | 'Saved query';
  trust: 'Certified' | 'Needs review';
  domain?: string;
  reason: string;
}

/** A Dataset has fields, Metrics come from a semantic model, a saved query is a plain block. */
export function appBuildHandoffSourceKind(source: Pick<AppSourceCatalogRecord, 'kind' | 'capabilities'>): AppBuildHandoffSourceSummary['kind'] {
  if (source.capabilities.dataset?.kind === 'semantic') return 'Metrics';
  if (source.capabilities.dataset) return 'Dataset';
  if (source.capabilities.semanticModelId || source.kind === 'semantic') return 'Metrics';
  return 'Saved query';
}

export function appBuildHandoffSourceSummary(source: AppSourceCatalogRecord, reason: string): AppBuildHandoffSourceSummary {
  return {
    sourceId: source.sourceId,
    title: source.title,
    kind: appBuildHandoffSourceKind(source),
    trust: source.trust === 'certified' ? 'Certified' : 'Needs review',
    ...(source.domain ? { domain: source.domain } : {}),
    reason,
  };
}

/** The App draft's record of one catalog source (the same shape App Studio stores). */
export function appDraftSourceFromCatalogRecord(source: AppSourceCatalogRecord): AppBuildDraftSource {
  const certified = source.trust === 'certified';
  return {
    id: source.sourceId,
    kind: source.kind === 'semantic' ? 'governed_semantic' : 'block',
    sourceRef: source.executionRef,
    qualifiedIdentity: source.qualifiedIdentity,
    sourcePath: source.sourcePath,
    executionRef: source.executionRef,
    snapshotId: source.snapshotId,
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceRevision,
    lifecycle: source.lifecycle,
    capabilities: source.capabilities,
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'not_required' : 'required',
  };
}

/**
 * Build the local App Studio draft for an AI build that started in Ask or an
 * MCP client. It has one empty page, the picked data as the App's data and
 * the uncovered questions as requirements with a gap. App Studio keeps both
 * when it plans pages, so the AI Data step shows the picks and lists the
 * gaps under "Not covered yet". The caller stores it.
 */
export function createAppBuildHandoffDraft(
  input: AppBuildHandoffInput,
  options: { id?: string; now?: string } = {},
): AppBuildDraft {
  const goal = input.goal.trim();
  if (!goal) throw new Error('An App build needs a description of what the App is for.');
  const name = (input.name?.trim() || appNameFromGoal(goal)).slice(0, 120);
  const sourcePolicy: AppBuildSourcePolicy = input.sourcePolicy ?? 'governed_only';
  const seen = new Set<string>();
  const sources = input.sources
    .filter((source) => {
      if (seen.has(source.sourceId)) return false;
      seen.add(source.sourceId);
      // "Only certified data" never carries data that needs review.
      return sourcePolicy === 'include_review_required' || source.trust === 'certified';
    })
    .slice(0, APP_BUILD_HANDOFF_SOURCE_LIMIT)
    .map(appDraftSourceFromCatalogRecord);
  const questions = new Set<string>();
  const gaps = (input.gaps ?? []).filter((gap) => {
    const key = gap.question.trim().toLowerCase();
    if (!key || questions.has(key)) return false;
    questions.add(key);
    return true;
  });
  const requirements: AppBuildRequirement[] = gaps.map((gap, index) => ({
    id: `not-covered-${index + 1}`,
    question: gap.question.trim().slice(0, 500),
    role: 'evidence',
    required: true,
    measures: [],
    dimensions: [],
    filters: [],
  }));
  const coverage: AppBuildRequirementCoverage[] = gaps.map((gap, index) => ({
    requirementId: `not-covered-${index + 1}`,
    status: 'gap',
    sourceIds: [],
    componentIds: [],
    reasons: [gap.reason?.trim() || 'No certified data covers this question yet.'],
  }));
  const audience = input.audience?.trim() || 'stakeholders';
  return createAppBuildDraft({
    id: options.id ?? newAppBuildDraftId(),
    appId: suggestAppId(name),
    name,
    authoringMode: 'ai',
    template: 'blank',
    sourcePolicy,
    frame: {
      goal,
      audience,
      metrics: [],
      dimensions: [],
      filters: [],
      desiredOutput: 'One responsive analytical page',
      clarificationQuestions: [],
    },
    requirements,
    coverage,
    sources,
    pages: [createBlankAppBuildPage({ name, goal, domain: input.domain, audience })],
    reviewTasks: [],
    ...(options.now ? { now: options.now } : {}),
  });
}

/** The notebook path that opens a draft in App Studio, e.g. `/?appDraft=build_…`. */
export function appStudioDraftPath(draftId: string): string {
  return `/?appDraft=${encodeURIComponent(draftId)}`;
}
