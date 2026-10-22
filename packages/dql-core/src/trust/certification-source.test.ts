import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockCompanionRelativePath,
  certifiedBlockFileState,
  certifiedSourceSha256,
  certifiedSourceState,
  currentBlockFileCheck,
  currentCheckForSource,
  readCompanionCheck,
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

describe('check records (design Q1: Checked · Needs certifying)', () => {
  const source = 'block "Orders" {\n  status = "review"\n}\n';
  const companion = (sha: string) => `name: Orders\nreviewStatus: review\ncheck:\n  checkedBy: kranthi@example.test\n  checkedByName: Kranthi\n  checkedAt: '2026-10-22T09:00:00.000Z'\n  sourceSha256: ${sha}\n  checks:\n    - 'Row key: each row is one order'\n  hiddenColumns:\n    - column: order_total\n      keptColumn: order_total_cents\n      reason: same number\n`;

  it('reads a check record and trusts it only for the source it checked', () => {
    const yaml = companion(certifiedSourceSha256(source));
    expect(readCompanionCheck(yaml)).toMatchObject({ checkedBy: 'kranthi@example.test', checkedByName: 'Kranthi', checks: ['Row key: each row is one order'], hiddenColumns: [{ column: 'order_total', keptColumn: 'order_total_cents', reason: 'same number' }] });
    expect(currentCheckForSource(source, yaml)).not.toBeNull();
    expect(currentCheckForSource(source.replace('review', 'draft'), yaml)).toBeNull();
    expect(readCompanionCheck('name: Orders\n')).toBeNull();
    expect(readCompanionCheck(companion('not-a-sha'))).toBeNull();
  });

  it('finds a block file\'s current check through its companion YAML', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-check-record-'));
    roots.push(root);
    mkdirSync(join(root, 'blocks'), { recursive: true });
    mkdirSync(join(root, 'semantic-layer', 'blocks'), { recursive: true });
    writeFileSync(join(root, 'blocks', 'orders.dql'), source);
    writeFileSync(join(root, 'semantic-layer', 'blocks', 'orders.yaml'), companion(certifiedSourceSha256(source)));
    expect(currentBlockFileCheck(root, 'blocks/orders.dql')?.checkedBy).toBe('kranthi@example.test');
    writeFileSync(join(root, 'blocks', 'orders.dql'), `${source}// edited\n`);
    expect(currentBlockFileCheck(root, 'blocks/orders.dql')).toBeNull();
  });
});
