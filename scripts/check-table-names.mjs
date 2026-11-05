#!/usr/bin/env node
// One answer to "is this the same table?" (simplification plan Z1, decision Z-D2).
//
// Table names are compared in one place: `tableKey` and `sameTable` in
// packages/dql-agent/src/ask-pipeline/physical-binding.ts. This check finds
// the other name helpers in source (a `sameRelation`, a `lastTwo`, a
// `relation.split('.')` ...) and compares them with a baseline that only
// shrinks: a new one fails, and one that is gone must leave the baseline.
//
//   node scripts/check-table-names.mjs                    check
//   node scripts/check-table-names.mjs --write-baseline   record what is there now
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'table-names-baseline.json');
const MODULE = 'packages/dql-agent/src/ask-pipeline/physical-binding.ts';

/** What a table-name helper looks like. */
export const PATTERNS = [
  { id: 'helper', re: /\bfunction\s+(sameRelation|normalizeRelation|bareRelation|relationKey|agentRelationMatchKey|normalizePhysicalIdentifier|exploratoryRelationsMatch|canonicalAgentPhysicalReference|semanticRelationSuffixMatches|sameSemanticIdentifier|splitQualifiedRelation\w*)\b/g },
  { id: 'helper', re: /\bconst\s+(sameRelation|lastTwo|twoPart|bareRelation|relationKey)\s*=/g },
  { id: 'split', re: /\b\w*[Rr]elation\w*\??\.split\(\s*['"]\.['"]\s*\)/g },
];

/** Counts per `path :: pattern match`, for every source file but tests and the module itself. */
export function scan(root = ROOT) {
  const counts = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue;
      const rel = relative(root, path).split(sep).join('/');
      if (rel === MODULE) continue;
      const text = readFileSync(path, 'utf8');
      for (const { id, re } of PATTERNS) {
        for (const match of text.matchAll(re)) {
          const key = `${rel} :: ${id === 'split' ? '<relation>.split(".")' : match[1]}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
  };
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** What changed against the baseline: new or grown helpers fail, and so do gone ones still listed. */
export function compare(found, baseline) {
  const grown = [];
  const gone = [];
  for (const [key, count] of Object.entries(found)) {
    if (count > (baseline[key] ?? 0)) grown.push(`${key} (${baseline[key] ?? 0} → ${count})`);
  }
  for (const [key, count] of Object.entries(baseline)) {
    if ((found[key] ?? 0) < count) gone.push(`${key} (${count} → ${found[key] ?? 0})`);
  }
  return { grown, gone };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan();
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(found).length} entries to ${relative(ROOT, BASELINE)}.`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const { grown, gone } = compare(found, baseline);
  if (grown.length) {
    console.error(`New table-name helpers (compare table names with tableKey or sameTable from ${MODULE}):\n  ${grown.join('\n  ')}`);
  }
  if (gone.length) {
    console.error(`Removed table-name helpers still in the baseline (run node scripts/check-table-names.mjs --write-baseline):\n  ${gone.join('\n  ')}`);
  }
  if (grown.length || gone.length) process.exit(1);
  console.log(`Table names: ${Object.values(found).reduce((sum, count) => sum + count, 0)} old helpers left, none new.`);
}
