import type {
  TileFilterOperator,
  AppBuildClarification,
  AppBuildFrame,
  AppBuildRequirement,
  AppBuildSourcePolicy,
  DatasetDescriptor,
  TileQuery,
} from '@zlens/core';
import {
  datasetMeasures,
  datasetPhysicalFields,
  normalizeTileQuery,
  tileQueryOutputAliases,
  tileQueryRunsWhateverTheRows,
  validateTileQuery,
} from '@zlens/core';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';
import { readPlannerJson } from './app-builder-planner-json.js';
import { readDashboardVizStyle, type DashboardVizStyle } from '@zlens/core';

export type AppBuilderComponentRole = AppBuildRequirement['role'];
export type AppBuilderComponentView = 'kpi' | 'line' | 'bar' | 'table';

export interface AppBuilderPlannedComponent {
  id: string;
  title: string;
  sourceId: string;
  /**
   * A Dataset component carries the exact approved field query that it will
   * author. This is intent only: source revision, snapshot, trust, contracts,
   * and SQL remain server-resolved authority at composition time.
   */
  query?: TileQuery;
  requirementIds: string[];
  role: AppBuilderComponentRole;
  view: AppBuilderComponentView;
  /** Optional chart styling, validated like a page file's `viz.style`. */
  style?: DashboardVizStyle;
  rationale: string;
}

/** A durable story page plan. Components remain identifier-bound elsewhere. */
export interface AppBuilderPlannedPage {
  id: string;
  title: string;
  componentIds: string[];
  sections: Array<{
    id: string;
    title: string;
    kind: 'exec_summary' | 'kpi_band' | 'insight' | 'appendix';
    componentIds: string[];
  }>;
}

/** A field-bound filter plan; source and tile bindings are compiled server-side. */
export interface AppBuilderPlannedFilter {
  id: string;
  label: string;
  field: string;
  scope: 'page' | 'app';
  pageId?: string;
  componentIds: string[];
}

export interface AppBuilderPlannedNavigation {
  fromComponentId: string;
  toPageId: string;
}

export interface AppBuilderPlannedCrossFilter {
  fromComponentId: string;
  fromField: string;
  toComponentId: string;
  toField: string;
}

export interface AppBuilderPlannedDetailDrill {
  pageId: string;
  componentId: string;
  fields: string[];
}

export interface AppBuilderBuildBrief {
  version: 1;
  planningMode: 'ai' | 'deterministic_fallback';
  /**
   * Bounded planner provenance for the dedicated initial App generator.
   * It deliberately records only how the brief was produced; it contains no
   * prompt, model output, result rows, credentials, or universal-run state.
   */
  plannerProvenance: AppBuilderPlannerProvenance;
  frame: AppBuildFrame;
  requirements: AppBuildRequirement[];
  components: AppBuilderPlannedComponent[];
  /** A story-oriented page graph compiled to local App draft pages. */
  pages: AppBuilderPlannedPage[];
  /** Explicit Dataset field controls. No field-name fallback is permitted. */
  filters: AppBuilderPlannedFilter[];
  navigation: AppBuilderPlannedNavigation[];
  crossFilters: AppBuilderPlannedCrossFilter[];
  detailDrills: AppBuilderPlannedDetailDrill[];
  selectedSourceIds: string[];
  candidateSourceIds: string[];
  warnings: string[];
}

export interface AppBuilderPlannerCompletionInput {
  system: string;
  user: string;
}

/** Server-owned outcome carried by the local provider adapter after a real
 * planner invocation succeeds. `providerId` is the selected local settings
 * id, not an untrusted provider response field. */
export interface AppBuilderPlannerCompletionResult {
  content: string;
  providerId?: string;
}

/**
 * Persisted evidence for the dedicated initial generator.  A configured
 * provider failure never turns into the deterministic mode: it rejects before
 * a proposal is created, so `not_attempted` means no planner was available.
 */
export interface AppBuilderPlannerProvenance {
  version: 1;
  mode: 'ai' | 'deterministic';
  providerInvocation: 'succeeded' | 'not_attempted';
  /** Present for the real local-provider adapter after its generate call. */
  providerId?: string;
}

export type AppBuilderPlannerCompletion = (
  input: AppBuilderPlannerCompletionInput,
) => Promise<string | AppBuilderPlannerCompletionResult | undefined>;

export interface PlanAppBuildBriefInput {
  prompt: string;
  candidates: AppSourceCatalogRecord[];
  /** Exact catalog source IDs that the caller explicitly requires in the brief. */
  requiredSourceIds: string[];
  sourcePolicy: AppBuildSourcePolicy;
  domain?: string;
  audience?: string;
  complete?: AppBuilderPlannerCompletion;
  /** How long planning may wait for the AI in all, in ms (default APP_BUILDER_PLANNER_BUDGET_MS). */
  timeBudgetMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/**
 * The longest Describe with AI waits for the AI's plan (V12: about 2 minutes of "Looking…", then a code). On
 * Cortex one plan takes 36-85 s, so this is one slow plan with room to spare, then a plain "took too long".
 */
export const APP_BUILDER_PLANNER_BUDGET_MS = 120_000;
/**
 * The AI is asked a second time only when its first reply came back within this time and the plan's time
 * allows it: on a slow provider a second ask doubles the wait (V12: 123-128 s for two asks, both unreadable).
 */
export const APP_BUILDER_RETRY_WITHIN_MS = 45_000;
const APP_BUILDER_RETRY_MIN_MS = 30_000;

class AppBuilderPlannerTimeout extends Error {}

/** A planner call that waits at most `limitMs`; past it, the reply is not waited for. */
async function withinPlannerTime<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppBuilderPlannerTimeout()), Math.max(0, limitMs));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * App-specific orchestration boundary. It shares a host provider adapter but
 * owns a structured, stateful build brief rather than invoking Ask AI's answer
 * state machine. One provider call is made, and one more only when the first
 * reply can't be read as a grounded brief (new-user test V8, item 4); it can
 * reference only the supplied candidate IDs.
 *
 * Acceptance: PRD-007, AGT-026.
 */
