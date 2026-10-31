import type { CLIFlags } from '../args.js';
import type { BlockStudioImportCandidate } from '../block-studio-import.js';
import { importFailureKind, previewImportCandidate, withImportRuntime, type ImportPreviewOutcome } from '../import-runtime.js';
import { createDqlGenerationSessionForProject } from '../local-runtime.js';
import type { ImportMetricDrafts } from '../import-metric-drafts.js';
import { formatValue } from './semantic.js';

export async function runImport(source: string, rest: string[], flags: CLIFlags): Promise<void> {
  if (source !== 'sql') {
    console.error(`\n  ✗ Unknown import source: "${source}"`);
    console.error('    Supported sources in this build: sql');
    console.error('');
    process.exit(1);
  }

  const inputPath = rest[0] || flags.input;
  if (!inputPath) {
    console.error('\n  ✗ Missing SQL import path.');
    console.error('    Usage: zlens import sql <file-or-folder> [--domain <name>] [--owner <name>]');
    console.error('');
    process.exit(1);
  }

  const session = await createDqlGenerationSessionForProject(process.cwd(), {
    sourceKind: 'raw-sql',
    inputPath,
    domain: flags.domain || 'imported',
    owner: flags.owner || '',
    provider: flags.provider,
  });
  const candidates = session.candidates;
  const drafts = candidates
    .filter((candidate) => candidate.draftSave.status === 'saved' && candidate.draftSave.path)
    .map((candidate) => ({ candidateId: candidate.id, path: candidate.draftSave.path as string }));
  const reused = candidates
    .filter((candidate) => candidate.draftSave.status === 'skipped')
    .map((candidate) => ({ candidateId: candidate.id, reason: candidate.draftSave.reason ?? 'Reuse recommended.' }));
  const errors = candidates.flatMap((candidate) => {
    const validationErrors = validationErrorsFor(candidate);
    const saveError = candidate.draftSave.status === 'error' && candidate.draftSave.error ? [candidate.draftSave.error] : [];
    return [...validationErrors, ...saveError].map((error) => ({ candidateId: candidate.id, error }));
  });

  const skipped = session.skippedStatements ?? [];

  // Run each draft once, as the Import SQL page does, so the list says which
  // ones work before anyone opens them.
  const previews = new Map<string, ImportPreviewOutcome>();
  let previewError: string | null = null;
  // The BI file's simple, filtered and ratio calculations become metric drafts, checked on the database (D3).
  let metricDrafts: ImportMetricDrafts | null = null;
  let metricDraftsError: string | null = null;
  const wantsPreviews = flags.preview !== false && drafts.length > 0;
  const wantsMetrics = flags.metrics !== false && /tableau|powerbi|folder|upload/.test(session.sourceKind);
  if (wantsPreviews || wantsMetrics) {
    try {
      await withImportRuntime(process.cwd(), flags, async (call) => {
        if (wantsPreviews) for (const draft of drafts) previews.set(draft.candidateId, await previewImportCandidate(call, session.id, draft.candidateId));
        if (wantsMetrics) {
          const response = await call('POST', `/api/block-studio/ai-imports/${encodeURIComponent(session.id)}/metric-drafts`, { check: flags.checkMetrics !== false });
          if (response.status === 200) metricDrafts = response.body?.metricDrafts ?? null;
          else metricDraftsError = String(response.body?.error ?? `HTTP ${response.status}`);
        }
      });
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
    }
  }
  const ran = Array.from(previews.values()).filter((outcome) => outcome.ok).length;
  const failures = new Map<string, number>();
  for (const outcome of previews.values()) if (!outcome.ok) failures.set(importFailureKind(outcome.reason), (failures.get(importFailureKind(outcome.reason)) ?? 0) + 1);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      session,
      drafts,
      saved: drafts,
      reused,
      skipped,
      errors,
      previews: Object.fromEntries(previews),
      ...(previewError ? { previewError } : {}),
      ...(metricDrafts ? { metricDrafts } : {}),
      ...(metricDraftsError ? { metricDraftsError } : {}),
    }, null, 2));
    return;
  }

  console.log('\n  ZLens AI Import: SQL');
  console.log('  ─────────────────────────────');
  console.log(`  Session:     ${session.id}`);
  console.log(`  Source:      ${session.inputPath}`);
  console.log(`  Candidates:  ${session.candidates.length}`);
  console.log(`  Drafts:      ${drafts.length}`);
  console.log(`  Reuse:       ${reused.length}`);
  if (skipped.length > 0) console.log(`  Left out:    ${skipped.length}`);
  console.log(`  Domain:      ${session.defaults.domain}`);
  if (session.defaults.owner) console.log(`  Owner:       ${session.defaults.owner}`);
  console.log(`  Generator:   ${session.generation.provider}`);
  if (errors.length > 0) console.log(`  Needs fixes: ${errors.length}`);
  if (flags.save) console.log('  Note:        --save is retained for compatibility; AI imports autosave as review drafts.');
  console.log('');
  for (const candidate of session.candidates) {
    const tables = candidate.lineage.sourceTables.length > 0
      ? candidate.lineage.sourceTables.join(', ')
      : 'not detected';
    const validationErrors = validationErrorsFor(candidate);
    const warningText = candidate.lineage.warnings.length > 0
      ? ` · ${candidate.lineage.warnings.join('; ')}`
      : '';
    const draftPath = drafts.find((item) => item.candidateId === candidate.id)?.path;
    const action = candidate.recommendedAction ? ` · ${candidate.recommendedAction}` : '';
    const params = candidate.parameterPolicy?.length
      ? ` · params ${candidate.parameterPolicy.map((entry) => `${entry.name}:${entry.policy}`).join(', ')}`
      : '';
    console.log(`  • ${candidate.name}`);
    console.log(`    ${candidate.id} · confidence ${Math.round(candidate.confidence * 100)}%${action} · tables: ${tables}${params}${warningText}`);
    if (validationErrors.length > 0) console.log(`    fix: ${validationErrors.join(' ')}`);
    if (draftPath) console.log(`    draft: ${draftPath}`);
    const preview = previews.get(candidate.id);
    if (preview) console.log(preview.ok ? `    ran: ${preview.rowCount} row${preview.rowCount === 1 ? '' : 's'}` : `    needs a fix: ${preview.reason}`);
    if (candidate.draftSave.status === 'skipped' && candidate.draftSave.reason) console.log(`    reuse: ${candidate.draftSave.reason}`);
    if (candidate.similarityMatches?.length) {
      const match = candidate.similarityMatches[0];
      console.log(`    match: ${match.name} (${match.kind}, ${Math.round(match.score * 100)}%)`);
    }
  }
  if (skipped.length > 0) {
    console.log('');
    console.log(`  Left out (${skipped.length}): no draft was made for these.`);
    for (const item of skipped) {
      console.log(`  • ${item.sourcePath}: ${item.reason}`);
      console.log(`    ${item.sql}`);
    }
  }
  console.log('');
  console.log('  Drafts are autosaved under blocks/_drafts or domains/<domain>/blocks/_drafts. Review, preview, then certify selected candidates.');
  console.log(`  Import cache: .dql/imports/${session.id}/`);
  if (previews.size > 0) {
    console.log('');
    console.log(`  Ran: ${ran} of ${previews.size} drafts.${failures.size ? ` Need a fix: ${previews.size - ran}.` : ''}`);
    for (const [reason, count] of [...failures.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${count} × ${reason}`);
    if (ran > 0) console.log(`  Certify the ones that pass the checks: zlens certify --from-import ${session.id} --apply`);
  } else if (previewError) {
    console.log('');
    console.log(`  The drafts were not run: ${previewError}`);
    console.log(`  Fix the connection, then check them with: zlens certify --from-import ${session.id}`);
  }
  if (metricDrafts) printMetricDrafts(metricDrafts);
  else if (metricDraftsError) {
    console.log('');
    console.log(`  Metric drafts were not made: ${metricDraftsError}`);
  }
  console.log('');
  if (errors.length > 0) process.exitCode = 1;
}

/** The import's metric drafts: what each calculation became, its value over all rows, and what was left out with why. */
export function printMetricDrafts(record: ImportMetricDrafts): void {
  if (!record.items.length) return;
  const width = Math.min(28, Math.max(12, ...record.items.map((item) => item.calculation.length)));
  const row = (name: string, text: string, tail = '') => console.log(`    ${name.padEnd(width)}  ${text}${tail ? `   ${tail}` : ''}`);
  const value = (item: ImportMetricDrafts['items'][number]) => (!record.checked ? 'not run' : item.value === undefined ? '' : item.value === null ? 'all rows: empty' : `all rows: ${formatValue(item.value)}`);
  const drafted = record.items.filter((item) => item.outcome === 'drafted');
  console.log('');
  if (!record.written) {
    console.log(`  Metric drafts: not written. ${record.notWrittenReason ?? ''}`);
    for (const item of drafted) row(item.calculation, item.inWords ?? '');
  } else if (drafted.length) {
    console.log(`  ${drafted.length} calculation${drafted.length === 1 ? ' became a metric draft' : 's became metric drafts'} (semantic-layer/metrics/_drafts/${record.domain}/):`);
    for (const item of drafted) {
      row(item.calculation, item.inWords ?? item.metric ?? '', value(item));
      for (const note of item.notes) console.log(`    ${''.padEnd(width)}  note: ${note}`);
    }
  }
  const reused = record.items.filter((item) => item.outcome === 'reused');
  if (reused.length) {
    console.log(`  ${reused.length} ${reused.length === 1 ? 'is already a metric or a draft' : 'are already metrics or drafts'}:`);
    for (const item of reused) row(item.calculation, item.reason ?? `the metric ${item.metric}`);
  }
  const failed = record.items.filter((item) => item.outcome === 'failed');
  if (failed.length) {
    console.log(`  ${failed.length} did not run on the database, so ${failed.length === 1 ? 'it was' : 'they were'} not written:`);
    for (const item of failed) row(item.calculation, item.inWords ?? '', item.reason);
  }
  const leftOut = record.items.filter((item) => item.outcome === 'left-out' || item.outcome === 'advanced');
  if (leftOut.length) {
    console.log(`  ${leftOut.length} calculation${leftOut.length === 1 ? ' is' : 's are'} left out:`);
    for (const item of leftOut.slice(0, 20)) row(item.calculation, item.formula.replace(/\s+/g, ' ').slice(0, 60), item.reason);
    if (leftOut.length > 20) console.log(`    … and ${leftOut.length - 20} more (zlens import sql … --format json lists them all).`);
  }
  const rowLevel = record.items.filter((item) => item.outcome === 'row-level').length;
  if (rowLevel) console.log(`  ${rowLevel} row-level calculation${rowLevel === 1 ? ' is a value per row' : 's are values per row'}: used inside the metrics that add them up, not metrics of their own.`);
  if (record.written && drafted.some((item) => item.path)) {
    console.log(`  They answer nothing until approved. Check each value against the old report, then: zlens semantic approve --all-from ${record.importId}`);
  }
}

function validationErrorsFor(candidate: BlockStudioImportCandidate): string[] {
  const diagnostics = ((candidate.validation as any)?.diagnostics ?? []) as Array<{ severity?: string; message?: string }>;
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message || 'Candidate validation failed.');
}
