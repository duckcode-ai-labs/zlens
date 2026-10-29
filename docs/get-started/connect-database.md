# Connect a database

ZLens runs queries against one database connection at a time. You set it up
in **Settings → Database**. Guided Setup uses the same screen.

## Install the driver first

Databricks SQL is built in. DuckDB (and local CSV, Parquet and JSON files)
and Snowflake need a driver in the project:

1. Open **Settings → Database**.
2. Pick your database in **Warehouse**.
3. If the status row says **Connector package required before you can
   connect**, click **Install connector**.

The row changes to **Connector installed and ready**. The driver goes into
`.dql/connectors/` in your project. From a terminal, the same thing is:

```bash
npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'   # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk                     # Snowflake
```

## Import a dbt profile

If your project uses dbt, ZLens reads `profiles.yml` for you. It looks in
`DBT_PROFILES_DIR`, the dbt project folder, the ZLens project folder and
`~/.dbt`.

1. Open **Settings → Database**.
2. Under **dbt profiles**, find your profile and target. Each row says which
   database and file it came from.
3. Click **Import & test**.

When the test passes, the status card shows **Test passed** and the
connection is active. If your `profiles.yml` lives somewhere else, type its
path under **Import dbt profiles.yml** and click **Find profiles**.

## Enter a connection by hand

1. Open **Settings → Database**.
2. Pick your database in **Warehouse**. ZLens supports DuckDB, Snowflake,
   Databricks SQL, BigQuery, PostgreSQL, Amazon Redshift, MySQL / MariaDB,
   SQL Server / Azure SQL, Trino / Starburst, ClickHouse, Amazon Athena,
   Microsoft Fabric and SQLite.
3. Fill in the fields. Required fields have a `*`. For DuckDB that is only
   **DuckDB file path**.
4. Click **Save connection**.

ZLens tests the connection before it saves it:

- **Test passed. Connection saved and activated.** You are done.
- **Test failed. Previous connection preserved.** Nothing changed. Fix the
  fields and save again.

Use **Test connection** on the status card at any time to check the active
connection.

## Where the connection is stored

The connection goes into `dql.config.json` under `connections`. The Jaffle
Shop sample's, for example, points at the DuckDB file in the same folder:

```json
"connections": {
  "jaffle_shop_dev": { "driver": "duckdb", "filepath": "jaffle_shop.duckdb" }
}
```

`dql.config.json` is shared through git, so secrets do not go in it:

- A password or token you type in the page is saved to
  `.dql/local/private/connection-secrets.json`, which git ignores. The config
  keeps a `${secret:<connection>.<field>}` reference instead.
- You can also write `${ENV_VAR}` in the config and set the variable in your
  shell.

Every driver's fields are listed in the [Connectors reference](../reference/connectors.md).

## Choose what ZLens reads: Metadata scope

After a passing test, **Metadata scope** appears under the form. It decides
which schemas ZLens reads. ZLens copies their table and column names into a
local index so Ask, notebook and saved query searches stay fast. What
happens to your rows: ZLens reads table structure and counts rows to check
keys. Sample rows are shown only to you, on this computer. Nothing is sent
anywhere unless you turn on
[value profiles](no-dbt.md#optional-show-the-drafter-what-the-columns-hold)
for AI answers; when they are on, Setup says *Value profiles are on: a few
column values are sent to your AI provider*. What else the scope does
depends on how the project models data:

- **With dbt** (`dbt-first`), the dbt project already says which tables
  matter. The scope is optional; use it only to add schemas dbt does not
  cover.
- **Without dbt** (`warehouse-first`), the schemas you choose here *are* the
  model. The section says **Choose the schemas to model**, and syncing also
  reads their comments, declared keys and view SQL into
  `.dql/warehouse-catalog.json`, which Modeling works from. See
  [No dbt? Start from your database](no-dbt.md).
- **Both** (`hybrid`): dbt models plus schemas dbt does not cover. The
  extra schemas are read for Modeling the same way.

To set it:

1. Pick an **Index mode**:
    - **Use exact dbt project relations (recommended)**: only the dbt project's
      tables.
    - **dbt relations plus selected schemas**: the dbt tables plus schemas you
      name. Use this for a hybrid project.
    - **Selected databases/catalogs and schemas**: only what you name. Use this
      without dbt.
2. To see what you can pick, click **Find available databases & schemas**.
   Name the schemas one line per database: `DATABASE: SCHEMA, SCHEMA`.
3. Click **Apply and synchronize**.

The status lines show what was read, for example **Warehouse metadata index
ready · 13 indexed warehouse relations** and, without dbt, **Modeling
catalog · 13 tables and views with their keys and comments**. A failed or
empty refresh keeps the previous index. **Refresh metadata** rebuilds it
later.

In **Guided Setup** the same section is one question, **Which schemas should
ZLens read?** (Database only and Both). Setup lists the schemas as soon as the
connection test passes; tick them and **Apply and synchronize**, and Setup
says what it read (*Read 13 tables (86 columns)*). Schemas named `staging`,
`stg` or `raw` wait behind **Show staging tables** when the database has
other schemas; a ticked one always shows. Index mode,
the typed list, the index details and **Refresh metadata** are under
**Advanced**, closed. With a dbt project the whole section is under
**Advanced**, since dbt already says which tables matter, and so is
**Import from a dbt profile**. Database only never shows the dbt profiles
from your home folder.

The scope is saved in `dql.config.json` under `metadataScopes`. The terminal
equivalent is:

```bash
zlens sync warehouse --schemas sales,finance
```

`--schemas` saves the selection as **Selected databases/catalogs and
schemas**; `zlens sync warehouse` with no flags syncs the saved selection
again and lists what changed since the last sync.

Next, without dbt: **Draft my models** in Guided Setup, or **Modeling →
Draft from warehouse**, drafts entities and joins from what you synced, for
you to review and certify. The first Domain is named after the database
(`jaffle_shop.duckdb` gives **Jaffle shop**), staging copies of a final
table are left out, and the drafts are kept until you save or discard them.
See [No dbt? Start from your database](no-dbt.md#or-use-guided-setup) and
[Modeling and Domain Packages](../datalex-and-dql.md#warehouse-first-model-your-database-without-dbt).

## Check from the terminal

```bash
npm run doctor
```

`zlens doctor` reports the default connection along with the rest of the
project setup.

## Troubleshooting

- **The driver package is not installed.** Install it as shown at the top of
  this page.
- **Connection refused.** Check the host, port, firewall and VPN.
- **Permission errors such as `role does not have USAGE on schema`.** ZLens
  needs `USAGE` on the schema and `SELECT` on the tables it queries.
- **Snowflake key-pair sign-in.** Set the authentication to key pair and give
  the private key path. The public key belongs on the Snowflake user.
- **Databricks HTTP path.** Paste the path `/sql/1.0/warehouses/<id>` or the
  warehouse ID.
