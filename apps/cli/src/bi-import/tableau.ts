import { variableName, type ImportedParameterType, type ImportedSqlParameter } from '../sql-import-script.js';
import type { BiCalculation } from './calculations.js';
import {
  listNames,
  sqlSourceContent,
  type BiCalculationModel,
  type BiDataType,
  type BiInventory,
  type BiLiteral,
  type BiModelTable,
  type BiSourceFilter,
  type BiWorksheet,
  type ExtractedBiFile,
} from './types.js';
import { child, descendants, parseXml, type XmlElement } from './xml.js';
import { readZipFile } from './zip.js';

/**
 * Custom SQL from a Tableau workbook (.twb, or the .twb inside a .twbx).
 *
 * Each Custom SQL relation of a data source (`<relation type='text'>`) becomes
 * one query, named after the relation. Parameters it uses (stored as
 * `<[Parameters].[Parameter 1]>`, typed as `<Parameters.Start Date>`) become
 * saved query parameters with the parameter's current value as default. A data
 * source that only reads tables, and calculated fields, have no SQL to import
 * and are listed as left out.
 */

const CONNECTION_NAMES: Record<string, string> = {
  postgres: 'PostgreSQL', sqlserver: 'SQL Server', snowflake: 'Snowflake', redshift: 'Redshift', bigquery: 'BigQuery',
  databricks: 'Databricks', oracle: 'Oracle', mysql: 'MySQL', teradata: 'Teradata', vertica: 'Vertica', presto: 'Presto',
  trino: 'Trino', 'azure-sql-dw': 'Azure Synapse', hyper: 'a Tableau extract', 'excel-direct': 'Excel', textscan: 'a text file',
  athena: 'Athena', exasol: 'Exasol', saphana: 'SAP HANA', db2: 'Db2', 'genericodbc': 'ODBC', sqlproxy: 'a published Tableau data source',
};

export function extractTableauPackagedWorkbook(zip: Buffer, displayPath: string): ExtractedBiFile {
  const workbook = readZipFile(zip, (name) => /\.twb$/i.test(name) && !name.includes('/'))
    ?? readZipFile(zip, (name) => /\.twb$/i.test(name));
  if (!workbook) throw new Error(`${displayPath} has no .twb workbook inside.`);
  return extractTableauWorkbook(workbook.data.toString('utf8'), displayPath);
}

