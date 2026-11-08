/**
 * Runtime version-drift status (REL-002 / Slice 1).
 *
 * A stale runtime is the #1 way "the fix didn't work" reports happen: the
 * project pins one zlens version, the global binary is another, and the
 * long-running server is a third. This module makes drift VISIBLE (doctor,
 * /api/health, Settings) without ever blocking offline use — the latest-version
 * lookup is best-effort with a hard 2s timeout and a 24h in-memory cache, and
 * every failure degrades to 'unknown'.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '@zlens/core';
import { noEgress } from '@zlens/connectors';

export interface DqlRuntimeVersionStatus {
  /** Version of the code actually serving this process. */
  runningVersion: string;
  /** ISO timestamp of process start — identifies a server started before a rebuild/upgrade. */
  processStartedAt: string;
  /** Where the running code lives: the project's node_modules, a global install, or a dev checkout. */
  invocationSource: 'project_local' | 'global' | 'dev_or_unknown';
  /** Range declared for zlens in the project package.json, if any. */
  projectPinnedRange?: string;
  /** Version installed in the project's node_modules, if any. */
  projectInstalledVersion?: string;
  /** Latest published version from npm, when the background check has succeeded. */
  latestKnownVersion?: string;
  latestCheckStatus: 'ok' | 'unknown';
  /** Human-readable drift warnings; empty means no drift detected. */
  drift: string[];
  upgradeCommand?: string;
}

const PROCESS_STARTED_AT = new Date().toISOString();
const LATEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LATEST_FETCH_TIMEOUT_MS = 2_000;

let latestCache: { version: string; fetchedAt: number } | undefined;
let latestInFlight: Promise<string | undefined> | undefined;

/** Best-effort latest published version; never throws, never blocks longer than 2s. */
export async function fetchLatestPublishedDqlVersion(): Promise<string | undefined> {
  if (readEnv('ZLENS_DISABLE_VERSION_CHECK') === '1' || noEgress()) return undefined;
  if (latestCache && Date.now() - latestCache.fetchedAt < LATEST_CACHE_TTL_MS) return latestCache.version;
  if (latestInFlight) return latestInFlight;
  latestInFlight = (async () => {
    try {
      const res = await fetch('https://registry.npmjs.org/@zlens/cli/latest', {
        signal: AbortSignal.timeout(LATEST_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return undefined;
      const body = await res.json() as { version?: unknown };
      if (typeof body.version === 'string' && body.version.trim()) {
        latestCache = { version: body.version.trim(), fetchedAt: Date.now() };
        return latestCache.version;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      latestInFlight = undefined;
    }
  })();
  return latestInFlight;
}

/** Synchronous view of the cached latest version (health endpoints must stay fast). */
export function cachedLatestPublishedDqlVersion(): string | undefined {
  if (latestCache && Date.now() - latestCache.fetchedAt < LATEST_CACHE_TTL_MS) return latestCache.version;
  return undefined;
}

function readProjectCliDeclaration(projectRoot: string): { range?: string; installed?: string } {
  const result: { range?: string; installed?: string } = {};
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      result.range = pkg.devDependencies?.['@zlens/cli'] ?? pkg.dependencies?.['@zlens/cli'];
    }
  } catch { /* unreadable package.json is not a drift signal */ }
  try {
    const installedPath = join(projectRoot, 'node_modules', '@zlens', 'cli', 'package.json');
    if (existsSync(installedPath)) {
      const installed = JSON.parse(readFileSync(installedPath, 'utf-8')) as { version?: string };
      if (typeof installed.version === 'string') result.installed = installed.version;
    }
  } catch { /* missing/unreadable install handled by drift text */ }
  return result;
}

function classifyInvocationSource(projectRoot: string, runtimeUrl: string): DqlRuntimeVersionStatus['invocationSource'] {
  try {
    const runtimePath = fileURLToPath(runtimeUrl);
    if (runtimePath.startsWith(join(projectRoot, 'node_modules'))) return 'project_local';
    if (/[\\/](lib[\\/])?node_modules[\\/]/.test(runtimePath)) return 'global';
  } catch { /* non-file URL (bundled) */ }
  return 'dev_or_unknown';
}

/**
 * True when `candidate` is a strictly higher semver than `current`
 * (major.minor.patch, then a release beats any prerelease of the same
 * version, then prerelease identifiers compared per semver). Unparseable
 * input falls back to plain inequality so a strange version still surfaces.
 */
export function isNewerDqlVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : undefined;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return candidate !== current;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === 0 && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}

export function resolveDqlRuntimeVersionStatus(input: {
  projectRoot: string;
  runningVersion: string;
  runtimeUrl?: string;
}): DqlRuntimeVersionStatus {
  const { range, installed } = readProjectCliDeclaration(input.projectRoot);
  const latest = cachedLatestPublishedDqlVersion();
  const invocationSource = classifyInvocationSource(input.projectRoot, input.runtimeUrl ?? import.meta.url);
  const drift: string[] = [];
  if (installed && input.runningVersion !== 'unknown' && installed !== input.runningVersion) {
    drift.push(`The running ZLens server is ${input.runningVersion}, but this project's local install is ${installed}. Restart via the project (npx zlens / npm run notebook) or align the versions — fixes in one are invisible in the other.`);
  }
  // Only an OLDER running/installed version is drift: a build ahead of npm
  // (an unreleased checkout or a locally packed tarball) is not.
  if (latest && input.runningVersion !== 'unknown' && isNewerDqlVersion(latest, input.runningVersion)) {
    drift.push(`A newer zlens is published (${latest}; running ${input.runningVersion}).`);
  }
  if (latest && installed && isNewerDqlVersion(latest, installed)) {
    drift.push(`The project pins/installs ${installed}, but ${latest} is the latest published version.`);
  }
  const upgradeCommand = installed
    ? `npm install @zlens/cli@${latest ?? 'latest'}`
    : `npm install -g @zlens/cli@${latest ?? 'latest'}`;
  return {
    runningVersion: input.runningVersion,
    processStartedAt: PROCESS_STARTED_AT,
    invocationSource,
    ...(range ? { projectPinnedRange: range } : {}),
    ...(installed ? { projectInstalledVersion: installed } : {}),
    ...(latest ? { latestKnownVersion: latest } : {}),
    latestCheckStatus: latest ? 'ok' : 'unknown',
    drift,
    ...(drift.length > 0 ? { upgradeCommand } : {}),
  };
}
