import type { DqlArtifactReference } from '@zlens/core';
import { withoutEnds } from '../../text-ends.js';
import { renderSemanticDqlArtifact, semanticDqlArtifactName } from '../../semantic-bridge/compose.js';
import { clipText } from '../vocabulary.js';
import type { SemanticCompileRequest } from './types.js';

/**
 * THE DQL AN ANSWER RAN. "How it was answered" shows the DQL first and the SQL
 * it compiled to second: a semantic answer is a semantic block over the
 * metrics, dimensions, filters, grain, order and limit the engine compiled.
 */
export function semanticAnswerArtifact(request: SemanticCompileRequest, reading: string, compiledSql: string): DqlArtifactReference {
  const filters = (request.filters ?? [])
    .filter((filter) => filter.dimension && filter.operator)
    .map((filter) => ({ dimension: filter.dimension!, operator: filter.operator!, values: (filter.values ?? []).map((value) => String(value)) }));
  const orderBy = (request.orderBy ?? []).filter((order) => order.name).map((order) => ({ name: order.name, direction: order.direction ?? 'asc' as const }));
  const input = {
    question: reading,
    metrics: request.metrics,
    dimensions: request.dimensions,
    filters,
    ...(request.timeDimension ? { timeDimension: request.timeDimension } : {}),
    ...(orderBy.length ? { orderBy } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
  };
  const name = semanticDqlArtifactName(input);
  return {
    kind: 'semantic_block',
    name,
    source: renderSemanticDqlArtifact({ ...input, name }),
    metrics: request.metrics,
    dimensions: request.dimensions,
    ...(filters.length ? { filters } : {}),
    ...(request.timeDimension ? { timeDimension: request.timeDimension } : {}),
    ...(orderBy.length ? { orderBy } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
    persistence: 'transient',
    trustState: 'governed',
    compiledSql,
  } as DqlArtifactReference;
}

// A name is cut between words, never inside one (V12: "count_of_regular_season_games_the_golden_state_w").
const blockName = (reading: string, fallback: string) => {
  const words = withoutEnds(reading.toLowerCase().replace(/[^a-z0-9]+/g, '_'), '_');
  const head = words.slice(0, 65);
  const lastBreak = head.lastIndexOf('_');
  const cut = words.length <= 64 ? words : (lastBreak >= 0 ? head.slice(0, lastBreak) : head) || words.slice(0, 64);
  return (cut || fallback).replace(/^(\d)/, 'q_$1');
};

const sqlBlockSource = (name: string, reading: string, sql: string) => [
  `block "${name}" {`,
  '  type = "custom"',
  '  status = "draft"',
  // Cut at a sentence end or a word, never mid-word (V9: it stopped mid-word).
  `  description = "${clipText(reading.replace(/"/g, "'"), 200)}"`,
  '  query = """',
  ...sql.split('\n').map((line) => `    ${line}`),
  '  """',
  '}',
].join('\n');

/** An AI-written statement as a draft DQL block: review-required until a person certifies it. */
export function sqlAnswerArtifact(sql: string, reading: string): DqlArtifactReference {
  const name = blockName(reading, 'ai_drafted_answer');
  return { kind: 'sql_block', name, source: sqlBlockSource(name, reading, sql), persistence: 'transient', trustState: 'review_required', compiledSql: sql };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The statement with each `?` replaced by its bound value, in order, so the
 * block runs by itself. A `?` inside a quoted literal or identifier is text,
 * not a placeholder. Undefined when the placeholders and values disagree.
 */
export function inlineSqlParams(sql: string, params: readonly unknown[]): string | undefined {
  let out = '';
  let next = 0;
  let quote: string | undefined;
  for (let at = 0; at < sql.length; at += 1) {
    const char = sql[at]!;
    if (quote) {
      out += char;
      if (char === quote) {
        // A doubled quote is an escaped quote inside the literal.
        if (sql[at + 1] === quote) { out += quote; at += 1; } else quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (char === '?') {
      if (next >= params.length) return undefined;
      out += sqlLiteral(params[next]);
      next += 1;
    } else {
      out += char;
    }
  }
  return next === params.length ? out : undefined;
}

/**
 * A governed composition as DQL: the statement composed from governed metrics
 * and dimensions along governed join paths, with its bound values written in.
 * Governed, like the answer; saving it makes a draft a person certifies.
 */
export function relationalAnswerArtifact(sql: string, params: readonly unknown[], reading: string): DqlArtifactReference | undefined {
  const query = inlineSqlParams(sql, params);
  if (query === undefined) return undefined;
  const name = blockName(reading, 'governed_answer');
  return { kind: 'sql_block', name, source: sqlBlockSource(name, reading, query), persistence: 'transient', trustState: 'governed', compiledSql: sql };
}
