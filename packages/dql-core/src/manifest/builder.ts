/**
 * Manifest Builder — scans a ZLens project and produces a DQLManifest.
 *
 * This is the core compilation step: discovers all blocks, notebooks,
 * semantic layer definitions, extracts dependencies, builds lineage,
 * and optionally imports dbt manifest data.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { Parser } from '../parser/index.js';
import { analyze, detectTrustConflicts } from '../semantic/index.js';
import { extractTablesFromSql } from '../lineage/sql-parser.js';
import { parseDatasetAggregateExpression } from '../datasets/aggregate-expression.node.js';
import { relatedFieldParts } from '../datasets/related-fields.js';
import { SAVED_QUERY_ROW_COUNT } from '../datasets/result-fields.js';
import { extractColumnLineage, type ColumnLineageResult } from '../lineage/column-lineage.js';
import { detectOutputDrift } from './output-drift.js';
import { validateBlockRetirements } from './retirement.js';
import { validateBlockMetricMappings } from './metric-mapping.js';
import { buildLineageGraph } from '../lineage/builder.js';
import { detectDomainFlows, getDomainTrustOverview } from '../lineage/domain-lineage.js';
import { loadSemanticLayerFromDir } from '../semantic/index.js';
import { DataLexContractRegistry } from '../contracts/index.js';
import type {
  LineageBlockInput,
  LineageMetricInput,
  LineageDimensionInput,
  LineageDbtModelInput,
  LineageDashboardInput,
  LineageAppInput,
  LineageBusinessViewInput,
  LineageDomainInput,
  LineageTermInput,
} from '../lineage/builder.js';
import type {
  DQLManifest,
  ManifestBlock,
  ManifestNotebook,
  ManifestNotebookCell,
  ManifestMetric,
  ManifestDimension,
  ManifestSource,
  ManifestLineage,
  ManifestDbtImport,
  ManifestDiagnostic,
  ManifestApp,
  ManifestDashboard,
  ManifestDatasetTile,
  ManifestBusinessView,
  ManifestDomain,
  ManifestTerm,
  ManifestDbtFirstModeling,
} from './types.js';
import {
  loadAppDocument,
  findAppDocuments,
  findDashboardsForApp,
  loadDashboardDocument,
  extractDashboardBlockRefs,
  appFolderRelPath,
  normalizeProductDomainContext,
  type AppDocument,
  type DashboardDocument,
  tileQueryHash,
} from '../apps/index.js';
import { loadDbtRunState, applyBlockDataState, type DbtRunStateIndex } from './dbt-freshness.js';
import { blockParameterDefinitions } from '../blocks/parameters.js';
import { loadDbtFirstModeling, loadWarehouseModeling, siblingDbtArtifact } from './dbt-first-modeling.js';
import { WAREHOUSE_CATALOG_PATH, readWarehouseCatalog } from './warehouse-catalog.js';
import { domainFolderSlug } from './domain-writer.js';
import { loadDomainPackageRegistry } from './domain-package-registry.js';
import type { DomainPackageRegistryResult } from './domain-package-registry.js';
import { buildManifestKnowledgeGraph, compactManifestKnowledgeGraph } from './knowledge-graph.js';
import { certifiedBlockFileState, changedSinceCertifiedMessage } from '../trust/certification-source.js';
import { loadManifestKnowledgeSkills, manifestKnowledgeSkillInputFiles } from './knowledge-skills.js';

// ---- Public API ----

/**
 * Filters applied to dbt manifest import to keep only the subgraph relevant
 * to this ZLens project. Each entry is either a plain model name, `tag:<name>`,
 * or `path:<prefix>` (matched against the node's `path` / `original_file_path`).
 *
 * Semantics
 * - `anchors` extend the DQL-referenced tables set — upstream BFS will follow
 *   from these as if ZLens had queried them directly.
 * - `include` (if non-empty) narrows the considered set to models matching at
 *   least one entry; upstream deps of those are still walked.
 * - `exclude` removes matching models from the final import even if they are
 *   upstream of an anchor.
 */
export interface DbtImportFilters {
  anchors?: string[];
  include?: string[];
  exclude?: string[];
}

export interface ManifestBuildOptions {
  /** Project root directory (must contain dql.config.json) */
  projectRoot: string;
  /** ZLens CLI version string */
  dqlVersion?: string;
  /** Path to dbt manifest.json for import */
  dbtManifestPath?: string;
  /** Path to a DataLex manifest JSON for optional datalex_contract validation */
  datalexManifestPath?: string;
  /**
   * Max upstream hops to follow through the dbt DAG from DQL anchor tables.
   * undefined = follow all the way to raw sources (default).
   * 3 = stop 3 hops above the anchor tables.
   * Useful for very large dbt projects to limit imported node count.
   */
  maxDbtHops?: number;
  /**
   * Total model threshold above which selective import is always used.
   * Defaults to 200. Projects with fewer models import everything.
   */
  selectiveDbtThreshold?: number;
  /**
   * Selective dbt import filters. When omitted, falls back to `dbtImport` in
   * `dql.config.json`. Caller-supplied filters take precedence over config.
   */
  dbtImportFilters?: DbtImportFilters;
  /** Additional directories to scan for .dql files */
  extraBlockDirs?: string[];
  /** Additional directories to scan for .dqlnb files */
  extraNotebookDirs?: string[];
}

/**
 * Enumerate every file whose contents could change the manifest output.
 *
 * Used by the cache layer to compute a fingerprint without building. Stays in
 * sync with `buildManifest`'s scan set: blocks, notebooks, semantic YAML,
 * `dql.config.json`, and (if present) the dbt `manifest.json`.
 *
 * Returns absolute paths, sorted. Does not read file contents.
 */
export function collectInputFiles(options: ManifestBuildOptions): string[] {
  const { projectRoot } = options;
  const files = new Set<string>();
  // Cache overlapping directory walks here as well. `sync dbt` asks for these
  // tracked files before a cache lookup, so repeated block/domain roots must
  // not turn a warm-cache check into several 4k-file traversals.
  const scanCache = createManifestScanCache();

  const configPath = join(projectRoot, 'dql.config.json');
  if (existsSync(configPath)) files.add(configPath);

  const config = loadProjectConfig(projectRoot);
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, options.datalexManifestPath, config);
  if (datalexManifestPath && existsSync(datalexManifestPath)) {
    files.add(datalexManifestPath);
  }

  const blockDirs = ['blocks', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of blockDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'], scanCache)) files.add(f);
  }

  const businessViewDirs = ['blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of businessViewDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'], scanCache)) files.add(f);
  }

  const termDirs = ['terms', 'blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of termDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'], scanCache)) files.add(f);
  }

  const notebookDirs = ['notebooks', 'domains', 'blocks', 'dashboards', 'workbooks', ...(options.extraNotebookDirs ?? [])];
  for (const dir of notebookDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dqlnb'], scanCache)) files.add(f);
  }

  const semanticDir = resolveSemanticPath(projectRoot, config);
  if (existsSync(semanticDir)) {
    for (const f of scanFilesRecursive(semanticDir, ['.yaml', '.yml'], scanCache)) files.add(f);
  }

  if (options.dbtManifestPath && existsSync(options.dbtManifestPath)) {
    files.add(options.dbtManifestPath);
    const catalogPath = siblingDbtArtifact(options.dbtManifestPath, 'catalog.json');
    const semanticManifestPath = siblingDbtArtifact(options.dbtManifestPath, 'semantic_manifest.json');
    if (catalogPath) files.add(catalogPath);
    if (semanticManifestPath) files.add(semanticManifestPath);
  }

  if (modelingModeOf(config)) {
    for (const f of scanFilesRecursive(join(projectRoot, 'domains'), ['.yaml', '.yml'], scanCache)) files.add(f);
    // Warehouse-first and hybrid entities bind to the warehouse catalog snapshot (RFC 0007).
    if (modelingModeOf(config) !== 'dbt-first' && existsSync(join(projectRoot, WAREHOUSE_CATALOG_PATH))) files.add(join(projectRoot, WAREHOUSE_CATALOG_PATH));
    const registry = loadDomainPackageRegistry(projectRoot);
    for (const f of manifestKnowledgeSkillInputFiles(projectRoot, registry)) files.add(f);
  }

  // Apps & dashboards. Manifests live at apps/<id>/dql.app.json; dashboards
  // live under apps/<id>/dashboards/*.dqld.
  for (const appJson of findAppDocuments(projectRoot)) {
    files.add(appJson);
    const appDir = appJson.slice(0, -'/dql.app.json'.length);
    for (const dqld of findDashboardsForApp(appDir)) files.add(dqld);
  }

  return [...files].sort();
}

