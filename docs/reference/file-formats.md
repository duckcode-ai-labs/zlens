# File formats

## `.dql` — the core format

Canonical, git-friendly, version-headered.

```dql
// dql-format: 1

block "Revenue by Segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  description = "Revenue by customer segment."
  owner = "analytics@company.com"
  tags = ["revenue"]

  query = """
SELECT segment, SUM(amount) AS revenue
FROM analytics.orders
GROUP BY 1
"""

  visualization {
    chart = "bar"
    x = segment
    y = revenue
  }
}
```

- **Version header** — `// dql-format: N` on line 1. Older files without a
  header are still parsed; `zlens fmt` adds the header on next save.
- **Canonical whitespace** — `zlens fmt` enforces it. CI should run `zlens fmt --check .`
- **Forward compatibility** — unknown top-level keys are preserved verbatim
- **Display hints** — block `visualization` is stored in the manifest as
  `displayHints`; Apps and notebooks can override it without changing the block.

## `.dqlnb` — notebook

JSON document holding a sequence of cells (`markdown`, `sql`, `dql`, `chart`).
Written in a stable key-order so git diffs stay readable.

```json
{
  "version": 1,
  "metadata": { "name": "Welcome", "createdAt": "2026-04-17T00:00:00Z" },
  "cells": [
    { "id": "c1", "type": "markdown", "source": "# Welcome" },
    { "id": "c2", "type": "sql", "source": "select 1" }
  ]
}
```

## `.run.json` — run snapshots

Sibling file next to a notebook holding the last execution's results:

```json
{
  "version": 1,
  "notebookPath": "notebooks/overview.dql",
  "capturedAt": "2026-04-15T12:34:56Z",
  "cells": [
    {
      "cellId": "abc123",
      "status": "success",
      "executionCount": 4,
      "result": { "columns": [...], "rows": [...], "rowCount": 42 }
    }
  ]
}
```

- **Git-ignored by default** — ZLens auto-appends `*.run.json` to `.gitignore` on first write
- **Used for rehydration** — re-opening a notebook loads results without re-running queries
- **Save trigger** — debounced 600ms after a cell's execution count / row count changes

## `.dql/local/notebook-research.sqlite` — notebook research state

Project-local SQLite database for notebook research runs. It stores local
review state such as source-cell fingerprints, reviewed SQL, preview metadata,
context-pack evidence, parameter review, duplicate/reuse decisions, and DQL
draft promotion references.

- **Local/private by default** — do not commit `.dql/local/**`
- **Source of queue state** — powers the notebook Research panel filters,
  counts, source coverage, and next-action buckets
- **Not a certified artifact** — create a DQL draft and certify the block when
  the research becomes shared business logic

## `.dqld` — App dashboard page

JSON document for one dashboard page inside an App. It stores grid layout,
block refs, text tiles, filters, page metadata, and per-tile consumer display
metadata. A tile's `viz` is the current renderer choice. A tile's `display`
is the governed GenUI contract: why that renderer was chosen, which
visualizations are allowed, and whether the presentation is certified or still
review-required.

```json
{
  "version": 1,
  "id": "daily-ops",
  "metadata": {
    "title": "Daily Ops",
    "visibility": "shared",
    "lifecycle": "review"
  },
  "layout": {
    "kind": "grid",
    "cols": 12,
    "rowHeight": 80,
    "items": [
      {
        "i": "approval-rate",
        "x": 0,
        "y": 0,
        "w": 4,
        "h": 3,
        "block": { "blockId": "card_approval_rate" },
        "title": "Approval Rate",
        "viz": { "type": "kpi", "options": { "valueField": "approval_rate" } },
        "display": {
          "mode": "block_hint",
          "component": "KpiMetric",
          "defaultVisualization": "kpi",
          "allowedVisualizations": ["kpi", "single_value", "table"],
          "fieldHints": { "value": "approval_rate" },
          "layoutIntent": "compact",
          "rationale": "Executive app uses KPI presentation for the certified approval-rate block.",
          "trustState": "certified",
          "reviewStatus": "certified"
        }
      }
    ]
  }
}
```

Dashboard pages are committed under `apps/<app-id>/dashboards/*.dqld`.
Private layout overrides and saved views stay local under `.dql/local/`.
AI pins are local until promoted into draft/certified DQL blocks or reviewed
dashboard tiles.

## `dql.app.json` — App manifest

JSON document for a local-first App package.

```json
{
  "version": 1,
  "id": "cards-ops",
  "name": "Cards Operations",
  "domain": "cards",
  "owners": ["cards-analytics@example.com"],
  "subdomain": "fraud",
  "groups": ["daily-ops"],
  "visibility": "shared",
  "lifecycle": "draft",
  "homepage": { "type": "dashboard", "id": "daily-ops" },
  "notebooks": [
    {
      "path": "notebooks/investigation.dqlnb",
      "title": "Investigation Notebook",
      "role": "analysis",
      "visibility": "shared"
    }
  ]
}
```

The App loader requires `id` (letters, digits, `-` and `_`, starting with a
letter or digit), `name`, a domain (`ownerDomain`, or the older `domain`) and
at least one entry in `owners`. An App missing any of them is not loaded. `version` is optional and must be `1`.
Pages are not listed here: each `.dqld` file under the App's `dashboards/`
folder is a page. A notebook `path` is relative to the project root.

