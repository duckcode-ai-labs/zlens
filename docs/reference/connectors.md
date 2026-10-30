# Connectors

ZLens uses a flat install. The CLI installs quickly and does not bundle
every database driver. Configure connections in `dql.config.json` or in
**Settings → Database** (see [Connect a database](../get-started/connect-database.md)).

## Active connectors

| Connector | Driver | Install model | Sign-in |
| --- | --- | --- | --- |
| Amazon Athena | `athena` | Project-local (`@aws-sdk/client-athena`) | AWS default credentials (SSO, environment, role), named profile, or access key |
| Amazon Redshift | `redshift` | Project-local (`pg`) | Password, or IAM (provisioned cluster or Serverless) |
| BigQuery | `bigquery` | Project-local (`@google-cloud/bigquery`) | Google sign-in (Application Default Credentials), service account key file or key JSON |
| ClickHouse | `clickhouse` | Built in (HTTP) | User and password; HTTPS for ClickHouse Cloud |
| Databricks SQL | `databricks` | Built in | Access token or OAuth bearer token |
| DuckDB | `duckdb` | Project-local (`duckdb`) | — |
| Local files | `file` | Project-local DuckDB | — |
| Microsoft Fabric | `fabric` | Project-local (`mssql`) | Microsoft Entra ID |
| MySQL / MariaDB | `mysql` | Project-local (`mysql2`) | User and password |
| PostgreSQL | `postgresql` | Project-local (`pg`) | Password, or RDS / Aurora IAM |
| Snowflake | `snowflake` | Project-local (`snowflake-sdk`) | Password, key pair, SSO, OAuth, PAT, MFA, workload identity |
| SQL Server / Azure SQL | `mssql` | Project-local (`mssql`) | SQL login, or Microsoft Entra ID (user, service principal, az login / managed identity) |
| SQLite | `sqlite` | Built in (read-only) | — |
| Trino / Starburst | `trino` | Built in (HTTP) | Password (HTTPS only) or JWT / OAuth token |

Every connector honours the same execution contract:

- the caller's deadline and cancel stop the statement on the server, not only in ZLens;
- results are capped at the requested row and byte limits, and a cut is reported as `truncated`;
- calendar dates come back as the `YYYY-MM-DD` the warehouse holds, never shifted by the machine's time zone;
- exact integers and decimals come back as numbers;
- a failed sign-in never repeats the password.

## Project-local driver install

Open **Settings → Database** and use **Install connector**; saving a
connection also installs what it needs. ZLens installs driver packages into:

```text
.dql/connectors/
```

`zlens notebook` and `zlens sync warehouse` also install the active
connection's driver on their own when it is missing. CLI equivalents, for
offline machines or CI:

```bash
npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'   # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk           # Snowflake
npm install --prefix .dql/connectors pg                      # PostgreSQL, Redshift
npm install --prefix .dql/connectors mysql2                  # MySQL, MariaDB
npm install --prefix .dql/connectors mssql                   # SQL Server, Azure SQL, Fabric
npm install --prefix .dql/connectors @google-cloud/bigquery  # BigQuery
npm install --prefix .dql/connectors @aws-sdk/client-athena  # Athena
```

The SSH client (`ssh2`) and the AWS IAM token packages
(`@aws-sdk/client-redshift`, `@aws-sdk/client-redshift-serverless`,
`@aws-sdk/rds-signer`) are installed the same way, only for a connection
that uses a tunnel or IAM sign-in.

This keeps the global CLI install small while still letting each project opt
into the database packages it actually uses.

Keep the `@^1.5.6-r.1` range on the DuckDB command (and the quotes, which
zsh needs): npm's `latest` for `@duckdb/node-api` is 2.0, whose database files
DuckDB 1.x cannot read.

**DuckDB's binary.** `@duckdb/node-api` gets its binary from a per-platform
optional dependency built on Node-API. One install loads on every Node from
20 up, nothing is compiled, and there is no install script, so npm 12 needs
no `allowScripts` entry for it. The binary is missing when optional
dependencies were skipped (`--omit=optional`) or the `.dql` folder was copied
from another operating system. ZLens then reinstalls the driver the next time
`zlens notebook` starts or `zlens sync warehouse` runs. By hand:

```bash
npm --prefix .dql/connectors install @duckdb/node-api --include=optional
```

A project set up with an older ZLens has the old `duckdb` package in
`.dql/connectors`. ZLens installs `@duckdb/node-api` next to it on the next
start, and you can delete `.dql/connectors/node_modules/duckdb`.

The other drivers have no install script either. `ssh2` has one, but it only
builds an optional speed-up, so it works with the script blocked.

## Credentials

Secrets typed in **Settings → Database** never go into `dql.config.json`. They
are written to `.dql/local/private/connection-secrets.json` (git-ignored,
readable only by your user, mode 0600), and the config keeps a reference in
their place:

```json
{ "driver": "postgresql", "host": "db.example.com", "username": "reader", "password": "${secret:warehouse.password}" }
```

The page never receives a saved secret back: it shows a mask, and
saving the mask keeps the stored value. A password already written literally
in an older config keeps working and moves to the private file the next time
the connection is saved from the page. `${ENV_VAR}` references keep working as
before and are the right choice for CI and servers.

Use a read-only database role for ZLens. Ask only runs single read-only
statements, but the database is the place that enforces it.

## Encryption in transit

Network databases take `sslMode`, named as in libpq:

| `sslMode` | Meaning |
| --- | --- |
| `disable` | No TLS |
| `require` | Encrypted; the certificate is not checked |
| `verify-ca` | Encrypted; the certificate must chain to a trusted CA |
| `verify-full` | Encrypted; the CA and the host name are both checked |

`sslRootCert` names a PEM bundle (a file path, or the PEM text) for private
CAs such as the RDS, Azure or Cloud SQL bundles. Defaults: Redshift `require`;
SQL Server and Fabric `verify-full` (set `trustServerCertificate` only for a
self-signed server on a network you trust); PostgreSQL and MySQL follow the
driver's default unless you choose. Trino and ClickHouse use `"ssl": true`
for HTTPS; Trino only accepts a password over HTTPS.

## SSH tunnels

PostgreSQL, Redshift, MySQL and SQL Server can be reached through an SSH
bastion. ZLens opens the tunnel when it connects and closes it when the
connection closes; TLS still checks the database's real host name.

```json
{
  "driver": "postgresql",
  "host": "10.0.3.17",
  "database": "analytics",
  "username": "reader",
  "password": "${secret:warehouse.password}",
  "sslMode": "verify-full",
  "sshTunnel": { "host": "bastion.example.com", "username": "ec2-user", "privateKeyPath": "~/.ssh/id_ed25519" }
}
```

## Common shape

```json
{
  "connections": {
    "default": {
      "driver": "databricks",
      "host": "${DATABRICKS_HOST}",
      "httpPath": "/sql/1.0/warehouses/${DATABRICKS_WAREHOUSE_ID}",
      "catalog": "main",
      "schema": "analytics",
      "token": "${DATABRICKS_TOKEN}"
    }
  }
}
```

Environment variables and `${secret:...}` references are resolved at
runtime, so secrets stay out of git.

## Databricks SQL

Use either a warehouse ID or the dbt/JDBC HTTP path. ZLens extracts the warehouse
ID from paths like `/sql/1.0/warehouses/<id>`.

```json
{
  "driver": "databricks",
  "host": "adb-123456789.0.azuredatabricks.net",
  "httpPath": "/sql/1.0/warehouses/9196548d010cf14d",
  "catalog": "main",
  "schema": "marts",
  "authMethod": "oauth",
  "token": "${DATABRICKS_TOKEN}",
  "waitTimeout": "50s",
  "byteLimit": 25000000
}
```

For automation, prefer an enterprise-approved OAuth token or service principal
token rather than a personal token.

## DuckDB and local files

```json
{
  "driver": "duckdb",
  "filepath": "./warehouse.duckdb"
}
```

For CSV, TSV, Parquet and JSON files, use the `file` driver. It runs on
DuckDB, so ZLens installs the DuckDB driver for it. With `dataFolder`, each
data file in that folder is a table (a view) named after the file, so sync,
Guided Setup and Ask see the folder as a database:

```json
{
  "driver": "file",
  "filepath": ":memory:",
  "dataFolder": "./data"
}
```

```sql
select * from orders   -- reads ./data/orders.csv
```

`dataFolder` is relative to the project. The files are read where they are, at
query time, and the tables follow the folder: a file added while ZLens runs
becomes a table, a removed one stops being one. Only files directly in the
folder are read, not subfolders. Left out: a file DuckDB cannot read (until it
changes), names with `*`, `?`, `[` or `]`, tool settings such as
`dql.config.json` and `package.json`, and, in the project's own folder, every
`.json` file. Two files with the same name (`orders.csv`, `orders.parquet`)
become `orders` and `orders_parquet`. With a real `filepath`, the views are
temporary and never written into that DuckDB file. `zlens notebook` on a
folder of data files writes this connection for you.

Replacing a Dataset tile and aggregate Dataset rollups need a DuckDB
connection; a `file` connection refuses them with that reason.

Any file can also be read from SQL:

```sql
select * from read_csv_auto('./data/orders.csv')
```

### Extension downloads

By default DuckDB installs a known extension the first time a statement needs
it (for example `httpfs` to read a URL), downloading it from DuckDB's
extension repository at `extensions.duckdb.org`, and `INSTALL <name>` downloads
one on request. Set `ZLENS_DUCKDB_AUTOINSTALL=off` (the old name
`DQL_DUCKDB_AUTOINSTALL` is still read) to have DuckDB use only the extensions
already installed: every connection starts with `autoinstall_known_extensions`
and `autoload_known_extensions` off, an `INSTALL` that would download (from
DuckDB's repository, a named one or a URL) is refused before it reaches the
engine, and a statement that needs an extension this install does not have
fails with one plain sentence: "the httpfs extension is not installed and
extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off); ask
an administrator to bundle it". Nothing is requested from any repository. An
extension an administrator bundled into DuckDB's `extension_directory` still
loads with an explicit `LOAD <name>` (or `INSTALL <name> FROM '<local path>'`),
and the extensions built into the driver (`json`, `parquet`) work as before.
Hosts that must not fetch code at run time set this; unset or `on` keeps
DuckDB's default.

### When ZLens serves people through a host

When ZLens runs inside a host (RFC 0010), a
statement reaches the connection's tables and views and nothing else the
engine could reach. DuckDB and `file` connections open with external access
off and their settings locked, after the database itself is open: no file
outside the database is read or written (file readers, `FROM 'file.csv'`,
`COPY`, `ATTACH`, `EXPORT DATABASE`), no extension is installed or loaded,
and no `SET` or `PRAGMA` changes a setting. ZLens also refuses those statements
(and their counterparts on other engines) before they run.

A folder of data files a connection should still read, for example one
mounted for it, is named in `allowedDirectories` (none by default; relative
folders are inside the project):

```json
{
  "driver": "duckdb",
  "filepath": "./warehouse.duckdb",
  "allowedDirectories": ["./data"]
}
```

A file reader whose path is a plain string inside one of these folders then
runs. DuckDB 1.2 and later enforce the folders in the engine; DuckDB 1.1 has
no such setting, so a connection that names folders keeps external access on
in the engine (extensions stay out) and ZLens's statement check enforces them.
The driver ZLens pins today is 1.1.3, so the folders rest on that check until
the driver is 1.2 or later; none are listed by default, and then the engine
itself is closed. Without a host nothing changes: `zlens notebook` reads files
as before.

With a host the statement check is deliberately broad on every connection: a
statement that begins with `SET`, `RESET`, `USE`, `PREPARE`, `EXECUTE` or
`CALL` is refused, and so is one whose text holds what looks like a file
reader's call anywhere, a string literal included. The check reads each
statement the way its engine does (its strings, quoted names and comments,
under every setting that changes how the engine reads them) and refuses one
it cannot read that way.

