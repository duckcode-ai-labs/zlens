import type { CellChartConfig } from '../store/types';

export type VisualBlockParameterType = 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]';

export interface VisualBlockParameter {
  name: string;
  type: VisualBlockParameterType;
  required: boolean;
  default?: unknown;
  policy: 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
  binding?: { kind: 'sql_value' | 'semantic_filter' | 'limit'; field?: string; operator?: 'equals' | 'in' | 'gte' | 'lte' };
}

export interface BlockFields {
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  blockType: string;
  name: string;
  status: string;
  llmContext?: string;
}

interface ParsedBlockDocument extends BlockFields {
  metric: string;
  metrics: string[];
  dimensions: string[];
  requestedFilters: string[];
  sourceDqlKind: string;
  sourceDqlName: string;
  sourceDqlPath: string;
  sourceDqlHash: string;
  sourceDqlMetrics: string[];
  sourceDqlDimensions: string[];
  timeDimension: string;
  granularity: string;
  query: string;
  visualization: string;
  tests: string;
}

interface SemanticSelection {
  kind: 'metric' | 'dimension';
  name: string;
}

export interface SemanticVisualFields {
  metrics: string[];
  dimensions: string[];
  requestedFilters: string[];
  timeDimension: string;
  granularity: string;
}

/**
 * Lightweight editor guard for metadata synchronization. This is not the DQL
 * validator; it only prevents an incomplete typing buffer (for example a
 * temporarily missing closing brace) from erasing the last valid identity
 * fields before the server validator can respond.
 */
export function hasCompleteBlockEnvelope(source: string): boolean {
  // The formatter's `// dql-format: 1` header (and any leading comment) comes before the block.
  const content = source.slice(leadingCommentLength(source));
  if (!/^\s*block\s+"[^"]+"\s*\{/i.test(content)) return false;
  let depth = 0;
  let sawOpeningBrace = false;
  let inString = false;
  let inTripleString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    if (content.slice(index, index + 3) === '"""' && !escaped) {
      inTripleString = !inTripleString;
      index += 2;
      inString = false;
      continue;
    }
    if (inTripleString) continue;
    const character = content[index];
    if (character === '"' && !escaped) inString = !inString;
    if (!inString) {
      if (character === '{') {
        depth += 1;
        sawOpeningBrace = true;
      } else if (character === '}') {
        depth -= 1;
        if (depth < 0) return false;
      }
    }
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }

  return sawOpeningBrace && depth === 0 && !inString && !inTripleString;
}

export function parseSemanticVisualFields(content: string): SemanticVisualFields {
  const scalar = (key: string) => content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const array = (key: string) => {
    const match = content.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'));
    return (match?.[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)).filter(Boolean);
  };
  const metrics = array('metrics');
  const metric = scalar('metric');
  return {
    metrics: metrics.length > 0 ? metrics : metric ? [metric] : [],
    dimensions: array('dimensions'),
    requestedFilters: array('requested_filters'),
    timeDimension: scalar('time_dimension'),
    granularity: scalar('granularity'),
  };
}

export function setSemanticMetrics(content: string, metrics: string[]): string {
  let next = content.replace(/\n\s*metrics\s*=\s*\[[\s\S]*?\]/i, '').replace(/\n\s*metric\s*=\s*"[^"]*"/i, '');
  const unique = Array.from(new Set(metrics.filter(Boolean)));
  return insertVisualField(
    next,
    `  metrics = [${unique.map((metricName) => `"${escapeDqlValue(metricName)}"`).join(', ')}]`,
  );
}

export function setSemanticArray(content: string, key: string, values: string[]): string {
  const unique = Array.from(new Set(values.filter(Boolean)));
  const rendered = `${key} = [${unique.map((value) => `"${escapeDqlValue(value)}"`).join(', ')}]`;
  const field = new RegExp(`\\b${key}\\s*=\\s*\\[[\\s\\S]*?\\]`, 'i');
  return field.test(content) ? content.replace(field, rendered) : insertVisualField(content, `  ${rendered}`);
}

/**
 * Browser-safe read of DQL's params section. The server-side DQL parser remains
 * authoritative for validation and execution; this only keeps the visual form
 * synchronized while the author types.
 */