export function extractTableauWorkbook(xml: string, displayPath: string): ExtractedBiFile {
  const document = parseXml(xml);
  const workbook = document.children.find((element) => element.name === 'workbook') ?? document;
  const fileName = displayPath.split('/').pop() ?? displayPath;
  const dataSources = child(workbook, 'datasources')?.children.filter((element) => element.name === 'datasource') ?? [];
  const parameters = readParameters(dataSources.find((source) => source.attributes.name === 'Parameters'));
  const worksheetsBySource = worksheetsUsing(workbook);
  const inventory: BiInventory = { tool: 'tableau', dataSources: [], calculations: [], tablesWithoutSql: 0, pages: reportPages(workbook) };
  const result: ExtractedBiFile = { sources: [], skipped: [], inventory, models: [], worksheets: worksheetFilters(workbook, dataSources) };

  for (const source of dataSources) {
    if (source.attributes.name === 'Parameters' || source.attributes.hasconnection === 'false') continue;
    const caption = source.attributes.caption || source.attributes.name || 'Data source';
    const relations = descendants(source, 'relation');
    const namedConnections = new Map(descendants(source, 'named-connection').map((named) => [named.attributes.name, child(named, 'connection')]));
    const ownConnection = child(source, 'connection');
    const databaseClass = [...namedConnections.values(), ownConnection].map((connection) => connection?.attributes.class).find((value) => value && value !== 'federated');
    inventory.dataSources.push({ name: caption, ...(databaseClass ? { database: CONNECTION_NAMES[databaseClass] ?? databaseClass } : {}) });
    const customSql: XmlElement[] = [];
    const seen = new Set<string>();
    // The same relation appears in the connection tree and again in the newer object graph.
    for (const relation of relations) {
      if (relation.attributes.type !== 'text' || !relation.text.trim()) continue;
      const key = `${relation.attributes.name ?? ''}\u0000${relation.text.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      customSql.push(relation);
    }
    const worksheets = worksheetsBySource.get(source.attributes.name ?? '') ?? [];
    const names = new Map<string, number>();
    customSql.forEach((relation, index) => {
      const connection = namedConnections.get(relation.attributes.connection ?? '') ?? ownConnection;
      const connectionClass = connection?.attributes.class && connection.attributes.class !== 'federated' ? connection.attributes.class : undefined;
      const relationName = (relation.attributes.name ?? '').replace(/\s*\(custom sql\)\s*$/i, '').trim();
      let name = relationName && !/^custom sql query\d*$/i.test(relationName) ? relationName : customSql.length > 1 ? `${caption} ${index + 1}` : caption;
      const repeat = (names.get(name) ?? 0) + 1;
      names.set(name, repeat);
      if (repeat > 1) name = `${name} ${repeat}`;
      const converted = convertParameters(relation.text.replace(/\r\n?/g, '\n').trim(), parameters);
      const notes = [
        `From Tableau workbook ${fileName}, data source ${caption}${connectionClass ? ` on ${CONNECTION_NAMES[connectionClass] ?? connectionClass}` : ''}.`,
        worksheets.length ? `Used by ${worksheets.length === 1 ? 'worksheet' : 'worksheets'} ${listNames(worksheets)}.` : '',
        connection?.attributes['one-time-sql'] ? 'This connection runs Initial SQL before the query; check that it does not change what the query returns.' : '',
      ];
      result.sources.push({
        path: `${displayPath}#${caption}/${name}`,
        content: sqlSourceContent(name, notes, converted.sql),
        sourceKind: 'tableau-workbook',
        parameters: converted.parameters,
      });
    });

    if (customSql.length === 0) {
      const tables = Array.from(new Set(relations
        .filter((relation) => relation.attributes.type === 'table' && relation.attributes.table)
        .map((relation) => relation.attributes.table.replace(/[\[\]"]/g, ''))));
      // Tables from a text file or a workbook are not in a database ZLens reads.
      if (!databaseClass || !['textscan', 'excel-direct', 'hyper'].includes(databaseClass)) inventory.tablesWithoutSql += tables.length;
      if (tables.length) {
        result.skipped.push({
          sourcePath: `${displayPath}#${caption}`,
          kind: 'no-sql',
          reason: `Tableau data source ${caption} reads ${tables.length === 1 ? 'a table' : `${tables.length} tables`} directly, with no Custom SQL to import. ZLens reads those tables from the database itself.`,
          sql: listNames(tables, 8),
        });
      }
    }

    const calculations = source.children.filter((column) => {
      const calculation = column.name === 'column' ? child(column, 'calculation') : undefined;
      return calculation?.attributes.class === 'tableau' && (calculation.attributes.formula ?? '').trim() !== '1';
    });
    inventory.calculations.push(...calculatedFields(calculations, source, caption, displayPath));
    result.models!.push(calculationModel(source, caption, displayPath, namedConnections, ownConnection));
    if (calculations.length) {
      result.skipped.push({
        sourcePath: `${displayPath}#${caption}`,
        kind: 'calculations',
        reason: `${calculations.length} calculated field${calculations.length === 1 ? '' : 's'} from data source ${caption} ${calculations.length === 1 ? 'has' : 'have'} no SQL to import. Simple, filtered and ratio calculations become metric drafts; the rest are listed with why.`,
        sql: listNames(calculations.map((column) => `${column.attributes.caption ?? column.attributes.name}: ${(child(column, 'calculation')!.attributes.formula ?? '').replace(/\s+/g, ' ').slice(0, 80)}`), 4),
      });
    }
  }
  return result;
}

/**
 * The calculated fields of a data source, each with its formula. A formula
 * names other calculations by their internal name (`[Calculation_1234]`);
 * those become the captions people see, so the formula reads as in Tableau.
 */
function calculatedFields(columns: XmlElement[], source: XmlElement, caption: string, displayPath: string): BiCalculation[] {
  const captions = new Map<string, string>();
  for (const column of source.children.filter((element) => element.name === 'column')) {
    const internal = (column.attributes.name ?? '').replace(/^\[|\]$/g, '');
    if (internal && column.attributes.caption) captions.set(internal, column.attributes.caption);
  }
  const calculationNames = new Map(columns.map((column) => {
    const internal = (column.attributes.name ?? '').replace(/^\[|\]$/g, '');
    return [internal, column.attributes.caption ?? internal];
  }));
  return columns.map((column) => {
    const formula = (child(column, 'calculation')!.attributes.formula ?? '').replace(/\r\n?/g, '\n');
    const references = Array.from(new Set(Array.from(formula.matchAll(/\[([^\]]+)\]/g), (match) => calculationNames.get(match[1]!)).filter((name): name is string => Boolean(name))));
    const id = (column.attributes.name ?? '').replace(/^\[|\]$/g, '');
    return {
      name: calculationNames.get(id) ?? 'Calculation',
      id,
      rawFormula: formula,
      formula: formula.replace(/\[([^\]]+)\]/g, (whole, name: string) => (captions.has(name) ? `[${captions.get(name)}]` : whole)),
      references,
      language: 'tableau' as const,
      role: column.attributes.role === 'measure' ? 'measure' as const : 'column' as const,
      owner: caption,
      sourcePath: displayPath,
    };
  });
}

const NO_DATABASE: Record<string, string> = {
  hyper: 'a Tableau extract with no live connection',
  textscan: 'a text file',
  'excel-direct': 'an Excel file',
  sqlproxy: 'a published Tableau data source, whose tables are on Tableau Server',
};

/**
 * Where the fields of a data source read from: each field's metadata record
 * names its column (`remote-name`) and the relation it is in (`parent-name`),
 * and the relation names its table (`[public].[users]`). Also the data
 * source's and its extract's filters, and its joins, which change what its
 * calculations add up.
 */
function calculationModel(
  source: XmlElement,
  caption: string,
  displayPath: string,
  namedConnections: Map<string | undefined, XmlElement | undefined>,
  ownConnection: XmlElement | undefined,
): BiCalculationModel {
  const model: BiCalculationModel = { tool: 'tableau', name: caption, sourcePath: displayPath, tables: [], fields: [], filters: [], unreadableFilters: [] };
  const extract = source.children.find((element) => element.name === 'extract');
  const live = ownConnection ? [ownConnection] : [];
  const relations = live.flatMap((connection) => descendants(connection, 'relation'));
  const tables = new Map<string, BiModelTable>();
  for (const relation of relations) {
    const name = relation.attributes.name;
    if (!name || tables.has(name) || relation.attributes.type === 'join' || relation.attributes.type === 'collection') continue;
    const connection = namedConnections.get(relation.attributes.connection) ?? ownConnection;
    const connectionClass = connection?.attributes.class ?? '';
    if (NO_DATABASE[connectionClass]) {
      tables.set(name, { name, noTable: `It reads ${NO_DATABASE[connectionClass]}.` });
    } else if (relation.attributes.type === 'table' && relation.attributes.table) {
      const parts = Array.from(relation.attributes.table.matchAll(/\[((?:[^\]]|\]\])+)\]|([^.[\]]+)/g), (match) => (match[1] ?? match[2]!).replace(/\]\]/g, ']'));
      const table = parts[parts.length - 1]!;
      tables.set(name, {
        name,
        source: {
          ...(parts.length > 1 ? { schema: parts[parts.length - 2] } : {}),
          table,
          ...(connection?.attributes.server ? { server: connection.attributes.server } : {}),
          ...(connection?.attributes.dbname ? { database: connection.attributes.dbname } : {}),
          ...(connectionClass && connectionClass !== 'federated' ? { connector: CONNECTION_NAMES[connectionClass] ?? connectionClass } : {}),
        },
      });
    } else {
      tables.set(name, { name, noTable: relation.attributes.type === 'text' ? 'It reads Custom SQL, a query rather than a table.' : `It reads a ${relation.attributes.type ?? 'relation'}, not a table.` });
    }
  }
  model.tables = Array.from(tables.values());
  if (!model.tables.length) {
    const connectionClass = ownConnection?.attributes.class ?? '';
    model.noTables = NO_DATABASE[connectionClass] ? `It reads ${NO_DATABASE[connectionClass]}.` : 'It reads no database table.';
  }

  const captions = new Map<string, string>();
  for (const column of source.children.filter((element) => element.name === 'column')) {
    if (column.attributes.caption) captions.set((column.attributes.name ?? '').replace(/^\[|\]$/g, ''), column.attributes.caption);
  }
  const seen = new Set<string>();
  for (const record of live.flatMap((connection) => descendants(connection, 'metadata-record'))) {
    if (record.attributes.class !== 'column') continue;
    const name = (child(record, 'local-name')?.text ?? '').trim().replace(/^\[|\]$/g, '');
    const table = (child(record, 'parent-name')?.text ?? '').trim().replace(/^\[|\]$/g, '');
    const column = (child(record, 'remote-name')?.text ?? '').trim();
    if (!name || !column || seen.has(name)) continue;
    seen.add(name);
    model.fields.push({
      name,
      ...(captions.get(name) ? { caption: captions.get(name) } : {}),
      table,
      column,
      dataType: tableauDataType(child(record, 'local-type')?.text),
    });
  }

  const joins = relations.filter((relation) => relation.attributes.type === 'join');
  if (joins.length) {
    const firstTable = (relation: XmlElement | undefined): string => {
      if (!relation) return '?';
      if (relation.attributes.type !== 'join') return relation.attributes.name ?? '?';
      return firstTable(relation.children.find((element) => element.name === 'relation'));
    };
    model.joins = {
      tables: new Set(relations.filter((relation) => relation.attributes.type !== 'join').map((relation) => relation.attributes.name)).size,
      inner: joins.filter((join) => join.attributes.join === 'inner').map((join) => {
        const sides = join.children.filter((element) => element.name === 'relation');
        return `${firstTable(sides[0])} with ${firstTable(sides[1])}`;
      }),
    };
  }

  const readFilter = (filter: XmlElement, from: BiSourceFilter['from']) => {
    const read = readSourceFilter(filter, from);
    if (typeof read === 'string') model.unreadableFilters.push(read);
    else if (read) model.filters.push(read);
  };
  for (const filter of source.children.filter((element) => element.name === 'filter')) readFilter(filter, 'data source');
  if (extract && extract.attributes.enabled !== 'false') {
    model.readsExtract = true;
    for (const filter of descendants(extract, 'filter')) readFilter(filter, 'extract');
  }
  return model;
}

