# RFC 0011: Move the DuckDB driver to `@duckdb/node-api`

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 (with Claude) |
| **Status** | Draft. Needs the owner's approval before any code is written |
| **Created** | 2026-10-19 |
| **Targets** | ZLens 0.3 (0.2.2 ships only the Node-range guard) |
| **Discussion** | — |
| **Implementation** | — |
| **Supersedes** | — |

## Decisions to approve

1. **Driver package.** ZLens loads DuckDB through the official
   [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api)
   ("Neo") instead of the deprecated `duckdb` package. `duckdb` 1.4.4 is the
   last release of the old client, and DuckDB no longer publishes new
   binaries for it.
2. **Version line.** Track DuckDB 1.5.x (`@duckdb/node-api@^1.5.6-r.1`, npm
   `latest`), not the `lts-v1.4` tag. `dbt-duckdb` in the samples already
   installs Python DuckDB 1.5.6, so the database file ZLens reads would then
   be written by the same engine version.
3. **Where it installs.** Unchanged: per project, into `.dql/connectors`, on
   first start or from the Connections page. It is still not a dependency of
   `@zlens/cli`, so a project without DuckDB never downloads it.
4. **One driver, no fallback.** ZLens stops loading `duckdb` entirely. It does
   not try `@duckdb/node-api` first and `duckdb` second. Two drivers would
   double the native-binding paths and the result-shape tests. A project that
   still has `duckdb` in `.dql/connectors` gets `@duckdb/node-api` installed
   next to it on the next start. The old folder stays until the person
   deletes it.
5. **Node range after the move.** Node 20, 22, 24 and 26. The Node-API
   bindings are ABI-stable, so the same binary loads on every Node release.
   `engines.node` becomes `>=20` again. The 0.2.2 guard
   (`packages/dql-connectors/src/duckdb-node-support.ts`) and
   `ZLENS_DUCKDB_BUILD_FROM_SOURCE` are deleted in the same change.
6. **No npm 12 install-script handling for DuckDB.** `@duckdb/node-api` has
   no install script. Its binary comes from per-platform optional
   dependencies (`@duckdb/node-bindings-<os>-<arch>`). `duckdb` leaves
   `NATIVE_CONNECTOR_PACKAGES`, the `allowScripts` seeding and the rebuild
   repair. better-sqlite3 still needs all three.

## Summary

Swap the driver behind `DuckDBConnector` from the callback-style `duckdb`
package to the promise-based `@duckdb/node-api`. The connector's public
surface (`connect`, `execute`, `openConsistentReadScope`, cancellation, the
`QueryResult` shape) stays the same. Everything that installs, repairs or
explains the old package's native binary goes away.

## Motivation

- **Node 25 and 26 cannot install the old driver.** `duckdb` 1.4.4 publishes
  prebuilt binaries for Node ABI 115, 127 and 137 (Node 20, 22, 24) only. On
  anything else, npm compiles DuckDB from source: over ten minutes on an
  M-series Mac, and a failure without Python and Xcode. ZLens's startup
  install gave up after ten minutes and the Connections test said "connector
  package missing". The owner hit this on a fresh install on Node 26, which
  becomes LTS this month. 0.2.2 replaces that with a plain "use Node 24 LTS or
  22" message. That message is a workaround: it turns new users away on the
  current Node.
- **npm 12 blocks the old driver's install script.** `duckdb` downloads its
  binary in an install script, so ZLens seeds `allowScripts` in
  `.dql/connectors/package.json` and rebuilds the package at startup
  (`apps/cli/src/connector-native.ts`). `@duckdb/node-api` needs none of that.
- **The old client is deprecated.** It gets no new DuckDB versions, while
  `dbt-duckdb` users move ahead (1.5.6 today).

Measured on 2026-10-19, Node 26.12.0 + npm 11.20, darwin-arm64:
`npm install @duckdb/node-api@1.5.6-r.1` took under 1 second and added 4
packages, with no install script. `SELECT 42::BIGINT, version()` returned
`v1.5.6`. The same machine needs over ten minutes to source-build `duckdb`
1.4.4 there.

## Detailed design

### Scope (from the current tree)

Only one production file loads the package:
`packages/dql-connectors/src/drivers/duckdb.ts` (about 700 lines). Its
`importConnectorDependency('duckdb', …)` call is the only load. The rest is
install and repair plumbing:

| File | Change |
|---|---|
| `packages/dql-connectors/src/drivers/duckdb.ts` | Port to `DuckDBInstance` / `DuckDBConnection` (below) |
| `apps/cli/src/local-runtime.ts` `CONNECTOR_INSTALLS.duckdb` | `packageName: '@duckdb/node-api'`, `packageSpec: '@duckdb/node-api@^1.5.6-r.1'` |
| `apps/cli/src/connector-native.ts` | Drop `duckdb` from `NATIVE_CONNECTOR_PACKAGES` |
| `packages/dql-connectors/src/native-binding.ts` | Drop `duckdb` from `NATIVE_INSTALL_SCRIPT_PACKAGES` and its binding-missing pattern |
| `packages/dql-connectors/src/duckdb-node-support.ts` | Delete (0.2.2 guard) |
| `apps/cli/src/commands/doctor.ts` `checkDuckDBDependency` | Check `@duckdb/node-api` loads |
| `packages/create-dql-app/bin/create-zlens-app.mjs` | Printed driver step installs `@duckdb/node-api` |
| `scripts/bootstrap-jaffle-shop-sample.mjs`, `packages/dql-mcp/scripts/stdio-e2e.mjs`, CI `duckdb@1.1.3` installs | Install `@duckdb/node-api` |
| `scripts/launch-gate.mjs` + gate specs | Expect `@duckdb/node-api` in `.dql/connectors`; no "rebuilt" note on npm 12 |
| Sample READMEs, `docs/reference/compatibility.md` | Node 20–26 |

