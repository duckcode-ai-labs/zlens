import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, scan } from './check-table-names.mjs';

const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'table-names-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

test('finds a local name helper and a split on a relation name, but not in tests or the module', () => {
  const root = project({
    'apps/cli/src/a.ts': "function sameRelation(a, b) { return a === b; }\nconst parts = relationName.split('.');\n",
    'apps/cli/src/a.test.ts': 'function sameRelation() {}\n',
    'packages/dql-agent/src/ask-pipeline/physical-binding.ts': "function sameRelation() {}\nconst x = relation.split('.');\n",
    'packages/dql-agent/src/b.ts': 'export const twoPart = (n) => n;\n',
  });
  assert.deepEqual(scan(root), {
    'apps/cli/src/a.ts :: <relation>.split(".")': 1,
    'apps/cli/src/a.ts :: sameRelation': 1,
    'packages/dql-agent/src/b.ts :: twoPart': 1,
  });
});

test('a new helper fails; a removed one must leave the baseline', () => {
  assert.deepEqual(compare({ 'a.ts :: lastTwo': 1 }, {}), { grown: ['a.ts :: lastTwo (0 → 1)'], gone: [] });
  assert.deepEqual(compare({}, { 'a.ts :: lastTwo': 1 }), { grown: [], gone: ['a.ts :: lastTwo (1 → 0)'] });
  assert.deepEqual(compare({ 'a.ts :: lastTwo': 1 }, { 'a.ts :: lastTwo': 1 }), { grown: [], gone: [] });
});
