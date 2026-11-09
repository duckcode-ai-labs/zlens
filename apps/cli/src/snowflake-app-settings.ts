import { readEnv } from '@zlens/core';

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

/** The database ZLens should read: the one granted (when there is exactly one), or the current one if still granted. */
export function chooseDatabase(granted: string[], current: string | undefined): string | undefined {
  if (current && granted.some((name) => name.toUpperCase() === current.toUpperCase())) return current;
  return granted.length === 1 ? granted[0] : undefined;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What a person sees while the app is not set up yet: plain steps for the admin, with the app's name filled in. */
export function snowflakeAppSetupPage(input: { appName?: string; needsUser: boolean; databases: string[] }): string {
  const app = input.appName ?? '<this app>';
  const steps: string[] = [];
  if (input.needsUser) {
    steps.push(`<li><strong>Who uses ZLens.</strong> In Snowsight, open <em>Catalog » Apps » ${escapeHtml(app)}</em>, then the <em>Configurations</em> tab, and enter the Snowflake user name of the person who will use ZLens.</li>`);
  }
  if (input.databases.length === 0) {
    const grants = [
      `GRANT USAGE ON DATABASE MY_DB TO APPLICATION ${app};`,
      `GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
      `GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
    ];
    steps.push(`<li><strong>What ZLens may read.</strong> Run this in a worksheet, with your database and schema in place of MY_DB and MY_SCHEMA:<pre>${escapeHtml(grants.join('\n'))}</pre></li>`);
  } else if (input.databases.length > 1) {
    steps.push(`<li><strong>One database.</strong> This app can see ${input.databases.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ')}. The free app reads one: revoke the others, or ask for the Team plan.</li>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>ZLens: almost ready</title><style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1rem;color:#222;line-height:1.5}pre{background:#f4f4f2;padding:.75rem;overflow-x:auto;font-size:.85rem}code{background:#f4f4f2;padding:0 .2rem}</style></head><body><h1>ZLens is almost ready</h1><p>Your Snowflake admin has one or two steps left:</p><ol>${steps.join('')}</ol><p>Then reload this page. ZLens picks the changes up within a minute, without a restart.</p></body></html>`;
}

/**
 * Stops the app's own service after a quiet spell. Snowflake does not auto-suspend a service with a
 * public endpoint, but it wakes a stopped one when its address is opened (both checked live), so an
 * idle free app costs nothing until someone comes back.
 */
export class IdleSuspender {
  private lastActivity: number;
  private inFlight = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private suspending = false;

  constructor(
    private readonly idleMs: number,
    private readonly suspend: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.lastActivity = now();
  }

  /** A request (other than Snowflake's readiness probe) started; call the returned function when it ends. */
  touch(): () => void {
    this.lastActivity = this.now();
    this.inFlight += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight -= 1;
      this.lastActivity = this.now();
    };
  }

  /** Whether the service should stop now. */
  due(): boolean {
    return !this.suspending && this.inFlight === 0 && this.now() - this.lastActivity >= this.idleMs;
  }

  async check(): Promise<boolean> {
    if (!this.due()) return false;
    this.suspending = true;
    try {
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
  }
}

export function idleSuspendFromEnv(env: NodeJS.ProcessEnv = process.env): { minutes: number; service: string } | undefined {
  const minutes = Number(readEnv('ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES', env)?.trim() ?? '');
  const service = readEnv('ZLENS_SNOWFLAKE_SERVICE', env)?.trim() ?? '';
  if (!Number.isFinite(minutes) || minutes <= 0 || !/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){2}$/.test(service)) return undefined;
  return { minutes, service };
}
