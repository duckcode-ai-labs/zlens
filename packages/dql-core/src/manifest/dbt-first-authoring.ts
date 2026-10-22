import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { domainFolderSlug, renderDomainDeclaration, type DomainInput } from './domain-writer.js';
import { loadDomainPackageRegistry } from './domain-package-registry.js';
import { WAREHOUSE_CATALOG_PATH, readWarehouseCatalog } from './warehouse-catalog.js';
import type {
  ManifestFanoutPolicy,
  ManifestModelLifecycle,
  ManifestRelationshipCardinality,
  ManifestRelationshipValidationEvidence,
  ManifestRelationshipValidationScope,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

const dbtJsonArtifactCache = new Map<string, { version: string; value: UnknownRecord }>();
let dbtJsonArtifactReads = 0;

/** PERF-001 instrumentation: physical dbt JSON parses since the last reset. */
export function resetDbtArtifactReadCount(): void {
  dbtJsonArtifactReads = 0;
}

/** PERF-001 instrumentation used by the ignored scale evidence harness. */
export function dbtArtifactReadCount(): number {
  return dbtJsonArtifactReads;
}

export interface DomainPackageAuthoringInput extends DomainInput {
  id: string;
  exports?: string[];
}

/**
 * A Model Area is one focused, reviewable source file inside a Domain Package.
 * It is intentionally not a second semantic model: entities and relationships
 * still compile into the domain-wide graph.
 */
export interface ModelAreaAuthoringInput {
  id: string;
  domain: string;
  name: string;
  description?: string;
  intentExamples?: string[];
  references?: string[];
}

export interface EntityBindingAuthoringInput {
  id: string;
  domain: string;
  dbtModel: string;
  /** Optional focused source area. Omit only for legacy/default model files. */
  areaId?: string;
  businessName?: string;
  businessContext?: string;
  conceptRefs?: string[];
  analyticalRole?: 'event' | 'dimension' | 'snapshot' | 'bridge' | 'unknown';
  status?: ManifestModelLifecycle;
  owner?: string;
  grain?: string;
  keys?: string[];
}

/**
 * The grains and keys of both models a relationship was certified against,
 * and, when the certify action recorded them, who certified it and when
 * (not part of the proof: a later change to grains or keys makes it stale,
 * and the date stays for "Changed since it was certified on …").
 */
export interface RelationshipCertifiedAgainst {
  from: { grain: string; keys: string[] };
  to: { grain: string; keys: string[] };
  certifiedAt?: string;
  certifiedBy?: string;
  certifiedByName?: string;
}

export interface RelationshipAuthoringInput {
  id: string;
  domain: string;
  /** Optional focused source area that owns this relationship. */
  areaId?: string;
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  status?: ManifestModelLifecycle;
  crossDomain?: boolean;
  owner?: string;
  certifiedAgainst?: RelationshipCertifiedAgainst;
  validation?: ManifestRelationshipValidationEvidence;
  ownerDomain?: string;
  verb?: string;
  description?: string;
  rationale?: string;
  roles?: { from?: string; to?: string };
  optionality?: { from: 'required' | 'optional' | 'unknown'; to: 'required' | 'optional' | 'unknown' };
  joinTypes?: Array<'left' | 'inner'>;
  aggregation?: { measuresFrom: string[]; dimensionsFrom: string[]; requiresPreAggregation?: boolean };
  temporal?: { factTime: string; validFrom: string; validTo?: string; openEnded?: boolean };
  attributionBlock?: string;
  importRefs?: string[];
  evidenceExpiresAt?: string;
  /** Share (0–1) of keyed "from" rows allowed to find no "to" row; omitted, the validator's default. */
  maxUnmatchedShare?: number;
  /** `referenced_keys`: judge uniqueness only over the keys the join reaches. */
  validationScope?: ManifestRelationshipValidationScope;
}

/** A business concept as authored: bindings describe where it lives; equivalences are typed mappings for a later, separately gated release. */
export interface ConceptAuthoringInput {
  id: string;
  domain: string;
  areaId?: string;
  name?: string;
  description?: string;
  synonyms?: string[];
  bindings: Array<{ entity: string; role?: 'canonical' | 'conformed'; grain?: string }>;
  rule?: string;
  equivalences?: Array<{ from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality?: 'one_to_one'; validFrom?: string; validTo?: string; status?: 'draft' | 'certified' }>;
  status?: ManifestModelLifecycle;
  owner?: string;
  origin?: 'manual' | 'ai_draft';
}

export interface ContractAuthoringInput {
  id: string;
  domain: string;
  entities: string[];
  blocks?: string[];
  status?: ManifestModelLifecycle;
  owner?: string;
  requiredEvaluation?: boolean;
  version?: number;
  grain?: string;
  metricRefs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  requiredFilters?: string[];
  purpose?: string;
  evaluationRefs?: string[];
}

export interface DomainExportAuthoringInput {
  id: string;
  domain: string;
  version?: number;
  entity?: string;
  metrics?: string[];
  blocks?: string[];
  allowedKeys?: string[];
  allowedDimensions?: string[];
  allowedFilters?: string[];
  purposes?: string[];
  consumerDomains?: string[];
  classification?: string;
  contract?: string;
  status?: ManifestModelLifecycle;
  owner?: string;
}

export interface DomainImportAuthoringInput {
  id?: string;
  domain: string;
  exportRef: string;
  purpose: string;
  status?: ManifestModelLifecycle;
  owner?: string;
}

export type ModelingAuthoringChange =
  | { operation: 'upsert_domain'; value: DomainPackageAuthoringInput }
  | { operation: 'upsert_area'; value: ModelAreaAuthoringInput }
  | { operation: 'upsert_entity'; value: EntityBindingAuthoringInput }
  | { operation: 'upsert_relationship'; value: RelationshipAuthoringInput }
  | { operation: 'upsert_contract'; value: ContractAuthoringInput }
  | { operation: 'upsert_export'; value: DomainExportAuthoringInput }
  | { operation: 'upsert_import'; value: DomainImportAuthoringInput }
  | { operation: 'upsert_concept'; value: ConceptAuthoringInput }
  // Removals. Modeling was upsert-only, so an entity, relationship or model
  // area authored by mistake could only be removed by hand-editing YAML.
  // Contract/export/import removal completes the set: every object the UI can
  // create, it can also retract through the same reviewed path.
  | { operation: 'remove_entity'; value: ModelingObjectRef }
  | { operation: 'remove_relationship'; value: ModelingObjectRef }
  | { operation: 'remove_area'; value: ModelingObjectRef }
  | { operation: 'remove_contract'; value: ModelingObjectRef }
  | { operation: 'remove_export'; value: ModelingObjectRef }
  | { operation: 'remove_import'; value: ModelingObjectRef }
  | { operation: 'remove_concept'; value: ModelingObjectRef }
  // Warehouse evidence for a relationship as authored (`zlens model
  // validate-relationship`): only the evidence, and on an explicit certify the
  // status and the grains certified against, change; every other authored
  // field stays exactly as written.
  | { operation: 'record_relationship_validation'; value: RelationshipValidationRecordInput };

/** The evidence one warehouse check wrote for an existing relationship. */
export interface RelationshipValidationRecordInput extends ModelingObjectRef {
  /** The authored file, as the manifest reports it (`sourcePath`); found by id within the domain when omitted. */
  sourcePath?: string;
  validation: ManifestRelationshipValidationEvidence;
  /** Set only when a person certifies with the check: the status becomes certified against these grains. */
  certifiedAgainst?: RelationshipCertifiedAgainst;
}

/** Identifies an authored modeling object for removal. */
export interface ModelingObjectRef {
  id: string;
  domain: string;
  /** Set when the object is owned by a Model Area rather than the domain root. */
  areaId?: string;
}

export interface ModelingSourcePatch {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface ModelingChangePreview {
  operation: ModelingAuthoringChange['operation'];
  patches: ModelingSourcePatch[];
  fingerprint: string;
}

export interface ModelingChangesPreview {
  operation: 'batch';
  changes: ModelingAuthoringChange[];
  patches: ModelingSourcePatch[];
  fingerprint: string;
  /**
   * Source paths each change touched, by its index in `changes`. Attribution is
   * captured inside the composed shadow because a change that depends on an
   * earlier one in the batch (an entity in a Domain the batch is still
   * creating) cannot be previewed standalone against the real project.
   */
  patchPathsByChange: string[][];
}

export interface DbtNodeAuthoringDetail {
  uniqueId: string;
  name: string;
  resourceType: 'model' | 'source' | 'warehouse';
  relation?: string;
  sourcePath?: string;
  description?: string;
  columns: Array<{
    name: string;
    type?: string;
    description?: string;
    tests: string[];
  }>;
  tests: string[];
  dqlMeta?: { grain?: string; keys: string[] };
}

/** A dbt-owned documentation/test edit. ZLens only plans and applies a source
 * YAML patch; it never mutates manifest.json or mirrors these fields into a
 * Domain Package. */
export interface DbtSourceAuthoringInput {
  uniqueId: string;
  description?: string;
  columns?: Array<{ name: string; description?: string; tests?: string[] }>;
}

export interface DbtSourcePatchPreview {
  uniqueId: string;
  patch: ModelingSourcePatch;
  fingerprint: string;
}

export function previewDbtSourcePatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtSourceAuthoringInput,
): DbtSourcePatchPreview {
  const root = resolve(dbtProjectRoot);
  const manifest = readJson(assertContainedPath(root, manifestPath, 'dbt manifest'));
  const raw = asRecord(asRecord(manifest.nodes)[input.uniqueId]);
  if (raw.resource_type !== 'model') throw new Error(`dbt model not found: ${input.uniqueId}`);
  const name = requiredId(stringValue(raw.name), 'dbt model');
  const patchPath = dbtPatchRelativePath(raw, name);
  const absolute = assertContainedPath(root, patchPath, 'dbt source patch');
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const document = before.trim() ? asRecord(yaml.load(before)) : { version: 2 };
  const models = Array.isArray(document.models) ? [...document.models as unknown[]] : [];
  const index = models.findIndex((entry) => asRecord(entry).name === name);
  const model: UnknownRecord = index >= 0 ? { ...asRecord(models[index]) } : { name };
  if (input.description !== undefined) model.description = input.description;
  if (input.columns) {
    const columns = Array.isArray(model.columns) ? [...model.columns as unknown[]] : [];
    for (const requested of input.columns) {
      const columnName = requiredId(requested.name, 'dbt column');
      const columnIndex = columns.findIndex((entry) => asRecord(entry).name === columnName);
      const column: UnknownRecord = columnIndex >= 0 ? { ...asRecord(columns[columnIndex]) } : { name: columnName };
      if (requested.description !== undefined) column.description = requested.description;
      if (requested.tests !== undefined) column.data_tests = cleanStrings(requested.tests);
      if (columnIndex >= 0) columns[columnIndex] = column;
      else columns.push(column);
    }
    model.columns = columns;
  }
  if (index >= 0) models[index] = model;
  else models.push(model);
  document.version = typeof document.version === 'number' ? document.version : 2;
  document.models = models;
  const after = dumpYaml(document);
  const patch = { path: patchPath, before, after, changed: before !== after };
  return {
    uniqueId: input.uniqueId,
    patch,
    fingerprint: hash({ uniqueId: input.uniqueId, path: patchPath, before, after }),
  };
}

export function applyDbtSourcePatch(
  dbtProjectRoot: string,
  manifestPath: string,
  input: DbtSourceAuthoringInput,
  expectedFingerprint: string,
): DbtSourcePatchPreview {
  const preview = previewDbtSourcePatch(dbtProjectRoot, manifestPath, input);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('dbt source changed after the preview. Refresh the source patch before applying.');
  }
  if (preview.patch.changed) {
    const absolute = assertContainedPath(dbtProjectRoot, preview.patch.path, 'dbt source patch');
    mkdirSync(dirname(absolute), { recursive: true });
    // Re-check after mkdir so a concurrently-created symlink cannot redirect
    // the final write outside the dbt project.
    assertContainedPath(dbtProjectRoot, preview.patch.path, 'dbt source patch');
    writeFileSync(absolute, preview.patch.after, 'utf8');
  }
  return preview;
}

