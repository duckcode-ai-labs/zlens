/**
 * `zlens agent` — block-first answer loop on the command line.
 *
 *   zlens agent ask "what was revenue last week?"
 *     [--provider claude|openai|gemini|ollama]
 *     [--user alice@acme.com]   (filters Skills + records feedback as this user)
 *     [--domain growth] [--purpose growth_attribution]
 *     [--format json]           (emits structured JSON instead of prose)
 *     [--thread <id>]           (continue a persisted conversation thread: the
 *                                question runs through the runtime's agent-run
 *                                engine, which injects prior turns and records
 *                                this one server-side)
 *
 *   zlens agent threads
 *     Lists persisted conversation threads (id, updated, title) from the runtime.
 *
 *   zlens agent reindex [path]
 *     Rebuilds .dql/cache/agent-kg.sqlite and metadata.sqlite from the
 *     project's manifest + Skills folder. Equivalent to `zlens app reindex`.
 *
 *   zlens agent feedback <up|down> --block <id> --question "..."
 *     Records feedback into the KG. Used by clients without MCP access.
 */

import {
  answerFromRuntimeRun,
  driveViaRuntime,
  projectRuntimeRun,
  type RuntimeDrivenRun,
} from './agent-eval-runtime.js';
import {
  CassetteStore,
  cassetteEvidenceLine,
  cassetteEvidenceSummary,
  cassetteDirFor,
  evalCassetteCanonicalizationV2,
  resolveCassetteModeFromEnv,
  runtimeCassetteModeMismatch,
  withCassette,
  type CassetteMode,
} from './agent-eval-cassette.js';
import type { AgentRun } from '@zlens/agent';
import { goldRowsMatch } from './eval-row-match.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  AskTraceSqliteStoreV1,
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  reindexProject,
  autoUpgradeProjectEmbeddings,
  probeLocalOllamaEmbeddings,
  upgradeVectorIndexForProject,
  setProcessDefaultEmbeddingProvider,
  isHashedEmbeddingProvider,
  projectEmbeddingProvider,
  readProjectEmbeddingSettings,
  loadSkills,
  pickProvider,
  resolveDomainContextEnvelope,
  buildAnalysisQuestionPlan,
  buildLocalContextPack,
  classifyProviderFailure,
  coerceReasoningEffort,
  contextRetrievalBudgetForQuestion,
  deriveGeneratedDraftSlug,
  loadAgentSemanticLayer,
  recordQueryRun,
  recordRuntimeSchemaSnapshot,
  type ProviderName,
  type AgentProvider,
  upsertGeneratedDqlArtifactDraft,
  upsertGeneratedDraft,
  validateSqlAgainstLocalContext,
  type AgentAnswer,
  type AgentFollowUpContext,
  type AgentResultPayload,
  type AgentSchemaTable,
  type AnalysisDepth,
  type NarrationIntegrityReceiptV1,
  type ReasoningEffort,
  createAskTraceObserverV1,
  defaultAskTraceSqlitePath,
  type AskTraceObserverV1,
  type ProviderAttemptTraceV1,
  type ProviderDispatchCompletionEvent,
  type ProviderDispatchEvent,
  type ProviderToolLoopOptions,
} from '@zlens/agent';
import { createHash, randomUUID } from 'node:crypto';
import { buildManifest, resolveDbtManifestPath } from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { buildAnswerLoopTools, createGroundingContextExpander } from '../llm/answer-loop-tools.js';
import { judgeAnswer, type JudgeCompletion } from './eval-judge.js';
import { startProjectRuntime } from './notebook.js';
import { runAgentTrace } from './agent-trace.js';
import { readEnv } from '@zlens/core';

/**
 * Resolve the runtime the agent posts certified blocks / generated SQL to.
 *
 * If the caller pinned one (`--runtime-url` / `ZLENS_RUNTIME_URL`) we validate it is
 * actually a reachable ZLens runtime — a bare `/api/health` is not enough, since
 * unrelated servers (e.g. Docker on :3474) answer `{"status":"ok"}` and would then
 * swallow the block with a misleading "no connection" error. Otherwise we start an
 * ephemeral runtime bound to THIS project on a free port and close it when done, so
 * there is no hardcoded-port collision and the runtime always matches the project.
 */
async function resolveAgentRuntime(
  projectRoot: string,
  flags: CLIFlags,
): Promise<{ runtimeBase: string; close: () => Promise<void>; askTraceCapability?: string }> {
  const explicit = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
    ?? (flags as { runtime?: string }).runtime
    ?? readEnv('ZLENS_RUNTIME_URL');
  if (explicit) {
    const base = explicit.replace(/\/$/, '');
    if (!(await isDqlRuntime(base))) {
      throw new Error(
        `No ZLens runtime is reachable at ${base}. Start one with \`zlens notebook\`, or omit ` +
          `--runtime-url / ZLENS_RUNTIME_URL to let \`zlens agent ask\` start an ephemeral runtime.`,
      );
    }
    return { runtimeBase: base, close: async () => {} };
  }
  const handle = await startProjectRuntime(projectRoot, { preferredPort: 0 });
  return { runtimeBase: handle.url, close: handle.close, askTraceCapability: handle.askTraceCapability };
}

function isLoopbackRuntimeUrl(runtimeBase: string): boolean {
  try {
    const hostname = new URL(runtimeBase).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * An already-running local Notebook runtime mints a one-shot, loopback-only
 * capability for this CLI request. Remote runtimes deliberately receive no
 * capability and therefore cannot be relabelled as CLI by arbitrary text.
 */
export async function requestLoopbackCliAskTraceCapability(runtimeBase: string): Promise<string | undefined> {
  if (!isLoopbackRuntimeUrl(runtimeBase)) return undefined;
  try {
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/ask-traces/cli-capability`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { capability?: unknown; expiresAt?: unknown; scope?: unknown };
    return typeof payload.capability === 'string'
      && typeof payload.expiresAt === 'string'
      && payload.scope === 'agent-runs'
      ? payload.capability
      : undefined;
  } catch {
    // A pre-observability runtime remains usable. Its request stays browser
    // attributed rather than fabricating a client-controlled CLI surface.
    return undefined;
  }
}

function runtimeProviderForCliFlag(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  switch (value.trim().toLowerCase()) {
    case 'claude': return 'anthropic';
    case 'openai': return 'openai';
    case 'gemini': return 'gemini';
    case 'ollama': return 'ollama';
    // Preserve an invalid explicit value through the host request so the
    // canonical preflight can return a typed `model_not_found` diagnostic.
    default: return value.trim().toLowerCase();
  }
}

async function fetchRuntimeSchemaContext(runtimeBase: string): Promise<AgentSchemaTable[]> {
  try {
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/schema`);
    if (!response.ok) return [];
    const raw = await response.json();
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeRuntimeSchemaTable)
      .filter((table): table is AgentSchemaTable => Boolean(table))
      .slice(0, 500);
  } catch {
    return [];
  }
}

function normalizeRuntimeSchemaTable(raw: unknown): AgentSchemaTable | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const table = raw as Record<string, unknown>;
  const relation = cleanRuntimeSchemaString(table.path) ?? cleanRuntimeSchemaString(table.name);
  if (!relation) return undefined;
  const columns = Array.isArray(table.columns)
    ? table.columns
        .map(normalizeRuntimeSchemaColumn)
        .filter((column): column is AgentSchemaTable['columns'][number] => Boolean(column))
        .slice(0, 120)
    : [];
  const declared = cleanRuntimeSchemaString(table.columnCompleteness);
  return {
    relation,
    name: cleanRuntimeSchemaString(table.name) ?? relation.split('.').pop() ?? relation,
    source: cleanRuntimeSchemaString(table.source) ?? 'runtime schema',
    columns,
    columnCompleteness: declared === 'complete' && (Array.isArray(table.columns) ? table.columns.length : 0) <= 120 ? 'complete' : 'partial',
  };
}

function normalizeRuntimeSchemaColumn(raw: unknown): AgentSchemaTable['columns'][number] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const column = raw as Record<string, unknown>;
  const name = cleanRuntimeSchemaString(column.name);
  if (!name) return undefined;
  return {
    name,
    type: cleanRuntimeSchemaString(column.type),
    description: cleanRuntimeSchemaString(column.description),
  };
}

function recordCliRuntimeSchemaSnapshot(projectRoot: string, schemaContext: AgentSchemaTable[], source: string): void {
  if (schemaContext.length === 0) return;
  try {
    recordRuntimeSchemaSnapshot(projectRoot, {
      source,
      tables: schemaContext.map((table) => ({
        relation: table.relation,
        schema: table.schema,
        name: table.name,
        description: table.description,
        source: table.source,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.type,
          description: column.description,
          sampleValues: column.sampleValues?.slice(0, 8),
        })),
      })),
    });
  } catch {
    // Runtime schema snapshots are advisory local metadata and must not block answers.
  }
}

function cleanRuntimeSchemaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cliReasoningEffort(flags: CLIFlags): ReasoningEffort | undefined {
  return coerceReasoningEffort(flags.reasoningEffort);
}

function cliAnalysisDepth(flags: CLIFlags): AnalysisDepth | undefined {
  const value = flags.analysisDepth?.trim().toLowerCase();
  return value === 'quick' || value === 'deep' ? value : undefined;
}

/**
 * Compatibility test adapter for a standalone provider boundary. Production
 * `zlens agent ask` no longer calls this: it uses the runtime AgentRun engine so
 * the router, cascade, freeze, tools, SQL, and provider spans share one
 * canonical trace. Keep this adapter truthful for lower-level provider tests
 * without making it an alternate orchestration authority.
 */
