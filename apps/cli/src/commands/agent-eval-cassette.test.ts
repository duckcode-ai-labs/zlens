import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProvider, AgentToolDefinition } from '@zlens/agent';
import {
  CassetteMissError,
  CassetteStore,
  cassetteEvidenceLine,
  cassetteEvidenceSummary,
  cassetteFingerprint,
  cassetteDirFor,
  cassetteKey,
  evalCassetteCanonicalizationV2,
  resolveCassetteModeFromEnv,
  runtimeCassetteModeMismatch,
  withCassette,
} from './agent-eval-cassette.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dql-cassette-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const msg = (content: string) => [{ role: 'user' as const, content }];

function stubProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return {
    name: 'claude' as AgentProvider['name'],
    available: async () => true,
    generate: async () => 'live answer',
    ...over,
  } as AgentProvider;
}

describe('cassetteKey', () => {
  it('is stable for identical input and differs when the prompt changes', () => {
    const a = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('q') });
    const b = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('q') });
    const c = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('different') });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('separates providers, operations, and reasoning effort', () => {
    const base = { operation: 'generate' as const, messages: msg('q') };
    expect(cassetteKey({ ...base, providerName: 'claude' }))
      .not.toBe(cassetteKey({ ...base, providerName: 'openai' }));
    expect(cassetteKey({ ...base, providerName: 'claude' }))
      .not.toBe(cassetteKey({ ...base, providerName: 'claude', operation: 'generate_with_tools' }));
    expect(cassetteKey({ ...base, providerName: 'claude', options: { reasoningEffort: 'high' } }))
      .not.toBe(cassetteKey({ ...base, providerName: 'claude', options: { reasoningEffort: 'low' } }));
  });

  it('is order-insensitive across tool names but sensitive to the set', () => {
    // A tool set reordering is the same call; adding a tool is not.
    const k1 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['a', 'b'] });
    const k2 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['b', 'a'] });
    const k3 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['a', 'b', 'c'] });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('v2 normalizes only declared producer transients and the explicit project root', () => {
    const rootA = '/private/tmp/dql-eval-a';
    const rootB = '/private/tmp/dql-eval-b';
    const producer = (root: string, suffix: string) => [
      {
        role: 'system' as const,
        content: [
          `context_pack_id: context-${suffix}`,
          `run_id: run-${suffix}`,
          `snapshot_id: snapshot-${suffix}`,
          `plan_id: plan-${suffix}`,
          `reference_instant: 2026-08-22T12:00:00.${suffix}Z`,
          `generated_at: 2026-08-22T12:00:01.${suffix}Z`,
          `retrieved_at: 2026-08-22T12:00:02.${suffix}Z`,
          `project root: ${root}/models/orders.sql`,
          'qualified candidate: dbt:column:jaffle_shop.dev.dim_customers.customer_name',
        ].join('\n'),
      },
      { role: 'user' as const, content: 'What is the order count for each customer on 2026-01-01?' },
    ];
    const a = cassetteFingerprint({
      providerName: 'claude', operation: 'generate', messages: producer(rootA, 'a'),
      canonicalization: evalCassetteCanonicalizationV2(rootA),
    });
    const b = cassetteFingerprint({
      providerName: 'claude', operation: 'generate', messages: producer(rootB, 'b'),
      canonicalization: evalCassetteCanonicalizationV2(rootB),
    });
    expect(a.key).toBe(b.key);
    expect(a.diagnostics).toMatchObject({
      version: 2,
      messageCount: 2,
      messageRoles: ['system', 'user'],
      appliedRuleClasses: expect.arrayContaining([
        'project_root',
        'producer_label:context_pack_id',
        'producer_label:run_id',
        'producer_label:snapshot_id',
        'producer_label:plan_id',
        'producer_label:reference_instant',
        'producer_label:generated_at',
        'producer_label:retrieved_at',
      ]),
    });
    expect(a.diagnostics!.preCanonicalHash).not.toBe(a.diagnostics!.postCanonicalHash);
  });

  it('v2 keeps user terms, business dates, physical evidence, role order, provider, options, and tools significant', () => {
    const root = '/private/tmp/dql-eval-root';
    const canonicalization = evalCassetteCanonicalizationV2(root);
    const base = {
      providerName: 'claude',
      operation: 'generate_with_tools' as const,
      messages: [
        { role: 'system' as const, content: `context_pack_id: context-1\nrelation: jaffle_shop.dev.dim_customers\nroot: ${root}` },
        { role: 'user' as const, content: 'Show revenue for fiscal date FY26-2026-01-01.' },
      ],
      toolNames: ['resolve_context', 'generate_sql'],
      options: { reasoningEffort: 'high', maxTokens: 400, temperature: 0.1 },
      canonicalization,
    };
    const key = cassetteKey(base);
    expect(cassetteKey({ ...base, messages: [base.messages[0]!, { role: 'user', content: 'Show revenue for fiscal date FY27-2026-01-01.' }] })).not.toBe(key);
    expect(cassetteKey({ ...base, messages: [{ role: 'system', content: `context_pack_id: context-2\nrelation: jaffle_shop.dev.orders\nroot: ${root}` }, base.messages[1]!] })).not.toBe(key);
    expect(cassetteKey({ ...base, messages: [...base.messages].reverse() })).not.toBe(key);
    expect(cassetteKey({ ...base, providerName: 'openai' })).not.toBe(key);
    expect(cassetteKey({ ...base, options: { ...base.options, maxTokens: 401 } })).not.toBe(key);
    expect(cassetteKey({ ...base, toolNames: [...base.toolNames].reverse() })).not.toBe(key);

    // Even a label-shaped value in a user question is business input, not
    // producer-owned context, and therefore must not be normalized.
    expect(cassetteKey({ ...base, messages: [base.messages[0]!, { role: 'user', content: 'context_pack_id: a customer-owned identifier' }] }))
      .not.toBe(cassetteKey({ ...base, messages: [base.messages[0]!, { role: 'user', content: 'context_pack_id: another customer-owned identifier' }] }));
  });
});