export async function planAppBuildBrief(input: PlanAppBuildBriefInput): Promise<AppBuilderBuildBrief> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('App build prompt is required.');
  const requiredSourceIds = Array.from(new Set(input.requiredSourceIds.map((id) => id.trim()).filter(Boolean)));
  if (requiredSourceIds.length > 12) {
    throw new Error('APP_BUILD_SOURCE_LIMIT: at most 12 required App sources can be planned at once.');
  }
  const suppliedById = new Map(input.candidates.map((candidate) => [candidate.sourceId, candidate]));
  const missingRequiredIds = requiredSourceIds.filter((sourceId) => !suppliedById.has(sourceId));
  if (missingRequiredIds.length) {
    throw new Error(`APP_BUILD_REQUIRED_SOURCE_MISSING: required sources were not supplied as candidate cards: ${missingRequiredIds.join(', ')}`);
  }
  const candidates = uniqueCandidates([
    ...requiredSourceIds.flatMap((sourceId) => {
      const candidate = suppliedById.get(sourceId);
      return candidate ? [candidate] : [];
    }),
    ...input.candidates,
  ]).slice(0, 12);
  if (!input.complete || candidates.length === 0) {
    return ensureAppBuildStructure(
      ensureRequiredSources(deterministicBrief(input, candidates), candidates, requiredSourceIds),
      candidates,
    );
  }

  const userPrompt = appBuilderUserPrompt(input, candidates);
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budgetMs = input.timeBudgetMs ?? APP_BUILDER_PLANNER_BUDGET_MS;
  const ask = async (retry: boolean, limitMs: number): Promise<string | AppBuilderPlannerCompletionResult | undefined> => {
    try {
      return await withinPlannerTime(input.complete!({
        system: appBuilderSystemPrompt(),
        user: retry ? `${userPrompt}\n\n${APP_BUILDER_RETRY_NOTE}` : userPrompt,
      }), limitMs);
    } catch (error) {
      if (error instanceof AppBuilderPlannerTimeout) {
        throw new Error(`APP_BUILD_PLANNER_TIMEOUT: the AI took longer than ${Math.round(budgetMs / 1000)} s to plan this App.`);
      }
      throw new Error(`APP_BUILD_PLANNER_PROVIDER_FAILED: the configured App Builder provider did not return a build brief. ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let completion = await ask(false, budgetMs);
  // A host hook that finds no configured provider declines with undefined.
  // That is "no planner configured", not a malformed answer: plan offline.
  if (completion === undefined) {
    return ensureAppBuildStructure(
      ensureRequiredSources(deterministicBrief(input, candidates), candidates, requiredSourceIds),
      candidates,
    );
  }
  let reply = readPlannerReply(completion);
  // A reply that can't be read as a grounded brief gets one more try, asking
  // for one compact JSON object (a long brief can be cut off at the token limit).
  // So does one cut off before any tile (V11 try 2: "AI picked 0 sources" after 64 s,
  // with the reply's requirements read but its components lost at the cut).
  const candidatesById = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
  const usableComponents = (read: ReturnType<typeof readPlannerReply>) => read.parsed ? normalizeComponents(
    read.parsed.components,
    candidatesById,
    new Set(read.requirements.map((requirement) => requirement.id)),
    new Map(read.requirements.map((requirement) => [requirement.id, requirement])),
  ).length : 0;
  const firstMs = now() - startedAt;
  const mayAskAgain = firstMs <= APP_BUILDER_RETRY_WITHIN_MS && budgetMs - firstMs >= APP_BUILDER_RETRY_MIN_MS;
  if (mayAskAgain && (!reply.parsed || reply.requirements.length === 0 || (reply.truncated && usableComponents(reply) === 0))) {
    // A second ask that runs out of time leaves the first reply as it was.
    const second = await ask(true, budgetMs - firstMs).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('APP_BUILD_PLANNER_TIMEOUT') && reply.parsed && reply.requirements.length > 0) return undefined;
      throw error;
    });
    if (second !== undefined) {
      const retried = readPlannerReply(second);
      // The second reply is kept unless it reads worse than the first.
      if ((retried.parsed && retried.requirements.length > 0) || !reply.parsed || reply.requirements.length === 0) {
        completion = second;
        reply = retried;
      }
    }
  }
  const { parsed, requirements, truncated } = reply;
  if (!parsed) {
    throw new Error('APP_BUILD_PLANNER_OUTPUT_INVALID: the configured App Builder provider did not return valid JSON for the build brief.');
  }
  if (requirements.length === 0) {
    throw new Error('APP_BUILD_PLANNER_OUTPUT_INVALID: the configured App Builder provider did not return grounded requirements.');
  }
  const providerId = typeof completion === 'string'
    ? undefined
    : appBuilderPlannerProviderId(completion?.providerId);
  const allowedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const plannedComponents = withoutRepeatedComponents(normalizeComponents(
    parsed.components,
    candidatesById,
    requirementIds,
    new Map(requirements.map((requirement) => [requirement.id, requirement])),
  ));
  // A plan cut short with no tile still has its questions: each gets the candidate whose fields answer it.
  const components = plannedComponents.length === 0 && truncated
    ? withoutRepeatedComponents(componentsForRequirements(requirements, candidates))
    : plannedComponents;
  const frame = normalizeFrame(parsed.frame, prompt, input.audience);
  // A part of the request the plan never mentions is a gap, not silently dropped (V11: "wins and losses"; losses never appeared).
  const unplanned = unplannedRequestParts(prompt, [
    ...requirements.flatMap((requirement) => [requirement.question, ...requirement.measures, ...requirement.dimensions, ...requirement.filters]),
    ...frame.metrics, ...frame.dimensions, ...frame.filters,
    ...components.map((component) => component.title),
  ]);
  const unplannedRequirements = unplanned.map((part, index): AppBuildRequirement => ({
    id: uniqueRequirementId(`asked-${index + 1}`, requirementIds),
    question: part.charAt(0).toUpperCase() + part.slice(1),
    role: 'evidence',
    required: true,
    measures: [],
    dimensions: [],
    filters: [],
  }));
  return ensureAppBuildStructure(ensureRequiredSources({
    version: 1,
    planningMode: 'ai',
    plannerProvenance: {
      version: 1,
      mode: 'ai',
      providerInvocation: 'succeeded',
      ...(providerId ? { providerId } : {}),
    },
    frame,
    requirements: [...requirements, ...unplannedRequirements],
    components,
    pages: normalizePlannedPages(parsed.pages, components),
    filters: [],
    navigation: [],
    crossFilters: [],
    detailDrills: [],
    selectedSourceIds: Array.from(new Set(components.map((component) => component.sourceId))),
    candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
    warnings: truncated ? [plannedComponents.length === 0 && components.length > 0 ? APP_BUILDER_TRUNCATED_PICKED_NOTE : APP_BUILDER_TRUNCATED_NOTE] : [],
  }, candidates, requiredSourceIds), candidates, parsed);
}

/** What a tile shows: its data, its query, and whether it is a table or a chart, whatever its title. */
function componentShowsKey(component: AppBuilderPlannedComponent): string {
  const query = component.query;
  const shape = component.view === 'table' || component.role === 'detail' || component.role === 'evidence' ? 'table' : 'chart';
  if (!query) return `${component.sourceId}\u0000as-is\u0000${shape}`;
  const sorted = <T>(items: T[] | undefined, key: (item: T) => string) => (items ?? []).map(key).sort();
  return JSON.stringify([
    component.sourceId,
    sorted(query.dimensions, (dimension) => `${dimension.field.toLowerCase()}:${dimension.timeGrain ?? ''}`),
    sorted(query.measures, (measure) => measure.measure.toLowerCase()),
    sorted(query.filters, (filter) => JSON.stringify([filter.field.toLowerCase(), filter.op, filter.values ?? []])),
    sorted(query.calculations, (calculation) => JSON.stringify(calculation)),
    query.detail === true,
    query.limit ?? null,
    shape,
  ]);
}

/**
 * One tile for each thing the plan shows (V12: the tester's App showed "Max POINTS PER GAME" beside "POINTS PER
 * GAME", the same numbers twice; a plan listed "Warriors Wins by Season" as a bar, a total and a table). A
 * repeat is dropped and the questions it answered move to the tile that stays.
 */
function withoutRepeatedComponents(components: AppBuilderPlannedComponent[]): AppBuilderPlannedComponent[] {
  const kept: AppBuilderPlannedComponent[] = [];
  const byKey = new Map<string, number>();
  for (const component of components) {
    const key = componentShowsKey(component);
    const index = byKey.get(key);
    if (index === undefined) {
      byKey.set(key, kept.length);
      kept.push(component);
      continue;
    }
    const first = kept[index]!;
    kept[index] = { ...first, requirementIds: Array.from(new Set([...first.requirementIds, ...component.requirementIds])) };
  }
  return kept;
}

function uniqueRequirementId(preferred: string, taken: Set<string>): string {
  let id = preferred;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${preferred}-${suffix}`;
  taken.add(id);
  return id;
}

/**
 * Tiles for a plan cut short before its components: for each question, the first candidate whose approved
 * fields answer it, with the field query that answers it. Questions no candidate answers stay gaps.
 */
function componentsForRequirements(requirements: AppBuildRequirement[], candidates: AppSourceCatalogRecord[]): AppBuilderPlannedComponent[] {
  const components: AppBuilderPlannedComponent[] = [];
  for (const [index, requirement] of requirements.entries()) {
    for (const candidate of candidates) {
      const descriptor = candidate.capabilities.dataset;
      if (!descriptor || !candidateSatisfiesStructuredRequirement(requirement, candidate)) continue;
      const planned = deterministicDatasetQuery(descriptor, requirement, requirement.role);
      if (!planned) continue;
      const { query, role } = withAskedSplits(planned, descriptor, requirement.role, [requirement.question], [requirement]);
      if (!datasetPlannedQueryCoversRequirement(query, requirement, descriptor)) continue;
      components.push({
        id: `component-${index + 1}`,
        title: requirement.question.replace(/[?.!]+$/, ''),
        sourceId: candidate.sourceId,
        query,
        requirementIds: [requirement.id],
        role,
        view: role === 'kpi' ? 'kpi' : role === 'trend' ? 'line' : role === 'detail' || role === 'evidence' ? 'table' : 'bar',
        rationale: `Its fields answer “${requirement.question}” · ${sourceKindAndTrust(candidate)}`,
      });
      break;
    }
  }
  return components;
}

/** Words that say how to show something, never what: a request part made only of them is not a question. */
const UNPLANNED_IGNORED_WORDS = new Set([
  'also', 'chart', 'compare', 'comparison', 'each', 'every', 'how', 'list', 'number', 'page', 'separate', 'separately',
  'show', 'shown', 'side', 'split', 'together', 'total', 'trend', 'what', 'which', 'who', 'see', 'help', 'did', 'does',
]);

/**
 * Parts of a request the plan never mentions. Only an item the request pairs with "and" or "or" with an
 * item the plan does cover counts ("regular-season wins and losses" when only wins are planned): a lone
 * phrasing like "shown separately" is never a question of its own.
 */
export function unplannedRequestParts(request: string, planned: string[]): string[] {
  const plannedWords = deterministicWords(planned.join(' '));
  const contentWords = (part: string) => Array.from(deterministicWords(part)).filter((word) => !/^\d+$/.test(word) && !UNPLANNED_IGNORED_WORDS.has(word) && !RATIONALE_IGNORED_WORDS.has(word));
  const out: string[] = [];
  for (const segment of request.split(/[.;:\n,!?]+/)) {
    const items = segment.split(/\s+(?:and|or|&)\s+/i).map((item) => item.trim()).filter(Boolean);
    if (items.length < 2) continue;
    const covered = items.filter((item) => contentWords(item).some((word) => plannedWords.has(word)));
    if (covered.length === 0) continue;
    for (const item of items) {
      const words = contentWords(item);
      if (words.length === 0 || words.length > 3 || words.some((word) => plannedWords.has(word))) continue;
      const part = item.replace(/^(?:the|a|an|their|its|and|or)\s+/i, '').trim();
      if (part && !out.some((existing) => existing.toLowerCase() === part.toLowerCase())) out.push(part);
    }
  }
  return out.slice(0, 3);
}

function ensureRequiredSources(
  brief: AppBuilderBuildBrief,
  candidates: AppSourceCatalogRecord[],
  requiredSourceIds: string[],
): AppBuilderBuildBrief {
  const byId = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
  const warnings = [...brief.warnings];
  const requirementsById = new Map(brief.requirements.map((requirement) => [requirement.id, requirement]));
  const components = brief.components.map((component) => {
    if (component.requirementIds.length === 0) return component;
    const candidate = byId.get(component.sourceId);
    const requirementIds = component.requirementIds.filter((requirementId) => {
      const requirement = requirementsById.get(requirementId);
      return Boolean(candidate && requirement && componentSatisfiesRequirement(component, requirement, candidate));
    });
    const removed = component.requirementIds.filter((requirementId) => !requirementIds.includes(requirementId));
    if (removed.length) {
      warnings.push(partialCoverageNote(component.title, removed.flatMap((requirementId) => {
        const requirement = requirementsById.get(requirementId);
        return requirement ? [requirement.question] : [];
      }), requirementIds.length, brief.requirements.length));
    }
    return requirementIds.length === component.requirementIds.length ? component : { ...component, requirementIds };
  });
  const componentIds = new Set(components.map((component) => component.id));
  for (const sourceId of requiredSourceIds) {
    if (components.some((component) => component.sourceId === sourceId)) continue;
    const candidate = byId.get(sourceId);
    if (!candidate) {
      throw new Error(`APP_BUILD_REQUIRED_SOURCE_MISSING: required source was not retained in the bounded candidate cards: ${sourceId}`);
    }
    const match = brief.requirements.find((requirement) => candidateSatisfiesStructuredRequirement(requirement, candidate));
    let componentId = `required-${candidate.sourceId.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'source'}`;
    for (let suffix = 2; componentIds.has(componentId); suffix += 1) {
      componentId = `${componentId.replace(/-\d+$/, '')}-${suffix}`;
    }
    componentIds.add(componentId);
    const plannedRole = match?.role ?? inferRole(candidate, components.length);
    const plannedQuery = candidate.capabilities.dataset
      ? deterministicDatasetQuery(candidate.capabilities.dataset, match, plannedRole)
      : undefined;
    // A saved query's result fields (design D1) that can't express this still show its result as it is.
    if (candidate.capabilities.dataset && !plannedQuery && !candidate.capabilities.dataset.result) {
      warnings.push(`You added ${plannerSourceName(candidate.title)}, but none of its fields answer what you asked. Add data that does.`);
      continue;
    }
    const { query, role } = plannedQuery && candidate.capabilities.dataset
      ? withAskedSplits(plannedQuery, candidate.capabilities.dataset, plannedRole, [candidate.title, ...(match ? [match.question] : [])], match ? [match] : [])
      : { query: plannedQuery, role: plannedRole };
    components.push({
      id: componentId,
      title: datasetComponentTitle(candidate.title, candidate.capabilities.dataset, query, role),
      sourceId: candidate.sourceId,
      requirementIds: match && (!candidate.capabilities.dataset || datasetPlannedQueryCoversRequirement(query!, match, candidate.capabilities.dataset)) ? [match.id] : [],
      ...(query ? { query } : {}),
      role,
      view: inferView(candidate, components.length),
      rationale: match
        ? `You added it, and its fields match “${match.question}” · ${sourceKindAndTrust(candidate)}`
        : `You added it · ${sourceKindAndTrust(candidate)}`,
    });
    if (!match) {
      warnings.push(`You added ${plannerSourceName(candidate.title)}, but its fields don't match anything you asked for yet.`);
    }
  }
  return {
    ...brief,
    components,
    selectedSourceIds: Array.from(new Set(components.map((component) => component.sourceId))),
    warnings,
  };
}

/**
 * Preserve the dedicated generator's narrative intent while reducing every
 * connection to identifiers from the source-bound component set. The model may
 * suggest a page or interaction; it cannot attach a field by display-name
 * coincidence, introduce a source, or smuggle an executable expression here.
 */
function ensureAppBuildStructure(
  brief: AppBuilderBuildBrief,
  candidates: AppSourceCatalogRecord[],
  raw?: Record<string, unknown>,
): AppBuilderBuildBrief {
  const pages = normalizePlannedPages(brief.pages, brief.components);
  const normalized = normalizePlannedInteractions({
    pages,
    components: brief.components,
    candidates: new Map(candidates.map((candidate) => [candidate.sourceId, candidate])),
    filters: raw?.filters ?? brief.filters,
    navigation: raw?.navigation ?? brief.navigation,
    crossFilters: raw?.crossFilters ?? brief.crossFilters,
    detailDrills: raw?.detailDrills ?? brief.detailDrills,
  });
  return {
    ...brief,
    pages,
    filters: normalized.filters,
    navigation: normalized.navigation,
    crossFilters: normalized.crossFilters,
    detailDrills: normalized.detailDrills,
    warnings: [...brief.warnings, ...normalized.warnings],
  };
}

function plannerIdentifier(value: unknown, fallback: string): string {
  const candidate = stringValue(value)?.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return candidate && candidate.length <= 80 ? candidate : fallback;
}

function plannerDisplayTitle(value: unknown, fallback: string): string {
  const title = stringValue(value);
  return title && title.length <= 160 ? title : fallback;
}

function normalizePlannedPages(value: unknown, components: AppBuilderPlannedComponent[]): AppBuilderPlannedPage[] {
  const available = new Set(components.map((component) => component.id));
  const assigned = new Set<string>();
  const seenPages = new Set<string>();
  const pages = (Array.isArray(value) ? value : []).slice(0, 8).flatMap((raw, index): AppBuilderPlannedPage[] => {
    const record = objectValue(raw);
    if (!record) return [];
    const id = plannerIdentifier(record.id, `page-${index + 1}`);
    if (seenPages.has(id)) return [];
    seenPages.add(id);
    const componentIds = stringArray(record.componentIds).filter((componentId) => available.has(componentId) && !assigned.has(componentId));
    componentIds.forEach((componentId) => assigned.add(componentId));
    return [{
      id,
      title: plannerDisplayTitle(record.title, humanizePlannerId(id)),
      componentIds,
      sections: normalizePlannedSections(record.sections, componentIds, components),
    }];
  });
  if (pages.length === 0) {
    const summary = components.filter((component) => component.role !== 'detail' && component.role !== 'evidence');
    const detail = components.filter((component) => component.role === 'detail' || component.role === 'evidence');
    const overview = summary.length > 0 ? summary : components;
    const overviewIds = overview.map((component) => component.id);
    overviewIds.forEach((componentId) => assigned.add(componentId));
    pages.push({
      id: 'overview',
      title: 'Overview',
      componentIds: overviewIds,
      sections: defaultPlannedSections(overviewIds, components),
    });
    const detailIds = detail.map((component) => component.id).filter((componentId) => !overviewIds.includes(componentId));
    if (detailIds.length > 0) {
      detailIds.forEach((componentId) => assigned.add(componentId));
      pages.push({ id: 'details', title: 'Details', componentIds: detailIds, sections: defaultPlannedSections(detailIds, components) });
    }
  }
  const unassigned = components.map((component) => component.id).filter((componentId) => !assigned.has(componentId));
  if (unassigned.length > 0) {
    const first = pages[0]!;
    first.componentIds.push(...unassigned);
    first.sections = normalizePlannedSections(first.sections, first.componentIds, components);
  }
  return pages.filter((page) => page.componentIds.length > 0).map((page) => ({
    ...page,
    sections: page.sections.length > 0 ? page.sections : defaultPlannedSections(page.componentIds, components),
  }));
}

function normalizePlannedSections(
  value: unknown,
  componentIds: string[],
  components: AppBuilderPlannedComponent[],
): AppBuilderPlannedPage['sections'] {
  const allowed = new Set(componentIds);
  const assigned = new Set<string>();
  const seen = new Set<string>();
  const sections = (Array.isArray(value) ? value : []).slice(0, 8).flatMap((raw, index): AppBuilderPlannedPage['sections'] => {
    const record = objectValue(raw);
    if (!record) return [];
    const id = plannerIdentifier(record.id, `section-${index + 1}`);
    const kind = record.kind;
    if (seen.has(id) || (kind !== 'exec_summary' && kind !== 'kpi_band' && kind !== 'insight' && kind !== 'appendix')) return [];
    seen.add(id);
    const selected = stringArray(record.componentIds).filter((componentId) => allowed.has(componentId) && !assigned.has(componentId));
    if (selected.length === 0) return [];
    selected.forEach((componentId) => assigned.add(componentId));
    return [{ id, title: plannerDisplayTitle(record.title, humanizePlannerId(id)), kind, componentIds: selected }];
  });
  const missing = componentIds.filter((componentId) => !assigned.has(componentId));
  if (missing.length > 0) {
    return [...sections, ...defaultPlannedSections(missing, components, sections.length)];
  }
  return sections;
}

function defaultPlannedSections(
  componentIds: string[],
  components: AppBuilderPlannedComponent[],
  offset = 0,
): AppBuilderPlannedPage['sections'] {
  const byId = new Map(components.map((component) => [component.id, component]));
  const groups: Array<{ kind: AppBuilderPlannedPage['sections'][number]['kind']; title: string; ids: string[] }> = [
    { kind: 'kpi_band', title: 'Key metrics', ids: [] },
    { kind: 'insight', title: 'Insights', ids: [] },
    { kind: 'appendix', title: 'Details', ids: [] },
  ];
  for (const id of componentIds) {
    const role = byId.get(id)?.role;
    if (role === 'kpi') groups[0]!.ids.push(id);
    else if (role === 'detail' || role === 'evidence') groups[2]!.ids.push(id);
    else groups[1]!.ids.push(id);
  }
  return groups.flatMap((group, index) => group.ids.length > 0 ? [{
    id: `${group.kind}-${offset + index + 1}`,
    title: group.title,
    kind: group.kind,
    componentIds: group.ids,
  }] : []);
}

function humanizePlannerId(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizePlannedInteractions(input: {
  pages: AppBuilderPlannedPage[];
  components: AppBuilderPlannedComponent[];
  candidates: Map<string, AppSourceCatalogRecord>;
  filters: unknown;
  navigation: unknown;
  crossFilters: unknown;
  detailDrills: unknown;
}): {
  filters: AppBuilderPlannedFilter[];
  navigation: AppBuilderPlannedNavigation[];
  crossFilters: AppBuilderPlannedCrossFilter[];
  detailDrills: AppBuilderPlannedDetailDrill[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const componentById = new Map(input.components.map((component) => [component.id, component]));
  const pageByComponent = new Map(input.pages.flatMap((page) => page.componentIds.map((componentId) => [componentId, page.id] as const)));
  const pageById = new Map(input.pages.map((page) => [page.id, page]));
  const exactField = (componentId: string, fieldName: string) => {
    const component = componentById.get(componentId);
    const descriptor = component ? input.candidates.get(component.sourceId)?.capabilities.dataset : undefined;
    return descriptor ? datasetPhysicalFields(descriptor).find((field) => field.status === 'approved'
      && sameDatasetName(fieldName, field.name, field.qualifiedId)) : undefined;
  };
  const filters: AppBuilderPlannedFilter[] = [];
  const filterIds = new Set<string>();
  for (const raw of (Array.isArray(input.filters) ? input.filters : []).slice(0, 12)) {
    const record = objectValue(raw);
    const field = stringValue(record?.field);
    const scope = record?.scope;
    if (!record || !field || (scope !== 'page' && scope !== 'app')) continue;
    const id = plannerIdentifier(record.id, `filter-${filters.length + 1}`);
    if (filterIds.has(id)) continue;
    const declaredPageId = stringValue(record.pageId);
    const requested = stringArray(record.componentIds);
    const fallbackIds = declaredPageId && pageById.has(declaredPageId)
      ? pageById.get(declaredPageId)!.componentIds
      : scope === 'app' ? input.components.map((component) => component.id) : [];
    const targets = (requested.length > 0 ? requested : fallbackIds)
      .filter((componentId) => componentById.has(componentId) && Boolean(exactField(componentId, field)));
    const pageId = scope === 'page'
      ? declaredPageId && pageById.has(declaredPageId) ? declaredPageId : pageByComponent.get(targets[0] ?? '')
      : undefined;
    const pageTargets = scope === 'page' && pageId ? targets.filter((componentId) => pageByComponent.get(componentId) === pageId) : targets;
    if (!pageId && scope === 'page' || pageTargets.length === 0) {
      warnings.push(`The ${plannerDisplayTitle(record.label, humanizePlannerId(id))} filter was left out: no tile has an approved field for it.`);
      continue;
    }
    filterIds.add(id);
    filters.push({
      id,
      label: plannerDisplayTitle(record.label, humanizePlannerId(id)),
      field,
      scope,
      ...(pageId ? { pageId } : {}),
      componentIds: Array.from(new Set(pageTargets)),
    });
  }

  const navigation: AppBuilderPlannedNavigation[] = [];
  const navigated = new Set<string>();
  for (const raw of (Array.isArray(input.navigation) ? input.navigation : []).slice(0, 12)) {
    const record = objectValue(raw);
    const fromComponentId = stringValue(record?.fromComponentId);
    const toPageId = stringValue(record?.toPageId);
    if (!fromComponentId || !toPageId || !componentById.has(fromComponentId) || !pageById.has(toPageId)
      || pageByComponent.get(fromComponentId) === toPageId || navigated.has(fromComponentId)) continue;
    navigated.add(fromComponentId);
    navigation.push({ fromComponentId, toPageId });
  }

  const crossFilters: AppBuilderPlannedCrossFilter[] = [];
  const crossKeys = new Set<string>();
  for (const raw of (Array.isArray(input.crossFilters) ? input.crossFilters : []).slice(0, 12)) {
    const record = objectValue(raw);
    const fromComponentId = stringValue(record?.fromComponentId);
    const fromField = stringValue(record?.fromField);
    const toComponentId = stringValue(record?.toComponentId);
    const toField = stringValue(record?.toField);
    const from = fromComponentId ? componentById.get(fromComponentId) : undefined;
    if (!fromComponentId || !fromField || !toComponentId || !toField || !from?.query || !componentById.has(toComponentId)
      || pageByComponent.get(fromComponentId) !== pageByComponent.get(toComponentId)) continue;
    const output = tileQueryOutputAliases(from.query).find((candidate) => candidate.kind === 'dimension'
      && sameDatasetName(fromField, candidate.alias, candidate.alias));
    if (!output || !exactField(toComponentId, toField)) {
      warnings.push('A click-to-filter link between two tiles was left out: its fields aren\'t approved on both tiles.');
      continue;
    }
    const key = `${fromComponentId}:${output.alias}:${toComponentId}:${toField}`;
    if (crossKeys.has(key)) continue;
    crossKeys.add(key);
    crossFilters.push({ fromComponentId, fromField: output.alias, toComponentId, toField });
  }

  const detailDrills: AppBuilderPlannedDetailDrill[] = [];
  const drilledPages = new Set<string>();
  for (const raw of (Array.isArray(input.detailDrills) ? input.detailDrills : []).slice(0, 8)) {
    const record = objectValue(raw);
    const pageId = stringValue(record?.pageId);
    const componentId = stringValue(record?.componentId);
    if (!pageId || !componentId || drilledPages.has(pageId) || pageByComponent.get(componentId) !== pageId) continue;
    const fields = stringArray(record?.fields).flatMap((field) => {
      const exact = exactField(componentId, field);
      return exact ? [exact.name] : [];
    });
    if (fields.length === 0) {
      warnings.push(`The row details on ${pageById.get(pageId)?.title ?? humanizePlannerId(pageId)} were left out: they don't use approved fields.`);
      continue;
    }
    drilledPages.add(pageId);
    detailDrills.push({ pageId, componentId, fields: Array.from(new Set(fields)).slice(0, 8) });
  }
  return { filters, navigation, crossFilters, detailDrills, warnings };
}

function candidateSatisfiesStructuredRequirement(
  requirement: AppBuildRequirement,
  candidate: AppSourceCatalogRecord,
): boolean {
  const hasStructuredRequirement = requirement.measures.length > 0
    || requirement.dimensions.length > 0
    || requirement.filters.length > 0;
  if (!hasStructuredRequirement) {
    return questionEvidenceMatchesCandidate(requirement.question, candidate);
  }

  // Provider-declared capability fields are only trustworthy when the visible
  // requirement question names them. This prevents an internally inconsistent
  // requirement such as "Profit margin" + measure "revenue" from laundering a
  // revenue source into false margin coverage.
  // A question that asks for a split by values ("regular season vs playoffs")
  // names no field for it: the requirement's declared grouping stands (V11).
  // A filter is named by its value, never its field ("the Warriors" for TEAM,
  // "2014 to 2018" for SEASON), and only narrows the rows (V12).
  // So is a grouping the requirement also filters on ("playoff wins" by SEASON and GAME_TYPE, filtered to playoffs).
  const filtered = new Set(requirement.filters.map((field) => field.toLowerCase()));
  if (!capabilityValuesMatch([
    ...requirement.measures,
    ...(asksForValueSplit(requirement.question) ? [] : requirement.dimensions.filter((dimension) => !filtered.has(dimension.toLowerCase()))),
  ], [requirement.question])) return false;

  // A declared measure is decisive: generic words in titles or descriptions
  // can never substitute a different metric into requirement coverage.
  // A source's approved Dataset fields count as its capabilities too: a saved
  // query offers its result columns as fields (design D1) though the block
  // declares no measures or dimensions of its own (new-user test V9: a
  // notebook block's WINS by SEASON and GAME_TYPE read as "can't answer").
  const fields = approvedDatasetFieldNames(candidate.capabilities.dataset);
  if (!capabilityValuesMatch(requirement.measures, [
    ...candidate.capabilities.measures,
    ...candidate.capabilities.outputs,
    ...fields.measures,
  ])) return false;
  if (!capabilityValuesMatch(requirement.dimensions, [...candidate.capabilities.dimensions, ...fields.physical])) return false;
  if (!capabilityValuesMatch(requirement.filters, [...candidate.capabilities.filters, ...fields.physical])) return false;
  return true;
}

/** The names of a Dataset's approved measures and physical fields. */
function approvedDatasetFieldNames(descriptor: DatasetDescriptor | undefined): { measures: string[]; physical: string[] } {
  if (!descriptor) return { measures: [], physical: [] };
  return {
    measures: datasetMeasures(descriptor).filter((measure) => measure.status === 'approved').map((measure) => measure.name),
    physical: datasetPhysicalFields(descriptor).filter((field) => field.status === 'approved').map((field) => field.name),
  };
}

/**
 * Coverage is about the field query a person will see, not merely every
 * capability advertised by its source. A Dataset with revenue and margin does
 * not make a revenue-only tile cover a margin requirement.
 */
function componentSatisfiesRequirement(
  component: AppBuilderPlannedComponent,
  requirement: AppBuildRequirement,
  candidate: AppSourceCatalogRecord,
): boolean {
  const descriptor = candidate.capabilities.dataset;
  if (!candidateSatisfiesStructuredRequirement(requirement, candidate)) {
    // A question with no declared fields (the keyword planner's) is covered
    // when the tile's own query names every word that matters in it:
    // "Top 10 regions by net amount" by net_amount grouped by region.
    const structured = requirement.measures.length > 0 || requirement.dimensions.length > 0 || requirement.filters.length > 0;
    if (structured || !descriptor || !component.query || !datasetQueryNamesQuestion(requirement.question, component.query)) return false;
  }
  return !descriptor || Boolean(component.query && datasetPlannedQueryCoversRequirement(component.query, requirement, descriptor));
}

/** Words about how to show a number, not which number: "top 10 … as a KPI". */
const PRESENTATION_WORDS = new Set([
  'as', 'best', 'bottom', 'breakdown', 'by', 'chart', 'each', 'headline', 'highest', 'kpi', 'largest', 'least',
  'list', 'lowest', 'most', 'over', 'per', 'rank', 'ranking', 'show', 'smallest', 'time', 'top', 'total', 'trend', 'worst',
]);
const GRAIN_WORDS: Record<string, string> = {
  daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year', annual: 'year', annually: 'year',
};

/** True when every word of the question that names data is named by the query's measures, groups or time grain. */
function datasetQueryNamesQuestion(question: string, query: TileQuery): boolean {
  const asked = Array.from(deterministicWords(question))
    .filter((token) => !PRESENTATION_WORDS.has(token) && !/^\d+$/.test(token))
    .map((token) => GRAIN_WORDS[token] ?? token);
  if (asked.length === 0) return false;
  const named = deterministicWords([
    ...query.measures.map((selection) => selection.measure),
    ...query.dimensions.flatMap((selection) => [selection.field, selection.timeGrain ?? '']),
  ].join(' '));
  return asked.every((token) => named.has(token));
}

function questionEvidenceMatchesCandidate(
  question: string,
  candidate: AppSourceCatalogRecord,
): boolean {
  const questionTokens = deterministicWords(question);
  if (questionTokens.size === 0) return false;
  const candidateTokens = deterministicWords([
    candidate.title,
    candidate.description ?? '',
    candidate.qualifiedIdentity,
    ...candidate.tags,
    ...candidate.capabilities.measures,
    ...candidate.capabilities.dimensions,
    ...candidate.capabilities.filters,
    ...candidate.capabilities.outputs,
  ].join(' '));
  return Array.from(questionTokens).every((token) => candidateTokens.has(token));
}

function capabilityValuesMatch(requiredValues: string[], availableValues: string[]): boolean {
  if (requiredValues.length === 0) return true;
  const availableTokenSets = availableValues.map((value) => deterministicWords(value));
  return requiredValues.every((requiredValue) => {
    const requiredTokens = deterministicWords(requiredValue);
    return requiredTokens.size > 0 && availableTokenSets.some((availableTokens) => (
      Array.from(requiredTokens).every((token) => availableTokens.has(token))
    ));
  });
}

function uniqueCandidates(candidates: AppSourceCatalogRecord[]): AppSourceCatalogRecord[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.sourceId)) return false;
    seen.add(candidate.sourceId);
    return true;
  });
}

