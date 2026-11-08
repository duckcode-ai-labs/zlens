import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import {
  buildManifest,
  discoverDbtDomains,
  loadDomainPackageRegistry,
  loadProjectConfig,
  modelingModeOf,
  renderDomainDeclaration,
  resolveDbtManifestPath,
  type DomainDiscoveryReport,
  type DomainProposal,
} from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { draftProjectMetricsFromHistory, findModeledRelationship, meaningDraftProvider, rejectDiscoveredRelationship, startLocalServer, termDirectoryFor, validateProjectRelationships } from '../local-runtime.js';
import { draftMeanings, meaningsStatus, planMeaningDrafts, plannedWithoutColumnList } from '../meaning-draft.js';
import { meaningCatalog } from '../meaning-routes.js';
import { draftTerms } from '../term-draft.js';
import { readValueProfile, valueProfileAllowed } from '../value-profile.js';

/** `zlens model` — inspect/validate v3 and preview evidence-bounded discovery (AGT-002/API-001). */
export async function runModel(file: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const subcommand = file ?? 'list';
  if (subcommand === 'discover' || subcommand === 'apply-discovery') {
    if (usesWarehouseDiscovery(rest)) {
      await runWarehouseDiscovery(subcommand, rest, flags);
      return;
    }
    // A dbt project checked on the warehouse drafts the whole model from
    // both (RFC 0012, decision M5); without --validate, dbt alone proposes Domains.
    if (rest.includes('--validate')) {
      await runWarehouseDiscovery(subcommand, rest, flags, { fromDbt: true });
      return;
    }
    runDomainDiscovery(subcommand, rest, flags);
    return;
  }
  if (subcommand === 'draft') {
    await runModelDraft(rest, flags);
    return;
  }
  if (subcommand === 'import') {
    await runModelImport(rest, flags);
    return;
  }
  if (subcommand === 'validate-relationship') {
    await runValidateRelationship(rest, flags);
    return;
  }
  if (subcommand === 'reject-discovery') {
    runRejectDiscovery(rest, flags);
    return;
  }
  if (subcommand === 'draft-meanings') {
    await runDraftMeanings(rest, flags);
    return;
  }
  if (subcommand === 'meanings') {
    runMeaningsStatus(rest, flags);
    return;
  }
  if (subcommand === 'draft-terms') {
    await runDraftTerms(rest, flags);
    return;
  }
  if (subcommand === 'draft-metrics') {
    await runDraftMetrics(rest, flags);
    return;
  }
  const args = rest.filter((value) => !value.startsWith('-'));
  const relationshipId = subcommand === 'explain' ? args[0] : undefined;
  const projectArg = subcommand === 'explain' ? args[1] : args[0];
  const projectRoot = resolve(projectArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    console.error(`No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    process.exitCode = 1;
    return;
  }
  const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) {
    console.error('dbt-first modeling is not enabled. Set manifestVersion: 3 in dql.config.json; the mode follows from the dbt project.');
    process.exitCode = 1;
    return;
  }

  if (subcommand === 'validate') {
    const diagnostics = (manifest.diagnostics ?? []).filter((diagnostic) => diagnostic.kind === 'modeling' || diagnostic.kind === 'config');
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const result = {
      valid: errors.length === 0,
      entities: Object.keys(manifest.modeling.entities).length,
      relationships: Object.keys(manifest.modeling.relationships).length,
      diagnostics,
    };
    if (flags.format === 'json') console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ZLens dbt-first modeling: ${result.valid ? 'valid' : 'invalid'}`);
      console.log(`  ${result.entities} entities, ${result.relationships} relationships`);
      for (const diagnostic of diagnostics) console.log(`  ${diagnostic.severity === 'error' ? '✗' : '!' } ${diagnostic.message}`);
    }
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (subcommand === 'explain') {
    if (!relationshipId) {
      console.error('Usage: zlens model explain <relationship-id> [path]');
      process.exitCode = 1;
      return;
    }
    // The id `zlens model list` prints, or the local id when only one domain uses it.
    let relationship: ReturnType<typeof findModeledRelationship>;
    try {
      relationship = findModeledRelationship(manifest, relationshipId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    if (!relationship) {
      console.error(`No relationship named "${relationshipId}". \`zlens model list\` shows their ids.`);
      process.exitCode = 1;
      return;
    }
    const output = {
      relationship,
      from: manifest.modeling.entities[relationship.from],
      to: manifest.modeling.entities[relationship.to],
      automaticJoinRule: relationship.automaticJoinAllowed
        ? 'certified + fresh + exported + fanout-safe'
        : 'blocked until the relationship meets certified, fresh, exported, fanout-safe policy',
    };
    console.log(flags.format === 'json' ? JSON.stringify(output, null, 2) : [
      `${relationship.id}: ${relationship.from} → ${relationship.to}`,
      `  ${relationship.cardinality}; fanout=${relationship.fanout}; status=${relationship.status}`,
      `  ${relationship.automaticJoinAllowed ? 'automatic join allowed' : relationship.staleCertification ? 'blocked: stale certification' : 'not automatic join proof'}`,
      `  source: ${relationship.sourcePath}`,
    ].join('\n'));
    return;
  }

  if (subcommand !== 'list') {
    console.error('Usage: zlens model list|validate|discover [path] | zlens model draft [path] [--apply [--passed-only]] | zlens model explain <relationship-id> [path] | zlens model validate-relationship <relationship-id>|--all [path] [--certify] [--dry-run] | zlens model reject-discovery <relationship-id> [path] [--reason <text>] | zlens model apply-discovery [path] --domain <id> --apply | zlens model import <file-or-directory> --domain <id> --area <id> --dry-run|--apply');
    process.exitCode = 1;
    return;
  }
  const output = {
    entities: Object.values(manifest.modeling.entities),
    relationships: Object.values(manifest.modeling.relationships),
    packages: Object.values(manifest.modeling.packages),
  };
  if (flags.format === 'json') console.log(JSON.stringify(output, null, 2));
  else {
    console.log('Entities');
    for (const entity of output.entities) console.log(`  ${entity.id} → ${entity.dbtUniqueId} (${entity.domain}) · ${entity.status ?? 'draft'}`);
    console.log('Relationships');
    for (const relationship of output.relationships) console.log(`  ${relationship.id}: ${relationship.from} → ${relationship.to} [${relationship.automaticJoinAllowed ? 'safe' : relationship.fanout}] · ${relationship.status}${relationship.validation ? ` · warehouse ${relationship.validation.status}` : ''}`);
  }
}

/** The project's warehouse catalog, or an error said once. */
function meaningsCatalog(rest: string[], flags: CLIFlags): { projectRoot: string; snapshot: NonNullable<ReturnType<typeof meaningCatalog>> } | undefined {
  const projectRoot = resolve(positionalArgs(rest, ['--max-tables'])[0] ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    modelImportError(flags, 'PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    return undefined;
  }
  const snapshot = meaningCatalog(projectRoot);
  if (!snapshot) {
    modelImportError(flags, 'NO_WAREHOUSE_CATALOG', 'No tables to describe yet. Run `zlens sync warehouse` or `zlens sync dbt` first.');
    return undefined;
  }
  return { projectRoot, snapshot };
}

/**
 * `zlens model draft-meanings [path]`: an AI first draft of what the tables and
 * columns mean. `--dry-run` says what would be sent and roughly what it costs,
 * with no model call. `--max-tables <n>` lowers the limit on one run.
 */
async function runDraftMeanings(rest: string[], flags: CLIFlags): Promise<void> {
  const catalog = meaningsCatalog(rest, flags);
  if (!catalog) return;
  const { projectRoot, snapshot } = catalog;
  const limitIndex = rest.indexOf('--max-tables');
  const maxTables = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : undefined;
  if (maxTables !== undefined && !(Number.isInteger(maxTables) && maxTables > 0)) {
    modelImportError(flags, 'INVALID_REQUEST', '--max-tables takes a whole number above zero.');
    return;
  }
  const config = loadProjectConfig(projectRoot);
  const valueProfile = valueProfileAllowed(config as Parameters<typeof valueProfileAllowed>[0], false) ? readValueProfile(projectRoot, snapshot.fingerprint) : undefined;
  const plan = planMeaningDrafts(projectRoot, snapshot, { ...(maxTables ? { maxTables } : {}), ...(valueProfile ? { valueProfile } : {}) });
  const columnsUnlisted = plannedWithoutColumnList(plan, snapshot.columnsUnlisted);
  const planSummary = { tables: plan.tables, columns: plan.columns, batches: plan.batches.length, alreadyDone: plan.alreadyDone, overLimit: plan.overLimit, estimatedInputTokens: plan.estimatedInputTokens, estimatedOutputTokens: plan.estimatedOutputTokens, sendsSampleValues: Boolean(valueProfile), columnsUnlisted };
  const human = flags.format !== 'json';
  if (human) {
    console.log(`To draft: ${plan.tables} tables, ${plan.columns} columns, in ${plan.batches.length} model calls.`);
    if (plan.alreadyDone) console.log(`Already done: ${plan.alreadyDone} tables.`);
    if (plan.overLimit) console.log(`Past the limit, left for the next run: ${plan.overLimit} tables.`);
    // A manifest holds only documented columns: a draft written from those is written nearly blind.
    if (columnsUnlisted) console.log(`! ${columnsUnlisted} dbt ${columnsUnlisted === 1 ? 'table lists only the columns its' : 'tables list only the columns their'} YAML documents. Run \`zlens sync warehouse\` (or \`dbt docs generate\`) first, so the draft sees every column.`);
    console.log(`Sends table names, column names, types and keys${valueProfile ? ', and sample values from the value profile' : ''}. ${valueProfile ? '' : 'No rows. '}About ${plan.estimatedInputTokens.toLocaleString('en-US')} tokens in and ${plan.estimatedOutputTokens.toLocaleString('en-US')} out.`);
  }
  if (flags.dryRun === true || plan.tables === 0) {
    if (!human) console.log(JSON.stringify({ plan: planSummary }, null, 2));
    return;
  }
  const selected = await meaningDraftProvider(projectRoot);
  if (!selected) {
    modelImportError(flags, 'NO_AI_PROVIDER', 'No AI provider is connected. Add one in Settings → AI, then run this again.');
    return;
  }
  const report = await draftMeanings({
    projectRoot,
    snapshot,
    provider: selected.provider,
    ...(selected.model ? { model: selected.model } : {}),
    ...(maxTables ? { maxTables } : {}),
    ...(valueProfile ? { valueProfile } : {}),
    date: new Date().toISOString().slice(0, 10),
    ...(human ? { onBatch: ({ done, total }: { done: number; total: number }) => console.log(`  ${done} of ${total} calls done`) } : {}),
  });
  if (!human) {
    console.log(JSON.stringify({ plan: planSummary, report }, null, 2));
  } else {
    console.log(`Drafted ${report.tablesDrafted} tables and ${report.columnsDrafted} column descriptions into meanings/. Nothing is reviewed yet.`);
    if (report.nothingToAdd) console.log(`  ${report.nothingToAdd} described ${report.nothingToAdd === 1 ? 'table' : 'tables'} had nothing to add.`);
    for (const item of report.dropped) console.log(`  dropped ${item.relation}${item.column ? `.${item.column}` : ''}: ${item.reason}`);
    for (const item of report.failed) console.log(`  not drafted (${item.tables.length} tables): ${item.reason}`);
    if (report.stopped) console.log(`Stopped early: ${report.stopped}`);
    if (report.failed.length) console.log('Run this again to draft what is left.');
  }
  if (report.tablesDrafted === 0 && report.failed.length > 0) process.exitCode = 1;
}

/**
 * `zlens model draft-terms [path] [--domain <id>]`: AI drafts of the words people
 * use, as draft terms that answer nothing until someone certifies them.
 */
async function runDraftTerms(rest: string[], flags: CLIFlags): Promise<void> {
  const catalog = meaningsCatalog(rest, flags);
  if (!catalog) return;
  const selected = await meaningDraftProvider(catalog.projectRoot);
  if (!selected) {
    modelImportError(flags, 'NO_AI_PROVIDER', 'No AI provider is connected. Add one in Settings → AI, then run this again.');
    return;
  }
  const domain = flags.domain || undefined;
  const manifest = buildManifest({ projectRoot: catalog.projectRoot, dbtManifestPath: resolveDbtManifestPath(catalog.projectRoot) ?? undefined });
  const report = await draftTerms({
    projectRoot: catalog.projectRoot,
    snapshot: catalog.snapshot,
    terms: Object.values(manifest.terms ?? {}),
    provider: selected.provider,
    ...(domain ? { domain } : {}),
    directory: termDirectoryFor(catalog.projectRoot, domain),
  });
  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Drafted ${report.drafted.length} terms. They answer nothing until someone certifies them.`);
    for (const term of report.drafted) console.log(`  ${term.name}: ${term.path}`);
    for (const item of report.dropped) console.log(`  dropped ${item.term}: ${item.reason}`);
    if (report.failed) console.log(`Failed: ${report.failed}`);
  }
  if (report.failed) process.exitCode = 1;
}

/**
 * `zlens model draft-metrics [path] [--domain <id>]`: metric
 * drafts from the aggregates recent queries repeat. Reads query text in memory
 * and keeps only expressions and counts.
 */
async function runDraftMetrics(rest: string[], flags: CLIFlags): Promise<void> {
  const catalog = meaningsCatalog(rest, flags);
  if (!catalog) return;
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = new WorkbenchRoutedQueryExecutor(catalog.projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the reads through ${via}`); } });
  const outcome = await draftProjectMetricsFromHistory(catalog.projectRoot, { executor, ...(flags.domain ? { domain: flags.domain } : {}) });
  if (flags.format === 'json') {
    console.log(JSON.stringify(outcome, null, 2));
  } else if (outcome.error) {
    console.error(outcome.error);
  } else {
    console.log(`Read ${outcome.statements} statements; ${outcome.repeated} aggregates repeat.`);
    for (const item of outcome.items) {
      console.log(item.failed ? `  not drafted ${item.name}: ${item.failed}` : `  ${item.name}: ${item.inWords}${item.value !== undefined ? ` Ran: ${item.value}.` : ''}`);
    }
    console.log('These are drafts and answer nothing. Review them with `zlens semantic drafts`, prove them with `zlens migrate compare`, then `zlens semantic approve`.');
  }
  if (outcome.error) process.exitCode = 1;
}

