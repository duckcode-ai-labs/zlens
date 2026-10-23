import {
  compareWarehouseTargets,
  getDialect,
  loadProjectConfig,
  semanticDimensionReference,
  type ComposeQueryResult,
  type MetricDefinition,
  type SemanticLayer,
  type SemanticExecutionReceiptV1,
  type SemanticTargetBindingV1,
  type WarehouseTargetIdentityV1,
} from '@zlens/core';
import type { PhysicalRelationBindingV1 } from '@zlens/agent';
import {
  compileDbtCloudSemanticQuery,
  listDbtCloudCompatibleDimensions,
  testDbtCloudSemanticConnection,
  type DbtCloudSemanticTestResult,
} from './dbt-cloud-semantic.js';
import { compileMetricFlowQuery, hasDbtSemanticManifest, hasMetricFlowCli, listMetricFlowDimensions, managedMetricFlowBin, MetricFlowUnavailableError, projectHasDbtProject, resolveMetricFlowCli, resolveSemanticManifestPath } from './metricflow.js';
import { readFileSync, statSync } from 'node:fs';
import {
  getEffectiveDbtCloudSemanticSettings,
  getSemanticRuntimeSettings,
  semanticRuntimeDraft,
  type SemanticRuntimePreference,
  type SemanticRuntimeSettingsInput,
} from './semantic-runtime-settings.js';

export type SemanticRuntimeAdapterId = 'native' | 'metricflow-cli' | 'dbt-cloud';
export type SemanticMetricExecutionStatus = 'ready' | 'requires_setup' | 'unsupported';
export type SemanticRuntimeHavingOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';

export interface SemanticRuntimeProjectConfig {
  semanticLayer?: { provider?: string; projectPath?: string };
  dbt?: { projectDir?: string; profilesDir?: string };
}

export interface SemanticRuntimeAdapterStatus {
  id: SemanticRuntimeAdapterId;
  label: string;
  bundled: boolean;
  configured: boolean;
  tested: boolean;
  ready: boolean;
  source: 'bundled' | 'local' | 'env' | 'none';
  detail: string;
  /** Positive runtime capability; declarations alone cannot grant it. */
  capabilities?: { having: boolean };
}

export interface SemanticRuntimeStatus {
  preference: SemanticRuntimePreference;
  active: SemanticRuntimeAdapterId;
  adapters: SemanticRuntimeAdapterStatus[];
  setup: string | null;
}

export interface SemanticMetricExecutionCapability {
  status: SemanticMetricExecutionStatus;
  engine: SemanticRuntimeAdapterId | null;
  reason: string | null;
  reasonCode?: 'SEMANTIC_SOURCE_DRIFT';
  semanticCatalogFingerprint?: string;
}

export interface SemanticRuntimeQueryRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  /** A governed post-aggregate metric predicate. */
  having?: Array<{ metric: string; operator: SemanticRuntimeHavingOperator; values: string[] }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
  engine?: 'native' | 'metricflow' | SemanticRuntimeAdapterId;
}

export type SemanticRuntimeBindingRole = 'dimension' | 'time_dimension' | 'filter' | 'order_by';

export interface SemanticRuntimeBinding {
  role: SemanticRuntimeBindingRole;
  /** Stable DQL/model-scoped identity shown to the analyst. */
  authoringReference: string;
  /** Exact dunder-qualified member sent to MetricFlow or dbt Cloud. */
  runtimeReference: string;
  /** Metric-relative entity path selected ahead of the member's own qualified name. */
  entityPath: string[];
  status: 'resolved' | 'ambiguous';
}

export interface SemanticRuntimePathCandidate {
  /** Stable evidence identity used by Ask clarification and retry. */
  id: string;
  label: string;
  description: string;
  authoringReference: string;
  runtimeReference: string;
  entityPath: string[];
  /** DQL-safe reference that preserves the model identity and the selected path. */
  selectionReference: string;
}

export interface SemanticRuntimeTraceStep {
  id:
    | 'resolve_members'
    | 'bind_entity_paths'
    | 'compile_semantic_query'
    | 'validate_execution_target'
    | 'preflight_physical_sql'
    | 'execute_query';
  label: string;
  status: 'completed' | 'failed' | 'not_started';
  detail: string;
}

export interface SemanticRuntimeTrace {
  version: 1;
  adapter: SemanticRuntimeAdapterId;
  status: 'compiled' | 'ambiguous' | 'failed';
  authoringRequest: SemanticRuntimeQueryRequest;
  runtimeRequest?: SemanticRuntimeQueryRequest;
  bindings: SemanticRuntimeBinding[];
  warnings: string[];
  steps: SemanticRuntimeTraceStep[];
  /** Redacted compiler-to-warehouse target proof shown in Trust & Steps. */
  targetBinding?: SemanticTargetBindingV1;
  /** Terminal receipt added by the shared execution gateway. */
  executionReceipt?: SemanticExecutionReceiptV1;
  failure?: {
    code: 'SEMANTIC_PATH_AMBIGUOUS' | 'SEMANTIC_COMPILATION_FAILED' | 'SEMANTIC_SOURCE_DRIFT';
    phase: 'capability' | 'path_binding' | 'compilation';
    message: string;
    environmentId?: string;
    semanticCatalogFingerprint?: string;
    metricInventoryState?: 'missing' | 'partial' | 'complete';
    unavailableMetrics?: string[];
    safeActions?: string[];
    candidates?: SemanticRuntimePathCandidate[];
  };
}

export interface SemanticRuntimeCompileContext {
  projectRoot: string;
  projectConfig: SemanticRuntimeProjectConfig;
  detectedProvider?: string | null;
  semanticLayer: SemanticLayer;
  driver?: string;
  tableMapping?: Record<string, string>;
  /**
   * Request-local Ask evidence. MetricFlow has no per-query dbt target flag,
   * so this is used to prove its default dbt profile target agrees with the
   * warehouse selected for this Ask before the CLI is invoked. The Ask
   * provenance fingerprint is deliberately not treated as warehouse proof.
   */
  metricFlowAskTarget?: MetricFlowAskTargetContext;
  /**
   * The run's deadline/cancellation. A semantic compile spawns an external
   * process; without this the process outlives the question that asked for it
   * and the run's own deadline cannot stop it.
   */
  signal?: AbortSignal;
}

/**
 * The target evidence available only on an Ask request. It is intentionally
 * additive: ordinary semantic blocks continue to use their existing runtime
 * target-binding flow, while Ask cannot silently compile through a dbt profile
 * whose default target is a different warehouse.
 */
export interface MetricFlowAskTargetContext {
  snapshotId: string;
  /** Request-local provenance for physical bindings, never a MF target proof. */
  executionTargetFingerprint: string;
  /** The selected ZLens connection rendered as a redacted warehouse identity. */
  selectedExecutionTarget: WarehouseTargetIdentityV1;
  /** Exact bindings admitted to this Ask request on the selected target. */
  physicalBindings: readonly PhysicalRelationBindingV1[];
  /**
   * The actual default target MetricFlow will obtain from profiles.yml. It is
   * absent when ZLens cannot resolve a complete default dbt target, which is a
   * pre-compilation refusal rather than permission to guess.
   */
  profileTarget?: {
    expectedTarget: WarehouseTargetIdentityV1;
    profileName?: string;
    targetName?: string;
    profilesPath?: string;
  };
}

export interface SemanticRuntimeCompileResult extends ComposeQueryResult {
  engine: SemanticRuntimeAdapterId;
  /**
   * The governed request as the USER expressed it (preferably model-scoped
   * dimension identities), after deterministic normalization. Echoed to callers
   * and back into `.dql` sources — it must never be replaced by adapter-specific
   * MetricFlow spellings such as `entity__dim`.
   */
  effectiveRequest: SemanticRuntimeQueryRequest;
  /**
   * The request actually SENT to a full runtime (MetricFlow / dbt Cloud), with
   * dimensions/filters/order-by/time qualified to entity-qualified names. Absent
   * for native compilation (which speaks bare names). Diagnostic only.
   */
  runtimeRequest?: SemanticRuntimeQueryRequest;
  /** Auditable authoring → runtime bindings and compiler phases. */
  semanticTrace: SemanticRuntimeTrace;
  /** Non-fatal advisories (e.g. a time grain clamped up to the column's base). */
  warnings?: string[];
}

export class SemanticRuntimeRequiredError extends Error {
  readonly code = 'SEMANTIC_RUNTIME_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticRuntimeRequiredError';
  }
}

/**
 * MetricFlow reads dbt's profile default target and its CLI currently exposes
 * no per-query target selection. Ask must therefore stop before dispatch when
 * that default cannot be proven to be the selected warehouse.
 */
export class MetricFlowAskTargetMismatchError extends SemanticRuntimeRequiredError {
  readonly details: {
    adapter: 'metricflow-cli';
    phase: 'capability';
    reason: 'profile_target_missing' | 'profile_target_mismatch' | 'binding_target_mismatch';
    profileName?: string;
    targetName?: string;
    mismatchFields?: string[];
    selectedTargetFingerprint: string;
    profileTargetFingerprint?: string;
    snapshotId: string;
    safeActions: string[];
  };

