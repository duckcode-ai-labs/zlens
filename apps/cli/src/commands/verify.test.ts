import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest } from '@zlens/core';
import { runVerify } from './verify.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function block(sql: string): string {
  return `block "monthly_revenue" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  owner = "analytics@example.com"
  description = "Monthly revenue."
  query = """
    ${sql}
  """
}`;
}

function compiledProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-verify-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'verify_demo' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  writeFileSync(join(root, 'blocks', 'monthly_revenue.dql'), block('SELECT 1 AS revenue'), 'utf-8');
  writeFileSync(
    join(root, 'dql-manifest.json'),
    JSON.stringify(buildManifest({ projectRoot: root }), null, 2),
    'utf-8',
  );
  return root;
}

describe('runVerify', () => {
  it('prints success to stdout when the manifest matches the source', async () => {
    const root = compiledProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runVerify(root, [], { format: 'text' } as never);

    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Manifest verified');
    expect(error).not.toHaveBeenCalled();
  });

  it('prints the drift report to stdout too, and exits 1', async () => {
    const root = compiledProject();
    writeFileSync(join(root, 'blocks', 'monthly_revenue.dql'), block('SELECT 2 AS revenue'), 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(runVerify(root, [], { format: 'text' } as never)).rejects.toThrow('exit 1');

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Manifest drift detected');
    expect(output).toContain('blocks/monthly_revenue: SQL drift');
    expect(error).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