function deterministicBrief(
  input: PlanAppBuildBriefInput,
  candidates: AppSourceCatalogRecord[],
  warnings: string[] = [],
): AppBuilderBuildBrief {
  const requirementQuestions = deterministicRequirementQuestions(input.prompt);
  // Parts of the request the keyword matcher split out are notes, never
  // publish blockers (design D4): no AI read the request, so a part it could
  // not match ("Keep it short and clear") is not a question the App must answer.
  // App Studio lists the uncovered ones under "Not covered yet".
  const requirements = requirementQuestions.map((question, index): AppBuildRequirement => ({
    id: `requirement-${index + 1}`,
    question,
    role: inferRequirementRole(question, index),
    required: false,
    measures: [],
    dimensions: [],
    filters: [],
  }));
  const requirementIdsBySource = new Map<string, string[]>();
  const selected: AppSourceCatalogRecord[] = [];
  const addSelection = (candidate: AppSourceCatalogRecord, requirementId: string) => {
    if (!selected.some((item) => item.sourceId === candidate.sourceId)) selected.push(candidate);
    const ids = requirementIdsBySource.get(candidate.sourceId) ?? [];
    if (!ids.includes(requirementId)) ids.push(requirementId);
    requirementIdsBySource.set(candidate.sourceId, ids);
  };
  if (requirements.length === 1) {
    for (const candidate of candidates.slice(0, Math.min(3, candidates.length))) {
      addSelection(candidate, requirements[0].id);
    }
  } else {
    const used = new Set<string>();
    for (const requirement of requirements) {
      const ranked = candidates
        .map((candidate) => ({ candidate, score: deterministicCandidateScore(requirement.question, candidate) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.candidate.sourceId.localeCompare(right.candidate.sourceId));
      const match = ranked.find((entry) => !used.has(entry.candidate.sourceId)) ?? ranked[0];
      if (!match) continue;
      used.add(match.candidate.sourceId);
      addSelection(match.candidate, requirement.id);
    }
  }
  const deterministicWarnings = [...warnings];
  const components = selected.flatMap((candidate, index): AppBuilderPlannedComponent[] => {
    const requirementIds = requirementIdsBySource.get(candidate.sourceId) ?? [];
    const primaryRequirement = requirements.find((requirement) => requirementIds.includes(requirement.id));
    const role = primaryRequirement?.role ?? inferRole(candidate, index);
    const query = candidate.capabilities.dataset
      ? deterministicDatasetQuery(candidate.capabilities.dataset, primaryRequirement, role)
      : undefined;
    if (candidate.capabilities.dataset && !query && !candidate.capabilities.dataset.result) {
      deterministicWarnings.push(`${plannerSourceName(candidate.title)} doesn't answer this. Add data that does.`);
      return [];
    }
    const coveredRequirementIds = candidate.capabilities.dataset && query
      ? requirementIds.filter((requirementId) => {
        const requirement = requirements.find((candidateRequirement) => candidateRequirement.id === requirementId);
        return Boolean(requirement && datasetPlannedQueryCoversRequirement(query, requirement, candidate.capabilities.dataset!));
      })
      : requirementIds;
    return [{
      id: `component-${index + 1}`,
      title: datasetComponentTitle(candidate.title, candidate.capabilities.dataset, query, role),
      sourceId: candidate.sourceId,
      requirementIds: coveredRequirementIds,
      ...(query ? { query } : {}),
      role,
      view: inferView(candidate, index),
      rationale: deterministicRationale(primaryRequirement?.question ?? input.prompt, candidate),
    }];
  });
  return {
    version: 1,
    planningMode: 'deterministic_fallback',
    plannerProvenance: {
      version: 1,
      mode: 'deterministic',
      providerInvocation: 'not_attempted',
    },
    frame: {
      goal: input.prompt.trim(),
      decision: input.prompt.trim(),
      audience: input.audience?.trim() || 'App users',
      metrics: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.measures))),
      dimensions: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.dimensions))),
      filters: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.filters))),
      desiredOutput: 'Interactive analytical App',
    },
    requirements,
    components,
    pages: [],
    filters: [],
    navigation: [],
    crossFilters: [],
    detailDrills: [],
    selectedSourceIds: selected.map((candidate) => candidate.sourceId),
    candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
    warnings: deterministicWarnings,
  };
}

