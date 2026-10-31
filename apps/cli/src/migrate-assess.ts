import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { planBlockStudioImport, tmdlDefinitionFolder } from './block-studio-import.js';
import { readBiFile, readTmdlFolder, unreadableBiFile } from './bi-import/index.js';
import { CALCULATION_KIND_LABELS, classifyCalculations, formulaWithoutComments, type CalculationKind, type ClassifiedCalculation } from './bi-import/calculations.js';
import { readPowerBiReportDefinition, readPowerBiReportLayout } from './bi-import/powerbi.js';
import { convertCalculationsToMetricDrafts, type ConversionOutcome } from './bi-import/metric-drafts.js';
import type { BiCalculationModel, BiReportPage, ExtractedBiFile } from './bi-import/types.js';
import type { SkippedSqlStatement } from './sql-import-script.js';

/**
 * `zlens migrate assess <folder>`: read a folder of Tableau workbooks, Power
 * BI files and SQL scripts, and say what moves to ZLens and how. It reads
 * files only: nothing runs against a database, no AI is asked, and nothing
 * leaves the computer. The query counts are the import's own
 * (`planBlockStudioImport`), so "23 queries" is what `zlens import sql` makes.
 */

export type AssessedTool = 'tableau' | 'powerbi' | 'sql';

export interface AssessedFile {
  path: string;
  tool: AssessedTool;
  queries: number;
  calculations: number;
  pages: BiReportPage[];
  /** Data sources (Tableau) or connectors (Power BI) and the database each reads. */
  dataSources: Array<{ name: string; database?: string }>;
}

export interface MigrationAssessment {
  input: string;
  readAt: string;
  zlensVersion: string;
  files: AssessedFile[];
  queries: {
    /** Drafts `zlens import sql` would make. */
    drafts: number;
    /** Drafts with report parameters. */
    withParameters: number;
    duplicates: number;
    /** Statements that change data (left out). */
    writes: number;
  };
  /** BI tables and data sources that load tables without SQL: ZLens reads those tables itself. */
  tablesWithoutSql: number;
  calculations: AssessedCalculation[];
  databases: Array<{ database: string; files: number; connects: 'yes' | 'no' | 'check'; note: string }>;
  /** Files ZLens could not read, and other left-out items that are not counted above. */
  leftOut: SkippedSqlStatement[];
}

/** A calculation, sorted, with what `zlens import sql` makes of it. */
export interface AssessedCalculation extends ClassifiedCalculation {
  /**
   * drafted: it becomes a metric draft (on its table, when the connected database has it).
   * left-out: simple, filtered or ratio, but the converter cannot place or translate it (`metricReason`).
   */
  asMetric: ConversionOutcome;
  /** The metric it becomes, in words: `sum(sales) where region = 'East', on analytics.orders`. */
  metricInWords?: string;
  metricReason?: string;
}

const BI_FILE = /\.(?:twb|twbx|pbit|pbix)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.dql', '.pbi']);

/** ZLens's connectors, by the names Tableau and Power BI give databases. */
const CONNECTS: Record<string, string> = {
  PostgreSQL: 'PostgreSQL', 'SQL Server': 'SQL Server', Snowflake: 'Snowflake', Redshift: 'Amazon Redshift', BigQuery: 'BigQuery',
  Databricks: 'Databricks', MySQL: 'MySQL', Trino: 'Trino', Athena: 'Amazon Athena', ClickHouse: 'ClickHouse', DuckDB: 'DuckDB', SQLite: 'SQLite',
};
const CHECK: Record<string, string> = {
  'Azure Synapse': 'Try the SQL Server connection; Synapse is not tested.',
  Presto: 'Try the Trino connection; Presto is not tested.',
  ODBC: 'Depends on the database behind the ODBC driver.',
  'a Tableau extract': 'An extract (.hyper) is a copy: connect ZLens to the database it was made from.',
  'a published Tableau data source': 'Published to Tableau Server or Cloud: connect ZLens to the database it reads.',
  'Not stated in the file': 'The file does not say which database: check the data source in Tableau or Power BI.',
  'a text file': 'CSV files: a ZLens Local files connection reads a folder of them.',
  'Csv.Document': 'CSV files: a ZLens Local files connection reads a folder of them.',
};

function cliVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Every file the assessment reads, and each PBIP report folder (`<name>.Report`). */
function walk(root: string): { files: string[]; reportFolders: string[] } {
  const files: string[] = [];
  const reportFolders: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/\.Report$/i.test(entry.name)) reportFolders.push(full);
        else stack.push(full);
      } else if (entry.isFile() && (BI_FILE.test(entry.name) || /\.(?:sql|tmdl)$/i.test(entry.name) || /^model\.bim$/i.test(entry.name))) {
        files.push(full);
      }
    }
  }
  return { files: files.sort(), reportFolders: reportFolders.sort() };
}

/** All files under a folder, as paths relative to it. */
function filesUnder(folder: string): string[] {
  const found: string[] = [];
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) found.push(relative(folder, full));
    }
  }
  return found.sort();
}

export function assessMigrationFolder(inputPath: string, options: { cwd?: string; now?: Date } = {}): MigrationAssessment {
  const cwd = options.cwd ?? process.cwd();
  const root = resolve(cwd, inputPath);
  if (!existsSync(root)) throw new Error(`There is nothing at ${inputPath}.`);
  const shown = (absolute: string) => {
    const rel = relative(cwd, absolute).replaceAll('\\', '/');
    return rel && !rel.startsWith('..') ? rel : absolute.replaceAll('\\', '/');
  };
  // A PBIP project file stands for its model and report folders beside it.
  const pbip = /\.pbip$/i.test(root) ? root.slice(0, -5) : null;
  const fileAllowed = pbip ? (file: string) => file.startsWith(`${pbip}.SemanticModel${sep}`) || file.startsWith(`${pbip}.Report${sep}`) : undefined;
  const planInput = pbip ? dirname(root) : root;
  const found = pbip
    ? walk(dirname(root))
    : statSync(root).isDirectory()
      ? (/\.Report$/i.test(root) ? { files: [], reportFolders: [root] } : walk(root))
      : { files: [root], reportFolders: [] };
  const files = fileAllowed ? found.files.filter(fileAllowed) : found.files;
  const reportFolders = pbip ? found.reportFolders.filter((folder) => folder === `${pbip}.Report`) : found.reportFolders;

  const assessed = new Map<string, AssessedFile>();
  const fileEntry = (path: string, tool: AssessedTool): AssessedFile => {
    const existing = assessed.get(path);
    if (existing) return existing;
    const created: AssessedFile = { path, tool, queries: 0, calculations: 0, pages: [], dataSources: [] };
    assessed.set(path, created);
    return created;
  };
  const calculations: AssessedCalculation[] = [];
  const leftOut: SkippedSqlStatement[] = [];
  const unclassified: Parameters<typeof classifyCalculations>[0] = [];
  const models: BiCalculationModel[] = [];
  let tablesWithoutSql = 0;
  const take = (path: string, tool: AssessedTool, extracted: ExtractedBiFile) => {
    leftOut.push(...extracted.skipped.filter((item) => item.kind === 'unreadable'));
    // A file ZLens could not read is listed as not read, not counted as read.
    if (!extracted.inventory) return;
    const entry = fileEntry(path, tool);
    tablesWithoutSql += extracted.inventory.tablesWithoutSql ?? 0;
    entry.calculations += extracted.inventory.calculations.length;
    entry.pages.push(...extracted.inventory.pages);
    entry.dataSources.push(...extracted.inventory.dataSources);
    unclassified.push(...extracted.inventory.calculations);
    models.push(...(extracted.models ?? []));
  };

  // Tableau and Power BI files, one at a time; a PBIP model's TMDL files as one model.
  const tmdlFolders = new Map<string, string[]>();
  for (const file of files) {
    const path = shown(file);
    if (/\.sql$/i.test(file)) {
      fileEntry(path, 'sql');
    } else if (/\.tmdl$/i.test(file)) {
      const folder = tmdlDefinitionFolder(file);
      tmdlFolders.set(folder, [...(tmdlFolders.get(folder) ?? []), file]);
    } else {
      const tool: AssessedTool = /\.twbx?$/i.test(file) ? 'tableau' : 'powerbi';
      try {
        take(path, tool, readBiFile(readFileSync(file), path));
      } catch (error) {
        take(path, tool, unreadableBiFile(path, error));
      }
    }
  }
  for (const [folder, folderFiles] of tmdlFolders) {
    const modelFiles = folderFiles.filter((file) => file.includes(`${sep}tables${sep}`) || /^(?:expressions|model)\.tmdl$/i.test(basename(file)) || folderFiles.length === 1);
    if (!modelFiles.length) continue;
    const path = shown(folder);
    try {
      take(path, 'powerbi', readTmdlFolder(modelFiles.map((file) => ({ absolutePath: file, displayPath: shown(file) })), path));
    } catch (error) {
      take(path, 'powerbi', unreadableBiFile(path, error));
    }
  }
  // PBIP reports: pages and visuals (PBIR), or the older single report.json.
  for (const folder of reportFolders) {
    const path = shown(folder);
    try {
      const legacy = join(folder, 'report.json');
      const pages = existsSync(legacy)
        ? readPowerBiReportLayout(readFileSync(legacy, 'utf8'))
        : readPowerBiReportDefinition(filesUnder(folder).filter((file) => /\.json$/i.test(file)).map((file) => ({ path: file, text: readFileSync(join(folder, file), 'utf8') })));
      fileEntry(path, 'powerbi').pages.push(...pages);
    } catch (error) {
      leftOut.push({ sourcePath: path, kind: 'unreadable', reason: `ZLens could not read this report: ${error instanceof Error ? error.message : String(error)}`, sql: basename(folder) });
    }
  }
  // The import's own converter, run without a database: what becomes a metric draft, and why the rest does not.
  const converted = convertCalculationsToMetricDrafts(unclassified, models, { domain: 'imported', importedAt: (options.now ?? new Date()).toISOString() });
  calculations.push(...converted.conversions.map((conversion): AssessedCalculation => ({
    ...conversion.calculation,
    asMetric: conversion.outcome === 'reused' ? 'drafted' : conversion.outcome,
    ...(conversion.inWords ? { metricInWords: conversion.inWords } : {}),
    ...(conversion.outcome === 'left-out' && conversion.reason ? { metricReason: conversion.reason } : {}),
  })));

  // The import's own plan: the drafts it would make, duplicates folded.
  let plan: ReturnType<typeof planBlockStudioImport> | null = null;
  try {
    plan = planBlockStudioImport(cwd, { sourceKind: 'raw-sql', inputPath: planInput, domain: 'imported', owner: '', ...(fileAllowed ? { fileAllowed } : {}) });
  } catch (error) {
    // No SQL anywhere (only .pbix files, or no files) means no drafts; anything else is said.
    const message = error instanceof Error ? error.message : String(error);
    if (!/^(?:No SQL|Nothing to import)/.test(message)) {
      leftOut.push({ sourcePath: shown(root), kind: 'unreadable', reason: `The queries could not be counted: ${message}`, sql: basename(root) });
    }
  }
  // A query's source is its file, then `#` and where in the file: the longest file path that starts it.
  const knownPaths = () => Array.from(assessed.keys()).sort((a, b) => b.length - a.length);
  for (const candidate of plan?.candidates ?? []) {
    const path = knownPaths().find((known) => candidate.sourcePath === known || candidate.sourcePath.startsWith(`${known}#`)) ?? candidate.sourcePath.split('#')[0]!;
    const entry = assessed.get(path) ?? fileEntry(path, /\.twbx?$/i.test(path) ? 'tableau' : /\.sql$/i.test(path) ? 'sql' : 'powerbi');
    entry.queries += 1;
  }
  const skipped = plan?.skippedStatements ?? [];

  const databases = new Map<string, Set<string>>();
  for (const entry of assessed.values()) {
    for (const source of entry.dataSources) {
      const database = source.database ?? 'Not stated in the file';
      databases.set(database, (databases.get(database) ?? new Set()).add(entry.path));
    }
  }

  return {
    input: shown(root),
    readAt: (options.now ?? new Date()).toISOString(),
    zlensVersion: cliVersion(),
    files: Array.from(assessed.values()).sort((a, b) => a.path.localeCompare(b.path)),
    queries: {
      drafts: plan?.candidates.length ?? 0,
      withParameters: (plan?.candidates ?? []).filter((candidate) => (candidate.parameterDecisions?.length ?? 0) > 0).length,
      duplicates: skipped.filter((item) => item.kind === 'duplicate').length,
      writes: skipped.filter((item) => item.kind === 'writes').length,
    },
    tablesWithoutSql,
    calculations,
    databases: Array.from(databases.entries())
      .map(([database, paths]) => ({ database, files: paths.size, ...connects(database) }))
      .sort((a, b) => b.files - a.files || a.database.localeCompare(b.database)),
    leftOut: [...leftOut, ...skipped.filter((item) => item.kind === 'unreadable' && !leftOut.some((seen) => seen.sourcePath === item.sourcePath))],
  };
}