/** `zlens model meanings [path]`: how far the descriptions have got. */
function runMeaningsStatus(rest: string[], flags: CLIFlags): void {
  const catalog = meaningsCatalog(rest, flags);
  if (!catalog) return;
  const status = meaningsStatus(catalog.projectRoot, catalog.snapshot);
  if (flags.format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`${status.tables} tables: ${status.drafted} with unreviewed AI drafts, ${status.reviewed} reviewed, ${status.stale} stale, ${status.undescribed} with no description.`);
}

/** Positional arguments, skipping the value after a flag that takes one. */
function positionalArgs(rest: string[], valued: string[] = ['--reason', '--source', '--dbt-manifest']): string[] {
  return rest.filter((value, index) => !value.startsWith('-') && !valued.includes(rest[index - 1] ?? ''));
}

/**
 * `zlens model validate-relationship <id> [path]` (or `--all`): the check the
 * Modeling page's Validate action runs, for relationships written by hand —
 * any keys, composite or role joins — with the evidence recorded in their
 * YAML. `--certify` certifies each one whose check passed; `--dry-run` only
 * reports.
 */
async function runValidateRelationship(rest: string[], flags: CLIFlags): Promise<void> {
  const all = rest.includes('--all');
  const args = positionalArgs(rest);
  const id = all ? undefined : args[0];
  const projectRoot = resolve((all ? args[0] : args[1]) ?? '.');
  if (!all && !id) {
    modelImportError(flags, 'INVALID_REQUEST', 'Usage: zlens model validate-relationship <relationship-id> [path] | --all [path] [--certify] [--dry-run] [--connection <name>]');
    return;
  }
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    modelImportError(flags, 'PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    return;
  }
  // A running workbench holds a DuckDB file open; the check then runs through it.
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the relationship check through ${via}, which has the DuckDB file open.`); } });
  try {
    const outcome = await validateProjectRelationships(projectRoot, {
      ...(all ? { all: true } : { ids: [id!] }),
      write: flags.dryRun !== true,
      certify: rest.includes('--certify'),
      ...(flags.connection ? { connection: flags.connection } : {}),
      executor,
    });
    if (flags.format === 'json') console.log(JSON.stringify(outcome, null, 2));
    else {
      console.log(`ZLens relationship validation (connection ${outcome.connectionId}${flags.dryRun ? ', dry run: nothing written' : ''})`);
      for (const result of outcome.results) {
        if (result.error) {
          console.log(`  ✗ ${result.id}: not checked: ${result.error}`);
          continue;
        }
        const evidence = result.evidence!;
        const mark = evidence.status === 'passed' ? '✓' : '✗';
        const counts = `${evidence.joinedRows.toLocaleString('en-US')} joined of ${evidence.fromRows.toLocaleString('en-US')} from rows · max ${evidence.maxToPerKey} to rows per key`;
        console.log(`  ${mark} ${result.id}: ${evidence.status} · ${counts}${result.certified ? ' · certified' : ''}`);
        console.log(`      ${evidence.message ?? ''}`);
      }
      if (outcome.paths.length) console.log(`  evidence written to ${outcome.paths.join(', ')}`);
    }
    if (outcome.results.some((result) => result.error || result.evidence?.status !== 'passed')) process.exitCode = 1;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : 'RELATIONSHIP_VALIDATION_FAILED';
    modelImportError(flags, code, error instanceof Error ? error.message : String(error));
  } finally {
    await executor.disconnect().catch(() => undefined);
  }
}

/** `zlens model reject-discovery <id> [path] [--reason <text>]`: discovery stops proposing a join. */
function runRejectDiscovery(rest: string[], flags: CLIFlags): void {
  const args = positionalArgs(rest);
  const id = args[0];
  const projectRoot = resolve(args[1] ?? '.');
  const reasonIndex = rest.indexOf('--reason');
  const reason = reasonIndex >= 0 ? rest[reasonIndex + 1] : undefined;
  if (!id) {
    modelImportError(flags, 'INVALID_REQUEST', 'Usage: zlens model reject-discovery <relationship-id> [path] [--reason <text>]');
    return;
  }
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    modelImportError(flags, 'PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    return;
  }
  try {
    const decision = rejectDiscoveredRelationship(projectRoot, id, reason ? { reason } : {});
    if (flags.format === 'json') console.log(JSON.stringify(decision, null, 2));
    else {
      console.log(`Discovery will not propose ${decision.from} → ${decision.to} on ${decision.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ')} again.`);
      console.log('  Recorded in .dql/modeling-discovery.json (commit it so teammates share the decision). The model itself is unchanged.');
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : 'REJECT_FAILED';
    modelImportError(flags, code, error instanceof Error ? error.message : String(error));
  }
}

