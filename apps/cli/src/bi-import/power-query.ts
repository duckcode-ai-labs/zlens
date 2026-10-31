import { variableName, type ImportedParameterType, type ImportedSqlParameter } from '../sql-import-script.js';
import type { BiTableSource } from './types.js';

/**
 * Reading the SQL out of Power Query (M) code: a Power BI table loads its rows
 * with an M expression, and the SQL a report runs sits in it as
 * `Value.NativeQuery(source, "select …")`, as `Sql.Database(server, db,
 * [Query="select …"])` (and the other connectors' Query option), or as
 * `Odbc.Query(dsn, "select …")`. The SQL text is often built with `&` from
 * string literals and parameters; parameters become saved query parameters.
 */

interface MToken {
  kind: 'string' | 'identifier' | 'number' | 'punct';
  /** The token as written; for a string, its decoded value is `value`. */
  text: string;
  value: string;
  start: number;
}

export interface PowerQueryParameter {
  name: string;
  valueType: ImportedParameterType;
  default?: string | number | boolean;
}

export interface NativeQuery {
  sql: string;
  /** The connector the query runs on, as people say it (`SQL Server`), when known. */
  connector?: string;
  parameters: ImportedSqlParameter[];
  notes: string[];
}

export interface PowerQueryReading {
  queries: NativeQuery[];
  /** Tables the expression loads without SQL (`dbo.ORDERS`), for the left-out list. */
  tables: string[];
  /** What the expression loads from when it is neither SQL nor a table (`Csv.Document`). */
  otherSources: string[];
  /** The database connector the expression uses, as people say it (`Snowflake`), when known. */
  connector?: string;
}

const CONNECTORS: Array<[RegExp, string]> = [
  [/^Sql\.Databases?$/i, 'SQL Server'],
  [/^Snowflake\.Databases$/i, 'Snowflake'],
  [/^PostgreSQL\.Database$/i, 'PostgreSQL'],
  [/^(?:Databricks|DatabricksMultiCloud)\.(?:Catalogs|Contents|Query)$/i, 'Databricks'],
  [/^AmazonRedshift\.Database$/i, 'Redshift'],
  [/^GoogleBigQuery\.Database$/i, 'BigQuery'],
  [/^Oracle\.Database$/i, 'Oracle'],
  [/^MySQL\.Database$/i, 'MySQL'],
  [/^Teradata\.Database$/i, 'Teradata'],
  [/^(?:Odbc|OleDb|AdoDotNet)\.(?:Query|DataSource)$/i, 'ODBC'],
];
const FILE_SOURCES = /^(?:Csv\.Document|Excel\.Workbook|Json\.Document|Xml\.Tables|Web\.Contents|SharePoint\.\w+|Folder\.\w+|File\.Contents|OData\.Feed|Salesforce\.\w+|Dataflows?\.\w+|PowerPlatform\.\w+|AzureStorage\.\w+|Lakehouse\.\w+|Fabric\.\w+)$/i;

export function readPowerQuery(expression: string, context: { parameters: Map<string, PowerQueryParameter>; shared: Map<string, string> }): PowerQueryReading {
  const tokens = tokenize(expression);
  const bindings = letBindings(tokens);
  const queries: NativeQuery[] = [];
  const connector = findConnector(tokens, context.shared);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let sqlRange: [number, number] | null = null;
    if (token.kind === 'identifier' && /^Value\.NativeQuery$/i.test(token.text) && tokens[index + 1]?.text === '(') {
      sqlRange = callArguments(tokens, index + 1)[1] ?? null;
    } else if (token.kind === 'identifier' && /^(?:Odbc|OleDb|AdoDotNet)\.Query$/i.test(token.text) && tokens[index + 1]?.text === '(') {
      sqlRange = callArguments(tokens, index + 1)[1] ?? null;
    } else if (token.kind === 'identifier' && token.text === 'Query' && tokens[index + 1]?.text === '=' && insideRecord(tokens, index)) {
      sqlRange = [index + 2, valueEnd(tokens, index + 2)];
    }
    if (!sqlRange) continue;
    const text = evaluateText(tokens, sqlRange, { bindings, parameters: context.parameters, shared: context.shared, depth: 0 });
    if (!text || !text.parts.length || !/\b(?:select|with)\b/i.test(text.parts.filter((part) => part.kind === 'text').map((part) => part.value).join(' '))) continue;
    queries.push(assemble(text.parts, connector));
  }

  const tables = queries.length ? [] : navigationTables(tokens);
  const otherSources = queries.length || tables.length
    ? []
    : Array.from(new Set(tokens.filter((token) => token.kind === 'identifier' && FILE_SOURCES.test(token.text)).map((token) => token.text)));
  return { queries, tables, otherSources, ...(connector ? { connector } : {}) };
}