  constructor(input: {
    target: MetricFlowAskTargetContext;
    reason: 'profile_target_missing' | 'profile_target_mismatch' | 'binding_target_mismatch';
    mismatchFields?: string[];
  }) {
    const profileName = input.target.profileTarget?.profileName ?? 'default';
    const targetName = input.target.profileTarget?.targetName ?? 'default';
    const profileLabel = `dbt profile "${profileName}" target "${targetName}"`;
    const message = input.reason === 'binding_target_mismatch'
      ? 'The exact physical metadata selected for this Ask request belongs to a different execution target. '
        + 'ZLens did not invoke local MetricFlow. Refresh the selected connection metadata and retry.'
      : input.reason === 'profile_target_missing'
        ? 'Local MetricFlow cannot prove that its default dbt profile target matches the warehouse selected for this Ask request. '
          + 'ZLens did not invoke MetricFlow. Configure a complete default target in profiles.yml for the selected ZLens connection, then retry.'
        : `Local MetricFlow uses ${profileLabel}, which does not match the warehouse selected for this Ask request`
          + `${input.mismatchFields?.length ? ` (${input.mismatchFields.join(', ')})` : ''}. `
          + 'MetricFlow CLI has no per-query dbt target override, so ZLens did not invoke it. '
          + 'Select the matching ZLens connection or make the dbt default target match it, then retry.';
    super(message);
    this.name = 'MetricFlowAskTargetMismatchError';
    this.details = {
      adapter: 'metricflow-cli',
      phase: 'capability',
      reason: input.reason,
      ...(input.target.profileTarget?.profileName ? { profileName: input.target.profileTarget.profileName } : {}),
      ...(input.target.profileTarget?.targetName ? { targetName: input.target.profileTarget.targetName } : {}),
      ...(input.mismatchFields?.length ? { mismatchFields: [...input.mismatchFields] } : {}),
      selectedTargetFingerprint: input.target.selectedExecutionTarget.identityFingerprint,
      ...(input.target.profileTarget?.expectedTarget
        ? { profileTargetFingerprint: input.target.profileTarget.expectedTarget.identityFingerprint }
        : {}),
      snapshotId: input.target.snapshotId,
      safeActions: ['select_matching_connection', 'configure_dbt_profile_target', 'refresh_snapshot'],
    };
  }
}

/**
 * A semantic Dataset metric filter is post-aggregate. A raw WHERE fallback
 * would alter the metric, so adapters must advertise this exact operation.
 */
export class SemanticRuntimeHavingUnsupportedError extends Error {
  readonly code = 'SEMANTIC_HAVING_UNSUPPORTED';

  constructor(readonly adapter: SemanticRuntimeAdapterId) {
    super(`${adapter} does not advertise support for governed post-aggregate metric filters. Remove the total filter or select a Dataset source whose current semantic adapter supports it.`);
    this.name = 'SemanticRuntimeHavingUnsupportedError';
  }
}

export class SemanticSourceDriftError extends Error {
  readonly code = 'SEMANTIC_SOURCE_DRIFT';
  readonly details: {
    adapter: 'dbt-cloud';
    phase: 'capability';
    environmentId?: string;
    semanticCatalogFingerprint?: string;
    metricInventoryState: 'missing' | 'partial' | 'complete';
    requestedMetrics: string[];
    unavailableMetrics: string[];
    safeActions: string[];
    semanticTrace?: SemanticRuntimeTrace;
  };
  readonly semanticTrace?: SemanticRuntimeTrace;

  constructor(input: {
    environmentId?: string;
    semanticCatalogFingerprint?: string;
    metricInventoryState: 'missing' | 'partial' | 'complete';
    requestedMetrics: string[];
    unavailableMetrics: string[];
    authoringRequest?: SemanticRuntimeQueryRequest;
  }) {
    const unavailable = input.unavailableMetrics.length > 0
      ? ` The configured environment does not contain: ${input.unavailableMetrics.join(', ')}.`
      : '';
    super(
      'The configured dbt Cloud environment does not have a complete verified compiler metric inventory for this request.'
      + unavailable
      + ' Deploy the intended dbt semantic project, then reapply dbt Cloud Semantic Layer settings before running this metric.',
    );
    this.name = 'SemanticSourceDriftError';
    this.semanticTrace = input.authoringRequest
      ? {
          version: 1,
          adapter: 'dbt-cloud',
          status: 'failed',
          authoringRequest: input.authoringRequest,
          bindings: [],
          warnings: [],
          steps: [
            { id: 'resolve_members', label: 'Verify selected metrics in the compiler inventory', status: 'failed', detail: this.message },
            { id: 'bind_entity_paths', label: 'Bind metric-relative entity paths', status: 'not_started', detail: 'Capability verification failed before path binding.' },
            { id: 'compile_semantic_query', label: 'Compile with the selected semantic adapter', status: 'not_started', detail: 'Nothing was compiled.' },
            { id: 'execute_query', label: 'Execute the compiled warehouse query', status: 'not_started', detail: 'Nothing was executed.' },
          ],
          failure: {
            code: 'SEMANTIC_SOURCE_DRIFT',
            phase: 'capability',
            message: this.message,
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            ...(input.semanticCatalogFingerprint
              ? { semanticCatalogFingerprint: input.semanticCatalogFingerprint }
              : {}),
            metricInventoryState: input.metricInventoryState,
            unavailableMetrics: [...input.unavailableMetrics],
            safeActions: ['refresh_snapshot', 'reapply_semantic_runtime'],
          },
        }
      : undefined;
    this.details = {
      adapter: 'dbt-cloud',
      phase: 'capability',
      environmentId: input.environmentId,
      semanticCatalogFingerprint: input.semanticCatalogFingerprint,
      metricInventoryState: input.metricInventoryState,
      requestedMetrics: [...input.requestedMetrics],
      unavailableMetrics: [...input.unavailableMetrics],
      safeActions: ['refresh_snapshot', 'reapply_semantic_runtime'],
      ...(this.semanticTrace ? { semanticTrace: this.semanticTrace } : {}),
    };
  }
}

export class SemanticRuntimeCompilationError extends Error {
  readonly code = 'SEMANTIC_COMPILATION_FAILED';
  readonly adapter: Exclude<SemanticRuntimeAdapterId, 'native'>;

  constructor(adapter: Exclude<SemanticRuntimeAdapterId, 'native'>, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`${adapter} semantic compilation failed: ${message}`, {
      cause: error instanceof Error ? error : undefined,
    });
    this.name = 'SemanticRuntimeCompilationError';
    this.adapter = adapter;
  }
}

export class SemanticRuntimePathAmbiguityError extends Error {
  readonly code = 'SEMANTIC_PATH_AMBIGUOUS';
  readonly adapter: Exclude<SemanticRuntimeAdapterId, 'native'>;
  readonly details: {
    authoringReference: string;
    runtimeReference: string;
    candidates: SemanticRuntimePathCandidate[];
  };
  readonly semanticTrace: SemanticRuntimeTrace;

  constructor(input: {
    adapter: Exclude<SemanticRuntimeAdapterId, 'native'>;
    authoringRequest: SemanticRuntimeQueryRequest;
    runtimeRequest: SemanticRuntimeQueryRequest;
    bindings: SemanticRuntimeBinding[];
    warnings: string[];
    authoringReference: string;
    runtimeReference: string;
    candidates: SemanticRuntimePathCandidate[];
  }) {
    const choices = input.candidates.map((candidate) => candidate.label).join(' or ');
    const message = `The semantic dimension "${input.authoringReference}" is reachable through more than one governed entity path (${choices}). Choose the intended path before DQL compiles or executes the query.`;
    super(message);
    this.name = 'SemanticRuntimePathAmbiguityError';
    this.adapter = input.adapter;
    this.details = {
      authoringReference: input.authoringReference,
      runtimeReference: input.runtimeReference,
      candidates: input.candidates,
    };
    this.semanticTrace = {
      version: 1,
      adapter: input.adapter,
      status: 'ambiguous',
      authoringRequest: input.authoringRequest,
      runtimeRequest: input.runtimeRequest,
      bindings: [
        ...input.bindings.filter((binding) => binding.runtimeReference !== input.runtimeReference),
        {
          role: inferSemanticBindingRole(input.authoringRequest, input.authoringReference),
          authoringReference: input.authoringReference,
          runtimeReference: input.runtimeReference,
          entityPath: [],
          status: 'ambiguous',
        },
      ],
      warnings: input.warnings,
      steps: [
        { id: 'resolve_members', label: 'Resolve governed semantic members', status: 'completed', detail: 'Metric and dimension identities resolved from the pinned semantic snapshot.' },
        { id: 'bind_entity_paths', label: 'Bind metric-relative entity paths', status: 'failed', detail: message },
        { id: 'compile_semantic_query', label: 'Compile with the selected semantic adapter', status: 'not_started', detail: 'Compilation is gated until one entity path is selected.' },
        { id: 'execute_query', label: 'Execute the compiled warehouse query', status: 'not_started', detail: 'Nothing was executed.' },
      ],
      failure: {
        code: 'SEMANTIC_PATH_AMBIGUOUS',
        phase: 'path_binding',
        message,
        candidates: input.candidates,
      },
    };
  }
}

export function assertDbtCloudMetricInventory(
  projectRoot: string,
  metrics: string[],
  authoringRequest?: SemanticRuntimeQueryRequest,
): void {
  if (metrics.length === 0) return;
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const inventoryState = !cloud.metricNames
    ? 'missing'
    : cloud.metricInventoryComplete
      ? 'complete'
      : 'partial';
  const available = new Set((cloud.metricNames ?? []).map((name) => name.toLowerCase()));
  const unavailableMetrics = metrics.filter((metric) => !available.has(metric.toLowerCase()));
  if (inventoryState !== 'complete' || unavailableMetrics.length > 0) {
    throw new SemanticSourceDriftError({
      environmentId: cloud.environmentId,
      semanticCatalogFingerprint: cloud.semanticCatalogFingerprint,
      metricInventoryState: inventoryState,
      requestedMetrics: metrics,
      unavailableMetrics,
      ...(authoringRequest ? { authoringRequest } : {}),
    });
  }
}

const cloudProbeCache = new Map<string, { expiresAt: number; result: DbtCloudSemanticTestResult }>();

const OFFSET_PARAMETER_KEYS = new Set(['offsetwindow', 'offsettograin']);
const METRIC_DEPENDENCY_KEYS = new Set([
  'metric',
  'metrics',
  'inputmetric',
  'inputmetrics',
  'numerator',
  'denominator',
  'basemetric',
]);
const TIME_GRAIN_ORDER = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

/**
 * API-004 / AGT-001: MetricFlow requires `metric_time` whenever an input metric uses a time offset.
 * dbt stores that requirement in the metric definition, so normalize it once at
 * the shared runtime boundary instead of asking every UI and agent route to infer
 * the same compiler constraint independently.
 */