function tableauDataType(localType: string | undefined): BiDataType {
  const type = (localType ?? '').trim().toLowerCase();
  if (type === 'integer') return 'integer';
  if (type === 'real') return 'number';
  if (type === 'string') return 'string';
  if (type === 'date' || type === 'datetime') return 'date';
  if (type === 'boolean') return 'boolean';
  return 'unknown';
}

/**
 * A data source or extract filter as values kept or dropped, or a range. A
 * filter ZLens cannot read (a condition, a top N, a relative date) comes back
 * as words; null when it keeps every row.
 */
function readSourceFilter(filter: XmlElement, from: BiSourceFilter['from']): BiSourceFilter | string | null {
  const rawColumn = filter.attributes.column ?? '';
  // `[federated.0abc].[none:region:nk]` → region; `[region]` → region.
  const last = /\[((?:[^\]]|\]\])+)\]$/.exec(rawColumn)?.[1]?.replace(/\]\]/g, ']') ?? rawColumn;
  const derived = /^(\w+):(.+):(\w+)$/.exec(last);
  const field = derived ? derived[2]! : last;
  const words = `A ${from} filter on ${field || 'a field'} (${filter.attributes.class ?? 'unknown'})`;
  if (!field || (derived && derived[1] !== 'none')) return `${words} that ZLens cannot read.`;
  if (filter.attributes.class === 'quantitative') {
    const included = filter.attributes['included-values'] ?? 'in-range';
    const min = child(filter, 'min')?.text.trim();
    const max = child(filter, 'max')?.text.trim();
    if (included === 'all') return null;
    if (included === 'non-null') return { field, kind: 'exclude', values: [{ kind: 'null' }], from };
    if (included === 'null') return { field, kind: 'include', values: [{ kind: 'null' }], from };
    if (included !== 'in-range' && included !== 'in-range-or-null') return `${words} that ZLens cannot read.`;
    return {
      field,
      kind: 'range',
      ...(min ? { min: tableauLiteral(min) } : {}),
      ...(max ? { max: tableauLiteral(max) } : {}),
      ...(included === 'in-range-or-null' ? { includeNull: true } : {}),
      from,
    };
  }
  if (filter.attributes.class !== 'categorical') return `${words} that ZLens cannot read.`;
  const group = child(filter, 'groupfilter');
  if (!group) return `${words} that ZLens cannot read.`;
  const members = (element: XmlElement): BiLiteral[] | null => {
    const fn = element.attributes.function;
    if (fn === 'member') return element.attributes.member === undefined ? null : [tableauLiteral(element.attributes.member)];
    if (fn === 'union') {
      const all = element.children.filter((item) => item.name === 'groupfilter').map(members);
      return all.every((item): item is BiLiteral[] => item !== null) ? all.flat() : null;
    }
    return null;
  };
  const fn = group.attributes.function;
  if (fn === 'level-members') return null;
  if (fn === 'member' || fn === 'union') {
    const values = members(group);
    return values ? { field, kind: 'include', values, from } : `${words} that ZLens cannot read.`;
  }
  if (fn === 'except') {
    const [everything, dropped] = group.children.filter((item) => item.name === 'groupfilter');
    const values = dropped ? members(dropped) : null;
    return everything?.attributes.function === 'level-members' && values ? { field, kind: 'exclude', values, from } : `${words} that ZLens cannot read.`;
  }
  return `${words} that ZLens cannot read.`;
}