export function buildManifest(options: ManifestBuildOptions): DQLManifest {
  const { projectRoot, dqlVersion = '0.6.0' } = options;

  const diagnostics: ManifestDiagnostic[] = [];
  // A large project commonly stores blocks, terms, and domains under the same
  // directory tree. The manifest scanner needs distinct declaration passes,
  // but it must not re-walk that tree or re-read the same source three times
  // during one build. Source text is always read freshly; unchanged text can
  // reuse a bounded parsed AST across adjacent builds.
  const scanCache = createManifestScanCache(projectRoot);

  // Load project config
  const config = loadProjectConfig(projectRoot);
  const projectName = config.project ?? 'dql-project';
  const dbtFirstV3 = config.manifestVersion === 3 && config.modeling?.mode === 'dbt-first';
  // Warehouse-first and hybrid modeling (RFC 0007): entities bind to warehouse relations.
  const warehouseV3 = config.manifestVersion === 3 && (config.modeling?.mode === 'warehouse-first' || config.modeling?.mode === 'hybrid');
  const modelingV3 = dbtFirstV3 || warehouseV3;
  if ((config.manifestVersion === 3 || config.modeling?.mode === 'dbt-first') && !modelingV3) {
    diagnostics.push({
      kind: 'config',
      severity: 'error',
      message: 'manifest v3 requires both `manifestVersion: 3` and `modeling.mode: "dbt-first"`; compiling with manifest v2 compatibility defaults',
    });
  } else if ((config.modeling?.mode === 'warehouse-first' || config.modeling?.mode === 'hybrid') && !warehouseV3) {
    diagnostics.push({
      kind: 'config',
      severity: 'error',
      message: `\`modeling.mode: "${config.modeling.mode}"\` requires \`manifestVersion: 3\`; compiling with manifest v2 compatibility defaults`,
    });
  }
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, options.datalexManifestPath, config);
  const datalexRegistry = datalexManifestPath
    ? new DataLexContractRegistry({ manifestPath: datalexManifestPath })
    : undefined;
  for (const message of datalexRegistry?.loadDiagnostics() ?? []) {
    diagnostics.push({
      kind: 'config',
      filePath: datalexManifestPath ? relative(projectRoot, datalexManifestPath) : undefined,
      severity: 'warning',
      message,
    });
  }

  // Scan first-class business domains
  const domainDirs = ['domains', 'blocks', 'terms', 'business-views', ...(options.extraBlockDirs ?? [])];
  const packageRegistry = modelingV3 ? loadDomainPackageRegistry(projectRoot) : undefined;
  const domains = packageRegistry
    ? Object.fromEntries(packageRegistry.values().map((pkg) => [pkg.id, pkg.domain]))
    : scanDomains(projectRoot, domainDirs, diagnostics, scanCache);
  if (!packageRegistry) validateDomainHierarchy(domains, diagnostics);

  // Scan blocks
  const blockDirs = ['blocks', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const blockScan = scanBlocks(projectRoot, blockDirs, diagnostics, datalexRegistry, scanCache);
  const blocks = blockScan.blocks;
  const knowledgeBlocks = blockScan.all;

  // Scan business composition views
  const businessViewDirs = ['blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const businessViews = scanBusinessViews(projectRoot, businessViewDirs, diagnostics, scanCache);

  // Scan business glossary terms
  const termDirs = ['terms', 'blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const terms = scanTerms(projectRoot, termDirs, diagnostics, scanCache);

  if (packageRegistry) {
    applyDomainPackageOwnership(projectRoot, packageRegistry, blocks, businessViews, terms, diagnostics);
    applyDomainPackageOwnershipToValues(projectRoot, packageRegistry, knowledgeBlocks, 'Block', diagnostics);
  }

  // Scan notebooks
  const notebookDirs = ['notebooks', 'blocks', 'dashboards', 'workbooks', ...(options.extraNotebookDirs ?? [])];
  const notebooks = scanNotebooks(projectRoot, notebookDirs, diagnostics, datalexRegistry);

  // Extract blocks declared inside notebook DQL cells
  const notebookBlocks = extractNotebookBlocks(notebooks);
  for (const [name, block] of Object.entries(notebookBlocks)) {
    if (!blocks[name]) blocks[name] = block;
    knowledgeBlocks.push(block);
  }
  const notebookTerms = extractNotebookTerms(notebooks);
  for (const [name, term] of Object.entries(notebookTerms)) {
    if (!terms[name]) terms[name] = term;
  }

  validateDomains(domains, blocks, businessViews, terms, diagnostics);
  validateBusinessViews(businessViews, blocks, diagnostics);
  validateTermRefs(terms, blocks, businessViews, diagnostics);

  // Cross-artifact trust-conflict detection: two certified terms / blocks that
  // claim the same concept/grain but disagree. Additive `kind: 'conflict'`
  // diagnostics; conservative heuristics avoid false positives.
  diagnostics.push(...detectTrustConflicts(terms, blocks));

  // Output-contract drift detection: a parent block `ref()`s a child and
  // references a column the child no longer outputs. Additive `kind: 'drift'`
  // warnings — never fails the build; freeform composition stays unrestricted.
  diagnostics.push(...detectOutputDrift(blocks));

  // Load semantic layer
  const semanticDir = resolveSemanticPath(projectRoot, config);
  const { metrics, dimensions } = loadSemanticDefinitions(projectRoot, semanticDir);
  // A block that declares which metric it answers must name a real one.
  diagnostics.push(...validateBlockMetricMappings(blocks, metrics, {
    metricsKnown: (!config.semanticLayer?.provider || config.semanticLayer.provider === 'dql') && config.modeling?.mode !== 'dbt-first',
  }));

  // Collect all source tables
  const sources = collectSources(blocks, notebooks, metrics, dimensions);

  // Collect all table names DQL actually references — these are the "anchors"
  // from which we walk upstream through the dbt DAG.
  const referencedTables = new Set<string>();
  for (const block of Object.values(blocks)) {
    for (const t of block.tableDependencies) referencedTables.add(t.toLowerCase());
  }
  for (const nb of Object.values(notebooks)) {
    for (const cell of nb.cells) {
      for (const t of cell.tableDependencies) referencedTables.add(t.toLowerCase());
    }
  }
  for (const m of Object.values(metrics)) referencedTables.add(m.table.toLowerCase());
  for (const d of Object.values(dimensions)) referencedTables.add(d.table.toLowerCase());

  // Import dbt manifest if provided. Filters come from options or config
  // (options win when both are present).
  let dbtImport: ManifestDbtImport | undefined;
  if (options.dbtManifestPath) {
    const filters = options.dbtImportFilters ?? config.dbtImport;
    // Freshness-aware trust — read dbt's run artifacts (run_results.json + source
    // freshness) alongside the manifest, READ-ONLY. Empty/absent → every node is
    // `unknown` and blocks are left untouched (additive, backward compatible).
    const runState = loadDbtRunState(options.dbtManifestPath);
    dbtImport = importDbtManifest(options.dbtManifestPath, sources, referencedTables, {
      maxHops: options.maxDbtHops,
      selectiveThreshold: options.selectiveDbtThreshold ?? 200,
      filters,
      runState,
    });
    // Roll up per-model run state into each certified block's effective
    // `dataState` via its transitive dbt upstreams.
    applyBlockDataState(blocks, sources, dbtImport.dbtDag, runState);
  }

  let dbtFirstModeling: ReturnType<typeof loadDbtFirstModeling> | undefined;
  if (dbtFirstV3) {
    if (!options.dbtManifestPath || !existsSync(options.dbtManifestPath)) {
      diagnostics.push({
        kind: 'config',
        severity: 'error',
        message: 'manifest v3 dbt-first modeling requires a readable dbt manifest.json',
      });
    } else {
      dbtFirstModeling = loadDbtFirstModeling(projectRoot, options.dbtManifestPath);
      diagnostics.push(...dbtFirstModeling.diagnostics);
    }
  } else if (warehouseV3) {
    const catalog = readWarehouseCatalog(projectRoot);
    if (catalog.error) diagnostics.push({ kind: 'config', severity: 'error', message: `warehouse catalog snapshot ${WAREHOUSE_CATALOG_PATH} could not be read: ${catalog.error}` });
    dbtFirstModeling = loadWarehouseModeling(projectRoot, {
      mode: config.modeling!.mode as 'warehouse-first' | 'hybrid',
      ...(catalog.snapshot ? { catalog: catalog.snapshot, catalogPath: WAREHOUSE_CATALOG_PATH } : {}),
      ...(options.dbtManifestPath ? { dbtManifestPath: options.dbtManifestPath } : {}),
    });
    diagnostics.push(...dbtFirstModeling.diagnostics);
  }

  // Apps & dashboards (consumption layer). Scanned after blocks/notebooks
  // because dashboard refs are resolved against the block path → name map.
  const { apps, dashboards } = scanAppsAndDashboards(projectRoot, blocks, knowledgeBlocks, diagnostics);

  // Retired blocks: replacedBy / deprecatedOn checks, and remaining uses of
  // deprecated blocks by other blocks and App pages. Additive `kind: 'retirement'`.
  const blocksByDatasetSource = new Map(Object.values(blocks).map((block) => [manifestDatasetBlockSourceId(block), block]));
  diagnostics.push(...validateBlockRetirements({
    blocks,
    dashboards,
    resolveDatasetSource: (sourceId) => blocksByDatasetSource.get(sourceId),
  }));

  // Build lineage
  const lineage = buildManifestLineage(
    domains,
    blocks,
    metrics,
    dimensions,
    notebooks,
    modelingV3 ? stripDbtImportDetails(dbtImport) : dbtImport,
    apps,
    dashboards,
    businessViews,
    terms,
  );
  if (dbtFirstModeling) appendDbtFirstModelingLineage(lineage, dbtFirstModeling.modeling);

  const baseManifest: Omit<DQLManifest, 'knowledgeGraph'> = {
    manifestVersion: modelingV3 ? 3 : 2,
    dqlVersion,
    // v3 is a reproducible policy artifact. Runtime build time lives in the
    // local cache, not in the canonical manifest content.
    generatedAt: modelingV3 ? new Date(0).toISOString() : new Date().toISOString(),
    project: projectName,
    projectRoot,
    domains,
    blocks,
    blockDeclarations: knowledgeBlocks,
    businessViews,
    terms,
    notebooks,
    metrics,
    dimensions,
    sources: modelingV3 ? stripDbtOwnedSourceDetails(sources) : sources,
    apps: Object.keys(apps).length > 0 ? apps : undefined,
    dashboards: Object.keys(dashboards).length > 0 ? dashboards : undefined,
    lineage,
    dbtImport: modelingV3 ? undefined : dbtImport,
    dbtProvenance: dbtFirstModeling?.provenance,
    modeling: dbtFirstModeling?.modeling,
    diagnostics,
  };
  if (!modelingV3) return baseManifest;

  const skillCatalog = loadManifestKnowledgeSkills(projectRoot, packageRegistry);
  diagnostics.push(...skillCatalog.diagnostics);
  const inlineKnowledgeGraph = buildManifestKnowledgeGraph({ manifest: baseManifest, skills: skillCatalog.skills, blocks: knowledgeBlocks });
  diagnostics.push(...inlineKnowledgeGraph.diagnostics);
  const knowledgeGraph = compactManifestKnowledgeGraph(inlineKnowledgeGraph);
  return { ...baseManifest, knowledgeGraph, diagnostics };
}

/**
 * Validate the Dataset declarations in one in-memory DQL source without
 * writing it into a project. Source-authoring proposals use this same
 * grammar-to-manifest validation as `buildManifest`, so an accepted proposal
 * cannot introduce a Dataset declaration which would only fail after its
 * source file has changed.
 */
export function validateDatasetBlockSource(source: string, filePath = '<memory>.dql'): {
  blocks: ManifestBlock[];
  diagnostics: ManifestDiagnostic[];
} {
  const diagnostics: ManifestDiagnostic[] = [];
  const ast = new Parser(source, filePath).parse();
  const blocks: ManifestBlock[] = [];
  for (const statement of ast.statements) {
    const block = statement as any;
    if (block.kind !== 'BlockDecl') continue;
    const manifestBlock = blockDeclToManifestBlock(block, filePath);
    validateDatasetBlockContract(manifestBlock, diagnostics);
    blocks.push(manifestBlock);
  }
  return { blocks, diagnostics };
}

/**
 * A file inside a Domain Package inherits that package's stable id. Explicit
 * display-name aliases are canonicalized; a conflicting declaration is an
 * error instead of silently splitting ownership between manifest projections.
 */
function applyDomainPackageOwnership(
  projectRoot: string,
  registry: DomainPackageRegistryResult,
  blocks: Record<string, ManifestBlock>,
  businessViews: Record<string, ManifestBusinessView>,
  terms: Record<string, ManifestTerm>,
  diagnostics: ManifestDiagnostic[],
): void {
  const assign = (kind: string, value: { filePath: string; domain?: string }) => {
    const sourcePath = value.filePath.split('#')[0];
    const pkg = registry.packageForPath(join(projectRoot, sourcePath));
    if (!pkg) return;
    const explicit = value.domain?.trim();
    if (!explicit || explicit === pkg.id || explicit === pkg.name) {
      value.domain = pkg.id;
      return;
    }
    diagnostics.push({
      kind: 'resolve',
      filePath: value.filePath,
      severity: 'error',
      message: `${kind} domain "${explicit}" conflicts with owning Domain Package "${pkg.id}".`,
    });
  };
  for (const block of Object.values(blocks)) assign('Block', block);
  for (const view of Object.values(businessViews)) assign('Business view', view);
  for (const term of Object.values(terms)) assign('Term', term);
}

function applyDomainPackageOwnershipToValues(
  projectRoot: string,
  registry: DomainPackageRegistryResult,
  values: Array<{ filePath: string; domain?: string }>,
  kind: string,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const value of values) {
    const sourcePath = value.filePath.split('#')[0];
    const pkg = registry.packageForPath(join(projectRoot, sourcePath));
    if (!pkg) continue;
    const explicit = value.domain?.trim();
    if (!explicit || explicit === pkg.id || explicit === pkg.name) {
      value.domain = pkg.id;
      continue;
    }
    // The legacy selected map already reports the same conflict. Only report
    // catalog-only duplicates that did not survive that compatibility view.
    if (!Object.values(values).some((candidate) => candidate !== value && candidate.filePath === value.filePath)) {
      diagnostics.push({ kind: 'resolve', filePath: value.filePath, severity: 'error', message: `${kind} domain "${explicit}" conflicts with owning Domain Package "${pkg.id}".` });
    }
  }
}

// ---- Project Config ----

interface ProjectConfig {
  project?: string;
  /** Git-owned OSS workspace layout. Skills may live in the surrounding dbt repo. */
  layout?: { version?: number; mode?: string; skillsPath?: string };
  /** Manifest v3 is opt-in and only active with `modeling.mode: "dbt-first"`. */
  manifestVersion?: 1 | 2 | 3;
  modeling?: {
    /** `warehouse-first` and `hybrid` bind entities to warehouse relations (RFC 0007). */
    mode?: 'dbt-first' | 'warehouse-first' | 'hybrid';
  };
  semanticLayer?: { provider?: string; path?: string; projectPath?: string };
  dataDir?: string;
  /** Selective dbt import filters; merged into buildManifest options. */
  dbtImport?: DbtImportFilters;
  /**
   * dbt integration — so commands can default to the right manifest path
   * without the user re-typing `--dbt-manifest` on every invocation.
   */
  dbt?: {
    /** Path to the dbt project root (absolute, or relative to projectRoot) */
    projectDir?: string;
    /** Path to the dbt manifest.json, relative to `projectDir`. Default: target/manifest.json */
    manifestPath?: string;
    /** Directory containing dbt profiles.yml; used by runtime onboarding, never copied into the manifest. */
    profilesDir?: string;
    /** Optional remote source provenance retained by dbt-first onboarding. */
    repoUrl?: string;
    branch?: string;
    subPath?: string;
  };
  /** Optional interop path to a DataLex compiler manifest. ZLens itself does not require DataLex. */
  datalex?: {
    /** Path to datalex-manifest.json, absolute or relative to projectRoot */
    manifestPath?: string;
  };
  /**
   * Optional `zlens propose` conventions. Refines the convention-agnostic
   * classifier + bounded selection. All fields are optional; defaults apply.
   */
  propose?: {
    /** Folders/tags that mean business (default ["marts","core","reporting"]). */
    businessLayers?: string[];
    /** Folders/tags that mean plumbing (default ["staging","intermediate","base"]). */
    excludeLayers?: string[];
    /** Max candidates generated per domain (default 8). */
    maxPerDomain?: number;
    /** Minimum demand score a candidate needs to be selected (default 0). */
    minScore?: number;
    /** Optional AI enrichment toggle (default "auto"). */
    aiEnrichment?: 'auto' | 'on' | 'off';
  };
}

/**
 * Load `dql.config.json`. Exposed so CLI commands can read the same config
 * the manifest builder uses — no need for each command to re-implement parse.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Resolve the absolute path to the configured dbt manifest.json (if any).
 * Honors explicit CLI flag first, then `dbt.projectDir + dbt.manifestPath` from
 * config, then the conventional `target/manifest.json` inside the project root.
 * Returns `null` if none of those exist.
 */
export function resolveDbtManifestPath(
  projectRoot: string,
  explicit?: string,
): string | null {
  if (explicit) {
    return isAbsPath(explicit) ? explicit : join(projectRoot, explicit);
  }
  const config = loadProjectConfig(projectRoot);
  if (config.dbt?.projectDir) {
    const dbtRoot = isAbsPath(config.dbt.projectDir)
      ? config.dbt.projectDir
      : join(projectRoot, config.dbt.projectDir);
    const rel = config.dbt.manifestPath ?? 'target/manifest.json';
    const abs = isAbsPath(rel) ? rel : join(dbtRoot, rel);
    if (existsSync(abs)) return abs;
  }
  const fallback = join(projectRoot, 'target', 'manifest.json');
  if (existsSync(fallback)) return fallback;
  return null;
}

/**
 * Resolve the absolute path to the configured DataLex manifest.
 * Honors explicit CLI flag first, then `datalex.manifestPath` from config,
 * then `<projectRoot>/datalex-manifest.json`.
 */
export function resolveDataLexManifestPath(
  projectRoot: string,
  explicit?: string,
  loadedConfig?: ProjectConfig,
): string | null {
  if (explicit) {
    const abs = isAbsPath(explicit) ? explicit : join(projectRoot, explicit);
    return existsSync(abs) ? abs : abs;
  }
  const config = loadedConfig ?? loadProjectConfig(projectRoot);
  if (config.datalex?.manifestPath) {
    const rel = config.datalex.manifestPath;
    const abs = isAbsPath(rel) ? rel : join(projectRoot, rel);
    if (existsSync(abs)) return abs;
    return abs;
  }
  const fallback = join(projectRoot, 'datalex-manifest.json');
  if (existsSync(fallback)) return fallback;
  return null;
}

function isAbsPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Remove physical dbt payloads before serializing a v3 lineage graph. */
function stripDbtImportDetails(dbtImport: ManifestDbtImport | undefined): ManifestDbtImport | undefined {
  if (!dbtImport?.dbtDag) return dbtImport;
  return {
    ...dbtImport,
    dbtDag: {
      edges: dbtImport.dbtDag.edges,
      models: dbtImport.dbtDag.models.map(({ columns: _columns, description: _description, ...model }) => model),
    },
  };
}

/** Keep source names/usage but never serialize dbt-owned schema content in v3. */
function stripDbtOwnedSourceDetails(sources: Record<string, ManifestSource>): Record<string, ManifestSource> {
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    const { dbtModel: _dbtModel, ...sparseSource } = source;
    return [name, sparseSource];
  }));
}

/**
 * Add DQL-owned analytical bindings and relationship proof to lineage without
 * mutating or reclassifying dbt transformation edges. A relationship edge is
 * intentionally distinct from dbt `depends_on`: it is a reviewed analytical
 * join policy, not inferred DAG evidence.
 */
function appendDbtFirstModelingLineage(lineage: ManifestLineage, modeling: ManifestDbtFirstModeling): void {
  const existingNodeIds = new Set(lineage.nodes.map((node) => node.id));
  const existingEdges = new Set(lineage.edges.map((edge) => `${edge.source}:${edge.target}:${edge.type}`));
  const dbtNodeByUniqueId = new Map<string, string>();
  for (const node of lineage.nodes) {
    const uniqueId = typeof node.metadata?.uniqueId === 'string' ? node.metadata.uniqueId : undefined;
    if (uniqueId) dbtNodeByUniqueId.set(uniqueId, node.id);
  }
  const addEdge = (source: string, target: string, type: string) => {
    const key = `${source}:${target}:${type}`;
    if (!existingEdges.has(key)) {
      lineage.edges.push({ source, target, type });
      existingEdges.add(key);
    }
  };

  for (const entity of Object.values(modeling.entities)) {
    const entityId = `dql_entity:${entity.id}`;
    if (!existingNodeIds.has(entityId)) {
      lineage.nodes.push({
        id: entityId,
        type: 'dql_entity',
        name: entity.id,
        layer: 'answer',
        domain: entity.domain,
        filePath: entity.sourcePath,
        metadata: {
          dbtUniqueId: entity.dbtUniqueId,
          grain: entity.grain,
          keys: entity.keys,
          identityFingerprint: entity.identityFingerprint,
          provenance: 'dql sparse overlay',
        },
      });
      existingNodeIds.add(entityId);
    }
    const dbtNode = dbtNodeByUniqueId.get(entity.dbtUniqueId);
    if (dbtNode) addEdge(dbtNode, entityId, 'binds_dbt_model');
  }

  for (const relationship of Object.values(modeling.relationships)) {
    addEdge(`dql_entity:${relationship.from}`, `dql_entity:${relationship.to}`, 'governed_relationship');
  }
}

function resolveSemanticPath(projectRoot: string, config: ProjectConfig): string {
  const customPath = config.semanticLayer?.path;
  if (customPath) return join(projectRoot, customPath);
  return join(projectRoot, 'semantic-layer');
}

// ---- Recursive File Scanner ----

interface ManifestScanCache {
  filesByDirectory: Map<string, string[]>;
  sources: Map<string, string>;
  parsedSources?: Map<string, CachedManifestSource>;
}

interface CachedManifestSource {
  source: string;
  ast: ReturnType<Parser['parse']>;
}

// Keep only the most recently compiled project roots. Source text is compared
// before any AST reuse, so this is a parser cache rather than a stale-source
// cache; it makes watcher-triggered one-file edits avoid reparsing the other
// thousands of unchanged DQL declarations.
const MAX_MANIFEST_PARSE_CACHE_PROJECTS = 4;
const manifestParseCaches = new Map<string, Map<string, CachedManifestSource>>();

function createManifestScanCache(projectRoot?: string): ManifestScanCache {
  let parsedSources: Map<string, CachedManifestSource> | undefined;
  if (projectRoot) {
    parsedSources = manifestParseCaches.get(projectRoot);
    if (parsedSources) {
      // Map insertion order doubles as a tiny LRU.
      manifestParseCaches.delete(projectRoot);
      manifestParseCaches.set(projectRoot, parsedSources);
    } else {
      parsedSources = new Map();
      manifestParseCaches.set(projectRoot, parsedSources);
      while (manifestParseCaches.size > MAX_MANIFEST_PARSE_CACHE_PROJECTS) {
        const oldest = manifestParseCaches.keys().next().value;
        if (!oldest) break;
        manifestParseCaches.delete(oldest);
      }
    }
  }
  return { filesByDirectory: new Map(), sources: new Map(), parsedSources };
}

function scanFilesRecursive(
  dir: string,
  extensions: string[],
  cache?: ManifestScanCache,
): string[] {
  const cacheKey = `${dir}\u0000${[...extensions].sort().join(',')}`;
  const cached = cache?.filesByDirectory.get(cacheKey);
  if (cached) return cached;
  const results: string[] = [];
  if (!existsSync(dir)) {
    cache?.filesByDirectory.set(cacheKey, results);
    return results;
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...scanFilesRecursive(fullPath, extensions, cache));
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      results.push(fullPath);
    }
  }
  cache?.filesByDirectory.set(cacheKey, results);
  return results;
}

function readManifestSource(filePath: string, cache?: ManifestScanCache): string {
  const cached = cache?.sources.get(filePath);
  if (cached !== undefined) return cached;
  const source = readFileSync(filePath, 'utf-8');
  cache?.sources.set(filePath, source);
  return source;
}

function parseManifestSource(
  source: string,
  relPath: string,
  filePath: string,
  cache?: ManifestScanCache,
): ReturnType<Parser['parse']> {
  const cached = cache?.parsedSources?.get(filePath);
  if (cached?.source === source) return cached.ast;
  const ast = new Parser(source, relPath).parse();
  cache?.parsedSources?.set(filePath, { source, ast });
  return ast;
}

