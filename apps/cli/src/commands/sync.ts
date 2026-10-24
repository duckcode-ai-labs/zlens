/**
 * `zlens sync dbt` — detect dbt manifest changes and refresh the DQL cache.
 * `zlens sync warehouse` — read the warehouse's schemas into DQL (no dbt needed).
 *
 * Usage:
 *   zlens sync dbt [path]                   Sync dbt manifest for the project at path
 *   zlens sync dbt --dbt-manifest <path>    Explicit manifest.json path
 *   zlens sync dbt --watch                  Poll for manifest.json changes (1s interval)
 *   zlens sync dbt --clear                  Clear the DQL manifest cache
 *
 * What it does:
 *   - Locates target/manifest.json (explicit or auto-detected)
 *   - Diffs current tracked-file hashes against `.dql/cache/manifest.sqlite`
 *   - Reports which DQL inputs (blocks, notebooks, semantic YAML, dbt manifest)
 *     changed since the last compile
 *   - Parses the dbt manifest for a quick model/source/metric count
 *   - In --watch mode, re-runs the diff whenever manifest.json mtime moves
 *
 * Default mode atomically refreshes the compiled manifest, metadata catalog,
 * and agent index. `--check` preserves the historical report-only behavior.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { collectInputFiles, loadProjectConfig, resolveDbtManifestPath } from '@zlens/core';
import { ManifestCache } from '@zlens/project';
import { defaultKgPath, ensureAgentProjectReady } from '@zlens/agent';
import type { CLIFlags } from '../args.js';
import { manifestCacheTrackedFiles, readCliDqlVersion } from './compile.js';
import { runCompile } from './compile.js';

interface DbtManifestShape {
  nodes?: Record<string, { resource_type?: string }>;
  sources?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  semantic_models?: Record<string, unknown>;
}

interface DbtCounts {
  models: number;
  sources: number;
  metrics: number;
  semanticModels: number;
  /** The manifest could not be read: nothing is counted, rather than "0 metric(s)". */
  unreadable?: boolean;
}

