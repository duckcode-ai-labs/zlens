import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { CLIFlags } from '../args.js';
import { withImportRuntime, type ImportRuntimeCall } from '../import-runtime.js';
import { keyWords, type Verdict } from '../report-match/compare.js';
import { DEFAULT_MATCH_REPORT, matchReportMarkdown, verdictWords } from '../report-match/record.js';
import type { CompareOutcome } from '../report-match/run.js';

/**
 * `zlens migrate compare <file|folder>`: an old report's export against
 * ZLens's own table, through the runtime that holds the connection. It exits 0
 * when everything matches, 1 when something differs, 2 when something is not
 * proven, so a script or a coding agent can read the result.
 */

const EXPORT_FILE = /\.(?:csv|tsv|txt|xlsx)$/i;

/** One export's options, from flags or a folder's `exports.yaml`. */
interface ExportOptions {
  worksheet?: string;
  report?: string;
  query?: string;
  filters?: string[];
  waive?: string[];
  map?: Record<string, string>;
  keys?: string[];
  ignore?: string[];
  fileRows?: boolean;
  tolerance?: string;
  dates?: string;
  parameters?: Record<string, string>;
}

function pairs(list: string[] | undefined): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  return Object.fromEntries(list.map((item) => {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`"${item}" needs the form name=value.`);
    return [item.slice(0, at).trim(), item.slice(at + 1).trim()];
  }));
}

function optionsFromFlags(flags: CLIFlags): ExportOptions {
  const map = pairs(flags.compareMap);
  const parameters = pairs(flags.compareParams);
  return {
    ...(flags.worksheet ? { worksheet: flags.worksheet } : {}),
    ...(flags.report ? { report: flags.report } : {}),
    ...(flags.query ? { query: flags.query } : {}),
    ...(flags.compareFilters ? { filters: flags.compareFilters } : {}),
    ...(flags.waive ? { waive: flags.waive } : {}),
    ...(map ? { map } : {}),
    ...(flags.compareKeys ? { keys: flags.compareKeys } : {}),
    ...(flags.compareIgnore ? { ignore: flags.compareIgnore } : {}),
    ...(flags.fileRows ? { fileRows: true } : {}),
    ...(flags.tolerance ? { tolerance: flags.tolerance } : {}),
    ...(flags.dates ? { dates: flags.dates } : {}),
    ...(parameters ? { parameters } : {}),
  };
}

/** A folder's exports, each with what `exports.yaml` says about it. */
function exportsIn(folder: string, shared: ExportOptions): Array<{ path: string; options: ExportOptions }> {
  const listed = join(folder, 'exports.yaml');
  const named = existsSync(listed) ? (yaml.load(readFileSync(listed, 'utf-8')) as Record<string, ExportOptions> | null) ?? {} : {};
  return readdirSync(folder)
    .filter((entry) => EXPORT_FILE.test(entry) && statSync(join(folder, entry)).isFile())
    .sort()
    .map((entry) => ({ path: join(folder, entry), options: { ...shared, ...(named[entry] ?? {}) } }));
}

async function compareOne(call: ImportRuntimeCall, body: Record<string, unknown>, flags: CLIFlags): Promise<{ outcome?: CompareOutcome; stopped?: string; recorded: string[] }> {
  const response = await call('POST', '/api/report-match/compare', body);
  if (response.status === 422) return { stopped: String(response.body?.error), recorded: [] };
  if (response.status !== 200) throw new Error(String(response.body?.error ?? `HTTP ${response.status}`));
  const outcome = response.body.comparison as CompareOutcome;
  let recorded: string[] = [];
  if (flags.record !== false) {
    const saved = await call('POST', '/api/report-match/record', { id: outcome.id, via: 'cli' });
    if (saved.status === 200) recorded = saved.body.recorded as string[];
    else console.error(`  The comparison was not recorded: ${String(saved.body?.error ?? `HTTP ${saved.status}`)}`);
  }
  return { outcome, recorded };
}

