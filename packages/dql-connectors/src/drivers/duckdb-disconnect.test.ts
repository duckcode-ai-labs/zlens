import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];

class FakeConnection {
  constructor(readonly id: number) {}
  async run(_sql: string) {
    return { columnNames: () => ['one'], getRows: async () => [[1]] };
  }
  closeSync() {
    events.push(`connection.close:${this.id}`);
  }
}

class FakeInstance {
  private nextConnection = 0;
  static async create(_path: string) {
    events.push('database.open');
    return new FakeInstance();
  }
  async connect() {
    this.nextConnection += 1;
    return new FakeConnection(this.nextConnection);
  }
  closeSync() {
    events.push('database.close');
  }
}

vi.mock('../optional-dependency.js', () => ({
  importConnectorDependency: async () => ({ DuckDBInstance: FakeInstance }),
}));

const { DuckDBConnector } = await import('./duckdb.js');

describe('DuckDBConnector.disconnect', () => {
  beforeEach(() => { events.length = 0; });

  it('closes the connection and the database, and drops its references', async () => {
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: '/tmp/dql-fake-disconnect.duckdb' });
    expect(await connector.ping()).toBe(true);
    events.length = 0;

    await connector.disconnect();

    expect(events).toContain('database.close');
    expect(events.filter((event) => event.startsWith('connection.close:')).length).toBeGreaterThanOrEqual(1);
    expect(events.lastIndexOf('database.close')).toBeGreaterThan(events.indexOf('connection.close:1'));
    const held = connector as unknown as { db: unknown; connection: unknown; releaseDatabase: unknown };
    expect(held.db).toBeNull();
    expect(held.connection).toBeNull();
    expect(held.releaseDatabase).toBeNull();
    await expect(connector.execute('SELECT 1')).rejects.toThrow('not connected');
    expect(await connector.ping()).toBe(false);
  });

  it('is safe to call twice and closes the database once', async () => {
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: '/tmp/dql-fake-twice.duckdb' });
    await connector.disconnect();
    const closes = events.filter((event) => event === 'database.close').length;
    await expect(connector.disconnect()).resolves.toBeUndefined();
    expect(events.filter((event) => event === 'database.close').length).toBe(closes);
  });

  it('closes an in-memory database too', async () => {
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb' });
    await connector.disconnect();
    expect(events).toContain('database.close');
  });

  it('collectGarbage reports whether a GC was available and never throws', () => {
    const original = (globalThis as { gc?: () => void }).gc;
    const gc = vi.fn();
    (globalThis as { gc?: () => void }).gc = gc;
    try {
      expect(DuckDBConnector.collectGarbage()).toBe(true);
      expect(gc).toHaveBeenCalledOnce();
      (globalThis as { gc?: () => void }).gc = undefined;
      expect(DuckDBConnector.collectGarbage()).toBe(false);
    } finally {
      (globalThis as { gc?: () => void }).gc = original;
    }
  });
});
