import { variableName, type ImportedParameterType, type ImportedSqlParameter } from '../sql-import-script.js';
import { listNames, sqlSourceContent, type ExtractedBiFile } from './types.js';
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
  athena: 'Athena', exasol: 'Exasol', saphana: 'SAP HANA', db2: 'Db2', 'genericodbc': 'ODBC',
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
  const result: ExtractedBiFile = { sources: [], skipped: [] };

  for (const source of dataSources) {
    if (source.attributes.name === 'Parameters' || source.attributes.hasconnection === 'false') continue;
    const caption = source.attributes.caption || source.attributes.name || 'Data source';
    const relations = descendants(source, 'relation');
    const namedConnections = new Map(descendants(source, 'named-connection').map((named) => [named.attributes.name, child(named, 'connection')]));
    const ownConnection = child(source, 'connection');
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
    if (calculations.length) {
      result.skipped.push({
        sourcePath: `${displayPath}#${caption}`,
        kind: 'calculations',
        reason: `${calculations.length} calculated field${calculations.length === 1 ? ' is' : 's are'} not imported from data source ${caption}. Rebuild the ones your reports need as metrics.`,
        sql: listNames(calculations.map((column) => `${column.attributes.caption ?? column.attributes.name}: ${(child(column, 'calculation')!.attributes.formula ?? '').replace(/\s+/g, ' ').slice(0, 80)}`), 4),
      });
    }
  }
  return result;
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