function connects(database: string): { connects: 'yes' | 'no' | 'check'; note: string } {
  if (CONNECTS[database]) return { connects: 'yes', note: `ZLens connects to ${CONNECTS[database]}.` };
  if (CHECK[database]) return { connects: 'check', note: CHECK[database]! };
  if (/^(?:Excel|Excel\.Workbook|Web\.Contents|SharePoint|OData|Salesforce|Json\.Document|Xml\.Tables|Folder|File\.Contents)/i.test(database)) {
    return { connects: 'no', note: 'Not a database: load it into your warehouse first, or export it to CSV for a Local files connection.' };
  }
  return { connects: 'no', note: 'ZLens has no connector for it yet.' };
}

// ── Reporting ───────────────────────────────────────────────────────────────

const KINDS: CalculationKind[] = ['simple', 'filtered', 'ratio', 'row-level', 'advanced'];

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

function toolCounts(files: AssessedFile[]): string {
  const counts = countBy(files, (file) => file.tool);
  return [
    counts.get('tableau') ? plural(counts.get('tableau')!, 'Tableau workbook') : '',
    counts.get('powerbi') ? plural(counts.get('powerbi')!, 'Power BI file') : '',
    counts.get('sql') ? plural(counts.get('sql')!, 'SQL file') : '',
  ].filter(Boolean).join(', ') || 'none';
}