### API mapping

| Today (`duckdb`) | `@duckdb/node-api` |
|---|---|
| `new Database(path, cb)` | `await DuckDBInstance.create(path, options)`; use `DuckDBInstance.fromCache(path)` for the shared-database map we keep today (`sharedDuckDBDatabases`) |
| `db.connect()` | `await instance.connect()` |
| `connection.all(sql, ...params, cb)` | `await connection.runAndReadAll(sql, params)` |
| `connection.interrupt()` | `connection.interrupt()` (same name, so the AbortSignal path stays) |
| `connection.close(cb)` / `db.close(cb)` | `connection.closeSync()` / `instance.closeSync()` |
| Row objects with JS values | `reader.getRowObjects()` (DuckDB values) or `getRowObjectsJson()` |

### Values and types

- **Typed columns.** Today ZLens guesses column types from the first row's
  values (`inferDuckDBType`). The new reader gives the real DuckDB type for
  each column (`reader.columnTypes()`). Map those to `ColumnMeta.type`
  instead. This also fixes columns that are NULL in the first row.
- **Values.** Convert with one function the tests pin down. The old client
  already gave JS numbers and `Date`s, and `normalizeDuckDBValue` turned
  BIGINT into a number. Keep exactly today's output: BIGINT/HUGEINT become a
  number when safe and a string otherwise; DECIMAL becomes a number;
  DATE/TIMESTAMP/TIMESTAMPTZ become what they are today; UUID becomes a
  string; LIST/STRUCT/MAP become plain JS. `getRowObjectsJson()` turns BIGINT
  into a string, so it is not a drop-in replacement.
- **Parameters.** `runAndReadAll(sql, values)` binds positional `?` / `$1`
  the same way. Arrays and Dates need explicit `DuckDBValue` wrappers; the
  existing `buildParamValues` output is the place to do it.

### Behaviour that must not change

Each of these has a test today, and each must pass unchanged on the new driver:

- `restrictExternalAccess` and `allowedDirectories` (`restrictDuckDBDatabase`);
- `ZLENS_DUCKDB_AUTOINSTALL=off` (extension downloads off, with the "not
  installed" message);
- the lock message when another process holds the file
  (`duckDBOpenFailureMessage`);
- consistent-read scopes (schema and time zone carried over, one transaction);
- cancellation through `AbortSignal`;
- `PRAGMA disable_checkpoint_on_shutdown` on open;
- read-only opens of the dbt sample's `jaffle_shop.duckdb` while `dbt build`
  is not running.

### Rollout

1. Port the driver behind the existing test suite
   (`packages/dql-connectors/src/drivers/duckdb*.test.ts`), with value-shape
   snapshot tests written against today's driver first.
2. Switch installs, doctor, create-zlens-app, CI and gate.
3. Run the launch gate on npm 10 (Node 22), npm 12 (Node 24) and Node 26.
   All rows must pass on all three.
4. Release as 0.3.0 with a changelog line: "DuckDB driver is now
   `@duckdb/node-api`. It installs on its own on next start. You can delete
   `.dql/connectors/node_modules/duckdb`."

## Backward compatibility

- **Database files.** DuckDB 1.5 reads files written by 1.4. A file that 1.5
  writes stays readable by older DuckDB unless someone raises its storage
  version, and ZLens never does that. dbt-duckdb already writes these files
  with 1.5.6.
- **Projects with `duckdb` installed.** On the next start, ZLens finds
  `@duckdb/node-api` missing and installs it, which takes about a second. The
  old package is left in place and never loaded.
- **Pinned connector setups.** Anyone who scripted
  `npm install --prefix .dql/connectors duckdb` (CI, Docker images) has to
  change that line. Doctor names the new package.
- **Embedding hosts.** `DuckDBConnector` keeps its interface, so hosts are
  not affected.

## Alternatives considered

- **Keep `duckdb` and build our own binaries for Node 25/26.** We would own a
  native build matrix for a client DuckDB has deprecated, and repeat it for
  every new Node. Rejected.
- **Ship DuckDB inside `@zlens/cli` (hard dependency).** Every install would
  carry about 40 MB per platform, even for Snowflake-only users, and the
  per-project driver model would be gone. Rejected for now; we can revisit
  this once `@duckdb/node-api` is the only native piece left besides
  better-sqlite3.
- **DuckDB-Wasm.** No native binary, but slower, limited file access and no
  extensions without fetching them. It does not fit local warehouse files.
  Rejected.
- **Load both drivers (`@duckdb/node-api` first, then `duckdb`).** Rejected
  under decision 4.

## Unresolved questions

- Does the `fromCache` instance cache fit how ZLens shares one database
  across connectors today, or should ZLens keep its own map
  (`sharedDuckDBDatabases`)? To be decided while porting, with the existing
  sharing tests as the judge.
- Exact `TIMESTAMPTZ` rendering. The old client returned a JS `Date`. The
  port must keep that, and a snapshot test settles it.

## Adoption signal

- Zero "connector package missing for duckdb" reports on Node 26.
- Launch gate passes on Node 26 with no DuckDB-specific rows skipped.
- The npm 12 "ZLens rebuilt the DuckDB driver" note disappears from gate
  output, because there is nothing to rebuild.