export function previewModelingChange(projectRoot: string, change: ModelingAuthoringChange): ModelingChangePreview {
  const root = resolve(projectRoot);
  // An explicit switch with a real default: the previous nested ternary fell
  // through to `previewImport`, so a mistyped operation was silently treated
  // as a domain import rather than rejected.
  const patches = ((): ModelingSourcePatch[] => {
    switch (change.operation) {
      case 'upsert_domain': return previewDomain(root, change.value);
      case 'upsert_area': return [previewArea(root, change.value)];
      case 'upsert_entity': return previewEntity(root, change.value);
      case 'upsert_relationship': return previewRelationship(root, change.value);
      case 'upsert_contract': return [previewContract(root, change.value)];
      case 'upsert_export': return [previewExport(root, change.value)];
      case 'upsert_import': return [previewImport(root, change.value)];
      case 'remove_entity': return [previewRemoveListEntry(root, change.value, 'entities.dql.yaml', 'entities')];
      case 'remove_relationship': return [previewRemoveListEntry(root, change.value, 'relationships.dql.yaml', 'relationships')];
      case 'remove_area': return previewRemoveArea(root, change.value);
      case 'remove_contract': return [previewRemoveListEntry(root, change.value, 'contracts.dql.yaml', 'contracts')];
      case 'remove_export': return [previewRemoveListEntry(root, change.value, 'interfaces.dql.yaml', 'exports')];
      case 'remove_import': return [previewRemoveListEntry(root, change.value, 'interfaces.dql.yaml', 'imports')];
      case 'upsert_concept': return [previewConcept(root, change.value)];
      case 'remove_concept': return [previewRemoveListEntry(root, change.value, 'concepts.dql.yaml', 'concepts')];
      case 'record_relationship_validation': return [previewRelationshipValidationRecord(root, change.value)];
      default: {
        const unsupported: never = change;
        throw new Error(`Unsupported modeling operation: ${(unsupported as { operation?: string }).operation ?? 'unknown'}`);
      }
    }
  })();
  return {
    operation: change.operation,
    patches,
    fingerprint: hash(patches.map((patch) => ({ path: patch.path, before: patch.before, after: patch.after }))),
  };
}

