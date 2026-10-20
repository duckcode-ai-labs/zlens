/**
 * Links to an App page (RFC 0008 step 10). `?app=<id>&page=<id>` opens that
 * page in the reader; the address bar carries it while the page is open, so
 * copying the URL shares the page. Pure: no React, no I/O.
 */

export interface AppPageLink {
  appId: string;
  pageId: string | null;
}

const APP_PARAM = 'app';
const PAGE_PARAM = 'page';

export function readAppPageLink(href: string): AppPageLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const appId = url.searchParams.get(APP_PARAM)?.trim();
  if (!appId) return null;
  const pageId = url.searchParams.get(PAGE_PARAM)?.trim() || null;
  return { appId, pageId };
}

const DRAFT_PARAM = 'appDraft';

/**
 * `?appDraft=<id>` opens that local App Studio draft. MCP `build_dql_app`
 * returns this link; App Studio then starts at the AI Data step.
 */
export function readAppDraftLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const draftId = url.searchParams.get(DRAFT_PARAM)?.trim() ?? '';
  return /^[a-z0-9_:-]{1,128}$/i.test(draftId) ? draftId : null;
}

/** The href without the draft link, so a reload does not reopen the draft. */
export function withoutAppDraftLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(DRAFT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The href with this page's link set, or with the link removed when `link` is null. */
export function withAppPageLink(href: string, link: AppPageLink | null): string {
  const url = new URL(href);
  url.searchParams.delete(APP_PARAM);
  url.searchParams.delete(PAGE_PARAM);
  if (link) {
    url.searchParams.set(APP_PARAM, link.appId);
    if (link.pageId) url.searchParams.set(PAGE_PARAM, link.pageId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A full link to a page on one origin. On a server shared over the network
 * the access token rides in the fragment, which browsers never send to a
 * server, exactly like the links `zlens notebook` prints.
 */
export function appPageUrl(origin: string, link: AppPageLink, token?: string): string {
  const base = origin.replace(/\/$/, '');
  const path = withAppPageLink(`${base}/`, link);
  return `${base}${path}${token ? `#dql_token=${encodeURIComponent(token)}` : ''}`;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** Whether an origin can only be opened on this computer. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}
