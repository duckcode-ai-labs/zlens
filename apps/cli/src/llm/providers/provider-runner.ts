import { composeAnswer, markProviderMetadata, markProviderMetadataArray, type HostFloorRefusalReason } from '@zlens/agent';
import { parseAnalyticalTimeWindow, resolvePlanTimeRange, type AnalyticalTimeWindowV1 } from '@zlens/agent';
import {
  ClaudeProvider,
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  GeminiProvider,
  loadAgentSemanticLayer,
  OllamaProvider,
  OpenAIProvider,
  createAnalyticalFailure,
  buildAnalysisQuestionPlan,
  buildCertifiedBlockInvocationInput,
  certifiedBlockProvesRequestedTopN,
  compactSemanticRuntimeFailure,
  advertisedTools,
  probeSemanticJoinFanout,
  buildAnalyticalRequirementSet,
  buildLocalContextPack,
  contextRetrievalBudgetForQuestion,
  ensureAgentProjectReady,
  isLikelyClarificationReply,
  type AgentAnswer,
  type AgentDqlArtifactReference,
  type CertifiedFitConfirmation,
  type CertifiedFitConfirmationRequest,
  type AgentFollowUpContext,
  type AgentConversationBindingV1,
  type AgentMemberBinding,
  type AgentPriorResultReference,
  type AgentProvider,
  type ProviderToolLoopOptions,
  type AgentResultPayload,
  type ConversationSnapshot,
  type ConversationResultMemberSetV1,
  type LocalContextPack,
  type ProviderDispatchEvent,
  type ProviderDispatchCompletionEvent,
  type Skill,
  isTrustedConversationTurn,
  createProviderDispatchEgressReceipt,
  createProviderEgressReceipt,
  assertProviderPayloadAllowed,
  prepareProviderContextForDispatch,
  prepareProviderWireEnvelopeForDispatch,
  prepareServerOwnedProviderSchemaContext,
  projectEmbeddingProvider,
  answerAgentic,
  trimCertifiedBlockResultToRequestedTopN,
  runAgenticToolLoopDetailed,
  evidenceCandidateRoles,
  qualifyAuthorizationReferences,
  scopeContextPackToExploratoryCandidateClosure,
  createAnalystLaneHandler,
  parseProposal,
  renderContextValidationRefusalForUser,
  validateSqlAgainstLocalContext,
  resolveOrchestratorPolicy,
  type AgenticLane,
  type OrchestratorPolicy,
  type AskToolNameV2,
  type AskToolObservationV1,
  type AgentEvidenceCandidate,
  type AgentToolDefinition,
  type AnswerLoopInput,
  type AgentMessage,
  type KGNode,
} from '@zlens/agent';
import {
  CassetteStore,
  evalCassetteCanonicalizationV2,
  resolveCassetteModeFromEnv,
  withCassette,
} from '../../commands/agent-eval-cassette.js';
import {
  buildManifest,
  normalizeDqlArtifactReference,
  resolveDbtManifestPath,
  type ProviderDispatchPhaseV1,
  type ProviderEgressPurpose,
  type ProviderEgressReceiptV1,
} from '@zlens/core';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal, ProviderId } from '../types.js';
import { buildAnswerLoopTools, createGroundingContextExpander } from '../answer-loop-tools.js';
import { getSemanticRuntimeStatus } from '../../semantic-runtime.js';
import { blockProposalDqlMetadata } from '../proposal-metadata.js';
import { getEffectiveProviderConfig } from '../../settings/provider-settings.js';
import { ClaudeCodeCliProvider, CodexCliProvider } from '../../providers/subscription-cli.js';
import { ClaudeOAuthProvider, claudeOAuthConnected } from '../../providers/oauth/claude-oauth.js';
import { CodexOAuthProvider, codexOAuthConnected } from '../../providers/oauth/codex-oauth.js';
import { readEnv } from '@zlens/core';

/**
 * Providers the governed answer-loop runner can drive. Beyond the API-key/local
 * providers this includes the subscription CLI providers (`claude-code`, `codex`) —
 * used as plain completion backends here, distinct from the MCP `claudeCodeRunner`.
 */
type SimpleProviderId =
  | Extract<ProviderId, 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai'>
  | 'claude-code'
  | 'codex';


interface ProviderSpec {
  label: string;
  setup: string;
  create(projectRoot: string): AgentProvider;
}

const SPECS: Record<SimpleProviderId, ProviderSpec> = {
  anthropic: {
    label: 'Anthropic Claude',
    setup: 'Configure Anthropic in Settings or set ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'anthropic');
      return new ClaudeProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  openai: {
    label: 'OpenAI',
    setup: 'Configure OpenAI in Settings or set OPENAI_API_KEY. Optional: OPENAI_MODEL and OPENAI_BASE_URL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
    },
  },
  gemini: {
    label: 'Gemini',
    setup: 'Configure Gemini in Settings or set GEMINI_API_KEY. Optional: GEMINI_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'gemini');
      return new GeminiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  ollama: {
    label: 'Ollama',
    setup: 'Start Ollama and configure OLLAMA_BASE_URL / OLLAMA_MODEL in Settings or env.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'ollama');
      return new OllamaProvider({ model: config.model, baseUrl: config.baseUrl });
    },
  },
  'custom-openai': {
    label: 'Custom OpenAI-compatible',
    setup: 'Configure a custom OpenAI-compatible endpoint in Settings with base URL, model, and optional API key.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'custom-openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, allowNoApiKey: true });
    },
  },
  'claude-code': {
    label: 'Claude subscription',
    setup: 'Open Settings → Claude subscription and click "Sign in with Claude" (or install the `claude` CLI and run `claude /login`).',
    // OAuth-first: use the browser-login token when connected; fall back to the CLI-passthrough otherwise.
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'claude-code').model;
      return claudeOAuthConnected(projectRoot)
        ? new ClaudeOAuthProvider({ projectRoot, model })
        : new ClaudeCodeCliProvider({ model });
    },
  },
  codex: {
    label: 'ChatGPT subscription',
    setup: 'Open Settings → ChatGPT subscription and click "Sign in with ChatGPT" (or install the `codex` CLI and run `codex login`).',
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'codex').model;
      return codexOAuthConnected(projectRoot)
        ? new CodexOAuthProvider({ projectRoot, model })
        : new CodexCliProvider({ model });
    },
  },
};

/**
 * The eval cassette mode this runtime's providers run in, reported by
 * `/api/health` so `zlens agent eval --cassette <mode>` can check the
 * workbench it drives. `off` without ZLENS_EVAL_CASSETTE_DIR.
 */
export function evalCassetteRuntimeMode(env: Record<string, string | undefined> = process.env): 'off' | 'record' | 'replay' | 'live' {
  return readEnv('ZLENS_EVAL_CASSETTE_DIR', env) ? resolveCassetteModeFromEnv(env) : 'off';
}

export function applyEvalCassette(provider: AgentProvider, projectRoot: string): AgentProvider {
  const dir = readEnv('ZLENS_EVAL_CASSETTE_DIR');
  if (!dir) return provider;
  return withCassette(
    provider,
    new CassetteStore(dir),
    resolveCassetteModeFromEnv(process.env),
    evalCassetteCanonicalizationV2(projectRoot),
  );
}

/**
 * Create a replay-only provider when the runtime is launched for an offline
 * evaluation. This is intentionally unavailable outside explicit cassette
 * replay: recording and live modes still require a configured real provider.
 *
 * The cassette's recorded provider identity is part of its key. Recover it
 * from a single-provider cassette directory instead of borrowing a user's
 * active provider or guessing from an API setting. The base provider cannot
 * make a network call; replay misses remain CassetteMissError failures.
 */
export function createEvalCassetteReplayProvider(projectRoot: string): AgentProvider | undefined {
  const dir = readEnv('ZLENS_EVAL_CASSETTE_DIR');
  if (!dir || resolveCassetteModeFromEnv(process.env) !== 'replay') return undefined;

  const store = new CassetteStore(dir);
  const providerNames = store.providerNames();
  const providerName = providerNames.length === 1 ? asAgentProviderName(providerNames[0]!) : undefined;
  if (!providerName) return undefined;

  return withCassette({
    name: providerName,
    available: async () => true,
    generate: async () => {
      throw new Error('Eval cassette replay miss: no live provider is available.');
    },
  }, store, 'replay', evalCassetteCanonicalizationV2(projectRoot));
}

function asAgentProviderName(value: string): AgentProvider['name'] | undefined {
  return value === 'claude' || value === 'openai' || value === 'gemini' || value === 'ollama'
    ? value
    : undefined;
}

/**
 * A raw text provider for planning calls that are not the answer itself.
 *
 * Research hypothesis planning needs `generate`, not the full agent runner —
 * and the runner cannot be reused for it, because the runner IS the governed
 * answer path. Cassettes apply, so a recorded run stays hermetic.
 */
export function createGovernedTextProvider(
  id: SimpleProviderId,
  projectRoot: string,
): AgentProvider | undefined {
  const spec = SPECS[id];
  if (!spec) return undefined;
  try {
    return applyEvalCassette(spec.create(projectRoot), projectRoot);
  } catch {
    return undefined;
  }
}

/**
 * THE GOVERNED ANSWER RUNNER IS THE ASK PIPELINE.
 *
 * Every analytical answer — Ask, App Copilot, notebook SQL authoring,
 * Research hypotheses — runs through the host's Ask pipeline executor. The
 * registry still hands out a runner per provider so callers can resolve the
 * configured provider, but a direct `run` is no longer an answer surface.
 */
