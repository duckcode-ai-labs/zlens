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
import { rejectDiscoveredRelationship, startLocalServer, validateProjectRelationships } from '../local-runtime.js';

/** `zlens model` — inspect/validate v3 and preview evidence-bounded discovery (AGT-002/API-001). */
export async function runModel(file: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const subcommand = file ?? 'list';
  if (subcommand === 'discover' || subcommand === 'apply-discovery') {
    if (usesWarehouseDiscovery(rest)) {
      await runWarehouseDiscovery(subcommand, rest, flags);
      return;
    }
    runDomainDiscovery(subcommand, rest, flags);
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
    console.error('dbt-first modeling is not enabled. Set manifestVersion: 3 and modeling.mode: "dbt-first" in dql.config.json.');
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
    const relationship = manifest.modeling.relationships[relationshipId];
    if (!relationship) {
      console.error(`No relationship named "${relationshipId}".`);
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
    console.error('Usage: zlens model list|validate|discover [path] | zlens model explain <relationship-id> [path] | zlens model validate-relationship <relationship-id>|--all [path] [--certify] [--dry-run] | zlens model reject-discovery <relationship-id> [path] [--reason <text>] | zlens model apply-discovery [path] --domain <id> --apply | zlens model import <file-or-directory> --domain <id> --area <id> --dry-run|--apply');
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
async function runWarehouseDiscovery(subcommand: 'discover' | 'apply-discovery', rest: string[], flags: CLIFlags): Promise<void> {
  const pathArg = rest.find((value, index) => !value.startsWith('-') && rest[index - 1] !== '--source' && rest[index - 1] !== '--dbt-manifest');
  const projectRoot = resolve(pathArg ?? '.');
  const validate = rest.includes('--validate');
  // Opt-in: read recent query text in memory and keep only which columns were joined.
  const queryHistory = rest.includes('--query-history');
  const includeStaging = rest.includes('--include-staging');
  const { discoverProjectWarehouseModel, applyProjectWarehouseDiscovery } = await import('../local-runtime.js');
  // A running workbench holds a DuckDB file open; the checks then run through it.
  const { WorkbenchRoutedQueryExecutor } = await import('../workbench-query-route.js');
  const executor = validate || queryHistory ? new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the warehouse checks through ${via}, which has the DuckDB file open.`); } }) : undefined;
  try {
    const report = await discoverProjectWarehouseModel(projectRoot, {
      ...(flags.domain ? { domain: flags.domain } : {}),
      validate,
      queryHistory,
      hideStagingDuplicates: !includeStaging,
      ...(executor ? { executor } : {}),
    });
    const writing = subcommand === 'apply-discovery' && flags.apply === true && flags.dryRun !== true;
    if (!writing) {
      if (flags.format === 'json') {
        console.log(JSON.stringify(subcommand === 'apply-discovery' ? { mode: 'preview', ...report } : report, null, 2));
      } else {
        printWarehouseDiscovery(report);
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
      console.log('ZLens warehouse discovery apply');
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

function printWarehouseDiscovery(report: import('../warehouse-model-discovery.js').WarehouseDiscoveryReport): void {
  const newEntities = report.entities.filter((entity) => !entity.existing);
  console.log(`ZLens warehouse discovery (draft only${report.validated ? ', checked on the warehouse' : ''})`);
  console.log(`  catalog ${report.catalogFingerprint.slice(0, 12)} · ${report.relations} relations · ${newEntities.length} new entities · ${report.relationships.length} new relationships${report.existingRelationships ? ` · ${report.existingRelationships} already modeled` : ''}`);
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
    const grain = entity.grain ? `grain ${entity.grain} (${entity.grainSource === 'primary_key' ? 'primary key' : 'unique on the warehouse'})` : entity.grainCandidate ? `grain unset (candidate ${entity.grainCandidate}; --validate checks it)` : 'grain unset';
    console.log(`  ${entity.domain}.${entity.id} ← ${entity.relation} · ${grain}${entity.existing ? ' · already bound' : ''}`);
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