/**
 * Compose an ordered batch against a disposable Domain Package shadow. This is
 * intentionally write-free for the real project and avoids the lost-update bug
 * caused by independently previewing two changes that target the same YAML file.
 */
export function previewModelingChanges(
  projectRoot: string,
  changes: ModelingAuthoringChange[],
): ModelingChangesPreview {
  const root = resolve(projectRoot);
  const shadow = mkdtempSync(join(tmpdir(), 'dql-modeling-preview-'));
  try {
    for (const configName of ['dql.config.json', 'dql.config.yaml', 'dql.config.yml']) {
      const source = join(root, configName);
      if (existsSync(source)) cpSync(source, join(shadow, configName));
    }
    const domains = join(root, 'domains');
    if (existsSync(domains)) cpSync(domains, join(shadow, 'domains'), { recursive: true, dereference: false });
    // Warehouse-first and hybrid entities are written with the relation as the
    // warehouse spells it, which the catalog snapshot supplies.
    const warehouseCatalog = join(root, WAREHOUSE_CATALOG_PATH);
    if (existsSync(warehouseCatalog)) {
      mkdirSync(dirname(join(shadow, WAREHOUSE_CATALOG_PATH)), { recursive: true });
      cpSync(warehouseCatalog, join(shadow, WAREHOUSE_CATALOG_PATH));
    }
    const touched = new Set<string>();
    const patchPathsByChange: string[][] = [];
    for (const change of changes) {
      const preview = previewModelingChange(shadow, change);
      for (const patch of preview.patches) touched.add(patch.path);
      patchPathsByChange.push(preview.patches.map((patch) => patch.path));
      applyModelingChange(shadow, change, preview.fingerprint);
    }
    const patches = [...touched].sort().map((path): ModelingSourcePatch => {
      const beforePath = safeProjectPath(root, path);
      const afterPath = safeProjectPath(shadow, path);
      const before = existsSync(beforePath) ? readFileSync(beforePath, 'utf8') : '';
      const after = existsSync(afterPath) ? readFileSync(afterPath, 'utf8') : '';
      return { path, before, after, changed: before !== after };
    });
    return {
      operation: 'batch',
      changes,
      patches,
      fingerprint: hash(patches.map(({ path, before, after }) => ({ path, before, after }))),
      patchPathsByChange,
    };
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

/** Apply exactly one reviewed batch, rolling every changed file back on error. */
export function applyModelingChanges(
  projectRoot: string,
  changes: ModelingAuthoringChange[],
  expectedFingerprint: string,
): ModelingChangesPreview {
  const preview = previewModelingChanges(projectRoot, changes);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    throw new Error('Modeling source changed after the batch preview. Refresh the proposal before applying.');
  }
  const written: ModelingSourcePatch[] = [];
  try {
    for (const patch of preview.patches) {
      if (!patch.changed) continue;
      const absolute = safeProjectPath(projectRoot, patch.path);
      if (!patch.after) rmSync(absolute, { force: true });
      else {
        mkdirSync(dirname(absolute), { recursive: true });
        safeProjectPath(projectRoot, patch.path);
        writeFileSync(absolute, patch.after, 'utf8');
      }
      written.push(patch);
    }
  } catch (error) {
    for (const patch of written.reverse()) {
      const absolute = safeProjectPath(projectRoot, patch.path);
      if (!patch.before) rmSync(absolute, { force: true });
      else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, patch.before, 'utf8');
      }
    }
    throw error;
  }
  return preview;
}

