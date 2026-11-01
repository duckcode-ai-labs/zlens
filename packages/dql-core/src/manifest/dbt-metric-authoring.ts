import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import {
  assertContainedPath,
  asRecord,
  dumpYaml,
  hash,
  loadDbtNodeAuthoringDetail,
  readJson,
  stringValue,
  type ModelingSourcePatch,
} from './dbt-first-authoring.js';

type UnknownRecord = Record<string, unknown>;

/** The aggregations DQL compiles natively from a MetricFlow measure (`dbt-provider.ts` AGG_TYPE_MAP). */
export const DBT_METRIC_AGGREGATIONS = ['sum', 'count', 'count_distinct', 'average', 'min', 'max'] as const;
export type DbtMetricAggregation = typeof DBT_METRIC_AGGREGATIONS[number];

export interface DbtMetricAuthoringInput {
  /** `add` refuses a name that exists anywhere in the dbt project; `edit` changes that metric in place. */
  mode: 'add' | 'edit';
  /** The MetricFlow semantic model that holds the measure. Created when it does not exist yet. */
  semanticModel: string;
  /** dbt model unique_id behind a semantic model that does not exist yet. */
  modelUniqueId?: string;
  /** Required with a new semantic model: its primary entity and aggregate time column. */
  primaryEntity?: { name: string; column: string };
  timeDimension?: { name: string; column: string; timeGranularity?: string };
  metric: {
    name: string;
    label?: string;
    description?: string;
    /** `avg` is accepted for `average`. */
    aggregation: string;
    column: string;
    /** Written as `config.meta.domain`, which ZLens reads as the metric's domain. */
    domain?: string;
    /**
     * Other names people use for the metric. Written as `config.meta.synonyms` in the same patch, which ZLens reads
     * as aliases of the metric, so a question that uses one finds it.
     */
    synonyms?: string[];
  };
  dimensions?: Array<{ name: string; column?: string; type?: 'categorical' | 'time'; timeGranularity?: string }>;
}

export interface DbtMetricPatchPreview {
  semanticModel: string;
  metric: string;
  patches: ModelingSourcePatch[];
  fingerprint: string;
  /** Things the check could not prove (for example, columns when no dbt manifest exists). */
  warnings: string[];
  /** Where the patches go: dbt's YAML, or the project's own `semantic-layer/` folder. */
  writesTo?: 'dbt' | 'semantic-layer';
}

/** A semantic model the project already has, and the dbt model it sits on. */
export interface ExistingSemanticModel {
  name: string;
  /** The dbt model's name, from `model: ref('…')`, else the last part of `table:`. */
  dbtModel?: string;
  /** Project-relative for `semantic-layer`, dbt-project-relative for `dbt`. */
  path: string;
  owner: 'dbt' | 'semantic-layer';
}

/** Where a project keeps metrics. `semanticLayerDir` is set only when ZLens reads the project's own semantic layer. */
export interface MetricAuthoringPaths {
  dbtProjectRoot: string;
  manifestPath: string;
  projectRoot: string;
  semanticLayerDir?: string;
}

interface Loaded { path: string; before: string; document: UnknownRecord }

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

function invalid(issues: string[]): never {
  throw Object.assign(new Error(issues.join(' ')), { code: 'DBT_METRIC_INVALID', issues });
}

function yamlFiles(root: string, modelPaths: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks are skipped so a link inside models/ cannot lead the scan or a write outside the project.
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(entry.name) && statSync(full).size < 2_000_000) out.push(full);
    }
  };
  for (const modelPath of modelPaths) walk(resolve(root, modelPath));
  return out.sort();
}

function modelPathsOf(root: string): string[] {
  try {
    const project = asRecord(yaml.load(readFileSync(join(root, 'dbt_project.yml'), 'utf8')));
    const paths = Array.isArray(project['model-paths']) ? project['model-paths'].map(String).filter(Boolean) : [];
    return paths.length ? paths : ['models'];
  } catch {
    return ['models'];
  }
}

function listOf(document: UnknownRecord, key: string): UnknownRecord[] {
  return Array.isArray(document[key]) ? (document[key] as unknown[]).map(asRecord) : [];
}