export function createDirectCliAskTraceProvider(
  provider: AgentProvider,
  trace: AskTraceObserverV1,
): AgentProvider {
  let attemptIndex = 0;
  let lastFailedSpanId: string | undefined;
  type Entry = { spanId: string | undefined; attempt: ProviderAttemptTraceV1 };
  const pending = new Map<string, Entry[]>();
  const keyFor = (event: Pick<ProviderDispatchEvent, 'provider' | 'operation' | 'attemptIndex'>) =>
    `${event.provider}:${event.operation}:${event.attemptIndex}`;
  const attempt = (event: Pick<ProviderDispatchEvent, 'provider' | 'model'>, retryOfSpanId?: string): ProviderAttemptTraceV1 => ({
    version: 1 as const,
    phase: 'generation' as const,
    physicalAttemptIndex: ++attemptIndex,
    providerFingerprint: `sha256:${createHash('sha256').update(event.provider).digest('hex')}`,
    ...(event.model ? { modelFingerprint: `sha256:${createHash('sha256').update(event.model).digest('hex')}` } : {}),
    ...(retryOfSpanId ? { retryOfSpanId } : {}),
    admission: 'admitted' as const,
    provenance: 'live' as const,
  });
  const finish = (entry: Entry, outcome: 'ok' | 'error' | 'cancelled', error?: unknown) => {
    if (!entry.spanId) return;
    const diagnostic = outcome === 'ok' ? undefined : classifyProviderFailure({
      phase: 'generation',
      code: error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : undefined,
      message: error instanceof Error ? error.message : String(error ?? ''),
      providerFingerprint: entry.attempt.providerFingerprint,
      modelFingerprint: entry.attempt.modelFingerprint,
    });
    const finalAttempt: ProviderAttemptTraceV1 = outcome === 'ok'
      ? entry.attempt
      : {
          ...entry.attempt,
          ...(diagnostic?.httpStatusClass ? { httpStatusClass: diagnostic.httpStatusClass } : {}),
          ...(diagnostic ? { retryable: diagnostic.retryable, safeAction: diagnostic.safeAction } : {}),
          cause: outcome === 'cancelled' ? 'cancelled' : diagnostic?.cause ?? 'unknown',
        };
    trace.finishSpan(entry.spanId, {
      outcome: outcome === 'ok' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'error',
      reasonCode: outcome === 'ok' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'provider_failure',
      payload: { kind: 'provider', attempt: finalAttempt },
    });
    if (outcome !== 'ok') lastFailedSpanId = entry.spanId;
  };
  const observedOptions = (options: ProviderToolLoopOptions = {}): ProviderToolLoopOptions => ({
    ...options,
    onProviderDispatch: (event) => {
      const tracedAttempt = attempt(event, lastFailedSpanId);
      const spanId = trace.startSpan({
        name: 'provider.attempt',
        stage: 'provider',
        reasonCode: 'started',
        payload: { kind: 'provider', attempt: tracedAttempt },
      });
      const key = keyFor(event);
      pending.set(key, [...(pending.get(key) ?? []), { spanId, attempt: tracedAttempt }]);
      return options.onProviderDispatch?.(event) ?? event.envelope;
    },
    onProviderDispatchComplete: (event: ProviderDispatchCompletionEvent) => {
      const key = keyFor(event);
      const entries = pending.get(key) ?? [];
      const entry = entries[0];
      if (entry && event.outcome === 'ok' && (event.settlement === 'transport' || event.settlement === 'process')) {
        entry.attempt = {
          ...entry.attempt,
          ...(event.settlement === 'transport' ? { transportOutcome: 'ok' as const } : { processOutcome: 'ok' as const }),
        };
      } else {
        const closed = entries.shift();
        if (entries.length > 0) pending.set(key, entries); else pending.delete(key);
        if (closed) finish(
          closed,
          event.outcome,
          event.error ?? (typeof event.httpStatus === 'number' ? Object.assign(new Error(`HTTP ${event.httpStatus}`), { code: `HTTP_${event.httpStatus}` }) : undefined),
        );
      }
      options.onProviderDispatchComplete?.(event);
    },
    onProviderDispatchRejected: (event) => {
      const denied = trace.startSpan({
        name: 'provider.attempt',
        stage: 'provider',
        reasonCode: 'provider_failure',
        payload: {
          kind: 'provider',
          attempt: {
            ...attempt(event, lastFailedSpanId),
            admission: 'denied' as const,
          },
        },
      });
      trace.finishSpan(denied, { outcome: 'denied', reasonCode: 'provider_failure' });
      lastFailedSpanId = denied;
      options.onProviderDispatchRejected?.(event);
    },
  });
  const invoke = async <T>(options: ProviderToolLoopOptions | undefined, call: (observed: ProviderToolLoopOptions) => Promise<T>): Promise<T> => {
    try {
      const result = await call(observedOptions(options));
      for (const entries of pending.values()) for (const entry of entries) finish(entry, 'ok');
      pending.clear();
      return result;
    } catch (error) {
      const outcome = options?.signal?.aborted ? 'cancelled' as const : 'error' as const;
      for (const entries of pending.values()) for (const entry of entries) finish(entry, outcome, error);
      pending.clear();
      throw error;
    }
  };
  return {
    name: provider.name,
    available: () => provider.available(),
    generate: (messages, options) => invoke(options, (observed) => provider.generate(messages, observed)),
    ...(provider.generateWithTools ? {
      generateWithTools: (messages: Parameters<NonNullable<AgentProvider['generateWithTools']>>[0], tools: Parameters<NonNullable<AgentProvider['generateWithTools']>>[1], options?: Parameters<NonNullable<AgentProvider['generateWithTools']>>[2]) =>
        invoke(options, (observed) => provider.generateWithTools!(messages, tools, observed)),
    } : {}),
    ...(provider.generateStream ? {
      generateStream: (messages: Parameters<NonNullable<AgentProvider['generateStream']>>[0], options: Parameters<NonNullable<AgentProvider['generateStream']>>[1], onDelta: Parameters<NonNullable<AgentProvider['generateStream']>>[2]) =>
        invoke(options, (observed) => provider.generateStream!(messages, observed, onDelta)),
    } : {}),
  };
}

/** A ZLens runtime answers `/api/connections` with a connector/connection payload. */
async function isDqlRuntime(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/connections`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return 'connectorStatus' in body || 'dbtProfiles' in body || 'connections' in body;
  } catch {
    return false;
  }
}

export async function runAgent(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'ask':
      return runAsk(rest, flags);
    case 'threads':
      return runThreads(flags);
    case 'trace':
      return runAgentTrace(rest, flags);
    case 'reindex':
      return runReindex(rest, flags);
    case 'feedback':
      return runFeedback(rest, flags);
    case 'eval':
      return runEval(rest, flags);
    default:
      throw new Error(
        'Usage: zlens agent <ask|threads|trace|reindex|feedback|eval> [args]\n' +
            '  zlens agent ask "<question>" [--provider claude|openai|gemini|ollama] [--user <id>] [--domain <d>] [--purpose <approved-purpose>] [--thread <id>]\n' +
      '  zlens agent threads [--runtime-url <url>]\n' +
      '  zlens agent trace list|show|export|validate|replay|compare\n' +
      '  zlens agent reindex [path]\n' +
      '  zlens agent feedback up|down --block <id> --question "..."\n' +
      '  zlens agent eval agent-evals.yml [--provider claude|openai|gemini|ollama] [--execute] [--save]\n',
        );
  }
}

/**
 * Canonical CLI Ask entrypoint. Direct and threaded CLI questions use the
 * exact local AgentRun engine as the browser, so trace evidence follows the
 * router's candidate/cascade/freeze/execution authority rather than a legacy
 * answer-loop approximation.
 */
async function runAsk(rest: string[], flags: CLIFlags): Promise<void> {
  const question = rest.join(' ').trim();
  if (!question) throw new Error('Usage: zlens agent ask "<question>"');
  const threadId = (flags as { thread?: string }).thread;
  return threadId
    ? runThreadAsk(question, threadId, flags)
    : runCanonicalCliAsk(question, undefined, flags);
}

/**
 * Compatibility entrypoint retained for downstream imports during the CLI
 * transition. It deliberately delegates before allocating any legacy state,
 * so even an old internal caller gets the canonical AgentRun trace rather than
 * an incomplete synthetic receipt.
 */
async function runLegacyDirectAsk(rest: string[], flags: CLIFlags): Promise<void> {
  const question = rest.join(' ').trim();
  if (!question) throw new Error('Usage: zlens agent ask "<question>"');
  return runCanonicalCliAsk(question, (flags as { thread?: string }).thread, flags);

  // Thread-scoped ask: hand the question to the runtime's agent-run engine with
  // the thread id, so the SERVER injects prior turns and persists this run as a
  // new turn (the same conversation store the notebook UI uses).
  const threadId = (flags as { thread?: string }).thread;
  if (threadId) return runThreadAsk(question, threadId!, flags);

  const projectRoot = findProjectRoot(process.cwd());
  const traceStore = new AskTraceSqliteStoreV1({ path: defaultAskTraceSqlitePath(projectRoot) });
  const trace = createAskTraceObserverV1({
    store: traceStore,
    runId: `cli-${randomUUID()}`,
    surface: 'cli',
    mode: 'ask',
    questionFingerprint: `sha256:${createHash('sha256').update(question).digest('hex')}`,
  });
  const classifySpan = trace.startSpan({
    name: 'request.classify',
    stage: 'request',
    reasonCode: 'started',
    payload: { kind: 'stage', route: 'direct_cli_legacy' },
  });
  const kgPath = defaultKgPath(projectRoot);
  try {
    await reindexProject(projectRoot, { kgPath });
    trace.finishSpan(classifySpan, { outcome: 'ok', reasonCode: 'completed' });
  } catch (error) {
    trace.finishSpan(classifySpan, { outcome: 'error', reasonCode: 'unknown' });
    trace.finalize({ status: 'failed' });
    traceStore.close();
    throw error;
  }

  const providerName = (flags as { provider?: string }).provider as ProviderName | undefined;
  const userId = (flags as { user?: string }).user;
  const domain = (flags as { domain?: string }).domain;
  const purpose = flags.purpose || undefined;
  const format = (flags as { format?: string }).format;
  const reasoningEffort = cliReasoningEffort(flags);
  const requestedDepth = cliAnalysisDepth(flags);

  let provider: AgentProvider;
  try {
    provider = await pickProvider(providerName);
  } catch (error) {
    trace.finalize({ status: 'failed' });
    traceStore.close();
    throw error;
  }
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);

  let closeRuntime: (() => Promise<void>) | undefined;
  try {
    const preflight = trace.startSpan({
      name: 'provider.preflight',
      stage: 'provider',
      reasonCode: 'started',
      payload: {
        kind: 'provider',
        attempt: {
          version: 1,
          phase: 'preflight',
          physicalAttemptIndex: 0,
          providerFingerprint: `sha256:${createHash('sha256').update(provider.name).digest('hex')}`,
          readiness: 'unknown',
          admission: 'unknown',
          provenance: 'live',
        },
      },
    });
    let providerReady = false;
    try { providerReady = await provider.available(); } catch { providerReady = false; }
    trace.finishSpan(preflight, {
      outcome: providerReady ? 'ok' : 'unavailable',
      reasonCode: providerReady ? 'completed' : 'provider_preflight',
      payload: {
        kind: 'provider',
        attempt: {
          version: 1,
          phase: 'preflight',
          physicalAttemptIndex: 0,
          providerFingerprint: `sha256:${createHash('sha256').update(provider.name).digest('hex')}`,
          readiness: providerReady ? 'ready' : 'unavailable',
          admission: 'unknown',
          cause: providerReady ? undefined : 'authentication',
          safeAction: providerReady ? undefined : 'fix_provider_configuration',
          provenance: 'live',
        },
      },
    });
    if (!providerReady) {
      throw Object.assign(new Error('The selected AI provider is not ready. Configure or sign in to the provider and retry.'), {
        code: 'AUTHENTICATION_FAILED',
      });
    }
    const tracedProvider = createDirectCliAskTraceProvider(provider, trace);
    const memoryContext = memory.search({
      query: question,
      scopes: ['project', 'user', 'artifact'],
      limit: 6,
    });
    const semanticLayer = loadAgentSemanticLayer(projectRoot);
    const questionPlan = buildAnalysisQuestionPlan(question);
    const contextBudget = contextRetrievalBudgetForQuestion({
      questionPlan,
      requestedDepth,
      reasoningEffort,
    });
    const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
    const domainContext = domain ? resolveDomainContextEnvelope({ manifest, activeDomain: domain, purpose, source: 'explicit_api' }) : undefined;
    const { runtimeBase, close } = await resolveAgentRuntime(projectRoot, flags);
    closeRuntime = close;
    const schemaContext = await fetchRuntimeSchemaContext(runtimeBase);
    recordCliRuntimeSchemaSnapshot(projectRoot, schemaContext, 'direct CLI runtime schema');
    const retrievalSpan = trace.startSpan({
      name: 'retrieval',
      stage: 'retrieval',
      reasonCode: 'started',
      payload: { kind: 'retrieval', candidateCount: 0 },
    });
    const contextPack = await buildLocalContextPack(projectRoot, {
      question,
      surface: 'cli',
      strictness: contextBudget.strictness,
      limit: contextBudget.limit,
      domainContext,
      runtimeSchemaSnapshot: schemaContext.length > 0
        ? {
            source: 'direct CLI runtime schema',
            tables: schemaContext,
          }
        : undefined,
    }).catch(() => undefined);
    trace.finishSpan(retrievalSpan, {
      outcome: 'ok',
      reasonCode: 'completed',
      payload: { kind: 'retrieval', candidateCount: contextPack?.objects.length ?? 0 },
    });
    // The running runtime owns Ask: routing, the V2 lane, the plan boundary,
    // the gates, and the persisted run. The CLI drives it over HTTP exactly as
    // the notebook and the MCP server do; there is no second, in-process path.
    const runtimeRun = await driveViaRuntime({ runtimeBase, question, requestedMode: 'auto', timeoutMs: 180_000, workspaceContext: { ...(domain ? { domain } : {}), ...(purpose ? { purpose } : {}) } });
    const result = answerFromRuntimeRun(runtimeRun);

    trace.finalize({ status: 'completed' });

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const badge = result.kind === 'certified'
      ? '✓ Certified'
      : result.kind === 'uncertified'
        ? '! AI-generated · uncertified'
        : '? No answer';
    const cite = result.citations.length > 0
      ? '\n\nCitations:\n' + result.citations.map((c) => `  - ${c.kind} \`${c.name}\`${c.gitSha ? ` · ${c.gitSha.slice(0, 8)}` : ''}`).join('\n')
      : '';
    const footer = result.provenanceFooter ? `\n\n— ${result.provenanceFooter}` : '';
    console.log(`${badge}\n\n${result.text}${footer}${cite}`);
    const resultPayload = result.result!;
    if (resultPayload) {
      console.log(`\nRows: ${resultPayload.rowCount}`);
      console.log(JSON.stringify(resultPayload.rows.slice(0, 5), null, 2));
    }
    printDqlArtifactPreview(result);
  } catch (error) {
    const cancelled = error instanceof Error && (error as Error).name === 'AbortError';
    trace.finalize({ status: cancelled ? 'cancelled' : 'failed' });
    throw error;
  } finally {
    kg.close();
    memory.close();
    const close = closeRuntime;
    if (close) await close!();
    traceStore.close();
  }
}

