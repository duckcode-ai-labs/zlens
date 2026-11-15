/**
 * Local OSS owner identity (spec 14, part C).
 *
 * A new DRAFT block must never be born with a "Missing owner" Certifier strike
 * just because the OSS user never passed `--owner`. We resolve a sensible
 * default owner ONCE and persist it, then stamp it across every draft-creating
 * path (propose, generate, enrichment, /api/ai/build) when no explicit owner is
 * supplied.
 *
 * Resolution order (first non-empty wins):
 *   1. Persisted owner — `dql.config.json` `identity.owner`, else `.dql/local`.
 *   2. git `user.email` (project-local, then global).
 *   3. `$USER` / `$USERNAME` / OS user — `<user>@local`.
 *   4. `guest@local` (guaranteed non-empty fallback).
 *
 * This module is deterministic and offline — it never calls a provider. The git
 * lookup is best-effort and degrades silently when git is absent or the repo has
 * no configured email.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the resolved owner is cached when `dql.config.json` is unavailable. */
const LOCAL_OWNER_PATH = ['.dql', 'local', 'owner'];

export interface ResolveOwnerOptions {
  /**
   * When provided, this owner wins over any persisted/derived value (the human
   * passed `--owner` / `body.owner`). Empty / whitespace is treated as absent.
   */
  explicit?: string;
  /**
   * Persist the resolved owner so subsequent calls (and other tools) reuse it.
   * Defaults to true. Set false for pure reads (e.g. a preview that must write
   * nothing).
   */
  persist?: boolean;
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a persisted owner from `dql.config.json` `identity.owner`, else `.dql/local/owner`. */
export function readPersistedOwner(projectRoot: string): string | undefined {
  const configPath = join(projectRoot, 'dql.config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        identity?: { owner?: unknown };
      };
      const owner = nonEmpty(typeof raw.identity?.owner === 'string' ? raw.identity.owner : undefined);
      if (owner) return owner;
    } catch {
      // Malformed config is not fatal — fall through to the local cache.
    }
  }
  const localPath = join(projectRoot, ...LOCAL_OWNER_PATH);
  if (existsSync(localPath)) {
    try {
      return nonEmpty(readFileSync(localPath, 'utf-8'));
    } catch {
      // Unreadable cache — fall through.
    }
  }
  return undefined;
}

/** Best-effort git `user.email` (project-local first, then global). Never throws. */
function gitUserEmail(projectRoot: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return nonEmpty(out);
    } catch {
      return undefined;
    }
  };
  return run(['config', 'user.email']) ?? run(['config', '--global', 'user.email']);
}

/** `$USER` / OS user → `<user>@local`, else undefined. */
function osUserOwner(): string | undefined {
  const fromEnv = nonEmpty(process.env.USER) ?? nonEmpty(process.env.USERNAME);
  if (fromEnv) return `${fromEnv}@local`;
  try {
    const name = nonEmpty(userInfo().username);
    if (name) return `${name}@local`;
  } catch {
    // userInfo can throw on exotic platforms — ignore.
  }
  return undefined;
}

/**
 * Persist the owner into `dql.config.json` `identity.owner` when the config
 * exists; otherwise cache it under `.dql/local/owner`. Best-effort — a failure to
 * persist never blocks the caller (the owner is still returned).
 */
export function persistOwner(projectRoot: string, owner: string): void {
  const value = nonEmpty(owner);
  if (!value) return;
  const configPath = join(projectRoot, 'dql.config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const identity = (raw.identity && typeof raw.identity === 'object'
        ? raw.identity
        : {}) as Record<string, unknown>;
      if (identity.owner === value) return; // already current — no rewrite.
      identity.owner = value;
      raw.identity = identity;
      writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
      return;
    } catch {
      // Fall through to the local cache when the config cannot be rewritten.
    }
  }
  try {
    const localPath = join(projectRoot, ...LOCAL_OWNER_PATH);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, value + '\n', 'utf-8');
  } catch {
    // Caching is advisory; a read-only filesystem must not break resolution.
  }
}

/**
 * WHO OWNS WHAT IS MADE WHEN A HOST SIGNS THE PERSON IN. In the ZLens app for
 * Snowflake, Snowflake signs the person in and the container's own account
 * ("zlens@local") is nobody's name: a draft Ask saves, and the owner the
 * builder offers, are the signed-in Snowflake user's, or empty for a reviewer
 * to fill (V2, listing retake F4). The host runs each request inside
 * `withSignedInOwner`, and turns `ownersFromSignInOnly` on for work outside a
 * request; anywhere else nothing changes.
 */
const signedInOwner = new AsyncLocalStorage<{ owner: string }>();
let signInOnly = false;

/** Runs `work` with `owner` (the signed-in person, or empty for nobody) as the owner of what it creates. */
export function withSignedInOwner<T>(owner: string | undefined, work: () => T): T {
  return signedInOwner.run({ owner: nonEmpty(owner) ?? '' }, work);
}

/** On: outside a signed-in request no owner is derived from git or the machine's user (it stays empty). */
export function ownersFromSignInOnly(on: boolean): void {
  signInOnly = on;
}

/** The signed-in owner of the current work, when a host signs people in: the person, or '' for nobody. */
export function signedInOwnerOf(): string | undefined {
  const scope = signedInOwner.getStore();
  if (scope) return scope.owner;
  return signInOnly ? '' : undefined;
}

/**
 * Resolve the default local OSS owner. Returns a non-empty string, except
 * where a host signs people in (`withSignedInOwner`): there it is the
 * signed-in person, or empty, never derived from this machine and never
 * persisted. When an explicit owner is given it wins (and is persisted
 * outside a host); otherwise the first persisted/derived value is used and
 * persisted for reuse.
 */
export function resolveLocalOwner(projectRoot: string, options: ResolveOwnerOptions = {}): string {
  const persist = options.persist !== false;

  const explicit = nonEmpty(options.explicit);
  const signedIn = signedInOwnerOf();
  if (signedIn !== undefined) return explicit ?? signedIn;
  if (explicit) {
    if (persist) persistOwner(projectRoot, explicit);
    return explicit;
  }

  const persisted = readPersistedOwner(projectRoot);
  if (persisted) return persisted;

  const resolved = gitUserEmail(projectRoot) ?? osUserOwner() ?? 'guest@local';
  if (persist) persistOwner(projectRoot, resolved);
  return resolved;
}
