import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCompanionCertification,
  blockCertificationByline,
  buildCertificationReceipt,
  certificationByline,
  gitUserName,
  bylineForViewer,
  isViewer,
  localPersonAliases,
  localPersonIdentity,
  localPersonSelf,
  personDisplayName,
  readCompanionCertification,
} from './certification-receipt.js';

/**
 * D5: every certification records who certified and when, with the person's
 * display name when one is known, so App surfaces can say "Certified by
 * <name> · <date>" and list the checks that passed.
 */
const roots: string[] = [];
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-certified-by-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SOURCE = 'block "Orders" {\n  domain = "commerce"\n  status = "certified"\n  query = """SELECT 1 AS n"""\n}\n';

describe('certification receipts record the certifier (D5)', () => {
  it('keeps the display name beside the identity and the time, and reads it back', () => {
    const receipt = buildCertificationReceipt({
      source: SOURCE,
      certifiedBy: 'maria@acme.com',
      certifiedByName: 'Maria Lopez',
      via: 'app-dataset',
      checks: ['Row key: each row is one order (order_id is filled and different on all 3 rows)', 'run', 'run'],
      now: new Date('2026-10-21T09:30:00.000Z'),
    });
    expect(receipt).toMatchObject({ certifiedBy: 'maria@acme.com', certifiedByName: 'Maria Lopez', certifiedAt: '2026-10-21T09:30:00.000Z', via: 'app-dataset', rules: 'oss' });
    expect(receipt.checks).toEqual(['Row key: each row is one order (order_id is filled and different on all 3 rows)', 'run']);
    const companion = applyCompanionCertification('name: Orders\n', 'certified', receipt);
    expect(readCompanionCertification(companion)).toEqual(receipt);
    expect(certificationByline(receipt)).toEqual({ by: 'maria@acme.com', name: 'Maria Lopez', at: '2026-10-21T09:30:00.000Z', checks: receipt.checks });
  });

  it('records no display name when none is known, and "local" when nobody is', () => {
    const anonymous = buildCertificationReceipt({ source: SOURCE, certifiedBy: undefined, via: 'cli' });
    expect(anonymous.certifiedBy).toBe('local');
    expect(anonymous).not.toHaveProperty('certifiedByName');
    expect(buildCertificationReceipt({ source: SOURCE, certifiedBy: 'kranthi', certifiedByName: 'kranthi', via: 'cli' })).not.toHaveProperty('certifiedByName');
  });

  it('reads who certified a block file from its companion: the receipt, {} for an old certification, null for a draft', () => {
    const root = project();
    mkdirSync(join(root, 'blocks/commerce'), { recursive: true });
    mkdirSync(join(root, 'semantic-layer/blocks/commerce'), { recursive: true });
    writeFileSync(join(root, 'blocks/commerce/orders.dql'), SOURCE);
    const receipt = buildCertificationReceipt({ source: SOURCE, certifiedBy: 'maria@acme.com', certifiedByName: 'Maria', via: 'block-studio', now: new Date('2026-10-21T00:00:00.000Z') });
    writeFileSync(join(root, 'semantic-layer/blocks/commerce/orders.yaml'), applyCompanionCertification('name: Orders\n', 'certified', receipt));
    expect(blockCertificationByline(root, 'blocks/commerce/orders.dql')).toEqual({ by: 'maria@acme.com', name: 'Maria', at: '2026-10-21T00:00:00.000Z' });

    writeFileSync(join(root, 'semantic-layer/blocks/commerce/orders.yaml'), 'name: Orders\nreviewStatus: certified\n');
    expect(blockCertificationByline(root, 'blocks/commerce/orders.dql')).toEqual({});

    writeFileSync(join(root, 'blocks/commerce/orders.dql'), SOURCE.replace('certified', 'draft'));
    expect(blockCertificationByline(root, 'blocks/commerce/orders.dql')).toBeNull();
    expect(blockCertificationByline(root, 'blocks/commerce/missing.dql')).toBeNull();
    expect(blockCertificationByline(root, undefined)).toBeNull();
  });

  it('takes the display name from git user.name', () => {
    const root = project();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kranthi K'], { cwd: root });
    expect(gitUserName(root)).toBe('Kranthi K');
  });
});

describe('one name for one person (phase-4 review: git name, noreply email and "Kranthi@local")', () => {
  it('reads every local spelling of this person as their display name, and anyone else as recorded', () => {
    const root = project();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', '232610070+someone@users.noreply.github.com'], { cwd: root });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ identity: { owner: 'analytics@jaffle.shop' } }));
    const previousUser = process.env.USER;
    process.env.USER = 'Kranthi';
    try {
      const person = { name: 'DuckCode AI Labs', aliases: localPersonAliases(root) };
      // The project's configured owner is someone else in a sample project (B6).
      expect(personDisplayName('analytics@jaffle.shop', person)).toBe('analytics@jaffle.shop');
      expect(personDisplayName('232610070+someone@users.noreply.github.com', person)).toBe('DuckCode AI Labs');
      expect(personDisplayName('Kranthi@local', person)).toBe('DuckCode AI Labs');
      expect(personDisplayName('maria@acme.com', person)).toBe('maria@acme.com');
      expect(personDisplayName('', person)).toBeUndefined();
      // Without a display name, the identity stays as recorded.
      expect(personDisplayName('Kranthi@local', { aliases: person.aliases })).toBe('Kranthi@local');
    } finally {
      if (previousUser === undefined) delete process.env.USER; else process.env.USER = previousUser;
    }
  });
});

describe('"by you" only for your own certifications (B6)', () => {
  it('the sample owner\'s certification is not the viewer\'s, and the viewer\'s own records their identity', () => {
    const root = project();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kranthi@example.test'], { cwd: root });
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ identity: { owner: 'analytics@jaffle.shop' } }));
    const previousUser = process.env.USER;
    process.env.USER = 'Kranthi';
    try {
      const self = localPersonSelf(root);
      expect([...self].sort()).toEqual(['kranthi@example.test', 'kranthi@local']);
      const person = { aliases: localPersonAliases(root), self };
      // The sample's certified saved query: certified by its own owner, not by whoever opens it.
      expect(isViewer('analytics@jaffle.shop', person)).toBe(false);
      expect(bylineForViewer({ by: 'analytics@jaffle.shop', at: '2026-10-16T00:00:00Z' }, person)).not.toHaveProperty('byYou');
      // A placeholder names nobody, so it is nobody's "you".
      expect(isViewer('local', person)).toBe(false);
      expect(isViewer('owner@local', person)).toBe(false);
      // The viewer's own certification, by git email or by $USER@local.
      expect(bylineForViewer<{ by: string; byYou?: boolean }>({ by: 'Kranthi@Example.test' }, person).byYou).toBe(true);
      expect(isViewer('Kranthi@local', person)).toBe(true);
      // A new certification records the person, never the configured owner.
      expect(localPersonIdentity(root)).toBe('kranthi@example.test');
    } finally {
      if (previousUser === undefined) delete process.env.USER; else process.env.USER = previousUser;
    }
  });
});