// ---- Block Scanning ----

function scanDomains(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  scanCache?: ManifestScanCache,
): Record<string, ManifestDomain> {
  const domains: Record<string, ManifestDomain> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql'], scanCache);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readManifestSource(filePath, scanCache);
        if (!/(^|\n)\s*domain\s+"/.test(source)) continue;
        const ast = parseManifestSource(source, relPath, filePath, scanCache);

        for (const stmt of ast.statements) {
          const domain = stmt as any;
          if (domain.kind !== 'DomainDecl') continue;

          if (domains[domain.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate domain "${domain.name}" also declared in ${domains[domain.name].filePath}`,
            });
            continue;
          }

          domains[domain.name] = domainDeclToManifestDomain(domain, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse domain file: ${msg}`,
        });
      }
    }
  }

  return domains;
}

/** Validate parent references without changing legacy flat-domain semantics. */
function validateDomainHierarchy(
  domains: Record<string, ManifestDomain>,
  diagnostics: ManifestDiagnostic[],
): void {
  const keyFor = (value: string) => domainAliasKey(value);
  // A parent may be named by the child's `parent = "<id>"`, by the display
  // name, or by the folder: all three are the same domain.
  const byKey = new Map<string, ManifestDomain>();
  for (const domain of Object.values(domains)) {
    for (const alias of [domain.id, domain.name, domain.filePath?.replace(/\\/g, '/').match(/^domains\/(?:.*\/)?([^/]+)\/[^/]+$/)?.[1]]) if (alias) byKey.set(keyFor(alias), domain);
  }
  for (const domain of Object.values(domains)) {
    if (!domain.parent) continue;
    const parent = byKey.get(keyFor(domain.parent));
    if (!parent) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'error',
        message: `domain "${domain.name}" references missing parent "${domain.parent}"`,
      });
      continue;
    }
    const visited = new Set<string>([keyFor(domain.name)]);
    let current: ManifestDomain | undefined = parent;
    while (current?.parent) {
      const currentKey = keyFor(current.name);
      if (visited.has(currentKey)) {
        diagnostics.push({
          kind: 'resolve',
          filePath: domain.filePath,
          severity: 'error',
          message: `domain hierarchy contains a cycle involving "${domain.name}"`,
        });
        break;
      }
      visited.add(currentKey);
      current = byKey.get(keyFor(current.parent));
    }
  }
}

function scanBlocks(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
  scanCache?: ManifestScanCache,
): { blocks: Record<string, ManifestBlock>; all: ManifestBlock[] } {
  const blocks: Record<string, ManifestBlock> = {};
  const all: ManifestBlock[] = [];
  const seenFiles = new Set<string>();
  let companionRegistry: DomainPackageRegistryResult | undefined;

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql'], scanCache);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readManifestSource(filePath, scanCache);
        const ast = parseManifestSource(source, relPath, filePath, scanCache);
        collectContractDiagnostics(ast, relPath, diagnostics, datalexRegistry);

        for (const stmt of ast.statements) {
          const block = stmt as any;
          if (block.kind !== 'BlockDecl') continue;

          const nextBlock = blockDeclToManifestBlock(block, relPath);
          markChangedSinceCertified(projectRoot, nextBlock, source, diagnostics, () => {
            companionRegistry ??= loadDomainPackageRegistry(projectRoot);
            return companionRegistry;
          });
          validateDatasetBlockContract(nextBlock, diagnostics);
          all.push(nextBlock);
          if (blocks[block.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'warning',
              message: `duplicate block "${block.name}" also declared in ${blocks[block.name].filePath}`,
            });
          }
          if (!blocks[block.name] || shouldReplaceDuplicateBlock(blocks[block.name], nextBlock)) {
            blocks[block.name] = nextBlock;
          }
        }
      } catch (err) {
        // Surface parse failures as diagnostics instead of silently dropping
        // the file. Users see a concrete error + path; `zlens doctor` picks it up.
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse block file: ${msg}`,
        });
      }
    }
  }

  return { blocks, all };
}

/**
 * A block certified by an explicit Certify action carries a receipt with the
 * fingerprint of the source it certified. When the source on disk no longer
 * matches it, the block was edited after certification (outside ZLens, which
 * demotes an edited block on save): report it as pending recertification and
 * say so. A block with no receipt (certified before receipts) stays certified.
 */
function markChangedSinceCertified(
  projectRoot: string,
  block: ManifestBlock,
  source: string,
  diagnostics: ManifestDiagnostic[] | undefined,
  registry: () => DomainPackageRegistryResult,
): void {
  if (block.status !== 'certified') return;
  const { state, companionPath } = certifiedBlockFileState(projectRoot, block.filePath, source, {
    packageForPath: (filePath) => registry().packageForPath(filePath),
  });
  if (state !== 'changed') return;
  block.status = 'pending_recertification';
  block.certificationSourceChanged = true;
  diagnostics?.push({
    kind: 'resolve',
    filePath: block.filePath,
    severity: 'warning',
    message: changedSinceCertifiedMessage(block.name, companionPath),
  });
}

function shouldReplaceDuplicateBlock(existing: ManifestBlock, next: ManifestBlock): boolean {
  return duplicateBlockPriority(next) > duplicateBlockPriority(existing);
}

function duplicateBlockPriority(block: ManifestBlock): number {
  let score = 0;
  if (block.status === 'certified') score += 100;
  else if (block.status === 'review') score += 60;
  else if (block.status === 'draft') score += 20;
  else score += 10;
  const path = block.filePath.replaceAll('\\', '/');
  if (!path.includes('/_drafts/') && !path.startsWith('_drafts/') && !path.startsWith('blocks/_drafts/')) score += 10;
  if (path.startsWith('domains/') || path.startsWith('blocks/')) score += 5;
  return score;
}

// ---- Business View Scanning ----

function scanBusinessViews(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  scanCache?: ManifestScanCache,
): Record<string, ManifestBusinessView> {
  const views: Record<string, ManifestBusinessView> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql'], scanCache);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readManifestSource(filePath, scanCache);
        if (!source.includes('business_view')) continue;
        const ast = parseManifestSource(source, relPath, filePath, scanCache);

        for (const stmt of ast.statements) {
          const view = stmt as any;
          if (view.kind !== 'BusinessViewDecl') continue;

          if (views[view.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate business_view "${view.name}" also declared in ${views[view.name].filePath}`,
            });
            continue;
          }

          views[view.name] = businessViewDeclToManifestBusinessView(view, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse business view file: ${msg}`,
        });
      }
    }
  }

  return views;
}

// ---- Business Term Scanning ----

function scanTerms(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  scanCache?: ManifestScanCache,
): Record<string, ManifestTerm> {
  const terms: Record<string, ManifestTerm> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql'], scanCache);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readManifestSource(filePath, scanCache);
        if (!source.includes('term')) continue;
        const ast = parseManifestSource(source, relPath, filePath, scanCache);

        for (const stmt of ast.statements) {
          const term = stmt as any;
          if (term.kind !== 'TermDecl') continue;

          if (terms[term.name]) {
            // Two DOMAINS may each define the same business word differently
            // ("Revenue" is ordered in Commerce and invoiced in Finance): the
            // second is kept under its qualified key, and a pinned domain's
            // envelope decides which one an answer reads (ID-001). The same
            // name twice in ONE domain is still a duplicate.
            const existing = terms[term.name];
            const incoming = termDeclToManifestTerm(term, relPath);
            if (incoming.domain && existing.domain && existing.domain !== incoming.domain && !terms[`${incoming.domain}::${term.name}`]) {
              terms[`${incoming.domain}::${term.name}`] = incoming;
              continue;
            }
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate term "${term.name}" also declared in ${terms[term.name].filePath}`,
            });
            continue;
          }

          terms[term.name] = termDeclToManifestTerm(term, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse term file: ${msg}`,
        });
      }
    }
  }

  return terms;
}

function validateDomains(
  domains: Record<string, ManifestDomain>,
  blocks: Record<string, ManifestBlock>,
  views: Record<string, ManifestBusinessView>,
  terms: Record<string, ManifestTerm>,
  diagnostics: ManifestDiagnostic[],
): void {
  const resolveDomain = createManifestDomainResolver(domains);
  const declaredDomains = new Set(Object.values(domains).map((domain) => domain.name));
  const usedDomains = new Map<string, string[]>();
  const addUse = (domain: string | undefined, label: string) => {
    if (!domain) return;
    const resolvedDomain = resolveDomain(domain);
    const list = usedDomains.get(resolvedDomain) ?? [];
    list.push(label);
    usedDomains.set(resolvedDomain, list);
  };

  for (const block of Object.values(blocks)) {
    addUse(block.domain, `block "${block.name}"`);
    if (!block.domain) {
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'warning',
        message: `block "${block.name}" is missing a domain. Add a domain field or place it under domains/<domain>/blocks/.`,
      });
    }
  }
  for (const view of Object.values(views)) addUse(view.domain, `business_view "${view.name}"`);
  for (const term of Object.values(terms)) addUse(term.domain, `term "${term.name}"`);

  for (const block of Object.values(blocks)) {
    if (!block.domain) continue;
    const blockDomain = resolveDomain(block.domain);
    for (const ref of block.refDependencies ?? []) {
      const dependency = blocks[ref];
      const dependencyDomain = dependency?.domain ? resolveDomain(dependency.domain) : undefined;
      if (!dependencyDomain || dependencyDomain === blockDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'warning',
        message: `block "${block.name}" in domain "${blockDomain}" depends on block "${dependency.name}" in domain "${dependencyDomain}". Mark this as a bridge pattern or document the cross-domain dependency.`,
      });
    }
  }
  for (const view of Object.values(views)) {
    if (!view.domain) continue;
    const viewDomain = resolveDomain(view.domain);
    for (const ref of view.blockRefs ?? []) {
      const block = blocks[ref];
      const blockDomain = block?.domain ? resolveDomain(block.domain) : undefined;
      if (!blockDomain || blockDomain === viewDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'warning',
        message: `business_view "${view.name}" in domain "${viewDomain}" includes block "${block.name}" from domain "${blockDomain}". Review the cross-domain dependency.`,
      });
    }
    for (const ref of view.businessViewRefs ?? []) {
      const dependency = views[ref];
      const dependencyDomain = dependency?.domain ? resolveDomain(dependency.domain) : undefined;
      if (!dependencyDomain || dependencyDomain === viewDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'warning',
        message: `business_view "${view.name}" in domain "${viewDomain}" includes business_view "${dependency.name}" from domain "${dependencyDomain}". Review the cross-domain dependency.`,
      });
    }
  }

  for (const [domain, users] of usedDomains) {
    if (!declaredDomains.has(domain)) {
      diagnostics.push({
        kind: 'resolve',
        severity: 'warning',
        message: `domain "${domain}" is used by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ` and ${users.length - 3} more` : ''} but has no first-class domain declaration.`,
      });
    }
  }

  for (const domain of Object.values(domains)) {
    if (!domain.owner) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" is missing owner metadata.`,
      });
    }
    if (!domain.reviewCadence) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" is missing reviewCadence metadata.`,
      });
    } else {
      const cadenceDays = reviewCadenceDays(domain.reviewCadence);
      if (cadenceDays === null) {
        diagnostics.push({
          kind: 'resolve',
          filePath: domain.filePath,
          severity: 'warning',
          message: `domain "${domain.name}" has unrecognized reviewCadence "${domain.reviewCadence}". Use daily, weekly, biweekly, monthly, quarterly, semiannual, or annual.`,
        });
      } else if (cadenceDays > 180) {
        diagnostics.push({
          kind: 'resolve',
          filePath: domain.filePath,
          severity: 'warning',
          message: `domain "${domain.name}" reviewCadence "${domain.reviewCadence}" is stale for enterprise use. Prefer quarterly or more frequent review for active domains.`,
        });
      }
    }
    if (!usedDomains.has(domain.name)) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" has no terms, blocks, or business views yet.`,
      });
    }
  }
}

function createManifestDomainResolver(domains: Record<string, ManifestDomain>): (domain: string) => string {
  const aliases = new Map<string, string>();
  for (const domain of Object.values(domains)) {
    aliases.set(domain.name, domain.name);
    aliases.set(domainAliasKey(domain.name), domain.name);
    if (domain.id) { aliases.set(domain.id, domain.name); aliases.set(domainAliasKey(domain.id), domain.name); }
    const folderAlias = domain.filePath?.replace(/\\/g, '/').match(/^domains\/([^/]+)\//)?.[1];
    if (folderAlias) aliases.set(domainAliasKey(folderAlias), domain.name);
  }
  return (domain) => aliases.get(domain) ?? aliases.get(domainAliasKey(domain)) ?? domain;
}

function domainAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function reviewCadenceDays(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return null;
  if (normalized === 'daily' || normalized === 'day') return 1;
  if (normalized === 'weekly' || normalized === 'week') return 7;
  if (normalized === 'biweekly' || normalized === 'fortnightly') return 14;
  if (normalized === 'monthly' || normalized === 'month') return 30;
  if (normalized === 'quarterly' || normalized === 'quarter') return 90;
  if (normalized === 'semiannual' || normalized === 'semiannually' || normalized === 'halfyearly') return 180;
  if (normalized === 'annual' || normalized === 'annually' || normalized === 'yearly') return 365;
  const everyMatch = normalized.match(/^every(\d+)(day|days|week|weeks|month|months)$/);
  if (!everyMatch) return null;
  const amount = Number(everyMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = everyMatch[2];
  if (unit.startsWith('day')) return amount;
  if (unit.startsWith('week')) return amount * 7;
  if (unit.startsWith('month')) return amount * 30;
  return null;
}

function validateBusinessViews(
  views: Record<string, ManifestBusinessView>,
  blocks: Record<string, ManifestBlock>,
  diagnostics: ManifestDiagnostic[],
): void {
  const blockNames = new Set(Object.keys(blocks));
  const viewNames = new Set(Object.keys(views));

  for (const view of Object.values(views)) {
    view.unresolvedBlockRefs = view.blockRefs.filter((ref) => !blockNames.has(ref));
    view.blockRefs = view.blockRefs.filter((ref) => blockNames.has(ref));
    view.unresolvedBusinessViewRefs = view.businessViewRefs.filter((ref) => !viewNames.has(ref));
    view.businessViewRefs = view.businessViewRefs.filter((ref) => viewNames.has(ref));

    if (view.unresolvedBlockRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved block refs: ${view.unresolvedBlockRefs.join(', ')}`,
      });
    }

    if (view.unresolvedBusinessViewRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved business_view refs: ${view.unresolvedBusinessViewRefs.join(', ')}`,
      });
    }
  }

  detectBusinessViewCycles(views, diagnostics);
}

function validateTermRefs(
  terms: Record<string, ManifestTerm>,
  blocks: Record<string, ManifestBlock>,
  views: Record<string, ManifestBusinessView>,
  diagnostics: ManifestDiagnostic[],
): void {
  const termNames = new Set(Object.keys(terms));

  for (const block of Object.values(blocks)) {
    const declared = block.termRefs ?? [];
    block.unresolvedTermRefs = declared.filter((ref) => !termNames.has(ref));
    block.termRefs = declared.filter((ref) => termNames.has(ref));
    if (block.unresolvedTermRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'error',
        message: `block "${block.name}" has unresolved term refs: ${block.unresolvedTermRefs.join(', ')}`,
      });
    }
  }

  for (const view of Object.values(views)) {
    const declared = view.declaredTermRefs ?? [];
    view.unresolvedTermRefs = declared.filter((ref) => !termNames.has(ref));
    view.declaredTermRefs = declared.filter((ref) => termNames.has(ref));
    if (view.unresolvedTermRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved term refs: ${view.unresolvedTermRefs.join(', ')}`,
      });
    }
  }

  const collectTermsForView = (viewName: string, seen = new Set<string>()): string[] => {
    const view = views[viewName];
    if (!view || seen.has(viewName)) return [];
    seen.add(viewName);
    const refs = new Set<string>(view.declaredTermRefs ?? []);
    for (const blockRef of view.blockRefs) {
      for (const termRef of blocks[blockRef]?.termRefs ?? []) refs.add(termRef);
    }
    for (const viewRef of view.businessViewRefs) {
      for (const termRef of collectTermsForView(viewRef, seen)) refs.add(termRef);
    }
    return [...refs];
  };

  for (const view of Object.values(views)) {
    const declaredSet = new Set(view.declaredTermRefs ?? []);
    const allRefs = collectTermsForView(view.name);
    view.termRefs = allRefs;
    view.inheritedTermRefs = allRefs.filter((ref) => !declaredSet.has(ref));
  }
}

function detectBusinessViewCycles(
  views: Record<string, ManifestBusinessView>,
  diagnostics: ManifestDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart), name];
      const key = cycle.join(' -> ');
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push({
          kind: 'resolve',
          filePath: views[name]?.filePath,
          severity: 'error',
          message: `business_view cycle detected: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }

    visiting.add(name);
    stack.push(name);
    for (const ref of views[name]?.businessViewRefs ?? []) {
      visit(ref);
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of Object.keys(views)) {
    visit(name);
  }
}

