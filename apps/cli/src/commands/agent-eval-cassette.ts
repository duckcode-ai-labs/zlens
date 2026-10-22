/**
 * Provider cassettes — record a suite once against a real model, replay it
 * offline forever. A deliberately-labelled deterministic migration can keep a
 * legacy response usable for orchestration replay, but it is never evidence of
 * current provider quality.
 *
 * A provider-backed eval is the only kind that measures the product users get:
 * without one, `mayAssumeInterpretation` is false and every ambiguous question
 * clarifies by design (AGT-017), which makes a clarification rate an artifact.
 * But calling a real model on every PR is slow, costly, and non-deterministic —
 * so the suite could never gate anything.
 *
 * Recording once and replaying fixes all three. Model drift then shows up as a
 * reviewable diff when cassettes are re-recorded, instead of as a mystery
 * regression on an unrelated pull request.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentMessage,
  AgentProvider,
  AgentToolDefinition,
  ProviderRunOptions,
  ProviderToolLoopOptions,
} from '@zlens/agent';
import { readEnv } from '@zlens/core';

export type CassetteMode = 'record' | 'replay' | 'live';

/** One recorded tool call, so replay can re-run it against the live tools. */
export interface CassetteToolCall {
  name: string;
  args: unknown;
}

/**
 * How this response entered the cassette store. `providerName` is part of the
 * dispatch fingerprint; it is not itself a claim that the response was
 * recorded from that provider.
 */
export type CassetteProvenance =
  | {
      kind: 'recorded_provider';
      replayClassification: 'recorded_provider';
      providerQuality: 'eligible';
    }
  | {
      kind: 'migrated_legacy_deterministic_fixture';
      sourceLegacyKey: string;
      replayClassification: 'orchestration_replay_only';
      providerQuality: 'excluded';
    }
  | {
      /**
       * A deliberately authored response over the checked-in sanitized
       * fixture. It exercises replay/orchestration only; it is never presented
       * as a live-provider response or provider-quality evidence.
       */
      kind: 'synthetic_deterministic_orchestration_fixture';
      replayClassification: 'orchestration_replay_only';
      providerQuality: 'excluded';
      createdAt: string;
      creationMethod: 'sanitized_fixture_sql';
      source: 'current_scoped_runtime_dispatch';
    };

export interface CassetteEntry {
  key: string;
  operation: 'generate' | 'generate_with_tools';
  /**
   * Legacy timestamp for a response recorded from a provider or imported from
   * an older cassette. Synthetic fixtures use `createdAt` instead so they do
   * not imply a live provider recording.
   */
  recordedAt?: string;
  /** Creation timestamp for an explicitly synthetic deterministic fixture. */
  createdAt?: string;
  providerName: string;
  /** The model's final text. */
  text: string;
  /** Tool calls the model made, in order (generate_with_tools only). */
  toolCalls?: CassetteToolCall[];
  /**
   * Provenance is additive so historical entries remain readable. Entries
   * without it are deliberately excluded from real-provider quality claims.
   */
  provenance?: CassetteProvenance;
  /**
   * V2 stores only hashes and structural dispatch facts. It never stores a
   * prompt, credentials, or retrieved business context beyond the model text
   * that a cassette has always intentionally contained.
   */
  fingerprintDiagnostics?: CassetteFingerprintDiagnosticsV2;
}

/** Eval-only canonicalization. Production dispatches never opt into this. */
export interface EvalCassetteCanonicalizationV2 {
  version: 2;
  /** Exact absolute project-root prefix supplied by the eval host. */
  projectRoot: string;
}

export interface CassetteFingerprintDiagnosticsV2 {
  version: 2;
  messageCount: number;
  messageRoles: AgentMessage['role'][];
  preCanonicalHash: string;
  postCanonicalHash: string;
  appliedRuleClasses: string[];
}

export interface CassetteFingerprint {
  key: string;
  /** Exact legacy full-prompt hash, retained only for safe v1 replay migration. */
  legacyKey?: string;
  diagnostics?: CassetteFingerprintDiagnosticsV2;
}

