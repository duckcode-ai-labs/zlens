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
    expect(procedures).toEqual(['start_app', 'stop_app', 'app_url', 'backups', 'back_up_now', 'restore_backup', 'launcher_status', 'launcher_start']);
    for (const name of procedures) expect(readme).toMatch(new RegExp('```sql\\n[^`]*app_public\\.' + name + '\\('));
    expect(readme).toContain(`\`${CORTEX_DEFAULT_MODEL}\``);
    expect(readme).toContain('AI_COMPLETE');
  });

  it('keeps History\'s change log in the app\'s own table, readable by app_admin as app_public.history, and says so', () => {
    expect(setup).toMatch(/CREATE TABLE IF NOT EXISTS core\.history_log \(\s*commit_id VARCHAR,\s*changed_at TIMESTAMP_TZ,\s*changed_by VARCHAR,\s*item VARCHAR,\s*kind VARCHAR,\s*version NUMBER,\s*change VARCHAR,\s*certified BOOLEAN\s*\);/);
    expect(setup).toMatch(/CREATE OR REPLACE VIEW app_public\.history AS\s+SELECT changed_at, changed_by, item, kind, version, change, certified\s+FROM core\.history_log;/);
    expect(setup).toContain('GRANT SELECT ON VIEW app_public.history TO APPLICATION ROLE app_admin;');
    // Never granted to the person using ZLens, and never anything they could write.
    expect(setup).not.toMatch(/ON (TABLE|VIEW) [a-z_.]*history[a-z_]* TO APPLICATION ROLE app_user/i);
    expect(setup).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*history/i);
    expect(readme).toContain('### History');
    expect(readme).toMatch(/```sql\nSELECT changed_at, changed_by, item, kind, version, change, certified\nFROM ZLENS_APP\.app_public\.history/);
    expect(readme).toContain('History itself keeps working');
  });

  it('tells the person what the first open looks like', () => {
    expect(readme).toContain('SNOWSERVICES_INGRESS');
    expect(readme).toContain('service is not yet running');
    expect(readme).toMatch(/reload/i);
    expect(setup).toContain("SHOW SERVICES LIKE ''ZLENS'' IN SCHEMA core");
  });

  /** The body of one procedure in the setup script: what is between its $$ marks. */
  const procedure = (name: string) => {
    const start = setup.indexOf(`CREATE OR REPLACE PROCEDURE app_public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    const open = setup.indexOf('$$', start) + 2;
    return setup.slice(open, setup.indexOf('$$', open));
  };

  it('V14: app_url() starts a stopped ZLens and waits until it is ready before it gives the address', () => {
    const appUrl = procedure('app_url');
    // Stopped: it resumes the pool and the service, as opening the address would. Still stopping: ask again in a minute.
    expect(appUrl).toMatch(/IF \(svc_status = 'SUSPENDED'\) THEN\s+BEGIN\s+ALTER COMPUTE POOL IDENTIFIER\(:pool\) RESUME;[\s\S]*?ALTER SERVICE core\.zlens RESUME;/);
    expect(appUrl).toMatch(/IF \(svc_status = 'SUSPENDING'\) THEN\s+RETURN 'ZLens is stopping/);
    // Stopped or starting: it waits, with Snowflake's own call (seconds first, then the service), for about 4 minutes.
    const wait = /SELECT SYSTEM\$WAIT_FOR_SERVICES\((\d+), 'core\.zlens'\) INTO :wait_result;/.exec(appUrl);
    expect(wait).not.toBeNull();
    expect(Number(wait![1])).toBeGreaterThanOrEqual(180);
    expect(Number(wait![1])).toBeLessThanOrEqual(300);
    expect(appUrl).toMatch(/IF \(svc_status IN \('SUSPENDED', 'PENDING'\)\) THEN\s+BEGIN\s+SELECT SYSTEM\$WAIT_FOR_SERVICES/);
    // The wait fails on a timeout: that is caught, the state read again, and the address comes after it.
    expect(appUrl).toMatch(/SYSTEM\$WAIT_FOR_SERVICES[\s\S]*?EXCEPTION WHEN OTHER THEN[\s\S]*?services_after := [\s\S]*?SHOW ENDPOINTS IN SERVICE core\.zlens/);
    // Ready: the address alone. Still starting: says so, with an honest wait, and the address to open once.
    expect(appUrl).toMatch(/RETURN url;\s+END;\s*$/);
    expect(appUrl).toContain("'ZLens is still starting. A start takes about 2 to 3 minutes");
    expect(appUrl).toContain('Wait, then open the address once: ');
    expect(appUrl).not.toMatch(/5 to 15|about 2 minutes/);
    // It never stops or re-creates anything, and any user of the app may call it.
    expect(appUrl).not.toMatch(/SUSPEND;|CREATE |ensure_zlens/);
    expect(setup).toContain('GRANT USAGE ON PROCEDURE app_public.app_url() TO APPLICATION ROLE app_user;');
    expect(procedure('start_app')).toContain('about 2 to 3 minutes');
  });

  it('V14: states one start time, about 2 to 3 minutes, in the setup script, the readme and Help', () => {
    const help = readFileSync(join(__dirname, '..', '..', 'dql-notebook', 'src', 'components', 'help', 'HelpDocsPage.tsx'), 'utf8');
    for (const text of [setup, readme, help]) {
      expect(text).not.toMatch(/5 to 15|five to fifteen/i);
      expect(text).toContain('2 to 3 minutes');
    }
  });

  it('V2: Launch app opens the launcher page, which starts ZLens and offers its address only once it is ready', () => {
    // The manifest opens the launcher, not the address (Snowflake takes one or the other).
    const manifest = yaml.load(read('manifest.yml')) as { artifacts: Record<string, unknown> };
    expect(manifest.artifacts.default_streamlit).toBe('app_public.launcher');
    expect(manifest.artifacts).not.toHaveProperty('default_web_endpoint');
    // The page lives in the versioned schema, on the app's own warehouse, for both app roles.
    expect(setup).toContain("CREATE OR REPLACE STREAMLIT app_public.launcher FROM ''/launcher'' MAIN_FILE = ''launcher.py'' TITLE = ''ZLens'' QUERY_WAREHOUSE = ' || CURRENT_DATABASE() || '_WH'");
    expect(setup).toContain('GRANT USAGE ON STREAMLIT app_public.launcher TO APPLICATION ROLE app_user;');
    expect(setup).toContain('GRANT USAGE ON STREAMLIT app_public.launcher TO APPLICATION ROLE app_admin;');
    // READY only when the service runs and its container reports READY (a service itself reports RUNNING).
    const status = procedure('launcher_status');
    expect(status).toContain("SHOW SERVICE CONTAINERS IN SERVICE core.zlens");
    expect(status).toContain("svc_status := IFF(ready_containers > 0 AND other_containers = 0, 'READY', 'PENDING');");
    expect(status).toContain("SYS_CONTEXT('SNOWFLAKE$APPLICATION', 'GET_CONFIGURATION_VALUE', 'ZLENS_USER')");
    expect(status).not.toMatch(/RESUME|SUSPEND;|CREATE /);
    // Start only resumes a stopped ZLens and returns at once: no long wait inside a page's call.
    const start = procedure('launcher_start');
    expect(start).toMatch(/IF \(svc_status = 'SUSPENDED'\) THEN\s+BEGIN\s+ALTER COMPUTE POOL IDENTIFIER\(:pool\) RESUME;[\s\S]*?ALTER SERVICE core\.zlens RESUME;/);
    expect(start).not.toMatch(/WAIT_FOR_SERVICES|SUSPEND;|CREATE |ensure_zlens/);
    for (const name of ['launcher_status', 'launcher_start']) {
      expect(setup).toContain(`GRANT USAGE ON PROCEDURE app_public.${name}() TO APPLICATION ROLE app_user;`);
    }
    // Both address forms (Snowflake moves endpoints to *.snowflake.app), in app_url() and the launcher.
    for (const name of ['app_url', 'launcher_status']) {
      expect(procedure(name)).toContain("LIKE '%.snowflakecomputing.app%' OR endpoint.\"ingress_url\" LIKE '%.snowflake.app%'");
    }
  });

  it('V2: the launcher page calls only the app\'s own procedures, and pins a Streamlit with link_button', () => {
    const page = read('launcher/launcher.py');
    const calls = [...page.matchAll(/session\.sql\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(calls).toEqual(['CALL app_public.launcher_status()', 'CALL app_public.launcher_start()', 'SELECT CURRENT_DATABASE()']);
    expect(page).not.toMatch(/requests|urllib|http\.client|socket|components\.html/);
    expect(page).toContain('st.link_button("Open ZLens", status["url"]');
    // The address is offered only once READY, with a copy of it in case the browser blocks the tab.
    expect(page).toMatch(/if name == "READY" and status\["url"\]:[\s\S]*?st\.link_button[\s\S]*?st\.code\(status\["url"\]/);
    expect(page.indexOf('st.link_button')).toBeGreaterThan(page.indexOf('if name == "READY"'));
    const env = yaml.load(read('launcher/environment.yml')) as { channels: string[]; dependencies: string[] };
    expect(env.channels).toEqual(['snowflake']);
    const pin = env.dependencies.find((dep) => dep.startsWith('streamlit='));
    const [major, minor] = pin!.slice('streamlit='.length).split('.').map(Number);
    expect(major! > 1 || (major === 1 && minor! >= 27)).toBe(true);
  });

  it('V2: the readme and Help send people to Launch app, with app_url() as the SQL route', () => {
    const firstOpen = readme.slice(readme.indexOf('## The first open'), readme.indexOf('## What ZLens does first'));
    expect(firstOpen).toContain('**Press Launch app.**');
    expect(firstOpen).toContain('**Open ZLens**');
    expect(firstOpen).toMatch(/Start from \*\*Launch app\*\* instead/);
    expect(firstOpen).toMatch(/```sql\n\s*CALL ZLENS_APP\.app_public\.app_url\(\);\n\s*```/);
    expect(firstOpen).not.toMatch(/opens the\s+address directly|After a stop, run `app_url\(\)` first/);
    const help = readFileSync(join(__dirname, '..', '..', 'dql-notebook', 'src', 'components', 'help', 'HelpDocsPage.tsx'), 'utf8');
    expect(help).toContain('press <strong>Launch app</strong>');
    expect(help).not.toContain('opens the address at once');
  });

  it('V2: the backup stage setting names the same three grants as the readme', () => {
    const description = /CONFIGURATION DEFINITION zlens_backup_stage[\s\S]*?DESCRIPTION = '([^']*)'/.exec(setup)?.[1] ?? '';
    expect(description).toMatch(/USAGE on its database/);
    expect(description).toMatch(/USAGE on its schema/);
    expect(description).toMatch(/READ, WRITE on the stage/);
    expect(description.length).toBeLessThan(260);
    expect(readme).toContain('GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;');
    expect(readme).toContain('GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;');
    expect(readme).toContain('GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ZLENS_APP;');
  });
});