export function normalizeSemanticRuntimeQueryRequest(
  request: SemanticRuntimeQueryRequest,
  semanticLayer: SemanticLayer,
): SemanticRuntimeQueryRequest {
  const normalized: SemanticRuntimeQueryRequest = {
    ...request,
    metrics: [...request.metrics],
    dimensions: [...request.dimensions],
    filters: request.filters?.map((filter) => ({
      ...filter,
      ...(filter.values ? { values: [...filter.values] } : {}),
    })),
    having: request.having?.map((filter) => ({ ...filter, values: [...filter.values] })),
    orderBy: request.orderBy?.map((order) => ({ ...order })),
    ...(request.timeDimension ? { timeDimension: { ...request.timeDimension } } : {}),
  };
  // A saved query owns its own group-by contract, and an explicit `metric_time`
  // grouping already satisfies the compiler.
  if (normalized.savedQuery || hasMetricTimeGrouping(normalized.dimensions) || isMetricTimeName(normalized.timeDimension?.name)) {
    return normalized;
  }

  const metrics = semanticLayer.listMetrics(undefined, { includeVariants: true });
  const metricByName = new Map(metrics.map((metric) => [metric.name.toLowerCase(), metric]));
  const grains = new Set<string>();
  const visited = new Set<string>();
  for (const metricName of normalized.metrics) {
    const metric = semanticLayer.getMetric(metricName) ?? resolveMetricDefinition(metricName, metrics, metricByName);
    if (metric) collectMetricOffsetGrains(metric, metrics, metricByName, visited, grains);
  }
  const offsetGrain = finestTimeGrain(grains);
  // No offset metric in play — whatever time dimension the caller chose stands.
  if (!offsetGrain) return normalized;

  // An offset metric REQUIRES `metric_time`, and an entity-qualified time
  // dimension cannot satisfy it: MetricFlow rejects the query with "group-by-items
  // do not [include] 'metric_time'". This used to bail out whenever ANY time
  // dimension was set, so the requirement this function exists to enforce was
  // never applied to exactly the case that needs it — a block combining
  // `previous_month_acm` with `..._header.close_date` failed every compile.
  //
  // `metric_time` IS the metrics' aggregation time dimension, so substituting it
  // preserves the intent ("by month"); the caller's requested granularity is kept
  // and only falls back to the offset grain when none was given.
  return {
    ...normalized,
    timeDimension: {
      name: 'metric_time',
      granularity: normalized.timeDimension?.granularity ?? offsetGrain,
    },
  };
}

/** `metric_time`, with or without a grain suffix (`metric_time__month`). */
function isMetricTimeName(name: string | undefined): boolean {
  if (!name) return false;
  const value = name.replace(/["`\[\]]/g, '').toLowerCase();
  return value === 'metric_time' || value.startsWith('metric_time__');
}

function hasMetricTimeGrouping(dimensions: string[]): boolean {
  return dimensions.some((dimension) => {
    const value = dimension.replace(/["`\[\]]/g, '').toLowerCase();
    return value === 'metric_time' || value.startsWith('metric_time__');
  });
}

function collectMetricOffsetGrains(
  metric: MetricDefinition,
  metrics: MetricDefinition[],
  metricByName: Map<string, MetricDefinition>,
  visited: Set<string>,
  grains: Set<string>,
): void {
  const identity = metric.name.toLowerCase();
  if (visited.has(identity)) return;
  visited.add(identity);
  const typeParams = metric.typeParams
    ?? readRecord(readRecord(metric.source?.extra)?.raw)?.type_params;
  if (!typeParams || typeof typeParams !== 'object') return;

  collectOffsetGrains(typeParams, grains);
  for (const dependencyName of collectMetricDependencyNames(typeParams)) {
    const dependency = resolveMetricDefinition(dependencyName, metrics, metricByName);
    if (dependency) collectMetricOffsetGrains(dependency, metrics, metricByName, visited, grains);
  }
}

function collectOffsetGrains(value: unknown, grains: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOffsetGrains(item, grains);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = normalizeSemanticKey(key);
    if (OFFSET_PARAMETER_KEYS.has(normalizedKey)) {
      const grain = readTimeGrain(nested);
      if (grain) grains.add(grain);
    }
    collectOffsetGrains(nested, grains);
  }
}

function collectMetricDependencyNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (nested: unknown): void => {
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    const record = readRecord(nested);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (METRIC_DEPENDENCY_KEYS.has(normalizeSemanticKey(key))) collectNamedReferences(child, names);
      visit(child);
    }
  };
  visit(value);
  return names;
}

function collectNamedReferences(value: unknown, names: Set<string>): void {
  if (typeof value === 'string' && value.trim()) {
    names.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedReferences(item, names);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const key of ['name', 'metric', 'metric_name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) names.add(candidate.trim());
  }
}

function readTimeGrain(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeTimeGrain(value);
  const record = readRecord(value);
  if (!record) return undefined;
  for (const key of ['granularity', 'grain', 'value', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const grain = normalizeTimeGrain(candidate);
      if (grain) return grain;
    }
  }
  return undefined;
}

function normalizeTimeGrain(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return TIME_GRAIN_ORDER.includes(normalized) ? normalized : undefined;
}

function finestTimeGrain(grains: Set<string>): string | undefined {
  return TIME_GRAIN_ORDER.find((grain) => grains.has(grain));
}

function normalizeSemanticKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resolveMetricDefinition(
  name: string,
  metrics: MetricDefinition[],
  metricByName: Map<string, MetricDefinition>,
): MetricDefinition | undefined {
  const normalized = name.toLowerCase();
  return metricByName.get(normalized)
    ?? metrics.find((metric) => metric.name.toLowerCase().endsWith(`.${normalized}`)
      || normalized.endsWith(`.${metric.name.toLowerCase()}`));
}

const semanticManifestCache = new Map<string, { key: string; defines: boolean }>();

/** Does a dbt semantic manifest define at least one semantic model or metric? dbt writes an empty one on every parse. */
function semanticManifestDefinesSemantics(path: string): boolean {
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}|${stat.size}`;
  } catch {
    return false;
  }
  const cached = semanticManifestCache.get(path);
  if (cached?.key === key) return cached.defines;
  let defines = false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const entries = (value: unknown): number => Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
    defines = entries(parsed.semantic_models) > 0 || entries(parsed.metrics) > 0;
  } catch {
    defines = false;
  }
  semanticManifestCache.set(path, { key, defines });
  return defines;
}

/**
 * IS THIS PROJECT'S SEMANTIC LAYER ONE MetricFlow CAN READ?
 *
 * Local MetricFlow and dbt Cloud serve dbt semantic models and metrics. A
 * project whose metrics are DQL semantic-layer YAML (`semanticLayer.provider:
 * "dql"`, the default) has nothing for them to read: an `mf` executable that
 * happens to be on PATH used to become the active runtime anyway, and every
 * metric in the picker failed with "Local MetricFlow returned no compatible
 * dimensions" while Ask fell back to AI-written SQL (ZLens 0.1.0 e2e, F4).
 * Same rule as the semantic layer loader: an explicit dbt provider, or a dbt
 * semantic manifest that actually defines semantic models or metrics.
 */
export function projectHasDbtSemantics(projectRoot: string): boolean {
  const config = loadProjectConfig(projectRoot) as { semanticLayer?: { provider?: string; projectPath?: string }; dbt?: { projectDir?: string; manifestPath?: string } };
  const provider = config.semanticLayer?.provider;
  if (provider === 'dbt') return true;
  if (provider && provider !== 'dql') return false;
  const dbtProjectDir = config.dbt?.projectDir;
  return semanticManifestDefinesSemantics(resolveSemanticManifestPath(projectRoot, {
    ...(dbtProjectDir ? { dbtProjectDir } : {}),
    ...(config.dbt?.manifestPath ? { dbtManifestPath: config.dbt.manifestPath } : {}),
  }));
}

export async function getSemanticRuntimeStatus(
  projectRoot: string,
  options: {
    probeConfiguredCloud?: boolean;
    /**
     * The semantic layer's resolved provider when the caller already knows it
     * (`dbt` when dbt semantic models are loaded). Without it the project's
     * own config and dbt artifacts decide.
     */
    semanticProvider?: string | null;
  } = {},
): Promise<SemanticRuntimeStatus> {
  const redacted = getSemanticRuntimeSettings(projectRoot);
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const metricFlowCli = resolveMetricFlowCli(projectRoot);
  const cliReady = Boolean(metricFlowCli);
  // MetricFlow compiles a dbt project; a warehouse-first project (no dbt) has
  // none, so its setup advice names what the native compiler runs instead.
  const dbtProject = projectHasDbtProject(projectRoot);
  let cloudTest: DbtCloudSemanticTestResult | undefined;
  if (cloud.configured && cloud.testState === 'passed') {
    cloudTest = {
      ok: true,
      message: cloud.testMessage ?? 'Previously tested.',
      dialect: cloud.dialect,
      metricCount: cloud.metricCount,
    };
  } else if (cloud.configured && options.probeConfiguredCloud) {
    cloudTest = await probeDbtCloudSemanticRuntime(projectRoot).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  // A successful catalog probe proves only that dbt Cloud can compile. It does
  // not prove that the SQL will run on the connection selected in DQL. Existing
  // pre-target-binding settings deliberately remain non-executable until the
  // user reapplies them against an active warehouse connection.
  const cloudReady = Boolean(cloudTest?.ok && cloud.executionTargetFingerprint);
  const preference = redacted.preference;
  // A detected `mf` is chosen automatically only for a semantic layer it can read.
  const dbtSemantics = cliReady && preference === 'auto'
    ? options.semanticProvider ? options.semanticProvider === 'dbt' : projectHasDbtSemantics(projectRoot)
    : true;
  const active = selectActiveAdapter(preference, cloudReady, cliReady && dbtSemantics);
  const adapters: SemanticRuntimeAdapterStatus[] = [
    {
      id: 'native',
      label: 'DQL native semantic compiler',
      bundled: true,
      configured: true,
      tested: true,
      ready: true,
      source: 'bundled',
      detail: 'Bundled with ZLens. Executes simple metrics and ratios of simple metrics without an external runtime.',
      capabilities: { having: true },
    },
    {
      id: 'metricflow-cli',
      label: 'Local MetricFlow',
      bundled: false,
      configured: cliReady,
      tested: cliReady,
      ready: cliReady,
      source: cliReady ? 'local' : 'none',
      capabilities: { having: false },
      detail: cliReady
        ? `Detected ${metricFlowCli?.source === 'managed' ? 'the project-local managed runtime' : 'a compatible `mf` executable'}${metricFlowCli?.version ? ` · ${metricFlowCli.version}` : ''}.${dbtSemantics ? '' : ' Not used automatically: this project\'s metrics are defined in the DQL semantic layer, which MetricFlow does not read, so the DQL native compiler serves them.'}`
        : 'The DQL adapter is bundled; install a project-local MetricFlow Python runtime or use an existing `mf` executable.',
    },
    {
      id: 'dbt-cloud',
      label: 'dbt Cloud Semantic Layer',
      bundled: true,
      configured: cloud.configured,
      tested: cloudReady || cloud.testState === 'failed',
      ready: cloudReady,
      source: cloud.source,
      capabilities: { having: false },
      detail: !cloud.configured
        ? 'Adapter is bundled; configure Host, Environment ID, and a Semantic Layer service token.'
        : cloudTest?.ok && !cloud.executionTargetFingerprint
          ? 'Catalog test passed, but no execution target is bound. Reapply dbt Cloud Semantic Layer settings with the intended warehouse connection active.'
          : cloudReady
            ? cloudTest?.message ?? 'Test passed.'
            : cloudTest?.message ?? cloud.testMessage ?? 'Configured but not tested.',
    },
  ];
  const setup = active !== 'native'
    ? null
    : !dbtProject && !cloud.configured
      ? 'This project has no dbt project. The DQL native compiler runs its simple and ratio metrics; derived, cumulative, and conversion metrics need a dbt project with MetricFlow or dbt Cloud.'
      : cloud.configured && !cloudReady
      ? cloudTest?.ok && !cloud.executionTargetFingerprint
        ? 'Reapply dbt Cloud Semantic Layer settings with the intended warehouse connection active to bind compilation and execution targets.'
        : 'Test the configured dbt Cloud Semantic Layer connection, or install a compatible local MetricFlow runtime.'
      : 'Configure dbt Cloud Semantic Layer, or install a compatible local MetricFlow runtime for derived, cumulative, and conversion metrics.';
  return { preference, active, adapters, setup };
}

export function semanticRuntimeAdapterSupportsHaving(
  status: SemanticRuntimeStatus,
  adapter: SemanticRuntimeAdapterId,
): boolean {
  return status.adapters.find((candidate) => candidate.id === adapter)?.capabilities?.having === true;
}

export async function testSemanticRuntimeDraft(
  projectRoot: string,
  input: SemanticRuntimeSettingsInput,
): Promise<DbtCloudSemanticTestResult> {
  const draft = semanticRuntimeDraft(projectRoot, input);
  return testDbtCloudSemanticConnection(draft);
}

/**
 * Rewrite a semantic request's dimension references (dimensions, filter
 * dimensions, order-by names, time dimension) from bare names to the
 * MetricFlow entity-qualified names the runtime expects, using the
 * compatibility service as the source of truth. Names it can't resolve pass
 * through unchanged (the 1.8.13 group-by suggestion-retry is the safety net).
 * `metric_time` is never rewritten. Also clamps a requested time grain up to
 * the column's base grain, collecting a warning. Pure — returns a new request.
 */
/**
 * Explain, actionably, why no full semantic runtime is active for a derived/
 * ratio/cumulative metric — probing the REAL runtime state so the message names
 * the actual gap instead of a generic "configure a runtime". Covers both traps:
 *   • dbt Cloud is configured but its connection test is failing (bad host/env/
 *     token or network) — so it never becomes active, and the query silently
 *     falls back to native, which can't compose a derived metric;
 *   • MetricFlow is installed but this server process can't find it, because the
 *     server was launched from a shell without the dbt virtualenv on PATH.
 */
/** A dbt Cloud connection error that reads like a rejected/expired token rather
 *  than a bad host or a network failure. Exported for testability. */
export function looksLikeAuthFailure(detail: string): boolean {
  return /\b(401|403|unauthori[sz]ed|forbidden|expired|invalid[\s-]*token|token[\s-]*(?:is[\s-]*)?(?:invalid|expired)|authenticat[a-z]*|permission denied|not[\s-]*authori[sz]ed)\b/i.test(detail);
}

export async function explainMissingSemanticRuntime(projectRoot: string, dbtProjectPath?: string): Promise<string> {
  // dbt Cloud compiles remotely and needs no local dbt project; otherwise a
  // project without one has no runtime to set up, only metrics to reshape.
  if (!dbtProjectPath && !projectHasDbtProject(projectRoot) && !getEffectiveDbtCloudSemanticSettings(projectRoot).configured) {
    return 'This metric is not one the DQL native engine runs, and this project has no dbt project for MetricFlow or dbt Cloud to run it. The native engine runs simple metrics, ratios of two simple metrics, and derived metrics that do arithmetic over simple metrics with no offset window; define the metric as one of those.';
  }
  const status = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });
  const cloud = status.adapters.find((adapter) => adapter.id === 'dbt-cloud');
  const cli = resolveMetricFlowCli(projectRoot);
  const head = 'This is a derived metric — it needs dbt Cloud or local MetricFlow, and neither is active for this server right now.';
  const reasons: string[] = [];

  // dbt Cloud is configured but not usable — the most likely cause once a user
  // has "switched to cloud". `detail` carries the live connection-test error.
  if (cloud?.configured && !cloud.ready) {
    const detail = cloud.detail ?? 'not tested';
    if (looksLikeAuthFailure(detail)) {
      // An expired/invalid token is the "works, then stops after a while"
      // symptom: a short-lived Semantic Layer session token was used instead of
      // a durable service token, or the token lacks Semantic Layer permission.
      reasons.push(`dbt Cloud rejected the service token (${detail}) — it has expired or lacks Semantic Layer permission. In dbt Cloud → Account Settings → Service Tokens, create a durable service token with the “Semantic Layer Only” permission set and no short expiration (do NOT copy the short-lived token from the Semantic Layer “Connect/Query” dialog — that one expires), paste it into Settings, then “Test & save”.`);
    } else {
      reasons.push(`dbt Cloud is configured but its connection test is not passing (${detail}). In Settings → Semantic execution adapters → dbt Cloud, re-check Host, Environment ID, and the Semantic Layer service token, then “Test & save”.`);
    }
  }

  // Local MetricFlow.
  if (cli) {
    if (!hasDbtSemanticManifest(projectRoot, dbtProjectPath)) {
      reasons.push(`MetricFlow is installed (${cli.bin}) but target/semantic_manifest.json is missing — run \`dbt parse\` in the dbt project.`);
    }
  } else if (!cloud?.configured) {
    const managed = managedMetricFlowBin(projectRoot);
    reasons.push(`MetricFlow is not on this server’s PATH: start the server from the shell where \`mf\` works (activate your dbt virtualenv) and restart it, set ZLENS_METRICFLOW_BIN to the path from \`which mf\`, or install the managed runtime in Settings (${managed}).`);
  }

  return reasons.length > 0
    ? `${head} ${reasons.join(' ')}`
    : `${head} ${status.setup ?? 'Configure a runtime in Settings → Semantic execution adapters.'}`;
}