/** What a Power Query that loads a database table does after picking it. */
export interface PowerQueryTable {
  source?: BiTableSource;
  /** The column's name after Power Query (lower case) → the database column, through `Table.RenameColumns`. */
  renames: Map<string, string>;
  /** Database columns (lower case) changed to a type that changes their values, with the type as written. */
  changedTypes: Record<string, string>;
  /** Steps that change the rows or values (`Table.SelectRows`, `Table.AddColumn`), so the table is no longer the database's. */
  changingSteps: string[];
}

/** Steps that keep the table's rows and values: renaming, picking or ordering columns, changing types. */
const KEEPING_STEPS = /^Table\.(?:RenameColumns|TransformColumnTypes|SelectColumns|RemoveColumns|ReorderColumns|Sort|Buffer)$/i;
/** Types that change a column's values: a whole number or a fixed decimal rounds, a date drops the time. */
const CHANGES_VALUES = /^(?:Int64\.Type|Int32\.Type|Int16\.Type|Int8\.Type|Byte\.Type|Currency\.Type|Date\.Type|DateTime\.Type|DateTimeZone\.Type|type\s+(?:date|datetime|datetimezone))$/i;

/**
 * The database table a Power Query loads (`Source{[Schema="dbo",Item="ORDERS"]}`),
 * the server and database it connects to, and the steps after it: renames
 * are followed back to the database column, a change to a whole number or a
 * date is noted per column, and any other step means the table changed.
 */
export function readPowerQueryTable(expression: string, context: { shared: Map<string, string> }): PowerQueryTable {
  const tokens = tokenize(expression);
  const result: PowerQueryTable = { renames: new Map(), changedTypes: {}, changingSteps: [] };
  const tables = navigationTables(tokens);
  if (tables.length === 1) {
    const dot = tables[0]!.lastIndexOf('.');
    const connection = connectionOf(tokens, context.shared);
    result.source = {
      ...(dot > 0 ? { schema: tables[0]!.slice(0, dot) } : {}),
      table: dot > 0 ? tables[0]!.slice(dot + 1) : tables[0]!,
      ...connection,
    };
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'identifier' || !/^Table\./i.test(token.text) || tokens[index + 1]?.text !== '(') continue;
    if (!KEEPING_STEPS.test(token.text)) {
      result.changingSteps.push(token.text);
      continue;
    }
    const args = callArguments(tokens, index + 1);
    const pairs = args[1] ? listPairs(tokens, args[1]) : [];
    if (/^Table\.RenameColumns$/i.test(token.text)) {
      for (const [from, to] of pairs) {
        if (typeof from !== 'string' || typeof to !== 'string') continue;
        const original = result.renames.get(from.toLowerCase()) ?? from;
        result.renames.set(to.toLowerCase(), original);
      }
    } else if (/^Table\.TransformColumnTypes$/i.test(token.text)) {
      for (const [column, type] of pairs) {
        if (typeof column !== 'string' || typeof type !== 'object') continue;
        if (CHANGES_VALUES.test(type.written)) result.changedTypes[(result.renames.get(column.toLowerCase()) ?? column).toLowerCase()] = type.written;
      }
    }
  }
  return result;
}