export function applyModelingChange(
  projectRoot: string,
  change: ModelingAuthoringChange,
  expectedFingerprint?: string,
): ModelingChangePreview {
  const preview = previewModelingChange(projectRoot, change);
  if (expectedFingerprint && preview.fingerprint !== expectedFingerprint) {
    throw new Error('Modeling source changed after the preview. Refresh the preview before applying.');
  }
  for (const patch of preview.patches) {
    if (!patch.changed) continue;
    const absolute = safeProjectPath(projectRoot, patch.path);
    // An empty `after` means the source itself is being removed (deleting a
    // Model Area). Writing an empty file would leave a stray, un-parseable
    // artifact behind instead of removing the object.
    if (patch.after === '' && patch.before !== '') {
      rmSync(absolute, { force: true });
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    safeProjectPath(projectRoot, patch.path);
    writeFileSync(absolute, patch.after, 'utf8');
  }
  return preview;
}

/** Whether a provenance id names a warehouse relation rather than a dbt node. */
export function isWarehouseNodeId(uniqueId: string): boolean {
  return uniqueId.startsWith('warehouse.');
}

/** A warehouse relation's authoring detail, from the project's catalog snapshot. */
export function loadWarehouseNodeAuthoringDetail(projectRoot: string, uniqueId: string): DbtNodeAuthoringDetail | undefined {
  const relation = readWarehouseCatalog(projectRoot).snapshot?.relations.find((item) => item.id === uniqueId);
  if (!relation) return undefined;
  return {
    uniqueId,
    name: relation.name,
    resourceType: 'warehouse',
    relation: relation.relation,
    ...(relation.comment ? { description: relation.comment } : {}),
    columns: relation.columns.map((column) => ({
      name: column.name,
      ...(column.type ? { type: column.type } : {}),
      ...(column.comment ? { description: column.comment } : {}),
      tests: [],
    })),
    tests: [],
    ...(relation.primaryKey?.length ? { dqlMeta: { grain: relation.primaryKey.join(', '), keys: relation.primaryKey } } : {}),
  };
}

export function loadDbtNodeAuthoringDetail(manifestPath: string, uniqueId: string): DbtNodeAuthoringDetail | undefined {
  const manifest = readJson(manifestPath);
  const raw = asRecord(asRecord(manifest.nodes)[uniqueId] ?? asRecord(manifest.sources)[uniqueId]);
  if (Object.keys(raw).length === 0) return undefined;
  const resourceType = raw.resource_type === 'source' ? 'source' : raw.resource_type === 'model' ? 'model' : undefined;
  if (!resourceType) return undefined;
  const catalogPath = join(dirname(manifestPath), 'catalog.json');
  const catalog = existsSync(catalogPath) ? readJson(catalogPath) : {};
  const catalogEntry = asRecord(asRecord(catalog[resourceType === 'source' ? 'sources' : 'nodes'])[uniqueId]);
  const catalogColumns = asRecord(catalogEntry.columns);
  const manifestColumns = asRecord(raw.columns);
  const childMap = asRecord(manifest.child_map);
  const childIds = Array.isArray(childMap[uniqueId]) ? childMap[uniqueId] as unknown[] : [];
  const testNodes = asRecord(manifest.nodes);
  const childTests = childIds
    .map((id) => asRecord(testNodes[String(id)]))
    .filter((node) => node.resource_type === 'test');
  const modelTests = childTests
    .map((node) => String(node.name ?? node.unique_id ?? 'test'))
    .sort();
  const testsByColumn = new Map<string, string[]>();
  for (const node of childTests) {
    const metadata = asRecord(node.test_metadata);
    const kwargs = asRecord(metadata.kwargs);
    const columnName = stringValue(node.column_name) ?? stringValue(kwargs.column_name);
    if (!columnName) continue;
    const name = stringValue(metadata.name) ?? stringValue(node.name) ?? 'test';
    testsByColumn.set(columnName, [...(testsByColumn.get(columnName) ?? []), name]);
  }
  const names = new Set([...Object.keys(manifestColumns), ...Object.keys(catalogColumns)]);
  const columns = [...names].sort().map((name) => {
    const manifestColumn = asRecord(manifestColumns[name]);
    const catalogColumn = asRecord(catalogColumns[name]);
    return {
      name,
      type: stringValue(catalogColumn.type),
      description: stringValue(manifestColumn.description),
      tests: [...new Set([...stringArray(manifestColumn.tests), ...(testsByColumn.get(name) ?? [])])].sort(),
    };
  });
  const dqlMeta = asRecord(asRecord(raw.meta).dql);
  return {
    uniqueId,
    name: stringValue(raw.alias) ?? stringValue(raw.identifier) ?? stringValue(raw.name) ?? uniqueId,
    resourceType,
    relation: relationName(raw),
    sourcePath: stringValue(raw.original_file_path) ?? stringValue(raw.path),
    description: stringValue(raw.description),
    columns,
    tests: modelTests,
    dqlMeta: Object.keys(dqlMeta).length > 0
      ? { grain: stringValue(dqlMeta.grain), keys: stringArray(dqlMeta.keys ?? dqlMeta.key ?? dqlMeta.primary_key) }
      : undefined,
  };
}

function previewDomain(projectRoot: string, value: DomainPackageAuthoringInput): ModelingSourcePatch[] {
  const id = requiredId(value.id, 'domain');
  const root = packageRootForWrite(projectRoot, id, value.parent);
  const declarationPath = relative(projectRoot, join(root, 'domain.dql')).replace(/\\/g, '/');
  return [
    sourcePatch(projectRoot, declarationPath, renderDomainDeclaration({
      ...value,
      id,
      name: value.name || id.split('.').at(-1) || id,
      exports: cleanStrings(value.exports),
    })),
  ];
}

function previewArea(projectRoot: string, value: ModelAreaAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'model area');
  const domain = requiredId(value.domain, 'domain');
  const path = modelAreaSourceFile(projectRoot, domain, id);
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const document = before.trim() ? asRecord(yaml.load(before)) : {};
  const existing = asRecord(document.area);
  document.domain = domain;
  document.area = {
    ...existing,
    id,
    name: value.name.trim() || id,
    ...(value.description?.trim() ? { description: value.description.trim() } : {}),
    ...(cleanStrings(value.intentExamples).length > 0 ? { intent_examples: cleanStrings(value.intentExamples) } : {}),
    ...(cleanStrings(value.references).length > 0 ? { references: cleanStrings(value.references) } : {}),
  };
  const after = dumpYaml(document);
  return { path, before, after, changed: before !== after };
}

