import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { biSourceKind, isBiImportFile, readBiFile, readTmdlFolder, unreadableBiFile, type ExtractedBiFile } from './bi-import/index.js';
import { classifyCalculations, type BiCalculation } from './bi-import/calculations.js';
import type { BiCalculationModel, BiWorksheet } from './bi-import/types.js';
import { currentRecordOwner, ownedBy } from './host/record-owner.js';
import {
  foldSqlScript,
  splitAtStatementStarts,
  sqlLogicFingerprint,
  statementStartOffsets,
  unwrapStoredProcedures,
  type ImportedSqlParameter,
  type SkippedSqlStatement,
} from './sql-import-script.js';

export type { SkippedSqlStatement } from './sql-import-script.js';

export type BlockStudioImportSourceKind =
  | 'raw-sql-file'
  | 'raw-sql-folder'
  | 'tableau-workbook'
  | 'powerbi-project';

export type BlockStudioImportReviewStatus = 'draft' | 'review' | 'saved' | 'rejected';
export type BlockStudioImportInputMode = 'path' | 'paste' | 'upload';
export type BlockStudioImportSplitStrategy = 'semicolon-go' | 'metadata-comment' | 'statement-start' | 'manual';

export interface BlockStudioImportSource {
  path: string;
  content: string;
  /** An uploaded binary file (.twbx, .pbit) comes base64-encoded. */
  encoding?: 'base64';
}

export interface BlockStudioImportLineage {
  sourceTables: string[];
  parameters: string[];
  warnings: string[];
  statementIndex: number;
  totalStatements: number;
}

export interface BlockStudioAiAssistance {
  action: string;
  summary: string;
  createdAt: string;
  status: 'suggested' | 'accepted' | 'rejected';
  provider?: string;
  patch?: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'dqlSource'>>;
}

export interface BlockStudioCertificationChecklist {
  metadata: boolean;
  validation: boolean;
  run: boolean;
  tests: boolean;
  chart: boolean;
  lineage: boolean;
  aiReviewed: boolean;
  blockers: string[];
  checkedAt?: string;
}

export interface DqlGenerationEvidence {
  kind: 'dql_block' | 'dql_term' | 'business_view' | 'domain' | 'semantic_metric' | 'semantic_model' | 'dbt_model' | 'warehouse_table' | 'datalex_contract' | 'datalex_entity' | 'datalex_domain' | 'datalex_term' | 'metadata' | 'lineage';
  name: string;
  description?: string;
  objectKey?: string;
  source?: string;
  reason?: string;
  confidence?: number;
}

export interface BlockDraftSaveState {
  status: 'pending' | 'saved' | 'error' | 'skipped';
  path?: string;
  savedAt?: string;
  error?: string;
  reason?: string;
}

export type DqlParameterPolicyKind = 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
export type DqlParameterValue = string | number | boolean | Array<string | number | boolean>;

export interface DqlParameterDecision {
  name: string;
  policy: DqlParameterPolicyKind;
  value: DqlParameterValue;
  valueType: 'string' | 'number' | 'boolean' | 'date' | 'year' | 'set';
  sourceExpression: string;
  reason: string;
  confidence: number;
  /** A report parameter the imported SQL gave no value: the saved query declares it without a default. */
  required?: boolean;
}

export interface BlockFilterBinding {
  filter: string;
  binding: string;
}

export type BlockSimilarityMatchKind =
  | 'exact_sql_match'
  | 'parameterized_duplicate'
  | 'business_duplicate'
  | 'near_variant'
  | 'source_variant'
  | 'new_logic';

export type DqlCandidateRecommendedAction =
  | 'reuse_existing'
  | 'extend_existing'
  | 'create_replacement'
  | 'create_new'
  | 'review_required';

export interface BlockSimilarityMatch {
  kind: BlockSimilarityMatchKind;
  objectKey?: string;
  name: string;
  status?: string;
  source?: string;
  score: number;
  reason: string;
  recommendedAction: DqlCandidateRecommendedAction;
}

export interface BlockStudioImportCandidate {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  sourcePath: string;
  name: string;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  terms?: string[];
  pattern?: string;
  grain?: string;
  entities?: string[];
  outputs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  parameterPolicy?: Array<{ name: string; policy: string }>;
  filterBindings?: BlockFilterBinding[];
  sourceSystems?: string[];
  replacementFor?: string[];
  reviewCadence?: string;
  parameterDecisions?: DqlParameterDecision[];
  similarityMatches?: BlockSimilarityMatch[];
  recommendedAction?: DqlCandidateRecommendedAction;
  sql: string;
  dqlSource: string;
  validation: unknown | null;
  preview: unknown | null;
  lineage: BlockStudioImportLineage;
  confidence: number;
  splitStrategy: BlockStudioImportSplitStrategy;
  warnings: string[];
  conversionNotes: string[];
  /** What the import changed in the SQL, or could not do (a temp table folded into a WITH clause, a parameter without a value). */
  importNotes?: string[];
  aiAssistance: BlockStudioAiAssistance[];
  certificationChecklist?: BlockStudioCertificationChecklist;
  reviewStatus: BlockStudioImportReviewStatus;
  savedPath?: string;
  generationMode?: 'ai' | 'deterministic';
  generationProvider?: string;
  llmContext?: string;
  evidence?: DqlGenerationEvidence[];
  draftSave?: BlockDraftSaveState;
  analysisStatus?: 'queued' | 'retrieving' | 'reviewing' | 'previewing' | 'ready' | 'needs_attention';
}

export type DqlGenerationCandidate = BlockStudioImportCandidate & {
  generationMode: 'ai' | 'deterministic';
  generationProvider: string;
  llmContext: string;
  evidence: DqlGenerationEvidence[];
  draftSave: BlockDraftSaveState;
};

export interface BlockStudioImportManifest {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  inputPath: string;
  createdAt: string;
  updatedAt: string;
  inputMode: BlockStudioImportInputMode;
  sourceFiles: string[];
  defaults: {
    domain: string;
    owner: string;
    tags: string[];
  };
  candidateIds: string[];
  /** Statements that got no draft: they change data, run a procedure, or repeat a query already in this import. */
  skippedStatements?: SkippedSqlStatement[];
  /** With a host (RFC 0010): the person who imported; its SQL and preview rows are read only by them. */
  ownerId?: string;
}

export interface BlockStudioImportSession extends BlockStudioImportManifest {
  candidates: BlockStudioImportCandidate[];
}

export interface DqlGenerationSession extends Omit<BlockStudioImportSession, 'candidates'> {
  mode: 'ai-import';
  persistence?: 'session-only' | 'draft-files';
  generation: {
    provider: string;
    aiEnabled: boolean;
    contextObjectCount: number;
    createdDrafts: number;
    warnings: string[];
  };
  candidates: DqlGenerationCandidate[];
}

export interface BlockStudioImportSessionSummary {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  inputMode: BlockStudioImportInputMode;
  inputPath: string;
  sourceFiles: string[];
  createdAt: string;
  updatedAt: string;
  defaults: BlockStudioImportManifest['defaults'];
  candidateCount: number;
  savedCount: number;
  rejectedCount: number;
  warningCount: number;
}

export interface CreateBlockStudioImportOptions {
  sourceKind?: BlockStudioImportSourceKind | 'raw-sql';
  inputPath?: string;
  /** Which files under the import path may be read (a hosted server: project content only); others are skipped. */
  fileAllowed?: (absolutePath: string) => boolean;
  inputMode?: BlockStudioImportInputMode;
  sources?: BlockStudioImportSource[];
  domain?: string;
  owner?: string;
  tags?: string[];
}

interface SqlStatementCandidate {
  sourcePath: string;
  sql: string;
  statementIndex: number;
  totalStatements: number;
  splitStrategy: BlockStudioImportSplitStrategy;
  warnings: string[];
  parameters: ImportedSqlParameter[];
  notes: string[];
  sourceKind?: BlockStudioImportSourceKind;
}

interface SqlSource {
  path: string;
  content: string;
  /** Set for a query read out of a Tableau or Power BI file. */
  sourceKind?: BlockStudioImportSourceKind;
  /** The BI file's parameters, with their current values. */
  parameters?: ImportedSqlParameter[];
}

const ACTIVE_IMPORT_KINDS = new Set<BlockStudioImportSourceKind>(['raw-sql-file', 'raw-sql-folder', 'tableau-workbook', 'powerbi-project']);

/**
 * What an import would make, without saving anything: the drafts (one per
 * query, duplicates folded) and what is left out. `zlens migrate assess`
 * counts these, so its numbers are the import's own.
 */
