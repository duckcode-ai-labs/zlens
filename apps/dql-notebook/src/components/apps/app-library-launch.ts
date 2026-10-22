export type AppLibraryLaunchPreference = 'auto' | 'expanded' | 'collapsed';

export function appLibraryLaunchExpanded(input: {
  preference: AppLibraryLaunchPreference;
  loading: boolean;
  appCount: number;
  localDraftCount: number;
}): boolean {
  if (input.preference === 'expanded') return true;
  if (input.preference === 'collapsed') return false;
  if (input.loading) return false;
  return input.appCount === 0 && input.localDraftCount === 0;
}

/**
 * "Finish setup · Build an App" opens the new App form, not just the library
 * (new-user round 2, problem 10). Setup leaves this note for the Apps
 * library, which opens the form once and removes it.
 */
export const BUILD_NEW_APP_HANDOFF_KEY = 'dql-build-new-app';
export const BUILD_NEW_APP_EVENT = 'dql:build-new-app';

type HandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): HandoffStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Ask the Apps library to open the new App form. */
export function requestBuildNewApp(storage: HandoffStorage | undefined = sessionStore()): void {
  try { storage?.setItem(BUILD_NEW_APP_HANDOFF_KEY, '1'); } catch { /* the form simply stays closed */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BUILD_NEW_APP_EVENT));
}

/** Whether the new App form was asked for; `consume` removes the note. */
export function buildNewAppRequested(options: { consume?: boolean; storage?: HandoffStorage } = {}): boolean {
  const storage = options.storage ?? sessionStore();
  try {
    const asked = storage?.getItem(BUILD_NEW_APP_HANDOFF_KEY) === '1';
    if (asked && options.consume) storage?.removeItem(BUILD_NEW_APP_HANDOFF_KEY);
    return asked;
  } catch {
    return false;
  }
}
