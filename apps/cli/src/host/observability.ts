import { answerIdentities } from './answer-facts.js';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createAskTracePortableBundleV1, toOtlpOpenInferenceJsonV1 } from '@zlens/agent';
import type { DqlPrincipal } from './request-context.js';
import type { DqlRouteAction } from './route-actions.js';

/**
 * WHO DID WHAT, AND HOW EACH ANSWER WAS MADE (RFC 0010, slice HH-6).
 *
 * Audit: with `hostHooks.audit`, the server reports one event for every API
 * request that changes something or was refused (who, what action on what,
 * the outcome) and one for every finished answer (its trust label, the SQL
 * it ran as fingerprints, the sources, the provider). Events carry no result
 * values. With no hook nothing is recorded — central audit is the host's.
 *
 * Traces: each finished Ask trace becomes the same strict, redacted bundle
 * the trace export route serves, and goes to `hostHooks.traces` and/or, as
 * OpenTelemetry (OpenInference spans), to the standard
 * OTEL_EXPORTER_OTLP_ENDPOINT. Export never slows or fails an answer.
 */
export type DqlAuditEvent =
  | {
    kind: 'request';
    at: string;
    requestId?: string;
    actor: string | null;
    principalId: string | null;
    action: string;
    resource: DqlRouteAction['resource'];
    method: string;
    path: string;
    status: number;
    outcome: 'ok' | 'refused' | 'failed';
  }
  | {
    kind: 'answer';
    at: string;
    runId: string;
    actor: string | null;
    principalId: string | null;
    status: string;
    trustState: string;
    /** Why the run stopped (`certified_answer_found`, `blocked`, `needs_clarification`, …), the engine's own code. */
    stopReason?: string;
    /** The route the run resolved to (`certified_answer`, `semantic_answer`, `generated_answer`, `clarify`, `conversation`, …). */
    resolvedRoute?: string;
    /** The Ask tier whose statement ran (`certified`, `semantic`, `relational`, `exploratory`); absent when nothing ran. */
    tier?: string;
    /** On a run that stopped short of an answer: the typed refusal (`no_data`, `ambiguous`, `modeling_gap`, `policy_blocked`, …), never its sentence. */
    answerRefusalCode?: string;
    /** sha256 of each SQL statement the answer's artifacts carry, on a refused answer too when a statement ran before the refusal; never the SQL or its values. */
    sqlSha256: string[];
    sources: string[];
  }
  | {
    /** One model call's token counts, for the person whose request made it; never prompt or reply text. */
    kind: 'model_usage';
    at: string;
    requestId?: string;
    actor: string | null;
    principalId: string | null;
    provider: string;
    model: string | null;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  }
  | {
    /**
     * One knowledge call (HH-15): which source, which page and how it went.
     * Never the question, the search words or document text.
     */
    kind: 'knowledge';
    at: string;
    requestId?: string;
    runId?: string;
    actor: string | null;
    principalId: string | null;
    action: 'search' | 'fetch';
    sourceId: string;
    docId?: string;
    url?: string;
    outcome: 'ok' | 'error' | 'refused';
    resultCount?: number;
  };

export type DqlAuditSink = (event: DqlAuditEvent) => void | Promise<void>;

/** Who is acting, for audit records. */
export function auditActor(principal: DqlPrincipal | null | undefined): string | null {
  if (!principal) return null;
  return principal.email?.trim() || principal.displayName?.trim() || principal.id;
}
export type DqlTraceSink = (trace: { traceId: string; runId: string; bundle: unknown; otlp: Record<string, unknown> }) => void | Promise<void>;

const failed = { audit: 0, traces: 0 };
/** Events a sink failed to take, for health checks. Export never fails the request. */
export function observabilityFailures(): { audit: number; traces: number } {
  return { ...failed };
}

function emit(sink: DqlAuditSink, event: DqlAuditEvent): void {
  try {
    void Promise.resolve(sink(event)).catch(() => { failed.audit += 1; });
  } catch {
    failed.audit += 1;
  }
}

/**
 * Report this request when it finishes, if it changed something or was
 * refused. `who` is read at finish time, after sign-in resolved the person.
 */
export function auditRequest(
  sink: DqlAuditSink,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  route: DqlRouteAction,
  who: () => { principal: DqlPrincipal | null; actor: string | null; requestId?: string },
): void {
  const method = (req.method ?? 'GET').toUpperCase();
  res.once('finish', () => {
    const status = res.statusCode;
    const refused = status === 401 || status === 403;
    if ((method === 'GET' || method === 'HEAD') && !refused) return;
    const { principal, actor, requestId } = who();
    emit(sink, {
      kind: 'request',
      at: new Date().toISOString(),
      ...(requestId ? { requestId } : {}),
      actor,
      principalId: principal?.id ?? null,
      action: route.action,
      resource: route.resource,
      method,
      path,
      status,
      outcome: refused ? 'refused' : status >= 400 ? 'failed' : 'ok',
    });
  });
}