function reportCounts(files: AssessedFile[]): { worksheets: number; dashboards: number; pages: number; visuals: Map<string, number> } {
  const pages = files.flatMap((file) => file.pages);
  return {
    worksheets: pages.filter((page) => page.kind === 'worksheet').length,
    dashboards: pages.filter((page) => page.kind === 'dashboard').length,
    pages: pages.filter((page) => page.kind === 'page').length,
    visuals: countBy(pages.flatMap((page) => page.visuals), (visual) => visual),
  };
}

function reportPhrase(files: AssessedFile[]): string {
  const counts = reportCounts(files);
  const pageVisuals = files.flatMap((file) => file.pages).filter((page) => page.kind === 'page').reduce((sum, page) => sum + page.visuals.length, 0);
  const parts = [
    counts.worksheets ? plural(counts.worksheets, 'worksheet') : '',
    counts.dashboards ? plural(counts.dashboards, 'dashboard') : '',
    counts.pages ? `${plural(counts.pages, 'report page')} with ${plural(pageVisuals, 'visual')}` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'none';
}

function calculationPhrase(calculations: AssessedCalculation[]): string {
  const counts = countBy(calculations, (calculation) => calculation.kind);
  const drafted = calculations.filter((calculation) => calculation.asMetric === 'drafted').length;
  const leftOut = calculations.filter((calculation) => calculation.asMetric === 'left-out').length;
  return [
    drafted ? `${drafted.toLocaleString('en-US')} become metric drafts` : '',
    leftOut ? `${leftOut.toLocaleString('en-US')} simple, filtered or ratio that cannot yet, with why in the report` : '',
    counts.get('row-level') ? `${counts.get('row-level')!.toLocaleString('en-US')} row-level: a column or dimension` : '',
    counts.get('advanced') ? `${counts.get('advanced')!.toLocaleString('en-US')} advanced: rewrite by hand or with a coding agent` : '',
  ].filter(Boolean).join('; ');
}

/** The terminal summary. */
export function migrationAssessmentSummary(assessment: MigrationAssessment, reportPath: string | null): string[] {
  const { queries } = assessment;
  const lines = [
    '',
    '  ZLens migration assessment',
    '  ──────────────────────────',
    `  Read:          ${assessment.input} (${toolCounts(assessment.files)})`,
    `  Queries:       ${queries.drafts === 1 ? '1 query becomes a draft saved query' : `${plural(queries.drafts, 'query', 'queries')} become draft saved queries`} with zlens import sql${queries.withParameters ? ` (${queries.withParameters} with report parameters)` : ''}`,
  ];
  if (assessment.tablesWithoutSql) lines.push(`  Tables:        ${plural(assessment.tablesWithoutSql, 'table')} loaded without SQL: ZLens reads them from the database`);
  lines.push(`  Calculations:  ${assessment.calculations.length.toLocaleString('en-US')}${assessment.calculations.length ? ` (${calculationPhrase(assessment.calculations)})` : ''}`);
  lines.push(`  Report:        ${reportPhrase(assessment.files)}`);
  if (assessment.databases.length) lines.push(`  Databases:     ${assessment.databases.map((db) => `${db.database}${db.connects === 'yes' ? '' : db.connects === 'check' ? ' (check)' : ' (no connector)'}`).join(', ')}`);
  if (assessment.leftOut.length) lines.push(`  Not read:      ${plural(assessment.leftOut.length, 'file')}: ${assessment.leftOut.slice(0, 3).map((item) => item.sourcePath).join(', ')}${assessment.leftOut.length > 3 ? ', …' : ''}`);
  lines.push('');
  lines.push('  Nothing ran against a database and nothing left this computer.');
  if (reportPath) lines.push(`  Full report:   ${reportPath}`);
  lines.push('');
  return lines;
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const shortened = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return `\`${cell(shortened).replace(/`/g, "'")}\``;
};

