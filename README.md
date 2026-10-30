<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zlens-lockup-horizontal-reverse.svg">
    <img alt="ZLens" src="docs/assets/brand/zlens-lockup-horizontal.svg" width="300">
  </picture>
</p>

<h3 align="center">Certified, or it says so.</h3>

<p align="center">
  Certified answers on your warehouse.<br>
  Every answer says what it is built on:<br>
  a certified saved query, your semantic metrics, or SQL that AI wrote and someone still needs to review.
</p>

<p align="center">
  <a href="https://github.com/duckcode-ai-labs/zlens/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/duckcode-ai-labs/zlens/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@zlens/cli"><img alt="npm @zlens/cli" src="https://img.shields.io/npm/v/@zlens/cli?label=%40zlens%2Fcli"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="https://nodejs.org"><img alt="Node 20 | 22 | 24 | 26" src="https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024%20%7C%2026-green"></a>
</p>

<p align="center">
  <a href="https://docs.zlens.app/"><b>Docs</b></a> ·
  <a href="#try-it-in-one-click"><b>Try it in one click</b></a> ·
  <a href="#quickstart"><b>Quickstart</b></a> ·
  <a href="#video-tutorials"><b>Video tutorials</b></a> ·
  <a href="https://docs.zlens.app/agents/"><b>AI agents (MCP)</b></a> ·
  <a href="https://github.com/duckcode-ai-labs/zlens/discussions"><b>Discussions</b></a> ·
  <a href="./CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<p align="center">
  <a href="https://docs.zlens.app/">
    <img src="docs/media/clips/overview.gif" alt="ZLens in under a minute: Ask 'How has revenue changed by month?' and get a Certified answer from the monthly_revenue saved query, see how it was answered, open the Jaffle Growth Review App where all data is certified, then trace lineage from the dbt sources through the saved query to the App" width="100%">
  </a>
</p>

## What is ZLens?

ZLens is a local, open-source workbench for governed analytics. It works on
top of your dbt project, or straight on your database's own tables. It turns
the analytics people build (queries, notebooks, dashboards and AI answers)
into files you review in git, and it tells you how far to trust each answer.

Watch the [90-second film](https://youtu.be/nsyLc4UfKxo) for the whole idea.

When someone asks a question, ZLens tries the most trusted source first and
labels what it used:

| Label | Answered from | Means |
|---|---|---|
| ● **Certified** | a certified saved query | Ran a saved query a person reviewed and certified, exactly as certified. |
| ◐ **From Metrics** | your semantic layer | Built from approved metrics and dimensions. Not certified. |
| ○ **Needs review** | SQL written by AI | Grounded in your schema and checked before it runs, then saved as a draft saved query until someone certifies it. |

If none of these can answer safely, Ask refuses and says why. It never dresses
an unreviewed number up as a trusted one.

- **dbt stays the source of truth.** ZLens reads your manifest, semantic
  models and profiles; it does not replace dbt. No dbt? ZLens reads your
  database's tables, keys and comments and drafts the joins for you to
  certify.
- **Everything is a file.** Saved queries (`.dql` block files), notebooks
  (`.dqlnb`) and Apps live
  in your repo, so they are diffed, reviewed and versioned like code.
- **Works with your coding agent.** A built-in MCP server gives Claude Code,
  Codex, Cursor and Claude Desktop the same certified-first answers and labels.
- **Runs on your terms.** Use a Claude or ChatGPT subscription, an API key
  (Anthropic, OpenAI, Gemini or any OpenAI-compatible endpoint), or a local
  model through Ollama. No ZLens account or hosted service, and no usage telemetry.

## Try it in one click

See ZLens working on the Jaffle Shop sample, with nothing to install.

**In your browser:**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/duckcode-ai/jaffle-shop-duckdb?quickstart=1)

