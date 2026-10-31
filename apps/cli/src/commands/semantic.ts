/**
 * `zlens semantic` CLI subcommands:
 *   zlens semantic list [path]       — List metrics, dimensions, hierarchies
 *   zlens semantic validate [path]   — Validate semantic layer definitions
 *   zlens semantic query [path]      — Compose a SQL query from metric/dimension names
 *   zlens semantic pull [path]       — Pull/refresh a remote semantic layer repo cache
 *   zlens semantic import <provider> [path] — Import provider metadata into local semantic-layer YAML
 *   zlens semantic sync [path]       — Re-run the last semantic import from manifest
 *   zlens semantic drafts            — List metric drafts waiting for review
 *   zlens semantic approve <name…>   — Approve metric drafts (or --all-from <import id|latest>)
 *   zlens semantic discard <name…>   — Delete metric drafts
 */

import { resolve, join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolveLocalOwner } from '@zlens/agent';
import {
  resolveSemanticLayerWithDiagnostics,
  pullCachedRepo,
} from '@zlens/core';
import { QueryExecutor } from '@zlens/connectors';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection, resolveProjectSemanticConfig } from '../local-runtime.js';
import { loadSemanticImportManifest, performSemanticImport, syncSemanticImport } from '../semantic-import.js';
import { MetricDraftApprovalError, approveMetricDrafts, discardMetricDrafts, importDraftsToApprove, listMetricDrafts, readImportMetricDraftsRecord } from '../import-metric-drafts.js';

export async function runSemantic(
  subcommand: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const targetArg = subcommand === 'import'
    ? (rest[1] ?? '.')
    : subcommand === 'query' || subcommand === 'approve' || subcommand === 'discard'
      ? '.'
      : (rest[0] ?? '.');
  const baseDir = resolve(targetArg);
  const projectRoot = findProjectRoot(baseDir);

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error(`No ZLens project found at "${baseDir}". Run from a project root or pass a project path.`);
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);
  const semanticConfig = resolveProjectSemanticConfig(config, projectRoot);

  switch (subcommand) {
    case 'list':
      return semanticList(semanticConfig, projectRoot, flags);
    case 'validate':
      return semanticValidate(semanticConfig, projectRoot, flags);
    case 'query':
      // `zlens semantic query <metrics> [dims]`: the metrics are the first argument.
      return semanticQuery(semanticConfig, projectRoot, rest, flags);
    case 'pull':
      return semanticPull(semanticConfig, flags);
    case 'import':
      return semanticImport(projectRoot, rest, flags);
    case 'sync':
      return semanticSync(projectRoot, flags);
    case 'drafts':
      return semanticDrafts(projectRoot, flags);
    case 'approve':
      return semanticApprove(projectRoot, rest, flags);
    case 'discard':
      return semanticDiscard(projectRoot, rest, flags);
    default:
      console.log(`
  zlens semantic — Semantic layer management

  Subcommands:
    zlens semantic list [path]                 List all metrics, dimensions, hierarchies
    zlens semantic validate [path]             Validate semantic layer definitions
    zlens semantic query <metrics> [dims]      Compose a SQL query from metric/dimension names
    zlens semantic pull [path]                 Refresh remote semantic layer cache
    zlens semantic import <provider> [path]    Import provider metadata into local semantic-layer YAML
    zlens semantic sync [path]                 Refresh the last semantic import from manifest
    zlens semantic drafts                      List metric drafts waiting for review
    zlens semantic approve <name> [name…]      Approve metric drafts: they answer from now on
    zlens semantic approve --all-from <import> Approve every draft an import wrote and ran
    zlens semantic discard <name> [name…]      Delete metric drafts

  Options:
    --format json|text    Output format (default: text)
    --verbose             Show detailed output
`.trim());
      break;
  }
}

// ── metric drafts ─────────────────────────────────────────────────────────────