/**
 * A source name a business reader recognises: "top_customers" reads
 * "Top Customers"; a name that already has spaces is kept as written.
 */
export function plannerSourceName(title: string): string {
  const trimmed = title.trim();
  return /\s/.test(trimmed) ? trimmed : humanizePlannerId(trimmed);
}

/**
 * "Certified saved query", "Certified table", "Metrics · Not certified yet":
 * the kinds the Add data list names (Table, Saved query, Metrics; T1, F09).
 * A saved query given fields (a Dataset) is still a saved query; "Dataset"
 * is never said to a person.
 */
export function sourceKindAndTrust(candidate: Pick<AppSourceCatalogRecord, 'kind' | 'trust' | 'capabilities'> & { tags?: readonly string[] }): string {
  const dataset = candidate.capabilities.dataset;
  const kind = dataset?.kind === 'semantic' || candidate.capabilities.semanticModelId || candidate.kind === 'semantic'
    ? 'Metrics'
    : dataset && !dataset.result && (candidate.tags ?? []).includes('from-table')
      ? 'table'
      : 'saved query';
  return candidate.trust === 'certified'
    ? `Certified ${kind}`
    : `${kind.charAt(0).toUpperCase()}${kind.slice(1)} · Not certified yet`;
}

const RATIONALE_IGNORED_WORDS = new Set(['all', 'any', 'are', 'but', 'each', 'how', 'into', 'our', 'over', 'per', 'show', 'than', 'that', 'their', 'this', 'what', 'when', 'which', 'who', 'why', 'your']);

