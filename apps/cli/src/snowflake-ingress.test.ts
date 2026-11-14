import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { sameOriginAsHost, snowflakeIngressFromEnv, snowflakeIngressRefusal, snowflakeIngressRefusalPage, snowflakeSignedInUser, withSnowflakeUser } from './snowflake-ingress.js';
import { localPersonIdentity, localPersonName } from './certification-receipt.js';

/**
 * ZLens inside Snowflake (the ZLens app): Snowflake signs the person in and names them in
 * Sf-Context-Current-User; the free app serves one named person.
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('when the Snowflake sign-in counts', () => {
  it('only with ZLENS_SNOWFLAKE_INGRESS set AND inside a Snowflake container (its token file)', () => {
    const inside = () => true;
    const outside = () => false;
    expect(snowflakeIngressFromEnv({ ZLENS_SNOWFLAKE_INGRESS: '1', ZLENS_SNOWFLAKE_APP_USER: 'ana' }, inside)).toEqual({ appUser: 'ana' });
    expect(snowflakeIngressFromEnv({ ZLENS_SNOWFLAKE_INGRESS: '1' }, inside)).toEqual({});
    // Anywhere else the header could come from anyone: never trusted.
    expect(snowflakeIngressFromEnv({ ZLENS_SNOWFLAKE_INGRESS: '1', ZLENS_SNOWFLAKE_APP_USER: 'ana' }, outside)).toBeUndefined();
    expect(snowflakeIngressFromEnv({}, inside)).toBeUndefined();
  });

  it('refuses a request Snowflake did not sign in, and anyone but the app\'s one person', () => {
    expect(snowflakeIngressRefusal({ appUser: 'ZLENS_TEST_EAST' }, undefined)).toMatchObject({ status: 401, code: 'SNOWFLAKE_SIGN_IN_REQUIRED' });
    expect(snowflakeIngressRefusal({ appUser: 'ZLENS_TEST_EAST' }, 'ZLENS_TEST_WEST')).toMatchObject({ status: 403, code: 'NOT_THIS_APPS_USER' });
    expect(snowflakeIngressRefusal({ appUser: 'ZLENS_TEST_EAST' }, 'zlens_test_east')).toBeUndefined();
    expect(snowflakeIngressRefusal({}, 'ANYONE')).toBeUndefined();
    // The refusal never names the app's person to someone else.
    expect(snowflakeIngressRefusal({ appUser: 'PRIVATE_PERSON_NAME' }, 'B')?.error).not.toContain('PRIVATE_PERSON_NAME');
  });

  it('accepts the page\'s own address as its origin (Snowflake makes the address; it is not known in advance)', () => {
    expect(sameOriginAsHost('https://abc-org-acct.snowflakecomputing.app', 'abc-org-acct.snowflakecomputing.app')).toBe(true);
    expect(sameOriginAsHost('https://evil.example', 'abc-org-acct.snowflakecomputing.app')).toBe(false);
    expect(sameOriginAsHost('http://abc-org-acct.snowflakecomputing.app', 'abc-org-acct.snowflakecomputing.app')).toBe(false);
    expect(sameOriginAsHost(undefined, 'h')).toBe(false);
    expect(snowflakeIngressRefusalPage('<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('who is acting, inside Snowflake', () => {
  it('is the user the trusted ingress names, for that work only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-sf-person-'));
    roots.push(root);
    const outside = localPersonIdentity(root);
    expect(withSnowflakeUser({}, 'TEST_ADMIN', () => localPersonIdentity(root))).toBe('TEST_ADMIN');
    expect(withSnowflakeUser({}, ['TEST_ADMIN'], () => localPersonName(root))).toBe('TEST_ADMIN');
    // It follows the work across awaits, and ends with it.
    expect(await withSnowflakeUser({}, ' TEST_ADMIN ', async () => { await new Promise((done) => setTimeout(done, 1)); return snowflakeSignedInUser(); })).toBe('TEST_ADMIN');
    expect(snowflakeSignedInUser()).toBeUndefined();
    expect(localPersonIdentity(root)).toBe(outside);
  });

  it('is never the header without the ingress, or with no user in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-sf-person-'));
    roots.push(root);
    expect(withSnowflakeUser(undefined, 'TEST_ADMIN', () => snowflakeSignedInUser())).toBeUndefined();
    expect(withSnowflakeUser(undefined, 'TEST_ADMIN', () => localPersonIdentity(root))).not.toBe('TEST_ADMIN');
    expect(withSnowflakeUser({}, '  ', () => snowflakeSignedInUser())).toBeUndefined();
    expect(withSnowflakeUser({}, undefined, () => snowflakeSignedInUser())).toBeUndefined();
  });
});

describe('the server inside Snowflake', () => {
  async function start(host = '127.0.0.1') {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-sf-ingress-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, host,
      snowflakeIngress: { appUser: 'ZLENS_TEST_EAST' },
      captureServer: (created) => { servers.push(created); },
    });
    return Object.assign((path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers }), { port });
  }

  /** fetch() will not send a Host header of the test's choosing; a plain request will. */
  function statusWithHost(port: number, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const sent = request({ host: '127.0.0.1', port, path, headers }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on('error', reject);
      sent.end();
    });
  }

  it('serves its one person, refuses everyone else, and keeps the readiness check open', async () => {
    const call = await start();
    expect((await call('/api/connections', { 'Sf-Context-Current-User': 'ZLENS_TEST_EAST' })).status).toBe(200);
    const other = await call('/api/connections', { 'Sf-Context-Current-User': 'ZLENS_TEST_WEST' });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: 'NOT_THIS_APPS_USER' });
    expect((await call('/api/connections')).status).toBe(401);
    const page = await call('/', { 'Sf-Context-Current-User': 'ZLENS_TEST_WEST' });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('set up for one person');
    expect((await call('/api/health')).status).toBe(200);
    // Its own address is its origin; another site's is not.
    const host = 'abc-org-acct.snowflakecomputing.app';
    expect(await statusWithHost(call.port, '/api/connections', { 'Sf-Context-Current-User': 'ZLENS_TEST_EAST', Origin: `https://${host}`, Host: host })).toBe(200);
    const fromElsewhere = await call('/api/connections', { 'Sf-Context-Current-User': 'ZLENS_TEST_EAST', Origin: 'https://evil.example' });
    expect(fromElsewhere.status).toBe(403);
  });

  it('starts on every interface with no shared token or origin list: Snowflake signs people in', async () => {
    const call = await start('0.0.0.0');
    expect((await call('/api/connections', { 'Sf-Context-Current-User': 'ZLENS_TEST_EAST' })).status).toBe(200);
  });
});
