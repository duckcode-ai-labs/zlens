import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConnector } from './connector.js';
import { QueryExecutor, isReconnectSafeReadOnlySql, isRecoverableConnectionLoss } from './query-executor.js';

const config = {
  driver: 'snowflake' as const,
  account: 'acct',
  username: 'analyst',
};

function connector(execute: DatabaseConnector['execute']): DatabaseConnector {
  return {
    driverName: 'snowflake',
    connect: vi.fn(async () => undefined),
    execute,
    disconnect: vi.fn(async () => undefined),
    ping: vi.fn(async () => true),
  };
}

describe('QueryExecutor stale-session recovery', () => {
  it('reconnects once and replays a read-only query after a terminated session', async () => {
    const stale = connector(vi.fn(async () => {
      throw new Error('Snowflake query failed: Unable to perform operation using terminated connection.');
    }));
    const fresh = connector(vi.fn(async () => ({
      columns: ['revenue'],
      rows: [{ revenue: 42 }],
      rowCount: 1,
      executionTimeMs: 2,
    })));
    const pool = {
      getConnector: vi.fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    const executor = new QueryExecutor(pool as never);

    const result = await executor.executePositional('SELECT SUM(revenue) FROM sales.orders', [], config);

    expect(result.rowCount).toBe(1);
    expect(pool.removeConnector).toHaveBeenCalledWith(config, stale);
    expect(fresh.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replay unsafe SQL or retry a non-connection warehouse error', async () => {
    const unsafe = connector(vi.fn(async () => {
      throw new Error('terminated connection');
    }));
    const unsafePool = {
      getConnector: vi.fn(async () => unsafe),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    await expect(new QueryExecutor(unsafePool as never).executePositional(
      'UPDATE sales.orders SET amount = 0',
      [],
      config,
    )).rejects.toThrow('terminated connection');
    expect(unsafePool.removeConnector).not.toHaveBeenCalled();

    const compilationFailure = connector(vi.fn(async () => {
      throw new Error('SQL compilation error: invalid identifier');
    }));
    const compilePool = {
      getConnector: vi.fn(async () => compilationFailure),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    await expect(new QueryExecutor(compilePool as never).executePositional(
      'SELECT missing FROM sales.orders',
      [],
      config,
    )).rejects.toThrow('invalid identifier');
    expect(compilePool.removeConnector).not.toHaveBeenCalled();
  });

  it('recognizes only safe, single-statement replay candidates', () => {
    expect(isReconnectSafeReadOnlySql('-- bounded preview\nSELECT * FROM sales.orders')).toBe(true);
    expect(isReconnectSafeReadOnlySql('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent')).toBe(true);
    expect(isReconnectSafeReadOnlySql('SELECT 1; DROP TABLE orders')).toBe(false);
    expect(isReconnectSafeReadOnlySql('DELETE FROM orders')).toBe(false);
    expect(isRecoverableConnectionLoss(new Error('Connection reset by peer'))).toBe(true);
    expect(isRecoverableConnectionLoss(new Error('SQL compilation error'))).toBe(false);
  });

  it('passes an inherited abort signal into an already-running connector call', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    let began = false;
    const pending = connector(async (_sql, _params, options) => {
      observed = options?.signal;
      began = true;
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason ?? new Error('cancelled')), { once: true });
        // A connector must remain pending until the driver settles or the
        // signal is observed. This is intentionally not a preflight-only test.
        void resolve;
      });
    });
    const pool = {
      getConnector: vi.fn(async () => pending),
      removeConnector: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
    };
    const execution = new QueryExecutor(pool as never).executePositional(
      'SELECT * FROM sales.orders', [], config, { signal: controller.signal },
    );
    await vi.waitFor(() => expect(began).toBe(true));
    controller.abort(new Error('cancelled during connector execution'));
    await expect(execution).rejects.toThrow('cancelled during connector execution');
    expect(observed).toBe(controller.signal);
    expect(pool.removeConnector).not.toHaveBeenCalled();
  });
});

describe('QueryExecutor placeholders', () => {
  it('rewrites $N to the driver\'s placeholder only when there are values to bind (Snowflake ->> FROM $1, live 2026-11-07)', async () => {
    const execute = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }));
    const pool = { getConnector: vi.fn(async () => connector(execute)), removeConnector: vi.fn(), disconnectAll: vi.fn() };
    const executor = new QueryExecutor(pool as never);
    await executor.executePositional('SHOW VIEWS IN DATABASE "NBA" ->> SELECT "name" FROM $1', [], config);
    await executor.executePositional('SELECT * FROM t WHERE id = $1', [7], config);
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      'SHOW VIEWS IN DATABASE "NBA" ->> SELECT "name" FROM $1',
      'SELECT * FROM t WHERE id = ?',
    ]);
    expect(execute.mock.calls[1]![1]).toEqual([7]);
  });
});

describe('a Snowflake session that outlived its sign-in', () => {
  it('counts as a lost connection, so a read-only statement signs in again (and re-reads a token file)', () => {
    expect(isRecoverableConnectionLoss(new Error('Snowflake query failed: Authentication token has expired.  The user must authenticate again.'))).toBe(true);
    expect(isRecoverableConnectionLoss(new Error('Snowflake query failed: Insufficient privileges to operate on table'))).toBe(false);
  });
});