/** `"East"`, `3`, `#2024-01-01#`, `%null%`, `true` as Tableau writes a member or a range end. */
function tableauLiteral(raw: string): BiLiteral {
  const value = raw.trim();
  if (value === '%null%' || /^null$/i.test(value)) return { kind: 'null' };
  const date = /^#([^#]+)#$/.exec(value);
  if (date) return { kind: 'date', value: date[1]!.replace(/ 00:00:00$/, '') };
  const text = /^"((?:[^"]|"")*)"$/.exec(value);
  if (text) return { kind: 'string', value: text[1]!.replace(/""/g, '"') };
  if (/^(?:true|false)$/i.test(value)) return { kind: 'boolean', value: value.toLowerCase() === 'true' };
  if (value !== '' && Number.isFinite(Number(value))) return { kind: 'number', value: Number(value) };
  return { kind: 'string', value };
}

/** The filters saved on each worksheet that narrow its rows. Fields only filtered on are not in an export of it. */
function worksheetFilters(workbook: XmlElement, dataSources: XmlElement[]): BiWorksheet[] {
  const captions = new Map<string, string>();
  for (const source of dataSources) {
    for (const column of source.children.filter((element) => element.name === 'column')) {
      if (column.attributes.caption) captions.set((column.attributes.name ?? '').replace(/^\[|\]$/g, ''), column.attributes.caption);
    }
  }
  const sheets = (child(workbook, 'worksheets')?.children ?? []).filter((element) => element.name === 'worksheet');
  return sheets.map((sheet) => {
    const view = descendants(sheet, 'view')[0];
    const filters = (view?.children ?? []).filter((element) => element.name === 'filter').flatMap((filter) => {
      const read = readSourceFilter(filter, 'data source');
      if (read === null) return [];
      const field = typeof read === 'string' ? fieldOfFilter(filter) : read.field;
      const label = captions.get(field) ?? field;
      return [{ field: label, words: typeof read === 'string' ? `${label}: a ${filter.attributes.class ?? 'filter'} ZLens cannot read` : filterWords(label, read) }];
    });
    return { name: sheet.attributes.name ?? 'Worksheet', filters };
  });
}