export function qualifyForMetricFlow(
  request: SemanticRuntimeQueryRequest,
  semanticLayer: SemanticLayer,
): { request: SemanticRuntimeQueryRequest; warnings: string[]; bindings: SemanticRuntimeBinding[] } {
  const warnings: string[] = [];
  const { compatible } = semanticLayer.explainCompatibleDimensions(request.metrics);
  const qualifiedByReference = new Map<string, { runtimeReference: string; entityPath: string[] }>();
  for (const dim of compatible) {
    if (!dim.qualifiedName) continue;
    for (const reference of [
      dim.name,
      semanticDimensionReference(dim),
      dim.source?.objectId,
      dim.qualifiedName,
    ]) {
      if (reference) {
        qualifiedByReference.set(reference.toLowerCase(), {
          runtimeReference: dim.qualifiedName,
          entityPath: dim.entityPath ?? [],
        });
      }
    }
  }
  const bindings: SemanticRuntimeBinding[] = [];

  // MetricFlow 0.13 accepts an ORDER BY dimension only when it is the exact
  // qualified item already selected in GROUP BY. The frozen Ask plan may keep
  // its business-facing order-by identity (`customer_name`) while its selected
  // grouping is the complete entity path
  // (`order_id__customer__customer_name`). Resolve that order-by against the
  // already-qualified grouping first. This is a narrow adapter boundary: it
  // does not invent a member, path, or grouping and it declines duplicate leaf
  // names rather than choosing one arbitrarily.
  interface SelectedGroupingBinding {
    runtimeReference: string;
    entityPath: string[];
  }
  const selectedGroupingByExactReference = new Map<string, SelectedGroupingBinding>();
  const ambiguousSelectedGroupingExactReferences = new Set<string>();
  const selectedGroupingByLeafReference = new Map<string, SelectedGroupingBinding>();
  const ambiguousSelectedGroupingLeafReferences = new Set<string>();
  const normalizedReference = (value: string): string => value.trim().toLowerCase();
  const referenceLeaf = (value: string): string => {
    const parts = normalizedReference(value).split(/(?:__|\.)/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  };
  const registerUniqueGrouping = (
    bindingsByReference: Map<string, SelectedGroupingBinding>,
    ambiguousReferences: Set<string>,
    reference: string,
    binding: SelectedGroupingBinding,
  ): void => {
    const key = normalizedReference(reference);
    if (!key || ambiguousReferences.has(key)) return;
    const existing = bindingsByReference.get(key);
    if (!existing) {
      bindingsByReference.set(key, binding);
      return;
    }
    if (existing.runtimeReference !== binding.runtimeReference) {
      bindingsByReference.delete(key);
      ambiguousReferences.add(key);
    }
  };
  const registerSelectedGrouping = (
    source: string,
    runtimeReference: string,
    entityPath: string[],
  ): void => {
    const selection = parseSemanticDimensionSelection(source);
    const binding = { runtimeReference, entityPath: [...entityPath] };
    registerUniqueGrouping(
      selectedGroupingByExactReference,
      ambiguousSelectedGroupingExactReferences,
      selection.reference,
      binding,
    );
    registerUniqueGrouping(
      selectedGroupingByExactReference,
      ambiguousSelectedGroupingExactReferences,
      runtimeReference,
      binding,
    );
    for (const leaf of [referenceLeaf(selection.reference), referenceLeaf(runtimeReference)]) {
      registerUniqueGrouping(
        selectedGroupingByLeafReference,
        ambiguousSelectedGroupingLeafReferences,
        leaf,
        binding,
      );
    }
  };
  const selectedGroupingForOrderBy = (name: string): SelectedGroupingBinding | undefined => {
    const selection = parseSemanticDimensionSelection(name);
    // An explicit path is a stronger authoring instruction than a selected
    // grouping alias. MetricFlow qualification below retains that exact path.
    if (selection.entityPath?.length || selection.reference === 'metric_time') return undefined;
    const exact = normalizedReference(selection.reference);
    if (!ambiguousSelectedGroupingExactReferences.has(exact)) {
      const binding = selectedGroupingByExactReference.get(exact);
      if (binding) return binding;
    }
    const leaf = referenceLeaf(selection.reference);
    return leaf && !ambiguousSelectedGroupingLeafReferences.has(leaf)
      ? selectedGroupingByLeafReference.get(leaf)
      : undefined;
  };
  const qualify = (name: string | undefined, role: SemanticRuntimeBindingRole): string | undefined => {
    if (!name) return name;
    const selection = parseSemanticDimensionSelection(name);
    const authoringReference = selection.reference;
    let runtimeReference: string;
    let entityPath = selection.entityPath ?? [];
    if (authoringReference === 'metric_time' || (authoringReference.includes('__') && !selection.entityPath)) {
      runtimeReference = authoringReference;
    } else {
      const exact = semanticLayer.resolveDimension(authoringReference, request.metrics);
      const compatibleBinding = qualifiedByReference.get(authoringReference.toLowerCase());
      const baseRuntimeReference = compatibleBinding?.runtimeReference
        ?? exact?.qualifiedName
        ?? authoringReference;
      if (selection.entityPath?.length) {
        const prefix = `${selection.entityPath.join('__')}__`;
        runtimeReference = baseRuntimeReference.startsWith(prefix)
          ? baseRuntimeReference
          : `${prefix}${baseRuntimeReference}`;
      } else {
        runtimeReference = baseRuntimeReference;
        entityPath = compatibleBinding?.entityPath ?? [];
      }
    }
    bindings.push({
      role,
      authoringReference,
      runtimeReference,
      entityPath,
      status: 'resolved',
    });
    return runtimeReference;
  };

  const timeDimension = request.timeDimension
    ? (() => {
        const selection = parseSemanticDimensionSelection(request.timeDimension!.name);
        const name = qualify(request.timeDimension!.name, 'time_dimension');
        let granularity = request.timeDimension!.granularity;
        const td = semanticLayer.getTimeDimension(selection.reference);
        if (td?.granularities?.length && !td.granularities.includes(granularity as typeof td.granularities[number])) {
          const clamped = td.granularities[0];
          warnings.push(`Time grain "${granularity}" is finer than ${request.timeDimension!.name}'s base grain; using "${clamped}".`);
          granularity = clamped;
        }
        return { name: name!, granularity };
      })()
    : undefined;

  const dimensions = request.dimensions.map((dimension) => {
    const bindingStart = bindings.length;
    const runtimeReference = qualify(dimension, 'dimension') ?? dimension;
    const binding = bindings.slice(bindingStart).find((candidate) => candidate.role === 'dimension');
    registerSelectedGrouping(dimension, runtimeReference, binding?.entityPath ?? []);
    return runtimeReference;
  });
  const orderBy = request.orderBy?.map((order) => {
    const selectedGrouping = selectedGroupingForOrderBy(order.name);
    if (selectedGrouping) {
      const selection = parseSemanticDimensionSelection(order.name);
      bindings.push({
        role: 'order_by',
        authoringReference: selection.reference,
        runtimeReference: selectedGrouping.runtimeReference,
        entityPath: [...selectedGrouping.entityPath],
        status: 'resolved',
      });
      return { ...order, name: selectedGrouping.runtimeReference };
    }
    return { ...order, name: qualify(order.name, 'order_by') ?? order.name };
  });

  return {
    warnings,
    bindings,
    request: {
      ...request,
      dimensions,
      ...(request.filters ? { filters: request.filters.map((f) => f.dimension ? { ...f, dimension: qualify(f.dimension, 'filter') } : f) } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(timeDimension ? { timeDimension } : {}),
    },
  };
}

const SEMANTIC_PATH_SELECTION = /^(.*?)@via\(([^)]+)\)$/;

export function parseSemanticDimensionSelection(value: string): { reference: string; entityPath?: string[] } {
  const match = value.trim().match(SEMANTIC_PATH_SELECTION);
  if (!match) return { reference: value };
  const entityPath = match[2]
    .split('>')
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z0-9_]+$/.test(part));
  return entityPath.length > 0
    ? { reference: match[1].trim(), entityPath }
    : { reference: match[1].trim() };
}