/** `{{"a", "b"}, {"c", Int64.Type}}` or `{"a", "b"}` → [a, b] pairs; a value that is not text comes back as written. */
function listPairs(tokens: MToken[], [start, end]: [number, number]): Array<[string | { written: string }, string | { written: string }]> {
  const value = (range: [number, number]): string | { written: string } => {
    const [from, to] = range;
    if (to - from === 1 && tokens[from]!.kind === 'string') return tokens[from]!.value;
    return { written: tokens.slice(from, to).map((token) => token.text).join(' ').replace(/\s*\.\s*/g, '.') };
  };
  let at = start;
  while (at < end && tokens[at]!.text !== '{') at += 1;
  if (at >= end) return [];
  const inner = splitTopLevel(tokens, at + 1, closing(tokens, at), ',');
  const nested = inner.every(([from]) => tokens[from]?.text === '{');
  const lists = nested ? inner.map(([from]) => splitTopLevel(tokens, from + 1, closing(tokens, from), ',')) : [inner];
  return lists.filter((items) => items.length >= 2).map((items) => [value(items[0]!), value(items[1]!)]);
}

/** The server and database a connector call names: `Sql.Database("server", "db")`, or the `Kind="Database"` it navigates to. */
function connectionOf(tokens: MToken[], shared: Map<string, string>, depth = 0): Omit<BiTableSource, 'table' | 'schema'> {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const known = token.kind === 'identifier' ? CONNECTORS.find(([pattern]) => pattern.test(token.text)) : undefined;
    if (!known || tokens[index + 1]?.text !== '(') continue;
    const args = callArguments(tokens, index + 1).map(([from, to]) => (to - from === 1 && tokens[from]!.kind === 'string' ? tokens[from]!.value : undefined));
    const navigated = navigationDatabase(tokens);
    const namesDatabase = /^(?:Sql\.Database|PostgreSQL\.Database|AmazonRedshift\.Database|MySQL\.Database|Oracle\.Database|Teradata\.Database)$/i.test(token.text);
    const database = (namesDatabase ? args[1] : undefined) ?? navigated;
    return { connector: known[1], ...(args[0] ? { server: args[0] } : {}), ...(database ? { database } : {}) };
  }
  if (depth < 2) {
    for (const token of tokens) {
      const sharedExpression = token.kind === 'identifier' ? shared.get(token.text) : undefined;
      if (!sharedExpression) continue;
      const found = connectionOf(tokenize(sharedExpression), shared, depth + 1);
      if (found.connector) return { ...found, ...(found.database ? {} : navigationDatabase(tokens) ? { database: navigationDatabase(tokens) } : {}) };
    }
  }
  return {};
}

function navigationDatabase(tokens: MToken[]): string | undefined {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index]!.text !== '{' || tokens[index + 1]?.text !== '[') continue;
    const end = closing(tokens, index + 1);
    const fields = new Map<string, string>();
    for (let field = index + 2; field < end - 2; field += 1) {
      if (tokens[field]!.kind === 'identifier' && tokens[field + 1]!.text === '=' && tokens[field + 2]!.kind === 'string') fields.set(tokens[field]!.text.toLowerCase(), tokens[field + 2]!.value);
    }
    if ((fields.get('kind') ?? '').toLowerCase() === 'database' && fields.get('name')) return fields.get('name');
  }
  return undefined;
}

// ── Assembling the SQL text ────────────────────────────────────────────────

type TextPart = { kind: 'text'; value: string } | { kind: 'parameter'; name: string; written: string; known?: PowerQueryParameter } | { kind: 'unknown'; written: string };

function assemble(parts: TextPart[], connector: string | undefined): NativeQuery {
  const parameters = new Map<string, ImportedSqlParameter>();
  const notes: string[] = [];
  let unknown = 0;
  let sql = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      sql += part.value;
      continue;
    }
    const name = part.kind === 'parameter' ? part.name : `power_query_value_${++unknown}`;
    if (part.kind === 'unknown') notes.push(`Part of this SQL is built by Power Query code ZLens cannot read (${shorten(part.written)}); it became the parameter ${name}. Check the query.`);
    if (!parameters.has(name)) {
      const known = part.kind === 'parameter' ? part.known : undefined;
      parameters.set(name, {
        name,
        written: part.written,
        valueType: known?.valueType ?? 'string',
        ...(known?.default !== undefined ? { default: known.default } : {}),
      });
    }
    sql += '${' + name + '}';
  }
  // Power Query puts a text value inside SQL quotes ('" & Region & "'); a saved
  // query parameter is bound as a value, so the quotes go.
  sql = sql.replace(/N?'\$\{([A-Za-z_]\w*)\}'/g, (_whole, name: string) => '${' + name + '}');
  return { sql: sql.trim(), ...(connector ? { connector } : {}), parameters: Array.from(parameters.values()), notes };
}

