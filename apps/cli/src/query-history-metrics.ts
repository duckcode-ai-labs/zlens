/**
 * METRICS PEOPLE ALREADY RUN. A warehouse's query history says which aggregates
 * a team repeats: `SUM(extendedprice - taxamount)` run 412 times by 9 people is
 * a metric nobody wrote down. This counts those expressions and writes each as
 * an ordinary metric draft, so `zlens semantic drafts`, `zlens migrate compare`
 * and approval all work on it unchanged. A draft answers nothing until approved.
 *
 * The text is read in memory and dropped. What is kept is the expression, how
 * many statements ran it and how many people, never a literal or a person's
 * name: an expression holding a literal is left out, because a literal is often
 * someone's data. A draft that doesn't run on the warehouse isn't written.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSemanticLayerFromDir,
  loadSemanticMetricDraftsFromDir,
  serializeMetricDefinitionToYaml,
  type MetricDefinition,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';
import { sqlNamer } from './import-metric-drafts.js';
import { statementTables } from './warehouse-model-discovery.js';

export interface HistoryStatement {
  text: string;
  /** Who ran it, only to count people. */
  user?: string;
  /** How many times it ran, where the warehouse keeps one row per statement shape. */
  calls?: number;
}

export interface RepeatedAggregate {
  relation: WarehouseCatalogRelationV1;
  aggregate: 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
  /** Over bare column names, lower case. */
  expression: string;
  /** How many runs of a statement used it. */
  runs: number;
  /** How many different statements used it. */
  statements: number;
  people: number;
}

const AGGREGATE_CALL = /\b(sum|avg|min|max|count)\s*\(/gi;
const EXPRESSION_WORDS = new Set(['case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'is', 'coalesce', 'nullif', 'abs', 'round', 'cast', 'as', 'numeric', 'decimal', 'float', 'double', 'precision', 'integer', 'int', 'bigint', 'real', 'number', 'true', 'false']);

/** How far a bracket is read, and how long a statement may be: history is anyone's text. */
const MAX_BRACKET_CHARS = 2_000;
const MAX_STATEMENT_CHARS = 50_000;

/** What is inside the bracket at `open`, or undefined when it never closes nearby. */
function bracketed(text: string, open: number): { inner: string; end: number } | undefined {
  let depth = 0;
  for (let index = open; index < Math.min(text.length, open + MAX_BRACKET_CHARS); index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, index), end: index };
    }
  }
  return undefined;
}

const clean = (value: string) => value.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.');

/**
 * An aggregate's expression over one table's bare columns, or undefined when it
 * holds a literal or placeholder, a subquery, a function that isn't plain
 * arithmetic, or a name that isn't a column of one known table.
 */
