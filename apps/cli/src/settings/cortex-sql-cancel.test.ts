import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortexClaudeProvider, resetCortexRoute } from '@zlens/agent';
import { QueryExecutor, SnowflakeConnector, type ConnectionConfig } from '@zlens/connectors';
import { cortexSql } from './cortex-sign-in.js';

/**
 * CANCEL ON GIVE-UP, end to end through the server's own query path: when Ask stops waiting for Cortex through SQL
 * (`AI_COMPLETE`, the usual route: Snowflake keeps the Cortex REST API off for most accounts), the Snowflake driver
 * is told to cancel the running statement, so the customer's warehouse stops too. The Snowflake SDK is faked at the
 * statement: nothing reaches Snowflake.
 */
const connection = { driver: 'snowflake', account: 'acct', username: 'svc', authMethod: 'oauth', token: 't', warehouse: 'APP_WH' } as unknown as ConnectionConfig;
const refused = () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint.' }), { status: 403 });

afterEach(() => {
  vi.unstubAllGlobals();
  resetCortexRoute();
});

/** A Snowflake connector whose SDK runs AI_COMPLETE until it is cancelled, as Snowflake does. */
function slowSnowflake() {
  const connector = new SnowflakeConnector();
  const seen = { submitted: [] as string[], cancelled: 0 };
  (connector as unknown as { connection: unknown }).connection = {
    execute: (options: { sqlText: string; complete: (error: Error | undefined, statement?: unknown) => void }) => {
      seen.submitted.push(options.sqlText);
      const statement = {
        getStatementId: () => '01-ai-complete',
        // Snowflake answers a cancel by ending the statement with an error.
        cancel: (done: () => void) => {
          seen.cancelled += 1;
          done();
          setTimeout(() => options.complete(Object.assign(new Error('SQL execution canceled'), { code: '000604' }), statement), 5);
        },
      };
      return statement;
    },
  };
  const pool = { getConnector: async () => connector, removeConnector: async () => undefined, disconnectAll: async () => undefined };
  return { executor: new QueryExecutor(pool as never), seen };
}

describe('cancel on give-up through the server\'s query path', () => {
  it('cancels the running AI_COMPLETE statement in Snowflake when Ask stops waiting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    const { executor, seen } = slowSnowflake();
    const provider = new CortexClaudeProvider({ host: 'acct.snowflakecomputing.com', token: async () => ({ token: 't', type: 'OAUTH' }), sql: cortexSql(executor, connection) });
    const ask = new AbortController();
    const asked = provider.generate([{ role: 'user', content: 'Which region grew fastest?' }], { maxTokens: 50, signal: ask.signal });
    await vi.waitFor(() => expect(seen.submitted).toHaveLength(1));
    expect(seen.submitted[0]).toContain('AI_COMPLETE');
    expect(seen.cancelled).toBe(0);
    ask.abort(new Error('Ask reached its time limit'));
    await expect(asked).rejects.toThrow('Ask reached its time limit');
    expect(seen.cancelled).toBe(1);
  });

  it('hands the signal to the executor, and runs as before without one', async () => {
    const calls: Array<{ sql: string; options?: { signal?: AbortSignal } }> = [];
    const executor = {
      executePositional: async (sql: string, _binds: unknown[], _connection: ConnectionConfig, options?: { signal?: AbortSignal }) => {
        calls.push({ sql, ...(options ? { options } : {}) });
        return { rows: [{ R: '{}' }], columns: [], rowCount: 1, executionTimeMs: 1 };
      },
    };
    const run = cortexSql(executor, connection);
    const controller = new AbortController();
    await run('SELECT 1', [], { signal: controller.signal });
    await run('SELECT 2', []);
    expect(calls[0]!.options?.signal).toBe(controller.signal);
    expect(calls[1]!.options).toBeUndefined();
  });
});
