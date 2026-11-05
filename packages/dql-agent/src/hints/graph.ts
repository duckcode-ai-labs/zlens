import { analyzeSqlReferences, tableKey } from '@zlens/core';
import type {
  Hint,
  HintDependencyKind,
  HintGraphEdge,
  HintGraphEdgeKind,
  HintScope,
  QuestionScope,
} from './types.js';

const HIGH_SIGNAL_EDGE_KINDS = new Set<HintGraphEdgeKind>([
  'belongs_to_domain',
  'refines_metric',
  'uses_dbt_model',
  'refines_term',
  'relates_to_block',
]);

/**
 * Materialize a hint's typed graph connections from governed scope,
 * dependencies, lifecycle provenance, and parsed corrected SQL.
 */
export function buildHintGraphEdges(hint: Hint): HintGraphEdge[] {
  const edges = new Map<string, HintGraphEdge>();
  const add = (edge: HintGraphEdge): void => {
    edges.set(`${edge.kind}\0${edge.targetId}`, edge);
  };

  for (const edge of scopeEdges(hint.id, hint.scope)) add(edge);

  for (const dependency of hint.dependencies ?? []) {
    add({
      hintId: hint.id,
      kind: dependencyEdgeKind(dependency.kind),
      targetId: normalizeTargetId(dependency.id),
      targetKind: dependency.kind,
      targetName: dependency.name,
      fingerprint: dependency.fingerprint,
      source: 'dependency',
    });
  }

  if (hint.correctedSql?.trim()) {
    const analysis = analyzeSqlReferences(hint.correctedSql, hint.scope.dialect);
    const internalRelations = new Set(
      [...analysis.ctes, ...analysis.derivedRelations].map((name) => tableKey(name, 'object')),
    );
    for (const relation of analysis.tables) {
      const normalizedRelation = tableKey(relation, 'object');
      add({
        hintId: hint.id,
        kind: 'uses_relation',
        targetId: `relation:${normalizedRelation}`,
        targetKind: 'relation',
        targetName: relation,
        source: 'corrected_sql',
      });
    }
    for (const column of analysis.columns) {
      if (!column.relation || column.outputAliasReference) continue;
      const normalizedRelation = tableKey(column.relation, 'object');
      if (internalRelations.has(normalizedRelation)) continue;
      const normalizedColumn = normalizeName(column.column);
      add({
        hintId: hint.id,
        kind: 'uses_column',
        targetId: `column:${normalizedRelation}.${normalizedColumn}`,
        targetKind: 'column',
        targetName: `${column.relation}.${column.column}`,
        source: 'corrected_sql',
      });
    }
  }

  if (hint.traceId) {
    add({
      hintId: hint.id,
      kind: 'derived_from',
      targetId: `trace:${normalizeName(hint.traceId)}`,
      targetKind: 'trace',
      targetName: hint.traceId,
      source: 'lifecycle',
    });
  }
  if (hint.evaluationId) {
    add({
      hintId: hint.id,
      kind: 'validated_by',
      targetId: `evaluation:${normalizeName(hint.evaluationId)}`,
      targetKind: 'evaluation',
      targetName: hint.evaluationId,
      source: 'lifecycle',
    });
  }
  if (hint.supersedes) {
    add({
      hintId: hint.id,
      kind: 'supersedes',
      targetId: `hint:${normalizeName(hint.supersedes)}`,
      targetKind: 'hint',
      targetName: hint.supersedes,
      source: 'lifecycle',
    });
  }

  return [...edges.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.targetId.localeCompare(right.targetId),
  );
}

/** Graph targets resolved for a new question. */
export function questionHintGraphTargetIds(scope: QuestionScope): Set<string> {
  const targets = new Set<string>();
  for (const edge of scopeEdges('__question__', scope)) targets.add(edge.targetId);
  for (const relation of scope.relations ?? []) {
    targets.add(`relation:${tableKey(relation, 'object')}`);
  }
  for (const column of scope.columns ?? []) {
    const normalized = normalizeQualifiedColumn(column);
    if (normalized) targets.add(`column:${normalized}`);
  }
  return targets;
}