function semanticDrafts(projectRoot: string, flags: CLIFlags): void {
  const drafts = listMetricDrafts(projectRoot);
  if (flags.format === 'json') {
    console.log(JSON.stringify({ drafts }, null, 2));
    return;
  }
  if (!drafts.length) {
    console.log('\n  No metric drafts. zlens import sql <workbook> makes them from a Tableau or Power BI file\'s calculations.\n');
    return;
  }
  console.log(`\n  Metric drafts (${drafts.length}): they answer no question until approved.\n`);
  const width = Math.min(32, Math.max(...drafts.map((draft) => draft.name.length)));
  for (const draft of drafts) {
    const value = draft.value === undefined ? 'not run' : draft.value === null ? 'all rows: empty' : `all rows: ${formatValue(draft.value)}`;
    console.log(`  ${draft.name.padEnd(width)}  ${draft.inWords ?? draft.label}   ${value}`);
    if (draft.formula) console.log(`  ${''.padEnd(width)}  from ${draft.formula.replace(/\s+/g, ' ').slice(0, 100)}`);
    if (draft.match) console.log(`  ${''.padEnd(width)}  ${draft.match.words}${draft.match.changed ? '. Changed since compared.' : ''}`);
    for (const note of draft.notes) console.log(`  ${''.padEnd(width)}  note: ${note}`);
  }
  console.log('\n  Approve: zlens semantic approve <name> (a ratio brings its parts), or --all-from <import id>.\n');
}

function semanticApprove(projectRoot: string, rest: string[], flags: CLIFlags): void {
  let names = rest.filter(Boolean);
  let leftOut: string[] = [];
  if (flags.allFrom) {
    const importId = flags.allFrom === 'latest' ? latestImportWithMetricDrafts(projectRoot) : flags.allFrom;
    const record = importId ? readImportMetricDraftsRecord(projectRoot, importId) : null;
    if (!record) {
      console.error(`\n  ✗ ${flags.allFrom === 'latest' ? 'No import has made metric drafts yet.' : `Import ${flags.allFrom} made no metric drafts.`}\n`);
      process.exit(1);
    }
    const fromImport = importDraftsToApprove(projectRoot, record);
    names = [...names, ...fromImport.names];
    leftOut = fromImport.leftOut;
  }
  const saidOfLeftOut = `Left out, because the old report differs or the comparison can't be read: ${leftOut.join(', ')}. Approve each by name once you have looked at why.`;
  if (!names.length && leftOut.length) {
    console.log(flags.format === 'json' ? JSON.stringify({ approved: [], leftOut }, null, 2) : `\n  ${saidOfLeftOut}\n`);
    return;
  }
  if (!names.length) {
    console.error('\n  ✗ Name the metric drafts to approve, or --all-from <import id|latest>. List them with zlens semantic drafts.\n');
    process.exit(1);
  }
  const actor = resolveLocalOwner(projectRoot);
  try {
    const approved = approveMetricDrafts(projectRoot, Array.from(new Set(names)), actor);
    if (flags.format === 'json') {
      console.log(JSON.stringify({ approved, approvedBy: actor, ...(leftOut.length ? { leftOut } : {}) }, null, 2));
      return;
    }
    const metrics = approved.filter((item) => !item.dimension);
    const dimensions = approved.filter((item) => item.dimension);
    console.log(`\n  Approved ${metrics.length} metric${metrics.length === 1 ? '' : 's'} as ${actor}: ${metrics.length === 1 ? 'it answers' : 'they answer'} from now on.`);
    for (const item of metrics) console.log(`  ✓ ${item.name}  →  ${item.to}`);
    if (dimensions.length) console.log(`  With ${dimensions.length} dimension${dimensions.length === 1 ? '' : 's'} of their tables, to group by: ${dimensions.map((item) => item.name).join(', ')}.`);
    if (leftOut.length) console.log(`  ${saidOfLeftOut}`);
    console.log('');
  } catch (error) {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof MetricDraftApprovalError ? 2 : 1);
  }
}