export function planBlockStudioImport(
  projectRoot: string,
  options: CreateBlockStudioImportOptions,
): {
  sourceKind: BlockStudioImportSourceKind;
  inputPath: string;
  sourceFiles: string[];
  candidates: BlockStudioImportCandidate[];
  skippedStatements: SkippedSqlStatement[];
  importId: string;
  defaults: { domain: string; owner: string; tags: string[] };
  createdAt: string;
  /** The BI files' calculations and where their fields read from, for metric drafts. */
  calculations: ImportCalculations;
} {
  const sourceBundle = collectSqlSources(projectRoot, options);
  const sourceKind = sourceBundle.sourceKind;
  if (!ACTIVE_IMPORT_KINDS.has(sourceKind)) {
    throw new Error(`${sourceKind} import is planned but not implemented in this build.`);
  }

  const now = new Date().toISOString();
  const defaults = {
    domain: sanitizeDomain(options.domain || 'imported'),
    owner: options.owner?.trim() ?? '',
    tags: normalizeTags(['imported', 'raw-sql', ...(options.tags ?? [])]),
  };
  // A BI file with calculations and no SQL has no statements: its calculations become metric drafts instead.
  const collected = sourceBundle.sources.length ? collectSqlStatements(sourceBundle.sources) : { statements: [], skipped: [] };
  collected.skipped.unshift(...sourceBundle.skipped);
  const importId = buildImportId(sourceKind, sourceBundle.inputPath, now);
  const built = collected.statements.map((statement) => buildSqlCandidate({
    importId,
    sourceKind,
    projectRoot,
    statement,
    defaults,
  }));
  // The same query twice in one import (a report copied into two files) is
  // one draft; the copy is listed as skipped.
  const seen = new Map<string, BlockStudioImportCandidate>();
  const skippedStatements = [...collected.skipped];
  const candidates: BlockStudioImportCandidate[] = [];
  for (const candidate of built) {
    const fingerprint = sqlLogicFingerprint(candidate.sql);
    const first = seen.get(fingerprint);
    if (first) {
      skippedStatements.push({
        sourcePath: candidate.sourcePath,
        kind: 'duplicate',
        reason: `Same query as "${first.name}" (${first.sourcePath}).`,
        sql: candidate.sql.replace(/^(?:[ \t]*--[^\n]*\n)+/, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });
      continue;
    }
    seen.set(fingerprint, candidate);
    candidates.push(candidate);
  }
  return {
    sourceKind,
    inputPath: sourceBundle.inputPath,
    sourceFiles: sourceBundle.sources.map((source) => source.path),
    candidates,
    skippedStatements,
    importId,
    defaults,
    createdAt: now,
    calculations: sourceBundle.calculations,
  };
}

/** The calculations a BI file holds, with the tables and fields they read: what metric drafts are made from. */
export interface ImportCalculations {
  calculations: BiCalculation[];
  models: BiCalculationModel[];
  /** Tableau worksheets and their saved filters, for comparing an export of one. */
  worksheets?: BiWorksheet[];
}

/** The newest imported worksheet of this name, for the filters an export of it does not show. */
export function findImportedWorksheet(projectRoot: string, name: string): BiWorksheet | undefined {
  const wanted = name.trim().toLowerCase();
  for (const session of listBlockStudioImportSessions(projectRoot)) {
    const found = (readBlockStudioImportCalculations(projectRoot, session.id).worksheets ?? []).find((worksheet) => worksheet.name.trim().toLowerCase() === wanted);
    if (found) return found;
  }
  return undefined;
}

/** Whether any calculation could become a metric draft (simple, filtered or ratio). */
function hasMetricCalculations(calculations: ImportCalculations): boolean {
  return classifyCalculations(calculations.calculations).some((calculation) => calculation.kind === 'simple' || calculation.kind === 'filtered' || calculation.kind === 'ratio');
}

export function readBlockStudioImportCalculations(projectRoot: string, importId: string): ImportCalculations {
  ownImportManifest(projectRoot, importId);
  const file = join(importRoot(projectRoot, importId), 'calculations.json');
  if (!existsSync(file)) return { calculations: [], models: [] };
  return JSON.parse(readFileSync(file, 'utf-8')) as ImportCalculations;
}

export function createBlockStudioImportSession(
  projectRoot: string,
  options: CreateBlockStudioImportOptions,
): BlockStudioImportSession {
  const inputMode = options.inputMode ?? (options.sources?.length ? 'upload' : 'path');
  const { sourceKind, inputPath, sourceFiles, candidates, skippedStatements, importId, defaults, createdAt: now, calculations } = planBlockStudioImport(projectRoot, options);
  // A workbook with calculations and no SQL still imports: its calculations become metric drafts.
  if (candidates.length === 0 && !hasMetricCalculations(calculations)) {
    throw new Error(`Nothing to import: ${skippedStatements.length === 1 ? 'the one statement' : `all ${skippedStatements.length} statements`} found ${skippedStatements.length === 1 ? 'was' : 'were'} left out. ${skippedStatements.slice(0, 3).map((item) => item.reason).join(' ')}`);
  }
  giveUniqueNames(candidates);
  const manifest: BlockStudioImportManifest = {
    id: importId,
    sourceKind,
    inputPath,
    inputMode,
    sourceFiles,
    createdAt: now,
    updatedAt: now,
    defaults,
    candidateIds: candidates.map((candidate) => candidate.id),
    ...(skippedStatements.length ? { skippedStatements } : {}),
  };
  const session = { ...manifest, candidates };
  writeBlockStudioImportSession(projectRoot, session);
  if (calculations.calculations.length || calculations.worksheets?.length) writeFileSync(join(importRoot(projectRoot, importId), 'calculations.json'), JSON.stringify(calculations) + '\n', 'utf-8');
  return session;
}

/**
 * RFC 0010: with a host, an import session (its SQL, candidates and preview rows, run as the importer) is the
 * importer's. Someone else's, or one kept before the host, reads as not found. Returns the manifest, or null when
 * the session does not exist yet.
 */
function ownImportManifest(projectRoot: string, importId: string): BlockStudioImportManifest | null {
  const manifestPath = join(importRoot(projectRoot, importId), 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BlockStudioImportManifest;
  if (!ownedBy(manifest.ownerId, currentRecordOwner())) throw new Error(`Import session not found: ${importId}`);
  return manifest;
}

export function loadBlockStudioImportSession(projectRoot: string, importId: string): BlockStudioImportSession {
  const manifest = ownImportManifest(projectRoot, importId);
  if (!manifest) throw new Error(`Import session not found: ${importId}`);
  const candidates = manifest.candidateIds.map((candidateId) => readBlockStudioImportCandidate(projectRoot, importId, candidateId));
  return { ...manifest, candidates };
}

export function listBlockStudioImportSessions(projectRoot: string): BlockStudioImportSessionSummary[] {
  const root = join(projectRoot, '.dql', 'imports');
  if (!existsSync(root)) return [];
  const summaries: BlockStudioImportSessionSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const session = loadBlockStudioImportSession(projectRoot, entry.name);
      summaries.push({
        id: session.id,
        sourceKind: session.sourceKind,
        inputMode: session.inputMode ?? 'path',
        inputPath: session.inputPath,
        sourceFiles: session.sourceFiles ?? [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        defaults: session.defaults,
        candidateCount: session.candidates.length,
        savedCount: session.candidates.filter((candidate) => candidate.reviewStatus === 'saved').length,
        rejectedCount: session.candidates.filter((candidate) => candidate.reviewStatus === 'rejected').length,
        warningCount: session.candidates.reduce((sum, candidate) => sum + (candidate.warnings?.length ?? candidate.lineage.warnings.length), 0),
      });
    } catch {
      // Ignore partial sessions so one bad cache entry does not break Imports.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteBlockStudioImportSession(projectRoot: string, importId: string): void {
  ownImportManifest(projectRoot, importId);
  rmSync(importRoot(projectRoot, importId), { recursive: true, force: true });
}

export function clearBlockStudioImportSessions(projectRoot: string): number {
  const root = join(projectRoot, '.dql', 'imports');
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^imp_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    // With a host, only the person's own sessions.
    try { ownImportManifest(projectRoot, entry.name); } catch { continue; }
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function writeBlockStudioImportSession(projectRoot: string, session: BlockStudioImportSession): void {
  const existing = ownImportManifest(projectRoot, session.id);
  const owner = currentRecordOwner();
  const root = importRoot(projectRoot, session.id);
  const candidatesDir = join(root, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const manifest: BlockStudioImportManifest = {
    id: session.id,
    sourceKind: session.sourceKind,
    inputPath: session.inputPath,
    inputMode: session.inputMode ?? 'path',
    sourceFiles: session.sourceFiles ?? [],
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    defaults: session.defaults,
    candidateIds: session.candidates.map((candidate) => candidate.id),
    ...(session.skippedStatements?.length ? { skippedStatements: session.skippedStatements } : {}),
    ...(existing?.ownerId ? { ownerId: existing.ownerId } : typeof owner === 'string' ? { ownerId: owner } : {}),
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  for (const candidate of session.candidates) {
    writeBlockStudioImportCandidate(projectRoot, session.id, candidate);
  }
}

export function writeBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidate: BlockStudioImportCandidate,
): void {
  ownImportManifest(projectRoot, importId);
  const candidatesDir = join(importRoot(projectRoot, importId), 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  writeFileSync(join(candidatesDir, candidateFile(candidate.id)), JSON.stringify(candidate, null, 2) + '\n', 'utf-8');
}

/** A candidate id ZLens made: one file name in the import's folder, never a path. */
function candidateFile(candidateId: string): string {
  if (typeof candidateId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(candidateId) || candidateId.includes('..')) {
    throw new Error('Import candidate not found.');
  }
  return `${candidateId}.json`;
}

export function readBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidateId: string,
): BlockStudioImportCandidate {
  ownImportManifest(projectRoot, importId);
  const candidatePath = join(importRoot(projectRoot, importId), 'candidates', candidateFile(candidateId));
  if (!existsSync(candidatePath)) throw new Error(`Import candidate not found: ${candidateId}`);
  return JSON.parse(readFileSync(candidatePath, 'utf-8')) as BlockStudioImportCandidate;
}

export function updateBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidateId: string,
  patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'parameterDecisions' | 'similarityMatches' | 'recommendedAction' | 'sql' | 'reviewStatus' | 'llmContext' | 'evidence' | 'draftSave' | 'generationMode' | 'generationProvider' | 'savedPath' | 'conversionNotes'>>,
): BlockStudioImportCandidate {
  const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
  const next: BlockStudioImportCandidate = { ...candidate };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.domain !== undefined) next.domain = sanitizeDomain(patch.domain);
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.terms !== undefined) next.terms = normalizeStringList(patch.terms);
  if (patch.pattern !== undefined) next.pattern = normalizePattern(patch.pattern);
  if (patch.grain !== undefined) next.grain = patch.grain;
  if (patch.entities !== undefined) next.entities = normalizeStringList(patch.entities);
  if (patch.outputs !== undefined) next.outputs = normalizeStringList(patch.outputs);
  if (patch.dimensions !== undefined) next.dimensions = normalizeStringList(patch.dimensions);
  if (patch.allowedFilters !== undefined) next.allowedFilters = normalizeStringList(patch.allowedFilters);
  if (patch.parameterPolicy !== undefined) next.parameterPolicy = normalizeParameterPolicy(patch.parameterPolicy);
  if (patch.filterBindings !== undefined) next.filterBindings = normalizeFilterBindings(patch.filterBindings);
  if (patch.sourceSystems !== undefined) next.sourceSystems = normalizeStringList(patch.sourceSystems);
  if (patch.replacementFor !== undefined) next.replacementFor = normalizeStringList(patch.replacementFor);
  if (patch.reviewCadence !== undefined) next.reviewCadence = normalizeReviewCadence(patch.reviewCadence) || 'monthly';
  if (patch.parameterDecisions !== undefined) next.parameterDecisions = patch.parameterDecisions;
  if (patch.similarityMatches !== undefined) next.similarityMatches = patch.similarityMatches;
  if (patch.recommendedAction !== undefined) next.recommendedAction = patch.recommendedAction;
  if (patch.sql !== undefined) next.sql = patch.sql;
  if (patch.reviewStatus !== undefined) next.reviewStatus = patch.reviewStatus;
  if (patch.llmContext !== undefined) next.llmContext = patch.llmContext;
  if (patch.evidence !== undefined) next.evidence = patch.evidence;
  if (patch.draftSave !== undefined) next.draftSave = patch.draftSave;
  if (patch.generationMode !== undefined) next.generationMode = patch.generationMode;
  if (patch.generationProvider !== undefined) next.generationProvider = patch.generationProvider;
  if (patch.savedPath !== undefined) next.savedPath = patch.savedPath;
  if (patch.conversionNotes !== undefined) next.conversionNotes = patch.conversionNotes;
  if (patch.name || patch.domain || patch.description || patch.owner || patch.tags || patch.terms || patch.pattern || patch.grain || patch.entities || patch.outputs || patch.dimensions || patch.allowedFilters || patch.parameterPolicy || patch.filterBindings || patch.sourceSystems || patch.replacementFor || patch.reviewCadence || patch.parameterDecisions || patch.sql || patch.llmContext) {
    next.dqlSource = candidateToDqlSource(next);
    next.lineage = {
      ...next.lineage,
      sourceTables: extractSourceTables(next.sql),
      parameters: extractSqlParameters(next.sql),
      warnings: [...analyzeSqlWarnings(next.sql, next.lineage.totalStatements), ...(next.importNotes ?? [])],
    };
    next.warnings = next.lineage.warnings;
    next.confidence = scoreSqlCandidate(next.sql, next.lineage);
  }
  writeBlockStudioImportCandidate(projectRoot, importId, next);
  return next;
}

export function candidateToDqlSource(candidate: Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'parameterDecisions' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'llmContext'>): string {
  const tags = normalizeTags(candidate.tags).map((tag) => dqlString(tag)).join(', ');
  const terms = normalizeStringList(candidate.terms ?? []).slice(0, 16);
  const sql = candidate.sql.trim().replace(/"""/g, '\\"\\"\\"');
  const llmContext = candidate.llmContext?.trim();
  const pattern = normalizePattern(candidate.pattern || inferSqlPattern(candidate.sql));
  const grain = candidate.grain?.trim() || inferSqlGrain(candidate.sql);
  const outputs = normalizeStringList(candidate.outputs?.length ? candidate.outputs : inferSqlOutputs(candidate.sql)).slice(0, 24);
  const dimensions = normalizeStringList(candidate.dimensions?.length ? candidate.dimensions : inferSqlDimensions(candidate.sql, grain, outputs)).slice(0, 16);
  const sourceSystems = normalizeStringList(candidate.sourceSystems?.length ? candidate.sourceSystems : inferSqlSourceSystems(candidate.sql)).slice(0, 12);
  const entities = normalizeStringList(candidate.entities?.length ? candidate.entities : inferSqlEntities(grain, sourceSystems)).slice(0, 12);
  const allowedFilters = normalizeStringList(candidate.allowedFilters?.length ? candidate.allowedFilters : inferSqlFilters(candidate.sql)).slice(0, 16);
  const parameterDecisions = normalizeParameterDecisions(candidate.parameterDecisions ?? []);
  const parameterPolicy = normalizeParameterPolicy(candidate.parameterPolicy?.length
    ? candidate.parameterPolicy
    : parameterDecisions.map((decision) => ({ name: decision.name, policy: decision.policy })));
  const filterBindings = normalizeFilterBindings(candidate.filterBindings ?? []);
  const reviewCadence = normalizeReviewCadence(candidate.reviewCadence || 'monthly');
  const params = parameterDecisions.filter((decision) => decision.policy !== 'static');
  const lines: string[] = [
    `block ${dqlString(candidate.name)} {`,
    '    status = "draft"',
    `    domain = ${dqlString(sanitizeDomain(candidate.domain))}`,
    '    type = "custom"',
    `    description = ${dqlString(candidate.description)}`,
    `    tags = [${tags}]`,
  ];
  if (candidate.owner.trim()) lines.push(`    owner = ${dqlString(candidate.owner)}`);
  if (pattern) lines.push(`    pattern = ${dqlString(pattern)}`);
  if (grain) lines.push(`    grain = ${dqlString(grain)}`);
  if (entities.length > 0) lines.push(`    entities = [${entities.map(dqlString).join(', ')}]`);
  if (outputs.length > 0) lines.push(`    outputs = [${outputs.map(dqlString).join(', ')}]`);
  if (terms.length > 0) lines.push(`    terms = [${terms.map(dqlString).join(', ')}]`);
  if (dimensions.length > 0) lines.push(`    dimensions = [${dimensions.map(dqlString).join(', ')}]`);
  if (allowedFilters.length > 0) lines.push(`    allowedFilters = [${allowedFilters.map(dqlString).join(', ')}]`);
  if (parameterPolicy.length > 0) {
    lines.push('    parameterPolicy {');
    lines.push(...parameterPolicy.map((entry) => `        ${entry.name} = ${dqlString(entry.policy)}`));
    lines.push('    }');
  }
  if (filterBindings.length > 0) {
    lines.push('    filterBindings {');
    lines.push(...filterBindings.map((entry) => `        ${entry.filter} = ${dqlString(entry.binding)}`));
    lines.push('    }');
  }
  if (sourceSystems.length > 0) lines.push(`    sourceSystems = [${sourceSystems.map(dqlString).join(', ')}]`);
  if (candidate.replacementFor?.length) lines.push(`    replacementFor = [${candidate.replacementFor.map(dqlString).join(', ')}]`);
  if (reviewCadence) lines.push(`    reviewCadence = ${dqlString(reviewCadence)}`);
  if (llmContext) lines.push(`    llmContext = ${dqlString(llmContext)}`);
  if (params.length > 0) {
    lines.push('', '    params {');
    // A report parameter the imported SQL gave no value is declared with its
    // type only: the saved query asks for it until someone sets a default.
    lines.push(...params.map((param) => (param.required
      ? `        ${param.name}: ${dqlParamType(param.valueType)}`
      : `        ${param.name} = ${formatDqlLiteral(param.value)}`)));
    lines.push('    }');
  }
  // A block whose query is empty is not a runnable custom block. This was emitted
  // unconditionally, so a SEMANTIC answer (metrics/dimensions, no SQL) was written
  // out as type="custom" with `query = """ """` — a block that can never execute.
  // Emit the section only when there is SQL to put in it.
  if (sql.trim()) {
    lines.push('', '    query = """', sql, '    """');
  }
  lines.push('', '    visualization {', '        chart = "table"', '    }');
  lines.push('', '    tests {', '        assert row_count > 0', '    }', '}');
  return `${lines.join('\n')}\n`;
}

function normalizeParameterPolicy(value: Array<{ name: string; policy: string }>): Array<{ name: string; policy: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; policy: string }> = [];
  for (const item of value) {
    const name = normalizeIdentifier(item.name);
    const policy = String(item.policy ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!name || !policy || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, policy });
  }
  return result.slice(0, 24);
}

function normalizeFilterBindings(value: BlockFilterBinding[]): BlockFilterBinding[] {
  const seen = new Set<string>();
  const result: BlockFilterBinding[] = [];
  for (const item of value) {
    const filter = normalizeIdentifier(item.filter);
    const binding = String(item.binding ?? '').trim();
    if (!filter || !binding || seen.has(filter)) continue;
    seen.add(filter);
    result.push({ filter, binding });
  }
  return result.slice(0, 24);
}

function normalizeReviewCadence(value: string | undefined): string {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_ -]+/g, '').replace(/\s+/g, '_');
  const allowed = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual']);
  return allowed.has(normalized) ? normalized : '';
}

function normalizeParameterDecisions(value: DqlParameterDecision[]): DqlParameterDecision[] {
  const seen = new Set<string>();
  const result: DqlParameterDecision[] = [];
  for (const item of value) {
    const name = normalizeIdentifier(item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({
      ...item,
      name,
      policy: normalizeParameterPolicyKind(item.policy),
      reason: item.reason || 'Detected from imported SQL literal.',
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
    });
  }
  return result.slice(0, 24);
}

function normalizeParameterPolicyKind(value: string): DqlParameterPolicyKind {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'dynamic'
    || normalized === 'static'
    || normalized === 'business'
    || normalized === 'derived'
    || normalized === 'optional'
    || normalized === 'ambiguous_review_required'
  ) return normalized;
  return 'ambiguous_review_required';
}

function normalizeIdentifier(value: string): string {
  return String(value || '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, '_$1');
}

function dqlParamType(valueType: DqlParameterDecision['valueType']): string {
  if (valueType === 'date') return 'date';
  if (valueType === 'number' || valueType === 'year') return 'number';
  if (valueType === 'boolean') return 'boolean';
  if (valueType === 'set') return 'string[]';
  return 'string';
}

function formatDqlLiteral(value: DqlParameterValue): string {
  if (Array.isArray(value)) return `[${value.map(formatDqlLiteral).join(', ')}]`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return dqlString(String(value));
}

export interface DqlSqlParameterizationResult {
  sql: string;
  parameterDecisions: DqlParameterDecision[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  filterBindings: BlockFilterBinding[];
  allowedFilters: string[];
  warnings: string[];
}

export function parameterizeSqlForDqlImport(sql: string): DqlSqlParameterizationResult {
  let nextSql = sql;
  const decisions = new Map<string, DqlParameterDecision>();
  const bindings = new Map<string, BlockFilterBinding>();
  const warnings: string[] = [];
  const addDecision = (decision: DqlParameterDecision) => {
    const name = normalizeIdentifier(decision.name);
    if (!name || decisions.has(name)) return name;
    decisions.set(name, { ...decision, name });
    return name;
  };
  const addBinding = (filter: string, binding: string) => {
    const normalized = normalizeIdentifier(filter);
    if (!normalized || bindings.has(normalized)) return;
    bindings.set(normalized, { filter: normalized, binding: binding.trim() });
  };
  const availableParamName = (preferred: string, fallback: string): string => {
    const normalized = normalizeIdentifier(preferred);
    return normalized && !decisions.has(normalized) ? normalized : normalizeIdentifier(fallback);
  };
  const availableFilterName = (preferred: string, fallback: string): string => {
    const normalized = normalizeIdentifier(preferred);
    return normalized && !bindings.has(normalized) ? normalized : normalizeIdentifier(fallback);
  };
  const placeholder = (name: string) => '${' + name + '}';

  const yearLiterals = extractYearLiterals(nextSql);
  const yearParamName = (year: number): string => {
    if (yearLiterals.length <= 1) return 'season_year';
    if (year === yearLiterals[0]) return 'season_start';
    if (year === yearLiterals[yearLiterals.length - 1]) return 'season_end';
    return `season_year_${year}`;
  };
  if (yearLiterals.length > 0) {
    nextSql = nextSql.replace(
      /(extract\s*\(\s*year\s+from\s+([^)]+?)\s*\)\s*(?:>=|<=|<>|!=|=|>|<)\s*)([12][0-9]{3})/gi,
      (match, prefix: string, column: string, yearValue: string) => {
        if (match.includes('${')) return match;
        const year = Number(yearValue);
        const name = addDecision({
          name: yearParamName(year),
          policy: 'dynamic',
          value: year,
          valueType: 'year',
          sourceExpression: `EXTRACT(YEAR FROM ${column.trim()})`,
          reason: 'Year literal is user scope and should be reusable across seasons.',
          confidence: 0.94,
        });
        addBinding(yearLiterals.length > 1 ? 'season_range' : 'season', `${column.trim()}.year`);
        return `${prefix}${placeholder(name)}`;
      },
    );
    nextSql = nextSql.replace(
      /(extract\s*\(\s*year\s+from\s+([^)]+?)\s*\)\s+in\s*\()([^)]+)(\))/gi,
      (match, prefix: string, column: string, list: string, suffix: string) => {
        if (match.includes('${')) return match;
        const listYears = extractYearValuesFromList(list);
        const normalizedColumn = column.trim();
        if (listYears.length === 1) {
          const name = addDecision({
            name: 'season_year',
            policy: 'dynamic',
            value: listYears[0],
            valueType: 'year',
            sourceExpression: `EXTRACT(YEAR FROM ${normalizedColumn})`,
            reason: 'Single-year list literal is user scope and should be reusable across seasons.',
            confidence: 0.94,
          });
          addBinding('season', `${normalizedColumn}.year`);
          return `EXTRACT(YEAR FROM ${normalizedColumn}) = ${placeholder(name)}`;
        }
        if (listYears.length > 1 && isContiguousYearRange(listYears)) {
          const firstYear = listYears[0];
          const lastYear = listYears[listYears.length - 1];
          const startName = addDecision({
            name: 'season_start',
            policy: 'dynamic',
            value: firstYear,
            valueType: 'year',
            sourceExpression: `EXTRACT(YEAR FROM ${normalizedColumn})`,
            reason: 'Contiguous year list is treated as a reusable season range.',
            confidence: 0.95,
          });
          const endName = addDecision({
            name: 'season_end',
            policy: 'dynamic',
            value: lastYear,
            valueType: 'year',
            sourceExpression: `EXTRACT(YEAR FROM ${normalizedColumn})`,
            reason: 'Contiguous year list is treated as a reusable season range.',
            confidence: 0.95,
          });
          addBinding('season_range', `${normalizedColumn}.year`);
          return `EXTRACT(YEAR FROM ${normalizedColumn}) BETWEEN ${placeholder(startName)} AND ${placeholder(endName)}`;
        }
        const replaced = list.replace(/\b([12][0-9]{3})\b/g, (_yearMatch, yearValue: string) => {
          const year = Number(yearValue);
          const name = addDecision({
            name: `season_year_${year}`,
            policy: 'dynamic',
            value: year,
            valueType: 'year',
            sourceExpression: `EXTRACT(YEAR FROM ${normalizedColumn})`,
            reason: 'Non-contiguous year list is user scope and should remain an explicit selected set.',
            confidence: 0.94,
          });
          return placeholder(name);
        });
        addBinding('season_set', `${normalizedColumn}.year`);
        return `${prefix}${replaced}${suffix}`;
      },
    );
  }

  nextSql = nextSql.replace(/\blimit\s+([0-9]+)\b/gi, (match, value: string) => {
    if (match.includes('${')) return match;
    const topN = Number(value);
    if (!Number.isFinite(topN) || topN <= 0 || topN > 10000) return match;
    const name = addDecision({
      name: 'top_n',
      policy: 'dynamic',
      value: topN,
      valueType: 'number',
      sourceExpression: 'LIMIT',
      reason: 'Top/bottom row count is presentation scope and should be reusable.',
      confidence: 0.9,
    });
    return match.replace(value, placeholder(name));
  });

  nextSql = nextSql.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+between\s+(?:date\s+)?'([12][0-9]{3}-[01][0-9]-[0-3][0-9])'\s+and\s+(?:date\s+)?'([12][0-9]{3}-[01][0-9]-[0-3][0-9])'/gi,
    (match, column: string, startValue: string, endValue: string) => {
      if (match.includes('${') || !isDateScopeColumn(column)) return match;
      const columnName = lastIdentifierPart(column);
      const startName = addDecision({
        name: availableParamName('start_date', `${columnName}_start_date`),
        policy: 'dynamic',
        value: startValue,
        valueType: 'date',
        sourceExpression: column,
        reason: 'Date range literal is runtime scope and should be controlled by app filters.',
        confidence: 0.9,
      });
      const endName = addDecision({
        name: availableParamName('end_date', `${columnName}_end_date`),
        policy: 'dynamic',
        value: endValue,
        valueType: 'date',
        sourceExpression: column,
        reason: 'Date range literal is runtime scope and should be controlled by app filters.',
        confidence: 0.9,
      });
      addBinding(availableFilterName('date_range', `${columnName}_range`), column);
      return `${column} BETWEEN ${placeholder(startName)} AND ${placeholder(endName)}`;
    },
  );

  nextSql = nextSql.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(>=|<=|=|>|<)\s*'([12][0-9]{3}-[01][0-9]-[0-3][0-9])'/gi,
    (match, column: string, operator: string, value: string) => {
      if (match.includes('${') || !isDateScopeColumn(column)) return match;
      const name = operator === '>=' || operator === '>' ? 'start_date' : operator === '<=' || operator === '<' ? 'end_date' : `${lastIdentifierPart(column)}_date`;
      const paramName = addDecision({
        name,
        policy: 'dynamic',
        value,
        valueType: 'date',
        sourceExpression: column,
        reason: 'Date literal is runtime scope and should be controlled by app filters.',
        confidence: 0.88,
      });
      addBinding(name === 'start_date' || name === 'end_date' ? 'date_range' : name, column);
      return `${column} ${operator} ${placeholder(paramName)}`;
    },
  );

  nextSql = nextSql.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+in\s*\(([^)]*)\)/gi,
    (match, column: string, rawList: string) => {
      if (match.includes('${') || /\bextract\s*\(/i.test(match)) return match;
      const columnName = lastIdentifierPart(column);
      if (!isRuntimeScopeColumn(columnName)) return match;
      const values = parseSqlLiteralList(rawList);
      if (!values || values.length === 0) return match;
      const name = addDecision({
        name: `${columnName}_set`,
        policy: 'dynamic',
        value: values,
        valueType: 'set',
        sourceExpression: column,
        reason: 'Selected-set literal is user scope and should stay reusable for one or many values.',
        confidence: 0.86,
      });
      addBinding(`${columnName}_set`, column);
      return `${column} IN (${placeholder(name)})`;
    },
  );

  // Pattern filters are how models most often express a member scope
  // (customer_name ILIKE '%Capital One%'). Parameterize them like equality
  // literals so the Ask filter chooser can offer and re-apply the value —
  // without this, LIKE-filtered answers exposed no runtime-editable inputs
  // and the auto filter pickup appeared "missing". NOT LIKE stays literal.
  nextSql = nextSql.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+(I?LIKE)\s+('(?:''|[^'])*')/gi,
    (match, column: string, likeKeyword: string, rawValue: string) => {
      if (match.includes('${') || /\bnot\s+i?like\b/i.test(match)) return match;
      const columnName = lastIdentifierPart(column);
      if (!isRuntimeScopeColumn(columnName)) return match;
      const literal = parseSqlLiteral(rawValue);
      const name = addDecision({
        name: columnName,
        policy: 'dynamic',
        value: literal,
        valueType: 'string',
        sourceExpression: column,
        reason: 'Pattern filter is user scope and should be reusable.',
        confidence: 0.8,
      });
      addBinding(columnName, column);
      return `${column} ${likeKeyword} ${placeholder(name)}`;
    },
  );

  nextSql = nextSql.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*('(?:''|[^'])*'|[0-9]+(?:\.[0-9]+)?)/gi,
    (match, column: string, rawValue: string) => {
      if (match.includes('${') || /extract\s*\(/i.test(match)) return match;
      const columnName = lastIdentifierPart(column);
      if (!isRuntimeScopeColumn(columnName)) {
        const literal = parseSqlLiteral(rawValue);
        if (isBusinessRuleLiteral(columnName, literal)) {
          const name = addDecision({
            name: `${columnName}_rule`,
            policy: 'static',
            value: literal,
            valueType: typeof literal === 'number' ? 'number' : 'string',
            sourceExpression: column,
            reason: 'Literal appears to define a fixed business rule, not runtime scope.',
            confidence: 0.72,
          });
          warnings.push(`Kept ${columnName} as static business logic (${name}).`);
        }
        return match;
      }
      const literal = parseSqlLiteral(rawValue);
      const name = addDecision({
        name: columnName,
        policy: 'dynamic',
        value: literal,
        valueType: typeof literal === 'number' ? 'number' : 'string',
        sourceExpression: column,
        reason: 'Filter literal is user scope and should be reusable.',
        confidence: 0.82,
      });
      addBinding(columnName, column);
      return `${column} = ${placeholder(name)}`;
    },
  );

  const parameterDecisions = Array.from(decisions.values());
  const parameterPolicy = parameterDecisions.map((decision) => ({ name: decision.name, policy: decision.policy }));
  const filterBindings = Array.from(bindings.values());
  const allowedFilters = Array.from(new Set([
    ...filterBindings.map((binding) => binding.filter),
    ...parameterDecisions.filter((decision) => decision.policy === 'dynamic').map((decision) => decision.name),
  ])).slice(0, 16);

  return { sql: nextSql, parameterDecisions, parameterPolicy, filterBindings, allowedFilters, warnings };
}

function extractYearLiterals(sql: string): number[] {
  const years = new Set<number>();
  const cleaned = stripSqlComments(sql);
  const extractRegex = /extract\s*\(\s*year\s+from\s+[^)]+\)\s*(?:(?:>=|<=|<>|!=|=|>|<)\s*([12][0-9]{3})|\s+in\s*\(([^)]*)\))/gi;
  let match: RegExpExecArray | null;
  while ((match = extractRegex.exec(cleaned))) {
    for (const value of [match[1], ...(match[2]?.match(/[12][0-9]{3}/g) ?? [])]) {
      if (value) years.add(Number(value));
    }
  }
  return Array.from(years).sort((a, b) => a - b);
}

function extractYearValuesFromList(list: string): number[] {
  const years = new Set<number>();
  for (const value of list.match(/\b[12][0-9]{3}\b/g) ?? []) {
    years.add(Number(value));
  }
  return Array.from(years).sort((a, b) => a - b);
}

function isContiguousYearRange(years: number[]): boolean {
  if (years.length < 2) return false;
  for (let index = 1; index < years.length; index += 1) {
    if (years[index] !== years[index - 1] + 1) return false;
  }
  return true;
}

function lastIdentifierPart(column: string): string {
  return normalizeIdentifier(column.split('.').pop() ?? column).toLowerCase();
}

function stripSqlIdentifierQuotes(value: string): string {
  return value.replace(/["\[\]]/g, '').replaceAll('`', '');
}

function parseSqlLiteral(raw: string): string | number {
  if (/^'/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function parseSqlLiteralList(rawList: string): Array<string | number> | null {
  const parts = splitSqlList(rawList).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const values: Array<string | number> = [];
  for (const part of parts) {
    if (!/^(?:'(?:''|[^'])*'|[0-9]+(?:\.[0-9]+)?)$/i.test(part)) return null;
    values.push(parseSqlLiteral(part));
  }
  return values;
}

function isDateScopeColumn(column: string): boolean {
  return /(date|day|time|period|month|week)/i.test(column);
}

function isRuntimeScopeColumn(column: string): boolean {
  const normalized = normalizeIdentifier(column).toLowerCase();
  return /(?:^|_)(player|team|customer|account|user|segment|region|product|position|market|channel|country|state|city|league|season|year)(?:_|$)/i.test(normalized)
    || /(?:^|_)(id|key|name|code)$/i.test(normalized);
}

function isBusinessRuleLiteral(column: string, value: string | number): boolean {
  const text = String(value).toLowerCase();
  return /(status|state|type|flag|is_|mode|category)/i.test(column)
    && /^(active|approved|complete|completed|valid|regular|true|1|yes|current)$/i.test(text);
}
function inferSqlGrain(sql: string): string {
  const groupFields = extractGroupByFields(sql);
  return groupFields[0] ?? '';
}

function inferSqlPattern(sql: string): string {
  const lower = stripSqlComments(sql).toLowerCase();
  const groupFields = extractGroupByFields(sql);
  if (/@metric\s*\(/i.test(sql)) return 'metric_wrapper';
  if (/\bjoin\b/i.test(sql)) {
    const systems = new Set(inferSqlSourceSystems(sql));
    if (systems.size > 1) return 'bridge';
  }
  if (hasRankingLimit(sql)) return 'ranking';
  if (groupFields.some((field) => /\b(date|day|week|month|quarter|year|period|time)\b/i.test(field))) return 'trend';
  if (groupFields.length === 1 && /_id$|_key$/i.test(groupFields[0])) return 'entity_rollup';
  if (!/\b(sum|count|avg|min|max|median|percentile|rank)\s*\(/i.test(lower) && /\b(dim|profile|customer|account|player|product|user|entity)\b/i.test(lower)) {
    return 'entity_profile';
  }
  return 'custom';
}

function hasRankingLimit(sql: string): boolean {
  return /\border\s+by\b[\s\S]*\blimit\s+(?:\d+|\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}|[:?][A-Za-z_][A-Za-z0-9_]*)/i.test(sql);
}

function inferSqlOutputs(sql: string): string[] {
  const selectMatch = sql.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!selectMatch) return [];
  return splitSqlList(selectMatch[1])
    .map((expr) => {
      const alias = expr.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]
        ?? expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1]
        ?? '';
      return stripSqlIdentifierQuotes(alias);
    })
    .filter(Boolean)
    .filter((name) => !/^(from|where|group|order|limit)$/i.test(name));
}

function inferSqlFilters(sql: string): string[] {
  const filters = new Set<string>();
  const where = sql.match(/\bwhere\b([\s\S]+?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)?.[1] ?? '';
  const addFilter = (value: string | undefined) => {
    const name = stripSqlIdentifierQuotes(value?.split('.').pop() ?? '');
    if (name && !/^(and|or|not|null|year|month|day)$/i.test(name)) filters.add(name);
  };
  const extractRegex = /\bextract\s*\([^)]*\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  const isNullRegex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s+is\s+(?:not\s+)?null\b/gi;
  const regex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = extractRegex.exec(where))) addFilter(match[1]);
  while ((match = isNullRegex.exec(where))) addFilter(match[1]);
  while ((match = regex.exec(where))) {
    addFilter(match[1]);
  }
  return [...filters];
}

function inferSqlSourceSystems(sql: string): string[] {
  return extractSourceTables(sql)
    .map((table) => table.split('.').filter(Boolean).slice(-2, -1)[0] ?? table.split('.').filter(Boolean)[0])
    .filter(Boolean)
    .map((value) => businessToken(value))
    .filter(Boolean);
}

function inferSqlEntities(grain: string, sourceSystems: string[]): string[] {
  const entity = grain && /_id$|_key$/i.test(grain) ? businessEntityFromIdentifier(grain) : '';
  return Array.from(new Set([entity, ...sourceSystems.map(businessEntityFromIdentifier)].filter(Boolean)));
}

function inferSqlDimensions(sql: string, grain: string, outputs: string[]): string[] {
  const outputSet = new Set(outputs.map((output) => output.toLowerCase()));
  return extractGroupByFields(sql)
    .filter((field) => field !== grain)
    .filter((field) => !outputSet.has(field.toLowerCase()))
    .filter((field) => !/\b(total|count|sum|avg|average|min|max|rate|pct|percent|amount|revenue|points?|score)\b/i.test(field))
    .slice(0, 16);
}

function extractGroupByFields(sql: string): string[] {
  const match = sql.match(/\bgroup\s+by\b([\s\S]+?)(?:\border\s+by\b|\blimit\b|\bqualify\b|\bhaving\b|$)/i);
  if (!match) return [];
  return splitSqlList(match[1])
    .map((item) => stripSqlIdentifierQuotes(item).trim())
    .filter((item) => item && !/^\d+$/.test(item))
    .map((item) => item.split('.').pop() ?? item)
    .slice(0, 4);
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!double && char === "'" && value[i - 1] !== '\\') single = !single;
    else if (!single && char === '"' && value[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '(') depth += 1;
    else if (!single && !double && char === ')' && depth > 0) depth -= 1;
    else if (!single && !double && depth === 0 && char === ',') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function collectSqlStatements(sources: SqlSource[]): { statements: SqlStatementCandidate[]; skipped: SkippedSqlStatement[] } {
  const statements: SqlStatementCandidate[] = [];
  const skipped: SkippedSqlStatement[] = [];
  for (const source of sources) {
    // A stored procedure becomes its body; then the file is split into
    // statements and each script is folded into the queries it ends in.
    const split = splitSqlStatements(unwrapStoredProcedures(source.content));
    const folded = foldSqlScript(split.statements.filter(hasExecutableSql), { parameters: source.parameters ?? [] });
    skipped.push(...folded.skipped.map((item) => ({ ...item, sourcePath: source.path })));
    const queries = folded.queries.filter((query) => hasExecutableSql(query.sql));
    const sharedWarnings = queries.length === 1 ? analyzeSqlWarnings(queries[0].sql, queries.length) : [];
    queries.forEach((query, index) => {
      statements.push({
        sourcePath: source.path,
        sql: query.sql,
        statementIndex: index + 1,
        totalStatements: queries.length,
        splitStrategy: split.strategy,
        warnings: index === 0 ? sharedWarnings : [],
        parameters: query.parameters,
        notes: query.notes,
        ...(source.sourceKind ? { sourceKind: source.sourceKind } : {}),
      });
    });
  }
  if (statements.length === 0 && skipped.length === 0) throw new Error('No SQL statements found to import.');
  return { statements, skipped };
}

function buildSqlCandidate(options: {
  importId: string;
  sourceKind: BlockStudioImportSourceKind;
  projectRoot: string;
  statement: SqlStatementCandidate;
  defaults: { domain: string; owner: string; tags: string[] };
}): BlockStudioImportCandidate {
  const statement = options.statement;
  const sourcePath = displayPath(options.projectRoot, statement.sourcePath);
  const metadata = extractStatementMetadata(statement.sql);
  const sourceTables = extractSourceTables(statement.sql);
  const inferred = inferStatementBusinessMetadata(statement.sql, sourcePath, sourceTables);
  // A name header wins, then a short comment right above the query, then a
  // name read from the SQL. Names that repeat in one import get a number
  // afterwards (giveUniqueNames).
  const name = metadata.name || metadata.title || inferred.name || basename(statement.sourcePath, extname(statement.sourcePath));
  const parameters = extractSqlParameters(statement.sql);
  const parameterDecisions: DqlParameterDecision[] = statement.parameters.map((parameter) => ({
    name: parameter.name,
    policy: 'dynamic',
    value: parameter.default ?? '',
    valueType: parameter.valueType,
    sourceExpression: parameter.written,
    reason: `Report parameter ${parameter.written} in the imported SQL.`,
    confidence: 0.9,
    ...(parameter.default === undefined ? { required: true } : {}),
  }));
  const warnings = [
    ...(parameters.length > 0 ? [`Contains parameters: ${parameters.join(', ')}`] : []),
    ...(statement.sql.includes('"""') ? ['SQL contains triple quotes that were escaped in the DQL draft.'] : []),
    ...statement.warnings,
    ...statement.notes,
  ];
  const lineage: BlockStudioImportLineage = {
    sourceTables,
    parameters,
    warnings,
    statementIndex: statement.statementIndex,
    totalStatements: statement.totalStatements,
  };
  const candidate: BlockStudioImportCandidate = {
    id: buildCandidateId(sourcePath, statement.statementIndex, statement.sql),
    sourceKind: statement.sourceKind ?? options.sourceKind,
    sourcePath,
    name: titleizeName(name),
    domain: metadata.domain ? sanitizeDomain(metadata.domain) : options.defaults.domain,
    description: metadata.description || inferred.description || `Imported from ${sourcePath}`,
    owner: options.defaults.owner,
    tags: normalizeTags([...options.defaults.tags, ...metadata.tags, ...(metadata.name ? [] : inferred.tags)]),
    ...(parameterDecisions.length ? { parameterDecisions } : {}),
    sql: statement.sql.trim(),
    dqlSource: '',
    validation: null,
    preview: null,
    lineage,
    confidence: scoreSqlCandidate(statement.sql, lineage),
    splitStrategy: statement.splitStrategy,
    warnings,
    ...(statement.notes.length ? { importNotes: statement.notes } : {}),
    conversionNotes: [
      'Deterministic SQL extraction created this DQL draft locally.',
      'Name, description, domain, and tags come from leading SQL comments when present; otherwise ZLens uses the source path and import defaults.',
      'Multiple scripts in one file are split by semicolon, GO batch separator, repeated name/title header comments, or a new statement on its own line.',
      'Temp tables, views and tables a script builds before its query become WITH clauses; DECLARE and SET values become parameter defaults; statements that change data get no draft.',
      'Otherwise the SQL statement is wrapped into query = """ ... """ without LLM rewriting.',
      'Visualization defaults to table until a reviewer chooses a chart type.',
      'The default test is assert row_count > 0.',
      'Optional AI assist is review-gated and only receives this candidate context.',
    ],
    aiAssistance: [],
    reviewCadence: 'monthly',
    reviewStatus: 'draft',
  };
  candidate.dqlSource = candidateToDqlSource(candidate);
  return candidate;
}

function splitSqlStatements(source: string): { statements: string[]; strategy: BlockStudioImportSplitStrategy } {
  const semicolonStatements = splitSqlBySemicolonAndGo(source);
  const base: { statements: string[]; strategy: BlockStudioImportSplitStrategy } = semicolonStatements.length > 1
    ? { statements: semicolonStatements, strategy: 'semicolon-go' }
    : (() => {
      const metadataStatements = splitSqlByMetadataHeaders(source);
      return metadataStatements.length > 1
        ? { statements: metadataStatements, strategy: 'metadata-comment' as const }
        : { statements: semicolonStatements, strategy: 'semicolon-go' as const };
    })();
  // T-SQL scripts often have no semicolons, and a pasted page of reports may
  // leave only a blank line between queries: split where a new statement
  // starts on its own line.
  const statements = base.statements.flatMap(splitAtStatementStarts);
  if (base.statements.length === 1 && statements.length > 1) return { statements, strategy: 'statement-start' };
  return { statements, strategy: base.strategy };
}

function splitSqlBySemicolonAndGo(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let single = false;
  let double = false;
  let backtick = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, i)) {
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (!single && !double && !backtick) {
      if (char === '-' && next === '-') {
        lineComment = true;
        i += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        blockComment = true;
        i += 1;
        continue;
      }
      if (char === '$') {
        const tag = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
        if (tag) {
          dollarQuote = tag;
          i += tag.length - 1;
          continue;
        }
      }
    }

    if (!double && !backtick && char === "'" && source[i - 1] !== '\\') single = !single;
    else if (!single && !backtick && char === '"' && source[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '`') backtick = !backtick;

    if (!single && !double && !backtick) {
      const goMatch = matchGoBatchSeparator(source, i);
      if (goMatch) {
        const statement = source.slice(start, i).trim();
        if (statement) statements.push(statement);
        start = goMatch.end;
        i = goMatch.end - 1;
        continue;
      }
    }

    if (!single && !double && !backtick && char === ';') {
      const statement = source.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const trailing = source.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function splitSqlByMetadataHeaders(source: string): string[] {
  const chunks: string[] = [];
  const lines = source.split(/\r?\n/);
  let current: string[] = [];
  const flush = () => {
    const chunk = current.join('\n').trim();
    if (chunk) chunks.push(chunk);
    current = [];
  };

  for (const line of lines) {
    const isHeader = /^\s*(?:--|\/\*)\s*(?:name|block|title|query)\s*:/i.test(line);
    if (isHeader && current.some((item) => stripSqlComments(item).trim().length > 0)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return chunks.filter((chunk) => /\b(select|with)\b/i.test(stripSqlComments(chunk)));
}

function matchGoBatchSeparator(source: string, index: number): { end: number } | null {
  const char = source[index];
  if (char !== 'g' && char !== 'G') return null;
  const lineStart = Math.max(source.lastIndexOf('\n', index - 1) + 1, 0);
  if (source.slice(lineStart, index).trim()) return null;
  const rest = source.slice(index);
  // Only the GO line itself: `\s` here crossed blank lines and swallowed the
  // comment after them, the next query's name header.
  const match = rest.match(/^go(?:[ \t]+\d+)?[ \t]*(?:--[^\r\n]*)?(?:\r?\n|$)/i);
  if (!match) return null;
  return { end: index + match[0].length };
}

function analyzeSqlWarnings(sql: string, totalStatements: number): string[] {
  const warnings: string[] = [];
  // A second query on the same line as the first (`select … from a select …
  // from b`) is not split; say so. Subqueries and WITH lists are not counted.
  if (totalStatements === 1 && statementStartOffsets(sql, { lineStartOnly: false }).length > 0) {
    warnings.push('Only one candidate was created, but multiple SELECT/WITH clauses were detected. Add semicolons, GO batch separators, or split manually if this file contains multiple scripts.');
  }
  return warnings;
}

function extractStatementMetadata(sql: string): { name: string; title: string; description: string; domain: string; tags: string[] } {
  const leading = sql.split(/\r?\n/).slice(0, 12).join('\n');
  const name = leading.match(/(?:--|\/\*)\s*(?:name|block|title|query)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const description = leading.match(/(?:--|\/\*)\s*(?:description|desc)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const domain = leading.match(/(?:--|\/\*)\s*domain\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tagText = leading.match(/(?:--|\/\*)\s*tags?\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tags = normalizeTags(tagText ? tagText.split(',') : []);
  // The first plain comment, never a `key: value` header line.
  const firstComment = leading.match(/^[^\S\n]*--[^\S\n]*(?!(?:name|block|title|query|description|desc|domain|tags?)\s*:)(\S.*)$/im)?.[1]?.trim() ?? '';
  // A short comment right above a query without a name header names it
  // (`-- Average order value per customer type`).
  const title = !name && isCommentTitle(firstComment) && commentDirectlyAboveCode(sql, firstComment) ? firstComment : '';
  if (description) return { name, title, description, domain, tags };
  return { name, title, description: title ? '' : firstComment, domain, tags };
}

function isCommentTitle(comment: string): boolean {
  if (comment.length < 3 || comment.length > 60 || !/[A-Za-z]{3}/.test(comment)) return false;
  if (comment.split(/\s+/).length > 9) return false;
  if (/[:=<>'"();]/.test(comment)) return false;
  return !/^(?:todo|fixme|note|xxx|hack|select|and|or|where|from|join|group|order|limit|union|with)\b/i.test(comment);
}

function commentDirectlyAboveCode(sql: string, comment: string): boolean {
  const lines = sql.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(comment));
  if (index < 0) return false;
  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) return false;
    if (/^\s*--/.test(line)) continue;
    return true;
  }
  return false;
}

/** Names that repeat in one import get " 2", " 3" in the order they were found. */
function giveUniqueNames(candidates: BlockStudioImportCandidate[]): void {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    if ((counts.get(key) ?? 0) < 2) continue;
    const position = (seen.get(key) ?? 0) + 1;
    seen.set(key, position);
    if (position === 1) continue;
    candidate.name = `${candidate.name} ${position}`;
    candidate.dqlSource = candidateToDqlSource(candidate);
  }
}

function inferStatementBusinessMetadata(sql: string, sourcePath: string, sourceTables: string[]): { name: string; description: string; tags: string[] } {
  const expressions = extractSelectExpressions(sql);
  const aggregateAliases = expressions.filter(isAggregateExpression).map(extractExpressionAlias).filter(Boolean);
  const dimensionAliases = expressions.filter((expression) => !isAggregateExpression(expression)).map(extractExpressionAlias).filter(Boolean);
  const orderByAliases = extractOrderByAliases(sql);
  const metric = aggregateAliases[0] || orderByAliases.find((alias) => /total|sum|count|avg|score|point|revenue|amount|sales|games?/i.test(alias)) || aggregateAliases[0] || '';
  const dimension = dimensionAliases.find((alias) => !/^row_?number$/i.test(alias)) || '';
  const years = extractYearFilters(sql);
  const tableLabel = sourceTables[0] || sourcePath;
  const tableEntity = businessEntityFromIdentifier(tableLabel.split('.').pop() || tableLabel);
  const metricLabel = metric ? titleizeName(metric) : '';
  const pluralDimension = dimension ? pluralizeBusinessEntity(businessEntityFromIdentifier(dimension)) : pluralizeBusinessEntity(tableEntity);
  const yearLabel = years.length === 1 ? years[0] : years.length > 1 ? years.join(' ') : '';
  const yearClause = years.length === 1 ? ` for ${years[0]}` : years.length > 1 ? ` for ${years.join(' and ')}` : '';

  // "Top …" only for a ranking: sorted descending and cut to the first rows.
  const ranking = /\border\s+by\b[\s\S]*\bdesc\b/i.test(stripSqlComments(sql))
    && (hasRankingLimit(sql) || /\bselect\s+(?:distinct\s+)?top\s*\(?\s*\d+/i.test(sql) || /\bfetch\s+first\b/i.test(sql));
  const dimensionLabel = dimension ? titleizeName(dimension) : '';
  let name = '';
  if (metricLabel && dimension && ranking) {
    name = `Top ${pluralDimension} By ${metricLabel}${yearLabel ? ` ${yearLabel}` : ''}`;
  } else if (metricLabel && dimension) {
    name = `${metricLabel} By ${dimensionLabel}${yearLabel ? ` ${yearLabel}` : ''}`;
  } else if (metricLabel) {
    name = `${metricLabel}${yearLabel ? ` ${yearLabel}` : ''}`;
  } else if (dimension) {
    name = `${pluralDimension} Detail${yearLabel ? ` ${yearLabel}` : ''}`;
  }

  const selectedMeasures = aggregateAliases.map(titleizeName).filter((label) => label && label !== metricLabel);
  let description = '';
  if (metricLabel && dimension && ranking) {
    description = `Ranks ${pluralDimension.toLowerCase()} by ${metricLabel.toLowerCase()}${yearClause} using ${sourceTables.join(', ') || sourcePath}.`;
  } else if (metricLabel && dimension) {
    description = `Calculates ${metricLabel.toLowerCase()} by ${dimensionLabel.toLowerCase()}${yearClause} using ${sourceTables.join(', ') || sourcePath}.`;
  } else if (metricLabel) {
    description = `Calculates ${metricLabel.toLowerCase()}${yearClause} using ${sourceTables.join(', ') || sourcePath}.`;
  } else if (dimension) {
    description = `Lists ${pluralDimension.toLowerCase()}${yearClause} from ${sourceTables.join(', ') || sourcePath}.`;
  }
  if (description && selectedMeasures.length > 0) {
    description = `${description.replace(/\.$/, '')}, including ${selectedMeasures.map((item) => item.toLowerCase()).join(', ')}.`;
  }

  const tags = [
    ...sourceTables.flatMap((table) => table.split('.').slice(-2).map(businessToken)),
    metric,
    dimension,
    ...years,
  ].flatMap((item) => item.split(/[_\s.-]+/)).map(businessToken).filter(Boolean);

  return {
    name: name || '',
    description,
    tags,
  };
}

function extractSelectExpressions(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((expression) => expression.trim())
    .filter((expression) => expression && expression !== '*');
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!double && char === "'" && value[i - 1] !== '\\') single = !single;
    else if (!single && char === '"' && value[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '(') depth += 1;
    else if (!single && !double && char === ')' && depth > 0) depth -= 1;
    else if (!single && !double && depth === 0 && char === ',') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function isAggregateExpression(expression: string): boolean {
  return /\b(sum|count|avg|min|max|median|percentile_cont|percentile_disc)\s*\(/i.test(expression);
}

function extractExpressionAlias(expression: string): string {
  const asMatch = expression.match(/\bas\s+[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/i);
  if (asMatch) return asMatch[1];
  const trailing = expression.match(/\s+[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/);
  if (trailing && !/[).]$/.test(trailing[1])) return trailing[1];
  const simple = expression.match(/(?:^|\.)[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/);
  return simple?.[1] ?? '';
}

function extractOrderByAliases(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(/\border\s+by\b([\s\S]+?)(?:\blimit\b|\bfetch\b|\boffset\b|$)/i);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((item) => item.replace(/\b(asc|desc|nulls\s+first|nulls\s+last)\b/gi, '').trim())
    .map(extractExpressionAlias)
    .filter(Boolean);
}

function extractYearFilters(sql: string): string[] {
  const years = new Set<string>();
  const cleaned = stripSqlComments(sql);
  let match: RegExpExecArray | null;
  const extractYear = /extract\s*\(\s*year\s+from\s+[^)]+\)\s*(?:=\s*([12][0-9]{3})|in\s*\(([^)]*)\))/gi;
  while ((match = extractYear.exec(cleaned))) {
    const raw = match[1] || match[2] || '';
    for (const year of raw.match(/[12][0-9]{3}/g) ?? []) years.add(year);
  }
  const namedYear = /\b(?:year|season)\b\s*(?:=|in\s*\()\s*([^)\s]+(?:\s*,\s*[^)\s]+)*)/gi;
  while ((match = namedYear.exec(cleaned))) {
    for (const year of match[1].match(/[12][0-9]{3}/g) ?? []) years.add(year);
  }
  return Array.from(years).sort();
}

function businessEntityFromIdentifier(identifier: string): string {
  const clean = identifier
    .replace(/^(dim|fact|fct|stg|src|int)_/i, '')
    .replace(/_(id|key|name|code)$/i, '')
    .replace(/s$/i, '');
  return titleizeName(clean) || 'Records';
}

function pluralizeBusinessEntity(entity: string): string {
  if (/s$/i.test(entity)) return entity;
  if (/y$/i.test(entity)) return `${entity.slice(0, -1)}ies`;
  return `${entity}s`;
}

function businessToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(dim|fact|fct|stg|src|int)_/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSourceTables(sql: string): string[] {
  const tables = new Set<string>();
  const cleaned = stripSqlComments(sql).replace(/extract\s*\(\s*\w+\s+from\s+[^)]+\)/gi, 'EXTRACT_VALUE');
  const cteNames = extractCteNames(cleaned);
  const part = '(?:\\[[^\\]]+\\]|"[^"]+"|`[^`]+`|[A-Za-z0-9_/:#$-]+)';
  const regex = new RegExp(`\\b(?:from|join|update|into)\\s+(${part}(?:\\.${part})*)`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    // [dev].[orders] and "dev"."orders" are dev.orders.
    const raw = match[1].replace(/[`"\[\]]/g, '');
    if (!raw || raw.startsWith('(')) continue;
    if (/^(select|values|unnest|lateral)$/i.test(raw)) continue;
    if (cteNames.has(raw.toLowerCase())) continue;
    tables.add(raw);
  }
  return Array.from(tables);
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const withIndex = sql.search(/\bwith\b/i);
  if (withIndex < 0) return names;
  const prefix = sql.slice(withIndex);
  const regex = /(?:\bwith\b|,)\s+([A-Za-z_][A-Za-z0-9_$]*)\s+as\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prefix))) names.add(match[1].toLowerCase());
  return names;
}

function hasExecutableSql(sql: string): boolean {
  return stripSqlComments(sql).trim().length > 0;
}

function extractSqlParameters(sql: string): string[] {
  const params = new Set<string>();
  const cleaned = stripSqlStrings(stripSqlComments(sql));
  let match: RegExpExecArray | null;
  const handlebars = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
  while ((match = handlebars.exec(cleaned))) params.add(match[1]);
  const dqlTemplate = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
  while ((match = dqlTemplate.exec(cleaned))) params.add(match[1]);
  const colon = /(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = colon.exec(cleaned))) params.add(match[2]);
  const dollar = /(^|[^$])\$([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = dollar.exec(cleaned))) params.add(match[2]);
  return Array.from(params);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

function stripSqlStrings(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""');
}

function scoreSqlCandidate(sql: string, lineage: BlockStudioImportLineage): number {
  let score = /\bselect\b/i.test(sql) ? 0.76 : 0.62;
  if (lineage.sourceTables.length > 0) score += 0.1;
  if (/\bgroup\s+by\b/i.test(sql)) score += 0.04;
  if (lineage.parameters.length > 0) score -= 0.12;
  if (lineage.totalStatements > 1) score -= 0.03;
  return Math.max(0.35, Math.min(0.92, Number(score.toFixed(2))));
}

function walkImportFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // .pbi holds a Power BI project's local cache, not its definition.
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dql' || entry.name === '.pbi') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (extname(entry.name).toLowerCase() === '.sql' || isBiImportFile(entry.name))) files.push(full);
    }
  }
  return files.sort();
}

function collectSqlSources(projectRoot: string, options: CreateBlockStudioImportOptions): {
  sourceKind: BlockStudioImportSourceKind;
  inputPath: string;
  sources: SqlSource[];
  skipped: SkippedSqlStatement[];
  calculations: ImportCalculations;
} {
  const sources: SqlSource[] = [];
  const skipped: SkippedSqlStatement[] = [];
  const calculations: ImportCalculations = { calculations: [], models: [], worksheets: [] };
  const add = (extracted: ExtractedBiFile) => {
    sources.push(...extracted.sources);
    skipped.push(...extracted.skipped);
    calculations.calculations.push(...(extracted.inventory?.calculations ?? []));
    calculations.models.push(...(extracted.models ?? []));
    calculations.worksheets!.push(...(extracted.worksheets ?? []));
  };
  const readSafely = (displayName: string, read: () => ExtractedBiFile) => {
    try {
      add(read());
    } catch (error) {
      add(unreadableBiFile(displayName, error));
    }
  };

  if (options.sources?.length) {
    const tmdl: Array<{ absolutePath: string; displayPath: string; text: string }> = [];
    options.sources.forEach((source, index) => {
      const path = sanitizeSourcePath(source.path || `pasted-${index + 1}.sql`);
      const bytes = Buffer.from(source.content ?? '', source.encoding === 'base64' ? 'base64' : 'utf8');
      if (/\.tmdl$/i.test(path)) {
        tmdl.push({ absolutePath: '', displayPath: path, text: bytes.toString('utf8') });
      } else if (isBiImportFile(path)) {
        readSafely(path, () => readBiFile(bytes, path));
      } else if ((source.content ?? '').trim()) {
        sources.push({ path, content: source.content });
      }
    });
    // Uploaded .tmdl files are one Power BI model's tables and expressions.
    if (tmdl.length) readSafely('uploaded TMDL files', () => readBiFile(Buffer.from(tmdl.map((file) => file.text).join('\n\n')), 'uploaded.tmdl'));
    if (sources.length === 0 && skipped.length === 0) throw new Error('No SQL content was provided.');
    const kinds = new Set(sources.map((source) => source.sourceKind ?? 'raw-sql'));
    const uploadedKind = options.sources.length === 1 ? biSourceKind(options.sources[0].path ?? '') : null;
    return {
      sourceKind: uploadedKind ?? (kinds.size === 1 && !kinds.has('raw-sql') ? [...kinds][0] as BlockStudioImportSourceKind : sources.length > 1 ? 'raw-sql-folder' : 'raw-sql-file'),
      inputPath: options.inputMode === 'paste' ? 'pasted SQL' : `${options.sources.length} uploaded file(s)`,
      sources,
      skipped,
      calculations,
    };
  }

  let inputPath = resolveInputPath(projectRoot, options.inputPath ?? '');
  // A Power BI project file points at its model folder beside it.
  if (/\.pbip$/i.test(inputPath) && existsSync(inputPath.replace(/\.pbip$/i, '.SemanticModel'))) inputPath = inputPath.replace(/\.pbip$/i, '.SemanticModel');
  const sourceKind = resolveSourceKind(inputPath, options.sourceKind);
  const stats = statSync(inputPath);
  const files = (stats.isDirectory() ? walkImportFiles(inputPath) : [inputPath]).filter((file) => !options.fileAllowed || options.fileAllowed(file));
  const tmdlFolders = new Map<string, string[]>();
  for (const file of files) {
    const shown = displayPath(projectRoot, file);
    if (extname(file).toLowerCase() === '.sql') {
      sources.push({ path: shown, content: readFileSync(file, 'utf-8') });
    } else if (/\.tmdl$/i.test(file)) {
      const folder = tmdlDefinitionFolder(file);
      tmdlFolders.set(folder, [...(tmdlFolders.get(folder) ?? []), file]);
    } else {
      readSafely(shown, () => readBiFile(readFileSync(file), shown));
    }
  }
  for (const [folder, folderFiles] of tmdlFolders) {
    // Tables and shared expressions (parameters) make up the model's queries.
    const expressions = join(folder, 'expressions.tmdl');
    const modelFiles = Array.from(new Set([...folderFiles, ...(existsSync(expressions) && (!options.fileAllowed || options.fileAllowed(expressions)) ? [expressions] : [])]))
      .filter((file) => file.includes(`${sep}tables${sep}`) || /^(?:expressions|model)\.tmdl$/i.test(basename(file)) || folderFiles.length === 1);
    if (modelFiles.length === 0) continue;
    readSafely(displayPath(projectRoot, folder), () => readTmdlFolder(modelFiles.map((file) => ({ absolutePath: file, displayPath: displayPath(projectRoot, file) })), displayPath(projectRoot, folder)));
  }
  if (sources.length === 0 && skipped.length === 0) throw new Error('No SQL, Tableau or Power BI files found to import.');
  return {
    sourceKind,
    inputPath: displayPath(projectRoot, inputPath),
    sources,
    skipped,
    calculations,
  };
}

/** A PBIP model's `definition` folder holding this .tmdl file (its tables/ folder's parent), else the file's own folder. */
export function tmdlDefinitionFolder(file: string): string {
  let folder = dirname(file);
  for (let depth = 0; depth < 4; depth += 1) {
    if (basename(folder).toLowerCase() === 'definition') return folder;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return basename(dirname(file)).toLowerCase() === 'tables' ? dirname(dirname(file)) : dirname(file);
}

function sanitizeSourcePath(path: string): string {
  const clean = path.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  return clean.endsWith('.sql') || isBiImportFile(clean) ? clean : `${clean || 'pasted'}.sql`;
}

function resolveInputPath(projectRoot: string, inputPath: string): string {
  if (!inputPath.trim()) throw new Error('Import path is required.');
  const resolved = resolve(projectRoot, inputPath);
  if (!existsSync(resolved)) throw new Error(`Import path not found: ${inputPath}`);
  return resolved;
}

function resolveSourceKind(inputPath: string, requested?: CreateBlockStudioImportOptions['sourceKind']): BlockStudioImportSourceKind {
  if (requested && requested !== 'raw-sql') return requested;
  const stats = statSync(inputPath);
  if (stats.isDirectory()) return /\.SemanticModel$|[\\/]definition$/i.test(inputPath) ? 'powerbi-project' : 'raw-sql-folder';
  if (extname(inputPath).toLowerCase() === '.sql') return 'raw-sql-file';
  const kind = biSourceKind(inputPath);
  if (kind) return kind;
  throw new Error('Import reads .sql files, Tableau workbooks (.twb, .twbx) and Power BI files (.pbit, .pbip, model.bim, .tmdl), or a folder of them.');
}

function importRoot(projectRoot: string, importId: string): string {
  if (!/^imp_[A-Za-z0-9_-]+$/.test(importId)) {
    throw new Error(`Invalid import session id: ${importId}`);
  }
  return join(projectRoot, '.dql', 'imports', importId);
}

function buildImportId(sourceKind: string, inputPath: string, createdAt: string): string {
  const hash = createHash('sha1').update(`${sourceKind}:${inputPath}:${createdAt}:${randomUUID()}`).digest('hex').slice(0, 10);
  return `imp_${hash}`;
}

function buildCandidateId(sourcePath: string, statementIndex: number, sql: string): string {
  const hash = createHash('sha1').update(`${sourcePath}:${statementIndex}:${sql}`).digest('hex').slice(0, 12);
  return `cand_${hash}`;
}

function displayPath(projectRoot: string, absPath: string): string {
  const rel = relative(projectRoot, absPath).replaceAll('\\', '/');
  return rel && !rel.startsWith('..') ? rel : absPath.replaceAll('\\', '/');
}

function sanitizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '') || 'imported';
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function normalizePattern(value: string | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const allowed = new Set([
    'metric_wrapper',
    'entity_profile',
    'entity_rollup',
    'ranking',
    'trend',
    'bridge',
    'drilldown',
    'replacement',
    'custom',
  ]);
  return allowed.has(normalized) ? normalized : '';
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function titleizeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Imported Query';
}

function dqlString(value: string): string {
  return JSON.stringify(value ?? '');
}
