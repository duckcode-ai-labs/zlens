import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import {
  canonicalize,
  canonicalizeNotebook,
  loadDomainPackageRegistry,
  NodeKind,
  Parser,
  blockParameterDefinitions,
  applyDataLexMigration,
  resolveBlockParameterValues,
  planDataLexMigration,
  resolveDbtManifestPath,
} from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { runImport } from './import.js';
import { assessMigrationFolder, DEFAULT_ASSESSMENT_FILE, isAssessableInput, migrationAssessmentMarkdown, migrationAssessmentSummary } from '../migrate-assess.js';

export type MigrationSource = 'looker' | 'tableau' | 'powerbi' | 'dbt' | 'metabase' | 'raw-sql';

export interface MigrationResult {
  source: MigrationSource;
  blocksGenerated: number;
  metricsGenerated: number;
  dimensionsGenerated: number;
  needsReview: number;
}

/**
 * Generate a DQL block skeleton from a source tool definition.
 */
function generateBlockDQL(opts: {
  name: string;
  domain: string;
  description: string;
  sql: string;
  owner: string;
  tags: string[];
  chart: string;
}): string {
  const tagStr = opts.tags.map((t) => `"${t}"`).join(', ');
  return `block "${opts.name}" {
    domain = "${opts.domain}"
    type = "custom"
    description = "${opts.description}"
    tags = [${tagStr}]
    owner = "${opts.owner}"

    query = """
        ${opts.sql.split('\n').join('\n        ')}
    """

    visualization {
        chart = "${opts.chart}"
        x = dimension
        y = measure
    }

    tests {
        assert row_count > 0
    }
}
`;
}

export async function runMigrate(file: string, flags: CLIFlags, rest: string[] = []): Promise<void> {
  if (file === 'assess') {
    await runMigrateAssess(rest[0] || flags.input, flags);
    return;
  }
  if (file === 'format') {
    await runFormatMigrate(flags.input || '.', flags);
    return;
  }
  if (file === 'layout') {
    await runLayoutMigrate(flags);
    return;
  }
  if (file === 'parameters') {
    await runParameterMigrateCheck(flags);
    return;
  }
  if (file === 'datalex') {
    await runDataLexManifestMigration(flags);
    return;
  }
  if (file === 'modeling') {
    await runModelingMigration(flags);
    return;
  }
  // file is used as the source type for migration
  const source = file as MigrationSource;
  const validSources: MigrationSource[] = ['looker', 'tableau', 'powerbi', 'dbt', 'metabase', 'raw-sql'];

  if (!validSources.includes(source)) {
    console.error(`\n  ✗ Unknown migration source: "${source}"`);
    console.error(`    Valid sources: ${validSources.join(', ')}`);
    console.error(`    Or: "assess <folder>" to see what moves from a folder of Tableau, Power BI and SQL files`);
    console.error(`    Or: "format" to upgrade .dql/.dqlnb files to the canonical on-disk format`);
    console.error(`    Or: "layout --to domain-first --dry-run" to preview enterprise domain layout moves`);
    console.error(`    Or: "parameters --check" to audit legacy block parameter contracts`);
    console.error(`    Or: "datalex --input <datalex-manifest.json> [--apply]" for a dbt-first DQL v3 migration`);
    console.error(`    Or: "modeling --to dbt-first --dry-run|--apply" for explicit DQL 2.0 adoption`);
    console.error('');
    process.exit(1);
  }

  // SQL files, Tableau workbooks and Power BI files are read by the import.
  const imported = source === 'raw-sql' || source === 'tableau' || source === 'powerbi';
  if (imported && flags.input) {
    await runImport('sql', [flags.input], flags);
    return;
  }

  const guidance = MIGRATION_GUIDANCE[source];
  if (flags.format === 'json') {
    console.log(JSON.stringify({
      source,
      status: imported ? 'use-import' : 'not-built',
      reads: guidance.reads,
      next: guidance.next,
      ...(imported ? {} : {
        exampleBlock: generateBlockDQL({
          name: `migrated-from-${source}`,
          domain: 'migrated',
          description: `Migrated from ${source}`,
          sql: 'SELECT dimension, SUM(measure) AS measure\nFROM source_table\nGROUP BY dimension',
          owner: 'migration-bot',
          tags: ['migrated', source],
          chart: 'bar',
        }),
      }),
    }, null, 2));
    return;
  }

  console.log(`\n  ZLens Migration: ${source}`);
  console.log('  ─────────────────────────────');
  console.log(`  ${guidance.reads}`);
  console.log('');
  console.log('  Next steps:');
  guidance.next.forEach((step, index) => console.log(`    ${index + 1}. ${step}`));
  console.log('');
}

/**
 * `zlens migrate assess <folder>`: what moves from a folder of Tableau, Power
 * BI and SQL files. Prints a summary and writes the full report as Markdown
 * (`--out`, default zlens-migration-assessment.md here); `--format json`
 * prints the assessment and writes nothing.
 */
async function runMigrateAssess(input: string | undefined, flags: CLIFlags): Promise<void> {
  if (!input) {
    console.error('\n  ✗ Which folder? Usage: zlens migrate assess <folder> [--out <file.md>] [--format json]\n');
    process.exitCode = 1;
    return;
  }
  if (!isAssessableInput(resolve(input))) {
    console.error(`\n  ✗ ${input} is not a folder, or a Tableau, Power BI or SQL file.\n`);
    process.exitCode = 1;
    return;
  }
  const assessment = assessMigrationFolder(input);
  if (flags.format === 'json') {
    console.log(JSON.stringify(assessment, null, 2));
    return;
  }
  const reportPath = flags.outDir || DEFAULT_ASSESSMENT_FILE;
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), migrationAssessmentMarkdown(assessment));
  for (const line of migrationAssessmentSummary(assessment, reportPath)) console.log(line);
}