async function runModelImport(rest: string[], flags: CLIFlags): Promise<void> {
  const sourcePath = rest.find((value) => !value.startsWith('-'));
  const projectRoot = resolve('.');
  if (!sourcePath || !flags.domain || !flags.area || Boolean(flags.dryRun) === Boolean(flags.apply)) {
    modelImportError(flags, 'INVALID_REQUEST', 'Usage: zlens model import <file-or-directory> --domain <id> --area <id> --dry-run|--apply --format json');
    return;
  }
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    modelImportError(flags, 'PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot}.`);
    return;
  }
  let server: Server | undefined;
  try {
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as never, preferredPort: 0, captureServer: (created) => { server = created; } });
    const base = `http://127.0.0.1:${port}`;
    const modeling = await modelImportRequest<{ snapshotId: string }>(`${base}/api/modeling/dbt-first`);
    const discovered = await modelImportRequest<{ session: { id: string; candidates: Array<{ id: string; action: string }> } }>(`${base}/api/modeling/dbt-first/imports`, { method: 'POST', body: JSON.stringify({ source: { mode: 'path', path: resolve(sourcePath) } }) });
    const selectedCandidateIds = discovered.session.candidates.filter((candidate) => candidate.action === 'import').map((candidate) => candidate.id);
    const preview = await modelImportRequest<{ proposal: { id: string; proposalHash: string; diagnostics: Array<{ severity: string }>; [key: string]: unknown } }>(`${base}/api/modeling/dbt-first/imports/${encodeURIComponent(discovered.session.id)}/preview`, { method: 'POST', body: JSON.stringify({ selectedCandidateIds, domain: flags.domain, areaId: flags.area, expectedSnapshotId: modeling.snapshotId }) });
    if (flags.dryRun) {
      console.log(flags.format === 'json' ? JSON.stringify(preview.proposal, null, 2) : formatModelImportProposal(preview.proposal, false));
      return;
    }
    if (preview.proposal.diagnostics.some((diagnostic) => diagnostic.severity === 'blocking')) {
      modelImportError(flags, 'PROPOSAL_BLOCKED', 'The import proposal has blocking diagnostics and was not applied.', preview.proposal);
      return;
    }
    const committed = await modelImportRequest<{ proposal: unknown; snapshotId: string }>(`${base}/api/context-proposals/${encodeURIComponent(preview.proposal.id)}/commit`, { method: 'POST', body: JSON.stringify({ expectedProposalHash: preview.proposal.proposalHash, idempotencyKey: `cli-${Date.now().toString(36)}` }) });
    console.log(flags.format === 'json' ? JSON.stringify(committed, null, 2) : `${formatModelImportProposal(preview.proposal, true)}\nSnapshot: ${committed.snapshotId}`);
  } catch (error) {
    const record = error && typeof error === 'object' ? error as { code?: string; message?: string; details?: unknown } : {};
    modelImportError(flags, record.code ?? 'MODELING_IMPORT_FAILED', record.message ?? String(error), record.details);
  } finally {
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
  }
}