export function formatSemanticDimensionSelection(reference: string, entityPath: string[]): string {
  return entityPath.length > 0 ? `${reference}@via(${entityPath.join('>')})` : reference;
}

export function applySemanticPathSelection(
  request: SemanticRuntimeQueryRequest,
  authoringReference: string,
  entityPath: string[],
): SemanticRuntimeQueryRequest {
  const bind = (value: string): string => {
    const parsed = parseSemanticDimensionSelection(value);
    const selectedReference = parsed.reference.toLowerCase();
    const requestedReference = authoringReference.toLowerCase();
    const sameReference = selectedReference === requestedReference
      || ((!selectedReference.includes('.') || !requestedReference.includes('.'))
        && selectedReference.split('.').pop() === requestedReference.split('.').pop());
    return sameReference ? formatSemanticDimensionSelection(parsed.reference, entityPath) : value;
  };
  return {
    ...request,
    dimensions: request.dimensions.map(bind),
    ...(request.filters ? { filters: request.filters.map((filter) => filter.dimension ? { ...filter, dimension: bind(filter.dimension) } : filter) } : {}),
    ...(request.orderBy ? { orderBy: request.orderBy.map((order) => ({ ...order, name: bind(order.name) })) } : {}),
    ...(request.timeDimension ? { timeDimension: { ...request.timeDimension, name: bind(request.timeDimension.name) } } : {}),
  };
}

export function encodeSemanticPathEvidenceId(authoringReference: string, entityPath: string[]): string {
  return `semantic-path:${encodeURIComponent(authoringReference)}:${encodeURIComponent(entityPath.join('>'))}`;
}

export function decodeSemanticPathEvidenceId(value: string | undefined): {
  authoringReference: string;
  entityPath: string[];
} | undefined {
  if (!value?.startsWith('semantic-path:')) return undefined;
  const [, encodedReference, encodedPath] = value.split(':');
  if (!encodedReference || !encodedPath) return undefined;
  try {
    const entityPath = decodeURIComponent(encodedPath).split('>').filter(Boolean);
    return entityPath.length > 0
      ? { authoringReference: decodeURIComponent(encodedReference), entityPath }
      : undefined;
  } catch {
    return undefined;
  }
}

function inferSemanticBindingRole(
  request: SemanticRuntimeQueryRequest,
  authoringReference: string,
): SemanticRuntimeBindingRole {
  const matches = (value: string | undefined) =>
    parseSemanticDimensionSelection(value ?? '').reference.toLowerCase() === authoringReference.toLowerCase();
  if (matches(request.timeDimension?.name)) return 'time_dimension';
  if (request.filters?.some((filter) => matches(filter.dimension))) return 'filter';
  if (request.orderBy?.some((order) => matches(order.name))) return 'order_by';
  return 'dimension';
}

function semanticTraceForSuccess(input: {
  adapter: SemanticRuntimeAdapterId;
  authoringRequest: SemanticRuntimeQueryRequest;
  runtimeRequest?: SemanticRuntimeQueryRequest;
  bindings: SemanticRuntimeBinding[];
  warnings: string[];
}): SemanticRuntimeTrace {
  return {
    version: 1,
    adapter: input.adapter,
    status: 'compiled',
    authoringRequest: input.authoringRequest,
    ...(input.runtimeRequest ? { runtimeRequest: input.runtimeRequest } : {}),
    bindings: input.bindings,
    warnings: input.warnings,
    steps: [
      { id: 'resolve_members', label: 'Resolve governed semantic members', status: 'completed', detail: 'Metric and dimension identities resolved from the pinned semantic snapshot.' },
      { id: 'bind_entity_paths', label: 'Bind metric-relative entity paths', status: 'completed', detail: input.bindings.length > 0 ? `${input.bindings.length} runtime member binding(s) resolved.` : 'No dimension path binding was required.' },
      { id: 'compile_semantic_query', label: 'Compile with the selected semantic adapter', status: 'completed', detail: `Compiled through ${input.adapter}.` },
      { id: 'execute_query', label: 'Execute the compiled warehouse query', status: 'not_started', detail: 'Execution is owned by the authorized host after compilation.' },
    ],
  };
}

