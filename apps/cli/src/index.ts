#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";
import { runBuild } from "./commands/build.js";
import { runDoctor } from "./commands/doctor.js";
import { runPreview } from "./commands/preview.js";
import { runServe } from "./commands/serve.js";
import { runParse } from "./commands/parse.js";
import { runTest } from "./commands/test.js";
import { runCertify } from "./commands/certify.js";
import { runInfo } from "./commands/info.js";
import { runMigrate } from "./commands/migrate.js";
import { runFmt } from "./commands/fmt.js";
import { runNotebook } from "./commands/notebook.js";
import { runValidate } from "./commands/validate.js";
import { runSemantic } from "./commands/semantic.js";
import { runLineage } from "./commands/lineage.js";
import { runCompile } from "./commands/compile.js";
import { runSync } from "./commands/sync.js";
import { runDiff } from "./commands/diff.js";
import { runMcp } from "./commands/mcp.js";
import { runApp } from "./commands/app.js";
import { runSchedule } from "./commands/schedule.js";
import { runAgent } from "./commands/agent.js";
import { runSlack } from "./commands/slack.js";
import { runVerify } from "./commands/verify.js";
import { runImport } from "./commands/import.js";
import { runConnect } from "./commands/connect.js";
import { runPromote } from "./commands/promote.js";
import { runEval } from "./commands/eval.js";
import { runCi } from "./commands/ci.js";
import { runPropose } from "./commands/propose.js";
import { runModel } from "./commands/model.js";
import { explainNativeDependencyError, sqlitePreflightMessage } from "./native-deps.js";