export async function runMigrateCompare(input: string | undefined, flags: CLIFlags): Promise<void> {
  const cwd = process.cwd();
  const typed = flags.metric !== undefined && flags.value !== undefined;
  if (!input && !typed) {
    console.error('\n  ✗ Name an export to compare.');
    console.error('    Usage: zlens migrate compare <file-or-folder> [--worksheet <name>] [--filter "field >= value"] [--waive "Field: reason"]');
    console.error('           zlens migrate compare --metric <name> --value <number>');
    console.error('');
    process.exit(1);
  }
  const shared = optionsFromFlags(flags);
  const target = input ? resolve(cwd, input) : '';
  if (input && !existsSync(target)) {
    console.error(`\n  ✗ There is nothing at ${input}.\n`);
    process.exit(1);
  }
  const isFolder = Boolean(input) && statSync(target).isDirectory();
  const work = typed ? [] : isFolder ? exportsIn(target, shared) : [{ path: target, options: shared }];
  if (!typed && !work.length) {
    console.error(`\n  ✗ ${input} has no .csv or .tsv files.\n`);
    process.exit(1);
  }

  const outcomes: CompareOutcome[] = [];
  const stopped: Array<{ file: string; reason: string }> = [];
  const recordedBy = new Map<string, string[]>();
  await withImportRuntime(cwd, flags, async (call) => {
    if (typed) {
      const result = await compareOne(call, { metric: flags.metric, value: flags.value, ...shared }, flags);
      if (result.stopped) stopped.push({ file: flags.metric!, reason: result.stopped });
      if (result.outcome) {
        outcomes.push(result.outcome);
        recordedBy.set(result.outcome.id, result.recorded);
      }
      return;
    }
    for (const item of work) {
      const result = await compareOne(call, { file: { name: basename(item.path), base64: readFileSync(item.path).toString('base64') }, ...item.options }, flags);
      if (result.stopped) stopped.push({ file: basename(item.path), reason: result.stopped });
      if (result.outcome) {
        outcomes.push(result.outcome);
        recordedBy.set(result.outcome.id, result.recorded);
      }
    }
  });

  const verdicts = outcomes.map((outcome) => outcome.comparison.verdict);
  const code = verdicts.includes('differs') ? 1 : stopped.length || verdicts.includes('not-proven') ? 2 : 0;
  if (flags.format === 'json') {
    console.log(JSON.stringify({ comparisons: outcomes, stopped }, null, 2));
    process.exitCode = code;
    return;
  }
  for (const outcome of outcomes) printOutcome(outcome, recordedBy.get(outcome.id) ?? []);
  for (const item of stopped) console.log(`\n  ${item.file}: could not be compared.\n    ${item.reason}`);
  console.log('');
  if (work.length > 1) {
    const count = (verdict: Verdict) => verdicts.filter((value) => value === verdict).length;
    console.log(`  ${count('matches')} of ${work.length} exports match; ${count('differs')} ${count('differs') === 1 ? 'differs' : 'differ'}; ${count('not-proven')} not proven${stopped.length ? `; ${stopped.length} could not be compared` : ''}.`);
  }
  if (isFolder || flags.outDir) {
    const out = resolve(cwd, flags.outDir || DEFAULT_MATCH_REPORT);
    writeFileSync(out, matchReportMarkdown(outcomes, stopped, new Date().toISOString()), 'utf-8');
    console.log(`  Report: ${out}`);
  }
  console.log('');
  process.exitCode = code;
}

function printOutcome(outcome: CompareOutcome, recorded: string[]): void {
  const { comparison, file, mapping } = outcome;
  const { rows, values } = comparison;
  console.log(`\n  ${file.name}: ${rows.inFile} row${rows.inFile === 1 ? '' : 's'}${rows.totalsSetAside ? `, ${rows.totalsSetAside} total row${rows.totalsSetAside === 1 ? '' : 's'} set aside` : ''}${rows.emptySetAside ? `, ${rows.emptySetAside} empty row${rows.emptySetAside === 1 ? '' : 's'} set aside` : ''}`);
  console.log('');
  const width = Math.min(28, Math.max(...Object.keys(mapping).map((header) => header.length)));
  for (const [header, target] of Object.entries(mapping)) {
    const number = comparison.numbers.find((item) => item.column === header);
    console.log(`    ${header.padEnd(width)}  ${target}${number ? `, at ${number.precision}${number.percentPoints ? ', read as percent points' : ''}` : ''}`);
  }
  console.log('');
  const filters = outcome.filters.stated.length ? `, with ${outcome.filters.stated.join(' and ')}` : '';
  console.log(`  ${verdictWords(comparison.verdict)}: ${rows.inBoth} of ${rows.inFile} rows, ${values.equal} of ${values.compared} values${filters}${outcome.scope === 'all rows' ? '' : `, on ${outcome.scope}`}.`);
  for (const coarse of comparison.numbers.filter((number) => number.coarse)) console.log(`    ${coarse.column} was compared only to ${coarse.precision}.`);
  for (const missing of comparison.missing) console.log(`    ${missing}`);
  const shown = comparison.differences.slice(0, 8);
  if (shown.length) console.log('');
  for (const item of shown) console.log(`    ${keyWords(item.key)}  ${item.column}  old report ${item.old || '(empty)'}  ZLens ${item.zlens ?? '(empty)'}${item.kind === 'empty-vs-zero' ? '  (empty against 0)' : ''}`);
  if (comparison.differences.length > shown.length) console.log(`    …and ${comparison.differences.length - shown.length} more.`);
  if (comparison.onlyInFile.length) console.log(`    Only in the export: ${comparison.onlyInFile.slice(0, 6).map(keyWords).join(', ')}${comparison.onlyInFile.length > 6 ? ', …' : ''}`);
  if (comparison.onlyInZLens.length) console.log(`    Only in ZLens: ${comparison.onlyInZLens.slice(0, 6).map(keyWords).join(', ')}${comparison.onlyInZLens.length > 6 ? ', …' : ''}`);
  if (comparison.reasons.length) {
    console.log('');
    console.log('  Possible reasons:');
    for (const reason of comparison.reasons) console.log(`    ${reason}`);
  }
  for (const note of comparison.notes) console.log(`  Note: ${note}`);
  if (outcome.filters.seen.length && comparison.verdict !== 'matches') {
    console.log('');
    console.log('  Filters ZLens can see, as saved (they may have been changed before exporting):');
    for (const filter of outcome.filters.seen) console.log(`    ${filter}`);
    console.log('  State each: --filter "field >= value"   Or waive it: --waive "Field: reason"');
  }
  if (recorded.length) console.log(`  Recorded in ${recorded.join(', ')}`);
}