function resolveExpression(inner: string, tables: Map<string, WarehouseCatalogRelationV1>): { relation: WarehouseCatalogRelationV1; expression: string } | undefined {
  if (/'|\$\d|\?|\bselect\b/i.test(inner)) return undefined;
  // Arithmetic over names and small numbers only: this text is run on the
  // warehouse, and anyone who can run a query can put text in the history. A
  // long number is someone's data, so it is a literal and is left out.
  const unquoted = clean(inner);
  if (!/^[\w\s.$+\-*/%(),]+$/.test(unquoted) || /--|\/\*|\*\//.test(unquoted)) return undefined;
  if ((unquoted.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? []).some((number) => number.replace('.', '').length > 4)) return undefined;
  const single = new Set(tables.values()).size === 1 ? [...tables.values()][0] : undefined;
  let relation: WarehouseCatalogRelationV1 | undefined;
  let failed = false;
  const expression = clean(inner).replace(/[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*/g, (name) => {
    const parts = name.toLowerCase().split('.');
    if (parts.length === 1 && EXPRESSION_WORDS.has(parts[0]!)) return parts[0]!;
    const column = parts.pop()!;
    const owner = parts.length ? tables.get(parts.join('.')) : single;
    if (!owner || !owner.columns.some((item) => item.name.toLowerCase() === column) || (relation && relation.id !== owner.id)) {
      failed = true;
      return name;
    }
    relation = owner;
    return column;
  }).replace(/\s+/g, ' ').trim();
  return failed || !relation ? undefined : { relation, expression };
}

function statementAggregates(text: string, tables: Map<string, WarehouseCatalogRelationV1>): Array<{ relation: WarehouseCatalogRelationV1; aggregate: RepeatedAggregate['aggregate']; expression: string }> {
  const found: ReturnType<typeof statementAggregates> = [];
  for (const match of text.matchAll(AGGREGATE_CALL)) {
    const open = match.index! + match[0].length - 1;
    const call = bracketed(text, open);
    if (!call) continue;
    const word = match[1]!.toLowerCase();
    const distinct = /^\s*distinct\b/i.test(call.inner);
    // COUNT(*) is the size of a table, not something a team defines.
    if (word === 'count' && !distinct) continue;
    if (distinct && word !== 'count') continue;
    const resolved = resolveExpression(call.inner.replace(/^\s*distinct\b/i, ''), tables);
    if (resolved) found.push({ ...resolved, aggregate: word === 'count' ? 'count_distinct' : word as RepeatedAggregate['aggregate'] });
  }
  return found;
}

/** Count what statements repeat. A statement counts once per expression, however often it repeats it. */
export function repeatedAggregates(statements: Iterable<HistoryStatement>, snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'>, minimumRuns = 2): RepeatedAggregate[] {
  const known = new Map<string, WarehouseCatalogRelationV1>();
  for (const relation of snapshot.relations) {
    for (const spelling of [relation.relation, [relation.schema, relation.name].filter(Boolean).join('.')]) known.set(spelling.toLowerCase(), relation);
  }
  const counts = new Map<string, Omit<RepeatedAggregate, 'people'> & { users: Set<string> }>();
  for (const statement of statements) {
    if (statement.text.length > MAX_STATEMENT_CHARS) continue;
    const text = statement.text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const aliases = new Map<string, WarehouseCatalogRelationV1>();
    for (const [alias, name] of statementTables(text)) {
      const relation = known.get(name.toLowerCase());
      if (relation) aliases.set(alias, relation);
    }
    if (aliases.size === 0) continue;
    const seen = new Set<string>();
    for (const item of statementAggregates(text, aliases)) {
      const signature = `${item.relation.id}|${item.aggregate}|${item.expression}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const current = counts.get(signature) ?? { ...item, runs: 0, statements: 0, users: new Set<string>() };
      current.runs += Math.max(1, statement.calls ?? 1);
      current.statements += 1;
      if (statement.user) current.users.add(statement.user);
      counts.set(signature, current);
    }
  }
  return [...counts.values()]
    .filter((item) => item.runs >= minimumRuns)
    .map(({ users, ...item }) => ({ ...item, people: users.size }))
    .sort((a, b) => b.runs - a.runs || a.expression.localeCompare(b.expression));
}

const AGGREGATE_WORD: Record<RepeatedAggregate['aggregate'], string> = { sum: 'total', avg: 'average', min: 'lowest', max: 'highest', count_distinct: 'distinct' };
const METRIC_TYPE: Record<RepeatedAggregate['aggregate'], string> = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', count_distinct: 'count_distinct' };

/** A plain name from what the expression says. A person renames it on review. */
export function metricNameFor(item: Pick<RepeatedAggregate, 'aggregate' | 'expression' | 'relation'>): string {
  const words = item.expression.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/_+$/g, '');
  return `${AGGREGATE_WORD[item.aggregate]}_${item.relation.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${words}`.slice(0, 80);
}

export interface HistoryMetricDraftItem {
  name: string;
  inWords: string;
  runs: number;
  people: number;
  value?: number | null;
  path?: string;
  /** Why it wasn't written. */
  failed?: string;
}

/**
 * Write the top repeated aggregates as drafts, each run once over all rows on
 * the warehouse. A name a metric or a draft already has is left alone.
 */
export async function draftMetricsFromHistory(input: {
  projectRoot: string;
  aggregates: RepeatedAggregate[];
  domain: string;
  driver: string;
  /** Runs one read-only statement on the connected database. */
  run: (sql: string) => Promise<Array<Record<string, unknown>>>;
  maxDrafts?: number;
  /** With a host a value is computed under the runner's row rules, so it stays out of the project's files. */
  privateValues?: boolean;
  now?: Date;
}): Promise<HistoryMetricDraftItem[]> {
  const semanticDir = join(input.projectRoot, 'semantic-layer');
  const taken = new Set(existsSync(semanticDir)
    ? [...loadSemanticLayerFromDir(semanticDir).listMetrics(), ...loadSemanticMetricDraftsFromDir(semanticDir)].map((metric) => metric.name.toLowerCase())
    : []);
  const name = sqlNamer(input.driver.trim().toLowerCase());
  const ranAt = (input.now ?? new Date()).toISOString();
  const items: HistoryMetricDraftItem[] = [];
  for (const aggregate of input.aggregates.slice(0, input.maxDrafts ?? 20)) {
    const metric = metricNameFor(aggregate);
    if (taken.has(metric)) continue;
    taken.add(metric);
    const table = [aggregate.relation.schema, aggregate.relation.name].filter(Boolean).map((part) => name(part!)).join('.');
    const sql = aggregate.expression.replace(/[A-Za-z_][\w$]*/g, (word) => (EXPRESSION_WORDS.has(word) ? word : name(aggregate.relation.columns.find((column) => column.name.toLowerCase() === word)?.name ?? word)));
    const call = aggregate.aggregate === 'count_distinct' ? `COUNT(DISTINCT ${sql})` : `${aggregate.aggregate.toUpperCase()}(${sql})`;
    const inWords = `${call} on ${table}. Seen in ${aggregate.runs.toLocaleString('en-US')} runs${aggregate.people ? ` by ${aggregate.people} ${aggregate.people === 1 ? 'person' : 'people'}` : ''}.`;
    const item: HistoryMetricDraftItem = { name: metric, inWords, runs: aggregate.runs, people: aggregate.people };
    let value: number | null;
    try {
      const rows = await input.run(`SELECT ${call} AS value FROM ${table}`);
      const raw = Object.values(rows[0] ?? {})[0];
      value = raw === null || raw === undefined ? null : Number(raw);
    } catch (error) {
      items.push({ ...item, failed: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
      continue;
    }
    const definition: MetricDefinition = {
      name: metric,
      label: metric.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase()),
      description: `Repeated in query history: ${call}. Named by rule, not by a person.`,
      domain: input.domain,
      status: 'draft',
      type: METRIC_TYPE[aggregate.aggregate],
      sql,
      table,
      tags: ['query-history', 'human-review'],
      source: {
        provider: 'query-history',
        objectType: 'expression',
        objectId: `${aggregate.relation.id}#${aggregate.aggregate}(${aggregate.expression})`,
        objectName: metric,
        importedAt: ranAt,
        extra: { inWords, formula: call, check: input.privateValues ? { ran: true, ranAt } : { value, ranAt } },
      },
    } as MetricDefinition;
    const path = join('semantic-layer', 'metrics', '_drafts', input.domain.replace(/[^A-Za-z0-9_-]+/g, '-'), `${metric}.yaml`);
    mkdirSync(join(input.projectRoot, join(path, '..')), { recursive: true });
    writeFileSync(join(input.projectRoot, path), serializeMetricDefinitionToYaml(definition), 'utf-8');
    items.push({ ...item, value, path: path.replaceAll('\\', '/') });
  }
  return items;
}