export function createDqlAgentProviderRunner(id: SimpleProviderId, providerOverride?: AgentProvider): AgentRunner {
  return {
    async run(req, emit) {
      const spec = SPECS[id];
      void providerOverride;
      const message = `Direct provider runs are not an Ask surface any more; governed answers run through the Ask pipeline (${spec?.label ?? id}).`;
      emit({ kind: 'error', message });
      const error = Object.assign(new Error(message), { code: 'ASK_PIPELINE_OWNS_GOVERNED_ANSWERS', projectRoot: req.projectRoot });
      throw error;
    },
  };
}

function shouldShowProviderSetupHint(message: string): boolean {
  return /api key|not configured|not reachable|connection refused|ECONNREFUSED|fetch failed|network error|model .*not found/i
    .test(message);
}

function lastUserMessage(req: AgentRunRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role === 'user' && msg.content.trim()) return msg.content.trim();
  }
  return '';
}

/** Did the assistant's previous turn ask the user a clarifying question? */
const CLARIFY_MARKER_RE =
  /one more detail|needs clarification|which (?:business object|metric|table|certified block)|what (?:grain|filter|time period)|baseline period|should define the answer|before (?:i can|it can) (?:safely )?(?:answer|generate)/i;

/**
 * When the prior assistant turn was a clarifying question and this turn is the user's
 * answer, the answer alone is too vague to route — re-classifying it just re-clarifies.
 * Fold the ORIGINAL question together with the clarification answer so the loop has
 * enough to proceed. Returns the current message unchanged when this isn't a clarify
 * follow-up.
 */
export function resolveEffectiveQuestion(req: AgentRunRequest): string {
  const msgs = req.messages;
  const current = lastUserMessage(req);
  if (!current) return current;
  // The current user turn is the last message; find the assistant turn before it.
  let assistantIdx = -1;
  for (let i = msgs.length - 2; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return current;
  if (!CLARIFY_MARKER_RE.test(msgs[assistantIdx].content)) return current;
  if (!isLikelyClarificationReply(current)) return current;
  // Find the original user question that prompted the clarification.
  let original = '';
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content.trim()) { original = msgs[i].content.trim(); break; }
  }
  if (!original || original === current) return current;
  return `${original} — clarification: ${current}`;
}

export function rewriteFollowUpQuestion(question: string, followUp?: AgentFollowUpContext): string {
  void followUp;
  return question.replace(/\s+/g, ' ').trim();
}

function formatPriorResultRefForQuestion(ref: AgentPriorResultReference): string {
  const parts = [
    `Prior result ref: result:${ref.id}`,
    ref.columns.length ? `schema=[${ref.columns.slice(0, 24).join(', ')}]` : '',
    typeof ref.rowCount === 'number' ? `row_count=${ref.rowCount}` : '',
    ref.sourceSql ? `source_sql=${compactInline(ref.sourceSql, 500)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatPriorDqlArtifactForQuestion(artifact: AgentDqlArtifactReference): string {
  const parts = [
    `Prior DQL artifact: kind=${artifact.kind}`,
    artifact.name ? `name=${artifact.name}` : '',
    artifact.sourcePath ? `path=${artifact.sourcePath}` : '',
    artifact.metrics?.length ? `metrics=[${artifact.metrics.slice(0, 12).join(', ')}]` : '',
    artifact.dimensions?.length ? `dimensions=[${artifact.dimensions.slice(0, 12).join(', ')}]` : '',
    artifact.filters?.length ? `filters=[${artifact.filters.slice(0, 8).map(formatDqlArtifactFilterInline).join('; ')}]` : '',
    artifact.timeDimension ? `time=${artifact.timeDimension.name}/${artifact.timeDimension.granularity}` : '',
    artifact.orderBy?.length ? `order_by=[${artifact.orderBy.slice(0, 8).map((order) => `${order.name} ${order.direction}`).join(', ')}]` : '',
    typeof artifact.limit === 'number' ? `limit=${artifact.limit}` : '',
    artifact.source ? `source=${compactInline(artifact.source, 900)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatDqlArtifactFilterInline(filter: { dimension: string; operator: string; values: string[] }): string {
  return `${filter.dimension} ${filter.operator} ${filter.values.slice(0, 8).join(', ')}`;
}

function formatFollowUpFilters(followUp: AgentFollowUpContext): string {
  if (!followUp.filters?.length) return '';
  if (followUp.dimensions?.length === 1) {
    return `${followUp.dimensions[0]} in [${followUp.filters.join(', ')}]`;
  }
  return followUp.filters.join(', ');
}

function compactInline(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3).trimEnd()}...` : compact;
}

/** Drafts shown to the model per app; enough to be useful, bounded for prompt size. */

/**
 * The App copilot's own app: its pages, tiles, and review-required drafts.
 *
 * `AppContextEnvelopeV1` already travelled to the prompt inside the serialized
 * run envelope, but only as an anonymous JSON dump — and it never carried the
 * app's drafts at all, because those live in `apps/<id>/drafts/` which the
 * manifest's block scan never reads. Rendering it here gives the drafts the
 * explicit trust instruction they need; the caller drops `appContext` from the
 * JSON dump so nothing is carried twice.
 *
 * This sits in the extra-context section, which already tells the model the
 * material must not override certified artifacts — the correct standing for a
 * review-required draft.
 */
/**
 * The App the question was asked in, as a bounded guidance string: name,
 * domain, audience, outcome, the focused block, and at most two draft names
 * (never their SQL — a draft's SQL is evidence the governed tiers read for
 * themselves, not prose for the interpreter). Capped so a large App cannot
 * crowd the cards out of the prompt.
 */
export function renderAppContextGuidance(value: unknown, maxChars = 600): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as {
    app?: { name?: string; domain?: string; audience?: string; businessOutcome?: string };
    drafts?: Array<{ name?: string; status?: string }>;
    focus?: { tileId?: string; blockId?: string };
  };
  const app = envelope.app;
  if (!app?.name) return undefined;
  const parts = [`Asked inside the App "${app.name}"${app.domain ? ` (domain ${app.domain})` : ''}.`];
  if (app.audience) parts.push(`Audience: ${app.audience}.`);
  if (app.businessOutcome) parts.push(`Outcome: ${app.businessOutcome}.`);
  if (envelope.focus?.blockId) parts.push(`Focused block: ${envelope.focus.blockId}.`);
  const drafts = (envelope.drafts ?? []).filter((draft) => draft?.name).slice(0, 2);
  if (drafts.length) parts.push(`Review-required drafts saved here (never certified): ${drafts.map((draft) => draft.name).join(', ')}.`);
  const text = parts.join(' ');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

export function renderExtraContext(req: AgentRunRequest, followUp?: AgentFollowUpContext): string | undefined {
  const parts: string[] = [];
  let upstream = req.upstream?.sql?.trim();
  if (upstream?.startsWith('{')) {
    // The run envelope carries `workspaceContext.appContext` for App copilot
    // questions. Render it as prose with its trust instruction, and strip it
    // from the JSON below rather than shipping the same content twice.
    try {
      const rawEnvelope = JSON.parse(upstream) as { workspaceContext?: Record<string, unknown> };
      const appContext = rawEnvelope.workspaceContext?.appContext;
      const rendered = renderAppContextGuidance(appContext);
      if (rendered) {
        parts.push(rendered);
        const { appContext: _dropped, ...restWorkspace } = rawEnvelope.workspaceContext ?? {};
        const envelope = prepareProviderContextForDispatch({
          ...rawEnvelope,
          workspaceContext: restWorkspace,
        }) as { workspaceContext?: Record<string, unknown> };
        upstream = JSON.stringify(envelope, null, 2);
      } else {
        upstream = JSON.stringify(prepareProviderContextForDispatch(rawEnvelope), null, 2);
      }
    } catch {
      // Not the structured envelope — fall through and carry it verbatim.
    }
  }
  if (upstream) {
    const label = upstream.startsWith('{') || upstream.startsWith('[')
      ? 'Current app/drill context'
      : 'Current upstream SQL';
    parts.push(`${label}:\n${upstream}`);
  }
  const context = req.conversationContext;
  // Thread-scoped runs render the structured conversation snapshot in its own
  // prompt section (answer-loop) — skip this text recap to avoid double-carrying.
  const hasServerSnapshot = Boolean((context as Record<string, unknown> | undefined)?.serverSnapshot);
  if (context && !hasServerSnapshot) {
    // Bound the carried-forward "conversation memory" defensively: only the most
    // recent turn's signals, with hard caps on the summary length and list sizes
    // so prompts don't grow across a long multi-turn chat.
    const clampText = (value: string, max = 240): string =>
      value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
    const clampList = (values: string[], max = 8): string => values.slice(0, max).join(', ');
    const contextLines = [
      context.sourceCertifiedBlock ? `source certified block: ${context.sourceCertifiedBlock}` : '',
      context.sourceQuestion ? `source question: ${clampText(context.sourceQuestion, 200)}` : '',
      context.sourceAnswerSummary ? `source answer summary: ${clampText(context.sourceAnswerSummary)}` : '',
      context.contextPackId ? `context pack: ${context.contextPackId}` : '',
      context.trustLabel ? `trust label: ${context.trustLabel}` : '',
      context.reviewStatus ? `review status: ${context.reviewStatus}` : '',
      context.draftBlockPath ? `draft block: ${context.draftBlockPath}` : '',
      context.dqlArtifact ? `prior DQL artifact:\n${formatPriorDqlArtifactForQuestion(context.dqlArtifact)}` : '',
      context.requestedFilters?.length ? `remembered filters: ${clampList(context.requestedFilters)}` : '',
      context.requestedDimensions?.length ? `remembered dimensions: ${clampList(context.requestedDimensions)}` : '',
      context.outputColumns?.length ? `prior output columns: ${clampList(context.outputColumns)}` : '',
      context.resultDimensionValues ? `prior result values: ${formatResultDimensionValues(context.resultDimensionValues)}` : '',
      context.turns?.length ? `recent analytical turns:\n${formatConversationTurnsForPrompt(context.turns)}` : '',
    ].filter(Boolean);
    if (contextLines.length > 0) {
      parts.push(`Conversation memory:\n${contextLines.join('\n')}`);
    }
  }
  if (followUp?.sourceBlockName) {
    const suffix = followUp.kind === 'drilldown'
      ? 'Use it as source context, but prefer a distinct certified drilldown block or a review-required draft.'
      : followUp.kind === 'contextual'
        ? 'This is advisory prior-turn context — use it only if the question refers to it; on a new topic, ignore it.'
        : 'Reuse it for this generic follow-up.';
    const lead = followUp.kind === 'contextual'
      ? `Prior turn used certified block "${followUp.sourceBlockName}".`
      : `Follow-up context: the user is referring to certified block "${followUp.sourceBlockName}".`;
    parts.push(`${lead} ${suffix}`);
  }
  if (followUp?.filters?.length) {
    parts.push(`Requested follow-up filters: ${followUp.filters.join(', ')}`);
  }
  if (followUp?.dimensions?.length) {
    parts.push(`Requested follow-up dimensions: ${followUp.dimensions.join(', ')}`);
  }
  if (followUp?.priorResultRef) {
    parts.push(`Prior result reference:\n${formatPriorResultRefForQuestion(followUp.priorResultRef)}`);
  }
  if (followUp?.priorDqlArtifact) {
    parts.push(`Prior DQL artifact reference:\n${formatPriorDqlArtifactForQuestion(followUp.priorDqlArtifact)}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function selectedContextForMetadata(req: AgentRunRequest, question: string): unknown {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return req.upstream;
  try {
    const parsed = JSON.parse(upstream) as Record<string, unknown>;
    if (!('selectedBlock' in parsed) && !('focusBlock' in parsed)) return req.upstream;
    if (shouldUseFocusedTileForQuestion(question)) return req.upstream;
    const { selectedBlock: _selectedBlock, ...rest } = parsed;
    return {
      ...rest,
      focusBlock: rest.focusBlock ?? _selectedBlock,
      contextPolicy: {
        ...(rest.contextPolicy && typeof rest.contextPolicy === 'object' && !Array.isArray(rest.contextPolicy)
          ? rest.contextPolicy as Record<string, unknown>
          : {}),
        retrieval: 'question_first',
        focusBlockUse: 'soft_context_only',
      },
    };
  } catch {
    return req.upstream;
  }
}

function shouldUseSelectedBlockHint(
  req: AgentRunRequest,
  question: string,
  followUp?: AgentFollowUpContext,
): boolean {
  if (followUp?.kind === 'generic' && followUp.sourceBlockName) return false;
  if (followUp?.kind === 'drilldown' || isDrilldownFollowUp(question)) return false;
  return shouldUseFocusedTileForQuestion(question) && extractSelectedBlockHints(req).length > 0;
}

function shouldUseFocusedTileForQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(this|that|it|selected\s+(?:tile|block|metric)|current\s+(?:tile|block|metric))\b/.test(lower)) return false;
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|less|most|rank|ranking|orders?|customers?|revenue|spend|by\s+[a-z]|compare|break\s*down|drill|why|driver|list|show|give me)\b/.test(lower)) {
    return false;
  }
  return true;
}

