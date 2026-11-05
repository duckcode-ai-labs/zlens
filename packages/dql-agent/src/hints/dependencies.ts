import { createHash } from 'node:crypto';
import { analyzeSqlReferences, tableKey } from '@zlens/core';
import { normalizeScopeName, type HintDependency, type HintDependencyKind, type HintScope } from './types.js';

export interface HintDependencyObject {
  objectKey: string;
  objectType: string;
  name: string;
  fullName?: string;
  domain?: string;
  sourcePath?: string;
  status?: string;
  description?: string;
  payload?: Record<string, unknown>;
}

export interface HintDependencyRelation {
  relation: string;
  name: string;
  objectKey?: string;
  source: string;
  columns: Array<{
    name: string;
    type?: string;
    description?: string;
  }>;
  columnCompleteness?: 'complete' | 'partial';
}

export interface CollectedHintDependencies {
  dependencies: HintDependency[];
  referencedRelations: string[];
  unknownRelations: string[];
}

export interface HintFreshnessAssessment {
  snapshotCurrent: boolean;
  dependenciesCurrent: boolean;
  staleDependencies: HintDependency[];
  /**
   * Dependency-bearing hints are scoped: an unrelated project snapshot change
   * does not invalidate them when every recorded dependency still matches.
   * Legacy hints without dependency evidence fall back to the project snapshot.
   */
  current: boolean;
}

/** Content-address the governed relation/object inputs used by a hint. */
export function collectHintDependencies(input: {
  sql?: string;
  scope: HintScope;
  objects: HintDependencyObject[];
  relations: HintDependencyRelation[];
  /** Conservative fingerprint when a scoped object is not in the bounded pack. */
  fallbackFingerprint?: string;
}): CollectedHintDependencies {
  const dependencies = new Map<string, HintDependency>();
  const analysis = input.sql?.trim() ? analyzeSqlReferences(input.sql) : null;
  const referencedRelations = analysis?.tables ?? [];
  const unknownRelations: string[] = [];

  for (const referenced of referencedRelations) {
    const relation = findRelation(input.relations, referenced);
    if (!relation) {
      unknownRelations.push(referenced);
      continue;
    }
    const dependency = relationDependency(relation);
    dependencies.set(dependency.id, dependency);
    if (relation.objectKey) {
      const object = input.objects.find((candidate) => candidate.objectKey === relation.objectKey);
      if (object) {
        const objectDep = objectDependency(object);
        dependencies.set(objectDep.id, objectDep);
      }
    }
  }

  for (const [scopeField, kind, objectTypes] of SCOPE_OBJECTS) {
    const name = input.scope[scopeField];
    if (!name) continue;
    const object = input.objects.find((candidate) =>
      objectTypes.includes(candidate.objectType.toLowerCase())
      && objectNames(candidate).some((candidateName) => eq(candidateName, name)),
    );
    const dependency = object
      ? objectDependency(object, kind)
      : input.fallbackFingerprint
        ? {
            id: `scope:${kind}:${normalizeScopeName(name)}`,
            kind,
            name,
            fingerprint: input.fallbackFingerprint,
          }
        : undefined;
    if (!dependency) continue;
    dependencies.set(dependency.id, dependency);
  }

  return {
    dependencies: [...dependencies.values()].sort((left, right) => left.id.localeCompare(right.id)),
    referencedRelations,
    unknownRelations,
  };
}

/** Build the current dependency lookup used by retrieval-time drift gates. */
export function currentHintDependencyFingerprints(input: {
  objects: HintDependencyObject[];
  relations: HintDependencyRelation[];
}): Map<string, string> {
  const current = new Map<string, string>();
  for (const relation of input.relations) {
    const dependency = relationDependency(relation);
    current.set(dependency.id, dependency.fingerprint);
  }
  for (const object of input.objects) {
    const dependency = objectDependency(object);
    current.set(dependency.id, dependency.fingerprint);
    const inferredKind = hintKindForObjectType(object.objectType);
    if (inferredKind) {
      const scoped = objectDependency(object, inferredKind);
      current.set(scoped.id, scoped.fingerprint);
    }
  }
  return current;
}

export function staleHintDependencies(
  dependencies: HintDependency[] | undefined,
  current: ReadonlyMap<string, string> | undefined,
): HintDependency[] {
  if (!dependencies?.length || !current) return [];
  return dependencies.filter((dependency) => current.get(dependency.id) !== dependency.fingerprint);
}