function printDqlArtifactPreview(result: AgentAnswer): void {
  const dqlSource = result.dqlArtifact?.source?.trim();
  if (dqlSource) {
    console.log(`\n--- DQL artifact (${result.dqlArtifact?.kind ?? 'draft'}) ---\n${dqlSource}`);
  }
  if (result.proposedSql) {
    const label = dqlSource
      ? 'Compiled SQL preview'
      : 'Proposed SQL (review before saving as a block)';
    console.log(`\n--- ${label} ---\n${result.proposedSql}`);
    if (result.suggestedViz) console.log(`Viz: ${result.suggestedViz}`);
    if (result.draftBlock?.path) console.log(`Draft: ${result.draftBlock.path}`);
    if (result.promoteCommand) console.log(`Promote: ${result.promoteCommand}`);
  }
}

/** Minimal slice of the runtime's AgentRun payload that the CLI prints. */
interface AgentThreadRun {
  id?: string;
  route?: string;
  trustState?: string;
  answer?: string;
  summary?: string;
  traceReference?: {
    traceId?: string;
    recordingStatus?: string;
  };
  reviewDraft?: { path: string; askedTimes: number; created: boolean };
}

function printCanonicalCliAskRun(run: AgentThreadRun, threadId?: string): void {
  const badge = run.trustState === 'certified'
    ? '✓ Certified'
    : run.trustState === 'grounded'
      ? '✓ Verified (grounded)'
      : run.trustState === 'review_required'
        ? '! AI-generated · review required'
        : run.trustState === 'blocked'
          ? '✕ Blocked'
          : '· Reply';
  console.log(`${badge}\n\n${(run.answer ?? run.summary ?? '').trim()}`);
  if (run.reviewDraft?.path) {
    // Tier 2: the review-required answer was saved as a draft (never certified).
    const again = run.reviewDraft.created ? '' : ` (asked ${run.reviewDraft.askedTimes} times; existing draft reused)`;
    console.log(`\nReview draft saved: ${run.reviewDraft.path}${again}`);
    console.log(`  Not certified. Review it, then certify with: zlens certify --from-draft ${run.reviewDraft.path} --owner <you>`);
  }
  if (threadId) console.log(`\nThread: ${threadId}`);
  const trace = run.traceReference;
  if (trace?.traceId) {
    console.log(`\nTrace: ${trace.traceId} (${trace.recordingStatus ?? 'recording'})`);
  } else {
    console.log('\nTrace: unavailable');
  }
}

/**
 * Submit every user-visible CLI Ask through the runtime AgentRun endpoint.
 * The runtime owns run IDs, conversation hydration, candidate provenance,
 * cascade/freeze authority, physical tool/SQL execution, and final trace
 * reference. The CLI only supplies user intent and an optional host-minted
 * surface capability.
 */
/**
 * Say so when this project is answering from a token-hash index.
 *
 * Re-embedding a 63k-object catalog takes minutes, so `ask` must never do it —
 * but staying silent about it is how a machine with `nomic-embed-text` already
 * pulled kept serving lexical-only retrieval, and every "it cannot find my
 * model" report looked like a ranking bug instead of an unbuilt index. One
 * line, once, naming the command that fixes it.
 */
let lexicalRetrievalWarned = false;
function warnWhenRetrievalIsLexicalOnly(projectRoot: string): void {
  if (lexicalRetrievalWarned || process.env.VITEST) return;
  try {
    if (readProjectEmbeddingSettings(projectRoot).provider) return;
    if (!isHashedEmbeddingProvider(projectEmbeddingProvider(projectRoot))) return;
    lexicalRetrievalWarned = true;
    console.error('ZLens: retrieval is using the token-hash index (lexical matching only).'
      + ' Run `zlens agent reindex` to embed with a local model, if one is installed.');
  } catch {
    // A warning must never be the reason an answer does not happen.
  }
}