/**
 * High-signal targets may recall a hint even when wording differs. Relation and
 * column edges deliberately only rank/explain a recalled hint: schema overlap
 * alone is too broad to make a correction applicable.
 */
export function highSignalHintGraphTargetIds(scope: QuestionScope): Set<string> {
  const targets = new Set<string>();
  for (const edge of scopeEdges('__question__', scope)) {
    if (HIGH_SIGNAL_EDGE_KINDS.has(edge.kind)) targets.add(edge.targetId);
  }
  return targets;
}

export function describeHintGraphOverlap(edges: HintGraphEdge[], targets: ReadonlySet<string>): string | undefined {
  const matched = edges.filter((edge) => targets.has(edge.targetId));
  if (matched.length === 0) return undefined;
  const grouped = new Map<string, string[]>();
  for (const edge of matched) {
    const values = grouped.get(edge.targetKind) ?? [];
    if (!values.includes(edge.targetName)) values.push(edge.targetName);
    grouped.set(edge.targetKind, values);
  }
  return [...grouped.entries()]
    .map(([kind, names]) => `${kind}=${names.slice(0, 4).join(', ')}`)
    .join('; ');
}

export function hintGraphOverlapScore(edges: HintGraphEdge[], targets: ReadonlySet<string>): number {
  let score = 0;
  for (const edge of edges) {
    if (!targets.has(edge.targetId)) continue;
    score += edgeWeight(edge.kind);
  }
  return Math.min(score, 0.85);
}

function scopeEdges(hintId: string, scope: HintScope | QuestionScope): HintGraphEdge[] {
  const edges: HintGraphEdge[] = [];
  const add = (
    kind: HintGraphEdgeKind,
    targetKind: string,
    value: string | undefined,
  ): void => {
    if (!value?.trim()) return;
    edges.push({
      hintId,
      kind,
      targetId: `${targetKind}:${normalizeName(value)}`,
      targetKind,
      targetName: value,
      source: 'scope',
    });
  };

  add('belongs_to_domain', 'domain', scope.domain);
  add('refines_metric', 'metric', scope.metric);
  add('uses_dbt_model', 'dbt_model', scope.dbtModel);
  add('refines_term', 'term', scope.term);
  add('relates_to_block', 'block', scope.block);
  add('uses_dialect', 'dialect', scope.dialect);

  if ('metrics' in scope) {
    for (const metric of scope.metrics ?? []) add('refines_metric', 'metric', metric);
    for (const model of scope.dbtModels ?? []) add('uses_dbt_model', 'dbt_model', model);
  }

  return edges;
}

function dependencyEdgeKind(kind: HintDependencyKind): HintGraphEdgeKind {
  if (kind === 'domain') return 'belongs_to_domain';
  if (kind === 'metric') return 'refines_metric';
  if (kind === 'dbt_model') return 'uses_dbt_model';
  if (kind === 'relation') return 'uses_relation';
  if (kind === 'term') return 'refines_term';
  if (kind === 'block') return 'relates_to_block';
  return 'depends_on';
}

function edgeWeight(kind: HintGraphEdgeKind): number {
  if (kind === 'refines_metric' || kind === 'relates_to_block') return 0.3;
  if (kind === 'belongs_to_domain' || kind === 'uses_dbt_model' || kind === 'refines_term') return 0.22;
  if (kind === 'uses_relation') return 0.12;
  if (kind === 'uses_column') return 0.06;
  if (kind === 'uses_dialect') return 0.03;
  return 0;
}

function normalizeTargetId(value: string): string {
  const [kind, ...rest] = value.split(':');
  return rest.length > 0
    ? `${normalizeName(kind)}:${normalizeName(rest.join(':'))}`
    : normalizeName(value);
}

function normalizeQualifiedColumn(value: string): string | undefined {
  const normalized = value.replace(/["`\[\]]/g, '').trim().toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length < 2) return undefined;
  const column = parts.pop()!;
  return `${parts.join('.')}.${column}`;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
