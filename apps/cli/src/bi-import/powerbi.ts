import { humanizeObjectName } from '../sql-import-script.js';
import { readPowerQuery, readPowerQueryParameter, readPowerQueryTable, type PowerQueryParameter } from './power-query.js';
import type { BiCalculation } from './calculations.js';
import {
  listNames,
  sqlSourceContent,
  type BiCalculationModel,
  type BiDataType,
  type BiInventory,
  type BiModelTable,
  type BiReportPage,
  type ExtractedBiFile,
} from './types.js';
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
    /** Calculated columns (a data column has no expression). */
    columns: Array<{ name: string; expression: string }>;
    /** Data columns: the name the report uses, its type, and the column Power Query gives it. */
    dataColumns: Array<{ name: string; dataType?: string; sourceColumn?: string }>;
  }>;
  expressions: Array<{ name: string; expression: string }>;
  /** The model's storage mode, for a partition that does not name its own. */
  defaultMode?: string;
}

export function extractPowerBiTemplate(zip: Buffer, displayPath: string): ExtractedBiFile {
  const schema = readZipFile(zip, (name) => name === 'DataModelSchema');
  if (!schema) throw new Error(`${displayPath} has no DataModelSchema; save it again as a Power BI template (.pbit).`);
  const extracted = extractPowerBiModelJson(decodeModelText(schema.data), displayPath);
  if (extracted.inventory) {
    try {
      const layout = readZipFile(zip, (name) => name === 'Report/Layout');
      if (layout) extracted.inventory.pages = readPowerBiReportLayout(decodeModelText(layout.data));
    } catch {
      // The report is only counted; its queries are what the import needs.
    }
  }
  return extracted;
}

/**
 * A report's pages and their visuals from its layout JSON: a template's
 * `Report/Layout`, or a PBIP report's `report.json` (the older format).
 */
export function readPowerBiReportLayout(text: string): BiReportPage[] {
  const layout = JSON.parse(text) as { sections?: Array<{ displayName?: string; name?: string; visualContainers?: Array<{ config?: string }> }> };
  return (layout.sections ?? []).map((section) => ({
    name: section.displayName || section.name || 'Page',
    kind: 'page' as const,
    visuals: (section.visualContainers ?? []).map((container) => {
      try {
        return String((JSON.parse(container.config ?? '{}') as { singleVisual?: { visualType?: string } }).singleVisual?.visualType ?? '');
      } catch {
        return '';
      }
    }).filter(Boolean),
  }));
}

/**
 * A PBIP report in the PBIR format: `definition/pages/<page>/page.json` and
 * `definition/pages/<page>/visuals/<visual>/visual.json`, paths relative to the
 * report folder.
 */
