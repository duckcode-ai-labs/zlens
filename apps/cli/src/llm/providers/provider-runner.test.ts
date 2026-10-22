import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { __test__, createDqlAgentProviderRunner, createEvalCassetteReplayProvider, evalCassetteRuntimeMode, resolveEffectiveQuestion } from './provider-runner.js';
import { CassetteStore, cassetteFingerprint, cassetteKey, evalCassetteCanonicalizationV2 } from '../../commands/agent-eval-cassette.js';
import type { AgentRunRequest } from '../types.js';
import type { AgentMessage } from '@zlens/agent';

const providerFixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/jaffle-supply-chain',
);

function req(messages: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunRequest {
  return { provider: 'ollama', messages, projectRoot: '/tmp/x' } as AgentRunRequest;
}

describe('eval cassette provider bootstrap', () => {
  it('replays a labelled deterministic migration without configured provider settings', async () => {
    const cassetteDir = mkdtempSync(join(tmpdir(), 'dql-runtime-cassette-provider-'));
    const messages: AgentMessage[] = [{ role: 'user', content: 'show revenue' }];
    const projectRoot = '/tmp/dql-runtime-cassette-project';
    const key = cassetteKey({
      providerName: 'claude',
      operation: 'generate',
      messages,
      canonicalization: evalCassetteCanonicalizationV2(projectRoot),
    });
    const oldDir = process.env.ZLENS_EVAL_CASSETTE_DIR;
    const oldMode = process.env.ZLENS_EVAL_CASSETTE_MODE;
    try {
      new CassetteStore(cassetteDir).put({
        key,
        operation: 'generate',
        text: 'recorded governed interpretation',
        providerName: 'claude',
        recordedAt: '2026-08-22T00:00:00.000Z',
        provenance: {
          kind: 'migrated_legacy_deterministic_fixture',
          sourceLegacyKey: 'legacy-order-count-v1',
          replayClassification: 'orchestration_replay_only',
          providerQuality: 'excluded',
        },
      });
      process.env.ZLENS_EVAL_CASSETTE_DIR = cassetteDir;
      delete process.env.ZLENS_EVAL_CASSETTE_MODE;

      const provider = createEvalCassetteReplayProvider(projectRoot);
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('claude');
      await expect(provider!.available()).resolves.toBe(true);
      await expect(provider!.generate(messages)).resolves.toBe('recorded governed interpretation');
    } finally {
      if (oldDir === undefined) delete process.env.ZLENS_EVAL_CASSETTE_DIR;
      else process.env.ZLENS_EVAL_CASSETTE_DIR = oldDir;
      if (oldMode === undefined) delete process.env.ZLENS_EVAL_CASSETTE_MODE;
      else process.env.ZLENS_EVAL_CASSETTE_MODE = oldMode;
      rmSync(cassetteDir, { recursive: true, force: true });
    }
  });
});

describe('resolveEffectiveQuestion — clarify follow-up folding', () => {
  it('folds the original question with the clarification answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'Can you give me total revenue based on most products performed?' },
      { role: 'assistant', content: 'Needs clarification before a governed answer can be produced. For "…", which business object and measure should I use, and at what grain?' },
      { role: 'user', content: 'I need product details with name' },
    ]));
    expect(out).toContain('Can you give me total revenue based on most products performed?');
    expect(out).toContain('clarification: I need product details with name');
  });

  it('returns the current message unchanged when the prior assistant turn was NOT a clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'what is total revenue?' },
      { role: 'assistant', content: 'Revenue is $2.8M this quarter.' },
      { role: 'user', content: 'now break it down by region' },
    ]));
    expect(out).toBe('now break it down by region');
  });

  it('returns the single user message when there is no prior turn', () => {
    expect(resolveEffectiveQuestion(req([{ role: 'user', content: 'top products by revenue' }]))).toBe('top products by revenue');
  });

  it('does not merge when the original equals the current answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'revenue by product' },
      { role: 'assistant', content: 'I need one more detail before querying: which metric should define the answer?' },
      { role: 'user', content: 'revenue by product' },
    ]));
    expect(out).toBe('revenue by product');
  });

  it('does not merge a complete new analytical question after clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'which customer should I use?' },
      { role: 'assistant', content: 'Needs clarification: which customer should define the answer?' },
      { role: 'user', content: 'what region has the most revenue' },
    ]));
    expect(out).toBe('what region has the most revenue');
  });

  it('does not merge a compact standalone analytical request after clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'which breakdown should I use?' },
      { role: 'assistant', content: 'I need one more detail: which metric and dimension should define the answer?' },
      { role: 'user', content: 'revenue by region' },
    ]));
    expect(out).toBe('revenue by region');
  });
});

describe('answer-loop tool surface', () => {
  it('converts a server-only compound parent binding into one exact child filter', () => {
    const followUp = __test__.followUpFromConversationContext({
      ...req([{ role: 'user', content: 'top customers in that region' }]),
      conversationContext: {
        analyticalTaskDependencyBinding: {
          version: 1,
          sourceTaskId: 'task-1',
          sourceResultFingerprint: 'a'.repeat(64),
          canonicalColumn: 'region',
          value: 'Philadelphia',
          rowFingerprint: 'b'.repeat(64),
        },
      },
    }, 'top customers in that region');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'task:task-1',
      filters: ['Philadelphia'],
      dimensions: ['region'],
      memberBindings: [{ dimension: 'region', values: ['Philadelphia'], confidence: 'exact' }],
    });
    expect(followUp).not.toHaveProperty('sourceAnswer');
    expect(followUp).not.toHaveProperty('priorResult');
  });
});

describe('the provider runner is not an answer surface', () => {
  it('refuses a direct run and names the pipeline that owns governed answers', async () => {
    const runner = createDqlAgentProviderRunner('ollama');
    const turns: unknown[] = [];
    await expect(runner.run(req([{ role: 'user', content: 'total revenue' }]), (turn) => { turns.push(turn); }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ASK_PIPELINE_OWNS_GOVERNED_ANSWERS' });
    expect(turns).toEqual([expect.objectContaining({ kind: 'error' })]);
  });
});

describe('evalCassetteRuntimeMode', () => {
  it('reports off without a cassette directory, and replay unless the mode says record or live', () => {
    expect(evalCassetteRuntimeMode({})).toBe('off');
    expect(evalCassetteRuntimeMode({ ZLENS_EVAL_CASSETTE_MODE: 'record' })).toBe('off');
    expect(evalCassetteRuntimeMode({ ZLENS_EVAL_CASSETTE_DIR: '/c' })).toBe('replay');
    expect(evalCassetteRuntimeMode({ ZLENS_EVAL_CASSETTE_DIR: '/c', ZLENS_EVAL_CASSETTE_MODE: 'record' })).toBe('record');
    expect(evalCassetteRuntimeMode({ ZLENS_EVAL_CASSETTE_DIR: '/c', ZLENS_EVAL_CASSETTE_MODE: 'live' })).toBe('live');
  });
});
