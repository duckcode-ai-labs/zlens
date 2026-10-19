import { describe, expect, it } from 'vitest';
import { isNoRemoteFailure, isSampleRemoteFailure, remoteUrlInputProblem, shouldOfferSendAsBranch, syncSummary } from './git-connect';

describe('remoteUrlInputProblem', () => {
  it('accepts the addresses Git hosts hand out', () => {
    for (const url of [
      'https://github.com/acme/analytics.git',
      'ssh://git@gitlab.example.com/acme/analytics.git',
      'git@github.com:acme/analytics.git',
      '/srv/git/analytics.git',
      '../analytics.git',
      'file:///srv/git/analytics.git',
      'C:\\repos\\analytics.git',
      '  https://github.com/acme/analytics.git  ',
    ]) {
      expect(remoteUrlInputProblem(url), url).toBeNull();
    }
  });

  it('explains what is wrong with unusable input', () => {
    expect(remoteUrlInputProblem('')).toMatch(/Enter the remote URL/);
    expect(remoteUrlInputProblem('https://github.com/acme/a b.git')).toMatch(/spaces/);
    expect(remoteUrlInputProblem('ext::sh -c id')).not.toBeNull();
    expect(remoteUrlInputProblem('--upload-pack=id')).toMatch(/not a remote URL/);
    expect(remoteUrlInputProblem('http://github.com/acme/a.git')).toMatch(/HTTPS or SSH/);
    expect(remoteUrlInputProblem('https://me:ghp_token@github.com/acme/a.git')).toMatch(/password or token/);
    expect(remoteUrlInputProblem('github.com/acme/analytics')).toMatch(/Use an address like/);
  });
});

describe('isNoRemoteFailure', () => {
  it('recognizes only the server no_remote failure', () => {
    expect(isNoRemoteFailure({ ok: false, code: 'no_remote' })).toBe(true);
    expect(isNoRemoteFailure({ ok: false, code: 'push_failed' })).toBe(false);
    expect(isNoRemoteFailure({ ok: true, code: 'no_remote' })).toBe(false);
    expect(isNoRemoteFailure(null)).toBe(false);
  });
});

describe('syncSummary (D3)', () => {
  const ok = { state: 'ok' } as const;
  it('says what is new on the remote and what is not sent yet', () => {
    expect(syncSummary({ hasRemote: true, ahead: 1, behind: 3, check: ok })).toMatchObject({ text: '3 new on the remote · 1 of yours not sent', tone: 'warning' });
    expect(syncSummary({ hasRemote: true, ahead: 2, behind: 0, check: ok })).toMatchObject({ text: '2 of yours not sent', tone: 'muted' });
    expect(syncSummary({ hasRemote: true, ahead: 0, behind: 0, check: ok })).toMatchObject({ text: 'Up to date', tone: 'ok' });
  });
  it('says an update is waiting while conflicts are being resolved', () => {
    expect(syncSummary({ hasRemote: true, ahead: 0, behind: 0, check: ok, updating: true })).toMatchObject({ text: 'Update waiting for your choices', tone: 'warning' });
  });
  it('never claims up to date before the first check, and a failed check is a quiet note', () => {
    expect(syncSummary({ hasRemote: true, ahead: 0, behind: 0, check: { state: 'unknown' } }).text).toBe('Checking the remote…');
    expect(syncSummary({ hasRemote: true, ahead: 0, behind: 0, check: { state: 'unreachable', message: 'Git could not sign in to the remote.' } }))
      .toMatchObject({ text: "Can't reach the remote", tone: 'warning', title: 'Git could not sign in to the remote.' });
    expect(syncSummary({ hasRemote: false, ahead: 0, behind: 0, check: ok }).text).toBe('no remote');
  });
});

describe('shouldOfferSendAsBranch (D4)', () => {
  it('offers a new branch on the base branch once the remote has it', () => {
    expect(shouldOfferSendAsBranch({ branch: 'main', baseBranch: 'main', baseOnRemote: true })).toBe(true);
    expect(shouldOfferSendAsBranch({ branch: 'develop', baseBranch: 'develop', baseOnRemote: true })).toBe(true);
    expect(shouldOfferSendAsBranch({ branch: 'master', baseBranch: 'develop', baseOnRemote: true })).toBe(true);
  });
  it('sends directly from a feature branch, and on the first send to an empty repository', () => {
    expect(shouldOfferSendAsBranch({ branch: 'feature/x', baseBranch: 'main', baseOnRemote: true })).toBe(false);
    expect(shouldOfferSendAsBranch({ branch: 'main', baseBranch: 'main', baseOnRemote: false })).toBe(false);
    expect(shouldOfferSendAsBranch({ branch: 'HEAD', baseBranch: 'main', baseOnRemote: true })).toBe(false);
    expect(shouldOfferSendAsBranch({ branch: null, baseBranch: 'main', baseOnRemote: true })).toBe(false);
  });
});

describe('isSampleRemoteFailure (D5)', () => {
  it('recognises a send refused because origin is the ZLens sample', () => {
    expect(isSampleRemoteFailure({ ok: false, code: 'sample_remote' })).toBe(true);
    expect(isSampleRemoteFailure({ ok: false, code: 'push_failed' })).toBe(false);
    expect(isSampleRemoteFailure({ ok: true })).toBe(false);
  });
});