/** The dbt model a `model:` field names: `ref('claims')`, `ref('pkg', 'claims')`, `ref('claims', v=2)` or a bare name. */
function refTarget(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  const call = /^ref\((.*)\)$/s.exec(text);
  if (!call) return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : undefined;
  const positional = call[1]!.split(',').map((part) => part.trim()).filter((part) => /^['"]/.test(part));
  return positional.pop()?.replace(/^['"]|['"]$/g, '');
}

/** The last part of a table name, unquoted: `"harbor"."main"."claims"` and `main.claims` both read as `claims`. */
function tableName(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.split('.').filter(Boolean).pop()?.replace(/^["`\[]|["`\]]$/g, '') || undefined;
}

/** Every semantic model the project has, dbt's and (when ZLens reads it) its own semantic layer's, so nothing is created twice. */
export function listExistingSemanticModels(paths: Pick<MetricAuthoringPaths, 'dbtProjectRoot' | 'projectRoot' | 'semanticLayerDir'>): ExistingSemanticModel[] {
  const found: ExistingSemanticModel[] = [];
  if (paths.semanticLayerDir) {
    for (const entry of readNativeModels(paths.projectRoot, paths.semanticLayerDir)) {
      // A cube beside a semantic model on the same dbt model is one model, not two.
      if (entry.kind === 'cube' && found.some((seen) => seen.dbtModel === entry.dbtModel)) continue;
      found.push({ name: entry.name, ...(entry.dbtModel ? { dbtModel: entry.dbtModel } : {}), path: entry.file.path, owner: 'semantic-layer' });
    }
  }
  const root = resolve(paths.dbtProjectRoot);
  for (const file of yamlFiles(root, modelPathsOf(root))) {
    let document: UnknownRecord;
    try { document = asRecord(yaml.load(readFileSync(file, 'utf8'))); } catch { continue; }
    for (const model of listOf(document, 'semantic_models')) {
      if (typeof model.name !== 'string') continue;
      const dbtModel = refTarget(model.model);
      found.push({ name: model.name, ...(dbtModel ? { dbtModel } : {}), path: relative(root, file).replace(/\\/g, '/'), owner: 'dbt' });
    }
  }
  return found;
}

/** Names of the other metrics (in the loaded YAML or the dbt manifest) whose inputs name `name`, a measure or a metric. */
function metricsReferencing(name: string, files: Loaded[], manifest: UnknownRecord | undefined): string[] {
  const found = new Set<string>();
  const mentions = (typeParams: unknown): boolean => {
    if (typeof typeParams === 'string') return typeParams === name;
    if (Array.isArray(typeParams)) return typeParams.some(mentions);
    if (typeParams && typeof typeParams === 'object') return Object.values(typeParams).some(mentions);
    return false;
  };
  for (const file of files) {
    for (const metric of listOf(file.document, 'metrics')) {
      if (metric.name !== name && mentions(metric.type_params)) found.add(String(metric.name));
    }
  }
  for (const node of Object.values(asRecord(manifest?.metrics))) {
    const metric = asRecord(node);
    if (metric.name !== name && mentions(metric.type_params)) found.add(String(metric.name));
  }
  return [...found].sort();
}

/** Build the YAML patches for adding or editing one MetricFlow simple metric, without writing anything. */
export function previewDbtMetricPatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtMetricAuthoringInput,
): DbtMetricPatchPreview {
  const root = resolve(dbtProjectRoot);
  const issues: string[] = [];
  const warnings: string[] = [];
  const metricInput = input.metric ?? ({} as DbtMetricAuthoringInput['metric']);
  const metricName = String(metricInput.name ?? '').trim();
  let semanticModelName = String(input.semanticModel ?? '').trim();
  if (input.mode !== 'add' && input.mode !== 'edit') issues.push('mode must be "add" or "edit".');
  if (!NAME.test(metricName)) issues.push(`Metric name "${metricName}" must be lowercase letters, digits and single underscores, starting with a letter (for example average_claimed_amount).`);
  if (!NAME.test(semanticModelName)) issues.push(`Semantic model name "${semanticModelName}" must be lowercase letters, digits and single underscores.`);
  const aggregationRaw = String(metricInput.aggregation ?? '').trim().toLowerCase();
  const aggregation = (aggregationRaw === 'avg' ? 'average' : aggregationRaw) as DbtMetricAggregation;
  if (!DBT_METRIC_AGGREGATIONS.includes(aggregation)) issues.push(`Unsupported aggregation "${metricInput.aggregation ?? ''}". Use one of: ${DBT_METRIC_AGGREGATIONS.join(', ')}.`);
  const column = String(metricInput.column ?? '').trim();
  if (!COLUMN.test(column)) issues.push(`Column "${column}" must be a single column name; expressions are not supported here.`);
  if (issues.length) invalid(issues);

  // Everything the project already defines, so a duplicate is refused before anything is written.
  const loaded = new Map<string, Loaded>();
  for (const file of yamlFiles(root, modelPathsOf(root))) {
    const path = relative(root, file).replace(/\\/g, '/');
    const before = readFileSync(file, 'utf8');
    let document: UnknownRecord;
    try {
      document = asRecord(yaml.load(before));
    } catch (error) {
      // A file that is not parsable cannot be shown to hold the name, so it is named rather than skipped silently.
      warnings.push(`${path} could not be parsed as YAML and was not checked for duplicates: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    loaded.set(path, { path, before, document });
  }
  const all = [...loaded.values()];
  const manifest = existsSync(manifestPath) ? readJson(assertContainedPath(root, manifestPath, 'dbt manifest')) : undefined;
  const manifestMetricNames = Object.values(asRecord(manifest?.metrics)).map((node) => stringValue(asRecord(node).name));
  const metricOwner = all.find((file) => listOf(file.document, 'metrics').some((metric) => metric.name === metricName));
  const measureOwner = all.find((file) => listOf(file.document, 'semantic_models').some((model) => listOf(model, 'measures').some((measure) => measure.name === metricName)));
  let semanticOwner = all.find((file) => listOf(file.document, 'semantic_models').some((model) => model.name === semanticModelName));
  if (!semanticOwner && input.modelUniqueId && manifest) {
    // The semantic model may be named differently from its dbt model. A second one on the same dbt model would split
    // its measures, so the existing one is used.
    const pickedNode = asRecord(asRecord(manifest.nodes)[input.modelUniqueId]);
    const pickedName = pickedNode.resource_type === 'model' ? stringValue(pickedNode.name) : undefined;
    if (pickedName) {
      for (const file of all) {
        const found = listOf(file.document, 'semantic_models').find((candidate) => refTarget(candidate.model) === pickedName);
        if (found) {
          semanticOwner = file;
          semanticModelName = String(found.name);
          warnings.push(`dbt model "${pickedName}" already has the semantic model "${semanticModelName}" (${file.path}); the metric was added there instead of creating a second one.`);
          break;
        }
      }
    }
  }

  if (input.mode === 'add') {
    if (metricOwner || manifestMetricNames.includes(metricName)) issues.push(`A metric named "${metricName}" already exists${metricOwner ? ` in ${metricOwner.path}` : ' in the dbt manifest'}. Pick another name, or edit that metric.`);
    if (measureOwner) issues.push(`A measure named "${metricName}" already exists in ${measureOwner.path}; MetricFlow measure names are unique across the project.`);
  } else if (!metricOwner) {
    issues.push(`There is no metric named "${metricName}" in the dbt project YAML to edit.`);
  }

  // The semantic model: an existing one is extended; otherwise one is created beside its dbt model.
  let target: { file: Loaded; model: UnknownRecord } | undefined;
  let created: { path: string; modelName: string; dir: string } | undefined;
  const knownColumns = new Map<string, string>();
  let modelNode: string | undefined;
  if (semanticOwner) {
    const model = listOf(semanticOwner.document, 'semantic_models').find((candidate) => candidate.name === semanticModelName)!;
    target = { file: semanticOwner, model };
    modelNode = refTarget(model.model);
  } else if (input.mode === 'edit') {
    issues.push(`Semantic model "${semanticModelName}" is not defined in the dbt project YAML.`);
  } else {
    const node = input.modelUniqueId && manifest ? asRecord(asRecord(manifest.nodes)[input.modelUniqueId]) : undefined;
    if (!input.modelUniqueId) issues.push(`Semantic model "${semanticModelName}" does not exist. Say which dbt model it is built on to create it.`);
    else if (!manifest) issues.push('No dbt manifest was found, so the dbt model cannot be looked up. Run dbt parse and try again.');
    else if (node?.resource_type !== 'model') issues.push(`dbt model not found: ${input.modelUniqueId}.`);
    else {
      modelNode = stringValue(node.name);
      const original = stringValue(node.original_file_path) ?? `models/${modelNode}.sql`;
      const dir = dirname(original).replace(/\\/g, '/');
      created = { modelName: modelNode ?? semanticModelName, dir, path: `${dir === '.' ? '' : `${dir}/`}${semanticModelName}_semantic.yml` };
      // A file at that path that the scan did not load (unparsable, over 2 MB, or outside model-paths) may hold
      // the semantic model or other content. Writing a new file over it would destroy it, so refuse.
      if (!loaded.has(created.path) && existsSync(resolve(root, created.path))) {
        issues.push(`${created.path} already exists but could not be read as dbt YAML (see warnings), so ZLens will not overwrite it. Fix or move that file, or add the semantic model there by hand.`);
      }
    }
    if (!input.primaryEntity?.name || !input.primaryEntity.column) issues.push('A new semantic model needs a primary entity (name and key column).');
    if (!input.timeDimension?.name || !input.timeDimension.column) issues.push('A new semantic model needs a time column for MetricFlow to aggregate over time.');
  }

  // Columns are checked against the dbt model when its columns are known; an undocumented model is unproven, not wrong.
  if (modelNode && manifest) {
    const uniqueId = Object.entries(asRecord(manifest.nodes)).find(([, node]) => asRecord(node).resource_type === 'model' && asRecord(node).name === modelNode)?.[0];
    for (const item of (uniqueId ? loadDbtNodeAuthoringDetail(manifestPath, uniqueId)?.columns : undefined) ?? []) knownColumns.set(item.name.toLowerCase(), item.name);
  }
  const checkColumn = (value: string, what: string): string => {
    if (!COLUMN.test(value)) { issues.push(`${what} column "${value}" must be a single column name.`); return value; }
    if (knownColumns.size === 0) return value;
    const known = knownColumns.get(value.toLowerCase());
    if (!known) issues.push(`Unknown column "${value}" for ${what} on dbt model "${modelNode}". Columns: ${[...knownColumns.values()].sort().join(', ')}.`);
    return known ?? value;
  };
  if (knownColumns.size === 0) warnings.push(`The columns of ${modelNode ? `dbt model "${modelNode}"` : 'the dbt model'} are not documented in the manifest, so column names were not checked.`);
  const measureColumn = checkColumn(column, 'the metric');

  const model = target?.model ?? {
    name: semanticModelName,
    model: `ref('${created?.modelName ?? semanticModelName}')`,
    defaults: { agg_time_dimension: input.timeDimension?.name },
    entities: input.primaryEntity ? [{ name: input.primaryEntity.name, type: 'primary', expr: checkColumn(input.primaryEntity.column, 'the primary entity') }] : [],
    dimensions: [] as UnknownRecord[],
    measures: [] as UnknownRecord[],
  };
  const dimensions = Array.isArray(model.dimensions) ? [...model.dimensions as unknown[]].map(asRecord) : [];
  const wanted = [
    ...(created && input.timeDimension ? [{ name: input.timeDimension.name, column: input.timeDimension.column, type: 'time' as const, timeGranularity: input.timeDimension.timeGranularity ?? 'day' }] : []),
    ...(input.dimensions ?? []),
  ];
  for (const requested of wanted) {
    const name = String(requested.name ?? '').trim();
    const dimensionColumn = String(requested.column ?? name).trim();
    if (!NAME.test(name)) { issues.push(`Dimension name "${name}" must be lowercase letters, digits and single underscores.`); continue; }
    if (requested.timeGranularity && !GRAINS.includes(requested.timeGranularity)) issues.push(`Dimension "${name}" has an unknown time granularity "${requested.timeGranularity}". Use one of: ${GRAINS.join(', ')}.`);
    const expr = checkColumn(dimensionColumn, `dimension "${name}"`);
    const existing = dimensions.find((dimension) => dimension.name === name);
    if (existing) {
      if (String(existing.expr ?? existing.name) !== expr) issues.push(`Dimension "${name}" already exists on "${semanticModelName}" with column "${String(existing.expr ?? existing.name)}".`);
      continue;
    }
    dimensions.push({
      name,
      type: requested.type === 'time' ? 'time' : 'categorical',
      ...(expr !== name ? { expr } : {}),
      ...(requested.type === 'time' ? { type_params: { time_granularity: requested.timeGranularity ?? 'day' } } : {}),
    });
  }
  const hasTime = dimensions.some((dimension) => dimension.type === 'time') && Boolean(asRecord(model.defaults).agg_time_dimension ?? input.timeDimension?.name);
  if (!hasTime) issues.push(`Semantic model "${semanticModelName}" has no aggregate time dimension (defaults.agg_time_dimension), which MetricFlow needs for a metric.`);
  if (issues.length) invalid(issues);

  const measures = Array.isArray(model.measures) ? [...model.measures as unknown[]].map(asRecord) : [];
  const measureIndex = measures.findIndex((measure) => measure.name === metricName);
  if (input.mode === 'edit' && measureIndex < 0) invalid([`Metric "${metricName}" does not use a measure of the same name on "${semanticModelName}"; edit it in dbt directly.`]);
  if (input.mode === 'edit') {
    const current = measures[measureIndex]!;
    const changesMeaning = String(current.agg ?? '').toLowerCase() !== aggregation || String(current.expr ?? current.name) !== measureColumn;
    // A measure's aggregation and column define every metric built on it (ratio, derived, cumulative, other simple
    // metrics), so changing them here would silently change those metrics too.
    const users = changesMeaning ? metricsReferencing(metricName, all, manifest) : [];
    if (users.length) {
      invalid([`The measure "${metricName}" is also used by ${users.map((name) => `"${name}"`).join(', ')}. Changing its aggregation or column would change ${users.length === 1 ? 'that metric' : 'those metrics'} too, so ZLens will not do it. Add a new metric with its own measure instead, or edit the dependants in dbt first.`]);
    }
  }
  const measure: UnknownRecord = {
    ...(measureIndex >= 0 ? measures[measureIndex] : {}),
    name: metricName,
    ...(metricInput.description?.trim() ? { description: metricInput.description.trim() } : {}),
    agg: aggregation,
    expr: measureColumn,
  };
  if (measureIndex >= 0) measures[measureIndex] = measure; else measures.push(measure);
  const nextModel: UnknownRecord = { ...model, dimensions, measures };

  // Place the semantic model and the metric; each touched file is written once.
  const edits = new Map<string, Loaded>();
  const touch = (file: Loaded): UnknownRecord => {
    const entry = edits.get(file.path) ?? { ...file, document: { ...file.document } };
    edits.set(file.path, entry);
    return entry.document;
  };
  if (target) {
    const document = touch(target.file);
    document.semantic_models = listOf(target.file.document, 'semantic_models').map((candidate) => (candidate.name === semanticModelName ? nextModel : candidate));
  } else if (created) {
    const existingFile = loaded.get(created.path);
    const document = touch(existingFile ?? { path: created.path, before: '', document: { version: 2 } });
    document.semantic_models = [...(existingFile ? listOf(existingFile.document, 'semantic_models') : []), nextModel];
  }
  const metricHome = metricOwner ?? target?.file ?? loaded.get(created?.path ?? '') ?? { path: created?.path ?? '', before: '', document: { version: 2 } };
  const metricDocument = touch(metricHome);
  const metrics = listOf(metricHome.document, 'metrics');
  const metricIndex = metrics.findIndex((metric) => metric.name === metricName);
  const existingMetric = metricIndex >= 0 ? metrics[metricIndex] : {};
  const domain = metricInput.domain?.trim();
  const synonyms: string[] = [];
  for (const raw of metricInput.synonyms ?? []) {
    const word = String(raw).trim();
    if (word && !synonyms.some((seen) => seen.toLowerCase() === word.toLowerCase())) synonyms.push(word);
  }
  const existingMeta = asRecord(asRecord(existingMetric.config).meta);
  // dql.authored marks a metric written here: ZLens reads it from the YAML until dbt parses it into the manifest.
  const meta: UnknownRecord = { ...existingMeta, ...(domain ? { domain } : {}), ...(synonyms.length ? { synonyms } : {}), dql: { ...asRecord(existingMeta.dql), authored: true } };
  const nextMetric: UnknownRecord = {
    ...existingMetric,
    name: metricName,
    label: metricInput.label?.trim() || metricName.split('_').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' '),
    ...(metricInput.description?.trim() ? { description: metricInput.description.trim() } : {}),
    type: 'simple',
    type_params: { ...asRecord(existingMetric.type_params), measure: metricName },
    ...(Object.keys(meta).length ? { config: { ...asRecord(existingMetric.config), meta } } : {}),
  };
  if (metricIndex >= 0) metrics[metricIndex] = nextMetric; else metrics.push(nextMetric);
  metricDocument.metrics = metrics;

  const patches: ModelingSourcePatch[] = [...edits.values()].map((entry) => {
    entry.document.version = typeof entry.document.version === 'number' ? entry.document.version : 2;
    const after = dumpYaml(entry.document);
    return { path: entry.path, before: entry.before, after, changed: entry.before !== after };
  });
  return { semanticModel: semanticModelName, metric: metricName, patches, fingerprint: hash({ input, patches }), warnings, writesTo: 'dbt' };
}

export function applyDbtMetricPatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtMetricAuthoringInput,
  expectedFingerprint: string,
): DbtMetricPatchPreview {
  const preview = previewDbtMetricPatch(dbtProjectRoot, manifestPath, input);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('dbt source changed after the preview. Refresh the source patch before applying.');
  }
  for (const patch of preview.patches.filter((item) => item.changed)) {
    const absolute = assertContainedPath(dbtProjectRoot, patch.path, 'dbt source patch');
    mkdirSync(dirname(absolute), { recursive: true });
    // Re-check after mkdir so a concurrently-created symlink cannot redirect the write outside the dbt project.
    assertContainedPath(dbtProjectRoot, patch.path, 'dbt source patch');
    writeFileSync(absolute, patch.after, 'utf8');
  }
  return preview;
}

// ── The project's own semantic layer ──────────────────────────────────────────────────────────────────────────────
// A project with `semanticLayer.provider: dql` keeps its semantic models in `semantic-layer/`, and that is all Ask reads.
// A metric for one of those models belongs beside them: written to dbt's YAML it would answer nothing, and would need
// a second, competing semantic model on the same dbt model.

interface NativeFile { path: string; before: string; document: UnknownRecord }
interface NativeModel { name: string; kind: 'semantic_model' | 'cube'; dbtModel?: string; file: NativeFile; record: UnknownRecord }

const NATIVE_SQL: Record<DbtMetricAggregation, (column: string) => string> = {
  sum: (column) => `SUM(${column})`,
  count: (column) => `COUNT(${column})`,
  count_distinct: (column) => `COUNT(DISTINCT ${column})`,
  average: (column) => `AVG(${column})`,
  min: (column) => `MIN(${column})`,
  max: (column) => `MAX(${column})`,
};

/** Each YAML file in one folder of the semantic layer, drafts left out, as `{ <key>: [...] }` or one object per file. */
function nativeFiles(projectRoot: string, semanticLayerDir: string, folder: string): NativeFile[] {
  const files: NativeFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === '_drafts') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.ya?ml$/i.test(entry.name)) continue;
      const before = readFileSync(full, 'utf8');
      let document: UnknownRecord;
      try { document = asRecord(yaml.load(before)); } catch { continue; }
      files.push({ path: relative(projectRoot, full).replace(/\\/g, '/'), before, document });
    }
  };
  walk(join(semanticLayerDir, folder));
  return files;
}