export async function runCanonicalCliAsk(question: string, threadId: string | undefined, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const format = (flags as { format?: string }).format;
  if (format !== 'json') warnWhenRetrievalIsLexicalOnly(projectRoot);
  const { runtimeBase, close, askTraceCapability: embeddedCapability } = await resolveAgentRuntime(projectRoot, flags);
  try {
    const askTraceCapability = embeddedCapability ?? await requestLoopbackCliAskTraceCapability(runtimeBase);
    const reasoningEffort = cliReasoningEffort(flags);
    const analysisDepth = cliAnalysisDepth(flags);
    const domain = (flags as { domain?: string }).domain;
    const purpose = flags.purpose || undefined;
    const userId = (flags as { user?: string }).user;
    const provider = runtimeProviderForCliFlag((flags as { provider?: string }).provider);
    // `surface` is deliberately absent from public JSON. The runtime assigns
    // trace surface only after consuming its own loopback capability; this
    // context carries user intent, never attribution authority.
    const workspaceContext = {
      ...(domain ? { domain } : {}),
      ...(purpose ? { purpose } : {}),
      ...(userId ? { userId } : {}),
      ...(provider ? { provider } : {}),
    };
    const hasWorkspaceContext = Object.keys(workspaceContext).length > 0;
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/agent-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(askTraceCapability ? { 'X-DQL-Ask-Trace-Capability': askTraceCapability } : {}),
      },
      body: JSON.stringify({
        question,
        ...(threadId ? { threadId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(analysisDepth ? { analysisDepth } : {}),
        ...(hasWorkspaceContext ? { workspaceContext } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { run?: AgentThreadRun };
    if (!payload.run?.id) throw new Error('Runtime did not return a canonical agent run.');
    const run = payload.run;
    if (format === 'json') {
      // Preserve the established top-level run shape while adding compact,
      // content-free trace discoverability for scripts and support bundles.
      console.log(JSON.stringify({
        ...run,
        runId: run.id,
        ...(run.traceReference?.traceId ? { traceId: run.traceReference.traceId } : {}),
        traceRecordingStatus: run.traceReference?.recordingStatus ?? 'unavailable',
      }, null, 2));
      return;
    }
    printCanonicalCliAskRun(run, threadId);
  } finally {
    await close();
  }
}

/**
 * `zlens agent ask --thread <id>` — POST the question to the runtime's
 * `/api/agent-runs` with the threadId in the body. The server injects the
 * thread's prior turns into the conversation context and records the completed
 * run as the next turn, so follow-ups resolve "those"/"that product" correctly
 * across CLI invocations (and across the notebook UI, which shares the store).
 */
async function runThreadAsk(question: string, threadId: string, flags: CLIFlags): Promise<void> {
  return runCanonicalCliAsk(question, threadId, flags);
}

/** `zlens agent threads` — list server-persisted conversation threads. */
async function runThreads(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const format = (flags as { format?: string }).format;
  const { runtimeBase, close } = await resolveAgentRuntime(projectRoot, flags);
  try {
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/agent/threads?limit=50`);
    if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as {
      threads?: Array<{ id: string; surface?: string; title?: string; updatedAt?: string }>;
    };
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    if (format === 'json') {
      console.log(JSON.stringify({ threads }, null, 2));
      return;
    }
    if (threads.length === 0) {
      console.log('No conversation threads yet. Ask from the notebook UI, or continue one here with `zlens agent ask "<question>" --thread <id>`.');
      return;
    }
    for (const thread of threads) {
      const updated = thread.updatedAt ? new Date(thread.updatedAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      console.log(`  ${thread.id}  ${updated}  [${thread.surface ?? 'notebook'}]  ${thread.title ?? '(untitled)'}`);
    }
    console.log(`\n${threads.length} thread(s). Continue one: zlens agent ask "<question>" --thread <id>`);
  } finally {
    await close();
  }
}

function recordCliQueryRun(
  projectRoot: string,
  run: {
    objectKey?: string;
    source: string;
    status: string;
    rowCount?: number;
    durationMs?: number;
    errorCode?: string;
    payload?: Record<string, unknown>;
  },
): void {
  try {
    recordQueryRun(projectRoot, run);
  } catch {
    // Local query-run history is advisory and must not block CLI answers.
  }
}

async function runReindex(rest: string[], flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(rest[0] ?? process.cwd()));
  const stats = await reindexProject(projectRoot);
  // Re-embedding a large catalog with a real model takes minutes, so it can
  // only belong to the one command whose whole job is building the index. The
  // server does it in the background and `ask` only reports it; leaving it out
  // of `reindex` too is why a machine with nomic-embed-text pulled kept
  // answering from a token-hash index.
  const embeddings = (flags as { embeddings?: string }).embeddings === 'off'
    ? { providerId: 'hashed-token-v1', upgraded: false, reason: 'disabled' as const }
    : await autoUpgradeProjectEmbeddings(projectRoot, {
      probeLocalOllamaEmbeddings,
      upgradeVectorIndexForProject,
      setProcessDefaultEmbeddingProvider,
    });
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: true, ...stats, embeddings }, null, 2));
    return;
  }
  const kgStatus = stats.kgRebuilt ? 'KG rebuilt' : 'KG fresh';
  const catalogStatus = stats.metadataRefreshed ? 'metadata refreshed' : 'metadata fresh';
  console.log(`  ✓ ${kgStatus}; ${catalogStatus} — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`);
  if (embeddings.upgraded) {
    console.log(`  ✓ Semantic retrieval re-embedded with local Ollama (${embeddings.model}).`);
  } else if (embeddings.reason === 'not_chosen') {
    const local = (embeddings as { localModel?: string }).localModel;
    console.log(`  · Search: word-based.${local ? ` Local Ollama embeddings (${local}) are available on this computer:` : ''} Turn on local embeddings in Settings → AI provider → Search for meaning-based search.`);
  } else if (embeddings.reason === 'no_local_model') {
    console.log('  · Embeddings: token-hash fallback (lexical only). Install Ollama and pull an embedding'
      + ' model such as nomic-embed-text, then rerun, for meaning-based retrieval.');
  } else if (embeddings.reason === 'reembed_failed') {
    console.log('  · Embeddings: kept the existing index — the local model answered the probe but could not embed.');
  }
}

async function runFeedback(rest: string[], flags: CLIFlags): Promise<void> {
  const rating = rest[0];
  if (rating !== 'up' && rating !== 'down') {
    throw new Error('Usage: zlens agent feedback up|down --block <id> --question "..."');
  }
  const blockId = (flags as { block?: string }).block;
  const question = (flags as { question?: string }).question;
  const user = (flags as { user?: string }).user ?? `${process.env.USER ?? 'owner'}@local`;
  if (!question) throw new Error('--question is required');

  const projectRoot = findProjectRoot(process.cwd());
  const kgPath = defaultKgPath(projectRoot);
  if (!existsSync(kgPath)) throw new Error('KG not built. Run `zlens agent reindex`.');
  const kg = new KGStore(kgPath);
  try {
    kg.recordFeedback({
      id: `fb_${Date.now().toString(36)}`,
      ts: new Date().toISOString(),
      user,
      question,
      answerKind: blockId?.startsWith('block:') ? 'certified' : 'uncertified',
      blockId,
      rating,
      comment: (flags as { comment?: string }).comment,
    });
    console.log(`  ✓ Recorded ${rating} from ${user}.`);
  } finally {
    kg.close();
  }
}

interface AgentEvalFile {
  cases?: AgentEvalCase[];
}

interface AgentEvalCase {
  name?: string;
  question: string;
  domain?: string;
  followUp?: AgentFollowUpContext;
  selectedContext?: unknown;
  expected?: {
    sourceTier?: 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
    certification?: 'certified' | 'ai_generated' | 'analyst_review_required';
    kind?: 'certified' | 'uncertified' | 'no_answer';
    sqlContains?: string | string[];
    sqlNotContains?: string | string[];
    citationKind?: string;
    noHallucinatedColumns?: string[];
    route?: 'certified' | 'generated_sql' | 'research' | 'clarify' | 'blocked';
    intent?: string;
    reviewStatus?: 'none' | 'draft_ready' | 'analyst_review_required' | 'certified';
    missingContextKind?: string;
    /** Persisted router terminal outcome required for runtime-driven gap cases. */
    terminalOutcomeKind?: 'modeling_gap' | 'policy_blocked';
    /** OBS-008: assert the compact local trace state without opening trace detail. */
    traceRecordingStatus?: 'recording' | 'complete' | 'partial' | 'unavailable' | 'detail_expired';
    allowedRelationsOnly?: boolean;
    allowedColumnsOnly?: boolean;
    draftSaved?: boolean;
    minToolCalls?: number;
    rows?: unknown[];
    /**
     * A public benchmark's correct answer: the rows its reference SQL returns.
     * Compared by values, ignoring column names and order (see
     * eval-row-match.ts), because a benchmark names its columns its own way.
     */
    goldRows?: unknown[];
    /** The reference SQL the gold rows came from, kept for audit. */
    goldSql?: string;
    /** The question asks for an order, so rows must come back in it. */
    goldOrdered?: boolean;
    /** The answer may carry columns the correct answer does not. */
    goldAllowExtraColumns?: boolean;
    /**
     * Is this question answerable at all?
     *
     * When true, ANY refusal (`no_answer` / `clarify`) is a FALSE REFUSAL — the
     * single number that makes "Ask AI refuses too much" measurable instead of
     * anecdotal. When false, the case belongs to the genuine-refusal class and a
     * refusal is the correct outcome; answering it would be a hallucination.
     *
     * Omitted, it is inferred from the other expectations, so existing case files
     * contribute to the metric without being rewritten.
     */
    answerable?: boolean;
  };
}

interface AgentEvalResult {
  name: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  /**
   * True when verified narration failed its fact check and the deterministic
   * record was shown instead. A silent rise here is exactly the truncation
   * defect that shipped unnoticed, so it is measured.
   */
  narrationFallback?: boolean;
  /**
   * Was verified-fact narration ATTEMPTED at all? Undefined on cases that never
   * reach the narrator (refusals, conversational replies). Without this the
   * grounded-narration denominator counted every case, diluting real failures
   * with runs that were never at risk — a metric that masks the defect it was
   * added to catch.
   */
  narrationAttempted?: boolean;
  executionMs?: number;
  executionMatched?: boolean;
  kind: AgentAnswer['kind'];
  route?: string;
  intent?: string;
  reviewStatus?: string;
  /** Undefined when the runtime did not persist a retrieval count. */
  contextObjects?: number;
  followUp: boolean;
  draftSaved: boolean;
  expected?: AgentEvalCase['expected'];
  validationCode?: string;
  trace: AgentEvalTraceStage[];
  toolCalls: number;
  /**
   * Physical provider round trips. Tool calls are cheap; dispatches are the
   * cost a person waits for, and the budget the recorded big-repo failures
   * actually exhausted. Undefined on drivers that do not persist telemetry.
   */
  providerDispatchCount?: number;
  judgeScore?: number;
  judgePass?: boolean;
  /**
   * Selectable options offered with a clarification. A clarification that offers
   * real choices is answerable in one more turn; one that offers none is the
   * dead end this suite exists to catch.
   */
  clarificationOptionCount?: number;
  /** True when the run replied conversationally instead of asserting data. */
  conversational?: boolean;
  /** True when that conversational reply actually carried content. */
  conversationalAnswer?: boolean;
  /** True when the meaning resolver ran (a provider was reachable). */
  meaningResolved?: boolean;
  /** Compact trace receipt evidence from a runtime-driven Ask run. */
  observability?: RuntimeDrivenRun['observability'];
  /** Why the rows did not match the correct answer, when they did not. */
  goldMatchReason?: string;
  /**
   * The runtime never produced a run for this case (timeout, transport or
   * server error). Recorded so one slow question cannot end the suite, and
   * kept apart from refusals: nothing was refused.
   */
  runtimeError?: string;
  /**
   * What a benchmark report needs from each answer: the trust label shown to
   * the user, which path answered (certified block, semantic layer, AI SQL),
   * the proofs that path recorded, the SQL, and how many rows came back.
   */
  answer?: {
    trustState?: string;
    tier?: string;
    proofs?: string[];
    sql?: string;
    rowCount?: number;
    /** AI calls that left the machine, and the result rows they carried (Ask's target is 0). */
    egress?: { receipts: number; resultRows: number };
  };
}

type AgentEvalTraceStageName =
  | 'context'
  | 'rewrite'
  | 'lane'
  | 'tools'
  | 'answer'
  | 'validation'
  | 'execution'
  | 'draft'
  | 'observability'
  | 'scoring';

interface AgentEvalTraceStage {
  stage: AgentEvalTraceStageName;
  status: 'passed' | 'failed' | 'not_run' | 'info';
  message: string;
  payload?: unknown;
}

async function runEval(rest: string[], flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const evalPath = rest[0] ? join(projectRoot, rest[0]) : join(projectRoot, 'agent-evals.yml');
  if (!existsSync(evalPath)) throw new Error(`Eval file not found: ${evalPath}`);

  const raw = loadYaml(readFileSync(evalPath, 'utf-8')) as AgentEvalFile | AgentEvalCase[] | null;
  const cases = Array.isArray(raw) ? raw : raw?.cases ?? [];
  if (cases.length === 0) throw new Error('No eval cases found.');

  const kgPath = defaultKgPath(projectRoot);
  if (!existsSync(kgPath)) await reindexProject(projectRoot, { kgPath });

  const providerName = (flags as { provider?: string }).provider as ProviderName | undefined;
  const rawProvider = await pickProvider(providerName);
  // Cassettes make a provider-backed suite repeatable and free to re-run. They
  // apply to the in-process driver here; `--via runtime` needs the SERVER
  // started with ZLENS_EVAL_CASSETTE_DIR, since it owns its own provider.
  const cassetteMode = (flags as { cassette?: string }).cassette;
  const provider = cassetteMode === 'record' || cassetteMode === 'replay'
    ? withCassette(
      rawProvider,
      new CassetteStore(cassetteDirFor(projectRoot, rest[0] ?? 'agent-evals')),
      cassetteMode,
      evalCassetteCanonicalizationV2(projectRoot),
    )
    : rawProvider;
  const reasoningEffort = cliReasoningEffort(flags);
  const requestedDepth = cliAnalysisDepth(flags);
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);
  const execute = Boolean((flags as { execute?: boolean }).execute);
  // R3.2: optional LLM-as-judge. Uses the same provider's completion; skipped
  // gracefully when no provider is available so offline eval stays deterministic.
  const judge = Boolean(flags.judge);
  const judgeComplete: JudgeCompletion = async ({ system, user }) =>
    provider.generate([{ role: 'system', content: system }, { role: 'user', content: user }], {});
  // Which half of the stack is under test. `loop` preserves today's behaviour;
  // `runtime` is the one that exercises routing and gates end to end.
  // The in-process answer-loop driver is gone with the V1 runtime; every case
  // runs through a live server so it exercises routing, the lane, and the gates.
  // `parseArgs` rejects any other --via value.
  const via = 'runtime' as const;
  const runtimeBase = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
    ?? (flags as { runtime?: string }).runtime
    ?? readEnv('ZLENS_RUNTIME_URL')
    ?? 'http://127.0.0.1:3474';
  let runtimeCassetteMode: string | undefined;
  if (via === 'runtime') {
    // Fail fast and loudly. Without this, an unreachable server turns every case
    // into a transport error and the report reads as a false-refusal spike that
    // no code change caused.
    const probe = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/health`).catch(() => null);
    if (!probe?.ok) {
      throw new Error(
        `--via runtime needs a running ZLens workbench at ${runtimeBase}. Start one with \`zlens notebook ${projectRoot}\` (\`npm run notebook\`), or point --runtime-url / ZLENS_RUNTIME_URL at a running one.`,
      );
    }
    const health = await probe.json().catch(() => ({})) as { evalCassetteMode?: string };
    runtimeCassetteMode = health.evalCassetteMode;
    const mismatch = runtimeCassetteModeMismatch({
      requested: cassetteMode,
      reported: runtimeCassetteMode,
      runtimeBase,
      cassetteDir: relative(projectRoot, cassetteDirFor(projectRoot, rest[0] ?? 'agent-evals')),
    });
    if (mismatch) throw new Error(mismatch);
  }
  const semanticLayer = loadAgentSemanticLayer(projectRoot);
  const expandGroundingContext = createGroundingContextExpander(projectRoot);
  const answerLoopTools = buildAnswerLoopTools(projectRoot);
  const schemaContext = execute
    ? await fetchRuntimeSchemaContext(runtimeBase)
    : [];
  recordCliRuntimeSchemaSnapshot(projectRoot, schemaContext, 'CLI eval runtime schema');
  const manifest = execute
    ? buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined })
    : null;
  const results: AgentEvalResult[] = [];
  const caseTimeoutMs = (flags as { caseTimeoutMs?: number }).caseTimeoutMs;

  try {
    for (const testCase of cases) {
      const startedAt = Date.now();
      const memoryContext = memory.search({
        query: testCase.question,
        scopes: ['project', 'user', 'artifact'],
        limit: 6,
      });
      const questionPlan = buildAnalysisQuestionPlan(testCase.question, testCase.followUp);
      const contextBudget = contextRetrievalBudgetForQuestion({
        questionPlan,
        requestedDepth,
        reasoningEffort,
      });
      const contextPack = await buildLocalContextPack(projectRoot, {
        question: testCase.question,
        surface: 'cli-eval',
        followUp: testCase.followUp,
        selectedContext: testCase.selectedContext,
        strictness: contextBudget.strictness,
        limit: contextBudget.limit,
        runtimeSchemaSnapshot: schemaContext.length > 0
          ? {
              source: 'CLI eval runtime schema',
              tables: schemaContext,
            }
          : undefined,
      }).catch(() => undefined);
      // `--via runtime` posts to a running `zlens notebook` so the case exercises the
      // router, engine, plan boundary, and gates. The in-process driver below
      // calls the answer loop directly and cannot observe any of them, which is
      // why a refusal metric taken from it reads cleaner than users experience.
      let runtimeRun: AgentRun | undefined;
      try {
        runtimeRun = via === 'runtime'
          ? await driveViaRuntime({
              runtimeBase,
              question: testCase.question,
              ...(testCase.domain ? { workspaceContext: { domain: testCase.domain } } : {}),
              ...(caseTimeoutMs ? { timeoutMs: caseTimeoutMs } : {}),
            })
          : undefined;
      } catch (error) {
        results.push(runtimeErrorResult(testCase, error, Date.now() - startedAt, caseTimeoutMs ?? 120_000));
        continue;
      }
      // Runtime mode is scored from the persisted AgentRun. The transport
      // adapter intentionally has no AgentAnswer.contextPack, so borrowing the
      // local preflight pack here would fabricate retrieval/route evidence for a
      // different execution path.
      const runtimeProjection = runtimeRun ? projectRuntimeRun(runtimeRun) : undefined;
      if (!runtimeRun) throw new Error('The runtime returned no run for this case.');
      const result = answerFromRuntimeRun(runtimeRun);
      const evaluation = evaluateCase(testCase, result, runtimeProjection);
      const durationMs = Date.now() - startedAt;
      const draftSaved = Boolean(result.draftBlock?.path ?? result.draftBlockId);
      const narration = narrationOutcomeForEval(runtimeRun?.narrationIntegrityReceipt);
      const judgeVerdict = judge
        ? await judgeAnswer({
            question: testCase.question,
            sql: result.proposedSql ?? result.sql,
            answerText: result.text,
            trustLabel: result.trustLabelInfo?.display ?? result.certification,
            resultSample: result.result?.rows,
          }, judgeComplete)
        : undefined;
      results.push({
        name: testCase.name ?? testCase.question,
        passed: evaluation.failures.length === 0,
        failures: evaluation.failures,
        durationMs,
        // The persisted receipt is the only evidence for this metric. Rows and
        // reader prose are intentionally ignored: a row-bearing answer can be
        // skipped, while a deterministic fallback can render different wording.
        narrationAttempted: narration.narrationAttempted,
        narrationFallback: narration.narrationFallback,
        executionMs: result.result?.executionTime,
        executionMatched: evaluation.executionMatched,
        ...(judgeVerdict ? { judgeScore: judgeVerdict.score, judgePass: judgeVerdict.pass } : {}),
        kind: result.kind,
        route: runtimeProjection?.route ?? result.contextPack?.routeDecision.route,
        // Only the runtime driver can see the router's clarification options.
        // In-process runs leave this undefined, so a clarify there scores as a
        // dead end — the conservative reading, and another reason `--via runtime`
        // is the truthful one.
        ...(runtimeRun ? {
          clarificationOptionCount: runtimeRun.clarificationOptions?.length ?? 0,
          conversational: runtimeRun.route === 'conversation' || runtimeRun.answerKind === 'conversational',
          conversationalAnswer: (runtimeRun.route === 'conversation' || runtimeRun.answerKind === 'conversational')
            && Boolean(runtimeRun.answer?.trim()),
          meaningResolved: Boolean(runtimeRun.routeDecision?.meaningResolution),
        } : {}),
        ...(runtimeProjection?.observability ? { observability: runtimeProjection.observability } : {}),
        intent: runtimeRun?.routeDecision?.category ?? result.contextPack?.routeDecision.intent,
        reviewStatus: result.reviewStatus,
        contextObjects: runtimeProjection?.retrievalCandidateCount ?? result.contextPack?.objects.length,
        followUp: Boolean(testCase.followUp),
        draftSaved,
        toolCalls: runtimeProjection?.toolCallCount ?? result.evidence?.toolCalls?.length ?? 0,
        ...(runtimeProjection ? { providerDispatchCount: runtimeProjection.providerDispatchCount } : {}),
        expected: testCase.expected,
        validationCode: evaluation.validationCode,
        ...(evaluation.goldMatchReason ? { goldMatchReason: evaluation.goldMatchReason } : {}),
        answer: answerEvidence(runtimeRun, result),
        trace: buildEvalTrace({
          testCase,
          result,
          evaluation,
          durationMs,
          draftSaved,
          runtime: runtimeProjection,
        }),
      });
    }
  } finally {
    kg.close();
    memory.close();
  }

  const passed = results.filter((r) => r.passed).length;
  const metrics = computeEvalMetrics(results);
  // Runtime evals execute in a separate host, so its cassette directory is
  // supplied explicitly by the eval workflow for reporting. The summary does
  // not inspect prompts or provider credentials; it only classifies the
  // checked-in response provenance.
  const cassetteDirectory = via === 'runtime'
    ? readEnv('ZLENS_EVAL_CASSETTE_DIR')
    : cassetteMode === 'record' || cassetteMode === 'replay'
      ? cassetteDirFor(projectRoot, rest[0] ?? 'agent-evals')
      : undefined;
  // The runtime reads its mode from the same environment (replay unless
  // ZLENS_EVAL_CASSETTE_MODE says record or live).
  const reportedCassetteMode = runtimeCassetteMode === 'record' || runtimeCassetteMode === 'replay' || runtimeCassetteMode === 'live'
    ? runtimeCassetteMode
    : undefined;
  const cassetteRunMode: CassetteMode = via === 'runtime'
    ? reportedCassetteMode ?? resolveCassetteModeFromEnv(process.env)
    : cassetteMode === 'record' ? 'record' : 'replay';
  const cassetteEvidence = cassetteDirectory
    ? { ...cassetteEvidenceSummary(new CassetteStore(cassetteDirectory)), mode: cassetteRunMode }
    : undefined;
  const thresholds = {
    minToolRequirement: (flags as { minToolRequirement?: number }).minToolRequirement ?? null,
    minExecutionMatch: (flags as { minExecutionMatch?: number }).minExecutionMatch ?? null,
    minJudgePass: (flags as { minJudgePass?: number }).minJudgePass ?? null,
    maxWrongCertified: (flags as { maxWrongCertified?: number }).maxWrongCertified ?? null,
    maxFalseRefusal: (flags as { maxFalseRefusal?: number }).maxFalseRefusal ?? null,
    minRefusalRecall: (flags as { minRefusalRecall?: number }).minRefusalRecall ?? null,
    maxProviderDispatches: (flags as { maxProviderDispatches?: number }).maxProviderDispatches ?? null,
    maxLatencyP95Ms: (flags as { maxLatencyP95Ms?: number }).maxLatencyP95Ms ?? null,
    minGroundedNarration: (flags as { minGroundedNarration?: number }).minGroundedNarration ?? null,
  };
  const thresholdsPassed = agentEvalThresholdsPass(metrics, thresholds);
  const ok = passed === results.length && thresholdsPassed;
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({
      ok,
      passed,
      total: results.length,
      thresholds,
      metrics,
      ...(cassetteEvidence ? { cassetteEvidence } : {}),
      results,
    }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✕'} ${result.name}`);
    for (const failure of result.failures) console.log(`  - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} eval case(s) passed.`);
  console.log(`Certified hit rate: ${formatRate(metrics.certified_hit_rate)}`);
  console.log(`Generated follow-up pass rate: ${formatRate(metrics.generated_followup_pass_rate)}`);
  console.log(`Safe refusal rate: ${formatRate(metrics.safe_refusal_rate)}`);
  if (cassetteEvidence) {
    console.log(
      `Cassette replay entries: ${cassetteEvidence.totalEntries} `
      + `(${cassetteEvidence.migratedLegacyDeterministicFixtureEntries} migrated legacy deterministic fixture, `
      + `${cassetteEvidence.syntheticDeterministicOrchestrationFixtureEntries} synthetic deterministic orchestration fixture).`,
    );
    console.log(cassetteEvidenceLine(cassetteEvidence, cassetteEvidence.mode));
  }
  console.log(`False refusal rate: ${formatRate(metrics.false_refusal_rate)} (${metrics.false_refusal_count}/${metrics.answerable_case_count} answerable cases refused)`);
  console.log(`Clarification rate: ${formatRate(metrics.clarification_rate)} (answerable cases asked instead of answered)`);
  if (metrics.meaning_resolved_rate !== null && metrics.meaning_resolved_rate < 1) {
    console.log(
      `  ! Semantic judgment ran for only ${formatRate(metrics.meaning_resolved_rate)} of cases. `
      + 'Without a reachable provider ZLens will not settle a reading by lexical rank (AGT-017), so ambiguous '
      + 'questions clarify by design — treat the clarification rate above as an artifact, not a product signal.',
    );
  }
  console.log(`Refusal recall: ${formatRate(metrics.refusal_recall)} (${metrics.refusal_required_case_count} case(s) that must refuse)`);
  console.log(`Execution match rate: ${formatRate(metrics.execution_match_rate)}`);
  if (metrics.runtime_error_count > 0) console.log(`Runtime errors: ${metrics.runtime_error_count} case(s) got no answer`);
  console.log(`Tool requirement pass rate: ${formatRate(metrics.tool_requirement_pass_rate)}`);
  console.log(`Tool-observed case count: ${metrics.tool_observed_case_count}`);
  console.log(`Average tool calls: ${metrics.avg_tool_calls}`);
  console.log(`Provider dispatches: avg ${metrics.avg_provider_dispatches}, worst ${metrics.max_provider_dispatches}`);
  console.log(`Wrong certified count: ${metrics.wrong_certified_count}`);
  console.log(`Draft saved count: ${metrics.draft_saved_count}`);
  if (thresholds.minToolRequirement !== null) {
    console.log(`Tool requirement threshold: ${thresholds.minToolRequirement} (actual ${formatRate(metrics.tool_requirement_pass_rate)})`);
  }
  if (thresholds.minExecutionMatch !== null) {
    console.log(`Execution-match threshold: ${thresholds.minExecutionMatch} (actual ${formatRate(metrics.execution_match_rate)})`);
  }
  if (thresholds.minJudgePass !== null) {
    console.log(`Judge-pass threshold: ${thresholds.minJudgePass} (actual ${formatRate(metrics.judge_pass_rate)})`);
  }
  if (thresholds.maxFalseRefusal !== null) {
    console.log(`False-refusal ceiling: ${thresholds.maxFalseRefusal} (actual ${formatRate(metrics.false_refusal_rate)})`);
  }
  if (thresholds.minRefusalRecall !== null) {
    console.log(`Refusal-recall threshold: ${thresholds.minRefusalRecall} (actual ${formatRate(metrics.refusal_recall)})`);
  }
  if (thresholds.minGroundedNarration !== null && thresholds.minGroundedNarration !== undefined) {
    console.log(`Grounded-narration threshold: ${thresholds.minGroundedNarration} (actual ${formatRate(metrics.grounded_narration_rate)} over ${metrics.grounded_narration_attempted} attempted)`);
  }
  if (thresholds.maxWrongCertified !== null) {
    console.log(`Wrong-certified ceiling: ${thresholds.maxWrongCertified} (actual ${metrics.wrong_certified_count})`);
  }
  if (!ok) process.exitCode = 1;
}

function previewGeneratedDraftPath(projectRoot: string, domain: string, slug: string): string {
  const safeDomain = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  if (safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))) {
    return `domains/${safeDomain}/blocks/_drafts/${slug}.dql`;
  }
  return `blocks/_drafts/${slug}.dql`;
}