function extractSelectedBlockHints(req: AgentRunRequest): string[] {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return [];
  try {
    const parsed = JSON.parse(upstream) as {
      selectedBlock?: { blockId?: unknown };
      focusBlock?: { blockId?: unknown };
      availableBlocks?: Array<{ blockId?: unknown }>;
    };
    const selected = typeof parsed.selectedBlock?.blockId === 'string'
      ? parsed.selectedBlock.blockId.trim()
      : typeof parsed.focusBlock?.blockId === 'string'
        ? parsed.focusBlock.blockId.trim()
      : '';
    return selected ? [selected] : [];
  } catch {
    return [];
  }
}

function inferFollowUpContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  // A browser-carried assistant message is never enough to establish prior
  // governed authority. In particular, text such as "Answered by certified
  // block **x**" cannot become source attribution, a result filter, or a
  // compiler hint unless the host has reconstructed a persisted conversation
  // snapshot for this thread. HTTP Ask ingress removes public history; this
  // guard keeps alternative/direct provider entry points from reintroducing
  // the same authority bypass.
  if (!conversationSnapshotFromContext(req.conversationContext)) return undefined;
  // Even with server-backed context, a prior assistant turn is not permission
  // to carry rows, measures, or a block into a complete new analytical
  // question. Admit it only for an explicit prior-result reference/operation;
  // otherwise this returns `undefined`.
  const kind = isGenericFollowUp(question) ? 'generic' : isDrilldownFollowUp(question) ? 'drilldown' : undefined;
  if (!kind) return undefined;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== 'assistant') continue;
    const sourceBlockName = extractCertifiedBlockName(msg.content);
    if (!sourceBlockName) continue;
    return {
      kind,
      binding: 'prior_result',
      sourceBlockName,
      sourceAnswer: msg.content.slice(0, 1200),
      filters: kind === 'drilldown' ? extractDrilldownFilters(question) : undefined,
      dimensions: kind === 'drilldown' ? extractDrilldownDimensions(question) : undefined,
    };
  }
  return undefined;
}

function priorContextPackIdFromSnapshot(snapshot: ConversationSnapshot | undefined): string | undefined {
  const fromState = (snapshot?.workingState as { lastContextPackId?: unknown } | undefined)?.lastContextPackId;
  if (typeof fromState === 'string' && fromState.trim()) return fromState;
  const fromTurns = snapshot?.recentTurns?.length
    ? snapshot.recentTurns[snapshot.recentTurns.length - 1]?.contextPackId
    : undefined;
  return typeof fromTurns === 'string' && fromTurns.trim() ? fromTurns : undefined;
}

/** Parse the server-attached conversation snapshot (thread-scoped runs only). */
function conversationSnapshotFromContext(
  context: AgentRunRequest['conversationContext'],
): ConversationSnapshot | undefined {
  const record = context as Record<string, unknown> | undefined;
  const raw = record?.conversationEnvelope ?? record?.serverSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const snapshot = raw as ConversationSnapshot;
  return typeof snapshot.threadId === 'string' && Array.isArray(snapshot.recentTurns)
    ? snapshot
    : undefined;
}

/**
 * Deterministic stale-context protection: when the persisted working state says
 * the new question is a topic SHIFT, prior-turn filters must not be forced into
 * the follow-up (a "by X" phrasing can regex-classify as drilldown even on a
 * genuinely new topic). Question-derived filters are kept; carried ones drop.
 */
function applyTopicShiftGuard(
  followUp: AgentFollowUpContext | undefined,
  snapshot: ConversationSnapshot | undefined,
): AgentFollowUpContext | undefined {
  if (!followUp || snapshot?.topicRelation !== 'shift') return followUp;
  // A server-produced compound dependency is a direct child input, not an
  // incidental thread carry. Every other result binding is dropped on a
  // topic shift so a fresh analytical request cannot receive prior rows or
  // measures merely because the thread has history.
  return followUp.binding === 'task_dependency' ? followUp : undefined;
}

/**
 * Resolve the prior-turn context a follow-up may build on.
 *
 * The topic-shift guard is applied HERE rather than by the caller. It used to
 * be invoked at the provider call site only, while the retrieval call site
 * (`buildLocalContextPack`) took the raw result — so on a detected topic shift
 * the context pack was still built with the previous question's filters and
 * dimensions, and the retrieval query text was seeded with the previous
 * question and answer. Folding the guard in makes it impossible to forget at a
 * third call site.
 */
export function resolveAgentFollowUpContext(
  rawContext: Record<string, unknown> | undefined,
  question: string,
  snapshot?: ConversationSnapshot,
): AgentFollowUpContext | undefined {
  return applyTopicShiftGuard(
    resolveAgentFollowUpContextRaw(rawContext, question),
    snapshot ?? conversationSnapshotFromContext(rawContext as AgentRunRequest['conversationContext']),
  );
}

