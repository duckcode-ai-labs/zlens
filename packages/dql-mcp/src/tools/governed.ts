import { askScopeFromWorkspace, workspaceContextForScope } from '@zlens/agent';
import { resolveTrustLabel, trustLabelIdForStatus } from '@zlens/core';
import type { DQLContext } from '../context.js';
import { fetchRuntime, readRuntimeJson, runtimeBaseUrl, runtimeTimeoutMs, runtimeUnreachableMessage } from '../runtime-fetch.js';

/**
 * Governed-generation MCP tools. Unlike the BYOSQL Tier-2 tool
 * (`query_via_metadata`, where the CALLING agent authors the SQL), these run
 * DQL's OWN governed engines end-to-end and return the executed answer / block
 * draft — the SAME cascade the web UI uses, so every trust guard (honesty gate,
 * hollow-answer handling, forced-join retry, deterministic refusal) applies
 * automatically. They are thin proxies to the local runtime's governed HTTP
 * endpoints (`/api/agent-runs`, `/api/ai/build`), which already own the LLM
 * provider + warehouse executors, so there is no second provider to configure.
 *
 * Both require the ZLens runtime to be running (the workbench `zlens notebook`
 * starts) because governed
 * answering/building executes SQL against the warehouse.
 */

const runtimeBase = runtimeBaseUrl;

function runtimeUnavailable(base: string, projectRoot: string, err: unknown) {
  return {
    ok: false as const,
    runtimeUnavailable: true as const,
    error: runtimeUnreachableMessage(base, projectRoot, err, 'Governed answering and building need it'),
  };
}

/**
 * The workbench answers without an AI model only by refusing. An agent that
 * is itself the model should then answer through the bring-your-own-SQL path,
 * which needs no model inside ZLens; say so instead of returning a "blocked"
 * run that reads like a finished answer.
 */
const MODEL_UNAVAILABLE_NEXT_STEP =
  'Answer it yourself instead: call ask_dql; when it routes to a certified block, run it with query_via_block; ' +
  'otherwise call inspect_metadata_context and run one read-only SELECT with query_via_metadata (label the result AI-Generated, review required). ' +
  'Or set up an AI provider in the workbench (Settings → AI provider) so ZLens can answer itself.';

function modelUnavailable(run: AgentRunLike): boolean {
  const failure = (run.artifacts ?? [])
    .map((artifact) => (artifact?.payload as { diagnosticReceipt?: { failure?: { safeActions?: unknown } } } | undefined)?.diagnosticReceipt?.failure)
    .find(Boolean);
  const safeActions = Array.isArray(failure?.safeActions) ? failure!.safeActions as unknown[] : [];
  return run.status === 'blocked' && (safeActions.includes('retry-after-provider') || /no ai model is configured/i.test(run.answer ?? run.summary ?? ''));
}

interface AgentAnswerPayload {
  answer?: string;
  text?: string;
  proposedSql?: string;
  sql?: string;
  result?: { columns?: unknown[]; rows?: unknown[]; rowCount?: number };
  executionError?: string;
  dqlArtifact?: unknown;
  draftBlockId?: string;
  draftBlock?: { path?: string };
  promoteCommand?: string;
  citations?: unknown[];
  validationWarnings?: string[];
  trustLabel?: string;
}

interface AgentRunLike {
  id?: string;
  question?: string;
  route?: string;
  status?: string;
  trustState?: string;
  answerKind?: string;
  answer?: string;
  summary?: string;
  artifacts?: Array<{ id?: string; kind?: string; title?: string; trustState?: string; ref?: string; payload?: unknown }>;
  nextActions?: unknown[];
  /** The Ask pipeline receipt; its context ledger says what the answer was read against. */
  diagnosticReceiptV9?: { context?: unknown };
  /** The draft a review-required answer left for review (graduated trust, Tier 2). */
  reviewDraft?: { path: string; status: 'draft'; askedTimes: number; created: boolean };
}

/** Reshape a runtime AgentRun into a compact, agent-friendly governed result. */
type InvestigationLike = {
  headline?: { text?: string; verdict?: string };
  drivers?: Array<{ path?: Array<{ dimension?: { label?: string }; member?: { label?: string } }>; prior?: { value?: string }; current?: { value?: string }; share?: string; verdict?: string }>;
  ruledOut?: Array<{ dimension?: { label?: string } }>;
  notInvestigated?: Array<{ dimension?: { label?: string }; reason?: string }>;
  caveats?: Array<{ text?: string }>;
  confidence?: { level?: string; reasons?: string[] };
};

/**
 * A Research investigation, compact: the headline, the drivers with their
 * share of the change, what was ruled out and not broken down, the caveats and
 * the confidence. Figures only; the rows stay in the run.
 */