function evaluateCase(
  testCase: AgentEvalCase,
  result: AgentAnswer,
  runtime?: RuntimeDrivenRun,
): {
  failures: string[];
  validationCode?: string;
  executionMatched?: boolean;
  goldMatchReason?: string;
} {
  const expected = testCase.expected;
  if (!expected) return { failures: [] };
  const failures: string[] = [];
  let validationCode: string | undefined;
  let executionMatched: boolean | undefined;
  // Answerability is asserted per case as well as aggregated into
  // false_refusal_rate, so a single dead-end fails its own case instead of only
  // nudging a rate someone has to notice.
  const answerable = evalCaseIsAnswerable(expected);
  // Three distinct outcomes, not two. An option-bearing clarification neither
  // answers nor dead-ends: it must not fail an answerable case (its cost is
  // tracked by `clarification_rate`), and it must not fail a must-refuse case
  // either, because it did not assert anything about the data.
  const clarifiedWithOptions = (result.clarificationOptions?.length ?? 0) > 0;
  // A conversational reply ("I'm here to help you explore your data…") asserts
  // nothing about the warehouse. For an out-of-scope question that is the CORRECT
  // outcome — declining politely — so it must not be scored as an answer.
  const conversational = (result as { answerKind?: string }).answerKind === 'conversational';
  const answerText = typeof result.text === 'string' ? result.text.trim() : '';
  // Conversational replies split two ways, and the case's own expectation says
  // which is right: for an answerable question a substantive reply IS the answer
  // (a definition), and for an out-of-scope one it is the correct decline.
  const conversationalAnswer = conversational && answerText.length > 0;
  const producedDataAnswer = result.kind !== 'no_answer' && !conversational;
  const deadEnded = !producedDataAnswer && !clarifiedWithOptions && !conversationalAnswer;
  if (answerable === true && deadEnded) {
    failures.push(`FALSE REFUSAL: this question is answerable, but the run dead-ended with no answer and no options${
      result.refusalCode ? ` (${result.refusalCode})` : ''}`);
  }
  if (answerable === false && producedDataAnswer) {
    failures.push(`expected a refusal (question is out of scope / unanswerable), but the run answered with kind ${result.kind}`);
  }
  if (expected.kind && result.kind !== expected.kind) failures.push(`kind expected ${expected.kind}, got ${result.kind}`);
  if (expected.sourceTier && result.sourceTier !== expected.sourceTier) failures.push(`sourceTier expected ${expected.sourceTier}, got ${result.sourceTier}`);
  if (expected.certification && result.certification !== expected.certification) failures.push(`certification expected ${expected.certification}, got ${result.certification}`);
  if (expected.reviewStatus && result.reviewStatus !== expected.reviewStatus) failures.push(`reviewStatus expected ${expected.reviewStatus}, got ${result.reviewStatus}`);
  const observedRoute = runtime?.route ?? result.contextPack?.routeDecision.route;
  if (expected.route && observedRoute !== expected.route) failures.push(`route expected ${expected.route}, got ${observedRoute ?? 'none'}`);
  if (expected.intent && result.contextPack?.routeDecision.intent !== expected.intent) failures.push(`intent expected ${expected.intent}, got ${result.contextPack?.routeDecision.intent ?? 'none'}`);
  // `modeling_gap` is a broad terminal kind. A relationship expectation is
  // satisfied only by the router's persisted relationship-specific witness;
  // otherwise a missing metric/dimension tuple would be misreported as a
  // relationship repair opportunity.
  const runtimeReportsMissingContext = expected.missingContextKind === 'relationship'
    ? runtime?.terminalOutcome?.gap?.code === 'MISSING_RELATIONSHIP'
    : runtime?.terminalOutcome?.kind === 'modeling_gap'
      && expected.missingContextKind === 'modeling_gap';
  if (expected.missingContextKind
    && !runtimeReportsMissingContext
    && !result.contextPack?.missingContext.some((item) => item.kind === expected.missingContextKind)) {
    failures.push(`missing context kind ${expected.missingContextKind} was not reported`);
  }
  if (expected.terminalOutcomeKind && runtime?.terminalOutcome?.kind !== expected.terminalOutcomeKind) {
    failures.push(`terminal outcome expected ${expected.terminalOutcomeKind}, got ${runtime?.terminalOutcome?.kind ?? 'none'}`);
  }
  if (expected.traceRecordingStatus && runtime?.observability?.recordingStatus !== expected.traceRecordingStatus) {
    failures.push(`trace recording status expected ${expected.traceRecordingStatus}, got ${runtime?.observability?.recordingStatus ?? 'unavailable'}`);
  }
  for (const token of stringList(expected.sqlContains)) {
    if (!result.proposedSql?.toLowerCase().includes(token.toLowerCase())) failures.push(`SQL did not contain "${token}"`);
  }
  for (const token of stringList(expected.sqlNotContains)) {
    if (result.proposedSql?.toLowerCase().includes(token.toLowerCase())) failures.push(`SQL contained forbidden token "${token}"`);
  }
  if (expected.citationKind && !result.citations.some((c) => c.kind === expected.citationKind)) failures.push(`missing citation kind ${expected.citationKind}`);
  for (const column of expected.noHallucinatedColumns ?? []) {
    if (result.proposedSql?.toLowerCase().includes(column.toLowerCase())) failures.push(`hallucinated forbidden column "${column}"`);
  }
  if (expected.draftSaved !== undefined) {
    const saved = Boolean(result.draftBlock?.path ?? result.draftBlockId);
    if (saved !== expected.draftSaved) failures.push(`draftSaved expected ${expected.draftSaved}, got ${saved}`);
  }
  if (typeof expected.minToolCalls === 'number') {
    const actualToolCalls = runtime?.toolCallCount ?? result.evidence?.toolCalls?.length ?? 0;
    if (actualToolCalls < expected.minToolCalls) {
      failures.push(`toolCalls expected at least ${expected.minToolCalls}, got ${actualToolCalls}`);
    }
  }
  if ((expected.allowedRelationsOnly || expected.allowedColumnsOnly) && result.proposedSql) {
    const validation = validateSqlAgainstLocalContext(result.proposedSql, result.contextPack, {
      question: testCase.question,
      intent: result.contextPack?.routeDecision.intent,
      filterValues: testCase.followUp?.filters,
    });
    if (!validation.ok) {
      validationCode = validation.code;
      failures.push(`SQL context validation failed (${validation.code}): ${validation.error}`);
    }
  }
  if (expected.rows) {
    const actualRows = result.result?.rows ?? [];
    executionMatched = rowsEqual(actualRows, expected.rows);
    if (!executionMatched) failures.push('executed rows did not match expected rows');
  }
  let goldMatchReason: string | undefined;
  if (expected.goldRows) {
    const actualRows = result.result?.rows ?? [];
    const match = producedDataAnswer
      ? goldRowsMatch(actualRows, expected.goldRows, {
          ordered: expected.goldOrdered,
          allowExtraColumns: expected.goldAllowExtraColumns,
        })
      : { match: false, reason: 'no data answer was returned' };
    executionMatched = match.match;
    if (!match.match) {
      goldMatchReason = match.reason;
      failures.push(`answer does not match the correct answer: ${match.reason}`);
    }
  }
  return { failures, validationCode, executionMatched, goldMatchReason };
}