async function modelImportRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(payload.message ?? payload.error ?? response.statusText)), { code: payload.code, details: payload.details });
  return payload as T;
}

function formatModelImportProposal(proposal: { id: string; proposalHash: string; [key: string]: unknown }, applied: boolean): string {
  const impact = proposal.impact as { files?: number; modelingChanges?: number } | undefined;
  return [`DQL modeling YAML import ${applied ? 'applied as draft' : 'dry run'}`, `  proposal ${proposal.id} · ${proposal.proposalHash.slice(0, 12)}`, `  ${impact?.modelingChanges ?? 0} modeling changes across ${impact?.files ?? 0} files`, applied ? '  source compiled and project indexes rebuilt' : '  no source files changed'].join('\n');
}

function modelImportError(flags: CLIFlags, code: string, message: string, details?: unknown): void {
  if (flags.format === 'json') console.log(JSON.stringify({ code, message, ...(details === undefined ? {} : { details }) }, null, 2));
  else console.error(`${code}: ${message}`);
  process.exitCode = 1;
}

/**
 * Warehouse-first projects discover from the warehouse catalog; hybrid ones
 * do when asked (`--source warehouse`) or when they have no dbt manifest.
 * dbt-first projects keep dbt discovery exactly as before.
 */
function usesWarehouseDiscovery(rest: string[]): boolean {
  const sourceIndex = rest.indexOf('--source');
  const source = sourceIndex >= 0 ? rest[sourceIndex + 1] : undefined;
  const pathArg = rest.find((value, index) => !value.startsWith('-') && rest[index - 1] !== '--source' && rest[index - 1] !== '--dbt-manifest');
  const projectRoot = resolve(pathArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) return false;
  let mode: ReturnType<typeof modelingModeOf>;
  try {
    mode = modelingModeOf(loadProjectConfig(projectRoot));
  } catch {
    return false;
  }
  if (source === 'dbt') return false;
  if (mode === 'warehouse-first') return true;
  if (mode !== 'hybrid') return false;
  if (source === 'warehouse') return true;
  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
  return !dbtManifestPath || !existsSync(dbtManifestPath);
}

/**
 * `zlens model discover [path] [--validate] [--domain <id>]` previews drafts
 * from the warehouse catalog; `zlens model apply-discovery [path] --apply`
 * writes them as drafts. `--validate` checks each join and naming-key grain
 * on the warehouse (aggregates only) and proposes the cardinality it saw.
 * `--query-history` (opt-in) also counts the joins recent queries ran.
 * Staging copies of a final table (`stg_customers` beside `customers`) are
 * left out, as in Guided Setup; `--include-staging` drafts them too.
 */