export function semanticPathAmbiguityFromError(input: {
  adapter: Exclude<SemanticRuntimeAdapterId, 'native'>;
  error: unknown;
  authoringRequest: SemanticRuntimeQueryRequest;
  runtimeRequest: SemanticRuntimeQueryRequest;
  bindings: SemanticRuntimeBinding[];
  warnings: string[];
}): SemanticRuntimePathAmbiguityError | undefined {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (!/ambiguous and can(?:not|'t) be resolved/i.test(message)) return undefined;
  const parsedCandidates: Array<{ baseRuntimeReference: string; entityPath: string[] }> = [];
  const candidatePattern = /(?:TimeDimension|Dimension)\(\s*['"]([^'"]+)['"][^)]*?entity_path=\[([^\]]*)\]/g;
  for (const match of message.matchAll(candidatePattern)) {
    const entityPath = Array.from(match[2].matchAll(/['"]([^'"]+)['"]/g), (item) => item[1]).filter(Boolean);
    if (entityPath.length > 0) parsedCandidates.push({ baseRuntimeReference: match[1], entityPath });
  }
  if (parsedCandidates.length < 2) return undefined;
  const runtimeReference = parsedCandidates[0].baseRuntimeReference;
  const matchingBinding = input.bindings.find((binding) => binding.runtimeReference === runtimeReference);
  const authoringReference = matchingBinding?.authoringReference
    ?? input.authoringRequest.timeDimension?.name
    ?? input.authoringRequest.dimensions[0]
    ?? runtimeReference;
  const candidates = parsedCandidates.map((candidate) => {
    const runtimeName = `${candidate.entityPath.join('__')}__${candidate.baseRuntimeReference}`;
    return {
      id: encodeSemanticPathEvidenceId(authoringReference, candidate.entityPath),
      label: `Use ${authoringReference} via ${candidate.entityPath.join(' → ')}`,
      description: `Bind the governed member to ${runtimeName}. No SQL will run until this path is selected.`,
      authoringReference,
      runtimeReference: runtimeName,
      entityPath: candidate.entityPath,
      selectionReference: formatSemanticDimensionSelection(authoringReference, candidate.entityPath),
    };
  });
  return new SemanticRuntimePathAmbiguityError({
    adapter: input.adapter,
    authoringRequest: input.authoringRequest,
    runtimeRequest: input.runtimeRequest,
    bindings: input.bindings,
    warnings: input.warnings,
    authoringReference,
    runtimeReference,
    candidates,
  });
}

function semanticRequestWithoutPathSelectors(
  request: SemanticRuntimeQueryRequest,
): SemanticRuntimeQueryRequest {
  const strip = (value: string) => parseSemanticDimensionSelection(value).reference;
  return {
    ...request,
    dimensions: request.dimensions.map(strip),
    ...(request.filters ? { filters: request.filters.map((filter) => filter.dimension ? { ...filter, dimension: strip(filter.dimension) } : filter) } : {}),
    ...(request.orderBy ? { orderBy: request.orderBy.map((order) => ({ ...order, name: strip(order.name) })) } : {}),
    ...(request.timeDimension ? { timeDimension: { ...request.timeDimension, name: strip(request.timeDimension.name) } } : {}),
  };
}

/**
 * Verify the one profile target that the local MetricFlow CLI will actually
 * use. `executionTargetFingerprint` is retained solely to bind the Ask
 * metadata overlay together; it is never substituted for an observed or
 * configured warehouse identity.
 */
export function assertMetricFlowAskTarget(
  target: MetricFlowAskTargetContext | undefined,
): string[] {
  if (!target) return [];
  // MetricFlow only RENDERS SQL here (`mf query --explain`); DQL executes that
  // SQL on the connection the person selected, and the relation names in it
  // come from the semantic manifest. A profile whose default target names a
  // different database, schema, role or warehouse therefore does not change
  // the statement, and refusing on it would silence the semantic engine on
  // every project whose connection form differs from profiles.yml (a role
  // left blank is enough). Such differences are RECORDED as warnings on the
  // candidate; only a different driver, whose dialect would render different
  // SQL, stops the compile before dispatch.
  const warnings: string[] = [];
  if (target.physicalBindings.some((binding) => binding.executionTargetFingerprint !== target.executionTargetFingerprint)) {
    warnings.push(new MetricFlowAskTargetMismatchError({ target, reason: 'binding_target_mismatch' }).message);
  }
  if (!target.profileTarget?.expectedTarget) {
    warnings.push('the dbt profile default target that local MetricFlow reads could not be verified against the selected connection; the compiled SQL runs on the selected connection');
    return warnings;
  }
  const mismatches = compareMetricFlowAskTargets(
    target.profileTarget.expectedTarget,
    target.selectedExecutionTarget,
  );
  if (mismatches.length === 0) return warnings;
  const fields = mismatches.map((mismatch) => mismatch.field);
  if (fields.includes('driver') || fields.includes('dialect')) {
    throw new MetricFlowAskTargetMismatchError({ target, reason: 'profile_target_mismatch', mismatchFields: fields });
  }
  const profile = target.profileTarget.profileName ? `dbt profile "${target.profileTarget.profileName}"${target.profileTarget.targetName ? ` target "${target.profileTarget.targetName}"` : ''}` : 'the dbt profile default target';
  warnings.push(`${profile} differs from the selected connection in ${fields.join(', ')}; MetricFlow rendered the SQL and the selected connection runs it`);
  return warnings;
}

/**
 * dbt profile files and connection forms commonly retain unquoted Snowflake
 * target components exactly as users typed them, while Snowflake folds those
 * components to upper case. This comparison is intentionally local to the
 * MetricFlow Ask preflight: the shared target contract remains strict, and
 * exact physical bindings keep their own quote-aware identity checks.
 */
function compareMetricFlowAskTargets(
  expected: WarehouseTargetIdentityV1,
  actual: WarehouseTargetIdentityV1,
) {
  if (expected.driver !== 'snowflake' || actual.driver !== 'snowflake') {
    return compareWarehouseTargets(expected, actual);
  }
  return compareWarehouseTargets(
    withNormalizedSnowflakeConfiguredTargetComponents(expected),
    withNormalizedSnowflakeConfiguredTargetComponents(actual),
  );
}

function withNormalizedSnowflakeConfiguredTargetComponents(
  target: WarehouseTargetIdentityV1,
): WarehouseTargetIdentityV1 {
  return {
    ...target,
    redactedContext: {
      ...target.redactedContext,
      database: normalizeSnowflakeConfiguredTargetComponent(target.redactedContext.database),
      schema: normalizeSnowflakeConfiguredTargetComponent(target.redactedContext.schema),
      role: normalizeSnowflakeConfiguredTargetComponent(target.redactedContext.role),
      warehouse: normalizeSnowflakeConfiguredTargetComponent(target.redactedContext.warehouse),
    },
  };
}

function normalizeSnowflakeConfiguredTargetComponent(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // Double quoted Snowflake identifiers are case-sensitive. Keep their exact
  // spelling, including escaped quote pairs; only unquoted components fold.
  return /^"(?:[^"]|"")*"$/.test(trimmed) ? trimmed : trimmed.toUpperCase();
}