export async function runSync(
  subcommand: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  if (subcommand === 'warehouse') {
    await runSyncWarehouse(rest, flags);
    return;
  }
  if (subcommand !== 'dbt') {
    console.error('Usage: zlens sync dbt [path] [--watch] [--clear] [--dbt-manifest <path>]');
    console.error('       zlens sync warehouse [path] [--connection <name>] [--schemas a,b] [--database <name>]');
    process.exitCode = 1;
    return;
  }

  const allArgs = rest;

  // --dbt-manifest <path>
  let dbtManifestPath: string | undefined;
  const dbtIdx = allArgs.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && allArgs[dbtIdx + 1]) {
    dbtManifestPath = resolve(allArgs[dbtIdx + 1]);
  }

  const watch = allArgs.includes('--watch');
  const clear = allArgs.includes('--clear');
  const check = allArgs.includes('--check');

  // First non-flag, non-value arg is the project root
  const skip = new Set<string>();
  if (dbtIdx >= 0) {
    skip.add(allArgs[dbtIdx]);
    if (allArgs[dbtIdx + 1]) skip.add(allArgs[dbtIdx + 1]);
  }
  const pathArg = allArgs.find((a) => !a.startsWith('-') && !skip.has(a));
  const projectRoot = resolve(pathArg ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No ZLens project found (missing dql.config.json). Run from a project root or pass a path.');
    process.exitCode = 1;
    return;
  }

  // Resolution order: explicit --dbt-manifest flag → `dbt:` section in
  // dql.config.json → <projectRoot>/target/manifest.json.
  const resolved = resolveDbtManifestPath(projectRoot, dbtManifestPath);
  if (!resolved) {
    const cfg = loadProjectConfig(projectRoot);
    const hintedDir = cfg.dbt?.projectDir
      ? resolve(projectRoot, cfg.dbt.projectDir)
      : undefined;
    console.error('✗ No dbt manifest found.');
    console.error('');
    if (hintedDir) {
      console.error(`  dql.config.json points at: ${hintedDir}`);
      console.error(`  but no manifest.json exists at ${join(hintedDir, cfg.dbt?.manifestPath ?? 'target/manifest.json')}.`);
      console.error('');
      console.error(`  Run \`dbt parse\` (or \`dbt compile\`) inside ${hintedDir} first,`);
      console.error('  or pass an explicit --dbt-manifest <path>.');
    } else {
      console.error('  No `dbt` section in dql.config.json and no ./target/manifest.json in sight.');
      console.error('');
      console.error('  Fix one of:');
      console.error('    1. Add to dql.config.json:');
      console.error('         "dbt": { "projectDir": "../dbt" }');
      console.error('    2. Pass --dbt-manifest <path> to this command.');
      console.error('    3. Run this from a directory with ./target/manifest.json.');
    }
    process.exitCode = 1;
    return;
  }
  dbtManifestPath = resolved;

  const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');

  if (clear) {
    if (!existsSync(cachePath)) {
      console.log('  No cache to clear.');
      return;
    }
    const cache = new ManifestCache({ path: cachePath });
    try {
      cache.clear();
      console.log(`  Cleared DQL manifest cache at ${relative(projectRoot, cachePath)}`);
    } finally {
      cache.close();
    }
    return;
  }

  const runOnce = async () => {
    reportDiff({ projectRoot, dbtManifestPath: dbtManifestPath!, cachePath });
    if (check) return;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const compile = await runCompile(projectRoot, ['--dbt-manifest', dbtManifestPath!], { ...flags, format: 'text' });
    if (process.exitCode) return;
    if (compile?.reusedPreparedAgentIndex) {
      console.log('  ✓ dbt sync complete — reused the matching manifest, metadata catalog, and agent index.');
      process.exitCode = previousExitCode;
      return;
    }
    // Stamp the persisted source-version only after both the KG and metadata
    // snapshot are ready. `reindexProject` is intentionally a lower-level
    // primitive and does not make that readiness promise across a restart.
    const indexed = await ensureAgentProjectReady(projectRoot, { kgPath: defaultKgPath(projectRoot) });
    console.log(`  ✓ dbt sync complete — manifest, metadata, and agent index share the refreshed project state (${indexed.nodes} indexed object(s)).`);
    process.exitCode = previousExitCode;
  };
  await runOnce();

  if (!watch) return;

  console.log(`\n  Watching ${relative(projectRoot, dbtManifestPath)} for changes (Ctrl-C to stop)...`);
  let lastMtime = safeMtime(dbtManifestPath);
  let refreshing = false;
  const interval = setInterval(() => {
    const current = safeMtime(dbtManifestPath!);
    if (!refreshing && current !== null && current !== lastMtime) {
      lastMtime = current;
      console.log(`\n  [${new Date().toISOString()}] Manifest changed — re-syncing.`);
      refreshing = true;
      void runOnce().finally(() => { refreshing = false; });
    }
  }, 1000);

  // Keep process alive until signalled
  await new Promise<void>((done) => {
    const stop = () => {
      clearInterval(interval);
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * `zlens sync warehouse [path] [--connection <name>] [--schemas a,b] [--database <name>]`
 *
 * Reads the selected schemas' tables, columns, comments, declared keys and
 * view definitions — metadata only, never rows. In warehouse-first or hybrid
 * modeling this writes `.dql/warehouse-catalog.json`, which Modeling binds
 * entities to; in any project it refreshes the schema metadata Ask retrieves
 * from. `--schemas` saves the selection, as Settings → Sync schema does.
 */
async function runSyncWarehouse(rest: string[], flags: CLIFlags): Promise<void> {
  const valueOf = (name: string) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const valueFlags = new Set(['--schemas', '--database', '--connection']);
  const pathArg = rest.find((arg, index) => !arg.startsWith('-') && !valueFlags.has(rest[index - 1] ?? ''));
  const projectRoot = resolve(pathArg ?? '.');
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No ZLens project found (missing dql.config.json). Run from a project root or pass a path.');
    process.exitCode = 1;
    return;
  }
  const schemas = (valueOf('--schemas') ?? '').split(',').map((schema) => schema.trim()).filter(Boolean);
  const connectionId = valueOf('--connection') ?? (flags.connection || undefined);
  const { syncProjectWarehouse } = await import('../local-runtime.js');
  // A running workbench holds a DuckDB file open; the schema is then read through it.
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Reading the schema through ${via}, which has the DuckDB file open.`); } });
  try {
    const result = await syncProjectWarehouse(projectRoot, {
      ...(connectionId ? { connectionId } : {}),
      ...(valueOf('--database') ? { database: valueOf('--database') } : {}),
      ...(schemas.length ? { schemas } : {}),
      executor,
    });
    const scopes = result.scope.scopes.map((scope) => `${scope.catalogOrDatabase}: ${scope.schemas.join(', ')}`).join('; ');
    if (flags.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  ZLens Sync — warehouse (connection "${result.connectionId}")`);
      console.log('  ' + '='.repeat(50));
      console.log(`  Schemas: ${scopes}`);
      console.log(`  ✓ Schema metadata for Ask: ${result.metadataRelations} relation(s).`);
      const catalog = result.warehouseCatalog;
      if (!catalog) {
        console.log('  Modeling reads dbt in this project, so no warehouse catalog was written.');
        console.log('  To model the warehouse directly, set "manifestVersion": 3 and "modeling": { "mode": "warehouse-first" } in dql.config.json.');
      } else if (catalog.error) {
        console.error(`  ✗ Warehouse catalog: ${catalog.error}`);
        process.exitCode = 1;
      } else if (catalog.skipped) {
        console.log(`  Warehouse catalog unchanged: ${catalog.skipped}.`);
      } else {
        console.log(`  ✓ Warehouse catalog: ${catalog.relations} relation(s) → ${relative(projectRoot, catalog.path)}`);
        for (const warning of catalog.warnings ?? []) console.log(`    ! ${warning}`);
        const profile = catalog.valueProfile;
        if (profile && 'error' in profile) console.log(`    ! Value profile not read: ${profile.error}`);
        else if (profile && 'skipped' in profile) console.log(`    Value profile not read: ${profile.skipped}.`);
        else if (profile) console.log(`  ✓ Value profile (agent.valueProfile): example values of ${profile.columns} column(s) in ${profile.relations} relation(s), ${profile.skippedSensitive} sensitive column(s) left out → .dql/cache/value-profile.json. These values reach your AI provider with drafting prompts.`);
        if (catalog.drift) {
          const drift = catalog.drift;
          console.log('  Changed since the last sync:');
          for (const [label, items] of [['new tables', drift.addedRelations], ['removed tables', drift.removedRelations], ['new columns', drift.addedColumns], ['removed columns', drift.removedColumns], ['changed types', drift.changedColumnTypes]] as const) {
            if (items.length) console.log(`    ${label}: ${items.slice(0, 8).join(', ')}${items.length > 8 ? ` … and ${items.length - 8} more` : ''}`);
          }
          if (drift.affected.length) {
            console.log(`  Modeled objects to review (${drift.affected.length}): ${drift.affected.slice(0, 8).join(', ')}${drift.affected.length > 8 ? ' …' : ''}`);
            console.log('  `zlens compile` names any join or grain that no longer holds; a certified join whose keys changed stops being automatic until it is validated again.');
          }
        }
        console.log('  Next: `zlens model discover` drafts entities and relationships from it for review.');
      }
    }
    if (result.warehouseCatalog?.error) process.exitCode = 1;
  } catch (error) {
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await executor.disconnect().catch(() => undefined);
  }
}

