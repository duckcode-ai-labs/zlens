# Repo layout & build

> ~2 minutes · ends with a local dev loop

## Clone & install

```bash
git clone https://github.com/duckcode-ai-labs/zlens.git
cd zlens
pnpm install
```

Requires **pnpm 9+** and **Node 20, 22, 24 or 26**.

## Layout

```
dql/
├── apps/
│   ├── cli/              # zlens CLI entry
│   ├── dql-notebook/     # Vite + React notebook
│   ├── notebook-browser/ # browser notebook build
│   ├── desktop/          # Tauri desktop shell
│   └── vscode-extension/ # VS Code extension
├── packages/
│   ├── dql-core/         # parser + AST + semantic + lineage
│   ├── dql-compiler/     # IR + emitters
│   ├── dql-runtime/      # query execution
│   ├── dql-connectors/   # active Databricks, DuckDB/file, and Snowflake drivers
│   ├── dql-governance/   # lint + certification
│   ├── dql-project/      # SQLite registry
│   ├── dql-lsp/          # language server
│   ├── dql-charts/       # chart specs
│   └── dql-ui/           # shared tokens + primitives
└── docs/                 # documentation (built with MkDocs, see mkdocs.yml)
```

This list is the main packages, not every one. See
[CONTRIBUTING.md](https://github.com/duckcode-ai-labs/zlens/blob/main/CONTRIBUTING.md) for the full list.

## Common scripts

```bash
pnpm build         # turbo-driven full build
pnpm test          # tests across packages
pnpm -F @zlens/notebook-app dev   # just the notebook UI (Vite)
pip install -r requirements-docs.txt && mkdocs serve   # the docs site
```

There is no root `dev` or `lint` script. Type-check one package with
`npx tsc --noEmit` from its folder.

## Running the CLI from source

```bash
pnpm -F zlens build
node apps/cli/dist/index.js --version
```

Or link it globally during dev:

```bash
cd apps/cli && pnpm link --global
zlens --version    # now shells out to your local build
```