export async function compileSemanticRuntimeQuery(
  request: SemanticRuntimeQueryRequest,
  context: SemanticRuntimeCompileContext,
): Promise<SemanticRuntimeCompileResult | null> {
  const effectiveRequest = normalizeSemanticRuntimeQueryRequest(request, context.semanticLayer);
  const status = await getSemanticRuntimeStatus(context.projectRoot, {
    probeConfiguredCloud: true,
    ...(context.detectedProvider ? { semanticProvider: context.detectedProvider } : {}),
  });
  const explicit = effectiveRequest.engine;
  const fullRuntimeRequested = explicit === 'metricflow' || explicit === 'metricflow-cli' || explicit === 'dbt-cloud';
  const candidates = selectSemanticRuntimeAdapters(explicit, status.active);
  const routeLockedToFullRuntime = candidates.length === 1 && candidates[0] !== 'native';

  // Qualify dimension references to MetricFlow entity-qualified names ONCE, at
  // this boundary, for the full-runtime engines. Native keeps the bare request.
  const {
    request: runtimeRequest,
    warnings: qualifyWarnings,
    bindings,
  } = qualifyForMetricFlow(effectiveRequest, context.semanticLayer);

  let lastRuntimeError: Error | undefined;
  for (const adapter of candidates) {
    if (effectiveRequest.having?.length && !semanticRuntimeAdapterSupportsHaving(status, adapter)) {
      throw new SemanticRuntimeHavingUnsupportedError(adapter);
    }
    if (adapter === 'dbt-cloud') {
      const adapterStatus = status.adapters.find((item) => item.id === adapter);
      if (!adapterStatus?.ready) continue;
      try {
        assertDbtCloudMetricInventory(context.projectRoot, runtimeRequest.metrics, effectiveRequest);
        const result = await compileDbtCloudSemanticQuery(
          getEffectiveDbtCloudSemanticSettings(context.projectRoot),
          runtimeRequest,
        );
        return {
          sql: result.sql,
          joins: [],
          tables: [],
          engine: 'dbt-cloud',
          effectiveRequest,
          runtimeRequest,
          semanticTrace: semanticTraceForSuccess({
            adapter: 'dbt-cloud',
            authoringRequest: effectiveRequest,
            runtimeRequest,
            bindings,
            warnings: qualifyWarnings,
          }),
          warnings: qualifyWarnings,
        };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (isSemanticRuntimeError(error)) throw error;
        const ambiguity = semanticPathAmbiguityFromError({
          adapter: 'dbt-cloud',
          error,
          authoringRequest: effectiveRequest,
          runtimeRequest,
          bindings,
          warnings: qualifyWarnings,
        });
        if (ambiguity) throw ambiguity;
        throw new SemanticRuntimeCompilationError('dbt-cloud', error);
      }
    }
    if (adapter === 'metricflow-cli') {
      if (!hasMetricFlowCli(context.projectRoot)) continue;
      if (!projectHasDbtProject(context.projectRoot, context.projectConfig)) {
        // Reached only when MetricFlow was chosen explicitly: say why it cannot
        // run instead of asking for a dbt artifact this project cannot make.
        lastRuntimeError = new SemanticRuntimeRequiredError(
          'MetricFlow is the selected semantic runtime, but this project has no dbt project for it to compile. Set the semantic runtime to the DQL native compiler, which runs simple and ratio metrics.',
        );
        continue;
      }
      try {
        // `mf query` has no target flag. Do not let the CLI read an unrelated
        // profiles.yml default merely because native compilation received the
        // selected Ask binding separately.
        const targetWarnings = assertMetricFlowAskTarget(context.metricFlowAskTarget);
        const dbtProjectPath = context.projectConfig.semanticLayer?.provider === 'dbt'
          ? context.projectConfig.semanticLayer.projectPath
          : context.projectConfig.dbt?.projectDir;
        const compiled = await compileMetricFlowQuery({
          projectRoot: context.projectRoot,
          dbtProjectPath,
          profilesDir: context.projectConfig.dbt?.profilesDir,
          metrics: runtimeRequest.metrics,
          dimensions: runtimeRequest.dimensions,
          filters: runtimeRequest.filters,
          timeDimension: runtimeRequest.timeDimension,
          orderBy: runtimeRequest.orderBy,
          limit: runtimeRequest.limit,
          savedQuery: runtimeRequest.savedQuery,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return {
          sql: compiled.sql,
          joins: [],
          tables: [],
          engine: 'metricflow-cli',
          effectiveRequest,
          runtimeRequest,
          semanticTrace: semanticTraceForSuccess({
            adapter: 'metricflow-cli',
            authoringRequest: effectiveRequest,
            runtimeRequest,
            bindings,
            warnings: [...qualifyWarnings, ...targetWarnings],
          }),
          warnings: [...qualifyWarnings, ...targetWarnings],
        };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (isSemanticRuntimeError(error)) throw error;
        const ambiguity = semanticPathAmbiguityFromError({
          adapter: 'metricflow-cli',
          error,
          authoringRequest: effectiveRequest,
          runtimeRequest,
          bindings,
          warnings: qualifyWarnings,
        });
        if (ambiguity) throw ambiguity;
        throw new SemanticRuntimeCompilationError('metricflow-cli', error);
      }
    }
    const nativeRequest = semanticRequestWithoutPathSelectors(effectiveRequest);
    const postAggregateHaving = nativeRequest.having ?? [];
    const composed = context.semanticLayer.composeQuery({
      metrics: nativeRequest.metrics,
      dimensions: nativeRequest.dimensions,
      filters: nativeRequest.filters as Array<{ dimension: string; operator: string; values: string[] }> | undefined,
      // A total predicate is applied before presentation ordering and limits.
      limit: postAggregateHaving.length > 0 ? undefined : nativeRequest.limit,
      timeDimension: nativeRequest.timeDimension,
      orderBy: postAggregateHaving.length > 0 ? undefined : nativeRequest.orderBy,
      driver: context.driver,
      tableMapping: context.tableMapping,
    });
    if (composed) {
      const sql = postAggregateHaving.length > 0
        ? composeNativePostAggregateHaving({
            sql: composed.sql,
            request: nativeRequest,
            semanticLayer: context.semanticLayer,
            driver: context.driver,
          })
        : composed.sql;
      return {
        ...composed,
        sql,
        engine: 'native',
        effectiveRequest,
        semanticTrace: semanticTraceForSuccess({
          adapter: 'native',
          authoringRequest: effectiveRequest,
          bindings: bindings.map((binding) => ({
            ...binding,
            runtimeReference: parseSemanticDimensionSelection(binding.authoringReference).reference,
            entityPath: [],
          })),
          warnings: postAggregateHaving.length > 0
            ? ['Applied the approved metric filter after semantic aggregation.']
            : [],
        }),
      };
    }
  }

  if (fullRuntimeRequested || routeLockedToFullRuntime) {
    throw lastRuntimeError ?? new SemanticRuntimeRequiredError(status.setup ?? 'The requested semantic runtime is unavailable.');
  }
  if (lastRuntimeError && !context.semanticLayer.canComposeMetric(effectiveRequest.metrics[0] ?? '')) {
    throw new SemanticRuntimeRequiredError(lastRuntimeError.message);
  }
  return null;
}

/**
 * Wrap compiler-owned aggregate output and predicate only output aliases.
 * This is the post-aggregation meaning of a Dataset HAVING filter and never
 * injects user text into provider SQL.
 */
function composeNativePostAggregateHaving(input: {
  sql: string;
  request: SemanticRuntimeQueryRequest;
  semanticLayer: SemanticLayer;
  driver?: string;
}): string {
  const having = input.request.having ?? [];
  if (having.length === 0) return input.sql;
  const dialect = getDialect(input.driver);
  const relation = dialect.quoteIdentifier('dql_semantic_aggregate');
  const metricAlias = (reference: string): string => {
    const metric = input.semanticLayer.getMetric(reference);
    if (!metric) throw new SemanticRuntimeHavingUnsupportedError('native');
    return metric.name;
  };
  const column = (alias: string): string => `${relation}.${dialect.quoteIdentifier(alias)}`;
  const numericLiteral = (value: unknown): string => {
    // Tile query values originate in a JSON App draft.  The typed planner
    // normalizes them to strings, but do not let a numeric JSON scalar turn a
    // governed post-aggregate predicate into a generic capability failure on
    // the way to the compiler.  We still accept only finite decimal literals;
    // this is a representation normalization, never SQL interpolation.
    const literal = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(literal)) {
      throw new SemanticRuntimeHavingUnsupportedError('native');
    }
    return literal;
  };
  const predicate = (filter: NonNullable<SemanticRuntimeQueryRequest['having']>[number]): string => {
    const expression = column(metricAlias(filter.metric));
    const values = filter.values.map(numericLiteral);
    if (values.length === 0) throw new SemanticRuntimeHavingUnsupportedError('native');
    switch (filter.operator) {
      case 'eq': return `${expression} = ${values[0]}`;
      case 'neq': return `${expression} <> ${values[0]}`;
      case 'gt': return `${expression} > ${values[0]}`;
      case 'gte': return `${expression} >= ${values[0]}`;
      case 'lt': return `${expression} < ${values[0]}`;
      case 'lte': return `${expression} <= ${values[0]}`;
      case 'between':
        if (values.length !== 2) throw new SemanticRuntimeHavingUnsupportedError('native');
        return `${expression} BETWEEN ${values[0]} AND ${values[1]}`;
      case 'in': return `${expression} IN (${values.join(', ')})`;
      case 'not_in': return `${expression} NOT IN (${values.join(', ')})`;
    }
  };
  const outputAlias = (reference: string): string => {
    const metric = input.semanticLayer.getMetric(reference);
    if (metric) return metric.name;
    const parsed = parseSemanticDimensionSelection(reference).reference;
    if (input.request.timeDimension && parsed === parseSemanticDimensionSelection(input.request.timeDimension.name).reference) {
      const time = input.semanticLayer.resolveDimension(parsed, input.request.metrics);
      if (time) return `${time.name}_${input.request.timeDimension.granularity}`;
    }
    const dimension = input.semanticLayer.resolveDimension(parsed, input.request.metrics);
    if (dimension) return dimension.name;
    throw new SemanticRuntimeHavingUnsupportedError('native');
  };
  const orderBy = (input.request.orderBy ?? []).map((order) => {
    if (order.direction !== 'asc' && order.direction !== 'desc') throw new SemanticRuntimeHavingUnsupportedError('native');
    return `${column(outputAlias(order.name))} ${order.direction.toUpperCase()}`;
  });
  const limit = input.request.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)) {
    throw new SemanticRuntimeHavingUnsupportedError('native');
  }
  const select = !dialect.limitAtEnd && limit ? `SELECT TOP ${limit} *` : 'SELECT *';
  return [
    select,
    `FROM (${input.sql}) AS ${relation}`,
    `WHERE ${having.map(predicate).join(' AND ')}`,
    ...(orderBy.length > 0 ? [`ORDER BY ${orderBy.join(', ')}`] : []),
    ...(dialect.limitAtEnd && limit ? [dialect.limitClause(limit)] : []),
  ].join('\n');
}

/**
 * AGT-013/AGT-014/SEC-004: planning selects one adapter. Compilation may not
 * silently downgrade to another semantic engine or native SQL after selection.
 */
export function selectSemanticRuntimeAdapters(
  requested: SemanticRuntimeQueryRequest['engine'],
  active: SemanticRuntimeAdapterId,
): SemanticRuntimeAdapterId[] {
  if (requested === 'native') return ['native'];
  if (requested === 'dbt-cloud') return ['dbt-cloud'];
  if (requested === 'metricflow' || requested === 'metricflow-cli') return ['metricflow-cli'];
  return [active];
}

/** A compatible dimension enriched with its MetricFlow-qualified name and, for
 *  time dimensions, real queryable grains. */
export type RuntimeCompatibleDimension = ReturnType<SemanticLayer['listDimensions']>[number] & {
  qualifiedName?: string;
  granularities?: string[];
};

export interface RuntimeCompatibilityResult {
  /** The engine that produced this compatibility answer. */
  engine: SemanticRuntimeAdapterId;
  dimensions: RuntimeCompatibleDimension[];
  incompatible: Array<{ name: string; qualifiedName?: string; reason: string }>;
  /** Retained for wire compatibility; selected-adapter failures no longer downgrade. */
  degraded?: string;
}

/**
 * The authoritative per-metric dimension-compatibility answer from the exact
 * adapter selected for execution. A selected adapter failure is preserved; it
 * never becomes a native compatibility answer.
 */
