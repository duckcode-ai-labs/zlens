import { humanizeObjectName } from '../sql-import-script.js';
import { readPowerQuery, readPowerQueryParameter, type PowerQueryParameter } from './power-query.js';
import { listNames, sqlSourceContent, type ExtractedBiFile } from './types.js';
import { decodeModelText, readZipFile } from './zip.js';

/**
 * Native SQL from a Power BI model: a template (.pbit, whose DataModelSchema
 * is the model as JSON), a project's model.bim, or a project's TMDL folder
 * (`<name>.SemanticModel/definition`). Each table's Power Query is read for
 * native SQL; tables that load without SQL, calculated tables and DAX
 * measures are listed as left out.
 */

interface PowerBiModel {
  tables: Array<{
    name: string;
    partitions: Array<{ name: string; mode?: string; type: string; expression: string }>;
    measures: Array<{ name: string; expression: string }>;
  }>;
  expressions: Array<{ name: string; expression: string }>;
}

export function extractPowerBiTemplate(zip: Buffer, displayPath: string): ExtractedBiFile {
  const schema = readZipFile(zip, (name) => name === 'DataModelSchema');
  if (!schema) throw new Error(`${displayPath} has no DataModelSchema; save it again as a Power BI template (.pbit).`);
  return extractPowerBiModelJson(decodeModelText(schema.data), displayPath);
}

/** A .pbix keeps its model compressed in a format ZLens does not read: say how to get a template instead. */
export function powerBiReportWithoutModel(displayPath: string): ExtractedBiFile {
  return {
    sources: [],
    skipped: [{
      sourcePath: displayPath,
      kind: 'unreadable',
      reason: 'A .pbix stores its model compressed, so ZLens cannot read its queries. In Power BI Desktop choose File → Export → Power BI template and import the .pbit, or save the report as a Power BI project (PBIP).',
      sql: displayPath.split('/').pop() ?? displayPath,
    }],
  };
}

export function extractPowerBiModelJson(text: string, displayPath: string): ExtractedBiFile {
  const json = JSON.parse(text) as { model?: { tables?: any[]; expressions?: any[] } };
  const joined = (value: unknown) => (Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '');
  const model: PowerBiModel = {
    tables: (json.model?.tables ?? []).map((table: any) => ({
      name: String(table.name ?? ''),
      partitions: (table.partitions ?? []).map((partition: any) => ({
        name: String(partition.name ?? table.name ?? ''),
        mode: partition.mode,
        type: String(partition.source?.type ?? 'm'),
        expression: joined(partition.source?.expression),
      })),
      measures: (table.measures ?? []).map((measure: any) => ({ name: String(measure.name ?? ''), expression: joined(measure.expression) })),
    })),
    expressions: (json.model?.expressions ?? []).map((expression: any) => ({ name: String(expression.name ?? ''), expression: joined(expression.expression) })),
  };
  return extractFromModel(model, displayPath);
}

/** A PBIP TMDL folder: `files` are its .tmdl files (tables/*.tmdl, expressions.tmdl), paths relative to `definition/`. */
export function extractPowerBiTmdl(files: Array<{ path: string; text: string }>, displayPath: string): ExtractedBiFile {
  const model: PowerBiModel = { tables: [], expressions: [] };
  for (const file of files) {
    const parsed = parseTmdl(file.text);
    model.tables.push(...parsed.tables);
    model.expressions.push(...parsed.expressions);
  }
  return extractFromModel(model, displayPath);
}