function resolveAgentFollowUpContextRaw(
  rawContext: Record<string, unknown> | undefined,
  question: string,
): AgentFollowUpContext | undefined {
  const context = rawContext as AgentRunRequest['conversationContext'];
  if (!context) return undefined;
  const taskDependency = analyticalTaskDependencyBindingFromContext(context);
  // A compound child receives exactly one server-computed parent value plus
  // result/row proofs. Do not replay parent prose, SQL, or result rows into the
  // child; its normal governed retrieval and immutable-plan checks still run.
  if (taskDependency) {
    return {
      kind: 'drilldown',
      binding: 'task_dependency',
      sourceTurnId: `task:${taskDependency.sourceTaskId}`,
      filters: [taskDependency.value],
      dimensions: [taskDependency.canonicalColumn],
      priorResultColumns: [taskDependency.canonicalColumn],
      priorResultValues: { [taskDependency.canonicalColumn]: [taskDependency.value] },
      memberBindings: [{
        dimension: taskDependency.canonicalColumn,
        values: [taskDependency.value],
        source: 'prior_result',
        confidence: 'exact',
        sourceTurnId: `task:${taskDependency.sourceTaskId}`,
      }],
      resolvedReferences: [`${taskDependency.canonicalColumn}: ${taskDependency.value}`],
    };
  }
  const turns = conversationTurnsFromContext(context);
  const activeTurn = activeConversationTurn(context, turns, question);
  const activeResult = activeTurn?.result && typeof activeTurn.result === 'object' && !Array.isArray(activeTurn.result)
    ? activeTurn.result as Record<string, unknown>
    : undefined;
  const sourceBlockName = cleanOptionalString(activeTurn?.sourceCertifiedBlock) ?? cleanOptionalString(context.sourceCertifiedBlock);
  const priorMemberSets = cleanPriorResultMemberSets(activeResult?.memberSets)
    ?? cleanPriorResultMemberSets(context.resultMemberSets);
  // New turns persist entity/display sets with a content-free result
  // fingerprint. Legacy rows retain `dimensionValues`, so merge both forms for
  // restart compatibility. The resolver always binds the display values; an
  // optional entity key is preserved as local continuity metadata, not guessed
  // into a user-visible filter.
  const priorResultValues = mergePriorResultValues(
    memberSetValuesByDimension(priorMemberSets),
    cleanStringRecordArray(activeResult?.dimensionValues),
    cleanStringRecordArray(context.resultDimensionValues),
  );
  const pluralPriorEntity = pluralPriorResultEntity(question);
  const priorResultSetUnavailable = Boolean(
    pluralPriorEntity && valuesForPriorDimension(priorResultValues ?? {}, pluralPriorEntity).length === 0,
  );
  const priorResultColumns = mergeStrings(
    arrayValue(activeResult?.columns),
    context.resultColumns,
    context.outputColumns,
  );
  const priorResultRef = priorResultRefFromTurn(activeTurn, activeResult, priorResultColumns);
  const priorDqlArtifact = cleanDqlArtifactReference(activeTurn?.dqlArtifact) ?? cleanDqlArtifactReference(context.dqlArtifact);
  const resolvedReferences = resolveConversationReferences(question, turns, priorResultValues);
  const focusedPriorResultValues = resolvedReferences.valuesByDimension ?? priorResultValues;
  const hasFocusedReference = Boolean(resolvedReferences.valuesByDimension);
  const relativeComparison = isEntityRelativeComparisonQuestion(question);
  const hasUsefulContext = Boolean(sourceBlockName || priorResultColumns?.length || focusedPriorResultValues || priorDqlArtifact);
  if (!hasUsefulContext) {
    // "Those customers" is an explicit set reference. Do not silently turn it
    // into a global customer ranking when the retained result values are absent
    // (for example, an intentionally redacted old row). The Ask runtime turns
    // this typed continuity gap into a clarification before any compiler or
    // connection attempt.
    if (!priorResultSetUnavailable || !pluralPriorEntity) return undefined;
    return {
      kind: 'drilldown',
      binding: 'prior_result',
      dimensions: [pluralPriorEntity],
      unresolvedReferences: [`The previous result did not retain the displayed ${pluralPriorEntity} set needed for "those ${pluralPriorEntity}s".`],
      priorResultSetUnavailable: true,
    };
  }
  // Prior-result material is execution-relevant context, not a friendly
  // transcript hint. A complete new question therefore receives no carry at
  // all. The only admission routes are a resolved typed reference, an
  // explicit prior-result operation, or a deictic/generic follow-up.
  const inferredKind = resolvedReferences.memberBindings?.length
    ? 'drilldown'
    : isGenericFollowUp(question)
      ? 'generic'
      : isDrilldownFollowUp(question, priorShapeTerms(priorResultColumns, focusedPriorResultValues))
        ? 'drilldown'
        : undefined;
  if (!inferredKind) return undefined;
  const binding: AgentConversationBindingV1 = 'prior_result';
  const kind = inferredKind;
  return {
    kind,
    binding,
    sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    // A relative comparison needs the named member from history, not the prior
    // block's result contract. Carrying a beverage-ranking block into "less tax
    // than Melissa" biases retrieval toward the same technical artifact and is
    // exactly how the old loop produced a global tax KPI or all customer rows.
    sourceBlockName: relativeComparison ? undefined : sourceBlockName,
    sourceQuestion: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.question) ?? cleanOptionalString(context.sourceQuestion),
    sourceAnswer: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.answerSummary) ?? cleanOptionalString(context.sourceAnswerSummary),
    filters: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedFilters'),
          hasFocusedReference ? undefined : context.requestedFilters,
          extractDrilldownFilters(question),
          resolvedReferences.filters,
        )
      : undefined,
    dimensions: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedDimensions'),
          hasFocusedReference ? undefined : context.requestedDimensions,
          extractDrilldownDimensions(question),
          resolvedReferences.dimensions,
        )
      : undefined,
    priorResultColumns: relativeComparison ? undefined : priorResultColumns,
    priorResultValues: focusedPriorResultValues,
    priorResultRef: relativeComparison ? undefined : priorResultRef,
    priorDqlArtifact: relativeComparison ? undefined : priorDqlArtifact,
    priorLimit: relativeComparison
      ? undefined
      : activeTurnNumber(activeTurn, 'topN') ?? (typeof context.priorLimit === 'number' ? context.priorLimit : undefined),
    priorMeasures: relativeComparison
      ? undefined
      : mergeStrings(
          activeTurnStringArray(activeTurn, 'requestedMeasures'),
          priorDqlArtifact?.metrics,
          arrayValue(activeResult?.measureColumns),
          context.priorMeasures,
          inferredMeasuresFromAnswerContract(context.answerContract),
          inferredMeasureColumns(priorResultColumns),
        ),
    memberBindings: resolvedReferences.memberBindings?.map((binding) => ({
      ...binding,
      sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    })),
    resolvedReferences: resolvedReferences.labels,
    unresolvedReferences: priorResultSetUnavailable && pluralPriorEntity
      ? [`The previous result did not retain the displayed ${pluralPriorEntity} set needed for "those ${pluralPriorEntity}s".`]
      : resolvedReferences.unresolved,
    ...(priorResultSetUnavailable ? { priorResultSetUnavailable: true } : {}),
    deicticChoices: resolvedReferences.deicticChoices,
    // The prior turn's actual rows, so a follow-up can compute across the shown
    // results ("of these, the average") without a fresh query. A relative
    // comparison deliberately drops the prior contract, so skip it there too.
    priorResult: relativeComparison ? undefined : priorResultDataFromTurn(activeResult, priorResultColumns),
  };
}

function analyticalTaskDependencyBindingFromContext(context: AgentRunRequest['conversationContext']): {
  sourceTaskId: string;
  sourceResultFingerprint: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
} | undefined {
  const raw = cleanRecord((context as Record<string, unknown>).analyticalTaskDependencyBinding);
  if (!raw || raw.version !== 1) return undefined;
  const sourceTaskId = cleanOptionalString(raw.sourceTaskId);
  const sourceResultFingerprint = cleanOptionalString(raw.sourceResultFingerprint)?.toLowerCase();
  const canonicalColumn = cleanOptionalString(raw.canonicalColumn);
  const value = cleanOptionalString(raw.value);
  const rowFingerprint = cleanOptionalString(raw.rowFingerprint)?.toLowerCase();
  if (!sourceTaskId || !canonicalColumn || !value
    || !/^[a-f0-9]{64}$/.test(sourceResultFingerprint ?? '')
    || !/^[a-f0-9]{64}$/.test(rowFingerprint ?? '')) return undefined;
  return { sourceTaskId, sourceResultFingerprint: sourceResultFingerprint!, canonicalColumn, value, rowFingerprint: rowFingerprint! };
}

/** Build the bounded prior-result rows (aligned to columns) for cross-result
 *  follow-up computation, from a turn's persisted result sample. */
function priorResultDataFromTurn(
  activeResult: Record<string, unknown> | undefined,
  columns: string[] | undefined,
): AgentFollowUpContext['priorResult'] {
  if (!activeResult || !columns || columns.length === 0) return undefined;
  const sample = activeResult.rowsSample;
  if (!Array.isArray(sample) || sample.length === 0) return undefined;
  const rows = sample
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => columns.map((_, index) => row[index]));
  if (rows.length === 0) return undefined;
  const measureColumns = (arrayValue(activeResult.measureColumns) ?? [])
    .filter((value): value is string => typeof value === 'string');
  const rowCountRaw = activeResult.rowCount;
  return {
    columns,
    rows,
    ...(measureColumns.length > 0 ? { measureColumns } : {}),
    ...(typeof rowCountRaw === 'number' ? { rowCount: rowCountRaw } : {}),
  };
}

function followUpFromConversationContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  return resolveAgentFollowUpContext(req.conversationContext as Record<string, unknown> | undefined, question);
}