/** What each `zlens migrate <tool>` can read today, and what to run. */
const MIGRATION_GUIDANCE: Record<MigrationSource, { reads: string; next: string[] }> = {
  'raw-sql': {
    reads: 'Reads .sql files: one or many queries per file, scripts with temp tables, and report parameters.',
    next: [
      'Import them: zlens migrate raw-sql --input <file or folder> (the same as zlens import sql <path>)',
      'Certify the drafts that pass: zlens certify --from-import --apply',
    ],
  },
  tableau: {
    reads: 'Reads the Custom SQL in Tableau workbooks (.twb, .twbx), with their parameters. Calculated fields are listed, not converted.',
    next: [
      'Import them: zlens migrate tableau --input <workbook or folder> (the same as zlens import sql <path>)',
      'Certify the drafts that pass: zlens certify --from-import --apply',
      'Rebuild the calculated fields your reports need as metrics.',
    ],
  },
  powerbi: {
    reads: 'Reads the native SQL in Power BI templates (.pbit) and projects (PBIP), with their parameters. DAX measures are listed, not converted; export a .pbix as a template first.',
    next: [
      'Import them: zlens migrate powerbi --input <.pbit, project folder or folder> (the same as zlens import sql <path>)',
      'Certify the drafts that pass: zlens certify --from-import --apply',
      'Rebuild the DAX measures your reports need as metrics.',
    ],
  },
  looker: {
    reads: 'Not built yet: ZLens does not read LookML.',
    next: [
      'Export the SQL behind the Looks and explores you keep into .sql files.',
      'Import them: zlens import sql <folder>',
      'Rebuild LookML measures and dimensions as metrics in the semantic layer.',
    ],
  },
  metabase: {
    reads: 'Not built yet: ZLens does not read Metabase exports.',
    next: [
      'Copy the SQL of the questions you keep into .sql files; {{variables}} become saved query parameters.',
      'Import them: zlens import sql <folder>',
    ],
  },
  dbt: {
    reads: 'ZLens reads your dbt project directly; there is nothing to migrate.',
    next: [
      'Point dql.config.json at the dbt project, then draft saved queries from your models: zlens propose',
    ],
  },
};

type ModelingMigrationIssueCode =
  | 'DBT_MANIFEST_MISSING'
  | 'INVALID_SOURCE'
  | 'DOMAIN_UNRESOLVED'
  | 'TARGET_COLLISION'
  | 'IDENTITY_COLLISION'
  | 'AMBIGUOUS_DBT_BINDING';

export interface ModelingMigrationIssue {
  code: ModelingMigrationIssueCode;
  path: string;
  detail: string;
  candidates?: string[];
}

export interface ModelingMigrationLoss {
  code: 'MISSING_DBT_BINDING' | 'YAML_COMMENTS' | 'UNKEYED_MODELING_OBJECT';
  path: string;
  detail: string;
}

export interface ModelingMigrationReport {
  target: 'dbt-first';
  mode: 'dry-run' | 'applied';
  status: 'ready' | 'blocked' | 'noop' | 'applied';
  fingerprint: string;
  configChanges: string[];
  modelingConsolidations: Array<{ domain: string; sources: string[]; target: string }>;
  productMoves: Array<{ kind: 'app' | 'notebook'; domain: string; source: string; target: string }>;
  qualifiedIdentityRewrites: Array<{ domain: string; kind: string; localId: string; qualifiedId: string }>;
  ambiguities: ModelingMigrationIssue[];
  losses: ModelingMigrationLoss[];
  written: string[];
  removed: string[];
}

interface ModelingFileOperation {
  kind: 'file';
  target: string;
  content: string;
}

interface ModelingDirectoryOperation {
  kind: 'directory';
  source: string;
  target: string;
  patches: Array<{ path: string; content: string }>;
}

type ModelingWriteOperation = ModelingFileOperation | ModelingDirectoryOperation;

export interface ModelingMigrationPlan {
  report: ModelingMigrationReport;
  writes: ModelingWriteOperation[];
  deletes: string[];
}

interface DbtBindingIndex {
  uniqueIds: Set<string>;
  aliases: Map<string, string[]>;
}

/** MIG-001/MIG-002: explicit, previewable adoption of the canonical dbt-first layout. */
export async function runModelingMigration(flags: CLIFlags): Promise<void> {
  if (flags.to !== 'dbt-first' || (flags.apply === true && flags.dryRun === true)) {
    throw new Error('Usage: zlens migrate modeling --to dbt-first --dry-run|--apply');
  }
  const projectRoot = findProjectRoot(resolve(flags.input || process.cwd()));
  const plan = planModelingMigration(projectRoot);
  const apply = flags.apply === true;
  let applied: { written: string[]; removed: string[] } | undefined;

  if (apply) {
    if (plan.report.ambiguities.length > 0) {
      plan.report.status = 'blocked';
      process.exitCode = 1;
    } else if (plan.report.status !== 'noop') {
      applied = applyModelingMigration(projectRoot, plan);
      plan.report.mode = 'applied';
      plan.report.status = 'applied';
      plan.report.written = applied.written;
      plan.report.removed = applied.removed;
    } else {
      plan.report.mode = 'applied';
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(plan.report, null, 2));
    return;
  }
  console.log(`\n  DQL modeling migration to dbt-first (${apply ? 'apply' : 'dry run'})`);
  console.log('  ─────────────────────────────');
  console.log(`  Project:       ${projectRoot}`);
  console.log(`  Fingerprint:   ${plan.report.fingerprint}`);
  console.log(`  Status:        ${plan.report.status}`);
  console.log(`  Config:        ${plan.report.configChanges.length}`);
  console.log(`  Models:        ${plan.report.modelingConsolidations.length}`);
  console.log(`  Products:      ${plan.report.productMoves.length}`);
  console.log(`  Ambiguities:   ${plan.report.ambiguities.length}`);
  console.log(`  Explicit loss: ${plan.report.losses.length}`);
  for (const issue of plan.report.ambiguities) console.log(`    ✗ ${issue.code} ${issue.path}: ${issue.detail}`);
  for (const loss of plan.report.losses) console.log(`    ! ${loss.code} ${loss.path}: ${loss.detail}`);
  if (!apply && plan.report.status === 'ready') console.log('  Review this fingerprint, then re-run with --apply.');
  console.log('');
}

