import { checkCortexAsk, type CortexAskReadiness, type CortexClaudeProvider } from '@zlens/agent';

/**
 * ASK READINESS, KEPT FOR THE SERVER (approved fix plan, risk 3 "Cortex setup blocks Ask", B3). Whether Ask's
 * Cortex is set up is checked with one tiny Cortex call (checkCortexAsk) when ZLens starts in Snowflake and when
 * a page first asks, kept for a few minutes, and checked again on demand ("Check again"). While Ask is not ready it
 * is also checked again every few minutes for an hour, so a grant an admin runs shows on the launcher and in Ask
 * without anyone pressing anything. A check that fails costs Snowflake nothing to speak of: the refusal comes
 * before any model runs.
 *
 * What a page reads (`GET /api/ask/readiness`, field `askReadiness`):
 * - `not_applicable`: Ask does not use Snowflake Cortex (another model, or none set up: Settings says so).
 * - `checking`: the first check has not answered yet.
 * - otherwise the check's result (CortexAskReadiness): `ready`, `missing_grant`, `region`, `model_unavailable` or
 *   `other`, with the headline, the plain-words message and the one line of SQL that fixes it.
 */
export type AskReadinessView =
  | { state: 'not_applicable' }
  | { state: 'checking'; headline: string }
  | CortexAskReadiness;

export interface AskReadinessOptions {
  /** The Cortex provider Ask uses now, or null when Ask does not use Cortex. */
  provider: () => Promise<CortexClaudeProvider | null> | CortexClaudeProvider | null;
  /** Who the CORTEX_USER grant names: the installed app, else the role (default: the provider's own). */
  grantee?: (provider: CortexClaudeProvider) => { appName?: string; role?: string };
  /** How long a result is kept before a read checks again (default 10 minutes). */
  ttlMs?: number;
  /** While Ask is not ready: check again this often (default 5 minutes)... */
  retryMs?: number;
  /** ...for this long after it was first seen not ready (default 1 hour). */
  retryForMs?: number;
  /** Time limit for one check, fallbacks included (default 60 s, under the 90 s Snowflake ingress limit). */
  timeoutMs?: number;
  now?: () => number;
  /** Told every result; `changed` when the state, model or fix differs from the last one (or it is the first). */
  onResult?: (readiness: CortexAskReadiness, changed: boolean) => void | Promise<void>;
  /** Runs a check (tests replace it). */
  check?: typeof checkCortexAsk;
}

const CHECKING: AskReadinessView = { state: 'checking', headline: 'Checking that Ask can reach Snowflake Cortex…' };

/** What identifies the setup a result was checked for: a new connection or model is a new check. */
function setupKey(provider: CortexClaudeProvider): string {
  return `${provider.host}|${provider.requestedModel}|${provider.automaticModel ? 'auto' : 'named'}`;
}

function sameResult(a: CortexAskReadiness | undefined, b: CortexAskReadiness): boolean {
  return Boolean(a) && a!.state === b.state && a!.model === b.model && a!.fellBackFrom === b.fellBackFrom && a!.fixSql === b.fixSql && a!.message === b.message;
}

export class AskReadinessCheck {
  private last: { at: number; key: string; readiness: CortexAskReadiness } | undefined;
  private running: { key: string; done: Promise<AskReadinessView> } | undefined;
  private retry: NodeJS.Timeout | undefined;
  private notReadySince: number | undefined;
  private stopped = false;

  constructor(private readonly options: AskReadinessOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async cortex(): Promise<CortexClaudeProvider | null> {
    try {
      return (await this.options.provider()) ?? null;
    } catch {
      return null;
    }
  }

  /** The last result for the current setup, kept for ttlMs; a stale or missing one is checked in the background. */
  async read(): Promise<AskReadinessView> {
    const provider = await this.cortex();
    if (!provider) return { state: 'not_applicable' };
    const key = setupKey(provider);
    const last = this.last?.key === key ? this.last : undefined;
    const fresh = last && this.now() - last.at < (this.options.ttlMs ?? 10 * 60_000);
    if (!fresh) void this.run(provider, false);
    return last?.readiness ?? CHECKING;
  }

  /** Checks now and answers with the result ("Check again"); `fresh` forgets a remembered fallback first. */
  async check(options: { fresh?: boolean } = {}): Promise<AskReadinessView> {
    const provider = await this.cortex();
    if (!provider) return { state: 'not_applicable' };
    return this.run(provider, options.fresh === true);
  }

  /** At start: one check in the background. */
  start(): void {
    void this.check();
  }

  /** Stops the re-checks (server shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private run(provider: CortexClaudeProvider, fresh: boolean): Promise<AskReadinessView> {
    const key = setupKey(provider);
    if (this.running?.key === key && !fresh) return this.running.done;
    const done = (async (): Promise<AskReadinessView> => {
      const grantee = this.options.grantee?.(provider) ?? provider.grantee;
      const readiness = await (this.options.check ?? checkCortexAsk)(provider, {
        ...grantee,
        fresh,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      const previous = this.last?.key === key ? this.last.readiness : undefined;
      this.last = { at: this.now(), key, readiness };
      this.scheduleRetry(readiness);
      try {
        await this.options.onResult?.(readiness, !sameResult(previous, readiness));
      } catch {
        // Telling others (the launcher's table) is best effort; the result stands.
      }
      return readiness;
    })();
    const entry = { key, done };
    this.running = entry;
    void done.finally(() => { if (this.running === entry) this.running = undefined; });
    return done;
  }

  private scheduleRetry(readiness: CortexAskReadiness): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (readiness.state === 'ready') {
      this.notReadySince = undefined;
      return;
    }
    const now = this.now();
    this.notReadySince ??= now;
    if (this.stopped || now - this.notReadySince >= (this.options.retryForMs ?? 60 * 60_000)) return;
    this.retry = setTimeout(() => { void this.check(); }, this.options.retryMs ?? 5 * 60_000);
    this.retry.unref?.();
  }
}