function conversationTurnsFromContext(context: AgentRunRequest['conversationContext']): Array<Record<string, unknown>> {
  const explicit = Array.isArray(context?.turns)
    ? context.turns.map(cleanRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn))
    : [];
  const snapshot = conversationSnapshotFromContext(context);
  const snapshotTurns = [
    ...(snapshot?.recalledTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recalled')),
    ...(snapshot?.recentTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recent')),
  ].filter((turn): turn is Record<string, unknown> => Boolean(turn));
  const merged = mergeConversationTurnRecords([...snapshotTurns, ...explicit]);
  if (merged.length > 0) return merged.slice(-12);
  const legacy = cleanRecord({
    id: context?.sourceAnswerId,
    question: context?.sourceQuestion,
    answerSummary: context?.sourceAnswerSummary,
    sourceCertifiedBlock: context?.sourceCertifiedBlock,
    requestedFilters: context?.requestedFilters,
    requestedDimensions: context?.requestedDimensions,
    requestedMeasures: context?.priorMeasures,
    topN: context?.priorLimit,
    result: {
      columns: context?.resultColumns ?? context?.outputColumns,
      rowsSample: context?.resultRowsSample,
      dimensionValues: context?.resultDimensionValues,
      memberSets: context?.resultMemberSets,
      measureColumns: context?.priorMeasures,
    },
    route: context?.route,
    trustLabel: context?.trustLabel,
    reviewStatus: context?.reviewStatus,
    certification: context?.certification,
    contextPackId: context?.contextPackId,
    sourceSql: (context as Record<string, unknown> | undefined)?.sourceSql,
    dqlArtifact: context?.dqlArtifact,
    cascade: context?.cascade,
  });
  return legacy ? [legacy] : [];
}

function snapshotTurnToConversationRecord(
  turn: ConversationSnapshot['recentTurns'][number],
  snapshotSource: 'recent' | 'recalled',
): Record<string, unknown> | undefined {
  return compactConversationRecord({
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    route: turn.route,
    trustLabel: turn.trustLabel,
    runStatus: turn.runStatus,
    stopReason: turn.stopReason,
    contextPackId: turn.contextPackId,
    sourceSql: turn.sourceSql,
    dqlArtifact: turn.dqlArtifact,
    cascade: turn.cascade,
    snapshotSource,
    result: compactConversationRecord({
      columns: turn.resultColumns,
      dimensionValues: turn.resultDimensionValues,
      memberSets: turn.resultMemberSets,
      rowCount: turn.resultRowCount,
    }),
  });
}

function mergeConversationTurnRecords(turns: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const anonymous: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    const id = cleanOptionalString(turn.id);
    if (!id) {
      anonymous.push(turn);
      continue;
    }
    const current = byId.get(id);
    byId.set(id, current ? { ...current, ...turn } : turn);
  }
  return [...anonymous, ...byId.values()];
}

function activeConversationTurn(
  context: AgentRunRequest['conversationContext'],
  turns: Array<Record<string, unknown>>,
  question: string,
): Record<string, unknown> | undefined {
  if (turns.length === 0) return undefined;
  const activeId = cleanOptionalString(context?.activeTurnId);
  const activeMatch = activeId
    ? turns.find((turn) => cleanOptionalString(turn.id) === activeId)
    : undefined;
  const recalled = turns.filter((turn) =>
    cleanOptionalString(turn.snapshotSource) === 'recalled'
    && !turnIsUntrustedContext(turn)
    && turnHasUsefulResult(turn));
  if (recalled.length > 0) {
    const bestRecalled = recalled
      .map((turn) => ({ turn, score: scoreTurnForQuestion(turn, question) }))
      .sort((a, b) => b.score - a.score)[0];
    const activeScore = activeMatch ? scoreTurnForQuestion(activeMatch, question) : 0;
    if (bestRecalled && shouldPreferRecalledPriorResult(question, bestRecalled.score, activeScore)) {
      return bestRecalled.turn;
    }
  }
  if (activeId) {
    // An active chat-only recap is presentation context, not an analytical
    // result boundary. Fall through to the last trusted result-bearing turn so
    // plural deictic references retain their bounded member set after reload.
    if (activeMatch && !turnIsUntrustedContext(activeMatch) && turnHasUsefulResult(activeMatch)) return activeMatch;
  }
  // When nothing in the thread is trustworthy there is NO anchor. Falling back
  // to the last turn regardless meant a thread whose turns had all failed kept
  // anchoring each new question to the most recent failure.
  return [...turns].reverse().find((turn) => {
    return !turnIsUntrustedContext(turn) && turnHasUsefulResult(turn);
  }) ?? [...turns].reverse().find((turn) => !turnIsUntrustedContext(turn));
}

/**
 * A turn the next question may build on. This used to exclude only `blocked`,
 * so a refused turn ("I couldn't find the answer") stayed eligible as the
 * follow-up anchor and handed its broken DQL artifact and failing SQL to the
 * next question as authoritative prior context.
 */
function turnIsUntrustedContext(turn: Record<string, unknown>): boolean {
  return !isTrustedConversationTurn(turn as Parameters<typeof isTrustedConversationTurn>[0]);
}

function turnHasUsefulResult(turn: Record<string, unknown>): boolean {
  const result = cleanRecord(turn.result);
  const columns = arrayValue(result?.columns);
  const rows = arrayValue(result?.rowsSample);
  const values = cleanStringRecordArray(result?.dimensionValues);
  const memberSets = cleanPriorResultMemberSets(result?.memberSets);
  // New persisted turns can retain a typed entity/display set even when an
  // older compacted record no longer carries the preview rows. Treat that set
  // as result-bearing continuity evidence; otherwise a later chat-only turn
  // can displace the only safe anchor after restart.
  return Boolean(columns?.length || rows?.length || values || memberSets?.length);
}

function scoreTurnForQuestion(turn: Record<string, unknown>, question: string): number {
  const queryTokens = tokenSet(question);
  if (queryTokens.size === 0) return 0;
  const result = cleanRecord(turn.result);
  const values = cleanStringRecordArray(result?.dimensionValues);
  const text = [
    cleanOptionalString(turn.question),
    cleanOptionalString(turn.answerSummary),
    ...(arrayValue(result?.columns) ?? []).map((value) => cleanOptionalString(value)).filter((value): value is string => Boolean(value)),
    ...Object.entries(values ?? {}).flatMap(([key, list]) => [key, ...list.slice(0, 8)]),
  ].filter(Boolean).join(' ');
  let score = 0;
  const turnTokens = tokenSet(text);
  for (const token of queryTokens) {
    if (turnTokens.has(token)) score += 1;
  }
  return score;
}

function shouldPreferRecalledPriorResult(question: string, recalledScore: number, activeScore: number): boolean {
  if (recalledScore >= Math.max(activeScore + 2, 2)) return true;
  if (!wantsPriorResultReference(question)) return false;
  return recalledScore > 0 && recalledScore > activeScore;
}

function wantsPriorResultReference(question: string): boolean {
  return /\b(?:previous|prior|earlier|above)\s+(?:results?|outputs?|rows?|turns?)\b/i.test(question)
    || /\b(?:with|from|using|include)\s+(?:the\s+)?(?:previous|prior|earlier|above)\b/i.test(question);
}

function tokenSet(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length > 2 && !GENERIC_FOLLOW_UP_WORDS.has(token)));
}

function priorResultRefFromTurn(
  activeTurn: Record<string, unknown> | undefined,
  activeResult: Record<string, unknown> | undefined,
  priorResultColumns: string[] | undefined,
): AgentPriorResultReference | undefined {
  const columns = priorResultColumns?.slice(0, 32) ?? [];
  if (columns.length === 0) return undefined;
  const id = cleanOptionalString(activeTurn?.id) ?? 'previous';
  const rowCount = typeof activeResult?.rowCount === 'number' && Number.isFinite(activeResult.rowCount)
    ? activeResult.rowCount
    : Array.isArray(activeResult?.rowsSample)
      ? activeResult.rowsSample.length
      : undefined;
  const sourceSql = cleanOptionalString(activeTurn?.sourceSql);
  return {
    id,
    question: cleanOptionalString(activeTurn?.question),
    columns,
    rowCount,
    sourceSql: sourceSql ? sourceSql.slice(0, 1200) : undefined,
  };
}

function resolveConversationReferences(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): {
  filters?: string[];
  dimensions?: string[];
  labels?: string[];
  unresolved?: string[];
  valuesByDimension?: Record<string, string[]>;
  memberBindings?: AgentMemberBinding[];
  /**
   * Candidates a singular reference ("this customer") could mean when the prior
   * result offered more than one. Carried instead of guessed so the run can ask.
   */
  deicticChoices?: { dimension: string; values: string[] };
} {
  const namedValues = resolveNamedConversationValues(question, turns, activeValues);
  const dimensions = [
    ...(resolveDeicticDimensions(question, activeValues) ?? []),
    ...Object.keys(namedValues ?? {}).map(normalizePriorValueDimension),
  ];
  let filters = resolveDeicticFilters(question, activeValues) ?? [];
  const labels: string[] = [];
  // An ambiguous singular reference is the single most common follow-up shape
  // ("what region does this customer belong to?" after a ranked list). Keep the
  // candidates so the run can offer them instead of dead-ending.
  const ambiguousSingular = !namedValues
    ? resolveSingularDeicticCandidates(question, activeValues)
    : undefined;
  const deicticChoices = ambiguousSingular && ambiguousSingular.values.length > 1
    ? ambiguousSingular
    : undefined;
  // Do NOT backfill an ambiguous singular from history: filtering on all of the
  // candidates answers a different question than the one that was asked.
  if (!namedValues && !deicticChoices && dimensions.length > 0 && filters.length === 0) {
    for (const turn of [...turns].reverse()) {
      const values = cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues);
      if (!values) continue;
      filters = dimensions.flatMap((dimension) => valuesForPriorDimension(values, dimension));
      if (filters.length > 0) break;
    }
  }
  for (const dimension of dimensions) {
    const values = (namedValues
      ? valuesForPriorDimension(namedValues, dimension)
      : activeValues
        ? valuesForPriorDimension(activeValues, dimension)
        : []).slice(0, 5);
    labels.push(values.length ? `${dimension}: ${values.join(', ')}` : `${dimension}: unresolved`);
  }
  if (namedValues) filters.push(...Object.values(namedValues).flat());
  const questionText = normalizeConversationValueText(question);
  const memberBindings: AgentMemberBinding[] = namedValues
    ? Object.entries(namedValues).map(([dimension, values]) => ({
        dimension: normalizePriorValueDimension(dimension),
        values,
        source: 'prior_result',
        confidence: values.every((value) => (` ${questionText} `).includes(` ${normalizeConversationValueText(value)} `))
          ? 'exact'
          : 'unique_partial',
      }))
    : dimensions.length === 1 && filters.length > 0
      ? [{
          dimension: dimensions[0]!,
          values: Array.from(new Set(filters)).slice(0, 24),
          source: 'prior_result',
          confidence: 'deictic',
        }]
      : [];
  const unresolved = referencesNeedValues(question) && filters.length === 0
    ? [deicticChoices
        ? `"${deicticChoices.dimension}" was referenced in the singular, but the previous result had ${deicticChoices.values.length} of them.`
        : 'Could not resolve the referenced prior result values from conversation state.']
    : undefined;
  return {
    filters: filters.length > 0 ? Array.from(new Set(filters)).slice(0, 24) : undefined,
    dimensions: dimensions.length > 0 ? Array.from(new Set(dimensions)) : undefined,
    labels: labels.length > 0 ? Array.from(new Set(labels)) : undefined,
    unresolved,
    valuesByDimension: namedValues,
    memberBindings: memberBindings.length > 0 ? memberBindings : undefined,
    deicticChoices,
  };
}