/** Build a deterministic plan without writing. Exported for commit-scoped migration tests. */
export function planModelingMigration(projectRootInput: string): ModelingMigrationPlan {
  const projectRoot = resolve(projectRootInput);
  const writes: ModelingWriteOperation[] = [];
  const deletes: string[] = [];
  const report: ModelingMigrationReport = {
    target: 'dbt-first',
    mode: 'dry-run',
    status: 'ready',
    fingerprint: '',
    configChanges: [],
    modelingConsolidations: [],
    productMoves: [],
    qualifiedIdentityRewrites: [],
    ambiguities: [],
    losses: [],
    written: [],
    removed: [],
  };

  const configPath = join(projectRoot, 'dql.config.json');
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
      config = parsed as Record<string, unknown>;
    }
  } catch (error) {
    report.ambiguities.push({ code: 'INVALID_SOURCE', path: 'dql.config.json', detail: errorMessage(error) });
  }
  const nextConfig = structuredClone(config);
  if (nextConfig.manifestVersion !== 3) {
    nextConfig.manifestVersion = 3;
    report.configChanges.push('manifestVersion: 3');
  }
  const existingModeling = jsonRecord(nextConfig.modeling);
  if (nextConfig.modeling !== undefined && (typeof nextConfig.modeling !== 'object' || nextConfig.modeling === null || Array.isArray(nextConfig.modeling))) {
    report.ambiguities.push({
      code: 'INVALID_SOURCE',
      path: 'dql.config.json.modeling',
      detail: 'Existing modeling configuration is not an object and cannot be preserved safely.',
    });
  }
  if (existingModeling.mode !== 'dbt-first') {
    nextConfig.modeling = { ...existingModeling, mode: 'dbt-first' };
    report.configChanges.push('modeling.mode: dbt-first');
  }
  const nextConfigSource = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== nextConfigSource) {
    writes.push({ kind: 'file', target: 'dql.config.json', content: nextConfigSource });
  }

  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
  let dbtIndex: DbtBindingIndex | undefined;
  if (!dbtManifestPath || !existsSync(dbtManifestPath)) {
    report.ambiguities.push({
      code: 'DBT_MANIFEST_MISSING',
      path: 'dql.config.json',
      detail: 'dbt-first migration requires a readable dbt manifest.json; run dbt parse/compile or configure dbt.projectDir.',
    });
  } else {
    try {
      dbtIndex = readDbtBindingIndex(dbtManifestPath);
    } catch (error) {
      report.ambiguities.push({ code: 'INVALID_SOURCE', path: displayPath(projectRoot, dbtManifestPath), detail: errorMessage(error) });
    }
  }

  const registry = loadDomainPackageRegistry(projectRoot);
  for (const diagnostic of registry.diagnostics.filter((item) => item.severity === 'error')) {
    report.ambiguities.push({
      code: 'DOMAIN_UNRESOLVED',
      path: diagnostic.filePath ?? 'domains',
      detail: diagnostic.message,
    });
  }

  for (const pkg of registry.values()) {
    planModelingPackage(projectRoot, pkg.id, pkg.root, dbtIndex, report, writes, deletes);
  }
  planLegacyProducts(projectRoot, registry, report, writes, deletes);

  report.ambiguities.sort(compareIssue);
  report.losses.sort((a, b) => `${a.path}:${a.code}:${a.detail}`.localeCompare(`${b.path}:${b.code}:${b.detail}`));
  report.productMoves.sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`));
  report.modelingConsolidations.sort((a, b) => a.domain.localeCompare(b.domain));
  report.qualifiedIdentityRewrites.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  report.configChanges.sort();
  writes.sort((a, b) => a.target.localeCompare(b.target));
  const uniqueDeletes = [...new Set(deletes)].sort();
  report.fingerprint = fingerprintMigrationState(projectRoot, dbtManifestPath);
  if (report.ambiguities.length > 0) report.status = 'blocked';
  else if (writes.length === 0 && uniqueDeletes.length === 0) report.status = 'noop';
  return { report, writes, deletes: uniqueDeletes };
}

function planModelingPackage(
  projectRoot: string,
  domain: string,
  packageRoot: string,
  dbtIndex: DbtBindingIndex | undefined,
  report: ModelingMigrationReport,
  writes: ModelingWriteOperation[],
  deletes: string[],
): void {
  const modelingDir = join(packageRoot, 'modeling');
  if (!existsSync(modelingDir)) return;
  const sources = readdirSync(modelingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(modelingDir, entry.name))
    .sort();
  if (sources.length === 0) return;
  const targetAbs = join(modelingDir, 'model.dql.yaml');
  const targetRel = slash(relative(projectRoot, targetAbs));
  const merged: Record<string, unknown> = {};
  const identities = new Map<string, unknown>();
  let valid = true;

  for (const sourcePath of sources) {
    const sourceRel = slash(relative(projectRoot, sourcePath));
    let document: Record<string, unknown>;
    const source = readFileSync(sourcePath, 'utf8');
    try {
      const parsed = yaml.load(source);
      if (parsed !== undefined && parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('expected a YAML mapping at the document root');
      }
      document = yamlRecord(parsed);
    } catch (error) {
      report.ambiguities.push({ code: 'INVALID_SOURCE', path: sourceRel, detail: errorMessage(error) });
      valid = false;
      continue;
    }
    if (sourcePath !== targetAbs && /(^|\n)\s*#/.test(source)) {
      report.losses.push({
        code: 'YAML_COMMENTS',
        path: sourceRel,
        detail: 'Comments cannot be represented in the consolidated YAML document; authored values are preserved.',
      });
    }
    for (const [section, rawValue] of Object.entries(document)) {
      if (MODELING_LIST_SECTIONS.has(section) && !Array.isArray(rawValue)) {
        report.ambiguities.push({
          code: 'INVALID_SOURCE',
          path: `${sourceRel}.${section}`,
          detail: `Modeling section "${section}" must be a list; the migration will not guess how object keys map to stable ids.`,
        });
        valid = false;
        continue;
      }
      if (Array.isArray(rawValue)) {
        const destination = Array.isArray(merged[section]) ? merged[section] as unknown[] : [];
        for (const rawItem of rawValue) {
          const item = yamlRecord(rawItem);
          const localId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
          if (!localId) {
            destination.push(rawItem);
            report.losses.push({
              code: 'UNKEYED_MODELING_OBJECT',
              path: `${sourceRel}.${section}`,
              detail: 'Object is preserved but cannot receive a deterministic qualified identity until an id is added.',
            });
            continue;
          }
          const key = `${section}:${localId}`;
          const prior = identities.get(key);
          if (prior !== undefined) {
            if (stableJson(prior) !== stableJson(rawItem)) {
              report.ambiguities.push({
                code: 'IDENTITY_COLLISION',
                path: `${sourceRel}.${section}.${localId}`,
                detail: `Conflicting definitions of ${section}.${localId} cannot be consolidated automatically.`,
              });
              valid = false;
            }
            continue;
          }
          identities.set(key, rawItem);
          if (section === 'entities') normalizeEntityDbtBinding(item, sourceRel, dbtIndex, report);
          destination.push(item);
          report.qualifiedIdentityRewrites.push({
            domain,
            kind: section.replace(/s$/, ''),
            localId,
            qualifiedId: `${domain}::${section.replace(/s$/, '')}::${localId}`,
          });
        }
        merged[section] = destination;
      } else if (!(section in merged)) {
        merged[section] = rawValue;
      } else if (stableJson(merged[section]) !== stableJson(rawValue)) {
        report.ambiguities.push({
          code: 'IDENTITY_COLLISION',
          path: `${sourceRel}.${section}`,
          detail: `Conflicting top-level modeling value "${section}" cannot be consolidated automatically.`,
        });
        valid = false;
      }
    }
  }
  if (!valid) return;
  const content = yaml.dump(merged, { noRefs: true, lineWidth: -1, sortKeys: false, noCompatMode: true }).trimEnd() + '\n';
  const before = existsSync(targetAbs) ? readFileSync(targetAbs, 'utf8') : '';
  const splitSources = sources.filter((source) => source !== targetAbs);
  if (before !== content) writes.push({ kind: 'file', target: targetRel, content });
  for (const source of splitSources) deletes.push(slash(relative(projectRoot, source)));
  if (splitSources.length > 0) {
    report.modelingConsolidations.push({
      domain,
      sources: sources.map((source) => slash(relative(projectRoot, source))),
      target: targetRel,
    });
  }
}

const MODELING_LIST_SECTIONS = new Set(['entities', 'relationships', 'contracts', 'conformance', 'rules', 'exports', 'imports']);

function normalizeEntityDbtBinding(
  entity: Record<string, unknown>,
  sourcePath: string,
  dbtIndex: DbtBindingIndex | undefined,
  report: ModelingMigrationReport,
): void {
  const id = typeof entity.id === 'string' ? entity.id : 'unknown';
  const ref = typeof entity.dbt_model === 'string' ? entity.dbt_model.trim() : '';
  if (!ref || !dbtIndex) return;
  if (dbtIndex.uniqueIds.has(ref)) return;
  const matches = dbtIndex.aliases.get(normalizeDbtReference(ref)) ?? [];
  if (matches.length === 1) {
    entity.dbt_model = matches[0];
  } else if (matches.length > 1) {
    report.ambiguities.push({
      code: 'AMBIGUOUS_DBT_BINDING',
      path: `${sourcePath}.entities.${id}.dbt_model`,
      detail: `Binding "${ref}" matches multiple dbt nodes; use an exact dbt unique_id.`,
      candidates: matches,
    });
  } else {
    report.losses.push({
      code: 'MISSING_DBT_BINDING',
      path: `${sourcePath}.entities.${id}.dbt_model`,
      detail: `Binding "${ref}" is preserved but does not resolve in the current dbt manifest.`,
    });
  }
}

function planLegacyProducts(
  projectRoot: string,
  registry: ReturnType<typeof loadDomainPackageRegistry>,
  report: ModelingMigrationReport,
  writes: ModelingWriteOperation[],
  deletes: string[],
): void {
  const claimedTargets = new Map<string, string>();
  for (const appsDir of findNamedDirectories(join(projectRoot, 'domains'), 'apps')) {
    const pkg = registry.packageForPath(appsDir);
    if (!pkg) {
      report.ambiguities.push({ code: 'DOMAIN_UNRESOLVED', path: slash(relative(projectRoot, appsDir)), detail: 'No Domain Package owns this legacy Apps directory.' });
      continue;
    }
    for (const entry of readdirSync(appsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const sourceAbs = join(appsDir, entry.name);
      const manifestPath = join(sourceAbs, 'dql.app.json');
      if (!existsSync(manifestPath)) continue;
      const sourceRel = slash(relative(projectRoot, sourceAbs));
      let document: Record<string, unknown>;
      try {
        document = jsonRecord(JSON.parse(readFileSync(manifestPath, 'utf8')));
      } catch (error) {
        report.ambiguities.push({ code: 'INVALID_SOURCE', path: `${sourceRel}/dql.app.json`, detail: errorMessage(error) });
        continue;
      }
      const id = typeof document.id === 'string' ? document.id.trim() : '';
      if (!id || id !== entry.name) {
        report.ambiguities.push({
          code: 'IDENTITY_COLLISION',
          path: `${sourceRel}/dql.app.json`,
          detail: `App folder "${entry.name}" and document id "${id || '(missing)'}" differ; choose the canonical global id explicitly.`,
        });
        continue;
      }
      if (!productOwnerMatches(document, pkg.id)) {
        report.ambiguities.push({ code: 'DOMAIN_UNRESOLVED', path: `${sourceRel}/dql.app.json`, detail: `Existing domain ownership conflicts with path owner "${pkg.id}".` });
        continue;
      }
      const targetRel = `apps/${id}`;
      const claimedBy = claimedTargets.get(targetRel);
      if (existsSync(join(projectRoot, targetRel)) || claimedBy) {
        report.ambiguities.push({
          code: 'TARGET_COLLISION',
          path: targetRel,
          detail: claimedBy
            ? 'Multiple domain-local Apps resolve to the same global target; ZLens will not choose one.'
            : 'Global App target already exists; ZLens will not merge or overwrite it.',
          candidates: claimedBy ? [claimedBy, sourceRel] : [sourceRel, targetRel],
        });
        continue;
      }
      claimedTargets.set(targetRel, sourceRel);
      document.ownerDomain = pkg.id;
      if (!Array.isArray(document.usesDomains) || document.usesDomains.length === 0) document.usesDomains = [pkg.id];
      const manifestContent = `${JSON.stringify(document, null, 2)}\n`;
      writes.push({ kind: 'directory', source: sourceRel, target: targetRel, patches: [{ path: 'dql.app.json', content: manifestContent }] });
      deletes.push(sourceRel);
      report.productMoves.push({ kind: 'app', domain: pkg.id, source: sourceRel, target: targetRel });
    }
  }

  for (const notebooksDir of findNamedDirectories(join(projectRoot, 'domains'), 'notebooks')) {
    const pkg = registry.packageForPath(notebooksDir);
    if (!pkg) {
      report.ambiguities.push({ code: 'DOMAIN_UNRESOLVED', path: slash(relative(projectRoot, notebooksDir)), detail: 'No Domain Package owns this legacy Notebooks directory.' });
      continue;
    }
    for (const sourceAbs of walkFiles(notebooksDir).filter((path) => path.endsWith('.dqlnb'))) {
      const sourceRel = slash(relative(projectRoot, sourceAbs));
      const nested = slash(relative(notebooksDir, sourceAbs));
      const targetRel = `notebooks/${nested}`;
      const claimedBy = claimedTargets.get(targetRel);
      if (existsSync(join(projectRoot, targetRel)) || claimedBy) {
        report.ambiguities.push({
          code: 'TARGET_COLLISION',
          path: targetRel,
          detail: claimedBy
            ? 'Multiple domain-local Notebooks resolve to the same global target; ZLens will not choose one.'
            : 'Global Notebook target already exists; ZLens will not merge or overwrite it.',
          candidates: claimedBy ? [claimedBy, sourceRel] : [sourceRel, targetRel],
        });
        continue;
      }
      claimedTargets.set(targetRel, sourceRel);
      let notebook: Record<string, unknown>;
      try {
        notebook = jsonRecord(JSON.parse(readFileSync(sourceAbs, 'utf8')));
      } catch (error) {
        report.ambiguities.push({ code: 'INVALID_SOURCE', path: sourceRel, detail: errorMessage(error) });
        continue;
      }
      const metadata = jsonRecord(notebook.metadata);
      if (!productOwnerMatches(metadata, pkg.id)) {
        report.ambiguities.push({ code: 'DOMAIN_UNRESOLVED', path: sourceRel, detail: `Existing notebook ownership conflicts with path owner "${pkg.id}".` });
        continue;
      }
      metadata.ownerDomain = pkg.id;
      if (!Array.isArray(metadata.usesDomains) || metadata.usesDomains.length === 0) metadata.usesDomains = [pkg.id];
      notebook.metadata = metadata;
      const content = canonicalizeNotebook(JSON.stringify(notebook));
      writes.push({ kind: 'file', target: targetRel, content });
      deletes.push(sourceRel);
      report.productMoves.push({ kind: 'notebook', domain: pkg.id, source: sourceRel, target: targetRel });
    }
  }
}

function productOwnerMatches(document: Record<string, unknown>, pathDomain: string): boolean {
  const owner = typeof document.ownerDomain === 'string' && document.ownerDomain.trim()
    ? document.ownerDomain.trim()
    : typeof document.domain === 'string' && document.domain.trim()
      ? document.domain.trim()
      : undefined;
  return !owner || owner === pathDomain;
}

/** Apply only the exact reviewed fingerprint, with rollback across all source replacements. */
export function applyModelingMigration(projectRootInput: string, plan: ModelingMigrationPlan): { written: string[]; removed: string[] } {
  const projectRoot = resolve(projectRootInput);
  if (plan.report.ambiguities.length > 0) throw new Error('Migration plan is blocked by ambiguities; no files were written.');
  const current = planModelingMigration(projectRoot);
  if (current.report.fingerprint !== plan.report.fingerprint || migrationShape(current) !== migrationShape(plan)) {
    throw new Error('SOURCE_CHANGED: migration inputs changed after preview; run --dry-run again and review the new fingerprint.');
  }
  if (plan.writes.length === 0 && plan.deletes.length === 0) return { written: [], removed: [] };

  const stageRoot = join(projectRoot, '.dql', 'migration-staging', randomUUID());
  const afterRoot = join(stageRoot, 'after');
  const beforeRoot = join(stageRoot, 'before');
  const deletedRoot = join(stageRoot, 'deleted');
  const installed: string[] = [];
  const backedUp: string[] = [];
  const removed: string[] = [];
  try {
    for (const operation of plan.writes) {
      const staged = join(afterRoot, operation.target);
      mkdirSync(dirname(staged), { recursive: true });
      if (operation.kind === 'file') {
        writeFileSync(staged, operation.content, 'utf8');
      } else {
        const source = safeMigrationPath(projectRoot, operation.source);
        rejectSymlinks(source);
        cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
        for (const patch of operation.patches) {
          const patchPath = safeMigrationPath(staged, patch.path);
          mkdirSync(dirname(patchPath), { recursive: true });
          writeFileSync(patchPath, patch.content, 'utf8');
        }
      }
    }

    for (const operation of plan.writes) {
      const target = safeMigrationPath(projectRoot, operation.target);
      const staged = join(afterRoot, operation.target);
      if (existsSync(target)) {
        const backup = join(beforeRoot, operation.target);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(target, backup);
        backedUp.push(operation.target);
      }
      mkdirSync(dirname(target), { recursive: true });
      renameSync(staged, target);
      installed.push(operation.target);
    }
    for (const sourceRel of plan.deletes) {
      if (plan.writes.some((operation) => operation.target === sourceRel)) continue;
      const source = safeMigrationPath(projectRoot, sourceRel);
      if (!existsSync(source)) continue;
      const backup = join(deletedRoot, sourceRel);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(source, backup);
      removed.push(sourceRel);
    }
    rmSync(stageRoot, { recursive: true, force: true });
    return { written: installed, removed };
  } catch (error) {
    for (const sourceRel of [...removed].reverse()) {
      const source = safeMigrationPath(projectRoot, sourceRel);
      const backup = join(deletedRoot, sourceRel);
      if (existsSync(source)) rmSync(source, { recursive: true, force: true });
      if (existsSync(backup)) {
        mkdirSync(dirname(source), { recursive: true });
        renameSync(backup, source);
      }
    }
    for (const targetRel of [...installed].reverse()) {
      const target = safeMigrationPath(projectRoot, targetRel);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
    for (const targetRel of [...backedUp].reverse()) {
      const target = safeMigrationPath(projectRoot, targetRel);
      const backup = join(beforeRoot, targetRel);
      if (existsSync(backup)) {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(backup, target);
      }
    }
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function readDbtBindingIndex(path: string): DbtBindingIndex {
  const manifest = jsonRecord(JSON.parse(readFileSync(path, 'utf8')));
  const nodes = { ...jsonRecord(manifest.nodes), ...jsonRecord(manifest.sources) };
  const uniqueIds = new Set<string>();
  const aliases = new Map<string, string[]>();
  for (const [uniqueId, raw] of Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b))) {
    const node = jsonRecord(raw);
    if (node.resource_type !== 'model' && node.resource_type !== 'source') continue;
    uniqueIds.add(uniqueId);
    const names = [node.name, node.alias, node.identifier, relationFromDbtNode(node)]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    for (const name of names) {
      const key = normalizeDbtReference(name);
      const values = aliases.get(key) ?? [];
      if (!values.includes(uniqueId)) values.push(uniqueId);
      aliases.set(key, values.sort());
    }
  }
  return { uniqueIds, aliases };
}

function relationFromDbtNode(node: Record<string, unknown>): string {
  return [node.database, node.schema, node.alias ?? node.identifier ?? node.name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('.');
}

function normalizeDbtReference(value: string): string {
  return value.trim().replace(/^ref\(['"]|['"]\)$/g, '').replace(/["`]/g, '').toLowerCase();
}