function evaluateText(
  tokens: MToken[],
  [start, end]: [number, number],
  context: { bindings: Map<string, [number, number]>; parameters: Map<string, PowerQueryParameter>; shared: Map<string, string>; depth: number },
): { parts: TextPart[] } | null {
  if (start >= end || context.depth > 8) return null;
  const parts: TextPart[] = [];
  for (const [partStart, partEnd] of splitTopLevel(tokens, start, end, '&')) {
    const first = tokens[partStart];
    if (!first) continue;
    const written = tokens.slice(partStart, partEnd).map((token) => token.text).join(' ');
    if (partEnd - partStart === 1 && first.kind === 'string') {
      parts.push({ kind: 'text', value: first.value });
      continue;
    }
    if (first.text === '(' && closing(tokens, partStart) === partEnd - 1) {
      const inner = evaluateText(tokens, [partStart + 1, partEnd - 1], { ...context, depth: context.depth + 1 });
      if (inner) { parts.push(...inner.parts); continue; }
    }
    if (partEnd - partStart === 1 && first.kind === 'identifier') {
      const parameter = context.parameters.get(first.text) ?? context.parameters.get(first.text.toLowerCase());
      if (parameter) { parts.push({ kind: 'parameter', name: parameter.name, written: first.text, known: parameter }); continue; }
      const binding = context.bindings.get(first.text);
      if (binding) {
        const inner = evaluateText(tokens, binding, { ...context, depth: context.depth + 1 });
        if (inner) { parts.push(...inner.parts); continue; }
      }
      // A shared query that holds the SQL text (Query = SalesSql).
      const sharedExpression = context.shared.get(first.text);
      if (sharedExpression) {
        const sharedTokens = tokenize(sharedExpression);
        const sharedBindings = letBindings(sharedTokens);
        const range: [number, number] = sharedBindings.size ? (() => {
          const inAt = sharedTokens.findIndex((token, at) => token.text === 'in' && at > 0);
          const result = sharedTokens[inAt + 1];
          return result && sharedBindings.has(result.text) ? sharedBindings.get(result.text)! : [0, sharedTokens.length];
        })() : [0, sharedTokens.length];
        const inner = evaluateText(sharedTokens, range, { ...context, bindings: sharedBindings, depth: context.depth + 1 });
        if (inner && inner.parts.some((part) => part.kind === 'text')) { parts.push(...inner.parts); continue; }
      }
      parts.push({ kind: 'parameter', name: variableName(first.text), written: first.text });
      continue;
    }
    // Text.From(Region), Date.ToText(StartDate, "yyyy-MM-dd"): the value inside.
    if (first.kind === 'identifier' && /^(?:Text\.From|Number\.ToText|Date\.ToText|DateTime\.ToText|DateTimeZone\.ToText|Text\.Trim)$/i.test(first.text) && tokens[partStart + 1]?.text === '(' && closing(tokens, partStart + 1) === partEnd - 1) {
      const argument = callArguments(tokens, partStart + 1)[0];
      const inner = argument ? evaluateText(tokens, argument, { ...context, depth: context.depth + 1 }) : null;
      if (inner && inner.parts.every((part) => part.kind !== 'text')) { parts.push(...inner.parts); continue; }
    }
    parts.push({ kind: 'unknown', written });
  }
  return { parts };
}

// ── Finding things in the code ─────────────────────────────────────────────

