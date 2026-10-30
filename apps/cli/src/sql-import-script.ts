/**
 * From a legacy SQL file to the queries ZLens can keep.
 *
 * SQL brought over from Tableau, Power BI or a reporting server holds more
 * than queries: T-SQL batches without semicolons, temp tables built in steps,
 * variables set with DECLARE or SET, stored procedures, report parameters
 * written the tool's way (`:start_date`, `@Region`, `<Parameters.Store>`), and
 * cleanup or load steps that change data. This module splits a file into
 * statements, folds each script into the queries it ends in (a temp table
 * becomes a WITH clause, a variable becomes a parameter or is written into the
 * query) and says why every other statement was left out. Nothing here runs
 * SQL.
 */

export type ImportedParameterType = 'string' | 'number' | 'boolean' | 'date';

export interface ImportedSqlParameter {
  /** The saved query parameter: `${name}` in the query. */
  name: string;
  /** How the source wrote it: `:start_date`, `@Region`, `<Parameters.Store>`. */
  written: string;
  valueType: ImportedParameterType;
  /** The value the script set, when it set a plain value. Without one the parameter is required. */
  default?: string | number | boolean;
}

export type SkippedSqlStatementKind =
  | 'writes'
  | 'duplicate'
  | 'runs-procedure'
  | 'not-a-query'
  /** A BI table or data source that loads data without SQL. */
  | 'no-sql'
  /** Tableau calculated fields, DAX measures and calculated tables. */
  | 'calculations'
  /** A file ZLens could not read (a .pbix, a damaged workbook). */
  | 'unreadable';

export interface SkippedSqlStatement {
  sourcePath: string;
  kind: SkippedSqlStatementKind;
  /** One plain sentence: why ZLens did not make a draft of it. */
  reason: string;
  /** The start of the statement, for the list. */
  sql: string;
}

export interface ImportedScriptQuery {
  /** One runnable statement: the comments above it, then the query. */
  sql: string;
  parameters: ImportedSqlParameter[];
  /** What the import changed in it, or could not do, in plain sentences. */
  notes: string[];
}

export interface FoldedSqlScript {
  queries: ImportedScriptQuery[];
  skipped: Array<Omit<SkippedSqlStatement, 'sourcePath'>>;
}

const NOTE_MARKER = /^[ \t]*--[ \t]*zlens-note:[ \t]*(.*)$/gim;
const HEADER_COMMENT = /^\s*(?:--|\/\*)\s*(?:name|block|title|query)\s*:/im;

// ── Masking: find code without being fooled by strings and comments ───────

/**
 * `sql` with every string, quoted identifier and comment replaced by spaces
 * (newlines kept), so a regex over it only sees code and its offsets still
 * point into `sql`.
 */
export function maskSqlNonCode(sql: string, options: { keepQuotes?: boolean } = {}): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    // A string still ends a line as a value: `= '2024-01-01'` must not read as an open `=`.
    if (options.keepQuotes && /['"`]/.test(sql[from] ?? '') && to - 1 > from) {
      out[from] = sql[from];
      out[to - 1] = sql[to - 1];
    }
  };
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          if (sql[j + 1] === char) { j += 2; continue; }
          break;
        }
        if (char === "'" && sql[j] === '\\' && sql[j + 1] === "'") { j += 2; continue; }
        j += 1;
      }
      const stop = Math.min(sql.length, j + 1);
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag && !/^\$[A-Za-z_]\w*$/.test(tag)) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

interface CodeToken {
  text: string;
  lower: string;
  start: number;
  end: number;
  depth: number;
}

function codeTokens(masked: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const regex = /[A-Za-z_#@$][\w#@$]*|\S/g;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked))) {
    const text = match[0];
    if (text === ')') depth = Math.max(0, depth - 1);
    tokens.push({ text, lower: text.toLowerCase(), start: match.index, end: match.index + text.length, depth });
    if (text === '(') depth += 1;
  }
  return tokens;
}

/**
 * Replace regex matches found in code only (never inside strings or
 * comments). The regex runs over the masked text, so a match is code; the
 * callback also gets the masked text to look around the match.
 */
function replaceInCode(sql: string, regex: RegExp, replace: (match: RegExpExecArray, masked: string) => string): string {
  const masked = maskSqlNonCode(sql);
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const global = new RegExp(regex.source, flags);
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = global.exec(masked))) {
    if (match[0].length === 0) { global.lastIndex += 1; continue; }
    out += sql.slice(last, match.index) + replace(match, masked);
    last = match.index + match[0].length;
  }
  return out + sql.slice(last);
}

/** The original text of a regex group matched over masked text (needs the `d` flag). */
function groupText(source: string, match: RegExpExecArray, group: number): string {
  const range = match.indices?.[group];
  return range ? source.slice(range[0], range[1]) : '';
}

// ── Splitting a file into statements ────────────────────────────────────────