export async function describeRuntimeCompatibility(
  projectRoot: string,
  semanticLayer: SemanticLayer,
  metrics: string[],
  projectConfig?: SemanticRuntimeProjectConfig,
): Promise<RuntimeCompatibilityResult> {
  if (metrics.length === 0) return { engine: 'native', dimensions: [], incompatible: [] };
  const status = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });

  const nativeExplain = (): RuntimeCompatibilityResult => {
    const { compatible, incompatible } = semanticLayer.explainCompatibleDimensions(metrics);
    return {
      engine: 'native',
      dimensions: compatible.map((d) => ({ ...d, qualifiedName: d.qualifiedName })),
      incompatible: incompatible.map((d) => ({ name: d.name, qualifiedName: d.qualifiedName, reason: d.reason })),
    };
  };

  // dbt Cloud is truth when active: it returns entity-qualified names and real
  // queryable grains straight from the semantic layer.
  if (status.active === 'dbt-cloud') {
    try {
      assertDbtCloudMetricInventory(projectRoot, metrics);
      const cloud = await listDbtCloudCompatibleDimensions(getEffectiveDbtCloudSemanticSettings(projectRoot), metrics);
      const dimensions: RuntimeCompatibleDimension[] = cloud.map((dimension) => {
        const local = semanticLayer.resolveDimension(dimension.name, metrics);
        const isTime = dimension.type?.toLowerCase() === 'time';
        return {
          ...(local ?? {
            name: dimension.name,
            label: dimension.name.replace(/[_-]+/g, ' '),
            description: dimension.description ?? '',
            domain: '',
            sql: dimension.name,
            type: isTime ? 'date' : 'string',
            table: '',
            isTimeDimension: isTime,
            source: { provider: 'dbt', objectType: 'dimension', objectId: dimension.name, objectName: dimension.name },
          }),
          qualifiedName: dimension.name,
          granularities: dimension.granularities.map((v) => v.toLowerCase()),
        } as RuntimeCompatibleDimension;
      });
      return { engine: 'dbt-cloud', dimensions, incompatible: [] };
    } catch (error) {
      // Preserve source-catalog drift as its own stable contract. Wrapping it in
      // SEMANTIC_RUNTIME_REQUIRED would turn an environment mismatch into a
      // generic setup error and prevents the UI/agent from offering the
      // deploy-and-reapply recovery path.
      if (error instanceof SemanticSourceDriftError) throw error;
      throw new SemanticRuntimeRequiredError(
        `dbt Cloud dimension listing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Local MetricFlow: ask mf itself, then hydrate labels/types from the local
  // catalog by matching each qualified name's tail (same trick as the cloud path).
  if (status.active === 'metricflow-cli') {
    const dbtProjectPath = projectConfig?.semanticLayer?.provider === 'dbt'
      ? projectConfig.semanticLayer.projectPath
      : projectConfig?.dbt?.projectDir;
    const mfDims = await listMetricFlowDimensions({ projectRoot, dbtProjectPath, profilesDir: projectConfig?.dbt?.profilesDir, metrics });
    if (mfDims.length > 0) {
      const dimensions: RuntimeCompatibleDimension[] = mfDims.map((mf) => {
        const tail = mf.qualifiedName.split('__').pop()!.toLowerCase();
        const local = semanticLayer.resolveDimension(mf.qualifiedName, metrics)
          ?? semanticLayer.resolveDimension(tail, metrics);
        const isTime = Boolean(mf.granularities?.length) || Boolean(local?.isTimeDimension);
        return {
          ...(local ?? {
            name: tail,
            label: tail.replace(/[_-]+/g, ' '),
            description: '',
            domain: '',
            sql: tail,
            type: isTime ? 'date' : 'string',
            table: '',
            isTimeDimension: isTime,
            source: { provider: 'dbt', objectType: 'dimension', objectId: tail, objectName: tail },
          }),
          qualifiedName: mf.qualifiedName,
          granularities: mf.granularities,
        } as RuntimeCompatibleDimension;
      });
      return { engine: 'metricflow-cli', dimensions, incompatible: [] };
    }
    throw new SemanticRuntimeRequiredError(projectHasDbtSemantics(projectRoot)
      ? `Local MetricFlow returned no dimensions for ${metrics.join(', ') || 'the selected metrics'}. Run \`dbt parse\` so target/semantic_manifest.json is current, or set the semantic runtime to DQL native in Settings → Semantic runtime.`
      : `Local MetricFlow is selected as the semantic runtime, but ${metrics.join(', ') || 'these metrics'} ${metrics.length === 1 ? 'is' : 'are'} defined in the DQL semantic layer, which MetricFlow does not read. Set the semantic runtime to Auto or DQL native in Settings → Semantic runtime.`);
  }

  return nativeExplain();
}

export async function listRuntimeCompatibleDimensions(
  projectRoot: string,
  semanticLayer: SemanticLayer,
  metrics: string[],
  projectConfig?: SemanticRuntimeProjectConfig,
): Promise<Array<ReturnType<SemanticLayer['listDimensions']>[number]>> {
  const result = await describeRuntimeCompatibility(projectRoot, semanticLayer, metrics, projectConfig);
  return result.dimensions;
}

export function semanticMetricExecutionCapability(
  metricName: string,
  semanticLayer: SemanticLayer,
  provider: string,
  runtime: SemanticRuntimeStatus,
  projectRoot?: string,
): SemanticMetricExecutionCapability {
  const fullRuntime = runtime.active === 'dbt-cloud' || runtime.active === 'metricflow-cli'
    ? runtime.active
    : null;
  if (provider === 'dbt' && fullRuntime) {
    if (fullRuntime === 'dbt-cloud' && projectRoot) {
      const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
      const inventoryState = !cloud.metricNames
        ? 'missing'
        : cloud.metricInventoryComplete
          ? 'complete'
          : 'partial';
      const available = new Set((cloud.metricNames ?? []).map((name) => name.toLowerCase()));
      if (inventoryState !== 'complete' || !available.has(metricName.toLowerCase())) {
        return {
          status: 'requires_setup',
          engine: 'dbt-cloud',
          reasonCode: 'SEMANTIC_SOURCE_DRIFT',
          semanticCatalogFingerprint: cloud.semanticCatalogFingerprint,
          reason: inventoryState !== 'complete'
            ? 'Reapply dbt Cloud Semantic Layer settings to verify its metric inventory before execution.'
            : `Metric "${metricName}" exists locally but is not deployed in dbt Cloud environment ${cloud.environmentId ?? 'unknown'}. Deploy it, then reapply the semantic runtime settings.`,
        };
      }
    }
    return { status: 'ready', engine: fullRuntime, reason: null };
  }
  if (semanticLayer.canComposeMetric(metricName)) {
    return { status: 'ready', engine: 'native', reason: null };
  }
  const metric = semanticLayer.getMetric(metricName);
  if (provider === 'dbt') {
    const kind = metric?.metricType || metric?.aggregation || metric?.type || 'metric';
    return {
      status: 'requires_setup',
      engine: null,
      reason: `${kind} metric requires a full semantic runtime. ${runtime.setup ?? 'Configure dbt Cloud Semantic Layer or local MetricFlow.'}`,
    };
  }
  return {
    status: 'unsupported',
    engine: null,
    reason: 'The metric does not have enough composable measure and relation metadata.',
  };
}

// Timestamp of the last SUCCESSFUL probe per connection fingerprint. A dbt Cloud
// connection that worked recently must not be demoted to "not ready" by a single
// transient probe failure (network blip / cold connection / rate limit) — that
// flipped the active runtime to native and stranded derived metrics on the
// generic "configure a runtime" error for minutes at a time ("first works, then
// not"). Mirrors the MetricFlow positive-resolution cache.
const cloudLastGoodAt = new Map<string, number>();
const CLOUD_TRUST_WINDOW_MS = 30 * 60_000; // treat a failure as transient if it worked within this window

async function probeDbtCloudSemanticRuntime(projectRoot: string): Promise<DbtCloudSemanticTestResult> {
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  if (!cloud.configured || !cloud.fingerprint) {
    return { ok: false, message: 'dbt Cloud Semantic Layer is not configured.' };
  }
  const now = Date.now();
  const cached = cloudProbeCache.get(cloud.fingerprint);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = await testDbtCloudSemanticConnection(cloud, fetch, { includeMetricInventory: false });
  if (result.ok) {
    // A working connection stays trusted for a good while.
    cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 5 * 60_000, result });
    cloudLastGoodAt.set(cloud.fingerprint, now);
    return result;
  }

  // Probe failed. If this connection succeeded within the trust window, treat the
  // failure as transient: keep it ready (better to attempt the real compile and
  // surface a specific cloud error than to silently fall back to native), and
  // retry the probe soon rather than caching the failure for minutes.
  const lastGoodAt = cloudLastGoodAt.get(cloud.fingerprint) ?? 0;
  if (now - lastGoodAt < CLOUD_TRUST_WINDOW_MS) {
    const transient: DbtCloudSemanticTestResult = {
      ok: true,
      message: 'Using the recent successful dbt Cloud connection; a readiness probe failed transiently.',
    };
    cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 20_000, result: transient });
    return transient;
  }
  // No recent success — cache the failure only briefly so it self-heals fast.
  cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 20_000, result });
  return result;
}

function selectActiveAdapter(
  preference: SemanticRuntimePreference,
  cloudReady: boolean,
  cliReady: boolean,
): SemanticRuntimeAdapterId {
  // An explicit preference is a route lock, including while setup is broken.
  // Reporting the preferred adapter as active lets every surface return the
  // original readiness/compiler failure instead of silently selecting a
  // different engine with different semantic behavior.
  if (preference === 'dbt-cloud') return 'dbt-cloud';
  if (preference === 'metricflow-cli') return 'metricflow-cli';
  if (preference === 'native') return 'native';
  if (cloudReady) return 'dbt-cloud';
  if (cliReady) return 'metricflow-cli';
  return 'native';
}

export function isSemanticRuntimeError(error: unknown): boolean {
  return error instanceof SemanticSourceDriftError
    || error instanceof SemanticRuntimeRequiredError
    || error instanceof SemanticRuntimeHavingUnsupportedError
    || error instanceof SemanticRuntimeCompilationError
    || error instanceof SemanticRuntimePathAmbiguityError
    || error instanceof MetricFlowUnavailableError;
}

export function semanticRuntimeErrorCode(
  error: unknown,
): 'SEMANTIC_RUNTIME_REQUIRED' | 'SEMANTIC_HAVING_UNSUPPORTED' | 'SEMANTIC_COMPILATION_FAILED' | 'SEMANTIC_PATH_AMBIGUOUS' | 'SEMANTIC_SOURCE_DRIFT' | undefined {
  if (error instanceof SemanticSourceDriftError) return error.code;
  if (error instanceof SemanticRuntimePathAmbiguityError) return error.code;
  if (error instanceof SemanticRuntimeCompilationError) return error.code;
  if (error instanceof SemanticRuntimeHavingUnsupportedError) return error.code;
  if (error instanceof SemanticRuntimeRequiredError || error instanceof MetricFlowUnavailableError) {
    return 'SEMANTIC_RUNTIME_REQUIRED';
  }
  return undefined;
}

export function semanticRuntimeErrorDetails(error: unknown): unknown {
  if (error instanceof MetricFlowAskTargetMismatchError) return error.details;
  if (error instanceof SemanticSourceDriftError) return error.details;
  if (error instanceof SemanticRuntimePathAmbiguityError) {
    return {
      ...error.details,
      semanticTrace: error.semanticTrace,
    };
  }
  if (error instanceof SemanticRuntimeCompilationError) {
    return {
      adapter: error.adapter,
      phase: 'compilation',
    };
  }
  return undefined;
}