function reportDiff(opts: {
  projectRoot: string;
  dbtManifestPath: string;
  cachePath: string;
}): void {
  const { projectRoot, dbtManifestPath, cachePath } = opts;

  const counts = readDbtCounts(dbtManifestPath);

  console.log(`\n  ZLens Sync — dbt`);
  console.log('  ' + '='.repeat(50));
  console.log(`  Manifest: ${relative(projectRoot, dbtManifestPath)}`);
  if (counts.unreadable) console.log('    The manifest could not be read, so its models and metrics are not counted here.');
  else console.log(`    ${counts.models} model(s), ${counts.sources} source(s), ${counts.metrics} metric(s), ${counts.semanticModels} semantic_model(s)`);

  if (!existsSync(cachePath)) {
    console.log('\n  Cache: (cold) — next `zlens compile` will build from scratch.\n');
    return;
  }

  const files = manifestCacheTrackedFiles(
    collectInputFiles({ projectRoot, dbtManifestPath }),
    readCliDqlVersion(),
  );
  const cache = new ManifestCache({ path: cachePath });
  try {
    const changed = cache.diffFiles(files);
    const fp = cache.fingerprint(files);
    const lookup = cache.lookup(fp, files);

    if (lookup.hit) {
      console.log('\n  Cache: HIT — next `zlens compile` will be served from cache.');
      console.log(`    built at: ${lookup.builtAt}\n`);
      return;
    }

    console.log('\n  Cache: MISS — next `zlens compile` will rebuild.');
    if (changed.length === 0) {
      console.log('    (no prior build for these exact inputs)\n');
      return;
    }
    console.log(`    ${changed.length} file(s) changed since last build:`);
    for (const path of changed.slice(0, 20)) {
      console.log(`      ${relative(projectRoot, path)}`);
    }
    if (changed.length > 20) {
      console.log(`      ... and ${changed.length - 20} more`);
    }
    console.log('');
  } finally {
    cache.close();
  }
}

/**
 * Counts what the dbt manifest declares. Metrics are dbt's own metrics, the
 * same number Setup shows (`doctor` names the measures it adds separately).
 * A manifest without a metrics map falls back to semantic_manifest.json
 * beside it, so a project with 19 metrics never reads "0 metric(s)".
 */
export function readDbtCounts(manifestPath: string): DbtCounts {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DbtManifestShape;
    let models = 0;
    for (const node of Object.values(raw.nodes ?? {})) {
      if (node?.resource_type === 'model') models += 1;
    }
    let metrics = Object.keys(raw.metrics ?? {}).length;
    if (metrics === 0) {
      try {
        const semanticPath = join(dirname(manifestPath), 'semantic_manifest.json');
        if (existsSync(semanticPath)) {
          const semantic = JSON.parse(readFileSync(semanticPath, 'utf-8')) as { metrics?: unknown[] };
          if (Array.isArray(semantic.metrics)) metrics = semantic.metrics.length;
        }
      } catch {
        // The manifest's own count stands.
      }
    }
    return {
      models,
      sources: Object.keys(raw.sources ?? {}).length,
      metrics,
      semanticModels: Object.keys(raw.semantic_models ?? {}).length,
    };
  } catch {
    return { models: 0, sources: 0, metrics: 0, semanticModels: 0, unreadable: true };
  }
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
