import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@zlens/connectors';
import { WorkbenchRoutedQueryExecutor, type WorkbenchQueryRouteOptions } from '../workbench-query-route.js';
import { appsPublishSettings, appsPublishSettingsProblems, buildManifest, collectInputFiles, resolveDbtManifestPath, resolveSemanticLayerWithDiagnostics } from '@zlens/core';
import { buildLocalContextPack, defaultKgPath, defaultMetadataPath, openMetadataCatalog } from '@zlens/agent';
import type { CLIFlags } from '../args.js';
import {
  assertLocalQueryRuntimeReady,
  findProjectRoot,
  getConnectorInstallStatuses,
  loadProjectConfig,
  normalizeProjectConnection,
  resolveProjectSemanticConfig,
  resolveAgentRuntimeValueGrounding,
} from '../local-runtime.js';
import { listRemoteMcpSettings } from '../llm/mcp-config.js';
import { listProviderSettings } from '../settings/provider-settings.js';
import { describeNpmInvocation, resolveNpmInvocation } from '../npm-runtime.js';
import { betterSqlite3Help, probeBetterSqlite3, type BetterSqlite3Probe } from '../native-deps.js';
import { connectorBindingError } from '../connector-native.js';
import { duckdbNoPrebuiltHelp, duckdbNoPrebuiltReason, nativeBindingHelp, nativeInstallContextFor } from '@zlens/connectors';
import { fetchLatestPublishedDqlVersion, resolveDqlRuntimeVersionStatus } from '../version-status.js';
import { resolveRetrievalHealthStatus } from '../retrieval-health.js';
import { getSemanticRuntimeStatus, explainMissingSemanticRuntime } from '../semantic-runtime.js';
import { isGovernedSourceFile, isLegacyBroadDqlIgnore } from '../git-contract.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  advisory?: boolean;
}

/**
 * How publishing an App treats trust (T3): never blocked by default, every
 * tile certified when `apps.requireCertifiedToPublish` is true.
 */
export function checkAppsPublishing(projectRoot: string): Check {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8'));
  } catch {
    raw = undefined;
  }
  const problems = appsPublishSettingsProblems(raw);
  if (problems.length) return { name: 'App publishing', ok: false, detail: `${problems.join(' ')} Publishing is not blocked until it is fixed.` };
  return appsPublishSettings(raw).requireCertifiedToPublish
    ? { name: 'App publishing', ok: true, detail: 'every tile must be certified to publish (apps.requireCertifiedToPublish: true)' }
    : { name: 'App publishing', ok: true, detail: 'not blocked by trust; readers see "Not certified yet" on tiles nobody certified (set apps.requireCertifiedToPublish: true to require certified tiles)' };
}