/** A note for a tile kept in the plan that answers only part of the request. */
function partialCoverageNote(title: string, questions: string[], keptCount: number, requirementCount: number): string {
  const name = plannerSourceName(title);
  const question = questions[0];
  const quotable = requirementCount > 1 && question && question.length <= 120;
  if (keptCount === 0) {
    return quotable && questions.length === 1
      ? `${name} doesn't answer “${question}”. Add data that does, or remove that question.`
      : `${name} doesn't answer what you asked. Add data that does.`;
  }
  return quotable
    ? `${name} covers only part of what you asked. It doesn't answer “${question}”${questions.length > 1 ? ` and ${questions.length - 1} more` : ''}.`
    : `${name} covers only part of what you asked.`;
}

/**
 * Why the built-in planner (no AI provider) picked a source, in words: which
 * of the request's words its name, description or fields contain, and its
 * type and trust. "Its name and description match “customers” · Certified saved query".
 */
export function deterministicRationale(
  question: string,
  candidate: Pick<AppSourceCatalogRecord, 'title' | 'description' | 'tags' | 'kind' | 'trust' | 'capabilities'>,
): string {
  const asked = new Map<string, string>();
  for (const raw of question.split(/[^A-Za-z0-9]+/)) {
    const [normalized] = Array.from(deterministicWords(raw));
    // Connecting words ("by", "per", "show") say nothing about why data fits.
    if (!normalized || normalized.length < 3 || RATIONALE_IGNORED_WORDS.has(normalized)) continue;
    if (!asked.has(normalized)) asked.set(normalized, raw.toLowerCase());
  }
  const name = deterministicWords(candidate.title);
  const description = deterministicWords([candidate.description ?? '', ...candidate.tags].join(' '));
  const fields = deterministicWords([
    ...candidate.capabilities.measures,
    ...candidate.capabilities.dimensions,
    ...candidate.capabilities.filters,
  ].join(' '));
  const matched: string[] = [];
  const places = new Set<'name' | 'description' | 'fields'>();
  for (const [normalized, spelled] of asked) {
    const where = [
      name.has(normalized) ? 'name' as const : null,
      description.has(normalized) ? 'description' as const : null,
      fields.has(normalized) ? 'fields' as const : null,
    ].filter((place): place is 'name' | 'description' | 'fields' => place !== null);
    if (!where.length) continue;
    matched.push(spelled);
    where.forEach((place) => places.add(place));
  }
  const trust = sourceKindAndTrust(candidate);
  if (!matched.length) return `One of the closest matches in the data you can use · ${trust}`;
  const placeOrder = (['name', 'description', 'fields'] as const).filter((place) => places.has(place));
  const placeWords = placeOrder.length === 1
    ? placeOrder[0]
    : `${placeOrder.slice(0, -1).join(', ')} and ${placeOrder[placeOrder.length - 1]}`;
  const subject = placeOrder.length === 1 && placeOrder[0] === 'fields' ? 'Its fields match' : `Its ${placeWords} ${placeOrder.length === 1 ? 'matches' : 'match'}`;
  const words = matched.slice(0, 3).map((word) => `“${word}”`).join(', ');
  return `${subject} ${words}${matched.length > 3 ? ` and ${matched.length - 3} more` : ''} · ${trust}`;
}

const DETERMINISTIC_REQUIREMENT_STOP_WORDS = new Set([
  'a', 'an', 'analytics', 'and', 'app', 'application', 'available', 'block',
  'build', 'certified', 'create', 'dashboard', 'data', 'dql', 'draft', 'for',
  'from', 'governed', 'in', 'last', 'me', 'of', 'on', 'please', 'report',
  'source', 'table', 'the', 'to', 'using', 'view', 'warehouse', 'with',
]);

function deterministicRequirementQuestions(prompt: string): string[] {
  const trimmed = prompt.trim().replace(/[.!?]+$/, '');
  const focusMatch = trimmed.match(/\b(?:showing|including|that shows?|that tracks?|that monitors?)\b\s+(.+)$/i);
  const focus = (focusMatch?.[1] ?? trimmed.replace(/^(?:please\s+)?(?:build|create|make|design)\s+(?:me\s+)?/i, '')).trim();
  const parts = focus.split(/\s*(?:,|;|\band\b)\s*/i)
    .map((part) => part.replace(/^(?:and\s+)?/i, '').trim())
    .filter((part) => part.length > 2);
  if (parts.length < 2 || parts.length > 6 || parts.some((part) => deterministicWords(part).size === 0)) return [trimmed];
  return Array.from(new Set(parts.map((part) => part[0].toUpperCase() + part.slice(1))));
}

function deterministicWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/)
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !DETERMINISTIC_REQUIREMENT_STOP_WORDS.has(token)));
}

function deterministicCandidateScore(question: string, candidate: AppSourceCatalogRecord): number {
  const required = deterministicWords(question);
  const title = deterministicWords(candidate.title);
  const evidence = deterministicWords([
    candidate.title,
    candidate.description ?? '',
    candidate.qualifiedIdentity,
    ...candidate.tags,
    ...candidate.capabilities.measures,
    ...candidate.capabilities.dimensions,
    ...candidate.capabilities.filters,
  ].join(' '));
  let score = 0;
  for (const word of required) {
    if (title.has(word)) score += 4;
    else if (evidence.has(word)) score += 2;
  }
  return score;
}

function inferRequirementRole(question: string, index: number): AppBuilderComponentRole {
  const normalized = question.toLowerCase();
  // "Total revenue as a KPI" is one number, whatever else it mentions.
  if (/\bkpi\b|\bheadline\b/.test(normalized)) return 'kpi';
  if (/trend|growth|change|week|month|quarter|year|over time/.test(normalized)) return 'trend';
  if (/region|segment|category|channel|breakdown|rank|top/.test(normalized)) return 'breakdown';
  if (/^total\b/.test(normalized)) return 'kpi';
  if (/detail|customer|order|record|list/.test(normalized)) return 'detail';
  return index === 0 ? 'kpi' : 'evidence';
}

function appBuilderSystemPrompt(): string {
  // The reply is read as JSON (V12: Describe with AI failed 3 of 3 with "did not return valid JSON" on Cortex,
  // and the plans it did read lost every tile query to strings in place of objects). So the prompt says where
  // the JSON starts, which keys come first (a reply cut off keeps its tiles), and the exact query shape.
  return [
    'You are the DQL App Builder planner. Produce one stateful analytical App build brief, not a prose answer.',
    'Reply with exactly one JSON object and nothing else: no prose before or after it, no code fence. Start the reply with { and end it with }.',
    'Write its keys in this order: requirements, components, pages, frame, filters, navigation, crossFilters, detailDrills.',
    'Use only sourceId values present in the supplied candidate cards. Never invent a source, field, capability, or trust state.',
    'Draft and review sources may be recommended, but their trust must not be upgraded.',
    'requirements: [{id, question, role, required, measures[], dimensions[], filters[], grain?}]. role is kpi, trend, breakdown, detail, narrative, or evidence. measures, dimensions and filters are exact field names from the cards; filters lists only the fields the data must be filtered on, and is [] when the data is already limited to what is asked.',
    'components: [{id, title, sourceId, query, requirementIds[], role, view, style?, rationale}]. view is kpi, line, bar, or table. rationale is one short sentence.',
    'query uses only the approved Dataset fields and measures on that source card, in exactly this shape: {"dimensions":[{"field":"SEASON"}],"measures":[{"measure":"WINS"}],"filters":[{"field":"GAME_TYPE","op":"eq","values":["Playoffs"]}]}. dimensions and measures are arrays of objects, never of strings; a KPI has "dimensions":[]. op is eq, neq, in, not_in, gt, gte, lt, lte, between, or contains, and values is always an array ("between" takes [from, to]). Filter only on a value the request or the card names; for a name, use contains with its most telling word ("Warriors"), since the stored value may be shorter or longer.',
    'style is optional chart styling: {labels?: none|last|all, format?: number|compact|currency|percent, sort?: none|asc|desc, stack?: boolean, referenceLines?: [{value, label?}], bands?: [{from, to, label?}]}. Add a reference line or band only for a target or threshold the user stated; never invent one.',
    'pages: [{id, title, componentIds[], sections:[{id,title,kind,componentIds[]}]}]. section kind is exec_summary, kpi_band, insight, or appendix. Every component must appear on one page.',
    'frame: {goal, decision?, audience?, metrics[], dimensions[], grain?, timeRange?, comparison?, filters[], desiredOutput?, clarificationQuestions?}, each value short.',
    'filters, navigation, crossFilters and detailDrills are [] unless the request asks for a filter, linked charts or a drill.',
    'filters: [{id,label,field,scope,pageId?,componentIds[]}]. field must be one exact approved physical Dataset field for every named component; scope is page or app.',
    'navigation: [{fromComponentId,toPageId}]. crossFilters: [{fromComponentId,fromField,toComponentId,toField}], where fromField is an exact selected dimension output and toField is an exact approved physical target field on the same page.',
    'detailDrills: [{pageId,componentId,fields[]}], where every field is an exact approved physical Dataset field. Never write SQL, joins, source revisions, results, or trust claims.',
    'Prefer the fewest components that cover the request, at most 6, and never two that show the same numbers. Prefer data already limited to what the request names over adding filters. Ask a clarification only when a material choice cannot be made from supplied evidence.',
  ].join('\n');
}

