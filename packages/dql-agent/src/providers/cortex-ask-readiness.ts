import {
  CORTEX_CROSS_REGION_STATEMENT,
  cortexFailureKind,
  cortexFailureWords,
  cortexGrantStatement,
  resetCortexModelChoice,
  resetCortexRoute,
  type CortexClaudeProvider,
} from './claude-cortex.js';

/**
 * ASK READINESS: is Ask's Cortex set up? A person must never find out that Ask is broken by asking a question and
 * getting a raw error. One tiny Cortex call (one output token) answers it up front, and a failure is told with the
 * one line of SQL an admin runs, chosen from Snowflake's error:
 * - `missing_grant`: the app (or role) lacks SNOWFLAKE.CORTEX_USER. Snowflake does not grant it to an installed app
 *   by itself, and only an ACCOUNTADMIN can (both seen on a real install, 25 Nov 2026).
 * - `region`: no Claude model is offered in the account's region; the account's CORTEX_ENABLED_CROSS_REGION setting
 *   must allow one (Japan, São Paulo, the Middle East, Africa and Azure accounts, by default).
 * - `model_unavailable`: Cortex does not offer the model a person named in Settings.
 * - `other`: anything else, in Snowflake's words.
 * Snowflake refusing the Cortex REST API (403, error 003001) is NOT a failure: it does so for most accounts, and
 * ZLens then asks through SQL (`AI_COMPLETE`). REST refused with a working AI_COMPLETE is `ready`, with no admin
 * step; only a failing AI_COMPLETE gets the grant or region line.
 * The wording is cortexFailureInWords', so a check and an Ask that fails say the same thing.
 */
export type CortexAskReadinessState = 'ready' | 'missing_grant' | 'region' | 'model_unavailable' | 'other';

export interface CortexAskReadiness {
  state: CortexAskReadinessState;
  /** The first line a person reads: "Ask is ready: it uses …" or "Ask is not ready: …". */
  headline: string;
  /** What is wrong and who fixes it, in plain words. Absent when ready. */
  message?: string;
  /** The one statement that fixes it, with the app's name filled in. */
  fixSql?: string;
  /** The line before `fixSql`: who runs it. */
  fixIntro?: string;
  /** The model Ask uses (ready), or the one it asked for (not ready). */
  model?: string;
  /** The model Ask was set to use, when Cortex did not offer it in the account's region and Ask uses `model` instead. */
  fellBackFrom?: string;
  /** How Cortex answered: its REST API, or SQL (`AI_COMPLETE`) when Snowflake refuses REST for the account. */
  route?: 'rest' | 'sql';
  /** When the check ran (ISO 8601). */
  checkedAt: string;
}

/** Who may run the fix: both the CORTEX_USER grant and the account setting need ACCOUNTADMIN. */
const FIX_INTRO = 'An ACCOUNTADMIN runs this one line in Snowsight:';

export interface CortexAskCheckOptions {
  /** The installed app's name, so the grant names it (`GRANT … TO APPLICATION <app>`); default: the provider's. */
  appName?: string;
  /** Outside the app: the role ZLens signs in with. */
  role?: string;
  /** Ends the check (the caller's time limit). */
  signal?: AbortSignal;
  /**
   * Check from scratch: forget a remembered REST refusal and model fallback first, so an account whose admin has
   * since changed a setting is seen as it is now ("Check again").
   */
  fresh?: boolean;
  now?: () => Date;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? '').trim().slice(0, 400);
}

/** The headline for a result: the same words wherever readiness is shown (Ask, the launcher, Settings). */
export function cortexAskHeadline(readiness: Pick<CortexAskReadiness, 'state' | 'model' | 'fellBackFrom' | 'route'>): string {
  switch (readiness.state) {
    case 'ready': {
      // Through SQL is the usual route: Snowflake keeps the Cortex REST API off for most accounts (error 003001).
      const through = readiness.route === 'sql' ? 'Cortex SQL (AI_COMPLETE)' : 'Snowflake Cortex';
      return readiness.fellBackFrom
        ? `Ask is ready: it uses ${readiness.model} through ${through}, because Snowflake Cortex does not offer ${readiness.fellBackFrom} to your account.`
        : `Ask is ready: it uses ${readiness.model ?? 'Claude'} through ${through}.`;
    }
    case 'missing_grant':
      return 'Ask is not ready: ZLens may not use Snowflake Cortex yet.';
    case 'region':
      return 'Ask is not ready: Snowflake Cortex offers no Claude model to your account in its region.';
    case 'model_unavailable':
      return `Ask is not ready: Snowflake Cortex does not offer ${readiness.model ?? 'the model set in Settings'} in your account.`;
    case 'other':
      return 'Ask is not ready: Snowflake Cortex did not answer a one-word test.';
  }
}

/**
 * One tiny Cortex call through `provider` (the provider Ask uses, so the check takes the same route and the same
 * model fallback), classified. Never throws: a failure is a result.
 */
export async function checkCortexAsk(provider: CortexClaudeProvider, options: CortexAskCheckOptions = {}): Promise<CortexAskReadiness> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  // The provider's own grantee (the installed app, else its role) unless the caller names one.
  const grantee = options.appName?.trim() || options.role?.trim()
    ? {
      ...(options.appName?.trim() ? { appName: options.appName.trim() } : {}),
      ...(options.role?.trim() ? { role: options.role.trim() } : {}),
    }
    : { ...provider.grantee };
  if (options.fresh) {
    resetCortexModelChoice(provider.host);
    resetCortexRoute(provider.host);
  }
  try {
    await provider.generate([{ role: 'user', content: 'Reply with exactly: OK' }], {
      maxTokens: 1,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const inUse = provider.modelInUse();
    const ready = { state: 'ready' as const, model: inUse.model, ...(inUse.instead ? { fellBackFrom: inUse.instead } : {}), route: provider.route() };
    return { ...ready, headline: cortexAskHeadline(ready), checkedAt };
  } catch (error) {
    // The provider throws plain words with Snowflake's own error as the cause: classify Snowflake's.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const raw = cause instanceof Error ? cause.message : String(cause);
    const failure = cortexFailureKind(raw);
    const aborted = options.signal?.aborted === true;
    const state: CortexAskReadinessState = aborted
      ? 'other'
      : failure?.kind === 'grant'
        ? 'missing_grant'
        : failure?.kind === 'region'
          ? 'region'
          // A model ZLens chose itself fell back through every Claude model: none is offered in the region.
          : failure?.kind === 'model'
            ? (provider.automaticModel ? 'region' : 'model_unavailable')
            : 'other';
    const base = { state, model: provider.requestedModel };
    const message = aborted
      ? 'Snowflake Cortex did not answer within the time the check allows. Try again in a minute.'
      : failure
        // A model ZLens chose that fell back through every Claude model is told as the region it is.
        ? cortexFailureWords(state === 'region' ? { ...failure, kind: 'region' } : failure, grantee)
        : firstLine(error);
    const fixSql = state === 'missing_grant'
      ? `${cortexGrantStatement(grantee)};`
      : state === 'region'
        ? `${CORTEX_CROSS_REGION_STATEMENT};`
        : undefined;
    return {
      ...base,
      headline: cortexAskHeadline(base),
      ...(message ? { message } : {}),
      ...(fixSql ? { fixSql, fixIntro: FIX_INTRO } : {}),
      route: provider.route(),
      checkedAt,
    };
  }
}