const HELP = `
  zlens — ZLens CLI

  Usage:
    zlens init [directory]           Initialize ZLens in a project (auto-detects dbt or a DuckDB file)
    zlens new <type> <name>         Create a domain, block, semantic block, view, term, dashboard, or workbook
    zlens build <file.dql>          Compile a DQL file to a static HTML bundle
    zlens doctor [path]             Run local setup checks for a ZLens project
    zlens doctor scale [path]       Report enterprise-scale manifest/cache/index health
    zlens doctor git-hygiene [path] Flag tracked local/generated files that create noisy commits
    zlens preview <file.dql>        Render a local browser preview for a DQL file
    zlens serve [directory]         Serve a built DQL bundle locally
    zlens parse <file.dql>          Parse and analyze a DQL file
    zlens test <file.dql>           [deprecated] Use zlens certify --connection instead
    zlens validate [path]           Validate all DQL files and semantic references
    zlens certify <file.dql>        Evaluate certification rules
    zlens certify <term file> --apply
                                    Certify the business terms a file declares
    zlens certify <file.dql> --enterprise
                                    Enforce enterprise reusable-block requirements
    zlens certify --from-draft <path> Promote a Tier-2 draft block to certified
    zlens certify --from-import [id] Check every draft of an SQL import (latest by default); --apply certifies the ones that pass
                                    (auto-flips status, sets datalex_contract,
                                     surfaces datalex-manifest.json patch)
    zlens info <file.dql>           Show block metadata
    zlens migrate <source>          Scaffold migration from looker/tableau/dbt/metabase/raw-sql
    zlens migrate format [--check]  Upgrade all .dql/.dqlnb files to canonical format
    zlens migrate layout --to domain-first [--dry-run]
                                    Preview or apply legacy-to-domain folder moves
    zlens migrate parameters --check  Audit legacy block parameters before AI adaptation
    zlens migrate datalex --input <manifest.json> [--dry-run|--apply]
                                    Convert DataLex-only business semantics into
                                    draft dbt-first Domain Package overlays
    zlens migrate modeling --to dbt-first --dry-run|--apply
                                    Explicitly adopt manifest v3, consolidate
                                    modeling, and relocate legacy shared products
    zlens import sql <path>         Draft saved queries from SQL, Tableau (.twb, .twbx) or Power BI (.pbit, PBIP) files
    zlens import sql <path> --save  Compatibility alias; drafts autosave before certification
    zlens propose [path]            Draft a ranked governance layer from dbt evidence
                                    (one DRAFT block per high-value model; never
                                     auto-certified — humans certify)
    zlens propose --dry-run         Rank dbt models without writing any drafts
    zlens promote notebook <path> --to shared
                                    Strip local run/UI state and mark a notebook shared
    zlens promote app <app-id> --to shared
                                    Promote an App manifest to reviewed shared source
    zlens promote dashboard <app-id>/<dashboard-id> --to shared
                                    Strip local tiles/state and mark a dashboard shared
    zlens fmt <file.dql|.dqlnb>     Format DQL/notebook file in place
    zlens diff <path>               Diff a .dql/.dqlnb file vs HEAD
    zlens diff <before> <after>     Semantic diff between two files
    zlens diff <path> --impact --write-recertification
                                    Mark impacted semantic YAML pending recertification
    zlens notebook [path]           Launch the browser-first notebook for a project
                                    (offers to create one in a folder without a project)
    zlens semantic <sub> [path]     Semantic layer: list, validate, query, pull
    zlens compile [path]            Generate project manifest (dql-manifest.json)
    zlens sync dbt [path]           Diff, compile, and reindex dbt-backed DQL state
    zlens sync dbt --check [path]   Report dbt/DQL drift without writing
    zlens sync warehouse [path]     Read warehouse schemas (tables, columns, keys) — no dbt needed
    zlens model list|validate [path]  Inspect or validate dbt-first Domain Packages
    zlens model discover [path]     Preview draft domains and joins (from dbt, or the warehouse catalog)
    zlens model apply-discovery [path] --apply
                                    Write reviewed sparse Domain Package proposals
    zlens model import <file-or-directory> --domain <id> --area <id> --dry-run|--apply
                                    Import DQL/dbt YAML through the guarded proposal service
    zlens model explain <id> [path] Explain whether a relationship is automatic join proof
    zlens model validate-relationship <id>|--all [path] [--certify] [--dry-run]
                                    Check an authored relationship on the warehouse and record the evidence
    zlens model reject-discovery <id> [path] [--reason <text>]
                                    Stop discovery proposing a join a reviewer turned down
    zlens lineage [block] [path]    Answer-layer lineage analysis
    zlens lineage cross-domain      Show cross-domain lineage flows (--domain filters)
    zlens mcp [--http]              Run the ZLens MCP server (stdio by default; --http = loopback)
    zlens mcp test [path]           Check MCP readiness, incl. the running workbench (exits 1 if not)
    zlens connect <target> [path]   Configure Codex, Claude Code, Claude Desktop, or Cursor MCP
    zlens app new|generate|ls|show|build|reindex <name-or-path>
                                    Manage App artifacts (metadata, policies, dashboards, schedules)
    zlens app check <id>            Run publish checks on an App (exits 1 if not ready)
    zlens app diff [base] [head]    Review what a change does to every App page (git revisions)
    zlens app verify <snapshot.html>  Check a signed App snapshot offline (exits 1 if it fails)
    zlens app key                   Print this project's snapshot signing public key
    zlens schedule list|run|start|status  Local scheduler for @schedule'd blocks (alerts + notifications)
      zlens agent ask "<question>"    Block-first agent loop (certified blocks → fallback LLM SQL)
      zlens agent threads             List persisted conversation threads (resume with --thread)
      zlens agent trace list|show|export|validate|replay|compare
                                    Inspect/export local redacted Ask execution traces
      zlens agent reindex [path]      Rebuild .dql/cache/agent-kg.sqlite and metadata.sqlite
      zlens agent feedback up|down    Record local answer-quality telemetry for later review
      zlens agent eval agent-evals.yml  Measure certified/follow-up/refusal accuracy
    zlens slack serve               Slack slash-command bot (forwards to the answer loop)
    zlens verify [path]             Check the local dql-manifest.json still matches the source
    zlens eval [path]               Replay block examples + eval/*.yaml through the agent
                                    router and score routing accuracy (CI-gateable)
    zlens ci init [path]            Write a GitHub Actions workflow that runs zlens eval on every PR
    zlens --version                  Show version
    zlens --help                    Show this help

  Options:
    --format json|text              Output format (default: text)
    --verbose                       Show detailed output
    --open                          Open the preview or served bundle in a browser
    --no-open                       Do not open the browser automatically
    --no-schedules                  For "notebook": do not run App schedules while it is open
    --yes, -y                       For "notebook": create a project in a folder without one, without asking
    --check                         For "fmt": check-only and exit 1 if changes needed
    --input <path>                  Source path for scaffold-style migration commands
    --out-dir <path>                Output directory for "build"
    --to <layout>                   Target layout for "migrate layout" (domain-first)
                                    For "promote": shared
    --port <number>                 Preferred local port for "preview" or "serve"
    --ask-runtime-mode <mode>       Ask runtime: pipeline_v3 (the interpreter-first
                                    intent → prepare → execute pipeline; the only runtime).
                                    Overrides "agent.askRuntimeMode" in dql.config.json,
                                    which all Ask surfaces honor
    --chart <type>                  Primary chart type for "new" scaffolds (default: bar)
    --domain <name>                 Domain for new block scaffolds (default: general)
    --area <id>                     Model Area for modeling import and authoring
    --owner <name>                  Owner for new block scaffolds (default: current user)
    --query-only                    Create a query-only block without visualization
    --pattern <name>                Block scaffold pattern (entity_profile, ranking, trend, bridge, ...)
    --ai-layout                     For "app generate": store dynamic GenUI layout metadata
    --enterprise                    For "certify": require enterprise block contract metadata
    --connection <driver|path>      Database connection for certify/test (e.g. duckdb, path/to/db)
    --save                          For "import sql": retained for compatibility; drafts autosave
    --from-draft <path>             For "certify": promote a Tier-2 draft block to certified
    --from-import [id|latest]       For "certify": check an SQL import's drafts; with --apply, certify the ones that pass
    --no-preview                    For "import sql": make the drafts without running them
    --contract <id@version>         For "certify --from-draft": DataLex contract id (e.g. commerce.Customer.foo@1)
    --datalex-manifest <path>       Optional DataLex manifest for datalex_contract validation
    --open-pr                       For "certify --from-draft": push branch + open GitHub PR with the diff
      --force                         For "certify --from-draft": overwrite an existing certified block
                                      For "migrate layout": apply domain-first file moves
      --dry-run                       For "migrate layout": preview file moves
      --apply                         For "migrate datalex": write the reviewed migration plan
      --execute                       For "agent eval": run bounded SQL previews
      --min-answer-rate <0..1>        For "eval": fail below non-refusal rate on answerable cases
      --min-tool-requirement <0..1>    For "agent eval": fail below required tool-call pass rate
      --via runtime                    For "agent eval": drive a running workbench (routing + gates); the default and only driver
      --cassette record|replay         For "agent eval": require the workbench to run in this cassette mode (it is started
                                       with ZLENS_EVAL_CASSETTE_DIR and ZLENS_EVAL_CASSETTE_MODE); also the --judge calls' mode
      --judge                          For "agent eval": score each answer with the LLM judge (needs a provider)
      --min-judge-pass <0..1>          For "agent eval": fail below this judge pass rate (needs --judge)
      --max-false-refusal <0..1>       For "agent eval": fail above this share of ANSWERABLE cases refused
      --min-refusal-recall <0..1>      For "agent eval": fail below this share of must-refuse cases that refused
      --thread <id>                   For "agent ask": continue a persisted conversation thread
      --ai                            For "doctor": include AI, MCP, and metadata checks
  `;