/**
 * What a cassette directory can support in an eval report. A migrated or
 * historical-unknown entry still supports deterministic orchestration replay;
 * neither is allowed to stand in for a current provider-quality measurement.
 */
export interface CassetteEvidenceSummary {
  totalEntries: number;
  recordedProviderEntries: number;
  migratedLegacyDeterministicFixtureEntries: number;
  syntheticDeterministicOrchestrationFixtureEntries: number;
  unknownProvenanceEntries: number;
  orchestrationReplayEligible: boolean;
  realProviderQualityEligible: boolean;
  realProviderQualityExclusionReasons: string[];
}

const EVAL_ORCHESTRATION_TRANSIENT_LABELS = [
  'context_pack_id',
  'run_id',
  'snapshot_id',
  'plan_id',
  'reference_instant',
  'generated_at',
  'retrieved_at',
] as const;

const EVAL_ORCHESTRATION_TRANSIENT_LABEL_PATTERN = EVAL_ORCHESTRATION_TRANSIENT_LABELS.join('|');

/**
 * This is intentionally not a general UUID/date/path scrubber. The provider
 * still sees and the fingerprint still binds every business date, user term,
 * relation, column, qualified ID, join, lineage edge, SQL fragment, role, and
 * option. Only producer-labelled orchestration values and the explicitly
 * supplied eval project root are non-semantic enough to normalize.
 */
function canonicalizeEvalMessageContentV2(content: string, projectRoot: string): {
  content: string;
  appliedRuleClasses: string[];
} {
  const applied = new Set<string>();
  const replacePlainLabel = (_whole: string, prefix: string, label: string): string => {
    applied.add(`producer_label:${label.toLowerCase()}`);
    return `${prefix}<ORCHESTRATION_TRANSIENT>`;
  };
  const replaceJsonLabel = (_whole: string, prefix: string, label: string, suffix: string): string => {
    applied.add(`producer_label:${label.toLowerCase()}`);
    return `${prefix}"<ORCHESTRATION_TRANSIENT>"${suffix}`;
  };
  let normalized = content
    .replace(
      new RegExp(`^(\\s*)((?:${EVAL_ORCHESTRATION_TRANSIENT_LABEL_PATTERN}))\\s*:\\s*[^\\r\\n]*$`, 'gim'),
      (_whole, indent: string, label: string) => replacePlainLabel(_whole, `${indent}${label}: `, label),
    )
    .replace(
      new RegExp(`^(\\s*"((?:${EVAL_ORCHESTRATION_TRANSIENT_LABEL_PATTERN}))"\\s*:\\s*)"[^"\\r\\n]*"(\\s*,?\\s*)$`, 'gim'),
      (_whole, prefix: string, label: string, suffix: string) => replaceJsonLabel(_whole, prefix, label, suffix),
    );
  if (projectRoot && normalized.includes(projectRoot)) {
    normalized = normalized.split(projectRoot).join('<PROJECT_ROOT>');
    applied.add('project_root');
  }
  return { content: normalized, appliedRuleClasses: Array.from(applied).sort() };
}

export function evalCassetteCanonicalizationV2(projectRoot: string): EvalCassetteCanonicalizationV2 {
  return { version: 2, projectRoot };
}