function findConnector(tokens: MToken[], shared: Map<string, string>, depth = 0): string | undefined {
  for (const token of tokens) {
    if (token.kind !== 'identifier') continue;
    const known = CONNECTORS.find(([pattern]) => pattern.test(token.text));
    if (known) return known[1];
  }
  if (depth > 2) return undefined;
  // `Source = SharedSource`: the connector is in a shared query.
  for (const token of tokens) {
    const sharedExpression = token.kind === 'identifier' ? shared.get(token.text) : undefined;
    if (sharedExpression) {
      const found = findConnector(tokenize(sharedExpression), shared, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `Source{[Schema="dbo",Item="ORDERS"]}[Data]`, `{[Name="orders",Kind="Table"]}`, and a
 * chain of plain names (`{[Name="tpch"]}` then `{[Name="region"]}`) → dbo.ORDERS, orders, tpch.region.
 */
function navigationTables(tokens: MToken[]): string[] {
  const tables: string[] = [];
  const plainNames: string[] = [];
  let schema = '';
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].text !== '{' || tokens[index + 1]?.text !== '[') continue;
    const end = closing(tokens, index + 1);
    const fields = new Map<string, string>();
    for (let field = index + 2; field < end - 2; field += 1) {
      if (tokens[field].kind === 'identifier' && tokens[field + 1].text === '=' && tokens[field + 2].kind === 'string') fields.set(tokens[field].text.toLowerCase(), tokens[field + 2].value);
    }
    const kind = (fields.get('kind') ?? '').toLowerCase();
    if (kind === 'schema' || kind === 'database') schema = fields.get('name') ?? schema;
    const item = fields.get('item') ?? (kind === 'table' || kind === 'view' ? fields.get('name') : undefined);
    if (item) tables.push([fields.get('schema') ?? schema, item].filter(Boolean).join('.'));
    else if (!kind && fields.has('name')) plainNames.push(fields.get('name')!);
  }
  if (!tables.length && plainNames.length) tables.push(plainNames.slice(-2).join('.'));
  return Array.from(new Set(tables));
}

function insideRecord(tokens: MToken[], index: number): boolean {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = tokens[at].text;
    if (text === ']' || text === ')' || text === '}') depth += 1;
    else if (text === '[' || text === '(' || text === '{') {
      if (depth === 0) return text === '[';
      depth -= 1;
    }
  }
  return false;
}

/** The end (exclusive) of a record field's value: the next top-level `,` or the record's `]`. */
function valueEnd(tokens: MToken[], start: number): number {
  let depth = 0;
  for (let at = start; at < tokens.length; at += 1) {
    const text = tokens[at].text;
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') {
      if (depth === 0) return at;
      depth -= 1;
    } else if (text === ',' && depth === 0) return at;
  }
  return tokens.length;
}

/** The argument ranges of the call whose `(` is at `open`. */
function callArguments(tokens: MToken[], open: number): Array<[number, number]> {
  const end = closing(tokens, open);
  return splitTopLevel(tokens, open + 1, end < 0 ? tokens.length : end, ',');
}

function splitTopLevel(tokens: MToken[], start: number, end: number, separator: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let last = start;
  for (let at = start; at < end; at += 1) {
    const text = tokens[at].text;
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === separator && depth === 0 && tokens[at].kind === 'punct') {
      ranges.push([last, at]);
      last = at + 1;
    }
  }
  if (last < end) ranges.push([last, end]);
  return ranges;
}

function closing(tokens: MToken[], open: number): number {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    const text = tokens[at].text;
    if (tokens[at].kind !== 'punct') continue;
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** The steps of the outermost `let … in`: name → token range of its value. */
function letBindings(tokens: MToken[]): Map<string, [number, number]> {
  const bindings = new Map<string, [number, number]>();
  const letAt = tokens.findIndex((token) => token.kind === 'identifier' && token.text === 'let');
  if (letAt < 0) return bindings;
  let depth = 0;
  let inAt = tokens.length;
  for (let at = letAt + 1; at < tokens.length; at += 1) {
    const text = tokens[at].text;
    if (tokens[at].kind === 'punct' && (text === '(' || text === '[' || text === '{')) depth += 1;
    else if (tokens[at].kind === 'punct' && (text === ')' || text === ']' || text === '}')) depth -= 1;
    else if (tokens[at].kind === 'identifier' && text === 'let') depth += 1;
    else if (tokens[at].kind === 'identifier' && text === 'in') {
      if (depth === 0) { inAt = at; break; }
      depth -= 1;
    }
  }
  for (const [start, end] of splitTopLevel(tokens, letAt + 1, inAt, ',')) {
    if (tokens[start + 1]?.text === '=') bindings.set(tokens[start].text, [start + 2, end]);
  }
  return bindings;
}

// ── Tokens ─────────────────────────────────────────────────────────────────

export function tokenize(source: string): MToken[] {
  const tokens: MToken[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (char === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (char === '"' || (char === '#' && source[i + 1] === '"')) {
      const open = char === '#' ? i + 1 : i;
      let j = open + 1;
      let raw = '';
      while (j < source.length) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') { raw += '"'; j += 2; continue; }
          break;
        }
        raw += source[j];
        j += 1;
      }
      // #"Step Name" is an identifier; "…" is text.
      tokens.push(char === '#'
        ? { kind: 'identifier', text: raw, value: raw, start: i }
        : { kind: 'string', text: source.slice(i, j + 1), value: decodeEscapes(raw), start: i });
      i = j + 1;
      continue;
    }
    const word = /^#?[A-Za-z_][\w.]*/.exec(source.slice(i, i + 200));
    if (word) { tokens.push({ kind: 'identifier', text: word[0], value: word[0], start: i }); i += word[0].length; continue; }
    const number = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(source.slice(i, i + 40));
    if (number) { tokens.push({ kind: 'number', text: number[0], value: number[0], start: i }); i += number[0].length; continue; }
    const punct = /^(?:=>|<>|<=|>=|\.\.\.|\.\.|[^\s])/.exec(source.slice(i, i + 3))![0];
    tokens.push({ kind: 'punct', text: punct, value: punct, start: i });
    i += punct.length;
  }
  return tokens;
}