const STATEMENT_KEYWORDS = new Set([
  'select', 'with', 'insert', 'update', 'delete', 'merge', 'create', 'drop', 'alter', 'truncate',
  'declare', 'set', 'exec', 'execute', 'call', 'use', 'print', 'if', 'grant', 'revoke', 'copy',
]);
// After one of these the next line still belongs to the same statement.
const CONTINUES = new Set([
  'union', 'all', 'distinct', 'intersect', 'except', 'minus', 'as', 'into', 'and', 'or', 'not', 'in',
  'exists', 'then', 'else', 'when', 'on', 'by', 'from', 'join', 'where', 'having', 'select', 'values',
  'using', 'is', 'like', 'between', '(', ',', '=', '<', '>', '+', '-', '*', '/', '|', '!',
]);
const CTE_START = /^with\s+(?:recursive\s+)?[^\s(]+\s*(?:\([^)]*\)\s*)?as\s*\(/i;

/**
 * Where new statements begin inside `text`, which has no semicolons or GO
 * lines left to split on: T-SQL scripts often have none, and a pasted page of
 * reports may only leave a blank line between queries. A statement keyword
 * at the start of a line, outside parentheses, begins a new statement unless
 * the line before leaves the current one open (`UNION ALL`, `AS`, `INSERT
 * INTO t` before its SELECT, `UPDATE t` before its SET, a WITH list before its
 * main SELECT).
 *
 * With `lineStartOnly: false` it also counts a restart in the middle of a
 * line (`select a from x select b from y`), which is only warned about.
 */
export function statementStartOffsets(text: string, options: { lineStartOnly?: boolean } = {}): number[] {
  const lineStartOnly = options.lineStartOnly ?? true;
  const masked = maskSqlNonCode(text, { keepQuotes: true });
  const tokens = codeTokens(masked);
  const cuts: number[] = [];
  let first: string | null = null;
  let mainSeen = false;
  let prev: string | null = null;
  const atLineStart = (offset: number) => /^[ \t]*$/.test(masked.slice(masked.lastIndexOf('\n', offset - 1) + 1, offset));

  for (const token of tokens) {
    const word = /^[A-Za-z_]/.test(token.text) ? token.lower : null;
    if (first === null) {
      if (word) {
        first = word;
        mainSeen = word === 'select';
      }
      prev = token.lower;
      continue;
    }
    if (word && token.depth === 0 && STATEMENT_KEYWORDS.has(word) && (!lineStartOnly || atLineStart(token.start))) {
      if (startsStatement(word, first, mainSeen, prev, masked.slice(token.start, token.start + 400))) {
        cuts.push(lineStartOnly ? cutBefore(text, masked, token.start) : token.start);
        first = word;
        mainSeen = word === 'select';
        prev = word;
        continue;
      }
    }
    if (word && token.depth === 0 && !mainSeen && (first === 'with' || first === 'insert' || first === 'create')
      && (word === 'select' || ((word === 'insert' || word === 'update' || word === 'delete' || word === 'merge') && first === 'with'))) {
      mainSeen = true;
    }
    prev = token.lower;
  }
  return cuts;
}

function startsStatement(word: string, first: string, mainSeen: boolean, prev: string | null, rest: string): boolean {
  if (prev && CONTINUES.has(prev)) return false;
  switch (word) {
    case 'with':
      if (!CTE_START.test(rest)) return false; // WITH (NOLOCK), WITH ROLLUP
      return first === 'with' || first === 'insert' || first === 'create' ? mainSeen : true;
    case 'select':
      return first === 'with' || first === 'insert' || first === 'create' ? mainSeen : true;
    case 'set':
      return !['update', 'merge', 'alter'].includes(first);
    case 'insert':
    case 'update':
    case 'delete':
      if (first === 'merge') return false;
      if (first === 'with' && !mainSeen) return false;
      return true;
    default:
      return true;
  }
}

/**
 * The offset to cut at for a statement starting at `offset`: the start of its
 * line, moved up over the comments directly above it, so a comment that names
 * or describes a query stays with it.
 */
function cutBefore(text: string, masked: string, offset: number): number {
  let cut = text.lastIndexOf('\n', offset - 1) + 1;
  let probe = cut;
  let commentStart = -1;
  let sawHeader = false;
  while (probe > 0) {
    const lineStart = text.lastIndexOf('\n', probe - 2) + 1;
    const line = text.slice(lineStart, probe - 1);
    const maskedLine = masked.slice(lineStart, probe - 1);
    if (!line.trim()) {
      if (commentStart >= 0) break;
      probe = lineStart;
      continue;
    }
    if (!maskedLine.trim()) {
      commentStart = lineStart;
      if (HEADER_COMMENT.test(line)) sawHeader = true;
      probe = lineStart;
      continue;
    }
    // A code line directly above the comments: they trail that statement,
    // unless one of them is a name header.
    if (commentStart >= 0 && !sawHeader && text.slice(probe - 1, commentStart).trim() === '') return cut;
    break;
  }
  if (commentStart >= 0) cut = commentStart;
  return cut;
}

/** Split `text` where {@link statementStartOffsets} finds new statements. */
export function splitAtStatementStarts(text: string): string[] {
  const cuts = statementStartOffsets(text);
  if (cuts.length === 0) return [text];
  const parts: string[] = [];
  let last = 0;
  for (const cut of cuts) {
    if (cut <= last) continue;
    parts.push(text.slice(last, cut));
    last = cut;
  }
  parts.push(text.slice(last));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// ── Stored procedures ───────────────────────────────────────────────────────

/**
 * Replace each `CREATE PROCEDURE … AS [BEGIN] … [END]` with its body, its
 * parameters turned into DECLARE lines (so a default becomes the saved query
 * parameter's default) and a name taken from the procedure. A procedure ends
 * at the next GO line or the end of the file.
 */
export function unwrapStoredProcedures(source: string): string {
  const masked = maskSqlNonCode(source);
  const header = /(^|\n)[ \t]*create\s+(?:or\s+alter\s+)?proc(?:edure)?\s+([^\s(]+)([\s\S]*?)\bas\b/gid;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = header.exec(masked))) {
    const start = match.index + match[1].length;
    const procName = groupText(source, match, 2);
    let paramsText = groupText(source, match, 3).trim();
    if (paramsText.startsWith('(') && closingParen(maskSqlNonCode(paramsText), 0) === paramsText.length - 1) paramsText = paramsText.slice(1, -1);
    const bodyStart = match.index + match[0].length;
    const goLine = /\n[ \t]*go[ \t]*(?:\r?\n|$)/i.exec(masked.slice(bodyStart));
    const bodyEnd = goLine ? bodyStart + goLine.index : source.length;
    let body = source.slice(bodyStart, bodyEnd).trim();
    const maskedBody = maskSqlNonCode(body);
    if (/^begin\b/i.test(maskedBody)) {
      const endMatch = /\bend\s*;?\s*$/i.exec(maskedBody);
      body = body.slice(5, endMatch ? endMatch.index : body.length).trim();
    }
    const declares = splitTopLevel(paramsText, ',')
      .map((item) => /^\s*(@[\w$#]+)\s+(?:as\s+)?([A-Za-z_][\w]*(?:\s*\([^)]*\))?)\s*(?:=\s*([\s\S]+?))?\s*(?:\b(?:output|out|readonly)\b)?\s*$/i.exec(item))
      .filter((item): item is RegExpExecArray => Boolean(item))
      .map((item) => `DECLARE ${item[1]} ${item[2]}${item[3] ? ` = ${item[3].trim()}` : ''};`);
    const name = humanizeObjectName(procName);
    const lines = [
      ...(HEADER_COMMENT.test(body.split(/\r?\n/).slice(0, 12).join('\n')) || !name ? [] : [`-- name: ${name}`]),
      `-- zlens-note: Taken from stored procedure ${procName.replace(/[\[\]"]/g, '')}.`,
      ...declares,
      body,
    ];
    out += source.slice(last, start) + lines.join('\n') + '\n';
    last = bodyEnd;
    header.lastIndex = bodyEnd;
  }
  return out + source.slice(last);
}

/** `dbo.usp_store_revenue` → `Store revenue`. */
export function humanizeObjectName(name: string): string {
  const base = name.replace(/[\[\]"`]/g, '').split('.').pop() ?? '';
  const words = base
    .replace(/^#+/, '')
    .replace(/^(?:usp|sp|proc|p|vw|v|rpt)_/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

function splitTopLevel(value: string, separator: string): string[] {
  const masked = maskSqlNonCode(value);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(value.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(value.slice(last));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// ── Folding a script into its queries ──────────────────────────────────────

interface TempDefinition {
  key: string;
  written: string;
  cteName: string;
  columns: string[];
  bodies: string[];
  index: number;
  hashed: boolean;
  problem?: string;
  kind: 'temp' | 'table' | 'view';
}

interface VariableValue {
  name: string;
  written: string;
  sqlType?: string;
  /** The expression assigned, as written; undefined when declared without a value. */
  value?: string;
}

const TSQL_SET_OPTIONS = /^(?:nocount|ansi_\w+|quoted_identifier|xact_abort|transaction|datefirst|dateformat|language|rowcount|arithabort|concat_null_yields_null|numeric_roundabort|statistics|showplan_\w+|fmtonly|noexec|lock_timeout|deadlock_priority|implicit_transactions|search_path|role|timezone|time|session|schema|client_encoding|statement_timeout|query_tag|context_info|identity_insert)\b/i;

/**
 * Turn the statements of one file, in order, into the queries it holds.
 *
 * - A query (SELECT or WITH) becomes one query. Temp tables, views and tables
 *   the script built before it and the query reads become WITH clauses.
 * - DECLARE and SET give variables their values: a plain value becomes the
 *   parameter's default, an expression (`GETDATE()`) is written into the
 *   query.
 * - Comments above a step that is folded away (a name header on the CREATE
 *   TEMP TABLE) move to the next query.
 * - Session settings and temp-table cleanup are dropped quietly. Anything else
 *   that changes data, and EXEC/CALL, is listed as skipped with the reason.
 */
export function foldSqlScript(statements: string[], options: { parameters?: ImportedSqlParameter[] } = {}): FoldedSqlScript {
  const queries: ImportedScriptQuery[] = [];
  const skipped: FoldedSqlScript['skipped'] = [];
  const temps = new Map<string, TempDefinition>();
  const variables = new Map<string, VariableValue>();
  const snowflakeVariables = new Map<string, VariableValue>();
  let carriedComments: string[] = [];
  let carriedNotes: string[] = [];
  let database: string | null = null;

  const items = statements.map((statement, index) => ({ index, ...splitLeadingComments(statement) }));
  // Tables and views the script creates and a later statement reads are steps
  // of the script; one nothing reads is the script's output.
  const createdNames = items.map((item) => createdObject(item.code));
  const readLater = (key: string, from: number) => items.slice(from + 1).some((item) => referencePattern(key).test(maskSqlNonCode(item.code)));

  const skip = (kind: SkippedSqlStatementKind, reason: string, code: string) => {
    skipped.push({ kind, reason, sql: preview(code) });
  };
  const carry = (comments: string, notes: string[]) => {
    if (comments.trim()) carriedComments.push(comments.trimEnd());
    carriedNotes.push(...notes);
  };

  for (const item of items) {
    const { code, comments, notes } = item;
    const masked = maskSqlNonCode(code);
    const head = masked.trim();
    const firstWord = /^[A-Za-z_]+/.exec(head)?.[0]?.toLowerCase() ?? (head.startsWith('(') ? 'select' : '');
    const created = createdNames[item.index];

    if (created && created.body !== null) {
      const key = tempKey(created.name);
      const isScratch = created.temp || created.name.includes('#');
      if (isScratch || readLater(key, item.index)) {
        temps.set(key, newTemp(created.name, key, item.index, created.kind, created.columns, [created.body]));
        carry(comments, notes);
        continue;
      }
      if (created.kind === 'view') {
        // A view nothing in the file reads is a report: import what it selects.
        const name = humanizeObjectName(created.name);
        pushQuery(created.body, `${comments ? `${comments}\n` : ''}${HEADER_COMMENT.test(comments) || !name ? '' : `-- name: ${name}\n`}`, [...notes, `Taken from view ${cleanName(created.name)}.`]);
        continue;
      }
      skip('writes', `Creates table ${cleanName(created.name)}. ZLens imports queries that read; if this is a report, import its SELECT.`, code);
      carry(comments, []);
      continue;
    }
    if (created && created.body === null) {
      // CREATE TABLE t (columns): filled by INSERT … SELECT further on.
      const key = tempKey(created.name);
      if (created.temp || created.name.includes('#') || readLater(key, item.index)) {
        temps.set(key, newTemp(created.name, key, item.index, 'temp', created.columns, []));
        carry(comments, notes);
        continue;
      }
      skip('writes', `Creates table ${cleanName(created.name)}. ZLens imports only queries that read.`, code);
      carry(comments, []);
      continue;
    }

    const selectInto = firstWord === 'select' ? selectIntoTarget(code) : null;
    if (selectInto) {
      const key = tempKey(selectInto.target);
      if (selectInto.target.includes('#') || readLater(key, item.index)) {
        temps.set(key, newTemp(selectInto.target, key, item.index, 'temp', [], [selectInto.body]));
        carry(comments, notes);
        continue;
      }
      skip('writes', `Creates table ${cleanName(selectInto.target)} (SELECT … INTO). ZLens imports only queries that read.`, code);
      carry(comments, []);
      continue;
    }

    const assignments = firstWord === 'select' ? selectAssignments(code) : null;
    if (assignments) {
      // T-SQL `SELECT @total = SUM(x) FROM t` sets variables; it is not a report.
      for (const assignment of assignments) {
        variables.set(assignment.name, { ...(variables.get(assignment.name) ?? { name: assignment.name, written: assignment.written }), value: assignment.value });
      }
      carry(comments, notes);
      continue;
    }

    if (firstWord === 'select' || (firstWord === 'with' && !withWrites(masked))) {
      pushQuery(code, comments, notes);
      continue;
    }

    if (firstWord === 'declare') {
      for (const variable of parseDeclare(code)) variables.set(variable.name, variable);
      carry(comments, notes);
      continue;
    }
    if (firstWord === 'set') {
      const tsql = /^set\s+(@[\w$#]+)\s*=\s*([\s\S]+?)\s*;?\s*$/i.exec(code);
      if (tsql) {
        const name = variableName(tsql[1]);
        variables.set(name, { ...(variables.get(name) ?? { name, written: tsql[1] }), value: tsql[2] });
        carry(comments, notes);
        continue;
      }
      const snowflake = /^set\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*;?\s*$/i.exec(code);
      if (snowflake && !TSQL_SET_OPTIONS.test(snowflake[1])) {
        const name = variableName(snowflake[1]);
        snowflakeVariables.set(name, { name, written: `$${snowflake[1]}`, value: snowflake[2] });
      }
      carry(comments, notes);
      continue;
    }
    if (firstWord === 'use') {
      database = /^use\s+([^\s;]+)/i.exec(code)?.[1]?.replace(/[\[\]"`]/g, '') ?? database;
      carry(comments, notes);
      continue;
    }
    if (['begin', 'commit', 'rollback', 'print', 'go', 'raiserror', 'waitfor', 'end'].includes(firstWord) || /^alter\s+session\b/i.test(head)) {
      carry(comments, notes);
      continue;
    }
    if (firstWord === 'exec' || firstWord === 'execute' || firstWord === 'call') {
      skip('runs-procedure', `Runs a procedure (${firstLine(code)}). ZLens imports the queries themselves; import the procedure's SQL instead.`, code);
      carry(comments, []);
      continue;
    }

    const target = writeTarget(firstWord, code);
    if (target) {
      const key = tempKey(target.name);
      const temp = temps.get(key);
      if (temp && firstWord === 'insert' && target.select !== null) {
        temp.bodies.push(target.select);
        if (!temp.columns.length && target.columns.length) temp.columns = target.columns;
        carry(comments, notes);
        continue;
      }
      if (temp && firstWord === 'drop') {
        carry(comments, notes);
        continue;
      }
      if (temp) {
        temp.problem = `the script changes ${temp.written} after creating it (${firstWord.toUpperCase()})`;
        carry(comments, notes);
        continue;
      }
      if (firstWord === 'drop' && (target.name.includes('#') || /\btemp(?:orary)?\b/i.test(head))) {
        carry(comments, notes);
        continue;
      }
    }
    if (firstWord === 'if') {
      const inner = /\b(insert|update|delete|merge|truncate|drop|alter|create)\b\s+(?:into\s+|from\s+|table\s+|view\s+)?(?:if\s+exists\s+)?([^\s(;]+)/i.exec(masked);
      if (!inner || inner[2].includes('#') || temps.has(tempKey(code.slice(inner.index + inner[0].length - inner[2].length, inner.index + inner[0].length)))) {
        carry(comments, notes);
        continue;
      }
      skip('writes', `Changes data (IF … ${inner[1].toUpperCase()}). ZLens imports only queries that read.`, code);
      carry(comments, []);
      continue;
    }
    if (['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'copy', 'unload', 'with', 'replace', 'upsert'].includes(firstWord)) {
      skip('writes', `Changes data (${firstWord === 'with' ? 'WITH … ' : ''}${(firstWord === 'with' ? /\b(insert|update|delete|merge)\b/i.exec(masked)?.[1] ?? 'write' : firstWord).toUpperCase()}). ZLens imports only queries that read.`, code);
      carry(comments, []);
      continue;
    }
    skip('not-a-query', 'Not a query ZLens can import.', code);
    carry(comments, []);
  }
  return { queries, skipped };

  function pushQuery(queryCode: string, comments: string, notes: string[]) {
    const queryNotes = [...carriedNotes, ...notes];
    const leading = [...carriedComments, comments.trimEnd()].filter(Boolean).join('\n');
    carriedComments = [];
    carriedNotes = [];
    let sql = queryCode.trim().replace(/;\s*$/, '');
    const folded = foldTemps(sql, temps);
    sql = folded.sql;
    queryNotes.push(...folded.notes);
    if (database) queryNotes.push(`The script ran USE ${database} first. Check that the tables it reads point at that database.`);
    const converted = convertParameters(sql, variables, snowflakeVariables, options.parameters ?? []);
    queryNotes.push(...converted.notes);
    queries.push({
      sql: `${leading ? `${leading}\n` : ''}${converted.sql}`,
      parameters: converted.parameters,
      notes: Array.from(new Set(queryNotes)),
    });
  }
}

function newTemp(written: string, key: string, index: number, kind: TempDefinition['kind'], columns: string[], bodies: string[]): TempDefinition {
  const base = key.replace(/^#+/, '');
  const cteName = /^[A-Za-z_][\w]*$/.test(base) ? base : (base.replace(/[^\w]+/g, '_').replace(/^(\d)/, '_$1') || `step_${index + 1}`);
  return { key, written: cleanName(written), cteName, columns, bodies, index, hashed: key.startsWith('#'), kind };
}

function splitLeadingComments(statement: string): { comments: string; code: string; notes: string[] } {
  const notes: string[] = [];
  const withoutMarkers = statement.replace(NOTE_MARKER, (_line, note: string) => {
    if (note.trim()) notes.push(note.trim());
    return '';
  });
  const masked = maskSqlNonCode(withoutMarkers);
  const codeStart = masked.search(/\S/);
  if (codeStart < 0) return { comments: withoutMarkers.trim(), code: '', notes };
  const lineStart = withoutMarkers.lastIndexOf('\n', codeStart - 1) + 1;
  const prefixOnLine = masked.slice(lineStart, codeStart);
  const cut = /^\s*$/.test(prefixOnLine) ? lineStart : codeStart;
  return {
    comments: withoutMarkers.slice(0, cut).replace(/\n{2,}/g, '\n').trim(),
    code: withoutMarkers.slice(cut).trim(),
    notes,
  };
}

interface CreatedObject {
  name: string;
  kind: 'temp' | 'table' | 'view';
  temp: boolean;
  columns: string[];
  /** The SELECT it is built from; null for CREATE TABLE t (columns). */
  body: string | null;
}

function createdObject(code: string): CreatedObject | null {
  const masked = maskSqlNonCode(code);
  const asSelect = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:local|global)\s+)?(?:(temp|temporary|volatile|transient|multiset\s+volatile)\s+)?(table|view)\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*(\([^)]*\))?\s*(?:with\s*\([^)]*\)\s*)?as\b/id.exec(masked);
  if (asSelect) {
    let body = code.slice(asSelect[0].length).trim().replace(/;\s*$/, '');
    body = body.replace(/\s+with\s+(?:no\s+)?data\b[\s\S]*$/i, '').replace(/\s+on\s+commit\s+preserve\s+rows\s*$/i, '').trim();
    const maskedBody = maskSqlNonCode(body);
    if (maskedBody.startsWith('(') && closingParen(maskedBody, 0) === maskedBody.trimEnd().length - 1) body = body.slice(1, body.trimEnd().length - 1).trim();
    if (!/^\s*(?:select|with|\()/i.test(maskSqlNonCode(body))) return null;
    const columnList = groupText(code, asSelect, 4);
    return {
      name: groupText(code, asSelect, 3),
      kind: asSelect[2].toLowerCase() === 'view' ? 'view' : asSelect[1] ? 'temp' : 'table',
      temp: Boolean(asSelect[1]),
      columns: columnList ? splitTopLevel(columnList.slice(1, -1), ',').map(cleanName) : [],
      body,
    };
  }
  const withColumns = /^\s*create\s+(?:(?:local|global)\s+)?(?:(temp|temporary|volatile|multiset\s+volatile)\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/id.exec(masked);
  if (withColumns) {
    const open = withColumns.index + withColumns[0].length - 1;
    const close = closingParen(masked, open);
    const defs = splitTopLevel(code.slice(open + 1, close < 0 ? code.length : close), ',');
    const columns = defs
      .filter((def) => !/^(?:constraint|primary|unique|foreign|check|index|key)\b/i.test(def))
      .map((def) => cleanName(def.split(/\s+/)[0] ?? ''))
      .filter(Boolean);
    return { name: groupText(code, withColumns, 2), kind: 'temp', temp: Boolean(withColumns[1]), columns, body: null };
  }
  return null;
}

function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `SELECT … INTO #t FROM …`: the target and the query without its INTO. */
function selectIntoTarget(code: string): { target: string; body: string } | null {
  const masked = maskSqlNonCode(code);
  const tokens = codeTokens(masked);
  const into = tokens.find((token) => token.depth === 0 && token.lower === 'into');
  if (!into) return null;
  const from = tokens.find((token) => token.depth === 0 && token.lower === 'from');
  if (from && from.start < into.start) return null;
  const targetMatch = /^\s*([^\s,;()]+)/.exec(masked.slice(into.end));
  if (!targetMatch) return null;
  const targetStart = into.end + targetMatch[0].length - targetMatch[1].length;
  const target = code.slice(targetStart, targetStart + targetMatch[1].length);
  const body = `${code.slice(0, into.start).trimEnd()}\n${code.slice(targetStart + targetMatch[1].length).trimStart()}`.trim().replace(/;\s*$/, '');
  return { target, body };
}

/** `SELECT @a = expr, @b = expr [FROM …]`: each variable and the scalar query that sets it, or null for a real SELECT. */
function selectAssignments(code: string): Array<{ name: string; written: string; value: string }> | null {
  const masked = maskSqlNonCode(code);
  if (!/^\s*select\s+@/i.test(masked)) return null;
  const tokens = codeTokens(masked);
  const from = tokens.find((token) => token.depth === 0 && token.lower === 'from');
  const listStart = /^\s*select\s+/i.exec(masked)![0].length;
  const listEnd = from ? from.start : code.length;
  const rest = from ? code.slice(from.start).trim().replace(/;\s*$/, '') : '';
  const items = splitTopLevel(code.slice(listStart, listEnd), ',');
  const parsed = items.map((item) => /^(@[\w$#]+)\s*=\s*([\s\S]+)$/.exec(item.trim()));
  if (!parsed.length || parsed.some((item) => !item)) return null;
  return parsed.map((item) => ({
    name: variableName(item![1]),
    written: item![1],
    value: rest ? `SELECT ${item![2].trim().replace(/;\s*$/, '')} ${rest}` : item![2].trim().replace(/;\s*$/, ''),
  }));
}

function withWrites(masked: string): boolean {
  const tokens = codeTokens(masked);
  return tokens.some((token) => token.depth === 0 && ['insert', 'update', 'delete', 'merge'].includes(token.lower));
}

function writeTarget(firstWord: string, code: string): { name: string; columns: string[]; select: string | null } | null {
  const masked = maskSqlNonCode(code);
  let match: RegExpExecArray | null = null;
  switch (firstWord) {
    case 'insert': {
      match = /^\s*insert\s+(?:into\s+)?([^\s(]+)\s*(\([^)]*\))?\s*/id.exec(masked);
      if (!match) return null;
      const columnList = groupText(code, match, 2);
      const rest = code.slice(match[0].length).trim().replace(/;\s*$/, '');
      return {
        name: groupText(code, match, 1),
        columns: columnList ? splitTopLevel(columnList.slice(1, -1), ',').map(cleanName) : [],
        select: /^(?:select|with|\()/i.test(maskSqlNonCode(rest).trim()) ? rest : null,
      };
    }
    case 'update':
      match = /^\s*update\s+([^\s(;]+)/i.exec(masked);
      break;
    case 'delete':
      match = /^\s*delete\s+(?:from\s+)?([^\s(;]+)/i.exec(masked);
      break;
    case 'truncate':
      match = /^\s*truncate\s+(?:table\s+)?([^\s(;]+)/i.exec(masked);
      break;
    case 'drop':
      match = /^\s*drop\s+(?:table|view|temporary\s+table)\s+(?:if\s+exists\s+)?([^\s(;]+)/i.exec(masked);
      break;
    case 'alter':
      match = /^\s*alter\s+table\s+([^\s(;]+)/i.exec(masked);
      break;
    default:
      return null;
  }
  if (!match) return null;
  const offset = match.index + match[0].lastIndexOf(match[1]);
  return { name: code.slice(offset, offset + match[1].length), columns: [], select: null };
}

function tempKey(name: string): string {
  const clean = cleanName(name);
  const parts = clean.split('.').filter(Boolean);
  return (parts.pop() ?? clean).toLowerCase();
}

function cleanName(name: string): string {
  return name.replace(/[\[\]"`]/g, '').trim();
}

function referencePattern(key: string): RegExp {
  const base = key.replace(/^#+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return key.startsWith('#')
    ? new RegExp(`(?<![\\w$@])(?:[\\w\\[\\]]+\\.\\.?)?\\[?#{1,2}${base}\\]?(?![\\w$])`, 'i')
    : new RegExp(`(?<![\\w.#@$\\]])\\[?${base}\\]?(?![\\w$])`, 'i');
}

function foldTemps(sql: string, temps: Map<string, TempDefinition>): { sql: string; notes: string[] } {
  if (temps.size === 0) return { sql, notes: [] };
  const used: TempDefinition[] = [];
  const visit = (text: string, before: number) => {
    const masked = maskSqlNonCode(text);
    for (const temp of temps.values()) {
      if (temp.index >= before || used.includes(temp)) continue;
      if (!referencePattern(temp.key).test(masked)) continue;
      used.push(temp);
      for (const body of temp.bodies) visit(body, temp.index);
    }
  };
  visit(sql, Number.MAX_SAFE_INTEGER);
  if (used.length === 0) return { sql, notes: [] };
  const broken = used.find((temp) => temp.problem || temp.bodies.length === 0);
  if (broken) {
    return {
      sql,
      notes: [`This query reads ${broken.written}, but ${broken.problem ?? `the script never fills ${broken.written}`}. ZLens could not turn it into one query; rewrite it as one SELECT.`],
    };
  }
  used.sort((a, b) => a.index - b.index);
  const rename = (text: string) => used.reduce(
    (current, temp) => replaceInCode(current, new RegExp(referencePattern(temp.key).source, 'gi'), () => temp.cteName),
    text,
  );
  const hoisted: string[] = [];
  const ctes = used.map((temp) => {
    const bodies = temp.bodies.map((body) => {
      const split = splitWithList(rename(body));
      if (split.ctes) hoisted.push(split.ctes);
      return split.main;
    });
    const columns = temp.columns.length ? ` (${temp.columns.join(', ')})` : '';
    return `${temp.cteName}${columns} AS (\n${bodies.join('\nUNION ALL\n')}\n)`;
  });
  const query = rename(sql);
  const own = splitWithList(query);
  const recursive = own.recursive ? 'RECURSIVE ' : '';
  const list = [...hoisted, ...ctes, ...(own.ctes ? [own.ctes] : [])].join(',\n');
  const steps = used.map((temp) => temp.written).join(', ');
  return {
    sql: `WITH ${recursive}${list}\n${own.main}`,
    notes: [`Built from a script of several steps: ${steps} ${used.length === 1 ? 'became a WITH clause' : 'became WITH clauses'}.`],
  };
}

/** `WITH a AS (…), b AS (…) SELECT …` → its CTE list and its main statement. */
function splitWithList(sql: string): { ctes: string | null; main: string; recursive: boolean } {
  const masked = maskSqlNonCode(sql);
  const opening = /^\s*with\s+(recursive\s+)?/i.exec(masked);
  if (!opening) return { ctes: null, main: sql.trim(), recursive: false };
  const tokens = codeTokens(masked).filter((token) => token.start >= opening[0].length);
  const main = tokens.find((token) => token.depth === 0 && ['select', 'insert', 'update', 'delete', 'merge'].includes(token.lower));
  if (!main) return { ctes: null, main: sql.trim(), recursive: false };
  return {
    ctes: sql.slice(opening[0].length, main.start).trim().replace(/,\s*$/, ''),
    main: sql.slice(main.start).trim(),
    recursive: Boolean(opening[1]),
  };
}

function parseDeclare(code: string): VariableValue[] {
  const body = code.replace(/^\s*declare\s+/i, '').replace(/;\s*$/, '');
  return splitTopLevel(body, ',')
    .map((item) => /^(@[\w$#]+)\s+(?:as\s+)?([A-Za-z_]\w*(?:\s*\([^)]*\))?)\s*(?:=\s*([\s\S]+))?$/i.exec(item.trim()))
    .filter((item): item is RegExpExecArray => Boolean(item))
    .map((item) => ({ name: variableName(item[1]), written: item[1], sqlType: item[2], ...(item[3] ? { value: item[3].trim() } : {}) }));
}

/** `@StartDate` / `Start Date` / `startDate` → `start_date`. */
export function variableName(written: string): string {
  return written
    .replace(/^[@:$#]+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .replace(/^(\d)/, '_$1');
}

// ── Parameters ─────────────────────────────────────────────────────────────

function convertParameters(
  sql: string,
  variables: Map<string, VariableValue>,
  snowflakeVariables: Map<string, VariableValue>,
  declared: ImportedSqlParameter[],
): { sql: string; parameters: ImportedSqlParameter[]; notes: string[] } {
  const parameters = new Map<string, ImportedSqlParameter>();
  // `${name}` already: a BI file's parameter (Tableau, Power BI) with its current
  // value, or a saved query parameter someone wrote by hand.
  const masked = maskSqlNonCode(sql);
  const placeholder = /\$\{\s*([A-Za-z_]\w*)\s*\}/g;
  let existing: RegExpExecArray | null;
  while ((existing = placeholder.exec(masked))) {
    const name = existing[1];
    if (parameters.has(name)) continue;
    const known = declared.find((parameter) => parameter.name === name);
    parameters.set(name, known ?? { name, written: existing[0], valueType: parameterType(name, undefined, undefined) });
  }
  const notes: string[] = [];
  const inlined = new Set<string>();
  const useVariable = (variable: VariableValue | undefined, written: string, ownName?: string): string => {
    const name = variable?.name ?? ownName ?? variableName(written);
    const literal = variable?.value === undefined ? undefined : parseLiteral(variable.value);
    if (variable?.value !== undefined && literal === undefined) {
      if (!inlined.has(name)) {
        inlined.add(name);
        notes.push(/^null$/i.test(variable.value.trim())
          ? `${written} defaults to NULL, so it was written into the query as NULL rather than made a parameter.`
          : `${written} is set to ${variable.value.trim()}, so that expression was written into the query.`);
      }
      return `(${variable.value.trim()})`;
    }
    if (!parameters.has(name)) {
      parameters.set(name, {
        name,
        written,
        valueType: parameterType(name, variable?.sqlType, literal),
        ...(literal !== undefined ? { default: literal } : {}),
      });
    }
    return '${' + name + '}';
  };

  let next = replaceInCode(sql, /<Parameters\.([^>\n]+)>/g, (match) => useVariable(undefined, match[0], variableName(match[1])));
  next = replaceInCode(next, /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (match) => useVariable(undefined, match[0], variableName(match[1])));
  next = replaceInCode(next, /(?<![\w@])@(?!@)([A-Za-z_][\w$#]*)(?!\s*\()/g, (match, masked) => {
    // `FROM @stage` is a Snowflake stage, not a parameter.
    if (/\b(?:from|join)\s*$/i.test(masked.slice(Math.max(0, match.index - 12), match.index))) return match[0];
    return useVariable(variables.get(variableName(match[1])), match[0]);
  });
  next = replaceInCode(next, /(?<=^|[\s(,=<>!+\-*/]):([A-Za-z_]\w*)\b/g, (match) => useVariable(undefined, match[0]));
  if (snowflakeVariables.size) {
    next = replaceInCode(next, /(?<![\w$])\$([A-Za-z_]\w*)\b/g, (match) => {
      const variable = snowflakeVariables.get(variableName(match[1]));
      return variable ? useVariable(variable, match[0]) : match[0];
    });
  }
  for (const parameter of parameters.values()) {
    if (parameter.default === undefined) {
      notes.push(`${parameter.written} became the parameter ${parameter.name}. Give it a default value so the preview and Certify can run the query.`);
    }
  }
  if (parameters.size && !notes.some((note) => note.includes('became the parameter'))) {
    notes.push(`Report parameters became saved query parameters: ${Array.from(parameters.values()).map((parameter) => `${parameter.written} → ${parameter.name}`).join(', ')}.`);
  }
  return { sql: next, parameters: Array.from(parameters.values()), notes };
}

/** A plain value a parameter can default to, or undefined for an expression or NULL. */
function parseLiteral(raw: string): string | number | boolean | undefined {
  const value = raw.trim().replace(/;$/, '').trim();
  const quoted = /^N?'((?:''|[^'])*)'$/i.exec(value);
  if (quoted) return quoted[1].replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  const typed = /^(?:date|timestamp)\s+'([^']*)'$/i.exec(value)
    ?? /^cast\s*\(\s*'([^']*)'\s+as\s+\w+\s*\)$/i.exec(value)
    ?? /^convert\s*\(\s*\w+\s*,\s*'([^']*)'\s*(?:,\s*\d+\s*)?\)$/i.exec(value);
  if (typed) return typed[1];
  return undefined;
}

function parameterType(name: string, sqlType: string | undefined, value: string | number | boolean | undefined): ImportedParameterType {
  const type = sqlType?.toLowerCase() ?? '';
  if (/date|time/.test(type)) return 'date';
  if (/int|decimal|numeric|float|real|money|double|number/.test(type)) return 'number';
  if (/^bit$|bool/.test(type)) return 'boolean';
  if (type) return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  if (/(?:^|_)(?:date|day|month|week|period|start|end|since|until|from|to)(?:_|$)|_at$|_on$/.test(name)) return 'date';
  if (/(?:^|_)(?:year|top_n|limit|count|num|number|qty|quantity|amount|days|months)(?:_|$)/.test(name)) return 'number';
  return 'string';
}

function preview(code: string): string {
  const text = code.trim().replace(/\s+/g, ' ');
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function firstLine(code: string): string {
  const line = code.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line.replace(/;\s*$/, '');
}

/**
 * A fingerprint of a query's logic, to find the same query twice in one
 * import: comments, letter case outside strings and spacing do not count.
 */
export function sqlLogicFingerprint(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      // A string or quoted name stays exactly as written.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          if (sql[j + 1] === char) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += char.toLowerCase();
    i += 1;
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=<>+*/;-])\s*/g, '$1')
    .replace(/;+$/, '')
    .trim();
}