const TERMINAL = new Set(['completed', 'needs_review', 'needs_clarification', 'cancelled', 'blocked']);

type AuditableRun = {
  id?: unknown;
  status?: unknown;
  trustState?: unknown;
  route?: unknown;
  stopReason?: unknown;
  answerRefusalCode?: unknown;
  diagnosticReceiptV9?: { executed?: { tier?: unknown } };
  artifacts?: Array<{ payload?: Record<string, unknown>; sourceId?: unknown; kind?: unknown }>;
};

const code = (value: unknown): string | undefined => (typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined);

/** The answer event for a finished run: codes only — no question text, no SQL, no values, no sentence. */
export function answerAuditEvent(run: AuditableRun, who: { principal: DqlPrincipal | null; actor: string | null }): DqlAuditEvent | null {
  if (typeof run.id !== 'string' || typeof run.status !== 'string' || !TERMINAL.has(run.status)) return null;
  // The same identifiers a host gets with the answer's facts (answer-facts.ts).
  const { sqlSha256, sources } = answerIdentities(run as { artifacts?: unknown[] });
  const stopReason = code(run.stopReason);
  const resolvedRoute = code(run.route);
  const tier = code(run.diagnosticReceiptV9?.executed?.tier);
  // A refusal code belongs to a run that stopped short of an answer; a completed run carries none.
  const answerRefusalCode = run.status === 'completed' ? undefined : code(run.answerRefusalCode);
  return {
    kind: 'answer',
    at: new Date().toISOString(),
    runId: run.id,
    actor: who.actor,
    principalId: who.principal?.id ?? null,
    status: run.status,
    trustState: typeof run.trustState === 'string' ? run.trustState : 'unknown',
    ...(stopReason ? { stopReason } : {}),
    ...(resolvedRoute ? { resolvedRoute } : {}),
    ...(tier ? { tier } : {}),
    ...(answerRefusalCode ? { answerRefusalCode } : {}),
    sqlSha256,
    sources,
  };
}

/** A model call's usage as an audit event, for whoever made the request it belongs to. */
export function modelUsageAuditEvent(
  line: { at: string; provider: string; model?: string; operation: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number },
  who: { principal: DqlPrincipal | null; actor: string | null; requestId?: string },
): DqlAuditEvent {
  return {
    kind: 'model_usage',
    at: line.at,
    ...(who.requestId ? { requestId: who.requestId } : {}),
    actor: who.actor,
    principalId: who.principal?.id ?? null,
    provider: line.provider,
    model: line.model ?? null,
    operation: line.operation,
    inputTokens: line.inputTokens,
    outputTokens: line.outputTokens,
    ...(line.cacheReadTokens ? { cacheReadTokens: line.cacheReadTokens } : {}),
    ...(line.cacheWriteTokens ? { cacheWriteTokens: line.cacheWriteTokens } : {}),
    ...(line.reasoningTokens ? { reasoningTokens: line.reasoningTokens } : {}),
  };
}

/** A knowledge call as an audit event: ids, link and outcome only. */
export function knowledgeAuditEvent(
  activity: { action: 'search' | 'fetch'; sourceId: string; docId?: string; url?: string; outcome: 'ok' | 'error' | 'refused'; resultCount?: number },
  who: { principal: DqlPrincipal | null; actor: string | null; requestId?: string; runId?: string },
): DqlAuditEvent {
  return {
    kind: 'knowledge',
    at: new Date().toISOString(),
    ...(who.requestId ? { requestId: who.requestId } : {}),
    ...(who.runId ? { runId: who.runId } : {}),
    actor: who.actor,
    principalId: who.principal?.id ?? null,
    action: activity.action,
    sourceId: activity.sourceId,
    ...(activity.docId ? { docId: activity.docId } : {}),
    ...(activity.url ? { url: activity.url } : {}),
    outcome: activity.outcome,
    ...(typeof activity.resultCount === 'number' ? { resultCount: activity.resultCount } : {}),
  };
}

/** Report one knowledge call to the host's audit sink; never fails the answer. */
export function auditKnowledge(sink: DqlAuditSink, ...input: Parameters<typeof knowledgeAuditEvent>): void {
  emit(sink, knowledgeAuditEvent(...input));
}

/** Send every model call's usage to the host's audit sink (null removes it). */
export function auditModelUsage(sink: DqlAuditSink | null, setListener: (listener: ((line: Parameters<typeof modelUsageAuditEvent>[0]) => void) | null) => void, who: () => { principal: DqlPrincipal | null; actor: string | null; requestId?: string }): void {
  setListener(sink ? (line) => emit(sink, modelUsageAuditEvent(line, who())) : null);
}

