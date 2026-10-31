import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { listExistingSemanticModels, previewProjectMetricPatch, resolveSemanticLayer, type DbtMetricAuthoringInput, type MetricAuthoringPaths } from '@zlens/core';
import { startLocalServer } from './local-runtime.js';

/**
 * A walkthrough of the Harbor demo: Modeling → Add metric on `claims` refused its preview with "A new semantic model
 * needs a primary entity…", and the dialog said the model had none, although Ask answers claims metrics from
 * `semantic-layer/semantic_models/claims.yaml`. Add metric only ever looked in dbt's YAML. These run on the demo's own
 * semantic layer: a dbt-first project with `semanticLayer.provider: dql`, a manifest and no dbt semantic models.
 */
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'ask-pipeline-host/fixtures/harbor-claims');
const COLUMNS = ['claim_id', 'region', 'product', 'claim_type', 'status', 'claimed_amount', 'reported_date'];

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harbor() {
  const root = mkdtempSync(join(tmpdir(), 'dql-native-metric-'));
  roots.push(root);
  cpSync(fixture, root, { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  const model = (name: string, columns: string[]) => ({ unique_id: `model.harbor_claims.${name}`, resource_type: 'model', name, alias: name, schema: 'main', database: 'harbor', relation_name: `"harbor"."main"."${name}"`, original_file_path: `models/claims/${name}.sql`, columns: Object.fromEntries(columns.map((column) => [column, { name: column }])) });
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
    metadata: { project_name: 'harbor_claims' },
    nodes: { 'model.harbor_claims.claims': model('claims', COLUMNS), 'model.harbor_claims.members': model('members', ['member_id', 'joined_date']) },
    sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
  }));
  const paths: MetricAuthoringPaths = { dbtProjectRoot: root, manifestPath: join(root, 'target', 'manifest.json'), projectRoot: root, semanticLayerDir: join(root, 'semantic-layer') };
  return { root, paths };
}

const average: DbtMetricAuthoringInput = {
  mode: 'add',
  semanticModel: 'claims',
  modelUniqueId: 'model.harbor_claims.claims',
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', description: 'Mean amount claimed per claim.', aggregation: 'average', column: 'claimed_amount', domain: 'claims', synonyms: ['mean claimed amount'] },
};

const patchAt = (preview: ReturnType<typeof previewProjectMetricPatch>, path: string) => preview.patches.find((patch) => patch.path === path);

