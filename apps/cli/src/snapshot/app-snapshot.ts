/**
 * Signed App snapshots (RFC 0008 step 10).
 *
 * A snapshot is one self-contained HTML file of a page as it was read: the
 * reader's rendering of a complete run, wrapped by the server in a document
 * with no scripts and a CSP that allows no network, plus a signed manifest.
 * The manifest binds the file's bytes to the run the server recorded: run
 * and result fingerprints, the page filters, and every bound figure as the
 * server computed it. Anyone with the file can check it offline with
 * `zlens app verify`; nothing is uploaded anywhere.
 *
 * The project key is Ed25519, created on first use in `.dql/local/private`
 * (never in git). Its public half is printed by `zlens app verify --key` and
 * travels in every snapshot so a verifier can pin it.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoryBindingCatalog } from '@zlens/core';

export const SNAPSHOT_SIGNATURE_PREFIX = '<!--dql-snapshot-signature:v1:';
export const MAX_SNAPSHOT_BODY_BYTES = 8 * 1024 * 1024;

export interface SnapshotManifest {
  version: 1;
  kind: 'dql-app-snapshot';
  app: { id: string; title: string };
  page: { id: string; title: string };
  run: { id: string; snapshotId: string; filterFingerprint: string; resultFingerprint: string };
  /** Page filters as the server applied them to this run. */
  filters: Array<{ id: string; label: string; value: string }>;
  /** Every bound figure the run returned, as the server computed it. */
  figures: Array<{ key: string; label: string; display: string; value: number | string | null }>;
  trust: { certified: number; total: number };
  createdAt: string;
  /** sha256 of the file's bytes before the signature comment. */
  contentSha256: string;
  key: { id: string; publicKey: string; algorithm: 'ed25519' };
  /** Who exported it, when a host named them (RFC 0010 HH-8). */
  signedBy?: string;
}

export interface SnapshotSignature {
  manifest: SnapshotManifest;
  /** Base64 Ed25519 signature over the canonical manifest JSON. */
  signature: string;
}

export interface SnapshotKey {
  id: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI DER, base64. */
  publicKeyBase64: string;
  publicKeyPem: string;
}

export function snapshotKeyPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'private', 'signing', 'app-snapshots-ed25519.pem');
}

/** The project's snapshot key, created on first use. */
export function loadOrCreateSnapshotKey(projectRoot: string): SnapshotKey {
  const path = snapshotKeyPath(projectRoot);
  let privateKey: KeyObject;
  if (existsSync(path)) {
    privateKey = createPrivateKey(readFileSync(path, 'utf-8'));
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort on filesystems without modes */ }
  }
  return describeKey(privateKey, createPublicKey(privateKey));
}

/** The project's public key without creating one. */
export function readSnapshotPublicKey(projectRoot: string): SnapshotKey | null {
  const path = snapshotKeyPath(projectRoot);
  if (!existsSync(path)) return null;
  const privateKey = createPrivateKey(readFileSync(path, 'utf-8'));
  return describeKey(privateKey, createPublicKey(privateKey));
}

