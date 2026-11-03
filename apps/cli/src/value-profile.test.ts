import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { QueryExecutor } from '@zlens/connectors';
import type { WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { VALUE_PROFILE_PATH, includedColumn, isSensitiveColumn, letterFree, roundedRange, isSensitiveValue, profileWarehouseValues, readValueProfile, refreshValueProfile, removeValueProfile, renderColumnProfile, resolveValueProfilePolicy, valueProfileAllowed, writeValueProfile } from './value-profile.js';

describe('the value profile', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  const warehouse = () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-value-profile-'));
    roots.push(root);
    const file = join(root, 'shop.sqlite');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, status TEXT, delivered_at TEXT, amount REAL, customer_email TEXT, note TEXT);
      INSERT INTO orders VALUES
        (1, 'delivered', '12/31/2021 11:45 PM', 20.5, 'ann@example.com', 'call ann@example.com'),
        (2, 'delivered', '01/02/2022 09:10 AM', 7.0, 'bo@example.com', 'call ann@example.com'),
        (3, 'canceled', NULL, 99.0, 'cy@example.com', 'gift'),
        (4, 'delivered', '01/03/2022 10:00 AM', 12.0, 'di@example.com', 'gift'),
        (5, 'delivered', '01/04/2022 10:00 AM', 15.0, 'ed@example.com', 'call ann@example.com');
    `);
    db.close();
    const snapshot: WarehouseCatalogSnapshotV1 = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }], capturedAt: '2026-09-22T00:00:00.000Z', fingerprint: 'sha256:catalog-a',
      relations: [{ id: 'warehouse.main.orders', schema: 'main', name: 'orders', relation: 'main.orders', kind: 'table', columns: [
        { name: 'order_id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }, { name: 'delivered_at', type: 'TEXT' }, { name: 'amount', type: 'REAL' }, { name: 'customer_email', type: 'TEXT' }, { name: 'note', type: 'TEXT' },
      ] }],
    } as WarehouseCatalogSnapshotV1;
    // The CLI's own better-sqlite3, as a project's .dql/connectors would provide it.
    return { root, connection: { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never, snapshot };
  };

  it('is off unless the project opts in', () => {
    expect(resolveValueProfilePolicy(undefined).mode).toBe('off');
    expect(resolveValueProfilePolicy({}).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'yes' } } }).mode).toBe('off');
    expect(resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }).mode).toBe('sampled');
    // Ask may show it only while opted in, and never under a host.
    expect(valueProfileAllowed(undefined, false)).toBe(false);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'off' } } }, false)).toBe(false);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'sampled' } } }, false)).toBe(true);
    expect(valueProfileAllowed({ agent: { valueProfile: { mode: 'sampled' } } }, true)).toBe(false);
  });

  it('never reads a column whose name marks it sensitive, and honours the project exclusions', () => {
    const policy = resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled', exclude: ['^internal_', '(invalid'] } } });
    for (const name of ['customer_email', 'phone_number', 'ssn', 'api_key', 'date_of_birth', 'home_address', 'internal_notes', 'first_name', 'last_name', 'username', 'annual_salary']) expect(isSensitiveColumn(name, policy), name).toBe(true);
    for (const name of ['status', 'product_name', 'location_name', 'order_moment_delivered', 'country']) expect(isSensitiveColumn(name, policy), name).toBe(false);
    // A name column of a table of people is a person's name; of a product, a store or a team it is not.
    for (const [column, relation] of [['name', 'main.customers'], ['customer_name', 'dev.customers'], ['display_name', '"app"."users"']]) expect(isSensitiveColumn(column!, policy, relation), `${relation}.${column}`).toBe(true);
    for (const [column, relation] of [['name', 'main.products'], ['location_name', 'dev.locations'], ['team_name', 'main.teams']]) expect(isSensitiveColumn(column!, policy, relation), `${relation}.${column}`).toBe(false);
  });

  it('drops a sampled value that is itself personal data or a secret', () => {
    // Credential shapes are assembled here so the secret scanner does not read the test as a leak.
    const stripeLike = ['sk', 'live', 'abcdef123456'].join('_');
    const awsLike = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    for (const value of ['ann@example.com', '123-45-6789', '+1 (555) 010-2030', 'https://x.example/a', stripeLike, awsLike]) expect(isSensitiveValue(value), value).toBe(true);
    for (const value of ['555-010-2030', '(555) 010-2030']) expect(isSensitiveValue(value), value).toBe(true);
    for (const value of ['delivered', '12/31/2021 11:45 PM', '2021-12-31', '2021-12-31 23:45:00', '20210', 'Philadelphia', 'jaffle']) expect(isSensitiveValue(value), value).toBe(false);
  });

  it('records the most frequent stored values of text columns and the range of numbers, and stores them outside git', async () => {
    const { root, connection, snapshot } = warehouse();
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }) });
    const orders = profile.relations['main.orders']!;
    expect(orders.status).toEqual({ examples: ['delivered'] });
    expect(orders.amount).toEqual({ min: '7', max: '99' });
    expect(orders.customer_email).toBeUndefined();
    // A value only one or two rows hold is that row's: never kept, whatever the column is called.
    expect(orders.delivered_at).toBeUndefined();
    // A free-text column keeps only what enough rows share, and never an email address, however often.
    expect(orders.note).toBeUndefined();
    expect(profile.skippedSensitive).toBe(1);
    expect(profile.skippedIdentifying).toBe(1);

    const path = writeValueProfile(root, profile);
    expect(path).toContain(join('.dql', 'cache'));
    expect(readValueProfile(root, 'sha256:catalog-a')?.relations['main.orders']?.status).toEqual({ examples: ['delivered'] });
    // A profile of another catalog, or of no known catalog, is not evidence about this one.
    expect(readValueProfile(root, 'sha256:catalog-b')).toBeUndefined();
    expect(readValueProfile(root, undefined)).toBeUndefined();
    expect(renderColumnProfile(orders.status)).toBe(" holds 'delivered'");
    expect(renderColumnProfile(orders.amount)).toBe(' ranges 7 to 99');
    // Switched off: the profile goes, and nothing reads it again.
    removeValueProfile(root);
    expect(readValueProfile(root, 'sha256:catalog-a')).toBeUndefined();
  });

  it('a table of people under cryptic names gives away no name: no value repeats', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-value-profile-'));
    roots.push(root);
    const file = join(root, 'hr.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE t_ppl (prs_id INTEGER PRIMARY KEY, fll_nm TEXT, dpt_cd TEXT, sl_amt REAL)');
    const insert = db.prepare('INSERT INTO t_ppl VALUES (?, ?, ?, ?)');
    ['Emma Van Zant', 'Zala Ibrahimagic', 'David Smith', 'Ann Lee', 'Bo Chen', 'Cy Diaz'].forEach((name, index) => insert.run(index + 1, name, index % 2 ? 'OPS' : 'FIN', 41234.56 + index * 9137.11));
    db.close();
    const snapshot = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [], capturedAt: 'x', fingerprint: 'sha256:hr',
      relations: [{ id: 'warehouse.main.t_ppl', schema: 'main', name: 't_ppl', relation: 'main.t_ppl', kind: 'table', columns: [{ name: 'prs_id', type: 'INTEGER' }, { name: 'fll_nm', type: 'TEXT' }, { name: 'dpt_cd', type: 'TEXT' }, { name: 'sl_amt', type: 'REAL' }] }],
    } as unknown as WarehouseCatalogSnapshotV1;
    const connection = { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never;
    const policy = resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } });
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection, snapshot, policy });
    const people = profile.relations['main.t_ppl']!;
    // The name rules can't read `fll_nm`; the values themselves say it's one per row.
    expect(isSensitiveColumn('fll_nm', policy, 'main.t_ppl')).toBe(false);
    expect(people.fll_nm).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain('Emma');
    expect(people.dpt_cd).toEqual({ examples: expect.arrayContaining(['FIN', 'OPS']) });
    // A range is the scale, not one person's pay to the cent.
    expect(people.sl_amt).toEqual({ min: '41000', max: '87000' });
    expect(profile.skippedIdentifying).toBe(1);

    // Where names say nothing, `include` reads only the columns listed.
    const listed = await profileWarehouseValues({ executor: new QueryExecutor(), connection, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled', include: ['^dpt_cd$'] } } }) });
    expect(Object.keys(listed.relations['main.t_ppl']!)).toEqual(['dpt_cd']);
  });

  it('include matches a column alone or with its table', () => {
    const policy = resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled', include: ['^t_ord\\.sts$', '^dpt_cd$', '(invalid'] } } });
    expect(includedColumn('sts', policy, 'sl.t_ord')).toBe(true);
    expect(includedColumn('sts', policy, 'sl.t_inv')).toBe(false);
    expect(includedColumn('dpt_cd', policy, 'hr.t_ppl')).toBe(true);
    expect(includedColumn('anything', resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }), 'x.y')).toBe(true);
  });

  it('a name many rows share is still a name: a column of many distinct values keeps only values with no letters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-value-profile-'));
    roots.push(root);
    const file = join(root, 'sales.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE t_inv (inv_id INTEGER PRIMARY KEY, cnf_rcv_by TEXT, inv_dt TEXT, dlv_mth TEXT)');
    const insert = db.prepare('INSERT INTO t_inv VALUES (?, ?, ?, ?)');
    // 80 people each sign for five invoices; 60 days each see several invoices; two delivery methods.
    for (let index = 0; index < 400; index += 1) insert.run(index + 1, `Signer Number${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + Math.floor(index / 26) % 4)} Person`, `2013-0${1 + (index % 6)}-${String(10 + (index % 10)).padStart(2, '0')}`, index % 3 ? 'Delivery Van' : 'Customer Collect');
    db.close();
    const snapshot = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [], capturedAt: 'x', fingerprint: 'sha256:inv',
      relations: [{ id: 'warehouse.main.t_inv', schema: 'main', name: 't_inv', relation: 'main.t_inv', kind: 'table', columns: [{ name: 'inv_id', type: 'INTEGER' }, { name: 'cnf_rcv_by', type: 'TEXT' }, { name: 'inv_dt', type: 'TEXT' }, { name: 'dlv_mth', type: 'TEXT' }] }],
    } as unknown as WarehouseCatalogSnapshotV1;
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection: { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }) });
    const invoices = profile.relations['main.t_inv']!;
    expect(invoices.cnf_rcv_by).toBeUndefined();
    expect(invoices.dlv_mth).toEqual({ examples: ['Delivery Van', 'Customer Collect'] });
    expect(invoices.inv_dt?.examples?.every((value) => /^2013-0\d-\d\d$/.test(value))).toBe(true);
    expect(profile.skippedIdentifying).toBe(1);
  });

  it('an archive of people is not a list of categories, though each name appears on three versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-value-profile-'));
    roots.push(root);
    const file = join(root, 'archive.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE t_cst_arc (cst_id INTEGER, cst_nm TEXT, sts TEXT)');
    const insert = db.prepare('INSERT INTO t_cst_arc VALUES (?, ?, ?)');
    insert.run(1, 'Olya Izmaylov', 'active'); insert.run(1, 'Olya Izmaylov', 'active'); insert.run(1, 'Olya Izmaylov', 'lapsed');
    for (let index = 2; index < 40; index += 1) insert.run(index, `Customer ${index}A Person`, index % 2 ? 'active' : 'lapsed');
    db.close();
    const snapshot = {
      version: 1, driver: 'sqlite', connectionId: 'default', scopes: [], capturedAt: 'x', fingerprint: 'sha256:arc',
      relations: [{ id: 'warehouse.main.t_cst_arc', schema: 'main', name: 't_cst_arc', relation: 'main.t_cst_arc', kind: 'table', columns: [{ name: 'cst_id', type: 'INTEGER' }, { name: 'cst_nm', type: 'TEXT' }, { name: 'sts', type: 'TEXT' }] }],
    } as unknown as WarehouseCatalogSnapshotV1;
    const profile = await profileWarehouseValues({ executor: new QueryExecutor(), connection: { driver: 'sqlite', filepath: file, moduleSearchPaths: [process.cwd()] } as never, snapshot, policy: resolveValueProfilePolicy({ agent: { valueProfile: { mode: 'sampled' } } }) });
    expect(JSON.stringify(profile)).not.toContain('Olya');
    expect(profile.relations['main.t_cst_arc']?.sts?.examples).toEqual(expect.arrayContaining(['active', 'lapsed']));
  });

  it('a value with no letters but a date\'s is letter-free', () => {
    expect(['2013-01-31', '12/31/2021 11:45 PM', '2021-12-31T23:45:00Z', '31 Dec 2021', '00042'].every(letterFree)).toBe(true);
    expect(['Emma Van Zant', 'INV-0042', 'David', 'São Paulo', 'Julia', 'Marie', 'Augustus', 'Novak'].some(letterFree)).toBe(false);
  });

  it('a range keeps two significant figures', () => {
    expect(['7', '99', '0.987', '171233410.25', '-1234', '0', 'abc'].map((value) => roundedRange(value))).toEqual(['7', '99', '0.99', '170000000', '-1200', '0', 'abc']);
  });

  it('a sync reads values only when opted in and not under a host; otherwise it removes what was read before', async () => {
    const { root, connection, snapshot } = warehouse();
    const executor = new QueryExecutor();
    const sync = (config: Parameters<typeof resolveValueProfilePolicy>[0], hosted = false) => refreshValueProfile({ projectRoot: root, config, executor, connection, snapshot, hosted });

    expect(await sync({ agent: { valueProfile: { mode: 'sampled' } } })).toMatchObject({ relations: 1, skippedSensitive: 1 });
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(true);
    // Switched off (or never on): nothing read, the earlier profile removed.
    expect(await sync(undefined)).toBeUndefined();
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(false);

    writeValueProfile(root, { version: 1, catalogFingerprint: 'sha256:catalog-a', capturedAt: 'x', relations: {}, skippedSensitive: 0 });
    // Under a host: each reader's row and column policies decide; nothing is read, the earlier profile goes.
    const hosted = await sync({ agent: { valueProfile: { mode: 'sampled' } } }, true);
    expect(hosted).toMatchObject({ skipped: expect.stringContaining('host') });
    expect(existsSync(join(root, VALUE_PROFILE_PATH))).toBe(false);
  });
});
