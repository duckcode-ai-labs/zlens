import type { IncomingHttpHeaders } from 'node:http';
import { readEnv } from '@zlens/core';
import { brandedPage } from './brand-page.js';

/**
 * The ZLens app for Snowflake, set up from Snowsight instead of SQL. The admin types the one person
 * the free app serves on the app's Configurations tab (an application configuration value), and
 * grants the app a database. ZLens reads both while it runs, so neither needs a restart:
 *
 * - the person: `SYS_CONTEXT('SNOWFLAKE$APPLICATION', 'GET_CONFIGURATION_VALUE', <name>)`, which the
 *   container's own session may read (checked live 2026-11-09); an unset value raises an error, read
 *   here as "not set yet";
 * - the data: the databases the app can see (`SHOW DATABASES` as the app lists only those granted to
 *   it, plus the app's own), used when exactly one is granted.
 *
 * On only with ZLENS_SNOWFLAKE_APP_SETTINGS=1 inside a Snowflake container (the ingress mode is on).
 */
export interface SnowflakeAppSettingsOptions {
  /** The application configuration that names the person (ZLENS_SNOWFLAKE_APP_USER_CONFIGURATION, default ZLENS_USER). */
  userConfiguration: string;
  /** The app's own database (the installed app's name), never offered as data. */
  appName?: string;
  /** How long a read is reused, in ms. */
  ttlMs?: number;
}

export interface SnowflakeAppState {
  /** The one person the free app serves; null until the admin sets it. */
  user: string | null;
  /** Databases granted to the app (its own and Snowflake's left out), sorted. */
  databases: string[];
}

export type SnowflakeAppQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

const NOT_SET = /has not been set/i;
/** Databases every account shows that are not the customer's data. */
const NOT_DATA = new Set(['SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA', 'SNOWFLAKE_LEARNING_DB']);

export function snowflakeAppSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SnowflakeAppSettingsOptions | undefined {
  if (!/^(1|true|on|yes)$/i.test(readEnv('ZLENS_SNOWFLAKE_APP_SETTINGS', env)?.trim() ?? '')) return undefined;
  const userConfiguration = readEnv('ZLENS_SNOWFLAKE_APP_USER_CONFIGURATION', env)?.trim() || 'ZLENS_USER';
  const appName = readEnv('ZLENS_SNOWFLAKE_APP_NAME', env)?.trim() || undefined;
  return { userConfiguration, appName };
}

/** An identifier Snowflake would accept unquoted in a configuration name, so it can sit in a string literal safely. */
function plainName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Not a configuration name: ${name}`);
  return name.toUpperCase();
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  if (!row) return undefined;
  const key = Object.keys(row)[0];
  return key === undefined ? undefined : row[key];
}

export async function readAppUser(query: SnowflakeAppQuery, configuration: string): Promise<string | null> {
  try {
    const rows = await query(`SELECT SYS_CONTEXT('SNOWFLAKE$APPLICATION', 'GET_CONFIGURATION_VALUE', '${plainName(configuration)}') AS V`);
    const value = firstValue(rows[0]);
    const user = typeof value === 'string' ? value.trim() : '';
    return user ? user.toUpperCase() : null;
  } catch (error) {
    if (NOT_SET.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}

export async function readGrantedDatabases(query: SnowflakeAppQuery, appName?: string): Promise<string[]> {
  const rows = await query('SHOW TERSE DATABASES');
  const own = appName?.toUpperCase();
  // As the app, Snowflake also lists databases it reaches for other reasons (its own, an application
  // package, the image repository's database in a provider account): only ordinary databases in which
  // the app can see a table or view count as data granted to it (checked live 2026-11-09).
  const candidates = rows
    .filter((row) => !/^APPLICATION/i.test(String(row.kind ?? row.KIND ?? '')))
    .map((row) => String(row.name ?? row.NAME ?? '').trim())
    .filter((name) => name && name.toUpperCase() !== own && !NOT_DATA.has(name.toUpperCase()))
    .slice(0, 50);
  const quote = (part: string) => `"${part.replace(/"/g, '""')}"`;
  const readable: string[] = [];
  for (const name of candidates) {
    try {
      // Every database shows INFORMATION_SCHEMA's views to anyone who sees it: only the other schemas count.
      const schemas = (await query(`SHOW TERSE SCHEMAS IN DATABASE ${quote(name)}`))
        .map((row) => String(row.name ?? row.NAME ?? ''))
        .filter((schema) => schema && schema.toUpperCase() !== 'INFORMATION_SCHEMA')
        .slice(0, 20);
      for (const schema of schemas) {
        if ((await query(`SHOW TERSE OBJECTS IN SCHEMA ${quote(name)}.${quote(schema)} LIMIT 1`)).length > 0) {
          readable.push(name);
          break;
        }
      }
    } catch {
      // Not readable by the app: not data granted to it.
    }
  }
  return readable.sort((a, b) => a.localeCompare(b));
}