With a host, a statement a person or a model writes only reads, on every
connection: one `SELECT` (or `WITH`, `VALUES`, `TABLE`, `SHOW`, `DESCRIBE` or
`EXPLAIN` of one). A change to data, tables, settings or the session, or
several statements at once, is refused. ZLens's own statements (its views of
the project's data files, uploaded datasets) keep their shapes. Give
the warehouse account behind a hosted connection read-only grants all the
same: the check is a second layer, not a substitute for them. Without a host
nothing changes: a notebook cell may still write to your own DuckDB file.

Such a statement does not read the warehouse's own record of other sessions,
their queries, its users or its settings either: query-history, session and
activity views and their table functions, server settings and variables, and
SHOW of sessions, users, grants or settings. On each engine:

| Engine | Not read with a host |
|---|---|
| Snowflake | `ACCOUNT_USAGE` (and `ORGANIZATION_USAGE`) `QUERY_HISTORY`, `LOGIN_HISTORY`, `SESSIONS`, `ACCESS_HISTORY`; the `INFORMATION_SCHEMA` query- and login-history functions; `SHOW PARAMETERS`, `USERS`, `GRANTS` and the like |
| Databricks | `system.query.history`, `system.access.*`, `system.billing.*`; `SHOW GRANTS`, `USERS` and the like |
| BigQuery | `INFORMATION_SCHEMA.JOBS*`, `INFORMATION_SCHEMA.SESSIONS*` |
| Postgres, Redshift | `pg_stat_activity`, `pg_stat_statements`, `pg_settings`, `pg_locks` and the other activity, settings and role views, `current_setting`, the `pg_read_file` family; Redshift's `stl_*`, `svl_*`, `stv_*`, `sys_query_*` views; SHOW (Postgres: all; Redshift: anything but tables, columns, schemas, databases, views, datashares, models) |
| MySQL | `performance_schema.*`, `mysql.*`, `sys.*`, `information_schema.PROCESSLIST` and `INNODB_TRX`, `@@` variables; `SHOW PROCESSLIST`, `VARIABLES`, `STATUS`, `GRANTS` and the like |
| DuckDB | `duckdb_settings`, `duckdb_secrets`, `duckdb_extensions`, `duckdb_databases`, `pg_settings`, `current_setting` |
| ClickHouse | `system` logs, processes, settings, users, roles, grants, quotas; `SHOW PROCESSLIST`, `SETTINGS` and the like |
| Trino, Athena | `system.runtime.*` queries, tasks, nodes, transactions |
| SQL Server, Fabric | `sys.dm_exec_*`, `sys.dm_os_*`, `sys.dm_tran_*`, `sys.configurations`, logins and credentials, `@@` variables |
| SQLite | nothing beyond `PRAGMA` and `ATTACH`, refused already |

A name is matched however it is written (any case, quoted or not, qualified
or not); the same name as another schema's table, or as a column, is not
(`ops.pg_locks`, `t.stl_weight`). There is no setting to allow these: the
warehouse role's grants are the first control, so give it no grant on them.
ZLens's own statements are not affected; with a host, warehouse discovery does
not read query history.