function semanticDiscard(projectRoot: string, rest: string[], flags: CLIFlags): void {
  const names = rest.filter(Boolean);
  if (!names.length) {
    console.error('\n  ✗ Name the metric drafts to discard. List them with zlens semantic drafts.\n');
    process.exit(1);
  }
  try {
    const discarded = discardMetricDrafts(projectRoot, names);
    if (flags.format === 'json') console.log(JSON.stringify({ discarded }, null, 2));
    else console.log(`\n  Discarded ${discarded.join(', ')}.\n`);
  } catch (error) {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** The most recent import session that made metric drafts. */
function latestImportWithMetricDrafts(projectRoot: string): string | null {
  const root = join(projectRoot, '.dql', 'imports');
  if (!existsSync(root)) return null;
  const sessions = readdirSync(root)
    .filter((entry) => /^imp_[A-Za-z0-9_-]+$/.test(entry) && existsSync(join(root, entry, 'metric-drafts.json')))
    .filter((entry) => (readImportMetricDraftsRecord(projectRoot, entry)?.items ?? []).some((item) => item.outcome === 'drafted' && item.path))
    .map((entry) => ({ entry, at: statSync(join(root, entry, 'metric-drafts.json')).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return sessions[0]?.entry ?? null;
}

export function formatValue(value: number): string {
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 1 ? 4 : Number.isInteger(value) ? 0 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// ── list ──────────────────────────────────────────────────────────────────────

function semanticList(
  semanticConfig: unknown,
  projectRoot: string,
  flags: CLIFlags,
): void {
  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`  ✗ ${err}`);
    }
  }

  if (!result.layer) {
    console.error('No semantic layer found. Add YAML files to semantic-layer/ or configure a provider in dql.config.json.');
    process.exit(1);
  }

  const layer = result.layer;
  const metrics = layer.listMetrics();
  const dimensions = layer.listDimensions();
  const hierarchies = layer.listHierarchies();

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      provider: result.detectedProvider ?? 'configured',
      metrics: metrics.map(m => ({ name: m.name, label: m.label, type: m.type, table: m.table, domain: m.domain })),
      dimensions: dimensions.map(d => ({ name: d.name, label: d.label, type: d.type, table: d.table })),
      hierarchies: hierarchies.map(h => ({ name: h.name, label: h.label, levels: h.levels.length })),
    }, null, 2));
    return;
  }

  const provider = result.detectedProvider ?? 'configured';
  console.log(`\n  Semantic Layer (${provider})`);
  console.log(`  ${'─'.repeat(50)}`);

  if (metrics.length > 0) {
    console.log(`\n  Metrics (${metrics.length}):`);
    for (const m of metrics) {
      console.log(`    • ${m.name}  [${m.type}]  ${m.label}`);
      if (flags.verbose && m.description) {
        console.log(`      ${m.description}`);
      }
    }
  } else {
    console.log('\n  Metrics: none');
  }

  if (dimensions.length > 0) {
    console.log(`\n  Dimensions (${dimensions.length}):`);
    for (const d of dimensions) {
      console.log(`    • ${d.name}  [${d.type}]  ${d.label}`);
      if (flags.verbose && d.description) {
        console.log(`      ${d.description}`);
      }
    }
  } else {
    console.log('\n  Dimensions: none');
  }

  if (hierarchies.length > 0) {
    console.log(`\n  Hierarchies (${hierarchies.length}):`);
    for (const h of hierarchies) {
      console.log(`    • ${h.name}  (${h.levels.length} levels)  ${h.label}`);
    }
  }

  console.log('');
}

// ── validate ──────────────────────────────────────────────────────────────────

