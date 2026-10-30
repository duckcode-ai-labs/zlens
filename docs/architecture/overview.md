# Architecture overview

ZLens is a pnpm + Turbo monorepo. The runtime is a small set of focused
packages; the two user-facing surfaces are the CLI and the notebook.

## Packages

| Package | Role |
| --- | --- |
| `@zlens/core` | Lexer, parser, AST, semantic resolution, lineage, canonical format |
| `@zlens/dql-compiler` | IR + Vega-Lite / HTML emitters |
| `@zlens/runtime` | Query execution, param binding, result shaping |
| `@zlens/connectors` | Active Databricks HTTP, DuckDB/file, and Snowflake drivers, with optional project-local installs for native packages |
| `@zlens/governance` | Lint rules, certification gates |
| `@zlens/project` | SQLite-backed project registry & manifest cache |
| `@zlens/dql-lsp` | Language server for editor integrations |
| `@zlens/charts` | Chart spec resolution |
| `@zlens/ui` | Shared design tokens + primitives (v0.10) |

## Apps

| App | Role |
| --- | --- |
| `zlens` | Single `zlens` binary — `init / compile / notebook / diff / …` |
| `dql-notebook` | Vite + React 18 browser-first notebook |
| `vscode-extension` | `.dql` syntax, validation, preview in VS Code |
| `docs` | Plain-markdown docs (this folder) |

## Data flow

```
user edits .dql file
        │
        ▼
  dql-core parser ─────────────▶ AST
        │                         │
        │                         ▼
        │                   dql-governance (lint)
        │                         │
        ▼                         ▼
   dql-compiler IR ────▶ dql-runtime ────▶ warehouse (via dql-connectors)
        │                    │
        ▼                    ▼
  HTML dashboard         notebook result
        │                    │
        └──────┬─────────────┘
               ▼
        lineage DAG (dql-core)
               │
               ▼
        OpenLineage snapshot (optional, from your own script)
```

## Where data lives

| Data | Storage |
| --- | --- |
| Source `.dql` files | Git |
| Project manifest cache | `.dql/cache/manifest.sqlite` (better-sqlite3) |
| Run snapshots | Sibling `<notebook>.run.json` (git-ignored) |
| Block registry | `.dql/registry.sqlite` |
| Query results | In-memory; never persisted unless snapshotted |

Nothing requires a hosted DB. ZLens is fully local-first.
