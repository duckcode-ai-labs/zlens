import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { duckDBOpenFailureMessage } from '@zlens/connectors';

// The Node DuckDB driver's message for a file Python duckdb 2.0.0 wrote.
const DUCKDB2_ERROR = [
  'IO Error: Trying to read a database file with version number 999, but we can only read versions between 64 and 67.',
  'The database file was created with an newer version of DuckDB.',
  '',
  'Newer DuckDB version might introduce backward incompatible changes (possibly guarded by compatibility settings).',
  'See the storage page for migration strategy and more information: https://duckdb.org/internals/storage',
].join('\n');

// The DuckDB connector rejects the open with its formatted message; doctor
// must show it as the "Local query runtime" detail.
vi.mock('@zlens/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zlens/connectors')>();
  class QueryExecutor {
    async getConnector(connection: { filepath?: string }) {
      return {
        ping: async () => {
          throw new Error(actual.duckDBOpenFailureMessage(connection.filepath ?? ':memory:', DUCKDB2_ERROR));
        },
      };
    }
    async disconnect() {}
  }
  return { ...actual, QueryExecutor };
});

const { checkLocalQueryRuntime } = await import('./doctor.js');

// New-user review blocker (B2): the dbt sample's setup installed Python duckdb
// 2.0, and `zlens doctor` printed DuckDB's "version number 999" error without
// saying how to fix it.
describe('zlens doctor on a DuckDB file written by DuckDB 2.0', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('says which DuckDB ZLens reads and how to rebuild the file, then DuckDB\'s own words', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-doctor-duckdb2-'));
    roots.push(root);
    const check = await checkLocalQueryRuntime(root, { driver: 'duckdb', filepath: 'jaffle_shop.duckdb' }, { find: async () => null });
    expect(check.name).toBe('Local query runtime');
    expect(check.ok).toBe(false);
    const filepath = join(root, 'jaffle_shop.duckdb');
    expect(check.detail).toBe(`Local query runtime is unavailable for driver "duckdb": ${duckDBOpenFailureMessage(filepath, DUCKDB2_ERROR)}`);
    expect(check.detail).toContain(
      'This database file was written by a newer DuckDB (2.x). ZLens reads files from DuckDB 1.5. '
      + "Rebuild it with `pip install 'duckdb<1.6'` (then rerun dbt), or use a file written by DuckDB 1.5.",
    );
    expect(check.detail).toContain(`\nOriginal DuckDB error (${filepath}): IO Error: Trying to read a database file with version number 999`);
  });
});