function hashDispatch(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalDispatch(input: {
  providerName: string;
  operation: CassetteEntry['operation'];
  messages: AgentMessage[];
  toolNames?: string[];
  options?: { reasoningEffort?: unknown; maxTokens?: unknown; temperature?: unknown } | undefined;
}, messages: AgentMessage[], version?: 2): Record<string, unknown> {
  return {
    ...(version ? { v: version } : {}),
    p: input.providerName,
    o: input.operation,
    m: messages.map((message) => ({ r: message.role, c: message.content })),
    // V1 intentionally treated a tool-set reorder as equivalent. V2 is
    // narrower: canonicalization must not rewrite provider/tool dispatch
    // semantics, including tool order.
    t: version ? [...(input.toolNames ?? [])] : [...(input.toolNames ?? [])].sort(),
    e: input.options?.reasoningEffort ?? null,
    x: input.options?.maxTokens ?? null,
    z: input.options?.temperature ?? null,
  };
}

/**
 * Stable key for one provider dispatch.
 *
 * Deliberately includes the full message list: the prompt IS the input, and two
 * turns that differ only in retrieved context are genuinely different calls.
 * Tool NAMES are included but not their schemas — a description edit should not
 * invalidate every cassette in the suite.
 */
export function cassetteFingerprint(input: {
  providerName: string;
  operation: CassetteEntry['operation'];
  messages: AgentMessage[];
  toolNames?: string[];
  options?: { reasoningEffort?: unknown; maxTokens?: unknown; temperature?: unknown } | undefined;
  canonicalization?: EvalCassetteCanonicalizationV2;
}): CassetteFingerprint {
  const legacyHash = hashDispatch(canonicalDispatch(input, input.messages));
  if (!input.canonicalization) return { key: legacyHash.slice(0, 32) };

  const applied = new Set<string>();
  const messages = input.messages.map((message) => {
    // A user may literally ask about an ID, date, or local path. Only
    // producer-owned messages can contain the labelled orchestration fields
    // that this eval-only canonicalizer is permitted to normalize.
    if (message.role === 'user') return message;
    const normalized = canonicalizeEvalMessageContentV2(message.content, input.canonicalization!.projectRoot);
    for (const rule of normalized.appliedRuleClasses) applied.add(rule);
    return { ...message, content: normalized.content };
  });
  const postHash = hashDispatch(canonicalDispatch(input, messages, 2));
  return {
    key: postHash.slice(0, 32),
    legacyKey: legacyHash.slice(0, 32),
    diagnostics: {
      version: 2,
      messageCount: input.messages.length,
      messageRoles: input.messages.map((message) => message.role),
      preCanonicalHash: hashDispatch(canonicalDispatch(input, input.messages, 2)),
      postCanonicalHash: postHash,
      appliedRuleClasses: Array.from(applied).sort(),
    },
  };
}

export function cassetteKey(input: Parameters<typeof cassetteFingerprint>[0]): string {
  return cassetteFingerprint(input).key;
}

export class CassetteStore {
  private readonly dir: string;
  private readonly loaded = new Map<string, CassetteEntry>();

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as CassetteEntry;
        if (entry?.key) this.loaded.set(entry.key, entry);
      } catch {
        // A corrupt cassette is skipped, not fatal: it re-records on the next
        // --record run, and a replay miss reports the key that is missing.
      }
    }
  }

  get(key: string): CassetteEntry | undefined {
    return this.loaded.get(key);
  }

  put(entry: CassetteEntry): void {
    this.loaded.set(entry.key, entry);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${entry.key}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  }

  size(): number {
    return this.loaded.size;
  }

  entries(): CassetteEntry[] {
    return Array.from(this.loaded.values()).sort((left, right) => left.key.localeCompare(right.key));
  }

  /**
   * A replay-only runtime with no configured provider still needs the identity
   * that was used to derive cassette keys. Keep that identity in the cassette
   * store rather than guessing a provider from user settings.
   */
  providerNames(): string[] {
    return Array.from(new Set(
      Array.from(this.loaded.values())
        .map((entry) => entry.providerName.trim())
        .filter(Boolean),
    )).sort();
  }
}

export function cassetteEvidenceSummary(store: CassetteStore): CassetteEvidenceSummary {
  const entries = store.entries();
  const recordedProviderEntries = entries.filter((entry) => entry.provenance?.kind === 'recorded_provider').length;
  const migratedLegacyDeterministicFixtureEntries = entries.filter(
    (entry) => entry.provenance?.kind === 'migrated_legacy_deterministic_fixture',
  ).length;
  const syntheticDeterministicOrchestrationFixtureEntries = entries.filter(
    (entry) => entry.provenance?.kind === 'synthetic_deterministic_orchestration_fixture',
  ).length;
  const unknownProvenanceEntries = entries.length
    - recordedProviderEntries
    - migratedLegacyDeterministicFixtureEntries
    - syntheticDeterministicOrchestrationFixtureEntries;
  const realProviderQualityExclusionReasons = [
    ...(migratedLegacyDeterministicFixtureEntries > 0 ? ['migrated_legacy_deterministic_fixture'] : []),
    ...(syntheticDeterministicOrchestrationFixtureEntries > 0 ? ['synthetic_deterministic_orchestration_fixture'] : []),
    ...(unknownProvenanceEntries > 0 ? ['unknown_cassette_provenance'] : []),
    ...(entries.length === 0 ? ['no_cassette_entries'] : []),
  ];
  return {
    totalEntries: entries.length,
    recordedProviderEntries,
    migratedLegacyDeterministicFixtureEntries,
    syntheticDeterministicOrchestrationFixtureEntries,
    unknownProvenanceEntries,
    orchestrationReplayEligible: entries.length > 0,
    realProviderQualityEligible: realProviderQualityExclusionReasons.length === 0,
    realProviderQualityExclusionReasons,
  };
}

