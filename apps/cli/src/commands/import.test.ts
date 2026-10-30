import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runImport } from './import.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe('runImport', () => {
  it('autosaves valid SQL import candidates as review drafts', async () => {
    const originalCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'dql-import-cli-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'orders.sql'), `-- name: orders by region
-- description: Orders grouped by region
-- domain: finance
select region, count(*) as orders
from marts.orders
group by region;
`, 'utf-8');

    try {
      process.chdir(root);
      await runImport('sql', ['orders.sql'], {
        check: false,
        chart: '',
        connection: '',
        domain: 'finance',
        format: 'json',
        help: false,
        input: '',
        open: null,
        outDir: '',
        owner: 'analytics',
        port: null,
        preview: false,
        queryOnly: false,
        save: true,
        skipTests: false,
        template: '',
        verbose: false,
        version: false,
      });

      const draftDir = join(root, 'blocks', '_drafts', 'finance');
      const draftFile = readdirSync(draftDir).find((file) => file.startsWith('orders-by-region-') && file.endsWith('.dql'));
      expect(draftFile).toBeTruthy();
      const blockPath = join(draftDir, draftFile!);
      const companionPath = join(root, 'semantic-layer', 'blocks', '_drafts', 'finance', draftFile!.replace(/\.dql$/, '.yaml'));
      expect(existsSync(companionPath)).toBe(true);
      expect(readFileSync(blockPath, 'utf-8')).toContain('status = "draft"');
      expect(readFileSync(companionPath, 'utf-8')).toContain('reviewStatus: draft');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