export function readPowerBiReportDefinition(files: Array<{ path: string; text: string }>): BiReportPage[] {
  const pages = new Map<string, BiReportPage>();
  const pageOf = (id: string) => {
    const page = pages.get(id) ?? { name: id, kind: 'page' as const, visuals: [] };
    pages.set(id, page);
    return page;
  };
  const normalized = files.map((file) => ({ path: file.path.replace(/\\/g, '/'), text: file.text })).sort((a, b) => a.path.localeCompare(b.path));
  for (const file of normalized) {
    const pageMatch = /(?:^|\/)pages\/([^/]+)\/page\.json$/i.exec(file.path);
    const visualMatch = /(?:^|\/)pages\/([^/]+)\/visuals\/[^/]+\/visual\.json$/i.exec(file.path);
    try {
      if (pageMatch) {
        const json = JSON.parse(file.text) as { displayName?: string };
        const page = pageOf(pageMatch[1]!);
        if (json.displayName) page.name = json.displayName;
      } else if (visualMatch) {
        const json = JSON.parse(file.text) as { visual?: { visualType?: string } };
        if (json.visual?.visualType) pageOf(visualMatch[1]!).visuals.push(json.visual.visualType);
      }
    } catch {
      // A file that does not parse is not counted.
    }
  }
  // `pages/pages.json` lists the pages in the order the report shows them.
  let order: string[] = [];
  try {
    order = (JSON.parse(normalized.find((file) => /(?:^|\/)pages\/pages\.json$/i.test(file.path))?.text ?? '{}') as { pageOrder?: string[] }).pageOrder ?? [];
  } catch {
    // Without it, pages come in folder order.
  }
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...pages.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([, page]) => page);
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
  const json = JSON.parse(text) as { model?: { tables?: any[]; expressions?: any[]; defaultMode?: string } };
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
      columns: (table.columns ?? [])
        .filter((column: any) => column.type === 'calculated' && joined(column.expression).trim())
        .map((column: any) => ({ name: String(column.name ?? ''), expression: joined(column.expression) })),
      dataColumns: (table.columns ?? [])
        .filter((column: any) => (column.type ?? 'data') === 'data' && column.name)
        .map((column: any) => ({
          name: String(column.name),
          ...(column.dataType ? { dataType: String(column.dataType) } : {}),
          ...(column.sourceColumn ? { sourceColumn: String(column.sourceColumn) } : {}),
        })),
    })),
    expressions: (json.model?.expressions ?? []).map((expression: any) => ({ name: String(expression.name ?? ''), expression: joined(expression.expression) })),
    ...(json.model?.defaultMode ? { defaultMode: json.model.defaultMode } : {}),
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
    if (parsed.defaultMode) model.defaultMode = parsed.defaultMode;
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
  const inventory: BiInventory = { tool: 'powerbi', dataSources: [], calculations: [], tablesWithoutSql: 0, pages: [] };
  const calculationModel: BiCalculationModel = { tool: 'powerbi', name: fileName, sourcePath: displayPath, tables: [], fields: [], filters: [], unreadableFilters: [] };
  const result: ExtractedBiFile = { sources: [], skipped: [], inventory, models: [calculationModel] };
  const connectors = new Map<string, BiInventory['dataSources'][number]>();
  const tableLoads: string[] = [];
  const tablesLoaded = new Set<string>();
  const otherLoads: string[] = [];
  const calculatedTables: string[] = [];
  const measures: string[] = [];
  const calculation = (name: string, formula: string, role: BiCalculation['role'], owner: string): BiCalculation => ({ name, formula, language: 'dax', role, owner, sourcePath: displayPath });
  for (const table of model.tables) {
    calculationModel.tables.push(modelTable(table, shared, model.defaultMode));
    const renames = table.partitions.length === 1 && table.partitions[0]!.type === 'm' ? readPowerQueryTable(table.partitions[0]!.expression, { shared }).renames : new Map<string, string>();
    for (const column of table.dataColumns) {
      const loaded = column.sourceColumn ?? column.name;
      calculationModel.fields.push({ name: column.name, table: table.name, column: renames.get(loaded.toLowerCase()) ?? loaded, dataType: powerBiDataType(column.dataType) });
    }
    measures.push(...table.measures.map((measure) => `${measure.name} = ${measure.expression.replace(/\s+/g, ' ').slice(0, 60)}`));
    inventory.calculations.push(...table.measures.map((measure) => calculation(measure.name, measure.expression, 'measure', table.name)));
    inventory.calculations.push(...table.columns.map((column) => calculation(column.name, column.expression, 'column', table.name)));
    for (const partition of table.partitions) {
      if (partition.type !== 'm') {
        // A table that only holds measures ({BLANK()}) is not a calculation of its own.
        if (partition.type === 'calculated' && !/^\{?\s*BLANK\(\)\s*\}?$/i.test(partition.expression.trim())) {
          calculatedTables.push(table.name);
          inventory.calculations.push(calculation(table.name, partition.expression, 'table', table.name));
        }
        continue;
      }
      const reading = readPowerQuery(partition.expression, { parameters, shared });
      // A database connector, else what it loads from (Csv.Document, Excel.Workbook, Web.Contents).
      const source = reading.connector ?? reading.otherSources[0];
      if (source && !connectors.has(source)) connectors.set(source, { name: source, database: source });
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
      if (!reading.queries.length && reading.tables.length) {
        tableLoads.push(`${table.name} (${reading.tables.join(', ')})`);
        tablesLoaded.add(table.name);
      }
      else if (!reading.queries.length && reading.otherSources.length) otherLoads.push(`${table.name} (${reading.otherSources.join(', ')})`);
    }
  }
  inventory.dataSources.push(...connectors.values());
  // Each table once, however many partitions it has; file and web loads are data sources, not database tables.
  inventory.tablesWithoutSql = tablesLoaded.size;
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
      reason: `${parts} ${measures.length + calculatedTables.length === 1 ? 'has' : 'have'} no SQL to import. Simple, filtered and ratio measures become metric drafts; the rest are listed with why.`,
      sql: listNames([...measures, ...calculatedTables.map((name) => `${name} (calculated table)`)], 4),
    });
  }
  return result;
}

/**
 * The database table a Power BI table loads, read from its one Power Query
 * partition. A table with several partitions, a native query, a file, a
 * calculated table, or Power Query steps that change rows has none.
 */