function fieldOfFilter(filter: XmlElement): string {
  const last = /\[((?:[^\]]|\]\])+)\]$/.exec(filter.attributes.column ?? '')?.[1]?.replace(/\]\]/g, ']') ?? filter.attributes.column ?? 'a field';
  return /^\w+:(.+):\w+$/.exec(last)?.[1] ?? last;
}

function filterWords(label: string, filter: BiSourceFilter): string {
  const shown = (literal: BiLiteral) => (literal.kind === 'null' ? 'empty' : String(literal.value));
  if (filter.kind === 'range') return [filter.min ? `${label} >= ${shown(filter.min)}` : '', filter.max ? `${label} <= ${shown(filter.max)}` : ''].filter(Boolean).join(' and ') || `${label} has a value`;
  return `${label} ${filter.kind === 'include' ? 'in' : 'not in'} (${(filter.values ?? []).map(shown).join(', ')})`;
}

/** Worksheets (with the mark each draws) and dashboards. */
function reportPages(workbook: XmlElement): BiInventory['pages'] {
  const worksheets = (child(workbook, 'worksheets')?.children ?? []).filter((element) => element.name === 'worksheet');
  const dashboards = (child(workbook, 'dashboards')?.children ?? []).filter((element) => element.name === 'dashboard');
  return [
    ...worksheets.map((worksheet) => ({
      name: worksheet.attributes.name ?? 'Worksheet',
      kind: 'worksheet' as const,
      visuals: [descendants(worksheet, 'mark')[0]?.attributes.class ?? 'Automatic'],
    })),
    ...dashboards.map((dashboard) => ({ name: dashboard.attributes.name ?? 'Dashboard', kind: 'dashboard' as const, visuals: [] })),
  ];
}

