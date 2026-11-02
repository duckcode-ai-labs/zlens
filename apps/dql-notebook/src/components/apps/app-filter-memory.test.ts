import { describe, expect, it } from 'vitest';
import {
  APP_FILTER_MEMORY_PERSON_KEY,
  APP_FILTER_MEMORY_PREFIX,
  appFilterMemoryKey,
  appFilterMemoryPersonToken,
  forgetAppFilterMemory,
  syncAppFilterMemoryPerson,
} from './app-filter-memory';
import { readPersistedAppFilterValues, writePersistedAppFilterValues } from './app-dashboard-filter-scope';

/** A localStorage stand-in with the parts the memory reads: get/set/remove, key(i) and length. */
function storageWith(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    keys: () => [...map.keys()].sort(),
  };
}

const vic = { id: 'u_vic' };
const wes = { id: 'u_wes' };
const west = JSON.stringify({ draft: { region: 'West' }, applied: { region: 'West' }, fingerprints: { region: 'fp' } });

describe('App filter memory is the signed-in person\'s (B7)', () => {
  it('without a host the key is the App alone, as before', () => {
    expect(appFilterMemoryKey('claims-weekly', null)).toBe('dql.apps.dashboard-filter-values.v1:claims-weekly');
    expect(appFilterMemoryKey('claims-weekly', undefined)).toBe('dql.apps.dashboard-filter-values.v1:claims-weekly');
    expect(appFilterMemoryKey('claims-weekly', { id: '' })).toBe('dql.apps.dashboard-filter-values.v1:claims-weekly');
  });

  it('under a host the key names the App and the person, by a stable token that is not the id or email', () => {
    const person = { id: 'vic@harbor.example' };
    const key = appFilterMemoryKey('claims-weekly', person);
    expect(key.startsWith(`${APP_FILTER_MEMORY_PREFIX}claims-weekly:p:`)).toBe(true);
    expect(key).not.toContain('vic');
    expect(key).not.toContain('@');
    expect(key).toBe(appFilterMemoryKey('claims-weekly', { id: 'vic@harbor.example' }));
    expect(key).not.toBe(appFilterMemoryKey('claims-weekly', wes));
    expect(key).not.toBe(appFilterMemoryKey('claims-monthly', person));
    expect(appFilterMemoryPersonToken('u_vic')).toMatch(/^[0-9a-f]{16}$/);
    expect(appFilterMemoryPersonToken('u_vic')).not.toBe(appFilterMemoryPersonToken('u_wes'));
  });

  it('one person\'s remembered filters are never read back for another on the same browser', () => {
    const storage = storageWith();
    writePersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', vic), {
      draft: { region: 'West' }, applied: { region: 'West' }, fingerprints: { region: 'fp' },
    });
    expect(readPersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', vic)).applied).toEqual({ region: 'West' });
    expect(readPersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', wes)).applied).toEqual({});
    // Nor for the hostless key, nor the other way round.
    expect(readPersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', null)).applied).toEqual({});
  });

  it('a different person signing in drops everything remembered, the hostless memory included', () => {
    const storage = storageWith({
      [appFilterMemoryKey('claims-weekly', vic)]: west,
      [appFilterMemoryKey('claims-weekly', null)]: west,
      [APP_FILTER_MEMORY_PERSON_KEY]: appFilterMemoryPersonToken(vic.id),
      'dql-theme': 'paper',
    });
    expect(syncAppFilterMemoryPerson(storage, wes)).toBe(true);
    expect(storage.keys()).toEqual([APP_FILTER_MEMORY_PERSON_KEY, 'dql-theme'].sort());
    expect(storage.getItem(APP_FILTER_MEMORY_PERSON_KEY)).toBe(appFilterMemoryPersonToken(wes.id));
    expect(storage.getItem('dql-theme')).toBe('paper');
    // Wes then opens Claims Weekly: nothing of Vic's comes back.
    expect(readPersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', wes))).toEqual({ draft: {}, applied: {}, fingerprints: {} });
  });

  it('the same person again keeps their own memory', () => {
    const storage = storageWith({
      [appFilterMemoryKey('claims-weekly', vic)]: west,
      [APP_FILTER_MEMORY_PERSON_KEY]: appFilterMemoryPersonToken(vic.id),
    });
    expect(syncAppFilterMemoryPerson(storage, vic)).toBe(false);
    expect(readPersistedAppFilterValues(storage, appFilterMemoryKey('claims-weekly', vic)).applied).toEqual({ region: 'West' });
  });

  it('the first person a host names on a browser with hostless memory starts clean, and is recorded', () => {
    const storage = storageWith({ [appFilterMemoryKey('claims-weekly', null)]: west });
    expect(syncAppFilterMemoryPerson(storage, vic)).toBe(true);
    expect(storage.keys()).toEqual([APP_FILTER_MEMORY_PERSON_KEY]);
    // An empty browser: nothing to drop, the person is still recorded.
    const empty = storageWith();
    expect(syncAppFilterMemoryPerson(empty, vic)).toBe(false);
    expect(empty.getItem(APP_FILTER_MEMORY_PERSON_KEY)).toBe(appFilterMemoryPersonToken(vic.id));
  });

  it('without a host nothing is recorded or dropped: one person per machine, as before', () => {
    const storage = storageWith({ [appFilterMemoryKey('claims-weekly', null)]: west, 'dql-theme': 'paper' });
    expect(syncAppFilterMemoryPerson(storage, null)).toBe(false);
    expect(syncAppFilterMemoryPerson(storage, undefined)).toBe(false);
    expect(storage.keys()).toEqual([appFilterMemoryKey('claims-weekly', null), 'dql-theme'].sort());
    expect(storage.getItem(APP_FILTER_MEMORY_PERSON_KEY)).toBeNull();
  });

  it('sign-out forgets every remembered App filter and whose they were, and nothing else', () => {
    const storage = storageWith({
      [appFilterMemoryKey('claims-weekly', vic)]: west,
      [appFilterMemoryKey('claims-monthly', vic)]: west,
      [appFilterMemoryKey('claims-weekly', null)]: west,
      [APP_FILTER_MEMORY_PERSON_KEY]: appFilterMemoryPersonToken(vic.id),
      'dql-theme': 'paper',
      'dql.apps.active-ai-build.v1': '{}',
    });
    const removed = forgetAppFilterMemory(storage);
    expect(removed).toHaveLength(4);
    expect(storage.keys()).toEqual(['dql-theme', 'dql.apps.active-ai-build.v1'].sort());
    expect(forgetAppFilterMemory(storage)).toEqual([]);
  });

  it('a storage that throws leaves the page running', () => {
    const broken = {
      length: 1,
      key: () => { throw new Error('blocked'); },
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(forgetAppFilterMemory(broken)).toEqual([]);
    expect(syncAppFilterMemoryPerson(broken, vic)).toBe(false);
  });
});
