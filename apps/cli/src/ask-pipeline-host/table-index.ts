/**
 * THE TABLE INDEX. A warehouse-first schema too large to show whole used to
 * reach the drafter as the five tables word overlap chose. Word overlap can't
 * tell a live table from its copies: the first benchmark on a 351-table schema
 * filled those five with look-alikes, and better words barely helped, because
 * every look-alike had them too.
 *
 * So above the budget the model chooses. It reads one line per table, what the
 * table holds when something says so and its columns when nothing does, and
 * names the tables the question needs. Those get full cards. If the call fails,
 * word overlap chooses as before.
 */

import type { AgentMessage } from '@zlens/agent';

/** What the index may take of a prompt. Past this, the tables search ranks lower are left out. */
export const TABLE_INDEX_CHARS = 60_000;
/** How many tables the model may choose. */
export const TABLE_INDEX_PICKS = 8;
const MAX_LINE_WORDS_CHARS = 140;

export const TABLE_INDEX_SYSTEM = 'You choose which database tables a question needs. You are given one line per table: its name, then what it holds, or its columns when nothing says what it holds. ' +
  'Choose every table needed to answer the question, including tables needed only to join others or to name what the answer groups by. ' +
  'Prefer the table that holds the live data over archives, copies, backups, snapshots and per-department duplicates, unless the question asks for one of those. ' +
  `Respond with ONLY a JSON object: {"tables":["schema.table"]}, most important first, at most ${TABLE_INDEX_PICKS} tables.`;

interface IndexedRelation {
  name: string;
  description?: string;
  columns: string[];
}

/** One table, one line. */
export function tableIndexLine(relation: IndexedRelation): string {
  const words = (relation.description ?? '').replace(/^AI draft:\s*/, '').replace(/\s+/g, ' ').trim() || `columns: ${relation.columns.join(', ')}`;
  return `- ${relation.name}: ${words.length > MAX_LINE_WORDS_CHARS ? `${words.slice(0, MAX_LINE_WORDS_CHARS - 1)}…` : words}`;
}

/** The index, the tables search ranked first, as many as the budget holds. */
export function tableIndexLines(relations: IndexedRelation[], ranked: string[] = [], budget = TABLE_INDEX_CHARS): string[] {
  const order = new Map(ranked.map((name, index) => [name.toLowerCase(), index]));
  const sorted = [...relations].sort((left, right) => (order.get(left.name.toLowerCase()) ?? Infinity) - (order.get(right.name.toLowerCase()) ?? Infinity));
  const lines: string[] = [];
  let chars = 0;
  for (const relation of sorted) {
    const line = tableIndexLine(relation);
    if (chars + line.length + 1 > budget) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines;
}

export function tableIndexMessages(question: string, lines: string[]): AgentMessage[] {
  return [
    { role: 'system', content: TABLE_INDEX_SYSTEM },
    { role: 'user', content: `QUESTION: ${question}\n\nTABLES:\n${lines.join('\n')}` },
  ];
}

/** The tables a reply names, among those offered, as the index spells them. */
export function parseTablePicks(reply: string, offered: string[]): string[] {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: { tables?: unknown };
  try {
    parsed = JSON.parse(reply.slice(start, end + 1)) as { tables?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.tables)) return [];
  const byLower = new Map(offered.map((name) => [name.toLowerCase(), name]));
  const picks = parsed.tables.flatMap((name) => {
    const found = typeof name === 'string' ? byLower.get(name.trim().toLowerCase()) : undefined;
    return found ? [found] : [];
  });
  return [...new Set(picks)].slice(0, TABLE_INDEX_PICKS);
}