interface TableauParameter extends ImportedSqlParameter {
  caption: string;
}

function readParameters(source: XmlElement | undefined): Map<string, TableauParameter> {
  const parameters = new Map<string, TableauParameter>();
  for (const column of source?.children.filter((element) => element.name === 'column') ?? []) {
    const internal = column.attributes.name ?? '';
    const caption = column.attributes.caption || internal.replace(/^\[|\]$/g, '');
    if (!caption) continue;
    const valueType = parameterType(column.attributes.datatype);
    const raw = column.attributes.value ?? child(column, 'calculation')?.attributes.formula;
    const value = raw === undefined ? undefined : parameterValue(raw, valueType);
    const parameter: TableauParameter = {
      name: variableName(caption),
      written: `<Parameters.${caption}>`,
      caption,
      valueType,
      ...(value !== undefined ? { default: value } : {}),
    };
    parameters.set(internal.replace(/^\[|\]$/g, '').toLowerCase(), parameter);
    parameters.set(caption.toLowerCase(), parameter);
  }
  return parameters;
}

function parameterType(datatype: string | undefined): ImportedParameterType {
  if (datatype === 'date' || datatype === 'datetime') return 'date';
  if (datatype === 'integer' || datatype === 'real') return 'number';
  if (datatype === 'boolean') return 'boolean';
  return 'string';
}

/** `#2024-01-01#`, `"https"`, `-8`, `true` → the value. */
function parameterValue(raw: string, type: ImportedParameterType): string | number | boolean | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const date = /^#([^#]+)#$/.exec(value);
  if (date) return date[1].replace(/ 00:00:00$/, '');
  const text = /^"((?:[^"]|"")*)"$/.exec(value);
  if (text) return text[1].replace(/""/g, '"');
  if (type === 'number' && Number.isFinite(Number(value))) return Number(value);
  if (type === 'boolean' && /^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

/** `<[Parameters].[Parameter 1]>` and `<Parameters.Start Date>` → `${start_date}`. */
function convertParameters(sql: string, parameters: Map<string, TableauParameter>): { sql: string; parameters: ImportedSqlParameter[] } {
  const used = new Map<string, ImportedSqlParameter>();
  const replaced = sql.replace(/<\[Parameters\]\.\[([^\]]+)\]>|<Parameters\.([^>\n]+)>/g, (_whole, internal: string | undefined, typed: string | undefined) => {
    const key = (internal ?? typed ?? '').trim();
    const known = parameters.get(key.toLowerCase());
    const parameter: ImportedSqlParameter = known
      ? { name: known.name, written: known.written, valueType: known.valueType, ...(known.default !== undefined ? { default: known.default } : {}) }
      : { name: variableName(key), written: `<Parameters.${key}>`, valueType: 'string' };
    used.set(parameter.name, parameter);
    return '${' + parameter.name + '}';
  });
  return { sql: replaced, parameters: Array.from(used.values()) };
}

/** Data source name → the worksheets that read it. */
function worksheetsUsing(workbook: XmlElement): Map<string, string[]> {
  const using = new Map<string, string[]>();
  for (const worksheet of descendants(workbook, 'worksheet')) {
    const name = worksheet.attributes.name;
    if (!name) continue;
    const sources = new Set(descendants(worksheet, 'datasource').map((source) => source.attributes.name).filter((value): value is string => Boolean(value)));
    for (const source of sources) using.set(source, [...(using.get(source) ?? []), name]);
  }
  return using;
}
