import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import * as yaml from 'js-yaml';
import { loadDomainPackageRegistry, type DomainPackageRegistryResult } from '../manifest/domain-package-registry.js';

/**
 * Whether a certified block is still the source that was certified.
 *
 * The explicit Certify action writes a receipt into the block's companion YAML
 * (`semantic-layer/blocks/<domain>/<slug>.yaml`) that holds `sourceSha256`,
 * the fingerprint of the `.dql` it certified. Saving through ZLens never keeps
 * an edited block certified, but an edit made outside ZLens (an editor, a
 * merge, a script) would; comparing the receipt with the file on disk is how
 * such an edit is noticed.
 */

/** The fingerprint a certification receipt records for a `.dql` source. */
export function certifiedSourceSha256(source: string): string {
  return createHash('sha256').update(source.trimEnd() + '\n').digest('hex');
}

/**
 * - `matches`: the source is the one the receipt certified.
 * - `changed`: the source was edited after it was certified.
 * - `no_receipt`: there is no receipt fingerprint to compare with (no companion
 *   YAML, no receipt, or a block certified before receipts were recorded).
 */
export type CertifiedSourceState = 'matches' | 'changed' | 'no_receipt';

/** The `certification.sourceSha256` a companion YAML holds, or null when it holds none. */
export function receiptSourceSha256(companion: string | null | undefined): string | null {
  if (!companion) return null;
  try {
    const parsed = yaml.load(companion) as { certification?: { sourceSha256?: unknown } } | null;
    const sha = parsed?.certification?.sourceSha256;
    return typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha.trim()) ? sha.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Compare a `.dql` source with the fingerprint its certification receipt recorded. */
export function certifiedSourceState(source: string, companion: string | null | undefined): CertifiedSourceState {
  const recorded = receiptSourceSha256(companion);
  if (!recorded) return 'no_receipt';
  // A checkout that turned line endings into CRLF has not changed the block.
  if (certifiedSourceSha256(source) === recorded) return 'matches';
  return certifiedSourceSha256(source.replace(/\r\n/g, '\n')) === recorded ? 'matches' : 'changed';
}

const PRIVATE_BLOCK_PREFIX = '.dql/local/private/blocks';
const PRIVATE_BLOCK_COMPANION_PREFIX = '.dql/local/private/semantic-layer/blocks';

/**
 * The project-relative companion YAML of a block file, or null when the path
 * is not a block path. `domains/<pkg>/blocks/<path>.dql` maps to
 * `semantic-layer/blocks/<package id>/<path>.yaml` (drafts under `_drafts/<package id>/`),
 * `blocks/<path>.dql` to `semantic-layer/blocks/<path>.yaml`, and a private
 * block to its private companion.
 */
export function blockCompanionRelativePath(
  projectRoot: string,
  blockPath: string,
  registry?: Pick<DomainPackageRegistryResult, 'packageForPath'>,
): string | null {
  const normalized = normalize(blockPath).replace(/^\/+/, '').replaceAll('\\', '/');
  // The companion of a private block has to be private too, or the block hides
  // while its YAML announces it in tracked source.
  if (normalized.startsWith(`${PRIVATE_BLOCK_PREFIX}/`)) {
    const withoutRoot = normalized.slice(`${PRIVATE_BLOCK_PREFIX}/`.length).replace(/\.dql$/, '.yaml');
    return `${PRIVATE_BLOCK_COMPANION_PREFIX}/${withoutRoot}`;
  }
  if (normalized.startsWith('blocks/')) {
    const withoutRoot = normalized.slice('blocks/'.length).replace(/\.dql$/, '.yaml');
    return join('semantic-layer', 'blocks', withoutRoot).replaceAll('\\', '/');
  }
  if (normalized.startsWith('domains/')) {
    const pkg = (registry ?? loadDomainPackageRegistry(projectRoot)).packageForPath(join(projectRoot, normalized));
    const local = pkg ? relative(pkg.root, join(projectRoot, normalized)).replaceAll('\\', '/') : '';
    if (pkg && local.startsWith('blocks/') && local.endsWith('.dql')) {
      return companionForDomainBlock(pkg.id, local.slice('blocks/'.length));
    }
  }
  const domainFirst = normalized.match(/^domains\/([^/]+)\/blocks\/(.+)\.dql$/);
  if (domainFirst) return companionForDomainBlock(domainFirst[1]!, `${domainFirst[2]}.dql`);
  return null;
}

function companionForDomainBlock(domain: string, subpath: string): string {
  const blockPath = subpath.replace(/\.dql$/, '');
  const companionBlockPath = blockPath.startsWith('_drafts/')
    ? join('_drafts', domain, blockPath.slice('_drafts/'.length))
    : join(domain, blockPath);
  return join('semantic-layer', 'blocks', `${companionBlockPath}.yaml`).replaceAll('\\', '/');
}

/** {@link certifiedSourceState} for a block file, reading its companion YAML from the project. */
export function certifiedBlockFileState(
  projectRoot: string,
  blockPath: string,
  source: string,
  registry?: Pick<DomainPackageRegistryResult, 'packageForPath'>,
): { state: CertifiedSourceState; companionPath: string | null } {
  const companionPath = blockCompanionRelativePath(projectRoot, blockPath, registry);
  const absolute = companionPath ? join(projectRoot, companionPath) : null;
  let companion: string | null = null;
  try {
    companion = absolute && existsSync(absolute) ? readFileSync(absolute, 'utf-8') : null;
  } catch {
    companion = null;
  }
  return { state: certifiedSourceState(source, companion), companionPath };
}

/** The sentence every surface uses for a certified block edited after certification. */
export function changedSinceCertifiedMessage(blockName: string, companionPath: string | null): string {
  const receipt = companionPath ? `the certification receipt in ${companionPath}` : 'its certification receipt';
  return `certified saved query "${blockName}" was edited after it was certified: its source no longer matches ${receipt}. `
    + 'Ask treats it as needing recertification until it is certified again.';
}

/**
 * The record "Check and use" leaves in a block's companion YAML (`check:`):
 * ZLens checked the data (it compiles, runs, what one row is, number formats)
 * and the person added it, but nobody vouched for it yet. A checked block is
 * **Checked · Needs certifying**: tiles can use it while an App is edited, and
 * it never publishes under any data rule until someone certifies it. Like a
 * certification receipt it names the exact source it checked, so an edit made
 * afterwards makes it an ordinary block that needs review again.
 */
export interface BlockCheckRecord {
  /** Who ran the check: the host's signed-in person, else the local owner. */
  checkedBy: string;
  /** Their display name, when one is known. */
  checkedByName?: string;
  /** ISO-8601 time of the check. */
  checkedAt: string;
  /** sha256 of the checked `.dql` source ({@link certifiedSourceSha256}). */
  sourceSha256: string;
  /** What the check found, in plain words ("Row key: …", "Number formats: …"). */
  checks?: string[];
  /** Columns left out because another column holds the same number in other units. */
  hiddenColumns?: Array<{ column: string; keptColumn: string; reason: string }>;
}

/** The `check:` record a companion YAML holds, when it holds a valid one. */
export function readCompanionCheck(companion: string | null | undefined): BlockCheckRecord | null {
  if (!companion) return null;
  try {
    const parsed = yaml.load(companion) as { check?: Record<string, unknown> } | null;
    const record = parsed?.check;
    if (!record || typeof record !== 'object' || typeof record.checkedBy !== 'string') return null;
    const at = record.checkedAt as unknown;
    const sha = typeof record.sourceSha256 === 'string' ? record.sourceSha256.trim().toLowerCase() : '';
    if (at === undefined || !/^[0-9a-f]{64}$/.test(sha)) return null;
    const hidden = Array.isArray(record.hiddenColumns)
      ? record.hiddenColumns.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        return typeof item.column === 'string' && typeof item.keptColumn === 'string'
          ? [{ column: item.column, keptColumn: item.keptColumn, reason: typeof item.reason === 'string' ? item.reason : '' }]
          : [];
      })
      : [];
    return {
      checkedBy: record.checkedBy,
      ...(typeof record.checkedByName === 'string' && record.checkedByName.trim() ? { checkedByName: record.checkedByName.trim() } : {}),
      checkedAt: at instanceof Date ? at.toISOString() : String(at),
      sourceSha256: sha,
      ...(Array.isArray(record.checks) ? { checks: record.checks.map(String) } : {}),
      ...(hidden.length ? { hiddenColumns: hidden } : {}),
    };
  } catch {
    return null;
  }
}

/** The check record of a source, only while the source is still the one that was checked. */
export function currentCheckForSource(source: string, companion: string | null | undefined): BlockCheckRecord | null {
  const check = readCompanionCheck(companion);
  if (!check) return null;
  const matches = certifiedSourceSha256(source) === check.sourceSha256
    || certifiedSourceSha256(source.replace(/\r\n/g, '\n')) === check.sourceSha256;
  return matches ? check : null;
}

/** {@link currentCheckForSource} for a block file, reading its companion YAML; null when unreadable. */
export function currentBlockFileCheck(
  projectRoot: string,
  blockPath: string,
  source?: string,
  registry?: Pick<DomainPackageRegistryResult, 'packageForPath'>,
): BlockCheckRecord | null {
  try {
    const companionPath = blockCompanionRelativePath(projectRoot, blockPath, registry);
    if (!companionPath) return null;
    const absolute = join(projectRoot, companionPath);
    if (!existsSync(absolute)) return null;
    const text = source ?? readFileSync(join(projectRoot, normalize(blockPath).replace(/^\/+/, '')), 'utf-8');
    return currentCheckForSource(text, readFileSync(absolute, 'utf-8'));
  } catch {
    return null;
  }
}