function semanticValidate(
  semanticConfig: unknown,
  projectRoot: string,
  flags: CLIFlags,
): void {
  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];

  // Collect loading errors
  for (const err of result.errors) {
    issues.push({ level: 'error', message: err });
  }

  if (!result.layer) {
    issues.push({ level: 'error', message: 'No semantic layer could be loaded.' });
  } else {
    const layer = result.layer;
    const metrics = layer.listMetrics();
    const dimensions = layer.listDimensions();

    // Validate metrics
    for (const m of metrics) {
      if (!m.sql || m.sql.trim().length === 0) {
        issues.push({ level: 'error', message: `Metric "${m.name}" has empty SQL expression.` });
      }
      if (!m.table || m.table.trim().length === 0) {
        issues.push({ level: 'warning', message: `Metric "${m.name}" has no table reference.` });
      }
      if (!m.label || m.label.trim().length === 0) {
        issues.push({ level: 'warning', message: `Metric "${m.name}" has no label.` });
      }
    }

    // Validate dimensions
    for (const d of dimensions) {
      if (!d.sql || d.sql.trim().length === 0) {
        issues.push({ level: 'error', message: `Dimension "${d.name}" has empty SQL expression.` });
      }
    }

    // Check for duplicate names
    const metricNames = new Set<string>();
    for (const m of metrics) {
      if (metricNames.has(m.name)) {
        issues.push({ level: 'error', message: `Duplicate metric name: "${m.name}".` });
      }
      metricNames.add(m.name);
    }

    const dimNames = new Set<string>();
    for (const d of dimensions) {
      if (dimNames.has(d.name)) {
        issues.push({ level: 'error', message: `Duplicate dimension name: "${d.name}".` });
      }
      dimNames.add(d.name);
    }

    if (metrics.length === 0 && dimensions.length === 0) {
      issues.push({ level: 'warning', message: 'Semantic layer is empty — no metrics or dimensions found.' });
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ valid: issues.filter(i => i.level === 'error').length === 0, issues }, null, 2));
    return;
  }

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');

  if (errors.length > 0) {
    console.log(`\n  ✗ ${errors.length} error(s):`);
    for (const e of errors) {
      console.log(`    ✗ ${e.message}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n  ⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.log(`    ⚠ ${w.message}`);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n  ✓ Semantic layer is valid.');
  }

  console.log('');

  if (errors.length > 0) {
    process.exit(1);
  }
}

// ── query ─────────────────────────────────────────────────────────────────────

function semanticQuery(
  semanticConfig: unknown,
  projectRoot: string,
  args: string[],
  flags: CLIFlags,
): void {
  if (args.length === 0) {
    console.error('Usage: zlens semantic query <metric1,metric2> [dim1,dim2] [--format json]');
    process.exit(1);
  }

  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  if (!result.layer) {
    console.error('No semantic layer found.');
    for (const err of result.errors) console.error(`  ✗ ${err}`);
    process.exit(1);
  }

  const metricNames = args[0].split(',').map(s => s.trim()).filter(Boolean);
  const dimNames = args[1] ? args[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  const composed = result.layer.composeQuery({
    metrics: metricNames,
    dimensions: dimNames,
  });

  if (!composed) {
    console.error(`Could not compose query for metrics [${metricNames.join(', ')}].`);
    console.error('Ensure the metrics exist in your semantic layer definitions.');
    process.exit(1);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ sql: composed, metrics: metricNames, dimensions: dimNames }, null, 2));
  } else {
    console.log(`\n  Composed SQL:\n`);
    console.log(`  ${composed.sql}`);
    console.log('');
  }
}

// ── pull ──────────────────────────────────────────────────────────────────────

function semanticPull(
  semanticConfig: unknown,
  flags: CLIFlags,
): void {
  const cfg = semanticConfig as { repoUrl?: string; branch?: string } | undefined;

  if (!cfg?.repoUrl) {
    console.error('No remote repo configured. Set semanticLayer.repoUrl in dql.config.json.');
    process.exit(1);
  }

  const result = pullCachedRepo(cfg.repoUrl, cfg.branch);

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.freshClone) {
      console.log(`  ✓ Pulled latest from ${cfg.repoUrl} (branch: ${cfg.branch ?? 'main'})`);
    }
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log(`  Cache: ${result.localPath}`);
  }
}

async function semanticImport(
  projectRoot: string,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const provider = rest[0] as 'dbt' | 'cubejs' | 'snowflake' | undefined;
  if (!provider || (provider !== 'dbt' && provider !== 'cubejs' && provider !== 'snowflake')) {
    console.error('Usage: zlens semantic import <dbt|cubejs|snowflake> [path] [--input <source-path>]');
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);
  const sourceConfig = buildImportSourceConfig(provider, config.semanticLayer, flags.input, projectRoot);
  const executeQuery = provider === 'snowflake'
    ? createSnowflakeQueryExecutor(config, projectRoot)
    : undefined;
  const result = await performSemanticImport({
    targetProjectRoot: projectRoot,
    provider,
    sourceConfig,
    executeQuery,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  ✓ Imported semantic layer from ${provider}`);
  console.log(`    Target: ${projectRoot}`);
  console.log(`    Manifest: ${join(projectRoot, 'semantic-layer', 'imports', 'manifest.json')}`);
  console.log('');
  console.log('  Imported objects:');
  for (const [kind, count] of Object.entries(result.counts)) {
    console.log(`    ${kind}: ${count}`);
  }
  if (result.manifest.warnings.length > 0) {
    console.log('');
    console.log('  Warnings:');
    for (const warning of result.manifest.warnings) {
      console.log(`    - ${warning}`);
    }
  }
  console.log('');
}

async function semanticSync(
  projectRoot: string,
  flags: CLIFlags,
): Promise<void> {
  const config = loadProjectConfig(projectRoot);
  const manifest = loadSemanticImportManifest(projectRoot);
  if (!manifest) {
    console.error('No semantic import manifest found. Run `zlens semantic import <provider>` first.');
    process.exit(1);
  }

  const executeQuery = manifest.provider === 'snowflake'
    ? createSnowflakeQueryExecutor(config, projectRoot)
    : undefined;
  const result = await syncSemanticImport({
    targetProjectRoot: projectRoot,
    executeQuery,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  ✓ Synced semantic import from ${manifest.provider}`);
  console.log(`    Imported at: ${result.manifest.importedAt}`);
  console.log(`    Manifest: ${join(projectRoot, 'semantic-layer', 'imports', 'manifest.json')}`);
  console.log('');
}

function buildImportSourceConfig(
  provider: 'dbt' | 'cubejs' | 'snowflake',
  semanticConfig: unknown,
  inputPath: string,
  projectRoot: string,
) {
  const current = (semanticConfig ?? {}) as {
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
    source?: 'local' | 'github' | 'gitlab';
  };

  if (provider === 'snowflake') {
    return {
      provider,
      projectPath: current.projectPath,
      connection: current.connection,
    };
  }

  if (inputPath) {
    return {
      provider,
      projectPath: resolve(projectRoot, inputPath),
    };
  }

  return {
    provider,
    projectPath: current.projectPath,
    repoUrl: current.repoUrl,
    branch: current.branch,
    subPath: current.subPath,
    source: current.source,
  };
}

function createSnowflakeQueryExecutor(
  config: ReturnType<typeof loadProjectConfig>,
  projectRoot: string,
) {
  const connection = config.defaultConnection;
  if (!connection || connection.driver !== 'snowflake') {
    throw new Error('Snowflake semantic import requires a default Snowflake connection in dql.config.json.');
  }
  const executor = new QueryExecutor();
  const normalizedConnection = normalizeProjectConnection(connection, projectRoot);
  return async (sql: string) => {
    const result = await executor.executeQuery(sql, [], {}, normalizedConnection);
    return { rows: result.rows };
  };
}
