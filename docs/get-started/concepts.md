# Concepts

ZLens is a layer for certified analytics on your warehouse. If you use dbt,
dbt builds and tests your models and ZLens reads them; if you don't, ZLens
models your database's own tables (see [No dbt?](no-dbt.md)). ZLens covers what people
do with the data next: the queries, dashboards and AI answers. Everything is a file in your project, so it can be reviewed
in git.

## Saved query

A **saved query** is a named, reusable query. On disk it is a saved query (a
`.dql` block file). Besides the SQL (or a semantic metric query), it records an
owner, a Domain, a description, tests and a chart. Saved queries are what ZLens
reuses, reviews and cites.

A Domain groups data by business area, like Sales or Finance.

```dql
block "Revenue by Segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  owner = "analytics@company.com"
  description = "Total order revenue by customer segment"

  query = """
SELECT segment, SUM(amount) AS revenue
FROM analytics.orders
GROUP BY 1
"""

  tests {
    assert row_count > 0
  }
}
```

## Draft and certified

Every saved query has a status. The two that matter most:

- **Draft**: saved, but nobody has vouched for it yet.
- **Certified**: a person checked it. Certifying runs the saved query and any tests
  it declares (tests are optional), and records who certified it, when, and a
  fingerprint of the exact source.

**Saving never certifies.** Saving your work, importing SQL, or keeping an AI
answer always makes a draft. Only a person certifying it makes a saved query
certified: **Certify** in the saved query editor or on an imported draft, **Certify and
use this data** for a table in an App, or `zlens certify --from-draft`.

If a certified saved query's file is edited afterwards outside ZLens, its source no
longer matches that fingerprint. ZLens then shows it as **RECERTIFY** and Ask
stops treating it as certified until someone certifies it again.

See [Save and certify](../blocks/certify.md).

## Trust labels

Every answer and every App tile says how far to trust it:

| Label | Means |
|---|---|
| **Certified** | It ran a certified saved query exactly as reviewed. |
| **Governed** | It was built from semantic metrics and dimensions. |
| **Needs review** / **AI-generated** | AI wrote the SQL. Check it before relying on it. |
| A refusal | ZLens could not answer safely and says why, instead of guessing. |

See [Ask and trust](../ask/index.md).

## Notebook

A **notebook** (`.dqlnb`) is a list of cells: SQL, DQL, notes and inputs. It
is where you explore. Results are kept in a git-ignored `.run.json` file next
to it, so they never end up in a commit. A useful cell becomes a saved query with
**Save as saved query**. See [Notebooks](../notebooks/index.md).

## Semantic layer

The shared business vocabulary: **metrics** (such as revenue) and
**dimensions** (such as customer segment). ZLens imports dbt's semantic
models, so a DQL cell can ask for `@metric(revenue)` by `@dim(segment)`
without writing joins. See [Semantic layer](../reference/semantic-layer.md).

## App

An **App** is a set of dashboard and report pages for a decision or a team,
built from saved queries. Each tile shows its trust label, and readers can ask
questions about the App. Published Apps live in `apps/<app-id>/`. See
[Apps](../apps/index.md).

## Manifest

`dql-manifest.json` is ZLens's compiled view of the project: saved queries,
notebooks, Apps, metrics, the dbt models they read, and the links between
them. `zlens compile` and `zlens sync dbt` write it.

## Lineage

**Lineage** is the graph from source tables and dbt models through saved queries to
the Apps that show them. It answers "where did this number come from?" and
"what uses this model?". See [Lineage](../lineage/index.md).

## How they fit

```text
dbt sources and models ─┐
                        ├─▶ semantic layer ─▶ blocks ─▶ notebooks
warehouse tables ───────┘                       │
                                                ▼
                                               Apps ◀── Ask
                                                │
                                                ▼
                                             lineage
```

## What the open-source version is

ZLens open source is a local, single-user workspace. Certification,
personas and App visibility are local labels kept in your files; they are
not a hosted permission system.
