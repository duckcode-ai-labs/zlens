import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasetsAppFeatureEnabled, loadProjectConfig } from './local-runtime.js';

// APP-007: field-based Dataset tiles are on by default; `apps.datasets: false`
// is the only off-switch.
describe('datasetsAppFeatureEnabled', () => {
  it('is on when apps.datasets is not set', () => {
    expect(datasetsAppFeatureEnabled({})).toBe(true);
    expect(datasetsAppFeatureEnabled({ apps: {} })).toBe(true);
  });

  it('is on when apps.datasets is true', () => {
    expect(datasetsAppFeatureEnabled({ apps: { datasets: true } })).toBe(true);
  });

  it('is off only when apps.datasets is false', () => {
    expect(datasetsAppFeatureEnabled({ apps: { datasets: false } })).toBe(false);
  });

  it('reads the switch from dql.config.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-datasets-flag-'));
    try {
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'flag' }));
      expect(datasetsAppFeatureEnabled(loadProjectConfig(root))).toBe(true);
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'flag', apps: { datasets: false } }));
      expect(datasetsAppFeatureEnabled(loadProjectConfig(root))).toBe(false);
      writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'flag', apps: { datasets: true } }));
      expect(datasetsAppFeatureEnabled(loadProjectConfig(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