Click the button, then **Create codespace**. In about a minute ZLens opens in a
panel inside the codespace, and the terminal prints a link that opens it in its
own tab: the certified saved queries, the Jaffle Growth Review App, lineage and
notebooks. Nothing opened? Click **Ports**, then the globe next to **ZLens (3474)**. It uses your GitHub account's free Codespaces hours;
stop it at [github.com/codespaces](https://github.com/codespaces) when you're done.

No dbt? The same in one click on the database-only sample, the Jaffle Shop as
a plain DuckDB file:

[![Open the database-only sample in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/duckcode-ai/jaffle-shop-warehouse?quickstart=1)

**With Docker:**

```bash
docker run --rm -p 127.0.0.1:3474:3474 -p 127.0.0.1:54545:54545 -p 127.0.0.1:1455:1455 ghcr.io/duckcode-ai/zlens-demo
```

Open the link it prints. It runs on your machine and keeps nothing after you
stop it (Ctrl+C). Ports 54545 and 1455 let **Sign in with Claude** and **Sign in
with ChatGPT** finish inside the container.

**On your own data, in one command:**

```bash
npx zlens notebook ./my-data
```

`./my-data` can be a dbt project, a folder with a DuckDB or SQLite file, or a
folder of CSV, Parquet or JSON files (each file becomes a table). ZLens asks
before it creates a project there, then opens the workbench, and Guided Setup
drafts the tables and joins for you to certify. To start a new project
instead, run `npm create zlens@latest`. On npm 12, add
`--allow-scripts=better-sqlite3` after `npx` (or after `npm create zlens@latest`);
see [npm 12 and install scripts](https://docs.zlens.app/get-started/install/#npm-12-and-install-scripts).

Whichever you use, **Ask** needs an AI model: add one in **Settings → AI provider**.
For the full walkthrough on a sample dbt project, follow the [Quickstart](#quickstart).

## Quickstart

Run ZLens on the Jaffle Shop sample dbt project. It takes about ten minutes
and needs Node.js 20, 22, 24 or 26 (26 LTS recommended), Python 3.9 to 3.14
and git. `./setup.sh` picks a supported Python for you. No warehouse account
is needed.

**1. Get the sample and set it up**

The sample is the Jaffle Shop dbt project on DuckDB, already set up as a
ZLens workspace. Clone it and run its setup script:

```bash
git clone https://github.com/duckcode-ai/jaffle-shop-duckdb.git
cd jaffle-shop-duckdb
./setup.sh
```

`./setup.sh` builds the sample's DuckDB database with dbt, installs ZLens and
the DuckDB driver into this folder, and imports the dbt project. It ends with
`Setup complete.` and is safe to run again.

<details>
<summary>Without the script</summary>

<br>

Build the database:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/dbt deps --profiles-dir .
.venv/bin/dbt seed --profiles-dir .
.venv/bin/dbt build --profiles-dir . --exclude resource_type:seed
```

Install ZLens and import the dbt project:

```bash
npm install
npm run sync
```

You don't need to install the DuckDB driver: `npm run notebook` installs the
active connection's driver the first time it starts.

</details>

> [!NOTE]
> **npm 12** runs a dependency's install script only when `package.json` lists
> it in `allowScripts`. The sample already allows `better-sqlite3`, the SQLite
> library ZLens keeps its index in. The DuckDB driver has no install script,
> so it needs no entry. If ZLens says it could not load
> better-sqlite3 (a folder installed before the sample had the entry), run
> `npm install-scripts approve better-sqlite3` then
> `npm rebuild better-sqlite3`. See
> [npm 12 and install scripts](https://docs.zlens.app/get-started/install/#npm-12-and-install-scripts).

> [!NOTE]
> Do not run `create-zlens-app` inside the sample: it creates a second, empty
> workspace in `dql/`.

**2. Open the workbench**

```bash
npm run notebook
```

The terminal prints `Notebook ready: http://127.0.0.1:3474` and your browser
opens it.

**3. Finish Guided Setup and run a query**

Guided Setup walks you through four steps: **Open an existing ZLens project**
(already selected, click **Continue to credentials**), the sample's DuckDB
connection (already configured and tested), an optional AI provider
(**Skip AI for now**), then **Finish setup · Build an App**. Then open
**Notebooks → New Notebook**, click **Create DQL query → Switch to SQL cell**,
and run this with **Shift+Enter**:

```sql
select customer_name, count_lifetime_orders, lifetime_spend
from dev.customers
order by lifetime_spend desc
limit 10
```

Next: [ask a question in plain English](https://docs.zlens.app/ask/),
[keep the query as a saved query and certify it](https://docs.zlens.app/blocks/),
or [add ZLens to your own dbt project](https://docs.zlens.app/get-started/your-dbt-project/).
The full walkthrough is the [Quickstart guide](https://docs.zlens.app/get-started/).

**No dbt?** [Start from your database](https://docs.zlens.app/get-started/no-dbt/):
connect it, choose schemas, and ZLens drafts the models for you to certify.

<details>
<summary><b>Install the CLI globally, upgrade, or connect another database</b></summary>

<br>

`npm install` in a ZLens project (the sample, or one made with
`create-zlens-app`) installs the CLI into that project, so `npm run …` and
`npx zlens …` use the version that project was tested with. To have a `zlens`
command everywhere:

```bash
npm i -g @zlens/cli --allow-scripts=better-sqlite3   # install or upgrade (npm 12 needs the flag)
zlens --version
cd your-dbt-repo && zlens init ./dql
```

Install only the driver your warehouse needs, into the project:

| Database | Install before running queries |
|---|---|
| Databricks SQL | nothing (built in, over HTTPS) |
| DuckDB, or local CSV / Parquet / JSON files | `npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'` |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` |

ZLens installs the DuckDB driver on its own the first time it connects, so
you can usually skip that row. The notebook's Connections page can install
DuckDB or Snowflake for you. See
[Install](https://docs.zlens.app/get-started/install/),
[Connect a database](https://docs.zlens.app/get-started/connect-database/),
[Connectors](https://docs.zlens.app/reference/connectors/) and
[Troubleshooting](https://docs.zlens.app/guides/troubleshooting/).
Coming from the `dql` command and `@duckcodeailabs/dql-cli`? Install
`@zlens/cli`; the [install guide](https://docs.zlens.app/get-started/install/)
covers the switch.

</details>

## Video tutorials

Short videos (about a minute each) on the [ZLens YouTube channel](https://www.youtube.com/@zlensanalytics).
New here? Watch **Start here**, then **Quick Start**. The [Video tutorials](https://docs.zlens.app/get-started/videos/) page in the docs lists every video next to its steps.

| Playlist | What it covers |
|---|---|
| [Start here](https://youtu.be/nsyLc4UfKxo) | The whole idea in 90 seconds: certified answers, AI answers you can review, refusals instead of guesses. |
| [Quick Start](https://www.youtube.com/playlist?list=PLOQWt259Y25k) | Install, Guided Setup, your first question with a trust label, then your own data, with or without dbt. |
| [Notebooks](https://www.youtube.com/playlist?list=PLUdJRzKhNIRA) | SQL, charts, inputs and AI in one file you share, review in git and save as a saved query. |
| [Blocks and certification](https://www.youtube.com/playlist?list=PLRvLK1Q_JFQA) | Saved queries your team can trust: import your SQL, add tests, then certify, change or retire. |
| [Ask and trust](https://www.youtube.com/playlist?list=PLahuj-J7h3TY) | How Ask picks a source, what each label means, and when it refuses. |
| [Semantic layer](https://www.youtube.com/playlist?list=PLXjz0fV3orFg) | Define a metric once so every answer computes it the same way, and certify how tables join. (These videos use the older label "Governed"; it is now "From Metrics".) |
| [Lineage](https://www.youtube.com/playlist?list=PLJIc5kBRmBLs) | Trace a number to its source, and see what a change will break before you make it. |
| [Share and review with git](https://www.youtube.com/playlist?list=PLZGwS382JLAs) | Review data work like code: see what changed, share a review branch and pull request, get updates. |
| [Your AI agent + ZLens](https://www.youtube.com/playlist?list=PLJSaxF-L_t4Q) | Use ZLens from Claude Code, Claude Desktop, Codex and Cursor over MCP. |
| [Evals and CI](https://www.youtube.com/playlist?list=PLcTI7I6RUs-4) | Test your AI answers like code, and fail a pull request when an answer gets worse. |
| [Apps](https://www.youtube.com/playlist?list=PLBI3ZFFvskKQ) | Dashboards that show their proof: every tile has a receipt, and filters say which tiles they reach. |

## Features

### Ask, with a trust label and the receipts

Ask a question in plain English. The answer opens with its trust label, the
saved query or metrics it came from and their owner. **How it was answered**
shows every step: the certified saved queries it checked, the semantic layer, the checks
before running, and the exact DQL and SQL that ran.

<p align="center">
  <img src="docs/assets/readme/ask-certified.png" alt="Ask answers 'How has revenue changed by month?' with a Certified answer from the monthly_revenue saved query; the How it answered panel lists Read the question, Certified blocks, Semantic layer skipped, Checked before running, Ran on the warehouse and Answer" width="100%">
</p>

When no certified saved query or metric fits, AI writes the SQL from your schema.
ZLens checks it before it runs, labels the answer **AI-generated**, and saves
it as a draft saved query for someone to review. It never certifies itself.

<p align="center">
  <img src="docs/assets/readme/ask-review.png" alt="An AI-generated answer with 4 checks passed, its result table, and the line Saved for review as a draft block (not certified)" width="85%">
</p>

[Ask a question](https://docs.zlens.app/ask/) ·
[How Ask answered](https://docs.zlens.app/ask/how-it-answered/) ·
[Answers that need review](https://docs.zlens.app/ask/needs-review/)

### Saved queries: save is a draft, certify is a person

A saved query is a named, reusable query with an owner, a description, tests
and a chart. Save a notebook cell with **Save as saved query**, and it is a
draft. **Certify** runs the saved query and its checks; only if they pass
does it become Certified, with a receipt of who certified it, when, and under
which rules.

<p align="center">
  <img src="docs/assets/readme/block-certified.png" alt="Block Studio showing top_customers_by_spend as Certified, with the receipt line Certified by analytics@jaffle.shop via Block Studio, OSS rules, and a Block certified panel with Metadata, Validation, Run, Chart and Lineage checks" width="100%">
</p>

[Saved queries](https://docs.zlens.app/blocks/) ·
[Save and certify](https://docs.zlens.app/blocks/certify/)

### Notebooks

Explore with SQL, DQL, Ask AI, note and input cells against your warehouse.
Results show with filters, pivots, charts and CSV or JSON export. The notebook
is a `.dqlnb` file; results stay out of git.

<p align="center">
  <img src="docs/assets/readme/notebook.png" alt="A notebook with a warehouse SQL cell over dev.customers and its result table of ten customers" width="100%">
</p>

[Work in a notebook](https://docs.zlens.app/notebooks/)

### Apps and dashboards

Build Apps from saved queries for the people who read the numbers. Every tile carries
its trust label and a receipt, and the page says how much of it is certified.
Ask about an App and the answer reads that page's own results and filters, and
takes the trust of the weakest tile it read.

<p align="center">
  <img src="docs/assets/readme/app.png" alt="A ZLens App page: the badge reads All data certified, an Ask box sits above the tiles, and every tile is labelled Certified" width="100%">
</p>

<p align="center">
  <img src="docs/assets/readme/app-ask.png" alt="The Jaffle Growth Review App, all data certified, with Ask about Jaffle Growth Review open: a Certified answer read from the App's current results, where every tile it read runs a certified source" width="100%">
</p>

[Read an App](https://docs.zlens.app/apps/) ·
[Ask about an App](https://docs.zlens.app/apps/ask-about-an-app/)

### Lineage, from your tables to the App

Trace any saved query, App or notebook end to end: your warehouse tables (and, if you
use dbt, the sources and models behind them), business terms, the saved query, its
chart, the dashboard page and the App. Lineage is built from your synced
warehouse catalog or dbt manifest plus your ZLens files, in the workbench or
with `zlens lineage`.

<p align="center">
  <img src="docs/assets/readme/lineage.png" alt="End-to-end lineage of the monthly_revenue saved query: four dbt sources, staging models, order_items and orders, the Revenue and Order business terms, the saved query, its chart, the jaffle-growth overview dashboard and the Jaffle Growth Review App" width="100%">
</p>

[Lineage](https://docs.zlens.app/lineage/)

### AI agents over MCP

Point your coding agent at the project and it answers data questions the way
Ask does: certified saved queries first, the same trust labels, AI-written SQL kept
as a draft for review.

```console
$ npm exec -- zlens connect claude-code

  ZLens agent connection setup
    Project: /path/to/jaffle-shop-duckdb

  ✓ Claude Code
    Project .mcp.json and CLAUDE.md now point Claude Code at ZLens.
    Next: Open Claude Code from this project and run /mcp to confirm the dql server is loaded.

  Verify before asking an agent: zlens mcp test
```

`zlens connect` also supports `codex`, `cursor`, `claude-desktop` and `all`.
Keep `npm run notebook` running while the agent works: it runs the queries.

[Connect your AI agent](https://docs.zlens.app/agents/) ·
[MCP tools](https://docs.zlens.app/agents/tools/)

## How it works

<p align="center">
  <a href="docs/assets/architecture/dql-flow.svg">
    <img src="docs/assets/architecture/dql-flow.svg" alt="ZLens architecture: a dbt project and an optional DataLex manifest feed Sync context and Certified saved queries, which compile into the DQL manifest that serves Apps, notebooks, agents over MCP and CI verify; AI-written SQL enters as drafts for review" width="100%">
  </a>
</p>

1. **Sync.** `zlens sync dbt` reads your dbt manifest, semantic models and
   warehouse shape into a local index. Without dbt, `zlens sync warehouse`
   reads the schemas you choose: tables, columns, keys and comments.
2. **Certify.** Saved queries are reviewed queries with an owner and tests.
   Certifying records who vouched for them.
3. **Compile.** `zlens compile` writes `dql-manifest.json`: every saved query,
   metric, notebook and App, with lineage and trust.
4. **Serve.** Apps, notebooks, Ask, your agent over MCP and `zlens eval` in
   CI all use the same certified saved queries instead of each inventing its own SQL.

DQL is the language saved queries are written in: each is a `block` in a
`.dql` file. See
[Concepts](https://docs.zlens.app/get-started/concepts/),
[the DQL language](https://docs.zlens.app/reference/language/)
and the [architecture overview](https://docs.zlens.app/architecture/overview/).

## Packages

ZLens ships as 20 npm packages. Most people only need `zlens` (for `npx
zlens`), `create-zlens` (for `npm create zlens`) or `@zlens/cli`.

<details>
<summary><b>All packages</b></summary>

<br>

| Package | What it is |
|---|---|
| [`@zlens/cli`](./apps/cli) | The `zlens` command: workbench, sync, compile, certify, lineage, Ask and the MCP server |
| [`zlens`](./packages/zlens) | `npx zlens …` with nothing installed: runs `@zlens/cli` |
| [`create-zlens`](./packages/create-zlens) | `npm create zlens@latest`: creates a project and opens the workbench |
| [`create-zlens-app`](./packages/create-dql-app) | Scaffolds a ZLens project, next to your dbt project or for a database alone |
| [`@zlens/core`](./packages/dql-core) | DQL language core: lexer, parser, AST and semantic analysis |
| [`@zlens/dql-compiler`](./packages/dql-compiler) | DQL compiler: IR lowering, Vega-Lite generation, HTML and CSS output |
| [`@zlens/runtime`](./packages/dql-runtime) | Browser runtime: data fetching, Vega rendering, hot reload |
| [`@zlens/project`](./packages/dql-project) | Project and block registry: block metadata, versions, sync and storage |
| [`@zlens/governance`](./packages/dql-governance) | Block testing, certification, cost estimation and access policies |
| [`@zlens/connectors`](./packages/dql-connectors) | Connectors for local files, SQL warehouses and lakehouse engines |
| [`@zlens/notebook`](./packages/dql-notebook) | Notebook document model and execution helpers |
| [`@zlens/agent`](./packages/dql-agent) | The agent: knowledge graph, Skills, block-first answer loop, LLM providers |
| [`@zlens/mcp`](./packages/dql-mcp) | MCP server exposing certified blocks, semantic layer, lineage and governance |
| [`@zlens/charts`](./packages/dql-charts) | React SVG chart components for blocks |
| [`@zlens/ui`](./packages/dql-ui) | Design tokens, theme provider and headless UI primitives |
| [`@zlens/dql-lsp`](./packages/dql-lsp) | DQL language server |
| [`@zlens/slack`](./packages/dql-slack) | Slack slash-command bot that answers through the block-first agent loop |
| [`@zlens/openlineage`](./packages/dql-openlineage) | Send a project's lineage to an OpenLineage receiver from your own script |
| [`@zlens/plugin-api`](./packages/dql-plugin-api) | Plugin contracts: connectors, chart renderers, governance rule packs |
| [`@zlens/telemetry`](./packages/dql-telemetry) | Deprecated and unused: ZLens sends no usage telemetry |

</details>

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and
the [repository layout](./docs/contribute/repo-layout.md); the
[roadmap](./ROADMAP.md) shows what is planned. Please follow the
[code of conduct](./CODE_OF_CONDUCT.md).

## Community and support

- **Questions and help:** ask in [GitHub Discussions → Q&A](https://github.com/duckcode-ai-labs/zlens/discussions/categories/q-a).
  Not sure whether it's a bug? Ask there first.
- **Ideas and feature suggestions:** [Discussions → Ideas](https://github.com/duckcode-ai-labs/zlens/discussions/categories/ideas).
- **Show what you built:** [Discussions → Show and tell](https://github.com/duckcode-ai-labs/zlens/discussions/categories/show-and-tell).
- **Reproducible bugs and well-defined feature requests:** [open an issue](https://github.com/duckcode-ai-labs/zlens/issues/new/choose).
- **Release news:** [Announcements](https://github.com/duckcode-ai-labs/zlens/discussions/categories/announcements) and
  [Releases](https://github.com/duckcode-ai-labs/zlens/releases).
- **Video tutorials:** [ZLens on YouTube](https://www.youtube.com/@zlensanalytics).
- **Security issues:** follow [SECURITY.md](./SECURITY.md) (security@zlens.app); do not open a public issue.

[SUPPORT.md](./SUPPORT.md) explains what to include when you ask and how we triage.

## License

ZLens is licensed under the [Apache License 2.0](./LICENSE); see also
[NOTICE](./NOTICE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

<details>
<summary>Licences of releases before the ZLens rename</summary>

<br>

`create-dql-app`, `@duckcodeailabs/dql-openlineage`,
`@duckcodeailabs/dql-plugin-api` and `@duckcodeailabs/dql-telemetry` were
published as MIT up to and including 1.17.2; every later release is
Apache-2.0. Versions already on npm keep the licence they were published under.

</details>