In OSS, `visibility`, `domain`, `subdomain`, `groups`, `audience`, and
`lifecycle` are organization metadata and trust labels. They are not hosted
permissions or RBAC enforcement.

## `dql.config.json` — project config

Lives at the project root. Written by `zlens init` and `create-zlens-app`.

```json
{
  "project": "jaffle-analytics",
  "layout": { "version": 2, "mode": "oss-dbt-workspace", "skillsPath": "skills" },
  "connections": {
    "default": { "driver": "duckdb", "filepath": ":memory:" }
  },
  "metadataScopes": {
    "default": {
      "mode": "selected_scopes",
      "scopes": [
        { "catalogOrDatabase": "jaffle_shop", "schemas": ["main"] }
      ]
    }
  },
  "semanticLayer": { "provider": "dql", "path": "semantic-layer" },
  "dbt": {
    "projectDir": "../dbt",
    "manifestPath": "target/manifest.json"
  },
  "datalex": {
    "manifestPath": "../datalex/datalex-manifest.json"
  },
  "governance": {
    "required_fields": ["domain", "owner", "description"]
  },
  "agent": {
    "valueProfile": { "mode": "off" },
    "resultReview": { "mode": "off" }
  },
  "apps": {
    "requireCertifiedToPublish": false
  }
}
```

Fields:

- **`project`** — human-readable project name
- **`layout`** — OSS workspace convention. New projects use version `2` and
  keep shared agent guidance in visible `skills/`; legacy `.dql/skills/` is
  read only for migration compatibility.
- **`connections`** — named database connections. `default` is used unless a block overrides it
- **`metadataScopes`** — optional per-connection warehouse metadata allowlists.
  The notebook Database panel writes this only after the connection target and
  bounded metadata synchronization succeed. `dbt_relations` indexes exact
  current manifest relations; `selected_scopes` indexes only the named
  databases/catalogs and schemas; `dbt_plus_selected` combines both. Secrets,
  observed target identity, and generated fingerprints are never stored here.
- **`semanticLayer`** — `{ provider, path, projectPath }`. Providers: `dql` (local YAML), `dbt`, `cubejs`, `snowflake`
- **`dbt`** — `{ projectDir, manifestPath }` for in-place or sibling dbt projects. `zlens compile` and `zlens sync dbt` read from here
- **`datalex`** — optional `{ manifestPath }` for validating `datalex_contract` references. ZLens works without DataLex; this only enables interop checks when a DataLex manifest exists
- **`governance`** — required fields every block must declare to pass `zlens certify`
- **`agent.valueProfile`** — `{ mode: "off" | "sampled", exclude: [patterns] }`,
  off by default. `sampled`: each warehouse-first schema sync also reads a few
  example values and the range of each column for Ask's SQL drafter; those
  values reach your AI provider with the drafting prompt. Sensitive columns
  and values are never read, and never under a hosted server. See
  [value profile](../get-started/no-dbt.md#optional-show-the-drafter-what-the-columns-hold).
- **`agent.resultReview`** — `{ mode: "off" | "on" }`, off by default. `on`:
  before an AI-drafted answer is shown, one more AI call checks its result
  against the question and may revise the SQL once. It sends the question,
  the SQL and the result's shape (row count, distinct and empty values per
  column, repeated rows), never a value from the result. Costs about one AI
  call per AI-drafted answer (median 3.6 s on Claude). See
  [a second look at the result](../ask/needs-review.md#optional-a-second-look-at-the-result).
  Both settings are read at every question, so a change applies to the next one.
- **`apps.requireCertifiedToPublish`** — `true` or `false`, `false` by default.
  Off: publishing an App is never blocked by trust; tiles nobody certified
  carry **Not certified yet** for readers, and the publish dialog recommends
  certifying them. `true`: every tile of an App (its data, every join it can
  reach, every input of a calculation) must be certified before the App is
  published; the publish dialog and the server refuse with one message,
  `APP_BUILD_REQUIRES_CERTIFIED`, and list the certify actions. It is read at
  every publish, so a change applies to the next one. There is no per-App
  setting; an older App's `sourcePolicy` ("Only certified data") is ignored.
  `zlens doctor` reports it on its **App publishing** line. With a host, the
  host's admin policy can turn it on for the project. See
  [Publish](../apps/build.md#7-publish).

### Environment variables

Environment variables that configure ZLens use the `ZLENS_` prefix, for example
`ZLENS_SERVER_TOKEN` and `ZLENS_ALLOWED_ORIGINS`. The older `DQL_` names (for
example `DQL_SERVER_TOKEN`) are still read as a fallback when the `ZLENS_`
variable is not set, so existing setups keep working.

`ZLENS_ASK_RESULT_REVIEW=1` turns the result review on and `=0` turns it off,
whatever `agent.resultReview` says.

## `dql-manifest.json` — build output

Generated by `zlens compile`. Declares every block/notebook/dashboard in the
project plus their lineage edges. Read by third-party lineage tools, and by
`@zlens/openlineage` when you send a lineage snapshot.
