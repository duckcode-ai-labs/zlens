import { readFileSync } from 'node:fs';
import { extractPowerBiModelJson, extractPowerBiTemplate, extractPowerBiTmdl, powerBiReportWithoutModel } from './powerbi.js';
import { extractTableauPackagedWorkbook, extractTableauWorkbook } from './tableau.js';
import type { ExtractedBiFile } from './types.js';
import { decodeModelText } from './zip.js';

export type { ExtractedBiFile, ExtractedSqlSource } from './types.js';

/**
 * Import SQL reads BI files as well as .sql: Tableau workbooks (.twb, .twbx)
 * and Power BI templates (.pbit), projects (model.bim, a TMDL folder) and
 * reports (.pbix, which only gets a note on how to export a template).
 */

/** Files the import reads besides .sql. A .tmdl file is read with the rest of its folder. */
export function isBiImportFile(fileName: string): boolean {
  return /\.(?:twb|twbx|pbit|pbix|tmdl)$/i.test(fileName) || /(?:^|[\\/])model\.bim$/i.test(fileName);
}

export function biSourceKind(fileName: string): 'tableau-workbook' | 'powerbi-project' | null {
  if (/\.(?:twb|twbx)$/i.test(fileName)) return 'tableau-workbook';
  if (/\.(?:pbit|pbix|pbip|tmdl|bim)$/i.test(fileName) || /\.SemanticModel$/i.test(fileName)) return 'powerbi-project';
  return null;
}

/** One BI file's queries and what it leaves out. Binary files (.twbx, .pbit) come as bytes. */
export function readBiFile(content: Buffer, displayPath: string): ExtractedBiFile {
  const lower = displayPath.toLowerCase();
  if (lower.endsWith('.twb')) return extractTableauWorkbook(content.toString('utf8'), displayPath);
  if (lower.endsWith('.twbx')) return extractTableauPackagedWorkbook(content, displayPath);
  if (lower.endsWith('.pbit')) return extractPowerBiTemplate(content, displayPath);
  if (lower.endsWith('.pbix')) return powerBiReportWithoutModel(displayPath);
  if (lower.endsWith('model.bim')) return extractPowerBiModelJson(decodeModelText(content), displayPath);
  if (lower.endsWith('.tmdl')) return extractPowerBiTmdl([{ path: displayPath, text: decodeModelText(content) }], displayPath);
  return { sources: [], skipped: [] };
}

/** A PBIP model's TMDL folder (`…/definition`): its tables and shared expressions read together. */
export function readTmdlFolder(files: Array<{ absolutePath: string; displayPath: string }>, folderDisplayPath: string): ExtractedBiFile {
  return extractPowerBiTmdl(files.map((file) => ({ path: file.displayPath, text: decodeModelText(readFileSync(file.absolutePath)) })), folderDisplayPath);
}

/** A BI file that could not be read, as a left-out entry instead of failing the whole import. */
export function unreadableBiFile(displayPath: string, error: unknown): ExtractedBiFile {
  return {
    sources: [],
    skipped: [{
      sourcePath: displayPath,
      kind: 'unreadable',
      reason: `ZLens could not read this file: ${error instanceof Error ? error.message : String(error)}`,
      sql: displayPath.split('/').pop() ?? displayPath,
    }],
  };
}
