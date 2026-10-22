import { describe, expect, it } from 'vitest';
import { appLibraryLaunchExpanded, buildNewAppRequested, requestBuildNewApp } from './app-library-launch';

describe('App library launcher disclosure (UI-022, E2E-020)', () => {
  it('does not flash the launcher before both library sources finish loading', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: true,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(false);
  });

  it('expands by default only when the loaded library is empty', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(true);
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 1,
      localDraftCount: 0,
    })).toBe(false);
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 0,
      localDraftCount: 1,
    })).toBe(false);
  });

  it('preserves an explicit expand or collapse choice', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'expanded',
      loading: false,
      appCount: 2,
      localDraftCount: 1,
    })).toBe(true);
    expect(appLibraryLaunchExpanded({
      preference: 'collapsed',
      loading: false,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(false);
  });
});

describe('"Finish setup · Build an App" opens the new App form (new-user round 2, problem 10)', () => {
  it('leaves a note the library reads once, even when Apps already exist', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    expect(buildNewAppRequested({ storage })).toBe(false);
    requestBuildNewApp(storage);
    expect(buildNewAppRequested({ storage })).toBe(true);
    expect(buildNewAppRequested({ storage, consume: true })).toBe(true);
    expect(buildNewAppRequested({ storage })).toBe(false);
    // The library with Apps opens the form when asked.
    expect(appLibraryLaunchExpanded({ preference: 'expanded', loading: false, appCount: 2, localDraftCount: 1 })).toBe(true);
  });
});