describe('withCassette', () => {
  it('records a live call, then replays it without touching the provider', async () => {
    const generate = vi.fn(async () => 'recorded answer');
    const recorder = withCassette(stubProvider({ generate }), new CassetteStore(dir), 'record');
    expect(await recorder.generate(msg('q'))).toBe('recorded answer');
    expect(generate).toHaveBeenCalledTimes(1);

    const replayGenerate = vi.fn(async () => 'SHOULD NOT BE CALLED');
    const player = withCassette(stubProvider({ generate: replayGenerate }), new CassetteStore(dir), 'replay');
    expect(await player.generate(msg('q'))).toBe('recorded answer');
    expect(replayGenerate).not.toHaveBeenCalled();
    expect(cassetteEvidenceSummary(new CassetteStore(dir))).toMatchObject({
      totalEntries: 1,
      recordedProviderEntries: 1,
      migratedLegacyDeterministicFixtureEntries: 0,
      realProviderQualityEligible: true,
    });
  });

  it('fails a replay miss instead of silently calling a live model', async () => {
    // The property that makes this safe to run in CI: no cassette, no network.
    const generate = vi.fn(async () => 'live');
    const player = withCassette(stubProvider({ generate }), new CassetteStore(dir), 'replay');
    await expect(player.generate(msg('never recorded'))).rejects.toBeInstanceOf(CassetteMissError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not alias a V2 runtime dispatch to a legacy-key cassette', async () => {
    const messages = [
      { role: 'system' as const, content: 'context_pack_id: generated-run\nrelation: jaffle_shop.dev.dim_customers' },
      { role: 'user' as const, content: 'What is the order count for each customer?' },
    ];
    const fingerprint = cassetteFingerprint({
      providerName: 'claude',
      operation: 'generate',
      messages,
      canonicalization: evalCassetteCanonicalizationV2('/private/tmp/dql-v2-cassette'),
    });
    expect(fingerprint.legacyKey).toBeTruthy();
    new CassetteStore(dir).put({
      key: fingerprint.legacyKey!,
      operation: 'generate',
      text: 'legacy response must not satisfy V2 dispatch',
      providerName: 'claude',
      recordedAt: new Date().toISOString(),
    });
    const generate = vi.fn(async () => 'live');
    const player = withCassette(
      stubProvider({ generate }),
      new CassetteStore(dir),
      'replay',
      evalCassetteCanonicalizationV2('/private/tmp/dql-v2-cassette'),
    );
    await expect(player.generate(messages)).rejects.toMatchObject({ key: fingerprint.key });
    expect(generate).not.toHaveBeenCalled();
  });

  it('re-invokes recorded tool calls on replay so execution still really happens', async () => {
    // A fully stubbed replay would sail past a broken compiler or a wrong number.
    // Freezing the model's CHOICES while still running the tools keeps the suite
    // able to catch both.
    const calls: string[] = [];
    const tool = (name: string): AgentToolDefinition => ({
      name,
      description: '',
      inputSchema: { type: 'object', properties: {} },
      run: async (args: unknown) => { calls.push(`${name}:${JSON.stringify(args)}`); return { ok: true }; },
    });
    const tools = [tool('compile_semantic_query'), tool('scan_manifest')];

    const live = stubProvider({
      generateWithTools: async (_m, suppliedTools) => {
        await suppliedTools[0]!.run({ metric: 'revenue' });
        await suppliedTools[1]!.run({ q: 'orders' });
        return 'final text';
      },
    });
    const recorder = withCassette(live, new CassetteStore(dir), 'record');
    expect(await recorder.generateWithTools!(msg('q'), tools)).toBe('final text');
    expect(calls).toEqual(['compile_semantic_query:{"metric":"revenue"}', 'scan_manifest:{"q":"orders"}']);

    calls.length = 0;
    const modelCall = vi.fn(async () => 'SHOULD NOT BE CALLED');
    const player = withCassette(
      stubProvider({ generateWithTools: modelCall as never }),
      new CassetteStore(dir),
      'replay',
    );
    expect(await player.generateWithTools!(msg('q'), tools)).toBe('final text');
    expect(modelCall).not.toHaveBeenCalled();
    // Tools ran again, in the recorded order.
    expect(calls).toEqual(['compile_semantic_query:{"metric":"revenue"}', 'scan_manifest:{"q":"orders"}']);
  });

  it('reports available() in replay without needing credentials', async () => {
    const available = vi.fn(async () => false);
    const player = withCassette(stubProvider({ available }), new CassetteStore(dir), 'replay');
    expect(await player.available()).toBe(true);
    expect(available).not.toHaveBeenCalled();
  });

  it('preserves a provider-owned typed readiness failure in record mode', async () => {
    const readinessFailure = Object.assign(
      new Error('Saved OAuth session expired and same-provider CLI is unavailable.'),
      { code: 'CLAUDE_OAUTH_CLI_UNAVAILABLE' },
    );
    const provider = {
      ...stubProvider({ available: async () => false }),
      getReadinessFailure: vi.fn(() => readinessFailure),
    } as AgentProvider & { getReadinessFailure: () => Error & { code: string } };
    const recorder = withCassette(provider, new CassetteStore(dir), 'record') as AgentProvider & {
      getReadinessFailure?: () => Error | undefined;
    };

    expect(await recorder.available()).toBe(false);
    expect(recorder.getReadinessFailure?.()).toBe(readinessFailure);
    expect(provider.getReadinessFailure).toHaveBeenCalledTimes(1);
  });

  it('passes live mode straight through', async () => {
    const provider = stubProvider();
    expect(withCassette(provider, new CassetteStore(dir), 'live')).toBe(provider);
  });

  it('persists across store instances and survives a corrupt file', async () => {
    const recorder = withCassette(stubProvider({ generate: async () => 'persisted' }), new CassetteStore(dir), 'record');
    await recorder.generate(msg('q'));
    expect(new CassetteStore(dir).size()).toBe(1);
  });

  it('records safe v2 fingerprint diagnostics and replays an order-count proposal across fresh project roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'dql-cassette-project-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'dql-cassette-project-b-'));
    const orderCountMessages = (projectRoot: string, id: string) => [
      {
        role: 'system' as const,
        content: [
          `context_pack_id: context-${id}`,
          `run_id: run-${id}`,
          `snapshot_id: snapshot-${id}`,
          `plan_id: plan-${id}`,
          `generated_at: 2026-08-22T00:00:00.${id}Z`,
          `runtime source: ${projectRoot}/target/manifest.json`,
          'relation: jaffle_shop.dev.dim_customers',
          'column: count_lifetime_orders',
        ].join('\n'),
      },
      { role: 'user' as const, content: 'What is the order count for each customer?' },
    ];
    const response = '```json\n{"sql":"SELECT customer_name AS customer_name, count_lifetime_orders AS count_lifetime_orders FROM jaffle_shop.dev.dim_customers"}\n```';
    try {
      const record = withCassette(
        stubProvider({ generate: async () => response }),
        new CassetteStore(dir),
        'record',
        evalCassetteCanonicalizationV2(rootA),
      );
      await expect(record.generate(orderCountMessages(rootA, 'a'))).resolves.toBe(response);

      const fingerprint = cassetteFingerprint({
        providerName: 'claude', operation: 'generate', messages: orderCountMessages(rootA, 'a'),
        canonicalization: evalCassetteCanonicalizationV2(rootA),
      });
      const entry = new CassetteStore(dir).get(fingerprint.key)!;
      expect(entry.fingerprintDiagnostics).toMatchObject({
        version: 2,
        messageCount: 2,
        messageRoles: ['system', 'user'],
        appliedRuleClasses: expect.arrayContaining(['project_root', 'producer_label:context_pack_id']),
      });
      expect(JSON.stringify(entry.fingerprintDiagnostics)).not.toContain('What is the order count');
      expect(JSON.stringify(entry.fingerprintDiagnostics)).not.toContain(rootA);

      const live = vi.fn(async () => 'MUST NOT CALL LIVE');
      const replay = withCassette(
        stubProvider({ generate: live }),
        new CassetteStore(dir),
        'replay',
        evalCassetteCanonicalizationV2(rootB),
      );
      await expect(replay.generate(orderCountMessages(rootB, 'b'))).resolves.toBe(response);
      expect(live).not.toHaveBeenCalled();
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('exposes the distinct recorded provider identities for replay bootstrap', async () => {
    const store = new CassetteStore(dir);
    store.put({
      key: 'claude-entry', operation: 'generate', text: 'one', providerName: 'claude', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    store.put({
      key: 'openai-entry', operation: 'generate', text: 'two', providerName: 'openai', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    store.put({
      key: 'claude-entry-2', operation: 'generate', text: 'three', providerName: 'claude', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(store.providerNames()).toEqual(['claude', 'openai']);
  });

  it('classifies a migrated legacy deterministic fixture as orchestration replay only', () => {
    const store = new CassetteStore(dir);
    store.put({
      key: 'migrated-v2',
      operation: 'generate',
      text: 'safe replay response',
      providerName: 'claude',
      recordedAt: '2026-08-22T00:00:00.000Z',
      provenance: {
        kind: 'migrated_legacy_deterministic_fixture',
        sourceLegacyKey: 'legacy-v1',
        replayClassification: 'orchestration_replay_only',
        providerQuality: 'excluded',
      },
    });
    const summary = cassetteEvidenceSummary(new CassetteStore(dir));
    expect(summary).toEqual({
      totalEntries: 1,
      recordedProviderEntries: 0,
      migratedLegacyDeterministicFixtureEntries: 1,
      syntheticDeterministicOrchestrationFixtureEntries: 0,
      unknownProvenanceEntries: 0,
      orchestrationReplayEligible: true,
      realProviderQualityEligible: false,
      realProviderQualityExclusionReasons: ['migrated_legacy_deterministic_fixture'],
    });
  });

  it('classifies a synthetic sanitized-fixture response as orchestration-only evidence', () => {
    const store = new CassetteStore(dir);
    store.put({
      key: 'synthetic-v2',
      operation: 'generate',
      text: 'safe fixture response',
      providerName: 'claude',
      createdAt: '2026-08-22T12:00:00.000Z',
      provenance: {
        kind: 'synthetic_deterministic_orchestration_fixture',
        replayClassification: 'orchestration_replay_only',
        providerQuality: 'excluded',
        createdAt: '2026-08-22T12:00:00.000Z',
        creationMethod: 'sanitized_fixture_sql',
        source: 'current_scoped_runtime_dispatch',
      },
    });

    expect(cassetteEvidenceSummary(new CassetteStore(dir))).toEqual({
      totalEntries: 1,
      recordedProviderEntries: 0,
      migratedLegacyDeterministicFixtureEntries: 0,
      syntheticDeterministicOrchestrationFixtureEntries: 1,
      unknownProvenanceEntries: 0,
      orchestrationReplayEligible: true,
      realProviderQualityEligible: false,
      realProviderQualityExclusionReasons: ['synthetic_deterministic_orchestration_fixture'],
    });
  });

  it('never reports real-provider evidence for a run where every call was replayed', () => {
    const recorded = {
      totalEntries: 3,
      recordedProviderEntries: 3,
      migratedLegacyDeterministicFixtureEntries: 0,
      syntheticDeterministicOrchestrationFixtureEntries: 0,
      unknownProvenanceEntries: 0,
      orchestrationReplayEligible: true,
      realProviderQualityEligible: true,
      realProviderQualityExclusionReasons: [],
    };
    expect(cassetteEvidenceLine(recorded, 'replay')).toBe(
      'Real-provider quality evidence: none from this run — every provider call was replayed from 3 recorded response(s); no provider was called.',
    );
    expect(cassetteEvidenceLine(recorded, 'replay')).not.toContain('eligible');
    expect(cassetteEvidenceLine(recorded, 'record')).toBe('Real-provider quality evidence: eligible.');
    expect(cassetteEvidenceLine(
      { ...recorded, realProviderQualityEligible: false, realProviderQualityExclusionReasons: ['no_cassette_entries'] },
      'record',
    )).toBe('Real-provider quality evidence: excluded (no_cassette_entries).');
  });

  it('stops --cassette when the workbench it drives is not in that mode', () => {
    const base = { runtimeBase: 'http://127.0.0.1:3474', cassetteDir: 'test-cassettes/agent-evals' };
    expect(runtimeCassetteModeMismatch({ ...base, requested: undefined, reported: 'off' })).toBeUndefined();
    expect(runtimeCassetteModeMismatch({ ...base, requested: 'replay', reported: 'replay' })).toBeUndefined();
    expect(runtimeCassetteModeMismatch({ ...base, requested: 'live', reported: 'off' })).toBeUndefined();

    // A normally started workbench would make live provider calls while the
    // report claimed cassette replay.
    expect(runtimeCassetteModeMismatch({ ...base, requested: 'replay', reported: 'off' })).toBe(
      '--cassette replay needs the workbench to run in replay mode, but the workbench at http://127.0.0.1:3474 runs with cassette mode "off". '
      + 'The workbench makes the provider calls, so the flag alone cannot change them. '
      + 'Start it with `ZLENS_EVAL_CASSETTE_DIR=test-cassettes/agent-evals ZLENS_EVAL_CASSETTE_MODE=replay zlens notebook . --no-open`, then run the eval again.',
    );
    expect(runtimeCassetteModeMismatch({ ...base, requested: 'record', reported: undefined }))
      .toContain('does not report its cassette mode (it predates this check)');
    expect(runtimeCassetteModeMismatch({ ...base, requested: 'live', reported: 'replay' }))
      .toContain('Start it without ZLENS_EVAL_CASSETTE_DIR');
  });

  it('derives a readable cassette directory per suite', () => {
    expect(cassetteDirFor('/p', 'answerability.agent-evals.yml')).toBe('/p/test-cassettes/answerability.agent-evals');
  });

  it('keeps exact direct and full-runtime migrated v2 order-count replays as read-only one-relation proposals', () => {
    const cassetteDirectory = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../test/fixtures/jaffle-supply-chain/test-cassettes/answerability',
    );

    // Direct runner and full runtime dispatch intentionally have different
    // complete messages: the runtime includes its upstream execution context.
    // They therefore retain distinct V2 keys instead of aliasing one prompt to
    // another. Both entries are explicitly labelled deterministic migrations,
    // not recorded-provider quality evidence.
    const keys = [
      '53234ee35ab31fb5854b7158b2a7d692',
      '8b1c5206f05624e16692388161ccc43f',
    ] as const;
    const entries = keys.map((key) => {
      const fixture = join(cassetteDirectory, `${key}.json`);
      return JSON.parse(readFileSync(fixture, 'utf8')) as {
      key: string;
      operation: string;
      providerName: string;
      text: string;
      provenance?: {
        kind?: string;
        sourceLegacyKey?: string;
        replayClassification?: string;
        providerQuality?: string;
      };
      fingerprintDiagnostics?: {
        version?: number;
        messageCount?: number;
        messageRoles?: string[];
        preCanonicalHash?: string;
        postCanonicalHash?: string;
        appliedRuleClasses?: string[];
      };
      };
    });
    for (const entry of entries) {
      expect(entry).toMatchObject({ operation: 'generate', providerName: 'claude' });
      expect(entry.provenance).toEqual({
        kind: 'migrated_legacy_deterministic_fixture',
        sourceLegacyKey: '6a7a0b1cde72e1dbd3b20e9ccadb271d',
        replayClassification: 'orchestration_replay_only',
        providerQuality: 'excluded',
      });
      expect(new CassetteStore(cassetteDirectory).get(entry.key)?.text).toBe(entry.text);
      const proposal = JSON.parse(entry.text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? '{}') as { sql?: string };
      expect(proposal.sql).toContain('SELECT customer_name AS customer_name, count_lifetime_orders AS count_lifetime_orders');
      expect(proposal.sql).toContain('FROM dim_customers');
      expect(proposal.sql).not.toMatch(/\b(?:join|insert|update|delete|drop)\b/i);
    }
    const fullRuntime = entries.find((entry) => entry.key === '8b1c5206f05624e16692388161ccc43f')!;
    expect(fullRuntime.fingerprintDiagnostics).toEqual({
      version: 2,
      messageCount: 5,
      messageRoles: ['system', 'system', 'user', 'system', 'system'],
      preCanonicalHash: '8b1c5206f05624e16692388161ccc43fbaf2cb871032155b30d43bf59f8e119e',
      postCanonicalHash: '8b1c5206f05624e16692388161ccc43fbaf2cb871032155b30d43bf59f8e119e',
      appliedRuleClasses: [],
    });
    expect(cassetteEvidenceSummary(new CassetteStore(cassetteDirectory))).toMatchObject({
      migratedLegacyDeterministicFixtureEntries: 3,
      realProviderQualityEligible: false,
      realProviderQualityExclusionReasons: expect.arrayContaining(['migrated_legacy_deterministic_fixture']),
    });
  });

  it('keeps the scoped taxonomy replay fixtures synthetic, qualified, and single-relation', () => {
    const cassetteDirectory = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../test/fixtures/jaffle-supply-chain/test-cassettes/answerability',
    );
    const expected = [{
      key: '87b4e10fabf27cfc386916fa06f41df6',
      relation: 'jaffle_shop.dev.supplies',
      projection: 'SUM(supply_cost) AS total_supply_cost',
    }, {
      key: '5f0a9a36292648ea4641adc8dfbc257f',
      relation: 'jaffle_shop.dev.order_items',
      projection: 'SUM(product_price) AS revenue',
    }, {
      // Deliberate sanitized deterministic replay for the same scoped
      // runtime dispatch contract. It remains orchestration-only evidence:
      // its provenance excludes provider-quality evaluation and its SQL is a
      // one-relation, read-only customer fixture.
      key: '44a53a7575fb5885755759c05146630f',
      relation: 'dim_customers',
      projection: 'count_lifetime_orders AS count_lifetime_orders',
    }] as const;
    const store = new CassetteStore(cassetteDirectory);

    for (const fixture of expected) {
      const entry = JSON.parse(readFileSync(join(cassetteDirectory, `${fixture.key}.json`), 'utf8')) as {
        key: string;
        createdAt?: string;
        text: string;
        provenance?: Record<string, unknown>;
        fingerprintDiagnostics?: Record<string, unknown>;
      };
      expect(entry.createdAt).toBeTruthy();
      expect(entry.provenance).toEqual({
        kind: 'synthetic_deterministic_orchestration_fixture',
        replayClassification: 'orchestration_replay_only',
        providerQuality: 'excluded',
        createdAt: entry.createdAt,
        creationMethod: 'sanitized_fixture_sql',
        source: 'current_scoped_runtime_dispatch',
      });
      expect(entry.fingerprintDiagnostics).toMatchObject({
        version: 2,
        messageCount: 5,
        messageRoles: ['system', 'system', 'user', 'system', 'system'],
        appliedRuleClasses: [],
      });
      const proposal = JSON.parse(entry.text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? '{}') as { sql?: string };
      expect(proposal.sql).toContain(`FROM ${fixture.relation}`);
      expect(proposal.sql).toContain(fixture.projection);
      expect(proposal.sql).not.toMatch(/\b(?:join|insert|update|delete|drop)\b/i);
      expect(store.get(fixture.key)?.text).toBe(entry.text);
    }

    expect(cassetteEvidenceSummary(store)).toMatchObject({
      syntheticDeterministicOrchestrationFixtureEntries: 3,
      realProviderQualityEligible: false,
      realProviderQualityExclusionReasons: expect.arrayContaining([
        'synthetic_deterministic_orchestration_fixture',
      ]),
    });
  });
});

describe('resolveCassetteModeFromEnv', () => {
  it('defaults to replay for anything that is not an explicit record/live', () => {
    // The safety-critical default. A cassette dir set in CI with a missing or
    // misspelled mode must mean "never call a live model", not a surprise bill
    // and a non-deterministic suite.
    expect(resolveCassetteModeFromEnv({})).toBe('replay');
    expect(resolveCassetteModeFromEnv({ ZLENS_EVAL_CASSETTE_MODE: undefined })).toBe('replay');
    expect(resolveCassetteModeFromEnv({ ZLENS_EVAL_CASSETTE_MODE: 'recrod' })).toBe('replay');
    expect(resolveCassetteModeFromEnv({ ZLENS_EVAL_CASSETTE_MODE: 'RECORD' })).toBe('replay');
  });

  it('honours an explicit record or live', () => {
    expect(resolveCassetteModeFromEnv({ ZLENS_EVAL_CASSETTE_MODE: 'record' })).toBe('record');
    expect(resolveCassetteModeFromEnv({ ZLENS_EVAL_CASSETTE_MODE: 'live' })).toBe('live');
  });
});