function previewEntity(projectRoot: string, value: EntityBindingAuthoringInput): ModelingSourcePatch[] {
  const id = requiredId(value.id, 'entity');
  const domain = requiredId(value.domain, 'domain');
  const dbtModel = requiredId(value.dbtModel, 'dbt model');
  const path = modelingSourceFile(projectRoot, domain, 'entities.dql.yaml', 'entities', 'id', id, value.areaId);
  // A warehouse relation (warehouse-first or hybrid modeling) is bound with
  // `relation:` as the warehouse spells it; a dbt node keeps `dbt_model:`.
  const binding: UnknownRecord = isWarehouseNodeId(dbtModel)
    ? { relation: readWarehouseCatalog(projectRoot).snapshot?.relations.find((relation) => relation.id === dbtModel)?.relation ?? dbtModel }
    : { dbt_model: dbtModel };
  const entity: UnknownRecord = {
    id,
    ...binding,
    ...(value.businessName?.trim() ? { business_name: value.businessName.trim() } : {}),
    ...(value.businessContext?.trim() ? { business_context: value.businessContext.trim() } : {}),
    ...(cleanStrings(value.conceptRefs).length > 0 ? { concept_refs: cleanStrings(value.conceptRefs) } : {}),
    ...(value.analyticalRole ? { analytical_role: value.analyticalRole } : {}),
    ...(value.status ? { status: canonicalLifecycle(value.status) } : {}),
    ...(value.owner?.trim() ? { owner: value.owner.trim() } : {}),
    ...(value.grain ? { grain: value.grain } : {}),
    ...(cleanStrings(value.keys).length > 0 ? { keys: cleanStrings(value.keys) } : {}),
  };
  return upsertMovingListPatches(projectRoot, domain, path, 'entities', entity);
}

function previewRelationship(projectRoot: string, value: RelationshipAuthoringInput): ModelingSourcePatch[] {
  const id = requiredId(value.id, 'relationship');
  const domain = requiredId(value.domain, 'domain');
  if (!value.from || !value.to || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error('Relationship requires from, to, and at least one key pair.');
  }
  const relationship: UnknownRecord = {
    id,
    from: value.from,
    to: value.to,
    keys: value.keys.map((key) => ({ from: key.from, to: key.to })),
    cardinality: value.cardinality,
    fanout: canonicalFanout(value.fanout),
    status: canonicalLifecycle(value.status),
    ...(value.crossDomain ? { crossDomain: true } : {}),
    ...(value.owner ? { owner: value.owner } : {}),
    ...(value.ownerDomain ? { owner_domain: value.ownerDomain } : {}),
    ...(value.verb ? { verb: value.verb } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.rationale ? { rationale: value.rationale } : {}),
    ...(value.roles ? { roles: value.roles } : {}),
    ...(value.optionality ? { optionality: value.optionality } : {}),
    ...(value.joinTypes?.length ? { join_types: value.joinTypes } : {}),
    ...(value.aggregation ? { aggregation: {
      measures_from: cleanStrings(value.aggregation.measuresFrom),
      dimensions_from: cleanStrings(value.aggregation.dimensionsFrom),
      ...(value.aggregation.requiresPreAggregation ? { requires_pre_aggregation: true } : {}),
    } } : {}),
    ...(value.temporal ? { temporal: {
      fact_time: value.temporal.factTime,
      valid_from: value.temporal.validFrom,
      ...(value.temporal.validTo ? { valid_to: value.temporal.validTo } : {}),
      ...(value.temporal.openEnded ? { open_ended: true } : {}),
    } } : {}),
    ...(value.attributionBlock ? { attribution_block: value.attributionBlock } : {}),
    ...(value.importRefs?.length ? { imports: cleanStrings(value.importRefs) } : {}),
    ...(value.evidenceExpiresAt ? { evidence_expires_at: value.evidenceExpiresAt } : {}),
    ...(value.maxUnmatchedShare !== undefined ? { max_unmatched_share: value.maxUnmatchedShare } : {}),
    ...(value.validationScope ? { validation_scope: value.validationScope } : {}),
    ...(value.certifiedAgainst ? { certifiedAgainst: value.certifiedAgainst } : {}),
    ...(value.validation ? { validation: validationSource(value.validation) } : {}),
  };
  return upsertMovingListPatches(projectRoot, domain, modelingSourceFile(projectRoot, domain, 'relationships.dql.yaml', 'relationships', 'id', id, value.areaId), 'relationships', relationship);
}

function previewRelationshipValidationRecord(projectRoot: string, value: RelationshipValidationRecordInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'relationship');
  const domain = requiredId(value.domain, 'domain');
  const areaId = value.areaId?.includes('::') ? value.areaId.split('::').pop() : value.areaId;
  const path = value.sourcePath?.trim()
    ? value.sourcePath.trim().replace(/\\/g, '/')
    : modelingSourceFile(projectRoot, domain, 'relationships.dql.yaml', 'relationships', 'id', id, areaId?.trim() || undefined);
  if (!/\.dql\.ya?ml$/.test(path)) throw new Error(`Relationship evidence is written only to a modeling YAML file, not ${path}.`);
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const list = before.trim() ? asRecord(yaml.load(before)).relationships : undefined;
  if (!Array.isArray(list) || !list.some((entry) => asRecord(entry).id === id)) {
    throw new Error(`Relationship "${id}" is not authored in domain "${domain}"; evidence is recorded only for an existing relationship.`);
  }
  return upsertListPatch(projectRoot, path, 'relationships', 'id', {
    id,
    validation: validationSource(value.validation),
    ...(value.certifiedAgainst ? { status: 'certified', certifiedAgainst: value.certifiedAgainst } : {}),
  });
}

function previewConcept(projectRoot: string, value: ConceptAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'concept');
  const domain = requiredId(value.domain, 'domain');
  const bindings = (value.bindings ?? []).filter((binding) => binding.entity?.trim()).map((binding) => ({
    entity: binding.entity.trim(),
    ...(binding.role ? { role: binding.role } : {}),
    ...(binding.grain?.trim() ? { grain: binding.grain.trim() } : {}),
  }));
  if (bindings.length === 0) throw new Error(`Concept "${id}" needs at least one entity binding.`);
  const equivalences = (value.equivalences ?? []).map((equivalence) => ({
    from: equivalence.from, to: equivalence.to,
    keys: equivalence.keys.map((pair) => ({ from: pair.from, to: pair.to })),
    cardinality: equivalence.cardinality ?? 'one_to_one',
    ...(equivalence.validFrom ? { valid_from: equivalence.validFrom } : {}),
    ...(equivalence.validTo ? { valid_to: equivalence.validTo } : {}),
    status: equivalence.status ?? 'draft',
  }));
  const concept: UnknownRecord = {
    id,
    ...(value.name?.trim() ? { name: value.name.trim() } : {}),
    ...(value.description?.trim() ? { description: value.description.trim() } : {}),
    ...(cleanStrings(value.synonyms).length ? { synonyms: cleanStrings(value.synonyms) } : {}),
    bindings,
    ...(value.rule?.trim() ? { rule: value.rule.trim() } : {}),
    ...(equivalences.length ? { equivalences } : {}),
    status: canonicalLifecycle(value.status),
    ...(value.owner?.trim() ? { owner: value.owner.trim() } : {}),
    origin: value.origin ?? 'manual',
  };
  return upsertListPatch(projectRoot, modelingSourceFile(projectRoot, domain, 'concepts.dql.yaml', 'concepts', 'id', id, value.areaId), 'concepts', 'id', concept);
}

