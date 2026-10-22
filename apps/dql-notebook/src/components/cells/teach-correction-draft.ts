import type { Cell } from '../../store/types';
import type { AgentHint, AgentHintLesson } from '../../api/client';

export type TeachCorrectionScope = AgentHint['scope'];

export interface TeachCorrectionDraft {
  title: string;
  guidance: string;
  rationale: string;
  lesson: AgentHintLesson;
  scope: TeachCorrectionScope;
  changedIdentifiers: {
    added: string[];
    removed: string[];
  };
  filtersChanged: boolean;
}

const SQL_WORDS = new Set([
  'all', 'and', 'as', 'asc', 'avg', 'between', 'by', 'case', 'cast', 'coalesce',
  'count', 'cross', 'date', 'day', 'desc', 'distinct', 'else', 'end', 'false',
  'from', 'full', 'group', 'having', 'in', 'inner', 'interval', 'is', 'join',
  'left', 'like', 'limit', 'max', 'min', 'month', 'not', 'null', 'on', 'or',
  'order', 'outer', 'over', 'partition', 'qualify', 'right', 'round', 'row',
  'rows', 'select', 'sum', 'then', 'true', 'union', 'when', 'where', 'with',
  'year',
]);

function normalizedIdentifier(value: string): string {
  return value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
}

function sqlIdentifiers(sql: string): Set<string> {
  const sourceOnly = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ');
  const identifiers = sourceOnly.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? [];
  return new Set(
    identifiers
      .map(normalizedIdentifier)
      .filter((value) => value.length > 1 && !SQL_WORDS.has(value)),
  );
}

function changedIdentifiers(previousSql: string, correctedSql: string): {
  added: string[];
  removed: string[];
} {
  const previous = sqlIdentifiers(previousSql);
  const corrected = sqlIdentifiers(correctedSql);
  return {
    added: [...corrected].filter((value) => !previous.has(value)).slice(0, 4),
    removed: [...previous].filter((value) => !corrected.has(value)).slice(0, 4),
  };
}

function hasFilterClause(sql: string): boolean {
  return /\b(?:where|having|qualify)\b/i.test(sql);
}

function cleanScope(scope: TeachCorrectionScope): TeachCorrectionScope {
  return Object.fromEntries(
    Object.entries(scope)
      .map(([key, value]) => [key, value?.trim()])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  ) as TeachCorrectionScope;
}

export function teachScopeHasRecallAnchor(scope: TeachCorrectionScope): boolean {
  return [scope.metric, scope.dbtModel, scope.domain, scope.term, scope.block]
    .some((value) => Boolean(value?.trim()));
}

export function teachScopeLabels(scope: TeachCorrectionScope): string[] {
  return [
    scope.domain?.trim() ? `domain ${scope.domain.trim()}` : undefined,
    scope.metric?.trim() ? `metric ${scope.metric.trim()}` : undefined,
    scope.dbtModel?.trim() ? `model ${scope.dbtModel.trim()}` : undefined,
    scope.term?.trim() ? `term ${scope.term.trim()}` : undefined,
    scope.block?.trim() ? `saved query ${scope.block.trim()}` : undefined,
    scope.dialect?.trim() ? `dialect ${scope.dialect.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
}

export function parseTeachLessonLines(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

export function buildTeachCorrectionDraft(
  cell: Cell,
  input: {
    question: string;
    previousSql: string;
    correctedSql: string;
    domain?: string;
  },
): TeachCorrectionDraft {
  const scope = cleanScope({
    metric: cell.dqlArtifact?.metrics?.[0],
    domain: input.domain,
  });
  const changes = changedIdentifiers(input.previousSql, input.correctedSql);
  const filtersChanged = hasFilterClause(input.previousSql) !== hasFilterClause(input.correctedSql)
    || (
      hasFilterClause(input.previousSql)
      && hasFilterClause(input.correctedSql)
      && input.previousSql.match(/\b(?:where|having|qualify)\b[\s\S]*/i)?.[0]
        !== input.correctedSql.match(/\b(?:where|having|qualify)\b[\s\S]*/i)?.[0]
    );
  const subject = scope.metric
    ? `${scope.metric} questions`
    : scope.domain
      ? `${scope.domain} questions`
      : 'matching questions';
  const lessonParts: string[] = [];
  if (changes.added.length > 0 && changes.removed.length > 0) {
    lessonParts.push(`use ${changes.added.join(', ')} instead of ${changes.removed.join(', ')}`);
  } else if (changes.added.length > 0) {
    lessonParts.push(`use ${changes.added.join(', ')}`);
  }
  if (filtersChanged) lessonParts.push('apply the corrected filter conditions');
  if (lessonParts.length === 0) lessonParts.push('follow the reviewed SQL pattern');
  const shortQuestion = input.question.trim().replace(/\s+/g, ' ').slice(0, 70);
  const lessonCategory: AgentHintLesson['category'] = filtersChanged
    ? 'filter_rule'
    : changes.added.length > 0 || changes.removed.length > 0
      ? 'relation_rule'
      : 'semantic_rule';
  const guidance = `For ${subject}, ${lessonParts.join(' and ')}. Confirm this lesson against the reviewed SQL and current governed context.`;

  return {
    title: scope.metric
      ? `Correct ${scope.metric} logic`
      : `Correction for: ${shortQuestion}`,
    guidance,
    rationale: '',
    lesson: {
      version: 1,
      category: lessonCategory,
      rule: guidance,
      intentExamples: [input.question.trim()].filter(Boolean),
      avoid: [],
      expectedOutcome: undefined,
    },
    scope,
    changedIdentifiers: changes,
    filtersChanged,
  };
}