function fingerprintMigrationState(projectRoot: string, dbtManifestPath: string | null): string {
  const hash = createHash('sha256');
  const paths = [
    join(projectRoot, 'dql.config.json'),
    ...walkFiles(join(projectRoot, 'domains')),
    ...walkFiles(join(projectRoot, 'apps')),
    ...walkFiles(join(projectRoot, 'notebooks')),
  ];
  if (dbtManifestPath) paths.push(dbtManifestPath);
  const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
  for (const path of unique) {
    if (path.includes(`${sep}.dql${sep}`)) continue;
    hash.update(displayPath(projectRoot, path));
    hash.update('\0');
    if (existsSync(path) && statSync(path).isFile()) hash.update(readFileSync(path));
    else hash.update('<missing>');
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function migrationShape(plan: ModelingMigrationPlan): string {
  return stableJson({
    writes: plan.writes.map((operation) => operation.kind === 'file'
      ? { kind: operation.kind, target: operation.target, content: operation.content }
      : { kind: operation.kind, source: operation.source, target: operation.target, patches: operation.patches }),
    deletes: plan.deletes,
    ambiguities: plan.report.ambiguities,
    losses: plan.report.losses,
  });
}

function findNamedDirectories(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.name === name) found.push(path);
      else stack.push(path);
    }
  }
  return found.sort();
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) files.push(path);
    }
  }
  return files.sort();
}

