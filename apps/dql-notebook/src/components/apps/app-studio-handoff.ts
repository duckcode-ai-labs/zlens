import type { AppStudioBuildDraft } from '../../api/client';
import type { AppBuildBriefEdits } from './AppBuildProposalPanel';

/**
 * One AI engine for Apps (design D9): an App that AI builds in Ask or from an
 * MCP client arrives as a local App Studio draft and opens at the AI Data
 * step, the same state App Studio reaches after "Describe with AI". Pure: no
 * React, no I/O beyond the injected API call.
 */

/** App Studio plans with at most this many required sources at once. */
const AI_DATA_REQUIRED_SOURCE_LIMIT = 12;

/** Tiles a template places on a new page; they are not content the author built. */
const TEMPLATE_TILE_IDS = new Set(['template-introduction']);

/**
 * Draft sources recorded from the App source catalog (Datasets, Metrics and
 * saved queries). Only these carry catalog ids the planner can require.
 */
const PLANNABLE_SOURCE_KINDS = new Set<AppStudioBuildDraft['sources'][number]['kind']>([
  'block',
  'governed_semantic',
]);

export interface AppStudioAiDataResume {
  /** The App's goal, sent to the planner as the prompt. */
  prompt: string;
  /** The App's data, required so the planner proposes it. */
  requiredSourceIds: string[];
}

/**
 * An AI App draft that has no pages built yet opens at the AI Data step: the
 * draft Ask or an MCP client made, or a "Describe with AI" draft left before
 * its pages were built. Its data (picked by Ask or the MCP client) is
 * required, so the planner proposes it. Manual drafts, edits of a published
 * App and drafts with any content open on the canvas as before.
 */
export function appStudioAiDataResume(draft: AppStudioBuildDraft): AppStudioAiDataResume | null {
  if (draft.authoringMode !== 'ai' || draft.baseApp || draft.state === 'project_published') return null;
  const built = draft.pages.some((page) => page.layout.items.some((item) => !TEMPLATE_TILE_IDS.has(item.i)));
  if (built) return null;
  const prompt = draft.frame.goal.trim();
  if (!prompt) return null;
  return {
    prompt,
    requiredSourceIds: draft.sources
      .filter((source) => PLANNABLE_SOURCE_KINDS.has(source.kind))
      .map((source) => source.id)
      .slice(0, AI_DATA_REQUIRED_SOURCE_LIMIT),
  };
}

type OpenAppAiBuildInStudio = (sessionId: string, input: {
  selectedTileIds?: string[];
  expectedProposalHash?: string;
  appName?: string;
  audience?: string;
}) => Promise<{ ok: true; draft: Pick<AppStudioBuildDraft, 'id' | 'appId' | 'name'> } | { ok: false; error: string }>;

/**
 * "Open in App Studio" on an Ask App proposal: the server makes the App
 * Studio draft (no App files), then the notebook opens Apps on that draft,
 * where App Studio starts at the AI Data step.
 */
export async function openAppProposalInStudio(input: {
  sessionId: string;
  selectedTileIds: Iterable<string>;
  proposalHash?: string;
  edits: AppBuildBriefEdits;
  openInStudio: OpenAppAiBuildInStudio;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
}): Promise<{ ok: true; draftId: string; appId: string; name: string } | { ok: false; error: string }> {
  const result = await input.openInStudio(input.sessionId, {
    selectedTileIds: Array.from(input.selectedTileIds),
    ...(input.proposalHash ? { expectedProposalHash: input.proposalHash } : {}),
    ...(input.edits.appName ? { appName: input.edits.appName } : {}),
    ...(input.edits.audience ? { audience: input.edits.audience } : {}),
  });
  if (!result.ok) return result;
  input.onOpenApp?.(result.draft.appId, undefined, result.draft.id);
  return { ok: true, draftId: result.draft.id, appId: result.draft.appId, name: result.draft.name };
}