// ---- Notebook Scanning ----

function scanNotebooks(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
): Record<string, ManifestNotebook> {
  const notebooks: Record<string, ManifestNotebook> = {};
  const seen = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dqlnb']);

    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      try {
        const raw = readFileSync(filePath, 'utf-8');
        const relPath = relative(projectRoot, filePath);
        const doc = JSON.parse(raw);

        if (doc.version !== 1 || !Array.isArray(doc.cells)) continue;

        const cells: ManifestNotebookCell[] = [];

        for (const cell of doc.cells) {
          const type = cell.type;
          if (type !== 'sql' && type !== 'dql') continue;

          const source = cell.source ?? cell.content ?? '';
          if (!source.trim()) continue;

          let sqlToAnalyze = source;
          let blockName: string | undefined;

          // For DQL cells, try to extract the block's SQL
          if (type === 'dql') {
            try {
              const parser = new Parser(source, `${relPath}:${cell.id}`);
              const ast = parser.parse();
              collectContractDiagnostics(ast, relPath, diagnostics, datalexRegistry);
              for (const stmt of ast.statements) {
                if ((stmt as any).kind === 'BlockDecl') {
                  blockName = (stmt as any).name;
                  sqlToAnalyze = (stmt as any).query?.rawSQL ?? source;
                  break;
                }
              }
            } catch {
              // Fall back to analyzing the raw source as SQL
            }
          }

          const parseResult = extractTablesFromSql(sqlToAnalyze);

          // Find if any chart cell references this cell
          const chartCell = doc.cells.find(
            (c: any) => c.type === 'chart' && c.config?.sourceCellId === cell.id,
          );

          cells.push({
            id: cell.id ?? `cell-${cells.length}`,
            type,
            title: cell.title ?? cell.name,
            source,
            tableDependencies: parseResult.tables.map(normalizeTableName),
            refDependencies: parseResult.refs,
            blockName,
            chartType: chartCell?.config?.chart,
            bindingPath: typeof cell.blockBinding?.path === 'string' ? cell.blockBinding.path : undefined,
          });
        }

        if (cells.length > 0) {
          const productContext = normalizeProductDomainContext(
            doc.metadata ?? {},
            stringOrUndefined(doc.metadata?.domain),
          );
          notebooks[relPath] = {
            title: doc.metadata?.title ?? doc.title ?? relPath,
            filePath: relPath,
            ...productContext,
            cells,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relative(projectRoot, filePath),
          severity: 'error',
          message: `Failed to parse notebook: ${msg}`,
        });
      }
    }
  }

  return notebooks;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

/**
 * The placeholder block older welcome notebooks carried ("Example Customer
 * Rollup", `SELECT 1 AS customer_count`). It is not data anyone can use, so it
 * never becomes a block: it showed up in every new App's Data step (design D7).
 * Only the untouched starter is skipped; an edited copy is a real block.
 */
export function isStarterPlaceholderBlock(blockName: string | undefined, sql: string | undefined): boolean {
  if (blockName !== 'Example Customer Rollup') return false;
  return (sql ?? '').replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase() === 'select 1 as customer_count';
}

/** Extract blocks declared inside notebook DQL cells into the blocks map. */
function extractNotebookBlocks(notebooks: Record<string, ManifestNotebook>): Record<string, ManifestBlock> {
  const blocks: Record<string, ManifestBlock> = {};

  for (const [nbPath, nb] of Object.entries(notebooks)) {
    for (const cell of nb.cells) {
      if (cell.type !== 'dql' || !cell.blockName) continue;
      const placeholder = /query\s*=\s*"""([\s\S]*?)"""/i.exec(cell.source)?.[1];
      if (isStarterPlaceholderBlock(cell.blockName, placeholder)) continue;

      // Only add if not already found as a standalone block file
      if (!blocks[cell.blockName]) {
        try {
          const ast = new Parser(cell.source, `${nbPath}:${cell.id}`).parse();
          const block = ast.statements.find((stmt: any) => stmt.kind === 'BlockDecl' && stmt.name === cell.blockName);
          if (block) {
            blocks[cell.blockName] = blockDeclToManifestBlock(block, `${nbPath}#${cell.id}`);
          }
        } catch {
          const parseResult = extractTablesFromSql(cell.source);
          blocks[cell.blockName] = {
            name: cell.blockName,
            filePath: `${nbPath}#${cell.id}`,
            sql: '',
            rawTableRefs: parseResult.tables,
            tableDependencies: parseResult.tables.map(normalizeTableName),
            refDependencies: parseResult.refs,
            allDependencies: [...parseResult.refs, ...parseResult.tables.map(normalizeTableName)],
            tests: [],
          };
        }
      }
    }
  }

  return blocks;
}

/** Extract terms declared inside notebook DQL cells into the terms map. */
function extractNotebookTerms(notebooks: Record<string, ManifestNotebook>): Record<string, ManifestTerm> {
  const terms: Record<string, ManifestTerm> = {};

  for (const [nbPath, nb] of Object.entries(notebooks)) {
    for (const cell of nb.cells) {
      if (cell.type !== 'dql' || !cell.source.includes('term')) continue;
      try {
        const ast = new Parser(cell.source, `${nbPath}:${cell.id}`).parse();
        for (const stmt of ast.statements) {
          const term = stmt as any;
          if (term.kind !== 'TermDecl' || terms[term.name]) continue;
          terms[term.name] = termDeclToManifestTerm(term, `${nbPath}#${cell.id}`);
        }
      } catch {
        // scanNotebooks already records parse diagnostics for invalid DQL cells.
      }
    }
  }

  return terms;
}

// ---- Semantic Layer ----

function loadSemanticDefinitions(
  projectRoot: string,
  semanticDir: string,
): { metrics: Record<string, ManifestMetric>; dimensions: Record<string, ManifestDimension> } {
  const metrics: Record<string, ManifestMetric> = {};
  const dimensions: Record<string, ManifestDimension> = {};

  if (!existsSync(semanticDir)) return { metrics, dimensions };

  try {
    const layer = loadSemanticLayerFromDir(semanticDir);

    for (const m of layer.listMetrics()) {
      metrics[m.name] = {
        name: m.name,
        label: m.label,
        type: m.type,
        table: m.table,
        domain: m.domain,
        status: m.status,
        description: m.description,
        sql: m.sql,
        owner: m.owner,
        tags: m.tags,
        metricType: m.metricType,
        objectKind: m.objectKind,
        filePath: semanticDefinitionFilePath(projectRoot, semanticDir, m.source?.extra),
      };
    }

    for (const d of layer.listDimensions()) {
      const timeDim = layer.getTimeDimension(d.name);
      dimensions[d.name] = {
        name: d.name,
        label: d.label,
        table: d.table,
        domain: d.domain,
        type: d.type,
        status: d.status,
        description: d.description,
        sql: d.sql,
        owner: d.owner,
        tags: d.tags,
        qualifiedName: d.qualifiedName,
        isTimeDimension: d.isTimeDimension,
        granularities: timeDim?.granularities,
        filePath: semanticDefinitionFilePath(projectRoot, semanticDir, d.source?.extra),
      };
    }
  } catch {
    // Non-fatal — semantic layer may not exist or be misconfigured
  }

  return { metrics, dimensions };
}

function semanticDefinitionFilePath(
  projectRoot: string,
  semanticDir: string,
  extra: Record<string, unknown> | undefined,
): string | undefined {
  const path = extra?.path;
  if (typeof path !== 'string' || path.trim().length === 0) return undefined;
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('semantic-layer/')) return normalized;
  return relative(projectRoot, join(semanticDir, normalized)).replace(/\\/g, '/');
}

// ---- Source Collection ----

function collectSources(
  blocks: Record<string, ManifestBlock>,
  notebooks: Record<string, ManifestNotebook>,
  metrics: Record<string, ManifestMetric>,
  dimensions: Record<string, ManifestDimension>,
): Record<string, ManifestSource> {
  const sources: Record<string, ManifestSource> = {};

  function ensureSource(name: string, origin: 'sql' | 'semantic', rawRef?: string): ManifestSource {
    if (!sources[name]) {
      sources[name] = { name, origin, rawRef, referencedBy: [] };
    }
    return sources[name];
  }

  // From blocks
  for (const block of Object.values(blocks)) {
    for (let i = 0; i < block.tableDependencies.length; i++) {
      const tableName = block.tableDependencies[i];
      // Skip if it's actually a ref to another block
      if (blocks[tableName]) continue;
      const source = ensureSource(tableName, 'sql', block.rawTableRefs[i]);
      source.referencedBy.push(`block:${block.name}`);
    }
  }

  // From notebooks
  for (const nb of Object.values(notebooks)) {
    for (const cell of nb.cells) {
      for (const tableName of cell.tableDependencies) {
        if (blocks[tableName]) continue;
        const source = ensureSource(tableName, 'sql');
        source.referencedBy.push(`notebook:${nb.filePath}#${cell.id}`);
      }
    }
  }

  // From semantic layer
  for (const metric of Object.values(metrics)) {
    const source = ensureSource(metric.table, 'semantic');
    if (!source.referencedBy.includes(`metric:${metric.name}`)) {
      source.referencedBy.push(`metric:${metric.name}`);
    }
  }
  for (const dim of Object.values(dimensions)) {
    const source = ensureSource(dim.table, 'semantic');
    if (!source.referencedBy.includes(`dimension:${dim.name}`)) {
      source.referencedBy.push(`dimension:${dim.name}`);
    }
  }

  return sources;
}

// ---- dbt Manifest Import ----

interface DbtImportOptions {
  /** Max upstream hops from anchor tables. undefined = unlimited (follow to raw sources). */
  maxHops?: number;
  /** Auto-enable selective import when total model count exceeds this. Default: 200. */
  selectiveThreshold?: number;
  /** Tag/path/name filters for selective import. */
  filters?: DbtImportFilters;
  /**
   * Freshness-aware trust — per-uniqueId last-run/freshness state read from
   * `run_results.json`. Attached additively to emitted dbt nodes. Optional;
   * when absent no run-state is attached.
   */
  runState?: DbtRunStateIndex;
}

/**
 * Lightweight index entry built from the raw dbt manifest.
 * Kept small — only the fields needed for the BFS traversal and final import.
 */
interface DbtIndexEntry {
  uniqueId: string;
  name: string;          // alias ?? name
  type: 'model' | 'source';
  schema?: string;
  database?: string;
  dependsOn: string[];   // upstream uniqueIds
  /** Normalised lookup names (name, schema.name, db.schema.name) */
  lookupKeys: string[];
  /**
   * Lookup names built from the model's EXACT name only (no dbt role-prefix
   * stripping). Tried first during anchor resolution so a block ref like
   * `dev.customers` resolves to the `customers` mart instead of colliding with
   * the stripped alias of `stg_customers`.
   */
  primaryLookupKeys: string[];
  /** dbt tags (for `tag:<name>` filters) */
  tags: string[];
  /** File path relative to dbt project root (for `path:<prefix>` filters) */
  path?: string;
  raw: any;              // reference to the original manifest node
}

/** Parse a filter expression into a matcher function. */
function compileFilter(expr: string): (entry: DbtIndexEntry) => boolean {
  if (expr.startsWith('tag:')) {
    const tag = expr.slice(4);
    return (e) => e.tags.includes(tag);
  }
  if (expr.startsWith('path:')) {
    const prefix = expr.slice(5);
    return (e) => !!e.path && e.path.startsWith(prefix);
  }
  // Bare name — match against the model name (case-insensitive)
  const lower = expr.toLowerCase();
  return (e) => e.name.toLowerCase() === lower;
}

function compileFilters(exprs: string[] | undefined): ((e: DbtIndexEntry) => boolean) | null {
  if (!exprs || exprs.length === 0) return null;
  const matchers = exprs.map(compileFilter);
  return (entry) => matchers.some((m) => m(entry));
}

