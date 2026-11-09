import { existsSync } from 'node:fs';
import { readEnv } from '@zlens/core';

/**
 * ZLens running inside Snowflake (Snowpark Container Services, the ZLens app): Snowflake signs the
 * person in before a request reaches the container, and its ingress sets `Sf-Context-Current-User`
 * on every request. A client cannot forge it from outside: the ingress replaces it (checked live,
 * 2026-11-08). So there, the person is who that header says, and no shared ZLens token is needed.
 *
 * On only with ZLENS_SNOWFLAKE_INGRESS=1 AND Snowflake's own sign-in token file present (it exists
 * only inside a Snowflake container): anywhere else the header could come from anyone, so it is never
 * trusted there.
 */
export interface SnowflakeIngress {
  /** The one Snowflake user this ZLens serves (the free app); anyone else is refused. Unset: any signed-in user. */
  appUser?: string;
}

export const SNOWFLAKE_SESSION_TOKEN_FILE = '/snowflake/session/token';
export const SNOWFLAKE_USER_HEADER = 'sf-context-current-user';

export function snowflakeIngressFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  insideSnowflake: () => boolean = () => existsSync(SNOWFLAKE_SESSION_TOKEN_FILE),
): SnowflakeIngress | undefined {
  if (!/^(1|true|on|yes)$/i.test(readEnv('ZLENS_SNOWFLAKE_INGRESS', env)?.trim() ?? '')) return undefined;
  if (!insideSnowflake()) {
    console.warn('[zlens] ZLENS_SNOWFLAKE_INGRESS is set, but this is not a Snowflake container (no sign-in token file): ignored.');
    return undefined;
  }
  const appUser = readEnv('ZLENS_SNOWFLAKE_APP_USER', env)?.trim();
  return appUser ? { appUser } : {};
}

/** Why a request is refused, or undefined when the person may use this ZLens. */
export function snowflakeIngressRefusal(
  ingress: SnowflakeIngress,
  userHeader: string | string[] | undefined,
): { status: 401 | 403; error: string; code: string } | undefined {
  const user = (Array.isArray(userHeader) ? userHeader[0] : userHeader)?.trim();
  if (!user) {
    return { status: 401, error: 'Open ZLens through its Snowflake address: Snowflake signs you in there.', code: 'SNOWFLAKE_SIGN_IN_REQUIRED' };
  }
  if (ingress.appUser && user.toUpperCase() !== ingress.appUser.toUpperCase()) {
    return { status: 403, error: 'This ZLens app is set up for one person. Ask your Snowflake admin for access.', code: 'NOT_THIS_APPS_USER' };
  }
  return undefined;
}

/** A browser request from the page this server served: its Origin is the address the request came to. */
export function sameOriginAsHost(origin: string | undefined, host: string | string[] | undefined): boolean {
  const hostValue = (Array.isArray(host) ? host[0] : host)?.trim().toLowerCase();
  if (!origin || !hostValue) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.host.toLowerCase() === hostValue;
  } catch {
    return false;
  }
}

/** The page a refused person sees in the browser (the API answers in JSON). */
export function snowflakeIngressRefusalPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>ZLens</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head><body><h1>ZLens</h1><p>${safe}</p></body></html>`;
}
