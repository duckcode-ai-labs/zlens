# Compatibility

## Runtime

- **Node.js** — 20, 22, or 24 LTS (24 recommended). Node 21, 23, 25 and 26
  are not supported: the `duckdb` package ZLens installs for DuckDB and local
  files publishes prebuilt binaries only for Node 20, 22 and 24, so on any
  other Node its install compiles DuckDB from source (over ten minutes, and a
  failure without Python and a C++ toolchain). ZLens does not start that build
  on its own; it says to use Node 24 LTS or 22. To build from source anyway,
  set `ZLENS_DUCKDB_BUILD_FROM_SOURCE=1` and install DuckDB from the
  Connections page.
- **Package managers** — npm, pnpm, yarn all work for consuming published packages
- **OS** — macOS, Linux, Windows

## Connectors

ZLens uses a flat install. Databricks SQL is built in; DuckDB/local files and
Snowflake install project-local driver packages into `.dql/connectors/`. See
[Connectors](./connectors.md).

## Chart types

`bar`, `line`, `scatter`, `donut`, `pie`, `area`, `heatmap`, `kpi`, `table`,
`histogram`, `grouped-bar`, `stacked-bar`, `waterfall`, `funnel`, `gauge`,
`geo`, `combo`, `boxplot`, `forecast`, `stacked-area`.

## Editor support

- **VS Code** — [`dql.dql-language-support`](https://marketplace.visualstudio.com/items?itemName=dql.dql-language-support) extension (syntax, snippets, LSP)
- **Any LSP client** — `@zlens/dql-lsp` speaks standard LSP

## What's in this repo

- DQL language (parser, formatter, AST)
- CLI (`init`, `notebook`, `compile`, `sync`, `diff`, `preview`, `serve`, `certify`, `validate`, `fmt`, `doctor`)
- Notebook UI (SQL + DQL cells, Block Studio, lineage panel, git panel, governed chat)
- Apps, dashboard pages, attached notebooks, personal AI pins, and optional local persona/policy previews
- Semantic layer (local YAML + dbt manifest and semantic manifest import)
- Lineage DAG (Domain / App / Dashboard / Notebook / Block / semantic / dbt / source granularity)
- Active connectors for Databricks SQL, DuckDB/local files, and Snowflake
- Local agentic analytics with certified-first routing, draft block proposals, and BYO provider setup
- Local schedules and Slack front-end
- Plugin API (custom connectors, charts, governance rules)
- OpenLineage export

## What's **not** in this repo

Lives in the closed DuckCode Cloud product:

- Hosted multi-user workspace with SSO, enforced RBAC, audit logs, and governed secrets
- Organization memory, approval workflows, and permissions-aware team retrieval
- Managed scheduled monitors, alerting, orchestration, and Slack/Teams delivery
- Regulatory governance packs (SOX, HIPAA, GDPR)
- Premium connectors (SAP, Oracle, mainframe)
- Federated multi-warehouse blocks