function previewContract(projectRoot: string, value: ContractAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'contract');
  const domain = requiredId(value.domain, 'domain');
  const contract: UnknownRecord = {
    id,
    entities: cleanStrings(value.entities),
    blocks: cleanStrings(value.blocks),
    status: canonicalLifecycle(value.status),
    ...(value.owner ? { owner: value.owner } : {}),
    requiredEvaluation: value.requiredEvaluation !== false,
    version: value.version ?? 1,
    ...(value.grain ? { grain: value.grain } : {}),
    ...(value.metricRefs?.length ? { metrics: cleanStrings(value.metricRefs) } : {}),
    ...(value.dimensions?.length ? { dimensions: cleanStrings(value.dimensions) } : {}),
    ...(value.allowedFilters?.length ? { allowed_filters: cleanStrings(value.allowedFilters) } : {}),
    ...(value.requiredFilters?.length ? { required_filters: cleanStrings(value.requiredFilters) } : {}),
    ...(value.purpose ? { purpose: value.purpose } : {}),
    ...(value.evaluationRefs?.length ? { evaluations: cleanStrings(value.evaluationRefs) } : {}),
  };
  return upsertListPatch(projectRoot, modelingSourceFile(projectRoot, domain, 'contracts.dql.yaml', 'contracts', 'id', id), 'contracts', 'id', contract);
}

function previewExport(projectRoot: string, value: DomainExportAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'domain export');
  const domain = requiredId(value.domain, 'domain');
  const exported: UnknownRecord = {
    id,
    version: value.version ?? 1,
    ...(value.entity ? { entity: value.entity } : {}),
    metrics: cleanStrings(value.metrics),
    blocks: cleanStrings(value.blocks),
    allowed_keys: cleanStrings(value.allowedKeys),
    allowed_dimensions: cleanStrings(value.allowedDimensions),
    allowed_filters: cleanStrings(value.allowedFilters),
    purposes: cleanStrings(value.purposes),
    consumer_domains: cleanStrings(value.consumerDomains),
    ...(value.classification ? { classification: value.classification } : {}),
    ...(value.contract ? { contract: value.contract } : {}),
    status: canonicalLifecycle(value.status),
    ...(value.owner ? { owner: value.owner } : {}),
  };
  return upsertListPatch(projectRoot, modelingSourceFile(projectRoot, domain, 'interfaces.dql.yaml', 'exports', 'id', id), 'exports', 'id', exported);
}

function previewImport(projectRoot: string, value: DomainImportAuthoringInput): ModelingSourcePatch {
  const domain = requiredId(value.domain, 'domain');
  const exportRef = requiredId(value.exportRef.replace('@', '.v'), 'domain export reference').replace(/\.v(\d+)$/, '@$1');
  const id = value.id?.trim() || `${domain}:${exportRef}`;
  const imported: UnknownRecord = {
    id,
    export: exportRef,
    purpose: value.purpose,
    status: canonicalLifecycle(value.status),
    ...(value.owner ? { owner: value.owner } : {}),
  };
  return upsertListPatch(projectRoot, modelingSourceFile(projectRoot, domain, 'interfaces.dql.yaml', 'imports', 'id', id), 'imports', 'id', imported);
}

function validationSource(value: ManifestRelationshipValidationEvidence): UnknownRecord {
  return {
    status: value.status,
    checked_at: value.checkedAt,
    query_fingerprint: value.queryFingerprint,
    ...(value.proofFingerprint ? { proof_fingerprint: value.proofFingerprint } : {}),
    from_rows: value.fromRows,
    to_rows: value.toRows,
    joined_rows: value.joinedRows,
    from_null_keys: value.fromNullKeys,
    to_null_keys: value.toNullKeys,
    unmatched_from: value.unmatchedFrom,
    max_from_per_key: value.maxFromPerKey,
    max_to_per_key: value.maxToPerKey,
    ...(value.unmatchedKeyedFrom !== undefined ? { unmatched_keyed_from: value.unmatchedKeyedFrom } : {}),
    ...(value.unmatchedKeyValues !== undefined ? { unmatched_key_values: value.unmatchedKeyValues } : {}),
    ...(value.unmatchedShare !== undefined ? { unmatched_share: value.unmatchedShare } : {}),
    ...(value.maxUnmatchedShare !== undefined ? { max_unmatched_share: value.maxUnmatchedShare } : {}),
    ...(value.maxToPerReferencedKey !== undefined ? { max_to_per_referenced_key: value.maxToPerReferencedKey } : {}),
    ...(value.maxFromPerReferencedKey !== undefined ? { max_from_per_referenced_key: value.maxFromPerReferencedKey } : {}),
    ...(value.scope ? { scope: value.scope } : {}),
    ...(value.message ? { message: value.message } : {}),
  };
}

/**
 * Upsert an entity or relationship into `path`, MOVING it there when another
 * modeling file of the same domain already declares the same id.
 *
 * An id is unique within a Domain Package. Certifying a join that discovery
 * drafted into `modeling/model.dql.yaml` writes it to the subject area the
 * editor names (`modeling/areas/core.dql.yaml`); upserting there alone left the
 * draft behind, and `zlens model validate` then failed with a duplicate
 * relationship. The other declaration is removed in the same change, and its
 * fields the editor does not set are carried over, as an in-place edit keeps
 * them.
 */
