import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { Parser } from '../parser/index.js';

/**
 * Certification receipts for business terms.
 *
 * A term is certified only through an explicit Certify action, the same
 * promise saved queries keep: the action checks the term (an owner, a
 * definition, metrics that exist), writes `status = "certified"` into the
 * term's declaration and leaves a receipt beside the `.dql` file
 * (`terms/revenue.dql` → `terms/revenue.certification.yaml`). The receipt says
 * who certified the term, when, and holds a fingerprint of what the term
 * means. A term whose source says certified without a receipt that matches it
 * counts as a draft: typing the word into a file is not a review.
 *
 * One receipt file holds every certified term its `.dql` file declares, keyed
 * by term name, so a file with several terms keeps them apart.
 */

export interface TermCertificationReceipt {
  /** Who certified: the host's signed-in person, else the local git/OS owner. */
  certifiedBy: string;
  /** Their display name, when one is known. */
  certifiedByName?: string;
  /** ISO-8601 time of the certification. */
  certifiedAt: string;
  /** The surface the Certify action came from. */
  via: 'modeling' | 'cli';
  /** The fingerprint of the term ({@link termCertificationFingerprint}). */
  termSha256: string;
  /** The checks the term passed. */
  checks?: string[];
}

/** The fields of a term that make up its meaning; the status is not one of them. */
export interface TermMeaning {
  name: string;
  domain?: string;
  termType?: string;
  description?: string;
  owner?: string;
  businessOwner?: string;
  tags?: string[];
  synonyms?: string[];
  identifiers?: string[];
  metricRefs?: string[];
  businessOutcome?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
}

/**
 * - `matches`: a receipt certified exactly this term.
 * - `changed`: the term was edited after it was certified.
 * - `no_receipt`: nothing certified it (no receipt file, or none for this term).
 */
export type TermCertificationState = 'matches' | 'changed' | 'no_receipt';

const RECEIPT_HEADER = '# ZLens certification receipts for the terms in the .dql file of the same name.\n'
  + '# Written by Certify (Modeling → Terms & concepts, or zlens certify). Editing a term clears its receipt.\n';

/**
 * The fingerprint a receipt records: sha256 over the term's meaning. Lists are
 * compared as sets, so reordering synonyms is not an edit; the status is left
 * out, so writing `certified` does not change what was certified.
 */
export function termCertificationFingerprint(term: TermMeaning): string {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const list = (value: unknown) => (Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].sort()
    : []);
  const canonical = {
    name: text(term.name),
    domain: text(term.domain),
    termType: text(term.termType),
    description: text(term.description),
    owner: text(term.owner),
    businessOwner: text(term.businessOwner),
    tags: list(term.tags),
    synonyms: list(term.synonyms),
    identifiers: list(term.identifiers),
    metricRefs: list(term.metricRefs),
    businessOutcome: text(term.businessOutcome),
    decisionUse: text(term.decisionUse),
    reviewCadence: text(term.reviewCadence),
    businessRules: list(term.businessRules),
    caveats: list(term.caveats),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The project-relative receipt file of a term file, or null when the term does not live in a `.dql` file (a notebook cell). */
export function termCertificationReceiptPath(termFilePath: string): string | null {
  return /\.dql$/.test(termFilePath) ? termFilePath.replace(/\.dql$/, '.certification.yaml') : null;
}

/** Every receipt a term file's receipt file holds, by term name. */
export function readTermCertificationReceipts(projectRoot: string, termFilePath: string): Record<string, TermCertificationReceipt> {
  const receiptPath = termCertificationReceiptPath(termFilePath);
  if (!receiptPath) return {};
  const absolute = join(projectRoot, receiptPath);
  if (!existsSync(absolute)) return {};
  try {
    const parsed = yaml.load(readFileSync(absolute, 'utf-8')) as { terms?: Record<string, unknown> } | null;
    const receipts: Record<string, TermCertificationReceipt> = {};
    for (const [name, raw] of Object.entries(parsed?.terms ?? {})) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      const sha = typeof record.termSha256 === 'string' ? record.termSha256.trim().toLowerCase() : '';
      if (typeof record.certifiedBy !== 'string' || record.certifiedAt === undefined || !/^[0-9a-f]{64}$/.test(sha)) continue;
      const at = record.certifiedAt as unknown;
      receipts[name] = {
        certifiedBy: record.certifiedBy,
        ...(typeof record.certifiedByName === 'string' && record.certifiedByName.trim() ? { certifiedByName: record.certifiedByName.trim() } : {}),
        certifiedAt: at instanceof Date ? at.toISOString() : String(at),
        via: record.via === 'cli' ? 'cli' : 'modeling',
        termSha256: sha,
        ...(Array.isArray(record.checks) ? { checks: record.checks.map(String) } : {}),
      };
    }
    return receipts;
  } catch {
    return {};
  }
}

