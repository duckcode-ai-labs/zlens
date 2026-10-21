# CLI reference

> **Source of truth:** the installed CLI. Run `zlens --help` (or the project-local
> equivalent below) for the exact command list shipped by your version. This
> page is maintained against
> [`apps/cli/src/index.ts`](https://github.com/duckcode-ai-labs/zlens/blob/main/apps/cli/src/index.ts),
> and CI checks that every dispatched top-level command appears here.

```bash
zlens --help
zlens --version
```

## Running the CLI

The command prefix depends on how ZLens was installed:

| Installation | Command form | When to use it |
| --- | --- | --- |
| Project-local (recommended) | `npm exec -- zlens <command>` | Any CLI command using the version in this repository |
| Project-local starter script | `npm run doctor`, `npm run notebook`, and similar | Common commands already declared in `package.json` |
| Project-local shorthand | `npx zlens <command>` | Convenient when the local dependency is already installed |
| Global | `zlens <command>` | A global installation available everywhere on `PATH` |

For example:

```bash
npm install
npm run doctor
npm exec -- zlens model list
npm exec -- zlens --help
```

`npm run` adds `node_modules/.bin` to `PATH` for that script. A normal shell
does not, so a bare `zlens` command requires
`npm install -g @zlens/cli`. The command tables below use the
short global form for readability; prepend `npm exec --` for a project-local
installation.

## Commands

### Project

| Command | What it does |
| --- | --- |
| `zlens init [dir]` | Initialize ZLens in a project. A dbt project makes a dbt project; a DuckDB file and no dbt makes a Database only project (`warehouse-first`); an empty folder leaves the choice to Guided Setup |
| `zlens init [dir] --warehouse-first` | Initialize a project that models the database's own tables, no dbt needed (`manifestVersion: 3`, `modeling.mode: "warehouse-first"`) |
| `zlens doctor [path]` | Run local setup checks |
| `zlens doctor scale` | Report enterprise-scale manifest/cache/index health |
| `zlens doctor git-hygiene` | Flag tracked local/generated files before commit |
| `zlens validate [path]` | Validate all `.dql` files and semantic references |
| `zlens compile [path]` | Generate project manifest (`dql-manifest.json`) |
| `zlens verify [path]` | Verify that `dql-manifest.json` is reproducible from tracked source |

`zlens doctor scale --format json` includes counts, cache freshness,
metadata/KG index state, context-pack timing, source fingerprints, domain
shards, and top rejected evidence candidates that were relevant but excluded by
retrieval caps.

`zlens doctor git-hygiene --format json` checks tracked files against the OSS Git
policy and flags `.dql/cache`, `.dql/local`, `*.run.json`, `dql-manifest.json`,
local databases, data files, AI pins, saved views, and layout overrides.

### Authoring

| Command | What it does |
| --- | --- |
| `zlens new <type> <name>` | Create a domain, block, semantic block, term, business view, dashboard, workbook, or notebook |
| `zlens new domain <name>` | Create `domains/<domain>/domain.dql` plus domain-local `terms/`, `blocks/`, `views/`, and `apps/` folders |
| `zlens new block --domain <domain> --pattern <pattern> <name>` | Create a draft block scaffold with enterprise contract metadata |
| `zlens new view --domain <domain> <name>` | Create a domain-local business view scaffold |
| `zlens import sql <path>` | Generate AI-first DQL draft blocks from SQL files or folders |
| `zlens import sql <path> --save` | Compatibility alias; generated drafts autosave before certification |
| `zlens propose [path]` | Rank dbt models and write review-only DQL block proposals |
| `zlens propose [path] --dry-run` | Preview ranked proposals without writing files |
| `zlens parse <file.dql>` | Parse and analyze a DQL file |
| `zlens info <file.dql>` | Show block metadata |
| `zlens certify <file.dql>` | Evaluate certification rules |
| `zlens certify <file.dql> --enterprise` | Enforce grain, outputs, source-system lineage, pattern-specific reusable contracts, review cadence, and test assertions |
| `zlens certify --from-draft <path>` | Promote a reviewed Tier-2 draft and surface its DataLex contract patch |
| `zlens test <file.dql>` | Deprecated compatibility command; use `zlens certify --connection` |
| `zlens fmt <file.dql\|.dqlnb>` | Format a file in place (canonical form) |
| `zlens fmt --check <path>` | CI check; exits 1 if anything needs formatting |

### Diff & versioning

| Command | What it does |
| --- | --- |
| `zlens diff <path>` | Semantic diff of a `.dql` or `.dqlnb` against git HEAD |
| `zlens diff <before> <after>` | Semantic diff between two files on disk |
| `zlens diff <path> --impact --write-recertification` | Mark impacted semantic metric/dimension YAML as `pending_recertification` |

Exits **1** on changes — scriptable like `git diff`.

### Build & preview

| Command | What it does |
| --- | --- |
| `zlens build <file.dql>` | Compile to a static HTML bundle |
| `zlens preview <file.dql>` | Local browser preview |
| `zlens serve [dir]` | Serve a built bundle |
| `zlens notebook [path]` | Launch the browser-first notebook. In a folder with no ZLens project it asks "No ZLens project here. Create one? [Y/n]" and creates it as `zlens init` would; `--yes` creates it without asking; without a terminal it prints the one command to run |

### Data & semantic

| Command | What it does |
| --- | --- |
| `zlens semantic list\|validate\|query\|pull` | Semantic layer operations |
| `zlens sync dbt [path]` | Diff, compile, and reindex dbt-backed ZLens state |
| `zlens sync dbt --check [path]` | Report dbt/DQL drift without writing |
| `zlens sync warehouse [path]` | Read the selected schemas' tables, columns, comments, declared keys and view SQL (metadata only, never rows). No dbt needed |
| `zlens model list [path]` | List Domain Packages: entities and relationships |
| `zlens model validate [path]` | Validate Domain Packages and relationship proofs |
| `zlens model discover [path]` | Preview draft domains, entities and joins: from dbt in a dbt-first project, from the warehouse catalog in a warehouse-first one |
| `zlens model apply-discovery [path] --apply` | Write the previewed drafts as Domain Package proposals (without `--apply`, preview only) |
| `zlens model explain <id> [path]` | Explain whether a relationship has automatic-join proof |
| `zlens model validate-relationship <id>\|--all [path] [--certify] [--dry-run]` | Check authored relationships on the warehouse (the Modeling page's Validate) and record the evidence |
| `zlens model reject-discovery <id> [path] [--reason <text>]` | Stop warehouse discovery proposing a join a reviewer turned down |
| `zlens lineage [block] [path]` | Answer-layer lineage analysis |

Warehouse sync and discovery flags (see
[No dbt? Start from your database](../get-started/no-dbt.md)):

| Command | Flag | Meaning |
| --- | --- | --- |
| `zlens sync warehouse` | `--schemas a,b` | Schemas to read; saved as the connection's metadata scope. With no flags, the saved selection is synced again |
| `zlens sync warehouse` | `--database <name>` | Database or catalog the schemas are in (default: the connection's own) |
| `zlens sync warehouse` | `--connection <name>` | Connection to read (default: the project's default connection) |
| `zlens sync warehouse` | `agent.valueProfile.mode: "sampled"` in `dql.config.json` | Also read a few example values and the range of each column for Ask's SQL drafter (off by default; the values reach your AI provider). See [value profile](../get-started/no-dbt.md#optional-show-the-drafter-what-the-columns-hold) |
| `zlens model discover`, `apply-discovery` | `--validate` | Check each drafted join and candidate key on the warehouse (aggregate queries only) and propose the cardinality seen |
| `zlens model discover`, `apply-discovery` | `--query-history` | Also count joins in recent warehouse queries (Snowflake, PostgreSQL, Databricks, BigQuery); only join pairs and counts are kept |
| `zlens model discover`, `apply-discovery` | `--domain <id>` | From the warehouse: put every drafted entity into this domain (default: one domain per schema). From dbt: the discovered domain to apply |
| `zlens model discover`, `apply-discovery` | `--source warehouse\|dbt` | In a hybrid project, choose what to draft from (default: dbt when a dbt manifest exists) |

```bash
zlens init --warehouse-first
zlens sync warehouse --schemas dev
zlens model discover --validate
zlens model apply-discovery --apply --validate
```

Useful lineage flags:

```bash
zlens lineage --term "Customer"          # business term to blocks/views/consumption
zlens lineage --business-360 "Customer"  # business definition, reusable block contracts, sources, consumers, and gaps
zlens lineage cross-domain --domain customer
                                      # domain boundary flows touching customer
zlens lineage --business                 # business lineage summary
zlens lineage --business "Customer 360"  # focused business composition and backing sources
zlens lineage --table fct_orders         # technical source lineage
zlens lineage --dashboard daily_ops      # consumption lineage
```

### Apps, agent, and MCP

| Command | What it does |
| --- | --- |
| `zlens app new <name>` | Create a local App package |
| `zlens app generate "<prompt>"` | Generate a governed App draft from certified blocks plus review placeholders |
| `zlens app generate "<prompt>" --ai-layout` | Store richer GenUI layout metadata for dynamic visualization/layout decisions |
| `zlens app ls\|show\|reindex` | List, inspect, or reindex local Apps |
| `zlens app build [path]` | Build every App in the project at `path` (default `.`) into `dql-manifest.json`. It takes a project path, not an App id: `zlens app build .` |
| `zlens promote notebook <path> --to shared` | Strip local run/UI state and mark a notebook as shared source |
| `zlens promote app <app-id> --to shared` | Mark an App manifest as shared/reviewed source |
| `zlens promote dashboard <app-id>/<dashboard-id> --to shared` | Strip AI pins/local state and mark a dashboard as shared source |
| `zlens agent ask "<question>"` | Ask through the certified-first local agent loop |
| `zlens agent threads` | List persisted conversations that can be resumed with `--thread` |
| `zlens agent reindex` | Rebuild `.dql/cache/agent-kg.sqlite` and metadata cache |
| `zlens agent feedback up\|down` | Record answer feedback |
| `zlens agent eval <file.yml>` | Run answer-loop eval checks with metrics and JSON traces; cases can assert `expected.minToolCalls` for tool-observed deep/research flows |
| `zlens agent trace list\|show\|export\|validate\|replay\|compare` | Inspect and export local redacted Ask trace receipts without starting a provider, tool, SQL, or network path |
| `zlens mcp [path]` | Run the ZLens MCP server over stdio |
| `zlens mcp --http [path]` | Run loopback HTTP MCP with a bearer token |
| `zlens mcp test [path]` | Verify manifest, metadata catalog, agent index, MCP tools, and the running workbench (`zlens notebook`); exits 1 if any check fails |
| `zlens connect codex [path]` | Write project `.codex/config.toml` plus `AGENTS.md` |
| `zlens connect claude-code [path]` | Write project `.mcp.json` plus `CLAUDE.md` |
| `zlens connect claude-desktop [path]` | Update Claude Desktop MCP config |
| `zlens connect cursor [path]` | Write project `.cursor/mcp.json` |
| `zlens connect all [path]` | Configure all supported local MCP clients |

### Automation, integrations, and evaluation

| Command | What it does |
| --- | --- |
| `zlens schedule list [path]` | List local schedules declared by DQL blocks |
| `zlens schedule run [path]` | Run due local schedules once; `zlens schedule run <appId> [scheduleId]` runs one App schedule (through a running `zlens notebook` when there is one) |
| `zlens schedule start [path]` | Start the local scheduler (App schedules are left to a running `zlens notebook`, which runs them itself) |
| `zlens schedule status [path]` | Show local scheduler status |
| `zlens schedule stop [path]` | Stop the local scheduler |
| `zlens slack serve [path]` | Run the Slack slash-command bot through the governed answer loop |
| `zlens eval [path]` | Replay block examples and `eval/*.yaml` through the router |
| `zlens agent eval <file.yml>` | Evaluate certified/follow-up/refusal behavior, optional tools, SQL execution, and judging |

### Migration

| Command | What it does |
| --- | --- |
| `zlens import sql <path>` | Generate autosaved AI import drafts from SQL files/folders |
| `zlens migrate <source>` | Scaffold from looker, tableau, dbt, metabase, or raw-sql |
| `zlens migrate layout --to domain-first --dry-run` | Preview moves from legacy folders into `domains/<domain>/...` |
| `zlens migrate layout --to domain-first --force` | Apply the previewed domain-first file moves |
| `zlens migrate format` | Rewrite every `.dql` and `.dqlnb` in the project in canonical form |
| `zlens migrate format --check` | Dry run; exits 1 if anything would change |
| `zlens migrate parameters --check` | Audit legacy block parameters before AI adaptation |
| `zlens migrate datalex --input <manifest.json> --dry-run` | Preview DataLex-only semantics as dbt-first Domain Package overlays |
| `zlens migrate datalex --input <manifest.json> --apply` | Apply the reviewed DataLex migration plan |
| `zlens migrate modeling --to dbt-first --dry-run` | Preview manifest-v3/dbt-first modeling adoption |
| `zlens migrate modeling --to dbt-first --apply` | Apply the reviewed dbt-first modeling migration |

## Shared and command-specific flags

| Flag | Meaning |
| --- | --- |
| `--format json\|text` | Output format (default: text) |
| `--verbose` | Detailed output |
| `--open` / `--no-open` | Auto-open the browser on `preview`/`serve` |
| `--no-schedules` | `zlens notebook` does not run the project's App schedules |
| `--yes`, `-y` | `zlens notebook` creates a project in a folder that has none, without asking |
| `--check` | For `fmt`: non-zero exit if changes needed |
| `--input <path>` | Source for scaffold-style migrations |
| `--out-dir <path>` | Output directory for `build` |
| `--host <host>` | Bind host for local HTTP commands; defaults to loopback |
| `--to domain-first` | Target for `zlens migrate layout` |
| `--dry-run` | Preview layout moves without writing |
| `--apply` | Apply an otherwise preview-only migration or discovery plan |
| `--warehouse-first` | For `init`: model the database's own tables, no dbt needed |
| `--plan` | Print a deterministic proposal plan without writing |
| `--force` / `-f` | Apply supported overwrites or file moves |
| `--to shared` | Target for `zlens promote` |
| `--port <n>` | Preferred local port for `preview`/`serve` |
| `--chart <type>` | Primary chart type for `new` scaffolds |
| `--domain <name>` | Domain for new block scaffolds |
| `--owner <name>` | Owner for new block scaffolds |
| `--purpose <text>` | Governed purpose for an authorized cross-domain import |
| `--pattern <name>` | Block scaffold pattern, such as `metric_wrapper`, `entity_profile`, `entity_rollup`, `ranking`, `trend`, `bridge`, `drilldown`, or `replacement` |
| `--template <name>` | Alias for `--pattern` on scaffold commands |
| `--enterprise` | For `certify`: require enterprise-ready reusable block metadata plus pattern-specific parameter/filter contracts |
| `--query-only` | Create a query-only block (no visualization) |
| `--connection <driver\|path>` | Connection for `certify`/`test` (e.g. `duckdb`, `./db.duckdb`) |
| `--skip-tests` | Skip executable certification tests when the command supports it |
| `--save` | Compatibility flag for SQL import; drafts already autosave |
| `--from-draft <path>` | Draft source for `zlens certify --from-draft` |
| `--contract <id@version>` | DataLex contract bound during draft certification |
| `--datalex-manifest <path>` | DataLex manifest used for contract validation or compilation |
| `--open-pr` | Push the certification branch and open a GitHub pull request |
| `--http` | Run MCP over loopback HTTP instead of stdio |
| `--ai` | Include AI provider, MCP, and metadata checks in `zlens doctor` |
| `--ai-layout` | Store dynamic GenUI layout metadata for `zlens app generate` |
| `--provider <name>` | Select agent provider where supported |
| `--user <id>` | Attribute agent memory or feedback to a local user id |
| `--runtime-url <url>` / `--runtime <url>` | Select the local agent runtime endpoint |
| `--thread <id>` | Continue a persisted `zlens agent ask` conversation |
| `--reasoning-effort low\|medium\|high` | Select supported provider reasoning effort |
| `--analysis-depth quick\|deep` | Control the agent context budget |
| `--block <id>` / `--question <text>` / `--comment <text>` | Supply agent feedback context |
| `--execute` | Execute bounded generated SQL previews during agent eval and score expected rows |
| `--min-route-accuracy <0..1>` | For `zlens eval`: minimum expected-route accuracy |
| `--min-refusal <0..1>` | For `zlens eval`: minimum refusal recall |
| `--min-answer-rate <0..1>` | For `zlens eval`: fail when answerable cases route to missing context below this non-refusal rate |
| `--min-tool-requirement <0..1>` | For `zlens agent eval`: fail when cases with `expected.minToolCalls` fall below this pass rate |
| `--min-execution-match <0..1>` | For `zlens agent eval`: minimum expected-row execution match |
| `--min-judge-pass <0..1>` | For `zlens agent eval`: minimum LLM-judge pass rate |
| `--max-wrong-certified <n>` | For `zlens agent eval`: maximum wrongly certified answers |
| `--no-examples` | For `zlens eval`: score YAML cases without manifest examples |
| `--impact` | Include downstream impact in `zlens diff` |
| `--write-recertification` | Mark impacted semantic YAML pending recertification |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure *or* `zlens diff`/`zlens fmt --check` found differences |
| `2` | Usage / argument error |