/**
 * Is the case answerable? Explicit `expected.answerable` wins; otherwise infer
 * from the expectations already present, so the metric covers legacy case files.
 * A case with no expectations at all is excluded — it asserts nothing, so it can
 * neither prove nor disprove a false refusal.
 */
export function evalCaseIsAnswerable(expected: AgentEvalCase['expected']): boolean | undefined {
  if (!expected) return undefined;
  if (expected.answerable !== undefined) return expected.answerable;
  if (expected.kind === 'no_answer') return false;
  if (expected.sourceTier === 'no_answer') return false;
  if (expected.route === 'clarify' || expected.route === 'blocked') return false;
  if (Object.keys(expected).length === 0) return undefined;
  return true;
}

/**
 * Did the run leave the user with NO way forward?
 *
 * Deliberately narrower than "did not answer". A clarification that offers
 * selectable options is answerable on the next turn — worth minimising, tracked
 * separately as `clarification_rate`, but not the defect. A clarification with
 * ZERO options is a true dead end: the reported production loop was exactly
 * this, and a free-text reply to it reproduced the same question forever.
 */
/** A case whose runtime call failed: failed, never a match, never a refusal. */
function runtimeErrorResult(testCase: AgentEvalCase, error: unknown, durationMs: number, timeoutMs: number): AgentEvalResult {
  const aborted = error instanceof Error && error.name === 'AbortError';
  const message = aborted
    ? `no answer within ${Math.round(timeoutMs / 1000)}s`
    : error instanceof Error ? error.message : String(error);
  const scoresRows = Boolean(testCase.expected?.rows || testCase.expected?.goldRows);
  return {
    name: testCase.name ?? testCase.question,
    passed: false,
    failures: [`the runtime did not answer: ${message}`],
    durationMs,
    runtimeError: message,
    ...(scoresRows ? { executionMatched: false } : {}),
    kind: 'no_answer',
    followUp: Boolean(testCase.followUp),
    draftSaved: false,
    toolCalls: 0,
    expected: testCase.expected,
    trace: [{ stage: 'answer', status: 'failed', message: `The runtime did not answer: ${message}` }],
  };
}

export function evalResultRefused(
  result: Pick<AgentEvalResult, 'kind' | 'route' | 'clarificationOptionCount' | 'conversationalAnswer' | 'runtimeError'>,
): boolean {
  // No run came back, so nothing was refused; the case failed on its own count.
  if (result.runtimeError) return false;
  // A substantive conversational reply is an ANSWER, not a dead end. A governed
  // definition ("**top_customers** — Top 10 customers by lifetime spend…") is
  // exactly what a "what does X mean?" turn should return, and scoring it as a
  // refusal would report the feature working as the feature failing.
  if (result.conversationalAnswer) return false;
  // Order matters: the drivers collapse every clarification to `no_answer`
  // (it is not an answer), so the option check has to run FIRST or an
  // option-bearing clarification is miscounted as a dead end.
  if (result.route === 'clarify' && (result.clarificationOptionCount ?? 0) > 0) return false;
  return result.kind === 'no_answer' || result.route === 'clarify';
}

/** Did the run ask an answerable clarification rather than answering outright? */
export function evalResultClarified(
  result: Pick<AgentEvalResult, 'route' | 'clarificationOptionCount'>,
): boolean {
  return result.route === 'clarify' && (result.clarificationOptionCount ?? 0) > 0;
}

/**
 * Translate only the durable narration receipt into evaluation fields.
 *
 * Reader prose, row count, and result shape are deliberately absent: a skipped
 * narration can have rows, and a deterministic fallback can use any wording.
 */
export function narrationOutcomeForEval(
  receipt: NarrationIntegrityReceiptV1 | undefined,
): Pick<AgentEvalResult, 'narrationAttempted' | 'narrationFallback'> {
  if (receipt?.mode !== 'verified_facts' || !receipt.attempted) return {};
  return {
    // A durable receipt is the only source of this metric.  An infrastructure
    // error started a verified narration but did not produce a grounded answer,
    // so it belongs in the denominator just like the deterministic floor.  The
    // old mapping treated it as a success because only fallback was negative.
    narrationAttempted: true,
    narrationFallback: receipt.outcome !== 'success',
  };
}