function rejectSymlinks(root: string): void {
  for (const path of [root, ...walkFiles(root)]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Migration refuses symlinked source: ${path}`);
  }
}

function safeMigrationPath(root: string, relativePath: string): string {
  const base = resolve(root);
  const path = resolve(base, relativePath);
  if (path !== base && !path.startsWith(`${base}${sep}`)) throw new Error(`Migration path escapes project root: ${relativePath}`);
  return path;
}

function yamlRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function displayPath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  return rel.startsWith('..') ? resolve(path) : slash(rel);
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function compareIssue(a: ModelingMigrationIssue, b: ModelingMigrationIssue): number {
  return `${a.path}:${a.code}:${a.detail}`.localeCompare(`${b.path}:${b.code}:${b.detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runDataLexManifestMigration(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const datalexManifestPath = flags.datalexManifestPath || flags.input;
  if (!datalexManifestPath) {
    console.error('Usage: zlens migrate datalex --input <datalex-manifest.json> [--dry-run|--apply]');
    process.exitCode = 1;
    return;
  }
  const absoluteDataLex = resolve(datalexManifestPath);
  if (!existsSync(absoluteDataLex)) {
    console.error(`DataLex manifest not found: ${absoluteDataLex}`);
    process.exitCode = 1;
    return;
  }
  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
  if (!dbtManifestPath) {
    console.error('No dbt manifest found. Run dbt parse/compile or configure dql.config.json before migrating DataLex.');
    process.exitCode = 1;
    return;
  }
  const plan = planDataLexMigration({ projectRoot, datalexManifestPath: absoluteDataLex, dbtManifestPath });
  const applyRequested = flags.apply === true && flags.dryRun !== true;
  const blocked = plan.report.ambiguities.length > 0;
  const apply = applyRequested && !blocked;
  const result = apply ? applyDataLexMigration(projectRoot, plan) : undefined;
  if (applyRequested && blocked) process.exitCode = 1;

  if (flags.format === 'json') {
    console.log(JSON.stringify({ mode: blocked && applyRequested ? 'blocked' : apply ? 'applied' : 'dry-run', plan, result }, null, 2));
    return;
  }
  console.log(`\n  DataLex → DQL dbt-first migration (${blocked && applyRequested ? 'blocked' : apply ? 'applied' : 'dry-run'})`);
  console.log(`    matched dbt entities: ${plan.report.matchedEntities.length}`);
  console.log(`    drafted DQL objects: ${plan.report.draftedObjects.length}`);
  console.log(`    dropped dbt mirrors: ${plan.report.droppedDbtMirrors.length}`);
  console.log(`    explicit losses: ${plan.report.losses.length}`);
  console.log(`    ambiguities: ${plan.report.ambiguities.length}`);
  console.log(`    auto-certified: ${plan.report.autoCertified}`);
  if (apply) {
    console.log(`    wrote: ${result?.written.length ?? 0}; unchanged: ${result?.unchanged.length ?? 0}`);
  } else {
    console.log(blocked
      ? '    no files written; replace ambiguous names with exact dbt unique IDs and preview again.'
      : '    no files written; add --apply after reviewing the generated plan.');
  }
  for (const ambiguity of plan.report.ambiguities) {
    console.log(`    ✗ ${ambiguity.path}: ${ambiguity.reason} (${ambiguity.candidates.join(', ')})`);
  }
  for (const file of plan.files) console.log(`    ${file.kind}: ${file.path}`);
}

interface FormatMigrateReport {
  scanned: number;
  alreadyCanonical: number;
  upgraded: number;
  failed: Array<{ path: string; error: string }>;
  dryRun: boolean;
}

interface LayoutMove {
  source: string;
  target: string;
  kind: 'block' | 'term' | 'business-view';
  domain: string;
  status: 'move' | 'exists' | 'same';
}

interface LayoutMigrateReport {
  targetLayout: 'domain-first';
  dryRun: boolean;
  scanned: number;
  moves: LayoutMove[];
  skipped: LayoutMove[];
}

export interface ParameterMigrationIssue {
  path: string;
  block?: string;
  kind: 'undeclared_placeholder' | 'policy_without_definition' | 'incompatible_default' | 'ambiguous_semantic_filter' | 'duplicate_parameterized_contract';
  detail: string;
}

export interface ParameterMigrationReport {
  scanned: number;
  blocksWithParameters: number;
  issues: ParameterMigrationIssue[];
}

/**
 * A read-only migration audit. Existing blocks keep their legacy execution
 * defaults; the report identifies only the contracts that need a human review
 * before AI may adapt their values.
 */
export async function runParameterMigrateCheck(flags: CLIFlags): Promise<void> {
  const root = findProjectRoot(resolve(flags.input || process.cwd()));
  const report: ParameterMigrationReport = { scanned: 0, blocksWithParameters: 0, issues: [] };
  const contracts = new Map<string, Array<{ path: string; block: string }>>();

  for (const absPath of walkDqlFiles(root)) {
    if (!absPath.endsWith('.dql')) continue;
    report.scanned += 1;
    const source = readFileSync(absPath, 'utf-8');
    const program = new Parser(source, absPath).parse();
    for (const statement of program.statements) {
      if (statement.kind !== NodeKind.BlockDecl) continue;
      const block = statement;
      const path = relative(root, absPath) || absPath;
      const names = new Set(block.params?.params.map((parameter) => parameter.name) ?? []);
      const definitions = blockParameterDefinitions(block);
      if (definitions.length) report.blocksWithParameters += 1;

      for (const interpolation of block.query?.interpolations ?? []) {
        if (!names.has(interpolation.variableName)) {
          report.issues.push({
            path,
            block: block.name,
            kind: 'undeclared_placeholder',
            detail: `\${${interpolation.variableName}} is not declared in params.`,
          });
        }
      }
      for (const policy of block.parameterPolicy ?? []) {
        if (!names.has(policy.name)) {
          report.issues.push({
            path,
            block: block.name,
            kind: 'policy_without_definition',
            detail: `parameterPolicy.${policy.name} has no parameter declaration.`,
          });
        }
      }
      for (const error of resolveBlockParameterValues(definitions).errors) {
        report.issues.push({ path, block: block.name, kind: 'incompatible_default', detail: error });
      }
      if (block.blockType === 'semantic') {
        for (const binding of block.filterBindings ?? []) {
          if (!names.has(binding.filter)) {
            report.issues.push({
              path,
              block: block.name,
              kind: 'ambiguous_semantic_filter',
              detail: `filterBindings.${binding.filter} does not map to a typed parameter.`,
            });
          }
        }
      }

      const sql = block.query?.rawSQL
        ?.replace(/'(?:[^']|'')*'/g, '?')
        .replace(/\b\d+(?:\.\d+)?\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (sql && definitions.length) {
        const signature = `${sql}::${definitions.map((parameter) => `${parameter.name}:${parameter.type}:${parameter.binding?.kind ?? 'unbound'}`).sort().join('|')}`;
        const entries = contracts.get(signature) ?? [];
        entries.push({ path, block: block.name });
        contracts.set(signature, entries);
      }
    }
  }

  for (const entries of contracts.values()) {
    if (entries.length < 2) continue;
    const detail = `Equivalent parameterized contract also appears in ${entries.map((entry) => `${entry.block} (${entry.path})`).join(', ')}.`;
    for (const entry of entries) {
      report.issues.push({ path: entry.path, block: entry.block, kind: 'duplicate_parameterized_contract', detail });
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n  DQL parameter migration audit');
    console.log('  ─────────────────────────────');
    console.log(`  Project: ${root}`);
    console.log(`  Scanned: ${report.scanned}`);
    console.log(`  Blocks with parameters: ${report.blocksWithParameters}`);
    console.log(`  Review issues: ${report.issues.length}`);
    for (const issue of report.issues.slice(0, 50)) {
      console.log(`    ✗ ${issue.path}${issue.block ? ` [${issue.block}]` : ''}: ${issue.detail}`);
    }
    if (report.issues.length > 50) console.log(`    ... ${report.issues.length - 50} more`);
    console.log('');
  }
  if (flags.check && report.issues.length) process.exitCode = 1;
}

export async function runLayoutMigrate(flags: CLIFlags): Promise<void> {
  if (flags.to !== 'domain-first') {
    throw new Error('Usage: zlens migrate layout --to domain-first [--dry-run]');
  }

  const projectRoot = findProjectRoot(resolve(flags.input || process.cwd()));
  const dryRun = flags.dryRun === true || flags.force !== true;
  const report: LayoutMigrateReport = {
    targetLayout: 'domain-first',
    dryRun,
    scanned: 0,
    moves: [],
    skipped: [],
  };

  const legacyDirs: Array<{ dir: string; kind: LayoutMove['kind']; targetFolder: string }> = [
    { dir: 'blocks', kind: 'block', targetFolder: 'blocks' },
    { dir: 'terms', kind: 'term', targetFolder: 'terms' },
    { dir: 'business-views', kind: 'business-view', targetFolder: 'views' },
  ];

  for (const legacy of legacyDirs) {
    const root = join(projectRoot, legacy.dir);
    if (!existsSync(root)) continue;
    for (const sourcePath of walkDqlFiles(root)) {
      report.scanned += 1;
      const source = readFileSync(sourcePath, 'utf-8');
      const domain = inferDomainFromDql(source);
      const targetPath = join(projectRoot, 'domains', domain, legacy.targetFolder, basename(sourcePath));
      const relSource = relative(projectRoot, sourcePath);
      const relTarget = relative(projectRoot, targetPath);
      const status: LayoutMove['status'] = sourcePath === targetPath
        ? 'same'
        : existsSync(targetPath)
          ? 'exists'
          : 'move';
      const item: LayoutMove = {
        source: relSource,
        target: relTarget,
        kind: legacy.kind,
        domain,
        status,
      };
      if (status === 'move') {
        report.moves.push(item);
        if (!dryRun) {
          mkdirSync(dirname(targetPath), { recursive: true });
          renameSync(sourcePath, targetPath);
        }
      } else {
        report.skipped.push(item);
      }
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  ZLens layout migration to domain-first${dryRun ? ' (dry run)' : ''}`);
  console.log('  ─────────────────────────────');
  console.log(`  Project:       ${projectRoot}`);
  console.log(`  Scanned:       ${report.scanned}`);
  console.log(`  ${dryRun ? 'Would move' : 'Moved'}:    ${report.moves.length}`);
  console.log(`  Skipped:       ${report.skipped.length}`);
  if (report.moves.length > 0) {
    console.log('');
    for (const move of report.moves.slice(0, 25)) {
      console.log(`    ${move.source} -> ${move.target}`);
    }
    if (report.moves.length > 25) {
      console.log(`    ... ${report.moves.length - 25} more`);
    }
  }
  if (report.skipped.length > 0) {
    console.log('');
    console.log('  Skipped files:');
    for (const skipped of report.skipped.slice(0, 10)) {
      console.log(`    ${skipped.source} (${skipped.status})`);
    }
    if (report.skipped.length > 10) {
      console.log(`    ... ${report.skipped.length - 10} more`);
    }
  }
  if (dryRun && report.moves.length > 0) {
    console.log('  Re-run with --force to apply these file moves.');
  }
  console.log('');
}

export async function runFormatMigrate(root: string, flags: CLIFlags): Promise<void> {
  const dryRun = flags.check === true;
  const report: FormatMigrateReport = {
    scanned: 0,
    alreadyCanonical: 0,
    upgraded: 0,
    failed: [],
    dryRun,
  };

  for (const absPath of walkDqlFiles(root)) {
    report.scanned += 1;
    const rel = relative(root, absPath) || absPath;
    const source = readFileSync(absPath, 'utf-8');
    let canonical: string;
    try {
      canonical = absPath.endsWith('.dqlnb') ? canonicalizeNotebook(source) : canonicalize(source);
    } catch (error) {
      report.failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (canonical === source) {
      report.alreadyCanonical += 1;
      continue;
    }
    if (!dryRun) writeFileSync(absPath, canonical, 'utf-8');
    report.upgraded += 1;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length > 0) process.exit(1);
    return;
  }

  console.log(`\n  ZLens format migration${dryRun ? ' (dry run)' : ''}`);
  console.log('  ─────────────────────────────');
  console.log(`  Scanned:            ${report.scanned}`);
  console.log(`  Already canonical:  ${report.alreadyCanonical}`);
  console.log(`  ${dryRun ? 'Would upgrade' : 'Upgraded'}:     ${report.upgraded}`);
  if (report.failed.length > 0) {
    console.log(`  Failed:             ${report.failed.length}`);
    for (const f of report.failed) console.log(`    ✗ ${f.path}: ${f.error}`);
    process.exit(1);
  }
  console.log('');
}

function inferDomainFromDql(source: string): string {
  const match = source.match(/^\s*domain\s*=\s*"([^"]+)"/m);
  return slugifyDomain(match?.[1] || 'uncategorized');
}

function slugifyDomain(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'uncategorized';
}

function* walkDqlFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'target') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (entry.name.endsWith('.dql') || entry.name.endsWith('.dqlnb'))) {
        try {
          if (statSync(full).size > 0) yield full;
        } catch {
          // skip unreadable
        }
      }
    }
  }
}
