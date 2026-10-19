# Install

ZLens is a set of npm packages. Most people never install it by hand: the
[Quickstart](index.md) scaffolds a project that installs the CLI locally.
This page covers the other ways to install and upgrade.

## Requirements

- Node.js 20, 22 or 24 (24 LTS recommended). CI tests all three. Node 25 and
  26 are not supported yet: ZLens's DuckDB driver has no prebuilt binary for
  them, so the driver install would compile DuckDB from source and ZLens stops
  with "use Node 24 LTS or 22" instead.
- npm 10 or newer. On npm 12, see [npm 12 and install scripts](#npm-12-and-install-scripts).
- macOS, Linux or Windows.

## Option A: a new project with npm (recommended)

```bash
npx create-zlens-app@latest my-analytics
cd my-analytics
npm install
npm run doctor
npm run notebook
```

`npm run notebook` opens the workbench at `http://127.0.0.1:3474`.

The project gets `dql.config.json`, a welcome notebook, and npm scripts:

| Script | Runs |
|---|---|
| `npm run notebook` | `zlens notebook` |
| `npm run sync` | `zlens sync dbt` |
| `npm run compile` | `zlens compile` |
| `npm run lineage` | `zlens lineage` |
| `npm run doctor` | `zlens doctor` |
| `npm run validate` | `zlens validate` |

Run it inside a dbt repo to wire the dbt project in automatically; see
[Add ZLens to your dbt project](your-dbt-project.md).

### Database drivers

Install only the driver your database needs, from the project folder:

| Database | Install |
|---|---|
| DuckDB, or local CSV, Parquet and JSON files | `npm install --prefix .dql/connectors duckdb` |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` |
| Databricks SQL | nothing; it is built in |

You can also install DuckDB or Snowflake from **Settings → Database** with
**Install connector**. See [Connect a database](connect-database.md).

## Option B: add the CLI to an existing ZLens project

```bash
npm pkg set allowScripts.better-sqlite3=true --json   # needed on npm 12
npm i -D @zlens/cli
npm exec -- zlens doctor
npm exec -- zlens notebook
```

## Option C: a global install

```bash
npm i -g @zlens/cli --allow-scripts=better-sqlite3
zlens --version
```

npm 12 needs `--allow-scripts=better-sqlite3` for a global install (see
below); npm 10 and 11 ignore it.

A global install gives you the `zlens` command only. It does not create a
project. Create one with `zlens init`:

```bash
cd my-dbt-repo
zlens init ./dql
cd dql
zlens doctor
```

## Option D: Docker

No Node.js needed on your machine.

```bash
git clone https://github.com/duckcode-ai-labs/zlens.git
cd zlens
export ZLENS_SERVER_TOKEN="$(openssl rand -hex 24)"
docker compose up
```

1. The first build takes a few minutes.
2. `docker compose up` prints a link like
   `http://127.0.0.1:3474/#dql_token=<your token>`. Open that link.
3. Run from the ZLens source repo, Docker creates and opens a starter project
   under `.dql/docker-starter/`. Run from a folder with `dql.config.json`, it
   opens that folder as the project.

The container binds `0.0.0.0`, so ZLens refuses to start without
`ZLENS_SERVER_TOKEN`. The compose file sets `ZLENS_ALLOWED_ORIGINS` for
`127.0.0.1:3474` and `localhost:3474`; change it if you map another port.

Optional extras:

```bash
docker compose --profile slack up    # adds the Slack bot on :3479
docker compose --profile ollama up   # adds a local Ollama on :11434
```

## npm 12 and install scripts

npm 12 blocks a dependency's install script unless the project's
`package.json` lists the package in `allowScripts`, and prints
`install scripts blocked because they are not covered by allowScripts`. Two
packages ZLens uses download their native binary in that script:

| Package | What ZLens uses it for | Where it is allowed |
|---|---|---|
| `better-sqlite3` | the local index, run history and caches | your project's `package.json`: projects from `create-zlens-app` 0.2.1 and the sample projects already have it |
| `duckdb` | the DuckDB driver | `.dql/connectors/package.json`: ZLens writes it when it installs or repairs the driver |

The entry in `package.json` is:

```json
"allowScripts": {
  "better-sqlite3": true
}
```

**A folder installed without it.** ZLens stops with "ZLens could not load
better-sqlite3" and `npm run doctor` fails its **SQLite native module** check.
Approve the script and rebuild, in the project folder:

```bash
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
```

**The DuckDB driver.** `zlens notebook` (at startup) and `zlens sync warehouse`
repair a driver installed without its binary. To do it yourself:

```bash
npm --prefix .dql/connectors install-scripts approve duckdb
npm --prefix .dql/connectors rebuild duckdb
```

**A global install.** `npm install -g` has no `package.json` to allow scripts
in, so pass the flag (or set it once with
`npm config set allow-scripts=better-sqlite3 --location=user`):

```bash
npm install -g @zlens/cli --allow-scripts=better-sqlite3
```

npm 12 needs Node.js 22.22.2 or newer (or 24.15.0 or newer). npm 10 and 11
run install scripts as before and ignore `allowScripts`.

## Run project commands

A project-local CLI is not on your shell's `PATH`. Use one of these:

| You want | Run |
|---|---|
| A provided script | `npm run doctor` |
| Any command | `npm exec -- zlens <command>` |
| Shorthand | `npx zlens <command>` |
| A global install | `zlens <command>` |

This is why `npm run doctor` can work while a bare `zlens doctor` says
`command not found`.

## Verify

```bash
npm exec -- zlens --version   # project-local
zlens --version               # global
```

Both print `zlens` and a version number.

## Upgrade

Upgrading is a normal npm install of the latest version.

```bash
npm i -D @zlens/cli@latest    # project-local (recommended)
npm i -g @zlens/cli@latest --allow-scripts=better-sqlite3   # global
```

The first time the workbench opens after an upgrade, it shows **Guided Setup**
again so you can check the project, database and AI settings.

### Upgrading from the `dql` command

ZLens used to be published as `@duckcodeailabs/dql-cli`, with the
`create-dql-app` starter and the `dql` command. They are replaced by
`@zlens/cli`, `create-zlens-app` and `@zlens/*`.

- The `dql` command still works as an alias for `zlens`, so existing scripts
  keep running.
- Your `.dql` files, `dql.config.json` and `dql.app.json` keep their names.
  DQL is still the name of the query language.

## Troubleshooting

**`zlens: command not found`, or an old version.** Run the latest without
any `PATH` setup:

```bash
npx -p @zlens/cli@latest zlens notebook
```

To fix a global install, check these in order:

```bash
which -a zlens               # an old copy shadowing it?
hash -r                      # clear the shell's cached path
npm ls -g @zlens/cli         # installed globally?
npm prefix -g                # "<prefix>/bin" must be on PATH
npm i -g @zlens/cli@latest --allow-scripts=better-sqlite3   # reinstall; a failed install never links the command
```

**"ZLens could not load better-sqlite3" or "Could not locate the bindings
file".** npm 12 skipped its install script. See
[npm 12 and install scripts](#npm-12-and-install-scripts).

**A native driver fails to build (`node-gyp rebuild`).** Switch to Node 22
LTS and retry. On macOS run `xcode-select --install` once. On Linux install
`python3`, `make` and `g++`; on Windows, the Microsoft C++ Build Tools.

**Docker: port already in use.** In `docker-compose.yml`, change
`127.0.0.1:3474:3474` to another host port, such as `127.0.0.1:3475:3474`, and
set `ZLENS_ALLOWED_ORIGINS` to match.

More fixes: [Troubleshooting](../guides/troubleshooting.md).