export function parseVisualBlockParameters(content: string): VisualBlockParameter[] {
  const policies = parseSectionAssignments(content, 'parameterPolicy');
  const filters = parseSectionAssignments(content, 'filterBindings');
  const placeholders = new Set(Array.from(content.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g)).map((match) => match[1]));
  const semantic = /\btype\s*=\s*"semantic"/i.test(content);
  const params = readDqlSection(content, 'params');

  return params.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) return [];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(string|number|boolean|date)(\[\])?)?\s*(?:=\s*(.+))?$/.exec(line);
    if (!match) return [];
    const name = match[1];
    const parsedDefault = match[4] === undefined ? undefined : parseVisualDefault(match[4]);
    const type = (match[2] ? `${match[2]}${match[3] ?? ''}` : inferVisualParameterType(visualDefaultValueText(parsedDefault), name)) as VisualBlockParameterType;
    const filterField = filters.get(name);
    const binding = placeholders.has(name)
      ? { kind: 'sql_value' as const }
      : name === 'top_n' || name === 'limit'
        ? { kind: 'limit' as const }
        : semantic && filterField
          ? { kind: 'semantic_filter' as const, field: filterField, operator: name.endsWith('_set') ? 'in' as const : 'equals' as const }
          : undefined;
    return [{
      name,
      type,
      required: match[4] === undefined,
      ...(match[4] === undefined ? {} : { default: parsedDefault }),
      policy: normalizeVisualPolicy(policies.get(name)),
      ...(binding ? { binding } : {}),
    }];
  });
}

/**
 * Turns a value the author typed into a useful default type. The author can
 * always choose a different type in the visual editor.
 */
export function inferVisualParameterType(value: string, name = ''): VisualBlockParameterType {
  const trimmed = value.trim();
  const nameHint = name.toLowerCase();
  if (trimmed.includes(',')) {
    const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length > 0 && items.every((item) => isDateValue(item))) return 'date[]';
    if (items.length > 0 && items.every((item) => isNumberValue(item))) return 'number[]';
    return 'string[]';
  }
  if (trimmed === 'true' || trimmed === 'false') return 'boolean';
  if (isDateValue(trimmed)) return 'date';
  if (isNumberValue(trimmed)) return 'number';
  if (/\b(date|from|start|end|until)\b|(?:^|_)(date|at)(?:_|$)/.test(nameHint)) return 'date';
  if (/(?:^|_)(top_n|limit|count|rank|number)(?:_|$)|_n$/.test(nameHint)) return 'number';
  if (/(?:_set|_list|_ids|_values)$/.test(nameHint)) return 'string[]';
  return 'string';
}

export function visualParameterDefaultText(parameter: Pick<VisualBlockParameter, 'default'>): string {
  if (parameter.default === undefined) return '';
  return visualDefaultValueText(parameter.default);
}

/**
 * Parameter sections belong to a DQL block. Keep a blank notebook cell blank
 * until the author explicitly adds a parameter, then create the smallest
 * useful draft block and preserve any query text they already entered.
 */
export function ensureNotebookDqlBlockSource(content: string): string {
  if (/^\s*block\s+"/i.test(content)) return content;
  const query = content.trim();
  const queryBody = query
    ? query.split(/\r?\n/).map((line) => `    ${line}`).join('\n')
    : '    -- Write query';
  return `block "notebook_query" {
  status = "draft"
  domain = "uncategorized"
  type = "custom"
  description = "Notebook analysis"

  query = """
${queryBody}
  """
}
`;
}

/** Write a canonical typed declaration and matching policy back into DQL source. */
export function upsertVisualBlockParameter(
  content: string,
  update: {
    name: string;
    previousName?: string;
    type: VisualBlockParameterType;
    required: boolean;
    defaultText?: string;
    policy: VisualBlockParameter['policy'];
  },
): string {
  const safeName = normalizeParameterName(update.name);
  if (!safeName) return content;
  const parameters = parseVisualBlockParameters(content)
    .filter((parameter) => parameter.name !== update.previousName && parameter.name !== safeName)
    .map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      defaultText: visualParameterDefaultText(parameter),
      policy: parameter.policy,
    }));
  parameters.push({
    name: safeName,
    type: update.type,
    required: update.required,
    defaultText: update.defaultText ?? '',
    policy: update.policy,
  });
  return writeVisualParameters(content, parameters);
}

