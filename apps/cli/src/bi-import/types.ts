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
