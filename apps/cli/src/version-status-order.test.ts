import { describe, expect, it, vi } from 'vitest';
import { fetchLatestPublishedDqlVersion, isNewerDqlVersion } from './version-status.js';

describe('isNewerDqlVersion', () => {
  it('orders release versions numerically', () => {
    expect(isNewerDqlVersion('1.17.3', '1.17.2')).toBe(true);
    expect(isNewerDqlVersion('1.17.10', '1.17.9')).toBe(true);
    expect(isNewerDqlVersion('2.0.0', '1.99.99')).toBe(true);
  });

  it('does not call an older or equal published version newer (a build ahead of npm is not drift)', () => {
    expect(isNewerDqlVersion('1.17.2', '1.17.3')).toBe(false);
    expect(isNewerDqlVersion('1.17.3', '1.17.3')).toBe(false);
  });

  it('ranks a release above its prereleases and orders prerelease identifiers', () => {
    expect(isNewerDqlVersion('1.18.0', '1.18.0-rc.1')).toBe(true);
    expect(isNewerDqlVersion('1.18.0-rc.1', '1.18.0')).toBe(false);
    expect(isNewerDqlVersion('1.18.0-rc.10', '1.18.0-rc.2')).toBe(true);
    expect(isNewerDqlVersion('1.18.0-rc.1', '1.17.3')).toBe(true);
  });

  it('falls back to inequality for unparseable versions', () => {
    expect(isNewerDqlVersion('nightly', '1.17.3')).toBe(true);
    expect(isNewerDqlVersion('nightly', 'nightly')).toBe(false);
  });
});

describe('the update check on an install with no internet access', () => {
  it('asks npm nothing when ZLENS_NO_EGRESS=1', async () => {
    vi.stubEnv('ZLENS_DISABLE_VERSION_CHECK', '');
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await fetchLatestPublishedDqlVersion()).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