/**
 * Resolve explicit mentions against bounded values from recent result sets. Full
 * phrases win; otherwise a unique member token may resolve a shortened name
 * ("Melissa" → "Melissa Lopez"). Ambiguous partials are deliberately left for
 * clarification instead of guessing between two real warehouse members.
 */
function resolveNamedConversationValues(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  const questionText = normalizeConversationValueText(question);
  const questionTokens = new Set(questionText.split(' ').filter((token) =>
    token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
  ));
  if (!questionText || questionTokens.size === 0) return undefined;

  const candidates = new Map<string, { dimension: string; value: string; exact: boolean }>();
  const addValues = (values: Record<string, string[]> | undefined) => {
    for (const [dimension, members] of Object.entries(values ?? {})) {
      for (const value of members) {
        const normalized = normalizeConversationValueText(value);
        if (!normalized) continue;
        const exact = (` ${questionText} `).includes(` ${normalized} `);
        const memberTokens = normalized.split(' ').filter((token) =>
          token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
        );
        const partial = memberTokens.some((token) => questionTokens.has(token));
        if (!exact && !partial) continue;
        candidates.set(`${dimension}\u0000${normalized}`, { dimension, value, exact });
      }
    }
  };
  addValues(activeValues);
  for (const turn of [...turns].reverse()) {
    addValues(cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues));
  }

  const all = [...candidates.values()];
  const exact = all.filter((candidate) => candidate.exact);
  const selected = exact.length > 0 ? exact : all;
  const distinctValues = new Set(selected.map((candidate) => normalizeConversationValueText(candidate.value)));
  if (distinctValues.size !== 1) return undefined;

  const out: Record<string, string[]> = {};
  for (const candidate of selected) {
    out[candidate.dimension] = Array.from(new Set([...(out[candidate.dimension] ?? []), candidate.value])).slice(0, 4);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConversationValueText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@._'-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEntityRelativeComparisonQuestion(question: string): boolean {
  return /\b(?:less|lower|fewer|more|higher|greater)\b[^?.!]{0,80}\bthan\b\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+[A-Z][A-Za-z0-9@._'-]+/.test(question);
}

function cleanRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactConversationRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanDqlArtifactReference(value: unknown): AgentDqlArtifactReference | undefined {
  const artifact = normalizeDqlArtifactReference(value);
  if (!artifact) return undefined;
  return {
    ...artifact,
    source: artifact.source.slice(0, 3000),
    metrics: uniqueStringList(artifact.metrics),
    dimensions: uniqueStringList(artifact.dimensions),
    filters: artifact.filters
      ?.filter((filter) => filter.values.length > 0)
      .slice(0, 12)
      .map((filter) => ({ ...filter, values: uniqueStringList(filter.values)?.slice(0, 12) ?? [] })),
    orderBy: artifact.orderBy?.slice(0, 12),
  };
}

function uniqueStringList(value: string[] | undefined): string[] | undefined {
  if (!value?.length) return undefined;
  const unique = Array.from(new Set(value)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function activeTurnStringArray(turn: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  return arrayValue(turn?.[key]);
}

function activeTurnNumber(turn: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = turn?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function referencesNeedValues(question: string): boolean {
  return /\b(?:it|its|they|their|them|he|she|him|his|her|hers|this|that|these|those|same|above|previous|prior)\b/i.test(question);
}

function extractCertifiedBlockName(content: string): string | undefined {
  const fromAnswer = content.match(/Answered by certified block \*\*([^*]+)\*\*/i)?.[1];
  const fromRoute = content.match(/Answered from certified block\s+([A-Za-z0-9_.-]+)/i)?.[1];
  const fromCitation = content.match(/^- block:\s*([A-Za-z0-9_.-]+)/im)?.[1];
  // The name pattern admits dots, so a sentence period lands in the match
  // ("... block food_vs_drink_revenue.") — strip trailing punctuation.
  return (fromAnswer ?? fromRoute ?? fromCitation)?.trim().replace(/[.,;:]+$/, '') || undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mergeStrings(...groups: Array<unknown[] | undefined>): string[] | undefined {
  const values = groups
    .flatMap((group) => group ?? [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function inferredMeasuresFromAnswerContract(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const requestedShape = record.requestedShape && typeof record.requestedShape === 'object' && !Array.isArray(record.requestedShape)
    ? record.requestedShape as Record<string, unknown>
    : undefined;
  return mergeStrings(arrayValue(record.measures), arrayValue(requestedShape?.measures));
}

function inferredMeasureColumns(columns: string[] | undefined): string[] | undefined {
  if (!columns?.length) return undefined;
  const measures = columns.filter((column) =>
    /\b(revenue|sales|amount|total|count|average|avg|sum|spend|cost|margin|profit|value|points?|score|quantity|rate|volume)\b/i.test(
      column.replace(/_/g, ' '),
    )
  );
  return measures.length > 0 ? measures : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function cleanStringRecordArray(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const values = Array.isArray(raw)
      ? raw.map(cleanOptionalString).filter((item): item is string => Boolean(item)).slice(0, 24)
      : [];
    if (key.trim() && values.length > 0) out[key.trim()] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Values a singular deictic reference ("this customer") could be pointing at.
 *
 * This used to `.slice(0, 1)` — silently picking the FIRST row of the previous
 * answer and binding it as a required filter. After a ten-row ranking, "this
 * customer" would quietly become "Melissa Lopez" because she happened to sort
 * first, and the user was never told. An ambiguous reference must stay
 * ambiguous so the caller can ask which one was meant.
 */
function resolveSingularDeicticCandidates(
  question: string,
  priorValues: Record<string, string[]> | undefined,
): { dimension: string; values: string[] } | undefined {
  if (!priorValues) return undefined;
  const singular = resolveSingularDeicticDimension(question, priorValues);
  if (!singular) return undefined;
  const values = Array.from(new Set(valuesForPriorDimension(priorValues, singular))).slice(0, 24);
  return values.length > 0 ? { dimension: singular, values } : undefined;
}

function resolveDeicticFilters(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const hasExplicitPluralReference = /\b(?:these|those|same)\s+(?:customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/i.test(question);
  if (!hasExplicitPluralReference) {
    const singular = resolveSingularDeicticCandidates(question, priorValues);
    if (singular) {
      // Exactly one candidate is unambiguous and can be bound as a filter.
      // Several candidates are a question for the user, not a coin flip.
      return singular.values.length === 1 ? singular.values : undefined;
    }
  }
  const dims = resolveDeicticDimensions(question, priorValues) ?? [];
  const values = dims.flatMap((dim) => valuesForPriorDimension(priorValues, dim));
  return values.length > 0 ? Array.from(new Set(values)).slice(0, 24) : undefined;
}

function resolveDeicticDimensions(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const lower = question.toLowerCase();
  const dims: string[] = [];
  // A definite article names the current population ("the customers", "the
  // regions"); it does not point at rows from the previous answer. Treating
  // "the" like "these/those" silently turned ordinary new analyses into
  // required member filters from conversation history. Carry prior members only
  // for explicit demonstratives or other unambiguous prior-result references.
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:these|those|same|previous|prior|above)\s+cat(?:egor|agor|ogor)(?:y|ies)\b/, 'category'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+products?\b/, 'product'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+customers?\b/, 'customer'],
    [/\b(?:above|previous|prior)\s+(?:orders?|results?|rows?)\b/, 'customer'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+segments?\b/, 'segment'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+regions?\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (!pattern.test(lower)) continue;
    if (dim === 'product' && /\b(?:this|that|these|those|same|previous|prior|above)\s+product\s+cat(?:egor|agor|ogor)(?:y|ies)\b/.test(lower)) continue;
    if (valuesForPriorDimension(priorValues, dim).length) dims.push(dim);
  }
  // Subject/object pronouns usually refer to people/accounts when paired with
  // purchasing verbs. Resolve that entity before broad object retrieval so a
  // prior customer row does not become a fresh catalog search for "they".
  if (
    dims.length === 0
    && /\b(?:they|their|them)\b[^.?!]{0,48}\b(?:buy|bought|purchase|purchased|order|ordered|spend|spent|use|used)\b/.test(lower)
  ) {
    if (valuesForPriorDimension(priorValues, 'customer').length > 0) dims.push('customer');
    else {
      const nameColumn = personNameFallbackDimension(priorValues);
      if (nameColumn) dims.push(nameColumn);
    }
  }
  // Singular people pronouns are common in conversational analytical follow-ups
  // ("what region does he belong to?", "what is her segment?"). Resolve them
  // against the prior result's typed customer values, preserving the same
  // ambiguity guard used by "this customer". This is intentionally limited to
  // a person-like prior dimension; a pronoun must never make us guess a product
  // or metric member from the first row.
  if (dims.length === 0 && /\b(?:he|she|him|his|her|hers)\b/.test(lower)) {
    if (valuesForPriorDimension(priorValues, 'customer').length > 0) dims.push('customer');
    else {
      const nameColumn = personNameFallbackDimension(priorValues);
      if (nameColumn) dims.push(nameColumn);
    }
  }
  // Singular people pronouns are deliberately EXCLUDED from this broad
  // fallback. `singlePriorValueDimension` returns a whole dimension, and
  // `resolveDeicticFilters` then binds every value in it — so "what region he
  // belongs to" over a ten-row answer silently filtered on all ten people at
  // once, with no clarification and no sign anything had been assumed. A
  // singular reference resolves above or becomes an ambiguity for the user to
  // settle; it must never widen into the entire prior population.
  if (dims.length === 0 && /\b(?:it|its|they|their|them|this|these|those|that|same|above|previous|prior)\b/.test(lower)) {
    const single = singlePriorValueDimension(priorValues);
    if (single) dims.push(single);
  }
  return dims.length > 0 ? Array.from(new Set(dims)) : undefined;
}

function resolveSingularDeicticDimension(question: string, priorValues: Record<string, string[]>): string | undefined {
  const lower = question.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:this|that|same|previous|prior|above)\s+product\b/, 'product'],
    [/\b(?:this|that|same|previous|prior|above)\s+customer\b/, 'customer'],
    [/\b(?:he|she|him|his|her|hers)\b/, 'customer'],
    [/\b(?:this|that|same|previous|prior|above)\s+category\b/, 'category'],
    [/\b(?:this|that|same|previous|prior|above)\s+segment\b/, 'segment'],
    [/\b(?:this|that|same|previous|prior|above)\s+region\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (pattern.test(lower) && valuesForPriorDimension(priorValues, dim).length) return dim;
  }
  // A person pronoun over a result whose only people column is a bare `name`.
  // Returning the column here keeps the ambiguity guard intact: the caller
  // still collects every candidate and asks which one was meant.
  if (/\b(?:he|she|him|his|her|hers)\b/.test(lower)) return personNameFallbackDimension(priorValues);
  return undefined;
}

function valuesForPriorDimension(values: Record<string, string[]>, dim: string): string[] {
  const aliases = [dim, `${dim}_name`];
  if (dim === 'product') aliases.push('sku');
  if (dim === 'category') aliases.push('product_type', 'category_name');
  const exact = aliases.flatMap((alias) => values[alias] ?? []);
  // Exact alias matching alone is too literal for real result sets: keys here
  // are raw result column names, so `customer_display_name` and `top_customer`
  // both identify customers while matching none of the aliases above. Fold
  // every key that normalizes to the same business dimension AND actually
  // names members of it.
  const normalized = Object.entries(values)
    .filter(([key]) => normalizePriorValueDimension(key) === dim && namesMembersOf(key, dim))
    .flatMap(([, dimensionValues]) => dimensionValues);
  return Array.from(new Set([...exact, ...normalized])).filter(Boolean);
}

/**
 * Words that mark a column as describing an attribute OF an entity rather than
 * listing the entity's members.
 */
const NON_IDENTITY_COLUMN_WORDS = new Set([
  'id', 'ids', 'key', 'keys', 'code', 'type', 'types', 'status', 'tier', 'segment',
  'category', 'group', 'class', 'level', 'flag', 'count', 'total', 'sum', 'avg',
  'revenue', 'spend', 'amount', 'value', 'score', 'rank', 'date', 'at', 'ts',
]);

/**
 * Does this column list MEMBERS of `dim`, rather than an attribute of them?
 *
 * `customer_type` normalizes to the customer dimension but holds "returning" —
 * a segment label, not a person. Binding it as a member filter is precisely
 * the silent wrong answer this resolver exists to prevent, so a column whose
 * remaining words describe an attribute is not a source of member identities.
 * Ids are excluded for the same reason the persistence layer excludes them:
 * they are not a display surface a user can recognise or choose between.
 */
function namesMembersOf(key: string, dim: string): boolean {
  const words = key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const residual = words.filter((word) => word !== dim && word !== `${dim}s`);
  return !residual.some((word) => NON_IDENTITY_COLUMN_WORDS.has(word));
}

/**
 * The display column of a prior result that plainly holds person names, for
 * use only when no business-entity key resolved.
 *
 * A certified block that outputs a bare `name` column defeats both alias and
 * normalized matching: `name` describes no entity on its own. That is the
 * exact shape behind the reported failure — ten named customers on screen,
 * and "what region he belongs to" resolving to nothing. Restricted to a
 * singular person reference and to a single unambiguous name-like column, so
 * a pronoun can still never conjure a product or metric member.
 */
function personNameFallbackDimension(priorValues: Record<string, string[]>): string | undefined {
  for (const entity of ['customer', 'account', 'user'] as const) {
    if (valuesForPriorDimension(priorValues, entity).length > 0) return undefined;
  }
  const nameColumns = Object.keys(priorValues)
    .filter((key) => /(^|[_\s-])(full[_\s-]?)?name$/i.test(key.trim()))
    .filter((key) => (priorValues[key] ?? []).length > 0);
  return nameColumns.length === 1 ? nameColumns[0] : undefined;
}

function pluralPriorResultEntity(question: string): 'customer' | 'account' | 'product' | 'user' | undefined {
  const lower = question.toLowerCase();
  if (/\b(?:these|those|same|previous|prior)\s+customers?\b|\bof\s+(?:these|those)\s+customers?\b/.test(lower)) return 'customer';
  if (/\b(?:these|those|same|previous|prior)\s+accounts?\b|\bof\s+(?:these|those)\s+accounts?\b/.test(lower)) return 'account';
  if (/\b(?:these|those|same|previous|prior)\s+products?\b|\bof\s+(?:these|those)\s+products?\b/.test(lower)) return 'product';
  if (/\b(?:these|those|same|previous|prior)\s+users?\b|\bof\s+(?:these|those)\s+users?\b/.test(lower)) return 'user';
  return undefined;
}

function cleanPriorResultMemberSets(value: unknown): ConversationResultMemberSetV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowedEntities = new Set<ConversationResultMemberSetV1['entity']>([
    'customer', 'account', 'product', 'user', 'other',
  ]);
  const sets = value.flatMap((raw): ConversationResultMemberSetV1[] => {
    const record = cleanRecord(raw);
    if (!record || record.version !== 1) return [];
    const entity = cleanOptionalString(record.entity) as ConversationResultMemberSetV1['entity'] | undefined;
    const displayColumn = cleanOptionalString(record.displayColumn);
    const displayValues = arrayValue(record.displayValues)
      ?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item, index, values) => values.indexOf(item) === index)
      .slice(0, 24);
    if (!entity || !allowedEntities.has(entity) || !displayColumn || !displayValues?.length) return [];
    const keyColumn = cleanOptionalString(record.keyColumn);
    const keyValues = arrayValue(record.keyValues)
      ?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item, index, values) => values.indexOf(item) === index)
      .slice(0, 24);
    const resultFingerprint = cleanOptionalString(record.resultFingerprint);
    return [{
      version: 1,
      entity,
      displayColumn,
      displayValues,
      ...(keyColumn && keyValues?.length ? { keyColumn, keyValues } : {}),
      ...(resultFingerprint && /^[a-f0-9]{64}$/i.test(resultFingerprint)
        ? { resultFingerprint: resultFingerprint.toLowerCase() }
        : {}),
    }];
  });
  return sets.length > 0 ? sets.slice(0, 8) : undefined;
}

function memberSetValuesByDimension(
  sets: ConversationResultMemberSetV1[] | undefined,
): Record<string, string[]> | undefined {
  if (!sets?.length) return undefined;
  // Key each set under BOTH its display column and its business entity.
  //
  // The entity was already resolved when the turn was persisted (a `name`
  // column on a customer result is recorded as entity `customer`). Keying only
  // by `displayColumn` threw that away, so a resolver asking for the values of
  // dimension `customer` found nothing whenever the result happened to display
  // `name` rather than `customer_name` — no pronoun binding, and worse, no
  // ambiguity candidates either, so the "which one did you mean?" question
  // could never be asked. Merge rather than overwrite: two sets can share an
  // entity.
  return mergePriorResultValues(
    ...sets.map((set) => ({ [set.displayColumn]: set.displayValues })),
    ...sets.map((set) => ({ [set.entity]: set.displayValues })),
  );
}

function mergePriorResultValues(
  ...records: Array<Record<string, string[]> | undefined>
): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const record of records) {
    for (const [dimension, values] of Object.entries(record ?? {})) {
      const existing = merged[dimension] ?? [];
      const next = Array.from(new Set([...existing, ...values]))
        .filter(Boolean)
        .slice(0, 24);
      if (next.length > 0) merged[dimension] = next;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function formatResultDimensionValues(value: Record<string, string[]>): string {
  return Object.entries(value)
    .slice(0, 8)
    .map(([key, values]) => `${key}=[${values.slice(0, 8).join(', ')}]`)
    .join('; ');
}

function formatConversationTurnsForPrompt(turns: unknown[]): string {
  return turns
    .map(cleanRecord)
    .filter((turn): turn is Record<string, unknown> => Boolean(turn))
    .slice(-4)
    .map((turn, index) => {
      const result = cleanRecord(turn.result);
      const columns = arrayValue(result?.columns)?.map(cleanOptionalString).filter(Boolean).slice(0, 6) ?? [];
      const values = cleanStringRecordArray(result?.dimensionValues);
      const valueText = values ? formatResultDimensionValues(values) : '';
      const cascade = cleanRecord(turn.cascade);
      const cascadeText = [
        cleanOptionalString(cascade?.terminalLane),
        cleanOptionalString(cascade?.routeTier),
      ].filter(Boolean).join('/');
      return [
        `${index + 1}. ${cleanOptionalString(turn.question) ?? 'prior turn'}`,
        cascadeText ? `cascade=${cascadeText}` : '',
        cleanOptionalString(turn.answerSummary) ? `summary=${cleanOptionalString(turn.answerSummary)}` : '',
        columns.length ? `columns=${columns.join(', ')}` : '',
        valueText ? `values=${valueText}` : '',
      ].filter(Boolean).join(' | ');
    })
    .join('\n');
}

function singlePriorValueDimension(priorValues: Record<string, string[]>): string | undefined {
  const dims = Array.from(new Set(Object.keys(priorValues).map(normalizePriorValueDimension).filter(Boolean)));
  return dims.length === 1 ? dims[0] : undefined;
}

function normalizePriorValueDimension(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('category')) return 'category';
  if (lower.includes('product')) return 'product';
  if (lower.includes('customer')) return 'customer';
  if (lower.includes('account')) return 'account';
  if (lower.includes('user')) return 'user';
  if (lower.includes('region')) return 'region';
  if (lower.includes('segment')) return 'segment';
  if (lower.includes('channel')) return 'channel';
  return lower.replace(/[_\s-]+name$/, '').replace(/[^a-z0-9_ -]+/g, '').trim();
}

export const __test__ = {
  applyTopicShiftGuard,
  isDrilldownFollowUp,
  followUpFromConversationContext,
  inferFollowUpContext,
  rewriteFollowUpQuestion,
};

const GENERIC_FOLLOW_UP_WORDS = new Set([
  'a', 'about', 'again', 'all', 'also', 'and', 'are', 'as', 'be', 'block', 'can', 'could', 'data', 'did', 'do', 'does',
  'execute', 'for', 'from', 'get', 'give', 'import', 'it', 'its', 'let', 'lets', 'me', 'metrics',
  'more', 'now', 'of', 'output', 'please', 'result', 'results', 'run', 'show', 'solution', 'summary',
  'that', 'the', 'them', 'this', 'to', 'use', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you',
]);

function isGenericFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(?:what|how)\s+about\s+(?:the\s+)?(?:other|remaining|rest(?:\s+of\s+the)?)\s+(?:metrics?|measures?)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:combine|merge|join|final|summari[sz]e)\b/.test(lower) && /\b(?:previous|prior|above|these|those|results?|outputs?|turns?)\b/.test(lower)) {
    return true;
  }
  if (!/\b(block|data|execute|import|it|result|results|run|solution|that|this)\b/.test(lower)) return false;
  const tokens = lower.match(/[a-z0-9_]+/g) ?? [];
  const meaningful = tokens.filter((token) => token.length > 1 && !GENERIC_FOLLOW_UP_WORDS.has(token));
  return meaningful.length === 0;
}

