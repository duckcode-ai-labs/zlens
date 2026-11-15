import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownersFromSignInOnly, persistOwner, readPersistedOwner, resolveLocalOwner, signedInOwnerOf, withSignedInOwner } from './identity.js';

describe('local owner identity (spec 14, part C)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-identity-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('always resolves a non-empty owner (guest@local fallback at worst)', () => {
    const owner = resolveLocalOwner(projectRoot, { persist: false });
    expect(owner).toBeTruthy();
    expect(owner.length).toBeGreaterThan(0);
  });

  it('prefers an explicit owner and persists it to dql.config.json identity.owner', () => {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    const owner = resolveLocalOwner(projectRoot, { explicit: 'alice@example.com' });
    expect(owner).toBe('alice@example.com');

    const config = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8'));
    expect(config.identity.owner).toBe('alice@example.com');
    // Existing fields are preserved by the merge.
    expect(config.project).toBe('p');
  });

  it('reads a persisted owner from dql.config.json before deriving from git/OS', () => {
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', identity: { owner: 'persisted@example.com' } }),
      'utf-8',
    );
    expect(readPersistedOwner(projectRoot)).toBe('persisted@example.com');
    expect(resolveLocalOwner(projectRoot, { persist: false })).toBe('persisted@example.com');
  });

  it('caches the owner under .dql/local/owner when no config file exists', () => {
    persistOwner(projectRoot, 'cached@example.com');
    expect(existsSync(join(projectRoot, '.dql', 'local', 'owner'))).toBe(true);
    expect(readPersistedOwner(projectRoot)).toBe('cached@example.com');
  });

  it('treats whitespace-only explicit owner as absent', () => {
    const owner = resolveLocalOwner(projectRoot, { explicit: '   ', persist: false });
    expect(owner).toBeTruthy();
    expect(owner.trim()).toBe(owner);
  });
});

describe('the owner where a host signs the person in (the app for Snowflake; V2, listing retake F4)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-identity-signed-in-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p', identity: { owner: 'zlens@local' } }), 'utf-8');
  });
  afterEach(() => {
    ownersFromSignInOnly(false);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('is the signed-in user, or nobody: never the machine or a persisted owner, and never persisted', () => {
    expect(withSignedInOwner('ANALYST', () => resolveLocalOwner(projectRoot))).toBe('ANALYST');
    expect(withSignedInOwner(' ', () => resolveLocalOwner(projectRoot))).toBe('');
    expect(withSignedInOwner(undefined, () => signedInOwnerOf())).toBe('');
    // A person's own choice still wins, and is not written to the project.
    expect(withSignedInOwner('ANALYST', () => resolveLocalOwner(projectRoot, { explicit: 'reviewer@example.com' }))).toBe('reviewer@example.com');
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')).identity.owner).toBe('zlens@local');
    // Outside the scope, as before.
    expect(signedInOwnerOf()).toBeUndefined();
    expect(resolveLocalOwner(projectRoot)).toBe('zlens@local');
  });

  it('work outside a request derives no owner while the host signs people in', () => {
    ownersFromSignInOnly(true);
    expect(resolveLocalOwner(projectRoot)).toBe('');
    expect(withSignedInOwner('ANALYST', () => resolveLocalOwner(projectRoot))).toBe('ANALYST');
    ownersFromSignInOnly(false);
    expect(resolveLocalOwner(projectRoot)).toBe('zlens@local');
  });
});
