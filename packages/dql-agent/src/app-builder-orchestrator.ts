import type {
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
  tileQueryValidationRuns,
  validateTileQuery,
} from '@zlens/core';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';
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
}

/**
 * App-specific orchestration boundary. It shares a host provider adapter but
 * owns a structured, stateful build brief rather than invoking Ask AI's answer
 * state machine. At most one provider call is made and it can reference only
 * the supplied candidate IDs.
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

  let completion: string | AppBuilderPlannerCompletionResult | undefined;
  try {
    completion = await input.complete({
      system: appBuilderSystemPrompt(),
      user: appBuilderUserPrompt(input, candidates),
    });
  } catch (error) {
    throw new Error(`APP_BUILD_PLANNER_PROVIDER_FAILED: the configured App Builder provider did not return a build brief. ${error instanceof Error ? error.message : String(error)}`);
  }
  // A host hook that finds no configured provider declines with undefined.
  // That is "no planner configured", not a malformed answer: plan offline.
  if (completion === undefined) {
    return ensureAppBuildStructure(
      ensureRequiredSources(deterministicBrief(input, candidates), candidates, requiredSourceIds),
      candidates,
    );
  }
  const raw = typeof completion === 'string' ? completion : completion?.content;
  const providerId = typeof completion === 'string'
    ? undefined
    : appBuilderPlannerProviderId(completion?.providerId);
  const parsed = parsePlannerJson(raw);
  if (!parsed) {
    throw new Error('APP_BUILD_PLANNER_OUTPUT_INVALID: the configured App Builder provider did not return valid JSON for the build brief.');
  }
  const allowedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const requirements = normalizeRequirements(parsed.requirements);
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const components = normalizeComponents(
    parsed.components,
    new Map(candidates.map((candidate) => [candidate.sourceId, candidate])),
    requirementIds,
    new Map(requirements.map((requirement) => [requirement.id, requirement])),
  );
  if (requirements.length === 0) {
    throw new Error('APP_BUILD_PLANNER_OUTPUT_INVALID: the configured App Builder provider did not return grounded requirements.');
  }
  const frame = normalizeFrame(parsed.frame, prompt, input.audience);
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
    requirements,
    components,
    pages: normalizePlannedPages(parsed.pages, components),
    filters: [],
    navigation: [],
    crossFilters: [],
    detailDrills: [],
    selectedSourceIds: Array.from(new Set(components.map((component) => component.sourceId))),
    candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
    warnings: [],
  }, candidates, requiredSourceIds), candidates, parsed);
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
    const role = match?.role ?? inferRole(candidate, components.length);
    const query = candidate.capabilities.dataset
      ? deterministicDatasetQuery(candidate.capabilities.dataset, match, role)
      : undefined;
    // A saved query's result fields (design D1) that can't express this still show its result as it is.
    if (candidate.capabilities.dataset && !query && !candidate.capabilities.dataset.result) {
      warnings.push(`You added ${plannerSourceName(candidate.title)}, but it can't answer this with its approved fields yet.`);
      continue;
    }
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
  if (!capabilityValuesMatch([
    ...requirement.measures,
    ...requirement.dimensions,
    ...requirement.filters,
  ], [requirement.question])) return false;

  // A declared measure is decisive: generic words in titles or descriptions
  // can never substitute a different metric into requirement coverage.
  if (!capabilityValuesMatch(requirement.measures, [
    ...candidate.capabilities.measures,
    ...candidate.capabilities.outputs,
  ])) return false;
  if (!capabilityValuesMatch(requirement.dimensions, candidate.capabilities.dimensions)) return false;
  if (!capabilityValuesMatch(requirement.filters, candidate.capabilities.filters)) return false;
  return true;
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
      deterministicWarnings.push(`${plannerSourceName(candidate.title)} can't answer this with its approved fields yet.`);
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

/** "Certified saved query", "Certified Dataset", "Metrics · Not certified yet" (the App glossary, T1). */
export function sourceKindAndTrust(candidate: Pick<AppSourceCatalogRecord, 'kind' | 'trust' | 'capabilities'>): string {
  const kind = candidate.capabilities.dataset?.kind === 'semantic'
    ? 'Metrics'
    : candidate.capabilities.dataset
      ? 'Dataset'
      : candidate.capabilities.semanticModelId || candidate.kind === 'semantic'
        ? 'Metrics'
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
      ? `${name} can't answer “${question}” with its approved fields yet.`
      : `${name} can't answer what you asked with its approved fields yet.`;
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
  return [
    'You are the DQL App Builder planner. Produce one stateful analytical App build brief, not a prose answer.',
    'Use only sourceId values present in the supplied candidate cards. Never invent a source, field, capability, or trust state.',
    'Draft and review sources may be recommended, but their trust must not be upgraded.',
    'Return JSON only with keys frame, requirements, components, pages, filters, navigation, crossFilters, and detailDrills.',
    'frame: {goal, decision?, audience?, metrics[], dimensions[], grain?, timeRange?, comparison?, filters[], desiredOutput?, clarificationQuestions?}.',
    'requirements: [{id, question, role, required, measures[], dimensions[], filters[], grain?}]. role is kpi, trend, breakdown, detail, narrative, or evidence.',
    'components: [{id, title, sourceId, query?, requirementIds[], role, view, style?, rationale}]. query is a TileQuery using only the approved Dataset fields on that source card. view is kpi, line, bar, or table.',
    'style is optional chart styling: {labels?: none|last|all, format?: number|compact|currency|percent, sort?: none|asc|desc, stack?: boolean, referenceLines?: [{value, label?}], bands?: [{from, to, label?}]}. Add a reference line or band only for a target or threshold the user stated; never invent one.',
    'pages: [{id, title, componentIds[], sections:[{id,title,kind,componentIds[]}]}]. section kind is exec_summary, kpi_band, insight, or appendix. Every component must appear on one page.',
    'filters: [{id,label,field,scope,pageId?,componentIds[]}]. field must be one exact approved physical Dataset field for every named component; scope is page or app.',
    'navigation: [{fromComponentId,toPageId}]. crossFilters: [{fromComponentId,fromField,toComponentId,toField}], where fromField is an exact selected dimension output and toField is an exact approved physical target field on the same page.',
    'detailDrills: [{pageId,componentId,fields[]}], where every field is an exact approved physical Dataset field. Never write SQL, joins, source revisions, results, or trust claims.',
    'Prefer the fewest components that cover the request. Ask a clarification only when a material choice cannot be made from supplied evidence.',
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

function parsePlannerJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
    const question = stringValue(record.question);
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
      filters: stringArray(record.filters),
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
      ? normalizedDatasetQuery(record.query, candidate.capabilities.dataset, primaryRequirement, role)
      : undefined;
    // A Dataset card must always carry a validated, field-level query. Do not
    // fall back to a legacy block tile when its governed descriptor cannot
    // express the requested component. A saved query's result fields
    // (design D1) are not a row-level contract: its result shows as it is.
    if (candidate.capabilities.dataset && !query && !candidate.capabilities.dataset.result) return [];
    // Style is presentation only: malformed fields are dropped, never fatal.
    const style = readDashboardVizStyle(record.style, `components[${index}].style`, () => undefined);
    return [{
      id,
      title: datasetComponentTitle(stringValue(record.title) ?? id, candidate.capabilities.dataset, query, role),
      sourceId,
      ...(query ? { query } : {}),
      requirementIds: selectedRequirementIds,
      role,
      view,
      ...(style ? { style } : {}),
      rationale: stringValue(record.rationale) ?? 'Selected from the bounded App source candidate set.',
    }];
  });
}

