# Install

ZLens is a set of npm packages. Most people never install it by hand: the
[Quickstart](index.md) scaffolds a project that installs the CLI locally.
This page covers the other ways to install and upgrade.

## Run it without installing

```bash
npx zlens notebook ./my-data
```

`npx` fetches the `zlens` package (the `zlens` command of `@zlens/cli`) and
runs it. `./my-data` can be a dbt project, a folder with a DuckDB or SQLite
file, or a folder of CSV, Parquet or JSON files. ZLens asks before it creates
a project there (`--yes` creates it without asking), then opens the workbench.
Run the same command again to reopen it.

To start a new project and open it in one step:

```bash
npm create zlens@latest
```

In a folder with data it offers to make the project there; anywhere else it
asks for a new folder's name. On npm 12, add `--allow-scripts=better-sqlite3`
after `npx` or after `npm create zlens@latest` (see
[npm 12 and install scripts](#npm-12-and-install-scripts)); npm 10 and 11
ignore the flag.

`npx @zlens/cli` does not work: that package has two commands (`zlens`, and
`dql`, its old name), so npx cannot tell which to run. Use `npx zlens`.

## Requirements

- Node.js 20, 22, 24 or 26 (26 LTS recommended). CI tests all four.
  Odd-numbered lines such as Node 25 run but are not tested.
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

`zlens notebook` and `zlens sync warehouse` install the active connection's
driver into `.dql/connectors` the first time they run. To install it yourself
(offline or in CI), install only the driver your database needs, from the
project folder:

| Database | Install |
|---|---|
| DuckDB, or local CSV, Parquet and JSON files | `npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'` |
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

### Just try it: the demo image

```bash
docker run --rm -p 127.0.0.1:3474:3474 -p 127.0.0.1:54545:54545 -p 127.0.0.1:1455:1455 ghcr.io/duckcode-ai/zlens-demo
```

The image holds the Jaffle Shop sample, already built. It makes an access
token, waits for ZLens and prints one link (`http://localhost:3474/?app=…#dql_token=…`)
that opens the sample's certified App. Nothing is kept after you stop it
(Ctrl+C). Ports 54545 and 1455 are where **Sign in with Claude** and **Sign in
with ChatGPT** return your browser; leave them out if you use an API key. Port 3474 already in use? Run
`docker run --rm -e ZLENS_PORT=3480 -p 127.0.0.1:3480:3480 ghcr.io/duckcode-ai/zlens-demo`.

### Run your own project in Docker

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
`install scripts blocked because they are not covered by allowScripts`. One
package ZLens uses downloads its native binary in that script:

| Package | What ZLens uses it for | Where it is allowed |
|---|---|---|
| `better-sqlite3` | the local index, run history and caches | your project's `package.json`: projects from `create-zlens-app` 0.2.1 and the sample projects already have it |

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

**The DuckDB driver.** `@duckdb/node-api` has no install script, so it needs
no `allowScripts` entry. Its binary comes as a per-platform optional
dependency. If it is missing (optional dependencies skipped, or a `.dql`
folder copied from another operating system), `zlens notebook` (at startup)
and `zlens sync warehouse` reinstall it. To do it yourself:

```bash
npm --prefix .dql/connectors install @duckdb/node-api --include=optional
```

**`npx zlens` and `npm create zlens`.** They install into npm's cache, which
has no `package.json` of yours either, and npx reuses what it installed. If
ZLens says npx installed it without running the script, clear that copy and
run the command again with the flag. ZLens prints both commands, with the
copy's key:

```bash
npm cache npx rm <key>
npx --allow-scripts=better-sqlite3 zlens notebook ./my-data
```

Pass the flag the first time to skip this:
`npx --allow-scripts=better-sqlite3 zlens …` or
`npm create zlens@latest --allow-scripts=better-sqlite3`.

**A global install.** `npm install -g` has no `package.json` to allow scripts
in, so pass the flag (or set it once with
`npm config set allow-scripts=better-sqlite3 --location=user`):

```bash
npm install -g @zlens/cli --allow-scripts=better-sqlite3
```

npm 12 needs Node.js 22.22.2 or newer (or 24.15.0 or newer, or Node 26). npm 10 and 11
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

**A native driver fails to build (`node-gyp rebuild`).** Switch to an LTS
Node (20, 22, 24 or 26) and retry: better-sqlite3 has prebuilt binaries for
those. On macOS run `xcode-select --install` once. On Linux install
`python3`, `make` and `g++`; on Windows, the Microsoft C++ Build Tools.

**Docker: port already in use.** In `docker-compose.yml`, change
`127.0.0.1:3474:3474` to another host port, such as `127.0.0.1:3475:3474`, and
set `ZLENS_ALLOWED_ORIGINS` to match.

More fixes: [Troubleshooting](../guides/troubleshooting.md).