function importDbtManifest(
  manifestPath: string,
  sources: Record<string, ManifestSource>,
  referencedTables: Set<string>,
  opts: DbtImportOptions = {},
): ManifestDbtImport {
  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);
  const projectName = manifest.metadata?.project_name;

  // ── Step 1: Build a lightweight index of every model + source ──────────────
  const index = new Map<string, DbtIndexEntry>();

  const rawNodes: Record<string, any> = manifest.nodes ?? {};
  for (const [uniqueId, node] of Object.entries(rawNodes)) {
    if (node.resource_type !== 'model') continue;
    const name = (node.alias ?? node.name) as string;
    if (!name) continue;
    const schema: string | undefined = node.schema;
    const database: string | undefined = node.database;
    const dependsOn: string[] = Array.isArray(node.depends_on?.nodes) ? node.depends_on.nodes : [];
    const lookupKeys = buildLookupKeys(name, schema, database);
    const primaryLookupKeys = buildPrimaryLookupKeys(name, schema, database);
    const tags = Array.isArray(node.tags) ? (node.tags as string[]) : [];
    const path = (node.original_file_path ?? node.path) as string | undefined;
    index.set(uniqueId, { uniqueId, name, type: 'model', schema, database, dependsOn, lookupKeys, primaryLookupKeys, tags, path, raw: node });
  }

  const rawSources: Record<string, any> = manifest.sources ?? {};
  for (const [uniqueId, src] of Object.entries(rawSources)) {
    const name = (src.identifier ?? src.name) as string;
    if (!name) continue;
    const schema: string | undefined = src.schema;
    const database: string | undefined = src.database;
    const lookupKeys = buildLookupKeys(name, schema, database);
    const primaryLookupKeys = buildPrimaryLookupKeys(name, schema, database);
    const tags = Array.isArray(src.tags) ? (src.tags as string[]) : [];
    const path = (src.original_file_path ?? src.path) as string | undefined;
    index.set(uniqueId, { uniqueId, name, type: 'source', schema, database, dependsOn: [], lookupKeys, primaryLookupKeys, tags, path, raw: src });
  }

  const totalDbtModels = [...index.values()].filter((e) => e.type === 'model').length;
  const filters = opts.filters;
  const hasFilterConfig = !!(filters && (filters.anchors?.length || filters.include?.length || filters.exclude?.length));
  const useSelective = totalDbtModels > (opts.selectiveThreshold ?? 200)
    || referencedTables.size > 0
    || hasFilterConfig;

  // ── Step 2: Determine which nodes to import ────────────────────────────────
  let selectedIds: Set<string>;

  if (!useSelective) {
    // Small project: import everything (original behaviour)
    selectedIds = new Set(index.keys());
  } else {
    // Large project or explicit references: selective BFS upstream from anchors

    // Build reverse lookup: normalised table/model names -> uniqueIds.
    // Multiple dbt nodes may share a short alias, so short-name matches are
    // used only when they resolve unambiguously.
    const nameToIds = new Map<string, Set<string>>();
    const primaryNameToIds = new Map<string, Set<string>>();
    const addTo = (map: Map<string, Set<string>>, key: string, uniqueId: string) => {
      const normalized = key.toLowerCase();
      const existing = map.get(normalized);
      if (existing) existing.add(uniqueId);
      else map.set(normalized, new Set([uniqueId]));
    };
    for (const entry of index.values()) {
      for (const key of entry.lookupKeys) addTo(nameToIds, key, entry.uniqueId);
      for (const key of entry.primaryLookupKeys) addTo(primaryNameToIds, key, entry.uniqueId);
    }

    const resolveDbtAnchor = (ref: string): string | undefined => {
      const refKeys = buildReferencedTableLookupKeys(ref);
      // Prefer an unambiguous match on EXACT model names before falling back to
      // dbt role-prefix-stripped aliases — otherwise `dev.customers` is ambiguous
      // between the `customers` mart and the stripped alias of `stg_customers`,
      // and the anchor (and its whole upstream subgraph) is silently skipped.
      for (const key of refKeys) {
        const ids = primaryNameToIds.get(key);
        if (ids?.size === 1) return [...ids][0];
      }
      for (const key of refKeys) {
        const ids = nameToIds.get(key);
        if (ids?.size === 1) return [...ids][0];
      }
      return undefined;
    };

    // Anchors = DQL-referenced tables ∪ user-declared `dbtImport.anchors`
    const anchors = new Set<string>();
    for (const tableName of referencedTables) {
      const uid = resolveDbtAnchor(tableName);
      if (uid) anchors.add(uid);
    }
    for (const anchorExpr of filters?.anchors ?? []) {
      // anchors may be plain names, `tag:...`, or `path:...`
      if (anchorExpr.includes(':')) {
        const match = compileFilter(anchorExpr);
        for (const entry of index.values()) {
          if (match(entry)) anchors.add(entry.uniqueId);
        }
      } else {
        const uid = resolveDbtAnchor(anchorExpr);
        if (uid) anchors.add(uid);
      }
    }

    // BFS upstream through depends_on edges
    selectedIds = new Set<string>(anchors);
    let frontier = [...anchors];
    let hop = 0;

    while (frontier.length > 0 && (opts.maxHops === undefined || hop < opts.maxHops)) {
      const next: string[] = [];
      for (const uid of frontier) {
        const entry = index.get(uid);
        for (const dep of entry?.dependsOn ?? []) {
          if (!selectedIds.has(dep) && index.has(dep)) {
            selectedIds.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
      hop++;
    }

    // Apply include/exclude filters. Include narrows the set; exclude removes
    // matching entries. Anchor nodes are always preserved even if include
    // would filter them out — they are the reason we're here.
    const includeMatch = compileFilters(filters?.include);
    const excludeMatch = compileFilters(filters?.exclude);
    if (includeMatch || excludeMatch) {
      for (const uid of [...selectedIds]) {
        if (anchors.has(uid)) continue;
        const entry = index.get(uid);
        if (!entry) continue;
        if (includeMatch && !includeMatch(entry)) selectedIds.delete(uid);
        else if (excludeMatch && excludeMatch(entry)) selectedIds.delete(uid);
      }
    }
  }

  // ── Step 3: Emit only selected nodes ──────────────────────────────────────
  let modelsImported = 0;
  let sourcesImported = 0;
  const dbtDagModels: NonNullable<ManifestDbtImport['dbtDag']>['models'] = [];
  const dbtDagEdges: NonNullable<ManifestDbtImport['dbtDag']>['edges'] = [];

  for (const uid of selectedIds) {
    const entry = index.get(uid);
    if (!entry) continue;

    if (entry.type === 'model') {
      const node = entry.raw;
      const tableName = entry.name;
      const columns = node.columns
        ? Object.values(node.columns as Record<string, any>).map((v: any) => ({
            name: v.name,
            description: v.description,
            type: v.data_type,
          }))
        : undefined;

      const modelRunState = opts.runState?.byUniqueId.get(uid);
      if (!sources[tableName]) {
        sources[tableName] = { name: tableName, origin: 'dbt', referencedBy: [] };
      }
      sources[tableName].dbtModel = {
        uniqueId: uid,
        database: entry.database,
        schema: entry.schema,
        materializedAs: node.config?.materialized,
        description: node.description,
        columns: node.columns
          ? Object.fromEntries(
              Object.entries(node.columns as Record<string, any>).map(([k, v]: [string, any]) => [
                k,
                { name: v.name, description: v.description, type: v.data_type },
              ]),
            )
          : undefined,
        runState: modelRunState,
      };
      if (sources[tableName].origin === 'sql') sources[tableName].origin = 'dbt';

      // Only include edges where both endpoints are in the selected set
      const selectedDeps = entry.dependsOn.filter((dep) => selectedIds.has(dep));
      dbtDagModels.push({
        uniqueId: uid,
        name: tableName,
        type: 'model',
        dependsOn: selectedDeps,
        columns,
        schema: entry.schema,
        database: entry.database,
        materialized: node.config?.materialized,
        description: node.description,
        runState: modelRunState,
      });
      for (const dep of selectedDeps) {
        dbtDagEdges.push({ source: dep, target: uid });
      }
      modelsImported++;

    } else {
      // source
      const src = entry.raw;
      const tableName = entry.name;
      if (!sources[tableName]) {
        sources[tableName] = { name: tableName, origin: 'dbt', referencedBy: [] };
      }
      const sourceRunState = opts.runState?.byUniqueId.get(uid);
      sources[tableName].dbtModel = {
        uniqueId: uid,
        database: entry.database,
        schema: entry.schema,
        description: src.description,
        runState: sourceRunState,
      };
      dbtDagModels.push({
        uniqueId: uid,
        name: tableName,
        type: 'source',
        dependsOn: [],
        schema: entry.schema,
        database: entry.database,
        description: src.description,
        runState: sourceRunState,
      });
      sourcesImported++;
    }
  }

  return {
    manifestPath,
    projectName,
    modelsImported,
    sourcesImported,
    totalDbtModels,
    selective: useSelective,
    maxHops: opts.maxHops,
    importedAt: new Date().toISOString(),
    dbtDag: { models: dbtDagModels, edges: dbtDagEdges },
    runResultsPath: opts.runState?.runResultsPath,
  };
}

/** Build all normalised lookup keys for a dbt node name. */
/**
 * Lookup keys from a dbt node's EXACT name (no role-prefix stripping), so a
 * mart `customers` and a staging `stg_customers` never collide on the same key.
 */
function buildPrimaryLookupKeys(name: string, schema?: string, database?: string): string[] {
  const alias = name.toLowerCase();
  const keys = new Set<string>([alias]);
  if (schema) keys.add(`${schema}.${alias}`.toLowerCase());
  if (schema && database) keys.add(`${database}.${schema}.${alias}`.toLowerCase());
  return [...keys];
}

function buildLookupKeys(name: string, schema?: string, database?: string): string[] {
  const aliases = new Set([name.toLowerCase()]);
  const stripped = stripDbtRolePrefix(name);
  if (stripped) aliases.add(stripped);

  const keys = new Set<string>();
  for (const alias of aliases) {
    keys.add(alias);
    if (schema) keys.add(`${schema}.${alias}`.toLowerCase());
    if (schema && database) keys.add(`${database}.${schema}.${alias}`.toLowerCase());
  }
  return [...keys];
}

function buildReferencedTableLookupKeys(ref: string): string[] {
  const normalized = ref.replace(/["`]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  const last = parts.at(-1);
  if (last) keys.add(last);
  return [...keys];
}

function stripDbtRolePrefix(name: string): string | undefined {
  const normalized = name.toLowerCase();
  const match = /^(?:src|stg|int|dim|fct)_(.+)$/.exec(normalized);
  return match?.[1];
}

// ---- Apps & Dashboards Scanning ----

/**
 * Discover Apps under `apps/<id>/dql.app.json` plus their dashboards under
 * `apps/<id>/dashboards/*.dqld`. Returns the manifest views for both.
 *
 * Block refs declared in dashboards are resolved against the already-built
 * blocks map: block-id refs map directly; path refs go through the
 * file-path → block-name index. Unresolved refs are surfaced as diagnostics
 * but do not fail the build — partial Apps are still useful in the UI.
 */
function scanAppsAndDashboards(
  projectRoot: string,
  blocks: Record<string, ManifestBlock>,
  blockDeclarations: ManifestBlock[],
  diagnostics: ManifestDiagnostic[],
): { apps: Record<string, ManifestApp>; dashboards: Record<string, ManifestDashboard> } {
  const apps: Record<string, ManifestApp> = {};
  const dashboards: Record<string, ManifestDashboard> = {};

  // Build block-path → block-name index once for all dashboards.
  const blockPathToName = new Map<string, string>();
  for (const block of Object.values(blocks)) {
    if (block.filePath) blockPathToName.set(block.filePath, block.name);
  }
  const knownBlockNames = new Set(Object.keys(blocks));
  // App Studio persists a path-qualified source id, not the legacy block name.
  // Retain every declaration here so compile diagnostics cannot accidentally
  // resolve a same-named block from another Domain or source file.
  const datasetBlocksBySourceId = new Map<string, ManifestBlock>();
  for (const block of blockDeclarations) {
    if (!block.filePath) continue;
    datasetBlocksBySourceId.set(manifestDatasetBlockSourceId(block), block);
  }

  const appJsonPaths = findAppDocuments(projectRoot);
  for (const appJsonPath of appJsonPaths) {
    const appRel = relative(projectRoot, appJsonPath);
    const { document: app, errors } = loadAppDocument(appJsonPath);
    if (errors.length > 0) {
      for (const e of errors) {
        diagnostics.push({
          kind: 'config',
          filePath: appRel,
          severity: 'error',
          message: e.message,
        });
      }
    }
    if (!app) continue;

    const appDir = appJsonPath.slice(0, -'/dql.app.json'.length);
    const appFolderRel = appFolderRelPath(projectRoot, appJsonPath);
    const localDashboardIds: string[] = [];
    const qualifiedDashboardIds: string[] = [];

    // Scan this App's dashboards.
    for (const dqldPath of findDashboardsForApp(appDir)) {
      const dqldRel = relative(projectRoot, dqldPath);
      const { document: dashboard, errors: dErrs } = loadDashboardDocument(dqldPath);
      if (dErrs.length > 0) {
        for (const e of dErrs) {
          diagnostics.push({
            kind: 'config',
            filePath: dqldRel,
            severity: 'error',
            message: e.message,
          });
        }
      }
      if (!dashboard) continue;

      // APP-034 / APP-041: a v3 tile is an explicit query over a captured
      // Dataset source revision. Read the current block source during compile
      // so a field removal or edited source is visible before the runtime
      // rejects the page. Semantic provider contracts remain target-bound and
      // are revalidated by their execution gateway; block sources have a
      // complete Git-owned contract available in this compiler pass.
      validateDashboardDatasetSourceDrift({
        projectRoot,
        dashboard,
        filePath: dqldRel,
        blockSources: datasetBlocksBySourceId,
        diagnostics,
      });

      const refs = extractDashboardBlockRefs(dashboard);
      const resolvedById: string[] = [];
      const resolvedByPath: string[] = [];
      const unresolved: string[] = [];
      for (const id of refs.byId) {
        if (knownBlockNames.has(id)) resolvedById.push(id);
        else unresolved.push(id);
      }
      for (const refPath of refs.byPath) {
        const resolved = blockPathToName.get(refPath);
        if (resolved) resolvedByPath.push(resolved);
        else unresolved.push(refPath);
      }
      if (unresolved.length > 0) {
        diagnostics.push({
          kind: 'resolve',
          filePath: dqldRel,
          severity: 'warning',
          message: `dashboard "${dashboard.id}" has unresolved block refs: ${unresolved.join(', ')}`,
        });
      }

      const qualifiedId = `${app.id}/${dashboard.id}`;
      const datasetTiles = manifestDatasetTiles(dashboard);
      const dashRecord: ManifestDashboard = {
        id: dashboard.id,
        appId: app.id,
        qualifiedId,
        title: dashboard.metadata.title,
        description: dashboard.metadata.description,
        businessOutcome: dashboard.metadata.businessOutcome,
        businessOwner: dashboard.metadata.businessOwner,
        decisionUse: dashboard.metadata.decisionUse,
        reviewCadence: dashboard.metadata.reviewCadence,
        businessRules: dashboard.metadata.businessRules,
        caveats: dashboard.metadata.caveats,
        domain: dashboard.metadata.domain ?? app.domain,
        subdomain: dashboard.metadata.subdomain ?? app.subdomain,
        groups: dashboard.metadata.groups ?? app.groups ?? [],
        audience: dashboard.metadata.audience ?? app.audience,
        visibility: dashboard.metadata.visibility ?? app.visibility ?? 'shared',
        lifecycle: dashboard.metadata.lifecycle ?? app.lifecycle ?? 'draft',
        tags: dashboard.metadata.tags ?? [],
        filePath: dqldRel,
        blockIds: resolvedById,
        blockPathRefs: resolvedByPath,
        unresolvedRefs: unresolved,
        params: (dashboard.params ?? []).map((p) => p.id),
        filters: (dashboard.filters ?? []).map((f) => f.id),
        ...(datasetTiles.length > 0 ? { datasetTiles } : {}),
        layout: {
          kind: dashboard.layout.kind,
          cols: dashboard.layout.cols,
          rowHeight: dashboard.layout.rowHeight,
          itemCount: dashboard.layout.items.length,
        },
      };
      dashboards[qualifiedId] = dashRecord;
      localDashboardIds.push(dashboard.id);
      qualifiedDashboardIds.push(qualifiedId);
    }

    // Cross-check homepage dashboard exists.
    if (app.homepage?.type === 'dashboard') {
      if (!localDashboardIds.includes(app.homepage.id)) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `homepage references unknown dashboard "${app.homepage.id}"`,
        });
      }
    } else if (app.homepage?.type === 'notebook' && !existsSync(join(projectRoot, app.homepage.path))) {
      diagnostics.push({
        kind: 'resolve',
        filePath: appRel,
        severity: 'warning',
        message: `homepage references unknown notebook "${app.homepage.path}"`,
      });
    }
    // Cross-check schedule dashboards exist.
    for (const sched of app.schedules ?? []) {
      if (!localDashboardIds.includes(sched.dashboard)) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `schedule "${sched.id}" references unknown dashboard "${sched.dashboard}"`,
        });
      }
    }
    for (const notebook of app.notebooks ?? []) {
      if (!existsSync(join(projectRoot, notebook.path))) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `notebook reference points to missing file "${notebook.path}"`,
        });
      }
    }

    apps[app.id] = appDocumentToManifest(app, appFolderRel, qualifiedDashboardIds);
  }

  return { apps, dashboards };
}

/**
 * Build offline lineage facts for v3 field-query tiles.  The stored Dataset
 * binding, rather than an inferred block name or generated SQL, is the
 * authority here.  Runtime execution later adds target-specific evidence.
 */
function manifestDatasetTiles(dashboard: DashboardDocument): ManifestDatasetTile[] {
  if (dashboard.version !== 3 || !dashboard.datasets?.length) return [];

  const bindings = new Map(dashboard.datasets.map((binding) => [binding.sourceId, binding]));
  const tiles: ManifestDatasetTile[] = [];
  for (const item of dashboard.layout.items) {
    if (!item.query || !item.sourceId) continue;
    const binding = bindings.get(item.sourceId);
    // Parser/runtime reject this malformed v3 relationship. Do not invent a
    // lineage source record from an unbound tile in the compiler meanwhile.
    if (!binding) continue;

    const sourceFingerprint = manifestDatasetLineageHash({
      sourceId: binding.sourceId,
      sourceRevision: binding.sourceRevision,
      snapshotId: binding.snapshotId,
      contractFingerprint: binding.contractFingerprint,
    });
    const queryFingerprint = manifestDatasetLineageHash({ query: tileQueryHash(item.query) });
    const dependencyFingerprint = manifestDatasetLineageHash({
      tileId: item.i,
      sourceFingerprint,
      queryFingerprint,
      // Keep an inconsistent tile-level revision visible in the dependency
      // identity until the regular source-drift diagnostic is repaired.
      tileSourceRevision: item.sourceRevision,
      // Runtime inputs live outside TileQuery. Hash their authored contract
      // without exposing raw values in lineage so a parameter/filter or
      // declared interaction edit cannot look equivalent to an earlier tile.
      parameterBindings: item.parameterBindings ?? [],
      filterBindings: item.filterBindings ?? [],
      dashboardParams: dashboard.params ?? [],
      dashboardFilters: dashboard.filters ?? [],
      dashboardInteractions: dashboard.interactions ?? null,
    });
    tiles.push({
      id: item.i,
      sourceId: binding.sourceId,
      sourceRevision: binding.sourceRevision,
      snapshotId: binding.snapshotId,
      contractFingerprint: binding.contractFingerprint,
      sourceFingerprint,
      queryFingerprint,
      dependencyFingerprint,
      sourceKind: manifestDatasetSourceKind(binding.sourceId),
      selectedOutputs: {
        dimensions: item.query.dimensions.map((dimension) => dimension.field),
        measures: item.query.measures.map((measure) => measure.measure),
        filters: (item.query.filters ?? []).map((filter) => filter.field),
        having: (item.query.having ?? []).map((filter) => filter.field),
      },
    });
  }
  return tiles;
}

function manifestDatasetSourceKind(sourceId: string): ManifestDatasetTile['sourceKind'] {
  if (sourceId.startsWith('app:block:')) return 'block_dataset';
  if (sourceId.startsWith('app:semantic:')) return 'semantic_dataset';
  return 'other_dataset';
}

function manifestDatasetLineageHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalManifestDatasetLineageValue(value))).digest('hex')}`;
}

function canonicalManifestDatasetLineageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalManifestDatasetLineageValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalManifestDatasetLineageValue(entry)]));
}

function validateDashboardDatasetSourceDrift(input: {
  projectRoot: string;
  dashboard: DashboardDocument;
  filePath: string;
  blockSources: ReadonlyMap<string, ManifestBlock>;
  diagnostics: ManifestDiagnostic[];
}): void {
  const { projectRoot, dashboard, filePath, blockSources, diagnostics } = input;
  if (dashboard.version !== 3 || !dashboard.datasets?.length) return;

  const bindingBySourceId = new Map(dashboard.datasets.map((binding) => [binding.sourceId, binding]));
  for (const binding of dashboard.datasets) {
    const block = blockSources.get(binding.sourceId);
    if (!block) {
      // `app:semantic:` has no compiler-local contract: native, dbt, and
      // MetricFlow adapters bind it against the active target at runtime.
      // A missing block identity, however, is a deterministic compile error.
      if (binding.sourceId.startsWith('app:block:')) {
        diagnostics.push({
          kind: 'drift',
          filePath,
          severity: 'error',
          message: `APP_DATASET_SOURCE_UNRESOLVED: Dataset source ${binding.sourceId} no longer resolves to its declared block. Choose the current Dataset and reselect its fields.`,
        });
      }
      continue;
    }
    const currentRevision = manifestDatasetBlockSourceRevision(projectRoot, block);
    if (currentRevision !== binding.sourceRevision) {
      diagnostics.push({
        kind: 'drift',
        filePath,
        severity: 'error',
        message: `APP_DATASET_SOURCE_DRIFT: Dataset source ${binding.sourceId} changed after this page was authored. Choose the current Dataset and reselect its fields before publishing.`,
      });
    }
  }

  for (const item of dashboard.layout.items) {
    if (!item.query || !item.sourceId) continue;
    const block = blockSources.get(item.sourceId);
    if (!block) continue;
    const binding = bindingBySourceId.get(item.sourceId);
    if (!binding) continue;
    const declared = manifestDatasetDeclaredFields(block);
    // A saved query whose result columns can't be named here (SELECT *, or no
    // column lineage) is checked by the runtime when its tiles run.
    if (!declared) continue;
    const { physical, measures } = declared;
    const diagnosePhysical = (field: string, role: string) => {
      if (physical.has(field.toLowerCase())) return;
      // A field from a related table ("customer__customer_name") comes through
      // the model's certified joins, which the runtime checks on every run.
      if (relatedFieldParts(field)) return;
      diagnostics.push({
        kind: 'drift',
        filePath,
        severity: 'error',
        message: `APP_DATASET_FIELD_DRIFT: Tile ${item.i} selects ${role} ${field}, which is no longer declared by Dataset ${binding.id}. Refresh the Dataset and reselect supported fields.`,
      });
    };
    const diagnoseMeasure = (measure: string, role: string) => {
      if (measures.has(measure.toLowerCase())) return;
      if (relatedFieldParts(measure)) return;
      diagnostics.push({
        kind: 'drift',
        filePath,
        severity: 'error',
        message: `APP_DATASET_FIELD_DRIFT: Tile ${item.i} selects ${role} ${measure}, which is no longer declared by Dataset ${binding.id}. Refresh the Dataset and reselect supported measures.`,
      });
    };
    for (const dimension of item.query.dimensions) diagnosePhysical(dimension.field, 'dimension');
    for (const measure of item.query.measures) diagnoseMeasure(measure.measure, 'measure');
    for (const filter of item.query.filters ?? []) diagnosePhysical(filter.field, 'filter field');
    for (const filter of item.query.having ?? []) diagnoseMeasure(filter.field, 'HAVING measure');
  }
}

/**
 * The fields a block offers App tiles, as the compiler can know them. A block
 * with a Dataset definition declares them. A plain saved query's fields are
 * its result columns (design D1): their names come from its column lineage,
 * plus the measures ZLens adds over a result — Min/Max of each number and the
 * row count — so a tile over them is not reported as drift. Their types are
 * read at runtime, so a number column is accepted as a measure here and the
 * runtime refuses a tile whose fields really went away. Undefined when the
 * result's columns can't be named (SELECT *, an expression without a name).
 */
function manifestDatasetDeclaredFields(block: ManifestBlock): { physical: Set<string>; measures: Set<string> } | undefined {
  const plainSavedQuery = Boolean(block.sql?.trim()) && block.blockType !== 'semantic'
    && !block.datasetGrain && !block.datasetFields?.length && !block.datasetMeasures?.length;
  if (!plainSavedQuery) {
    return {
      physical: new Set((block.datasetFields ?? []).map((field) => field.name.toLowerCase())),
      measures: new Set((block.datasetMeasures ?? []).map((measure) => measure.name.toLowerCase())),
    };
  }
  const outputs = block.outputs ?? [];
  if (!outputs.length || outputs.some((output) => output.unresolved || !output.name?.trim() || output.name === '*')) return undefined;
  const columns = outputs.map((output) => output.name.trim().toLowerCase());
  const measures = new Set<string>([SAVED_QUERY_ROW_COUNT, 'result_row_count']);
  for (const column of columns) {
    measures.add(column);
    measures.add(`min_${column}`);
    measures.add(`max_${column}`);
  }
  return { physical: new Set(columns), measures };
}

/** Keep compiler source identity byte-for-byte aligned with App source catalog. */
function manifestDatasetBlockSourceId(block: ManifestBlock): string {
  const domain = block.domain?.trim() || 'global';
  const identity = createHash('sha256').update(`${block.filePath}\u0000${block.name}`).digest('hex').slice(0, 20);
  return `app:block:${domain}:${identity}`;
}

/** The runtime and metadata catalog bind block source revisions to raw DQL text. */
function manifestDatasetBlockSourceRevision(projectRoot: string, block: ManifestBlock): string {
  const path = join(projectRoot, block.filePath);
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex')}`;
  } catch {
    // This is handled by the existing block scan. A stable fallback preserves
    // deterministic diagnostics rather than depending on filesystem metadata.
    return `sha256:${createHash('sha256').update(JSON.stringify(block)).digest('hex')}`;
  }
}

function appDocumentToManifest(
  app: AppDocument,
  filePath: string,
  dashboardIds: string[],
): ManifestApp {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    businessOutcome: app.businessOutcome,
    businessOwner: app.businessOwner,
    decisionUse: app.decisionUse,
    reviewCadence: app.reviewCadence,
    businessRules: app.businessRules,
    caveats: app.caveats,
    domain: app.domain,
    ownerDomain: app.ownerDomain ?? app.domain,
    usesDomains: app.usesDomains,
    purpose: app.purpose,
    requiredExports: app.requiredExports,
    classification: app.classification,
    subdomain: app.subdomain,
    groups: app.groups ?? [],
    audience: app.audience,
    visibility: app.visibility ?? 'shared',
    lifecycle: app.lifecycle ?? 'draft',
    owners: app.owners,
    tags: app.tags ?? [],
    filePath,
    members: app.members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      roles: m.roles,
      attributes: m.attributes,
    })),
    roles: app.roles.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      description: r.description,
    })),
    policies: (app.policies ?? []).map((p) => ({
      id: p.id,
      description: p.description,
      domain: p.domain,
      minClassification: p.minClassification,
      allowedRoles: p.allowedRoles,
      allowedUsers: p.allowedUsers,
      accessLevel: p.accessLevel,
      enabled: p.enabled === undefined ? true : Boolean(p.enabled),
    })),
    rlsBindings: (app.rlsBindings ?? []).map((b) => ({
      role: b.role,
      variable: b.variable,
      from: b.from,
    })),
    schedules: (app.schedules ?? []).map((s) => ({
      id: s.id,
      cron: s.cron,
      dashboard: s.dashboard,
      deliver: s.deliver.map((d) => {
        if (d.kind === 'slack') return { kind: 'slack' as const, channel: d.channel };
        if (d.kind === 'email') return { kind: 'email' as const, to: d.to };
        return { kind: 'webhook' as const, url: d.url };
      }),
      description: s.description,
      enabled: s.enabled === undefined ? true : Boolean(s.enabled),
      ...(s.monitors?.length ? { monitors: s.monitors.map((monitor) => ({ ...monitor, when: { ...monitor.when } })) } : {}),
      ...(s.digest === false ? { digest: false } : {}),
    })),
    dashboards: dashboardIds,
    notebooks: (app.notebooks ?? []).map((n) => ({
      path: n.path,
      title: n.title,
      role: n.role,
      visibility: n.visibility ?? 'shared',
    })),
    homepage: app.homepage,
  };
}

// ---- Lineage Builder ----

function buildManifestLineage(
  manifestDomains: Record<string, ManifestDomain>,
  blocks: Record<string, ManifestBlock>,
  metrics: Record<string, ManifestMetric>,
  dimensions: Record<string, ManifestDimension>,
  notebooks?: Record<string, ManifestNotebook>,
  dbtImport?: ManifestDbtImport,
  apps?: Record<string, ManifestApp>,
  appDashboards?: Record<string, ManifestDashboard>,
  businessViews?: Record<string, ManifestBusinessView>,
  terms?: Record<string, ManifestTerm>,
): ManifestLineage {
  // Convert to lineage builder input format
  const lineageBlocks: LineageBlockInput[] = Object.values(blocks).map((b) => ({
    name: b.name,
    sql: b.sql,
    domain: b.domain,
    owner: b.owner,
    status: b.status as any,
    blockType: b.blockType,
    metricRef: b.metricRef,
    metricsRef: b.metricsRef,
    dimensionsRef: b.dimensionsRef,
    chartType: b.chartType,
    filePath: b.filePath,
    description: b.description,
    businessOutcome: b.businessOutcome,
    reviewCadence: b.reviewCadence,
    tests: b.tests,
    termRefs: b.termRefs,
    pattern: b.pattern,
    grain: b.grain,
    entities: b.entities,
    declaredOutputs: b.declaredOutputs,
    dimensions: b.dimensions,
    allowedFilters: b.allowedFilters,
    parameterPolicy: b.parameterPolicy,
    filterBindings: b.filterBindings,
    sourceSystems: b.sourceSystems,
    replacementFor: b.replacementFor,
    replacedBy: b.replacedBy,
    deprecatedOn: b.deprecatedOn,
  }));

  const lineageDomains: LineageDomainInput[] = Object.values(manifestDomains ?? {}).map((domain) => ({
    name: domain.name,
    owner: domain.owner,
    businessOwner: domain.businessOwner,
    boundedContext: domain.boundedContext,
    filePath: domain.filePath,
    sourceSystems: domain.sourceSystems,
    primaryTerms: domain.primaryTerms,
    reviewCadence: domain.reviewCadence,
    businessOutcome: domain.businessOutcome,
    tags: domain.tags,
  }));

  const lineageTerms: LineageTermInput[] = Object.values(terms ?? {}).map((term) => ({
    name: term.name,
    domain: term.domain,
    owner: term.owner,
    status: term.status as any,
    termType: term.termType,
    filePath: term.filePath,
    description: term.description,
    identifiers: term.identifiers,
    synonyms: term.synonyms,
    businessOutcome: term.businessOutcome,
    reviewCadence: term.reviewCadence,
  }));

  const lineageMetrics: LineageMetricInput[] = Object.values(metrics).map((m) => ({
    name: m.name,
    table: m.table,
    domain: m.domain,
    type: m.type,
    status: m.status as any,
    owner: m.owner,
    filePath: m.filePath,
    description: m.description,
    sql: m.sql,
    tags: m.tags,
  }));

  const lineageDimensions: LineageDimensionInput[] = Object.values(dimensions).map((d) => ({
    name: d.name,
    table: d.table,
    domain: d.domain,
    type: d.type,
    status: d.status as any,
    owner: d.owner,
    filePath: d.filePath,
    description: d.description,
    sql: d.sql,
    tags: d.tags,
  }));

  const lineageBusinessViews: LineageBusinessViewInput[] = Object.values(businessViews ?? {}).map((view) => ({
    name: view.name,
    domain: view.domain,
    owner: view.owner,
    status: view.status as any,
    filePath: view.filePath,
    description: view.description,
    businessOutcome: view.businessOutcome,
    reviewCadence: view.reviewCadence,
    blockRefs: view.blockRefs,
    businessViewRefs: view.businessViewRefs,
    termRefs: view.termRefs,
    declaredTermRefs: view.declaredTermRefs,
  }));

  // A bound cell points at a `.dql` block file by path.
  const pathToBlockName = new Map<string, string>();
  for (const block of Object.values(blocks)) {
    if (block.filePath) pathToBlockName.set(block.filePath, block.name);
  }

  const dashboards: LineageDashboardInput[] = Object.values(notebooks ?? {}).map((notebook) => {
    // Blocks declared inline inside this notebook (DQL cells with block declarations)
    const inlineBlockNames = notebook.cells
      .map((cell) => cell.blockName)
      .filter((name): name is string => Boolean(name));
    const inlineBlockSet = new Set(inlineBlockNames);

    // Blocks explicitly ref()-ed from notebook SQL cells, plus bound cells
    // (Track 5): a bound cell points at a `.dql` block file by path.
    const refDeps = new Set<string>();
    for (const cell of notebook.cells) {
      for (const ref of cell.refDependencies ?? []) {
        if (!inlineBlockSet.has(ref) && blocks[ref]) refDeps.add(ref);
      }
      if (cell.bindingPath) {
        const bound = pathToBlockName.get(cell.bindingPath);
        if (bound && !inlineBlockSet.has(bound)) refDeps.add(bound);
      }
    }

    // Only what the notebook's cells actually use: inline declarations,
    // explicit ref()s and bound cells. A notebook that merely queries the same
    // table as a block does not use that block. Linking every block that
    // shares a table made impact analysis name notebooks that never touch the
    // block (each NBA block "fed" a notebook that queries int_player_stats).
    const allBlocks = [...new Set([...inlineBlockNames, ...refDeps])];

    return {
      name: notebook.title,
      kind: 'notebook',
      filePath: notebook.filePath,
      blocks: allBlocks,
      charts: notebook.cells
        .filter((cell) => cell.chartType && cell.blockName)
        .map((cell) => cell.blockName!)
        .filter(Boolean),
      refDependencies: [],       // already merged into blocks above
      tableDependencies: [],     // intentionally empty — no dbt_model → dashboard shortcuts
    };
  });

  const dbtModels: LineageDbtModelInput[] = (dbtImport?.dbtDag?.models ?? []).map((model) => ({
    name: model.name,
    uniqueId: model.uniqueId,
    type: model.type,
    dependsOn: model.dependsOn,
    columns: model.columns,
    schema: model.schema,
    database: model.database,
    materialized: model.materialized,
    description: model.description,
  }));

  // First-class dashboards from `.dqld` files. Keyed by qualified id so
  // dashboards with the same local id can exist in different Apps.
  const appDashboardInputs: LineageDashboardInput[] = Object.values(appDashboards ?? {}).map((d) => ({
    name: d.qualifiedId,
    kind: 'dashboard',
    filePath: d.filePath,
    blocks: [...d.blockIds, ...d.blockPathRefs],
    charts: [],
    refDependencies: [],
    tableDependencies: [],
  }));

  const lineageApps: LineageAppInput[] = Object.values(apps ?? {}).map((a) => ({
    id: a.id,
    name: a.name,
    domain: a.domain,
    owner: a.owners[0],
    filePath: a.filePath,
    dashboards: a.dashboards,
  }));

  const graph = buildLineageGraph(lineageBlocks, lineageMetrics, lineageDimensions, {
    dbtModels,
    dashboards: [...dashboards, ...appDashboardInputs],
    apps: lineageApps,
    businessViews: lineageBusinessViews,
    terms: lineageTerms,
    domains: lineageDomains,
  });

  // Serialize to manifest format
  const graphJson = graph.toJSON();
  const domains = graph.getDomains();
  const flows = detectDomainFlows(graph);

  const domainTrust: Record<string, { total: number; certified: number; score: number }> = {};
  for (const domain of domains) {
    const overview = getDomainTrustOverview(graph, domain);
    domainTrust[domain] = {
      total: overview.totalBlocks,
      certified: overview.certified,
      score: overview.trustScore,
    };
  }

  const manifestNodes: ManifestLineage['nodes'] = graphJson.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: n.name,
    layer: n.layer,
    domain: n.domain,
    owner: n.owner,
    status: n.status,
    filePath: blocks[n.name]?.filePath
      ?? businessViews?.[n.name]?.filePath
      ?? terms?.[n.name]?.filePath
      ?? metrics[n.name]?.filePath
      ?? dimensions[n.name]?.filePath
      ?? n.metadata?.filePath,
    columns: n.columns,
    metadata: n.metadata,
  }));
  const manifestEdges: ManifestLineage['edges'] = graphJson.edges.map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
    sourceDomain: e.sourceDomain,
    targetDomain: e.targetDomain,
  }));

  appendVirtualAppTileLineage({
    nodes: manifestNodes,
    edges: manifestEdges,
    blocks,
    dashboards: appDashboards,
  });

  return {
    nodes: manifestNodes,
    edges: manifestEdges,
    domains,
    crossDomainFlows: flows.map((f) => ({
      from: f.from,
      to: f.to,
      edgeCount: f.edges.length,
    })),
    domainTrust,
  };
}

