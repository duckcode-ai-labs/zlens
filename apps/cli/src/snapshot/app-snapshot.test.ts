import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  loadOrCreateSnapshotKey,
  readSnapshotPublicKey,
  sanitizeThemeVariables,
  signSnapshot,
  snapshotBodyIssues,
  snapshotFileName,
  snapshotKeyPath,
  verifySnapshot,
  type SnapshotInput,
} from './app-snapshot.js';

const roots: string[] = [];
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-snapshot-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const input = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  appId: 'sales',
  appTitle: 'Sales <review>',
  pageId: 'overview',
  pageTitle: 'Overview',
  run: { id: 'run-1', snapshotId: 'snap-1', filterFingerprint: 'f-1', resultFingerprint: 'r-1' },
  filters: [{ id: 'region', label: 'Region', value: 'US' }],
  figures: [{ key: 'revenue.revenue', label: 'Revenue', display: '$1.2M', value: 1_200_000 }],
  trust: { certified: 3, total: 3 },
  body: '<section class="snap-grid"><article class="snap-tile"><div class="dql-tile-kpi">$1.2M</div></article></section>',
  createdAt: '2026-09-23T10:00:00.000Z',
  ...overrides,
});

describe('signed App snapshots', () => {
  it('creates one private project key and reuses it', () => {
    const root = project();
    expect(readSnapshotPublicKey(root)).toBeNull();
    const first = loadOrCreateSnapshotKey(root);
    const second = loadOrCreateSnapshotKey(root);
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshotKeyPath(root)).toContain(join('.dql', 'local', 'private'));
    if (process.platform !== 'win32') expect(statSync(snapshotKeyPath(root)).mode & 0o077).toBe(0);
  });

  it('signs a self-contained document that verifies offline', () => {
    const key = loadOrCreateSnapshotKey(project());
    const { html, manifest } = signSnapshot(input(), key);
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('Sales &lt;review&gt;');
    // The same words as the App's trust line (#168): no tile count when all are certified.
    expect(html).toContain('All tiles certified');
    expect(html).not.toContain('All 3 tiles certified');
    expect(manifest.figures[0]).toMatchObject({ key: 'revenue.revenue', display: '$1.2M' });
    const result = verifySnapshot(html);
    expect(result).toMatchObject({ ok: true, contentIntact: true, signatureValid: true });
    expect(verifySnapshot(html, [key.publicKeyPem]).trustedKey).toBe(true);
    expect(verifySnapshot(html, [key.publicKeyBase64]).ok).toBe(true);
  });

  it('fails when a single figure in the page is edited', () => {
    const { html } = signSnapshot(input(), loadOrCreateSnapshotKey(project()));
    const tampered = html.replace('<div class="dql-tile-kpi">$1.2M</div>', '<div class="dql-tile-kpi">$9.9M</div>');
    expect(tampered).not.toBe(html);
    const result = verifySnapshot(tampered);
    expect(result.ok).toBe(false);
    expect(result.contentIntact).toBe(false);
    expect(result.problems).toContain('The file was changed after it was signed.');
  });

  it('fails when the manifest is re-written with a new content hash', () => {
    const { html } = signSnapshot(input(), loadOrCreateSnapshotKey(project()));
    const at = html.lastIndexOf('<!--dql-snapshot-signature:v1:');
    const content = html.slice(0, at - 1).replace('$1.2M', '$9.9M');
    const block = JSON.parse(Buffer.from(html.slice(at + '<!--dql-snapshot-signature:v1:'.length, html.lastIndexOf('-->')), 'base64').toString('utf-8'));
    block.manifest.contentSha256 = createHash('sha256').update(content, 'utf-8').digest('hex');
    block.manifest.figures[0].display = '$9.9M';
    const forged = `${content}\n<!--dql-snapshot-signature:v1:${Buffer.from(JSON.stringify(block)).toString('base64')}-->\n`;
    const result = verifySnapshot(forged);
    expect(result.contentIntact).toBe(true);
    expect(result.signatureValid).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fails when a different key re-signs the file and a key is pinned', () => {
    const trusted = loadOrCreateSnapshotKey(project());
    const other = loadOrCreateSnapshotKey(project());
    const { html } = signSnapshot(input(), other);
    expect(verifySnapshot(html).ok).toBe(true);
    const pinned = verifySnapshot(html, [trusted.publicKeyPem]);
    expect(pinned.ok).toBe(false);
    expect(pinned.trustedKey).toBe(false);
    expect(pinned.problems.join(' ')).toContain(other.id);
  });

  it('refuses content appended after the signature and files without one', () => {
    const { html } = signSnapshot(input(), loadOrCreateSnapshotKey(project()));
    expect(verifySnapshot(`${html}<p>added</p>`).ok).toBe(false);
    expect(verifySnapshot('<html></html>').problems[0]).toContain('no DQL snapshot signature');
  });

  it('refuses active or external content in the page body', () => {
    expect(snapshotBodyIssues('<svg><rect width="4"/></svg><table><tr><td>1</td></tr></table>')).toEqual([]);
    expect(snapshotBodyIssues('<p>Paid once = on time; javascript: is a word here</p>')).toEqual([]);
    expect(snapshotBodyIssues('<script>alert(1)</script>')).not.toEqual([]);
    expect(snapshotBodyIssues('<div onclick="x()">')).not.toEqual([]);
    expect(snapshotBodyIssues('<img src="https://example.com/p.png">')).not.toEqual([]);
    expect(snapshotBodyIssues('<div style="background:url(//evil.test/x)">')).not.toEqual([]);
    expect(snapshotBodyIssues('<a href="javascript:alert(1)">')).not.toEqual([]);
    expect(snapshotBodyIssues('<!-- dql-snapshot-signature:v1:abc -->')).not.toEqual([]);
  });

  it('keeps only safe theme variables', () => {
    expect(sanitizeThemeVariables({ '--dql-ink': '#111', '--bad': 'red;}body{display:none', color: 'red', '--img': 'url(x)' })).toBe('--dql-ink:#111');
  });

  it('signs canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(snapshotFileName('sales app', 'over/view', '2026-09-23T10:05:00.000Z')).toBe('sales-app-over-view-202609231005.signed.html');
  });
});
