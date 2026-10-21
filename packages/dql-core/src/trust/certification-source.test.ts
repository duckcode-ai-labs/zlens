import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockCompanionRelativePath,
  certifiedBlockFileState,
  certifiedSourceSha256,
  certifiedSourceState,
} from './certification-source.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const source = 'block "Revenue" {\n  status = "certified"\n  owner = "analytics"\n  query = """SELECT 1 AS revenue"""\n}\n';
const companionFor = (sha: string) => `name: revenue\nreviewStatus: certified\ncertification:\n  certifiedBy: analytics\n  sourceSha256: ${sha}\n`;

describe('certifiedSourceState', () => {
  it('matches the source the receipt certified, ignoring trailing whitespace and CRLF line endings', () => {
    const companion = companionFor(certifiedSourceSha256(source));
    expect(certifiedSourceState(source, companion)).toBe('matches');
    expect(certifiedSourceState(`${source.trimEnd()}\n\n`, companion)).toBe('matches');
    expect(certifiedSourceState(source.replace(/\n/g, '\r\n'), companion)).toBe('matches');
  });

  it('reports an edit made after certification', () => {
    expect(certifiedSourceState(source.replace('SELECT 1', 'SELECT 2'), companionFor(certifiedSourceSha256(source)))).toBe('changed');
  });

  it('has nothing to compare without a receipt fingerprint', () => {
    expect(certifiedSourceState(source, null)).toBe('no_receipt');
    expect(certifiedSourceState(source, 'name: revenue\nreviewStatus: certified\n')).toBe('no_receipt');
    expect(certifiedSourceState(source, companionFor(''))).toBe('no_receipt');
    expect(certifiedSourceState(source, 'certification: [unclosed')).toBe('no_receipt');
  });
});

describe('blockCompanionRelativePath', () => {
  it('maps block files to their companion YAML', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-companion-path-'));
    roots.push(root);
    expect(blockCompanionRelativePath(root, 'blocks/commerce/revenue.dql')).toBe('semantic-layer/blocks/commerce/revenue.yaml');
    expect(blockCompanionRelativePath(root, 'domains/commerce/blocks/revenue.dql')).toBe('semantic-layer/blocks/commerce/revenue.yaml');
    expect(blockCompanionRelativePath(root, 'domains/commerce/blocks/_drafts/revenue.dql')).toBe('semantic-layer/blocks/_drafts/commerce/revenue.yaml');
    expect(blockCompanionRelativePath(root, '.dql/local/private/blocks/mine.dql')).toBe('.dql/local/private/semantic-layer/blocks/mine.yaml');
    expect(blockCompanionRelativePath(root, 'notebooks/x.dql')).toBeNull();
  });

  it('reads the companion of a block file from the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-companion-state-'));
    roots.push(root);
    mkdirSync(join(root, 'semantic-layer/blocks/commerce'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer/blocks/commerce/revenue.yaml'), companionFor(certifiedSourceSha256(source)));
    expect(certifiedBlockFileState(root, 'domains/commerce/blocks/revenue.dql', source)).toEqual({
      state: 'matches',
      companionPath: 'semantic-layer/blocks/commerce/revenue.yaml',
    });
    expect(certifiedBlockFileState(root, 'domains/commerce/blocks/other.dql', source).state).toBe('no_receipt');
  });
});