function upsertMovingListPatches(
  projectRoot: string,
  domain: string,
  path: string,
  listKey: 'entities' | 'relationships',
  value: UnknownRecord,
): ModelingSourcePatch[] {
  const id = value.id;
  const root = findPackageRoot(projectRoot, domain);
  const target = path.replace(/\\/g, '/');
  const removals: ModelingSourcePatch[] = [];
  let carried: UnknownRecord | undefined;
  for (const candidate of root ? modelingYamlFiles(join(root, 'modeling')) : []) {
    const relativePath = relative(projectRoot, candidate).replace(/\\/g, '/');
    if (relativePath === target) continue;
    const before = readFileSync(candidate, 'utf8');
    const document = asRecord(yaml.load(before));
    const list = Array.isArray(document[listKey]) ? document[listKey] as unknown[] : [];
    const kept = list.filter((entry) => asRecord(entry).id !== id);
    if (kept.length === list.length) continue;
    carried ??= asRecord(list.find((entry) => asRecord(entry).id === id));
    document[listKey] = kept;
    const after = dumpYaml(document);
    removals.push({ path: relativePath, before, after, changed: before !== after });
  }
  return [...removals, upsertListPatch(projectRoot, path, listKey, 'id', value, carried)];
}

function upsertListPatch(
  projectRoot: string,
  path: string,
  listKey: string,
  identityKey: string,
  value: UnknownRecord,
  /** The same object as declared in another file it is moving from: its fields the value does not set are kept. */
  carried?: UnknownRecord,
): ModelingSourcePatch {
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const document = before.trim() ? asRecord(yaml.load(before)) : {};
  const list = Array.isArray(document[listKey]) ? [...document[listKey] as unknown[]] : [];
  const index = list.findIndex((entry) => asRecord(entry)[identityKey] === value[identityKey]);
  // Preserve fields the focused UI does not currently edit. This keeps an
  // entity or relationship authored in a small Model Area from losing its
  // advanced DQL policy when a user updates its business context or keys.
  if (index >= 0) list[index] = { ...asRecord(list[index]), ...value };
  else if (carried) list.push({ ...carried, ...value });
  // Append rather than re-sorting the whole list. Sorting by id on every upsert
  // turned a one-field edit into a whole-file diff and discarded the grouping
  // the author chose, which matters for a Git-backed file people hand-edit.
  else list.push(value);
  document[listKey] = list;
  const after = dumpYaml(document);
  return { path, before, after, changed: before !== after };
}

/**
 * Drop one entry from an authored modeling list.
 *
 * Removing the last entry leaves the list key present but empty rather than
 * deleting the file: the file is the domain's authored source, and silently
 * removing it would lose any sibling content and read as data loss in git.
 */
function previewRemoveListEntry(
  projectRoot: string,
  ref: ModelingObjectRef,
  legacyName: string,
  listKey: string,
): ModelingSourcePatch {
  const id = requiredId(ref.id, listKey);
  const domain = requiredId(ref.domain, 'domain');
  // Callers hold the QUALIFIED area id (`commerce::model_area::revenue`) while
  // the source-file resolver wants the local segment. Reduce it, and when there
  // is none fall through to the resolver's own search, which finds whichever
  // file actually declares this id — more robust than trusting a stale hint.
  const areaId = ref.areaId?.includes('::') ? ref.areaId.split('::').pop() : ref.areaId;
  const path = modelingSourceFile(projectRoot, domain, legacyName, listKey, 'id', id, areaId?.trim() || undefined);
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  if (!before.trim()) return { path, before, after: before, changed: false };
  const document = asRecord(yaml.load(before));
  const list = Array.isArray(document[listKey]) ? [...(document[listKey] as unknown[])] : [];
  const next = list.filter((entry) => asRecord(entry).id !== id);
  if (next.length === list.length) return { path, before, after: before, changed: false };
  document[listKey] = next;
  const after = dumpYaml(document);
  return { path, before, after, changed: before !== after };
}

/**
 * Remove a Model Area.
 *
 * An area OWNS its entities and relationships (they live in the same file), so
 * deleting the area file would silently delete them too. Refuse instead — the
 * user must clear the area first, which keeps the destructive step explicit.
 */
function previewRemoveArea(projectRoot: string, ref: ModelingObjectRef): ModelingSourcePatch[] {
  const id = requiredId(ref.id, 'model area');
  const domain = requiredId(ref.domain, 'domain');
  const root = findPackageRoot(projectRoot, domain);
  if (!root) throw new Error(`Unknown domain: ${domain}`);
  const localId = id.includes('::') ? id.split('::').pop() ?? id : id;
  const path = join(relative(projectRoot, root), 'modeling', 'areas', `${localId}.dql.yaml`).split(sep).join('/');
  const absolute = safeProjectPath(projectRoot, path);
  if (!existsSync(absolute)) return [{ path, before: '', after: '', changed: false }];
  const before = readFileSync(absolute, 'utf8');
  const document = asRecord(yaml.load(before));
  const entities = Array.isArray(document.entities) ? document.entities.length : 0;
  const relationships = Array.isArray(document.relationships) ? document.relationships.length : 0;
  if (entities > 0 || relationships > 0) {
    throw new Error(
      `Model area "${localId}" still owns ${entities} entit${entities === 1 ? 'y' : 'ies'} and ${relationships} relationship${relationships === 1 ? '' : 's'}. Remove or move them before deleting the area.`,
    );
  }
  return [{ path, before, after: '', changed: true }];
}

function sourcePatch(projectRoot: string, path: string, after: string): ModelingSourcePatch {
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  return { path, before, after, changed: before !== after };
}