const COMMAND_HELP: Record<string, string> = {
  init: `
  zlens init — Create a ZLens project in a folder

  Usage:
    zlens init [folder] [--force] [--open]

  Notes:
    ZLens looks at what the folder holds. A dbt project (here or a level up)
    makes a dbt project. A DuckDB file and no dbt project makes a Database
    only project that reads the database's own tables. An empty folder gets a
    project, and Guided Setup asks where your data lives.
    --force patches missing folders of an existing project; it never
    overwrites dql.config.json or your files. --open starts the notebook.
  `,
  notebook: `
  zlens notebook — Open the ZLens workbench in your browser

  Usage:
    zlens notebook [folder] [--port <n>] [--no-open] [--yes]

  Notes:
    Opens the project in the folder (or the nearest one above it). In a
    folder with no ZLens project, it asks "No ZLens project here. Create
    one? [Y/n]" and creates it the way zlens init would; --yes creates it
    without asking. Without a terminal it prints the one command to run.
  `,
  certify: `
  zlens certify — Evaluate local certification rules

  Usage:
    zlens certify <file.dql> [--connection <driver|path>] [--skip-tests] [--enterprise]
    zlens certify --from-draft <path> [--owner <name>] [--domain <name>] [--contract <id@version>] [--enterprise] [--force]
    zlens certify --from-import [id|latest] [--apply]

  Notes:
    \`zlens certify <file.dql>\` evaluates the certification rules and writes
    nothing. Saving a block never certifies it; a person certifies explicitly.
    \`zlens certify --from-draft <path>\` runs the same rules Certify runs
    in Saved queries (owner, a successful compile and run, passing tests) and only
    when they pass promotes the draft to status = "certified", recording who
    certified it in the block's companion YAML (reviewStatus + certification).
    --enterprise makes grain, declared outputs, source-system lineage,
    reusable pattern, review cadence, and test assertions hard requirements.
  `,
  import: `
  zlens import — Convert existing SQL into reviewable DQL drafts

  Usage:
    zlens import sql <file-or-folder> [--domain <name>] [--owner <name>]
    zlens import sql <file-or-folder> --save [--domain <name>] [--owner <name>]

  Notes:
    Import creates AI-first draft blocks under _drafts, parameterizes safe
    runtime literals, checks for similar certified blocks, and never certifies
    generated DQL automatically.
  `,
  propose: `
  zlens propose — Draft a governance layer from dbt evidence

  Usage:
    zlens propose [path] [--dbt-manifest <path>] [--owner <name>] [--limit <n>]
    zlens propose [path] --dry-run [--format json]

  Reads dbt artifacts (manifest.json, catalog.json, semantic_manifest.json,
  run_results.json) and emits one DRAFT block per high-value model, inferring
  grain / pattern / outputs / llmContext conservatively. Each draft is born
  status="draft", checked by the Certifier (verdict stored in the file), and
  ranked by downstream fan-out, exposure linkage, and run frequency.

  Nothing is ever auto-certified. Re-running is idempotent — existing drafts
  and already-promoted blocks are never overwritten or duplicated. Promote a
  reviewed draft with: zlens certify --from-draft <path> --owner you@example.com
  `,
  app: `
  zlens app — Manage local App artifacts

  Usage:
    zlens app new <id> --domain <domain> [--owner <user>]
    zlens app generate "<prompt>" [--domain <domain>] [--owner <user>] [--ai-layout]
    zlens app ls [path]
    zlens app show <name> [path]
    zlens app build [path]       Build every App in the project at path (default: .)
    zlens app reindex [path]
    zlens app check <id> [--format json]
                                 Run the checks publishing runs; exits 1 if not ready
    zlens app diff [base] [head] [--html <file>] [--markdown <file>] [--check] [--format json]
                                 Review App page changes between git revisions
                                 (default: HEAD against the working tree); --check
                                 exits 1 when a changed page has problems
    zlens app verify <snapshot.html> [--trust-key <public.pem>] [--format json]
                                 Check a signed App snapshot offline; exits 1 if a check fails
    zlens app key [--format json]
                                 Print this project's snapshot signing public key

  Notes:
    app new and app generate create a local App draft only; no App files are
    written until you publish the draft from Apps in zlens notebook.
    app build takes a project path, not an App id: zlens app build .
    --ai-layout stores DQL-native GenUI metadata for dynamic visualization and
    layout decisions while preserving certified block trust boundaries.
  `,
  compile: `
  zlens compile — Generate dql-manifest.json

  Usage:
    zlens compile [path] [--dbt-manifest <path>] [--dbt-hops <n>] [--datalex-manifest <path>] [--no-cache]

  dql-manifest.json is the dbt-like compiled artifact for blocks, notebooks,
  Apps, dashboards, semantic objects, sources, dbt imports, and lineage.
  `,
  doctor: `
  zlens doctor — Check a local ZLens project

  Usage:
    zlens doctor [path] [--format json]
    zlens doctor [path] --ai
    zlens doctor scale [path] [--format json]
    zlens doctor git-hygiene [path] [--format json]

  Prints setup checks and the next local-first commands to run.
  `,
  promote: `
  zlens promote — Turn private/local work into clean shared Git source

  Usage:
    zlens promote notebook <path> --to shared
    zlens promote app <app-id> --to shared
    zlens promote dashboard <app-id>/<dashboard-id> --to shared

  Promotion removes run snapshots, local UI state, AI pins, and legacy generated
  options while preserving reviewed app/notebook/dashboard metadata.
  `,
  connect: `
  zlens connect — Configure ZLens for external AI agents

  Usage:
    zlens connect codex [path]        Write project .codex/config.toml + AGENTS.md
    zlens connect claude-code [path]  Write project .mcp.json + CLAUDE.md
    zlens connect claude-desktop [path]
    zlens connect cursor [path]
    zlens connect all [path]

  After connecting, run: zlens mcp test [path]
  `,
  semantic: `
  zlens semantic — Work with the local semantic layer

  Usage:
    zlens semantic list [path]
    zlens semantic validate [path]
    zlens semantic query <metrics> [dimensions]
  `,
  eval: `
  zlens eval — Score the answer agent's routing accuracy

  Usage:
    zlens eval [path] [--format json]
    zlens eval [path] --min-route-accuracy <0..1> --min-refusal <0..1> --min-candidate-recall <0..1>
    zlens eval [path] --no-examples
    zlens eval [path] --init        Write a starter eval/golden.yaml template
    zlens eval [path] --min-answer-rate <0..1>

  Thresholds are shares between 0 and 1 (90% is 0.9); a value outside that
  range is an error. A threshold that no case measures (for example
  --min-refusal with no expectRefuse case) is reported as n/a and not applied.
  The manifest is built from source in memory: no zlens compile needed.

  Replays every certified block's examples[].question plus any eval/*.yaml
  cases through the existing agent router (no warehouse, no LLM judging) and
  scores route accuracy, block selection, grain match, question-plan shape,
  and refusal precision/recall. Exits non-zero below the configured
  thresholds, so it is CI-gateable.

  eval/*.yaml cases:
    - question: "..."
      expectRoute: certified | generated | missing_context | research
      expectBlock: "<block name>"        # optional
      expectGrain: "<grain>"             # optional
      expectRefuse: true                 # optional; shorthand for missing_context
      expectMetricTerms: ["<term>"]      # optional; must appear in the question plan
      expectNoMetricTerms: ["<term>"]    # optional; sticky-metric-carry guard
      expectFilters: ["<phrase>"]        # optional; member filters that must survive
      expectNoFilters: ["<phrase>"]      # optional; phrases that must NOT become filters
      expectEvidence: ["<objectKey>"]    # optional; must be in the context pack
      priorQuestion: "..."               # optional; replayed first (thread case)
      topicRelation: continuation | refinement | return | shift
      priorMeasures: ["<measure>"]       # optional; prior turn's answered measures
  `,
  verify: `
  zlens verify — Check the local dql-manifest.json still matches the source

  Usage:
    zlens verify [path] [--dbt-manifest <path>] [--dbt-hops <n>] [--datalex-manifest <path>] [--format json]

  Recompiles in memory and compares block SQL, status and domain, plus added
  or removed blocks, notebooks, Apps, dashboards, metrics, dimensions and
  sources. Exits 1 on drift. dql-manifest.json is gitignored, so this is a
  local check after zlens compile; in CI, gate on zlens eval (zlens ci init).
  `,
  ci: `
  zlens ci — Continuous-integration setup

  Usage:
    zlens ci init [path] [--force]

  Writes .github/workflows/zlens-eval.yml at the git root. On every pull
  request it runs, with the CLI pinned to this version:

    npx -y --package=@zlens/cli@<version> zlens eval . --min-route-accuracy 1 --min-refusal 1

  zlens eval reads no warehouse and calls no model, so the job needs no
  database file, dbt target/, dql-manifest.json, lockfile or API key. A
  project in a subfolder gets a working-directory. --force overwrites.
  `,
};