export function removeVisualBlockParameter(content: string, name: string): string {
  const parameters = parseVisualBlockParameters(content)
    .filter((parameter) => parameter.name !== name)
    .map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      defaultText: visualParameterDefaultText(parameter),
      policy: parameter.policy,
    }));
  return writeVisualParameters(content, parameters);
}

/**
 * Bind one visual parameter to a semantic dimension without disturbing other
 * parameter or filter bindings. Ask uses this after the user explicitly adds a
 * result-column filter to a transient semantic artifact.
 */
export function setVisualBlockParameterBinding(content: string, name: string, field: string): string {
  const safeName = normalizeParameterName(name);
  const safeField = field.trim();
  if (!safeName || !safeField) return content;
  const body = readDqlSection(content, 'filterBindings');
  const retained = body
    .split(/\r?\n/)
    .filter((line) => line.trim() && !new RegExp(`^${safeName}\\s*=`).test(line.trim()));
  retained.push(`${safeName} = "${escapeDqlValue(safeField)}"`);
  return setDqlSectionBody(content, 'filterBindings', retained.join('\n'));
}

function writeVisualParameters(
  content: string,
  parameters: Array<{
    name: string;
    type: VisualBlockParameterType;
    required: boolean;
    defaultText: string;
    policy: VisualBlockParameter['policy'];
  }>,
): string {
  const paramsBody = parameters.map((parameter) => {
    const declaration = `${parameter.name}: ${parameter.type}`;
    return parameter.required ? declaration : `${declaration} = ${serializeVisualDefault(parameter.defaultText, parameter.type)}`;
  }).join('\n');
  const policyBody = parameters.map((parameter) => `${parameter.name} = "${parameter.policy}"`).join('\n');
  let next = setDqlSectionBody(content, 'params', paramsBody);
  next = setDqlSectionBody(next, 'parameterPolicy', policyBody);
  return next;
}

function serializeVisualDefault(value: string, type: VisualBlockParameterType): string {
  const trimmed = value.trim();
  if (type === 'boolean') return trimmed === 'true' ? 'true' : 'false';
  if (type === 'number') return isNumberValue(trimmed) ? String(Number(trimmed)) : '0';
  if (type.endsWith('[]')) {
    const itemType = type.slice(0, -2) as Exclude<VisualBlockParameterType, `${string}[]`>;
    const values = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    return `[${values.map((item) => serializeVisualDefault(item, itemType)).join(', ')}]`;
  }
  return `"${escapeDqlValue(trimmed)}"`;
}

function normalizeParameterName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : '';
}

function isNumberValue(value: string): boolean {
  return value !== '' && Number.isFinite(Number(value));
}

function isDateValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readDqlSection(content: string, sectionName: string): string {
  const start = new RegExp(`\\b${sectionName}\\s*\\{`, 'i').exec(content);
  if (!start || start.index === undefined) return '';
  const opening = content.indexOf('{', start.index);
  let depth = 0;
  for (let index = opening; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(opening + 1, index).trim();
    }
  }
  return '';
}

function parseSectionAssignments(content: string, sectionName: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readDqlSection(content, sectionName).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match) entries.set(match[1], match[2]);
  }
  return entries;
}