/** Use one Domain Model source by default while editing existing split objects in place. */
function modelingSourceFile(projectRoot: string, domain: string, legacyName: string, listKey: string, identityKey: string, identityValue: string, areaId?: string): string {
  const root = findPackageRoot(projectRoot, domain);
  if (!root) throw new Error(`Domain Package "${domain}" does not exist. Create the domain first.`);
  if (areaId?.trim()) {
    const areaPath = modelAreaSourceFile(projectRoot, domain, areaId);
    if (!existsSync(safeProjectPath(projectRoot, areaPath))) {
      throw new Error(`Model Area "${areaId}" does not exist. Create the area before adding modeling objects.`);
    }
    return areaPath;
  }
  // New area files are nested under modeling/areas/. Find the true owner
  // before falling back to the historical unified/typed files.
  for (const candidate of modelingYamlFiles(join(root, 'modeling'))) {
    const document = asRecord(yaml.load(readFileSync(candidate, 'utf8')));
    const list = Array.isArray(document[listKey]) ? document[listKey] as unknown[] : [];
    if (list.some((entry) => asRecord(entry)[identityKey] === identityValue)) {
      return relative(projectRoot, candidate).replace(/\\/g, '/');
    }
  }
  const unified = join(root, 'modeling', 'model.dql.yaml');
  const legacy = join(root, 'modeling', legacyName);
  for (const candidate of [unified, legacy]) {
    if (!existsSync(candidate)) continue;
    const document = asRecord(yaml.load(readFileSync(candidate, 'utf8')));
    const list = Array.isArray(document[listKey]) ? document[listKey] as unknown[] : [];
    if (list.some((entry) => asRecord(entry)[identityKey] === identityValue)) return relative(projectRoot, candidate).replace(/\\/g, '/');
  }
  return relative(projectRoot, unified).replace(/\\/g, '/');
}

function modelAreaSourceFile(projectRoot: string, domain: string, id: string): string {
  const root = findPackageRoot(projectRoot, domain);
  if (!root) throw new Error(`Domain Package "${domain}" does not exist. Create the domain first.`);
  const localId = requiredId(id, 'model area');
  return relative(projectRoot, join(root, 'modeling', 'areas', `${localId}.dql.yaml`)).replace(/\\/g, '/');
}

function modelingYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...modelingYamlFiles(fullPath));
    else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) files.push(fullPath);
  }
  return files.sort();
}

function packageRootForWrite(projectRoot: string, id: string, parent?: string): string {
  const existing = findPackageRoot(projectRoot, id);
  if (existing) return existing;
  if (parent) {
    const parentRoot = findPackageRoot(projectRoot, parent);
    if (!parentRoot) throw new Error(`Parent Domain Package "${parent}" does not exist.`);
    return join(parentRoot, domainFolderSlug(id.split('.').pop() ?? id));
  }
  return join(projectRoot, 'domains', domainFolderSlug(id));
}

function findPackageRoot(projectRoot: string, id: string): string | undefined {
  return loadDomainPackageRegistry(projectRoot).get(id)?.root;
}

function safeProjectPath(projectRoot: string, relativePath: string): string {
  if (!relativePath.replace(/\\/g, '/').startsWith('domains/')) throw new Error('Modeling writes are restricted to domains/.');
  return assertContainedPath(projectRoot, relativePath, 'Modeling path');
}

function dbtPatchRelativePath(raw: UnknownRecord, name: string): string {
  const patchPath = stringValue(raw.patch_path);
  if (patchPath) {
    const separator = patchPath.indexOf('://');
    const relativePath = separator >= 0 ? patchPath.slice(separator + 3) : patchPath;
    if (!relativePath.endsWith('.yml') && !relativePath.endsWith('.yaml')) throw new Error('dbt patch_path must point to a YAML source file.');
    return relativePath.replace(/\\/g, '/');
  }
  const original = stringValue(raw.original_file_path) ?? stringValue(raw.path);
  if (!original) throw new Error(`dbt model ${name} does not declare a source path.`);
  return join(dirname(original), `${name}.yml`).replace(/\\/g, '/');
}

/** Resolve lexical and real paths so existing symlink ancestors cannot escape
 * the intended project root. Missing leaf segments are allowed for previews. */
export function assertContainedPath(projectRoot: string, inputPath: string, label: string): string {
  const root = resolve(projectRoot);
  const canonicalRoot = existsSync(root) ? realpathSync(root) : root;
  const absolute = resolve(root, inputPath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes the project root.`);
  let existing = absolute;
  while (!existsSync(existing) && existing !== root) existing = dirname(existing);
  const canonicalExisting = existsSync(existing) ? realpathSync(existing) : canonicalRoot;
  if (canonicalExisting !== canonicalRoot && !canonicalExisting.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${label} escapes the project root through a symlink.`);
  }
  return absolute;
}

/**
 * Serialize authored modeling source.
 *
 * Key order and list order are preserved (`sortKeys: false`, and callers append
 * rather than re-sort). Comments are NOT preserved: `js-yaml` re-serializes the
 * parsed tree, so a comment in `model.dql.yaml` is dropped the first time the
 * UI writes that file. `02-object-model-and-project-layout.md` asks writers to
 * preserve comments "where feasible"; doing so needs a CST-based emitter (the
 * `yaml` package's Document API), which is a new runtime dependency for this
 * published package and is deliberately left as a separate decision.
 */
export function dumpYaml(value: unknown): string {
  return yaml.dump(value, { noRefs: true, lineWidth: -1, sortKeys: false, noCompatMode: true }).trimEnd() + '\n';
}

function canonicalLifecycle(value: ManifestModelLifecycle | undefined): Exclude<ManifestModelLifecycle, 'review'> {
  if (value === 'review') return 'reviewed';
  return value ?? 'draft';
}

function canonicalFanout(value: ManifestFanoutPolicy): Exclude<ManifestFanoutPolicy, 'unsafe'> {
  return value === 'unsafe' ? 'forbidden' : value;
}

export function readJson(path: string): UnknownRecord {
  const stat = statSync(path);
  const version = `${stat.size}:${stat.mtimeMs}`;
  const cached = dbtJsonArtifactCache.get(path);
  if (cached?.version === version) return cached.value;
  const value = asRecord(JSON.parse(readFileSync(path, 'utf8')));
  dbtJsonArtifactReads += 1;
  dbtJsonArtifactCache.set(path, { version, value });
  return value;
}

function relationName(raw: UnknownRecord): string | undefined {
  const database = stringValue(raw.database);
  const schema = stringValue(raw.schema);
  const identifier = stringValue(raw.alias) ?? stringValue(raw.identifier) ?? stringValue(raw.name);
  return [database, schema, identifier].filter(Boolean).join('.') || undefined;
}

function requiredId(value: string | undefined, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) throw new Error(`${label} requires a safe non-empty id.`);
  return normalized;
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
