/**
 * Pure helpers for connecting a project to Git from the UI (initialize a
 * repository, add a remote). The server is the authority on validation; these
 * only give immediate feedback before a request is sent.
 */

export const REMOTE_URL_EXAMPLES = 'https://github.com/org/repo.git, git@github.com:org/repo.git, or a local folder path';

/** Returns a plain-language problem with a pasted remote URL, or null when it looks usable. */
export function remoteUrlInputProblem(raw: string): string | null {
  const url = raw.trim();
  if (!url) return 'Enter the remote URL from your Git host.';
  if (/\s/.test(url)) return 'The remote URL cannot contain spaces.';
  if (url.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(url)) return 'That is not a remote URL.';
  if (/^http:\/\//i.test(url)) return 'Use the HTTPS or SSH address of the repository.';
  if (/^https:\/\/[^/@\s]*:[^/@\s]*@/i.test(url)) {
    return 'Remove the password or token from the URL. Use an SSH key or a Git credential helper instead.';
  }
  if (/^(?:https|ssh):\/\/[^/\s]+\/.+/i.test(url)) return null;
  if (/^file:\/\/.+/i.test(url)) return null;
  if (/^[A-Za-z0-9._~-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return null;
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || /^[A-Za-z]:[\\/]/.test(url)) return null;
  return `Use an address like ${REMOTE_URL_EXAMPLES}.`;
}

/** True when a push/share failed only because no remote is configured yet. */
export function isNoRemoteFailure(result: { ok: boolean; code?: string } | null | undefined): boolean {
  return Boolean(result && !result.ok && result.code === 'no_remote');
}

/** How often the Git page checks the remote while it is open (D3). */
export const BACKGROUND_FETCH_INTERVAL_MS = 5 * 60 * 1000;

export type RemoteCheck = { state: 'unknown' } | { state: 'ok' } | { state: 'unreachable'; message: string };

/** The header's one-line sync summary: what is new on the remote and what is not sent yet. */
export function syncSummary(input: { hasRemote: boolean; ahead: number; behind: number; check: RemoteCheck }): { text: string; tone: 'muted' | 'ok' | 'warning'; title?: string } {
  if (!input.hasRemote) return { text: 'no remote', tone: 'muted', title: 'No Git remote is configured. Changes stay on this computer.' };
  if (input.check.state === 'unreachable') return { text: "Can't reach the remote", tone: 'warning', title: input.check.message };
  const parts: string[] = [];
  if (input.behind > 0) parts.push(`${input.behind} new on the remote`);
  if (input.ahead > 0) parts.push(`${input.ahead} of yours not sent`);
  if (parts.length > 0) return { text: parts.join(' · '), tone: input.behind > 0 ? 'warning' : 'muted' };
  return input.check.state === 'ok' ? { text: 'Up to date', tone: 'ok' } : { text: 'Checking the remote…', tone: 'muted' };
}

/**
 * D4: sending from the base branch offers a new branch first. Only when the
 * remote already has that base branch: the first send to an empty repository
 * is what creates it.
 */
export function shouldOfferSendAsBranch(input: { branch: string | null; baseBranch?: string; baseOnRemote?: boolean }): boolean {
  if (!input.branch || input.branch === 'HEAD' || !input.baseOnRemote) return false;
  return input.branch === (input.baseBranch || 'main') || input.branch === 'main' || input.branch === 'master';
}

/** True when a send was refused because origin is the ZLens sample (D5). */
export function isSampleRemoteFailure(result: { ok: boolean; code?: string } | null | undefined): boolean {
  return Boolean(result && !result.ok && result.code === 'sample_remote');
}
