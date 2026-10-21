import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DUCKDB_EXTENSION_DOWNLOADS_OFF,
  DuckDBConnector,
  duckDBAutoinstallOff,
  extensionDownloadsOffMessage,
  missingDuckDBExtensionName,
  normalizeDuckDBRow,
  normalizeDuckDBValue,
  resolveDuckDBModule,
} from './duckdb.js';
import { readEnv } from '../env.js';

const configuredDuckDbConnectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = configuredDuckDbConnectorRoot ? it : it.skip;

describe('resolveDuckDBModule', () => {
  it('accepts a direct Database export', () => {
    class Database {}
    expect(resolveDuckDBModule({ Database })).toEqual({ Database });
  });

  it('accepts a CommonJS default export shape', () => {
    class Database {}
    expect(resolveDuckDBModule({ default: { Database } })).toEqual({ Database });
  });

  it('throws when Database is missing', () => {
    expect(() => resolveDuckDBModule({ default: {} })).toThrow('Database constructor');
  });
});

describe('normalizeDuckDBValue', () => {
  it('converts safe bigint values to numbers', () => {
    expect(normalizeDuckDBValue(42n)).toBe(42);
  });

  it('converts unsafe bigint values to strings', () => {
    expect(normalizeDuckDBValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe((BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString());
  });

  it('normalizes nested row values', () => {
    expect(normalizeDuckDBRow({
      revenue: 10n,
      breakdown: { total: 20n },
      points: [1n, 2n],
    })).toEqual({
      revenue: 10,
      breakdown: { total: 20 },
      points: [1, 2],
    });
  });
});

describe('DuckDBConnector execution control', () => {
  it('interrupts a pending native query on abort and ignores its late callback', async () => {
    const connector = new DuckDBConnector();
    let callback: ((error: Error | null, rows: unknown) => void) | undefined;
    const interrupt = vi.fn();
    const all = vi.fn((...args: unknown[]) => {
      callback = args.at(-1) as ((error: Error | null, rows: unknown) => void);
    });
    (connector as unknown as { connection: unknown; db: unknown }).connection = { all, interrupt };
    const controller = new AbortController();

    const pending = connector.execute('SELECT slow_value', undefined, { signal: controller.signal, deadlineMs: 10_000 });
    const cancelled = expect(pending).rejects.toThrow('DuckDB query was cancelled: Ask run cancelled.');
    expect(all).toHaveBeenCalledTimes(1);
    controller.abort(new Error('Ask run cancelled'));

    await cancelled;
    expect(interrupt).toHaveBeenCalledTimes(1);
    // node-duckdb can still invoke the callback after interrupt. It must not
    // revive a cancelled Ask execution or resolve a second result.
    callback?.(null, [{ slow_value: 42 }]);
    await Promise.resolve();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('interrupts a pending native query when its connector deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      const connector = new DuckDBConnector();
      const interrupt = vi.fn();
      const all = vi.fn();
      (connector as unknown as { connection: unknown; db: unknown }).connection = { all, interrupt };

      const pending = connector.execute('SELECT slow_value', undefined, { deadlineMs: 25 });
      const timedOut = expect(pending).rejects.toThrow('DuckDB query exceeded the 25ms deadline.');
      await vi.advanceTimersByTimeAsync(25);

      await timedOut;
      expect(interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DuckDB consistent App read scope', () => {
  duckDbIt('copies the active schema and holds its own same-Database snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-scope-'));
    const filepath = join(directory, 'scope.duckdb');
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await connector.execute('CREATE SCHEMA analytics');
      await connector.execute('CREATE TABLE main.scope_values (value INTEGER)');
      await connector.execute('INSERT INTO main.scope_values VALUES (1)');
      await connector.execute('CREATE TABLE analytics.scope_values (value INTEGER)');
      await connector.execute('INSERT INTO analytics.scope_values VALUES (2)');
      await connector.execute('SET schema = analytics');

      const scope = await connector.openConsistentReadScope();
      try {
        expect(scope.context.schema).toBe('analytics');
        expect((await scope.execute('SELECT value FROM scope_values')).rows).toEqual([{ value: 2 }]);
        await connector.execute('INSERT INTO analytics.scope_values VALUES (3)');
        expect((await scope.execute('SELECT value FROM scope_values ORDER BY value')).rows).toEqual([{ value: 2 }]);
      } finally {
        await scope.close();
      }
      expect((await connector.execute('SELECT value FROM analytics.scope_values ORDER BY value')).rows).toEqual([{ value: 2 }, { value: 3 }]);
    } finally {
      await connector.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('DuckDB database lifetime', () => {
  // duckdb-node frees a closed native instance only when its Connection and
  // Statement objects are garbage-collected. Force that moment instead of
  // waiting for it, which is when a stale instance used to delete the WAL.
  const collectGarbage = async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let pass = 0; pass < 3; pass += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const count = async (connector: DuckDBConnector) =>
    (await connector.execute('SELECT COUNT(*)::INTEGER AS n, COUNT(value)::INTEGER AS keyed FROM lifetime_values')).rows[0];

  duckDbIt('keeps commits made after a reconnect when the closed database is finally destroyed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-lifetime-'));
    const filepath = join(directory, 'lifetime.duckdb');
    const config = { driver: 'duckdb' as const, filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] };
    const first = new DuckDBConnector();
    const second = new DuckDBConnector();
    const third = new DuckDBConnector();
    try {
      await first.connect(config);
      await first.execute('CREATE TABLE lifetime_values (value INTEGER)');
      await first.execute('INSERT INTO lifetime_values VALUES (1), (1)');
      expect(await count(first)).toEqual({ n: 2, keyed: 2 });
      await first.disconnect();

      await second.connect(config);
      await second.execute('DELETE FROM lifetime_values');
      await second.execute('INSERT INTO lifetime_values VALUES (1), (NULL)');
      await second.disconnect();
      await collectGarbage();

      await third.connect(config);
      expect(await count(third)).toEqual({ n: 2, keyed: 1 });
    } finally {
      await first.disconnect();
      await second.disconnect();
      await third.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  duckDbIt('serves differently configured connectors on one file from one database until the last disconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-shared-'));
    const filepath = join(directory, 'shared.duckdb');
    // Pool keys differ (module search paths, path spelling) but the file is
    // the same, so both connectors must read and write one native instance.
    const writer = new DuckDBConnector();
    const reader = new DuckDBConnector();
    try {
      await writer.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await reader.connect({ driver: 'duckdb', filepath: join(directory, '.', 'shared.duckdb'), moduleSearchPaths: [configuredDuckDbConnectorRoot!, directory] });
      await writer.execute('CREATE TABLE lifetime_values (value INTEGER)');
      await writer.execute('INSERT INTO lifetime_values VALUES (1)');
      expect(await count(reader)).toEqual({ n: 1, keyed: 1 });

      const scope = await writer.openConsistentReadScope();
      await writer.disconnect();
      await expect(scope.execute('SELECT 1')).rejects.toThrow('DuckDB consistent read scope is closed.');
      await reader.execute('INSERT INTO lifetime_values VALUES (NULL)');
      expect(await count(reader)).toEqual({ n: 2, keyed: 1 });
      await reader.disconnect();
      await collectGarbage();

      await writer.connect({ driver: 'duckdb', filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      expect(await count(writer)).toEqual({ n: 2, keyed: 1 });
    } finally {
      await writer.disconnect();
      await reader.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  duckDbIt('keeps in-memory databases private to their connector', async () => {
    const first = new DuckDBConnector();
    const second = new DuckDBConnector();
    try {
      await first.connect({ driver: 'duckdb', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await second.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await first.execute('CREATE TABLE only_first (value INTEGER)');
      await expect(second.execute('SELECT * FROM only_first')).rejects.toThrow();
    } finally {
      await first.disconnect();
      await second.disconnect();
    }
  });
});

/**
 * A stand-in `duckdb` module that records every statement per connection, so the
 * settings a connection starts with can be checked without the native driver.
 */
function stubDuckDBModule(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-duckdb-stub-'));
  const dir = join(root, 'node_modules', 'duckdb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'duckdb', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), `
const log = [];
class Connection {
  constructor() { this.statements = []; log.push(this.statements); }
  all(sql, ...args) {
    const callback = args[args.length - 1];
    this.statements.push(sql);
    const rows = /current_schema/.test(sql) ? [{ __dql_schema: 'main' }] : /TimeZone/.test(sql) ? [{ __dql_timezone: 'UTC' }] : [];
    process.nextTick(() => callback(null, rows));
  }
  close(callback) { if (callback) callback(); }
}
class Database {
  constructor(path, callback) { process.nextTick(() => callback(null)); }
  connect() { return new Connection(); }
  close(callback) { if (callback) callback(null); }
}
module.exports = { Database, log };
`);
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

const SWITCH_NAMES = ['ZLENS_DUCKDB_AUTOINSTALL', 'DQL_DUCKDB_AUTOINSTALL'] as const;

describe('extension downloads (ZLENS_DUCKDB_AUTOINSTALL)', () => {
  const stubRoot = stubDuckDBModule();
  const stub = createRequire(join(stubRoot, 'package.json'))('duckdb') as { log: string[][] };
  const saved: Partial<Record<(typeof SWITCH_NAMES)[number], string | undefined>> = {};
  beforeAll(() => { for (const name of SWITCH_NAMES) saved[name] = process.env[name]; });
  beforeEach(() => {
    stub.log.length = 0;
    for (const name of SWITCH_NAMES) delete process.env[name];
  });
  afterAll(() => {
    for (const name of SWITCH_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(stubRoot, { recursive: true, force: true });
  });
  /** What ran on every connection before its first statement that is not the connector's own setup. */
  const setupOf = (statements: string[]): string[] => {
    const first = statements.findIndex((sql) => !/^(?:PRAGMA disable_checkpoint_on_shutdown|SET autoinstall_known_extensions|SET autoload_known_extensions|CHECKPOINT)\b/.test(sql));
    return first === -1 ? [] : statements.slice(0, first);
  };
  const SETTINGS = [...DUCKDB_EXTENSION_DOWNLOADS_OFF];

  it('reads the switch: off, false, 0 or no turn downloads off; unset or on keeps DuckDB\'s default', () => {
    for (const value of ['off', 'false', '0', 'no', 'OFF']) expect(duckDBAutoinstallOff({ ZLENS_DUCKDB_AUTOINSTALL: value })).toBe(true);
    for (const value of [undefined, '', 'on', 'true']) expect(duckDBAutoinstallOff({ ZLENS_DUCKDB_AUTOINSTALL: value })).toBe(false);
  });

  it('reads the old name DQL_DUCKDB_AUTOINSTALL when the new one is not set; the new one wins when both are', () => {
    expect(duckDBAutoinstallOff({ DQL_DUCKDB_AUTOINSTALL: 'off' })).toBe(true);
    expect(duckDBAutoinstallOff({ ZLENS_DUCKDB_AUTOINSTALL: 'on', DQL_DUCKDB_AUTOINSTALL: 'off' })).toBe(false);
    expect(duckDBAutoinstallOff({ ZLENS_DUCKDB_AUTOINSTALL: 'off', DQL_DUCKDB_AUTOINSTALL: 'on' })).toBe(true);
  });

  async function exercise(filepath: string): Promise<void> {
    const config = { driver: 'duckdb' as const, filepath, moduleSearchPaths: [stubRoot] };
    const first = new DuckDBConnector();
    const second = new DuckDBConnector();
    try {
      await first.connect(config);
      await first.execute('SELECT 1');
      const scope = await first.openConsistentReadScope();
      await scope.execute('SELECT 2');
      await scope.close();
      // Another connector on the same file shares the open database: a pooled connection, not a new database.
      await second.connect(config);
      await second.execute('SELECT 3');
    } finally {
      await second.disconnect();
      await first.disconnect();
    }
  }

  it('by default (unset) no connection is told anything about extensions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-default-'));
    try {
      await exercise(join(directory, 'w.duckdb'));
      const all = stub.log.flat();
      expect(all).toContain('SELECT 1');
      expect(all).toContain('SELECT 3');
      expect(all.filter((sql) => /autoinstall|autoload|INSTALL/i.test(sql))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('off: both settings are issued on every new connection, before anything else runs on it (the database, each connector, each read scope, a pooled reopen)', async () => {
    process.env.ZLENS_DUCKDB_AUTOINSTALL = 'off';
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-off-'));
    try {
      await exercise(join(directory, 'w.duckdb'));
      // The database's own setup connection: the pragma, then both settings.
      expect(stub.log[0]).toEqual(['PRAGMA disable_checkpoint_on_shutdown', ...SETTINGS]);
      // The first connector's connection: both settings, then its statement.
      expect(stub.log[1].slice(0, 3)).toEqual([...SETTINGS, 'SELECT 1']);
      const used = stub.log.filter((statements) => setupOf(statements).length > 0 || statements.some((sql) => /^SELECT [123]$/.test(sql)));
      // The connector, its read scope and the second connector's pooled connection.
      expect(used.length).toBeGreaterThanOrEqual(3);
      for (const statements of used) expect(setupOf(statements), statements.join(' | ')).toEqual(expect.arrayContaining(SETTINGS));
      expect(stub.log.flat().filter((sql) => /^SELECT [123]$/.test(sql))).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('off under the old name DQL_DUCKDB_AUTOINSTALL does the same; ZLENS_DUCKDB_AUTOINSTALL=on beside it wins', async () => {
    process.env.DQL_DUCKDB_AUTOINSTALL = 'off';
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [stubRoot] });
    await connector.execute('SELECT 1');
    await connector.disconnect();
    expect(stub.log[1]).toEqual([...SETTINGS, 'SELECT 1']);
    stub.log.length = 0;
    process.env.ZLENS_DUCKDB_AUTOINSTALL = 'on';
    await connector.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [stubRoot] });
    await connector.execute('SELECT 1');
    await connector.disconnect();
    expect(stub.log.flat().filter((sql) => /autoinstall|autoload/.test(sql))).toEqual([]);
  });

  it('off: an INSTALL that would download, or a SET that turns downloading back on, is refused before the engine sees it; a local file still installs', async () => {
    process.env.ZLENS_DUCKDB_AUTOINSTALL = 'off';
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [stubRoot] });
    try {
      const refused = [
        'INSTALL httpfs',
        'install httpfs;',
        'FORCE INSTALL httpfs',
        'INSTALL "httpfs"',
        'INSTALL spatial FROM community',
        "INSTALL httpfs FROM 'http://127.0.0.1:1/'",
        'SELECT 1; INSTALL httpfs',
        '/* nothing */ INSTALL httpfs -- now',
      ];
      for (const sql of refused) {
        await expect(connector.execute(sql), sql).rejects.toThrow(/extension downloads are off on this install \(ZLENS_DUCKDB_AUTOINSTALL=off\): INSTALL (httpfs|spatial) would download it; ask an administrator to bundle it/);
      }
      await expect(connector.execute('SET autoinstall_known_extensions = true')).rejects.toThrow(/extension downloads are off on this install \(ZLENS_DUCKDB_AUTOINSTALL=off\); autoinstall_known_extensions cannot be changed/);
      await expect(connector.execute('RESET autoload_known_extensions')).rejects.toThrow(/autoload_known_extensions cannot be changed/);
      await expect(connector.execute("PRAGMA autoload_known_extensions='true'")).rejects.toThrow(/autoload_known_extensions cannot be changed/);
      const engineSaw = () => stub.log.flat().filter((sql) => /^(?:FORCE\s+)?INSTALL|= true|RESET|PRAGMA autoload/i.test(sql) || /;\s*INSTALL/i.test(sql));
      expect(engineSaw()).toEqual([]);
      // Bundling from disk downloads nothing: these reach the engine.
      const allowed = ["INSTALL httpfs FROM '/opt/zlens/extensions'", "INSTALL '/opt/zlens/extensions/httpfs.duckdb_extension'", 'LOAD httpfs', 'SET autoload_known_extensions = false', "SELECT 'INSTALL httpfs' AS text"];
      const before = stub.log.flat().length;
      for (const sql of allowed) await connector.execute(sql);
      expect(stub.log.flat().slice(before)).toEqual(allowed);
    } finally {
      await connector.disconnect();
    }
  });

  it('names the extension a DuckDB error is about, in each wording the engine uses', () => {
    expect(missingDuckDBExtensionName('Missing Extension Error: File http://x/never.csv requires the extension httpfs to be loaded\n\nPlease try installing and loading the httpfs extension by running:\nINSTALL httpfs;')).toBe('httpfs');
    expect(missingDuckDBExtensionName('Catalog Error: Scalar Function with name "st_point" is not in the catalog, but it exists in the spatial extension.\n\nPlease try installing and loading the spatial extension:')).toBe('spatial');
    expect(missingDuckDBExtensionName("Extension Autoloading Error: An error occurred while trying to automatically install the required extension 'httpfs':\nExtension \"/x/httpfs.duckdb_extension\" not found.")).toBe('httpfs');
    expect(missingDuckDBExtensionName('IO Error: Extension "/x/v1.1.3/osx_arm64/httpfs.duckdb_extension" not found.\nExtension "httpfs" is an existing extension.\n\nInstall it first using "INSTALL httpfs".')).toBe('httpfs');
    expect(missingDuckDBExtensionName('Catalog Error: Table with name orders does not exist!')).toBeUndefined();
    expect(missingDuckDBExtensionName('IO Error: Could not establish connection')).toBeUndefined();
    expect(extensionDownloadsOffMessage('httpfs')).toBe('the httpfs extension is not installed and extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off); ask an administrator to bundle it');
  });

  /** A repository on loopback that records what DuckDB asks for; the egress spy cannot see DuckDB's native HTTP client. */
  async function recordingRepository(): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url ?? ''); res.writeHead(404); res.end('no'); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    return {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      requests,
      close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    };
  }

  duckDbIt('off, with a real DuckDB: a statement that needs an extension the install does not have fails closed with one plain sentence, and no repository is asked for anything', async () => {
    process.env.ZLENS_DUCKDB_AUTOINSTALL = 'off';
    const repository = await recordingRepository();
    // A fresh image has no extension cache (this machine may have ~/.duckdb): an empty folder, as a new task would have.
    const cache = mkdtempSync(join(tmpdir(), 'dql-duckdb-ext-'));
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      const settings = (await connector.execute("SELECT current_setting('autoinstall_known_extensions') AS install, current_setting('autoload_known_extensions') AS load")).rows[0];
      expect([String(settings.install), String(settings.load)]).toEqual(['false', 'false']);
      await connector.execute(`SET extension_directory = '${cache}'`);
      await connector.execute(`SET custom_extension_repository = '${repository.url}'`);
      // Auto-install on first use has its own repository setting (DuckDB 1.1+); by default it is extensions.duckdb.org.
      await connector.execute(`SET autoinstall_extension_repository = '${repository.url}'`).catch(() => undefined);
      const notInstalled = (name: string) => new RegExp(`^DuckDB query failed: the ${name} extension is not installed and extension downloads are off on this install \\(ZLENS_DUCKDB_AUTOINSTALL=off\\); ask an administrator to bundle it$`);
      for (const [sql, name] of [
        ["SELECT * FROM read_csv('http://127.0.0.1:1/never.csv')", 'httpfs'],
        ["SELECT * FROM read_parquet('https://127.0.0.1:1/never.parquet')", 'httpfs'],
        ['SELECT ST_Point(1, 2)', 'spatial'],
        ['LOAD httpfs', 'httpfs'],
      ]) {
        const error = await connector.execute(sql).then(() => null, (failure: unknown) => failure as Error);
        expect(error, sql).toBeInstanceOf(Error);
        expect(error!.message, sql).toMatch(notInstalled(name));
        expect(error!.message, sql).not.toContain(cache);
      }
      await expect(connector.execute('INSTALL httpfs')).rejects.toThrow(/INSTALL httpfs would download it/);
      await expect(connector.execute('SET autoinstall_known_extensions = true')).rejects.toThrow(/cannot be changed by a statement/);
      // A read scope's connection is just as closed.
      const scope = await connector.openConsistentReadScope();
      try {
        await expect(scope.execute("SELECT * FROM read_csv('http://127.0.0.1:1/never.csv')")).rejects.toThrow(notInstalled('httpfs'));
      } finally {
        await scope.close();
      }
      // Extensions built into the driver still load; nothing is fetched for them.
      await connector.execute('LOAD json');
      await connector.execute('LOAD parquet');
      expect((await connector.execute("SELECT json_valid('{\"a\": 1}') AS ok")).rows).toEqual([{ ok: true }]);
      // A restricted engine (RFC 0010) opens on the same database settings without tripping over them.
      const restricted = new DuckDBConnector();
      try {
        await restricted.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [configuredDuckDbConnectorRoot!], restrictExternalAccess: true });
        expect((await restricted.execute('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
        await expect(restricted.execute('INSTALL httpfs')).rejects.toThrow(/would download it/);
      } finally {
        await restricted.disconnect();
      }
    } finally {
      await connector.disconnect();
      await repository.close();
      rmSync(cache, { recursive: true, force: true });
    }
    expect(repository.requests).toEqual([]);
  }, 60_000);

  duckDbIt('off, with a real DuckDB: an extension already in the extension directory still loads with an explicit LOAD, and until then the error says so', async () => {
    process.env.ZLENS_DUCKDB_AUTOINSTALL = 'off';
    const repository = await recordingRepository();
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
      await connector.execute(`SET custom_extension_repository = '${repository.url}'`);
      await connector.execute(`SET autoinstall_extension_repository = '${repository.url}'`).catch(() => undefined);
      // The driver's default extension directory (~/.duckdb) is the one an administrator bundles into.
      const installed = (await connector.execute("SELECT installed FROM duckdb_extensions() WHERE extension_name = 'httpfs'")).rows[0]?.installed === true;
      if (!installed) {
        console.warn('httpfs is not installed for this DuckDB: the bundled-extension path is not exercised on this machine');
        return;
      }
      await expect(connector.execute("SELECT * FROM read_csv('http://127.0.0.1:1/never.csv')")).rejects.toThrow(/the httpfs extension is installed but not loaded, and extension downloads are off on this install \(ZLENS_DUCKDB_AUTOINSTALL=off\); run LOAD httpfs first/);
      await connector.execute('LOAD httpfs');
      // Loaded: the statement now fails on the unreachable address, not on the extension.
      const error = await connector.execute("SELECT * FROM read_csv('http://127.0.0.1:1/never.csv')").then(() => null, (failure: unknown) => failure as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toMatch(/extension downloads are off/);
    } finally {
      await connector.disconnect();
      await repository.close();
    }
    expect(repository.requests).toEqual([]);
  }, 60_000);
});

describe('a restricted DuckDB engine (RFC 0010, with a host)', () => {
  duckDbIt('reads its own tables and views, and no file, extension or setting; every connector on the file shares the restriction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-restricted-'));
    const filepath = join(directory, 'warehouse.duckdb');
    const canary = join(directory, 'canary.csv');
    writeFileSync(canary, 'value\nCANARY-RESTRICTED-7d1a\n');
    const config = { driver: 'duckdb' as const, filepath, moduleSearchPaths: [configuredDuckDbConnectorRoot!] };
    const seed = new DuckDBConnector();
    const restricted = new DuckDBConnector();
    const later = new DuckDBConnector();
    try {
      await seed.connect(config);
      await seed.execute("CREATE TABLE claims AS SELECT * FROM (VALUES ('West', 10), ('East', 7)) AS t(region, amount)");
      await seed.execute('CREATE VIEW totals AS SELECT SUM(amount) AS total FROM claims');
      // Without the restriction a statement reads the file (single-user DQL, unchanged).
      expect((await seed.execute(`SELECT COUNT(*) AS n FROM read_csv_auto('${canary}')`)).rows).toEqual([{ n: 1 }]);
      await seed.disconnect();

      await restricted.connect({ ...config, restrictExternalAccess: true });
      expect((await restricted.execute('SELECT region FROM claims ORDER BY region')).rows).toEqual([{ region: 'East' }, { region: 'West' }]);
      expect((await restricted.execute('SELECT total FROM totals')).rows).toEqual([{ total: 17 }]);
      for (const sql of [
        `SELECT * FROM read_text('${canary}')`,
        `SELECT * FROM read_csv_auto('${canary}')`,
        `SELECT * FROM '${canary}'`,
        `SELECT * FROM glob('${directory}/*')`,
        `COPY claims TO '${join(directory, 'out.csv')}'`,
        `ATTACH '${join(directory, 'other.duckdb')}' AS other`,
        'INSTALL httpfs',
        'LOAD httpfs',
        'SET enable_external_access = true',
        'SET threads = 1',
        `EXPORT DATABASE '${join(directory, 'export')}'`,
      ]) {
        const error = await restricted.execute(sql).then(() => null, (failure: unknown) => failure as Error);
        expect(error, sql).toBeInstanceOf(Error);
        expect(error!.message).not.toContain('CANARY-RESTRICTED-7d1a');
      }
      expect(existsSync(join(directory, 'out.csv'))).toBe(false);
      expect(existsSync(join(directory, 'other.duckdb'))).toBe(false);
      // A consistent read scope still opens on the locked settings.
      const scope = await restricted.openConsistentReadScope();
      try {
        expect((await scope.execute('SELECT COUNT(*) AS n FROM claims')).rows).toEqual([{ n: 2 }]);
      } finally {
        await scope.close();
      }
      // A connector that did not ask for the restriction shares the open database, restricted.
      await later.connect(config);
      await expect(later.execute(`SELECT * FROM read_text('${canary}')`)).rejects.toThrow(/Permission Error/);
    } finally {
      await later.disconnect();
      await restricted.disconnect();
      await seed.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  duckDbIt('keeps an allowed folder readable: in the engine where it can, else through the statement check', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dql-duckdb-allowed-'));
    const connector = new DuckDBConnector();
    try {
      await connector.connect({ driver: 'duckdb', filepath: join(directory, 'w.duckdb'), moduleSearchPaths: [configuredDuckDbConnectorRoot!], restrictExternalAccess: true, allowedDirectories: [directory] });
      const access = (await connector.execute("SELECT current_setting('enable_external_access') AS access, current_setting('lock_configuration') AS locked")).rows[0] as { access: boolean; locked: boolean };
      expect(access.locked).toBe(true);
      const version = String((await connector.execute('SELECT version() AS v')).rows[0]?.v ?? '');
      // DuckDB 1.1 has no allow-list in the engine: external access stays on and DQL's statement check holds the line.
      if (version.startsWith('v1.1')) expect(access.access).toBe(true);
      else expect(access.access).toBe(false);
      // Extensions are out either way (nothing is fetched: the repository cannot exist).
      await expect(connector.execute('LOAD httpfs')).rejects.toThrow();
      await expect(connector.execute('INSTALL httpfs')).rejects.toThrow();
      await expect(connector.execute('SET threads = 1')).rejects.toThrow(/locked/);
    } finally {
      await connector.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Launch blocker: DuckDB's own lock message did not say what to do.
describe('a DuckDB file another process holds', () => {
  it('names the holder and how to free the file, and keeps DuckDB\'s words', async () => {
    const { duckDBOpenFailureMessage } = await import('./duckdb.js');
    const duckdb = 'IO Error: Could not set lock on file "/p/jaffle_shop.duckdb": Conflicting lock is held in /usr/bin/node (PID 20683) by user me. See also https://duckdb.org/docs/stable/connect/concurrency';
    const message = duckDBOpenFailureMessage('/p/jaffle_shop.duckdb', duckdb);
    expect(message).toMatch(/^DuckDB file \/p\/jaffle_shop\.duckdb is in use by another process \(PID 20683\)/);
    expect(message).toContain('for a `zlens notebook` (the workbench), press Ctrl+C in its terminal');
    expect(message).toContain(duckdb);
    expect(duckDBOpenFailureMessage('/p/x.duckdb', 'IO Error: No such file')).toBe('DuckDB connection failed: IO Error: No such file');
  });
});

// New-user review blocker (B2): Python duckdb 2.0 wrote the dbt sample's file,
// and DuckDB's message did not say which release could read it or how to fix it.
describe('a DuckDB file written by a newer DuckDB', () => {
  // The Node duckdb 1.4.4 driver's exact message for a file Python duckdb 2.0.0 wrote.
  const duckdb2 = [
    'IO Error: Trying to read a database file with version number 999, but we can only read versions between 64 and 67.',
    'The database file was created with an newer version of DuckDB.',
    '',
    'Newer DuckDB version might introduce backward incompatible changes (possibly guarded by compatibility settings).',
    'See the storage page for migration strategy and more information: https://duckdb.org/internals/storage',
  ].join('\n');

  it('says DuckDB 2.x wrote it, that ZLens reads 1.4, and how to rebuild it', async () => {
    const { duckDBOpenFailureMessage } = await import('./duckdb.js');
    const message = duckDBOpenFailureMessage('/p/jaffle_shop.duckdb', duckdb2);
    const [guidance, ...rest] = message.split('\n');
    expect(guidance).toBe(
      'This database file was written by a newer DuckDB (2.x). ZLens reads files from DuckDB 1.4. '
      + "Rebuild it with `pip install 'duckdb<1.5'` (then rerun dbt), or use a file written by DuckDB 1.4.",
    );
    // DuckDB's own words stay underneath, with the file they are about.
    expect(rest.join('\n')).toBe(`Original DuckDB error (/p/jaffle_shop.duckdb): ${duckdb2}`);
  });

  it('does not claim 2.x for another newer storage version', async () => {
    const { duckDBNewerFileMessage } = await import('./duckdb.js');
    const message = duckDBNewerFileMessage('/p/x.duckdb', 'IO Error: Trying to read a database file with version number 68, but we can only read versions between 64 and 67.\nThe database file was created with an newer version of DuckDB.');
    expect(message).toMatch(/^This database file was written by a newer DuckDB\. ZLens reads files from DuckDB 1\.4\./);
    expect(message).not.toContain('2.x');
  });

  it('leaves other open failures alone', async () => {
    const { duckDBNewerFileMessage, duckDBOpenFailureMessage } = await import('./duckdb.js');
    expect(duckDBNewerFileMessage('/p/x.duckdb', 'IO Error: No such file')).toBeUndefined();
    expect(duckDBNewerFileMessage('/p/x.duckdb', 'IO Error: Trying to read a database file with version number 39, but we can only read versions between 64 and 67.\nThe database file was created with an older version of DuckDB.')).toBeUndefined();
    expect(duckDBOpenFailureMessage('/p/x.duckdb', 'IO Error: Could not set lock on file "/p/x.duckdb": Conflicting lock is held in node (PID 7)')).toMatch(/^DuckDB file \/p\/x\.duckdb is in use/);
  });
});