export async function runDoctor(targetPath: string | null, flags: CLIFlags, rest: string[] = []): Promise<void> {
  if (targetPath === 'scale') {
    await runDoctorScale(rest[0] ?? null, flags);
    return;
  }
  if (targetPath === 'git-hygiene') {
    runDoctorGitHygiene(rest[0] ?? null, flags);
    return;
  }

  const cwd = resolve(targetPath || '.');
  const projectRoot = findProjectRoot(cwd);
  const config = loadProjectConfig(projectRoot);

  // loadProjectConfig normalizes connections.default → defaultConnection
  const defaultConnection = config.defaultConnection;

  // Detect dbt project for conditional checks
  const isDbt = existsSync(join(projectRoot, 'dbt_project.yml'));

  // For dbt projects, semantic-layer/ dir is not needed (dbt provides it)
  const hasSemanticLayerDir = existsSync(join(projectRoot, 'semantic-layer'));
  const semanticLayerOk = isDbt || hasSemanticLayerDir;
  const semanticLayerDetail = isDbt
    ? (hasSemanticLayerDir ? 'found' : 'provided by dbt')
    : (hasSemanticLayerDir ? 'found' : 'missing');

  // data/ is optional
  const hasDataDir = existsSync(join(projectRoot, 'data'));

  const checks: Check[] = [
    checkNodeVersion(),
    checkNpmExecutable(),
    checkSqliteNativeBinding(),
    checkProjectCliVersion(projectRoot),
    {
      name: 'Project root',
      ok: existsSync(projectRoot),
      detail: projectRoot,
    },
    {
      name: 'dql.config.json',
      ok: existsSync(join(projectRoot, 'dql.config.json')),
      detail: existsSync(join(projectRoot, 'dql.config.json')) ? 'found' : 'missing',
    },
    {
      // Layout v2 projects (the create-zlens-app starter) keep blocks under
      // domains/<domain>/blocks; older projects use a top-level blocks/.
      name: 'blocks/',
      ok: existsSync(join(projectRoot, 'blocks')) || existsSync(join(projectRoot, 'domains')),
      detail: existsSync(join(projectRoot, 'blocks'))
        ? 'found'
        : existsSync(join(projectRoot, 'domains'))
          ? 'found domains/ (blocks live in domains/<domain>/blocks)'
          : 'missing (create domains/<domain>/blocks or blocks/)',
    },
    {
      name: 'semantic-layer/',
      ok: semanticLayerOk,
      detail: semanticLayerDetail,
    },
    {
      name: 'data/',
      ok: true,
      detail: hasDataDir ? 'found' : 'not found (optional)',
    },
    {
      name: 'Default connection',
      ok: true,
      detail: defaultConnection?.driver
        ? `driver=${defaultConnection.driver}`
        : 'not configured yet; add Databricks, DuckDB/file, or Snowflake in the notebook Connections page',
    },
    checkSemanticLayer(resolveProjectSemanticConfig(config, projectRoot), projectRoot),
  ];

  checks.push(checkNotebookAssets());
  checks.push(checkAppsPublishing(projectRoot));
  checks.push(checkOutputContractDrift(projectRoot));
  checks.push(await checkDqlVersionDrift(projectRoot));
  checks.push(checkRetrievalHealth(projectRoot, config));
  checks.push(await checkSemanticExecutionRuntime(projectRoot, resolveProjectSemanticConfig(config, projectRoot)));
  if (isDbt) checks.push(checkDbtArtifactFreshness(projectRoot));

  if (defaultConnection?.driver === 'file' || defaultConnection?.driver === 'duckdb') {
    checks.push(checkDuckDBDependency(projectRoot));
  }
  if (defaultConnection?.driver === 'snowflake') {
    checks.push(checkSnowflakeNodeVersion());
  }
  if (defaultConnection?.driver) {
    checks.push(await checkLocalQueryRuntime(projectRoot, defaultConnection));
  }
  if (flags.ai) {
    checks.push(...checkAiRuntime(projectRoot));
  }

  const passed = checks.filter((check) => check.ok).length;
  const nextSteps = buildDoctorNextSteps(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      ok: passed === checks.length,
      projectRoot,
      checks,
      nextSteps,
    }, null, 2));
    return;
  }

  console.log(`\n  ZLens Doctor`);
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.advisory ? '!' : check.ok ? '✓' : '✗'} ${check.name}`);
    console.log(`    ${check.detail.split('\n').join('\n    ')}`);
  }
  console.log('');
  console.log(`  Summary: ${passed}/${checks.length} checks passed`);
  console.log('');
  console.log('  Next local-first steps:');
  for (const step of nextSteps) {
    console.log(`    ${step}`);
  }
  console.log('');
  console.log('  OSS note: certification, personas, and policies are local single-user trust previews.');
  console.log('');
}

interface GitHygieneIssue {
  severity: 'warning' | 'error';
  path: string;
  code: string;
  message: string;
}

interface GitHygieneReport {
  ok: boolean;
  projectRoot: string;
  checkedFiles: number;
  issues: GitHygieneIssue[];
  commitPolicy: {
    durable: string[];
    localOnly: string[];
  };
}

function runDoctorGitHygiene(targetPath: string | null, flags: CLIFlags): void {
  const projectRoot = findProjectRoot(resolve(targetPath || '.'));
  const tracked = listTrackedGitFiles(projectRoot);
  const issues = [
    ...tracked.flatMap((path) => classifyGitHygieneIssue(path)),
    ...findGovernedSourceIgnoreIssues(projectRoot),
  ];
  const report: GitHygieneReport = {
    ok: issues.length === 0,
    projectRoot,
    checkedFiles: tracked.length,
    issues,
    commitPolicy: {
      durable: [
        'domains/**/domain.dql',
        'domains/**/modeling/**/*.dql.yaml',
        'domains/**/skills/**/*.skill.md',
        'domains/**/blocks/**/*.dql',
        'skills/**/*.skill.md',
        'blocks/**/*.dql',
        'terms/**/*.dql',
        'business-views/**/*.dql',
        'semantic-layer/**/*.yaml',
        'tests/**',
        'apps/*/dql.app.json',
        'apps/*/dashboards/*.dqld',
        'curated/shared .dqlnb files',
        '.dql/hints/**/*.hint.yaml',
        '.dql/traces/**/*.trace.json',
        '.dql/evaluations/**/*.hint-evaluation.yaml',
        '.dql/reviews/**/*.review.yaml',
        'dql.config.json',
        'package.json',
      ],
      localOnly: [
        '.dql/cache/**',
        '.dql/local/**',
        '.dql/imports/** by default',
        '*.run.json',
        'dql-manifest.json',
        'data/**',
        'AI pins and saved views',
        'personal layout overrides',
      ],
    },
  };

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n  ZLens Git Hygiene');
  console.log(`    Project: ${projectRoot}`);
  console.log(`    Tracked files checked: ${tracked.length}`);
  console.log('');
  if (issues.length === 0) {
    console.log('  ✓ No tracked local/generated files found.');
  } else {
    for (const issue of issues) {
      console.log(`  ${issue.severity === 'error' ? '✗' : '!'} ${issue.path}`);
      console.log(`    ${issue.message}`);
    }
  }
  console.log('');
  console.log('  Durable shared source: DQL domains/modeling/skills/blocks/terms/views, tests, reviewed Apps/dashboards, curated notebooks, semantic-layer YAML, governed Hint Graph evidence, config.');
  console.log('  Keep local/private: .dql cache/local/imports, run snapshots, compiled manifests, data files, AI pins, saved views, layout overrides.');
  console.log('');
}

const GOVERNED_SOURCE_ROOTS = [
  'domains',
  'skills',
  'blocks',
  'terms',
  'business-views',
  'notebooks',
  'workbooks',
  'apps',
  'dashboards',
  'semantic-layer',
  'tests',
  '.dql/hints',
  '.dql/traces',
  '.dql/evaluations',
  '.dql/reviews',
] as const;

function listGovernedSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const walk = (absoluteDir: string) => {
    if (files.length >= 2_000) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (files.length >= 2_000) return;
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const path = relative(projectRoot, absolute).replace(/\\/g, '/');
        if (isGovernedSourceFile(path)) files.push(path);
      }
    }
  };
  for (const root of GOVERNED_SOURCE_ROOTS) {
    const absolute = join(projectRoot, root);
    if (existsSync(absolute)) walk(absolute);
  }
  for (const path of ['dql.config.json', 'package.json']) {
    if (existsSync(join(projectRoot, path))) files.push(path);
  }
  return [...new Set(files)].sort();
}

function findGovernedSourceIgnoreIssues(projectRoot: string): GitHygieneIssue[] {
  const issues: GitHygieneIssue[] = [];
  const gitignorePath = join(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const hasLegacyBroadIgnore = readFileSync(gitignorePath, 'utf-8')
      .split(/\r?\n/)
      .some(isLegacyBroadDqlIgnore);
    if (hasLegacyBroadIgnore) {
      issues.push({
        severity: 'error',
        path: '.gitignore',
        code: 'broad_dql_ignore',
        message: 'The broad .dql/ rule hides Git-owned Hint Graph evidence. Use granular local-runtime ignores instead.',
      });
    }
  }
  const governedFiles = listGovernedSourceFiles(projectRoot);
  let ignoredFiles: string[] = [];
  if (governedFiles.length > 0) {
    try {
      ignoredFiles = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        input: `${governedFiles.join('\0')}\0`,
      }).split('\0').filter(Boolean);
    } catch {
      // Exit 1 means none of the governed files are ignored.
    }
  }
  for (const path of ignoredFiles) {
    issues.push({
      severity: 'error',
      path,
      code: 'governed_source_ignored',
      message: 'Governed project source is ignored by Git and cannot be shared, reviewed, or rebuilt in another clone.',
    });
  }
  return issues;
}

function listTrackedGitFiles(projectRoot: string): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: projectRoot, encoding: 'utf-8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function classifyGitHygieneIssue(path: string): GitHygieneIssue[] {
  const issues: GitHygieneIssue[] = [];
  const add = (code: string, message: string, severity: GitHygieneIssue['severity'] = 'warning') => {
    issues.push({ severity, path, code, message });
  };
  if (path === 'dql-manifest.json') {
    add('compiled_manifest_tracked', 'Compiled dql-manifest.json should be reproducible and usually excluded from source commits.');
  }
  if (/\.run\.json$/i.test(path) || /\.dqlnb\.run\.json$/i.test(path) || /\.dql\.run\.json$/i.test(path)) {
    add('run_snapshot_tracked', 'Run snapshots are execution state, not durable shared source.');
  }
  if (path.startsWith('.dql/cache/')) {
    add('cache_tracked', '.dql/cache contains generated SQLite/index artifacts and should stay local.', 'error');
  }
  if (path.startsWith('.dql/local/')) {
    add('local_state_tracked', '.dql/local contains private app pins, saved views, and user-local state.', 'error');
  }
  if (path.startsWith('.dql/imports/')) {
    add('imports_tracked', '.dql/imports should stay local unless a specific imported artifact is curated and promoted.');
  }
  if (path.startsWith('data/')) {
    add('data_file_tracked', 'Raw data files are usually environment data; commit only intentional tiny fixtures.');
  }
  if (/\.sqlite(?:3)?$/i.test(path) || /\.(duckdb|duckdb\.wal)$/i.test(path)) {
    add('database_file_tracked', 'Local database files create noisy and potentially sensitive commits.', 'error');
  }
  if (/ai[-_]?pin/i.test(path) || /saved[-_]?view/i.test(path) || /layout[-_]?override/i.test(path)) {
    add('private_ui_state_tracked', 'AI pins, saved views, and layout overrides should be promoted into clean shared artifacts before commit.');
  }
  return issues;
}

interface ScaleIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

interface ScaleReport {
  ok: boolean;
  projectRoot: string;
  counts: Record<string, number>;
  cache: {
    manifestFresh: boolean;
    manifestAgeMs: number | null;
    metadataCatalog: { exists: boolean; path: string; sizeBytes: number | null };
    agentKg: { exists: boolean; path: string; sizeBytes: number | null };
    contextPackMs: number | null;
    contextPackObjects: number | null;
    sourceFingerprints: number | null;
    domainShards: number | null;
  };
  retrieval: {
    topRejectedEvidence: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      score: number;
      rejectedRank: number;
    }>;
  };
  issues: ScaleIssue[];
}

async function runDoctorScale(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(targetPath || '.'));
  const started = Date.now();
  const dbtManifestPath = resolveDbtManifestPath(projectRoot) ?? undefined;
  const manifest = buildManifest({ projectRoot, dbtManifestPath });
  const semanticCounts = resolveDoctorSemanticCounts(projectRoot, {
    manifestMetrics: Object.keys(manifest.metrics ?? {}).length,
    manifestDimensions: Object.keys(manifest.dimensions ?? {}).length,
  });
  const inputFiles = collectInputFiles({ projectRoot, dbtManifestPath });
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  const manifestFresh = isManifestFresh(manifestPath, inputFiles);
  const metadataPath = defaultMetadataPath(projectRoot);
  const kgPath = defaultKgPath(projectRoot);
  const contextStarted = Date.now();
  let contextPackMs: number | null = null;
  let contextPackObjects: number | null = null;
  let sourceFingerprints: number | null = null;
  let domainShards: number | null = null;
  let topRejectedEvidence: ScaleReport['retrieval']['topRejectedEvidence'] = [];
  const issues: ScaleIssue[] = [];

  if (existsSync(metadataPath)) {
    try {
      const catalog = openMetadataCatalog(projectRoot);
      try {
        sourceFingerprints = catalog.sourceFingerprints(10000).length;
        domainShards = catalog.domainShards(1000).length;
      } finally {
        catalog.close();
      }
      const pack = await buildLocalContextPack(projectRoot, {
        question: 'ZLens doctor scale retrieval check for enterprise metadata coverage',
        mode: 'debug',
        surface: 'doctor',
        limit: 16,
      });
      contextPackMs = Date.now() - contextStarted;
      contextPackObjects = pack.objects.length;
      topRejectedEvidence = pack.retrievalDiagnostics.topRejected.slice(0, 10);
      if (sourceFingerprints === 0) {
        issues.push({
          severity: 'warning',
          code: 'source_fingerprints_missing',
          message: 'metadata.sqlite has no source fingerprints. Run zlens compile or zlens agent reindex with the current CLI to refresh the scale index.',
        });
      }
      if (domainShards === 0) {
        issues.push({
          severity: 'warning',
          code: 'domain_shards_missing',
          message: 'metadata.sqlite has no domain shard stats. Run zlens compile or zlens agent reindex with the current CLI to refresh the scale index.',
        });
      }
    } catch (error) {
      issues.push({
        severity: 'warning',
        code: 'context_pack_failed',
        message: `Metadata retrieval check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    issues.push({
      severity: 'warning',
      code: 'metadata_catalog_missing',
      message: 'metadata.sqlite is missing. Run zlens compile or zlens agent reindex before AI import and Ask AI workflows.',
    });
  }

  if (!existsSync(kgPath)) {
    issues.push({
      severity: 'warning',
      code: 'agent_kg_missing',
      message: 'agent-kg.sqlite is missing. Run zlens agent reindex for scalable agent retrieval.',
    });
  }
  if (!manifestFresh) {
    issues.push({
      severity: 'warning',
      code: 'manifest_stale',
      message: 'dql-manifest.json is missing or older than at least one tracked project input.',
    });
  }

  const resolveDomain = createDomainResolver(manifest.domains ?? {});
  const declaredDomains = new Set(Object.values(manifest.domains ?? {}).map((domain) => domain.name));
  const usedDomains = new Set<string>();
  for (const block of Object.values(manifest.blocks)) if (block.domain) usedDomains.add(resolveDomain(block.domain));
  for (const term of Object.values(manifest.terms ?? {})) if (term.domain) usedDomains.add(resolveDomain(term.domain));
  for (const view of Object.values(manifest.businessViews ?? {})) if (view.domain) usedDomains.add(resolveDomain(view.domain));
  const missingDomains = [...usedDomains].filter((domain) => !declaredDomains.has(domain));
  if (missingDomains.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'missing_domain_declarations',
      message: `${missingDomains.length} used domain(s) have no first-class domain declaration: ${missingDomains.slice(0, 10).join(', ')}${missingDomains.length > 10 ? '...' : ''}`,
    });
  }
  const missingEnterpriseMetadata = Object.values(manifest.blocks).filter((block) =>
    !block.pattern || !block.grain || !(block.declaredOutputs?.length),
  );
  if (missingEnterpriseMetadata.length > 0) {
    issues.push({
      severity: 'info',
      code: 'block_contract_gaps',
      message: `${missingEnterpriseMetadata.length} block(s) are missing pattern, grain, or declared outputs.`,
    });
  }
  if (contextPackMs !== null && contextPackMs > 1000) {
    issues.push({
      severity: 'warning',
      code: 'slow_context_pack',
      message: `Context-pack retrieval took ${contextPackMs}ms; target is under 1000ms for common questions.`,
    });
  }

  const report: ScaleReport = {
    ok: !issues.some((issue) => issue.severity === 'error'),
    projectRoot,
    counts: {
      domains: Object.keys(manifest.domains ?? {}).length,
      blocks: Object.keys(manifest.blocks).length,
      certifiedBlocks: Object.values(manifest.blocks).filter((block) => block.status === 'certified').length,
      draftBlocks: Object.values(manifest.blocks).filter((block) => block.status === 'draft').length,
      terms: Object.keys(manifest.terms ?? {}).length,
      businessViews: Object.keys(manifest.businessViews ?? {}).length,
      apps: Object.keys(manifest.apps ?? {}).length,
      dashboards: Object.keys(manifest.dashboards ?? {}).length,
      semanticMetrics: semanticCounts.metrics,
      semanticDimensions: semanticCounts.dimensions,
      dbtModels: manifest.dbtImport?.dbtDag?.models?.length ?? 0,
      dbtSources: manifest.dbtImport?.sourcesImported ?? 0,
      lineageNodes: manifest.lineage.nodes.length,
      lineageEdges: manifest.lineage.edges.length,
      diagnostics: manifest.diagnostics?.length ?? 0,
    },
    cache: {
      manifestFresh,
      manifestAgeMs: manifestAgeMs(manifestPath),
      metadataCatalog: fileState(metadataPath),
      agentKg: fileState(kgPath),
      contextPackMs,
      contextPackObjects,
      sourceFingerprints,
      domainShards,
    },
    retrieval: {
      topRejectedEvidence,
    },
    issues,
  };

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n  ZLens Doctor Scale');
  console.log(`    Project: ${projectRoot}`);
  console.log(`    Checked in ${Date.now() - started}ms`);
  console.log('');
  console.log('  Counts:');
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`    ${key}: ${value}`);
  }
  console.log('');
  console.log('  Cache:');
  console.log(`    manifest fresh: ${report.cache.manifestFresh ? 'yes' : 'no'}`);
  console.log(`    metadata.sqlite: ${report.cache.metadataCatalog.exists ? formatBytes(report.cache.metadataCatalog.sizeBytes ?? 0) : 'missing'}`);
  console.log(`    agent-kg.sqlite: ${report.cache.agentKg.exists ? formatBytes(report.cache.agentKg.sizeBytes ?? 0) : 'missing'}`);
  console.log(`    context pack: ${report.cache.contextPackMs === null ? 'not checked' : `${report.cache.contextPackMs}ms, ${report.cache.contextPackObjects} objects`}`);
  console.log(`    source fingerprints: ${report.cache.sourceFingerprints === null ? 'not checked' : report.cache.sourceFingerprints}`);
  console.log(`    domain shards: ${report.cache.domainShards === null ? 'not checked' : report.cache.domainShards}`);
  if (report.retrieval.topRejectedEvidence.length > 0) {
    console.log('');
    console.log('  Top rejected evidence:');
    for (const item of report.retrieval.topRejectedEvidence) {
      console.log(`    #${item.rejectedRank} ${item.objectType}:${item.name} (${item.score.toFixed(1)})`);
      console.log(`      ${item.reason}`);
    }
  }
  if (issues.length > 0) {
    console.log('');
    console.log('  Issues:');
    for (const issue of issues) {
      console.log(`    ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
  }
  console.log('');
}

function resolveDoctorSemanticCounts(
  projectRoot: string,
  fallback: { manifestMetrics: number; manifestDimensions: number },
): { metrics: number; dimensions: number } {
  try {
    const config = loadProjectConfig(projectRoot);
    const result = resolveSemanticLayerWithDiagnostics(
      resolveProjectSemanticConfig(config, projectRoot) as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
      projectRoot,
    );
    if (result.layer) {
      return {
        metrics: result.layer.listMetrics().length,
        dimensions: result.layer.listDimensions().length,
      };
    }
  } catch {
    // Fall back to compiled manifest counts so doctor scale remains diagnostic-only.
  }
  return {
    metrics: fallback.manifestMetrics,
    dimensions: fallback.manifestDimensions,
  };
}

function isManifestFresh(manifestPath: string, inputFiles: string[]): boolean {
  if (!existsSync(manifestPath)) return false;
  const manifestMtime = statSync(manifestPath).mtimeMs;
  return inputFiles.every((filePath) => {
    try {
      return statSync(filePath).mtimeMs <= manifestMtime;
    } catch {
      return true;
    }
  });
}

function manifestAgeMs(manifestPath: string): number | null {
  if (!existsSync(manifestPath)) return null;
  return Math.max(0, Date.now() - statSync(manifestPath).mtimeMs);
}

function fileState(path: string): { exists: boolean; path: string; sizeBytes: number | null } {
  if (!existsSync(path)) return { exists: false, path, sizeBytes: null };
  return { exists: true, path, sizeBytes: statSync(path).size };
}

function createDomainResolver(domains: Record<string, { name: string; filePath?: string }>): (domain: string) => string {
  const aliases = new Map<string, string>();
  for (const domain of Object.values(domains)) {
    aliases.set(domain.name, domain.name);
    aliases.set(domainAliasKey(domain.name), domain.name);
    const folderAlias = domain.filePath?.replace(/\\/g, '/').match(/^domains\/([^/]+)\//)?.[1];
    if (folderAlias) aliases.set(domainAliasKey(folderAlias), domain.name);
  }
  return (domain) => aliases.get(domain) ?? aliases.get(domainAliasKey(domain)) ?? domain;
}

function domainAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Node 20, 22 and 24 are supported; a newer Node runs, but the DuckDB driver has no prebuilt binary for it. */
export function checkNodeVersion(version = process.versions.node): Check {
  const match = version.match(/^(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if (major < 20) {
    return { name: 'Node.js', ok: false, detail: `version=${version} (requires Node 20, 22 or 24)` };
  }
  const reason = duckdbNoPrebuiltReason(version);
  if (reason) {
    return { name: 'Node.js', ok: true, advisory: true, detail: `version=${version} is not supported yet (supported: Node 20, 22 or 24). ${reason}` };
  }
  return { name: 'Node.js', ok: true, detail: `version=${version} (supported: Node 20, 22 or 24)` };
}

export function isSnowflakeSupportedNodeVersion(version = process.versions.node): boolean {
  const match = version.match(/^(\d+)/);
  const major = match ? Number(match[1]) : 0;
  return major === 20 || major === 22 || major === 24;
}

function checkSnowflakeNodeVersion(): Check {
  return {
    name: 'Snowflake Node.js runtime',
    ok: isSnowflakeSupportedNodeVersion(),
    detail: `version=${process.versions.node} (Snowflake supports Node 20, 22, or 24)`,
  };
}

function buildDoctorNextSteps(projectRoot: string): string[] {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    // Existing repositories do not need package.json. Use npx below.
  }

  const command = (script: string, args: string) => scripts[script]
    ? `npm run ${script}`
    : `npx zlens ${args}`;
  return [
    `${command('notebook', 'notebook')}    # open the local ZLens workspace`,
    `${command('validate', 'validate')}    # check DQL files and semantic references`,
    `${command('compile', 'compile')}     # write dql-manifest.json`,
    `${command('lineage', 'lineage')}     # inspect source -> block -> dashboard -> App lineage`,
  ];
}

function checkNpmExecutable(): Check {
  try {
    const invocation = resolveNpmInvocation();
    return {
      name: 'npm executable',
      ok: true,
      detail: `${describeNpmInvocation(invocation)} (resolved via ${invocation.source})`,
    };
  } catch (error) {
    return {
      name: 'npm executable',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkProjectCliVersion(projectRoot: string): Check {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      name: 'Project-local ZLens CLI',
      ok: true,
      detail: 'no project package.json; skipping local CLI check',
    };
  }

  let declared: string | undefined;
  let legacyDeclared: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = pkg.devDependencies?.['@zlens/cli'] ?? pkg.dependencies?.['@zlens/cli'];
    // The CLI's name before ZLens; projects scaffolded earlier still declare it.
    legacyDeclared = pkg.devDependencies?.['@duckcodeailabs/dql-cli'] ?? pkg.dependencies?.['@duckcodeailabs/dql-cli'];
  } catch {
    return {
      name: 'Project-local ZLens CLI',
      ok: false,
      detail: 'failed to parse package.json',
    };
  }

  if (!declared && legacyDeclared) {
    return {
      name: 'Project-local ZLens CLI',
      ok: false,
      detail: `package.json declares @duckcodeailabs/dql-cli ${legacyDeclared}, the CLI's old name. Replace it with @zlens/cli, then run npm install.`,
    };
  }

  if (!declared) {
    return {
      name: 'Project-local ZLens CLI',
      ok: true,
      detail: 'not declared in package.json (optional for non-scaffolded projects)',
    };
  }

  const runningVersion = readRunningCliVersion();
  const installedPackage = join(projectRoot, 'node_modules', '@zlens', 'cli', 'package.json');
  if (!existsSync(installedPackage)) {
    return {
      name: 'Project-local ZLens CLI',
      ok: false,
      detail: `package.json declares @zlens/cli ${declared}, but node_modules is missing. Run npm install, then npm run notebook or npx zlens.`,
    };
  }

  try {
    const installed = JSON.parse(readFileSync(installedPackage, 'utf-8')) as { version?: string };
    if (installed.version && runningVersion !== 'unknown' && installed.version !== runningVersion) {
      return {
        name: 'Project-local ZLens CLI',
        ok: false,
        detail: `running zlens ${runningVersion}, but project-local zlens is ${installed.version}. Use npm run notebook, npm run compile, or ./node_modules/.bin/zlens.`,
      };
    }
    return {
      name: 'Project-local ZLens CLI',
      ok: true,
      detail: `declared=${declared}, installed=${installed.version ?? 'unknown'}, running=${runningVersion}`,
    };
  } catch {
    return {
      name: 'Project-local ZLens CLI',
      ok: false,
      detail: 'failed to parse project-local @zlens/cli/package.json',
    };
  }
}

function readRunningCliVersion(): string {
  try {
    const commandDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(commandDir, '../package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function checkDuckDBDependency(projectRoot: string, nodeVersion = process.versions.node): Check {
  const status = getConnectorInstallStatuses(projectRoot).find((item) => item.driver === 'duckdb');
  // No prebuilt binary for this Node: installing or rebuilding means a DuckDB
  // source build, so name the Node to use instead (a copy that loads is fine).
  const noPrebuilt = duckdbNoPrebuiltHelp(nodeVersion);
  if (noPrebuilt && status && (!status.installed || connectorBindingError([status.installPath, projectRoot], 'duckdb'))) {
    return { name: 'DuckDB connector package', ok: false, detail: noPrebuilt };
  }
  if (!status) {
    return {
      name: 'DuckDB connector package',
      ok: false,
      detail: 'DuckDB connector status was not available.',
    };
  }

  if (status.installed) {
    // Installed is not loadable: npm 12 blocks duckdb's install script, which
    // downloads its native binary, unless package.json allows it.
    const broken = connectorBindingError([status.installPath, projectRoot], 'duckdb');
    if (broken) {
      return {
        name: 'DuckDB connector package',
        ok: false,
        detail: nativeBindingHelp({
          packageName: 'duckdb',
          role: 'the DuckDB driver ZLens queries DuckDB and local files with',
          error: broken.error,
          context: nativeInstallContextFor(broken.packageDir),
        }),
      };
    }
  }

  return {
    name: 'DuckDB connector package',
    ok: status.installed,
    detail: status.installed
      ? `installed at ${status.installPath} or project node_modules`
      : `missing; install from the notebook Connections page or run ${status.installCommand}`,
  };
}

/**
 * better-sqlite3 holds ZLens's local index, run history and caches. npm 12
 * installs it without its native binary unless package.json allows its
 * install script; every other command stops with this same message.
 */
export function checkSqliteNativeBinding(probe: () => BetterSqlite3Probe = probeBetterSqlite3): Check {
  const result = probe();
  if (result.ok) {
    return { name: 'SQLite native module (better-sqlite3)', ok: true, detail: 'loads' };
  }
  return {
    name: 'SQLite native module (better-sqlite3)',
    ok: false,
    detail: betterSqlite3Help(result.error, result.packageDir),
  };
}

function checkSemanticLayer(semanticConfig: unknown, projectRoot: string): Check {
  try {
    const result = resolveSemanticLayerWithDiagnostics(
      semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
      projectRoot,
    );

    if (result.errors.length > 0) {
      return {
        name: 'Semantic layer',
        ok: false,
        detail: result.errors.join('; '),
      };
    }

    if (!result.layer) {
      return {
        name: 'Semantic layer',
        ok: true,
        detail: 'not configured (optional)',
      };
    }

    const dims = result.layer.listDimensions().length;
    const provider = result.detectedProvider ?? 'configured';
    return {
      name: 'Semantic layer',
      ok: true,
      detail: `provider=${provider}, ${semanticMetricWords(result.layer.listMetrics())}, ${dims} dimensions`,
    };
  } catch (err) {
    return {
      name: 'Semantic layer',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Surface output-contract drift: a parent block `ref()`s a child and
 * references a column the child no longer outputs. These are always warnings —
 * ZLens keeps composition freeform and never fails the build on drift — so the
 * check stays `ok` while still listing each drift so reviewers see it.
 */
function checkOutputContractDrift(projectRoot: string): Check {
  try {
    const dbtManifestPath = resolveDbtManifestPath(projectRoot) ?? undefined;
    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    const drift = (manifest.diagnostics ?? []).filter((d) => d.kind === 'drift');
    if (drift.length === 0) {
      return {
        name: 'Output-contract drift',
        ok: true,
        detail: 'no drift detected — referenced ref() columns match child output contracts',
      };
    }
    const lines = drift.map((d) => {
      const where = d.filePath ? `${d.filePath}: ` : '';
      return `⚠ ${where}${d.message}`;
    });
    return {
      name: 'Output-contract drift',
      // Warning, not failure — drift never blocks. Reported so it is visible.
      ok: true,
      detail: `${drift.length} drift warning(s):\n    ${lines.join('\n    ')}`,
    };
  } catch (err) {
    return {
      name: 'Output-contract drift',
      ok: true,
      detail: `not checked: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkNotebookAssets(): Check {
  const commandDir = dirname(fileURLToPath(import.meta.url));
  const reactAppDir = resolve(commandDir, '../assets/dql-notebook');
  const legacyAppDir = resolve(commandDir, '../assets/notebook-browser');
  const hasReact = existsSync(join(reactAppDir, 'index.html'));
  const hasLegacy = existsSync(join(legacyAppDir, 'index.html'));
  return {
    name: 'Notebook app assets',
    ok: hasReact || hasLegacy,
    detail: hasReact || hasLegacy
      ? 'found'
      : 'missing — try reinstalling: npm i -g @zlens/cli',
  };
}

/**
 * The project's query runtime. While `zlens notebook` runs on a DuckDB project
 * it holds the database file, and DuckDB lets only one process open it: the
 * check then runs a `SELECT 1` through the workbench (the read-only route the
 * other CLI commands use) and passes with where it ran. Anything else holding
 * the file still fails, with the driver's message naming the process.
 */
export async function checkLocalQueryRuntime(
  projectRoot: string,
  connection: NonNullable<ReturnType<typeof loadProjectConfig>['defaultConnection']>,
  options: Pick<WorkbenchQueryRouteOptions, 'find' | 'fetchImpl' | 'env'> = {},
): Promise<Check> {
  const normalized = normalizeProjectConnection(connection, projectRoot);
  let via: string | undefined;
  const routed = new WorkbenchRoutedQueryExecutor(projectRoot, { ...options, onRoute: (route) => { via = route; } });
  if (await routed.routesTo(normalized)) {
    try {
      await routed.executePositional('SELECT 1 AS ok', [], normalized);
      return { name: 'Local query runtime', ok: true, detail: `workbench running on ${via ?? 'this project'}: driver=${connection.driver} answered through it (it holds the DuckDB file)` };
    } catch (error) {
      return { name: 'Local query runtime', ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const previousCwd = process.cwd();
  const executor = new QueryExecutor();

  try {
    process.chdir(projectRoot);
    await assertLocalQueryRuntimeReady(executor, normalized);
    return {
      name: 'Local query runtime',
      ok: true,
      detail: `driver=${connection.driver} is available`,
    };
  } catch (error) {
    return {
      name: 'Local query runtime',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.chdir(previousCwd);
    await executor.disconnect().catch(() => {});
  }
}

function checkAiRuntime(projectRoot: string): Check[] {
  const providers = listProviderSettings(projectRoot);
  const active = providers.find((provider) => provider.active);
  const usableProviders = providers.filter((provider) =>
    provider.enabled &&
    provider.configured &&
    (provider.id !== 'ollama' || provider.active || provider.source !== 'none')
  );
  const mcp = listRemoteMcpSettings(projectRoot);
  const trustedMcp = mcp.entries.filter((entry) => entry.enabled && entry.trusted);
  const metadataPath = defaultMetadataPath(projectRoot);
  const kgPath = defaultKgPath(projectRoot);

  return [
    {
      name: 'AI provider',
      ok: Boolean(active?.enabled && active.configured) || usableProviders.length > 0,
      detail: active
        ? `${active.label} is active${active.model ? `, model=${active.model}` : ''}, source=${active.source}`
        : usableProviders.length > 0
          ? `${usableProviders.map((provider) => provider.label).join(', ')} configured; choose one in Connections`
          : 'no usable provider configured; add OpenAI, Anthropic Claude, or another provider in Connections',
    },
    {
      name: 'Provider fallback',
      ok: true,
      detail: 'ZLens uses the selected provider and reports errors instead of silently falling back to another model.',
    },
    {
      name: 'MCP servers and connectors',
      ok: mcp.warnings.length === 0,
      detail: trustedMcp.length > 0
        ? `${trustedMcp.length} trusted enabled MCP connection(s); config=${mcp.path}`
        : mcp.warnings.length > 0
          ? mcp.warnings.join('; ')
          : `none configured yet; optional config path=${mcp.path}`,
    },
    {
      name: 'Metadata catalog',
      ok: existsSync(metadataPath),
      detail: existsSync(metadataPath)
        ? metadataPath
        : 'missing; run zlens compile or zlens agent reindex before deep ask/build flows',
    },
    {
      name: 'Agent knowledge index',
      ok: existsSync(kgPath),
      detail: existsSync(kgPath)
        ? kgPath
        : 'missing; run zlens agent reindex before Claude Code/Codex ask flows',
    },
  ];
}

/**
 * REL-002: version drift is the #1 source of "the fix didn't work" reports —
 * the project pin, the global binary, and a long-running server can be three
 * different versions. Best-effort latest lookup (2s cap); offline stays ok.
 */
async function checkDqlVersionDrift(projectRoot: string): Promise<Check> {
  await fetchLatestPublishedDqlVersion();
  const status = resolveDqlRuntimeVersionStatus({ projectRoot, runningVersion: readRunningCliVersion() });
  const identity = [
    `running=${status.runningVersion} (${status.invocationSource})`,
    status.projectInstalledVersion ? `project=${status.projectInstalledVersion}` : undefined,
    status.projectPinnedRange ? `pin=${status.projectPinnedRange}` : undefined,
    status.latestKnownVersion ? `latest=${status.latestKnownVersion}` : 'latest=unknown (offline or check disabled)',
  ].filter(Boolean).join(', ');
  if (status.drift.length === 0) {
    return { name: 'ZLens version drift', ok: true, detail: identity };
  }
  return {
    name: 'ZLens version drift',
    ok: false,
    detail: `${identity}. ${status.drift.join(' ')}${status.upgradeCommand ? ` Upgrade: ${status.upgradeCommand}` : ''}`,
  };
}

/**
 * P0: the agent stack fails soft (value grounding silently disabled, hashed
 * embedding fallback, caches without GC). Surface the degradations in one
 * glance instead of a debugging session. Warnings, never blocking.
 */
function checkRetrievalHealth(projectRoot: string, config: ReturnType<typeof loadProjectConfig>): Check {
  const valueGrounding = resolveAgentRuntimeValueGrounding(config);
  const health = resolveRetrievalHealthStatus({
    projectRoot,
    valueGroundingMode: valueGrounding.mode,
    searchSafeColumnCount: valueGrounding.searchSafeColumns.size,
  });
  const summary = [
    `value-grounding=${health.valueGrounding.mode}${health.valueGrounding.mode === 'safe_automatic' ? ` (${health.valueGrounding.searchSafeColumns} safe columns)` : ''}`,
    `embeddings=${health.embeddings.providerId}${health.embeddings.semantic ? '' : ' (lexical fallback)'}`,
    health.catalog.exists
      ? `catalog=${health.catalog.objectCount ?? '?'} objects, packs=${health.catalog.contextPackCount ?? 0} (${formatBytes(health.catalog.contextPackBytes ?? 0)})`
      : 'catalog=missing',
    health.runStore.exists
      ? `runs=${health.runStore.runCount ?? '?'} (${formatBytes(health.runStore.fileBytes ?? 0)})`
      : 'runs=none',
    `snapshots=${health.snapshots.count} (${formatBytes(health.snapshots.totalBytes)})`,
  ].join(', ');
  if (health.warnings.length === 0) {
    return { name: 'Agent retrieval health', ok: true, detail: summary };
  }
  return {
    name: 'Agent retrieval health',
    ok: true,
    advisory: true,
    detail: `${summary}. ${health.warnings.join(' ')}`,
  };
}

/**
 * Semantic EXECUTION health: how many metrics can DQL compose natively vs
 * require a full semantic runtime (dbt Cloud Semantic Layer / MetricFlow CLI),
 * and which engine is active. This is the one-glance answer to "why is my
 * derived metric graying out / erroring" — the definition can be perfectly
 * governed while execution needs a runtime that is not configured.
 */
async function checkSemanticExecutionRuntime(projectRoot: string, semanticConfig: unknown): Promise<Check> {
  try {
    const result = resolveSemanticLayerWithDiagnostics(
      semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
      projectRoot,
    );
    if (!result.layer) {
      return { name: 'Semantic execution runtime', ok: true, detail: 'no semantic layer configured (optional)' };
    }
    const runtime = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });
    const metrics = result.layer.listMetrics();
    const composable = metrics.filter((metric) => result.layer!.canComposeMetric(metric.name)).length;
    const runtimeOnly = metrics.length - composable;
    // The two causes that make a metric fail with no visible reason: `mf` not
    // resolving on the SERVER's PATH (a shell alias does not count), and a dbt
    // profiles target whose fingerprint differs from the active ZLens connection
    // — a different role or warehouse silently yields "semantic engine
    // unavailable" and nothing in the product said so.
    const adapterDetail = runtime.adapters
      .filter((adapter) => adapter.id !== 'native')
      .map((adapter) => `${adapter.id}=${adapter.ready ? 'ready' : adapter.configured ? 'configured but not ready' : 'not configured'}`)
      .join(', ');
    const runtimeCause = runtime.active === 'native' && runtimeOnly > 0
      ? await explainMissingSemanticRuntime(projectRoot).catch(() => null)
      : null;
    const summary = [
      `engine=${runtime.active}`,
      `${semanticMetricWords(metrics)} (${composable} native-composable, ${runtimeOnly} need a full semantic runtime)`,
      adapterDetail || undefined,
    ].filter(Boolean).join(', ');
    if (runtimeOnly === 0 || runtime.active !== 'native') {
      return { name: 'Semantic execution runtime', ok: true, detail: summary };
    }
    if (runtimeCause) {
      return {
        name: 'Semantic execution runtime',
        ok: false,
        detail: `${summary}. ${runtimeCause}`,
      };
    }
    return {
      name: 'Semantic execution runtime',
      ok: false,
      detail: `${summary}. ${runtimeOnly} derived/ratio/cumulative metric(s) cannot execute locally — their panels gray out and Ask falls back. ${runtime.setup ?? 'Configure dbt Cloud Semantic Layer or local MetricFlow in Settings to enable them.'}`,
    };
  } catch (error) {
    return {
      name: 'Semantic execution runtime',
      ok: true,
      detail: `status unavailable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * dbt artifact freshness: ZLens reads target/manifest.json and
 * target/semantic_manifest.json AS-IS with no staleness gate — regenerating
 * dbt without re-running `zlens compile` (or running `dbt run` mid-session)
 * silently degrades metric selection and MetricFlow execution. Surface it.
 */
function checkDbtArtifactFreshness(projectRoot: string): Check {
  const manifestPath = resolveDbtManifestPath(projectRoot);
  if (!manifestPath || !existsSync(manifestPath)) {
    return {
      name: 'dbt artifacts',
      ok: true,
      detail: 'no dbt manifest resolved (non-dbt project, or run dbt parse first)',
    };
  }
  const semanticPath = join(dirname(manifestPath), 'semantic_manifest.json');
  const dqlManifestPath = join(projectRoot, 'dql-manifest.json');
  const mtime = (path: string): number | undefined => {
    try { return existsSync(path) ? statSync(path).mtimeMs : undefined; } catch { return undefined; }
  };
  const manifestM = mtime(manifestPath);
  const semanticM = mtime(semanticPath);
  const compiledM = mtime(dqlManifestPath);
  const problems: string[] = [];
  if (semanticM === undefined) {
    problems.push('target/semantic_manifest.json is MISSING — MetricFlow metrics cannot load or execute; run `dbt parse`.');
  }
  if (compiledM !== undefined && manifestM !== undefined && manifestM > compiledM) {
    problems.push('dbt manifest is NEWER than the last zlens compile — metric/dimension changes are invisible to the agent; run `zlens compile`.');
  }
  if (compiledM !== undefined && semanticM !== undefined && semanticM > compiledM) {
    problems.push('semantic_manifest.json is NEWER than the last zlens compile; run `zlens compile`.');
  }
  const summary = `manifest=${manifestM ? new Date(manifestM).toISOString() : 'missing'}, semantic_manifest=${semanticM ? new Date(semanticM).toISOString() : 'MISSING'}, dql-compile=${compiledM ? new Date(compiledM).toISOString() : 'never'}`;
  if (problems.length === 0) {
    return { name: 'dbt artifacts', ok: true, detail: summary };
  }
  return { name: 'dbt artifacts', ok: false, detail: `${summary}. ${problems.join(' ')} Note: avoid running dbt while Ask sessions are active — artifacts are read per question.` };
}

/**
 * The semantic layer's metrics in the words `zlens sync` and Setup use
 * (new-user round 2, problem 10): dbt's own metrics, and separately the
 * measures ZLens also offers as metrics. "19 metrics and 5 measures", never
 * "24 metrics" beside a sync that says 19.
 */
export function semanticMetricWords(metrics: Array<{ source?: { objectType?: string } }>): string {
  const measures = metrics.filter((metric) => metric.source?.objectType === 'measure').length;
  const own = metrics.length - measures;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return measures ? `${plural(own, 'metric')} and ${plural(measures, 'measure')}` : plural(own, 'metric');
}