describe('Add metric on the demo\'s semantic layer', () => {
  it('finds the semantic model on the dbt model by its table, and a cube beside it is the same model', () => {
    const { paths } = harbor();
    const models = listExistingSemanticModels(paths);
    expect(models.filter((model) => model.dbtModel === 'claims')).toEqual([{ name: 'claims', dbtModel: 'claims', path: 'semantic-layer/semantic_models/claims.yaml', owner: 'semantic-layer' }]);
    expect(models.find((model) => model.name === 'claim_payments')).toMatchObject({ dbtModel: 'claim_payments', path: 'semantic-layer/cubes/claim-payments.yaml' });
  });

  it('adds the metric to the existing model, with no primary entity or time column asked for', () => {
    const { paths } = harbor();
    const preview = previewProjectMetricPatch(paths, average);
    expect(preview).toMatchObject({ semanticModel: 'claims', writesTo: 'semantic-layer', warnings: [] });
    expect(preview.patches.map((patch) => patch.path).sort()).toEqual([
      'semantic-layer/cubes/claims.yaml', 'semantic-layer/metrics/claims.yaml', 'semantic-layer/semantic_models/claims.yaml',
    ]);
    const metrics = yaml.load(patchAt(preview, 'semantic-layer/metrics/claims.yaml')!.after) as { metrics: Array<Record<string, unknown>> };
    expect(metrics.metrics.find((metric) => metric.name === 'claim_count')).toBeDefined();
    expect(metrics.metrics.find((metric) => metric.name === 'average_claimed_amount')).toEqual({
      name: 'average_claimed_amount', label: 'Average claimed amount', description: 'Mean amount claimed per claim.', domain: 'claims',
      cube: 'claims', table: 'claims', sql: 'AVG(claimed_amount)', type: 'avg', aggregation: 'average', metric_type: 'simple',
      type_params: { measure: 'average_claimed_amount' }, agg_time_dimension: 'reported_date', synonyms: ['mean claimed amount'],
    });
    expect((yaml.load(patchAt(preview, 'semantic-layer/semantic_models/claims.yaml')!.after) as { measures: string[] }).measures).toEqual(['claim_count', 'claimed_amount', 'average_claimed_amount']);
  });

  it('never marks the metric certified: a review decides that', () => {
    const { paths } = harbor();
    expect(previewProjectMetricPatch(paths, average).patches.find((patch) => patch.path.includes('metrics/'))!.after).not.toMatch(/average_claimed_amount[\s\S]*status: certified/);
  });

  it('checks the column against the dbt model, and refuses a name already taken', () => {
    const { paths } = harbor();
    expect(() => previewProjectMetricPatch(paths, { ...average, metric: { ...average.metric, column: 'nope' } })).toThrow(/Unknown column "nope"/);
    expect(() => previewProjectMetricPatch(paths, { ...average, metric: { ...average.metric, name: 'claimed_amount' } })).toThrow(/already exists in semantic-layer\/metrics\/claims\.yaml/);
  });

  it('keeps the new-model path, and its demands, for a dbt model that truly has none', () => {
    const { paths } = harbor();
    const none: DbtMetricAuthoringInput = { mode: 'add', semanticModel: 'members', modelUniqueId: 'model.harbor_claims.members', metric: { name: 'member_count', aggregation: 'count', column: 'member_id' } };
    expect(() => previewProjectMetricPatch(paths, none)).toThrow(/A new semantic model needs a primary entity/);
    expect(previewProjectMetricPatch(paths, { ...none, primaryEntity: { name: 'member', column: 'member_id' }, timeDimension: { name: 'joined_date', column: 'joined_date' } })).toMatchObject({ writesTo: 'dbt' });
  });

  it('ignores the semantic layer when the project does not read it: dbt owns the metric', () => {
    const { paths } = harbor();
    const { semanticLayerDir: _unread, ...dbtOnly } = paths;
    expect(listExistingSemanticModels(dbtOnly)).toEqual([]);
    expect(() => previewProjectMetricPatch(dbtOnly, average)).toThrow(/A new semantic model needs a primary entity/);
  });

  it('through the routes: lists the model, previews, applies, and the semantic layer answers with the metric at once', async () => {
    const { root } = harbor();
    const port = await startLocalServer({ rootDir: root, projectRoot: root, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string; semanticModels: Array<{ name: string; dbtModel?: string }> };
    expect(page.semanticModels).toContainEqual(expect.objectContaining({ name: 'claims', dbtModel: 'claims' }));
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() as Record<string, any> };
    };
    const preview = await post('/api/modeling/dbt-first/dbt-metric/preview', { change: average, expectedSnapshotId: page.snapshotId });
    expect(preview.status, JSON.stringify(preview.json).slice(0, 300)).toBe(200);
    const applied = await post('/api/modeling/dbt-first/dbt-metric/apply', { change: average, expectedFingerprint: preview.json.fingerprint, expectedSnapshotId: preview.json.snapshotId });
    expect(applied.status, JSON.stringify(applied.json).slice(0, 300)).toBe(200);
    expect(applied.json.manifestRefresh).toMatchObject({ refreshed: true });
    expect(existsSync(join(root, 'models'))).toBe(false);
    expect(readFileSync(join(root, 'semantic-layer', 'metrics', 'claims.yaml'), 'utf-8')).toContain('average_claimed_amount');
    const layer = resolveSemanticLayer({ provider: 'dql', path: 'semantic-layer' }, root)!;
    expect(layer.getMetric('average_claimed_amount')).toMatchObject({ sql: 'AVG(claimed_amount)', cube: 'claims', type: 'avg', table: 'claims' });
    expect(layer.getCube('claims')?.measures.map((measure) => measure.name)).toContain('average_claimed_amount');
  });
});
