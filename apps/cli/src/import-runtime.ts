import type { CLIFlags } from './args.js';
import { startProjectRuntime } from './commands/notebook.js';
import { findRunningNotebook, serverTokenFor } from './schedule/notebook-runtime.js';

/**
 * Import SQL from the terminal, through the routes the Import SQL page uses:
 * a preview or a Certify from `zlens import sql` / `zlens certify
 * --from-import` is the page's own, with the same read-only guard, checks and
 * receipt. The running `zlens notebook` serves them when there is one (it
 * holds the DuckDB file open); otherwise an ephemeral runtime does, closed
 * when the work is done.
 */

export type ImportRuntimeCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export async function withImportRuntime<T>(
  projectRoot: string,
  flags: Pick<CLIFlags, 'format'>,
  work: (call: ImportRuntimeCall) => Promise<T>,
): Promise<T> {
  const running = await findRunningNotebook(projectRoot).catch(() => null);
  const token = running ? serverTokenFor(running.loopback) : undefined;
  if (running && flags.format !== 'json') console.error(`  Using zlens notebook (pid ${running.descriptor.pid}) at ${running.url}.`);
  const handle = running
    ? { url: running.url, close: async () => undefined }
    : await startProjectRuntime(projectRoot, { preferredPort: 0 });
  const call: ImportRuntimeCall = async (method, path, body) => {
    const response = await fetch(`${handle.url}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
    return { status: response.status, body: parsed };
  };
  try {
    return await work(call);
  } finally {
    await handle.close();
  }
}

const candidatePath = (importId: string, candidateId: string) =>
  `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`;

export type ImportPreviewOutcome = { ok: true; rowCount: number } | { ok: false; reason: string };

/** Run one draft's preview, as the Import SQL page does after making the drafts. */
export async function previewImportCandidate(call: ImportRuntimeCall, importId: string, candidateId: string): Promise<ImportPreviewOutcome> {
  const response = await call('POST', `${candidatePath(importId, candidateId)}/preview`, {});
  if (response.status !== 200) return { ok: false, reason: plainImportFailure(String(response.body?.error ?? `HTTP ${response.status}`)) };
  const result = response.body?.preview?.result;
  return { ok: true, rowCount: Number(result?.rowCount ?? result?.rows?.length ?? 0) };
}

export type ImportCertifyOutcome = { ok: true; path: string } | { ok: false; reason: string };

/** Certify one draft through the page's Certify: the checks, then the certified file and its receipt. */
export async function certifyImportCandidate(call: ImportRuntimeCall, importId: string, candidateId: string): Promise<ImportCertifyOutcome> {
  const response = await call('POST', `${candidatePath(importId, candidateId)}/certify`, {});
  if (response.status === 200) return { ok: true, path: String(response.body?.candidate?.savedPath ?? '') };
  // The blockers carry the database's own words; the error is the issues' titles.
  const blockers: string[] = Array.isArray(response.body?.blockers) ? response.body.blockers.map(String) : [];
  return { ok: false, reason: plainImportFailure(blockers.join(' ') || String(response.body?.error ?? `HTTP ${response.status}`)) };
}

/**
 * A short reason a draft did not run or certify, so a list of hundreds groups
 * into a few kinds of fix.
 */
export function plainImportFailure(message: string): string {
  // The database's own message, without the echoed SQL after "LINE n:".
  const text = message.replace(/\s+/g, ' ').replace(/\s+LINE \d+:.*$/i, '').trim();
  const required = /Provide required parameters?: ([^.]+)/i.exec(text);
  if (required) return `Needs a default value: ${required[1].trim()}.`;
  const missingTable = /Table with name ([\w.#"]+) does not exist|relation "?([\w.]+)"? does not exist|Object '([^']+)' does not exist|Invalid object name '([^']+)'/i.exec(text);
  if (missingTable) return `Reads a table this connection does not have: ${(missingTable[1] ?? missingTable[2] ?? missingTable[3] ?? missingTable[4]).replace(/"/g, '')}.`;
  if (/Parser Error|syntax error/i.test(text)) return `Does not parse on this connection: ${firstSentence(text.replace(/^.*?(?:Parser Error:\s*)?(syntax error)/i, '$1'))}`;
  if (/Binder Error|column .* (?:not found|does not exist)|ambiguous/i.test(text)) return `Column problem: ${firstSentence(text.replace(/^.*?Binder Error:\s*/i, ''))}`;
  if (/only supports read-only SELECT or WITH/i.test(text)) return 'Not one read-only SELECT or WITH query.';
  return firstSentence(text);
}

/** The kind of fix a reason from {@link plainImportFailure} needs, to count a long list by kind. */
export function importFailureKind(reason: string): string {
  const colon = reason.indexOf(': ');
  return colon > 0 && colon < 60 ? reason.slice(0, colon) : reason;
}

function firstSentence(text: string): string {
  const sentence = /^(.{1,180}?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text.slice(0, 180);
  return sentence.endsWith('.') || sentence.endsWith('!') || sentence.endsWith('?') ? sentence : `${sentence}.`;
}