function computeEvalMetrics(results: AgentEvalResult[]) {
  const answerableCases = results.filter((result) => evalCaseIsAnswerable(result.expected) === true);
  const refusalRequiredCases = results.filter((result) => evalCaseIsAnswerable(result.expected) === false);
  const certifiedCases = results.filter((result) =>
    result.expected?.kind === 'certified' ||
    result.expected?.certification === 'certified' ||
    result.expected?.route === 'certified',
  );
  const generatedFollowUpCases = results.filter((result) =>
    result.followUp &&
    (result.expected?.kind === 'uncertified' || result.expected?.route === 'generated_sql'),
  );
  const refusalCases = results.filter((result) =>
    result.expected?.kind === 'no_answer' || result.expected?.route === 'clarify',
  );
  const executionTimes = results
    .map((result) => result.executionMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const executionMatchCases = results.filter((result) => result.executionMatched !== undefined);
  const toolRequiredCases = results.filter((result) => typeof result.expected?.minToolCalls === 'number');
  const toolCallCounts = results.map((result) => result.toolCalls);
  const judged = results.filter((result) => typeof result.judgeScore === 'number');
  return {
    certified_hit_rate: ratio(certifiedCases.filter((result) => result.passed && result.kind === 'certified').length, certifiedCases.length),
    judge_mean_score: judged.length ? average(judged.map((result) => result.judgeScore ?? 0)) : null,
    judge_pass_rate: judged.length ? ratio(judged.filter((result) => result.judgePass).length, judged.length) : null,
    generated_followup_pass_rate: ratio(generatedFollowUpCases.filter((result) => result.passed).length, generatedFollowUpCases.length),
    safe_refusal_rate: ratio(refusalCases.filter((result) => result.passed && result.kind === 'no_answer').length, refusalCases.length),
    execution_match_rate: ratio(executionMatchCases.filter((result) => result.executionMatched).length, executionMatchCases.length),
    tool_requirement_pass_rate: ratio(
      toolRequiredCases.filter((result) => result.toolCalls >= (result.expected?.minToolCalls ?? 0)).length,
      toolRequiredCases.length,
    ),
    wrong_certified_count: results.filter((result) =>
      result.kind === 'certified' &&
      (result.expected?.kind ? result.expected.kind !== 'certified' : result.followUp),
    ).length,
    outside_context_rejection_count: results.filter((result) =>
      result.validationCode === 'unknown_relation' || result.validationCode === 'unknown_column',
    ).length,
    /**
     * THE headline number: how often an answerable question was refused.
     * Bounds every other quality metric — a run that refuses cannot be wrong,
     * so a falling false-refusal rate must be read together with
     * `execution_match_rate` to be sure refusals were replaced by CORRECT answers.
     */
    false_refusal_rate: ratio(answerableCases.filter(evalResultRefused).length, answerableCases.length),
    false_refusal_count: answerableCases.filter(evalResultRefused).length,
    /** Cases the runtime never answered (timeout, transport or server error). */
    runtime_error_count: results.filter((result) => result.runtimeError).length,
    answerable_case_count: answerableCases.length,
    /**
     * Answerable cases that asked an option-bearing clarification instead of
     * answering. Not a defect, but a direct cost in turns — read it next to
     * false_refusal_rate so a fall in refusals is not just a rise in questions.
     */
    clarification_rate: ratio(answerableCases.filter(evalResultClarified).length, answerableCases.length),
    /**
     * Cases where semantic judgment ran. Without a provider `mayAssumeInterpretation`
     * is false (AGT-017), so every ambiguous question clarifies by design and
     * `clarification_rate` says nothing about product quality.
     */
    meaning_resolved_rate: ratio(results.filter((result) => result.meaningResolved === true).length, results.length),
    /**
     * Latency, which the acceptance matrix asked for and nothing measured. A
     * quality gain paid for entirely in wall clock is not a gain: the plan's
     * two-tier target is certified/semantic under 5s while research takes
     * minutes, and only a per-class p95 can tell those apart from a regression.
     */
    latency_p50_ms: percentileMs(results, 0.5),
    latency_p95_ms: percentileMs(results, 0.95),
    latency_p95_answerable_ms: percentileMs(answerableCases, 0.95),
    /**
     * How often verified narration survived. When the drafted narration fails
     * its fact check the reader gets the deterministic record under a
     * disclaimer — correct, but visibly worse. A silent fall here is exactly
     * the truncation defect that shipped unnoticed, so it is measured.
     */
    grounded_narration_rate: ratio(
      results.filter((result) => result.narrationAttempted && result.narrationFallback === false).length,
      results.filter((result) => result.narrationAttempted).length,
    ),
    grounded_narration_attempted: results.filter((result) => result.narrationAttempted).length,
    /**
     * The guard on the above: cases that must NOT produce a data answer.
     * Scored on "did not answer" rather than "dead-ended", because declining via
     * a clarification is still declining — what would be wrong is asserting
     * something about data the project does not have.
     */
    refusal_recall: ratio(
      refusalRequiredCases.filter((result) => result.kind === 'no_answer' || result.conversational === true).length,
      refusalRequiredCases.length,
    ),
    refusal_required_case_count: refusalRequiredCases.length,
    draft_saved_count: results.filter((result) => result.draftSaved).length,
    tool_observed_case_count: results.filter((result) => result.toolCalls > 0).length,
    avg_tool_calls: average(toolCallCounts),
    /**
     * Physical provider round trips per question. The number that actually
     * bounds a turn on the slowest transports, and the one the recorded
     * big-repo failures exhausted.
     */
    avg_provider_dispatches: average(results.map((result) => result.providerDispatchCount ?? 0)),
    max_provider_dispatches: results.reduce((worst, result) => Math.max(worst, result.providerDispatchCount ?? 0), 0),
    // Runtime runs only report this when the persisted router recorded an
    // explicit retrieval count. Treat absent evidence as unknown, not as an
    // invented empty context pack.
    avg_context_objects: average(results
      .map((result) => result.contextObjects)
      .filter((count): count is number => typeof count === 'number')),
    avg_execution_ms: executionTimes.length ? average(executionTimes) : null,
  };
}

function agentEvalThresholdsPass(
  metrics: ReturnType<typeof computeEvalMetrics>,
  thresholds: {
    minToolRequirement: number | null;
    minExecutionMatch?: number | null;
    minJudgePass?: number | null;
    maxWrongCertified?: number | null;
    maxFalseRefusal?: number | null;
    minRefusalRecall?: number | null;
    minGroundedNarration?: number | null;
    /** Ceiling on physical provider round trips for the worst question. */
    maxProviderDispatches?: number | null;
    /** Ceiling on p95 wall clock for answerable questions, in milliseconds. */
    maxLatencyP95Ms?: number | null;
  },
): boolean {
  // A rate threshold with no applicable cases (metric === null) is vacuously
  // satisfied — you only fail when the metric exists and falls below the bar.
  const rateOk = (metric: number | null, min: number | null | undefined): boolean =>
    min === null || min === undefined || metric === null || metric >= min;
  // A ceiling is only meaningful when the metric has data; `null` means no
  // answerable case was scored, which is "unknown", not "perfect".
  const ceilingOk = (metric: number | null, max: number | null | undefined): boolean =>
    max === null || max === undefined || metric === null || metric <= max;
  // A cost ceiling is only meaningful when something was measured; zero
  // dispatches means no run reached a provider, which is not "fast".
  const costOk = (metric: number | null | undefined, max: number | null | undefined): boolean =>
    max === null || max === undefined || metric === null || metric === undefined || metric <= max;
  return costOk(metrics.max_provider_dispatches, thresholds.maxProviderDispatches)
    && costOk(metrics.latency_p95_answerable_ms, thresholds.maxLatencyP95Ms)
    && rateOk(metrics.grounded_narration_rate, thresholds.minGroundedNarration)
    && rateOk(metrics.tool_requirement_pass_rate, thresholds.minToolRequirement)
    && rateOk(metrics.execution_match_rate, thresholds.minExecutionMatch)
    && rateOk(metrics.judge_pass_rate, thresholds.minJudgePass)
    && ceilingOk(metrics.false_refusal_rate, thresholds.maxFalseRefusal)
    && rateOk(metrics.refusal_recall, thresholds.minRefusalRecall)
    && (thresholds.maxWrongCertified === null
      || thresholds.maxWrongCertified === undefined
      || metrics.wrong_certified_count <= thresholds.maxWrongCertified);
}

function buildEvalTrace(input: {
  testCase: AgentEvalCase;
  result: AgentAnswer;
  evaluation: ReturnType<typeof evaluateCase>;
  durationMs: number;
  draftSaved: boolean;
  /** Persisted runtime evidence; never projected into a synthetic context pack. */
  runtime?: RuntimeDrivenRun;
}): AgentEvalTraceStage[] {
  const { testCase, result, evaluation, durationMs, draftSaved, runtime } = input;
  const routeDecision = result.contextPack?.routeDecision;
  const selectedRelations = result.contextPack?.retrievalDiagnostics.selectedRelations ?? [];
  const allowedRelations = result.contextPack?.allowedSqlContext?.relations ?? [];
  const followUp = testCase.followUp;
  const toolCalls = result.evidence?.toolCalls ?? [];
  const observedToolCallCount = runtime?.toolCallCount ?? toolCalls.length;
  const routeEvidence = result.evidence?.route ?? [];
  const executionStatus = result.executionError
    ? 'failed'
    : result.result
      ? 'passed'
      : 'not_run';
  const validationExpected = Boolean(testCase.expected?.allowedRelationsOnly || testCase.expected?.allowedColumnsOnly);
  const validationStatus = evaluation.validationCode
    ? 'failed'
    : validationExpected
      ? 'passed'
      : 'not_run';
  const rowsExpected = testCase.expected?.rows !== undefined;
  const expectedMinToolCalls = testCase.expected?.minToolCalls;
  const toolStatus = typeof expectedMinToolCalls === 'number'
    ? observedToolCallCount >= expectedMinToolCalls ? 'passed' : 'failed'
    : observedToolCallCount > 0 ? 'passed' : routeEvidence.length > 0 ? 'info' : 'not_run';
  const toolMessage = typeof expectedMinToolCalls === 'number'
    ? observedToolCallCount >= expectedMinToolCalls
      ? `Observed ${observedToolCallCount} provider tool call(s), meeting the minimum of ${expectedMinToolCalls}.`
      : `Observed ${observedToolCallCount} provider tool call(s), below the minimum of ${expectedMinToolCalls}.`
    : observedToolCallCount > 0
      ? `Observed ${observedToolCallCount} provider tool call(s).`
      : routeEvidence.length > 0
        ? `Captured ${routeEvidence.length} deterministic route evidence step(s).`
        : 'No provider tool calls were observed for this answer.';

  return [
    {
      stage: 'context',
      status: runtime && (runtime.retrievalCandidateCount !== undefined || runtime.sourceCoverage?.length || runtime.terminalOutcome)
        ? 'passed'
        : result.contextPack ? 'passed' : 'not_run',
      message: runtime && (runtime.retrievalCandidateCount !== undefined || runtime.sourceCoverage?.length || runtime.terminalOutcome)
        ? `Persisted route evidence recorded ${runtime.retrievalCandidateCount ?? 'an unspecified number of'} retrieved candidate(s).`
        : result.contextPack
        ? `Context pack ${result.contextPack.id} selected ${result.contextPack.objects.length} object(s).`
        : 'No context pack was attached to the answer.',
      payload: runtime && (runtime.retrievalCandidateCount !== undefined || runtime.sourceCoverage?.length || runtime.terminalOutcome)
        ? {
            evidenceSource: 'persisted_agent_run',
            retrievalCandidateCount: runtime.retrievalCandidateCount,
            sourceCoverage: runtime.sourceCoverage,
            terminalOutcome: runtime.terminalOutcome,
          }
        : result.contextPack
        ? {
            contextPackId: result.contextPack.id,
            selectedObjectCount: result.contextPack.objects.length,
            allowedRelationCount: allowedRelations.length,
            selectedRelations: selectedRelations.slice(0, 12).map((relation) => relation.relation),
            missingContext: result.contextPack.missingContext,
          }
        : undefined,
    },
    {
      stage: 'rewrite',
      status: followUp ? 'passed' : 'not_run',
      message: followUp
        ? `Follow-up context attached (${followUp.kind}).`
        : 'No follow-up rewrite/context was supplied for this case.',
      payload: summarizeFollowUpForTrace(followUp),
    },
    {
      stage: 'lane',
      status: runtime ? 'passed' : routeDecision ? 'passed' : 'not_run',
      message: runtime
        ? `Persisted engine route ${runtime.runRoute}${runtime.route ? ` evaluated as ${runtime.route}` : ''}.`
        : routeDecision
        ? `Lane ${routeDecision.route} / ${routeDecision.intent}.`
        : 'No lane decision was attached to the answer.',
      payload: runtime
        ? {
            engineRoute: runtime.runRoute,
            evalRoute: runtime.route,
            status: runtime.status,
            trustState: runtime.trustState,
            terminalOutcome: runtime.terminalOutcome,
          }
        : routeDecision
        ? {
            route: routeDecision.route,
            intent: routeDecision.intent,
            reason: routeDecision.reason,
            trustLabel: routeDecision.trustLabel,
            reviewStatus: routeDecision.reviewStatus,
            exactObjectKey: routeDecision.exactObjectKey,
          }
        : undefined,
    },
    {
      stage: 'tools',
      status: toolStatus,
      message: toolMessage,
      payload: {
        observedToolCalls: observedToolCallCount,
        expectedMinToolCalls,
        ...(runtime ? { evidenceSource: 'persisted_agent_run.telemetry' } : {}),
        providerToolCalls: runtime ? [] : toolCalls.slice(0, 12).map((call) => ({
          order: call.order,
          name: call.name,
          status: call.status,
          inputSummary: call.inputSummary,
          outputSummary: call.outputSummary,
        })),
        routeEvidence: routeEvidence.slice(0, 12).map((step) => ({
          tool: step.tool,
          status: step.status,
          label: step.label,
          detail: step.detail,
        })),
      },
    },
    {
      stage: 'answer',
      status: result.kind === 'no_answer' ? 'failed' : 'passed',
      message: `Answer kind ${result.kind}${result.sourceTier ? ` from ${result.sourceTier}` : ''}.`,
      payload: {
        kind: result.kind,
        sourceTier: result.sourceTier,
        certification: result.certification,
        reviewStatus: result.reviewStatus,
        route: result.route?.tier,
        refusalCode: result.refusalCode,
        sourceCertifiedBlock: result.sourceCertifiedBlock,
        dqlArtifactKind: result.dqlArtifact?.kind,
        providerUsed: result.providerUsed,
      },
    },
    {
      stage: 'validation',
      status: validationStatus,
      message: evaluation.validationCode
        ? `SQL context validation failed with ${evaluation.validationCode}.`
        : validationExpected
          ? 'SQL context validation passed.'
          : 'SQL context validation was not required by this case.',
      payload: {
        validationCode: evaluation.validationCode,
        failures: evaluation.failures,
        expectedAllowedRelationsOnly: testCase.expected?.allowedRelationsOnly,
        expectedAllowedColumnsOnly: testCase.expected?.allowedColumnsOnly,
      },
    },
    {
      stage: 'execution',
      status: executionStatus,
      message: result.executionError
        ? result.executionError
        : result.result
          ? `Executed and returned ${result.result.rowCount} row(s).`
          : 'No SQL/block execution result was captured.',
      payload: {
        rowCount: result.result?.rowCount,
        executionTime: result.result?.executionTime,
        executionMatched: rowsExpected ? evaluation.executionMatched : undefined,
        expectedRows: rowsExpected ? testCase.expected?.rows?.length : undefined,
        columns: summarizeResultColumns(result.result?.columns),
      },
    },
    {
      stage: 'draft',
      status: draftSaved ? 'passed' : 'not_run',
      message: draftSaved
        ? `Draft captured at ${result.draftBlock?.path ?? result.draftBlockId}.`
        : 'No generated draft was captured.',
      payload: {
        draftBlockId: result.draftBlockId,
        draftPath: result.draftBlock?.path,
        promoteCommand: result.promoteCommand,
      },
    },
    {
      stage: 'observability',
      status: runtime?.observability?.recordingStatus === 'complete'
        ? 'passed'
        : runtime?.observability ? 'info' : 'not_run',
      message: runtime?.observability
        ? `Local Ask trace recording ${runtime.observability.recordingStatus}.`
        : 'No runtime trace receipt was attached to this evaluation run.',
      payload: runtime?.observability
        ? {
            recordingStatus: runtime.observability.recordingStatus,
            storeSchemaVersion: runtime.observability.storeSchemaVersion,
            ...(runtime.observability.traceFingerprint ? { traceFingerprint: runtime.observability.traceFingerprint } : {}),
          }
        : undefined,
    },
    {
      stage: 'scoring',
      status: evaluation.failures.length === 0 ? 'passed' : 'failed',
      message: evaluation.failures.length === 0
        ? `Case passed in ${durationMs}ms.`
        : `Case failed ${evaluation.failures.length} check(s) in ${durationMs}ms.`,
      payload: {
        durationMs,
        expected: testCase.expected,
      },
    },
  ];
}

function summarizeFollowUpForTrace(followUp: AgentFollowUpContext | undefined): unknown {
  if (!followUp) return undefined;
  const priorResultRef = followUp.priorResultRef
    ? {
        id: followUp.priorResultRef.id,
        question: followUp.priorResultRef.question,
        columns: followUp.priorResultRef.columns,
        rowCount: followUp.priorResultRef.rowCount,
        sourceSql: truncateTraceText(followUp.priorResultRef.sourceSql, 4000),
      }
    : undefined;
  const priorDqlArtifact = followUp.priorDqlArtifact
    ? {
        kind: followUp.priorDqlArtifact.kind,
        name: followUp.priorDqlArtifact.name,
        sourcePath: followUp.priorDqlArtifact.sourcePath,
        source: truncateTraceText(followUp.priorDqlArtifact.source, 4000),
        metrics: followUp.priorDqlArtifact.metrics,
        dimensions: followUp.priorDqlArtifact.dimensions,
        filters: followUp.priorDqlArtifact.filters,
        timeDimension: followUp.priorDqlArtifact.timeDimension,
        orderBy: followUp.priorDqlArtifact.orderBy,
        limit: followUp.priorDqlArtifact.limit,
      }
    : undefined;
  return {
    kind: followUp.kind,
    sourceTurnId: followUp.sourceTurnId,
    sourceBlockName: followUp.sourceBlockName,
    sourceQuestion: followUp.sourceQuestion,
    filters: followUp.filters,
    dimensions: followUp.dimensions,
    priorResultColumns: followUp.priorResultColumns,
    priorResultValues: followUp.priorResultValues,
    priorResultRef,
    priorDqlArtifact,
    priorLimit: followUp.priorLimit,
    priorMeasures: followUp.priorMeasures,
    resolvedReferences: followUp.resolvedReferences,
    unresolvedReferences: followUp.unresolvedReferences,
  };
}

function truncateTraceText(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function summarizeResultColumns(columns: unknown[] | undefined): string[] {
  return (columns ?? []).map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && 'name' in column) {
      const name = (column as { name?: unknown }).name;
      return typeof name === 'string' ? name : JSON.stringify(column);
    }
    return String(column);
  });
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
}

function stringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function rowsEqual(actual: unknown[], expected: unknown[]): boolean {
  return JSON.stringify(normalizeRows(actual)) === JSON.stringify(normalizeRows(expected));
}

function normalizeRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function createCertifiedBlockExecutor(
  projectRoot: string,
  manifest: ReturnType<typeof buildManifest>,
  runtimeBase: string,
) {
  return async (node: { name: string; nodeId: string }): Promise<AgentResultPayload> => {
    const block = manifest.blocks[node.name] ?? manifest.blocks[node.nodeId.replace(/^block:/, '')];
    if (!block) throw new Error(`Matched block ${node.name} is not present in the manifest.`);
    const source = readFileSync(join(projectRoot, block.filePath), 'utf-8');
    const payload = await executeRuntimeCell(runtimeBase, {
      id: `agent-eval-${node.name}`,
      type: 'dql',
      source,
      title: node.name,
    });
    const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
    return {
      columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
      rows,
      rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
      executionTime: payload.result?.executionTime,
      blockName: node.name,
    };
  };
}

function createGeneratedSqlExecutor(runtimeBase: string) {
  return async (sql: string): Promise<AgentResultPayload> => {
    const payload = await executeRuntimeCell(runtimeBase, {
      id: `agent-eval-generated-${Date.now().toString(36)}`,
      type: 'sql',
      source: sql,
      title: 'agent eval generated SQL',
    });
    const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
    return {
      columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
      rows,
      rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
      executionTime: payload.result?.executionTime,
      sql,
    };
  };
}

async function executeRuntimeCell(
  runtimeBase: string,
  cell: { id: string; type: 'dql' | 'sql'; source: string; title: string },
): Promise<{
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    executionTime?: number;
  };
  error?: string;
}> {
  const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/notebook/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell }),
  });
  if (!response.ok) {
    // Prefer the runtime's own sentence and code (e.g. CONNECTION_NOT_CONFIGURED) over raw JSON.
    const text = await response.text();
    let failure: { error?: unknown; code?: unknown } | undefined;
    try { failure = JSON.parse(text) as { error?: unknown; code?: unknown }; } catch { failure = undefined; }
    throw new Error(typeof failure?.error === 'string'
      ? `${failure.error}${typeof failure.code === 'string' ? ` (${failure.code})` : ''}`
      : `Runtime returned ${response.status}: ${text}`);
  }
  const payload = (await response.json()) as {
    result?: {
      columns?: unknown[];
      rows?: unknown[];
      rowCount?: number;
      executionTime?: number;
    };
    error?: string;
  };
  if (payload.error) throw new Error(payload.error);
  return payload;
}

/** The per-answer facts a benchmark report publishes. */
function answerEvidence(run: AgentRun, result: AgentAnswer): AgentEvalResult['answer'] {
  const receipt = (run as { diagnosticReceiptV9?: { executed?: { tier?: string; proofs?: string[] } } }).diagnosticReceiptV9;
  const sql = result.sql ?? result.proposedSql;
  return {
    trustState: run.trustState,
    ...(receipt?.executed?.tier ? { tier: receipt.executed.tier } : {}),
    ...(receipt?.executed?.proofs?.length ? { proofs: receipt.executed.proofs } : {}),
    ...(sql ? { sql } : {}),
    ...(result.result?.rows ? { rowCount: result.result.rows.length } : {}),
    ...(run.providerEgressReceipts ? {
      egress: {
        receipts: run.providerEgressReceipts.length,
        resultRows: run.providerEgressReceipts.reduce((sum, entry) => sum + (entry.resultRowCount ?? 0), 0),
      },
    } : {}),
  };
}

export const __test__ = {
  answerEvidence,
  agentEvalThresholdsPass,
  buildEvalTrace,
  cliAnalysisDepth,
  cliReasoningEffort,
  computeEvalMetrics,
  narrationOutcomeForEval,
  evaluateCase,
  runtimeErrorResult,
};

/** Percentile over observed case durations. Returns null when nothing timed. */
function percentileMs(results: ReadonlyArray<{ durationMs?: number }>, q: number): number | null {
  const observed = results
    .map((result) => result.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (observed.length === 0) return null;
  // Nearest-rank: with a handful of cases an interpolated percentile invents a
  // duration nothing actually took.
  const rank = Math.min(observed.length - 1, Math.max(0, Math.ceil(q * observed.length) - 1));
  return observed[rank] ?? null;
}