/** Apply the same fail-closed freshness rule at review, inspection, and retrieval. */
export function assessHintFreshness(input: {
  dependencies?: HintDependency[];
  snapshotId?: string;
  currentDependencies?: ReadonlyMap<string, string>;
  currentSnapshotId?: string | null;
}): HintFreshnessAssessment {
  const dependencies = input.dependencies ?? [];
  const staleDependencies = dependencies.length > 0
    ? staleHintDependencies(dependencies, input.currentDependencies ?? new Map())
    : [];
  const snapshotCurrent = Boolean(input.snapshotId)
    && Boolean(input.currentSnapshotId)
    && input.snapshotId === input.currentSnapshotId
    && !input.currentSnapshotId!.startsWith('unverified:');
  const dependenciesCurrent = dependencies.length > 0 && staleDependencies.length === 0;
  // v1/v2 approved hints predate snapshot/dependency provenance. Preserve their
  // historical retrieval behavior; v3 lifecycle approval cannot create these.
  const legacyUnversioned = dependencies.length === 0 && !input.snapshotId;
  return {
    snapshotCurrent,
    dependenciesCurrent,
    staleDependencies,
    current: dependencies.length > 0 ? dependenciesCurrent : snapshotCurrent || legacyUnversioned,
  };
}

function relationDependency(relation: HintDependencyRelation): HintDependency {
  const name = tableKey(relation.relation, 'object');
  return {
    id: `relation:${name}`,
    kind: 'relation',
    name: relation.relation,
    fingerprint: fingerprint({
      relation: name,
      objectKey: relation.objectKey,
      source: relation.source,
      columnCompleteness: relation.columnCompleteness,
      columns: relation.columns
        .map((column) => ({
          name: column.name.toLowerCase(),
          type: column.type?.toLowerCase(),
          description: column.description,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }),
  };
}

function objectDependency(
  object: HintDependencyObject,
  kind = hintKindForObjectType(object.objectType) ?? 'semantic',
): HintDependency {
  return {
    id: `${kind}:${object.objectKey}`,
    kind,
    name: object.fullName ?? object.name,
    fingerprint: fingerprint({
      objectKey: object.objectKey,
      objectType: object.objectType,
      name: object.name,
      fullName: object.fullName,
      domain: object.domain,
      status: object.status,
      description: object.description,
      sourcePath: object.sourcePath,
      payload: object.payload,
    }),
    sourcePath: object.sourcePath,
  };
}

function findRelation(
  relations: HintDependencyRelation[],
  referenced: string,
): HintDependencyRelation | undefined {
  const keys = relationKeys(referenced);
  return relations.find((relation) =>
    [...relationKeys(relation.relation)].some((key) => keys.has(key))
    || [...relationKeys(relation.name)].some((key) => keys.has(key)),
  );
}

function relationKeys(value: string): Set<string> {
  const normalized = tableKey(value, 'object');
  const parts = normalized.split('.');
  return new Set([normalized, parts.at(-1) ?? normalized]);
}

function objectNames(object: HintDependencyObject): string[] {
  return [object.name, object.fullName, object.objectKey]
    .filter((value): value is string => Boolean(value));
}

function eq(left: string, right: string): boolean {
  return normalizeScopeName(left) === normalizeScopeName(right);
}

/**
 * One scope name for every spelling of the same object. A dbt model may be
 * named by its bare model name, by its unique id (`model.<package>.<name>`),
 * by a source's unique id (`source.<package>.<source>.<name>`) or with a
 * kind prefix; a hint captured under one spelling must be found under any.
 */
export { normalizeScopeName };

function hintKindForObjectType(objectType: string): HintDependencyKind | undefined {
  const normalized = objectType.toLowerCase();
  if (normalized === 'dbt_model' || normalized === 'dbt_source') return 'dbt_model';
  if (normalized.includes('metric')) return 'metric';
  if (normalized === 'domain' || normalized === 'domain_capsule') return 'domain';
  if (normalized === 'term' || normalized === 'dql_term') return 'term';
  if (normalized === 'block' || normalized === 'dql_block') return 'block';
  if (normalized.includes('semantic') || normalized === 'business_view') return 'semantic';
  return undefined;
}

const SCOPE_OBJECTS: Array<[
  keyof Pick<HintScope, 'metric' | 'dbtModel' | 'domain' | 'term' | 'block'>,
  HintDependencyKind,
  string[],
]> = [
  ['metric', 'metric', ['metric', 'semantic_metric']],
  ['dbtModel', 'dbt_model', ['dbt_model', 'dbt_source']],
  ['domain', 'domain', ['domain', 'domain_capsule']],
  ['term', 'term', ['term', 'dql_term']],
  ['block', 'block', ['block', 'dql_block']],
];

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
