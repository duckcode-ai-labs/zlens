# Add ZLens to your dbt project

ZLens sits next to your dbt project. It reads dbt's artifacts and never
changes your dbt files.

## 1. Build the dbt manifest

From your dbt repo:

```bash
dbt parse      # or dbt build
```

This writes `target/manifest.json`. ZLens also reads `catalog.json`
(from `dbt docs generate`), `semantic_manifest.json` and `run_results.json`
when they exist.

## 2. Create the ZLens folder

Keep ZLens in a `dql/` folder inside the dbt repo:

```bash
npx create-zlens-app@latest dql
cd dql
npm install
```

The scaffolder finds `dbt_project.yml` in the folder above and writes this to
`dql.config.json`:

```json
"dbt": {
  "projectDir": "..",
  "manifestPath": "target/manifest.json"
}
```

Your repo now looks like this:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ target/manifest.json
└─ dql/
   ├─ dql.config.json
   ├─ notebooks/
   ├─ domains/
   ├─ apps/
   └─ .dql/          (local state, git-ignored)
```

!!! tip "Already have the CLI installed globally?"
    `zlens init ./dql` from the dbt repo root does the same job. It also reads
    your dbt profile and, for DuckDB, writes the connection for you.

**Separate folders.** If dbt and ZLens live side by side (`analytics/dbt/`
and `analytics/dql/`), run `create-zlens-app` from `analytics/`. It looks for
`dbt_project.yml` one and two levels up and in a sibling `dbt/` folder. You
can always set `dbt.projectDir` in `dql.config.json` yourself.

## 3. Import dbt

```bash
npm run sync
```

`zlens sync dbt` reads the manifest, compiles `dql-manifest.json` and
rebuilds the search index. It prints the model and source counts and ends
with `✓ dbt sync complete`.

Run it again whenever dbt changes. To re-run it on every manifest change:

```bash
npm exec -- zlens sync dbt --watch
```

## 4. Connect the database and open the workbench

```bash
npm run notebook
```

In Guided Setup:

1. On **Connect your dbt project**, click **Preview**, then **Apply project**.
   This turns on the dbt-first features, such as browsing dbt models in the
   notebook's **Database** tab.
2. On **Connect your database**, your dbt profile is listed under
   **dbt profiles**. Click **Import & test**.

You can do both later in **Settings → Project & dbt** and
**Settings → Database**. See [Connect a database](connect-database.md) for other
databases and for drivers.

## Check that it worked

- `npm run doctor` passes its checks.
- In **Notebooks**, the **Database** tab lists your dbt models.
- In **Lineage**, picking a saved query shows the dbt models it reads.

## dbt semantic metrics

If your dbt project has MetricFlow metrics, ZLens reads them from
`semantic_manifest.json`.

- Simple metrics run with ZLens's built-in compiler.
- Derived, ratio, cumulative and conversion metrics need a semantic runtime.
  Open **Settings → Project & dbt** and click **Install local MetricFlow**, or
  set up the dbt Cloud Semantic Layer on the same page.

## Large dbt projects

To import only part of a big project, add `dbtImport` filters to
`dql.config.json` and run `npm run sync` again:

```json
"dbtImport": {
  "anchors": ["tag:cards", "fct_card_transactions"],
  "include": ["path:models/marts/cards"],
  "exclude": ["tag:deprecated"]
}
```

## Troubleshooting

- **`manifest.json not found`.** Run `dbt parse` in the dbt project first.
- **Metrics missing.** Check that `target/semantic_manifest.json` exists.
- **Lineage out of date.** Run `npm run sync`.

Next: [Ask a question](../ask/index.md).
