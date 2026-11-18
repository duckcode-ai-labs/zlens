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
    // A privilege's name is not a statement (the Privileges section names Snowflake's Future upgrades list).
    const privilege = /^`(?:CREATE (?:WAREHOUSE|COMPUTE POOL|DATABASE|EXTERNAL ACCESS INTEGRATION|SECURITY INTEGRATION|SHARE|LISTING)|EXECUTE (?:MANAGED )?TASK|BIND SERVICE ENDPOINT)`$/;
    for (const inline of prose.match(/`[^`\n]+`/g) ?? []) {
      if (privilege.test(inline)) continue;
      expect(inline).not.toMatch(/^`\s*(CALL|GRANT|ALTER|CREATE|DROP|REVOKE|SELECT)\b/i);
    }
    for (const line of prose.split('\n')) expect(line.trim()).not.toMatch(/^(CALL|GRANT|ALTER|CREATE|REVOKE)\s/);
  });

  it('documents every procedure the app gives the customer, and names the Cortex model', () => {
    const procedures = [...setup.matchAll(/CREATE OR REPLACE PROCEDURE app_public\.(\w+)\(/g)].map((match) => match[1]!);
    expect(procedures).toEqual(['start_app', 'stop_app', 'app_url', 'backups', 'back_up_now', 'restore_backup', 'launcher_status', 'launcher_start', 'launcher_data']);
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
    expect(appUrl).toContain("'ZLens is still starting. A start usually takes 2 to 3 minutes, and up to 20 minutes the first time after an install or update. '");
    expect(appUrl).toContain('Wait, then open the address once: ');
    expect(appUrl).not.toMatch(/5 to 15|about 2 minutes/);
    // It never stops or re-creates anything, and any user of the app may call it.
    expect(appUrl).not.toMatch(/SUSPEND;|CREATE |ensure_zlens/);
    expect(setup).toContain('GRANT USAGE ON PROCEDURE app_public.app_url() TO APPLICATION ROLE app_user;');
    expect(procedure('start_app')).toContain('usually 2 to 3 minutes, and up to 20 minutes the first time after an install or update');
  });

  it('V14: states one start time, about 2 to 3 minutes, in the setup script, the readme and Help', () => {
    const help = readFileSync(join(__dirname, '..', '..', 'dql-notebook', 'src', 'components', 'help', 'HelpDocsPage.tsx'), 'utf8');
    for (const text of [setup, readme, help]) {
      expect(text).not.toMatch(/5 to 15|five to fifteen/i);
      expect(text).toContain('2 to 3 minutes');
    }
  });

  it('V4: every start time in the app package says up to 20 minutes for the first start after an install or update', () => {
    const page = read('launcher/launcher.py');
    // A first start after an update took 13 min 56 s while the page said 2 to 3 minutes the whole time.
    for (const text of [setup, readme, page]) {
      const promises = text.split(/(?<=[.;:])\s+/).filter((sentence) => /2 to 3\b/.test(sentence));
      expect(promises.length).toBeGreaterThan(0);
      for (const sentence of promises) expect(sentence.replace(/\s+/g, ' ')).toMatch(/usually (?:takes )?2 to 3\b.*up to 20\b.*(?:the )?first (?:time|start) after an install or update/);
      expect(text).not.toMatch(/about 2 to 3|longer right after an install/);
    }
    for (const name of ['start_app', 'app_url']) expect(procedure(name)).toContain('up to 20 minutes the first time after an install or update');
    // Past 5 minutes, the blue box no longer promises 2 to 3 minutes; it says the first start can take up to 20.
    expect(page).toMatch(/elif elapsed > SLOW_START_SECONDS:\n(?:\s+#[^\n]*\n)*\s+st\.info\("Starting ZLens\. The first start after an install or update can take up to 20 minutes\."\)\nelse:\n\s+st\.info\("Starting ZLens\. This usually takes 2 to 3 minutes, and up to 20 minutes the first time after an install or update\."\)/);
    const slow = page.slice(page.indexOf('elif elapsed > SLOW_START_SECONDS:'), page.indexOf('else:', page.indexOf('elif elapsed > SLOW_START_SECONDS:')));
    expect(slow).not.toContain('2 to 3');
    // A start is still checked past the 20 minutes before the page gives up.
    expect(Number(/^STOP_WAITING_SECONDS = (\d+)$/m.exec(page)?.[1])).toBeGreaterThan(20 * 60);
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
    expect(calls).toEqual(['CALL app_public.launcher_status()', 'SELECT CURRENT_DATABASE(), CURRENT_TIMESTAMP()', 'SELECT CURRENT_WAREHOUSE()', 'CALL app_public.launcher_data()', 'CALL app_public.launcher_start()']);
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

  /** The body of one branch of the launcher page: from its `if` line to the next line that starts a top-level block. */
  const branch = (page: string, start: string) => {
    const from = page.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    const rest = page.slice(from + start.length);
    const end = rest.search(/\n(?:if |# |state\.|elapsed|st\.progress)/);
    return rest.slice(0, end === -1 ? undefined : end);
  };

  it('V3: once ready, the launcher checks again every minute for 10 minutes, then stops and offers Check again', () => {
    const page = read('launcher/launcher.py');
    const constant = (name: string) => Number(new RegExp(`^${name} = (\\d+)$`, 'm').exec(page)?.[1]);
    expect(constant('RECHECK_SECONDS')).toBe(60);
    expect(constant('RECHECK_FOR_SECONDS')).toBe(600);
    const ready = branch(page, 'if name == "READY" and status["url"]:');
    // The quiet re-check sleeps only inside the window, then reruns; after it, no sleep and no rerun of its own.
    expect(ready).toMatch(/left = RECHECK_FOR_SECONDS - \(now - state\["ready_since"\]\)\n\s+if left > 0:\n[^\n]*\n\s+clear_leftovers\(\)\n\s+time\.sleep\(RECHECK_SECONDS\)\n\s+st\.rerun\(\)/);
    expect(ready.match(/time\.sleep\(/g)).toHaveLength(1);
    const after = ready.slice(ready.indexOf('time.sleep(RECHECK_SECONDS)'));
    expect(after).toContain('This page has stopped checking, so its warehouse can suspend.');
    expect(after).toMatch(/if st\.button\("Check again"\):\n\s+state\["ready_since"\] = time\.time\(\)\n\s+st\.rerun\(\)\n\s+st\.stop\(\)/);
    // A start that never finishes is not checked forever either.
    expect(constant('STOP_WAITING_SECONDS')).toBeLessThanOrEqual(1800);
    expect(page).toMatch(/if elapsed > STOP_WAITING_SECONDS:[\s\S]*?st\.stop\(\)[\s\S]*?time\.sleep\(POLL_SECONDS\)/);
    // Every sleep in the page is one of the three bounded waits (set-up, ready, starting).
    expect([...page.matchAll(/time\.sleep\((\w+)\)/g)].map((match) => match[1])).toEqual(['SETUP_RECHECK_SECONDS', 'RECHECK_SECONDS', 'POLL_SECONDS']);
  });

  it('V3: a re-check that finds ZLens stopped or restarting shows it starting, and starts a stopped one', () => {
    const page = read('launcher/launcher.py');
    // Leaving READY starts a new start, timed from now, and forgets the ready window.
    expect(page).toMatch(/if name != "READY":\n\s+state\.pop\("ready_since", None\)\n\s+if state\.get\("last_status"\) == "READY":\n\s+state\["started_at"\] = now\n\s+state\.pop\("start_sent_at", None\)\n\s+state\.pop\("started_in", None\)\nstate\["last_status"\] = name/);
    expect(page).toMatch(/if name == "SUSPENDED" and now - state\.get\("start_sent_at", 0\) > RESEND_START_SECONDS:\n\s+start\(\)/);
    // "Started in" is measured once, when READY is first seen, not again on every re-check.
    expect(page).toContain('state["started_in"] = minutes(now - state["started_at"])');
    expect(page).not.toMatch(/Started in \{minutes\(time\.time\(\)/);
  });

  it('V3: every state of the launcher says when it was checked, with the time zone', () => {
    const page = read('launcher/launcher.py');
    // The time comes from Snowflake (the session's time zone), in the same query as the app's name, and in a
    // query of their own: with CURRENT_WAREHOUSE() beside them the query failed in the installed app, and the page
    // said "<this app>" and UTC (V17 and V17 p6 testers).
    expect(page).toContain('session.sql("SELECT CURRENT_DATABASE(), CURRENT_TIMESTAMP()")');
    expect(page).not.toMatch(/CURRENT_TIMESTAMP\(\), CURRENT_WAREHOUSE\(\)/);
    expect(page).toMatch(/def clock\(moment, later_seconds=0\):[\s\S]*?moment\.tzname\(\)[\s\S]*?return f"\{moment:%H:%M\} \{zone\}"/);
    expect(page).toContain('st.success(f"ZLens is ready. Checked at {checked}.")');
    for (const start of ['if status["error"]:', 'if name in ("FAILED", "INTERNAL_ERROR"):']) {
      expect(branch(page, start)).toContain('st.caption(f"Checked at {checked}.")');
    }
    expect(page).toContain('st.caption(f"{minutes(elapsed)} so far. Your projects are kept. Checked at {checked}.")');
  });

  it('V3: the launcher draws the ZLens logo inline, with nothing to fetch', () => {
    const page = read('launcher/launcher.py');
    // An image file shown with st.image loaded as a broken image in the Native App's page (V16 release check).
    expect(page).not.toContain('st.image(');
    expect(page).not.toMatch(/\.png/);
    expect(page).toContain('st.markdown(LOGO_SVG, unsafe_allow_html=True)');
    expect(page).toMatch(/LOGO_SVG = \([\s\S]*?<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*?aria-label="ZLens"[\s\S]*?M11 12H51V20L24 44H37V52H11V44L38 20H11Z[\s\S]*?<circle cx="47\.9" cy="48" r="6\.4"[\s\S]*?<\/svg>'\n\)/);
    // No outside address in the mark: nothing for the page to load.
    const svg = page.slice(page.indexOf('LOGO_SVG = ('), page.indexOf("</svg>'") + 7);
    expect(svg.match(/https?:\/\/[^"]+/g)).toEqual(['http://www.w3.org/2000/svg']);
    expect(page).toMatch(/def show_title\(\):[\s\S]*?st\.markdown\(LOGO_SVG, unsafe_allow_html=True\)[\s\S]*?except Exception:[\s\S]*?st\.title\("ZLens"\)/);
    expect(page.indexOf('show_title()\n\nif status["error"]')).toBeGreaterThan(-1);
  });

  it('V3: the launcher set-up steps grant tables and views, as the README does', () => {
    const page = read('launcher/launcher.py');
    const readme = read('README.md');
    for (const kind of ['TABLES', 'VIEWS']) {
      expect(page).toContain(`GRANT SELECT ON ALL ${kind} IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};`);
      expect(readme).toContain(`GRANT SELECT ON ALL ${kind} IN SCHEMA`);
    }
  });

  it('V3: the readme, Help and the launcher say which warehouse to pick when Snowsight asks for one', () => {
    const firstOpen = readme.slice(readme.indexOf('## The first open'), readme.indexOf('## What ZLens does first'));
    expect(firstOpen).toContain('**If Snowsight asks you to select a warehouse**');
    expect(firstOpen).toContain('pick `ZLENS_APP_WH` (your\n  app\'s name followed by `_WH`), the app\'s own warehouse');
    expect(firstOpen).toContain('missing a default warehouse');
    // The warehouse the launcher runs on is that one.
    expect(setup).toContain("QUERY_WAREHOUSE = ' || CURRENT_DATABASE() || '_WH'");
    expect(setup).not.toContain('so no one is\n-- asked to pick one');
    const help = readFileSync(join(__dirname, '..', '..', 'dql-notebook', 'src', 'components', 'help', 'HelpDocsPage.tsx'), 'utf8');
    expect(help).toContain('If Snowsight asks you to select a warehouse before that page opens, pick <span style={inlineCode}>ZLENS_APP_WH</span>');
    expect(help).toContain("troubleCard('Snowsight asks for a warehouse'");
    const page = read('launcher/launcher.py');
    expect(branch(page, 'if not status["zlens_user"]:')).toContain('If Snowsight asks you to select a warehouse before this page opens, pick {warehouse}, ');
    expect(page).toContain('warehouse = f"{app}_WH"');
  });

  it('V3: the readme explains the Snowflake pages ZLens cannot change: the cached page, a late sign-in, a blocked pop-up', () => {
    const firstOpen = readme.slice(readme.indexOf('## The first open'), readme.indexOf('## What ZLens does first'));
    expect(firstOpen).toMatch(/\*\*Reopening the page\*\* from the app can first show Snowsight's cached copy of it for a few\s+seconds/);
    expect(firstOpen).toMatch(/\*\*The page says when it last checked\*\*/);
    expect(firstOpen).toMatch(/a sign-in that finishes\s+after ZLens has stopped itself/);
    expect(firstOpen).toMatch(/A browser that blocks pop-ups blocks Open ZLens too: copy the address\s+from the page instead\./);
    // "service is not yet running" is explained in one place only.
    expect(readme.match(/service is not yet running/g)).toHaveLength(1);
  });

  it('V4: the readme says what to do when Snowsight greys the page out, and that its cached lines can linger', () => {
    const firstOpen = readme.slice(readme.indexOf('## The first open'), readme.indexOf('## What ZLens does first'));
    expect(firstOpen).toMatch(/\*\*If the page looks greyed out\*\* with a \*\*Start\*\* button at the top, Snowsight has put it to\s+sleep: press \*\*Start\*\*, then \*\*Check again\*\*\./);
    expect(firstOpen).toMatch(/faded lines from the\s+copy can stay under it for up to a minute\./);
  });

  it('V4: the ready page names the warehouse it really runs on, in plain words when Snowflake does not say', () => {
    const page = read('launcher/launcher.py');
    // Snowsight runs the page on the warehouse the person picked, which need not be the app's <app>_WH.
    // Read on its own, once per page session: a failure there costs only the warehouse's name. Without it, the
    // app's own <app>_WH, the page's QUERY_WAREHOUSE (V17 query history: the page ran there).
    expect(page).toMatch(/def page_warehouse_name\(\):[\s\S]*?if "page_warehouse" not in st\.session_state:\n\s+try:\n\s+st\.session_state\["page_warehouse"\] = str\(session\.sql\("SELECT CURRENT_WAREHOUSE\(\)"\)\.collect\(\)\[0\]\[0\] or ""\)\n\s+except Exception:[^\n]*\n\s+st\.session_state\["page_warehouse"\] = ""/);
    expect(page).toContain('app, moment = read_context()');
    expect(page).toContain('page_warehouse = page_warehouse_name() or (warehouse if app != "<this app>" else "")');
    const ready = branch(page, 'if name == "READY" and status["url"]:');
    expect(ready).toContain('keeps = f"this page\'s own, {page_warehouse}" if page_warehouse else "this page\'s own"');
    // Snowsight's own calls for an open page run on the warehouse it shows at the top (V17 p8 query history).
    expect(ready).toContain('f"while it stays open it keeps two warehouses running: {keeps}, and the one Snowsight shows at the top of the page. "');
    // The ready page no longer names the app's own warehouse as the one it keeps running.
    expect(ready).not.toContain('{warehouse}');
    expect(readme).toMatch(/reads the app's name, the time, the name of the warehouse it runs\s+on and the names of the databases granted to the app; it reads none of your data\./);
  });

  it('V17 p7: before the user is saved, the launcher says the missing step and checks again until it is saved', () => {
    const page = read('launcher/launcher.py');
    const constant = (name: string) => Number(new RegExp(`^${name} = (\\d+)$`, 'm').exec(page)?.[1]);
    expect(constant('SETUP_RECHECK_SECONDS')).toBe(10);
    expect(constant('SETUP_RECHECK_FOR_SECONDS')).toBe(600);
    const setUp = branch(page, 'if not status["zlens_user"]:');
    // The step that is missing, first, with what a saved user looks like on the Configurations tab.
    expect(setUp).toContain('**One step is missing: name the Snowflake user who uses ZLens.**');
    expect(setUp).toContain('green "\n        "**Configured** badge');
    expect(setUp).toContain('st.code(f"ALTER APPLICATION {app} SET CONFIGURATION ZLENS_USER VALUE = \'THEIR_USER\';", language="sql")');
    // It checks again by itself for a while (V17 p6 tester: after the save, the page kept its old frame until a
    // browser reload), then stops so its warehouse can suspend, and offers Check again.
    expect(setUp).toMatch(/left = SETUP_RECHECK_FOR_SECONDS - \(now - state\["setup_since"\]\)\n\s+if left > 0:\n[\s\S]*?time\.sleep\(SETUP_RECHECK_SECONDS\)\n\s+st\.rerun\(\)/);
    expect(setUp).toMatch(/This page has stopped checking, so its warehouse can suspend\.[\s\S]*?if st\.button\("Check again"\):\n\s+state\["setup_since"\] = time\.time\(\)\n\s+st\.rerun\(\)\n\s+st\.stop\(\)/);
    expect(page).toContain('\nstate.pop("setup_since", None)\n');
  });

  it('V17 p9: once the user is saved, the launcher says when ZLens can read no database, and names the ones it can', () => {
    const page = read('launcher/launcher.py');
    const data = procedure('launcher_data');
    // Names only: SHOW commands, never a query of the data, and nothing started, stopped or created.
    expect(data).toContain("EXECUTE IMMEDIATE 'SHOW TERSE DATABASES'");
    expect(data).toContain('SHOW TERSE OBJECTS IN DATABASE');
    expect(data).not.toMatch(/SELECT|RESUME|SUSPEND;|CREATE /);
    // The same test ZLens itself uses: not the app's own database, an application or package, or Snowflake's,
    // and a table or view outside INFORMATION_SCHEMA. NULL when it cannot tell.
    expect(data).toContain("NOT LIKE 'APPLICATION%'");
    expect(data).toContain('UPPER(:db_name) <> UPPER(CURRENT_DATABASE())');
    expect(data).toContain("NOT IN ('SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA', 'SNOWFLAKE_LEARNING_DB')");
    expect(data).toContain("UPPER(obj.\"schema_name\") <> 'INFORMATION_SCHEMA'");
    expect(data).toMatch(/EXCEPTION WHEN OTHER THEN\s+RETURN NULL;/);
    expect(setup).toContain('GRANT USAGE ON PROCEDURE app_public.launcher_data() TO APPLICATION ROLE app_user;');
    // The page: the grant step on the ready and the starting screens while none is readable (V17 p8 tester: one
    // press of Run ran 1 of 8 grant lines and the page said "ZLens is ready"), and the names once one is.
    expect(page).toContain('\ndata = read_data()\n');
    const ready = branch(page, 'if name == "READY" and status["url"]:');
    expect(ready).toMatch(/if data == \[\]:\n\s+show_missing_data\(app\)\n\s+st\.success/);
    expect(ready).toContain(`reads = f", and can read {', '.join(data)}" if data else ""`);
    expect(page).toMatch(/elapsed = now - state\["started_at"\]\nif data == \[\]:\n\s+show_missing_data\(app\)/);
    expect(page).toContain('"**One step is missing: grant ZLens a database.** ZLens can read none of your data yet.');
    // A failed read says nothing about data, so the page never says a database is missing when it cannot tell.
    expect(page).toMatch(/def read_data\(\):[\s\S]*?except Exception:[^\n]*\n\s+return None\n\s+if not isinstance\(value, list\):\n\s+return None/);
    // The set-up screen and the grant step show the same lines, with the same advice on Snowsight's Run.
    expect(page.match(/st\.code\(grant_lines\(app\), language="sql"\)/g)).toHaveLength(2);
    expect(page).toContain('RUN_ALL = "Select all the lines, then press Run: Snowsight\'s Run on its own runs only the statement at the cursor."');
    const firstOpen = readme.slice(readme.indexOf('## The first open'), readme.indexOf('## What ZLens does first'));
    expect(firstOpen).toContain('**If the page says "One step is missing: grant ZLens a database"**');
  });

  it('V17 p9: no line of an earlier screen stays faded under the current one', () => {
    const page = read('launcher/launcher.py');
    // Streamlit drops an earlier screen's lines only when a run ends, and each checking screen ends its run with a
    // rerun (V17 p8 tester: a set-up line stayed faded under "ZLens is ready" for 10 minutes).
    expect(Number(/^LEFTOVER_SLOTS = (\d+)$/m.exec(page)?.[1])).toBeGreaterThanOrEqual(12);
    expect(page).toMatch(/def clear_leftovers\(\):[\s\S]*?for _ in range\(LEFTOVER_SLOTS\):\n\s+st\.empty\(\)/);
    const sleeps = [...page.matchAll(/\n\s*time\.sleep\(\w+\)/g)];
    expect(sleeps).toHaveLength(3);
    for (const sleep of sleeps) expect(page.slice(0, sleep.index).trimEnd().endsWith('clear_leftovers()')).toBe(true);
  });

  it('V17 p9: the readme explains the Future upgrades privileges Snowflake lists in the Get dialog', () => {
    // Snowflake's privileges for automatic grants (manifest version 2); the Get dialog lists those the app does not
    // ask for under Future upgrades (V17 p8 tester: the readme said "no listings, shares" with no word on them).
    const automatic = ['EXECUTE TASK', 'EXECUTE MANAGED TASK', 'CREATE WAREHOUSE', 'CREATE COMPUTE POOL', 'BIND SERVICE ENDPOINT', 'CREATE DATABASE', 'CREATE EXTERNAL ACCESS INTEGRATION', 'CREATE SECURITY INTEGRATION', 'CREATE SHARE', 'CREATE LISTING'];
    const manifest = yaml.load(read('manifest.yml')) as { manifest_version: number; privileges: Array<Record<string, unknown>> };
    expect(manifest.manifest_version).toBe(2);
    const asked = manifest.privileges.map((entry) => Object.keys(entry)[0]!);
    expect(asked).toEqual(['BIND SERVICE ENDPOINT', 'CREATE COMPUTE POOL', 'CREATE WAREHOUSE']);
    const privileges = readme.slice(readme.indexOf('## Privileges'), readme.indexOf('## What ZLens reaches')).replace(/\s+/g, ' ');
    expect(privileges).toContain('under **Future upgrades**');
    for (const name of automatic.filter((name) => !asked.includes(name))) expect(privileges).toContain(`\`${name}\``);
    expect(privileges).toContain('This version asks for none of them, and no version can add one in a patch.');
    expect(privileges).toContain('feature policy');
  });

  it('V4: the cost section says an open ZLens tab does not keep ZLens running', () => {
    const minutes = /idle_minutes VARCHAR DEFAULT '(\d+)'/.exec(setup)?.[1];
    const cost = readme.slice(readme.indexOf('### What it costs to run'), readme.indexOf('## Privileges'));
    expect(cost).toContain(`An open ZLens tab does not keep it running: ZLens stops after ${minutes} minutes with no one using it.`);
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
