import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_EGRESS_REPOSITORY_ERROR, pullCachedRepo, resolveRepoSource } from './repo-resolver.js';

afterEach(() => vi.unstubAllEnvs());

describe('reading a semantic layer from a Git repository', () => {
  it('clones and pulls nothing on an install with no internet access (ZLENS_NO_EGRESS)', () => {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    expect(() => resolveRepoSource({ provider: 'dbt', source: 'github', repoUrl: 'https://github.com/org/analytics.git' }, '/tmp/project'))
      .toThrow(NO_EGRESS_REPOSITORY_ERROR);
    expect(() => pullCachedRepo('https://github.com/org/analytics.git')).toThrow(NO_EGRESS_REPOSITORY_ERROR);
  });

  it('still reads a local project folder without internet access', () => {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    expect(resolveRepoSource({ provider: 'dbt', projectPath: 'analytics' }, '/tmp/project')).toEqual({ localPath: '/tmp/project/analytics', freshClone: false, warnings: [] });
  });
});