function investigationSummary(run: AgentRunLike) {
  const research = (run.artifacts ?? []).find((artifact) => artifact?.kind === 'research_run');
  const payload = research?.payload as { kind?: string; investigation?: InvestigationLike } | undefined;
  const investigation = payload?.kind === 'investigation' ? payload.investigation : undefined;
  if (!investigation) return undefined;
  return {
    headline: investigation.headline?.text,
    verdict: investigation.headline?.verdict,
    drivers: (investigation.drivers ?? []).slice(0, 10).map((driver) => ({
      path: (driver.path ?? []).map((step) => `${step.dimension?.label ?? 'dimension'}: ${step.member?.label ?? ''}`).join(' › '),
      prior: driver.prior?.value,
      current: driver.current?.value,
      share: driver.share,
      verdict: driver.verdict,
    })),
    ruledOut: (investigation.ruledOut ?? []).map((entry) => entry.dimension?.label).filter(Boolean),
    notInvestigated: (investigation.notInvestigated ?? []).map((entry) => ({ dimension: entry.dimension?.label, reason: entry.reason })),
    caveats: (investigation.caveats ?? []).map((caveat) => caveat.text).filter(Boolean),
    confidence: investigation.confidence,
  };
}

function mapRun(run: AgentRunLike) {
  if (modelUnavailable(run)) {
    return {
      ok: false as const,
      modelUnavailable: true as const,
      question: run.question,
      status: run.status,
      trustState: run.trustState,
      error: `ZLens has no AI model set up, so answer_question could not answer. ${MODEL_UNAVAILABLE_NEXT_STEP}`,
    };
  }
  const primary = (run.artifacts ?? [])[0];
  const p = (primary?.kind === 'answer' ? primary.payload : undefined) as AgentAnswerPayload | undefined;
  const investigation = investigationSummary(run);
  return {
    ok: true as const,
    question: run.question,
    route: run.route,
    status: run.status,
    // Canonical trust — report VERBATIM. Generated answers are review-required,
    // semantic answers governed, and neither is certified.
    trustState: run.trustState,
    // The same words the Ask page shows: governed → From Metrics.
    trustLabelInfo: resolveTrustLabel(trustLabelIdForStatus(run.trustState)),
    answerKind: run.answerKind,
    answer: run.answer ?? run.summary,
    summary: run.summary,
    ...(p
      ? {
          sql: p.proposedSql ?? p.sql,
          result: p.result,
          rowCount: p.result?.rowCount,
          dqlArtifact: p.dqlArtifact,
          draftBlockPath: run.reviewDraft?.path ?? p.draftBlockId ?? p.draftBlock?.path,
          promote: p.promoteCommand ?? (run.reviewDraft?.path ? `zlens certify --from-draft ${run.reviewDraft.path} --owner <you>` : undefined),
          citations: p.citations,
          validationWarnings: p.validationWarnings,
          executionError: p.executionError,
        }
      : {}),
    artifacts: run.artifacts,
    nextActions: run.nextActions,
    // The context ledger (CTX-010): envelope, what was admitted, rendered,
    // selected, enforced and used — ids and counts, never rows.
    ...(run.diagnosticReceiptV9?.context ? { context: run.diagnosticReceiptV9.context } : {}),
    ...(investigation ? { investigation } : {}),
    ...(run.reviewDraft ? { reviewDraft: run.reviewDraft } : {}),
    trustNote:
      'Report trustState verbatim and never upgrade it. A governed answer is built from semantic metrics and dimensions; a review-required answer must be reviewed before it is trusted. Neither is certified.',
  };
}

export async function answerQuestion(
  ctx: DQLContext,
  args: {
    question: string;
    audience?: 'analyst' | 'stakeholder';
    requestedMode?: 'auto' | 'ask' | 'research';
    reasoningEffort?: 'low' | 'medium' | 'high';
    analysisDepth?: 'quick' | 'deep';
    threadId?: string;
    serverUrl?: string;
    domain?: string;
    purpose?: string;
    modelAreaId?: string;
    skillRefs?: string[];
  },
) {
  const question = args.question?.trim();
  if (!question) return { ok: false as const, error: 'Provide a non-empty { question }.' };
  const base = runtimeBase(args.serverUrl);
  // The same four selections the notebook sends (CTX-001); the runtime
  // resolves them into an envelope, this client never does.
  const workspaceContext = workspaceContextForScope(askScopeFromWorkspace(args));
  let response: Response;
  try {
    response = await fetchRuntime(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        requestedMode: args.requestedMode ?? 'auto',
        ...(args.audience ? { audience: args.audience } : {}),
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        ...(args.analysisDepth ? { analysisDepth: args.analysisDepth } : {}),
        ...(args.threadId ? { threadId: args.threadId } : {}),
        ...(Object.keys(workspaceContext).length ? { workspaceContext } : {}),
      }),
    }, 'generate');
  } catch (err) {
    return runtimeUnavailable(base, ctx.projectRoot, err);
  }
  if (!response.ok) {
    return { ok: false as const, error: `ZLens runtime returned ${response.status}: ${await response.text()}` };
  }
  const payload = await readRuntimeJson<{ run?: AgentRunLike; error?: string }>(response, runtimeTimeoutMs('generate')).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as { run?: AgentRunLike; error?: string });
  if (payload.error || !payload.run) return { ok: false as const, error: payload.error ?? 'No run returned by the runtime.' };
  return mapRun(payload.run);
}