/** M text escapes: #(lf), #(cr,lf), #(tab), #(#), #(000D). */
function decodeEscapes(text: string): string {
  return text.replace(/#\(([^)]*)\)/g, (whole, inner: string) => inner.split(',').map((code) => {
    const name = code.trim().toLowerCase();
    if (name === 'lf') return '\n';
    if (name === 'cr') return '\r';
    if (name === 'tab') return '\t';
    if (name === '#') return '#';
    if (/^[0-9a-f]{4}$|^[0-9a-f]{8}$/i.test(name)) return String.fromCodePoint(Number.parseInt(name, 16));
    return whole;
  }).join('')).replace(/\r\n?/g, '\n');
}

// ── Parameters ─────────────────────────────────────────────────────────────

/** `"2024-01-01" meta [IsParameterQuery=true, Type="Date"]` → a parameter with its value; null when the expression is not one. */
export function readPowerQueryParameter(name: string, expression: string): PowerQueryParameter | null {
  if (!/meta\s*\[[^\]]*IsParameterQuery\s*=\s*true/i.test(expression)) return null;
  const value = expression.slice(0, expression.search(/\bmeta\s*\[/i)).trim();
  const declaredType = /Type\s*=\s*"([^"]+)"/i.exec(expression)?.[1]?.toLowerCase() ?? '';
  const tokens = tokenize(value);
  let parsed: string | number | boolean | undefined;
  if (tokens.length === 1 && tokens[0].kind === 'string') parsed = tokens[0].value;
  else if (tokens.length === 1 && tokens[0].kind === 'number') parsed = Number(tokens[0].text);
  else if (tokens.length === 1 && /^(?:true|false)$/i.test(tokens[0].text)) parsed = tokens[0].text.toLowerCase() === 'true';
  else if (tokens[0]?.kind === 'identifier' && /^#(?:date|datetime|datetimezone)$/i.test(tokens[0].text)) {
    const parts = tokens.filter((token) => token.kind === 'number').map((token) => Number(token.text));
    if (parts.length >= 3) {
      const pad = (number: number) => String(number).padStart(2, '0');
      const date = `${parts[0]}-${pad(parts[1])}-${pad(parts[2])}`;
      parsed = parts.slice(3).some((part) => part !== 0) ? `${date} ${pad(parts[3] ?? 0)}:${pad(parts[4] ?? 0)}:${pad(parts[5] ?? 0)}` : date;
    }
  }
  const valueType: ImportedParameterType = /date|time/.test(declaredType) ? 'date'
    : /number|decimal|int|currency|percentage/.test(declaredType) ? 'number'
      : /logical|bool/.test(declaredType) ? 'boolean'
        : typeof parsed === 'number' ? 'number' : typeof parsed === 'boolean' ? 'boolean' : 'string';
  return { name: variableName(name), valueType, ...(parsed !== undefined ? { default: parsed } : {}) };
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