/** A run store that also reports each run once, when it first finishes. */
export function withAnswerAudit<T extends { save(run: never): unknown }>(store: T, sink: DqlAuditSink, who: () => { principal: DqlPrincipal | null; actor: string | null }): T {
  const reported = new Set<string>();
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'save' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (run: AuditableRun) => {
        const result = (value as (run: unknown) => unknown).call(target, run);
        const event = answerAuditEvent(run, who());
        if (event?.kind === 'answer' && !reported.has(event.runId)) {
          reported.add(event.runId);
          emit(sink, event);
        }
        return result;
      };
    },
  });
}

/** POST one OTLP/JSON traces payload to a collector (OpenTelemetry's HTTP/JSON protocol). */
export async function postOtlpTraces(endpoint: string, payload: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const base = endpoint.replace(/\/$/, '');
  const url = /\/v1\/traces$/.test(base) ? base : `${base}/v1/traces`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`OTLP collector answered ${response.status}`);
}

/** `OTEL_EXPORTER_OTLP_HEADERS` (k=v,k2=v2), as OpenTelemetry defines it. */
export function otlpHeadersFromEnv(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return out;
}

type TraceStoreLike = {
  finalize(envelope: { traceId: string; runId: string }): unknown;
  get(traceId: string): Parameters<typeof createAskTracePortableBundleV1>[0] | undefined;
};

/**
 * QUESTION FINGERPRINTS LEAVE KEYED. A trace keeps `sha256(question)` to tell
 * the same question apart from others on this install. Sent to a host's sink
 * or an OpenTelemetry collector, that hash could be checked against a list of
 * likely questions anywhere, so it leaves as HMAC-SHA256 under this install's
 * own key: the same question still keys the same way here, and nowhere else.
 */
export function keyQuestionFingerprints<T>(trace: T, key: string): T {
  const keyed = (value: string) => `sha256:${createHmac('sha256', key).update(value).digest('hex')}`;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(record)) {
      // The question's own fingerprint, and the stage span that carries it.
      if (typeof entry === 'string' && (name === 'questionFingerprint' || (name === 'fingerprint' && record.kind === 'stage'))) out[name] = keyed(entry);
      else out[name] = walk(entry);
    }
    return out;
  };
  return walk(trace) as T;
}

/**
 * The key question fingerprints leave under: the host's (`traceSalt`, stable
 * for its workspace), or one ZLens makes once and keeps in the project's private
 * folder (`.dql/local/private/trace-salt`), never in git.
 */
export function traceQuestionKey(projectRoot: string, hostSalt?: unknown): string {
  if (typeof hostSalt === 'string' && hostSalt.trim()) return hostSalt;
  // A host's key that is not a text is not used (and never written anywhere); DQL keys with its own instead.
  if (hostSalt !== undefined) console.warn('[zlens] The host\'s traceSalt is not a non-empty text; question fingerprints are keyed with this project\'s own key.');
  const folder = join(projectRoot, '.dql', 'local', 'private');
  const file = join(folder, 'trace-salt');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  }
  mkdirSync(folder, { recursive: true });
  const made = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, `${made}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    // Another process made it first: use theirs.
    const saved = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
    writeFileSync(file, `${made}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  try { chmodSync(file, 0o600); } catch { /* best effort on file systems without modes */ }
  return made;
}

/**
 * A trace store that also exports each finished trace — strictly redacted —
 * to the host's sink and/or an OTLP collector, after the local write. With
 * `questionKey`, question fingerprints leave keyed (`keyQuestionFingerprints`).
 */
export function withTraceExport<T extends TraceStoreLike>(store: T, targets: { sink?: DqlTraceSink; otlpEndpoint?: string; otlpHeaders?: Record<string, string>; questionKey?: () => string }): T {
  if (!targets.sink && !targets.otlpEndpoint) return store;
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'finalize' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (envelope: { traceId: string; runId: string }) => {
        const result = (value as (envelope: unknown) => unknown).call(target, envelope);
        queueMicrotask(() => {
          void (async () => {
            try {
              const stored = target.get(envelope.traceId);
              if (!stored) return;
              const trace = targets.questionKey ? keyQuestionFingerprints(stored, targets.questionKey()) : stored;
              const bundle = createAskTracePortableBundleV1(trace, { profile: 'strict', provenance: 'recorded' } as Parameters<typeof createAskTracePortableBundleV1>[1]);
              const otlp = toOtlpOpenInferenceJsonV1(bundle.trace);
              if (targets.sink) await targets.sink({ traceId: envelope.traceId, runId: envelope.runId, bundle, otlp });
              if (targets.otlpEndpoint) await postOtlpTraces(targets.otlpEndpoint, otlp, targets.otlpHeaders);
            } catch {
              failed.traces += 1;
            }
          })();
        });
        return result;
      };
    },
  });
}
