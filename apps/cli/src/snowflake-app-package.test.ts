import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { CORTEX_DEFAULT_MODEL } from '@zlens/agent';

/**
 * The app package for Snowflake (deploy/snowflake-app/app) against Snowflake's enforced listing standards:
 * the compute pool in marketplace.yml (4.2), every SQL step of the readme in a code block (4.5), the Cortex
 * model named (4.8.1), every procedure documented, and one idle time everywhere it is stated.
 */
const APP = join(__dirname, '..', '..', '..', 'deploy', 'snowflake-app', 'app');
const read = (name: string) => readFileSync(join(APP, name), 'utf8');
const setup = read('setup.sql');
const readme = read('README.md');

describe('the app package for Snowflake', () => {
  it('lists the compute pool it creates in marketplace.yml', () => {
    const family = /INSTANCE_FAMILY\s*=\s*([A-Z0-9_]+)/.exec(setup)?.[1];
    expect(family).toBe('CPU_X64_XS');
    const marketplace = yaml.load(read('marketplace.yml')) as { required_compute_pools: Array<Record<string, { label: string; description: string; compatible_instance_families: string[] }>> };
    expect(marketplace.required_compute_pools).toHaveLength(1);
    const [pool] = Object.values(marketplace.required_compute_pools[0]!);
    expect(pool!.label).toBeTruthy();
    expect(pool!.description).toContain(family);
    expect(pool!.compatible_instance_families).toEqual([family]);
    // No external endpoints, so no connections.
    expect(marketplace).not.toHaveProperty('connections');
  });

  it('states one idle time: the setup script, the readme and the listing file agree', () => {
    const minutes = /idle_minutes VARCHAR DEFAULT '(\d+)'/.exec(setup)?.[1];
    expect(minutes).toBe('60');
    expect(setup).toContain("'ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES', :idle_minutes");
    expect(readme).toContain(`After ${minutes} minutes with no one using it`);
    expect(read('marketplace.yml')).toContain(`after ${minutes} idle minutes`);
    expect(setup).not.toMatch(/IDLE_SUSPEND_MINUTES', '\d+'/);
  });

  it('puts every SQL step of the readme in a code block', () => {
    const prose = readme.replace(/```sql[\s\S]*?```/g, '');
    // Inline code may name a function or a role, but never a statement to run.
    for (const inline of prose.match(/`[^`\n]+`/g) ?? []) {
      expect(inline).not.toMatch(/^`\s*(CALL|GRANT|ALTER|CREATE|DROP|REVOKE|SELECT)\b/i);
    }
    for (const line of prose.split('\n')) expect(line.trim()).not.toMatch(/^(CALL|GRANT|ALTER|CREATE|REVOKE)\s/);
  });

  it('documents every procedure the app gives the customer, and names the Cortex model', () => {
    const procedures = [...setup.matchAll(/CREATE OR REPLACE PROCEDURE app_public\.(\w+)\(/g)].map((match) => match[1]!);
    expect(procedures).toEqual(['start_app', 'stop_app', 'app_url', 'backups', 'back_up_now', 'restore_backup']);
    for (const name of procedures) expect(readme).toMatch(new RegExp('```sql\\n[^`]*app_public\\.' + name + '\\('));
    expect(readme).toContain(`\`${CORTEX_DEFAULT_MODEL}\``);
    expect(readme).toContain('AI_COMPLETE');
  });

  it('tells the person what the first open looks like', () => {
    expect(readme).toContain('SNOWSERVICES_INGRESS');
    expect(readme).toContain('service is not yet running');
    expect(readme).toMatch(/reload/i);
    // app_url() says "starting", with the wait, instead of an address that would show that page.
    expect(setup).toContain("SHOW SERVICES LIKE ''ZLENS'' IN SCHEMA core");
    expect(setup).toContain("'ZLens is starting. This takes '");
  });
});