function appBuilderUserPrompt(input: PlanAppBuildBriefInput, candidates: AppSourceCatalogRecord[]): string {
  return JSON.stringify({
    request: input.prompt,
    sourcePolicy: input.sourcePolicy,
    requiredSourceIds: input.requiredSourceIds,
    domain: input.domain,
    audience: input.audience,
    candidateCards: candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      qualifiedIdentity: candidate.qualifiedIdentity,
      title: candidate.title,
      description: candidate.description,
      domain: candidate.domain,
      lifecycle: candidate.lifecycle,
      trust: candidate.trust,
      eligibleForLocalPreview: candidate.eligibility.localPreview,
      capabilities: plannerCapabilities(candidate),
      evidence: candidate.reasons,
    })),
  });
}

/** Asked of the provider the second time, when its first reply could not be read as a grounded brief. */
export const APP_BUILDER_RETRY_NOTE = 'Your previous reply could not be read as the build brief. Reply again with exactly one JSON object and nothing else: no prose, no code fence. Keep it compact: at most 6 components, one short sentence per rationale, and include requirements.';

/** Said on the plan when the reply was cut off and closed after its last complete part. */
export const APP_BUILDER_TRUNCATED_NOTE = 'The AI plan was cut short, so it may cover less than you asked. Add more data or tiles yourself.';
/** Said when the reply was cut off before its tiles, and ZLens picked data for its questions by their fields. */
export const APP_BUILDER_TRUNCATED_PICKED_NOTE = 'The AI plan was cut short before it picked any data, so ZLens picked data whose fields answer its questions. Check the picks, or try again.';

/** A planner reply read as a brief (see `readPlannerJson`), with its grounded requirements. */
function readPlannerReply(completion: string | AppBuilderPlannerCompletionResult): {
  parsed?: Record<string, unknown>;
  requirements: AppBuildRequirement[];
  truncated: boolean;
} {
  const raw = typeof completion === 'string' ? completion : completion?.content;
  const read = readPlannerJson(raw);
  if (!read) return { requirements: [], truncated: false };
  return { parsed: read.value, requirements: normalizeRequirements(read.value.requirements), truncated: read.truncated };
}

/** Provider identifiers originate in the local runtime's selected settings,
 * but keep the persisted proposal schema bounded if another host adapter
 * implements the planner completion contract. */
function appBuilderPlannerProviderId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(id) ? id : undefined;
}

function normalizeFrame(value: unknown, prompt: string, audience?: string): AppBuildFrame {
  const record = objectValue(value);
  return {
    goal: stringValue(record?.goal) ?? prompt,
    ...(stringValue(record?.decision) ? { decision: stringValue(record?.decision) } : {}),
    audience: stringValue(record?.audience) ?? audience ?? 'App users',
    metrics: stringArray(record?.metrics),
    dimensions: stringArray(record?.dimensions),
    ...(stringValue(record?.grain) ? { grain: stringValue(record?.grain) } : {}),
    ...(stringValue(record?.timeRange) ? { timeRange: stringValue(record?.timeRange) } : {}),
    ...(stringValue(record?.comparison) ? { comparison: stringValue(record?.comparison) } : {}),
    filters: stringArray(record?.filters),
    ...(stringValue(record?.desiredOutput) ? { desiredOutput: stringValue(record?.desiredOutput) } : {}),
    ...normalizeClarifications(record?.clarificationQuestions),
  };
}

function normalizeRequirements(value: unknown): AppBuildRequirement[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 12).flatMap((raw, index) => {
    const record = objectValue(raw);
    if (!record) return [];
    const id = stringValue(record.id) ?? `requirement-${index + 1}`;
    const asked = stringValue(record.question);
    const question = asked ? plainPlannerText(asked) : undefined;
    const role = appRole(record.role);
    if (!question || !role || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      question,
      role,
      required: record.required !== false,
      measures: stringArray(record.measures),
      dimensions: stringArray(record.dimensions),
      filters: plannerFilterFields(record.filters),
      ...(stringValue(record.grain) ? { grain: stringValue(record.grain) } : {}),
    }];
  });
}

function normalizeComponents(
  value: unknown,
  candidatesById: Map<string, AppSourceCatalogRecord>,
  requirementIds: Set<string>,
  requirementsById: Map<string, AppBuildRequirement>,
): AppBuilderPlannedComponent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 16).flatMap((raw, index) => {
    const record = objectValue(raw);
    if (!record) return [];
    const sourceId = stringValue(record.sourceId);
    const role = appRole(record.role);
    const view = appView(record.view);
    const id = stringValue(record.id) ?? `component-${index + 1}`;
    const candidate = sourceId ? candidatesById.get(sourceId) : undefined;
    if (!sourceId || !candidate || !role || !view || seen.has(id)) return [];
    seen.add(id);
    const selectedRequirementIds = stringArray(record.requirementIds).filter((requirementId) => requirementIds.has(requirementId));
    const primaryRequirement = selectedRequirementIds
      .map((requirementId) => requirementsById.get(requirementId))
      .find((requirement): requirement is AppBuildRequirement => Boolean(requirement));
    const query = candidate.capabilities.dataset
      ? normalizedDatasetQuery(plannerTileQuery(record.query), candidate.capabilities.dataset, primaryRequirement, role)
      : undefined;
    // A Dataset card must always carry a validated, field-level query. Do not
    // fall back to a legacy block tile when its governed descriptor cannot
    // express the requested component. A saved query's result fields
    // (design D1) are not a row-level contract: its result shows as it is,
    // but only for a component that names no fields. One whose fields the
    // source lacks is refused before Apply (V11: a bar of lifetime_value
    // over Top Customers blanked App Studio).
    if (candidate.capabilities.dataset && !query && (!candidate.capabilities.dataset.result || record.query !== undefined)) return [];
    // Style is presentation only: malformed fields are dropped, never fatal.
    const style = readDashboardVizStyle(record.style, `components[${index}].style`, () => undefined);
    const title = plainPlannerText(stringValue(record.title) ?? id);
    // A split the title or its questions ask for is applied (V11: "Wins by Season and Game Type" added up every game type).
    const split = query && candidate.capabilities.dataset
      ? withAskedSplits(query, candidate.capabilities.dataset, role, [title, ...selectedRequirementIds.flatMap((requirementId) => {
        const requirement = requirementsById.get(requirementId);
        return requirement ? [requirement.question] : [];
      })], selectedRequirementIds.flatMap((requirementId) => requirementsById.get(requirementId) ?? []))
      : { query, role };
    return [{
      id,
      title: datasetComponentTitle(title, candidate.capabilities.dataset, split.query, split.role),
      sourceId,
      ...(split.query ? { query: split.query } : {}),
      requirementIds: selectedRequirementIds,
      role: split.role,
      view,
      ...(style ? { style } : {}),
      rationale: plainPlannerText(stringValue(record.rationale) ?? 'Selected from the bounded App source candidate set.'),
    }];
  });
}

/**
 * Planner text a business reader sees, in their words (V11: a reason read "trust remains review_required as
 * supplied"). The trust and data-rule codes the candidate cards carry read as App Studio says them.
 */