function nativeEntries(file: NativeFile, keys: string[]): { keyed: string | undefined; entries: UnknownRecord[] } {
  const keyed = keys.find((key) => Array.isArray(file.document[key]));
  return { keyed, entries: keyed ? listOf(file.document, keyed) : typeof file.document.name === 'string' ? [file.document] : [] };
}

/** The semantic layer's models: semantic models first, then cubes, the older way to say the same thing. */
function readNativeModels(projectRoot: string, semanticLayerDir: string): NativeModel[] {
  const read = (folder: string, keys: string[], kind: NativeModel['kind']): NativeModel[] => nativeFiles(projectRoot, semanticLayerDir, folder).flatMap((file) =>
    nativeEntries(file, keys).entries
      .filter((record) => typeof record.name === 'string')
      .map((record) => {
        const dbtModel = refTarget(record.model) ?? tableName(record.table);
        return { name: String(record.name), kind, ...(dbtModel ? { dbtModel } : {}), file, record };
      }));
  return [...read('semantic_models', ['semantic_models', 'semanticModels'], 'semantic_model'), ...read('cubes', ['cubes'], 'cube')];
}

/** The native model an Add metric change is for: named by the change, or sitting on its dbt model. */
function nativeModelFor(models: NativeModel[], input: DbtMetricAuthoringInput, dbtModelName: string | undefined): NativeModel | undefined {
  const wanted = String(input.semanticModel ?? '').trim();
  const on = (name: string | undefined) => (name ? models.find((model) => model.dbtModel?.toLowerCase() === name.toLowerCase()) : undefined);
  return models.find((model) => model.name === wanted) ?? on(dbtModelName) ?? on(wanted);
}