async function runWarehouseDiscovery(subcommand: 'discover' | 'apply-discovery', rest: string[], flags: CLIFlags, mode: { fromDbt?: boolean } = {}): Promise<void> {
  const pathArg = rest.find((value, index) => !value.startsWith('-') && rest[index - 1] !== '--source' && rest[index - 1] !== '--dbt-manifest');
  const projectRoot = resolve(pathArg ?? '.');
  const validate = rest.includes('--validate');
  const dbtManifestIndex = rest.indexOf('--dbt-manifest');
  const dbtManifestPath = dbtManifestIndex >= 0 ? rest[dbtManifestIndex + 1] : undefined;
  // Opt-in on a warehouse other than DuckDB or SQLite: read views that join or aggregate (decision M4).
  const readViews = rest.includes('--read-views');
  // Opt-in: read recent query text in memory and keep only which columns were joined.
  const queryHistory = rest.includes('--query-history');
  const includeStaging = rest.includes('--include-staging');
  const { discoverProjectDbtModel, discoverProjectWarehouseModel, applyProjectWarehouseDiscovery } = await import('../local-runtime.js');
  // A running workbench holds a DuckDB file open; the checks then run through it.
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = validate || queryHistory ? new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the warehouse checks through ${via}, which has the DuckDB file open.`); } }) : undefined;
  try {
    const report = mode.fromDbt && executor
      ? await discoverProjectDbtModel(projectRoot, {
        ...(flags.domain ? { domain: flags.domain } : {}),
        hideStagingDuplicates: !includeStaging,
        readViews,
        ...(dbtManifestPath ? { dbtManifestPath } : {}),
        executor,
      })
      : await discoverProjectWarehouseModel(projectRoot, {
        ...(flags.domain ? { domain: flags.domain } : {}),
        validate,
        queryHistory,
        hideStagingDuplicates: !includeStaging,
        readViews,
        ...(executor ? { executor } : {}),
      });
    const writing = subcommand === 'apply-discovery' && flags.apply === true && flags.dryRun !== true;
    if (!writing) {
      if (flags.format === 'json') {
        console.log(JSON.stringify(subcommand === 'apply-discovery' ? { mode: 'preview', ...report } : report, null, 2));
      } else {
        printWarehouseDiscovery(report, mode.fromDbt ? 'ZLens model discovery from dbt and the warehouse' : undefined);
        console.log(subcommand === 'apply-discovery'
          ? 'No files written. Re-run with --apply to add these drafts.'
          : 'Add them as drafts with: zlens model apply-discovery --apply' + (validate ? ' --validate' : ''));
      }
      return;
    }
    const applied = applyProjectWarehouseDiscovery(projectRoot, report);
    if (flags.format === 'json') {
      console.log(JSON.stringify({ catalogFingerprint: report.catalogFingerprint, applied }, null, 2));
    } else {
      console.log(mode.fromDbt ? 'ZLens model discovery apply (dbt and the warehouse)' : 'ZLens warehouse discovery apply');
      console.log(`  ${applied.changes} draft change(s) written:`);
      for (const path of applied.paths) console.log(`    ${path}`);
      console.log('  Everything is a draft. Review and certify on the Modeling page.');
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : 'WAREHOUSE_DISCOVERY_FAILED';
    discoveryError(flags, code, error instanceof Error ? error.message : String(error));
  } finally {
    await executor?.disconnect().catch(() => undefined);
  }
}

/**
 * `zlens model draft [path] [--apply [--passed-only]]` (RFC 0012, P5): draft
 * the whole model, checked on the warehouse, and show it for review by group:
 * the tables to answer from, the look-alikes Ask will skip, the joins with
 * what the warehouse said about each, the measured rules and the concepts.
 * `--apply --passed-only` writes everything except the joins that need a
 * look. A dbt-first project drafts from dbt and the warehouse together.
 */
async function runModelDraft(rest: string[], flags: CLIFlags): Promise<void> {
  // `--select` takes every value up to the next flag, as dbt's does.
  const consumed = new Set<number>();
  const select: string[] = [];
  rest.forEach((value, index) => {
    if (value === '--source' || value === '--dbt-manifest' || value === '--hops' || value === '--budget') consumed.add(index + 1);
    if (value !== '--select') return;
    for (let next = index + 1; next < rest.length && !rest[next]!.startsWith('--'); next += 1) {
      consumed.add(next);
      select.push(rest[next]!);
    }
  });
  if (flags.area) select.push(`area:${flags.area}`);
  const numberAfter = (flag: string): number | undefined | null => {
    const index = rest.indexOf(flag);
    if (index < 0) return undefined;
    const value = Number(rest[index + 1]);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  const hops = numberAfter('--hops');
  const budget = numberAfter('--budget');
  if (hops === null || budget === null || budget === 0) {
    discoveryError(flags, 'INVALID_ARGUMENT', '--hops takes a whole number of steps, and --budget a whole number of tables above 0.');
    return;
  }
  const scoped = select.length > 0 || hops !== undefined || budget !== undefined;
  const pathArg = rest.find((value, index) => !value.startsWith('-') && !consumed.has(index));
  const projectRoot = resolve(pathArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    discoveryError(flags, 'DBT_PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    return;
  }
  const dbtManifestIndex = rest.indexOf('--dbt-manifest');
  const dbtManifestPath = dbtManifestIndex >= 0 ? rest[dbtManifestIndex + 1] : undefined;
  const passedOnly = rest.includes('--passed-only');
  const readViews = rest.includes('--read-views');
  if (scoped && usesWarehouseDiscovery(rest)) {
    discoveryError(flags, 'INVALID_ARGUMENT', '--select, --area, --hops and --budget pick tables of a dbt project. For a warehouse without dbt, choose its schemas with zlens sync warehouse --schemas.');
    return;
  }
  const { discoverProjectDbtModel, discoverProjectWarehouseModel, applyProjectWarehouseDiscovery } = await import('../local-runtime.js');
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the warehouse checks through ${via}, which has the DuckDB file open.`); } });
  try {
    const report = usesWarehouseDiscovery(rest)
      ? await discoverProjectWarehouseModel(projectRoot, { ...(flags.domain ? { domain: flags.domain } : {}), validate: true, hideStagingDuplicates: !rest.includes('--include-staging'), readViews, executor })
      : await discoverProjectDbtModel(projectRoot, {
        ...(flags.domain ? { domain: flags.domain } : {}),
        hideStagingDuplicates: !rest.includes('--include-staging'),
        readViews,
        ...(dbtManifestPath ? { dbtManifestPath } : {}),
        scope: { ...(select.length ? { select } : {}), ...(hops !== undefined ? { hops } : {}), ...(budget !== undefined ? { budget } : {}) },
        executor,
      });
    const needsLook = report.relationships.filter((relationship) => relationship.validation?.status !== 'passed');
    if (flags.apply === true && flags.dryRun !== true) {
      const selection = passedOnly ? { relationshipIds: report.relationships.filter((relationship) => relationship.validation?.status === 'passed').map((relationship) => relationship.id) } : {};
      const applied = applyProjectWarehouseDiscovery(projectRoot, report, selection);
      if (flags.format === 'json') {
        console.log(JSON.stringify({ catalogFingerprint: report.catalogFingerprint, applied, ...(passedOnly ? { leftOut: needsLook.map((relationship) => relationship.id) } : {}), ...(report.scope ? { scope: { ...report.scope, leftOut: report.scope.leftOut.length } } : {}) }, null, 2));
        return;
      }
      console.log('ZLens model draft apply');
      printDraftScope(report);
      console.log(`  ${applied.changes} draft change(s) written${passedOnly && needsLook.length ? `; ${needsLook.length} join${needsLook.length === 1 ? '' : 's'} that need a look left out` : ''}:`);
      for (const path of applied.paths) console.log(`    ${path}`);
      console.log('  Everything is a draft. Certify joins that passed on the Modeling page or with zlens model validate-relationship --certify.');
      return;
    }
    if (flags.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDraftReview(report);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : 'MODEL_DRAFT_FAILED';
    discoveryError(flags, code, error instanceof Error ? error.message : String(error));
  } finally {
    await executor.disconnect().catch(() => undefined);
  }
}