function parseVisualDefault(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (isNumberValue(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitDqlArray(value.slice(1, -1)).map(parseVisualDefault);
  }
  return value;
}

function splitDqlArray(value: string): string[] {
  const values: string[] = [];
  let quote = false;
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== '\\') quote = !quote;
    if (char === ',' && !quote) {
      if (current.trim()) values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function visualDefaultValueText(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function normalizeVisualPolicy(value: string | undefined): VisualBlockParameter['policy'] {
  return value === 'static' || value === 'business' || value === 'derived' || value === 'optional' || value === 'ambiguous_review_required'
    ? value
    : 'dynamic';
}

/**
 * A semantic filter is a typed runtime value, not a saved literal predicate.
 * Keep the legacy requested_filters metadata for older readers, while emitting
 * the params + filterBindings contract consumed by the unified invocation path.
 */
export function setSemanticRuntimeFilters(content: string, filters: string[]): string {
  const managedNames = new Set(parseSemanticVisualFields(content).requestedFilters);
  const unique = Array.from(new Set(filters.filter(Boolean)));
  let next = setSemanticArray(content, 'requested_filters', unique);
  next = updateNamedSectionEntries(next, 'params', managedNames, unique, (name) => `${name}: string`);
  next = updateNamedSectionEntries(next, 'parameterPolicy', managedNames, unique, (name) => `${name} = "dynamic"`);
  next = updateNamedSectionEntries(next, 'filterBindings', managedNames, unique, (name) => `${name} = "${escapeDqlValue(name)}"`);
  return next;
}

function updateNamedSectionEntries(
  content: string,
  section: string,
  managedNames: Set<string>,
  activeNames: string[],
  render: (name: string) => string,
): string {
  const body = getDqlSectionBody(content, section);
  const retained = body
    .split(/\r?\n/)
    .filter((line) => {
      const name = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|=)/)?.[1];
      return !name || !managedNames.has(name);
    });
  const nextBody = [...retained.filter((line) => line.trim()), ...activeNames.map(render)].join('\n');
  return setDqlSectionBody(content, section, nextBody);
}

export function setSemanticScalar(content: string, key: string, value: string): string {
  const escaped = escapeDqlValue(value);
  const field = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  return field.test(content) ? content.replace(field, `$1"${escaped}"`) : insertVisualField(content, `  ${key} = "${escaped}"`);
}

/**
 * Remove semantic members that are no longer approved by the current
 * multi-metric compatibility answer. This keeps source mode, visual mode, and
 * runtime filter bindings on the same fail-closed selection contract.
 */
export function reconcileSemanticCompatibility(content: string, compatibleNames: string[]): string {
  const allowed = new Set(compatibleNames.filter(Boolean));
  const current = parseSemanticVisualFields(content);
  let next = setSemanticArray(
    content,
    'dimensions',
    current.dimensions.filter((dimension) => allowed.has(dimension)),
  );
  next = setSemanticRuntimeFilters(
    next,
    current.requestedFilters.filter((dimension) => allowed.has(dimension)),
  );
  if (current.timeDimension && !allowed.has(current.timeDimension)) {
    next = setSemanticScalar(next, 'time_dimension', '');
    next = setSemanticScalar(next, 'granularity', '');
  }
  return next;
}

function escapeDqlValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function insertVisualField(content: string, field: string): string {
  if (/visualization\s*\{/i.test(content)) {
    return content.replace(/\n\s*visualization\s*\{/i, `\n${field}\n\n  visualization {`);
  }
  return content.replace(/\n\}\s*$/, `\n${field}\n}\n`);
}

export function parseDqlChartConfig(content: string): CellChartConfig | undefined {
  const vizMatch = content.match(/visualization\s*\{([^}]+)\}/is);
  if (!vizMatch) return undefined;
  const body = vizMatch[1];
  const get = (key: string) =>
    body.match(new RegExp(`\\b${key}\\s*=\\s*["']?([\\w-]+)["']?`, 'i'))?.[1];
  const chart = get('chart');
  if (!chart) return undefined;
  return {
    chart,
    x: get('x'),
    y: get('y'),
    color: get('color'),
    title: body.match(/\btitle\s*=\s*"([^"]+)"/i)?.[1],
  };
}