/** Reads the person and the granted databases, reusing a read for ttlMs; a failed read keeps the last good one. */
export class SnowflakeAppSettings {
  private last: { at: number; state: SnowflakeAppState } | undefined;
  private pending: Promise<SnowflakeAppState> | undefined;

  constructor(private readonly options: SnowflakeAppSettingsOptions, private readonly query: SnowflakeAppQuery, private readonly now: () => number = Date.now) {}

  async current(): Promise<SnowflakeAppState> {
    const ttl = this.options.ttlMs ?? 30_000;
    if (this.last && this.now() - this.last.at < ttl) return this.last.state;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const [user, databases] = await Promise.all([
          readAppUser(this.query, this.options.userConfiguration),
          readGrantedDatabases(this.query, this.options.appName),
        ]);
        const state = { user, databases };
        this.last = { at: this.now(), state };
        return state;
      } catch (error) {
        if (this.last) return this.last.state;
        throw error;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  /** Forget the last read, so the next request sees a change made a moment ago. */
  invalidate(): void {
    this.last = undefined;
  }
}

/**
 * The databases ZLens may read (onboarding design P6, decision D2): every one granted to the app. The first is
 * only the session's default (the database unqualified names resolve in): the current one while it is still
 * granted, else the first granted. Empty when nothing is granted.
 */
export function chooseDatabase(granted: string[], current: string | undefined): string[] {
  const kept = current ? granted.find((name) => name.toUpperCase() === current.toUpperCase()) : undefined;
  if (!kept) return [...granted];
  return [current!, ...granted.filter((name) => name.toUpperCase() !== current!.toUpperCase())];
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What a person sees while the app is not set up yet: plain steps for the admin, with the app's name filled in, in the ZLens brand. */
export function snowflakeAppSetupPage(input: { appName?: string; needsUser: boolean; databases: string[] }): string {
  const app = input.appName ?? '<this app>';
  const steps: string[] = [];
  if (input.needsUser) {
    steps.push(`<li><strong>Who uses ZLens.</strong> In Snowsight, open <em>Apps</em> in the left menu, then <em>${escapeHtml(app)}</em>, then its <em>Configurations</em> tab. Pick a warehouse at the top of the page first (Snowsight needs one to save), then <em>Review</em>, enter the Snowflake user name of the person who will use ZLens, and <em>Save</em>.</li>`);
  }
  if (input.databases.length === 0) {
    const grants = [
      `GRANT USAGE ON DATABASE MY_DB TO APPLICATION ${app};`,
      `GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
      `GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
    ];
    steps.push(`<li><strong>What ZLens may read.</strong> Run this in a worksheet, with your database and schema in place of MY_DB and MY_SCHEMA. Select all the lines, then press <em>Run</em>: Snowsight&#39;s Run on its own runs only the statement at the cursor.<pre>${escapeHtml(grants.join('\n'))}</pre></li>`);
  }
  const left = steps.length === 1 ? 'One step is left' : `${steps.length} steps are left`;
  return brandedPage({
    title: 'ZLens: almost ready',
    body: `<h1>ZLens is almost ready</h1><p><span class="dot"></span>ZLens is running in your Snowflake account. ${left} for your Snowflake admin:</p><ol>${steps.join('')}</ol><p>Then reload this page. ZLens picks the changes up within a minute, without a restart.</p>`,
  });
}

/**
 * Requests that are not someone using ZLens, so they neither restart the idle clock nor hold ZLens up:
 * - Snowflake's readiness probe (`/api/health`);
 * - an open page's event streams (`/api/operations/events`, `/api/watch`), which stay open as long as the tab;
 * - what an open page asks for by itself once the person has not touched it for a while: the page marks those
 *   `x-dql-background: 1` (api/server-auth.ts in the notebook; polls, refreshes, reconnects).
 * The polls of a long request (`/api/long-requests/<id>`) always count: they follow work a person started.
 */
export const PAGE_EVENT_STREAMS: ReadonlySet<string> = new Set(['/api/operations/events', '/api/watch']);

export function countsAsUse(method: string | undefined, path: string, headers: IncomingHttpHeaders): boolean {
  if (path === '/api/health') return false;
  if ((method ?? 'GET').toUpperCase() === 'GET' && PAGE_EVENT_STREAMS.has(path)) return false;
  if (path.startsWith('/api/long-requests/')) return true;
  const background = headers['x-dql-background'];
  return (Array.isArray(background) ? background[0] : background)?.trim() !== '1';
}

/** Why ZLens is stopping, as the open pages are told (the `stopping` event on their event streams). */
export interface ZLensStoppingNotice {
  /** `idle`: ZLens stopped itself after the quiet spell; `stopped`: it was stopped (stop_app(), or Snowflake). */
  reason: 'idle' | 'stopped';
  /** For `idle`: the quiet spell, in minutes. */
  idleMinutes?: number;
}

/** The `stopping` event, as written on an open event stream. */
export function stoppingEventFrame(notice: ZLensStoppingNotice): string {
  return `event: stopping\ndata: ${JSON.stringify(notice)}\n\n`;
}

/** The part of `process` the stop signal is read from (a test passes its own). */
export type StopSignalSource = Pick<NodeJS.Process, 'prependListener' | 'removeListener' | 'listenerCount' | 'kill' | 'pid'>;

/**
 * When the process is told to stop (SIGTERM: `stop_app()`, which suspends the service, or Snowflake itself),
 * tell the open pages first, so none of them starts ZLens again by itself. It runs before the other SIGTERM
 * listeners (`zlens notebook` exits in its own), and when there is none the process still ends on SIGTERM as
 * it would have. Returns the function that removes it.
 */
export function tellPagesOnStopSignal(tell: () => void, source: StopSignalSource = process): () => void {
  const onSignal = () => {
    try { tell(); } catch { /* telling the pages must never keep the process up */ }
    if (source.listenerCount('SIGTERM') <= 1) {
      source.removeListener('SIGTERM', onSignal);
      source.kill(source.pid, 'SIGTERM');
    }
  };
  source.prependListener('SIGTERM', onSignal);
  return () => { source.removeListener('SIGTERM', onSignal); };
}

/** How long server work may hold ZLens up after the last time someone used it. */
export const IDLE_WORK_HOLD_MS = 6 * 60 * 60_000;

/**
 * Stops the app's own service after a quiet spell. Snowflake does not auto-suspend a service with a
 * public endpoint, but it wakes a stopped one when its address is opened (both checked live), so an
 * idle free app costs nothing until someone comes back.
 *
 * Only someone's requests count as use (see countsAsUse): an open tab nobody touches does not keep it up.
 * Server work a person started (a long request, an Ask run, a backup) holds it up while it runs, and the
 * quiet spell starts again when that work ends; a hold lasts at most IDLE_WORK_HOLD_MS after the last use,
 * so work that never ends cannot keep the service billing.
 */
export class IdleSuspender {
  /** The last request someone made. */
  private lastUse: number;
  /** The last use, or the last time server work was seen running: the quiet spell counts from here. */
  private lastActivity: number;
  private inFlight = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private suspending = false;
  private beforeSuspend: (() => Promise<void>) | undefined;
  private readonly holds: Array<() => boolean> = [];

  constructor(
    private readonly idleMs: number,
    private readonly suspend: () => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly maxHoldMs: number = IDLE_WORK_HOLD_MS,
  ) {
    this.lastUse = now();
    this.lastActivity = this.lastUse;
  }

  /** Someone's request started (see countsAsUse); call the returned function when it ends. */
  touch(): () => void {
    this.used();
    this.inFlight += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight -= 1;
      this.used();
    };
  }

  /** Server work that keeps ZLens up while it says so. */
  holdWhile(working: () => boolean): void {
    this.holds.push(working);
  }

  private used(): void {
    this.lastUse = this.now();
    this.lastActivity = this.lastUse;
  }

  private working(): boolean {
    if (this.now() - this.lastUse >= this.maxHoldMs) return false;
    return this.holds.some((working) => {
      try { return working(); } catch { return false; }
    });
  }

  /** Whether the service should stop now. */
  due(): boolean {
    return !this.suspending && this.inFlight === 0 && !this.working() && this.now() - this.lastActivity >= this.idleMs;
  }

  /** Work to do just before stopping (the daily backup). Someone coming back meanwhile keeps ZLens running. */
  onBeforeSuspend(work: () => Promise<void>): void {
    this.beforeSuspend = work;
  }

  async check(): Promise<boolean> {
    if (!this.suspending && this.working()) this.lastActivity = this.now();
    if (!this.due()) return false;
    this.suspending = true;
    try {
      if (this.beforeSuspend) {
        try {
          await this.beforeSuspend();
        } catch (error) {
          console.warn(`[zlens] Before stopping: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (this.inFlight > 0 || this.working() || this.now() - this.lastActivity < this.idleMs) {
          this.suspending = false;
          return false;
        }
      }
      await this.suspend();
      return true;
    } catch (error) {
      this.suspending = false;
      this.lastActivity = this.now();
      console.warn(`[zlens] Could not stop this idle service: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => { void this.check(); }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function idleSuspendFromEnv(env: NodeJS.ProcessEnv = process.env): { minutes: number; service: string } | undefined {
  const minutes = Number(readEnv('ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES', env)?.trim() ?? '');
  const service = readEnv('ZLENS_SNOWFLAKE_SERVICE', env)?.trim() ?? '';
  if (!Number.isFinite(minutes) || minutes <= 0 || !/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){2}$/.test(service)) return undefined;
  return { minutes, service };
}
