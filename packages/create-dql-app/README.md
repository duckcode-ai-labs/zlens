# create-zlens-app

The fastest way to start a ZLens project: certified answers on your warehouse.

```bash
npx create-zlens-app@latest my-analytics
cd my-analytics
npm install
# npm install --prefix .dql/connectors snowflake-sdk  # Snowflake only
# Databricks does not need an extra package.
npm run notebook
```

Opens a running notebook at <http://127.0.0.1:3474> in under 5 minutes on a
clean machine. No global install required; the template installs
`zlens` locally and exposes it through npm scripts.

The scaffolded project is a clean starter: `dql.config.json`, a welcome
notebook, and npm scripts for `notebook`, `sync`, `compile`, `lineage`,
`doctor`, and `validate`.

## dbt project or database only

ZLens works on your warehouse, from a dbt project or straight from the
database. The scaffolder picks one of two workspace shapes:

- **dbt project.** `dql.config.json` gets a `dbt` block pointing at your dbt
  project and `npm run sync` runs `zlens sync dbt`. Pass the project with
  `--dbt <path>`, or let the scaffolder find it: it looks for
  `dbt_project.yml` next to the new folder (one and two levels up, and in a
  sibling `dbt/` folder) and in the folder you run it from and its parent.
- **Database only.** Pass `--warehouse <driver>`. `dql.config.json` gets
  `"manifestVersion": 3`, `"modeling": { "mode": "warehouse-first" }`, no dbt
  block, and a `default` connection stub for that driver, with secrets as
  `${ENV_VAR}` placeholders. `npm run sync` runs `zlens sync warehouse`.

```bash
npx create-zlens-app@latest my-analytics --dbt ../my-dbt-project
npx create-zlens-app@latest my-analytics --warehouse snowflake
npx create-zlens-app@latest my-analytics --warehouse duckdb --database-path ./warehouse.duckdb
```

With neither flag and no dbt project found, an interactive run asks
"dbt project, or a database only?" (then the dbt project path, or the
database and, for DuckDB or SQLite, its file). A non-interactive run (CI,
piped input) keeps the old default: a dbt config pointing at
`../my-dbt-project` for you to edit.

Next steps for a database-only workspace (also in its generated README):

```bash
# 1. Fill the "default" connection in dql.config.json (or Settings → Database)
npx zlens sync warehouse --schemas analytics   # 2. first time; then: npm run sync
npx zlens model discover --validate            # 3. preview the drafted model
npm run notebook                               # 4. review and certify in Modeling, then Ask
```

Database drivers are project-local so the base install stays fast:

| Database | Extra install | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into ZLens through HTTPS |
| DuckDB or local files | `npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'` | Needed for DuckDB, CSV, Parquet, and JSON. ZLens installs it on its own the first time it connects |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake connections |

You can also install DuckDB or Snowflake from the notebook Connections page.

Want a ready-made dbt project to try ZLens on? Clone the example repo and add
ZLens to it — the same steps you'd use on your own dbt repo:
[github.com/duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).

Already installed `zlens` globally? That only installs the
command. From an existing dbt repo, run `zlens init ./dql` before `cd dql`.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dbt <path>` | detected | Use the dbt project at `<path>` (the folder with `dbt_project.yml`) |
| `--warehouse <driver>` | — | Database only, no dbt. One of `duckdb`, `postgresql` (or `postgres`), `snowflake`, `bigquery`, `databricks`, `redshift`, `mysql`, `mssql`, `fabric`, `clickhouse`, `trino`, `athena`, `sqlite` |
| `--database-path <file>` | `./warehouse.duckdb` | With `--warehouse duckdb` or `sqlite`: the database file, relative to where you run the command |
| `--template <name>` | `starter` | Starter template |

`--dbt` and `--warehouse` cannot be combined.

## Docs

- [Quickstart](https://github.com/duckcode-ai-labs/zlens/blob/main/docs/01-quickstart.md)
- [Concepts](https://github.com/duckcode-ai-labs/zlens/blob/main/docs/02-concepts.md)
- [Connect your own warehouse](https://github.com/duckcode-ai-labs/zlens/blob/main/docs/guides/connect-warehouse.md)

## License

[Apache-2.0](https://github.com/duckcode-ai-labs/zlens/blob/main/LICENSE). The
package ships `LICENSE` and `NOTICE`. Versions of `create-dql-app` (its former
name) up to and including 1.17.2 were published as MIT and keep that licence.
