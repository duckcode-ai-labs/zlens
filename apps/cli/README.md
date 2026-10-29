# `zlens`

Official command-line interface for ZLens.

Use the CLI to scaffold projects, validate blocks, preview charts locally, and build static bundles, all on your own machine.

## Install

Use Node 20, 22, 24 or 26 (26 LTS recommended). If you change Node versions
after installing native database drivers, reinstall those project-local
dependencies for the active runtime.

```bash
npm i -D @zlens/cli@latest
npx zlens --version
```

Project-local installation is recommended for existing repositories. npm puts
the executable in `node_modules/.bin`, so use `npx zlens ...` or the repository's
`npm run ...` scripts. A bare shell command requires a global installation:

```bash
npm i -g @zlens/cli@latest
zlens --version
```

Or run it without adding a dependency:

```bash
npx -p @zlens/cli zlens --help
```

From this repo, you can also run:

```bash
pnpm exec zlens --help
```

## Quick Start

These commands use the project-local CLI installed by the starter templates.

```bash
npx create-zlens-app@latest my-dql-project
cd my-dql-project
npm install
npm run doctor
npm run notebook
```

If you want the dbt-integrated starter instead, use the Jaffle Shop semantic-layer course repo:

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm i -D @zlens/cli
npx zlens init .
npx zlens semantic import dbt .
npm run notebook
```

## Common Commands

The examples below use the short `zlens` form. For a project-local installation,
run them as `npm exec -- zlens ...` or through a repository script. See the
[complete CLI reference](../../docs/reference/cli.md) for every command,
subcommand, flag, and exit code.

- `zlens init [directory]` — create a starter ZLens project
- `zlens new block <name>` — scaffold a new DQL block in the current project
- `zlens new semantic-block <name>` — scaffold a semantic block plus companion YAML files
- `zlens new dashboard <name>` — scaffold a new dashboard in `dashboards/`
- `zlens new workbook <name>` — scaffold a new workbook in `workbooks/`
- `zlens doctor [path]` — check local setup, config, and starter folders
- `zlens parse <file.dql>` — parse and validate a DQL block
- `zlens fmt <file.dql>` — format a DQL file
- `zlens validate [path]` — validate DQL files and semantic references
- `zlens certify <file.dql>` — run certification checks
- `zlens preview <file.dql>` — preview a block in the browser
- `zlens build <file.dql>` — build a static bundle in `dist/`
- `zlens serve [directory]` — serve a built bundle locally

## Learn More

- Root docs: [`../../README.md`](../../README.md)
- Quickstart: [`../../docs/01-quickstart.md`](../../docs/01-quickstart.md)
- CLI reference: [`../../docs/reference/cli.md`](../../docs/reference/cli.md)
- Project config: [`../../docs/reference/file-formats.md`](../../docs/reference/file-formats.md)
