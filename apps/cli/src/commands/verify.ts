/**
 * `zlens verify` — prove the on-disk manifest is reproducible from source.
 *
 * Recompiles the manifest in-memory and diffs it against `dql-manifest.json`.
 * Returns a non-zero exit code (and prints a diff summary) on drift. Used by
 * CI to ensure programmable artifacts (Apps, dashboards, blocks, RLS rules,
 * schedules) stay in lock-step with their source files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest, changedSinceCertifiedMessage, resolveDataLexManifestPath, resolveDbtManifestPath, type DQLManifest } from '@zlens/core';
import type { CLIFlags } from '../args.js';

export async function runVerify(
  pathArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const allArgs = [...(pathArg ? [pathArg] : []), ...rest];
  let dbtManifestPath: string | undefined;
  const dbtIdx = allArgs.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && allArgs[dbtIdx + 1]) {
    dbtManifestPath = resolve(allArgs[dbtIdx + 1]);
    if (!existsSync(dbtManifestPath)) {
      throw new Error(`dbt manifest not found: ${dbtManifestPath}`);
    }
  }

  let maxDbtHops: number | undefined;
  const hopsIdx = allArgs.indexOf('--dbt-hops');
  if (hopsIdx >= 0 && allArgs[hopsIdx + 1]) {
    const parsed = Number.parseInt(allArgs[hopsIdx + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) maxDbtHops = parsed;
  }

  const pathCandidates = allArgs.filter((a) => !a.startsWith('-'));
  const filteredCandidates = pathCandidates
    .filter((c) => dbtIdx < 0 || c !== allArgs[dbtIdx + 1])
    .filter((c) => hopsIdx < 0 || c !== allArgs[hopsIdx + 1]);
  const projectRoot = resolve(filteredCandidates[0] ?? '.');
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`dql-manifest.json not found at ${manifestPath}. Run \`zlens compile\` first.`);
  }

  let dqlVersion = '0.6.0';
  try {
    const pkgPath = join(import.meta.dirname ?? __dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      dqlVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? dqlVersion;
    }
  } catch { /* use default */ }

  const resolvedDbt = resolveDbtManifestPath(projectRoot, dbtManifestPath);
  if (resolvedDbt) dbtManifestPath = resolvedDbt;
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    throw new Error(`DataLex manifest not found: ${flags.datalexManifestPath}`);
  }

  const onDisk = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DQLManifest;
  const fresh = buildManifest({ projectRoot, dqlVersion, dbtManifestPath, maxDbtHops, datalexManifestPath });

  const drift = diffManifest(onDisk, fresh);
  const json = (flags as { format?: string }).format === 'json';
  // Not drift between source and manifest, so not a failure: a certified block
  // edited after its receipt was written, which Ask no longer serves as certified.
  const warnings = changedCertifiedBlocks(fresh);
  if (!json) for (const warning of warnings) console.error(`  ⚠ ${warning}`);

  if (drift.length === 0) {
    if (json) {
      console.log(JSON.stringify(warnings.length > 0 ? { ok: true, warnings } : { ok: true }));
    } else {
      console.log('  ✓ Manifest verified — no drift between source tree and dql-manifest.json.');
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify({ ok: false, drift, ...(warnings.length > 0 ? { warnings } : {}) }, null, 2));
  } else {
    console.error(`  ✗ Manifest drift detected:`);
    for (const item of drift) console.error(`    - ${item}`);
    console.error('\n  Run `zlens compile` to regenerate, then commit.');
  }
  process.exit(1);
}

function changedCertifiedBlocks(manifest: DQLManifest): string[] {
  return Object.values(manifest.blocks)
    .filter((block) => block.certificationSourceChanged)
    .map((block) => `${block.filePath}: ${changedSinceCertifiedMessage(block.name, null)} Certify it again (Block Studio's Re-certify).`);
}

function diffManifest(a: DQLManifest, b: DQLManifest): string[] {
  const drift: string[] = [];
  diffMap('blocks', new Set(Object.keys(a.blocks)), new Set(Object.keys(b.blocks)), drift);
  diffMap('notebooks', new Set(Object.keys(a.notebooks)), new Set(Object.keys(b.notebooks)), drift);
  diffMap('apps', new Set(Object.keys(a.apps ?? {})), new Set(Object.keys(b.apps ?? {})), drift);
  diffMap('dashboards', new Set(Object.keys(a.dashboards ?? {})), new Set(Object.keys(b.dashboards ?? {})), drift);
  diffMap('metrics', new Set(Object.keys(a.metrics)), new Set(Object.keys(b.metrics)), drift);
  diffMap('dimensions', new Set(Object.keys(a.dimensions)), new Set(Object.keys(b.dimensions)), drift);
  diffMap('sources', new Set(Object.keys(a.sources)), new Set(Object.keys(b.sources)), drift);

  // Block-level drift: shape changes that matter for downstream readers.
  for (const [name, block] of Object.entries(a.blocks)) {
    const other = b.blocks[name];
    if (!other) continue;
    if (block.sql !== other.sql) drift.push(`blocks/${name}: SQL drift`);
    if ((block.status ?? '') !== (other.status ?? '')) drift.push(`blocks/${name}: status drift (${block.status} → ${other.status})`);
    if ((block.domain ?? '') !== (other.domain ?? '')) drift.push(`blocks/${name}: domain drift`);
  }
  return drift;
}

function diffMap(label: string, a: Set<string>, b: Set<string>, into: string[]): void {
  for (const k of a) if (!b.has(k)) into.push(`${label}: removed "${k}"`);
  for (const k of b) if (!a.has(k)) into.push(`${label}: added "${k}"`);
}