/**
 * A drilldown INHERITS the previous turn's filters and dimensions, so the bar
 * for classifying one has to be a reference to that previous turn.
 *
 * This used to fire on a bare `by`, `for`, `only`, `where`, `compare` or a noun
 * like `regions`, which is present in almost every analytical question. "Show
 * revenue by region" on a brand-new topic was therefore treated as a drilldown
 * of whatever came before and silently inherited its filters — the reported
 * "when I ask a different question it's not giving the right solution".
 *
 * Now it needs either a deictic reference to the prior result, or an explicit
 * drill verb that only makes sense relative to something already on screen.
 */
function isDrilldownFollowUp(question: string, _priorTerms: string[] = []): boolean {
  const lower = question.toLowerCase();
  const deicticDrilldown = /\b(?:this|that|these|those|same|above|previous|prior)\s+(?:amount|value|orders?|results?|rows?|customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/.test(lower)
    || /\b(?:they|their|them|he|she|him|his|her|hers)\b/.test(lower);
  // `break ... down` is split by its object more often than not ("break that
  // down", "break the revenue down"), so the verb and particle are matched with
  // a short gap between them rather than adjacently.
  const explicitDrillVerb = /\b(drills?|breakdowns?|slices?|segments?|splits?|why|drivers?|root cause|variance)\b/.test(lower)
    || /\bbreak\b.{0,16}\bdown\b/.test(lower);
  const hasDeicticReference = /\b(?:this|that|these|those|same|above|previous|prior|they|their|them|he|she|him|his|her|hers)\b/.test(lower);
  const resultStateReference = /\b(?:decline|drop|change|increase|decrease|variance)\b/.test(lower);
  // A shared word such as customer, revenue, or region is not a prior-result
  // reference. It appears in many unrelated analytical questions and used to
  // make a fresh request inherit the prior answer's filters and measures.
  const explicitPriorResultOperation = /\b(?:top|bottom)\s+\d+\s+of\s+(?:these|those|them|the\s+(?:prior|previous)?\s*results?)\b/.test(lower)
    || /\b(?:average|sum|total|compare)\s+(?:of|across)\s+(?:these|those|them|the\s+(?:prior|previous)?\s*results?)\b/.test(lower);
  // An additive projection is explicitly anchored to the result on screen.
  // It still has no authority without a completed host-persisted result; the
  // local runtime checks that boundary before it can preserve prior shape.
  const explicitResultProjectionAugmentation = /\b(?:add|include|also\s+(?:show|include))\s+(?:the\s+)?[a-z][a-z0-9_ -]{0,48}\s+(?:here|there|too|as\s+well)\b/.test(lower);
  // A drill verb with NO NEW SUBJECT is a shape continuation of the answer
  // on screen: "can you split by month" names no measure and no entity of its
  // own, so there is nothing else it could be about. Requiring a deictic word
  // here dropped the entire conversation — the certified `monthly_revenue`
  // block then claimed the turn against an EMPTY plan (its fit vacuously
  // exact), answering a different question than the one being refined. A
  // question that brings its own measure or entity keeps today's strictness.
  const plan = buildAnalysisQuestionPlan(question);
  const bringsOwnSubject = plan.metricTerms.length > 0 || plan.entities.length > 0;
  // The verb must also have NO explicit object: "split by month" refines what
  // is on screen, while "split shipments by warehouse" names its own subject
  // even when that noun is outside the parser's vocabulary.
  const objectlessDrill = /\b(?:splits?|slices?|group)\s*(?:it|this|that|them|these|those)?\s*by\b/.test(lower)
    || /\bbreak\s*(?:it|this|that|them)?\s*down\s+by\b/.test(lower);
  const shapeContinuation = objectlessDrill && !bringsOwnSubject;
  if (!deicticDrilldown && !explicitPriorResultOperation && !explicitResultProjectionAugmentation
    && !shapeContinuation
    && !(explicitDrillVerb && (hasDeicticReference || resultStateReference))) return false;
  // Bare definitions should not inherit a prior result merely because they
  // contain a pronoun. An explicit result operation remains authoritative.
  return explicitPriorResultOperation || explicitResultProjectionAugmentation || !/\b(what is|what are|define|definition|meaning of)\b/.test(lower);
}

/**
 * Lower-cased words from the prior result's columns and dimension keys, used to
 * detect that a follow-up is about that result.
 */
function priorShapeTerms(
  columns: string[] | undefined,
  dimensionValues: Record<string, string[]> | undefined,
): string[] {
  const names = [...(columns ?? []), ...Object.keys(dimensionValues ?? {})];
  const terms = new Set<string>();
  for (const name of names) {
    for (const part of name.toLowerCase().split(/[^a-z0-9]+/)) {
      // Skip short and generic tokens that would match almost any question.
      if (part.length >= 4 && !['name', 'total', 'count', 'value', 'date', 'time'].includes(part)) {
        terms.add(part);
      }
    }
  }
  return [...terms];
}

function extractDrilldownFilters(question: string): string[] {
  const filters: string[] = [];
  const quoted = [...question.matchAll(/["']([^"']+)["']/g)].map((match) => match[1].trim()).filter(Boolean);
  filters.push(...quoted);
  for (const pattern of [
    /\benterprise\b/i,
    /\bsmall business\b/i,
    /\bmid[- ]market\b/i,
    /\blast week\b/i,
    /\bthis week\b/i,
    /\blast month\b/i,
    /\bthis month\b/i,
    /\blast quarter\b/i,
    /\bthis quarter\b/i,
  ]) {
    const match = question.match(pattern);
    if (match) filters.push(match[0]);
  }
  return Array.from(new Set(filters));
}

function extractDrilldownDimensions(question: string): string[] {
  const dims: string[] = [];
  for (const match of question.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/gi)) {
    const value = match[1].replace(/\b(last|this|where|for|only|and|with)\b.*$/i, '').trim();
    if (value) dims.push(value);
  }
  for (const dim of ['segment', 'region', 'customer', 'channel', 'product', 'category', 'week', 'month']) {
    if (new RegExp(`\\b${dim}\\b`, 'i').test(question)) dims.push(dim);
  }
  return Array.from(new Set(dims));
}