/** What this run drafted of the project, and what it left over the budget (model-at-scale design S4). */
function printDraftScope(report: import('../warehouse-model-discovery.js').WarehouseDiscoveryReport): void {
  const scope = report.scope;
  if (!scope) return;
  console.log(`  Scope: ${scope.description} · ${scope.drafted} of ${scope.asked} table${scope.asked === 1 ? '' : 's'} drafted (budget ${scope.budget} a run)`);
  if (scope.context) console.log(`  Also read ${scope.context} table${scope.context === 1 ? '' : 's'} other areas already model, to draft joins to them (not drafted again)`);
  if (report.areas?.length) {
    const fresh = report.entities.filter((entity) => !entity.existing);
    console.log(`  Areas: ${report.areas.map((area) => `${area.domain}/${area.id}${area.shared ? ' (Shared)' : ''}: ${fresh.filter((entity) => entity.domain === area.domain && entity.area === area.id).length} table${fresh.filter((entity) => entity.domain === area.domain && entity.area === area.id).length === 1 ? '' : 's'}${area.references.length ? `, ${area.references.length} from other areas at its edge` : ''}`).join(' · ')}`);
  }
  if (scope.outside?.length) {
    console.log(`Joins left for another run: ${scope.outside.length} declared join${scope.outside.length === 1 ? ' reaches a table' : 's reach tables'} not drafted yet (${scope.outside.length === 1 ? 'draft its area to add it' : 'draft their areas to add them'})`);
    for (const edge of scope.outside.slice(0, 5)) console.log(`  ${edge.from} → ${edge.to} on ${edge.column}`);
    if (scope.outside.length > 5) console.log(`  … and ${scope.outside.length - 5} more`);
  }
  if (scope.leftOut.length === 0) return;
  console.log(`Left out over the budget: ${scope.leftOut.length} (business tables, then tables an exposure uses, then tables many models read, were drafted first)`);
  for (const item of scope.leftOut.slice(0, 8)) console.log(`  ${item.relation} · ${item.layer}`);
  if (scope.leftOut.length > 8) console.log(`  … and ${scope.leftOut.length - 8} more (--format json lists them all)`);
  if (scope.areas.length > 0) {
    console.log('Draft one area at a time with --select (business tables in each):');
    console.log(`  ${scope.areas.slice(0, 12).map((area) => `${area.id} (${area.tables})`).join(' · ')}`);
  }
}

/** The drafted model by group, as the Modeling page's review shows it. */
function printDraftReview(report: import('../warehouse-model-discovery.js').WarehouseDiscoveryReport): void {
  const fresh = report.entities.filter((entity) => !entity.existing);
  const tables = fresh.filter((entity) => !entity.useInstead);
  const lookAlikes = fresh.filter((entity) => entity.useInstead);
  const passed = report.relationships.filter((relationship) => relationship.validation?.status === 'passed');
  const needsLook = report.relationships.length - passed.length;
  const keyText = (keys: Array<{ from: string; to: string }>) => keys.map((pair) => (pair.from === pair.to ? pair.from : `${pair.from} = ${pair.to}`)).join(', ');
  console.log('ZLens model draft (checked on the warehouse; nothing is written without --apply)');
  printDraftScope(report);
  if (report.dbtLeftOut?.length) console.log(`  Left to the dbt draft: ${report.dbtLeftOut.length} table${report.dbtLeftOut.length === 1 ? '' : 's'} dbt builds (zlens model draft --source dbt drafts ${report.dbtLeftOut.length === 1 ? 'it' : 'them'} as dbt models)`);
  printReadNotes(report);
  console.log(`  ${tables.length} table${tables.length === 1 ? '' : 's'} to answer from · ${lookAlikes.length} with a better table to use instead · ${report.relationships.length} join${report.relationships.length === 1 ? '' : 's'} (${passed.length} passed) · ${report.rules?.length ?? 0} measured rule${report.rules?.length === 1 ? '' : 's'} · ${report.concepts?.length ?? 0} concept${report.concepts?.length === 1 ? '' : 's'}`);
  console.log('Tables to answer from');
  for (const entity of tables) console.log(`  ${entity.domain}${entity.area ? `/${entity.area}` : ''}.${entity.id} ← ${entity.relation}${entity.description ? ` · ${entity.description}` : entity.grain ? ` · one row per ${entity.grain}${entity.sampled ? ` (measured on ${entity.sampled})` : ''}` : ''}`);
  if (report.stagingHidden?.length) {
    console.log('Staging copies left out (a final table holds the same rows; --include-staging drafts them)');
    for (const item of report.stagingHidden) console.log(`  ${item.relation} · same as ${item.finalRelation}`);
  }
  if (lookAlikes.length) {
    console.log('Use another table instead (Ask answers from the other table unless a question names this one)');
    for (const entity of lookAlikes) console.log(`  ${entity.relation} → use ${entity.useInstead!.entity}: ${entity.useInstead!.reason}`);
  }
  console.log('Joins (each checked on the warehouse)');
  if (report.relationships.length === 0) console.log('  none found');
  for (const relationship of report.relationships) {
    const status = relationship.validation?.status;
    const mark = status === 'passed' ? '✓' : status ? '!' : '?';
    const why = status === 'passed' ? '' : status ? `: ${relationship.validation?.message ?? 'the check did not pass'}` : `: not checked${relationship.validationError ? ` (${relationship.validationError})` : ''}`;
    console.log(`  ${mark} ${relationship.from} → ${relationship.to} on ${keyText(relationship.keys)} · ${relationship.cardinality}${why}${relationship.sampled ? ` · checked on ${relationship.sampled}; validate it on the whole tables to certify it` : ''}`);
  }
  if (report.rules?.length) {
    console.log('Rules measured on the data (each number is what the saved query returned)');
    for (const rule of report.rules) console.log(`  ${rule.id}: ${rule.expression}`);
  }
  if (report.concepts?.length) {
    console.log('Concepts');
    for (const concept of report.concepts) console.log(`  ${concept.id}: ${concept.description}`);
  }
  console.log(needsLook
    ? `Write everything that passed with: zlens model draft --apply --passed-only (leaves out the ${needsLook} join${needsLook === 1 ? '' : 's'} that need${needsLook === 1 ? 's' : ''} a look), or all of it with --apply.`
    : 'Write it as drafts with: zlens model draft --apply');
}