export function extractSqlFromText(dqlContent: string): string | null {
  const trimmed = dqlContent.trim();
  if (!trimmed) return null;

  const tripleQuoteMatch = trimmed.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;

  const bareTripleMatch = trimmed.match(/"""([\s\S]*?)"""/);
  if (bareTripleMatch) return bareTripleMatch[1].trim() || null;

  if (/^\s*(dashboard|workbook)\s+"/i.test(trimmed)) return null;

  const sqlKeywordMatch = trimmed.match(
    /\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b([\s\S]*)/i,
  );
  if (sqlKeywordMatch) {
    let raw = sqlKeywordMatch[0];
    const dqlSectionStart = raw.search(/\b(visualization|tests|block)\s*\{/i);
    if (dqlSectionStart > 0) raw = raw.slice(0, dqlSectionStart);
    raw = trimAtNamedArgBoundary(raw);
    return raw.trim() || null;
  }

  return null;
}

function trimAtNamedArgBoundary(sql: string): string {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== ch) {
        if (sql[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === ',' && depth === 0) {
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (j < sql.length && /[a-zA-Z_]/.test(sql[j])) {
        while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
        let k = j;
        while (k < sql.length && /\s/.test(sql[k])) k++;
        if (k < sql.length && sql[k] === '=' && sql[k + 1] !== '=') {
          return sql.slice(0, i);
        }
      }
    }
  }
  return sql;
}

export function parseBlockFields(content: string): BlockFields | null {
  const parsed = parseBlockDocument(content);
  if (!parsed) return null;
  return {
    name: parsed.name,
    domain: parsed.domain,
    owner: parsed.owner,
    description: parsed.description,
    blockType: parsed.blockType,
    status: parsed.status,
    tags: parsed.tags,
    llmContext: parsed.llmContext,
  };
}

export function setBlockStringField(content: string, key: string, value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  if (re.test(content)) return content.replace(re, `$1"${escaped}"`);
  return insertBlockField(content, `  ${key} = "${escaped}"`);
}

export function setBlockName(content: string, value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  const header = content.slice(0, leadingCommentLength(content));
  const body = content.slice(header.length);
  return /^\s*block\s+"/i.test(body)
    ? `${header}${body.replace(/^(\s*block\s+)"[^"]*"/i, `$1"${escaped}"`)}`
    : content;
}

/**
 * The length of the comment lines and blank lines a block file opens with,
 * such as the formatter's `// dql-format: 1` header. Every editor helper reads
 * the block after them, so a saved file and a new draft edit the same way.
 */
export function leadingCommentLength(content: string): number {
  return /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*/.exec(content)?.[0].length ?? 0;
}

/** The file declares a block, after any leading comment lines. */
export function startsWithBlockDeclaration(content: string): boolean {
  return /^\s*block\s+"/i.test(content.slice(leadingCommentLength(content)));
}

export function setBlockTags(content: string, tags: string[]): string {
  const tagStr = tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(', ');
  const re = /(\btags\s*=\s*)\[[^\]]*\]/i;
  if (re.test(content)) return content.replace(re, `$1[${tagStr}]`);
  return insertBlockField(content, `  tags = [${tagStr}]`);
}

/**
 * Update a top-level block array without touching unknown clauses. This is used
 * by the Block Studio context inspector for the business references that make a
 * block discoverable to people and to the governed agent.
 */
export function setBlockArray(content: string, key: string, values: string[]): string {
  const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const list = `[${unique.map((value) => `"${escapeDqlValue(value)}"`).join(', ')}]`;
  // A list, or a single string an earlier version wrote (`caveats = "…"`).
  const field = new RegExp(`(\\b${key}\\s*=\\s*)(?:\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*")`, 'i');
  if (field.test(content)) return content.replace(field, (_whole, prefix: string) => `${prefix}${list}`);
  return insertBlockField(content, `  ${key} = ${list}`);
}

export function upsertVisualizationConfig(content: string, chartConfig: CellChartConfig): string {
  const section = /visualization\s*\{[\s\S]*?\n\s*\}/i;
  if (!section.test(content)) {
    const visualization = buildVisualizationSection(chartConfig);
    return insertBlockField(content, `  ${visualization.replace(/\n/g, '\n  ')}`, true);
  }
  return content.replace(section, (current) => {
    let next = current;
    for (const [key, value] of Object.entries(chartConfig)) {
      if (value == null || value === '') continue;
      const escaped = String(value).replace(/"/g, '\\"');
      const field = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
      if (field.test(next)) next = next.replace(field, `$1"${escaped}"`);
      else next = next.replace(/\n(\s*)\}$/, `\n$1  ${key} = "${escaped}"\n$1}`);
    }
    return next;
  });
}

export function getDqlSectionBody(content: string, sectionName: string): string {
  const section = content.match(new RegExp(`\\b${sectionName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'i'));
  return section?.[1]
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s{4}/, ''))
    .join('\n')
    .trim() ?? '';
}

export function setDqlSectionBody(content: string, sectionName: string, body: string): string {
  const cleanBody = body.trim();
  const rendered = cleanBody
    ? `  ${sectionName} {\n${cleanBody.split(/\r?\n/).map((line) => `    ${line.trimEnd()}`).join('\n')}\n  }`
    : '';
  const section = new RegExp(`\\n\\s*${sectionName}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'i');
  if (section.test(content)) {
    return content.replace(section, rendered ? `\n${rendered}` : '');
  }
  if (!rendered) return content;
  if (/\n\s*visualization\s*\{/i.test(content)) {
    return content.replace(/\n\s*visualization\s*\{/i, `\n${rendered}\n\n  visualization {`);
  }
  return insertBlockField(content, rendered, true);
}

export function buildSemanticRef(kind: 'metric' | 'dimension', name: string): string {
  return kind === 'metric' ? `@metric(${name})` : `@dim(${name})`;
}

export function upsertSemanticSelection(content: string, selection: SemanticSelection): string {
  const parsed = parseBlockDocument(content);
  if (!parsed || parsed.blockType !== 'semantic') return content;

  if (selection.kind === 'metric') {
    const allMetrics = new Set<string>();
    if (parsed.metric) allMetrics.add(parsed.metric);
    for (const metric of parsed.metrics) allMetrics.add(metric);
    allMetrics.add(selection.name);
    return setSemanticMetrics(content, Array.from(allMetrics));
  }

  return setSemanticArray(
    content,
    'dimensions',
    parsed.dimensions.includes(selection.name)
      ? parsed.dimensions
      : [...parsed.dimensions, selection.name],
  );
}

export function appendSemanticRefToQuery(content: string, reference: string): string {
  const parsed = parseBlockDocument(content);
  if (!parsed || parsed.blockType !== 'custom') {
    return `${content.trimEnd()}\n${reference}\n`;
  }
  const query = parsed.query.trimEnd();
  const nextQuery = query ? `${query}\n${reference}` : reference;
  return setBlockQuery(content, nextQuery);
}

/**
 * Set the raw SQL body of a custom (raw-SQL) block without normalizing the
 * document. A targeted edit is important here: visual query edits must preserve
 * params, parameterPolicy, filterBindings, tests, and future/unknown clauses.
 */
export function setBlockQuery(content: string, sql: string): string {
  const rendered = `  query = """\n${sql.trimEnd()}\n  """`;
  const queryField = /\n\s*query\s*=\s*"""[\s\S]*?"""/i;
  const parsed = parseBlockDocument(content);
  if (!parsed) {
    // Never drop typed SQL silently: a draft the helpers cannot read as a
    // block (mid-edit in DQL Source) still gets its query replaced in place.
    return queryField.test(content) ? content.replace(queryField, `\n${rendered}`) : content;
  }
  const next = setBlockStringField(content, 'type', 'custom');
  return queryField.test(next)
    ? next.replace(queryField, `\n${rendered}`)
    : insertBlockField(next, rendered, true);
}

export function extractSemanticReferences(content: string): {
  metrics: string[];
  dimensions: string[];
  segments: string[];
} {
  const metrics = new Set<string>();
  const dimensions = new Set<string>();
  const segments = new Set<string>();
  const semanticRegex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = semanticRegex.exec(content))) {
    const name = match[2].trim();
    if (!name) continue;
    if (match[1].toLowerCase() === 'metric') metrics.add(name);
    else dimensions.add(name);
  }
  const segmentRegex = /\/\*\s*segment:([^*]+)\*\//gi;
  while ((match = segmentRegex.exec(content))) {
    const name = match[1].trim();
    if (name) segments.add(name);
  }
  return {
    metrics: Array.from(metrics),
    dimensions: Array.from(dimensions),
    segments: Array.from(segments),
  };
}

function parseBlockDocument(content: string): ParsedBlockDocument | null {
  const body = content.slice(leadingCommentLength(content));
  if (!/^\s*block\s+"/i.test(body.trim())) return null;
  const str = (key: string) =>
    content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const name = body.match(/^\s*block\s+"([^"]+)"/i)?.[1] ?? '';
  const tagsMatch = content.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  const queryMatch = content.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  return {
    name,
    domain: str('domain'),
    owner: str('owner'),
    description: str('description'),
    llmContext: str('llmContext'),
    status: str('status') || 'draft',
    blockType: (str('type') || 'custom').toLowerCase() === 'semantic' ? 'semantic' : 'custom',
    tags: tagsMatch ? (tagsMatch[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)) : [],
    metric: str('metric'),
    metrics: parseArrayField(content, 'metrics'),
    dimensions: parseArrayField(content, 'dimensions'),
    requestedFilters: parseArrayField(content, 'requested_filters'),
    sourceDqlKind: str('source_dql_kind'),
    sourceDqlName: str('source_dql_name'),
    sourceDqlPath: str('source_dql_path'),
    sourceDqlHash: str('source_dql_hash'),
    sourceDqlMetrics: parseArrayField(content, 'source_dql_metrics'),
    sourceDqlDimensions: parseArrayField(content, 'source_dql_dimensions'),
    timeDimension: str('time_dimension'),
    granularity: str('granularity'),
    query: queryMatch?.[1]?.trim() ?? '',
    visualization: extractNamedBlock(content, 'visualization'),
    tests: extractNamedBlock(content, 'tests'),
  };
}

function parseArrayField(content: string, key: string): string[] {
  const match = content.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'));
  if (!match) return [];
  return (match[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)).filter(Boolean);
}

function extractNamedBlock(content: string, key: string): string {
  const startMatch = new RegExp(`\\b${key}\\s*\\{`, 'i').exec(content);
  if (!startMatch || startMatch.index == null) return '';
  let depth = 0;
  let start = -1;
  for (let i = startMatch.index; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return content.slice(startMatch.index, i + 1).trim();
      }
    }
  }
  return '';
}

