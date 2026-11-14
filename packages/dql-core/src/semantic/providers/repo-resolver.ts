/**
 * Repo resolver: clones or pulls a remote Git repository into a local cache
 * directory so that file-based semantic layer providers (dbt, cubejs, etc.)
 * can read definitions from it.
 *
 * Supports GitHub and GitLab repositories. Uses shallow clone with a single
 * branch for speed. Caches clones under ~/.dql/cache/repos/ with a TTL so
 * repeated runs don't re-clone every time.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { SemanticLayerProviderConfig } from './provider.js';
import { readEnv } from '../../env.js';

/** Default cache TTL: 10 minutes. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Base directory for cached repo clones. */
function getCacheBaseDir(): string {
  return join(homedir(), '.dql', 'cache', 'repos');
}

/**
 * Compute a stable cache key from the repo URL + branch.
 */
function cacheKey(repoUrl: string, branch: string): string {
  const hash = createHash('sha256').update(`${repoUrl}#${branch}`).digest('hex').slice(0, 16);
  // Extract a human-readable slug from the URL
  const slug = repoUrl
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(-60);
  return `${slug}__${hash}`;
}

export interface RepoResolveResult {
  /** Absolute path to the resolved project root (local dir or cloned repo + subPath). */
  localPath: string;
  /** Whether the repo was freshly cloned or updated. */
  freshClone: boolean;
  /** Any warnings (e.g., stale cache used). */
  warnings: string[];
}

/**
 * Resolve the effective local path for a semantic layer config.
 *
 * - If source is 'local' (default) or no repoUrl is set, returns the
 *   projectRoot + projectPath as-is.
 * - If source is 'github' or 'gitlab', shallow-clones the repo into a
 *   cache directory and returns the path to the cloned content.
 */
export function resolveRepoSource(
  config: SemanticLayerProviderConfig,
  projectRoot: string,
): RepoResolveResult {
  const source = config.source ?? 'local';

  if (source === 'local' || !config.repoUrl) {
    // Local path — just resolve projectPath relative to projectRoot
    const localPath = config.projectPath
      ? join(projectRoot, config.projectPath)
      : projectRoot;
    return { localPath, freshClone: false, warnings: [] };
  }

  // Remote source. Without internet access (ZLENS_NO_EGRESS, as in the ZLens app for Snowflake) nothing is
  // cloned or pulled, whichever route asked.
  refuseWithoutInternet();

  // Remote source: clone or update
  const repoUrl = config.repoUrl;
  const branch = config.branch ?? 'main';
  const subPath = config.subPath ?? '';
  const warnings: string[] = [];

  const cacheBase = getCacheBaseDir();
  mkdirSync(cacheBase, { recursive: true });

  const key = cacheKey(repoUrl, branch);
  const cloneDir = join(cacheBase, key);
  let freshClone = false;

  if (existsSync(cloneDir)) {
    // Check if the cache is still fresh
    const stat = statSync(cloneDir);
    const age = Date.now() - stat.mtimeMs;

    if (age < CACHE_TTL_MS) {
      // Cache is fresh — use as-is
      const localPath = subPath ? join(cloneDir, subPath) : cloneDir;
      return { localPath, freshClone: false, warnings };
    }

    // Cache is stale — try to pull
    try {
      execFileSync('git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', branch], {
        timeout: 30_000,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      execFileSync('git', ['-C', cloneDir, 'reset', '--hard', `origin/${branch}`], {
        timeout: 30_000,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      freshClone = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to update cached repo, using stale cache: ${msg}`);
    }
  } else {
    // Fresh clone
    try {
      const tokenEnv = getAuthEnv(repoUrl);
      const authUrl = injectToken(repoUrl, tokenEnv);

      execFileSync(
        'git',
        ['clone', '--depth=1', '--branch', branch, '--single-branch', authUrl, cloneDir],
        {
          timeout: 60_000,
          stdio: 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
      freshClone = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to clone semantic layer repo "${repoUrl}" (branch: ${branch}): ${msg}. ` +
        'Ensure the repo URL is correct and, for private repos, set GITHUB_TOKEN or GITLAB_TOKEN.',
      );
    }
  }

  const localPath = subPath ? join(cloneDir, subPath) : cloneDir;
  return { localPath, freshClone, warnings };
}

/**
 * Get the auth token from environment variables based on repo URL.
 */
function getAuthEnv(repoUrl: string): string | undefined {
  if (repoUrl.includes('github.com') || repoUrl.includes('github')) {
    return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  }
  if (repoUrl.includes('gitlab.com') || repoUrl.includes('gitlab')) {
    return process.env.GITLAB_TOKEN ?? process.env.GL_TOKEN;
  }
  return undefined;
}

/**
 * Inject an auth token into an HTTPS URL for git clone.
 * Returns the original URL if no token is available or URL is not HTTPS.
 */
function injectToken(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'https:') return repoUrl;

    if (repoUrl.includes('github')) {
      // GitHub: https://x-access-token:TOKEN@github.com/owner/repo.git
      url.username = 'x-access-token';
      url.password = token;
    } else if (repoUrl.includes('gitlab')) {
      // GitLab: https://oauth2:TOKEN@gitlab.com/owner/repo.git
      url.username = 'oauth2';
      url.password = token;
    }
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Manually refresh a cached repo (for `zlens semantic pull` CLI command).
 */
/** Thrown before any clone or pull on an install with no internet access (ZLENS_NO_EGRESS). */
export const NO_EGRESS_REPOSITORY_ERROR = 'This install has no internet access (ZLENS_NO_EGRESS), so it cannot read a Git repository. Use a project folder on this install.';

function refuseWithoutInternet(): void {
  if (/^(1|true|on|yes)$/i.test(readEnv('ZLENS_NO_EGRESS')?.trim() ?? '')) throw new Error(NO_EGRESS_REPOSITORY_ERROR);
}

export function pullCachedRepo(repoUrl: string, branch: string = 'main'): RepoResolveResult {
  refuseWithoutInternet();
  const cacheBase = getCacheBaseDir();
  const key = cacheKey(repoUrl, branch);
  const cloneDir = join(cacheBase, key);
  const warnings: string[] = [];

  if (!existsSync(cloneDir)) {
    // No cache — do a fresh clone
    return resolveRepoSource(
      { provider: 'dbt', source: 'github', repoUrl, branch },
      process.cwd(),
    );
  }

  try {
    execFileSync('git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', branch], {
      timeout: 30_000,
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    execFileSync('git', ['-C', cloneDir, 'reset', '--hard', `origin/${branch}`], {
      timeout: 30_000,
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to pull: ${msg}`);
  }

  return { localPath: cloneDir, freshClone: true, warnings };
}