/**
 * The report's provenance line. The summary classifies how the entries were
 * recorded; it cannot say this run reached a provider. In replay mode every
 * dispatch is answered from the cassette (a miss fails, never goes live), so
 * the run carries no real-provider quality evidence of its own.
 */
export function cassetteEvidenceLine(summary: CassetteEvidenceSummary, mode: CassetteMode): string {
  if (!summary.realProviderQualityEligible) {
    return `Real-provider quality evidence: excluded (${summary.realProviderQualityExclusionReasons.join(', ')}).`;
  }
  if (mode === 'replay') {
    return 'Real-provider quality evidence: none from this run — every provider call was replayed from '
      + `${summary.recordedProviderEntries} recorded response(s); no provider was called.`;
  }
  return 'Real-provider quality evidence: eligible.';
}

export class CassetteMissError extends Error {
  readonly key: string;
  readonly fingerprintDiagnostics?: CassetteFingerprintDiagnosticsV2;
  constructor(key: string, operation: string, fingerprintDiagnostics?: CassetteFingerprintDiagnosticsV2) {
    const safeDiagnostics = fingerprintDiagnostics
      ? ` Safe V2 dispatch facts: messages=${fingerprintDiagnostics.messageCount}; roles=${fingerprintDiagnostics.messageRoles.join(',')}; pre=${fingerprintDiagnostics.preCanonicalHash}; post=${fingerprintDiagnostics.postCanonicalHash}; rules=${fingerprintDiagnostics.appliedRuleClasses.join(',') || 'none'}.`
      : '';
    super(
      `No cassette for ${operation} (${key}). CI replays recorded provider responses and never calls a live model; `
      + 're-record with --record against a real provider and commit the new cassettes.'
      + safeDiagnostics,
    );
    this.name = 'CassetteMissError';
    this.key = key;
    this.fingerprintDiagnostics = fingerprintDiagnostics;
  }
}

/**
 * Wrap a provider so its dispatches are recorded or replayed.
 *
 * On replay of a tool loop the recorded tool calls are RE-INVOKED against the
 * live tools rather than stubbed. The model's choices stay frozen (that is the
 * point), but compilation, validation, and execution still really happen — so
 * the suite keeps catching a broken compiler or a wrong number, which a fully
 * stubbed replay would sail straight past.
 */