function describeKey(privateKey: KeyObject, publicKey: KeyObject): SnapshotKey {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    id: snapshotKeyId(der),
    privateKey,
    publicKey,
    publicKeyBase64: der.toString('base64'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** A short, stable id for a public key: the first 16 hex of its SPKI sha256. */
export function snapshotKeyId(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

/** JSON with object keys sorted at every level, so signing is byte-stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

const esc = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * The reader's rendering is the page body. It is the author's own page, but
 * the snapshot is shared beyond this machine, so anything active is refused
 * here and the document's CSP blocks it again.
 */
export function snapshotBodyIssues(body: string): string[] {
  const issues: string[] = [];
  if (Buffer.byteLength(body, 'utf-8') > MAX_SNAPSHOT_BODY_BYTES) issues.push('The page is larger than 8 MB.');
  const checks: Array<[RegExp, string]> = [
    [/<\s*(script|iframe|frame|object|embed|link|meta|base|form|input|button|textarea|select)\b/i, 'active or external elements'],
    // Attribute checks look inside tags only, so prose such as "once = 1" is fine.
    [/<[a-z][^>]*\son[a-z]+\s*=/i, 'event handlers'],
    [/<[a-z][^>]*javascript\s*:/i, 'javascript: URLs'],
    [/<[a-z][^>]*\s(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, 'external links or images'],
    [/url\(\s*["']?\s*(?:https?:)?\/\//i, 'external CSS resources'],
    [/@import/i, 'CSS imports'],
    [/<!--\s*dql-snapshot-signature/i, 'a signature block'],
  ];
  for (const [pattern, label] of checks) if (pattern.test(body)) issues.push(`The page contains ${label}.`);
  return issues;
}

/** Theme variables from the reader, reduced to safe custom-property declarations. */
export function sanitizeThemeVariables(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  return Object.entries(raw as Record<string, unknown>)
    .filter(([name, value]) => /^--[a-z0-9-]{1,40}$/i.test(name) && typeof value === 'string' && value.length <= 120 && !/[;{}<>\\]|url\(/i.test(value))
    .slice(0, 40)
    .map(([name, value]) => `${name}:${value as string}`)
    .join(';');
}

export function snapshotFigures(catalog: StoryBindingCatalog | undefined): SnapshotManifest['figures'] {
  return Object.values(catalog ?? {})
    .map((binding) => ({ key: binding.key, label: binding.label, display: binding.display, value: binding.value ?? null }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

const SNAPSHOT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'";

const SNAPSHOT_STYLES = `
:root{--snap-ink:#1a1a1a;--snap-muted:#4a4a52;--snap-line:#e9e6e0;--snap-surface:#fff;--snap-page:#fbfaf7;--snap-accent:#0b7a75;--dql-ink:var(--snap-ink);--dql-muted:var(--snap-muted);--dql-line:var(--snap-line);--dql-surface:var(--snap-surface);--dql-accent:var(--snap-accent);--dql-accent-soft:rgba(11,122,117,.1);--dql-font:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;--dql-font-display:ui-serif,Georgia,'Times New Roman',serif}
*{box-sizing:border-box}
html,body{margin:0;background:var(--snap-page);color:var(--snap-ink)}
body{padding:24px clamp(16px,4vw,40px);font:400 14px/1.55 var(--dql-font);font-variant-numeric:tabular-nums}
.snap{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.snap-head{display:grid;gap:6px;padding-bottom:14px;border-bottom:1px solid var(--snap-line)}
.snap-app{margin:0;color:var(--snap-muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.snap-title{margin:0;font:600 24px/1.25 var(--dql-font)}
.snap-meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--snap-muted);font-size:12px}
.snap-meta strong{color:var(--snap-ink);font-weight:600}
.snap-trust{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--snap-line);border-radius:999px;background:var(--snap-surface);color:var(--snap-accent);font-weight:600}
.snap-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}
.snap-tile{min-width:0;padding:14px;border:1px solid var(--snap-line);border-radius:12px;background:var(--snap-surface);break-inside:avoid}
.snap-tile-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px}
.snap-tile-head h2{margin:0;font-size:13px;font-weight:600}
.snap-tile-trust{flex:none;color:var(--snap-muted);font-size:11px}
.snap-tile-trust.certified{color:var(--snap-accent)}
.snap-tile .dql-tile-title{display:none}
.dql-tile{margin:8px 0;padding:12px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface);overflow:hidden;break-inside:avoid}
.dql-tile .dql-tile-title{margin:0 0 8px;font-size:13px;font-weight:600}
.snap ol{margin:6px 0 0;padding-left:18px}
.dql-value.missing{color:var(--snap-muted)}
.dql-tile-kpi{font:600 32px/1.2 var(--dql-font)}
.snap svg{display:block;width:100%;height:auto}
.snap table{width:100%;border-collapse:collapse;font-size:12px}
.snap th,.snap td{padding:4px 8px;border-bottom:1px solid var(--snap-line);text-align:left}
.snap td.num{text-align:right}
.snap .dql-cf-tone{font-weight:600}.snap .dql-cf-tone.good{color:#0b7a75}.snap .dql-cf-tone.warning{color:#b26b1f}.snap .dql-cf-tone.bad{color:#c14545}
.snap .muted{color:var(--snap-muted);font-size:12px}
.snap-text{grid-column:1/-1;max-width:760px}
.snap-story{max-width:760px;display:grid;gap:14px;font-size:16px;line-height:1.65}
.snap-story p{margin:0}
.snap-story h3{margin:6px 0 0;font:600 20px/1.3 var(--dql-font-display)}
.dql-story-value,.dql-value{font-weight:600}
.snap-proof{display:grid;gap:8px;padding-top:14px;border-top:1px solid var(--snap-line);color:var(--snap-muted);font-size:12px}
.snap-proof code{font:12px/1.4 ui-monospace,'JetBrains Mono',Menlo,monospace;color:var(--snap-ink);word-break:break-all}
.snap-proof details summary{cursor:pointer;color:var(--snap-ink)}
.snap-proof table{margin-top:6px}
@media (max-width:720px){.snap-grid{grid-template-columns:1fr}.snap-grid>.snap-tile{grid-column:1/-1!important}}
@media print{html,body{background:#fff}body{padding:0}.snap-tile{border-color:#ddd}h1,h2,h3,figcaption{break-after:avoid}figure,.dql-tile,.snap-tile,tr{break-inside:avoid}@page{margin:14mm}}
`;

export interface SnapshotInput {
  appId: string;
  appTitle: string;
  pageId: string;
  pageTitle: string;
  run: SnapshotManifest['run'];
  filters: SnapshotManifest['filters'];
  figures: SnapshotManifest['figures'];
  trust: SnapshotManifest['trust'];
  /** The reader's rendering of the page, already checked by snapshotBodyIssues. */
  body: string;
  themeVariables?: string;
  createdAt?: string;
}

/** The unsigned document: header, the reader's page, and a human-readable proof footer. */
export function buildSnapshotDocument(input: SnapshotInput, key: Pick<SnapshotKey, 'id'>): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const when = new Date(createdAt).toUTCString().replace(' GMT', ' UTC');
  const filters = input.filters.length
    ? input.filters.map((filter) => `${esc(filter.label)}: <strong>${esc(filter.value)}</strong>`).join(' · ')
    : 'No page filters';
  const trust = input.trust.total
    ? input.trust.certified === input.trust.total
      ? 'All tiles certified'
      : `${input.trust.certified} of ${input.trust.total} tiles certified`
    : '';
  const figureRows = input.figures.slice(0, 400).map((figure) => (
    `<tr><td>${esc(figure.label)}</td><td class="num">${esc(figure.display)}</td><td><code>${esc(figure.key)}</code></td></tr>`
  )).join('');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="generator" content="DQL signed snapshot v1">',
    `<title>${esc(input.pageTitle)} · ${esc(input.appTitle)}</title>`,
    `<style>${SNAPSHOT_STYLES}${input.themeVariables ? `:root{${input.themeVariables}}` : ''}</style>`,
    '</head><body><div class="snap">',
    '<header class="snap-head">',
    `<p class="snap-app">${esc(input.appTitle)}</p>`,
    `<h1 class="snap-title">${esc(input.pageTitle)}</h1>`,
    `<div class="snap-meta"><span>Snapshot of ${esc(when)}</span><span>${filters}</span>${trust ? `<span class="snap-trust">${esc(trust)}</span>` : ''}</div>`,
    '</header>',
    `<div class="snap-body">${input.body}</div>`,
    '<footer class="snap-proof">',
    `<span>Signed by ZLens project key <code>${esc(key.id)}</code>. Every figure below was recorded by the ZLens server for run <code>${esc(input.run.id)}</code>; the signature covers this file's bytes and those figures.</span>`,
    '<span>Check it offline: <code>zlens app verify &lt;this file&gt;</code>. Editing the file breaks the signature.</span>',
    `<span>Result fingerprint <code>${esc(input.run.resultFingerprint)}</code></span>`,
    input.figures.length ? `<details><summary>${input.figures.length} recorded ${input.figures.length === 1 ? 'figure' : 'figures'}</summary><table><thead><tr><th>Figure</th><th>Value</th><th>Binding</th></tr></thead><tbody>${figureRows}</tbody></table></details>` : '',
    '</footer>',
    '</div></body></html>',
  ].join('\n');
}

/**
 * What signs snapshots (RFC 0010 HH-8): the project's local Ed25519 key by
 * default, or a host's key service (for example a cloud KMS or HSM key that
 * signs Ed25519) that never hands out the private key.
 */
export interface SnapshotSigner {
  id: string;
  /** SPKI DER, base64, of an Ed25519 public key. */
  publicKeyBase64: string;
  sign(data: Buffer): Promise<Buffer> | Buffer;
}

/** The project's local key as a signer. */
export function localSnapshotSigner(key: SnapshotKey): SnapshotSigner {
  return { id: key.id, publicKeyBase64: key.publicKeyBase64, sign: (data) => sign(null, data, key.privateKey) };
}

/** Sign a snapshot with any signer, naming who exported it when known. */
export async function signSnapshotWith(input: SnapshotInput & { signedBy?: string }, signer: SnapshotSigner): Promise<{ html: string; manifest: SnapshotManifest }> {
  const { manifest, document } = snapshotManifest(input, signer);
  const signature = Buffer.from(await signer.sign(Buffer.from(canonicalJson(manifest), 'utf-8'))).toString('base64');
  return sealSnapshot(document, manifest, signature);
}

function snapshotManifest(input: SnapshotInput & { signedBy?: string }, key: Pick<SnapshotSigner, 'id' | 'publicKeyBase64'>): { manifest: SnapshotManifest; document: string } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const document = buildSnapshotDocument({ ...input, createdAt }, key);
  const manifest: SnapshotManifest = {
    version: 1,
    kind: 'dql-app-snapshot',
    app: { id: input.appId, title: input.appTitle },
    page: { id: input.pageId, title: input.pageTitle },
    run: input.run,
    filters: input.filters,
    figures: input.figures,
    trust: input.trust,
    createdAt,
    contentSha256: createHash('sha256').update(document, 'utf-8').digest('hex'),
    key: { id: key.id, publicKey: key.publicKeyBase64, algorithm: 'ed25519' },
    ...(input.signedBy ? { signedBy: input.signedBy } : {}),
  };
  return { manifest, document };
}

function sealSnapshot(document: string, manifest: SnapshotManifest, signature: string): { html: string; manifest: SnapshotManifest } {
  const block: SnapshotSignature = { manifest, signature };
  return {
    html: `${document}\n${SNAPSHOT_SIGNATURE_PREFIX}${Buffer.from(JSON.stringify(block), 'utf-8').toString('base64')}-->\n`,
    manifest,
  };
}

/** Sign a snapshot document; the signature is appended as a trailing comment. */
export function signSnapshot(input: SnapshotInput, key: SnapshotKey): { html: string; manifest: SnapshotManifest } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const document = buildSnapshotDocument({ ...input, createdAt }, key);
  const manifest: SnapshotManifest = {
    version: 1,
    kind: 'dql-app-snapshot',
    app: { id: input.appId, title: input.appTitle },
    page: { id: input.pageId, title: input.pageTitle },
    run: input.run,
    filters: input.filters,
    figures: input.figures,
    trust: input.trust,
    createdAt,
    contentSha256: createHash('sha256').update(document, 'utf-8').digest('hex'),
    key: { id: key.id, publicKey: key.publicKeyBase64, algorithm: 'ed25519' },
  };
  const signature = sign(null, Buffer.from(canonicalJson(manifest), 'utf-8'), key.privateKey).toString('base64');
  const block: SnapshotSignature = { manifest, signature };
  return {
    html: `${document}\n${SNAPSHOT_SIGNATURE_PREFIX}${Buffer.from(JSON.stringify(block), 'utf-8').toString('base64')}-->\n`,
    manifest,
  };
}

export interface SnapshotVerification {
  ok: boolean;
  /** The file's bytes match the signed content hash. */
  contentIntact: boolean;
  /** The signature matches the manifest and the key it names. */
  signatureValid: boolean;
  /** Set when the caller pinned a key (a project key or --key). */
  trustedKey?: boolean;
  manifest?: SnapshotManifest;
  problems: string[];
}

/** Verify a snapshot file offline. `trustedPublicKeys` are SPKI DER base64 or PEM strings. */
export function verifySnapshot(html: string, trustedPublicKeys: string[] = []): SnapshotVerification {
  const problems: string[] = [];
  const at = html.lastIndexOf(`\n${SNAPSHOT_SIGNATURE_PREFIX}`);
  if (at < 0) return { ok: false, contentIntact: false, signatureValid: false, problems: ['This file has no DQL snapshot signature.'] };
  const content = html.slice(0, at);
  const tail = html.slice(at + 1 + SNAPSHOT_SIGNATURE_PREFIX.length);
  const end = tail.indexOf('-->');
  if (end < 0 || tail.slice(end + 3).trim() !== '') {
    return { ok: false, contentIntact: false, signatureValid: false, problems: ['The signature block is malformed or has content after it.'] };
  }
  let block: SnapshotSignature;
  try {
    block = JSON.parse(Buffer.from(tail.slice(0, end), 'base64').toString('utf-8')) as SnapshotSignature;
  } catch {
    return { ok: false, contentIntact: false, signatureValid: false, problems: ['The signature block cannot be read.'] };
  }
  const manifest = block?.manifest;
  if (!manifest || manifest.version !== 1 || manifest.kind !== 'dql-app-snapshot' || typeof block.signature !== 'string' || !manifest.key?.publicKey) {
    return { ok: false, contentIntact: false, signatureValid: false, problems: ['The signature block is not a DQL snapshot manifest.'] };
  }
  const contentIntact = createHash('sha256').update(content, 'utf-8').digest('hex') === manifest.contentSha256;
  if (!contentIntact) problems.push('The file was changed after it was signed.');
  let signatureValid = false;
  try {
    const der = Buffer.from(manifest.key.publicKey, 'base64');
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (snapshotKeyId(der) !== manifest.key.id) problems.push('The key id does not match the key.');
    else signatureValid = verify(null, Buffer.from(canonicalJson(manifest), 'utf-8'), publicKey, Buffer.from(block.signature, 'base64'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid && !problems.some((problem) => problem.startsWith('The key id'))) problems.push('The signature does not match the manifest.');
  let trustedKey: boolean | undefined;
  if (trustedPublicKeys.length) {
    const pinned = trustedPublicKeys.map((key) => {
      try {
        const object = key.includes('BEGIN PUBLIC KEY')
          ? createPublicKey(key)
          : createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
        return (object.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
      } catch {
        return '';
      }
    });
    trustedKey = pinned.includes(manifest.key.publicKey);
    if (!trustedKey) problems.push(`Signed by key ${manifest.key.id}, which is not a key you trust.`);
  }
  return { ok: contentIntact && signatureValid && trustedKey !== false, contentIntact, signatureValid, ...(trustedKey !== undefined ? { trustedKey } : {}), manifest, problems };
}

export function snapshotFileName(appId: string, pageId: string, createdAt: string): string {
  const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  return `${slug(appId)}-${slug(pageId)}-${createdAt.slice(0, 16).replace(/[-:T]/g, '')}.signed.html`;
}