export function plainPlannerText(text: string): string {
  return text
    .replace(/\binclude_review_required\b/gi, 'certified and not-certified data')
    .replace(/\bgoverned_only\b/gi, 'certified data only')
    .replace(/\breview[_-]required\b/gi, 'not certified yet')
    .replace(/\breview_status\b/gi, 'review')
    .replace(/\bnot_required\b/gi, 'not needed')
    .replace(/\bsourceId\b/g, 'data')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizedDatasetQuery(
  raw: unknown,
  descriptor: DatasetDescriptor,
  requirement: AppBuildRequirement | undefined,
  role: AppBuilderComponentRole,
): TileQuery | undefined {
  const supplied = normalizeTileQuery(raw);
  // A proposed tile must run whatever rows come back (V10 retest): an average
  // the run would refuse for combining rows is never proposed.
  if (supplied && tileQueryRunsWhateverTheRows(validateTileQuery(descriptor, supplied))) return supplied;
  return deterministicDatasetQuery(descriptor, requirement, role);
}

/**
 * A provider may choose a query only from the compact approved card. When it
 * cannot, this deterministic fallback uses one approved measure and the
 * narrowest role-compatible group. It never invents a field or lowers trust.
 *
 * The measure and the group are the ones whose words match the question
 * best ("net amount" by "region"). A grouping field never shares the
 * measure's name (a number column is both a field and its own total, and
 * grouping a total by itself is not a question). The first combination the
 * Dataset accepts wins, so one unusable pairing never makes a checked
 * Dataset "unable to answer".
 */
export function deterministicDatasetQuery(
  descriptor: DatasetDescriptor,
  requirement: AppBuildRequirement | undefined,
  role: AppBuilderComponentRole,
): TileQuery | undefined {
  const approvedMeasures = datasetMeasures(descriptor).filter((field) => field.status === 'approved');
  const approvedFields = datasetPhysicalFields(descriptor).filter((field) => field.status === 'approved');
  const question = requirement?.question ?? '';
  const requiredMeasures = requirement?.measures ?? [];
  const measures = requiredMeasures.length > 0
    ? approvedMeasures.filter((measure) => requiredMeasures.some((required) => sameDatasetName(required, measure.name, measure.qualifiedId)))
    : rankedByWords(question, approvedMeasures, (measure) => `${measure.name} ${measure.qualifiedId}`);
  if (measures.length === 0) return undefined;

  const requiredDimensions = requirement?.dimensions ?? [];
  const groupings = (measureName: string): Array<TileQuery['dimensions']> => {
    if (role === 'trend') {
      // The time field the question names, else the Dataset's primary one.
      const times = rankedByWords(question, approvedFields
        .filter((field) => field.role === 'time' && Boolean(field.time?.grains.length))
        .sort((left, right) => Number(Boolean(right.time?.primary)) - Number(Boolean(left.time?.primary))), (field) => field.name);
      const options: Array<TileQuery['dimensions']> = times.map((time) => {
        const grains = time.time?.grains ?? [];
        const grain = grains.includes('month') ? 'month' : grains[0];
        return [{ field: time.name, ...(grain ? { timeGrain: grain } : {}) }];
      });
      return [...options, []];
    }
    if (role === 'breakdown' || role === 'detail' || role === 'evidence') {
      if (requiredDimensions.length > 0) {
        return approvedFields
          .filter((field) => requiredDimensions.some((required) => sameDatasetName(required, field.name, field.qualifiedId)))
          .map((field) => [{ field: field.name }]);
      }
      const groupable = approvedFields
        .filter((field) => (field.role === 'dimension' || field.role === 'key' || field.role === 'attribute') && field.name.toLowerCase() !== measureName.toLowerCase());
      // Words that named the measure ("amount" in "by net amount") do not pick the group.
      const measureWords = deterministicWords(measureName);
      const groupWords = Array.from(deterministicWords(question)).filter((token) => !measureWords.has(token));
      const score = (field: (typeof groupable)[number]) => {
        const available = deterministicWords(field.name);
        return groupWords.filter((token) => available.has(token)).length;
      };
      const ranked = [...groupable].sort((left, right) => score(right) - score(left) || groupingRank(left) - groupingRank(right));
      const options: Array<TileQuery['dimensions']> = ranked.map((field) => [{ field: field.name }]);
      // A Dataset with nothing to group by still answers with its total.
      return options.length > 0 ? options : [[]];
    }
    return [[]];
  };
  for (const measure of measures) {
    for (const dimensions of groupings(measure.name)) {
      const query: TileQuery = { dimensions, measures: [{ measure: measure.name }] };
      if (tileQueryRunsWhateverTheRows(validateTileQuery(descriptor, query))) return query;
    }
  }
  return undefined;
}

/** Text categories group best, then other categories, the row key, and plain numbers last. */
function groupingRank(field: ReturnType<typeof datasetPhysicalFields>[number]): number {
  if (field.role === 'dimension') return field.type === 'string' ? 0 : 1;
  if (field.role === 'key') return 2;
  return 3;
}

/** Items whose words match the question most, in their own order when tied. */
function rankedByWords<T>(question: string, items: T[], text: (item: T) => string): T[] {
  const requested = deterministicWords(question);
  if (requested.size === 0) return [...items];
  const score = (item: T) => {
    const available = deterministicWords(text(item));
    return Array.from(requested).filter((token) => available.has(token)).length;
  };
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function datasetPlannedQueryCoversRequirement(query: TileQuery, requirement: AppBuildRequirement, descriptor: DatasetDescriptor): boolean {
  const selectedMeasures = query.measures.map((selection) => selection.measure);
  const selectedDimensions = [
    ...query.dimensions.map((selection) => selection.field),
    ...(query.filters ?? []).map((filter) => filter.field),
  ];
  if (requirement.measures.length > 0 && !requirement.measures.every((required) => selectedMeasures.some((selected) => {
    const measure = datasetMeasures(descriptor).find((candidate) => sameDatasetName(selected, candidate.name, candidate.qualifiedId));
    return Boolean(measure && sameDatasetName(required, measure.name, measure.qualifiedId));
  }))) return false;
  if (requirement.dimensions.length > 0 && !requirement.dimensions.every((required) => selectedDimensions.some((selected) => {
    const field = datasetPhysicalFields(descriptor).find((candidate) => sameDatasetName(selected, candidate.name, candidate.qualifiedId));
    return Boolean(field && sameDatasetName(required, field.name, field.qualifiedId));
  }))) return false;
  // A filter the question asks for is met by filtering on that field, or by showing each of its values on
  // its own (V12: "playoff wins" grouped by GAME_TYPE shows the playoff wins apart from the others).
  if (requirement.filters.length > 0 && !requirement.filters.every((required) => selectedDimensions.some((selected) => {
    const field = datasetPhysicalFields(descriptor).find((candidate) => sameDatasetName(selected, candidate.name, candidate.qualifiedId));
    return Boolean(field && sameDatasetName(required, field.name, field.qualifiedId));
  }))) return false;
  return true;
}

/**
 * Provider titles are presentation-only. If a title names an approved metric
 * that the emitted field query does not select, replace it with the exact
 * selected output rather than leaving the App to claim coverage it cannot
 * execute. This is deliberately narrow: ordinary descriptive titles survive.
 */
function datasetComponentTitle(
  title: string,
  descriptor: DatasetDescriptor | undefined,
  query: TileQuery | undefined,
  role: AppBuilderComponentRole,
): string {
  if (!descriptor || !query) return title;
  const selected = datasetMeasures(descriptor).filter((measure) => (
    query.measures.some((selection) => sameDatasetName(selection.measure, measure.name, measure.qualifiedId))
  ));
  if (selected.length === 0) return titleNamingOnlyAppliedSplits(title, descriptor, query);
  const titleWords = deterministicWords(title);
  const namesUnselected = datasetMeasures(descriptor).filter((measure) => (
    !selected.some((selectedMeasure) => selectedMeasure.qualifiedId === measure.qualifiedId)
    && Array.from(deterministicWords(measure.name)).some((word) => titleWords.has(word))
  ));
  if (namesUnselected.length === 0) return titleNamingOnlyAppliedSplits(title, descriptor, query);
  const measureLabel = selected[0]!.name;
  const dimensions = query.dimensions.map((dimension) => dimension.field);
  if (role === 'trend' && dimensions.length) return `${measureLabel} over time`;
  if ((role === 'breakdown' || role === 'detail' || role === 'evidence') && dimensions.length) return `${measureLabel} by ${dimensions.join(' and ')}`;
  return measureLabel;
}

/** Fields a tile can group by: categories, keys and dates, never a number column. */
function splitFields(descriptor: DatasetDescriptor): ReturnType<typeof datasetPhysicalFields> {
  return datasetPhysicalFields(descriptor).filter((field) => field.status === 'approved' && (field.role === 'dimension' || field.role === 'key' || field.role === 'time'));
}

/** "regular season vs playoffs", "split by …", "broken down by …": a split asked for by its values, or by words naming no field. */
const VALUE_SPLIT = /\b(?:vs\.?|versus)\s|\bsplit\s+(?:by|between|into)\b|\bbroken\s+(?:down|out)\s+by\b/i;
/** The words after "by", "per", "for each" or "across": the groupings a title or question names. */
const NAMED_SPLIT = /\b(?:split\s+by|broken\s+(?:down|out)\s+by|by|per|for\s+each|across)\s+([^.;:?()]+)/gi;

function asksForValueSplit(text: string): boolean {
  return VALUE_SPLIT.test(text);
}

/** The phrases naming groupings by field; a phrase of values ("regular season vs playoffs") names none. */
function namedSplitPhrases(text: string): string[] {
  return Array.from(text.matchAll(NAMED_SPLIT), (match) => match[1] ?? '').filter((phrase) => phrase.trim() && !/\b(?:vs\.?|versus)\s/i.test(`${phrase} `));
}

/** Whether every word of a field's name is in the phrase ("Game Type" names GAME_TYPE). */
function phraseNamesField(phraseWords: Set<string>, fieldName: string): boolean {
  const words = deterministicWords(fieldName);
  return words.size > 0 && Array.from(words).every((word) => phraseWords.has(word));
}

/**
 * The query with the splits its title or questions ask for (V11: "Warriors Wins by Season and Game Type"
 * grouped by season alone, so 2015 read 91: 3 preseason, 73 regular season and 15 playoff wins added up).
 * A split is a grouping the requirement declares, a field a "by …" phrase names, or, for a split by values
 * ("regular season vs playoffs"), the one text grouping of the source the tile does not use yet. Each is added
 * only where the tile still runs whatever the rows; a KPI given a split becomes a breakdown.
 */
export function withAskedSplits(
  query: TileQuery,
  descriptor: DatasetDescriptor,
  role: AppBuilderComponentRole,
  texts: string[],
  requirements: AppBuildRequirement[],
): { query: TileQuery; role: AppBuilderComponentRole } {
  const fields = splitFields(descriptor);
  const measureWords = new Set(query.measures.flatMap((selection) => Array.from(deterministicWords(selection.measure))));
  const grouped = (current: TileQuery, field: (typeof fields)[number]) => current.dimensions.some((dimension) => sameDatasetName(dimension.field, field.name, field.qualifiedId));
  const asked: typeof fields = [];
  // A field the tile keeps to one value is not split by: "playoff wins" filtered to Playoffs is one series.
  const oneValue = (field: (typeof fields)[number]) => (query.filters ?? []).some((filter) => sameDatasetName(filter.field, field.name, field.qualifiedId)
    && filter.op === 'eq' && (filter.values?.length ?? 0) === 1);
  const ask = (field: (typeof fields)[number] | undefined) => {
    if (!field || grouped(query, field) || asked.includes(field) || oneValue(field)) return;
    if (Array.from(deterministicWords(field.name)).every((word) => measureWords.has(word))) return;
    asked.push(field);
  };
  for (const requirement of requirements) {
    for (const dimension of requirement.dimensions) ask(fields.find((field) => sameDatasetName(dimension, field.name, field.qualifiedId)));
  }
  for (const text of texts) {
    for (const phrase of namedSplitPhrases(text)) {
      const words = deterministicWords(phrase);
      for (const field of fields) if (phraseNamesField(words, field.name)) ask(field);
    }
  }
  if (texts.some(asksForValueSplit)) {
    const ungrouped = fields.filter((field) => field.role === 'dimension' && field.type === 'string' && !grouped(query, field) && !asked.includes(field));
    if (ungrouped.length === 1) ask(ungrouped[0]);
  }
  const limit = role === 'detail' || role === 'evidence' ? 3 : 2;
  let next = query;
  for (const field of asked) {
    if (next.dimensions.length >= limit) break;
    const grain = field.role === 'time' ? (field.time?.grains.includes('month') ? 'month' : field.time?.grains[0]) : undefined;
    const candidate: TileQuery = { ...next, dimensions: [...next.dimensions, { field: field.name, ...(grain ? { timeGrain: grain } : {}) }] };
    if (tileQueryRunsWhateverTheRows(validateTileQuery(descriptor, candidate))) next = candidate;
  }
  return { query: next, role: next !== query && role === 'kpi' ? 'breakdown' : role };
}

/**
 * A title never names a split its query does not apply (V11). In "Wins by Season and Game Type (2014–2018)"
 * each grouping after "by" must be one the query groups by: one naming another field of the source is taken
 * out ("Wins by Season (2014–2018)"), and so is one naming nothing, unless a grouping of the query is still
 * unnamed (a "Year" for SEASON). A grouping that names a selected measure ("by revenue") is a ranking, kept.
 */
export function titleNamingOnlyAppliedSplits(title: string, descriptor: DatasetDescriptor, query: TileQuery): string {
  const match = /^(.*?\S)\s+(by|per)\s+(.+?)(\s*\([^)]*\))?\s*$/i.exec(title);
  if (!match) return title;
  const [, head, joiner, list, parenthetical = ''] = match;
  const items = list!.split(/\s*(?:,|\band\b|&|\/)\s*/i).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return title;
  const fields = splitFields(descriptor);
  const grains = new Set(['day', 'daily', 'week', 'weekly', 'month', 'monthly', 'quarter', 'quarterly', 'year', 'yearly']);
  const timeGrouped = query.dimensions.some((dimension) => Boolean(dimension.timeGrain) || fields.some((field) => field.role === 'time' && sameDatasetName(dimension.field, field.name, field.qualifiedId)));
  const groupedNamedBy = (words: Set<string>) => query.dimensions.find((dimension) => {
    const fieldWords = deterministicWords(dimension.field);
    return fieldWords.size > 0 && (Array.from(fieldWords).every((word) => words.has(word)) || Array.from(words).every((word) => fieldWords.has(word)));
  });
  const named = new Set<string>();
  const unknown: string[] = [];
  const kept = items.filter((item) => {
    const words = deterministicWords(item);
    const dimension = groupedNamedBy(words);
    if (dimension) { named.add(dimension.field); return true; }
    if (Array.from(words).some((word) => grains.has(word)) && timeGrouped) return true;
    if (query.measures.some((selection) => phraseNamesField(words, selection.measure))) return true;
    if (fields.some((field) => phraseNamesField(words, field.name))) return false;
    unknown.push(item);
    return true;
  });
  // A word that names no field may still be what a grouping of the query is called ("Year" for SEASON).
  const unnamedGroupings = query.dimensions.filter((dimension) => !named.has(dimension.field)).length;
  const keptItems = kept.filter((item) => !unknown.includes(item) || unknown.indexOf(item) < unnamedGroupings);
  if (keptItems.length === items.length) return title;
  return keptItems.length
    ? `${head} ${joiner} ${keptItems.join(' and ')}${parenthetical}`
    : `${head}${parenthetical}`;
}

function plannerCapabilities(candidate: AppSourceCatalogRecord): Record<string, unknown> {
  const descriptor = candidate.capabilities.dataset;
  return {
    measures: [...candidate.capabilities.measures],
    dimensions: [...candidate.capabilities.dimensions],
    filters: [...candidate.capabilities.filters],
    outputs: [...candidate.capabilities.outputs],
    ...(descriptor ? {
      dataset: {
        id: descriptor.id,
        kind: descriptor.kind,
        operations: [...descriptor.operations],
        fields: datasetPhysicalFields(descriptor)
          .filter((field) => field.status === 'approved')
          .map((field) => ({ name: field.name, qualifiedId: field.qualifiedId, role: field.role, type: field.type, timeGrains: field.time?.grains ?? [] })),
        measures: datasetMeasures(descriptor)
          .filter((measure) => measure.status === 'approved')
          .map((measure) => ({ name: measure.name, qualifiedId: measure.qualifiedId, aggregation: measure.aggregation, allowedAggs: [...measure.allowedAggs] })),
      },
    } : {}),
  };
}

function sameDatasetName(value: string, name: string, qualifiedId: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === name.toLowerCase() || normalized === qualifiedId.toLowerCase();
}

function wordsMatch(question: string, candidate: string): boolean {
  const requested = deterministicWords(question);
  if (requested.size === 0) return false;
  const available = deterministicWords(candidate);
  return Array.from(requested).some((token) => available.has(token));
}

function normalizeClarifications(value: unknown): Pick<AppBuildFrame, 'clarificationQuestions'> | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const questions = value.slice(0, 3).flatMap((raw, index): AppBuildClarification[] => {
    const record = objectValue(raw);
    const question = stringValue(record?.question);
    if (!record || !question || !Array.isArray(record.choices)) return [];
    const choices = record.choices.slice(0, 5).flatMap((choiceRaw, choiceIndex) => {
      const choice = objectValue(choiceRaw);
      const label = stringValue(choice?.label);
      if (!choice || !label) return [];
      return [{
        id: stringValue(choice.id) ?? `choice-${choiceIndex + 1}`,
        label: plainPlannerText(label),
        ...(stringValue(choice.description) ? { description: plainPlannerText(stringValue(choice.description)!) } : {}),
      }];
    });
    if (choices.length < 2) return [];
    return [{
      id: stringValue(record.id) ?? `clarification-${index + 1}`,
      question: plainPlannerText(question),
      choices,
      required: record.required !== false,
      ...(stringValue(record.answerId) ? { answerId: stringValue(record.answerId) } : {}),
    }];
  });
  return questions.length ? { clarificationQuestions: questions } : {};
}