function normalizedDatasetQuery(
  raw: unknown,
  descriptor: DatasetDescriptor,
  requirement: AppBuildRequirement | undefined,
  role: AppBuilderComponentRole,
): TileQuery | undefined {
  const supplied = normalizeTileQuery(raw);
  if (supplied && tileQueryValidationRuns(validateTileQuery(descriptor, supplied))) return supplied;
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
      if (tileQueryValidationRuns(validateTileQuery(descriptor, query))) return query;
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
  if (requirement.filters.length > 0 && !requirement.filters.every((required) => (query.filters ?? []).some((filter) => {
    const field = datasetPhysicalFields(descriptor).find((candidate) => sameDatasetName(filter.field, candidate.name, candidate.qualifiedId));
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
  if (selected.length === 0) return title;
  const titleWords = deterministicWords(title);
  const namesUnselected = datasetMeasures(descriptor).filter((measure) => (
    !selected.some((selectedMeasure) => selectedMeasure.qualifiedId === measure.qualifiedId)
    && Array.from(deterministicWords(measure.name)).some((word) => titleWords.has(word))
  ));
  if (namesUnselected.length === 0) return title;
  const measureLabel = selected[0]!.name;
  const dimension = query.dimensions[0]?.field;
  if (role === 'trend' && dimension) return `${measureLabel} over time`;
  if ((role === 'breakdown' || role === 'detail' || role === 'evidence') && dimension) return `${measureLabel} by ${dimension}`;
  return measureLabel;
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
        label,
        ...(stringValue(choice.description) ? { description: stringValue(choice.description) } : {}),
      }];
    });
    if (choices.length < 2) return [];
    return [{
      id: stringValue(record.id) ?? `clarification-${index + 1}`,
      question,
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

function appRole(value: unknown): AppBuilderComponentRole | undefined {
  return value === 'kpi' || value === 'trend' || value === 'breakdown' || value === 'detail'
    || value === 'narrative' || value === 'evidence' ? value : undefined;
}

function appView(value: unknown): AppBuilderComponentView | undefined {
  return value === 'kpi' || value === 'line' || value === 'bar' || value === 'table' ? value : undefined;
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