function extractFromModel(model: PowerBiModel, displayPath: string): ExtractedBiFile {
  const fileName = displayPath.replace(/\/definition$/, '').split('/').pop() ?? displayPath;
  const parameters = new Map<string, PowerQueryParameter>();
  const shared = new Map<string, string>();
  for (const expression of model.expressions) {
    const parameter = readPowerQueryParameter(expression.name, expression.expression);
    if (parameter) {
      parameters.set(expression.name, parameter);
      parameters.set(expression.name.toLowerCase(), parameter);
    } else {
      shared.set(expression.name, expression.expression);
    }
  }
  const result: ExtractedBiFile = { sources: [], skipped: [] };
  const tableLoads: string[] = [];
  const otherLoads: string[] = [];
  const calculatedTables: string[] = [];
  const measures: string[] = [];
  for (const table of model.tables) {
    measures.push(...table.measures.map((measure) => `${measure.name} = ${measure.expression.replace(/\s+/g, ' ').slice(0, 60)}`));
    for (const partition of table.partitions) {
      if (partition.type !== 'm') {
        // A table that only holds measures ({BLANK()}) is not a calculation of its own.
        if (partition.type === 'calculated' && !/^\{?\s*BLANK\(\)\s*\}?$/i.test(partition.expression.trim())) calculatedTables.push(table.name);
        continue;
      }
      const reading = readPowerQuery(partition.expression, { parameters, shared });
      reading.queries.forEach((query, index) => {
        const name = humanizeObjectName(table.name) || table.name;
        const fullName = reading.queries.length > 1 ? `${name} ${index + 1}` : name;
        const notes = [
          `From Power BI ${fileName}, table ${table.name}${query.connector ? ` on ${query.connector}` : ''}${partition.mode === 'directQuery' ? ' (DirectQuery)' : ''}.`,
          ...query.notes,
        ];
        result.sources.push({
          path: `${displayPath}#${table.name}${reading.queries.length > 1 ? `/${index + 1}` : ''}`,
          content: sqlSourceContent(fullName, notes, query.sql),
          sourceKind: 'powerbi-project',
          parameters: query.parameters,
        });
      });
      if (!reading.queries.length && reading.tables.length) tableLoads.push(`${table.name} (${reading.tables.join(', ')})`);
      else if (!reading.queries.length && reading.otherSources.length) otherLoads.push(`${table.name} (${reading.otherSources.join(', ')})`);
    }
  }
  if (tableLoads.length) {
    result.skipped.push({
      sourcePath: displayPath,
      kind: 'no-sql',
      reason: `${tableLoads.length} Power BI table${tableLoads.length === 1 ? ' loads a database table' : 's load database tables'} with Power Query steps, not SQL, so there is no query to import. ZLens reads those tables from the database itself.`,
      sql: listNames(tableLoads, 6),
    });
  }
  if (otherLoads.length) {
    result.skipped.push({
      sourcePath: displayPath,
      kind: 'no-sql',
      reason: `${otherLoads.length} Power BI table${otherLoads.length === 1 ? ' loads' : 's load'} from files or web sources, not a database, so there is no SQL to import.`,
      sql: listNames(otherLoads, 6),
    });
  }
  if (measures.length || calculatedTables.length) {
    const parts = [
      measures.length ? `${measures.length} DAX measure${measures.length === 1 ? '' : 's'}` : '',
      calculatedTables.length ? `${calculatedTables.length} calculated table${calculatedTables.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');
    result.skipped.push({
      sourcePath: displayPath,
      kind: 'calculations',
      reason: `${parts} ${measures.length + calculatedTables.length === 1 ? 'is' : 'are'} not imported. Rebuild the ones your reports need as metrics.`,
      sql: listNames([...measures, ...calculatedTables.map((name) => `${name} (calculated table)`)], 4),
    });
  }
  return result;
}

// ── TMDL ────────────────────────────────────────────────────────────────────

/**
 * The parts of TMDL the import reads: `table`, its `partition … = m` with
 * `source =` (inline or the indented lines under it, or a ``` block), its
 * `measure`s, and `expression`s (parameters and shared queries).
 */
export function parseTmdl(text: string): Pick<PowerBiModel, 'tables' | 'expressions'> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tables: PowerBiModel['tables'] = [];
  const expressions: PowerBiModel['expressions'] = [];
  let table: PowerBiModel['tables'][number] | null = null;
  const indentOf = (line: string) => /^[\t ]*/.exec(line)![0].replace(/ {4}/g, '\t').length;
  const objectName = (raw: string) => raw.trim().replace(/^'(.*)'$/, '$1').replace(/''/g, "'");

  /** The value after `=` at line `index`: the rest of the line, or the deeper-indented block under it. */
  const valueAt = (index: number, rest: string): { value: string; next: number } => {
    const own = indentOf(lines[index]);
    if (rest.trim() && !rest.trim().startsWith('```')) {
      // A value can continue on deeper lines (expression X = let … in …).
      const block = deeperBlock(index + 1, own);
      return { value: [rest, ...block.lines].join('\n').trim(), next: block.next };
    }
    if (rest.trim().startsWith('```')) {
      const body: string[] = [];
      let at = index + 1;
      while (at < lines.length && !lines[at].trim().startsWith('```')) body.push(lines[at++]);
      return { value: dedent(body).trim(), next: at + 1 };
    }
    const block = deeperBlock(index + 1, own);
    return { value: dedent(block.lines).trim(), next: block.next };
  };
  const deeperBlock = (start: number, indent: number) => {
    const block: string[] = [];
    let at = start;
    while (at < lines.length && (!lines[at].trim() || indentOf(lines[at]) > indent)) block.push(lines[at++]);
    while (block.length && !block[block.length - 1].trim()) { block.pop(); at -= 1; }
    // Only the lines deeper than a property of the object itself: stop at the first
    // line at most one level deeper that looks like a property (`mode: import`).
    return { lines: block, next: at };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const tableMatch = /^table\s+(.+)$/.exec(line);
    if (tableMatch) {
      table = { name: objectName(tableMatch[1]), partitions: [], measures: [] };
      tables.push(table);
      continue;
    }
    const expressionMatch = /^expression\s+('(?:[^']|'')+'|[^\s=]+)\s*=(.*)$/.exec(line);
    if (expressionMatch) {
      const { value, next } = valueAt(index, expressionMatch[2]);
      expressions.push({ name: objectName(expressionMatch[1]), expression: stripProperties(value) });
      index = next - 1;
      continue;
    }
    if (!table) continue;
    const measureMatch = /^\s+measure\s+('(?:[^']|'')+'|[^\s=]+)\s*=(.*)$/.exec(line);
    if (measureMatch) {
      const { value, next } = valueAt(index, measureMatch[2]);
      table.measures.push({ name: objectName(measureMatch[1]), expression: stripProperties(value) });
      index = next - 1;
      continue;
    }
    const partitionMatch = /^\s+partition\s+('(?:[^']|'')+'|[^\s=]+)\s*=\s*(\w+)\s*$/.exec(line);
    if (partitionMatch) {
      const partition = { name: objectName(partitionMatch[1]), type: partitionMatch[2], expression: '', mode: undefined as string | undefined };
      const own = indentOf(line);
      let at = index + 1;
      while (at < lines.length && (!lines[at].trim() || indentOf(lines[at]) > own)) {
        const property = /^\s+(mode|source)\s*[:=](.*)$/.exec(lines[at]);
        if (property && indentOf(lines[at]) === own + 1) {
          if (property[1] === 'mode') partition.mode = property[2].trim();
          else {
            const { value, next } = valueAt(at, property[2]);
            partition.expression = value;
            at = next;
            continue;
          }
        }
        at += 1;
      }
      table.partitions.push(partition);
      index = at - 1;
      continue;
    }
    if (trimmed.startsWith('calculationGroup')) continue;
  }
  return { tables, expressions };
}

/** A TMDL value's own lines end where the object's properties (`lineageTag: …`, `annotation …`) start. */
function stripProperties(value: string): string {
  const lines = value.split('\n');
  const cut = lines.findIndex((line, index) => index > 0 && /^\s*(?:lineageTag|annotation|formatString|displayFolder|description|queryGroup|isHidden|resultType|kind|changedProperty)\b/.test(line));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[\t ]*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut)).join('\n');
}
