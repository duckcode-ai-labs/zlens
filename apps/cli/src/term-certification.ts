import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setTermStatusInSource,
  termCertificationFingerprint,
  termMeaningInSource,
  writeTermCertificationReceipt,
  type ManifestTerm,
  type TermCertificationReceipt,
} from '@zlens/core';

/**
 * Certify for business terms: the checks a term must pass, and the one write
 * that makes it certified (its status plus a receipt beside its file). Saving
 * a term never certifies it; the Modeling page's Certify button and
 * `zlens certify <term file>` both come through here.
 */

export interface TermCertificationVerdict {
  /** Plain sentences, one per thing to fix. Empty when the term can be certified. */
  blockers: string[];
  /** Names of the checks that passed, for the receipt. */
  checks: string[];
}

/** What a term needs before a person can certify it. `knownMetrics` is checked only when the project has a semantic layer. */
export function termCertificationVerdict(term: ManifestTerm, knownMetrics?: Set<string>): TermCertificationVerdict {
  const blockers: string[] = [];
  const checks: string[] = [];
  if ((term.status ?? '').toLowerCase() === 'deprecated') blockers.push('A retired term cannot be certified. Set it back to draft first.');
  if (!/\.dql$/.test(term.filePath)) blockers.push(`Only a term in a .dql file can be certified; this one is in ${term.filePath}.`);
  if (term.owner?.trim()) checks.push('has-owner');
  else blockers.push('Add an owner: the person or team who answers for this word.');
  if (term.description?.trim()) checks.push('has-definition');
  else blockers.push('Add a definition (the description), so everyone reads the word the same way.');
  if (term.metricRefs?.length && knownMetrics) {
    const unknown = term.metricRefs.filter((ref) => !knownMetrics.has(ref.toLowerCase()));
    if (unknown.length) blockers.push(`Unknown metric${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Link governed metrics only.`);
    else checks.push('metrics-resolve');
  }
  return { blockers, checks };
}

/**
 * Write `status = "certified"` into the term's declaration and its receipt.
 * The caller has checked the term with {@link termCertificationVerdict}.
 */
export function certifyTermDeclaration(projectRoot: string, term: ManifestTerm, input: {
  certifiedBy: string | undefined | null;
  certifiedByName?: string | undefined | null;
  via: TermCertificationReceipt['via'];
  checks: string[];
  now?: Date;
}): TermCertificationReceipt {
  const absolute = join(projectRoot, term.filePath);
  const source = readFileSync(absolute, 'utf-8');
  const certified = setTermStatusInSource(source, term.name, 'certified');
  const meaning = termMeaningInSource(certified, term.name, term.filePath);
  if (!meaning) throw new Error(`No term named "${term.name}" in ${term.filePath}.`);
  const certifiedBy = input.certifiedBy?.trim() || term.owner?.trim() || 'local';
  const certifiedByName = input.certifiedByName?.replace(/[\r\n]/g, ' ').trim();
  const receipt: TermCertificationReceipt = {
    certifiedBy,
    ...(certifiedByName && certifiedByName !== certifiedBy ? { certifiedByName } : {}),
    certifiedAt: (input.now ?? new Date()).toISOString(),
    via: input.via,
    termSha256: termCertificationFingerprint(meaning),
    ...(input.checks.length ? { checks: [...new Set(input.checks)] } : {}),
  };
  if (certified !== source) writeFileSync(absolute, certified, 'utf-8');
  writeTermCertificationReceipt(projectRoot, term.filePath, term.name, receipt);
  return receipt;
}
