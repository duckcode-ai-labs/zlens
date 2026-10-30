import type { CLIFlags } from '../args.js';
import type { BlockStudioImportCandidate } from '../block-studio-import.js';
import { createDqlGenerationSessionForProject } from '../local-runtime.js';

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

  if (flags.format === 'json') {
    console.log(JSON.stringify({ session, drafts, saved: drafts, reused, skipped, errors }, null, 2));
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
  console.log('');
  if (errors.length > 0) process.exitCode = 1;
}

function validationErrorsFor(candidate: BlockStudioImportCandidate): string[] {
  const diagnostics = ((candidate.validation as any)?.diagnostics ?? []) as Array<{ severity?: string; message?: string }>;
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message || 'Candidate validation failed.');
}