/** Lake tables too large to read whole: what the checks read of them (open-formats plan L4). */
function printReadNotes(report: import('../warehouse-model-discovery.js').WarehouseDiscoveryReport): void {
  const notes = report.readNotes ?? [];
  if (!notes.length) return;
  console.log('  Large tables (each check reads at most a set amount of a table; ZLENS_READ_BUDGET_MB changes it):');
  for (const note of notes) console.log(`    ${note.kind === 'sampled' ? '·' : '!'} ${note.text}`);
}

function printWarehouseDiscovery(report: import('../warehouse-model-discovery.js').WarehouseDiscoveryReport, title = 'ZLens warehouse discovery'): void {
  const newEntities = report.entities.filter((entity) => !entity.existing);
  console.log(`${title} (draft only${report.validated ? ', checked on the warehouse' : ''})`);
  printReadNotes(report);
  console.log(`  catalog ${report.catalogFingerprint.slice(0, 12)} · ${report.relations} relations · ${newEntities.length} new entities · ${report.relationships.length} new relationships${report.existingRelationships ? ` · ${report.existingRelationships} already modeled` : ''}${report.rules?.length ? ` · ${report.rules.length} measured rules` : ''}${report.concepts?.length ? ` · ${report.concepts.length} concepts` : ''}`);
  if (report.queryHistory) {
    console.log('error' in report.queryHistory
      ? `  query history: ${report.queryHistory.error}`
      : `  query history: ${report.queryHistory.statements} recent statements read in memory · ${report.queryHistory.joins} distinct joins seen (only join pairs kept)`);
  }
  console.log('Domains');
  for (const domain of report.domains) console.log(`  ${domain.id}${domain.name && domain.name !== domain.id ? ` ("${domain.name}")` : ''}${domain.existing ? ' (exists)' : ''}`);
  if (report.stagingHidden?.length) {
    console.log('Staging copies left out (a final table holds the same data; --include-staging drafts them)');
    for (const item of report.stagingHidden) console.log(`  ${item.relation} · same as ${item.finalRelation}`);
  }
  console.log('Entities');
  for (const entity of report.entities) {
    const repeats = entity.identity?.duplicates ? `grain unset (${entity.identity.columns.join(', ')} repeats on ${entity.identity.duplicates.toLocaleString('en-US')} rows)` : undefined;
    const grain = entity.grain ? `grain ${entity.grain} (${entity.grainSource === 'primary_key' ? 'primary key' : 'unique on the warehouse'})` : repeats ?? (entity.grainCandidate ? `grain unset (candidate ${entity.grainCandidate}; --validate checks it)` : 'grain unset');
    console.log(`  ${entity.domain}.${entity.id} ← ${entity.relation} · ${grain}${entity.layer ? ` · ${entity.layer}` : ''}${entity.existing ? ' · already bound' : ''}`);
  }
  const picks = report.entities.filter((entity) => entity.useInstead);
  if (picks.length) {
    console.log('Table picks (Ask answers from the table on the right until a person decides)');
    for (const entity of picks) {
      console.log(`  ${entity.relation} → ${entity.useInstead!.relation}`);
      console.log(`      ${entity.useInstead!.reason}`);
    }
  }
  console.log('Relationships');
  if (report.relationships.length === 0) console.log('  none found');
  for (const relationship of report.relationships) {
    const keys = relationship.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ');
    const check = relationship.validation
      ? ` · warehouse: ${relationship.validation.status}${relationship.validation.status === 'passed' ? '' : ` (${relationship.validation.message})`}`
      : relationship.validationError ? ` · not checked: ${relationship.validationError}` : '';
    const nameOnly = !relationship.validation && !relationship.validationError && relationship.evidence.every((item) => item.source === 'same_name' || item.source === 'named_for_table' || item.source === 'shared_key')
      ? ' · a name match only: --validate checks the values'
      : '';
    console.log(`  ${relationship.from} → ${relationship.to} on ${keys} · ${relationship.cardinality}${check}${nameOnly}`);
    for (const item of relationship.evidence) console.log(`      because ${item.reason}`);
  }
  if (report.concepts?.length) {
    console.log('Concepts (a key several tables share, with no table of its own)');
    for (const concept of report.concepts) console.log(`  ${concept.domain}.${concept.id}: ${concept.description}`);
  }
  if (report.rules?.length) {
    console.log('Rules measured on the data (each with the query that measured it)');
    for (const rule of report.rules) console.log(`  ${rule.domain}.${rule.id}: ${rule.expression}`);
  }
  if (report.lookAlikeJoins?.length) {
    console.log('Not proposed: these join a table the draft says to use another instead of (the pick\'s joins are drafted)');
    for (const relationship of report.lookAlikeJoins) {
      console.log(`  ${relationship.from} → ${relationship.to} on ${relationship.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ')} · ${relationship.reason}`);
    }
  }
  if (report.withheld?.length) {
    console.log('Not proposed: a name suggested these joins, the warehouse did not back them');
    for (const relationship of report.withheld) {
      console.log(`  ${relationship.from} → ${relationship.to} on ${relationship.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ')}`);
      console.log(`      ${relationship.reason}`);
    }
  }
  if (report.dismissed?.length) {
    console.log('Not proposed again: removed or rejected by a reviewer');
    for (const relationship of report.dismissed) {
      console.log(`  ${relationship.from} → ${relationship.to} on ${relationship.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ')} · ${relationship.reason}`);
    }
  }
}