export function withCassette(
  provider: AgentProvider,
  store: CassetteStore,
  mode: CassetteMode,
  canonicalization?: EvalCassetteCanonicalizationV2,
): AgentProvider {
  if (mode === 'live') return provider;

  const wrapped: AgentProvider = {
    name: provider.name,
    available: () => (mode === 'replay' ? Promise.resolve(true) : provider.available()),

    async generate(messages: AgentMessage[], options?: ProviderRunOptions): Promise<string> {
      const fingerprint = cassetteFingerprint({ providerName: provider.name, operation: 'generate', messages, options, canonicalization });
      // V2 dispatch identity is deliberately exact. A V1 key can describe a
      // different full runtime envelope (for example, direct runner versus
      // runtime runner); silently falling back would replay a response for the
      // wrong prompt. Migrations must create an explicitly labelled V2 entry.
      const hit = store.get(fingerprint.key);
      if (hit) return hit.text;
      if (mode === 'replay') throw new CassetteMissError(fingerprint.key, 'generate', fingerprint.diagnostics);
      const text = await provider.generate(messages, options);
      store.put({
        key: fingerprint.key, operation: 'generate', text,
        providerName: provider.name, recordedAt: new Date().toISOString(),
        provenance: {
          kind: 'recorded_provider',
          replayClassification: 'recorded_provider',
          providerQuality: 'eligible',
        },
        ...(fingerprint.diagnostics ? { fingerprintDiagnostics: fingerprint.diagnostics } : {}),
      });
      return text;
    },
  };

  // Readiness remains provider-owned.  The generic AgentProvider interface is
  // deliberately boolean-only, but subscription adapters may expose a
  // redacted typed cause after `available() === false`.  Preserve that optional
  // server-side hook in record/replay wrappers so preflight does not degrade a
  // real OAuth/CLI failure into an untyped configuration gap.
  const readinessProvider = provider as AgentProvider & { getReadinessFailure?: () => Error | undefined };
  if (readinessProvider.getReadinessFailure) {
    (wrapped as AgentProvider & { getReadinessFailure?: () => Error | undefined }).getReadinessFailure =
      () => readinessProvider.getReadinessFailure?.();
  }

  if (provider.generateWithTools) {
    wrapped.generateWithTools = async (
      messages: AgentMessage[],
      tools: AgentToolDefinition[],
      options?: ProviderToolLoopOptions,
    ): Promise<import('@zlens/agent').NativeToolLoopResult> => {
      const fingerprint = cassetteFingerprint({
        providerName: provider.name,
        operation: 'generate_with_tools',
        messages,
        toolNames: tools.map((tool) => tool.name),
        options: options as { reasoningEffort?: unknown } | undefined,
        canonicalization,
      });
      // See `generate`: never alias a V2 tool-loop dispatch to a legacy key.
      const hit = store.get(fingerprint.key);
      if (hit) {
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        for (const call of hit.toolCalls ?? []) {
          const tool = byName.get(call.name);
          // A cassette recorded against a tool set that no longer has this tool
          // is stale in a way the run should surface, not paper over.
          if (!tool) continue;
          await tool.run(call.args).catch(() => undefined);
        }
        return hit.text;
      }
      if (mode === 'replay') throw new CassetteMissError(fingerprint.key, 'generate_with_tools', fingerprint.diagnostics);
      const observed: CassetteToolCall[] = [];
      const recordingTools = tools.map((tool) => ({
        ...tool,
        run: async (args: unknown) => {
          observed.push({ name: tool.name, args });
          return tool.run(args);
        },
      }));
      const text = await provider.generateWithTools!(messages, recordingTools, options);
      // A native V2 controller budget stop is not provider prose and must
      // remain typed through the live lane. Do not serialize it as a normal
      // cassette completion (which would erase the terminal cause on replay).
      if (typeof text !== 'string') return text;
      store.put({
        key: fingerprint.key, operation: 'generate_with_tools', text, toolCalls: observed,
        providerName: provider.name, recordedAt: new Date().toISOString(),
        provenance: {
          kind: 'recorded_provider',
          replayClassification: 'recorded_provider',
          providerQuality: 'eligible',
        },
        ...(fingerprint.diagnostics ? { fingerprintDiagnostics: fingerprint.diagnostics } : {}),
      });
      return text;
    };
  }

  return wrapped;
}

/**
 * Pick the cassette mode from the environment.
 *
 * Defaults to `replay` for ANY value that is not explicitly `record` or `live`,
 * including a missing or misspelled one. If someone sets the cassette directory
 * in CI and forgets the mode, the safe outcome is "never call a live model",
 * not a surprise bill and a non-deterministic suite.
 */
export function resolveCassetteModeFromEnv(env: Record<string, string | undefined>): CassetteMode {
  const raw = readEnv('ZLENS_EVAL_CASSETTE_MODE', env);
  return raw === 'record' || raw === 'live' ? raw : 'replay';
}

/** Where a project's eval cassettes live. */
export function cassetteDirFor(projectRoot: string, suiteName: string): string {
  const safe = suiteName.replace(/[^a-z0-9._-]+/gi, '-').replace(/\.(ya?ml)$/i, '');
  return join(projectRoot, 'test-cassettes', safe);
}

export { dirname as _dirname };