function getVersion(): string {
  try {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(cliDir, "../package.json"), "utf-8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const { command, file, rest, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(`zlens ${getVersion()}`);
    process.exit(0);
  }

  if (flags.help || !command) {
    console.log(
      (command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP).trim(),
    );
    process.exit(0);
  }

  if (flags.argErrors?.length) {
    for (const message of flags.argErrors) console.error(`Error: ${message}`);
    process.exit(1);
  }

  const commandAllowsNoFile =
    command === "init" ||
    command === "serve" ||
    command === "doctor" ||
    command === "notebook" ||
    command === "validate" ||
    command === "semantic" ||
    command === "lineage" ||
    command === "compile" ||
    command === "sync" ||
    command === "mcp" ||
    command === "connect" ||
    command === "app" ||
    command === "promote" ||
    command === "schedule" ||
    command === "verify" ||
    command === "eval" ||
    command === "ci" ||
    command === "propose" ||
    (command === "certify" && Boolean(flags.fromDraft || flags.fromImport));
  if (!file && !commandAllowsNoFile) {
    console.error(
      'Error: No file/argument specified. Run "zlens --help" for usage.',
    );
    process.exit(1);
  }

  // npm 12 blocks better-sqlite3's install script unless package.json allows
  // it: catch the missing native binary here, before it surfaces as "Could
  // not locate the bindings file" from inside some store.
  const preflight = sqlitePreflightMessage(command);
  if (preflight) {
    console.error(`Error: ${preflight}`);
    process.exit(1);
  }

  try {
    switch (command) {
      case "init":
        await runInit(file, flags);
        break;
      case "new":
        await runNew(file, rest, flags);
        break;
      case "build":
        await runBuild(file!, flags);
        break;
      case "doctor":
        await runDoctor(file, flags, rest);
        break;
      case "parse":
        await runParse(file!, flags);
        break;
      case "preview":
        await runPreview(file!, flags);
        break;
      case "serve":
        await runServe(file, flags);
        break;
      case "test":
        await runTest(file!, flags);
        break;
      case "certify":
        await runCertify(file ?? "", flags);
        break;
      case "info":
        await runInfo(file!, flags);
        break;
      case "migrate":
        await runMigrate(file!, flags);
        break;
      case "import":
        await runImport(file!, rest, flags);
        break;
      case "propose":
        await runPropose(file, rest, flags);
        break;
      case "fmt":
        await runFmt(file!, flags);
        break;
      case "notebook":
        await runNotebook(file, flags);
        break;
      case "validate":
        await runValidate(file, flags);
        break;
      case "semantic":
        await runSemantic(file, rest, flags);
        break;
      case "compile":
        await runCompile(file, rest, flags);
        break;
      case "sync":
        await runSync(file, rest, flags);
        break;
      case "model":
        await runModel(file, rest, flags);
        break;
      case "lineage":
        await runLineage(file, rest, flags);
        break;
      case "diff":
        await runDiff(file, rest, flags);
        break;
      case "mcp":
        await runMcp(file, rest, flags);
        break;
      case "connect":
        await runConnect(file, rest, flags);
        break;
      case "promote":
        await runPromote(file, rest, flags);
        break;
      case "app":
        await runApp(file, rest, flags);
        break;
      case "schedule":
        await runSchedule(file, rest, flags);
        break;
      case "agent":
        await runAgent(file, rest, flags);
        break;
      case "slack":
        await runSlack(file, rest, flags);
        break;
      case "verify":
        await runVerify(file, rest, flags);
        break;
      case "eval":
        await runEval(file, rest, flags);
        break;
      case "ci":
        await runCi(file, rest, flags);
        break;
      default:
        console.error(
          `Unknown command: ${command}. Run "zlens --help" for usage.`,
        );
        process.exit(1);
    }
  } catch (err) {
    const native = explainNativeDependencyError(err);
    console.error(`Error: ${native ?? (err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  }
}

main();