/** Whether a term is the one its receipt certified. */
export function termCertificationState(
  projectRoot: string,
  termFilePath: string,
  term: TermMeaning,
): { state: TermCertificationState; receipt?: TermCertificationReceipt; receiptPath: string | null } {
  const receiptPath = termCertificationReceiptPath(termFilePath);
  const receipt = readTermCertificationReceipts(projectRoot, termFilePath)[term.name];
  if (!receipt) return { state: 'no_receipt', receiptPath };
  return { state: receipt.termSha256 === termCertificationFingerprint(term) ? 'matches' : 'changed', receipt, receiptPath };
}

function writeReceipts(projectRoot: string, termFilePath: string, receipts: Record<string, TermCertificationReceipt>): void {
  const receiptPath = termCertificationReceiptPath(termFilePath);
  if (!receiptPath) throw new Error(`Only a term in a .dql file can be certified; ${termFilePath} is not one.`);
  const absolute = join(projectRoot, receiptPath);
  const names = Object.keys(receipts).sort();
  if (!names.length) {
    rmSync(absolute, { force: true });
    return;
  }
  const ordered = Object.fromEntries(names.map((name) => [name, receipts[name]]));
  writeFileSync(absolute, RECEIPT_HEADER + yaml.dump({ terms: ordered }, { lineWidth: 200, noRefs: true }), 'utf-8');
}

/** Record that a person certified this term. */
export function writeTermCertificationReceipt(projectRoot: string, termFilePath: string, name: string, receipt: TermCertificationReceipt): void {
  writeReceipts(projectRoot, termFilePath, { ...readTermCertificationReceipts(projectRoot, termFilePath), [name]: receipt });
}

/** Drop a term's receipt (it was edited, renamed, retired or deleted); the file goes when it holds no other term's. */
export function removeTermCertificationReceipt(projectRoot: string, termFilePath: string, name: string): boolean {
  if (!termCertificationReceiptPath(termFilePath)) return false;
  const receipts = readTermCertificationReceipts(projectRoot, termFilePath);
  if (!receipts[name]) return false;
  delete receipts[name];
  writeReceipts(projectRoot, termFilePath, receipts);
  return true;
}

/** The meaning of the term called `name` in a `.dql` source, or null when the source declares no such term. */
export function termMeaningInSource(source: string, name: string, filePath = 'term.dql'): (TermMeaning & { status?: string; start: number; end: number }) | null {
  const ast = new Parser(source, filePath).parse();
  for (const statement of ast.statements) {
    const term = statement as unknown as TermMeaning & { kind: string; status?: string; span: { start: { offset: number }; end: { offset: number } } };
    if (term.kind !== 'TermDecl' || term.name !== name) continue;
    return { ...term, start: term.span.start.offset, end: term.span.end.offset };
  }
  return null;
}

/**
 * Set the status of one term in a `.dql` source, leaving every other line
 * (other terms, comments, formatting) as it was. Throws when the result would
 * mean anything else than the term did before.
 */
export function setTermStatusInSource(source: string, name: string, status: string): string {
  const term = termMeaningInSource(source, name);
  if (!term) throw new Error(`No term named "${name}" in this file.`);
  const body = source.slice(term.start, term.end);
  const statusLine = /^(\s*)status\s*=\s*"[^"]*"/m;
  const nextBody = statusLine.test(body)
    ? body.replace(statusLine, (_match, indent: string) => `${indent}status = "${status}"`)
    : body.replace(/\{[^\S\n]*\n?/, (open) => `${open.endsWith('\n') ? open : `${open}\n`}  status = "${status}"\n`);
  const next = source.slice(0, term.start) + nextBody + source.slice(term.end);
  const reread = termMeaningInSource(next, name);
  if (!reread || reread.status !== status || termCertificationFingerprint(reread) !== termCertificationFingerprint(term)) {
    throw new Error(`Could not set the status of term "${name}" without changing it. Edit its file directly.`);
  }
  return next;
}

/** The sentence every surface uses for a term that says certified without a matching receipt. */
export function termNotCertifiedMessage(name: string, state: Exclude<TermCertificationState, 'matches'>, receiptPath: string | null): string {
  const why = state === 'changed'
    ? 'it was edited after it was certified'
    : receiptPath ? `nobody certified it (no receipt in ${receiptPath})` : 'only a term in a .dql file can carry a certification receipt';
  return `term "${name}" says certified, but ${why}, so it counts as a draft. Certify it in Modeling → Terms & concepts, or with zlens certify.`;
}