Catalog lookups (a table's columns, the schema search) send schema and table
names to the warehouse as bound values on every engine, never inside the
statement's text. Databricks connections take `?` parameters, sent as the
statement API's named parameters.

## SQLite

```json
{ "driver": "sqlite", "filepath": "./data/app.sqlite" }
```

The file is opened read-only; ZLens never changes it.

## Snowflake

Password auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "password",
  "password": "${SNOWFLAKE_PASSWORD}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Key-pair auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "key_pair",
  "privateKeyPath": "${SNOWFLAKE_PRIVATE_KEY_PATH}",
  "privateKeyPassphrase": "${SNOWFLAKE_PRIVATE_KEY_PASSPHRASE}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Use either `privateKeyPath` or `privateKey`. The public key is configured on
the Snowflake user; ZLens only needs the private key material or file path.

Enterprise auth fields are passed through to the Snowflake Node driver:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "programmatic_access_token",
  "token": "${SNOWFLAKE_PAT}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "queryTag": "team=analytics;app=dql",
  "proxyHost": "${HTTPS_PROXY_HOST}",
  "proxyPort": 8080
}
```

Supported `authMethod` values include `password`, `mfa`, `key_pair`,
`external_browser`, `oauth`, `oauth_authorization_code`,
`oauth_client_credentials`, `programmatic_access_token`, and
`workload_identity`.

For dbt `profiles.yml`, ZLens imports Snowflake `private_key_path`,
`private_key`, `private_key_passphrase`, `authenticator`, `token`, proxy
fields, OAuth fields, workload identity fields, and query tags where present.

## PostgreSQL

```json
{
  "driver": "postgresql",
  "host": "db.example.com",
  "port": 5432,
  "database": "analytics",
  "username": "dql_reader",
  "password": "${PG_PASSWORD}",
  "sslMode": "verify-full",
  "sslRootCert": "~/certs/rds-global-bundle.pem"
}
```

RDS and Aurora IAM sign-in: set `"authMethod": "aws_default"` (or
`aws_profile` with `profile`, or `aws_access_key`) and `region`; ZLens mints a
fresh token for each new connection. Row caps are applied with a cursor
inside a read-only transaction, so the server stops after the rows the
caller can take.

## Amazon Redshift

```json
{
  "driver": "redshift",
  "host": "analytics.abc123.us-east-1.redshift.amazonaws.com",
  "database": "dev",
  "authMethod": "aws_profile",
  "profile": "analytics",
  "clusterId": "analytics",
  "username": "dql_reader"
}
```

IAM sign-in uses GetClusterCredentials for a provisioned cluster
(`clusterId` and `username`) or GetCredentials for Serverless (`workgroup`).
Password sign-in takes `username` and `password`. TLS is on by default.

## MySQL / MariaDB

```json
{ "driver": "mysql", "host": "db.example.com", "database": "shop", "username": "dql_reader", "password": "${MYSQL_PASSWORD}", "sslMode": "verify-full" }
```

In MySQL a database is the schema: tables are named `shop.orders`.

## SQL Server, Azure SQL and Microsoft Fabric

```json
{ "driver": "mssql", "host": "myserver.database.windows.net", "database": "sales", "authMethod": "azure_default" }
```

`authMethod`: `password` (SQL login with `username`/`password`),
`azure_password`, `azure_service_principal` (`oauthClientId`,
`oauthClientSecret`, `tenantId`), or `azure_default` (az login, managed
identity, environment variables). Fabric (`"driver": "fabric"`) always
encrypts and defaults to `azure_default`. Descriptions set as
`MS_Description` extended properties are read into the modeling catalog.

## BigQuery

```json
{ "driver": "bigquery", "projectId": "acme-analytics", "location": "US", "schema": "marts", "authMethod": "application_default", "byteLimit": 10000000000 }
```

`authMethod`: `application_default` (run `gcloud auth application-default
login`, or a workload identity), `service_account_key_file` (`keyFilename`),
or `service_account_json` (`serviceAccountJson`). `byteLimit` becomes the
job's maximum bytes billed: BigQuery refuses a query that would scan more
instead of billing it.

## Trino / Starburst

```json
{ "driver": "trino", "host": "trino.example.com", "port": 443, "ssl": true, "catalog": "hive", "schema": "analytics", "username": "dql", "password": "${TRINO_PASSWORD}" }
```

Use `"authMethod": "token"` with `token` for JWT or OAuth access tokens.
Tables are named with their catalog: `hive.analytics.orders`.

## ClickHouse

```json
{ "driver": "clickhouse", "host": "abc123.us-east-1.aws.clickhouse.cloud", "ssl": true, "database": "analytics", "username": "dql_reader", "password": "${CLICKHOUSE_PASSWORD}" }
```

Row caps and deadlines are ClickHouse server settings (`max_result_rows`,
`max_execution_time`); a cancelled query is killed by its query id.

## Amazon Athena

```json
{ "driver": "athena", "region": "us-east-1", "workgroup": "analytics", "database": "sales", "outputLocation": "s3://acme-athena-results/dql/", "authMethod": "aws_default" }
```

`outputLocation` is needed unless the workgroup enforces one. A cancelled or
timed-out query is stopped with StopQueryExecution, so it stops scanning (and
billing).
