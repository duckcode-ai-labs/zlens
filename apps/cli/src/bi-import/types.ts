import type { ImportedSqlParameter, SkippedSqlStatement } from '../sql-import-script.js';
import type { BiCalculation } from './calculations.js';

/** One query read out of a BI file, as SQL the import's script folding takes. */
export interface ExtractedSqlSource {
  /** Where it came from, for the draft list: `reports/sales.twb#Orders/Usage Stats`. */
  path: string;
  /** `-- name:` and `-- zlens-note:` header lines, then the SQL, with parameters written `${name}`. */
  content: string;
  sourceKind: 'tableau-workbook' | 'powerbi-project';
  /** The parameters the file declares, with their current values as defaults. */
  parameters: ImportedSqlParameter[];
}

export interface ExtractedBiFile {
  sources: ExtractedSqlSource[];
  /** What has no SQL to import (table loads, calculated fields, DAX measures), with the reason. */
  skipped: SkippedSqlStatement[];
  /** What the file holds besides SQL, for `zlens migrate assess`. */
  inventory?: BiInventory;
  /** Where each field of each data source (Tableau) or model (Power BI) reads from, for turning calculations into metrics. */
  models?: BiCalculationModel[];
}

export type BiDataType = 'integer' | 'number' | 'string' | 'date' | 'boolean' | 'unknown';

/** A database table as the BI file names it. */
export interface BiTableSource {
  schema?: string;
  table: string;
  /** The server and database the file connects to, as written, to compare with ZLens's connection. */
  server?: string;
  database?: string;
  /** The database, as people say it (`Snowflake`). */
  connector?: string;
}

export interface BiModelTable {
  /** Tableau relation name, or Power BI table name. */
  name: string;
  source?: BiTableSource;
  /** Why it is not one database table (Custom SQL, a file, Power Query steps that change rows). */
  noTable?: string;
  /** Power BI: how the report reads it. Text compares ignoring case in import mode. */
  mode?: 'import' | 'directQuery' | 'dual';
  /** Power BI: database columns (lower case) Power Query changes to a whole number or a date, with the type. */
  changedTypes?: Record<string, string>;
}

export interface BiModelField {
  /** Tableau: the field's internal name without brackets. Power BI: the column's name. */
  name: string;
  caption?: string;
  /** The `BiModelTable` it belongs to. */
  table: string;
  /** The database column it reads. */
  column: string;
  dataType: BiDataType;
}

export type BiLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

/** A Tableau data source or extract filter: it narrows every calculation on the data source. */
export interface BiSourceFilter {
  /** The field's internal name. */
  field: string;
  kind: 'include' | 'exclude' | 'range';
  values?: BiLiteral[];
  min?: BiLiteral;
  max?: BiLiteral;
  /** A range that also keeps empty values. */
  includeNull?: boolean;
  from: 'data source' | 'extract';
}

/** One Tableau data source, or one Power BI model: the tables and fields its calculations read. */
export interface BiCalculationModel {
  tool: 'tableau' | 'powerbi';
  /** The Tableau data source's caption (a calculation's `owner`), or the Power BI file's name. */
  name: string;
  sourcePath: string;
  tables: BiModelTable[];
  fields: BiModelField[];
  /** Tableau: data source and extract filters ZLens reads. */
  filters: BiSourceFilter[];
  /** Tableau: filters ZLens cannot read, in words. Any one leaves the data source's calculations out. */
  unreadableFilters: string[];
  /** Tableau: the data source joins tables (older joins): how many tables, and the inner joins by their tables. */
  joins?: { tables: number; inner: string[] };
  /** Tableau: the workbook reads an extract, not the live tables. */
  readsExtract?: boolean;
  /** Why no calculation on it can become a metric: a published data source, a text file. */
  noTables?: string;
}

/** A BI file's contents, counted: where its data comes from, its calculations and its report. */
export interface BiInventory {
  tool: 'tableau' | 'powerbi';
  /** Each data source (Tableau) or connector (Power BI), with the database it reads, as people say it. */
  dataSources: Array<{ name: string; database?: string }>;
  calculations: BiCalculation[];
  /** Tables loaded without SQL (read by name, or through Power Query steps): ZLens reads them from the database. */
  tablesWithoutSql: number;
  /** Worksheets and dashboards (Tableau) or report pages (Power BI), with each one's chart types. */
  pages: BiReportPage[];
}

export interface BiReportPage {
  name: string;
  kind: 'worksheet' | 'dashboard' | 'page';
  /** The visuals on it by type (`Bar`, `lineChart`); a Tableau worksheet has one. */
  visuals: string[];
}

export function sqlSourceContent(name: string, notes: string[], sql: string): string {
  const lines = [`-- name: ${name.replace(/[\r\n]+/g, ' ')}`, ...notes.filter(Boolean).map((note) => `-- zlens-note: ${note.replace(/[\r\n]+/g, ' ')}`), sql.trim()];
  return `${lines.join('\n')}\n`;
}

export function listNames(names: string[], limit = 5): string {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}
