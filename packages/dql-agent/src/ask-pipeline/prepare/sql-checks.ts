import type { AnalyticalIntentV1 } from '../intent.js';
import { withoutBlockNames } from '../named-blocks.js';
import { sqlReturnsOneRow, tableName } from '@zlens/core';

/**
 * THE CHECKS AN AI-DRAFTED STATEMENT PASSES BEFORE IT RUNS.
 *
 * A drafted statement is review-required, but review is not a license to be
 * wrong without anyone noticing. These checks are deterministic and cheap:
 * every value the question states is in the statement, every required filter
 * of the project is in the statement, and the statement is row-guarded. What
 * the statement filters on is extracted so the answer can say it in words.
 * They read SQL as text on purpose — a parser that cannot read one dialect is
 * not a reason to skip them.
 */

export interface StatedValue {
  value: string;
  kind: 'text' | 'year' | 'fiscal_year' | 'quarter';
  /** The whole name a capitalised word belongs to ("Golden State Warriors" for "Golden"), when it has several words. */
  name?: string;
}

const NOT_VALUES = new Set([
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'show', 'list', 'give', 'find', 'get', 'tell', 'compare', 'top', 'bottom', 'total', 'totals', 'count', 'counts', 'number', 'sum', 'average', 'avg', 'lost', 'won', 'amount', 'amounts', 'revenue', 'by', 'for', 'and', 'or', 'the', 'in', 'of', 'on', 'at', 'to', 'from', 'with', 'per', 'is', 'are', 'was', 'were', 'a', 'an', 'all', 'each', 'every', 'month', 'months', 'year', 'years', 'quarter', 'week', 'day', 'fiscal', 'calendar', 'last', 'this', 'next', 'current', 'previous', 'i', 'we', 'our', 'my', 'please', 'also', 'only', 'and/or',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** An instruction that opens a clause, not a value: "count them by name Return only those fields". */
const INSTRUCTION_WORDS = new Set(['return', 'include', 'exclude', 'display', 'sort', 'order', 'group', 'rank', 'filter', 'limit', 'use', 'select', 'calculate', 'compute', 'count', 'sum', 'average', 'break', 'split', 'only', 'please', 'then', 'also']);
/** After one of these a word sits where a value goes, even an instruction word: "orders marked Return". */
const BEFORE_A_VALUE = new Set(['for', 'in', 'at', 'of', 'from', 'by', 'with', 'to', 'on', 'is', 'are', 'named', 'called', 'marked', 'like', 'vs', 'versus', 'than', 'and', 'or', 'status', 'type', 'kind', 'category', 'tag', 'label', 'code']);

function opensAClause(tokens: string[], index: number): boolean {
  if (BEFORE_A_VALUE.has(tokens[index - 1]!.toLowerCase())) return false;
  const next = tokens.slice(index + 1, index + 4);
  return next.length === 3 && next.every((word) => /^[a-z]/.test(word) && !['and', 'or'].includes(word));
}

function properNouns(text: string): string[] {
  return properNounNames(text).flatMap((name) => name);
}

/**
 * The capitalised words of a text, grouped into the names they form: words next to each other in the same
 * clause ("Golden State Warriors") are one name, words parted by anything else ("Acme, Contoso") are not.
 */
function properNounNames(text: string): string[][] {
  const names: string[][] = [];
  for (const sentence of text.split(/[.?!\n]+/)) {
    // A comma, semicolon or bracket parts two names, as a word between them does.
    const tokens = sentence.split(/\s+|(?=[,;:()])|(?<=[,;:()])/).filter(Boolean);
    let current: string[] = [];
    const close = () => { if (current.length) names.push(current); current = []; };
    tokens.forEach((token, index) => {
      if (/^[,;:()]$/.test(token)) { close(); return; }
      const words = tokens.filter((item) => !/^[,;:()]$/.test(item));
      const position = words.indexOf(token);
      const word = token.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/'s$/, '');
      // Capitalized mixed case (Splunk, Curry). ALL-CAPS tokens are field
      // names or acronyms the user typed, not values the data must hold.
      if (index === 0 || position === 0 || !/^[A-Z][a-z][A-Za-z0-9&-]*$/.test(word) || NOT_VALUES.has(word.toLowerCase())
        || (INSTRUCTION_WORDS.has(word.toLowerCase()) && opensAClause(words, position))) { close(); return; }
      current.push(word);
    });
    close();
  }
  return names;
}

/**
 * The question itself, without a document pasted after it. A definitions
 * document ("# Special Words Definition … ## Strike Rate") is context for
 * reading the question: its headings and capitalised terms are not values
 * the data holds, and demanding them in the SQL fails every correct draft.
 */
export function questionProper(question: string): string {
  const cut = question.search(/\n\s*\n(?=\s*(?:reference document\b|#{1,6}\s))/i);
  const body = cut >= 0 ? question.slice(0, cut) : question;
  // Markdown heading lines inside the question are titles, never values.
  return body.split('\n').filter((line) => !/^\s*#{1,6}\s/.test(line)).join('\n');
}

/** A vocabulary ref (`column:main.match.match_winner`), which names a field, never a value. */
const REF_LITERAL = /^(column|dimension|metric|measure|entity|relation|block|concept|term):\S+$/i;

/**
 * The values a question (and its reading, when there is one) states and a
 * correct statement must apply. `namedBlocks` are the blocks the question
 * names as blocks ("using the certified block Eligible Top Players"): their
 * names identify a project object, so their words are not values.
 */
export function statedValues(question: string, intent?: AnalyticalIntentV1, options: { namedBlocks?: string[] } = {}): StatedValue[] {
  question = questionProper(question);
  const named = options.namedBlocks ?? [];
  if (named.length) question = withoutBlockNames(question, named);
  const namedText = new Set(named.map((name) => name.trim().toLowerCase()));
  const values: StatedValue[] = [];
  const add = (value: string, kind: StatedValue['kind']) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    if (!values.some((item) => item.kind === kind && item.value.toLowerCase() === trimmed.toLowerCase())) values.push({ value: trimmed, kind });
  };
  const fiscal = new Set<string>();
  for (const match of question.matchAll(/\bFY\s?'?(\d{4}|\d{2})\b/gi)) { add(`FY${match[1]}`, 'fiscal_year'); fiscal.add(match[1]!); }
  for (const match of question.matchAll(/\bQ([1-4])\b/g)) add(`Q${match[1]}`, 'quarter');
  for (const match of question.matchAll(/\b(19|20)\d{2}\b/g)) if (!fiscal.has(match[0])) add(match[0], 'year');
  for (const match of question.matchAll(/["“‘]([^"”’]{2,80})["”’]/g)) add(match[1]!, 'text');
  for (const name of properNounNames(question)) {
    for (const word of name) {
      if (/^Q[1-4]$/.test(word)) continue;
      const before = values.length;
      add(word, 'text');
      if (name.length > 1 && values.length > before) values[values.length - 1]!.name = name.join(' ');
    }
  }
  if (intent) {
    const literals = [
      ...intent.filters.flatMap((filter) => filter.values),
      ...intent.measures.flatMap((measure) => (measure.scope ?? []).flatMap((scope) => scope.values)),
    ];
    // A flag value the reading chose ("has_premium is true") is not a value
    // the question stated: the statement may apply it as a join, `= 1` or
    // the bare column, none of which spells the word.
    // A ref the reading put where a value goes ("column:main.match.match_winner",
    // comparing two columns) names a field, not a value the data holds.
    for (const literal of literals) {
      if (!(typeof literal === 'string' && /[A-Za-z]/.test(literal) && literal.length <= 80 && !NOT_VALUES.has(literal.toLowerCase()) && !namedText.has(literal.trim().toLowerCase()) && !/^(true|false|yes|no|y|n|t|f)$/i.test(literal.trim()) && !REF_LITERAL.test(literal.trim()))) continue;
      const before = values.length;
      add(literal, 'text');
      // A name the reading wrote in several capitalised words ("Boston Celtics") is applied by any of its words,
      // as a name in the question is: the data may hold only "Celtics" (new-user test, V7 retest, 2026-11-10).
      if (values.length > before && /^[A-Z][\w&'-]*(\s+[A-Z][\w&'-]*)+$/.test(literal.trim())) values[values.length - 1]!.name = literal.trim();
    }
    for (const clause of intent.unresolved) for (const word of properNouns(`x ${named.length ? withoutBlockNames(clause.clause, named) : clause.clause}`)) add(word, 'text');
  }
  return values;
}

/** The stated values a statement does not apply. */
export function missingStatedValues(sql: string, stated: StatedValue[]): StatedValue[] {
  const lower = sql.toLowerCase();
  return stated.filter((item) => {
    // A word of a longer name is applied when the statement spells the name by any of its own words: "Golden
    // State Warriors" filtered as ILIKE '%warriors%' (new-user test, 2026-11-10: refused for "Golden", "State").
    if (item.kind === 'text' && item.name) return !item.name.toLowerCase().split(/\s+/).filter((word) => word.length > 3).some((word) => lower.includes(word));
    if (item.kind === 'text') return !item.value.toLowerCase().split(/\s+/).filter((word) => word.length > 1).every((word) => lower.includes(word));
    if (item.kind === 'year') {
      if (lower.includes(item.value)) return false;
      // A range that spans the year applies it ('2016-01-01' .. '2018-01-01').
      const year = Number(item.value);
      const dates = [...sql.matchAll(/'(\d{4})-(\d{2})-(\d{2})/g)].map((match) => Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]));
      return !(dates.some((date) => date <= year * 10000 + 101) && dates.some((date) => date >= year * 10000 + 1231));
    }
    if (item.kind === 'quarter') return !(lower.includes(item.value.toLowerCase()) || /\bquarter\b/.test(lower));
    // A fiscal year may be stored as FY26, 26, 2026, or as the calendar dates
    // it spans, which begin in the previous calendar year for most calendars.
    const digits = item.value.replace(/^FY/i, '');
    const full = digits.length === 2 ? Number(`20${digits}`) : Number(digits);
    // A fiscal-year field compared to the two digits the question used
    // (FISCAL_YEAR = 26) applies it; whether the data stores 26 or 2026 is
    // for the rows to say, not for this text check to guess.
    const onFiscalField = new RegExp(`\\b\\w*(?:fiscal|fy)\\w*"?\\s*(?:=|in\\s*\\()\\s*'?${digits}'?\\b`, 'i').test(sql);
    return !onFiscalField && ![`fy${digits}`, String(full), String(full - 1), `'${digits}'`].some((token) => lower.includes(token.toLowerCase()));
  });
}

export interface NamePartsByOr {
  /** The name the question states ("Los Angeles Lakers"). */
  name: string;
  /** The parts the statement matches, each alone ("Lakers", "Los Angeles"). */
  parts: [string, string];
  /** Each part's condition as written, without its table qualifier (`CITY ILIKE '%Los Angeles%'`). */
  conditions: [string, string];
  /** The table both conditions read, when the statement says which. */
  relation?: string;
  /** The two conditions and their OR, as the statement spells them. */
  text: string;
}

/**
 * A name the question states, matched by EITHER of its parts: "Los Angeles Lakers" as
 * `NICKNAME ILIKE '%Lakers%' OR CITY ILIKE '%Los Angeles%'`. Each part alone may pick other rows (the Clippers
 * play in Los Angeles too), so the host asks the warehouse whether the parts pick the same rows, and matches
 * both when they do not (new-user test, V12 gate: G3 counted 15 preseason games for the Lakers, 9 of them
 * theirs). Only two parts of one table.
 */
export function namePartsMatchedByOr(sql: string, stated: StatedValue[]): NamePartsByOr[] {
  const names = [...new Set(stated.flatMap((item) => (item.kind === 'text' && item.name ? [item.name] : [])))];
  if (names.length === 0) return [];
  const aliases = relationAliases(sql);
  const relations = [...new Set(aliases.values())];
  const operand = String.raw`((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s+((?:not\s+)?i?like)\s+'%([^%']+)%'`;
  const found: NamePartsByOr[] = [];
  for (const match of sql.matchAll(new RegExp(`${operand}\\s+or\\s+${operand}`, 'gi'))) {
    const [, leftColumn, leftOp, leftPart, rightColumn, rightOp, rightPart] = match as unknown as string[];
    if (/not/i.test(leftOp!) || /not/i.test(rightOp!) || leftPart!.toLowerCase() === rightPart!.toLowerCase()) continue;
    const name = names.find((candidate) => candidate.toLowerCase().includes(leftPart!.toLowerCase()) && candidate.toLowerCase().includes(rightPart!.toLowerCase()));
    if (!name) continue;
    const qualifier = (column: string) => (column.includes('.') ? column.split('.')[0]!.replace(/"/g, '').toLowerCase() : undefined);
    if (qualifier(leftColumn!) !== qualifier(rightColumn!)) continue;
    const bare = (column: string) => column.replace(/^"?[\w$]+"?\./, '');
    const owner = qualifier(leftColumn!);
    const relation = owner ? aliases.get(owner) : relations.length === 1 ? relations[0] : undefined;
    found.push({
      name,
      parts: [leftPart!, rightPart!],
      conditions: [`${bare(leftColumn!)} ${leftOp} '%${leftPart}%'`, `${bare(rightColumn!)} ${rightOp} '%${rightPart}%'`],
      ...(relation ? { relation } : {}),
      text: match[0],
    });
  }
  return found;
}

export interface RequiredFilterCheck { text: string; column: string; values: Array<string | number | boolean> }

const REQUIRED_FILTER_TEXT = /^\s*([A-Za-z_][\w:.]*)\s*(==|=|!=|<>|>=|<=|>|<|not in|in)\s*(.+?)\s*$/i;

/** A project's required filter ("is_test = false", "region in ('EMEA')") as a column and the values a statement must name. */
export function requiredFilterFromText(text: string): RequiredFilterCheck | undefined {
  const match = REQUIRED_FILTER_TEXT.exec(text);
  const bare = match ? undefined : /^\s*([A-Za-z_][\w:.]*)\s*$/.exec(text);
  const name = match?.[1] ?? bare?.[1];
  if (!name) return undefined;
  const column = name.split(/[:.]/).pop()!;
  if (bare) return { text, column, values: [] };
  const raw = match![3]!.trim().replace(/^\(|\)$/g, '');
  const values = raw.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    .map((part) => /^(true|false)$/i.test(part) ? part.toLowerCase() === 'true' : /^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part);
  return { text, column, values };
}

/** The required filters a statement does not apply: its column is not named, or one of its values is not. */
export function missingRequiredFilters(sql: string, required: RequiredFilterCheck[]): RequiredFilterCheck[] {
  const lower = sql.toLowerCase();
  return required.filter((filter) => {
    const column = filter.column.toLowerCase();
    if (!new RegExp(`(^|[^a-z0-9_])"?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?([^a-z0-9_]|$)`).test(lower)) return true;
    return !filter.values.every((value) => {
      if (typeof value === 'boolean') return lower.includes(String(value)) || lower.includes(value ? '= 1' : '= 0') || (!value && new RegExp(`not\\s+"?${column}`).test(lower));
      return lower.includes(String(value).toLowerCase());
    });
  });
}

/** What a statement filters on, in its own words, for the answer to repeat. */
export function appliedConditions(sql: string, maxChars = 400): string | undefined {
  const clauses: string[] = [];
  const pattern = /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\bqualify\b|\bunion\b|\)\s*(?:,|select\b|$)|$)/gi;
  for (const match of sql.matchAll(pattern)) {
    const text = match[1]!.replace(/\s+/g, ' ').trim();
    if (text) clauses.push(text);
  }
  if (clauses.length === 0) return undefined;
  const joined = clauses.join(' · ');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

export interface JoinKeyPair { left: { relation: string; column: string; qualifier?: string }; right: { relation: string; column: string; qualifier?: string } }

const RELATION_TOKEN = String.raw`((?:"[^"]+"|[A-Za-z_$][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_$][\w$]*)){0,2})`;
const NOT_ALIAS = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'order', 'limit', 'using', 'natural', 'union', 'having', 'qualify', 'lateral']);

/**
 * The text of every ON clause: from the keyword to the next clause keyword,
 * or to the parenthesis that closes the query the join sits in. Parentheses
 * opened inside the clause (`ON (a.x = b.x AND a.y = b.y)`) stay part of it.
 */
function onClauses(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, ' ');
  const clauses: string[] = [];
  const boundary = /^\s*\b(?:left|right|inner|full|cross|natural|join|where|group\s+by|order\s+by|limit|having|union|intersect|except|window|qualify)\b/i;
  for (const match of text.matchAll(/\bon\b/gi)) {
    let depth = 0;
    let index = match.index! + match[0].length;
    for (; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && /\s/.test(char) && boundary.test(text.slice(index))) break;
    }
    clauses.push(text.slice(match.index! + match[0].length, index));
  }
  return clauses;
}

/**
 * The equi-join keys of a statement, with aliases resolved to the relations
 * they name: EVERY equality of every ON clause, so a composite key joined on
 * all its columns (`ON s.match_id = b.match_id AND s.ball_id = b.ball_id …`)
 * reads as that key, not as its first column. CTE references are left out.
 */
/** The relations a statement reads, by lower-cased alias and by table name. */
function relationAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of sql.matchAll(new RegExp(String.raw`\b(?:from|join)\s+${RELATION_TOKEN}(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?`, 'gi'))) {
    const relation = match[1]!;
    const alias = match[2] && !NOT_ALIAS.has(match[2].toLowerCase()) ? match[2] : undefined;
    const tail = tableName(relation);
    aliases.set(tail.toLowerCase(), relation);
    if (alias) aliases.set(alias.toLowerCase(), relation);
  }
  return aliases;
}

export function joinKeyPairs(sql: string): JoinKeyPair[] {
  const ctes = new Set([...sql.matchAll(/(?:\bwith\b(?:\s+recursive\b)?|,)\s*([A-Za-z_][\w$]*)(?:\s*\([^)]*\))?\s+as\s*\(/gi)].map((match) => match[1]!.toLowerCase()));
  const aliases = relationAliases(sql);
  const pairs: JoinKeyPair[] = [];
  for (const clause of onClauses(sql)) {
    for (const match of clause.matchAll(/("?[\w$]+"?)\.("?[\w$]+"?)\s*=\s*("?[\w$]+"?)\.("?[\w$]+"?)/g)) {
      const left = aliases.get(match[1]!.replace(/"/g, '').toLowerCase());
      const right = aliases.get(match[3]!.replace(/"/g, '').toLowerCase());
      if (!left || !right) continue;
      if (ctes.has(left.replace(/"/g, '').toLowerCase()) || ctes.has(right.replace(/"/g, '').toLowerCase())) continue;
      pairs.push({ left: { relation: left, column: match[2]!, qualifier: match[1]!.replace(/"/g, '') }, right: { relation: right, column: match[4]!, qualifier: match[3]!.replace(/"/g, '') } });
    }
  }
  return pairs;
}

export interface JoinKeyGroup {
  left: { relation: string; qualifier?: string; columns: string[] };
  right: { relation: string; qualifier?: string; columns: string[] };
}

/**
 * The same equalities grouped into one key per pair of joined tables: the
 * columns a join matches on together. Whether a join repeats rows is a
 * property of that whole key — a (match, over, ball, innings) row is unique
 * even though a ball number repeats across matches — so a cardinality check
 * probes the tuple, never a column of it alone.
 */
export function joinKeyGroups(sql: string): JoinKeyGroup[] {
  const groups: JoinKeyGroup[] = [];
  for (const pair of joinKeyPairs(sql)) {
    const sameSides = (group: JoinKeyGroup) => group.left.qualifier === pair.left.qualifier && group.right.qualifier === pair.right.qualifier;
    const swapped = (group: JoinKeyGroup) => group.left.qualifier === pair.right.qualifier && group.right.qualifier === pair.left.qualifier;
    const existing = groups.find((group) => sameSides(group) || swapped(group));
    if (!existing) {
      groups.push({ left: { relation: pair.left.relation, qualifier: pair.left.qualifier, columns: [pair.left.column] }, right: { relation: pair.right.relation, qualifier: pair.right.qualifier, columns: [pair.right.column] } });
      continue;
    }
    const [mine, theirs] = sameSides(existing) ? [pair.left, pair.right] : [pair.right, pair.left];
    if (existing.left.columns.some((column, index) => column === mine.column && existing.right.columns[index] === theirs.column)) continue;
    existing.left.columns.push(mine.column);
    existing.right.columns.push(theirs.column);
  }
  return groups;
}

export interface GroupedColumn {
  column: string;
  /** The relation the column is read from, as the statement names it; absent for a bare column of a statement that reads several relations. */
  relation?: string;
  qualifier?: string;
}

/** Split a clause on its top-level commas (a comma inside a call is not a separator). */
function topLevelItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) { if (char === quoted) quoted = undefined; continue; }
    if (char === '\'' || char === '"') quoted = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) { items.push(text.slice(start, index)); start = index + 1; }
  }
  items.push(text.slice(start));
  return items.map((item) => item.trim()).filter(Boolean);
}

const SIMPLE_COLUMN = /^(?:("?[\w$]+"?)\.)?("?[\w$]+"?)$/;
/** A select item without its output name (`o.location_id AS store` -> `o.location_id`). */
const withoutAlias = (item: string) => item.trim().replace(/\s+(?:as\s+)?"?[\w$]+"?$/i, '').trim();

/**
 * WHAT A STATEMENT GROUPS BY. Each plain column of every GROUP BY, with the
 * relation it is read from (aliases resolved, CTEs left out). A position
 * (`GROUP BY 1`) is read from the select list before it; an expression is
 * not a column and is skipped. Best effort by design: what this cannot read
 * is not reported, so a check built on it never fails a statement it misread.
 */
export function groupedColumns(sql: string): GroupedColumn[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ctes = new Set([...text.matchAll(/(?:\bwith\b|,)\s*([A-Za-z_][\w$]*)\s+as\s*\(/gi)].map((match) => match[1]!.toLowerCase()));
  const aliases = new Map<string, string>();
  const relations: string[] = [];
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:from|join)\s+${RELATION_TOKEN}(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?`, 'gi'))) {
    const relation = match[1]!;
    if (ctes.has(relation.replace(/"/g, '').toLowerCase())) continue;
    const alias = match[2] && !NOT_ALIAS.has(match[2].toLowerCase()) ? match[2] : undefined;
    aliases.set(tableName(relation).toLowerCase(), relation);
    if (alias) aliases.set(alias.toLowerCase(), relation);
    if (!relations.includes(relation)) relations.push(relation);
  }
  const out: GroupedColumn[] = [];
  for (const match of text.matchAll(/\bgroup\s+by\b([\s\S]*?)(?=\bhaving\b|\border\s+by\b|\blimit\b|\bqualify\b|\bwindow\b|\bunion\b|\)|;|$)/gi)) {
    // The select list of the query this GROUP BY closes: the last SELECT before it.
    const before = text.slice(0, match.index);
    const select = [...before.matchAll(/\bselect\b([\s\S]*?)\bfrom\b/gi)].pop()?.[1];
    const selected = select ? topLevelItems(select.replace(/^\s*distinct\b/i, '')) : [];
    for (const written of topLevelItems(match[1]!)) {
      const item = /^\d+$/.test(written) ? withoutAlias(selected[Number(written) - 1] ?? '') : written;
      const column = SIMPLE_COLUMN.exec(withoutAlias(item));
      if (!column) continue;
      const qualifier = column[1]?.replace(/"/g, '');
      const name = column[2]!.replace(/"/g, '');
      const relation = qualifier ? aliases.get(qualifier.toLowerCase()) : relations.length === 1 ? relations[0] : undefined;
      if (qualifier && !relation) continue;
      if (!out.some((existing) => existing.column.toLowerCase() === name.toLowerCase() && existing.relation === relation)) {
        out.push({ column: name, ...(relation ? { relation } : {}), ...(qualifier ? { qualifier } : {}) });
      }
    }
  }
  return out;
}

/** Whether a statement reads a column anywhere (bare or qualified, quoted or not). */
export function mentionsColumn(sql: string, column: string): boolean {
  const escaped = column.replace(/"/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])"?${escaped}"?(?![\\w$])`, 'i').test(sql.replace(/--[^\n]*/g, ' '));
}

/**
 * LEFT JOINS THAT DO NOTHING. A LEFT JOIN keeps every row of the tables before
 * it, so a table joined that way and never used again (no column selected,
 * filtered, grouped, or joined on further) cannot restrict the answer: at best
 * it changes nothing, at worst it repeats rows. It is almost always a
 * restriction the statement meant to apply ("only the claim amounts that are
 * expense reserves") and did not. Returns the unused relations as written.
 * A join is judged only when its table's columns are known: none of them may
 * appear outside its ON clause, qualified by the table or its alias, or bare.
 */
export function unusedLeftJoins(sql: string, columnsOf: (relation: string) => string[] | undefined): string[] {
  return unusedJoins(sql, columnsOf).filter((join) => join.left).map((join) => join.relation);
}

export interface UnusedJoin {
  relation: string;
  /** The name the statement gives it: its alias, or its own name. */
  alias: string;
  left: boolean;
  /** Its columns the ON clause joins on: the key whose repeats multiply rows. */
  keys: string[];
}

/**
 * Every joined table (LEFT or inner) used nowhere outside its own ON clause.
 * A LEFT one restricts nothing (see unusedLeftJoins). An inner one may be a
 * deliberate restriction ("only amounts that are loss payments"), which is
 * harmless when it matches one row per row; when its key repeats, every total
 * of the other tables is counted once per match, which the caller checks.
 */
export function unusedJoins(sql: string, columnsOf: (relation: string) => string[] | undefined): UnusedJoin[] {
  const text = sql.replace(/--[^\n]*/g, ' ');
  const joins = [...text.matchAll(new RegExp(String.raw`\b(left\s+(?:outer\s+)?|inner\s+)?join\s+${RELATION_TOKEN}(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?\s+on\b`, 'gi'))];
  const unused: UnusedJoin[] = [];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const join of joins) {
    const relation = join[2]!;
    const columns = columnsOf(relation);
    if (!columns?.length) continue;
    const alias = join[3] && !NOT_ALIAS.has(join[3].toLowerCase()) ? join[3] : tableName(relation);
    const start = join.index! + join[0].length;
    const rest = text.slice(start);
    const end = rest.search(/\b(?:left|right|inner|full|cross|join|where|group\s+by|order\s+by|limit|having|union|qualify|window)\b|\)/i);
    const onClause = end >= 0 ? rest.slice(0, end) : rest;
    const outside = text.slice(0, join.index!) + text.slice(start + onClause.length);
    if (new RegExp(`(^|[^\\w$])"?${escape(alias)}"?\\.`, 'i').test(outside)) continue;
    // A bare column of this table, anywhere else, may be read from it.
    const bare = columns.some((column) => new RegExp(`(?<![\\w$."])"?${escape(column)}"?(?![\\w$])`, 'i').test(outside));
    if (bare) continue;
    const keys = [...onClause.matchAll(new RegExp(`(?:^|[^\\w$])"?${escape(alias)}"?\\.("?[\\w$]+"?)`, 'gi'))].map((match) => match[1]!.replace(/"/g, ''));
    unused.push({ relation, alias, left: Boolean(join[1] && /^left/i.test(join[1])), keys: [...new Set(keys)] });
  }
  return unused;
}

/**
 * Whether a statement sums, averages or counts (not distinct) a column of the
 * relation a qualifier names. Across a join that repeats the key on the other
 * side, such a total counts each of that relation's rows once per match.
 */
export function aggregatesColumnOf(sql: string, qualifier: string): boolean {
  const name = qualifier.replace(/"/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(sum|avg|count)\\s*\\(\\s*(?!distinct\\b)[^)]*\\b"?${name}"?\\s*\\.`, 'i').test(sql);
}

/** Whether a statement aggregates rows, where a join that repeats keys on both sides counts a row more than once. */
export function aggregatesRows(sql: string): boolean {
  return /\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b/i.test(sql);
}

/**
 * The drafter is told never to return more rows than the host shows, so it
 * writes that LIMIT on a plain list. Left there, exactly that many rows come
 * back and nothing can tell there were more. A LIMIT of that size comes off
 * unless the question asks for that many, so the host's own guard sees the rest.
 * A wrong guess is harmless: the same first rows come back, marked as bounded.
 */
export function withoutDrafterCap(sql: string, maxRows: number, asked: string): string {
  const askedFor = new RegExp(`\\b(?:top|first|last|bottom|limit(?:ed)?(?:\\s+(?:to|of))?|highest|lowest|best|worst)\\b(?:\\s+\\w+){0,2}\\s+${maxRows}\\b|\\b(?:show|list|give|get|return|fetch)(?:\\s+(?:me|us))?(?:\\s+the)?\\s+${maxRows}\\b`, 'i');
  if (askedFor.test(asked)) return sql;
  return sql.trim().replace(/;\s*$/, '').replace(new RegExp(`\\s+limit\\s+${maxRows}\\s*$`, 'i'), '');
}

/**
 * A statement with a top-level row limit: the one it has, or one added. A
 * statement that returns one row by construction (`SELECT COUNT(*) …` with no
 * GROUP BY) gets none: there is nothing to guard, and a saved query that
 * kept the guard read as a "Top 501" to every App tile built on it.
 */
export function withRowGuard(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+(\s+offset\s+\d+)?\s*$/i.test(trimmed) || /\bfetch\s+(first|next)\s+\d+\s+rows?\s+only\s*$/i.test(trimmed)) return trimmed;
  if (sqlReturnsOneRow(trimmed)) return trimmed;
  return `${trimmed}\nLIMIT ${maxRows}`;
}