/** The full report, as Markdown to keep or share. */
export function migrationAssessmentMarkdown(assessment: MigrationAssessment): string {
  const { queries, files } = assessment;
  const report = reportCounts(files);
  const out: string[] = [];
  const date = assessment.readAt.slice(0, 10);
  out.push('# Migration assessment', '');
  out.push(`Read from \`${assessment.input}\` on ${date} by ZLens ${assessment.zlensVersion} (\`zlens migrate assess\`). It read files only: nothing ran against a database, no AI was asked, and nothing left this computer.`, '');

  out.push('## Summary', '');
  out.push('| | Found | How it comes to ZLens |', '|---|---|---|');
  out.push(`| Files | ${files.length}: ${toolCounts(files)} | |`);
  out.push(`| Queries (Custom SQL, native SQL, scripts) | ${queries.drafts} | \`zlens import sql\` makes a draft saved query of each; certify the ones that run.${queries.withParameters ? ` ${queries.withParameters} take report parameters, which become saved query parameters.` : ''}${queries.duplicates ? ` ${plural(queries.duplicates, 'copy', 'copies')} of the same query ${queries.duplicates === 1 ? 'is' : 'are'} counted once.` : ''}${queries.writes ? ` ${plural(queries.writes, 'statement')} that change${queries.writes === 1 ? 's' : ''} data ${queries.writes === 1 ? 'is' : 'are'} left out.` : ''} |`);
  if (assessment.tablesWithoutSql) out.push(`| Tables loaded without SQL | ${assessment.tablesWithoutSql} | ZLens reads these tables from the database directly; there is nothing to import. |`);
  const kinds = countBy(assessment.calculations, (calculation) => calculation.kind);
  const drafted = assessment.calculations.filter((calculation) => calculation.asMetric === 'drafted').length;
  const leftOut = assessment.calculations.filter((calculation) => calculation.asMetric === 'left-out').length;
  out.push(`| Calculations | ${assessment.calculations.length} | ${KINDS.filter((kind) => kinds.get(kind)).map((kind) => `${CALCULATION_KIND_LABELS[kind].split(':')[0]} ${kinds.get(kind)}`).join(', ') || 'none'}. ${drafted ? `${drafted} become metric drafts with \`zlens import sql\`, placed on the table and column they read; a person approves each. ` : ''}${leftOut ? `${leftOut} simple, filtered or ratio ${leftOut === 1 ? 'calculation cannot' : 'calculations cannot'} yet, with why below. ` : ''}Row-level ones are a column or dimension; advanced ones are rewritten by hand or with a coding agent. |`);
  out.push(`| Report | ${reportPhrase(files)} | Rebuilt as App tiles, each with its trust label. |`);
  if (assessment.databases.length) out.push(`| Databases | ${assessment.databases.map((db) => db.database).join(', ')} | ${assessment.databases.every((db) => db.connects === 'yes') ? 'ZLens connects to all of them.' : 'See Databases below.'} |`);
  out.push('');

  out.push('## Next steps', '');
  out.push('1. In a ZLens project connected to the database these reports read (`npx zlens notebook <folder>`), import the queries:', '');
  out.push('   ```bash', `   npx zlens import sql ${assessment.input.includes(' ') ? JSON.stringify(assessment.input) : assessment.input}`, '   ```', '');
  out.push('   Each query becomes a draft saved query and runs once, so the list says which work.', '');
  out.push('2. Certify the ones that ran, each with its own receipt:', '');
  out.push('   ```bash', '   npx zlens certify --from-import --apply', '   ```', '');
  if (assessment.calculations.length) out.push(`3. ${drafted ? 'Approve the metric drafts the import made from the calculations (`npx zlens semantic drafts`, then `npx zlens semantic approve <name>`), checking each value against the old report. ' : ''}Rebuild the rest your reports need: row-level ones as columns of a saved query, and the ones listed below with why.`, '');
  if (report.worksheets || report.pages) out.push(`${assessment.calculations.length ? 4 : 3}. Rebuild the dashboards as Apps from the certified saved queries.`, '');

  if (assessment.databases.length) {
    out.push('## Databases', '');
    out.push('| Database | Files | ZLens | Note |', '|---|---:|---|---|');
    for (const db of assessment.databases) out.push(`| ${cell(db.database)} | ${db.files} | ${db.connects === 'yes' ? 'Connects' : db.connects === 'check' ? 'Check' : 'No connector'} | ${cell(db.note)} |`);
    out.push('');
  }

  if (assessment.calculations.length) {
    out.push('## Calculations', '');
    out.push('Sorted by reading each formula, then translated the way `zlens import sql` does; nothing was run. A metric draft is written only when the connected database has its table and columns.', '');
    const from = (item: AssessedCalculation) => cell(`${item.sourcePath}${item.owner ? ` · ${item.owner}` : ''}`);
    const draftedItems = assessment.calculations.filter((item) => item.asMetric === 'drafted');
    if (draftedItems.length) {
      out.push(`### Become metric drafts (${draftedItems.length})`, '');
      out.push('| Name | As a metric | Formula | From |', '|---|---|---|---|');
      for (const item of draftedItems) out.push(`| ${cell(item.name)} | ${code(item.metricInWords ?? '')} | ${code(formulaWithoutComments(item.formula, item.language))} | ${from(item)} |`);
      out.push('');
    }
    const leftOutItems = assessment.calculations.filter((item) => item.asMetric === 'left-out');
    if (leftOutItems.length) {
      out.push(`### Simple, filtered or ratio, but not a metric yet (${leftOutItems.length})`, '');
      out.push('| Name | Why | Formula | From |', '|---|---|---|---|');
      for (const item of leftOutItems) out.push(`| ${cell(item.name)} | ${cell(item.metricReason ?? '')} | ${code(formulaWithoutComments(item.formula, item.language))} | ${from(item)} |`);
      out.push('');
    }
    for (const kind of ['row-level', 'advanced'] as const) {
      const items = assessment.calculations.filter((calculation) => calculation.asMetric === kind);
      if (!items.length) continue;
      out.push(`### ${CALCULATION_KIND_LABELS[kind]} (${items.length})`, '');
      if (kind === 'advanced') {
        out.push('| Name | Why | Formula | From |', '|---|---|---|---|');
        for (const item of items) out.push(`| ${cell(item.name)} | ${cell(item.reason)} | ${code(formulaWithoutComments(item.formula, item.language))} | ${from(item)} |`);
      } else {
        out.push('| Name | Formula | From |', '|---|---|---|');
        for (const item of items) out.push(`| ${cell(item.name)} | ${code(formulaWithoutComments(item.formula, item.language))} | ${from(item)} |`);
      }
      out.push('');
    }
  }

  out.push('## Files', '');
  out.push('| File | Tool | Queries | Calculations | Report | Data sources |', '|---|---|---:|---:|---|---|');
  const toolName: Record<AssessedTool, string> = { tableau: 'Tableau', powerbi: 'Power BI', sql: 'SQL' };
  for (const file of files) {
    const sheets = file.pages.filter((page) => page.kind === 'worksheet').length;
    const dashboards = file.pages.filter((page) => page.kind === 'dashboard').length;
    const pages = file.pages.filter((page) => page.kind === 'page');
    const reportCell = [
      sheets ? plural(sheets, 'worksheet') : '',
      dashboards ? plural(dashboards, 'dashboard') : '',
      pages.length ? `${plural(pages.length, 'page')}, ${plural(pages.reduce((sum, page) => sum + page.visuals.length, 0), 'visual')}` : '',
    ].filter(Boolean).join(', ');
    const sources = Array.from(new Set(file.dataSources.map((source) => source.database ?? 'not stated'))).join(', ');
    out.push(`| ${cell(file.path)} | ${toolName[file.tool]} | ${file.queries} | ${file.calculations} | ${cell(reportCell)} | ${cell(sources)} |`);
  }
  out.push('');

  if (report.visuals.size) {
    out.push('## Charts', '');
    out.push('| Chart type | Count |', '|---|---:|');
    for (const [visual, count] of [...report.visuals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out.push(`| ${cell(visual)} | ${count} |`);
    out.push('');
  }

  if (assessment.leftOut.length) {
    out.push('## Not read', '');
    out.push('| File | Why |', '|---|---|');
    for (const item of assessment.leftOut) out.push(`| ${cell(item.sourcePath)} | ${cell(item.reason)} |`);
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The report's default file name, beside where the command runs. */
export const DEFAULT_ASSESSMENT_FILE = 'zlens-migration-assessment.md';

export function isAssessableInput(path: string): boolean {
  return existsSync(path) && (statSync(path).isDirectory() || BI_FILE.test(path) || /\.(?:sql|tmdl|pbip)$/i.test(path) || /^model\.bim$/i.test(basename(path)));
}