function modelTable(table: PowerBiModel['tables'][number], shared: Map<string, string>, defaultMode: string | undefined): BiModelTable {
  const partitions = table.partitions;
  const modes = partitions.map((partition) => (partition.mode ?? defaultMode ?? 'import').toLowerCase());
  const mode = modes.includes('directquery') ? 'directQuery' as const : modes.includes('dual') ? 'dual' as const : 'import' as const;
  if (partitions.length !== 1) return { name: table.name, mode, noTable: partitions.length ? 'It loads several partitions.' : 'It loads no data.' };
  const partition = partitions[0]!;
  if (partition.type !== 'm') return { name: table.name, mode, noTable: partition.type === 'calculated' ? 'It is a calculated table.' : `It loads with a ${partition.type} partition.` };
  const reading = readPowerQuery(partition.expression, { parameters: new Map(), shared });
  if (reading.queries.length) return { name: table.name, mode, noTable: 'It loads a native query, not a table.' };
  if (reading.otherSources.length) return { name: table.name, mode, noTable: `It loads from ${reading.otherSources.join(', ')}, not a database.` };
  const loaded = readPowerQueryTable(partition.expression, { shared });
  if (!loaded.source) return { name: table.name, mode, noTable: 'ZLens cannot tell which database table it loads.' };
  if (loaded.changingSteps.length) {
    return { name: table.name, mode, noTable: `Its Power Query changes the rows or values after loading (${Array.from(new Set(loaded.changingSteps)).join(', ')}).` };
  }
  return { name: table.name, mode, source: loaded.source, ...(Object.keys(loaded.changedTypes).length ? { changedTypes: loaded.changedTypes } : {}) };
}

function powerBiDataType(dataType: string | undefined): BiDataType {
  const type = (dataType ?? '').toLowerCase();
  if (type === 'int64') return 'integer';
  if (type === 'double' || type === 'decimal') return 'number';
  if (type === 'string') return 'string';
  if (type === 'datetime') return 'date';
  if (type === 'boolean') return 'boolean';
  return 'unknown';
}

// ── TMDL ────────────────────────────────────────────────────────────────────

/**
 * The parts of TMDL the import reads: `table`, its `partition … = m` with
 * `source =` (inline or the indented lines under it, or a ``` block), its
 * `measure`s, and `expression`s (parameters and shared queries).
 */
export function parseTmdl(text: string): Pick<PowerBiModel, 'tables' | 'expressions' | 'defaultMode'> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tables: PowerBiModel['tables'] = [];
  const expressions: PowerBiModel['expressions'] = [];
  let defaultMode: string | undefined;
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
    const modeMatch = !table ? /^\s+defaultMode:\s*(\w+)/.exec(line) : null;
    if (modeMatch) defaultMode = modeMatch[1];
    const tableMatch = /^table\s+(.+)$/.exec(line);
    if (tableMatch) {
      table = { name: objectName(tableMatch[1]), partitions: [], measures: [], columns: [], dataColumns: [] };
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
    // A calculated column has `= expression`; a data column has none.
    const columnMatch = /^\s+column\s+('(?:[^']|'')+'|[^\s=]+)\s*=(.*)$/.exec(line);
    if (columnMatch) {
      const { value, next } = valueAt(index, columnMatch[2]);
      table.columns.push({ name: objectName(columnMatch[1]), expression: stripProperties(value) });
      index = next - 1;
      continue;
    }
    // A data column has no `=`; its type and source column are properties under it.
    const dataColumnMatch = /^\s+column\s+('(?:[^']|'')+'|[^\s=]+)\s*$/.exec(line);
    if (dataColumnMatch) {
      const column: PowerBiModel['tables'][number]['dataColumns'][number] = { name: objectName(dataColumnMatch[1]) };
      const own = indentOf(line);
      let at = index + 1;
      while (at < lines.length && (!lines[at].trim() || indentOf(lines[at]) > own)) {
        const property = /^\s+(dataType|sourceColumn)\s*:\s*(.+)$/.exec(lines[at]);
        if (property && indentOf(lines[at]) === own + 1) column[property[1] as 'dataType' | 'sourceColumn'] = objectName(property[2]);
        at += 1;
      }
      table.dataColumns.push(column);
      index = at - 1;
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
  return { tables, expressions, ...(defaultMode ? { defaultMode } : {}) };
}

/** A TMDL value's own lines end where the object's properties (`lineageTag: …`, `annotation …`) start. */
function stripProperties(value: string): string {
  const lines = value.split('\n');
  const cut = lines.findIndex((line, index) => index > 0 && /^\s*(?:lineageTag|annotation|formatString|displayFolder|description|queryGroup|isHidden|resultType|kind|changedProperty|dataType|summarizeBy|sortByColumn|dataCategory|isNameInferred|isDataTypeInferred|isAvailableInMdx|sourceColumn)\b/.test(line));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[\t ]*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut)).join('\n');
}