/**
 * Add virtual Dataset-source and App-tile nodes after generic lineage
 * construction.  A v3 TileQuery is saved analytical intent, not physical
 * SQL. Its offline lineage therefore stops at the exact Dataset binding and
 * records no target-specific SQL fingerprint.
 */
function appendVirtualAppTileLineage(input: {
  nodes: ManifestLineage['nodes'];
  edges: ManifestLineage['edges'];
  blocks: Record<string, ManifestBlock>;
  dashboards?: Record<string, ManifestDashboard>;
}): void {
  const { nodes, edges, blocks, dashboards } = input;
  if (!dashboards) return;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}\u0000${edge.type}`));
  const blockBySourceId = new Map(
    Object.values(blocks).map((block) => [manifestDatasetBlockSourceId(block), block.name]),
  );
  const addEdge = (source: string, target: string, type: string, sourceDomain?: string, targetDomain?: string) => {
    const id = `${source}\u0000${target}\u0000${type}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ source, target, type, sourceDomain, targetDomain });
  };

  for (const dashboard of Object.values(dashboards).sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId))) {
    const dashboardNodeId = `dashboard:${dashboard.qualifiedId}`;
    if (!nodeIds.has(dashboardNodeId)) continue;
    for (const tile of [...(dashboard.datasetTiles ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
      const sourceNodeId = `dataset_source:${tile.sourceFingerprint}`;
      if (!nodeIds.has(sourceNodeId)) {
        nodeIds.add(sourceNodeId);
        nodes.push({
          id: sourceNodeId,
          type: 'dataset_source',
          name: tile.sourceId,
          layer: 'consumption',
          domain: dashboard.domain,
          filePath: dashboard.filePath,
          metadata: {
            artifactKind: 'virtual_dataset_source',
            sourceKind: tile.sourceKind,
            sourceId: tile.sourceId,
            sourceRevision: tile.sourceRevision,
            snapshotId: tile.snapshotId,
            contractFingerprint: tile.contractFingerprint,
            sourceFingerprint: tile.sourceFingerprint,
            // Deliberately no `physicalSqlFingerprint`: compilation is offline
            // and semantic adapters may not have a physical SQL representation.
            physicalSqlAvailability: 'unavailable_offline',
          },
        });
        const blockName = tile.sourceKind === 'block_dataset' ? blockBySourceId.get(tile.sourceId) : undefined;
        if (blockName) {
          addEdge(`block:${blockName}`, sourceNodeId, 'contains', dashboard.domain, dashboard.domain);
        }
      }

      const tileNodeId = `app_tile:${dashboard.qualifiedId}:${tile.id}`;
      if (!nodeIds.has(tileNodeId)) {
        nodeIds.add(tileNodeId);
        nodes.push({
          id: tileNodeId,
          type: 'app_tile',
          name: tile.id,
          layer: 'consumption',
          domain: dashboard.domain,
          filePath: dashboard.filePath,
          metadata: {
            artifactKind: 'virtual_app_tile',
            sourceKind: tile.sourceKind,
            sourceId: tile.sourceId,
            sourceRevision: tile.sourceRevision,
            snapshotId: tile.snapshotId,
            contractFingerprint: tile.contractFingerprint,
            sourceFingerprint: tile.sourceFingerprint,
            queryFingerprint: tile.queryFingerprint,
            dependencyFingerprint: tile.dependencyFingerprint,
            selectedOutputs: tile.selectedOutputs,
            // Query intent is recorded above. Runtime receipts alone may add a
            // target-specific SQL fingerprint after actual execution.
            physicalSqlAvailability: 'unavailable_offline',
          },
        });
      }
      addEdge(sourceNodeId, tileNodeId, 'feeds', dashboard.domain, dashboard.domain);
      addEdge(tileNodeId, dashboardNodeId, 'contains', dashboard.domain, dashboard.domain);
    }
  }
}

// ---- AST Helpers ----

function blockDeclToManifestBlock(block: any, filePath: string): ManifestBlock {
  const sql = block.query?.rawSQL ?? '';
  const parseResult = extractTablesFromSql(sql);
  const columnLineage = sql ? extractColumnLineage(sql) : null;
  const domain = extractProp(block, 'domain');
  const owner = extractProp(block, 'owner');
  const description = extractProp(block, 'description');
  const tags = extractTags(block);
  const tests = extractTests(block);
  const agent = extractAgentMetadata(block);

  return {
    name: block.name,
    filePath,
    domain,
    owner,
    status: extractProp(block, 'status'),
    blockType: block.blockType,
    sql,
    rawTableRefs: parseResult.tables,
    tableDependencies: parseResult.tables.map(normalizeTableName),
    refDependencies: parseResult.refs,
    metricRefs: parseResult.metricRefs,
    dimensionRefs: parseResult.dimensionRefs,
    dimensionsRef: block.dimensionsRef,
    allDependencies: [
      ...parseResult.refs,
      ...parseResult.tables.map(normalizeTableName),
      ...parseResult.metricRefs.map((m) => `@metric(${m})`),
      ...parseResult.dimensionRefs.map((d) => `@dim(${d})`),
      ...((block.metricsRef ?? (block.metricRef ? [block.metricRef] : [])).map((m: string) => `@metric(${m})`)),
      ...((block.dimensionsRef ?? []).map((d: string) => `@dim(${d})`)),
    ],
    chartType: extractVisualizationChart(block),
    displayHints: extractDisplayHints(block),
    metricRef: block.metricRef,
    metricsRef: block.metricsRef,
    tests,
    tags,
    description,
    termRefs: Array.isArray(block.termRefs) ? block.termRefs : undefined,
    pattern: typeof block.pattern === 'string' ? block.pattern : undefined,
    grain: typeof block.grain === 'string' ? block.grain : undefined,
    datasetGrain: block.datasetGrain && typeof block.datasetGrain === 'object'
      ? {
          entities: Array.isArray(block.datasetGrain.entities) ? block.datasetGrain.entities : [],
          keys: Array.isArray(block.datasetGrain.keys) ? block.datasetGrain.keys : [],
          keyEvidence: typeof block.datasetGrain.keyEvidence === 'string' ? block.datasetGrain.keyEvidence : undefined,
          description: typeof block.datasetGrain.description === 'string' ? block.datasetGrain.description : undefined,
          timeGrain: typeof block.datasetGrain.timeGrain === 'string' ? block.datasetGrain.timeGrain : undefined,
          timeBucketBy: typeof block.datasetGrain.timeBucketBy === 'string' ? block.datasetGrain.timeBucketBy : undefined,
          aggregate: block.datasetGrain.aggregate === true || undefined,
        }
      : undefined,
    datasetFields: Array.isArray(block.datasetFields)
      ? block.datasetFields.map((field: any) => ({
          name: field.name,
          role: field.role,
          type: field.type,
          grains: Array.isArray(field.grains) ? field.grains : undefined,
          primary: field.primary === true || undefined,
          hierarchy: field.hierarchy,
          level: field.level,
          status: field.status,
        }))
      : undefined,
    datasetMeasures: Array.isArray(block.datasetMeasures)
      ? block.datasetMeasures.map((measure: any) => ({
          name: measure.name,
          aggregation: measure.aggregation,
          from: measure.from,
          numerator: measure.numerator,
          denominator: measure.denominator,
          expression: measure.expression,
          timeBucketBy: measure.timeBucketBy,
          additive: measure.additive,
          entityAdditive: measure.entityAdditive,
          allowedAggs: Array.isArray(measure.allowedAggs) ? measure.allowedAggs : undefined,
          format: measure.format,
          currency: measure.currency,
          status: measure.status,
        }))
      : undefined,
    entities: Array.isArray(block.entities) ? block.entities : undefined,
    declaredOutputs: Array.isArray(block.outputs) ? block.outputs : undefined,
    dimensions: Array.isArray(block.dimensions) ? block.dimensions : undefined,
    allowedFilters: Array.isArray(block.allowedFilters) ? block.allowedFilters : undefined,
    parameterPolicy: Array.isArray(block.parameterPolicy)
      ? block.parameterPolicy.map((entry: { name: string; policy: string }) => ({
          name: entry.name,
          policy: entry.policy,
        }))
      : undefined,
    parameters: blockParameterDefinitions(block),
    filterBindings: Array.isArray(block.filterBindings)
      ? block.filterBindings.map((entry: { filter: string; binding: string }) => ({
          filter: entry.filter,
          binding: entry.binding,
        }))
      : undefined,
    metricMappings: Array.isArray(block.metricMappings) && block.metricMappings.length > 0
      ? block.metricMappings.map((entry: { output: string; metric: string; filter?: string }) => ({
          output: entry.output,
          metric: entry.metric,
          ...(entry.filter ? { filter: entry.filter } : {}),
        }))
      : undefined,
    sourceSystems: Array.isArray(block.sourceSystems) ? block.sourceSystems : undefined,
    replacementFor: Array.isArray(block.replacementFor) ? block.replacementFor : undefined,
    replacedBy: typeof block.replacedBy === 'string' && block.replacedBy.trim() ? block.replacedBy.trim() : undefined,
    deprecatedOn: typeof block.deprecatedOn === 'string' && block.deprecatedOn.trim() ? block.deprecatedOn.trim() : undefined,
    unresolvedTermRefs: [],
    llmContext: agent.llmContext,
    examples: agent.examples,
    invariants: agent.invariants,
    businessOutcome: agent.businessOutcome,
    businessOwner: agent.businessOwner,
    decisionUse: agent.decisionUse,
    reviewCadence: agent.reviewCadence,
    businessRules: agent.businessRules,
    caveats: agent.caveats,
    synonyms: agent.synonyms,
    primaryTerms: agent.primaryTerms,
    datalexContract: typeof block.datalexContract === 'string' ? block.datalexContract : undefined,
    draftMetadata: extractDraftMetadata(block),
    outputs: columnLineage?.parsed && columnLineage.columns.length > 0
      ? columnLineage.columns.map((c) => ({
          name: c.name,
          isAggregate: c.isAggregate,
          aggregateFn: c.aggregateFn,
          sources: c.sources,
          unresolved: c.unresolved,
        }))
      : undefined,
    outputContract: buildOutputContract(
      Array.isArray(block.outputs) ? block.outputs : undefined,
      columnLineage,
      Array.isArray(block.datasetFields) ? block.datasetFields : undefined,
    ),
  };
}

/**
 * Build a block's typed `outputContract` — the columns a parent that `ref()`s
 * this block can rely on. Additive and distinct from `outputs` (column-lineage
 * shaped). Source of truth, in priority order:
 *
 *   1. `declaredOutputs` (reviewer-declared field names) when present. These
 *      are the contract the block author committed to, so they win. Column
 *      lineage is used only to enrich `role`/`type` for matching names.
 *   2. Otherwise, the resolved column-lineage output columns — but only when
 *      the projection is fully resolved (no `*`/unresolved entries). A star or
 *      unparsed projection means the schema is open, so we emit no contract and
 *      drift detection stays silent for this block (conservative).
 *
 * Returns undefined when neither source yields a usable schema, keeping the
 * field optional and backward-compatible.
 */
function buildOutputContract(
  declaredOutputs: string[] | undefined,
  columnLineage: ColumnLineageResult | null,
  datasetFields?: Array<{ name?: string; role?: string; type?: string }>,
): Array<{ name: string; type?: string; role?: string }> | undefined {
  const roleByName = new Map<string, string>();
  const datasetFieldByName = new Map<string, { role?: string; type?: string }>();
  for (const field of datasetFields ?? []) {
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    if (name) datasetFieldByName.set(name.toLowerCase(), { role: field.role, type: field.type });
  }
  if (columnLineage?.parsed) {
    for (const col of columnLineage.columns) {
      if (col.isAggregate) roleByName.set(col.name.toLowerCase(), 'metric');
    }
  }

  if (Array.isArray(declaredOutputs) && declaredOutputs.length > 0) {
    const seen = new Set<string>();
    const contract: Array<{ name: string; type?: string; role?: string }> = [];
    for (const raw of declaredOutputs) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const datasetField = datasetFieldByName.get(name.toLowerCase());
      contract.push({ name, type: datasetField?.type, role: datasetField?.role ?? roleByName.get(name.toLowerCase()) });
    }
    return contract.length > 0 ? contract : undefined;
  }

  if (!columnLineage?.parsed || columnLineage.columns.length === 0) return undefined;
  // Only emit a derived contract when every output column is resolved — a star
  // or unresolved entry means we cannot enumerate the real output schema.
  if (columnLineage.columns.some((c) => c.unresolved || c.name === '*' || c.name.endsWith('.*'))) {
    return undefined;
  }
  const seen = new Set<string>();
  const contract: Array<{ name: string; type?: string; role?: string }> = [];
  for (const col of columnLineage.columns) {
    const name = col.name?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const datasetField = datasetFieldByName.get(name.toLowerCase());
    contract.push({ name, type: datasetField?.type, role: datasetField?.role ?? (col.isAggregate ? 'metric' : undefined) });
  }
  return contract.length > 0 ? contract : undefined;
}

/**
 * Dataset declarations are intentionally strict. This only validates source
 * shape and physical dependencies; a `keyEvidence` id is resolved against a
 * typed proof later by the local runtime/catalog, because a nonempty string is
 * not evidence of uniqueness, source identity, or snapshot freshness.
 */
function validateDatasetBlockContract(block: ManifestBlock, diagnostics?: ManifestDiagnostic[]): void {
  const hasDataset = Boolean(block.datasetGrain || block.datasetFields || block.datasetMeasures);
  if (!hasDataset) return;
  const error = (message: string) => diagnostics?.push({
    kind: 'resolve',
    filePath: block.filePath,
    severity: 'error',
    message: `Dataset contract for block "${block.name}": ${message}`,
  });
  if (!block.datasetGrain || !block.datasetFields?.length || !block.datasetMeasures?.length) {
    error('grain, fields, and measures must all be declared together.');
    return;
  }
  if (!block.datasetGrain.entities.length || !block.datasetGrain.keys.length) {
    error('grain must declare at least one entity and one physical key.');
  }
  if (block.status === 'certified' && !block.datasetGrain.keyEvidence?.trim()) {
    error('a certified dataset requires a typed keyEvidence reference; a preview is not a grain proof.');
  }
  const physical = new Map<string, NonNullable<ManifestBlock['datasetFields']>[number]>();
  for (const field of block.datasetFields) {
    const normalized = field.name?.trim().toLowerCase();
    if (!normalized) {
      error('every field needs a physical name.');
      continue;
    }
    if (physical.has(normalized)) error(`physical field "${field.name}" is declared more than once.`);
    physical.set(normalized, field);
    if (!field.type) error(`physical field "${field.name}" needs a declared type.`);
    if (field.role === 'time' && (!field.grains?.length || field.grains.some((grain) => !grain.trim()))) {
      error(`time field "${field.name}" needs supported time grains.`);
    }
  }
  const outputNames = new Set((block.outputContract ?? []).map((output) => output.name.toLowerCase()));
  for (const field of block.datasetFields) {
    if (field.name && outputNames.size > 0 && !outputNames.has(field.name.toLowerCase())) {
      error(`physical field "${field.name}" is not present in the block output contract.`);
    }
  }
  for (const key of block.datasetGrain.keys) {
    const field = physical.get(key.toLowerCase());
    if (!field) error(`grain key "${key}" is not a declared physical field.`);
    else if (field.role !== 'key' && !(block.datasetGrain.aggregate && field.role === 'time' && field.name === block.datasetGrain.timeBucketBy)) {
      error(`grain key "${key}" must have role "key"${block.datasetGrain.aggregate ? ' unless it is the declared aggregate timeBucketBy field' : ''}.`);
    }
  }
  const measureNames = new Set<string>();
  for (const measure of block.datasetMeasures) {
    const name = measure.name?.trim().toLowerCase();
    if (!name) {
      error('every measure needs a name.');
      continue;
    }
    if (measureNames.has(name)) error(`measure "${measure.name}" is declared more than once.`);
    measureNames.add(name);
    const dependencies = measure.expression
      ? []
      : measure.aggregation === 'ratio'
        ? [measure.numerator, measure.denominator]
        : [measure.from];
    if (measure.expression && (measure.from || measure.numerator || measure.denominator)) {
      error(`calculated measure "${measure.name}" cannot combine expression with legacy physical inputs.`);
    }
    if (!measure.expression && measure.aggregation === 'ratio' && (!measure.numerator || !measure.denominator)) {
      error(`ratio measure "${measure.name}" requires numerator and denominator physical fields.`);
    }
    if (!measure.expression && measure.aggregation !== 'ratio' && !measure.from) {
      error(`${measure.aggregation} measure "${measure.name}" requires a physical from field.`);
    }
    for (const dependency of dependencies) {
      if (dependency && !physical.has(dependency.toLowerCase())) {
        error(`measure "${measure.name}" depends on undeclared physical field "${dependency}".`);
      }
    }
    if (measure.expression) {
      try {
        const parsed = parseDatasetAggregateExpression({
          expression: measure.expression,
          physicalFields: block.datasetFields.map((field) => field.name),
        });
        if (parsed.aggregation !== measure.aggregation) {
          error(`calculated measure "${measure.name}" declares ${measure.aggregation}, but its expression resolves to ${parsed.aggregation}.`);
        }
      } catch (cause) {
        error(`calculated measure "${measure.name}" is invalid: ${cause instanceof Error ? cause.message : 'unknown expression error'}`);
      }
    }
    if (measure.timeBucketBy) {
      const bucket = physical.get(measure.timeBucketBy.toLowerCase());
      if (!bucket || bucket.role !== 'time') {
        error(`measure "${measure.name}" timeBucketBy "${measure.timeBucketBy}" must reference a declared physical time field.`);
      }
    }
    if (measure.aggregation === 'count_distinct' && measure.additive === 'additive' && !measure.timeBucketBy) {
      error(`time-additive distinct measure "${measure.name}" requires an exact timeBucketBy field and current grain proof.`);
    }
    if (!measure.allowedAggs?.includes(measure.aggregation)) {
      error(`measure "${measure.name}" must include its declared aggregation in allowedAggs.`);
    }
  }
  if (block.datasetGrain.aggregate) {
    const bucket = block.datasetGrain.timeBucketBy;
    if (!block.datasetGrain.timeGrain || !bucket) {
      error('an aggregate dataset requires both timeGrain and exact timeBucketBy evidence.');
    } else {
      const field = physical.get(bucket.toLowerCase());
      if (!field || field.role !== 'time') error(`aggregate dataset timeBucketBy "${bucket}" must reference a declared time field.`);
      else if (!field.grains?.includes(block.datasetGrain.timeGrain)) error(`aggregate dataset timeBucketBy "${bucket}" does not declare the ${block.datasetGrain.timeGrain} grain.`);
      if (!block.datasetGrain.keys.some((key) => key.toLowerCase() === bucket.toLowerCase())) error(`aggregate dataset timeBucketBy "${bucket}" must be included in the declared grain keys.`);
    }
  }
}

