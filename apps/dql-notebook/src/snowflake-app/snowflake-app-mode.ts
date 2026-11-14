import { useSyncExternalStore } from 'react';

/**
 * The ZLens app for Snowflake: one person, inside their Snowflake account, with no Git, no dbt project
 * and no laptop. The server marks the page it serves there (`<meta name="zlens-snowflake-app"
 * content="1">`, before any script), so the app opens on Ask and leaves out the laptop's screens
 * (Source control, the CLI guide, keys kept in files) from its first paint. The setup check
 * (`/api/onboarding/launch` → `snowflakeAppManaged`) confirms it later, for a server that does not
 * mark the page. Everywhere else this is false and nothing changes.
 */
export function snowflakeAppPage(doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  try {
    return doc?.querySelector('meta[name="zlens-snowflake-app"]')?.getAttribute('content') === '1';
  } catch {
    return false;
  }
}

let snowflakeApp = snowflakeAppPage();
const listeners = new Set<() => void>();

/** Whether this is the ZLens app for Snowflake. */
export function isSnowflakeApp(): boolean {
  return snowflakeApp;
}

/** Set from the setup check (and by tests). */
export function setSnowflakeApp(value: boolean): void {
  if (snowflakeApp === value) return;
  snowflakeApp = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether this is the ZLens app for Snowflake, re-rendering if the setup check says so later. */
export function useSnowflakeApp(): boolean {
  return useSyncExternalStore(subscribe, isSnowflakeApp, isSnowflakeApp);
}