function dbtModelNameOf(manifestPath: string, root: string, uniqueId: string | undefined): string | undefined {
  if (!uniqueId || !existsSync(manifestPath)) return undefined;
  const node = asRecord(asRecord(readJson(assertContainedPath(root, manifestPath, 'dbt manifest')).nodes)[uniqueId]);
  return node.resource_type === 'model' ? stringValue(node.name) : undefined;
}

function previewNativeMetricPatch(paths: MetricAuthoringPaths & { semanticLayerDir: string }, input: DbtMetricAuthoringInput, target: NativeModel, models: NativeModel[]): DbtMetricPatchPreview {
  const issues: string[] = [];
  const warnings: string[] = [];
  const metricInput = input.metric ?? ({} as DbtMetricAuthoringInput['metric']);
  const metricName = String(metricInput.name ?? '').trim();
  const aggregationRaw = String(metricInput.aggregation ?? '').trim().toLowerCase();
  const aggregation = (aggregationRaw === 'avg' ? 'average' : aggregationRaw) as DbtMetricAggregation;
  const column = String(metricInput.column ?? '').trim();
  if (input.mode !== 'add' && input.mode !== 'edit') issues.push('mode must be "add" or "edit".');
  if (!NAME.test(metricName)) issues.push(`Metric name "${metricName}" must be lowercase letters, digits and single underscores, starting with a letter (for example average_claimed_amount).`);
  if (!DBT_METRIC_AGGREGATIONS.includes(aggregation)) issues.push(`Unsupported aggregation "${metricInput.aggregation ?? ''}". Use one of: ${DBT_METRIC_AGGREGATIONS.join(', ')}.`);
  if (!COLUMN.test(column)) issues.push(`Column "${column}" must be a single column name; expressions are not supported here.`);
  if (issues.length) invalid(issues);

  // The dbt model's documented columns, when there is one: an undocumented model is unproven, not wrong.
  const manifestRoot = resolve(paths.dbtProjectRoot);
  const manifest = existsSync(paths.manifestPath) ? readJson(assertContainedPath(manifestRoot, paths.manifestPath, 'dbt manifest')) : undefined;
  const uniqueId = input.modelUniqueId ?? Object.entries(asRecord(manifest?.nodes)).find(([, node]) => asRecord(node).resource_type === 'model' && asRecord(node).name === target.dbtModel)?.[0];
  const knownColumns = new Map<string, string>();
  for (const item of (manifest && uniqueId ? loadDbtNodeAuthoringDetail(paths.manifestPath, uniqueId)?.columns : undefined) ?? []) knownColumns.set(item.name.toLowerCase(), item.name);
  if (knownColumns.size === 0) warnings.push(`The columns of "${target.dbtModel ?? target.name}" are not documented in the manifest, so column names were not checked.`);
  const checkColumn = (value: string, what: string): string => {
    if (!COLUMN.test(value)) { issues.push(`${what} column "${value}" must be a single column name.`); return value; }
    if (knownColumns.size === 0) return value;
    const known = knownColumns.get(value.toLowerCase());
    if (!known) issues.push(`Unknown column "${value}" for ${what} on "${target.dbtModel ?? target.name}". Columns: ${[...knownColumns.values()].sort().join(', ')}.`);
    return known ?? value;
  };
  const measureColumn = checkColumn(column, 'the metric');

  const cube = target.kind === 'cube' ? target : models.find((model) => model.kind === 'cube' && (model.name === target.name || (target.dbtModel && model.dbtModel === target.dbtModel)));
  const metricFiles = nativeFiles(paths.projectRoot, paths.semanticLayerDir, 'metrics');
  const metricOwner = metricFiles.find((file) => nativeEntries(file, ['metrics']).entries.some((metric) => metric.name === metricName));
  if (input.mode === 'add' && metricOwner) issues.push(`A metric named "${metricName}" already exists in ${metricOwner.path}. Pick another name, or edit that metric.`);
  if (input.mode === 'add' && !metricOwner && cube && listOf(cube.record, 'measures').some((measure) => measure.name === metricName)) issues.push(`A measure named "${metricName}" already exists in ${cube.file.path}. Pick another name.`);
  if (input.mode === 'edit' && !metricOwner) issues.push(`There is no metric named "${metricName}" in the semantic layer to edit.`);

  const dimensions = (input.dimensions ?? []).map((requested) => {
    const name = String(requested.name ?? '').trim();
    if (!NAME.test(name)) issues.push(`Dimension name "${name}" must be lowercase letters, digits and single underscores.`);
    return { name, column: checkColumn(String(requested.column ?? name).trim(), `dimension "${name}"`) };
  });
  if (issues.length) invalid(issues);

  const table = String(cube?.record.table ?? target.record.table ?? target.dbtModel ?? target.name);
  const sql = NATIVE_SQL[aggregation](measureColumn);
  const type = aggregation === 'average' ? 'avg' : aggregation;
  const label = metricInput.label?.trim() || metricName.split('_').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
  const description = metricInput.description?.trim();
  const timeDimensions = [...listOf(cube?.record ?? {}, 'time_dimensions')];
  const aggTimeDimension = stringValue((timeDimensions.find((dimension) => dimension.primary_time === true) ?? timeDimensions[0])?.name)
    ?? (Array.isArray(target.record.time_dimensions) ? stringValue(target.record.time_dimensions[0]) : undefined);
  const synonyms = Array.from(new Set((metricInput.synonyms ?? []).map((word) => String(word).trim()).filter(Boolean)));
  const domain = metricInput.domain?.trim() || stringValue(cube?.record.domain ?? target.record.domain);
  const definition: UnknownRecord = {
    name: metricName,
    label,
    ...(description ? { description } : {}),
    ...(domain ? { domain } : {}),
    ...(cube ? { cube: cube.name } : {}),
    table,
    sql,
    type,
    aggregation,
    metric_type: 'simple',
    type_params: { measure: metricName },
    ...(aggTimeDimension ? { agg_time_dimension: aggTimeDimension } : {}),
    ...(synonyms.length ? { synonyms } : {}),
  };

  // Each touched file is written once, its other entries left as they are.
  const edits = new Map<string, NativeFile>();
  const touch = (file: NativeFile): UnknownRecord => {
    const entry = edits.get(file.path) ?? { ...file, document: { ...file.document } };
    edits.set(file.path, entry);
    return entry.document;
  };
  /** Changes the one entry `name` in its file: a keyed list keeps its other entries. */
  const update = (file: NativeFile, keys: string[], name: string, change: (record: UnknownRecord) => UnknownRecord) => {
    const document = touch(file);
    const { keyed, entries } = nativeEntries({ ...file, document }, keys);
    if (keyed) document[keyed] = entries.map((entry) => (entry.name === name ? change(entry) : entry));
    else Object.assign(document, change(document));
  };

  if (metricOwner) {
    update(metricOwner, ['metrics'], metricName, (metric) => ({ ...metric, ...definition }));
  } else {
    const sameModel = metricFiles.find((file) => {
      const { keyed, entries } = nativeEntries(file, ['metrics']);
      return keyed && entries.some((metric) => (cube ? metric.cube === cube.name : metric.table === table));
    });
    if (sameModel) {
      const document = touch(sameModel);
      document.metrics = [...listOf(sameModel.document, 'metrics'), definition];
    } else {
      const path = relative(paths.projectRoot, join(paths.semanticLayerDir, 'metrics', `${metricName}.yaml`)).replace(/\\/g, '/');
      Object.assign(touch({ path, before: '', document: {} }), definition);
    }
  }
  if (cube) {
    update(cube.file, ['cubes'], cube.name, (record) => {
      const measures = listOf(record, 'measures');
      const measure: UnknownRecord = { name: metricName, label, ...(description ? { description } : {}), sql, type, aggregation, ...(aggTimeDimension ? { agg_time_dimension: aggTimeDimension } : {}) };
      const known = listOf(record, 'dimensions');
      const added = dimensions.filter((dimension) => !known.some((existing) => existing.name === dimension.name))
        .map((dimension) => ({ name: dimension.name, label: titleOf(dimension.name), sql: dimension.column, type: 'string' }));
      return {
        ...record,
        measures: measures.some((item) => item.name === metricName) ? measures.map((item) => (item.name === metricName ? { ...item, ...measure } : item)) : [...measures, measure],
        ...(added.length ? { dimensions: [...known, ...added] } : {}),
      };
    });
  }
  if (target.kind === 'semantic_model') {
    update(target.file, ['semantic_models', 'semanticModels'], target.name, (record) => ({
      ...record,
      measures: Array.from(new Set([...(Array.isArray(record.measures) ? record.measures.map(String) : []), metricName])),
      ...(dimensions.length ? { dimensions: Array.from(new Set([...(Array.isArray(record.dimensions) ? record.dimensions.map(String) : []), ...dimensions.map((dimension) => dimension.name)])) } : {}),
    }));
  }

  const patches: ModelingSourcePatch[] = [...edits.values()].map((entry) => {
    const after = dumpYaml(entry.document);
    return { path: entry.path, before: entry.before, after, changed: entry.before !== after };
  });
  return { semanticModel: target.name, metric: metricName, patches, fingerprint: hash({ input, patches }), warnings, writesTo: 'semantic-layer' };
}