function domainDeclToManifestDomain(domain: any, filePath: string): ManifestDomain {
  return {
    id: typeof domain.id === 'string' ? domain.id : domainFolderSlug(domain.name),
    name: domain.name,
    filePath,
    parent: typeof domain.parent === 'string' ? domain.parent : undefined,
    owner: typeof domain.owner === 'string' ? domain.owner : undefined,
    businessOwner: typeof domain.businessOwner === 'string' ? domain.businessOwner : undefined,
    boundedContext: typeof domain.boundedContext === 'string' ? domain.boundedContext : undefined,
    sourceSystems: Array.isArray(domain.sourceSystems) ? domain.sourceSystems : undefined,
    primaryTerms: Array.isArray(domain.primaryTerms) ? domain.primaryTerms : undefined,
    reviewCadence: typeof domain.reviewCadence === 'string' ? domain.reviewCadence : undefined,
    tags: Array.isArray(domain.tags) ? domain.tags : undefined,
    businessOutcome: typeof domain.businessOutcome === 'string' ? domain.businessOutcome : undefined,
    description: typeof domain.description === 'string' ? domain.description : undefined,
    inScope: Array.isArray(domain.inScope) ? domain.inScope : undefined,
    outOfScope: Array.isArray(domain.outOfScope) ? domain.outOfScope : undefined,
    dbtGroups: Array.isArray(domain.dbtGroups) ? domain.dbtGroups : undefined,
    dbtPaths: Array.isArray(domain.dbtPaths) ? domain.dbtPaths : undefined,
    dbtTags: Array.isArray(domain.dbtTags) ? domain.dbtTags : undefined,
    semanticDomains: Array.isArray(domain.semanticDomains) ? domain.semanticDomains : undefined,
    semanticTags: Array.isArray(domain.semanticTags) ? domain.semanticTags : undefined,
    exports: Array.isArray(domain.exports) ? domain.exports : undefined,
  };
}

function termDeclToManifestTerm(term: any, filePath: string): ManifestTerm {
  return {
    name: term.name,
    filePath,
    domain: extractProp(term, 'domain'),
    owner: extractProp(term, 'owner'),
    status: extractProp(term, 'status'),
    termType: typeof term.termType === 'string' ? term.termType : undefined,
    tags: extractTags(term),
    description: extractProp(term, 'description'),
    identifiers: Array.isArray(term.identifiers) ? term.identifiers : undefined,
    synonyms: Array.isArray(term.synonyms) ? term.synonyms : undefined,
    metricRefs: Array.isArray(term.metricRefs) ? term.metricRefs : undefined,
    businessOutcome: typeof term.businessOutcome === 'string' ? term.businessOutcome : undefined,
    businessOwner: typeof term.businessOwner === 'string' ? term.businessOwner : undefined,
    decisionUse: typeof term.decisionUse === 'string' ? term.decisionUse : undefined,
    reviewCadence: typeof term.reviewCadence === 'string' ? term.reviewCadence : undefined,
    businessRules: Array.isArray(term.businessRules) ? term.businessRules : undefined,
    caveats: Array.isArray(term.caveats) ? term.caveats : undefined,
  };
}

function businessViewDeclToManifestBusinessView(view: any, filePath: string): ManifestBusinessView {
  const blockRefs: string[] = [];
  const businessViewRefs: string[] = [];
  for (const ref of view.includes ?? []) {
    if (ref.refType === 'block') blockRefs.push(ref.name);
    if (ref.refType === 'business_view') businessViewRefs.push(ref.name);
  }

  return {
    name: view.name,
    filePath,
    domain: extractProp(view, 'domain'),
    owner: extractProp(view, 'owner'),
    status: extractProp(view, 'status'),
    tags: extractTags(view),
    description: extractProp(view, 'description'),
    businessOutcome: typeof view.businessOutcome === 'string' ? view.businessOutcome : undefined,
    businessOwner: typeof view.businessOwner === 'string' ? view.businessOwner : undefined,
    decisionUse: typeof view.decisionUse === 'string' ? view.decisionUse : undefined,
    reviewCadence: typeof view.reviewCadence === 'string' ? view.reviewCadence : undefined,
    businessRules: Array.isArray(view.businessRules) ? view.businessRules : undefined,
    caveats: Array.isArray(view.caveats) ? view.caveats : undefined,
    blockRefs,
    businessViewRefs,
    termRefs: Array.isArray(view.termRefs) ? view.termRefs : [],
    declaredTermRefs: Array.isArray(view.termRefs) ? view.termRefs : [],
    inheritedTermRefs: [],
    unresolvedTermRefs: [],
    unresolvedBlockRefs: [],
    unresolvedBusinessViewRefs: [],
  };
}

function collectContractDiagnostics(
  ast: import('../ast/index.js').ProgramNode,
  relPath: string,
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
): void {
  if (!diagnostics) return;
  const hasContractRef = ast.statements.some((stmt: any) => stmt.kind === 'BlockDecl' && typeof stmt.datalexContract === 'string' && stmt.datalexContract.trim() !== '');
  if (!hasContractRef) return;

  const semanticDiagnostics = analyze(ast, { datalexRegistry });
  for (const diag of semanticDiagnostics) {
    if (!diag.message.includes('datalex_contract') && !diag.message.includes('DataLex manifest')) continue;
    diagnostics.push({
      kind: 'semantic',
      filePath: relPath,
      severity: diag.severity === 'error' ? 'error' : 'warning',
      message: diag.message,
    });
  }
}

function extractProp(block: any, propName: string): string | undefined {
  if (block[propName] !== undefined && block[propName] !== null) {
    return String(block[propName]);
  }
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === propName && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

function extractVisualizationChart(block: any): string | undefined {
  if (!block.visualization) return undefined;
  for (const prop of block.visualization.properties ?? []) {
    if (prop.name === 'chart' && prop.value?.kind === 'StringLiteral') {
      return String(prop.value.value);
    }
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

function extractDisplayHints(block: any): ManifestBlock['displayHints'] | undefined {
  const chart = extractVisualizationChart(block);
  const fieldHints: Record<string, string> = {};
  if (block.visualization) {
    for (const prop of block.visualization.properties ?? []) {
      const name = String(prop.name ?? prop.key ?? '');
      if (!['x', 'y', 'color', 'time', 'label', 'value', 'rank'].includes(name)) continue;
      const value = literalOrIdentifier(prop.value);
      if (value) fieldHints[name] = value;
    }
  }
  if (!chart && Object.keys(fieldHints).length === 0) return undefined;
  const allowed = new Set<string>();
  if (chart) allowed.add(chart);
  allowed.add('table');
  if (chart === 'bar' || chart === 'grouped_bar' || chart === 'stacked_bar') {
    allowed.add('line');
  }
  if (chart === 'line' || chart === 'area') {
    allowed.add('bar');
  }
  return {
    ...(chart ? { defaultVisualization: chart } : {}),
    allowedVisualizations: Array.from(allowed),
    ...(Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    source: 'block_visualization',
  };
}

function literalOrIdentifier(value: any): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'StringLiteral' || value.kind === 'Literal') return String(value.value);
  if (value.kind === 'Identifier') return String(value.name);
  if (typeof value.name === 'string') return value.name;
  if (typeof value.value === 'string' || typeof value.value === 'number') return String(value.value);
  return undefined;
}

function extractTags(block: any): string[] | undefined {
  if (Array.isArray(block.tags)) return block.tags;
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === 'tags' && prop.value?.kind === 'ArrayLiteral') {
      return prop.value.elements
        ?.map((e: any) => (e.kind === 'Literal' ? String(e.value) : null))
        .filter(Boolean);
    }
  }
  return undefined;
}

/**
 * v1.2 Track G — agent-facing metadata.
 * Pulls `llmContext`, `invariants`, `examples` directly from the parsed block
 * node. All three are optional; absent values return undefined so the MCP
 * layer can omit them.
 */
function extractAgentMetadata(block: any): {
  llmContext?: string;
  examples?: Array<{ question: string; sql?: string }>;
  invariants?: string[];
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
  synonyms?: string[];
  primaryTerms?: string[];
} {
  return {
    llmContext: typeof block.llmContext === 'string' ? block.llmContext : undefined,
    invariants: Array.isArray(block.invariants) ? block.invariants : undefined,
    examples: Array.isArray(block.examples) ? block.examples : undefined,
    businessOutcome: typeof block.businessOutcome === 'string' ? block.businessOutcome : undefined,
    businessOwner: typeof block.businessOwner === 'string' ? block.businessOwner : undefined,
    decisionUse: typeof block.decisionUse === 'string' ? block.decisionUse : undefined,
    reviewCadence: typeof block.reviewCadence === 'string' ? block.reviewCadence : undefined,
    businessRules: Array.isArray(block.businessRules) ? block.businessRules : undefined,
    caveats: Array.isArray(block.caveats) ? block.caveats : undefined,
    synonyms: Array.isArray(block.synonyms) && block.synonyms.length > 0 ? block.synonyms : undefined,
    primaryTerms: Array.isArray(block.primaryTerms) && block.primaryTerms.length > 0 ? block.primaryTerms : undefined,
  };
}

function extractDraftMetadata(block: any): NonNullable<ManifestBlock['draftMetadata']> | undefined {
  const metadata = stripUndefined({
    sourceQuestion: typeof block.sourceQuestion === 'string' ? block.sourceQuestion : undefined,
    sourceBlock: typeof block.sourceBlock === 'string' ? block.sourceBlock : undefined,
    sourceDqlKind: typeof block.sourceDqlKind === 'string' ? block.sourceDqlKind : undefined,
    sourceDqlName: typeof block.sourceDqlName === 'string' ? block.sourceDqlName : undefined,
    sourceDqlPath: typeof block.sourceDqlPath === 'string' ? block.sourceDqlPath : undefined,
    sourceDqlHash: typeof block.sourceDqlHash === 'string' ? block.sourceDqlHash : undefined,
    sourceDqlMetrics: Array.isArray(block.sourceDqlMetrics) ? block.sourceDqlMetrics : undefined,
    sourceDqlDimensions: Array.isArray(block.sourceDqlDimensions) ? block.sourceDqlDimensions : undefined,
    sourceDqlFilters: Array.isArray(block.sourceDqlFilters) ? block.sourceDqlFilters : undefined,
    sourceDqlTimeDimension: typeof block.sourceDqlTimeDimension === 'string' ? block.sourceDqlTimeDimension : undefined,
    sourceDqlGranularity: typeof block.sourceDqlGranularity === 'string' ? block.sourceDqlGranularity : undefined,
    sourceDqlOrderBy: Array.isArray(block.sourceDqlOrderBy) ? block.sourceDqlOrderBy : undefined,
    sourceDqlLimit: typeof block.sourceDqlLimit === 'number' ? block.sourceDqlLimit : undefined,
    followupKind: typeof block.followupKind === 'string' ? block.followupKind : undefined,
    requestedFilters: Array.isArray(block.requestedFilters) ? block.requestedFilters : undefined,
    requestedDimensions: Array.isArray(block.requestedDimensions) ? block.requestedDimensions : undefined,
    orderBy: Array.isArray(block.orderBy) ? block.orderBy : undefined,
    limit: typeof block.limit === 'number' ? block.limit : undefined,
    timeDimension: typeof block.timeDimension === 'string' ? block.timeDimension : undefined,
    granularity: typeof block.granularity === 'string' ? block.granularity : undefined,
    draftPath: typeof block.draftPath === 'string' ? block.draftPath : undefined,
    contextPackId: typeof block.contextPackId === 'string' ? block.contextPackId : undefined,
    routeIntent: typeof block.routeIntent === 'string' ? block.routeIntent : undefined,
    askedTimes: typeof block.askedTimes === 'number' ? block.askedTimes : undefined,
    validationWarnings: Array.isArray(block.validationWarnings) ? block.validationWarnings : undefined,
    proposedContractId: typeof block.proposedContractId === 'string' ? block.proposedContractId : undefined,
    proposedDomain: typeof block.proposedDomain === 'string' ? block.proposedDomain : undefined,
    proposedEntity: typeof block.proposedEntity === 'string' ? block.proposedEntity : undefined,
    upstreamRefs: Array.isArray(block.upstreamRefs) ? block.upstreamRefs : undefined,
    firstAsked: typeof block.firstAsked === 'string' ? block.firstAsked : undefined,
    lastAsked: typeof block.lastAsked === 'string' ? block.lastAsked : undefined,
  });
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function extractTests(block: any): string[] {
  if (Array.isArray(block.tests)) {
    return block.tests.map((a: any) => {
      if (typeof a === 'string') return a;
      const expected = formatManifestTestExpected(a.expected);
      return `${a.field ?? ''} ${a.operator ?? ''} ${expected}`.trim();
    });
  }
  if (!block.tests?.assertions) return [];
  return block.tests.assertions.map((a: any) => {
    if (typeof a === 'string') return a;
    return `${a.field ?? ''} ${a.operator ?? ''} ${a.expected ?? ''}`.trim();
  });
}

function formatManifestTestExpected(node: any): string {
  if (!node || typeof node !== 'object') return String(node ?? '');
  switch (node.kind) {
    case 'StringLiteral':
      return JSON.stringify(node.value);
    case 'NumberLiteral':
    case 'BooleanLiteral':
      return String(node.value);
    case 'Identifier':
      return node.name;
    case 'ArrayLiteral':
      return `[${(node.elements ?? []).map(formatManifestTestExpected).join(', ')}]`;
    default:
      return String(node.value ?? '');
  }
}

/**
 * Normalize DuckDB reader function calls to plain table names.
 * e.g., "read_csv_auto('./data/revenue.csv')" → "revenue"
 */
function normalizeTableName(name: string): string {
  const readerMatch = name.match(
    /^(?:read_csv_auto|read_csv|read_parquet|read_json|read_json_auto)\s*\(\s*['"]([^'"]+)['"]\s*\)$/i,
  );
  if (readerMatch) {
    const path = readerMatch[1];
    const filename = path.split('/').pop() ?? path;
    return filename.replace(/\.(csv|parquet|json)$/i, '');
  }
  return name;
}

/**
 * The project's modeling mode when manifest v3 modeling is active, else
 * undefined. `dbt-first` binds entities to dbt models; `warehouse-first` and
 * `hybrid` bind them to warehouse relations (RFC 0007).
 */
export function modelingModeOf(config: { manifestVersion?: number; modeling?: { mode?: string } }): 'dbt-first' | 'warehouse-first' | 'hybrid' | undefined {
  if (config.manifestVersion !== 3) return undefined;
  const mode = config.modeling?.mode;
  return mode === 'dbt-first' || mode === 'warehouse-first' || mode === 'hybrid' ? mode : undefined;
}
