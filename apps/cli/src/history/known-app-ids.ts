import { resolve } from 'node:path';

/**
 * The App ids History knows (V3, the ZLens app for Snowflake): every App it keeps versions of, there now or
 * removed. A new App never takes one of them, so two Apps never share one History item (V15 retest: a new App took
 * the id of an App in History's trash and went on as its v3). History registers itself while it runs; without
 * History (open source, Enterprise) nothing is registered and nothing changes.
 */
const providers = new Map<string, () => Iterable<string>>();

/** Registers what History knows for a project; `null` takes it away (only when it is still `provider`). */
export function registerHistoryAppIds(projectRoot: string, provider: (() => Iterable<string>) | null, previous?: () => Iterable<string>): void {
  const key = resolve(projectRoot);
  if (provider) providers.set(key, provider);
  else if (!previous || providers.get(key) === previous) providers.delete(key);
}

/** The App ids History knows for a project; empty without History, or when it cannot say. */
export function historyAppIds(projectRoot: string): string[] {
  const provider = providers.get(resolve(projectRoot));
  if (!provider) return [];
  try {
    return [...provider()];
  } catch {
    return [];
  }
}
