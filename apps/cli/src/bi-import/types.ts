import type { ImportedSqlParameter, SkippedSqlStatement } from '../sql-import-script.js';

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
}

export function sqlSourceContent(name: string, notes: string[], sql: string): string {
  const lines = [`-- name: ${name.replace(/[\r\n]+/g, ' ')}`, ...notes.filter(Boolean).map((note) => `-- zlens-note: ${note.replace(/[\r\n]+/g, ' ')}`), sql.trim()];
  return `${lines.join('\n')}\n`;
}

export function listNames(names: string[], limit = 5): string {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}