function titleOf(name: string): string {
  return name.split('_').filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

function resolveNativeTarget(paths: MetricAuthoringPaths, input: DbtMetricAuthoringInput): { dir: string; models: NativeModel[]; target: NativeModel } | undefined {
  const dir = paths.semanticLayerDir;
  if (!dir) return undefined;
  const models = readNativeModels(paths.projectRoot, dir);
  const target = nativeModelFor(models, input, dbtModelNameOf(paths.manifestPath, resolve(paths.dbtProjectRoot), input.modelUniqueId));
  return target ? { dir, models, target } : undefined;
}

/** Add metric's preview: into the project's own semantic model when one sits on the dbt model, else into dbt's YAML. */
export function previewProjectMetricPatch(paths: MetricAuthoringPaths, input: DbtMetricAuthoringInput): DbtMetricPatchPreview {
  const native = resolveNativeTarget(paths, input);
  return native
    ? previewNativeMetricPatch({ ...paths, semanticLayerDir: native.dir }, input, native.target, native.models)
    : previewDbtMetricPatch(paths.dbtProjectRoot, paths.manifestPath, input);
}

/** Add metric's apply: writes exactly what was previewed, or nothing if the files moved since. */
export function applyProjectMetricPatch(paths: MetricAuthoringPaths, input: DbtMetricAuthoringInput, expectedFingerprint: string): DbtMetricPatchPreview {
  const native = resolveNativeTarget(paths, input);
  if (!native) return applyDbtMetricPatch(paths.dbtProjectRoot, paths.manifestPath, input, expectedFingerprint);
  const preview = previewNativeMetricPatch({ ...paths, semanticLayerDir: native.dir }, input, native.target, native.models);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('The semantic layer changed after the preview. Refresh the preview before applying.');
  }
  for (const patch of preview.patches.filter((item) => item.changed)) {
    const absolute = assertContainedPath(paths.projectRoot, patch.path, 'semantic layer patch');
    mkdirSync(dirname(absolute), { recursive: true });
    assertContainedPath(paths.projectRoot, patch.path, 'semantic layer patch');
    writeFileSync(absolute, patch.after, 'utf8');
  }
  return preview;
}