function runDomainDiscovery(
  subcommand: 'discover' | 'apply-discovery',
  rest: string[],
  flags: CLIFlags,
): void {
  const explicitManifestIndex = rest.indexOf('--dbt-manifest');
  const explicitManifest = explicitManifestIndex >= 0 ? rest[explicitManifestIndex + 1] : undefined;
  const consumed = new Set<number>();
  if (explicitManifestIndex >= 0) {
    consumed.add(explicitManifestIndex);
    consumed.add(explicitManifestIndex + 1);
  }
  const pathArg = rest.find((value, index) => !value.startsWith('-') && !consumed.has(index));
  const projectRoot = resolve(pathArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    discoveryError(flags, 'DBT_PROJECT_NOT_FOUND', `No ZLens project found at ${projectRoot} (missing dql.config.json).`);
    return;
  }
  const dbtManifestPath = resolveDbtManifestPath(
    projectRoot,
    explicitManifest ? resolve(projectRoot, explicitManifest) : undefined,
  );
  if (!dbtManifestPath || !existsSync(dbtManifestPath)) {
    discoveryError(flags, 'DBT_MANIFEST_MISSING', 'No dbt manifest found. Run dbt parse or pass --dbt-manifest <path>.');
    return;
  }

  let report: DomainDiscoveryReport;
  try {
    report = discoverDbtDomains({ projectRoot, dbtManifestPath });
  } catch (error) {
    discoveryError(
      flags,
      'DBT_ARTIFACT_INVALID',
      `Could not discover domains from the dbt artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (subcommand === 'discover') {
    printDiscoveryReport(report, flags, false);
    return;
  }

  const selected = flags.domain
    ? report.proposals.filter((proposal) => proposal.id === flags.domain)
    : report.proposals;
  if (flags.domain && selected.length === 0) {
    discoveryError(flags, 'DOMAIN_MEMBERSHIP_AMBIGUOUS', `No unambiguous discovered domain named "${flags.domain}".`);
    return;
  }
  if (!flags.apply || flags.dryRun) {
    printDiscoveryReport({ ...report, proposals: selected }, flags, true);
    return;
  }

  const registry = loadDomainPackageRegistry(projectRoot);
  const existing = new Set(registry.values().map((pkg) => pkg.id));
  const selectedIds = new Set(selected.map((proposal) => proposal.id));
  const results = selected.map((proposal) => applyDomainProposal(projectRoot, proposal, report, existing, selectedIds));
  const output = { sourceFingerprint: report.sourceFingerprint, applied: results };
  if (flags.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('ZLens domain discovery apply');
    for (const result of results) console.log(`  ${result.status === 'created' ? '+' : result.status === 'existing' ? '=' : '!'} ${result.id}: ${result.message}`);
    printRelationshipCandidates(report);
    console.log('Skill candidates remain review-only drafts and were not written or certified.');
  }
  if (results.some((result) => result.status === 'blocked')) process.exitCode = 1;
}

function applyDomainProposal(
  projectRoot: string,
  proposal: DomainProposal,
  report: DomainDiscoveryReport,
  existing: Set<string>,
  selected: Set<string>,
): { id: string; status: 'created' | 'existing' | 'blocked'; path?: string; message: string } {
  if (existing.has(proposal.id)) {
    return { id: proposal.id, status: 'existing', message: 'existing Domain Package retained unchanged' };
  }
  if (proposal.proposedParent && !existing.has(proposal.proposedParent) && !selected.has(proposal.proposedParent)) {
    return {
      id: proposal.id,
      status: 'blocked',
      message: `proposed parent "${proposal.proposedParent}" must exist or be selected before apply`,
    };
  }
  const safeSegments = proposal.id.split('.').filter((segment) => /^[a-z0-9_]+$/.test(segment));
  if (safeSegments.length !== proposal.id.split('.').length || safeSegments.length === 0) {
    return { id: proposal.id, status: 'blocked', message: 'domain id is not a safe normalized path' };
  }
  const sourcePath = ['domains', ...safeSegments, 'domain.dql'].join('/');
  const absolutePath = resolve(projectRoot, sourcePath);
  const memberships = report.memberships.filter((membership) => membership.proposedDomain === proposal.id);
  const dbtPaths = [...new Set(memberships.map((membership) => membership.sourcePath).filter((value): value is string => Boolean(value)))].sort();
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, renderDomainDeclaration({
    id: proposal.id,
    name: proposal.name,
    parent: proposal.proposedParent,
    owner: proposal.owner,
    dbtPaths,
    description: 'Draft domain boundary proposed from cited dbt evidence; review before governance use.',
  }), 'utf8');
  existing.add(proposal.id);
  return { id: proposal.id, status: 'created', path: sourcePath, message: `wrote ${sourcePath} as a review-required proposal` };
}

function printDiscoveryReport(report: DomainDiscoveryReport, flags: CLIFlags, applyPreview: boolean): void {
  if (flags.format === 'json') {
    console.log(JSON.stringify(applyPreview ? { mode: 'preview', ...report } : report, null, 2));
    return;
  }
  console.log(`ZLens dbt domain discovery${applyPreview ? ' apply preview' : ''} (deterministic, draft only)`);
  console.log(`  source ${report.sourceFingerprint.slice(0, 12)} · ${report.memberships.length} models · ${report.unassignedModels.length} unassigned`);
  console.log('Domain proposals');
  if (report.proposals.length === 0) console.log('  none');
  for (const proposal of report.proposals) {
    const owner = proposal.owner ? ` · owner=${proposal.owner}` : '';
    const parent = proposal.proposedParent ? ` · parent=${proposal.proposedParent}` : '';
    console.log(`  ${proposal.id}: ${proposal.matchedDbtUniqueIds.length} models · ${proposal.confidence}${owner}${parent}${proposal.requiresReview ? ' · review required' : ''}`);
  }
  if (report.unassignedModels.length > 0) {
    console.log('Unassigned models');
    for (const model of report.unassignedModels) {
      const candidates = model.candidateDomains.length > 0 ? ` (${model.candidateDomains.join(', ')})` : '';
      console.log(`  ${model.dbtUniqueId}: ${model.reason}${candidates}`);
    }
  }
  printRelationshipCandidates(report);
  console.log(`Review-only skill drafts: ${report.skillDraftCandidates.length}; none are certified.`);
  if (applyPreview) console.log('No files written. Re-run with --apply after reviewing the selected proposals.');
}

/**
 * REL-004: show the relationships dbt already declares, with their exact key
 * pairs, instead of reporting a bare count the author cannot act on. These are
 * draft candidates — `zlens model import` binds them, certification stays manual.
 */
function printRelationshipCandidates(report: DomainDiscoveryReport): void {
  if (report.relationshipDraftCandidates.length === 0) {
    console.log('Relationships declared in dbt tests: none found.');
    return;
  }
  console.log(`Relationships declared in dbt tests: ${report.relationshipDraftCandidates.length} (draft candidates, not certified)`);
  for (const candidate of report.relationshipDraftCandidates) {
    const keys = candidate.keys.map((key) => `${key.from} = ${key.to}`).join(', ');
    console.log(`  ${candidate.fromDbtUniqueId} -> ${candidate.toDbtUniqueId} on ${keys}`);
  }
  console.log('  Bind these with: zlens model import <schema.yml> --domain <id> --apply');
}

function discoveryError(flags: CLIFlags, code: string, message: string): void {
  if (flags.format === 'json') console.log(JSON.stringify({ code, message, recoverable: true }, null, 2));
  else console.error(`${code}: ${message}`);
  process.exitCode = 1;
}
