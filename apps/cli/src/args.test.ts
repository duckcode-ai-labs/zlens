import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('parses open and no-open flags plus port and out-dir', () => {
    const parsed = parseArgs(['preview', 'blocks/demo.dql', '--open', '--port', '4488', '--out-dir', 'out']);
    expect(parsed.command).toBe('preview');
    expect(parsed.file).toBe('blocks/demo.dql');
    expect(parsed.flags.open).toBe(true);
    expect(parsed.flags.port).toBe(4488);
    expect(parsed.flags.outDir).toBe('out');
  });

  it('preserves the notebook Ask runtime mode for launch-time validation', () => {
    const parsed = parseArgs(['notebook', '.', '--ask-runtime-mode', 'pipeline_v3']);
    expect(parsed.flags.askRuntimeMode).toBe('pipeline_v3');

    // The parser does not silently coerce an absent value into the safe
    // default. The notebook startup validator will reject this explicit error.
    expect(parseArgs(['notebook', '.', '--ask-runtime-mode']).flags.askRuntimeMode).toBe('');
  });

  it('collects extra positionals and new-block flags', () => {
    const parsed = parseArgs(['new', 'block', 'Revenue', 'by', 'Segment', '--chart', 'line', '--domain', 'finance', '--owner', 'demo', '--pattern', 'ranking', '--query-only']);
    expect(parsed.command).toBe('new');
    expect(parsed.file).toBe('block');
    expect(parsed.rest).toEqual(['Revenue', 'by', 'Segment']);
    expect(parsed.flags.chart).toBe('line');
    expect(parsed.flags.domain).toBe('finance');
    expect(parsed.flags.owner).toBe('demo');
    expect(parsed.flags.template).toBe('ranking');
    expect(parsed.flags.queryOnly).toBe(true);
  });

  it('parses domain layout migration flags', () => {
    const parsed = parseArgs(['migrate', 'layout', '--to', 'domain-first', '--dry-run']);
    expect(parsed.command).toBe('migrate');
    expect(parsed.file).toBe('layout');
    expect(parsed.flags.to).toBe('domain-first');
    expect(parsed.flags.dryRun).toBe(true);
  });

  it('parses enterprise certification flag', () => {
    const parsed = parseArgs(['certify', 'blocks/customer.dql', '--enterprise']);
    expect(parsed.command).toBe('certify');
    expect(parsed.file).toBe('blocks/customer.dql');
    expect(parsed.flags.enterprise).toBe(true);
  });

  it('lets no-open override browser launching', () => {
    const parsed = parseArgs(['serve', 'dist/demo', '--open', '--no-open']);
    expect(parsed.flags.open).toBe(false);
  });

  it('parses init with connection flag', () => {
    const parsed = parseArgs(['init', 'demo', '--connection', 'duckdb']);
    expect(parsed.command).toBe('init');
    expect(parsed.file).toBe('demo');
    expect(parsed.flags.connection).toBe('duckdb');
  });

  it('parses sql import command arguments', () => {
    const parsed = parseArgs(['import', 'sql', './queries', '--domain', 'finance', '--owner', 'analytics']);
    expect(parsed.command).toBe('import');
    expect(parsed.file).toBe('sql');
    expect(parsed.rest).toEqual(['./queries']);
    expect(parsed.flags.domain).toBe('finance');
    expect(parsed.flags.owner).toBe('analytics');
  });

  it('parses app generation AI layout flag', () => {
    const parsed = parseArgs(['app', 'generate', 'Build a clean NBA app', '--ai-layout']);
    expect(parsed.command).toBe('app');
    expect(parsed.file).toBe('generate');
    expect(parsed.rest).toEqual(['Build a clean NBA app']);
    expect(parsed.flags.aiLayout).toBe(true);
  });

  it('parses agent provider, runtime, and feedback flags without adding them to the prompt', () => {
    const parsed = parseArgs([
      'agent',
      'ask',
      'Who scored the least points?',
      '--provider',
      'ollama',
      '--runtime-url',
      'http://127.0.0.1:3474',
      '--user',
      'analyst@local',
      '--reasoning-effort',
      'high',
      '--analysis-depth',
      'deep',
    ]);

    expect(parsed.command).toBe('agent');
    expect(parsed.file).toBe('ask');
    expect(parsed.rest).toEqual(['Who scored the least points?']);
    expect(parsed.flags.provider).toBe('ollama');
    expect(parsed.flags.runtimeUrl).toBe('http://127.0.0.1:3474');
    expect(parsed.flags.user).toBe('analyst@local');
    expect(parsed.flags.reasoningEffort).toBe('high');
    expect(parsed.flags.analysisDepth).toBe('deep');
  });

  it('parses agent eval tool-observation threshold', () => {
    const parsed = parseArgs([
      'agent',
      'eval',
      'agent-evals.yml',
      '--min-tool-requirement',
      '0.75',
    ]);

    expect(parsed.command).toBe('agent');
    expect(parsed.file).toBe('eval');
    expect(parsed.rest).toEqual(['agent-evals.yml']);
    expect(parsed.flags.minToolRequirement).toBe(0.75);
  });

  it('parses the bounded local Ask trace export and replay controls', () => {
    const exportArgs = parseArgs([
      'agent', 'trace', 'export', 'run-local-1', '--out', 'trace-bundle',
      '--profile', 'support', '--confirm-reviewed-identifiers', '--question', 'Reviewed business wording only',
    ]);
    expect(exportArgs.command).toBe('agent');
    expect(exportArgs.file).toBe('trace');
    expect(exportArgs.rest).toEqual(['export', 'run-local-1']);
    expect(exportArgs.flags).toMatchObject({
      outDir: 'trace-bundle', traceProfile: 'support', confirmReviewedIdentifiers: true,
      question: 'Reviewed business wording only',
    });

    const replayArgs = parseArgs(['agent', 'trace', 'replay', 'trace-bundle', '--mode', 'receipt']);
    expect(replayArgs.flags.traceMode).toBe('receipt');
  });

  it('parses router eval answer-rate threshold', () => {
    const parsed = parseArgs([
      'eval',
      'apps/cli/test/fixtures/jaffle-supply-chain',
      '--min-answer-rate',
      '0.9',
    ]);

    expect(parsed.command).toBe('eval');
    expect(parsed.file).toBe('apps/cli/test/fixtures/jaffle-supply-chain');
    expect(parsed.flags.minAnswerRate).toBe(0.9);
  });

  it('parses diff recertification changeset flags', () => {
    const parsed = parseArgs([
      'diff',
      'blocks/revenue.dql',
      '--impact',
      '--write-recertification',
    ]);

    expect(parsed.command).toBe('diff');
    expect(parsed.file).toBe('blocks/revenue.dql');
    expect(parsed.flags.impact).toBe(true);
    expect(parsed.flags.writeRecertification).toBe(true);
  });

  it('parses eval and agent eval share thresholds between 0 and 1', () => {
    const parsed = parseArgs(['eval', '.', '--min-route-accuracy', '1', '--min-refusal', '0', '--min-candidate-recall', '0.9']);
    expect(parsed.flags.minRouteAccuracy).toBe(1);
    expect(parsed.flags.minRefusal).toBe(0);
    expect(parsed.flags.minCandidateRecall).toBe(0.9);
    expect(parsed.flags.argErrors).toBeUndefined();
  });

  it('rejects an out-of-range share instead of silently dropping the gate', () => {
    const parsed = parseArgs(['eval', '.', '--min-route-accuracy', '90', '--max-false-refusal', '-1', '--min-judge-pass', 'high']);
    expect(parsed.flags.minRouteAccuracy).toBeUndefined();
    expect(parsed.flags.maxFalseRefusal).toBeUndefined();
    expect(parsed.flags.minJudgePass).toBeUndefined();
    expect(parsed.flags.argErrors).toEqual([
      '--min-route-accuracy expects a share between 0 and 1 (for 90% use 0.9), got "90".',
      '--max-false-refusal expects a share between 0 and 1 (for 90% use 0.9), got "-1".',
      '--min-judge-pass expects a share between 0 and 1 (for 90% use 0.9), got "high".',
    ]);
    // The value was consumed, so it never becomes a positional path.
    expect(parsed.file).toBe('.');
    expect(parsed.rest).toEqual([]);
  });

  it('parses --judge so --min-judge-pass has judge scores to gate on', () => {
    const parsed = parseArgs(['agent', 'eval', 'agent-evals.yml', '--judge', '--min-judge-pass', '0.8']);
    expect(parsed.flags.judge).toBe(true);
    expect(parsed.flags.minJudgePass).toBe(0.8);
    expect(parsed.file).toBe('eval');
    expect(parsed.rest).toEqual(['agent-evals.yml']);
  });

  it('accepts --via runtime and rejects the removed in-process --via loop driver', () => {
    expect(parseArgs(['agent', 'eval', '--via', 'runtime']).flags.via).toBe('runtime');
    const loop = parseArgs(['agent', 'eval', '--via', 'loop']);
    expect(loop.flags.via).toBeUndefined();
    expect(loop.flags.argErrors?.[0]).toContain('--via loop is not supported');
    expect(parseArgs(['agent', 'eval', '--cassette', 'tape']).flags.argErrors?.[0])
      .toBe('--cassette expects record, replay or live, got "tape".');
  });
});