/**
 * What POST /api/ai/build returns for a block (dql-agent `BuildBlockResult`):
 * `path`, `name`, `sqlPreview`, `certifierVerdict`, `reflection`, `route`, and
 * `generation` ('offline_template' when no AI model was available). The older
 * `draftBlock` / `dqlArtifact` / `verdict` names are still read for runtimes
 * that sent them.
 */
interface BuildFromPromptResultLike {
  status?: string;
  route?: unknown;
  path?: string;
  name?: string;
  sqlPreview?: string;
  description?: string;
  grain?: string;
  outputs?: string[];
  certifierVerdict?: { blocking?: string[]; warnings?: string[]; ready?: boolean };
  reflection?: { ready?: boolean; remainingBlocking?: string[]; remainingWarnings?: string[]; fixesApplied?: unknown[] };
  edited?: boolean;
  previousSql?: string;
  generation?: 'model' | 'governed_metric' | 'offline_template';
  diagnostics?: { sourceTrust?: string; reviewRequired?: boolean; warnings?: string[] };
  draftBlock?: { path?: string; slug?: string; name?: string; domain?: string; status?: string; askedTimes?: number };
  dqlArtifact?: unknown;
  verdict?: unknown;
  appliedSkills?: unknown[];
  citations?: unknown[];
  sql?: string;
  explanation?: string;
  error?: string;
}

export async function buildBlockFromPrompt(
  ctx: DQLContext,
  args: {
    prompt: string;
    mode?: 'create' | 'edit';
    blockPath?: string;
    owner?: string;
    serverUrl?: string;
  },
) {
  const prompt = args.prompt?.trim();
  if (!prompt) return { ok: false as const, error: 'Provide a non-empty { prompt } describing the block to build.' };
  const mode = args.mode === 'edit' ? 'edit' : 'create';
  if (mode === 'edit' && !args.blockPath?.trim()) {
    return { ok: false as const, error: 'Edit mode requires { blockPath } (the block to modify in place).' };
  }
  const base = runtimeBase(args.serverUrl);
  let response: Response;
  try {
    response = await fetchRuntime(`${base}/api/ai/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        target: 'block',
        mode,
        ...(args.blockPath ? { blockPath: args.blockPath.trim() } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
      }),
    }, 'generate');
  } catch (err) {
    return runtimeUnavailable(base, ctx.projectRoot, err);
  }
  if (!response.ok) {
    return { ok: false as const, error: `ZLens runtime returned ${response.status}: ${await response.text()}` };
  }
  const result = await readRuntimeJson<BuildFromPromptResultLike>(response, runtimeTimeoutMs('generate')).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as BuildFromPromptResultLike);
  if (result.error) return { ok: false as const, error: result.error };
  // Refresh the in-process context so subsequent tool calls see the new draft.
  ctx.refresh();
  const draftBlockPath = result.path ?? result.draftBlock?.path;
  const verdict = result.certifierVerdict ?? result.verdict;
  if (result.generation === 'offline_template') {
    return {
      ok: false as const,
      modelUnavailable: true as const,
      error:
        'ZLens could not build this block from your description (no AI model is set up in ZLens, or the model returned no usable SQL): the workbench saved only a starter template' +
        (draftBlockPath ? ` at ${draftBlockPath} (delete it or replace its SQL)` : '') +
        '. Write the SQL yourself (search_metadata / get_table_schema / validate_sql help), then save it with suggest_block. ' +
        'Or set up an AI provider in the workbench (Settings → AI provider).',
      templateDraftPath: draftBlockPath,
      templateSql: result.sqlPreview,
    };
  }
  return {
    ok: true as const,
    status: result.status,
    route: result.route,
    name: result.name ?? result.draftBlock?.name,
    draftBlockPath,
    ...(result.draftBlock ? { draftBlock: result.draftBlock } : {}),
    sql: result.sqlPreview ?? result.sql,
    description: result.description,
    grain: result.grain,
    outputs: result.outputs,
    ...(result.dqlArtifact ? { dqlArtifact: result.dqlArtifact } : {}),
    verdict,
    reviewRemaining: result.reflection
      ? { blocking: result.reflection.remainingBlocking ?? [], warnings: result.reflection.remainingWarnings ?? [] }
      : undefined,
    ...(result.edited ? { edited: true, previousSql: result.previousSql } : {}),
    appliedSkills: result.appliedSkills,
    citations: result.citations,
    warnings: result.diagnostics?.warnings,
    trustLabel: 'AI-Generated',
    promote: draftBlockPath ? `zlens certify --from-draft ${draftBlockPath}` : undefined,
    trustNote:
      'AI drafts, humans certify. This is a review-required DRAFT — never present it as certified. Review the verdict, then certify explicitly.',
  };
}