function inferRole(candidate: AppSourceCatalogRecord, index: number): AppBuilderComponentRole {
  const text = `${candidate.title} ${candidate.capabilities.chartType ?? ''}`.toLowerCase();
  if (index === 0 && candidate.capabilities.measures.length) return 'kpi';
  if (/trend|time|date|week|month|line/.test(text)) return 'trend';
  if (/region|segment|category|channel|bar|rank/.test(text)) return 'breakdown';
  return 'detail';
}

function inferView(candidate: AppSourceCatalogRecord, index: number): AppBuilderComponentView {
  const allowed = candidate.capabilities.allowedVisualizations ?? [];
  const preferred = candidate.capabilities.chartType ?? allowed[0] ?? '';
  if (/line|area/.test(preferred)) return 'line';
  if (/bar|column|rank/.test(preferred)) return 'bar';
  if (index === 0 && candidate.capabilities.measures.length) return 'kpi';
  return 'table';
}

/**
 * A role in the planner's own words: the six roles, and the near words a model uses for them ("comparison",
 * "chart", "table", "metric"). A requirement or tile with a near word is kept, not dropped (V12: "did not return
 * grounded requirements" when every role read as something else).
 */
const PLANNER_ROLE_WORDS: Record<string, AppBuilderComponentRole> = {
  kpi: 'kpi', metric: 'kpi', headline: 'kpi', number: 'kpi', total: 'kpi', summary: 'kpi',
  trend: 'trend', time_series: 'trend', timeseries: 'trend', over_time: 'trend',
  breakdown: 'breakdown', comparison: 'breakdown', compare: 'breakdown', chart: 'breakdown', split: 'breakdown', ranking: 'breakdown', distribution: 'breakdown',
  detail: 'detail', table: 'detail', list: 'detail', details: 'detail',
  narrative: 'narrative', text: 'narrative', insight: 'narrative',
  evidence: 'evidence',
};

function appRole(value: unknown): AppBuilderComponentRole | undefined {
  if (typeof value !== 'string') return undefined;
  return PLANNER_ROLE_WORDS[value.trim().toLowerCase().replace(/[\s-]+/g, '_')];
}

/** A view in the planner's own words: "stacked_bar", "column" and "bar_chart" are bars, "area" a line, "metric" a KPI. */
function appView(value: unknown): AppBuilderComponentView | undefined {
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  if (word === 'kpi' || /^(?:metric|number|kpi[_ -]?card|big[_ -]?number|scorecard)$/.test(word)) return 'kpi';
  if (/^(?:line|area)(?:[_ -]?chart)?$/.test(word)) return 'line';
  if (/^(?:(?:stacked|grouped|horizontal)[_ -]?)?(?:bar|column)s?(?:[_ -]?chart)?$/.test(word) || word === 'chart') return 'bar';
  if (/^(?:table|grid|detail|pivot)(?:[_ -]?table)?$/.test(word)) return 'table';
  return undefined;
}

const PLANNER_FILTER_OPERATORS: Record<string, TileFilterOperator> = {
  eq: 'eq', '=': 'eq', '==': 'eq', equals: 'eq', equal: 'eq', is: 'eq',
  neq: 'neq', ne: 'neq', '!=': 'neq', '<>': 'neq', not_equals: 'neq', not_equal: 'neq',
  in: 'in', not_in: 'not_in', 'not in': 'not_in',
  gt: 'gt', '>': 'gt', gte: 'gte', '>=': 'gte', lt: 'lt', '<': 'lt', lte: 'lte', '<=': 'lte',
  between: 'between', contains: 'contains', like: 'contains', ilike: 'contains',
};

/**
 * A tile query in the shape the planner wrote it, read as a TileQuery (V12: Cortex wrote
 * `"measures": ["WINS"]` and `{"op": "equals", "value": "Playoffs"}`, so every AI tile query was refused and
 * replaced by one with no filters). Field names, measures and values are kept exactly as written: this only
 * fixes the shape, and the query is validated against the source's approved fields as before.
 */
export function plannerTileQuery(raw: unknown): unknown {
  const record = objectValue(raw);
  if (!record) return raw;
  const name = (item: unknown, ...keys: string[]): string | undefined => {
    if (typeof item === 'string') return stringValue(item);
    const object = objectValue(item);
    return object ? keys.map((key) => stringValue(object[key])).find(Boolean) : undefined;
  };
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const dimensions = list(record.dimensions ?? record.groupBy ?? record.group_by).flatMap((item) => {
    const field = name(item, 'field', 'name', 'dimension', 'column');
    if (!field) return [];
    const object = objectValue(item);
    const timeGrain = object ? stringValue(object.timeGrain ?? object.grain) : undefined;
    const alias = object ? stringValue(object.alias) : undefined;
    return [{ field, ...(timeGrain ? { timeGrain } : {}), ...(alias ? { alias } : {}) }];
  });
  const measures = list(record.measures ?? record.metrics).flatMap((item) => {
    const measure = name(item, 'measure', 'name', 'field', 'metric');
    const alias = objectValue(item) ? stringValue(objectValue(item)!.alias) : undefined;
    return measure ? [{ measure, ...(alias ? { alias } : {}) }] : [];
  });
  const filters = list(record.filters ?? record.where).flatMap((item) => {
    const object = objectValue(item);
    const field = object ? name(object, 'field', 'name', 'dimension', 'column') : undefined;
    const opWord = object ? stringValue(object.op ?? object.operator) ?? (object.values !== undefined || object.value !== undefined ? 'eq' : undefined) : undefined;
    const op = opWord ? PLANNER_FILTER_OPERATORS[opWord.toLowerCase()] : undefined;
    if (!object || !field || !op) return [];
    const supplied = object.values ?? object.value;
    const values = Array.isArray(supplied)
      ? supplied
      : objectValue(supplied) && ('from' in objectValue(supplied)! || 'to' in objectValue(supplied)!)
        ? [objectValue(supplied)!.from, objectValue(supplied)!.to]
        : supplied === undefined ? undefined : [supplied];
    return [{ field, op: op === 'eq' && values && values.length > 1 ? 'in' as const : op, ...(values ? { values } : {}) }];
  });
  const kept: Record<string, unknown> = { dimensions, measures };
  if (filters.length) kept.filters = filters;
  // A key that claims authority (a revision, SQL, trust) stays, so the query is refused as before.
  for (const [key, value] of Object.entries(record)) {
    if (/revision|sql|snapshot|trust|contract|fingerprint|binding|source/i.test(key)) kept[key] = value;
  }
  for (const key of ['calculations', 'rollups', 'having', 'comparison', 'detail', 'detailColumns', 'respectsGlobalFilters'] as const) {
    if (record[key] !== undefined) kept[key] = record[key];
  }
  if (typeof record.limit === 'number' && Number.isInteger(record.limit) && record.limit > 0) kept.limit = record.limit;
  const orderBy = list(record.orderBy).flatMap((item) => {
    const object = objectValue(item);
    const alias = object ? stringValue(object.alias ?? object.field) : undefined;
    const direction = object ? stringValue(object.direction ?? object.dir ?? object.order)?.toLowerCase() : undefined;
    return alias && (direction === 'asc' || direction === 'desc') ? [{ alias, direction }] : [];
  });
  if (orderBy.length) kept.orderBy = orderBy;
  return kept;
}

/** A requirement's filter fields: "TEAM = Golden State Warriors" and `{field: "TEAM"}` both name TEAM. */
function plannerFilterFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    const object = objectValue(item);
    const text = object ? stringValue(object.field ?? object.name) : stringValue(item);
    if (!text) return [];
    const field = text.split(/\s*(?:=|!=|<>|>=|<=|>|<|\bbetween\b|\bin\b|\bcontains\b|\bis\b|:)\s*/i)[0]!.trim();
    return field && /^[A-Za-z_][A-Za-z0-9_. ]*$/.test(field) ? [field] : [];
  })));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())))
    : [];
}