function normalizeBlockDocument(doc: ParsedBlockDocument): string {
  const lines = [
    `block "${escapeDqlString(doc.name || 'New Block')}" {`,
    `  status = "${escapeDqlString(doc.status || 'draft')}"`,
    `  domain = "${escapeDqlString(doc.domain || 'uncategorized')}"`,
    `  type = "${doc.blockType}"`,
    `  description = "${escapeDqlString(doc.description)}"`,
    `  owner = "${escapeDqlString(doc.owner)}"`,
    `  tags = [${doc.tags.map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`,
  ];
  if (doc.llmContext) {
    lines.push(`  llmContext = "${escapeDqlString(doc.llmContext)}"`);
  }
  appendSourceDqlMetadata(lines, doc);

  if (doc.blockType === 'semantic') {
    const semanticMetrics = doc.metrics.length > 0
      ? Array.from(new Set(doc.metrics))
      : doc.metric
        ? [doc.metric]
        : [];
    lines.push(`  metrics = [${semanticMetrics.map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`);
    lines.push(`  dimensions = [${Array.from(new Set(doc.dimensions)).map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`);
    if (doc.timeDimension) {
      lines.push(`  time_dimension = "${escapeDqlString(doc.timeDimension)}"`);
    }
    if (doc.granularity) {
      lines.push(`  granularity = "${escapeDqlString(doc.granularity)}"`);
    }
    if (doc.requestedFilters.length > 0) {
      lines.push(`  requested_filters = [${Array.from(new Set(doc.requestedFilters)).map((filter) => `"${escapeDqlString(filter)}"`).join(', ')}]`);
    }
  }

  if (doc.blockType === 'custom') {
    lines.push('');
    lines.push('  query = """');
    lines.push(...indentBlock(doc.query.trim(), 4));
    lines.push('  """');
  }

  if (doc.visualization) {
    lines.push('');
    lines.push(...indentExistingBlock(doc.visualization, 2));
  }

  if (doc.tests) {
    lines.push('');
    lines.push(...indentExistingBlock(doc.tests, 2));
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

function appendSourceDqlMetadata(lines: string[], doc: ParsedBlockDocument): void {
  if (doc.sourceDqlKind) {
    lines.push(`  source_dql_kind = "${escapeDqlString(doc.sourceDqlKind)}"`);
  }
  if (doc.sourceDqlName) {
    lines.push(`  source_dql_name = "${escapeDqlString(doc.sourceDqlName)}"`);
  }
  if (doc.sourceDqlPath) {
    lines.push(`  source_dql_path = "${escapeDqlString(doc.sourceDqlPath)}"`);
  }
  if (doc.sourceDqlHash) {
    lines.push(`  source_dql_hash = "${escapeDqlString(doc.sourceDqlHash)}"`);
  }
  if (doc.sourceDqlMetrics.length > 0) {
    lines.push(`  source_dql_metrics = [${Array.from(new Set(doc.sourceDqlMetrics)).map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`);
  }
  if (doc.sourceDqlDimensions.length > 0) {
    lines.push(`  source_dql_dimensions = [${Array.from(new Set(doc.sourceDqlDimensions)).map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`);
  }
}

function buildVisualizationSection(chartConfig: CellChartConfig): string {
  const lines: string[] = [];
  lines.push('visualization {');
  lines.push(`  chart = "${chartConfig.chart ?? 'table'}"`);
  if (chartConfig.x) lines.push(`  x = ${chartConfig.x}`);
  if (chartConfig.y) lines.push(`  y = ${chartConfig.y}`);
  if (chartConfig.color) lines.push(`  color = ${chartConfig.color}`);
  if (chartConfig.title) lines.push(`  title = "${escapeDqlString(chartConfig.title)}"`);
  lines.push('}');
  return lines.join('\n');
}

function indentBlock(value: string, spaces: number): string[] {
  const indent = ' '.repeat(spaces);
  const lines = value ? value.split('\n') : [''];
  return lines.map((line) => `${indent}${line}`);
}

function indentExistingBlock(value: string, spaces: number): string[] {
  const indent = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${indent}${line.trimEnd()}`);
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Add a clause the block does not have yet. A `key = value` field joins the
 * block's other top-level fields, before its first section (params, query,
 * visualization, tests …), so it never lands after `tests { }`; a section
 * (`beforeClosingBrace`) goes last, before the block's closing brace. The file
 * may open with comments, such as the formatter's `// dql-format: 1` header.
 */
function insertBlockField(content: string, field: string, beforeClosingBrace: boolean = false): string {
  const trimmed = content.trimEnd();
  const lines = trimmed.split('\n');
  const openIndex = lines.findIndex((line) => /^\s*block\s+"[^"]*"\s*\{/i.test(line));
  // The block's own closing brace, found by depth (strings and comments
  // skipped), not "the last line": a comment or a second declaration after
  // the block must never receive the field (B10).
  const closeAt = openIndex < 0 ? -1 : blockClosingBraceOffset(trimmed, lines.slice(0, openIndex).reduce((total, line) => total + line.length + 1, 0));
  if (openIndex < 0 || closeAt < 0) {
    return `${trimmed}\n${field}\n`;
  }
  if (beforeClosingBrace) {
    const before = trimmed.slice(0, closeAt).replace(/[ \t]*$/, '');
    return `${before.endsWith('\n') ? before : `${before}\n`}\n${field}\n${trimmed.slice(closeAt)}`;
  }
  const after = blockFieldInsertionLine(lines, openIndex);
  return [...lines.slice(0, after + 1), field, ...lines.slice(after + 1)].join('\n');
}

/** The offset of the `}` that closes the block opened at or after `from`, or -1. */
function blockClosingBraceOffset(content: string, from: number): number {
  let depth = 0;
  let opened = false;
  for (let at = from; at < content.length; at++) {
    if (content.startsWith('"""', at)) {
      const end = content.indexOf('"""', at + 3);
      if (end < 0) return -1;
      at = end + 2;
      continue;
    }
    const ch = content[at];
    if (ch === '/' && content[at + 1] === '/') {
      const newline = content.indexOf('\n', at);
      if (newline < 0) return -1;
      at = newline;
      continue;
    }
    if (ch === '"') {
      at++;
      while (at < content.length && content[at] !== '"' && content[at] !== '\n') at += content[at] === '\\' ? 2 : 1;
      continue;
    }
    if (ch === '{') {
      depth++;
      opened = true;
    } else if (ch === '}') {
      depth--;
      if (opened && depth === 0) return at;
    }
  }
  return -1;
}

/**
 * The line after which a new top-level field goes: the last single-line
 * `key = value` field before the block's first section or multi-line value
 * (the opening line when there is none). `query` counts as a section.
 */
function blockFieldInsertionLine(lines: string[], openIndex: number): number {
  let depth = 1;
  let inTripleQuote = false;
  let insertAfter = openIndex;
  for (let index = openIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('//')) continue;
    const field = /^\s*([A-Za-z_]\w*)\s*=/.exec(line);
    for (let at = 0; at < line.length; at++) {
      if (inTripleQuote) {
        if (line.startsWith('"""', at)) { inTripleQuote = false; at += 2; }
        continue;
      }
      if (line.startsWith('"""', at)) { inTripleQuote = true; at += 2; continue; }
      const ch = line[at];
      if (ch === '/' && line[at + 1] === '/') break;
      if (ch === '"') {
        at++;
        while (at < line.length && line[at] !== '"') at += line[at] === '\\' ? 2 : 1;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
    }
    if (!field || field[1].toLowerCase() === 'query' || depth !== 1 || inTripleQuote) break;
    insertAfter = index;
  }
  return insertAfter;
}
