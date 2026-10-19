# 01 — Getting started

!!! warning "Archived page"
    This page was written for an earlier version of ZLens and may not match the
    current product. See [About the archive](../archive.md) for the current page.

**Who this is for:** anyone adding ZLens to a dbt project for the first time.

**What you'll do:** add a ZLens workspace to a dbt repo, sync the dbt DAG,
open the notebook, and see end-to-end lineage.

**Time:** 10 minutes.

---

## Prerequisites

- **Node.js** 20, 22, or 24 LTS (check: `node --version`). Node 25 and 26 are
  not supported yet: ZLens's DuckDB driver has no prebuilt binary for them.
- **git** (any modern version)
- A dbt project with `target/manifest.json`
- Optional for tutorial 04: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, or a local Ollama server.

---

## Step 1 — Pick your dbt repo

Make sure the dbt manifest is fresh, then continue to Step 2:

```bash
cd your-dbt-repo
dbt parse         # or dbt build — either writes target/manifest.json
```

> **Need a ready repo?** Use the separate
> [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb)
> sample and follow its
> [README](https://github.com/duckcode-ai/jaffle-shop-duckdb#readme) (or the
> [Quickstart](../get-started/index.md)) instead of this tutorial. The sample
> is already a ZLens workspace, so skip Step 2 there: do not run
> `create-zlens-app` inside it.

---

## Step 2 — Scaffold the ZLens workspace

From the dbt repo root:

```bash
npx create-zlens-app@latest dql
cd dql
npm install
```

> **You should see** `detected sibling dbt project at …` during scaffolding —
> the generated `dql.config.json` is wired back to the parent dbt project.
> ZLens stays isolated under its own folder; your dbt files are untouched.

Point the default connection at the dbt warehouse. For a local DuckDB file,
edit `dql.config.json`:

```json
"connections": {
  "default": {
    "driver": "duckdb",
    "filepath": "../my_warehouse.duckdb"
  }
}
```

(Use your warehouse driver instead. Databricks is built in; DuckDB/local files
and Snowflake use project-local drivers. See
[connect-warehouse](../get-started/connect-database.md).)

Install only the driver your project uses:

```bash
npm install --prefix .dql/connectors duckdb          # DuckDB and local files
# npm install --prefix .dql/connectors snowflake-sdk # Snowflake
# Databricks does not need an extra package.
```

---

## Step 3 — Check the setup

```bash
npm run doctor
```

> **You should see** green checks for Node version, project config,
> directories, the default connection, and the dbt project, plus the next
> commands for the local workflow.

---

## Step 4 — Sync the dbt DAG

```bash
npm run sync
```

> **You should see** dbt sources and models imported into the DQL manifest —
> with their upstream lineage edges.

---

## Step 5 — Open the notebook

```bash
npm run notebook
```

The CLI starts a local server on **http://127.0.0.1:3474** and opens the
browser UI. Open `notebooks/welcome.dqlnb` and run a cell against a dbt
model:

```sql
SELECT date_trunc('month', ordered_at) AS month,
       SUM(order_total)                AS revenue
FROM dev.orders
GROUP BY 1 ORDER BY 1
```

> **You should see** real rows from the dbt-built warehouse. (`dev` is the
> schema used in this sample query; substitute your own schema if needed.)

---

## Step 6 — See the lineage

Click **Lineage** in the activity bar.

> **You should see** the imported dbt DAG: seeds/sources flowing into staging
> models into marts. As you add blocks, dashboards, and Apps in the next
> tutorials, they appear downstream of the dbt models they read — the full
> `source → dbt model → block → dashboard → App` graph.

---

## What you now have

- A ZLens workspace living inside a dbt repo (`./dql`), tracked in git
- The dbt DAG imported into `dql-manifest.json`
- A running local notebook querying the dbt warehouse
- Lineage from sources through dbt models

[Continue to tutorial 02 — Authoring blocks →](./02-authoring-blocks.md)
