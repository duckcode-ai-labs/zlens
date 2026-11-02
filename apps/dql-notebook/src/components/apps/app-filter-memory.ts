/**
 * Where an App reader's last filters live in this browser, and whose they are.
 *
 * An App remembers the App-scoped filter values a reader chose and reopens
 * with them ("Opened with your last filters"). Under a host (RFC 0010 HH-9)
 * one browser may serve several signed-in people in turn, so the memory is
 * keyed by the person as well as the App, and the memory of one person is
 * dropped when a different person signs in or when the person signs out.
 * Without a host (one person per machine) the key is the App alone, as before.
 */

/** Every remembered App filter key starts with this; `forgetAppFilterMemory` removes them all. */
export const APP_FILTER_MEMORY_PREFIX = 'dql.apps.dashboard-filter-values.v1:';

/** Whose filters the keys under the prefix belong to (a token, never the id or email in clear). Deliberately outside the prefix. */
export const APP_FILTER_MEMORY_PERSON_KEY = 'dql.apps.dashboard-filter-memory.person.v1';

export interface AppFilterMemoryPerson { id: string }

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * A short, stable token for a person id. The key is only a label in this
 * browser's storage; the token keeps the host's id (which may be an email) out
 * of it. Two 32-bit FNV-1a digests with different seeds, as hex.
 */
export function appFilterMemoryPersonToken(personId: string): string {
  const digest = (seed: number): string => {
    let hash = seed >>> 0;
    for (let index = 0; index < personId.length; index += 1) {
      hash ^= personId.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${digest(0x811c9dc5)}${digest(0x050c5d1f)}`;
}

/** The storage key for one App's remembered filters: the App alone without a host, the App and the person under one. */
export function appFilterMemoryKey(appId: string, person: AppFilterMemoryPerson | null | undefined): string {
  if (!person || !person.id) return `${APP_FILTER_MEMORY_PREFIX}${appId}`;
  return `${APP_FILTER_MEMORY_PREFIX}${appId}:p:${appFilterMemoryPersonToken(person.id)}`;
}

/** Removes every remembered App filter (all keys under the prefix) and the record of whose they were. Nothing else. */
export function forgetAppFilterMemory(storage: MemoryStorage): string[] {
  const removed: string[] = [];
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key && key.startsWith(APP_FILTER_MEMORY_PREFIX)) {
        storage.removeItem(key);
        removed.push(key);
      }
    }
    if (storage.getItem(APP_FILTER_MEMORY_PERSON_KEY) !== null) {
      storage.removeItem(APP_FILTER_MEMORY_PERSON_KEY);
      removed.push(APP_FILTER_MEMORY_PERSON_KEY);
    }
  } catch {
    // Browser storage is a convenience: a page without it still runs.
  }
  return removed.sort();
}

/**
 * Makes the remembered filters in this browser the signed-in person's.
 * Under a host, a different person than the one recorded (or none recorded
 * while filters exist) drops everything remembered, then the person is
 * recorded. Without a host nothing is touched. Returns whether anything was
 * dropped.
 */
export function syncAppFilterMemoryPerson(storage: MemoryStorage, person: AppFilterMemoryPerson | null | undefined): boolean {
  if (!person || !person.id) return false;
  const token = appFilterMemoryPersonToken(person.id);
  try {
    const recorded = storage.getItem(APP_FILTER_MEMORY_PERSON_KEY);
    if (recorded === token) return false;
    let cleared = false;
    if (recorded !== null || hasAppFilterMemory(storage)) {
      forgetAppFilterMemory(storage);
      cleared = true;
    }
    storage.setItem(APP_FILTER_MEMORY_PERSON_KEY, token);
    return cleared;
  } catch {
    return false;
  }
}

function hasAppFilterMemory(storage: MemoryStorage): boolean {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(APP_FILTER_MEMORY_PREFIX)) return true;
  }
  return false;
}

/** The browser's storage, when the page has one. */
export function appFilterMemoryStorage(): MemoryStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}
